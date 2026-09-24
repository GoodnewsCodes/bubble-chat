import mongoose, { Document, Schema } from 'mongoose';

export type TemplateType = 'meeting' | 'document' | 'task';

export interface ITemplate extends Document {
  user_id: mongoose.Types.ObjectId;
  type: TemplateType;
  title: string;
  description?: string;
  content: Record<string, any>; // flexible JSON — agenda items, doc sections, task fields
  isDefault: boolean;  // platform-provided default template
  tags?: string[];
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const TemplateSchema = new Schema<ITemplate>(
  {
    user_id:    { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type:       { type: String, enum: ['meeting', 'document', 'task'], required: true },
    title:      { type: String, required: true, trim: true },
    description:{ type: String, default: '' },
    content:    { type: Schema.Types.Mixed, default: {} },
    isDefault:  { type: Boolean, default: false },
    tags:       [{ type: String }],
    usageCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

TemplateSchema.index({ user_id: 1, type: 1 });

export const Template = mongoose.model<ITemplate>('Template', TemplateSchema);
