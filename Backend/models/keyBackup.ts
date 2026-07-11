import mongoose, { Document, Schema } from 'mongoose';

/**
 * A user's encrypted full-account backup (Signal SVR-style).
 *
 * The client serializes its ENTIRE local store — message history, chats/contacts,
 * identity + prekey material, drafts, settings — and encrypts it with a key
 * derived (Argon2id) from the user's recovery passphrase/PIN. Only the resulting
 * opaque ciphertext lands here; the server never sees the plaintext or the PIN.
 *
 * On re-login on a fresh/reinstalled device the client fetches this blob, the
 * user enters their PIN, and everything is rehydrated locally in one flow.
 *
 * Large blobs live in object storage (`blobUrl`); `kdfParams` lets the client
 * re-derive the key, and `svrVerifier` + the attempt counters enforce
 * rate-limited PIN tries so the backup can't be brute-forced (a wrong PIN never
 * reveals anything, and too many attempts lock the blob).
 */
export interface IKeyBackup extends Document {
  userId: mongoose.Types.ObjectId;

  /** Pointer to the ciphertext in object storage (preferred for big backups). */
  blobUrl?: string;
  /** Inline ciphertext for small backups (base64). Use blobUrl above ~1MB. */
  blob?: string;
  /** Monotonic version so an older device never clobbers a newer snapshot. */
  version: number;
  /** Bytes of the plaintext-before-encryption, for the client's restore UI. */
  sizeBytes?: number;

  // Argon2id parameters the client used to derive the backup key from the PIN.
  kdfParams: {
    algorithm: string; // 'argon2id'
    salt: string;      // base64
    memoryKiB: number;
    iterations: number;
    parallelism: number;
  };

  /** Verifier used to check a PIN attempt WITHOUT decrypting (rate-limit gate). */
  svrVerifier: string;

  // Brute-force protection.
  attemptCount: number;
  lockedUntil?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const KeyBackupSchema: Schema<IKeyBackup> = new Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

    blobUrl: { type: String },
    blob: { type: String, select: false }, // never returned unless explicitly asked
    version: { type: Number, default: 1 },
    sizeBytes: { type: Number },

    kdfParams: {
      algorithm: { type: String, default: 'argon2id' },
      salt: { type: String, required: true },
      memoryKiB: { type: Number, default: 65536 },
      iterations: { type: Number, default: 3 },
      parallelism: { type: Number, default: 1 },
    },

    svrVerifier: { type: String, required: true },

    attemptCount: { type: Number, default: 0 },
    lockedUntil: { type: Date },
  },
  { timestamps: true }
);

export const KeyBackup = mongoose.model<IKeyBackup>('KeyBackup', KeyBackupSchema);
