import { Request, Response } from 'express';
import Network, { NetworkPost } from '../models/network';
import mongoose from 'mongoose';

// ─── Networks ─────────────────────────────────────────────────────────────────

// GET /api/v1/community/networks
export const getNetworks = async (req: Request, res: Response) => {
  try {
    const { search, category, page = 1, limit = 12 } = req.query;
    const query: any = {};
    if (search) query.$text = { $search: search as string };
    if (category) query.categories = { $in: [category as string] };

    const networks = await Network.find(query)
      .populate('creator', 'username avatar')
      .sort({ memberCount: -1, activityScore: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .lean();

    const total = await Network.countDocuments(query);
    res.json({ networks, total, page: Number(page), limit: Number(limit) });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/v1/community/networks/:id
export const getNetworkById = async (req: Request, res: Response) => {
  try {
    const network = await Network.findById(req.params.id)
      .populate('creator', 'username avatar full_name')
      .populate('members', 'username avatar')
      .lean();
    if (!network) return res.status(404).json({ message: 'Network not found' });
    res.json({ network });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/v1/community/networks
export const createNetwork = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id;
    const { title, description, image, categories, onlyCreatorCanPost, isPrivate } = req.body;
    const network = await Network.create({
      title,
      description,
      image: image || '',
      creator: userId,
      members: [userId],
      memberCount: 1,
      categories: categories || [],
      onlyCreatorCanPost: onlyCreatorCanPost !== false,
      isPrivate: isPrivate || false,
      badge: 'New',
    });
    res.status(201).json({ network });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

// POST /api/v1/community/networks/:id/join
export const joinNetwork = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id;
    const network = await Network.findById(req.params.id);
    if (!network) return res.status(404).json({ message: 'Network not found' });

    const alreadyMember = network.members.some((m) => m.equals(userId));
    if (alreadyMember) {
      return res.json({ message: 'Already a member', network });
    }

    network.members.push(userId);
    network.memberCount = network.members.length;
    // Boost activity score on join
    network.activityScore += 2;
    await network.save();

    res.json({ message: 'Joined successfully', network });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/v1/community/networks/:id/leave
export const leaveNetwork = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id;
    const network = await Network.findById(req.params.id);
    if (!network) return res.status(404).json({ message: 'Network not found' });

    network.members = network.members.filter((m) => !m.equals(userId)) as any;
    network.memberCount = network.members.length;
    await network.save();
    res.json({ message: 'Left network successfully' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Trending ─────────────────────────────────────────────────────────────────

// GET /api/v1/community/trending
export const getTrendingNetworks = async (req: Request, res: Response) => {
  try {
    // Trending algorithm: weight by (memberCount * 0.4) + (activityScore * 0.6)
    // boost networks created within the last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const networks = await Network.find()
      .populate('creator', 'username avatar')
      .lean();

    const scored = networks.map((n) => {
      const isNew = new Date(n.createdAt) > thirtyDaysAgo;
      const score = n.memberCount * 0.4 + n.activityScore * 0.6 + (isNew ? 10 : 0);
      return { ...n, trendingScore: score };
    });

    scored.sort((a, b) => b.trendingScore - a.trendingScore);

    res.json({ networks: scored.slice(0, 10) });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/v1/community/month
export const getNetworkOfTheMonth = async (req: Request, res: Response) => {
  try {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    // Network with the highest member growth this month = biggest memberCount (simplified)
    const network = await Network.findOne()
      .populate('creator', 'username avatar full_name')
      .populate('members', 'username avatar')
      .sort({ memberCount: -1, activityScore: -1 })
      .lean();

    res.json({ network });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/v1/community/categories
export const getCategories = async (req: Request, res: Response) => {
  try {
    const allCategories = await Network.distinct('categories');
    res.json({ categories: allCategories });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Network Posts ────────────────────────────────────────────────────────────

// GET /api/v1/community/networks/:id/posts
export const getNetworkPosts = async (req: Request, res: Response) => {
  try {
    const posts = await NetworkPost.find({ network: req.params.id })
      .populate('author', 'username avatar full_name verified_badge')
      .populate('forwardedFrom')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ posts });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/v1/community/networks/:id/posts
export const createNetworkPost = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id;
    const network = await Network.findById(req.params.id);
    if (!network) return res.status(404).json({ message: 'Network not found' });

    // Only creator can post if onlyCreatorCanPost is set
    if (network.onlyCreatorCanPost && !network.creator.equals(userId)) {
      return res.status(403).json({ message: 'Only the network creator can post updates.' });
    }

    const { content, mediaUrl, mediaType, linkUrl } = req.body;
    const post = await NetworkPost.create({
      network: network._id,
      author: userId,
      content,
      mediaUrl,
      mediaType,
      linkUrl,
    });

    // Boost activity score
    network.activityScore += 5;
    await network.save();

    const populated = await post.populate('author', 'username avatar full_name verified_badge');
    res.status(201).json({ post: populated });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

// POST /api/v1/community/networks/:networkId/posts/:postId/react
export const reactToNetworkPost = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id;
    const { emoji } = req.body;
    const post = await NetworkPost.findById(req.params.postId);
    if (!post) return res.status(404).json({ message: 'Post not found' });

    const existingIdx = post.reactions.findIndex((r) => r.user.equals(userId));
    if (existingIdx !== -1) {
      if (post.reactions[existingIdx].emoji === emoji) {
        post.reactions.splice(existingIdx, 1); // toggle off
      } else {
        post.reactions[existingIdx].emoji = emoji; // change emoji
      }
    } else {
      post.reactions.push({ user: userId, emoji });
    }

    // Boost activity score on network
    await Network.findByIdAndUpdate(req.params.networkId, { $inc: { activityScore: 1 } });
    await post.save();
    res.json({ post });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

// POST /api/v1/community/networks/:networkId/posts/:postId/forward
export const forwardNetworkPost = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id;
    const { targetNetworkId } = req.body;
    const original = await NetworkPost.findById(req.params.postId);
    if (!original) return res.status(404).json({ message: 'Post not found' });

    const targetNetworkId_ = targetNetworkId || req.params.networkId;
    const targetNetwork = await Network.findById(targetNetworkId_);
    if (!targetNetwork) return res.status(404).json({ message: 'Target network not found' });

    if (targetNetwork.onlyCreatorCanPost && !targetNetwork.creator.equals(userId)) {
      return res.status(403).json({ message: 'Only the network creator can post updates.' });
    }

    const forwarded = await NetworkPost.create({
      network: targetNetworkId_,
      author: userId,
      content: original.content,
      mediaUrl: original.mediaUrl,
      mediaType: original.mediaType,
      linkUrl: original.linkUrl,
      forwardedFrom: original._id,
    });

    await Network.findByIdAndUpdate(targetNetworkId_, { $inc: { activityScore: 3 } });

    res.status(201).json({ post: forwarded });
  } catch (err: any) {
    res.status(400).json({ message: err.message });
  }
};

// DELETE /api/v1/community/networks/:networkId/posts/:postId
export const deleteNetworkPost = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?._id;
    const post = await NetworkPost.findById(req.params.postId);
    if (!post) return res.status(404).json({ message: 'Post not found' });

    const network = await Network.findById(req.params.networkId);
    const isAuthor = post.author.equals(userId);
    const isCreator = network?.creator.equals(userId);

    if (!isAuthor && !isCreator) {
      return res.status(403).json({ message: 'Only the post author or network creator can delete posts.' });
    }

    await NetworkPost.findByIdAndDelete(req.params.postId);
    res.json({ message: 'Post deleted' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};
