import AsyncStorage from '@react-native-async-storage/async-storage';
import { setApiToken } from './api';

/** Decode a JWT's exp claim (seconds since epoch); null for opaque/malformed tokens. */
const decodeJwtExp = (token: string): number | null => {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    if (typeof atob !== 'function') return null;
    const obj = JSON.parse(atob(padded));
    return typeof obj.exp === 'number' ? obj.exp : null;
  } catch {
    return null;
  }
};

const KEYS = {
  ACCESS_TOKEN: 'bubble_access_token',
  REFRESH_TOKEN: 'bubble_refresh_token',
  USER: 'bubble_user',
  LAST_LOGIN: 'bubble_last_login',
  HAS_SEEN_ONBOARDING: 'bubble_has_seen_onboarding',
} as const;

export const authStorage = {
  /** Store tokens + user after login/OTP verify */
  async setSession(accessToken: string, refreshToken: string, user: any) {
    await AsyncStorage.multiSet([
      [KEYS.ACCESS_TOKEN, accessToken],
      [KEYS.REFRESH_TOKEN, refreshToken],
      [KEYS.USER, JSON.stringify(user)],
      [KEYS.LAST_LOGIN, Date.now().toString()],
    ]);
    setApiToken(accessToken); // keep in-memory cache in sync
    // E2EE removed — no keypair/public-key bootstrap on login.
  },

  /** Get stored access token */
  async getAccessToken(): Promise<string | null> {
    return AsyncStorage.getItem(KEYS.ACCESS_TOKEN);
  },

  /** Get stored refresh token */
  async getRefreshToken(): Promise<string | null> {
    return AsyncStorage.getItem(KEYS.REFRESH_TOKEN);
  },

  /** Get stored user object */
  async getUser(): Promise<any | null> {
    const raw = await AsyncStorage.getItem(KEYS.USER);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  },

  /** Get the timestamp of last login */
  async getLastLogin(): Promise<number | null> {
    const raw = await AsyncStorage.getItem(KEYS.LAST_LOGIN);
    return raw ? parseInt(raw, 10) : null;
  },

  /**
   * Check if session is still valid. The refresh token's own JWT `exp` claim is
   * authoritative (rotated on every refresh); the last-login wall-clock window is
   * only a fallback for opaque tokens. A stale access token alone is fine — the
   * api layer refreshes it on demand.
   */
  async isSessionValid(): Promise<boolean> {
    const refreshToken = await authStorage.getRefreshToken();
    if (!refreshToken) return false;
    const exp = decodeJwtExp(refreshToken);
    if (exp !== null) return exp > Math.floor(Date.now() / 1000);
    const lastLogin = await authStorage.getLastLogin();
    if (!lastLogin) return false;
    const THIRTY_ONE_DAYS = 31 * 24 * 60 * 60 * 1000;
    return Date.now() - lastLogin < THIRTY_ONE_DAYS;
  },

  /** Update stored user data (e.g. after profile setup) */
  async updateUser(user: any) {
    await AsyncStorage.setItem(KEYS.USER, JSON.stringify(user));
  },

  /** Clear all session data (logout) */
  async clearSession() {
    await AsyncStorage.multiRemove([
      KEYS.ACCESS_TOKEN,
      KEYS.REFRESH_TOKEN,
      KEYS.USER,
      KEYS.LAST_LOGIN,
    ]);
    setApiToken(null); // clear in-memory cache
  },

  /** Mark onboarding as seen */
  async setOnboardingSeen() {
    await AsyncStorage.setItem(KEYS.HAS_SEEN_ONBOARDING, '1');
  },

  /** Has user seen the onboarding slides before? */
  async hasSeenOnboarding(): Promise<boolean> {
    const val = await AsyncStorage.getItem(KEYS.HAS_SEEN_ONBOARDING);
    return val === '1';
  },
};
