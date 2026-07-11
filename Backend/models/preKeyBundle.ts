import mongoose, { Document, Schema } from 'mongoose';

/**
 * A single-use ("one-time") X25519 prekey for a device.
 *
 * X3DH consumes one of these per new session so that even the very first message
 * to an offline device has forward secrecy. The client uploads a pool of public
 * one-time prekeys at registration and replenishes it when the server pool runs
 * low; the server hands out exactly ONE per bundle fetch and deletes it
 * (consume-on-read) so no two sessions share a prekey.
 *
 * Only PUBLIC keys live here. When the pool for a device is empty the bundle
 * falls back to the device's signed prekey alone (still secure, just reuses the
 * signed prekey until the pool is topped up).
 */
export interface IOneTimePreKey extends Document {
  userId: mongoose.Types.ObjectId;
  deviceId: string;
  keyId: number;
  publicKey: string; // base64
  createdAt: Date;
}

const OneTimePreKeySchema: Schema<IOneTimePreKey> = new Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    deviceId: { type: String, required: true },
    keyId: { type: Number, required: true },
    publicKey: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// One row per (user, device, keyId); also the query key for consume + count.
OneTimePreKeySchema.index({ userId: 1, deviceId: 1, keyId: 1 }, { unique: true });
OneTimePreKeySchema.index({ userId: 1, deviceId: 1, createdAt: 1 });

export const OneTimePreKey = mongoose.model<IOneTimePreKey>('OneTimePreKey', OneTimePreKeySchema);
