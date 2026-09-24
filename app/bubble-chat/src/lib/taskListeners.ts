// Lightweight pub/sub so action-item screens (e.g. the Calendar/Action Items list)
// can live-refresh when the backend reports task changes — the app doesn't use
// react-query, so this mirrors the subscribeCallState/subscribePresence pattern.
//
// Realtime sources that should refresh the Action Items list:
//  - `task_followup`       — a still-pending action item was nudged (F3 follow-up loop)
//  - `action_item_updated` — a meeting action item's status/assignee changed elsewhere
//  - `meeting_ended` (enriched) — a finished meeting just created new action items
//    (emitted from callManager's handler so we don't double-bind the same event)

type Listener = () => void;
const listeners = new Set<Listener>();

export const subscribeTasksChanged = (cb: Listener): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export const emitTasksChanged = (): void => {
  listeners.forEach((l) => {
    try { l(); } catch { /* ignore listener errors */ }
  });
};

export const setupTaskListeners = (socket: any): void => {
  if (!socket) return;
  socket.off('task_followup');
  socket.off('action_item_updated');

  socket.on('task_followup', () => emitTasksChanged());
  socket.on('action_item_updated', () => emitTasksChanged());
};
