import mongoose, { Document, Schema } from 'mongoose';

export interface IMessage extends Document {
  sender: mongoose.Types.ObjectId;
  content: string; // Used for text or captions
  chat: mongoose.Types.ObjectId;
  readBy: mongoose.Types.ObjectId[];
  // Recipients whose device has RECEIVED the message (read or not). Drives the
  // two-gray-ticks "delivered" state; readBy drives the blue "read" state.
  deliveredTo: mongoose.Types.ObjectId[];

  // Rich Messaging Metadata
  message_type: 'text' | 'image' | 'video' | 'voice' | 'file' | 'location' | 'contact' | 'system' | 'call';
  parent_message?: mongoose.Types.ObjectId; // For replies/threading
  is_forwarded: boolean;
  is_announcement: boolean;
  is_encrypted: boolean;
  is_pinned: boolean;
  client_id?: string; // For idempotency

  // ── E2EE (Signal protocol) ──────────────────────────────────────────────────
  // crypto_version 0/undefined = legacy plaintext (`content`); 2 = E2EE, where
  // `content` is empty and the body lives in the encrypted fields below. Stamping
  // the version lets old plaintext history stay readable while new sends encrypt.
  crypto_version?: number;
  // Group messages (Sender Keys): ONE opaque ciphertext for every member device.
  ciphertext?: string;
  // 1:1 / multi-device (Sesame): one pairwise envelope per recipient device,
  // including the sender's OTHER devices for self-sync. The server routes these
  // but cannot read them.
  envelopes?: {
    recipientUserId: mongoose.Types.ObjectId;
    recipientDeviceId: string;
    type: 'prekey' | 'whisper' | 'senderkey' | 'sealed';
    body: string; // base64 ciphertext
  }[];
  // Group re-key generation this message was encrypted under (matches the
  // conversation's sender-key epoch), so a re-keyed recipient picks the right key.
  epoch?: number;

  // Marks a message that was sent by the Knowledge Continuity Engine on behalf
  // of a user asking the brain a low-confidence question. Replies whose
  // parent_message has this flag trigger automatic closed-loop ingestion.
  brainQuestionRef?: boolean;

  // Workspace File Attachment
  workspaceFile?: mongoose.Types.ObjectId;

  // Interaction & History
  reactions: {
    user: mongoose.Types.ObjectId;
    emoji: string;
    timestamp: Date;
  }[];
  edit_history: {
    content: string;
    editedAt: Date;
  }[];
  mentions: mongoose.Types.ObjectId[];

  // Media & Assets
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'voice' | 'file'; // Legacy/helper
  fileSize?: number;
  media_metadata?: {
    width?: number;
    height?: number;
    duration?: number; // for audio/video
    mime_type?: string;
    quality?: 'sd' | 'hd';
  };

  // Call-log entry metadata (message_type: 'call'). Rendered WhatsApp/Signal-style
  // in the thread — a call icon + type + duration, tappable to view the transcript
  // when one was captured.
  call_metadata?: {
    callType?: 'voice' | 'video';
    duration?: number; // seconds
    status?: 'completed' | 'missed' | 'declined';
    hasMinutes?: boolean;
    meetingId?: string;
  };

  // Speech-to-text of a voice note, filled in asynchronously after upload.
  transcript?: string;

  // Location specific
  location?: {
    latitude: number;
    longitude: number;
    address?: string;
    name?: string;
  };

  // Privacy
  isBurnAfterReading: boolean;
  expiresAt?: Date;

  // Soft-delete per user ("delete for me" hides from that user only)
  deletedFor?: mongoose.Types.ObjectId[];

  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema: Schema<IMessage> = new Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    content: {
      type: String,
      trim: true,
      default: '',
    },
    chat: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
    },
    readBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    // Delivered-but-not-necessarily-read recipients (two gray ticks).
    deliveredTo: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],

    // Type & Threading
    message_type: {
      type: String,
      enum: ['text', 'image', 'video', 'voice', 'file', 'location', 'contact', 'system', 'sticker', 'call'],
      default: 'text',
    },
    parent_message: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
    },
    is_forwarded: { type: Boolean, default: false },
    is_announcement: { type: Boolean, default: false },
    is_encrypted: { type: Boolean, default: false },
    is_pinned: { type: Boolean, default: false },
    client_id: { type: String },
    brainQuestionRef: { type: Boolean, default: false },

    // E2EE payloads (see IMessage). All opaque to the server.
    crypto_version: { type: Number, default: 0 },
    ciphertext: { type: String },
    envelopes: [
      {
        recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        recipientDeviceId: { type: String },
        type: { type: String, enum: ['prekey', 'whisper', 'senderkey', 'sealed'] },
        body: { type: String },
      },
    ],
    epoch: { type: Number },

    workspaceFile: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WorkspaceFile',
    },

    // Interactions
    reactions: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        emoji: { type: String },
        timestamp: { type: Date, default: Date.now },
      },
    ],
    edit_history: [
      {
        content: { type: String },
        editedAt: { type: Date, default: Date.now },
      },
    ],
    mentions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],

    // High-Quality Asset storage link
    mediaUrl: {
      type: String,
    },
    mediaType: {
      type: String,
      enum: ['image', 'video', 'voice', 'file'],
    },
    fileSize: {
      type: Number,
    },
    media_metadata: {
      width: { type: Number },
      height: { type: Number },
      duration: { type: Number },
      mime_type: { type: String },
      quality: { type: String, enum: ['sd', 'hd'], default: 'sd' },
    },
    call_metadata: {
      callType: { type: String, enum: ['voice', 'video'] },
      duration: { type: Number },
      status: { type: String, enum: ['completed', 'missed', 'declined'] },
      hasMinutes: { type: Boolean },
      meetingId: { type: String },
    },

    // STT transcript for voice notes (populated asynchronously post-upload).
    transcript: { type: String },

    // Location
    location: {
      latitude: { type: Number },
      longitude: { type: Number },
      address: { type: String },
      name: { type: String },
    },

    // Privacy Logic
    isBurnAfterReading: {
      type: Boolean,
      default: false,
    },
    expiresAt: {
      type: Date,
      index: { expires: 0 },
    },

    // Soft-delete: users who chose "delete for me"
    deletedFor: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
  },

  {
    timestamps: true,
  }
);

// Idempotency: at most one message per (chat, sender, client_id). Partial index so
// only documents that actually carry a client_id are constrained — legacy/system
// messages without one are unaffected. Backs the de-dup guard in sendMessage and
// also stops two concurrent retries from both inserting.
MessageSchema.index(
  { chat: 1, sender: 1, client_id: 1 },
  { unique: true, partialFilterExpression: { client_id: { $type: 'string' } } }
);

// Message history pagination and delta-fetch after reconnect.
MessageSchema.index({ chat: 1, createdAt: -1 });

// Unread-count queries (readBy: { $ne: userId }) run on every send and mark-read.
MessageSchema.index({ chat: 1, readBy: 1 });

// Delivery catch-up queries (deliveredTo: { $ne: userId }) run on history fetch.
MessageSchema.index({ chat: 1, deliveredTo: 1 });

export const Message = mongoose.model<IMessage>('Message', MessageSchema);
