import express from 'express';
import passport from 'passport';
import { getCurrentSecurityCode } from '../controllers/securityController';

const router = express.Router();

// Protected: Only authenticated users can get the current weekly code
router.use(passport.authenticate('jwt', { session: false }));

/**
 * @swagger
 * /api/v1/security/current:
 *   get:
 *     tags: [Security]
 *     summary: Retrieve the current weekly security code
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current active security code and its metadata.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 code: { type: string, example: "88219" }
 *                 expiresAt: { type: string, format: date-time }
 *                 nextRotation: { type: string, format: date-time }
 *       401:
 *         description: Unauthorized. JWT required if user is not on premium plan.
 */
router.get('/current', getCurrentSecurityCode);

export default router;
