import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import * as SecureStore from 'expo-secure-store';
import { getRandomBytes } from 'expo-crypto';
import { getChatKeys, postChatKeys, updateProfile } from './api';

/**
 * End-to-end encryption (tweetnacl) — mirror of the web module
 * (BUBBLESPACE/frontend/src/lib/e2ee.ts); envelope formats MUST stay in sync
 * with it and with Backend/utils/brainKeyService.ts.
 *
 *  - DMs: nacl.box between the two participants; no server/Brain key exists.
 *  - Groups: per-conversation nacl.secretbox key wrapped to each member and to
 *    the org Brain, so Aida/Brain group features keep working.
 *
 * Private key lives in the device keychain via expo-secure-store.
 */

// Hermes has no crypto.getRandomValues; feed nacl from expo-crypto's CSPRNG.
nacl.setPRNG((x: Uint8Array, n: number) => {
    const bytes = getRandomBytes(n);
    for (let i = 0; i < n; i++) x[i] = bytes[i];
});

const KEYPAIR_STORAGE_KEY = 'bubble_e2ee_keypair_v1';

export interface MessageEnvelope {
    v: number;
    alg: 'nacl.box' | 'nacl.secretbox';
    nonce: string;
    ciphertext: string;
    from?: string;
    epoch?: number;
}

interface ChatCipherState {
    mode: 'dm' | 'group';
    otherPub?: Uint8Array;
    groupKey?: Uint8Array;
    epoch?: number;
}

let keyPairCache: nacl.BoxKeyPair | null = null;
const chatStateCache = new Map<string, ChatCipherState | null>();
const groupKeyByEpoch = new Map<string, Uint8Array>();

// ─── Key pair ─────────────────────────────────────────────────────────────────

export const ensureKeyPair = async (): Promise<nacl.BoxKeyPair> => {
    if (keyPairCache) return keyPairCache;
    try {
        const raw = await SecureStore.getItemAsync(KEYPAIR_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            keyPairCache = nacl.box.keyPair.fromSecretKey(util.decodeBase64(parsed.secretKey));
            return keyPairCache;
        }
    } catch { /* regenerate below */ }
    keyPairCache = nacl.box.keyPair();
    await SecureStore.setItemAsync(KEYPAIR_STORAGE_KEY, JSON.stringify({
        publicKey: util.encodeBase64(keyPairCache.publicKey),
        secretKey: util.encodeBase64(keyPairCache.secretKey),
    }));
    return keyPairCache;
};

export const getMyPublicKeyB64 = async (): Promise<string> =>
    util.encodeBase64((await ensureKeyPair()).publicKey);

/** Call once after login: register this device's public key with the server. */
export const bootstrapE2EE = async (currentPublicKey?: string | null): Promise<void> => {
    const mine = await getMyPublicKeyB64();
    if (currentPublicKey !== mine) {
        try { await updateProfile({ publicKey: mine }); } catch (err) {
            console.warn('[e2ee] public key upload failed (will retry next session):', err);
        }
    }
};

// ─── Primitives ───────────────────────────────────────────────────────────────

const wrapKey = (kp: nacl.BoxKeyPair, key: Uint8Array, recipientPubB64: string): string => {
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const box = nacl.box(key, nonce, util.decodeBase64(recipientPubB64), kp.secretKey);
    return JSON.stringify({
        nonce: util.encodeBase64(nonce),
        box: util.encodeBase64(box),
        from: util.encodeBase64(kp.publicKey),
    });
};

const unwrapKey = (kp: nacl.BoxKeyPair, wrapped: string): Uint8Array | null => {
    try {
        const env = JSON.parse(wrapped);
        return nacl.box.open(
            util.decodeBase64(env.box),
            util.decodeBase64(env.nonce),
            util.decodeBase64(env.from),
            kp.secretKey
        ) || null;
    } catch { return null; }
};

// ─── Per-chat state ───────────────────────────────────────────────────────────

export const prepareChat = async (chatId: string, myId: string): Promise<ChatCipherState | null> => {
    if (chatStateCache.has(chatId)) return chatStateCache.get(chatId) ?? null;
    let state: ChatCipherState | null = null;
    try {
        const kp = await ensureKeyPair();
        const info = await getChatKeys(chatId);
        const members: { id: string; publicKey: string | null }[] = info.members || [];

        if (!info.isGroupChat) {
            const other = members.find(m => m.id !== myId);
            state = other?.publicKey
                ? { mode: 'dm', otherPub: util.decodeBase64(other.publicKey) }
                : null;
        } else {
            let groupKey: Uint8Array | null = null;
            let epoch: number = info.epoch || 0;

            if (epoch > 0 && info.myWrappedKey) {
                groupKey = unwrapKey(kp, info.myWrappedKey);
            }
            if (epoch === 0) {
                groupKey = nacl.randomBytes(nacl.secretbox.keyLength);
                epoch = 1;
                const keys = members
                    .filter(m => m.publicKey)
                    .map(m => ({ recipientId: m.id, encryptedKey: wrapKey(kp, groupKey!, m.publicKey!) }));
                if (info.brainPublicKey) {
                    keys.push({ recipientId: 'brain', encryptedKey: wrapKey(kp, groupKey, info.brainPublicKey) });
                }
                if (keys.length > 0) await postChatKeys(chatId, epoch, keys);
            } else if (groupKey && Array.isArray(info.missingRecipients) && info.missingRecipients.length > 0) {
                const byId = new Map(members.map(m => [m.id, m.publicKey]));
                const keys = info.missingRecipients
                    .map((rid: string) => {
                        const pub = rid === 'brain' ? info.brainPublicKey : byId.get(rid);
                        return pub ? { recipientId: rid, encryptedKey: wrapKey(kp, groupKey!, pub) } : null;
                    })
                    .filter(Boolean) as { recipientId: string; encryptedKey: string }[];
                if (keys.length > 0) postChatKeys(chatId, epoch, keys).catch(() => undefined);
            }

            if (groupKey) {
                groupKeyByEpoch.set(`${chatId}:${epoch}`, groupKey);
                state = { mode: 'group', groupKey, epoch };
            }
        }
    } catch (err) {
        console.warn('[e2ee] prepareChat failed — falling back to plaintext:', err);
        state = null;
    }
    chatStateCache.set(chatId, state);
    return state;
};

export const resetChatState = (chatId: string) => { chatStateCache.delete(chatId); };

// ─── Encrypt / decrypt ────────────────────────────────────────────────────────

export const encryptForChat = async (state: ChatCipherState, text: string): Promise<string> => {
    const bytes = util.decodeUTF8(text);
    if (state.mode === 'dm') {
        const kp = await ensureKeyPair();
        const nonce = nacl.randomBytes(nacl.box.nonceLength);
        const ciphertext = nacl.box(bytes, nonce, state.otherPub!, kp.secretKey);
        return JSON.stringify({
            v: 1, alg: 'nacl.box',
            nonce: util.encodeBase64(nonce),
            ciphertext: util.encodeBase64(ciphertext),
            from: util.encodeBase64(kp.publicKey),
        } as MessageEnvelope);
    }
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const ciphertext = nacl.secretbox(bytes, nonce, state.groupKey!);
    return JSON.stringify({
        v: 1, alg: 'nacl.secretbox',
        nonce: util.encodeBase64(nonce),
        ciphertext: util.encodeBase64(ciphertext),
        epoch: state.epoch,
    } as MessageEnvelope);
};

export const parseEnvelope = (content: string | null | undefined): MessageEnvelope | null => {
    if (!content || content[0] !== '{') return null;
    try {
        const env = JSON.parse(content);
        return env && (env.alg === 'nacl.box' || env.alg === 'nacl.secretbox') && env.nonce && env.ciphertext
            ? env : null;
    } catch { return null; }
};

export const decryptEnvelope = (
    chatId: string,
    env: MessageEnvelope,
    state: ChatCipherState | null
): string | null => {
    try {
        if (env.alg === 'nacl.box') {
            if (!state?.otherPub || !keyPairCache) return null;
            const opened = nacl.box.open(
                util.decodeBase64(env.ciphertext),
                util.decodeBase64(env.nonce),
                state.otherPub,
                keyPairCache.secretKey
            );
            return opened ? util.encodeUTF8(opened) : null;
        }
        const key = env.epoch !== undefined
            ? (groupKeyByEpoch.get(`${chatId}:${env.epoch}`) || (state?.epoch === env.epoch ? state?.groupKey : undefined))
            : state?.groupKey;
        if (!key) return null;
        const opened = nacl.secretbox.open(
            util.decodeBase64(env.ciphertext),
            util.decodeBase64(env.nonce),
            key
        );
        return opened ? util.encodeUTF8(opened) : null;
    } catch { return null; }
};

export const ENCRYPTED_PLACEHOLDER = '🔒 Encrypted message';
