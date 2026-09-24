import mongoose, { Document, Schema } from 'mongoose';

export interface ISecurityCode extends Document {
  code: string;
  isCurrent: boolean;
  createdAt: Date;
  expiresAt: Date;
}

const SecurityCodeSchema: Schema<ISecurityCode> = new Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
    },
    isCurrent: {
      type: Boolean,
      default: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

export const SecurityCode = mongoose.model<ISecurityCode>('SecurityCode', SecurityCodeSchema);
