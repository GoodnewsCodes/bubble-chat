import { PushToken } from '../models/pushToken';
import { User } from '../models/users';
import { sendWebPushNotification, isWebPushReady } from './webPush';

export type PushCategory = 'call' | 'message' | 'reminder' | 'digest' | 'system';

/** Returns true when the token JSON represents a Web Push subscription object. */
const isWebPushToken = (token: string): boolean => {
  try {
    const obj = JSON.parse(token);
    return typeof obj?.endpoint === 'string';
  } catch {
    return false;
  }
};

/**
 * Sends push notifications to a list of users.
 *
 * Supports two delivery channels, determined by the stored token format:
 * - **Web Push** (VAPID): tokens stored as JSON subscription objects
 *   (deviceType='web'). Used for browsers / PWA installs.
 * - **Expo Push**: all other tokens. Existing mobile behaviour unchanged.
 *
 * Honors each recipient's notification preferences:
 * - `notification_settings.muted === true` drops EVERY category.
 * - `notification_settings.preview === false` hides message content for
 *   'message' category pushes.
 *
 * @param userIds Array of MongoDB User IDs (string or ObjectId)
 * @param title   Notification title
 * @param body    Notification body
 * @param data    Extra key-value pairs forwarded to the notification payload
 * @param category Type of push (defaults to 'message')
 */
export const sendPushNotification = async (
  userIds: (string | any)[],
  title: string,
  body: string,
  data?: any,
  category: PushCategory = 'message'
): Promise<void> => {
  try {
    if (!userIds || userIds.length === 0) return;

    // Standardize IDs to strings
    let strUserIds = userIds.map(id => String(id));

    // Preference gate: fetch recipients' notification settings once.
    const prefsById = new Map<string, any>();
    try {
      const users = await User.find({ _id: { $in: strUserIds } })
        .select('notification_settings')
        .lean();
      for (const u of users) prefsById.set(String(u._id), (u as any).notification_settings || {});
    } catch (prefErr) {
      // Preference lookup failing must never block delivery — fall back to send-all.
      console.error('[Push] Preference lookup failed, sending unfiltered:', prefErr);
    }

    strUserIds = strUserIds.filter(id => prefsById.get(id)?.muted !== true);
    if (strUserIds.length === 0) return;

    // Retrieve active push tokens for target users
    const pushTokens = await PushToken.find({ userId: { $in: strUserIds } });
    if (pushTokens.length === 0) return;

    // ── Split tokens by delivery channel ─────────────────────────────────────
    const webTokens: typeof pushTokens = [];
    const expoTokens: typeof pushTokens = [];

    for (const pt of pushTokens) {
      if (isWebPushToken(pt.token)) {
        webTokens.push(pt);
      } else {
        expoTokens.push(pt);
      }
    }

    // ── 1. Web Push (VAPID) ───────────────────────────────────────────────────
    if (webTokens.length > 0 && isWebPushReady()) {
      const isCall = category === 'call';
      const expiredIds: string[] = [];

      await Promise.all(webTokens.map(async pt => {
        const prefs = prefsById.get(String(pt.userId)) || {};
        const redact = category === 'message' && prefs.preview === false;

        try {
          await sendWebPushNotification(pt.token, {
            title,
            body: redact ? 'New message' : body,
            icon: '/pwa-192x192.svg',
            badge: '/favicon.svg',
            // Calls keep the notification visible and add Answer/Decline buttons
            tag: isCall ? `call-${data?.roomId || 'ring'}` : undefined,
            requireInteraction: isCall,
            vibrate: isCall ? [200, 100, 200, 100, 400] : [200],
            data: {
              ...(data || {}),
              category,
              url: isCall
                ? `/call/join?room=${data?.roomId}&type=${data?.callType || 'voice'}`
                : '/dashboard',
            },
            actions: isCall
              ? [
                { action: 'answer', title: '✅ Answer' },
                { action: 'decline', title: '❌ Decline' },
              ]
              : undefined,
          });
        } catch (err: any) {
          if (err?.message === 'SUBSCRIPTION_EXPIRED') {
            expiredIds.push(String(pt._id));
          } else {
            console.error('[Push] Web push failed:', err);
          }
        }
      }));

      // Prune expired subscriptions so they don't clog future sends
      if (expiredIds.length > 0) {
        PushToken.deleteMany({ _id: { $in: expiredIds } })
          .catch(e => console.error('[Push] Failed to prune expired web tokens:', e));
      }
    }

    // ── 2. Expo Push ──────────────────────────────────────────────────────────
    if (expoTokens.length > 0) {
      const messages = expoTokens.map(pt => {
        const prefs = prefsById.get(String(pt.userId)) || {};
        const redact = category === 'message' && prefs.preview === false;
        return {
          to: pt.token,
          sound: prefs.sounds === false ? undefined : ('default' as const),
          title,
          body: redact ? 'New message' : body,
          data: data || {},
        };
      });

      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messages),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[Push] Expo returned status ${response.status}: ${errText}`);
      }
    }
  } catch (error) {
    console.error('[Push] Failed to send push notification:', error);
  }
};
