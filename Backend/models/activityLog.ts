import mongoose, { Document, Schema } from 'mongoose';

export type ActivityAction =
  // Files
  | 'file_uploaded'
  | 'file_deleted'
  | 'file_shared'
  | 'file_downloaded'
  | 'folder_created'
  // Tasks & Calendar
  | 'task_created'
  | 'task_updated'
  | 'task_completed'
  | 'task_deleted'
  | 'task_assigned'
  // Meetings
  | 'meeting_started'
  | 'meeting_ended'
  | 'meeting_joined'
  | 'meeting_left'
  | 'transcript_saved'
  // Calls
  | 'call_initiated'
  | 'call_invited'
  | 'call_accepted'
  | 'call_rejected'
  | 'call_busy'
  | 'call_missed'
  | 'call_ended'
  | 'room_knock'
  | 'room_knock_accepted'
  | 'room_knock_denied'
  // Messaging
  | 'message_sent'
  // Brain / Knowledge
  | 'document_ingested'
  // Payments
  | 'payment_made'
  | 'invoice_created'
  | 'invoice_sent'
  | 'goal_created'
  // Auth & Account
  | 'login'
  | 'logout'
  | 'password_changed'
  | 'profile_updated'
  // Social
  | 'post_created'
  | 'contact_added'
  | 'community_joined';

export interface IActivityLog extends Document {
  actor: mongoose.Types.ObjectId;
  action: ActivityAction;
  entityId?: string;
  entityType?: string;
  entityLabel?: string;    // Human-readable name of the entity
  metadata?: Record<string, any>;
  ip?: string;
  userAgent?: string;
  createdAt: Date;
}

const ActivityLogSchema = new Schema<IActivityLog>(
  {
    actor:       { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    action:      { type: String, required: true },
    entityId:    { type: String },
    entityType:  { type: String },
    entityLabel: { type: String },
    metadata:    { type: Schema.Types.Mixed },
    ip:          { type: String },
    userAgent:   { type: String },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

ActivityLogSchema.index({ actor: 1, createdAt: -1 });
ActivityLogSchema.index({ createdAt: -1 }); // For admin-level queries

export const ActivityLog = mongoose.model<IActivityLog>('ActivityLog', ActivityLogSchema);
