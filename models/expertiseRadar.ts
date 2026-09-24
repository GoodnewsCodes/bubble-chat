import mongoose, { Document, Schema } from 'mongoose';

export interface IExpertiseRadar extends Document {
  userId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  topic: string;
  score: number;
  activityCount: number;
  updatedAt: Date;
}

const ExpertiseRadarSchema: Schema<IExpertiseRadar> = new Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    topic: { type: String, required: true, trim: true, lowercase: true },
    score: { type: Number, default: 0 },
    activityCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Unique compound index so there is at most one entry per user-topic combination
ExpertiseRadarSchema.index({ userId: 1, topic: 1 }, { unique: true });
ExpertiseRadarSchema.index({ organizationId: 1, topic: 1, score: -1 });

export const ExpertiseRadar = mongoose.model<IExpertiseRadar>('ExpertiseRadar', ExpertiseRadarSchema);
