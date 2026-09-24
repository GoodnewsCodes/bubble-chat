import express from 'express';
import { checkHealth, checkHealthDetailed } from '../controllers/healthController';

const router = express.Router();

/**
 * @swagger
 * /api/v1/health:
 *   get:
 *     tags: [Health]
 *     summary: Basic System Health Check
 *     description: Returns the health status of the API service
 *     responses:
 *       200:
 *         description: API is healthy
 */
router.get('/', checkHealth);

/**
 * @swagger
 * /api/v1/health/detailed:
 *   get:
 *     tags: [Health]
 *     summary: Detailed System Health Check
 *     description: Returns the health status of the API including Database and Cache connection status
 *     responses:
 *       200:
 *         description: All services are healthy
 *       503:
 *         description: One or more services are degraded
 */
router.get('/detailed', checkHealthDetailed);

export default router;
