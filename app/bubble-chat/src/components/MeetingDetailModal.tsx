import React, { useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Modal, Alert, ActivityIndicator } from 'react-native';
import { Calendar, Clock, X, Check, Mail } from 'lucide-react-native';
import { Image } from 'expo-image';
import { emailMeetingTranscript } from '../lib/api';

function getInitials(name: string) {
  if (!name) return 'UC';
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/**
 * Tabbed meeting-detail bottom sheet (Summary | Action Items | Transcript).
 * Shared by the Calls screen and People → History so both stay in sync with the
 * web Events & Meet detail view.
 */
export function MeetingDetailModal({ meeting, loading, onClose }: { meeting: any; loading: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'summary' | 'actions' | 'transcript'>('summary');
  const [emailLoading, setEmailLoading] = useState(false);

  if (!meeting) return null;

  const handleEmailTranscript = async () => {
    setEmailLoading(true);
    try {
      const res = await emailMeetingTranscript(meeting._id || meeting.id);
      Alert.alert('Sent!', res.message || 'Transcript emailed to you.');
    } catch (err: any) {
      Alert.alert('Failed', err.message || 'Could not send the email. Try again later.');
    } finally {
      setEmailLoading(false);
    }
  };

  const hasActions = Array.isArray(meeting.actionItems) && meeting.actionItems.length > 0;
  const hasTranscript = !!(meeting.transcriptRaw || (Array.isArray(meeting.transcriptChunks) && meeting.transcriptChunks.length > 0));

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(31,32,48,0.5)', justifyContent: 'flex-end' }}>
        <View style={{ backgroundColor: '#ffffff', borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '88%' }}>
          {/* Handle */}
          <View style={{ alignItems: 'center', paddingTop: 12, paddingBottom: 4 }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.12)' }} />
          </View>

          {/* Title row */}
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingHorizontal: 22, paddingBottom: 4 }}>
            <Text style={{ fontSize: 17, fontFamily: 'SpaceGrotesk_700Bold', color: '#1f2030', flex: 1 }} numberOfLines={2}>
              {meeting.title || 'Meeting'}
            </Text>
            <TouchableOpacity onPress={onClose} style={{ padding: 6 }}>
              <X size={20} color="#1f2030" />
            </TouchableOpacity>
          </View>

          {/* Metadata: date + duration */}
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 22, paddingBottom: 10, gap: 12 }}>
            {meeting.startedAt ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Calendar size={12} color="#9a9aab" />
                <Text style={{ fontSize: 11, color: '#9a9aab', fontFamily: 'Poppins_400Regular' }}>
                  {new Date(meeting.startedAt).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </Text>
              </View>
            ) : null}
            {meeting.duration ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Clock size={12} color="#9a9aab" />
                <Text style={{ fontSize: 11, color: '#9a9aab', fontFamily: 'Poppins_400Regular' }}>
                  {Math.floor(meeting.duration / 60)}:{String(meeting.duration % 60).padStart(2, '0')}
                </Text>
              </View>
            ) : null}
            {loading && (
              <Text style={{ fontSize: 11, color: '#9a9aab', fontFamily: 'Poppins_400Regular' }}>Loading…</Text>
            )}
          </View>

          {/* Attendees */}
          {Array.isArray(meeting.attendees) && meeting.attendees.length > 0 && (
            <View style={{ paddingHorizontal: 22, paddingBottom: 10 }}>
              <Text style={{ fontSize: 10, color: '#9a9aab', fontFamily: 'Poppins_700Bold', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Attendees</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {meeting.attendees.map((a: any, i: number) => {
                  const name = a?.full_name || a?.username || (typeof a === 'string' ? a : 'User');
                  const initials = getInitials(name);
                  return (
                    <View key={i} style={{ alignItems: 'center', marginRight: 12 }}>
                      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: '#ede9fe', alignItems: 'center', justifyContent: 'center', marginBottom: 3 }}>
                        {a?.avatar ? (
                          <Image source={{ uri: a.avatar }} style={{ width: 36, height: 36, borderRadius: 18 }} contentFit="cover" />
                        ) : (
                          <Text style={{ fontSize: 12, fontFamily: 'SpaceGrotesk_700Bold', color: '#6c5ce7' }}>{initials}</Text>
                        )}
                      </View>
                      <Text style={{ fontSize: 9, color: '#1f2030', fontFamily: 'Poppins_600SemiBold', maxWidth: 50, textAlign: 'center' }} numberOfLines={1}>
                        {name.split(' ')[0]}
                      </Text>
                    </View>
                  );
                })}
              </ScrollView>
            </View>
          )}

          {/* Tab bar */}
          <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.06)', paddingHorizontal: 22 }}>
            {(['summary', 'actions', 'transcript'] as const).map((t) => {
              const label = t === 'summary' ? 'Summary' : t === 'actions' ? `Action Items${hasActions ? ` (${meeting.actionItems.length})` : ''}` : 'Transcript';
              const active = tab === t;
              return (
                <TouchableOpacity
                  key={t}
                  onPress={() => setTab(t)}
                  style={{ marginRight: 20, paddingBottom: 10, paddingTop: 4, borderBottomWidth: 2, borderBottomColor: active ? '#6c5ce7' : 'transparent' }}
                >
                  <Text style={{ fontSize: 12, fontFamily: active ? 'Poppins_700Bold' : 'Poppins_600SemiBold', color: active ? '#6c5ce7' : '#9a9aab' }}>
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <ScrollView style={{ padding: 22 }} contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
            {tab === 'summary' && (
              <>
                {meeting.agenda ? (
                  <View style={{ marginBottom: 16, padding: 12, backgroundColor: 'rgba(108,92,231,0.06)', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(108,92,231,0.15)' }}>
                    <Text style={{ fontSize: 10, fontFamily: 'Poppins_700Bold', color: '#6c5ce7', letterSpacing: 1, marginBottom: 4 }}>AGENDA</Text>
                    <Text style={{ fontSize: 12.5, color: '#1f2030', lineHeight: 19, fontFamily: 'Poppins_400Regular' }}>{meeting.agenda}</Text>
                  </View>
                ) : null}
                <Text style={{ fontSize: 13, color: '#1f2030', lineHeight: 20, fontFamily: 'Poppins_400Regular' }}>
                  {meeting.summary || 'AI summary is generating or unavailable for this meeting.'}
                </Text>
              </>
            )}

            {tab === 'actions' && Array.isArray(meeting.carriedOverActionItems) && meeting.carriedOverActionItems.length > 0 && (
              <View style={{ marginBottom: 14 }}>
                <Text style={{ fontSize: 10, fontFamily: 'Poppins_700Bold', color: '#f59e0b', letterSpacing: 1, marginBottom: 6 }}>
                  CARRIED OVER FROM LAST MEETING
                </Text>
                {meeting.carriedOverActionItems.map((ai: any, i: number) => (
                  <View key={`carry-${i}`} style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8, padding: 12, backgroundColor: 'rgba(245,158,11,0.06)', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(245,158,11,0.2)' }}>
                    <Check size={14} color="#f59e0b" style={{ marginTop: 2 }} />
                    <View style={{ flex: 1, marginLeft: 8 }}>
                      <Text style={{ fontSize: 13, fontFamily: 'Poppins_600SemiBold', color: '#1f2030' }}>{ai.text || String(ai)}</Text>
                      {(ai.assignedToName || ai.assignedTo?.full_name) && (
                        <Text style={{ fontSize: 10, color: '#f59e0b', fontFamily: 'Poppins_700Bold', marginTop: 2 }}>
                          Assigned: {ai.assignedToName || ai.assignedTo?.full_name}
                        </Text>
                      )}
                      {ai.fromMeeting?.title ? (
                        <Text style={{ fontSize: 9.5, color: '#9a9aab', fontFamily: 'Poppins_400Regular', marginTop: 2 }}>
                          From “{ai.fromMeeting.title}”
                        </Text>
                      ) : null}
                    </View>
                  </View>
                ))}
              </View>
            )}

            {tab === 'actions' && (
              hasActions ? meeting.actionItems.map((ai: any, i: number) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10, padding: 12, backgroundColor: '#f8f8fb', borderRadius: 14, borderWidth: 1, borderColor: 'rgba(0,0,0,0.05)' }}>
                  <Check size={14} color={ai.status === 'done' ? '#10b981' : '#9a9aab'} style={{ marginTop: 2 }} />
                  <View style={{ flex: 1, marginLeft: 8 }}>
                    <Text style={{ fontSize: 13, fontFamily: 'Poppins_600SemiBold', color: '#1f2030' }}>{ai.text || ai.title || String(ai)}</Text>
                    {(ai.assignedToName || ai.assignedTo?.full_name) && (
                      <Text style={{ fontSize: 10, color: '#6c5ce7', fontFamily: 'Poppins_700Bold', marginTop: 2 }}>
                        Assigned: {ai.assignedToName || ai.assignedTo?.full_name}
                      </Text>
                    )}
                  </View>
                </View>
              )) : (
                <Text style={{ fontSize: 12, color: '#9a9aab', fontFamily: 'Poppins_400Regular', textAlign: 'center', marginTop: 24 }}>
                  No action items captured for this meeting.
                </Text>
              )
            )}

            {tab === 'transcript' && (
              <>
                <TouchableOpacity
                  onPress={handleEmailTranscript}
                  disabled={emailLoading}
                  style={{
                    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                    backgroundColor: emailLoading ? '#ede9fe' : '#6c5ce7',
                    borderRadius: 12, paddingVertical: 10, paddingHorizontal: 18, marginBottom: 16,
                    opacity: emailLoading ? 0.7 : 1,
                  }}
                >
                  {emailLoading
                    ? <ActivityIndicator size="small" color="#6c5ce7" />
                    : <Mail size={14} color="#ffffff" />}
                  <Text style={{ fontSize: 13, fontFamily: 'Poppins_700Bold', color: emailLoading ? '#6c5ce7' : '#ffffff' }}>
                    {emailLoading ? 'Sending…' : 'Email me this transcript'}
                  </Text>
                </TouchableOpacity>
                {hasTranscript ? (
                  Array.isArray(meeting.transcriptChunks) && meeting.transcriptChunks.length > 0
                    ? meeting.transcriptChunks.map((c: any, i: number) => (
                        <View key={i} style={{ marginBottom: 8 }}>
                          {c.speaker ? <Text style={{ fontSize: 11, fontFamily: 'Poppins_700Bold', color: '#6c5ce7' }}>{c.speaker}</Text> : null}
                          <Text style={{ fontSize: 13, color: '#1f2030', lineHeight: 20, fontFamily: 'Poppins_400Regular' }}>{c.text}</Text>
                        </View>
                      ))
                    : <Text style={{ fontSize: 13, color: '#1f2030', lineHeight: 20, fontFamily: 'Poppins_400Regular' }}>{meeting.transcriptRaw}</Text>
                ) : (
                  <Text style={{ fontSize: 12, color: '#9a9aab', fontFamily: 'Poppins_400Regular', textAlign: 'center', marginTop: 24 }}>
                    No transcript captured for this meeting.
                  </Text>
                )}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export default MeetingDetailModal;
