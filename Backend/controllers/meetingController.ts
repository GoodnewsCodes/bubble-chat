import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Meeting, IMeeting } from '../models/meeting';
import { Task } from '../models/task';
import { User } from '../models/users';
import OpenAI from 'openai';
import { createNotification } from './notificationController';
import { logActivity } from './activityLogController';
import { Organization } from '../models/organizations';
import { Conversation } from '../models/conversations';
import { Message } from '../models/messages';

// ─── DeepSeek client (same engine as aidaController) ─────────────────────────
const deepseekClient = new OpenAI({
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: process.env.DEEPSEEK_API_KEY || '',
});

const hasDeepSeekKey = (): boolean => {
  const key = process.env.DEEPSEEK_API_KEY;
  return !!(key && key.trim().length > 10);
};

// ─── Helper: AI-powered transcript processing via DeepSeek ───────────────────
// Exported so the background catch-up processor (scheduler.ts) uses the SAME
// DeepSeek intelligence as the live meeting-end path — one source of truth.
export const extractMeetingIntelligence = async (
  transcript: string,
  attendeeNames: string[]
): Promise<{
  summary: string;
  actionItems: { text: string; assignedToName?: string }[];
}> => {
  // The transcript itself is produced independently (live captions / Whisper). Only
  // the AI *summary + action items* depend on Aida (DeepSeek). When that's unavailable
  // we still return a usable record — never leak provider/config wording to end users,
  // which previously made a working transcript look broken ("DeepSeek key not configured").
  if (!transcript) {
    return {
      summary: 'No transcript was captured for this meeting, so no summary is available.',
      actionItems: [],
    };
  }
  if (!hasDeepSeekKey()) {
    return {
      summary: 'AI summary will appear here once Aida is enabled for this workspace. The full transcript is available below.',
      actionItems: [],
    };
  }

  const attendeeLine =
    attendeeNames.length > 0 ? `Attendees: ${attendeeNames.join(', ')}.` : '';

  // A single extraction call. Long meetings are map-reduced below: each chunk is
  // analyzed with this, then the per-chunk results are merged in one final pass —
  // previously only the FIRST 3000 chars were analyzed, so anything decided later
  // in a long meeting silently vanished from summaries and action items.
  const runExtraction = async (
    text: string,
    mode: 'full' | 'chunk',
    chunkInfo = ''
  ): Promise<{ summary: string; actionItems: { text: string; assignedToName?: string }[] } | null> => {
    const detailInstruction =
      mode === 'full'
        ? 'A highly detailed, premium explanation of the meeting. This explanation should explain everything in key exciting details, highlighting who said what, key decisions, technical context, files shared, and future steps.'
        : 'A thorough summary of THIS PORTION of the meeting: who said what, decisions made, technical context, files shared, next steps.';
    try {
      const response = await deepseekClient.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: `You are Aida, an expert meeting intelligence assistant. Analyze transcripts and extract structured data. Always return valid JSON only.`,
          },
          {
            role: 'user',
            content: `Analyze this meeting transcript${chunkInfo} and return a JSON object.
${attendeeLine}

TRANSCRIPT:
${text}

Extract:
1. ${detailInstruction}
2. All action items with who they are assigned to

Return ONLY this JSON (no other text):
{"summary": "...", "actionItems": [{"text": "...", "assignedToName": "...or null"}]}`,
          },
        ],
        max_tokens: 1500,
        temperature: 0.3,
      });
      const raw = response.choices[0].message?.content?.trim() || '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          summary: parsed.summary || '',
          actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
        };
      }
    } catch (err) {
      console.error('[Meeting AI] DeepSeek transcript extraction error:', err);
    }
    return null;
  };

  const SINGLE_PASS_LIMIT = 12000; // chars — comfortably within DeepSeek's context
  const CHUNK_SIZE = 10000;
  const MAX_CHUNKS = 12;

  try {
    // Short meetings: one pass over the WHOLE transcript.
    if (transcript.length <= SINGLE_PASS_LIMIT) {
      const result = await runExtraction(transcript, 'full');
      if (result && result.summary) return result;
    } else {
      // Long meetings: map (per chunk) → reduce (merge pass).
      const chunks: string[] = [];
      const effectiveSize = Math.max(CHUNK_SIZE, Math.ceil(transcript.length / MAX_CHUNKS));
      for (let i = 0; i < transcript.length; i += effectiveSize) {
        chunks.push(transcript.substring(i, i + effectiveSize + 200)); // 200-char overlap
      }
      const chunkResults = await Promise.all(
        chunks.map((c, i) => runExtraction(c, 'chunk', ` (part ${i + 1} of ${chunks.length})`))
      );
      const valid = chunkResults.filter((r): r is NonNullable<typeof r> => !!r && !!r.summary);
      if (valid.length > 0) {
        const mergedActionItems = valid.flatMap(r => r.actionItems);
        const combinedSummaries = valid.map((r, i) => `Part ${i + 1}: ${r.summary}`).join('\n\n');
        const mergeResult = await runExtraction(
          `The following are sequential summaries of one meeting. Merge them into a single coherent, highly detailed meeting explanation (who said what, key decisions, technical context, future steps) and consolidate the action items, removing duplicates.\n\n${combinedSummaries}\n\nACTION ITEMS SO FAR: ${JSON.stringify(mergedActionItems)}`,
          'full'
        );
        if (mergeResult && mergeResult.summary) {
          // Merge pass may drop items — union with the per-chunk set, dedup by text.
          const seen = new Set(mergeResult.actionItems.map(a => a.text.trim().toLowerCase()));
          for (const item of mergedActionItems) {
            const key = item.text?.trim().toLowerCase();
            if (key && !seen.has(key)) {
              seen.add(key);
              mergeResult.actionItems.push(item);
            }
          }
          return mergeResult;
        }
        // Merge pass failed — still better to return concatenated chunk results
        // than the first 300 chars.
        return { summary: combinedSummaries, actionItems: mergedActionItems };
      }
    }
  } catch (err) {
    console.error('[Meeting AI] extraction pipeline error:', err);
  }

  return {
    summary: transcript.substring(0, 300) + '...',
    actionItems: [],
  };
};

// ─── POST /api/v1/meetings ── Create a meeting record ────────────────────────

export const createMeeting = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { roomId, title, type, attendees, attendeeNames, chatId } = req.body;

    // Every participant's client calls this when joining a call (caller AND callee).
    // Without this guard each of them would create their own Meeting document for the
    // same roomId, with themselves as "host" — fragmenting the transcript/history and
    // making host-only-end logic meaningless. Join the existing live record instead.
    if (roomId) {
      const existing = await Meeting.findOne({ roomId, status: 'live' });
      if (existing) {
        const alreadyIn =
          String(existing.host) === String(userId) ||
          existing.attendees.some((a: any) => String(a) === String(userId));
        if (!alreadyIn) {
          existing.attendees.push(userId);
          if (attendeeNames?.length) {
            existing.attendeeNames = Array.from(
              new Set([...(existing.attendeeNames || []), ...attendeeNames])
            );
          }
          await existing.save();
        }
        return res.status(200).json({ message: 'Joined existing meeting', meeting: existing });
      }
    }

    const meeting = await Meeting.create({
      roomId: roomId || `room-${Date.now()}`,
      title: title || 'Untitled Meeting',
      host: userId,
      type: type || 'video',
      attendees: attendees || [],
      attendeeNames: attendeeNames || [],
      chatId: chatId || undefined,
      startedAt: new Date(),
      status: 'live',
    });

    // TEMP diagnostic (remove after verifying active-rooms): confirm a live record is born.
    console.log(`[CreateMeeting] created roomId=${meeting.roomId} status=${meeting.status} host=${userId}`);

    // Start the audio recording immediately so transcription always works, even
    // on clients without live captions (Safari/Firefox/mobile). Best-effort: no-ops
    // unless LIVEKIT_EGRESS_ENABLED + the egress worker are provisioned.
    try {
      const { startRoomAudioEgress } = await import('../utils/livekitEgress');
      const egress = await startRoomAudioEgress(meeting.roomId);
      if (egress) {
        meeting.recordingKey = egress.recordingKey;
        meeting.egressId = egress.egressId;
        await meeting.save();
      }
    } catch (egressErr) {
      console.error('[Meeting] Failed to start audio egress:', egressErr);
    }

    if (attendees && attendees.length > 0) {
      const hostUser = await User.findById(userId).select('full_name username');
      const hostName =
        hostUser?.full_name || hostUser?.username || 'Someone';

      for (const attendeeId of attendees) {
        await createNotification({
          recipient: attendeeId,
          sender: userId,
          type: 'meeting_started',
          title: `Meeting started: ${meeting.title}`,
          body: `${hostName} has started a meeting. Join now!`,
          entityId: String(meeting._id),
          entityType: 'Meeting',
        });
      }
    }

    await logActivity({
      actor: userId,
      action: 'meeting_started',
      entityId: String(meeting._id),
      entityType: 'Meeting',
      entityLabel: meeting.title,
    });

    // Broadcast to all org members so their "Active Rooms" list refreshes instantly.
    try {
      const hostUser = await User.findById(userId).select('full_name username avatar organization').lean();
      const orgId = (hostUser as any)?.organization;
      const { getIO } = await import('../utils/socket');
      const io = getIO();
      const roomCard = {
        id: String(meeting._id),
        roomId: meeting.roomId,
        title: meeting.title,
        type: meeting.type,
        members: 1,
        host: hostUser,
        attendees: [],
        startedAt: meeting.startedAt,
      };
      if (orgId) {
        const orgMembers = await User.find({ organization: orgId }).select('_id').lean();
        for (const m of orgMembers) {
          io.to(String(m._id)).emit('meeting_room_update', { action: 'started', room: roomCard });
        }
      }
      // Also notify invited attendees regardless of org membership.
      for (const aid of (attendees || [])) {
        io.to(String(aid)).emit('meeting_room_update', { action: 'started', room: roomCard });
      }
    } catch { /* best-effort socket broadcast */ }

    res.status(201).json({ message: 'Meeting created', meeting });
  } catch (err: any) {
    res
      .status(500)
      .json({ message: 'Failed to create meeting', error: err.message });
  }
};

// ─── GET /api/v1/meetings/active ── Live rooms in the org ────────────────────
// Returns all meetings with status='live' that are in the same org as the
// requesting user. This powers the "Active Rooms" section in CallsView.

export const getActiveMeetings = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    // Find the requesting user's org so we can scope rooms to their workspace.
    const user = await User.findById(userId).select('organization').lean();
    const orgId = (user as any)?.organization;

    let query: any = { status: 'live' };
    if (orgId) {
      // Find all members of this org so we can filter meetings to org-scoped rooms.
      const orgMembers = await User.find({ organization: orgId }).select('_id').lean();
      const memberIds = orgMembers.map((m: any) => m._id);
      query = {
        status: 'live',
        $or: [
          { host: { $in: memberIds } },
          { attendees: { $in: memberIds } },
          // Always include the requester's OWN live meetings regardless of org linkage,
          // so a host/attendee never fails to see a room they're actually in (guards
          // against org-membership mismatches between host and viewer).
          { host: userId },
          { attendees: userId },
        ],
      };
    }

    // TEMP diagnostic (remove after verifying active-rooms): log scope + result count.
    console.log(`[ActiveMeetings] user=${userId} orgId=${orgId || 'none'}`);

    const meetings = await Meeting.find(query)
      .populate('host', 'full_name username avatar')
      .populate('attendees', 'full_name username avatar')
      .sort({ startedAt: -1 })
      .lean();

    // Shape into the "room card" format the frontend expects.
    const rooms = meetings.map((m: any) => ({
      id: String(m._id),
      roomId: m.roomId,
      title: m.title || 'Untitled Meeting',
      type: m.type || 'video',
      members: (m.attendees?.length || 0) + 1, // +1 for host
      host: m.host,
      attendees: m.attendees || [],
      startedAt: m.startedAt,
    }));

    console.log(`[ActiveMeetings] returning ${rooms.length} live room(s)`);
    res.status(200).json({ rooms });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to fetch active meetings', error: err.message });
  }
};

// ─── GET /api/v1/meetings ── List meetings for user ──────────────────────────

export const getMeetings = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const page = parseInt((req.query.page as string) || '1');
    const limit = parseInt((req.query.limit as string) || '20');
    const skip = (page - 1) * limit;

    const meetings = await Meeting.find({
      $or: [{ host: userId }, { attendees: userId }],
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('host', 'full_name username avatar')
      .populate('attendees', 'full_name username avatar')
      .populate('filesShared.uploadedBy', 'full_name username avatar')
      .lean();

    res.status(200).json({ meetings, page, limit });
  } catch (err: any) {
    res
      .status(500)
      .json({ message: 'Failed to fetch meetings', error: err.message });
  }
};

// ─── GET /api/v1/meetings/stats/:withUserId ────────────────────────────────────

export const getMeetingStatsWithUser = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const withUserId = String(req.params.withUserId || '');
    if (!mongoose.Types.ObjectId.isValid(withUserId)) {
      return res.status(400).json({ message: 'Invalid target user ID' });
    }

    const targetUserObjectId = new mongoose.Types.ObjectId(withUserId);
    const currentUserObjectId = new mongoose.Types.ObjectId(userId);

    const meetings = await Meeting.find({
      status: 'ended',
      $or: [
        { host: currentUserObjectId, attendees: targetUserObjectId },
        { host: targetUserObjectId, attendees: currentUserObjectId },
        { attendees: { $all: [currentUserObjectId, targetUserObjectId] } }
      ]
    })
      .sort({ startedAt: -1 })
      .populate('host', 'full_name username avatar')
      .populate('attendees', 'full_name username avatar')
      .lean();

    const count = meetings.length;
    res.status(200).json({ count, meetings });
  } catch (err: any) {
    res.status(500).json({ message: 'Failed to fetch meeting statistics', error: err.message });
  }
};

// ─── GET /api/v1/meetings/:id ─────────────────────────────────────────────────

export const getMeetingById = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const meeting = await Meeting.findOne({
      _id: req.params.id,
      $or: [{ host: userId }, { attendees: userId }],
    })
      .populate('host', 'full_name username avatar')
      .populate('attendees', 'full_name username avatar')
      .populate('actionItems.assignedTo', 'full_name username')
      .populate('filesShared.uploadedBy', 'full_name username avatar')
      .lean();

    if (!meeting) return res.status(404).json({ message: 'Meeting not found' });
    res.status(200).json({ meeting });
  } catch (err: any) {
    res
      .status(500)
      .json({ message: 'Failed to fetch meeting', error: err.message });
  }
};

// ─── POST /api/v1/meetings/:id/transcript ── Submit transcript chunks ─────────
// This is called in real-time from the client's SpeechRecognition events.
// It accumulates chunks in the DB as a background task throughout the call.

export const addTranscriptChunk = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const { speaker, speakerId, text, timestamp } = req.body;

    if (!text?.trim()) {
      return res.status(400).json({ message: 'text is required' });
    }

    // A speech-recognition chunk can land just after the client flips the meeting
    // to 'ended' during teardown (e.g. trailing words before the mic stops). Accept
    // it for a short grace window after endedAt instead of dropping it with a 404.
    const TRANSCRIPT_GRACE_MS = 15_000;
    const graceWindowStart = new Date(Date.now() - TRANSCRIPT_GRACE_MS);

    const meeting = await Meeting.findOneAndUpdate(
      {
        _id: req.params.id,
        $and: [
          { $or: [{ host: userId }, { attendees: userId }] },
          { $or: [{ status: 'live' }, { status: 'ended', endedAt: { $gte: graceWindowStart } }] },
        ],
      },
      {
        $push: {
          transcriptChunks: {
            speaker: speaker || 'Unknown',
            // Attribute each chunk to the speaking user. Fall back to the authenticated
            // caller's id since Web Speech only captures the local user's own mic.
            speakerId: speakerId || String(userId || ''),
            text: text.trim(),
            timestamp: timestamp || Date.now(),
          },
        },
      },
      { returnDocument: 'after', select: '_id' }
    );

    if (!meeting) {
      return res
        .status(404)
        .json({ message: 'Live meeting not found or access denied' });
    }

    // 204 is preferred for fire-and-forget chunk saves (no body needed)
    res.status(204).end();
  } catch (err: any) {
    res
      .status(500)
      .json({ message: 'Failed to add transcript chunk', error: err.message });
  }
};

// ─── POST /api/v1/meetings/:id/files ── Log a file shared in the meeting ──────
// Called after a workspace file is uploaded so we record it against the meeting.

export const logSharedFile = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { fileId, name, fileType, fileSize, fileUrl, linkUrl, source } =
      req.body;

    if (!name) {
      return res.status(400).json({ message: 'name is required' });
    }

    const user = await User.findById(userId).select('full_name username');
    const uploadedByName = user?.full_name || user?.username || 'Unknown';

    const meeting = await Meeting.findOneAndUpdate(
      {
        _id: req.params.id,
        $or: [{ host: userId }, { attendees: userId }],
      },
      {
        $push: {
          filesShared: {
            fileId,
            name,
            fileType: fileType || 'file',
            fileSize,
            fileUrl,
            linkUrl,
            uploadedBy: userId,
            uploadedByName,
            sharedAt: new Date(),
            source: source || 'file_upload',
          },
        },
      },
      { returnDocument: 'after', select: 'filesShared' }
    );

    if (!meeting) {
      return res.status(404).json({ message: 'Meeting not found' });
    }

    const added = meeting.filesShared[meeting.filesShared.length - 1];
    res.status(201).json({ message: 'File logged to meeting', file: added });
  } catch (err: any) {
    res
      .status(500)
      .json({ message: 'Failed to log shared file', error: err.message });
  }
};

// ─── GET /api/v1/meetings/:id/files ── List files shared in a meeting ─────────

export const getMeetingFiles = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    const userId = (req as any).user?._id;

    const meeting = await Meeting.findOne({
      _id: req.params.id,
      $or: [{ host: userId }, { attendees: userId }],
    })
      .select('title filesShared')
      .populate('filesShared.uploadedBy', 'full_name username avatar');

    if (!meeting) return res.status(404).json({ message: 'Meeting not found' });

    res
      .status(200)
      .json({ title: meeting.title, files: meeting.filesShared });
  } catch (err: any) {
    res
      .status(500)
      .json({ message: 'Failed to fetch meeting files', error: err.message });
  }
};

// ─── POST /api/v1/meetings/:id/screen-share/start ── Record start ─────────────

export const startScreenShare = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { shareType, label } = req.body; // shareType: 'screen' | 'window' | 'tab'

    const user = await User.findById(userId).select('full_name username');
    const sharedByName = user?.full_name || user?.username || 'Unknown';

    const meeting = await Meeting.findOneAndUpdate(
      {
        _id: req.params.id,
        $or: [{ host: userId }, { attendees: userId }],
        status: 'live',
      },
      {
        $push: {
          screenShares: {
            sharedBy: userId,
            sharedByName,
            shareType: shareType || 'screen',
            label: label || null,
            startedAt: new Date(),
          },
        },
      },
      { returnDocument: 'after' }
    );

    if (!meeting) {
      return res.status(404).json({ message: 'Live meeting not found' });
    }

    const session =
      meeting.screenShares[meeting.screenShares.length - 1];

    res
      .status(201)
      .json({ message: 'Screen share started', session });
  } catch (err: any) {
    res
      .status(500)
      .json({ message: 'Failed to start screen share', error: err.message });
  }
};

// ─── PATCH /api/v1/meetings/:id/screen-share/:sessionId/end ── Record end ─────

export const endScreenShare = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const { sessionId } = req.params;

    const meeting = await Meeting.findOne({
      _id: req.params.id,
      $or: [{ host: userId }, { attendees: userId }],
    });

    if (!meeting) return res.status(404).json({ message: 'Meeting not found' });

    const session = (meeting.screenShares as any).id(sessionId);
    if (!session) {
      return res
        .status(404)
        .json({ message: 'Screen share session not found' });
    }

    const endedAt = new Date();
    session.endedAt = endedAt;
    session.duration = Math.round(
      (endedAt.getTime() - new Date(session.startedAt).getTime()) / 1000
    );

    await meeting.save();

    res.status(200).json({ message: 'Screen share ended', session });
  } catch (err: any) {
    res
      .status(500)
      .json({ message: 'Failed to end screen share', error: err.message });
  }
};

// ─── POST /api/v1/meetings/:id/email-transcript ── On-demand transcript email ──
export const emailTranscriptOnDemand = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?._id;
    const meeting = await Meeting.findById(req.params.id);
    if (!meeting) {
      res.status(404).json({ success: false, message: 'Meeting not found' });
      return;
    }

    const user = await User.findById(userId).select('email full_name username');
    if (!user?.email) {
      res.status(400).json({ success: false, message: 'Your account has no email address' });
      return;
    }

    const rawTranscript = (meeting as any).transcriptRaw ||
      ((meeting as any).transcriptChunks || [])
        .map((c: any) => `${c.speaker ? c.speaker + ': ' : ''}${c.text}`)
        .join('\n');

    if (!rawTranscript && !(meeting as any).summary) {
      res.status(400).json({ success: false, message: 'No transcript or summary available for this meeting' });
      return;
    }

    const { sendMeetingTranscriptEmail } = await import('../utils/mailer');
    await sendMeetingTranscriptEmail(
      user.email,
      user.full_name || user.username || 'Attendee',
      (meeting as any).title || 'Meeting',
      rawTranscript || '',
      (meeting as any).summary || '',
      ((meeting as any).actionItems || []).map((ai: any) => ({
        text: ai.text || String(ai),
        assignedToName: ai.assignedToName || undefined,
      }))
    );

    res.json({ success: true, message: 'Transcript emailed to ' + user.email });
  } catch (err: any) {
    console.error('[Meeting] email-transcript on-demand error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to send email' });
  }
};

// ─── POST /api/v1/meetings/:id/end ── End meeting + AI background extraction ──

export const endMeeting = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const saveToStorage = req.body.saveToStorage !== false;
    const sendEmail = req.body.sendEmail !== false;

    const searchId = String(req.params.id);
    const isObjectId = mongoose.Types.ObjectId.isValid(searchId);

    const meeting = await Meeting.findOne({
      $or: [
        ...(isObjectId ? [{ _id: searchId }] : []),
        { roomId: searchId },
      ],
      $and: [{ $or: [{ host: userId }, { attendees: userId }] }],
    });

    if (!meeting)
      return res.status(404).json({ message: 'Meeting not found' });

    // A multi-party meeting only terminates for everyone when the host ends it.
    // A non-host calling /end is just leaving — keep the meeting 'live' for the
    // rest of the group instead of tearing it down under them. 1:1 calls (at most
    // one other attendee) keep the old phone-call semantics: either side ends it.
    const isHost = String(meeting.host) === String(userId);
    const isGroupMeeting = (meeting.attendees?.length || 0) >= 2;
    if (isGroupMeeting && !isHost) {
      return res.status(200).json({ message: 'Left meeting', meeting, left: true });
    }

    const endedAt = new Date();
    const duration = Math.round(
      (endedAt.getTime() - meeting.startedAt.getTime()) / 1000
    );

    // Compile raw transcript from accumulated real-time chunks
    const rawTranscript =
      meeting.transcriptChunks
        ?.map(
          (c) => `${c.speaker ? c.speaker + ': ' : ''}${c.text}`
        )
        .join('\n') ||
      req.body.transcriptRaw ||
      '';

    // Mark as ended immediately — AI runs in background
    meeting.endedAt = endedAt;
    meeting.duration = duration;
    meeting.status = 'ended';
    meeting.transcriptRaw = rawTranscript;
    await meeting.save();

    // Broadcast meeting_ended via socket immediately to terminate the view for all participants
    try {
      const { getIO } = await import('../utils/socket');
      const io = getIO();
      // Emit to both the roomId and each participant's personal room for cross-device delivery
      const endPayload = {
        roomId: meeting.roomId,
        meetingId: String(meeting._id),
        title: meeting.title,
        // summary/actionItems will be populated by background AI and re-emitted after
      };
      io.to(meeting.roomId).emit('meeting_ended', endPayload);
      // Also emit to each participant's personal user room so all their devices get it
      const allParticipantIds = [String(meeting.host), ...meeting.attendees.map((a: any) => String(a))];
      for (const pid of allParticipantIds) {
        io.to(pid).emit('meeting_ended', endPayload);
      }
      console.log(`[Meeting] Broadcasted meeting_ended for room ${meeting.roomId} to ${allParticipantIds.length} participants`);
    } catch (socketErr) {
      console.error('[Meeting] Socket emit meeting_ended failed:', socketErr);
    }

    // Respond to client immediately so UI isn't blocked
    res.status(200).json({
      message: 'Meeting ended. AI analysis is running in the background.',
      meeting,
    });

    // A group's admin-set transcript policy overrides the caller's ad-hoc choice for that
    // group's meetings: 'off' = keep nothing, 'save' = store only, 'email' = email members.
    let effectiveSave = saveToStorage;
    let effectiveEmail = sendEmail;
    try {
      if (meeting.chatId) {
        const convo = await Conversation.findById(meeting.chatId).select('isGroupChat transcriptPolicy');
        if (convo && convo.isGroupChat && convo.transcriptPolicy) {
          if (convo.transcriptPolicy === 'off') { effectiveSave = false; effectiveEmail = false; }
          else if (convo.transcriptPolicy === 'save') { effectiveSave = true; effectiveEmail = false; }
          else if (convo.transcriptPolicy === 'email') { effectiveSave = true; effectiveEmail = true; }
        }
      }
    } catch (policyErr) {
      console.error('[endMeeting] Failed to apply group transcript policy:', policyErr);
    }

    // ── Background AI extraction (non-blocking) ───────────────────────────
    setImmediate(async () => {
      await runBackgroundMeetingAI(meeting, rawTranscript, String(userId), effectiveSave, effectiveEmail);
    });
  } catch (err: any) {
    res
      .status(500)
      .json({ message: 'Failed to end meeting', error: err.message });
  }
};

// ─── Server safeguard: auto-end a meeting whose LiveKit room has emptied ──────
// Called from socket.ts after a grace period once the last socket leaves a
// meeting room (host disconnected without clicking End, or a network drop left
// nobody behind). Mirrors endMeeting's termination + background-AI path but
// has no req/res — it's invoked off the socket lifecycle, not an HTTP call.
export const autoEndMeetingByRoomId = async (roomId: string): Promise<void> => {
  try {
    const meeting = await Meeting.findOne({ roomId, status: 'live' });
    if (!meeting) return;

    const endedAt = new Date();
    const duration = Math.round(
      (endedAt.getTime() - meeting.startedAt.getTime()) / 1000
    );
    const rawTranscript =
      meeting.transcriptChunks
        ?.map((c) => `${c.speaker ? c.speaker + ': ' : ''}${c.text}`)
        .join('\n') || '';

    meeting.endedAt = endedAt;
    meeting.duration = duration;
    meeting.status = 'ended';
    meeting.transcriptRaw = rawTranscript;
    await meeting.save();

    try {
      const { getIO } = await import('../utils/socket');
      const io = getIO();
      const endPayload = {
        roomId: meeting.roomId,
        meetingId: String(meeting._id),
        title: meeting.title,
      };
      io.to(meeting.roomId).emit('meeting_ended', endPayload);
      const allParticipantIds = [String(meeting.host), ...meeting.attendees.map((a: any) => String(a))];
      for (const pid of allParticipantIds) {
        io.to(pid).emit('meeting_ended', endPayload);
      }
    } catch (socketErr) {
      console.error('[Meeting] autoEndMeetingByRoomId socket emit failed:', socketErr);
    }

    console.log(`[Meeting] Auto-ended empty-room meeting ${meeting._id} (room ${roomId})`);

    setImmediate(async () => {
      // No explicit user chose save/email preferences here — default to saving the
      // transcript to storage (so the history isn't silently lost) without emailing
      // anyone, since an unattended auto-end is not the same as a deliberate end.
      await runBackgroundMeetingAI(meeting, rawTranscript, String(meeting.host), true, false);
    });
  } catch (err) {
    console.error('[Meeting] autoEndMeetingByRoomId failed:', err);
  }
};

// Helper to execute all post-meeting background AI extraction tasks (summaries, actions, docs, notifications)
export const runBackgroundMeetingAI = async (
  meeting: any,
  rawTranscript: string,
  userId: string,
  saveToStorage: boolean,
  sendEmail: boolean
) => {
  try {
    const allParticipants = [meeting.host, ...meeting.attendees];

    // Stop the audio recording now that the meeting ended (unconditional — halts
    // egress and its cost even when live captions were sufficient).
    if (meeting.egressId) {
      try {
        const { stopRoomAudioEgress } = await import('../utils/livekitEgress');
        await stopRoomAudioEgress(meeting.egressId);
      } catch (stopErr) {
        console.error('[Meeting AI] Failed to stop egress:', stopErr);
      }
    }

    // BACKSTOP: if live speech-recognition produced little/no transcript (e.g. the
    // call was on Safari/Firefox/mobile), transcribe the LiveKit Egress recording
    // via Whisper so every meeting still yields a transcript. No-ops until Egress
    // is enabled and meeting.recordingKey is set.
    if ((!rawTranscript || rawTranscript.trim().length < 20) && meeting.recordingKey) {
      try {
        // Give LiveKit a moment to finalize + upload the recording to S3.
        await new Promise((r) => setTimeout(r, 6000));
        const { transcribeMeetingRecording } = await import('../utils/livekitEgress');
        const fromAudio = await transcribeMeetingRecording(meeting.recordingKey);
        if (fromAudio && fromAudio.trim()) {
          rawTranscript = fromAudio;
          await Meeting.findByIdAndUpdate(meeting._id, { $set: { transcriptRaw: fromAudio } });
          console.log(`[Meeting AI] Transcribed Egress recording for meeting ${meeting._id} (${fromAudio.length} chars).`);
        }
      } catch (whisperErr) {
        console.error('[Meeting AI] Egress transcription failed:', whisperErr);
      }
    }

    const intelligence = await extractMeetingIntelligence(
      rawTranscript,
      meeting.attendeeNames || []
    );

    // Resolve action items → map names to user IDs
    const resolvedActionItems = await Promise.all(
      intelligence.actionItems.map(async (ai) => {
        let assignedTo: any = undefined;
        if (ai.assignedToName) {
          const found = await User.findOne({
            $or: [
              {
                full_name: {
                  $regex: ai.assignedToName,
                  $options: 'i',
                },
              },
              {
                username: {
                  $regex: ai.assignedToName,
                  $options: 'i',
                },
              },
            ],
            _id: { $in: [...meeting.attendees, meeting.host] },
          }).select('_id');
          if (found) assignedTo = found._id;
        }
        return {
          text: ai.text,
          assignedToName: ai.assignedToName,
          assignedTo,
          status: 'pending',
        };
      })
    );

    // Persist AI results
    await Meeting.findByIdAndUpdate(meeting._id, {
      $set: {
        summary: intelligence.summary,
        actionItems: resolvedActionItems,
      },
    });

    // Auto-create synced Calendar tasks. Re-processing (scheduler catch-up or a
    // manual regenerate) must not duplicate: remove this meeting's previously
    // auto-created tasks that are still open — completed ones are kept as history.
    await Task.deleteMany({
      meetingRef: meeting._id,
      source: 'meeting',
      status: { $nin: ['done', 'cancelled'] },
    }).catch((err: any) => console.error('[Meeting AI] stale task cleanup failed:', err));

    const createdTasks = [];
    for (const ai of resolvedActionItems) {
      if (ai.text) {
        const task = await Task.create({
          user_id: ai.assignedTo || meeting.host,
          assignedTo: ai.assignedTo,
          assignedToName: ai.assignedToName,
          type: 'synced',
          source: 'meeting',
          meetingRef: meeting._id,
          title: ai.text,
          description: `From meeting: ${meeting.title}`,
          start_time: new Date(),
          end_time: new Date(Date.now() + 24 * 60 * 60 * 1000),
          priority: 'medium',
          status: 'todo',
        });
        createdTasks.push(task);
        // Link the meeting's action item back to its Task so status changes can be
        // mirrored both ways (see updateTask's meeting sync).
        (ai as any).taskRef = task._id;

        if (ai.assignedTo) {
          await createNotification({
            recipient: ai.assignedTo,
            sender: meeting.host,
            type: 'meeting_action_item',
            title: 'New action item assigned',
            body: `From meeting "${meeting.title}": ${ai.text}`,
            entityId: String(task._id),
            entityType: 'Task',
          });
        }
      }
    }

    // Persist the taskRef linkage onto Meeting.actionItems (they were saved above
    // before the Tasks existed).
    if (createdTasks.length > 0) {
      await Meeting.findByIdAndUpdate(meeting._id, {
        $set: { actionItems: resolvedActionItems },
      });
    }

    // Find organization for meeting host and save Minutes as a .md document to storage center
    const hostUser = await User.findById(meeting.host);
    let org = null;
    if (hostUser) {
      const { resolveUserOrg } = await import('../utils/orgResolver');
      org = await resolveUserOrg(hostUser);
    }

    if (org && saveToStorage) {
      try {
        const { OrgDocument } = await import('../models/orgDocument');
        const minutesTitle = `Meeting Minutes: ${meeting.title}`;
        const formattedActionItems = resolvedActionItems
          .map((ai) => `- ${ai.text} (Assigned to: ${ai.assignedToName || 'Unassigned'})`)
          .join('\n');
        const minutesContent = `# Meeting Minutes: ${meeting.title}\n\n**Date:** ${new Date().toLocaleDateString()}\n**Duration:** ${meeting.duration ? Math.floor(meeting.duration / 60) + ' minutes' : 'unknown'}\n\n## Summary\n${intelligence.summary}\n\n## Action Items\n${formattedActionItems || 'None'}`;

        await OrgDocument.create({
          title: minutesTitle,
          content: minutesContent,
          department: 'general',
          accessLevel: 'public',
          createdBy: meeting.host,
          organizationId: org._id,
          tags: ['minutes', 'meeting', meeting.title.toLowerCase()],
        });
        console.log(`[Meeting AI] Saved meeting minutes as OrgDocument for org: ${org.name}`);
      } catch (docErr) {
        console.error('[Meeting AI] Failed to save minutes document:', docErr);
      }
    }

    // Email participants with the full AI summary + transcript
    if (sendEmail) {
      const { sendMeetingTranscriptEmail } = await import('../utils/mailer');
      for (const participantId of allParticipants) {
        try {
          const user = await User.findById(participantId);
          if (user && user.email && (user as any).privacy_settings?.email_notifications !== false) {
            await sendMeetingTranscriptEmail(
              user.email,
              user.full_name || user.username || 'Attendee',
              meeting.title,
              rawTranscript,
              intelligence.summary,
              resolvedActionItems.map(ai => ({ text: ai.text, assignedToName: ai.assignedToName }))
            );
            console.log(`[Meeting Email] Transcript email sent to: ${user.email}`);
          }
        } catch (emailErr) {
          console.error('[Meeting Email] Failed sending transcript email:', emailErr);
        }
      }

      // Absentee catch-up: org members who were NOT in the meeting get a SHORT
      // recap (summary only) so the whole team stays caught up. Best-effort.
      if (org && intelligence.summary) {
        try {
          const { sendMeetingRecapEmail } = await import('../utils/mailer');
          const participantIds = new Set(allParticipants.map((p: any) => String(p)));
          const absentees = await User.find({
            organizationId: org._id,
            _id: { $nin: Array.from(participantIds) },
            email: { $exists: true, $ne: '' },
            is_bot: { $ne: true },
            'privacy_settings.email_notifications': { $ne: false },
          }).select('email full_name username').limit(200);

          for (const member of absentees) {
            try {
              if (member.email) {
                await sendMeetingRecapEmail(
                  member.email,
                  member.full_name || member.username || 'there',
                  meeting.title,
                  intelligence.summary
                );
              }
            } catch (recapErr) {
              console.error('[Meeting Email] Failed sending absentee recap:', recapErr);
            }
          }
          console.log(`[Meeting Email] Absentee recap sent to ${absentees.length} org member(s).`);
        } catch (absErr) {
          console.error('[Meeting Email] Absentee recap pass failed:', absErr);
        }
      }
    }

    // Push transcript + summary through the unified brain event bus.
    // The listener handles chunking, embedding, Pinecone upsert, OrgDocument save,
    // and expertise-radar updates — keeping a single ingestion code path.
    if (org && rawTranscript) {
      try {
        const { brainEventBus } = await import('../utils/brainEventListener');
        brainEventBus.emit('meeting_ended', {
          meetingId: String(meeting._id),
          organizationId: String(org._id),
          hostId: String(meeting.host),
          title: meeting.title,
          transcript: rawTranscript,
          summary: intelligence.summary || '',
          tags: ['transcript', 'meeting', meeting.title.toLowerCase()],
        });
      } catch (busErr) {
        console.error('[Meeting Brain] Failed to emit meeting_ended:', busErr);
      }
    }

    // Drop a "📝 Meeting minutes ready" system message into the originating
    // chat so the transcript download surfaces directly in the conversation
    // where the call started.
    if (meeting.chatId) {
      try {
        const baseUrl = process.env.API_PUBLIC_URL || process.env.BASE_URL || '';
        const transcriptUrl = `${baseUrl}/api/v1/meetings/${meeting._id}/transcript.md`;
        const systemContent = `📝 Meeting minutes ready for "${meeting.title}". ${resolvedActionItems.length} action item${resolvedActionItems.length === 1 ? '' : 's'} captured.`;

        const systemMessage = await Message.create({
          chat: meeting.chatId,
          sender: meeting.host,
          content: systemContent,
          message_type: 'file',
          mediaUrl: transcriptUrl,
          mediaType: 'file',
          media_metadata: { mime_type: 'text/markdown' },
          is_announcement: true,
        });

        await Conversation.findByIdAndUpdate(meeting.chatId, {
          latestMessage: systemMessage._id,
        });

        try {
          const { getIO } = await import('../utils/socket');
          const io = getIO();
          io.to(String(meeting.chatId)).emit('new_message', systemMessage);
        } catch (_) { /* silent */ }
      } catch (chatErr) {
        console.error('[Meeting Minutes] Failed to post system message:', chatErr);
      }
    }

    // Re-broadcast meeting_ended with AI intelligence for live UI updates
    try {
      const { getIO } = await import('../utils/socket');
      const io = getIO();
      const enrichedPayload = {
        roomId: meeting.roomId,
        meetingId: String(meeting._id),
        title: meeting.title,
        summary: intelligence.summary,
        actionItems: resolvedActionItems.map(ai => ({ text: ai.text, assignedToName: ai.assignedToName })),
        rawTranscript,
      };
      io.to(meeting.roomId).emit('meeting_ended', enrichedPayload);
      const allParticipantIds2 = [String(meeting.host), ...meeting.attendees.map((a: any) => String(a))];
      for (const pid of allParticipantIds2) {
        io.to(pid).emit('meeting_ended', enrichedPayload);
      }
    } catch (_) { /* silent */ }

    // Notify all participants that minutes are ready
    for (const participantId of allParticipants) {
      if (String(participantId) !== String(userId)) {
        await createNotification({
          recipient: participantId,
          sender: userId,
          type: 'meeting_ended',
          title: `Meeting ended: ${meeting.title}`,
          body: `${resolvedActionItems.length} action items were extracted. Check your Calendar.`,
          entityId: String(meeting._id),
          entityType: 'Meeting',
        });
      }
    }

    await logActivity({
      actor: userId,
      action: 'meeting_ended',
      entityId: String(meeting._id),
      entityType: 'Meeting',
      entityLabel: meeting.title,
      metadata: {
        duration: meeting.duration || 0,
        actionItemCount: resolvedActionItems.length,
        tasksCreated: createdTasks.length,
      },
    });
  } catch (bgErr) {
    console.error('[Meeting AI] Background extraction failed:', bgErr);
  }
};

// ─── POST /api/v1/meetings/:id/transcribe-upload ── Transcribe uploaded recording ──
export const transcribeUpload = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    if (!req.file) {
      return res.status(400).json({ message: 'No audio file uploaded' });
    }
    const searchId = String(req.params.id);
    const isObjectId = mongoose.Types.ObjectId.isValid(searchId);

    let meeting = await Meeting.findOne({
      $or: [
        ...(isObjectId ? [{ _id: searchId }] : []),
        { roomId: searchId },
      ],
    });

    // If meeting is not found, check if this is a scheduled meeting task
    if (!meeting && isObjectId) {
      const task = await Task.findOne({
        _id: searchId,
        $or: [{ user_id: userId }, { assignedTo: userId }],
      });
      if (task && task.type === 'meeting') {
        meeting = await Meeting.create({
          roomId: String(task._id),
          title: task.title,
          host: task.user_id,
          type: task.meetingType || 'video',
          attendees: task.recipients || [],
          attendeeNames: [],
          startedAt: task.start_time || new Date(),
          status: 'ended',
        });
        task.meetingRef = meeting._id;
        await task.save();
      }
    }

    if (!meeting) {
      return res.status(404).json({ message: 'Meeting or Meeting-Task not found' });
    }

    // Parse speakerNames
    let speakerNames: string[] = [];
    try {
      if (req.body.speakerNames) {
        if (typeof req.body.speakerNames === 'string') {
          try {
            speakerNames = JSON.parse(req.body.speakerNames);
          } catch (_) {
            speakerNames = req.body.speakerNames.split(',').map((s: string) => s.trim());
          }
        } else if (Array.isArray(req.body.speakerNames)) {
          speakerNames = req.body.speakerNames;
        }
      }
    } catch (err) {
      console.warn('[transcribeUpload] Failed to parse speakerNames:', err);
    }

    // Resolve speakerNames if empty
    if (speakerNames.length === 0) {
      const hostUser = await User.findById(meeting.host).select('full_name username');
      const attendeeUsers = await User.find({ _id: { $in: meeting.attendees } }).select('full_name username');
      speakerNames = [
        hostUser ? (hostUser.full_name || hostUser.username || 'Host') : 'Host',
        ...attendeeUsers.map(u => u.full_name || u.username || 'Attendee')
      ];
    }

    // Call whisperService to transcribe. It attributes a speaker only when the
    // recording has a single known participant; a mixed/composite recording stays
    // unattributed rather than guessed.
    const { transcribeWithTimestamps } = await import('../utils/whisperService');
    const chunks = await transcribeWithTimestamps(req.file.path, speakerNames);

    // Keep the truthful speaker (may be undefined for mixed audio) — do NOT rotate
    // names per chunk, which fabricated confidently-wrong attribution.
    const annotatedChunks = chunks.map((chunk) => ({
      speaker: chunk.speaker,
      text: chunk.text,
      timestamp: chunk.timestamp || Date.now(),
    }));

    const rawTranscript = annotatedChunks
      .map(c => `${c.speaker ? c.speaker + ': ' : ''}${c.text}`)
      .join('\n');

    // Overwrite meeting transcript fields
    meeting.transcriptChunks = annotatedChunks;
    meeting.transcriptRaw = rawTranscript;
    meeting.status = 'ended';
    meeting.endedAt = new Date();
    if (!meeting.duration && chunks.length > 0) {
      const maxTime = Math.max(...chunks.map(c => c.timestamp || 0));
      meeting.duration = maxTime > 0 ? maxTime : undefined;
    }
    await meeting.save();

    // Trigger the background AI intelligence
    setImmediate(async () => {
      await runBackgroundMeetingAI(meeting, rawTranscript, String(userId), true, true);
    });

    res.status(200).json({
      message: 'Audio transcribed and saved successfully. AI processing in progress.',
      transcriptRaw: rawTranscript,
      transcriptChunks: annotatedChunks,
    });
  } catch (err: any) {
    console.error('[transcribeUpload] Error:', err);
    res.status(500).json({ message: 'Failed to transcribe uploaded recording', error: err.message });
  }
};

// ─── GET /api/v1/meetings/:id/action-items ────────────────────────────────────

export const getMeetingActionItems = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const meeting = await Meeting.findOne({
      _id: req.params.id,
      $or: [{ host: userId }, { attendees: userId }],
    })
      .select('title actionItems summary')
      .populate('actionItems.assignedTo', 'full_name username avatar');

    if (!meeting)
      return res.status(404).json({ message: 'Meeting not found' });

    res.status(200).json({
      title: meeting.title,
      summary: meeting.summary,
      actionItems: meeting.actionItems,
    });
  } catch (err: any) {
    res
      .status(500)
      .json({ message: 'Failed to fetch action items', error: err.message });
  }
};

// ─── GET /api/v1/meetings/:id/transcript.md ──────────────────────────────────
// Returns the meeting transcript as a markdown document. Only the host and
// attendees may download.
export const downloadTranscriptMarkdown = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user?._id;
    const meeting = await Meeting.findOne({
      _id: req.params.id,
      $or: [{ host: userId }, { attendees: userId }],
    })
      .populate('host', 'full_name username')
      .populate('attendees', 'full_name username');

    if (!meeting) return res.status(404).json({ message: 'Meeting not found' });

    const hostName = (meeting.host as any)?.full_name || (meeting.host as any)?.username || 'Host';
    const attendeeLines = ((meeting.attendees as any[]) || [])
      .map((a) => `- ${a.full_name || a.username || 'Attendee'}`)
      .join('\n');

    const chunks = meeting.transcriptChunks || [];
    const fmtTimestamp = (ts?: number) => {
      if (!ts) return '';
      const seconds = Math.floor(ts / 1000);
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}]`;
    };

    const transcriptBody = chunks.length > 0
      ? chunks
          .map((c) => `${fmtTimestamp(c.timestamp)} **${c.speaker || 'Speaker'}**: ${c.text}`)
          .join('\n\n')
      : (meeting.transcriptRaw || '_No transcript captured._');

    const decisions = ''; // future: surface meeting.summary structured decisions
    const actionItems = (meeting.actionItems || [])
      .map((a) => `- ${a.text}${a.assignedToName ? ` — _${a.assignedToName}_` : ''}`)
      .join('\n');

    const md = [
      `# ${meeting.title}`,
      ``,
      `**Host:** ${hostName}  `,
      `**Date:** ${meeting.startedAt.toISOString().slice(0, 10)}  `,
      meeting.endedAt ? `**Ended:** ${meeting.endedAt.toISOString()}  ` : '',
      ``,
      `## Attendees`,
      attendeeLines || '_No attendees recorded._',
      ``,
      `## Summary`,
      meeting.summary || '_Summary not yet generated._',
      ``,
      decisions ? `## Decisions\n${decisions}\n` : '',
      `## Action Items`,
      actionItems || '_None._',
      ``,
      `## Transcript`,
      transcriptBody,
      ``,
    ]
      .filter((l) => l !== undefined)
      .join('\n');

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${meeting.title.replace(/[^a-z0-9-_ ]/gi, '_')}.md"`
    );
    return res.status(200).send(md);
  } catch (err: any) {
    return res.status(500).json({ message: 'Failed to render transcript', error: err.message });
  }
};