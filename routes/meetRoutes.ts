import express from 'express';
import passport from 'passport';
import { getCallLogs, createCallLog, updateCallLog, clearCallLogs, deleteCallLog, getRoomTranscript, saveTranscriptChunk, getLiveKitToken, createInviteLink } from '../controllers/meetController';
import { getZegoToken } from '../utils/zego';

const router = express.Router();
router.use(passport.authenticate('jwt', { session: false }));

router.get('/livekit-token', getLiveKitToken);
router.post('/invite-link', createInviteLink);

/**
 * @swagger
 * tags:
 *   name: Meet
 *   description: Call logs for the Meet section
 */

/**
 * @swagger
 * /api/v1/meet/logs:
 *   get:
 *     summary: Get user's call logs
 *     tags: [Meet]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of call logs
 */
router.get('/logs', getCallLogs);
router.patch('/logs/:id', updateCallLog);

/**
 * @swagger
 * /api/v1/meet/logs:
 *   post:
 *     summary: Log a completed or missed call
 *     tags: [Meet]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [roomId, type]
 *             properties:
 *               roomId: { type: string }
 *               type: { type: string, enum: [voice, video] }
 *               label: { type: string }
 *               duration: { type: number }
 *               missed: { type: boolean }
 *     responses:
 *       201:
 *         description: Call log created
 */
router.post('/logs', createCallLog);

/**
 * @swagger
 * /api/v1/meet/logs:
 *   delete:
 *     summary: Clear all call logs for the current user
 *     tags: [Meet]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logs cleared
 */
router.delete('/logs', clearCallLogs);
router.delete('/logs/:id', deleteCallLog);
router.get('/logs/:roomId/transcript', getRoomTranscript);
router.post('/logs/:roomId/transcript/chunks', saveTranscriptChunk);
router.get('/token', (req, res) => {
    try {
        const userId = (req as any).user?._id?.toString();
        const roomId = req.query.roomId as string || '';
        const token = getZegoToken(userId, roomId, 3600);
        res.json({ token });
    } catch (err: any) {
        res.status(500).json({ message: err.message });
    }
});

export default router;
