import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as fs from 'fs';
import * as path from 'path';
import { Response } from 'express';
import { Readable } from 'stream';
import dotenv from 'dotenv';
dotenv.config();

const uploadsDir = process.env.VERCEL
  ? path.join('/tmp', 'uploads')
  : path.join(__dirname, '..', 'uploads');
try {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
} catch {
  // Vercel / read-only filesystem — uploads go to S3 anyway
}


const BUCKET = process.env.FILEBASE_BUCKET as string;

export const s3Client = new S3Client({
  endpoint: 'https://s3.filebase.com',
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.FILEBASE_ACCESS_KEY as string,
    secretAccessKey: process.env.FILEBASE_SECRET_KEY as string,
  },
  forcePathStyle: true, // Required for Filebase/S3-compatible
});

// ── Fallback (previous) bucket ───────────────────────────────────────────────
// After a bucket switch, files uploaded earlier still live in the old bucket. When
// FILEBASE_FALLBACK_* is configured, reads look in the current bucket first and fall back
// to the old one. Writes ALWAYS go to the current bucket.
const FALLBACK_BUCKET = process.env.FILEBASE_FALLBACK_BUCKET || '';
export const fallbackS3Client: S3Client | null =
  FALLBACK_BUCKET && process.env.FILEBASE_FALLBACK_ACCESS_KEY && process.env.FILEBASE_FALLBACK_SECRET_KEY
    ? new S3Client({
        endpoint: 'https://s3.filebase.com',
        region: 'us-east-1',
        credentials: {
          accessKeyId: process.env.FILEBASE_FALLBACK_ACCESS_KEY,
          secretAccessKey: process.env.FILEBASE_FALLBACK_SECRET_KEY,
        },
        forcePathStyle: true,
      })
    : null;

interface StorageTarget { client: S3Client; bucket: string }
const primaryTarget = (): StorageTarget => ({ client: s3Client, bucket: BUCKET });
const fallbackTarget = (): StorageTarget | null =>
  fallbackS3Client ? { client: fallbackS3Client, bucket: FALLBACK_BUCKET } : null;

const isMissingObject = (err: any): boolean =>
  err?.name === 'NoSuchKey' || err?.name === 'NoSuchBucket' || err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404 ||
  err?.name === 'AccessDenied' || err?.$metadata?.httpStatusCode === 403;

// Legacy URLs name their bucket, so we can route them straight to the right one.
const urlNamesFallbackBucket = (url: string): boolean => {
  if (!FALLBACK_BUCKET || !url.startsWith('http')) return false;
  try {
    const u = new URL(url);
    return u.hostname.startsWith(`${FALLBACK_BUCKET}.`) || u.pathname.replace(/^\//, '').startsWith(`${FALLBACK_BUCKET}/`);
  } catch { return false; }
};

// Which bucket holds this key? Remembered briefly so presigning stays cheap.
const locationCache = new Map<string, { fallback: boolean; at: number }>();
const LOCATION_TTL_MS = 10 * 60 * 1000;
const resolveTarget = async (key: string, hintFallback: boolean): Promise<StorageTarget> => {
  const fb = fallbackTarget();
  if (!fb) return primaryTarget();
  if (hintFallback) return fb;
  const hit = locationCache.get(key);
  if (hit && Date.now() - hit.at < LOCATION_TTL_MS) return hit.fallback ? fb : primaryTarget();
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    locationCache.set(key, { fallback: false, at: Date.now() });
    return primaryTarget();
  } catch (err: any) {
    if (!isMissingObject(err)) return primaryTarget(); // transient — don't cache a wrong answer
    try {
      await fb.client.send(new HeadObjectCommand({ Bucket: fb.bucket, Key: key }));
      locationCache.set(key, { fallback: true, at: Date.now() });
      return fb;
    } catch {
      return primaryTarget();
    }
  }
};

// Header-safe download names: no quotes / CR / LF / path separators.
const safeDownloadName = (name?: string): string | undefined => {
  if (!name) return undefined;
  const cleaned = name.replace(/[\u0000-\u001f\u007f"\\/]+/g, '_').trim().slice(0, 200);
  return cleaned || undefined;
};
const contentDisposition = (name: string): string =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

/**
 * Extract the storage KEY from a previously stored Filebase URL.
 * Handles both virtual-hosted style (bubblle-19.s3.filebase.com/KEY)
 * and path-style (s3.filebase.com/bubblle-19/KEY).
 */
export const extractKeyFromUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname;
    // Remove leading slash
    if (path.startsWith('/')) path = path.slice(1);
    // Strip bucket prefix for path-style URLs: "bubblle-19/messages/..." -> "messages/..."
    if (path.startsWith(`${BUCKET}/`)) {
      path = path.slice(BUCKET.length + 1);
    } else if (FALLBACK_BUCKET && path.startsWith(`${FALLBACK_BUCKET}/`)) {
      path = path.slice(FALLBACK_BUCKET.length + 1);
    }
    return path;
  } catch {
    // If URL parsing fails, assume it's already a key
    return url;
  }
};

const saveFileLocally = async (
  fileData: Buffer | fs.ReadStream,
  fileKey: string
): Promise<{ url: string; key: string }> => {
  const safeFilename = fileKey.replace(/\//g, '_');
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
 * Upload a file stream or buffer to Filebase (private bucket — no ACL).
 * IMPORTANT: We store the KEY (not the URL) for later presigning.
 * Returns { url (legacy compat), key } — always use `key` for new code.
 */
export const uploadToFilebase = async (
  fileData: Buffer | fs.ReadStream,
  fileKey: string,
  contentType: string
): Promise<{ url: string; key: string }> => {
  const accessKey = process.env.FILEBASE_ACCESS_KEY;
  const secretKey = process.env.FILEBASE_SECRET_KEY;
  const bypassFilebase = process.env.BYPASS_FILEBASE === 'true' || !accessKey || !secretKey;

  if (bypassFilebase) {
    // console.log('ℹ️ Bypassing Filebase, saving file locally.');
    return saveFileLocally(fileData, fileKey);
  }

  try {
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: BUCKET,
        Key: fileKey,
        Body: fileData,
        ContentType: contentType,
        // NOTE: No ACL — bucket is private. All access via presigned URLs.
      },
    });

    await upload.done();

    // Build a legacy URL for backward-compat with old DB records.
    // Use path-style so extractKeyFromUrl can always recover the key.
    const url = `https://s3.filebase.com/${BUCKET}/${fileKey}`;
    return { url, key: fileKey };
  } catch (error) {
    console.warn('⚠️ S3 Upload failed, falling back to local storage:', error);
    if (fileData instanceof fs.ReadStream) {
      const filePath = (fileData as any).path;
      if (filePath && typeof filePath === 'string' && fs.existsSync(filePath)) {
        const newStream = fs.createReadStream(filePath);
        return saveFileLocally(newStream, fileKey);
      }
    }
    return saveFileLocally(fileData, fileKey);
  }
};

/**
 * Generate a short-lived (1 hour) presigned URL for accessing a private Filebase object.
 * Accepts either a raw storage KEY or a full Filebase URL (both styles).
 * If downloadName is provided, explicitly triggers browser "Save As" mechanics.
 */
export const getSignedMediaUrl = async (keyOrUrl: string, downloadName?: string): Promise<string> => {
  if (keyOrUrl.startsWith('http') && !keyOrUrl.includes('filebase.com')) {
    return keyOrUrl;
  }
  const key = keyOrUrl.startsWith('http') ? extractKeyFromUrl(keyOrUrl) : keyOrUrl;
  const target = await resolveTarget(key, urlNamesFallbackBucket(keyOrUrl));
  const name = safeDownloadName(downloadName);
  const command = new GetObjectCommand({
    Bucket: target.bucket,
    Key: key,
    ...(name && { ResponseContentDisposition: contentDisposition(name) })
  });
  return await getSignedUrl(target.client, command, { expiresIn: 3600 });
};

/**
 * Cached variant of getSignedMediaUrl for hot read paths (e.g. avatars in
 * formatUser, which runs on every profile/me and getMe). Presigning on every
 * request added latency AND produced a new URL each time, defeating the browser's
 * image cache. We cache the signed URL for slightly under its 1h expiry, so
 * repeated reads reuse one stable, cacheable URL. Falls back to direct signing if
 * Redis is unavailable. Only for cacheable, non-download (no filename) URLs.
 */
export const getSignedMediaUrlCached = async (keyOrUrl: string): Promise<string> => {
  if (keyOrUrl.startsWith('http') && !keyOrUrl.includes('filebase.com')) {
    return keyOrUrl;
  }
  const key = keyOrUrl.startsWith('http') ? extractKeyFromUrl(keyOrUrl) : keyOrUrl;
  const cacheKey = `media:signed:${key}`;
  try {
    const { getCache, setCache } = await import('./redis');
    const cached = await getCache(cacheKey);
    if (cached && typeof cached === 'string') return cached;
    const signed = await getSignedMediaUrl(keyOrUrl);
    // 50 min TTL — comfortably under the 60 min presign expiry.
    await setCache(cacheKey, signed, 3000);
    return signed;
  } catch {
    return getSignedMediaUrl(keyOrUrl);
  }
};

/**
 * Streams a Filebase object directly to the client response with proper cross-origin headers.
 * Helps prevent ERR_BLOCKED_BY_RESPONSE.NotSameOrigin from browser security policies.
 */
export const streamS3Object = async (keyOrUrl: string, res: Response, downloadName?: string, range?: string): Promise<void> => {
  if (keyOrUrl.startsWith('http') && !keyOrUrl.includes('filebase.com')) {
    res.redirect(keyOrUrl);
    return;
  }
  const key = keyOrUrl.startsWith('http') ? extractKeyFromUrl(keyOrUrl) : keyOrUrl;

  // Handle local fallback files directly
  if (key.startsWith('/uploads/') || key.startsWith('uploads/')) {
    const filename = key.replace(/^\/?uploads\//, '');
    const localPath = path.join(uploadsDir, filename);
    if (fs.existsSync(localPath)) {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Allow-Origin', '*');
      const localName = safeDownloadName(downloadName);
      if (localName) {
        res.setHeader('Content-Disposition', contentDisposition(localName));
      }
      fs.createReadStream(localPath).pipe(res);
      return;
    } else {
      res.status(404).json({ message: 'Local file not found' });
      return;
    }
  }

  try {
    const name = safeDownloadName(downloadName);
    const buildCommand = (bucket: string) => new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      // Forward the client's Range header. iOS AVPlayer (voice notes / video on
      // the mobile app) probes with `Range: bytes=0-1` and REQUIRES a 206 Partial
      // Content response — ignoring Range made audio silently unplayable on iPhones.
      ...(range && { Range: range }),
      ...(name && { ResponseContentDisposition: contentDisposition(name) })
    });

    // Current bucket first; if the object isn't there, try the previous bucket.
    const fb = fallbackTarget();
    const preferFallback = urlNamesFallbackBucket(keyOrUrl);
    const first = preferFallback && fb ? fb : primaryTarget();
    const second = preferFallback ? primaryTarget() : fb;
    let response;
    try {
      response = await first.client.send(buildCommand(first.bucket));
    } catch (err: any) {
      if (!second || !isMissingObject(err)) throw err;
      response = await second.client.send(buildCommand(second.bucket));
    }

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

    // Explicitly allow cross-origin embedder policies to access this resource
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (name) {
      res.setHeader('Content-Disposition', contentDisposition(name));
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type');
    }

    const stream = response.Body as Readable;
    stream.pipe(res);
  } catch (error: any) {
    console.error(`[Filebase] Streaming error for key: ${key}`, error);
    // Fallback: If it's a NoSuchKey error or similar, return 404
    if (error.name === 'NoSuchKey') {
      res.status(404).json({ message: 'File not found on storage server' });
    } else {
      res.status(500).json({ message: 'Error streaming file: ' + error.message });
    }
  }
};

