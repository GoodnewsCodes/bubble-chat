import { describe, it, expect } from 'vitest';
import { newSessionRecord, findValidSession, hashToken, SESSION_TTL_MS } from '../utils/sessions';

describe('sessions', () => {
  const now = 1_700_000_000_000;
  const rec = newSessionRecord('sid-1', 'tok-1', {}, now);

  it('stores a hash, never the raw token', () => {
    expect(rec.tokenHash).toBe(hashToken('tok-1'));
    expect(JSON.stringify(rec)).not.toContain('tok-1');
  });

  it('expires exactly 30 days after sign-in', () => {
    expect(rec.expiresAt.getTime() - now).toBe(SESSION_TTL_MS);
    expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('accepts the right token any number of times (no rotation races)', () => {
    expect(findValidSession([rec], 'sid-1', 'tok-1', now + 1000).ok).toBe(true);
    expect(findValidSession([rec], 'sid-1', 'tok-1', now + 2000).ok).toBe(true);
  });

  it('rejects a wrong token or unknown session as revoked', () => {
    expect(findValidSession([rec], 'sid-1', 'nope', now)).toEqual({ ok: false, reason: 'revoked' });
    expect(findValidSession([rec], 'other', 'tok-1', now)).toEqual({ ok: false, reason: 'revoked' });
    expect(findValidSession(undefined, 'sid-1', 'tok-1', now)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('rejects after the 30 days are up', () => {
    expect(findValidSession([rec], 'sid-1', 'tok-1', now + SESSION_TTL_MS - 1).ok).toBe(true);
    expect(findValidSession([rec], 'sid-1', 'tok-1', now + SESSION_TTL_MS)).toEqual({ ok: false, reason: 'expired' });
  });
});
