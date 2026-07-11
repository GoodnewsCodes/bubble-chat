import { Tabs, Redirect } from "expo-router";
import { MessageSquare, User, Users, Plus, Share2 } from "lucide-react-native";
import React, { useState, useEffect, useRef } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Animated } from "react-native";
import { BlurView } from "expo-blur";
import { triggerPlusButton } from "../../lib/mockData";
import { useTheme } from "../../lib/theme";
import { NicknameProvider } from "../../lib/nicknames";
import { fetchActiveMeetings, getUnreadChatCount } from "../../lib/api";
import { getSocket } from "../../lib/socket";
import { setInMeetingUsers, setViewerVisibility } from "../../lib/presence";
import { subscribeCallState, CallState } from "../../lib/callManager";
import { authStorage } from "../../lib/authStorage";

function CustomTabBar({ state, descriptors, navigation }: any) {
  // The tab bar follows the app theme: light blur surface in light mode, dark
  // blur surface in dark mode (confirmed on-device — a pinned-light bar looked
  // broken against dark screens).
  const { colors, isDark } = useTheme();
  const currentRouteName = state.routes[state.index].name;
  const [activeRoomCount, setActiveRoomCount] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetchActiveMeetings();
        const rooms = res?.rooms || [];
        if (!cancelled) setActiveRoomCount(rooms.length);
        // Feed the "in a meeting" registry: every host + attendee of a live room.
        const ids: (string | null)[] = [];
        for (const r of rooms) {
          const host = r?.host;
          ids.push(typeof host === 'string' ? host : (host?._id || host?.id || null));
          for (const a of (r?.attendees || [])) {
            ids.push(typeof a === 'string' ? a : (a?._id || a?.id || null));
          }
        }
        setInMeetingUsers(ids);
      } catch { /* best-effort */ }
    };
    poll();
    intervalRef.current = setInterval(poll, 30_000);

    const socket = getSocket();
    const refresh = () => poll();
    socket?.on('meeting_room_update', refresh);
    socket?.on('meeting_ended', refresh);

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      socket?.off('meeting_room_update', refresh);
      socket?.off('meeting_ended', refresh);
    };
  }, []);

  // ── WhatsApp-style tab counters ──────────────────────────────────────────
  // Chats: authoritative total-unread number, kept live via socket events.
  // Updates: an unseen-activity dot that clears once the Updates tab is opened.
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [unseenUpdates, setUnseenUpdates] = useState(0);
  const unreadThrottle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refreshUnread = async () => {
      try {
        const res: any = await getUnreadChatCount();
        const count = Math.max(0, Number(res?.count ?? res?.data?.count ?? 0) || 0);
        if (!cancelled) setUnreadTotal(count);
      } catch { /* best-effort */ }
    };
    // Throttle bursts (many new_message/unread events in quick succession).
    const bumpUnread = () => {
      if (unreadThrottle.current) return;
      unreadThrottle.current = setTimeout(() => { unreadThrottle.current = null; refreshUnread(); }, 600);
    };
    refreshUnread();
    const socket = getSocket();
    const onUpdates = () => setUnseenUpdates(n => (currentRouteName === 'updates' ? 0 : n + 1));
    socket?.on('new_message', bumpUnread);
    socket?.on('receive_message', bumpUnread);
    socket?.on('unread_count_updated', bumpUnread);
    socket?.on('messages_read', bumpUnread);
    socket?.on('new_chat', bumpUnread);
    socket?.on('connect', refreshUnread);
    socket?.on('updates_changed', onUpdates);
    return () => {
      cancelled = true;
      if (unreadThrottle.current) { clearTimeout(unreadThrottle.current); unreadThrottle.current = null; }
      socket?.off('new_message', bumpUnread);
      socket?.off('receive_message', bumpUnread);
      socket?.off('unread_count_updated', bumpUnread);
      socket?.off('messages_read', bumpUnread);
      socket?.off('new_chat', bumpUnread);
      socket?.off('connect', refreshUnread);
      socket?.off('updates_changed', onUpdates);
    };
  }, []);
  // Opening the Chats or Updates tab clears that tab's indicator.
  useEffect(() => {
    if (currentRouteName === 'updates') setUnseenUpdates(0);
    if (currentRouteName === 'messages') {
      // Re-pull shortly after landing on Chats so the number reflects reads.
      const t = setTimeout(() => {
        getUnreadChatCount().then((res: any) => {
          setUnreadTotal(Math.max(0, Number(res?.count ?? res?.data?.count ?? 0) || 0));
        }).catch(() => {});
      }, 800);
      return () => clearTimeout(t);
    }
  }, [currentRouteName]);

  // Glow the People icon while a call is ringing / in progress, so an active call
  // reads at a glance from anywhere in the app.
  const [callActive, setCallActive] = useState(false);
  const callPulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const unsub = subscribeCallState((s: CallState) => {
      setCallActive(s.status === 'calling_out' || s.status === 'calling_in' || s.status === 'in_call');
    });
    return unsub;
  }, []);
  useEffect(() => {
    if (callActive) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(callPulse, { toValue: 1, duration: 700, useNativeDriver: true }),
          Animated.timing(callPulse, { toValue: 0, duration: 700, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
    callPulse.setValue(0);
  }, [callActive, callPulse]);

  if (currentRouteName === "chat/[id]") {
    return null;
  }

  return (
    <View style={styles.tabBarWrapper}>
      {/* Full-width native blur panel behind the tabs — adapts to the theme */}
      <BlurView intensity={75} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: isDark ? 'rgba(15, 16, 24, 0.82)' : 'rgba(248, 247, 255, 0.78)' }]} />

      {/* Row containing capsule tabs and FAB */}
      <View style={styles.container}>
        {/* Pill Container for the Main Tabs */}
        <View style={[styles.pillContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {state.routes.map((route: any, index: number) => {
            if (route.name === "calls" || route.name === "chat/[id]" || route.name === "brain" || route.name === "calendar") return null;

            const { options } = descriptors[route.key];
            const label =
              options.tabBarLabel !== undefined
                ? options.tabBarLabel
                : options.title !== undefined
                ? options.title
                : route.name;

            const isFocused = state.index === index;

            const onPress = () => {
              const event = navigation.emit({
                type: "tabPress",
                target: route.key,
                canPreventDefault: true,
              });

              if (!isFocused && !event.defaultPrevented) {
                navigation.navigate(route.name);
              }
            };

            // Icon and Label Mapping
            let displayName = label;
            let iconComponent = null;
            const iconSize = 20;
            const activeColor = colors.purple;
            const inactiveColor = colors.textSoft;
            const color = isFocused ? activeColor : inactiveColor;

            if (route.name === "messages") {
              displayName = "Chats";
              iconComponent = (
                <View style={{ position: 'relative' }}>
                  <MessageSquare color={color} size={iconSize} />
                  {unreadTotal > 0 && (
                    <View style={{
                      position: 'absolute', top: -7, right: -10, minWidth: 16, height: 16,
                      paddingHorizontal: 3, borderRadius: 8, backgroundColor: '#f4663b',
                      alignItems: 'center', justifyContent: 'center',
                      borderWidth: 1.5, borderColor: isDark ? 'rgba(15,16,24,0.82)' : 'rgba(248,247,255,0.78)',
                    }}>
                      <Text style={{ color: '#fff', fontSize: 9, fontFamily: 'Poppins_700Bold', lineHeight: 12 }}>
                        {unreadTotal > 99 ? '99+' : unreadTotal}
                      </Text>
                    </View>
                  )}
                </View>
              );
            } else if (route.name === "people") {
              displayName = "People";
              iconComponent = (
                <View style={{ position: 'relative' }}>
                  {/* Pulsing glow ring behind the icon while a call is active. */}
                  {callActive && (
                    <Animated.View
                      pointerEvents="none"
                      style={{
                        position: 'absolute', top: -6, left: -6, right: -6, bottom: -6,
                        borderRadius: 999, backgroundColor: colors.purple,
                        opacity: callPulse.interpolate({ inputRange: [0, 1], outputRange: [0.12, 0.4] }),
                        transform: [{ scale: callPulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.25] }) }],
                      }}
                    />
                  )}
                  <Users color={callActive ? colors.purple : color} size={iconSize} />
                  {(activeRoomCount > 0 || callActive) && (
                    <View style={{
                      position: 'absolute', top: -3, right: -5,
                      width: 8, height: 8, borderRadius: 4,
                      backgroundColor: callActive ? colors.purple : '#10b981',
                      borderWidth: 1.5, borderColor: isDark ? 'rgba(15,16,24,0.82)' : 'rgba(248,247,255,0.78)',
                    }} />
                  )}
                </View>
              );
            } else if (route.name === "updates") {
              displayName = "Updates";
              iconComponent = (
                <View style={{ position: 'relative' }}>
                  <Share2 color={color} size={iconSize} />
                  {unseenUpdates > 0 && (
                    <View style={{
                      position: 'absolute', top: -7, right: -10, minWidth: 16, height: 16,
                      paddingHorizontal: 3, borderRadius: 8, backgroundColor: '#f4663b',
                      alignItems: 'center', justifyContent: 'center',
                      borderWidth: 1.5, borderColor: isDark ? 'rgba(15,16,24,0.82)' : 'rgba(248,247,255,0.78)',
                    }}>
                      <Text style={{ color: '#fff', fontSize: 9, fontFamily: 'Poppins_700Bold', lineHeight: 12 }}>
                        {unseenUpdates > 99 ? '99+' : unseenUpdates}
                      </Text>
                    </View>
                  )}
                </View>
              );
            } else if (route.name === "profile") {
              displayName = "Profile";
              iconComponent = <User color={color} size={iconSize} />;
            }

            return (
              <TouchableOpacity
                key={route.key}
                onPress={onPress}
                style={styles.tabItem}
                activeOpacity={0.75}
              >
                {iconComponent}
                <Text
                  style={[
                    styles.tabLabel,
                    {
                      color,
                      fontFamily: isFocused ? "Poppins_600SemiBold" : "Poppins_500Medium",
                    },
                  ]}
                >
                  {displayName}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Floating Action Button (FAB) on the Right */}
        <TouchableOpacity
          style={[styles.fab, { backgroundColor: colors.card, borderColor: colors.border }]}
          activeOpacity={0.8}
          onPress={() => {
            triggerPlusButton(); // Triggers the popup modal in messages.tsx
          }}
        >
          <Plus color={colors.text} size={24} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function TabsLayout() {
  // Re-guard the authenticated area. index.tsx routes here on a valid session, but a
  // deep link / notification tap can target a (main) route directly — without this
  // check an unauthenticated or onboarding-incomplete user would land in the tabs.
  // On failure we bounce to '/' (index.tsx) which owns the canonical splash/login/
  // profile-setup routing, so we don't duplicate that logic here.
  const [gate, setGate] = useState<'checking' | 'ok' | 'redirect'>('checking');

  // Seed viewer reciprocity flags from the stored user so presence/read-receipt
  // gating reflects my own privacy settings from the first render.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const valid = await authStorage.isSessionValid();
        if (!valid) { if (active) setGate('redirect'); return; }
        const u: any = await authStorage.getUser();
        if (u) {
          setViewerVisibility({
            showOnline: u.privacy_settings?.show_online_status !== false,
            readReceipts: u.privacy_settings?.read_receipts !== false,
          });
        }
        if (active) setGate(u?.onboardingComplete ? 'ok' : 'redirect');
      } catch {
        if (active) setGate('redirect');
      }
    })();
    return () => { active = false; };
  }, []);

  if (gate === 'redirect') return <Redirect href={"/" as any} />;
  if (gate === 'checking') return null;

  return (
    <NicknameProvider>
      <Tabs
        tabBar={(props) => <CustomTabBar {...props} />}
        screenOptions={{
          headerShown: false,
        }}
      >
        <Tabs.Screen
          name="messages"
          options={{
            title: "Chats",
          }}
        />
        <Tabs.Screen
          name="people"
          options={{
            title: "People",
          }}
        />
        <Tabs.Screen
          name="updates"
          options={{
            title: "Updates",
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: "Profile",
          }}
        />
        <Tabs.Screen
          name="brain"
          options={{
            href: null,
          }}
        />
        <Tabs.Screen
          name="calendar"
          options={{
            href: null,
          }}
        />
        <Tabs.Screen
          name="calls"
          options={{
            href: null,
          }}
        />
        <Tabs.Screen
          name="chat/[id]"
          options={{
            href: null,
          }}
        />
      </Tabs>
    </NicknameProvider>
  );
}

const styles = StyleSheet.create({
  tabBarWrapper: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 105,
    overflow: "hidden",
    justifyContent: "center",
    alignItems: "center",
  },
  container: {
    width: "100%",
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "transparent",
  },
  pillContainer: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: "#ffffff",
    borderRadius: 32,
    paddingVertical: 12,
    paddingHorizontal: 8,
    marginRight: 12,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
    borderWidth: 1,
    borderColor: "rgba(108,92,231,0.05)",
  },
  tabItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  tabLabel: {
    fontSize: 10,
    marginTop: 4,
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
    borderWidth: 1,
    borderColor: "rgba(108,92,231,0.05)",
  },
});
