import { useEffect, useRef } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { authStorage } from '../../lib/authStorage';
import { joinRoomByLink } from '../../lib/callManager';

/**
 * Deep-link landing for a signed call invite: bubblechat://call/join?room=&t=&type=
 * Authenticated users join the room (GlobalCallOverlay then renders the LiveKit call);
 * unauthenticated users are routed to login. Guest/account-less join is out of scope.
 */
export default function CallJoinScreen() {
  const { room, t, type } = useLocalSearchParams<{ room?: string; t?: string; type?: string }>();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    (async () => {
      const token = await authStorage.getAccessToken();
      if (!token) {
        router.replace('/login');
        return;
      }
      if (!room) {
        router.replace('/(main)/calls');
        return;
      }
      await joinRoomByLink({
        roomId: String(room),
        type: type === 'voice' ? 'voice' : 'video',
        joinToken: t ? String(t) : undefined,
      });
      // The overlay (mounted in the root layout) now shows the active call.
      router.replace('/(main)/calls');
    })();
  }, [room, t, type]);

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color="#6c5ce7" />
      <Text style={styles.label}>Joining call…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#ffffff', gap: 16 },
  label: { color: '#6b6f86', fontSize: 15 },
});
