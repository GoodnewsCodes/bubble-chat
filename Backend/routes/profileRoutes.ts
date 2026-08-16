import express from 'express';
import passport from 'passport';
import multer from 'multer';
import {
  getMyProfile,
  getPublicProfile,
  updateProfile,
  uploadAvatar,
  followUser,
  getFollowers,
  getFollowing,
  deleteAccount,
  setupProfile,
  uploadBackground,
  saveBackup,
  getBackup,
  getAllAvatars,
} from '../controllers/profileController';

const router = express.Router();
const jwtAuth = passport.authenticate('jwt', { session: false });

// Multer — store file in memory buffer for Filebase upload
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB cap enforced here too
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      const err: any = new Error('Invalid file type. Allowed: jpeg, png, webp, gif, avif, heic.');
      err.status = 400;
      cb(err);
    }
  },
});

/**
 * @swagger
 * /api/v1/profile/me:
 *   get:
 *     tags: [Profile]
 *     summary: Get the authenticated user's full profile
 *     description: Returns complete profile including private fields, profile completeness score, followers, following, and contacts.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profile retrieved.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     full_name: { type: string }
 *                     username: { type: string }
 *                     email: { type: string }
 *                     avatar: { type: string }
 *                     bio: { type: string }
 *                     isOnline: { type: boolean }
 *                     followersCount: { type: number }
 *                     followingCount: { type: number }
 *                     postsCount: { type: number }
 *                     profile_completeness:
 *                       type: object
 *                       properties:
 *                         percentage: { type: number }
 *                         completed: { type: number }
 *                         total: { type: number }
 *                         checks:
 *                           type: object
 *                           properties:
 *                             has_avatar: { type: boolean }
 *                             has_bio: { type: boolean }
 *                             has_username: { type: boolean }
 *                             has_full_name: { type: boolean }
 *                             has_phone: { type: boolean }
 *                             has_location: { type: boolean }
 *                             has_gender: { type: boolean }
 *                             has_date_of_birth: { type: boolean }
 *                             has_hobbies: { type: boolean }
 *                             has_status_message: { type: boolean }
 *                             has_links: { type: boolean }
 */
router.get('/me', jwtAuth, getMyProfile);

// Onboarding setup — called once after OTP verification
router.patch('/setup', jwtAuth, setupProfile);

/**
 * @swagger
 * /api/v1/profile/me:
 *   put:
 *     tags: [Profile]
 *     summary: Update the authenticated user's profile
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               full_name: { type: string }
 *               username: { type: string }
 *               bio: { type: string }
 *               blog: { type: string }
 *               links: { type: array, items: { type: string } }
 *               status_message: { type: string }
 *               mood_emoji: { type: string }
 *               gender: { type: string, enum: [male, female, other, prefer_not_to_say] }
 *               date_of_birth: { type: string, format: date }
 *               hobbies: { type: array, items: { type: string } }
 *               location:
 *                 type: object
 *                 properties:
 *                   city: { type: string }
 *                   country: { type: string }
 *                   timezone: { type: string }
 *               notification_settings:
 *                 type: object
 *                 properties:
 *                   muted: { type: boolean }
 *                   preview: { type: boolean }
 *                   sounds: { type: boolean }
 *                   ai_suggestions_enabled: { type: boolean }
 *               privacy_settings:
 *                 type: object
 *                 properties:
 *                   profile_photo: { type: string, enum: [everyone, contacts, nobody] }
 *                   last_seen: { type: string, enum: [everyone, contacts, nobody] }
 *                   read_receipts: { type: boolean }
 *     responses:
 *       200:
 *         description: Profile updated.
 *       409:
 *         description: Username already taken.
 */
router.put('/me', jwtAuth, updateProfile);

/**
 * @swagger
 * /api/v1/profile/me:
 *   delete:
 *     tags: [Profile]
 *     summary: Permanently delete the authenticated user's account
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Account deleted.
 */
router.delete('/me', jwtAuth, deleteAccount);

/**
 * @swagger
 * /api/v1/profile/avatar:
 *   post:
 *     tags: [Profile]
 *     summary: Upload or replace profile avatar
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Image file (jpeg, png, webp, gif — max 5MB)
 *     responses:
 *       200:
 *         description: Avatar uploaded successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   properties:
 *                     avatarUrl: { type: string }
 *                     user: { $ref: '#/components/schemas/User' }
 *       400:
 *         description: No file provided or invalid type/size.
 */
router.post('/avatar', jwtAuth, upload.single('file'), uploadAvatar);
router.post('/background', jwtAuth, upload.single('file'), uploadBackground);

router.post('/backup', jwtAuth, saveBackup);
router.get('/backup', jwtAuth, getBackup);
router.get('/avatars', jwtAuth, getAllAvatars);

/**
 * @swagger
 * /api/v1/profile/follow/{userId}:
 *   post:
 *     tags: [Profile]
 *     summary: Follow or unfollow a user (toggle)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Follow toggled.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 following: { type: boolean }
 */
router.post('/follow/:userId', jwtAuth, followUser);

/**
 * @swagger
 * /api/v1/profile/{userId}/followers:
 *   get:
 *     tags: [Profile]
 *     summary: Get a user's followers list
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Followers list.
 */
router.get('/:userId/followers', getFollowers);

/**
 * @swagger
 * /api/v1/profile/{userId}/following:
 *   get:
 *     tags: [Profile]
 *     summary: Get a user's following list
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Following list.
 */
router.get('/:userId/following', getFollowing);

/**
 * @swagger
 * /api/v1/profile/{identifier}:
 *   get:
 *     tags: [Profile]
 *     summary: Get a public profile by userId, username, or BubbleID
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema: { type: string }
 *         description: User's ObjectId, username, or uniqueTag (e.g. bubble-A3F9X7K2)
 *     responses:
 *       200:
 *         description: Public profile data.
 */
router.get('/:identifier', getPublicProfile);

export default router;



// import express from 'express';
// import passport from 'passport';
// import multer from 'multer';
// import { getProfile, updateProfile, uploadAvatar } from '../controllers/profileController';

// const router = express.Router();
// const jwtAuth = passport.authenticate('jwt', { session: false });

// // Multer memory storage for parsing FormData files
// const upload = multer({
//   storage: multer.memoryStorage(),
//   limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
// });

// /**
//  * @swagger
//  * /api/v1/profile:
//  *   get:
//  *     tags: [Profile]
//  *     summary: Get the current user's profile
//  *     security:
//  *       - bearerAuth: []
//  *     responses:
//  *       200:
//  *         description: Profile retrieved successfully.
//  */
// router.get('/', jwtAuth, getProfile);

// /**
//  * @swagger
//  * /api/v1/profile:
//  *   put:
//  *     tags: [Profile]
//  *     summary: Update the current user's profile details
//  *     security:
//  *       - bearerAuth: []
//  *     requestBody:
//  *       required: true
//  *       content:
//  *         application/json:
//  *           schema:
//  *             type: object
//  *             properties:
//  *               full_name: { type: string }
//  *               bio: { type: string }
//  *               blog: { type: string }
//  *               status_message: { type: string }
//  *               mood_emoji: { type: string }
//  *               gender: { type: string, enum: [male, female, other, prefer_not_to_say] }
//  *               date_of_birth: { type: string, format: date }
//  *               hobbies: { type: array, items: { type: string } }
//  *               location: { type: object }
//  *     responses:
//  *       200:
//  *         description: Profile updated successfully.
//  */
// router.put('/', jwtAuth, updateProfile);

// /**
//  * @swagger
//  * /api/v1/profile/avatar:
//  *   post:
//  *     tags: [Profile]
//  *     summary: Upload a new profile avatar directly to Filebase S3
//  *     security:
//  *       - bearerAuth: []
//  *     requestBody:
//  *       required: true
//  *       content:
//  *         multipart/form-data:
//  *           schema:
//  *             type: object
//  *             properties:
//  *               file:
//  *                 type: string
//  *                 format: binary
//  *     responses:
//  *       200:
//  *         description: Avatar uploaded successfully.
//  */
// router.post('/avatar', jwtAuth, upload.single('file'), uploadAvatar);

// export default router;
