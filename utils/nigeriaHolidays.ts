// Nigerian public holidays.
//
// SOURCE OF TRUTH: Google Calendar's public Nigerian holiday calendar (ICS feed). We fetch and
// parse the real, official dates from Google so movable holidays (Eids, Easter) are always
// correct instead of hardcoded guesses. The static FALLBACK table below is only used when the
// network/Google is unavailable, so the calendar still works offline.

export interface HolidaySeed {
  name: string;
  date: string; // YYYY-MM-DD
}

// Google's public holiday calendar id for Nigeria (English): en.ng#holiday@group.v.calendar.google.com
const GOOGLE_NG_ICS =
  'https://calendar.google.com/calendar/ical/en.ng%23holiday%40group.v.calendar.google.com/public/basic.ics';

const pad = (n: number) => String(n).padStart(2, '0');

// ── Static fallback (used only if Google is unreachable) ─────────────────────
const FIXED: { name: string; month: number; day: number }[] = [
  { name: "New Year's Day", month: 1, day: 1 },
  { name: "Workers' Day", month: 5, day: 1 },
  { name: 'Democracy Day', month: 6, day: 12 },
  { name: 'Independence Day', month: 10, day: 1 },
  { name: 'Christmas Day', month: 12, day: 25 },
  { name: 'Boxing Day', month: 12, day: 26 },
];

const MOVABLE: Record<number, HolidaySeed[]> = {
  2025: [
    { name: 'Eid-el-Fitr', date: '2025-03-31' },
    { name: 'Good Friday', date: '2025-04-18' },
    { name: 'Easter Monday', date: '2025-04-21' },
    { name: 'Eid-el-Kabir', date: '2025-06-06' },
    { name: 'Eid-el-Maulud', date: '2025-09-05' },
  ],
  2026: [
    { name: 'Eid-el-Fitr', date: '2026-03-20' },
    { name: 'Good Friday', date: '2026-04-03' },
    { name: 'Easter Monday', date: '2026-04-06' },
    { name: 'Eid-el-Kabir', date: '2026-05-27' },
    { name: 'Eid-el-Maulud', date: '2026-08-25' },
  ],
  2027: [
    { name: 'Eid-el-Fitr', date: '2027-03-10' },
    { name: 'Good Friday', date: '2027-03-26' },
    { name: 'Easter Monday', date: '2027-03-29' },
    { name: 'Eid-el-Kabir', date: '2027-05-17' },
    { name: 'Eid-el-Maulud', date: '2027-08-15' },
  ],
};

/** Static fallback list for a year (fixed + known movable dates). */
export const getNigerianHolidays = (year: number): HolidaySeed[] => {
  const fixed = FIXED.map((f) => ({ name: f.name, date: `${year}-${pad(f.month)}-${pad(f.day)}` }));
  const movable = MOVABLE[year] || [];
  return [...fixed, ...movable].sort((a, b) => a.date.localeCompare(b.date));
};

// ── ICS parsing ──────────────────────────────────────────────────────────────
// Unfold folded lines (continuation lines start with a space/tab), then pull SUMMARY + DTSTART
// from each VEVENT. DTSTART for all-day holidays looks like `DTSTART;VALUE=DATE:20260101`.
const parseIcs = (ics: string): HolidaySeed[] => {
  const unfolded = ics.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const out: HolidaySeed[] = [];
  let inEvent = false;
  let name = '';
  let date = '';
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true; name = ''; date = '';
    } else if (line === 'END:VEVENT') {
      if (name && date) out.push({ name, date });
      inEvent = false;
    } else if (inEvent) {
      if (line.startsWith('SUMMARY')) {
        name = line.substring(line.indexOf(':') + 1).trim();
      } else if (line.startsWith('DTSTART')) {
        const raw = line.substring(line.indexOf(':') + 1).trim(); // e.g. 20260101 or 20260101T000000Z
        const m = raw.match(/^(\d{4})(\d{2})(\d{2})/);
        if (m) date = `${m[1]}-${m[2]}-${m[3]}`;
      }
    }
  }
  return out;
};

/**
 * Fetch the real Nigerian public holidays from Google Calendar's public ICS feed.
 * Returns [] on any failure so the caller can fall back to the static list.
 */
export const fetchGoogleNigerianHolidays = async (): Promise<HolidaySeed[]> => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(GOOGLE_NG_ICS, { signal: controller.signal as any });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const text = await res.text();
    const parsed = parseIcs(text);
    // De-dupe by name+date
    const seen = new Set<string>();
    return parsed.filter((h) => {
      const k = `${h.name.toLowerCase()}|${h.date}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  } catch {
    return [];
  }
};
