import mongoose, { Document, Schema } from 'mongoose';

export interface IGoal extends Document {
  user_id: mongoose.Types.ObjectId;
  title: string;
  targetAmount: number; // in cents
  currentAmount: number; // in cents
  currency: string;
  type: 'individual' | 'group';
  members: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const GoalSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    targetAmount: { type: Number, required: true },
    currentAmount: { type: Number, default: 0 },
    currency: { type: String, default: 'usd' },
    type: { type: String, enum: ['individual', 'group'], default: 'individual' },
    members: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

export const Goal = mongoose.model<IGoal>('Goal', GoalSchema);
