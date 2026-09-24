/**
 * inspect-transcripts.ts  (READ-ONLY)
 *
 * Audits existing meeting/calendar transcript data to verify the speaker-attribution
 * fix is behaving in real data:
 *   - Are transcriptChunks present at all?
 *   - Do chunks carry a real speakerId (live-caption path = truthful) vs only a
 *     speaker name vs nothing (mixed-audio Whisper backstop, honestly unattributed)?
 *   - Is there any sign of the OLD fabricated rotation (many distinct speaker names
 *     with NO speakerId on the same meeting → likely the old heuristic)?
 *   - Did the meeting get a summary + (implicitly) brain ingestion material?
 *
 * Makes NO writes. Run:
 *   npx ts-node scripts/inspect-transcripts.ts
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

import { Meeting } from '../models/meeting';
import { CalendarEvent } from '../models/calendarEvent';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/bubble';

const auditChunks = (chunks: any[] = []) => {
  const total = chunks.length;
  const withSpeakerId = chunks.filter((c) => c.speakerId).length;
  const withSpeakerNameOnly = chunks.filter((c) => !c.speakerId && c.speaker).length;
  const unattributed = chunks.filter((c) => !c.speakerId && !c.speaker).length;
  const distinctNames = new Set(chunks.map((c) => c.speaker).filter(Boolean));
  const distinctIds = new Set(chunks.map((c) => c.speakerId).filter(Boolean));
  return { total, withSpeakerId, withSpeakerNameOnly, unattributed, distinctNames, distinctIds };
};

const verdict = (a: ReturnType<typeof auditChunks>) => {
  if (a.total === 0) return 'no chunks';
  if (a.withSpeakerId > 0) return '✅ live-caption attribution (truthful speakerId)';
  if (a.withSpeakerNameOnly > 0 && a.distinctNames.size <= 1)
    return '✅ single-speaker name only (post-fix backstop behavior)';
  if (a.withSpeakerNameOnly > 0 && a.distinctNames.size > 1)
    return '⚠️  multiple names, NO speakerId — could be legacy fabricated rotation';
  if (a.unattributed === a.total)
    return '✅ unattributed (mixed-audio backstop, honest)';
  return 'mixed';
};

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log('🔌 Connected (READ-ONLY)\n');

  for (const [label, Model] of [
    ['Meeting', Meeting],
    ['CalendarEvent', CalendarEvent],
  ] as const) {
    const docs = await (Model as any)
      .find({ transcriptChunks: { $exists: true, $ne: [] } })
      .select('_id title summary transcriptChunks createdAt')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    console.log(`=== ${label}: ${docs.length} doc(s) with transcriptChunks ===`);
    if (docs.length === 0) {
      console.log('   (none — no meetings have produced transcript chunks yet)\n');
      continue;
    }

    for (const d of docs) {
      const a = auditChunks(d.transcriptChunks);
      console.log(
        `\n  • ${String(d._id)}  "${(d.title || 'untitled').slice(0, 40)}"  (${
          d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 10) : '?'
        })`
      );
      console.log(
        `    chunks=${a.total}  withSpeakerId=${a.withSpeakerId}  nameOnly=${a.withSpeakerNameOnly}  ` +
          `unattributed=${a.unattributed}  distinctNames=${a.distinctNames.size}  distinctIds=${a.distinctIds.size}`
      );
      console.log(`    summary=${d.summary ? 'yes (' + d.summary.length + ' chars)' : 'NO'}`);
      console.log(`    verdict: ${verdict(a)}`);
      // Show first 2 chunks as a sample of the ingested "Name: text" shape.
      d.transcriptChunks.slice(0, 2).forEach((c: any) => {
        const who = c.speaker ? c.speaker + (c.speakerId ? ` [${c.speakerId}]` : '') : '(unattributed)';
        console.log(`      ↳ ${who}: ${String(c.text || '').slice(0, 60)}`);
      });
    }
    console.log('');
  }

  await mongoose.disconnect();
  console.log('🔌 Disconnected.');
}

run().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
