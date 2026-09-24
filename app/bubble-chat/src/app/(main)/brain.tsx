import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Animated,
  Alert,
  Platform,
  Dimensions,
  KeyboardAvoidingView,
  Modal,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { BlurView } from 'expo-blur';
import {
  Brain,
  Search,
  Upload,
  Link2,
  FileText,
  Mic,
  ChevronRight,
  ChevronDown,
  CheckCircle,
  Clock,
  XCircle,
  Sparkles,
  MessageSquare,
  Users,
  X,
  Send,
  BookOpen,
  RotateCcw,
  AlertCircle,
} from 'lucide-react-native';
import {
  brainIngestFile,
  brainIngestText,
  brainIngestUrl,
  brainGetJobs,
  brainSearch,
  brainOnboardingBrief,
  brainAskQuestion,
  getDailyDigest,
  getExpertiseRadar,
} from '../../lib/api';

const { width: SCREEN_W } = Dimensions.get('window');

// ─── Types ───────────────────────────────────────────────────────────────────

type Tab = 'search' | 'seed' | 'onboard' | 'ask' | 'digest';

interface IngestionJob {
  _id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  sourceType: 'file' | 'url' | 'text' | 'recording' | 'youtube' | 'slack_export' | 'ai_conversation' | 'holiday';
  title?: string;
  createdAt: string;
  error?: string;
}

interface SearchResult {
  id: string;
  title: string;
  chunk: string;
  score: number;
  department?: string;
}

// ─── Small Components ────────────────────────────────────────────────────────

const StatusBadge = ({ status }: { status: IngestionJob['status'] }) => {
  const map: Record<IngestionJob['status'], { color: string; icon: React.ReactNode; label: string }> = {
    queued:     { color: '#f59e0b', icon: <Clock size={12} color="#f59e0b" />, label: 'Queued' },
    processing: { color: '#6c5ce7', icon: <ActivityIndicator size={10} color="#6c5ce7" />, label: 'Processing' },
    completed:  { color: '#10b981', icon: <CheckCircle size={12} color="#10b981" />, label: 'Done' },
    failed:     { color: '#ef4444', icon: <XCircle size={12} color="#ef4444" />, label: 'Failed' },
  };
  const m = map[status];
  return (
    <View style={[styles.badge, { borderColor: m.color + '40', backgroundColor: m.color + '15' }]}>
      {m.icon}
      <Text style={[styles.badgeText, { color: m.color }]}>{m.label}</Text>
    </View>
  );
};

const Chip = ({ label, active, onPress }: { label: string; active?: boolean; onPress: () => void }) => (
  <TouchableOpacity
    onPress={onPress}
    activeOpacity={0.75}
    style={[styles.chip, active && styles.chipActive]}
  >
    <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
  </TouchableOpacity>
);

// ─── DigestTab Component ────────────────────────────────────────────────────

const DigestTab = () => {
  const [digest, setDigest] = useState<any>(null);
  const [radar, setRadar] = useState<Record<string, any[]>>({});
  const [loading, setLoading] = useState(true);
  const [radarLoading, setRadarLoading] = useState(true);
  const [headsUpExpanded, setHeadsUpExpanded] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const [digestData, radarData] = await Promise.allSettled([
          getDailyDigest(),
          getExpertiseRadar(),
        ]);
        if (digestData.status === 'fulfilled') setDigest(digestData.value?.digest);
        if (radarData.status === 'fulfilled') setRadar(radarData.value?.byTopic || {});
      } catch { /* silent */ } finally {
        setLoading(false);
        setRadarLoading(false);
      }
    };
    load();
  }, []);

  const today = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <View>
      <Text style={digestStyles.sectionTitle}>Morning Brief</Text>
      <Text style={digestStyles.sectionSub}>{today}</Text>

      {loading ? (
        <View style={digestStyles.loadingCard}>
          <ActivityIndicator color="#6c5ce7" />
          <Text style={digestStyles.loadingText}>Generating your brief…</Text>
        </View>
      ) : digest ? (
        <>
          {/* Main brief */}
          <View style={digestStyles.briefCard}>
            <View style={digestStyles.briefHeader}>
              <View style={digestStyles.briefIconWrap}><Sparkles size={16} color="#6c5ce7" /></View>
              <Text style={digestStyles.briefLabel}>AI Summary</Text>
            </View>
            <Text style={digestStyles.briefText}>{digest.morningBrief}</Text>
          </View>

          {/* Today's events */}
          {digest.events?.length > 0 && (
            <View style={digestStyles.section}>
              <Text style={digestStyles.sectionHeader}>Today's Events ({digest.events.length})</Text>
              {digest.events.map((e: any) => (
                <View key={e._id} style={digestStyles.eventRow}>
                  <View style={digestStyles.eventDot} />
                  <View style={{ flex: 1 }}>
                    <Text style={digestStyles.eventTitle}>{e.title}</Text>
                    <Text style={digestStyles.eventTime}>
                      {new Date(e.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* High-confidence knowledge */}
          {digest.highConfidenceItems?.length > 0 && (
            <View style={digestStyles.section}>
              <Text style={digestStyles.sectionHeader}>Key Knowledge ({digest.highConfidenceItems.length})</Text>
              {digest.highConfidenceItems.map((item: any, idx: number) => (
                <View key={idx} style={digestStyles.knowledgeCard}>
                  <Text style={digestStyles.knowledgeSource}>{item.sourceTitle || 'Knowledge Base'}</Text>
                  <Text style={digestStyles.knowledgeContent} numberOfLines={3}>{item.content}</Text>
                  <View style={digestStyles.confidenceBadge}>
                    <Text style={digestStyles.confidenceText}>
                      {Math.round((item.confidence || 0) * 100)}% confidence
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* Heads-up items */}
          {digest.headsUpItems?.length > 0 && (
            <View style={digestStyles.section}>
              <TouchableOpacity
                style={digestStyles.headsUpToggle}
                onPress={() => setHeadsUpExpanded(e => !e)}
                activeOpacity={0.75}
              >
                <AlertCircle size={14} color="#f59e0b" />
                <Text style={digestStyles.headsUpToggleText}>
                  {digest.headsUpItems.length} heads-up item(s)
                </Text>
                <ChevronDown size={14} color="#f59e0b" style={{ transform: [{ rotate: headsUpExpanded ? '180deg' : '0deg' }] }} />
              </TouchableOpacity>
              {headsUpExpanded && digest.headsUpItems.map((item: any, idx: number) => (
                <View key={idx} style={[digestStyles.knowledgeCard, { borderLeftColor: '#f59e0b' }]}>
                  <Text style={digestStyles.knowledgeContent} numberOfLines={2}>{item.content}</Text>
                </View>
              ))}
            </View>
          )}
        </>
      ) : (
        <View style={digestStyles.loadingCard}>
          <Sparkles size={28} color="#e5e7eb" />
          <Text style={digestStyles.loadingText}>No digest yet. Check back tomorrow morning!</Text>
        </View>
      )}

      {/* Expertise Radar */}
      <Text style={[digestStyles.sectionTitle, { marginTop: 24 }]}>Expertise Radar</Text>
      <Text style={digestStyles.sectionSub}>Top contributors per topic across your org</Text>

      {radarLoading ? (
        <ActivityIndicator color="#6c5ce7" style={{ marginTop: 12 }} />
      ) : Object.keys(radar).length === 0 ? (
        <View style={digestStyles.loadingCard}>
          <Users size={28} color="#e5e7eb" />
          <Text style={digestStyles.loadingText}>No expertise data yet.</Text>
        </View>
      ) : (
        Object.entries(radar).slice(0, 8).map(([topic, experts]) => (
          <View key={topic} style={digestStyles.radarCard}>
            <Text style={digestStyles.radarTopic}>#{topic}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {experts.slice(0, 4).map((expert: any, idx: number) => (
                <View key={idx} style={digestStyles.radarExpert}>
                  <View style={digestStyles.radarAvatar}>
                    <Text style={digestStyles.radarAvatarText}>
                      {(expert.user?.full_name || expert.user?.username || '?')[0].toUpperCase()}
                    </Text>
                  </View>
                  <Text style={digestStyles.radarName} numberOfLines={1}>
                    {expert.user?.full_name || expert.user?.username || 'Member'}
                  </Text>
                  <View style={digestStyles.radarScoreBadge}>
                    <Text style={digestStyles.radarScore}>{expert.score}</Text>
                  </View>
                </View>
              ))}
            </ScrollView>
          </View>
        ))
      )}
    </View>
  );
};

const digestStyles = StyleSheet.create({
  sectionTitle: { fontFamily: 'Poppins_700Bold', fontSize: 16, color: '#1a1a2e', marginBottom: 4 },
  sectionSub: { fontFamily: 'Poppins_400Regular', fontSize: 12, color: '#9a9aab', marginBottom: 16 },
  loadingCard: {
    backgroundColor: '#fff', borderRadius: 16, padding: 24, alignItems: 'center', gap: 10,
    borderWidth: 1, borderColor: 'rgba(108,92,231,0.1)', marginBottom: 12,
  },
  loadingText: { fontFamily: 'Poppins_400Regular', fontSize: 13, color: '#9a9aab', textAlign: 'center' },
  briefCard: {
    backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 16,
    borderWidth: 1, borderColor: 'rgba(108,92,231,0.12)',
    shadowColor: '#6c5ce7', shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 3,
  },
  briefHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  briefIconWrap: { width: 32, height: 32, borderRadius: 10, backgroundColor: '#ede9fe', alignItems: 'center', justifyContent: 'center' },
  briefLabel: { fontFamily: 'Poppins_600SemiBold', fontSize: 13, color: '#1a1a2e' },
  briefText: { fontFamily: 'Poppins_400Regular', fontSize: 13, color: '#374151', lineHeight: 22 },
  section: { marginBottom: 16 },
  sectionHeader: { fontFamily: 'Poppins_600SemiBold', fontSize: 13, color: '#374151', marginBottom: 10 },
  eventRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 8 },
  eventDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#6c5ce7', marginTop: 5 },
  eventTitle: { fontFamily: 'Poppins_500Medium', fontSize: 13, color: '#1a1a2e' },
  eventTime: { fontFamily: 'Poppins_400Regular', fontSize: 11, color: '#9a9aab' },
  knowledgeCard: {
    backgroundColor: '#faf7ff', borderRadius: 12, padding: 12, marginBottom: 8,
    borderLeftWidth: 3, borderLeftColor: '#6c5ce7',
  },
  knowledgeSource: { fontFamily: 'Poppins_600SemiBold', fontSize: 11, color: '#6c5ce7', marginBottom: 4 },
  knowledgeContent: { fontFamily: 'Poppins_400Regular', fontSize: 13, color: '#374151', lineHeight: 20 },
  confidenceBadge: {
    alignSelf: 'flex-start', backgroundColor: '#ede9fe', borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 3, marginTop: 6,
  },
  confidenceText: { fontFamily: 'Poppins_500Medium', fontSize: 10, color: '#6c5ce7' },
  headsUpToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8,
    backgroundColor: '#fffbeb', borderRadius: 10, padding: 10,
  },
  headsUpToggleText: { fontFamily: 'Poppins_500Medium', fontSize: 13, color: '#d97706', flex: 1 },
  radarCard: {
    backgroundColor: '#fff', borderRadius: 14, padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: 'rgba(108,92,231,0.1)',
  },
  radarTopic: { fontFamily: 'Poppins_600SemiBold', fontSize: 12, color: '#6c5ce7', marginBottom: 10 },
  radarExpert: { alignItems: 'center', marginRight: 16 },
  radarAvatar: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: '#ede9fe',
    alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  radarAvatarText: { fontFamily: 'Poppins_700Bold', fontSize: 16, color: '#6c5ce7' },
  radarName: { fontFamily: 'Poppins_400Regular', fontSize: 11, color: '#374151', maxWidth: 60, textAlign: 'center' },
  radarScoreBadge: {
    backgroundColor: '#f3f4f6', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2, marginTop: 3,
  },
  radarScore: { fontFamily: 'Poppins_600SemiBold', fontSize: 10, color: '#6b7280' },
});

// ─── Main Screen ─────────────────────────────────────────────────────────────

export default function BrainScreen() {
  const [activeTab, setActiveTab] = useState<Tab>('search');

  // Search state
  const [query, setQuery] = useState('');
  const [deptFilter, setDeptFilter] = useState('all');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  // Seed state
  const [seedMode, setSeedMode] = useState<'file' | 'text' | 'url'>('file');
  const [urlInput, setUrlInput] = useState('');
  const [textInput, setTextInput] = useState('');
  const [textTitle, setTextTitle] = useState('');
  const [seeding, setSeeding] = useState(false);
  const [seedSuccess, setSeedSuccess] = useState(false);
  const [jobs, setJobs] = useState<IngestionJob[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);

  // Onboarding state
  const [brief, setBrief] = useState<string | null>(null);
  const [loadingBrief, setLoadingBrief] = useState(false);

  // Ask state
  const [question, setQuestion] = useState('');
  const [askResult, setAskResult] = useState<{ answer?: string; expert?: any } | null>(null);
  const [asking, setAsking] = useState(false);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const seedSuccessScale = useRef(new Animated.Value(0)).current;

  const DEPARTMENTS = ['all', 'engineering', 'product', 'marketing', 'hr', 'finance', 'meetings', 'communications'];

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: true }).start();
  }, [activeTab]);

  const loadJobs = useCallback(async () => {
    setLoadingJobs(true);
    try {
      const data = await brainGetJobs();
      setJobs((data?.jobs || data?.data || []).slice(0, 10));
    } catch {
      /* silent */
    } finally {
      setLoadingJobs(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'seed') loadJobs();
  }, [activeTab, loadJobs]);

  // ── Search ──────────────────────────────────────────────────────────────────

  // Monotonic search id so a slow earlier request can't overwrite a newer one's
  // results (type "refund", search, refine to "refund policy", search again — the
  // first response must not clobber the second when it lands late).
  const searchSeqRef = useRef(0);

  const handleSearch = async () => {
    if (!query.trim()) return;
    const seq = ++searchSeqRef.current;
    setSearching(true);
    setSearchResults([]);
    try {
      const dept = deptFilter === 'all' ? undefined : deptFilter;
      const data = await brainSearch(query, dept, 8);
      if (seq !== searchSeqRef.current) return; // superseded by a newer search
      setSearchResults(data?.results || []);
    } catch (e: any) {
      if (seq !== searchSeqRef.current) return;
      Alert.alert('Search failed', e?.message || 'Search is temporarily unavailable. Please try again.');
    } finally {
      if (seq === searchSeqRef.current) setSearching(false);
    }
  };

  // ── Seed: file ──────────────────────────────────────────────────────────────

  const handlePickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'text/*', 'audio/*', 'video/*', 'application/msword',
               'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const file = result.assets[0];
      setSeeding(true);
      setSeedSuccess(false);
      await brainIngestFile({ uri: file.uri, name: file.name, type: file.mimeType || 'application/octet-stream' });
      triggerSuccess();
      loadJobs();
    } catch (e: any) {
      Alert.alert('Upload failed', e.message);
    } finally {
      setSeeding(false);
    }
  };

  // ── Seed: URL ───────────────────────────────────────────────────────────────

  const handleIngestUrl = async () => {
    if (!urlInput.trim()) return;
    setSeeding(true);
    setSeedSuccess(false);
    try {
      await brainIngestUrl(urlInput.trim());
      setUrlInput('');
      triggerSuccess();
      loadJobs();
    } catch (e: any) {
      Alert.alert('Ingest failed', e.message);
    } finally {
      setSeeding(false);
    }
  };

  // ── Seed: Text ──────────────────────────────────────────────────────────────

  const handleIngestText = async () => {
    if (!textInput.trim()) return;
    setSeeding(true);
    setSeedSuccess(false);
    try {
      await brainIngestText(textInput.trim(), textTitle || undefined);
      setTextInput('');
      setTextTitle('');
      triggerSuccess();
      loadJobs();
    } catch (e: any) {
      Alert.alert('Ingest failed', e.message);
    } finally {
      setSeeding(false);
    }
  };

  const triggerSuccess = () => {
    setSeedSuccess(true);
    seedSuccessScale.setValue(0);
    Animated.spring(seedSuccessScale, { toValue: 1, useNativeDriver: true, bounciness: 12 }).start();
    setTimeout(() => setSeedSuccess(false), 3000);
  };

  // ── Onboarding ──────────────────────────────────────────────────────────────

  const handleLoadBrief = async () => {
    setLoadingBrief(true);
    setBrief(null);
    try {
      const data = await brainOnboardingBrief();
      setBrief(data?.brief || data?.message || 'No brief available yet. Seed the brain with org content first.');
    } catch (e: any) {
      setBrief(`Could not load brief: ${e.message}`);
    } finally {
      setLoadingBrief(false);
    }
  };

  // ── Ask ─────────────────────────────────────────────────────────────────────

  const handleAsk = async () => {
    if (!question.trim()) return;
    setAsking(true);
    setAskResult(null);
    try {
      const data = await brainAskQuestion(question.trim());
      setAskResult({ answer: data?.answer, expert: data?.expert });
    } catch (e: any) {
      // 503 / network errors often carry no `.message` — avoid "Error: undefined".
      const msg = e?.message
        ? `Sorry, I couldn't answer that: ${e.message}`
        : "The Brain is temporarily unavailable — it may be warming up. Please try again in a moment.";
      setAskResult({ answer: msg });
    } finally {
      setAsking(false);
    }
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.brainIcon}>
            <Brain size={20} color="#6c5ce7" />
          </View>
          <View>
            <Text style={styles.headerTitle}>Company Brain</Text>
            <Text style={styles.headerSub}>Org knowledge at your fingertips</Text>
          </View>
        </View>
      </View>

      {/* Tab pills */}
      <View style={styles.tabRow}>
        {([
          { id: 'search',  label: 'Search',   icon: <Search size={14} color={activeTab === 'search'  ? '#fff' : '#9a9aab'} /> },
          { id: 'seed',    label: 'Seed',     icon: <Upload size={14} color={activeTab === 'seed'    ? '#fff' : '#9a9aab'} /> },
          { id: 'onboard', label: 'Onboard',  icon: <BookOpen size={14} color={activeTab === 'onboard'? '#fff' : '#9a9aab'} /> },
          { id: 'ask',     label: 'Ask',      icon: <Sparkles size={14} color={activeTab === 'ask'   ? '#fff' : '#9a9aab'} /> },
          { id: 'digest',  label: 'Digest',   icon: <Brain size={14} color={activeTab === 'digest'  ? '#fff' : '#9a9aab'} /> },
        ] as const).map(t => (
          <TouchableOpacity
            key={t.id}
            onPress={() => { fadeAnim.setValue(0); setActiveTab(t.id as Tab); }}
            style={[styles.tabPill, activeTab === t.id && styles.tabPillActive]}
            activeOpacity={0.8}
          >
            {t.icon}
            <Text style={[styles.tabPillText, activeTab === t.id && styles.tabPillTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

          {/* ─── SEARCH TAB ─── */}
          {activeTab === 'search' && (
            <View>
              <Text style={styles.sectionTitle}>Search the Brain</Text>
              <Text style={styles.sectionSub}>Ask anything — results are pulled semantically from your org's knowledge base.</Text>

              {/* Search bar */}
              <View style={styles.searchBar}>
                <Search size={16} color="#9a9aab" />
                <TextInput
                  style={styles.searchInput}
                  placeholder="e.g. 'how do we handle refunds?'"
                  placeholderTextColor="#9a9aab"
                  value={query}
                  onChangeText={setQuery}
                  onSubmitEditing={handleSearch}
                  returnKeyType="search"
                />
                {searching
                  ? <ActivityIndicator size="small" color="#6c5ce7" />
                  : (
                    <TouchableOpacity onPress={handleSearch} activeOpacity={0.7} style={styles.searchBtn}>
                      <Text style={styles.searchBtnText}>Go</Text>
                    </TouchableOpacity>
                  )}
              </View>

              {/* Department filter */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
                {DEPARTMENTS.map(d => (
                  <Chip key={d} label={d === 'all' ? 'All' : d.charAt(0).toUpperCase() + d.slice(1)}
                    active={deptFilter === d} onPress={() => setDeptFilter(d)} />
                ))}
              </ScrollView>

              {/* Results */}
              {searchResults.length > 0 && (
                <View style={styles.resultsContainer}>
                  {searchResults.map((r, i) => (
                    <View key={r.id || i} style={styles.resultCard}>
                      <View style={styles.resultHeader}>
                        <FileText size={14} color="#6c5ce7" />
                        <Text style={styles.resultTitle} numberOfLines={1}>{r.title}</Text>
                        {r.department && <Text style={styles.resultDept}>{r.department}</Text>}
                      </View>
                      <Text style={styles.resultChunk} numberOfLines={4}>{r.chunk}</Text>
                      {r.score && (
                        <Text style={styles.resultScore}>Relevance: {Math.round(r.score * 100)}%</Text>
                      )}
                    </View>
                  ))}
                </View>
              )}

              {!searching && query && searchResults.length === 0 && (
                <View style={styles.emptyState}>
                  <Brain size={40} color="#d1d5db" />
                  <Text style={styles.emptyText}>No results found. Try different keywords or seed more content.</Text>
                </View>
              )}

              {!query && (
                <View style={styles.emptyState}>
                  <Sparkles size={40} color="#e0dbff" />
                  <Text style={styles.emptyText}>Type a question to search across your organization's shared knowledge.</Text>
                </View>
              )}
            </View>
          )}

          {/* ─── SEED TAB ─── */}
          {activeTab === 'seed' && (
            <View>
              <Text style={styles.sectionTitle}>Seed the Brain</Text>
              <Text style={styles.sectionSub}>Upload files, paste links, or drop text to grow your org's knowledge base.</Text>

              {/* Mode selector */}
              <View style={styles.modeRow}>
                {([
                  { mode: 'file', icon: <Upload size={16} color={seedMode === 'file' ? '#6c5ce7' : '#9a9aab'} />, label: 'File / Audio' },
                  { mode: 'url',  icon: <Link2  size={16} color={seedMode === 'url'  ? '#6c5ce7' : '#9a9aab'} />, label: 'URL / Link' },
                  { mode: 'text', icon: <FileText size={16} color={seedMode === 'text' ? '#6c5ce7' : '#9a9aab'} />, label: 'Paste Text' },
                ] as const).map(m => (
                  <TouchableOpacity
                    key={m.mode}
                    style={[styles.modeCard, seedMode === m.mode && styles.modeCardActive]}
                    onPress={() => setSeedMode(m.mode)}
                    activeOpacity={0.75}
                  >
                    {m.icon}
                    <Text style={[styles.modeLabel, seedMode === m.mode && styles.modeLabelActive]}>{m.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* File upload */}
              {seedMode === 'file' && (
                <TouchableOpacity style={styles.dropZone} onPress={handlePickFile} activeOpacity={0.8} disabled={seeding}>
                  {seeding ? (
                    <ActivityIndicator size="large" color="#6c5ce7" />
                  ) : (
                    <>
                      <View style={styles.dropIcon}><Upload size={28} color="#6c5ce7" /></View>
                      <Text style={styles.dropTitle}>Tap to pick a file</Text>
                      <Text style={styles.dropSub}>PDF, DOCX, TXT, MP3, MP4 and more</Text>
                      <View style={styles.dropHint}><Mic size={12} color="#9a9aab" /><Text style={styles.dropHintText}>Audio files are auto-transcribed</Text></View>
                    </>
                  )}
                </TouchableOpacity>
              )}

              {/* URL ingest */}
              {seedMode === 'url' && (
                <View>
                  <View style={styles.inputGroup}>
                    <Link2 size={16} color="#9a9aab" style={styles.inputIcon} />
                    <TextInput
                      style={styles.textField}
                      placeholder="https://docs.company.com/handbook"
                      placeholderTextColor="#9a9aab"
                      value={urlInput}
                      onChangeText={setUrlInput}
                      autoCapitalize="none"
                      keyboardType="url"
                    />
                  </View>
                  <Text style={styles.inputHint}>Supports web pages, Google Docs (public), Notion pages, YouTube links, and more.</Text>
                  <TouchableOpacity
                    style={[styles.primaryBtn, seeding && styles.primaryBtnDisabled]}
                    onPress={handleIngestUrl}
                    disabled={seeding || !urlInput.trim()}
                    activeOpacity={0.8}
                  >
                    {seeding ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.primaryBtnText}>Ingest URL →</Text>}
                  </TouchableOpacity>
                </View>
              )}

              {/* Text paste */}
              {seedMode === 'text' && (
                <View>
                  <TextInput
                    style={styles.titleField}
                    placeholder="Title (optional)"
                    placeholderTextColor="#9a9aab"
                    value={textTitle}
                    onChangeText={setTextTitle}
                  />
                  <TextInput
                    style={[styles.textArea]}
                    placeholder="Paste your text, notes, ChatGPT export, meeting summary…"
                    placeholderTextColor="#9a9aab"
                    value={textInput}
                    onChangeText={setTextInput}
                    multiline
                    numberOfLines={8}
                    textAlignVertical="top"
                  />
                  <TouchableOpacity
                    style={[styles.primaryBtn, seeding && styles.primaryBtnDisabled]}
                    onPress={handleIngestText}
                    disabled={seeding || !textInput.trim()}
                    activeOpacity={0.8}
                  >
                    {seeding ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.primaryBtnText}>Ingest Text →</Text>}
                  </TouchableOpacity>
                </View>
              )}

              {/* Success flash */}
              {seedSuccess && (
                <Animated.View style={[styles.successBanner, { transform: [{ scale: seedSuccessScale }] }]}>
                  <CheckCircle size={18} color="#10b981" />
                  <Text style={styles.successText}>Queued for ingestion! The brain is learning…</Text>
                </Animated.View>
              )}

              {/* Jobs list */}
              <View style={styles.jobsHeader}>
                <Text style={styles.jobsTitle}>Recent Jobs</Text>
                <TouchableOpacity onPress={loadJobs} style={styles.refreshBtn}>
                  <RotateCcw size={14} color="#6c5ce7" />
                </TouchableOpacity>
              </View>

              {loadingJobs ? (
                <ActivityIndicator color="#6c5ce7" style={{ marginTop: 12 }} />
              ) : jobs.length === 0 ? (
                <Text style={styles.noJobs}>No ingestion jobs yet.</Text>
              ) : (
                jobs.map(j => (
                  <View key={j._id} style={styles.jobCard}>
                    <View style={styles.jobLeft}>
                      <FileText size={16} color="#6c5ce7" />
                      <View style={{ flex: 1, marginLeft: 10 }}>
                        <Text style={styles.jobTitle} numberOfLines={1}>{j.title || j.sourceType}</Text>
                        <Text style={styles.jobDate}>{new Date(j.createdAt).toLocaleString()}</Text>
                        {j.error && <Text style={styles.jobError}>{j.error}</Text>}
                      </View>
                    </View>
                    <StatusBadge status={j.status} />
                  </View>
                ))
              )}
            </View>
          )}

          {/* ─── ONBOARDING TAB ─── */}
          {activeTab === 'onboard' && (
            <View>
              <Text style={styles.sectionTitle}>Your Onboarding Brief</Text>
              <Text style={styles.sectionSub}>A personalized summary of what your organization knows, tailored for you as a new joiner.</Text>

              {!brief && !loadingBrief && (
                <TouchableOpacity style={styles.primaryBtn} onPress={handleLoadBrief} activeOpacity={0.8}>
                  <BookOpen size={16} color="#fff" />
                  <Text style={[styles.primaryBtnText, { marginLeft: 8 }]}>Generate My Brief</Text>
                </TouchableOpacity>
              )}

              {loadingBrief && (
                <View style={styles.loadingBlock}>
                  <ActivityIndicator color="#6c5ce7" size="large" />
                  <Text style={styles.loadingText}>Compiling your personalized brief…</Text>
                </View>
              )}

              {brief && (
                <View>
                  <View style={styles.briefCard}>
                    <View style={styles.briefHeader}>
                      <Sparkles size={16} color="#6c5ce7" />
                      <Text style={styles.briefHeaderText}>AI-Generated Brief</Text>
                    </View>
                    <Text style={styles.briefBody}>{brief}</Text>
                  </View>
                  <TouchableOpacity style={styles.ghostBtn} onPress={handleLoadBrief} activeOpacity={0.8}>
                    <RotateCcw size={14} color="#6c5ce7" />
                    <Text style={styles.ghostBtnText}>Regenerate</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}

          {/* ─── ASK TAB ─── */}
          {activeTab === 'ask' && (
            <View>
              <Text style={styles.sectionTitle}>Ask the Brain</Text>
              <Text style={styles.sectionSub}>Ask any work question — get an AI answer backed by org knowledge, plus the right expert to follow up with.</Text>

              <View style={styles.askBar}>
                <TextInput
                  style={styles.askInput}
                  placeholder="e.g. Who handles enterprise renewals?"
                  placeholderTextColor="#9a9aab"
                  value={question}
                  onChangeText={setQuestion}
                  multiline
                />
                <TouchableOpacity
                  style={[styles.askSend, asking && { opacity: 0.5 }]}
                  onPress={handleAsk}
                  disabled={asking || !question.trim()}
                  activeOpacity={0.75}
                >
                  {asking ? <ActivityIndicator color="#fff" size="small" /> : <Send size={16} color="#fff" />}
                </TouchableOpacity>
              </View>

              {askResult && (
                <View style={styles.askResultCard}>
                  {askResult.answer && (
                    <View style={styles.answerBlock}>
                      <View style={styles.answerHeaderRow}>
                        <Brain size={16} color="#6c5ce7" />
                        <Text style={styles.answerHeaderText}>Brain Answer</Text>
                      </View>
                      <Text style={styles.answerText}>{askResult.answer}</Text>
                    </View>
                  )}
                  {askResult.expert && (
                    <View style={styles.expertBlock}>
                      <Users size={14} color="#10b981" />
                      <View style={{ marginLeft: 8 }}>
                        <Text style={styles.expertLabel}>Suggested Expert</Text>
                        <Text style={styles.expertName}>
                          {askResult.expert.full_name || askResult.expert.username || 'A team member'}
                        </Text>
                        {askResult.expert.topTags?.length > 0 && (
                          <Text style={styles.expertTags}>{askResult.expert.topTags.slice(0, 3).join(' · ')}</Text>
                        )}
                      </View>
                    </View>
                  )}
                </View>
              )}

              {!askResult && !asking && (
                <View style={styles.emptyState}>
                  <MessageSquare size={40} color="#e0dbff" />
                  <Text style={styles.emptyText}>Your question will be matched against org documents and the right expert will be suggested.</Text>
                </View>
              )}
            </View>
          )}

          {/* ─── DIGEST TAB ─── */}
          {activeTab === 'digest' && (
            <DigestTab />
          )}

          <View style={{ height: 120 }} />
        </ScrollView>
      </Animated.View>
    </KeyboardAvoidingView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#f8f7ff',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'ios' ? 58 : 36,
    paddingBottom: 12,
    backgroundColor: '#f8f7ff',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  brainIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: '#ede9fe',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontFamily: 'Poppins_700Bold',
    fontSize: 18,
    color: '#1a1a2e',
  },
  headerSub: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 11,
    color: '#9a9aab',
    marginTop: -2,
  },
  tabRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 4,
  },
  tabPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: 'rgba(108,92,231,0.1)',
  },
  tabPillActive: {
    backgroundColor: '#6c5ce7',
    borderColor: '#6c5ce7',
  },
  tabPillText: {
    fontFamily: 'Poppins_500Medium',
    fontSize: 11,
    color: '#9a9aab',
  },
  tabPillTextActive: {
    color: '#fff',
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  sectionTitle: {
    fontFamily: 'Poppins_700Bold',
    fontSize: 20,
    color: '#1a1a2e',
    marginBottom: 4,
  },
  sectionSub: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 13,
    color: '#6b7280',
    marginBottom: 20,
    lineHeight: 20,
  },
  // Search
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: 'rgba(108,92,231,0.12)',
    gap: 10,
    marginBottom: 12,
    shadowColor: '#6c5ce7',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  searchInput: {
    flex: 1,
    fontFamily: 'Poppins_400Regular',
    fontSize: 14,
    color: '#1a1a2e',
  },
  searchBtn: {
    backgroundColor: '#6c5ce7',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 10,
  },
  searchBtnText: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 13,
    color: '#fff',
  },
  chipRow: {
    marginBottom: 16,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#fff',
    marginRight: 8,
    borderWidth: 1,
    borderColor: 'rgba(108,92,231,0.15)',
  },
  chipActive: {
    backgroundColor: '#6c5ce7',
    borderColor: '#6c5ce7',
  },
  chipText: {
    fontFamily: 'Poppins_500Medium',
    fontSize: 12,
    color: '#6b7280',
  },
  chipTextActive: {
    color: '#fff',
  },
  resultsContainer: { gap: 12 },
  resultCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(108,92,231,0.08)',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  resultHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  resultTitle: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 13,
    color: '#1a1a2e',
    flex: 1,
  },
  resultDept: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 10,
    color: '#9a9aab',
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  resultChunk: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 13,
    color: '#4b5563',
    lineHeight: 20,
  },
  resultScore: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 11,
    color: '#9a9aab',
    marginTop: 8,
    textAlign: 'right',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
    gap: 14,
  },
  emptyText: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 14,
    color: '#9a9aab',
    textAlign: 'center',
    maxWidth: 280,
    lineHeight: 22,
  },
  // Seed
  modeRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 20,
  },
  modeCard: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: 'rgba(108,92,231,0.12)',
    gap: 6,
  },
  modeCardActive: {
    borderColor: '#6c5ce7',
    backgroundColor: '#ede9fe',
  },
  modeLabel: {
    fontFamily: 'Poppins_500Medium',
    fontSize: 11,
    color: '#9a9aab',
    textAlign: 'center',
  },
  modeLabelActive: {
    color: '#6c5ce7',
  },
  dropZone: {
    borderWidth: 1.5,
    borderColor: '#6c5ce7',
    borderStyle: 'dashed',
    borderRadius: 20,
    paddingVertical: 40,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#faf8ff',
    gap: 8,
    marginBottom: 20,
  },
  dropIcon: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: '#ede9fe',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  dropTitle: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 15,
    color: '#1a1a2e',
  },
  dropSub: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 12,
    color: '#9a9aab',
  },
  dropHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 4,
  },
  dropHintText: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 11,
    color: '#9a9aab',
  },
  inputGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(108,92,231,0.12)',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
    marginBottom: 8,
  },
  inputIcon: {},
  textField: {
    flex: 1,
    fontFamily: 'Poppins_400Regular',
    fontSize: 14,
    color: '#1a1a2e',
  },
  inputHint: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 11,
    color: '#9a9aab',
    marginBottom: 16,
    lineHeight: 16,
  },
  titleField: {
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(108,92,231,0.12)',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: 'Poppins_400Regular',
    fontSize: 14,
    color: '#1a1a2e',
    marginBottom: 10,
  },
  textArea: {
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(108,92,231,0.12)',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: 'Poppins_400Regular',
    fontSize: 14,
    color: '#1a1a2e',
    minHeight: 140,
    marginBottom: 14,
  },
  primaryBtn: {
    flexDirection: 'row',
    backgroundColor: '#6c5ce7',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    gap: 8,
    shadowColor: '#6c5ce7',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 6,
  },
  primaryBtnDisabled: {
    opacity: 0.5,
  },
  primaryBtnText: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 15,
    color: '#fff',
  },
  successBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#d1fae5',
    borderRadius: 12,
    padding: 14,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#6ee7b7',
  },
  successText: {
    fontFamily: 'Poppins_500Medium',
    fontSize: 13,
    color: '#065f46',
    flex: 1,
  },
  jobsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  jobsTitle: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 15,
    color: '#1a1a2e',
  },
  refreshBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: '#ede9fe',
  },
  noJobs: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 13,
    color: '#9a9aab',
    textAlign: 'center',
    paddingVertical: 16,
  },
  jobCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: 'rgba(108,92,231,0.07)',
  },
  jobLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 10,
  },
  jobTitle: {
    fontFamily: 'Poppins_500Medium',
    fontSize: 13,
    color: '#1a1a2e',
  },
  jobDate: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 11,
    color: '#9a9aab',
    marginTop: 2,
  },
  jobError: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 11,
    color: '#ef4444',
    marginTop: 2,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
  },
  badgeText: {
    fontFamily: 'Poppins_500Medium',
    fontSize: 10,
  },
  // Onboarding
  loadingBlock: {
    alignItems: 'center',
    paddingVertical: 40,
    gap: 14,
  },
  loadingText: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 13,
    color: '#9a9aab',
    textAlign: 'center',
  },
  briefCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(108,92,231,0.1)',
    marginBottom: 14,
    shadowColor: '#6c5ce7',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
  },
  briefHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(108,92,231,0.08)',
  },
  briefHeaderText: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 14,
    color: '#6c5ce7',
  },
  briefBody: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 14,
    color: '#374151',
    lineHeight: 24,
  },
  ghostBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#6c5ce7',
    marginBottom: 20,
  },
  ghostBtnText: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 14,
    color: '#6c5ce7',
  },
  // Ask
  askBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: '#fff',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(108,92,231,0.12)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
    marginBottom: 20,
    shadowColor: '#6c5ce7',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  askInput: {
    flex: 1,
    fontFamily: 'Poppins_400Regular',
    fontSize: 14,
    color: '#1a1a2e',
    maxHeight: 100,
  },
  askSend: {
    backgroundColor: '#6c5ce7',
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  askResultCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: 'rgba(108,92,231,0.1)',
    gap: 16,
    shadowColor: '#6c5ce7',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
  },
  answerBlock: { gap: 10 },
  answerHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  answerHeaderText: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 13,
    color: '#6c5ce7',
  },
  answerText: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 14,
    color: '#374151',
    lineHeight: 22,
  },
  expertBlock: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#f0fdf4',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#6ee7b7',
  },
  expertLabel: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 11,
    color: '#6b7280',
  },
  expertName: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 14,
    color: '#065f46',
  },
  expertTags: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 11,
    color: '#10b981',
    marginTop: 2,
  },
});
