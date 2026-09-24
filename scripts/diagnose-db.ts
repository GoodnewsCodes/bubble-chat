import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/bubble-chat';

async function diagnose() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('--- Database Diagnosis ---');

        const db = mongoose.connection.db;
        if (!db) {
            console.error('Database object is undefined.');
            return;
        }

        // Check for users
        const users = await db.collection('users').find({}).toArray();
        console.log(`Total Users: ${users.length}`);
        const emailMap: Record<string, number> = {};
        users.forEach(u => {
            console.log(`- User: ${u.full_name} (${u.email}) | ID: ${u._id} | Org: ${u.organization} | Bot: ${u.is_bot}`);
            if (u.email) {
                emailMap[u.email] = (emailMap[u.email] || 0) + 1;
            } else {
                console.warn(`  ! No email found for user ${u.full_name}`);
            }
        });

        Object.entries(emailMap).forEach(([email, count]) => {
            if (count > 1) console.error(`  !! DUPLICATE EMAIL detected: ${email} (${count} users)`);
        });

        // Check for conversations
        const conversations = await db.collection('conversations').find({}).toArray();
        console.log(`Total Conversations: ${conversations.length}`);
        conversations.forEach(c => {
            console.log(`- Chat: ${c.chatName} | ID: ${c._id} | Group: ${c.isGroupChat} | Users: ${c.users.length}`);
            if (c.users.length > 50) {
                console.error(`  !! POTENTIAL GLOBAL CHAT detected: ${c.chatName}`);
            }
        });

    } catch (err) {
        console.error('Diagnosis failed:', err);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
}

diagnose();
