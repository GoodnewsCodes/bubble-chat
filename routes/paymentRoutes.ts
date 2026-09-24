import express from 'express';
import { createCheckoutSession, stripeWebhook, getTransactions, withdrawFunds, depositFunds, createGoal, getGoals, contributeToGoal } from '../controllers/paymentController';
import { createInvoice, getInvoices, getInvoiceById, updateInvoice, deleteInvoice } from '../controllers/invoiceController';
import passport from 'passport';

const router = express.Router();

router.post('/create-checkout-session', express.json(), createCheckoutSession);
router.post('/webhook', express.raw({ type: 'application/json' }), stripeWebhook);

const requireAuth = passport.authenticate('jwt', { session: false });

// Ledger endpoints
router.get('/transactions', requireAuth, getTransactions);
router.post('/withdraw',    requireAuth, withdrawFunds);
router.post('/deposit',     requireAuth, depositFunds);

// Goals endpoints
router.post('/goals',           requireAuth, createGoal);
router.get('/goals',            requireAuth, getGoals);
router.post('/goals/contribute',requireAuth, contributeToGoal);

// Invoice endpoints
router.post('/invoice',         requireAuth, createInvoice);
router.get('/invoices',         requireAuth, getInvoices);
router.get('/invoice/:id',      requireAuth, getInvoiceById);
router.put('/invoice/:id',      requireAuth, updateInvoice);
router.delete('/invoice/:id',   requireAuth, deleteInvoice);

export default router;

