import mongoose, { Document, Schema } from 'mongoose';

/**
 * One wrapped copy of a conversation's symmetric group key.
 *
 * Group E2EE model: a per-conversation secretbox key is generated client-side
 * and distributed by encrypting ("wrapping") it with nacl.box to each member's
 * public key — and to the org Brain's public key (recipientId: 'brain') so the
 * Brain can still process group content. 1:1 DMs never get a 'brain' row: they
 * use direct nacl.box between the two participants and stay private.
 *
 * `encryptedKey` is an opaque client-produced envelope
 * (JSON: { nonce, box, from } — all base64). The server never sees the raw key.
 * `epoch` increments on re-key (member removal); messages record the epoch that
 * encrypted them so history stays decryptable after rotation.
 */
export interface IConversationKey extends Document {
  conversationId: mongoose.Types.ObjectId;
  /** User _id as string, or the literal 'brain' for the org Brain recipient. */
  recipientId: string;
  encryptedKey: string;
  epoch: number;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ConversationKeySchema: Schema<IConversationKey> = new Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
    },
    recipientId: { type: String, required: true },
    encryptedKey: { type: String, required: true },
    epoch: { type: Number, required: true, default: 1 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// One wrapped key per (conversation, recipient, epoch).
ConversationKeySchema.index(
  { conversationId: 1, recipientId: 1, epoch: 1 },
  { unique: true }
);
ConversationKeySchema.index({ conversationId: 1, epoch: -1 });

export const ConversationKey = mongoose.model<IConversationKey>(
  'ConversationKey',
  ConversationKeySchema
);
