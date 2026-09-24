import express from 'express';
import passport from 'passport';
import { ingest, getJobStatus } from '../controllers/brainController';
import { getOnboardingBrief, searchBrain, routeQuestion, resolveQAExchange } from '../controllers/continuityController';
import { getDailyDigest, getDigestHistory, getExpertiseRadar } from '../controllers/digestController';
import { handleUpload } from '../middleware/upload';

const router = express.Router();
const requireAuth = passport.authenticate('jwt', { session: false });

// Apply JWT authentication requirement for all brain endpoints
router.use(requireAuth);

/**
 * Universal Ingestion Route
 * Handles files, URLs, text blocks, chats, YouTube links, Slack exports.
 * Returns job payload immediately (async background processing).
 * POST /api/v1/brain/ingest
 */
router.post('/ingest', handleUpload.single('file'), ingest);

/**
 * Polling route to track ingestion job status
 * GET /api/v1/brain/jobs/:id
 */
router.get('/jobs/:id', getJobStatus);

/**
 * Knowledge Continuity: Get personalized onboarding brief (structured)
 * GET /api/v1/brain/brief
 */
router.get('/brief', getOnboardingBrief);

/**
 * Semantic search over the org brain with expert routing fallback
 * GET /api/v1/brain/search?query=...
 */
router.get('/search', searchBrain);

/**
 * DM / Group routing pre-fill helper for low-confidence queries
 * POST /api/v1/brain/route-question
 */
router.post('/route-question', routeQuestion);

/**
 * Closed-loop: index a completed Q&A exchange into the brain
 * POST /api/v1/brain/qa/resolve
 */
router.post('/qa/resolve', resolveQAExchange);

/**
 * Daily digest — today's AI-synthesized morning brief for the current user
 * GET /api/v1/brain/digest?date=YYYY-MM-DD
 */
router.get('/digest', getDailyDigest);

/**
 * Digest history — last N days of morning briefs
 * GET /api/v1/brain/digest/history?days=7
 */
router.get('/digest/history', getDigestHistory);

/**
 * Expertise radar — org-wide topic-expert leaderboard
 * GET /api/v1/brain/expertise?topic=...
 */
router.get('/expertise', getExpertiseRadar);

export default router;
