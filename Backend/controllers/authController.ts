import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { User } from '../models/users';
import { Organization } from '../models/organizations';
import { Otp } from '../models/otp';
import { PushToken } from '../models/pushToken';
import { sendOTPEmail, sendPasswordResetEmail, sendWelcomeNewMemberEmail } from '../utils/mailer';
import { seedOrgKnowledge } from './orgController';
import { Conversation } from '../models/conversations';
import { Message } from '../models/messages';
import { getAidaBotUser } from './aidaController';
import { logActivity } from './activityLogController';

// ─── Token Helpers ────────────────────────────────────────────────────────────

// Signing with a hardcoded fallback secret would let anyone mint valid tokens;
// refuse to sign/verify rather than silently degrade. envCheck enforces these at
// boot in production — this guard covers dev and misconfigured deploys.
export const getRefreshKey = (): string => {
  const key = process.env.JWT_REFRESH_KEY || process.env.JWT_REFRESH_SECRET;
  if (!key) throw new Error('JWT_REFRESH_KEY is not set — refusing to use a default secret');
  return key;
};

const generateAccessToken = (userId: string) => {
  if (!process.env.JWT_KEY) throw new Error('JWT_KEY is not set — refusing to use a default secret');
  return jwt.sign({ id: userId }, process.env.JWT_KEY, { expiresIn: '2d' });
};

const generateRefreshToken = (userId: string) =>
  jwt.sign({ id: userId }, getRefreshKey(), { expiresIn: '30d' });

// ─── Cookie Helpers ────────────────────────────────────────────────────────────

export const setAuthCookies = (res: Response, accessToken: string, refreshToken?: string) => {
  const isProd = process.env.NODE_ENV === 'production';
  const cookieOptions: any = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: 15 * 60 * 1000, // 15 minutes
  };

  res.cookie('access_token', accessToken, cookieOptions);

  if (refreshToken) {
    res.cookie('refresh_token', refreshToken, {
      ...cookieOptions,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });
  }
};

export const clearAuthCookies = (res: Response) => {
  const isProd = process.env.NODE_ENV === 'production';
  const clearOptions: any = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
  };
  res.clearCookie('access_token', clearOptions);
  res.clearCookie('refresh_token', clearOptions);
};

// ─── OTP Helper ───────────────────────────────────────────────────────────────

const generateOTP = (): string =>
  crypto.randomInt(10000, 100000).toString(); // 5-digit OTP, CSPRNG

// ─── Format Helper ────────────────────────────────────────────────────────────

const formatUser = (u: any) => ({
  id: u._id,
  full_name: u.full_name || null,
  email: u.email || null,
  phone_number: u.phone_number || null,
  avatar: u.avatar || null,
  uniqueTag: u.uniqueTag || null,
  bio: u.bio || null,
  organization: u.organization || null,
  org_role: u.org_role || null,
  org_industry: u.org_industry || null,
  org_size: u.org_size || null,
  onboardingComplete: u.onboardingComplete ?? false,
  signupKind: u.signupKind || 'individual',
  onboardingStep:
    u.onboardingStep ||
    (u.onboardingComplete ? 'complete' : u.isVerified ? 'awaiting_profile' : 'awaiting_otp'),
  isVerified: u.isVerified ?? false,
  isPremium: u.isPremium ?? false,
  is_bot: u.is_bot ?? false,
  verified_badge: u.verified_badge ?? false,
  isOnline: u.isOnline ?? false,
  publicKey: u.publicKey || null,
  role: u.role || 'employee',
  isSocialAccount: !!u.googleId,
  createdAt: u.createdAt,
  updatedAt: u.updatedAt,
});

// ─── Unique BubbleID Tag ──────────────────────────────────────────────────────

const generateUniqueTag = async (base: string): Promise<string> => {
  let tag: string;
  let exists: boolean;
  const cleanBase = base.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'bubble';
  do {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const suffix = Array.from({ length: 8 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
    tag = `${cleanBase}-${suffix}`;
    exists = !!(await User.findOne({ uniqueTag: tag }));
  } while (exists);
  return tag;
};

// ─── Password Validator ───────────────────────────────────────────────────────

const validatePassword = (password: string): string | null => {
  if (password.length < 8) return 'Password must be at least 8 characters long.';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter.';
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter.';
  if (!/\d/.test(password)) return 'Password must contain at least one number.';
  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password))
    return 'Password must contain at least one special character.';
  return null;
};

// ─── CHECK USER STATUS ────────────────────────────────────────────────────────

export const checkUserStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const emailRaw = (req.query.email as string | undefined)?.trim().toLowerCase();
    const phoneRaw = (req.query.phone_number as string | undefined)?.trim();

    if (!emailRaw && !phoneRaw) {
      res.status(400).json({ message: 'email or phone_number is required.' });
      return;
    }

    const filter: any = emailRaw ? { email: emailRaw } : { phone_number: phoneRaw };
    const user = await User.findOne(filter).select(
      'isVerified onboardingComplete onboardingStep signupKind organization organizationId role'
    );

    if (!user) {
      res.status(200).json({ data: { exists: false, nextAction: 'register' } });
      return;
    }

    const step =
      user.onboardingStep ||
      (user.onboardingComplete ? 'complete' : user.isVerified ? 'awaiting_profile' : 'awaiting_otp');

    const nextAction =
      step === 'awaiting_otp' ? 'verify_otp' : step === 'complete' ? 'login' : 'login_then_setup';

    res.status(200).json({
      data: {
        exists: true,
        isVerified: !!user.isVerified,
        onboardingStep: step,
        signupKind: user.signupKind || 'individual',
        hasOrg: !!user.organizationId,
        role: user.role || 'employee',
        nextAction,
      },
    });
  } catch (err: any) {
    res.status(500).json({ message: 'Status check failed: ' + err.message });
  }
};

// ─── REGISTER ─────────────────────────────────────────────────────────────────

export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      full_name,
      email,
      phone_number,
      password,
      publicKey,
      org_name,
      org_industry,
      org_size,
      signupKind: signupKindInput,
    } = req.body;

    if (!email && !phone_number) {
      res.status(400).json({ message: 'Email or phone number is required.' });
      return;
    }

    if (!password) {
      res.status(400).json({ message: 'Password is required.' });
      return;
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      res.status(400).json({ message: passwordError });
      return;
    }

    const cleanOrgName = org_name ? org_name.trim() : '';
    const hasInviteCode = !!req.body.inviteCode;
    const signupKind: 'individual' | 'organization' =
      signupKindInput === 'individual' || signupKindInput === 'organization'
        ? signupKindInput
        : cleanOrgName || hasInviteCode
        ? 'organization'
        : 'individual';

    const existingByEmail = email ? await User.findOne({ email: email.toLowerCase() }) : null;
    const existingByPhone =
      !existingByEmail && phone_number ? await User.findOne({ phone_number }) : null;
    const existing = existingByEmail || existingByPhone;

    if (existing) {
      if (existing.isVerified) {
        res.status(409).json({
          message: 'An account with this identifier already exists. Please log in.',
          data: { onboardingStep: existing.onboardingStep || 'complete', requiresLogin: true },
        });
        return;
      }

      const otp = generateOTP();
      const otpExpires = new Date(Date.now() + 10 * 60 * 1000);
      const hashedPasswordResume = await bcrypt.hash(password, 12);
      existing.password = hashedPasswordResume;
      existing.signupKind = signupKind;
      existing.onboardingStep = 'awaiting_otp';
      await existing.save();

      await Otp.create({ userId: existing._id, otp, type: 'verification', expiresAt: otpExpires });

      if (existing.email) {
        try {
          await sendOTPEmail(existing.email, existing.full_name || 'User', otp);
        } catch (emailErr: any) {
          console.warn(`⚠️ Could not send OTP email to ${existing.email}:`, emailErr.message);
          // console.log(`[DEV/TESTING] OTP for ${existing.email} is: ${otp}`);
        }
      }

      res.status(201).json({
        message: 'Resuming signup. A fresh OTP has been sent.',
        data: {
          email: existing.email || null,
          phone_number: existing.phone_number || null,
          requiresVerification: true,
          expiresInMinutes: 10,
          onboardingStep: 'awaiting_otp',
          signupKind,
          resumed: true,
        },
      });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const otp = generateOTP();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000);
    const uniqueTag = await generateUniqueTag(full_name || 'user');

    const cleanOrgIndustry = cleanOrgName ? org_industry || '' : '';
    const validOrgSizes = ['solo', '2-10', '11-50', '51-200', '201-500', '500+'];
    const cleanOrgSize =
      cleanOrgName && org_size && validOrgSizes.includes(org_size) ? org_size : undefined;

    const newUser = await User.create({
      full_name,
      email: email?.toLowerCase(),
      phone_number: phone_number || undefined,
      password: hashedPassword,
      isVerified: false,
      uniqueTag,
      onboardingComplete: false,
      signupKind,
      onboardingStep: 'awaiting_otp',
      publicKey,
      organization: cleanOrgName,
      org_industry: cleanOrgIndustry,
      org_size: cleanOrgSize,
      role: cleanOrgName ? 'admin' : 'employee',
    });

    let organization = null;
    if (cleanOrgName) {
      const inviteCode = crypto.randomBytes(16).toString('hex').toUpperCase();
      organization = await Organization.create({
        name: cleanOrgName,
        industry: cleanOrgIndustry || undefined,
        size: cleanOrgSize,
        owner: newUser._id,
        inviteCode,
        pineconeNamespace: `org-${newUser._id}`,
      });

      await User.findByIdAndUpdate(newUser._id, { organizationId: organization._id });
      await seedOrgKnowledge(organization, (newUser._id as any).toString());

      const bot = await getAidaBotUser();
      const botId = bot ? bot._id : null;
      const defaultChat = await Conversation.create({
        chatName: cleanOrgName,
        isGroupChat: true,
        users: botId ? [newUser._id, botId] : [newUser._id],
        groupAdmin: newUser._id,
        groupIcon: 'black',
        groupDescription: `Default group chat for ${cleanOrgName}`,
        organizationId: organization._id,
        isDefaultOrgChat: true,
      });

      if (botId) {
        const welcomeContent = `👋 **Welcome to the ${cleanOrgName} Workspace on Bubble!**\n\nI am **Aida**, your workspace intelligence assistant. I will automatically index shared resources and meeting transcripts to grow our collective business brain.\n\nAll members who join will automatically be added to this default group chat. Feel free to collaborate, share documents, schedule calls, and ask me anything!`;
        const initialMsg = await Message.create({
          chat: defaultChat._id,
          sender: botId,
          content: welcomeContent,
          message_type: 'text',
        });
        defaultChat.latestMessage = (initialMsg as any)._id;
        await defaultChat.save();
      }
    } else if (req.body.inviteCode) {
      const existingOrg = await Organization.findOne({ inviteCode: req.body.inviteCode });
      if (existingOrg) {
        await User.findByIdAndUpdate(newUser._id, {
          organization: existingOrg.name,
          organizationId: existingOrg._id,
          org_industry: existingOrg.industry,
          org_size: existingOrg.size,
          role: 'employee',
        });

        const defaultChat = await Conversation.findOne({
          organizationId: existingOrg._id,
          isDefaultOrgChat: true,
        });

        if (defaultChat) {
          if (!defaultChat.users.map((id: any) => id.toString()).includes(newUser._id.toString())) {
            defaultChat.users.push(newUser._id);
            await defaultChat.save();
          }
        }

        if (newUser.email) {
          const summaryHtml = existingOrg.description
            ? existingOrg.description.replace(/\n/g, '<br />')
            : 'Welcome to the organization! The brain is currently ready and listening.';
          await sendWelcomeNewMemberEmail(
            newUser.email,
            newUser.full_name || newUser.username || 'Employee',
            existingOrg.name,
            summaryHtml
          );
        }
      }
    }

    await Otp.create({ userId: newUser._id, otp, type: 'verification', expiresAt: otpExpires });

    if (email) {
      try {
        await sendOTPEmail(email, full_name || 'User', otp);
      } catch (emailErr: any) {
        console.warn(`⚠️ Could not send OTP email to ${email}:`, emailErr.message);
        // console.log(`[DEV/TESTING] OTP for ${email} is: ${otp}`);
      }
    }

    res.status(201).json({
      message: 'Account created. Please verify your email with the OTP sent.',
      data: {
        email: newUser.email || null,
        phone_number: newUser.phone_number || null,
        requiresVerification: true,
        expiresInMinutes: 10,
        onboardingStep: 'awaiting_otp',
        signupKind,
        resumed: false,
      },
    });
  } catch (err: any) {
    res.status(500).json({ message: 'Registration failed: ' + err.message });
  }
};

// ─── VERIFY OTP ───────────────────────────────────────────────────────────────

export const verifyOTP = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      res.status(400).json({ message: 'Email and OTP are required.' });
      return;
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      res.status(404).json({ message: 'User not found.' });
      return;
    }

    if (user.isVerified) {
      res.status(400).json({ message: 'Account is already verified. Please login.' });
      return;
    }

    const otpRecord = await Otp.findOne({
      userId: user._id,
      otp: otp.toString(),
      type: 'verification',
      isUsed: false,
      expiresAt: { $gt: new Date() },
    });

    if (!otpRecord) {
      res.status(400).json({ message: 'Invalid or expired OTP. Please check and try again.' });
      return;
    }

    otpRecord.isUsed = true;
    await otpRecord.save();

    const refreshToken = generateRefreshToken(String(user._id));
    await User.findByIdAndUpdate(user._id, {
      isVerified: true,
      isOnline: true,
      lastSeen: new Date(),
      refreshToken,
      onboardingStep: 'awaiting_profile',
    });

    const accessToken = generateAccessToken(String(user._id));

    setAuthCookies(res, accessToken, refreshToken);

    res.status(200).json({
      message: 'Email verified successfully. Welcome to Bubble!',
      data: { accessToken, refreshToken, user: formatUser(user) },
    });
  } catch (err: any) {
    res.status(500).json({ message: 'OTP verification failed: ' + err.message });
  }
};

// ─── RESEND OTP ───────────────────────────────────────────────────────────────

export const resendOTP = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;

    if (!email) {
      res.status(400).json({ message: 'Email is required.' });
      return;
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      res.status(404).json({ message: 'User not found.' });
      return;
    }

    if (user.isVerified) {
      res.status(400).json({ message: 'Account is already verified.' });
      return;
    }

    const otp = generateOTP();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

    await Otp.create({ userId: user._id, otp, type: 'verification', expiresAt: otpExpires });

    if (user.email) {
      try {
        await sendOTPEmail(user.email, user.full_name || 'User', otp);
      } catch (emailErr: any) {
        console.warn(`⚠️ Could not send OTP email to ${user.email}:`, emailErr.message);
        // console.log(`[DEV/TESTING] OTP for ${user.email} is: ${otp}`);
      }
    }

    res.status(200).json({
      message: 'A new OTP has been sent to your email.',
      data: {
        userId: user._id,
        otpSentTo: user.email || user.phone_number,
        expiresInMinutes: 10,
      },
    });
  } catch (err: any) {
    res.status(500).json({ message: 'Resend OTP failed: ' + err.message });
  }
};

// ─── LOGIN ────────────────────────────────────────────────────────────────────

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, phone_number, password } = req.body;

    if (!email && !phone_number) {
      res.status(400).json({ message: 'Email or phone number is required.' });
      return;
    }

    if (!password) {
      res.status(400).json({ message: 'Password is required.' });
      return;
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      res.status(400).json({ message: passwordError });
      return;
    }

    const query = email ? { email: email.toLowerCase() } : { phone_number };
    const user = await User.findOne(query).select('+password +refreshToken');

    if (!user) {
      res.status(401).json({ message: 'No account found with these credentials.' });
      return;
    }

    if (!user.isVerified) {
      const otp = generateOTP();
      const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

      await Otp.create({ userId: user._id, otp, type: 'verification', expiresAt: otpExpires });

      if (user.email) {
        try {
          await sendOTPEmail(user.email, user.full_name || 'User', otp);
        } catch (emailErr: any) {
          console.warn(`⚠️ Could not send OTP email to ${user.email}:`, emailErr.message);
          // console.log(`[DEV/TESTING] OTP for ${user.email} is: ${otp}`);
        }
      }

      res.status(200).json({
        message: 'Account is not verified. A new OTP has been sent to your email.',
        data: {
          email: user.email || null,
          phone_number: user.phone_number || null,
          requiresVerification: true,
        },
      });
      return;
    }

    if (!user.password) {
      res
        .status(400)
        .json({ message: 'This account uses social login. Please sign in with Google.' });
      return;
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      res.status(401).json({ message: 'Incorrect password.' });
      return;
    }

    const accessToken = generateAccessToken(String(user._id));
    const refreshToken = generateRefreshToken(String(user._id));

    await User.findByIdAndUpdate(user._id, {
      refreshToken,
      isOnline: true,
      lastSeen: new Date(),
    });

    logActivity({
      actor: user._id,
      action: 'login',
      entityType: 'Auth',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    setAuthCookies(res, accessToken, refreshToken);

    res.status(200).json({
      message: 'Login successful. Welcome back!',
      data: { accessToken, refreshToken, user: formatUser(user) },
    });
  } catch (err: any) {
    res.status(500).json({ message: 'Login failed: ' + err.message });
  }
};

// ─── LOGOUT ───────────────────────────────────────────────────────────────────

export const logout = async (req: any, res: Response): Promise<void> => {
  try {
    if (!req.user?._id) {
      res.status(401).json({ message: 'Unauthorized.' });
      return;
    }

    await User.findByIdAndUpdate(req.user._id, {
      refreshToken: '',
      isOnline: false,
      lastSeen: new Date(),
      socketId: '',
    });

    logActivity({
      actor: req.user._id,
      action: 'logout',
      entityType: 'Auth',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    clearAuthCookies(res);

    res.status(200).json({ message: 'Logged out successfully.' });
  } catch (err: any) {
    res.status(500).json({ message: 'Logout failed: ' + err.message });
  }
};

// ─── FORGOT PASSWORD ──────────────────────────────────────────────────────────

export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;

    if (!email) {
      res.status(400).json({ message: 'Email is required.' });
      return;
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      res
        .status(200)
        .json({ message: 'If an account with that email exists, a reset link has been sent.' });
      return;
    }

    const otp = generateOTP();
    const otpExpires = new Date(Date.now() + 15 * 60 * 1000);

    await Otp.create({ userId: user._id, otp, type: 'reset', expiresAt: otpExpires });

    try {
      await sendPasswordResetEmail(user.email!, user.full_name || 'User', otp);
    } catch (emailErr: any) {
      console.warn(`⚠️ Could not send password reset email to ${user.email}:`, emailErr.message);
      // console.log(`[DEV/TESTING] Reset OTP for ${user.email} is: ${otp}`);
    }

    res.status(200).json({
      message: 'If an account with that email exists, a verification code has been sent.',
    });
  } catch (err: any) {
    res.status(500).json({ message: 'Forgot password failed: ' + err.message });
  }
};

// ─── RESET PASSWORD ───────────────────────────────────────────────────────────

export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      res
        .status(400)
        .json({ message: 'Email, Verification OTP, and new password are required.' });
      return;
    }

    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      res.status(400).json({ message: passwordError });
      return;
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      res.status(400).json({ message: 'Invalid or expired OTP.' });
      return;
    }

    const otpRecord = await Otp.findOne({
      userId: user._id,
      otp: otp.toString(),
      type: 'reset',
      isUsed: false,
      expiresAt: { $gt: new Date() },
    });

    if (!otpRecord) {
      res.status(400).json({ message: 'Invalid or expired OTP.' });
      return;
    }

    otpRecord.isUsed = true;
    await otpRecord.save();

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await User.findByIdAndUpdate(user._id, { password: hashedPassword, refreshToken: '' });

    res
      .status(200)
      .json({ message: 'Password reset successfully. Please login with your new password.' });
  } catch (err: any) {
    res.status(500).json({ message: 'Password reset failed: ' + err.message });
  }
};

// ─── CHANGE PASSWORD ──────────────────────────────────────────────────────────

export const changePassword = async (req: any, res: Response): Promise<void> => {
  try {
    if (!req.user?._id) {
      res.status(401).json({ message: 'Unauthorized.' });
      return;
    }

    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      res.status(400).json({ message: 'Current password and new password are required.' });
      return;
    }

    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      res.status(400).json({ message: passwordError });
      return;
    }

    const user = await User.findById(req.user._id).select('+password');
    if (!user?.password) {
      res
        .status(400)
        .json({ message: 'This account uses social login and has no password.' });
      return;
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      res.status(401).json({ message: 'Current password is incorrect.' });
      return;
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await User.findByIdAndUpdate(user._id, { password: hashedPassword });

    res.status(200).json({ message: 'Password changed successfully.' });
  } catch (err: any) {
    res.status(500).json({ message: 'Change password failed: ' + err.message });
  }
};

// ─── REFRESH TOKEN ────────────────────────────────────────────────────────────

export const refreshToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.body?.refreshToken || req.cookies?.refresh_token;

    if (!token) {
      res.status(400).json({ message: 'Refresh token is required.' });
      return;
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token, getRefreshKey());
    } catch {
      res.status(401).json({ message: 'Invalid or expired refresh token.' });
      return;
    }

    const user = await User.findById(decoded.id).select('+refreshToken');
    if (!user || user.refreshToken !== token) {
      res.status(401).json({ message: 'Refresh token is invalid or has been revoked.' });
      return;
    }

    const newAccessToken = generateAccessToken(String(user._id));
    const newRefreshToken = generateRefreshToken(String(user._id));

    await User.findByIdAndUpdate(user._id, { refreshToken: newRefreshToken });

    setAuthCookies(res, newAccessToken, newRefreshToken);

    res.status(200).json({
      message: 'Tokens refreshed successfully.',
      data: { accessToken: newAccessToken, refreshToken: newRefreshToken },
    });
  } catch (err: any) {
    res.status(500).json({ message: 'Token refresh failed: ' + err.message });
  }
};

// ─── GET ME ───────────────────────────────────────────────────────────────────

export const getMe = async (req: any, res: Response): Promise<void> => {
  try {
    if (!req.user?._id) {
      res.status(401).json({ message: 'Unauthorized.' });
      return;
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      res.status(404).json({ message: 'User not found.' });
      return;
    }

    res.status(200).json({ message: 'Profile retrieved successfully.', data: formatUser(user) });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to retrieve profile: ' + err.message });
  }
};

// ─── SET ACCOUNT TYPE ─────────────────────────────────────────────────────────

export const setAccountType = async (req: any, res: Response): Promise<void> => {
  try {
    if (!req.user?._id) {
      res.status(401).json({ message: 'Unauthorized.' });
      return;
    }

    const { accountType } = req.body;
    if (accountType !== 'individual' && accountType !== 'organization') {
      res.status(400).json({ message: "accountType must be 'individual' or 'organization'." });
      return;
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      res.status(404).json({ message: 'User not found.' });
      return;
    }

    if (user.onboardingComplete || user.organizationId || user.role === 'admin') {
      res.status(409).json({ message: 'Account type can no longer be changed for this account.' });
      return;
    }

    if (accountType === 'organization') {
      user.signupKind = 'organization';
      user.role = 'admin';
    } else {
      user.signupKind = 'individual';
      user.role = 'employee';
    }
    await user.save();

    try {
      const { invalidateUserCaches } = await import('./profileController');
      await invalidateUserCaches(user._id);
    } catch {
      /* cache best-effort */
    }

    res.status(200).json({ message: 'Account type updated.', data: formatUser(user) });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to set account type: ' + err.message });
  }
};

// ─── GOOGLE AUTH ──────────────────────────────────────────────────────────────

export const googleLogin = (req: Request, res: Response): void => {
  // Handled by passport.authenticate in the route
};

// ✅ FULLY REWRITTEN — fixes two bugs:
//
// Bug 1 (redirect went to backend):
//   The old code fell back to ORIGIN, which Railway sets to the backend service
//   URL, not the frontend. Now we use FRONTEND_URL exclusively.
//
// Bug 2 (mobile UA false positive):
//   The old code checked user-agent strings (Android, iPhone, etc.) which belong
//   to the *browser* a web user is visiting bubblespace.xyz on — so any Android
//   Chrome user was redirected to the bubblechat:// deep link, which is dead in
//   a browser. Mobile detection is now state-flag only: native mobile clients
//   must set state=mobile_<deeplink> when initiating the flow. Web users always
//   receive state='web' and are correctly redirected to the frontend.
export const googleCallback = async (req: any, res: Response): Promise<void> => {
  // ── Single source of truth for the frontend URL ───────────────────────────
  // CHANGE THIS: ensure FRONTEND_URL is set in your Railway backend env vars
  // to https://bubblespace.xyz (or whatever your deployed frontend domain is).
  // Do NOT rely on ORIGIN — Railway injects that as the backend's own URL.
  const FRONTEND = process.env.FRONTEND_URL || 'https://bubblespace.xyz';

  try {
    const user = req.user;
    if (!user) {
      res.redirect(`${FRONTEND}/login?error=auth_failed`);
      return;
    }

    const accessToken  = generateAccessToken(String(user._id));
    const refreshToken = generateRefreshToken(String(user._id));

    await User.findByIdAndUpdate(user._id, {
      refreshToken,
      isOnline: true,
      lastSeen: new Date(),
    });

    setAuthCookies(res, accessToken, refreshToken);

    // ── Invite-code handling (unchanged logic) ────────────────────────────────
    const rawState = req.query.state as string | undefined;
    const state    = rawState ? decodeURIComponent(rawState) : 'web';

    let inviteCode: string | undefined;
    if (state.includes('_invite_')) {
      const parts = state.split('_invite_');
      inviteCode  = parts[1] ? parts[1].trim() : undefined;
    }

    if (inviteCode && user && !user.organization) {
      try {
        const existingOrg = await Organization.findOne({ inviteCode });
        if (existingOrg) {
          user.organization   = existingOrg.name;
          user.organizationId = existingOrg._id as any;
          user.org_industry   = existingOrg.industry;
          user.org_size       = existingOrg.size;
          user.role           = 'employee';
          await user.save();

          const defaultChat = await Conversation.findOne({
            organizationId: existingOrg._id,
            isDefaultOrgChat: true,
          });
          if (defaultChat) {
            const userStr = user._id.toString();
            if (!defaultChat.users.map((id: any) => id.toString()).includes(userStr)) {
              defaultChat.users.push(user._id);
              await defaultChat.save();
            }
          }
        }
      } catch (err) {
        console.error('Failed to auto-link organization via invite code in googleCallback:', err);
      }
    }

    const userJson = encodeURIComponent(JSON.stringify(formatUser(user)));

    // ── Routing decision: state flag ONLY, never user-agent ──────────────────
    // Web flow sets state='web' (see authRoute.ts /google handler).
    // Native mobile sets state='mobile_<deeplink>' explicitly.
    // We never sniff the User-Agent here because it belongs to the browser the
    // web user is visiting bubblespace.xyz on — an Android Chrome user would
    // incorrectly match 'Android' and get sent to a dead bubblechat:// link.
    const isMobileRequest = state.startsWith('mobile_');

    if (isMobileRequest) {
      // Native mobile app: redirect into the app via custom scheme deep link
      const deepLinkBase = state.replace(/^mobile_/, '') || 'bubblechat://';
      const separator    = deepLinkBase.includes('?') ? '&' : '?';
      res.redirect(
        `${deepLinkBase}${separator}access_token=${accessToken}&refresh_token=${refreshToken}&user=${userJson}`
      );
    } else {
      // Web: always redirect to the React frontend's /auth/google/callback page
      res.redirect(
        `${FRONTEND}auth/google/callback?access_token=${accessToken}&refresh_token=${refreshToken}&user=${userJson}`
      );
    }
  } catch (err: any) {
    console.error('Google callback error:', err);

    const FRONTEND = process.env.FRONTEND_URL || 'https://bubblespace.xyz';
    const rawState = req.query.state as string | undefined;
    const state    = rawState ? decodeURIComponent(rawState) : 'web';

    if (state.startsWith('mobile_')) {
      const deepLinkBase = state.replace(/^mobile_/, '') || 'bubblechat://';
      const separator    = deepLinkBase.includes('?') ? '&' : '?';
      res.redirect(`${deepLinkBase}${separator}error=server_error`);
    } else {
      res.redirect(`${FRONTEND}/login?error=server_error`);
    }
  }
};

// ─── GOOGLE MOBILE LOGIN ──────────────────────────────────────────────────────

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export const googleMobileLogin = async (req: Request, res: Response): Promise<void> => {
  const { idToken, inviteCode } = req.body;

  if (!idToken) {
    res.status(400).json({ message: 'Google ID Token is required.' });
    return;
  }

  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      res.status(401).json({ message: 'Invalid ID token payload.' });
      return;
    }

    const { email, name, sub: googleId, picture } = payload;

    if (!email) {
      res.status(400).json({ message: 'Email address not provided in ID token.' });
      return;
    }

    const normalizedEmail = email.toLowerCase();

    const { findOrCreateGoogleUser } = await import('../utils/googleAuth');
    let user = await findOrCreateGoogleUser({
      googleId,
      email: normalizedEmail,
      fullName: name,
      avatar: picture || '',
    });

    if (inviteCode && user && !user.organization) {
      try {
        const existingOrg = await Organization.findOne({ inviteCode });
        if (existingOrg) {
          user.organization   = existingOrg.name;
          user.organizationId = existingOrg._id as any;
          user.org_industry   = existingOrg.industry;
          user.org_size       = existingOrg.size as any;
          user.role           = 'employee';
          await user.save();

          const defaultChat = await Conversation.findOne({
            organizationId: existingOrg._id,
            isDefaultOrgChat: true,
          });
          if (defaultChat) {
            const userStr = user._id.toString();
            if (!defaultChat.users.map((id: any) => id.toString()).includes(userStr)) {
              defaultChat.users.push(user._id);
              await defaultChat.save();
            }
          }

          if (user.email) {
            const summaryHtml = existingOrg.description
              ? existingOrg.description.replace(/\n/g, '<br />')
              : 'Welcome to the organization! The brain is currently ready and listening.';
            await sendWelcomeNewMemberEmail(
              user.email,
              user.full_name || 'Employee',
              existingOrg.name,
              summaryHtml
            );
          }
        }
      } catch (err) {
        console.error(
          'Failed to auto-link organization via invite code in googleMobileLogin:',
          err
        );
      }
    }

    const accessToken  = generateAccessToken(String(user._id));
    const refreshToken = generateRefreshToken(String(user._id));

    await User.findByIdAndUpdate(user._id, {
      refreshToken,
      isOnline: true,
      lastSeen: new Date(),
    });

    res.status(200).json({
      message: 'Google login successful.',
      data: { accessToken, refreshToken, user: formatUser(user) },
    });
  } catch (err: any) {
    console.error('Google mobile authentication failed:', err);
    res.status(401).json({ message: 'Google token verification failed: ' + err.message });
  }
};

// ─── 2FA ──────────────────────────────────────────────────────────────────────

export const setup2FA = async (req: any, res: Response): Promise<void> => {
  try {
    if (!req.user?._id) {
      res.status(401).json({ message: 'Unauthorized.' });
      return;
    }

    const mockQrUrl =
      'https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=otpauth://totp/Bubble:User?secret=JBSWY3DPEHPK3PXP&issuer=Bubble';

    res.status(200).json({
      qrCode: mockQrUrl,
      message: 'Scan this QR code with your authenticator app.',
    });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to initialize 2FA.' });
  }
};

export const verify2FA = async (req: any, res: Response): Promise<void> => {
  try {
    if (!req.user?._id) {
      res.status(401).json({ message: 'Unauthorized.' });
      return;
    }

    const { token } = req.body;
    if (!token || token.length !== 6) {
      res.status(400).json({ success: false, message: 'Invalid 2FA token.' });
      return;
    }

    await User.findByIdAndUpdate(req.user._id, { twoFactorEnabled: true });

    res.status(200).json({ success: true, message: '2FA verification successful.' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to verify 2FA token.' });
  }
};

// ─── PUSH TOKEN ───────────────────────────────────────────────────────────────

export const savePushToken = async (req: any, res: Response): Promise<void> => {
  try {
    const userId              = req.user?._id;
    const { token, deviceType } = req.body;

    if (!userId) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    if (!token) {
      res.status(400).json({ message: 'token is required' });
      return;
    }

    await PushToken.findOneAndUpdate(
      { token },
      { userId, deviceType: deviceType || 'unknown' },
      { upsert: true, returnDocument: 'after' }
    );

    res.status(200).json({ success: true, message: 'Push token registered successfully.' });
  } catch (error: any) {
    console.error('[savePushToken] error:', error);
    res.status(500).json({ message: 'Failed to register push token.' });
  }
};

// ─── WEB PUSH (VAPID) ─────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/web-push-subscribe
 * Saves a Web Push PushSubscription object (from the browser's PushManager.subscribe()
 * call) as a push token for the authenticated user. Subsequent pushes sent by the
 * server via sendPushNotification() will be routed through VAPID Web Push for this
 * device. Calling this again with the same subscription is a no-op (upsert on endpoint).
 */
export const saveWebPushSubscription = async (req: any, res: Response): Promise<void> => {
  try {
    const userId       = req.user?._id;
    const { subscription } = req.body;

    if (!userId) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    if (!subscription?.endpoint) {
      res.status(400).json({ message: 'subscription.endpoint is required' });
      return;
    }

    // Store the full subscription JSON as the token; use endpoint as the unique key
    const tokenStr = JSON.stringify(subscription);

    await PushToken.findOneAndUpdate(
      { token: tokenStr },
      { userId, deviceType: 'web', platform: 'web' },
      { upsert: true, returnDocument: 'after' }
    );

    res.status(200).json({ success: true, message: 'Web push subscription saved.' });
  } catch (error: any) {
    console.error('[saveWebPushSubscription] error:', error);
    res.status(500).json({ message: 'Failed to save web push subscription.' });
  }
};

/**
 * GET /api/v1/auth/vapid-public-key
 * Returns the VAPID public key so the client can call PushManager.subscribe().
 * Public endpoint — no auth required (the key itself is not a secret).
 */
export const getVapidPublicKey = async (_req: Request, res: Response): Promise<void> => {
  const { getVapidPublicKey: vapidKey } = await import('../utils/webPush');
  const publicKey = vapidKey();
  if (!publicKey) {
    res.status(503).json({ message: 'Web push not configured on this server.' });
    return;
  }
  res.status(200).json({ publicKey });
};


// ─── CLERK AUTH SYNC ──────────────────────────────────────────────────────────
// Verifies a Clerk session token (issued by @clerk/clerk-expo on mobile) and
// exchanges it for our own app JWT.  Finds or creates the user by email so IDs
// stay consistent between web and mobile regardless of auth provider.
export const clerkSync = async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionToken } = req.body;
    if (!sessionToken) {
      res.status(400).json({ message: 'sessionToken is required.' });
      return;
    }

    // Lazy-import so the app starts even before CLERK_SECRET_KEY is set.
    const { createClerkClient, verifyToken: clerkVerifyToken } = await import('@clerk/backend');
    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

    // Resolve the Clerk user from either a session ID (from OAuth flow) or a JWT.
    let clerkUserId: string;
    if (sessionToken.startsWith('sess_')) {
      // `sessionToken` is actually a Clerk session ID from useOAuth's createdSessionId.
      const session = await clerk.sessions.getSession(sessionToken);
      if (!session || session.status !== 'active') {
        res.status(401).json({ message: 'Clerk session is invalid or expired.' });
        return;
      }
      clerkUserId = session.userId;
    } else {
      // Treat as a Clerk JWT for email/password sign-in.
      try {
        const payload = await clerkVerifyToken(sessionToken, { secretKey: process.env.CLERK_SECRET_KEY });
        clerkUserId = payload.sub;
      } catch {
        res.status(401).json({ message: 'Invalid or expired Clerk session token.' });
        return;
      }
    }

    // Fetch the Clerk user to get their email and profile.
    const clerkUser = await clerk.users.getUser(clerkUserId);
    const email = clerkUser.emailAddresses?.[0]?.emailAddress;
    if (!email) {
      res.status(400).json({ message: 'Clerk account has no verified email address.' });
      return;
    }

    // Find existing user or create a new one.
    let user = await User.findOne({ email });
    if (!user) {
      const full_name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || clerkUser.username || email.split('@')[0];
      const uniqueTag = await generateUniqueTag(full_name);
      user = await User.create({
        email,
        full_name,
        username: clerkUser.username || email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '_'),
        avatar: clerkUser.imageUrl || undefined,
        clerkId: clerkUser.id,
        isVerified: true,
        signupKind: 'individual',
        uniqueTag,
        onboardingStep: 'awaiting_profile',
      } as any);
    } else {
      // Sync Clerk metadata in case it changed.
      const updates: Record<string, any> = { clerkId: clerkUser.id };
      if (!user.avatar && clerkUser.imageUrl) updates.avatar = clerkUser.imageUrl;
      if (!user.full_name && clerkUser.firstName) updates.full_name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ');
      await User.findByIdAndUpdate(user._id, updates);
      user = (await User.findById(user._id))!;
    }

    const accessToken = generateAccessToken(String(user._id));
    const newRefreshToken = generateRefreshToken(String(user._id));
    await User.findByIdAndUpdate(user._id, { refreshToken: newRefreshToken, isOnline: true, lastSeen: new Date() });

    res.status(200).json({
      message: 'Clerk sync successful.',
      data: { accessToken, refreshToken: newRefreshToken, user: formatUser(user) },
    });
  } catch (error: any) {
    console.error('[clerkSync] error:', error);
    res.status(500).json({ message: 'Clerk sync failed.' });
  }
};




// import { Request, Response } from 'express';
// import bcrypt from 'bcryptjs';
// import jwt from 'jsonwebtoken';
// import crypto from 'crypto';
// import { OAuth2Client } from 'google-auth-library';
// import { User } from '../models/users';
// import { Organization } from '../models/organizations';
// import { Otp } from '../models/otp';
// import { PushToken } from '../models/pushToken';
// import { sendOTPEmail, sendPasswordResetEmail, sendWelcomeNewMemberEmail } from '../utils/mailer';
// import { seedOrgKnowledge } from './orgController';
// import { Conversation } from '../models/conversations';
// import { Message } from '../models/messages';
// import { getAidaBotUser } from './aidaController';
// import { logActivity } from './activityLogController';

// // ─── Token Helpers ────────────────────────────────────────────────────────────

// const generateAccessToken = (userId: string) =>
//   jwt.sign({ id: userId }, process.env.JWT_KEY as string, { expiresIn: '7d' });

// const generateRefreshToken = (userId: string) =>
//   jwt.sign({ id: userId }, (process.env.JWT_REFRESH_KEY || process.env.JWT_REFRESH_SECRET || 'bubble_default_refresh_key') as string, { expiresIn: '30d' });

// // ─── OTP Helper ───────────────────────────────────────────────────────────────

// const generateOTP = (): string =>
//   Math.floor(10000 + Math.random() * 90000).toString(); // 5-digit OTP

// // ─── Format Helper ────────────────────────────────────────────────────────────

// const formatUser = (u: any) => ({
//   id: u._id,
//   full_name: u.full_name || null,
//   email: u.email || null,
//   phone_number: u.phone_number || null,
//   avatar: u.avatar || null,
//   uniqueTag: u.uniqueTag || null,
//   bio: u.bio || null,
//   organization: u.organization || null,
//   org_role: u.org_role || null,
//   org_industry: u.org_industry || null,
//   org_size: u.org_size || null,
//   onboardingComplete: u.onboardingComplete ?? false,
//   signupKind: u.signupKind || 'individual',
//   onboardingStep: u.onboardingStep || (u.onboardingComplete ? 'complete' : (u.isVerified ? 'awaiting_profile' : 'awaiting_otp')),
//   isVerified: u.isVerified ?? false,
//   isPremium: u.isPremium ?? false,
//   is_bot: u.is_bot ?? false,
//   verified_badge: u.verified_badge ?? false,
//   isOnline: u.isOnline ?? false,
//   publicKey: u.publicKey || null,
//   role: u.role || 'employee',
//   isSocialAccount: !!u.googleId,
//   createdAt: u.createdAt,
//   updatedAt: u.updatedAt,
// });

// // ─── Unique BubbleID Tag ──────────────────────────────────────────────────────

// const generateUniqueTag = async (base: string): Promise<string> => {
//   let tag: string;
//   let exists: boolean;
//   const cleanBase = base.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'bubble';
//   do {
//     const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
//     const suffix = Array.from({ length: 8 }, () =>
//       chars[Math.floor(Math.random() * chars.length)]
//     ).join('');
//     tag = `${cleanBase}-${suffix}`;
//     exists = !!(await User.findOne({ uniqueTag: tag }));
//   } while (exists);
//   return tag;
// };

// // ─── Password Validator ────────────────────────────────────────────────────────
// const validatePassword = (password: string): string | null => {
//   if (password.length < 8) return 'Password must be at least 8 characters long.';
//   if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter.';
//   if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter.';
//   if (!/\d/.test(password)) return 'Password must contain at least one number.';
//   if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) return 'Password must contain at least one special character.';
//   return null;
// };

// // ─── CHECK USER STATUS ────────────────────────────────────────────────────────
// /**
//  * GET /api/v1/auth/status?email=...&phone_number=...
//  * Public, no-auth probe so the signup/login UI can predict the user's state
//  * before issuing destructive calls. Returns whether the identifier already has
//  * an account and, if so, where they are in the signup state machine.
//  *
//  * Response shape:
//  *   { exists, isVerified, onboardingStep, signupKind, hasOrg, role, nextAction }
//  *
//  * `nextAction` is a hint for the client:
//  *   - 'register'        → no account; safe to call /auth/register
//  *   - 'verify_otp'      → account exists but not verified
//  *   - 'login_then_setup'→ verified but onboarding incomplete; user should log in
//  *   - 'login'           → fully onboarded; user should just log in
//  */
// export const checkUserStatus = async (req: Request, res: Response): Promise<void> => {
//   try {
//     const emailRaw = (req.query.email as string | undefined)?.trim().toLowerCase();
//     const phoneRaw = (req.query.phone_number as string | undefined)?.trim();

//     if (!emailRaw && !phoneRaw) {
//       res.status(400).json({ message: 'email or phone_number is required.' });
//       return;
//     }

//     const filter: any = emailRaw ? { email: emailRaw } : { phone_number: phoneRaw };
//     const user = await User.findOne(filter).select(
//       'isVerified onboardingComplete onboardingStep signupKind organization organizationId role'
//     );

//     if (!user) {
//       res.status(200).json({
//         data: {
//           exists: false,
//           nextAction: 'register',
//         },
//       });
//       return;
//     }

//     // Derive step for legacy users that pre-date the field.
//     const step =
//       user.onboardingStep ||
//       (user.onboardingComplete ? 'complete' : user.isVerified ? 'awaiting_profile' : 'awaiting_otp');

//     const nextAction =
//       step === 'awaiting_otp'
//         ? 'verify_otp'
//         : step === 'complete'
//         ? 'login'
//         : 'login_then_setup';

//     res.status(200).json({
//       data: {
//         exists: true,
//         isVerified: !!user.isVerified,
//         onboardingStep: step,
//         signupKind: user.signupKind || 'individual',
//         hasOrg: !!user.organizationId,
//         role: user.role || 'employee',
//         nextAction,
//       },
//     });
//   } catch (err: any) {
//     res.status(500).json({ message: 'Status check failed: ' + err.message });
//   }
// };

// // ─── REGISTER ─────────────────────────────────────────────────────────────────
// /**
//  * POST /api/v1/auth/register
//  * Creates unverified account and sends OTP to email
//  */
// export const register = async (req: Request, res: Response): Promise<void> => {
//   try {
//     const { full_name, email, phone_number, password, publicKey, org_name, org_industry, org_size, signupKind: signupKindInput } = req.body;

//     if (!email && !phone_number) {
//       res.status(400).json({ message: 'Email or phone number is required.' });
//       return;
//     }

//     if (!password) {
//       res.status(400).json({ message: 'Password is required.' });
//       return;
//     }

//     const passwordError = validatePassword(password);
//     if (passwordError) {
//       res.status(400).json({ message: passwordError });
//       return;
//     }

//     // Derive signupKind: explicit input wins, else infer from org_name / inviteCode.
//     const cleanOrgName = org_name ? org_name.trim() : '';
//     const hasInviteCode = !!req.body.inviteCode;
//     const signupKind: 'individual' | 'organization' =
//       signupKindInput === 'individual' || signupKindInput === 'organization'
//         ? signupKindInput
//         : (cleanOrgName || hasInviteCode) ? 'organization' : 'individual';

//     // ── Resume-friendly conflict handling ─────────────────────────────────
//     // If an UNVERIFIED account exists for this email/phone, treat this call as
//     // a resume of a prior interrupted signup: regenerate an OTP and return the
//     // same 201 shape. Only block (409) when the existing account is verified.
//     const existingByEmail = email ? await User.findOne({ email: email.toLowerCase() }) : null;
//     const existingByPhone = !existingByEmail && phone_number ? await User.findOne({ phone_number }) : null;
//     const existing = existingByEmail || existingByPhone;

//     if (existing) {
//       if (existing.isVerified) {
//         res.status(409).json({
//           message: 'An account with this identifier already exists. Please log in.',
//           data: { onboardingStep: existing.onboardingStep || 'complete', requiresLogin: true },
//         });
//         return;
//       }

//       // Unverified — resume. Regenerate OTP, refresh password/signupKind in case they changed it.
//       const otp = generateOTP();
//       const otpExpires = new Date(Date.now() + 10 * 60 * 1000);
//       const hashedPasswordResume = await bcrypt.hash(password, 12);
//       existing.password = hashedPasswordResume;
//       existing.signupKind = signupKind;
//       existing.onboardingStep = 'awaiting_otp';
//       await existing.save();

//       await Otp.create({
//         userId: existing._id,
//         otp,
//         type: 'verification',
//         expiresAt: otpExpires,
//       });

//       if (existing.email) {
//         try {
//           await sendOTPEmail(existing.email, existing.full_name || 'User', otp);
//         } catch (emailErr: any) {
//           console.warn(`⚠️ Could not send OTP email to ${existing.email}:`, emailErr.message);
//           console.log(`[DEV/TESTING] OTP for ${existing.email} is: ${otp}`);
//         }
//       }

//       res.status(201).json({
//         message: 'Resuming signup. A fresh OTP has been sent.',
//         data: {
//           email: existing.email || null,
//           phone_number: existing.phone_number || null,
//           requiresVerification: true,
//           expiresInMinutes: 10,
//           onboardingStep: 'awaiting_otp',
//           signupKind,
//           resumed: true,
//         },
//       });
//       return;
//     }

//     const hashedPassword = await bcrypt.hash(password, 12);
//     const otp = generateOTP();
//     const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
//     const uniqueTag = await generateUniqueTag(full_name || 'user');

//     // Clean org values to prevent enum validation crashes
//     const cleanOrgIndustry = cleanOrgName ? (org_industry || '') : '';
//     const validOrgSizes = ['solo', '2-10', '11-50', '51-200', '201-500', '500+'];
//     const cleanOrgSize = (cleanOrgName && org_size && validOrgSizes.includes(org_size)) ? org_size : undefined;

//     // Create new user
//     const newUser = await User.create({
//       full_name,
//       email: email?.toLowerCase(),
//       phone_number: phone_number || undefined,
//       password: hashedPassword,
//       isVerified: false,
//       uniqueTag,
//       onboardingComplete: false,
//       signupKind,
//       onboardingStep: 'awaiting_otp',
//       publicKey,
//       organization: cleanOrgName,
//       org_industry: cleanOrgIndustry,
//       org_size: cleanOrgSize,
//       role: cleanOrgName ? 'admin' : 'employee',
//     });

//     // Handle Organization Registration
//     let organization = null;
//     if (cleanOrgName) {
//       const inviteCode = crypto.randomBytes(16).toString('hex').toUpperCase(); // Secure 32-char invite code (impossible to clash)
//       organization = await Organization.create({
//         name: cleanOrgName,
//         industry: cleanOrgIndustry || undefined,
//         size: cleanOrgSize,
//         owner: newUser._id,
//         inviteCode,
//         pineconeNamespace: `org-${newUser._id}`,
//       });

//       // Canonical org reference on the user
//       await User.findByIdAndUpdate(newUser._id, { organizationId: organization._id });

//       // Seed basic knowledge for the organization
//       await seedOrgKnowledge(organization, (newUser._id as any).toString());

//       // Create default group chat
//       const bot = await getAidaBotUser();
//       const botId = bot ? bot._id : null;
//       const defaultChat = await Conversation.create({
//         chatName: cleanOrgName,
//         isGroupChat: true,
//         users: botId ? [newUser._id, botId] : [newUser._id],
//         groupAdmin: newUser._id,
//         groupIcon: 'black',
//         groupDescription: `Default group chat for ${cleanOrgName}`,
//         organizationId: organization._id,
//         isDefaultOrgChat: true,
//       });

//       if (botId) {
//         const welcomeContent = `👋 **Welcome to the ${cleanOrgName} Workspace on Bubble!**\n\nI am **Aida**, your workspace intelligence assistant. I will automatically index shared resources and meeting transcripts to grow our collective business brain.\n\nAll members who join will automatically be added to this default group chat. Feel free to collaborate, share documents, schedule calls, and ask me anything!`;
//         const initialMsg = await Message.create({
//           chat: defaultChat._id,
//           sender: botId,
//           content: welcomeContent,
//           message_type: 'text',
//         });
//         defaultChat.latestMessage = (initialMsg as any)._id;
//         await defaultChat.save();
//       }
//     } else if (req.body.inviteCode) {
//       // Handle joining an existing organization during signup
//       const existingOrg = await Organization.findOne({ inviteCode: req.body.inviteCode });
//       if (existingOrg) {
//         await User.findByIdAndUpdate(newUser._id, {
//           organization: existingOrg.name,
//           organizationId: existingOrg._id,
//           org_industry: existingOrg.industry,
//           org_size: existingOrg.size,
//           role: 'employee',
//         });

//         // Add to default group chat
//         const defaultChat = await Conversation.findOne({
//           organizationId: existingOrg._id,
//           isDefaultOrgChat: true,
//         });

//         if (defaultChat) {
//           if (!defaultChat.users.map((id: any) => id.toString()).includes(newUser._id.toString())) {
//             defaultChat.users.push(newUser._id);
//             await defaultChat.save();
//           }
//         }

//         // Send welcome email (as they joined and completed signup here)
//         if (newUser.email) {
//           const summaryHtml = existingOrg.description 
//             ? existingOrg.description.replace(/\n/g, '<br />') 
//             : 'Welcome to the organization! The brain is currently ready and listening.';
          
//           await sendWelcomeNewMemberEmail(newUser.email, newUser.full_name || newUser.username || 'Employee', existingOrg.name, summaryHtml);
//         }
//       }
//     }

//     await Otp.create({
//       userId: newUser._id,
//       otp,
//       type: 'verification',
//       expiresAt: otpExpires,
//     });

//     // Send OTP via email
//     if (email) {
//       try {
//         await sendOTPEmail(email, full_name || 'User', otp);
//       } catch (emailErr: any) {
//         console.warn(`⚠️ Could not send OTP email to ${email}:`, emailErr.message);
//         console.log(`[DEV/TESTING] OTP for ${email} is: ${otp}`);
//       }
//     }

//     // No tokens issued for unverified users
//     res.status(201).json({
//       message: 'Account created. Please verify your email with the OTP sent.',
//       data: {
//         email: newUser.email || null,
//         phone_number: newUser.phone_number || null,
//         requiresVerification: true,
//         expiresInMinutes: 10,
//         onboardingStep: 'awaiting_otp',
//         signupKind,
//         resumed: false,
//       },
//     });
//   } catch (err: any) {
//     res.status(500).json({ message: 'Registration failed: ' + err.message });
//   }
// };

// // ─── VERIFY OTP ───────────────────────────────────────────────────────────────
// /**
//  * POST /api/v1/auth/verify-otp
//  * Verifies the OTP and marks account as verified, returns tokens
//  */
// export const verifyOTP = async (req: Request, res: Response): Promise<void> => {
//   try {
//     const { email, otp } = req.body;

//     if (!email || !otp) {
//       res.status(400).json({ message: 'Email and OTP are required.' });
//       return;
//     }

//     const user = await User.findOne({ email: email.toLowerCase() });
//     if (!user) {
//       res.status(404).json({ message: 'User not found.' });
//       return;
//     }

//     if (user.isVerified) {
//       res.status(400).json({ message: 'Account is already verified. Please login.' });
//       return;
//     }

//     const otpRecord = await Otp.findOne({
//       userId: user._id,
//       otp: otp.toString(),
//       type: 'verification',
//       isUsed: false,
//       expiresAt: { $gt: new Date() },
//     });

//     if (!otpRecord) {
//       res.status(400).json({ message: 'Invalid or expired OTP. Please check and try again.' });
//       return;
//     }

//     // Mark OTP used
//     otpRecord.isUsed = true;
//     await otpRecord.save();

//     // Mark verified and advance signup state machine to the next step.
//     // Individuals go to profile only. Organization founders also need profile first; we
//     // advance to awaiting_org during profile setup if they still have org work to do.
//     const refreshToken = generateRefreshToken(String(user._id));
//     await User.findByIdAndUpdate(user._id, {
//       isVerified: true,
//       isOnline: true,
//       lastSeen: new Date(),
//       refreshToken,
//       onboardingStep: 'awaiting_profile',
//     });

//     const accessToken = generateAccessToken(String(user._id));

//     res.status(200).json({
//       message: 'Email verified successfully. Welcome to Bubble!',
//       data: {
//         accessToken,
//         refreshToken,
//         user: formatUser(user),
//       },
//     });
//   } catch (err: any) {
//     res.status(500).json({ message: 'OTP verification failed: ' + err.message });
//   }
// };

// // ─── RESEND OTP ───────────────────────────────────────────────────────────────
// /**
//  * POST /api/v1/auth/resend-otp
//  */
// export const resendOTP = async (req: Request, res: Response): Promise<void> => {
//   try {
//     const { email } = req.body;

//     if (!email) {
//       res.status(400).json({ message: 'Email is required.' });
//       return;
//     }

//     const user = await User.findOne({ email: email.toLowerCase() });
//     if (!user) {
//       res.status(404).json({ message: 'User not found.' });
//       return;
//     }

//     if (user.isVerified) {
//       res.status(400).json({ message: 'Account is already verified.' });
//       return;
//     }

//     const otp = generateOTP();
//     const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

//     await Otp.create({
//       userId: user._id,
//       otp,
//       type: 'verification',
//       expiresAt: otpExpires,
//     });

//     if (user.email) {
//       try {
//         await sendOTPEmail(user.email, user.full_name || 'User', otp);
//       } catch (emailErr: any) {
//         console.warn(`⚠️ Could not send OTP email to ${user.email}:`, emailErr.message);
//         console.log(`[DEV/TESTING] OTP for ${user.email} is: ${otp}`);
//       }
//     }

//     res.status(200).json({
//       message: 'A new OTP has been sent to your email.',
//       data: {
//         userId: user._id,
//         otpSentTo: user.email || user.phone_number,
//         expiresInMinutes: 10,
//       },
//     });
//   } catch (err: any) {
//     res.status(500).json({ message: 'Resend OTP failed: ' + err.message });
//   }
// };

// // ─── LOGIN ────────────────────────────────────────────────────────────────────
// /**
//  * POST /api/v1/auth/login
//  */
// export const login = async (req: Request, res: Response): Promise<void> => {
//   try {
//     const { email, phone_number, password } = req.body;

//     if (!email && !phone_number) {
//       res.status(400).json({ message: 'Email or phone number is required.' });
//       return;
//     }

//     if (!password) {
//       res.status(400).json({ message: 'Password is required.' });
//       return;
//     }

//     const passwordError = validatePassword(password);
//     if (passwordError) {
//       res.status(400).json({ message: passwordError });
//       return;
//     }

//     const query = email
//       ? { email: email.toLowerCase() }
//       : { phone_number };

//     const user = await User.findOne(query).select('+password +refreshToken');
//     if (!user) {
//       res.status(401).json({ message: 'No account found with these credentials.' });
//       return;
//     }

//     if (!user.isVerified) {
//       // Re-send OTP and prompt them to verify
//       const otp = generateOTP();
//       const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

//       await Otp.create({
//         userId: user._id,
//         otp,
//         type: 'verification',
//         expiresAt: otpExpires,
//       });

//       if (user.email) {
//         try {
//           await sendOTPEmail(user.email, user.full_name || 'User', otp);
//         } catch (emailErr: any) {
//           console.warn(`⚠️ Could not send OTP email to ${user.email}:`, emailErr.message);
//           console.log(`[DEV/TESTING] OTP for ${user.email} is: ${otp}`);
//         }
//       }

//       res.status(200).json({
//         message: 'Account is not verified. A new OTP has been sent to your email.',
//         data: {
//           email: user.email || null,
//           phone_number: user.phone_number || null,
//           requiresVerification: true,
//         },
//       });
//       return;
//     }

//     if (!user.password) {
//       res.status(400).json({ message: 'This account uses social login. Please sign in with Google.' });
//       return;
//     }

//     const isMatch = await bcrypt.compare(password, user.password);
//     if (!isMatch) {
//       res.status(401).json({ message: 'Incorrect password.' });
//       return;
//     }

//     const accessToken = generateAccessToken(String(user._id));
//     const refreshToken = generateRefreshToken(String(user._id));

//     await User.findByIdAndUpdate(user._id, {
//       refreshToken,
//       isOnline: true,
//       lastSeen: new Date(),
//     });

//     logActivity({
//       actor: user._id,
//       action: 'login',
//       entityType: 'Auth',
//       ip: req.ip,
//       userAgent: req.headers['user-agent'],
//     });

//     res.status(200).json({
//       message: 'Login successful. Welcome back!',
//       data: {
//         accessToken,
//         refreshToken,
//         user: formatUser(user),
//       },
//     });
//   } catch (err: any) {
//     res.status(500).json({ message: 'Login failed: ' + err.message });
//   }
// };

// // ─── LOGOUT ───────────────────────────────────────────────────────────────────
// /**
//  * POST /api/v1/auth/logout
//  */
// export const logout = async (req: any, res: Response): Promise<void> => {
//   try {
//     if (!req.user?._id) {
//       res.status(401).json({ message: 'Unauthorized.' });
//       return;
//     }

//     await User.findByIdAndUpdate(req.user._id, {
//       refreshToken: '',
//       isOnline: false,
//       lastSeen: new Date(),
//       socketId: '',
//     });

//     logActivity({
//       actor: req.user._id,
//       action: 'logout',
//       entityType: 'Auth',
//       ip: req.ip,
//       userAgent: req.headers['user-agent'],
//     });

//     res.status(200).json({ message: 'Logged out successfully.' });
//   } catch (err: any) {
//     res.status(500).json({ message: 'Logout failed: ' + err.message });
//   }
// };

// // ─── FORGOT PASSWORD ──────────────────────────────────────────────────────────
// /**
//  * POST /api/v1/auth/forgot-password
//  */
// export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
//   try {
//     const { email } = req.body;

//     if (!email) {
//       res.status(400).json({ message: 'Email is required.' });
//       return;
//     }

//     const user = await User.findOne({ email: email.toLowerCase() });
//     // Always return 200 to prevent email enumeration
//     if (!user) {
//       res.status(200).json({
//         message: 'If an account with that email exists, a reset link has been sent.',
//       });
//       return;
//     }

//     const otp = generateOTP();
//     const otpExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

//     await Otp.create({
//       userId: user._id,
//       otp,
//       type: 'reset',
//       expiresAt: otpExpires,
//     });

//     try {
//       await sendPasswordResetEmail(user.email!, user.full_name || 'User', otp);
//     } catch (emailErr: any) {
//       console.warn(`⚠️ Could not send password reset email to ${user.email}:`, emailErr.message);
//       console.log(`[DEV/TESTING] Reset OTP for ${user.email} is: ${otp}`);
//     }

//     res.status(200).json({
//       message: 'If an account with that email exists, a verification code has been sent.',
//     });
//   } catch (err: any) {
//     res.status(500).json({ message: 'Forgot password failed: ' + err.message });
//   }
// };

// // ─── RESET PASSWORD ───────────────────────────────────────────────────────────
// /**
//  * POST /api/v1/auth/reset-password
//  */
// export const resetPassword = async (req: Request, res: Response): Promise<void> => {
//   try {
//     const { email, otp, newPassword } = req.body;

//     if (!email || !otp || !newPassword) {
//       res.status(400).json({ message: 'Email, Verification OTP, and new password are required.' });
//       return;
//     }

//     const passwordError = validatePassword(newPassword);
//     if (passwordError) {
//       res.status(400).json({ message: passwordError });
//       return;
//     }

//     const user = await User.findOne({ email: email.toLowerCase() });
//     if (!user) {
//       res.status(400).json({ message: 'Invalid or expired OTP.' });
//       return;
//     }

//     const otpRecord = await Otp.findOne({
//       userId: user._id,
//       otp: otp.toString(),
//       type: 'reset',
//       isUsed: false,
//       expiresAt: { $gt: new Date() },
//     });

//     if (!otpRecord) {
//       res.status(400).json({ message: 'Invalid or expired OTP.' });
//       return;
//     }

//     otpRecord.isUsed = true;
//     await otpRecord.save();

//     const hashedPassword = await bcrypt.hash(newPassword, 12);

//     await User.findByIdAndUpdate(user._id, {
//       password: hashedPassword,
//       refreshToken: '', // Invalidate all existing sessions
//     });

//     res.status(200).json({ message: 'Password reset successfully. Please login with your new password.' });
//   } catch (err: any) {
//     res.status(500).json({ message: 'Password reset failed: ' + err.message });
//   }
// };

// // ─── CHANGE PASSWORD (Authenticated) ─────────────────────────────────────────
// /**
//  * POST /api/v1/auth/change-password
//  */
// export const changePassword = async (req: any, res: Response): Promise<void> => {
//   try {
//     if (!req.user?._id) {
//       res.status(401).json({ message: 'Unauthorized.' });
//       return;
//     }

//     const { currentPassword, newPassword } = req.body;

//     if (!currentPassword || !newPassword) {
//       res.status(400).json({ message: 'Current password and new password are required.' });
//       return;
//     }

//     const passwordError = validatePassword(newPassword);
//     if (passwordError) {
//       res.status(400).json({ message: passwordError });
//       return;
//     }

//     const user = await User.findById(req.user._id).select('+password');
//     if (!user?.password) {
//       res.status(400).json({ message: 'This account uses social login and has no password.' });
//       return;
//     }

//     const isMatch = await bcrypt.compare(currentPassword, user.password);
//     if (!isMatch) {
//       res.status(401).json({ message: 'Current password is incorrect.' });
//       return;
//     }

//     const hashedPassword = await bcrypt.hash(newPassword, 12);
//     await User.findByIdAndUpdate(user._id, { password: hashedPassword });

//     res.status(200).json({ message: 'Password changed successfully.' });
//   } catch (err: any) {
//     res.status(500).json({ message: 'Change password failed: ' + err.message });
//   }
// };

// // ─── REFRESH TOKEN ────────────────────────────────────────────────────────────
// /**
//  * POST /api/v1/auth/refresh-token
//  */
// export const refreshToken = async (req: Request, res: Response): Promise<void> => {
//   try {
//     const { refreshToken: token } = req.body;

//     if (!token) {
//       res.status(400).json({ message: 'Refresh token is required.' });
//       return;
//     }

//     let decoded: any;
//     try {
//       decoded = jwt.verify(token, (process.env.JWT_REFRESH_KEY || process.env.JWT_REFRESH_SECRET || 'bubble_default_refresh_key') as string);
//     } catch {
//       res.status(401).json({ message: 'Invalid or expired refresh token.' });
//       return;
//     }

//     const user = await User.findById(decoded.id).select('+refreshToken');
//     if (!user || user.refreshToken !== token) {
//       res.status(401).json({ message: 'Refresh token is invalid or has been revoked.' });
//       return;
//     }

//     const newAccessToken = generateAccessToken(String(user._id));
//     const newRefreshToken = generateRefreshToken(String(user._id));

//     await User.findByIdAndUpdate(user._id, { refreshToken: newRefreshToken });

//     res.status(200).json({
//       message: 'Tokens refreshed successfully.',
//       data: {
//         accessToken: newAccessToken,
//         refreshToken: newRefreshToken,
//       },
//     });
//   } catch (err: any) {
//     res.status(500).json({ message: 'Token refresh failed: ' + err.message });
//   }
// };

// // ─── GET ME ───────────────────────────────────────────────────────────────────
// /**
//  * GET /api/v1/auth/me
//  * Returns the currently authenticated user's profile
//  */
// export const getMe = async (req: any, res: Response): Promise<void> => {
//   try {
//     if (!req.user?._id) {
//       res.status(401).json({ message: 'Unauthorized.' });
//       return;
//     }

//     const user = await User.findById(req.user._id);
//     if (!user) {
//       res.status(404).json({ message: 'User not found.' });
//       return;
//     }

//     res.status(200).json({
//       message: 'Profile retrieved successfully.',
//       data: formatUser(user),
//     });
//   } catch (err: any) {
//     res.status(500).json({ message: 'Failed to retrieve profile: ' + err.message });
//   }
// };

// // ─── SET ACCOUNT TYPE ─────────────────────────────────────────────────────────
// /**
//  * POST /api/v1/auth/account-type
//  * One-time, pre-onboarding promotion that lets social (Google) accounts choose
//  * between an individual or an organization account during onboarding — the same
//  * choice email signups make on the signup page.
//  *
//  * Picking 'organization' sets role=admin + signupKind=organization, which is what
//  * unlocks the org onboarding steps. The Organization document itself is still
//  * created later in setupProfile via ensureOrganizationForFounder, exactly like the
//  * email flow. No org doc is created here.
//  */
// export const setAccountType = async (req: any, res: Response): Promise<void> => {
//   try {
//     if (!req.user?._id) {
//       res.status(401).json({ message: 'Unauthorized.' });
//       return;
//     }

//     const { accountType } = req.body;
//     if (accountType !== 'individual' && accountType !== 'organization') {
//       res.status(400).json({ message: "accountType must be 'individual' or 'organization'." });
//       return;
//     }

//     const user = await User.findById(req.user._id);
//     if (!user) {
//       res.status(404).json({ message: 'User not found.' });
//       return;
//     }

//     // One-time, pre-onboarding only. Reject once the user has committed.
//     if (user.onboardingComplete || user.organizationId || user.role === 'admin') {
//       res.status(409).json({ message: 'Account type can no longer be changed for this account.' });
//       return;
//     }

//     if (accountType === 'organization') {
//       user.signupKind = 'organization';
//       user.role = 'admin';
//     } else {
//       user.signupKind = 'individual';
//       user.role = 'employee';
//     }
//     await user.save();

//     // Drop any cached profile so the next /profile/me reflects the new role/kind.
//     try {
//       const { invalidateUserCaches } = await import('./profileController');
//       await invalidateUserCaches(user._id);
//     } catch { /* cache best-effort */ }

//     res.status(200).json({
//       message: 'Account type updated.',
//       data: formatUser(user),
//     });
//   } catch (err: any) {
//     res.status(500).json({ message: 'Failed to set account type: ' + err.message });
//   }
// };

// // ─── GOOGLE AUTH ─────────────────────────────────────────────────────────────
// /**
//  * Initiates the Google OAuth flow.
//  * Note: This is typically handled directly in the routes with passport.authenticate.
//  */
// export const googleLogin = (req: Request, res: Response): void => {
//   // Logic is in the routes
// };

// /**
//  * Handles the Google OAuth callback.
//  * Passport has already authenticated the user and attached it to req.user.
//  */
// export const googleCallback = async (req: any, res: Response): Promise<void> => {
//   try {
//     const user = req.user;
//     if (!user) {
//       res.redirect(`${process.env.FRONTEND_URL || process.env.ORIGIN || 'http://localhost:5173'}/login?error=auth_failed`);
//       return;
//     }

//     const accessToken = generateAccessToken(String(user._id));
//     const refreshToken = generateRefreshToken(String(user._id));

//     // Update user's refresh token and online status
//     await User.findByIdAndUpdate(user._id, {
//       refreshToken,
//       isOnline: true,
//       lastSeen: new Date(),
//     });

//     const userJson = encodeURIComponent(JSON.stringify(formatUser(user)));
//     const rawState = req.query.state as string;
//     const state = rawState ? decodeURIComponent(rawState) : '';

//     // Extract inviteCode if present in state (e.g. mobile_..._invite_INVITECODE)
//     let inviteCode: string | undefined = undefined;
//     if (state && state.includes('_invite_')) {
//       const parts = state.split('_invite_');
//       inviteCode = parts[1] ? parts[1].trim() : undefined;
//     }

//     // Link user to organization via inviteCode if user has no organization yet
//     if (inviteCode && user && !user.organization) {
//       try {
//         const existingOrg = await Organization.findOne({ inviteCode });
//         if (existingOrg) {
//           user.organization = existingOrg.name;
//           user.organizationId = existingOrg._id as any;
//           user.org_industry = existingOrg.industry;
//           user.org_size = existingOrg.size;
//           user.role = 'employee';
//           await user.save();

//           // Add user to the default group chat of this organization
//           const defaultChat = await Conversation.findOne({
//             organizationId: existingOrg._id,
//             isDefaultOrgChat: true,
//           });
//           if (defaultChat) {
//             const userStr = user._id.toString();
//             if (!defaultChat.users.map((id: any) => id.toString()).includes(userStr)) {
//               defaultChat.users.push(user._id);
//               await defaultChat.save();
//             }
//           }
//         }
//       } catch (err) {
//         console.error('Failed to auto-link organization via invite code in googleCallback:', err);
//       }
//     }

//     const userAgent = req.headers['user-agent'] || '';
//     const isMobileUA = userAgent.includes('Expo')
//       || userAgent.includes('Android')
//       || userAgent.includes('iPhone')
//       || userAgent.includes('iPad')
//       || (userAgent.includes('Mobile') && !userAgent.includes('Macintosh'));
//     const isMobileRequest = (state && state.startsWith('mobile_')) || isMobileUA;

//     let redirectUrl = `${process.env.FRONTEND_URL || process.env.ORIGIN || 'http://localhost:5173'}/auth/google/callback?access_token=${accessToken}&refresh_token=${refreshToken}&user=${userJson}`;
    
//     if (isMobileRequest) {
//       let targetCallback = '';
//       if (state && state.startsWith('mobile_')) {
//         targetCallback = state.replace('mobile_', '');
//       } else {
//         targetCallback = 'bubblechat://';
//       }
//       const separator = targetCallback.includes('?') ? '&' : '?';
//       redirectUrl = `${targetCallback}${separator}access_token=${accessToken}&refresh_token=${refreshToken}&user=${userJson}`;
//     }

//     res.redirect(redirectUrl);
//   } catch (err: any) {
//     console.error('Google callback error:', err);
//     const rawState = req.query.state as string;
//     const state = rawState ? decodeURIComponent(rawState) : '';
//     const userAgent = req.headers['user-agent'] || '';
//     const isMobileUA = userAgent.includes('Expo')
//       || userAgent.includes('Android')
//       || userAgent.includes('iPhone')
//       || userAgent.includes('iPad')
//       || (userAgent.includes('Mobile') && !userAgent.includes('Macintosh'));
//     const isMobileRequest = (state && state.startsWith('mobile_')) || isMobileUA;

//     if (isMobileRequest) {
//       let targetCallback = '';
//       if (state && state.startsWith('mobile_')) {
//         targetCallback = state.replace('mobile_', '');
//       } else {
//         targetCallback = 'bubblechat://';
//       }
//       const separator = targetCallback.includes('?') ? '&' : '?';
//       res.redirect(`${targetCallback}${separator}error=server_error`);
//     } else {
//       res.redirect(`${process.env.FRONTEND_URL || process.env.ORIGIN || 'http://localhost:5173'}/login?error=server_error`);
//     }
//   }
// };

// const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// /**
//  * Handles Native Google Sign-In verification for mobile clients.
//  * Verifies ID Token, registers or links the user, processes optional invites, and returns JWT tokens.
//  */
// export const googleMobileLogin = async (req: Request, res: Response): Promise<void> => {
//   const { idToken, inviteCode } = req.body;

//   if (!idToken) {
//     res.status(400).json({ message: 'Google ID Token is required.' });
//     return;
//   }

//   try {
//     // 1. Verify the token Google gave the mobile app
//     const ticket = await client.verifyIdToken({
//       idToken,
//       audience: process.env.GOOGLE_CLIENT_ID,
//     });

//     const payload = ticket.getPayload();
//     if (!payload) {
//       res.status(401).json({ message: 'Invalid ID token payload.' });
//       return;
//     }

//     const { email, name, sub: googleId, picture } = payload;

//     if (!email) {
//       res.status(400).json({ message: 'Email address not provided in ID token.' });
//       return;
//     }

//     const normalizedEmail = email.toLowerCase();

//     // 2. Find or create user via the shared, hardened resolver (same logic as
//     // passport.ts) so web and mobile behave identically and recover from races.
//     const { findOrCreateGoogleUser } = await import('../utils/googleAuth');
//     let user = await findOrCreateGoogleUser({
//       googleId,
//       email: normalizedEmail,
//       fullName: name,
//       avatar: picture || '',
//     });

//     // Link user to organization via inviteCode if user has no organization yet
//     if (inviteCode && user && !user.organization) {
//       try {
//         const existingOrg = await Organization.findOne({ inviteCode });
//         if (existingOrg) {
//           user.organization = existingOrg.name;
//           user.organizationId = existingOrg._id as any;
//           user.org_industry = existingOrg.industry;
//           user.org_size = existingOrg.size as any;
//           user.role = 'employee';
//           await user.save();

//           // Add user to the default group chat of this organization
//           const defaultChat = await Conversation.findOne({
//             organizationId: existingOrg._id,
//             isDefaultOrgChat: true,
//           });
//           if (defaultChat) {
//             const userStr = user._id.toString();
//             if (!defaultChat.users.map((id: any) => id.toString()).includes(userStr)) {
//               defaultChat.users.push(user._id);
//               await defaultChat.save();
//             }
//           }

//           // Send welcome email (as they joined here)
//           if (user.email) {
//             const summaryHtml = existingOrg.description 
//               ? existingOrg.description.replace(/\n/g, '<br />') 
//               : 'Welcome to the organization! The brain is currently ready and listening.';
//             await sendWelcomeNewMemberEmail(user.email, user.full_name || 'Employee', existingOrg.name, summaryHtml);
//           }
//         }
//       } catch (err) {
//         console.error('Failed to auto-link organization via invite code in googleMobileLogin:', err);
//       }
//     }

//     // Generate session tokens
//     const accessToken = generateAccessToken(String(user._id));
//     const refreshToken = generateRefreshToken(String(user._id));

//     // Update user's refresh token and online status
//     await User.findByIdAndUpdate(user._id, {
//       refreshToken,
//       isOnline: true,
//       lastSeen: new Date(),
//     });

//     res.status(200).json({
//       message: 'Google login successful.',
//       data: {
//         accessToken,
//         refreshToken,
//         user: formatUser(user),
//       }
//     });

//   } catch (err: any) {
//     console.error('Google mobile authentication failed:', err);
//     res.status(401).json({ message: 'Google token verification failed: ' + err.message });
//   }
// };

// // ─── 2FA INTEGRATION ─────────────────────────────────────────────────────────

// export const setup2FA = async (req: any, res: Response): Promise<void> => {
//   try {
//     if (!req.user?._id) {
//       res.status(401).json({ message: 'Unauthorized.' });
//       return;
//     }

//     // In a real application, you would use 'otplib' to generate a secret
//     // and 'qrcode' to generate a data URL. 
//     // Here we return a mock data URL since package manager blocks our direct usage.

//     const mockQrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=otpauth://totp/Bubble:User?secret=JBSWY3DPEHPK3PXP&issuer=Bubble";

//     // Save the mock secret on user (JBSWY3DPEHPK3PXP in base32 would be standard)
//     // For mock, we'll verify any 6 digit token directly for demo.

//     res.status(200).json({
//       qrCode: mockQrUrl,
//       message: 'Scan this QR code with your authenticator app.'
//     });
//   } catch (err: any) {
//     res.status(500).json({ message: 'Failed to initialize 2FA.' });
//   }
// };

// export const verify2FA = async (req: any, res: Response): Promise<void> => {
//   try {
//     if (!req.user?._id) {
//       res.status(401).json({ message: 'Unauthorized.' });
//       return;
//     }

//     const { token } = req.body;
//     if (!token || token.length !== 6) {
//       res.status(400).json({ success: false, message: 'Invalid 2FA token.' });
//       return;
//     }

//     // Mark user as 2FA enabled
//     await User.findByIdAndUpdate(req.user._id, { twoFactorEnabled: true });

//     res.status(200).json({
//       success: true,
//       message: '2FA verification successful.'
//     });
//   } catch (err: any) {
//     res.status(500).json({ success: false, message: 'Failed to verify 2FA token.' });
//   }
// };

// /**
//  * Registers or updates a push token for the authenticated user.
//  * POST /api/v1/auth/push-token
//  */
// export const savePushToken = async (req: any, res: Response): Promise<void> => {
//   try {
//     const userId = req.user?._id;
//     const { token, deviceType } = req.body;

//     if (!userId) {
//       res.status(401).json({ message: 'Unauthorized' });
//       return;
//     }

//     if (!token) {
//       res.status(400).json({ message: 'token is required' });
//       return;
//     }

//     // Upsert the token mapping
//     await PushToken.findOneAndUpdate(
//       { token },
//       { userId, deviceType: deviceType || 'unknown' },
//       { upsert: true, returnDocument: 'after' }
//     );

//     res.status(200).json({ success: true, message: 'Push token registered successfully.' });
//   } catch (error: any) {
//     console.error('[savePushToken] error:', error);
//     res.status(500).json({ message: 'Failed to register push token.' });
//   }
// };