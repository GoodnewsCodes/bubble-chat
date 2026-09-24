/**
 * seed-test.ts — fresh-start test data for messaging/calls/updates QA.
 *
 * Resets prior test data (everything under *@bubble.test — users, their
 * conversations and messages), then creates ONE small realistic org so every
 * feature (DMs, group chat, previews, unread badges, calls, mentions) is
 * testable from a clean slate. All messages are PLAINTEXT (is_encrypted:false)
 * — the mobile client no longer encrypts.
 *
 * Run:
 *   npm run seed:test           (from Backend/)
 *   # or: npx ts-node scripts/seed-test.ts
 *
 * Optional overrides (env):
 *   SEED_ORG        organization name.        Default: 'Bubble QA'
 *   SEED_PASSWORD   shared password for all.  Default: 'BubbleTest2026!'
 *   SEED_FORCE=1    allow seeding a non-local DB.
 */

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

import { User } from '../models/users';
import { Organization } from '../models/organizations';
import { Conversation } from '../models/conversations';
import { Message } from '../models/messages';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/bubble';

// Guard: never seed known-password accounts into production unless forced.
const looksLocal = /localhost|127\.0\.0\.1/.test(MONGODB_URI);
if ((process.env.NODE_ENV === 'production' || !looksLocal) && process.env.SEED_FORCE !== '1') {
    console.error('✋ Refusing to seed: non-local MONGODB_URI or NODE_ENV=production.');
    console.error('   Set SEED_FORCE=1 (and a strong SEED_PASSWORD) if you really mean it.');
    process.exit(1);
}
if (!looksLocal && !process.env.SEED_PASSWORD) {
    console.error('✋ SEED_PASSWORD is required when seeding a non-local database — no default password.');
    process.exit(1);
}

const ORG = process.env.SEED_ORG || 'Bubble QA';
const PASSWORD = process.env.SEED_PASSWORD || 'BubbleTest2026!';
const TEST_EMAIL_RE = /@bubble\.test$/i;

// Small, realistic roster. Emails are stable & scoped to @bubble.test so the
// reset below only ever touches seeded accounts.
const ROSTER: { name: string; email: string; username: string; role: 'admin' | 'employee'; org_role: string }[] = [
    { name: 'Ada Founder', email: 'ada@bubble.test', username: 'ada', role: 'admin', org_role: 'Founder' },
    { name: 'Ben Backend', email: 'ben@bubble.test', username: 'ben', role: 'employee', org_role: 'Backend Engineer' },
    { name: 'Chidi Design', email: 'chidi@bubble.test', username: 'chidi', role: 'employee', org_role: 'Product Designer' },
    { name: 'Dara Mobile', email: 'dara@bubble.test', username: 'dara', role: 'employee', org_role: 'Mobile Engineer' },
    { name: 'Efe Marketing', email: 'efe@bubble.test', username: 'efe', role: 'employee', org_role: 'Marketing Lead' },
];

function uniqueTagFor(username: string): string {
    return `${username}-${Math.floor(1000 + Math.random() * 9000)}`;
}

/** Insert a plaintext text message and point the conversation's latestMessage at it. */
async function seedMessage(convId: any, senderId: any, memberIds: any[], content: string) {
    const msg = await Message.create({
        sender: senderId,
        content,
        chat: convId,
        message_type: 'text',
        is_encrypted: false,
        readBy: [senderId],           // sender has read their own message
        deliveredTo: memberIds,       // treat as delivered to everyone for QA
    });
    await Conversation.findByIdAndUpdate(convId, { latestMessage: msg._id });
    return msg;
}

async function run() {
    try {
        // console.log('🔌 Connecting to MongoDB…');
        await mongoose.connect(MONGODB_URI);
        // console.log('✅ Connected.\n');

        // ── Reset: wipe prior @bubble.test users + their convos + messages ──
        const oldUsers = await User.find({ email: TEST_EMAIL_RE }).select('_id');
        const oldIds = oldUsers.map(u => u._id);
        if (oldIds.length) {
            const oldConvos = await Conversation.find({ users: { $in: oldIds } }).select('_id');
            const oldConvoIds = oldConvos.map(c => c._id);
            const delMsgs = await Message.deleteMany({ chat: { $in: oldConvoIds } });
            const delConvos = await Conversation.deleteMany({ _id: { $in: oldConvoIds } });
            const delUsers = await User.deleteMany({ _id: { $in: oldIds } });
            // console.log(`🧹 Reset: removed ${delUsers.deletedCount} users, ${delConvos.deletedCount} conversations, ${delMsgs.deletedCount} messages.\n`);
        } else {
            // console.log('🧹 Reset: no prior @bubble.test data found.\n');
        }
        // Fresh org each run so scoping is clean.
        await Organization.deleteMany({ name: ORG });

        // ── Users + organization ──
        const hashedPassword = await bcrypt.hash(PASSWORD, 12);
        const users: Record<string, any> = {};
        let orgDoc: any = null;

        for (const person of ROSTER) {
            const user = await User.create({
                full_name: person.name,
                email: person.email,
                username: person.username,
                password: hashedPassword,
                uniqueTag: uniqueTagFor(person.username),
                isVerified: true,
                onboardingComplete: true,
                onboardingStep: 'complete',
                signupKind: person.role === 'admin' ? 'organization' : 'individual',
                role: person.role,
                organization: ORG,
                org_role: person.org_role,
                bio: `${person.org_role} at ${ORG} (seeded test account)`,
                privacy_settings: {
                    profile_photo: 'everyone',
                    last_seen: 'everyone',
                    read_receipts: true,
                    show_online_status: true,
                    email_notifications: true,
                },
                notification_settings: { muted: false, preview: true, sounds: true },
                actionItemEmailMode: 'each',
            });

            if (!orgDoc && person.role === 'admin') {
                orgDoc = await Organization.create({
                    name: ORG,
                    owner: user._id,
                    inviteCode: `org-${Math.random().toString(36).slice(2, 10)}`,
                });
                // console.log(`🏢 Created organization "${ORG}" (invite: ${orgDoc.inviteCode})`);
            }
            users[person.username] = user;
        }
        // Attach org to everyone + wire up mutual contacts so they see each other.
        const allIds = Object.values(users).map((u: any) => u._id);
        for (const u of Object.values(users) as any[]) {
            u.organizationId = orgDoc?._id;
            u.contacts = allIds.filter((id: any) => String(id) !== String(u._id));
            await u.save();
        }

        // ── Conversations: 2 DMs + 1 group, each with a few plaintext messages ──
        const dm = async (a: any, b: any) => Conversation.create({
            isGroupChat: false,
            users: [a._id, b._id],
            organizationId: orgDoc?._id,
        });

        const adaBen = await dm(users.ada, users.ben);
        await seedMessage(adaBen._id, users.ada._id, [users.ada._id, users.ben._id], 'Hey Ben, are you free for a quick sync?');
        await seedMessage(adaBen._id, users.ben._id, [users.ada._id, users.ben._id], 'Yep, give me 5 and I’ll call you.');
        await seedMessage(adaBen._id, users.ada._id, [users.ada._id, users.ben._id], 'Perfect 👍');

        const adaChidi = await dm(users.ada, users.chidi);
        await seedMessage(adaChidi._id, users.chidi._id, [users.ada._id, users.chidi._id], 'Shared the new mockups in the group.');
        await seedMessage(adaChidi._id, users.ada._id, [users.ada._id, users.chidi._id], 'Looks great, love the new palette.');

        const groupMembers = [users.ada, users.ben, users.chidi, users.dara];
        const groupIds = groupMembers.map(u => u._id);
        const group = await Conversation.create({
            chatName: 'Product Team',
            isGroupChat: true,
            users: groupIds,
            groupAdmin: users.ada._id,
            groupDescription: 'Design + engineering sync',
            organizationId: orgDoc?._id,
        });
        await seedMessage(group._id, users.ada._id, groupIds, 'Morning team — standup in 10 minutes.');
        await seedMessage(group._id, users.dara._id, groupIds, 'On it. Pushing the messaging fix now.');
        await seedMessage(group._id, users.chidi._id, groupIds, 'I’ll demo the updated screens after.');

        // ── Summary ──
        // console.log('\n🌱 Seeded fresh test org:');
        // console.log('──────────────────────────────────────────────────────────');
        // console.log(`   Organization: ${ORG}`);
        // console.log(`   Password (all users): ${PASSWORD}`);
        for (const p of ROSTER) {
            // console.log(`   • ${p.name.padEnd(15)} ${p.email.padEnd(20)} @${p.username.padEnd(6)} [${p.org_role}]`);
        }
        // console.log('   Conversations: 2 DMs (Ada↔Ben, Ada↔Chidi) + 1 group (Product Team)');
        // console.log('──────────────────────────────────────────────────────────');
        // console.log('   Log two of them in on web + mobile to test messaging, calls,');
        // console.log('   presence, mentions and the People/Updates screens.\n');

        await mongoose.disconnect();
        // console.log('🔌 Disconnected.');
    } catch (err) {
        console.error('❌ Error:', err);
        process.exit(1);
    }
}

run();
