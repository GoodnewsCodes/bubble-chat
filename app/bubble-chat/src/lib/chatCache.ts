import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchAllUserChats, fetchMessages, getMyContacts, getSecureMediaUrl, sendTextMessage } from './api';
import { authStorage } from './authStorage';
import { getCachedNickname } from './nicknames';
import { prepareChat, parseEnvelope, decryptEnvelope, ENCRYPTED_PLACEHOLDER } from './e2ee';

// Storage Keys
const KEYS = {
  CACHED_CHATS: 'bubble_cached_chats',
  CACHED_CONTACTS: 'bubble_cached_contacts',
  CACHED_FOLDERS: 'bubble_cached_folders',
  FOLDER_MAPPINGS: 'bubble_chat_folder_mappings',
  MESSAGES_PREFIX: 'bubble_cached_messages_',
  OFFLINE_QUEUE: 'bubble_offline_message_queue',
  DRAFTS: 'bubble_chat_drafts',
};

const DEFAULT_FOLDERS = ["All", "Unread", "Friends", "Work", "Archive"];

// Date format helpers
const formatChatTime = (dateInput: any): string => {
  const date = new Date(dateInput);
  if (isNaN(date.getTime())) return '';
  const now = new Date();
  
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  
  if (now.getTime() - date.getTime() < 7 * 24 * 60 * 60 * 1000) {
    return date.toLocaleDateString([], { weekday: 'short' });
  }
  
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const formatMessagePreciseTime = (dateInput: any): string => {
  const date = new Date(dateInput);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

// Collapse duplicate conversations so each renders once. Group chats dedupe by
// id; 1:1 chats dedupe by the other participant — this guards against parallel
// DM documents existing for the same user-pair (e.g. seeded twice). On collision
// the most recently updated row wins.
const dedupeChats = (rows: any[]): any[] => {
  const byKey = new Map<string, any>();
  for (const row of rows) {
    const key = !row.isGroupChat && row.otherUserId ? `dm:${row.otherUserId}` : `id:${row.id}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    const existingTs = new Date(existing.updatedAt || 0).getTime();
    const rowTs = new Date(row.updatedAt || 0).getTime();
    byKey.set(key, rowTs >= existingTs ? row : existing);
  }
  return Array.from(byKey.values());
};

// Keep one row per id, preserving the last occurrence.
const dedupeById = <T extends { id: string }>(rows: T[]): T[] =>
  Array.from(new Map(rows.map((r) => [r.id, r])).values());

let avatarMemoryCache: { [urlOrUserId: string]: string } = {};

export const chatCache = {
  // ─── Folders & Mappings ─────────────────────────────────────────────────────
  
  async getFolders(): Promise<string[]> {
    try {
      const raw = await AsyncStorage.getItem(KEYS.CACHED_FOLDERS);
      if (!raw) {
        await AsyncStorage.setItem(KEYS.CACHED_FOLDERS, JSON.stringify(DEFAULT_FOLDERS));
        return DEFAULT_FOLDERS;
      }
      return JSON.parse(raw);
    } catch {
      return DEFAULT_FOLDERS;
    }
  },

  async addFolder(name: string): Promise<string[]> {
    const folders = await this.getFolders();
    const clean = name.trim();
    if (clean && !folders.includes(clean)) {
      folders.push(clean);
      await AsyncStorage.setItem(KEYS.CACHED_FOLDERS, JSON.stringify(folders));
    }
    return folders;
  },

  async getFolderMappings(): Promise<{ [id: string]: string[] }> {
    try {
      const raw = await AsyncStorage.getItem(KEYS.FOLDER_MAPPINGS);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  },

  async moveChatToFolder(chatId: string, folderName: string): Promise<{ [id: string]: string[] }> {
    const mappings = await this.getFolderMappings();
    const folders = mappings[chatId] || [];
    
    if (folders.includes(folderName)) {
      mappings[chatId] = folders.filter(f => f !== folderName);
    } else {
      mappings[chatId] = [...folders, folderName];
    }
    
    await AsyncStorage.setItem(KEYS.FOLDER_MAPPINGS, JSON.stringify(mappings));
    return mappings;
  },

  // ─── Chats & Syncing ────────────────────────────────────────────────────────
  
  async getCachedChats(): Promise<any[]> {
    try {
      const raw = await AsyncStorage.getItem(KEYS.CACHED_CHATS);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  async syncChatsWithBackend(): Promise<any[]> {
    const user = await authStorage.getUser();
    if (!user) return [];
    const currentUserId = String(user.id || user._id);

    // Fetch from API
    const response = await fetchAllUserChats();
    const list = response?.conversations || [];
    
    // Map to UI Chat objects
    const mapped = await Promise.all(list.map(async (c: any) => {
      const isGroup = !!c.isGroupChat;
      const otherUser = !isGroup 
        ? c.users.find((u: any) => String(u.id || u._id) !== currentUserId) 
        : null;

      // Pin check
      const isPinned = Array.isArray(c.pinnedBy) && c.pinnedBy.some((id: any) => String(id) === currentUserId);
      const isMuted = Array.isArray(c.mutedBy) && c.mutedBy.some((id: any) => String(id) === currentUserId);
      const isArchived = Array.isArray(c.archivedBy) && c.archivedBy.some((id: any) => String(id) === currentUserId);

      // Latest Message Text — skip system/announcement messages for preview
      let latestText = null;
      let latestMessageTime = c.updatedAt;
      if (c.latestMessage) {
        const isSystem = c.latestMessage.message_type === 'system' || c.latestMessage.is_announcement;

        // ── NEW ──
        const isBotMsg = !!(
          c.latestMessage.senderIsBot ||
          c.latestMessage.sender?.is_bot ||
          c.latestMessage.sender?.username === 'aida'
        );

        if (!isSystem && !isBotMsg) {
          if (c.latestMessage.message_type === 'text') {
            latestText = c.latestMessage.content;
          } else {
            latestText = `📎 [${c.latestMessage.message_type || 'Media'}]`;
          }
          latestMessageTime = c.latestMessage.sentAt || c.latestMessage.createdAt;
        }
        // For groups, the latest message time might still reflect the last update even if system
        if (isGroup && !latestText) {
          latestMessageTime = c.updatedAt;
        }
      }

      // Check status — exclude system messages from unread count
      let status: 'read_own' | 'unread_other' | 'typing' | 'sent' | 'delivered' | 'read_other_all' = 'read_own';
      let latestFromMe = false;
      // unreadCount from backend may include system messages — we trust the backend's count
      // but filter it: if there's no real latestText, treat unread as 0
      const effectiveUnreadCount = (c.latestMessage?.message_type === 'system' || c.latestMessage?.is_announcement)
        ? 0
        : (c.unreadCount || 0);
      if (c.latestMessage && !(c.latestMessage.message_type === 'system' || c.latestMessage.is_announcement)) {
        const senderId = String(c.latestMessage.sender?.id || c.latestMessage.sender?._id || c.latestMessage.sender);
        if (senderId === currentUserId) {
          latestFromMe = true;
          // 3-state ticks: read (blue ✓✓) > delivered (gray ✓✓) > sent (gray ✓).
          status = c.latestMessage.isRead
            ? 'read_other_all'
            : (c.latestMessage.isDelivered ? 'delivered' : 'sent');
        } else {
          status = 'unread_other';
        }
      }

      return {
        id: String(c.id || c._id),
        name: isGroup
          ? (c.chatName || "Group Chat")
          : (getCachedNickname(String(otherUser?.id || otherUser?._id || '')) || otherUser?.full_name || otherUser?.username || "Unknown User"),
        realName: isGroup ? null : (otherUser?.full_name || otherUser?.username || "Unknown User"),
        avatar: isGroup ? (c.groupIcon || null) : (otherUser?.avatar || null),
        isGroupChat: isGroup,
        otherUserId: otherUser ? String(otherUser.id || otherUser._id) : null,
        latestMessage: latestText,
        time: formatChatTime(latestMessageTime || c.updatedAt),
        unreadCount: effectiveUnreadCount,
        isPinned: isPinned,
        // Muted (notifications off) and archived (hidden from main tabs) are
        // separate user actions — conflating them made the Archive tab show
        // muted chats and vice versa.
        isMuted: isMuted,
        isArchived: isArchived,
        isOnline: !isGroup && !!otherUser?.isOnline,
        is_bot: !isGroup && (!!otherUser?.is_bot || otherUser?.username === 'aida' || otherUser?.username?.toLowerCase() === 'aida'),
        username: !isGroup ? (otherUser?.username || "") : "",
        typingUser: null,
        status: status,
        latestFromMe,
        updatedAt: c.updatedAt,
        bio: isGroup ? (c.groupDescription || "Group Chat") : (otherUser?.bio || ""),
        email: otherUser?.email || "",
        phone: otherUser?.phone_number || "N/A",
        organization: otherUser?.organization || "",
        org_role: otherUser?.org_role || "",
        messages: [],
        // Preserve full group info for Info panel
        users: isGroup ? c.users : undefined,
        groupAdmin: isGroup ? c.groupAdmin : undefined,
        inviteCode: isGroup ? c.inviteCode : undefined,
        allowMembersToShareInvite: isGroup ? c.allowMembersToShareInvite : undefined,
        maxMembers: isGroup ? (c.maxMembers ?? 0) : undefined,
        transcriptPolicy: isGroup ? (c.transcriptPolicy || 'save') : undefined,
        resources: isGroup ? (c.resources || []) : undefined,
      };
    }));

    // Collapse any duplicate conversations (parallel DM docs / repeated rows)
    // before caching so each chat renders exactly once.
    const deduped = dedupeChats(mapped);

    // Cache mapped list
    await AsyncStorage.setItem(KEYS.CACHED_CHATS, JSON.stringify(deduped));
    return deduped;
  },

  // ─── Messages & Syncing ─────────────────────────────────────────────────────
  
  async getCachedMessages(chatId: string): Promise<any[]> {
    try {
      const raw = await AsyncStorage.getItem(KEYS.MESSAGES_PREFIX + chatId);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  async syncMessagesWithBackend(chatId: string): Promise<any[]> {
    const user = await authStorage.getUser();
    if (!user) return [];
    const currentUserId = String(user.id || user._id);

    const response = await fetchMessages(chatId);
    const list = Array.isArray(response) ? response : [];

    // Resolve E2EE state once per sync; failures degrade to lock placeholders.
    const hasEncrypted = list.some((m: any) => m.is_encrypted && m.content);
    const cipher = hasEncrypted
      ? await prepareChat(chatId, currentUserId).catch(() => null)
      : null;
    const decryptText = (m: any): string | null => {
      if (!m.is_encrypted || !m.content) return null;
      const env = parseEnvelope(m.content);
      const plain = env ? decryptEnvelope(chatId, env, cipher) : null;
      return plain ?? ENCRYPTED_PLACEHOLDER;
    };

    const mapped = list.map((m: any) => {
      const senderId = String(m.sender?.id || m.sender?._id || m.sender);
      const isMe = senderId === currentUserId;
      const isSystem = m.message_type === 'system' || m.is_announcement === true;

      return {
        id: String(m.id || m._id),
        text: decryptText(m) ?? (m.content || (m.mediaUrl ? `📎 [${m.message_type || 'Media'}]` : '')),
        is_encrypted: !!m.is_encrypted,
        sender: isMe ? 'me' : (isSystem ? 'system' : 'other'),
        senderName: m.sender ? (getCachedNickname(senderId) || m.sender?.full_name || m.sender?.username) : undefined,
        senderIsBot: m.senderIsBot || (m.sender && (m.sender.is_bot || m.sender.username === 'aida' || m.sender.username?.toLowerCase() === 'aida')),
        time: formatMessagePreciseTime(m.createdAt),
        timestamp: m.createdAt,
        reactions: Array.isArray(m.reactions) ? m.reactions.map((r: any) => r.emoji) : [],
        isPinned: !!m.is_pinned,
        isRead: !!m.isRead,
        isDelivered: !!m.isDelivered,
        mediaUrl: m.mediaUrl,
        message_type: m.message_type,
        media_metadata: m.media_metadata || null,
        transcript: m.transcript || null,
        parent_message: m.parent_message || null,
        is_announcement: m.is_announcement,
        isSystem,
        fileName: m.fileName,
        mimeType: m.mimeType,
      };
    });

    await AsyncStorage.setItem(KEYS.MESSAGES_PREFIX + chatId, JSON.stringify(mapped));
    return mapped;
  },

  // ─── Contacts Caching & Sync ──────────────────────────────────────────────────
  
  async getCachedContacts(): Promise<any[]> {
    try {
      const raw = await AsyncStorage.getItem(KEYS.CACHED_CONTACTS);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  async syncContactsWithBackend(): Promise<any[]> {
    const response = await getMyContacts();
    const list = response?.data || [];

    const mapped = list.map((u: any) => ({
      id: String(u.id || u._id),
      name: getCachedNickname(String(u.id || u._id)) || u.full_name || u.username || "Unknown",
      avatar: u.avatar || null,
      isOnline: !!u.isOnline,
      username: u.username || "",
      bio: u.bio || "",
      email: u.email || "",
      phone: u.phone_number || "N/A",
      organization: u.organization || "",
      org_role: u.org_role || "Collaborator",
      category: u.category || "work",
    }));

    // Drop duplicate contacts (same user returned more than once).
    const deduped = dedupeById(mapped);

    await AsyncStorage.setItem(KEYS.CACHED_CONTACTS, JSON.stringify(deduped));
    return deduped;
  },

  // ─── Per-chat message drafts ─────────────────────────────────────────────────
  // Unsent compose text survives navigation and app restarts. Stored plaintext
  // on-device only (never sent anywhere until the user hits send).

  async saveDraft(chatId: string, text: string): Promise<void> {
    try {
      const raw = await AsyncStorage.getItem(KEYS.DRAFTS);
      const drafts = raw ? JSON.parse(raw) : {};
      if (text && text.trim()) drafts[String(chatId)] = text;
      else delete drafts[String(chatId)];
      await AsyncStorage.setItem(KEYS.DRAFTS, JSON.stringify(drafts));
    } catch { /* drafts are best-effort */ }
  },

  async getDraft(chatId: string): Promise<string> {
    try {
      const raw = await AsyncStorage.getItem(KEYS.DRAFTS);
      const drafts = raw ? JSON.parse(raw) : {};
      return drafts[String(chatId)] || '';
    } catch { return ''; }
  },

  async getAllDrafts(): Promise<Record<string, string>> {
    try {
      const raw = await AsyncStorage.getItem(KEYS.DRAFTS);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  },

  async clearDraft(chatId: string): Promise<void> {
    return this.saveDraft(chatId, '');
  },

  // ─── Offline Queue ─────────────────────────────────────────────────────────
  async getOfflineQueue(): Promise<any[]> {
    try {
      const raw = await AsyncStorage.getItem(KEYS.OFFLINE_QUEUE);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  // clientId lets a queued retry be matched against an attempt that actually reached
  // the server (e.g. the response was lost to a network drop) — without it, the offline
  // queue would create a genuine duplicate message every time it had to retry.
  async addToOfflineQueue(chatId: string, text: string, clientId?: string, isEncrypted?: boolean): Promise<string> {
    const queue = await this.getOfflineQueue();
    const tempId = clientId || `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newItem = {
      id: tempId,
      chatId,
      text, // already ciphertext when isEncrypted — encrypted at compose time
      isEncrypted: !!isEncrypted,
      timestamp: new Date().toISOString(),
    };
    queue.push(newItem);
    await AsyncStorage.setItem(KEYS.OFFLINE_QUEUE, JSON.stringify(queue));
    return tempId;
  },

  async removeFromOfflineQueue(tempId: string): Promise<any[]> {
    const queue = await this.getOfflineQueue();
    const updated = queue.filter((item: any) => item.id !== tempId);
    await AsyncStorage.setItem(KEYS.OFFLINE_QUEUE, JSON.stringify(updated));
    return updated;
  },

  _isProcessingQueue: false,

  async processOfflineQueue(): Promise<void> {
    // syncChatAndMessages can fire from multiple triggers in quick succession (socket
    // reconnect, send-success, screen focus) — without this guard, two overlapping
    // calls would both read the same unprocessed item and send it twice.
    if (this._isProcessingQueue) return;
    this._isProcessingQueue = true;
    try {
      const queue = await this.getOfflineQueue();
      if (queue.length === 0) return;

      console.log(`Processing offline queue: ${queue.length} items`);
      for (const item of queue) {
        try {
          await sendTextMessage(item.chatId, item.text, { clientId: item.id, is_encrypted: !!item.isEncrypted });
          await this.removeFromOfflineQueue(item.id);
        } catch (err) {
          console.warn("Offline queue processing failed, stopping queue send:", err);
          break;
        }
      }
    } finally {
      this._isProcessingQueue = false;
    }
  },

  async saveMessageLocally(chatId: string, message: any): Promise<void> {
    const cached = await this.getCachedMessages(chatId);
    cached.push(message);
    await AsyncStorage.setItem(KEYS.MESSAGES_PREFIX + chatId, JSON.stringify(cached));

    try {
      const cachedChats = await this.getCachedChats();
      const updatedChats = cachedChats.map((c: any) => {
        if (String(c.id) === String(chatId)) {
          return {
            ...c,
            latestMessage: message.text,
            time: message.time || formatChatTime(message.timestamp),
            updatedAt: message.timestamp,
          };
        }
        return c;
      });
      await AsyncStorage.setItem(KEYS.CACHED_CHATS, JSON.stringify(updatedChats));
    } catch (err) {
      console.warn("Failed to update latest message in cached chats list:", err);
    }
  },

  async markChatReadLocally(chatId: string): Promise<void> {
    try {
      const cachedChats = await this.getCachedChats();
      const updatedChats = cachedChats.map((c: any) =>
        String(c.id) === String(chatId) ? { ...c, unreadCount: 0 } : c
      );
      await AsyncStorage.setItem(KEYS.CACHED_CHATS, JSON.stringify(updatedChats));
    } catch (err) {
      console.warn("Failed to zero unread count in cached chats list:", err);
    }
  },

  // Patches a single cached chat entry (e.g. after a group rename/icon change or a
  // `chat_updated` socket event) so chat-list / Work / All-chats reflect it without
  // a full backend resync. Accepts raw conversation fields (groupIcon/chatName) and
  // maps them onto the cached chat's UI shape (avatar/name).
  async patchCachedChat(chatId: string, patch: { groupIcon?: string | null; chatName?: string | null; groupDescription?: string | null }): Promise<void> {
    try {
      const cachedChats = await this.getCachedChats();
      const updatedChats = cachedChats.map((c: any) => {
        if (String(c.id) !== String(chatId)) return c;
        return {
          ...c,
          avatar: patch.groupIcon !== undefined ? (patch.groupIcon || null) : c.avatar,
          name: patch.chatName !== undefined && patch.chatName ? patch.chatName : c.name,
          bio: patch.groupDescription !== undefined ? (patch.groupDescription || c.bio) : c.bio,
        };
      });
      await AsyncStorage.setItem(KEYS.CACHED_CHATS, JSON.stringify(updatedChats));
    } catch (err) {
      console.warn("Failed to patch cached chat:", err);
    }
  },

  async performCloudBackup(): Promise<boolean> {
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      const keysToBackup = allKeys.filter(k => 
        k.startsWith('bubble_cached_') || 
        k.startsWith('bubble_chat_') ||
        k === 'bubble_auto_backup' ||
        k === 'bubble_last_backup_time'
      );
      if (keysToBackup.length === 0) return false;

      const keyValues = await AsyncStorage.multiGet(keysToBackup);
      const backupObj = {
        version: 1,
        timestamp: Date.now(),
        data: keyValues,
      };

      const { uploadCloudBackup } = await import('./api');
      await uploadCloudBackup(JSON.stringify(backupObj));
      return true;
    } catch (err) {
      console.error('Failed to perform cloud backup:', err);
      return false;
    }
  },

  async restoreCloudBackup(): Promise<boolean> {
    try {
      const { fetchCloudBackup } = await import('./api');
      const res = await fetchCloudBackup();
      const { backupData } = res?.data || {};
      if (!backupData) {
        console.log('No backup data found in cloud to restore.');
        return false;
      }

      const backupObj = JSON.parse(backupData);
      const keyValues = backupObj?.data;
      if (Array.isArray(keyValues) && keyValues.length > 0) {
        await AsyncStorage.multiSet(keyValues);
        console.log(`Successfully restored ${keyValues.length} cached keys from cloud backup!`);
        return true;
      }
      return false;
    } catch (err: any) {
      // 404 = no backup yet (fresh account). That's expected, not an error.
      if (err?.status === 404) {
        console.log('No cloud backup yet for this user — nothing to restore.');
        return false;
      }
      console.error('Failed to restore cloud backup:', err);
      return false;
    }
  },

  // ─── Avatar Caching ─────────────────────────────────────────────────────────
  async initAvatarCache(): Promise<void> {
    try {
      const raw = await AsyncStorage.getItem('bubble_cached_avatars');
      if (raw) {
        avatarMemoryCache = JSON.parse(raw);
      }
    } catch (err) {
      console.warn("Failed to initialize avatar cache:", err);
    }
  },

  async syncAvatarsWithBackend(): Promise<void> {
    try {
      const { getAllAvatars } = await import('./api');
      const response = await getAllAvatars();
      const list = response?.data || [];

      const newCache: { [urlOrUserId: string]: string } = {};
      for (const item of list) {
        if (item.base64Data) {
          if (item.imageUrl) {
            // Key by both the raw stored URL and its query-stripped form, since the
            // backend hands clients *signed* URLs (?X-Amz-…) that differ from the
            // unsigned URL stored here.
            newCache[item.imageUrl] = item.base64Data;
            newCache[item.imageUrl.split('?')[0]] = item.base64Data;
          }
          if (item.userId) {
            newCache[String(item.userId)] = item.base64Data;
          }
        }
      }

      avatarMemoryCache = newCache;
      await AsyncStorage.setItem('bubble_cached_avatars', JSON.stringify(newCache));
      console.log(`Synced ${list.length} avatars with backend.`);
    } catch (err) {
      console.warn("Failed to sync avatars with backend:", err);
    }
  },

  getCachedAvatar(urlOrUserId: string | null | undefined): string | null {
    if (!urlOrUserId) return null;
    const key = String(urlOrUserId);
    // Try the exact key (userId or full URL), then the query-stripped URL so that
    // a signed URL resolves to the same cached base64 as the unsigned stored URL.
    return avatarMemoryCache[key] || avatarMemoryCache[key.split('?')[0]] || null;
  }
};
