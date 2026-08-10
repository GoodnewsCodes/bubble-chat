import { loadEnvironment, watchEnvironmentChanges } from './utils/envLoader';
// Load environment variables (.env.local overrides .env) immediately before module imports
loadEnvironment();
watchEnvironmentChanges();

import { assertCriticalEnv } from './utils/envCheck';
assertCriticalEnv();

import express, { Request, Response } from 'express';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import mongoose from 'mongoose';
import http from 'http';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { initSocket, getIO } from './utils/socket';
import { initSecurityScheduler, initTranscriptProcessor, initTaskReminderScheduler, initActionItemFollowUpScheduler, initDailyDigestScheduler, initWeeklyDigestScheduler, initHolidayReminderScheduler, initMeetingStartRingScheduler } from './utils/scheduler';
import { initBrainEventListener } from './utils/brainEventListener';
import { warmEmbeddings } from './utils/embeddings';
import { processQueue } from './utils/queue';
import { Conversation } from './models/conversations';
import './middleware/passport';

import chatRoutes from './routes/chatRoutes';
import messageRoutes from './routes/messageRoutes';
import userRoutes from './routes/userRoutes';
import storiesRoutes from './routes/storiesRoutes';
import meetRoutes from './routes/meetRoutes';
import meetingRoutes from './routes/meetingRoutes';
import communityRoutes from './routes/communityRoutes';
import feedRoutes from './routes/feedRoutes';
import authRoutes from './routes/authRoutes';
import paymentRoutes from './routes/paymentRoutes';
import securityRoutes from './routes/securityRoutes';
import healthRoutes from './routes/healthRoutes';
import profileRoutes from './routes/profileRoutes';
import workspaceRoutes from './routes/workspaceRoutes';
import taskRoutes from './routes/taskRoutes';
import aidaRoutes from './routes/aidaRoutes';
import notificationRoutes from './routes/notificationRoutes';
import templateRoutes from './routes/templateRoutes';
import activityRoutes from './routes/activityRoutes';
import orgRoutes from './routes/orgRoutes';
import brainRoutes from './routes/brainRoutes';
import calendarRoutes from './routes/calendarRoutes';
import keyRoutes from './routes/keyRoutes';
import { seedDefaultTemplates } from './controllers/templateController';

const app = express();
app.disable('x-powered-by');

// FIX 1: Railway injects PORT dynamically — never hardcode this
const PORT = process.env.PORT || 3000;

// CORS: allow local dev + the Bubble Space production domain. Set CORS_ORIGINS
// (comma-separated) or FRONTEND_URL in the environment to add/override origins.
// No Railway host is hardcoded — production origins come from env or the line below.
const PRODUCTION_ORIGINS = [
  'https://bubblespace.xyz',
];

const allowedOrigins: string[] = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim().replace(/^FRONTEND_URL=/, ''))
  : [
    'http://localhost:8080',
    'http://localhost:8081',
    'http://localhost:5173',
    'http://localhost:3000',
    ...PRODUCTION_ORIGINS,
  ];

// Also honour the legacy FRONTEND_URL var if set
if (process.env.FRONTEND_URL) {
  const fUrl = process.env.FRONTEND_URL.replace(/^FRONTEND_URL=/, '').trim();
  if (fUrl && !allowedOrigins.includes(fUrl)) {
    allowedOrigins.push(fUrl);
  }
}

// console.log('✅ CORS allowed origins:', allowedOrigins);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman, Railway health checks)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    console.warn(`🚫 CORS blocked for origin: ${origin}`);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(compression());

// Trust proxy is required when hosted on Railway (which uses reverse proxies)
// otherwise express-rate-limit treats all users as a single IP
app.set('trust proxy', 1);

// Speed / Rate limits
const limiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 1000, // limit each IP to 1000 requests per 5 minutes
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', limiter);

// Strict limiter for public key discovery and authentication endpoints
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per 15 mins
  message: 'Security policy: Too many requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Protect brute-force targets rather than wildcarding all /auth endpoints.
// This prevents background calls to `/auth/me` or OAuth redirects from locking users out.
app.use('/api/v1/auth/login', strictLimiter);
app.use('/api/v1/auth/register', strictLimiter);
app.use('/api/v1/auth/verify-otp', strictLimiter);
app.use('/api/v1/auth/forgot-password', strictLimiter);
app.use('/api/v1/auth/reset-password', strictLimiter);
app.use('/api/v1/user/search', strictLimiter); // Prevent bulk scraping of identities

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false,
}));
// 25mb: mobile cloud backup POSTs the device's whole cached store as one JSON
// body; the default 100kb limit rejected it, leaving req.body undefined and
// crashing the backup controller.
app.use(express.json({ limit: '25mb' }));

// Parse incoming HTTP cookies for HttpOnly auth tokens
app.use((req: any, res: any, next: any) => {
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const cookies: Record<string, string> = {};
    cookieHeader.split(';').forEach((cookie: string) => {
      const parts = cookie.split('=');
      if (parts.length >= 2) {
        const name = parts[0].trim();
        const value = parts.slice(1).join('=').trim();
        cookies[name] = decodeURIComponent(value);
      }
    });
    req.cookies = cookies;
  } else {
    req.cookies = {};
  }
  next();
});

// JSON Parsing Error Handler
app.use((err: any, req: any, res: any, next: any) => {
  if (err instanceof SyntaxError && 'body' in err) {
    console.error('❌ JSON Syntax Error:', err.message);
    return res.status(400).json({ message: 'Invalid JSON payload: ' + err.message });
  }
  next();
});

// Attach Socket.io to every request
app.use((req: any, res, next) => {
  try {
    req.io = getIO();
  } catch (err) {
    // io not initialized yet during startup — safe to ignore
  }
  next();
});

// Swagger setup
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Bubble Chat API',
      version: '1.0.0',
      description: 'API documentation for the Bubble Chat backend',
    },
    servers: [
      {
        // FIX 3: Use the Railway public URL in production, fallback to localhost in dev
        url: process.env.RAILWAY_PUBLIC_DOMAIN
          ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
          : `http://localhost:${PORT}`,
        description: process.env.RAILWAY_PUBLIC_DOMAIN ? 'Production server' : 'Development server',
      },
    ],
    tags: [
      { name: 'Authentication', description: 'User registration and login operations' },
      { name: 'Messages', description: 'CRUD operations for real-time messaging' },
      { name: 'Chat', description: '1-on-1 and Group Conversation management' },
      { name: 'Users', description: 'User profile, status, and search operations' },
      { name: 'Stories', description: 'User story uploads and retrieval' },
      { name: 'Security', description: 'Protocol key rotation and security numbers' },
      { name: 'Payment', description: 'Stripe anonymous and standard checkout flow' },
      { name: 'Workspace', description: 'Per-user file buckets with access management and sharing' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', example: '60d0fe4f5311236168a109ca' },
            full_name: { type: 'string', example: 'Desmond Ubi' },
            username: { type: 'string', example: 'desmond_ubi' },
            email: { type: 'string', example: 'ubi@example.com' },
            phone_number: { type: 'string', example: '+1234567890' },
            avatar: { type: 'string', example: 'https://cdn.example.com/avatar.png' },
            gender: { type: 'string', enum: ['male', 'female', 'other', 'prefer_not_to_say'] },
            date_of_birth: { type: 'string', format: 'date' },
            status_message: { type: 'string', example: 'Available' },
            mood_emoji: { type: 'string', example: '😊' },
            hobbies: { type: 'array', items: { type: 'string' } },
            location: {
              type: 'object',
              properties: {
                city: { type: 'string' },
                country: { type: 'string' },
                timezone: { type: 'string', default: 'UTC' }
              }
            },
            isOnline: { type: 'boolean' },
            lastSeen: { type: 'string', format: 'date-time' },
            uniqueTag: { type: 'string', example: 'bubble-A3F9X7K2' },
            bio: { type: 'string' },
            isVerified: { type: 'boolean' },
            isPremium: { type: 'boolean' },
            verified_badge: { type: 'boolean' },
            publicKey: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' }
          }
        },
        Message: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            message_type: { type: 'string', enum: ['text', 'image', 'video', 'voice', 'file', 'location', 'contact', 'system'] },
            mediaUrl: { type: 'string' },
            mediaType: { type: 'string' },
            fileSize: { type: 'number' },
            is_forwarded: { type: 'boolean' },
            reactions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  user: { type: 'string' },
                  emoji: { type: 'string' },
                  timestamp: { type: 'string', format: 'date-time' }
                }
              }
            },
            sender: { $ref: '#/components/schemas/User' },
            chat: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                chatName: { type: 'string' },
                isGroupChat: { type: 'boolean' }
              }
            },
            sentAt: { type: 'string', format: 'date-time' }
          }
        },
        Conversation: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            chatName: { type: 'string' },
            isGroupChat: { type: 'boolean' },
            users: { type: 'array', items: { $ref: '#/components/schemas/User' } },
            groupAdmin: { $ref: '#/components/schemas/User' },
            groupIcon: { type: 'string' },
            groupDescription: { type: 'string' },
            latestMessage: { $ref: '#/components/schemas/Message' },
            totalMembers: { type: 'number' },
            theme: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' }
          }
        },
        Story: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            mediaType: { type: 'string', enum: ['image', 'video', 'audio', 'text'] },
            mediaUrl: { type: 'string' },
            textContent: { type: 'string' },
            author: { $ref: '#/components/schemas/User' },
            viewCount: { type: 'number' },
            remainingSeconds: { type: 'number' },
            createdAt: { type: 'string', format: 'date-time' }
          }
        }
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: ['./routes/*.ts', './index.ts'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

/**
 * @swagger
 * /api/health:
 *   get:
 *     summary: Health check endpoint
 *     responses:
 *       200:
 *         description: API is healthy
 */
app.get('/api/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'OK', message: 'Server is running smooth' });
});

app.get('/', (req: Request, res: Response) => {
  res.status(200).json({
    message: 'Welcome to the Bubble Chat Backend API! ✨',
    status: 'online'
  });
});

/**
 * @swagger
 * /status:
 *   get:
 *     summary: System status endpoint for frontend status page
 */
app.get('/status', (req: Request, res: Response) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  const overallStatus = dbStatus === 'connected' ? 'operational' : 'degraded';

  res.status(200).json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: {
      database: dbStatus
    }
  });
});

// Static upload folder bypass
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API Routes
app.use('/api/v1/chat', chatRoutes);
app.use('/api/v1/message', messageRoutes);
app.use('/api/v1/user', userRoutes);
app.use('/api/v1/story', storiesRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/profile', profileRoutes);
app.use('/api/v1/health', healthRoutes);
app.use('/api/v1/meet', meetRoutes);
app.use('/api/v1/meetings', meetingRoutes);
app.use('/api/v1/community', communityRoutes);
app.use('/api/v1/feed', feedRoutes);
app.use('/api/v1/payment', paymentRoutes);
app.use('/api/v1/security', securityRoutes);
app.use('/api/v1/workspace', workspaceRoutes);
app.use('/api/v1/tasks', taskRoutes);
app.use('/api/v1/aida', aidaRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/templates', templateRoutes);
app.use('/api/v1/activity', activityRoutes);
app.use('/api/v1/org', orgRoutes);
app.use('/api/v1/brain', brainRoutes);
app.use('/api/v1/events', calendarRoutes);
app.use('/api/v1/keys', keyRoutes);

// Catch-all error handler. Without this, errors passed to next(err) by route handlers
// or multer (e.g. fileFilter rejections, LIMIT_FILE_SIZE) fall through to Express's
// default handler, which returns a raw HTML page instead of JSON — the client's
// res.json().catch(() => ({})) then silently swallows it into a generic, unhelpful
// "Request failed: 500" with no indication of what actually went wrong.
app.use((err: any, _req: Request, res: Response, _next: any) => {
  if (err?.name === 'MulterError') {
    const messages: Record<string, string> = {
      LIMIT_FILE_SIZE: 'File is too large.',
      LIMIT_UNEXPECTED_FILE: 'Unexpected file field.',
    };
    res.status(400).json({ message: messages[err.code] || err.message || 'Upload failed.' });
    return;
  }
  console.error('[Unhandled error]', err);
  res.status(err?.status || 500).json({ message: err?.message || 'Internal server error.' });
});

// FIX 4: Create the HTTP server BEFORE connecting to MongoDB
const server = http.createServer(app);

// FIX 5: initSocket is now called RIGHT HERE before the DB connection,
// so it's attached to the server early. Socket.io attaches to the HTTP
// server object itself — it doesn't need the server to be listening yet.
initSocket(server);

const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/bubble-chat';

mongoose.connect(mongoURI, { family: 4 })
  .then(async () => {
    // console.log('✅ MongoDB connected successfully.');

    // One-time self-heal: an earlier schema named the digest date field
    // `generatedDate`; it's now `date`. The old unique index
    // (userId_1_generatedDate_-1) lingers in existing databases and makes every
    // user's 2nd daily digest fail with E11000 (dup key on generatedDate: null).
    // Drop the orphaned indexes if present — harmless once they're gone.
    try {
      const digestCol = mongoose.connection.collection('dailydigests');
      const existing = await digestCol.indexes();
      for (const stale of ['userId_1_generatedDate_-1', 'generatedDate_1']) {
        if (existing.some((i: any) => i.name === stale)) {
          await digestCol.dropIndex(stale).catch(() => undefined);
          // console.log(`🧹 Dropped stale dailydigests index: ${stale}`);
        }
      }
    } catch (err: any) {
      console.warn('Daily-digest index cleanup skipped:', err?.message || err);
    }

    initSecurityScheduler();
    initTranscriptProcessor();
    initTaskReminderScheduler();
    initMeetingStartRingScheduler();
    initActionItemFollowUpScheduler();
    initDailyDigestScheduler();
    initWeeklyDigestScheduler();
    initHolidayReminderScheduler();
    initBrainEventListener();
    // Warm the local embedding model in the background so the first brain ingest
    // isn't blocked on the one-time model download/load.
    warmEmbeddings();

    const systemUser = await import('./models/users').then(m => m.User.findOne({ is_bot: true }));
    if (systemUser) await seedDefaultTemplates(String(systemUser._id));

    // FIX 6: server.listen is now INSIDE the .then() which is correct —
    // but we also pass a hostname of '0.0.0.0' so Railway's proxy can
    // reach the container. Without this, Node may only bind to localhost
    // inside the container, making it unreachable from outside → 502.
    server.listen(Number(PORT), '0.0.0.0', () => {
      // console.log(`🚀 Server is running on port ${PORT}`);
      // console.log(`📄 Swagger docs available at /api-docs`);

      // Start Message Queue Worker
      processQueue(async (payload) => {
        try {
          const io = getIO();
          if (payload.type === 'new_message') {
            const { chatId, message } = payload;
            io.to(chatId).emit('new_message', message);

            const chatDoc = await Conversation.findById(chatId);
            if (chatDoc && chatDoc.users) {
              chatDoc.users.forEach((u: any) => {
                io.to(u.toString()).emit('new_message', message);
              });
            }
          }
        } catch (err) {
          console.error('Queue Worker Processing Error:', err);
        }
      });
    });
  })
  .catch((err) => {
    console.error('❌ MongoDB connection error:', err);
    // FIX 7: Log the full error so Railway's deploy logs show exactly what failed
    console.error('💡 Check your MONGODB_URI environment variable in Railway Variables tab');
    process.exit(1);
  });
