// OS-level connectivity (NetInfo).
//
// Before this module the app inferred connectivity solely from the Socket.IO
// connection state, which is slow and imprecise: it can't tell "airplane mode"
// from "server briefly unreachable", and it can't fire the instant the network
// returns. WhatsApp gates everything on real connectivity — so do we now:
//   • sync calls are skipped entirely while offline (no wasted timeouts), and
//   • the outbound queue / resync fire on the exact offline→online edge.
//
// `isOnline()` is synchronous so callers (syncScheduler, screens) can gate a
// call without awaiting. A NetInfo subscription keeps the cached value fresh and
// emits online/offline transitions to subscribers.

import NetInfo, { NetInfoState } from '@react-native-community/netinfo';

// Optimistic default: assume online until NetInfo says otherwise, so the first
// sync on a cold start isn't suppressed before the first NetInfo event lands.
let online = true;
let started = false;

type Listener = (isOnline: boolean) => void;
const listeners = new Set<Listener>();
const reconnectListeners = new Set<() => void>();

// A device is "online" when it has a network link. We DELIBERATELY do NOT gate on
// `isInternetReachable`: that flag comes from a background reachability probe
// (NetInfo pings a Google endpoint) which returns `false` on a slow, firewalled,
// or region-blocked probe EVEN WHEN the connection works fine — and because every
// sync/profile/message call is gated on isOnline(), one bad probe froze the whole
// app "offline" (no profile, no endpoints, no real-time, sends stuck). So we only
// go offline on an EXPLICIT `isConnected === false` (airplane mode / no link).
// Worst case now: we attempt a request that fails and is retried — never a silent
// app-wide freeze. This mirrors WhatsApp, which doesn't gray out on a flaky probe.
const computeOnline = (state: NetInfoState): boolean => {
  return state.isConnected !== false;
};

const apply = (next: boolean): void => {
  if (next === online) return;
  const wasOffline = !online;
  online = next;
  listeners.forEach((l) => {
    try { l(next); } catch { /* a bad listener must not break the rest */ }
  });
  // Fire the reconnect edge (offline → online) once per transition.
  if (next && wasOffline) {
    reconnectListeners.forEach((l) => {
      try { l(); } catch { /* best-effort */ }
    });
  }
};

// Begin listening. Safe to call multiple times; only the first call subscribes.
export const startNetworkMonitor = (): void => {
  if (started) return;
  started = true;
  NetInfo.addEventListener((state) => apply(computeOnline(state)));
  // Seed the initial value (addEventListener also fires immediately on most
  // platforms, but fetch() guarantees we don't sit on the optimistic default).
  NetInfo.fetch().then((state) => apply(computeOnline(state))).catch(() => {});
};

// Synchronous best-known connectivity. Cheap to call in hot paths.
export const isOnline = (): boolean => online;

// Subscribe to online/offline transitions. Returns an unsubscribe fn.
export const subscribeNetwork = (fn: Listener): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

// Subscribe to the offline→online edge only (queue flush / resync). Returns an
// unsubscribe fn.
export const onReconnect = (fn: () => void): (() => void) => {
  reconnectListeners.add(fn);
  return () => reconnectListeners.delete(fn);
};
