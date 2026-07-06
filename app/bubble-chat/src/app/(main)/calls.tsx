import React, { useState, useEffect, useReducer, useRef } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Modal, TextInput, Alert, KeyboardAvoidingView, Platform, Animated } from 'react-native';
import { Phone, Video, Users, User, MicOff, PhoneOff, Volume2, Calendar, ChevronLeft, ChevronRight, ChevronDown, Clock, Plus, X, Check, PhoneMissed, Trash2, FileText, Sparkles } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Text as SvgText, Defs, LinearGradient, Stop } from 'react-native-svg';
import { getOrgMembers, fetchTasks, createTaskFull, updateTaskFull, getSecureMediaUrl, fetchCallLogs, deleteCallLog, clearCallLogs, updateCallLog, fetchMeetings, fetchMeetingById, fetchActiveMeetings } from '../../lib/api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { startOutgoingCall, joinRoomByLink, knockToJoinRoom } from '../../lib/callManager';
import { authStorage } from '../../lib/authStorage';
import { getSocket } from '../../lib/socket';
import { subscribeTasksChanged } from '../../lib/taskListeners';
import { Image } from 'expo-image';
import { Avatar } from '../../components/Avatar';
import { MeetingDetailModal } from '../../components/MeetingDetailModal';
import { useIsOnline, useIsInMeeting, getPresence, subscribePresence } from '../../lib/presence';

// Live presence dot — rendered inside a list `.map`, so it owns its own hook subscription.
// Blinks green while the user is in a live meeting; steady green when merely online.
function StaffDot({ userId, fallback }: { userId?: string | null; fallback?: boolean }) {
  const online = useIsOnline(userId, !!fallback);
  const inMeeting = useIsInMeeting(userId);
  const blink = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (inMeeting) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(blink, { toValue: 0.25, duration: 600, useNativeDriver: true }),
          Animated.timing(blink, { toValue: 1, duration: 600, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
  }, [inMeeting, blink]);

  if (inMeeting) {
    return <Animated.View style={{ opacity: blink }} className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full border-3 border-white bg-green-500 shadow-sm" />;
  }
  if (!online) return null;
  return <View className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full border-3 border-white bg-green-500 shadow-sm" />;
}

// Calendar cells generator
const getCalendarCells = (currentDate: Date) => {
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevMonthDays = new Date(year, month, 0).getDate();

  const cells = [];
  // Previous month overflow
  for (let i = firstDay - 1; i >= 0; i--) {
    cells.push({
      date: new Date(year, month - 1, prevMonthDays - i),
      isCurrentMonth: false,
    });
  }
  // Current month
  for (let i = 1; i <= daysInMonth; i++) {
    cells.push({
      date: new Date(year, month, i),
      isCurrentMonth: true,
    });
  }
  // Next month overflow
  const remainingCells = 42 - cells.length;
  for (let i = 1; i <= remainingCells; i++) {
    cells.push({
      date: new Date(year, month + 1, i),
      isCurrentMonth: false,
    });
  }
  return cells;
};

function getInitials(name: string) {
  if (!name) return 'UC';
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
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

export default function CallsScreen() {
  const [callsTab, setCallsTab] = useState<'meet' | 'calendar' | 'logs'>('meet');
  const [callLogs, setCallLogs] = useState<any[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  // Call-log detail: revisit a past call + attach an agenda / activity notes.
  const [selectedLog, setSelectedLog] = useState<any | null>(null);
  const [logAgenda, setLogAgenda] = useState('');
  const [logNotes, setLogNotes] = useState('');
  const [savingLog, setSavingLog] = useState(false);

  const openLogDetail = (log: any) => {
    setSelectedLog(log);
    setLogAgenda(log.agenda || '');
    setLogNotes(log.notes || '');
  };

  const saveLogDetail = async () => {
    if (!selectedLog) return;
    const id = String(selectedLog._id || selectedLog.id);
    setSavingLog(true);
    try {
      await updateCallLog(id, { agenda: logAgenda, notes: logNotes });
      setCallLogs(prev => prev.map(l => String(l._id || l.id) === id ? { ...l, agenda: logAgenda, notes: logNotes } : l));
      setSelectedLog(null);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Could not save notes.');
    } finally {
      setSavingLog(false);
    }
  };

  const loadCallLogs = React.useCallback(async () => {
    setLogsLoading(true);
    try {
      const res = await fetchCallLogs();
      setCallLogs(res?.logs || res?.data || (Array.isArray(res) ? res : []));
    } catch {
      /* keep whatever we have */
    } finally {
      setLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (callsTab === 'logs') loadCallLogs();
  }, [callsTab, loadCallLogs]);

  const handleDeleteLog = async (id: string) => {
    setCallLogs(prev => prev.filter(l => String(l._id || l.id) !== String(id)));
    try { await deleteCallLog(id); } catch { /* best-effort */ }
  };

  const handleClearLogs = () => {
    Alert.alert('Clear call logs', 'Remove all call history?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear', style: 'destructive', onPress: async () => {
          setCallLogs([]);
          try { await clearCallLogs(); } catch { /* best-effort */ }
        },
      },
    ]);
  };

  // Real meeting history (replaces the old hardcoded mock rooms). Mirrors the
  // web meetings tab — backed by GET /api/v1/meetings.
  const [meetings, setMeetings] = useState<any[]>([]);
  const [meetingsLoading, setMeetingsLoading] = useState(false);
  const [selectedMeeting, setSelectedMeeting] = useState<any | null>(null);
  const [meetingDetailLoading, setMeetingDetailLoading] = useState(false);

  const loadMeetings = React.useCallback(async () => {
    setMeetingsLoading(true);
    try {
      const res: any = await fetchMeetings(1, 20);
      setMeetings(Array.isArray(res?.meetings) ? res.meetings : (Array.isArray(res) ? res : []));
    } catch (err) {
      console.warn('Failed to load meetings:', err);
    } finally {
      setMeetingsLoading(false);
    }
  }, []);

  useEffect(() => { loadMeetings(); }, [loadMeetings]);

  // ── Live Collaborative Spaces (active rooms) ──────────────────────────────
  // Mirrors the web meet tab's "Live Collaborative Spaces": the rooms that are
  // live right now, with a Join button. Backed by GET /api/v1/meetings/active,
  // refreshed on the same socket events the web listens to + a 30s safety poll.
  const [activeRooms, setActiveRooms] = useState<any[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);

  const loadActiveRooms = React.useCallback(async () => {
    setRoomsLoading(true);
    try {
      const res: any = await fetchActiveMeetings();
      setActiveRooms(Array.isArray(res?.rooms) ? res.rooms : []);
    } catch (err) {
      console.warn('Failed to load active rooms:', err);
    } finally {
      setRoomsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadActiveRooms();
    const interval = setInterval(loadActiveRooms, 30_000);
    const socket = getSocket();
    const refresh = () => loadActiveRooms();
    socket?.on('meeting_room_update', refresh);
    socket?.on('meeting_ended', refresh);
    return () => {
      clearInterval(interval);
      socket?.off('meeting_room_update', refresh);
      socket?.off('meeting_ended', refresh);
    };
  }, [loadActiveRooms]);

  // Join a live room. The host (or an already-admitted attendee) re-enters its
  // LiveKit session directly; everyone else "knocks" and only enters once the host
  // admits them (room_knock → room_knock_response, handled in callManager).
  const handleJoinRoom = async (room: any) => {
    const roomId = room?.roomId || room?.id;
    if (!roomId) return;
    setJoiningRoomId(String(roomId));
    try {
      const me = await authStorage.getUser();
      const myId = String(me?._id || me?.id || '');
      const hostId = String(room?.host?._id || room?.host?.id || room?.host || '');
      const attendeeIds = (room?.attendees || []).map((a: any) => String(a?._id || a?.id || a));
      const type = room?.type === 'video' ? 'video' : 'voice';
      if (myId && (myId === hostId || attendeeIds.includes(myId))) {
        await joinRoomByLink({ roomId: String(roomId), type });
      } else {
        await knockToJoinRoom({ roomId: String(roomId), hostId: hostId || undefined, type });
      }
    } catch (err: any) {
      Alert.alert('Could not join', err?.message || 'Failed to join the live room.');
    } finally {
      setJoiningRoomId(null);
    }
  };

  // Unified Call Logs tab data: the legacy CallLog collection is rarely populated
  // (no client ever calls saveCallLog), so on its own this tab looked empty even
  // after real calls happened. Merge in the real Meeting records — same shape web's
  // CallLogsSection (tab-views.tsx) already unifies — so both clients show the same
  // call history.
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

  const openMeetingDetail = async (meeting: any) => {
    setSelectedMeeting(meeting);
    setMeetingDetailLoading(true);
    try {
      const res: any = await fetchMeetingById(String(meeting._id || meeting.id));
      const full = res?.meeting || res?.data || res;
      // carriedOverActionItems rides alongside `meeting` in the response — stash
      // it on the object so the detail modal can render "carried over" items.
      if (full) setSelectedMeeting({ ...full, carriedOverActionItems: res?.carriedOverActionItems || [] });
    } catch (err) {
      console.warn('Failed to load meeting detail:', err);
    } finally {
      setMeetingDetailLoading(false);
    }
  };

  const [coworkers, setCoworkers] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);

  // "People in the office" / "All Active Staff" — re-render on realtime presence
  // changes so the list actually reflects who's online, not the full roster.
  const [, forcePresenceRender] = useReducer((x) => x + 1, 0);
  useEffect(() => subscribePresence(forcePresenceRender), []);
  const onlineCoworkers = coworkers.filter((w) => getPresence(w.id ?? w._id) ?? !!w.isOnline);

  // Calling states

  // Calendar agenda states
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [actionItemsOpen, setActionItemsOpen] = useState(false);

  // New Event form states
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  // Meeting agenda — persisted with the event and included in invite emails.
  const [agenda, setAgenda] = useState('');
  const [startTimeText, setStartTimeText] = useState('10:00');
  const [endTimeText, setEndTimeText] = useState('11:00');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high' | 'urgent'>('medium');
  const [type, setType] = useState<'meeting' | 'task' | 'event'>('meeting');
  const [meetingType, setMeetingType] = useState<'voice' | 'video'>('voice');

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const loadCache = async () => {
    try {
      const cachedTasks = await AsyncStorage.getItem('bubble_cached_tasks');
      if (cachedTasks) {
        setTasks(JSON.parse(cachedTasks));
      }
      const cachedCoworkers = await AsyncStorage.getItem('bubble_cached_coworkers');
      if (cachedCoworkers) {
        setCoworkers(JSON.parse(cachedCoworkers));
      }
    } catch (err) {
      console.warn("Failed to load cached calls screen data:", err);
    }
  };

  const syncData = async () => {
    try {
      // Fetch coworkers — full org directory (searchUsers('') only returns
      // explicit contacts now, which left this section empty).
      const coworkersRes = await getOrgMembers();
      const rawMembers = coworkersRes?.members || coworkersRes?.data || [];
      const coworkersList = rawMembers.map((u: any) => ({ ...u, id: String(u.id || u._id) }));
      setCoworkers(coworkersList);
      await AsyncStorage.setItem('bubble_cached_coworkers', JSON.stringify(coworkersList));

      // Fetch tasks/agenda. getTasks responds with { tasks: [...] }.
      const tasksRes = await fetchTasks();
      const tasksList = Array.isArray(tasksRes) ? tasksRes : (tasksRes?.tasks || tasksRes?.data || []);
      setTasks(tasksList);
      await AsyncStorage.setItem('bubble_cached_tasks', JSON.stringify(tasksList));
    } catch (err) {
      console.warn("Failed to sync calls screen data:", err);
    }
  };

  useEffect(() => {
    loadCache();
    syncData();
  }, []);

  useEffect(() => {
    const interval = setInterval(syncData, 6000);
    return () => clearInterval(interval);
  }, []);

  // Live-refresh when an action item is followed-up / completed / a meeting ends (F3).
  useEffect(() => subscribeTasksChanged(syncData), []);



  // Toggle a meeting-sourced action item done / open. Backend mirrors it onto the
  // meeting record and notifies other participants (F3).
  const handleToggleActionItem = async (task: any) => {
    const id = task._id || task.id;
    const next = task.status === 'done' ? 'todo' : 'done';
    // Optimistic update so the checkbox feels instant.
    setTasks(prev => prev.map((t: any) => ((t._id || t.id) === id ? { ...t, status: next } : t)));
    try {
      await updateTaskFull(id, { status: next });
    } catch {
      Alert.alert('Error', 'Could not update action item.');
      syncData();
    }
  };

  const handleCreateEvent = async () => {
    if (!title.trim()) {
      Alert.alert('Validation Error', 'Please enter a title for the event.');
      return;
    }

    try {
      const start = new Date(selectedDate);
      const [sH, sM] = startTimeText.split(':').map(Number);
      start.setHours(sH || 10, sM || 0, 0, 0);

      const end = new Date(selectedDate);
      const [eH, eM] = endTimeText.split(':').map(Number);
      end.setHours(eH || 11, eM || 0, 0, 0);

      const payload = {
        title: title.trim(),
        description: description.trim(),
        agenda: agenda.trim() || undefined,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        priority,
        type,
        meetingType: type === 'meeting' ? meetingType : undefined,
      };

      await createTaskFull(payload);
      
      // Reset form
      setTitle('');
      setDescription('');
      setAgenda('');
      setStartTimeText('10:00');
      setEndTimeText('11:00');
      setPriority('medium');
      setType('meeting');
      setMeetingType('voice');
      
      setIsModalOpen(false);
      await syncData();

      if ((payload.priority === 'high' || payload.priority === 'urgent') && payload.type === 'meeting') {
        Alert.alert(
          'Priority Meeting Scheduled',
          'Everybody in the group is notified to come online for this call.',
          [
            { text: 'Later', style: 'cancel' },
            { 
              text: 'Start Call Now', 
              onPress: () => {
                startOutgoingCall({ name: payload.title, avatar: null }, payload.meetingType || 'voice');
              } 
            }
          ]
        );
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to create event.');
    }
  };

  // Calendar Helpers
  const prevMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
  const nextMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
  const isSelected = (date: Date) => date.toDateString() === selectedDate.toDateString();
  const isToday = (date: Date) => date.toDateString() === new Date().toDateString();

  const cells = getCalendarCells(currentDate);
  const selectedDayTasks = tasks.filter(t => new Date(t.start_time).toDateString() === selectedDate.toDateString());

  return (
    <SafeAreaView className="flex-1 bg-white dark:bg-[#1a1b28]" edges={['top']}>
      {/* Header */}
      <View className="flex-row items-center justify-between px-6 pt-5 pb-3">
        <View>
          <Svg height="36" width="160">
            <Defs>
              <LinearGradient id="callsGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <Stop offset="0%" stopColor="#6c5ce7" />
                <Stop offset="100%" stopColor="rgba(108,92,231,0.6)" />
              </LinearGradient>
            </Defs>
            <SvgText
              fill="url(#callsGrad)"
              fontSize="26"
              fontFamily="SpaceGrotesk_700Bold"
              x="0"
              y="26"
              letterSpacing="-0.5"
            >
              {callsTab === 'meet' ? "Calls" : callsTab === 'calendar' ? "Calendar" : "Call Logs"}
            </SvgText>
          </Svg>
          <Text className="text-xs text-ink-soft dark:text-[#9a9bb6] mt-0.5 font-sans">
            {callsTab === 'meet' ? "Experience seamless communication" : callsTab === 'calendar' ? "Organize team meetings & agendas" : "Your recent call history"}
          </Text>
        </View>

        {callsTab === 'meet' ? (
          <TouchableOpacity
            onPress={() => {
              startOutgoingCall({ name: 'Quick Meet Room', avatar: null }, 'video');
            }}
            className="bg-purple px-4 py-2.5 rounded-xl shadow-sm"
          >
            <Text className="text-white text-xs font-bold font-sans">New Meet</Text>
          </TouchableOpacity>
        ) : callsTab === 'calendar' ? (
          <TouchableOpacity
            onPress={() => setIsModalOpen(true)}
            className="flex-row items-center bg-purple px-4 py-2.5 rounded-xl shadow-sm"
          >
            <Plus color="#fff" size={15} />
            <Text className="text-white text-xs font-bold font-sans ml-1">Add Event</Text>
          </TouchableOpacity>
        ) : callLogs.length > 0 ? (
          <TouchableOpacity
            onPress={handleClearLogs}
            className="flex-row items-center bg-red-500/10 px-4 py-2.5 rounded-xl"
          >
            <Trash2 color="#ef4444" size={15} />
            <Text className="text-red-500 text-xs font-bold font-sans ml-1">Clear</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Tab Switcher */}
      <View className="flex-row px-6 pb-2 border-b border-black/5 dark:border-white/10">
        <TouchableOpacity
          onPress={() => setCallsTab('meet')}
          className={`mr-6 pb-3 pt-1 border-b-2 ${
            callsTab === 'meet' ? 'border-purple' : 'border-transparent'
          }`}
        >
          <Text className={`text-sm font-bold font-sans ${
            callsTab === 'meet' ? 'text-purple' : 'text-ink-soft dark:text-[#9a9bb6]'
          }`}>
            Live Meetings
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setCallsTab('calendar')}
          className={`mr-6 pb-3 pt-1 border-b-2 ${
            callsTab === 'calendar' ? 'border-purple' : 'border-transparent'
          }`}
        >
          <Text className={`text-sm font-bold font-sans ${
            callsTab === 'calendar' ? 'text-purple' : 'text-ink-soft dark:text-[#9a9bb6]'
          }`}>
            Business Calendar
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setCallsTab('logs')}
          className={`mr-6 pb-3 pt-1 border-b-2 ${
            callsTab === 'logs' ? 'border-purple' : 'border-transparent'
          }`}
        >
          <Text className={`text-sm font-bold font-sans ${
            callsTab === 'logs' ? 'text-purple' : 'text-ink-soft dark:text-[#9a9bb6]'
          }`}>
            Call Logs
          </Text>
        </TouchableOpacity>
      </View>

      {callsTab === 'meet' ? (
        <ScrollView className="flex-1 px-4 pt-4 bg-purple-soft/5" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 130 }}>
          {/* Live Collaborative Spaces — rooms that are live right now (web parity). */}
          <View className="mb-8">
            <View className="flex-row items-center justify-between mb-4 px-1">
              <Text className="text-xs font-bold uppercase tracking-wider text-black/30 dark:text-white/30 italic font-sans">Live Collaborative Spaces</Text>
              <View className="flex-row items-center bg-emerald-500/10 px-3 py-1 rounded-full">
                <View className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-2" />
                <Text className="text-[10px] font-bold text-emerald-600 font-sans">{activeRooms.length} ACTIVE ROOMS</Text>
              </View>
            </View>

            {roomsLoading && activeRooms.length === 0 ? (
              <View className="py-8 items-center justify-center">
                <Text className="text-xs text-ink-soft dark:text-[#9a9bb6] font-sans">Checking for live rooms…</Text>
              </View>
            ) : activeRooms.length === 0 ? (
              <View className="py-8 items-center justify-center border-2 border-dashed border-black/5 dark:border-white/10 rounded-[28px] bg-black/[0.02]">
                <Text className="text-xs text-ink-soft dark:text-[#9a9bb6] font-sans">No active live meetings. Start one to collaborate!</Text>
              </View>
            ) : (
              <View className="space-y-3">
                {activeRooms.map((room: any) => {
                  const participants = [room.host, ...(room.attendees || [])].filter(Boolean);
                  const whenStr = room.startedAt ? new Date(room.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                  const roomKey = String(room.roomId || room.id);
                  const joining = joiningRoomId === roomKey;
                  return (
                    <View key={roomKey} className="w-full bg-purple-soft/40 dark:bg-purple/15 p-5 rounded-[28px] border border-purple/5 shadow-sm mb-3">
                      <View className="flex-row items-start justify-between">
                        <View className="flex-1 min-w-0 pr-2">
                          <View className="flex-row items-center gap-1.5 mb-1">
                            <View className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                            <Text className="text-[9px] font-bold uppercase tracking-wider text-emerald-600 font-sans">
                              Live{whenStr ? ` · Started ${whenStr}` : ''}
                            </Text>
                          </View>
                          <Text className="text-[16px] font-bold text-ink dark:text-[#f4f5fb] font-sans" numberOfLines={1}>{room.title || 'Live Meeting'}</Text>
                          <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] font-medium font-sans mt-0.5">
                            {room.members || participants.length} {(room.members || participants.length) === 1 ? 'person' : 'people'} joined
                          </Text>
                        </View>
                        <View className="px-2 py-0.5 rounded-full bg-white/60 dark:bg-white/10 border border-black/5 dark:border-white/10">
                          <Text className="text-[9px] font-bold uppercase text-ink-soft dark:text-[#9a9bb6] font-sans">{room.type === 'video' ? 'Video' : 'Audio'}</Text>
                        </View>
                      </View>

                      <View className="flex-row items-end justify-between mt-5">
                        <View className="flex-row -space-x-3">
                          {participants.slice(0, 4).map((p: any, i: number) => (
                            <View key={i} className="w-9 h-9 rounded-full border-2 border-white bg-purple items-center justify-center shadow-sm overflow-hidden">
                              <Text className="text-white text-[11px] font-bold font-sans">
                                {(p?.full_name || p?.username || '?').charAt(0).toUpperCase()}
                              </Text>
                            </View>
                          ))}
                          {participants.length > 4 && (
                            <View className="w-9 h-9 rounded-full border-2 border-white bg-purple/10 items-center justify-center shadow-sm">
                              <Text className="text-[10px] font-bold text-purple font-sans">+{participants.length - 4}</Text>
                            </View>
                          )}
                        </View>
                        <TouchableOpacity
                          onPress={() => handleJoinRoom(room)}
                          disabled={joining}
                          className="flex-row items-center gap-1.5 bg-purple px-4 py-2.5 rounded-2xl shadow-sm"
                          style={{ opacity: joining ? 0.6 : 1 }}
                        >
                          <Video color="#fff" size={15} />
                          <Text className="text-white text-sm font-bold font-sans">{joining ? 'Joining…' : 'Join'}</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </View>

          {/* Upcoming scheduled meetings (next 7 days) — completes the Live Rooms
              card with what's COMING UP, not just what's live (web parity). */}
          {(() => {
            const now = Date.now();
            const weekOut = now + 7 * 86400000;
            const upcoming = (tasks || [])
              .filter((t: any) => (t.type === 'meeting' || t.type === 'event') && t.start_time &&
                new Date(t.start_time).getTime() > now && new Date(t.start_time).getTime() <= weekOut &&
                t.status !== 'done' && t.status !== 'cancelled')
              .sort((a: any, b: any) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
              .slice(0, 5);
            if (upcoming.length === 0) return null;
            return (
              <View className="mb-8">
                <View className="flex-row items-center justify-between mb-4 px-1">
                  <Text className="text-xs font-bold uppercase tracking-wider text-black/30 dark:text-white/30 italic font-sans">Upcoming Meetings</Text>
                  <View className="bg-blue-500/10 px-3 py-1 rounded-full">
                    <Text className="text-[10px] font-bold text-blue-600 font-sans">NEXT 7 DAYS</Text>
                  </View>
                </View>
                <View>
                  {upcoming.map((t: any) => {
                    const start = new Date(t.start_time);
                    const isToday = start.toDateString() === new Date().toDateString();
                    const whenStr = `${isToday ? 'Today' : start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
                    return (
                      <TouchableOpacity
                        key={String(t._id || t.id)}
                        onPress={() => setCallsTab('calendar')}
                        className="w-full bg-blue-500/5 p-5 rounded-[28px] border border-blue-500/10 mb-3"
                      >
                        <View className="flex-row items-start justify-between">
                          <View className="flex-1 min-w-0 pr-2">
                            <View className="flex-row items-center gap-1.5 mb-1">
                              <Calendar color="#2563eb" size={12} />
                              <Text className="text-[9px] font-bold uppercase tracking-wider text-blue-600 font-sans">{whenStr}</Text>
                            </View>
                            <Text className="text-[16px] font-bold text-ink dark:text-[#f4f5fb] font-sans" numberOfLines={1}>{t.title || 'Meeting'}</Text>
                            {t.description ? (
                              <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] font-sans mt-0.5" numberOfLines={2}>{t.description}</Text>
                            ) : null}
                          </View>
                          <View className="px-2 py-0.5 rounded-full bg-white/60 dark:bg-white/10 border border-black/5 dark:border-white/10">
                            <Text className="text-[9px] font-bold uppercase text-ink-soft dark:text-[#9a9bb6] font-sans">
                              {t.meetingType === 'voice' || t.type === 'event' ? 'Event' : 'Meeting'}
                            </Text>
                          </View>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            );
          })()}

          {/* Meetings history (real data, mirrors the web meetings tab) */}
          <View className="mb-8">
            <View className="flex-row items-center justify-between mb-4 px-1">
              <Text className="text-xs font-bold uppercase tracking-wider text-black/30 dark:text-white/30 italic font-sans">Recent Meetings</Text>
              <View className="flex-row items-center bg-purple/10 px-3 py-1 rounded-full">
                <View className="w-1.5 h-1.5 rounded-full bg-purple mr-2" />
                <Text className="text-[10px] font-bold text-purple font-sans">{meetings.length} MEETINGS</Text>
              </View>
            </View>

            {meetingsLoading && meetings.length === 0 ? (
              <View className="py-8 items-center justify-center">
                <Text className="text-xs text-ink-soft dark:text-[#9a9bb6] font-sans">Loading meetings…</Text>
              </View>
            ) : meetings.length === 0 ? (
              <View className="py-8 items-center justify-center">
                <Text className="text-xs text-ink-soft dark:text-[#9a9bb6] font-sans">No meetings yet</Text>
              </View>
            ) : (
              <View className="space-y-4">
                {meetings.map((m: any) => {
                  const attendees = Array.isArray(m.attendees) ? m.attendees : [];
                  const isLive = m.status === 'live';
                  const when = m.startedAt ? new Date(m.startedAt) : (m.createdAt ? new Date(m.createdAt) : null);
                  const durationMin = m.duration ? Math.round(m.duration / 60) : null;
                  return (
                    <TouchableOpacity
                      key={String(m._id || m.id)}
                      onPress={() => openMeetingDetail(m)}
                      className="w-full bg-purple-soft/40 dark:bg-purple/15 p-5 rounded-[28px] border border-purple/5 shadow-sm mb-3"
                    >
                      <View className="flex-row items-center justify-between">
                        <Text className="text-[17px] font-bold text-ink dark:text-[#f4f5fb] font-sans flex-1" numberOfLines={1}>{m.title || 'Untitled Meeting'}</Text>
                        {isLive && (
                          <View className="flex-row items-center bg-emerald-500/10 px-2 py-0.5 rounded-full ml-2">
                            <View className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5" />
                            <Text className="text-[9px] font-bold text-emerald-600 font-sans">LIVE</Text>
                          </View>
                        )}
                      </View>
                      <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] font-medium uppercase font-sans mt-1">
                        {attendees.length} {attendees.length === 1 ? 'attendee' : 'attendees'}
                        {when ? ` · ${when.toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}
                        {durationMin != null ? ` · ${durationMin}m` : ''}
                      </Text>

                      <View className="flex-row items-end justify-between mt-6">
                        <View className="flex-row -space-x-3">
                          {attendees.slice(0, 3).map((a: any, i: number) => (
                            <View key={i} className="w-10 h-10 rounded-full border-2 border-white bg-purple items-center justify-center shadow-sm overflow-hidden">
                              <Text className="text-white text-[12px] font-bold font-sans">
                                {(a.full_name || a.username || '?').charAt(0).toUpperCase()}
                              </Text>
                            </View>
                          ))}
                        </View>
                        <View className="flex-row items-center gap-1.5">
                          {(m.summary || m.transcriptRaw) && <FileText color="#6c5ce7" size={16} />}
                          {Array.isArray(m.actionItems) && m.actionItems.length > 0 && (
                            <View className="bg-purple/10 px-2 py-0.5 rounded-full">
                              <Text className="text-[9px] font-bold text-purple font-sans">{m.actionItems.length} TASKS</Text>
                            </View>
                          )}
                        </View>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>

          {/* People in the Office */}
          <View className="mb-24">
            <View className="flex-row items-center justify-between mb-4 px-1">
              <Text className="text-xs font-bold uppercase tracking-wider text-black/30 dark:text-white/30 italic font-sans">People in the office</Text>
              <View className="bg-purple/10 px-2 py-0.5 rounded-full">
                <Text className="text-[10px] font-bold text-purple uppercase font-sans">All Active Staff</Text>
              </View>
            </View>

            {onlineCoworkers.length === 0 ? (
              <View className="py-8 items-center justify-center">
                <Text className="text-xs text-ink-soft dark:text-[#9a9bb6] font-sans">No staff online currently</Text>
              </View>
            ) : (
              <View className="flex-row flex-wrap justify-between">
                {onlineCoworkers.map(worker => {
                  const displayName = worker.full_name || worker.name || worker.username || 'Unknown staff';
                  return (
                    <View key={worker.id} style={{ width: '48%' }} className="bg-white dark:bg-[#1a1b28] border border-black/5 dark:border-white/10 rounded-[32px] p-5 mb-4 items-center shadow-sm relative overflow-hidden">
                      <View className="relative">
                        <Avatar
                          url={worker.avatar}
                          // userId unlocks the offline base64 avatar cache. Also fixed a
                          // bug where the fallback used the ORG name (so almost every
                          // person with an org showed a black group-tile with the
                          // company's initials instead of their own colored avatar).
                          userId={worker.id}
                          name={displayName}
                          size={80}
                          style={{ borderRadius: 24 }}
                          imageStyle={{ borderRadius: 24 }}
                        />
                        <StaffDot userId={worker.id} fallback={worker.isOnline} />
                      </View>
                      <Text className="text-[15px] font-bold text-ink dark:text-[#f4f5fb] mt-4 text-center w-full font-sans" numberOfLines={1}>
                        {displayName}
                      </Text>
                      <Text className="text-[10px] font-bold text-purple uppercase italic mt-1 text-center w-full font-sans" numberOfLines={1}>
                        {worker.org_role || 'Staff Member'}
                      </Text>
                      <Text className="text-[9px] text-ink-soft dark:text-[#9a9bb6] font-medium text-center mt-0.5 w-full font-sans" numberOfLines={1}>
                        {worker.organization || 'Bubble Chat'}
                      </Text>

                      <View className="flex-row items-center justify-center gap-2 mt-5">
                        <TouchableOpacity
                          onPress={() => startOutgoingCall({ id: worker.id, otherUserId: worker.id, name: displayName, avatar: worker.avatar }, 'voice')}
                          className="w-10 h-10 rounded-xl bg-purple-soft items-center justify-center"
                        >
                          <Phone color="#6c5ce7" size={16} />
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => startOutgoingCall({ id: worker.id, otherUserId: worker.id, name: displayName, avatar: worker.avatar }, 'video')}
                          className="w-10 h-10 rounded-xl bg-purple-soft items-center justify-center"
                        >
                          <Video color="#6c5ce7" size={16} />
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        </ScrollView>
      ) : callsTab === 'calendar' ? (
        <ScrollView className="flex-1 bg-purple-soft/5" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 130 }}>
          {/* Calendar Widget */}
          <View className="bg-purple-soft/20 p-6 border-b border-black/5 dark:border-white/10 w-full">
            <View className="flex-row justify-between items-center mb-4">
              <Text className="text-lg font-bold text-ink dark:text-[#f4f5fb] font-sans">{monthNames[currentDate.getMonth()]} {currentDate.getFullYear()}</Text>
              <View className="flex-row gap-2">
                <TouchableOpacity onPress={prevMonth} className="p-2 border border-black/5 dark:border-white/10 rounded-xl bg-white dark:bg-[#1a1b28]">
                  <ChevronLeft color="#6c5ce7" size={16} />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setCurrentDate(new Date())} className="px-3 py-2 border border-black/5 dark:border-white/10 rounded-xl bg-white dark:bg-[#1a1b28]">
                  <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] font-sans">Today</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={nextMonth} className="p-2 border border-black/5 dark:border-white/10 rounded-xl bg-white dark:bg-[#1a1b28]">
                  <ChevronRight color="#6c5ce7" size={16} />
                </TouchableOpacity>
              </View>
            </View>

            <View className="flex-row justify-between mb-2">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                <Text key={day} className="text-[10px] font-bold text-black/30 dark:text-white/30 uppercase flex-1 text-center font-sans">{day}</Text>
              ))}
            </View>

            <View className="flex-row flex-wrap">
              {cells.map((cell, idx) => {
                const selected = isSelected(cell.date);
                const today = isToday(cell.date);
                const dayTasks = tasks.filter(t => new Date(t.start_time).toDateString() === cell.date.toDateString());
                const hasMeeting = dayTasks.length > 0;

                return (
                  <TouchableOpacity
                    key={idx}
                    onPress={() => setSelectedDate(cell.date)}
                    className="w-[14.28%] aspect-square p-1"
                  >
                    <View className={`flex-1 rounded-[14px] p-1.5 justify-between border ${
                      selected ? 'bg-purple border-purple' : 
                      today ? 'border-purple/50 bg-purple/5' : 
                      cell.isCurrentMonth ? 'bg-white dark:bg-[#1a1b28] border-black/5 dark:border-white/10' : 'bg-slate-50 dark:bg-white/5 border-black/5 dark:border-white/10 opacity-50'
                    }`}>
                      <Text className={`text-xs font-bold font-sans ${selected ? 'text-white' : 'text-ink dark:text-[#f4f5fb]'}`}>
                        {cell.date.getDate()}
                      </Text>
                      {hasMeeting && (
                        <View className="flex-row gap-0.5 mt-auto flex-wrap">
                          {dayTasks.map(t => {
                            // Shared indicator spec: green=meeting, yellow=recurring,
                            // blue=event, purple=task, red=holiday.
                            let dotColor = 'bg-violet-500'; // task → purple (default)
                            if (t.eventType === 'holiday' || t.type === 'holiday') {
                              dotColor = 'bg-red-500';
                            } else if (t.isRecurring || t.__recurring || t.recurrenceRule) {
                              dotColor = 'bg-yellow-500';
                            } else if (t.type === 'meeting' || t.eventType === 'meeting_video' || t.eventType === 'meeting_audio') {
                              dotColor = 'bg-emerald-500';
                            } else if (t.type === 'event' || t.eventType === 'company' || t.eventType === 'all_day') {
                              dotColor = 'bg-blue-500';
                            } else if (t.type === 'task') {
                              dotColor = 'bg-violet-500';
                            }
                            return (
                              <View key={t._id || t.id} className={`w-1.5 h-1.5 rounded-full ${selected ? 'bg-white dark:bg-[#1a1b28]' : dotColor}`} />
                            );
                          })}
                        </View>
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Agenda view */}
          <View className="p-6 mb-24">
            <Text className="text-xs font-bold uppercase tracking-wider text-black/30 dark:text-white/30 italic mb-1 font-sans">Agenda for</Text>
            <Text className="text-lg font-bold text-ink dark:text-[#f4f5fb] mb-4 font-sans">{selectedDate.toLocaleDateString('en-US', { dateStyle: 'medium' })}</Text>

            {selectedDayTasks.length === 0 ? (
              <View className="py-10 border-2 border-dashed border-black/5 dark:border-white/10 rounded-[24px] bg-white/50 items-center justify-center">
                <Calendar color="#6c5ce7" size={20} opacity={0.3} className="mb-2" />
                <Text className="text-sm text-ink-soft dark:text-[#9a9bb6] font-medium font-sans">No events scheduled.</Text>
              </View>
            ) : (
              selectedDayTasks.map(task => {
                // Shared indicator spec: green=meeting, yellow=recurring, blue=event, purple=task, orange=holiday.
                const isHoliday = task.eventType === 'holiday' || task.type === 'holiday';
                const isRecurring = task.isRecurring || task.__recurring || task.recurrenceRule;
                const isMeeting = task.type === 'meeting' || task.eventType === 'meeting_video' || task.eventType === 'meeting_audio';
                const isEvent = task.type === 'event' || task.eventType === 'company' || task.eventType === 'all_day';
                const labelColor = isHoliday ? 'bg-orange-100' : isRecurring ? 'bg-yellow-100' : isMeeting ? 'bg-emerald-100' : isEvent ? 'bg-blue-100' : 'bg-purple/10';
                const labelTextColor = isHoliday ? 'text-orange-600' : isRecurring ? 'text-yellow-700' : isMeeting ? 'text-emerald-600' : isEvent ? 'text-blue-600' : 'text-purple';
                const pColor = task.priority === 'urgent' || task.priority === 'high' ? 'bg-red-50 text-red-600' : 'bg-yellow-50 text-yellow-600';
                return (
                  <View key={task._id || task.id} className="p-4 rounded-2xl bg-white dark:bg-[#1a1b28] border border-black/5 dark:border-white/10 mb-3 shadow-sm">
                    <View className="flex-row items-center gap-2 mb-2">
                      <View className={`px-2 py-0.5 rounded-full flex-row items-center gap-1 ${labelColor}`}>
                        {task.type === 'meeting' && (
                          task.meetingType === 'video' 
                            ? <Video size={10} color="#10b981" /> 
                            : <Phone size={10} color="#10b981" />
                        )}
                        <Text className={`text-[9px] font-bold uppercase font-sans ${labelTextColor}`}>
                          {task.type === 'meeting' 
                            ? `Meeting (${task.meetingType === 'video' ? 'Video' : 'Voice'})` 
                            : (task.type || 'task')}
                        </Text>
                      </View>
                      <Text className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase font-sans ${pColor}`}>
                        {task.priority || 'medium'}
                      </Text>
                    </View>
                    <Text className="font-bold text-ink dark:text-[#f4f5fb] text-sm mb-2 font-sans">{task.title}</Text>
                    {task.description ? (
                      <Text className="text-[12px] text-ink-soft dark:text-[#9a9bb6] mb-2 font-sans" numberOfLines={2}>{task.description}</Text>
                    ) : null}
                    <View className="flex-row items-center gap-4">
                      <View className="flex-row items-center gap-1.5">
                        <Clock color="#6c5ce7" size={14} />
                        <Text className="text-[11px] text-ink-soft dark:text-[#9a9bb6] font-medium font-sans">
                          {new Date(task.start_time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} - {new Date(task.end_time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                        </Text>
                      </View>
                      {(task.type === 'meeting' || task.priority === 'high' || task.priority === 'urgent') && (
                        <TouchableOpacity 
                          onPress={() => {
                            startOutgoingCall({ name: task.title, avatar: null }, task.meetingType || 'voice');
                          }}
                          className="bg-purple/10 px-2.5 py-1 rounded-lg flex-row items-center gap-1"
                        >
                          {task.meetingType === 'video' ? <Video size={11} color="#6c5ce7" /> : <Phone size={11} color="#6c5ce7" />}
                          <Text className="text-[10px] font-bold text-purple font-sans">
                            {task.meetingType === 'video' ? 'Video room' : 'Call room'}
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                );
              })
            )}

            {/* Action Items captured from meeting transcripts — collapsible accordion below agenda */}
            {(() => {
              const actionItems = tasks.filter((t: any) => t.source === 'meeting');
              if (actionItems.length === 0) return null;
              const now = Date.now();
              const pendingCount = actionItems.filter((item: any) => item.status !== 'done').length;
              return (
                <View className="mt-4 rounded-2xl border border-black/5 dark:border-white/10 bg-white dark:bg-[#1a1b28] overflow-hidden">
                  <TouchableOpacity
                    onPress={() => setActionItemsOpen(v => !v)}
                    className="flex-row items-center gap-1.5 px-4 py-3"
                    activeOpacity={0.7}
                  >
                    <Check color="#6c5ce7" size={14} />
                    <Text className="text-xs font-bold uppercase tracking-wider text-purple font-sans">Action Items</Text>
                    {pendingCount > 0 && (
                      <View className="bg-purple/10 rounded-full px-1.5 py-0.5">
                        <Text className="text-[10px] font-bold text-purple font-sans">{pendingCount}</Text>
                      </View>
                    )}
                    <Text className="text-[10px] text-ink-soft dark:text-[#9a9bb6] font-sans">from meetings</Text>
                    <View className="ml-auto" style={{ transform: [{ rotate: actionItemsOpen ? '180deg' : '0deg' }] }}>
                      <ChevronDown size={14} color="#9ca3af" />
                    </View>
                  </TouchableOpacity>
                  {actionItemsOpen && (
                    <View className="px-4 pb-4">
                      {actionItems.map((item: any) => {
                        const done = item.status === 'done';
                        const overdue = !done && item.end_time && new Date(item.end_time).getTime() < now;
                        const meetingName = item.meetingRef?.title || (item.description || '').replace(/^From meeting:\s*/, '');
                        const chipColor = done ? '#ecfdf5' : overdue ? '#fef2f2' : '#fefce8';
                        const chipText = done ? '#059669' : overdue ? '#ef4444' : '#ca8a04';
                        return (
                          <View key={item._id || item.id} className="p-3.5 rounded-2xl bg-slate-50 dark:bg-white/5/60 border border-black/5 dark:border-white/10 mb-2 flex-row items-start gap-2.5">
                            <TouchableOpacity
                              onPress={() => handleToggleActionItem(item)}
                              style={{ marginTop: 2, width: 18, height: 18, borderRadius: 6, borderWidth: 1, borderColor: done ? '#10b981' : '#d1d5db', backgroundColor: done ? '#10b981' : 'transparent', alignItems: 'center', justifyContent: 'center' }}
                            >
                              {done && <Check size={11} color="#fff" />}
                            </TouchableOpacity>
                            <View className="flex-1">
                              <Text className={`text-[13px] font-semibold font-sans ${done ? 'line-through text-ink-soft dark:text-[#9a9bb6]' : 'text-ink dark:text-[#f4f5fb]'}`}>{item.title}</Text>
                              <View className="flex-row items-center gap-1.5 mt-1 flex-wrap">
                                <Text style={{ backgroundColor: chipColor, color: chipText }} className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase font-sans">
                                  {done ? 'Done' : overdue ? 'Overdue' : 'Pending'}
                                </Text>
                                {item.assignedToName ? <Text className="text-[10px] text-ink-soft dark:text-[#9a9bb6] font-sans">· {item.assignedToName}</Text> : null}
                                {meetingName ? <Text className="text-[10px] text-ink-soft dark:text-[#9a9bb6] font-sans" numberOfLines={1}>· {meetingName}</Text> : null}
                              </View>
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  )}
                </View>
              );
            })()}
          </View>
        </ScrollView>
      ) : (
        <ScrollView className="flex-1 px-4 pt-4 bg-purple-soft/5" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 130 }}>
          {(logsLoading || meetingsLoading) && unifiedLogs.length === 0 ? (
            <Text className="text-center text-ink-soft dark:text-[#9a9bb6] text-sm mt-12 font-sans">Loading call history…</Text>
          ) : unifiedLogs.length === 0 ? (
            <View className="items-center mt-16">
              <View className="w-16 h-16 rounded-full bg-purple-soft/40 dark:bg-purple/15 items-center justify-center mb-3">
                <Phone color="#6c5ce7" size={26} />
              </View>
              <Text className="text-ink dark:text-[#f4f5fb] font-bold font-sans">No call history yet</Text>
              <Text className="text-ink-soft dark:text-[#9a9bb6] text-xs mt-1 font-sans">Your voice and video calls will show up here.</Text>
            </View>
          ) : (
            unifiedLogs.map((item) => {
              const log = item.raw;
              const isVideo = item.type === 'video';
              const missed = item.missed;
              const whenStr = item.timestamp ? new Date(item.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
              const mins = Math.floor(item.duration / 60);
              const secs = item.duration % 60;
              const durStr = item.duration ? `${mins}:${secs.toString().padStart(2, '0')}` : '';
              const Icon = missed ? PhoneMissed : isVideo ? Video : Phone;
              const hasNotes = !item.isMeeting && !!(log.agenda || log.notes);
              return (
                <TouchableOpacity
                  key={item.id}
                  activeOpacity={0.8}
                  onPress={() => (item.isMeeting ? openMeetingDetail(log) : openLogDetail(log))}
                  className="flex-row items-center bg-white dark:bg-[#1a1b28] rounded-2xl p-3.5 mb-2.5 border border-black/5 dark:border-white/10"
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
                  {hasNotes && <FileText color="#6c5ce7" size={15} style={{ marginRight: 6 }} />}
                  {item.isMeeting ? (
                    <TouchableOpacity onPress={() => openMeetingDetail(log)} className="p-2">
                      <FileText color="#10b981" size={16} />
                    </TouchableOpacity>
                  ) : (
                    <>
                      {/* Revisit (re-call the same room) */}
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
      )}

      {/* Advanced Create Event Modal */}
      <Modal visible={isModalOpen} transparent animationType="slide">
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setIsModalOpen(false)}
          className="flex-1 bg-black/60 justify-end"
        >
          <TouchableOpacity activeOpacity={1} className="bg-white dark:bg-[#1a1b28] rounded-t-3xl p-6 pb-12 shadow-2xl">
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <View>
                <Text className="text-lg font-bold text-ink dark:text-[#f4f5fb]">Schedule Agenda</Text>
                <Text className="text-xs text-ink-soft dark:text-[#9a9bb6]">Plan for {selectedDate.toLocaleDateString('en-US', { dateStyle: 'short' })}</Text>
              </View>
              <TouchableOpacity onPress={() => setIsModalOpen(false)} style={{ padding: 4 }}>
                <X color="#6c5ce7" size={20} />
              </TouchableOpacity>
            </View>
            
            <ScrollView style={{ maxHeight: 400 }} contentContainerStyle={{ gap: 16 }} showsVerticalScrollIndicator={false}>
              <View>
                <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1">Title</Text>
                <TextInput
                  value={title}
                  onChangeText={setTitle}
                  placeholder="e.g. Design Sync Meeting"
                  className="bg-purple-soft/30 dark:bg-white/5 rounded-2xl p-4 text-ink dark:text-[#f4f5fb] border border-black/5 dark:border-white/10"
                />
              </View>

              <View>
                <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1">Description</Text>
                <TextInput
                  value={description}
                  onChangeText={setDescription}
                  placeholder="What is this about?"
                  className="bg-purple-soft/30 dark:bg-white/5 rounded-2xl p-4 text-ink dark:text-[#f4f5fb] border border-black/5 dark:border-white/10"
                  multiline
                  numberOfLines={2}
                />
              </View>

              {type === 'meeting' && (
                <View>
                  <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1">Agenda</Text>
                  <TextInput
                    value={agenda}
                    onChangeText={setAgenda}
                    placeholder="Topics to cover, in order…"
                    className="bg-blue-500/5 rounded-2xl p-4 text-ink dark:text-[#f4f5fb] border border-blue-500/10"
                    multiline
                    numberOfLines={3}
                  />
                </View>
              )}

              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1">Start Time (HH:MM)</Text>
                  <TextInput
                    value={startTimeText}
                    onChangeText={setStartTimeText}
                    placeholder="10:00"
                    className="bg-purple-soft/30 dark:bg-white/5 rounded-2xl p-4 text-ink dark:text-[#f4f5fb] border border-black/5 dark:border-white/10"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1">End Time (HH:MM)</Text>
                  <TextInput
                    value={endTimeText}
                    onChangeText={setEndTimeText}
                    placeholder="11:00"
                    className="bg-purple-soft/30 dark:bg-white/5 rounded-2xl p-4 text-ink dark:text-[#f4f5fb] border border-black/5 dark:border-white/10"
                  />
                </View>
              </View>

              {/* Type Select Tabs */}
              <View>
                <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1.5">Event Type</Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  {['meeting', 'task', 'event'].map(t => {
                    const active = type === t;
                    return (
                      <TouchableOpacity
                        key={t}
                        onPress={() => setType(t as any)}
                        style={{
                          flex: 1,
                          backgroundColor: active ? '#6c5ce7' : 'rgba(108,92,231,0.08)',
                          borderRadius: 12,
                          paddingVertical: 10,
                          alignItems: 'center'
                        }}
                      >
                        <Text style={{ color: active ? '#fff' : '#9a9aab', fontSize: 12, fontFamily: 'Poppins_600SemiBold', textTransform: 'capitalize' }}>
                          {t}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {type === 'meeting' && (
                <View>
                  <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1.5">Meeting Type</Text>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    {['voice', 'video'].map(mt => {
                      const active = meetingType === mt;
                      return (
                        <TouchableOpacity
                          key={mt}
                          onPress={() => setMeetingType(mt as any)}
                          style={{
                            flex: 1,
                            backgroundColor: active ? '#6c5ce7' : 'rgba(108,92,231,0.08)',
                            borderRadius: 12,
                            paddingVertical: 10,
                            alignItems: 'center'
                          }}
                        >
                          <Text style={{ color: active ? '#fff' : '#9a9aab', fontSize: 12, fontFamily: 'Poppins_600SemiBold', textTransform: 'capitalize' }}>
                            {mt === 'voice' ? 'Voice Call' : 'Video Call'}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              )}

              {/* Priority Select Tabs */}
              <View>
                <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1.5">Priority</Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  {['low', 'medium', 'high', 'urgent'].map(p => {
                    const active = priority === p;
                    return (
                      <TouchableOpacity
                        key={p}
                        onPress={() => setPriority(p as any)}
                        style={{
                          flex: 1,
                          backgroundColor: active ? '#6c5ce7' : 'rgba(108,92,231,0.08)',
                          borderRadius: 12,
                          paddingVertical: 10,
                          alignItems: 'center'
                        }}
                      >
                        <Text style={{ color: active ? '#fff' : '#9a9aab', fontSize: 11, fontFamily: 'Poppins_600SemiBold', textTransform: 'capitalize' }}>
                          {p}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            </ScrollView>

            <TouchableOpacity
              onPress={handleCreateEvent}
              className="bg-purple py-4 rounded-xl items-center flex-row justify-center mt-6 shadow-md"
            >
              <Check color="#fff" size={16} />
              <Text className="text-white font-bold ml-2">Create Agenda Event</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ── Meeting detail (tabbed: Summary | Action Items | Transcript) ── */}
      <MeetingDetailModal
        meeting={selectedMeeting}
        loading={meetingDetailLoading}
        onClose={() => setSelectedMeeting(null)}
      />

      {/* ── Call-log detail: revisit + agenda + activity notes ── */}
      <Modal visible={selectedLog !== null} transparent animationType="slide" onRequestClose={() => setSelectedLog(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: 'rgba(31,32,48,0.5)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: '#ffffff', borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 22, maxHeight: '85%' }}>
            <View className="flex-row items-center justify-between mb-1">
              <Text className="text-[18px] font-bold text-ink dark:text-[#f4f5fb] font-sans flex-1" numberOfLines={1}>{selectedLog?.label || 'Call'}</Text>
              <TouchableOpacity onPress={() => setSelectedLog(null)} className="p-1.5"><X size={20} color="#1f2030" /></TouchableOpacity>
            </View>
            <Text className="text-xs text-ink-soft dark:text-[#9a9bb6] font-sans mb-4">
              {selectedLog?.missed ? 'Missed' : selectedLog?.type === 'video' ? 'Video call' : 'Voice call'}
              {selectedLog?.timestamp ? ` · ${new Date(selectedLog.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
              {selectedLog?.duration ? ` · ${Math.floor(selectedLog.duration / 60)}:${String(selectedLog.duration % 60).padStart(2, '0')}` : ''}
            </Text>

            <TouchableOpacity
              onPress={() => { const v = selectedLog?.type === 'video'; setSelectedLog(null); startOutgoingCall({ name: selectedLog?.label || 'Call', avatar: null }, v ? 'video' : 'voice'); }}
              className="flex-row items-center justify-center bg-purple rounded-2xl py-3 mb-5"
            >
              <Phone size={16} color="#fff" style={{ marginRight: 8 }} />
              <Text className="text-white font-bold text-sm font-sans">Revisit call</Text>
            </TouchableOpacity>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24 }}>
              <Text className="text-xs font-bold uppercase tracking-wider text-black/30 dark:text-white/30 mb-1.5 font-sans">Agenda</Text>
              <TextInput
                value={logAgenda}
                onChangeText={setLogAgenda}
                placeholder="What was this call about?"
                placeholderTextColor="#9a9aab"
                multiline
                className="bg-purple-soft/20 rounded-2xl p-3 text-[14px] text-ink dark:text-[#f4f5fb] font-sans mb-5"
                style={{ minHeight: 70, textAlignVertical: 'top' }}
              />

              <Text className="text-xs font-bold uppercase tracking-wider text-black/30 dark:text-white/30 mb-1.5 font-sans">Activity notes</Text>
              <TextInput
                value={logNotes}
                onChangeText={setLogNotes}
                placeholder="Decisions, follow-ups, takeaways…"
                placeholderTextColor="#9a9aab"
                multiline
                className="bg-purple-soft/20 rounded-2xl p-3 text-[14px] text-ink dark:text-[#f4f5fb] font-sans mb-5"
                style={{ minHeight: 110, textAlignVertical: 'top' }}
              />

              <TouchableOpacity onPress={saveLogDetail} disabled={savingLog} className="bg-purple rounded-2xl py-3 items-center" style={{ opacity: savingLog ? 0.6 : 1 }}>
                <Text className="text-white font-bold text-sm font-sans">{savingLog ? 'Saving…' : 'Save notes'}</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

    </SafeAreaView>
  );
}
