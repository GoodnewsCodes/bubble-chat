import express from 'express';
import {
  chatWithAida,
  getDailyBriefing,
  getFinancialAdvice,
  extractActionItems,
  searchWorkspace,
  scheduleSuggestion,
  summarizeFeed,
  flagPayments,
  aidaScheduleTask,
  getAidaConversation,
  chatWithAidaInConversation,
  summarizeConversation,
  getConversationContext,
  getAidaWritingSuggestions,
  aidaDraft,
  // Org Knowledge Base (RAG)
  listOrgDocs,
  getOrgDoc,
  createOrgDoc,
  updateOrgDoc,
  deleteOrgDoc,
  requireAidaKey,
} from '../controllers/aidaController';
import passport from 'passport';

const router = express.Router();
const requireAuth = passport.authenticate('jwt', { session: false });

// ── Aida as Chat Contact ─────────────────────────────────────────────────────
router.get('/conversation', requireAuth, getAidaConversation);
router.post('/chat-message', requireAuth, requireAidaKey, chatWithAidaInConversation);
router.get('/conversation-summary/:id', requireAuth, requireAidaKey, summarizeConversation);
// POST variant lets clients pass decrypted recentContext for E2EE DMs.
router.post('/conversation-summary/:id', requireAuth, requireAidaKey, summarizeConversation);
router.get('/conversation-context/:conversationId', requireAuth, requireAidaKey, getConversationContext);

// ── Core conversational endpoints (AidaPage) ─────────────────────────────────
router.post('/chat', requireAuth, requireAidaKey, chatWithAida);
router.post('/writing-suggestions', requireAuth, requireAidaKey, getAidaWritingSuggestions);
router.post('/draft', requireAuth, requireAidaKey, aidaDraft);
router.get('/daily-briefing', requireAuth, requireAidaKey, getDailyBriefing);
router.get('/financial-advice', requireAuth, requireAidaKey, getFinancialAdvice);

// ── Agentic action endpoints ──────────────────────────────────────────────────
router.post('/extract-action-items', requireAuth, extractActionItems);
router.post('/search-workspace', requireAuth, searchWorkspace);
router.post('/schedule-suggestion', requireAuth, scheduleSuggestion);
router.post('/schedule-task', requireAuth, aidaScheduleTask);
router.post('/summarize-feed', requireAuth, summarizeFeed);
router.get('/flag-payments', requireAuth, flagPayments);

// ── Org Knowledge Base (RAG Documents) ───────────────────────────────────────
router.get('/org-docs', requireAuth, listOrgDocs);
router.get('/org-docs/:id', requireAuth, getOrgDoc);
router.post('/org-docs', requireAuth, createOrgDoc);
router.patch('/org-docs/:id', requireAuth, updateOrgDoc);
router.delete('/org-docs/:id', requireAuth, deleteOrgDoc);

export default router;
