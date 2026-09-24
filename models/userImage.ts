import mongoose, { Document, Schema } from 'mongoose';

export interface IUserImage extends Document {
    userId: mongoose.Types.ObjectId;
    imageUrl: string;
    base64Data?: string;
    mimetype?: string;
    createdAt: Date;
}

const UserImageSchema: Schema<IUserImage> = new Schema(
    {
        userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        imageUrl: { type: String, required: true },
        base64Data: { type: String }, // Store small images/thumbnails directly
        mimetype: { type: String },
    },
    { timestamps: true }
);

export const UserImage = mongoose.model<IUserImage>('UserImage', UserImageSchema);
