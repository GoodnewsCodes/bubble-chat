import { Request, Response } from 'express';
import { IngestionJob } from '../models/ingestionJob';
import { OrgDocument } from '../models/orgDocument';
import { User } from '../models/users';
import { Organization } from '../models/organizations';
import { Conversation } from '../models/conversations';
import { Message } from '../models/messages';
import { chunkText, generateEmbedding } from '../utils/embeddings';
import { upsertVectors, hasPinecone } from '../utils/pinecone';
import { transcribeAudio } from '../utils/whisperService';
import { resolveUserOrg } from '../utils/orgResolver';
import { updateExpertiseRadar } from './continuityController';
import * as fs from 'fs';
import * as crypto from 'crypto';
import OpenAI from 'openai';

const getDeepSeekClient = () => {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key || key.startsWith('your_') || key.startsWith('add_your_')) return null;
  return new OpenAI({
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: key,
  });
};

/**
 * Helper to fetch content of external URLs (strips HTML tags).
 */
const fetchUrlText = async (url: string): Promise<string> => {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'BubbleBrainIngest/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return html
      .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, '')
      .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch (err: any) {
    throw new Error(`Failed to retrieve page content: ${err.message}`);
  }
};

/**
 * Helper to fetch a YouTube video transcript via the youtube-transcript package.
 * Falls back to video page URL scraping if transcript is unavailable.
 */
const fetchYouTubeTranscript = async (url: string): Promise<{ text: string; title: string }> => {
  try {
    // Extract video ID from various YouTube URL formats
    const match = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
    if (!match) throw new Error('Could not extract YouTube video ID from URL.');
    const videoId = match[1];

    // Try youtube-transcript package
    let transcriptText = '';
    let videoTitle = `YouTube Video: ${videoId}`;
    try {
      const { YoutubeTranscript } = await import('youtube-transcript');
      const transcript = await YoutubeTranscript.fetchTranscript(videoId);
      transcriptText = transcript.map((t: any) => t.text).join(' ');
    } catch (transcriptErr) {
      console.warn(`[Brain YouTube] Transcript unavailable for ${videoId}, falling back to page scrape.`);
      // Fallback: scrape the page for description
      transcriptText = await fetchUrlText(url);
    }

    // Try to fetch video title from oEmbed
    try {
      const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
      if (oembedRes.ok) {
        const oembedData = await oembedRes.json();
        videoTitle = oembedData.title || videoTitle;
      }
    } catch { /* silent */ }

    return { text: transcriptText, title: videoTitle };
  } catch (err: any) {
    throw new Error(`YouTube ingest failed: ${err.message}`);
  }
};

/**
 * Helper to parse Slack export JSON into a flat conversation text.
 * Slack exports are arrays of message objects: [{ text, user, ts }, ...]
 */
const parseSlackExport = (rawContent: string): string => {
  try {
    const messages = JSON.parse(rawContent);
    if (!Array.isArray(messages)) throw new Error('Expected JSON array');
    return messages
      .filter((m: any) => m.text && m.type === 'message')
      .map((m: any) => {
        const ts = m.ts ? new Date(parseFloat(m.ts) * 1000).toISOString() : '';
        return `[${ts}] ${m.user || 'user'}: ${m.text}`;
      })
      .join('\n');
  } catch {
    // If not valid JSON array, return as-is (might be pre-processed text)
    return rawContent;
  }
};

/**
 * Helper to parse an exported AI conversation (ChatGPT/Claude JSON).
 * Handles the common { messages: [{ role, content }] } format.
 */
const parseAIConversation = (rawContent: string): string => {
  try {
    const data = JSON.parse(rawContent);
    const messages = data.messages || data.conversation || data;
    if (!Array.isArray(messages)) throw new Error('Expected messages array');
    return messages
      .filter((m: any) => m.content)
      .map((m: any) => `[${(m.role || 'user').toUpperCase()}]: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n\n');
  } catch {
    return rawContent;
  }
};


/**
 * Extract plain text from an uploaded document. Handles PDF and DOCX/DOC via
 * binary parsers; everything else is read as UTF-8 (txt, md, csv, json, etc.).
 */
const extractFileText = async (filePath: string, originalName: string, mimetype: string): Promise<string> => {
  const lower = originalName.toLowerCase();
  const isPdf = mimetype === 'application/pdf' || lower.endsWith('.pdf');
  const isDocx =
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    lower.endsWith('.docx') ||
    lower.endsWith('.doc');

  if (isPdf) {
    const { PDFParse } = await import('pdf-parse');
    const buffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return result.text || '';
    } finally {
      await parser.destroy();
    }
  }

  if (isDocx) {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || '';
  }

  return fs.readFileSync(filePath, 'utf8');
};

/**
 * POST /api/brain/ingest
 * Universal ingestion route (Supports async processing, returns Job ID).
 */
export const ingest = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Derive Org ID server-side from authenticated JWT context
    const user = await User.findById(userId);
    if (!user || (!user.organizationId && !user.organization)) {
      return res.status(400).json({ error: 'User is not mapped to any organization' });
    }

    const org = await resolveUserOrg(user);
    if (!org) {
      return res.status(404).json({ error: 'Organization details not found.' });
    }

    // Admin gate — only the org owner or an admin may seed/ingest into the brain.
    const isOwner = String(org.owner) === String(user._id);
    const isAdmin = user.role === 'admin' || user.role === 'HR';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Only admins or the organization owner may ingest into the brain.' });
    }

    const { sourceType, title, content, url, chatId, tags = [], department = 'general' } = req.body;
    const file = (req as any).file;

    if (!sourceType) {
      return res.status(400).json({ error: 'sourceType is required.' });
    }

    // Initialize Job entry
    const job = await IngestionJob.create({
      userId,
      organizationId: org._id,
      sourceType,
      status: 'pending',
    });

    // Handle background task orchestration
    setImmediate(async () => {
      try {
        job.status = 'processing';
        await job.save();

        let extractedText = '';
        let finalTitle = title || 'Brain Document';

        if (sourceType === 'file' || sourceType === 'recording') {
          if (!file) throw new Error('No uploaded file found.');
          finalTitle = title || file.originalname;

          const isAudio =
            file.mimetype.startsWith('audio/') ||
            file.mimetype.startsWith('video/') ||
            ['.mp3', '.wav', '.webm', '.caf', '.amr', '.m4a', '.ogg', '.oga', '.aac', '.3gp'].some(ext =>
              file.originalname.toLowerCase().endsWith(ext)
            );

          if (isAudio) {
            extractedText = await transcribeAudio(file.path);
          } else {
            extractedText = await extractFileText(file.path, file.originalname, file.mimetype);
          }

          // Clean up temp multer file safely
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        } else if (sourceType === 'youtube') {
          if (!url) throw new Error('URL is required for YouTube ingestion.');
          const ytResult = await fetchYouTubeTranscript(url);
          extractedText = ytResult.text;
          finalTitle = title || ytResult.title;
        } else if (sourceType === 'slack_export') {
          if (!content && !file) throw new Error('Content or file is required for Slack export ingestion.');
          const rawSlack = file ? fs.readFileSync(file.path, 'utf8') : content;
          extractedText = parseSlackExport(rawSlack);
          finalTitle = title || 'Slack Export';
          if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
        } else if (sourceType === 'ai_conversation') {
          if (!content && !file) throw new Error('Content or file is required for AI conversation ingestion.');
          const rawAI = file ? fs.readFileSync(file.path, 'utf8') : content;
          extractedText = parseAIConversation(rawAI);
          finalTitle = title || 'AI Conversation Export';
          if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
        } else if (sourceType === 'holiday') {
          // Holidays are simple named entries — no enrichment needed
          extractedText = content || title || 'Public Holiday';
          finalTitle = title || 'Public Holiday';
        } else if (sourceType === 'text') {
          if (!content) throw new Error('Content is required for text ingestion.');
          extractedText = content;
        } else if (sourceType === 'url') {
          if (!url) throw new Error('URL is required for URL ingestion.');
          finalTitle = title || `Webpage: ${url}`;
          extractedText = await fetchUrlText(url);
        } else if (sourceType === 'chat') {
          if (!chatId) throw new Error('Chat ID is required for chat transcript ingestion.');
          const conversation = await Conversation.findById(chatId);
          if (!conversation) throw new Error('Conversation not found.');
          finalTitle = title || `Chat Transcript: ${conversation.chatName}`;

          const messages = await Message.find({ chat: chatId })
            .populate('sender', 'full_name username')
            .sort({ createdAt: 1 })
            .limit(200);

          extractedText = messages
            .map(m => {
              const name = (m.sender as any)?.full_name || (m.sender as any)?.username || 'User';
              return `[${m.createdAt.toISOString()}] ${name}: ${m.content}`;
            })
            .join('\n');
        }

        if (!extractedText || extractedText.trim().length === 0) {
          throw new Error('Extracted content is empty.');
        }

        // DeepSeek intelligence pass
        let summary = 'No summary generated.';
        let aiTags: string[] = Array.isArray(tags) ? tags : [tags];
        const deepseek = getDeepSeekClient();

        if (deepseek) {
          try {
            const systemPrompt = `You are Aida, an expert company brain analyst. Analyze document content and extract structured data in JSON. Include:
            1. A highly professional summary (2-3 sentences).
            2. High-level topic tags (max 5 items).
            3. Core decisions extracted (string array).
            4. Future action items extracted (string array).
            
            Return ONLY JSON:
            {"summary": "...", "tags": ["tag1", "tag2"], "decisions": ["..."], "actionItems": ["..."]}`;

            const res = await deepseek.chat.completions.create({
              model: 'deepseek-chat',
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Content:\n\n${extractedText.substring(0, 4000)}` },
              ],
              temperature: 0.3,
            });

            const rawJson = res.choices?.[0]?.message?.content?.trim() || '';
            const match = rawJson.match(/\{[\s\S]*\}/);
            if (match) {
              const parsed = JSON.parse(match[0]);
              summary = parsed.summary || summary;
              if (Array.isArray(parsed.tags)) {
                aiTags = Array.from(new Set([...aiTags, ...parsed.tags.map((t: string) => t.toLowerCase())]));
              }
            }
          } catch (aiErr) {
            console.error('[Brain Ingest AI] DeepSeek pass failed:', aiErr);
          }
        }

        // Chunking and embedding to Pinecone
        const namespace = org.pineconeNamespace || `org-${org._id}`;
        const chunks = chunkText(extractedText, 500, 100);
        const pineconeIds: string[] = [];

        if (hasPinecone() && namespace) {
          const vectors = [];
          for (const chunk of chunks) {
            const embedding = await generateEmbedding(chunk);
            if (embedding && embedding.length > 0) {
              const vectorId = `brain-${crypto.randomUUID()}`;
              pineconeIds.push(vectorId);
              vectors.push({
                id: vectorId,
                values: embedding,
                metadata: {
                  title: finalTitle,
                  chunk,
                  department,
                  accessLevel: 'public',
                  organizationId: org._id.toString(),
                },
              });
            }
          }
          if (vectors.length > 0) {
            await upsertVectors(vectors, namespace);
          }
        }

        // Save OrgDocument
        const doc = await OrgDocument.create({
          title: finalTitle,
          content: extractedText,
          department,
          accessLevel: 'public',
          createdBy: userId,
          organizationId: org._id,
          pineconeIds,
          tags: aiTags,
        });

        // Increment author's Expertise score for these topics
        if (aiTags.length > 0) {
          await updateExpertiseRadar(userId.toString(), org._id.toString(), aiTags, 5);
        }

        job.status = 'completed';
        job.resultDocumentId = doc._id;
        await job.save();
        // console.log(`[Brain Ingest] Successfully processed Job ${job._id} for Org ${org.name}`);
      } catch (jobErr: any) {
        console.error(`[Brain Ingest Background] Job ${job._id} failed:`, jobErr);
        job.status = 'failed';
        job.error = jobErr.message || 'Unknown error';
        await job.save();
      }
    });

    return res.status(202).json({
      message: 'Ingestion job initialized.',
      jobId: job._id,
      status: job.status,
    });
  } catch (err: any) {
    console.error('[Brain Ingest] Controller error:', err);
    return res.status(500).json({ error: 'Failed to initialize ingestion job.' });
  }
};

/**
 * GET /api/brain/jobs/:id
 * Poll details and status of an ingestion job.
 */
export const getJobStatus = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const { id } = req.params;

    const job = await IngestionJob.findOne({ _id: id, userId });
    if (!job) {
      return res.status(404).json({ error: 'Job not found or unauthorized.' });
    }

    return res.status(200).json({ job });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};
