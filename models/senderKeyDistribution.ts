import mongoose, { Document, Schema } from 'mongoose';

/**
 * One sender-key distribution message for a group conversation.
 *
 * Group E2EE uses Signal "Sender Keys": each sender encrypts a group message ONCE
 * with its own sending chain, and distributes that chain's key to every other
 * member device via a pairwise (already-encrypted) session. This collection is
 * the mailbox for those distribution messages — the payload is an OPAQUE
 * ciphertext the server cannot read; it only routes it to the recipient device.
 *
 * `epoch` bumps whenever the group re-keys (a member is removed, or on periodic
 * rotation), so ex-members can't decrypt post-removal traffic. The Brain device
 * is a recipient here for org/group chats (and only those) — that is how Aida
 * gets group content while DMs, which never create sender keys, stay private.
 */
export interface ISenderKeyDistribution extends Document {
  conversationId: mongoose.Types.ObjectId;
  epoch: number;

  senderUserId: mongoose.Types.ObjectId;
  senderDeviceId: string;

  recipientUserId: mongoose.Types.ObjectId;
  recipientDeviceId: string;

  /** Opaque, pairwise-encrypted sender-key distribution message (base64). */
  ciphertext: string;

  createdAt: Date;
}

const SenderKeyDistributionSchema: Schema<ISenderKeyDistribution> = new Schema(
  {
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    epoch: { type: Number, required: true, default: 1 },

    senderUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    senderDeviceId: { type: String, required: true },

    recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    recipientDeviceId: { type: String, required: true },

    ciphertext: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Idempotent per (conversation, epoch, sender-device, recipient-device): a
// redistribute overwrites in place, and a recipient never sees a duplicate.
SenderKeyDistributionSchema.index(
  { conversationId: 1, epoch: 1, senderDeviceId: 1, recipientDeviceId: 1 },
  { unique: true }
);
// A recipient device pulls all distributions addressed to it.
SenderKeyDistributionSchema.index({ recipientUserId: 1, recipientDeviceId: 1, createdAt: 1 });

export const SenderKeyDistribution = mongoose.model<ISenderKeyDistribution>(
  'SenderKeyDistribution',
  SenderKeyDistributionSchema
);
