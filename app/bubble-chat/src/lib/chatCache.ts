// Cache lives in MMKV (synchronous, no async-bridge round-trip) via an
// AsyncStorage-compatible shim, so every existing `await AsyncStorage.x` call
// site keeps working while reads become far faster. See ./storage.
import { mmkvAsyncShim as AsyncStorage } from './storage';
import { fetchAllUserChats, fetchMessages, getContacts, getSecureMediaUrl, sendTextMessage, sendMediaMessage, addContact } from './api';
import { authStorage } from './authStorage';
import { getCachedNickname } from './nicknames';
import { isOnline } from './network';

// Storage Keys
const KEYS = {
  CACHED_CHATS: 'bubble_cached_chats',
  CACHED_CONTACTS: 'bubble_cached_contacts',
  CACHED_FOLDERS: 'bubble_cached_folders',
  FOLDER_MAPPINGS: 'bubble_chat_folder_mappings',
  MESSAGES_PREFIX: 'bubble_cached_messages_',
  OFFLINE_QUEUE: 'bubble_offline_message_queue',
  DRAFTS: 'bubble_chat_drafts',
  ORG_MEMBERS: 'bubble_cached_org_members',
  CALL_HISTORY: 'bubble_cached_call_history',
  PENDING_CONTACTS: 'bubble_chat_pending_contacts',
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
  // ─── Incremental-sync cursors ────────────────────────────────────────────────
  // Per-resource server timestamp of the last successful sync. Passing it back as
  // `?since=` fetches only what changed, so we stop refetching whole lists.
  //
  // Deliberately IN-MEMORY (not persisted): the first sync of each app launch has
  // no cursor and does a full fetch, which reconciles deletions/hides that may
  // have missed their realtime socket event; subsequent syncs in the same session
  // are incremental. This mirrors WhatsApp — full reconcile on open, deltas while
  // running — without a persisted cursor that could pin stale rows forever.
  _syncCursors: {} as Record<string, string>,
  async getSyncCursor(resource: string): Promise<string | undefined> {
    return this._syncCursors[resource] || undefined;
  },
  async setSyncCursor(resource: string, cursor: string): Promise<void> {
    this._syncCursors[resource] = cursor;
  },

  // ─── Generic JSON blob cache ─────────────────────────────────────────────────
  // Backing store for the Updates/Profile sections (tasks, meetings, calendar
  // events, org members, digest, profile, invite code, docs…). Keys must be
  // prefixed `bubble_cached_` so the MMKV migration + cloud backup pick them up.
  async getCachedJSON<T>(key: string, fallback: T): Promise<T> {
    try {
      const raw = await AsyncStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  },
  async setCachedJSON(key: string, value: any): Promise<void> {
    try { await AsyncStorage.setItem(key, JSON.stringify(value)); } catch { /* best-effort */ }
  },

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

    // Incremental fetch: pass the last cursor so the server returns only changed
    // conversations. First-ever sync has no cursor → full list.
    const cursor = await this.getSyncCursor('chats');
    const response = await fetchAllUserChats(cursor || undefined);
    const list = response?.conversations || [];

    // Map to UI Chat objects. Each row is mapped defensively: a single malformed
    // conversation (e.g. missing `users`) must never reject the whole sync, or the
    // list screen would throw away good data and fall back to the error banner.
    const mapped = (await Promise.all(list.map(async (c: any) => {
     try {
      const isGroup = !!c.isGroupChat;
      const participants = Array.isArray(c.users) ? c.users : [];
      const otherUser = !isGroup
        ? participants.find((u: any) => String(u.id || u._id) !== currentUserId)
        : null;

      // Pin check
      const isPinned = Array.isArray(c.pinnedBy) && c.pinnedBy.some((id: any) => String(id) === currentUserId);
      const isMuted = Array.isArray(c.mutedBy) && c.mutedBy.some((id: any) => String(id) === currentUserId);
      const isArchived = Array.isArray(c.archivedBy) && c.archivedBy.some((id: any) => String(id) === currentUserId);

      // Latest Message Text — skip system/announcement messages for preview
      let latestText = null;
      let latestMessageTime = c.updatedAt;
      if (c.latestMessage) {
        // A call log entry gets a WhatsApp-style preview ("📞 Voice call") even
        // though it's flagged is_announcement.
        const isCall = c.latestMessage.message_type === 'call';
        const isSystem = !isCall && (c.latestMessage.message_type === 'system' || c.latestMessage.is_announcement);

        // ── NEW ──
        const isBotMsg = !!(
          c.latestMessage.senderIsBot ||
          c.latestMessage.sender?.is_bot ||
          c.latestMessage.sender?.username === 'aida'
        );

        if (isCall) {
          const ct = c.latestMessage.call_metadata?.callType;
          latestText = `📞 ${ct === 'video' ? 'Video' : 'Voice'} call`;
          latestMessageTime = c.latestMessage.sentAt || c.latestMessage.createdAt;
        } else if (!isSystem && !isBotMsg) {
          if (c.latestMessage.message_type === 'text') {
            // E2EE removed — previews are plaintext, shown directly.
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
          : (getCachedNickname(String(otherUser?.id || otherUser?._id || '')) || otherUser?.full_name || otherUser?.username || otherUser?.email?.split('@')[0] || "Unknown User"),
        realName: isGroup ? null : (otherUser?.full_name || otherUser?.username || otherUser?.email?.split('@')[0] || "Unknown User"),
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
     } catch (err) {
      console.warn('Skipping malformed conversation during chat sync:', c?.id || c?._id, err);
      return null;
     }
    }))).filter(Boolean) as any[];

    // On an incremental response, merge the delta over the existing cache: put
    // fresh rows first so dedupeChats (which keeps the most-recently-updated row
    // per conversation) prefers them, while untouched cached rows are preserved.
    // A full response (no cursor) replaces the cache outright.
    const base = response?.incremental && cursor ? await this.getCachedChats() : [];
    const deduped = dedupeChats([...mapped, ...base]);

    // Cache mapped list + advance the cursor for the next incremental fetch.
    await AsyncStorage.setItem(KEYS.CACHED_CHATS, JSON.stringify(deduped));
    if (response?.syncedAt) await this.setSyncCursor('chats', response.syncedAt);
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

    // E2EE removed — all messages are plaintext and render directly from content.
    const mapped = list.map((m: any) => {
      const senderId = String(m.sender?.id || m.sender?._id || m.sender);
      const isMe = senderId === currentUserId;
      // A 'call' entry is centered like a system row but keeps sender attribution
      // so the client can show outgoing/incoming direction — so it's NOT lumped in
      // with generic system messages.
      const isCall = m.message_type === 'call';
      const isSystem = !isCall && (m.message_type === 'system' || m.is_announcement === true);

      return {
        id: String(m.id || m._id),
        text: m.content || (m.mediaUrl ? `📎 [${m.message_type || 'Media'}]` : ''),
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
        call_metadata: m.call_metadata || null,
        isCall,
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
    // Rich roster: org colleagues + explicit contacts (self and bots excluded
    // server-side), matching the web chat list. The narrow /contacts/my endpoint
    // returned only manually-added contacts, so a user who reached people via the
    // org directory saw an empty Messages screen ("No conversations yet").
    const response = await getContacts();
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

  // ─── Workroom (org directory) cache ──────────────────────────────────────────
  // Offline-first: show the cached org roster instantly, then a background fetch
  // reconciles. Revisiting the People screen never blanks on a network call.
  async getCachedOrgMembers(): Promise<any[]> {
    try {
      const raw = await AsyncStorage.getItem(KEYS.ORG_MEMBERS);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  },
  async setCachedOrgMembers(list: any[]): Promise<void> {
    try { await AsyncStorage.setItem(KEYS.ORG_MEMBERS, JSON.stringify(list || [])); } catch { /* best-effort */ }
  },

  // ─── Call history cache ──────────────────────────────────────────────────────
  // History (call logs + past meetings) is cached so it paints instantly on
  // revisit; a background refresh then merges the latest entries.
  async getCachedCallHistory(): Promise<{ logs: any[]; meetings: any[] }> {
    try {
      const raw = await AsyncStorage.getItem(KEYS.CALL_HISTORY);
      return raw ? JSON.parse(raw) : { logs: [], meetings: [] };
    } catch { return { logs: [], meetings: [] }; }
  },
  async setCachedCallHistory(data: { logs: any[]; meetings: any[] }): Promise<void> {
    try { await AsyncStorage.setItem(KEYS.CALL_HISTORY, JSON.stringify(data || { logs: [], meetings: [] })); } catch { /* best-effort */ }
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
  // Outbound messages composed while offline (or when a send fails) are persisted
  // here and flushed, strictly in order, once connectivity returns — so "queued
  // messages send first" like WhatsApp. Items carry a `clientId` so a retry that
  // actually reached the server (lost response) is de-duped by the backend's
  // unique (chat, sender, client_id) index instead of creating a duplicate.
  //
  // Item shape (persisted):
  //   { id, chatId, type: 'text'|'media', timestamp, retryCount?, nextRetryAt?,
  //     text?, isEncrypted?, parentMessageId?,           // text
  //     file?: {uri,name,type,size}, content?, messageType?, mediaDuration? }  // media
  async getOfflineQueue(): Promise<any[]> {
    try {
      const raw = await AsyncStorage.getItem(KEYS.OFFLINE_QUEUE);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  async addToOfflineQueue(chatId: string, text: string, clientId?: string, isEncrypted?: boolean, parentMessageId?: string): Promise<string> {
    const queue = await this.getOfflineQueue();
    const tempId = clientId || `temp-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    queue.push({
      id: tempId,
      chatId,
      type: 'text',
      text, // already ciphertext when isEncrypted — encrypted at compose time
      isEncrypted: !!isEncrypted,
      parentMessageId: parentMessageId || undefined,
      timestamp: new Date().toISOString(),
      retryCount: 0,
    });
    await AsyncStorage.setItem(KEYS.OFFLINE_QUEUE, JSON.stringify(queue));
    return tempId;
  },

  // Queue a media/voice message. The local file `uri` is persisted and re-sent on
  // flush, so a photo/voice note composed offline uploads once the network returns.
  async addMediaToOfflineQueue(
    chatId: string,
    file: { uri: string; name?: string; type?: string; size?: number },
    opts?: { clientId?: string; content?: string; messageType?: string; mediaDuration?: number; parentMessageId?: string },
  ): Promise<string> {
    const queue = await this.getOfflineQueue();
    const tempId = opts?.clientId || `temp-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    queue.push({
      id: tempId,
      chatId,
      type: 'media',
      file,
      content: opts?.content || '',
      messageType: opts?.messageType,
      mediaDuration: opts?.mediaDuration,
      parentMessageId: opts?.parentMessageId || undefined,
      timestamp: new Date().toISOString(),
      retryCount: 0,
    });
    await AsyncStorage.setItem(KEYS.OFFLINE_QUEUE, JSON.stringify(queue));
    return tempId;
  },

  async removeFromOfflineQueue(tempId: string): Promise<any[]> {
    const queue = await this.getOfflineQueue();
    const updated = queue.filter((item: any) => item.id !== tempId);
    await AsyncStorage.setItem(KEYS.OFFLINE_QUEUE, JSON.stringify(updated));
    return updated;
  },

  // Persist a per-item retry increment + next-attempt time without disturbing order.
  async _patchQueueItem(tempId: string, patch: { retryCount?: number; nextRetryAt?: number }): Promise<void> {
    const queue = await this.getOfflineQueue();
    const updated = queue.map((it: any) => (it.id === tempId ? { ...it, ...patch } : it));
    await AsyncStorage.setItem(KEYS.OFFLINE_QUEUE, JSON.stringify(updated));
  },

  _isProcessingQueue: false,
  _retryTimer: null as ReturnType<typeof setTimeout> | null,
  _MAX_QUEUE_RETRIES: 8,

  // Send one queued item. Text and media take their own API path; both pass the
  // item id as clientId so the backend de-dupes lost-response retries.
  async _sendQueueItem(item: any): Promise<void> {
    if (item.type === 'media' && item.file?.uri) {
      const fileObj = { uri: item.file.uri, name: item.file.name, type: item.file.type, size: item.file.size } as any;
      await sendMediaMessage(item.chatId, fileObj, {
        clientId: item.id,
        content: item.content,
        message_type: item.messageType,
        media_duration: item.mediaDuration,
        ...(item.parentMessageId && { parent_message: item.parentMessageId }),
      });
    } else {
      await sendTextMessage(item.chatId, item.text, {
        clientId: item.id,
        is_encrypted: !!item.isEncrypted,
        ...(item.parentMessageId && { parent_message: item.parentMessageId }),
      });
    }
  },

  async processOfflineQueue(): Promise<void> {
    // Multiple triggers (socket reconnect, NetInfo reconnect, send-success, screen
    // focus, app foreground) can fire in quick succession — this guard stops two
    // overlapping passes from both grabbing the same item and sending it twice.
    if (this._isProcessingQueue) return;
    // Don't burn through retry budget while offline — a reconnect re-triggers us.
    if (!isOnline()) return;
    this._isProcessingQueue = true;
    try {
      const queue = await this.getOfflineQueue();
      if (queue.length === 0) return;

      const now = Date.now();
      console.log(`Processing offline queue: ${queue.length} item(s)`);
      // Strict FIFO: process from the head. If the head item is still backing off,
      // stop the whole pass (preserves order + "queued sends first"); a scheduled
      // timer or the next trigger resumes it.
      for (const item of queue) {
        if (item.nextRetryAt && item.nextRetryAt > now) break;
        try {
          await this._sendQueueItem(item);
          await this.removeFromOfflineQueue(item.id);
        } catch (err) {
          const retryCount = (item.retryCount || 0) + 1;
          if (retryCount > this._MAX_QUEUE_RETRIES) {
            // Give up on a persistently failing item (e.g. deleted chat) so it can't
            // block every message behind it forever.
            console.warn(`Dropping queued message after ${retryCount} failed attempts:`, item.id, err);
            await this.removeFromOfflineQueue(item.id);
            continue;
          }
          // Exponential backoff with jitter (2s → 60s cap), then stop the pass.
          const delay = Math.min(60000, 2000 * 2 ** (retryCount - 1)) * (0.75 + Math.random() * 0.5);
          await this._patchQueueItem(item.id, { retryCount, nextRetryAt: now + delay });
          console.warn(`Offline queue send failed (attempt ${retryCount}), backing off ${Math.round(delay)}ms:`, err);
          break;
        }
      }
    } finally {
      this._isProcessingQueue = false;
      await this._scheduleQueueRetry();
    }
  },

  // Arm a single timer for the head item's next attempt so backoff resumes on its
  // own. Processing is strict FIFO, so only the head governs the next wake. No
  // timer is armed while offline — `onReconnect` re-triggers processing instead,
  // which also avoids a tight loop of offline attempts.
  async _scheduleQueueRetry(): Promise<void> {
    try {
      if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
      if (!isOnline()) return;
      const queue = await this.getOfflineQueue();
      if (queue.length === 0) return;
      const now = Date.now();
      const head = queue[0];
      // Clamp to 1s..60s: never a 0ms tight loop, never sleep too long.
      const wait = Math.max(1000, Math.min((head.nextRetryAt || now) - now, 60000));
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        this.processOfflineQueue().catch(() => {});
      }, wait);
    } catch { /* best-effort scheduling */ }
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
  async patchCachedChat(chatId: string, patch: { groupIcon?: string | null; chatName?: string | null; groupDescription?: string | null; resources?: any[] }): Promise<void> {
    try {
      const cachedChats = await this.getCachedChats();
      const updatedChats = cachedChats.map((c: any) => {
        if (String(c.id) !== String(chatId)) return c;
        return {
          ...c,
          avatar: patch.groupIcon !== undefined ? (patch.groupIcon || null) : c.avatar,
          name: patch.chatName !== undefined && patch.chatName ? patch.chatName : c.name,
          bio: patch.groupDescription !== undefined ? (patch.groupDescription || c.bio) : c.bio,
          resources: patch.resources !== undefined ? patch.resources : c.resources,
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

  // ─── Pending contact adds (offline QR scan / add-by-tag) ─────────────────────
  // Adding a contact hits the server, so a scan/add done offline is parked here
  // and completed on reconnect — the user isn't blocked mid-flow.
  async queuePendingContact(identifier: string): Promise<void> {
    try {
      const id = String(identifier || '').trim();
      if (!id) return;
      const raw = await AsyncStorage.getItem(KEYS.PENDING_CONTACTS);
      const list: string[] = raw ? JSON.parse(raw) : [];
      if (!list.includes(id)) list.push(id);
      await AsyncStorage.setItem(KEYS.PENDING_CONTACTS, JSON.stringify(list));
    } catch { /* best-effort */ }
  },

  async processPendingContacts(): Promise<void> {
    if (!isOnline()) return;
    let list: string[] = [];
    try {
      const raw = await AsyncStorage.getItem(KEYS.PENDING_CONTACTS);
      list = raw ? JSON.parse(raw) : [];
    } catch { return; }
    if (list.length === 0) return;
    const remaining: string[] = [];
    for (const identifier of list) {
      try {
        await addContact(identifier);
      } catch (err) {
        // Keep it only if the failure looks transient (network); a 4xx (bad tag /
        // already a contact) shouldn't be retried forever.
        const status = (err as any)?.status;
        if (!status || status >= 500) remaining.push(identifier);
        else console.warn('Dropping un-addable pending contact:', identifier, err);
      }
    }
    try {
      if (remaining.length) await AsyncStorage.setItem(KEYS.PENDING_CONTACTS, JSON.stringify(remaining));
      else await AsyncStorage.removeItem(KEYS.PENDING_CONTACTS);
    } catch { /* best-effort */ }
    // Refresh the roster so the newly-added contacts appear.
    if (remaining.length !== list.length) {
      try { await this.syncContactsWithBackend(); } catch { /* non-fatal */ }
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
