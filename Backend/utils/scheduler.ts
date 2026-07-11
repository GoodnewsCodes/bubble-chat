import cron from 'node-cron';
import crypto from 'crypto';
import { SecurityCode } from '../models/security';

/**
 * Bubble Chat Weekly Security Rotation Service
 * Generates a new, cryptographically strong security number every week.
 */

// 1. Generate a new security code
export const rotateSecurityCode = async () => {
  try {
    await SecurityCode.updateMany({ isCurrent: true }, { isCurrent: false });

    const newCode = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const code = await SecurityCode.create({
      code: newCode,
      isCurrent: true,
      expiresAt: expiresAt,
    });

    console.log(`🔒 SECURITY UPDATED: New Weekly Security Code rotation completed. ID: ${code._id}`);
    return code;
  } catch (err) {
    console.error('❌ Error during security code rotation:', err);
  }
};

// 2. Schedule the security rotation task
export const initSecurityScheduler = () => {
  // Sunday at 00:00 (Midnight)
  cron.schedule('0 0 * * 0', async () => {
    console.log('⏳ Sunday Midnight: Initiating weekly security rotation...');
    await rotateSecurityCode();
  });

  SecurityCode.findOne({ isCurrent: true }).then(async (code) => {
    if (!code) {
      console.log('🛡️ No active security code found. Initializing first-run rotation...');
      await rotateSecurityCode();
    }
  });
};

// ─── Background Transcript Processor ─────────────────────────────────────────

/**
 * Processes ended meetings that have unprocessed transcripts.
 * Runs every 5 minutes. Uses HuggingFace if available, otherwise extracts
 * action items via local pattern matching.
 */
export const processTranscriptQueue = async () => {
  try {
    const { Meeting } = await import('../models/meeting');
    const { extractMeetingIntelligence } = await import('../controllers/meetingController');
    const { resolveUserOrg } = await import('./orgResolver');
    const { brainEventBus } = await import('./brainEventListener');

    // Find ended meetings with raw transcript but no summary yet
    const unprocessed = await Meeting.find({
      status: 'ended',
      $or: [
        { transcriptRaw: { $exists: true, $ne: '' } },
        { transcriptChunks: { $exists: true, $not: { $size: 0 } } },
      ],
      summary: { $in: [null, ''] as any },
    }).limit(5);

    if (unprocessed.length === 0) return;

    console.log(`🎙️ [Transcript] Processing ${unprocessed.length} meeting transcript(s)...`);

    for (const meeting of unprocessed) {
      try {
        // Build full transcript text
        let fullText = meeting.transcriptRaw || '';
        if (!fullText && meeting.transcriptChunks?.length) {
          fullText = meeting.transcriptChunks
            .map(c => c.speaker ? `[${c.speaker}]: ${c.text}` : c.text)
            .join('\n');
        }

        if (!fullText || fullText.trim().length < 20) {
          // Mark as processed with placeholder
          meeting.summary = 'No transcript content available for this meeting.';
          await meeting.save();
          continue;
        }

        const attendeeNames = meeting.attendeeNames || [];

        // Local regex extraction as the safety-net fallback (always available).
        const lines = fullText.split(/[.\n!?]/);
        const actionPatterns = /\b(will|should|must|needs? to|action:|todo:|task:|going to|i'll|we'll)\b/i;
        const localActionItems: { text: string; assignedToName: string | null }[] = [];
        lines.forEach(line => {
          const trimmed = line.trim();
          if (trimmed.length > 15 && actionPatterns.test(trimmed)) {
            const assignedTo = attendeeNames.find(n => trimmed.toLowerCase().includes(n.toLowerCase())) || null;
            localActionItems.push({ text: trimmed, assignedToName: assignedTo });
          }
        });

        // Primary: the SAME DeepSeek intelligence the live meeting-end path uses.
        let summary = '';
        try {
          const intelligence = await extractMeetingIntelligence(fullText, attendeeNames);
          if (intelligence.summary) summary = intelligence.summary;
          if (intelligence.actionItems?.length > 0) {
            meeting.actionItems = intelligence.actionItems.map((item: any) => ({
              text: item.text,
              assignedToName: item.assignedToName || null,
              status: 'pending',
            })) as any;
          }
        } catch (aiErr) {
          console.warn(`[Transcript] DeepSeek processing failed for meeting ${meeting._id}, using local extraction.`, aiErr);
        }

        // Fallback summary/action items if DeepSeek returned nothing usable.
        if (!summary) {
          summary = `Meeting: ${meeting.title}. Duration: ${meeting.duration ? Math.floor(meeting.duration / 60) + ' minutes' : 'unknown'}. ` +
            (localActionItems.length > 0 ? `${localActionItems.length} action item(s) identified.` : 'No action items detected.');
          if (localActionItems.length > 0 && (!meeting.actionItems || meeting.actionItems.length === 0)) {
            meeting.actionItems = localActionItems.map(item => ({
              text: item.text,
              assignedToName: item.assignedToName || null,
              status: 'pending',
            })) as any;
          }
        }

        meeting.summary = summary;
        await meeting.save();
        console.log(`✅ [Transcript] Processed meeting ${meeting._id}: "${meeting.title}"`);

        // Close the safety-net brain gap: meetings the live path missed still get
        // ingested. The meeting_ended listener handles chunk/embed/upsert.
        try {
          const host = await (await import('../models/users')).User.findById(meeting.host);
          const org = host ? await resolveUserOrg(host) : null;
          if (org) {
            brainEventBus.emit('meeting_ended', {
              meetingId: String(meeting._id),
              organizationId: String(org._id),
              hostId: String(meeting.host),
              title: meeting.title,
              transcript: fullText,
              summary,
              tags: ['transcript', 'meeting', meeting.title.toLowerCase()],
            });
          }
        } catch (brainErr) {
          console.error(`[Transcript] Brain emit failed for meeting ${meeting._id}:`, brainErr);
        }
      } catch (meetingErr) {
        console.error(`❌ [Transcript] Failed for meeting ${meeting._id}:`, meetingErr);
      }
    }
  } catch (err) {
    console.error('❌ [Transcript] Queue processing error:', err);
  }
};

// 3. Initialize transcript background processor
export const initTranscriptProcessor = () => {
  // Run every 5 minutes. The re-embed pass rides along so brain documents whose
  // Pinecone upsert failed (embedStatus: 'failed') heal automatically.
  cron.schedule('*/5 * * * *', async () => {
    await processTranscriptQueue();
    try {
      const { reembedFailedDocs } = await import('./brainIngest');
      await reembedFailedDocs();
    } catch (err) {
      console.error('❌ [BrainIngest] re-embed pass error:', err);
    }
  });

  // Run once at startup
  setTimeout(async () => {
    await processTranscriptQueue();
  }, 10000); // 10s after boot

  console.log('🎙️ [Transcript] Background processor initialized (runs every 5 min).');
};

// ─── Task & Goal Reminder Automation ──────────────────────────────────────────

/**
 * Checks for tasks that are due soon and sends email reminders.
 * Runs every 30 minutes.
 */
export const processTaskReminders = async () => {
  try {
    const { Task } = await import('../models/task');
    const { User } = await import('../models/users');
    const { sendTaskReminderEmail } = await import('./mailer');

    // We evaluate tasks starting/ending within the next 5.5 days that aren't fully reminded
    const now = new Date();
    const imminentWindow = new Date(now.getTime() + 5.5 * 24 * 60 * 60 * 1000);

    const upcomingTasks = await Task.find({
      status: { $in: ['todo', 'in-progress'] },
      $or: [
        { end_time: { $gte: now, $lte: imminentWindow } },
        { start_time: { $gte: now, $lte: imminentWindow } }
      ]
    }).limit(50);

    if (upcomingTasks.length === 0) return;

    for (const task of upcomingTasks) {
      if (!task.end_time && !task.start_time) continue;

      const targetDate = task.end_time || task.start_time;
      const diffMs = targetDate.getTime() - now.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);

      const levelsStr = (task as any).reminderLevelsSent || [];
      let newLevel = null;

      // 5-2-1 Logic Thresholds
      if (diffDays <= 5.1 && diffDays > 2 && !levelsStr.includes('5d')) {
        newLevel = '5d';
      } else if (diffDays <= 2.1 && diffDays > 1 && !levelsStr.includes('2d')) {
        newLevel = '2d';
      } else if (diffDays <= 1.1 && diffDays > 0 && !levelsStr.includes('1d')) {
        newLevel = '1d';
      }

      if (!newLevel) continue;

      try {
        const assignedUserId = task.assignedTo || task.user_id;
        const user = await User.findById(assignedUserId);

        const emailMode: string = (user as any)?.actionItemEmailMode ?? 'each';
        const emailsAllowed = (user as any)?.privacy_settings?.email_notifications !== false;
        if (user && user.email && emailMode === 'each' && emailsAllowed) {
          const daysText = newLevel === '5d' ? '5 days' : newLevel === '2d' ? '2 days' : '1 day';
          await sendTaskReminderEmail(
            user.email,
            user.full_name || user.username || 'User',
            `${task.title} (Starts in ${daysText})`,
            targetDate,
            task.description
          );

          (task as any).reminderLevelsSent = levelsStr;
          (task as any).reminderLevelsSent.push(newLevel);
          await task.save();
          console.log(`✅ [TaskReminders] ${newLevel} email sent for Task ${task._id}`);
        } else {
          // Prevent infinite loop if no email mapped
          (task as any).reminderLevelsSent = levelsStr;
          (task as any).reminderLevelsSent.push(newLevel);
          await task.save();
        }
      } catch (err) {
        console.error(`❌ [TaskReminders] Failed processing task ${task._id}:`, err);
      }
    }
  } catch (err) {
    console.error('❌ [TaskReminders] Scheduler processing error:', err);
  }
};

export const initTaskReminderScheduler = () => {
  // Check every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    await processTaskReminders();
  });

  console.log('⏰ [TaskReminders] Background auto-reminder initialized (runs every 30 min).');
};

/**
 * "Meeting begins → ring everyone" — when a scheduled meeting's start time
 * arrives, ring every invited attendee (WhatsApp-style): an `incoming_call`
 * socket event for anyone with the app open, plus a push notification so it also
 * rings when the app is closed. Runs every minute; each meeting is rung exactly
 * once (guarded by `startRingSentAt`).
 */
export const processMeetingStartRings = async () => {
  try {
    const { Task } = await import('../models/task');
    const { User } = await import('../models/users');
    const { getIO } = await import('./socket');
    const { sendPushNotification } = await import('./push');

    const now = new Date();
    // Fire for meetings whose start time is within the last 60s (a minute-resolution
    // cron can land just after start) up to 30s ahead. Never ring a meeting that
    // started long ago (missed by downtime) — that would ring people out of the blue.
    const windowStart = new Date(now.getTime() - 60 * 1000);
    const windowEnd = new Date(now.getTime() + 30 * 1000);

    const due = await Task.find({
      type: 'meeting',
      status: { $in: ['todo', 'in-progress'] },
      start_time: { $gte: windowStart, $lte: windowEnd },
      startRingSentAt: { $exists: false },
    }).limit(25);

    if (due.length === 0) return;

    let io: any = null;
    try { io = getIO(); } catch { /* socket not ready — skip this pass */ }
    if (!io) return;

    for (const task of due) {
      try {
        const hostId = String(task.assignedTo || task.user_id);
        const host = await User.findById(hostId).select('full_name username');
        const hostName = host?.full_name || host?.username || 'Someone';
        const type = task.meetingType || 'video';
        // Deterministic room id so every attendee who accepts lands in the SAME room.
        const roomId = `bubble-evt-${String(task._id)}`;

        const attendees = new Set<string>([
          ...((task.recipients || []) as any[]).map(String),
          hostId,
        ]);

        for (const uid of attendees) {
          io.to(uid).emit('incoming_call', {
            fromUserId: hostId,
            roomId,
            callerName: `${task.title}`,
            type,
            isEvent: true,
          });
        }

        sendPushNotification(
          [...attendees],
          `Meeting starting: ${task.title}`,
          `${hostName}'s meeting is starting now — tap to join.`,
          { roomId, type: 'incoming_call', callType: type, callerName: task.title, isEvent: true },
          'call'
        ).catch(err => console.error('[MeetingRing] push failed:', err));

        (task as any).startRingSentAt = new Date();
        await task.save();
        console.log(`🔔 [MeetingRing] Rang ${attendees.size} attendee(s) for meeting "${task.title}" (${task._id}).`);
      } catch (err) {
        console.error(`❌ [MeetingRing] Failed ringing meeting ${task._id}:`, err);
      }
    }
  } catch (err) {
    console.error('❌ [MeetingRing] Scheduler processing error:', err);
  }
};

export const initMeetingStartRingScheduler = () => {
  cron.schedule('* * * * *', async () => {
    await processMeetingStartRings();
  });
  console.log('🔔 [MeetingRing] Meeting-start ringer initialized (runs every minute).');
};

// ─── Action-Item Follow-Up Loop ───────────────────────────────────────────────

/**
 * Closes the loop on meeting action items: if an item extracted from a transcript
 * is still pending 24h after it was created, nudge the assignee once — via realtime
 * socket (`task_followup`), push, and an in-app notification — then stamp
 * `followUpSentAt` so we never double-ping. This is what makes BubbleChat "follow up
 * automatically" where Zoom just sends the transcript and stops.
 *
 * Runs every 6 hours. Distinct from processTaskReminders (which is due-date based);
 * this is "still not actioned since the meeting" based.
 */
export const processActionItemFollowUps = async () => {
  try {
    const { Task } = await import('../models/task');
    const { User } = await import('../models/users');
    const { createNotification } = await import('../controllers/notificationController');
    const { getIO } = await import('./socket');

    const now = new Date();
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000); // created > 24h ago

    const stale = await Task.find({
      source: 'meeting',
      status: { $in: ['todo', 'in-progress'] },
      followUpSentAt: null, // matches both null and missing in MongoDB
      createdAt: { $lte: cutoff },
    })
      .populate('meetingRef', 'title')
      .limit(50);

    if (stale.length === 0) return;

    let io: any = null;
    try { io = getIO(); } catch { /* socket not ready */ }

    for (const task of stale) {
      try {
        const assigneeId = String(task.assignedTo || task.user_id);
        const meetingTitle = (task.meetingRef as any)?.title || 'a meeting';
        const overdue = !!(task.end_time && task.end_time.getTime() < now.getTime());

        const payload = {
          taskId: String(task._id),
          title: task.title,
          meetingTitle,
          dueAt: task.end_time,
          overdue,
        };

        // Realtime: assignee's personal room (joined on connect as socket.join(userId)).
        if (io) io.to(assigneeId).emit('task_followup', payload);

        const body = overdue
          ? `Overdue action item from "${meetingTitle}": ${task.title}`
          : `Still open from "${meetingTitle}": ${task.title}`;

        // createNotification persists the in-app notification AND fires the push.
        await createNotification({
          recipient: assigneeId,
          sender: assigneeId,
          type: 'task_followup',
          title: overdue ? 'Overdue action item' : 'Action item still open',
          body,
          entityId: String(task._id),
          entityType: 'Task',
        });

        // Best-effort email nudge — only when user has opted for per-item emails.
        try {
          const user = await User.findById(assigneeId).select('email full_name username actionItemEmailMode privacy_settings');
          const emailMode: string = (user as any)?.actionItemEmailMode ?? 'each';
          const emailsAllowed = (user as any)?.privacy_settings?.email_notifications !== false;
          if (user?.email && emailMode === 'each' && emailsAllowed) {
            const { sendTaskReminderEmail } = await import('./mailer');
            await sendTaskReminderEmail(
              user.email,
              user.full_name || user.username || 'User',
              `${task.title} (from ${meetingTitle})`,
              task.end_time || now,
              task.description
            );
          }
        } catch (mailErr) {
          console.error(`❌ [ActionItemFollowUp] email failed for task ${task._id}:`, mailErr);
        }

        task.followUpSentAt = now;
        await task.save();
        console.log(`✅ [ActionItemFollowUp] Nudged assignee for task ${task._id}`);
      } catch (err) {
        console.error(`❌ [ActionItemFollowUp] Failed for task ${task._id}:`, err);
      }
    }
  } catch (err) {
    console.error('❌ [ActionItemFollowUp] Scheduler processing error:', err);
  }
};

export const initActionItemFollowUpScheduler = () => {
  // Every 6 hours
  cron.schedule('0 */6 * * *', async () => {
    await processActionItemFollowUps();
  });
  console.log('⏰ [ActionItemFollowUp] Action-item follow-up loop initialized (runs every 6h).');
};

// ─── Daily Digest Generator ────────────────────────────────────────────────────

/**
 * Generates personalized morning briefs for all active users across all orgs.
 * Runs at 07:00 UTC daily. Each user's digest is cached in DailyDigest collection.
 */
export const runDailyDigestJob = async (forHourUtc?: number) => {
  try {
    const { User } = await import('../models/users');
    const { generateDigestForUser } = await import('../controllers/digestController');
    const { sendPushNotification } = await import('./push');
    const { PushToken } = await import('../models/pushToken');

    // Find all users who belong to an org and have digest enabled (or default)
    const allUsers = await User.find({
      organization: { $exists: true, $ne: '' },
      $or: [
        { 'digestPreferences.enabled': true },
        { 'digestPreferences.enabled': { $exists: false } }, // default on
      ],
    }).select('_id full_name username email digestPreferences actionItemEmailMode privacy_settings').limit(500);

    // Honor each user's preferred delivery hour (digestPreferences.notifyTime,
    // "HH:MM"); users without a preference get the 07:00 default. When invoked
    // without an hour (manual run), everyone matches.
    const users = forHourUtc === undefined ? allUsers : allUsers.filter(u => {
      const notifyTime: string = (u as any).digestPreferences?.notifyTime || '07:00';
      const hour = parseInt(notifyTime.split(':')[0], 10);
      return (Number.isFinite(hour) ? hour : 7) === forHourUtc;
    });
    if (users.length === 0) return;

    console.log(`📅 [DailyDigest] Generating briefs for ${users.length} users...`);

    let successCount = 0;
    const today = new Date();

    for (const user of users) {
      try {
        const digest = await generateDigestForUser(user._id.toString(), today);
        if (!digest) continue;

        // Send push notification if user has push tokens
        if (digest.morningBrief) {
          await sendPushNotification(
            [user._id.toString()],
            '🌅 Your Morning Brief is Ready',
            digest.morningBrief.substring(0, 120),
            { type: 'morning_digest', date: today.toISOString().slice(0, 10) }
          );
          digest.pushSent = true;
          await digest.save();

          // Also email the same brief (in addition to push). Best-effort, and
          // only if the user hasn't turned email notifications off.
          if ((user as any).email && (user as any).privacy_settings?.email_notifications !== false) {
            try {
              const { sendDigestEmail } = await import('./mailer');
              let emailBody = digest.morningBrief;

              // 'summary' mode: append pending action items so per-task emails are skipped
              // but users still see everything once a day in their digest.
              const emailMode: string = (user as any).actionItemEmailMode ?? 'each';
              if (emailMode === 'summary') {
                const { Task } = await import('../models/task');
                const pending = await Task.find({
                  $or: [{ assignedTo: user._id }, { user_id: user._id }],
                  source: 'meeting',
                  status: { $in: ['todo', 'in-progress'] },
                }).select('title end_time').limit(20);
                if (pending.length > 0) {
                  const lines = pending.map(t => `• ${t.title}${t.end_time ? ` (due ${t.end_time.toLocaleDateString()})` : ''}`).join('\n');
                  emailBody += `\n\n──────────────────────\n📋 Pending Action Items\n${lines}`;
                }
              }

              await sendDigestEmail(
                (user as any).email,
                user.full_name || user.username || 'there',
                '🌅 Your Daily Brief',
                emailBody
              );
            } catch (mailErr) {
              console.error(`[DailyDigest] Email failed for ${user._id}:`, mailErr);
            }
          }
        }

        successCount++;
      } catch (userErr) {
        console.error(`[DailyDigest] Failed for user ${user._id}:`, userErr);
      }
    }

    console.log(`✅ [DailyDigest] Completed: ${successCount}/${users.length} briefs generated.`);
  } catch (err) {
    console.error('❌ [DailyDigest] Job failed:', err);
  }
};

export const initDailyDigestScheduler = () => {
  // Run hourly; each pass delivers to users whose digestPreferences.notifyTime
  // matches the current UTC hour (default 07:00). This makes notifyTime real
  // instead of a stored-but-ignored preference.
  cron.schedule('0 * * * *', async () => {
    const hour = new Date().getUTCHours();
    await runDailyDigestJob(hour);
  });

  console.log('📅 [DailyDigest] Scheduler initialized (hourly, honoring digestPreferences.notifyTime).');
};

// ─── Weekly Digest Generator ────────────────────────────────────────────────────

/**
 * Sends a 7-day recap push to all active users across all orgs.
 * Runs Mondays at 08:00 UTC.
 */
export const runWeeklyDigestJob = async () => {
  try {
    const { User } = await import('../models/users');
    const { generateWeeklyBriefForUser } = await import('../controllers/digestController');
    const { sendPushNotification } = await import('./push');

    const users = await User.find({
      organization: { $exists: true, $ne: '' },
      $or: [
        { 'digestPreferences.enabled': true },
        { 'digestPreferences.enabled': { $exists: false } }, // default on
      ],
    }).select('_id full_name username email').limit(500);

    console.log(`🗓️ [WeeklyDigest] Generating weekly recaps for ${users.length} users...`);

    let successCount = 0;
    const today = new Date();

    for (const user of users) {
      try {
        const brief = await generateWeeklyBriefForUser(user._id.toString(), today);
        if (!brief) continue;

        await sendPushNotification(
          [user._id.toString()],
          '🗓️ Your Weekly Recap',
          brief.substring(0, 120),
          { type: 'weekly_digest', date: today.toISOString().slice(0, 10) }
        );

        // Also email the 7-day recap (in addition to push). Best-effort.
        if ((user as any).email) {
          try {
            const { sendDigestEmail } = await import('./mailer');
            await sendDigestEmail(
              (user as any).email,
              user.full_name || user.username || 'there',
              '🗓️ Your Weekly Recap',
              brief
            );
          } catch (mailErr) {
            console.error(`[WeeklyDigest] Email failed for ${user._id}:`, mailErr);
          }
        }
        successCount++;
      } catch (userErr) {
        console.error(`[WeeklyDigest] Failed for user ${user._id}:`, userErr);
      }
    }

    console.log(`✅ [WeeklyDigest] Completed: ${successCount}/${users.length} recaps sent.`);
  } catch (err) {
    console.error('❌ [WeeklyDigest] Job failed:', err);
  }
};

export const initWeeklyDigestScheduler = () => {
  // Run Mondays at 08:00 UTC
  cron.schedule('0 8 * * 1', async () => {
    console.log('🗓️ [WeeklyDigest] Monday 08:00 UTC — Running weekly digest job...');
    await runWeeklyDigestJob();
  });

  console.log('🗓️ [WeeklyDigest] Scheduler initialized (runs Mondays at 08:00 UTC).');
};

// ─── Holiday reminders ────────────────────────────────────────────────────────
// Notify each org's members (push + email) about public holidays happening tomorrow.
// These are individual reminders surfaced per user — not a mass announcement feed.
export const processHolidayReminders = async () => {
  try {
    const { CalendarEvent } = await import('../models/calendarEvent');
    const { User } = await import('../models/users');
    const { Organization } = await import('../models/organizations');
    const { sendPushNotification } = await import('./push');
    const { sendCalendarEventEmail } = await import('./mailer');

    // Tomorrow's local day window.
    const now = new Date();
    const tomorrowStart = new Date(now);
    tomorrowStart.setDate(now.getDate() + 1);
    tomorrowStart.setHours(0, 0, 0, 0);
    const tomorrowEnd = new Date(tomorrowStart);
    tomorrowEnd.setHours(23, 59, 59, 999);

    const holidays = await CalendarEvent.find({
      eventType: 'holiday',
      startTime: { $gte: tomorrowStart, $lte: tomorrowEnd },
    }).lean();

    if (!holidays.length) return;

    for (const h of holidays as any[]) {
      const org = await Organization.findById(h.organizationId).lean();
      if (!org) continue;
      const members = await User.find({ organization: (org as any).name }).select('_id full_name email privacy_settings').lean();
      if (!members.length) continue;

      const ids = members.map((m: any) => String(m._id));
      await sendPushNotification(ids, `🎉 ${h.title}`, `Tomorrow is ${h.title} — a public holiday.`, {
        type: 'holiday',
        eventId: String(h._id),
      }, 'reminder');

      const { emailAllowed } = await import('./mailer');
      for (const m of members as any[]) {
        // Respect the member's email-notifications opt-out (reminder mail is
        // informational, not transactional).
        if (!emailAllowed(m)) continue;
        try {
          await sendCalendarEventEmail(
            m.email,
            m.full_name || 'there',
            h.title,
            'event',
            new Date(h.startTime),
            new Date(h.endTime),
            h.description || `${h.title} is a public holiday.`,
            'Bubblespace'
          );
        } catch (emailErr) {
          console.error(`[HolidayReminder] email to ${m.email} failed:`, emailErr);
        }
      }
    }
    console.log(`🎉 [HolidayReminder] Notified members of ${holidays.length} holiday(s) for tomorrow.`);
  } catch (err) {
    console.error('[HolidayReminder] job failed:', err);
  }
};

export const initHolidayReminderScheduler = () => {
  // Run daily at 08:30 UTC — remind members of holidays happening the next day.
  cron.schedule('30 8 * * *', async () => {
    await processHolidayReminders();
  });

  console.log('🗓️ [HolidayReminder] Scheduler initialized (runs daily at 08:30 UTC).');
};

