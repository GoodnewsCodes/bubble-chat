import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { authStorage } from '../lib/authStorage';

export default function Index() {
  const router = useRouter();

  useEffect(() => {
    async function checkAuth() {
      try {
        const valid = await authStorage.isSessionValid();
        if (valid) {
          const user = await authStorage.getUser();
          if (user?.onboardingComplete) {
            router.replace('/(main)/messages' as any);
          } else {
            router.replace('/profile-setup' as any);
          }
        } else {
          await authStorage.clearSession();
          const seen = await authStorage.hasSeenOnboarding();
          if (seen) {
            router.replace('/login' as any);
          } else {
            router.replace('/splash' as any);
          }
        }
      } catch {
        const seen = await authStorage.hasSeenOnboarding();
        if (seen) {
          router.replace('/login' as any);
        } else {
          router.replace('/splash' as any);
        }
      }
    }
    checkAuth();
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: '#f5f4ff', alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator size="large" color="#6c5ce7" />
    </View>
  );
}
