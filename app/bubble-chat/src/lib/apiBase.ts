// Single source of truth for the backend host, shared by api.ts (HTTP) and
// socket.ts (realtime). Kept in its OWN module so both can import it without a
// circular dependency (api.ts ↔ socket.ts import each other for other things).

import Constants from 'expo-constants';

const ENV_API_URL = process.env.EXPO_PUBLIC_API_URL?.trim();

// A release/dev build shipped without the EAS secret would silently point every
// request + socket at localhost and just appear frozen. Flag it so the app root
// can surface a visible error instead of failing invisibly. (In __DEV__ the
// localhost fallback is expected — we auto-rewrite it to the Metro host below.)
export const API_MISCONFIGURED = !ENV_API_URL && !__DEV__;
if (!ENV_API_URL) {
  const msg = '[api] EXPO_PUBLIC_API_URL is not set — falling back to localhost. Set it (EAS secret) to the Bubble Space backend for real builds.';
  if (API_MISCONFIGURED) console.error(msg); else console.warn(msg);
}

// In dev on a PHYSICAL device (Expo Go), `localhost` resolves to the phone
// itself, not the Mac running the backend — so every request + the socket fail
// and the app looks "frozen" (no profile, no endpoints, no realtime, sends stuck).
// This is the recurring trap. Rewrite a localhost host to the Metro bundler's
// host IP (the exact IP the app was loaded from), keeping the port + path — so it
// just works on device without hand-editing an IP on every network change. On the
// iOS simulator the Metro host is already localhost, so nothing changes there.
const resolveDevHost = (url: string): string => {
  if (!__DEV__) return url;
  try {
    if (!/:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(url)) return url;
    const hostUri: string | undefined =
      (Constants.expoConfig as any)?.hostUri ||
      (Constants as any)?.expoGoConfig?.debuggerHost ||
      (Constants as any)?.manifest2?.extra?.expoGo?.debuggerHost ||
      (Constants as any)?.manifest?.debuggerHost;
    const host = typeof hostUri === 'string' ? hostUri.split(':')[0] : undefined;
    if (host && host !== 'localhost' && host !== '127.0.0.1') {
      return url.replace(/(:\/\/)(localhost|127\.0\.0\.1)/, `$1${host}`);
    }
  } catch { /* keep the original url */ }
  return url;
};

export const BASE_URL = resolveDevHost(ENV_API_URL || 'http://localhost:3000/api/v1');
export const API_BASE = BASE_URL.replace(/\/api\/v1\/?$/, '');
if (__DEV__) console.log('[api] resolved BASE_URL =', BASE_URL);
