// Background-sync coordinator.
//
// Screens used to call their full sync (`syncChatAndMessages` / `syncWithBackend`)
// directly on *every* socket `connect` event AND on a 5-second interval. With a
// few screens mounted and the socket churning, that fanned out into thousands of
// requests, tripped the backend rate limiter, and returned HTTP 429 — which in
// turn broke chat resolution (`accessOrCreateChat` never succeeded). This module
// coalesces those calls and backs the whole client off after a 429 so we stop
// piling on. Real-time updates still arrive over Socket.IO; these syncs are just
// a safety net, so dropping redundant ones is harmless.

let backoffUntil = 0;

// Called from api.ts `handleResponse` whenever the server returns 429. Suppresses
// all throttled network syncs for a cooldown so the client stops stampeding.
export const noteRateLimit = (retryAfterMs = 30000): void => {
  backoffUntil = Math.max(backoffUntil, Date.now() + retryAfterMs);
};

export const isBackedOff = (): boolean => Date.now() < backoffUntil;

const lastRun: Record<string, number> = {};
const inFlight: Record<string, boolean> = {};

// Per-key throttle: at most one run per `minIntervalMs`, never two in flight for
// the same key, and nothing at all while backed off from a 429. Extra calls in
// the window are dropped (a socket event or the next interval tick re-triggers
// soon anyway). Returns the fn's result, or undefined when the call was skipped.
export const runThrottled = async <T>(
  key: string,
  fn: () => Promise<T>,
  minIntervalMs = 2500,
  opts: { respectBackoff?: boolean } = {},
): Promise<T | undefined> => {
  const respectBackoff = opts.respectBackoff !== false;
  if (respectBackoff && isBackedOff()) return undefined;
  if (inFlight[key]) return undefined;
  const now = Date.now();
  if (now - (lastRun[key] || 0) < minIntervalMs) return undefined;
  lastRun[key] = now;
  inFlight[key] = true;
  try {
    return await fn();
  } finally {
    inFlight[key] = false;
  }
};

// Clears the throttle window for a key so the next `runThrottled` runs immediately.
// Use for explicit user actions (pull-to-retry, tapping a chat) that should bypass
// the coalescing window.
export const resetThrottle = (key: string): void => {
  lastRun[key] = 0;
};
