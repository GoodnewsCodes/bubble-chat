import { io, Socket } from 'socket.io-client';

// Env-driven; localhost dev fallback only (no hardcoded production host).
const BASE_URL = (process.env.EXPO_PUBLIC_API_URL?.replace(/ i$/, '')?.trim()) || 'http://localhost:3000/api/v1';
const SOCKET_URL = BASE_URL.replace(/\/api\/v1\/?$/, '');

let socket: Socket | null = null;

// Screens that mount before initSocket() completes (cold start — init is async)
// register here; they're invoked the moment the socket exists so their event
// handlers actually get attached. Without this, an early-mounting screen grabbed
// `null` from getSocket(), returned, and silently had NO real-time for its whole
// life (typing, new_message, receipts all dead on that screen).
const readyCallbacks = new Set<(s: Socket) => void>();

/**
 * Runs `cb` with the live socket — immediately if it already exists, otherwise
 * as soon as initSocket() creates it. Returns an unsubscribe function.
 */
export const onSocketReady = (cb: (s: Socket) => void): (() => void) => {
    if (socket) {
        cb(socket);
        return () => undefined;
    }
    readyCallbacks.add(cb);
    return () => { readyCallbacks.delete(cb); };
};

export const initSocket = (token: string): Socket => {
    if (socket) return socket;

    socket = io(SOCKET_URL, {
        auth: { token },
        // websocket first: the polling transport is plain HTTP, which competes
        // with (and during incidents, dies with) regular API traffic.
        transports: ['websocket', 'polling'],
        // NEVER stop retrying. A finite attempt cap (was 15) meant one bad patch
        // (server restart, request storm, network flap) permanently killed the
        // socket for the rest of the session — messages/typing stopped arriving
        // in real time while REST kept working, which read as "chat is broken".
        reconnection: true,
        reconnectionAttempts: Infinity,
        // Jittered backoff so many clients/screens don't reconnect in lockstep.
        reconnectionDelay: 2000,
        reconnectionDelayMax: 30000,
        randomizationFactor: 0.5,
    });

    // [DEBUG-INSTRUMENTATION] counters to distinguish a real reconnect storm from
    // handler stacking. Remove once diagnosed.
    let __connectCount = 0;
    let __disconnectCount = 0;
    socket.on('connect', () => {
        __connectCount += 1;
        console.log(`✅ [socket] connect #${__connectCount} id=${socket?.id}`);
    });

    socket.on('disconnect', (reason) => {
        __disconnectCount += 1;
        console.log(`❌ [socket] disconnect #${__disconnectCount} reason=${reason}`);
    });

    socket.on('connect_error', (err) => {
        console.error('⚠️ [socket] connect_error:', err.message);
    });

    // Flush screens that mounted before the socket existed.
    const s = socket;
    readyCallbacks.forEach((cb) => {
        try { cb(s); } catch { /* listener errors must not break init */ }
    });
    readyCallbacks.clear();

    return socket;
};

export const getSocket = (): Socket | null => {
    return socket;
};

export const disconnectSocket = (): void => {
    if (socket) {
        socket.disconnect();
        socket = null;
    }
};
