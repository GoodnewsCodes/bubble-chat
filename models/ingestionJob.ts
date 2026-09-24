import mongoose, { Document, Schema } from 'mongoose';

export interface IIngestionJob extends Document {
  userId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  sourceType: 'file' | 'url' | 'chat' | 'text' | 'recording' | 'youtube' | 'slack_export' | 'ai_conversation' | 'holiday';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;
  resultDocumentId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const IngestionJobSchema: Schema<IIngestionJob> = new Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    sourceType: {
      type: String,
      enum: ['file', 'url', 'chat', 'text', 'recording', 'youtube', 'slack_export', 'ai_conversation', 'holiday'],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
    },
    error: { type: String },
    resultDocumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrgDocument' },
  },
  { timestamps: true }
);

IngestionJobSchema.index({ organizationId: 1, status: 1 });

export const IngestionJob = mongoose.model<IIngestionJob>('IngestionJob', IngestionJobSchema);
