import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { User } from '../models/users';
import { Meeting } from '../models/meeting';
import mongoose from 'mongoose';
import { sendPushNotification } from './push';
import { logActivity } from '../controllers/activityLogController';


let io: Server;

// Authoritative presence registry: userId -> set of that user's live socket ids.
// A user is "online" while they have at least one connected socket. This makes
// presence robust to multiple tabs/devices — closing one tab no longer flips the
// user offline while another is still connected, and offline only fires on the
// genuine last disconnect.
const onlineSockets = new Map<string, Set<string>>();

// Users who opted out of presence (privacy_settings.show_online_status=false).
// They still connect and receive everything — they just never appear online to
// others: no user_status_change broadcast, excluded from presence_snapshot, and
// User.isOnline stays false so REST-formatted user objects agree.
const hiddenStatusUsers = new Set<string>();

export const getOnlineUserIds = (): string[] =>
  Array.from(onlineSockets.keys()).filter((id) => !hiddenStatusUsers.has(id));

/**
 * Live-update presence privacy when the user flips "Online status" in Settings
 * (called from updateProfile). Broadcasts the resulting appear/disappear so
 * other clients update immediately instead of waiting for a reconnect.
 */
export const setUserStatusHidden = async (userId: string, hidden: boolean): Promise<void> => {
  const uid = String(userId);
  const wasHidden = hiddenStatusUsers.has(uid);
  if (hidden) hiddenStatusUsers.add(uid);
  else hiddenStatusUsers.delete(uid);
  if (wasHidden === hidden || !io) return;

  const isConnected = (onlineSockets.get(uid)?.size || 0) > 0;
  if (!isConnected) return;
  try {
    await User.findByIdAndUpdate(uid, { isOnline: !hidden, lastSeen: new Date() });
    io.emit('user_status_change', { userId: uid, isOnline: !hidden });
  } catch (err) {
    console.error('Presence privacy update failed:', err);
  }
};

// Active group/multi-party calls, keyed by roomId. Lets us re-remind members who
// were invited but haven't joined yet, every few minutes, while the call is live.
interface ActiveGroupCall {
  invited: Set<string>;
  joined: Set<string>;
  type: 'voice' | 'video';
  callerName: string;
  callerAvatar?: string;
  startedAt: number;
  lastReminder: number;
}
const activeGroupCalls = new Map<string, ActiveGroupCall>();

// ─── Busy-call registry ─────────────────────────────────────────────────────
// userId -> the call they're currently in (ringing out or connected). Lets the
// server suppress a second incoming ring entirely: the busy target never hears
// it, and the caller gets an immediate `call_busy` instead of 30s of ringback.
// In-memory (resets on restart) — clients keep their own auto-reject fallback.
interface ActiveUserCall {
  roomId: string;
  type: 'voice' | 'video';
  since: number;
}
const activeCallByUser = new Map<string, ActiveUserCall>();

// Anything older than this is presumed to be a leaked entry (missed hangup).
const ACTIVE_CALL_STALE_MS = 10 * 60 * 1000; // 10 minutes (down from 4h so leaked slots quickly self-heal)

const getActiveCall = (userId: string): ActiveUserCall | undefined => {
  const entry = activeCallByUser.get(String(userId));
  if (!entry) return undefined;
  if (Date.now() - entry.since > ACTIVE_CALL_STALE_MS) {
    activeCallByUser.delete(String(userId));
    return undefined;
  }
  return entry;
};

const setActiveCall = (userId: string, roomId: string, type: 'voice' | 'video') => {
  activeCallByUser.set(String(userId), { roomId, type, since: Date.now() });
};

// Clear every user whose active call is the given room (used when a room ends).
// Exported so the HTTP endMeeting path can free participants' busy slots too.
export const clearActiveCallsForRoom = (roomId?: string) => {
  if (!roomId) return;
  for (const [uid, entry] of activeCallByUser) {
    if (entry.roomId === roomId) activeCallByUser.delete(uid);
  }
};

const GROUP_REMINDER_INTERVAL_MS = 5 * 60 * 1000;  // re-ring inactive members every 5 min
const GROUP_CALL_MAX_AGE_MS = 30 * 60 * 1000;      // stop reminding after 30 min

const endGroupCallTracking = (roomId?: string) => {
  if (roomId) activeGroupCalls.delete(roomId);
};

// ─── Empty-room safeguard ──────────────────────────────────────────────────
// Leaving never ends a meeting by itself — only the host's explicit End does
// (see call_end/meeting_ended handlers). But if a meeting's room genuinely
// empties out (everyone left or dropped, including the host, without anyone
// clicking End), the Meeting record would stay 'live' forever. Give it a short
// grace period for reconnects, then auto-end it.
const EMPTY_ROOM_GRACE_MS = 45 * 1000;
const scheduleEmptyRoomCheck = (roomId: string) => {
  if (!roomId) return;
  setTimeout(async () => {
    try {
      const stillOccupied = (io.sockets.adapter.rooms.get(roomId)?.size || 0) > 0;
      if (stillOccupied) return;
      const { autoEndMeetingByRoomId } = await import('../controllers/meetingController');
      await autoEndMeetingByRoomId(roomId);
    } catch (err) {
      console.error('[Meeting] Empty-room check failed:', err);
    }
  }, EMPTY_ROOM_GRACE_MS);
};

export const initSocket = (server: HttpServer) => {
  io = new Server(server, {
    pingTimeout: 60000,
    pingInterval: 25000,
    cors: {
      origin: '*', // For development, allow all origins
      methods: ['GET', 'POST'],
    },
  });

  // Recurring reminder: every minute, re-ring + push members who were invited to a
  // group call but haven't joined, at most once per GROUP_REMINDER_INTERVAL_MS, until
  // they join or the call ages out / ends.
  setInterval(() => {
    const now = Date.now();
    for (const [roomId, call] of activeGroupCalls) {
      if (now - call.startedAt > GROUP_CALL_MAX_AGE_MS) { activeGroupCalls.delete(roomId); continue; }
      if (now - call.lastReminder < GROUP_REMINDER_INTERVAL_MS) continue;
      const pending = [...call.invited].filter((u) => !call.joined.has(u));
      if (pending.length === 0) continue;
      call.lastReminder = now;
      for (const uid of pending) {
        io.to(uid).emit('incoming_call', {
          fromUserId: 'group',
          roomId,
          callerName: call.callerName,
          callerAvatar: call.callerAvatar,
          type: call.type,
          isReminder: true,
        });
      }
      const typeStr = call.type === 'video' ? 'video call' : 'voice call';
      sendPushNotification(
        pending,
        `Ongoing ${typeStr}`,
        `${call.callerName}'s group ${typeStr} is still going — tap to join`,
        { roomId, type: 'incoming_call', callType: call.type, callerName: call.callerName },
        'call'
      ).catch((err) => console.error('[GroupCall] reminder push failed:', err));
    }
  }, 60 * 1000);

  // Socket authentication middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error: Token missing'));
    }
    // Never verify against a hardcoded fallback secret — that would accept
    // attacker-minted tokens whenever JWT_KEY is unset.
    const secret = process.env.JWT_KEY;
    if (!secret) {
      return next(new Error('Authentication error: server JWT key not configured'));
    }
    jwt.verify(token, secret, async (err: any, decoded: any) => {
      if (err) return next(new Error('Authentication error: Invalid token'));
      (socket as any).userId = decoded.id;
      // ALSO store on socket.data — custom props set directly on the socket are NOT
      // carried by the RemoteSocket objects returned from io.fetchSockets(); only
      // socket.data survives. emitToConversation relies on this to detect who is in
      // a room (without it, every in-room user gets a duplicate delivery).
      socket.data.userId = decoded.id;
      try {
        const user = await User.findById(decoded.id).select('username full_name privacy_settings');
        if (user) {
          (socket as any).username = user.username;
          (socket as any).fullName = user.full_name;
          // Presence privacy: remember opted-out users so connection handling
          // below can keep them invisible to everyone else.
          if ((user as any).privacy_settings?.show_online_status === false) {
            hiddenStatusUsers.add(String(decoded.id));
          } else {
            hiddenStatusUsers.delete(String(decoded.id));
          }
        }
      } catch (dbErr) {
        console.error('Socket auth DB lookup error:', dbErr);
      }
      next();
    });
  });

  io.on('connection', (socket: Socket) => {
    const userId = (socket as any).userId;
    // console.log(`✅ Authenticated socket connection: ${socket.id} (User: ${userId})`);

    // Automatically register user on connection and join their personal room
    socket.join(String(userId)); // <-- personal room: guarantees delivery even when no chat is open

    // Register this socket; only broadcast "online" on the FIRST socket for the user.
    const existing = onlineSockets.get(userId) || new Set<string>();
    const wasOffline = existing.size === 0;
    existing.add(socket.id);
    onlineSockets.set(userId, existing);

    const statusHidden = hiddenStatusUsers.has(String(userId));
    if (wasOffline) {
      // Hidden users never flip isOnline in the DB and never broadcast — they
      // stay "offline" to everyone while still fully connected themselves.
      User.findByIdAndUpdate(userId, { socketId: socket.id, isOnline: !statusHidden, lastSeen: new Date() })
        .then(() => {
          if (!statusHidden) {
            socket.broadcast.emit('user_status_change', { userId, isOnline: true });
          }
        })
        .catch((err) => console.error('Presence online update failed:', err));
    } else {
      // Keep socketId pointing at a live socket for any legacy lookups.
      User.findByIdAndUpdate(userId, { socketId: socket.id }).catch(() => undefined);
    }

    // Seed the connecting client with everyone currently online so its UI starts
    // correct instead of waiting for the next delta event.
    socket.emit('presence_snapshot', { online: getOnlineUserIds() });

    // ─── Chat Room Management ─────────────────────────────────────────────────
    // Clients must join a room to receive real-time events scoped to that chat.

    socket.on('join_room', async (chatId: string) => {
      try {
        const { Conversation } = await import('../models/conversations');
        const convo = await Conversation.findById(chatId);
        if (convo && convo.users.map((id: any) => id.toString()).includes(userId)) {
          socket.join(chatId);
          // console.log(`[Room] User ${userId} joined conversation room: ${chatId}`);
          return;
        }

        // Allow meeting rooms starting with meet- or matching a live meeting user is associated with
        const { Meeting } = await import('../models/meeting');
        const isObjectId = mongoose.Types.ObjectId.isValid(chatId);
        const meeting = await Meeting.findOne({
          $or: [
            ...(isObjectId ? [{ _id: chatId }] : []),
            { roomId: chatId },
          ],
          $and: [{ $or: [{ host: userId }, { attendees: userId }] }],
        });

        if (meeting || chatId.startsWith('meet-') || chatId.startsWith('bubble-')) {
          socket.join(chatId);
          // console.log(`[Room] User ${userId} joined meeting room: ${chatId}`);
        } else {
          console.warn(`[Room Security] User ${userId} attempted to join unauthorized room: ${chatId}`);
        }
      } catch (err) {
        console.error('[Room] Join error:', err);
      }
    });

    socket.on('leave_room', (chatId: string) => {
      socket.leave(chatId);
      scheduleEmptyRoomCheck(chatId);
      // console.log(`[Room] User ${userId} left room: ${chatId}`);
    });

    // ─── Direct Messages (legacy peer-to-peer fallback) ───────────────────────
    socket.on('send_message', (data: { toUserId: string; message: string; fromUserId: string; chatId?: string; isBurn?: boolean }) => {
      // If chatId is known, relay via room (preferred)
      if (data.chatId) {
        socket.to(data.chatId).emit('receive_message', data);
        return;
      }
      // Fallback: send directly to recipient's personal room
      io.to(data.toUserId).emit('receive_message', data);
    });

    // ─── Typing Indicators ────────────────────────────────────────────────────
    socket.on('typing_start', (data: { toUserId: string; chatId?: string }) => {
      const fromUsername = (socket as any).username;
      const fromName = (socket as any).fullName;
      // Emit to the chat room; also emit to the recipient's personal userId room as fallback
      if (data.chatId) socket.to(data.chatId).emit('typing_start', { fromUserId: userId, chatId: data.chatId, fromUsername, fromName });
      if (data.toUserId) io.to(data.toUserId).emit('typing_start', { fromUserId: userId, chatId: data.chatId, fromUsername, fromName });
    });

    socket.on('typing_stop', (data: { toUserId: string; chatId?: string }) => {
      if (data.chatId) socket.to(data.chatId).emit('typing_stop', { fromUserId: userId, chatId: data.chatId });
      if (data.toUserId) io.to(data.toUserId).emit('typing_stop', { fromUserId: userId, chatId: data.chatId });
    });

    socket.on('typing', (data: { chatId?: string }) => {
      const fromUsername = (socket as any).username;
      const fromName = (socket as any).fullName;
      if (data.chatId) socket.to(data.chatId).emit('typing_start', { fromUserId: userId, chatId: data.chatId, fromUsername, fromName });
    });

    socket.on('stop_typing', (data: { chatId?: string }) => {
      if (data.chatId) socket.to(data.chatId).emit('typing_stop', { fromUserId: userId, chatId: data.chatId });
    });

    // ─── Voice Recording Indicator ────────────────────────────────────────────
    socket.on('recording_start', (data: { chatId: string }) => {
      socket.to(data.chatId).emit('recording_start', { fromUserId: userId, chatId: data.chatId });
    });

    socket.on('recording_stop', (data: { chatId: string }) => {
      socket.to(data.chatId).emit('recording_stop', { fromUserId: userId, chatId: data.chatId });
    });

    // ─── Delivery Receipts ────────────────────────────────────────────────────
    // A recipient's device acks messages it just received (live) so senders can
    // flip 1-gray-tick → 2-gray-ticks. Offline catch-up happens in allMessages.
    socket.on('message_delivered', async (data: { chatId: string; messageIds: string[] }) => {
      try {
        if (!data?.chatId || !Array.isArray(data.messageIds) || data.messageIds.length === 0) return;
        const { Message } = await import('../models/messages');
        const { Conversation } = await import('../models/conversations');
        const convo = await Conversation.findById(data.chatId).select('users');
        if (!convo || !convo.users.some((u: any) => String(u) === String(userId))) return;

        await Message.updateMany(
          { _id: { $in: data.messageIds }, chat: data.chatId, sender: { $ne: userId } },
          { $addToSet: { deliveredTo: userId } }
        );

        // Respect the acker's read-receipt privacy: still record delivery in the
        // DB, but don't surface the receipt to senders.
        const acker = await User.findById(userId).select('privacy_settings').lean();
        if ((acker as any)?.privacy_settings?.read_receipts === false) return;

        const { emitToConversation } = await import('../controllers/messageController');
        await emitToConversation(io, String(data.chatId), convo.users as any[], 'message_delivery_receipt', {
          chatId: String(data.chatId),
          messageIds: data.messageIds,
          deliveredBy: String(userId),
        });
      } catch (err) {
        console.error('[Delivery] message_delivered failed:', err);
      }
    });

    // ─── Read Receipts & Burn Protocol ───────────────────────────────────────
    socket.on('message_read', async (data: { messageId: string, toUserId: string, isBurnAfterReading: boolean }) => {
      io.to(data.toUserId).emit('message_read_receipt', { messageId: data.messageId, readBy: userId });

      if (data.isBurnAfterReading) {
        setTimeout(() => {
          socket.emit('message_burned', { messageId: data.messageId });
          io.to(data.toUserId).emit('message_burned', { messageId: data.messageId });
        }, 60000);
      }
    });

    socket.on('meeting_transcript_chunk', async (data: { roomId: string, speaker?: string, text: string, userId?: string }) => {
      // Auto-resolve speaker identity from the authenticated socket session
      // This ensures silent diarization — whoever is speaking is always correctly identified
      const speakerName = (socket as any).fullName || (socket as any).username || data.speaker || 'Participant';
      const speakerId = userId || data.userId;

      // Relay for LIVE display only. Persistence is intentionally NOT done here:
      // each speaking client saves its own chunk exactly once via the HTTP
      // addMeetingTranscriptChunk endpoint (with its speakerId). Saving here too caused
      // every line to be written twice and show up duplicated in the saved/emailed transcript.
      const enrichedData = { ...data, speaker: speakerName, speakerId, userId: speakerId };
      socket.to(data.roomId).emit('meeting_transcript_chunk', enrichedData);
    });

    socket.on('meeting_started', (data: { roomId: string, meetingId: string }) => {
      // console.log(`[Meeting] Relaying meeting_started for room: ${data.roomId}`);
      io.to(data.roomId).emit('meeting_started', data);
    });

    socket.on('meeting_reaction', (data: { roomId: string, emoji: string }) => {
      socket.to(data.roomId).emit('meeting_reaction', data);
    });

    socket.on('meeting_chat_message', (data: { roomId: string, speaker: string, text: string, imageUrl?: string }) => {
      socket.to(data.roomId).emit('meeting_chat_message', data);
    });

    socket.on('meeting_ended', async (data: { roomId: string }) => {
      // A non-host leaving a multi-party meeting must not end it for the rest of the
      // group — only relay this as a real termination when the sender is the host
      // (or it's a 1:1 call, where either side ending it is the expected phone-call
      // behavior). Otherwise just drop them from the room silently.
      try {
        const meeting = await Meeting.findOne({ roomId: data.roomId, status: 'live' }).select('host attendees');
        if (meeting && meeting.attendees.length >= 2 && String(meeting.host) !== String(userId)) {
          socket.leave(data.roomId);
          return;
        }
      } catch (err) {
        console.error('[Meeting] Failed to verify host on meeting_ended:', err);
      }
      // console.log(`[Meeting] Relaying meeting_ended for room: ${data.roomId}`);
      io.to(data.roomId).emit('meeting_ended', data);
      endGroupCallTracking(data.roomId);
      clearActiveCallsForRoom(data.roomId);
    });

    // ─── E2EE Public Key Exchange ─────────────────────────────────────────────
    socket.on('request_public_key', async (data: { targetUserId: string }) => {
      const target = await User.findById(data.targetUserId);
      if (target && target.publicKey) {
        socket.emit('receive_public_key', { userId: data.targetUserId, publicKey: target.publicKey });
      }
    });

    // ─── Call Signaling ───────────────────────────────────────────────────────
    socket.on('call_offer', async (data: { toUserId: string; roomId: string; callerName?: string; callerAvatar?: string; type?: 'voice' | 'video' }) => {
      // Use authenticated socket identity as the authoritative caller name
      const callerName = (socket as any).fullName || (socket as any).username || data.callerName || 'Colleague';

      // Busy gate: if the target is already in a different call, don't ring or
      // push them at all — tell the caller immediately instead.
      const targetBusy = getActiveCall(data.toUserId);
      if (targetBusy && targetBusy.roomId !== data.roomId) {
        socket.emit('call_busy', { toUserId: data.toUserId, roomId: data.roomId, type: data.type || 'voice' });
        logActivity({
          actor: userId,
          action: 'call_busy',
          entityId: data.toUserId,
          entityType: 'Call',
          entityLabel: callerName,
          metadata: { roomId: data.roomId, callType: data.type || 'voice', to: data.toUserId },
        });
        return;
      }

      // Caller joins the room immediately so hangup events later reach this socket
      socket.join(data.roomId);
      // Ringing out counts as busy — a cross-ring while dialing must not double-book.
      setActiveCall(userId, data.roomId, data.type || 'voice');

      io.to(String(data.toUserId)).emit('incoming_call', {
        ...data,
        fromUserId: userId,
        callerName,
      });

      // Persist an auditable trace: who called whom, on which room, at what time.
      logActivity({
        actor: userId,
        action: 'call_initiated',
        entityId: data.toUserId,
        entityType: 'Call',
        entityLabel: callerName,
        metadata: { roomId: data.roomId, callType: data.type || 'voice', to: data.toUserId },
      });

      // Send push notification for incoming call asynchronously
      const typeStr = data.type === 'video' ? 'video call' : 'voice call';
      sendPushNotification(
        [data.toUserId],
        `Incoming ${typeStr} from ${callerName}`,
        `${callerName} is calling you...`,
        {
          roomId: data.roomId,
          type: 'incoming_call',
          callType: data.type || 'voice',
          callerName,
        },
        'call'
      ).catch(err => console.error('[Push] Incoming call push failed:', err));
    });

    // Ring an ADDITIONAL participant into a call that is already running. Unlike
    // call_offer (which the client pairs with a freshly-minted room), call_invite
    // reuses the caller's CURRENT roomId so the invitee joins the same LiveKit room.
    // LiveKit handles the N-way media natively; this only fans out the ring.
    socket.on('call_invite', async (data: { toUserId: string; roomId: string; callerName?: string; callerAvatar?: string; type?: 'voice' | 'video' }) => {
      const callerName = (socket as any).fullName || (socket as any).username || data.callerName || 'Colleague';

      // Busy gate: an invitee already in a DIFFERENT call gets no ring/push;
      // the inviter is told immediately. (Re-ringing someone into the SAME room
      // stays allowed — that's the group-reminder path.)
      const inviteeBusy = getActiveCall(data.toUserId);
      if (inviteeBusy && inviteeBusy.roomId !== data.roomId) {
        socket.emit('call_busy', { toUserId: data.toUserId, roomId: data.roomId, type: data.type || 'voice' });
        return;
      }

      // Inviter is already in the room, but join defensively in case this socket isn't.
      socket.join(data.roomId);
      // The inviter is mid-call in this room — make sure the registry knows.
      setActiveCall(userId, data.roomId, data.type || 'voice');

      io.to(String(data.toUserId)).emit('incoming_call', {
        ...data,
        fromUserId: userId,
        callerName,
      });

      logActivity({
        actor: userId,
        action: 'call_invited',
        entityId: data.toUserId,
        entityType: 'Call',
        entityLabel: callerName,
        metadata: { roomId: data.roomId, callType: data.type || 'voice', to: data.toUserId },
      });

      const typeStr = data.type === 'video' ? 'video call' : 'voice call';
      sendPushNotification(
        [data.toUserId],
        `${callerName} invited you to a ${typeStr}`,
        `${callerName} is inviting you to join...`,
        {
          roomId: data.roomId,
          type: 'incoming_call',
          callType: data.type || 'voice',
          callerName,
        },
        'call'
      ).catch(err => console.error('[Push] Call invite push failed:', err));

      // Track this as an active group call so we can re-remind no-shows. The inviter
      // (host) counts as joined; each invitee is pending until they answer.
      let call = activeGroupCalls.get(data.roomId);
      if (!call) {
        call = {
          invited: new Set<string>(),
          joined: new Set<string>([String(userId)]),
          type: data.type || 'voice',
          callerName,
          callerAvatar: data.callerAvatar,
          startedAt: Date.now(),
          lastReminder: Date.now(),
        };
        activeGroupCalls.set(data.roomId, call);
      }
      call.invited.add(String(data.toUserId));
    });

    socket.on('call_answer', async (data: { toUserId: string; roomId: string }) => {
      // Mark this member as joined so the group-call reminder stops ringing them.
      const groupCall = activeGroupCalls.get(data.roomId);
      if (groupCall) groupCall.joined.add(String(userId));

      // Callee joins the room so subsequent meeting_ended / call_ended events reach them.
      socket.join(data.roomId);
      // Answering marks BOTH parties as in-call in the busy registry.
      setActiveCall(userId, data.roomId, groupCall?.type || 'voice');
      setActiveCall(data.toUserId, data.roomId, groupCall?.type || 'voice');

      // Pull the caller's open sockets into the same room so they can hear the callee's hangup.
      try {
        const targetSockets = await io.in(data.toUserId).fetchSockets();
        for (const s of targetSockets) {
          await s.join(data.roomId);
        }
      } catch (err) {
        console.error('[Call] Failed to join caller socket(s) to room:', err);
      }

      io.to(data.toUserId).emit('call_accepted', { byUserId: userId, roomId: data.roomId });

      logActivity({
        actor: userId,
        action: 'call_accepted',
        entityId: data.toUserId,
        entityType: 'Call',
        metadata: { roomId: data.roomId, from: data.toUserId },
      });

      // If this room already has a Meeting record (it does for any call/meeting
      // created via createMeeting — both 1:1 calls and Events & Meets), record the
      // accepter as an attendee. This is what makes a mid-call invite's "consent"
      // actually count: meeting history, transcript access, and action-item
      // attribution all key off Meeting.attendees, not just who answered the ring.
      Meeting.updateOne(
        { roomId: data.roomId, host: { $ne: userId } },
        { $addToSet: { attendees: userId } }
      ).catch(err => console.error('[Meeting] Failed to add attendee on call_answer:', err));

      // Stamp the moment the callee picked up (first answer only) so the post-call
      // log entry reads as an ANSWERED call and its duration counts talk time from
      // the pickup — not the ring. Guarded on answeredAt absence so a re-answer /
      // reconnect can't reset it.
      Meeting.updateOne(
        { roomId: data.roomId, status: 'live', answeredAt: { $exists: false } },
        { $set: { answeredAt: new Date() } }
      ).catch(err => console.error('[Meeting] Failed to stamp answeredAt on call_answer:', err));
    });

    socket.on('call_reject', async (data: { toUserId: string; roomId?: string }) => {
      // A member who declines shouldn't keep getting group-call reminders — mark them
      // resolved (reuse the joined set) so the recurring ring skips them.
      if (data.roomId) {
        const gc = activeGroupCalls.get(data.roomId);
        if (gc) gc.joined.add(String(userId));
      }

      // Busy registry: a reject only frees the rejecter if it's for the call the
      // registry has them in. A busy auto-reject of a SECOND ring (different room)
      // must not clear their real active call.
      const rejecterEntry = activeCallByUser.get(String(userId));
      if (rejecterEntry && data.roomId && rejecterEntry.roomId === data.roomId) {
        activeCallByUser.delete(String(userId));
      }
      // If the caller was only ringing out on this room (not connected to anyone
      // else), a decline frees them too.
      const callerEntry = activeCallByUser.get(String(data.toUserId));
      if (callerEntry && data.roomId && callerEntry.roomId === data.roomId) {
        const stillLive = activeGroupCalls.has(data.roomId);
        if (!stillLive) activeCallByUser.delete(String(data.toUserId));
      }

      // Always tell the caller that THIS invitee declined (informational).
      io.to(data.toUserId).emit('call_rejected', { byUserId: userId, roomId: data.roomId });

      // Only a plain 1:1 call (never registered as a group/invite room) is torn
      // down by a decline. If the room is an active group/invite call, the caller
      // is a host with an ONGOING call and one invitee declining must not end it —
      // so we do NOT broadcast `call_ended` for those rooms.
      const isGroupOrInvite = data.roomId ? activeGroupCalls.has(data.roomId) : false;
      if (!isGroupOrInvite) {
        io.to(data.toUserId).emit('call_ended', { byUserId: userId, roomId: data.roomId });
        io.to(userId).emit('call_ended', { byUserId: userId, roomId: data.roomId });

        // A DECLINE (callee rejects the ring) marks the call declined so its log
        // entry reads "Declined" instead of a bland "completed". We only mark it
        // when the rejecter is NOT the meeting host and the call was never answered
        // — a HOST emitting call_reject is a caller giving up on a no-answer, which
        // must stay classified as "missed", not "declined". No-ops when the caller
        // never created a meeting (no live record to mark).
        if (data.roomId) {
          Meeting.updateOne(
            { roomId: data.roomId, status: 'live', host: { $ne: userId }, answeredAt: { $exists: false } },
            { $set: { declinedAt: new Date() } }
          ).catch(err => console.error('[Meeting] Failed to mark declinedAt on call_reject:', err));
        }
      }

      logActivity({
        actor: userId,
        action: 'call_rejected',
        entityId: data.toUserId,
        entityType: 'Call',
        metadata: { roomId: data.roomId, from: data.toUserId },
      });
    });

    socket.on('call_end', async (data: { toUserId?: string; roomId?: string }) => {
      // Explicit hangup. For a 1:1 call, either side ending it ends it for both —
      // notifying the named toUserId/self covers that regardless of room broadcast.
      // For a multi-party meeting, a non-host hanging up must NOT fan out to the
      // whole room (that would end it for every other participant); only the host's
      // hangup tears down the room broadcast.
      let broadcastToRoom = true;
      if (data.roomId) {
        try {
          const meeting = await Meeting.findOne({ roomId: data.roomId, status: 'live' }).select('host attendees');
          if (meeting && meeting.attendees.length >= 2 && String(meeting.host) !== String(userId)) {
            broadcastToRoom = false;
            socket.leave(data.roomId);
          }
        } catch (err) {
          console.error('[Call] Failed to verify host on call_end:', err);
        }
      }

      // Busy registry: the hanger-up is always freed; when the end is broadcast
      // (1:1 or host hangup) the whole room's participants are freed too.
      activeCallByUser.delete(String(userId));
      if (data.roomId && broadcastToRoom) clearActiveCallsForRoom(data.roomId);

      if (data.toUserId) io.to(data.toUserId).emit('call_ended', { byUserId: userId, roomId: data.roomId });
      io.to(userId).emit('call_ended', { byUserId: userId, roomId: data.roomId });
      if (data.roomId && broadcastToRoom) {
        io.to(data.roomId).emit('call_ended', { byUserId: userId, roomId: data.roomId });
        endGroupCallTracking(data.roomId);
        // Live Rooms list delta: drop this room from the People "LIVE" list right
        // away instead of waiting for the 30s poll to notice it's gone.
        io.emit('meeting_room_update', { action: 'ended', roomId: data.roomId });
        // AUTHORITATIVE: flip the Meeting doc to status:'ended' in the DB. Without
        // this the room stayed status:'live' forever (getActiveMeetings queries
        // status:'live'), so ended calls kept reappearing on the next poll.
        try {
          const { autoEndMeetingByRoomId } = await import('../controllers/meetingController');
          await autoEndMeetingByRoomId(data.roomId);
        } catch (err) {
          console.error('[Call] Failed to auto-end meeting on call_end:', err);
        }
      }

      logActivity({
        actor: userId,
        action: 'call_ended',
        entityId: data.toUserId,
        entityType: 'Call',
        metadata: { roomId: data.roomId, to: data.toUserId },
      });
    });

    // ─── Knock-to-join (request access to a LIVE room) ────────────────────────
    // Tapping a room in the Live Rooms list "knocks" instead of barging in: the
    // request is relayed to everyone already in the room (their sockets joined the
    // roomId room) plus the named host, so any participant can admit them. The
    // requester only enters once someone accepts (room_knock_response) — this is
    // the "ring the host to let me in" UX rather than an uninvited direct join.
    socket.on('room_knock', async (data: { roomId: string; hostId?: string; requesterAvatar?: string; type?: 'voice' | 'video' }) => {
      const requesterName = (socket as any).fullName || (socket as any).username || 'A colleague';
      const payload = {
        roomId: data.roomId,
        requesterId: String(userId),
        requesterName,
        requesterAvatar: data.requesterAvatar || null,
        type: data.type || 'video',
      };

      // Notify in-room participants…
      socket.to(data.roomId).emit('room_knock', payload);
      // …and the host explicitly, in case their socket hasn't joined the room.
      if (data.hostId && String(data.hostId) !== String(userId)) {
        io.to(String(data.hostId)).emit('room_knock', payload);
      }

      logActivity({
        actor: userId,
        action: 'room_knock',
        entityId: data.hostId || data.roomId,
        entityType: 'Call',
        entityLabel: requesterName,
        metadata: { roomId: data.roomId, type: data.type || 'video' },
      });

      if (data.hostId) {
        sendPushNotification(
          [String(data.hostId)],
          `${requesterName} wants to join`,
          `${requesterName} is asking to join your live room`,
          { roomId: data.roomId, type: 'room_knock', requesterId: String(userId) },
          'call'
        ).catch(err => console.error('[Push] Knock push failed:', err));
      }
    });

    // A host/participant answers a knock. On accept we pre-add the requester as a
    // meeting attendee so transcript access + action-item attribution count them,
    // then tell the requester's client to enter the room (or that they were denied).
    socket.on('room_knock_response', async (data: { roomId: string; requesterId: string; accepted: boolean; type?: 'voice' | 'video' }) => {
      if (data.accepted) {
        Meeting.updateOne(
          { roomId: data.roomId, host: { $ne: data.requesterId } },
          { $addToSet: { attendees: data.requesterId } }
        ).catch(err => console.error('[Meeting] Failed to add attendee on knock accept:', err));
      }

      io.to(String(data.requesterId)).emit('room_knock_response', {
        roomId: data.roomId,
        accepted: !!data.accepted,
        type: data.type || 'video',
      });

      logActivity({
        actor: userId,
        action: data.accepted ? 'room_knock_accepted' : 'room_knock_denied',
        entityId: data.requesterId,
        entityType: 'Call',
        metadata: { roomId: data.roomId },
      });
    });

    // 'disconnecting' fires BEFORE socket.io removes the socket from its rooms
    // (unlike 'disconnect', where socket.rooms is already emptied), so this is the
    // only place we can see which meeting rooms a network drop is about to vacate.
    socket.on('disconnecting', () => {
      for (const roomId of socket.rooms) {
        if (roomId === socket.id || roomId === userId) continue;
        scheduleEmptyRoomCheck(roomId);
      }
    });

    socket.on('disconnect', async () => {
      // console.log(`Socket disconnected: ${socket.id}`);
      try {
        const set = onlineSockets.get(userId);
        if (set) {
          set.delete(socket.id);
          if (set.size > 0) {
            // Other tabs/devices for this user are still connected — stay online.
            onlineSockets.set(userId, set);
            return;
          }
          onlineSockets.delete(userId);
        }

        // Last socket gone → they can't be in a call anymore; free the busy slot
        // so they can be rung the moment they reconnect.
        activeCallByUser.delete(String(userId));

        // Genuine last disconnect → mark offline and broadcast once. Hidden
        // users never appeared online, so no offline broadcast for them either.
        await User.findByIdAndUpdate(userId, {
          socketId: '',
          isOnline: false,
          lastSeen: new Date(),
        });
        if (!hiddenStatusUsers.has(String(userId))) {
          socket.broadcast.emit('user_status_change', { userId, isOnline: false });
        }
      } catch (err) {
        console.error('Error on disconnect:', err);
      }
    });
  });

  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized!');
  }
  return io;
};
