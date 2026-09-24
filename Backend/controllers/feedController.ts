import { Request, Response } from 'express';
import Post from '../models/post';
import { User } from '../models/users';
import mongoose from 'mongoose';

// GET /api/v1/feed
export const getFeedPosts = async (req: Request, res: Response) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const posts = await Post.find()
      .populate('author', 'username avatar full_name verified_badge uniqueTag')
      .populate('comments.user', 'username avatar')
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .lean();

    const total = await Post.countDocuments();
    res.json({ posts, total, page: Number(page), limit: Number(limit) });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/v1/feed/trending — posts with most engagement in last 48h
export const getTrendingPosts = async (req: Request, res: Response) => {
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const posts = await Post.find({ createdAt: { $gte: cutoff } })
      .populate('author', 'username avatar full_name verified_badge uniqueTag')
      .populate('comments.user', 'username avatar')
      .lean();

    // Score by likes + comments + reposts
    const scored = posts.map(p => ({
      ...p,
      _score: (p.likes?.length || 0) * 3 + (p.comments?.length || 0) * 2 + (p.reposts?.length || 0),
    }));
    scored.sort((a, b) => b._score - a._score);

    res.json({ posts: scored.slice(0, 20), total: scored.length });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/v1/feed/following — posts from followed users
export const getFollowingFeed = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id;
    const { page = 1, limit = 20 } = req.query;

    const currentUser = await User.findById(userId).select('following').lean();
    const followingIds = currentUser?.following || [];

    if (followingIds.length === 0) {
      res.json({ posts: [], total: 0, message: 'Follow some users to see their posts here.' });
      return;
    }

    const posts = await Post.find({ author: { $in: followingIds } })
      .populate('author', 'username avatar full_name verified_badge uniqueTag')
      .populate('comments.user', 'username avatar')
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .lean();

    const total = await Post.countDocuments({ author: { $in: followingIds } });
    res.json({ posts, total, page: Number(page), limit: Number(limit) });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/v1/feed/suggestions — suggested users to follow
export const getSuggestedUsers = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id;
    const currentUser = await User.findById(userId).select('following').lean();
    const alreadyFollowing = (currentUser?.following || []).map(id => id.toString());
    alreadyFollowing.push(userId.toString()); // don't suggest self

    const suggested = await User.find({
      _id: { $nin: alreadyFollowing },
    })
      .select('full_name username avatar bio verified_badge uniqueTag followersCount')
      .sort({ 'followers': -1 })
      .limit(8)
      .lean();

    res.json({ users: suggested });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/v1/feed
export const createPost = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id;
    const { content } = req.body;
    const file = (req as any).file;

    if (!content && !file) {
      return res.status(400).json({ message: 'Post must have content or media.' });
    }

    let mediaUrl: string | undefined;
    let mediaType: 'image' | 'video' | undefined;

    if (file) {
      const mime = file.mimetype || '';
      mediaType = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : undefined;
      mediaUrl = (file as any).location || file.path || `/uploads/${file.filename}`;
    }

    const post = await Post.create({
      author: userId,
      content: content || '',
      mediaUrl,
      mediaType,
    });

    const populated = await post.populate('author', 'username avatar full_name verified_badge uniqueTag');
    res.status(201).json({ post: populated });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

// POST /api/v1/feed/:id/like
export const toggleLike = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id;
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: 'Post not found' });

    const alreadyLiked = post.likes.some((id) => id.equals(userId));
    if (alreadyLiked) {
      post.likes = post.likes.filter((id) => !id.equals(userId)) as any;
    } else {
      post.likes.push(userId);
    }
    await post.save();
    res.json({ liked: !alreadyLiked, likeCount: post.likes.length });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

// POST /api/v1/feed/:id/repost
export const toggleRepost = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id;
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: 'Post not found' });

    const alreadyReposted = post.reposts.some((id) => id.equals(userId));
    if (alreadyReposted) {
      post.reposts = post.reposts.filter((id) => !id.equals(userId)) as any;
    } else {
      post.reposts.push(userId);
    }
    await post.save();
    res.json({ reposted: !alreadyReposted, repostCount: post.reposts.length });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

// POST /api/v1/feed/:id/save
export const toggleSave = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id;
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: 'Post not found' });

    const alreadySaved = post.saves.some((id) => id.equals(userId));
    if (alreadySaved) {
      post.saves = post.saves.filter((id) => !id.equals(userId)) as any;
    } else {
      post.saves.push(userId);
    }
    await post.save();
    res.json({ saved: !alreadySaved, saveCount: post.saves.length });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

// GET /api/v1/feed/saved
export const getSavedPosts = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id;
    const posts = await Post.find({ saves: userId })
      .populate('author', 'username avatar full_name verified_badge uniqueTag')
      .populate('comments.user', 'username avatar')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ posts, total: posts.length });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/v1/feed/:id/comment
export const addComment = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id;
    const { text } = req.body;
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: 'Post not found' });

    post.comments.push({ user: userId, text, createdAt: new Date() });
    await post.save();
    const populated = await post.populate('comments.user', 'username avatar');
    res.status(201).json({ comments: populated.comments });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

// DELETE /api/v1/feed/:id
export const deletePost = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id;
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: 'Post not found' });
    if (!post.author.equals(userId)) return res.status(403).json({ message: 'Not authorized' });

    await post.deleteOne();
    res.json({ message: 'Post deleted' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};
