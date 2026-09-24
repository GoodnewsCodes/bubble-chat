import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

import { User } from '../models/users';
import Post from '../models/post';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/bubble-chat';

const postsData = [
  {
    content: "Just configured the new neural pathway API. The data throughput is phenomenal compared to the legacy architecture. We are truly entering the new age of instantaneous web3 integrations. ⚡",
    media: [
      { type: "image", url: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=800&q=80" }
    ],
    tags: ["tech", "api", "neural"]
  },
  {
    content: "Architecture review was a massive success today. The sector 07 team successfully migrated all legacy database entries to the new distributed cluster. Let's keep the momentum going!",
    media: [],
    tags: ["infrastructure", "migration"]
  },
  {
    content: "Observational notes: Ambient glow properties are massively improving interface retention times... Visual hierarchy matters.",
    media: [
      { type: "image", url: "https://images.unsplash.com/photo-1620121478247-ec786ac3abf2?w=800&q=80" }
    ],
    tags: ["ui", "ux", "design"]
  }
];

const seedFeed = async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    // console.log('MongoDB connected for Feed Data generation.');

    let author = await User.findOne({ username: 'alpha_explorer' });
    if (!author) {
      // console.log('alpha_explorer missing. Creating default creator profile...');
      author = await User.create({
        full_name: 'Alpha Explorer',
        username: 'alpha_explorer',
        email: 'alpha@test.bubble.io',
        password: 'Password123!',
        uniqueTag: 'ALPHA123',
        isVerified: true
      });
    }

    await Post.deleteMany({});

    for (const p of postsData) {
      await Post.create({
        author: author._id,
        content: p.content,
        mediaUrl: p.media[0]?.url || undefined,
        mediaType: p.media[0]?.type || undefined,
        likes: [author._id]
      });
    }

    // console.log('--- Feed Data Implanted ---');

  } catch (error) {
    console.error('Error seeding feeds:', error);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
};

seedFeed();
