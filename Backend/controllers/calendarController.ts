import { Request, Response } from 'express';
import * as crypto from 'crypto';
import OpenAI from 'openai';
import { CalendarEvent } from '../models/calendarEvent';
import { OrgDocument } from '../models/orgDocument';
import { User } from '../models/users';
import { Organization } from '../models/organizations';
import { ExpertiseRadar } from '../models/expertiseRadar';
import { IngestionJob } from '../models/ingestionJob';
import { chunkText, generateEmbedding } from '../utils/embeddings';
import { upsertVectors, queryVectors, hasPinecone } from '../utils/pinecone';
import { updateExpertiseRadar } from './continuityController';
import { brainEventBus } from '../utils/brainEventListener';
import { transcribeWithTimestamps } from '../utils/whisperService';
import { getNigerianHolidays, fetchGoogleNigerianHolidays } from '../utils/nigeriaHolidays';
import * as fs from 'fs';

const getDeepSeekClient = () => {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key || key.trim().length <= 10) return null;
  return new OpenAI({ baseURL: 'https://api.deepseek.com/v1', apiKey: key });
};

// ─── Helper: Ingest event into the brain ─────────────────────────────────────

const ingestEventIntoBrain = async (
  event: any,
  org: any,
  contentText: string,
  tags: string[]
) => {
  try {
    const namespace = org.pineconeNamespace || `org-${org._id}`;
    const chunks = chunkText(contentText, 500, 100);
    const pineconeIds: string[] = [];

    if (hasPinecone() && chunks.length > 0) {
      const vectors = [];
      for (const chunk of chunks) {
        const embedding = await generateEmbedding(chunk);
        if (embedding?.length > 0) {
          const vectorId = `event-${crypto.randomUUID()}`;
          pineconeIds.push(vectorId);
          vectors.push({
            id: vectorId,
            values: embedding,
            metadata: {
              title: event.title,
              chunk,
              department: 'meetings',
              accessLevel: 'public',
              organizationId: org._id.toString(),
              sourceType: 'calendar_event',
              eventId: event._id.toString(),
            },
          });
        }
      }
      if (vectors.length > 0) await upsertVectors(vectors, namespace);
    }

    const doc = await OrgDocument.create({
      title: `Event: ${event.title}`,
      content: contentText,
      department: 'meetings',
      accessLevel: 'public',
      createdBy: event.createdBy,
      organizationId: org._id,
      pineconeIds,
      tags,
    });

    // Update event with brain links
    event.relatedDocIds.push(doc._id);
    event.pineconeIds.push(...pineconeIds);
    event.brainEnriched = true;
    await event.save();

    // Update expertise radar for attendees
    if (tags.length > 0 && event.attendees?.length > 0) {
      for (const attendeeId of event.attendees) {
        await updateExpertiseRadar(attendeeId.toString(), org._id.toString(), tags, 3);
      }
    }
  } catch (err) {
    console.error('[Calendar Brain] Ingest error:', err);
  }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const getOrgFromUser = async (userId: string) => {
  const user = await User.findById(userId);
  if (!user) return { user: null, org: null };
  // Resolve by canonical organizationId first (robust), then fall back to the
  // legacy org *name* match. Resolving by name alone silently returned no org
  // whenever the stored name drifted from the Organization doc — which made the
  // calendar 400 and render empty even for valid org members.
  let org = null as any;
  if ((user as any).organizationId) org = await Organization.findById((user as any).organizationId);
  if (!org && user.organization) org = await Organization.findOne({ name: user.organization });
  return { user, org };
};

/**
 * Idempotently seed Nigerian public holidays for an org (current + next year).
 * Safe to call on every holiday fetch — only missing entries are inserted.
 */
export const ensureNigerianHolidays = async (org: any, createdById: any): Promise<void> => {
  try {
    if (!org?._id) return;
    const now = new Date();
    const years = [now.getFullYear(), now.getFullYear() + 1];

    const rangeStart = new Date(`${years[0]}-01-01T00:00:00.000`);
    const rangeEnd = new Date(`${years[years.length - 1]}-12-31T23:59:59.999`);
    const existing = await CalendarEvent.find({
      organizationId: org._id,
      eventType: 'holiday',
      startTime: { $gte: rangeStart, $lte: rangeEnd },
    }).select('title startTime').lean();

    // Already seeded for this 2-year window — skip the network fetch entirely.
    if (existing.length >= 18) return;

    // Source of truth: Google Calendar's public NG holiday feed. Fall back to the static
    // list only if Google is unreachable, so the calendar still populates offline.
    const fromGoogle = await fetchGoogleNigerianHolidays();
    let seeds = fromGoogle.filter((s) => years.includes(new Date(s.date).getFullYear()));
    if (seeds.length === 0) {
      seeds = years.flatMap((y) => getNigerianHolidays(y));
    }

    const keyOf = (title: string, d: any) => `${String(title).toLowerCase()}|${new Date(d).toISOString().slice(0, 10)}`;
    const have = new Set(existing.map((e: any) => keyOf(e.title, e.startTime)));

    const toCreate = seeds.filter((s) => !have.has(`${s.name.toLowerCase()}|${s.date}`));
    if (toCreate.length === 0) return;

    await CalendarEvent.insertMany(
      toCreate.map((s) => {
        const startDate = new Date(`${s.date}T00:00:00.000`);
        const endDate = new Date(`${s.date}T23:59:59.999`);
        return {
          organizationId: org._id,
          title: s.name,
          eventType: 'holiday',
          description: `${s.name} — public holiday in Nigeria.`,
          startTime: startDate,
          endTime: endDate,
          isAllDay: true,
          createdBy: createdById,
          attendees: [],
          attendeeNames: [],
          tags: ['holiday', 'NG'],
          decisions: [],
          actionItems: [],
          relatedDocIds: [],
          pineconeIds: [],
          topicTags: ['holiday'],
          brainEnriched: true,
        };
      })
    );
  } catch (err) {
    console.error('[ensureNigerianHolidays] seeding failed:', err);
  }
};

// ─── POST /api/v1/events/create ──────────────────────────────────────────────

export const createEvent = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { user, org } = await getOrgFromUser(userId.toString());
    if (!org) return res.status(400).json({ error: 'User organization not found.' });

    const {
      title, eventType = 'meeting_video', description, startTime, endTime,
      isAllDay = false, attendees = [], agenda, tags = [],
      isRecurring = false, recurrenceRule, parentEventId,
    } = req.body;

    if (!title || !startTime || !endTime) {
      return res.status(400).json({ error: 'title, startTime, endTime are required.' });
    }

    // Fetch attendee names for display
    const attendeeUsers = await User.find({ _id: { $in: attendees } }).select('full_name username');
    const attendeeNames = attendeeUsers.map(u => u.full_name || u.username || 'Member');

    const event = await CalendarEvent.create({
      organizationId: org._id,
      title,
      eventType,
      description,
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      isAllDay,
      createdBy: userId,
      attendees: [userId, ...attendees.filter((a: string) => a !== userId.toString())],
      attendeeNames,
      agenda,
      tags,
      isRecurring,
      recurrenceRule,
      parentEventId,
      decisions: [],
      actionItems: [],
      relatedDocIds: [],
      pineconeIds: [],
      topicTags: [],
    });

    // Background: ingest basic event info into brain immediately
    const basicContent = `Event: ${title}\nType: ${eventType}\nDate: ${startTime}\nAttendees: ${attendeeNames.join(', ')}\n${description || ''}\n${agenda || ''}`;
    setImmediate(async () => {
      await ingestEventIntoBrain(event, org, basicContent, ['event', eventType, ...tags]);
      brainEventBus.emit('calendar_event_created', {
        eventId: event._id.toString(),
        organizationId: org._id.toString(),
        title,
        eventType,
      });
    });

    return res.status(201).json({ event, message: 'Event created and queued for brain indexing.' });
  } catch (err: any) {
    console.error('[Calendar] createEvent error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// ─── GET /api/v1/events ──────────────────────────────────────────────────────

export const getEvents = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const { start, end, type, mine } = req.query;

    const { org } = await getOrgFromUser(userId.toString());
    // No org → the calendar is org-scoped (events require an organizationId), so
    // return an empty set with 200 (not a 400). A blank-but-OK calendar with a hint
    // beats a silent error that the client swallows into an empty screen.
    if (!org) {
      return res.status(200).json({ events: [], count: 0, note: 'Join or create an organization to use the shared calendar.' });
    }

    // Seed Nigerian public holidays for this org on ANY calendar load (idempotent —
    // early-returns once seeded), so holidays show by default rather than only when
    // a holiday-typed query is made.
    await ensureNigerianHolidays(org, userId);

    const filter: any = { organizationId: org._id, status: { $ne: 'cancelled' } };

    if (start || end) {
      filter.startTime = {};
      if (start) filter.startTime.$gte = new Date(start as string);
      if (end) filter.startTime.$lte = new Date(end as string);
    }

    if (type) filter.eventType = type;

    // Filter to only user's events if ?mine=true
    if (mine === 'true') {
      filter.attendees = userId;
    }

    const events = await CalendarEvent.find(filter)
      .sort({ startTime: 1 })
      .limit(200)
      .populate('attendees', 'full_name username avatar')
      .lean();

    return res.status(200).json({ events, count: events.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── GET /api/v1/events/:id ──────────────────────────────────────────────────

export const getEvent = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const { id } = req.params;

    const { org } = await getOrgFromUser(userId.toString());
    if (!org) return res.status(400).json({ error: 'Organization not found.' });

    const event = await CalendarEvent.findOne({ _id: id, organizationId: org._id })
      .populate('attendees', 'full_name username avatar role department')
      .populate('relatedDocIds', 'title tags createdAt')
      .lean();

    if (!event) return res.status(404).json({ error: 'Event not found.' });

    return res.status(200).json({ event });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── PUT /api/v1/events/:id ──────────────────────────────────────────────────

export const updateEvent = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const { id } = req.params;

    const { org } = await getOrgFromUser(userId.toString());
    if (!org) return res.status(400).json({ error: 'Organization not found.' });

    const event = await CalendarEvent.findOne({ _id: id, organizationId: org._id });
    if (!event) return res.status(404).json({ error: 'Event not found.' });

    const { title, description, startTime, endTime, attendees, agenda, tags, status } = req.body;

    if (title) event.title = title;
    if (description !== undefined) event.description = description;
    if (startTime) event.startTime = new Date(startTime);
    if (endTime) event.endTime = new Date(endTime);
    if (agenda !== undefined) event.agenda = agenda;
    if (tags) event.tags = tags;
    if (status) event.status = status;

    if (attendees) {
      const attendeeUsers = await User.find({ _id: { $in: attendees } }).select('full_name username');
      event.attendees = attendees;
      event.attendeeNames = attendeeUsers.map(u => u.full_name || u.username || 'Member');
    }

    await event.save();
    return res.status(200).json({ event, message: 'Event updated.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── DELETE /api/v1/events/:id (soft delete) ─────────────────────────────────

export const deleteEvent = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const { id } = req.params;

    const { org } = await getOrgFromUser(userId.toString());
    if (!org) return res.status(400).json({ error: 'Organization not found.' });

    const event = await CalendarEvent.findOne({ _id: id, organizationId: org._id });
    if (!event) return res.status(404).json({ error: 'Event not found.' });

    event.status = 'cancelled';
    await event.save();

    return res.status(200).json({ message: 'Event cancelled.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── POST /api/v1/events/:id/start-meeting ───────────────────────────────────

export const startMeeting = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const { id } = req.params;

    const { org } = await getOrgFromUser(userId.toString());
    if (!org) return res.status(400).json({ error: 'Organization not found.' });

    const event = await CalendarEvent.findOne({ _id: id, organizationId: org._id });
    if (!event) return res.status(404).json({ error: 'Event not found.' });

    // Generate or reuse LiveKit room ID
    if (!event.liveKitRoomId) {
      event.liveKitRoomId = `evt-${org._id}-${event._id}-${Date.now()}`;
    }
    event.status = 'live';
    await event.save();

    return res.status(200).json({
      message: 'Meeting started.',
      roomId: event.liveKitRoomId,
      eventId: event._id,
      // Pre-set agenda travels with the room so the joining client can stamp it
      // onto the Meeting record (createMeeting accepts `agenda`).
      agenda: event.agenda || '',
      title: event.title,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── POST /api/v1/events/:id/end-meeting ─────────────────────────────────────

export const endMeeting = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const { id } = req.params;
    const { transcriptText, transcriptChunks } = req.body;

    const { org } = await getOrgFromUser(userId.toString());
    if (!org) return res.status(400).json({ error: 'Organization not found.' });

    const event = await CalendarEvent.findOne({ _id: id, organizationId: org._id });
    if (!event) return res.status(404).json({ error: 'Event not found.' });

    event.status = 'ended';
    if (transcriptText) event.transcriptRaw = transcriptText;
    if (transcriptChunks) event.transcriptChunks = transcriptChunks;
    await event.save();

    // Background DeepSeek enrichment + brain ingest
    setImmediate(async () => {
      try {
        const deepseek = getDeepSeekClient();
        const rawText = transcriptText || transcriptChunks?.map((c: any) => `${c.speaker ? '[' + c.speaker + '] ' : ''}${c.text}`).join('\n') || '';

        let summary = `Meeting: ${event.title}`;
        let decisions: string[] = [];
        let actionItems: string[] = [];
        let tags: string[] = ['meeting', event.eventType];

        if (deepseek && rawText.length > 20) {
          const aiRes = await deepseek.chat.completions.create({
            model: 'deepseek-chat',
            messages: [
              {
                role: 'system',
                content: `You are Aida, an expert meeting analyst. Analyze the meeting transcript and return JSON:
{
  "summary": "2-3 sentence professional meeting summary",
  "decisions": ["decision1", "decision2"],
  "actionItems": ["action item 1", "action item 2"],
  "tags": ["topic1", "topic2", "topic3"]
}`,
              },
              { role: 'user', content: `Meeting: ${event.title}\n\nTranscript:\n${rawText.substring(0, 5000)}` },
            ],
            temperature: 0.3,
          });
          const raw = aiRes.choices?.[0]?.message?.content?.trim() || '';
          const match = raw.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            summary = parsed.summary || summary;
            decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
            actionItems = Array.isArray(parsed.actionItems) ? parsed.actionItems : [];
            if (Array.isArray(parsed.tags)) tags = [...tags, ...parsed.tags.map((t: string) => t.toLowerCase())];
          }
        }

        event.summary = summary;
        event.decisions = decisions;
        event.actionItems = actionItems.map(text => ({ text, status: 'pending' })) as any;
        event.topicTags = tags;
        await event.save();

        // Ingest enriched content into brain
        const fullContent = `${summary}\n\nDecisions:\n${decisions.join('\n')}\n\nAction Items:\n${actionItems.join('\n')}\n\nTranscript:\n${rawText}`;
        await ingestEventIntoBrain(event, org, fullContent, tags);

        // Emit brain event for downstream listeners
        brainEventBus.emit('meeting_ended', {
          meetingId: event._id.toString(),
          organizationId: org._id.toString(),
          hostId: event.createdBy.toString(),
          title: event.title,
          transcript: rawText,
          summary,
          tags,
        });

        console.log(`[Calendar] Meeting ${event._id} enriched and indexed into brain.`);
      } catch (enrichErr) {
        console.error('[Calendar] End meeting enrichment failed:', enrichErr);
      }
    });

    return res.status(200).json({ message: 'Meeting ended. Enrichment queued.', eventId: event._id });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── POST /api/v1/events/holidays/bulk ──────────────────────────────────────

export const bulkImportHolidays = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const { holidays } = req.body; // [{ name, date, country? }]

    if (!Array.isArray(holidays) || holidays.length === 0) {
      return res.status(400).json({ error: 'holidays array is required.' });
    }

    const { user, org } = await getOrgFromUser(userId.toString());
    if (!org) return res.status(400).json({ error: 'Organization not found.' });

    // Only admins can bulk-import holidays
    if (user?.role !== 'admin') return res.status(403).json({ error: 'Admin role required.' });

    const created = [];
    for (const h of holidays) {
      const startDate = new Date(h.date);
      const endDate = new Date(h.date);
      endDate.setHours(23, 59, 59, 999);

      const event = await CalendarEvent.create({
        organizationId: org._id,
        title: h.name,
        eventType: 'holiday',
        startTime: startDate,
        endTime: endDate,
        isAllDay: true,
        createdBy: userId,
        attendees: [],
        attendeeNames: [],
        tags: ['holiday', h.country || 'general'],
        decisions: [],
        actionItems: [],
        relatedDocIds: [],
        pineconeIds: [],
        topicTags: ['holiday'],
        brainEnriched: true, // holidays don't need enrichment
      });
      created.push(event);
    }

    return res.status(201).json({ message: `${created.length} holiday(s) imported.`, created });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// ─── GET /api/v1/events/suggest ─────────────────────────────────────────────

export const getEventSuggestions = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const { query, startTime } = req.query;

    const { org } = await getOrgFromUser(userId.toString());
    if (!org) return res.status(400).json({ error: 'Organization not found.' });

    const namespace = org.pineconeNamespace || `org-${org._id}`;

    // 1. Title suggestions from similar past events
    let titleSuggestions: string[] = ['Weekly Team Sync', 'Project Kickoff', 'Board Meeting', '1:1 Check-in', 'Sprint Review'];
    if (query) {
      const recentEvents = await CalendarEvent.find({
        organizationId: org._id,
        title: { $regex: query as string, $options: 'i' },
        status: 'ended',
      }).select('title').limit(5).lean();
      const eventTitles = recentEvents.map(e => e.title);
      titleSuggestions = [...new Set([...eventTitles, ...titleSuggestions])].slice(0, 6);
    }

    // 2. Participant suggestions via expertise radar for the query topic
    let participantSuggestions: any[] = [];
    if (query) {
      const keywords = (query as string).toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const experts = await ExpertiseRadar.find({
        organizationId: org._id,
        topic: { $in: keywords },
      })
        .populate('userId', 'full_name username avatar department')
        .sort({ score: -1 })
        .limit(5)
        .lean();
      participantSuggestions = experts.map((e: any) => ({
        userId: e.userId?._id,
        name: e.userId?.full_name || e.userId?.username,
        avatar: e.userId?.avatar,
        department: e.userId?.department,
        topic: e.topic,
        score: e.score,
      }));
    }

    // 3. Agenda pre-fill from similar past event brain docs
    let agendaSuggestion = '';
    if (query && hasPinecone()) {
      const embedding = await generateEmbedding(query as string);
      if (embedding.length > 0) {
        const matches = await queryVectors(embedding, 2, org._id.toString(), namespace, { sourceType: 'calendar_event' });
        if (matches.length > 0 && matches[0].score > 0.6) {
          agendaSuggestion = matches[0].metadata?.chunk || '';
        }
      }
    }

    // 4. Conflict check
    let conflicts: any[] = [];
    if (startTime) {
      const checkStart = new Date(startTime as string);
      const checkEnd = new Date(checkStart.getTime() + 60 * 60 * 1000); // 1hr default
      conflicts = await CalendarEvent.find({
        organizationId: org._id,
        status: { $in: ['scheduled', 'live'] },
        startTime: { $lt: checkEnd },
        endTime: { $gt: checkStart },
      }).select('title startTime endTime attendees').limit(5).lean();
    }

    return res.status(200).json({
      titleSuggestions,
      participantSuggestions,
      agendaSuggestion,
      conflicts,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};
