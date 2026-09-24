import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, ActivityIndicator, Animated, Modal, Platform,
  KeyboardAvoidingView, Alert, Dimensions,
} from 'react-native';
import {
  Calendar, ChevronLeft, ChevronRight, Plus, Sparkles, Video,
  Mic, Globe, Clock, Users, X, CheckCircle, AlertCircle,
  BookOpen, Brain, ChevronDown, Play, FileText, MapPin,
} from 'lucide-react-native';
import {
  getDailyDigest, getCalendarEvents, createCalendarEvent,
  getEventSuggestions, startCalendarMeeting, deleteCalendarEvent,
} from '../../lib/api';
import { notifyDailyBrief } from '../../lib/pushNotifications';

const { width: SCREEN_W } = Dimensions.get('window');

// ─── Types ────────────────────────────────────────────────────────────────────

type CalendarViewMode = 'month' | 'week' | 'agenda';

interface CalEvent {
  _id: string;
  title: string;
  eventType: 'company' | 'holiday' | 'meeting_video' | 'meeting_audio' | 'all_day';
  startTime: string;
  endTime: string;
  isAllDay: boolean;
  status: 'scheduled' | 'live' | 'ended' | 'cancelled';
  summary?: string;
  attendees?: any[];
  liveKitRoomId?: string;
}

interface DigestData {
  morningBrief: string;
  events: any[];
  highConfidenceItems: any[];
  headsUpItems: any[];
  yesterdayRecap?: {
    meetings: { title: string; summary?: string; decisions?: string[]; actionItems?: string[] }[];
    messageHighlights: { title: string; snippet: string }[];
    decisions: { title: string; snippet: string }[];
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Indicator palette — shared spec across web + mobile:
//   green = meetings · yellow = recurring · blue = events · purple = tasks · orange = holidays
const CATEGORY_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  meeting:   { bg: '#dcfce7', border: '#22c55e', text: '#16a34a' }, // green
  recurring: { bg: '#fef9c3', border: '#eab308', text: '#ca8a04' }, // yellow
  event:     { bg: '#dbeafe', border: '#3b82f6', text: '#2563eb' }, // blue
  task:      { bg: '#ede9fe', border: '#6c5ce7', text: '#6c5ce7' }, // purple
  holiday:   { bg: '#fde4dc', border: '#f4663b', text: '#d8492a' }, // orange
};

// Map a calendar item to one of the five indicator categories. Recurrence wins
// over the base type so a repeating meeting still reads as "recurring" (yellow).
// `__recurring` is annotated by detectRecurringIds during load.
function eventCategory(event: any): string {
  if (event?.eventType === 'holiday') return 'holiday';
  if (event?.isRecurring || event?.recurrenceRule || event?.parentEventId || event?.__recurring) return 'recurring';
  if (event?.eventType === 'task' || event?.type === 'task') return 'task';
  if (event?.eventType === 'meeting_video' || event?.eventType === 'meeting_audio') return 'meeting';
  return 'event'; // company / all_day / everything else
}

function eventColors(event: any) {
  return CATEGORY_COLORS[eventCategory(event)] || CATEGORY_COLORS.event;
}

// Lightweight recurrence recognition: events that aren't explicitly recurring
// but repeat (same title appearing 3+ times, or twice at a steady weekly/daily
// cadence) are treated as structured recurring events going forward.
function detectRecurringIds(events: any[]): Set<string> {
  const byTitle = new Map<string, any[]>();
  for (const e of events) {
    const key = String(e?.title || '').trim().toLowerCase();
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key)!.push(e);
  }
  const ids = new Set<string>();
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    if (group.length >= 3) {
      group.forEach(e => ids.add(String(e._id || e.id)));
      continue;
    }
    // Exactly two: only treat as recurring if spaced a whole number of weeks/days apart.
    const times = group.map(e => new Date(e.startTime).getTime()).sort((a, b) => a - b);
    const gapDays = Math.round((times[1] - times[0]) / 86400000);
    if (gapDays === 1 || gapDays === 7 || gapDays === 14 || gapDays === 30 || gapDays === 28) {
      group.forEach(e => ids.add(String(e._id || e.id)));
    }
  }
  return ids;
}

const EVENT_ICONS: Record<string, React.ReactNode> = {
  meeting_video: <Video size={13} color="#16a34a" />,
  meeting_audio: <Mic size={13} color="#16a34a" />,
  company:       <Globe size={13} color="#2563eb" />,
  holiday:       <CheckCircle size={13} color="#d8492a" />,
  all_day:       <Clock size={13} color="#2563eb" />,
};

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const TODAY = new Date();

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

const isSameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// ─── Event Badge ──────────────────────────────────────────────────────────────

const EventBadge = ({ event, onPress }: { event: CalEvent; onPress: () => void }) => {
  const colors = eventColors(event);
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.eventBadge, { backgroundColor: colors.bg, borderLeftColor: colors.border }]}
      activeOpacity={0.75}
    >
      <View style={styles.eventBadgeRow}>
        {EVENT_ICONS[event.eventType]}
        <Text style={[styles.eventBadgeTitle, { color: colors.text }]} numberOfLines={1}>
          {event.title}
        </Text>
      </View>
      {!event.isAllDay && (
        <Text style={[styles.eventBadgeTime, { color: colors.border }]}>{fmtTime(event.startTime)}</Text>
      )}
    </TouchableOpacity>
  );
};

// ─── Morning Brief Card ────────────────────────────────────────────────────────

const MorningBriefCard = ({ digest, loading }: { digest: DigestData | null; loading: boolean }) => {
  const [expanded, setExpanded] = useState(true);

  if (loading) {
    return (
      <View style={styles.digestCard}>
        <ActivityIndicator color="#6c5ce7" size="small" />
        <Text style={styles.digestLoading}>Loading your morning brief…</Text>
      </View>
    );
  }

  if (!digest?.morningBrief) return null;

  return (
    <View style={styles.digestCard}>
      <TouchableOpacity style={styles.digestHeader} onPress={() => setExpanded(e => !e)} activeOpacity={0.8}>
        <View style={styles.digestHeaderLeft}>
          <View style={styles.digestIcon}><Sparkles size={16} color="#6c5ce7" /></View>
          <Text style={styles.digestTitle}>Morning Brief</Text>
        </View>
        <ChevronDown size={18} color="#9a9aab" style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }} />
      </TouchableOpacity>

      {expanded && (
        <>
          <Text style={styles.digestBrief}>{digest.morningBrief}</Text>

          {digest.yesterdayRecap && (
            (digest.yesterdayRecap.meetings.length > 0 ||
             digest.yesterdayRecap.messageHighlights.length > 0 ||
             digest.yesterdayRecap.decisions.length > 0) && (
              <View style={styles.recapSection}>
                <Text style={styles.recapHeader}>Yesterday</Text>
                {digest.yesterdayRecap.meetings.map((m, i) => (
                  <Text key={`m-${i}`} style={styles.recapLine}>
                    • {m.title}{m.summary ? ` — ${m.summary.slice(0, 120)}` : ''}
                  </Text>
                ))}
                {digest.yesterdayRecap.messageHighlights.map((h, i) => (
                  <Text key={`h-${i}`} style={styles.recapLine}>• {h.snippet.slice(0, 120)}</Text>
                ))}
                {digest.yesterdayRecap.decisions.map((d, i) => (
                  <Text key={`d-${i}`} style={styles.recapLine}>• Decision: {d.title}</Text>
                ))}
              </View>
            )
          )}

          {digest.headsUpItems?.length > 0 && (
            <View style={styles.headsUpRow}>
              <AlertCircle size={13} color="#f59e0b" />
              <Text style={styles.headsUpText}>{digest.headsUpItems.length} heads-up item(s) — tap to expand</Text>
            </View>
          )}
        </>
      )}
    </View>
  );
};

// ─── Create Event Modal ────────────────────────────────────────────────────────

const EVENT_TYPES = [
  { key: 'meeting_video', label: 'Video Meeting', icon: <Video size={16} color="#16a34a" /> },
  { key: 'meeting_audio', label: 'Audio Meeting', icon: <Mic size={16} color="#16a34a" /> },
  { key: 'company',       label: 'Company Event', icon: <Globe size={16} color="#2563eb" /> },
  { key: 'all_day',       label: 'All Day',        icon: <Clock size={16} color="#2563eb" /> },
  { key: 'holiday',       label: 'Holiday',        icon: <CheckCircle size={16} color="#d8492a" /> },
];

const QUICK_TEMPLATES = [
  { label: 'Weekly Sync', eventType: 'meeting_video', duration: 60 },
  { label: 'Kickoff',     eventType: 'meeting_video', duration: 90 },
  { label: 'Board Meeting', eventType: 'company',     duration: 120 },
  { label: '1:1 Check-in',  eventType: 'meeting_audio', duration: 30 },
];

interface CreateEventModalProps {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
  defaultDate?: Date;
}

const CreateEventModal = ({ visible, onClose, onCreated, defaultDate }: CreateEventModalProps) => {
  const [title, setTitle] = useState('');
  const [eventType, setEventType] = useState<string>('meeting_video');
  const [description, setDescription] = useState('');
  const [agenda, setAgenda] = useState('');
  const [creating, setCreating] = useState(false);
  const [suggestions, setSuggestions] = useState<any>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startTime = defaultDate ? new Date(defaultDate) : new Date();
  startTime.setHours(10, 0, 0, 0);
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);

  useEffect(() => {
    if (!title.trim()) { setSuggestions(null); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSuggestLoading(true);
      try {
        const data = await getEventSuggestions(title.trim(), startTime.toISOString());
        setSuggestions(data);
        if (data.agendaSuggestion && !agenda) setAgenda(data.agendaSuggestion);
      } catch { /* silent */ } finally {
        setSuggestLoading(false);
      }
    }, 600);
  }, [title]);

  const applyTemplate = (t: typeof QUICK_TEMPLATES[0]) => {
    setTitle(t.label);
    setEventType(t.eventType);
  };

  const handleCreate = async () => {
    if (!title.trim()) return Alert.alert('Title required');
    setCreating(true);
    try {
      await createCalendarEvent({
        title: title.trim(),
        eventType: eventType as any,
        description,
        agenda,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      });
      onCreated();
      onClose();
      setTitle(''); setDescription(''); setAgenda('');
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.modalWrapper} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>New Event</Text>
          <TouchableOpacity onPress={onClose} style={styles.modalClose} activeOpacity={0.7}>
            <X size={20} color="#6b7280" />
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
          {/* Quick templates */}
          <Text style={styles.fieldLabel}>Quick Templates</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.templateRow}>
            {QUICK_TEMPLATES.map(t => (
              <TouchableOpacity key={t.label} style={styles.templateChip} onPress={() => applyTemplate(t)} activeOpacity={0.75}>
                <Text style={styles.templateChipText}>{t.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Event type */}
          <Text style={styles.fieldLabel}>Event Type</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.typeRow}>
            {EVENT_TYPES.map(t => (
              <TouchableOpacity
                key={t.key}
                style={[styles.typeChip, eventType === t.key && styles.typeChipActive]}
                onPress={() => setEventType(t.key)}
                activeOpacity={0.75}
              >
                {t.icon}
                <Text style={[styles.typeChipText, eventType === t.key && styles.typeChipTextActive]}>{t.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Title */}
          <Text style={styles.fieldLabel}>Title</Text>
          <TextInput
            style={styles.fieldInput}
            placeholder="e.g. Weekly Team Sync"
            placeholderTextColor="#9a9aab"
            value={title}
            onChangeText={setTitle}
          />

          {/* AI title suggestions */}
          {suggestions?.titleSuggestions?.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.suggestRow}>
              {suggestions.titleSuggestions.slice(0, 4).map((s: string) => (
                <TouchableOpacity key={s} style={styles.suggestChip} onPress={() => setTitle(s)} activeOpacity={0.75}>
                  <Sparkles size={11} color="#6c5ce7" />
                  <Text style={styles.suggestChipText}>{s}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          {/* Date/time display */}
          <Text style={styles.fieldLabel}>Date & Time</Text>
          <View style={styles.dateDisplay}>
            <Clock size={16} color="#6c5ce7" />
            <Text style={styles.dateDisplayText}>
              {fmtDate(startTime.toISOString())} · {fmtTime(startTime.toISOString())} – {fmtTime(endTime.toISOString())}
            </Text>
          </View>

          {/* Conflict warning */}
          {suggestions?.conflicts?.length > 0 && (
            <View style={styles.conflictBanner}>
              <AlertCircle size={14} color="#ef4444" />
              <Text style={styles.conflictText}>
                {suggestions.conflicts.length} conflict(s) at this time
              </Text>
            </View>
          )}

          {/* Participant suggestions */}
          {suggestions?.participantSuggestions?.length > 0 && (
            <>
              <Text style={styles.fieldLabel}>Suggested Participants</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.suggestRow}>
                {suggestions.participantSuggestions.map((p: any) => (
                  <View key={p.userId} style={styles.participantChip}>
                    <Users size={12} color="#6c5ce7" />
                    <Text style={styles.participantName}>{p.name}</Text>
                    <Text style={styles.participantTopic}>{p.topic}</Text>
                  </View>
                ))}
              </ScrollView>
            </>
          )}

          {/* Agenda */}
          <Text style={styles.fieldLabel}>Agenda {suggestLoading && <ActivityIndicator size="small" color="#6c5ce7" />}</Text>
          <TextInput
            style={[styles.fieldInput, styles.fieldTextArea]}
            placeholder="Meeting agenda (auto-filled from brain if available)"
            placeholderTextColor="#9a9aab"
            value={agenda}
            onChangeText={setAgenda}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />

          {/* Description */}
          <Text style={styles.fieldLabel}>Description (optional)</Text>
          <TextInput
            style={styles.fieldInput}
            placeholder="Add context or notes"
            placeholderTextColor="#9a9aab"
            value={description}
            onChangeText={setDescription}
          />

          <View style={{ height: 32 }} />
        </ScrollView>

        <View style={styles.modalFooter}>
          <TouchableOpacity
            style={[styles.createBtn, (creating || !title.trim()) && styles.createBtnDisabled]}
            onPress={handleCreate}
            disabled={creating || !title.trim()}
            activeOpacity={0.8}
          >
            {creating
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={styles.createBtnText}>Create Event →</Text>
            }
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

// ─── Event Detail Modal ────────────────────────────────────────────────────────

const EventDetailModal = ({ event, onClose, onStartMeeting }: { event: CalEvent | null; onClose: () => void; onStartMeeting: (e: CalEvent) => void }) => {
  if (!event) return null;
  const colors = eventColors(event);

  return (
    <Modal visible={!!event} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.modalWrapper}>
        <View style={[styles.modalHeader, { borderBottomColor: colors.border + '30' }]}>
          <View style={styles.detailHeaderLeft}>
            {EVENT_ICONS[event.eventType]}
            <Text style={[styles.modalTitle, { marginLeft: 8 }]}>{event.title}</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.modalClose} activeOpacity={0.7}>
            <X size={20} color="#6b7280" />
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.modalBody}>
          <View style={styles.detailRow}>
            <Clock size={15} color="#9a9aab" />
            <Text style={styles.detailText}>
              {fmtDate(event.startTime)} · {fmtTime(event.startTime)} – {fmtTime(event.endTime)}
            </Text>
          </View>

          {event.attendees && event.attendees.length > 0 && (
            <View style={styles.detailRow}>
              <Users size={15} color="#9a9aab" />
              <Text style={styles.detailText}>
                {event.attendees.map((a: any) => a.full_name || a.username).join(', ')}
              </Text>
            </View>
          )}

          {event.summary && (
            <View style={styles.summaryCard}>
              <View style={styles.summaryHeader}>
                <Brain size={14} color="#6c5ce7" />
                <Text style={styles.summaryLabel}>AI Summary</Text>
              </View>
              <Text style={styles.summaryText}>{event.summary}</Text>
            </View>
          )}

          {(event.eventType === 'meeting_video' || event.eventType === 'meeting_audio') && event.status === 'scheduled' && (
            <TouchableOpacity
              style={styles.startMeetingBtn}
              onPress={() => { onClose(); onStartMeeting(event); }}
              activeOpacity={0.8}
            >
              <Play size={16} color="#fff" />
              <Text style={styles.startMeetingText}>Start Meeting</Text>
            </TouchableOpacity>
          )}

          {event.status === 'live' && (
            <View style={styles.liveBanner}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>Meeting is live</Text>
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
};

// ─── Main Calendar Screen ──────────────────────────────────────────────────────

export default function CalendarScreen() {
  const [viewMode, setViewMode] = useState<CalendarViewMode>('month');
  const [currentDate, setCurrentDate] = useState(new Date(TODAY));
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [digest, setDigest] = useState<DigestData | null>(null);
  const [digestLoading, setDigestLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<Date>(TODAY);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CalEvent | null>(null);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  // Load events for the visible month
  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const start = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
      const end = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);
      const data = await getCalendarEvents({ start: start.toISOString(), end: end.toISOString() });
      const raw = data?.events || [];
      // Recognize repeated patterns and tag them so they render as recurring (yellow).
      const recurringIds = detectRecurringIds(raw);
      setEvents(raw.map((e: any) => ({ ...e, __recurring: e.isRecurring || recurringIds.has(String(e._id || e.id)) })));
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, [currentDate]);

  // Load morning digest
  const loadDigest = useCallback(async () => {
    setDigestLoading(true);
    try {
      const data = await getDailyDigest();
      const d = data?.digest || null;
      setDigest(d);
      // Surface the brief as a local notification (once per day), like web.
      if (d?.morningBrief) notifyDailyBrief(d.morningBrief);
    } catch { /* silent */ } finally {
      setDigestLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    loadDigest();
  }, []);

  const navigateMonth = (dir: 1 | -1) => {
    Animated.timing(fadeAnim, { toValue: 0, duration: 120, useNativeDriver: true }).start(() => {
      const d = new Date(currentDate);
      d.setMonth(d.getMonth() + dir);
      setCurrentDate(d);
      Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    });
  };

  const eventsOnDay = (day: Date) =>
    events.filter(e => isSameDay(new Date(e.startTime), day));

  const selectedDayEvents = eventsOnDay(selectedDay);

  // Build calendar grid
  const firstDay = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
  const daysInMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
  const startOffset = firstDay.getDay();
  const calCells: (Date | null)[] = [
    ...Array(startOffset).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(currentDate.getFullYear(), currentDate.getMonth(), i + 1)),
  ];

  const handleStartMeeting = async (event: CalEvent) => {
    try {
      const data = await startCalendarMeeting(event._id);
      Alert.alert('Meeting Started', `Room ID: ${data.roomId}`, [{ text: 'OK' }]);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  };

  return (
    <View style={styles.screen}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Calendar size={20} color="#6c5ce7" />
          <Text style={styles.headerTitle}>Calendar</Text>
        </View>
        <TouchableOpacity style={styles.addBtn} onPress={() => setShowCreate(true)} activeOpacity={0.8}>
          <Plus size={20} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* View mode switcher */}
      <View style={styles.viewToggle}>
        {(['month', 'week', 'agenda'] as CalendarViewMode[]).map(mode => (
          <TouchableOpacity
            key={mode}
            style={[styles.viewToggleBtn, viewMode === mode && styles.viewToggleBtnActive]}
            onPress={() => setViewMode(mode)}
            activeOpacity={0.75}
          >
            <Text style={[styles.viewToggleText, viewMode === mode && styles.viewToggleTextActive]}>
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Morning Brief */}
        <MorningBriefCard digest={digest} loading={digestLoading} />

        {/* Month navigation */}
        <View style={styles.monthNav}>
          <TouchableOpacity onPress={() => navigateMonth(-1)} style={styles.monthNavBtn} activeOpacity={0.7}>
            <ChevronLeft size={20} color="#6c5ce7" />
          </TouchableOpacity>
          <Text style={styles.monthLabel}>
            {MONTHS[currentDate.getMonth()]} {currentDate.getFullYear()}
          </Text>
          <TouchableOpacity onPress={() => navigateMonth(1)} style={styles.monthNavBtn} activeOpacity={0.7}>
            <ChevronRight size={20} color="#6c5ce7" />
          </TouchableOpacity>
        </View>

        {/* Weekday row */}
        <View style={styles.weekdayRow}>
          {WEEKDAYS.map(d => (
            <Text key={d} style={styles.weekdayLabel}>{d}</Text>
          ))}
        </View>

        {/* Calendar grid */}
        <Animated.View style={[styles.calGrid, { opacity: fadeAnim }]}>
          {calCells.map((day, idx) => {
            if (!day) return <View key={`empty-${idx}`} style={styles.calCell} />;
            const isToday = isSameDay(day, TODAY);
            const isSelected = isSameDay(day, selectedDay);
            const dayEvents = eventsOnDay(day);
            const hasEvent = dayEvents.length > 0;

            return (
              <TouchableOpacity
                key={day.toISOString()}
                style={[
                  styles.calCell,
                  isSelected && styles.calCellSelected,
                ]}
                onPress={() => setSelectedDay(new Date(day))}
                activeOpacity={0.7}
              >
                <View style={[styles.dayNum, isToday && styles.dayNumToday, isSelected && styles.dayNumSelected]}>
                  <Text style={[styles.dayText, isToday && styles.dayTextToday, isSelected && styles.dayTextSelected]}>
                    {day.getDate()}
                  </Text>
                </View>
                {hasEvent && (
                  <View style={styles.dotRow}>
                    {dayEvents.slice(0, 3).map(e => (
                      <View
                        key={e._id}
                        style={[styles.eventDot, { backgroundColor: eventColors(e).border }]}
                      />
                    ))}
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </Animated.View>

        {/* Selected day events */}
        <View style={styles.dayEventsSection}>
          <Text style={styles.dayEventsTitle}>
            {isSameDay(selectedDay, TODAY) ? 'Today' : fmtDate(selectedDay.toISOString())}
            <Text style={styles.dayEventsCount}> · {selectedDayEvents.length} event{selectedDayEvents.length !== 1 ? 's' : ''}</Text>
          </Text>

          {loading && <ActivityIndicator color="#6c5ce7" style={{ marginTop: 12 }} />}

          {!loading && selectedDayEvents.length === 0 && (
            <View style={styles.emptyDay}>
              <Calendar size={32} color="#e5e7eb" />
              <Text style={styles.emptyDayText}>No events. Tap + to create one.</Text>
            </View>
          )}

          {selectedDayEvents.map(event => (
            <EventBadge key={event._id} event={event} onPress={() => setSelectedEvent(event)} />
          ))}
        </View>

        {/* Upcoming events (next 7 days) */}
        <View style={styles.upcomingSection}>
          <Text style={styles.upcomingTitle}>Upcoming</Text>
          {events
            .filter(e => {
              const d = new Date(e.startTime);
              const now = new Date();
              return d > now && d <= new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
            })
            .slice(0, 5)
            .map(event => (
              <TouchableOpacity
                key={event._id}
                style={styles.upcomingCard}
                onPress={() => setSelectedEvent(event)}
                activeOpacity={0.75}
              >
                <View style={[styles.upcomingAccent, { backgroundColor: eventColors(event).border }]} />
                <View style={styles.upcomingBody}>
                  <Text style={styles.upcomingTitle2} numberOfLines={1}>{event.title}</Text>
                  <Text style={styles.upcomingTime}>{fmtDate(event.startTime)} · {fmtTime(event.startTime)}</Text>
                </View>
                {(event.eventType === 'meeting_video' || event.eventType === 'meeting_audio') && event.status === 'scheduled' && (
                  <TouchableOpacity
                    style={styles.joinBtn}
                    onPress={() => handleStartMeeting(event)}
                    activeOpacity={0.8}
                  >
                    <Play size={13} color="#fff" />
                    <Text style={styles.joinBtnText}>Join</Text>
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
            ))}
        </View>

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* Modals */}
      <CreateEventModal
        visible={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={loadEvents}
        defaultDate={selectedDay}
      />
      <EventDetailModal
        event={selectedEvent}
        onClose={() => setSelectedEvent(null)}
        onStartMeeting={handleStartMeeting}
      />
    </View>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f8f7ff' },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingTop: Platform.OS === 'ios' ? 58 : 36,
    paddingBottom: 12, backgroundColor: '#f8f7ff',
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerTitle: { fontFamily: 'Poppins_700Bold', fontSize: 20, color: '#1a1a2e' },
  addBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: '#6c5ce7', alignItems: 'center', justifyContent: 'center',
  },

  viewToggle: {
    flexDirection: 'row', marginHorizontal: 20, marginBottom: 12,
    backgroundColor: '#fff', borderRadius: 12, padding: 4,
    borderWidth: 1, borderColor: 'rgba(108,92,231,0.1)',
  },
  viewToggleBtn: {
    flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8,
  },
  viewToggleBtnActive: { backgroundColor: '#6c5ce7' },
  viewToggleText: { fontFamily: 'Poppins_500Medium', fontSize: 13, color: '#9a9aab' },
  viewToggleTextActive: { color: '#fff' },

  scrollContent: { paddingHorizontal: 16 },

  // Digest card
  digestCard: {
    backgroundColor: '#fff', borderRadius: 18, padding: 16, marginBottom: 16,
    borderWidth: 1, borderColor: 'rgba(108,92,231,0.1)',
    shadowColor: '#6c5ce7', shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 3,
  },
  digestHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  digestHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  digestIcon: {
    width: 32, height: 32, borderRadius: 10, backgroundColor: '#ede9fe',
    alignItems: 'center', justifyContent: 'center',
  },
  digestTitle: { fontFamily: 'Poppins_600SemiBold', fontSize: 14, color: '#1a1a2e' },
  digestLoading: { fontFamily: 'Poppins_400Regular', fontSize: 13, color: '#9a9aab', marginTop: 8 },
  digestBrief: {
    fontFamily: 'Poppins_400Regular', fontSize: 13, color: '#374151',
    lineHeight: 22, marginTop: 12,
  },
  headsUpRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  headsUpText: { fontFamily: 'Poppins_400Regular', fontSize: 12, color: '#f59e0b' },
  recapSection: {
    marginTop: 14, paddingTop: 12,
    borderTopWidth: 1, borderTopColor: '#eee',
  },
  recapHeader: {
    fontFamily: 'Poppins_600SemiBold', fontSize: 12,
    color: '#6c5ce7', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6,
  },
  recapLine: {
    fontFamily: 'Poppins_400Regular', fontSize: 12, color: '#4b5563', lineHeight: 19,
  },

  // Month navigation
  monthNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  monthNavBtn: { padding: 8 },
  monthLabel: { fontFamily: 'Poppins_700Bold', fontSize: 17, color: '#1a1a2e' },

  // Weekday row
  weekdayRow: { flexDirection: 'row', marginBottom: 6 },
  weekdayLabel: {
    flex: 1, textAlign: 'center', fontFamily: 'Poppins_500Medium',
    fontSize: 11, color: '#9a9aab', paddingVertical: 4,
  },

  // Calendar grid
  calGrid: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 20 },
  calCell: {
    width: `${100 / 7}%`, aspectRatio: 1, alignItems: 'center',
    justifyContent: 'flex-start', paddingTop: 4, borderRadius: 8,
  },
  calCellSelected: { backgroundColor: 'rgba(108,92,231,0.06)' },
  dayNum: {
    width: 30, height: 30, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center',
  },
  dayNumToday: { backgroundColor: '#ede9fe' },
  dayNumSelected: { backgroundColor: '#6c5ce7' },
  dayText: { fontFamily: 'Poppins_400Regular', fontSize: 13, color: '#374151' },
  dayTextToday: { color: '#6c5ce7', fontFamily: 'Poppins_600SemiBold' },
  dayTextSelected: { color: '#fff', fontFamily: 'Poppins_600SemiBold' },
  dotRow: { flexDirection: 'row', gap: 2, marginTop: 2 },
  eventDot: { width: 5, height: 5, borderRadius: 3 },

  // Day events section
  dayEventsSection: { marginBottom: 24 },
  dayEventsTitle: { fontFamily: 'Poppins_700Bold', fontSize: 16, color: '#1a1a2e', marginBottom: 10 },
  dayEventsCount: { fontFamily: 'Poppins_400Regular', fontSize: 13, color: '#9a9aab' },
  emptyDay: { alignItems: 'center', paddingVertical: 24, gap: 8 },
  emptyDayText: { fontFamily: 'Poppins_400Regular', fontSize: 13, color: '#9a9aab' },

  // Event badge
  eventBadge: {
    borderRadius: 10, padding: 10, marginBottom: 8,
    borderLeftWidth: 3, borderWidth: 1, borderColor: 'transparent',
  },
  eventBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  eventBadgeTitle: { fontFamily: 'Poppins_600SemiBold', fontSize: 13, flex: 1 },
  eventBadgeTime: { fontFamily: 'Poppins_400Regular', fontSize: 11, marginTop: 3 },

  // Upcoming section
  upcomingSection: { marginBottom: 16 },
  upcomingTitle: { fontFamily: 'Poppins_700Bold', fontSize: 15, color: '#1a1a2e', marginBottom: 10 },
  upcomingCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden',
    marginBottom: 8, borderWidth: 1, borderColor: 'rgba(108,92,231,0.07)',
    shadowColor: '#000', shadowOpacity: 0.03, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 1,
  },
  upcomingAccent: { width: 4, alignSelf: 'stretch' },
  upcomingBody: { flex: 1, paddingHorizontal: 12, paddingVertical: 10 },
  upcomingTitle2: { fontFamily: 'Poppins_600SemiBold', fontSize: 13, color: '#1a1a2e' },
  upcomingTime: { fontFamily: 'Poppins_400Regular', fontSize: 11, color: '#9a9aab', marginTop: 2 },
  joinBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#6c5ce7', paddingHorizontal: 12, paddingVertical: 8, marginRight: 10, borderRadius: 8,
  },
  joinBtnText: { fontFamily: 'Poppins_600SemiBold', fontSize: 12, color: '#fff' },

  // Modal
  modalWrapper: { flex: 1, backgroundColor: '#f8f7ff' },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingTop: Platform.OS === 'ios' ? 20 : 16,
    paddingBottom: 16, backgroundColor: '#fff',
    borderBottomWidth: 1, borderBottomColor: 'rgba(108,92,231,0.1)',
  },
  detailHeaderLeft: { flexDirection: 'row', alignItems: 'center' },
  modalTitle: { fontFamily: 'Poppins_700Bold', fontSize: 18, color: '#1a1a2e' },
  modalClose: { padding: 4 },
  modalBody: { flex: 1, paddingHorizontal: 20, paddingTop: 20 },
  modalFooter: { padding: 20, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: 'rgba(108,92,231,0.1)' },

  fieldLabel: { fontFamily: 'Poppins_600SemiBold', fontSize: 13, color: '#374151', marginBottom: 6, marginTop: 16 },
  fieldInput: {
    backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    fontFamily: 'Poppins_400Regular', fontSize: 14, color: '#1a1a2e',
    borderWidth: 1, borderColor: 'rgba(108,92,231,0.15)',
  },
  fieldTextArea: { minHeight: 90, paddingTop: 12 },

  templateRow: { flexDirection: 'row', marginBottom: 4 },
  templateChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
    backgroundColor: '#f3f4f6', marginRight: 8,
  },
  templateChipText: { fontFamily: 'Poppins_500Medium', fontSize: 12, color: '#374151' },

  typeRow: { flexDirection: 'row' },
  typeChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12,
    backgroundColor: '#fff', marginRight: 8, borderWidth: 1, borderColor: 'rgba(108,92,231,0.15)',
  },
  typeChipActive: { backgroundColor: '#ede9fe', borderColor: '#6c5ce7' },
  typeChipText: { fontFamily: 'Poppins_500Medium', fontSize: 12, color: '#6b7280' },
  typeChipTextActive: { color: '#6c5ce7' },

  suggestRow: { flexDirection: 'row', marginTop: 6, marginBottom: 4 },
  suggestChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16,
    backgroundColor: '#ede9fe', marginRight: 6,
  },
  suggestChipText: { fontFamily: 'Poppins_400Regular', fontSize: 11, color: '#6c5ce7' },

  participantChip: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12,
    backgroundColor: '#f3f4f6', marginRight: 8, alignItems: 'center',
  },
  participantName: { fontFamily: 'Poppins_500Medium', fontSize: 12, color: '#1a1a2e', marginTop: 2 },
  participantTopic: { fontFamily: 'Poppins_400Regular', fontSize: 10, color: '#9a9aab' },

  dateDisplay: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#f3f4f6', borderRadius: 10, padding: 12,
  },
  dateDisplayText: { fontFamily: 'Poppins_400Regular', fontSize: 13, color: '#374151' },

  conflictBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#fef2f2', borderRadius: 8, padding: 10, marginTop: 8,
  },
  conflictText: { fontFamily: 'Poppins_500Medium', fontSize: 12, color: '#ef4444' },

  createBtn: {
    backgroundColor: '#6c5ce7', borderRadius: 14, paddingVertical: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  createBtnDisabled: { opacity: 0.5 },
  createBtnText: { fontFamily: 'Poppins_700Bold', fontSize: 16, color: '#fff' },

  // Event detail
  detailRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 12 },
  detailText: { fontFamily: 'Poppins_400Regular', fontSize: 14, color: '#374151', flex: 1 },
  summaryCard: {
    backgroundColor: '#faf7ff', borderRadius: 14, padding: 14,
    borderLeftWidth: 3, borderLeftColor: '#6c5ce7', marginTop: 8,
  },
  summaryHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  summaryLabel: { fontFamily: 'Poppins_600SemiBold', fontSize: 13, color: '#6c5ce7' },
  summaryText: { fontFamily: 'Poppins_400Regular', fontSize: 13, color: '#374151', lineHeight: 21 },

  startMeetingBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#6c5ce7', borderRadius: 14, paddingVertical: 14, marginTop: 20,
  },
  startMeetingText: { fontFamily: 'Poppins_700Bold', fontSize: 15, color: '#fff' },

  liveBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#dcfce7', borderRadius: 10, padding: 12, marginTop: 20,
  },
  liveDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#22c55e' },
  liveText: { fontFamily: 'Poppins_600SemiBold', fontSize: 13, color: '#16a34a' },
});
