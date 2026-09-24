import mongoose, { Document, Schema } from 'mongoose';

export interface IPushToken extends Document {
  userId: mongoose.Types.ObjectId;
  /** Expo push token string, OR a JSON-serialised Web Push subscription object. */
  token: string;
  deviceType: string;
  /** 'ios' | 'android' | 'web' | 'unknown' — used to pick the right delivery channel. */
  platform: string;
  createdAt: Date;
  updatedAt: Date;
}

const PushTokenSchema: Schema<IPushToken> = new Schema(
  {
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    token:      { type: String, required: true, unique: true },
    deviceType: { type: String, default: 'unknown' },
    platform:   { type: String, enum: ['ios', 'android', 'web', 'unknown'], default: 'unknown' },
  },
  { timestamps: true }
);

export const PushToken = mongoose.model<IPushToken>('PushToken', PushTokenSchema);

