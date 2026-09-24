import { useEffect, useReducer } from 'react';

// Live online/offline presence, fed by the backend `user_status_change` broadcast.
// `undefined` means "no realtime info yet" — callers fall back to the last value
// the API gave them until the socket reports an actual change.
const onlineMap = new Map<string, boolean>();
let listeners: (() => void)[] = [];

const notify = () => {
  listeners.forEach((l) => {
    try { l(); } catch {}
  });
};

export const setupPresenceListeners = (socket: any) => {
  if (!socket) return;
  socket.off('user_status_change');
  socket.on('user_status_change', (data: { userId: string; isOnline: boolean }) => {
    if (!data?.userId) return;
    onlineMap.set(String(data.userId), !!data.isOnline);
    notify();
  });
};

export const getPresence = (userId?: string | null): boolean | undefined => {
  // Reciprocity: if I've hidden my own online status, I see no one as online.
  if (!viewerPresenceVisible) return false;
  return userId != null ? onlineMap.get(String(userId)) : undefined;
};

export const subscribePresence = (l: () => void) => {
  listeners.push(l);
  return () => { listeners = listeners.filter((x) => x !== l); };
};

// ── Viewer reciprocity (WhatsApp-style) ──────────────────────────────────────
// If the signed-in user hides their OWN online status, they also stop seeing
// everyone else's presence; likewise, turning off their own read receipts hides
// others' "seen" state from them. Outbound suppression (not broadcasting my
// presence / not sending my acks) is enforced server-side; these flags gate what
// the viewer is allowed to SEE. Seeded at app bootstrap and updated on save.
let viewerPresenceVisible = true;
let viewerReadReceipts = true;

/** Update the viewer's own privacy visibility. Call on bootstrap and after saving settings. */
export const setViewerVisibility = (opts: { showOnline?: boolean; readReceipts?: boolean }) => {
  let changed = false;
  if (typeof opts.showOnline === 'boolean' && opts.showOnline !== viewerPresenceVisible) {
    viewerPresenceVisible = opts.showOnline;
    changed = true;
  }
  if (typeof opts.readReceipts === 'boolean' && opts.readReceipts !== viewerReadReceipts) {
    viewerReadReceipts = opts.readReceipts;
    changed = true;
  }
  if (changed) notify();
};

export const getViewerPresenceVisible = (): boolean => viewerPresenceVisible;
export const getViewerReadReceipts = (): boolean => viewerReadReceipts;

/** Hook: viewer's own privacy visibility flags. Re-renders when they change. */
export const useViewerVisibility = (): { presenceVisible: boolean; readReceipts: boolean } => {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => subscribePresence(force), []);
  return { presenceVisible: viewerPresenceVisible, readReceipts: viewerReadReceipts };
};

/** Resolves the displayed online state: realtime value if known, else the API fallback. */
export const useIsOnline = (userId?: string | null, fallback: boolean = false): boolean => {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => subscribePresence(force), []);
  // Reciprocity: if I hide my own online status, I see no one as online.
  if (!viewerPresenceVisible) return false;
  const known = getPresence(userId);
  return known === undefined ? fallback : known;
};

// ── "In a live meeting" registry ─────────────────────────────────────────────
// Distinct from plain online: a userId is "in a meeting" if they're the host or an
// attendee of a currently-live room. Populated from the active-meetings poll
// (see (main)/_layout.tsx) and consumed to render a blinking green dot.
let inMeetingSet = new Set<string>();
let meetingListeners: (() => void)[] = [];

const notifyMeeting = () => {
  meetingListeners.forEach((l) => { try { l(); } catch {} });
};

/** Replace the set of user IDs currently in a live meeting (call from the rooms poll). */
export const setInMeetingUsers = (userIds: (string | null | undefined)[]) => {
  const next = new Set(userIds.filter(Boolean).map((id) => String(id)));
  // Avoid spurious re-renders when nothing changed.
  if (next.size === inMeetingSet.size && [...next].every((id) => inMeetingSet.has(id))) return;
  inMeetingSet = next;
  notifyMeeting();
};

export const isInMeeting = (userId?: string | null): boolean =>
  userId != null && inMeetingSet.has(String(userId));

export const subscribeInMeeting = (l: () => void) => {
  meetingListeners.push(l);
  return () => { meetingListeners = meetingListeners.filter((x) => x !== l); };
};

/** Hook: true while the given user is in a live meeting. */
export const useIsInMeeting = (userId?: string | null): boolean => {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => subscribeInMeeting(force), []);
  return isInMeeting(userId);
};
