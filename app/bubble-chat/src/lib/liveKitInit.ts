import Constants from 'expo-constants';

let registered = false;

/**
 * LiveKit needs the native WebRTC module, which only exists in a custom dev client
 * or a release build — never in Expo Go. Calling registerGlobals() there throws.
 * We register once, lazily, and treat Expo Go as "calling disabled".
 */
export const isLiveKitAvailable = (): boolean => {
  if (Constants.appOwnership === 'expo') return false;
  try {
    require('@livekit/react-native-webrtc');
    return true;
  } catch {
    return false;
  }
};

export const ensureLiveKitRegistered = (): boolean => {
  if (registered) return true;
  if (!isLiveKitAvailable()) return false;
  try {
    const { registerGlobals } = require('@livekit/react-native');
    registerGlobals();
    registered = true;
    return true;
  } catch (e) {
    console.warn('[LiveKit] registerGlobals failed:', e);
    return false;
  }
};
