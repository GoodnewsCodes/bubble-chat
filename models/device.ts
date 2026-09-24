import mongoose, { Document, Schema } from 'mongoose';

/**
 * One end-to-end-encryption device (a client install) belonging to a user.
 *
 * Signal-protocol identity lives HERE, not on the User: a single account can
 * have several devices (mobile, web, and the org Brain is modeled as its own
 * device too), and each is an independent crypto recipient. The server only ever
 * stores PUBLIC material — the private identity/prekeys never leave the device.
 *
 * `signedPreKey` / `kyberPreKey` are the long-lived (rotated ~weekly) keys served
 * in a prekey bundle for X3DH/PQXDH session setup; single-use `OneTimePreKey`
 * rows (see ./preKeyBundle) are consumed one-per-session on bundle fetch.
 */
export interface IDevice extends Document {
  userId: mongoose.Types.ObjectId;
  /** Stable client-generated device id (also the libsignal address device id). */
  deviceId: string;
  /** libsignal registration id (uint14). */
  registrationId: number;
  /** Base64 Ed25519/X25519 public identity key (the safety-number anchor). */
  identityKey: string;

  // Current signed prekey (X3DH). Rotated on a schedule; the client keeps the
  // matching private key (plus the previous one, for a grace window) on-device.
  signedPreKey: {
    keyId: number;
    publicKey: string; // base64
    signature: string; // base64, signed by identityKey
    createdAt: Date;
  };

  // Optional post-quantum (Kyber) prekey for PQXDH-hardened session setup.
  kyberPreKey?: {
    keyId: number;
    publicKey: string; // base64
    signature: string; // base64
    createdAt: Date;
  };

  name?: string; // human label ("iPhone 15", "Chrome · Mac")
  platform?: 'ios' | 'android' | 'web' | 'brain';
  /** True for the org Brain's device — used to enforce the DM privacy boundary. */
  isBrain: boolean;

  lastSeenAt: Date;
  /** Set when a device is remotely revoked; revoked devices get no new sessions. */
  revokedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const DeviceSchema: Schema<IDevice> = new Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    deviceId: { type: String, required: true },
    registrationId: { type: Number, required: true },
    identityKey: { type: String, required: true },

    signedPreKey: {
      keyId: { type: Number, required: true },
      publicKey: { type: String, required: true },
      signature: { type: String, required: true },
      createdAt: { type: Date, default: Date.now },
    },
    kyberPreKey: {
      keyId: { type: Number },
      publicKey: { type: String },
      signature: { type: String },
      createdAt: { type: Date },
    },

    name: { type: String, default: '' },
    platform: { type: String, enum: ['ios', 'android', 'web', 'brain'] },
    isBrain: { type: Boolean, default: false },

    lastSeenAt: { type: Date, default: Date.now },
    revokedAt: { type: Date },
  },
  { timestamps: true }
);

// One row per (user, device). Register/re-register upserts on this key.
DeviceSchema.index({ userId: 1, deviceId: 1 }, { unique: true });

export const Device = mongoose.model<IDevice>('Device', DeviceSchema);
