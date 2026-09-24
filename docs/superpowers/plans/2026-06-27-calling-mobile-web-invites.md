# Calling: mobile, web responsiveness, invites + Google-login fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make calling work on mobile, make the web call UI responsive, let users add people to a call (contacts / meeting / signed link), and fix the post-Google-login non-responsive dashboard.

**Architecture:** Reuse the existing LiveKit `roomId` + Socket.io ring model. Invites ring additional users into an *existing* room (Approach A); a signed JWT join link lets authenticated users join a room from a URL/deep-link. Web responsiveness and the Google-login fix are layout/state-only.

**Tech Stack:** Backend (Express + Socket.io + livekit-server-sdk + JWT), Web (Vite/React + TanStack Router + Tailwind), Mobile (Expo Router + NativeWind + @livekit/react-native). Spec: `docs/superpowers/specs/2026-06-27-calling-mobile-web-invites-design.md`.

## Global Constraints

- TWO frontends share one backend: web `BUBBLESPACE/frontend`, mobile `app/bubble-chat`, shared `Backend`. Confirm which before editing.
- Mobile LiveKit media only works on a **dev build**, never Expo Go. Don't validate calling in Expo Go.
- Keep existing 1:1 call behavior intact; invites are **additive**.
- Mobile breakpoint = `max-width: 767px` (web). Match existing Tailwind/`md:` conventions.
- Signed join links: authenticated users only for v1. Guest join is out of scope.
- TypeScript must stay clean (`npx tsc --noEmit` for web/backend; 0 Expo type errors).

---

## Phase 1 — Google-login responsive fix (web) `quick win`

### Task 1: Reproduce + root-cause the non-responsive-until-refresh bug

**Files:**
- Inspect: `BUBBLESPACE/frontend/src/components/chat/dashboard.tsx:62-125`, `src/routes/auth/google-callback.tsx`, `src/hooks/use-mobile.ts`, `src/components/ui/use-mobile.tsx`

- [ ] **Step 1:** Run web dev server, throttle to a mobile viewport (375px), complete Google sign-in, observe the dashboard renders desktop layout until refresh. Note initial value of `isMobile` (`useState(false)` at `dashboard.tsx:63`).
- [ ] **Step 2:** Confirm hypothesis: first committed render uses `isMobile=false`; the `matchMedia` effect updates state but the user-visible layout was already desktop and isn't re-derived on the post-OAuth client navigation. Write findings as a one-line comment in the commit message.

### Task 2: Lazy-initialize the mobile flag so first paint is correct

**Files:**
- Modify: `BUBBLESPACE/frontend/src/hooks/use-mobile.ts`
- Modify: `BUBBLESPACE/frontend/src/components/ui/use-mobile.tsx`
- Modify: `BUBBLESPACE/frontend/src/components/chat/dashboard.tsx:63,119-125`

**Interfaces:**
- Produces: `useIsMobile(): boolean` — correct on first render (no `undefined`/`false` flash).

- [ ] **Step 1:** In both `use-mobile` hooks, replace `useState<boolean | undefined>(undefined)` with a lazy initializer:

```ts
const getMatch = () =>
  typeof window !== 'undefined' &&
  window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches
const [isMobile, setIsMobile] = React.useState<boolean>(getMatch)
```
Keep the existing `matchMedia` `change` listener; also add `window.addEventListener('resize', onChange)` with matching cleanup. Return `isMobile` (no `!!undefined`).

- [ ] **Step 2:** In `dashboard.tsx`, replace local `const [isMobile, setIsMobile] = useState(false)` + the `matchMedia` effect (lines 119-125) with `const isMobile = useIsMobile()` (import the canonical hook). Leave `isMobileMenuOpen` state as-is.
- [ ] **Step 3:** `cd BUBBLESPACE/frontend && npx tsc --noEmit` → expect clean.
- [ ] **Step 4:** Re-run the Task 1 repro: mobile layout now correct on first paint after Google login, no refresh.
- [ ] **Step 5:** Commit `fix: derive isMobile on first render so post-Google-login dashboard is responsive immediately`.

---

## Phase 2 — Web call modal responsiveness `quick win`

### Task 3: Make LiveKitMeetingModal usable below 768px

**Files:**
- Modify: `BUBBLESPACE/frontend/src/components/chat/LiveKitMeetingModal.tsx` (container `329-331`, side panel `~899`, video grid `~760-890`, control bar `~1180+`)

**Interfaces:**
- Consumes: `useIsMobile()` from Task 2.

- [ ] **Step 1:** Read the full file to map the call layout (outer container, video area, `w-80` participants/chat panel, control bar) before editing.
- [ ] **Step 2:** Outer container (`329-331`): on mobile drop the `p-5/p-8` and `md:pl-[88px]` offset, force full-screen (`h-full w-full`, square corners). Keep desktop classes behind `md:`.
- [ ] **Step 3:** Video area: below `md` render a single main speaker fills the screen with the self-view as a small absolute PiP tile; multi-column grid only `md:` and up.
- [ ] **Step 4:** Participants/chat panel (`w-80` fixed column): below `md` convert to an overlay/bottom-sheet toggled from the control bar (reuse existing open/close state); `md:` keeps the fixed column.
- [ ] **Step 5:** Control bar: allow `flex-wrap`, ensure ≥44px touch targets, keep all controls reachable on a 375px width.
- [ ] **Step 6:** `npx tsc --noEmit` → clean. Manually verify at 375 / 414 / 768 / desktop: no horizontal scroll, all controls usable, desktop unchanged.
- [ ] **Step 7:** Commit `feat: make web call modal responsive on small viewports`.

---

## Phase 3 — Invites backend (Approach A + signed links) `feature`

### Task 4: `call_invite` socket event — ring users into an existing room

**Files:**
- Modify: `Backend/utils/socket.ts` (near the `call_offer` handler ~224-260)

**Interfaces:**
- Produces socket event `call_invite` — payload `{ toUserId: string; roomId: string; callerName?: string; callerAvatar?: string; type?: 'voice'|'video' }`. Emits `incoming_call` to `toUserId` with the **given** `roomId` (does NOT create a new room). Safe to emit once per invitee for multi-add.

- [ ] **Step 1:** Add a `socket.on('call_invite', ...)` handler mirroring `call_offer` but using the provided `roomId` verbatim and emitting `incoming_call` to `data.toUserId` (reuse the existing incoming_call payload shape + missed-call notification path). Do not mint a roomId.
- [ ] **Step 2:** Build backend (`cd Backend && npx tsc --noEmit`) → clean.
- [ ] **Step 3:** Commit `feat(backend): call_invite socket event to ring users into an existing room`.

### Task 5: Signed join-link endpoint + token guard

**Files:**
- Modify: `Backend/controllers/meetController.ts` (add `createInviteLink`, extend `getLiveKitToken` to accept a join token)
- Modify: `Backend/routes/meetRoutes.ts`

**Interfaces:**
- Produces: `POST /api/v1/meet/invite-link` body `{ roomId: string }` → `{ url: string }` where url = `${FRONTEND_URL}/call/join?room=<roomId>&t=<jwt>`. JWT signed with `JWT_KEY`, payload `{ roomId, scope: 'room-join' }`, ~24h expiry.
- `GET /api/v1/meet/livekit-token?roomId=&joinToken=` — when `joinToken` is present and valid for `roomId`, issue the room token even if the caller wasn't the room creator.

- [ ] **Step 1:** Add `createInviteLink` controller: verify auth, sign JWT, return `{ url }`. Register `router.post('/invite-link', createInviteLink)`.
- [ ] **Step 2:** In `getLiveKitToken`, if `joinToken` provided, `jwt.verify` it against `JWT_KEY` and require `payload.roomId === roomId && payload.scope === 'room-join'`; on success proceed to issue the LiveKit token. Keep existing behavior when absent.
- [ ] **Step 3:** `npx tsc --noEmit` → clean.
- [ ] **Step 4:** Manual: `curl` invite-link with a bearer token returns a url; calling `livekit-token` with that `t` returns a token.
- [ ] **Step 5:** Commit `feat(backend): signed call invite links + join-token-authorized livekit tokens`.

---

## Phase 4 — Invites + calling on the clients `feature`

### Task 6: Web — "Add people" picker + meeting Join + copy-link

**Files:**
- Modify: `BUBBLESPACE/frontend/src/components/chat/LiveKitMeetingModal.tsx` (add an "Add people" panel + "Copy invite link" button in the control bar / side panel)
- Modify: `BUBBLESPACE/frontend/src/lib/api.ts` (add `createCallInviteLink(roomId)`)
- Reference: wherever meetings list a "Join call" affordance

**Interfaces:**
- Consumes: socket `call_invite` (Task 4), `POST /meet/invite-link` (Task 5).

- [ ] **Step 1:** Add `createCallInviteLink(roomId)` to web `api.ts`.
- [ ] **Step 2:** In the modal, add an "Add people" panel listing contacts/org members; on select, `socket.emit('call_invite', { toUserId, roomId, type, callerName, callerAvatar })` for each.
- [ ] **Step 3:** Add "Copy invite link" → calls `createCallInviteLink(roomId)`, copies `url` to clipboard, toasts.
- [ ] **Step 4:** Ensure a meeting's "Join call" opens the modal joined to that meeting's `roomId`.
- [ ] **Step 5:** `npx tsc --noEmit` → clean. Commit `feat(web): add-people picker, meeting join, and copy invite link`.

### Task 7: Web — `/call/join` route

**Files:**
- Create: `BUBBLESPACE/frontend/src/routes/call/join.tsx`

- [ ] **Step 1:** New route reads `?room=&t=`, calls `getLiveKitToken({ roomId, joinToken })`, opens the call modal joined to that room (or redirects to login first, preserving the link).
- [ ] **Step 2:** `npx tsc --noEmit` → clean. Manually open a generated link in a second session → joins the same room.
- [ ] **Step 3:** Commit `feat(web): /call/join route for signed invite links`.

### Task 8: Mobile — verify real LiveKit calling on the dev build

**Files:**
- Inspect/fix: `app/bubble-chat/src/lib/liveKitInit.ts`, `src/components/liveKitCall.tsx`, `src/lib/callManager.ts`, `app.json` (permissions plugin)

- [ ] **Step 1:** Confirm `app.json` declares camera/mic permissions via `@livekit/react-native-expo-plugin` (iOS `NSCameraUsageDescription`/`NSMicrophoneUsageDescription`, Android record/camera).
- [ ] **Step 2:** On the dev build, run a 1:1 call between two devices/simulators: token fetch → connect → `AudioSession` start → audio both ways → video both ways → mic/cam/speaker toggles → hang-up cleanup (mic released, session stopped). Fix gaps found.
- [ ] **Step 3:** Confirm Expo-Go still degrades gracefully (calling disabled, no crash).
- [ ] **Step 4:** Commit `fix(mobile): verified/working LiveKit 1:1 calling on dev build`.

### Task 9: Mobile — add-people picker + deep-link join

**Files:**
- Modify: `app/bubble-chat/src/lib/callManager.ts` (add `inviteToCall(user)`), the call overlay UI in `src/app/_layout.tsx`, `src/lib/api.ts`, deep-link config in `app.json`

**Interfaces:**
- Consumes: socket `call_invite` (Task 4), `POST /meet/invite-link` (Task 5).

- [ ] **Step 1:** Add `inviteToCall(user)` to `callManager`: `socket.emit('call_invite', { toUserId, roomId: currentRoomId, type, callerName, callerAvatar })`.
- [ ] **Step 2:** Add an in-call "Add people" sheet (reuse the contacts source) wired to `inviteToCall`.
- [ ] **Step 3:** Add a "Share link" action (calls invite-link API, uses RN Share).
- [ ] **Step 4:** Register a deep-link scheme/path for `call/join` in `app.json`; handler fetches token (with `joinToken`) and joins the room.
- [ ] **Step 5:** 0 Expo type errors. Commit `feat(mobile): in-call add-people, share link, and deep-link join`.

---

## Self-review notes

- **Spec coverage:** WS1→Phase1 (T1-2); WS2→Phase2 (T3); WS4 backend→Phase3 (T4-5); WS4 clients (contacts/meeting/link)→Phase4 (T6-7,9); WS3 mobile calling→Phase4 (T8). All covered.
- **Type consistency:** `call_invite` payload identical across T4/T6/T9; invite-link returns `{ url }` consumed by `createCallInviteLink` (T6) and mobile (T9); `getLiveKitToken` `joinToken` param used by T7/T9.
- **UI tasks** use manual viewport/device verification rather than unit tests (no UI test harness in these frontends); logic tasks (T2 hook, T4/T5 backend) are verified by tsc + manual curl/repro. This is the honest test strategy for this codebase.
