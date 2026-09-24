import mongoose, { Document, Schema } from 'mongoose';

export interface IWorkspaceFile extends Document {
  name: string;
  originalName?: string;
  fileUrl?: string;
  fileKey?: string;
  fileType: 'image' | 'video' | 'audio' | 'pdf' | 'doc' | 'spreadsheet' | 'other' | 'folder';
  mimeType?: string;
  fileSize?: number;
  isFolder: boolean;

  // Owner & Organisation
  uploadedBy: mongoose.Types.ObjectId;
  workspace: string; // workspace label/bucket name e.g. "Branding Core"

  // Source provenance
  source: 'meeting' | 'contact' | 'manual';
  sourceReference?: string; // e.g. chatId or meetingId

  // Access control
  sharedWith: mongoose.Types.ObjectId[];  // users who can view
  blockedUsers: mongoose.Types.ObjectId[]; // users who are explicitly denied
  isPublic: boolean; // anyone with a link can view if true

  // Metadata
  tags: string[];
  description?: string;

  createdAt: Date;
  updatedAt: Date;
}

const WorkspaceFileSchema: Schema<IWorkspaceFile> = new Schema(
  {
    name: { type: String, required: true, trim: true },
    originalName: { type: String },
    fileUrl: { type: String },
    fileKey: { type: String },
    isFolder: { type: Boolean, default: false },

    fileType: {
      type: String,
      enum: ['image', 'video', 'audio', 'pdf', 'doc', 'spreadsheet', 'other', 'folder'],
      default: 'other',
    },
    mimeType: { type: String },
    fileSize: { type: Number, default: 0 },

    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    workspace: {
      type: String,
      default: 'Default',
      trim: true,
    },

    source: {
      type: String,
      enum: ['meeting', 'contact', 'manual'],
      default: 'manual',
    },
    sourceReference: { type: String },

    sharedWith: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    isPublic: { type: Boolean, default: false },

    tags: [{ type: String }],
    description: { type: String },
  },
  { timestamps: true }
);

// Text search index on name / tags / description
WorkspaceFileSchema.index({ name: 'text', tags: 'text', description: 'text' });
// Fast per-user listing
WorkspaceFileSchema.index({ uploadedBy: 1, workspace: 1, createdAt: -1 });

export const WorkspaceFile = mongoose.model<IWorkspaceFile>('WorkspaceFile', WorkspaceFileSchema);
