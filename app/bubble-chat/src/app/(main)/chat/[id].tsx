import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView,
  TextInput, KeyboardAvoidingView, Platform, Modal, Alert, Clipboard, Switch, Keyboard, ActivityIndicator,
  Animated, PanResponder, Linking,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ChevronLeft, ChevronRight, Forward, Phone, Video, Search, MoreVertical,
  Smile, Paperclip, Mic, Send, X, Mail, Briefcase,
  Camera, FileText, Image as ImageIcon,
  Info, Sparkles, BellOff, EyeOff, Archive, Trash2,
  Copy, Pin, Edit2, Check, CheckCheck,
  MicOff, PhoneOff, Volume2, Clock, Play, Pause, MessageSquare, Reply,
} from 'lucide-react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import {
  useAudioRecorder, useAudioPlayer, useAudioPlayerStatus,
  RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync,
} from 'expo-audio';
import { Message } from '../../../lib/mockData';
import { chatCache } from '../../../lib/chatCache';
import { getSocket } from '../../../lib/socket';
import {
  sendTextMessage,
  sendMediaMessage,
  reactToMessage,
  toggleMessagePin,
  deleteMessageForMe,
  deleteMessageForEveryone,
  markMessagesRead,
  updateMessage,
  muteChat,
  clearChat,
  toggleChatPin,
  deleteChat,
  getAidaWritingSuggestions,
  aidaDraft,
  getSecureMediaUrl,
  uploadGroupOrOrgImage,
  accessOrCreateChat,
  getChatById,
} from '../../../lib/api';
import { startOutgoingCall, startGroupCall } from '../../../lib/callManager';
import { prepareChat, encryptForChat, parseEnvelope, decryptEnvelope, ENCRYPTED_PLACEHOLDER } from '../../../lib/e2ee';
import { useTheme } from '../../../lib/theme';
import { useIsOnline, useViewerVisibility } from '../../../lib/presence';
import { authStorage } from '../../../lib/authStorage';
import { useNicknames } from '../../../lib/nicknames';
import { setActiveChatId } from '../../../lib/activeChatRef';
import { Avatar } from '../../../components/Avatar';

const PURPLE = '#6c5ce7';
const INK = '#1f2030';
const INK_SOFT = '#9a9aab';
const BG = '#f8f7ff';
const PURPLE_SOFT = 'rgba(108,92,231,0.10)';

// Render message body text, turning URLs into tappable links. Long URLs are
// truncated for display (the full URL still opens) so they never widen the bubble.
// Mirrors the web's renderMentionText linkify behavior (chat-window.tsx).
const URL_REGEX = /(https?:\/\/[^\s<>"']+)/g;
const MENTION_REGEX = /(@[a-zA-Z0-9_.\-]+)/g;

function renderMessageText(
  text: string,
  isMe: boolean,
  mentionNames?: Record<string, string>,
  // Received bubbles sit on `colors.surface`, so their text must follow the theme
  // (dark ink in light mode, near-white in dark mode). Sent bubbles are always on
  // purple, so their text stays white regardless of scheme.
  textColors?: { text: string; textSoft: string }
) {
  if (!text) return text;
  const baseColor = isMe ? '#ffffff' : (textColors?.text ?? INK);
  const softColor = isMe ? 'rgba(255,255,255,0.8)' : (textColors?.textSoft ?? INK_SOFT);
  const linkColor = isMe ? '#ffffff' : PURPLE;
  const mentionColor = isMe ? '#ffe8a3' : PURPLE;
  const parts = text.split(URL_REGEX);
  return parts.map((segment, i) => {
    URL_REGEX.lastIndex = 0;
    if (URL_REGEX.test(segment)) {
      const display = segment.length > 40 ? segment.slice(0, 38) + '…' : segment;
      return (
        <Text
          key={`url-${i}`}
          style={{ color: linkColor, textDecorationLine: 'underline' }}
          onPress={() => Linking.openURL(segment).catch(() => { })}
        >
          {display}
        </Text>
      );
    }
    // Highlight @mentions and show the person's NAME right beside the handle
    // (e.g. "@dara (Dara Mobile)") so an @ is never just a bare username.
    return segment.split(MENTION_REGEX).map((piece, j) => {
      if (piece.startsWith('@') && piece.length > 1) {
        const uname = piece.slice(1).toLowerCase();
        const fullName = uname === 'all' ? null : mentionNames?.[uname];
        return (
          <Text key={`m-${i}-${j}`} style={{ color: mentionColor, fontFamily: 'Poppins_700Bold' }}>
            {piece}
            {fullName ? (
              <Text style={{ color: softColor, fontFamily: 'Poppins_400Regular' }}>
                {` (${fullName})`}
              </Text>
            ) : null}
          </Text>
        );
      }
      return (
        <Text key={`t-${i}-${j}`} style={{ color: baseColor }}>
          {piece}
        </Text>
      );
    });
  });
}

const AVATARS = [
  "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=150&auto=format&fit=crop",
];

const EMOJI_CATEGORIES = [
  { title: 'Smileys', emojis: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🥸', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🫣', '🤭', '🤫', '🤥', '😶', '😶‍🌫️', '😐', '😑', '😬', '🫨', '🫠', '🙄', '😯', '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '😵‍💫', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕'] },
  { title: 'Gestures', emojis: ['👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🫀', '🫁', '🦷', '🦴', '👀', '👁️', '👅', '👄', '💋', '🩸'] },
  { title: 'Hearts & Expressions', emojis: ['❤️', '🩷', '🧡', '💛', '💚', '💙', '🩵', '💜', '🖤', '🩶', '🤍', '🤎', '💔', '❤️‍🔥', '❤️‍🩹', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '🗣️', '👤', '👥', '🫂'] },
  { title: 'Activities & Symbols', emojis: ['🔥', '✨', '🌟', '⭐', '🌈', '⚡', '💥', '❄️', '☀️', '🎈', '🎉', '🎊', '🎁', '🎂', '🎄', '🎆', '🎇', '🧨', '🧿', '🔮', '🎮', '🕹️', '🎲', '🧩', '🎯', '🎳', '🏆', '🥇', '🥈', '🥉', '⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏉', '🎱', '🏓', '🏸', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🛹', '🛼', '🚴', '🏃', '🚶', '🤫'] },
  { title: 'Food & Drinks', emojis: ['🍎', '🍌', '🍇', '🍓', '🍉', '🍒', '🍑', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌽', '🥕', '🥔', '🍠', '🥐', '🍞', '🥖', '🥨', '🥯', '🥞', '🧇', '🧀', '🍖', '🍗', '🥩', '🥓', '🍔', '🍟', '🍕', '🌭', '🥪', '🌮', '🌯', '🍳', '🍲', '🍿', '🍱', '🍣', '🍤', '🍙', '🍘', '🍨', '🍧', '🍩', '🍪', '🎂', '🍰', '🧁', '🥧', '🍫', '🍬', '🍭', '🍯', '🍼', '🥛', '☕', '🍵', '🧉', '🥤', '🍺', '🍻', '🥂', '🍷', '🥃', '🍸', '🍹', '🍾'] }
];

export default function ChatScreen() {
  const { colors } = useTheme();
  // Theme-aware shadows of the module constants. In light mode these resolve to the
  // exact original hex (#1f2030 / #9a9aab), so every modal/inline `INK` usage below is
  // a no-op in light and automatically themes to the dark palette in dark mode.
  const INK = colors.text;
  const INK_SOFT = colors.textSoft;
  const insets = useSafeAreaInsets();
  // Optional context passed on navigation (name/avatar/otherUserId) lets a chat
  // that isn't cached yet render its header + empty thread INSTANTLY instead of
  // blocking on the network behind "Loading conversation…".
  const { id, name: paramName, avatar: paramAvatar, otherUserId: paramOtherUserId } = useLocalSearchParams<{
    id: string; name?: string; avatar?: string; otherUserId?: string;
  }>();
  const router = useRouter();
  const [messageText, setMessageText] = useState('');

  // Draft persistence: restore unsent text when the chat opens, save (debounced)
  // as the user types, clear on send. Survives navigation and app restarts.
  const draftTimerRef = useRef<any>(null);
  const draftRestoredRef = useRef(false);
  useEffect(() => {
    draftRestoredRef.current = false;
    chatCache.getDraft(String(id)).then(draft => {
      if (draft) setMessageText(prev => prev || draft);
      draftRestoredRef.current = true;
    }).catch(() => { draftRestoredRef.current = true; });
    return () => { if (draftTimerRef.current) clearTimeout(draftTimerRef.current); };
  }, [id]);
  useEffect(() => {
    if (!draftRestoredRef.current) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      chatCache.saveDraft(String(id), messageText).catch(() => undefined);
    }, 400);
  }, [messageText, id]);
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chat, setChat] = useState<any>(null);

  // username (lowercase) → full name for everyone in this chat, so rendered
  // @mentions can show the person's name right beside the handle.
  const mentionNames = React.useMemo(() => {
    const map: Record<string, string> = {};
    const members = [...(chat?.users || []), ...(chat?.members || [])];
    for (const u of members) {
      const uname = u?.username ? String(u.username).toLowerCase() : null;
      if (uname && !map[uname]) map[uname] = u.full_name || u.name || '';
    }
    return map;
  }, [chat?.users, chat?.members]);
  const [isAttachmentOpen, setIsAttachmentOpen] = useState(false);
  const [isEmojiOpen, setIsEmojiOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<{ name: string; size: string; type: string; url?: string } | null>(null);
  const [openSection, setOpenSection] = useState<string | null>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  // Real microphone recorder (expo-audio). Produces a local file URI we upload
  // as a voice note — replaces the old hardcoded sample-URL mock.
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [typingUser, setTypingUser] = useState<{ id: string; name?: string; username?: string } | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [isPulsing, setIsPulsing] = useState(true);
  const [ownUser, setOwnUser] = useState<any>(null);
  const isPeerOnline = useIsOnline(chat?.otherUserId, !!chat?.isOnline);
  // Reciprocity: if I turned off my own read receipts, I don't see others' "seen" state.
  const { readReceipts: viewerReadReceipts } = useViewerVisibility();
  const { getDisplayName, saveNickname } = useNicknames();

  // New States for Lightbox, Forwarding, and Emoji selector
  const [lightboxImageIndex, setLightboxImageIndex] = useState<number | null>(null);
  const [forwardingMessage, setForwardingMessage] = useState<Message | null>(null);
  const [isForwardLoading, setIsForwardLoading] = useState<string | null>(null);
  const [recentChats, setRecentChats] = useState<any[]>([]);
  const [activeEmojiCategoryIdx, setActiveEmojiCategoryIdx] = useState<number>(0);
  const [forwardedChatIds, setForwardedChatIds] = useState<string[]>([]);
  const sendingRef = useRef(false);

  // User details for own-typing socket filters
  const currentUserIdRef = useRef<string | null>(null);
  const chatRef = useRef<any>(null);

  // E2EE cipher state for this chat (null = plaintext / keys unavailable).
  const cipherRef = useRef<Awaited<ReturnType<typeof prepareChat>>>(null);
  const decryptIncoming = (data: any): string | null => {
    if (!data?.is_encrypted || !data?.content) return null;
    const env = parseEnvelope(data.content);
    const plain = env ? decryptEnvelope(String(id), env, cipherRef.current) : null;
    return plain ?? ENCRYPTED_PLACEHOLDER;
  };

  // @mention state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null); // null = not in mention mode
  const [mentionSuggestions, setMentionSuggestions] = useState<{ id: string; name: string; username: string; avatar?: string; isMentionAll?: boolean }[]>([]);
  const mentionStartIndexRef = useRef<number>(-1);

  const [isEditingGroup, setIsEditingGroup] = useState(false);
  const [groupFormData, setGroupFormData] = useState({
    chatName: '',
    groupDescription: '',
    groupIcon: '',
    maxMembers: 0,
    transcriptPolicy: 'save' as 'email' | 'save' | 'off',
    allowMembersToShareInvite: true,
    resources: [] as { label: string; url?: string; type?: 'link' | 'file' }[],
  });
  // Draft inputs for adding a new group resource (label + url)
  const [newResLabel, setNewResLabel] = useState('');
  const [newResUrl, setNewResUrl] = useState('');
  // Tapped group member → profile sheet
  const [selectedMember, setSelectedMember] = useState<any | null>(null);
  const [showAllMembers, setShowAllMembers] = useState(false);
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState('');
  useEffect(() => { setEditingNickname(false); setNicknameDraft(''); }, [selectedMember?.id || selectedMember?._id, isInfoOpen]);

  // Refresh the full, authoritative member list from the server whenever the
  // info panel opens for a group — the chat-list object can carry a partial
  // `users` array (stale cache / trimmed socket payload), so we re-fetch here,
  // same as the web GroupInfo component does via getChatById.
  useEffect(() => {
    if (!isInfoOpen || !chat?.isGroupChat) return;
    const cid = chat?.id || chat?._id;
    if (!cid) return;
    let cancelled = false;
    getChatById(String(cid))
      .then((res: any) => {
        const fresh = res?.conversation || res?.data || res;
        if (cancelled || !fresh) return;
        setChat((prev: any) => {
          if (!prev) return prev;
          const freshUsers = Array.isArray(fresh.users) && fresh.users.length > 0 ? fresh.users : prev.users;
          const freshMembers = Array.isArray(fresh.members) && fresh.members.length > 0 ? fresh.members : prev.members;
          return { ...prev, users: freshUsers, members: freshMembers };
        });
      })
      .catch(() => { /* keep existing data */ });
    return () => { cancelled = true; };
  }, [isInfoOpen, chat?.id, chat?._id]);

  const handleStartEditGroup = () => {
    setGroupFormData({
      chatName: chat?.name || '',
      groupDescription: chat?.bio || '',
      groupIcon: chat?.avatar || '',
      maxMembers: chat?.maxMembers || 0,
      transcriptPolicy: chat?.transcriptPolicy || 'save',
      allowMembersToShareInvite: chat?.allowMembersToShareInvite ?? true,
      resources: Array.isArray(chat?.resources) ? chat.resources : [],
    });
    setNewResLabel('');
    setNewResUrl('');
    setIsEditingGroup(true);
  };

  useEffect(() => {
    authStorage.getUser().then((user) => {
      if (user) {
        currentUserIdRef.current = String(user.id || user._id);
        setOwnUser(user);
      }
    });
  }, []);

  // Load recent chats for forwarding
  useEffect(() => {
    async function loadRecentChats() {
      try {
        const chats = await chatCache.getCachedChats();
        setRecentChats(chats);
      } catch (err) {
        console.warn("Failed to load recent chats for forwarding:", err);
      }
    }
    if (forwardingMessage) {
      loadRecentChats();
      setForwardedChatIds([]);
    }
  }, [forwardingMessage]);

  useEffect(() => {
    chatRef.current = chat;
  }, [chat]);

  useEffect(() => {
    let timerInterval: any = null;
    let pulseInterval: any = null;

    if (isRecording) {
      setRecordingSeconds(0);
      setIsPulsing(true);

      timerInterval = setInterval(() => {
        setRecordingSeconds(prev => prev + 1);
      }, 1000);

      pulseInterval = setInterval(() => {
        setIsPulsing(prev => !prev);
      }, 500);
    } else {
      setRecordingSeconds(0);
    }

    return () => {
      if (timerInterval) clearInterval(timerInterval);
      if (pulseInterval) clearInterval(pulseInterval);
    };
  }, [isRecording]);

  const formatRecordingTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  // Aida Suggestions state
  const [aidaSuggestions, setAidaSuggestions] = useState<string[]>([]);
  const [aidaUnavailable, setAidaUnavailable] = useState(false);
  // Deep Aida "Draft" (F5): a full context-aware reply fills the input.
  const [isDrafting, setIsDrafting] = useState(false);

  // For E2EE chats the server can't read the ciphertext, so we hand Aida the
  // locally-decrypted recent lines (transient — never stored server-side). For
  // plaintext chats we send nothing and let the server read directly.
  const buildAidaContext = (limit = 20): string[] | undefined => {
    if (!cipherRef.current) return undefined;
    return messages
      .filter(m => m.sender !== 'system' && m.text)
      .slice(-limit)
      .map(m => `${m.sender === 'me' ? 'Me' : (m.senderName || chat?.name || 'Them')}: ${m.text}`);
  };

  const handleDraftForMe = async () => {
    if (isDrafting) return;
    setIsDrafting(true);
    try {
      const res = await aidaDraft(String(id), messageText.trim() || undefined, buildAidaContext());
      if (res?.draft) {
        setMessageText(res.draft);
        setAidaSuggestions([]);
      } else {
        Alert.alert('Aida', 'Could not draft a reply right now.');
      }
    } catch (err: any) {
      if (err?.status === 503 || err?.code === 'AIDA_UNCONFIGURED') {
        setAidaUnavailable(true);
      } else {
        Alert.alert('Aida', 'Could not generate draft.');
      }
    } finally {
      setIsDrafting(false);
    }
  };

  const handleStartCall = (type: 'voice' | 'video') => {
    if (chat?.isGroupChat) {
      const members = [...(chat?.users || []), ...(chat?.members || [])];
      // Pass the group's icon so the call overlay shows it instead of initials.
      startGroupCall(members, type, chat?.name, chat?.avatar || undefined);
      return;
    }
    if (!chat?.otherUserId) return;
    startOutgoingCall({
      id: chat.otherUserId,
      otherUserId: chat.otherUserId,
      name: chat.name,
      avatar: chat.avatar,
      chatId: chat.id,
    }, type);
  };

  useEffect(() => {
    if (!chat || messages.length === 0) return;

    // Find the last received message (sender !== 'me')
    const lastReceived = [...messages].reverse().find(m => m.sender !== 'me');
    if (!lastReceived) {
      setAidaSuggestions([]);
      return;
    }

    if (aidaUnavailable) return;

    const fetchSuggestions = async () => {
      try {
        const response = await getAidaWritingSuggestions(lastReceived.text, String(id), buildAidaContext());
        const suggestionsList = response?.suggestions || response?.data || [];
        setAidaSuggestions(suggestionsList);
      } catch (err: any) {
        if (err?.status === 503 || err?.code === 'AIDA_UNCONFIGURED') {
          setAidaUnavailable(true);
          setAidaSuggestions([]);
          return;
        }
        // Fallback suggestions
        setAidaSuggestions([
          "Sounds good!",
          "Let's sync up later.",
          "Can you share the file?",
          "Got it, thanks!"
        ]);
      }
    };
    fetchSuggestions();
  }, [messages, id]);

  const typingTimer = useRef<any>(null);
  const suggestDraftTimer = useRef<any>(null);

  // Brain-augmented draft suggestions — fires 800ms after typing pauses.
  // Surfaces facts from the company brain the user may not know off the top of
  // their head (e.g. status of a project, contact info, prior decisions).
  useEffect(() => {
    if (suggestDraftTimer.current) clearTimeout(suggestDraftTimer.current);
    if (!messageText || messageText.trim().length < 3) return;
    if (aidaUnavailable) return;
    suggestDraftTimer.current = setTimeout(async () => {
      try {
        const response = await getAidaWritingSuggestions(messageText, String(id));
        const list = response?.suggestions || response?.data || [];
        if (Array.isArray(list) && list.length > 0) {
          setAidaSuggestions(list);
        }
      } catch (err: any) {
        if (err?.status === 503 || err?.code === 'AIDA_UNCONFIGURED') {
          setAidaUnavailable(true);
          setAidaSuggestions([]);
        }
        // otherwise silent — keep whatever suggestions are already there
      }
    }, 800);
    return () => {
      if (suggestDraftTimer.current) clearTimeout(suggestDraftTimer.current);
    };
  }, [messageText, id]);

  const handleTextChange = (text: string) => {
    setMessageText(text);

    // ── @mention detection ───────────────────────────────────
    if (chat?.isGroupChat && Array.isArray(chat?.users) && chat.users.length > 0) {
      // Find the last '@' that starts a word
      const lastAt = text.lastIndexOf('@');
      if (lastAt !== -1) {
        const afterAt = text.slice(lastAt + 1);
        // If no space after the @, we are still in mention mode
        if (!afterAt.includes(' ') && !afterAt.includes('\n')) {
          const query = afterAt.toLowerCase();
          setMentionQuery(query);
          mentionStartIndexRef.current = lastAt;
          // Filter members
          const allMembers: { id: string; name: string; username: string; avatar?: string }[] = chat.users.map((u: any) => ({
            id: String(u.id || u._id || u),
            name: u.full_name || u.username || '',
            username: u.username || '',
            avatar: u.avatar,
          })).filter((u: any) => u.id !== currentUserIdRef.current);

          const filtered = query
            ? allMembers.filter(u =>
              u.name.toLowerCase().includes(query) || u.username.toLowerCase().includes(query)
            )
            : allMembers;
          // "@all" pseudo-member — notifies every member of the group.
          const showAll = 'all'.startsWith(query);
          const results: { id: string; name: string; username: string; avatar?: string; isMentionAll?: boolean }[] = showAll
            ? [{ id: 'all', name: 'All members', username: 'all', isMentionAll: true }, ...filtered]
            : filtered;
          setMentionSuggestions(results.slice(0, 8));
        } else {
          setMentionQuery(null);
          setMentionSuggestions([]);
        }
      } else {
        setMentionQuery(null);
        setMentionSuggestions([]);
      }
    }
    // ───────────────────────────────────────────

    const socket = getSocket();
    if (socket && chat) {
      const targetUserId = chat.otherUserId;
      if (!text.trim()) {
        if (typingTimer.current) clearTimeout(typingTimer.current);
        socket.emit('typing_stop', { toUserId: targetUserId, chatId: chat.id });
        return;
      }
      socket.emit('typing_start', { toUserId: targetUserId, chatId: chat.id });
      if (typingTimer.current) clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => {
        socket.emit('typing_stop', { toUserId: targetUserId, chatId: chat.id });
      }, 2000);
    }
  };

  const insertMention = (member: { id: string; name: string; username: string }) => {
    const startIdx = mentionStartIndexRef.current;
    if (startIdx === -1) return;
    const before = messageText.slice(0, startIdx);
    const displayName = member.username ? `@${member.username}` : `@${member.name.replace(/\s/g, '_').toLowerCase()}`;
    const newText = before + displayName + ' ';
    setMessageText(newText);
    setMentionQuery(null);
    setMentionSuggestions([]);
    mentionStartIndexRef.current = -1;
  };

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    if (!id) return;

    const onTypingStart = (data: { fromUserId: string; chatId: string; fromName?: string; fromUsername?: string }) => {
      if (currentUserIdRef.current && String(data.fromUserId) === String(currentUserIdRef.current)) return;
      if (String(data.chatId) === String(id)) {
        setChat((prev: any) => prev ? { ...prev, status: 'typing' } : prev);
        setTypingUser({ id: data.fromUserId, name: data.fromName, username: data.fromUsername });
      }
    };

    const onTypingStop = (data: { fromUserId: string; chatId: string }) => {
      if (currentUserIdRef.current && String(data.fromUserId) === String(currentUserIdRef.current)) return;
      if (String(data.chatId) === String(id)) {
        setChat((prev: any) => prev ? { ...prev, status: 'read_own' } : prev);
        setTypingUser(null);
      }
    };

    const onConnect = () => {
      console.log("Socket connected/reconnected in Chat detail screen. Flushing and syncing...");
      // A reconnect gets a new socket on the server, which loses prior room
      // membership — re-join so room-scoped events (e.g. group typing) keep flowing.
      socket.emit('join_room', id);
      syncChatAndMessages();
    };

    socket.emit('join_room', id);

    socket.on('typing_start', onTypingStart);
    socket.on('typing_stop', onTypingStop);
    socket.on('connect', onConnect);

    // Real-time new message delivery without waiting for poll
    const onNewMessage = (data: any) => {
      if (!data) return;
      const incomingChatId = data.chat || data.chatId;
      if (String(incomingChatId) !== String(id)) return;

      // ── NEW: discard Aida bot messages in group chats ──
      const isBotSender = data.sender?.is_bot || data.sender?.username?.toLowerCase() === 'aida';
      if (isBotSender && chatRef.current?.isGroupChat) return;
      const currentUserId = currentUserIdRef.current;
      const senderId = String(data.sender?.id || data.sender?._id || data.sender);
      const isMe = currentUserId && String(senderId) === String(currentUserId);
      const isSystem = data.message_type === 'system' || data.is_announcement === true;

      const formatted = {
        id: String(data.id || data._id || Date.now()),
        text: decryptIncoming(data) ?? (data.content || data.text || ''),
        is_encrypted: !!data.is_encrypted,
        sender: isMe ? 'me' : (isSystem ? 'system' : 'other'),
        senderName: data.sender?.full_name || data.sender?.username || undefined,
        senderIsBot: data.sender?.is_bot || data.sender?.username === 'aida',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp: data.createdAt || new Date().toISOString(),
        reactions: [],
        isPinned: false,
        isRead: false,
        mediaUrl: data.mediaUrl,
        message_type: data.message_type || 'text',
        isSystem,
      };

      setMessages(prev => {
        // Deduplicate by id
        if (prev.some((m: any) => String(m.id) === String(formatted.id))) return prev;
        return [...prev, formatted as any];
      });

      // Delivery ack: this device has the message — flip the sender's tick to
      // 2-gray. (Read/blue is emitted separately by the mark-as-read flow.)
      if (!isMe && !isSystem && (data.id || data._id)) {
        socket.emit('message_delivered', { chatId: String(id), messageIds: [String(data.id || data._id)] });
      }
    };

    socket.on('new_message', onNewMessage);
    socket.on('receive_message', onNewMessage);

    // Sender-side receipt updates: another participant's device received or read
    // our messages — update tick state on our own bubbles.
    const onDeliveryReceipt = (data: any) => {
      if (!data || String(data.chatId) !== String(id)) return;
      const currentUserId = currentUserIdRef.current;
      if (currentUserId && String(data.deliveredBy) === String(currentUserId)) return;
      const idSet = new Set((data.messageIds || []).map(String));
      setMessages(prev => prev.map((m: any) =>
        idSet.has(String(m.id)) && m.sender === 'me' ? { ...m, isDelivered: true } : m
      ));
    };
    socket.on('message_delivery_receipt', onDeliveryReceipt);

    const onMessagesRead = (data: any) => {
      if (!data || String(data.chatId) !== String(id)) return;
      const currentUserId = currentUserIdRef.current;
      if (currentUserId && String(data.userId) === String(currentUserId)) return;
      setMessages(prev => prev.map((m: any) =>
        m.sender === 'me' ? { ...m, isRead: true, isDelivered: true } : m
      ));
    };
    socket.on('messages_read', onMessagesRead);

    // Real-time removal when the other side deletes a message for everyone.
    const onMessageDeleted = (data: any) => {
      if (!data?.messageId) return;
      if (data.chatId && String(data.chatId) !== String(id)) return;
      setMessages(prev => prev.filter((m: any) => String(m.id) !== String(data.messageId)));
    };
    socket.on('message_deleted', onMessageDeleted);

    // Live membership/metadata update for THIS conversation so the member count and
    // members list reflect adds/removes immediately (no reload).
    const onChatUpdated = (updated: any) => {
      const u = updated?.data || updated;
      const uid = u?.id || u?._id;
      if (!uid || String(uid) !== String(id)) return;
      setChat((prev: any) => (prev ? { ...prev, ...u } : prev));
      // Keep chat-list / Work / All-chats in sync so a group rename or icon change
      // (made by anyone, including this device) shows up everywhere immediately.
      chatCache.patchCachedChat(String(uid), {
        groupIcon: u.groupIcon,
        chatName: u.chatName,
        groupDescription: u.groupDescription,
      });
    };
    socket.on('chat_updated', onChatUpdated);

    // Real-time edits from the other side. Payload is the formatted message from the backend.
    const onMessageEdited = (data: any) => {
      if (!data) return;
      const editedId = String(data.id || data._id || '');
      const editedChatId = String(data.chat || data.chatId || '');
      if (!editedId) return;
      if (editedChatId && editedChatId !== String(id)) return;
      setMessages(prev => prev.map((m: any) =>
        String(m.id) === editedId
          ? { ...m, text: decryptIncoming(data) ?? data.content ?? data.text ?? m.text, isEdited: true }
          : m
      ));
    };
    socket.on('message_edited', onMessageEdited);

    // Real-time reaction updates from the other side. Backend sends the full
    // reactions array so we just replace it on the matching message.
    const onMessageReaction = (data: any) => {
      if (!data?.messageId) return;
      if (data.chatId && String(data.chatId) !== String(id)) return;
      // Backend sends reactions as objects ({ user, emoji, timestamp }); the UI
      // renders a flat list of emoji strings, so normalize here.
      const emojis = Array.isArray(data.reactions)
        ? data.reactions.map((r: any) => (typeof r === 'string' ? r : r?.emoji)).filter(Boolean)
        : [];
      setMessages(prev => prev.map((m: any) =>
        String(m.id) === String(data.messageId)
          ? { ...m, reactions: emojis }
          : m
      ));
    };
    socket.on('message_reaction', onMessageReaction);

    const onMessageTranscribed = (data: any) => {
      if (!data?.messageId) return;
      if (data.chatId && String(data.chatId) !== String(id)) return;
      setMessages(prev => prev.map((m: any) =>
        String(m.id) === String(data.messageId) ? { ...m, transcript: data.transcript } : m
      ));
    };
    socket.on('message_transcribed', onMessageTranscribed);

    if (socket.connected) {
      onConnect();
    }

    return () => {
      socket.emit('leave_room', id);
      socket.off('typing_start', onTypingStart);
      socket.off('typing_stop', onTypingStop);
      socket.off('connect', onConnect);
      socket.off('new_message', onNewMessage);
      socket.off('receive_message', onNewMessage);
      socket.off('message_delivery_receipt', onDeliveryReceipt);
      socket.off('messages_read', onMessagesRead);
      socket.off('message_deleted', onMessageDeleted);
      socket.off('chat_updated', onChatUpdated);
      socket.off('message_edited', onMessageEdited);
      socket.off('message_reaction', onMessageReaction);
      socket.off('message_transcribed', onMessageTranscribed);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (chatRef.current) {
        socket.emit('typing_stop', { toUserId: chatRef.current.otherUserId, chatId: chatRef.current.id });
      }
    };
  }, [id]);

  // Header Dropdown Actions states
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isAiSummaryOpen, setIsAiSummaryOpen] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [isChatPinned, setIsChatPinned] = useState(false);
  const [isArchived, setIsArchived] = useState(false);

  // Message context & long-press actions
  const [activeContextMessage, setActiveContextMessage] = useState<Message | null>(null);

  // Reply (quote) target — set via long-press "Reply" or swipe-to-reply.
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);

  // Swipe-to-reply: one Animated.Value + PanResponder per visible message row, cached by id so
  // a mid-swipe gesture survives re-renders (e.g. while the message list updates from a socket event).
  const swipeAnimsRef = useRef<Map<string, Animated.Value>>(new Map());
  const swipeRespondersRef = useRef<Map<string, ReturnType<typeof PanResponder.create>>>(new Map());
  const swipeMsgRef = useRef<Map<string, any>>(new Map());
  const isSelectionModeRef = useRef(false);

  const getSwipeAnim = (id: string) => {
    let anim = swipeAnimsRef.current.get(id);
    if (!anim) {
      anim = new Animated.Value(0);
      swipeAnimsRef.current.set(id, anim);
    }
    return anim;
  };

  const getSwipeResponder = (msg: any) => {
    const id = msg.id;
    swipeMsgRef.current.set(id, msg);
    let responder = swipeRespondersRef.current.get(id);
    if (responder) return responder;
    const anim = getSwipeAnim(id);
    responder = PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gesture) => {
        if (isSelectionModeRef.current) return false;
        return gesture.dx > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5;
      },
      onPanResponderMove: (_evt, gesture) => {
        anim!.setValue(Math.max(0, Math.min(gesture.dx, 80)));
      },
      onPanResponderRelease: (_evt, gesture) => {
        Animated.spring(anim!, { toValue: 0, useNativeDriver: true, friction: 7 }).start();
        if (gesture.dx > 60) {
          const latest = swipeMsgRef.current.get(id);
          if (latest) handleReplyTo(latest);
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(anim!, { toValue: 0, useNativeDriver: true, friction: 7 }).start();
      },
    });
    swipeRespondersRef.current.set(id, responder);
    return responder;
  };

  // Selection mode
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
  isSelectionModeRef.current = isSelectionMode;

  // Editing message ID
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  // Custom Toast Notifier
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2000);
  };

  // Map a raw backend conversation (accessOrCreateChat response) into the same
  // shape chatCache.syncChatsWithBackend produces, so the screen can render it
  // immediately without waiting for a full chat-list re-sync.
  const chatFromConversation = async (conversation: any) => {
    if (!conversation) return null;
    const me = await authStorage.getUser().catch(() => null);
    const myId = String(me?.id || me?._id || '');
    const isGroup = !!conversation.isGroupChat;
    const users = Array.isArray(conversation.users) ? conversation.users : [];
    const other = isGroup ? null : users.find((u: any) => String(u.id || u._id) !== myId);
    return {
      id: String(conversation.id || conversation._id),
      name: isGroup
        ? (conversation.chatName || 'Group Chat')
        : (other?.full_name || other?.username || (paramName as string) || 'Chat'),
      avatar: isGroup ? (conversation.groupIcon || null) : (other?.avatar || (paramAvatar as string) || null),
      isGroupChat: isGroup,
      otherUserId: other ? String(other.id || other._id) : ((paramOtherUserId as string) || null),
      latestMessage: null,
      unreadCount: 0,
      isPinned: false,
      isMuted: false,
      isOnline: !isGroup && !!other?.isOnline,
      username: other?.username || '',
      bio: isGroup ? (conversation.groupDescription || 'Group Chat') : (other?.bio || ''),
      email: other?.email || '',
      messages: [],
      users: isGroup ? conversation.users : undefined,
      groupAdmin: isGroup ? conversation.groupAdmin : undefined,
      status: 'read_own',
    };
  };

  // True once no cache/params/network source could produce a chat — shows the
  // retry state instead of an infinite spinner.
  const [loadFailed, setLoadFailed] = useState(false);

  const loadCachedChatAndMessages = async () => {
    const cachedChats = await chatCache.getCachedChats();
    let foundChat = cachedChats.find((c: any) => String(c.id) === String(id));
    if (!foundChat) {
      foundChat = cachedChats.find((c: any) => !c.isGroupChat && String(c.otherUserId) === String(id));
    }
    if (foundChat) {
      setChat(foundChat);
      setIsMuted(!!foundChat.isMuted);
      setIsChatPinned(!!foundChat.isPinned);
      if (String(foundChat.id) !== String(id)) {
        router.replace(`/chat/${foundChat.id}`);
        return;
      }
    } else if (paramName) {
      // Not cached yet (brand-new DM) but the navigator told us who this is —
      // render the header + empty thread NOW; the sync below fills in the rest.
      setChat({
        id: String(id),
        name: String(paramName),
        avatar: (paramAvatar as string) || null,
        isGroupChat: false,
        otherUserId: (paramOtherUserId as string) || String(id),
        latestMessage: null, unreadCount: 0, isPinned: false, isMuted: false,
        isOnline: false, username: '', bio: '', email: '', messages: [],
        status: 'read_own',
      });
    }
    const cachedMsgs = await chatCache.getCachedMessages(id as string);
    setMessages(cachedMsgs);
  };

  const syncChatAndMessages = async () => {
    try {
      // Flush offline queue if online/reconnected
      await chatCache.processOfflineQueue();

      const cachedChats = await chatCache.getCachedChats();
      let foundChat = cachedChats.find((c: any) => String(c.id) === String(id));
      if (!foundChat) {
        foundChat = cachedChats.find((c: any) => !c.isGroupChat && String(c.otherUserId) === String(id));
      }
      if (foundChat) {
        setChat(foundChat);
        setIsMuted(!!foundChat.isMuted);
        setIsChatPinned(!!foundChat.isPinned);
        if (String(foundChat.id) !== String(id)) {
          router.replace(`/chat/${foundChat.id}`);
          return;
        }
      } else {
        // Resolve user ID via API
        try {
          const res = await accessOrCreateChat(id as string);
          const conversation = res?.conversation || res?.data?.conversation || res?.data || res;
          const actualChatId = conversation?.id || conversation?._id;
          // Render from the response IMMEDIATELY — don't block on the full
          // chat-list re-sync (that runs in the background).
          const direct = await chatFromConversation(conversation);
          if (direct) {
            setChat((prev: any) => prev && String(prev.id) === String(direct.id) ? { ...prev, ...direct } : direct);
            setLoadFailed(false);
          }
          chatCache.syncChatsWithBackend().catch(() => undefined);
          if (actualChatId && String(actualChatId) !== String(id)) {
            router.replace(`/chat/${actualChatId}`);
            return;
          }
        } catch (apiErr) {
          console.warn("Failed to resolve chat via API in ChatScreen:", apiErr);
        }
      }

      const freshMsgs = await chatCache.syncMessagesWithBackend(id as string);
      setMessages(freshMsgs);
    } catch (err) {
      console.warn("Silent sync failed in ChatScreen:", err);
    }
  };

  // Hard stop for the spinner: if nothing resolved the chat after 6s, offer a
  // retry instead of spinning forever (e.g. offline with an uncached chat id).
  useEffect(() => {
    if (chat) { setLoadFailed(false); return; }
    const t = setTimeout(() => {
      if (!chat) setLoadFailed(true);
    }, 6000);
    return () => clearTimeout(t);
  }, [chat, id]);

  useEffect(() => {
    loadCachedChatAndMessages();
    syncChatAndMessages();
    // Resolve E2EE keys for this chat so sends encrypt and incoming decrypt.
    (async () => {
      const user = await authStorage.getUser().catch(() => null);
      const myId = String(user?.id || user?._id || '');
      if (!myId) return;
      cipherRef.current = await prepareChat(String(id), myId).catch(() => null);
      if (cipherRef.current) syncChatAndMessages();
    })();
  }, [id]);

  useEffect(() => {
    const interval = setInterval(syncChatAndMessages, 5000);
    return () => clearInterval(interval);
  }, [id]);

  // Register this chat as the focused one so messages.tsx suppresses in-app
  // notifications while the user is actively reading it.
  useEffect(() => {
    const chatId = chat?.id;
    if (!chatId) return;
    setActiveChatId(String(chatId));
    return () => setActiveChatId(null);
  }, [chat?.id]);

  // Clear the unread badge on open (and whenever new messages land while the chat is open).
  // Tells the backend (which emits `messages_read` so the list zeros the badge) and updates
  // the local cache immediately so it sticks even if the socket round-trip is missed.
  useEffect(() => {
    const chatId = chat?.id;
    if (!chatId) return;
    markMessagesRead(String(chatId)).catch(() => {});
    chatCache.markChatReadLocally(String(chatId));
  }, [chat?.id, messages.length]);

  useEffect(() => {
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, [messages, chat?.status]);

  if (!chat) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }} edges={['top', 'bottom']}>
        {loadFailed ? (
          <>
            <Text style={{ color: INK, fontFamily: 'Poppins_600SemiBold', fontSize: 15, textAlign: 'center' }}>
              Couldn’t load this conversation
            </Text>
            <Text style={{ color: INK_SOFT, fontFamily: 'Poppins_400Regular', fontSize: 12.5, textAlign: 'center', marginTop: 6 }}>
              Check your connection and try again.
            </Text>
            <TouchableOpacity
              onPress={() => { setLoadFailed(false); loadCachedChatAndMessages(); syncChatAndMessages(); }}
              style={{ marginTop: 18, backgroundColor: PURPLE, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 28 }}
            >
              <Text style={{ color: '#fff', fontFamily: 'Poppins_700Bold', fontSize: 13 }}>Retry</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 10, padding: 8 }}>
              <Text style={{ color: INK_SOFT, fontFamily: 'Poppins_600SemiBold', fontSize: 12.5 }}>Go back</Text>
            </TouchableOpacity>
          </>
        ) : (
          <Text style={{ color: INK, fontFamily: 'Poppins_600SemiBold', fontSize: 15 }}>Loading conversation...</Text>
        )}
      </SafeAreaView>
    );
  }

  const getInitials = (name: string) =>
    name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();

  const getGroupInitials = (name: string) => {
    const clean = name.trim().replace(/\s+/g, ' ');
    const parts = clean.split(' ');
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return clean.slice(0, 2).toUpperCase();
  };

  const handleSend = async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    let text = messageText.trim();

    // Capture and clear the reply target up-front so the preview bar dismisses
    // immediately and a follow-up message isn't accidentally sent as a reply.
    const replyTarget = replyingTo;
    const replyParentId = replyTarget ? String((replyTarget as any).id) : undefined;
    setReplyingTo(null);

    const socket = getSocket();
    if (socket && chat) {
      if (typingTimer.current) clearTimeout(typingTimer.current);
      socket.emit('typing_stop', { toUserId: chat.otherUserId, chatId: chat.id });
    }

    try {
      if (editingMessageId) {
        if (!text) return;
        try {
          await updateMessage(editingMessageId, text);
          setEditingMessageId(null);
          setMessageText('');
          showToast("Message edited");
          await syncChatAndMessages();
        } catch (editErr: any) {
          const msg = String(editErr?.message || editErr || '');
          if (msg.includes('Edit window expired') || msg.includes('EDIT_WINDOW_EXPIRED')) {
            showToast("Edit window expired (4 min)");
          } else {
            showToast("Edit failed");
          }
        }
        return;
      }

      if (selectedFile) {
        const fileObj = {
          uri: selectedFile.url || 'https://images.unsplash.com/photo-1548142813-c348350df52b?w=200',
          name: selectedFile.name,
          type: selectedFile.type === 'image' ? 'image/jpeg' : selectedFile.type === 'video' ? 'video/mp4' : 'application/pdf'
        } as any;
        const mediaClientId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        await sendMediaMessage(chat.id, fileObj, { content: text, clientId: mediaClientId, ...(replyParentId && { parent_message: replyParentId }) });
        setMessageText('');
        setSelectedFile(null);
        setIsAttachmentOpen(false);
        setIsEmojiOpen(false);
        await syncChatAndMessages();
      } else {
        if (!text) return;
        // ── Optimistic send: bubble appears immediately, then resolves to ✓ or marks as failed.
        const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const tempMsg = {
          id: tempId,
          text,
          sender: 'me',
          senderName: 'Me',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          timestamp: new Date().toISOString(),
          reactions: [],
          isPinned: false,
          isRead: false,
          status: 'sending',
          parent_message: replyTarget ? {
            id: replyParentId,
            content: replyTarget.text || '[Media]',
            sender: { full_name: replyTarget.senderName || null },
          } : null,
        } as any;
        setMessages(prev => [...prev, tempMsg]);
        setMessageText('');
        setIsAttachmentOpen(false);
        setIsEmojiOpen(false);

        // E2EE: encrypt at compose time so both the live send AND any offline
        // queue retry carry ciphertext. The optimistic bubble keeps plaintext.
        const cipher = cipherRef.current;
        const wire = cipher ? await encryptForChat(cipher, text) : text;

        try {
          await sendTextMessage(chat.id, wire, { clientId: tempId, is_encrypted: !!cipher, ...(replyParentId && { parent_message: replyParentId }) });
          // Mark as sent; sync will reconcile the server id shortly.
          setMessages(prev => prev.map((m: any) =>
            m.id === tempId ? { ...m, status: 'sent' } : m
          ));
          await syncChatAndMessages();
        } catch (sendErr) {
          console.warn("API send failed, queuing offline:", sendErr);
          // Reuse tempId as the queue item's clientId — if the original request actually
          // reached the server and only the response was lost, the retry carries the same
          // clientId and the backend's unique index returns the existing message instead
          // of creating a duplicate.
          const queueId = await chatCache.addToOfflineQueue(chat.id, wire, tempId, !!cipher);
          setMessages(prev => prev.map((m: any) =>
            m.id === tempId ? { ...m, id: queueId, status: 'queued' } : m
          ));
          await chatCache.saveMessageLocally(chat.id, { ...tempMsg, id: queueId, status: 'queued' });
        }
      }
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to send message.");
    } finally {
      sendingRef.current = false;
    }
  };

  // Deduplicate members by ID before computing count — prevents double-counting
  // when the backend returns overlapping entries in both `users` and `members`.
  const rawChatMembers = chat.isGroupChat ? [...(chat.users || []), ...(chat.members || [])] : []
  const uniqueMemberIds = [...new Set(rawChatMembers.map((m: any) => String(m._id || m.id || m.username || m.email || '')).filter(Boolean))]
  const memberCount = uniqueMemberIds.length
  const statusLine = chat.status === 'typing'
    ? 'typing…'
    : (isPeerOnline && !chat.isGroupChat)
      ? 'Online'
      : chat.isGroupChat
        ? `${memberCount > 0 ? memberCount : ''} member${memberCount !== 1 ? 's' : ''}`.trim()
        : 'Offline'

  const filteredMessages = messages.filter(msg => {
    const isSystem = msg.isSystem || msg.message_type === 'system' || msg.is_announcement || msg.sender === 'system';

    // ── NEW ──
    if (chat?.isGroupChat && msg.senderIsBot) {
      return false;
    }

    if (!searchQuery.trim()) return true;
    if (isSystem) return false;
    return msg.text.toLowerCase().includes(searchQuery.toLowerCase());
  });

  const imageMessages = messages.filter(msg =>
    msg.message_type === 'image' &&
    (msg.mediaUrl || msg.media_url) &&
    !msg.isSystem &&
    msg.sender !== 'system' &&
    !(chat?.isGroupChat && msg.senderIsBot)
  );

  const handleReactMessage = async (messageId: string, emoji: string) => {
    try {
      await reactToMessage(messageId, emoji);
      await syncChatAndMessages();
    } catch (err) {
      showToast("Reaction failed");
    }
    setActiveContextMessage(null);
  };

  const handleTogglePinMessage = async (messageId: string) => {
    try {
      await toggleMessagePin(messageId);
      showToast("Message pin toggled");
      await syncChatAndMessages();
    } catch (err) {
      showToast("Pin failed");
    }
    setActiveContextMessage(null);
  };

  const handleDeleteMessage = async (messageId: string) => {
    try {
      await deleteMessageForMe(messageId);
      showToast("Message deleted");
      await syncChatAndMessages();
    } catch (err) {
      showToast("Delete failed");
    }
    setActiveContextMessage(null);
  };

  const handleDeleteForEveryone = async (messageId: string) => {
    setActiveContextMessage(null);
    // Mark as deleting (greyed out) without removing — only drop on success.
    setMessages(prev => prev.map((m: any) =>
      m.id === messageId ? { ...m, status: 'deleting' } : m
    ));
    try {
      await deleteMessageForEveryone(messageId);
      setMessages(prev => prev.filter(m => m.id !== messageId));
      showToast("Deleted for everyone");
    } catch (err) {
      setMessages(prev => prev.map((m: any) =>
        m.id === messageId ? { ...m, status: undefined } : m
      ));
      showToast("Delete failed");
    }
  };

  const handleEditMessage = (msg: Message) => {
    setEditingMessageId(msg.id);
    setMessageText(msg.text);
    setActiveContextMessage(null);
  };

  const handleReplyTo = (msg: Message) => {
    setReplyingTo(msg);
    setActiveContextMessage(null);
    inputRef.current?.focus();
  };

  // ── Voice note recording (real microphone via expo-audio) ──
  const startRecording = async () => {
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Microphone needed', 'Enable microphone access to send voice messages.');
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      setIsRecording(true);
    } catch (err: any) {
      console.warn('startRecording failed:', err);
      Alert.alert('Recording error', err?.message || 'Could not start recording.');
      setIsRecording(false);
    }
  };

  const cancelRecording = async () => {
    setIsRecording(false);
    try { await audioRecorder.stop(); } catch { /* ignore */ }
  };

  const stopAndSendRecording = async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    const durationSecs = recordingSeconds;
    const replyTarget = replyingTo;
    const replyParentId = replyTarget ? String((replyTarget as any).id) : undefined;
    setReplyingTo(null);
    setIsRecording(false);
    try {
      await audioRecorder.stop();
      const uri = audioRecorder.uri;
      if (!uri) throw new Error('No audio was captured.');
      await sendMediaMessage(
        chat.id,
        { uri, name: `voice-${Date.now()}.m4a`, type: 'audio/m4a' } as any,
        {
          message_type: 'voice',
          media_duration: durationSecs,
          ...(replyParentId && { parent_message: replyParentId }),
        }
      );
      await syncChatAndMessages();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to send voice message.');
    } finally {
      try { await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }); } catch { /* ignore */ }
      sendingRef.current = false;
    }
  };

  const handleToggleMessageSelect = (msgId: string) => {
    setSelectedMessageIds(prev =>
      prev.includes(msgId) ? prev.filter(id => id !== msgId) : [...prev, msgId]
    );
  };

  const handleForwardMessage = async (targetChatId: string) => {
    if (!forwardingMessage) return;
    if (sendingRef.current) return;
    sendingRef.current = true;
    setIsForwardLoading(targetChatId);
    try {
      const isMedia = forwardingMessage.message_type && forwardingMessage.message_type !== 'text';
      if (isMedia && (forwardingMessage.mediaUrl || forwardingMessage.media_url)) {
        const secureUrl = getSecureMediaUrl(forwardingMessage.mediaUrl || forwardingMessage.media_url);
        const fileName = forwardingMessage.text || 'forwarded_file';
        const fileObj = {
          uri: secureUrl,
          name: fileName,
          type: forwardingMessage.message_type === 'image'
            ? 'image/jpeg'
            : forwardingMessage.message_type === 'video'
              ? 'video/mp4'
              : 'application/pdf',
        } as any;
        await sendMediaMessage(targetChatId, fileObj, { content: forwardingMessage.text || '' });
      } else {
        await sendTextMessage(targetChatId, forwardingMessage.text);
      }
      showToast("Message forwarded");
      setForwardedChatIds(prev => [...prev, targetChatId]);
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to forward message.");
    } finally {
      setIsForwardLoading(null);
      sendingRef.current = false;
    }
  };

  const renderedItems: Array<{ type: 'divider'; id: string; text: string } | { type: 'message'; id: string; data: Message }> = [];
  let lastDateText = '';

  const formatDividerDate = (date: Date) => {
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return '';
    const options: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'short', day: 'numeric' };
    return d.toLocaleDateString('en-US', options);
  };

  filteredMessages.forEach(msg => {
    const msgDate = msg.timestamp ? new Date(msg.timestamp) : new Date();
    const dateText = formatDividerDate(msgDate);
    if (dateText && dateText !== lastDateText) {
      renderedItems.push({
        type: 'divider',
        id: `div-${msg.id}-${dateText}`,
        text: dateText,
      });
      lastDateText = dateText;
    }
    renderedItems.push({
      type: 'message',
      id: msg.id,
      data: msg,
    });
  });

  if (isInfoOpen) {
    const isGroupAdmin = chat.isGroupChat && chat.groupAdmin && String(chat.groupAdmin.id || chat.groupAdmin._id || chat.groupAdmin) === String(currentUserIdRef.current);
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
        {/* Page Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <TouchableOpacity onPress={() => setIsInfoOpen(false)} style={{ padding: 6, marginRight: 10 }}>
            <ChevronLeft size={24} color={PURPLE} />
          </TouchableOpacity>
          <View>
            <Text style={{ fontSize: 19, fontFamily: 'SpaceGrotesk_700Bold', color: INK }}>Information</Text>
            <Text style={{ fontSize: 12, fontFamily: 'Poppins_400Regular', color: INK_SOFT, marginTop: 1 }}>
              {chat.isGroupChat ? 'Group Details' : 'Contact Details'}
            </Text>
          </View>
        </View>

        <ScrollView style={{ flex: 1, paddingHorizontal: 20, paddingTop: 20 }} showsVerticalScrollIndicator={false}>
          {/* Profile Card */}
          <TouchableOpacity
            disabled={!isGroupAdmin}
            onPress={handleStartEditGroup}
            activeOpacity={isGroupAdmin ? 0.7 : 1}
            style={{ alignItems: 'center', backgroundColor: colors.card, borderRadius: 24, padding: 24, borderWidth: 1, borderColor: colors.border, marginBottom: 20 }}
          >
            <View style={{ marginBottom: 14 }}>
              <Avatar
                url={chat.avatar}
                name={chat.name || chat.organization}
                size={76}
                isGroup={!!(chat.isGroupChat || chat.organization)}
                style={{ borderRadius: 22 }}
                imageStyle={{ borderRadius: 22 }}
              />
            </View>
            <Text style={{ fontSize: 20, fontFamily: 'SpaceGrotesk_700Bold', color: INK, textAlign: 'center' }}>{chat.name}</Text>
            <Text style={{ fontSize: 13.5, fontFamily: 'Poppins_700Bold', color: PURPLE, marginTop: 4 }}>
              @{chat.isGroupChat ? 'group_' + chat.name.toLowerCase().replace(/\s/g, '_') : chat.name.toLowerCase().replace(/\s/g, '_')}
            </Text>
            {!chat.isGroupChat && chat.otherUserId && (
              editingNickname ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
                  <TextInput
                    autoFocus
                    value={nicknameDraft}
                    onChangeText={setNicknameDraft}
                    placeholder={chat.realName || chat.name}
                    style={{ fontSize: 13.5, fontFamily: 'Poppins_600SemiBold', color: INK, textAlign: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, minWidth: 160 }}
                  />
                  <TouchableOpacity
                    onPress={async () => {
                      await saveNickname(chat.otherUserId, nicknameDraft);
                      setEditingNickname(false);
                      chatCache.syncChatsWithBackend();
                    }}
                    style={{ paddingHorizontal: 10, paddingVertical: 8 }}
                  >
                    <Check size={18} color={PURPLE} />
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity
                  onPress={() => {
                    setNicknameDraft('');
                    setEditingNickname(true);
                  }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}
                >
                  <Text style={{ fontSize: 11.5, fontFamily: 'Poppins_500Medium', color: INK_SOFT }}>Save as...</Text>
                  <Edit2 size={11} color={INK_SOFT} />
                </TouchableOpacity>
              )
            )}
            <Text style={{ fontSize: 13, fontFamily: 'Poppins_400Regular', color: INK_SOFT, textAlign: 'center', marginTop: 10, lineHeight: 20, paddingHorizontal: 10 }}>
              {chat.bio}
            </Text>
          </TouchableOpacity>

          {/* Info Cards - Only displayed for 1-on-1 chats */}
          {!chat.isGroupChat && (
            <>
              <InfoCard icon={<Mail size={19} color={PURPLE} />} label="Email Address" value={chat.email} />
              <InfoCard icon={<Phone size={19} color={PURPLE} />} label="Phone Number" value={chat.phone} />
              <InfoCard icon={<Briefcase size={19} color={PURPLE} />} label="Organization & Role" value={`${chat.organization} · ${chat.org_role}`} />
            </>
          )}


          {/* Group Invite Code Card */}
          {chat.isGroupChat && chat.inviteCode && (() => {
            const isGroupAdmin = chat.groupAdmin && String(chat.groupAdmin.id || chat.groupAdmin._id || chat.groupAdmin) === String(currentUserIdRef.current);
            if (isGroupAdmin || (chat.allowMembersToShareInvite ?? true)) {
              return (
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.card, padding: 16, borderRadius: 18, borderWidth: 1, borderColor: colors.border, marginBottom: 10 }}>
                  <View style={{ flex: 1, marginRight: 10 }}>
                    <Text style={{ fontSize: 10, fontFamily: 'Poppins_700Bold', color: INK_SOFT, textTransform: 'uppercase', letterSpacing: 1 }}>Group Invite Code</Text>
                    <Text style={{ fontSize: 11.5, fontFamily: 'Poppins_500Medium', color: INK_SOFT, marginTop: 2 }}>Anyone with this code can join the group</Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => {
                      Clipboard.setString(chat.inviteCode);
                      Alert.alert("Copied", "Group invite code copied to clipboard!");
                    }}
                    style={{ backgroundColor: colors.surface, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, borderWidth: 1, borderColor: colors.border, flexDirection: 'row', alignItems: 'center' }}
                  >
                    <Copy size={12} color={PURPLE} style={{ marginRight: 4 }} />
                    <Text style={{ fontSize: 13, fontFamily: 'Poppins_700Bold', color: PURPLE }}>{chat.inviteCode}</Text>
                  </TouchableOpacity>
                </View>
              );
            }
            return null;
          })()}

          {/* List group members */}
          {chat.isGroupChat && (() => {
            // Deduplicate members across both `users` and `members` arrays
            const allRawMembers = [...(chat.users || []), ...(chat.members || [])]
            const seenIds = new Set<string>()
            const uniqueMembers = allRawMembers.filter((m: any) => {
              const id = String(m._id || m.id || m.username || m.email || '')
              if (!id || seenIds.has(id)) return false
              seenIds.add(id)
              return true
            })
            if (uniqueMembers.length === 0) return null
            const displayedMembers = showAllMembers ? uniqueMembers : uniqueMembers.slice(0, 3);
            return (
              <View style={{ marginBottom: 20 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 20, marginBottom: 10 }}>
                  <Text style={{ fontSize: 13, fontFamily: 'SpaceGrotesk_700Bold', color: INK, textTransform: 'uppercase', letterSpacing: 1 }}>
                    Group Members ({uniqueMembers.length})
                  </Text>
                  {uniqueMembers.length > 3 && (
                    <TouchableOpacity
                      onPress={() => setShowAllMembers(!showAllMembers)}
                      style={{ backgroundColor: colors.purpleSoft, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 }}
                    >
                      <Text style={{ fontSize: 10.5, fontFamily: 'Poppins_700Bold', color: PURPLE }}>
                        {showAllMembers ? 'Show Less' : `View All (+${uniqueMembers.length - 3})`}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
                <View style={{ gap: 10 }}>
                  {displayedMembers.map((member: any) => {
                    const isAdmin = chat.groupAdmin && String(member.id || member._id || member) === String(chat.groupAdmin.id || chat.groupAdmin._id || chat.groupAdmin);
                    return (
                      <TouchableOpacity
                        key={member.id || member._id || member}
                        activeOpacity={0.7}
                        onPress={() => setSelectedMember({ ...member, isAdmin })}
                        style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, padding: 12, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(0,0,0,0.03)' }}
                      >
                        <Avatar
                          url={member.avatar}
                          name={getDisplayName(member)}
                          size={36}
                          style={{ borderRadius: 10 }}
                          imageStyle={{ borderRadius: 10 }}
                        />
                        <View style={{ marginLeft: 12, flex: 1 }}>
                          <Text style={{ fontSize: 13.5, fontFamily: 'Poppins_600SemiBold', color: INK }}>
                            {getDisplayName(member)}
                          </Text>
                        </View>
                        {isAdmin && (
                          <View style={{ backgroundColor: 'rgba(108,92,231,0.15)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, marginRight: 6 }}>
                            <Text style={{ fontSize: 10, fontFamily: 'Poppins_700Bold', color: PURPLE, textTransform: 'uppercase' }}>Admin</Text>
                          </View>
                        )}
                        <ChevronLeft size={16} color={INK_SOFT} style={{ transform: [{ rotate: '180deg' }] }} />
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            );
          })()}

          {/* Dynamic Shared Resources / Storage center */}
          <Text style={{ fontSize: 13, fontFamily: 'SpaceGrotesk_700Bold', color: INK, marginTop: 20, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
            {chat.isGroupChat ? 'Shared Resources' : 'Storage Center'}
          </Text>

          {(() => {
            const mediaSummary = countMedia(messages);
            const accordionSections = [
              {
                key: 'photos', label: `Photos & Videos (${mediaSummary.images + mediaSummary.videos})`, icon: <ImageIcon size={16} color={PURPLE} />, items: [
                  ...mediaSummary.imageUrls.map((url, idx) => ({ label: `Photo ${idx + 1}`, url })),
                  ...mediaSummary.videoItems.map(item => ({ label: item.label, url: item.url }))
                ]
              },
              {
                key: 'voice', label: `Voice Notes & Audio (${mediaSummary.voice + mediaSummary.audio})`, icon: <Mic size={16} color={PURPLE} />, items: [
                  ...mediaSummary.voiceItems.map(item => ({ label: item.label, url: item.url })),
                  ...mediaSummary.audioItems.map(item => ({ label: item.label, url: item.url }))
                ]
              },
              { key: 'links', label: `Links (${mediaSummary.linkItems.length})`, icon: <Sparkles size={16} color={PURPLE} />, items: mediaSummary.linkItems },
              { key: 'files', label: `Documents & Files (${mediaSummary.files})`, icon: <FileText size={16} color={PURPLE} />, items: mediaSummary.fileItems },
            ];

            return accordionSections.map((section) => {
              const isOpen = openSection === section.key;
              return (
                <View key={section.key} style={{ backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(0,0,0,0.04)', marginBottom: 8, overflow: 'hidden' }}>
                  <TouchableOpacity
                    onPress={() => setOpenSection(isOpen ? null : section.key)}
                    activeOpacity={0.7}
                    style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14 }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      {section.icon}
                      <Text style={{ fontSize: 13, fontFamily: 'Poppins_600SemiBold', color: INK }}>
                        {section.label}
                      </Text>
                    </View>
                    <ChevronLeft size={16} color={INK_SOFT} style={{ transform: [{ rotate: isOpen ? '-90deg' : '0deg' }] }} />
                  </TouchableOpacity>

                  {isOpen && (
                    <View style={{ paddingHorizontal: 14, paddingBottom: 14, borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.04)', paddingTop: 10 }}>
                      {section.items.length === 0 ? (
                        <Text style={{ fontSize: 12, fontFamily: 'Poppins_400Regular', color: INK_SOFT, fontStyle: 'italic' }}>
                          No shared items yet.
                        </Text>
                      ) : (
                        section.items.map((item, idx) => (
                          <TouchableOpacity
                            key={idx}
                            onPress={() => {
                              import('react-native').then(({ Linking }) => {
                                const secureUrl = getSecureMediaUrl(item.url);
                                if (secureUrl) Linking.openURL(secureUrl).catch(() => { });
                              });
                            }}
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 }}
                          >
                            <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: PURPLE }} />
                            <Text numberOfLines={1} style={{ fontSize: 12.5, fontFamily: 'Poppins_500Medium', color: PURPLE, textDecorationLine: 'underline', flex: 1 }}>
                              {item.label}
                            </Text>
                          </TouchableOpacity>
                        ))
                      )}
                    </View>
                  )}
                </View>
              );
            });
          })()}

          <TouchableOpacity
            onPress={() => setIsInfoOpen(false)}
            style={{ marginTop: 28, backgroundColor: PURPLE, paddingVertical: 16, borderRadius: 18, alignItems: 'center', shadowColor: PURPLE, shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 5, marginBottom: 32 }}
          >
            <Text style={{ color: '#ffffff', fontFamily: 'Poppins_700Bold', fontSize: 14 }}>Back to Chat</Text>
          </TouchableOpacity>
        </ScrollView>

        {/* ── Group Member Profile Modal ── */}
        <Modal visible={selectedMember !== null} animationType="slide" presentationStyle="pageSheet">
          <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}>
              <View>
                <Text style={{ fontSize: 19, fontFamily: 'SpaceGrotesk_700Bold', color: INK }}>Profile</Text>
                <Text style={{ fontSize: 12, fontFamily: 'Poppins_400Regular', color: INK_SOFT, marginTop: 1 }}>Group member</Text>
              </View>
              <TouchableOpacity onPress={() => setSelectedMember(null)} style={{ padding: 6 }}>
                <X size={20} color={PURPLE} />
              </TouchableOpacity>
            </View>

            {selectedMember && (
              <ScrollView style={{ flex: 1, paddingHorizontal: 20, paddingTop: 20 }} showsVerticalScrollIndicator={false}>
                {/* Hero */}
                <View style={{ alignItems: 'center', backgroundColor: colors.card, borderRadius: 24, padding: 24, borderWidth: 1, borderColor: colors.border, marginBottom: 20 }}>
                  <View style={{ marginBottom: 14 }}>
                    <Avatar
                      url={selectedMember.avatar}
                      name={getDisplayName(selectedMember)}
                      size={76}
                      style={{ borderRadius: 22 }}
                      imageStyle={{ borderRadius: 22 }}
                    />
                  </View>
                  {editingNickname ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                      <TextInput
                        autoFocus
                        value={nicknameDraft}
                        onChangeText={setNicknameDraft}
                        placeholder={selectedMember.full_name || selectedMember.username}
                        style={{ fontSize: 15, fontFamily: 'Poppins_700Bold', color: INK, textAlign: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, minWidth: 160 }}
                      />
                      <TouchableOpacity
                        onPress={async () => {
                          const memberId = String(selectedMember.id || selectedMember._id);
                          await saveNickname(memberId, nicknameDraft);
                          setEditingNickname(false);
                        }}
                        style={{ paddingHorizontal: 10, paddingVertical: 8 }}
                      >
                        <Check size={18} color={PURPLE} />
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <TouchableOpacity
                      onPress={() => {
                        setNicknameDraft('');
                        setEditingNickname(true);
                      }}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
                    >
                      <Text style={{ fontSize: 20, fontFamily: 'SpaceGrotesk_700Bold', color: INK, textAlign: 'center' }}>
                        {getDisplayName(selectedMember)}
                      </Text>
                      <Edit2 size={13} color={INK_SOFT} />
                    </TouchableOpacity>
                  )}
                  {selectedMember.isAdmin && (
                    <View style={{ backgroundColor: 'rgba(108,92,231,0.15)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, marginTop: 10 }}>
                      <Text style={{ fontSize: 10, fontFamily: 'Poppins_700Bold', color: PURPLE, textTransform: 'uppercase', letterSpacing: 1 }}>Group Admin</Text>
                    </View>
                  )}
                </View>

                {/* Detail cards */}
                {!!selectedMember.email && (
                  <InfoCard icon={<Mail size={19} color={PURPLE} />} label="Email Address" value={selectedMember.email} />
                )}
                {!!selectedMember.phone_number && (
                  <InfoCard icon={<Phone size={19} color={PURPLE} />} label="Phone Number" value={selectedMember.phone_number} />
                )}
                {(!!selectedMember.organization || !!selectedMember.org_role) && (
                  <InfoCard
                    icon={<Briefcase size={19} color={PURPLE} />}
                    label="Organization & Role"
                    value={[selectedMember.organization, selectedMember.org_role].filter(Boolean).join(' · ')}
                  />
                )}

                {/* Quick actions */}
                {String(selectedMember.id || selectedMember._id) !== String(currentUserIdRef.current) && (
                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                    <TouchableOpacity
                      onPress={() => {
                        const m = selectedMember;
                        const memberId = String(m.id || m._id);
                        setSelectedMember(null);
                        setIsInfoOpen(false);
                        // Navigate immediately with the member's context — the chat
                        // screen resolves/creates the conversation itself.
                        router.push({
                          pathname: `/chat/${memberId}` as any,
                          params: { name: getDisplayName(m), avatar: m.avatar || '', otherUserId: memberId },
                        });
                      }}
                      style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: PURPLE, borderRadius: 16, paddingVertical: 14 }}
                    >
                      <MessageSquare size={16} color="#fff" />
                      <Text style={{ color: '#fff', fontFamily: 'Poppins_700Bold', fontSize: 13 }}>Message</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => {
                        const m = selectedMember;
                        const memberId = String(m.id || m._id);
                        setSelectedMember(null);
                        startOutgoingCall({ id: memberId, otherUserId: memberId, name: getDisplayName(m), avatar: m.avatar }, 'voice');
                      }}
                      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: PURPLE_SOFT, borderWidth: 1, borderColor: 'rgba(108,92,231,0.2)', borderRadius: 16, paddingVertical: 14, paddingHorizontal: 18 }}
                    >
                      <Phone size={16} color={PURPLE} />
                      <Text style={{ color: PURPLE, fontFamily: 'Poppins_700Bold', fontSize: 13 }}>Call</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => {
                        const m = selectedMember;
                        const memberId = String(m.id || m._id);
                        setSelectedMember(null);
                        startOutgoingCall({ id: memberId, otherUserId: memberId, name: getDisplayName(m), avatar: m.avatar }, 'video');
                      }}
                      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: PURPLE_SOFT, borderWidth: 1, borderColor: 'rgba(108,92,231,0.2)', borderRadius: 16, paddingVertical: 14, paddingHorizontal: 18 }}
                    >
                      <Video size={16} color={PURPLE} />
                      <Text style={{ color: PURPLE, fontFamily: 'Poppins_700Bold', fontSize: 13 }}>Video</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </ScrollView>
            )}
          </SafeAreaView>
        </Modal>

        {/* Edit Group Info Modal */}
        <Modal visible={isEditingGroup} animationType="slide" presentationStyle="pageSheet">
          <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}>
              <View>
                <Text style={{ fontSize: 19, fontFamily: 'SpaceGrotesk_700Bold', color: INK }}>Edit Group Info</Text>
                <Text style={{ fontSize: 12, fontFamily: 'Poppins_400Regular', color: INK_SOFT, marginTop: 1 }}>Update group details</Text>
              </View>
              <TouchableOpacity onPress={() => setIsEditingGroup(false)}>
                <X color={PURPLE} size={20} />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ flex: 1, paddingHorizontal: 20, paddingTop: 20 }} showsVerticalScrollIndicator={false}>
              <View style={{ backgroundColor: colors.card, borderRadius: 24, padding: 20, borderWidth: 1, borderColor: colors.border, marginBottom: 20 }}>
                <View style={{ marginBottom: 16 }}>
                  <Text style={{ fontSize: 11, fontFamily: 'Poppins_700Bold', color: INK, textTransform: 'uppercase', marginBottom: 6 }}>Group Avatar</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingBottom: 5 }}>
                    {AVATARS.map((url) => (
                      <TouchableOpacity
                        key={url}
                        onPress={() => setGroupFormData({ ...groupFormData, groupIcon: url })}
                        style={{
                          width: 54,
                          height: 54,
                          borderRadius: 16,
                          borderWidth: groupFormData.groupIcon === url ? 3 : 0,
                          borderColor: PURPLE,
                          overflow: 'hidden',
                        }}
                      >
                        <Image source={{ uri: url }} style={{ width: '100%', height: '100%' }} />
                      </TouchableOpacity>
                    ))}
                  </ScrollView>

                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                    <TouchableOpacity
                      onPress={async () => {
                        const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
                        if (!permissionResult.granted) {
                          Alert.alert("Permission Denied", "Camera roll permissions are required to choose a group icon.");
                          return;
                        }

                        const pickerResult = await ImagePicker.launchImageLibraryAsync({
                          mediaTypes: ImagePicker.MediaTypeOptions.Images,
                          allowsEditing: true,
                          quality: 0.8,
                        });

                        if (pickerResult.canceled) return;
                        const uri = pickerResult.assets[0].uri;
                        try {
                          const uploadedUrl = await uploadGroupOrOrgImage(uri);
                          setGroupFormData({ ...groupFormData, groupIcon: uploadedUrl });
                          Alert.alert("Success", "Custom avatar uploaded!");
                        } catch (err: any) {
                          Alert.alert("Error", err.message || "Failed to upload image.");
                        }
                      }}
                      style={{
                        flex: 1,
                        backgroundColor: PURPLE_SOFT,
                        borderWidth: 1,
                        borderColor: 'rgba(108,92,231,0.2)',
                        borderRadius: 12,
                        paddingVertical: 10,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Text style={{ color: PURPLE, fontSize: 11, fontFamily: 'Poppins_700Bold' }}>Upload Custom</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      onPress={() => {
                        setGroupFormData({ ...groupFormData, groupIcon: '' });
                      }}
                      style={{
                        flex: 1,
                        backgroundColor: 'rgba(239,68,68,0.05)',
                        borderWidth: 1,
                        borderColor: 'rgba(239,68,68,0.1)',
                        borderRadius: 12,
                        paddingVertical: 10,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Text style={{ color: '#ef4444', fontSize: 11, fontFamily: 'Poppins_700Bold' }}>Remove Avatar</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={{ marginBottom: 16 }}>
                  <Text style={{ fontSize: 11, fontFamily: 'Poppins_700Bold', color: INK, textTransform: 'uppercase', marginBottom: 6 }}>Group Name</Text>
                  <TextInput
                    value={groupFormData.chatName}
                    onChangeText={(t) => setGroupFormData({ ...groupFormData, chatName: t })}
                    style={{ backgroundColor: colors.surface, borderRadius: 16, padding: 14, color: INK, borderWidth: 1, borderColor: colors.border }}
                  />
                </View>

                <View style={{ marginBottom: 16 }}>
                  <Text style={{ fontSize: 11, fontFamily: 'Poppins_700Bold', color: INK, textTransform: 'uppercase', marginBottom: 6 }}>Description / Bio</Text>
                  <TextInput
                    value={groupFormData.groupDescription}
                    onChangeText={(t) => setGroupFormData({ ...groupFormData, groupDescription: t })}
                    style={{ backgroundColor: colors.surface, borderRadius: 16, padding: 14, color: INK, borderWidth: 1, borderColor: colors.border, minHeight: 80 }}
                    multiline
                    textAlignVertical="top"
                  />
                </View>

                {/* Admin Permission Switch */}
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <View style={{ flex: 1, paddingRight: 10 }}>
                    <Text style={{ fontSize: 11, fontFamily: 'Poppins_700Bold', color: INK, textTransform: 'uppercase' }}>Admin Permission</Text>
                    <Text style={{ fontSize: 10.5, color: INK_SOFT, marginTop: 2 }}>Allow members to share invite</Text>
                  </View>
                  <Switch
                    value={groupFormData.allowMembersToShareInvite}
                    onValueChange={(val) => setGroupFormData({ ...groupFormData, allowMembersToShareInvite: val })}
                    trackColor={{ false: "#e2e8f0", true: PURPLE }}
                    thumbColor={Platform.OS === 'ios' ? undefined : groupFormData.allowMembersToShareInvite ? PURPLE : "#f4f3f4"}
                  />
                </View>

                {/* Member limit */}
                <View style={{ marginBottom: 16 }}>
                  <Text style={{ fontSize: 11, fontFamily: 'Poppins_700Bold', color: INK, textTransform: 'uppercase', marginBottom: 6 }}>Member Limit</Text>
                  <TextInput
                    value={groupFormData.maxMembers ? String(groupFormData.maxMembers) : ''}
                    onChangeText={(t) => setGroupFormData({ ...groupFormData, maxMembers: parseInt(t.replace(/[^0-9]/g, ''), 10) || 0 })}
                    keyboardType="number-pad"
                    placeholder="0 = unlimited"
                    placeholderTextColor={INK_SOFT}
                    style={{ backgroundColor: colors.surface, borderRadius: 16, padding: 14, color: INK, borderWidth: 1, borderColor: colors.border }}
                  />
                  <Text style={{ fontSize: 10.5, color: INK_SOFT, marginTop: 4 }}>
                    Cap how many people can join. Currently {memberCount} member(s).
                  </Text>
                </View>

                {/* Meeting transcript policy */}
                <View style={{ marginBottom: 16 }}>
                  <Text style={{ fontSize: 11, fontFamily: 'Poppins_700Bold', color: INK, textTransform: 'uppercase', marginBottom: 6 }}>Meeting Transcripts</Text>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    {([
                      { key: 'email', label: 'Email members' },
                      { key: 'save', label: 'Save only' },
                      { key: 'off', label: 'Off' },
                    ] as const).map((opt) => {
                      const active = groupFormData.transcriptPolicy === opt.key;
                      return (
                        <TouchableOpacity
                          key={opt.key}
                          onPress={() => setGroupFormData({ ...groupFormData, transcriptPolicy: opt.key })}
                          style={{ flex: 1, backgroundColor: active ? PURPLE : 'rgba(108,92,231,0.08)', borderRadius: 12, paddingVertical: 10, alignItems: 'center' }}
                        >
                          <Text style={{ color: active ? '#fff' : INK_SOFT, fontSize: 11, fontFamily: 'Poppins_600SemiBold' }}>{opt.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                  <Text style={{ fontSize: 10.5, color: INK_SOFT, marginTop: 4 }}>
                    How this group's meeting transcripts are handled when a call ends.
                  </Text>
                </View>

                {/* Group resources */}
                <View style={{ marginBottom: 16 }}>
                  <Text style={{ fontSize: 11, fontFamily: 'Poppins_700Bold', color: INK, textTransform: 'uppercase', marginBottom: 6 }}>Resources</Text>
                  {groupFormData.resources.length > 0 && (
                    <View style={{ gap: 8, marginBottom: 10 }}>
                      {groupFormData.resources.map((r, idx) => (
                        <View key={idx} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10 }}>
                          <View style={{ flex: 1, marginRight: 8 }}>
                            <Text style={{ fontSize: 12.5, fontFamily: 'Poppins_600SemiBold', color: INK }} numberOfLines={1}>{r.label}</Text>
                            {!!r.url && <Text style={{ fontSize: 10.5, color: PURPLE }} numberOfLines={1}>{r.url}</Text>}
                          </View>
                          <TouchableOpacity
                            onPress={() => setGroupFormData({ ...groupFormData, resources: groupFormData.resources.filter((_, i) => i !== idx) })}
                            style={{ padding: 4 }}
                          >
                            <X size={15} color="#ef4444" />
                          </TouchableOpacity>
                        </View>
                      ))}
                    </View>
                  )}
                  <View style={{ gap: 8 }}>
                    <TextInput
                      value={newResLabel}
                      onChangeText={setNewResLabel}
                      placeholder="Label (e.g. Brand kit)"
                      placeholderTextColor={INK_SOFT}
                      style={{ backgroundColor: colors.surface, borderRadius: 12, padding: 12, color: INK, borderWidth: 1, borderColor: colors.border }}
                    />
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <TextInput
                        value={newResUrl}
                        onChangeText={setNewResUrl}
                        placeholder="https://…"
                        placeholderTextColor={INK_SOFT}
                        autoCapitalize="none"
                        style={{ flex: 1, backgroundColor: colors.surface, borderRadius: 12, padding: 12, color: INK, borderWidth: 1, borderColor: colors.border }}
                      />
                      <TouchableOpacity
                        onPress={() => {
                          if (!newResLabel.trim() || !newResUrl.trim()) {
                            Alert.alert('Add resource', 'Enter both a label and a URL.');
                            return;
                          }
                          setGroupFormData({
                            ...groupFormData,
                            resources: [...groupFormData.resources, { label: newResLabel.trim(), url: newResUrl.trim(), type: 'link' }],
                          });
                          setNewResLabel('');
                          setNewResUrl('');
                        }}
                        style={{ backgroundColor: PURPLE_SOFT, borderWidth: 1, borderColor: 'rgba(108,92,231,0.2)', borderRadius: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' }}
                      >
                        <Text style={{ color: PURPLE, fontSize: 12, fontFamily: 'Poppins_700Bold' }}>Add</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                  <Text style={{ fontSize: 10.5, color: INK_SOFT, marginTop: 4 }}>
                    Links/docs that give this group's AI helpful context.
                  </Text>
                </View>

                <TouchableOpacity
                  onPress={async () => {
                    const memberCount = chat?.users?.length || 0;
                    if (groupFormData.maxMembers > 0 && groupFormData.maxMembers < memberCount) {
                      Alert.alert('Member limit too low', `The cap can't be below the current ${memberCount} member(s).`);
                      return;
                    }
                    try {
                      const { updateGroupSettings } = await import('../../../lib/api');
                      const res = await updateGroupSettings(chat.id, {
                        chatName: groupFormData.chatName.trim(),
                        groupDescription: groupFormData.groupDescription.trim(),
                        groupIcon: groupFormData.groupIcon,
                        maxMembers: groupFormData.maxMembers,
                        transcriptPolicy: groupFormData.transcriptPolicy,
                        allowMembersToShareInvite: groupFormData.allowMembersToShareInvite,
                        resources: groupFormData.resources,
                      });
                      if (res?.conversation) {
                        setChat(res.conversation);
                        await chatCache.patchCachedChat(String(chat.id), {
                          groupIcon: res.conversation.groupIcon,
                          chatName: res.conversation.chatName,
                          groupDescription: res.conversation.groupDescription,
                        });
                        Alert.alert("Success", "Group settings updated successfully.");
                        setIsEditingGroup(false);
                      }
                    } catch (err: any) {
                      Alert.alert("Error", err.message || "Failed to update group settings.");
                    }
                  }}
                  style={{ backgroundColor: PURPLE, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingVertical: 14 }}
                >
                  <Text style={{ color: '#fff', fontWeight: 'bold' }}>Save Changes</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </SafeAreaView>
        </Modal>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['bottom']}>

      {/* ── Tap Outside Popups Dismiss Overlays ── */}
      {isMenuOpen && (
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setIsMenuOpen(false)}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 199,
            backgroundColor: 'transparent',
          }}
        />
      )}

      {(isAttachmentOpen || isEmojiOpen) && (
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => {
            setIsAttachmentOpen(false);
            setIsEmojiOpen(false);
          }}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 90,
            backgroundColor: 'transparent',
          }}
        />
      )}

      {/* ── Header (fills from the very top of the screen) ── */}
      <View style={{
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: 14, paddingTop: insets.top + 8, paddingBottom: 10,
        borderBottomWidth: 1, borderBottomColor: colors.border,
        backgroundColor: colors.card,
        zIndex: 200,
      }}>
        {isSearching ? (
          <View style={{
            flexDirection: 'row', alignItems: 'center', flex: 1,
            backgroundColor: colors.card, borderRadius: 14,
            paddingHorizontal: 12, paddingVertical: 8, marginHorizontal: 4,
          }}>
            <Search size={16} color={PURPLE} style={{ marginRight: 8 }} />
            <TextInput
              style={{ flex: 1, fontSize: 14, fontFamily: 'Poppins_400Regular', color: INK, padding: 0 }}
              placeholder="Search messages..."
              placeholderTextColor={INK_SOFT}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
            />
            <TouchableOpacity onPress={() => { setIsSearching(false); setSearchQuery(''); }} style={{ padding: 4 }}>
              <X size={16} color={INK} />
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {/* Back + Avatar + Name */}
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0 }}>
              <TouchableOpacity
                onPress={() => router.back()}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  backgroundColor: 'rgba(108,92,231,0.08)',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginRight: 10,
                }}
              >
                <ChevronLeft size={20} color={PURPLE} />
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => setIsInfoOpen(true)}
                activeOpacity={0.75}
                style={{ flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0 }}
              >
                <View style={{ position: 'relative', flexShrink: 0, marginRight: 10 }}>
                  <Avatar
                    url={chat.avatar}
                    name={chat.name || chat.organization}
                    size={40}
                    isGroup={!!(chat.isGroupChat || chat.organization)}
                  />
                  {isPeerOnline && !chat.isGroupChat && (
                    <View style={{ position: 'absolute', bottom: -1, right: -1, width: 11, height: 11, borderRadius: 99, backgroundColor: '#22c55e', borderWidth: 2, borderColor: '#ffffff' }} />
                  )}
                </View>

                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text numberOfLines={2} style={{ fontSize: 14, fontFamily: 'Poppins_700Bold', color: colors.text, lineHeight: 17, marginRight: 4 }}>
                      {(chat.name || chat.organization || '').toUpperCase().replace(/\s+/g, '\n')}
                    </Text>
                    {isMuted && <BellOff size={11} color={INK_SOFT} style={{ marginLeft: 2 }} />}
                  </View>
                  <Text style={{ fontSize: 11, fontFamily: 'Poppins_400Regular', color: chat.status === 'typing' ? PURPLE : INK_SOFT, marginTop: 1 }}>
                    {chat.status === 'typing'
                      ? (typingUser ? `${getDisplayName(typingUser)} is typing…` : 'typing…')
                      : chat.isGroupChat ? statusLine : isPeerOnline ? 'Online' : 'Offline'}
                  </Text>
                </View>
              </TouchableOpacity>
            </View>

            {/* Action Icons */}
            {(() => {
              const hideCallButtons = chat?.is_bot || chat?.username === 'aida' || chat?.username?.toLowerCase() === 'aida' || (chat?.otherUserId && String(chat.otherUserId) === String(currentUserIdRef.current));
              return (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <IconBtn icon={<Search size={18} color={INK_SOFT} />} onPress={() => setIsSearching(true)} />
                  {!hideCallButtons && (
                    <>
                      <IconBtn icon={<Phone size={18} color={INK_SOFT} />} onPress={() => handleStartCall('voice')} />
                      <IconBtn icon={<Video size={18} color={INK_SOFT} />} onPress={() => handleStartCall('video')} />
                    </>
                  )}
                  <IconBtn icon={<Info size={18} color={INK_SOFT} />} onPress={() => setIsInfoOpen(true)} />
                  <IconBtn icon={<MoreVertical size={18} color={INK_SOFT} />} onPress={() => setIsMenuOpen(prev => !prev)} />
                </View>
              );
            })()}
          </>
        )}
      </View>

      {/* ── More Options Dropdown Menu (Popover style) ── */}
      {isMenuOpen && (
        <View style={{
          position: 'absolute',
          top: 60,
          right: 14,
          width: 195,
          backgroundColor: colors.card,
          borderRadius: 20,
          paddingVertical: 6,
          borderWidth: 1,
          borderColor: 'rgba(108,92,231,0.08)',
          shadowColor: '#6c5ce7',
          shadowOpacity: 0.12,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 4 },
          elevation: 10,
          zIndex: 1000,
        }}>
          <DropdownItem
            icon={<Info size={16} color={INK_SOFT} />}
            label="Information"
            onPress={() => {
              setIsMenuOpen(false);
              setIsInfoOpen(true);
            }}
          />
          <DropdownItem
            icon={<Sparkles size={16} color={INK_SOFT} />}
            label="AI Summary"
            onPress={() => {
              setIsMenuOpen(false);
              setIsAiSummaryOpen(true);
            }}
          />
          <DropdownItem
            icon={<Search size={16} color={INK_SOFT} />}
            label="Search in Chat"
            onPress={() => {
              setIsMenuOpen(false);
              setIsSearching(true);
            }}
          />
          <View style={{ height: 1, backgroundColor: colors.border }} />
          <DropdownItem
            icon={<Pin size={16} color={INK_SOFT} />}
            label={isChatPinned ? "Unpin Chat" : "Pin Chat"}
            onPress={async () => {
              setIsMenuOpen(false);
              const next = !isChatPinned;
              setIsChatPinned(next);
              try {
                await toggleChatPin(chat.id);
                showToast(next ? "Chat pinned" : "Chat unpinned");
              } catch (err) {
                setIsChatPinned(!next);
                showToast("Failed to update pin");
              }
            }}
          />
          <DropdownItem
            icon={<BellOff size={16} color={INK_SOFT} />}
            label={isMuted ? "Unmute" : "Mute"}
            onPress={async () => {
              setIsMenuOpen(false);
              const next = !isMuted;
              setIsMuted(next);
              try {
                await muteChat(chat.id);
                showToast(next ? "Chat muted" : "Chat unmuted");
              } catch (err) {
                setIsMuted(!next);
                showToast("Failed to update mute");
              }
            }}
          />
          <DropdownItem
            icon={<EyeOff size={16} color={INK_SOFT} />}
            label="Clear Chat"
            onPress={() => {
              setIsMenuOpen(false);
              setMessages([]);
              showToast("Chat cleared");
            }}
          />
          <DropdownItem
            icon={<Archive size={16} color={INK_SOFT} />}
            label={isArchived ? "Unarchive Chat" : "Archive Chat"}
            onPress={() => {
              setIsMenuOpen(false);
              setIsArchived(prev => !prev);
              showToast(isArchived ? "Chat unarchived" : "Chat archived");
            }}
          />
          <View style={{ height: 1, backgroundColor: colors.border }} />
          <DropdownItem
            icon={<Trash2 size={16} color="red" />}
            label="Delete Chat"
            labelStyle={{ color: 'red' }}
            onPress={() => {
              setIsMenuOpen(false);
              router.back();
              showToast("Chat deleted");
            }}
          />
        </View>
      )}

      {/* ── Messages + Input ── */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* Subtle lavender bg for chat area */}
        <ScrollView
          ref={scrollViewRef}
          style={{ flex: 1, backgroundColor: colors.bg }}
          contentContainerStyle={[
            { paddingHorizontal: 14, paddingTop: 16, paddingBottom: 24 },
            renderedItems.length === 0 && { flexGrow: 1, justifyContent: 'center' }
          ]}
          showsVerticalScrollIndicator={false}
        >
          {renderedItems.length === 0 ? (
            <View style={{ alignItems: 'center', justifyContent: 'center', opacity: 0.8 }}>
              <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: 'rgba(108, 92, 231, 0.1)', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
                <MessageSquare size={36} color="#6c5ce7" />
              </View>
              <Text style={{ fontFamily: 'Poppins_600SemiBold', fontSize: 20, color: colors.text, marginBottom: 8 }}>
                Say hello! 👋
              </Text>
              <Text style={{ fontFamily: 'Poppins_400Regular', fontSize: 14, color: colors.textSoft, textAlign: 'center', maxWidth: 250 }}>
                {chat?.isGroupChat
                  ? 'Start the conversation with your group members.'
                  : 'Start a conversation by sending a message below.'}
              </Text>
            </View>
          ) : (
            renderedItems.map(item => {
              if (item.type === 'divider') {
                return (
                  <View key={item.id} style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 18, paddingHorizontal: 10 }}>
                    <View style={{ flex: 1, height: 1, backgroundColor: 'rgba(0,0,0,0.06)' }} />
                    <Text style={{ marginHorizontal: 16, fontSize: 12, fontFamily: 'Poppins_500Medium', color: INK_SOFT }}>
                      {item.text}
                    </Text>
                    <View style={{ flex: 1, height: 1, backgroundColor: 'rgba(0,0,0,0.06)' }} />
                  </View>
                );
              }

              const msg = item.data as any;
              const isMe = msg.sender === 'me';
              const isSystem = msg.sender === 'system' || msg.isSystem || msg.is_announcement;
              const isSelected = selectedMessageIds.includes(msg.id);

              // ── System / Announcement Messages ─ render as centered banner ──────
              if (isSystem) {
                return (
                  <View key={msg.id} style={{ alignItems: 'center', marginVertical: 10, paddingHorizontal: 20 }}>
                    <View style={{
                      backgroundColor: 'rgba(108,92,231,0.07)',
                      borderRadius: 20,
                      paddingHorizontal: 14,
                      paddingVertical: 7,
                      borderWidth: 1,
                      borderColor: 'rgba(108,92,231,0.12)',
                      maxWidth: '85%',
                    }}>
                      <Text style={{ fontSize: 11.5, fontFamily: 'Poppins_500Medium', color: '#6c5ce7', textAlign: 'center', lineHeight: 17 }}>
                        {msg.text}
                      </Text>
                    </View>
                  </View>
                );
              }

              return (
                <View key={msg.id} style={{ marginBottom: 14, position: 'relative' }}>
                  {/* Swipe-to-reply hint icon, revealed behind the row as it's dragged right */}
                  <Animated.View
                    pointerEvents="none"
                    style={{
                      position: 'absolute',
                      left: 4,
                      top: 0,
                      bottom: 0,
                      justifyContent: 'center',
                      opacity: getSwipeAnim(msg.id).interpolate({ inputRange: [0, 60], outputRange: [0, 1], extrapolate: 'clamp' }),
                    }}
                  >
                    <Reply size={18} color={PURPLE} />
                  </Animated.View>

                  <Animated.View
                    {...getSwipeResponder(msg).panHandlers}
                    style={{
                      flexDirection: 'row',
                      justifyContent: isMe ? 'flex-end' : 'flex-start',
                      alignItems: 'flex-end',
                      transform: [{ translateX: getSwipeAnim(msg.id) }],
                    }}
                  >
                  {/* Checkbox for selection mode */}
                  {isSelectionMode && (
                    <TouchableOpacity
                      onPress={() => handleToggleMessageSelect(msg.id)}
                      style={{
                        justifyContent: 'center',
                        alignItems: 'center',
                        paddingRight: 10,
                        alignSelf: 'center',
                      }}
                    >
                      <View style={{
                        width: 20,
                        height: 20,
                        borderRadius: 10,
                        borderWidth: 2,
                        borderColor: isSelected ? PURPLE : INK_SOFT,
                        backgroundColor: isSelected ? PURPLE : 'transparent',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}>
                        {isSelected && <Check size={12} color="#ffffff" />}
                      </View>
                    </TouchableOpacity>
                  )}

                  {/* Left (Received) message avatar */}
                  {!isMe && (
                    <View style={{ marginRight: 8, marginBottom: 2, alignSelf: 'flex-end', flexShrink: 0 }}>
                      <Avatar
                        url={chat.avatar}
                        userId={!chat.isGroupChat ? chat.otherUserId : undefined}
                        name={chat.isGroupChat && msg.senderName ? msg.senderName : chat.name}
                        size={28}
                        isGroup={chat.isGroupChat ? false : !!chat.organization}
                      />
                    </View>
                  )}

                  <View style={{ maxWidth: '70%', alignItems: isMe ? 'flex-end' : 'flex-start' }}>
                    <TouchableOpacity
                      activeOpacity={isSelectionMode ? 0.75 : 0.9}
                      onPress={() => {
                        if (isSelectionMode) {
                          handleToggleMessageSelect(msg.id);
                        } else if (msg.message_type === 'image' && (msg.mediaUrl || msg.media_url)) {
                          const idx = imageMessages.findIndex(imgMsg => imgMsg.id === msg.id);
                          if (idx !== -1) {
                            setLightboxImageIndex(idx);
                          }
                        } else {
                          setActiveContextMessage(msg);
                        }
                      }}
                      onLongPress={() => {
                        if (!isSelectionMode) {
                          setActiveContextMessage(msg);
                        }
                      }}
                      style={{
                        position: 'relative',
                        borderRadius: 18,
                        borderBottomRightRadius: isMe ? 4 : 18,
                        borderBottomLeftRadius: isMe ? 18 : 4,
                        paddingHorizontal: 14,
                        paddingTop: 10,
                        paddingBottom: msg.reactions && msg.reactions.length > 0 ? 14 : 10,
                        backgroundColor: isMe ? PURPLE : colors.surface,
                        shadowColor: isMe ? PURPLE : '#000',
                        shadowOpacity: isMe ? 0.15 : 0.02,
                        shadowRadius: 4,
                        shadowOffset: { width: 0, height: 1 },
                        elevation: 1,
                      }}
                    >
                      {!isMe && chat.isGroupChat && msg.senderName && (
                        <Text style={{ fontSize: 10, fontFamily: 'Poppins_700Bold', color: PURPLE, marginBottom: 3 }}>
                          {msg.senderName}
                        </Text>
                      )}
                      {msg.parent_message && (
                        <TouchableOpacity
                          activeOpacity={0.7}
                          onPress={() => {
                            const idx = messages.findIndex(mm => String(mm.id) === String(msg.parent_message?.id));
                            if (idx !== -1) scrollViewRef.current?.scrollTo({ y: Math.max(0, idx * 64), animated: true });
                          }}
                          style={{
                            borderLeftWidth: 2,
                            borderLeftColor: isMe ? 'rgba(255,255,255,0.6)' : PURPLE,
                            backgroundColor: isMe ? 'rgba(255,255,255,0.15)' : 'rgba(108,92,231,0.06)',
                            borderRadius: 8,
                            paddingHorizontal: 8,
                            paddingVertical: 5,
                            marginBottom: 6,
                          }}
                        >
                          <Text style={{ fontSize: 10, fontFamily: 'Poppins_700Bold', color: isMe ? 'rgba(255,255,255,0.9)' : PURPLE }}>
                            {msg.parent_message.sender?.full_name || 'Reply'}
                          </Text>
                          <Text numberOfLines={1} style={{ fontSize: 11, fontFamily: 'Poppins_400Regular', color: isMe ? 'rgba(255,255,255,0.75)' : INK_SOFT }}>
                            {msg.parent_message.content || '[Media]'}
                          </Text>
                        </TouchableOpacity>
                      )}
                      {msg.message_type === 'voice' ? (
                        <VoiceMessagePlayer msg={msg} isMe={isMe} />
                      ) : msg.message_type === 'image' && (msg.mediaUrl || msg.media_url) ? (
                        <View style={{ marginVertical: 4 }}>
                          <Image
                            source={{ uri: getSecureMediaUrl(msg.mediaUrl || msg.media_url) || undefined }}
                            style={{ width: 200, height: 150, borderRadius: 12 }}
                            contentFit="cover"
                          />
                          {msg.text && msg.text !== (msg.mediaUrl || msg.media_url) && (
                            <Text style={{ fontSize: 14, lineHeight: 20, fontFamily: 'Poppins_400Regular', color: isMe ? '#ffffff' : colors.text, marginTop: 6 }}>
                              {renderMessageText(msg.text, isMe, mentionNames, colors)}
                            </Text>
                          )}
                        </View>
                      ) : msg.message_type === 'video' && (msg.mediaUrl || msg.media_url) ? (
                        <View style={{ marginVertical: 4 }}>
                          <View style={{ width: 200, height: 150, borderRadius: 12, overflow: 'hidden', justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' }}>
                            <Image
                              source={{ uri: getSecureMediaUrl(msg.mediaUrl || msg.media_url) || undefined }}
                              style={{ width: '100%', height: '100%', opacity: 0.6, position: 'absolute' }}
                              contentFit="cover"
                            />
                            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.8)', justifyContent: 'center', alignItems: 'center' }}>
                              <Play size={16} color="#000" style={{ marginLeft: 2 }} />
                            </View>
                          </View>
                          {msg.text && msg.text !== (msg.mediaUrl || msg.media_url) && (
                            <Text style={{ fontSize: 14, lineHeight: 20, fontFamily: 'Poppins_400Regular', color: isMe ? '#ffffff' : colors.text, marginTop: 6 }}>
                              {renderMessageText(msg.text, isMe, mentionNames, colors)}
                            </Text>
                          )}
                        </View>
                      ) : msg.message_type === 'file' && (msg.mediaUrl || msg.media_url) ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4, width: 200 }}>
                          <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: isMe ? 'rgba(255,255,255,0.2)' : 'rgba(108,92,231,0.1)', alignItems: 'center', justifyContent: 'center' }}>
                            <FileText size={16} color={isMe ? '#ffffff' : PURPLE} />
                          </View>
                          <Text numberOfLines={1} style={{ fontSize: 13, fontFamily: 'Poppins_600SemiBold', color: isMe ? '#ffffff' : colors.text, flex: 1 }}>
                            {msg.text || 'Document File'}
                          </Text>
                        </View>
                      ) : (
                        <Text style={{ fontSize: 14, lineHeight: 20, fontFamily: 'Poppins_400Regular', color: isMe ? '#ffffff' : INK }}>
                          {renderMessageText(msg.text, isMe, mentionNames, colors)}
                        </Text>
                      )}

                      {/* Reaction badge */}
                      {msg.reactions && msg.reactions.length > 0 && (
                        <View style={{
                          position: 'absolute',
                          bottom: -10,
                          right: isMe ? undefined : 12,
                          left: isMe ? 12 : undefined,
                          flexDirection: 'row',
                          backgroundColor: colors.card,
                          borderRadius: 12,
                          paddingHorizontal: 6,
                          paddingVertical: 2,
                          borderWidth: 1,
                          borderColor: 'rgba(108,92,231,0.15)',
                          shadowColor: '#000',
                          shadowOpacity: 0.05,
                          shadowRadius: 3,
                          elevation: 1,
                        }}>
                          {(msg.reactions as any[]).map((emoji: string, idx: number) => (
                            <Text key={idx} style={{ fontSize: 11, marginRight: idx < msg.reactions!.length - 1 ? 2 : 0 }}>{emoji}</Text>
                          ))}
                        </View>
                      )}
                    </TouchableOpacity>

                    {/* Time and checkmarks outside/under the bubble */}
                    <View style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      marginTop: msg.reactions && msg.reactions.length > 0 ? 12 : 4,
                      paddingHorizontal: 6,
                    }}>
                      {msg.isPinned && <Pin size={10} color={INK_SOFT} style={{ marginRight: 4 }} />}
                      <Text style={{ fontSize: 9.5, fontFamily: 'Poppins_400Regular', color: INK_SOFT }}>
                        {msg.time}
                      </Text>
                      {isMe && (
                        msg.status === 'queued' ? (
                          <Clock size={11} color={INK_SOFT} style={{ marginLeft: 4 }} />
                        ) : (msg.isRead && viewerReadReceipts) ? (
                          <CheckCheck size={11} color="#38bdf8" style={{ marginLeft: 4 }} />
                        ) : ((msg as any).isDelivered || msg.isRead) ? (
                          <CheckCheck size={11} color={INK_SOFT} style={{ marginLeft: 4 }} />
                        ) : (
                          <Check size={11} color={INK_SOFT} style={{ marginLeft: 4 }} />
                        )
                      )}
                    </View>
                  </View>

                  {/* Right (Sent) message avatar */}
                  {isMe && (
                    <View style={{ marginLeft: 8, marginBottom: 2, alignSelf: 'flex-end', flexShrink: 0 }}>
                      <Avatar
                        url={ownUser?.avatar || null}
                        userId={ownUser?.id || ownUser?._id}
                        name={ownUser?.name || 'Me'}
                        size={28}
                        isGroup={false}
                      />
                    </View>
                  )}
                  </Animated.View>
                </View>
              );
            })
          )}

          {/* Typing bubble */}
          {chat.status === 'typing' && (
            <View style={{ marginBottom: 10, flexDirection: 'row', justifyContent: 'flex-start', alignItems: 'flex-end' }}>
              <View style={{ marginRight: 8, marginBottom: 2, alignSelf: 'flex-end', flexShrink: 0 }}>
                <Avatar
                  url={chat.avatar}
                  name={chat.isGroupChat && typingUser ? getDisplayName(typingUser) : chat.name}
                  size={28}
                  isGroup={chat.isGroupChat ? false : !!chat.organization}
                />
              </View>
              <View style={{ borderRadius: 18, borderBottomLeftRadius: 4, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: colors.surface }}>
                <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
                  {[0, 1, 2].map(i => (
                    <View key={i} style={{ width: 6, height: 6, borderRadius: 99, backgroundColor: colors.textSoft }} />
                  ))}
                  <Text style={{ fontSize: 12, color: colors.textSoft, fontFamily: 'Poppins_500Medium', marginLeft: 4 }}>
                    {typingUser ? `${getDisplayName(typingUser)} is typing…` : 'typing…'}
                  </Text>
                </View>
              </View>
            </View>
          )}
        </ScrollView>

        {/* ── Bottom Bar (Contextual depending on Selection Mode) ── */}
        {isSelectionMode ? (
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingVertical: 14,
            borderTopWidth: 1,
            borderTopColor: 'rgba(0,0,0,0.06)',
            backgroundColor: colors.card,
          }}>
            <TouchableOpacity onPress={() => {
              setIsSelectionMode(false);
              setSelectedMessageIds([]);
            }}>
              <Text style={{ fontSize: 13.5, fontFamily: 'Poppins_600SemiBold', color: INK_SOFT }}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => {
              setSelectedMessageIds(messages.map(m => m.id));
            }}>
              <Text style={{ fontSize: 13.5, fontFamily: 'Poppins_600SemiBold', color: PURPLE }}>Select All</Text>
            </TouchableOpacity>

            <View style={{ flexDirection: 'row', gap: 12 }}>
              <TouchableOpacity
                onPress={() => {
                  const textToCopy = messages
                    .filter(m => selectedMessageIds.includes(m.id))
                    .map(m => `[${m.time}] ${m.sender === 'me' ? 'Me' : chat.name}: ${m.text}`)
                    .join('\n');
                  showToast(`${selectedMessageIds.length} messages copied`);
                  setIsSelectionMode(false);
                  setSelectedMessageIds([]);
                }}
                disabled={selectedMessageIds.length === 0}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: selectedMessageIds.length > 0 ? 'rgba(108,92,231,0.08)' : 'transparent',
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderRadius: 10,
                }}
              >
                <Copy size={14} color={selectedMessageIds.length > 0 ? PURPLE : INK_SOFT} style={{ marginRight: 4 }} />
                <Text style={{ fontSize: 12.5, fontFamily: 'Poppins_700Bold', color: selectedMessageIds.length > 0 ? PURPLE : INK_SOFT }}>
                  Copy
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => {
                  setMessages(prev => prev.filter(m => !selectedMessageIds.includes(m.id)));
                  showToast(`${selectedMessageIds.length} messages deleted`);
                  setIsSelectionMode(false);
                  setSelectedMessageIds([]);
                }}
                disabled={selectedMessageIds.length === 0}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: selectedMessageIds.length > 0 ? 'rgba(239, 68, 68, 0.08)' : 'transparent',
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderRadius: 10,
                }}
              >
                <Trash2 size={14} color={selectedMessageIds.length > 0 ? 'red' : INK_SOFT} style={{ marginRight: 4 }} />
                <Text style={{ fontSize: 12.5, fontFamily: 'Poppins_700Bold', color: selectedMessageIds.length > 0 ? 'red' : INK_SOFT }}>
                  Delete
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View>
            {/* Editing banner alert */}
            {editingMessageId && (
              <View style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                backgroundColor: colors.card,
                paddingHorizontal: 16,
                paddingVertical: 8,
                borderBottomWidth: 1,
                borderBottomColor: 'rgba(108,92,231,0.1)',
              }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Edit2 size={14} color={PURPLE} style={{ marginRight: 6 }} />
                  <Text style={{ fontSize: 12, fontFamily: 'Poppins_500Medium', color: INK_SOFT }}>
                    Editing message...
                  </Text>
                </View>
                <TouchableOpacity onPress={() => { setEditingMessageId(null); setMessageText(''); }}>
                  <X size={14} color={INK} />
                </TouchableOpacity>
              </View>
            )}

            {/* Input Bar */}
            <View style={{
              position: 'relative',
              paddingHorizontal: 16,
              paddingVertical: 12,
              backgroundColor: colors.card,
              borderTopWidth: 1,
              borderTopColor: colors.border,
            }}>
              {/* ── Attachment popover menu ── */}
              {isAttachmentOpen && (
                <View style={{
                  position: 'absolute',
                  bottom: 70,
                  left: 16,
                  width: 190,
                  backgroundColor: colors.card,
                  borderRadius: 18,
                  padding: 8,
                  borderWidth: 1,
                  borderColor: 'rgba(108,92,231,0.08)',
                  shadowColor: '#6c5ce7',
                  shadowOpacity: 0.12,
                  shadowRadius: 10,
                  shadowOffset: { width: 0, height: 4 },
                  elevation: 8,
                  zIndex: 100,
                }}>
                  <Text style={{ fontSize: 10, fontFamily: 'Poppins_700Bold', color: INK_SOFT, textTransform: 'uppercase', paddingHorizontal: 12, paddingVertical: 6, letterSpacing: 0.8 }}>
                    Upload attachment
                  </Text>

                  <TouchableOpacity
                    onPress={() => {
                      setSelectedFile({ name: 'IMG_4829.jpg', size: '1.4 MB', type: 'image', url: 'https://images.unsplash.com/photo-1548142813-c348350df52b?w=200' });
                      setIsAttachmentOpen(false);
                    }}
                    style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12 }}
                  >
                    <ImageIcon size={16} color={PURPLE} style={{ marginRight: 10 }} />
                    <Text style={{ fontSize: 13, fontFamily: 'Poppins_500Medium', color: INK }}>Photo & Video</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={() => {
                      setSelectedFile({ name: 'screen_record.mov', size: '12.8 MB', type: 'video' });
                      setIsAttachmentOpen(false);
                    }}
                    style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12 }}
                  >
                    <Video size={16} color={PURPLE} style={{ marginRight: 10 }} />
                    <Text style={{ fontSize: 13, fontFamily: 'Poppins_500Medium', color: INK }}>Video Clip</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={() => {
                      setSelectedFile({ name: 'project_spec.pdf', size: '2.1 MB', type: 'file' });
                      setIsAttachmentOpen(false);
                    }}
                    style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12 }}
                  >
                    <FileText size={16} color={PURPLE} style={{ marginRight: 10 }} />
                    <Text style={{ fontSize: 13, fontFamily: 'Poppins_500Medium', color: INK }}>Document File</Text>
                  </TouchableOpacity>
                </View>
              )}



              {/* ── Selected Attachment Preview Card ── */}
              {selectedFile && (
                <View style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  backgroundColor: 'rgba(108,92,231,0.05)',
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor: 'rgba(108,92,231,0.1)',
                  padding: 10,
                  marginBottom: 10,
                }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0 }}>
                    {selectedFile.type === 'image' && selectedFile.url ? (
                      <Image source={{ uri: selectedFile.url }} style={{ width: 40, height: 40, borderRadius: 8, marginRight: 10 }} />
                    ) : (
                      <View style={{ width: 40, height: 40, borderRadius: 8, backgroundColor: 'rgba(108,92,231,0.1)', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
                        {selectedFile.type === 'video' ? <Video size={18} color={PURPLE} /> : <FileText size={18} color={PURPLE} />}
                      </View>
                    )}
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text numberOfLines={1} style={{ fontSize: 13, fontFamily: 'Poppins_600SemiBold', color: INK }}>
                        {selectedFile.name}
                      </Text>
                      <Text style={{ fontSize: 11, fontFamily: 'Poppins_400Regular', color: INK_SOFT }}>
                        {selectedFile.size} · {selectedFile.type.toUpperCase()}
                      </Text>
                    </View>
                  </View>
                  <TouchableOpacity
                    onPress={() => setSelectedFile(null)}
                    style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: colors.border, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <X size={12} color={INK} />
                  </TouchableOpacity>
                </View>
              )}

              {/* Aida Writing Suggestions Chips */}
              {aidaSuggestions.length > 0 && (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingBottom: 8 }}
                >
                  {aidaSuggestions.map((suggestion, idx) => (
                    <TouchableOpacity
                      key={idx}
                      onPress={() => {
                        setMessageText(suggestion);
                        setAidaSuggestions([]);
                      }}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        backgroundColor: 'rgba(108,92,231,0.08)',
                        borderColor: 'rgba(108,92,231,0.15)',
                        borderWidth: 1,
                        borderRadius: 100,
                        paddingHorizontal: 12,
                        paddingVertical: 6,
                      }}
                    >
                      <Sparkles size={11} color={PURPLE} style={{ marginRight: 4 }} />
                      <Text style={{ fontSize: 12, fontFamily: 'Poppins_600SemiBold', color: PURPLE }}>
                        {suggestion}
                      </Text>
                    </TouchableOpacity>
                  ))}
                  {/* Dismiss the suggestions row */}
                  <TouchableOpacity
                    onPress={() => setAidaSuggestions([])}
                    accessibilityLabel="Dismiss suggestions"
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 28,
                      height: 28,
                      borderRadius: 100,
                      backgroundColor: 'rgba(0,0,0,0.04)',
                      borderColor: 'rgba(0,0,0,0.06)',
                      borderWidth: 1,
                    }}
                  >
                    <X size={13} color={INK_SOFT} />
                  </TouchableOpacity>
                </ScrollView>
              )}

              {/* Aida unavailable notice */}
              {aidaUnavailable && (
                <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
                  <Text style={{ fontSize: 11, fontFamily: 'Poppins_500Medium', color: 'rgba(31,32,48,0.45)' }}>
                    Aida suggestions are unavailable on this workspace
                  </Text>
                </View>
              )}

              {/* ── @mention autocomplete dropdown ── */}
              {mentionQuery !== null && mentionSuggestions.length > 0 && (
                <View style={{
                  backgroundColor: colors.surface,
                  borderRadius: 16,
                  marginHorizontal: 4,
                  marginBottom: 8,
                  overflow: 'hidden',
                  borderWidth: 1,
                  borderColor: 'rgba(108,92,231,0.1)',
                }}>
                  {mentionSuggestions.map(member => (
                    <TouchableOpacity
                      key={member.id}
                      onPress={() => insertMention(member)}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 9 }}
                    >
                      {member.isMentionAll ? (
                        <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(108,92,231,0.1)', alignItems: 'center', justifyContent: 'center' }}>
                          <Text style={{ fontSize: 13, fontFamily: 'Poppins_700Bold', color: PURPLE }}>@</Text>
                        </View>
                      ) : (
                        <Avatar url={member.avatar} userId={member.id} name={member.name} size={28} isGroup={false} />
                      )}
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ fontSize: 13, fontFamily: 'Poppins_600SemiBold', color: INK }}>{member.name}</Text>
                        {member.isMentionAll && (
                          <Text style={{ fontSize: 11, fontFamily: 'Poppins_400Regular', color: INK_SOFT }}>Notify everyone in this group</Text>
                        )}
                      </View>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              {/* ── Reply (quote) preview bar ── */}
              {replyingTo && (
                <View style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: 'rgba(108,92,231,0.06)',
                  borderLeftWidth: 3,
                  borderLeftColor: PURPLE,
                  borderRadius: 12,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  marginHorizontal: 4,
                  marginBottom: 8,
                }}>
                  <Reply size={16} color={PURPLE} style={{ marginRight: 8 }} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 11, fontFamily: 'Poppins_700Bold', color: PURPLE }}>
                      Replying to {replyingTo.sender === 'me' ? 'yourself' : (replyingTo.senderName || 'message')}
                    </Text>
                    <Text numberOfLines={1} style={{ fontSize: 12, fontFamily: 'Poppins_400Regular', color: INK_SOFT }}>
                      {replyingTo.text || (replyingTo.message_type === 'voice' ? '🎤 Voice message' : replyingTo.message_type === 'image' ? '📷 Photo' : '[Media]')}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={() => setReplyingTo(null)} style={{ padding: 4, marginLeft: 6 }}>
                    <X size={16} color={INK_SOFT} />
                  </TouchableOpacity>
                </View>
              )}

              {/* ── Main Input Bar Row styled as a single continuous capsule ── */}
              {isRecording ? (
                <View style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: 'rgba(239, 68, 68, 0.05)',
                  borderRadius: 24,
                  paddingHorizontal: 16,
                  paddingVertical: 5,
                  minHeight: 48,
                  justifyContent: 'space-between',
                }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    {/* Pulsing red dot */}
                    <View style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: 'red',
                      opacity: isPulsing ? 1 : 0.2,
                    }} />
                    <Text style={{ fontSize: 14, fontFamily: 'Poppins_600SemiBold', color: 'red' }}>
                      Recording... {formatRecordingTime(recordingSeconds)}
                    </Text>
                  </View>

                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    {/* Cancel button */}
                    <TouchableOpacity
                      onPress={cancelRecording}
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 16,
                        backgroundColor: colors.border,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <X size={16} color={INK} />
                    </TouchableOpacity>

                    {/* Send voice message button */}
                    <TouchableOpacity
                      onPress={stopAndSendRecording}
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 16,
                        backgroundColor: PURPLE,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Send size={14} color="#ffffff" style={{ marginLeft: 2 }} />
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <View style={{
                  flexDirection: 'row',
                  alignItems: 'flex-end',
                  backgroundColor: colors.surface,
                  borderRadius: 24,
                  paddingHorizontal: 8,
                  paddingVertical: 5,
                  minHeight: 48,
                  maxHeight: 120,
                }}>
                  {/* Paperclip icon inside the capsule */}
                  <TouchableOpacity
                    onPress={() => {
                      setIsAttachmentOpen(prev => !prev);
                      setIsEmojiOpen(false);
                    }}
                    style={{
                      width: 38,
                      height: 38,
                      justifyContent: 'center',
                      alignItems: 'center',
                    }}
                  >
                    <Paperclip size={20} color={isAttachmentOpen ? PURPLE : INK_SOFT} />
                  </TouchableOpacity>

                  {/* Input text inside the capsule */}
                  <TextInput
                    ref={inputRef}
                    style={{
                      flex: 1,
                      fontSize: 15,
                      fontFamily: 'Poppins_400Regular',
                      color: colors.text,
                      maxHeight: 100,
                      paddingVertical: Platform.OS === 'ios' ? 8 : 4,
                      paddingHorizontal: 4,
                      textAlignVertical: 'center',
                    }}
                    placeholder={selectedFile ? "Add a caption..." : "Type a message..."}
                    placeholderTextColor={colors.textSoft}
                    multiline
                    value={messageText}
                    onChangeText={handleTextChange}
                    onFocus={() => setIsEmojiOpen(false)}
                  />

                  {/* Deep Aida: draft a full, context-aware reply (F5) */}
                  {!aidaUnavailable && (
                    <TouchableOpacity
                      onPress={handleDraftForMe}
                      disabled={isDrafting}
                      accessibilityLabel="Draft a reply for me"
                      style={{
                        width: 38,
                        height: 38,
                        justifyContent: 'center',
                        alignItems: 'center',
                        opacity: isDrafting ? 0.5 : 1,
                      }}
                    >
                      {isDrafting ? (
                        <ActivityIndicator size="small" color={PURPLE} />
                      ) : (
                        <Sparkles size={20} color={PURPLE} />
                      )}
                    </TouchableOpacity>
                  )}

                  {/* Smile Emoji button inside the capsule */}
                  <TouchableOpacity
                    onPress={() => {
                      if (!isEmojiOpen) {
                        Keyboard.dismiss();
                        setIsEmojiOpen(true);
                        setIsAttachmentOpen(false);
                      } else {
                        setIsEmojiOpen(false);
                      }
                    }}
                    style={{
                      width: 38,
                      height: 38,
                      justifyContent: 'center',
                      alignItems: 'center',
                    }}
                  >
                    <Smile size={20} color={isEmojiOpen ? PURPLE : INK_SOFT} />
                  </TouchableOpacity>

                  {/* Send / Mic button inside the capsule */}
                  {messageText.trim().length > 0 || selectedFile ? (
                    <TouchableOpacity
                      onPress={handleSend}
                      style={{
                        width: 38,
                        height: 38,
                        justifyContent: 'center',
                        alignItems: 'center',
                      }}
                    >
                      <Send size={20} color={PURPLE} />
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      onPress={startRecording}
                      style={{
                        width: 38,
                        height: 38,
                        justifyContent: 'center',
                        alignItems: 'center',
                      }}
                    >
                      <Mic size={20} color={INK_SOFT} />
                    </TouchableOpacity>
                  )}
                </View>
              )}
            </View>

            {isEmojiOpen && (
              <View style={{
                height: 250,
                backgroundColor: colors.card,
                borderTopWidth: 1,
                borderTopColor: colors.border,
                paddingTop: 8,
              }}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 8, gap: 6 }}
                  style={{ flexGrow: 0 }}
                >
                  {EMOJI_CATEGORIES.map((cat, idx) => (
                    <TouchableOpacity
                      key={cat.title}
                      onPress={() => setActiveEmojiCategoryIdx(idx)}
                      style={{
                        backgroundColor: activeEmojiCategoryIdx === idx ? PURPLE : 'rgba(108,92,231,0.06)',
                        paddingHorizontal: 12,
                        paddingVertical: 6,
                        borderRadius: 12,
                      }}
                    >
                      <Text style={{
                        fontSize: 12,
                        fontFamily: 'Poppins_600SemiBold',
                        color: activeEmojiCategoryIdx === idx ? '#ffffff' : PURPLE,
                      }}>
                        {cat.title}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>

                <ScrollView contentContainerStyle={{
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  paddingHorizontal: 12,
                  paddingBottom: 20,
                  gap: 12,
                  justifyContent: 'flex-start',
                }}>
                  {EMOJI_CATEGORIES[activeEmojiCategoryIdx].emojis.map((emoji) => (
                    <TouchableOpacity
                      key={emoji}
                      onPress={() => {
                        setMessageText(prev => prev + emoji);
                      }}
                      style={{
                        width: 40,
                        height: 40,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Text style={{ fontSize: 26 }}>{emoji}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}
          </View>
        )}
      </KeyboardAvoidingView>

      {/* ── Custom Floating Toast Alert Overlay ── */}
      {toastMessage && (
        <View style={{
          position: 'absolute',
          top: 80,
          alignSelf: 'center',
          backgroundColor: 'rgba(31,32,48,0.9)',
          paddingHorizontal: 20,
          paddingVertical: 10,
          borderRadius: 20,
          zIndex: 9999,
          shadowColor: '#000',
          shadowOpacity: 0.1,
          shadowRadius: 6,
          elevation: 5,
        }}>
          <Text style={{ color: '#ffffff', fontFamily: 'Poppins_600SemiBold', fontSize: 13 }}>
            {toastMessage}
          </Text>
        </View>
      )}

      {/* ── Message Context Menu Modal ── */}
      <Modal visible={activeContextMessage !== null} transparent animationType="fade">
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setActiveContextMessage(null)}
          style={{
            flex: 1,
            backgroundColor: 'rgba(31,32,48,0.4)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 20,
          }}
        >
          {activeContextMessage && (
            <TouchableOpacity
              activeOpacity={1}
              style={{
                width: '100%',
                maxWidth: 290,
                backgroundColor: colors.card,
                borderRadius: 24,
                padding: 16,
                shadowColor: '#000',
                shadowOpacity: 0.1,
                shadowRadius: 10,
                elevation: 10,
              }}
            >
              {/* Emojis reaction row */}
              <Text style={{ fontSize: 10, fontFamily: 'Poppins_700Bold', color: INK_SOFT, textTransform: 'uppercase', marginBottom: 8, letterSpacing: 0.5 }}>
                React
              </Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 }}>
                {['👍', '❤️', '😂', '😮', '😢', '🔥', '👎', '🎉'].map(emoji => (
                  <TouchableOpacity
                    key={emoji}
                    onPress={() => handleReactMessage(activeContextMessage.id, emoji)}
                    style={{ padding: 4 }}
                  >
                    <Text style={{ fontSize: 22 }}>{emoji}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={{ height: 1, backgroundColor: colors.border, marginBottom: 8 }} />

              {/* Actions */}
              <ContextMenuItem
                icon={<Reply size={16} color={INK_SOFT} />}
                label="Reply"
                onPress={() => handleReplyTo(activeContextMessage)}
              />
              <ContextMenuItem
                icon={<Copy size={16} color={INK_SOFT} />}
                label="Copy Text"
                onPress={() => {
                  Clipboard.setString(activeContextMessage.text || '');
                  showToast("Copied to clipboard!");
                  setActiveContextMessage(null);
                }}
              />
              <ContextMenuItem
                icon={<Pin size={16} color={INK_SOFT} />}
                label={activeContextMessage.isPinned ? "Unpin Message" : "Pin Message"}
                onPress={() => handleTogglePinMessage(activeContextMessage.id)}
              />

              {activeContextMessage.sender === 'me' && (() => {
                const ts = new Date((activeContextMessage as any).timestamp || 0).getTime();
                const withinWindow = ts > 0 && Date.now() - ts <= 4 * 60 * 1000;
                if (!withinWindow) return null;
                return (
                  <ContextMenuItem
                    icon={<Edit2 size={16} color={INK_SOFT} />}
                    label="Edit Message"
                    onPress={() => handleEditMessage(activeContextMessage)}
                  />
                );
              })()}

              <ContextMenuItem
                icon={<Check size={16} color={INK_SOFT} />}
                label="Select Message"
                onPress={() => {
                  setIsSelectionMode(true);
                  setSelectedMessageIds([activeContextMessage.id]);
                  setActiveContextMessage(null);
                }}
              />
              <ContextMenuItem
                icon={<Forward size={16} color={INK_SOFT} />}
                label="Forward Message"
                onPress={() => {
                  setForwardingMessage(activeContextMessage);
                  setActiveContextMessage(null);
                }}
              />

              <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 8 }} />

              <ContextMenuItem
                icon={<Trash2 size={16} color={INK_SOFT} />}
                label="Delete for Me"
                onPress={() => handleDeleteMessage(activeContextMessage.id)}
              />

              {activeContextMessage.sender === 'me' && (
                <ContextMenuItem
                  icon={<Trash2 size={16} color="red" />}
                  label="Delete for Everyone"
                  labelStyle={{ color: 'red' }}
                  onPress={() => handleDeleteForEveryone(activeContextMessage.id)}
                />
              )}
            </TouchableOpacity>
          )}
        </TouchableOpacity>
      </Modal>

      {/* ── AI Summary Modal ── */}
      <Modal visible={isAiSummaryOpen} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: 'rgba(31,32,48,0.5)', justifyContent: 'flex-end' }}>
          <View style={{
            backgroundColor: colors.card,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            padding: 24,
            maxHeight: '60%',
          }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Sparkles size={20} color={PURPLE} style={{ marginRight: 8 }} />
                <Text style={{ fontSize: 18, fontFamily: 'SpaceGrotesk_700Bold', color: INK }}>AI Conversation Summary</Text>
              </View>
              <TouchableOpacity onPress={() => setIsAiSummaryOpen(false)} style={{ padding: 4 }}>
                <X size={20} color={PURPLE} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={{ backgroundColor: 'rgba(108,92,231,0.05)', borderRadius: 18, padding: 16, borderLeftWidth: 4, borderLeftColor: PURPLE, marginBottom: 16 }}>
                <Text style={{ fontSize: 13, fontFamily: 'Poppins_400Regular', color: INK, lineHeight: 20 }}>
                  This conversation centers around alignment on Bubblespace product updates. Major key points discussed:
                </Text>
                <Text style={{ fontSize: 13, fontFamily: 'Poppins_500Medium', color: INK, lineHeight: 20, marginTop: 10 }}>
                  • Verified mobile-view responsiveness adjustments.
                </Text>
                <Text style={{ fontSize: 13, fontFamily: 'Poppins_500Medium', color: INK, lineHeight: 20, marginTop: 4 }}>
                  • Discussed PR progress for onboarding flow UI updates.
                </Text>
                <Text style={{ fontSize: 13, fontFamily: 'Poppins_500Medium', color: INK, lineHeight: 20, marginTop: 4 }}>
                  • Sync scheduled for 2 PM today to lock down high-fidelity templates.
                </Text>
              </View>

              <TouchableOpacity
                onPress={() => {
                  showToast("Summary copied!");
                  setIsAiSummaryOpen(false);
                }}
                style={{
                  backgroundColor: PURPLE,
                  borderRadius: 14,
                  paddingVertical: 12,
                  alignItems: 'center',
                  marginTop: 8,
                }}
              >
                <Text style={{ color: '#ffffff', fontSize: 13, fontFamily: 'Poppins_700Bold' }}>Copy Summary</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>



      {/* ── Group Member Profile Modal ── */}
      <Modal visible={selectedMember !== null} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <View>
              <Text style={{ fontSize: 19, fontFamily: 'SpaceGrotesk_700Bold', color: INK }}>Profile</Text>
              <Text style={{ fontSize: 12, fontFamily: 'Poppins_400Regular', color: INK_SOFT, marginTop: 1 }}>Group member</Text>
            </View>
            <TouchableOpacity onPress={() => setSelectedMember(null)} style={{ padding: 6 }}>
              <X size={20} color={PURPLE} />
            </TouchableOpacity>
          </View>

          {selectedMember && (
            <ScrollView style={{ flex: 1, paddingHorizontal: 20, paddingTop: 20 }} showsVerticalScrollIndicator={false}>
              {/* Hero */}
              <View style={{ alignItems: 'center', backgroundColor: colors.card, borderRadius: 24, padding: 24, borderWidth: 1, borderColor: colors.border, marginBottom: 20 }}>
                <View style={{ marginBottom: 14 }}>
                  <Avatar
                    url={selectedMember.avatar}
                    name={getDisplayName(selectedMember)}
                    size={76}
                    style={{ borderRadius: 22 }}
                    imageStyle={{ borderRadius: 22 }}
                  />
                </View>
                {editingNickname ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                    <TextInput
                      autoFocus
                      value={nicknameDraft}
                      onChangeText={setNicknameDraft}
                      placeholder={selectedMember.full_name || selectedMember.username}
                      style={{ fontSize: 15, fontFamily: 'Poppins_700Bold', color: INK, textAlign: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, minWidth: 160 }}
                    />
                    <TouchableOpacity
                      onPress={async () => {
                        const memberId = String(selectedMember.id || selectedMember._id);
                        await saveNickname(memberId, nicknameDraft);
                        setEditingNickname(false);
                      }}
                      style={{ paddingHorizontal: 10, paddingVertical: 8 }}
                    >
                      <Check size={18} color={PURPLE} />
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity
                    onPress={() => {
                      setNicknameDraft('');
                      setEditingNickname(true);
                    }}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
                  >
                    <Text style={{ fontSize: 20, fontFamily: 'SpaceGrotesk_700Bold', color: INK, textAlign: 'center' }}>
                      {getDisplayName(selectedMember)}
                    </Text>
                    <Edit2 size={13} color={INK_SOFT} />
                  </TouchableOpacity>
                )}
                {selectedMember.isAdmin && (
                  <View style={{ backgroundColor: 'rgba(108,92,231,0.15)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, marginTop: 10 }}>
                    <Text style={{ fontSize: 10, fontFamily: 'Poppins_700Bold', color: PURPLE, textTransform: 'uppercase', letterSpacing: 1 }}>Group Admin</Text>
                  </View>
                )}
              </View>

              {/* Detail cards (show what the member object carries) */}
              {!!selectedMember.email && (
                <InfoCard icon={<Mail size={19} color={PURPLE} />} label="Email Address" value={selectedMember.email} />
              )}
              {!!selectedMember.phone_number && (
                <InfoCard icon={<Phone size={19} color={PURPLE} />} label="Phone Number" value={selectedMember.phone_number} />
              )}
              {(!!selectedMember.organization || !!selectedMember.org_role) && (
                <InfoCard
                  icon={<Briefcase size={19} color={PURPLE} />}
                  label="Organization & Role"
                  value={[selectedMember.organization, selectedMember.org_role].filter(Boolean).join(' · ')}
                />
              )}

              {/* Quick actions */}
              {String(selectedMember.id || selectedMember._id) !== String(currentUserIdRef.current) && (
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                  <TouchableOpacity
                    onPress={() => {
                      const m = selectedMember;
                      const memberId = String(m.id || m._id);
                      setSelectedMember(null);
                      setIsInfoOpen(false);
                      // Navigate immediately with the member's context — the chat
                      // screen resolves/creates the conversation itself.
                      router.push({
                        pathname: `/chat/${memberId}` as any,
                        params: { name: getDisplayName(m), avatar: m.avatar || '', otherUserId: memberId },
                      });
                    }}
                    style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: PURPLE, borderRadius: 16, paddingVertical: 14 }}
                  >
                    <MessageSquare size={16} color="#fff" />
                    <Text style={{ color: '#fff', fontFamily: 'Poppins_700Bold', fontSize: 13 }}>Message</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => {
                      const m = selectedMember;
                      const memberId = String(m.id || m._id);
                      setSelectedMember(null);
                      startOutgoingCall({ id: memberId, otherUserId: memberId, name: getDisplayName(m), avatar: m.avatar }, 'voice');
                    }}
                    style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: PURPLE_SOFT, borderWidth: 1, borderColor: 'rgba(108,92,231,0.2)', borderRadius: 16, paddingVertical: 14, paddingHorizontal: 18 }}
                  >
                    <Phone size={16} color={PURPLE} />
                    <Text style={{ color: PURPLE, fontFamily: 'Poppins_700Bold', fontSize: 13 }}>Call</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => {
                      const m = selectedMember;
                      const memberId = String(m.id || m._id);
                      setSelectedMember(null);
                      startOutgoingCall({ id: memberId, otherUserId: memberId, name: getDisplayName(m), avatar: m.avatar }, 'video');
                    }}
                    style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: PURPLE_SOFT, borderWidth: 1, borderColor: 'rgba(108,92,231,0.2)', borderRadius: 16, paddingVertical: 14, paddingHorizontal: 18 }}
                  >
                    <Video size={16} color={PURPLE} />
                    <Text style={{ color: PURPLE, fontFamily: 'Poppins_700Bold', fontSize: 13 }}>Video</Text>
                  </TouchableOpacity>
                </View>
              )}
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>

      {/* ── Image Lightbox Modal ── */}
      <Modal visible={lightboxImageIndex !== null} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: '#000000', justifyContent: 'center', alignItems: 'center' }}>
          {/* Header */}
          <View style={{
            position: 'absolute',
            top: Platform.OS === 'ios' ? 50 : 20,
            left: 0,
            right: 0,
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingHorizontal: 20,
            zIndex: 10,
          }}>
            <View>
              <Text style={{ color: '#ffffff', fontSize: 14, fontFamily: 'Poppins_600SemiBold' }}>
                {lightboxImageIndex !== null ? `${lightboxImageIndex + 1} of ${imageMessages.length}` : ''}
              </Text>
              {lightboxImageIndex !== null && imageMessages[lightboxImageIndex]?.senderName && (
                <Text style={{ color: '#a0aec0', fontSize: 12, fontFamily: 'Poppins_400Regular' }}>
                  Sent by {imageMessages[lightboxImageIndex].senderName}
                </Text>
              )}
            </View>
            <TouchableOpacity
              onPress={() => setLightboxImageIndex(null)}
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: 'rgba(255,255,255,0.2)',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <X size={20} color="#ffffff" />
            </TouchableOpacity>
          </View>

          {/* Main Image */}
          {lightboxImageIndex !== null && imageMessages[lightboxImageIndex] && (
            <View style={{ width: '100%', height: '70%', justifyContent: 'center', alignItems: 'center' }}>
              <Image
                source={{ uri: getSecureMediaUrl(imageMessages[lightboxImageIndex].mediaUrl || imageMessages[lightboxImageIndex].media_url) || undefined }}
                style={{ width: '100%', height: '100%' }}
                contentFit="contain"
              />
              {imageMessages[lightboxImageIndex].text && imageMessages[lightboxImageIndex].text !== (imageMessages[lightboxImageIndex].mediaUrl || imageMessages[lightboxImageIndex].media_url) && (
                <View style={{
                  position: 'absolute',
                  bottom: -60,
                  backgroundColor: 'rgba(0,0,0,0.6)',
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  borderRadius: 12,
                  maxWidth: '85%',
                }}>
                  <Text style={{ color: '#ffffff', fontSize: 14, textAlign: 'center', fontFamily: 'Poppins_400Regular' }}>
                    {imageMessages[lightboxImageIndex].text}
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* Left / Right Nav Buttons */}
          {lightboxImageIndex !== null && imageMessages.length > 1 && (
            <View style={{
              position: 'absolute',
              bottom: 40,
              flexDirection: 'row',
              gap: 40,
              alignItems: 'center',
            }}>
              <TouchableOpacity
                disabled={lightboxImageIndex === 0}
                onPress={() => setLightboxImageIndex(prev => prev !== null && prev > 0 ? prev - 1 : prev)}
                style={{
                  width: 50,
                  height: 50,
                  borderRadius: 25,
                  backgroundColor: lightboxImageIndex === 0 ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.2)',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <ChevronLeft size={24} color={lightboxImageIndex === 0 ? '#4a5568' : '#ffffff'} />
              </TouchableOpacity>

              <TouchableOpacity
                disabled={lightboxImageIndex === imageMessages.length - 1}
                onPress={() => setLightboxImageIndex(prev => prev !== null && prev < imageMessages.length - 1 ? prev + 1 : prev)}
                style={{
                  width: 50,
                  height: 50,
                  borderRadius: 25,
                  backgroundColor: lightboxImageIndex === imageMessages.length - 1 ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.2)',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <ChevronRight size={24} color={lightboxImageIndex === imageMessages.length - 1 ? '#4a5568' : '#ffffff'} />
              </TouchableOpacity>
            </View>
          )}
        </View>
      </Modal>

      {/* ── Forward Message Modal ── */}
      <Modal visible={forwardingMessage !== null} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: 'rgba(31,32,48,0.5)', justifyContent: 'flex-end' }}>
          <View style={{
            backgroundColor: colors.card,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            padding: 24,
            height: '65%',
          }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <View>
                <Text style={{ fontSize: 18, fontFamily: 'SpaceGrotesk_700Bold', color: INK }}>Forward Message</Text>
                <Text style={{ fontSize: 12, fontFamily: 'Poppins_400Regular', color: INK_SOFT, marginTop: 2 }}>
                  Select a contact or group chat to forward this message
                </Text>
              </View>
              <TouchableOpacity onPress={() => setForwardingMessage(null)} style={{ padding: 4 }}>
                <X size={20} color={PURPLE} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 30 }}>
              {recentChats.length === 0 ? (
                <Text style={{ fontSize: 13, color: INK_SOFT, fontStyle: 'italic', textAlign: 'center', marginTop: 40 }}>
                  No recent chats found.
                </Text>
              ) : (
                recentChats.map((chatItem) => {
                  const isSent = forwardedChatIds.includes(String(chatItem.id));
                  const isLoading = isForwardLoading === String(chatItem.id);
                  return (
                    <View key={chatItem.id} style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      paddingVertical: 12,
                      borderBottomWidth: 1,
                      borderBottomColor: 'rgba(0,0,0,0.04)',
                    }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 10 }}>
                        <Avatar
                          url={chatItem.avatar}
                          userId={!chatItem.isGroupChat ? chatItem.otherUserId : undefined}
                          name={chatItem.name}
                          size={40}
                          isGroup={!!(chatItem.isGroupChat || chatItem.organization)}
                        />
                        <View style={{ marginLeft: 12, flex: 1 }}>
                          <Text numberOfLines={1} style={{ fontSize: 14, fontFamily: 'Poppins_600SemiBold', color: INK }}>
                            {chatItem.name}
                          </Text>
                          <Text numberOfLines={1} style={{ fontSize: 11, fontFamily: 'Poppins_400Regular', color: INK_SOFT, marginTop: 1 }}>
                            {chatItem.isGroupChat ? 'Group Chat' : 'Direct Chat'}
                          </Text>
                        </View>
                      </View>

                      <TouchableOpacity
                        disabled={isSent || isLoading}
                        onPress={() => handleForwardMessage(String(chatItem.id))}
                        style={{
                          backgroundColor: isSent ? '#f1f2f6' : PURPLE,
                          paddingHorizontal: 16,
                          paddingVertical: 8,
                          borderRadius: 12,
                          minWidth: 80,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {isLoading ? (
                          <Text style={{ color: '#ffffff', fontSize: 12, fontFamily: 'Poppins_700Bold' }}>Sending...</Text>
                        ) : isSent ? (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <Check size={12} color={INK_SOFT} />
                            <Text style={{ color: INK_SOFT, fontSize: 12, fontFamily: 'Poppins_700Bold' }}>Sent</Text>
                          </View>
                        ) : (
                          <Text style={{ color: '#ffffff', fontSize: 12, fontFamily: 'Poppins_700Bold' }}>Send</Text>
                        )}
                      </TouchableOpacity>
                    </View>
                  );
                })
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function IconBtn({ icon, onPress }: { icon: React.ReactNode; onPress?: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 10 }}>
      {icon}
    </TouchableOpacity>
  );
}

function InfoCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, padding: 16, borderRadius: 18, borderWidth: 1, borderColor: colors.border, marginBottom: 10 }}>
      {icon}
      <View style={{ marginLeft: 12, flex: 1 }}>
        <Text style={{ fontSize: 10, fontFamily: 'Poppins_700Bold', color: colors.textSoft, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</Text>
        <Text style={{ fontSize: 13.5, fontFamily: 'Poppins_600SemiBold', color: colors.text, marginTop: 2 }}>{value}</Text>
      </View>
    </View>
  );
}

function DropdownItem({
  icon,
  label,
  onPress,
  labelStyle
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  labelStyle?: any;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 14,
      }}
    >
      {icon}
      <Text style={[{ fontSize: 13, color: '#1f2030', fontFamily: 'Poppins_500Medium', marginLeft: 10 }, labelStyle]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function ContextMenuItem({
  icon,
  label,
  onPress,
  labelStyle
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  labelStyle?: any;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 8,
      }}
    >
      {icon}
      <Text style={[{ fontSize: 13.5, color: '#1f2030', fontFamily: 'Poppins_500Medium', marginLeft: 10 }, labelStyle]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function countMedia(messages: any[]) {
  let images = 0, videos = 0, audio = 0, files = 0, voice = 0;
  const imageUrls: string[] = [];
  const videoItems: any[] = [];
  const audioItems: any[] = [];
  const fileItems: any[] = [];
  const voiceItems: any[] = [];
  const linkItems: any[] = [];

  for (const m of messages) {
    const url = m.mediaUrl;
    const t = m.message_type || '';

    if (m.text) {
      const match = m.text.match(/(https?:\/\/[^\s]+)/gi);
      if (match) {
        match.forEach((link: string) => {
          linkItems.push({
            label: link.replace(/^https?:\/\/(www\.)?/, '').split('/')[0],
            url: link,
          });
        });
      }
    }

    if (!url) continue;

    if (t === 'image' || m.mimeType?.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(url)) {
      images++;
      imageUrls.push(url);
    } else if (t === 'video' || m.mimeType?.startsWith('video/') || /\.(mp4|webm|mov|mkv)(\?|$)/i.test(url)) {
      videos++;
      videoItems.push({
        label: m.fileName || url.split('/').pop() || 'Video file',
        url: url,
      });
    } else if (t === 'voice' || t === 'audio' || m.mimeType?.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|weba)(\?|$)/i.test(url)) {
      if (t === 'voice') {
        voice++;
        voiceItems.push({
          label: `Voice note (${m.duration || '0:14'})`,
          url: url,
        });
      } else {
        audio++;
        audioItems.push({
          label: m.fileName || url.split('/').pop() || 'Audio file',
          url: url,
        });
      }
    } else {
      files++;
      fileItems.push({
        label: m.fileName || url.split('/').pop() || 'Attachment file',
        url: url,
      });
    }
  }

  return {
    images,
    videos,
    audio,
    files,
    voice,
    imageUrls,
    videoItems,
    audioItems,
    fileItems,
    voiceItems,
    linkItems,
  };
}

function VoiceMessagePlayer({ msg, isMe }: { msg: any; isMe: boolean }) {
  // Resolve the stored voice note through the secure media proxy and play it for
  // real via expo-audio (replaces the old timer-driven fake waveform).
  const audioUri = getSecureMediaUrl(msg.mediaUrl || msg.media_url);
  const player = useAudioPlayer(audioUri ? { uri: audioUri } : null);
  const status = useAudioPlayerStatus(player);

  const fallbackDuration = msg.media_metadata?.duration || msg.media_duration || msg.duration || 14;
  const duration = status?.duration && status.duration > 0 ? status.duration : fallbackDuration;
  const currentSecs = status?.currentTime || 0;
  const progress = duration > 0 ? Math.min(1, currentSecs / duration) : 0;
  const isPlaying = !!status?.playing;

  // Restart from the top once playback finishes so the bubble is replayable.
  useEffect(() => {
    if (status?.didJustFinish) {
      try { player.seekTo(0); player.pause(); } catch { /* ignore */ }
    }
  }, [status?.didJustFinish]);

  const handlePlayPause = () => {
    if (!audioUri) return;
    try {
      if (isPlaying) {
        player.pause();
      } else {
        if (progress >= 1) player.seekTo(0);
        player.play();
      }
    } catch { /* ignore */ }
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const waveformBars = [12, 18, 8, 24, 14, 28, 10, 16, 22, 12, 26, 8, 18, 14, 20];

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', width: 220, paddingVertical: 4 }}>
        <TouchableOpacity
          onPress={handlePlayPause}
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            backgroundColor: isMe ? '#ffffff' : '#6c5ce7',
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 10,
          }}
        >
          {isPlaying ? (
            <Pause size={14} color={isMe ? '#6c5ce7' : '#ffffff'} />
          ) : (
            <Play size={14} color={isMe ? '#6c5ce7' : '#ffffff'} style={{ marginLeft: 2 }} />
          )}
        </TouchableOpacity>

        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2.5, height: 32, marginBottom: 2 }}>
            {waveformBars.map((barHeight, idx) => {
              const barProgress = idx / waveformBars.length;
              const isPlayed = progress >= barProgress;
              return (
                <View
                  key={idx}
                  style={{
                    width: 3,
                    height: barHeight,
                    borderRadius: 1.5,
                    backgroundColor: isMe
                      ? (isPlayed ? '#ffffff' : 'rgba(255,255,255,0.4)')
                      : (isPlayed ? '#6c5ce7' : 'rgba(108,92,231,0.2)'),
                  }}
                />
              );
            })}
          </View>

          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 10.5, color: isMe ? 'rgba(255,255,255,0.8)' : '#9a9aab', fontFamily: 'Poppins_400Regular' }}>
              {formatTime(currentSecs)}
            </Text>
            <Text style={{ fontSize: 10.5, color: isMe ? 'rgba(255,255,255,0.8)' : '#9a9aab', fontFamily: 'Poppins_400Regular' }}>
              {formatTime(duration)}
            </Text>
          </View>
        </View>
      </View>

      {/* Auto-transcription, shown once the backend's STT job completes. */}
      {msg.transcript ? (
        <Text style={{
          fontSize: 11.5,
          fontStyle: 'italic',
          lineHeight: 16,
          maxWidth: 220,
          marginTop: 2,
          color: isMe ? 'rgba(255,255,255,0.8)' : '#6b6b7b',
          fontFamily: 'Poppins_400Regular',
        }}>
          “{msg.transcript}”
        </Text>
      ) : null}
    </View>
  );
}
