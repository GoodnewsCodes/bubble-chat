import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Modal,
  Alert,
  Switch,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../../lib/theme';
import {
  Search,
  UserPlus,
  Plus,
  Phone,
  Video,
  MessageSquare,
  Users,
  Briefcase,
  X,
  Check,
  PhoneOff,
  MicOff,
  Volume2,
  Scan,
  History as HistoryIcon,
  PhoneMissed,
  FileText,
} from 'lucide-react-native';
import { Link, useNavigation, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import {
  Contact,
  Chat,
  subscribeToPlusButton,
} from '../../lib/mockData';
import { chatCache } from '../../lib/chatCache';
import { addContact, createGroupChat, getSecureMediaUrl, accessOrCreateChat, getOrgMembers, fetchMeetings, fetchCallLogs, fetchMeetingById, deleteCallLog, fetchActiveMeetings } from '../../lib/api';
import { startOutgoingCall, joinRoomByLink, knockToJoinRoom } from '../../lib/callManager';
import { useIsOnline, useIsInMeeting } from '../../lib/presence';
import { authStorage } from '../../lib/authStorage';
import { getSocket } from '../../lib/socket';
import { useNicknames, getCachedNickname } from '../../lib/nicknames';
import Svg, { Text as SvgText, Defs, LinearGradient, Stop } from 'react-native-svg';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { BlurView } from 'expo-blur';
import { Avatar as SharedAvatar } from '../../components/Avatar';
import { MeetingDetailModal } from '../../components/MeetingDetailModal';

// ─────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────
function getInitials(name: string) {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function getGroupInitials(name: string) {
  const clean = name.trim().replace(/\s+/g, ' ');
  const parts = clean.split(' ');
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

// ─────────────────────────────────────────────
// Avatar Component
// ─────────────────────────────────────────────
function Avatar({
  name,
  avatar,
  size = 52,
  isOnline,
  userId,
  isGroup = false,
  organization,
}: {
  name: string;
  avatar?: string | null;
  size?: number;
  isOnline?: boolean;
  userId?: string | null;
  isGroup?: boolean;
  organization?: string;
}) {
  const isFallbackBlack = isGroup;
  const online = useIsOnline(userId, !!isOnline);
  const inMeeting = useIsInMeeting(userId);

  // Blink the dot while the user is in a live meeting (distinct from a steady
  // online dot) so "someone is on a call right now" reads at a glance.
  const blink = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (inMeeting && !isGroup) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(blink, { toValue: 0.25, duration: 600, useNativeDriver: true }),
          Animated.timing(blink, { toValue: 1, duration: 600, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
  }, [inMeeting, isGroup, blink]);

  return (
    <View style={{ width: size, height: size }} className="relative shrink-0">
      <SharedAvatar
        url={avatar}
        // userId unlocks the offline base64 avatar cache (keyed by user id) —
        // without it, cards fell back to initials whenever the URL was
        // unsigned/expired even though the avatar was already cached locally.
        userId={userId}
        name={name}
        size={size}
        isGroup={isFallbackBlack}
        imageStyle={{ borderRadius: size * 0.38 }}
        style={{ borderRadius: size * 0.38 }}
      />
      {inMeeting && !isGroup ? (
        <Animated.View
          className="absolute -bottom-0.5 -right-0.5 bg-emerald-500 rounded-full border-2 border-white shadow-xs"
          style={{ width: size * 0.3, height: size * 0.3, opacity: blink }}
        />
      ) : online && !isGroup ? (
        <View
          className="absolute -bottom-0.5 -right-0.5 bg-emerald-500 rounded-full border-2 border-white shadow-xs"
          style={{ width: size * 0.27, height: size * 0.27 }}
        />
      ) : null}
    </View>
  );
}

// ─────────────────────────────────────────────
// Contacts Sub-Tab
// ─────────────────────────────────────────────
function ContactsTab({
  showAddModal,
  setShowAddModal,
  onStartCall,
  onOpenScanner,
}: {
  showAddModal: boolean;
  setShowAddModal: (v: boolean) => void;
  onStartCall: (user: any, type: 'voice' | 'video') => void;
  onOpenScanner: () => void;
}) {
  const { colors } = useTheme();
  const [search, setSearch] = useState('');
  const [addIdentifier, setAddIdentifier] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  // FIX: use chats to resolve real unread counts per contact
  const [chats, setChats] = useState<any[]>([]);
  const [typingChats, setTypingChats] = useState<Record<string, { fromUserId: string; fromUsername?: string; fromName?: string } | false>>({});

  const currentUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    authStorage.getUser().then((user) => {
      if (user) {
        currentUserIdRef.current = String(user.id || user._id);
      }
    });
  }, []);

  const loadCache = async () => {
    const cached = await chatCache.getCachedContacts();
    setContacts(cached);
    const cachedChats = await chatCache.getCachedChats();
    setChats(cachedChats);
  };

  const syncContacts = async () => {
    try {
      const fresh = await chatCache.syncContactsWithBackend();
      setContacts(fresh);
      const freshChats = await chatCache.syncChatsWithBackend();
      setChats(freshChats);
    } catch (err) {
      console.warn("Silent sync failed in ContactsTab:", err);
    }
  };

  useEffect(() => {
    loadCache();
    syncContacts();
  }, []);

  useEffect(() => {
    const interval = setInterval(syncContacts, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleTypingStart = (data: { chatId: string, fromUserId: string, fromUsername?: string, fromName?: string }) => {
      if (currentUserIdRef.current && String(data.fromUserId) === String(currentUserIdRef.current)) return;
      if (data.chatId) setTypingChats(prev => ({ ...prev, [data.chatId]: { fromUserId: data.fromUserId, fromUsername: data.fromUsername, fromName: data.fromName } }));
    };
    const handleTypingStop = (data: { chatId: string }) => {
      if (data.chatId) setTypingChats(prev => ({ ...prev, [data.chatId]: false }));
    };

    socket.on('typing_start', handleTypingStart);
    socket.on('typing_stop', handleTypingStop);

    return () => {
      socket.off('typing_start', handleTypingStart);
      socket.off('typing_stop', handleTypingStop);
    };
  }, []);

  const filtered = contacts
    .filter((c) => (c.name + c.username + (c.org_role || '')).toLowerCase().includes(search.toLowerCase()))
    .filter((c, i, arr) => arr.findIndex((x) => String(x.id) === String(c.id)) === i); // dedupe by id

  const handleAdd = async () => {
    const tag = addIdentifier.trim();
    if (!tag) return;
    try {
      await addContact(tag);
      setAddIdentifier('');
      setShowAddModal(false);
      await syncContacts();
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to add contact.");
    }
  };

  // FIX: resolve correct chat for a contact, prioritising 1-on-1 (non-group) chats
  const getChatForContact = (contact: Contact) => {
    return chats.find(c =>
      !c.isGroupChat &&
      (String(c.otherUserId) === String(contact.id) || String(c.id) === String(contact.id))
    );
  };

  return (
    <View className="flex-1">
      {/* Search + Action Row */}
      <View className="px-5 pb-3 pt-2 flex-row items-center gap-3">
        <View className="flex-1 flex-row items-center bg-purple/10 rounded-3xl border border-purple/5 px-4 py-2.5 shadow-sm shadow-purple/5">
          <Search color="#6c5ce7" size={16} />
          <TextInput
            placeholder="Search contacts..."
            value={search}
            onChangeText={setSearch}
            placeholderTextColor="rgba(108,92,231,0.4)"
            className="flex-1 text-[14px] text-ink dark:text-[#f4f5fb] font-medium font-sans ml-2"
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')}>
              <X color="#9a9aab" size={14} />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity
          onPress={onOpenScanner}
          style={{ width: 40, height: 40, backgroundColor: 'rgba(108,92,231,0.1)', borderRadius: 14, alignItems: 'center', justifyContent: 'center' }}
        >
          <Scan color="#6c5ce7" size={18} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setShowAddModal(true)}
          className="flex-row items-center bg-purple rounded-2xl px-4 py-2.5 shadow-xs"
        >
          <UserPlus color="#fff" size={15} />
          <Text className="text-white text-xs font-bold font-sans ml-1.5">Add</Text>
        </TouchableOpacity>
      </View>

      <ScrollView className="flex-1 px-5" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 130 }}>
        {/* Section header */}
        <View className="flex-row items-center mb-3 mt-1">
          <Text className="text-[10px] font-bold text-ink-soft dark:text-[#9a9bb6] uppercase tracking-widest font-sans">
            My Contacts
          </Text>
          <View className="flex-1 h-[1px] bg-black/5 dark:bg-white/[0.06] ml-3" />
          <View className="ml-3 bg-purple/10 px-2 py-0.5 rounded-full">
            <Text className="text-[9px] font-bold text-purple uppercase font-sans">
              {contacts.length} Total
            </Text>
          </View>
        </View>

        {filtered.length === 0 ? (
          <View
            className="py-16 items-center justify-center border-2 border-dashed rounded-3xl mt-2"
            style={{ backgroundColor: colors.isDark ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.5)', borderColor: colors.border }}
          >
            <View className="w-16 h-16 rounded-3xl bg-purple-soft/50 items-center justify-center mb-4">
              <Users color="#6c5ce7" size={28} />
            </View>
            <Text className="text-base font-bold text-ink dark:text-[#f4f5fb] font-sans">No contacts found</Text>
            <Text className="text-xs text-ink-soft dark:text-[#9a9bb6] mt-1 text-center max-w-[220px] leading-relaxed font-sans">
              {search
                ? 'Try a different name or username'
                : 'Add contacts to start connecting with people'}
            </Text>
            {!search && (
              <TouchableOpacity
                onPress={() => setShowAddModal(true)}
                className="mt-5 bg-purple px-5 py-3 rounded-2xl shadow-sm"
              >
                <Text className="text-white text-xs font-bold font-sans">
                  Add your first contact
                </Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          filtered.map((contact) => {
            // FIX: only match non-group 1-on-1 chats for unread badge
            const matchingChat = getChatForContact(contact);
            const typingInfo = matchingChat && typingChats[matchingChat.id];
            // FIX: unread count comes from the actual chat — 0 if no chat exists
            const unreadCount = matchingChat?.unreadCount || 0;
            // FIX: navigate to the chat id if exists, otherwise contact id (will create DM)
            const chatTarget = matchingChat?.id || contact.id;

            return (
              <View
                key={contact.id}
                className="flex-row items-center rounded-2xl px-4 py-3.5 mb-3 shadow-sm shadow-purple/5"
                style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.borderStrong }}
              >
                <Link href={`/chat/${chatTarget}`} asChild>
                  <TouchableOpacity
                    activeOpacity={0.75}
                    className="flex-1 flex-row items-center"
                  >
                    <Avatar name={contact.name} avatar={contact.avatar} size={50} isOnline={contact.isOnline} userId={contact.id} organization={contact.organization} />

                    {/* Info */}
                    <View className="flex-1 min-w-0 ml-3">
                      <View className="flex-row items-center justify-between">
                        <Text className="text-[15px] font-bold text-ink dark:text-[#f4f5fb] leading-tight font-sans flex-1" numberOfLines={1}>
                          {contact.name}
                        </Text>
                        {/* FIX: only show badge when there are real unread messages */}
                        {unreadCount > 0 && (
                          <View style={{ width: 20, height: 20, borderRadius: 99, backgroundColor: '#f4663b', alignItems: 'center', justifyContent: 'center', marginLeft: 6 }}>
                            <Text style={{ fontSize: 10, fontFamily: 'Poppins_700Bold', color: '#fff', lineHeight: 13 }}>
                              {unreadCount > 9 ? '9+' : unreadCount}
                            </Text>
                          </View>
                        )}
                      </View>
                      {typingInfo ? (
                        <Text className="text-[11px] font-semibold text-purple mt-0.5 font-sans">
                          {typingInfo.fromUsername ? `@${typingInfo.fromUsername} is typing...` : typingInfo.fromName ? `${typingInfo.fromName} is typing...` : 'typing...'}
                        </Text>
                      ) : matchingChat?.latestMessage ? (
                        <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] mt-0.5 font-sans" numberOfLines={1}>
                          {matchingChat.latestMessage}
                        </Text>
                      ) : (
                        <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] mt-0.5 font-sans" numberOfLines={1}>
                          @{contact.username}
                          {contact.org_role ? ` · ${contact.org_role}` : ''}
                        </Text>
                      )}
                    </View>
                  </TouchableOpacity>
                </Link>

                {/* Action Buttons */}
                <View className="flex-row items-center gap-2 ml-2">
                  <Link href={`/chat/${chatTarget}`} asChild>
                    <TouchableOpacity className="w-8 h-8 rounded-xl bg-purple-soft/40 dark:bg-purple/15 items-center justify-center">
                      <MessageSquare color="#6c5ce7" size={14} />
                    </TouchableOpacity>
                  </Link>
                  <TouchableOpacity
                    onPress={() => onStartCall(contact, 'voice')}
                    className="w-8 h-8 rounded-xl bg-purple-soft/40 dark:bg-purple/15 items-center justify-center"
                  >
                    <Phone color="#6c5ce7" size={14} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => onStartCall(contact, 'video')}
                    className="w-8 h-8 rounded-xl bg-purple-soft/40 dark:bg-purple/15 items-center justify-center"
                  >
                    <Video color="#6c5ce7" size={14} />
                  </TouchableOpacity>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      {/* Soft bottom fade — list gently blurs out as it scrolls past the edge */}
      {filtered.length > 4 && (
        <BlurView
          intensity={18}
          tint={colors.isDark ? 'dark' : 'light'}
          pointerEvents="none"
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 44 }}
        />
      )}

      {/* Add Friend Modal */}
      <Modal visible={showAddModal} transparent animationType="slide">
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => {
            setShowAddModal(false);
            setAddIdentifier('');
          }}
          className="flex-1 bg-black/60 justify-end"
        >
          <TouchableOpacity activeOpacity={1}>
            <SafeAreaView className="bg-white dark:bg-[#1a1b28] rounded-t-3xl shadow-2xl" edges={['bottom']}>
              <View className="px-6 pt-6 pb-2">
                <View className="flex-row items-start justify-between mb-2">
                  <View>
                    <Text className="text-lg font-bold text-ink dark:text-[#f4f5fb] font-display">Add a Contact</Text>
                    <Text className="text-xs text-ink-soft dark:text-[#9a9bb6] mt-0.5 font-sans">
                      Add by @username, Bubble ID, or email — or scan their QR
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => {
                      setShowAddModal(false);
                      setAddIdentifier('');
                    }}
                    className="w-8 h-8 rounded-xl bg-black/5 dark:bg-white/[0.06] items-center justify-center"
                  >
                    <X color="#6c5ce7" size={16} />
                  </TouchableOpacity>
                </View>

                <View className="bg-purple-soft/30 dark:bg-white/5 rounded-2xl border border-purple/10 px-4 py-3.5 mt-4 mb-4">
                  <TextInput
                    value={addIdentifier}
                    onChangeText={setAddIdentifier}
                    placeholder="@username · Bubble ID · email"
                    placeholderTextColor="#9a9aab"
                    className="text-[15px] text-ink dark:text-[#f4f5fb] font-sans"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>

                <View className="flex-row gap-3 mb-2">
                  <TouchableOpacity
                    onPress={() => {
                      setShowAddModal(false);
                      setAddIdentifier('');
                    }}
                    className="flex-1 border border-black/10 dark:border-white/20 rounded-xl py-3 items-center"
                  >
                    <Text className="text-sm font-semibold text-ink-soft dark:text-[#9a9bb6] font-sans">Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handleAdd}
                    className="flex-1 bg-purple rounded-xl py-3 items-center flex-row justify-center shadow-sm"
                  >
                    <Text className="text-white text-sm font-bold font-sans">Add Contact</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </SafeAreaView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

// ─────────────────────────────────────────────
// Workroom Sub-Tab
// FIX: navigate to 1-on-1 DM chat, not group
// ─────────────────────────────────────────────
function WorkroomTab({
  onStartCall,
  onOpenScanner,
}: {
  onStartCall: (user: any, type: 'voice' | 'video') => void;
  onOpenScanner: () => void;
}) {
  const { colors } = useTheme();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [chats, setChats] = useState<any[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [loadingDm, setLoadingDm] = useState<string | null>(null);

  const loadCacheAndSync = async () => {
    const cachedChats = await chatCache.getCachedChats();
    setChats(cachedChats);

    try {
      // searchUsers('') now intentionally returns only explicit contacts (org
      // colleagues shouldn't auto-populate a personal surface). Workroom needs the
      // actual org directory, so it uses the same endpoint web's Work tab uses.
      const response = await getOrgMembers();
      const rawList = response?.members || response?.data || [];
      const coworkersList = rawList.map((u: any) => ({
        id: String(u.id || u._id),
        name: getCachedNickname(String(u.id || u._id)) || u.full_name || u.name || u.username || "Unknown",
        avatar: u.avatar || null,
        isOnline: !!u.isOnline,
        username: u.username || "",
        org_role: u.org_role || "",
        organization: u.organization || "",
      }));
      setContacts(coworkersList);
    } catch (err) {
      console.warn("Workroom coworker fetch failed, fallback to cache:", err);
      const cachedContacts = await chatCache.getCachedContacts();
      setContacts(cachedContacts);
    }
  };

  useEffect(() => {
    loadCacheAndSync();
    const interval = setInterval(loadCacheAndSync, 5000);
    return () => clearInterval(interval);
  }, []);

  // FIX: Find existing 1-on-1 DM chat for a member, or create one via API.
  // Always carry the member's name/avatar as route params so a chat that isn't
  // cached yet renders instantly instead of stalling on "Loading conversation…".
  const handleOpenDm = async (member: any) => {
    const dmParams = {
      name: member.name || member.full_name || '',
      avatar: member.avatar || '',
      otherUserId: String(member.id),
    };
    // First check local cache for existing non-group chat
    const existingChat = chats.find(c =>
      !c.isGroupChat &&
      (String(c.otherUserId) === String(member.id) || String(c.id) === String(member.id))
    );

    if (existingChat) {
      router.push({ pathname: `/chat/${existingChat.id}` as any, params: dmParams });
      return;
    }

    // Navigate IMMEDIATELY by member id — the chat screen resolves/creates the
    // conversation itself (accessOrCreateChat) and renders the empty thread from
    // the params meanwhile. No blocking spinner here.
    setLoadingDm(member.id);
    try {
      router.push({ pathname: `/chat/${member.id}` as any, params: dmParams });
    } finally {
      setLoadingDm(null);
    }
  };

  const filteredGroups = chats.filter(
    (c) => c.isGroupChat && c.name.toLowerCase().includes(search.toLowerCase())
  );

  const filteredMembers = contacts.filter((m) =>
    (m.name + (m.org_role || '')).toLowerCase().includes(search.toLowerCase())
  );

  return (
    <View className="flex-1">
      {/* Search Bar */}
      <View className="px-5 pb-3 pt-2 flex-row items-center gap-3">
        <View className="flex-1 flex-row items-center bg-purple/10 rounded-3xl border border-purple/5 px-4 py-2.5 shadow-sm shadow-purple/5">
          <Search color={colors.purple} size={16} />
          <TextInput
            placeholder="Search groups or members..."
            value={search}
            onChangeText={setSearch}
            placeholderTextColor={colors.textSoft}
            className="flex-1 text-[14px] text-ink dark:text-[#f4f5fb] font-medium font-sans ml-2"
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')}>
              <X color="#9a9aab" size={14} />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity
          onPress={onOpenScanner}
          style={{ width: 40, height: 40, backgroundColor: colors.purpleSoft, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }}
        >
          <Scan color={colors.purple} size={18} />
        </TouchableOpacity>
      </View>

      <ScrollView className="flex-1 px-5" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 130 }}>
        {/* Active Collaborative Groups */}
        {filteredGroups.length > 0 && (
          <View className="mb-4">
            <View className="flex-row items-center mb-3">
              <Text className="text-[10px] font-bold text-ink-soft dark:text-[#9a9bb6] uppercase tracking-widest font-sans">
                Group Workspaces
              </Text>
              <View className="flex-1 h-[1px] bg-black/5 dark:bg-white/[0.06] ml-3" />
            </View>

            {filteredGroups.map((group) => (
              <Link href={`/chat/${group.id}`} key={group.id} asChild>
                <TouchableOpacity
                  activeOpacity={0.75}
                  className="flex-row items-center bg-white dark:bg-[#1a1b28] border border-black/5 dark:border-white/10 rounded-[22px] px-4 py-4 mb-2.5 shadow-sm shadow-purple/5"
                >
                  <Avatar name={group.name} avatar={group.avatar} size={50} isOnline={false} isGroup={true} />
                  <View className="flex-1 min-w-0 ml-3">
                    <Text className="text-[15px] font-bold text-ink dark:text-[#f4f5fb] leading-tight font-sans" numberOfLines={1}>
                      {group.name}
                    </Text>
                    <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] mt-0.5 font-sans">
                      Group Chat · {group.messages?.length || 0} messages
                    </Text>
                  </View>
                  <View className="h-8 flex-row items-center bg-purple px-3.5 rounded-xl gap-1 shadow-xs">
                    <MessageSquare color="#fff" size={13} />
                    <Text className="text-white text-[11px] font-bold font-sans">Open</Text>
                  </View>
                </TouchableOpacity>
              </Link>
            ))}
          </View>
        )}

        {/* Organization Members — FIX: tap opens 1-on-1 DM, not group */}
        {filteredMembers.length > 0 && (
          <View className="mb-8">
            <View className="flex-row items-center mb-3">
              <Text className="text-[10px] font-bold text-ink-soft dark:text-[#9a9bb6] uppercase tracking-widest font-sans">
                Org Members
              </Text>
              <View className="flex-1 h-[1px] bg-black/5 dark:bg-white/[0.06] ml-3" />
            </View>

            {filteredMembers.map((member) => (
              <View
                key={member.id}
                className="flex-row items-center bg-white dark:bg-[#1a1b28] border border-black/5 dark:border-white/10 rounded-[22px] px-4 py-3.5 mb-2.5 shadow-sm shadow-purple/5"
              >
                {/* FIX: TouchableOpacity calls handleOpenDm which ensures 1-on-1 DM */}
                <TouchableOpacity
                  activeOpacity={0.75}
                  onPress={() => handleOpenDm(member)}
                  className="flex-1 flex-row items-center"
                  disabled={loadingDm === member.id}
                >
                  <Avatar name={member.name} avatar={member.avatar} size={50} isOnline={member.isOnline} userId={member.id} organization={member.organization} />
                  <View className="flex-1 min-w-0 ml-3">
                    <View className="flex-row items-center gap-1.5 flex-wrap">
                      <Text className="text-[15px] font-bold text-ink dark:text-[#f4f5fb] leading-tight font-sans" numberOfLines={1}>
                        {member.name}
                      </Text>
                      {member.org_role && (
                        <View className="bg-purple/10 px-1.5 py-0.5 rounded-full">
                          <Text className="text-[9px] font-bold text-purple uppercase tracking-wider font-sans">
                            {member.org_role}
                          </Text>
                        </View>
                      )}
                    </View>
                    <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] mt-0.5 font-sans">
                      {loadingDm === member.id ? 'Opening chat...' : `@${member.username}`}
                    </Text>
                  </View>
                </TouchableOpacity>

                {/* Action Buttons */}
                <View className="flex-row items-center gap-2 ml-2">
                  {/* FIX: message icon also opens 1-on-1 DM */}
                  <TouchableOpacity
                    onPress={() => handleOpenDm(member)}
                    className="w-8 h-8 rounded-xl items-center justify-center"
                    style={{ backgroundColor: colors.purpleSoft }}
                    disabled={loadingDm === member.id}
                  >
                    <MessageSquare color={colors.purple} size={14} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => onStartCall(member, 'voice')}
                    className="w-8 h-8 rounded-xl items-center justify-center"
                    style={{ backgroundColor: colors.purpleSoft }}
                  >
                    <Phone color={colors.purple} size={14} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => onStartCall(member, 'video')}
                    className="w-8 h-8 rounded-xl items-center justify-center"
                    style={{ backgroundColor: colors.purpleSoft }}
                  >
                    <Video color={colors.purple} size={14} />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        )}

        {filteredGroups.length === 0 && filteredMembers.length === 0 && (
          <View className="py-16 items-center justify-center border-2 border-dashed border-black/5 dark:border-white/10 rounded-3xl mt-2 bg-white/50 dark:bg-white/[0.04]">
            <View className="w-16 h-16 rounded-3xl items-center justify-center mb-4" style={{ backgroundColor: colors.purpleSoft }}>
              <Briefcase color={colors.purple} size={28} />
            </View>
            <Text className="text-base font-bold text-ink dark:text-[#f4f5fb] font-sans">No workroom members</Text>
            <Text className="text-xs text-ink-soft dark:text-[#9a9bb6] mt-1 text-center max-w-[220px] leading-relaxed font-sans">
              {search ? 'Try a different search' : 'Join an organization to see your team here'}
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────
// History Sub-Tab — unified call history (call logs + meetings), mirroring the
// web Events & Calls "Call Logs" data flow: fetchCallLogs() + fetchMeetings()
// merged and sorted, with voice/video/duration/timestamp and meeting minutes.
// ─────────────────────────────────────────────
function HistoryTab({
  onStartCall,
}: {
  onStartCall: (user: any, type: 'voice' | 'video') => void;
}) {
  const { colors } = useTheme();
  const [search, setSearch] = useState('');
  const [callLogs, setCallLogs] = useState<any[]>([]);
  const [meetings, setMeetings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMeeting, setSelectedMeeting] = useState<any | null>(null);
  const [meetingDetailLoading, setMeetingDetailLoading] = useState(false);

  const load = async () => {
    try {
      const [logsRes, meetingsRes] = await Promise.all([
        fetchCallLogs().catch(() => ({ logs: [] })),
        fetchMeetings(1, 50).catch(() => ({ meetings: [] })),
      ]);
      const logs = (logsRes as any)?.logs || (logsRes as any)?.data || (Array.isArray(logsRes) ? logsRes : []);
      setCallLogs(logs);
      setMeetings(Array.isArray((meetingsRes as any)?.meetings) ? (meetingsRes as any).meetings : (Array.isArray(meetingsRes) ? (meetingsRes as any) : []));
    } catch (err) {
      console.warn('Failed to load call history:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, []);

  // Merge call logs + meetings into one list, newest first (calls.tsx parity).
  const unifiedLogs = React.useMemo(() => {
    const rawLogs = callLogs.map((l) => ({
      id: String(l._id || l.id),
      isMeeting: false as const,
      raw: l,
      timestamp: l.timestamp || l.createdAt,
      type: l.type,
      duration: l.duration || 0,
      missed: !!l.missed,
      label: l.label || 'Call',
    }));
    const rawMeetings = meetings.map((m) => ({
      id: String(m._id || m.id),
      isMeeting: true as const,
      raw: m,
      timestamp: m.startedAt || m.createdAt,
      type: m.type || 'video',
      duration: m.duration || 0,
      missed: false,
      label: m.title || 'Untitled Meeting',
    }));
    return [...rawLogs, ...rawMeetings].sort(
      (a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime()
    );
  }, [callLogs, meetings]);

  const filtered = unifiedLogs.filter((l) => l.label.toLowerCase().includes(search.toLowerCase()));

  const handleDeleteLog = async (id: string) => {
    setCallLogs((prev) => prev.filter((l) => String(l._id || l.id) !== String(id)));
    try { await deleteCallLog(id); } catch { /* best-effort */ }
  };

  const openMeetingDetail = async (meeting: any) => {
    setSelectedMeeting(meeting);
    setMeetingDetailLoading(true);
    try {
      const res: any = await fetchMeetingById(String(meeting._id || meeting.id));
      const full = res?.meeting || res?.data || res;
      if (full) setSelectedMeeting(full);
    } catch (err) {
      console.warn('Failed to load meeting detail:', err);
    } finally {
      setMeetingDetailLoading(false);
    }
  };

  return (
    <View className="flex-1">
      <View className="px-5 pb-3 pt-2 flex-row items-center gap-3">
        <View className="flex-1 flex-row items-center bg-purple/10 rounded-3xl border border-purple/5 px-4 py-2.5 shadow-sm shadow-purple/5">
          <Search color="#6c5ce7" size={16} />
          <TextInput
            placeholder="Search call history..."
            value={search}
            onChangeText={setSearch}
            placeholderTextColor="rgba(108,92,231,0.4)"
            className="flex-1 text-[14px] text-ink dark:text-[#f4f5fb] font-medium font-sans ml-2"
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')}>
              <X color="#9a9aab" size={14} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <ScrollView className="flex-1 px-5" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 130 }}>
        <View className="flex-row items-center mb-3 mt-1">
          <Text className="text-[10px] font-bold text-ink-soft dark:text-[#9a9bb6] uppercase tracking-widest font-sans">
            Call History
          </Text>
          <View className="flex-1 h-[1px] bg-black/5 dark:bg-white/[0.06] ml-3" />
        </View>

        {loading && filtered.length === 0 ? (
          <Text className="text-center text-ink-soft dark:text-[#9a9bb6] text-sm mt-12 font-sans">Loading call history…</Text>
        ) : filtered.length === 0 ? (
          <View
            className="py-16 items-center justify-center border-2 border-dashed rounded-3xl mt-2"
            style={{ backgroundColor: colors.isDark ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.5)', borderColor: colors.border }}
          >
            <View className="w-16 h-16 rounded-3xl bg-purple-soft/50 items-center justify-center mb-4">
              <HistoryIcon color="#6c5ce7" size={28} />
            </View>
            <Text className="text-base font-bold text-ink dark:text-[#f4f5fb] font-sans">No call history yet</Text>
            <Text className="text-xs text-ink-soft dark:text-[#9a9bb6] mt-1 text-center max-w-[220px] leading-relaxed font-sans">
              Your voice and video calls will show up here.
            </Text>
          </View>
        ) : (
          filtered.map((item) => {
            const log = item.raw;
            const isVideo = item.type === 'video';
            const missed = item.missed;
            const whenStr = item.timestamp ? new Date(item.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
            const mins = Math.floor(item.duration / 60);
            const secs = item.duration % 60;
            const durStr = item.duration ? `${mins}:${secs.toString().padStart(2, '0')}` : '';
            const Icon = missed ? PhoneMissed : isVideo ? Video : Phone;
            return (
              <TouchableOpacity
                key={item.id}
                activeOpacity={0.8}
                onPress={() => (item.isMeeting ? openMeetingDetail(log) : startOutgoingCall({ name: item.label, avatar: null }, isVideo ? 'video' : 'voice'))}
                className="flex-row items-center rounded-2xl p-3.5 mb-2.5"
                style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.borderStrong }}
              >
                <View className={`w-10 h-10 rounded-full items-center justify-center mr-3 ${missed ? 'bg-red-500/10' : item.isMeeting ? 'bg-emerald-500/10' : 'bg-purple-soft/40 dark:bg-purple/15'}`}>
                  <Icon color={missed ? '#ef4444' : item.isMeeting ? '#10b981' : '#6c5ce7'} size={18} />
                </View>
                <View className="flex-1">
                  <Text className="text-ink dark:text-[#f4f5fb] font-bold text-sm font-sans" numberOfLines={1}>{item.label}</Text>
                  <Text className={`text-xs mt-0.5 font-sans ${missed ? 'text-red-500' : 'text-ink-soft dark:text-[#9a9bb6]'}`}>
                    {missed ? 'Missed' : isVideo ? 'Video' : 'Voice'}{item.isMeeting ? ' · Meeting' : ''}{durStr ? ` · ${durStr}` : ''}{whenStr ? ` · ${whenStr}` : ''}
                  </Text>
                </View>
                {item.isMeeting ? (
                  <TouchableOpacity onPress={() => openMeetingDetail(log)} className="p-2">
                    <FileText color="#10b981" size={16} />
                  </TouchableOpacity>
                ) : (
                  <>
                    <TouchableOpacity onPress={() => startOutgoingCall({ name: item.label, avatar: null }, isVideo ? 'video' : 'voice')} className="p-2">
                      <Icon color="#6c5ce7" size={16} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => handleDeleteLog(item.id)} className="p-2">
                      <X color="#9a9aab" size={16} />
                    </TouchableOpacity>
                  </>
                )}
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>

      {/* Meeting detail (Summary | Action Items | Transcript) */}
      <MeetingDetailModal
        meeting={selectedMeeting}
        loading={meetingDetailLoading}
        onClose={() => setSelectedMeeting(null)}
      />
    </View>
  );
}

// ─────────────────────────────────────────────
// Main People Screen
// ─────────────────────────────────────────────
const TABS = ['Contacts', 'Workroom', 'History'] as const;
type TabType = (typeof TABS)[number];

export default function PeopleScreen() {
  const { colors, isDark } = useTheme();
  const [activeTab, setActiveTab] = useState<TabType>('Contacts');
  const [isFabMenuOpen, setIsFabMenuOpen] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [attachToOrg, setAttachToOrg] = useState(true);
  const [myOrg, setMyOrg] = useState<{ id?: string; name?: string }>({});

  // Live Rooms — poll same as _layout.tsx but store full room objects for display
  const [liveRooms, setLiveRooms] = useState<any[]>([]);
  const liveDotPulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const res: any = await fetchActiveMeetings();
        if (!cancelled) setLiveRooms(res?.rooms || []);
      } catch { /* best-effort */ }
    };
    refresh();
    const intervalId = setInterval(refresh, 30_000);
    const socket = getSocket();
    socket?.on('meeting_room_update', refresh);
    socket?.on('meeting_ended', refresh);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
      socket?.off('meeting_room_update', refresh);
      socket?.off('meeting_ended', refresh);
    };
  }, []);
  useEffect(() => {
    if (liveRooms.length > 0) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(liveDotPulse, { toValue: 1, duration: 800, useNativeDriver: true }),
          Animated.timing(liveDotPulse, { toValue: 0, duration: 800, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
    liveDotPulse.setValue(1);
  }, [liveRooms.length, liveDotPulse]);

  useEffect(() => {
    authStorage.getUser().then((user: any) => {
      if (user) setMyOrg({ id: user.organizationId ? String(user.organizationId) : undefined, name: user.organization || undefined });
    });
  }, []);

  // Lifted scanner states
  const [permission, requestPermission] = useCameraPermissions();
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [scanFallbackInput, setScanFallbackInput] = useState('');

  useEffect(() => {
    if (isScannerOpen && !permission?.granted) {
      requestPermission();
    }
  }, [isScannerOpen]);

  const handleBarcodeScanned = async ({ data }: { data: string }) => {
    if (scanned) return;
    setScanned(true);
    try {
      await addContact(data);
      Alert.alert("Success", `Contact "${data}" added successfully!`);
      setIsScannerOpen(false);
      await chatCache.syncContactsWithBackend();
      await chatCache.syncChatsWithBackend();
    } catch (err: any) {
      Alert.alert("Scan Failed", err.message || "Failed to add contact from QR code.");
    } finally {
      setScanned(false);
    }
  };

  const handleStartCall = (user: any, type: 'voice' | 'video') => {
    const targetId = user?.otherUserId || user?.id || user?._id;
    if (!targetId) return;
    startOutgoingCall({
      id: targetId,
      otherUserId: targetId,
      name: user?.name || user?.full_name || user?.username,
      avatar: user?.avatar,
      chatId: user?.chatId,
    }, type);
  };

  const navigation = useNavigation();
  const [isFocused, setIsFocused] = useState(navigation.isFocused());

  useEffect(() => {
    const unsubscribeFocus = navigation.addListener('focus', () => {
      setIsFocused(true);
    });
    const unsubscribeBlur = navigation.addListener('blur', () => {
      setIsFocused(false);
    });
    setIsFocused(navigation.isFocused());

    return () => {
      unsubscribeFocus();
      unsubscribeBlur();
    };
  }, [navigation]);

  useEffect(() => {
    if (!isFocused) {
      setIsFabMenuOpen(false);
      return;
    }

    const unsubscribePlus = subscribeToPlusButton(() => {
      setIsFabMenuOpen(prev => !prev);
    });

    return () => {
      unsubscribePlus();
    };
  }, [isFocused]);

  return (
    <SafeAreaView className="flex-1" edges={['top']} style={{ backgroundColor: colors.bg }}>
      {/* Header */}
      <View className="flex-row items-center justify-between px-6 pt-5 pb-2">
        <View>
          <Svg height="36" width="120">
            <Defs>
              <LinearGradient id="peopleGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <Stop offset="0%" stopColor="#6c5ce7" />
                <Stop offset="100%" stopColor="rgba(108,92,231,0.6)" />
              </LinearGradient>
            </Defs>
            <SvgText
              fill="url(#peopleGrad)"
              fontSize="26"
              fontFamily="SpaceGrotesk_700Bold"
              x="0"
              y="26"
              letterSpacing="-0.5"
            >
              People
            </SvgText>
          </Svg>
          <Text className="text-xs text-ink-soft dark:text-[#9a9bb6] mt-0.5 font-sans">Contacts &amp; your organization</Text>
        </View>
      </View>

      {/* Live — persistent card (divider on top) showing calls happening RIGHT
          NOW, always rendered above contacts/org members like the web's Live
          Rooms strip. Empty state when nothing is live. */}
      <View style={{ paddingHorizontal: 20, paddingBottom: 10 }}>
        {/* Divider line on top of the Live card */}
        <View style={{ height: 1, backgroundColor: colors.border, marginBottom: 12 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 6 }}>
          <Animated.View style={{
            width: 7, height: 7, borderRadius: 4,
            backgroundColor: liveRooms.length > 0 ? '#10b981' : colors.textSoft,
            opacity: liveRooms.length > 0
              ? liveDotPulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] })
              : 0.5,
            transform: [{ scale: liveRooms.length > 0 ? liveDotPulse.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.15] }) : 1 }],
          }} />
          <Text style={{ fontSize: 11, fontFamily: 'Poppins_700Bold', color: liveRooms.length > 0 ? '#10b981' : colors.textSoft, textTransform: 'uppercase', letterSpacing: 0.6 }}>
            Live
          </Text>
          {liveRooms.length > 0 && (
            <Text style={{ fontSize: 10, fontFamily: 'Poppins_600SemiBold', color: colors.textSoft }}>
              · {liveRooms.length} {liveRooms.length === 1 ? 'call' : 'calls'} happening now
            </Text>
          )}
        </View>
        {liveRooms.length === 0 && (
          <View style={{ backgroundColor: colors.card, borderRadius: 16, paddingVertical: 14, paddingHorizontal: 16, borderWidth: 1, borderColor: colors.border }}>
            <Text style={{ fontSize: 11.5, fontFamily: 'Poppins_400Regular', color: colors.textSoft }}>
              No live calls right now — start one from a chat or a colleague below.
            </Text>
          </View>
        )}
        {liveRooms.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
            {liveRooms.map((room: any) => {
              const host = room.host;
              const hostUsername = host?.username || host?.full_name || 'Someone';
              const roomTitle = room.title || `@${hostUsername}'s room`;
              const allParticipants: any[] = [host, ...(room.attendees || [])].filter(Boolean);
              const visibleChips = allParticipants.slice(0, 4);
              const overflow = allParticipants.length - visibleChips.length;
              const isVideo = room.type === 'video';
              return (
                <View
                  key={room.id || room.roomId}
                  style={{
                    backgroundColor: colors.card,
                    borderRadius: 18,
                    padding: 12,
                    borderWidth: 1,
                    borderColor: 'rgba(16,185,129,0.18)',
                    minWidth: 200,
                    maxWidth: 240,
                    shadowColor: '#10b981',
                    shadowOpacity: 0.06,
                    shadowRadius: 8,
                    shadowOffset: { width: 0, height: 2 },
                  }}
                >
                  {/* Room title + type icon */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 6 }}>
                    <View style={{ width: 26, height: 26, borderRadius: 8, backgroundColor: 'rgba(16,185,129,0.12)', alignItems: 'center', justifyContent: 'center' }}>
                      {isVideo ? <Video color="#10b981" size={13} /> : <Phone color="#10b981" size={13} />}
                    </View>
                    <Text style={{ flex: 1, fontSize: 12, fontFamily: 'Poppins_600SemiBold', color: colors.text }} numberOfLines={1}>
                      {roomTitle}
                    </Text>
                  </View>

                  {/* Host identity — who started this room */}
                  <Text style={{ fontSize: 10, fontFamily: 'Poppins_500Medium', color: colors.textSoft, marginBottom: 8 }} numberOfLines={1}>
                    Hosted by {host?.full_name || host?.username || 'Someone'}
                  </Text>

                  {/* Stacked participant avatars + overflow badge (matches web live-room card) */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      {visibleChips.map((p: any, i: number) => (
                        <View key={i} style={{ marginLeft: i === 0 ? 0 : -8, borderRadius: 13, borderWidth: 1.5, borderColor: colors.card }}>
                          <SharedAvatar
                            avatar={p?.avatar}
                            name={p?.full_name || p?.username || 'User'}
                            userId={p?._id || p?.id}
                            size={24}
                          />
                        </View>
                      ))}
                      {overflow > 0 && (
                        <View style={{ marginLeft: -8, width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: colors.card, backgroundColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(108,92,231,0.12)', alignItems: 'center', justifyContent: 'center' }}>
                          <Text style={{ fontSize: 9, fontFamily: 'Poppins_700Bold', color: colors.textSoft }}>+{overflow}</Text>
                        </View>
                      )}
                    </View>
                    <Text style={{ fontSize: 10, fontFamily: 'Poppins_500Medium', color: colors.textSoft, marginLeft: 8 }}>
                      {allParticipants.length} in call
                    </Text>
                  </View>

                  {/* Join button — host/attendee re-enters directly; others knock. */}
                  <TouchableOpacity
                    onPress={async () => {
                      const roomId = room.roomId || room.id;
                      const type = isVideo ? 'video' : 'voice';
                      const me = await authStorage.getUser();
                      const myId = String(me?._id || me?.id || '');
                      const hostId = String(host?._id || host?.id || room?.host || '');
                      const attendeeIds = (room?.attendees || []).map((a: any) => String(a?._id || a?.id || a));
                      if (myId && (myId === hostId || attendeeIds.includes(myId))) {
                        joinRoomByLink({ roomId, type });
                      } else {
                        knockToJoinRoom({ roomId, hostId: hostId || undefined, type });
                      }
                    }}
                    style={{ backgroundColor: '#10b981', borderRadius: 12, paddingVertical: 7, alignItems: 'center' }}
                    activeOpacity={0.8}
                  >
                    <Text style={{ fontSize: 12, fontFamily: 'Poppins_700Bold', color: '#ffffff' }}>Join</Text>
                  </TouchableOpacity>
                </View>
              );
            })}
          </ScrollView>
        )}
      </View>

      {/* Tab Switcher */}
      <View className="flex-row px-6 pb-1 border-b border-black/5 dark:border-white/10">
        {TABS.map((tab) => {
          const isActive = activeTab === tab;
          return (
            <TouchableOpacity
              key={tab}
              onPress={() => setActiveTab(tab)}
              className={`mr-6 pb-3 pt-1 border-b-2 ${
                isActive ? 'border-purple' : 'border-transparent'
              }`}
            >
              <Text
                className={`text-sm font-bold font-sans ${
                  isActive ? 'text-purple' : 'text-ink-soft dark:text-[#9a9bb6]'
                }`}
              >
                {tab}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Tab Content */}
      <View className="flex-1 pt-3 bg-purple-soft/5">
        {activeTab === 'Contacts' ? (
          <ContactsTab
            showAddModal={showAddModal}
            setShowAddModal={setShowAddModal}
            onStartCall={handleStartCall}
            onOpenScanner={() => setIsScannerOpen(true)}
          />
        ) : activeTab === 'Workroom' ? (
          <WorkroomTab
            onStartCall={handleStartCall}
            onOpenScanner={() => setIsScannerOpen(true)}
          />
        ) : (
          <HistoryTab onStartCall={handleStartCall} />
        )}
      </View>

      {/* ── Tap Outside FAB Menu Dismiss Overlay ── */}
      {isFabMenuOpen && (
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setIsFabMenuOpen(false)}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 99,
            backgroundColor: 'transparent',
          }}
        />
      )}

      {/* ── FAB Side Popover Menu ── */}
      {isFabMenuOpen && (
        <View style={{
          position: "absolute",
          bottom: 96,
          right: 16,
          width: 175,
          backgroundColor: colors.card,
          borderRadius: 18,
          paddingVertical: 6,
          shadowColor: "#6c5ce7",
          shadowOpacity: 0.12,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 4 },
          elevation: 10,
          borderWidth: 1,
          borderColor: colors.border,
          zIndex: 100,
        }}>
          <TouchableOpacity
            style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 14 }}
            onPress={() => {
              setIsFabMenuOpen(false);
              setShowAddModal(true);
            }}
          >
            <UserPlus size={16} color="#6c5ce7" style={{ marginRight: 10 }} />
            <Text style={{ fontSize: 13, color: colors.text, fontFamily: "Poppins_500Medium" }}>Add Contact</Text>
          </TouchableOpacity>
          <View style={{ height: 1, backgroundColor: colors.border }} />
          <TouchableOpacity
            style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 14 }}
            onPress={() => {
              setIsFabMenuOpen(false);
              setShowCreateGroupModal(true);
            }}
          >
            <Users size={16} color="#6c5ce7" style={{ marginRight: 10 }} />
            <Text style={{ fontSize: 13, color: colors.text, fontFamily: "Poppins_500Medium" }}>Create Group</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Create Group Chat Modal ── */}
      <Modal visible={showCreateGroupModal} transparent animationType="slide">
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setShowCreateGroupModal(false)}
          style={{ flex: 1, backgroundColor: "rgba(31,32,48,0.4)", justifyContent: "center", alignItems: "center", padding: 20 }}
        >
          <TouchableOpacity activeOpacity={1} style={{ width: "100%", maxWidth: 320, backgroundColor: colors.bg, borderRadius: 24, padding: 20, shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 8 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <Text style={{ fontSize: 17, fontFamily: "SpaceGrotesk_700Bold", color: colors.text }}>Create Group Chat</Text>
              <TouchableOpacity onPress={() => setShowCreateGroupModal(false)}>
                <X size={20} color="#6c5ce7" />
              </TouchableOpacity>
            </View>

            <Text style={{ fontSize: 11, fontFamily: "Poppins_700Bold", color: colors.textSoft, textTransform: "uppercase", marginBottom: 6, letterSpacing: 0.5 }}>Group Name</Text>
            <TextInput
              style={{ width: "100%", backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, fontFamily: "Poppins_400Regular", color: colors.text, marginBottom: 16 }}
              placeholder="e.g. Design Sync"
              value={newGroupName}
              onChangeText={setNewGroupName}
              placeholderTextColor={colors.textSoft}
            />

            {!!(myOrg.id || myOrg.name) && (
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 16 }}>
                <View style={{ flex: 1, paddingRight: 10 }}>
                  <Text style={{ fontSize: 13, fontFamily: "Poppins_700Bold", color: colors.text }}>Add to {myOrg.name || "your organization"}</Text>
                  <Text style={{ fontSize: 11, fontFamily: "Poppins_400Regular", color: colors.textSoft, marginTop: 2 }}>Your team's AI learns from this group.</Text>
                </View>
                <Switch
                  value={attachToOrg}
                  onValueChange={setAttachToOrg}
                  trackColor={{ false: "#c7c8d6", true: "#6c5ce7" }}
                  thumbColor="#ffffff"
                />
              </View>
            )}

            <TouchableOpacity
              style={{ backgroundColor: "#6c5ce7", borderRadius: 14, paddingVertical: 12, alignItems: "center", marginTop: 4 }}
              onPress={async () => {
                const name = newGroupName.trim();
                if (!name) return;
                try {
                  await createGroupChat(name, [], !!(myOrg.id || myOrg.name) && attachToOrg);
                  setNewGroupName("");
                  setShowCreateGroupModal(false);
                  await chatCache.syncChatsWithBackend();
                } catch (err: any) {
                  Alert.alert("Error", err.message || "Failed to create group.");
                }
              }}
            >
              <Text style={{ color: "#ffffff", fontSize: 13, fontFamily: "Poppins_700Bold" }}>Create Group</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* QR Code Scanner Modal (Lifted) */}
      <Modal visible={isScannerOpen} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: 'rgba(31,32,48,0.85)', justifyContent: 'center', alignItems: 'center' }}>
          <View style={{ width: '90%', maxWidth: 360, backgroundColor: colors.bg, borderRadius: 28, padding: 24, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 20, elevation: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <View>
                <Text style={{ fontSize: 18, fontFamily: 'SpaceGrotesk_700Bold', color: colors.text }}>Scan QR Code</Text>
                <Text style={{ fontSize: 12, fontFamily: 'Poppins_400Regular', color: colors.textSoft, marginTop: 2 }}>Scan coworker's profile QR code</Text>
              </View>
              <TouchableOpacity onPress={() => setIsScannerOpen(false)} style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' }}>
                <X color={colors.text} size={16} />
              </TouchableOpacity>
            </View>

            {/* Camera Frame */}
            <View style={{ width: '100%', height: 260, borderRadius: 20, overflow: 'hidden', backgroundColor: colors.surface, position: 'relative', justifyContent: 'center', alignItems: 'center', marginBottom: 20 }}>
              {permission?.granted ? (
                <CameraView
                  style={{ width: '100%', height: '100%' }}
                  facing="back"
                  onBarcodeScanned={handleBarcodeScanned}
                />
              ) : (
                <View style={{ padding: 20, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, fontFamily: 'Poppins_500Medium', color: colors.textSoft, textAlign: 'center', marginBottom: 10 }}>
                    Camera permission required to scan QR codes.
                  </Text>
                  <TouchableOpacity onPress={() => requestPermission()} style={{ backgroundColor: '#6c5ce7', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8 }}>
                    <Text style={{ color: '#ffffff', fontSize: 12, fontFamily: 'Poppins_700Bold' }}>Grant Permission</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>

            {/* Sandbox Fallback for simulator */}
            <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 16 }}>
              <Text style={{ fontSize: 11.5, fontFamily: 'Poppins_600SemiBold', color: colors.textSoft, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>
                Simulator Fallback (Enter Bubble ID)
              </Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TextInput
                  value={scanFallbackInput}
                  onChangeText={setScanFallbackInput}
                  placeholder="e.g. bubble-X89F2"
                  placeholderTextColor={colors.textSoft}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{ flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, fontSize: 13, fontFamily: 'Poppins_400Regular', color: colors.text }}
                />
                <TouchableOpacity
                  onPress={async () => {
                    const tag = scanFallbackInput.trim();
                    if (!tag) return;
                    try {
                      await addContact(tag);
                      Alert.alert("Success", `Contact added successfully!`);
                      setIsScannerOpen(false);
                      setScanFallbackInput('');
                      await chatCache.syncContactsWithBackend();
                      await chatCache.syncChatsWithBackend();
                    } catch (err: any) {
                      Alert.alert("Error", err.message || "Failed to add contact.");
                    }
                  }}
                  style={{ backgroundColor: '#6c5ce7', borderRadius: 12, paddingHorizontal: 14, justifyContent: 'center' }}
                >
                  <Text style={{ color: '#ffffff', fontSize: 12, fontFamily: 'Poppins_700Bold' }}>Submit</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}



// import React, { useState, useEffect, useRef } from 'react';
// import {
//   View,
//   Text,
//   TextInput,
//   TouchableOpacity,
//   ScrollView,
//   Modal,
//   Alert,
// } from 'react-native';
// import { SafeAreaView } from 'react-native-safe-area-context';
// import {
//   Search,
//   UserPlus,
//   Plus,
//   Phone,
//   Video,
//   MessageSquare,
//   Users,
//   Briefcase,
//   X,
//   Check,
//   PhoneOff,
//   MicOff,
//   Volume2,
//   Scan,
// } from 'lucide-react-native';
// import { Link, useNavigation } from 'expo-router';
// import { Image } from 'expo-image';
// import {
//   Contact,
//   Chat,
//   subscribeToPlusButton,
// } from '../../lib/mockData';
// import { chatCache } from '../../lib/chatCache';
// import { addContact, createGroupChat, searchUsers, getSecureMediaUrl } from '../../lib/api';
// import { startOutgoingCall } from '../../lib/callManager';
// import { authStorage } from '../../lib/authStorage';
// import { getSocket } from '../../lib/socket';
// import Svg, { Text as SvgText, Defs, LinearGradient, Stop } from 'react-native-svg';
// import { CameraView, useCameraPermissions } from 'expo-camera';
// import { Avatar as SharedAvatar } from '../../components/Avatar';

// // ─────────────────────────────────────────────
// // Helper
// // ─────────────────────────────────────────────
// function getInitials(name: string) {
//   return name
//     .split(' ')
//     .map((n) => n[0])
//     .join('')
//     .slice(0, 2)
//     .toUpperCase();
// }

// function getGroupInitials(name: string) {
//   const clean = name.trim().replace(/\s+/g, ' ');
//   const parts = clean.split(' ');
//   if (parts.length >= 2) {
//     return (parts[0][0] + parts[1][0]).toUpperCase();
//   }
//   return clean.slice(0, 2).toUpperCase();
// }

// // ─────────────────────────────────────────────
// // Avatar Component
// // ─────────────────────────────────────────────
// // ─────────────────────────────────────────────
// // Avatar Component
// // ─────────────────────────────────────────────
// function Avatar({
//   name,
//   avatar,
//   size = 52,
//   isOnline,
//   isGroup = false,
//   organization,
// }: {
//   name: string;
//   avatar?: string | null;
//   size?: number;
//   isOnline?: boolean;
//   isGroup?: boolean;
//   organization?: string;
// }) {
//   const isFallbackBlack = isGroup || !!organization;
//   return (
//     <View style={{ width: size, height: size }} className="relative shrink-0">
//       <SharedAvatar
//         url={avatar}
//         name={organization || name}
//         size={size}
//         isGroup={isFallbackBlack}
//         imageStyle={{ borderRadius: size * 0.38 }}
//         style={{ borderRadius: size * 0.38 }}
//       />
//       {isOnline && !isGroup && (
//         <View
//           className="absolute -bottom-0.5 -right-0.5 bg-emerald-500 rounded-full border-2 border-white shadow-xs"
//           style={{ width: size * 0.27, height: size * 0.27 }}
//         />
//       )}
//     </View>
//   );
// }

// // ─────────────────────────────────────────────
// // Contacts Sub-Tab
// // ─────────────────────────────────────────────
// function ContactsTab({
//   showAddModal,
//   setShowAddModal,
//   onStartCall,
//   onOpenScanner,
// }: {
//   showAddModal: boolean;
//   setShowAddModal: (v: boolean) => void;
//   onStartCall: (user: any, type: 'voice' | 'video') => void;
//   onOpenScanner: () => void;
// }) {
//   const [search, setSearch] = useState('');
//   const [addIdentifier, setAddIdentifier] = useState('');
//   const [contacts, setContacts] = useState<Contact[]>([]);
//   const [chats, setChats] = useState<any[]>([]);
//   const [typingChats, setTypingChats] = useState<Record<string, { fromUserId: string; fromUsername?: string; fromName?: string } | false>>({});

//   const currentUserIdRef = useRef<string | null>(null);

//   useEffect(() => {
//     authStorage.getUser().then((user) => {
//       if (user) {
//         currentUserIdRef.current = String(user.id || user._id);
//       }
//     });
//   }, []);

//   const loadCache = async () => {
//     const cached = await chatCache.getCachedContacts();
//     setContacts(cached);
//     const cachedChats = await chatCache.getCachedChats();
//     setChats(cachedChats);
//   };

//   const syncContacts = async () => {
//     try {
//       const fresh = await chatCache.syncContactsWithBackend();
//       setContacts(fresh);
//       const freshChats = await chatCache.syncChatsWithBackend();
//       setChats(freshChats);
//     } catch (err) {
//       console.warn("Silent sync failed in ContactsTab:", err);
//     }
//   };

//   useEffect(() => {
//     loadCache();
//     syncContacts();
//   }, []);

//   useEffect(() => {
//     const interval = setInterval(syncContacts, 5000);
//     return () => clearInterval(interval);
//   }, []);

//   useEffect(() => {
//     const socket = getSocket();
//     if (!socket) return;

//     const handleTypingStart = (data: { chatId: string, fromUserId: string, fromUsername?: string, fromName?: string }) => {
//       if (currentUserIdRef.current && String(data.fromUserId) === String(currentUserIdRef.current)) return;
//       if (data.chatId) setTypingChats(prev => ({ ...prev, [data.chatId]: { fromUserId: data.fromUserId, fromUsername: data.fromUsername, fromName: data.fromName } }));
//     };
//     const handleTypingStop = (data: { chatId: string }) => {
//       if (data.chatId) setTypingChats(prev => ({ ...prev, [data.chatId]: false }));
//     };

//     socket.on('typing_start', handleTypingStart);
//     socket.on('typing_stop', handleTypingStop);

//     return () => {
//       socket.off('typing_start', handleTypingStart);
//       socket.off('typing_stop', handleTypingStop);
//     };
//   }, []);

//   const filtered = contacts.filter((c) =>
//     (c.name + c.username + c.org_role).toLowerCase().includes(search.toLowerCase())
//   );

//   const handleAdd = async () => {
//     const tag = addIdentifier.trim();
//     if (!tag) return;
//     try {
//       await addContact(tag);
//       setAddIdentifier('');
//       setShowAddModal(false);
//       await syncContacts();
//     } catch (err: any) {
//       Alert.alert("Error", err.message || "Failed to add contact.");
//     }
//   };

//   return (
//     <View className="flex-1">
//       {/* Search + Action Row */}
//       <View className="px-5 pb-3 pt-2 flex-row items-center gap-3">
//         <View className="flex-1 flex-row items-center bg-purple/10 rounded-3xl border border-purple/5 px-4 py-2.5 shadow-sm shadow-purple/5">
//           <Search color="#6c5ce7" size={16} />
//           <TextInput
//             placeholder="Search contacts..."
//             value={search}
//             onChangeText={setSearch}
//             placeholderTextColor="rgba(108,92,231,0.4)"
//             className="flex-1 text-[14px] text-ink dark:text-[#f4f5fb] font-medium font-sans ml-2"
//           />
//           {search.length > 0 && (
//             <TouchableOpacity onPress={() => setSearch('')}>
//               <X color="#9a9aab" size={14} />
//             </TouchableOpacity>
//           )}
//         </View>
//         <TouchableOpacity
//           onPress={onOpenScanner}
//           style={{ width: 40, height: 40, backgroundColor: 'rgba(108,92,231,0.1)', borderRadius: 14, alignItems: 'center', justifyContent: 'center' }}
//         >
//           <Scan color="#6c5ce7" size={18} />
//         </TouchableOpacity>
//         <TouchableOpacity
//           onPress={() => setShowAddModal(true)}
//           className="flex-row items-center bg-purple rounded-2xl px-4 py-2.5 shadow-xs"
//         >
//           <UserPlus color="#fff" size={15} />
//           <Text className="text-white text-xs font-bold font-sans ml-1.5">Add</Text>
//         </TouchableOpacity>
//       </View>



//       <ScrollView className="flex-1 px-5" showsVerticalScrollIndicator={false}>
//         {/* Section header */}
//         <View className="flex-row items-center mb-3 mt-1">
//           <Text className="text-[10px] font-bold text-ink-soft dark:text-[#9a9bb6] uppercase tracking-widest font-sans">
//             My Contacts
//           </Text>
//           <View className="flex-1 h-[1px] bg-black/5 dark:bg-white/[0.06] ml-3" />
//           <View className="ml-3 bg-purple/10 px-2 py-0.5 rounded-full">
//             <Text className="text-[9px] font-bold text-purple uppercase font-sans">
//               {contacts.length} Total
//             </Text>
//           </View>
//         </View>

//         {filtered.length === 0 ? (
//           <View className="py-16 items-center justify-center border-2 border-dashed border-black/5 dark:border-white/10 rounded-3xl mt-2 bg-white/50 dark:bg-white/[0.04]">
//             <View className="w-16 h-16 rounded-3xl bg-purple-soft/50 items-center justify-center mb-4">
//               <Users color="#6c5ce7" size={28} />
//             </View>
//             <Text className="text-base font-bold text-ink dark:text-[#f4f5fb] font-sans">No contacts found</Text>
//             <Text className="text-xs text-ink-soft dark:text-[#9a9bb6] mt-1 text-center max-w-[220px] leading-relaxed font-sans">
//               {search
//                 ? 'Try a different name or username'
//                 : 'Add contacts to start connecting with people'}
//             </Text>
//             {!search && (
//               <TouchableOpacity
//                 onPress={() => setShowAddModal(true)}
//                 className="mt-5 bg-purple px-5 py-3 rounded-2xl shadow-sm"
//               >
//                 <Text className="text-white text-xs font-bold font-sans">
//                   Add your first contact
//                 </Text>
//               </TouchableOpacity>
//             )}
//           </View>
//         ) : (
//           filtered.map((contact) => {
//             const matchingChat = chats.find(c => String(c.otherUserId) === String(contact.id) || String(c.id) === String(contact.id));
//             const typingInfo = matchingChat && typingChats[matchingChat.id];

//             return (
//               <View
//                 key={contact.id}
//                 className="flex-row items-center bg-white dark:bg-[#1a1b28] border border-black/5 dark:border-white/10 rounded-2xl px-4 py-3.5 mb-2.5 shadow-sm shadow-purple/5"
//               >
//                 <Link href={`/chat/${contact.id}`} asChild>
//                   <TouchableOpacity
//                     activeOpacity={0.75}
//                     className="flex-1 flex-row items-center"
//                   >
//                     <Avatar name={contact.name} avatar={contact.avatar} size={50} isOnline={contact.isOnline} organization={contact.organization} />

//                     {/* Info */}
//                     <View className="flex-1 min-w-0 ml-3">
//                       <Text className="text-[15px] font-bold text-ink dark:text-[#f4f5fb] leading-tight font-sans" numberOfLines={1}>
//                         {contact.name}
//                       </Text>
//                       {typingInfo ? (
//                         <Text className="text-[11px] font-semibold text-purple mt-0.5 font-sans">
//                           {typingInfo.fromUsername ? `@${typingInfo.fromUsername} is typing...` : typingInfo.fromName ? `${typingInfo.fromName} is typing...` : 'typing...'}
//                         </Text>
//                       ) : (
//                         <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] mt-0.5 font-sans" numberOfLines={1}>
//                           @{contact.username}
//                           {contact.org_role ? ` · ${contact.org_role}` : ''}
//                         </Text>
//                       )}
//                     </View>
//                   </TouchableOpacity>
//                 </Link>

//                 {/* Action Buttons */}
//                 <View className="flex-row items-center gap-2 ml-2">
//                   <Link href={`/chat/${contact.id}`} asChild>
//                     <TouchableOpacity className="w-8 h-8 rounded-xl bg-purple-soft/40 dark:bg-purple/15 items-center justify-center">
//                       <MessageSquare color="#6c5ce7" size={14} />
//                     </TouchableOpacity>
//                   </Link>
//                   <TouchableOpacity
//                     onPress={() => onStartCall(contact, 'voice')}
//                     className="w-8 h-8 rounded-xl bg-purple-soft/40 dark:bg-purple/15 items-center justify-center"
//                   >
//                     <Phone color="#6c5ce7" size={14} />
//                   </TouchableOpacity>
//                   <TouchableOpacity
//                     onPress={() => onStartCall(contact, 'video')}
//                     className="w-8 h-8 rounded-xl bg-purple-soft/40 dark:bg-purple/15 items-center justify-center"
//                   >
//                     <Video color="#6c5ce7" size={14} />
//                   </TouchableOpacity>
//                 </View>
//               </View>
//             );
//           })
//         )}
//       </ScrollView>

//       {/* Add Friend Modal */}
//       <Modal visible={showAddModal} transparent animationType="slide">
//         <TouchableOpacity
//           activeOpacity={1}
//           onPress={() => {
//             setShowAddModal(false);
//             setAddIdentifier('');
//           }}
//           className="flex-1 bg-black/60 justify-end"
//         >
//           <TouchableOpacity activeOpacity={1}>
//             <SafeAreaView className="bg-white dark:bg-[#1a1b28] rounded-t-3xl shadow-2xl" edges={['bottom']}>
//               <View className="px-6 pt-6 pb-2">
//                 <View className="flex-row items-start justify-between mb-2">
//                   <View>
//                     <Text className="text-lg font-bold text-ink dark:text-[#f4f5fb] font-display">Add a Contact</Text>
//                     <Text className="text-xs text-ink-soft dark:text-[#9a9bb6] mt-0.5 font-sans">
//                       Enter their unique ID or @username
//                     </Text>
//                   </View>
//                   <TouchableOpacity
//                     onPress={() => {
//                       setShowAddModal(false);
//                       setAddIdentifier('');
//                     }}
//                     className="w-8 h-8 rounded-xl bg-black/5 dark:bg-white/[0.06] items-center justify-center"
//                   >
//                     <X color="#6c5ce7" size={16} />
//                   </TouchableOpacity>
//                 </View>

//                 <View className="bg-purple-soft/30 dark:bg-white/5 rounded-2xl border border-purple/10 px-4 py-3.5 mt-4 mb-4">
//                   <TextInput
//                     value={addIdentifier}
//                     onChangeText={setAddIdentifier}
//                     placeholder="@username · Bubble ID · email"
//                     placeholderTextColor="#9a9aab"
//                     className="text-[15px] text-ink dark:text-[#f4f5fb] font-sans"
//                     autoCapitalize="none"
//                     autoCorrect={false}
//                   />
//                 </View>

//                 <View className="flex-row gap-3 mb-2">
//                   <TouchableOpacity
//                     onPress={() => {
//                       setShowAddModal(false);
//                       setAddIdentifier('');
//                     }}
//                     className="flex-1 border border-black/10 dark:border-white/20 rounded-xl py-3 items-center"
//                   >
//                     <Text className="text-sm font-semibold text-ink-soft dark:text-[#9a9bb6] font-sans">Cancel</Text>
//                   </TouchableOpacity>
//                   <TouchableOpacity
//                     onPress={handleAdd}
//                     className="flex-1 bg-purple rounded-xl py-3 items-center flex-row justify-center shadow-sm"
//                   >
//                     <Text className="text-white text-sm font-bold font-sans">Add Contact</Text>
//                   </TouchableOpacity>
//                 </View>
//               </View>
//             </SafeAreaView>
//           </TouchableOpacity>
//         </TouchableOpacity>
//       </Modal>
//     </View>
//   );
// }

// // ─────────────────────────────────────────────
// // Workroom Sub-Tab
// // ─────────────────────────────────────────────
// function WorkroomTab({
//   onStartCall,
//   onOpenScanner,
// }: {
//   onStartCall: (user: any, type: 'voice' | 'video') => void;
//   onOpenScanner: () => void;
// }) {
//   const [search, setSearch] = useState('');
//   const [chats, setChats] = useState<any[]>([]);
//   const [contacts, setContacts] = useState<any[]>([]);

//   const loadCacheAndSync = async () => {
//     const cachedChats = await chatCache.getCachedChats();
//     setChats(cachedChats);

//     try {
//       const response = await searchUsers('');
//       const rawList = response?.users || [];
//       const coworkersList = rawList.map((u: any) => ({
//         id: String(u.id || u._id),
//         name: u.full_name || u.name || u.username || "Unknown",
//         avatar: u.avatar || null,
//         isOnline: !!u.isOnline,
//         username: u.username || "",
//         org_role: u.org_role || "",
//         organization: u.organization || "",
//       }));
//       setContacts(coworkersList);
//     } catch (err) {
//       console.warn("Workroom coworker fetch failed, fallback to cache:", err);
//       const cachedContacts = await chatCache.getCachedContacts();
//       setContacts(cachedContacts);
//     }
//   };

//   useEffect(() => {
//     loadCacheAndSync();
//     const interval = setInterval(loadCacheAndSync, 5000);
//     return () => clearInterval(interval);
//   }, []);

//   // Filter and display group chats and regular workspace members
//   const filteredGroups = chats.filter(
//     (c) => c.isGroupChat && c.name.toLowerCase().includes(search.toLowerCase())
//   );

//   const filteredMembers = contacts.filter((m) =>
//     (m.name + (m.org_role || '')).toLowerCase().includes(search.toLowerCase())
//   );

//   return (
//     <View className="flex-1">
//       {/* Search Bar */}
//       <View className="px-5 pb-3 pt-2 flex-row items-center gap-3">
//         <View className="flex-1 flex-row items-center bg-purple/10 rounded-3xl border border-purple/5 px-4 py-2.5 shadow-sm shadow-purple/5">
//           <Search color="#6c5ce7" size={16} />
//           <TextInput
//             placeholder="Search groups or members..."
//             value={search}
//             onChangeText={setSearch}
//             placeholderTextColor="rgba(108,92,231,0.4)"
//             className="flex-1 text-[14px] text-ink dark:text-[#f4f5fb] font-medium font-sans ml-2"
//           />
//           {search.length > 0 && (
//             <TouchableOpacity onPress={() => setSearch('')}>
//               <X color="#9a9aab" size={14} />
//             </TouchableOpacity>
//           )}
//         </View>
//         <TouchableOpacity
//           onPress={onOpenScanner}
//           style={{ width: 40, height: 40, backgroundColor: 'rgba(108,92,231,0.1)', borderRadius: 14, alignItems: 'center', justifyContent: 'center' }}
//         >
//           <Scan color="#6c5ce7" size={18} />
//         </TouchableOpacity>
//       </View>

//       <ScrollView className="flex-1 px-5" showsVerticalScrollIndicator={false}>
//         {/* Active Collaborative Groups */}
//         {filteredGroups.length > 0 && (
//           <View className="mb-4">
//             <View className="flex-row items-center mb-3">
//               <Text className="text-[10px] font-bold text-ink-soft dark:text-[#9a9bb6] uppercase tracking-widest font-sans">
//                 Group Workspaces
//               </Text>
//               <View className="flex-1 h-[1px] bg-black/5 dark:bg-white/[0.06] ml-3" />
//             </View>

//             {filteredGroups.map((group) => (
//               <Link href={`/chat/${group.id}`} key={group.id} asChild>
//                 <TouchableOpacity
//                   activeOpacity={0.75}
//                   className="flex-row items-center bg-white dark:bg-[#1a1b28] border border-black/5 dark:border-white/10 rounded-[22px] px-4 py-4 mb-2.5 shadow-sm shadow-purple/5"
//                 >
//                   <Avatar name={group.name} avatar={group.avatar} size={50} isOnline={false} isGroup={true} />
//                   <View className="flex-1 min-w-0 ml-3">
//                     <Text className="text-[15px] font-bold text-ink dark:text-[#f4f5fb] leading-tight font-sans" numberOfLines={1}>
//                       {group.name}
//                     </Text>
//                     <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] mt-0.5 font-sans">
//                       Group Chat · {group.messages.length} messages
//                     </Text>
//                   </View>
//                   <View className="h-8 flex-row items-center bg-purple px-3.5 rounded-xl gap-1 shadow-xs">
//                     <MessageSquare color="#fff" size={13} />
//                     <Text className="text-white text-[11px] font-bold font-sans">Open</Text>
//                   </View>
//                 </TouchableOpacity>
//               </Link>
//             ))}
//           </View>
//         )}

//         {/* Organization Members */}
//         {filteredMembers.length > 0 && (
//           <View className="mb-8">
//             <View className="flex-row items-center mb-3">
//               <Text className="text-[10px] font-bold text-ink-soft dark:text-[#9a9bb6] uppercase tracking-widest font-sans">
//                 Org Members
//               </Text>
//               <View className="flex-1 h-[1px] bg-black/5 dark:bg-white/[0.06] ml-3" />
//             </View>

//             {filteredMembers.map((member) => (
//               <View
//                 key={member.id}
//                 className="flex-row items-center bg-white dark:bg-[#1a1b28] border border-black/5 dark:border-white/10 rounded-[22px] px-4 py-3.5 mb-2.5 shadow-sm shadow-purple/5"
//               >
//                 <Link href={`/chat/${member.id}`} asChild>
//                   <TouchableOpacity
//                     activeOpacity={0.75}
//                     className="flex-1 flex-row items-center"
//                   >
//                     <Avatar name={member.name} avatar={member.avatar} size={50} isOnline={member.isOnline} userId={member.id} organization={member.organization} />
//                     <View className="flex-1 min-w-0 ml-3">
//                       <View className="flex-row items-center gap-1.5 flex-wrap">
//                         <Text className="text-[15px] font-bold text-ink dark:text-[#f4f5fb] leading-tight font-sans" numberOfLines={1}>
//                           {member.name}
//                         </Text>
//                         {member.org_role && (
//                           <View className="bg-purple/10 px-1.5 py-0.5 rounded-full">
//                             <Text className="text-[9px] font-bold text-purple uppercase tracking-wider font-sans">
//                               {member.org_role}
//                             </Text>
//                           </View>
//                         )}
//                       </View>
//                       <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] mt-0.5 font-sans">
//                         @{member.username}
//                       </Text>
//                     </View>
//                   </TouchableOpacity>
//                 </Link>

//                 {/* Action Buttons */}
//                 <View className="flex-row items-center gap-2 ml-2">
//                   <Link href={`/chat/${member.id}`} asChild>
//                     <TouchableOpacity className="w-8 h-8 rounded-xl bg-purple-soft/40 dark:bg-purple/15 items-center justify-center">
//                       <MessageSquare color="#6c5ce7" size={14} />
//                     </TouchableOpacity>
//                   </Link>
//                   <TouchableOpacity
//                     onPress={() => onStartCall(member, 'voice')}
//                     className="w-8 h-8 rounded-xl bg-purple-soft/40 dark:bg-purple/15 items-center justify-center"
//                   >
//                     <Phone color="#6c5ce7" size={14} />
//                   </TouchableOpacity>
//                   <TouchableOpacity
//                     onPress={() => onStartCall(member, 'video')}
//                     className="w-8 h-8 rounded-xl bg-purple-soft/40 dark:bg-purple/15 items-center justify-center"
//                   >
//                     <Video color="#6c5ce7" size={14} />
//                   </TouchableOpacity>
//                 </View>
//               </View>
//             ))}
//           </View>
//         )}
//       </ScrollView>
//     </View>
//   );
// }

// // ─────────────────────────────────────────────
// // Main People Screen
// // ─────────────────────────────────────────────
// const TABS = ['Contacts', 'Workroom'] as const;
// type TabType = (typeof TABS)[number];

// export default function PeopleScreen() {
//   const [activeTab, setActiveTab] = useState<TabType>('Contacts');
//   const [isFabMenuOpen, setIsFabMenuOpen] = useState(false);
//   const [showAddModal, setShowAddModal] = useState(false);
//   const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
//   const [newGroupName, setNewGroupName] = useState('');

//   // Lifted scanner states
//   const [permission, requestPermission] = useCameraPermissions();
//   const [isScannerOpen, setIsScannerOpen] = useState(false);
//   const [scanned, setScanned] = useState(false);
//   const [scanFallbackInput, setScanFallbackInput] = useState('');

//   useEffect(() => {
//     if (isScannerOpen && !permission?.granted) {
//       requestPermission();
//     }
//   }, [isScannerOpen]);

//   const handleBarcodeScanned = async ({ data }: { data: string }) => {
//     if (scanned) return;
//     setScanned(true);
//     try {
//       await addContact(data);
//       Alert.alert("Success", `Contact "${data}" added successfully!`);
//       setIsScannerOpen(false);
//       await chatCache.syncContactsWithBackend();
//       await chatCache.syncChatsWithBackend();
//     } catch (err: any) {
//       Alert.alert("Scan Failed", err.message || "Failed to add contact from QR code.");
//     } finally {
//       setScanned(false);
//     }
//   };

//   const handleStartCall = (user: any, type: 'voice' | 'video') => {
//     startOutgoingCall(user, type);
//   };

//   const navigation = useNavigation();
//   const [isFocused, setIsFocused] = useState(navigation.isFocused());

//   useEffect(() => {
//     const unsubscribeFocus = navigation.addListener('focus', () => {
//       setIsFocused(true);
//     });
//     const unsubscribeBlur = navigation.addListener('blur', () => {
//       setIsFocused(false);
//     });
//     setIsFocused(navigation.isFocused());

//     return () => {
//       unsubscribeFocus();
//       unsubscribeBlur();
//     };
//   }, [navigation]);

//   useEffect(() => {
//     if (!isFocused) {
//       setIsFabMenuOpen(false);
//       return;
//     }

//     const unsubscribePlus = subscribeToPlusButton(() => {
//       setIsFabMenuOpen(prev => !prev);
//     });

//     return () => {
//       unsubscribePlus();
//     };
//   }, [isFocused]);

//   return (
//     <SafeAreaView className="flex-1 bg-white dark:bg-[#1a1b28]" edges={['top']}>
//       {/* Header */}
//       <View className="flex-row items-center justify-between px-6 pt-5 pb-2">
//         <View>
//           <Svg height="36" width="120">
//             <Defs>
//               <LinearGradient id="peopleGrad" x1="0%" y1="0%" x2="100%" y2="0%">
//                 <Stop offset="0%" stopColor="#6c5ce7" />
//                 <Stop offset="100%" stopColor="rgba(108,92,231,0.6)" />
//               </LinearGradient>
//             </Defs>
//             <SvgText
//               fill="url(#peopleGrad)"
//               fontSize="26"
//               fontFamily="SpaceGrotesk_700Bold"
//               x="0"
//               y="26"
//               letterSpacing="-0.5"
//             >
//               People
//             </SvgText>
//           </Svg>
//           <Text className="text-xs text-ink-soft dark:text-[#9a9bb6] mt-0.5 font-sans">Contacts &amp; your organization</Text>
//         </View>
//       </View>

//       {/* Tab Switcher */}
//       <View className="flex-row px-6 pb-1 border-b border-black/5 dark:border-white/10">
//         {TABS.map((tab) => {
//           const isActive = activeTab === tab;
//           return (
//             <TouchableOpacity
//               key={tab}
//               onPress={() => setActiveTab(tab)}
//               className={`mr-6 pb-3 pt-1 border-b-2 ${
//                 isActive ? 'border-purple' : 'border-transparent'
//               }`}
//             >
//               <Text
//                 className={`text-sm font-bold font-sans ${
//                   isActive ? 'text-purple' : 'text-ink-soft dark:text-[#9a9bb6]'
//                 }`}
//               >
//                 {tab}
//               </Text>
//             </TouchableOpacity>
//           );
//         })}
//       </View>

//       {/* Tab Content */}
//       <View className="flex-1 pt-3 bg-purple-soft/5">
//         {activeTab === 'Contacts' ? (
//           <ContactsTab
//             showAddModal={showAddModal}
//             setShowAddModal={setShowAddModal}
//             onStartCall={handleStartCall}
//             onOpenScanner={() => setIsScannerOpen(true)}
//           />
//         ) : (
//           <WorkroomTab
//             onStartCall={handleStartCall}
//             onOpenScanner={() => setIsScannerOpen(true)}
//           />
//         )}
//       </View>

//       {/* ── Tap Outside FAB Menu Dismiss Overlay ── */}
//       {isFabMenuOpen && (
//         <TouchableOpacity
//           activeOpacity={1}
//           onPress={() => setIsFabMenuOpen(false)}
//           style={{
//             position: 'absolute',
//             top: 0,
//             left: 0,
//             right: 0,
//             bottom: 0,
//             zIndex: 99,
//             backgroundColor: 'transparent',
//           }}
//         />
//       )}

//       {/* ── FAB Side Popover Menu ── */}
//       {isFabMenuOpen && (
//         <View style={{
//           position: "absolute",
//           bottom: 96,
//           right: 16,
//           width: 175,
//           backgroundColor: "#ffffff",
//           borderRadius: 18,
//           paddingVertical: 6,
//           shadowColor: "#6c5ce7",
//           shadowOpacity: 0.12,
//           shadowRadius: 10,
//           shadowOffset: { width: 0, height: 4 },
//           elevation: 10,
//           borderWidth: 1,
//           borderColor: "rgba(108,92,231,0.08)",
//           zIndex: 100,
//         }}>
//           <TouchableOpacity
//             style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 14 }}
//             onPress={() => {
//               setIsFabMenuOpen(false);
//               setShowAddModal(true);
//             }}
//           >
//             <UserPlus size={16} color="#6c5ce7" style={{ marginRight: 10 }} />
//             <Text style={{ fontSize: 13, color: "#1f2030", fontFamily: "Poppins_500Medium" }}>Add Contact</Text>
//           </TouchableOpacity>
//           <View style={{ height: 1, backgroundColor: "rgba(0,0,0,0.05)" }} />
//           <TouchableOpacity
//             style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 14 }}
//             onPress={() => {
//               setIsFabMenuOpen(false);
//               setShowCreateGroupModal(true);
//             }}
//           >
//             <Users size={16} color="#6c5ce7" style={{ marginRight: 10 }} />
//             <Text style={{ fontSize: 13, color: "#1f2030", fontFamily: "Poppins_500Medium" }}>Create Group</Text>
//           </TouchableOpacity>
//         </View>
//       )}

//       {/* ── Create Group Chat Modal ── */}
//       <Modal visible={showCreateGroupModal} transparent animationType="slide">
//         <TouchableOpacity
//           activeOpacity={1}
//           onPress={() => setShowCreateGroupModal(false)}
//           style={{ flex: 1, backgroundColor: "rgba(31,32,48,0.4)", justifyContent: "center", alignItems: "center", padding: 20 }}
//         >
//           <TouchableOpacity activeOpacity={1} style={{ width: "100%", maxWidth: 320, backgroundColor: "#ffffff", borderRadius: 24, padding: 20, shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 8 }}>
//             <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
//               <Text style={{ fontSize: 17, fontFamily: "SpaceGrotesk_700Bold", color: "#1f2030" }}>Create Group Chat</Text>
//               <TouchableOpacity onPress={() => setShowCreateGroupModal(false)}>
//                 <X size={20} color="#6c5ce7" />
//               </TouchableOpacity>
//             </View>
            
//             <Text style={{ fontSize: 11, fontFamily: "Poppins_700Bold", color: "#9a9aab", textTransform: "uppercase", marginBottom: 6, letterSpacing: 0.5 }}>Group Name</Text>
//             <TextInput
//               style={{ width: "100%", backgroundColor: "rgba(108,92,231,0.05)", borderWidth: 1, borderColor: "rgba(108,92,231,0.08)", borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, fontFamily: "Poppins_400Regular", color: "#1f2030", marginBottom: 16 }}
//               placeholder="e.g. Design Sync"
//               value={newGroupName}
//               onChangeText={setNewGroupName}
//               placeholderTextColor="#9a9aab"
//             />

//             <TouchableOpacity
//               style={{ backgroundColor: "#6c5ce7", borderRadius: 14, paddingVertical: 12, alignItems: "center", marginTop: 4 }}
//               onPress={async () => {
//                 const name = newGroupName.trim();
//                 if (!name) return;
//                 try {
//                   await createGroupChat(name, []);
//                   setNewGroupName("");
//                   setShowCreateGroupModal(false);
//                   await chatCache.syncChatsWithBackend();
//                 } catch (err: any) {
//                   Alert.alert("Error", err.message || "Failed to create group.");
//                 }
//               }}
//             >
//               <Text style={{ color: "#ffffff", fontSize: 13, fontFamily: "Poppins_700Bold" }}>Create Group</Text>
//             </TouchableOpacity>
//           </TouchableOpacity>
//         </TouchableOpacity>
//       </Modal>

//       {/* QR Code Scanner Modal (Lifted) */}
//       <Modal visible={isScannerOpen} transparent animationType="slide">
//         <View style={{ flex: 1, backgroundColor: 'rgba(31,32,48,0.85)', justifyContent: 'center', alignItems: 'center' }}>
//           <View style={{ width: '90%', maxWidth: 360, backgroundColor: '#ffffff', borderRadius: 28, padding: 24, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 20, elevation: 10 }}>
//             <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
//               <View>
//                 <Text style={{ fontSize: 18, fontFamily: 'SpaceGrotesk_700Bold', color: '#1f2030' }}>Scan QR Code</Text>
//                 <Text style={{ fontSize: 12, fontFamily: 'Poppins_400Regular', color: '#9a9aab', marginTop: 2 }}>Scan coworker's profile QR code</Text>
//               </View>
//               <TouchableOpacity onPress={() => setIsScannerOpen(false)} style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.05)', alignItems: 'center', justifyContent: 'center' }}>
//                 <X color="#1f2030" size={16} />
//               </TouchableOpacity>
//             </View>

//             {/* Camera Frame */}
//             <View style={{ width: '100%', height: 260, borderRadius: 20, overflow: 'hidden', backgroundColor: '#f1f2f6', position: 'relative', justifyContent: 'center', alignItems: 'center', marginBottom: 20 }}>
//               {permission?.granted ? (
//                 <CameraView
//                   style={{ width: '100%', height: '100%' }}
//                   facing="back"
//                   onBarcodeScanned={handleBarcodeScanned}
//                 />
//               ) : (
//                 <View style={{ padding: 20, alignItems: 'center' }}>
//                   <Text style={{ fontSize: 13, fontFamily: 'Poppins_500Medium', color: '#9a9aab', textAlign: 'center', marginBottom: 10 }}>
//                     Camera permission required to scan QR codes.
//                   </Text>
//                   <TouchableOpacity onPress={() => requestPermission()} style={{ backgroundColor: '#6c5ce7', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8 }}>
//                     <Text style={{ color: '#ffffff', fontSize: 12, fontFamily: 'Poppins_700Bold' }}>Grant Permission</Text>
//                   </TouchableOpacity>
//                 </View>
//               )}
//             </View>

//             {/* Sandbox Fallback for simulator */}
//             <View style={{ borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.05)', paddingTop: 16 }}>
//               <Text style={{ fontSize: 11.5, fontFamily: 'Poppins_600SemiBold', color: '#9a9aab', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>
//                 Simulator Fallback (Enter Bubble ID)
//               </Text>
//               <View style={{ flexDirection: 'row', gap: 8 }}>
//                 <TextInput
//                   value={scanFallbackInput}
//                   onChangeText={setScanFallbackInput}
//                   placeholder="e.g. bubble-X89F2"
//                   placeholderTextColor="#9a9aab"
//                   autoCapitalize="none"
//                   autoCorrect={false}
//                   style={{ flex: 1, backgroundColor: 'rgba(108,92,231,0.05)', borderWidth: 1, borderColor: 'rgba(108,92,231,0.08)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, fontSize: 13, fontFamily: 'Poppins_400Regular', color: '#1f2030' }}
//                 />
//                 <TouchableOpacity
//                   onPress={async () => {
//                     const tag = scanFallbackInput.trim();
//                     if (!tag) return;
//                     try {
//                       await addContact(tag);
//                       Alert.alert("Success", `Contact added successfully!`);
//                       setIsScannerOpen(false);
//                       setScanFallbackInput('');
//                       await chatCache.syncContactsWithBackend();
//                       await chatCache.syncChatsWithBackend();
//                     } catch (err: any) {
//                       Alert.alert("Error", err.message || "Failed to add contact.");
//                     }
//                   }}
//                   style={{ backgroundColor: '#6c5ce7', borderRadius: 12, paddingHorizontal: 14, justifyContent: 'center' }}
//                 >
//                   <Text style={{ color: '#ffffff', fontSize: 12, fontFamily: 'Poppins_700Bold' }}>Submit</Text>
//                 </TouchableOpacity>
//               </View>
//             </View>
//           </View>
//         </View>
//       </Modal>
//     </SafeAreaView>
//   );
// }
