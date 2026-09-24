import mongoose, { Document, Schema } from 'mongoose';

export type TaskType = 'event' | 'task' | 'synced' | 'meeting';
export type TaskStatus = 'todo' | 'in-progress' | 'done' | 'snoozed' | 'cancelled';
export type TaskSource = 'manual' | 'meeting' | 'aida' | 'calendar_import';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface ITask extends Document {
  user_id: mongoose.Types.ObjectId;       // owner / creator
  assignedTo?: mongoose.Types.ObjectId;   // who is responsible
  assignedToName?: string;
  recipients?: mongoose.Types.ObjectId[]; // people invited / notified
  externalEmails?: string[];              // non-org participants invited by email

  type: TaskType;
  meetingType?: 'voice' | 'video';
  title: string;
  description?: string;
  start_time: Date;
  end_time: Date;

  status: TaskStatus;
  priority: TaskPriority;
  color?: string;       // hex color for calendar display
  isUpdated?: boolean;  // whether it has been updated since creation

  // Provenance
  source: TaskSource;
  meetingRef?: mongoose.Types.ObjectId;  // Meeting._id if synced from transcript

  // Recurrence (simple)
  isRecurring?: boolean;
  recurrence?: 'daily' | 'weekly' | 'monthly';

  // Snooze
  snoozedUntil?: Date;
  reminderLevelsSent?: string[];

  // Action-item follow-up: set once a "still pending" nudge has been sent for a
  // meeting-sourced task, so the follow-up job never double-pings the assignee.
  followUpSentAt?: Date;

  // Set once we've rung attendees at this meeting's start time, so the
  // "meeting begins → ring everyone" scheduler never re-rings the same event.
  startRingSentAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const TaskSchema = new Schema<ITask>(
  {
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    assignedToName: { type: String },
    recipients: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    externalEmails: [{ type: String, trim: true, lowercase: true }],

    type: { type: String, enum: ['event', 'task', 'synced', 'meeting'], default: 'task' },
    meetingType: { type: String, enum: ['voice', 'video'] },
    title: { type: String, required: true },
    description: { type: String },
    start_time: { type: Date, required: true },
    end_time: { type: Date, required: true },

    status: { type: String, enum: ['todo', 'in-progress', 'done', 'snoozed', 'cancelled'], default: 'todo' },
    priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
    color: { type: String, default: '#6366f1' },
    isUpdated: { type: Boolean, default: false },

    source: { type: String, enum: ['manual', 'meeting', 'aida', 'calendar_import'], default: 'manual' },
    meetingRef: { type: Schema.Types.ObjectId, ref: 'Meeting' },

    isRecurring: { type: Boolean, default: false },
    recurrence: { type: String, enum: ['daily', 'weekly', 'monthly'] },
    snoozedUntil: { type: Date },
    reminderLevelsSent: { type: [String], default: [] },
    followUpSentAt: { type: Date },
    startRingSentAt: { type: Date },
  },
  { timestamps: true }
);

TaskSchema.index({ user_id: 1, start_time: 1 });
TaskSchema.index({ assignedTo: 1, status: 1 });

export const Task = mongoose.model<ITask>('Task', TaskSchema);


