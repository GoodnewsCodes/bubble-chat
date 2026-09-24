import mongoose, { Document, Schema } from 'mongoose';

export interface IOtp extends Document {
  userId: mongoose.Types.ObjectId;
  otp: string;
  type: 'verification' | 'reset';
  isUsed: boolean;
  expiresAt: Date;
  createdAt: Date;
}

const OtpSchema: Schema<IOtp> = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    otp: { type: String, required: true },
    type: { type: String, enum: ['verification', 'reset'], required: true, default: 'verification' },
    isUsed: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Indexes
OtpSchema.index({ userId: 1 });
OtpSchema.index({ otp: 1 });
OtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index to auto-delete expired documents

export const Otp = mongoose.models.Otp || mongoose.model<IOtp>('Otp', OtpSchema);
