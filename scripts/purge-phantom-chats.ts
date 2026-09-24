/**
 * purge-phantom-chats.ts — delete bogus "Unknown User" conversations.
 *
 * The old accessChat(conversationId) bug upserted 1:1 conversations whose `users`
 * array contained an id that isn't a real User (a conversation id was passed where
 * a userId was expected). Those render as "Unknown User" and can even hold
 * mis-routed messages. This removes any non-group conversation with fewer than two
 * resolvable real-user members, plus its messages.
 *
 * Run:
 *   npm run purge:phantom            (from Backend/)
 *   # or: npx ts-node scripts/purge-phantom-chats.ts
 *   DRY_RUN=1 npm run purge:phantom  (report only, delete nothing)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

import { User } from '../models/users';
import { Conversation } from '../models/conversations';
import { Message } from '../models/messages';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/bubble';
const DRY_RUN = process.env.DRY_RUN === '1';

async function run() {
  try {
    // console.log('🔌 Connecting to MongoDB…');
    await mongoose.connect(MONGODB_URI);
    // console.log(`✅ Connected.${DRY_RUN ? '  (DRY RUN — nothing will be deleted)' : ''}\n`);

    const dms = await Conversation.find({ isGroupChat: { $ne: true } }).select('_id users').lean();
    const phantomIds: any[] = [];

    for (const c of dms) {
      const memberIds = (c.users || []).map((u: any) => String(u._id || u));
      // Count how many members actually exist as real users.
      const realCount = memberIds.length
        ? await User.countDocuments({ _id: { $in: memberIds } })
        : 0;
      // A valid 1:1 has two real users. Anything less = phantom (a member id that
      // isn't a real user, e.g. a conversation id, or a deleted account).
      if (realCount < 2) phantomIds.push(c._id);
    }

    if (phantomIds.length === 0) {
      // console.log('✨ No phantom conversations found. Nothing to purge.');
    } else {
      // console.log(`🔎 Found ${phantomIds.length} phantom conversation(s).`);
      if (!DRY_RUN) {
        const delMsgs = await Message.deleteMany({ chat: { $in: phantomIds } });
        const delConvos = await Conversation.deleteMany({ _id: { $in: phantomIds } });
        // console.log(`🧹 Purged ${delConvos.deletedCount} conversations and ${delMsgs.deletedCount} messages.`);
      } else {
        // console.log('   (DRY RUN — set DRY_RUN=0 or unset it to actually delete.)');
      }
    }

    await mongoose.disconnect();
    // console.log('🔌 Disconnected.');
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

run();
