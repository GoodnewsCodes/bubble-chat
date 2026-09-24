import express from 'express';
import passport from 'passport';
import {
  createEvent,
  getEvents,
  getEvent,
  updateEvent,
  deleteEvent,
  startMeeting,
  endMeeting,
  bulkImportHolidays,
  getEventSuggestions,
} from '../controllers/calendarController';
import {
  detectAndNotifyPatterns,
  confirmPattern,
  dismissPattern,
  getPendingPatterns,
} from '../controllers/recurringPatternController';

const router = express.Router();
const requireAuth = passport.authenticate('jwt', { session: false });

// All calendar routes require authentication
router.use(requireAuth);

/**
 * Smart suggestions for event creation (title, participants, agenda, conflicts)
 * GET /api/v1/events/suggest?query=...&startTime=...
 */
router.get('/suggest', getEventSuggestions);

/**
 * Bulk import public holidays (admin only)
 * POST /api/v1/events/holidays/bulk
 * Body: { holidays: [{ name, date, country? }] }
 */
router.post('/holidays/bulk', bulkImportHolidays);

/**
 * Create a new calendar event
 * POST /api/v1/events/create
 */
router.post('/create', createEvent);

/**
 * List events for the org (with date range, type, mine filters)
 * GET /api/v1/events?start=...&end=...&type=...&mine=true
 */
router.get('/', getEvents);

/**
 * Get single event detail with brain-linked documents
 * GET /api/v1/events/:id
 */
router.get('/:id', getEvent);

/**
 * Update an event
 * PUT /api/v1/events/:id
 */
router.put('/:id', updateEvent);

/**
 * Cancel an event (soft delete)
 * DELETE /api/v1/events/:id
 */
router.delete('/:id', deleteEvent);

/**
 * Start a meeting — creates/returns LiveKit room, sets event status to 'live'
 * POST /api/v1/events/:id/start-meeting
 */
router.post('/:id/start-meeting', startMeeting);

/**
 * End a meeting — accepts transcript, triggers DeepSeek enrichment + brain ingest
 * POST /api/v1/events/:id/end-meeting
 * Body: { transcriptText?, transcriptChunks? }
 */
router.post('/:id/end-meeting', endMeeting);

/**
 * Recurring pattern detection + notification
 * POST /api/v1/events/patterns/detect  — run detection for current user
 * GET  /api/v1/events/patterns/pending — get unacted-on patterns (for in-app banner)
 * POST /api/v1/events/patterns/:id/confirm
 * POST /api/v1/events/patterns/:id/dismiss
 */
router.post('/patterns/detect', detectAndNotifyPatterns);
router.get('/patterns/pending', getPendingPatterns);
router.post('/patterns/:id/confirm', confirmPattern);
router.post('/patterns/:id/dismiss', dismissPattern);

export default router;
