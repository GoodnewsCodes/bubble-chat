import express from 'express';
import passport from 'passport';
import {
  checkUserStatus,
  register,
  verifyOTP,
  resendOTP,
  login,
  logout,
  forgotPassword,
  resetPassword,
  changePassword,
  refreshToken,
  getMe,
  googleLogin,
  googleCallback,
  googleMobileLogin,
  setAccountType,
  setup2FA,
  verify2FA,
  savePushToken,
  saveWebPushSubscription,
  getVapidPublicKey,
  clerkSync,
} from '../controllers/authController';

const router = express.Router();
const jwtAuth = passport.authenticate('jwt', { session: false });

// ─── FRONTEND URL ─────────────────────────────────────────────────────────────
// CHANGE THIS: Set FRONTEND_URL in your Railway backend environment variables
// to your actual frontend domain, e.g. https://bubblespace.xyz
// Never rely on ORIGIN here — Railway sets ORIGIN to the backend service URL.
const FRONTEND = process.env.FRONTEND_URL || 'https://bubblespace.xyz';

/**
 * @swagger
 * /api/v1/auth/setup-2fa:
 *   post:
 *     tags: [Authentication]
 *     summary: Setup 2FA
 */
router.post('/setup-2fa', jwtAuth, setup2FA);

/**
 * @swagger
 * /api/v1/auth/verify-2fa:
 *   post:
 *     tags: [Authentication]
 *     summary: Verify 2FA
 */
router.post('/verify-2fa', jwtAuth, verify2FA);

/**
 * @swagger
 * /api/v1/auth/register:
 *   post:
 *     tags: [Authentication]
 *     summary: Register a new account
 */
router.post('/register', register);

// Pre-auth status probe
router.get('/status', checkUserStatus);

/**
 * @swagger
 * /api/v1/auth/verify-otp:
 *   post:
 *     tags: [Authentication]
 *     summary: Verify OTP and activate account
 */
router.post('/verify-otp', verifyOTP);

/**
 * @swagger
 * /api/v1/auth/resend-otp:
 *   post:
 *     tags: [Authentication]
 *     summary: Resend OTP to email
 */
router.post('/resend-otp', resendOTP);

/**
 * @swagger
 * /api/v1/auth/login:
 *   post:
 *     tags: [Authentication]
 *     summary: Login with email/phone and password
 */
router.post('/login', login);

/**
 * @swagger
 * /api/v1/auth/logout:
 *   post:
 *     tags: [Authentication]
 *     summary: Logout current session
 *     security:
 *       - bearerAuth: []
 */
router.post('/logout', jwtAuth, logout);

/**
 * @swagger
 * /api/v1/auth/forgot-password:
 *   post:
 *     tags: [Authentication]
 *     summary: Request a password reset OTP
 */
router.post('/forgot-password', forgotPassword);

/**
 * @swagger
 * /api/v1/auth/reset-password:
 *   post:
 *     tags: [Authentication]
 *     summary: Reset password using OTP from email
 */
router.post('/reset-password', resetPassword);

/**
 * @swagger
 * /api/v1/auth/change-password:
 *   post:
 *     tags: [Authentication]
 *     summary: Change password while authenticated
 *     security:
 *       - bearerAuth: []
 */
router.post('/change-password', jwtAuth, changePassword);

/**
 * @swagger
 * /api/v1/auth/refresh-token:
 *   post:
 *     tags: [Authentication]
 *     summary: Get new access + refresh tokens
 */
router.post('/refresh-token', refreshToken);

/**
 * @swagger
 * /api/v1/auth/me:
 *   get:
 *     tags: [Authentication]
 *     summary: Get currently authenticated user profile
 *     security:
 *       - bearerAuth: []
 */
router.get('/me', jwtAuth, getMe);

/**
 * @swagger
 * /api/v1/auth/account-type:
 *   post:
 *     tags: [Authentication]
 *     summary: Choose individual or organization account (one-time, pre-onboarding)
 *     security:
 *       - bearerAuth: []
 */
router.post('/account-type', jwtAuth, setAccountType);

/**
 * @swagger
 * /api/v1/auth/google:
 *   get:
 *     tags: [Authentication]
 *     summary: Initiate Google OAuth login flow
 */
router.get('/google', (req, res, next) => {
  // State defaults to 'web' so googleCallback never mistakes a browser
  // request for a mobile deep-link request. Mobile clients must explicitly
  // pass state=mobile_<deeplink> when initiating the flow.
  const state = req.query.state ? String(req.query.state) : 'web';
  passport.authenticate('google', { scope: ['profile', 'email'], state })(req, res, next);
});

/**
 * @swagger
 * /api/v1/auth/google/callback:
 *   get:
 *     tags: [Authentication]
 *     summary: Google OAuth callback handler
 */
router.get(
  '/google/callback',
  passport.authenticate('google', {
    session: false,
    // ✅ FIX: failureRedirect now always points to the FRONTEND, not ORIGIN.
    // ORIGIN on Railway resolves to the backend service URL, which has no /login page.
    failureRedirect: `${FRONTEND}/login?error=auth_failed`,
  }),
  googleCallback
);

/**
 * @swagger
 * /api/v1/auth/google/mobile:
 *   post:
 *     tags: [Authentication]
 *     summary: Verify native Google Sign-In token and login/register
 */
router.post('/google/mobile', googleMobileLogin);

/** POST /api/v1/auth/push-token — register Expo push token */
router.post('/push-token', jwtAuth, savePushToken);

/**
 * POST /api/v1/auth/web-push-subscribe
 * Saves a browser Web Push subscription (PushSubscription JSON) so the server
 * can deliver push notifications to this PWA install via VAPID.
 */
router.post('/web-push-subscribe', jwtAuth, saveWebPushSubscription);

/**
 * GET /api/v1/auth/vapid-public-key
 * Returns the VAPID public key needed by the browser to subscribe to push.
 * Public — no authentication required.
 */
router.get('/vapid-public-key', getVapidPublicKey);

/**
 * POST /api/v1/auth/clerk-sync
 * Verifies a Clerk session token from the mobile app and exchanges it for our
 * own app JWT.  Creates the user if they don't exist yet.
 */
router.post('/clerk-sync', clerkSync);

export default router;




// import express from 'express';
// import passport from 'passport';
// import {
//   checkUserStatus,
//   register,
//   verifyOTP,
//   resendOTP,
//   login,
//   logout,
//   forgotPassword,
//   resetPassword,
//   changePassword,
//   refreshToken,
//   getMe,
//   googleLogin,
//   googleCallback,
//   googleMobileLogin,
//   setAccountType,
//   setup2FA,
//   verify2FA,
//   savePushToken,
// } from '../controllers/authController';

// const router = express.Router();
// const jwtAuth = passport.authenticate('jwt', { session: false });

// /**
//  * @swagger
//  * /api/v1/auth/setup-2fa:
//  *   post:
//  *     tags: [Authentication]
//  *     summary: Setup 2FA
//  */
// router.post('/setup-2fa', jwtAuth, setup2FA);

// /**
//  * @swagger
//  * /api/v1/auth/verify-2fa:
//  *   post:
//  *     tags: [Authentication]
//  *     summary: Verify 2FA
//  */
// router.post('/verify-2fa', jwtAuth, verify2FA);

// /**
//  * @swagger
//  * /api/v1/auth/register:
//  *   post:
//  *     tags: [Authentication]
//  *     summary: Register a new account
//  *     description: Creates an unverified account and sends a 5-digit OTP to the provided email address.
//  *     requestBody:
//  *       required: true
//  *       content:
//  *         application/json:
//  *           schema:
//  *             type: object
//  *             required: [password]
//  *             properties:
//  *               full_name: { type: string, example: 'Desmond Ubi' }
//  *               email: { type: string, example: 'desmond@example.com' }
//  *               phone_number: { type: string, example: '+2348012345678' }
//  *               username: { type: string, example: 'desmond_ubi' }
//  *               password: { type: string, example: 'strongPassword123' }
//  *     responses:
//  *       201:
//  *         description: Account created successfully. A 5-digit pulse code has been sent to the provided email.
//  *         content:
//  *           application/json:
//  *             schema:
//  *               type: object
//  *               properties:
//  *                 message: { type: string, example: 'Account created. Please verify your email with the OTP sent.' }
//  *                 data:
//  *                   type: object
//  *                   properties:
//  *                     email: { type: string, example: 'user@example.com' }
//  *                     requiresVerification: { type: boolean, example: true }
//  *                     expiresInMinutes: { type: number, example: 10 }
//  *       400:
//  *         description: Bad request (validation failed or passwords do not match).
//  *       409:
//  *         description: Conflict (Email or Username already exists).
//  *       500:
//  *         description: Internal Server Error.
//  */
// router.post('/register', register);

// // Pre-auth status probe — used by the signup/login UI to route users to the
// // right next step (verify_otp / login_then_setup / login / register) based on
// // the existing account state, without leaking sensitive data.
// router.get('/status', checkUserStatus);

// /**
//  * @swagger
//  * /api/v1/auth/verify-otp:
//  *   post:
//  *     tags: [Authentication]
//  *     summary: Verify OTP and activate account
//  *     description: Validates the 5-digit OTP sent to the user's email. Session tokens are only issued upon successful verification.
//  *     requestBody:
//  *       required: true
//  *       content:
//  *         application/json:
//  *           schema:
//  *             type: object
//  *             required:
//  *               - email
//  *               - otp
//  *             properties:
//  *               email:
//  *                 type: string
//  *                 format: email
//  *                 example: user@bubble.chat
//  *               otp:
//  *                 type: string
//  *                 minLength: 5
//  *                 maxLength: 5
//  *                 example: "48291"
//  *     responses:
//  *       200:
//  *         description: Verified successfully. Returns JWT tokens.
//  *       400:
//  *         description: Invalid or expired OTP.
//  *       404:
//  *         description: User not found.
//  */
// router.post('/verify-otp', verifyOTP);

// /**
//  * @swagger
//  * /api/v1/auth/resend-otp:
//  *   post:
//  *     tags: [Authentication]
//  *     summary: Resend OTP to email
//  *     description: Issues a fresh 5-digit OTP and sends it to the user's registered email.
//  *     requestBody:
//  *       required: true
//  *       content:
//  *         application/json:
//  *           schema:
//  *             type: object
//  *             required:
//  *               - email
//  *             properties:
//  *               email:
//  *                 type: string
//  *                 format: email
//  *                 example: user@bubble.chat
//  *     responses:
//  *       200:
//  *         description: New OTP sent successfully.
//  *       400:
//  *         description: Account already verified or email missing.
//  *       404:
//  *         description: User not found.
//  */
// router.post('/resend-otp', resendOTP);

// /**
//  * @swagger
//  * /api/v1/auth/login:
//  *   post:
//  *     tags: [Authentication]
//  *     summary: Login with email/phone and password
//  *     requestBody:
//  *       required: true
//  *       content:
//  *         application/json:
//  *           schema:
//  *             type: object
//  *             properties:
//  *               email: { type: string, example: 'user@example.com' }
//  *               phone_number: { type: string, example: '+1234567890' }
//  *               password: { type: string, example: 'yourPassword123', required: true }
//  *     responses:
//  *       200:
//  *         description: Login successful. Returns tokens if verified, otherwise returns verification requirements.
//  *         content:
//  *           application/json:
//  *             schema:
//  *               type: object
//  *               properties:
//  *                 message: { type: string, example: 'Login successful. Welcome back!' }
//  *                 data:
//  *                   type: object
//  *                   properties:
//  *                     accessToken: { type: string }
//  *                     refreshToken: { type: string }
//  *                     user: { $ref: '#/components/schemas/User' }
//  *                     requiresVerification: { type: boolean }
//  *       401:
//  *         description: Invalid credentials or incorrect password.
//  *       500:
//  *         description: Login operation failed.
//  */
// router.post('/login', login);

// /**
//  * @swagger
//  * /api/v1/auth/logout:
//  *   post:
//  *     tags: [Authentication]
//  *     summary: Logout current session
//  *     security:
//  *       - bearerAuth: []
//  *     responses:
//  *       200:
//  *         description: Logged out successfully. Refresh token invalidated.
//  *         content:
//  *           application/json:
//  *             schema:
//  *               type: object
//  *               properties:
//  *                 message: { type: string, example: 'Logged out successfully.' }
//  *       401:
//  *         description: Unauthorized. Missing or invalid Bearer token.
//  */
// router.post('/logout', jwtAuth, logout);

// /**
//  * @swagger
//  * /api/v1/auth/forgot-password:
//  *   post:
//  *     tags: [Authentication]
//  *     summary: Request a password reset OTP
//  *     requestBody:
//  *       required: true
//  *       content:
//  *         application/json:
//  *           schema:
//  *             type: object
//  *             required: [email]
//  *             properties:
//  *               email: { type: string, format: email, example: 'user@example.com' }
//  *     responses:
//  *       200:
//  *         description: If the email matches an account, a 5-digit OTP code has been dispatched.
//  *         content:
//  *           application/json:
//  *             schema:
//  *               type: object
//  *               properties:
//  *                 message: { type: string, example: 'If an account with that email exists, a verification code has been sent.' }
//  *       500:
//  *         description: Forgot password process failed.
//  */
// router.post('/forgot-password', forgotPassword);

// /**
//  * @swagger
//  * /api/v1/auth/reset-password:
//  *   post:
//  *     tags: [Authentication]
//  *     summary: Reset password using OTP from email
//  *     requestBody:
//  *       required: true
//  *       content:
//  *         application/json:
//  *           schema:
//  *             type: object
//  *             required: [email, otp, newPassword]
//  *             properties:
//  *               email: { type: string, format: email, example: 'user@example.com' }
//  *               otp: { type: string, example: '12345' }
//  *               newPassword: { type: string, example: 'newStrongPassword123' }
//  *     responses:
//  *       200:
//  *         description: Password reset successfully. You can now login with your new credentials.
//  *         content:
//  *           application/json:
//  *             schema:
//  *               type: object
//  *               properties:
//  *                 message: { type: string, example: 'Password reset successfully. Please login with your new password.' }
//  *       400:
//  *         description: Invalid or expired OTP.
//  *       500:
//  *         description: Resource mutation failed.
//  */
// router.post('/reset-password', resetPassword);

// /**
//  * @swagger
//  * /api/v1/auth/change-password:
//  *   post:
//  *     tags: [Authentication]
//  *     summary: Change password while authenticated
//  *     security:
//  *       - bearerAuth: []
//  *     requestBody:
//  *       required: true
//  *       content:
//  *         application/json:
//  *           schema:
//  *             type: object
//  *             required: [currentPassword, newPassword]
//  *             properties:
//  *               currentPassword: { type: string, example: 'oldPassword123' }
//  *               newPassword: { type: string, example: 'newStrongPassword123' }
//  *     responses:
//  *       200:
//  *         description: Password has been successfully rotated.
//  *         content:
//  *           application/json:
//  *             schema:
//  *               type: object
//  *               properties:
//  *                 message: { type: string, example: 'Password changed successfully.' }
//  *       401:
//  *         description: Current password mismatch or Unauthorized.
//  */
// router.post('/change-password', jwtAuth, changePassword);

// /**
//  * @swagger
//  * /api/v1/auth/refresh-token:
//  *   post:
//  *     tags: [Authentication]
//  *     summary: Get new access + refresh tokens
//  *     requestBody:
//  *       required: true
//  *       content:
//  *         application/json:
//  *           schema:
//  *             type: object
//  *             required: [refreshToken]
//  *             properties:
//  *               refreshToken: { type: string, example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' }
//  *     responses:
//  *       200:
//  *         description: Access and Refresh tokens successfully rotated.
//  *         content:
//  *           application/json:
//  *             schema:
//  *               type: object
//  *               properties:
//  *                 message: { type: string, example: 'Tokens refreshed successfully.' }
//  *                 data:
//  *                   type: object
//  *                   properties:
//  *                     accessToken: { type: string }
//  *                     refreshToken: { type: string }
//  *       401:
//  *         description: Invalid or expired refresh token.
//  */
// router.post('/refresh-token', refreshToken);

// /**
//  * @swagger
//  * /api/v1/auth/me:
//  *   get:
//  *     tags: [Authentication]
//  *     summary: Get currently authenticated user profile
//  *     security:
//  *       - bearerAuth: []
//  *     responses:
//  *       200:
//  *         description: User profile retrieved successfully.
//  *         content:
//  *           application/json:
//  *             schema:
//  *               type: object
//  *               properties:
//  *                 message: { type: string, example: 'Profile retrieved successfully.' }
//  *                 data: { $ref: '#/components/schemas/User' }
//  *       401:
//  *         description: Unauthorized session.
//  */
// router.get('/me', jwtAuth, getMe);

// /**
//  * @swagger
//  * /api/v1/auth/account-type:
//  *   post:
//  *     tags: [Authentication]
//  *     summary: Choose individual or organization account (one-time, pre-onboarding)
//  *     description: Lets social (Google) accounts pick their account type during onboarding. Selecting 'organization' promotes the user to an org founder (role=admin).
//  *     security:
//  *       - bearerAuth: []
//  *     requestBody:
//  *       required: true
//  *       content:
//  *         application/json:
//  *           schema:
//  *             type: object
//  *             required: [accountType]
//  *             properties:
//  *               accountType: { type: string, enum: [individual, organization] }
//  *     responses:
//  *       200:
//  *         description: Account type updated. Returns the refreshed user.
//  *       400:
//  *         description: Invalid accountType.
//  *       409:
//  *         description: Account type can no longer be changed.
//  */
// router.post('/account-type', jwtAuth, setAccountType);

// /**
//  * @swagger
//  * /api/v1/auth/google:
//  *   get:
//  *     tags: [Authentication]
//  *     summary: Initiate Google OAuth login flow
//  *     responses:
//  *       302:
//  *         description: Redirects user to Google OAuth consent screen.
//  */
// router.get('/google', (req, res, next) => {
//   const state = req.query.state ? String(req.query.state) : 'web';
//   passport.authenticate('google', { scope: ['profile', 'email'], state })(req, res, next);
// });

// /**
//  * @swagger
//  * /api/v1/auth/google/callback:
//  *   get:
//  *     tags: [Authentication]
//  *     summary: Google OAuth callback handler
//  *     responses:
//  *       200:
//  *         description: Success. Returns JWT tokens upon successful login.
//  *       401:
//  *         description: Authentication failed.
//  */
// router.get('/google/callback', passport.authenticate('google', { session: false, failureRedirect: `${process.env.ORIGIN || 'http://localhost:5173'}/login?error=auth_failed` }), googleCallback);

// /**
//  * @swagger
//  * /api/v1/auth/google/mobile:
//  *   post:
//  *     tags: [Authentication]
//  *     summary: Verify native Google Sign-In token and login/register
//  *     requestBody:
//  *       required: true
//  *       content:
//  *         application/json:
//  *           schema:
//  *             type: object
//  *             required: [idToken]
//  *             properties:
//  *               idToken: { type: string, description: "Google ID Token" }
//  *               inviteCode: { type: string, description: "Optional organization invite code" }
//  *     responses:
//  *       200:
//  *         description: Login successful. Returns JWT tokens.
//  *       400:
//  *         description: Missing fields or invalid request.
//  *       401:
//  *         description: Google token verification failed.
//  */
// router.post('/google/mobile', googleMobileLogin);

// /** POST /api/v1/auth/push-token */
// router.post('/push-token', jwtAuth, savePushToken);

// export default router;
