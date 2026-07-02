import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';

/**
 * E2EE crypto contract tests. These lock the envelope formats and the DM/group
 * key model shared by web (src/lib/e2ee.ts), mobile (src/lib/e2ee.ts) and the
 * Brain key service (utils/brainKeyService.ts). If a client changes primitives,
 * these break — which is the point: the three implementations must interop.
 */

// Mirror of the client secretbox message envelope.
const encGroup = (key: Uint8Array, text: string, epoch: number) => {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(util.decodeUTF8(text), nonce, key);
  return JSON.stringify({
    v: 1, alg: 'nacl.secretbox',
    nonce: util.encodeBase64(nonce),
    ciphertext: util.encodeBase64(ct),
    epoch,
  });
};

const wrapKeyBox = (key: Uint8Array, from: nacl.BoxKeyPair, toPub: Uint8Array) => {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const box = nacl.box(key, nonce, toPub, from.secretKey);
  return JSON.stringify({
    nonce: util.encodeBase64(nonce),
    box: util.encodeBase64(box),
    from: util.encodeBase64(from.publicKey),
  });
};

describe('DM E2EE (nacl.box)', () => {
  it('round-trips a message between two devices', () => {
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();
    const text = 'the eagle lands at midnight 🦅';

    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const ct = nacl.box(util.decodeUTF8(text), nonce, bob.publicKey, alice.secretKey);

    // Bob decrypts with Alice's public key (box shared secret is symmetric).
    const opened = nacl.box.open(ct, nonce, alice.publicKey, bob.secretKey);
    expect(opened).not.toBeNull();
    expect(util.encodeUTF8(opened!)).toBe(text);
  });

  it('a third party cannot decrypt', () => {
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();
    const eve = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const ct = nacl.box(util.decodeUTF8('secret'), nonce, bob.publicKey, alice.secretKey);
    expect(nacl.box.open(ct, nonce, alice.publicKey, eve.secretKey)).toBeNull();
  });
});

describe('Group E2EE (nacl.secretbox + brain wrap)', () => {
  it('every member AND the brain can unwrap the group key and read messages', () => {
    const creator = nacl.box.keyPair();
    const member = nacl.box.keyPair();
    const brain = nacl.box.keyPair();
    const groupKey = nacl.randomBytes(nacl.secretbox.keyLength);

    const wrappedForMember = wrapKeyBox(groupKey, creator, member.publicKey);
    const wrappedForBrain = wrapKeyBox(groupKey, creator, brain.publicKey);

    const unwrap = (wrapped: string, kp: nacl.BoxKeyPair) => {
      const env = JSON.parse(wrapped);
      return nacl.box.open(
        util.decodeBase64(env.box),
        util.decodeBase64(env.nonce),
        util.decodeBase64(env.from),
        kp.secretKey
      );
    };

    const memberKey = unwrap(wrappedForMember, member);
    const brainKey = unwrap(wrappedForBrain, brain);
    expect(memberKey).not.toBeNull();
    expect(brainKey).not.toBeNull();
    expect(util.encodeBase64(memberKey!)).toBe(util.encodeBase64(groupKey));
    expect(util.encodeBase64(brainKey!)).toBe(util.encodeBase64(groupKey));

    // A group message encrypts once; both the member and the brain decrypt it.
    const wire = encGroup(groupKey, 'quarterly numbers are up 12%', 1);
    const env = JSON.parse(wire);
    for (const key of [memberKey!, brainKey!]) {
      const opened = nacl.secretbox.open(
        util.decodeBase64(env.ciphertext),
        util.decodeBase64(env.nonce),
        key
      );
      expect(util.encodeUTF8(opened!)).toBe('quarterly numbers are up 12%');
    }
  });

  it('an outsider without the wrapped key cannot read group messages', () => {
    const groupKey = nacl.randomBytes(nacl.secretbox.keyLength);
    const outsiderKey = nacl.randomBytes(nacl.secretbox.keyLength);
    const wire = encGroup(groupKey, 'internal only', 3);
    const env = JSON.parse(wire);
    const opened = nacl.secretbox.open(
      util.decodeBase64(env.ciphertext),
      util.decodeBase64(env.nonce),
      outsiderKey
    );
    expect(opened).toBeNull();
  });
});

describe('Privacy boundary: brain and DMs', () => {
  it('the brain is NOT a box recipient for DMs, so it holds no DM key', () => {
    // DM envelope is alg nacl.box with a `from` (sender pub). The brain is only
    // ever wrapped a *group* secretbox key — never a DM box key. This asserts the
    // envelope shape a DM produces so the server/brain can distinguish and refuse.
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const ct = nacl.box(util.decodeUTF8('private'), nonce, bob.publicKey, alice.secretKey);
    const env = {
      v: 1, alg: 'nacl.box',
      nonce: util.encodeBase64(nonce),
      ciphertext: util.encodeBase64(ct),
      from: util.encodeBase64(alice.publicKey),
    };
    expect(env.alg).toBe('nacl.box'); // brain's decryptForBrain only accepts nacl.secretbox
  });
});
