import { describe, it, expect } from 'vitest';

/**
 * The map-reduce action-item union logic from extractMeetingIntelligence: after
 * the merge pass, per-chunk items are unioned back in, deduped by normalized
 * text, so nothing decided late in a long meeting is lost and nothing appears
 * twice. This mirrors that reducer in isolation.
 */
const unionActionItems = (
  merged: { text: string; assignedToName?: string }[],
  fromChunks: { text: string; assignedToName?: string }[]
) => {
  const seen = new Set(merged.map(a => a.text.trim().toLowerCase()));
  const out = [...merged];
  for (const item of fromChunks) {
    const key = item.text?.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
};

describe('action-item map-reduce union', () => {
  it('recovers items the merge pass dropped', () => {
    const merged = [{ text: 'Ship the billing fix' }];
    const chunks = [
      { text: 'Ship the billing fix' },
      { text: 'Email the vendor about SLAs' }, // only surfaced in a later chunk
    ];
    const result = unionActionItems(merged, chunks);
    expect(result.map(r => r.text)).toEqual([
      'Ship the billing fix',
      'Email the vendor about SLAs',
    ]);
  });

  it('dedupes case/whitespace-insensitively', () => {
    const merged = [{ text: 'Follow up with Design' }];
    const chunks = [{ text: '  follow up with design  ' }];
    expect(unionActionItems(merged, chunks)).toHaveLength(1);
  });

  it('keeps assignee from the merged (authoritative) copy', () => {
    const merged = [{ text: 'Review PR', assignedToName: 'Ada' }];
    const chunks = [{ text: 'review pr', assignedToName: 'Someone else' }];
    const result = unionActionItems(merged, chunks);
    expect(result).toHaveLength(1);
    expect(result[0].assignedToName).toBe('Ada');
  });
});
