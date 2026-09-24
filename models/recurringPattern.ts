import mongoose, { Document, Schema } from 'mongoose';

/**
 * Tracks a detected behavioural pattern (a title+eventType combo that appears
 * ≥3 times within a rolling 90-day window for a given user in an org).
 *
 * Lifecycle:
 *   detected  → system detected ≥3 occurrences, notification sent
 *   confirmed → user said "yes, make this recurring" via push/email CTA
 *   dismissed → user said "no thanks"
 */
export interface IRecurringPattern extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;          // who the pattern belongs to
  normalisedTitle: string;                  // lowercase, stripped title used as key
  exampleTitle: string;                     // original title of the first matched event
  eventType: string;
  occurrences: number;                      // how many times seen when detected
  status: 'detected' | 'confirmed' | 'dismissed';
  notifiedAt?: Date;
  confirmedAt?: Date;
  // Once confirmed, we stamp the recurrenceRule so the front-end can use it
  recurrenceRule?: string;
  createdAt: Date;
  updatedAt: Date;
}

const RecurringPatternSchema = new Schema<IRecurringPattern>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    userId:         { type: Schema.Types.ObjectId, ref: 'User',         required: true, index: true },
    normalisedTitle:{ type: String, required: true },
    exampleTitle:   { type: String, required: true },
    eventType:      { type: String, default: 'meeting_video' },
    occurrences:    { type: Number, default: 3 },
    status: {
      type: String,
      enum: ['detected', 'confirmed', 'dismissed'],
      default: 'detected',
      index: true,
    },
    notifiedAt:     { type: Date },
    confirmedAt:    { type: Date },
    recurrenceRule: { type: String },
  },
  { timestamps: true }
);

// Compound unique: one pattern record per user+title combination
RecurringPatternSchema.index({ userId: 1, normalisedTitle: 1 }, { unique: true });

export const RecurringPattern = mongoose.model<IRecurringPattern>('RecurringPattern', RecurringPatternSchema);
