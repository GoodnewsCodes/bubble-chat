/**
 * dedupe-direct-conversations.ts
 * One-time cleanup for duplicate 1:1 (DM) conversations.
 *
 * Older "Tap to chat" / routing flows could race into parallel DM documents for
 * the same user-pair, which surfaced as the same contact appearing twice in the
 * chat list (each with the "Say hello!" placeholder). The app/back-end now create
 * DMs idempotently, but pre-existing duplicates need merging once.
 *
 * For every pair with more than one DM, this keeps the conversation with the most
 * recent activity, repoints all messages onto it, unions the per-user state
 * (muted/archived/pinned), intersects `deletedBy` (a user stays "deleted" only if
 * they had deleted every copy), recomputes `latestMessage`, then deletes the rest.
 *
 * Dry-run by default — prints what it WOULD do. Set APPLY=true to mutate.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/dedupe-direct-conversations.ts          # preview
 *   APPLY=true npx ts-node -r tsconfig-paths/register scripts/dedupe-direct-conversations.ts # execute
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

import { Conversation } from '../models/conversations';
import { Message } from '../models/messages';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/bubble';
const APPLY = process.env.APPLY === 'true';

const pairKey = (users: mongoose.Types.ObjectId[]): string =>
  users.map((u) => String(u)).sort().join('::');

const uniqStrings = (ids: any[]): string[] => Array.from(new Set(ids.map((i) => String(i))));

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log(`🔌 Connected. Mode: ${APPLY ? 'APPLY (will mutate)' : 'DRY-RUN (no changes)'}\n`);

  // Only well-formed 1:1 conversations (exactly two participants).
  const dms = await Conversation.find({ isGroupChat: false, users: { $size: 2 } }).lean();

  // Bucket by sorted user-pair.
  const byPair = new Map<string, any[]>();
  for (const c of dms) {
    const key = pairKey(c.users as any);
    (byPair.get(key) || byPair.set(key, []).get(key)!).push(c);
  }

  let pairsWithDupes = 0;
  let convosDeleted = 0;
  let messagesMoved = 0;

  for (const [key, copies] of byPair) {
    if (copies.length < 2) continue;
    pairsWithDupes++;

    // Message counts + latest activity per copy.
    const stats = await Promise.all(
      copies.map(async (c) => {
        const count = await Message.countDocuments({ chat: c._id });
        const last = await Message.findOne({ chat: c._id }).sort({ createdAt: -1 }).select('createdAt').lean();
        const lastTs = last?.createdAt ? new Date(last.createdAt).getTime() : new Date(c.updatedAt || 0).getTime();
        return { c, count, lastTs };
      })
    );

    // Keeper: most recent activity, then most messages.
    stats.sort((a, b) => b.lastTs - a.lastTs || b.count - a.count);
    const keeper = stats[0].c;
    const dups = stats.slice(1).map((s) => s.c);

    console.log(
      `Pair ${key.slice(0, 16)}…  ${copies.length} copies → keep ${String(keeper._id)} ` +
        `(${stats[0].count} msgs), merge ${dups.length}`
    );

    if (!APPLY) {
      convosDeleted += dups.length;
      messagesMoved += stats.slice(1).reduce((n, s) => n + s.count, 0);
      continue;
    }

    const dupIds = dups.map((d) => d._id);

    // Repoint messages onto the keeper.
    const moved = await Message.updateMany({ chat: { $in: dupIds } }, { $set: { chat: keeper._id } });
    messagesMoved += moved.modifiedCount || 0;

    // Union per-user UI state; intersect deletedBy across ALL copies.
    const allCopies = [keeper, ...dups];
    const unionField = (field: string) => uniqStrings(allCopies.flatMap((c: any) => c[field] || []));
    const deletedByIntersection = (keeper.deletedBy || [])
      .map((u: any) => String(u))
      .filter((u: string) => allCopies.every((c: any) => (c.deletedBy || []).some((d: any) => String(d) === u)));

    const newLatest = await Message.findOne({ chat: keeper._id }).sort({ createdAt: -1 }).select('_id').lean();

    await Conversation.updateOne(
      { _id: keeper._id },
      {
        $set: {
          mutedBy: unionField('mutedBy'),
          archivedBy: unionField('archivedBy'),
          pinnedBy: unionField('pinnedBy'),
          pinnedMessages: unionField('pinnedMessages'),
          deletedBy: deletedByIntersection,
          ...(newLatest?._id ? { latestMessage: newLatest._id } : {}),
        },
      }
    );

    const del = await Conversation.deleteMany({ _id: { $in: dupIds } });
    convosDeleted += del.deletedCount || 0;
  }

  console.log(
    `\n${APPLY ? '✅ Applied' : '📋 Would apply'}: pairs with dupes ${pairsWithDupes}, ` +
      `conversations removed ${convosDeleted}, messages moved ${messagesMoved}`
  );
  if (!APPLY && pairsWithDupes > 0) console.log('   Re-run with APPLY=true to execute.');

  await mongoose.disconnect();
  console.log('🔌 Disconnected.');
}

run().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
