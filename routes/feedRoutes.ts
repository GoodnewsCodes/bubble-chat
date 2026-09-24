import express from 'express';
import passport from 'passport';
import multer from 'multer';
import {
  getFeedPosts,
  getTrendingPosts,
  getFollowingFeed,
  getSuggestedUsers,
  createPost,
  toggleLike,
  toggleRepost,
  toggleSave,
  getSavedPosts,
  addComment,
  deletePost,
} from '../controllers/feedController';

const router = express.Router();
router.use(passport.authenticate('jwt', { session: false }));
const upload = multer({ storage: multer.memoryStorage() });

/** GET /api/v1/feed — paginated feed */
router.get('/', getFeedPosts);

/** GET /api/v1/feed/trending — trending posts by engagement */
router.get('/trending', getTrendingPosts);

/** GET /api/v1/feed/following — posts from users you follow */
router.get('/following', getFollowingFeed);

/** GET /api/v1/feed/suggestions — suggested users to follow */
router.get('/suggestions', getSuggestedUsers);

/** GET /api/v1/feed/saved — posts saved by the authenticated user */
router.get('/saved', getSavedPosts);

/** POST /api/v1/feed — create post (with optional media) */
router.post('/', upload.single('file'), createPost);

/** POST /api/v1/feed/:id/like — toggle like */
router.post('/:id/like', toggleLike);

/** POST /api/v1/feed/:id/repost — toggle repost */
router.post('/:id/repost', toggleRepost);

/** POST /api/v1/feed/:id/save — toggle save/bookmark */
router.post('/:id/save', toggleSave);

/** POST /api/v1/feed/:id/comment — add comment */
router.post('/:id/comment', addComment);

/** DELETE /api/v1/feed/:id — delete post (author only) */
router.delete('/:id', deletePost);

export default router;
