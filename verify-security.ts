import mongoose from 'mongoose';
import { SecurityCode } from './models/security';
import dotenv from 'dotenv';
dotenv.config();

const MONGO_URI = process.env.MONGODB_URI as string;

async function verify() {
  try {
    await mongoose.connect(MONGO_URI);
    const code = await SecurityCode.findOne({ isCurrent: true });
    if (code) {
      // console.log('✅ ACTIVE SECURITY CODE FOUND:', code.code);
    } else {
      // console.log('❌ NO ACTIVE SECURITY CODE FOUND');
    }
    await mongoose.disconnect();
  } catch (err) {
    console.error('ERROR:', err);
    process.exit(1);
  }
}

verify();
