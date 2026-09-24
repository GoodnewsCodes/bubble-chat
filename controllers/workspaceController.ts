import { Request, Response } from 'express';
import { WorkspaceFile } from '../models/workspaceFile';
import { uploadToFilebase, getSignedMediaUrl, extractKeyFromUrl, streamS3Object } from '../utils/filebase';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from '../utils/filebase';
import * as fs from 'fs';
import { logActivity } from './activityLogController';

export interface AuthRequest extends Request {
  user?: any;
}

const BUCKET = process.env.FILEBASE_BUCKET as string;

/**
 * Resolve file type from mime string
 */
const resolveFileType = (mime: string): IWorkspaceFile['fileType'] => {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv')) return 'spreadsheet';
  if (mime.includes('word') || mime.includes('document') || mime.includes('text')) return 'doc';
  return 'other';
};

type IWorkspaceFile = import('../models/workspaceFile').IWorkspaceFile;

// ─── Format helper ─────────────────────────────────────────────────────────────

const formatFile = (f: any) => ({
  id: f._id,
  name: f.name,
  originalName: f.originalName,
  fileUrl: f.fileUrl,
  fileKey: f.fileKey,
  fileType: f.fileType,
  mimeType: f.mimeType,
  fileSize: f.fileSize,
  workspace: f.workspace,
  source: f.source,
  sourceReference: f.sourceReference || null,
  isPublic: f.isPublic ?? false,
  uploadedBy: f.uploadedBy
    ? { id: f.uploadedBy._id, full_name: f.uploadedBy.full_name, avatar: f.uploadedBy.avatar, uniqueTag: f.uploadedBy.uniqueTag }
    : null,
  sharedWith: Array.isArray(f.sharedWith)
    ? f.sharedWith.map((u: any) => ({ id: u._id, full_name: u.full_name, avatar: u.avatar, uniqueTag: u.uniqueTag }))
    : [],
  blockedUsers: Array.isArray(f.blockedUsers)
    ? f.blockedUsers.map((u: any) => ({ id: u._id, full_name: u.full_name }))
    : [],
  tags: f.tags || [],
  description: f.description || null,
  createdAt: f.createdAt,
  updatedAt: f.updatedAt,
});

// ─── Handlers ──────────────────────────────────────────────────────────────────

/**
 * Upload file to workspace
 * POST /api/v1/workspace/file
 */
export const uploadWorkspaceFile = async (req: AuthRequest, res: Response): Promise<void> => {
  const { linkUrl, workspace = 'Default', source = 'manual', sourceReference, tags, description, name } = req.body;
  if (!req.file && !linkUrl) { res.status(400).json({ message: 'A file or linkUrl is required' }); return; }
  if (!req.user?._id) { res.status(401).json({ message: 'Unauthorized' }); return; }

  try {

    let url = linkUrl;
    let key = undefined;
    let fileType = 'link';
    let mimeType = 'text/uri-list';
    let fileSize = 0;
    let originalName = name || 'Web Link';

    if (req.file) {
      const fileKey = `workspace/${req.user._id}/${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
      const stream = fs.createReadStream(req.file.path);
      const resData = await uploadToFilebase(stream, fileKey, req.file.mimetype);
      url = resData.url;
      key = resData.key;
      fileType = resolveFileType(req.file.mimetype);
      mimeType = req.file.mimetype;
      fileSize = req.file.size;
      originalName = req.file.originalname;
    }

    const wFile = await WorkspaceFile.create({
      name: name || originalName,
      originalName,
      fileUrl: url,
      fileKey: key,
      fileType,
      mimeType,
      fileSize,
      uploadedBy: req.user._id,
      workspace: workspace.trim(),
      source,
      sourceReference,
      tags: tags ? (Array.isArray(tags) ? tags : tags.split(',').map((t: string) => t.trim())) : [],
      description,
    });

    await wFile.populate('uploadedBy', 'full_name avatar uniqueTag');

    logActivity({
      actor: req.user._id,
      action: 'file_uploaded',
      entityId: String(wFile._id),
      entityType: 'WorkspaceFile',
      entityLabel: wFile.name,
      metadata: { fileType: wFile.fileType, workspace: wFile.workspace, fileSize: wFile.fileSize },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json({ message: 'File uploaded successfully.', file: formatFile(wFile) });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  } finally {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
  }
};

/**
 * Create an empty folder representation
 * POST /api/v1/workspace/folder
 */
export const createWorkspaceFolder = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?._id) { res.status(401).json({ message: 'Unauthorized' }); return; }

  try {
    const { name, workspace = 'Default' } = req.body;
    if (!name?.trim()) { res.status(400).json({ message: 'Folder name is required' }); return; }

    const wFile = await WorkspaceFile.create({
      name: name.trim(),
      isFolder: true,
      fileType: 'folder',
      workspace: workspace.trim(),
      uploadedBy: req.user._id,
      source: 'manual',
    });

    await wFile.populate('uploadedBy', 'full_name avatar uniqueTag');

    logActivity({
      actor: req.user._id,
      action: 'folder_created',
      entityId: String(wFile._id),
      entityType: 'WorkspaceFile',
      entityLabel: wFile.name,
      metadata: { workspace: wFile.workspace },
    });

    res.status(201).json({ message: 'Folder created successfully.', file: formatFile(wFile) });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * List workspace files for the current user
 * GET /api/v1/workspace/file
 * Query: workspace, type, source, search
 */
export const listWorkspaceFiles = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?._id) { res.status(401).json({ message: 'Unauthorized' }); return; }

  try {
    const { workspace, type, source, search } = req.query;
    const query: any = {
      uploadedBy: req.user._id,
      blockedUsers: { $ne: req.user._id },
    };

    if (workspace) query.workspace = workspace;
    if (type) query.fileType = type;
    if (source) query.source = source;
    if (search) query.$text = { $search: search as string };

    const files = await WorkspaceFile.find(query)
      .populate('uploadedBy', 'full_name avatar uniqueTag')
      .populate('sharedWith', 'full_name avatar uniqueTag')
      .populate('blockedUsers', 'full_name avatar uniqueTag')
      .sort({ createdAt: -1 });

    // Also get distinct workspace names for sidebar
    const workspaces = await WorkspaceFile.distinct('workspace', { uploadedBy: req.user._id });

    // Explicitly grab all pure folders generated by the user
    const folderDocs = await WorkspaceFile.find({ uploadedBy: req.user._id, isFolder: true })
      .select('_id name workspace isPublic createdAt')
      .lean();

    res.status(200).json({
      message: 'Files retrieved.',
      total: files.length,
      workspaces,
      folderDocs: folderDocs.map(fd => ({ id: fd._id, name: fd.name, workspace: fd.workspace, isPublic: fd.isPublic, createdAt: fd.createdAt })),
      files: files.map(formatFile),
    });

  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * Get single file details
 * GET /api/v1/workspace/file/:fileId
 */
export const getWorkspaceFile = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?._id) { res.status(401).json({ message: 'Unauthorized' }); return; }
  try {
    const file = await WorkspaceFile.findById(req.params.fileId)
      .populate('uploadedBy', 'full_name avatar uniqueTag')
      .populate('sharedWith', 'full_name avatar uniqueTag')
      .populate('blockedUsers', 'full_name avatar uniqueTag');

    if (!file) { res.status(404).json({ message: 'File not found' }); return; }

    const userId = String(req.user._id);
    const isOwner = String(file.uploadedBy._id || file.uploadedBy) === userId;
    const isShared = file.sharedWith.some((u: any) => String(u._id || u) === userId);
    const isBlocked = file.blockedUsers.some((u: any) => String(u._id || u) === userId);

    if (!isOwner && !isShared && !file.isPublic) {
      res.status(403).json({ message: 'Access denied' }); return;
    }
    if (isBlocked) { res.status(403).json({ message: 'Access denied' }); return; }

    res.status(200).json({ message: 'File retrieved.', file: formatFile(file) });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * Get shared public folder details and its contents
 * GET /api/v1/workspace/shared/:folderId
 */
export const getSharedWorkspaceFolder = async (req: Request, res: Response): Promise<void> => {
  try {
    const folder = await WorkspaceFile.findById(req.params.folderId).populate('uploadedBy', 'full_name avatar uniqueTag');
    if (!folder || !folder.isFolder) { res.status(404).json({ message: 'Folder not found' }); return; }
    
    // Check if the folder itself is public. If not, accessing via shared link is blocked.
    // (If we wanted to allow explicitly sharedWith users to view this without logging in, we could, but let's stick to isPublic for public links)
    if (!folder.isPublic) {
      res.status(403).json({ message: 'This folder is not public' }); return;
    }

    // Retrieve all files matching this workspace bucket generated by the same owner
    // We implicitly allow viewing these files since the parent folder is public.
    const files = await WorkspaceFile.find({
      workspace: folder.name,
      uploadedBy: folder.uploadedBy,
    }).sort({ createdAt: -1 });

    res.status(200).json({
      folder: { name: folder.name, description: folder.description, uploadedBy: (folder as any).uploadedBy, createdAt: folder.createdAt },
      files: files.map(formatFile),
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * Delete a workspace file
 * DELETE /api/v1/workspace/file/:fileId
 */
export const deleteWorkspaceFile = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?._id) { res.status(401).json({ message: 'Unauthorized' }); return; }
  try {
    const file = await WorkspaceFile.findById(req.params.fileId);
    if (!file) { res.status(404).json({ message: 'File not found' }); return; }
    if (String(file.uploadedBy) !== String(req.user._id)) {
      res.status(403).json({ message: 'Only the file owner can delete it' }); return;
    }

    // Delete from Filebase if it's a real file
    try {
      if (!file.isFolder && file.fileKey) {
        await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: file.fileKey }));
      }
    } catch (e) {
      console.error('[Workspace] Filebase delete failed, removing DB record anyway:', e);
    }

    await WorkspaceFile.findByIdAndDelete(req.params.fileId);

    logActivity({
      actor: req.user._id,
      action: 'file_deleted',
      entityId: String(file._id),
      entityType: 'WorkspaceFile',
      entityLabel: file.name,
      metadata: { isFolder: file.isFolder },
    });

    res.status(200).json({ message: 'File deleted.', deleted_id: req.params.fileId });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * Manage access — add / remove users from sharedWith
 * PUT /api/v1/workspace/file/:fileId/access
 * Body: { action: 'add'|'remove', userId: string } | { isPublic: boolean }
 */
export const manageFileAccess = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?._id) { res.status(401).json({ message: 'Unauthorized' }); return; }
  try {
    const file = await WorkspaceFile.findById(req.params.fileId);
    if (!file) { res.status(404).json({ message: 'File not found' }); return; }
    if (String(file.uploadedBy) !== String(req.user._id)) {
      res.status(403).json({ message: 'Only the file owner can manage access' }); return;
    }

    const { action, userId, isPublic } = req.body;

    if (typeof isPublic === 'boolean') {
      file.isPublic = isPublic;
    }

    if (userId) {
      if (action === 'add') {
        if (!file.sharedWith.includes(userId)) file.sharedWith.push(userId);
        // Remove from blocked if explicitly sharing
        file.blockedUsers = file.blockedUsers.filter(id => String(id) !== String(userId)) as any;
      } else if (action === 'remove') {
        file.sharedWith = file.sharedWith.filter(id => String(id) !== String(userId)) as any;
      }
    }

    await file.save();
    await file.populate('sharedWith', 'full_name avatar uniqueTag');
    await file.populate('blockedUsers', 'full_name avatar uniqueTag');

    res.status(200).json({ message: 'Access updated.', file: formatFile(file) });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * Block a user from accessing a file
 * PUT /api/v1/workspace/file/:fileId/block
 * Body: { userId: string, action: 'block'|'unblock' }
 */
export const blockFileUser = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?._id) { res.status(401).json({ message: 'Unauthorized' }); return; }
  try {
    const file = await WorkspaceFile.findById(req.params.fileId);
    if (!file) { res.status(404).json({ message: 'File not found' }); return; }
    if (String(file.uploadedBy) !== String(req.user._id)) {
      res.status(403).json({ message: 'Only the file owner can block users' }); return;
    }

    const { userId, action = 'block' } = req.body;
    if (!userId) { res.status(400).json({ message: 'userId is required' }); return; }

    if (action === 'block') {
      if (!file.blockedUsers.includes(userId)) file.blockedUsers.push(userId);
      // Also remove from sharedWith
      file.sharedWith = file.sharedWith.filter(id => String(id) !== String(userId)) as any;
    } else {
      file.blockedUsers = file.blockedUsers.filter(id => String(id) !== String(userId)) as any;
    }

    await file.save();
    res.status(200).json({ message: action === 'block' ? 'User blocked from file.' : 'User unblocked.', file: formatFile(file) });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * Generate a signed proxy URL for secure file access
 * GET /api/v1/workspace/file/:fileId/proxy
 */
export const proxyWorkspaceFile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const file = await WorkspaceFile.findById(req.params.fileId);
    if (!file) { res.status(404).json({ message: 'File not found' }); return; }

    // Access check (skip if public)
    if (!file.isPublic && req.user) {
      const userId = String(req.user._id);
      const isOwner = String(file.uploadedBy) === userId;
      const isShared = file.sharedWith.some((u: any) => String(u) === userId);
      const isBlocked = file.blockedUsers.some((u: any) => String(u) === userId);
      if ((!isOwner && !isShared) || isBlocked) {
        res.status(403).json({ message: 'Access denied' }); return;
      }
    }

    if (file.isFolder || !file.fileKey) {
      res.status(400).json({ message: 'Folders cannot be proxied or downloaded.' });
      return;
    }

    const isDownload = req.query.download === 'true';
    const downloadName = isDownload ? file.originalName || file.name : undefined;
    await streamS3Object(file.fileKey, res, downloadName);

  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * Update file metadata (name, workspace, tags, description)
 * PUT /api/v1/workspace/file/:fileId
 */
export const updateWorkspaceFile = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?._id) { res.status(401).json({ message: 'Unauthorized' }); return; }
  try {
    const file = await WorkspaceFile.findById(req.params.fileId);
    if (!file) { res.status(404).json({ message: 'File not found' }); return; }
    if (String(file.uploadedBy) !== String(req.user._id)) {
      res.status(403).json({ message: 'Only the file owner can update metadata' }); return;
    }

    const { name, workspace, tags, description } = req.body;
    if (name) file.name = name;
    if (workspace) file.workspace = workspace;
    if (tags) file.tags = Array.isArray(tags) ? tags : tags.split(',').map((t: string) => t.trim());
    if (description !== undefined) file.description = description;

    await file.save();
    res.status(200).json({ message: 'File updated.', file: formatFile(file) });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * Get files shared WITH the current user by others
 * GET /api/v1/workspace/shared-with-me
 */
export const getSharedWithMe = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?._id) { res.status(401).json({ message: 'Unauthorized' }); return; }
  try {
    const files = await WorkspaceFile.find({
      sharedWith: req.user._id,
      uploadedBy: { $ne: req.user._id },
    })
      .populate('uploadedBy', 'full_name avatar uniqueTag username')
      .populate('sharedWith', 'full_name avatar uniqueTag')
      .sort({ updatedAt: -1 });

    res.status(200).json({
      message: 'Files shared with you.',
      total: files.length,
      files: files.map(f => ({
        ...formatFile(f),
        sharedBy: f.uploadedBy
          ? { id: (f.uploadedBy as any)._id, full_name: (f.uploadedBy as any).full_name, username: (f.uploadedBy as any).username, avatar: (f.uploadedBy as any).avatar }
          : null,
        sharedSource: f.source || 'manual',
        sharedSourceRef: f.sourceReference || null,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

