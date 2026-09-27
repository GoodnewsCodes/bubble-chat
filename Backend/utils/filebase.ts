import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Response } from 'express';
import { Readable } from 'stream';
import dotenv from 'dotenv';
dotenv.config();

export const uploadsDir = process.env.VERCEL
  ? path.join('/tmp', 'uploads')
  : path.join(__dirname, '..', 'uploads');
try {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
} catch {
  // Vercel / read-only filesystem — uploads go to S3 anyway
}

export interface BucketCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface BucketConfig {
  primaryBucket: string;
  fallbackBuckets: string[];
  allBuckets: string[];
  bucketCredentials: Record<string, BucketCredentials>;
}

/**
 * Parses configured storage buckets and per-bucket credentials.
 * Supports:
 * 1. Single account (all buckets share FILEBASE_ACCESS_KEY & FILEBASE_SECRET_KEY)
 * 2. Multi-account inline: FILEBASE_FALLBACK_BUCKETS="old_bucket:access_key:secret_key,other_bucket"
 * 3. Multi-account JSON: FILEBASE_BUCKET_CREDENTIALS='{"old_bucket": {"accessKey": "...", "secretKey": "..."}}'
 * 4. Multi-account Env Vars: FILEBASE_ACCESS_KEY_MY_BUCKET=... & FILEBASE_SECRET_KEY_MY_BUCKET=...
 */
export const getBucketConfig = (): BucketConfig => {
  const defaultAccessKey = (process.env.FILEBASE_ACCESS_KEY || '').trim();
  const defaultSecretKey = (process.env.FILEBASE_SECRET_KEY || '').trim();

  const rawBucketEnv = (process.env.FILEBASE_BUCKET || '').trim();
  const rawFallbackEnv = (process.env.FILEBASE_FALLBACK_BUCKETS || '').trim();
  const rawCredentialsEnv = (process.env.FILEBASE_BUCKET_CREDENTIALS || '').trim();

  const bucketCredentials: Record<string, BucketCredentials> = {};

  // Parse JSON credentials if provided
  if (rawCredentialsEnv) {
    try {
      const parsed = JSON.parse(rawCredentialsEnv);
      for (const [bName, creds] of Object.entries(parsed)) {
        if (creds && typeof creds === 'object') {
          const acc = (creds as any).accessKey || (creds as any).accessKeyId;
          const sec = (creds as any).secretKey || (creds as any).secretAccessKey;
          if (acc && sec) {
            bucketCredentials[bName.trim()] = { accessKeyId: String(acc).trim(), secretAccessKey: String(sec).trim() };
          }
        }
      }
    } catch (e) {
      console.warn('⚠️ [Filebase] Failed to parse FILEBASE_BUCKET_CREDENTIALS JSON:', e);
    }
  }

  const parseBucketSpec = (spec: string): string => {
    const trimmed = spec.trim();
    if (!trimmed) return '';

    // Check for inline bucket:accessKey:secretKey format
    const parts = trimmed.split(':');
    if (parts.length >= 3) {
      const bName = parts[0].trim();
      const bAccess = parts[1].trim();
      const bSecret = parts.slice(2).join(':').trim();
      if (bName && bAccess && bSecret) {
        bucketCredentials[bName] = { accessKeyId: bAccess, secretAccessKey: bSecret };
        return bName;
      }
    }

    return trimmed;
  };

  const bucketListFromMain = rawBucketEnv
    ? rawBucketEnv.split(',').map(parseBucketSpec).filter(Boolean)
    : [];
  const bucketListFromFallback = rawFallbackEnv
    ? rawFallbackEnv.split(',').map(parseBucketSpec).filter(Boolean)
    : [];

  const combined = [...bucketListFromMain, ...bucketListFromFallback];
  if (combined.length === 0) {
    combined.push('bubblle-19');
  }

  const allBuckets = Array.from(new Set(combined));
  const primaryBucket = allBuckets[0];
  const fallbackBuckets = allBuckets.slice(1);

  // For any bucket without custom credentials, check environment or use primary default
  for (const bName of allBuckets) {
    if (!bucketCredentials[bName]) {
      const envKeySuffix = bName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
      const envAccess = process.env[`FILEBASE_ACCESS_KEY_${envKeySuffix}`]?.trim();
      const envSecret = process.env[`FILEBASE_SECRET_KEY_${envKeySuffix}`]?.trim();

      if (envAccess && envSecret) {
        bucketCredentials[bName] = { accessKeyId: envAccess, secretAccessKey: envSecret };
      } else if (defaultAccessKey && defaultSecretKey) {
        bucketCredentials[bName] = { accessKeyId: defaultAccessKey, secretAccessKey: defaultSecretKey };
      }
    }
  }

  return { primaryBucket, fallbackBuckets, allBuckets, bucketCredentials };
};

export const getBucket = (): string => getBucketConfig().primaryBucket;

// ─── CLIENT CONNECTION POOL ──────────────────────────────────────────────────
// Maintains reusable S3Client instances per credential pair (maximizes socket reuse & throughput)
const s3ClientPool = new Map<string, S3Client>();

export const getS3ClientForBucket = (bucketName?: string): S3Client => {
  const config = getBucketConfig();
  const targetBucket = bucketName || config.primaryBucket;
  const creds = config.bucketCredentials[targetBucket] || {
    accessKeyId: (process.env.FILEBASE_ACCESS_KEY || '').trim(),
    secretAccessKey: (process.env.FILEBASE_SECRET_KEY || '').trim(),
  };

  const poolKey = `${creds.accessKeyId}:${creds.secretAccessKey}`;
  let client = s3ClientPool.get(poolKey);
  if (!client) {
    client = new S3Client({
      endpoint: 'https://s3.filebase.com',
      region: 'us-east-1',
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
      },
      forcePathStyle: true,
    });
    s3ClientPool.set(poolKey, client);
  }
  return client;
};

export const getS3Client = (): S3Client => getS3ClientForBucket();
export const s3Client = getS3Client();

// ─── HIGH PERFORMANCE BUCKET RESOLUTION & CACHING ────────────────────────────
// In-memory key-to-bucket cache (prevents redundant S3 probe calls)
const memoryBucketCache = new Map<string, { bucket: string; expiresAt: number }>();
const MEMORY_CACHE_MAX_SIZE = 10000;
const MEMORY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const getCachedBucket = async (key: string): Promise<string | null> => {
  const now = Date.now();
  const mem = memoryBucketCache.get(key);
  if (mem) {
    if (mem.expiresAt > now) {
      return mem.bucket;
    }
    memoryBucketCache.delete(key);
  }

  try {
    const { getCache } = await import('./redis');
    const redisBucket = await getCache(`media:bucket:${key}`);
    if (redisBucket && typeof redisBucket === 'string') {
      setMemoryBucket(key, redisBucket);
      return redisBucket;
    }
  } catch {
    // Redis unavailable / optional
  }

  return null;
};

const setMemoryBucket = (key: string, bucket: string): void => {
  if (memoryBucketCache.size >= MEMORY_CACHE_MAX_SIZE) {
    const keysToDelete = Array.from(memoryBucketCache.keys()).slice(0, 1000);
    for (const k of keysToDelete) memoryBucketCache.delete(k);
  }
  memoryBucketCache.set(key, { bucket, expiresAt: Date.now() + MEMORY_CACHE_TTL_MS });
};

export const setCachedBucket = async (key: string, bucket: string): Promise<void> => {
  setMemoryBucket(key, bucket);
  try {
    const { setCache } = await import('./redis');
    await setCache(`media:bucket:${key}`, bucket, 604800);
  } catch {
    // Redis unavailable / optional
  }
};

/**
 * Extract storage bucket and key from a URL or raw key.
 * Handles both virtual-hosted style (bucket.s3.filebase.com/KEY)
 * and path-style (s3.filebase.com/bucket/KEY).
 */
export const extractBucketAndKey = (urlOrKey: string): { bucket?: string; key: string } => {
  if (!urlOrKey) return { key: '' };

  if (urlOrKey.startsWith('/uploads/') || urlOrKey.startsWith('uploads/')) {
    return { key: urlOrKey };
  }

  try {
    const parsed = new URL(urlOrKey);
    let pathname = decodeURIComponent(parsed.pathname);
    if (pathname.startsWith('/')) pathname = pathname.slice(1);

    const hostname = parsed.hostname.toLowerCase();
    const { allBuckets } = getBucketConfig();

    // Check virtual-hosted style: <bucket>.s3.filebase.com
    if (hostname.endsWith('.s3.filebase.com') || hostname.endsWith('.filebase.com')) {
      const subdomain = hostname.split('.')[0];
      if (subdomain && subdomain !== 's3') {
        return { bucket: subdomain, key: pathname };
      }
    }

    // Check path style: s3.filebase.com/<bucket>/<key>
    if (hostname === 's3.filebase.com' || hostname === 'filebase.com') {
      const firstSlashIdx = pathname.indexOf('/');
      if (firstSlashIdx !== -1) {
        const potentialBucket = pathname.substring(0, firstSlashIdx);
        const actualKey = pathname.substring(firstSlashIdx + 1);
        return { bucket: potentialBucket, key: actualKey };
      }
    }

    // Check if pathname starts with any known bucket prefix
    for (const b of allBuckets) {
      if (pathname.startsWith(`${b}/`)) {
        return { bucket: b, key: pathname.slice(b.length + 1) };
      }
    }

    return { key: pathname };
  } catch {
    // Raw key string — check if prefixed with any known bucket
    const { allBuckets } = getBucketConfig();
    for (const b of allBuckets) {
      if (urlOrKey.startsWith(`${b}/`)) {
        return { bucket: b, key: urlOrKey.slice(b.length + 1) };
      }
    }
    return { key: urlOrKey };
  }
};

/**
 * Backward compatibility helper to extract just the storage KEY.
 */
export const extractKeyFromUrl = (url: string): string => {
  return extractBucketAndKey(url).key;
};

/**
 * Resolves which bucket holds a given key without unneeded round-trips.
 * Fast-path:
 * 1. Explicit bucket extracted from URL / key (0 ms)
 * 2. In-memory cache hit (~0.001 ms)
 * 3. Redis cache hit (~0.5 ms)
 * 4. Defaults to primary bucket
 */
export const resolveBucketForKey = async (
  keyOrUrl: string
): Promise<{ bucket: string; key: string; isExplicit: boolean }> => {
  const parsed = extractBucketAndKey(keyOrUrl);
  if (parsed.bucket) {
    return { bucket: parsed.bucket, key: parsed.key, isExplicit: true };
  }

  const cached = await getCachedBucket(parsed.key);
  if (cached) {
    return { bucket: cached, key: parsed.key, isExplicit: true };
  }

  const { primaryBucket } = getBucketConfig();
  return { bucket: primaryBucket, key: parsed.key, isExplicit: false };
};

const saveFileLocally = async (
  fileData: Buffer | fs.ReadStream,
  fileKey: string
): Promise<{ url: string; key: string }> => {
  const safeFilename = fileKey.replace(/[\/\\]/g, '_');
  const localPath = path.join(uploadsDir, safeFilename);

  if (fileData instanceof fs.ReadStream) {
    const writeStream = fs.createWriteStream(localPath);
    await new Promise((resolve, reject) => {
      fileData.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
  } else {
    fs.writeFileSync(localPath, fileData);
  }

  const relativeUrl = `/uploads/${safeFilename}`;
  return { url: relativeUrl, key: relativeUrl };
};

/**
 * Upload a file stream or buffer to Filebase.
 * Uses the primary bucket by default.
 * If the primary bucket is full or errors, seamlessly falls back to standby buckets.
 * Returns { url, key, bucket }.
 */
export const uploadToFilebase = async (
  fileData: Buffer | fs.ReadStream,
  fileKey: string,
  contentType: string
): Promise<{ url: string; key: string; bucket?: string }> => {
  const { primaryBucket, allBuckets, bucketCredentials } = getBucketConfig();
  const primaryCreds = bucketCredentials[primaryBucket];
  const bypassFilebase = process.env.BYPASS_FILEBASE === 'true';

  if (bypassFilebase || !primaryCreds?.accessKeyId || !primaryCreds?.secretAccessKey || !primaryBucket) {
    if (!bypassFilebase && (!primaryCreds?.accessKeyId || !primaryCreds?.secretAccessKey || !primaryBucket)) {
      const missing: string[] = [];
      if (!primaryCreds?.accessKeyId) missing.push('FILEBASE_ACCESS_KEY');
      if (!primaryCreds?.secretAccessKey) missing.push('FILEBASE_SECRET_KEY');
      if (!primaryBucket) missing.push('FILEBASE_BUCKET');
      console.warn(`⚠️ [Filebase] Missing required storage credentials (${missing.join(', ')}). Falling back to local storage.`);
    }
    return saveFileLocally(fileData, fileKey);
  }

  let lastError: any = null;

  // Try buckets in priority order (primary first, then fallback buckets if quota reached)
  for (let i = 0; i < allBuckets.length; i++) {
    const targetBucket = allBuckets[i];
    const client = getS3ClientForBucket(targetBucket);

    try {
      let bodyData = fileData;
      // If retrying with a ReadStream, recreate stream from disk if path exists
      if (i > 0 && fileData instanceof fs.ReadStream) {
        const filePath = (fileData as any).path;
        if (filePath && typeof filePath === 'string' && fs.existsSync(filePath)) {
          bodyData = fs.createReadStream(filePath);
        }
      }

      const upload = new Upload({
        client,
        params: {
          Bucket: targetBucket,
          Key: fileKey,
          Body: bodyData,
          ContentType: contentType,
        },
      });

      await upload.done();

      // Remember where this file is stored for instant retrieval
      setCachedBucket(fileKey, targetBucket).catch(() => {});

      if (i > 0) {
        console.warn(`ℹ️ [Filebase] Upload to primary bucket failed; successfully stored in fallback bucket: "${targetBucket}"`);
      }

      const url = `https://s3.filebase.com/${targetBucket}/${fileKey}`;
      return { url, key: fileKey, bucket: targetBucket };
    } catch (error: any) {
      lastError = error;
      console.warn(`⚠️ [Filebase] S3 upload to bucket "${targetBucket}" failed:`, error?.message || error);
    }
  }

  // If all S3 buckets fail, fall back to local storage so user flow is uninterrupted
  console.warn('⚠️ [Filebase] All configured S3 buckets failed, falling back to local storage:', lastError);
  if (fileData instanceof fs.ReadStream) {
    const filePath = (fileData as any).path;
    if (filePath && typeof filePath === 'string' && fs.existsSync(filePath)) {
      const newStream = fs.createReadStream(filePath);
      return saveFileLocally(newStream, fileKey);
    }
  }
  return saveFileLocally(fileData, fileKey);
};

/**
 * Generate a short-lived (1 hour) presigned URL for accessing a private Filebase object.
 * Uses the bucket's matching credentials and S3 client.
 */
export const getSignedMediaUrl = async (keyOrUrl: string, downloadName?: string): Promise<string> => {
  if (keyOrUrl.startsWith('http') && !keyOrUrl.includes('filebase.com')) {
    return keyOrUrl;
  }
  const { bucket, key } = await resolveBucketForKey(keyOrUrl);
  const client = getS3ClientForBucket(bucket);
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(downloadName && { ResponseContentDisposition: `attachment; filename="${downloadName}"` })
  });
  return await getSignedUrl(client, command, { expiresIn: 3600 });
};

/**
 * Cached variant of getSignedMediaUrl for hot read paths (avatars, profile images).
 * Presigning is cached in Redis for 50 minutes to eliminate latency and preserve browser cache.
 */
export const getSignedMediaUrlCached = async (keyOrUrl: string): Promise<string> => {
  if (keyOrUrl.startsWith('http') && !keyOrUrl.includes('filebase.com')) {
    return keyOrUrl;
  }
  const { bucket, key } = await resolveBucketForKey(keyOrUrl);
  const cacheKey = `media:signed:${bucket}:${key}`;
  try {
    const { getCache, setCache } = await import('./redis');
    const cached = await getCache(cacheKey);
    if (cached && typeof cached === 'string') return cached;
    const signed = await getSignedMediaUrl(keyOrUrl);
    await setCache(cacheKey, signed, 3000);
    return signed;
  } catch {
    return getSignedMediaUrl(keyOrUrl);
  }
};

/**
 * Streams a Filebase object directly to the client response with proper cross-origin headers.
 * Resolves across primary and fallback buckets with correct per-bucket credentials.
 */
export const streamS3Object = async (
  keyOrUrl: string,
  res: Response,
  downloadName?: string,
  range?: string
): Promise<void> => {
  if (keyOrUrl.startsWith('http') && !keyOrUrl.includes('filebase.com')) {
    res.redirect(keyOrUrl);
    return;
  }

  const { bucket: resolvedBucket, key } = await resolveBucketForKey(keyOrUrl);

  // Handle local fallback files directly
  if (key.startsWith('/uploads/') || key.startsWith('uploads/')) {
    const filename = key.replace(/^\/?uploads\//, '');
    const localPath = path.join(uploadsDir, filename);
    if (fs.existsSync(localPath)) {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (downloadName) {
        res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      }
      fs.createReadStream(localPath).pipe(res);
      return;
    } else {
      res.status(404).json({ message: 'Local file not found' });
      return;
    }
  }

  const { allBuckets } = getBucketConfig();

  // Try the resolved bucket first, then remaining fallback buckets
  const candidateBuckets = [
    resolvedBucket,
    ...allBuckets.filter(b => b !== resolvedBucket)
  ];

  let lastError: any = null;

  for (let i = 0; i < candidateBuckets.length; i++) {
    const currentBucket = candidateBuckets[i];
    const client = getS3ClientForBucket(currentBucket);

    try {
      const command = new GetObjectCommand({
        Bucket: currentBucket,
        Key: key,
        ...(range && { Range: range }),
        ...(downloadName && { ResponseContentDisposition: `attachment; filename="${downloadName}"` })
      });

      const response = await client.send(command);

      // Successfully retrieved! Cache bucket association for future instant lookups
      setCachedBucket(key, currentBucket).catch(() => {});

      if (range && response.ContentRange) {
        res.status(206);
      }

      if (response.ContentType) {
        res.setHeader('Content-Type', response.ContentType);
      }
      if (response.ContentLength) {
        res.setHeader('Content-Length', response.ContentLength);
      }
      if (response.ContentRange) {
        res.setHeader('Content-Range', response.ContentRange);
      }
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Allow-Origin', '*');

      if (!range) {
        res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
        res.setHeader('Vary', 'Accept-Encoding');
      }

      if (downloadName) {
        res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      }

      const stream = response.Body as Readable;
      stream.pipe(res);
      return;
    } catch (error: any) {
      lastError = error;
      const isNotFound =
        error.name === 'NoSuchKey' ||
        error.name === 'NotFound' ||
        error.$metadata?.httpStatusCode === 404;

      if (!isNotFound && error.name !== 'AccessDenied') {
        break;
      }
    }
  }

  console.error(`[Filebase] Streaming error for key: ${key}`, lastError);
  if (
    lastError?.name === 'NoSuchKey' ||
    lastError?.name === 'NotFound' ||
    lastError?.$metadata?.httpStatusCode === 404
  ) {
    res.status(404).json({ message: 'File not found on storage server' });
  } else {
    res.status(500).json({ message: 'Error streaming file: ' + (lastError?.message || 'Unknown error') });
  }
};

/**
 * Delete an object across Filebase buckets with their respective credentials.
 */
export const deleteFromFilebase = async (keyOrUrl: string): Promise<void> => {
  const { bucket: explicitBucket, key } = await resolveBucketForKey(keyOrUrl);
  const { allBuckets } = getBucketConfig();

  const targets = explicitBucket ? [explicitBucket] : allBuckets;
  await Promise.allSettled(
    targets.map(bucket => {
      const client = getS3ClientForBucket(bucket);
      return client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    })
  );

  memoryBucketCache.delete(key);
  try {
    const { deleteCache } = await import('./redis');
    await deleteCache(`media:bucket:${key}`);
  } catch {}
};

/**
 * Download a Filebase/S3 object to a temp file, searching primary & fallback buckets.
 */
export const downloadS3ObjectToTempFile = async (keyOrUrl: string): Promise<string> => {
  const { bucket: resolvedBucket, key } = await resolveBucketForKey(keyOrUrl);
  const { allBuckets } = getBucketConfig();
  const ext = path.extname(key) || '.ogg';
  const tmpPath = path.join(os.tmpdir(), `egress-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);

  const candidateBuckets = [
    resolvedBucket,
    ...allBuckets.filter(b => b !== resolvedBucket)
  ];

  let lastError: any = null;

  for (const currentBucket of candidateBuckets) {
    try {
      const client = getS3ClientForBucket(currentBucket);
      const command = new GetObjectCommand({ Bucket: currentBucket, Key: key });
      const response = await client.send(command);
      const body = response.Body as Readable;

      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(tmpPath);
        body.pipe(out);
        body.on('error', reject);
        out.on('error', reject);
        out.on('finish', () => resolve());
      });

      setCachedBucket(key, currentBucket).catch(() => {});
      return tmpPath;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error(`Could not download S3 object ${key}`);
};
