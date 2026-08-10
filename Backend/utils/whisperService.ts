import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

// Set the path to the statically bundled ffmpeg binary
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Speech-to-text provider. Groq serves Whisper (whisper-large-v3) on an
// OpenAI-compatible API with a free tier, so we prefer it when GROQ_API_KEY is
// set and transparently fall back to OpenAI's hosted Whisper otherwise. Both use
// the same OpenAI SDK — only the baseURL, key, and model id differ.
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

const STT_MODEL = process.env.GROQ_API_KEY
  ? (process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3')
  : 'whisper-1';

const getSttClient = () => {
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    return new OpenAI({ apiKey: groqKey, baseURL: GROQ_BASE_URL });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('No speech-to-text key configured: set GROQ_API_KEY (preferred) or OPENAI_API_KEY');
  }
  return new OpenAI({ apiKey });
};

// Natively supported formats by OpenAI Whisper API (no transcoding needed)
const SUPPORTED_EXTENSIONS = [
  '.flac', '.m4a', '.mp3', '.mp4', '.mpeg', '.mpga', '.ogg', '.oga', '.wav', '.webm',
];

// All formats LiveKit and recording clients may produce — auto-transcoded to MP3 via ffmpeg
const NEEDS_TRANSCODE = ['.caf', '.amr', '.3gp', '.opus', '.aac', '.ts', '.mkv', '.mov'];

const WHISPER_MAX_BYTES = 24 * 1024 * 1024;  // 24 MB (Whisper limit 25 MB, headroom buffer)
const CHUNK_DURATION_SECONDS = 600;           // Split long recordings into 10-minute segments

/** Transcode any audio/video file to mono 16 kHz MP3 for Whisper compatibility. */
const transcodeToMp3 = (inputPath: string, outputPath: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    // console.log(`[Whisper] Transcoding → ${path.basename(outputPath)}`);
    ffmpeg(inputPath)
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate('64k')
      .toFormat('mp3')
      .on('error', (err: Error) => { console.error('[Whisper] Transcode error:', err); reject(err); })
      .on('end', () => resolve())
      .save(outputPath);
  });

/** Get audio duration in seconds via ffprobe. */
const getAudioDuration = (filePath: string): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err: Error | null, metadata: any) => {
      if (err) return reject(err);
      resolve(metadata?.format?.duration || 0);
    });
  });


/** Extract a time-ranged segment from an audio file as MP3. */
const extractSegment = (
  inputPath: string,
  outputPath: string,
  startSeconds: number,
  durationSeconds: number
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startSeconds)
      .setDuration(durationSeconds)
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate('64k')
      .toFormat('mp3')
      .on('error', (err: Error) => reject(err))
      .on('end', () => resolve())
      .save(outputPath);
  });

const makeTempPath = (dir: string, label: string) =>
  path.join(dir, `whisper-${Date.now()}-${Math.random().toString(36).slice(2)}-${label}.mp3`);

const cleanupFiles = (files: string[]) => {
  for (const f of files) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* silent */ }
  }
};

/**
 * Transcribe an audio/video file using OpenAI Whisper-1.
 * - Accepts every format LiveKit produces (opus, caf, amr, 3gp, aac, mkv, mov, ts, webm, mp4 …)
 * - Auto-transcodes non-native formats to 16 kHz mono MP3
 * - Automatically chunks recordings that exceed the 25 MB Whisper API limit
 *
 * @returns Full plain-text transcript string.
 */
export const transcribeAudio = async (filePath: string): Promise<string> => {
  if (!fs.existsSync(filePath)) throw new Error(`Audio file not found: ${filePath}`);

  const ext = path.extname(filePath).toLowerCase();
  const dir = path.dirname(filePath);
  const tempFiles: string[] = [];

  try {
    // Step 1: Ensure compatible format
    let workingPath = filePath;
    if (!SUPPORTED_EXTENSIONS.includes(ext) || NEEDS_TRANSCODE.includes(ext)) {
      const transcodedPath = makeTempPath(dir, 'tc');
      tempFiles.push(transcodedPath);
      await transcodeToMp3(filePath, transcodedPath);
      workingPath = transcodedPath;
    }

    const fileSize = fs.statSync(workingPath).size;
    const openai = getSttClient();

    // Step 2: Small file — single Whisper call
    if (fileSize <= WHISPER_MAX_BYTES) {
      const response = await openai.audio.transcriptions.create({
        file: fs.createReadStream(workingPath),
        model: STT_MODEL,
        response_format: 'text',
      });
      return typeof response === 'string' ? response : (response as any).text || '';
    }

    // Step 3: Large file — chunk into 10-min segments
    // console.log(`[Whisper] File ${(fileSize / 1024 / 1024).toFixed(1)} MB exceeds limit — chunking.`);
    const duration = await getAudioDuration(workingPath);
    const parts: string[] = [];
    let offset = 0;
    let idx = 0;

    while (offset < duration) {
      const segPath = makeTempPath(dir, `seg${idx}`);
      tempFiles.push(segPath);
      await extractSegment(workingPath, segPath, offset, CHUNK_DURATION_SECONDS);

      const response = await openai.audio.transcriptions.create({
        file: fs.createReadStream(segPath),
        model: STT_MODEL,
        response_format: 'text',
      });
      const text = typeof response === 'string' ? response : (response as any).text || '';
      if (text.trim()) parts.push(text.trim());
      // console.log(`[Whisper] Chunk ${idx + 1}: ${Math.round(offset)}s–${Math.round(Math.min(offset + CHUNK_DURATION_SECONDS, duration))}s ✓`);
      offset += CHUNK_DURATION_SECONDS;
      idx++;
    }

    return parts.join('\n\n');
  } finally {
    cleanupFiles(tempFiles);
  }
};

/**
 * Transcribe a LiveKit meeting recording and return timestamped chunks
 * suitable for the CalendarEvent/Meeting transcriptChunks array.
 *
 * @param filePath    Path to the audio/video recording.
 * @param speakerNames Optional ordered list of participant names (for heuristic speaker labels).
 * @returns Array of { speaker?, text, timestamp } objects.
 */
export const transcribeWithTimestamps = async (
  filePath: string,
  speakerNames: string[] = []
): Promise<{ speaker?: string; text: string; timestamp: number }[]> => {
  if (!fs.existsSync(filePath)) throw new Error(`Audio file not found: ${filePath}`);

  const ext = path.extname(filePath).toLowerCase();
  const dir = path.dirname(filePath);
  const tempFiles: string[] = [];

  try {
    let workingPath = filePath;
    if (!SUPPORTED_EXTENSIONS.includes(ext) || NEEDS_TRANSCODE.includes(ext)) {
      const transcodedPath = makeTempPath(dir, 'tc-ts');
      tempFiles.push(transcodedPath);
      await transcodeToMp3(filePath, transcodedPath);
      workingPath = transcodedPath;
    }

    const openai = getSttClient();
    const fileSize = fs.statSync(workingPath).size;
    const chunks: { speaker?: string; text: string; timestamp: number }[] = [];

    // A room-composite (mixed) recording can't be attributed to a specific
    // speaker, so we no longer fabricate one by rotating names on sentence breaks
    // — that produced confidently-wrong "who said what". Attribution is only
    // truthful when there's exactly one known participant; otherwise leave it
    // undefined. (True per-speaker attribution comes from the live-caption path,
    // which carries the authenticated speakerId.)
    const soleSpeaker = speakerNames.length === 1 ? speakerNames[0] : undefined;
    const processSegments = (segments: any[], timeOffset = 0) => {
      for (const seg of segments) {
        chunks.push({ speaker: soleSpeaker, text: seg.text?.trim() || '', timestamp: Math.round(timeOffset + (seg.start || 0)) });
      }
    };

    if (fileSize <= WHISPER_MAX_BYTES) {
      const response = await openai.audio.transcriptions.create({
        file: fs.createReadStream(workingPath),
        model: STT_MODEL,
        response_format: 'verbose_json',
        timestamp_granularities: ['segment'],
      }) as any;
      processSegments(response?.segments || []);
    } else {
      const duration = await getAudioDuration(workingPath);
      let offset = 0;
      let idx = 0;

      while (offset < duration) {
        const segPath = makeTempPath(dir, `seg-ts${idx}`);
        tempFiles.push(segPath);
        await extractSegment(workingPath, segPath, offset, CHUNK_DURATION_SECONDS);

        const response = await openai.audio.transcriptions.create({
          file: fs.createReadStream(segPath),
          model: STT_MODEL,
          response_format: 'verbose_json',
          timestamp_granularities: ['segment'],
        }) as any;
        processSegments(response?.segments || [], offset);
        offset += CHUNK_DURATION_SECONDS;
        idx++;
      }
    }

    return chunks;
  } finally {
    cleanupFiles(tempFiles);
  }
};
