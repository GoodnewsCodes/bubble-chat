import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

import { User } from '../models/users';
import Network from '../models/network';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/bubble-chat';

const seedCommunity = async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    // console.log('MongoDB connected for Community Data generation.');

    await Network.deleteMany({});

    const admin = await User.findOne({ username: 'alpha_explorer' });

    if (admin) {
      await Network.create({
        title: "Design Explorers",
        description: "A hub for designers pushing visual bounds.",
        creator: admin._id,
        members: [admin._id],
        image: "https://images.unsplash.com/photo-1620121478247-ec786ac3abf2?w=800&q=80",
        categories: ["Design", "Trending"]
      });

      await Network.create({
        title: "Neural Nets & APIs",
        description: "Deep technical dive into architectural developments.",
        creator: admin._id,
        members: [admin._id],
        image: "https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=800&q=80",
        categories: ["AI & ML", "Trending"]
      });
    }

    // console.log('--- Community Systems Online ---');

  } catch (error) {
    console.error('Error seeding community:', error);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
};

seedCommunity();
