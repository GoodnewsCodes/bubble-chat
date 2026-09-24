import mongoose, { Schema, Document } from 'mongoose';

export interface INetworkPost extends Document {
  network: mongoose.Types.ObjectId;
  author: mongoose.Types.ObjectId;
  content: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'link' | 'file';
  linkUrl?: string;
  reactions: { user: mongoose.Types.ObjectId; emoji: string }[];
  forwardedFrom?: mongoose.Types.ObjectId;
  createdAt: Date;
}

const NetworkPostSchema = new Schema<INetworkPost>(
  {
    network: { type: Schema.Types.ObjectId, ref: 'Network', required: true, index: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, default: '' },
    mediaUrl: { type: String },
    mediaType: { type: String, enum: ['image', 'video', 'link', 'file'] },
    linkUrl: { type: String },
    reactions: [
      {
        user: { type: Schema.Types.ObjectId, ref: 'User' },
        emoji: { type: String },
      },
    ],
    forwardedFrom: { type: Schema.Types.ObjectId, ref: 'NetworkPost' },
  },
  { timestamps: true }
);

export interface INetwork extends Document {
  title: string;
  description: string;
  image: string;
  creator: mongoose.Types.ObjectId;
  members: mongoose.Types.ObjectId[];
  categories: string[];
  onlyCreatorCanPost: boolean;
  isPrivate: boolean;
  memberCount: number;
  activityScore: number; // for trending algorithm
  badge?: string; // e.g. "Hot", "New"
  createdAt: Date;
  updatedAt: Date;
}

const NetworkSchema = new Schema<INetwork>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    image: { type: String, default: '' },
    creator: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    members: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    categories: [{ type: String }],
    onlyCreatorCanPost: { type: Boolean, default: true },
    isPrivate: { type: Boolean, default: false },
    memberCount: { type: Number, default: 1 },
    activityScore: { type: Number, default: 0 }, // incremented on posts/reactions
    badge: { type: String }, // "Hot", "New", "Rising"
  },
  { timestamps: true }
);

// Text index for search
NetworkSchema.index({ title: 'text', description: 'text', categories: 'text' });

export const NetworkPost = mongoose.model<INetworkPost>('NetworkPost', NetworkPostSchema);
export default mongoose.model<INetwork>('Network', NetworkSchema);
