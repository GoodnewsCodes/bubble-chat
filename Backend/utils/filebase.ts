import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as fs from 'fs';
import * as path from 'path';
import { Response } from 'express';
import { Readable } from 'stream';
import dotenv from 'dotenv';
dotenv.config();

const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
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
    console.log('ℹ️ Bypassing Filebase, saving file locally.');
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
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ...(downloadName && { ResponseContentDisposition: `attachment; filename="${downloadName}"` })
  });
  return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
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

  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      // Forward the client's Range header. iOS AVPlayer (voice notes / video on
      // the mobile app) probes with `Range: bytes=0-1` and REQUIRES a 206
      // Partial Content response — ignoring Range made audio silently unplayable
      // on iPhones even though the file stored and downloaded fine.
      ...(range && { Range: range }),
      ...(downloadName && { ResponseContentDisposition: `attachment; filename="${downloadName}"` })
    });

    const response = await s3Client.send(command);

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
    
    if (downloadName) {
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
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

