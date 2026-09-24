import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import bcrypt from 'bcryptjs';

// Load env before importing models
dotenv.config({ path: path.join(__dirname, '../.env') });

import { User } from '../models/users';
import Network, { NetworkPost } from '../models/network';
import { Task } from '../models/task';
import { Transaction } from '../models/transaction';
import { Goal } from '../models/goal';
import Post from '../models/post';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/bubble-chat';

const seed = async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    // console.log('MongoDB Connected. Initiating Global Seed Protocol...');

    // 1. Wipe database
    // console.log('Wiping existing data...');
    await User.deleteMany({});
    await Network.deleteMany({});
    await NetworkPost.deleteMany({});
    await Task.deleteMany({});
    await Transaction.deleteMany({});
    await Goal.deleteMany({});
    await Post.deleteMany({});

    // 2. Create Users
    // console.log('Creating users...');
    const hashedPassword = await bcrypt.hash('password123', 12);

    const alpha = await User.create({
      full_name: 'Alpha Explorer',
      username: 'alpha_explorer',
      email: 'alpha@sets.chat',
      password: hashedPassword,
      isVerified: true,
      uniqueTag: 'sets-alpha99',
      avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=800&q=80',
    });

    const beta = await User.create({
      full_name: 'Beta Navigator',
      username: 'beta_nav',
      email: 'beta@sets.chat',
      password: hashedPassword,
      isVerified: true,
      uniqueTag: 'sets-beta88',
      avatar: 'https://images.unsplash.com/photo-1527980965255-d3b416303d12?w=800&q=80',
    });

    const gamma = await User.create({
      full_name: 'Gamma Pilot',
      username: 'gamma_pilot',
      email: 'gamma@sets.chat',
      password: hashedPassword,
      isVerified: true,
      uniqueTag: 'sets-gamma77',
      avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=800&q=80',
    });

    // 3. Setup Contacts and Social Graph
    alpha.contacts?.push(beta._id as any, gamma._id as any);
    alpha.following?.push(beta._id as any);
    beta.followers?.push(alpha._id as any);
    beta.contacts?.push(alpha._id as any);
    await alpha.save();
    await beta.save();

    // console.log('Users and social graph established.');

    // 4. Create Community Networks
    // console.log('Establishing community networks...');
    const designNet = await Network.create({
      title: "Design Explorers",
      description: "A hub for designers pushing visual bounds.",
      creator: alpha._id,
      members: [alpha._id, beta._id],
      memberCount: 2,
      image: "https://images.unsplash.com/photo-1620121478247-ec786ac3abf2?w=800&q=80",
      categories: ["Design", "Trending"],
      onlyCreatorCanPost: true
    });

    const apiNet = await Network.create({
      title: "Neural Nets & APIs",
      description: "Deep technical dive into architectural developments.",
      creator: beta._id,
      members: [beta._id, gamma._id, alpha._id],
      memberCount: 3,
      image: "https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=800&q=80",
      categories: ["AI & ML", "Tech"],
      onlyCreatorCanPost: false
    });

    // 5. Add Community Updates (Network Posts)
    await NetworkPost.create({
      network: designNet._id,
      author: alpha._id,
      content: "Welcome to Design Explorers! Feel free to share your latest work in the thread.",
    });

    await NetworkPost.create({
      network: apiNet._id,
      author: beta._id,
      content: "Has anyone tried integrating Gemma models with Node.js recently?",
    });

    // console.log('Community updates transmitted.');

    // 6. Create OPay Goals & Transactions
    // console.log('Setting up Finance & OPay Goals...');
    const savingGoal = await Goal.create({
      user_id: alpha._id,
      title: "New MacBook Pro Fund",
      targetAmount: 3000,
      currentAmount: 1500,
      currency: "usd",
      type: "individual",
      members: [alpha._id]
    });

    const groupGoal = await Goal.create({
      user_id: alpha._id,
      title: "Team Retrospect Retreat",
      targetAmount: 5000,
      currentAmount: 850,
      currency: "usd",
      type: "group",
      members: [alpha._id, beta._id, gamma._id]
    });

    // Seed Transactions
    await Transaction.create({
      user_id: alpha._id,
      type: 'deposit',
      amount: 2000,
      status: 'completed',
      source: 'opay_deposit',
      description: 'Initial funds load'
    });

    await Transaction.create({
      user_id: alpha._id,
      type: 'expense',
      amount: 1500,
      status: 'completed',
      source: 'opay_or_stripe',
      description: `Contribution to Goal: New MacBook Pro Fund`
    });

    await Transaction.create({
      user_id: beta._id,
      type: 'expense',
      amount: 850,
      status: 'completed',
      source: 'opay_or_stripe',
      description: `Contribution to Goal: Team Retrospect Retreat`
    });

    // 7. Seed Tasks for AI Briefings
    await Task.create({
      user_id: alpha._id,
      title: "Review Figma mockups",
      start_time: new Date(),
      end_time: new Date(Date.now() + 3600000),
      status: "todo",
      priority: "high"
    });

    await Task.create({
      user_id: alpha._id,
      title: "Setup Stripe Webhooks",
      start_time: new Date(Date.now() + 86400000), // Tomorrow
      end_time: new Date(Date.now() + 86400000 + 3600000),
      status: "todo",
      priority: "medium"
    });

    // 8. Add Feed Posts
    await Post.create({
      author: alpha._id,
      content: "Just finalized the new Sets theme engine! 🌌 What does everyone think?",
      likes: [beta._id],
    });

    await Post.create({
      author: gamma._id,
      content: "Studying WebGL shaders today. The mathematics is beautiful.",
      likes: [alpha._id, beta._id],
    });

    // console.log('--- GLOBAL SEED PROTOCOL COMPLETE ---');

  } catch (error) {
    console.error('Seed Error:', error);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
};

seed();
