import React, { useEffect, useState, useRef } from 'react';
import { View, Text, StyleSheet, Platform, Modal, TouchableOpacity, TextInput, ScrollView, KeyboardAvoidingView, Animated, Image } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { LiveKitRoom, VideoTrack, AudioSession } from '@livekit/react-native';
import {
  useTracks,
  useLocalParticipant,
  useParticipants,
  isTrackReference,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { MessageSquare, Users, FileText, X, Send, Smile, Paperclip, Mic, MicOff } from 'lucide-react-native';
import { getSocket } from '../lib/socket';
import { uploadGroupOrOrgImage, getSecureMediaUrl, addMeetingTranscriptChunk } from '../lib/api';
import { LiveTranscriber, isTranscriptionAvailable } from '../lib/liveTranscription';

// In-call chat message — mirrors web LiveKitMeetingModal's ChatMessageEntry so a
// web↔mobile call shares the same `meeting_chat_message` socket shape.
interface ChatMsg { speaker: string; text: string; imageUrl?: string; time: string; mine?: boolean }

const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '👏', '🔥'];
const nowTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Headless bridge: keeps the LiveKit local participant's mic/camera/screen-share in
 * sync with the overlay's toggle state. Lives inside <LiveKitRoom> so it can use the
 * room context.
 */
function LocalDeviceBridge({
  micEnabled,
  cameraEnabled,
  screenShareEnabled,
  onScreenShareError,
}: {
  micEnabled: boolean;
  cameraEnabled: boolean;
  screenShareEnabled?: boolean;
  onScreenShareError?: (err: Error) => void;
}) {
  const { localParticipant } = useLocalParticipant();

  useEffect(() => {
    localParticipant?.setMicrophoneEnabled(micEnabled).catch(() => {});
  }, [micEnabled, localParticipant]);

  useEffect(() => {
    localParticipant?.setCameraEnabled(cameraEnabled).catch(() => {});
  }, [cameraEnabled, localParticipant]);

  // Screen share needs native MediaProjection (Android) / a broadcast extension (iOS)
  // wired into the dev/release build — neither is guaranteed present, so any failure
  // here is reported back to the overlay instead of thrown, which resets the toggle
  // and shows an "unsupported" message rather than crashing the call.
  useEffect(() => {
    if (!localParticipant) return;
    if (!screenShareEnabled) {
      localParticipant.setScreenShareEnabled(false).catch(() => {});
      return;
    }
    localParticipant.setScreenShareEnabled(true).catch((err: Error) => {
      onScreenShareError?.(err);
    });
  }, [screenShareEnabled, localParticipant, onScreenShareError]);

  return null;
}

const initialsOf = (n?: string) => {
  const clean = (n || 'BC').trim().replace(/\s+/g, ' ');
  const parts = clean.split(' ');
  return (parts.length >= 2 ? parts[0][0] + parts[1][0] : clean.slice(0, 2)).toUpperCase();
};

/** Small avatar/initials placeholder for a participant in a video tile. */
function ParticipantAvatar({ name, avatar, size }: { name?: string; avatar?: string; size: number }) {
  const uri = getSecureMediaUrl(avatar);
  // A stale/expired signed URL was rendering a broken image with no fallback —
  // track load failure and drop back to initials, same as the shared Avatar.
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [uri]);

  if (uri && !failed) {
    return (
      <Image
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#6c5ce7', alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontSize: size * 0.36, fontFamily: 'Poppins_700Bold' }}>{initialsOf(name)}</Text>
    </View>
  );
}

/** Pull a participant's avatar out of their LiveKit metadata (set at token time). */
const participantAvatar = (p: any): string | undefined => {
  try {
    if (p?.metadata) {
      const meta = JSON.parse(p.metadata);
      if (meta?.avatar) return meta.avatar;
    }
  } catch { /* metadata is not JSON */ }
  return undefined;
};

/**
 * Headless bridge: reports the live participant roster (name/avatar/isLocal) up
 * to the parent overlay so UI OUTSIDE <LiveKitRoom> (the call header's avatar
 * cluster + participant count) can render it.
 */
function ParticipantsBridge({ onChanged }: { onChanged?: (list: { name?: string; avatar?: string; isLocal: boolean }[]) => void }) {
  const participants = useParticipants();
  useEffect(() => {
    onChanged?.(participants.map((p) => ({
      name: p?.name || p?.identity,
      avatar: participantAvatar(p),
      isLocal: !!p?.isLocal,
    })));
  }, [participants, onChanged]);
  return null;
}

/**
 * Voice-call "Audio Conference" stage — mirrors the WEB LiveKitMeetingModal's
 * light design: a large lavender main-stage card for the active speaker (purple
 * ring while speaking, "Camera Muted"/mic state line) and a row of light
 * participant tiles below (avatar, name, mic badge). Lives inside <LiveKitRoom>.
 */
function AudioConferenceArea() {
  const participants = useParticipants();

  // Active speaker wins the main stage; otherwise the first remote, otherwise self.
  const speaking = participants.find((p) => p.isSpeaking);
  const firstRemote = participants.find((p) => !p.isLocal);
  const main = speaking || firstRemote || participants[0];
  const others = participants.filter((p) => p !== main);

  const Tile = ({ p, size }: { p: any; size: number }) => {
    const micOn = p?.isMicrophoneEnabled;
    return (
      <View style={[styles.audioTile, p?.isSpeaking && styles.audioTileSpeaking]}>
        <ParticipantAvatar name={p?.name} avatar={participantAvatar(p)} size={size} />
        <Text numberOfLines={1} style={styles.audioTileName}>
          {p?.name || 'Participant'}{p?.isLocal ? ' (You)' : ''}
        </Text>
        <View style={[styles.audioMicBadge, { backgroundColor: micOn ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)' }]}>
          {micOn ? <Mic size={12} color="#22c55e" /> : <MicOff size={12} color="#ef4444" />}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.audioStage}>
      {/* Main active-speaker card — the web's rounded lavender stage */}
      <View style={[styles.audioMainCard, main?.isSpeaking && styles.audioMainCardSpeaking]}>
        <View style={styles.audioMainAvatarFrame}>
          <ParticipantAvatar name={main?.name} avatar={participantAvatar(main)} size={120} />
        </View>
        <Text numberOfLines={1} style={styles.audioMainName}>
          {main?.name || 'Participant'}{main?.isLocal ? ' (You)' : ''}
        </Text>
        <View style={styles.audioMainMicRow}>
          {main?.isCameraEnabled === false && (
            <>
              <MicOff size={13} color="#ef4444" />
              <Text style={[styles.audioMainMicText, { color: '#9a9aab' }]}>Camera Muted</Text>
            </>
          )}
          {main?.isCameraEnabled !== false && (
            main?.isMicrophoneEnabled
              ? <><Mic size={13} color="#22c55e" /><Text style={styles.audioMainMicText}>Speaking</Text></>
              : <><MicOff size={13} color="#ef4444" /><Text style={[styles.audioMainMicText, { color: '#ef4444' }]}>Muted</Text></>
          )}
        </View>
      </View>

      {/* Participant tile row */}
      {others.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.audioRow}>
          {others.map((p, i) => <Tile key={p?.sid || p?.identity || i} p={p} size={54} />)}
        </ScrollView>
      )}
    </View>
  );
}

/**
 * Renders the main video stage (screen-share, else the first remote, else local) with
 * the local camera as a picture-in-picture tile, plus a horizontally-scrolling row of
 * thumbnails for every other participant — matching the web meeting modal's main-stage
 * + thumbnail-row layout so group video shows everyone. Active speakers are highlighted.
 */
function VideoArea({ isVideo, fallback }: { isVideo: boolean; fallback: React.ReactNode }) {
  const cameraTracks = useTracks([Track.Source.Camera], { onlySubscribed: false }).filter((t) => isTrackReference(t));
  const screenTracks = useTracks([Track.Source.ScreenShare], { onlySubscribed: false }).filter((t) => isTrackReference(t));

  const screenShare = screenTracks[0];
  const firstRemote = cameraTracks.find((t) => t.participant && !t.participant.isLocal);
  const local = cameraTracks.find((t) => t.participant?.isLocal);

  // Main stage: a screen-share wins, then the first remote camera, then local.
  const main = screenShare || firstRemote || local;
  // Thumbnails: every other participant camera track except the one on the main stage
  // and the local PiP (local is always shown as PiP, never a thumbnail).
  const thumbs = cameraTracks.filter((t) => t !== main && !t.participant?.isLocal);

  const Thumbnails = thumbs.length > 0 ? (
    <View style={styles.thumbRowWrap} pointerEvents="none">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbRow}>
        {thumbs.map((t, i) => {
          const p = t.participant;
          const speaking = p?.isSpeaking;
          const camOn = p?.isCameraEnabled;
          return (
            <View key={p?.sid || p?.identity || i} style={[styles.thumbTile, speaking && styles.thumbTileSpeaking]}>
              {camOn ? (
                <VideoTrack trackRef={t as any} style={styles.fill} objectFit="cover" zOrder={1} />
              ) : (
                <View style={styles.thumbFallback}>
                  <ParticipantAvatar name={p?.name} avatar={participantAvatar(p)} size={30} />
                </View>
              )}
              <View style={styles.thumbLabel} pointerEvents="none">
                <Text numberOfLines={1} style={styles.thumbLabelText}>{p?.name || 'Guest'}</Text>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  ) : null;

  if (screenShare) {
    const sharerIsLocal = screenShare.participant?.isLocal;
    return (
      <View style={styles.fill}>
        <VideoTrack trackRef={screenShare as any} style={styles.fill} objectFit="contain" zOrder={0} />
        <View style={styles.screenShareBadge} pointerEvents="none">
          <Text style={styles.screenShareBadgeText}>
            {sharerIsLocal ? "You're presenting" : `${screenShare.participant?.name || 'Someone'} is presenting`}
          </Text>
        </View>
        {local && (
          <View style={styles.pip} pointerEvents="none">
            <VideoTrack trackRef={local as any} style={styles.fill} objectFit="cover" mirror zOrder={1} />
          </View>
        )}
        {Thumbnails}
      </View>
    );
  }

  // Audio→video upgrade: a voice call stays on the audio-conference stage only
  // until SOMEONE turns a camera on. The moment any camera track is live (local
  // toggled their camera, or a peer did), switch everyone to the video grid — so
  // flipping the camera mid-voice-call actually shows video instead of silently
  // publishing a track no one sees.
  const anyCameraLive = cameraTracks.some((t) => t.participant?.isCameraEnabled);
  if (!isVideo && !anyCameraLive) {
    // Voice call: show the multi-participant audio-conference stage. `fallback`
    // (single avatar) is retained only for the brief pre-connect moment handled
    // by the parent overlay, not here.
    return <AudioConferenceArea />;
  }

  const mainIsLocal = main?.participant?.isLocal;
  return (
    <View style={styles.fill}>
      {main ? (
        <VideoTrack trackRef={main as any} style={styles.fill} objectFit="cover" mirror={mainIsLocal} zOrder={0} />
      ) : (
        <View style={styles.fillCenter}>{fallback}</View>
      )}
      {/* Local PiP only when the local camera isn't already the main stage. */}
      {local && !mainIsLocal && (
        <View style={styles.pip} pointerEvents="none">
          <VideoTrack trackRef={local as any} style={styles.fill} objectFit="cover" mirror zOrder={1} />
        </View>
      )}
      {Thumbnails}
    </View>
  );
}

/**
 * A single reaction emoji that floats up and fades out, then removes itself.
 * Mirrors the web meeting modal's floating-emoji animation.
 */
function FloatingEmoji({ emoji, left, onDone }: { emoji: string; left: number; onDone: () => void }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: 1, duration: 2000, useNativeDriver: true }).start(() => onDone());
  }, [anim, onDone]);
  return (
    <Animated.Text
      pointerEvents="none"
      style={{
        position: 'absolute', bottom: 24, left, fontSize: 34,
        opacity: anim.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 1, 0] }),
        transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [0, -160] }) }, { scale: anim.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0.5, 1.2, 0.8] }) }],
      }}
    >
      {emoji}
    </Animated.Text>
  );
}

/**
 * Floating-reaction layer over the video. Listens for `meeting_reaction` from peers
 * (same event the web modal uses) and renders each as an upward-floating emoji.
 */
function ReactionsLayer({ roomId, register }: { roomId?: string; register: (fn: (emoji: string) => void) => void }) {
  const [items, setItems] = useState<{ id: string; emoji: string; left: number }[]>([]);
  const spawn = React.useCallback((emoji: string) => {
    const id = Math.random().toString(36).slice(2);
    const left = 20 + Math.random() * 140;
    setItems((prev) => [...prev, { id, emoji, left }]);
  }, []);

  useEffect(() => { register(spawn); }, [register, spawn]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onReaction = (data: any) => {
      if (roomId && data?.roomId && String(data.roomId) !== String(roomId)) return;
      spawn(data?.emoji || '👍');
    };
    socket.on('meeting_reaction', onReaction);
    return () => { socket.off('meeting_reaction', onReaction); };
  }, [roomId, spawn]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {items.map((it) => (
        <FloatingEmoji key={it.id} emoji={it.emoji} left={it.left} onDone={() => setItems((prev) => prev.filter((x) => x.id !== it.id))} />
      ))}
    </View>
  );
}

type PanelTab = 'people' | 'chat' | 'transcript';

/**
 * In-call panel matching web: a People / Chat / Transcript popup opened from a
 * floating button over the video. Lives inside <LiveKitRoom> so it can use the
 * participant hooks. Chat + transcript + reactions all ride the same Socket.io
 * events the web meeting modal uses (`meeting_chat_message`,
 * `meeting_transcript_chunk`, `meeting_reaction`) so web↔mobile calls interoperate.
 */
function CallPanel({ roomId, userName, userId, meetingDbId, onReact, registerControls, hideFabs }: {
  roomId?: string;
  userName: string;
  /** Local user id — stamped on transcript chunks for speaker attribution. */
  userId?: string;
  /** Meeting DB id — lets each speaker persist their own transcript chunks. */
  meetingDbId?: string | null;
  onReact: (emoji: string) => void;
  /** Lets the parent overlay's control tray open the chat panel / emoji bar
   *  (so the floating FABs can be hidden in favor of the web-style tray). */
  registerControls?: (c: { openChat: () => void; toggleEmoji: () => void }) => void;
  hideFabs?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PanelTab>('chat');
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [transcript, setTranscript] = useState<{ speaker?: string; text: string; time: string }[]>([]);
  const [unread, setUnread] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const participants = useParticipants();
  const scrollRef = useRef<ScrollView>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const scrollSoon = () => setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);

  // Incoming chat messages (text + shared images) from peers over the socket.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onMessage = (data: any) => {
      if (roomId && data?.roomId && String(data.roomId) !== String(roomId)) return;
      // Ignore the echo of our own message — we already appended it locally on send.
      if (data?.speaker && data.speaker === userName) return;
      setMessages(prev => [...prev, { speaker: data?.speaker || 'Guest', text: data?.text || '', imageUrl: data?.imageUrl, time: nowTime() }]);
      if (!openRef.current) setUnread(u => u + 1);
      scrollSoon();
    };
    socket.on('meeting_chat_message', onMessage);
    return () => { socket.off('meeting_chat_message', onMessage); };
  }, [roomId, userName]);

  // Live captions from PEERS over the socket (same event the web modal consumes).
  // The backend relays with `socket.to(room)`, so our OWN chunks never echo back —
  // we append those locally in the recognizer below instead.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onChunk = (data: any) => {
      if (roomId && data?.roomId && String(data.roomId) !== String(roomId)) return;
      // Guard against a same-device echo: ignore chunks stamped with our own id.
      if (userId && data?.speakerId && String(data.speakerId) === String(userId)) return;
      setTranscript(prev => [...prev, { speaker: data?.speaker, text: data?.text, time: nowTime() }]);
    };
    socket.on('meeting_transcript_chunk', onChunk);
    return () => { socket.off('meeting_transcript_chunk', onChunk); };
  }, [roomId, userId]);

  // On-device live transcription (mobile parity with the web's Web Speech API).
  // Transcribes THIS device's mic; each final line is (1) shown locally, (2)
  // relayed to peers over the socket, and (3) persisted so the post-call
  // transcript/summary is populated. No-op in Expo Go (native module absent).
  useEffect(() => {
    if (!isTranscriptionAvailable()) return;
    const speaker = userName || 'You';
    const transcriber = new LiveTranscriber((text: string) => {
      // 1) local display
      setTranscript(prev => [...prev, { speaker, text, time: nowTime() }]);
      // 2) relay to peers
      getSocket()?.emit('meeting_transcript_chunk', { roomId, speaker, speakerId: userId, text });
      // 3) persist (each client saves its own chunk exactly once)
      if (meetingDbId) {
        addMeetingTranscriptChunk(String(meetingDbId), { speaker, speakerId: userId, text, timestamp: Date.now() })
          .catch(() => undefined);
      }
    });
    // The module IS available here (checked above), so a false result means the
    // speaker denied the mic/speech permission — tell them, otherwise the transcript
    // tab just sits empty and looks broken.
    let cancelled = false;
    transcriber.start().then((ok) => {
      if (!ok && !cancelled) {
        setTranscript(prev => [...prev, {
          speaker: 'System',
          text: 'Live captions are off — grant microphone & speech-recognition permission in Settings to enable transcription.',
          time: nowTime(),
        }]);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; transcriber.stop(); };
  }, [roomId, userId, userName, meetingDbId]);

  const openPanel = (t: PanelTab) => { setTab(t); setOpen(true); setUnread(0); };

  // Expose panel/emoji controls to the parent overlay's control tray.
  useEffect(() => {
    registerControls?.({
      openChat: () => openPanel('chat'),
      toggleEmoji: () => setShowEmoji((s) => !s),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerControls]);

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    const socket = getSocket();
    setMessages(prev => [...prev, { speaker: userName, text, time: nowTime(), mine: true }]);
    socket?.emit('meeting_chat_message', { roomId, speaker: userName, text });
    scrollSoon();
  };

  // Pick + upload an image, then share its URL in the meeting chat over the socket.
  const handleAttach = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
      if (result.canceled || !result.assets?.length) return;
      setUploading(true);
      const uri = result.assets[0].uri;
      const url = await uploadGroupOrOrgImage(uri);
      const text = 'Shared an image';
      setMessages(prev => [...prev, { speaker: userName, text, imageUrl: url, time: nowTime(), mine: true }]);
      getSocket()?.emit('meeting_chat_message', { roomId, speaker: userName, text, imageUrl: url });
      scrollSoon();
    } catch (e) {
      console.warn('[LiveKit] image share failed:', e);
    } finally {
      setUploading(false);
    }
  };

  const react = (emoji: string) => {
    setShowEmoji(false);
    onReact(emoji); // spawn locally + emit to peers
  };

  return (
    <>
      {/* Reaction picker — the bar always renders (tray-driven too); the FABs
          only when the parent overlay's control tray isn't driving us. */}
      <View style={styles.reactWrap} pointerEvents="box-none">
        {showEmoji && (
          <View style={styles.emojiBar}>
            {REACTION_EMOJIS.map(e => (
              <TouchableOpacity key={e} onPress={() => react(e)} style={styles.emojiBtn}>
                <Text style={{ fontSize: 22 }}>{e}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        {!hideFabs && (
          <TouchableOpacity onPress={() => setShowEmoji(s => !s)} style={styles.reactFab} activeOpacity={0.85}>
            <Smile color="#fff" size={20} />
          </TouchableOpacity>
        )}
      </View>

      {/* Floating open button (chat-as-popup) */}
      {!hideFabs && (
        <TouchableOpacity onPress={() => openPanel('chat')} style={styles.panelFab} activeOpacity={0.85}>
          <MessageSquare color="#fff" size={20} />
          {unread > 0 && <View style={styles.panelFabDot} />}
        </TouchableOpacity>
      )}

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.panelBackdrop}>
          <View style={styles.panelSheet}>
            {/* Tabs */}
            <View style={styles.panelTabs}>
              {(['people', 'chat', 'transcript'] as PanelTab[]).map(t => (
                <TouchableOpacity key={t} onPress={() => setTab(t)} style={[styles.panelTab, tab === t && styles.panelTabActive]}>
                  {t === 'people' ? <Users size={15} color={tab === t ? '#6c5ce7' : '#9a9aab'} />
                    : t === 'chat' ? <MessageSquare size={15} color={tab === t ? '#6c5ce7' : '#9a9aab'} />
                    : <FileText size={15} color={tab === t ? '#6c5ce7' : '#9a9aab'} />}
                  <Text style={[styles.panelTabText, tab === t && styles.panelTabTextActive]}>
                    {t === 'people' ? `People (${participants.length})` : t === 'chat' ? 'Chat' : 'Transcript'}
                  </Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity onPress={() => setOpen(false)} style={styles.panelClose}><X size={18} color="#1f2030" /></TouchableOpacity>
            </View>

            {tab === 'people' && (
              <ScrollView style={styles.panelBody}>
                {participants.map((p, i) => (
                  <View key={p.identity || i} style={styles.personRow}>
                    <View style={[styles.personDot, p.isSpeaking && { backgroundColor: '#6c5ce7' }]} />
                    <Text style={styles.personName}>{p.name || p.identity || 'Participant'}{p.isLocal ? ' (You)' : ''}</Text>
                  </View>
                ))}
              </ScrollView>
            )}

            {tab === 'chat' && (
              <View style={{ flex: 1 }}>
                <ScrollView ref={scrollRef} style={styles.panelBody} onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}>
                  {messages.length === 0 ? (
                    <Text style={styles.panelEmpty}>No messages yet. Say hello 👋</Text>
                  ) : messages.map((m, i) => {
                    const mine = m.mine || m.speaker === userName;
                    return (
                      <View key={i} style={[styles.chatBubbleRow, mine && { alignItems: 'flex-end' }]}>
                        {!mine && <Text style={styles.chatFrom}>{m.speaker}</Text>}
                        <View style={[styles.chatBubble, mine ? styles.chatBubbleMine : styles.chatBubbleTheirs]}>
                          {m.imageUrl ? (
                            <Image source={{ uri: getSecureMediaUrl(m.imageUrl) || m.imageUrl }} style={styles.chatImage} />
                          ) : null}
                          {m.text ? <Text style={[styles.chatText, mine && { color: '#fff' }]}>{m.text}</Text> : null}
                          <Text style={[styles.chatTime, mine && { color: 'rgba(255,255,255,0.7)' }]}>{m.time}</Text>
                        </View>
                      </View>
                    );
                  })}
                </ScrollView>
                <View style={styles.chatComposer}>
                  <TouchableOpacity onPress={handleAttach} disabled={uploading} style={styles.chatAttach}>
                    <Paperclip size={18} color={uploading ? '#c4c4d0' : '#6c5ce7'} />
                  </TouchableOpacity>
                  <TextInput
                    value={draft}
                    onChangeText={setDraft}
                    placeholder={uploading ? 'Uploading image…' : 'Message…'}
                    placeholderTextColor="#9a9aab"
                    style={styles.chatInput}
                    onSubmitEditing={handleSend}
                    returnKeyType="send"
                  />
                  <TouchableOpacity onPress={handleSend} disabled={!draft.trim()} style={styles.chatSend}>
                    <Send size={16} color="#fff" />
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {tab === 'transcript' && (
              <ScrollView style={styles.panelBody}>
                {transcript.length === 0 ? (
                  <Text style={styles.panelEmpty}>Live transcript will appear here once speech is detected.</Text>
                ) : transcript.map((c, i) => (
                  <View key={i} style={{ marginBottom: 8 }}>
                    {c.speaker ? <Text style={styles.chatFrom}>{c.speaker}</Text> : null}
                    <Text style={styles.transcriptText}>{c.text}</Text>
                  </View>
                ))}
              </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

export interface LiveKitCallRoomProps {
  serverUrl: string;
  token: string;
  isVideo: boolean;
  micEnabled: boolean;
  cameraEnabled: boolean;
  speakerEnabled: boolean;
  /** Toggle local screen sharing. Requires native screen-capture support in this
   *  build; failures are reported via onScreenShareError instead of throwing. */
  screenShareEnabled?: boolean;
  onScreenShareError?: (err: Error) => void;
  /** LiveKit room id — used to scope the in-call chat/transcript/reaction sockets. */
  roomId?: string;
  /** Local user's display name — stamped on outgoing chat messages + reactions. */
  userName?: string;
  /** Local user id — stamps transcript chunks for speaker attribution/dedupe. */
  userId?: string;
  /** Meeting DB id — lets the on-device transcriber persist its own chunks. */
  meetingDbId?: string | null;
  /** Avatar/placeholder shown before remote video or on voice calls. */
  fallback: React.ReactNode;
  /** Reports the live roster up to the overlay (header avatar cluster/count). */
  onParticipantsChanged?: (list: { name?: string; avatar?: string; isLocal: boolean }[]) => void;
  /** Receives { openChat, toggleEmoji } so the overlay's tray can drive the
   *  in-call panel; when provided, the floating FABs are hidden. */
  registerPanelControls?: (c: { openChat: () => void; toggleEmoji: () => void }) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onError?: (err: Error) => void;
}

/**
 * Connects to a LiveKit room and renders the in-call media area. The call control
 * buttons stay in the parent overlay; their state flows in via micEnabled/cameraEnabled.
 */
export default function LiveKitCallRoom({
  serverUrl,
  token,
  isVideo,
  micEnabled,
  cameraEnabled,
  speakerEnabled,
  screenShareEnabled,
  onScreenShareError,
  roomId,
  userName,
  userId,
  meetingDbId,
  fallback,
  onParticipantsChanged,
  registerPanelControls,
  onConnected,
  onDisconnected,
  onError,
}: LiveKitCallRoomProps) {
  // Bridge: CallPanel's emoji button spawns a reaction locally (via this ref, set by
  // ReactionsLayer) and emits `meeting_reaction` so peers see it float too.
  const spawnReactionRef = useRef<((emoji: string) => void) | null>(null);
  const handleReact = React.useCallback((emoji: string) => {
    spawnReactionRef.current?.(emoji);
    getSocket()?.emit('meeting_reaction', { roomId, emoji });
  }, [roomId]);
  // Start the platform audio session for the lifetime of the room.
  useEffect(() => {
    let active = true;
    AudioSession.startAudioSession().catch((e) => console.warn('[LiveKit] audio session start failed:', e));
    return () => {
      active = false;
      AudioSession.stopAudioSession().catch(() => {});
      void active;
    };
  }, []);

  // Route audio to speaker or earpiece in response to the overlay toggle.
  useEffect(() => {
    const out = Platform.OS === 'ios'
      ? (speakerEnabled ? 'force_speaker' : 'default')
      : (speakerEnabled ? 'speaker' : 'earpiece');
    AudioSession.selectAudioOutput(out).catch(() => {});
  }, [speakerEnabled]);

  return (
    <LiveKitRoom
      serverUrl={serverUrl}
      token={token}
      connect={true}
      audio={false}
      video={isVideo}
      onConnected={onConnected}
      onDisconnected={onDisconnected}
      onError={onError}
    >
      <LocalDeviceBridge
        micEnabled={micEnabled}
        cameraEnabled={cameraEnabled}
        screenShareEnabled={screenShareEnabled}
        onScreenShareError={onScreenShareError}
      />
      <VideoArea isVideo={isVideo} fallback={fallback} />
      <ParticipantsBridge onChanged={onParticipantsChanged} />
      <ReactionsLayer roomId={roomId} register={(fn) => { spawnReactionRef.current = fn; }} />
      <CallPanel
        roomId={roomId}
        userName={userName || 'You'}
        userId={userId}
        meetingDbId={meetingDbId}
        onReact={handleReact}
        registerControls={registerPanelControls}
        hideFabs={!!registerPanelControls}
      />
    </LiveKitRoom>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, width: '100%', height: '100%' },
  fillCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', width: '100%' },
  // ── Voice "Audio Conference" stage (light — mirrors web LiveKitMeetingModal) ──
  audioStage: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
  audioMainCard: {
    width: '92%', flexGrow: 1, maxHeight: 420, borderRadius: 32, paddingVertical: 34, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(234,231,250,0.5)', borderWidth: 1.5, borderColor: 'rgba(108,92,231,0.3)',
  },
  audioMainCardSpeaking: { borderColor: '#6c5ce7', backgroundColor: 'rgba(234,231,250,0.75)' },
  audioMainAvatarFrame: {
    borderRadius: 30, overflow: 'hidden', borderWidth: 3, borderColor: '#ffffff',
    shadowColor: '#6c5ce7', shadowOpacity: 0.25, shadowRadius: 14, shadowOffset: { width: 0, height: 6 },
  },
  audioMainName: { marginTop: 16, color: '#1f2030', fontSize: 20, fontFamily: 'Poppins_700Bold' },
  audioMainMicRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  audioMainMicText: { color: '#22c55e', fontSize: 12.5, fontFamily: 'Poppins_500Medium' },
  audioRow: { flexDirection: 'row', gap: 12, paddingHorizontal: 14, paddingTop: 18 },
  audioTile: {
    width: 118, borderRadius: 24, paddingVertical: 14, alignItems: 'center',
    backgroundColor: '#ffffff', borderWidth: 1.5, borderColor: 'rgba(0,0,0,0.05)',
    shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
  },
  audioTileSpeaking: { borderColor: '#6c5ce7', backgroundColor: 'rgba(234,231,250,0.4)' },
  audioTileName: { marginTop: 8, color: '#1f2030', fontSize: 11.5, fontFamily: 'Poppins_600SemiBold', maxWidth: 106 },
  audioMicBadge: { marginTop: 6, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  screenShareBadge: {
    position: 'absolute', top: 12, left: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12,
  },
  screenShareBadgeText: { color: '#fff', fontSize: 11, fontFamily: 'Poppins_600SemiBold' },
  pip: {
    position: 'absolute',
    top: 16,
    right: 16,
    width: 104,
    height: 150,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  // ── Multi-participant thumbnail row ──
  thumbRowWrap: { position: 'absolute', left: 0, right: 0, bottom: 84 },
  thumbRow: { paddingHorizontal: 10, gap: 8, flexDirection: 'row' },
  thumbTile: {
    width: 60, height: 78, borderRadius: 12, overflow: 'hidden', backgroundColor: '#0b0b12',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.2)',
  },
  thumbTileSpeaking: { borderColor: '#6c5ce7', borderWidth: 2 },
  thumbFallback: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(108,92,231,0.18)' },
  thumbLabel: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.45)', paddingHorizontal: 4, paddingVertical: 2 },
  thumbLabelText: { color: '#fff', fontSize: 8, fontFamily: 'Poppins_600SemiBold' },
  // ── Reaction picker ──
  reactWrap: { position: 'absolute', bottom: 24, right: 16, alignItems: 'flex-end' },
  reactFab: {
    width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(108,92,231,0.92)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 4,
  },
  emojiBar: {
    flexDirection: 'row', backgroundColor: '#fff', borderRadius: 24, paddingHorizontal: 8, paddingVertical: 6, marginBottom: 8, gap: 2,
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 6,
  },
  emojiBtn: { paddingHorizontal: 5, paddingVertical: 2 },
  // ── In-call panel (People / Chat / Transcript) ──
  panelFab: {
    position: 'absolute', bottom: 24, left: 16,
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: 'rgba(108,92,231,0.92)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 4,
  },
  panelFabDot: { position: 'absolute', top: 10, right: 10, width: 9, height: 9, borderRadius: 5, backgroundColor: '#22c55e', borderWidth: 1.5, borderColor: '#fff' },
  panelBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  panelSheet: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, height: '62%', paddingTop: 8 },
  panelTabs: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.06)' },
  panelTab: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 12 },
  panelTabActive: { backgroundColor: 'rgba(108,92,231,0.08)' },
  panelTabText: { fontSize: 12, fontFamily: 'Poppins_600SemiBold', color: '#9a9aab' },
  panelTabTextActive: { color: '#6c5ce7' },
  panelClose: { marginLeft: 'auto', padding: 6 },
  panelBody: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  panelEmpty: { fontSize: 13, color: '#9a9aab', fontFamily: 'Poppins_400Regular', textAlign: 'center', marginTop: 24 },
  personRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.04)' },
  personDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#22c55e', marginRight: 10 },
  personName: { fontSize: 14, color: '#1f2030', fontFamily: 'Poppins_500Medium' },
  chatBubbleRow: { marginBottom: 8, alignItems: 'flex-start' },
  chatFrom: { fontSize: 10, color: '#6c5ce7', fontFamily: 'Poppins_700Bold', marginBottom: 2 },
  chatBubble: { maxWidth: '80%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14 },
  chatBubbleMine: { backgroundColor: '#6c5ce7', borderBottomRightRadius: 4 },
  chatBubbleTheirs: { backgroundColor: '#f1f5f9', borderBottomLeftRadius: 4 },
  chatText: { fontSize: 13.5, color: '#1f2030', fontFamily: 'Poppins_400Regular' },
  chatTime: { fontSize: 9, color: '#9a9aab', fontFamily: 'Poppins_400Regular', marginTop: 3, alignSelf: 'flex-end' },
  chatImage: { width: 180, height: 135, borderRadius: 10, marginBottom: 4, backgroundColor: '#e5e7eb' },
  chatComposer: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.06)' },
  chatAttach: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f1eefe' },
  chatInput: { flex: 1, backgroundColor: '#f1f5f9', borderRadius: 20, paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 10 : 6, fontSize: 14, fontFamily: 'Poppins_400Regular', color: '#1f2030' },
  chatSend: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#6c5ce7', alignItems: 'center', justifyContent: 'center' },
  transcriptText: { fontSize: 13.5, color: '#1f2030', lineHeight: 19, fontFamily: 'Poppins_400Regular' },
});
