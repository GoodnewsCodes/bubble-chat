import mongoose, { Document, Schema } from 'mongoose';

export interface ICalendarActionItem {
  _id?: mongoose.Types.ObjectId;
  text: string;
  assignedTo?: mongoose.Types.ObjectId;
  assignedToName?: string;
  deadline?: Date;
  status: 'pending' | 'done';
}

export interface ICalendarEvent extends Document {
  organizationId: mongoose.Types.ObjectId;
  title: string;
  eventType: 'company' | 'holiday' | 'meeting_video' | 'meeting_audio' | 'all_day';
  description?: string;
  startTime: Date;
  endTime: Date;
  isAllDay: boolean;

  // People
  createdBy: mongoose.Types.ObjectId;
  attendees: mongoose.Types.ObjectId[];
  attendeeNames?: string[];

  // Agenda & templates
  agenda?: string;
  templateId?: mongoose.Types.ObjectId;

  // LiveKit integration
  liveKitRoomId?: string;

  // Brain-enriched content (filled after meeting ends)
  transcriptRaw?: string;
  transcriptChunks?: { speaker?: string; text: string; timestamp?: number }[];
  summary?: string;
  decisions: string[];
  actionItems: ICalendarActionItem[];

  // Brain links
  relatedDocIds: mongoose.Types.ObjectId[];  // linked OrgDocument IDs
  pineconeIds: string[];
  tags: string[];
  topicTags: string[];

  // Recurrence
  isRecurring: boolean;
  recurrenceRule?: string;     // iCal RRULE string, e.g. "FREQ=WEEKLY;BYDAY=MO"
  parentEventId?: mongoose.Types.ObjectId;   // for recurring instances

  status: 'scheduled' | 'live' | 'ended' | 'cancelled';
  brainEnriched: boolean;      // true once DeepSeek enrichment pass done

  createdAt: Date;
  updatedAt: Date;
}

// ─── Sub-schemas ─────────────────────────────────────────────────────────────

const CalendarActionItemSchema = new Schema<ICalendarActionItem>(
  {
    text: { type: String, required: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    assignedToName: { type: String },
    deadline: { type: Date },
    status: { type: String, enum: ['pending', 'done'], default: 'pending' },
  },
  { _id: true }
);

// ─── Main schema ─────────────────────────────────────────────────────────────

const CalendarEventSchema = new Schema<ICalendarEvent>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    title: { type: String, required: true, trim: true },
    eventType: {
      type: String,
      enum: ['company', 'holiday', 'meeting_video', 'meeting_audio', 'all_day'],
      default: 'meeting_video',
    },
    description: { type: String, default: '' },
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    isAllDay: { type: Boolean, default: false },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    attendees: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    attendeeNames: [{ type: String }],

    agenda: { type: String, default: '' },
    templateId: { type: Schema.Types.ObjectId, ref: 'Template' },

    liveKitRoomId: { type: String },

    // Brain-enriched post-meeting content
    transcriptRaw: { type: String },
    transcriptChunks: [
      {
        speaker: { type: String },
        text: { type: String },
        timestamp: { type: Number },
      },
    ],
    summary: { type: String },
    decisions: [{ type: String }],
    actionItems: [CalendarActionItemSchema],

    relatedDocIds: [{ type: Schema.Types.ObjectId, ref: 'OrgDocument' }],
    pineconeIds: [{ type: String }],
    tags: [{ type: String }],
    topicTags: [{ type: String }],

    isRecurring: { type: Boolean, default: false },
    recurrenceRule: { type: String },
    parentEventId: { type: Schema.Types.ObjectId, ref: 'CalendarEvent' },

    status: {
      type: String,
      enum: ['scheduled', 'live', 'ended', 'cancelled'],
      default: 'scheduled',
    },
    brainEnriched: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// Fast lookup by org + date range (calendar views)
CalendarEventSchema.index({ organizationId: 1, startTime: 1, endTime: 1 });
// Attendee-based lookup (my events)
CalendarEventSchema.index({ attendees: 1, startTime: 1 });
// Status-based (find live meetings)
CalendarEventSchema.index({ organizationId: 1, status: 1 });
// Unenriched meetings queue
CalendarEventSchema.index({ status: 1, brainEnriched: 1 });

export const CalendarEvent = mongoose.model<ICalendarEvent>('CalendarEvent', CalendarEventSchema);
