import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Modal, TextInput, Alert, Share, ActivityIndicator, Platform, Switch } from 'react-native';
import { Calendar, ChevronLeft, ChevronRight, ChevronDown, Clock, Plus, X, Check, MicOff, PhoneOff, Volume2, Video, FileText, Users, Share2, Sparkles, Repeat, PartyPopper, Mail, Phone, Pencil } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../../lib/theme';
import { useNavigation } from 'expo-router';
import { subscribeToPlusButton } from '../../lib/mockData';
import Svg, { Text as SvgText, Defs, LinearGradient, Stop } from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DateTimePicker from '@react-native-community/datetimepicker';
import { fetchTasks, createTaskFull, updateTaskFull, uploadMeetingRecording, fetchAiDescription, getCalendarEvents, getOrgMembers, suggestRecurrence, detectPatterns, getPendingPatterns, confirmPattern, dismissPattern, fetchMeetings } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { authStorage } from '../../lib/authStorage';
import * as DocumentPicker from 'expo-document-picker';

// Helper to get calendar cells
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
  if (!name) return 'ME';
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

// Calendar dot colors
const COLOR_HOLIDAY = '#f4663b';   // festive orange — public holidays
const COLOR_RECURRING = '#eab308'; // yellow — repeated/recurring events
const COLOR_MEETING = '#22c55e';   // green — meetings
const COLOR_EVENT = '#3b82f6';     // blue — one-off events
const COLOR_TASK = '#6c5ce7';      // purple — tasks

// Resolve a calendar item's dot color. Holidays and recurring items take precedence
// over the plain type so a weekly meeting reads as "recurring (yellow)".
const getDotColor = (item: any): string => {
  if (item?.eventType === 'holiday' || item?.type === 'holiday') return COLOR_HOLIDAY;
  if (item?.isRecurring) return COLOR_RECURRING;
  if (item?.type === 'meeting' || item?.eventType === 'meeting_video' || item?.eventType === 'meeting_audio') return COLOR_MEETING;
  if (item?.type === 'event' || item?.eventType === 'company' || item?.eventType === 'all_day') return COLOR_EVENT;
  return COLOR_TASK;
};

// A calendar item's date works for both tasks (start_time) and calendar events (startTime).
const itemDate = (it: any): Date => new Date(it?.start_time || it?.startTime || Date.now());

// Friendly hour label e.g. "7 PM" used in recurrence suggestions.
const formatHour = (h: number) => {
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric' });
};

// Recurrence summary helpers (plain-language cadence preview).
const formatClock = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const weekdayName = (d: Date) => d.toLocaleDateString([], { weekday: 'long' });
const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// Pre-made event templates the user can tap to prefill the form (one-tap personal events).
const TEMPLATES: { label: string; type: 'meeting' | 'task' | 'event'; start: string; end: string; recurrence: 'none' | 'daily' | 'weekly' | 'monthly'; desc: string }[] = [
  { label: 'Daily Standup', type: 'meeting', start: '09:00', end: '09:15', recurrence: 'daily', desc: 'Quick sync on progress, blockers, and the plan for today.' },
  { label: 'Weekly Sync', type: 'meeting', start: '10:00', end: '11:00', recurrence: 'weekly', desc: 'Team alignment on priorities and updates for the week.' },
  { label: '1:1 Check-in', type: 'meeting', start: '15:00', end: '15:30', recurrence: 'weekly', desc: 'One-on-one check-in.' },
  { label: 'Focus Block', type: 'task', start: '13:00', end: '15:00', recurrence: 'none', desc: 'Deep-work block — no meetings.' },
];

export default function UpdatesScreen() {
  const { colors } = useTheme();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Event creation states
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startTime, setStartTime] = useState<Date>(() => { const d = new Date(); d.setHours(10, 0, 0, 0); return d; });
  const [endTime, setEndTime] = useState<Date>(() => { const d = new Date(); d.setHours(11, 0, 0, 0); return d; });
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);
  const [priority, setPriority] = useState<'low' | 'medium' | 'high' | 'urgent'>('medium');
  const [type, setType] = useState<'meeting' | 'task' | 'event'>('meeting');
  const [recurrence, setRecurrence] = useState<'none' | 'daily' | 'weekly' | 'monthly'>('none');
  const [recipients, setRecipients] = useState<string[]>([]);
  const [externalEmails, setExternalEmails] = useState<string[]>([]);
  const [externalInput, setExternalInput] = useState('');
  const currentUserIdRef = useRef<string | null>(null);
  const [orgMembers, setOrgMembers] = useState<any[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [holidayEvents, setHolidayEvents] = useState<any[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [recSuggestion, setRecSuggestion] = useState<{ recurrence: 'daily' | 'weekly' | 'monthly'; message: string } | null>(null);

  // Sub-tabs: Agenda (calendar + day items) vs Action Items (meeting-sourced tasks).
  const [subTab, setSubTab] = useState<'agenda' | 'actions'>('agenda');

  // Morning Brief digest — the AI-synthesized daily brief (parity with the web
  // dashboard + mobile calendar). Best-effort; hidden if none is available.
  const [digest, setDigest] = useState<any | null>(null);
  const [digestExpanded, setDigestExpanded] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { getDailyDigest } = await import('../../lib/api');
        const d = await getDailyDigest();
        if (!cancelled) setDigest(d?.digest || d?.data || d || null);
      } catch { /* digest is optional */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Real org calendar events (holidays, company events, scheduled meetings) for the
  // visible month + past/live meetings — mirrors the web Events & Meet data flow so the
  // agenda shows the same unified dataset, not just personal tasks.
  const [calendarEvents, setCalendarEvents] = useState<any[]>([]);
  const [meetings, setMeetings] = useState<any[]>([]);

  // Inline edit state for an action item (title + assignee).
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingItemTitle, setEditingItemTitle] = useState('');
  const [editingItemAssignee, setEditingItemAssignee] = useState<string | null>(null);
  const [savingItem, setSavingItem] = useState(false);

  // Recurring-pattern prompts: events the backend saw ≥3 times and asks to make recurring.
  const [pendingPatterns, setPendingPatterns] = useState<any[]>([]);
  const [patternBusyId, setPatternBusyId] = useState<string | null>(null);

  // Calling states
  const [activeCall, setActiveCall] = useState<{ user: any; type: 'voice' | 'video' } | null>(null);
  const [callDuration, setCallDuration] = useState(0);
  const [isCallMuted, setIsCallMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(false);

  // Transcript notification state
  const [transcriptModal, setTranscriptModal] = useState<{
    visible: boolean;
    title: string;
    summary: string;
    actionItems: { text: string; assignedToName?: string }[];
    rawTranscript?: string;
    meetingId?: string;
  }>({
    visible: false,
    title: '',
    summary: '',
    actionItems: [],
  });

  const [isUploading, setIsUploading] = useState(false);

  const handleUploadRecording = async (task: any) => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*',
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const fileAsset = result.assets[0];
      const fileToUpload = {
        uri: fileAsset.uri,
        name: fileAsset.name || 'recording.mp3',
        type: fileAsset.mimeType || 'audio/mpeg',
      } as any;

      setIsUploading(true);
      const res = await uploadMeetingRecording(task._id, fileToUpload);
      setIsUploading(false);

      if (res && res.message) {
        Alert.alert(
          '✨ Audio Transcribed',
          'Aida has successfully processed the audio recording. Check your updates for the summary and action items.',
          [
            {
              text: 'View Transcript',
              onPress: () => {
                setTranscriptModal({
                  visible: true,
                  title: task.title || 'Meeting Transcript',
                  summary: res.summary || 'AI Summary is processing in the background...',
                  actionItems: res.actionItems || [],
                  rawTranscript: res.transcriptRaw || '',
                  meetingId: task._id,
                });
              }
            },
            { text: 'OK' }
          ]
        );
      }
      await syncTasks();
    } catch (err: any) {
      setIsUploading(false);
      Alert.alert('Upload Failed', err.message || 'Could not upload audio file.');
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

  useEffect(() => {
    if (!isFocused) return;

    const unsubscribePlus = subscribeToPlusButton(() => {
      setIsModalOpen(true);
    });

    return () => {
      unsubscribePlus();
    };
  }, [isFocused]);

  // Tasks state
  const [tasks, setTasks] = useState<any[]>([]);

  const handleToggleActionItem = async (task: any) => {
    const id = String(task._id || task.id);
    const next = task.status === 'done' ? 'pending' : 'done';
    setTasks(prev => prev.map(t => (String(t._id || t.id) === id ? { ...t, status: next } : t)));
    try {
      await updateTaskFull(id, { status: next });
    } catch (_) {
      Alert.alert('Error', 'Could not update action item.');
    }
  };

  // Open the inline editor for an action item (edit title + reassign).
  const startEditItem = (item: any) => {
    setEditingItemId(String(item._id || item.id));
    setEditingItemTitle(item.title || '');
    setEditingItemAssignee(item.assignedTo ? String(item.assignedTo?._id || item.assignedTo?.id || item.assignedTo) : null);
  };

  const cancelEditItem = () => {
    setEditingItemId(null);
    setEditingItemTitle('');
    setEditingItemAssignee(null);
  };

  // Persist an edited action item (title + optional assignee) via the tasks endpoint.
  const saveEditItem = async () => {
    if (!editingItemId) return;
    const title = editingItemTitle.trim();
    if (!title) { Alert.alert('Add a title', 'Action item needs a title.'); return; }
    setSavingItem(true);
    const assignee = orgMembers.find((m: any) => String(m.id || m._id) === String(editingItemAssignee));
    const assignedToName = assignee ? (assignee.full_name || assignee.username) : undefined;
    // Optimistic update so the edit feels instant.
    setTasks(prev => prev.map(t => (String(t._id || t.id) === editingItemId
      ? { ...t, title, assignedTo: editingItemAssignee || t.assignedTo, ...(assignedToName ? { assignedToName } : {}) }
      : t)));
    try {
      await updateTaskFull(editingItemId, { title, ...(editingItemAssignee ? { assignedTo: editingItemAssignee } : {}) });
      cancelEditItem();
    } catch (_) {
      Alert.alert('Error', 'Could not save the action item.');
      syncTasks();
    } finally {
      setSavingItem(false);
    }
  };

  const loadCache = async () => {
    try {
      const raw = await AsyncStorage.getItem('bubble_cached_tasks');
      if (raw) {
        setTasks(JSON.parse(raw));
      }
    } catch (err) {
      console.warn("Failed to load cached tasks in updates.tsx:", err);
    }
  };

  const syncTasks = async () => {
    try {
      const response = await fetchTasks();
      const list = Array.isArray(response) ? response : (response?.data || []);
      setTasks(list);
      await AsyncStorage.setItem('bubble_cached_tasks', JSON.stringify(list));
    } catch (err) {
      console.warn("Failed to sync tasks silently in updates.tsx:", err);
    }
  };

  // Pull org calendar events (public holidays) + org members (for the notify-team picker).
  // Holidays are shown read-only on the calendar; both are best-effort and non-blocking.
  const syncAux = async () => {
    try {
      const evRes = await getCalendarEvents({ type: 'holiday' });
      const evList = evRes?.events || evRes?.data || (Array.isArray(evRes) ? evRes : []);
      setHolidayEvents((evList || []).filter((e: any) => e?.eventType === 'holiday'));
    } catch (err) {
      console.warn("Failed to fetch holidays in updates.tsx:", err);
    }
    try {
      const memRes = await getOrgMembers();
      if (memRes?.members) setOrgMembers(memRes.members);
    } catch (err) {
      console.warn("Failed to fetch org members in updates.tsx:", err);
    }
    try {
      const { chatCache } = await import('../../lib/chatCache');
      const cached = await chatCache.getCachedChats();
      setGroups((cached || []).filter((c: any) => c.isGroupChat));
      const cachedContacts = await chatCache.getCachedContacts();
      setContacts(cachedContacts || []);
    } catch (err) {
      console.warn("Failed to load groups/contacts in updates.tsx:", err);
    }
  };

  // Real org calendar events for the visible month + meetings — mirrors the web
  // Events & Meet queries (getCalendarEvents({start,end}) + fetchMeetings) so the
  // agenda and calendar dots reflect the same unified dataset across clients.
  const syncCalendar = React.useCallback(async () => {
    try {
      const start = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
      const end = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0, 23, 59, 59);
      const evRes: any = await getCalendarEvents({ start: start.toISOString(), end: end.toISOString() });
      const evList = evRes?.events || evRes?.data || (Array.isArray(evRes) ? evRes : []);
      setCalendarEvents(Array.isArray(evList) ? evList : []);
    } catch (err) {
      console.warn('Failed to fetch calendar events in updates.tsx:', err);
    }
    try {
      const mRes: any = await fetchMeetings(1, 50);
      setMeetings(Array.isArray(mRes?.meetings) ? mRes.meetings : (Array.isArray(mRes) ? mRes : []));
    } catch (err) {
      console.warn('Failed to fetch meetings in updates.tsx:', err);
    }
  }, [currentDate]);

  // Combined people you can notify directly: org teammates + saved contacts (deduped by id).
  const peopleToNotify = (() => {
    const map = new Map<string, any>();
    for (const m of orgMembers) map.set(String(m.id || m._id), m);
    for (const c of contacts) {
      const id = String(c.id || c._id);
      if (!map.has(id)) map.set(id, c);
    }
    return Array.from(map.values());
  })();

  // Expand selected groups → their member user-ids, unioned with individually picked recipients.
  const memberIdsOf = (group: any): string[] =>
    (group?.users || []).map((u: any) => String(u?.id || u?._id || u)).filter(Boolean);

  const resolveRecipients = (): string[] => {
    const ids = new Set<string>(recipients);
    for (const gid of selectedGroupIds) {
      const g = groups.find((x) => String(x.id || x._id) === String(gid));
      if (g) memberIdsOf(g).forEach((id) => ids.add(id));
    }
    // Always include the creator — you're a participant in your own agenda by default.
    if (currentUserIdRef.current) ids.add(String(currentUserIdRef.current));
    return Array.from(ids);
  };

  const toggleGroup = (id: string) => {
    setSelectedGroupIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const addExternalEmail = () => {
    const email = externalInput.trim().toLowerCase();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      Alert.alert('Invalid email', 'Enter a valid email address.');
      return;
    }
    setExternalEmails((prev) => (prev.includes(email) ? prev : [...prev, email]));
    setExternalInput('');
  };

  useEffect(() => {
    authStorage.getUser().then((u) => {
      if (u) currentUserIdRef.current = String(u.id || u._id);
    });
  }, []);

  // Load recurring-pattern prompts. Kick a fresh detection first (best-effort), then
  // pull the pending list for the in-app banner.
  const syncPatterns = async () => {
    try {
      await detectPatterns().catch(() => undefined);
      const res = await getPendingPatterns();
      setPendingPatterns(res?.patterns || []);
    } catch (err) {
      console.warn('Failed to load recurring patterns in updates.tsx:', err);
    }
  };

  const handleConfirmPattern = async (p: any) => {
    const id = String(p._id || p.id);
    setPatternBusyId(id);
    try {
      await confirmPattern(id);
      setPendingPatterns(prev => prev.filter(x => String(x._id || x.id) !== id));
      await syncTasks(); // recurring flag back-filled server-side — refresh the calendar
      Alert.alert('Set up', `"${p.exampleTitle || 'Event'}" is now a recurring event.`);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Could not set up the recurring event.');
    } finally {
      setPatternBusyId(null);
    }
  };

  const handleDismissPattern = async (p: any) => {
    const id = String(p._id || p.id);
    setPatternBusyId(id);
    // Optimistic: drop it immediately so the banner feels responsive.
    setPendingPatterns(prev => prev.filter(x => String(x._id || x.id) !== id));
    try {
      await dismissPattern(id);
    } catch {
      /* best-effort — if it fails it'll reappear on next detect */
    } finally {
      setPatternBusyId(null);
    }
  };

  useEffect(() => {
    loadCache();
    syncTasks();
    syncAux();
    syncPatterns();
  }, []);

  // Re-pull org events + meetings whenever the visible month changes (and on mount).
  useEffect(() => { syncCalendar(); }, [syncCalendar]);

  useEffect(() => {
    if (!isFocused) return;
    const interval = setInterval(syncTasks, 7000);
    return () => clearInterval(interval);
  }, [isFocused]);

  // Meetings we've already shown the "Meeting Ended" alert for this session —
  // the backend fires the event several times per meeting (room + personal
  // rooms + the post-AI enriched re-emit).
  const alertedMeetingsRef = useRef<Set<string>>(new Set());

  // Listen for meeting_ended socket event to show transcript notification
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onMeetingEnded = async (data: {
      roomId: string;
      meetingId?: string;
      title?: string;
      summary?: string;
      actionItems?: { text: string; assignedToName?: string }[];
      rawTranscript?: string;
    }) => {
      // The backend emits meeting_ended MULTIPLE times per meeting (to the room
      // + each participant's personal room, and again enriched after the AI
      // pass) — alert exactly ONCE per meeting or the popup keeps reappearing
      // after the user already dismissed it.
      const meetingKey = String(data.meetingId || data.roomId || '');
      if (meetingKey && alertedMeetingsRef.current.has(meetingKey)) return;
      if (meetingKey) alertedMeetingsRef.current.add(meetingKey);

      // Fetch full meeting details if we have meetingId
      let summary = data.summary || '';
      let actionItems = data.actionItems || [];
      let rawTranscript = data.rawTranscript || '';

      if (data.meetingId) {
        try {
          const { fetchMeetingById } = await import('../../lib/api');
          const res = await fetchMeetingById(data.meetingId);
          const m = res?.meeting;
          if (m) {
            summary = m.summary || '';
            actionItems = m.actionItems || [];
            rawTranscript = m.transcriptRaw || '';
          }
        } catch (_) {}
      }

      Alert.alert(
        '📋 Meeting Ended',
        `"${data.title || 'The meeting'}" has finished. Tap to view transcript & minutes.`,
        [
          { text: 'Later', style: 'cancel' },
          {
            text: 'View Transcript',
            onPress: () => {
              setTranscriptModal({
                visible: true,
                title: data.title || 'Meeting Transcript',
                summary,
                actionItems,
                rawTranscript,
                meetingId: data.meetingId,
              });
            },
          },
        ]
      );

      // Refresh tasks + meetings since new ones may have been created from action items
      await syncTasks();
      await syncCalendar();
    };

    socket.on('meeting_ended', onMeetingEnded);
    return () => {
      socket.off('meeting_ended', onMeetingEnded);
    };
  }, []);

  useEffect(() => {
    let timer: any;
    if (activeCall) {
      setCallDuration(0);
      timer = setInterval(() => {
        setCallDuration((prev) => prev + 1);
      }, 1000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [activeCall]);

  const formatDuration = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const secs = sec % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const cells = getCalendarCells(currentDate);

  const prevMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
  const nextMonth = () => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
  const isSelected = (date: Date) => date.toDateString() === selectedDate.toDateString();
  const isToday = (date: Date) => date.toDateString() === new Date().toDateString();

  const selectedDayTasks = tasks.filter(t => new Date(t.start_time).toDateString() === selectedDate.toDateString());
  const selectedDayHolidays = holidayEvents.filter(h => itemDate(h).toDateString() === selectedDate.toDateString());

  // Merge month org events with the holiday set, de-duped by _id (mirrors web allCalEvents).
  const allCalEvents = React.useMemo(() => {
    const ids = new Set(calendarEvents.map((e: any) => String(e._id)));
    const extraHolidays = holidayEvents.filter((h: any) => !ids.has(String(h._id)));
    return [...calendarEvents, ...extraHolidays];
  }, [calendarEvents, holidayEvents]);

  // Org calendar events for the selected day, normalized to task shape so the agenda
  // renders tasks + org events in one merged list (web selectedDayCalEvents parity).
  // These aren't Task records, so they're read-only (isOrgEvent: true).
  const selectedDayCalEvents = allCalEvents
    .filter((ev: any) => ev?.eventType !== 'holiday' && new Date(ev.startTime).toDateString() === selectedDate.toDateString())
    .map((ev: any) => ({
      _id: ev._id,
      title: ev.title,
      description: ev.summary || ev.description || ev.agenda || '',
      start_time: ev.startTime,
      end_time: ev.endTime,
      eventType: ev.eventType,
      status: ev.status,
      recipients: ev.attendees,
      isOrgEvent: true,
    }));

  // Unified agenda list: personal tasks + org events, sorted by start time.
  const selectedDayItems = [...selectedDayTasks, ...selectedDayCalEvents].sort(
    (a: any, b: any) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
  );

  // Past/live meetings that occurred on the selected day (web dayMeetings parity).
  const selectedDayMeetings = meetings.filter((m: any) => {
    const d = new Date(m.startedAt || m.createdAt);
    return d.toDateString() === selectedDate.toDateString();
  });

  // Meeting-sourced action items — the Action Items tab dataset.
  const meetingActionItems = tasks.filter((t: any) => t.source === 'meeting');

  // Upcoming holidays (next 90 days) — used as one-tap "pre-made" templates.
  const upcomingHolidays = holidayEvents
    .filter(h => { const d = itemDate(h); const now = new Date(); return d >= new Date(now.toDateString()) && d.getTime() - now.getTime() < 90 * 86400000; })
    .sort((a, b) => itemDate(a).getTime() - itemDate(b).getTime())
    .slice(0, 6);

  // Check if any high priority meeting is happening right now to show as a quick join option
  const activeNowMeeting = tasks.find(t => {
    if (t.type !== 'meeting' || (t.priority !== 'high' && t.priority !== 'urgent')) return false;
    const start = new Date(t.start_time).getTime();
    const end = new Date(t.end_time).getTime();
    const now = Date.now();
    return now >= start && now <= end;
  });

  // Combine the selected calendar day with a chosen time-of-day.
  const combineDayAndTime = (day: Date, t: Date) => {
    const d = new Date(day);
    d.setHours(t.getHours(), t.getMinutes(), 0, 0);
    return d;
  };

  const resetEventForm = () => {
    setTitle('');
    setDescription('');
    const s = new Date(); s.setHours(10, 0, 0, 0); setStartTime(s);
    const e = new Date(); e.setHours(11, 0, 0, 0); setEndTime(e);
    setPriority('medium');
    setType('meeting');
    setRecurrence('none');
    setRecipients([]);
    setExternalEmails([]);
    setExternalInput('');
    setSelectedGroupIds([]);
    setRecSuggestion(null);
  };

  const toggleRecipient = (id: string) => {
    setRecipients(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  // AI-describe: ask DeepSeek (via the existing endpoint) to write a description from the title.
  const runAiDescribe = async () => {
    const prompt = title.trim() || description.trim();
    if (!prompt) { Alert.alert('Add a title', 'Type an event title first so the AI knows what to describe.'); return; }
    setAiLoading(true);
    try {
      const res = await fetchAiDescription(prompt);
      const desc = res?.description || res?.data?.description;
      if (desc) setDescription(desc);
      else Alert.alert('AI', 'Could not generate a description right now.');
    } catch (err: any) {
      Alert.alert('AI', err.message || 'Could not generate a description.');
    } finally {
      setAiLoading(false);
    }
  };

  // Prefill the form from a pre-made template.
  const applyTemplate = (tpl: typeof TEMPLATES[number]) => {
    setTitle(tpl.label);
    setType(tpl.type);
    setDescription(tpl.desc);
    setRecurrence(tpl.recurrence);
    const [sH, sM] = tpl.start.split(':').map(Number);
    const [eH, eM] = tpl.end.split(':').map(Number);
    const s = new Date(); s.setHours(sH, sM, 0, 0); setStartTime(s);
    const e = new Date(); e.setHours(eH, eM, 0, 0); setEndTime(e);
  };

  const handleCreateEvent = async () => {
    if (!title.trim()) {
      Alert.alert('Validation Error', 'Please enter a title for the event.');
      return;
    }

    try {
      const start = combineDayAndTime(selectedDate, startTime);
      const end = combineDayAndTime(selectedDate, endTime);
      if (end <= start) {
        Alert.alert('Check times', 'End time must be after the start time.');
        return;
      }

      const finalRecipients = resolveRecipients();
      const payload: any = {
        title: title.trim(),
        description: description.trim(),
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        priority,
        type,
        isRecurring: recurrence !== 'none',
        ...(recurrence !== 'none' ? { recurrence } : {}),
        ...(finalRecipients.length ? { recipients: finalRecipients } : {}),
        ...(externalEmails.length ? { externalEmails } : {}),
      };

      await createTaskFull(payload);

      const wasUrgentMeeting = (priority === 'high' || priority === 'urgent') && type === 'meeting';
      const eventTitle = payload.title;
      const notifiedCount = finalRecipients.length;

      resetEventForm();
      setIsModalOpen(false);
      await syncTasks();

      // If urgent meeting scheduled immediately, prompt trigger
      if (wasUrgentMeeting) {
        Alert.alert(
          'Priority Meeting Scheduled',
          notifiedCount > 0
            ? `${notifiedCount} teammate(s) are notified to come online for this call.`
            : 'This priority meeting is on your calendar.',
          [
            { text: 'Later', style: 'cancel' },
            {
              text: 'Start Call Now',
              onPress: () => {
                setActiveCall({
                  user: { name: eventTitle, avatar: null },
                  type: 'voice'
                });
              }
            }
          ]
        );
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to create event.');
    }
  };

  // Smart recurrence suggestion: when the typed event repeats a past pattern (same title +
  // start hour seen before), suggest making it recurring. DeepSeek-phrased, local fallback.
  useEffect(() => {
    if (!isModalOpen || recurrence !== 'none' || title.trim().length < 3) { setRecSuggestion(null); return; }
    const hour = startTime.getHours();
    const norm = (s: string) => (s || '').trim().toLowerCase();
    const priorMatches = tasks.filter(t => norm(t.title) === norm(title) && new Date(t.start_time).getHours() === hour);
    if (priorMatches.length < 1) { setRecSuggestion(null); return; }
    let cancelled = false;
    const handle = setTimeout(async () => {
      let suggestion: { recurrence: 'daily' | 'weekly' | 'monthly'; message: string } = {
        recurrence: 'weekly',
        message: `You schedule "${title.trim()}" around ${formatHour(hour)} often — repeat it weekly?`,
      };
      try {
        const res = await suggestRecurrence({
          title: title.trim(),
          startTime: startTime.toISOString(),
          recentEvents: tasks.slice(0, 25).map(t => ({ title: t.title, start_time: t.start_time })),
        });
        if (res?.suggest && res.recurrence) suggestion = { recurrence: res.recurrence, message: res.message || suggestion.message };
      } catch { /* fall back to local phrasing */ }
      if (!cancelled) setRecSuggestion(suggestion);
    }, 600);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [title, startTime, isModalOpen, recurrence, tasks]);

  return (
    <SafeAreaView className="flex-1" edges={['top']} style={{ backgroundColor: colors.bg }}>
      <View className="flex-row items-center justify-between px-6 pt-5 pb-3 border-b border-black/5 dark:border-white/10">
        <View>
          <Svg height="36" width="140">
            <Defs>
              <LinearGradient id="updatesGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <Stop offset="0%" stopColor="#6c5ce7" />
                <Stop offset="100%" stopColor="rgba(108,92,231,0.6)" />
              </LinearGradient>
            </Defs>
            <SvgText
              fill="url(#updatesGrad)"
              fontSize="26"
              fontFamily="SpaceGrotesk_700Bold"
              x="0"
              y="26"
              letterSpacing="-0.5"
            >
              Updates
            </SvgText>
          </Svg>
          <Text className="text-xs text-ink-soft dark:text-[#9a9bb6] font-sans mt-0.5">Plan and sync team agendas</Text>
        </View>
        <TouchableOpacity
          onPress={() => setIsModalOpen(true)}
          className="flex-row items-center bg-purple px-4 py-2.5 rounded-xl shadow-sm"
        >
          <Plus color="#fff" size={16} />
          <Text className="text-white text-xs font-bold font-sans ml-1">Add Event</Text>
        </TouchableOpacity>
      </View>

      <ScrollView className="flex-1" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 130 }}>
        {/* Banner if priority meeting is live */}
        {activeNowMeeting && (
          <TouchableOpacity
            onPress={() => {
              setActiveCall({
                user: { name: activeNowMeeting.title, avatar: null },
                type: 'video'
              });
            }}
            className="mx-4 mt-4 bg-red-500 rounded-2xl p-4 flex-row items-center justify-between shadow-md shadow-red-500/20"
          >
            <View className="flex-1 mr-3">
              <Text className="text-white font-bold text-xs uppercase tracking-widest">🔴 LIVE TEAM CALL ACTIVE</Text>
              <Text className="text-white font-bold text-sm mt-1" numberOfLines={1}>{activeNowMeeting.title}</Text>
            </View>
            <View className="bg-white dark:bg-[#1a1b28] px-4 py-2 rounded-xl">
              <Text className="text-red-500 text-xs font-bold font-sans">JOIN NOW</Text>
            </View>
          </TouchableOpacity>
        )}

        {/* Recurring-pattern prompts: "this happened 3+ times — make it recurring?" */}
        {pendingPatterns.map((p: any) => {
          const id = String(p._id || p.id);
          const busy = patternBusyId === id;
          return (
            <View
              key={id}
              className="mx-4 mt-4 rounded-2xl p-4 border"
              style={{ backgroundColor: '#fef9c3', borderColor: '#eab308' }}
            >
              <View className="flex-row items-center mb-2">
                <Repeat color="#ca8a04" size={16} />
                <Text style={{ color: '#854d0e' }} className="font-bold text-[11px] uppercase tracking-widest ml-2">
                  Recurring pattern detected
                </Text>
              </View>
              <Text style={{ color: '#713f12' }} className="text-sm font-sans mb-3">
                You've had <Text className="font-bold">"{p.exampleTitle || 'this event'}"</Text>
                {p.occurrences ? ` ${p.occurrences} times` : ' several times'}. Set it up as a recurring event?
              </Text>
              <View className="flex-row gap-2">
                <TouchableOpacity
                  onPress={() => handleConfirmPattern(p)}
                  disabled={busy}
                  className="flex-1 rounded-xl py-2.5 items-center"
                  style={{ backgroundColor: '#ca8a04', opacity: busy ? 0.6 : 1 }}
                >
                  <Text className="text-white font-bold text-xs font-sans">{busy ? 'Setting up…' : 'Set up recurring'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => handleDismissPattern(p)}
                  disabled={busy}
                  className="rounded-xl py-2.5 px-4 items-center"
                  style={{ backgroundColor: 'rgba(0,0,0,0.06)' }}
                >
                  <Text style={{ color: '#713f12' }} className="font-bold text-xs font-sans">Dismiss</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        })}

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
              <Text key={day} className="text-[10px] font-bold text-black/30 dark:text-white/40 uppercase flex-1 text-center font-sans">{day}</Text>
            ))}
          </View>

          <View className="flex-row flex-wrap">
            {cells.map((cell, idx) => {
              const selected = isSelected(cell.date);
              const today = isToday(cell.date);
              const dayTasks = tasks.filter(t => new Date(t.start_time).toDateString() === cell.date.toDateString());
              const dayHolidays = holidayEvents.filter(h => itemDate(h).toDateString() === cell.date.toDateString());
              const dayCalEvents = calendarEvents.filter((e: any) => e?.eventType !== 'holiday' && new Date(e.startTime).toDateString() === cell.date.toDateString());
              const dayItems = [...dayTasks, ...dayHolidays, ...dayCalEvents];
              const hasMeeting = dayItems.length > 0;

              return (
                <TouchableOpacity
                  key={idx}
                  onPress={() => setSelectedDate(cell.date)}
                  className="w-[14.28%] aspect-square p-1"
                >
                  <View className={`flex-1 rounded-[14px] p-1.5 justify-between border ${
                    selected ? 'bg-purple border-purple' :
                    today ? 'border-purple/50 bg-purple/5' :
                    cell.isCurrentMonth ? 'bg-white dark:bg-[#1a1b28] border-black/5 dark:border-white/10' : 'bg-slate-50 dark:bg-[#23243a] border-black/5 dark:border-white/10 opacity-50'
                  }`}>
                    <Text className={`text-xs font-bold font-sans ${selected ? 'text-white' : 'text-ink dark:text-[#f4f5fb]'}`}>
                      {cell.date.getDate()}
                    </Text>
                    {hasMeeting && (
                      <View className="flex-row gap-0.5 mt-auto flex-wrap">
                        {dayItems.slice(0, 4).map((t, i) => (
                          <View key={t._id || i} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: selected ? '#ffffff' : getDotColor(t), marginRight: 1 }} />
                        ))}
                      </View>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Sub-tabs: Agenda | Action Items (mirrors the web Events & Meet surface). */}
        <View className="flex-row px-6 pt-4 gap-6 border-b border-black/5 dark:border-white/10">
          {([
            { key: 'agenda', label: 'Agenda' },
            { key: 'actions', label: `Action Items${meetingActionItems.length ? ` (${meetingActionItems.length})` : ''}` },
          ] as const).map(t => {
            const active = subTab === t.key;
            return (
              <TouchableOpacity key={t.key} onPress={() => setSubTab(t.key)} className={`pb-3 border-b-2 ${active ? 'border-purple' : 'border-transparent'}`}>
                <Text className={`text-sm font-bold font-sans ${active ? 'text-purple' : 'text-ink-soft dark:text-[#9a9bb6]'}`}>{t.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {subTab === 'agenda' ? (
        <View className="p-6">
          {/* Morning Brief — AI daily digest, aligned with calendar/web dashboards */}
          {digest?.morningBrief ? (
            <View style={{ borderLeftWidth: 3, borderLeftColor: COLOR_TASK }} className="p-4 rounded-2xl bg-purple-50/60 dark:bg-white/[0.04] border border-purple-100 dark:border-white/10 mb-4">
              <TouchableOpacity onPress={() => setDigestExpanded(e => !e)} activeOpacity={0.8} className="flex-row items-center justify-between">
                <View className="flex-row items-center gap-1.5">
                  <Sparkles size={14} color={COLOR_TASK} />
                  <Text style={{ color: COLOR_TASK }} className="text-[11px] font-bold uppercase font-sans">Morning Brief</Text>
                </View>
                <ChevronDown size={16} color="#9a9aab" style={{ transform: [{ rotate: digestExpanded ? '180deg' : '0deg' }] }} />
              </TouchableOpacity>
              {digestExpanded && (
                <Text className="text-[13px] text-ink dark:text-[#f4f5fb] mt-2 font-sans leading-5">{digest.morningBrief}</Text>
              )}
            </View>
          ) : null}

          <Text className="text-xs font-bold uppercase tracking-wider text-black/30 dark:text-white/40 italic mb-1 font-sans">Agenda for</Text>
          <Text className="text-lg font-bold text-ink dark:text-[#f4f5fb] mb-3 font-sans">{selectedDate.toLocaleDateString('en-US', { dateStyle: 'medium' })}</Text>

          {/* Dot legend */}
          <View className="flex-row flex-wrap gap-x-3 gap-y-1 mb-4">
            {[
              { c: COLOR_MEETING, l: 'Meeting' },
              { c: COLOR_RECURRING, l: 'Recurring' },
              { c: COLOR_HOLIDAY, l: 'Holiday' },
              { c: COLOR_EVENT, l: 'Event' },
              { c: COLOR_TASK, l: 'Task' },
            ].map(item => (
              <View key={item.l} className="flex-row items-center gap-1">
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: item.c }} />
                <Text className="text-[10px] text-ink-soft dark:text-[#9a9bb6] font-sans">{item.l}</Text>
              </View>
            ))}
          </View>

          {/* Public holidays for the day (read-only) */}
          {selectedDayHolidays.map((h, i) => (
            <View key={h._id || `hol-${i}`} style={{ borderLeftWidth: 3, borderLeftColor: COLOR_HOLIDAY }} className="p-4 rounded-2xl bg-orange-50/60 border border-orange-100 mb-3">
              <View className="flex-row items-center gap-1.5 mb-1">
                <PartyPopper size={13} color={COLOR_HOLIDAY} />
                <Text style={{ color: COLOR_HOLIDAY }} className="text-[9px] font-bold uppercase font-sans">Public Holiday</Text>
              </View>
              <Text className="font-bold text-ink dark:text-[#f4f5fb] text-sm font-sans">{h.title}</Text>
              {h.description ? <Text className="text-[12px] text-ink-soft dark:text-[#9a9bb6] mt-1 font-sans" numberOfLines={2}>{h.description}</Text> : null}
            </View>
          ))}

          {selectedDayItems.length === 0 && selectedDayHolidays.length === 0 && selectedDayMeetings.length === 0 ? (
            <View className="py-10 border-2 border-dashed border-black/5 dark:border-white/10 rounded-[24px] bg-white/50 dark:bg-white/[0.04] items-center justify-center">
              <Calendar color="#6c5ce7" size={20} opacity={0.3} className="mb-2" />
              <Text className="text-sm text-ink-soft dark:text-[#9a9bb6] font-medium font-sans">No events scheduled.</Text>
            </View>
          ) : (
            selectedDayItems.map((task: any) => {
              const isOrg = !!task.isOrgEvent;
              const orgLabel = task.eventType === 'meeting_video' ? 'Meeting · Video'
                : task.eventType === 'meeting_audio' ? 'Meeting · Audio'
                : task.eventType === 'company' ? 'Company'
                : task.eventType === 'all_day' ? 'All Day' : (task.eventType || 'event');
              const typeLabel = (task.type === 'meeting' || task.eventType?.startsWith('meeting')) ? { bg: '#eff6ff', text: '#3b82f6' } : (task.type === 'event' || isOrg) ? { bg: '#f0fdf4', text: '#22c55e' } : { bg: '#fefce8', text: '#ca8a04' };
              const pColor = task.priority === 'urgent' || task.priority === 'high' ? 'bg-red-50 text-red-600' : 'bg-yellow-50 text-yellow-600';
              return (
                <View key={task._id} style={{ borderLeftWidth: 3, borderLeftColor: getDotColor(task) }} className="p-4 rounded-2xl bg-white dark:bg-[#1a1b28] border border-black/5 dark:border-white/10 mb-3 shadow-sm">
                  <View className="flex-row items-center gap-2 mb-2">
                    <Text style={{ backgroundColor: typeLabel.bg, color: typeLabel.text }} className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase font-sans">
                      {isOrg ? orgLabel : (task.type || 'task')}
                    </Text>
                    {!isOrg && (
                      <Text className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase font-sans ${pColor}`}>
                        {task.priority || 'medium'}
                      </Text>
                    )}
                    {isOrg && <Text className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase font-sans bg-slate-100 text-slate-500">Org</Text>}
                    {task.isRecurring && (
                      <View className="flex-row items-center gap-1 px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(234,179,8,0.14)' }}>
                        <Repeat size={9} color="#a16207" />
                        <Text className="text-[9px] font-bold uppercase font-sans" style={{ color: '#a16207' }}>{task.recurrence || 'repeats'}</Text>
                      </View>
                    )}
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
                    {!isOrg && (task.type === 'meeting' || task.priority === 'high' || task.priority === 'urgent') && (
                      <TouchableOpacity
                        onPress={() => {
                          setActiveCall({ user: { name: task.title, avatar: null }, type: 'voice' });
                        }}
                        className="bg-purple/10 px-2.5 py-1 rounded-lg"
                      >
                        <Text className="text-[10px] font-bold text-purple font-sans">Call room</Text>
                      </TouchableOpacity>
                    )}
                    {!isOrg && task.type === 'meeting' && (
                      <TouchableOpacity
                        onPress={() => handleUploadRecording(task)}
                        className="bg-purple-soft/80 px-2.5 py-1 rounded-lg flex-row items-center"
                        style={{ gap: 4 }}
                      >
                        <FileText size={10} color="#6c5ce7" />
                        <Text className="text-[10px] font-bold text-purple font-sans">Upload Audio</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              );
            })
          )}

          {/* Meetings that happened / are live on this day — tap to view minutes. */}
          {selectedDayMeetings.length > 0 && (
            <View className="mt-2">
              <Text className="text-[10px] font-bold uppercase tracking-wider text-black/30 dark:text-white/40 mb-2 font-sans">Meetings this day</Text>
              {selectedDayMeetings.map((m: any) => {
                const isLive = m.status === 'live';
                const aiCount = Array.isArray(m.actionItems) ? m.actionItems.length : 0;
                return (
                  <TouchableOpacity
                    key={String(m._id || m.id)}
                    onPress={() => setTranscriptModal({
                      visible: true,
                      title: m.title || 'Meeting',
                      summary: m.summary || '',
                      actionItems: Array.isArray(m.actionItems) ? m.actionItems.map((ai: any) => ({ text: ai.text || ai.title || String(ai), assignedToName: ai.assignedToName || ai.assignedTo?.full_name })) : [],
                      rawTranscript: m.transcriptRaw || '',
                      meetingId: String(m._id || m.id),
                    })}
                    style={{ borderLeftWidth: 3, borderLeftColor: COLOR_MEETING }}
                    className="p-4 rounded-2xl bg-white dark:bg-[#1a1b28] border border-black/5 dark:border-white/10 mb-3 shadow-sm"
                  >
                    <View className="flex-row items-center justify-between">
                      <Text className="font-bold text-ink dark:text-[#f4f5fb] text-sm font-sans flex-1" numberOfLines={1}>{m.title || 'Untitled Meeting'}</Text>
                      {isLive && (
                        <View className="flex-row items-center bg-emerald-500/10 px-2 py-0.5 rounded-full ml-2">
                          <View className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5" />
                          <Text className="text-[9px] font-bold text-emerald-600 font-sans">LIVE</Text>
                        </View>
                      )}
                    </View>
                    {m.summary ? (
                      <Text className="text-[12px] text-ink-soft dark:text-[#9a9bb6] mt-1 font-sans" numberOfLines={2}>{m.summary}</Text>
                    ) : null}
                    <View className="flex-row items-center gap-3 mt-2">
                      {m.startedAt ? (
                        <Text className="text-[10px] text-ink-soft dark:text-[#9a9bb6] font-sans">{new Date(m.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
                      ) : null}
                      {aiCount > 0 && (
                        <View className="bg-purple/10 px-2 py-0.5 rounded-full">
                          <Text className="text-[9px] font-bold text-purple font-sans">{aiCount} ACTION ITEMS</Text>
                        </View>
                      )}
                      <View className="flex-row items-center gap-1">
                        <FileText size={11} color="#6c5ce7" />
                        <Text className="text-[10px] font-bold text-purple font-sans">View minutes</Text>
                      </View>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </View>
        ) : (
        /* ── Action Items tab: meeting-sourced items, editable ── */
        <View className="p-6">
          <Text className="text-xs font-bold uppercase tracking-wider text-black/30 dark:text-white/40 italic mb-1 font-sans">Action Items</Text>
          <Text className="text-lg font-bold text-ink dark:text-[#f4f5fb] mb-3 font-sans">From your meetings</Text>

          {meetingActionItems.length === 0 ? (
            <View className="py-10 border-2 border-dashed border-black/5 dark:border-white/10 rounded-[24px] bg-white/50 dark:bg-white/[0.04] items-center justify-center">
              <Check color="#6c5ce7" size={20} opacity={0.3} />
              <Text className="text-sm text-ink-soft dark:text-[#9a9bb6] font-medium font-sans mt-2">No action items from meetings yet.</Text>
            </View>
          ) : (
            meetingActionItems.map((item: any) => {
              const id = String(item._id || item.id);
              const done = item.status === 'done';
              const now = Date.now();
              const overdue = !done && item.end_time && new Date(item.end_time).getTime() < now;
              const meetingName = item.meetingRef?.title || (item.description || '').replace(/^From meeting:\s*/, '');
              const chipBg = done ? '#ecfdf5' : overdue ? '#fef2f2' : '#fefce8';
              const chipFg = done ? '#059669' : overdue ? '#ef4444' : '#ca8a04';
              const isEditing = editingItemId === id;
              return (
                <View key={id} style={{ padding: 14, borderRadius: 16, backgroundColor: 'rgba(248,248,252,0.8)', borderWidth: 1, borderColor: 'rgba(0,0,0,0.05)', marginBottom: 8 }}>
                  {isEditing ? (
                    <View style={{ gap: 10 }}>
                      <TextInput
                        value={editingItemTitle}
                        onChangeText={setEditingItemTitle}
                        placeholder="Action item"
                        placeholderTextColor="#9ca3af"
                        multiline
                        style={{ backgroundColor: '#fff', borderRadius: 12, padding: 12, fontSize: 13, color: '#1f2030', borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)', fontFamily: 'Poppins_400Regular' }}
                      />
                      <Text style={{ fontSize: 10, fontFamily: 'Poppins_700Bold', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.4 }}>Assign to</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                        <TouchableOpacity
                          onPress={() => setEditingItemAssignee(null)}
                          style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: editingItemAssignee ? 'rgba(108,92,231,0.08)' : '#6c5ce7' }}
                        >
                          <Text style={{ fontSize: 11, fontFamily: 'Poppins_600SemiBold', color: editingItemAssignee ? '#6c5ce7' : '#fff' }}>Unassigned</Text>
                        </TouchableOpacity>
                        {orgMembers.map((mem: any) => {
                          const mid = String(mem.id || mem._id);
                          const active = String(editingItemAssignee) === mid;
                          return (
                            <TouchableOpacity
                              key={mid}
                              onPress={() => setEditingItemAssignee(mid)}
                              style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: active ? '#6c5ce7' : 'rgba(108,92,231,0.08)' }}
                            >
                              <Text style={{ fontSize: 11, fontFamily: 'Poppins_600SemiBold', color: active ? '#fff' : '#6c5ce7' }} numberOfLines={1}>{mem.full_name || mem.username}</Text>
                            </TouchableOpacity>
                          );
                        })}
                      </ScrollView>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <TouchableOpacity onPress={cancelEditItem} style={{ flex: 1, paddingVertical: 10, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(0,0,0,0.1)' }}>
                          <Text style={{ fontSize: 12, fontFamily: 'Poppins_700Bold', color: '#9ca3af' }}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={saveEditItem} disabled={savingItem} style={{ flex: 1, paddingVertical: 10, borderRadius: 12, alignItems: 'center', backgroundColor: '#6c5ce7', opacity: savingItem ? 0.6 : 1 }}>
                          <Text style={{ fontSize: 12, fontFamily: 'Poppins_700Bold', color: '#fff' }}>{savingItem ? 'Saving…' : 'Save'}</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  ) : (
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                      <TouchableOpacity
                        onPress={() => handleToggleActionItem(item)}
                        style={{ marginTop: 2, width: 18, height: 18, borderRadius: 6, borderWidth: 1, borderColor: done ? '#10b981' : '#d1d5db', backgroundColor: done ? '#10b981' : 'transparent', alignItems: 'center', justifyContent: 'center' }}
                      >
                        {done && <Check size={11} color="#fff" />}
                      </TouchableOpacity>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 13, fontFamily: done ? 'Poppins_400Regular' : 'Poppins_600SemiBold', color: done ? '#9ca3af' : '#1f2030', textDecorationLine: done ? 'line-through' : 'none' }}>{item.title}</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                          <Text style={{ backgroundColor: chipBg, color: chipFg, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, fontSize: 9, fontFamily: 'Poppins_700Bold', textTransform: 'uppercase', letterSpacing: 0.3 }}>
                            {done ? 'Done' : overdue ? 'Overdue' : 'Pending'}
                          </Text>
                          {item.assignedToName ? <Text style={{ fontSize: 10, color: '#9ca3af', fontFamily: 'Poppins_400Regular' }}>· {item.assignedToName}</Text> : null}
                          {meetingName ? <Text style={{ fontSize: 10, color: '#9ca3af', fontFamily: 'Poppins_400Regular' }} numberOfLines={1}>· {meetingName}</Text> : null}
                        </View>
                      </View>
                      <TouchableOpacity onPress={() => startEditItem(item)} style={{ padding: 4 }}>
                        <Pencil size={14} color="#6c5ce7" />
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              );
            })
          )}
        </View>
        )}
      </ScrollView>

      {/* ── Transcript Viewer Modal ── */}
      <Modal visible={transcriptModal.visible} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={{ flex: 1, backgroundColor: '#ffffff' }} edges={['top']}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.06)' }}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={{ fontSize: 18, fontFamily: 'SpaceGrotesk_700Bold', color: '#1f2030' }} numberOfLines={1}>{transcriptModal.title}</Text>
              <Text style={{ fontSize: 12, fontFamily: 'Poppins_400Regular', color: '#9a9aab', marginTop: 1 }}>Meeting Minutes & Transcript</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity
                onPress={async () => {
                  const shareText = `Meeting: ${transcriptModal.title}\n\nSummary:\n${transcriptModal.summary}\n\nAction Items:\n${transcriptModal.actionItems.map(ai => `• ${ai.text}${ai.assignedToName ? ` (${ai.assignedToName})` : ''}`).join('\n')}\n\nFull Transcript:\n${transcriptModal.rawTranscript || ''}`;
                  try {
                    await Share.share({ message: shareText, title: transcriptModal.title });
                  } catch (_) {}
                }}
                style={{ padding: 6, backgroundColor: 'rgba(108,92,231,0.08)', borderRadius: 10 }}
              >
                <Share2 size={16} color="#6c5ce7" />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setTranscriptModal(prev => ({ ...prev, visible: false }))}
                style={{ padding: 6 }}
              >
                <X size={20} color="#6c5ce7" />
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView style={{ flex: 1, paddingHorizontal: 20, paddingTop: 20 }} showsVerticalScrollIndicator={false}>
            {/* AI Summary */}
            {transcriptModal.summary ? (
              <View style={{ backgroundColor: 'rgba(108,92,231,0.06)', borderRadius: 20, padding: 18, marginBottom: 18, borderLeftWidth: 3, borderLeftColor: '#6c5ce7' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                  <FileText size={16} color="#6c5ce7" />
                  <Text style={{ fontSize: 12, fontFamily: 'Poppins_700Bold', color: '#6c5ce7', marginLeft: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Aida's Meeting Intelligence</Text>
                </View>
                <Text style={{ fontSize: 13.5, fontFamily: 'Poppins_400Regular', color: '#1f2030', lineHeight: 22 }}>
                  {transcriptModal.summary}
                </Text>
              </View>
            ) : null}

            {/* Action Items */}
            {transcriptModal.actionItems.length > 0 && (
              <View style={{ marginBottom: 18 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                  <Check size={15} color="#22c55e" />
                  <Text style={{ fontSize: 12, fontFamily: 'Poppins_700Bold', color: '#1f2030', marginLeft: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Action Items ({transcriptModal.actionItems.length})</Text>
                </View>
                {transcriptModal.actionItems.map((ai, idx) => (
                  <View key={idx} style={{ flexDirection: 'row', alignItems: 'flex-start', backgroundColor: '#f0fdf4', borderRadius: 14, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(34,197,94,0.15)' }}>
                    <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#22c55e', alignItems: 'center', justifyContent: 'center', marginRight: 10, marginTop: 1, flexShrink: 0 }}>
                      <Text style={{ color: '#fff', fontSize: 10, fontFamily: 'Poppins_700Bold' }}>{idx + 1}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, fontFamily: 'Poppins_500Medium', color: '#1f2030', lineHeight: 20 }}>{ai.text}</Text>
                      {ai.assignedToName && (
                        <Text style={{ fontSize: 11, fontFamily: 'Poppins_600SemiBold', color: '#6c5ce7', marginTop: 3 }}>@ {ai.assignedToName}</Text>
                      )}
                    </View>
                  </View>
                ))}
              </View>
            )}

            {/* Raw Transcript */}
            {transcriptModal.rawTranscript ? (
              <View style={{ marginBottom: 32 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                  <Users size={15} color="#9a9aab" />
                  <Text style={{ fontSize: 12, fontFamily: 'Poppins_700Bold', color: '#9a9aab', marginLeft: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Full Transcript</Text>
                </View>
                <View style={{ backgroundColor: 'rgba(0,0,0,0.02)', borderRadius: 16, padding: 14, borderWidth: 1, borderColor: 'rgba(0,0,0,0.05)' }}>
                  <Text style={{ fontSize: 12.5, fontFamily: 'Poppins_400Regular', color: 'rgba(31,32,48,0.75)', lineHeight: 21 }}>
                    {transcriptModal.rawTranscript}
                  </Text>
                </View>
              </View>
            ) : (
              <View style={{ paddingVertical: 20, alignItems: 'center' }}>
                <Text style={{ fontSize: 13, fontFamily: 'Poppins_400Regular', color: '#9a9aab', fontStyle: 'italic' }}>No transcript available for this meeting.</Text>
              </View>
            )}
          </ScrollView>

          <View style={{ paddingHorizontal: 20, paddingBottom: 24, paddingTop: 8, gap: 10 }}>
            <TouchableOpacity
              onPress={async () => {
                const shareText = `Meeting: ${transcriptModal.title}\n\nSummary:\n${transcriptModal.summary}\n\nAction Items:\n${transcriptModal.actionItems.map(ai => `• ${ai.text}${ai.assignedToName ? ` (${ai.assignedToName})` : ''}`).join('\n')}\n\nFull Transcript:\n${transcriptModal.rawTranscript || ''}`;
                try {
                  await Share.share({ message: shareText, title: transcriptModal.title });
                } catch (_) {}
              }}
              style={{ backgroundColor: 'rgba(108,92,231,0.1)', paddingVertical: 14, borderRadius: 16, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}
            >
              <Share2 size={16} color="#6c5ce7" />
              <Text style={{ color: '#6c5ce7', fontFamily: 'Poppins_700Bold', fontSize: 14 }}>Share Minutes</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setTranscriptModal(prev => ({ ...prev, visible: false }))}
              style={{ backgroundColor: '#6c5ce7', paddingVertical: 14, borderRadius: 16, alignItems: 'center', shadowColor: '#6c5ce7', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 4 }}
            >
              <Text style={{ color: '#ffffff', fontFamily: 'Poppins_700Bold', fontSize: 14 }}>Done</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>

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
            
            <ScrollView style={{ maxHeight: 440 }} contentContainerStyle={{ gap: 16 }} showsVerticalScrollIndicator={false}>
              {/* Pre-made templates */}
              <View>
                <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1.5">Quick templates</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 8 }}>
                  {TEMPLATES.map(tpl => (
                    <TouchableOpacity
                      key={tpl.label}
                      onPress={() => applyTemplate(tpl)}
                      style={{ backgroundColor: 'rgba(108,92,231,0.08)', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 9, borderWidth: 1, borderColor: 'rgba(108,92,231,0.15)' }}
                    >
                      <Text style={{ color: '#6c5ce7', fontSize: 12, fontFamily: 'Poppins_600SemiBold' }}>{tpl.label}</Text>
                    </TouchableOpacity>
                  ))}
                  {upcomingHolidays.map((h, i) => (
                    <TouchableOpacity
                      key={h._id || `htpl-${i}`}
                      onPress={() => {
                        setTitle(h.title);
                        setType('event');
                        setRecurrence('none');
                        setDescription(h.description || `${h.title} — public holiday.`);
                        const d = itemDate(h);
                        setSelectedDate(d);
                        const s = new Date(); s.setHours(9, 0, 0, 0); setStartTime(s);
                        const e = new Date(); e.setHours(10, 0, 0, 0); setEndTime(e);
                      }}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(244,102,59,0.08)', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 9, borderWidth: 1, borderColor: 'rgba(244,102,59,0.2)' }}
                    >
                      <PartyPopper size={12} color={COLOR_HOLIDAY} />
                      <Text style={{ color: COLOR_HOLIDAY, fontSize: 12, fontFamily: 'Poppins_600SemiBold' }}>{h.title}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>

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
                <View className="flex-row items-center justify-between mb-1">
                  <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase">Description</Text>
                  <TouchableOpacity
                    onPress={runAiDescribe}
                    disabled={aiLoading}
                    className="flex-row items-center gap-1 px-2.5 py-1 rounded-lg"
                    style={{ backgroundColor: 'rgba(108,92,231,0.1)' }}
                  >
                    {aiLoading ? <ActivityIndicator size="small" color="#6c5ce7" /> : <Sparkles size={12} color="#6c5ce7" />}
                    <Text className="text-[11px] font-bold text-purple font-sans">{aiLoading ? 'Writing…' : 'Generate'}</Text>
                  </TouchableOpacity>
                </View>
                <TextInput
                  value={description}
                  onChangeText={setDescription}
                  placeholder="Describe what you need, or tap Generate…"
                  className="bg-purple-soft/30 dark:bg-white/5 rounded-2xl p-4 text-ink dark:text-[#f4f5fb] border border-black/5 dark:border-white/10"
                  multiline
                  numberOfLines={2}
                />
              </View>

              {/* Start / End time pickers (no more hh/mm typing) */}
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1">Start time</Text>
                  <TouchableOpacity
                    onPress={() => { setShowStartPicker(v => !v); setShowEndPicker(false); }}
                    className="bg-purple-soft/30 dark:bg-white/5 rounded-2xl p-4 border border-black/5 dark:border-white/10 flex-row items-center justify-between"
                  >
                    <Text className="text-ink dark:text-[#f4f5fb] font-sans">{startTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>
                    <Clock size={15} color="#6c5ce7" />
                  </TouchableOpacity>
                </View>
                <View style={{ flex: 1 }}>
                  <Text className="text-xs font-bold text-ink dark:text-[#f4f5fb] uppercase mb-1">End time</Text>
                  <TouchableOpacity
                    onPress={() => { setShowEndPicker(v => !v); setShowStartPicker(false); }}
                    className="bg-purple-soft/30 dark:bg-white/5 rounded-2xl p-4 border border-black/5 dark:border-white/10 flex-row items-center justify-between"
                  >
                    <Text className="text-ink dark:text-[#f4f5fb] font-sans">{endTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>
                    <Clock size={15} color="#6c5ce7" />
                  </TouchableOpacity>
                </View>
              </View>
              {showStartPicker && (
                <DateTimePicker
                  value={startTime}
                  mode="time"
                  is24Hour={false}
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  onChange={(_e, d) => {
                    setShowStartPicker(Platform.OS === 'ios');
                    if (d) {
                      setStartTime(d);
                      if (d >= endTime) { const e = new Date(d); e.setHours(d.getHours() + 1); setEndTime(e); }
                    }
                  }}
                />
              )}
              {showEndPicker && (
                <DateTimePicker
                  value={endTime}
                  mode="time"
                  is24Hour={false}
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  onChange={(_e, d) => {
                    setShowEndPicker(Platform.OS === 'ios');
                    if (d) setEndTime(d);
                  }}
                />
              )}

              {/* Smart recurrence suggestion */}
              {recSuggestion && (
                <View style={{ backgroundColor: 'rgba(234,179,8,0.10)', borderRadius: 16, padding: 14, borderWidth: 1, borderColor: 'rgba(234,179,8,0.3)', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Sparkles size={16} color="#a16207" />
                  <Text style={{ flex: 1, fontSize: 12, fontFamily: 'Poppins_500Medium', color: '#854d0e' }}>{recSuggestion.message}</Text>
                  <TouchableOpacity
                    onPress={() => { setRecurrence(recSuggestion.recurrence); setRecSuggestion(null); }}
                    style={{ backgroundColor: '#eab308', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7 }}
                  >
                    <Text style={{ color: '#fff', fontSize: 11, fontFamily: 'Poppins_700Bold' }}>Yes</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Recurrence — redesigned: a toggle that reveals a cadence picker + plain-language summary */}
              <View style={{ backgroundColor: 'rgba(234,179,8,0.08)', borderRadius: 18, borderWidth: 1, borderColor: 'rgba(234,179,8,0.22)', padding: 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ width: 30, height: 30, borderRadius: 10, backgroundColor: 'rgba(234,179,8,0.18)', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
                    <Repeat size={15} color="#a16207" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontFamily: 'Poppins_700Bold', color: colors.text }}>Repeats</Text>
                    <Text style={{ fontSize: 10.5, fontFamily: 'Poppins_400Regular', color: colors.textSoft }}>
                      {recurrence === 'none'
                        ? 'One-time event'
                        : `${recurrence === 'daily' ? 'Every day' : recurrence === 'weekly' ? `Every ${weekdayName(startTime)}` : `Monthly on the ${ordinal(startTime.getDate())}`} · ${formatClock(startTime)}`}
                    </Text>
                  </View>
                  <Switch
                    value={recurrence !== 'none'}
                    onValueChange={(on) => setRecurrence(on ? 'weekly' : 'none')}
                    trackColor={{ false: 'rgba(0,0,0,0.12)', true: '#eab308' }}
                    thumbColor={Platform.OS === 'ios' ? undefined : recurrence !== 'none' ? '#fff' : '#f4f3f4'}
                  />
                </View>

                {recurrence !== 'none' && (
                  <View style={{ flexDirection: 'row', gap: 6, marginTop: 12 }}>
                    {(['daily', 'weekly', 'monthly'] as const).map(r => {
                      const active = recurrence === r;
                      return (
                        <TouchableOpacity
                          key={r}
                          onPress={() => setRecurrence(r)}
                          style={{ flex: 1, backgroundColor: active ? '#eab308' : 'transparent', borderWidth: 1, borderColor: active ? '#eab308' : 'rgba(234,179,8,0.3)', borderRadius: 11, paddingVertical: 9, alignItems: 'center' }}
                        >
                          <Text style={{ color: active ? '#fff' : '#a16207', fontSize: 11.5, fontFamily: 'Poppins_600SemiBold', textTransform: 'capitalize' }}>{r}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
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

              {/* Notify team (opt-in, recipient-scoped) */}
              {(groups.length > 0 || peopleToNotify.length > 0) && (
                <View>
                  <View className="flex-row items-center gap-1.5 mb-1.5">
                    <Users size={13} color={colors.purple} />
                    <Text className="text-xs font-bold uppercase" style={{ color: colors.text }}>Notify groups, teammates or contacts</Text>
                  </View>
                  <Text className="text-[10.5px] mb-2 font-sans" style={{ color: colors.textSoft }}>
                    Everyone you pick gets an email + a push, and the event lands on their Updates. No mass blast.
                  </Text>

                  {/* Groups */}
                  {groups.length > 0 && (
                    <>
                      <Text className="text-[10px] font-bold uppercase mb-1.5" style={{ color: colors.textSoft }}>Your groups</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: peopleToNotify.length ? 12 : 0 }}>
                        {groups.map((g) => {
                          const gid = String(g.id || g._id);
                          const active = selectedGroupIds.includes(gid);
                          const count = (g.users || []).length;
                          return (
                            <TouchableOpacity
                              key={gid}
                              onPress={() => toggleGroup(gid)}
                              style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: active ? colors.purple : colors.purpleSoft, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 }}
                            >
                              <Users size={11} color={active ? '#fff' : colors.purple} />
                              <Text style={{ color: active ? '#fff' : colors.purple, fontSize: 11.5, fontFamily: 'Poppins_600SemiBold' }}>
                                {g.name}{count ? ` · ${count}` : ''}
                              </Text>
                              {active && <Check size={11} color="#fff" />}
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </>
                  )}

                  {/* Individual teammates + contacts */}
                  {peopleToNotify.length > 0 && (
                    <>
                      <Text className="text-[10px] font-bold uppercase mb-1.5" style={{ color: colors.textSoft }}>People</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                        {peopleToNotify.map((m) => {
                          const mid = String(m.id || m._id);
                          const active = recipients.includes(mid);
                          return (
                            <TouchableOpacity
                              key={mid}
                              onPress={() => toggleRecipient(mid)}
                              style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: active ? colors.purple : colors.purpleSoft, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 }}
                            >
                              {active && <Check size={11} color="#fff" />}
                              <Text style={{ color: active ? '#fff' : colors.purple, fontSize: 11.5, fontFamily: 'Poppins_600SemiBold' }}>
                                {m.full_name || m.name || m.username}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </>
                  )}
                </View>
              )}

              {/* External participants (people outside your organization) */}
              <View>
                <View className="flex-row items-center gap-1.5 mb-1.5">
                  <Mail size={13} color={colors.purple} />
                  <Text className="text-xs font-bold uppercase" style={{ color: colors.text }}>External participants</Text>
                </View>
                <Text className="text-[10.5px] mb-2 font-sans" style={{ color: colors.textSoft }}>
                  Invite anyone outside your org by email — they'll receive the same invite.
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TextInput
                    value={externalInput}
                    onChangeText={setExternalInput}
                    placeholder="name@company.com"
                    placeholderTextColor={colors.textSoft}
                    autoCapitalize="none"
                    keyboardType="email-address"
                    onSubmitEditing={addExternalEmail}
                    style={{ flex: 1, backgroundColor: colors.surface, borderRadius: 12, padding: 12, color: colors.text, borderWidth: 1, borderColor: colors.border }}
                  />
                  <TouchableOpacity onPress={addExternalEmail} style={{ backgroundColor: colors.purple, borderRadius: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: '#fff', fontFamily: 'Poppins_700Bold', fontSize: 12 }}>Add</Text>
                  </TouchableOpacity>
                </View>
                {externalEmails.length > 0 && (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {externalEmails.map((em) => (
                      <TouchableOpacity
                        key={em}
                        onPress={() => setExternalEmails((prev) => prev.filter((x) => x !== em))}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.purpleSoft, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 }}
                      >
                        <Text style={{ color: colors.purple, fontSize: 11.5, fontFamily: 'Poppins_600SemiBold' }}>{em}</Text>
                        <X size={11} color={colors.purple} />
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
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

      {/* ── Call Overlay Modal ── */}
      <Modal visible={activeCall !== null} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: '#1f2030' }} className="items-center justify-between py-16 px-6">
          {/* Header */}
          <View className="items-center mt-8">
            <Text className="text-white/60 text-xs font-bold font-sans uppercase tracking-widest mb-2">
              BUBBLE {activeCall?.type === 'video' ? 'VIDEO CALL' : 'VOICE CALL'}
            </Text>
            <Text className="text-white text-2xl font-bold font-sans mt-2">
              {activeCall?.user?.name || 'Meeting Room'}
            </Text>
            <Text className="text-[#6c5ce7] text-sm font-semibold font-sans mt-2">
              {callDuration === 0 ? 'Ringing Teammates...' : `Connected • ${formatDuration(callDuration)}`}
            </Text>
          </View>

          {/* Avatar / Video Preview area */}
          <View className="items-center justify-center my-8">
            <View style={{ width: 140, height: 140, borderRadius: 70, backgroundColor: 'rgba(108,92,231,0.15)', borderWidth: 4, borderColor: '#6c5ce7' }} className="items-center justify-center shadow-lg">
              <Text className="text-white text-4xl font-bold font-sans">
                {getInitials(activeCall?.user?.name)}
              </Text>
            </View>
          </View>

          {/* Action buttons */}
          <View className="w-full flex-row justify-around items-center px-4 mb-4">
            <TouchableOpacity 
              onPress={() => setIsCallMuted(!isCallMuted)}
              style={{ backgroundColor: isCallMuted ? '#6c5ce7' : 'rgba(255,255,255,0.08)' }} 
              className="w-14 h-14 rounded-full items-center justify-center"
            >
              <MicOff color={isCallMuted ? '#fff' : '#9a9aab'} size={22} />
            </TouchableOpacity>

            <TouchableOpacity 
              onPress={() => setActiveCall(null)}
              className="w-16 h-16 rounded-full bg-red-500 items-center justify-center shadow-lg shadow-red-500/30"
            >
              <PhoneOff color="#fff" size={24} />
            </TouchableOpacity>

            <TouchableOpacity 
              onPress={() => setIsSpeakerOn(!isSpeakerOn)}
              style={{ backgroundColor: isSpeakerOn ? '#6c5ce7' : 'rgba(255,255,255,0.08)' }} 
              className="w-14 h-14 rounded-full items-center justify-center"
            >
              <Volume2 color={isSpeakerOn ? '#fff' : '#9a9aab'} size={22} />
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      {isUploading && (
        <Modal transparent animationType="fade" visible={isUploading}>
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ backgroundColor: '#ffffff', borderRadius: 20, padding: 24, alignItems: 'center' }} className="gap-3 shadow-xl">
              <ActivityIndicator size="large" color="#6c5ce7" />
              <Text style={{ fontFamily: 'Poppins_600SemiBold', color: '#1f2030', fontSize: 14 }}>Transcribing Audio...</Text>
              <Text style={{ fontFamily: 'Poppins_400Regular', color: '#9a9aab', fontSize: 11 }}>Aida is processing your recording</Text>
            </View>
          </View>
        </Modal>
      )}
    </SafeAreaView>
  );
}
