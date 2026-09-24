import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import {
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  S3Upload,
} from 'livekit-server-sdk';
import { s3Client, extractKeyFromUrl } from './filebase';
import { transcribeAudio } from './whisperService';

const BUCKET = process.env.FILEBASE_BUCKET as string;

/**
 * LiveKit Egress is the room-recording feature that composites a call's audio and
 * drops it in Filebase/S3. It is the cross-platform RELIABILITY BACKSTOP for
 * transcription: live captions (Socket.io) are primary, but on browsers/devices
 * without client STT (Safari, Firefox, mobile) we transcribe this recording with
 * Whisper so every meeting still produces a transcript.
 *
 * Requires the LiveKit egress worker (LiveKit Cloud provides it; self-host needs
 * the egress container). Gated by LIVEKIT_EGRESS_ENABLED so it degrades gracefully.
 */
export const isEgressEnabled = (): boolean =>
  process.env.LIVEKIT_EGRESS_ENABLED === 'true';

const getEgressClient = (): EgressClient | null => {
  const url = process.env.LIVEKIT_URL;
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!url || !key || !secret) return null;
  // EgressClient needs an https(s) host, not the wss:// realtime URL.
  const httpUrl = url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
  return new EgressClient(httpUrl, key, secret);
};

/**
 * Start room composite **audio-only** egress to Filebase/S3.
 * Returns `{ egressId, recordingKey }` so the caller can persist them on the
 * Meeting (recordingKey → later Whisper transcription; egressId → stop on end).
 * Returns null when egress is disabled or misconfigured (caller no-ops).
 */
export const startRoomAudioEgress = async (
  roomName: string
): Promise<{ egressId: string; recordingKey: string } | null> => {
  if (!isEgressEnabled()) return null;
  const client = getEgressClient();
  if (!client) {
    console.warn('[Egress] enabled but LIVEKIT_URL/API key/secret missing — skipping.');
    return null;
  }

  // Deterministic, unique key under a meetings/ prefix.
  const recordingKey = `meetings/${roomName}-${Date.now()}.ogg`;

  try {
    const fileOutput = new EncodedFileOutput({
      fileType: EncodedFileType.OGG, // audio container; Whisper handles .ogg/.oga
      filepath: recordingKey,
      output: {
        case: 's3',
        value: new S3Upload({
          accessKey: process.env.FILEBASE_ACCESS_KEY as string,
          secret: process.env.FILEBASE_SECRET_KEY as string,
          bucket: BUCKET,
          endpoint: 'https://s3.filebase.com',
          region: 'us-east-1',
          forcePathStyle: true,
        }),
      },
    });

    const info = await client.startRoomCompositeEgress(
      roomName,
      { file: fileOutput },
      { audioOnly: true }
    );

    // console.log(`[Egress] Started audio egress ${info.egressId} for room ${roomName} → ${recordingKey}`);
    return { egressId: info.egressId, recordingKey };
  } catch (err) {
    console.error('[Egress] startRoomAudioEgress failed:', err);
    return null;
  }
};

/**
 * Stop a running egress (called when the meeting ends, before transcription).
 * Best-effort: never throws to the caller.
 */
export const stopRoomAudioEgress = async (egressId?: string): Promise<void> => {
  if (!egressId || !isEgressEnabled()) return;
  const client = getEgressClient();
  if (!client) return;
  try {
    await client.stopEgress(egressId);
    // console.log(`[Egress] Stopped egress ${egressId}`);
  } catch (err) {
    console.error('[Egress] stopRoomAudioEgress failed:', err);
  }
};

/** Download a Filebase/S3 object to a temp file and return the local path. */
const downloadToTempFile = async (keyOrUrl: string): Promise<string> => {
  const key = keyOrUrl.startsWith('http') ? extractKeyFromUrl(keyOrUrl) : keyOrUrl;
  const ext = path.extname(key) || '.ogg';
  const tmpPath = path.join(os.tmpdir(), `egress-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);

  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  const response = await s3Client.send(command);
  const body = response.Body as Readable;

  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath);
    body.pipe(out);
    body.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => resolve());
  });

  return tmpPath;
};

/**
 * Transcribe a meeting's egress recording. Downloads the object to a temp file,
 * runs Whisper, and cleans up. Returns '' if no recording or on failure so the
 * caller can fall back to the live speech-recognition transcript.
 */
export const transcribeMeetingRecording = async (recordingKey?: string): Promise<string> => {
  if (!recordingKey) return '';
  let tmpPath: string | null = null;
  try {
    tmpPath = await downloadToTempFile(recordingKey);
    const text = await transcribeAudio(tmpPath);
    return text?.trim() || '';
  } catch (err) {
    console.error('[Egress] Failed to transcribe meeting recording:', err);
    return '';
  } finally {
    if (tmpPath) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* silent */ }
    }
  }
};
