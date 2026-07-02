/**
 * One-time migration: remove server-held user private keys.
 *
 * The old flow generated RSA keypairs server-side and stored the PRIVATE key in
 * the User document — incompatible with real E2EE. Client-side nacl keypairs
 * replace them; legacy RSA public keys (PEM) are also cleared so clients
 * re-register their nacl public key on next login.
 *
 *   npx ts-node scripts/migrate-drop-private-keys.ts
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/bubble';

async function run() {
  await mongoose.connect(MONGODB_URI);
  const users = mongoose.connection.collection('users');

  const dropped = await users.updateMany(
    { privateKey: { $exists: true } },
    { $unset: { privateKey: '' } }
  );
  // Legacy PEM public keys are not nacl keys — clear so clients re-upload.
  const clearedPem = await users.updateMany(
    { publicKey: { $regex: '^-----BEGIN' } },
    { $set: { publicKey: '' } }
  );

  console.log(`✅ Removed privateKey from ${dropped.modifiedCount} user(s).`);
  console.log(`✅ Cleared legacy PEM publicKey on ${clearedPem.modifiedCount} user(s).`);
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
