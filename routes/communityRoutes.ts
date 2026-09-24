import express from 'express';
import passport from 'passport';
import {
  getNetworks,
  getNetworkById,
  createNetwork,
  joinNetwork,
  leaveNetwork,
  getTrendingNetworks,
  getNetworkOfTheMonth,
  getCategories,
  getNetworkPosts,
  createNetworkPost,
  reactToNetworkPost,
  forwardNetworkPost,
  deleteNetworkPost,
} from '../controllers/communityController';

const router = express.Router();
router.use(passport.authenticate('jwt', { session: false }));

/**
 * @swagger
 * tags:
 *   name: Community
 *   description: Community networks, channels, and trending topics
 */

// ─── Categories ─────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/community/categories:
 *   get:
 *     summary: Get all distinct categories used across networks
 *     tags: [Community]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of category strings
 */
router.get('/categories', getCategories);

// ─── Trending & Month ────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/community/trending:
 *   get:
 *     summary: Get trending networks using weighted activity algorithm
 *     tags: [Community]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Sorted list of top 10 trending networks
 */
router.get('/trending', getTrendingNetworks);

/**
 * @swagger
 * /api/v1/community/month:
 *   get:
 *     summary: Get the Network of the Month (largest by member count)
 *     tags: [Community]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The featured network of the month
 */
router.get('/month', getNetworkOfTheMonth);

// ─── Networks ────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/community/networks:
 *   get:
 *     summary: Get all networks (supports search and category filter)
 *     tags: [Community]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Paginated networks list
 */
router.get('/networks', getNetworks);

/**
 * @swagger
 * /api/v1/community/networks:
 *   post:
 *     summary: Create a new network
 *     tags: [Community]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               title: { type: string }
 *               description: { type: string }
 *               image: { type: string }
 *               categories: { type: array, items: { type: string } }
 *               onlyCreatorCanPost: { type: boolean }
 *               isPrivate: { type: boolean }
 *     responses:
 *       201:
 *         description: Network created
 */
router.post('/networks', createNetwork);

/**
 * @swagger
 * /api/v1/community/networks/{id}:
 *   get:
 *     summary: Get a single network by ID
 *     tags: [Community]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Network details with members
 */
router.get('/networks/:id', getNetworkById);

/**
 * @swagger
 * /api/v1/community/networks/{id}/join:
 *   post:
 *     summary: Join a network
 *     tags: [Community]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Joined successfully
 */
router.post('/networks/:id/join', joinNetwork);

/**
 * @swagger
 * /api/v1/community/networks/{id}/leave:
 *   delete:
 *     summary: Leave a network
 *     tags: [Community]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Left successfully
 */
router.delete('/networks/:id/leave', leaveNetwork);

// ─── Network Posts ───────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/community/networks/{id}/posts:
 *   get:
 *     summary: Get all posts / updates for a network
 *     tags: [Community]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of posts
 */
router.get('/networks/:id/posts', getNetworkPosts);

/**
 * @swagger
 * /api/v1/community/networks/{id}/posts:
 *   post:
 *     summary: Create a post in a network (creator only if onlyCreatorCanPost)
 *     tags: [Community]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               content: { type: string }
 *               mediaUrl: { type: string }
 *               mediaType: { type: string, enum: [image, video, link, file] }
 *               linkUrl: { type: string }
 *     responses:
 *       201:
 *         description: Post created
 */
router.post('/networks/:id/posts', createNetworkPost);

/**
 * @swagger
 * /api/v1/community/networks/{networkId}/posts/{postId}/react:
 *   post:
 *     summary: React to a network post (toggle emoji)
 *     tags: [Community]
 *     security:
 *       - bearerAuth: []
 */
router.post('/networks/:networkId/posts/:postId/react', reactToNetworkPost);

/**
 * @swagger
 * /api/v1/community/networks/{networkId}/posts/{postId}/forward:
 *   post:
 *     summary: Forward a network post to another network
 *     tags: [Community]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               targetNetworkId: { type: string, description: "Leave empty to forward to same network" }
 */
router.post('/networks/:networkId/posts/:postId/forward', forwardNetworkPost);
router.delete('/networks/:networkId/posts/:postId', deleteNetworkPost);

export default router;
