import mongoose, { Document, Schema } from 'mongoose';

export interface ITransaction extends Document {
  user_id: mongoose.Types.ObjectId;
  type: 'deposit' | 'withdrawal' | 'expense' | 'income';
  amount: number; // in cents
  currency: string;
  status: 'pending' | 'completed' | 'failed';
  source?: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

const TransactionSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['deposit', 'withdrawal', 'expense', 'income'], required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'usd' },
    status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
    source: { type: String },
    description: { type: String },
  },
  { timestamps: true }
);

export const Transaction = mongoose.model<ITransaction>('Transaction', TransactionSchema);
