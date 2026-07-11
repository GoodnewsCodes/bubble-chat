/**
 * dedup-live-meetings.ts — collapse duplicate LIVE meetings per room.
 *
 * A create-race (caller + callee both creating the Meeting for the same call)
 * spawned multiple live records per roomId — showing as duplicate "Voice Call"
 * rows, doubled "minutes ready" messages, and doubled calendar dots. This keeps
 * the EARLIEST live meeting per roomId (it holds the real transcript/attendees)
 * and marks the rest 'ended'. Then it builds the partial-unique index so the
 * race can never recur.
 *
 * Run:
 *   npm run dedup:meetings
 *   DRY_RUN=1 npm run dedup:meetings
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

import { Meeting } from '../models/meeting';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/bubble';
const DRY_RUN = process.env.DRY_RUN === '1';

async function run() {
  try {
    console.log('🔌 Connecting to MongoDB…');
    await mongoose.connect(MONGODB_URI);
    console.log(`✅ Connected.${DRY_RUN ? '  (DRY RUN)' : ''}\n`);

    const live = await Meeting.find({ status: 'live' }).select('_id roomId startedAt').sort({ startedAt: 1 }).lean();
    const byRoom = new Map<string, any[]>();
    for (const m of live) {
      const key = String(m.roomId);
      if (!byRoom.has(key)) byRoom.set(key, []);
      byRoom.get(key)!.push(m);
    }

    const losers: any[] = [];
    for (const [, group] of byRoom) {
      if (group.length > 1) {
        // group is sorted by startedAt asc → keep [0], end the rest.
        losers.push(...group.slice(1).map((m) => m._id));
      }
    }

    console.log(`🔎 ${byRoom.size} distinct live room(s); ${losers.length} duplicate live record(s) to collapse.`);
    if (losers.length && !DRY_RUN) {
      const res = await Meeting.updateMany(
        { _id: { $in: losers } },
        { $set: { status: 'ended', endedAt: new Date() } }
      );
      console.log(`🧹 Collapsed ${res.modifiedCount} duplicate meeting(s).`);
    }

    // Build the partial-unique index now that duplicates are gone (safe to re-run).
    if (!DRY_RUN) {
      try {
        await Meeting.collection.createIndex(
          { roomId: 1 },
          { unique: true, partialFilterExpression: { status: 'live' }, name: 'roomId_live_unique' }
        );
        console.log('🔐 Ensured partial-unique index on roomId (status: live).');
      } catch (idxErr: any) {
        console.error('⚠️  Could not build unique index (resolve remaining dups first):', idxErr?.message || idxErr);
      }
    }

    await mongoose.disconnect();
    console.log('🔌 Disconnected.');
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

run();
