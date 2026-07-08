import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { registerPushToken } from './api';

// Configure how notifications should behave when they are received while the app is in the foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    // `shouldShowAlert` was deprecated in SDK 53 in favor of the two flags below —
    // keeping it made every foreground banner log a deprecation warning.
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function registerForPushNotificationsAsync(): Promise<string | null> {
  let token: string | null = null;

  if (Platform.OS === 'web') {
    return null;
  }

  // Graceful simulator fallback
  if (!Device.isDevice) {
    console.log('[Push] Running in simulator/emulator, skipping push registration');
    return null;
  }

  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.log('[Push] Notification permissions not granted!');
      return null;
    }

    // EAS Project ID is required for push token resolution in EAS builds
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;

    const tokenObj = await Notifications.getExpoPushTokenAsync({
      projectId,
    });
    token = tokenObj.data;
    console.log('[Push] Expo Push Token obtained:', token);

    // Call API helper to register token to backend
    if (token) {
      await registerPushToken(token, Platform.OS);
    }
  } catch (error) {
    console.error('[Push] Error registering push notifications:', error);
  }

  if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF231F7C',
    });
  }

  return token;
}

const DAILY_BRIEF_KEY = 'daily_brief_notified_on';

/**
 * Surface the morning/daily brief as a local notification — once per calendar
 * day — mirroring the web behaviour of presenting the brief when it's ready.
 * Safe to call repeatedly; it self-throttles via AsyncStorage.
 */
export async function notifyDailyBrief(brief: string): Promise<void> {
  try {
    if (!brief || Platform.OS === 'web') return;

    // Respect "Pause all push notifications" and the daily-digest opt-out.
    try {
      const { authStorage } = await import('./authStorage');
      const me: any = await authStorage.getUser();
      if (me?.notification_settings?.muted === true) return;
      if (me?.digestPreferences?.enabled === false) return;
    } catch { /* prefs unavailable — default to showing */ }

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const last = await AsyncStorage.getItem(DAILY_BRIEF_KEY);
    if (last === today) return; // already shown today

    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      if (req.status !== 'granted') return;
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title: '☀️ Your Morning Brief',
        body: brief.length > 180 ? `${brief.slice(0, 177)}…` : brief,
        data: { type: 'daily_brief' },
      },
      trigger: null, // present immediately
    });
    await AsyncStorage.setItem(DAILY_BRIEF_KEY, today);
  } catch (err) {
    console.warn('[Push] notifyDailyBrief failed:', err);
  }
}
