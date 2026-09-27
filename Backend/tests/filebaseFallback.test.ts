import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getBucketConfig,
  extractBucketAndKey,
  extractKeyFromUrl,
  resolveBucketForKey,
  setCachedBucket,
} from '../utils/filebase';

describe('Filebase Fallback Buckets & URL Extraction', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.FILEBASE_BUCKET;
    delete process.env.FILEBASE_FALLBACK_BUCKETS;
    delete process.env.FILEBASE_BUCKET_CREDENTIALS;
    delete process.env.FILEBASE_ACCESS_KEY;
    delete process.env.FILEBASE_SECRET_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('getBucketConfig', () => {
    it('defaults to bubblle-19 when no env is provided', () => {
      const config = getBucketConfig();
      expect(config.primaryBucket).toBe('bubblle-19');
      expect(config.fallbackBuckets).toEqual([]);
      expect(config.allBuckets).toEqual(['bubblle-19']);
    });

    it('parses primary bucket and comma-separated fallback buckets', () => {
      process.env.FILEBASE_BUCKET = 'new-bucket-2';
      process.env.FILEBASE_FALLBACK_BUCKETS = 'bubblle-19, bucket-legacy';

      const config = getBucketConfig();
      expect(config.primaryBucket).toBe('new-bucket-2');
      expect(config.fallbackBuckets).toEqual(['bubblle-19', 'bucket-legacy']);
      expect(config.allBuckets).toEqual(['new-bucket-2', 'bubblle-19', 'bucket-legacy']);
    });

    it('supports comma-separated list inside FILEBASE_BUCKET directly', () => {
      process.env.FILEBASE_BUCKET = 'bucket-3, bucket-2, bubblle-19';

      const config = getBucketConfig();
      expect(config.primaryBucket).toBe('bucket-3');
      expect(config.fallbackBuckets).toEqual(['bucket-2', 'bubblle-19']);
      expect(config.allBuckets).toEqual(['bucket-3', 'bucket-2', 'bubblle-19']);
    });

    it('deduplicates bucket names preserving priority order', () => {
      process.env.FILEBASE_BUCKET = 'bucket-active, bubblle-19';
      process.env.FILEBASE_FALLBACK_BUCKETS = 'bubblle-19, bucket-standby, bucket-active';

      const config = getBucketConfig();
      expect(config.primaryBucket).toBe('bucket-active');
      expect(config.fallbackBuckets).toEqual(['bubblle-19', 'bucket-standby']);
      expect(config.allBuckets).toEqual(['bucket-active', 'bubblle-19', 'bucket-standby']);
    });

    it('parses inline per-bucket credentials (bucket:key:secret)', () => {
      process.env.FILEBASE_ACCESS_KEY = 'primary_key';
      process.env.FILEBASE_SECRET_KEY = 'primary_secret';
      process.env.FILEBASE_BUCKET = 'new-bucket';
      process.env.FILEBASE_FALLBACK_BUCKETS = 'old-bucket:old_key:old_secret';

      const config = getBucketConfig();
      expect(config.allBuckets).toEqual(['new-bucket', 'old-bucket']);
      expect(config.bucketCredentials['new-bucket']).toEqual({
        accessKeyId: 'primary_key',
        secretAccessKey: 'primary_secret',
      });
      expect(config.bucketCredentials['old-bucket']).toEqual({
        accessKeyId: 'old_key',
        secretAccessKey: 'old_secret',
      });
    });

    it('parses JSON per-bucket credentials from FILEBASE_BUCKET_CREDENTIALS', () => {
      process.env.FILEBASE_ACCESS_KEY = 'primary_key';
      process.env.FILEBASE_SECRET_KEY = 'primary_secret';
      process.env.FILEBASE_BUCKET = 'new-bucket';
      process.env.FILEBASE_FALLBACK_BUCKETS = 'old-bucket-json';
      process.env.FILEBASE_BUCKET_CREDENTIALS = JSON.stringify({
        'old-bucket-json': { accessKey: 'json_key', secretKey: 'json_secret' },
      });

      const config = getBucketConfig();
      expect(config.bucketCredentials['old-bucket-json']).toEqual({
        accessKeyId: 'json_key',
        secretAccessKey: 'json_secret',
      });
    });
  });

  describe('extractBucketAndKey', () => {
    beforeEach(() => {
      process.env.FILEBASE_BUCKET = 'bucket-active';
      process.env.FILEBASE_FALLBACK_BUCKETS = 'bubblle-19, bucket-legacy';
    });

    it('extracts bucket and key from path-style Filebase URLs', () => {
      const res = extractBucketAndKey('https://s3.filebase.com/bubblle-19/messages/6789/test-photo.jpg');
      expect(res.bucket).toBe('bubblle-19');
      expect(res.key).toBe('messages/6789/test-photo.jpg');
    });

    it('extracts bucket and key from virtual-hosted style Filebase URLs', () => {
      const res = extractBucketAndKey('https://bubblle-19.s3.filebase.com/avatars/user123/avatar.png');
      expect(res.bucket).toBe('bubblle-19');
      expect(res.key).toBe('avatars/user123/avatar.png');
    });

    it('extracts bucket and key from active bucket URLs', () => {
      const res = extractBucketAndKey('https://s3.filebase.com/bucket-active/workspace/123/doc.pdf');
      expect(res.bucket).toBe('bucket-active');
      expect(res.key).toBe('workspace/123/doc.pdf');
    });

    it('handles encoded characters in URL path', () => {
      const res = extractBucketAndKey('https://s3.filebase.com/bubblle-19/messages%2Froom-1%2Fmy%20file.pdf');
      expect(res.bucket).toBe('bubblle-19');
      expect(res.key).toBe('messages/room-1/my file.pdf');
    });

    it('handles raw keys without bucket prefix', () => {
      const res = extractBucketAndKey('messages/1234/image.png');
      expect(res.bucket).toBeUndefined();
      expect(res.key).toBe('messages/1234/image.png');
    });

    it('handles raw keys with known bucket prefix', () => {
      const res = extractBucketAndKey('bubblle-19/messages/1234/image.png');
      expect(res.bucket).toBe('bubblle-19');
      expect(res.key).toBe('messages/1234/image.png');
    });

    it('handles local /uploads/ URLs', () => {
      const res = extractBucketAndKey('/uploads/avatar_123.jpg');
      expect(res.bucket).toBeUndefined();
      expect(res.key).toBe('/uploads/avatar_123.jpg');
    });

    it('extractKeyFromUrl returns correct key for legacy compatibility', () => {
      expect(extractKeyFromUrl('https://s3.filebase.com/bubblle-19/messages/123.png')).toBe('messages/123.png');
    });
  });

  describe('resolveBucketForKey', () => {
    beforeEach(() => {
      process.env.FILEBASE_BUCKET = 'bucket-active';
      process.env.FILEBASE_FALLBACK_BUCKETS = 'bubblle-19';
    });

    it('resolves explicit bucket directly from URL with 0 overhead', async () => {
      const res = await resolveBucketForKey('https://s3.filebase.com/bubblle-19/messages/123.png');
      expect(res.bucket).toBe('bubblle-19');
      expect(res.key).toBe('messages/123.png');
      expect(res.isExplicit).toBe(true);
    });

    it('defaults to primary bucket when no bucket is specified', async () => {
      const res = await resolveBucketForKey('messages/new-file.png');
      expect(res.bucket).toBe('bucket-active');
      expect(res.key).toBe('messages/new-file.png');
      expect(res.isExplicit).toBe(false);
    });

    it('uses cached bucket mapping when set', async () => {
      await setCachedBucket('legacy-file-456.png', 'bubblle-19');
      const res = await resolveBucketForKey('legacy-file-456.png');
      expect(res.bucket).toBe('bubblle-19');
      expect(res.key).toBe('legacy-file-456.png');
      expect(res.isExplicit).toBe(true);
    });
  });
});
