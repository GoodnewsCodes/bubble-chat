import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import { ConversationKey } from '../models/conversationKey';

/**
 * The Brain's cryptographic identity — the ONLY server-side party that can read
 * E2EE group messages. Clients wrap each group's symmetric key to this public
 * key (ConversationKey row with recipientId 'brain'); ingestion and Aida group
 * features decrypt exclusively through this module.
 *
 * Isolation rules:
 *  - The private key lives in the BRAIN_PRIVATE_KEY env var (base64, 32 bytes),
 *    NEVER in Mongo. Rotating it requires re-wrapping group keys client-side.
 *  - 1:1 DMs have no 'brain' ConversationKey row, so this module physically
 *    cannot decrypt them — the privacy boundary is cryptographic, not policy.
 *
 * Generate a keypair with: npx ts-node scripts/generate-brain-keypair.ts
 */

let cachedKeyPair: nacl.BoxKeyPair | null = null;

export const brainKeysConfigured = (): boolean => !!process.env.BRAIN_PRIVATE_KEY;

const getKeyPair = (): nacl.BoxKeyPair | null => {
  if (cachedKeyPair) return cachedKeyPair;
  const b64 = process.env.BRAIN_PRIVATE_KEY;
  if (!b64) return null;
  try {
    const secretKey = util.decodeBase64(b64);
    if (secretKey.length !== nacl.box.secretKeyLength) {
      console.error('[BrainKeys] BRAIN_PRIVATE_KEY is not a 32-byte base64 key.');
      return null;
    }
    cachedKeyPair = nacl.box.keyPair.fromSecretKey(secretKey);
    return cachedKeyPair;
  } catch (err) {
    console.error('[BrainKeys] Failed to parse BRAIN_PRIVATE_KEY:', err);
    return null;
  }
};

/** Base64 public key clients wrap group keys to. Null when E2EE-for-brain is unconfigured. */
export const getBrainPublicKey = (): string | null => {
  const kp = getKeyPair();
  return kp ? util.encodeBase64(kp.publicKey) : null;
};

/** Envelope format shared with clients (all fields base64). */
interface WrappedKeyEnvelope {
  nonce: string;
  box: string;
  /** Wrapper's public key so recipients can open without a directory lookup. */
  from: string;
}

interface MessageEnvelope {
  v: number;
  alg: string;
  nonce: string;
  ciphertext: string;
  epoch?: number;
}

const groupKeyCache = new Map<string, Uint8Array>(); // `${conversationId}:${epoch}` → key

/**
 * Unwrap the group key for a conversation at a given epoch (latest if omitted).
 * Returns null when the Brain has no key for it (e.g. a private conversation).
 */
export const getGroupKeyForBrain = async (
  conversationId: string,
  epoch?: number
): Promise<Uint8Array | null> => {
  const kp = getKeyPair();
  if (!kp) return null;

  const query: any = { conversationId, recipientId: 'brain' };
  if (epoch !== undefined) query.epoch = epoch;
  const row = await ConversationKey.findOne(query).sort({ epoch: -1 }).lean();
  if (!row) return null;

  const cacheKey = `${conversationId}:${row.epoch}`;
  const cached = groupKeyCache.get(cacheKey);
  if (cached) return cached;

  try {
    const env: WrappedKeyEnvelope = JSON.parse(row.encryptedKey);
    const opened = nacl.box.open(
      util.decodeBase64(env.box),
      util.decodeBase64(env.nonce),
      util.decodeBase64(env.from),
      kp.secretKey
    );
    if (!opened) return null;
    groupKeyCache.set(cacheKey, opened);
    return opened;
  } catch (err) {
    console.error(`[BrainKeys] Failed to unwrap group key for ${conversationId}:`, err);
    return null;
  }
};

/**
 * Decrypt an E2EE group message for Brain/Aida processing. Accepts the raw
 * Message.content string; returns plaintext, or null if this conversation is
 * outside the Brain's reach (DM/private) or the envelope is malformed.
 */
export const decryptForBrain = async (
  conversationId: string,
  content: string
): Promise<string | null> => {
  let env: MessageEnvelope;
  try {
    env = JSON.parse(content);
  } catch {
    return null;
  }
  if (!env || env.alg !== 'nacl.secretbox' || !env.nonce || !env.ciphertext) return null;

  const key = await getGroupKeyForBrain(conversationId, env.epoch);
  if (!key) return null;

  try {
    const opened = nacl.secretbox.open(
      util.decodeBase64(env.ciphertext),
      util.decodeBase64(env.nonce),
      key
    );
    return opened ? util.encodeUTF8(opened) : null;
  } catch {
    return null;
  }
};
