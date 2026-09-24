import express from 'express';
import multer from 'multer';
import {
  ingestDocument,
  ingestDocumentFromUrl,
  ingestDocumentFromFile,
  listDocuments,
  deleteDocument,
  joinOrganizationByInvite,
  onboardOrgBrain,
  getOrgInviteCode,
  updateOrgProfile,
  getOrgMembers,
  getOrgTranscripts
} from '../controllers/orgController';
import passport from 'passport';

const router = express.Router();
const requireAuth = passport.authenticate('jwt', { session: false });

// In-memory multipart parser for brain-document uploads (PDF/txt up to ~20 MB).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// Org knowledge base
router.post('/documents', requireAuth, ingestDocument);
router.post('/documents/from-url', requireAuth, ingestDocumentFromUrl);
router.post('/documents/from-file', requireAuth, upload.single('file'), ingestDocumentFromFile);
router.get('/documents', requireAuth, listDocuments);
router.delete('/documents/:id', requireAuth, deleteDocument);
router.post('/join', requireAuth, joinOrganizationByInvite);
router.post('/brain/onboard', requireAuth, onboardOrgBrain);
router.get('/invite-code', requireAuth, getOrgInviteCode);
router.put('/profile', requireAuth, updateOrgProfile);
router.get('/members', requireAuth, getOrgMembers);
router.get('/transcripts', requireAuth, getOrgTranscripts);

export default router;
