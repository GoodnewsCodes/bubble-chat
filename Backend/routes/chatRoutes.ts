import express from 'express';
import passport from 'passport';
import {
  accessChat,
  fetchChats,
  createGroupChat,
  renameGroup,
  addToGroup,
  removeFromGroup,
  muteChat,
  clearChat,
  toggleChatPin,
  deleteChat,
  getUnreadChatCount,
  toggleArchiveChat,
  joinGroupChatByInvite,
  updateGroupSettings,
  getChatById,
} from '../controllers/chatController';


const router = express.Router();

// Apply JWT authentication to all chat routes
router.use(passport.authenticate('jwt', { session: false }));

/**
 * @swagger
 * /api/v1/chat:
 *   post:
 *     tags: [Chat]
 *     summary: Create or fetch a 1-on-1 chat
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               userId: { type: string }
 *     responses:
 *       200:
 *         description: Success. Returns the detailed conversation object.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 conversation: { $ref: '#/components/schemas/Conversation' }
 *       201:
 *         description: New direct conversation created.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 conversation: { $ref: '#/components/schemas/Conversation' }
 *       400:
 *         description: Missing userId or invalid request.
 */
router.route('/').post(accessChat);

/** GET /api/v1/chat/unread-count */
router.route('/unread-count').get(getUnreadChatCount);

/**
 * @swagger
 * /api/v1/chat:
 *   get:
 *     tags: [Chat]
 *     summary: Fetch all conversations for the logged in user
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of detailed conversation objects.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 total: { type: integer }
 *                 conversations:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Conversation' }
 */
router.route('/').get(fetchChats);

/**
 * @swagger
 * /api/v1/chat/group:
 *   post:
 *     tags: [Chat]
 *     summary: Create a new group chat
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               users: { type: array, items: { type: string } }
 *     responses:
 *       201:
 *         description: Group created successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 conversation: { $ref: '#/components/schemas/Conversation' }
 */
router.route('/group').post(createGroupChat);
router.route('/group/join').post(joinGroupChatByInvite);
router.route('/group/update').put(updateGroupSettings);

/**
 * @swagger
 * /api/v1/chat/rename:
 *   put:
 *     tags: [Chat]
 *     summary: Rename an existing group
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               chatId: { type: string }
 *               chatName: { type: string }
 *     responses:
 *       200:
 *         description: Group renamed successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 conversation: { $ref: '#/components/schemas/Conversation' }
 */
router.route('/rename').put(renameGroup);

/**
 * @swagger
 * /api/v1/chat/groupremove:
 *   put:
 *     tags: [Chat]
 *     summary: Remove a user from a group
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               chatId: { type: string }
 *               userId: { type: string }
 *     responses:
 *       200:
 *         description: Member removed successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 removed_user_id: { type: string }
 *                 conversation: { $ref: '#/components/schemas/Conversation' }
 */
router.route('/groupremove').put(removeFromGroup);

/**
 * @swagger
 * /api/v1/chat/groupadd:
 *   put:
 *     tags: [Chat]
 *     summary: Add a user to a group
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               chatId: { type: string }
 *               userId: { type: string }
 *     responses:
 *       200:
 *         description: Member added successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 added_member: { $ref: '#/components/schemas/User' }
 *                 conversation: { $ref: '#/components/schemas/Conversation' }
 */
router.route('/groupadd').put(addToGroup);

/** PUT /api/v1/chat/mute/:chatId — Toggle mute status */
router.put('/mute/:chatId', muteChat);

/** PUT /api/v1/chat/clear/:chatId — Clear all messages for me */
router.put('/clear/:chatId', clearChat);

/** PUT /api/v1/chat/pin/:chatId — Toggle pin status */
router.put('/pin/:chatId', toggleChatPin);

/** PATCH /api/v1/chat/toggle-archive/:chatId — Toggle archive status */
router.patch('/toggle-archive/:chatId', toggleArchiveChat);

/**
 * @swagger
 * /api/v1/chat/{chatId}:
 *   delete:
 *     tags: [Chat]
 *     summary: Delete a chat from your view (soft-delete, hides from your list)
 *     description: Marks all messages as deleted for you and hides the conversation. Other participants are unaffected.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Chat deleted from your view.
 */
router.delete('/:chatId', deleteChat);

/**
 * GET /api/v1/chat/:chatId — Fetch one conversation with fully-populated members.
 * Registered last so static GET routes (e.g. /unread-count) match first.
 */
router.get('/:chatId', getChatById);

export default router;
