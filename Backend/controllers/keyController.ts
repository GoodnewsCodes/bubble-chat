import { Request, Response } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { Device } from '../models/device';
import { OneTimePreKey } from '../models/preKeyBundle';
import { SenderKeyDistribution } from '../models/senderKeyDistribution';
import { KeyBackup } from '../models/keyBackup';

export interface AuthRequest extends Request {
  user?: any;
  io?: any;
}

/**
 * Signal-protocol key directory.
 *
 * The server is a blind relay: it stores ONLY public prekey material, opaque
 * sender-key distribution blobs, and opaque encrypted backups. It never sees a
 * private key or any plaintext. Every route here is JWT-authenticated (mounted
 * behind passport in keyRoutes).
 */

const MIN_ONE_TIME_PREKEYS = 10; // tell the client to replenish below this
const MAX_PREKEYS_PER_UPLOAD = 200;
const BACKUP_MAX_ATTEMPTS = 10;
const BACKUP_LOCK_MS = 15 * 60 * 1000;

// ─── Device registration ──────────────────────────────────────────────────────

/** POST /keys/devices — register (or re-register) THIS device's public keys. */
export const registerDevice = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user._id;
    const {
      deviceId, registrationId, identityKey,
      signedPreKey, kyberPreKey, oneTimePreKeys,
      name, platform,
    } = req.body || {};

    if (!deviceId || typeof registrationId !== 'number' || !identityKey ||
        !signedPreKey?.keyId || !signedPreKey?.publicKey || !signedPreKey?.signature) {
      res.status(400).json({ message: 'deviceId, registrationId, identityKey and a signed prekey are required' });
      return;
    }

    const device = await Device.findOneAndUpdate(
      { userId, deviceId },
      {
        userId,
        deviceId,
        registrationId,
        identityKey,
        signedPreKey: {
          keyId: signedPreKey.keyId,
          publicKey: signedPreKey.publicKey,
          signature: signedPreKey.signature,
          createdAt: new Date(),
        },
        ...(kyberPreKey?.keyId && kyberPreKey?.publicKey ? {
          kyberPreKey: {
            keyId: kyberPreKey.keyId,
            publicKey: kyberPreKey.publicKey,
            signature: kyberPreKey.signature,
            createdAt: new Date(),
          },
        } : {}),
        name: name || '',
        platform,
        lastSeenAt: new Date(),
        revokedAt: undefined,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Seed the one-time prekey pool. Re-register replaces the pool for this device.
    if (Array.isArray(oneTimePreKeys) && oneTimePreKeys.length) {
      await OneTimePreKey.deleteMany({ userId, deviceId });
      await insertOneTimePreKeys(userId, deviceId, oneTimePreKeys);
    }

    res.status(201).json({ message: 'Device registered', deviceId: device.deviceId });
  } catch (error: any) {
    if (error?.code === 11000) { res.status(409).json({ message: 'Device already registered' }); return; }
    res.status(500).json({ message: error.message });
  }
};

/** GET /keys/devices/:userId — list a user's active devices (public identity only). */
export const listDevices = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = String(req.params.userId);
    if (!mongoose.Types.ObjectId.isValid(userId)) { res.status(400).json({ message: 'Invalid userId' }); return; }
    const devices = await Device.find({ userId, revokedAt: { $exists: false } })
      .select('deviceId registrationId identityKey platform name isBrain lastSeenAt')
      .lean();
    res.status(200).json({ devices });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/** DELETE /keys/devices/:deviceId — revoke one of the CALLER's own devices. */
export const revokeDevice = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user._id;
    const { deviceId } = req.params;
    const device = await Device.findOneAndUpdate(
      { userId, deviceId },
      { revokedAt: new Date() },
      { new: true }
    );
    if (!device) { res.status(404).json({ message: 'Device not found' }); return; }
    await OneTimePreKey.deleteMany({ userId, deviceId });
    res.status(200).json({ message: 'Device revoked' });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Prekey bundles ───────────────────────────────────────────────────────────

/**
 * GET /keys/:userId/bundle[?deviceId=] — fetch prekey bundle(s) to start a
 * session. Consumes ONE one-time prekey per returned device (deleted so no two
 * sessions reuse it). Omitting deviceId returns a bundle for EVERY device of the
 * user (multi-device fan-out). Bundles are public — any authenticated user may
 * fetch another user's bundle to message them (incl. unknown/unsaved contacts).
 */
export const getPreKeyBundle = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = String(req.params.userId);
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
    if (!mongoose.Types.ObjectId.isValid(userId)) { res.status(400).json({ message: 'Invalid userId' }); return; }

    const query: any = { userId, revokedAt: { $exists: false } };
    if (deviceId) query.deviceId = deviceId;
    const devices = await Device.find(query).lean();
    if (!devices.length) { res.status(404).json({ message: 'No devices for user' }); return; }

    const bundles = [];
    for (const d of devices) {
      // Atomically pop the oldest one-time prekey; fall back to signed-only.
      const otp = await OneTimePreKey.findOneAndDelete(
        { userId, deviceId: d.deviceId },
        { sort: { createdAt: 1 } }
      ).lean();
      bundles.push({
        deviceId: d.deviceId,
        registrationId: d.registrationId,
        identityKey: d.identityKey,
        signedPreKey: d.signedPreKey,
        kyberPreKey: d.kyberPreKey || null,
        oneTimePreKey: otp ? { keyId: otp.keyId, publicKey: otp.publicKey } : null,
      });
    }

    res.status(200).json({ bundles });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/** PUT /keys/signed-prekey — rotate the CALLER device's signed (and Kyber) prekey. */
export const rotateSignedPreKey = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user._id;
    const { deviceId, signedPreKey, kyberPreKey } = req.body || {};
    if (!deviceId || !signedPreKey?.keyId || !signedPreKey?.publicKey || !signedPreKey?.signature) {
      res.status(400).json({ message: 'deviceId and a signed prekey are required' });
      return;
    }
    const update: any = {
      signedPreKey: { keyId: signedPreKey.keyId, publicKey: signedPreKey.publicKey, signature: signedPreKey.signature, createdAt: new Date() },
    };
    if (kyberPreKey?.keyId && kyberPreKey?.publicKey) {
      update.kyberPreKey = { keyId: kyberPreKey.keyId, publicKey: kyberPreKey.publicKey, signature: kyberPreKey.signature, createdAt: new Date() };
    }
    const device = await Device.findOneAndUpdate({ userId, deviceId }, update, { new: true });
    if (!device) { res.status(404).json({ message: 'Device not found' }); return; }
    res.status(200).json({ message: 'Signed prekey rotated' });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/** POST /keys/one-time — replenish the CALLER device's one-time prekey pool. */
export const addOneTimePreKeys = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user._id;
    const { deviceId, oneTimePreKeys } = req.body || {};
    if (!deviceId || !Array.isArray(oneTimePreKeys) || oneTimePreKeys.length === 0) {
      res.status(400).json({ message: 'deviceId and non-empty oneTimePreKeys[] are required' });
      return;
    }
    if (oneTimePreKeys.length > MAX_PREKEYS_PER_UPLOAD) {
      res.status(400).json({ message: `At most ${MAX_PREKEYS_PER_UPLOAD} prekeys per upload` });
      return;
    }
    const inserted = await insertOneTimePreKeys(userId, deviceId, oneTimePreKeys);
    res.status(201).json({ message: 'Prekeys stored', inserted });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/** GET /keys/one-time/count?deviceId= — remaining pool size (client tops up when low). */
export const getPreKeyCount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user._id;
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
    if (!deviceId) { res.status(400).json({ message: 'deviceId is required' }); return; }
    const count = await OneTimePreKey.countDocuments({ userId, deviceId });
    res.status(200).json({ count, low: count < MIN_ONE_TIME_PREKEYS });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Group sender keys ─────────────────────────────────────────────────────────

/**
 * POST /keys/sender-keys — publish sender-key distribution blobs to recipient
 * devices for a group. Each blob is opaque (pairwise-encrypted); the server just
 * routes it. Idempotent per (conversation, epoch, senderDevice, recipientDevice).
 */
export const postSenderKeys = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user._id;
    const { conversationId, epoch, senderDeviceId, distributions } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(String(conversationId)) || !Number.isInteger(epoch) ||
        !senderDeviceId || !Array.isArray(distributions) || distributions.length === 0) {
      res.status(400).json({ message: 'conversationId, integer epoch, senderDeviceId and distributions[] are required' });
      return;
    }
    if (distributions.length > 2000) { res.status(400).json({ message: 'Too many distributions' }); return; }

    const ops = distributions.map((d: any) => ({
      updateOne: {
        filter: {
          conversationId, epoch, senderDeviceId,
          recipientDeviceId: d.recipientDeviceId,
        },
        update: {
          $set: {
            conversationId, epoch,
            senderUserId: userId, senderDeviceId,
            recipientUserId: d.recipientUserId,
            recipientDeviceId: d.recipientDeviceId,
            ciphertext: d.ciphertext,
          },
        },
        upsert: true,
      },
    }));
    await SenderKeyDistribution.bulkWrite(ops as any[], { ordered: false });
    res.status(201).json({ message: 'Sender keys distributed', count: ops.length });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * GET /keys/sender-keys?deviceId= — pull (and consume) sender-key distributions
 * addressed to the CALLER's device. Once fetched, the client stores the sender
 * key locally, so we delete the delivered rows (consume-on-read).
 */
export const getSenderKeys = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user._id;
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
    if (!deviceId) { res.status(400).json({ message: 'deviceId is required' }); return; }

    const rows = await SenderKeyDistribution.find({ recipientUserId: userId, recipientDeviceId: deviceId })
      .sort({ createdAt: 1 })
      .lean();
    if (rows.length) {
      await SenderKeyDistribution.deleteMany({ _id: { $in: rows.map((r) => r._id) } });
    }
    res.status(200).json({
      distributions: rows.map((r) => ({
        conversationId: String(r.conversationId),
        epoch: r.epoch,
        senderUserId: String(r.senderUserId),
        senderDeviceId: r.senderDeviceId,
        ciphertext: r.ciphertext,
      })),
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Encrypted full-account backup (SVR-style) ─────────────────────────────────

/** POST /keys/backup — store/replace the CALLER's encrypted backup. */
export const putBackup = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user._id;
    const { blob, blobUrl, version, sizeBytes, kdfParams, svrVerifier } = req.body || {};
    if ((!blob && !blobUrl) || !kdfParams?.salt || !svrVerifier) {
      res.status(400).json({ message: 'A blob (or blobUrl), kdfParams.salt and svrVerifier are required' });
      return;
    }
    await KeyBackup.findOneAndUpdate(
      { userId },
      {
        userId,
        ...(blobUrl ? { blobUrl, blob: undefined } : { blob, blobUrl: undefined }),
        version: Number.isInteger(version) ? version : 1,
        sizeBytes,
        kdfParams,
        svrVerifier,
        attemptCount: 0,      // a fresh backup resets brute-force state
        lockedUntil: undefined,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.status(201).json({ message: 'Backup stored', version });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/** GET /keys/backup — metadata only (kdfParams + version); never returns the blob. */
export const getBackupMeta = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user._id;
    const backup = await KeyBackup.findOne({ userId }).lean();
    if (!backup) { res.status(404).json({ message: 'No backup found' }); return; }
    res.status(200).json({
      exists: true,
      version: backup.version,
      sizeBytes: backup.sizeBytes,
      kdfParams: backup.kdfParams,
      updatedAt: backup.updatedAt,
      locked: !!(backup.lockedUntil && backup.lockedUntil > new Date()),
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * POST /keys/backup/restore — verify a PIN attempt and, on success, return the
 * encrypted blob for the CALLER to decrypt locally (this powers "log in on a new
 * device → everything comes back"). The `verifier` is derived client-side from
 * the recovery PIN; the server compares it in constant time and rate-limits
 * failures so the backup can't be brute-forced. A wrong PIN reveals nothing.
 */
export const restoreBackup = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user._id;
    const { verifier } = req.body || {};
    if (!verifier) { res.status(400).json({ message: 'verifier is required' }); return; }

    const backup = await KeyBackup.findOne({ userId }).select('+blob');
    if (!backup) { res.status(404).json({ message: 'No backup found' }); return; }

    if (backup.lockedUntil && backup.lockedUntil > new Date()) {
      res.status(429).json({ message: 'Backup temporarily locked after too many attempts', lockedUntil: backup.lockedUntil });
      return;
    }

    const ok = timingSafeEqualStr(String(verifier), backup.svrVerifier);
    if (!ok) {
      backup.attemptCount = (backup.attemptCount || 0) + 1;
      if (backup.attemptCount >= BACKUP_MAX_ATTEMPTS) {
        backup.lockedUntil = new Date(Date.now() + BACKUP_LOCK_MS);
        backup.attemptCount = 0;
      }
      await backup.save();
      res.status(401).json({ message: 'Incorrect recovery PIN', attemptsLeft: Math.max(0, BACKUP_MAX_ATTEMPTS - backup.attemptCount) });
      return;
    }

    backup.attemptCount = 0;
    backup.lockedUntil = undefined;
    await backup.save();

    res.status(200).json({
      version: backup.version,
      kdfParams: backup.kdfParams,
      ...(backup.blobUrl ? { blobUrl: backup.blobUrl } : { blob: backup.blob }),
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

// ─── helpers ───────────────────────────────────────────────────────────────────

async function insertOneTimePreKeys(
  userId: any,
  deviceId: string,
  prekeys: { keyId: number; publicKey: string }[]
): Promise<number> {
  const docs = prekeys
    .filter((p) => Number.isInteger(p?.keyId) && typeof p?.publicKey === 'string')
    .map((p) => ({ userId, deviceId, keyId: p.keyId, publicKey: p.publicKey }));
  if (!docs.length) return 0;
  try {
    // ordered:false so a duplicate keyId doesn't abort the rest.
    const r = await OneTimePreKey.insertMany(docs, { ordered: false });
    return r.length;
  } catch (err: any) {
    // Partial success on duplicate-key errors is fine — count what went in.
    return err?.result?.nInserted ?? err?.insertedDocs?.length ?? 0;
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
