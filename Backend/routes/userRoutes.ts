import express from 'express';
import passport from 'passport';
import {
  getUserProfile,
  searchUsers,
  getOnlineScannedUsers,
  getUserStatus,
  toggleBlockUser,
  reportUser,
  getSuggestions,
  toggleFollowUser,
  getUserFollowers,
  getUserFollowing,
  getContacts,
  getMyContacts,
  addContact,
  removeContact,
  getContactNicknames,
  setContactNickname,
} from '../controllers/userController';

const router = express.Router();

router.use(passport.authenticate('jwt', { session: false }));

/**
 * @swagger
 * /api/v1/user/search:
 *   get:
 *     tags: [Users]
 *     summary: Search users by name, username, email, or uniqueTag
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of matching users.
 */
// NOTE: Specific named routes must come BEFORE /:userId to prevent collision
router.route('/suggestions').get(getSuggestions);
router.route('/search').get(searchUsers);

/**
 * @swagger
 * /api/v1/user/online-scanner:
 *   get:
 *     tags: [Users]
 *     summary: Get all currently online users
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of online users.
 */
router.route('/online-scanner').get(getOnlineScannedUsers);

/**
 * @swagger
 * /api/v1/user/status/{userId}:
 *   get:
 *     tags: [Users]
 *     summary: Get a user's online/offline status
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User status.
 */
router.route('/status/:userId').get(getUserStatus);

/**
 * @swagger
 * /api/v1/user/{userId}:
 *   get:
 *     tags: [Users]
 *     summary: Get a user's full public profile
 *     description: Returns bio, avatar, role, uniqueTag, online status and more. Used by the right panel in the chat UI.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Full user profile.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 user:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     full_name: { type: string }
 *                     username: { type: string }
 *                     email: { type: string }
 *                     phone: { type: string }
 *                     avatar: { type: string }
 *                     bio: { type: string }
 *                     role: { type: string }
 *                     uniqueTag: { type: string }
 *                     isOnline: { type: boolean }
 *                     status_message: { type: string }
 *                     verified_badge: { type: boolean }
 *                     lastSeen: { type: string }
 */
// ── Static routes MUST be registered before the '/:userId' catch-all below ──
// Express matches in registration order: with '/:userId' first, GET /user/contacts
// resolved to getUserProfile with userId="contacts" and blew up with
// `Cast to ObjectId failed for value "contacts"`. ('/contacts/my' only survived
// because it has two segments.)

/** GET /api/v1/user/contacts/my — Get my contacts */
router.get('/contacts/my', getMyContacts);

/** GET /api/v1/user/contacts/nicknames — Get my saved aliases for other users */
router.get('/contacts/nicknames', getContactNicknames);

/** GET /api/v1/user/contacts — Search contacts */
router.get('/contacts', getContacts);

/** POST /api/v1/user/contacts/add — Add a contact */
router.post('/contacts/add', addContact);

/** DELETE /api/v1/user/contacts/:userId — Remove a contact */
router.delete('/contacts/:userId', removeContact);

/** PATCH /api/v1/user/contacts/:contactId/nickname — Save or clear an alias for a user */
router.patch('/contacts/:contactId/nickname', setContactNickname);

/** POST /api/v1/user/block/:userId — Toggle block/unblock */
router.route('/block/:userId').post(toggleBlockUser);

/** POST /api/v1/user/report/:userId — Report user for investigation */
router.route('/report/:userId').post(reportUser);

/** POST /api/v1/user/:userId/follow — Toggle follow/unfollow */
router.post('/:userId/follow', toggleFollowUser);

/** GET /api/v1/user/:userId/followers */
router.get('/:userId/followers', getUserFollowers);

/** GET /api/v1/user/:userId — Public profile (keep LAST: matches any single segment) */
router.route('/:userId').get(getUserProfile);

export default router;


// import express from 'express';
// import passport from 'passport';
// import {
//   getContacts,
//   getUserStatus,
//   scanOnlineUsers,
//   addContact,
//   getMyContacts,
//   removeContact,
//   getUserPublicKey,
// } from '../controllers/userController';

// const router = express.Router();
// const jwtAuth = passport.authenticate('jwt', { session: false });


// /**
//  * @swagger
//  * /api/v1/user/search:
//  *   get:
//  *     tags: [Users]
//  *     summary: Search users by name, email, phone or BubbleID
//  *     security:
//  *       - bearerAuth: []
//  *     parameters:
//  *       - in: query
//  *         name: search
//  *         schema:
//  *           type: string
//  *         description: Search keyword (name, email, phone, BubbleID)
//  *     responses:
//  *       200:
//  *         description: Success. List of user profiles matching criteria.
//  *         content:
//  *           application/json:
//  *             schema:
//  *               type: object
//  *               properties:
//  *                 message: { type: string }
//  *                 total: { type: integer }
//  *                 users: { type: array, items: { $ref: '#/components/schemas/User' } }
//  */
// router.get('/search', jwtAuth, getContacts);

// /**
//  * @swagger
//  * /api/v1/user/contacts/add:
//  *   post:
//  *     tags: [Users]
//  *     summary: Add a contact by email or BubbleID
//  *     security:
//  *       - bearerAuth: []
//  *     requestBody:
//  *       required: true
//  *       content:
//  *         application/json:
//  *           schema:
//  *             type: object
//  *             properties:
//  *               identifier:
//  *                 type: string
//  *                 description: Email address or BubbleID (e.g. bubble-A3F9X7K2)
//  *     responses:
//  *       200:
//  *         description: Contact added successfully.
//  */
// router.post('/contacts/add', jwtAuth, addContact);

// /**
//  * @swagger
//  * /api/v1/user/contacts/my:
//  *   get:
//  *     tags: [Users]
//  *     summary: Get the logged-in user's contact list
//  *     security:
//  *       - bearerAuth: []
//  *     responses:
//  *       200:
//  *         description: My contacts list retrieved.
//  *         content:
//  *           application/json:
//  *             schema:
//  *               type: object
//  *               properties:
//  *                 message: { type: string }
//  *                 contacts: { type: array, items: { $ref: '#/components/schemas/User' } }
//  */
// router.get('/contacts/my', jwtAuth, getMyContacts);

// /**
//  * @swagger
//  * /api/v1/user/contacts/{userId}:
//  *   delete:
//  *     tags: [Users]
//  *     summary: Remove a contact by userId
//  *     security:
//  *       - bearerAuth: []
//  *     parameters:
//  *       - in: path
//  *         name: userId
//  *         required: true
//  *         schema:
//  *           type: string
//  *     responses:
//  *       200:
//  *         description: Contact removed successfully.
//  */
// router.delete('/contacts/:userId', jwtAuth, removeContact);

// /**
//  * @swagger
//  * /api/v1/user/public-key/{userId}:
//  *   get:
//  *     tags: [Users]
//  *     summary: Get a user's RSA public key for E2E encryption
//  *     security:
//  *       - bearerAuth: []
//  *     parameters:
//  *       - in: path
//  *         name: userId
//  *         required: true
//  *         schema:
//  *           type: string
//  *     responses:
//  *       200:
//  *         description: Public key retrieved.
//  *         content:
//  *           application/json:
//  *             schema:
//  *               type: object
//  *               properties:
//  *                 publicKey: { type: string }
//  */
// router.get('/public-key/:userId', jwtAuth, getUserPublicKey);

// /**
//  * @swagger
//  * /api/v1/user/online-scanner:
//  *   get:
//  *     tags: [Users]
//  *     summary: Scan database for all actively online users
//  *     security:
//  *       - bearerAuth: []
//  *     responses:
//  *       200:
//  *         description: Scanned online users.
//  */
// router.get('/online-scanner', jwtAuth, scanOnlineUsers);

// /**
//  * @swagger
//  * /api/v1/user/status/{userId}:
//  *   get:
//  *     tags: [Users]
//  *     summary: Fetch the online status of a given user
//  *     parameters:
//  *       - in: path
//  *         name: userId
//  *         required: true
//  *         schema:
//  *           type: string
//  *     responses:
//  *       200:
//  *         description: User status retrieved.
//  *         content:
//  *           application/json:
//  *             schema:
//  *               type: object
//  *               properties:
//  *                 isOnline: { type: boolean }
//  *                 lastSeen: { type: string, format: date-time }
//  */
// router.get('/status/:userId', getUserStatus);



// export default router;
