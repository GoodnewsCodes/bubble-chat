import React, { useEffect, useState, useRef } from "react";
import { Stack } from "expo-router";
import { useFonts } from "expo-font";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ClerkProvider } from "@clerk/clerk-expo";
import * as SecureStore from "expo-secure-store";

const clerkTokenCache = {
  async getToken(key: string) {
    try { return await SecureStore.getItemAsync(key); } catch { return null; }
  },
  async saveToken(key: string, value: string) {
    try { await SecureStore.setItemAsync(key, value); } catch {}
  },
  async clearToken(key: string) {
    try { await SecureStore.deleteItemAsync(key); } catch {}
  },
};
import { Poppins_400Regular, Poppins_500Medium, Poppins_600SemiBold, Poppins_700Bold } from "@expo-google-fonts/poppins";
import { SpaceGrotesk_700Bold } from "@expo-google-fonts/space-grotesk";
import * as SplashScreen from "expo-splash-screen";
import Constants from 'expo-constants';
import { verifyInstallation } from "nativewind";
import "../global.css";
import { initApiFromStorage, getSecureMediaUrl } from "../lib/api";
import { View, Text, TouchableOpacity, Modal, StyleSheet, ScrollView, Share, PanResponder, Dimensions, Alert, Animated } from "react-native";
import { Image } from "expo-image";
import { Phone, PhoneOff, Mic, MicOff, Volume2, Video, VideoOff, Minimize2, Maximize2, UserPlus, Link2, X, Monitor, MonitorOff } from "lucide-react-native";
import { CameraView, Camera } from "expo-camera";
import { BlurView } from "expo-blur";
import { subscribeCallState, acceptIncomingCall, declineIncomingCall, hangUpCall, inviteToCall, getLinkJoinToken, CallState, getPersistedCall, clearPersistedCall, rejoinPersistedCall } from "../lib/callManager";
import { authStorage } from "../lib/authStorage";
import { fetchActiveMeetings } from "../lib/api";
import { registerForPushNotificationsAsync } from "../lib/pushNotifications";
import { ThemeProvider } from "../lib/theme";
import { getLiveKitToken, createCallInviteLink } from "../lib/api";
import { chatCache } from "../lib/chatCache";
import { ensureLiveKitRegistered } from "../lib/liveKitInit";
import type { LiveKitCallRoomProps } from "../components/liveKitCall";

// LiveKit pulls in native WebRTC, which doesn't exist in Expo Go. Register once at
// module load (no-ops in Expo Go) and only require the call component when available,
// so importing this layout never crashes the Expo Go client.
const liveKitReady = ensureLiveKitRegistered();
let LiveKitCallRoom: React.ComponentType<LiveKitCallRoomProps> | null = null;
if (liveKitReady) {
  try {
    LiveKitCallRoom = require("../components/liveKitCall").default;
  } catch (e) {
    console.warn("[LiveKit] failed to load call component:", e);
  }
}

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync().catch(() => {});

// Call UI palette (light theme)
const WHITE = '#ffffff';
const INK = '#13141f';
const INK_SOFT = '#6b6f86';
const PURPLE = '#6c5ce7';
const PURPLE_SOFT = '#f1eefe';
const SURFACE = '#f5f4fb';
const BORDER = '#ece9f7';
const GREEN = '#10b981';
const RED = '#ef4444';
const PILL_W = 142;
const PILL_H = 184;

function GlobalCallOverlay() {
  const [callState, setCallState] = useState<CallState>({ status: 'idle' });
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeaker, setIsSpeaker] = useState(false);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  // Host end-call sheet (Save / Email / Both / Neither) — mirrors the web modal.
  const [showEndSheet, setShowEndSheet] = useState(false);
  // Local user's display name — stamped on this client's in-call chat + reactions.
  const [myName, setMyName] = useState('You');
  useEffect(() => {
    authStorage.getUser().then((u) => {
      if (u) {
        setMyName(u.full_name || u.username || 'You');
        // E2EE bootstrap: ensure a device keypair exists and the server holds
        // our public key (replaces any legacy server-generated PEM key).
        import('../lib/e2ee')
          .then(({ bootstrapE2EE }) => bootstrapE2EE(u.publicKey))
          .catch((err) => console.warn('[e2ee] bootstrap failed:', err));
      }
    }).catch(() => {});
  }, []);

  const handleScreenShareError = (err: Error) => {
    setIsScreenSharing(false);
    Alert.alert('Screen share unavailable', "This build doesn't support screen sharing yet. Try a video call instead.");
    console.warn('[LiveKit] screen share failed:', err);
  };

  // Pulsing ring animation around the avatar during incoming and outgoing calls.
  const ringPulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const isRinging = callState.status === 'calling_in' || callState.status === 'calling_out';
    if (isRinging) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(ringPulse, { toValue: 1, duration: 900, useNativeDriver: true }),
          Animated.timing(ringPulse, { toValue: 0, duration: 900, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
    ringPulse.setValue(0);
  }, [callState.status, ringPulse]);
  const [lkToken, setLkToken] = useState<string | null>(null);
  const [lkUrl, setLkUrl] = useState<string | null>(null);

  // Draggable floating pill position when minimized — clamped to the screen.
  const [pillPos, setPillPos] = useState(() => {
    const { width, height } = Dimensions.get('window');
    return { x: width - PILL_W - 16, y: height - PILL_H - 96 };
  });
  const dragOrigin = useRef({ x: 0, y: 0 });
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4,
      onPanResponderGrant: () => { dragOrigin.current = { ...pillPos }; },
      onPanResponderMove: (_, g) => {
        const { width, height } = Dimensions.get('window');
        const nx = Math.max(8, Math.min(width - PILL_W - 8, dragOrigin.current.x + g.dx));
        const ny = Math.max(40, Math.min(height - PILL_H - 8, dragOrigin.current.y + g.dy));
        setPillPos({ x: nx, y: ny });
      },
    })
  ).current;

  // Add-people / invite sheet
  const [showAddPeople, setShowAddPeople] = useState(false);
  const [contacts, setContacts] = useState<any[]>([]);
  const [invitedIds, setInvitedIds] = useState<string[]>([]);

  const openAddPeople = async () => {
    setShowAddPeople(true);
    if (contacts.length) return;
    try {
      const list = await chatCache.getCachedContacts();
      setContacts(Array.isArray(list) ? list : []);
    } catch {
      /* non-fatal: the share-link path still works */
    }
  };

  const handleInvite = (c: any) => {
    const cid = c.id || c._id || c.otherUserId;
    if (!cid) return;
    inviteToCall(c);
    setInvitedIds((prev) => (prev.includes(cid) ? prev : [...prev, cid]));
  };

  const handleShareLink = async () => {
    if (callState.status !== 'in_call') return;
    try {
      const { url } = await createCallInviteLink(callState.roomId);
      await Share.share({ message: `Join my Bubble call: ${url}`, url });
    } catch {
      /* user dismissed or link failed */
    }
  };

  useEffect(() => {
    const unsubscribe = subscribeCallState((state) => {
      setCallState(state);
      if (state.status === 'calling_out' || state.status === 'calling_in') {
        setIsMuted(false);
        setIsSpeaker(false);
        setIsCameraActive(state.type === 'video');
        setIsMinimized(false);
        setIsScreenSharing(false);
      }
      if (state.status === 'idle') {
        setLkToken(null);
        setLkUrl(null);
        setIsScreenSharing(false);
      }
    });
    return () => {
      unsubscribe();
      // Root layout is going away (logout/teardown): drop the call socket
      // listeners this module registered so nothing keeps firing into dead UI.
      import('../lib/socket').then(({ getSocket }) => {
        const sock = getSocket();
        if (sock) {
          import('../lib/callManager').then(m => m.teardownCallSocketListeners(sock));
        }
      }).catch(() => undefined);
    };
  }, []);

  // Fetch a LiveKit token once the call is connected. The component renders only
  // in a dev/release build (LiveKitCallRoom is null in Expo Go), so the avatar UI
  // remains the fallback everywhere else.
  useEffect(() => {
    if (!LiveKitCallRoom) return;
    if (callState.status !== 'in_call') return;
    if (lkToken) return;
    let cancelled = false;
    getLiveKitToken(callState.roomId, getLinkJoinToken() || undefined)
      .then((res: { token?: string; url?: string }) => {
        if (cancelled) return;
        if (res?.token && res?.url) {
          setLkToken(res.token);
          setLkUrl(res.url);
        } else {
          console.warn('[LiveKit] token endpoint returned no token/url');
        }
      })
      .catch((err) => console.warn('[LiveKit] token fetch failed:', err));
    return () => { cancelled = true; };
  }, [callState.status, (callState as any).roomId, lkToken]);

  useEffect(() => {
    if (callState.status === 'in_call' && isCameraActive && hasPermission === null) {
      Camera.requestCameraPermissionsAsync().then(({ status }) => {
        setHasPermission(status === 'granted');
      });
    }
  }, [callState.status, isCameraActive]);

  if (callState.status === 'idle') return null;

  const isIncoming = callState.status === 'calling_in';
  const isOutgoing = callState.status === 'calling_out';
  const isVideo = callState.type === 'video';

  const confirmHangUp = () => {
    if (callState.status !== 'in_call') {
      hangUpCall();
      return;
    }
    // Host with a saved meeting record → offer the transcript save/email options.
    if (callState.meetingDbId && callState.isHost) {
      setShowEndSheet(true);
      return;
    }
    // Non-host / no record → plain leave.
    Alert.alert(
      'End Call',
      'Are you sure you want to end this call?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'End Call', style: 'destructive', onPress: () => hangUpCall() },
      ]
    );
  };

  const endWith = (saveToStorage: boolean, sendEmail: boolean) => {
    setShowEndSheet(false);
    hangUpCall({ saveToStorage, sendEmail });
  };

  const formatDuration = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const secs = sec % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getGroupInitials = (n: string) => {
    if (!n) return 'BC';
    const clean = n.trim().replace(/\s+/g, ' ');
    const parts = clean.split(' ');
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return clean.slice(0, 2).toUpperCase();
  };

  const getAvatarUri = () => {
    if (callState.status === 'calling_out') {
      return getSecureMediaUrl(callState.user?.avatar || callState.user?.groupIcon);
    }
    if (callState.status === 'calling_in') {
      return getSecureMediaUrl(callState.callerAvatar);
    }
    if (callState.status === 'in_call') {
      return getSecureMediaUrl(callState.user?.avatar || callState.user?.groupIcon);
    }
    return null;
  };

  const getName = () => {
    if (callState.status === 'calling_out') {
      return callState.user?.name || callState.user?.full_name || callState.user?.chatName || 'Bubble User';
    }
    if (callState.status === 'calling_in') {
      return callState.callerName || 'Bubble User';
    }
    if (callState.status === 'in_call') {
      return callState.user?.name || callState.user?.full_name || callState.user?.chatName || 'Bubble User';
    }
    return 'Bubble User';
  };

  const name = getName();
  const avatarUri = getAvatarUri();

  const statusLabel = isOutgoing
    ? 'Calling…'
    : isIncoming
      ? `Incoming ${isVideo ? 'video' : 'voice'} call`
      : `Connected · ${formatDuration((callState as any).duration)}`;

  const renderAvatar = (size: number) => (
    avatarUri ? (
      <Image source={{ uri: avatarUri || undefined }} style={{ width: size, height: size, borderRadius: size / 2 }} />
    ) : (
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: PURPLE, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#ffffff', fontSize: size * 0.32, fontFamily: 'SpaceGrotesk_700Bold' }}>{getGroupInitials(name)}</Text>
      </View>
    )
  );

  // ── Incoming ringer ─────────────────────────────────────────────────────────
  // A dedicated "liquid glass" card (blurred, dimmed backdrop) shown ONLY while an
  // incoming call is ringing — matches the design: rounded-square avatar, caller
  // name, "INCOMING <TYPE> CALL…" label, and red-decline / green-accept circles.
  if (isIncoming) {
    return (
      <View style={styles.ringerRoot}>
        <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={styles.ringerDim} pointerEvents="none" />
        <View style={styles.ringerCardWrap}>
          <BlurView intensity={70} tint="light" style={StyleSheet.absoluteFill} />
          <View style={styles.ringerCardInner}>
            {/* Pulsing halo behind the avatar */}
            <Animated.View
              pointerEvents="none"
              style={{
                position: 'absolute', top: 0, width: 180, height: 180, borderRadius: 44,
                backgroundColor: 'rgba(108,92,231,0.18)',
                opacity: ringPulse.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.6] }),
                transform: [{ scale: ringPulse.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.08] }) }],
              }}
            />
            <View style={styles.ringerAvatarFrame}>
              {avatarUri ? (
                <Image source={{ uri: avatarUri || undefined }} style={styles.ringerAvatarImg} />
              ) : (
                <View style={[styles.ringerAvatarImg, styles.ringerAvatarFallback]}>
                  <Text style={styles.ringerAvatarInitials}>{getGroupInitials(name)}</Text>
                </View>
              )}
            </View>

            <Text style={styles.ringerName} numberOfLines={1}>{name}</Text>
            <Text style={styles.ringerSub}>INCOMING {isVideo ? 'VIDEO' : 'VOICE'} CALL…</Text>

            <View style={styles.ringerButtonsRow}>
              <TouchableOpacity onPress={() => declineIncomingCall()} style={[styles.ringerBtn, styles.ringerDecline]} activeOpacity={0.85}>
                <PhoneOff color="#ffffff" size={28} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => acceptIncomingCall()} style={[styles.ringerBtn, styles.ringerAccept]} activeOpacity={0.85}>
                {isVideo ? <Video color="#ffffff" size={28} /> : <Phone color="#ffffff" size={28} />}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>
    );
  }

  // Single unified tree for both full-screen and minimized states. The media slot
  // holding <LiveKitCallRoom> always renders at the same JSX position regardless of
  // isMinimized — only its wrapping style changes — so React never unmounts the
  // LiveKitRoom connection when the user minimizes/restores. (Previously this used
  // two separate `return` branches — a Modal for full screen, a plain View for mini —
  // which silently dropped the live call on minimize since LiveKitCallRoom only
  // existed inside the Modal branch.) A plain absolutely-positioned root (not a RN
  // Modal) is used so the minimized pill can float over the rest of the app while
  // still letting touches reach screens underneath it.
  return (
    <View
      style={[styles.callContainer, isMinimized && [styles.minimizedContainer, { left: pillPos.x, top: pillPos.y }]]}
      pointerEvents={isMinimized ? 'box-none' : 'auto'}
    >
      {/* Minimize / Maximize toggle (not while an incoming call is ringing) */}
      {!isIncoming && (
        isMinimized ? (
          <View style={styles.miniHeader}>
            <TouchableOpacity onPress={() => setIsMinimized(false)} style={styles.miniOptionButton}>
              <Maximize2 color={PURPLE} size={16} />
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity onPress={() => setIsMinimized(true)} style={styles.minimizeButton}>
            <Minimize2 color="rgba(255,255,255,0.55)" size={18} />
          </TouchableOpacity>
        )
      )}

      {/* Full-mode header */}
      {!isMinimized && (
        <View style={styles.callHeader}>
          <Text style={styles.callTypeTitle}>
            BUBBLE {isVideo ? 'VIDEO CALL' : 'VOICE CALL'}
          </Text>
          <Text style={styles.callerNameText} numberOfLines={2}>{name}</Text>
          <Text style={styles.statusText}>{statusLabel}</Text>
        </View>
      )}

      {/* Mini-mode name/timer — doubles as the drag handle for repositioning the pill */}
      {isMinimized && (
        <View {...panResponder.panHandlers} style={{ alignItems: 'center', width: '100%', marginTop: 4 }}>
          <Text numberOfLines={1} style={styles.miniNameText}>{name}</Text>
          <Text style={styles.miniDurationText}>
            {callState.status === 'in_call' ? formatDuration(callState.duration) : 'Calling…'}
          </Text>
        </View>
      )}

      {/* Media / Video Stream area — stable slot, see note above */}
      <View style={isMinimized ? styles.miniMediaSlot : styles.mediaContainer}>
        {callState.status === 'in_call' && LiveKitCallRoom && lkToken && lkUrl ? (
          <View style={isVideo ? (isMinimized ? styles.miniVideoFrame : styles.videoPreviewFrame) : (isMinimized ? styles.miniAvatarRing : styles.avatarOuterRing)}>
            <LiveKitCallRoom
              serverUrl={lkUrl}
              token={lkToken}
              isVideo={isVideo}
              micEnabled={!isMuted}
              cameraEnabled={isCameraActive}
              speakerEnabled={isSpeaker}
              screenShareEnabled={isScreenSharing}
              onScreenShareError={handleScreenShareError}
              roomId={(callState as any).roomId}
              userName={myName}
              fallback={renderAvatar(isMinimized ? 46 : 156)}
              onError={(err) => console.warn('[LiveKit] room error:', err)}
              onDisconnected={() => {
                // When the LiveKit room ends (peer left, network drop, or normal
                // hangup) reset the call state so the user can place/receive another
                // call. Without this the overlay stayed stuck in 'in_call' and every
                // subsequent call was blocked.
                hangUpCall();
              }}
            />
          </View>
        ) : callState.status === 'in_call' && isCameraActive && hasPermission && !isMinimized ? (
          <View style={styles.videoPreviewFrame}>
            <CameraView style={StyleSheet.absoluteFill} facing="front" />
            <View style={styles.remoteVideoPreviewOverlay}>
              {avatarUri ? (
                <Image source={{ uri: avatarUri || undefined }} style={styles.remoteAvatarImage} />
              ) : (
                <View style={styles.remoteInitialsPlaceholder}>
                  <Text style={styles.remoteInitialsText}>{getGroupInitials(name)}</Text>
                </View>
              )}
              <Text style={styles.remoteLabel}>You</Text>
            </View>
          </View>
        ) : isMinimized ? (
          renderAvatar(46)
        ) : (
          <View style={{ alignItems: 'center', justifyContent: 'center' }}>
            {/* Pulsing outer glow ring — visible when ringing */}
            {(isIncoming || isOutgoing) && (
              <Animated.View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  width: 260, height: 260, borderRadius: 130,
                  backgroundColor: isIncoming ? 'rgba(16,185,129,0.12)' : 'rgba(108,92,231,0.12)',
                  opacity: ringPulse.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0.7] }),
                  transform: [{ scale: ringPulse.interpolate({ inputRange: [0, 1], outputRange: [0.88, 1.1] }) }],
                }}
              />
            )}
            <View style={[styles.avatarOuterRing, isIncoming && styles.avatarOuterRingIncoming]}>
              <View style={styles.avatarInnerRing}>
                <View style={styles.avatarPlaceholderContainer}>
                  {renderAvatar(156)}
                </View>
              </View>
            </View>
          </View>
        )}
      </View>

      {/* Add-people sheet (full mode only) */}
      {!isMinimized && (
        <Modal visible={showAddPeople} transparent animationType="slide" onRequestClose={() => setShowAddPeople(false)}>
          <View style={styles.sheetBackdrop}>
            <View style={styles.sheetCard}>
              <View style={styles.sheetHeader}>
                <Text style={styles.sheetTitle}>Add people</Text>
                <TouchableOpacity onPress={() => setShowAddPeople(false)} style={styles.sheetClose}>
                  <X color={INK_SOFT} size={20} />
                </TouchableOpacity>
              </View>

              <TouchableOpacity onPress={handleShareLink} style={styles.shareLinkBtn}>
                <Link2 color={PURPLE} size={18} />
                <Text style={styles.shareLinkText}>Share invite link</Text>
              </TouchableOpacity>

              <Text style={styles.sheetSection}>RING A CONTACT</Text>
              <ScrollView style={{ maxHeight: 320 }}>
                {contacts.length === 0 ? (
                  <Text style={styles.sheetEmpty}>No contacts to ring</Text>
                ) : (
                  contacts.map((c: any) => {
                    const cid = c.id || c._id || c.otherUserId;
                    const invited = invitedIds.includes(cid);
                    const cname = c.full_name || c.name || c.username || 'Contact';
                    const avatarUrl = c.avatar ? getSecureMediaUrl(c.avatar) : null;
                    return (
                      <TouchableOpacity key={cid} disabled={invited} onPress={() => handleInvite(c)} style={styles.contactRow}>
                        {avatarUrl ? (
                          <Image source={{ uri: avatarUrl }} style={styles.contactAvatar} />
                        ) : (
                          <View style={[styles.contactAvatar, styles.contactAvatarFallback]}>
                            <Text style={styles.contactInitials}>{getGroupInitials(cname)}</Text>
                          </View>
                        )}
                        <Text style={styles.contactName} numberOfLines={1}>{cname}</Text>
                        <Text style={[styles.contactAction, invited && { color: INK_SOFT }]}>{invited ? 'Ringing…' : 'Invite'}</Text>
                      </TouchableOpacity>
                    );
                  })
                )}
              </ScrollView>
            </View>
          </View>
        </Modal>
      )}

      {/* Host end-call sheet — save transcript to storage and/or email attendees */}
      {!isMinimized && (
        <Modal visible={showEndSheet} transparent animationType="fade" onRequestClose={() => setShowEndSheet(false)}>
          <View style={styles.endBackdrop}>
            <View style={styles.endCard}>
              <Text style={styles.endTitle}>Save meeting transcript?</Text>
              <Text style={styles.endSubtitle}>
                Keep the transcript in your Storage Center, email it to attendees, or both.
              </Text>

              <TouchableOpacity style={[styles.endBtn, styles.endBtnPrimary]} onPress={() => endWith(true, false)}>
                <Text style={styles.endBtnPrimaryText}>Save in Storage Center</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.endBtn, styles.endBtnSoft]} onPress={() => endWith(false, true)}>
                <Text style={styles.endBtnSoftText}>Send via Email Only</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.endBtn, styles.endBtnGreen]} onPress={() => endWith(true, true)}>
                <Text style={styles.endBtnPrimaryText}>Save & Email Attendees</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.endBtn, styles.endBtnGhost]} onPress={() => endWith(false, false)}>
                <Text style={styles.endBtnGhostText}>Neither (Discard transcript)</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.endCancel} onPress={() => setShowEndSheet(false)}>
                <Text style={styles.endCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}

      {/* Call Actions */}
      {isMinimized ? (
        <View style={styles.miniButtonsRow}>
          <TouchableOpacity
            onPress={() => setIsMuted(!isMuted)}
            style={[styles.miniOptionsButton, isMuted && styles.activeMiniOptionsButton]}
          >
            {isMuted ? <MicOff color="#ffffff" size={14} /> : <Mic color={INK_SOFT} size={14} />}
          </TouchableOpacity>

          <TouchableOpacity
            onPress={confirmHangUp}
            style={[styles.miniOptionsButton, { backgroundColor: RED }]}
          >
            <PhoneOff color="#ffffff" size={14} />
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.actionsContainer}>
          {isIncoming ? (
            <View style={styles.incomingButtonsRow}>
              {/* Decline */}
              <View style={styles.incomingActionGroup}>
                <TouchableOpacity
                  onPress={() => declineIncomingCall()}
                  style={[styles.actionButton, styles.declineButton]}
                >
                  <PhoneOff color="#ffffff" size={26} />
                </TouchableOpacity>
                <Text style={styles.actionLabel}>Decline</Text>
              </View>

              {/* Accept */}
              <View style={styles.incomingActionGroup}>
                <TouchableOpacity
                  onPress={() => acceptIncomingCall()}
                  style={[styles.actionButton, styles.acceptButton]}
                >
                  {isVideo ? <Video color="#ffffff" size={26} /> : <Phone color="#ffffff" size={26} />}
                </TouchableOpacity>
                <Text style={styles.actionLabel}>Accept</Text>
              </View>
            </View>
          ) : (
            <View style={styles.glassActionPanel}>
              <View style={styles.buttonsRow}>
                {/* Mute Toggle */}
                <TouchableOpacity
                  onPress={() => setIsMuted(!isMuted)}
                  style={[styles.optionsButton, isMuted && styles.activeOptionsButton]}
                >
                  {isMuted ? <MicOff color="#ffffff" size={20} /> : <Mic color="rgba(255,255,255,0.8)" size={20} />}
                </TouchableOpacity>

                {/* End Call */}
                <TouchableOpacity
                  onPress={confirmHangUp}
                  style={[styles.actionButton, styles.declineButton]}
                >
                  <PhoneOff color="#ffffff" size={24} />
                </TouchableOpacity>

                {/* Speaker Toggle */}
                <TouchableOpacity
                  onPress={() => setIsSpeaker(!isSpeaker)}
                  style={[styles.optionsButton, isSpeaker && styles.activeOptionsButton]}
                >
                  <Volume2 color="#ffffff" size={20} />
                </TouchableOpacity>

                {/* Video Toggle (only in active calls) */}
                {callState.status === 'in_call' && (
                  <TouchableOpacity
                    onPress={() => setIsCameraActive(!isCameraActive)}
                    style={[styles.optionsButton, isCameraActive && styles.activeOptionsButton]}
                  >
                    {isCameraActive ? <Video color="#ffffff" size={20} /> : <VideoOff color="rgba(255,255,255,0.8)" size={20} />}
                  </TouchableOpacity>
                )}

                {/* Screen share (only in active calls; gracefully no-ops if the
                    build lacks native screen-capture support — see handleScreenShareError) */}
                {callState.status === 'in_call' && (
                  <TouchableOpacity
                    onPress={() => setIsScreenSharing(!isScreenSharing)}
                    style={[styles.optionsButton, isScreenSharing && styles.activeOptionsButton]}
                  >
                    {isScreenSharing ? <Monitor color="#ffffff" size={20} /> : <MonitorOff color="rgba(255,255,255,0.8)" size={20} />}
                  </TouchableOpacity>
                )}

                {/* Add people (only in active calls) */}
                {callState.status === 'in_call' && (
                  <TouchableOpacity
                    onPress={openAddPeople}
                    style={styles.optionsButton}
                  >
                    <UserPlus color="rgba(255,255,255,0.8)" size={20} />
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

async function checkAndTriggerAutoBackup() {
  try {
    const isAutoBackupEnabled = await AsyncStorage.getItem("bubble_auto_backup");
    if (isAutoBackupEnabled === "false") return;

    const now = new Date();
    if (now.getHours() === 2) {
      const todayStr = now.toDateString();
      const lastBackupDate = await AsyncStorage.getItem("bubble_last_auto_backup_date");
      if (lastBackupDate === todayStr) return;

      console.log("Auto-backup starting at 2:00 AM...");
      const { chatCache } = await import("../lib/chatCache");
      const success = await chatCache.performCloudBackup();
      if (success) {
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const dateStr = now.toLocaleDateString([], { month: 'short', day: 'numeric' });
        const fullTime = `${dateStr} at ${timeStr}`;
        await AsyncStorage.multiSet([
          ["bubble_last_auto_backup_date", todayStr],
          ["bubble_last_backup_time", fullTime]
        ]);
        console.log("Auto-backup successfully completed at 2:00 AM!");
      }
    }
  } catch (err) {
    console.warn("Failed in checkAndTriggerAutoBackup:", err);
  }
}

// Cold-start rejoin: if the app was killed mid-call and that meeting is still live,
// offer a pill to jump back in. Hidden while already in a call or once the room ends.
function RejoinBanner() {
  const [pending, setPending] = useState<{ roomId: string; type: 'voice' | 'video' } | null>(null);
  const [inCall, setInCall] = useState(false);

  useEffect(() => subscribeCallState((s) => setInCall(s.status !== 'idle')), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const persisted = await getPersistedCall();
      if (!persisted?.roomId) return;
      try {
        const res = await fetchActiveMeetings();
        const rooms = res?.rooms || [];
        const stillLive = rooms.some((r: any) => String(r?.roomId) === String(persisted.roomId));
        if (cancelled) return;
        if (stillLive) setPending(persisted);
        else await clearPersistedCall(); // meeting ended while we were away
      } catch { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!pending || inCall) return null;

  return (
    <View style={rejoinStyles.wrap} pointerEvents="box-none">
      <View style={rejoinStyles.pill}>
        <View style={rejoinStyles.dot} />
        <Text style={rejoinStyles.label} numberOfLines={1}>Meeting in progress</Text>
        <TouchableOpacity
          style={rejoinStyles.btn}
          onPress={() => { const p = pending; setPending(null); if (p) rejoinPersistedCall(p); }}
        >
          <Text style={rejoinStyles.btnText}>Rejoin</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={rejoinStyles.dismiss}
          onPress={() => { setPending(null); clearPersistedCall(); }}
        >
          <X size={16} color={INK_SOFT} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const rejoinStyles = StyleSheet.create({
  wrap: { position: 'absolute', top: 54, left: 0, right: 0, alignItems: 'center', zIndex: 50 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: WHITE, borderRadius: 999, paddingVertical: 8, paddingLeft: 14, paddingRight: 8,
    borderWidth: 1, borderColor: BORDER,
    shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 8,
  },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: GREEN },
  label: { fontFamily: 'Poppins_600SemiBold', fontSize: 13, color: INK, maxWidth: 160 },
  btn: { backgroundColor: PURPLE, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 14 },
  btnText: { color: WHITE, fontFamily: 'Poppins_700Bold', fontSize: 12 },
  dismiss: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
});

export default function RootLayout() {
  verifyInstallation();
  const [loaded, error] = useFonts({
    Poppins_400Regular,
    Poppins_500Medium,
    Poppins_600SemiBold,
    Poppins_700Bold,
    SpaceGrotesk_700Bold,
  });

  useEffect(() => {
    // Pre-load stored token into in-memory cache for synchronous getAuthHeaders()
    initApiFromStorage().then(() => {
      const { chatCache } = require("../lib/chatCache");
      chatCache.initAvatarCache().then(() => {
        chatCache.syncAvatarsWithBackend().catch(() => {});
      });
    }).catch(() => {});

    // Configure Google Sign-In
    const isExpoGo = Constants.appOwnership === 'expo';
    if (!isExpoGo) {
      try {
        const { GoogleSignin } = require("@react-native-google-signin/google-signin");
        if (process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID) {
          GoogleSignin.configure({
            webClientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
            offlineAccess: true,
          });
        } else {
          console.warn("⚠️ EXPO_PUBLIC_GOOGLE_CLIENT_ID is not configured. Google Sign-In may fail.");
        }
      } catch (e) {
        console.log("Google Sign-In native module is not available.");
      }
    } else {
      console.log("Running in Expo Go. Google Sign-In native module is disabled. Using Web fallback.");
    }
    
    // Check auto backup status on launch and schedule every 15 minutes
    checkAndTriggerAutoBackup();
    const interval = setInterval(checkAndTriggerAutoBackup, 15 * 60 * 1000);

    // Register Push Notifications on launch
    registerForPushNotificationsAsync().catch((err) => {
      console.warn("Failed to register push notifications on mount:", err);
    });

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [loaded, error]);

  if (!loaded && !error) {
    return null;
  }

  const clerkKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const inner = (
    <ThemeProvider>
      <Stack screenOptions={{ headerShown: false }} />
      <RejoinBanner />
      <GlobalCallOverlay />
    </ThemeProvider>
  );
  return clerkKey ? (
    <ClerkProvider publishableKey={clerkKey} tokenCache={clerkTokenCache}>
      {inner}
    </ClerkProvider>
  ) : inner;
}

const styles = StyleSheet.create({
  minimizedContainer: {
    // top/left are set inline from draggable `pillPos` state.
    position: 'absolute',
    width: PILL_W,
    height: PILL_H,
    backgroundColor: WHITE,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: BORDER,
    // paddingVertical/paddingHorizontal (not `padding`) so this wins over
    // callContainer's paddingVertical:72/paddingHorizontal:24 at matching specificity
    // when both styles are merged for the minimized pill.
    paddingVertical: 10,
    paddingHorizontal: 10,
    shadowColor: '#6c5ce7',
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
    zIndex: 9999,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  miniMediaSlot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniVideoFrame: {
    width: 64,
    height: 64,
    borderRadius: 16,
    backgroundColor: '#0b0b12',
    overflow: 'hidden',
  },
  miniAvatarRing: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  miniHeader: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  miniOptionButton: {
    padding: 4,
  },
  miniNameText: {
    fontSize: 12,
    fontFamily: 'Poppins_600SemiBold',
    color: INK,
    textAlign: 'center',
    width: 110,
    marginTop: 6,
  },
  miniDurationText: {
    fontSize: 10,
    fontFamily: 'Poppins_400Regular',
    color: INK_SOFT,
    marginTop: 2,
  },
  miniButtonsRow: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  miniOptionsButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: SURFACE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeMiniOptionsButton: {
    backgroundColor: PURPLE,
  },
  callContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9999,
    elevation: 24,
    backgroundColor: '#0f1018',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 72,
    paddingHorizontal: 24,
  },
  // ── Incoming "liquid glass" ringer ──
  ringerRoot: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 9999, elevation: 24,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 22,
  },
  ringerDim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(20,18,30,0.35)' },
  ringerCardWrap: {
    width: '100%', maxWidth: 420,
    borderRadius: 34, overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)',
    backgroundColor: 'rgba(255,255,255,0.14)',
    shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 30, shadowOffset: { width: 0, height: 18 },
    elevation: 18,
  },
  ringerCardInner: { alignItems: 'center', paddingTop: 34, paddingBottom: 30, paddingHorizontal: 24 },
  ringerAvatarFrame: {
    width: 150, height: 150, borderRadius: 40, overflow: 'hidden',
    borderWidth: 3, borderColor: 'rgba(255,255,255,0.65)',
    backgroundColor: PURPLE,
    shadowColor: PURPLE, shadowOpacity: 0.4, shadowRadius: 18, shadowOffset: { width: 0, height: 8 },
  },
  ringerAvatarImg: { width: '100%', height: '100%' },
  ringerAvatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: PURPLE },
  ringerAvatarInitials: { color: '#fff', fontSize: 48, fontFamily: 'SpaceGrotesk_700Bold' },
  ringerName: { marginTop: 22, color: '#ffffff', fontSize: 26, fontFamily: 'SpaceGrotesk_700Bold', textAlign: 'center' },
  ringerSub: { marginTop: 8, color: 'rgba(255,255,255,0.82)', fontSize: 13, letterSpacing: 2, fontFamily: 'Poppins_700Bold' },
  ringerButtonsRow: { flexDirection: 'row', gap: 44, marginTop: 30 },
  ringerBtn: {
    width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 6 }, elevation: 8,
  },
  ringerDecline: { backgroundColor: RED },
  ringerAccept: { backgroundColor: GREEN },
  minimizeButton: {
    position: 'absolute',
    top: 54,
    right: 24,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  callHeader: {
    alignItems: 'center',
    marginTop: 28,
  },
  callTypeTitle: {
    color: 'rgba(108,92,231,0.85)',
    fontSize: 11,
    fontFamily: 'Poppins_700Bold',
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  callerNameText: {
    color: WHITE,
    fontSize: 30,
    fontFamily: 'SpaceGrotesk_700Bold',
    marginTop: 4,
    textAlign: 'center',
  },
  statusText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 14,
    fontFamily: 'Poppins_600SemiBold',
    marginTop: 8,
  },
  mediaContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 32,
    width: '100%',
  },
  avatarOuterRing: {
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: 'rgba(108, 92, 231, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(108, 92, 231, 0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarOuterRingIncoming: {
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderColor: 'rgba(16, 185, 129, 0.28)',
  },
  avatarInnerRing: {
    width: 190,
    height: 190,
    borderRadius: 95,
    backgroundColor: 'rgba(108, 92, 231, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(108, 92, 231, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarPlaceholderContainer: {
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#6c5ce7',
    shadowOpacity: 0.4,
    shadowRadius: 24,
    elevation: 8,
  },
  videoPreviewFrame: {
    width: 280,
    height: 400,
    borderRadius: 32,
    backgroundColor: '#0b0b12',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: BORDER,
    position: 'relative',
  },
  remoteVideoPreviewOverlay: {
    position: 'absolute',
    bottom: 16,
    right: 16,
    width: 80,
    height: 110,
    borderRadius: 16,
    backgroundColor: WHITE,
    borderWidth: 1,
    borderColor: BORDER,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 6,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 2,
  },
  remoteAvatarImage: {
    width: 52,
    height: 52,
    borderRadius: 12,
  },
  remoteInitialsPlaceholder: {
    width: 52,
    height: 52,
    borderRadius: 12,
    backgroundColor: PURPLE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  remoteInitialsText: {
    color: '#ffffff',
    fontSize: 16,
    fontFamily: 'SpaceGrotesk_700Bold',
  },
  remoteLabel: {
    fontSize: 9,
    fontFamily: 'Poppins_700Bold',
    color: INK_SOFT,
    marginTop: 4,
    textTransform: 'uppercase',
  },
  actionsContainer: {
    width: '100%',
    alignItems: 'center',
    marginBottom: 20,
  },
  incomingButtonsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    width: '100%',
  },
  incomingActionGroup: {
    alignItems: 'center',
    gap: 10,
  },
  actionLabel: {
    fontSize: 13,
    fontFamily: 'Poppins_600SemiBold',
    color: 'rgba(255,255,255,0.6)',
  },
  glassActionPanel: {
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 32,
    paddingVertical: 14,
    paddingHorizontal: 24,
    width: '90%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
  },
  actionButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
  },
  declineButton: {
    backgroundColor: RED,
  },
  acceptButton: {
    backgroundColor: GREEN,
  },
  optionsButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeOptionsButton: {
    backgroundColor: PURPLE,
    borderColor: PURPLE,
  },

  // Add-people sheet
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheetCard: {
    backgroundColor: WHITE,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 32,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sheetTitle: {
    fontSize: 17,
    fontFamily: 'Poppins_700Bold',
    color: INK,
  },
  sheetClose: {
    padding: 4,
  },
  shareLinkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: PURPLE_SOFT,
    borderRadius: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },
  shareLinkText: {
    color: PURPLE,
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 13,
  },
  sheetSection: {
    fontSize: 10,
    fontFamily: 'Poppins_700Bold',
    color: INK_SOFT,
    letterSpacing: 1,
    marginBottom: 6,
  },
  sheetEmpty: {
    color: INK_SOFT,
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 24,
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  contactAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  contactAvatarFallback: {
    backgroundColor: PURPLE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactInitials: {
    color: WHITE,
    fontFamily: 'SpaceGrotesk_700Bold',
    fontSize: 14,
  },
  contactName: {
    flex: 1,
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 14,
    color: INK,
  },
  contactAction: {
    fontFamily: 'Poppins_700Bold',
    fontSize: 12,
    color: PURPLE,
  },

  // End-call sheet
  endBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  endCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: WHITE,
    borderRadius: 28,
    padding: 24,
    alignItems: 'stretch',
  },
  endTitle: {
    fontSize: 19,
    fontFamily: 'Poppins_700Bold',
    color: INK,
    textAlign: 'center',
  },
  endSubtitle: {
    fontSize: 13,
    fontFamily: 'Poppins_400Regular',
    color: INK_SOFT,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 18,
    lineHeight: 19,
  },
  endBtn: {
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
    marginBottom: 10,
  },
  endBtnPrimary: { backgroundColor: PURPLE },
  endBtnPrimaryText: { color: WHITE, fontFamily: 'Poppins_700Bold', fontSize: 14 },
  endBtnSoft: { backgroundColor: PURPLE_SOFT },
  endBtnSoftText: { color: PURPLE, fontFamily: 'Poppins_700Bold', fontSize: 14 },
  endBtnGreen: { backgroundColor: GREEN },
  endBtnGhost: { backgroundColor: SURFACE },
  endBtnGhostText: { color: INK_SOFT, fontFamily: 'Poppins_700Bold', fontSize: 14 },
  endCancel: { alignItems: 'center', paddingVertical: 8, marginTop: 2 },
  endCancelText: { color: INK_SOFT, fontFamily: 'Poppins_600SemiBold', fontSize: 13 },
});
