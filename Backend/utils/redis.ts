import Redis from 'ioredis';
import dotenv from 'dotenv';
dotenv.config();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// ─── Cache / general-purpose client ─────────────────────────────────────────────
// Used only for FAST, non-blocking commands (GET/SET/DEL/LPUSH/LLEN). Because it
// never runs a blocking command, a commandTimeout is a safe guarantee that a sick
// connection can never hang a request — getCache/setCache just fall through to
// MongoDB instead. (Blocking ops like BRPOP live on `blockingRedis` below.)
const MAX_RETRIES = 10;

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  connectTimeout: 5000,
  commandTimeout: 2000,
  keepAlive: 10000,
  retryStrategy: (times) => {
    if (times > MAX_RETRIES) {
      console.warn(`⚠️ Redis: Max reconnect attempts (${MAX_RETRIES}) reached. Stopping reconnect loop.`);
      return null; // Stop retrying
    }
    const delay = Math.min(times * 500, 5000);
    // console.log(`🔄 Redis reconnect attempt #${times} in ${delay}ms...`);
    return delay;
  },
});

export const blockingRedis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  connectTimeout: 5000,
  keepAlive: 10000,
  retryStrategy: (times) => {
    if (times > MAX_RETRIES) {
      console.warn(`⚠️ Redis (blocking): Max reconnect attempts (${MAX_RETRIES}) reached. Stopping reconnect loop.`);
      return null; // Stop retrying
    }
    const delay = Math.min(times * 500, 5000);
    return delay;
  },
});

redis.on('error', (err) => {
  console.warn('⚠️ Redis Connection Error:', err.message);
});

redis.on('connect', () => {
  // console.log('✅ Connected to Redis');
});

blockingRedis.on('error', (err) => {
  console.warn('⚠️ Redis (blocking) Connection Error:', err.message);
});
blockingRedis.on('connect', () => {
  // console.log('✅ Connected to Redis (blocking client)');
});

// Only talk to Redis when the connection is actually usable. When it isn't
// ('connecting', 'reconnecting', 'close', 'end'), skip the command entirely so the
// caller falls back to the source of truth (Mongo) *instantly* instead of waiting
// out commandTimeout on a dead/half-open socket.
const isReady = () => redis.status === 'ready';

export const setCache = async (key: string, value: any, ttl?: number) => {
  if (!isReady()) return;
  try {
    const stringValue = JSON.stringify(value);
    if (ttl) {
      await redis.set(key, stringValue, 'EX', ttl);
    } else {
      await redis.set(key, stringValue);
    }
  } catch (err: any) {
    console.error(`Redis setCache error for key ${key}:`, err?.message || err);
  }
};

export const getCache = async (key: string) => {
  if (!isReady()) return null;
  try {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err: any) {
    console.error(`Redis getCache error for key ${key}:`, err?.message || err);
    return null;
  }
};

export const deleteCache = async (key: string) => {
  if (!isReady()) return;
  try {
    await redis.del(key);
  } catch (err: any) {
    console.error(`Redis deleteCache error for key ${key}:`, err?.message || err);
  }
};

export default redis;
