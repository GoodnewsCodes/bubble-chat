import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSocket } from './socket';
import { RingtonePlayer } from './ringtone';
import { createMeeting, endMeeting } from './api';
import { authStorage } from './authStorage';

// Persist the active call so a cold-started app can offer to rejoin an ongoing
// meeting (mirrors the web's `bubble_active_meeting` localStorage approach).
const ACTIVE_CALL_KEY = 'bubble_active_call';

export const getPersistedCall = async (): Promise<{ roomId: string; type: 'voice' | 'video' } | null> => {
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_CALL_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};

export const clearPersistedCall = async () => {
  try { await AsyncStorage.removeItem(ACTIVE_CALL_KEY); } catch { /* best-effort */ }
};

const persistCall = (roomId: string, type: 'voice' | 'video') => {
  AsyncStorage.setItem(ACTIVE_CALL_KEY, JSON.stringify({ roomId, type })).catch(() => undefined);
};

export type CallState =
  | { status: 'idle' }
  | { status: 'calling_out'; user: any; type: 'voice' | 'video'; roomId: string }
  | { status: 'calling_in'; callerId: string; callerName: string; callerAvatar?: string; type: 'voice' | 'video'; roomId: string }
  | { status: 'in_call'; user: any; type: 'voice' | 'video'; roomId: string; duration: number; meetingDbId: string | null; hostId?: string | null; isHost?: boolean };

// The authoritative meeting host is whoever the backend recorded as `host` (the first
// client to create the Meeting record). We compare it against the local user id so the
// overlay can offer the end-call "save/email transcript" options only to the host.
const resolveHost = async (createMeetingRes: any): Promise<{ hostId: string | null; isHost: boolean }> => {
  const hostId = createMeetingRes?.meeting?.host ? String(createMeetingRes.meeting.host) : null;
  try {
    const me = await authStorage.getUser();
    const myId = String(me?._id || me?.id || '');
    return { hostId, isHost: hostId ? hostId === myId : true };
  } catch {
    return { hostId, isHost: true };
  }
};

let currentCallState: CallState = { status: 'idle' };
let listeners: ((state: CallState) => void)[] = [];
let ringtonePlayer: RingtonePlayer | null = null;
let durationInterval: any = null;
let callTimeout: any = null;
// Signed token from a /call/join deep link; the call overlay forwards it to the
// LiveKit token endpoint so a link-joined room is verified server-side.
let linkJoinToken: string | null = null;

export const getLinkJoinToken = () => linkJoinToken;

export const subscribeCallState = (listener: (state: CallState) => void) => {
  listeners.push(listener);
  listener(currentCallState);
  return () => {
    listeners = listeners.filter(l => l !== listener);
  };
};

const notify = () => {
  listeners.forEach(l => {
    try { l(currentCallState); } catch (e) {}
  });
};

export const setCallState = (newState: CallState) => {
  currentCallState = newState;
  // Keep the persisted "active call" in sync so a killed app can offer to rejoin.
  if (newState.status === 'in_call') {
    persistCall(newState.roomId, newState.type);
  } else if (newState.status === 'idle') {
    clearPersistedCall();
  }
  notify();
};

export const getCallState = () => currentCallState;

export const startRingtone = (type: 'incoming' | 'outgoing') => {
  if (!ringtonePlayer) {
    ringtonePlayer = new RingtonePlayer();
  }
  ringtonePlayer.startRinging(type);
};

export const stopRingtone = () => {
  if (ringtonePlayer) {
    ringtonePlayer.stop();
    ringtonePlayer = null;
  }
};

export const startOutgoingCall = async (user: any, type: 'voice' | 'video') => {
  const roomId = `bubble-${Math.random().toString(36).slice(2, 11)}`;
  
  // Update state immediately to open calling overlay for the host
  setCallState({
    status: 'calling_out',
    user,
    type,
    roomId
  });

  startRingtone('outgoing');

  const socket = getSocket();
  const currentUser = await authStorage.getUser();
  const callerName = currentUser?.full_name || currentUser?.username || 'Bubble User';
  const callerAvatar = currentUser?.avatar || null;

  if (socket) {
    // Emit call offer to backend with authentic caller details
    socket.emit('call_offer', {
      toUserId: user.id || user._id || user.otherUserId,
      roomId,
      callerName,
      callerAvatar,
      type
    });
  } else {
    console.warn("Socket not initialized. Attempting call on disconnected socket.");
  }

  // Timeout if no answer after 30 seconds
  if (callTimeout) clearTimeout(callTimeout);
  callTimeout = setTimeout(() => {
    if (socket) {
      socket.emit('call_reject', { toUserId: user.id || user._id || user.otherUserId });
    }
    hangUpCall();
  }, 30000);
};

export const acceptIncomingCall = async () => {
  const socket = getSocket();
  const state = currentCallState;
  if (!socket || state.status !== 'calling_in') return;

  if (callTimeout) clearTimeout(callTimeout);
  stopRingtone();

  // Emit call answer
  socket.emit('call_answer', {
    toUserId: state.callerId,
    roomId: state.roomId
  });

  // Create meeting in database
  let dbId: string | null = null;
  let host: { hostId: string | null; isHost: boolean } = { hostId: null, isHost: true };
  try {
    const res = await createMeeting({
      roomId: state.roomId,
      title: `${state.type === 'video' ? 'Video' : 'Voice'} Call`,
      type: state.type
    });
    dbId = res?.meeting?._id || res?._id || null;
    host = await resolveHost(res);
    if (dbId) {
      socket.emit('meeting_started', { roomId: state.roomId, meetingId: dbId });
    }
  } catch (err) {
    console.warn('Failed to create meeting record:', err);
  }

  setCallState({
    status: 'in_call',
    user: { name: state.callerName, avatar: state.callerAvatar, id: state.callerId },
    type: state.type,
    roomId: state.roomId,
    duration: 0,
    meetingDbId: dbId,
    hostId: host.hostId,
    isHost: host.isHost,
  });

  startDurationTimer();
};

export const declineIncomingCall = () => {
  const socket = getSocket();
  const state = currentCallState;
  if (!socket || state.status !== 'calling_in') return;

  if (callTimeout) clearTimeout(callTimeout);
  stopRingtone();

  socket.emit('call_reject', { toUserId: state.callerId });
  setCallState({ status: 'idle' });
};

// End/leave the current call. For an in-call host, `opts` carries the transcript
// preferences chosen in the end-call sheet (save to storage / email attendees). The
// backend gates `meeting_ended` + endMeeting by host, so a non-host simply leaves.
export const hangUpCall = async (opts?: { saveToStorage?: boolean; sendEmail?: boolean }) => {
  const socket = getSocket();
  const state = currentCallState;
  if (callTimeout) clearTimeout(callTimeout);
  stopRingtone();
  stopDurationTimer();

  if (state.status === 'calling_out') {
    const targetUserId = state.user?.id || state.user?._id || state.user?.otherUserId;
    if (socket) {
      socket.emit('call_reject', { toUserId: targetUserId, roomId: state.roomId });
      socket.emit('call_end', { toUserId: targetUserId, roomId: state.roomId });
    }
  } else if (state.status === 'calling_in') {
    // Tearing down an unanswered incoming call — tell the caller so their side resets too.
    if (socket) {
      socket.emit('call_reject', { toUserId: state.callerId, roomId: state.roomId });
    }
  } else if (state.status === 'in_call') {
    const targetUserId = state.user.id || state.user._id || state.user.otherUserId;
    if (socket) {
      socket.emit('call_end', { toUserId: targetUserId, roomId: state.roomId });
      socket.emit('meeting_ended', { roomId: state.roomId });
    }

    // Persist + close out the meeting on the server with the chosen transcript options.
    // Defaults preserve the prior behaviour for non-prompt exits (peer hangup, timeout).
    if (state.meetingDbId) {
      try {
        await endMeeting(state.meetingDbId, {
          saveToStorage: opts?.saveToStorage ?? true,
          sendEmail: opts?.sendEmail ?? true,
        });
      } catch (err) {
        console.warn('Failed to end meeting on server:', err);
      }
    }
  }

  setCallState({ status: 'idle' });
  linkJoinToken = null;
};

// Ring an ADDITIONAL participant into the call that's already running. Reuses the
// current room so they join the same LiveKit room (server emits call_invite →
// incoming_call). The invitee is idle, so their busy-reject guard passes.
export const inviteToCall = async (user: any) => {
  const state = currentCallState;
  if (state.status !== 'in_call') return;
  const socket = getSocket();
  if (!socket) return;

  const currentUser = await authStorage.getUser();
  const callerName = currentUser?.full_name || currentUser?.username || 'Bubble User';
  const callerAvatar = currentUser?.avatar || null;

  socket.emit('call_invite', {
    toUserId: user.id || user._id || user.otherUserId,
    roomId: state.roomId,
    callerName,
    callerAvatar,
    type: state.type,
  });
};

// Join an existing room from a deep link (no call_offer). Stashes the signed
// joinToken so the overlay's token fetch can verify it.
export const joinRoomByLink = async ({ roomId, type, joinToken }: { roomId: string; type: 'voice' | 'video'; joinToken?: string }) => {
  if (currentCallState.status !== 'idle') return;
  linkJoinToken = joinToken || null;

  let dbId: string | null = null;
  let host: { hostId: string | null; isHost: boolean } = { hostId: null, isHost: false };
  try {
    const res = await createMeeting({
      roomId,
      title: `${type === 'video' ? 'Video' : 'Voice'} Call`,
      type,
    });
    dbId = res?.meeting?._id || res?._id || null;
    host = await resolveHost(res);
  } catch (err) {
    console.warn('Failed to create meeting record for link join:', err);
  }

  setCallState({
    status: 'in_call',
    user: { name: 'Meeting', id: roomId },
    type,
    roomId,
    duration: 0,
    meetingDbId: dbId,
    hostId: host.hostId,
    isHost: host.isHost,
  });

  startDurationTimer();
};

// Knock to join a LIVE room: instead of barging in, ask the host/participants to
// admit you. Emits `room_knock`; the server relays it to whoever is in the room.
// The requester enters only when a `room_knock_response` accept arrives (handled
// in setupCallSocketListeners → joinRoomByLink). No-op if already in a call.
export const knockToJoinRoom = async ({ roomId, hostId, type }: { roomId: string; hostId?: string; type: 'voice' | 'video' }) => {
  if (currentCallState.status !== 'idle') return;
  const socket = getSocket();
  if (!socket) {
    Alert.alert('Not connected', 'Could not reach the server to request access.');
    return;
  }
  const currentUser = await authStorage.getUser();
  socket.emit('room_knock', {
    roomId,
    hostId,
    requesterAvatar: currentUser?.avatar || null,
    type,
  });
  // Stash the type so the accept handler joins with the right modality.
  pendingKnockType[roomId] = type;
  Alert.alert('Request sent', 'Waiting for the host to let you in…');
};

// Remembers the modality of each outstanding knock so we join with voice/video
// correctly when the accept comes back (the response echoes type too, as a fallback).
const pendingKnockType: Record<string, 'voice' | 'video'> = {};

// Rejoin an ongoing meeting after an app cold-start. Reuses the link-join path
// (createMeeting de-dups to the existing live record). No-op if already in a call.
export const rejoinPersistedCall = async ({ roomId, type }: { roomId: string; type: 'voice' | 'video' }) => {
  if (currentCallState.status !== 'idle') return;
  await joinRoomByLink({ roomId, type });
};

// Start a group call: ring every other member into one room (call_invite) and enter
// the room as host. LiveKit hosts the N-way media; the overlay renders the call.
export const startGroupCall = async (members: any[], type: 'voice' | 'video', groupName?: string) => {
  const roomId = `bubble-group-${Math.random().toString(36).slice(2, 11)}`;
  const socket = getSocket();
  const currentUser = await authStorage.getUser();
  const myId = String(currentUser?._id || currentUser?.id || '');
  const callerName = currentUser?.full_name || currentUser?.username || 'Bubble User';
  const callerAvatar = currentUser?.avatar || null;

  const targets = (members || [])
    .map((m: any) => String(m._id || m.id || m))
    .filter((mid) => mid && mid !== myId);

  if (socket) {
    for (const toUserId of targets) {
      socket.emit('call_invite', { toUserId, roomId, callerName, callerAvatar, type });
    }
  }

  let dbId: string | null = null;
  let host: { hostId: string | null; isHost: boolean } = { hostId: null, isHost: true };
  try {
    const res = await createMeeting({
      roomId,
      title: `${groupName || 'Group'} ${type === 'video' ? 'Video' : 'Voice'} Call`,
      type,
    });
    dbId = res?.meeting?._id || res?._id || null;
    host = await resolveHost(res);
    if (dbId && socket) socket.emit('meeting_started', { roomId, meetingId: dbId });
  } catch (err) {
    console.warn('Failed to create group meeting record:', err);
  }

  setCallState({
    status: 'in_call',
    user: { name: groupName || 'Group call', id: roomId },
    type,
    roomId,
    duration: 0,
    meetingDbId: dbId,
    hostId: host.hostId,
    isHost: host.isHost,
  });
  startDurationTimer();
};

const startDurationTimer = () => {
  if (durationInterval) clearInterval(durationInterval);
  durationInterval = setInterval(() => {
    const prev = getCallState();
    if (prev.status === 'in_call') {
      setCallState({ ...prev, duration: prev.duration + 1 });
    }
  }, 1000);
};

const stopDurationTimer = () => {
  if (durationInterval) {
    clearInterval(durationInterval);
    durationInterval = null;
  }
};

// Setup Socket Listeners
export const setupCallSocketListeners = (socket: any) => {
  if (!socket) return;

  // Remove duplicate listeners if any
  socket.off('incoming_call');
  socket.off('call_accepted');
  socket.off('call_rejected');
  socket.off('call_ended');
  socket.off('meeting_ended');
  socket.off('room_knock');
  socket.off('room_knock_response');

  socket.on('incoming_call', (data: { fromUserId: string; roomId: string; callerName?: string; callerAvatar?: string; type?: 'voice' | 'video' }) => {
    if (currentCallState.status !== 'idle') {
      // Busy, reject immediately
      socket.emit('call_reject', { toUserId: data.fromUserId });
      return;
    }

    setCallState({
      status: 'calling_in',
      callerId: data.fromUserId,
      callerName: data.callerName || 'Bubble User',
      callerAvatar: data.callerAvatar,
      roomId: data.roomId,
      type: data.type || 'voice'
    });

    startRingtone('incoming');

    if (callTimeout) clearTimeout(callTimeout);
    callTimeout = setTimeout(() => {
      declineIncomingCall();
    }, 30000);
  });

  socket.on('call_accepted', async (data: { byUserId: string; roomId: string }) => {
    if (currentCallState.status !== 'calling_out') return;
    if (callTimeout) clearTimeout(callTimeout);
    stopRingtone();

    // Host also creates/updates meeting DB record on accept
    let dbId: string | null = null;
    let host: { hostId: string | null; isHost: boolean } = { hostId: null, isHost: true };
    try {
      const user = currentCallState.user || {};
      const chatId = user.chatId || user.id || user._id || user.otherChatId;
      const otherUserId = user.otherUserId || user.id || user._id;
      const res = await createMeeting({
        roomId: data.roomId,
        title: `${currentCallState.type === 'video' ? 'Video' : 'Voice'} Call`,
        type: currentCallState.type,
        chatId,
        attendees: otherUserId ? [otherUserId] : [],
      });
      dbId = res?.meeting?._id || res?._id || null;
      host = await resolveHost(res);
      if (dbId) {
        socket.emit('meeting_started', { roomId: data.roomId, meetingId: dbId });
      }
    } catch (err) {
      console.warn('Failed to create meeting record:', err);
    }

    // currentCallState may have changed while awaiting; re-check we're still calling out.
    if (currentCallState.status !== 'calling_out') return;
    setCallState({
      status: 'in_call',
      user: currentCallState.user,
      type: currentCallState.type,
      roomId: data.roomId,
      duration: 0,
      meetingDbId: dbId,
      hostId: host.hostId,
      isHost: host.isHost,
    });

    startDurationTimer();
  });

  socket.on('call_rejected', () => {
    if (currentCallState.status === 'calling_out' || currentCallState.status === 'in_call') {
      hangUpCall();
    }
  });

  socket.on('meeting_ended', (data: { roomId: string; summary?: string; actionItems?: any[] }) => {
    if (currentCallState.status === 'in_call' && currentCallState.roomId === data.roomId) {
      hangUpCall();
    }
    // The enriched meeting_ended (post-AI) carries summary + action items and also
    // arrives after the call already ended — refresh any open Action Items list so the
    // newly-extracted items show up live. (Push notifications still alert the user.)
    if (data?.actionItems || data?.summary) {
      import('./taskListeners').then(m => m.emitTasksChanged()).catch(() => undefined);
    }
  });

  // Server emits 'call_ended' from either reject, explicit hangup, or timeout.
  // Reaches both sides regardless of join state — this is the authoritative end signal.
  socket.on('call_ended', (data: { roomId?: string; byUserId?: string }) => {
    const status = currentCallState.status;
    if (status === 'idle') return;
    // Match by room when present; otherwise fall back to "any active call".
    if (!data?.roomId || data.roomId === currentCallState.roomId) {
      hangUpCall();
    }
  });

  // Someone is knocking to join a live room we host / are in. Prompt to admit.
  socket.on('room_knock', (data: { roomId: string; requesterId: string; requesterName?: string; type?: 'voice' | 'video' }) => {
    const name = data.requesterName || 'A colleague';
    Alert.alert(
      'Join request',
      `${name} wants to join this room.`,
      [
        {
          text: 'Deny',
          style: 'cancel',
          onPress: () => socket.emit('room_knock_response', { roomId: data.roomId, requesterId: data.requesterId, accepted: false, type: data.type }),
        },
        {
          text: 'Admit',
          onPress: () => socket.emit('room_knock_response', { roomId: data.roomId, requesterId: data.requesterId, accepted: true, type: data.type }),
        },
      ],
    );
  });

  // Our knock was answered. On accept, enter the room; on deny, tell the user.
  socket.on('room_knock_response', (data: { roomId: string; accepted: boolean; type?: 'voice' | 'video' }) => {
    const type = pendingKnockType[data.roomId] || data.type || 'video';
    delete pendingKnockType[data.roomId];
    if (data.accepted) {
      joinRoomByLink({ roomId: data.roomId, type });
    } else {
      Alert.alert('Request declined', 'The host declined your request to join.');
    }
  });
};

/**
 * Remove every call listener this module registered. Call on root-layout
 * unmount (logout / app teardown) — previously listeners were only cleared on
 * RE-setup, so a dead layout kept reacting to call events.
 */
export const teardownCallSocketListeners = (socket: any) => {
  if (!socket) return;
  socket.off('incoming_call');
  socket.off('call_accepted');
  socket.off('call_rejected');
  socket.off('call_ended');
  socket.off('meeting_ended');
  socket.off('room_knock');
  socket.off('room_knock_response');
  stopRingtone();
};
