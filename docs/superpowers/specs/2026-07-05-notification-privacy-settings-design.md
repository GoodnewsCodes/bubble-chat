# Notification & Privacy Settings — end-to-end wiring

**Date:** 2026-07-05
**Scope:** Make every notification/privacy toggle actually take effect on both clients (Expo + web), add reciprocity for read receipts and online status, and reach web/Expo parity for notification sound + message preview.

## Goal

Every setting under Notifications and Privacy must produce the behavior the user
expects, with no dead toggles and no bugs, on **both** the Expo app and the web
app. Backend enforcement already exists; this work closes client-side gaps and
adds reciprocity.

## Settings covered

| Setting | Field | Behavior |
| --- | --- | --- |
| Pause all push | `notification_settings.muted` | Silences every push, in-app toast, browser notification, and sound. |
| Daily digest | `digestPreferences.enabled` | Off ⇒ no digest push/email. On ⇒ delivered at `notifyTime`. |
| Email notifications | `privacy_settings.email_notifications` | Off ⇒ no emails of any kind (recaps, reminders, digests). |
| Read receipts | `privacy_settings.read_receipts` | Off ⇒ you don't send acks **and** don't see others' seen state (reciprocal). |
| Online status | `privacy_settings.show_online_status` | Off ⇒ you don't broadcast presence **and** don't see others' presence (reciprocal). |
| Notification sounds | `notification_settings.sounds` | Off ⇒ new-message alerts are silent (push + in-app). |
| Message previews | `notification_settings.preview` | Off ⇒ notifications show "New message", never the text. |

## Already working (verify only — no rebuild)

- **Backend push** gating (muted/preview/sounds): `Backend/utils/push.ts`
- **Backend email** opt-out (`email_notifications`): `mailer.ts`, `scheduler.ts`,
  `taskController.ts`, `meetingController.ts`, `messageRequestController.ts`
- **Daily digest** (`digestPreferences.enabled` + `notifyTime`): `scheduler.ts`
- **Outbound** read-receipt suppression: `socket.ts`, `messageController.ts`
- **Outbound** presence suppression: `socket.ts`
- **Expo** foreground new-message handler honors muted/preview/sounds
- **Web** incoming handler honors muted/preview for toast + browser Notification
- All 7 toggles present in Expo `profile.tsx` and web settings

## Changes

### 1. Read-receipt reciprocity (client display gating)
If the current user's `read_receipts` is off, never render others' "seen"
(blue double-tick) state on their own sent messages.
- Expo: `app/bubble-chat/src/app/(main)/chat/[id].tsx` tick render
- Web: chat-window tick render

### 2. Online-status reciprocity (client display gating)
If the current user's `show_online_status` is off, never show anyone's online
dot or "online / last seen" text.
- Expo: gate centrally in `app/bubble-chat/src/lib/presence.ts` (`useIsOnline`)
- Web: gate `onlineUsers` consumers in `contexts/AppContext.tsx`

### 3. Web notification sound (parity)
Add a short sound on incoming messages, honoring `notification_settings.sounds`
and `muted`, only when the message is not for the currently-active chat.
- Web: `contexts/AppContext.tsx` `new_message` handler

### 4. Live verification
Confirm each toggle round-trips (save → refreshed user object) and that ticks /
dots re-render immediately on change, without reload.

## Design decisions

- **Reciprocity is enforced client-side at the display layer**, reading the
  current user's own `privacy_settings`. Presence and read-state already flow
  through central client stores, so this is the least-invasive, consistent,
  live-updating spot. Outbound suppression stays server-side (already present),
  making it airtight in both directions.
- **No schema changes** — every field already exists on the `User` model.
- Daily-digest / email behavior already matches the requested spec; verify only.

## Out of scope

- Server-side per-recipient presence filtering (client gating is sufficient for
  the UX; outbound suppression already prevents opted-out users from appearing).
- New settings or granularity beyond the existing 7 toggles.
