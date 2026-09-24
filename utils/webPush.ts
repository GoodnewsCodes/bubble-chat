import webpush from 'web-push';

let vapidInitialized = false;

/**
 * Call once at server startup to configure the web-push library with VAPID
 * credentials from environment variables.
 */
export const initWebPush = (): void => {
  const publicKey  = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject    = process.env.VAPID_SUBJECT || 'mailto:goodnewscodes@gmail.com';

  if (!publicKey || !privateKey) {
    console.warn('[WebPush] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — web push disabled');
    return;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidInitialized = true;
  console.log('[WebPush] VAPID initialized ✓');
};

/** Returns the raw VAPID public key string (for the client subscription call). */
export const getVapidPublicKey = (): string | null =>
  process.env.VAPID_PUBLIC_KEY || null;

/** True once initWebPush() has successfully configured credentials. */
export const isWebPushReady = (): boolean => vapidInitialized;

export interface WebPushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  /** Data passed to the service worker notificationclick handler. */
  data?: Record<string, any>;
  /** Keep notification visible until the user interacts (ideal for calls). */
  requireInteraction?: boolean;
  /** Vibration pattern in ms [on, off, on, …]. */
  vibrate?: number[];
  /** Action buttons shown on the notification. */
  actions?: Array<{ action: string; title: string; icon?: string }>;
}

/**
 * Send a single Web Push notification to a subscription stored as a JSON string.
 *
 * @throws `'SUBSCRIPTION_EXPIRED'` when the endpoint returns 404 or 410 —
 *   the caller should delete the stored token.
 */
export const sendWebPushNotification = async (
  subscriptionJson: string,
  payload: WebPushPayload
): Promise<void> => {
  if (!vapidInitialized) return;

  let subscription: webpush.PushSubscription;
  try {
    subscription = JSON.parse(subscriptionJson);
  } catch {
    console.error('[WebPush] Malformed subscription JSON — skipping');
    return;
  }

  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (err: any) {
    // 404 / 410 = subscription no longer valid; surface so caller can prune DB.
    if (err?.statusCode === 410 || err?.statusCode === 404) {
      throw new Error('SUBSCRIPTION_EXPIRED');
    }
    throw err;
  }
};
