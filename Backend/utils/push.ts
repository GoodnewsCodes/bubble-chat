import { PushToken } from '../models/pushToken';
import { User } from '../models/users';

export type PushCategory = 'call' | 'message' | 'reminder' | 'digest' | 'system';

/**
 * Sends push notifications to a list of users using the Expo Push API.
 *
 * Honors each recipient's notification preferences:
 * - `notification_settings.muted === true` drops EVERY category — "Pause all
 *   push notifications" means all of them, calls included (user decision).
 * - `notification_settings.preview === false` hides message content: the body
 *   is replaced with a generic line for 'message' pushes.
 *
 * @param userIds Array of MongoDB User IDs (string or ObjectId)
 * @param title Notification Title
 * @param body Notification Body/Content
 * @param data Optional extra key-value pairs to pass along
 * @param category What kind of push this is (defaults to 'message')
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
    if (pushTokens.length === 0) {
      // console.log(`[Push] No push tokens registered for user(s): ${strUserIds.join(', ')}`);
      return;
    }

    // Build Expo message payload — per-recipient so preview:false can redact.
    const messages = pushTokens.map(pt => {
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

    // console.log(`[Push] Dispatching ${messages.length} push notification(s) to Expo...`);

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
      return;
    }

    const result = await response.json();
    // console.log('[Push] Notification dispatch response:', JSON.stringify(result));
  } catch (error) {
    console.error('[Push] Failed to send push notification:', error);
  }
};
