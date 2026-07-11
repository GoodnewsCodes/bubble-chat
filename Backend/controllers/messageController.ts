import { Request, Response } from 'express';
import { Message } from '../models/messages';
import { Conversation } from '../models/conversations';
import { uploadToFilebase, getSignedMediaUrl, streamS3Object } from '../utils/filebase';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { enqueueMessage } from '../utils/queue';
import { transcribeAudio } from '../utils/whisperService';
import { getIO } from '../utils/socket';
import { sendPushNotification } from '../utils/push';
import { brainEventBus } from '../utils/brainEventListener';
import { logActivity } from './activityLogController';
import { formatConversation } from './chatController';

export interface AuthRequest extends Request {
  user?: any;
  io?: any;
}

// ─── Unread counting ──────────────────────────────────────────────────────────

// Single source of truth for a user's unread count in a chat. Must stay in sync
// with the aggregation in chatController.getChats: system messages, announcements
// and (in group chats) bot senders never count as unread — otherwise the live
// 'unread_count_updated' badge disagrees with the chat-list fetch and group badges
// get stuck on Aida transcripts that mark-as-read has no way to surface.
export const countUnreadForUser = async (
  chatId: any,
  userId: any,
  isGroupChat: boolean
): Promise<number> => {
  const query: any = {
    chat: chatId,
    sender: { $ne: userId },
    readBy: { $ne: userId },
    deletedFor: { $ne: userId },
    message_type: { $ne: 'system' },
    is_announcement: { $ne: true },
  };
  if (isGroupChat) {
    const { User } = await import('../models/users');
    const botUsers = await User.find({ is_bot: true }).select('_id').lean();
    if (botUsers.length) query.sender = { $ne: userId, $nin: botUsers.map(b => b._id) };
  }
  return Message.countDocuments(query);
};

// ─── Format helpers ───────────────────────────────────────────────────────────

const formatSender = async (u: any) => {
  let avatar = u.avatar || null;
  if (avatar && avatar.startsWith('http')) {
    try { avatar = await getSignedMediaUrl(avatar); } catch (e) { }
  }
  return {
    id: u._id,
    full_name: u.full_name || null,
    username: u.username || null,
    email: u.email || null,
    avatar,
    uniqueTag: u.uniqueTag || null,
    isOnline: u.isOnline ?? false,
    status_message: u.status_message || null,
    publicKey: u.publicKey || null,
  };
};

export const formatMessage = async (m: any) => ({
  _id: m._id,       // always include _id for frontend compatibility
  id: m._id,
  content: m.content || null,

  // Type & Context
  message_type: m.message_type || 'text',
  parent_message: m.parent_message ? {
    id: m.parent_message._id,
    content: m.parent_message.content || '[Media]',
    sender: m.parent_message.sender ? {
      full_name: m.parent_message.sender.full_name,
      uniqueTag: m.parent_message.sender.uniqueTag,
    } : null,
  } : null,
  is_forwarded: m.is_forwarded ?? false,
  is_announcement: m.is_announcement ?? false,
  is_encrypted: m.is_encrypted ?? false,

  // Media & Metadata
  mediaUrl: m.mediaUrl || null,
  mediaType: m.mediaType || null,
  fileSize: m.fileSize || null,
  media_metadata: m.media_metadata || null,
  call_metadata: m.call_metadata || null,
  transcript: m.transcript || null,
  location: m.location || null,

  // Interactions & State
  reactions: m.reactions || [],
  edit_history: m.edit_history || [],
  mentions: Array.isArray(m.mentions) ? await Promise.all(m.mentions.map(formatSender)) : [],
  readBy: Array.isArray(m.readBy) ? await Promise.all(m.readBy.map(formatSender)) : [],
  isRead: m.readBy && m.readBy.some((r: any) => {
    const senderId = String(m.sender?._id || m.sender?.id || m.sender);
    const readerId = String(r._id || r.id || r);
    return readerId !== senderId;
  }),
  // Delivery state (two gray ticks). A read message is implicitly delivered —
  // covers legacy messages created before deliveredTo existed.
  deliveredTo: Array.isArray(m.deliveredTo) ? m.deliveredTo.map((d: any) => String(d._id || d.id || d)) : [],
  isDelivered: (() => {
    const senderId = String(m.sender?._id || m.sender?.id || m.sender);
    const nonSender = (arr: any[]) => (arr || []).some((r: any) => String(r._id || r.id || r) !== senderId);
    return nonSender(m.deliveredTo) || nonSender(m.readBy);
  })(),

  sender: m.sender ? await formatSender(m.sender) : null,
  chat: m.chat
    ? { id: m.chat._id, chatName: m.chat.chatName || null, isGroupChat: m.chat.isGroupChat ?? false }
    : null,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
});

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * Send a new Message
 * POST /api/v1/message
 */
/**
 * Deliver a socket event to every member of a conversation EXACTLY ONCE.
 *
 * Previously we emitted to the chat room AND to each member's personal room, so a
 * member who had the chat open (joined the room) received the event twice — the
 * "sender sees the message twice, receiver sees it once" bug. We now emit to the
 * room once, then only to the personal rooms of members who are NOT currently in
 * the room, guaranteeing single delivery while still reaching offline-to-chat
 * recipients via their personal room.
 */
export const emitToConversation = async (
  io: any,
  chatId: string,
  users: any[],
  event: string,
  payload: any,
): Promise<void> => {
  const usersInRoom = new Set<string>();
  try {
    const roomSockets = await io.in(String(chatId)).fetchSockets();
    for (const s of roomSockets) {
      // RemoteSocket only carries socket.data (not custom props), so read userId
      // from data first; fall back to the legacy direct prop for safety.
      const uid = (s as any).data?.userId ?? (s as any).userId;
      if (uid) usersInRoom.add(String(uid));
    }
  } catch {
    // fetchSockets can fail in some adapters; fall back to personal-room only.
  }

  const fanoutUsers = users.filter((u) => !usersInRoom.has(String(u)));
  console.log(`[msg-debug] emit '${event}' chat=${String(chatId)} roomUsers=${usersInRoom.size} fanout=${fanoutUsers.length}`);
  io.to(String(chatId)).emit(event, payload);
  for (const u of fanoutUsers) {
    io.to(String(u)).emit(event, payload);
  }
};

/**
 * Transcribe a voice note off the request path. Reuses the same Whisper/Groq
 * service the meeting transcription uses, persists the result on the message,
 * and emits `message_transcribed` so both clients can show the text under the
 * voice bubble. Always cleans up the staged audio file.
 */
const transcribeVoiceNoteAsync = async (
  audioPath: string,
  messageId: string,
  chatId: string,
  users: any[],
  io: any,
): Promise<void> => {
  try {
    const transcript = (await transcribeAudio(audioPath))?.trim();
    if (!transcript) return;

    await Message.findByIdAndUpdate(messageId, { transcript });

    try {
      await emitToConversation(io, chatId, users, 'message_transcribed', { messageId, chatId, transcript });
    } catch (emitErr) {
      console.error('[Voice STT] emit message_transcribed failed:', emitErr);
    }
  } catch (err: any) {
    console.error(`[Voice STT] Transcription failed for message ${messageId}:`, err?.message || err);
  } finally {
    try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch { /* silent */ }
  }
};

export const sendMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  let { content, chatId, message_type, mediaUrl, mediaType, parent_message, fileSize, media_metadata, is_encrypted, location, mentions, media_duration, clientId } = req.body;

  // Set when a voice note is uploaded: a copy of the audio kept on disk so the
  // async transcription can run after we've already replied to the client.
  let voiceTranscriptionPath: string | undefined;

  if (req.file) {
    try {
      const result = await uploadToFilebase(
        fs.createReadStream(req.file.path),
        req.file.originalname,
        req.file.mimetype
      );

      if (!message_type || message_type === 'text') {
        if (req.file.mimetype.startsWith('image/')) message_type = 'image';
        else if (req.file.mimetype.startsWith('video/')) message_type = 'video';
        else if (req.file.mimetype.startsWith('audio/')) message_type = 'voice';
        else message_type = 'file';
      }
      mediaType = message_type;

      // Preserve a copy of the audio for transcription before the temp file is
      // unlinked (transcription is slow, so it can't block the send response).
      if (message_type === 'voice' || req.file.mimetype.startsWith('audio/')) {
        try {
          const ext = path.extname(req.file.originalname) || '.webm';
          voiceTranscriptionPath = path.join(os.tmpdir(), `voice-stt-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
          fs.copyFileSync(req.file.path, voiceTranscriptionPath);
        } catch (copyErr) {
          console.error('[Voice STT] Failed to stage audio for transcription:', copyErr);
          voiceTranscriptionPath = undefined;
        }
      }

      fs.unlinkSync(req.file.path);
      mediaUrl = result.url;
      fileSize = req.file.size;

      const durationVal = media_duration ? parseFloat(media_duration) : undefined;
      media_metadata = {
        ...media_metadata,
        mime_type: req.file.mimetype,
        ...(durationVal && { duration: durationVal })
      };
    } catch (uploadErr: any) {
      res.status(500).json({ message: `File upload failed: ${uploadErr.message}` });
      return;
    }
  }

  if ((!content && !mediaUrl) || !chatId) {
    res.status(400).json({ message: 'Missing required message fields' });
    return;
  }

  try {
    const convo = await Conversation.findById(chatId);
    if (!convo) {
      res.status(404).json({ message: 'Conversation not found' });
      return;
    }

    // Security check: must be a participant
    const isParticipant = convo.users.some(u => String(u) === String(req.user._id));
    if (!isParticipant) {
      res.status(403).json({ message: 'Forbidden: You are not a participant in this conversation' });
      return;
    }

    // "@all" in a group message notifies every member, regardless of what the
    // client sent in `mentions` — keeps behavior correct even if a client's
    // mention-picker logic falls out of sync with this rule.
    if (convo.isGroupChat && content && /(^|\s)@all\b/i.test(content)) {
      mentions = convo.users.filter((u: any) => String(u) !== String(req.user._id));
    }

    // Idempotency: if the client retried (double-click, reconnect, network retry)
    // with the same clientId, return the already-created message instead of
    // persisting a duplicate. This is the authoritative guard behind "send once".
    if (clientId) {
      const existing = await Message.findOne({ chat: chatId, sender: req.user._id, client_id: clientId });
      if (existing) {
        const fullExisting = await Message.findById(existing._id)
          .populate('sender', 'full_name username avatar email uniqueTag isOnline publicKey')
          .populate('chat')
          .populate({ path: 'parent_message', populate: { path: 'sender', select: 'full_name uniqueTag' } });
        const formattedExisting: any = await formatMessage(fullExisting);
        formattedExisting.clientId = clientId;
        // Duplicate retry — the original already handled (or is handling)
        // transcription, so drop this retry's staged audio copy.
        if (voiceTranscriptionPath) {
          try { if (fs.existsSync(voiceTranscriptionPath)) fs.unlinkSync(voiceTranscriptionPath); } catch { /* silent */ }
          voiceTranscriptionPath = undefined;
        }
        res.status(200).json({ message: 'Message already sent.', data: formattedExisting });
        return;
      }
    }

    const newMessage = await Message.create({
      sender: req.user._id,
      content,
      chat: chatId,
      message_type: message_type || 'text',
      mediaUrl,
      mediaType,
      parent_message,
      fileSize,
      media_metadata,
      is_encrypted: false, // E2EE removed — messages are always stored as plaintext
      location,
      mentions: mentions || [],
      readBy: [req.user._id],
      client_id: clientId || undefined,
    });

    const fullMessage = await Message.findById(newMessage._id)
      .populate('sender', 'full_name username avatar email uniqueTag isOnline publicKey')
      .populate('chat')
      .populate({
        path: 'parent_message',
        populate: { path: 'sender', select: 'full_name uniqueTag' }
      });

    const isSystem = newMessage.message_type === 'system' || newMessage.is_announcement === true;
    
    if (!isSystem) {
      await Conversation.findByIdAndUpdate(chatId, {
        latestMessage: newMessage._id,
        $pull: { deletedBy: { $in: convo.users } }
      });
    } else {
      // Just pull deletedBy so it reappears if someone deleted it, but don't bump latestMessage
      await Conversation.findByIdAndUpdate(chatId, {
        $pull: { deletedBy: { $in: convo.users } }
      });
    }

    const formatted: any = await formatMessage(fullMessage);
    // Echo the sender's optimistic clientId so the client can reconcile its
    // optimistic bubble with the server message by id, eliminating duplicates.
    if (clientId) formatted.clientId = clientId;
    // Top-level string chatId alongside the `chat` object, so realtime listeners
    // can match on a plain string without digging into the nested object.
    formatted.chatId = String(chatId);
    try {
      const io = req.io || getIO();
      await emitToConversation(io, chatId, convo.users as any[], 'new_message', formatted);

      // Voice note: transcribe in the background, then patch the message and
      // notify the room. Fire-and-forget so the send response isn't blocked.
      if (voiceTranscriptionPath) {
        transcribeVoiceNoteAsync(voiceTranscriptionPath, String(newMessage._id), String(chatId), convo.users as any[], io);
        voiceTranscriptionPath = undefined; // ownership handed to the async job
      }

      // First message into a DM that was previously hidden (empty colleague DM):
      // the recipient's chat list ignores new_message for chats it doesn't have,
      // so push a new_chat now that the DM has surfaced. `convo` was read before
      // this message was created, so a null latestMessage means this is the first.
      if (!isSystem && !convo.isGroupChat && !convo.latestMessage) {
        const fullConvo = await Conversation.findById(chatId)
          .populate('users', '-password -refreshToken -privateKey -zegoToken')
          .populate('groupAdmin', '-password -refreshToken -privateKey -zegoToken')
          .populate({ path: 'latestMessage', populate: { path: 'sender', select: 'full_name username avatar email uniqueTag isOnline is_bot' } });
        for (const u of convo.users as any[]) {
          const convoForUser = await formatConversation(fullConvo, u);
          io.to(String(u)).emit('new_chat', convoForUser);
        }
      }

      // Live unread badge: recompute each recipient's unread count for this chat
      // and push it to their personal room. Skip system messages (they don't
      // bump latestMessage above either).
      if (!isSystem) {
        const recipients = convo.users.filter((u: any) => String(u) !== String(req.user._id));
        await Promise.all(
          recipients.map(async (u: any) => {
            const unreadCount = await countUnreadForUser(chatId, u, !!convo.isGroupChat);
            io.to(u.toString()).emit('unread_count_updated', { chatId, unreadCount });
          })
        );
      }
    } catch (socketErr) {
      console.error('Socket emit new_message failed:', socketErr);
    }

    // Trigger push notification to other users asynchronously
    try {
      if (fullMessage) {
        const pushTargets = convo.users.filter((u: any) => String(u) !== String(req.user._id));
        if (pushTargets.length > 0) {
          const senderName = fullMessage.sender && ((fullMessage.sender as any).full_name || (fullMessage.sender as any).username)
            ? ((fullMessage.sender as any).full_name || (fullMessage.sender as any).username)
            : 'Someone';
          
          const title = convo.isGroupChat 
            ? `${senderName} inside ${convo.chatName || 'Group Chat'}`
            : senderName;

          let pushBody = '';
          if (newMessage.message_type === 'text') {
            pushBody = newMessage.content || 'Sent a message';
          } else if (newMessage.message_type === 'image') {
            pushBody = '🖼️ Sent an image';
          } else if (newMessage.message_type === 'video') {
            pushBody = '🎥 Sent a video';
          } else if (newMessage.message_type === 'voice') {
            pushBody = '🎵 Sent a voice note';
          } else {
            pushBody = '📁 Sent a file';
          }

          sendPushNotification(pushTargets, title, pushBody, {
            chatId: convo._id.toString(),
            type: 'new_message',
          }).catch(err => console.error('[Push] sendMessage hook failed:', err));
        }
      }
    } catch (pushErr) {
      console.error('[Push] Failed to compile push target information:', pushErr);
    }

    // 🧠 Brain ingestion — fire-and-forget for group chats only
    if (convo.isGroupChat && content && content.trim().length >= 10) {
      setImmediate(() => {
        brainEventBus.emit('group_message_sent', {
          messageId: String(newMessage._id),
          chatId: String(chatId),
          senderId: String(req.user._id),
        });
      });
    }

    // 🧠 Shared files in group chats also feed the brain
    if (convo.isGroupChat && mediaUrl && ['file', 'voice', 'video', 'image'].includes(newMessage.message_type)) {
      setImmediate(() => {
        brainEventBus.emit('chat_file_shared', {
          messageId: String(newMessage._id),
          chatId: String(chatId),
          senderId: String(req.user._id),
          mediaUrl,
          mimeType: media_metadata?.mime_type || mediaType || newMessage.message_type,
          caption: content || '',
        });
      });
    }

    // 🧠 Closed-loop capture — if this reply lands on a brain-routed question,
    // index the resulting Q&A pair back into the brain automatically.
    if (parent_message) {
      setImmediate(async () => {
        try {
          const parent = await Message.findById(parent_message).select('brainQuestionRef');
          if (parent?.brainQuestionRef) {
            brainEventBus.emit('qa_resolved', {
              questionMessageId: String(parent._id),
              replyMessageId: String(newMessage._id),
            });
          }
        } catch (err) {
          console.error('[Brain] qa_resolved emit failed:', err);
        }
      });
    }

    if (!isSystem) {
      logActivity({
        actor: req.user._id,
        action: 'message_sent',
        entityId: String(chatId),
        entityType: convo.isGroupChat ? 'GroupChat' : 'Chat',
        entityLabel: convo.isGroupChat ? (convo.chatName || 'Group Chat') : undefined,
        metadata: { messageType: newMessage.message_type, messageId: String(newMessage._id) },
      });
    }

    res.status(201).json(formatted);
  } catch (error: any) {
    // Concurrent retry raced past the idempotency check and hit the unique
    // (chat, sender, client_id) index — return the message that did win instead
    // of a 500, so the client still reconciles to a single bubble.
    if (error?.code === 11000 && clientId) {
      try {
        const winner = await Message.findOne({ chat: chatId, sender: req.user._id, client_id: clientId })
          .populate('sender', 'full_name username avatar email uniqueTag isOnline publicKey')
          .populate('chat')
          .populate({ path: 'parent_message', populate: { path: 'sender', select: 'full_name uniqueTag' } });
        if (winner) {
          const formattedWinner: any = await formatMessage(winner);
          formattedWinner.clientId = clientId;
          res.status(200).json({ message: 'Message already sent.', data: formattedWinner });
          return;
        }
      } catch { /* fall through to generic error */ }
    }
    res.status(500).json({ message: error.message });
  }
};

/**
 * Fetch all messages for a specific Chat
 * GET /api/v1/message/:chatId
 */
export const allMessages = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const convo = await Conversation.findById(req.params.chatId);
    if (!convo) {
      res.status(404).json({ message: 'Conversation not found' });
      return;
    }

    // Security Fix: Verify user is participant
    if (!convo.users.some(u => String(u) === String(req.user._id))) {
      res.status(403).json({ message: 'Forbidden: You are not a participant' });
      return;
    }

    // Incremental sync: with a `since` cursor, return only messages created or
    // updated after it (new messages, plus edits/reactions that bump updatedAt).
    // The mobile client passes the timestamp of its newest cached message and
    // merges the delta by id, so it doesn't refetch the whole thread each sync.
    // Realtime edits/deletes still arrive over sockets; this is the catch-up net.
    const sinceRaw = typeof req.query.since === 'string' ? req.query.since : undefined;
    const sinceDate = sinceRaw ? new Date(sinceRaw) : null;
    const sinceValid = sinceDate && !isNaN(sinceDate.getTime());

    const messages = await Message.find({
      chat: req.params.chatId,
      deletedFor: { $ne: req.user._id },
      ...(sinceValid ? { $or: [{ createdAt: { $gt: sinceDate } }, { updatedAt: { $gt: sinceDate } }] } : {}),
    })
      .populate('sender', 'full_name username avatar email uniqueTag isOnline status_message publicKey')
      .populate('chat')
      .populate({
        path: 'parent_message',
        populate: { path: 'sender', select: 'full_name uniqueTag' }
      })
      .sort({ createdAt: 1 });

    const formatted = await Promise.all(messages.map(formatMessage));
    res.status(200).json(formatted);

    // Offline delivery catch-up: fetching history means every message in it has
    // now REACHED this user's device. Mark them delivered and (privacy allowing)
    // notify senders — this is how a push-launched or cold-started client flips
    // the sender's ticks from 1 gray to 2 gray. Fire-and-forget after respond.
    setImmediate(async () => {
      try {
        const userId = req.user._id;
        const pending = messages
          .filter((msg: any) =>
            String(msg.sender?._id || msg.sender) !== String(userId) &&
            !(msg.deliveredTo || []).some((d: any) => String(d) === String(userId)))
          .map((msg: any) => String(msg._id));
        if (pending.length === 0) return;

        await Message.updateMany(
          { _id: { $in: pending } },
          { $addToSet: { deliveredTo: userId } }
        );

        if (req.user?.privacy_settings?.read_receipts === false) return;
        const io = req.io || getIO();
        await emitToConversation(io, String(req.params.chatId), convo.users as any[], 'message_delivery_receipt', {
          chatId: String(req.params.chatId),
          messageIds: pending,
          deliveredBy: String(userId),
        });
      } catch (err) {
        console.error('[Delivery] history catch-up failed:', err);
      }
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * Handle File/Media Uploads
 * POST /api/v1/message/upload
 */
export const uploadMedia = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ message: 'No file uploaded' });
    return;
  }

  try {
    const result = await uploadToFilebase(fs.createReadStream(req.file.path), req.file.originalname, req.file.mimetype);
    fs.unlinkSync(req.file.path);
    res.status(200).json({
      url: result.url,
      file_key: result.key, // result.key exists in { url, key }
      mimetype: req.file.mimetype,
      size: req.file.size
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * Edit an existing message
 * PUT /api/v1/message/:messageId
 */
const EDIT_WINDOW_MS = 4 * 60 * 1000;

export const editMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  const { content } = req.body;
  const { messageId } = req.params;

  try {
    const msg = await Message.findById(messageId);
    if (!msg) { res.status(404).json({ message: 'Message not found' }); return; }

    if (String(msg.sender) !== String(req.user._id)) {
      res.status(403).json({ message: 'You can only edit your own messages' });
      return;
    }

    const createdAt = (msg as any).createdAt ? new Date((msg as any).createdAt).getTime() : Date.now();
    if (Date.now() - createdAt > EDIT_WINDOW_MS) {
      res.status(403).json({ message: 'Edit window expired', code: 'EDIT_WINDOW_EXPIRED' });
      return;
    }

    const updated = await Message.findByIdAndUpdate(
      messageId,
      {
        content,
        $push: { edit_history: { content: msg.content, editedAt: new Date() } }
      },
      { returnDocument: 'after' }
    ).populate('sender', 'full_name username avatar');

    const formatted = await formatMessage(updated);
    try {
      const io = req.io || getIO();
      const convo = await Conversation.findById((updated as any).chat);
      await emitToConversation(io, String((updated as any).chat), (convo?.users as any[]) || [], 'message_edited', formatted);
    } catch (socketErr) {
      console.error('Socket emit message_edited failed:', socketErr);
    }

    res.status(200).json(formatted);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * React to a message
 * POST /api/v1/message/:messageId/react
 */
export const reactToMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  const { emoji } = req.body;
  const { messageId } = req.params;
  const userId = req.user?._id;

  try {
    const msg = await Message.findById(messageId);
    if (!msg) { res.status(404).json({ message: 'Message not found' }); return; }

    const existingReactionIndex = msg.reactions.findIndex(r => String(r.user) === String(userId));

    if (existingReactionIndex > -1) {
      if (msg.reactions[existingReactionIndex].emoji === emoji) {
        msg.reactions.splice(existingReactionIndex, 1);
      } else {
        msg.reactions[existingReactionIndex].emoji = emoji;
      }
    } else {
      msg.reactions.push({ user: (userId as any), emoji, timestamp: new Date() });
    }

    await msg.save();
    try {
      const io = req.io || getIO();
      const reactionPayload = {
        messageId,
        chatId: String(msg.chat),
        reactions: msg.reactions
      };
      const convo = await Conversation.findById(msg.chat);
      await emitToConversation(io, String(msg.chat), (convo?.users as any[]) || [], 'message_reaction', reactionPayload);
    } catch (socketErr) {
      console.error('Socket emit message_reaction failed:', socketErr);
    }
    res.status(200).json({ message: 'Reaction updated', reactions: msg.reactions });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * Delete a message (soft delete for user or hard delete for all)
 * DELETE /api/v1/message/:messageId
 */
export const deleteMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  const { messageId } = req.params;
  const { type } = req.query; // 'everyone' or 'me'
  const userId = req.user?._id;

  try {
    const msg = await Message.findById(messageId);
    if (!msg) { res.status(404).json({ message: 'Message not found' }); return; }

    if (type === 'everyone') {
      if (String(msg.sender) !== String(userId)) {
        res.status(403).json({ message: 'Unauthorized to delete for everyone' });
        return;
      }
      await Message.findByIdAndDelete(messageId);

      // If this was the conversation's latest message, re-point latestMessage to
      // the newest surviving one. Leaving a dangling ref made populate() return
      // null, which the chat-list 1:1 gate reads as "empty DM" — silently hiding
      // the whole conversation from BOTH participants' lists.
      try {
        const convoDoc = await Conversation.findById(msg.chat).select('latestMessage');
        if (convoDoc && String(convoDoc.latestMessage) === String(messageId)) {
          const newest = await Message.findOne({ chat: msg.chat })
            .sort({ createdAt: -1 })
            .select('_id');
          await Conversation.findByIdAndUpdate(msg.chat, { latestMessage: newest?._id || null });
        }
      } catch (repointErr) {
        console.error('Failed to re-point latestMessage after delete:', repointErr);
      }

      try {
        const io = req.io || getIO();
        const deletePayload = {
          messageId,
          chatId: String(msg.chat),
          deletedForEveryone: true
        };
        const convo = await Conversation.findById(msg.chat);
        await emitToConversation(io, String(msg.chat), (convo?.users as any[]) || [], 'message_deleted', deletePayload);
      } catch (socketErr) {
        console.error('Socket emit message_deleted failed:', socketErr);
      }
      res.status(200).json({ message: 'Message deleted for everyone' });
    } else {
      await Message.findByIdAndUpdate(messageId, { $addToSet: { deletedFor: userId } });
      try {
        const io = req.io || getIO();
        io.to(String(userId)).emit('message_deleted', {
          messageId,
          chatId: String(msg.chat),
          deletedForUser: String(userId)
        });
      } catch (socketErr) {
        console.error('Socket emit message_deleted for user failed:', socketErr);
      }
      res.status(200).json({ message: 'Message deleted for you' });
    }
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * Mark messages as read
 * PUT /api/v1/message/read/:chatId
 */
export const markAsRead = async (req: AuthRequest, res: Response): Promise<void> => {
  const { chatId } = req.params;
  const userId = req.user?._id;

  try {
    await Message.updateMany(
      { chat: chatId, sender: { $ne: userId } },
      // Reading implies delivery — keep both arrays consistent.
      { $addToSet: { readBy: userId, deliveredTo: userId }, isRead: true }
    );

    try {
      const io = req.io || getIO();
      // Reach senders even when they don't have this chat open (room-only emission
      // missed them). Respect the reader's read-receipt privacy: the DB is always
      // updated (unread counts), but receipts are only surfaced when allowed.
      const convoForCount = await Conversation.findById(chatId).select('isGroupChat users').lean();
      if (req.user?.privacy_settings?.read_receipts !== false) {
        await emitToConversation(io, String(chatId), (convoForCount?.users as any[]) || [], 'messages_read', { chatId, userId });
      }

      // Keep the badge authoritative: recompute this user's unread count for the
      // chat (now zero) and push it to their personal room so every device syncs.
      const unreadCount = await countUnreadForUser(chatId, userId, !!convoForCount?.isGroupChat);
      io.to(String(userId)).emit('unread_count_updated', { chatId, unreadCount });
    } catch (socketErr) {
      console.error('Socket emit messages_read failed:', socketErr);
    }

    res.status(200).json({ message: 'Messages marked as read' });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Aliases & Wrappers for Routes ────────────────────────────────────────────

export const updateMessage = editMessage;
export const markMessagesRead = markAsRead;

/**
 * Delete message for current user only
 */
export const deleteForMe = async (req: AuthRequest, res: Response): Promise<void> => {
  req.query.type = 'me';
  return deleteMessage(req, res);
};

/**
 * Delete message for all participants
 */
export const deleteForEveryone = async (req: AuthRequest, res: Response): Promise<void> => {
  req.query.type = 'everyone';
  return deleteMessage(req, res);
};

/**
 * Proxy media requests to get signed URLs
 */
export const proxyMedia = async (req: AuthRequest, res: Response): Promise<void> => {
  const { url } = req.query;
  if (!url) {
    res.status(400).json({ message: 'URL query parameter is required' });
    return;
  }
  try {
    // Forward Range so mobile AV players (voice notes, video) can stream with
    // 206 partial responses — required by iOS AVPlayer.
    await streamS3Object(url as string, res, undefined, req.headers.range as string | undefined);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * Toggle message pin status
 */
export const toggleMessagePin = async (req: AuthRequest, res: Response): Promise<void> => {
  const { messageId } = req.params;
  try {
    const msg = await Message.findById(messageId);
    if (!msg) {
      res.status(404).json({ message: 'Message not found' });
      return;
    }
    msg.is_pinned = !msg.is_pinned;
    await msg.save();
    res.status(200).json({
      message: `Message ${msg.is_pinned ? 'pinned' : 'unpinned'}`,
      is_pinned: msg.is_pinned
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * Share a file from a workspace into a chat
 */
export const shareWorkspaceFile = async (req: AuthRequest, res: Response): Promise<void> => {
  const { chatId, workspaceFileId, content } = req.body;
  if (!chatId || !workspaceFileId) {
    res.status(400).json({ message: 'Missing chatId or workspaceFileId' });
    return;
  }

  try {
    const newMessage = await Message.create({
      sender: req.user._id,
      chat: chatId,
      content: content || '',
      message_type: 'file',
      workspaceFile: workspaceFileId,
      readBy: [req.user._id],
    });

    const fullMessage = await Message.findById(newMessage._id)
      .populate('sender', 'full_name username avatar email')
      .populate('chat')
      .populate('workspaceFile');

    res.status(201).json(await formatMessage(fullMessage));
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};
