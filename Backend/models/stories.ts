import mongoose, { Document, Schema } from 'mongoose';

export interface IStory extends Document {
  author: mongoose.Types.ObjectId;
  mediaType: 'image' | 'video' | 'audio' | 'text';
  mediaUrl: string;
  textContent?: string;
  bg_gradient?: string;
  text_color?: string;
  font_size?: number;
  
  // Engagement
  views: mongoose.Types.ObjectId[];
  reactions: {
    user: mongoose.Types.ObjectId;
    emoji: string;
  }[];
  mentions: mongoose.Types.ObjectId[];
  
  // Settings
  is_close_friends_only: boolean;
  
  createdAt: Date;
  expiresAt: Date;
}

const StorySchema: Schema<IStory> = new Schema(
  {
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    mediaType: {
      type: String,
      enum: ['image', 'video', 'audio', 'text'],
      required: true,
    },
    mediaUrl: {
      type: String,
      default: '',
    },
    textContent: {
      type: String,
      default: '',
    },
    bg_gradient: {
      type: String,
    },
    text_color: {
      type: String,
    },
    font_size: {
      type: Number,
    },
    
    // Interactions
    views: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    reactions: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        emoji: { type: String },
      },
    ],
    mentions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    
    // Privacy settings
    is_close_friends_only: {
      type: Boolean,
      default: false,
    },

    createdAt: {
      type: Date,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      // Default to 24 hours from creation
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000), 
    },
  },
);

// TTL index to automatically delete expired stories from MongoDB
StorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Story = mongoose.model<IStory>('Story', StorySchema);
