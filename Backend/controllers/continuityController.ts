import { Request, Response } from 'express';
import { OrgDocument } from '../models/orgDocument';
import { User } from '../models/users';
import { Organization } from '../models/organizations';
import { ExpertiseRadar } from '../models/expertiseRadar';
import { Message } from '../models/messages';
import { Conversation } from '../models/conversations';
import { chunkText, generateEmbedding } from '../utils/embeddings';
import { upsertVectors, queryVectors, hasPinecone } from '../utils/pinecone';
import { resolveUserOrg } from '../utils/orgResolver';
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
 * Helper to update expertise radar scores incrementally.
 */
export const updateExpertiseRadar = async (
  userId: string,
  organizationId: string,
  topics: string[],
  weight: number
) => {
  try {
    for (const topic of topics) {
      const cleanTopic = topic.trim().toLowerCase();
      if (!cleanTopic) continue;

      await ExpertiseRadar.findOneAndUpdate(
        { userId, topic: cleanTopic },
        {
          $setOnInsert: { organizationId },
          $inc: { activityCount: 1, score: weight },
        },
        { upsert: true, returnDocument: 'after' }
      );
    }
  } catch (err) {
    console.error('[Expertise Radar] Increment failed:', err);
  }
};

/**
 * GET /api/brain/brief
 * Generates an onboarding brief tailored for the current user's department/role.
 */
export const getOnboardingBrief = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const user = await User.findById(userId);
    if (!user || (!user.organizationId && !user.organization)) {
      return res.status(400).json({ error: 'User is not mapped to any organization' });
    }

    const org = await resolveUserOrg(user);
    if (!org) {
      return res.status(404).json({ error: 'Organization details not found.' });
    }

    // 1. Fetch company profile (usually tagged 'profile' or 'onboarding')
    const profileDoc = await OrgDocument.findOne({
      organizationId: org._id,
      tags: { $in: ['profile', 'onboarding'] },
    }).select('title content');

    // 2. Fetch top documents matching general/department tags
    const relevantDocs = await OrgDocument.find({
      organizationId: org._id,
      department: { $in: ['general', user.role || 'general'] },
    })
      .select('title tags department createdAt')
      .sort({ createdAt: -1 })
      .limit(5);

    // 3. Find top experts in the organization across key active tags
    const activeRadar = await ExpertiseRadar.find({ organizationId: org._id })
      .populate('userId', 'full_name username role avatar')
      .sort({ score: -1 })
      .limit(6)
      .lean();

    // Group experts by topic
    const expertsByTopic: Record<string, any[]> = {};
    for (const item of activeRadar) {
      if (!expertsByTopic[item.topic]) {
        expertsByTopic[item.topic] = [];
      }
      expertsByTopic[item.topic].push({
        user: item.userId,
        score: item.score,
      });
    }

    return res.status(200).json({
      brief: {
        companyName: org.name,
        industry: org.industry,
        userRole: user.role,
        overview: profileDoc ? profileDoc.content : 'Welcome to the organization!',
        recommendedDocuments: relevantDocs,
        experts: expertsByTopic,
      },
    });
  } catch (err: any) {
    console.error('[Brain Onboarding Brief] Error:', err);
    return res.status(500).json({ error: 'Failed to generate onboarding brief.' });
  }
};

/**
 * GET /api/brain/search
 * Searches the Brain knowledge base with fallback expert routing if confidence is low.
 */
export const searchBrain = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const { query } = req.query;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Query parameter is required.' });
    }

    const user = await User.findById(userId);
    if (!user || (!user.organizationId && !user.organization)) {
      return res.status(400).json({ error: 'User is not mapped to any organization' });
    }

    const org = await resolveUserOrg(user);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found.' });
    }

    // Vector embedding of query
    const embedding = await generateEmbedding(query);
    const namespace = org.pineconeNamespace || `org-${org._id}`;

    let matches: any[] = [];
    if (embedding.length > 0 && hasPinecone()) {
      matches = await queryVectors(embedding, 3, org._id.toString(), namespace);
    }

    const CONFIDENCE_THRESHOLD = 0.70;
    const hasHighConfidence = matches.length > 0 && matches[0].score >= CONFIDENCE_THRESHOLD;

    if (hasHighConfidence) {
      const rawAnswer = matches[0].metadata?.chunk || '';

      // Synthesize a grounded natural-language answer from the retrieved chunks.
      // Falls back to the raw top chunk if DeepSeek is unconfigured or errors.
      let answer = rawAnswer;
      const deepseek = getDeepSeekClient();
      if (deepseek) {
        try {
          const context = matches
            .map((m: any) => `[${m.metadata?.title || 'Knowledge'}]\n${m.metadata?.chunk || ''}`)
            .join('\n\n');
          const aiRes = await deepseek.chat.completions.create({
            model: 'deepseek-chat',
            messages: [
              {
                role: 'system',
                content: `You are Aida, an organizational knowledge assistant. Answer the user's question using ONLY the provided context. Be concise and direct. If the context does not contain enough information to answer, say so plainly.`,
              },
              { role: 'user', content: `Context:\n${context}\n\nQuestion: ${query}` },
            ],
            temperature: 0.3,
            max_tokens: 400,
          });
          answer = aiRes.choices?.[0]?.message?.content?.trim() || rawAnswer;
        } catch (aiErr) {
          console.error('[Brain Search] DeepSeek synthesis failed, using raw chunk:', aiErr);
        }
      }

      return res.status(200).json({
        confidence: 'high',
        answer,
        rawAnswer,
        source: {
          title: matches[0].metadata?.title || 'Matching Fact',
          department: matches[0].metadata?.department || 'general',
        },
        matches: matches.map(m => ({
          title: m.metadata?.title,
          score: m.score,
          snippet: m.metadata?.chunk,
        })),
      });
    }

    // Low confidence or no matches -> Recommend experts based on Expertise Radar
    // Extract keywords from the query
    const stopWords = new Set(['what', 'is', 'the', 'how', 'to', 'in', 'on', 'at', 'a', 'an', 'of', 'for', 'with', 'about', 'who']);
    const keywords = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));

    // Find experts matching any keyword topics
    const experts = await ExpertiseRadar.find({
      organizationId: org._id,
      topic: { $in: keywords },
      userId: { $ne: userId } // don't recommend oneself
    })
      .populate('userId', 'full_name username role avatar')
      .sort({ score: -1 })
      .limit(3)
      .lean();

    const partialMatches = matches.map(m => ({
      title: m.metadata?.title,
      score: m.score,
      snippet: m.metadata?.chunk,
    }));

    // The best facts we DO have (just below the confidence bar). These are carried
    // into routing so the expert opens the DM already seeing what the brain knows,
    // instead of a generic "context fallback" placeholder.
    const topFacts = partialMatches
      .filter(p => p.snippet)
      .slice(0, 3)
      .map(p => ({ title: p.title || 'Related note', snippet: String(p.snippet).slice(0, 400) }));

    const prefilledContext = topFacts.length
      ? topFacts.map(f => `• ${f.title}: ${f.snippet}`).join('\n')
      : '';

    return res.status(200).json({
      confidence: 'low',
      message: 'No direct high-confidence match found.',
      partialMatches,
      topFacts,
      suggestedExperts: experts.map((e: any) => ({
        userId: e.userId?._id,
        name: e.userId?.full_name || e.userId?.username || 'Expert',
        role: e.userId?.role,
        avatar: e.userId?.avatar,
        topic: e.topic,
        score: e.score,
      })),
      suggestedRouting: {
        prefilledContext,
        routingOptions: ['dm', 'group'],
      },
    });
  } catch (err: any) {
    console.error('[Brain Search] Error:', err);
    return res.status(500).json({ error: 'Failed to search brain.' });
  }
};

/**
 * POST /api/brain/route-question
 * pre-fills a DM/group chat flow for routing low-confidence queries to experts.
 */
export const routeQuestion = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const { targetUserId, question, contextText } = req.body;

    if (!targetUserId || !question) {
      return res.status(400).json({ error: 'targetUserId and question are required.' });
    }

    const sender = await User.findById(userId).select('full_name username');
    const expert = await User.findById(targetUserId);
    if (!expert) return res.status(404).json({ error: 'Target expert user not found.' });

    // Get-or-create the pair's DM atomically. $size: 2 ensures we match only the
    // real 1:1 (never a group containing both), and the upsert prevents routing
    // from spawning a duplicate DM alongside one created via "Tap to chat".
    const chat = await Conversation.findOneAndUpdate(
      {
        isGroupChat: false,
        users: { $size: 2, $all: [userId, targetUserId] },
      },
      {
        $setOnInsert: {
          chatName: expert.full_name || expert.username || 'Chat',
          // isGroupChat omitted — the query's equality on it seeds the inserted doc.
          users: [userId, targetUserId],
        },
      },
      { upsert: true, returnDocument: 'after' }
    );

    // Prefill the routed message with the question + the brain facts we already
    // have, rendered as a blockquote so multi-line facts read cleanly.
    const contextBlock = contextText
      ? String(contextText).split('\n').map((l: string) => `> ${l}`).join('\n')
      : '> No initial matching context found.';
    const routingPayload = `❓ **Question routed from ${sender?.full_name || sender?.username || 'colleague'}:**\n"${question}"\n\n*What the Brain already knows:*\n${contextBlock}`;

    const message = await Message.create({
      chat: chat._id,
      sender: userId,
      content: routingPayload,
      message_type: 'text',
      brainQuestionRef: true,
    });

    chat.latestMessage = message._id as any;
    await chat.save();

    return res.status(201).json({
      message: 'Question successfully routed.',
      conversationId: chat._id,
      routedMessage: message,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/brain/qa/resolve
 * Explicit Closed-Loop action: index a completed Q&A conversation block back into the brain.
 */
export const resolveQAExchange = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const { messageId } = req.body;

    if (!messageId) {
      return res.status(400).json({ error: 'messageId is required.' });
    }

    // Fetch message
    const answerMessage = await Message.findById(messageId).populate('chat').populate('sender', 'full_name username');
    if (!answerMessage) return res.status(404).json({ error: 'Answer message not found.' });

    // Check sender
    const expertId = answerMessage.sender._id;

    // Retrieve previous messages in chat to reconstruct the Question
    const prevMessages = await Message.find({
      chat: answerMessage.chat._id,
      createdAt: { $lt: answerMessage.createdAt },
    })
      .sort({ createdAt: -1 })
      .limit(3);

    const questionMessage = prevMessages.find(m => m.content.includes('❓') || m.content.toLowerCase().includes('question') || m.content.toLowerCase().includes('help'));
    const questionText = questionMessage ? questionMessage.content : 'Routed question context';

    const qaContent = `Question:\n${questionText}\n\nAnswer:\n${answerMessage.content}`;

    const user = await User.findById(userId);
    if (!user || (!user.organizationId && !user.organization)) {
      return res.status(400).json({ error: 'User is not mapped to any organization' });
    }

    const org = await resolveUserOrg(user);
    if (!org) return res.status(404).json({ error: 'Organization not found.' });

    // DeepSeek tag extraction
    let aiTags: string[] = ['qa', 'resolved'];
    const deepseek = getDeepSeekClient();

    if (deepseek) {
      try {
        const res = await deepseek.chat.completions.create({
          model: 'deepseek-chat',
          messages: [
            {
              role: 'system',
              content: 'You are Aida. Extract 3-5 keywords/tags representing the topics discussed in this Q&A pair. Return JSON: {"tags": ["...", "..."]}',
            },
            { role: 'user', content: qaContent },
          ],
          temperature: 0.2,
        });
        const raw = res.choices?.[0]?.message?.content?.trim() || '';
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed.tags)) {
            aiTags = Array.from(new Set([...aiTags, ...parsed.tags.map((t: string) => t.toLowerCase())]));
          }
        }
      } catch (err) {
        console.error('[QA Resolve AI] Failed to extract tags:', err);
      }
    }

    // Embed to Pinecone
    const namespace = org.pineconeNamespace || `org-${org._id}`;
    const chunks = chunkText(qaContent, 500, 100);
    const pineconeIds: string[] = [];

    if (hasPinecone() && namespace) {
      const vectors = [];
      for (const chunk of chunks) {
        const embedding = await generateEmbedding(chunk);
        if (embedding && embedding.length > 0) {
          const vectorId = `qa-${crypto.randomUUID()}`;
          pineconeIds.push(vectorId);
          vectors.push({
            id: vectorId,
            values: embedding,
            metadata: {
              title: `Q&A Exchange: ${aiTags.join(', ')}`,
              chunk,
              department: 'general',
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

    // Save MongoDB document
    const doc = await OrgDocument.create({
      title: `Resolved Q&A: ${aiTags.slice(0, 3).join(', ')}`,
      content: qaContent,
      department: 'general',
      accessLevel: 'public',
      createdBy: expertId,
      organizationId: org._id,
      pineconeIds,
      tags: aiTags,
    });

    // Reward expert points in Expertise Cache
    await updateExpertiseRadar(expertId.toString(), org._id.toString(), aiTags, 10);

    return res.status(201).json({
      message: 'Q&A pair successfully indexed into the organization brain.',
      documentId: doc._id,
      tags: aiTags,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};
