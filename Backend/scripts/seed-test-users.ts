/**
 * seed-test-users.ts
 * Seeds a whole TEST TEAM: one org founder + several fully-onboarded colleagues
 * in the SAME organization, so you can immediately test calls (incl. busy
 * state), read receipts, group chats, mentions, and presence between accounts.
 *
 * Unlike seed-user.ts (one unverified user for testing onboarding), every user
 * here is verified + onboardingComplete, so they all land straight in the app.
 *
 * Run:
 *   npx ts-node scripts/seed-test-users.ts
 *
 * Optional overrides (env):
 *   SEED_ORG        organization name.        Default: 'Bubble QA'
 *   SEED_PASSWORD   shared password for all.  Default: 'BubbleTest2026!'
 *   SEED_COUNT      number of colleagues (1-8, excl. founder). Default: 4
 */

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

import { User } from '../models/users';
import { Organization } from '../models/organizations';

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
const COUNT = Math.max(1, Math.min(8, parseInt(process.env.SEED_COUNT || '4', 10) || 4));

// Deterministic, memorable test roster. Emails are stable so the script is
// idempotent — re-running skips anyone who already exists.
const ROSTER: { name: string; email: string; role: string; org_role: string }[] = [
    { name: 'Ada Founder',    email: 'ada@bubble.test',    role: 'admin',    org_role: 'CEO' },
    { name: 'Ben Backend',    email: 'ben@bubble.test',    role: 'employee', org_role: 'Backend Engineer' },
    { name: 'Chidi Design',   email: 'chidi@bubble.test',  role: 'employee', org_role: 'Product Designer' },
    { name: 'Dara Mobile',    email: 'dara@bubble.test',   role: 'employee', org_role: 'Mobile Engineer' },
    { name: 'Efe Marketing',  email: 'efe@bubble.test',    role: 'employee', org_role: 'Marketing Lead' },
    { name: 'Funke Sales',    email: 'funke@bubble.test',  role: 'employee', org_role: 'Sales Manager' },
    { name: 'Gozie Support',  email: 'gozie@bubble.test',  role: 'employee', org_role: 'Customer Support' },
    { name: 'Hauwa Finance',  email: 'hauwa@bubble.test',  role: 'employee', org_role: 'Finance Analyst' },
    { name: 'Ike Operations', email: 'ike@bubble.test',    role: 'employee', org_role: 'Operations' },
];

async function uniqueTagFor(name: string): Promise<string> {
    const base = name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().substring(0, 6) || 'user';
    for (let attempt = 0; attempt < 20; attempt++) {
        const tag = `${base}-${Math.floor(1000 + Math.random() * 9000)}`;
        if (!(await User.findOne({ uniqueTag: tag }))) return tag;
    }
    return `${base}-${Date.now()}`;
}

async function uniqueUsernameFor(name: string): Promise<string> {
    const base = name.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
    if (!(await User.findOne({ username: base }))) return base;
    for (let attempt = 0; attempt < 20; attempt++) {
        const candidate = `${base}${Math.floor(10 + Math.random() * 90)}`;
        if (!(await User.findOne({ username: candidate }))) return candidate;
    }
    return `${base}${Date.now() % 10000}`;
}

async function run() {
    try {
        console.log('🔌 Connecting to MongoDB…');
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Connected.\n');

        const hashedPassword = await bcrypt.hash(PASSWORD, 12);
        const toSeed = ROSTER.slice(0, 1 + COUNT); // founder + COUNT colleagues

        const created: { name: string; email: string; username: string; role: string }[] = [];
        let orgDoc = await Organization.findOne({ name: ORG });
        for (const person of toSeed) {
            const existing = await User.findOne({ email: person.email });
            if (existing) {
                console.log(`↷  ${person.email} already exists — skipped.`);
                continue;
            }

            const uniqueTag = await uniqueTagFor(person.name);
            const username = await uniqueUsernameFor(person.name);

            const user = await User.create({
                full_name: person.name,
                email: person.email,
                username,
                password: hashedPassword,
                uniqueTag,
                // Fully onboarded: verified, profile done, org attached — these
                // accounts exist to exercise the APP, not the onboarding wizard.
                isVerified: true,
                onboardingComplete: true,
                onboardingStep: 'complete',
                signupKind: person.role === 'admin' ? 'organization' : 'individual',
                role: person.role,
                organization: ORG,
                org_role: person.org_role,
                bio: `${person.org_role} at ${ORG} (seeded test account)`,
                // Defaults that make testing receipts/notifications predictable.
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

            // First admin creates the Organization document (calendar, live-room
            // scoping and org rosters all resolve through it, not just the name).
            if (!orgDoc && person.role === 'admin') {
                orgDoc = await Organization.create({
                    name: ORG,
                    owner: user._id,
                    inviteCode: `org-${Math.random().toString(36).slice(2, 10)}`,
                });
                console.log(`🏢 Created organization "${ORG}" (invite: ${orgDoc.inviteCode})`);
            }
            if (orgDoc) {
                user.organizationId = orgDoc._id as any;
                await user.save();
            }

            created.push({ name: person.name, email: person.email, username, role: person.role });
        }

        console.log('\n🌱 Seeded test team:');
        console.log('──────────────────────────────────────────────────────────');
        console.log(`   Organization: ${ORG}`);
        console.log(`   Password (all users): ${PASSWORD}`);
        for (const u of created) {
            console.log(`   • ${u.name.padEnd(16)} ${u.email.padEnd(22)} @${u.username}  [${u.role}]`);
        }
        if (created.length === 0) console.log('   (nothing new — all roster emails already existed)');
        console.log('──────────────────────────────────────────────────────────');
        console.log('   Log two of them in on web + mobile to test calls, busy');
        console.log('   state, read receipts, mentions (@username) and presence.');
        console.log('');

        await mongoose.disconnect();
        console.log('🔌 Disconnected.');
    } catch (err) {
        console.error('❌ Error:', err);
        process.exit(1);
    }
}

run();
