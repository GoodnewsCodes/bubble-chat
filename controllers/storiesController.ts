import { Request, Response } from 'express';
import { Story } from '../models/stories';
import { uploadToFilebase, getSignedMediaUrl, extractKeyFromUrl, streamS3Object } from '../utils/filebase';
import { AuthRequest } from './userController';
import * as fs from 'fs';

// ─── Format helpers ───────────────────────────────────────────────────────────

const formatAuthor = (u: any) => ({
  id: u._id,
  full_name: u.full_name || null,
  username: u.username || null,
  avatar: u.avatar || null,
  uniqueTag: u.uniqueTag || null,
  isOnline: u.isOnline ?? false,
  verified_badge: u.verified_badge ?? false,
});

const formatStory = (s: any) => ({
  id: s._id,
  mediaType: s.mediaType,
  mediaUrl: s.mediaUrl || null,
  textContent: s.textContent || null,
  author: s.author ? formatAuthor(s.author) : null,
  
  // Engagement
  views: Array.isArray(s.views) ? s.views.map(formatAuthor) : [],
  viewCount: Array.isArray(s.views) ? s.views.length : 0,
  reactions: s.reactions || [],
  mentions: Array.isArray(s.mentions) ? s.mentions.map(formatAuthor) : [],
  
  // Privacy
  is_close_friends_only: s.is_close_friends_only ?? false,
  
  // Background / text styling (for text stories)
  bg_gradient: s.bg_gradient || null,
  text_color: s.text_color || null,
  font_size: s.font_size || null,
  
  expiresAt: s.expiresAt || null,
  remainingSeconds: s.expiresAt
    ? Math.max(0, Math.floor((new Date(s.expiresAt).getTime() - Date.now()) / 1000))
    : null,
  createdAt: s.createdAt || null,
});

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * Upload a Story / Signal
 * POST /api/v1/story/upload
 * Content-Type: multipart/form-data | { textContent } for text-only
 */
export const uploadStory = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?._id) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  const file = req.file; // diskStorage — file.path is set, file.buffer is NOT
  const textContent = req.body.textContent || '';

  if (!file && !textContent) {
    res.status(400).json({ message: 'A media file or text content is required to post a Signal.' });
    return;
  }

  try {
    let mediaUrl: string | undefined;
    let mediaType: 'image' | 'video' | 'audio' | 'text' = 'text';

    if (file) {
      const fileKey = `media/stories/${req.user._id}/${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
      // Use createReadStream (diskStorage) — NOT file.buffer
      const stream = fs.createReadStream(file.path);
      const { url } = await uploadToFilebase(stream, fileKey, file.mimetype);
      mediaUrl = url;

      if (file.mimetype.startsWith('image/')) mediaType = 'image';
      else if (file.mimetype.startsWith('video/')) mediaType = 'video';
      else if (file.mimetype.startsWith('audio/')) mediaType = 'audio';

      // Clean up temp file
      try { fs.unlinkSync(file.path); } catch {}
    }

    const newStory = await Story.create({
      author: req.user._id,
      mediaType,
      mediaUrl: mediaUrl || '',
      textContent,
      is_close_friends_only: req.body.is_close_friends_only === 'true' || req.body.is_close_friends_only === true,
      mentions: req.body.mentions,
      bg_gradient: req.body.bg_gradient || undefined,
      text_color: req.body.text_color || undefined,
      font_size: req.body.font_size ? parseInt(req.body.font_size) : undefined,
    });

    const populated = await newStory.populate([
      { path: 'author', select: 'full_name username avatar uniqueTag isOnline verified_badge' },
      { path: 'mentions', select: 'full_name username avatar uniqueTag' }
    ]);

    res.status(201).json({
      message: 'Signal broadcast successfully. It will expire in 24 hours.',
      story: formatStory(populated),
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * Fetch all active stories (within 24-hour window)
 * GET /api/v1/story
 */
export const fetchStories = async (req: Request, res: Response): Promise<void> => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const stories = await Story.find({ createdAt: { $gte: cutoff } })
      .populate('author', 'full_name username avatar uniqueTag isOnline verified_badge')
      .populate('views', 'full_name avatar uniqueTag')
      .populate('mentions', 'full_name avatar uniqueTag')
      .sort({ createdAt: -1 });

    res.status(200).json({
      message: 'Active signals retrieved successfully.',
      total: stories.length,
      stories: stories.map(formatStory),
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * Proxy media for a story (presigned redirect, no JWT required so the browser can load it)
 * GET /api/v1/story/media/proxy?url=...
 */
export const proxyStoryMedia = async (req: Request, res: Response): Promise<void> => {
  try {
    const rawUrl = req.query.url as string;
    if (!rawUrl) { res.status(400).json({ message: 'Missing url parameter' }); return; }
    await streamS3Object(rawUrl, res);
  } catch (error: any) {
    res.status(500).json({ message: 'Failed to stream story media: ' + error.message });
  }
};
