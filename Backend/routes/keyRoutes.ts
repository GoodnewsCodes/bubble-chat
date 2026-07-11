import express from 'express';
import passport from 'passport';
import {
  registerDevice,
  listDevices,
  revokeDevice,
  getPreKeyBundle,
  rotateSignedPreKey,
  addOneTimePreKeys,
  getPreKeyCount,
  postSenderKeys,
  getSenderKeys,
  putBackup,
  getBackupMeta,
  restoreBackup,
} from '../controllers/keyController';

/**
 * Signal-protocol key directory (E2EE). The server stores only PUBLIC prekey
 * material, opaque sender-key blobs, and opaque encrypted backups — never a
 * private key or plaintext. All routes require a valid JWT.
 */
const router = express.Router();

router.use(passport.authenticate('jwt', { session: false }));

// Devices
router.post('/devices', registerDevice);
router.get('/devices/:userId', listDevices);
router.delete('/devices/:deviceId', revokeDevice);

// Prekeys
router.put('/signed-prekey', rotateSignedPreKey);
router.post('/one-time', addOneTimePreKeys);
router.get('/one-time/count', getPreKeyCount);

// Group sender keys
router.post('/sender-keys', postSenderKeys);
router.get('/sender-keys', getSenderKeys);

// Encrypted full-account backup (restore-on-re-login)
router.post('/backup', putBackup);
router.get('/backup', getBackupMeta);
router.post('/backup/restore', restoreBackup);

// Prekey bundle fetch. Registered LAST so the static routes above win over the
// dynamic `/:userId/bundle` pattern.
router.get('/:userId/bundle', getPreKeyBundle);

export default router;
