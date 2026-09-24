/**
 * end-stale-meetings.ts — flip abandoned "live" meetings to ended.
 *
 * Calls that ended without a clean end event (app killed, missed call_end) left
 * the Meeting stuck at status:'live' forever, so they kept showing in the "LIVE"
 * rooms list. This marks any meeting still 'live' past a cutoff as 'ended' (no AI
 * re-processing — these are stale, not freshly finished).
 *
 * Run:
 *   npm run end:stale                 (default: older than 2h)
 *   STALE_HOURS=1 npm run end:stale
 *   DRY_RUN=1 npm run end:stale
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

import { Meeting } from '../models/meeting';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/bubble';
const STALE_HOURS = parseFloat(process.env.STALE_HOURS || '2');
const DRY_RUN = process.env.DRY_RUN === '1';

async function run() {
  try {
    // console.log('🔌 Connecting to MongoDB…');
    await mongoose.connect(MONGODB_URI);
    // console.log(`✅ Connected.${DRY_RUN ? '  (DRY RUN)' : ''}\n`);

    const cutoff = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000);
    const stale = await Meeting.find({ status: 'live', startedAt: { $lt: cutoff } }).select('_id roomId startedAt').lean();
    // console.log(`🔎 ${stale.length} meeting(s) still 'live' but started before ${cutoff.toISOString()}.`);

    if (stale.length && !DRY_RUN) {
      const ids = stale.map((m: any) => m._id);
      const res = await Meeting.updateMany(
        { _id: { $in: ids } },
        { $set: { status: 'ended', endedAt: new Date() } }
      );
      // console.log(`🧹 Marked ${res.modifiedCount} meeting(s) as ended.`);
    } else if (DRY_RUN) {
      // console.log('   (DRY RUN — nothing changed.)');
    }

    await mongoose.disconnect();
    // console.log('🔌 Disconnected.');
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

run();
