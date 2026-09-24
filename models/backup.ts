import mongoose, { Document, Schema } from 'mongoose';

export interface IBackup extends Document {
  userId: mongoose.Types.ObjectId;
  backupData: string;
  createdAt: Date;
  updatedAt: Date;
}

const BackupSchema: Schema<IBackup> = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    backupData: { type: String, required: true },
  },
  { timestamps: true }
);

export const Backup = mongoose.model<IBackup>('Backup', BackupSchema);
