// Thin "no connection" strip shown at the top of the main screens while the
// device is offline — WhatsApp's "waiting for network" affordance. Cache still
// renders underneath; this just tells the user why data isn't refreshing.

import React, { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { CloudOff } from 'lucide-react-native';
import { isOnline, subscribeNetwork, startNetworkMonitor } from '../lib/network';
import { useTheme } from '../lib/theme';

export function OfflineBanner() {
  const { colors } = useTheme();
  const [offline, setOffline] = useState(!isOnline());

  useEffect(() => {
    startNetworkMonitor();
    setOffline(!isOnline());
    return subscribeNetwork((online) => setOffline(!online));
  }, []);

  if (!offline) return null;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        paddingVertical: 6,
        paddingHorizontal: 12,
        backgroundColor: colors.isDark ? 'rgba(248,113,113,0.16)' : 'rgba(239,68,68,0.10)',
      }}
    >
      <CloudOff size={13} color={colors.danger} />
      <Text
        style={{
          color: colors.danger,
          fontSize: 11.5,
          fontFamily: 'Poppins_600SemiBold',
        }}
      >
        No internet connection · showing saved data
      </Text>
    </View>
  );
}
