import React, { useState, useEffect, useRef } from "react";
import {
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Modal,
  Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Link, useNavigation, useRouter } from "expo-router";
import { Search, Pin, BellOff, Check, CheckCheck, MessageSquarePlus, UserPlus, FolderPlus, X, Trash2, Archive, Ban, Users } from "lucide-react-native";
import { Image } from "expo-image";
import { Avatar } from "../../components/Avatar";
import { 
  Chat, 
  Contact,
  subscribeToPlusButton,
} from "../../lib/mockData";
import { chatCache } from "../../lib/chatCache";
import { getSocket } from "../../lib/socket";
import { 
  addContact,
  toggleChatPin,
  toggleArchiveChat,
  deleteChat,
  removeContact,
  blockUser,
  getSecureMediaUrl,
  joinOrganizationByInvite,
} from "../../lib/api";
import { authStorage } from "../../lib/authStorage";
import Svg, { Text as SvgText, Defs, LinearGradient, Stop } from "react-native-svg";
import { useTheme } from "../../lib/theme";
import { getCachedNickname } from "../../lib/nicknames";
import { useViewerVisibility } from "../../lib/presence";
import * as Notifications from 'expo-notifications';
import { getActiveChatId } from "../../lib/activeChatRef";

export default function Messages() {
  const router = useRouter();
  const { colors } = useTheme();
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState("All");
  const [chatsList, setChatsList] = useState<Chat[]>([]);
  const [contactsList, setContactsList] = useState<Contact[]>([]);
  const [foldersList, setFoldersList] = useState<string[]>([]);
  const [folderMappings, setFolderMappings] = useState<{ [id: string]: string[] }>({});

  // Selection states
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);

  // Folder selection sub-modal state
  const [isFolderSelectOpen, setIsFolderSelectOpen] = useState(false);
  const [folderSelectChatId, setFolderSelectChatId] = useState<string | null>(null);

  // Context Menu state
  const [activeContextItem, setActiveContextItem] = useState<{
    type: 'chat' | 'contact';
    id: string;
    name: string;
    isPinned: boolean;
    isMuted: boolean;
  } | null>(null);

  // Custom Toast Notifier
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2000);
  };

  const handleLongPressItem = (type: 'chat' | 'contact', id: string, name: string, isPinned: boolean, isMuted: boolean) => {
    if (isSelectionMode) return;
    setActiveContextItem({ type, id, name, isPinned, isMuted });
  };

  const handlePressItem = (type: 'chat' | 'contact', id: string) => {
    if (isSelectionMode) {
      setSelectedItemIds(prev =>
        prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
      );
    } else {
      router.push(`/chat/${id}`);
    }
  };

  const handleTogglePin = async (id: string) => {
    try {
      await toggleChatPin(id);
      showToast("Chat pin toggled");
      await syncWithBackend();
    } catch (err: any) {
      showToast("Failed to toggle pin");
    }
    setActiveContextItem(null);
  };

  const handleToggleArchive = async (id: string) => {
    try {
      await toggleArchiveChat(id);
      showToast("Chat archive toggled");
      await syncWithBackend();
    } catch (err: any) {
      showToast("Failed to toggle archive");
    }
    setActiveContextItem(null);
  };

  const handleDeleteItem = async (id: string, type: 'chat' | 'contact') => {
    try {
      if (type === 'chat') {
        await deleteChat(id);
        showToast("Chat deleted");
      } else {
        await removeContact(id);
        showToast("Contact removed");
      }
      await syncWithBackend();
    } catch (err: any) {
      showToast("Action failed");
    }
    setActiveContextItem(null);
  };

  const handleBlockContact = async (name: string) => {
    if (!activeContextItem) return;
    try {
      let targetUserId = activeContextItem.id;
      if (activeContextItem.type === 'chat') {
        const chatObj = chatsList.find(c => c.id === activeContextItem.id);
        targetUserId = (chatObj as any)?.otherUserId || targetUserId;
      }
      await blockUser(targetUserId);
      showToast(`${name} has been blocked`);
      await syncWithBackend();
    } catch (err: any) {
      showToast("Failed to block user");
    }
    setActiveContextItem(null);
  };

  const handleToggleSelectMode = (id: string) => {
    setIsSelectionMode(true);
    setSelectedItemIds([id]);
    setActiveContextItem(null);
  };

  // FAB Menu States
  const [isFabMenuOpen, setIsFabMenuOpen] = useState(false);
  const [isAddContactOpen, setIsAddContactOpen] = useState(false);
  const [isCreateTabOpen, setIsCreateTabOpen] = useState(false);
  const [isJoinOrgOpen, setIsJoinOrgOpen] = useState(false);

  // Join Org/Group Input
  const [joinOrgCode, setJoinOrgCode] = useState("");
  const [isJoiningOrg, setIsJoiningOrg] = useState(false);

  // New Contact Inputs
  const [newContactName, setNewContactName] = useState("");
  const [newContactCategory, setNewContactCategory] = useState("Friends");

  // New Tab Inputs
  const [newTabName, setNewTabName] = useState("");
  const [newFolderNameInMove, setNewFolderNameInMove] = useState("");

  const navigation = useNavigation();
  const [isFocused, setIsFocused] = useState(navigation.isFocused());

  // Per-chat unsent drafts ("Draft: …" preview) + sync-failure banner state.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [syncFailed, setSyncFailed] = useState(false);

  useEffect(() => {
    const unsubscribeFocus = navigation.addListener("focus", () => {
      setIsFocused(true);
      chatCache.getAllDrafts().then(setDrafts).catch(() => undefined);
    });
    const unsubscribeBlur = navigation.addListener("blur", () => {
      setIsFocused(false);
    });
    setIsFocused(navigation.isFocused());

    return () => {
      unsubscribeFocus();
      unsubscribeBlur();
    };
  }, [navigation]);

  const loadCache = async () => {
    const cachedChats = await chatCache.getCachedChats();
    const cachedContacts = await chatCache.getCachedContacts();
    const cachedFolders = await chatCache.getFolders();
    const cachedMappings = await chatCache.getFolderMappings();
    setChatsList(cachedChats);
    setContactsList(cachedContacts);
    setFoldersList(cachedFolders);
    setFolderMappings(cachedMappings);
  };

  const syncWithBackend = async () => {
    try {
      const freshChats = await chatCache.syncChatsWithBackend();
      const freshContacts = await chatCache.syncContactsWithBackend();
      const freshFolders = await chatCache.getFolders();
      const freshMappings = await chatCache.getFolderMappings();
      setChatsList(freshChats);
      setContactsList(freshContacts);
      setFoldersList(freshFolders);
      setFolderMappings(freshMappings);
      setSyncFailed(false);
    } catch (err) {
      // Surface the failure instead of silently showing stale data.
      console.warn("Sync failed in messages.tsx:", err);
      setSyncFailed(true);
    }
  };

  const currentUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    loadCache();
    syncWithBackend();
    authStorage.getUser().then((user) => {
      if (user) {
        currentUserIdRef.current = String(user.id || user._id);
      }
    });
  }, []);

  // Real-time socket typing states
  const [typingChats, setTypingChats] = useState<Record<string, { fromUserId: string; fromUsername?: string; fromName?: string } | false>>({});

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleTypingStart = (data: { chatId: string; fromUserId: string; fromUsername?: string; fromName?: string }) => {
      if (currentUserIdRef.current && String(data.fromUserId) === String(currentUserIdRef.current)) return;
      if (data.chatId) {
        setTypingChats(prev => ({ ...prev, [data.chatId]: { fromUserId: data.fromUserId, fromUsername: data.fromUsername, fromName: data.fromName } }));
      }
    };

    const handleTypingStop = (data: { chatId: string }) => {
      if (data.chatId) {
        setTypingChats(prev => ({ ...prev, [data.chatId]: false }));
      }
    };

    // ── Real-time new message ─ update badge and preview instantly ────────────
    const handleNewMessage = (data: any) => {
      if (!data) return;
      const chatId = String(data.chat || data.chatId || '');
      if (!chatId) return;
      const currentUserId = currentUserIdRef.current;
      const senderId = String(data.sender?.id || data.sender?._id || data.sender || '');
      const isMe = currentUserId && senderId === String(currentUserId);
      const isSystem = data.message_type === 'system' || data.is_announcement === true;

      if (isSystem) return;

      const previewText = data.message_type === 'text'
        ? (data.content || data.text || '')
        : `📎 [${data.message_type || 'Media'}]`;

      // Own messages (sent from another device or echoed back) still update the
      // preview + "You:" tick — they just never bump the unread badge or notify.
      if (isMe) {
        setChatsList(prev => prev.map(c => {
          if (String(c.id) !== chatId) return c;
          return {
            ...c,
            latestMessage: previewText,
            latestFromMe: true,
            status: data.isRead ? 'read_other_all' : (data.isDelivered ? 'delivered' : 'sent'),
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          } as any;
        }));
        return;
      }

      setChatsList(prev => prev.map(c => {
        if (String(c.id) !== chatId) return c;
        return {
          ...c,
          latestMessage: previewText,
          latestFromMe: false,
          status: 'unread_other',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          unreadCount: (c.unreadCount || 0) + 1,
        } as any;
      }));

      // In-app foreground banner: fire a local notification when the user is in the
      // app but NOT inside this specific chat screen. Honors the user's settings:
      // muted = no banner at all; preview off = generic body; sounds off = silent.
      if (String(chatId) !== String(getActiveChatId())) {
        const senderName = data.sender?.full_name || data.sender?.username || 'Someone';
        authStorage.getUser().then((me: any) => {
          const prefs = me?.notification_settings || {};
          if (prefs.muted === true) return;
          Notifications.scheduleNotificationAsync({
            content: {
              title: senderName,
              body: prefs.preview === false ? 'New message' : previewText,
              sound: prefs.sounds === false ? undefined : 'default',
              data: { chatId, type: 'new_message' },
            },
            trigger: null,
          }).catch(() => {});
        }).catch(() => {});
      }
    };

    // ── Real-time read receipts ─ clear badge when other user reads ───────────
    const handleMessagesRead = (data: { chatId: string; userId: string }) => {
      if (!data?.chatId) return;
      const currentUserId = currentUserIdRef.current;
      // If the current user read messages, clear their own badge
      if (currentUserId && String(data.userId) === String(currentUserId)) {
        setChatsList(prev => prev.map(c =>
          String(c.id) === String(data.chatId) ? { ...c, unreadCount: 0 } : c
        ));
        return;
      }
      // Someone ELSE read the chat — if our own message is the latest, flip its
      // preview tick to blue.
      setChatsList(prev => prev.map(c =>
        String(c.id) === String(data.chatId) && (c as any).latestFromMe
          ? ({ ...c, status: 'read_other_all' } as any)
          : c
      ));
    };

    // ── Delivery receipts ─ recipient's device got our latest message (2 gray) ─
    const handleDeliveryReceipt = (data: { chatId: string; messageIds: string[]; deliveredBy: string }) => {
      if (!data?.chatId) return;
      const currentUserId = currentUserIdRef.current;
      if (currentUserId && String(data.deliveredBy) === String(currentUserId)) return;
      setChatsList(prev => prev.map(c =>
        String(c.id) === String(data.chatId) && (c as any).latestFromMe && c.status === 'sent'
          ? ({ ...c, status: 'delivered' } as any)
          : c
      ));
    };

    // ── Authoritative unread badge ─ backend pushes the exact server-side count
    // so every device stays in sync regardless of which one read/received.
    const handleUnreadCountUpdated = (data: { chatId: string; unreadCount: number }) => {
      if (!data?.chatId) return;
      setChatsList(prev => prev.map(c =>
        String(c.id) === String(data.chatId) ? { ...c, unreadCount: data.unreadCount } : c
      ));
    };

    const handleConnect = () => {
      console.log("Socket connected/reconnected in Messages screen. Flushing offline queue and syncing...");
      chatCache.processOfflineQueue().then(() => {
        syncWithBackend();
      });
    };

    // A group's membership/metadata changed (member added/removed/icon/name edited).
    // The backend sends the raw conversation shape (groupIcon/chatName); map those
    // onto the cached chat's UI shape (avatar/name) so the list actually reflects it.
    const handleChatUpdated = (updated: any) => {
      const u = updated?.data || updated;
      const uid = u?.id || u?._id;
      if (!uid) return;
      setChatsList(prev => prev.map(c => {
        if (String(c.id) !== String(uid)) return c;
        return {
          ...c,
          ...u,
          avatar: u.groupIcon !== undefined ? (u.groupIcon || null) : c.avatar,
          name: u.chatName !== undefined && u.chatName ? u.chatName : c.name,
          bio: u.groupDescription !== undefined ? (u.groupDescription || c.bio) : c.bio,
        };
      }));
      chatCache.patchCachedChat(String(uid), {
        groupIcon: u.groupIcon,
        chatName: u.chatName,
        groupDescription: u.groupDescription,
      });
    };

    socket.on('typing_start', handleTypingStart);
    socket.on('typing_stop', handleTypingStop);
    socket.on('new_message', handleNewMessage);
    socket.on('receive_message', handleNewMessage);
    socket.on('messages_read', handleMessagesRead);
    socket.on('message_delivery_receipt', handleDeliveryReceipt);
    socket.on('unread_count_updated', handleUnreadCountUpdated);
    socket.on('chat_updated', handleChatUpdated);
    socket.on('connect', handleConnect);

    if (socket.connected) {
      handleConnect();
    }

    return () => {
      socket.off('typing_start', handleTypingStart);
      socket.off('typing_stop', handleTypingStop);
      socket.off('new_message', handleNewMessage);
      socket.off('receive_message', handleNewMessage);
      socket.off('messages_read', handleMessagesRead);
      socket.off('message_delivery_receipt', handleDeliveryReceipt);
      socket.off('unread_count_updated', handleUnreadCountUpdated);
      socket.off('chat_updated', handleChatUpdated);
      socket.off('connect', handleConnect);
    };
  }, []);

  useEffect(() => {
    if (!isFocused) return;
    
    // Poll silently every 5 seconds (no spinner UI)
    const interval = setInterval(syncWithBackend, 5000);
    return () => clearInterval(interval);
  }, [isFocused]);

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

  const getInitials = (name: string) =>
    name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();

  // Safety-net dedupe: collapse any duplicate conversations that slipped through
  // (parallel DM docs for the same user-pair, repeated rows) so each renders once.
  const dedupedChats = Array.from(
    new Map(
      chatsList.map((c) => [
        !c.isGroupChat && c.otherUserId ? `dm:${c.otherUserId}` : `id:${c.id}`,
        c,
      ])
    ).values()
  );

  // Set of user ids that already have a 1:1 conversation — used to keep a contact
  // from showing in CONTACTS when it's already under RECENT MESSAGES.
  const chattedUserIds = new Set(
    dedupedChats.filter((c) => !c.isGroupChat && c.otherUserId).map((c) => String(c.otherUserId))
  );

  // Filter conversations by active tab
  const filteredChats = dedupedChats.filter((c) => {
    const matchesSearch = c.name.toLowerCase().includes(search.toLowerCase());
    if (!matchesSearch) return false;

    // Archived = user chose "archive" (Conversation.archivedBy) — distinct from
    // muted, which only silences notifications and stays in the main list.
    const isArchived = !!(c as any).isArchived;
    if (activeFilter === "Archive") return isArchived;
    if (isArchived) return false; // Hide archived from other tabs

    // Check custom folder tab mappings
    const mappings = folderMappings[c.id] || [];
    if (activeFilter !== "All" && mappings.includes(activeFilter)) {
      return true;
    }

    if (activeFilter === "Unread") return c.unreadCount > 0;
    if (activeFilter === "Work") return c.isGroupChat;
    if (activeFilter === "Friends") return !!c.isFriend;

    if (activeFilter !== "All") {
      const contact = contactsList.find(con => con.id === c.id);
      if (contact && contact.category?.toLowerCase() === activeFilter.toLowerCase()) return true;
      return false;
    }
    return true; // "All"
  });

  // Filter contacts visible per tab
  const filteredContacts = contactsList.filter((c) => {
    const matchesSearch = c.name.toLowerCase().includes(search.toLowerCase());
    if (!matchesSearch) return false;

    // A contact that already has a conversation belongs in RECENT MESSAGES only —
    // don't duplicate it down in CONTACTS.
    if (chattedUserIds.has(String(c.id))) return false;

    // Check custom folder tab mappings for contacts
    const mappings = folderMappings[c.id] || [];
    if (activeFilter !== "All" && mappings.includes(activeFilter)) {
      return true;
    }

    if (activeFilter === "All") return true;
    if (activeFilter === "Friends") return c.category === "friend" || c.category === "other";
    if (activeFilter === "Work") return c.category === "work";

    return c.category?.toLowerCase() === activeFilter.toLowerCase();
  }).filter((c, i, arr) => arr.findIndex(x => String(x.id) === String(c.id)) === i); // dedupe by id

  const isEmpty = filteredChats.length === 0 && filteredContacts.length === 0;

  const insets = useSafeAreaInsets();
  const headerHeight = 170 + insets.top;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* ── Chat / Contact List ── */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: headerHeight + 10, // Starts below the header, clean solid layout!
          paddingBottom: 125, // Leave room for the bottom blurred tab bar
          paddingHorizontal: 8,
        }}
        showsVerticalScrollIndicator={false}
      >
        {syncFailed && (
          <TouchableOpacity
            onPress={() => { setSyncFailed(false); syncWithBackend(); }}
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(244,102,59,0.1)", borderRadius: 12, paddingVertical: 8, paddingHorizontal: 12, marginBottom: 10 }}
          >
            <Text style={{ fontSize: 12, fontFamily: "Poppins_500Medium", color: "#f4663b" }}>
              Couldn't refresh — showing cached chats. Tap to retry.
            </Text>
          </TouchableOpacity>
        )}
        {isEmpty ? (
          <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 80 }}>
            <MessageSquarePlus size={36} color={colors.textSoft} />
            <Text style={{ marginTop: 12, fontSize: 14, fontFamily: "Poppins_500Medium", color: colors.textSoft }}>
              No conversations yet
            </Text>
            <Text style={{ fontSize: 12, fontFamily: "Poppins_400Regular", color: colors.textSoft, marginTop: 4 }}>
              Message a contact to get started
            </Text>
          </View>
        ) : (
          <>
            {/* Recent Messages */}
            {filteredChats.length > 0 && (
              <View style={{ marginBottom: 20 }}>
                <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, marginBottom: 8 }}>
                  <Text style={{ fontSize: 10, fontFamily: "Poppins_700Bold", color: colors.textSoft, letterSpacing: 1.5, fontStyle: "italic", textTransform: "uppercase" }}>
                    RECENT MESSAGES
                  </Text>
                  <View style={{ flex: 1, height: 1, backgroundColor: colors.border, marginLeft: 10 }} />
                </View>

                {filteredChats.map((chat, index) => {
                  const isSelected = selectedItemIds.includes(chat.id);
                  return (
                    <React.Fragment key={chat.id}>
                      <ChatRow
                        chat={chat}
                        getInitials={getInitials}
                        isSelectionMode={isSelectionMode}
                        isSelected={isSelected}
                        isTyping={typingChats[chat.id]}
                        draft={drafts[String(chat.id)]}
                        onPress={() => handlePressItem('chat', chat.id)}
                        onLongPress={() => handleLongPressItem('chat', chat.id, chat.name, chat.isPinned, !!chat.isMuted)}
                      />
                      {index < filteredChats.length - 1 && (
                        <View style={{ height: 1, backgroundColor: colors.border, marginHorizontal: 12, marginVertical: 3 }} />
                      )}
                    </React.Fragment>
                  );
                })}
              </View>
            )}

            {/* Contacts */}
            {filteredContacts.length > 0 && (
              <View style={{ marginBottom: 32 }}>
                <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, marginBottom: 8 }}>
                  <Text style={{ fontSize: 10, fontFamily: "Poppins_700Bold", color: colors.textSoft, letterSpacing: 1.5, fontStyle: "italic", textTransform: "uppercase" }}>
                    CONTACTS
                  </Text>
                  <View style={{ flex: 1, height: 1, backgroundColor: colors.border, marginLeft: 10 }} />
                </View>

                {filteredContacts.map((contact, index) => {
                  const isSelected = selectedItemIds.includes(contact.id);
                  const matchingChat = chatsList.find(c => String(c.otherUserId) === String(contact.id) || String(c.id) === String(contact.id));
                  const isTyping = matchingChat && !!typingChats[matchingChat.id];
                  const chatTarget = matchingChat?.id || contact.id;

                  return (
                    <React.Fragment key={contact.id}>
                      <ContactRow
                        contact={contact}
                        matchingChat={matchingChat}
                        getInitials={getInitials}
                        isSelectionMode={isSelectionMode}
                        isSelected={isSelected}
                        isTyping={typingChats[matchingChat?.id || '']}
                        onPress={() => handlePressItem('contact', chatTarget)}
                        onLongPress={() => handleLongPressItem('contact', contact.id, contact.name, false, false)}
                      />
                      {index < filteredContacts.length - 1 && (
                        <View style={{ height: 1, backgroundColor: colors.border, marginHorizontal: 12, marginVertical: 3 }} />
                      )}
                    </React.Fragment>
                  );
                })}
              </View>
            )}
          </>
        )}
      </ScrollView>

      {/* ── Fixed Solid Header Overlay ── */}
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: headerHeight,
          backgroundColor: colors.bg, // Solid background to prevent overlap issues
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          zIndex: 10,
        }}
      >
        <View style={{ paddingTop: insets.top }}>
          {/* Header Title with Deep Indigo/Purple Gradient */}
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 }}>
            <Svg height="36" width="160">
              <Defs>
                <LinearGradient id="textGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                  <Stop offset="0%" stopColor="#5e52e6" />
                  <Stop offset="100%" stopColor="#8a7bf3" />
                </LinearGradient>
              </Defs>
              <SvgText
                fill="url(#textGrad)"
                fontSize="28"
                fontFamily="SpaceGrotesk_700Bold"
                x="0"
                y="27"
                letterSpacing="-0.5"
              >
                Messages
              </SvgText>
            </Svg>
          </View>

          {/* Search */}
          <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                borderRadius: 24,
                paddingHorizontal: 16,
                paddingVertical: 12,
                backgroundColor: "rgba(108,92,231,0.08)",
                borderWidth: 1,
                borderColor: "rgba(108,92,231,0.08)",
              }}
            >
              <Search size={18} color="#6c5ce7" style={{ marginRight: 10, flexShrink: 0 }} />
              <TextInput
                placeholder="Search conversations..."
                value={search}
                onChangeText={setSearch}
                placeholderTextColor={colors.textSoft}
                style={{ flex: 1, fontSize: 14.5, color: colors.text, fontFamily: "Poppins_400Regular" }}
              />
            </View>
          </View>

          {/* Filter Tabs */}
          <View style={{ paddingBottom: 8 }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, gap: 8 }}>
              {foldersList.map((filter) => {
                const isActive = activeFilter === filter;
                return (
                  <TouchableOpacity
                    key={filter}
                    onPress={() => setActiveFilter(filter)}
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 7,
                      borderRadius: 100,
                      backgroundColor: isActive ? "#6c5ce7" : "rgba(108,92,231,0.08)",
                      borderWidth: 1,
                      borderColor: isActive ? "#6c5ce7" : "transparent",
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 13,
                        fontFamily: isActive ? "Poppins_700Bold" : "Poppins_500Medium",
                        color: isActive ? "#ffffff" : colors.textSoft,
                      }}
                    >
                      {filter}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </View>
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
        <View style={styles.fabMenu}>
          <TouchableOpacity
            style={styles.fabMenuItem}
            onPress={() => {
              setIsFabMenuOpen(false);
              setIsAddContactOpen(true);
            }}
          >
            <UserPlus size={16} color="#6c5ce7" style={{ marginRight: 10 }} />
            <Text style={styles.fabMenuText}>Add Contact</Text>
          </TouchableOpacity>
          <View style={styles.divider} />
          <TouchableOpacity
            style={styles.fabMenuItem}
            onPress={() => {
              setIsFabMenuOpen(false);
              setIsCreateTabOpen(true);
            }}
          >
            <FolderPlus size={16} color="#6c5ce7" style={{ marginRight: 10 }} />
            <Text style={styles.fabMenuText}>New Folder Tab</Text>
          </TouchableOpacity>
          <View style={styles.divider} />
          <TouchableOpacity
            style={styles.fabMenuItem}
            onPress={() => {
              setIsFabMenuOpen(false);
              setIsJoinOrgOpen(true);
            }}
          >
            <Users size={16} color="#6c5ce7" style={{ marginRight: 10 }} />
            <Text style={styles.fabMenuText}>Join Group / Org</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Add Contact Modal ── */}
      <Modal visible={isAddContactOpen} transparent animationType="slide">
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setIsAddContactOpen(false)}
          style={styles.modalOverlay}
        >
          <TouchableOpacity activeOpacity={1} style={[styles.modalContent, { backgroundColor: colors.card }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>Add Contact</Text>
              <TouchableOpacity onPress={() => setIsAddContactOpen(false)}>
                <X size={20} color="#6c5ce7" />
              </TouchableOpacity>
            </View>
            
            <Text style={[styles.inputLabel, { color: colors.textSoft }]}>Email or BubbleID</Text>
            <TextInput
              style={[styles.textInput, { color: colors.text, backgroundColor: colors.purpleSoft }]}
              placeholder="e.g. user@example.com or bubble-ID"
              value={newContactName}
              onChangeText={setNewContactName}
              placeholderTextColor={colors.textSoft}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <TouchableOpacity
              style={styles.saveBtn}
              onPress={async () => {
                const tag = newContactName.trim();
                if (!tag) return;
                try {
                  await addContact(tag);
                  showToast("Contact added!");
                  setNewContactName("");
                  setIsAddContactOpen(false);
                  await syncWithBackend();
                } catch (err: any) {
                  Alert.alert("Error", err.message || "Failed to add contact.");
                }
              }}
            >
              <Text style={styles.saveBtnText}>Save Contact</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ── Join Group / Org Modal ── */}
      <Modal visible={isJoinOrgOpen} transparent animationType="slide">
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setIsJoinOrgOpen(false)}
          style={styles.modalOverlay}
        >
          <TouchableOpacity activeOpacity={1} style={[styles.modalContent, { backgroundColor: colors.card }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>Join Group / Org</Text>
              <TouchableOpacity onPress={() => setIsJoinOrgOpen(false)}>
                <X size={20} color="#6c5ce7" />
              </TouchableOpacity>
            </View>

            <Text style={[styles.inputLabel, { color: colors.textSoft }]}>Organization / Group Code</Text>
            <TextInput
              style={[styles.textInput, { color: colors.text, backgroundColor: colors.purpleSoft }]}
              placeholder="Paste your invite code"
              value={joinOrgCode}
              onChangeText={setJoinOrgCode}
              placeholderTextColor={colors.textSoft}
              autoCapitalize="characters"
              autoCorrect={false}
            />

            <TouchableOpacity
              style={[styles.saveBtn, isJoiningOrg && { opacity: 0.6 }]}
              disabled={isJoiningOrg}
              onPress={async () => {
                const code = joinOrgCode.trim();
                if (!code) return;
                setIsJoiningOrg(true);
                try {
                  const result = await joinOrganizationByInvite(code);
                  showToast(result?.message || "Joined successfully!");
                  setJoinOrgCode("");
                  setIsJoinOrgOpen(false);
                  await syncWithBackend();
                } catch (err: any) {
                  Alert.alert("Error", err.message || "Failed to join. Check the code and try again.");
                } finally {
                  setIsJoiningOrg(false);
                }
              }}
            >
              <Text style={styles.saveBtnText}>{isJoiningOrg ? "Joining…" : "Join"}</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ── Create Folder Tab Modal ── */}
      <Modal visible={isCreateTabOpen} transparent animationType="slide">
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setIsCreateTabOpen(false)}
          style={styles.modalOverlay}
        >
          <TouchableOpacity activeOpacity={1} style={[styles.modalContent, { backgroundColor: colors.card }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>New Folder Tab</Text>
              <TouchableOpacity onPress={() => setIsCreateTabOpen(false)}>
                <X size={20} color="#6c5ce7" />
              </TouchableOpacity>
            </View>
            
            <Text style={[styles.inputLabel, { color: colors.textSoft }]}>Folder Name</Text>
            <TextInput
              style={[styles.textInput, { color: colors.text, backgroundColor: colors.purpleSoft }]}
              placeholder="e.g. VIP or Personal"
              value={newTabName}
              onChangeText={setNewTabName}
              placeholderTextColor={colors.textSoft}
              autoFocus
            />

            <TouchableOpacity
              style={styles.saveBtn}
              onPress={async () => {
                const name = newTabName.trim();
                if (!name) return;
                const updatedFolders = await chatCache.addFolder(name);
                setFoldersList(updatedFolders);
                setActiveFilter(name);
                setNewTabName("");
                setIsCreateTabOpen(false);
                showToast(`Tab ${name} created`);
              }}
            >
              <Text style={styles.saveBtnText}>Create Tab</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ── Move Chat to Folder Tab Modal ── */}
      <Modal visible={isFolderSelectOpen} transparent animationType="slide">
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => {
            setIsFolderSelectOpen(false);
            setFolderSelectChatId(null);
          }}
          style={styles.modalOverlay}
        >
          <TouchableOpacity activeOpacity={1} style={[styles.modalContent, { backgroundColor: colors.card }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>Move to Folder</Text>
              <TouchableOpacity onPress={() => { setIsFolderSelectOpen(false); setFolderSelectChatId(null); }}>
                <X size={20} color="#6c5ce7" />
              </TouchableOpacity>
            </View>

            <Text style={{ fontSize: 13, fontFamily: "Poppins_500Medium", color: colors.text, marginBottom: 12 }}>
              Choose which folders/tabs this conversation should appear in:
            </Text>

            <ScrollView style={{ maxHeight: 250 }} contentContainerStyle={{ gap: 8, paddingBottom: 12 }} showsVerticalScrollIndicator={false}>
              {foldersList.filter(f => f !== "All" && f !== "Unread" && f !== "Archive").map((folder) => {
                const isMapped = folderSelectChatId ? (folderMappings[folderSelectChatId] || []).includes(folder) : false;
                return (
                  <TouchableOpacity
                    key={folder}
                    onPress={async () => {
                      if (!folderSelectChatId) return;
                      const updated = await chatCache.moveChatToFolder(folderSelectChatId, folder);
                      setFolderMappings(updated);
                      showToast(isMapped ? `Removed from ${folder}` : `Moved to ${folder}`);
                    }}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      paddingVertical: 12,
                      paddingHorizontal: 14,
                      borderRadius: 14,
                      backgroundColor: isMapped ? colors.purpleSoft : colors.border,
                      borderWidth: 1,
                      borderColor: isMapped ? "#6c5ce7" : "transparent",
                    }}
                  >
                    <Text style={{ fontSize: 14, fontFamily: "Poppins_600SemiBold", color: isMapped ? "#6c5ce7" : colors.text }}>
                      {folder}
                    </Text>
                    {isMapped && <Check size={16} color="#6c5ce7" />}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            {/* Create inline folder tab section */}
            <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12, marginTop: 8, marginBottom: 8 }}>
              <Text style={{ fontSize: 10, fontFamily: 'Poppins_700Bold', color: colors.textSoft, textTransform: 'uppercase', marginBottom: 6, letterSpacing: 0.5 }}>
                Create & Move to New Tab
              </Text>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <TextInput
                  style={[styles.textInput, { flex: 1, marginBottom: 0, height: 42, paddingVertical: 0, color: colors.text, backgroundColor: colors.purpleSoft }]}
                  placeholder="New tab name..."
                  value={newFolderNameInMove}
                  onChangeText={setNewFolderNameInMove}
                  placeholderTextColor={colors.textSoft}
                />
                <TouchableOpacity
                  onPress={async () => {
                    const name = newFolderNameInMove.trim();
                    if (!name) return;
                    const updatedFolders = await chatCache.addFolder(name);
                    setFoldersList(updatedFolders);
                    if (folderSelectChatId) {
                      const updatedMappings = await chatCache.moveChatToFolder(folderSelectChatId, name);
                      setFolderMappings(updatedMappings);
                    }
                    setNewFolderNameInMove("");
                    showToast(`Created & added to ${name}`);
                  }}
                  style={{
                    backgroundColor: '#6c5ce7',
                    paddingHorizontal: 16,
                    height: 42,
                    borderRadius: 14,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ color: '#ffffff', fontSize: 12, fontFamily: 'Poppins_700Bold' }}>Create</Text>
                </TouchableOpacity>
              </View>
            </View>

            <TouchableOpacity
              style={[styles.saveBtn, { marginTop: 10 }]}
              onPress={() => {
                setIsFolderSelectOpen(false);
                setFolderSelectChatId(null);
              }}
            >
              <Text style={styles.saveBtnText}>Done</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ── Selection Mode Bulk Actions Bottom Bar ── */}
      {isSelectionMode && (
        <View style={{
          position: "absolute",
          bottom: 100,
          left: 16,
          right: 16,
          backgroundColor: colors.card,
          borderRadius: 20,
          paddingVertical: 14,
          paddingHorizontal: 20,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          borderWidth: 1,
          borderColor: "rgba(108,92,231,0.1)",
          shadowColor: "#6c5ce7",
          shadowOpacity: 0.15,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 4 },
          elevation: 10,
          zIndex: 1000,
        }}>
          <TouchableOpacity onPress={() => {
            setIsSelectionMode(false);
            setSelectedItemIds([]);
          }}>
            <Text style={{ fontSize: 13.5, fontFamily: "Poppins_600SemiBold", color: colors.textSoft }}>Cancel</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => {
            const allIds = [...filteredChats.map(c => c.id), ...filteredContacts.map(c => c.id)];
            setSelectedItemIds(allIds);
          }}>
            <Text style={{ fontSize: 13.5, fontFamily: "Poppins_600SemiBold", color: "#6c5ce7" }}>Select All</Text>
          </TouchableOpacity>

          <View style={{ flexDirection: "row", gap: 10 }}>
            <TouchableOpacity
              onPress={async () => {
                let count = 0;
                for (const id of selectedItemIds) {
                  try {
                    await toggleArchiveChat(id);
                    count++;
                  } catch (e) {}
                }
                showToast(`${count} chats archived`);
                setIsSelectionMode(false);
                setSelectedItemIds([]);
                await syncWithBackend();
              }}
              disabled={selectedItemIds.length === 0}
              style={{
                flexDirection: "row",
                alignItems: "center",
                backgroundColor: selectedItemIds.length > 0 ? "rgba(108,92,231,0.08)" : "transparent",
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 10,
              }}
            >
              <Archive size={14} color={selectedItemIds.length > 0 ? "#6c5ce7" : colors.textSoft} style={{ marginRight: 4 }} />
              <Text style={{ fontSize: 12.5, fontFamily: "Poppins_700Bold", color: selectedItemIds.length > 0 ? "#6c5ce7" : colors.textSoft }}>Archive</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={async () => {
                for (const id of selectedItemIds) {
                  try {
                    const chatIndex = chatsList.findIndex(c => c.id === id);
                    if (chatIndex !== -1) {
                      await deleteChat(id);
                    } else {
                      await removeContact(id);
                    }
                  } catch (e) {}
                }
                showToast(`Deleted selected items`);
                setIsSelectionMode(false);
                setSelectedItemIds([]);
                await syncWithBackend();
              }}
              disabled={selectedItemIds.length === 0}
              style={{
                flexDirection: "row",
                alignItems: "center",
                backgroundColor: selectedItemIds.length > 0 ? "rgba(239, 68, 68, 0.08)" : "transparent",
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 10,
              }}
            >
              <Trash2 size={14} color={selectedItemIds.length > 0 ? "red" : colors.textSoft} style={{ marginRight: 4 }} />
              <Text style={{ fontSize: 12.5, fontFamily: "Poppins_700Bold", color: selectedItemIds.length > 0 ? "red" : colors.textSoft }}>Delete</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

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

      {/* ── Contact/Chat Context Menu Modal ── */}
      <Modal visible={activeContextItem !== null} transparent animationType="fade">
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setActiveContextItem(null)}
          style={{
            flex: 1,
            backgroundColor: "rgba(31,32,48,0.4)",
            justifyContent: "center",
            alignItems: "center",
            padding: 20,
          }}
        >
          {activeContextItem && (
            <TouchableOpacity
              activeOpacity={1}
              style={{
                width: "100%",
                maxWidth: 290,
                backgroundColor: colors.card,
                borderRadius: 24,
                padding: 18,
                shadowColor: "#000",
                shadowOpacity: 0.1,
                shadowRadius: 10,
                elevation: 10,
              }}
            >
              <Text style={{ fontSize: 10, fontFamily: "Poppins_700Bold", color: colors.textSoft, textTransform: "uppercase", marginBottom: 4, letterSpacing: 0.5 }}>
                {activeContextItem.type === 'chat' ? 'Conversation Options' : 'Contact Options'}
              </Text>
              <Text style={{ fontSize: 15.5, fontFamily: "Poppins_700Bold", color: colors.text, marginBottom: 12 }}>
                {activeContextItem.name}
              </Text>

              <View style={{ height: 1, backgroundColor: colors.border, marginBottom: 8 }} />

              {activeContextItem.type === 'chat' && (
                <ContextMenuItem
                  icon={<Pin size={16} color={colors.textSoft} />}
                  label={activeContextItem.isPinned ? "Unpin Chat" : "Pin Chat"}
                  onPress={() => handleTogglePin(activeContextItem.id)}
                />
              )}

              {activeContextItem.type === 'chat' && (
                <ContextMenuItem
                  icon={<Archive size={16} color={colors.textSoft} />}
                  label={activeContextItem.isMuted ? "Unarchive Chat" : "Archive Chat"}
                  onPress={() => handleToggleArchive(activeContextItem.id)}
                />
              )}

              {activeContextItem.type === 'chat' && (
                <ContextMenuItem
                  icon={<FolderPlus size={16} color={colors.textSoft} />}
                  label="Move to Folder"
                  onPress={() => {
                    setFolderSelectChatId(activeContextItem.id);
                    setIsFolderSelectOpen(true);
                    setActiveContextItem(null);
                  }}
                />
              )}

              <ContextMenuItem
                icon={<Ban size={16} color={colors.textSoft} />}
                label="Block Contact"
                onPress={() => handleBlockContact(activeContextItem.name)}
              />

              <ContextMenuItem
                icon={<Check size={16} color={colors.textSoft} />}
                label="Select"
                onPress={() => handleToggleSelectMode(activeContextItem.id)}
              />

              <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 8 }} />

              <ContextMenuItem
                icon={<Trash2 size={16} color="red" />}
                label={activeContextItem.type === 'chat' ? "Delete Chat" : "Delete Contact"}
                labelStyle={{ color: "red" }}
                onPress={() => handleDeleteItem(activeContextItem.id, activeContextItem.type)}
              />
            </TouchableOpacity>
          )}
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function getGroupInitials(name: string) {
  if (!name) return 'UC';
  const clean = name.trim().replace(/\s+/g, ' ');
  const parts = clean.split(' ');
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

function ChatRow({
  chat,
  getInitials,
  isSelectionMode,
  isSelected,
  isTyping,
  draft,
  onPress,
  onLongPress
}: {
  chat: Chat;
  getInitials: (n: string) => string;
  isSelectionMode: boolean;
  isSelected: boolean;
  isTyping: { fromUserId: string; fromUsername?: string; fromName?: string } | false | undefined;
  draft?: string;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const { colors } = useTheme();
  // Reciprocity: hide others' presence / read state if I've hidden my own.
  const { presenceVisible, readReceipts } = useViewerVisibility();

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      onLongPress={onLongPress}
      style={{ flexDirection: "row", alignItems: "center", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 2 }}
    >
      {isSelectionMode && (
        <View style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          borderWidth: 2,
          borderColor: isSelected ? "#6c5ce7" : colors.textSoft,
          backgroundColor: isSelected ? "#6c5ce7" : "transparent",
          alignItems: "center",
          justifyContent: "center",
          marginRight: 10,
          flexShrink: 0,
        }}>
          {isSelected && <Check size={12} color="#ffffff" />}
        </View>
      )}

      {/* Avatar */}
      <View style={{ position: "relative", flexShrink: 0 }}>
        <Avatar
          url={chat.avatar}
          name={chat.name}
          size={52}
          isGroup={chat.isGroupChat}
          style={{ borderRadius: 14 }}
          imageStyle={{ borderRadius: 14 }}
        />
        {chat.isOnline && presenceVisible && !chat.isGroupChat && (
          <View style={{ position: "absolute", bottom: -1, right: -1, width: 13, height: 13, borderRadius: 99, backgroundColor: "#22c55e", borderWidth: 2, borderColor: "#f8f7ff" }} />
        )}
      </View>

      {/* Details */}
      <View style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flexDirection: "row", alignItems: "center", flex: 1, minWidth: 0 }}>
            {chat.isPinned && <Pin size={11} color="#6c5ce7" style={{ marginRight: 4 }} />}
            <Text numberOfLines={1} style={{ fontSize: 15, fontFamily: chat.unreadCount > 0 ? "Poppins_700Bold" : "Poppins_600SemiBold", color: colors.text, flex: 1 }}>
              {chat.name}
            </Text>
          </View>
          <Text style={{ fontSize: 11.5, fontFamily: "Poppins_400Regular", color: colors.textSoft, marginLeft: 8, flexShrink: 0 }}>
            {chat.time}
          </Text>
        </View>

        <View style={{ marginTop: 3, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          {isTyping ? (
            <Text style={{ fontSize: 13, color: "#6c5ce7", fontFamily: "Poppins_600SemiBold" }}>
              {(getCachedNickname(isTyping.fromUserId) || isTyping.fromName) ? `${getCachedNickname(isTyping.fromUserId) || isTyping.fromName} is typing...` : 'typing...'}
            </Text>
          ) : draft ? (
            <Text numberOfLines={1} style={{ fontSize: 13, fontFamily: "Poppins_400Regular", color: colors.textSoft, flex: 1, paddingRight: 8 }}>
              <Text style={{ color: "#f4663b", fontFamily: "Poppins_600SemiBold" }}>Draft: </Text>
              {draft}
            </Text>
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center", flex: 1, minWidth: 0, paddingRight: 8 }}>
              {chat.status === "sent" && <Check size={13} color="rgba(0,0,0,0.25)" style={{ marginRight: 3 }} />}
              {chat.status === "delivered" && <CheckCheck size={13} color="rgba(0,0,0,0.25)" style={{ marginRight: 3 }} />}
              {chat.status === "read_other_all" && (
                readReceipts
                  ? <CheckCheck size={13} color="#34B7F1" style={{ marginRight: 3 }} />
                  : <CheckCheck size={13} color="rgba(0,0,0,0.25)" style={{ marginRight: 3 }} />
              )}
              {chat.isMuted && <BellOff size={12} color="rgba(0,0,0,0.2)" style={{ marginRight: 3 }} />}
              <Text
                numberOfLines={1}
                style={{
                  fontSize: 13,
                  fontFamily: chat.unreadCount > 0 ? "Poppins_600SemiBold" : "Poppins_400Regular",
                  color: chat.unreadCount > 0 ? colors.text : colors.textSoft,
                  flex: 1,
                }}
              >
                {(chat as any).latestFromMe && chat.latestMessage ? (
                  <Text style={{ fontFamily: "Poppins_600SemiBold" }}>You: </Text>
                ) : null}
                {chat.latestMessage || "Say hello! 👋"}
              </Text>
            </View>
          )}
          {chat.unreadCount > 0 && (
            <View style={{ width: 20, height: 20, borderRadius: 99, backgroundColor: "#f4663b", alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontSize: 10, fontFamily: "Poppins_700Bold", color: "#fff", lineHeight: 13 }}>
                {chat.unreadCount > 9 ? "9+" : chat.unreadCount}
              </Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

function ContactRow({
  contact,
  matchingChat,
  getInitials,
  isSelectionMode,
  isSelected,
  isTyping,
  onPress,
  onLongPress
}: {
  contact: Contact;
  matchingChat?: Chat | null;
  getInitials: (n: string) => string;
  isSelectionMode: boolean;
  isSelected: boolean;
  isTyping?: { fromUserId: string; fromUsername?: string; fromName?: string } | false | undefined;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const { colors } = useTheme();
  const unreadCount = matchingChat?.unreadCount || 0;
  // Reciprocity: hide others' presence if I've hidden my own.
  const { presenceVisible } = useViewerVisibility();

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      onLongPress={onLongPress}
      style={{ flexDirection: "row", alignItems: "center", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 2 }}
    >
      {isSelectionMode && (
        <View style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          borderWidth: 2,
          borderColor: isSelected ? colors.purple : colors.textSoft,
          backgroundColor: isSelected ? colors.purple : "transparent",
          alignItems: "center",
          justifyContent: "center",
          marginRight: 10,
          flexShrink: 0,
        }}>
          {isSelected && <Check size={12} color="#ffffff" />}
        </View>
      )}

      <View style={{ position: "relative", flexShrink: 0 }}>
        <Avatar
          url={contact.avatar}
          name={contact.name}
          size={52}
          isGroup={false}
          style={{ borderRadius: 14 }}
          imageStyle={{ borderRadius: 14 }}
        />
        {contact.isOnline && presenceVisible && (
          <View style={{ position: "absolute", bottom: -1, right: -1, width: 13, height: 13, borderRadius: 99, backgroundColor: "#22c55e", borderWidth: 2, borderColor: colors.bg }} />
        )}
      </View>

      <View style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text numberOfLines={1} style={{ fontSize: 15, fontFamily: matchingChat && unreadCount > 0 ? "Poppins_700Bold" : "Poppins_600SemiBold", color: colors.text, flex: 1 }}>
            {contact.name}
          </Text>
          {unreadCount > 0 && (
            <View style={{ width: 20, height: 20, borderRadius: 99, backgroundColor: "#f4663b", alignItems: "center", justifyContent: "center", marginLeft: 6 }}>
              <Text style={{ fontSize: 10, fontFamily: "Poppins_700Bold", color: "#fff", lineHeight: 13 }}>
                {unreadCount > 9 ? "9+" : unreadCount}
              </Text>
            </View>
          )}
        </View>
        {isTyping ? (
          <Text style={{ fontSize: 12, fontFamily: "Poppins_600SemiBold", color: colors.purple, marginTop: 2 }}>
            {(getCachedNickname(isTyping.fromUserId) || isTyping.fromName) ? `${getCachedNickname(isTyping.fromUserId) || isTyping.fromName} is typing...` : 'typing...'}
          </Text>
        ) : matchingChat?.latestMessage ? (
          <Text numberOfLines={1} style={{ fontSize: 13, fontFamily: unreadCount > 0 ? "Poppins_600SemiBold" : "Poppins_400Regular", color: unreadCount > 0 ? colors.text : colors.textSoft, marginTop: 2 }}>
            {matchingChat.latestMessage}
          </Text>
        ) : (
          <Text style={{ fontSize: 12, fontFamily: "Poppins_400Regular", color: colors.textSoft, fontStyle: "italic", marginTop: 2 }}>
            Not messaged yet • Tap to chat
          </Text>
        )}
      </View>

      <MessageSquarePlus size={16} color={colors.purple} style={{ opacity: 0.65, marginLeft: 8, flexShrink: 0 }} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  fabMenu: {
    position: "absolute",
    bottom: 96,
    right: 16,
    width: 175,
    backgroundColor: "#ffffff",
    borderRadius: 18,
    paddingVertical: 6,
    shadowColor: "#6c5ce7",
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
    borderWidth: 1,
    borderColor: "rgba(108,92,231,0.08)",
    zIndex: 100,
  },
  fabMenuItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  fabMenuText: {
    fontSize: 13,
    color: "#1f2030",
    fontFamily: "Poppins_500Medium",
  },
  divider: {
    height: 1,
    backgroundColor: "rgba(0,0,0,0.05)",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(31,32,48,0.4)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalContent: {
    width: "100%",
    maxWidth: 320,
    backgroundColor: "#ffffff",
    borderRadius: 24,
    padding: 20,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 17,
    fontFamily: "SpaceGrotesk_700Bold",
    color: "#1f2030",
  },
  inputLabel: {
    fontSize: 11,
    fontFamily: "Poppins_700Bold",
    color: "#9a9aab",
    textTransform: "uppercase",
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  textInput: {
    width: "100%",
    backgroundColor: "rgba(108,92,231,0.05)",
    borderWidth: 1,
    borderColor: "rgba(108,92,231,0.08)",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Poppins_400Regular",
    color: "#1f2030",
    marginBottom: 16,
  },
  catBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(108,92,231,0.15)",
    backgroundColor: "transparent",
  },
  catBtnText: {
    fontSize: 12,
    fontFamily: "Poppins_500Medium",
    color: "#9a9aab",
  },
  saveBtn: {
    backgroundColor: "#6c5ce7",
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 4,
  },
  saveBtnText: {
    color: "#ffffff",
    fontSize: 13,
    fontFamily: "Poppins_700Bold",
  },
});

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
  const { colors } = useTheme();
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
      <Text style={[{ fontSize: 13.5, color: colors.text, fontFamily: 'Poppins_500Medium', marginLeft: 10 }, labelStyle]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}
