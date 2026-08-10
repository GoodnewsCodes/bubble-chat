import { EventEmitter } from 'events';
import { User } from '../models/users';
import { Organization } from '../models/organizations';
import { Conversation } from '../models/conversations';
import { Message } from '../models/messages';
import { ingestToBrain, BrainSourceKind } from './brainIngest';
import { extractTextFromFile } from './fileText';
import { updateExpertiseRadar } from '../controllers/continuityController';
import { logActivity } from '../controllers/activityLogController';
import { getSignedMediaUrl } from './filebase';
import { transcribeAudio } from './whisperService';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Central Brain Event Bus.
 * Other parts of the system emit events here;
 * this listener ingests them into the knowledge base without
 * coupling directly to any controller.
 */
export const brainEventBus = new EventEmitter();

// Prevent uncaught listener warnings for production usage
brainEventBus.setMaxListeners(20);

// ─── Internal helper ──────────────────────────────────────────────────────────

const ingestTextToOrg = async (
  text: string,
  title: string,
  tags: string[],
  orgId: string,
  namespace: string,
  createdBy: string,
  department = 'general',
  sourceKind: BrainSourceKind = 'document'
) => {
  // Delegate to the single shared brain-ingestion core so the event-bus path and
  // the HTTP/onboarding path stay byte-for-byte consistent (same chunking, same
  // embedding model, same metadata incl. the createdAtTs timestamp for recall).
  await ingestToBrain({
    orgId,
    namespace,
    title,
    content: text,
    createdBy,
    tags,
    department,
    accessLevel: 'public',
    source: { kind: sourceKind },
  });

  if (tags.length > 0) {
    await updateExpertiseRadar(createdBy, orgId, tags, 2);
  }
};

// ─── Event: Group Message Sent ────────────────────────────────────────────────

/**
 * Emitted by the message socket/controller when a group message is saved.
 * Payload: { messageId: string, chatId: string, senderId: string }
 */
brainEventBus.on('group_message_sent', async (payload: { messageId: string; chatId: string; senderId: string }) => {
  try {
    const { messageId, chatId, senderId } = payload;

    // Only ingest group chats that belong to an org
    const chat = await Conversation.findById(chatId).select('organizationId chatName isGroupChat');
    if (!chat || !chat.isGroupChat || !chat.organizationId) return;

    const org = await Organization.findById(chat.organizationId);
    if (!org) return;

    const message = await Message.findById(messageId).populate('sender', 'full_name username');
    if (!message || !message.content) return;

    // E2EE removed — group messages are plaintext, ingested directly. (Only group
    // messages reach this listener; DMs are never ingested by the Brain.)
    const messageText = message.content;
    if (messageText.trim().length < 10) return;

    const senderName = (message.sender as any)?.full_name || (message.sender as any)?.username || 'User';
    const content = `[${chat.chatName}] ${senderName}: ${messageText}`;
    const namespace = org.pineconeNamespace || `org-${org._id}`;

    await ingestTextToOrg(
      content,
      `Group Chat: ${chat.chatName}`,
      ['chat', 'group', chat.chatName.toLowerCase()],
      org._id.toString(),
      namespace,
      senderId,
      'communications',
      'chat'
    );

    // console.log(`[Brain Event] Ingested group message ${messageId} for org ${org.name}`);
  } catch (err) {
    console.error('[Brain Event] group_message_sent ingestion failed:', err);
  }
});

// ─── Event: Meeting Ended ─────────────────────────────────────────────────────

/**
 * Emitted after a meeting is ended and transcript/summary are ready.
 * Payload: { meetingId: string, organizationId: string, hostId: string, title: string, transcript: string, summary: string, tags?: string[] }
 */
brainEventBus.on('meeting_ended', async (payload: {
  meetingId: string;
  organizationId: string;
  hostId: string;
  title: string;
  transcript: string;
  summary: string;
  tags?: string[];
}) => {
  try {
    const { meetingId, organizationId, hostId, title, transcript, summary, tags = [] } = payload;
    if (!transcript && !summary) return;

    const org = await Organization.findById(organizationId);
    if (!org) return;

    const namespace = org.pineconeNamespace || `org-${org._id}`;
    const allTags = ['meeting', 'transcript', ...tags];
    const content = summary ? `${summary}\n\n${transcript}` : transcript;

    await ingestTextToOrg(
      content,
      `Meeting: ${title}`,
      allTags,
      org._id.toString(),
      namespace,
      hostId,
      'meetings',
      'meeting'
    );

    // console.log(`[Brain Event] Re-indexed meeting ${meetingId} into org ${org.name} brain`);
  } catch (err) {
    console.error('[Brain Event] meeting_ended ingestion failed:', err);
  }
});

// ─── Event: Calendar Event Created ───────────────────────────────────────────

/**
 * Emitted when a calendar event or meeting is created.
 * Payload: { eventId: string, organizationId: string, createdBy: string, title: string, description?: string, agenda?: string, eventType: string, startTime: string }
 */
brainEventBus.on('calendar_event_created', async (payload: {
  eventId: string;
  organizationId: string;
  createdBy: string;
  title: string;
  description?: string;
  agenda?: string;
  eventType: string;
  startTime: string;
}) => {
  try {
    const { eventId, organizationId, createdBy, title, description, agenda, eventType, startTime } = payload;

    const org = await Organization.findById(organizationId);
    if (!org) return;

    const namespace = org.pineconeNamespace || `org-${org._id}`;
    const content = [
      `Calendar Event: ${title}`,
      `Type: ${eventType}`,
      `Date: ${new Date(startTime).toLocaleString()}`,
      description ? `Description: ${description}` : '',
      agenda ? `Agenda: ${agenda}` : '',
    ].filter(Boolean).join('\n');

    await ingestTextToOrg(
      content,
      `Event: ${title}`,
      ['calendar', 'event', eventType],
      org._id.toString(),
      namespace,
      createdBy,
      'meetings',
      'calendar'
    );

    // console.log(`[Brain Event] Ingested calendar event "${title}" for org ${org.name}`);
  } catch (err) {
    console.error('[Brain Event] calendar_event_created ingestion failed:', err);
  }
});

// ─── Event: Org Document Uploaded ────────────────────────────────────────────

/**
 * Emitted when a document is manually uploaded to the org workspace/storage.
 * Payload: { documentId: string, organizationId: string, uploadedBy: string, title: string, content: string, tags?: string[], department?: string }
 */
brainEventBus.on('document_uploaded', async (payload: {
  documentId: string;
  organizationId: string;
  uploadedBy: string;
  title: string;
  content: string;
  tags?: string[];
  department?: string;
}) => {
  try {
    const { organizationId, uploadedBy, title, content, tags = [], department = 'general' } = payload;
    if (!content || content.trim().length < 20) return;

    const org = await Organization.findById(organizationId);
    if (!org) return;

    const namespace = org.pineconeNamespace || `org-${org._id}`;
    await ingestTextToOrg(
      content,
      title,
      ['document', ...tags],
      org._id.toString(),
      namespace,
      uploadedBy,
      department
    );

    // console.log(`[Brain Event] Ingested uploaded document "${title}" for org ${org.name}`);

    if (uploadedBy) {
      logActivity({
        actor: uploadedBy,
        action: 'document_ingested',
        entityId: payload.documentId,
        entityType: 'OrgDocument',
        entityLabel: title,
        metadata: { department, tags, organizationId },
      });
    }
  } catch (err) {
    console.error('[Brain Event] document_uploaded ingestion failed:', err);
  }
});

// ─── Event: Chat File Shared ─────────────────────────────────────────────────

const TEXT_LIKE_MIME = /^(text\/|application\/(json|x-yaml|csv|xml))/i;
const AUDIO_VIDEO_EXT = ['.mp3', '.wav', '.m4a', '.webm', '.ogg', '.oga', '.aac', '.3gp', '.mp4', '.mov', '.amr', '.caf'];

/**
 * Emitted by messageController when a non-text message (file/voice/video/image)
 * is shared in a group chat. The file is fetched from storage, normalized to
 * text where possible (transcript for audio/video, raw read for text formats),
 * and ingested into the brain.
 */
brainEventBus.on('chat_file_shared', async (payload: {
  messageId: string;
  chatId: string;
  senderId: string;
  mediaUrl: string;
  mimeType?: string;
  caption?: string;
}) => {
  try {
    const { chatId, senderId, mediaUrl, mimeType, caption } = payload;

    const chat = await Conversation.findById(chatId).select('organizationId chatName isGroupChat');
    if (!chat || !chat.isGroupChat || !chat.organizationId) return;

    const org = await Organization.findById(chat.organizationId);
    if (!org) return;

    const lowerUrl = mediaUrl.toLowerCase().split('?')[0];
    const isAudioVideo =
      (mimeType && (mimeType.startsWith('audio/') || mimeType.startsWith('video/'))) ||
      AUDIO_VIDEO_EXT.some((ext) => lowerUrl.endsWith(ext));
    const isTextLike = mimeType ? TEXT_LIKE_MIME.test(mimeType) : false;
    // PDFs and DOCX now have a real text extractor (shared with HTTP uploads).
    const isDoc =
      (mimeType === 'application/pdf' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') ||
      /\.(pdf|docx)$/i.test(lowerUrl);

    if (!isAudioVideo && !isTextLike && !isDoc) {
      // Images and other binaries — no text extractor. Skip rather than poison
      // the brain with binary garbage.
      // console.log(`[Brain Event] chat_file_shared skipped (unsupported mime: ${mimeType || 'unknown'})`);
      return;
    }

    const signedUrl = await getSignedMediaUrl(mediaUrl);
    const res = await fetch(signedUrl);
    if (!res.ok) return;

    let extractedText = '';
    let title = chat.chatName ? `File in ${chat.chatName}` : 'Shared File';

    if (isAudioVideo) {
      const ext = path.extname(mediaUrl).split('?')[0] || '.bin';
      const tmpPath = path.join(os.tmpdir(), `brain-${crypto.randomUUID()}${ext}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(tmpPath, buf);
      try {
        extractedText = await transcribeAudio(tmpPath);
        title = `Voice/Video in ${chat.chatName}`;
      } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    } else if (isDoc) {
      const buf = Buffer.from(await res.arrayBuffer());
      extractedText = (await extractTextFromFile(buf, mimeType || '', lowerUrl)) || '';
      title = `Document in ${chat.chatName}`;
    } else {
      extractedText = await res.text();
    }

    if (caption && caption.trim()) {
      extractedText = `Caption: ${caption.trim()}\n\n${extractedText}`;
    }

    if (!extractedText || extractedText.trim().length < 10) return;

    const namespace = org.pineconeNamespace || `org-${org._id}`;
    await ingestTextToOrg(
      extractedText,
      title,
      ['chat', 'file', 'shared'],
      org._id.toString(),
      namespace,
      senderId,
      'communications',
      isAudioVideo ? 'chat' : 'chat_file'
    );

    // console.log(`[Brain Event] Ingested chat file (${isAudioVideo ? 'transcript' : isDoc ? 'document' : 'text'}) for org ${org.name}`);
  } catch (err) {
    console.error('[Brain Event] chat_file_shared ingestion failed:', err);
  }
});

// ─── Event: QA Resolved (closed loop, automatic) ─────────────────────────────

/**
 * Emitted automatically when a reply lands on a message that originated from
 * the Knowledge Continuity Engine's expert routing (the reply's parent_message
 * has a brainQuestionRef). Mirrors the manual POST /api/brain/qa/resolve flow.
 */
brainEventBus.on('qa_resolved', async (payload: { questionMessageId: string; replyMessageId: string }) => {
  try {
    const { questionMessageId, replyMessageId } = payload;

    const [question, reply] = await Promise.all([
      Message.findById(questionMessageId).populate('chat', 'organizationId'),
      Message.findById(replyMessageId).populate('sender', 'full_name username'),
    ]);
    if (!question || !reply) return;

    const orgId = (question.chat as any)?.organizationId;
    if (!orgId) return;

    const org = await Organization.findById(orgId);
    if (!org) return;

    const answererId = String((reply.sender as any)?._id || reply.sender);
    const qaContent = `Question:\n${question.content}\n\nAnswer:\n${reply.content}`;
    const namespace = org.pineconeNamespace || `org-${org._id}`;

    await ingestTextToOrg(
      qaContent,
      `Resolved Q&A`,
      ['qa', 'resolved'],
      org._id.toString(),
      namespace,
      answererId,
      'general',
      'qa'
    );

    // Reward the expert for closing the loop.
    await updateExpertiseRadar(answererId, org._id.toString(), ['qa', 'resolved'], 10);

    // console.log(`[Brain Event] Closed-loop Q&A ingested for org ${org.name}`);
  } catch (err) {
    console.error('[Brain Event] qa_resolved ingestion failed:', err);
  }
});

/**
 * Initialize the brain event listener.
 * Call this once from index.ts after DB connection.
 *
 * Events handled:
 *  - group_message_sent      : auto-ingest group chat messages (DMs are NEVER ingested — E2E privacy)
 *  - chat_file_shared        : auto-ingest files / voice notes / videos shared in group chats
 *  - meeting_ended           : ingest meeting transcript + summary after a call ends
 *  - calendar_event_created  : ingest event metadata for discoverability and agenda pre-fill
 *  - document_uploaded       : ingest manually uploaded org documents immediately
 *  - qa_resolved             : closed-loop capture of expert replies routed via the brain
 */
export const initBrainEventListener = () => {
  // console.log('🧠 [Brain Event Listener] Initialized — group_message_sent, chat_file_shared, meeting_ended, calendar_event_created, document_uploaded, qa_resolved. DMs excluded by design (private 1:1s are never ingested).');
};
