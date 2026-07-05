import { Request, Response } from 'express';
import crypto from 'crypto';
import { CalendarEvent } from '../models/calendarEvent';
import { RecurringPattern } from '../models/recurringPattern';
import { User } from '../models/users';
import { sendPushNotification } from '../utils/push';
import { sendRecurringPatternEmail, emailAllowed } from '../utils/mailer';

const THRESHOLD = 3;           // detections needed to trigger a notification
const WINDOW_DAYS = 90;        // rolling window to look back in

/**
 * Normalise an event title so that "Weekly Sync 1" and "Weekly Sync 2"
 * collapse to the same key, without losing meaningful words.
 */
function normalise(title: string): string {
  return title
    .toLowerCase()
    // Strip trailing numbers / dates ("Sync #3", "Sync 2024-01-15")
    .replace(/\b\d{1,4}[-/]\d{1,2}([-/]\d{0,4})?\b/g, '')
    .replace(/\s+#?\d+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * POST /api/v1/calendar/detect-patterns
 *
 * Called by the client after a calendar sync (or periodically by the scheduler).
 * Scans the last 90 days of events for the authenticated user's org, groups by
 * normalised title, and for any group with ≥3 events that hasn't been notified
 * yet → creates a RecurringPattern record, sends a push + email.
 */
export const detectAndNotifyPatterns = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id || (req as any).user?._id;
    const user = await User.findById(userId).lean();
    if (!user) return res.status(401).json({ error: 'Unauthorised' });

    const orgId = (user as any).organizationId;
    if (!orgId) return res.status(400).json({ error: 'No organisation found' });

    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

    // Fetch all events this user attended (or created) within the window.
    // Holidays are excluded: they're seeded system events that recur BY NATURE
    // (Christmas Day ×4 etc.), so suggesting them as "recurring patterns"
    // spammed the Updates tab with junk cards after every scan.
    const events = await CalendarEvent.find({
      organizationId: orgId,
      $or: [{ createdBy: userId }, { attendees: userId }],
      startTime: { $gte: since },
      status: { $ne: 'cancelled' },
      eventType: { $ne: 'holiday' },
    })
      .select('title eventType isRecurring recurrenceRule parentEventId')
      .lean();

    // Group by normalised title
    const groups: Record<string, typeof events> = {};
    for (const ev of events) {
      // Skip events already flagged as formally recurring by the system
      if (ev.isRecurring || ev.recurrenceRule || ev.parentEventId) continue;
      const key = normalise(ev.title);
      if (!key) continue;
      if (!groups[key]) groups[key] = [];
      groups[key].push(ev);
    }

    const newlyDetected: string[] = [];

    for (const [key, group] of Object.entries(groups)) {
      if (group.length < THRESHOLD) continue;

      // Check if we've already notified this user about this pattern
      const existing = await RecurringPattern.findOne({ userId, normalisedTitle: key });
      if (existing) continue;   // already tracked — skip

      const example = group[0];
      const frontendBase = process.env.FRONTEND_URL || 'http://localhost:8080';

      // Create the pattern record first so we have its _id for links
      const pattern = await RecurringPattern.create({
        organizationId: orgId,
        userId,
        normalisedTitle: key,
        exampleTitle: example.title,
        eventType: example.eventType,
        occurrences: group.length,
        status: 'detected',
        notifiedAt: new Date(),
      });

      const confirmUrl = `${frontendBase}/api/v1/calendar/patterns/${pattern._id}/confirm`;
      const dismissUrl = `${frontendBase}/api/v1/calendar/patterns/${pattern._id}/dismiss`;

      // Push notification (fire-and-forget)
      sendPushNotification(
        [String(userId)],
        '🔁 Aida detected a pattern',
        `You've had "${example.title}" ${group.length} times. Make it recurring?`,
        { patternId: String(pattern._id), type: 'recurring_pattern' }
      ).catch(err => console.error('[Pattern] Push failed:', err));

      // Email notification (fire-and-forget) — skipped if the user opted out.
      if (emailAllowed(user)) {
        const name = (user as any).full_name || (user as any).name || (user as any).username || 'there';
        sendRecurringPatternEmail(
          (user as any).email,
          name,
          example.title,
          group.length,
          confirmUrl,
          dismissUrl
        ).catch(err => console.error('[Pattern] Email failed:', err));
      }

      newlyDetected.push(example.title);
    }

    // One-time cleanup: drop previously-detected patterns that were generated
    // from holiday events (before holidays were excluded above) so the junk
    // "Christmas Day ×4" cards stop resurfacing.
    try {
      const holidayTitles = await CalendarEvent.distinct('title', {
        organizationId: orgId,
        eventType: 'holiday',
      });
      if (holidayTitles.length) {
        const normalizedHolidays = holidayTitles.map((t: string) => normalise(t)).filter(Boolean);
        await RecurringPattern.deleteMany({
          userId,
          status: 'detected',
          normalisedTitle: { $in: normalizedHolidays },
        });
      }
    } catch (cleanupErr) {
      console.error('[Pattern] holiday-pattern cleanup failed:', cleanupErr);
    }

    // Also return any existing detected patterns for this user so the client
    // can show the in-app confirmation banner without waiting for email.
    const pendingPatterns = await RecurringPattern.find({ userId, status: 'detected' }).lean();

    return res.json({ detected: newlyDetected, pending: pendingPatterns });
  } catch (err: any) {
    console.error('[detectPatterns] error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/v1/calendar/patterns/:id/confirm
 *
 * User clicked "Yes, make it recurring."
 * Marks the pattern confirmed + patches all matching CalendarEvents to
 * isRecurring=true so the yellow dot appears immediately.
 */
export const confirmPattern = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user?.id || (req as any).user?._id;

    const pattern = await RecurringPattern.findOne({ _id: id, userId });
    if (!pattern) return res.status(404).json({ error: 'Pattern not found' });

    pattern.status = 'confirmed';
    pattern.confirmedAt = new Date();
    // Default weekly recurrence (user can edit later in calendar)
    pattern.recurrenceRule = 'FREQ=WEEKLY';
    await pattern.save();

    // Back-fill isRecurring on all matching events
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await CalendarEvent.updateMany(
      {
        organizationId: pattern.organizationId,
        $or: [{ createdBy: userId }, { attendees: userId }],
        startTime: { $gte: since },
        status: { $ne: 'cancelled' },
      },
      { $set: { isRecurring: true, recurrenceRule: 'FREQ=WEEKLY' } }
    ).where({
      // Only update events whose normalised title matches
      // (Mongo doesn't support JS normalise inside query — we use a regex)
      title: new RegExp(pattern.normalisedTitle.split(' ').filter(Boolean).join('|'), 'i'),
    });

    return res.json({ success: true, pattern });
  } catch (err: any) {
    console.error('[confirmPattern] error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/v1/calendar/patterns/:id/dismiss
 *
 * User said "no thanks." Mark dismissed so we don't ping them again.
 */
export const dismissPattern = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user?.id || (req as any).user?._id;

    const pattern = await RecurringPattern.findOneAndUpdate(
      { _id: id, userId },
      { status: 'dismissed' },
      { new: true }
    );
    if (!pattern) return res.status(404).json({ error: 'Pattern not found' });

    return res.json({ success: true });
  } catch (err: any) {
    console.error('[dismissPattern] error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/v1/calendar/patterns/pending
 *
 * Returns patterns the user hasn't acted on yet (for in-app banner).
 */
export const getPendingPatterns = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id || (req as any).user?._id;
    const pending = await RecurringPattern.find({ userId, status: 'detected' })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ patterns: pending });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};
