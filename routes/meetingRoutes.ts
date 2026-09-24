import express from 'express';
import {
  createMeeting,
  getMeetings,
  getActiveMeetings,
  getMeetingById,
  addTranscriptChunk,
  endMeeting,
  getMeetingActionItems,
  logSharedFile,
  getMeetingFiles,
  startScreenShare,
  endScreenShare,
  getMeetingStatsWithUser,
  transcribeUpload,
  downloadTranscriptMarkdown,
  emailTranscriptOnDemand,
} from '../controllers/meetingController';
import passport from 'passport';
import { handleUpload } from '../middleware/upload';

const router = express.Router();
const requireAuth = passport.authenticate('jwt', { session: false });

router.use(requireAuth);

// ── Core meeting CRUD ────────────────────────────────────────────────────────
router.post('/', createMeeting);
router.get('/', getMeetings);
router.get('/active', getActiveMeetings);
router.get('/stats/:withUserId', getMeetingStatsWithUser);
router.get('/:id', getMeetingById);

// ── Transcript (background real-time accumulation) ───────────────────────────
router.post('/:id/transcript', addTranscriptChunk);
router.post('/:id/transcribe-upload', handleUpload.single('audio'), transcribeUpload);
router.get('/:id/transcript.md', downloadTranscriptMarkdown);
router.post('/:id/email-transcript', emailTranscriptOnDemand);

// ── Meeting lifecycle ────────────────────────────────────────────────────────
router.post('/:id/end', endMeeting);

// ── Action items (AI-extracted, available after meeting ends) ────────────────
router.get('/:id/action-items', getMeetingActionItems);

// ── File sharing ─────────────────────────────────────────────────────────────
// POST  /api/v1/meetings/:id/files   — log a file/link shared in the meeting
// GET   /api/v1/meetings/:id/files   — retrieve all files shared in a meeting
router.post('/:id/files', logSharedFile);
router.get('/:id/files', getMeetingFiles);

// ── Screen / tab sharing sessions ────────────────────────────────────────────
// POST  /api/v1/meetings/:id/screen-share/start             — record start
// PATCH /api/v1/meetings/:id/screen-share/:sessionId/end    — record end
router.post('/:id/screen-share/start', startScreenShare);
router.patch('/:id/screen-share/:sessionId/end', endScreenShare);

export default router;
