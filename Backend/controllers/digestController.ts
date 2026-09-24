import { Request, Response } from 'express';
import OpenAI from 'openai';
import { DailyDigest } from '../models/dailyDigest';
import { CalendarEvent } from '../models/calendarEvent';
import { User } from '../models/users';
import { Organization } from '../models/organizations';
import { Task } from '../models/task';
import { OrgDocument } from '../models/orgDocument';
import { generateEmbedding } from '../utils/embeddings';
import { queryVectors, hasPinecone } from '../utils/pinecone';
import { resolveUserOrg } from '../utils/orgResolver';

const CONFIDENCE_THRESHOLD = 0.70;
const HEADS_UP_THRESHOLD = 0.45;

const getDeepSeekClient = () => {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key || key.startsWith('your_') || key.startsWith('add_your_')) return null;
  return new OpenAI({ baseURL: 'https://api.deepseek.com/v1', apiKey: key });
};

const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const endOfDay = (d: Date) => { const x = new Date(d); x.setHours(23,59,59,999); return x; };

const buildYesterdayRecap = async (
  userId: string,
  orgId: any,
  yStart: Date,
  yEnd: Date
) => {
  const meetings = await CalendarEvent.find({
    organizationId: orgId,
    attendees: userId,
    status: 'ended',
    endTime: { $gte: yStart, $lte: yEnd },
  })
    .select('title summary decisions actionItems')
    .lean();

  const meetingSummary = meetings.map((m: any) => ({
    title: m.title,
    summary: m.summary || '',
    decisions: Array.isArray(m.decisions) ? m.decisions.slice(0, 3) : [],
    actionItems: Array.isArray(m.actionItems)
      ? m.actionItems
          .filter((a: any) => !a.assignedTo || String(a.assignedTo) === String(userId))
          .slice(0, 3)
          .map((a: any) => a.text || '')
          .filter(Boolean)
      : [],
  }));

  // Top group-chat highlights from yesterday
  const chatDocs = await OrgDocument.find({
    organizationId: orgId,
    tags: 'chat',
    createdAt: { $gte: yStart, $lte: yEnd },
  })
    .select('title content')
    .sort({ createdAt: -1 })
    .limit(3)
    .lean();

  const messageHighlights = chatDocs.map((d: any) => ({
    title: d.title,
    snippet: (d.content || '').slice(0, 240),
  }));

  // Decisions captured yesterday (any source)
  const decisionDocs = await OrgDocument.find({
    organizationId: orgId,
    tags: { $in: ['decision', 'decisions'] },
    createdAt: { $gte: yStart, $lte: yEnd },
  })
    .select('title content')
    .sort({ createdAt: -1 })
    .limit(3)
    .lean();

  const decisions = decisionDocs.map((d: any) => ({
    title: d.title,
    snippet: (d.content || '').slice(0, 240),
  }));

  return { meetings: meetingSummary, messageHighlights, decisions };
};

/**
 * Core function: generate a daily digest for one user.
 * Called by the cron scheduler and on-demand by the GET endpoint.
 */
export const generateDigestForUser = async (userId: string, date: Date = new Date()): Promise<any> => {
  const dayStart = startOfDay(date);
  const dayEnd = endOfDay(date);
  const yesterday = new Date(dayStart.getTime() - 24 * 60 * 60 * 1000);
  const yStart = startOfDay(yesterday);
  const yEnd = endOfDay(yesterday);

  const user = await User.findById(userId);
  if (!user || (!user.organizationId && !user.organization)) return null;

  const org = await resolveUserOrg(user);
  if (!org) return null;

  // 1. Today's events for this user
  const todayEvents = await CalendarEvent.find({
    organizationId: org._id,
    attendees: userId,
    status: { $ne: 'cancelled' },
    startTime: { $gte: dayStart, $lte: dayEnd },
  }).sort({ startTime: 1 }).lean();

  // 2. Open action items from recent events
  const recentEvents = await CalendarEvent.find({
    organizationId: org._id,
    attendees: userId,
    status: 'ended',
    'actionItems.status': 'pending',
    'actionItems.assignedTo': userId,
    updatedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, // last 7 days
  }).select('title actionItems').lean();

  const openActionItems = recentEvents.flatMap(e =>
    e.actionItems
      .filter((a: any) => a.status === 'pending' && a.assignedTo?.toString() === userId.toString())
      .map((a: any) => ({ content: a.text, sourceTitle: e.title, type: 'action_item' as const, confidence: 1 }))
  );

  // 3. Recent decisions across org (high-confidence brain knowledge)
  const namespace = org.pineconeNamespace || `org-${org._id}`;
  const highConfidenceItems: any[] = [];
  const headsUpItems: any[] = [];

  if (hasPinecone()) {
    // Seed query with user's role + department for personalized relevance
    const seedQuery = `${user.org_role || user.role || 'employee'} ${user.department || 'general'} latest decisions updates`;
    const embedding = await generateEmbedding(seedQuery);
    if (embedding.length > 0) {
      const matches = await queryVectors(embedding, 8, org._id.toString(), namespace);
      for (const m of matches) {
        const item = {
          type: 'decision' as const,
          content: m.metadata?.chunk || '',
          sourceTitle: m.metadata?.title || 'Knowledge Base',
          sourceId: m.id,
          confidence: m.score,
        };
        if (m.score >= CONFIDENCE_THRESHOLD) {
          highConfidenceItems.push(item);
        } else if (m.score >= HEADS_UP_THRESHOLD) {
          headsUpItems.push(item);
        }
      }
    }
  }

  // 4. Yesterday recap — what happened, decisions made, action items captured.
  const yesterdayRecap = await buildYesterdayRecap(userId, org._id, yStart, yEnd);

  // 5. Build full item list
  const allItems = [
    ...todayEvents.map(e => ({
      type: 'event' as const,
      content: `${e.title} at ${new Date(e.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      sourceTitle: e.title,
      sourceId: e._id.toString(),
      confidence: 1,
    })),
    ...openActionItems,
    ...highConfidenceItems,
  ];

  // 6. AI-synthesize morning brief
  let morningBrief = `Good morning! You have ${todayEvents.length} event(s) today and ${openActionItems.length} open action item(s).`;
  const deepseek = getDeepSeekClient();

  if (deepseek && (allItems.length > 0 || yesterdayRecap.meetings.length > 0 || yesterdayRecap.messageHighlights.length > 0)) {
    try {
      const briefData = allItems.slice(0, 10).map(i => `- [${i.type}] ${i.content}`).join('\n');
      const recapLines: string[] = [];
      if (yesterdayRecap.meetings.length > 0) {
        recapLines.push('Meetings:');
        for (const m of yesterdayRecap.meetings) {
          recapLines.push(`  • ${m.title}${m.summary ? ` — ${m.summary.slice(0, 160)}` : ''}`);
          for (const d of m.decisions || []) recapLines.push(`    - Decision: ${d}`);
        }
      }
      if (yesterdayRecap.messageHighlights.length > 0) {
        recapLines.push('Group chat highlights:');
        for (const h of yesterdayRecap.messageHighlights) recapLines.push(`  • ${h.snippet.slice(0, 160)}`);
      }
      if (yesterdayRecap.decisions.length > 0) {
        recapLines.push('Decisions captured:');
        for (const d of yesterdayRecap.decisions) recapLines.push(`  • ${d.title}: ${d.snippet.slice(0, 160)}`);
      }
      const recapBlock = recapLines.length > 0 ? `Yesterday:\n${recapLines.join('\n')}\n\n` : '';

      const aiRes = await deepseek.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: `You are Aida, a smart work assistant. Generate a concise, professional morning brief for ${user.full_name || user.username}.
Role: ${user.org_role || user.role}. Department: ${user.department || 'general'}.
Structure (plain text, no markdown headers):
  1. Lead with ONE sentence reflecting on yesterday — meetings attended, decisions made, key updates.
  2. Then 3-4 bullet points covering today's events, open action items, and heads-up knowledge from the brain.
Be specific and actionable.`,
          },
          { role: 'user', content: `${recapBlock}Today's agenda and knowledge:\n${briefData}` },
        ],
        temperature: 0.5,
        max_tokens: 350,
      });
      morningBrief = aiRes.choices?.[0]?.message?.content?.trim() || morningBrief;
    } catch (err) {
      console.error('[Digest] DeepSeek brief generation failed:', err);
    }
  }

  // 7. Upsert the daily digest document
  const digest = await DailyDigest.findOneAndUpdate(
    { userId, date: dayStart },
    {
      organizationId: org._id,
      events: todayEvents.map(e => e._id),
      items: allItems,
      morningBrief,
      highConfidenceItems,
      headsUpItems,
      yesterdayRecap,
      generatedAt: new Date(),
    },
    { upsert: true, returnDocument: 'after' }
  );

  return digest;
};

/**
 * Generate a 7-day recap brief for one user. Returns a synthesized string (or
 * null if the user has no org). Used by the weekly digest push cron.
 */
export const generateWeeklyBriefForUser = async (userId: string, date: Date = new Date()): Promise<string | null> => {
  const weekEnd = endOfDay(date);
  const weekStart = startOfDay(new Date(date.getTime() - 7 * 24 * 60 * 60 * 1000));

  const user = await User.findById(userId);
  if (!user || (!user.organizationId && !user.organization)) return null;

  const org = await resolveUserOrg(user);
  if (!org) return null;

  // Meetings attended over the past week
  const meetings = await CalendarEvent.find({
    organizationId: org._id,
    attendees: userId,
    status: 'ended',
    endTime: { $gte: weekStart, $lte: weekEnd },
  }).select('title summary decisions actionItems').lean();

  // Action items still open for this user
  const openActionEvents = await CalendarEvent.find({
    organizationId: org._id,
    attendees: userId,
    'actionItems.status': 'pending',
    'actionItems.assignedTo': userId,
  }).select('title actionItems').lean();

  const openActionItems = openActionEvents.flatMap((e: any) =>
    (e.actionItems || [])
      .filter((a: any) => a.status === 'pending' && String(a.assignedTo) === String(userId))
      .map((a: any) => a.text)
      .filter(Boolean)
  );

  // Events coming up in the next 7 days
  const upcomingEvents = await CalendarEvent.find({
    organizationId: org._id,
    attendees: userId,
    status: { $ne: 'cancelled' },
    startTime: { $gt: weekEnd, $lte: new Date(weekEnd.getTime() + 7 * 24 * 60 * 60 * 1000) },
  }).sort({ startTime: 1 }).select('title startTime').limit(10).lean();

  // Nothing happened and nothing's coming up — skip this user
  if (meetings.length === 0 && openActionItems.length === 0 && upcomingEvents.length === 0) {
    return null;
  }

  let brief =
    `This week: ${meetings.length} meeting(s) attended, ${openActionItems.length} open action item(s), ` +
    `${upcomingEvents.length} event(s) coming up.`;

  const deepseek = getDeepSeekClient();
  if (deepseek) {
    try {
      const meetingLines = meetings
        .map((m: any) => `  • ${m.title}${m.summary ? ` — ${m.summary.slice(0, 160)}` : ''}`)
        .join('\n');
      const actionLines = openActionItems.slice(0, 10).map((a: string) => `  • ${a}`).join('\n');
      const upcomingLines = upcomingEvents
        .map((e: any) => `  • ${e.title} (${new Date(e.startTime).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })})`)
        .join('\n');

      const aiRes = await deepseek.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: `You are Aida, a smart work assistant. Write a concise weekly recap for ${user.full_name || user.username}.
Role: ${user.org_role || user.role}. Department: ${user.department || 'general'}.
Plain text, no markdown headers. Lead with one reflective sentence on the week, then short bullets covering accomplishments, still-open action items, and what's ahead next week.`,
          },
          {
            role: 'user',
            content: `Meetings this week:\n${meetingLines || '  (none)'}\n\nOpen action items:\n${actionLines || '  (none)'}\n\nNext week:\n${upcomingLines || '  (none)'}`,
          },
        ],
        temperature: 0.5,
        max_tokens: 400,
      });
      brief = aiRes.choices?.[0]?.message?.content?.trim() || brief;
    } catch (err) {
      console.error('[WeeklyDigest] DeepSeek brief generation failed:', err);
    }
  }

  return brief;
};

// ─── GET /api/v1/brain/digest ─────────────────────────────────────────────────

export const getDailyDigest = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const dateParam = req.query.date ? new Date(req.query.date as string) : new Date();
    const dayStart = startOfDay(dateParam);

    // Try cached digest first
    let digest = await DailyDigest.findOne({ userId, date: dayStart })
      .populate('events', 'title startTime endTime eventType liveKitRoomId status')
      .lean();

    // Generate fresh if not found or stale (older than 2 hours)
    const isStale = digest && (Date.now() - new Date(digest.generatedAt).getTime()) > 2 * 60 * 60 * 1000;
    if (!digest || isStale) {
      digest = await generateDigestForUser(userId.toString(), dateParam);
      if (!digest) return res.status(200).json({ digest: null, message: 'No organization found.' });
    }

    return res.status(200).json({ digest });
  } catch (err: any) {
    console.error('[Digest] getDailyDigest error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ─── GET /api/v1/brain/digest/history ────────────────────────────────────────

export const getDigestHistory = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const days = parseInt(req.query.days as string) || 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const history = await DailyDigest.find({
      userId,
      date: { $gte: startOfDay(since) },
    })
      .populate('events', 'title startTime eventType status')
      .sort({ date: -1 })
      .lean();

    return res.status(200).json({ history, count: history.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── GET /api/v1/brain/expertise ─────────────────────────────────────────────

export const getExpertiseRadar = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const user = await User.findById(userId);
    if (!user || (!user.organizationId && !user.organization)) {
      return res.status(400).json({ error: 'No organization found.' });
    }

    const org = await resolveUserOrg(user);
    if (!org) return res.status(404).json({ error: 'Organization not found.' });

    const { ExpertiseRadar } = await import('../models/expertiseRadar');
    const { topic } = req.query;

    const filter: any = { organizationId: org._id };
    if (topic) filter.topic = (topic as string).toLowerCase();

    const radar = await ExpertiseRadar.find(filter)
      .populate('userId', 'full_name username avatar role department')
      .sort({ score: -1 })
      .limit(50)
      .lean();

    // Group by topic for the radar view
    const byTopic: Record<string, any[]> = {};
    for (const entry of radar) {
      if (!byTopic[entry.topic]) byTopic[entry.topic] = [];
      byTopic[entry.topic].push({
        user: entry.userId,
        score: entry.score,
        activityCount: entry.activityCount,
      });
    }

    return res.status(200).json({ byTopic, total: radar.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};
