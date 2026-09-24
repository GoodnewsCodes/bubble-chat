import mongoose, { Document, Schema } from 'mongoose';

export interface IMessageRequest extends Document {
    from: mongoose.Types.ObjectId;
    to: mongoose.Types.ObjectId;
    conversationId?: mongoose.Types.ObjectId;
    status: 'pending' | 'accepted' | 'declined';
    createdAt: Date;
    updatedAt: Date;
}

const MessageRequestSchema: Schema<IMessageRequest> = new Schema(
    {
        from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' },
        status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending' },
    },
    { timestamps: true }
);

// Unique constraint: one pending request between any two users
MessageRequestSchema.index({ from: 1, to: 1 }, { unique: true });

export const MessageRequest = mongoose.model<IMessageRequest>('MessageRequest', MessageRequestSchema);
