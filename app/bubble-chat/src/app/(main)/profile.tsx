import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Modal, TextInput, Alert, Clipboard, Switch, Platform } from 'react-native';
import { Image } from 'expo-image';
import { User, Pencil, Mail, Phone, Briefcase, X, Check, LogOut, Copy, Share, ChevronLeft, Plus, Moon, Sun, Smartphone, FileText, Upload, Trash2, BrainCircuit } from 'lucide-react-native';
import { useTheme, Scheme } from '../../lib/theme';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { fetchOrgDocs, fetchOrgDoc, createOrgDoc, updateOrgDoc, deleteOrgDoc, ingestOrgFile, brainIngestUrl } from '../../lib/api';
import { Avatar } from '../../components/Avatar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRouter } from 'expo-router';
import { subscribeToPlusButton } from '../../lib/mockData';
import Svg, { Text as SvgText, Defs, LinearGradient, Stop } from 'react-native-svg';
import { authStorage } from '../../lib/authStorage';

import { getMyProfile, updateProfile, getSecureMediaUrl } from '../../lib/api';

const AVATARS = [
  "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=150&auto=format&fit=crop",
];

const PURPLE = '#6c5ce7';

function getInitials(name: string) {
  if (!name) return 'UC';
  return name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
}

function getGroupInitials(name: string) {
  if (!name) return 'UC';
  const clean = name.trim().replace(/\s+/g, ' ');
  const parts = clean.split(' ');
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

// A single org-member row — themed, shows name + handle/profile info + role badge.
// Reused in the inline (top-3) directory and the "View all" modal.
function OrgMemberRow({ member }: { member: any }) {
  const { colors } = useTheme();
  const handle = member.username
    ? `@${member.username}`
    : member.uniqueTag
      ? member.uniqueTag
      : member.email || '';
  const role = member.org_role || member.department || (member.role === 'admin' ? 'Admin' : 'Member');
  return (
    <View
      className="flex-row items-center p-3 rounded-2xl"
      style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong }}
    >
      <Avatar
        url={member.avatar}
        userId={member.id || member._id}
        name={member.full_name || member.username || 'Member'}
        size={38}
        style={{ borderRadius: 11 }}
        imageStyle={{ borderRadius: 11 }}
      />
      <View className="ml-3 flex-1 min-w-0">
        <Text className="text-[13px] font-bold font-sans" numberOfLines={1} style={{ color: colors.text }}>
          {member.full_name || member.username || 'Member'}
        </Text>
        {!!handle && (
          <Text className="text-[10.5px] font-sans" numberOfLines={1} style={{ color: colors.textSoft }}>
            {handle}{member.email && handle !== member.email ? ` · ${member.email}` : ''}
          </Text>
        )}
      </View>
      <View className="px-2 py-0.5 rounded-lg ml-2" style={{ backgroundColor: colors.purpleSoft }}>
        <Text className="font-bold text-[9px] uppercase font-sans" style={{ color: colors.purple }}>{role}</Text>
      </View>
    </View>
  );
}

// ── Org Knowledge Base manager (the files/docs that build the company brain) ──
// Lives inside Edit Organization; admins can view, edit, delete and upload the
// documents that feed AIda's brain.
function OrgKnowledgeBase({ active, isAdmin }: { active: boolean; isAdmin: boolean }) {
  const { colors } = useTheme();
  const [docs, setDocs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [ingestUrl, setIngestUrl] = useState('');
  const [newDoc, setNewDoc] = useState({ title: '', content: '' });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDoc, setEditDoc] = useState({ title: '', content: '' });

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetchOrgDocs({ page: 1 });
      setDocs(res?.docs || []);
    } catch (e: any) {
      // keep silent — empty state will show
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (active) load();
  }, [active]);

  const handleCreate = async () => {
    if (!newDoc.title.trim() || !newDoc.content.trim()) {
      Alert.alert('Add document', 'Give the entry a title and some content.');
      return;
    }
    setBusy(true);
    try {
      await createOrgDoc({ title: newDoc.title.trim(), content: newDoc.content.trim() });
      setNewDoc({ title: '', content: '' });
      setShowNew(false);
      await load();
      Alert.alert('Added', 'Entry added to your knowledge base. AIda is indexing it now.');
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to add the document.');
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'text/plain', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/*'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      setBusy(true);
      await ingestOrgFile({ uri: asset.uri, name: asset.name, type: asset.mimeType || 'application/octet-stream' }, asset.name);
      Alert.alert('Uploading', `"${asset.name}" is being processed into the brain. It'll appear here once indexed.`);
      // Give the async job a moment, then refresh.
      setTimeout(load, 2500);
    } catch (e: any) {
      Alert.alert('Upload failed', e.message || 'Could not upload the file.');
    } finally {
      setBusy(false);
    }
  };

  const startEdit = async (doc: any) => {
    setEditingId(doc._id);
    setEditDoc({ title: doc.title || '', content: '' });
    try {
      const res = await getOrgDocSafe(doc._id);
      setEditDoc({ title: res?.title || doc.title || '', content: res?.content || '' });
    } catch {}
  };

  const getOrgDocSafe = async (id: string) => {
    const res = await fetchOrgDoc(id);
    return res?.doc;
  };

  const handleSaveEdit = async (id: string) => {
    setBusy(true);
    try {
      await updateOrgDoc(id, { title: editDoc.title.trim(), content: editDoc.content.trim() });
      setEditingId(null);
      await load();
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to save changes.');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = (doc: any) => {
    Alert.alert('Remove document', `Remove "${doc.title}" from the knowledge base?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          setBusy(true);
          try {
            await deleteOrgDoc(doc._id);
            await load();
          } catch (e: any) {
            Alert.alert('Error', e.message || 'Failed to remove the document.');
          } finally {
            setBusy(false);
          }
        }
      },
    ]);
  };

  return (
    <View className="rounded-3xl p-5 mb-8" style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border }}>
      <View className="flex-row items-center justify-between mb-1">
        <View className="flex-row items-center" style={{ gap: 8 }}>
          <BrainCircuit color={colors.purple} size={18} />
          <Text className="text-[15px] font-bold" style={{ color: colors.text }}>Knowledge Base</Text>
        </View>
        <Text className="text-[11px] font-bold" style={{ color: colors.textSoft }}>{docs.length}</Text>
      </View>
      <Text className="text-[11px] mb-3" style={{ color: colors.textSoft }}>
        The documents AIda uses to answer questions about {`your org`}. {isAdmin ? 'Add, edit or remove them.' : 'Viewable by your team.'}
      </Text>

      {/* Actions */}
      {isAdmin && (
        <View className="flex-row" style={{ gap: 8, marginBottom: 12 }}>
          <TouchableOpacity
            onPress={handleUpload}
            disabled={busy}
            className="flex-1 flex-row items-center justify-center rounded-xl py-2.5"
            style={{ backgroundColor: colors.purpleSoft, borderWidth: 1, borderColor: colors.border, gap: 6, opacity: busy ? 0.6 : 1 }}
          >
            <Upload color={colors.purple} size={15} />
            <Text className="text-[12px] font-bold" style={{ color: colors.purple }}>Upload file</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setShowNew((v) => !v)}
            className="flex-1 flex-row items-center justify-center rounded-xl py-2.5"
            style={{ backgroundColor: colors.purple, gap: 6 }}
          >
            <Plus color="#fff" size={15} />
            <Text className="text-[12px] font-bold text-white">New entry</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* URL / YouTube ingestion — parity with web onboarding's link imports */}
      {isAdmin && (
        <View className="flex-row items-center rounded-xl mb-3" style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, paddingLeft: 12, paddingRight: 6, paddingVertical: 4, gap: 6 }}>
          <TextInput
            value={ingestUrl}
            onChangeText={setIngestUrl}
            placeholder="Paste a web page or YouTube link…"
            placeholderTextColor={colors.textSoft}
            autoCapitalize="none"
            keyboardType="url"
            style={{ flex: 1, fontSize: 12, fontFamily: 'Poppins_400Regular', color: colors.text, paddingVertical: 6 }}
          />
          <TouchableOpacity
            disabled={busy || !ingestUrl.trim()}
            onPress={async () => {
              const url = ingestUrl.trim();
              if (!/^https?:\/\//i.test(url)) { Alert.alert('Add link', 'Enter a full URL starting with http(s)://'); return; }
              setBusy(true);
              try {
                await brainIngestUrl(url);
                setIngestUrl('');
                Alert.alert('Importing', 'The link is being processed into the brain. It will appear once indexed.');
                setTimeout(load, 2500);
              } catch (e: any) {
                Alert.alert('Import failed', e?.message || 'Could not import that link.');
              } finally {
                setBusy(false);
              }
            }}
            className="rounded-lg px-3 py-2"
            style={{ backgroundColor: colors.purple, opacity: busy || !ingestUrl.trim() ? 0.5 : 1 }}
          >
            <Text className="text-[11px] font-bold text-white">Import</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* New entry form */}
      {showNew && isAdmin && (
        <View className="rounded-2xl p-3 mb-3" style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: 8 }}>
          <TextInput
            value={newDoc.title}
            onChangeText={(t) => setNewDoc({ ...newDoc, title: t })}
            placeholder="Title (e.g. Refund Policy)"
            placeholderTextColor={colors.textSoft}
            style={{ backgroundColor: colors.card, borderRadius: 12, padding: 12, color: colors.text, borderWidth: 1, borderColor: colors.border }}
          />
          <TextInput
            value={newDoc.content}
            onChangeText={(t) => setNewDoc({ ...newDoc, content: t })}
            placeholder="Paste or write the knowledge content…"
            placeholderTextColor={colors.textSoft}
            multiline
            textAlignVertical="top"
            style={{ backgroundColor: colors.card, borderRadius: 12, padding: 12, color: colors.text, borderWidth: 1, borderColor: colors.border, minHeight: 90 }}
          />
          <TouchableOpacity onPress={handleCreate} disabled={busy} className="rounded-xl py-3 items-center" style={{ backgroundColor: colors.purple, opacity: busy ? 0.6 : 1 }}>
            <Text className="text-white font-bold text-[12px]">{busy ? 'Saving…' : 'Add to knowledge base'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Doc list */}
      {loading ? (
        <Text className="text-[12px] italic" style={{ color: colors.textSoft }}>Loading…</Text>
      ) : docs.length === 0 ? (
        <View className="items-center py-6 rounded-2xl" style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}>
          <FileText color={colors.textSoft} size={24} />
          <Text className="text-[12px] mt-2 font-semibold" style={{ color: colors.text }}>No documents yet</Text>
          <Text className="text-[10.5px] mt-0.5" style={{ color: colors.textSoft }}>{isAdmin ? 'Upload a file or add an entry to teach AIda.' : 'Your admins haven\'t added any yet.'}</Text>
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          {docs.map((doc) => (
            <View key={String(doc._id)} className="rounded-2xl p-3" style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}>
              {editingId === doc._id ? (
                <View style={{ gap: 8 }}>
                  <TextInput
                    value={editDoc.title}
                    onChangeText={(t) => setEditDoc({ ...editDoc, title: t })}
                    placeholder="Title"
                    placeholderTextColor={colors.textSoft}
                    style={{ backgroundColor: colors.card, borderRadius: 12, padding: 10, color: colors.text, borderWidth: 1, borderColor: colors.border }}
                  />
                  <TextInput
                    value={editDoc.content}
                    onChangeText={(t) => setEditDoc({ ...editDoc, content: t })}
                    placeholder="Content"
                    placeholderTextColor={colors.textSoft}
                    multiline
                    textAlignVertical="top"
                    style={{ backgroundColor: colors.card, borderRadius: 12, padding: 10, color: colors.text, borderWidth: 1, borderColor: colors.border, minHeight: 100 }}
                  />
                  <View className="flex-row" style={{ gap: 8 }}>
                    <TouchableOpacity onPress={() => setEditingId(null)} className="flex-1 rounded-xl py-2.5 items-center" style={{ borderWidth: 1, borderColor: colors.border }}>
                      <Text className="text-[12px] font-bold" style={{ color: colors.textSoft }}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => handleSaveEdit(doc._id)} disabled={busy} className="flex-1 rounded-xl py-2.5 items-center" style={{ backgroundColor: colors.purple, opacity: busy ? 0.6 : 1 }}>
                      <Text className="text-[12px] font-bold text-white">{busy ? 'Saving…' : 'Save'}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <View className="flex-row items-center">
                  <FileText color={colors.purple} size={16} />
                  <View className="flex-1 min-w-0 ml-2.5">
                    <Text className="text-[13px] font-bold" numberOfLines={1} style={{ color: colors.text }}>{doc.title}</Text>
                    <Text className="text-[10px]" numberOfLines={1} style={{ color: colors.textSoft }}>
                      {(doc.department || 'general')}{doc.tags?.length ? ` · ${doc.tags.slice(0, 3).join(', ')}` : ''}
                    </Text>
                  </View>
                  {isAdmin && (
                    <View className="flex-row" style={{ gap: 6 }}>
                      <TouchableOpacity onPress={() => startEdit(doc)} className="w-8 h-8 rounded-lg items-center justify-center" style={{ backgroundColor: colors.purpleSoft }}>
                        <Pencil color={colors.purple} size={13} />
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => handleDelete(doc)} className="w-8 h-8 rounded-lg items-center justify-center" style={{ backgroundColor: 'rgba(239,68,68,0.12)' }}>
                        <Trash2 color="#ef4444" size={13} />
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              )}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

export default function ProfileScreen() {
  const router = useRouter();
  const { colors, scheme, setScheme, isDark } = useTheme();
  const [isEditing, setIsEditing] = useState(false);
  const [isAvatarModalOpen, setIsAvatarModalOpen] = useState(false);
  const [isQrModalOpen, setIsQrModalOpen] = useState(false);
  const [copiedText, setCopiedText] = useState(false);

  // Organization settings states
  const [orgData, setOrgData] = useState<{
    name: string;
    inviteCode: string;
    logo: string;
    description: string;
    allowMembersToShareInvite: boolean;
    emailTranscriptsToMembers: boolean;
    isAdmin?: boolean;
  } | null>(null);
  const [isEditingOrg, setIsEditingOrg] = useState(false);
  const [orgFormData, setOrgFormData] = useState({
    name: '',
    description: '',
    logo: '',
    allowMembersToShareInvite: true,
    emailTranscriptsToMembers: true,
  });
  const [activeOrgTab, setActiveOrgTab] = useState<'info' | 'people' | 'transcripts'>('info');
  const [orgMembers, setOrgMembers] = useState<any[]>([]);
  const [orgTranscripts, setOrgTranscripts] = useState<any[]>([]);
  const [expandedTranscriptId, setExpandedTranscriptId] = useState<string | null>(null);
  const [showAllMembers, setShowAllMembers] = useState(false);
  const [orgDefaultChat, setOrgDefaultChat] = useState<{ id: string; transcriptPolicy: 'email' | 'save' | 'off'; isAdmin: boolean } | null>(null);

  const [user, setUser] = useState({
    full_name: 'John Doe',
    username: 'johndoe123',
    org_role: 'Lead Developer',
    organization: 'Bubble',
    bio: 'Passionate about building scalable mobile experiences.',
    email: 'john.doe@example.com',
    phone_number: '+1 234 567 8900',
    chatsCount: 0,
    filesCount: 0,
    avatar: '',
    uniqueTag: '',
    role: '',
  });

  const [inviteCodeInput, setInviteCodeInput] = useState("");
  const [isJoiningOrg, setIsJoiningOrg] = useState(false);
  const [groupCodeInput, setGroupCodeInput] = useState("");
  const [isJoiningGroup, setIsJoiningGroup] = useState(false);

  const handleJoinGroup = async () => {
    const code = groupCodeInput.trim();
    if (!code) {
      Alert.alert("Error", "Please enter a group code.");
      return;
    }
    setIsJoiningGroup(true);
    try {
      const { joinGroupChat } = await import('../../lib/api');
      const res = await joinGroupChat(code);
      const chat = res?.conversation || res?.data?.conversation || res?.data || res;
      const { chatCache } = await import('../../lib/chatCache');
      await chatCache.syncChatsWithBackend();
      setGroupCodeInput("");
      const id = chat?.id || chat?._id;
      Alert.alert("Success", res?.message || "Joined group!");
      if (id) router.push(`/chat/${id}` as any);
    } catch (err: any) {
      Alert.alert("Error", err.message || "Could not join group. Check the code and try again.");
    } finally {
      setIsJoiningGroup(false);
    }
  };

  const handleJoinOrg = async () => {
    if (!inviteCodeInput.trim()) {
      Alert.alert("Error", "Please enter an invite code.");
      return;
    }
    setIsJoiningOrg(true);
    try {
      const { joinOrganizationByInvite } = await import('../../lib/api');
      const res = await joinOrganizationByInvite(inviteCodeInput.trim());
      if (res && res.organization) {
        Alert.alert("Success", `Successfully joined ${res.organization.name}!`);
        
        // Refresh local user state
        const updatedUser = {
          ...user,
          organization: res.organization.name,
          role: 'employee',
          org_role: 'Collaborator',
        };
        setUser(updatedUser);
        setFormData(updatedUser);
        await authStorage.updateUser(updatedUser);

        // Fetch organization settings/details
        const { getOrgInviteCode } = await import('../../lib/api');
        const orgRes = await getOrgInviteCode();
        if (orgRes) {
          setOrgData(orgRes);
          setOrgFormData({
            name: orgRes.name || '',
            description: orgRes.description || '',
            logo: orgRes.logo || '',
            allowMembersToShareInvite: orgRes.allowMembersToShareInvite ?? true,
            emailTranscriptsToMembers: orgRes.emailTranscriptsToMembers ?? true,
          });
        }
        
        // Sync local chat caches
        const { chatCache } = await import('../../lib/chatCache');
        await chatCache.syncChatsWithBackend();
        await chatCache.syncContactsWithBackend();

        setInviteCodeInput("");
      }
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to join organization.");
    } finally {
      setIsJoiningOrg(false);
    }
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

  const [formData, setFormData] = useState({ ...user });

  useEffect(() => {
    if (!isFocused) return;

    async function loadUser() {
      try {
        let currentOrg = '';
        const stored = await authStorage.getUser();
        if (stored) {
          const mapped = {
            ...user,
            ...stored,
            email: stored.email || user.email,
            phone_number: stored.phone_number || user.phone_number,
            full_name: stored.full_name || user.full_name,
            username: stored.username || user.username,
            bio: stored.bio || user.bio,
            org_role: stored.org_role || user.org_role,
            organization: stored.organization || user.organization,
            uniqueTag: stored.uniqueTag || user.uniqueTag,
            role: stored.role || user.role,
          };
          setUser(mapped);
          setFormData(mapped);
          currentOrg = stored.organization || '';
        }
        
        const fresh = await getMyProfile();
        if (fresh?.data) {
          const u = fresh.data;
          await authStorage.updateUser(u);
          const mappedFresh = {
            ...user,
            ...u,
            email: u.email || user.email,
            phone_number: u.phone_number || user.phone_number,
            full_name: u.full_name || user.full_name,
            username: u.username || user.username,
            bio: u.bio || user.bio,
            org_role: u.org_role || user.org_role,
            organization: u.organization || user.organization,
            chatsCount: u.chatsCount ?? user.chatsCount,
            filesCount: u.filesCount ?? user.filesCount,
            uniqueTag: u.uniqueTag || user.uniqueTag,
            role: u.role || user.role,
          };
          setUser(mappedFresh);
          setFormData(mappedFresh);
          currentOrg = u.organization || '';
        }

        if (currentOrg) {
          const { getOrgInviteCode, getOrgMembers, getOrgTranscripts } = await import('../../lib/api');
          const orgRes = await getOrgInviteCode();
          if (orgRes) {
            setOrgData(orgRes);
            setOrgFormData({
              name: orgRes.name || '',
              description: orgRes.description || '',
              logo: orgRes.logo || '',
              allowMembersToShareInvite: orgRes.allowMembersToShareInvite ?? true,
              emailTranscriptsToMembers: orgRes.emailTranscriptsToMembers ?? true,
            });
          }
          try {
            const membersRes = await getOrgMembers();
            if (membersRes?.members) {
              setOrgMembers(membersRes.members);
            }
            const transcriptsRes = await getOrgTranscripts();
            if (transcriptsRes?.transcripts) {
              setOrgTranscripts(transcriptsRes.transcripts);
            }
            const { fetchAllUserChats } = await import('../../lib/api');
            const me = await authStorage.getUser();
            const chatsRes = await fetchAllUserChats();
            const chatsList: any[] = Array.isArray(chatsRes) ? chatsRes : (chatsRes?.chats || []);
            // Prefer the explicit flag (requires the newer backend); fall back to heuristics so
            // this still works against an older/production backend that doesn't expose
            // `isDefaultOrgChat` yet: the org-wide chat is a group chat named after the org and
            // is normally the group with the most members.
            const orgName = (orgRes?.name || '').trim().toLowerCase();
            const groupChats = chatsList.filter((c: any) => c.isGroupChat);
            const defaultChat =
              chatsList.find((c: any) => c.isDefaultOrgChat) ||
              (orgName
                ? groupChats.find((c: any) => String(c.name || c.chatName || '').trim().toLowerCase() === orgName)
                : undefined) ||
              groupChats
                .slice()
                .sort((a: any, b: any) => (b.users?.length || 0) - (a.users?.length || 0))[0];
            if (defaultChat) {
              setOrgDefaultChat({
                id: defaultChat.id,
                transcriptPolicy: defaultChat.transcriptPolicy || 'save',
                isAdmin: !!(me?.id && defaultChat.groupAdmin && String(defaultChat.groupAdmin.id || defaultChat.groupAdmin._id || defaultChat.groupAdmin) === String(me.id)),
              });
            }
          } catch (orgErr) {
            console.warn("Failed to fetch organization details:", orgErr);
          }
        }
      } catch (e) {
        console.warn("Failed to load user profile in ProfileScreen:", e);
      }
    }
    loadUser();

    const unsubscribePlus = subscribeToPlusButton(() => {
      setIsEditing(true);
    });

    return () => {
      unsubscribePlus();
    };
  }, [isFocused]);

  const handleSave = async () => {
    try {
      const res = await updateProfile({
        full_name: formData.full_name.trim(),
        username: formData.username.trim().toLowerCase(),
        bio: formData.bio.trim(),
        email: formData.email.trim().toLowerCase(),
        phone_number: formData.phone_number.trim(),
        org_role: ((formData as any).org_role || '').trim(),
        actionItemEmailMode: (formData as any).actionItemEmailMode || 'each',
        app_background: (formData as any).app_background || undefined,
      });
      if (res?.data) {
        const u = res.data;
        await authStorage.updateUser(u);
        const updatedUser = {
          ...user,
          ...u,
          full_name: u.full_name || user.full_name,
          username: u.username || user.username,
          bio: u.bio || user.bio,
          email: u.email || user.email,
          phone_number: u.phone_number || user.phone_number,
          org_role: u.org_role || user.org_role,
          app_background: u.app_background || (user as any).app_background,
        };
        setUser(updatedUser);
      }
      setIsEditing(false);
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to update profile.");
    }
  };

  const handlePressAvatar = () => {
    Alert.alert(
      "Profile Image",
      "Would you like to change or remove your profile image?",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove Image", style: "destructive", onPress: handleRemoveAvatar },
        { text: "Change Image", onPress: () => setIsAvatarModalOpen(true) },
      ]
    );
  };

  const handleRemoveAvatar = async () => {
    try {
      const res = await updateProfile({ avatar: "" });
      if (res?.data) {
        await authStorage.updateUser(res.data);
        setUser(prev => ({ ...prev, avatar: "" }));
      } else {
        setUser(prev => ({ ...prev, avatar: "" }));
      }
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to remove profile image.");
    }
  };

  const handlePickFromGallery = async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'We need access to your gallery to upload a profile picture.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const uri = result.assets[0].uri;
        setIsAvatarModalOpen(false);
        const { uploadAvatar } = await import('../../lib/api');
        const res = await uploadAvatar(uri);
        if (res?.data) {
          const u = res.data.user;
          if (u) {
            await authStorage.updateUser(u);
            setUser(prev => ({ ...prev, avatar: u.avatar }));
          } else {
            setUser(prev => ({ ...prev, avatar: res.data.avatarUrl }));
          }
          Alert.alert("Success", "Profile picture updated successfully!");
          
          // Also sync avatar cache
          const { chatCache } = await import('../../lib/chatCache');
          await chatCache.syncAvatarsWithBackend();
        }
      }
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to upload profile picture.");
    }
  };

  const handleSelectAvatar = async (url: string) => {
    try {
      const res = await updateProfile({ avatar: url });
      if (res?.data) {
        const u = res.data;
        await authStorage.updateUser(u);
        setUser(prev => ({ ...prev, avatar: u.avatar }));
      } else {
        setUser(prev => ({ ...prev, avatar: url }));
      }
      setIsAvatarModalOpen(false);
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to update profile image.");
    }
  };

  const handleLogout = () => {
    Alert.alert(
      'Log Out',
      'Are you sure you want to log out?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Log Out',
          style: 'destructive',
          onPress: async () => {
            await authStorage.clearSession();
            router.replace('/login' as any);
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView className="flex-1" edges={['top']} style={{ backgroundColor: colors.bg }}>
      <View className="flex-row items-center justify-between px-6 pt-5 pb-3 border-b" style={{ borderColor: colors.border }}>
        <View>
          <Svg height="36" width="140">
            <Defs>
              <LinearGradient id="profileGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <Stop offset="0%" stopColor="#6c5ce7" />
                <Stop offset="100%" stopColor="rgba(108,92,231,0.6)" />
              </LinearGradient>
            </Defs>
            <SvgText
              fill="url(#profileGrad)"
              fontSize="26"
              fontFamily="SpaceGrotesk_700Bold"
              x="0"
              y="26"
              letterSpacing="-0.5"
            >
              Profile
            </SvgText>
          </Svg>
          <Text className="text-xs font-sans mt-0.5" style={{ color: colors.textSoft }}>Manage your account</Text>
        </View>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 180 }} showsVerticalScrollIndicator={false}>
        <View className="w-full" style={{ backgroundColor: colors.bg }}>
          {/* Hero Card */}
          <View className="items-center w-full p-6 border-b" style={{ backgroundColor: colors.card, borderColor: colors.border }}>
            <TouchableOpacity
              onPress={handlePressAvatar}
              activeOpacity={0.8}
              style={{
                width: 96,
                height: 96,
                borderRadius: 28,
                backgroundColor: user.avatar ? 'rgba(108,92,231,0.1)' : '#000000',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 16,
                shadowColor: '#6c5ce7',
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.1,
                shadowRadius: 8,
                elevation: 3,
                overflow: 'hidden',
                borderWidth: 1.5,
                borderColor: 'rgba(108,92,231,0.2)',
              }}
            >
              <Avatar
                url={user.avatar}
                userId={(user as any).id || (user as any)._id}
                name={user.organization || user.full_name}
                size={96}
                isGroup={!!user.organization}
                style={{ borderRadius: 28 }}
                imageStyle={{ borderRadius: 28 }}
              />
            </TouchableOpacity>
            <Text className="text-[22px] font-bold leading-tight font-sans" style={{ color: colors.text }}>{user.full_name}</Text>
            <Text className="text-[14px] font-bold mt-1.5 font-sans" style={{ color: colors.purple }}>@{user.username}</Text>
            <Text className="text-[14px] font-semibold mt-1.5 font-sans" style={{ color: colors.textSoft }}>{user.org_role}</Text>
            <Text className="text-[14px] text-center mt-4 leading-relaxed max-w-sm font-sans" style={{ color: colors.textSoft }}>{user.bio}</Text>

            {/* Stats row */}
            <View className="flex-row w-full items-center justify-around rounded-2xl shadow-sm py-4 mt-6 max-w-sm border" style={{ backgroundColor: colors.card, borderColor: colors.border }}>
              <View className="items-center px-6">
                <Text className="text-[20px] font-bold font-sans" style={{ color: colors.purple }}>{user.chatsCount}</Text>
                <Text className="text-[10px] font-semibold uppercase tracking-wider mt-0.5 font-sans" style={{ color: colors.textSoft }}>Chats</Text>
              </View>
              <View className="items-center px-6 border-l" style={{ borderColor: colors.border }}>
                <Text className="text-[20px] font-bold font-sans" style={{ color: colors.purple }}>{user.filesCount}</Text>
                <Text className="text-[10px] font-semibold uppercase tracking-wider mt-0.5 font-sans" style={{ color: colors.textSoft }}>Files</Text>
              </View>
            </View>

            {/* Buttons Row */}
            <View className="flex-row gap-3 mt-6 w-full max-w-sm justify-center">
              <TouchableOpacity
                onPress={() => setIsEditing(true)}
                className="flex-1 flex-row items-center justify-center rounded-2xl bg-purple py-3 shadow-lg shadow-purple/20"
              >
                <Pencil color="#fff" size={14} />
                <Text className="text-white text-[14px] font-bold ml-2 font-sans">Edit profile</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setIsQrModalOpen(true)}
                className="flex-1 flex-row items-center justify-center rounded-2xl bg-purple py-3 shadow-lg shadow-purple/20"
              >
                <Share color="#fff" size={14} />
                <Text className="text-white text-[14px] font-bold ml-2 font-sans">Share Info</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Contact Details Card */}
          <View className="w-full p-6 border-b" style={{ backgroundColor: colors.card, borderColor: colors.border }}>
            <Text className="text-[15px] font-bold border-b pb-3 mb-5 font-sans" style={{ color: colors.text, borderColor: colors.borderStrong }}>
              Contact details
            </Text>

            <View className="space-y-4">
              <View className="flex-row items-center p-4 rounded-2xl border mb-3" style={{ backgroundColor: colors.purpleSoft, borderColor: colors.border }}>
                <Mail color={colors.purple} size={20} />
                <View className="ml-3 flex-1">
                  <Text className="text-[10px] font-bold uppercase tracking-wider font-sans" style={{ color: colors.textSoft }}>Email</Text>
                  <Text className="text-sm font-semibold mt-0.5 font-sans" style={{ color: colors.text }}>{user.email}</Text>
                </View>
              </View>

              <View className="flex-row items-center p-4 rounded-2xl border mb-3" style={{ backgroundColor: colors.purpleSoft, borderColor: colors.border }}>
                <Phone color={colors.purple} size={20} />
                <View className="ml-3 flex-1">
                  <Text className="text-[10px] font-bold uppercase tracking-wider font-sans" style={{ color: colors.textSoft }}>Phone</Text>
                  <Text className="text-sm font-semibold mt-0.5 font-sans" style={{ color: colors.text }}>{user.phone_number}</Text>
                </View>
              </View>

              {user.organization && (
                <View className="flex-row items-center p-4 rounded-2xl border" style={{ backgroundColor: colors.purpleSoft, borderColor: colors.border }}>
                  <Briefcase color={colors.purple} size={20} />
                  <View className="ml-3 flex-1">
                    <Text className="text-[10px] font-bold uppercase tracking-wider font-sans" style={{ color: colors.textSoft }}>Organization</Text>
                    <Text className="text-sm font-semibold mt-0.5 font-sans" style={{ color: colors.text }}>{user.organization} ({user.org_role})</Text>
                  </View>
                </View>
              )}
            </View>
          </View>

          {/* Organization Settings Card */}
          {user.organization && orgData && (orgData.isAdmin || orgData.allowMembersToShareInvite) && (
            <View className="bg-white dark:bg-[#1a1b28] w-full p-6 border-b border-black/5 dark:border-white/10 mt-3">
              <View className="flex-row justify-between items-center border-b border-black/10 dark:border-white/20 pb-3 mb-4">
                <Text className="text-[15px] font-bold text-ink dark:text-[#f4f5fb] font-sans">
                  Organization Settings
                </Text>
                {orgData.isAdmin && (
                  <TouchableOpacity onPress={() => setIsEditingOrg(true)} className="bg-purple/10 px-3 py-1 rounded-xl">
                    <Text className="text-purple text-[12px] font-bold font-sans">Edit Settings</Text>
                  </TouchableOpacity>
                )}
              </View>

              {/* Organization Info Hero */}
              <View className="bg-purple-soft/10 p-4 rounded-2xl border border-black/5 dark:border-white/10 mb-3 flex-row items-center">
                <Avatar
                  url={orgData.logo}
                  name={orgData.name}
                  size={50}
                  isGroup={true}
                  style={{ borderRadius: 16 }}
                  imageStyle={{ borderRadius: 16 }}
                />
                <View className="ml-3 flex-1">
                  <Text className="text-sm font-bold text-ink dark:text-[#f4f5fb] font-sans">{orgData.name}</Text>
                  <Text className="text-xs text-ink-soft dark:text-[#9a9bb6] mt-0.5 font-sans" numberOfLines={2}>
                    {orgData.description || 'No description set'}
                  </Text>
                </View>
              </View>

              {orgData.isAdmin ? (
                <>
                  {/* Tab Switcher */}
                  <View className="flex-row border-b border-black/5 dark:border-white/10 mb-4 mt-2">
                    <TouchableOpacity
                      onPress={() => setActiveOrgTab('info')}
                      className={`mr-4 pb-2 border-b-2 ${activeOrgTab === 'info' ? 'border-purple' : 'border-transparent'}`}
                    >
                      <Text className={`text-[12.5px] font-bold ${activeOrgTab === 'info' ? 'text-purple' : 'text-ink-soft dark:text-[#9a9bb6]'}`}>General</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => setActiveOrgTab('people')}
                      className={`mr-4 pb-2 border-b-2 ${activeOrgTab === 'people' ? 'border-purple' : 'border-transparent'}`}
                    >
                      <Text className={`text-[12.5px] font-bold ${activeOrgTab === 'people' ? 'text-purple' : 'text-ink-soft dark:text-[#9a9bb6]'}`}>People</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => setActiveOrgTab('transcripts')}
                      className={`pb-2 border-b-2 ${activeOrgTab === 'transcripts' ? 'border-purple' : 'border-transparent'}`}
                    >
                      <Text className={`text-[12.5px] font-bold ${activeOrgTab === 'transcripts' ? 'text-purple' : 'text-ink-soft dark:text-[#9a9bb6]'}`}>Transcripts</Text>
                    </TouchableOpacity>
                  </View>

                  {/* General Tab */}
                  {activeOrgTab === 'info' && (
                    <View style={{ gap: 10 }}>
                      {orgData.inviteCode ? (
                        <View className="flex-row items-center justify-between bg-purple-soft/10 p-4 rounded-2xl border border-black/5 dark:border-white/10">
                          <View className="flex-1 pr-3">
                            <Text className="text-[13px] font-bold text-ink dark:text-[#f4f5fb] font-sans">Invite Code</Text>
                            <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] mt-0.5 font-sans leading-tight">Share with employees to let them join</Text>
                          </View>
                          <TouchableOpacity
                            onPress={() => {
                              Clipboard.setString(orgData.inviteCode);
                              Alert.alert("Copied", "Organization invite code copied to clipboard!");
                            }}
                            className="bg-white dark:bg-[#1a1b28] px-3 py-1.5 rounded-xl border border-black/5 dark:border-white/10 flex-row items-center"
                          >
                            <Copy color="#6c5ce7" size={12} style={{ marginRight: 4 }} />
                            <Text className="text-purple font-mono font-bold text-[11px]">
                              {orgData.inviteCode.slice(0, 6)}...{orgData.inviteCode.slice(-4)}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      ) : (
                        <View className="bg-red-50/50 p-4 rounded-2xl border border-red-100/30">
                          <Text className="text-[12px] font-bold text-red-500 font-sans">Invite Code Hidden</Text>
                          <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] mt-0.5 font-sans leading-tight">Your administrator has disabled invite code sharing for members.</Text>
                        </View>
                      )}

                      <View className="flex-row items-center justify-between bg-purple-soft/10 p-4 rounded-2xl border border-black/5 dark:border-white/10">
                        <View className="flex-1 pr-2">
                          <Text className="text-[13px] font-bold text-ink dark:text-[#f4f5fb] font-sans">Allow members to share code</Text>
                          <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] mt-0.5 font-sans leading-tight">If disabled, only admins can view/share the organization code</Text>
                        </View>
                        <Switch
                          value={orgData.allowMembersToShareInvite}
                          onValueChange={async (val) => {
                            try {
                              const { updateOrgProfile } = await import('../../lib/api');
                              const res = await updateOrgProfile({ allowMembersToShareInvite: val });
                              if (res) {
                                setOrgData(prev => prev ? { ...prev, allowMembersToShareInvite: val } : null);
                                setOrgFormData(prev => ({ ...prev, allowMembersToShareInvite: val }));
                              }
                            } catch (e: any) {
                              Alert.alert("Error", e.message || "Failed to update sharing settings.");
                            }
                          }}
                          trackColor={{ false: "#e2e8f0", true: "#6c5ce7" }}
                          thumbColor={Platform.OS === 'ios' ? undefined : orgData.allowMembersToShareInvite ? "#6c5ce7" : "#f4f3f4"}
                        />
                      </View>
                    </View>
                  )}

                  {/* People Tab */}
                  {activeOrgTab === 'people' && (
                    <View style={{ gap: 10 }}>
                      <View className="flex-row items-center justify-between mb-1">
                        <Text className="text-[10px] font-bold uppercase tracking-wider" style={{ color: colors.textSoft }}>Employee Directory ({orgMembers.length})</Text>
                        {orgMembers.length > 3 && (
                          <TouchableOpacity onPress={() => setShowAllMembers(true)} className="px-2 py-0.5 rounded-lg" style={{ backgroundColor: colors.purpleSoft }}>
                            <Text className="text-[10px] font-bold uppercase" style={{ color: colors.purple }}>View all</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                      {orgMembers.length === 0 ? (
                        <Text className="text-xs italic font-sans" style={{ color: colors.textSoft }}>No members found</Text>
                      ) : (
                        orgMembers.slice(0, 3).map((member) => (
                          <OrgMemberRow key={String(member.id || member._id || member.username)} member={member} />
                        ))
                      )}
                    </View>
                  )}

                  {/* Transcripts Tab */}
                  {activeOrgTab === 'transcripts' && (
                    <View style={{ gap: 10 }}>
                      {orgDefaultChat && (
                        <View style={{ backgroundColor: colors.card, borderRadius: 18, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 6 }}>
                          <Text style={{ fontSize: 13, fontFamily: 'Poppins_700Bold', color: colors.text }}>Send transcripts to members?</Text>
                          <Text style={{ fontSize: 10.5, fontFamily: 'Poppins_400Regular', color: colors.textSoft, marginTop: 2, marginBottom: 10 }}>
                            {orgDefaultChat.isAdmin
                              ? 'Controls whether company-wide meeting transcripts are emailed to participants.'
                              : 'Only the org admin can change this. Current setting:'}
                          </Text>
                          <View style={{ flexDirection: 'row', gap: 6 }}>
                            {([
                              { key: 'email', label: 'Email members' },
                              { key: 'save', label: 'Save only' },
                              { key: 'off', label: 'Off' },
                            ] as const).map((opt) => {
                              const active = orgDefaultChat.transcriptPolicy === opt.key;
                              const canEdit = !!(orgDefaultChat.isAdmin || orgData?.isAdmin);
                              return (
                                <TouchableOpacity
                                  key={opt.key}
                                  disabled={!canEdit}
                                  onPress={async () => {
                                    if (!canEdit) return;
                                    try {
                                      const { updateGroupSettings } = await import('../../lib/api');
                                      const res = await updateGroupSettings(orgDefaultChat.id, { transcriptPolicy: opt.key });
                                      if (res?.conversation) {
                                        setOrgDefaultChat(prev => prev ? { ...prev, transcriptPolicy: opt.key } : prev);
                                      }
                                    } catch (e: any) {
                                      Alert.alert("Error", e.message || "Failed to update transcript setting.");
                                    }
                                  }}
                                  style={{
                                    flex: 1,
                                    alignItems: 'center',
                                    paddingVertical: 9,
                                    borderRadius: 12,
                                    backgroundColor: active ? colors.purple : colors.purpleSoft,
                                    opacity: !canEdit && !active ? 0.5 : 1,
                                  }}
                                >
                                  <Text style={{ fontSize: 10.5, fontFamily: 'Poppins_700Bold', color: active ? '#fff' : colors.purple }}>{opt.label}</Text>
                                </TouchableOpacity>
                              );
                            })}
                          </View>
                        </View>
                      )}
                      <Text className="text-[10px] font-bold text-ink-soft dark:text-[#9a9bb6] uppercase tracking-wider mb-1">Meeting History ({orgTranscripts.length})</Text>
                      {orgTranscripts.length === 0 ? (
                        <Text className="text-xs text-ink-soft dark:text-[#9a9bb6] italic font-sans">No meeting history found</Text>
                      ) : (
                        orgTranscripts.map(meeting => {
                          const isExpanded = expandedTranscriptId === meeting.roomId;
                          return (
                            <View key={meeting.roomId} className="bg-purple-soft/5 rounded-2xl border border-black/5 dark:border-white/10 overflow-hidden">
                              <TouchableOpacity
                                onPress={() => setExpandedTranscriptId(isExpanded ? null : meeting.roomId)}
                                className="p-4 flex-row items-center justify-between"
                              >
                                <View className="flex-1 pr-2">
                                  <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] font-sans">{meeting.title || 'Untitled Meeting'}</Text>
                                  <Text className="text-[10.5px] text-ink-soft dark:text-[#9a9bb6] font-sans mt-0.5">
                                    Hosted by {meeting.host?.name || 'Unknown'} · {new Date(meeting.timing || Date.now()).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                                  </Text>
                                </View>
                                <ChevronLeft size={16} color="#6c5ce7" style={{ transform: [{ rotate: isExpanded ? '-90deg' : '0deg' }] }} />
                              </TouchableOpacity>

                              {isExpanded && (
                                <View className="px-4 pb-4 border-t border-black/5 dark:border-white/10 pt-3" style={{ gap: 12 }}>
                                  <View className="flex-row items-center justify-between">
                                    <Text className="text-[10.5px] text-ink-soft dark:text-[#9a9bb6] font-sans">Duration: {Math.ceil((meeting.duration || 0) / 60)} mins</Text>
                                    <Text className="text-[10.5px] text-ink-soft dark:text-[#9a9bb6] font-sans">Type: {meeting.type || 'Voice'}</Text>
                                  </View>

                                  {meeting.summary ? (
                                    <View className="bg-purple-soft/10 p-3 rounded-xl border border-purple/5">
                                      <Text className="text-[11px] font-bold text-purple uppercase mb-1">Detailed Intelligence</Text>
                                      <Text className="text-[11.5px] text-ink dark:text-[#f4f5fb] font-sans leading-relaxed">{meeting.summary}</Text>
                                    </View>
                                  ) : null}

                                  {meeting.actionItems && meeting.actionItems.length > 0 ? (
                                    <View>
                                      <Text className="text-[11px] font-bold text-purple uppercase mb-1">Action Items</Text>
                                      <View style={{ gap: 4 }} className="mt-1">
                                        {meeting.actionItems.map((item: string, idx: number) => (
                                          <View key={idx} className="flex-row items-start gap-1">
                                            <Text className="text-[11.5px] text-ink dark:text-[#f4f5fb]">•</Text>
                                            <Text className="text-[11.5px] text-ink dark:text-[#f4f5fb] font-sans flex-1">{item}</Text>
                                          </View>
                                        ))}
                                      </View>
                                    </View>
                                  ) : null}

                                  {meeting.rawTranscript ? (
                                    <View>
                                      <Text className="text-[11px] font-bold text-ink-soft dark:text-[#9a9bb6] uppercase mb-1">Raw Transcript</Text>
                                      <ScrollView style={{ maxHeight: 100 }} nestedScrollEnabled className="bg-black/5 dark:bg-white/[0.06] p-2.5 rounded-xl border border-black/5 dark:border-white/10">
                                        <Text className="text-[10px] text-ink-soft dark:text-[#9a9bb6] font-mono leading-relaxed">{meeting.rawTranscript}</Text>
                                      </ScrollView>
                                    </View>
                                  ) : null}
                                </View>
                              )}
                            </View>
                          );
                        })
                      )}
                    </View>
                  )}
                </>
              ) : (
                /* Non-admin view: ONLY show invite code card if allowMembersToShareInvite is true */
                orgData.allowMembersToShareInvite && orgData.inviteCode && (
                  <View className="flex-row items-center justify-between bg-purple-soft/10 p-4 rounded-2xl border border-black/5 dark:border-white/10 mt-2">
                    <View className="flex-1 pr-3">
                      <Text className="text-[13px] font-bold text-ink dark:text-[#f4f5fb] font-sans">Invite Code</Text>
                      <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] mt-0.5 font-sans leading-tight">Share with employees to let them join</Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => {
                        Clipboard.setString(orgData.inviteCode);
                        Alert.alert("Copied", "Organization invite code copied to clipboard!");
                      }}
                      className="bg-white dark:bg-[#1a1b28] px-3 py-1.5 rounded-xl border border-black/5 dark:border-white/10 flex-row items-center"
                    >
                      <Copy color="#6c5ce7" size={12} style={{ marginRight: 4 }} />
                      <Text className="text-purple font-mono font-bold text-[11px]">
                        {orgData.inviteCode}
                      </Text>
                    </TouchableOpacity>
                  </View>
                )
              )}
            </View>
          )}

          {/* Join Organization Card */}
          {!user.organization && (
            <View className="bg-white dark:bg-[#1a1b28] w-full p-6 border-b border-black/5 dark:border-white/10 mt-3">
              <Text className="text-[15px] font-bold text-ink dark:text-[#f4f5fb] border-b border-black/10 dark:border-white/20 pb-3 mb-5 font-sans">
                Join Organization
              </Text>
              
              <View className="bg-purple-soft/10 p-4 rounded-2xl border border-black/5 dark:border-white/10">
                <Text className="text-[13px] font-bold text-ink dark:text-[#f4f5fb] font-sans mb-0.5">Have an Organization Code?</Text>
                <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] mb-2.5 font-sans leading-tight">
                  Enter code to access workspace resources and chats
                </Text>
                
                <View className="flex-row gap-2.5 items-center">
                  <TextInput
                    placeholder="Enter Invite Code"
                    value={inviteCodeInput}
                    onChangeText={setInviteCodeInput}
                    placeholderTextColor="#9a9aab"
                    className="flex-1 bg-white dark:bg-[#1a1b28] border border-black/5 dark:border-white/10 h-11 px-3.5 rounded-xl text-ink dark:text-[#f4f5fb] font-sans text-sm"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <TouchableOpacity
                    onPress={handleJoinOrg}
                    disabled={isJoiningOrg}
                    className="bg-purple h-11 px-4 rounded-xl items-center justify-center shadow-xs"
                  >
                    <Text className="text-white text-xs font-bold font-sans">
                      {isJoiningOrg ? 'Joining...' : 'Join'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}

          {/* Join a Group Card */}
          <View className="bg-white dark:bg-[#1a1b28] w-full p-6 border-b border-black/5 dark:border-white/10 mt-3">
            <Text className="text-[15px] font-bold text-ink dark:text-[#f4f5fb] border-b border-black/10 dark:border-white/20 pb-3 mb-5 font-sans">
              Join a Group
            </Text>

            <View className="bg-purple-soft/10 p-4 rounded-2xl border border-black/5 dark:border-white/10">
              <Text className="text-[13px] font-bold text-ink dark:text-[#f4f5fb] font-sans mb-0.5">Have a group code?</Text>
              <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] mb-2.5 font-sans leading-tight">
                Paste a group invite code or link to join the conversation.
              </Text>

              <View className="flex-row gap-2.5 items-center">
                <TextInput
                  placeholder="e.g. grp-1a2b3c4d5e6f"
                  value={groupCodeInput}
                  onChangeText={setGroupCodeInput}
                  placeholderTextColor="#9a9aab"
                  className="flex-1 bg-white dark:bg-[#1a1b28] border border-black/5 dark:border-white/10 h-11 px-3.5 rounded-xl text-ink dark:text-[#f4f5fb] font-sans text-sm"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity
                  onPress={handleJoinGroup}
                  disabled={isJoiningGroup}
                  className="bg-purple h-11 px-4 rounded-xl items-center justify-center shadow-xs"
                >
                  <Text className="text-white text-xs font-bold font-sans">
                    {isJoiningGroup ? 'Joining...' : 'Join'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>

          {/* Action-Item Email Notifications — visible card (also editable in Edit Profile). */}
          <View className="w-full p-6 border-b mt-3" style={{ backgroundColor: colors.card, borderColor: colors.border }}>
            <View className="flex-row items-center border-b pb-3 mb-4" style={{ borderColor: colors.borderStrong }}>
              <Mail color={colors.purple} size={18} />
              <Text className="text-[15px] font-bold ml-2 font-sans" style={{ color: colors.text }}>Action-Item Emails</Text>
            </View>
            <Text className="text-[12px] mb-4 font-sans" style={{ color: colors.textSoft }}>
              Choose how BubbleSpace emails you about meeting action items assigned to you.
            </Text>
            <View style={{ gap: 8 }}>
              {([
                { value: 'each', label: 'Each item', desc: 'One email per due / overdue item' },
                { value: 'summary', label: 'Daily digest', desc: 'All items in your morning brief' },
                { value: 'off', label: 'Off', desc: 'No action-item emails' },
              ] as const).map((opt) => {
                const active = ((user as any).actionItemEmailMode || 'each') === opt.value;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    onPress={async () => {
                      const prevMode = (user as any).actionItemEmailMode || 'each';
                      // Optimistic — reflect the choice immediately.
                      setUser(prev => ({ ...prev, actionItemEmailMode: opt.value } as any));
                      setFormData(prev => ({ ...prev, actionItemEmailMode: opt.value } as any));
                      try {
                        const res = await updateProfile({ actionItemEmailMode: opt.value });
                        if (res?.data) await authStorage.updateUser(res.data);
                      } catch (err: any) {
                        setUser(prev => ({ ...prev, actionItemEmailMode: prevMode } as any));
                        Alert.alert('Error', err?.message || 'Could not update email setting.');
                      }
                    }}
                    style={{
                      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                      paddingVertical: 12, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1.5,
                      backgroundColor: active ? colors.purpleSoft : colors.surface,
                      borderColor: active ? colors.purple : colors.border,
                    }}
                  >
                    <View style={{ flex: 1, paddingRight: 10 }}>
                      <Text style={{ fontSize: 13, fontFamily: 'Poppins_700Bold', color: colors.text }}>{opt.label}</Text>
                      <Text style={{ fontSize: 11, fontFamily: 'Poppins_400Regular', color: colors.textSoft, marginTop: 1 }}>{opt.desc}</Text>
                    </View>
                    <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: active ? colors.purple : colors.border, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? colors.purple : 'transparent' }}>
                      {active && <Check size={12} color="#fff" />}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Notifications & Privacy — persisted to the backend via PUT /profile/me */}
          <View className="w-full p-6 border-b mt-3" style={{ backgroundColor: colors.card, borderColor: colors.border }}>
            <View className="flex-row items-center border-b pb-3 mb-4" style={{ borderColor: colors.borderStrong }}>
              <Mail color={colors.purple} size={18} />
              <Text className="text-[15px] font-bold ml-2 font-sans" style={{ color: colors.text }}>Notifications & Privacy</Text>
            </View>
            {([
              { key: 'muted', label: 'Pause all push notifications', desc: 'Silence every push — messages, reminders and calls', get: (u: any) => u.notification_settings?.muted === true, build: (v: boolean, u: any) => ({ notification_settings: { ...(u.notification_settings || {}), muted: v } }) },
              { key: 'digest_enabled', label: 'Daily digest', desc: 'Morning brief push + email', get: (u: any) => u.digestPreferences?.enabled !== false, build: (v: boolean, u: any) => ({ digestPreferences: { ...(u.digestPreferences || {}), enabled: v } }) },
              { key: 'email_notifications', label: 'Email notifications', desc: 'Meeting recaps, reminders and digests by email', get: (u: any) => u.privacy_settings?.email_notifications !== false, build: (v: boolean, u: any) => ({ privacy_settings: { ...(u.privacy_settings || {}), email_notifications: v } }) },
              { key: 'read_receipts', label: 'Read receipts', desc: 'Let others see when you read messages', get: (u: any) => u.privacy_settings?.read_receipts !== false, build: (v: boolean, u: any) => ({ privacy_settings: { ...(u.privacy_settings || {}), read_receipts: v } }) },
              { key: 'show_online_status', label: 'Online status', desc: 'Show when you are online', get: (u: any) => u.privacy_settings?.show_online_status !== false, build: (v: boolean, u: any) => ({ privacy_settings: { ...(u.privacy_settings || {}), show_online_status: v } }) },
              { key: 'sounds', label: 'Notification sounds', desc: 'Play a sound for new messages', get: (u: any) => u.notification_settings?.sounds !== false, build: (v: boolean, u: any) => ({ notification_settings: { ...(u.notification_settings || {}), sounds: v } }) },
              { key: 'preview', label: 'Message previews', desc: 'Show message text in notifications', get: (u: any) => u.notification_settings?.preview !== false, build: (v: boolean, u: any) => ({ notification_settings: { ...(u.notification_settings || {}), preview: v } }) },
            ] as const).map((row, idx, arr) => {
              const value = row.get(user as any);
              return (
                <View key={row.key} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: idx < arr.length - 1 ? 1 : 0, borderColor: colors.border }}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={{ fontSize: 13, fontFamily: 'Poppins_600SemiBold', color: colors.text }}>{row.label}</Text>
                    <Text style={{ fontSize: 11, fontFamily: 'Poppins_400Regular', color: colors.textSoft, marginTop: 1 }}>{row.desc}</Text>
                  </View>
                  <Switch
                    value={value}
                    onValueChange={async (next) => {
                      const patch = row.build(next, user as any);
                      const prevUser = user;
                      // Optimistic; roll back and surface on failure.
                      setUser(prev => ({ ...prev, ...patch } as any));
                      try {
                        const res = await updateProfile(patch);
                        if (res?.data) await authStorage.updateUser(res.data);
                      } catch (err: any) {
                        setUser(prevUser);
                        Alert.alert('Error', err?.message || 'Could not save that setting.');
                      }
                    }}
                    trackColor={{ false: colors.border, true: colors.purple }}
                    thumbColor="#fff"
                  />
                </View>
              );
            })}
          </View>

          {/* Appearance / Dark Mode */}
          <View className="w-full p-6 border-b mt-3" style={{ backgroundColor: colors.card, borderColor: colors.border }}>
            <Text className="text-[15px] font-bold border-b pb-3 mb-5 font-sans" style={{ color: colors.text, borderColor: colors.borderStrong }}>
              Appearance
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {([
                { key: 'light', label: 'Light', Icon: Sun },
                { key: 'dark', label: 'Dark', Icon: Moon },
                { key: 'system', label: 'System', Icon: Smartphone },
              ] as const).map((opt) => {
                const active = scheme === opt.key;
                return (
                  <TouchableOpacity
                    key={opt.key}
                    onPress={() => setScheme(opt.key as Scheme)}
                    style={{ flex: 1, alignItems: 'center', gap: 6, paddingVertical: 14, borderRadius: 16, borderWidth: 1, backgroundColor: active ? colors.purple : colors.purpleSoft, borderColor: active ? colors.purple : colors.border }}
                  >
                    <opt.Icon size={18} color={active ? '#fff' : colors.purple} />
                    <Text style={{ fontSize: 12, fontFamily: 'Poppins_600SemiBold', color: active ? '#fff' : colors.textSoft }}>{opt.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={{ fontSize: 11, color: colors.textSoft, marginTop: 10 }}>
              Dark mode applies across the mobile app. "System" follows your phone settings.
            </Text>
          </View>

          {/* Logout */}
          <View className="w-full p-6" style={{ backgroundColor: colors.card }}>
            <TouchableOpacity
              onPress={handleLogout}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 20,
                paddingHorizontal: 24,
                paddingVertical: 15,
                backgroundColor: 'rgba(239, 68, 68, 0.06)',
                borderWidth: 1.5,
                borderColor: 'rgba(239, 68, 68, 0.3)',
                shadowColor: '#ef4444',
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.05,
                shadowRadius: 6,
              }}
            >
              <LogOut color="#ef4444" size={18} strokeWidth={2.5} />
              <Text style={{ color: '#ef4444', fontSize: 14, fontFamily: 'Poppins_700Bold', marginLeft: 8 }}>Log Out</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>

      {/* Edit Profile Modal */}
      <Modal visible={isEditing} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView className="flex-1 bg-white dark:bg-[#1a1b28]" edges={['top']}>
          <View className="flex-row items-center justify-between px-6 py-4 border-b border-black/5 dark:border-white/10">
            <View>
              <Text className="text-xl font-bold text-ink dark:text-[#f4f5fb]">Edit profile</Text>
              <Text className="text-xs text-ink-soft dark:text-[#9a9bb6]">Update your information</Text>
            </View>
            <TouchableOpacity onPress={() => { setFormData(user); setIsEditing(false); }}>
              <X color="#6c5ce7" size={20} />
            </TouchableOpacity>
          </View>
          
          <ScrollView className="flex-1 px-6 pt-6">
            <View className="bg-purple-soft/30 dark:bg-white/5 rounded-3xl border border-black/5 dark:border-white/10 p-6 mb-8">
              <View className="mb-4">
                <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1">Full Name</Text>
                <TextInput
                  value={formData.full_name}
                  onChangeText={(t) => setFormData({...formData, full_name: t})}
                  className="bg-white dark:bg-[#1a1b28] rounded-2xl p-4 text-ink dark:text-[#f4f5fb] border border-black/5 dark:border-white/10"
                />
              </View>
              
              <View className="mb-4">
                <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1">Username</Text>
                <TextInput
                  value={formData.username}
                  onChangeText={(t) => setFormData({...formData, username: t})}
                  className="bg-white dark:bg-[#1a1b28] rounded-2xl p-4 text-ink dark:text-[#f4f5fb] border border-black/5 dark:border-white/10"
                  autoCapitalize="none"
                />
              </View>
              
              <View className="mb-4">
                <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1">Bio</Text>
                <TextInput
                  value={formData.bio}
                  onChangeText={(t) => setFormData({...formData, bio: t})}
                  className="bg-white dark:bg-[#1a1b28] rounded-2xl p-4 text-ink dark:text-[#f4f5fb] border border-black/5 dark:border-white/10 min-h-[80px]"
                  multiline
                  textAlignVertical="top"
                />
              </View>
              
              <View className="mb-4">
                <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1">Email</Text>
                <TextInput
                  value={formData.email}
                  onChangeText={(t) => setFormData({...formData, email: t})}
                  className="bg-white dark:bg-[#1a1b28] rounded-2xl p-4 text-ink dark:text-[#f4f5fb] border border-black/5 dark:border-white/10"
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
              </View>
              
              <View className="mb-4">
                <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1">Phone Number</Text>
                <TextInput
                  value={formData.phone_number}
                  onChangeText={(t) => setFormData({...formData, phone_number: t})}
                  className="bg-white dark:bg-[#1a1b28] rounded-2xl p-4 text-ink dark:text-[#f4f5fb] border border-black/5 dark:border-white/10"
                  keyboardType="phone-pad"
                />
              </View>

              <View className="mb-4">
                <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1">Role</Text>
                <TextInput
                  value={(formData as any).org_role}
                  onChangeText={(t) => setFormData({ ...formData, org_role: t } as any)}
                  placeholder="e.g. Lead Developer"
                  placeholderTextColor="#9a9aab"
                  className="bg-white dark:bg-[#1a1b28] rounded-2xl p-4 text-ink dark:text-[#f4f5fb] border border-black/5 dark:border-white/10"
                />
              </View>

              {/* Action-Item Email Mode */}
              <View className="mb-4">
                <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1">Action-Item Emails</Text>
                <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] mb-2 leading-tight">How BubbleSpace emails you about meeting action items.</Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  {([
                    { value: 'each', label: 'Each item' },
                    { value: 'summary', label: 'Daily digest' },
                    { value: 'off', label: 'Off' },
                  ] as const).map(opt => {
                    const active = ((formData as any).actionItemEmailMode || 'each') === opt.value;
                    return (
                      <TouchableOpacity
                        key={opt.value}
                        onPress={() => setFormData({ ...formData, actionItemEmailMode: opt.value } as any)}
                        style={{
                          flex: 1,
                          paddingVertical: 10,
                          borderRadius: 14,
                          alignItems: 'center',
                          backgroundColor: active ? '#6c5ce7' : 'rgba(108,92,231,0.07)',
                          borderWidth: active ? 0 : 1,
                          borderColor: 'rgba(108,92,231,0.15)',
                        }}
                      >
                        <Text style={{ fontSize: 11, fontFamily: 'Poppins_700Bold', color: active ? '#fff' : '#6c5ce7' }}>{opt.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* App Background — syncs the preset used on the BubbleSpace web app. */}
              <View className="mb-4">
                <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1">App Background</Text>
                <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] mb-2 leading-tight">Used across your BubbleSpace on the web.</Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  {([
                    { value: 'bubbles', label: 'Bubbles' },
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                  ] as const).map(opt => {
                    const active = ((formData as any).app_background || 'bubbles') === opt.value;
                    return (
                      <TouchableOpacity
                        key={opt.value}
                        onPress={() => setFormData({ ...formData, app_background: opt.value } as any)}
                        style={{
                          flex: 1,
                          paddingVertical: 10,
                          borderRadius: 14,
                          alignItems: 'center',
                          backgroundColor: active ? '#6c5ce7' : 'rgba(108,92,231,0.07)',
                          borderWidth: active ? 0 : 1,
                          borderColor: 'rgba(108,92,231,0.15)',
                        }}
                      >
                        <Text style={{ fontSize: 11, fontFamily: 'Poppins_700Bold', color: active ? '#fff' : '#6c5ce7' }}>{opt.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <TouchableOpacity
                onPress={handleSave}
                className="bg-purple py-4 rounded-xl items-center flex-row justify-center mt-2"
              >
                <Check color="#fff" size={16} />
                <Text className="text-white font-bold ml-2">Save Changes</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* Edit Organization Modal */}
      <Modal visible={isEditingOrg} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView className="flex-1 bg-white dark:bg-[#1a1b28]" edges={['top']}>
          <View className="flex-row items-center justify-between px-6 py-4 border-b border-black/5 dark:border-white/10">
            <View>
              <Text className="text-xl font-bold text-ink dark:text-[#f4f5fb]">Edit Organization</Text>
              <Text className="text-xs text-ink-soft dark:text-[#9a9bb6]">Update your organization's settings</Text>
            </View>
            <TouchableOpacity onPress={() => setIsEditingOrg(false)}>
              <X color="#6c5ce7" size={20} />
            </TouchableOpacity>
          </View>
          
          <ScrollView className="flex-1 px-6 pt-6">
            <View className="bg-purple-soft/30 dark:bg-white/5 rounded-3xl border border-black/5 dark:border-white/10 p-6 mb-8">
              <View className="mb-4">
                <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-2">Organization Logo</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingBottom: 5 }}>
                  {AVATARS.map((url) => (
                    <TouchableOpacity
                      key={url}
                      onPress={() => setOrgFormData({...orgFormData, logo: url})}
                      style={{
                        width: 54,
                        height: 54,
                        borderRadius: 16,
                        borderWidth: orgFormData.logo === url ? 3 : 0,
                        borderColor: PURPLE,
                        overflow: 'hidden',
                      }}
                    >
                      <Image source={{ uri: url }} style={{ width: '100%', height: '100%' }} />
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>

              <View className="mb-4">
                <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1">Organization Name</Text>
                <TextInput
                  value={orgFormData.name}
                  onChangeText={(t) => setOrgFormData({...orgFormData, name: t})}
                  className="bg-white dark:bg-[#1a1b28] rounded-2xl p-4 text-ink dark:text-[#f4f5fb] border border-black/5 dark:border-white/10"
                />
              </View>
              
              <View className="mb-4">
                <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1">Description</Text>
                <TextInput
                  value={orgFormData.description}
                  onChangeText={(t) => setOrgFormData({...orgFormData, description: t})}
                  className="bg-white dark:bg-[#1a1b28] rounded-2xl p-4 text-ink dark:text-[#f4f5fb] border border-black/5 dark:border-white/10 min-h-[80px]"
                  multiline
                  textAlignVertical="top"
                />
              </View>

              <View className="mb-6 flex-row items-center justify-between">
                <View className="flex-1 pr-2">
                  <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1">Transcripts Policy</Text>
                  <Text className="text-sm font-semibold text-ink dark:text-[#f4f5fb] font-sans">Should their transcripts be sent to them? Do they not?</Text>
                  <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] mt-0.5 font-sans leading-tight">Controls whether company-wide meeting transcripts are automatically emailed to participants.</Text>
                </View>
                <Switch
                  value={orgFormData.emailTranscriptsToMembers}
                  onValueChange={(val) => setOrgFormData({...orgFormData, emailTranscriptsToMembers: val})}
                  trackColor={{ false: "#e2e8f0", true: "#6c5ce7" }}
                  thumbColor={Platform.OS === 'ios' ? undefined : orgFormData.emailTranscriptsToMembers ? "#6c5ce7" : "#f4f3f4"}
                />
              </View>
              
              <TouchableOpacity
                onPress={async () => {
                  try {
                    const { updateOrgProfile } = await import('../../lib/api');
                    const res = await updateOrgProfile({
                      name: orgFormData.name.trim(),
                      description: orgFormData.description.trim(),
                      logo: orgFormData.logo,
                      allowMembersToShareInvite: orgFormData.allowMembersToShareInvite,
                      emailTranscriptsToMembers: orgFormData.emailTranscriptsToMembers,
                    });
                    if (res?.organization) {
                      setOrgData(res.organization);
                      setUser(prev => ({ ...prev, organization: res.organization.name }));
                      Alert.alert("Success", "Organization settings updated successfully.");
                      setIsEditingOrg(false);
                    }
                  } catch (err: any) {
                    Alert.alert("Error", err.message || "Failed to update organization settings.");
                  }
                }}
                className="bg-purple py-4 rounded-xl items-center flex-row justify-center mt-2"
              >
                <Check color="#fff" size={16} />
                <Text className="text-white font-bold ml-2">Save Settings</Text>
              </TouchableOpacity>
            </View>

            {/* Knowledge Base — the documents that build the company brain */}
            <OrgKnowledgeBase active={isEditingOrg} isAdmin={!!orgData?.isAdmin} />
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* Choose Avatar Modal */}
      <Modal visible={isAvatarModalOpen} transparent animationType="slide">
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setIsAvatarModalOpen(false)}
          style={{
            flex: 1,
            backgroundColor: 'rgba(31,32,48,0.4)',
            justifyContent: 'flex-end',
          }}
        >
          <TouchableOpacity
            activeOpacity={1}
            style={{
              backgroundColor: '#ffffff',
              borderTopLeftRadius: 28,
              borderTopRightRadius: 28,
              padding: 24,
            }}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <Text style={{ fontSize: 18, fontFamily: 'SpaceGrotesk_700Bold', color: '#1f2030' }}>
                Select Profile Image
              </Text>
              <TouchableOpacity onPress={() => setIsAvatarModalOpen(false)} style={{ padding: 4 }}>
                <X color={PURPLE} size={20} />
              </TouchableOpacity>
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingBottom: 10 }}>
              {/* Pick from Gallery Option */}
              <TouchableOpacity
                onPress={handlePickFromGallery}
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 20,
                  borderWidth: 1.5,
                  borderColor: PURPLE,
                  borderStyle: 'dashed',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: 'rgba(108,92,231,0.05)',
                }}
              >
                <Plus color={PURPLE} size={22} />
                <Text style={{ fontSize: 9, color: PURPLE, fontFamily: 'Poppins_600SemiBold', marginTop: 2 }}>Gallery</Text>
              </TouchableOpacity>

              {AVATARS.map((url) => (
                <TouchableOpacity
                  key={url}
                  onPress={() => handleSelectAvatar(url)}
                  style={{
                    width: 64,
                    height: 64,
                    borderRadius: 20,
                    borderWidth: user.avatar === url ? 3 : 0,
                    borderColor: PURPLE,
                    overflow: 'hidden',
                  }}
                >
                  <Image source={{ uri: url }} style={{ width: '100%', height: '100%' }} />
                </TouchableOpacity>
              ))}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* QR Info Share Modal */}
      <Modal visible={isQrModalOpen} transparent animationType="slide">
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setIsQrModalOpen(false)}
          style={{
            flex: 1,
            backgroundColor: 'rgba(31,32,48,0.4)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 24,
          }}
        >
          <TouchableOpacity
            activeOpacity={1}
            style={{
              width: '100%',
              maxWidth: 320,
              backgroundColor: '#ffffff',
              borderRadius: 28,
              padding: 24,
              alignItems: 'center',
              shadowColor: '#000',
              shadowOpacity: 0.1,
              shadowRadius: 10,
              elevation: 8,
            }}
          >
            <View style={{ width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <Text style={{ fontSize: 18, fontFamily: 'SpaceGrotesk_700Bold', color: '#1f2030' }}>
                Share Contact Info
              </Text>
              <TouchableOpacity onPress={() => setIsQrModalOpen(false)} style={{ padding: 4 }}>
                <X color={PURPLE} size={20} />
              </TouchableOpacity>
            </View>

            <Text style={{ fontSize: 12, color: '#9a9aab', fontFamily: 'Poppins_500Medium', textAlign: 'center', marginBottom: 16 }}>
              Let others scan this QR to instantly add you on Bubble Chat.
            </Text>

            <View style={{ width: 220, height: 220, borderRadius: 20, backgroundColor: '#f8f7ff', borderWidth: 1, borderColor: 'rgba(108,92,231,0.1)', alignItems: 'center', justifyContent: 'center', marginBottom: 20, overflow: 'hidden' }}>
              <Image 
                source={{ uri: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=6c5ce7&data=${encodeURIComponent(user.uniqueTag || user.email || user.username || 'unknown')}` }} 
                style={{ width: 200, height: 200 }} 
              />
            </View>

            <Text style={{ fontSize: 11, fontFamily: 'Poppins_700Bold', color: '#9a9aab', textTransform: 'uppercase', marginBottom: 6, letterSpacing: 0.5 }}>
              Your Bubble ID
            </Text>
            
            <View style={{ width: '100%', flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(108,92,231,0.05)', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 20 }}>
              <Text style={{ flex: 1, fontSize: 13, fontFamily: 'Poppins_600SemiBold', color: '#1f2030' }} numberOfLines={1}>
                {user.uniqueTag || user.email || user.username || 'N/A'}
              </Text>
              <TouchableOpacity 
                onPress={() => {
                  const tag = user.uniqueTag || user.email || user.username || '';
                  Clipboard.setString(tag);
                  setCopiedText(true);
                  setTimeout(() => setCopiedText(false), 2000);
                }}
                style={{ padding: 4 }}
              >
                <Copy color={PURPLE} size={16} />
              </TouchableOpacity>
            </View>

            {copiedText && (
              <Text style={{ fontSize: 12, fontFamily: 'Poppins_600SemiBold', color: '#22c55e', marginBottom: 12 }}>
                Copied to Clipboard!
              </Text>
            )}

            <TouchableOpacity
              onPress={() => setIsQrModalOpen(false)}
              style={{ width: '100%', backgroundColor: PURPLE, borderRadius: 14, paddingVertical: 12, alignItems: 'center' }}
            >
              <Text style={{ color: '#ffffff', fontSize: 13, fontFamily: 'Poppins_700Bold' }}>Dismiss</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ── Employee Directory Page (full-screen, not a popup) ── */}
      <Modal visible={showAllMembers} animationType="slide" presentationStyle="fullScreen">
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
          <View className="flex-row items-center px-4 py-4" style={{ borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <TouchableOpacity onPress={() => setShowAllMembers(false)} style={{ padding: 8, marginRight: 6 }}>
              <ChevronLeft color={colors.text} size={24} />
            </TouchableOpacity>
            <View>
              <Text className="text-xl font-bold" style={{ color: colors.text }}>Employee Directory</Text>
              <Text className="text-xs" style={{ color: colors.textSoft }}>{orgMembers.length} member{orgMembers.length === 1 ? '' : 's'} in {orgData?.name || 'your organization'}</Text>
            </View>
          </View>
          <ScrollView className="flex-1 px-6 pt-4" contentContainerStyle={{ gap: 10, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
            {orgMembers.map((member) => (
              <OrgMemberRow key={String(member.id || member._id || member.username)} member={member} />
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}
