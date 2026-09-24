import mongoose, { Document, Schema } from 'mongoose';

export interface IConversation extends Document {
  chatName: string;
  isGroupChat: boolean;
  users: mongoose.Types.ObjectId[];
  latestMessage?: mongoose.Types.ObjectId;
  groupAdmin?: mongoose.Types.ObjectId;
  
  // Group Metadata
  groupIcon?: string;
  groupDescription?: string;
  pinnedMessages: mongoose.Types.ObjectId[];
  
  // User-specific states
  mutedBy: mongoose.Types.ObjectId[];
  archivedBy: mongoose.Types.ObjectId[];
  deletedBy: mongoose.Types.ObjectId[]; // Users who deleted this chat locally
  pinnedBy: mongoose.Types.ObjectId[]; // Users who pinned this chat locally
  
  // Advanced Features
  ephemeralSettings: {
    isEnabled: boolean;
    duration: number; // in seconds
  };
  theme?: string;
  is_broadcast: boolean;
  organizationId?: mongoose.Types.ObjectId;
  isDefaultOrgChat?: boolean;
  inviteCode?: string;
  allowMembersToShareInvite?: boolean;

  // Admin-configurable group settings
  maxMembers?: number; // 0/undefined = unlimited
  transcriptPolicy?: 'email' | 'save' | 'off'; // how this group's meeting transcripts are handled
  resources?: { label: string; url?: string; type?: 'link' | 'file'; addedAt?: Date }[]; // group docs/links that feed the AI

  // E2EE sender-key generation. Bumps whenever the group re-keys (member removed
  // or periodic rotation) so ex-members can't read post-removal traffic. Messages
  // record the epoch that encrypted them; the Brain is a sender-key recipient for
  // org/group chats only (DMs never carry sender keys, so they stay private).
  keyEpoch?: number;

  createdAt: Date;
  updatedAt: Date;
}

const ConversationSchema: Schema<IConversation> = new Schema(
  {
    chatName: { type: String, trim: true, default: 'sender' },
    isGroupChat: { type: Boolean, default: false },
    users: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    latestMessage: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
    },
    groupAdmin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    
    // Group Metadata
    groupIcon: { type: String, default: '' },
    groupDescription: { type: String, default: '' },
    pinnedMessages: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Message',
      },
    ],
    
    // User Contexts
    mutedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    archivedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    deletedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    pinnedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    
    // Feature Sets
    ephemeralSettings: {
      isEnabled: { type: Boolean, default: false },
      duration: { type: Number, default: 0 }, // 0 means infinite until manually deleted
    },
    theme: { type: String, default: 'default' },
    is_broadcast: { type: Boolean, default: false },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      index: true,
    },
    isDefaultOrgChat: {
      type: Boolean,
      default: false,
    },
    inviteCode: {
      type: String,
      unique: true,
      sparse: true,
    },
    allowMembersToShareInvite: {
      type: Boolean,
      default: true,
    },

    // Admin-configurable group settings
    maxMembers: { type: Number, default: 0 }, // 0 = unlimited
    transcriptPolicy: {
      type: String,
      enum: ['email', 'save', 'off'],
      default: 'save',
    },
    resources: [
      {
        label: { type: String, required: true },
        url: { type: String },
        type: { type: String, enum: ['link', 'file'], default: 'link' },
        addedAt: { type: Date, default: Date.now },
      },
    ],

    // E2EE sender-key generation (see IConversation). Starts at 1 on first key.
    keyEpoch: { type: Number, default: 1 },
  },
  {
    timestamps: true,
  }
);

// A group chat MAY belong to an organization (a "subgroup"), in which case its
// messages feed the org's AI brain. It is not required: members without an org —
// and members who opt out of attaching a group to their org — can still create
// plain groups, and anyone can join one via its invite code. (Previously this was
// enforced as mandatory, which silently broke ALL group creation because the
// create path never set organizationId.)

// Chat-list fetches and membership checks filter by users on every request.
ConversationSchema.index({ users: 1 });

export const Conversation = mongoose.model<IConversation>('Conversation', ConversationSchema);
