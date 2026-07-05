import mongoose, { Document, Schema } from 'mongoose';

export interface IActionItem {
  _id?: mongoose.Types.ObjectId;
  text: string;
  assignedTo?: mongoose.Types.ObjectId;
  assignedToName?: string;
  deadline?: Date;
  status: 'pending' | 'done';
  taskRef?: mongoose.Types.ObjectId;
}

// ── Rich file-share record (replaces plain string IDs) ───────────────────────
export interface ISharedFile {
  _id?: mongoose.Types.ObjectId;
  fileId?: string;              // workspace file _id (if uploaded via workspace)
  name: string;
  fileType: string;             // e.g. 'image', 'pdf', 'video', 'file', 'link'
  fileSize?: number;            // bytes
  fileUrl?: string;             // direct URL (for workspace-proxied files)
  linkUrl?: string;             // for tab/link shares
  uploadedBy: mongoose.Types.ObjectId;
  uploadedByName?: string;
  sharedAt: Date;
  source: 'file_upload' | 'tab_share' | 'screen_share';
}

// ── Screen / tab share session record ────────────────────────────────────────
export interface IScreenShare {
  _id?: mongoose.Types.ObjectId;
  sharedBy: mongoose.Types.ObjectId;
  sharedByName?: string;
  shareType: 'screen' | 'window' | 'tab';
  label?: string;               // window/tab title captured from client
  startedAt: Date;
  endedAt?: Date;
  duration?: number;            // seconds
}

export interface IMeeting extends Document {
  roomId: string;
  title: string;
  host: mongoose.Types.ObjectId;
  attendees: mongoose.Types.ObjectId[];
  attendeeNames?: string[];

  // Conversation that triggered this meeting (1:1 call, group call from a chat,
  // or scheduled meeting tied to an event chat). When set, post-meeting minutes
  // are dropped into this chat as a system message with a transcript download.
  chatId?: mongoose.Types.ObjectId;

  type: 'video' | 'voice' | 'group';

  // Pre-set agenda (from the scheduling flow or creator) — surfaced in meeting
  // detail and included in invite emails alongside carried-over action items.
  agenda?: string;

  startedAt: Date;
  endedAt?: Date;
  duration?: number;

  // Transcript & Intelligence
  transcriptRaw?: string;
  transcriptChunks?: { speaker?: string; speakerId?: string; text: string; timestamp?: number }[];
  summary?: string;
  actionItems: IActionItem[];

  // LiveKit Egress recording (audio composite written to Filebase/S3). Populated
  // only when LIVEKIT_EGRESS_ENABLED is on; used as the Whisper source when the
  // live speech-recognition transcript is empty/thin.
  recordingKey?: string;
  egressId?: string; // running egress id — used to stop the recording on meeting end

  // ── NEW: rich shared-file records ─────────────────────────────────────────
  filesShared: ISharedFile[];

  // ── NEW: screen / tab share sessions ──────────────────────────────────────
  screenShares: IScreenShare[];

  status: 'scheduled' | 'live' | 'ended' | 'cancelled';

  createdAt: Date;
  updatedAt: Date;
}

// ─── Sub-schemas ─────────────────────────────────────────────────────────────

const ActionItemSchema = new Schema<IActionItem>(
  {
    text: { type: String, required: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    assignedToName: { type: String },
    deadline: { type: Date },
    status: { type: String, enum: ['pending', 'done'], default: 'pending' },
    taskRef: { type: Schema.Types.ObjectId, ref: 'Task' },
  },
  { _id: true }
);

const SharedFileSchema = new Schema<ISharedFile>(
  {
    fileId: { type: String },
    name: { type: String, required: true },
    fileType: { type: String, default: 'file' },
    fileSize: { type: Number },
    fileUrl: { type: String },
    linkUrl: { type: String },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    uploadedByName: { type: String },
    sharedAt: { type: Date, default: Date.now },
    source: {
      type: String,
      enum: ['file_upload', 'tab_share', 'screen_share'],
      default: 'file_upload',
    },
  },
  { _id: true }
);

const ScreenShareSchema = new Schema<IScreenShare>(
  {
    sharedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sharedByName: { type: String },
    shareType: { type: String, enum: ['screen', 'window', 'tab'], default: 'screen' },
    label: { type: String },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
    duration: { type: Number },
  },
  { _id: true }
);

// ─── Main schema ─────────────────────────────────────────────────────────────

const MeetingSchema = new Schema<IMeeting>(
  {
    roomId: { type: String, required: true, index: true },
    title: { type: String, default: 'Untitled Meeting' },
    host: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    attendees: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    attendeeNames: [{ type: String }],
    chatId: { type: Schema.Types.ObjectId, ref: 'Conversation', index: true },

    type: { type: String, enum: ['video', 'voice', 'group'], default: 'video' },
    agenda: { type: String, default: '' },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
    duration: { type: Number },

    transcriptRaw: { type: String },
    transcriptChunks: [
      {
        speaker: { type: String },
        speakerId: { type: String },
        text: { type: String },
        timestamp: { type: Number },
      },
    ],
    summary: { type: String },
    recordingKey: { type: String },
    egressId: { type: String },
    actionItems: [ActionItemSchema],

    filesShared: [SharedFileSchema],
    screenShares: [ScreenShareSchema],

    status: {
      type: String,
      enum: ['scheduled', 'live', 'ended', 'cancelled'],
      default: 'live',
    },
  },
  { timestamps: true }
);

MeetingSchema.index({ host: 1, createdAt: -1 });
MeetingSchema.index({ attendees: 1, createdAt: -1 });

export const Meeting = mongoose.model<IMeeting>('Meeting', MeetingSchema);