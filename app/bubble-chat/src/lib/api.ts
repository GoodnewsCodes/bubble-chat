/**
 * Centralized API utility for interacting with the Bubble Chat Backend.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { noteRateLimit } from './syncScheduler';

let GoogleSignin: any = null;
const isExpoGo = Constants.appOwnership === 'expo';
if (!isExpoGo) {
    try {
        GoogleSignin = require('@react-native-google-signin/google-signin').GoogleSignin;
    } catch (e) {
        console.log("Google Sign-In native module is not available in JS context.");
    }
}

const ENV_API_URL = process.env.EXPO_PUBLIC_API_URL?.trim();
if (!ENV_API_URL) {
  console.warn('[api] EXPO_PUBLIC_API_URL is not set — using the localhost dev fallback. Set it (EAS secret) to the Bubble Space backend for real builds.');
}
const BASE_URL = ENV_API_URL || 'http://localhost:3000/api/v1';
const API_BASE = BASE_URL.replace(/\/api\/v1\/?$/, '');

const originalFetch = globalThis.fetch;

// Single in-flight refresh promise. All concurrent 401s await this same promise.
let inFlightRefresh: Promise<string | null> | null = null;

/**
 * Decode a JWT's `exp` claim (seconds since epoch). Returns null on any parse failure.
 * We do NOT verify the signature — that's the server's job. We only need `exp` to know
 * if we should preemptively refresh.
 */
const getTokenExp = (token: string | null): number | null => {
    if (!token) return null;
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        // base64url -> base64
        const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = payload + '='.repeat((4 - payload.length % 4) % 4);
        // atob is available in the Hermes / Expo runtime.
        if (typeof atob !== 'function') return null;
        const obj = JSON.parse(atob(padded));
        return typeof obj.exp === 'number' ? obj.exp : null;
    } catch {
        return null;
    }
};

const isTokenExpiringSoon = (token: string | null, skewSec = 30): boolean => {
    const exp = getTokenExp(token);
    if (!exp) return false;
    return exp <= Math.floor(Date.now() / 1000) + skewSec;
};

/**
 * Refresh the access token. Returns the new access token, or null if refresh is
 * not possible (no refresh token, server rejected). On null, the session is cleared.
 *
 * Multiple concurrent callers share a single in-flight refresh — no thundering herd.
 */
const refreshAccessToken = async (): Promise<string | null> => {
    if (inFlightRefresh) return inFlightRefresh;

    inFlightRefresh = (async (): Promise<string | null> => {
        try {
            const refreshToken = await AsyncStorage.getItem('bubble_refresh_token');
            if (!refreshToken) return null;

            const res = await originalFetch(`${BASE_URL}/auth/refresh-token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refreshToken }),
            });
            if (!res.ok) return null;

            const data = await res.json().catch(() => null);
            const newAccess = data?.data?.accessToken;
            const newRefresh = data?.data?.refreshToken;
            if (!newAccess || !newRefresh) return null;

            await AsyncStorage.multiSet([
                ['bubble_access_token', newAccess],
                ['bubble_refresh_token', newRefresh],
                ['bubble_last_login', Date.now().toString()],
            ]);
            setApiToken(newAccess);
            return newAccess;
        } catch (err) {
            console.error('[api] refresh failed:', err);
            return null;
        }
    })();

    try {
        const result = await inFlightRefresh;
        if (!result) {
            // Refresh failed — clear session so the next request lands on /login cleanly.
            await AsyncStorage.multiRemove([
                'bubble_access_token',
                'bubble_refresh_token',
                'bubble_user',
                'bubble_last_login',
            ]);
            setApiToken(null);
        }
        return result;
    } finally {
        inFlightRefresh = null;
    }
};

const customFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : (input as any).url || String(input);

    const res = await originalFetch(input, init);

    if (res.status !== 401 || urlStr.includes('/auth/refresh-token')) {
        return res;
    }

    const newToken = await refreshAccessToken();
    if (!newToken) return res;

    const headers = init?.headers ? { ...init.headers } : {};
    (headers as any)['Authorization'] = `Bearer ${newToken}`;
    return originalFetch(input, { ...init, headers });
};

const fetch = customFetch;

export function getSecureMediaUrl(url?: string | null): string | null {
    if (!url) return null;
    if (url === 'black' || url === '#000000') return null;
    if (url.startsWith('blob:')) return url;

    if (url.includes('s3.filebase.com') || url.includes('filebase.com')) {
        const encoded = encodeURIComponent(url);
        return `${API_BASE}/api/v1/message/media/proxy?url=${encoded}`;
    }

    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('/')) return `${API_BASE}${url}`;
    return `${API_BASE}/${url}`;
}

export const startGoogleAuth = async (inviteCode?: string): Promise<{ accessToken: string; refreshToken: string; user: any } | null> => {
    // Check if the native module is actually available
    let useNativeGoogle = !!GoogleSignin;

    if (useNativeGoogle) {
        try {
            // 1. Ensure Google Play Services are available
            await GoogleSignin.hasPlayServices();

            // 2. Perform native Google Sign-In
            const userInfo = await GoogleSignin.signIn();

            // v16 returns { type: 'success', data: ... } or { type: 'cancelled' }
            if (userInfo?.type === 'cancelled' || userInfo?.data === null) {
                return null;
            }

            // 3. Extract the ID token (handle both userInfo.data?.idToken and userInfo.idToken)
            const idToken = userInfo.data?.idToken || (userInfo as any).idToken;
            if (!idToken) {
                throw new Error("No ID Token received from Google Sign-In.");
            }

            // 4. Send the verification request to our new backend route
            const response = await fetch(`${BASE_URL}/auth/google/mobile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken, inviteCode }),
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.message || `Request failed: ${response.status}`);
            }

            const data = await response.json();

            // 5. Check if successful and return tokens/user
            if (data?.data?.accessToken && data?.data?.refreshToken) {
                return {
                    accessToken: data.data.accessToken,
                    refreshToken: data.data.refreshToken,
                    user: data.data.user,
                };
            }

            throw new Error(data?.message || "Verification response from backend did not contain access and refresh tokens.");
        } catch (err: any) {
            const msg: string = err?.message || '';
            // Native module not linked in this binary → fall back to WebBrowser
            if (msg.includes('RNGoogleSignin') || msg.includes('TurboModuleRegistry') || msg.includes('enforcing')) {
                console.log("RNGoogleSignin native module missing in binary at runtime. Falling back to WebBrowser OAuth.");
                useNativeGoogle = false;
            } else if (err?.code === 'PLAY_SERVICES_NOT_AVAILABLE' || msg.includes('PLAY_SERVICES_NOT_AVAILABLE')) {
                // Device has no/outdated Google Play Services (emulator without gapps, Huawei) → fall back
                console.log("Google Play Services unavailable. Falling back to WebBrowser OAuth.");
                useNativeGoogle = false;
            } else {
                console.error('Google Native Auth Error:', err);
                throw err;
            }
        }
    }

    // --- FALLBACK FLOW (WebBrowser / Passport.js popup) ---
    if (!useNativeGoogle) {
        try {
            const redirectUri = Linking.createURL('/');
            let stateParam = `mobile_${encodeURIComponent(redirectUri)}`;
            if (inviteCode) {
                stateParam += `_invite_${encodeURIComponent(inviteCode)}`;
            }
            const authUrl = `${API_BASE}/api/v1/auth/google?state=${stateParam}`;

            const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUri);

            if (result.type === 'success') {
                const parsed = Linking.parse(result.url);
                const { access_token, refresh_token, user: userJson, error } = parsed.queryParams || {};

                if (error) {
                    throw new Error(error as string);
                }

                if (access_token && refresh_token && userJson) {
                    const userObj = JSON.parse(decodeURIComponent(userJson as string));
                    return {
                        accessToken: access_token as string,
                        refreshToken: refresh_token as string,
                        user: userObj,
                    };
                }
            }
            return null;
        } catch (err) {
            console.error('Google Auth Session Fallback Error:', err);
            throw err;
        }
    }
    return null;
};

import { initSocket, disconnectSocket } from './socket';

// In-memory cache — seeded from AsyncStorage at startup via initApiFromStorage()
const tokenCache: { accessToken: string | null } = { accessToken: null };

/**
 * Call this once at app root (e.g. _layout.tsx) to pre-load the stored token
 * into the in-memory cache so getAuthHeaders() remains synchronous.
 */
export const initApiFromStorage = async (): Promise<void> => {
    try {
        let token = await AsyncStorage.getItem('bubble_access_token');
        tokenCache.accessToken = token;

        // If the stored access token is already expired (or within 30s), refresh it
        // before any other code tries to use it. Cuts cold-start latency for returning users.
        if (token && isTokenExpiringSoon(token)) {
            const refreshed = await refreshAccessToken();
            token = refreshed ?? null;
        }

        if (token) {
            const sock = initSocket(token);
            import('./callManager').then(m => m.setupCallSocketListeners(sock));
            import('./presence').then(m => m.setupPresenceListeners(sock));
            import('./taskListeners').then(m => m.setupTaskListeners(sock));
        }
    } catch {
        tokenCache.accessToken = null;
    }
};

/** Called by authStorage.setSession() to keep cache in sync */
export const setApiToken = (token: string | null): void => {
    tokenCache.accessToken = token;
    if (token) {
        const sock = initSocket(token);
        import('./callManager').then(m => m.setupCallSocketListeners(sock));
        import('./presence').then(m => m.setupPresenceListeners(sock));
        import('./taskListeners').then(m => m.setupTaskListeners(sock));
    } else {
        disconnectSocket();
    }
};

export const getAuthHeaders = () => {
    const token = tokenCache.accessToken;
    return {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
};

const handleResponse = async (res: Response) => {
    if (!res.ok) {
        // Rate limited — back the whole client's background syncs off for a cooldown
        // so we stop stampeding the API (a 429 storm previously broke chat resolution).
        if (res.status === 429) noteRateLimit();
        const err = await res.json().catch(() => ({}));
        // Backend controllers inconsistently use `message` or `error` for error
        // text — read either so the UI never falls back to "Request failed: NNN".
        const error: any = new Error(err.message || err.error || `Request failed: ${res.status}`);
        error.status = res.status;
        error.code = err.code;
        error.data = err.data;
        throw error;
    }
    // 204 No Content — nothing to parse
    if (res.status === 204) return null;
    return res.json();
};

// ─── Auth ─────────────────────────────────────────────────────────────────────

export const register = async (data: any) => {
    const res = await fetch(`${BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

// Pre-auth probe: ask the backend what state an email is already in, so the
// UI can route users to the correct next step (OTP / login / register).
export type UserStatus = {
    exists: boolean;
    isVerified?: boolean;
    onboardingStep?: 'awaiting_otp' | 'awaiting_profile' | 'awaiting_org' | 'complete';
    signupKind?: 'individual' | 'organization';
    hasOrg?: boolean;
    role?: 'employee' | 'admin' | 'HR';
    nextAction: 'register' | 'verify_otp' | 'login_then_setup' | 'login';
};

export const checkUserStatus = async (email: string): Promise<UserStatus> => {
    const res = await fetch(`${BASE_URL}/auth/status?email=${encodeURIComponent(email.trim().toLowerCase())}`);
    const body = await handleResponse(res);
    return (body?.data || body) as UserStatus;
};

export const verifyOTP = async (email: string, otp: string) => {
    const res = await fetch(`${BASE_URL}/auth/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp }),
    });
    return handleResponse(res);
};

export const resendOTP = async (email: string) => {
    const res = await fetch(`${BASE_URL}/auth/resend-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
    });
    return handleResponse(res);
};

export const login = async (data: any) => {
    const res = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

export const clerkSyncApi = async (sessionToken: string): Promise<{ accessToken: string; refreshToken: string; user: any }> => {
    const res = await fetch(`${BASE_URL}/auth/clerk-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken }),
    });
    const data = await handleResponse(res);
    return data?.data ?? data;
};

export const logoutUser = async () => {
    const res = await fetch(`${BASE_URL}/auth/logout`, {
        method: 'POST',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const forgotPassword = async (email: string) => {
    const res = await fetch(`${BASE_URL}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
    });
    return handleResponse(res);
};

export const resetPassword = async (data: any) => {
    const res = await fetch(`${BASE_URL}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

export const setup2FA = async () => {
    const res = await fetch(`${BASE_URL}/auth/setup-2fa`, {
        method: 'POST',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const verify2FA = async (token: string) => {
    const res = await fetch(`${BASE_URL}/auth/verify-2fa`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ token }),
    });
    return handleResponse(res);
};

export const joinOrganizationByInvite = async (inviteCode: string) => {
    const res = await fetch(`${BASE_URL}/org/join`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ inviteCode }),
    });
    return handleResponse(res);
};

// ─── Users ────────────────────────────────────────────────────────────────────

export const searchUsers = async (query: string) => {
    const res = await fetch(
        `${BASE_URL}/user/search?search=${encodeURIComponent(query)}`,
        { headers: getAuthHeaders() }
    );
    const data = await handleResponse(res);
    const users = data.users || data.data || data.results || [];
    return { users };
};

export const getUserProfile = async (userId: string) => {
    const res = await fetch(`${BASE_URL}/user/${userId}`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const getContacts = async (searchQuery = '') => {
    const res = await fetch(
        `${BASE_URL}/user/contacts?search=${encodeURIComponent(searchQuery)}`,
        { headers: getAuthHeaders() }
    );
    return handleResponse(res);
};

export const getMyContacts = async () => {
    const res = await fetch(`${BASE_URL}/user/contacts/my`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const addContact = async (identifier: string) => {
    const res = await fetch(`${BASE_URL}/user/contacts/add`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ identifier }),
    });
    return handleResponse(res);
};

export const getContactNicknames = async () => {
    const res = await fetch(`${BASE_URL}/user/contacts/nicknames`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const setContactNickname = async (contactId: string, nickname: string) => {
    const res = await fetch(`${BASE_URL}/user/contacts/${contactId}/nickname`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({ nickname }),
    });
    return handleResponse(res);
};

export const updatePrivacy = async (privacySettings: any) => {
    const res = await fetch(`${BASE_URL}/profile/me`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ privacy_settings: privacySettings }),
    });
    return handleResponse(res);
};

export const getUserStatus = async (userId: string) => {
    const res = await fetch(`${BASE_URL}/user/status/${userId}`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const getOnlineScannedUsers = async () => {
    const res = await fetch(`${BASE_URL}/user/online-scanner`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

// ─── Chats & Groups ───────────────────────────────────────────────────────────

export const accessOrCreateChat = async (userId: string) => {
    const res = await fetch(`${BASE_URL}/chat`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ userId }),
    });
    return handleResponse(res);
};

export const fetchAllUserChats = async () => {
    const res = await fetch(`${BASE_URL}/chat`, { headers: getAuthHeaders() });
    return handleResponse(res);
};

export const getChatById = async (chatId: string) => {
    const res = await fetch(`${BASE_URL}/chat/${chatId}`, { headers: getAuthHeaders() });
    return handleResponse(res);
};

export const createGroupChat = async (name: string, users: string[], attachToOrg = true) => {
    const res = await fetch(`${BASE_URL}/chat/group`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ name, users, attachToOrg }),
    });
    return handleResponse(res);
};

export const joinGroupChat = async (inviteCode: string) => {
    const res = await fetch(`${BASE_URL}/chat/group/join`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ inviteCode }),
    });
    return handleResponse(res);
};

export const updateGroupChat = async (
    chatId: string,
    data: {
        chatName?: string;
        groupIcon?: string;
        groupDescription?: string;
    }
) => {
    const res = await fetch(`${BASE_URL}/chat/group/${chatId}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

export const addToGroup = async (chatId: string, userId: string) => {
    const res = await fetch(`${BASE_URL}/chat/groupadd`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ chatId, userId }),
    });
    return handleResponse(res);
};

export const removeFromGroup = async (chatId: string, userId: string) => {
    const res = await fetch(`${BASE_URL}/chat/groupremove`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ chatId, userId }),
    });
    return handleResponse(res);
};

// ─── Messages ─────────────────────────────────────────────────────────────────

export const fetchMessages = async (chatId: string) => {
    const res = await fetch(`${BASE_URL}/message/${chatId}`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const sendTextMessage = async (
    chatId: string,
    content: string,
    opts?: {
        parent_message?: string;
        mentions?: string[];
        is_forwarded?: boolean;
        clientId?: string;
        is_encrypted?: boolean;
    }
) => {
    const res = await fetch(`${BASE_URL}/message`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ chatId, content, message_type: 'text', ...opts }),
    });
    return handleResponse(res);
};

// ─── E2EE key exchange ────────────────────────────────────────────────────────

export const getChatKeys = async (chatId: string) => {
    const res = await fetch(`${BASE_URL}/chat/${chatId}/keys`, { headers: getAuthHeaders() });
    return handleResponse(res);
};

export const postChatKeys = async (
    chatId: string,
    epoch: number,
    keys: { recipientId: string; encryptedKey: string }[]
) => {
    const res = await fetch(`${BASE_URL}/chat/${chatId}/keys`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ epoch, keys }),
    });
    return handleResponse(res);
};

export const sendMediaMessage = async (
    chatId: string,
    file: any,
    opts?: {
        content?: string;
        parent_message?: string;
        message_type?: string;
        media_duration?: number;
        clientId?: string;
    }
) => {
    const token = tokenCache.accessToken;
    const fileUri = file?.uri || '';

    if (fileUri.startsWith('http://') || fileUri.startsWith('https://')) {
        const resolvedType = opts?.message_type ||
            (file.type?.startsWith('image/')
                ? 'image'
                : file.type?.startsWith('video/')
                    ? 'video'
                    : file.type?.startsWith('audio/')
                        ? 'voice'
                        : 'file');

        const res = await fetch(`${BASE_URL}/message`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                chatId,
                content: opts?.content || '',
                message_type: resolvedType,
                mediaUrl: fileUri,
                mediaType: resolvedType,
                parent_message: opts?.parent_message,
                media_duration: opts?.media_duration,
                fileName: file.name || 'attachment',
                fileSize: file.size || 1024,
                clientId: opts?.clientId,
            }),
        });
        return handleResponse(res);
    }

    const formData = new FormData();
    formData.append('chatId', chatId);
    if (opts?.content) formData.append('content', opts.content);
    if (opts?.parent_message)
        formData.append('parent_message', opts.parent_message);
    if (opts?.media_duration !== undefined)
        formData.append('media_duration', opts.media_duration.toString());
    if (opts?.clientId) formData.append('clientId', opts.clientId);

    const resolvedType =
        opts?.message_type ||
        (file.type?.startsWith('image/')
            ? 'image'
            : file.type?.startsWith('video/')
                ? 'video'
                : file.type?.startsWith('audio/')
                    ? 'voice'
                    : 'file');

    formData.append('message_type', resolvedType);
    formData.append('file', file);

    const res = await fetch(`${BASE_URL}/message`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
    });
    return handleResponse(res);
};

export const updateMessage = async (messageId: string, content: string) => {
    const res = await fetch(`${BASE_URL}/message/${messageId}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({ content }),
    });
    return handleResponse(res);
};

export const deleteMessageForMe = async (messageId: string) => {
    const res = await fetch(`${BASE_URL}/message/${messageId}/for-me`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const deleteMessageForEveryone = async (messageId: string) => {
    const res = await fetch(`${BASE_URL}/message/${messageId}/for-everyone`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const markMessagesRead = async (chatId: string) => {
    const res = await fetch(`${BASE_URL}/message/read/${chatId}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const reactToMessage = async (messageId: string, emoji: string) => {
    const res = await fetch(`${BASE_URL}/message/${messageId}/react`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ emoji }),
    });
    return handleResponse(res);
};

export const blockUser = async (userId: string) => {
    const res = await fetch(`${BASE_URL}/user/block/${userId}`, {
        method: 'POST',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const reportUser = async (userId: string, reason: string) => {
    const res = await fetch(`${BASE_URL}/user/report/${userId}`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ reason }),
    });
    return handleResponse(res);
};

export const muteChat = async (chatId: string) => {
    const res = await fetch(`${BASE_URL}/chat/mute/${chatId}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const clearChat = async (chatId: string) => {
    const res = await fetch(`${BASE_URL}/chat/clear/${chatId}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const toggleChatPin = async (chatId: string) => {
    const res = await fetch(`${BASE_URL}/chat/pin/${chatId}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const toggleMessagePin = async (messageId: string) => {
    const res = await fetch(`${BASE_URL}/message/${messageId}/pin`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const deleteChat = async (chatId: string) => {
    const res = await fetch(`${BASE_URL}/chat/${chatId}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const removeContact = async (userId: string) => {
    const res = await fetch(`${BASE_URL}/user/contacts/${userId}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const getSuggestions = async () => {
    const res = await fetch(`${BASE_URL}/user/suggestions`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const getUnreadChatCount = async () => {
    const res = await fetch(`${BASE_URL}/chat/unread-count`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const toggleArchiveChat = async (chatId: string) => {
    const res = await fetch(`${BASE_URL}/chat/toggle-archive/${chatId}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

// recentContext (decrypted "Name: text" lines) is passed for E2EE chats so Aida
// keeps working without the server ever reading/storing the ciphertext.
export const getAidaWritingSuggestions = async (message: string, conversationId: string, recentContext?: string[]) => {
    const res = await fetch(`${BASE_URL}/aida/writing-suggestions`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ message, conversationId, recentContext }),
    });
    return handleResponse(res);
};

// Context-Aware Draft on Behalf (Deep Aida): one full reply from the whole
// conversation + related meeting transcripts + open action items (F5).
export const aidaDraft = async (conversationId: string, currentMessage?: string, recentContext?: string[]) => {
    const res = await fetch(`${BASE_URL}/aida/draft`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ conversationId, currentMessage, recentContext }),
    });
    return handleResponse(res);
};

// ─── Stories ──────────────────────────────────────────────────────────────────

export const fetchStories = async () => {
    const res = await fetch(`${BASE_URL}/story`, { headers: getAuthHeaders() });
    return handleResponse(res);
};

export const uploadStory = async (
    file: File | undefined | null,
    textContent?: string,
    opts?: { bg_gradient?: string; text_color?: string }
) => {
    const token = tokenCache.accessToken;
    const formData = new FormData();
    if (textContent) formData.append('textContent', textContent);
    if (opts?.bg_gradient) formData.append('bg_gradient', opts.bg_gradient);
    if (opts?.text_color) formData.append('text_color', opts.text_color);
    if (file) formData.append('file', file);
    const res = await fetch(`${BASE_URL}/story`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
    });
    return handleResponse(res);
};

export const deleteStory = async (storyId: string) => {
    const res = await fetch(`${BASE_URL}/story/${storyId}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

// ─── E2EE ─────────────────────────────────────────────────────────────────────

export const uploadPublicKey = async (publicKey: string) => {
    const res = await fetch(`${BASE_URL}/user/public-key`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ publicKey }),
    });
    return handleResponse(res);
};

export const getPublicKey = async (userId: string) => {
    const res = await fetch(`${BASE_URL}/user/${userId}/public-key`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};



// ─── Workspace Files ──────────────────────────────────────────────────────────

export const uploadWorkspaceFile = async (
    file: File | null,
    opts?: {
        name?: string;
        workspace?: string;
        source?: string;
        sourceReference?: string;
        tags?: string;
        description?: string;
        linkUrl?: string;
    }
) => {
    const token = tokenCache.accessToken;
    const formData = new FormData();
    if (file) formData.append('file', file);
    if (opts?.linkUrl) formData.append('linkUrl', opts.linkUrl);
    if (opts?.name) formData.append('name', opts.name);
    if (opts?.workspace) formData.append('workspace', opts.workspace);
    if (opts?.source) formData.append('source', opts.source);
    if (opts?.sourceReference)
        formData.append('sourceReference', opts.sourceReference);
    if (opts?.tags) formData.append('tags', opts.tags);
    if (opts?.description) formData.append('description', opts.description);
    const res = await fetch(`${BASE_URL}/workspace/file`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
    });
    return handleResponse(res);
};

export const createWorkspaceFolder = async (
    name: string,
    workspace?: string
) => {
    const res = await fetch(`${BASE_URL}/workspace/folder`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ name, workspace }),
    });
    return handleResponse(res);
};

export const listWorkspaceFiles = async (params?: {
    workspace?: string;
    type?: string;
    source?: string;
    search?: string;
}) => {
    const q = new URLSearchParams();
    if (params?.workspace) q.set('workspace', params.workspace);
    if (params?.type) q.set('type', params.type);
    if (params?.source) q.set('source', params.source);
    if (params?.search) q.set('search', params.search);
    const res = await fetch(`${BASE_URL}/workspace/file?${q.toString()}`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const getSharedWorkspaceFolder = async (folderId: string) => {
    const res = await fetch(`${BASE_URL}/workspace/shared/${folderId}`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const deleteWorkspaceFile = async (fileId: string) => {
    const res = await fetch(`${BASE_URL}/workspace/file/${fileId}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const shareWorkspaceFile = async (chatId: string, fileId: string) => {
    const res = await fetch(`${BASE_URL}/message/share-workspace-file`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ chatId, fileId }),
    });
    return handleResponse(res);
};

export const manageWorkspaceFileAccess = async (
    fileId: string,
    payload: { action?: 'add' | 'remove'; userId?: string; isPublic?: boolean }
) => {
    const res = await fetch(`${BASE_URL}/workspace/file/${fileId}/access`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload),
    });
    return handleResponse(res);
};

export const blockWorkspaceFileUser = async (
    fileId: string,
    userId: string,
    action: 'block' | 'unblock' = 'block'
) => {
    const res = await fetch(`${BASE_URL}/workspace/file/${fileId}/block`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ userId, action }),
    });
    return handleResponse(res);
};

export const getWorkspaceFileProxyUrl = (fileId: string) =>
    `${BASE_URL}/workspace/file/${fileId}/proxy`;

export const updateWorkspaceFileMeta = async (
    fileId: string,
    data: {
        name?: string;
        workspace?: string;
        tags?: string;
        description?: string;
    }
) => {
    const res = await fetch(`${BASE_URL}/workspace/file/${fileId}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

// ─── Meet Logs ────────────────────────────────────────────────────────────────

export const fetchCallLogs = async () => {
    const res = await fetch(`${BASE_URL}/meet/logs`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const saveCallLog = async (data: {
    roomId: string;
    type: 'voice' | 'video';
    label?: string;
    duration?: number;
    missed?: boolean;
}) => {
    const res = await fetch(`${BASE_URL}/meet/logs`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

export const clearCallLogs = async () => {
    const res = await fetch(`${BASE_URL}/meet/logs`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const deleteCallLog = async (id: string) => {
    const res = await fetch(`${BASE_URL}/meet/logs/${id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

// Attach/update an agenda or activity notes on a past call log.
export const updateCallLog = async (id: string, data: { agenda?: string; notes?: string; label?: string }) => {
    const res = await fetch(`${BASE_URL}/meet/logs/${id}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

// ─── Feed / Blog ──────────────────────────────────────────────────────────────

export const fetchFeedPosts = async (page = 1, limit = 20) => {
    const res = await fetch(`${BASE_URL}/feed?page=${page}&limit=${limit}`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const getTrendingFeedPosts = async (page = 1, limit = 20) => {
    const res = await fetch(
        `${BASE_URL}/feed/trending?page=${page}&limit=${limit}`,
        { headers: getAuthHeaders() }
    );
    return handleResponse(res);
};

export const getFollowingFeedPosts = async (page = 1, limit = 20) => {
    const res = await fetch(
        `${BASE_URL}/feed/following?page=${page}&limit=${limit}`,
        { headers: getAuthHeaders() }
    );
    return handleResponse(res);
};

export const createFeedPost = async (content: string, file?: File) => {
    const token = tokenCache.accessToken;
    const formData = new FormData();
    formData.append('content', content);
    if (file) formData.append('file', file);
    const res = await fetch(`${BASE_URL}/feed`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
    });
    return handleResponse(res);
};

export const likeFeedPost = async (postId: string) => {
    const res = await fetch(`${BASE_URL}/feed/${postId}/like`, {
        method: 'POST',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const repostFeedPost = async (postId: string) => {
    const res = await fetch(`${BASE_URL}/feed/${postId}/repost`, {
        method: 'POST',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const addFeedComment = async (postId: string, text: string) => {
    const res = await fetch(`${BASE_URL}/feed/${postId}/comment`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ text }),
    });
    return handleResponse(res);
};

// ─── Community ────────────────────────────────────────────────────────────────

export const fetchCommunityCategories = async () => {
    const res = await fetch(`${BASE_URL}/community/categories`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const fetchTrendingNetworks = async () => {
    const res = await fetch(`${BASE_URL}/community/trending`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const fetchNetworkOfTheMonth = async () => {
    const res = await fetch(`${BASE_URL}/community/month`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const fetchNetworks = async (params?: {
    search?: string;
    category?: string;
    page?: number;
    limit?: number;
}) => {
    const q = new URLSearchParams();
    if (params?.search) q.set('search', params.search);
    if (params?.category) q.set('category', params.category);
    if (params?.page) q.set('page', params.page.toString());
    if (params?.limit) q.set('limit', params.limit.toString());
    const res = await fetch(
        `${BASE_URL}/community/networks?${q.toString()}`,
        { headers: getAuthHeaders() }
    );
    return handleResponse(res);
};

export const fetchNetworkById = async (id: string) => {
    const res = await fetch(`${BASE_URL}/community/networks/${id}`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const createNetwork = async (data: any) => {
    const res = await fetch(`${BASE_URL}/community/networks`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

export const joinNetwork = async (id: string) => {
    const res = await fetch(`${BASE_URL}/community/networks/${id}/join`, {
        method: 'POST',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const leaveNetwork = async (id: string) => {
    const res = await fetch(`${BASE_URL}/community/networks/${id}/leave`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const fetchNetworkPosts = async (id: string) => {
    const res = await fetch(
        `${BASE_URL}/community/networks/${id}/posts`,
        { headers: getAuthHeaders() }
    );
    return handleResponse(res);
};

export const createNetworkPost = async (id: string, data: any) => {
    const res = await fetch(
        `${BASE_URL}/community/networks/${id}/posts`,
        {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        }
    );
    return handleResponse(res);
};

export const reactToNetworkPost = async (
    networkId: string,
    postId: string,
    emoji: string
) => {
    const res = await fetch(
        `${BASE_URL}/community/networks/${networkId}/posts/${postId}/react`,
        {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ emoji }),
        }
    );
    return handleResponse(res);
};

export const forwardNetworkPost = async (
    networkId: string,
    postId: string,
    targetNetworkId?: string
) => {
    const res = await fetch(
        `${BASE_URL}/community/networks/${networkId}/posts/${postId}/forward`,
        {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ targetNetworkId }),
        }
    );
    return handleResponse(res);
};

export const deleteNetworkPost = async (networkId: string, postId: string) => {
    const res = await fetch(
        `${BASE_URL}/community/networks/${networkId}/posts/${postId}`,
        { method: 'DELETE', headers: getAuthHeaders() }
    );
    return handleResponse(res);
};

// ─── Saved Posts ──────────────────────────────────────────────────────────────

export const saveFeedPost = async (postId: string) => {
    const res = await fetch(`${BASE_URL}/feed/${postId}/save`, {
        method: 'POST',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const fetchSavedPosts = async () => {
    const res = await fetch(`${BASE_URL}/feed/saved`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

// ─── Aida AI ──────────────────────────────────────────────────────────────────

export const fetchAidaConversationObj = async () => {
    const res = await fetch(`${BASE_URL}/aida/conversation`, { headers: getAuthHeaders() });
    return handleResponse(res);
};

export const chatMessageAida = async (message: string, conversationId?: string) => {
    const res = await fetch(`${BASE_URL}/aida/chat-message`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ message, conversationId }),
    });
    return handleResponse(res);
};

export const fetchAidaConversationSummary = async (conversationId: string, recentContext?: string[]) => {
    // For E2EE chats POST the decrypted lines; otherwise a plain GET.
    if (recentContext && recentContext.length > 0) {
        const res = await fetch(`${BASE_URL}/aida/conversation-summary/${conversationId}`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ recentContext }),
        });
        return handleResponse(res);
    }
    const res = await fetch(`${BASE_URL}/aida/conversation-summary/${conversationId}`, { headers: getAuthHeaders() });
    return handleResponse(res);
};

export const fetchConversationContext = async (conversationId: string) => {
    const res = await fetch(`${BASE_URL}/aida/conversation-context/${conversationId}`, { headers: getAuthHeaders() });
    return handleResponse(res);
};

export const chatWithAida = async (message: string, history: any[] = []) => {
    const res = await fetch(`${BASE_URL}/aida/chat`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ message, history }),
    });
    return handleResponse(res);
};

export const fetchAidaBriefing = async () => {
    const res = await fetch(`${BASE_URL}/aida/daily-briefing`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const fetchAidaFinanceAdvice = async () => {
    const res = await fetch(`${BASE_URL}/aida/financial-advice`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const aidaExtractActionItems = async (
    transcript: string,
    attendeeNames?: string[]
) => {
    const res = await fetch(`${BASE_URL}/aida/extract-action-items`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ transcript, attendeeNames }),
    });
    return handleResponse(res);
};

export const aidaSearchWorkspace = async (query: string) => {
    const res = await fetch(`${BASE_URL}/aida/search-workspace`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ query }),
    });
    return handleResponse(res);
};

export const aidaScheduleSuggestion = async (
    duration = 30,
    preferredDay?: string
) => {
    const res = await fetch(`${BASE_URL}/aida/schedule-suggestion`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ duration, preferredDay }),
    });
    return handleResponse(res);
};

export const aidaScheduleTask = async (data: {
    title: string;
    startTime?: string;
    description?: string;
}) => {
    const res = await fetch(`${BASE_URL}/aida/schedule-task`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

export const aidaSummarizeFeed = async () => {
    const res = await fetch(`${BASE_URL}/aida/summarize-feed`, {
        method: 'POST',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const aidaFlagPayments = async () => {
    const res = await fetch(`${BASE_URL}/aida/flag-payments`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

// ─── Aida Org Knowledge Base (RAG Documents) ──────────────────────────────────

export const fetchOrgDocs = async (params?: { q?: string; department?: string; page?: number }) => {
    const q = new URLSearchParams();
    if (params?.q) q.set('q', params.q);
    if (params?.department) q.set('department', params.department);
    if (params?.page) q.set('page', params.page.toString());
    const res = await fetch(`${BASE_URL}/aida/org-docs?${q.toString()}`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const fetchOrgDoc = async (id: string) => {
    const res = await fetch(`${BASE_URL}/aida/org-docs/${id}`, { headers: getAuthHeaders() });
    return handleResponse(res);
};

export const createOrgDoc = async (data: {
    title: string;
    content: string;
    department?: string;
    accessLevel?: 'public' | 'restricted' | 'admin';
    tags?: string[];
}) => {
    const res = await fetch(`${BASE_URL}/aida/org-docs`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

export const updateOrgDoc = async (id: string, data: Partial<{
    title: string;
    content: string;
    department: string;
    accessLevel: string;
    tags: string[];
}>) => {
    const res = await fetch(`${BASE_URL}/aida/org-docs/${id}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

export const deleteOrgDoc = async (id: string) => {
    const res = await fetch(`${BASE_URL}/aida/org-docs/${id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};



// ─── Notifications ────────────────────────────────────────────────────────────

export const fetchNotifications = async (page = 1, limit = 30) => {
    const res = await fetch(
        `${BASE_URL}/notifications?page=${page}&limit=${limit}`,
        { headers: getAuthHeaders() }
    );
    return handleResponse(res);
};

export const fetchUnreadCount = async () => {
    const res = await fetch(`${BASE_URL}/notifications/unread-count`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const markNotificationRead = async (id: string) => {
    const res = await fetch(`${BASE_URL}/notifications/${id}/read`, {
        method: 'PUT',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const markAllNotificationsRead = async () => {
    const res = await fetch(`${BASE_URL}/notifications/read-all`, {
        method: 'PUT',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const deleteNotification = async (id: string) => {
    const res = await fetch(`${BASE_URL}/notifications/${id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const clearAllNotifications = async () => {
    const res = await fetch(`${BASE_URL}/notifications`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

// ─── Meetings ─────────────────────────────────────────────────────────────────

export const createMeeting = async (data: {
    roomId?: string;
    title?: string;
    type?: 'video' | 'voice' | 'group';
    attendees?: string[];
    attendeeNames?: string[];
    chatId?: string;
}) => {
    const res = await fetch(`${BASE_URL}/meetings`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

export const fetchActiveMeetings = async () => {
    const res = await fetch(`${BASE_URL}/meetings/active`, { headers: getAuthHeaders() });
    return handleResponse(res);
};

export const fetchMeetings = async (page = 1, limit = 20) => {
    const res = await fetch(
        `${BASE_URL}/meetings?page=${page}&limit=${limit}`,
        { headers: getAuthHeaders() }
    );
    return handleResponse(res);
};

export const fetchMeetingById = async (id: string) => {
    const res = await fetch(`${BASE_URL}/meetings/${id}`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

/**
 * Fire-and-forget transcript chunk — called in real-time from SpeechRecognition.
 * Uses meetingId (MongoDB _id) which is stored in the MeetRoom state after
 * createMeeting() is called at the start of the call.
 */
export const addMeetingTranscriptChunk = async (
    meetingId: string,
    chunk: { speaker?: string; speakerId?: string; text: string; timestamp?: number }
) => {
    const res = await fetch(`${BASE_URL}/meetings/${meetingId}/transcript`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(chunk),
    });
    return handleResponse(res);
};

export const endMeeting = async (
    meetingId: string,
    options?: { transcriptRaw?: string; saveToStorage?: boolean; sendEmail?: boolean }
) => {
    const res = await fetch(`${BASE_URL}/meetings/${meetingId}/end`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(options || {}),
    });
    return handleResponse(res);
};

export const uploadMeetingRecording = async (
    meetingId: string,
    file: any,
    speakerNames?: string[]
) => {
    const formData = new FormData();
    formData.append('audio', file);
    if (speakerNames && speakerNames.length > 0) {
        formData.append('speakerNames', JSON.stringify(speakerNames));
    }
    const res = await fetch(`${BASE_URL}/meetings/${meetingId}/transcribe-upload`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: formData,
    });
    return handleResponse(res);
};

export const getMeetingStatsWithUser = async (withUserId: string) => {
    const res = await fetch(`${BASE_URL}/meetings/stats/${withUserId}`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const fetchMeetingActionItems = async (meetingId: string) => {
    const res = await fetch(
        `${BASE_URL}/meetings/${meetingId}/action-items`,
        { headers: getAuthHeaders() }
    );
    return handleResponse(res);
};

// ── NEW: Meeting file sharing ─────────────────────────────────────────────────

/**
 * Log a file or link to the meeting's file list.
 * Call this AFTER the workspace upload succeeds to attach the record
 * to the meeting so it appears in the transcript drawer's Files tab.
 */
export const logMeetingFile = async (
    meetingId: string,
    data: {
        fileId?: string;
        name: string;
        fileType?: string;
        fileSize?: number;
        fileUrl?: string;
        linkUrl?: string;
        source?: 'file_upload' | 'tab_share' | 'screen_share';
    }
) => {
    const res = await fetch(`${BASE_URL}/meetings/${meetingId}/files`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

/** Fetch all files shared during a specific meeting. */
export const fetchMeetingFiles = async (meetingId: string) => {
    const res = await fetch(`${BASE_URL}/meetings/${meetingId}/files`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const emailMeetingTranscript = async (meetingId: string): Promise<{ success: boolean; message: string }> => {
    const res = await fetch(`${BASE_URL}/meetings/${meetingId}/email-transcript`, {
        method: 'POST',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

// ── NEW: Screen / tab share session tracking ──────────────────────────────────

/**
 * Record the start of a screen / window / tab share.
 * Returns a sessionId to be used when the share ends.
 */
export const startMeetingScreenShare = async (
    meetingId: string,
    data: { shareType?: 'screen' | 'window' | 'tab'; label?: string }
) => {
    const res = await fetch(
        `${BASE_URL}/meetings/${meetingId}/screen-share/start`,
        {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        }
    );
    return handleResponse(res);
};

/**
 * Record the end of a screen / window / tab share session.
 * Persists duration automatically on the backend.
 */
export const endMeetingScreenShare = async (
    meetingId: string,
    sessionId: string
) => {
    const res = await fetch(
        `${BASE_URL}/meetings/${meetingId}/screen-share/${sessionId}/end`,
        {
            method: 'PATCH',
            headers: getAuthHeaders(),
        }
    );
    return handleResponse(res);
};

// ─── Templates ────────────────────────────────────────────────────────────────

export const fetchTemplates = async (
    type?: 'meeting' | 'document' | 'task'
) => {
    const q = type ? `?type=${type}` : '';
    const res = await fetch(`${BASE_URL}/templates${q}`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const createTemplate = async (data: {
    type: 'meeting' | 'document' | 'task';
    title: string;
    description?: string;
    content?: Record<string, any>;
    tags?: string[];
}) => {
    const res = await fetch(`${BASE_URL}/templates`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

export const updateTemplate = async (id: string, data: any) => {
    const res = await fetch(`${BASE_URL}/templates/${id}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

export const useTemplate = async (id: string) => {
    const res = await fetch(`${BASE_URL}/templates/${id}/use`, {
        method: 'POST',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const deleteTemplate = async (id: string) => {
    const res = await fetch(`${BASE_URL}/templates/${id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

// ─── Activity Log ─────────────────────────────────────────────────────────────

export const fetchActivityLog = async (params?: {
    page?: number;
    limit?: number;
    action?: string;
    entityType?: string;
}) => {
    const q = new URLSearchParams();
    if (params?.page) q.set('page', params.page.toString());
    if (params?.limit) q.set('limit', params.limit.toString());
    if (params?.action) q.set('action', params.action);
    if (params?.entityType) q.set('entityType', params.entityType);
    const res = await fetch(`${BASE_URL}/activity?${q.toString()}`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const clearActivityLog = async () => {
    const res = await fetch(`${BASE_URL}/activity`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

// ─── Invoices ─────────────────────────────────────────────────────────────────

export const createInvoice = async (data: {
    recipientName?: string;
    recipientEmail?: string;
    items: { description: string; quantity: number; unitPrice: number }[];
    tax?: number;
    discount?: number;
    currency?: string;
    dueDate?: string;
    notes?: string;
}) => {
    const res = await fetch(`${BASE_URL}/payment/invoice`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

export const fetchInvoices = async (status?: string) => {
    const q = status ? `?status=${status}` : '';
    const res = await fetch(`${BASE_URL}/payment/invoices${q}`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const fetchInvoiceById = async (id: string) => {
    const res = await fetch(`${BASE_URL}/payment/invoice/${id}`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const updateInvoice = async (
    id: string,
    data: {
        status?: string;
        dueDate?: string;
        notes?: string;
        recipientEmail?: string;
    }
) => {
    const res = await fetch(`${BASE_URL}/payment/invoice/${id}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

export const deleteInvoice = async (id: string) => {
    const res = await fetch(`${BASE_URL}/payment/invoice/${id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

// ─── Extended Tasks ───────────────────────────────────────────────────────────

export const createTaskFull = async (data: {
    title: string;
    description?: string;
    start_time: string;
    end_time: string;
    type?: 'event' | 'task' | 'synced' | 'meeting';
    meetingType?: 'voice' | 'video';
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    assignedTo?: string;
    color?: string;
    source?: string;
    isRecurring?: boolean;
    recurrence?: 'daily' | 'weekly' | 'monthly';
    recipients?: string[];
    externalEmails?: string[];
}) => {
    const res = await fetch(`${BASE_URL}/tasks`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

export const updateTaskFull = async (id: string, data: any) => {
    const res = await fetch(`${BASE_URL}/tasks/${id}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

export const deleteTaskFull = async (id: string) => {
    const res = await fetch(`${BASE_URL}/tasks/${id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const fetchTasks = async (params?: {
    type?: string;
    status?: string;
    source?: string;
    from?: string;
    to?: string;
}) => {
    const q = new URLSearchParams();
    if (params?.type) q.set('type', params.type);
    if (params?.status) q.set('status', params.status);
    if (params?.source) q.set('source', params.source);
    if (params?.from) q.set('from', params.from);
    if (params?.to) q.set('to', params.to);
    const res = await fetch(`${BASE_URL}/tasks?${q.toString()}`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const snoozeTask = async (id: string, snoozedUntil: string) => {
    const res = await fetch(`${BASE_URL}/tasks/${id}/snooze`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ snoozedUntil }),
    });
    return handleResponse(res);
};

// ─── Feed: Trending Tags ──────────────────────────────────────────────────────

export const getTrendingTags = async () => {
    const res = await fetch(`${BASE_URL}/feed/trending`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

// ─── User: Follow / Suggestions ───────────────────────────────────────────────

export const followUser = async (userId: string) => {
    const res = await fetch(`${BASE_URL}/user/${userId}/follow`, {
        method: 'POST',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const getSuggestedUsers = async () => {
    const res = await fetch(`${BASE_URL}/user/suggestions`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const getMyFollowers = async (userId: string) => {
    const res = await fetch(`${BASE_URL}/user/${userId}/followers`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const getMyFollowing = async (userId: string) => {
    const res = await fetch(`${BASE_URL}/user/${userId}/following`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

// ─── Profile: Avatar Upload ───────────────────────────────────────────────────

export const uploadAvatar = async (file: File | string) => {
    const token = tokenCache.accessToken;
    const formData = new FormData();
    if (typeof file === 'string') {
        const fileUri = file;
        const filename = fileUri.split('/').pop() || 'avatar.jpg';
        formData.append('file', {
            uri: Platform.OS === 'ios' ? fileUri.replace('file://', '') : fileUri,
            name: filename,
            type: 'image/jpeg',
        } as any);
    } else {
        formData.append('file', file);
    }
    const res = await fetch(`${BASE_URL}/profile/avatar`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
    });
    return handleResponse(res);
};

export const getAllAvatars = async () => {
    const res = await fetch(`${BASE_URL}/profile/avatars`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const uploadGroupOrOrgImage = async (fileUri: string): Promise<string> => {
    const token = tokenCache.accessToken;
    const formData = new FormData();
    const filename = fileUri.split('/').pop() || 'upload.jpg';

    formData.append('file', {
        uri: Platform.OS === 'ios' ? fileUri.replace('file://', '') : fileUri,
        name: filename,
        type: 'image/jpeg',
    } as any);

    const res = await fetch(`${BASE_URL}/message/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
    });
    const data = await handleResponse(res);
    return data.url;
};

export const uploadBackground = async (file: File) => {
    const token = tokenCache.accessToken;
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${BASE_URL}/profile/background`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
    });
    return handleResponse(res);
};

// ─── Profile: Management ───────────────────────────────────────────────────────

export const getMyProfile = async () => {
    const res = await fetch(`${BASE_URL}/profile/me`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const updateProfile = async (data: any) => {
    const res = await fetch(`${BASE_URL}/profile/me`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

export const setupProfile = async (data: any) => {
    const res = await fetch(`${BASE_URL}/profile/setup`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

// ─── Workspace: Shared With Me ────────────────────────────────────────────────

export const getSharedWithMeFiles = async () => {
    const res = await fetch(`${BASE_URL}/workspace/shared-with-me`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

// ─── Messages: Unread Count ───────────────────────────────────────────────────

export const fetchUnreadMessageCount = async () => {
    const res = await fetch(`${BASE_URL}/chat/unread-count`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

// ─── Messages: Request System ─────────────────────────────────────────────────

export const sendMessageRequest = async (userId: string) => {
    const res = await fetch(`${BASE_URL}/message/request/${userId}`, {
        method: 'POST',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const respondToMessageRequest = async (requestId: string, action: 'accept' | 'decline') => {
    const res = await fetch(`${BASE_URL}/message/request/${requestId}`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({ action }),
    });
    return handleResponse(res);
};

export const getLiveKitToken = async (roomId: string, joinToken?: string) => {
    const qs = new URLSearchParams({ roomId });
    if (joinToken) qs.set('joinToken', joinToken);
    const res = await fetch(`${BASE_URL}/meet/livekit-token?${qs.toString()}`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

// Sign a shareable join link for the given call room (POST /meet/invite-link).
export const createCallInviteLink = async (roomId: string): Promise<{ url: string; joinToken: string; roomId: string }> => {
    const res = await fetch(`${BASE_URL}/meet/invite-link`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ roomId }),
    });
    return handleResponse(res);
};

export const onboardOrgBrain = async (description: string) => {
    const res = await fetch(`${BASE_URL}/org/brain/onboard`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ description }),
    });
    return handleResponse(res);
};

export const getOrgInviteCode = async () => {
    const res = await fetch(`${BASE_URL}/org/invite-code`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const ingestOrgDocument = async (data: { title: string; content: string; department?: string; accessLevel?: string; tags?: string[] }) => {
    const res = await fetch(`${BASE_URL}/org/documents`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

// Brain ingestion from a URL — YouTube transcript or generic web page.
export const ingestOrgDocumentFromUrl = async (data: { url: string; title?: string; department?: string; accessLevel?: string; tags?: string[] }) => {
    const res = await fetch(`${BASE_URL}/org/documents/from-url`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

// Brain ingestion from a file (PDF/txt/md). `file` accepts an expo-image-picker /
// document-picker shape ({ uri, name, mimeType }) — we wrap it in FormData.
export const ingestOrgDocumentFromFile = async (params: {
    file: { uri: string; name: string; type: string };
    title?: string;
    department?: string;
    accessLevel?: string;
    tags?: string[];
}) => {
    const form = new FormData();
    // @ts-ignore — React Native FormData accepts an object with uri/name/type
    form.append('file', { uri: params.file.uri, name: params.file.name, type: params.file.type });
    if (params.title) form.append('title', params.title);
    if (params.department) form.append('department', params.department);
    if (params.accessLevel) form.append('accessLevel', params.accessLevel);
    if (params.tags) form.append('tags', JSON.stringify(params.tags));

    const token = tokenCache.accessToken;
    const res = await fetch(`${BASE_URL}/org/documents/from-file`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form as any,
    });
    return handleResponse(res);
};

export const fetchAiDescription = async (prompt: string) => {
    const res = await fetch(`${BASE_URL}/tasks/ai-describe`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ prompt }),
    });
    return handleResponse(res);
};

export const uploadCloudBackup = async (backupData: string) => {
    const res = await fetch(`${BASE_URL}/profile/backup`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ backupData }),
    });
    return handleResponse(res);
};

export const fetchCloudBackup = async () => {
    const res = await fetch(`${BASE_URL}/profile/backup`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const registerPushToken = async (token: string, deviceType?: string) => {
    const res = await fetch(`${BASE_URL}/auth/push-token`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ token, deviceType }),
    });
    return handleResponse(res);
};

export const updateOrgProfile = async (data: {
    name?: string;
    industry?: string;
    size?: string;
    description?: string;
    logo?: string;
    allowMembersToShareInvite?: boolean;
    emailTranscriptsToMembers?: boolean;
}) => {
    const res = await fetch(`${BASE_URL}/org/profile`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

export const updateGroupSettings = async (
    chatId: string,
    data: {
        chatName?: string;
        groupIcon?: string;
        groupDescription?: string;
        allowMembersToShareInvite?: boolean;
        maxMembers?: number;
        transcriptPolicy?: 'email' | 'save' | 'off';
        resources?: { label: string; url?: string; type?: 'link' | 'file'; addedAt?: string }[];
    }
) => {
    const res = await fetch(`${BASE_URL}/chat/group/update`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ chatId, ...data }),
    });
    return handleResponse(res);
};

export const getOrgMembers = async () => {
    const res = await fetch(`${BASE_URL}/org/members`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

export const getOrgTranscripts = async () => {
    const res = await fetch(`${BASE_URL}/org/transcripts`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

// ─── Org Knowledge Base file upload (org-doc CRUD lives above as fetchOrgDocs/…) ─

/** Upload a file (PDF/DOCX/TXT/…) into the brain; becomes a knowledge-base document. */
export const ingestOrgFile = async (file: { uri: string; name: string; type: string }, title?: string) => {
    const token = tokenCache.accessToken;
    const formData = new FormData();
    formData.append('sourceType', 'file');
    if (title) formData.append('title', title);
    formData.append('file', {
        uri: Platform.OS === 'ios' ? file.uri.replace('file://', '') : file.uri,
        name: file.name,
        type: file.type || 'application/octet-stream',
    } as any);
    const res = await fetch(`${BASE_URL}/brain/ingest`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
    });
    return handleResponse(res);
};

// ─── Company Brain ────────────────────────────────────────────────────────────

/** Ingest a file (PDF, DOCX, TXT, MP3, MP4, …) into the brain */
export const brainIngestFile = async (file: {
    uri: string;
    name: string;
    type: string;
}) => {
    const token = tokenCache.accessToken;
    const formData = new FormData();
    formData.append('file', file as any);
    const res = await fetch(`${BASE_URL}/brain/ingest`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
    });
    return handleResponse(res);
};

/** Ingest a raw text snippet or paste into the brain */
export const brainIngestText = async (text: string, title?: string, department?: string) => {
    const res = await fetch(`${BASE_URL}/brain/ingest`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ text, title, department }),
    });
    return handleResponse(res);
};

/** Ingest a URL (web page / YouTube / doc link) into the brain */
export const brainIngestUrl = async (url: string, title?: string) => {
    const res = await fetch(`${BASE_URL}/brain/ingest`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ url, title }),
    });
    return handleResponse(res);
};

/** Poll job status */
export const brainGetJobStatus = async (jobId: string) => {
    const res = await fetch(`${BASE_URL}/brain/job/${jobId}`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

/** List all ingestion jobs for this org */
export const brainGetJobs = async () => {
    const res = await fetch(`${BASE_URL}/brain/jobs`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

/** Semantic search across org brain */
export const brainSearch = async (query: string, department?: string, topK?: number) => {
    const params = new URLSearchParams({ query });
    if (department) params.append('department', department);
    if (topK) params.append('topK', String(topK));
    const res = await fetch(`${BASE_URL}/brain/search?${params}`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

/** Generate an onboarding brief for the current user */
export const brainOnboardingBrief = async () => {
    const res = await fetch(`${BASE_URL}/brain/onboarding/brief`, {
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

/** Route a question to the right expert */
export const brainAskQuestion = async (question: string) => {
    const res = await fetch(`${BASE_URL}/brain/ask`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ question }),
    });
    return handleResponse(res);
};

/** Confirm a question was resolved (closes the loop) */
export const brainResolveQuestion = async (questionId: string, answer: string) => {
    const res = await fetch(`${BASE_URL}/brain/resolve`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ questionId, answer }),
    });
    return handleResponse(res);
};

/** Get the daily digest (morning brief) for the current user */
export const getDailyDigest = async (date?: string) => {
    const q = date ? `?date=${date}` : '';
    const res = await fetch(`${BASE_URL}/brain/digest${q}`, { headers: getAuthHeaders() });
    return handleResponse(res);
};

/** Get the last N days of digest history */
export const getDigestHistory = async (days = 7) => {
    const res = await fetch(`${BASE_URL}/brain/digest/history?days=${days}`, { headers: getAuthHeaders() });
    return handleResponse(res);
};

/** Get the expertise radar — topic-expert leaderboard for the org */
export const getExpertiseRadar = async (topic?: string) => {
    const q = topic ? `?topic=${encodeURIComponent(topic)}` : '';
    const res = await fetch(`${BASE_URL}/brain/expertise${q}`, { headers: getAuthHeaders() });
    return handleResponse(res);
};

// ─── Calendar Events ──────────────────────────────────────────────────────────

/** Create a new calendar event */
export const createCalendarEvent = async (data: {
    title: string;
    eventType?: 'company' | 'holiday' | 'meeting_video' | 'meeting_audio' | 'all_day';
    description?: string;
    startTime: string;
    endTime: string;
    isAllDay?: boolean;
    attendees?: string[];
    agenda?: string;
    tags?: string[];
    isRecurring?: boolean;
    recurrenceRule?: string;
}) => {
    const res = await fetch(`${BASE_URL}/events/create`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

/** List org events with optional filters */
export const getCalendarEvents = async (params?: {
    start?: string;
    end?: string;
    type?: string;
    mine?: boolean;
}) => {
    const q = new URLSearchParams();
    if (params?.start) q.set('start', params.start);
    if (params?.end) q.set('end', params.end);
    if (params?.type) q.set('type', params.type);
    if (params?.mine) q.set('mine', 'true');
    const res = await fetch(`${BASE_URL}/events?${q.toString()}`, { headers: getAuthHeaders() });
    return handleResponse(res);
};

/** Get a single event by ID */
export const getCalendarEvent = async (id: string) => {
    const res = await fetch(`${BASE_URL}/events/${id}`, { headers: getAuthHeaders() });
    return handleResponse(res);
};

/** Update an event */
export const updateCalendarEvent = async (id: string, data: any) => {
    const res = await fetch(`${BASE_URL}/events/${id}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

/** Cancel (soft-delete) an event */
export const deleteCalendarEvent = async (id: string) => {
    const res = await fetch(`${BASE_URL}/events/${id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

/** Start a meeting — creates LiveKit room, returns roomId */
export const startCalendarMeeting = async (eventId: string) => {
    const res = await fetch(`${BASE_URL}/events/${eventId}/start-meeting`, {
        method: 'POST',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

/** End a meeting — submit transcript for brain enrichment */
export const endCalendarMeeting = async (
    eventId: string,
    data: { transcriptText?: string; transcriptChunks?: any[] }
) => {
    const res = await fetch(`${BASE_URL}/events/${eventId}/end-meeting`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
    });
    return handleResponse(res);
};

/** Bulk import public holidays (admin only) */
export const bulkImportHolidays = async (holidays: { name: string; date: string; country?: string }[]) => {
    const res = await fetch(`${BASE_URL}/events/holidays/bulk`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ holidays }),
    });
    return handleResponse(res);
};

/** Get smart event creation suggestions (title, participants, agenda, conflicts) */
export const getEventSuggestions = async (query?: string, startTime?: string) => {
    const q = new URLSearchParams();
    if (query) q.set('query', query);
    if (startTime) q.set('startTime', startTime);
    const res = await fetch(`${BASE_URL}/events/suggest?${q.toString()}`, { headers: getAuthHeaders() });
    return handleResponse(res);
};

/**
 * Ask the AI (DeepSeek) whether a new event looks like a recurring pattern based on the
 * user's recent events. Returns { suggest, recurrence?, message? }. Safe to call even if the
 * endpoint/DeepSeek key is unavailable — callers should treat a thrown error as "no suggestion".
 */
export const suggestRecurrence = async (
    payload: { title: string; startTime: string; recentEvents: { title: string; start_time: string }[] }
): Promise<{ suggest: boolean; recurrence?: 'daily' | 'weekly' | 'monthly'; message?: string }> => {
    const res = await fetch(`${BASE_URL}/tasks/suggest-recurrence`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload),
    });
    return handleResponse(res);
};

// ── Recurring-pattern detection (events repeated ≥3 times → "make it recurring?") ──
// Backend: recurringPatternController, mounted at /api/v1/events/patterns/*.

/** Run server-side pattern detection for the current user (best-effort). */
export const detectPatterns = async () => {
    const res = await fetch(`${BASE_URL}/events/patterns/detect`, {
        method: 'POST',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

/** Patterns awaiting a decision — powers the in-app "set up recurring?" banner. */
export const getPendingPatterns = async (): Promise<{ patterns: any[] }> => {
    const res = await fetch(`${BASE_URL}/events/patterns/pending`, { headers: getAuthHeaders() });
    return handleResponse(res);
};

/** Confirm a detected pattern → backend marks matching events recurring. */
export const confirmPattern = async (id: string) => {
    const res = await fetch(`${BASE_URL}/events/patterns/${id}/confirm`, {
        method: 'POST',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};

/** Dismiss a detected pattern so the user isn't pinged again. */
export const dismissPattern = async (id: string) => {
    const res = await fetch(`${BASE_URL}/events/patterns/${id}/dismiss`, {
        method: 'POST',
        headers: getAuthHeaders(),
    });
    return handleResponse(res);
};