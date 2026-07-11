import { io, Socket } from 'socket.io-client';
import { API_BASE } from './apiBase';

// Share the exact host api.ts resolved — including the dev-mode localhost→Metro-IP
// rewrite — so realtime reaches the same backend as HTTP on a physical device.
const SOCKET_URL = API_BASE;

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

    socket.on('connect', () => {
        console.log('✅ [socket] connected');
    });

    socket.on('disconnect', (reason) => {
        // `reason` matters: "io client disconnect" = deliberate (logout),
        // anything else = network/server and will auto-reconnect.
        console.log(`❌ [socket] disconnected (${reason})`);
    });

    socket.on('connect_error', (err) => {
        console.warn('⚠️ [socket] connect_error:', err.message);
    });

    // Flush screens that mounted before the socket existed.
    const s = socket;
    readyCallbacks.forEach((cb) => {
        try { cb(s); } catch { /* listener errors must not break init */ }
    });
    readyCallbacks.clear();

    return socket;
};

/**
 * Point the LIVE socket at a fresh access token. The socket.io object lives for
 * the whole session and re-sends its `auth` on every (re)connect — so after a REST
 * token refresh we MUST update `socket.auth` here, otherwise the socket keeps
 * presenting the old (eventually expired) token and the backend rejects the next
 * reconnect, silently killing real-time (typing / new_message / receipts / calls).
 *
 * We DON'T force a disconnect/reconnect on an already-connected socket: a live
 * connection was already authenticated at its handshake and socket.io does not
 * re-verify the token mid-connection, so bouncing it here would just drop realtime
 * (and flap the user's presence) on every refresh for no gain. Updating `socket.auth`
 * is enough — the fresh token is used automatically on the next natural reconnect.
 * Only (re)connect if we're currently disconnected.
 */
export const updateSocketToken = (token: string): void => {
    if (!socket) { initSocket(token); return; }
    (socket.auth as any) = { token };
    if (!socket.connected) socket.connect();
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
