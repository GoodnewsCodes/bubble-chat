import crypto from 'crypto';

// A login is a "session": one per device/browser, valid for a fixed 30 days from sign-in
// (absolute, not sliding) — after that the user signs in again. The refresh token is NOT
// rotated: rotating a single-use token is what logs people out when two tabs refresh at
// once or a response is lost on a flaky network. Instead the server keeps only a hash of
// each session's token and revokes by deleting the session (logout / password reset).
export const SESSION_TTL_DAYS = 30;
export const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;
export const ACCESS_TOKEN_TTL = '2d';
export const ACCESS_TOKEN_TTL_MS = 2 * 24 * 60 * 60 * 1000;
// Concurrent devices per account. Oldest sessions are dropped beyond this; set
// MAX_SESSIONS=1 to enforce a single signed-in device.
export const MAX_SESSIONS = Math.max(1, Number(process.env.MAX_SESSIONS) || 5);

export interface SessionRecord {
  sid: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date;
  userAgent?: string;
  ip?: string;
}

export const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

export const newSessionRecord = (
  sid: string,
  refreshToken: string,
  meta: { userAgent?: string; ip?: string } = {},
  now: number = Date.now(),
): SessionRecord => ({
  sid,
  tokenHash: hashToken(refreshToken),
  createdAt: new Date(now),
  expiresAt: new Date(now + SESSION_TTL_MS),
  lastUsedAt: new Date(now),
  userAgent: meta.userAgent?.slice(0, 300),
  ip: meta.ip,
});

export type SessionCheck =
  | { ok: true; session: SessionRecord }
  | { ok: false; reason: 'revoked' | 'expired' };

// Constant-time hash compare + absolute-expiry check.
export const findValidSession = (
  sessions: SessionRecord[] | undefined,
  sid: string,
  refreshToken: string,
  now: number = Date.now(),
): SessionCheck => {
  const session = (sessions || []).find((s) => s.sid === sid);
  if (!session) return { ok: false, reason: 'revoked' };
  const a = Buffer.from(session.tokenHash, 'hex');
  const b = Buffer.from(hashToken(refreshToken), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'revoked' };
  if (new Date(session.expiresAt).getTime() <= now) return { ok: false, reason: 'expired' };
  return { ok: true, session };
};
