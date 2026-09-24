import { Request, Response } from 'express';
import { User } from '../models/users';

export interface AuthRequest extends Request {
  user?: any;
}

// ─── Shared format helper ─────────────────────────────────────────────────────

const formatUser = (u: any) => ({
  id: u._id,
  full_name: u.full_name || null,
  username: u.username || null,
  email: u.email || null,
  phone_number: u.phone_number || null,
  avatar: u.avatar || null,
  gender: u.gender || null,
  date_of_birth: u.date_of_birth || null,
  status_message: u.status_message || null,
  mood_emoji: u.mood_emoji || null,
  hobbies: u.hobbies || [],
  location: {
    city: u.location?.city || null,
    country: u.location?.country || null,
    timezone: u.location?.timezone || 'UTC',
  },
  isOnline: u.isOnline ?? false,
  lastSeen: u.lastSeen || null,
  last_active_at: u.last_active_at || null,
  uniqueTag: u.uniqueTag || null,
  bio: u.bio || null,
  blog: u.blog || null,
  links: u.links || [],
  sharedResources: u.sharedResources || [],
  // Org identity
  organization: u.organization || null,
  org_role: u.org_role || null,
  org_industry: u.org_industry || null,
  org_size: u.org_size || null,
  app_background: u.app_background || 'bubbles',
  custom_background: u.custom_background || null,
  onboardingComplete: u.onboardingComplete || false,
  isVerified: u.isVerified ?? false,
  isPremium: u.isPremium ?? false,
  is_bot: u.is_bot ?? false,
  verified_badge: u.verified_badge ?? false,
  publicKey: u.publicKey || null,
  role: u.role || 'employee',
  actionItemEmailMode: (u as any).actionItemEmailMode || 'each',
  notification_settings: u.notification_settings || null,
  privacy_settings: u.privacy_settings || null,
  contacts: u.contacts || [],
  blocked_users: u.blocked_users || [],
  followersCount: u.followers?.length ?? 0,
  followingCount: u.following?.length ?? 0,
  postsCount: u.postsCount ?? u.posts?.length ?? 0,
  createdAt: u.createdAt,
  updatedAt: u.updatedAt,
});

// ─── Search Users ─────────────────────────────────────────────────────────────
/**
 * GET /api/v1/user/search?search=desmond
 */
export const getContacts = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?._id) {
    res.status(401).json({ message: 'Unauthorized.' });
    return;
  }

  try {
    const currentUser = await User.findById(req.user._id).select('contacts organization').lean();
    const myContacts: any[] = (currentUser as any)?.contacts || [];
    const myOrg: string | undefined = (currentUser as any)?.organization;

    const keyword = req.query.search as string | undefined;

    // Build the base scope: only coworkers (same org) + explicit contacts
    const scopeFilter: any = myOrg
      ? { $or: [{ organization: myOrg }, { _id: { $in: myContacts } }] }
      : { _id: { $in: myContacts } }; // no org → only show explicit contacts

    const searchFilter = keyword
      ? {
          $or: [
            { full_name: { $regex: keyword, $options: 'i' } },
            { email: { $regex: keyword, $options: 'i' } },
            { phone_number: { $regex: keyword, $options: 'i' } },
            { uniqueTag: { $regex: keyword, $options: 'i' } },
            { username: { $regex: keyword, $options: 'i' } },
          ],
        }
      : {};

    const users = await User.find({
      ...searchFilter,
      ...scopeFilter,
      _id: { $ne: req.user._id },
      is_bot: { $ne: true },
    })
      .select('-password -refreshToken -privateKey -zegoToken -otp -otpExpires -passwordResetToken')
      .limit(30);

    res.status(200).json({
      message: 'Users found successfully.',
      total: users.length,
      data: users.map(formatUser),
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};


// ─── Add Contact ──────────────────────────────────────────────────────────────
/**
 * POST /api/v1/user/contacts/add
 * Body: { identifier } — email or BubbleID
 */
export const addContact = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?._id) {
    res.status(401).json({ message: 'Unauthorized.' });
    return;
  }

  const { identifier } = req.body;
  if (!identifier) {
    res.status(400).json({ message: 'Provide an email or BubbleID (uniqueTag) to add a contact.' });
    return;
  }

  try {
    const targetUser = await User.findOne({
      $or: [
        { email: identifier.toLowerCase() },
        { uniqueTag: identifier },
        { username: identifier.toLowerCase() },
      ],
    }).select('_id full_name avatar uniqueTag username');

    if (!targetUser) {
      res.status(404).json({ message: 'No user found with that email, username, or BubbleID.' });
      return;
    }

    if (String(targetUser._id) === String(req.user._id)) {
      res.status(400).json({ message: 'You cannot add yourself as a contact.' });
      return;
    }

    const currentUser = await User.findById(req.user._id).select('contacts');
    if (currentUser?.contacts?.some(id => String(id) === String(targetUser._id))) {
      res.status(400).json({ message: 'This user is already in your contacts.' });
      return;
    }

    // $addToSet (not $push) so a re-add or a concurrent request can never create a
    // duplicate contact entry — the root of "users show up twice" in the roster.
    await User.findByIdAndUpdate(req.user._id, {
      $addToSet: { contacts: targetUser._id },
    });

    res.status(200).json({
      message: 'Contact added successfully.',
      data: formatUser(targetUser),
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Get My Contacts ──────────────────────────────────────────────────────────
/**
 * GET /api/v1/user/contacts/my
 */
export const getMyContacts = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?._id) {
    res.status(401).json({ message: 'Unauthorized.' });
    return;
  }

  try {
    // Short-TTL cache. The roster changes rarely; embedded presence (isOnline) is
    // overridden live on the client from the central presence map, so brief
    // staleness here is invisible. Self-heals on expiry — no explicit invalidation.
    const { getCache, setCache } = await import('../utils/redis');
    const cacheKey = `user:contacts:${String(req.user._id)}`;
    const cached = await getCache(cacheKey).catch(() => null);
    if (cached) {
      res.status(200).json({ message: 'Contacts retrieved successfully.', total: cached.length, data: cached });
      return;
    }

    const userWithContacts = await User.findById(req.user._id)
      .populate('contacts', '-password -refreshToken -privateKey -zegoToken -otp -otpExpires');

    const data = (userWithContacts?.contacts || []).map(formatUser);
    await setCache(cacheKey, data, 30).catch(() => undefined);

    res.status(200).json({
      message: 'Contacts retrieved successfully.',
      total: data.length,
      data,
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Remove Contact ───────────────────────────────────────────────────────────
/**
 * DELETE /api/v1/user/contacts/:userId
 */
export const removeContact = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?._id) {
    res.status(401).json({ message: 'Unauthorized.' });
    return;
  }

  try {
    await User.findByIdAndUpdate(req.user._id, {
      $pull: { contacts: req.params.userId },
    });
    res.status(200).json({ message: 'Contact removed successfully.' });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Contact Nicknames (private per-viewer aliases) ──────────────────────────
/**
 * GET /api/v1/user/contacts/nicknames
 * Returns the requester's full alias map: { [contactId]: nickname }
 */
export const getContactNicknames = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?._id) {
    res.status(401).json({ message: 'Unauthorized.' });
    return;
  }

  try {
    const user = await User.findById(req.user._id).select('contactNicknames');
    res.status(200).json({
      message: 'Nicknames retrieved successfully.',
      data: user?.contactNicknames || {},
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * PATCH /api/v1/user/contacts/:contactId/nickname
 * Body: { nickname: string } — saving an empty/whitespace nickname clears it.
 * Not restricted to existing contacts — any user can be aliased (e.g. a group member).
 */
export const setContactNickname = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?._id) {
    res.status(401).json({ message: 'Unauthorized.' });
    return;
  }

  try {
    const { contactId } = req.params;
    const trimmed = typeof req.body?.nickname === 'string' ? req.body.nickname.trim() : '';

    const update = trimmed
      ? { $set: { [`contactNicknames.${contactId}`]: trimmed } }
      : { $unset: { [`contactNicknames.${contactId}`]: '' } };

    const user = await User.findByIdAndUpdate(req.user._id, update, { new: true }).select('contactNicknames');

    res.status(200).json({
      message: trimmed ? 'Nickname saved successfully.' : 'Nickname cleared successfully.',
      data: user?.contactNicknames || {},
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Block / Unblock User ─────────────────────────────────────────────────────
/**
 * POST /api/v1/user/block/:userId
 */
export const toggleBlockUser = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?._id) {
    res.status(401).json({ message: 'Unauthorized.' });
    return;
  }

  const targetId = req.params.userId;

  if (String(req.user._id) === targetId) {
    res.status(400).json({ message: 'You cannot block yourself.' });
    return;
  }

  try {
    const currentUser = await User.findById(req.user._id).select('blocked_users');
    const isBlocked = currentUser?.blocked_users?.some(id => String(id) === targetId);

    if (isBlocked) {
      await User.findByIdAndUpdate(req.user._id, { $pull: { blocked_users: targetId } });
      res.status(200).json({ message: 'User unblocked.', blocked: false });
    } else {
      await User.findByIdAndUpdate(req.user._id, {
        $push: { blocked_users: targetId },
        $pull: { contacts: targetId }, // Remove from contacts too
      });
      res.status(200).json({ message: 'User blocked.', blocked: true });
    }
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Get Public Key ───────────────────────────────────────────────────────────
/**
 * GET /api/v1/user/public-key/:userId
 */
export const getUserPublicKey = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.params.userId).select('publicKey');
    if (!user) {
      res.status(404).json({ message: 'User not found.' });
      return;
    }

    if (!user.publicKey) {
      res.status(202).json({ message: 'Public key is still being generated. Try again shortly.' });
      return;
    }

    res.status(200).json({ data: { publicKey: user.publicKey } });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};



// ─── Scan Online Users ────────────────────────────────────────────────────────
/**
 * GET /api/v1/user/online-scanner
 */
export const scanOnlineUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    const onlineUsers = await User.find({
      isOnline: true,
      socketId: { $ne: '' },
    }).select('-password -refreshToken -privateKey -zegoToken -otp -otpExpires');

    res.status(200).json({
      message: 'Online users scan completed.',
      total: onlineUsers.length,
      data: onlineUsers.map(formatUser),
    });
  } catch (err: any) {
    res.status(500).json({ message: 'Error running online scanner: ' + err.message });
  }
};


// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * Get a single user's public profile
 * GET /api/v1/user/:userId
 */
export const getUserProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.params.userId).select(
      'full_name username email phone avatar bio role uniqueTag isOnline status_message verified_badge lastSeen createdAt'
    );
    if (!user) {
      res.status(404).json({ message: 'User not found' });
      return;
    }
    res.status(200).json({
      message: 'User profile retrieved.',
      user: formatUser(user),
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

export const searchUsers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const query = (req.query.search as string) || '';
    const currentUser = await User.findById(req.user?._id).select('organization contacts role');

    let filter: any = {
      is_bot: { $ne: true },
      _id: { $ne: req.user?._id }, // Exclude self
    };

    if (query) {
      // 1. Check for exact match on BubbleID or Email (allow finding new people)
      const exactMatch = await User.findOne({
        $or: [
          { uniqueTag: query },
          { email: query.toLowerCase() }
        ]
      }).select('_id');

      if (exactMatch) {
        // If exact match found, just return that user specifically
        filter._id = exactMatch._id;
      } else {
        // 2. Regular search: prioritize Coworkers (same org)
        const allowedIds = [...(currentUser?.contacts || [])];
        // An org-less user has organization === '' (the schema default). Matching on that
        // bare value would treat every other org-less user as a "coworker" — effectively
        // exposing the entire org-less user base to itself. Only add the org clause when
        // the viewer actually belongs to a real organization.
        const scopeClauses: any[] = [{ _id: { $in: allowedIds } }];
        if (currentUser?.organization) {
          scopeClauses.push({ organization: currentUser.organization });
        }

        filter.$and = [
          {
            $or: [
              { full_name: { $regex: query, $options: 'i' } },
              { username: { $regex: query, $options: 'i' } },
              { email: { $regex: query, $options: 'i' } },
            ]
          },
          { $or: scopeClauses }
        ];
      }
    } else {
      // No query: default to ONLY the user's explicit contacts. Org colleagues must
      // never auto-populate a personal surface (chats/calls) — they belong to the
      // dedicated org directory (getOrgMembers) and only enter your contacts when you
      // explicitly add them. A keyword search above can still reach coworkers to add.
      filter._id = { ...filter._id, $in: currentUser?.contacts || [] };
    }

    const users = await User.find(filter)
      .select('full_name username email avatar uniqueTag isOnline verified_badge lastSeen organization org_role org_industry org_size')
      .limit(30);

    res.status(200).json({
      message: 'Users found.',
      total: users.length,
      users: users.map(formatUser),
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * Get online users scanner
 * GET /api/v1/user/online-scanner
 */
export const getOnlineScannedUsers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const users = await User.find({ isOnline: true, is_bot: { $ne: true } })
      .select('full_name username avatar uniqueTag isOnline')
      .limit(50);
    res.status(200).json({ message: 'Online users fetched.', users: users.map(formatUser) });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * Get user online status
 * GET /api/v1/user/status/:userId
 */
export const getUserStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.params.userId).select('isOnline lastSeen');
    if (!user) { res.status(404).json({ message: 'User not found' }); return; }
    res.status(200).json({ isOnline: user.isOnline, lastSeen: (user as any).lastSeen || null });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Report User ──────────────────────────────────────────────────────────────
/**
 * POST /api/v1/user/report/:userId
 * Body: { reason } — reason for report
 */
export const reportUser = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?._id) {
    res.status(401).json({ message: 'Unauthorized.' });
    return;
  }

  const targetId = req.params.userId;
  const { reason = 'No reason provided' } = req.body;

  if (String(req.user._id) === targetId) {
    res.status(400).json({ message: 'You cannot report yourself.' });
    return;
  }

  try {
    const targetUser = await User.findById(targetId).select('full_name email uniqueTag');
    if (!targetUser) {
      res.status(404).json({ message: 'User not found.' });
      return;
    }

    // Log report for admin investigation (extend with a Report model later)
    console.warn(`[REPORT] User ${req.user._id} reported user ${targetId} (${targetUser.email}) — Reason: ${reason}`);

    // Flag the reported user for review by adding to a conceptual queue
    // In a full implementation this would write to a Report model / alert admin dashboard
    await User.findByIdAndUpdate(targetId, {
      $set: { flagged_for_review: true },
    });

    res.status(200).json({
      message: 'Report submitted. Our team will review this account.',
      reported_user: targetId,
      reason,
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

export const getSuggestions = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?._id) {
    res.status(401).json({ message: 'Unauthorized.' });
    return;
  }

  try {
    const currentUser = await User.findById(req.user._id).select('following organization').lean();

    // If the user has not joined an organisation, return nothing.
    // Showing all unaffiliated users would expose random people from across the platform.
    if (!currentUser?.organization) {
      res.status(200).json({ message: 'Join an organisation to see colleagues.', data: [] });
      return;
    }

    const alreadyFollowing = ((currentUser as any)?.following || []).map((id: any) => id.toString());
    alreadyFollowing.push(req.user._id.toString());

    const users = await User.find({
      _id: { $nin: alreadyFollowing },
      is_bot: { $ne: true },
      organization: currentUser.organization // Only suggest within the org
    })
      .select('-password -refreshToken -privateKey -zegoToken -otp -otpExpires -passwordResetToken')
      .limit(8);

    res.status(200).json({
      message: 'Suggestions loaded.',
      data: users.map(formatUser),
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};


// ─── Follow / Unfollow ────────────────────────────────────────────────────────
export const toggleFollowUser = async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user?._id) { res.status(401).json({ message: 'Unauthorized.' }); return; }
  const targetId = req.params.userId;
  if (String(req.user._id) === targetId) { res.status(400).json({ message: 'You cannot follow yourself.' }); return; }
  try {
    const currentUser = await User.findById(req.user._id).select('following');
    const targetUser = await User.findById(targetId).select('followers');
    if (!targetUser) { res.status(404).json({ message: 'User not found.' }); return; }
    const isFollowing = currentUser?.following?.some(id => String(id) === targetId);
    if (isFollowing) {
      await User.findByIdAndUpdate(req.user._id, { $pull: { following: targetId } });
      await User.findByIdAndUpdate(targetId, { $pull: { followers: req.user._id } });
      res.status(200).json({ message: 'Unfollowed successfully.', following: false });
    } else {
      await User.findByIdAndUpdate(req.user._id, { $addToSet: { following: targetId } });
      await User.findByIdAndUpdate(targetId, { $addToSet: { followers: req.user._id } });
      res.status(200).json({ message: 'Now following.', following: true });
    }
  } catch (err: any) { res.status(500).json({ message: err.message }); }
};

export const getUserFollowers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const u = await User.findById(req.params.userId).populate('followers', '-password -refreshToken -privateKey -zegoToken').lean();
    if (!u) { res.status(404).json({ message: 'User not found.' }); return; }
    res.status(200).json({ message: 'Followers retrieved.', total: (u.followers || []).length, followers: (u.followers || []).map(formatUser) });
  } catch (err: any) { res.status(500).json({ message: err.message }); }
};

export const getUserFollowing = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const u = await User.findById(req.params.userId).populate('following', '-password -refreshToken -privateKey -zegoToken').lean();
    if (!u) { res.status(404).json({ message: 'User not found.' }); return; }
    res.status(200).json({ message: 'Following retrieved.', total: (u.following || []).length, following: (u.following || []).map(formatUser) });
  } catch (err: any) { res.status(500).json({ message: err.message }); }
};

