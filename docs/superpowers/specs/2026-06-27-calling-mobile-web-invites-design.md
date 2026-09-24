# Calling: mobile parity, web responsiveness, invites, + Google-login fix

**Date:** 2026-06-27
**Status:** Approved design — ready for implementation plan
**Scope:** Bubble Chat — web (`BUBBLESPACE/frontend`), Expo mobile (`app/bubble-chat`), shared `Backend`.

## Summary

Four independent workstreams, delivered **quick-wins-first**:

1. Fix: Google sign-in lands on a non-responsive dashboard until manual refresh (web).
2. Make the web call modal responsive on small viewports (web).
3. Make LiveKit calling actually work on mobile (Expo **dev build** — not Expo Go).
4. Invite / add people to a call from **contacts**, a **meeting/calendar event**, and a **shareable link** (backend + both frontends).

Invite architecture decision: **Approach A** (reuse the existing `roomId` + ring model) **plus signed join links**. Links are **authenticated-users-only for v1**; unauthenticated guest join is explicitly deferred.

## Current architecture (as found)

- **Signaling (shared, 1:1 only):** Socket.io events in `Backend/utils/socket.ts` — `call_offer`→`incoming_call`, `call_answer`→`call_accepted`, `call_reject`/`call_end`→`call_ended`. Every event targets a single `toUserId`.
- **Media:** LiveKit. `roomId` is generated client-side; the room token comes from `GET /meet/livekit-token?roomId=`.
- **Mobile:** `app/bubble-chat/src/lib/callManager.ts` (1:1 flow + ringtone + state), `src/components/liveKitCall.tsx` (real LiveKit room/video), rendered via a global overlay in `src/app/_layout.tsx`. Native LiveKit is gated by `src/lib/liveKitInit.ts#isLiveKitAvailable()` → **false in Expo Go**, true in a dev build.
- **Web:** `BUBBLESPACE/frontend/src/components/chat/LiveKitMeetingModal.tsx` (~1,259 lines).
- **Meetings:** `POST /api/v1/meetings` already creates a meeting with `attendees` + `roomId` and (when `LIVEKIT_EGRESS_ENABLED`) starts audio egress.
- **Responsive:** `dashboard.tsx` keeps local `isMobile` state (`useState(false)` + a `matchMedia` effect). Two duplicate `useIsMobile` hooks exist (`hooks/use-mobile.ts`, `components/ui/use-mobile.tsx`), both initializing `undefined`.

## Workstream 1 — Google-login responsive bug (web)

**Symptom:** After Google OAuth, the dashboard renders the desktop layout on a phone; a manual refresh fixes it.

**Root-cause hypothesis (confirm via systematic-debugging before fixing):** `dashboard.tsx:63` initializes `isMobile = false`; the correct value is only applied in a `useEffect`. On the post-OAuth client-navigation to `/dashboard/all` the first committed layout is desktop and isn't reliably re-derived until reload.

**Fix:**
- Lazy-initialize the mobile flag from `window.matchMedia('(max-width: 767px)').matches` so the **first** render is correct (guard for SSR/no-window).
- Add a `resize` fallback alongside the `matchMedia` `change` listener.
- Consolidate `dashboard.tsx` onto the canonical `useIsMobile` hook; apply the lazy-init fix in the shared hook(s) so the whole app benefits. (De-duplicate the two hooks if low-risk; otherwise align both.)

**Verification:** Reproduce on a mobile viewport via Google login; confirm correct layout on first paint with no refresh.

## Workstream 2 — Web call modal responsiveness

**Target:** `LiveKitMeetingModal.tsx`. Layout-only; no call-logic changes.

At `<768px`:
- Full-screen modal: drop `p-5/p-8` padding and the `md:pl-[88px]` rail offset; corners square.
- Video: single-column main speaker with a self-view PiP tile (no multi-column grid).
- Participants/chat side panel (`w-80` fixed today) becomes an overlay / bottom-sheet toggled from the control bar instead of a permanent column.
- Control bar wraps / condenses so all controls stay reachable; ensure touch target sizes.

**Verification:** Exercise at 375px / 414px / 768px widths; all controls usable; no horizontal scroll.

## Workstream 3 — Mobile calling (Expo dev build)

LiveKit is wired but unverified on a real build. This is **verification + targeted fixes**, not a rewrite.

- Confirm camera/mic permissions are declared (`app.json` + `@livekit/react-native-expo-plugin`); iOS `NSCameraUsageDescription` / `NSMicrophoneUsageDescription`, Android records/camera.
- Verify the 1:1 path on the dev build: token fetch → room connect → `AudioSession` start/stop → mic / camera / speaker toggles → remote + local video render → hang-up cleanup (no lingering session/mic).
- Confirm `ensureLiveKitRegistered()` runs before first connect and that Expo-Go fallback still degrades gracefully (calling disabled, no crash).
- Fix whatever the verification surfaces.

**Verification:** Real call between two dev-build devices/simulators: audio both ways, video both ways, toggles, clean hang-up.

## Workstream 4 — Invite / add people (contacts, meeting, link)

**Model — Approach A:** an invite rings additional users into an **existing** `roomId`; their normal incoming-call UI joins that same LiveKit room. LiveKit handles N-way media natively. Signed links are the one added primitive.

### Backend (`Backend`)
- **`call_invite` socket event** (`socket.ts`): like `call_offer` but targets an **existing** room — accepts `{ toUserId, roomId, callerName, callerAvatar, type }`, emits `incoming_call` to each target **without minting a new room**. Fan-out to N users (caller invites several). Reuses the existing `incoming_call`/`call_accepted` accept path.
- **Signed join link:** `POST /api/v1/meet/invite-link` → returns `{ url }` containing `roomId` + a short-lived signed token (JWT, e.g. 24h, scope=room-join). A guard validates the token on join and authorizes `GET /meet/livekit-token` for that room. (Token issuance reuses existing JWT infra.)
- `/meet/livekit-token?roomId=` already issues the room token; extend only if join-link auth requires it.

### Contacts (web + mobile)
- In-call **"Add people"** picker listing contacts / org members → emits `call_invite` for each selected user into the current room. Web: panel in `LiveKitMeetingModal`. Mobile: sheet from the call overlay, reusing the contacts source already used elsewhere.

### Meeting / calendar
- **"Join call"** on a meeting uses that meeting's `roomId`; the meeting's `attendees` are the invite list (ring them via `call_invite`).

### Link
- **Web route `/call/join`** (`?room=&t=`) → validates token, fetches a LiveKit token, opens the modal already joined.
- **Mobile deep link** to the same join params → same join flow.
- **Auth:** logged-in users only for v1. **Deferred:** unauthenticated/external-email guest join (needs guest-token issuance + guest UX) — out of scope, tracked as follow-up.

**Verification:** From an active 1:1 call, add a third user from contacts (they ring in and join); start a call from a meeting (attendees ring); generate a link, open it in a second authenticated session, join the same room.

## Out of scope / deferred

- Unauthenticated guest join via link (external, non-account users).
- Group-call recording/transcription changes (covered by the separate Whisper/egress work).
- Any unrelated refactor of the 1,259-line web modal beyond the responsive pass.

## Risks

- Multi-party introduces edge cases in the 1:1-centric `callManager` state (e.g. "the other user" assumptions). Keep 1:1 behavior intact; treat invites as additive.
- Mobile media only works on a dev build — never validate calling in Expo Go.
- Web modal is large; responsive changes must avoid regressing desktop.
