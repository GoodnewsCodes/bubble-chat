/**
 * calendarUtils.ts
 *
 * Shared calendar helpers used across mobile (calls.tsx) and web (tab-views.tsx).
 * Keep this file free of any React/RN imports so it can run in any context.
 */

// ─── Colour spec (shared between web and mobile) ──────────────────────────────
// green  = meeting
// yellow = recurring
// blue   = general event / company
// purple = task
// red    = holiday

export const EVENT_COLORS = {
  meeting: '#22c55e',
  recurring: '#eab308',
  event: '#3b82f6',
  task: '#6c5ce7',
  holiday: '#ef4444',
} as const;

export function calendarEventColor(ev: any): string {
  if (!ev) return EVENT_COLORS.task;
  if (ev.eventType === 'holiday' || ev.type === 'holiday') return EVENT_COLORS.holiday;
  if (ev.isRecurring || ev.recurrenceRule || ev.parentEventId || ev.__recurring)
    return EVENT_COLORS.recurring;
  if (ev.eventType === 'meeting_video' || ev.eventType === 'meeting_audio' || ev.type === 'meeting')
    return EVENT_COLORS.meeting;
  if (ev.eventType === 'company' || ev.eventType === 'all_day' || ev.type === 'event')
    return EVENT_COLORS.event;
  return EVENT_COLORS.task;
}

// ─── Pattern detection ────────────────────────────────────────────────────────

export interface PatternGroup {
  key: string;           // normalised title used as grouping key
  title: string;         // human-readable (first occurrence's title)
  count: number;         // how many times it appeared
  events: any[];
}

/**
 * Normalise an event title so "Weekly Sync 1" and "Weekly Sync 2" collapse
 * to the same key.
 */
export function normaliseTitle(title: string): string {
  return (title || '')
    .toLowerCase()
    // strip trailing dates like 2024-01-15 or 01/15
    .replace(/\b\d{1,4}[-/]\d{1,2}([-/]\d{0,4})?\b/g, '')
    // strip trailing numbers ("Sync #3", "Sync 2")
    .replace(/\s+#?\d+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Client-side pattern detection.
 *
 * Takes a flat list of calendar events/tasks and returns groups whose
 * normalised title appears MORE than `threshold` (default 3) times.
 *
 * Events that are already flagged as recurring by the server are excluded
 * (they're already handled).
 */
export function detectRecurringPatterns(
  events: any[],
  threshold = 3
): PatternGroup[] {
  const groups: Record<string, PatternGroup> = {};

  for (const ev of events) {
    // Skip events already formally recurring on the backend
    if (ev.isRecurring || ev.recurrenceRule || ev.parentEventId || ev.__recurring) continue;

    const key = normaliseTitle(ev.title || ev.name || '');
    if (!key || key.length < 3) continue;   // too short to be meaningful

    if (!groups[key]) {
      groups[key] = { key, title: ev.title || ev.name || key, count: 0, events: [] };
    }
    groups[key].count++;
    groups[key].events.push(ev);
  }

  return Object.values(groups).filter(g => g.count > threshold);
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}
