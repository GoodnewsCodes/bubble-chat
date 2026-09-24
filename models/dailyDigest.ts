import mongoose, { Document, Schema } from 'mongoose';

export interface IDigestItem {
  type: 'event' | 'action_item' | 'decision' | 'heads_up';
  content: string;
  sourceTitle?: string;
  sourceId?: string;
  confidence?: number;   // 0-1, items below 0.70 go into headsUp bucket
}

export interface IYesterdayRecap {
  meetings: { title: string; summary?: string; decisions?: string[]; actionItems?: string[] }[];
  messageHighlights: { title: string; snippet: string }[];
  decisions: { title: string; snippet: string }[];
}

export interface IDailyDigest extends Document {
  userId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  date: Date;                        // The calendar date this digest covers (midnight UTC)
  events: mongoose.Types.ObjectId[]; // CalendarEvent IDs for the day
  items: IDigestItem[];
  morningBrief: string;              // AI-synthesized 5-bullet plain-text summary
  highConfidenceItems: IDigestItem[];
  headsUpItems: IDigestItem[];       // items with score < 0.70, shown collapsed
  yesterdayRecap?: IYesterdayRecap;  // explicit reflection of the prior day
  generatedAt: Date;
  pushSent: boolean;                 // true once push notification delivered
}

const DigestItemSchema = new Schema<IDigestItem>(
  {
    type: { type: String, enum: ['event', 'action_item', 'decision', 'heads_up'], required: true },
    content: { type: String, required: true },
    sourceTitle: { type: String },
    sourceId: { type: String },
    confidence: { type: Number, min: 0, max: 1 },
  },
  { _id: false }
);

const DailyDigestSchema = new Schema<IDailyDigest>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    date: { type: Date, required: true },
    events: [{ type: Schema.Types.ObjectId, ref: 'CalendarEvent' }],
    items: [DigestItemSchema],
    morningBrief: { type: String, default: '' },
    highConfidenceItems: [DigestItemSchema],
    headsUpItems: [DigestItemSchema],
    yesterdayRecap: {
      meetings: [{
        _id: false,
        title: { type: String },
        summary: { type: String },
        decisions: [{ type: String }],
        actionItems: [{ type: String }],
      }],
      messageHighlights: [{
        _id: false,
        title: { type: String },
        snippet: { type: String },
      }],
      decisions: [{
        _id: false,
        title: { type: String },
        snippet: { type: String },
      }],
    },
    generatedAt: { type: Date, default: Date.now },
    pushSent: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// One digest per user per day
DailyDigestSchema.index({ userId: 1, date: 1 }, { unique: true });
DailyDigestSchema.index({ organizationId: 1, date: 1 });
DailyDigestSchema.index({ pushSent: 1, date: 1 }); // for the push-delivery background job

export const DailyDigest = mongoose.model<IDailyDigest>('DailyDigest', DailyDigestSchema);
