import mongoose from 'mongoose';
import { User } from '../models/users';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

async function run() {
    try {
        const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/bubble';
        await mongoose.connect(mongoUri);
        // console.log('Connected to MongoDB');

        let bot = await User.findOne({ is_bot: true, username: 'aida' });
        if (!bot) {
            bot = await User.create({
                full_name: 'Aida AI',
                username: 'aida',
                email: 'aida@bubble.internal',
                bio: 'Your intelligent workspace companion. Ask me anything about your organization, tasks, meetings, and more.',
                is_bot: true,
                isVerified: true,
                verified_badge: true,
                onboardingComplete: true,
                avatar: '',
                uniqueTag: 'bubble-AIDA-001',
                organization: 'Bubble Space',
                role: 'admin',
            });
            // console.log('[Aida] Bot user created:', bot._id);
        } else {
            // console.log('[Aida] Bot user already exists.');
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error('Error initializing Aida:', err);
    }
}

run();
