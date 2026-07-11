import React, { useState, useEffect } from 'react';
import { View, Text, Image, StyleSheet, ImageStyle, TextStyle, ViewStyle } from 'react-native';
import { getSecureMediaUrl } from '../lib/api';
import { chatCache } from '../lib/chatCache';

interface AvatarProps {
  url?: string | null;
  avatar?: string | null;
  userId?: string | null;
  name?: string | null;
  size?: number;
  isGroup?: boolean;
  style?: any;
  imageStyle?: any;
  textStyle?: any;
}

const MATURE_COLORS = [
  '#708090', // Slate Grey
  '#191970', // Midnight Blue
  '#36454F', // Charcoal
  '#01796F', // Pine Green
  '#4B0082', // Indigo
  '#4E2A5A', // Royal Plum
  '#800020', // Burgundy
];

const getFallbackColor = (name: string, isGroup?: boolean): string => {
  if (isGroup) return '#000000';
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % MATURE_COLORS.length;
  return MATURE_COLORS[index];
};

const getInitials = (name: string, isGroup?: boolean): string => {
  const clean = name.trim();
  if (!clean) return '?';
  if (isGroup) {
    return clean.slice(0, 2).toUpperCase();
  }
  const parts = clean.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return parts[0][0].toUpperCase();
};

export const Avatar: React.FC<AvatarProps> = ({
  url,
  avatar,
  userId,
  name,
  size = 40,
  isGroup = false,
  style,
  imageStyle,
  textStyle,
}) => {
  const [imgError, setImgError] = useState(false);
  const displayName = name || 'User';
  // Prefer the locally cached base64 (keyed by userId, then by URL) so avatars
  // render instantly and keep working with no network. Fall back to the secure
  // (proxied/signed) URL only when nothing is cached.
  const rawSrc = url || avatar;
  // 'black' / '#000000' are placeholder sentinels (e.g. a group with no uploaded
  // icon); treat them as "no image" so we render the initials tile directly
  // instead of firing a doomed image request.
  const isPlaceholderSrc = rawSrc === 'black' || rawSrc === '#000000';
  const cachedBase64 = isPlaceholderSrc
    ? null
    : chatCache.getCachedAvatar(userId) || chatCache.getCachedAvatar(rawSrc);
  const resolvedUrl = isPlaceholderSrc ? null : (cachedBase64 || getSecureMediaUrl(rawSrc));

  // Reset error state if the source changes
  useEffect(() => {
    setImgError(false);
  }, [url, avatar, userId]);

  const initials = getInitials(displayName, isGroup);
  const backgroundColor = getFallbackColor(displayName, isGroup);

  if (resolvedUrl && !imgError) {
    return (
      <Image
        source={{ uri: resolvedUrl }}
        style={[
          styles.avatar,
          { width: size, height: size, borderRadius: size / 2 },
          imageStyle,
          style,
        ]}
        onError={() => {
          console.log('[Avatar] image failed to load', { userId, rawSrc, resolvedUrl });
          setImgError(true);
        }}
      />
    );
  }

  // Initials fallback
  const fontSize = size * 0.4;
  return (
    <View
      style={[
        styles.fallbackContainer,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor,
        },
        style,
      ]}
    >
      <Text
        style={[
          styles.fallbackText,
          { fontSize, lineHeight: fontSize * 1.2 },
          textStyle,
        ]}
        numberOfLines={1}
      >
        {initials}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  avatar: {
    backgroundColor: '#e1e2e6',
  },
  fallbackContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  fallbackText: {
    color: '#ffffff',
    fontFamily: 'System',
    fontWeight: '700',
  },
});
