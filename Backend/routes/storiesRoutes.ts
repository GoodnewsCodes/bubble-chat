import express from 'express';
import passport from 'passport';
import { uploadStory, fetchStories, proxyStoryMedia } from '../controllers/storiesController';
import { handleUpload } from '../middleware/upload';

const router = express.Router();

// Public proxy for story media (no JWT — browser img/audio/video src tags need this)
router.get('/media/proxy', proxyStoryMedia);

router.use(passport.authenticate('jwt', { session: false }));

/**
 * @swagger
 * /api/v1/story:
 *   post:
 *     tags: [Stories]
 *     summary: Upload a new story (image, video, audio, or text)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               textContent:
 *                 type: string
 *               bg_gradient:
 *                 type: string
 *               text_color:
 *                 type: string
 *               font_size:
 *                 type: integer
 *               is_close_friends_only:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Story uploaded successfully.
 */
router.route('/').post(
  handleUpload.single('file'), 
  uploadStory
);

/**
 * @swagger
 * /api/v1/story:
 *   get:
 *     tags: [Stories]
 *     summary: Get all active stories
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of active signals/stories.
 */
router.route('/').get(fetchStories);


export default router;
