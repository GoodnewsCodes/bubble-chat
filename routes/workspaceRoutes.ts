import express from 'express';
import passport from 'passport';
import {
  uploadWorkspaceFile,
  createWorkspaceFolder,
  listWorkspaceFiles,
  getSharedWorkspaceFolder,
  getWorkspaceFile,
  deleteWorkspaceFile,
  manageFileAccess,
  blockFileUser,
  proxyWorkspaceFile,
  updateWorkspaceFile,
  getSharedWithMe,
} from '../controllers/workspaceController';
import { handleUpload } from '../middleware/upload';

const router = express.Router();

// Public proxy — accessible without JWT (access check done inside controller)
router.get('/file/:fileId/proxy', proxyWorkspaceFile);

// All subsequent routes require JWT
router.use(passport.authenticate('jwt', { session: false }));

/**
 * @swagger
 * /api/v1/workspace/file:
 *   post:
 *     tags: [Workspace]
 *     summary: Upload a file to a workspace bucket
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file: { type: string, format: binary }
 *               name: { type: string }
 *               workspace: { type: string, description: "Workspace/bucket label" }
 *               source: { type: string, enum: [meeting, contact, manual] }
 *               sourceReference: { type: string }
 *               tags: { type: string, description: "Comma-separated or array" }
 *               description: { type: string }
 *     responses:
 *       201:
 *         description: File uploaded successfully.
 */
router.post('/file', handleUpload.single('file'), uploadWorkspaceFile);

/**
 * @swagger
 * /api/v1/workspace/folder:
 *   post:
 *     tags: [Workspace]
 *     summary: Create an empty folder
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               workspace: { type: string, description: "Parent workspace/folder" }
 *     responses:
 *       201:
 *         description: Folder created.
 */
router.post('/folder', createWorkspaceFolder);

/**
 * @swagger
 * /api/v1/workspace/file:

 *   get:
 *     tags: [Workspace]
 *     summary: List workspace files owned by the current user
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: workspace
 *         schema: { type: string }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [image, video, audio, pdf, doc, spreadsheet, other] }
 *       - in: query
 *         name: source
 *         schema: { type: string, enum: [meeting, contact, manual] }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of workspace files.
 */
router.get('/file', listWorkspaceFiles);

/**
 * @swagger
 * /api/v1/workspace/shared/{folderId}:
 *   get:
 *     tags: [Workspace]
 *     summary: Retrieve a publicly shared folder and its contents
 *     parameters:
 *       - in: path
 *         name: folderId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Folder contents
 */
router.get('/shared/:folderId', getSharedWorkspaceFolder);

/**
 * @swagger

 * /api/v1/workspace/file/{fileId}:
 *   get:
 *     tags: [Workspace]
 *     summary: Get a single workspace file
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: fileId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: File details.
 *       403:
 *         description: Access denied.
 */
router.get('/file/:fileId', getWorkspaceFile);

/**
 * @swagger
 * /api/v1/workspace/file/{fileId}:
 *   put:
 *     tags: [Workspace]
 *     summary: Update file metadata (name, workspace, tags, description)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: fileId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               workspace: { type: string }
 *               tags: { type: string }
 *               description: { type: string }
 *     responses:
 *       200:
 *         description: File updated.
 */
router.put('/file/:fileId', updateWorkspaceFile);

/**
 * @swagger
 * /api/v1/workspace/file/{fileId}:
 *   delete:
 *     tags: [Workspace]
 *     summary: Delete a workspace file (owner only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: fileId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: File deleted.
 */
router.delete('/file/:fileId', deleteWorkspaceFile);

/**
 * @swagger
 * /api/v1/workspace/file/{fileId}/access:
 *   put:
 *     tags: [Workspace]
 *     summary: Manage who can access a file (share, revoke, toggle public)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: fileId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               action: { type: string, enum: [add, remove] }
 *               userId: { type: string }
 *               isPublic: { type: boolean }
 *     responses:
 *       200:
 *         description: Access updated.
 */
router.put('/file/:fileId/access', manageFileAccess);

/**
 * @swagger
 * /api/v1/workspace/file/{fileId}/block:
 *   put:
 *     tags: [Workspace]
 *     summary: Block or unblock a user from accessing a file
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: fileId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               userId: { type: string }
 *               action: { type: string, enum: [block, unblock] }
 *     responses:
 *       200:
 *         description: Block status updated.
 */
router.put('/file/:fileId/block', blockFileUser);

/** GET /api/v1/workspace/shared-with-me — files shared with current user */
router.get('/shared-with-me', getSharedWithMe);

export default router;
