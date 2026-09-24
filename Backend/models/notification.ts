import mongoose, { Document, Schema } from 'mongoose';

export type NotificationType =
  | 'new_message'
  | 'new_group_message'
  | 'task_assigned'
  | 'task_due_soon'
  | 'meeting_started'
  | 'meeting_ended'
  | 'meeting_action_item'
  | 'task_followup'
  | 'meeting_invite'
  | 'payment_received'
  | 'payment_due'
  | 'invoice_sent'
  | 'file_shared'
  | 'community_post'
  | 'feed_mention'
  | 'feed_like'
  | 'feed_comment'
  | 'contact_added'
  | 'message_request'
  | 'system';

export interface INotification extends Document {
  recipient: mongoose.Types.ObjectId;
  sender?: mongoose.Types.ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  entityId?: string;    // ID of the related entity (message, task, meeting, post…)
  entityType?: string;  // The collection/module name
  data?: Record<string, any>; // Extra payload for deep-linking
  read: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sender: { type: Schema.Types.ObjectId, ref: 'User' },
    type: {
      type: String,
      enum: [
        'new_message', 'new_group_message', 'task_assigned', 'task_due_soon',
        'meeting_started', 'meeting_ended', 'meeting_action_item', 'task_followup', 'meeting_invite',
        'payment_received', 'payment_due', 'invoice_sent', 'file_shared',
        'community_post', 'feed_mention', 'feed_like', 'feed_comment',
        'contact_added', 'message_request', 'system',
      ],
      required: true,
    },
    title: { type: String, required: true },
    body: { type: String, required: true },
    entityId: { type: String },
    entityType: { type: String },
    data: { type: Schema.Types.Mixed },
    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

// Composite index for efficient per-user queries
NotificationSchema.index({ recipient: 1, createdAt: -1 });
NotificationSchema.index({ recipient: 1, read: 1 });

export const Notification = mongoose.model<INotification>('Notification', NotificationSchema);
