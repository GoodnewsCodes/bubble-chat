import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { getUnreadChatCount } from './api';

/**
 * WhatsApp-style app-icon unread counter.
 *
 * Pulls the authoritative total from the backend (`GET /chat/unread-count` —
 * the same endpoint the web tab-title counter uses) and mirrors it onto the
 * app icon. Call sites: after a chat-list sync, on `unread_count_updated`
 * socket events, and when the app foregrounds/backgrounds.
 *
 * Expo Go on Android has no badge support (notifications module is limited
 * there) — silently no-op; the dev build gets full behavior. iOS works.
 */
const isExpoGoAndroid = Constants.appOwnership === 'expo' && Platform.OS === 'android';

let lastApplied: number | null = null;
let inFlight = false;

export const syncAppBadge = async (): Promise<void> => {
  if (isExpoGoAndroid || inFlight) return;
  inFlight = true;
  try {
    const res = await getUnreadChatCount();
    const count = Math.max(0, Number(res?.count ?? res?.data?.count ?? 0) || 0);
    if (count !== lastApplied) {
      await Notifications.setBadgeCountAsync(count);
      lastApplied = count;
    }
  } catch {
    // Badge is best-effort — never let it surface errors.
  } finally {
    inFlight = false;
  }
};

/** Immediate local set (e.g. clearing on read) without a network round-trip. */
export const setAppBadge = async (count: number): Promise<void> => {
  if (isExpoGoAndroid) return;
  try {
    await Notifications.setBadgeCountAsync(Math.max(0, count));
    lastApplied = Math.max(0, count);
  } catch { /* best-effort */ }
};
