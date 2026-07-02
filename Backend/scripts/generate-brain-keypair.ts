/**
 * Generate the org Brain's nacl.box keypair for E2EE group access.
 *
 *   npx ts-node scripts/generate-brain-keypair.ts
 *
 * Put BRAIN_PRIVATE_KEY in the backend .env (never commit it). The public key
 * is served to clients via GET /api/v1/chat/:chatId/keys.
 */
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';

const kp = nacl.box.keyPair();
console.log('Add to Backend/.env:\n');
console.log(`BRAIN_PRIVATE_KEY=${util.encodeBase64(kp.secretKey)}`);
console.log(`\n(Public key, derived automatically at runtime: ${util.encodeBase64(kp.publicKey)})`);
