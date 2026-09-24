# Bubble Chat — Implementation Documentation

Source of truth: the repository at `/Users/mac/bubble-chat` as of commit `83e85a6` plus uncommitted working-tree changes present on 2026-07-02 (a new E2EE key subsystem — see §8). This document was compiled by reading the actual code (file:line citations throughout) and cross-checking against the graphify knowledge graph (`graphify-out/GRAPH_REPORT.md`, 2851 nodes / 5557 edges / 207 communities). Where the code and the specs in `docs/superpowers/` disagree, the code wins and the discrepancy is called out explicitly.

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Backend Architecture](#2-backend-architecture)
3. [Authentication & Identity](#3-authentication--identity)
4. [Real-Time Layer (Socket.io)](#4-real-time-layer-socketio)
5. [Calling Subsystem (LiveKit)](#5-calling-subsystem-livekit)
6. [Brain AI / RAG Subsystem](#6-brain-ai--rag-subsystem)
7. [Web Frontend (BUBBLESPACE)](#7-web-frontend-bubblespace)
8. [E2EE Key Management Subsystem (new, uncommitted)](#8-e2ee-key-management-subsystem-new-uncommitted)
9. [Mobile App (Expo)](#9-mobile-app-expo)
10. [End-to-End Data Flow Walkthroughs](#10-end-to-end-data-flow-walkthroughs)
11. [Configuration, Dependencies & Infrastructure](#11-configuration-dependencies--infrastructure)
12. [Implementation Patterns & Conventions](#12-implementation-patterns--conventions)
13. [Assumptions, Technical Debt & Gaps](#13-assumptions-technical-debt--gaps)

---

## 1. System Overview

Bubble Chat is a three-surface product sharing one backend:

| Surface | Path | Stack |
|---|---|---|
| Backend API | `Backend/` | Node.js, Express, TypeScript, MongoDB (Mongoose), Socket.io, Redis (ioredis) |
| Web app | `BUBBLESPACE/frontend/` | React 19, Vite, TanStack Router + React Query, Tailwind v4, shadcn/ui (Radix) |
| Mobile app | `app/bubble-chat/` | Expo SDK ~56 (bare workflow, has native `android/`/`ios/`), React Native 0.85, expo-router, NativeWind |

It is a team-collaboration product: 1:1 and group chat, voice/video calling (LiveKit), a social feed/community layer, an org "Brain" (RAG knowledge base) with an AI assistant ("Aida", on DeepSeek), calendar/tasks, workspace file storage, invoices/payments, and — as of this writing, uncommitted — client-side E2EE for group chats with a cryptographically-scoped Brain participant.

There is no monorepo tool (no Turborepo/Nx) — the three projects are independent `package.json` trees under one git repo, coordinated only by the shared REST/Socket.io contract.

Graph-derived signal worth noting up front: `cn()` (a shadcn/ui class-merge helper) and two versions of `getAuthHeaders()`/`handleResponse()` are the highest-degree "god nodes" in the graph (`graphify-out/GRAPH_REPORT.md:202-211`) — i.e. structurally, the API-auth-header/response-parsing pattern is the most load-bearing convention that's *duplicated* across web and mobile rather than shared (see §12, §13).

---

## 2. Backend Architecture

### 2.1 Server bootstrap — `Backend/index.ts`

- `assertCriticalEnv()` runs first (`index.ts:6`, defined in `Backend/utils/envCheck.ts:5-67`) — validates `MONGODB_URI`, `JWT_KEY`, `JWT_REFRESH_KEY` (falls back to `JWT_REFRESH_SECRET`) are set; hard-exits in production if missing. A second tier of "FEATURE" vars (`OPENAI_API_KEY`, `PINECONE_API_KEY`, `DEEPSEEK_API_KEY`, `LIVEKIT_API_KEY`/`SECRET`, `FILEBASE_*`) only warns — those features degrade gracefully instead of crashing the process (see §12).
- Express app created (`index.ts:50`), `x-powered-by` disabled.
- **CORS** (`index.ts:59-96`): `PRODUCTION_ORIGINS` is hardcoded to `['https://bubblespace.xyz']`; additional origins come from `CORS_ORIGINS` (comma-separated) or default to localhost dev ports. Legacy `FRONTEND_URL` is folded in via regex. Credentials enabled; methods GET/POST/PUT/DELETE/OPTIONS/PATCH.
- **Middleware order**: compression → `trust proxy=1` (Railway) → rate limiters → Helmet → JSON body parser → JSON-parse-error handler → Socket.io request attachment.
- **Rate limiting** (`index.ts:105-130`): general limiter 1000 req/5min on `/api`; a stricter limiter (100 req/15min) on auth/user endpoints.
- **Swagger**: OpenAPI 3.0.0 schema served at `/api-docs` (`index.ts:158-298`).
- **Socket.io** is initialized (`initSocket(server)`, `index.ts:391`) *before* the MongoDB connection resolves — sockets can accept connections while Mongo is still connecting; individual handlers still depend on DB availability.
- **MongoDB**: `mongoose.connect(mongoURI, { family: 4 })` (`index.ts:393-395`), URI from `MONGODB_URI` (falls back to `mongodb://localhost:27017/bubble-chat`). On connect it self-heals by dropping stale `dailydigest` indexes (`index.ts:404-415`), then initializes schedulers/background jobs.
- Server listens on `0.0.0.0:PORT` inside the connect callback (`index.ts:436`); a message-queue worker starts on the listen callback (`index.ts:441-458`).
- **Error handling** (`index.ts:372-383`): Multer errors (file-too-large, unexpected-field) and a generic 500 catch-all; JSON parse errors return 400.

### 2.2 Configuration & environment

Env validation lives in `Backend/utils/envCheck.ts`. Variables used across the codebase, grouped by concern:

| Concern | Variables |
|---|---|
| Database | `MONGODB_URI` (also `MONGO_URI` used in `securityController`) |
| Auth/JWT | `JWT_KEY`, `JWT_REFRESH_KEY` (`JWT_REFRESH_SECRET` fallback) |
| Google OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` |
| AI — transcription | `OPENAI_API_KEY`, `GROQ_API_KEY`, `GROQ_WHISPER_MODEL` |
| AI — chat | `DEEPSEEK_API_KEY` |
| Vector store | `PINECONE_API_KEY`, `PINECONE_INDEX` (default `bubble-org-knowledge`) |
| Calling | `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_URL`, `LIVEKIT_EGRESS_ENABLED` (client bundles also read `VITE_LIVEKIT_*`) |
| Media storage | `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY`, `FILEBASE_BUCKET`, `BYPASS_FILEBASE` |
| Legacy calling (unused/alt) | `ZEGO_APP_ID`, `ZEGO_SERVER_SECRET` |
| Cache | `REDIS_URL` |
| Payments | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Email | `RESEND_API_KEY`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME` |
| Networking | `CORS_ORIGINS`, `FRONTEND_URL`, `SERVER_URL`, `ORIGIN`, `RAILWAY_PUBLIC_DOMAIN`, `API_PUBLIC_URL`, `BASE_URL` |
| Brain E2EE (new, uncommitted) | `BRAIN_PRIVATE_KEY` — see §8 |
| Seeding (dev only) | `SEED_EMAIL`, `SEED_PASSWORD`, `SEED_NAME`, `SEED_KIND`, `SEED_FORCE` |
| Misc | `NODE_ENV`, `PORT`, `ORG_CODE`, `WORKROOM_COUNT` |

There is no `.env.example` checked in and no documented deploy checklist for the new `BRAIN_PRIVATE_KEY` var — see §13.

### 2.3 Database — 31 Mongoose models (`Backend/models/`)

| Model | Purpose |
|---|---|
| `users.ts` | Core user profile: identity, presence, org role, onboarding state machine, digest prefs, E2EE keys, social graph |
| `conversations.ts` | 1:1 and group chats: participants, per-user mute/archive/pin state, org link, transcript policy |
| `messages.ts` | Messages: type (text/image/video/voice/file/location/contact/system), read-by, replies, reactions, edit history, soft-delete per user |
| `meeting.ts` | Calls: roomId, host/attendees, transcript raw+chunks, AI summary, actionItems, LiveKit egress refs |
| `organizations.ts` | Org record: owner, invite code, brainSeeded flag, Pinecone namespace |
| `task.ts` | Tasks/calendar items: owner, assignee, status, priority, type, source (manual/meeting/aida), recurrence |
| `stories.ts` | 24h disappearing stories with TTL index |
| `post.ts` | Social feed posts |
| `notification.ts` | Notifications by type |
| `security.ts` | E2EE "security code" (verification code, distinct from the new conversation-key system) |
| `feed.ts` | Empty file (no schema defined) |
| `workspaceFile.ts` | Per-user file storage with sharing/access controls |
| `network.ts` | Two schemas: `Network` (community) and `NetworkPost` |
| `calendarEvent.ts` | Org calendar events, brain-enriched, recurrence support |
| `conversationKey.ts` | **New** — E2EE group key distribution (see §8) |
| `dailyDigest.ts` | Per-user AI daily digest |
| `otp.ts` | OTP codes with TTL index |
| `messageRequest.ts` | Cross-org message requests (gating unsolicited DMs) |
| `invoice.ts` | Invoices |
| `transaction.ts` | Payment transactions |
| `callLog.ts` | Call history |
| `pushToken.ts` | Device push tokens |
| `activityLog.ts` | Audit trail (see §5) |
| `template.ts` | Reusable templates |
| `orgDocument.ts` | Brain knowledge base documents |
| `backup.ts` | Serialized client backup blob |
| `userImage.ts` | Small profile-image thumbnails |
| `ingestionJob.ts` | Brain ingestion job tracker |
| `goal.ts` | Savings/fundraising goals |
| `expertiseRadar.ts` | Per-user, per-topic expertise score |
| `recurringPattern.ts` | Detected recurring-event patterns |

### 2.4 Middleware & auth (`Backend/middleware/`)

`passport.ts` (86 lines) defines three Passport strategies:

1. **Local** (email/phone + password) — bcrypt compare against `User.password` (`select: false` field).
2. **Google OAuth** — only registered if `GOOGLE_CLIENT_ID`/`SECRET` are set; delegates user resolution to `findOrCreateGoogleUser()` (dynamically imported from `utils/googleAuth.ts`).
3. **JWT** — extracts from `Authorization: Bearer` or `x-auth-token` header, verifies with `JWT_KEY`, loads the user from Mongo by `payload.id`.

`AuthRequest` is a per-controller `interface AuthRequest extends Request { user?: any }` pattern (not a single shared type) — controllers read `req.user._id` after Passport populates it.

`upload.ts` configures Multer to OS temp storage, 1GB max, blocks executable file extensions.

There is **no dedicated session model** — the JWT + `User.refreshToken` field (checked on refresh) is the entire session mechanism; see §3.4.

### 2.5 Routes → Controllers

22 route modules under `/api/v1/*`, each delegating to one or more of the 28 controller files:

| Route | Base path | Controller(s) |
|---|---|---|
| `authRoutes.ts` | `/auth` | `authController.ts` |
| `chatRoutes.ts` | `/chat` | `chatController.ts`, `keyController.ts` (new, §8) |
| `messageRoutes.ts` | `/message` | `messageController.ts`, `messageRequestController.ts` |
| `userRoutes.ts` | `/user` | `userController.ts` |
| `storiesRoutes.ts` | `/story` | `storiesController.ts` |
| `profileRoutes.ts` | `/profile` | `profileController.ts` |
| `healthRoutes.ts` | `/health` | `healthController.ts` |
| `meetRoutes.ts` | `/meet` | `meetController.ts` |
| `meetingRoutes.ts` | `/meetings` | `meetingController.ts` |
| `communityRoutes.ts` | `/community` | `communityController.ts` |
| `feedRoutes.ts` | `/feed` | `feedController.ts` |
| `paymentRoutes.ts` | `/payment` | `paymentController.ts`, `invoiceController.ts` |
| `securityRoutes.ts` | `/security` | `securityController.ts` |
| `workspaceRoutes.ts` | `/workspace` | `workspaceController.ts` |
| `taskRoutes.ts` | `/tasks` | `taskController.ts` |
| `aidaRoutes.ts` | `/aida` | `aidaController.ts` |
| `notificationRoutes.ts` | `/notifications` | `notificationController.ts` |
| `templateRoutes.ts` | `/templates` | `templateController.ts` |
| `activityRoutes.ts` | `/activity` | `activityLogController.ts` |
| `orgRoutes.ts` | `/org` | `orgController.ts` |
| `brainRoutes.ts` | `/brain` | `brainController.ts`, `continuityController.ts`, `digestController.ts` |
| `calendarRoutes.ts` | `/events` | `calendarController.ts`, `recurringPatternController.ts` |

### 2.6 Response conventions

There is **no shared `handleResponse()` helper on the backend** — each controller calls `res.status(code).json({...})` directly with ad-hoc shapes. (`handleResponse()` as a "god node" in the graph report refers to the *frontend* fetch-wrapper — see §7.4/§9.3 — not a backend utility; this is worth flagging because the graph's naming can mislead without reading the actual code.) Standard status codes: 200/201/400/401/404/409/500. `profileController.ts` has local helpers `formatUser()` (user DTO with cache-aware signed avatar URLs), `duplicateKeyMessage()` (maps Mongo E11000 errors to friendly text), and `invalidateUserCaches()`.

### 2.7 Redis caching (`Backend/utils/redis.ts`)

Two ioredis clients: a fast one (2s command timeout, 3 retries, falls through to MongoDB on failure) for `GET`/`SET`/`DEL`, and a dedicated `blockingRedis` client (no timeout) for `BRPOP`-based queue consumption — kept separate so a blocking pop can never starve normal cache traffic. Cached keys include `user:profile:{id}`, `user:counts:{id}` (120s TTL), `user:avatar:{key}`. Cache is best-effort: every read checks `isReady()` and falls through to Mongo on miss/timeout, so Redis being down degrades performance, not correctness.

### 2.8 Socket.io (`Backend/utils/socket.ts`)

JWT-authenticated in the handshake (`socket.ts:105-135`, same `JWT_KEY` as REST). Tracks presence via an in-memory `onlineSockets: Map<userId, Set<socketId>>` (multi-device aware — a user is "online" while ≥1 socket is connected, broadcast only fires on the first connection). Also runs a 5-minute interval to re-ring group-call invitees who haven't joined (30-min cutoff), and a 45-second empty-room grace period before auto-ending an abandoned meeting (`autoEndMeetingByRoomId()`).

---

## 3. Authentication & Identity

Three parallel authentication paths converge on the same `User` document (matched by email):

### 3.1 Native email/password (`authController.ts`)

- **Register** (`POST /auth/register`, `authController.ts:148-364`): password regex-validated (8+ chars, upper/lower/digit/special), bcrypt-hashed at cost 12, a 5-digit OTP generated via `crypto.randomInt(10000, 100000)` (CSPRNG — recently hardened, see 3.4) with 10-minute expiry. Re-registering an unverified email regenerates the OTP instead of erroring. Optional `org_name` creates an Organization + default group chat + Brain seeding inline; optional `inviteCode` auto-joins an existing org.
- **Verify OTP** (`authController.ts:368-422`): marks the OTP used, sets `isVerified: true`, advances `onboardingStep` to `awaiting_profile`, issues token pair.
- **Login** (`authController.ts:475-566`): unverified users get a fresh OTP instead of a login error; users with no password hash (Google-only accounts) are rejected with a "sign in with Google" message.
- **Forgot/Reset/Change password**: standard OTP-gated reset flow; `resetPassword` clears `refreshToken` (forces re-login everywhere), `changePassword` does not (keeps the current session alive).

### 3.2 Google OAuth (dual-path, `Backend/utils/googleAuth.ts`)

Single shared resolver `findOrCreateGoogleUser()` (`googleAuth.ts:36-106`) used by both paths:

- **Web**: Passport `GoogleStrategy` → `GET /auth/google/callback` → redirects with tokens embedded, routing to web or mobile deep link based on a `state` prefix (`authController.ts:930`).
- **Mobile**: native Google Sign-In produces an `idToken`, verified server-side via `OAuth2Client.verifyIdToken()` at `POST /auth/google/mobile` (`authController.ts:966-1063`).

`findOrCreateGoogleUser()` looks up by `googleId` first, then by normalized email (linking `googleId` onto an existing account), then creates a new user (`isVerified: true` since Google pre-verifies email); it recovers from E11000 race conditions on concurrent first-time sign-in by re-querying and linking rather than erroring.

### 3.3 Clerk (mobile only, `authController.ts:1141-1219`)

`POST /auth/clerk-sync` verifies a Clerk session token (`@clerk/backend`), resolves the Clerk user, and finds-or-creates the same Bubble `User` by email — issuing standard Bubble JWTs. This is a second on-ramp used by `@clerk/clerk-expo` on mobile; it is not used by the web app, which goes through Passport directly.

### 3.4 JWT/session model

- Access token: 7-day expiry, signed with `JWT_KEY`, payload `{ id: userId }`.
- Refresh token: 30-day expiry, signed with `JWT_REFRESH_KEY`/`JWT_REFRESH_SECRET`, **also stored on the User document** — `POST /auth/refresh-token` checks the presented token against the stored one before issuing a new pair, which is what makes "logout everywhere" / reset-password-revokes-sessions possible.
- **No Session model** — the User's `refreshToken` field is the sole persisted session state; JWT `exp` is the only expiry mechanism otherwise.
- Commit `83e85a6` removed hardcoded fallback secrets (previously `'bubble_default_refresh_key'`) — `JWT_KEY`/`JWT_REFRESH_KEY` now throw at token-issuance time if unset, rather than silently signing with a known default. This is a real security fix (previously deployable without env vars, insecurely).

### 3.5 Account types & onboarding state machine

`User.signupKind: 'individual' | 'organization'` and `User.onboardingStep: 'awaiting_otp' | 'awaiting_profile' | 'awaiting_org' | 'complete'` drive a state machine mirrored on the frontend (`BUBBLESPACE/frontend/src/lib/onboarding.ts`): `stageFromUser()` derives the stage, `routeForStage()` maps it to a route, `resumeFromUser()` combines both and persists to `sessionStorage` for instant-resume-on-reload (non-authoritative — the backend is always re-consulted). `POST /auth/account-type` (`authController.ts:796-840`) lets a Google-authenticated user choose individual-vs-organization post-signup (gated so it can only be called once, before onboarding completes and before an org exists) — this endpoint is fully implemented server-side; the spec at `docs/superpowers/specs/2026-06-23-google-org-accounts-web-design.md` describes the same design and matches the shipped code.

### 3.6 Password storage

bcryptjs, cost factor 12, field marked `select: false` so it's excluded from default queries. Google-only users have `password: null`.

### 3.7 Client-side token handling (divergent by platform)

| | Web | Mobile |
|---|---|---|
| Storage | `localStorage` (unencrypted) | `AsyncStorage` (OS-level encryption) + in-memory cache |
| Attach | `getAuthHeaders()` reads `localStorage` synchronously per-request | `getAuthHeaders()` reads an in-memory `tokenCache`, seeded at startup by `initApiFromStorage()` |
| Refresh | `customFetch()` intercepts 401, single in-flight refresh promise dedupes concurrent triggers | Same pattern, plus **preemptive** refresh if the JWT `exp` claim is <30s out, checked at cold start |

Both implement the identical "single in-flight refresh promise" pattern independently rather than sharing a package — this is the duplication behind the two `getAuthHeaders()` god-nodes the graph flagged.

---

## 4. Real-Time Layer (Socket.io)

The Socket.io server (`Backend/utils/socket.ts`) is the backbone for: presence (`user_status_change`), typing indicators, live message delivery (`new_message`, `message_updated`, `message_deleted`, `message_reaction`), group metadata changes (`chat_updated`), and the entire calling signaling protocol (§5). Every socket connects with a personal room keyed by `userId`, plus chat-scoped rooms for message fan-out and meeting-scoped rooms for call signaling.

Both clients (web `BUBBLESPACE/frontend/src/lib/socket.ts`, mobile `app/bubble-chat/src/lib/socket.ts` via `initSocket()`) connect with `{ auth: { token } }`, `transports: ['polling', 'websocket']`, 5 reconnection attempts. On the web, `initApiFromStorage()` (mobile) / equivalent boot logic wires the socket up right after auth token restore, which is the source of the "surprising connection" the graph flagged: `initApiFromStorage() --calls--> initSocket()` (`graphify-out/GRAPH_REPORT.md:222-223`).

---

## 5. Calling Subsystem (LiveKit)

### 5.1 Backend lifecycle (`Backend/controllers/meetingController.ts`)

- `createMeeting()` (lines 165-288) is idempotent per `roomId`: if a `live` Meeting already exists for that room, the caller is added as an attendee and the existing record is returned instead of creating a duplicate. If `LIVEKIT_EGRESS_ENABLED` is set, `startRoomAudioEgress()` begins S3 audio recording immediately.
- `endMeeting()` (lines 739-850) enforces host-only termination for group calls (non-hosts leave instead of ending it for everyone; 1:1 calls end for both sides on either party leaving). The Meeting is flipped to `status: 'ended'` and saved **immediately** so the UI reflects the end without waiting on AI post-processing, which runs asynchronously via `setImmediate(() => runBackgroundMeetingAI(...))`.
- `runBackgroundMeetingAI()` (lines 908-1240) is the post-call pipeline: stop egress → backstop-transcribe via Whisper if live captions were thin (<20 chars) → `extractMeetingIntelligence()` (DeepSeek, map-reduce for long transcripts) → resolve action-item assignee names to user IDs → persist summary/actionItems on the Meeting → auto-create synced Task records per action item → optionally save minutes as an `OrgDocument` → optionally email the transcript to participants (and a short recap to absent org members) → emit a `meeting_ended` Brain event for ingestion → post a "meeting minutes ready" system message into the originating chat → send notifications → write an `activityLog` entry.
- `meeting_ended` is broadcast over Socket.io **twice**: immediately with no AI data (so the UI closes the call promptly), then again once AI processing finishes (so summary/action items appear live without a refresh).

### 5.2 Token & room management

`Backend/utils/livekitService.ts` generates a LiveKit `AccessToken` (roomJoin/canPublish/canSubscribe all true) with the user's avatar embedded in token metadata so it propagates to other participants without a separate profile lookup. `GET /meet/livekit-token` (`meetController.ts:256-286`) optionally verifies a signed `joinToken` (see invite links below) before minting the LiveKit token.

### 5.3 Egress & transcription (`Backend/utils/livekitEgress.ts`)

`startRoomAudioEgress()` records audio-only OGG to S3/Filebase at a deterministic `meetings/{roomName}-{timestamp}.ogg` path via LiveKit's `EgressClient`. `stopRoomAudioEgress()` is best-effort (never throws) and is called as soon as a meeting ends to stop billing. `transcribeMeetingRecording()` downloads the recording to a temp file and runs Whisper — used only as a backstop when the live, client-side Web Speech / mobile transcript came back too short.

### 5.4 Permission model: knock-to-join vs. invite links

- **Direct join**: any authenticated user can request a LiveKit token for any `roomId` they know — there's no room-membership check at the token endpoint itself.
- **Invite links**: `createInviteLink()` (`meetController.ts:237-254`) issues a JWT (`scope: 'room-join'`, 24h expiry, signed with `JWT_KEY`) embedded in a URL (`{FRONTEND_URL}/call/join?room={roomId}&t={joinToken}`); the token endpoint verifies scope+roomId match before minting.
- **Knock-to-join** (Socket.io, `socket.ts:507-573`): a non-participant emits `room_knock`; the server relays it to everyone currently in the room plus an explicit push notification to the host; whoever answers emits `room_knock_response`, and on acceptance the requester is added to `Meeting.attendees` server-side (so they retain transcript access later) before being notified to join.

### 5.5 Activity logging

`ActivityAction` (`Backend/models/activityLog.ts:3-49`) includes 8 call-specific actions: `call_initiated`, `call_invited`, `call_accepted`, `call_rejected`, `call_missed`, `call_ended`, `room_knock`, `room_knock_accepted`/`room_knock_denied` — each logged from `socket.ts` at the moment the corresponding signal is relayed, giving a full audit trail of who tried to join what and when.

### 5.6 Web call UI — `LiveKitMeetingModal.tsx` (1466 lines)

Requests media permissions and immediately releases the probe tracks; fetches a LiveKit token (verifying `joinToken` client-side first if present); creates the Meeting DB record and emits `meeting_started`; runs live speech recognition via the browser's `SpeechRecognition`/`webkitSpeechRecognition` API, pushing finalized chunks to the backend via both HTTP (`addMeetingTranscriptChunk`) and socket; supports a minimizable floating pill (LiveKit room stays mounted so audio/transcript continue while the user browses elsewhere in the app); on end-of-call, hosts get a modal choosing to save transcript to storage, email it, both, or neither.

### 5.7 Mobile call UI — `callManager.ts` + `liveKitCall.tsx`

A local `CallState` union (`idle | calling_out | calling_in | in_call`) drives a global call overlay (`_layout.tsx`) that renders above all navigation. Outgoing/incoming calls play platform ringtones that bypass silent mode (`expo-audio`, `playsInSilentMode: true`). Accepting a call creates the Meeting DB record and starts a duration timer. Active calls persist to `AsyncStorage` (`bubble_active_call`) so a cold-started app can offer to rejoin an in-progress call via a "RejoinBanner" that first confirms the meeting is still live via `fetchActiveMeetings()`. The video screen shows a main stage (screen-share > first remote participant > local) with a horizontally scrolling thumbnail row, floating animated emoji reactions, and mic/camera/speaker/screen-share toggles synced to the LiveKit `localParticipant` via a `LocalDeviceBridge` component.

There is a known 2-file import cycle between `src/lib/api.ts` and `src/lib/callManager.ts` (flagged by the graph, `graphify-out/GRAPH_REPORT.md:226`), resolved at runtime by `api.ts` using a dynamic `import()` for `callManager` rather than a static import — it doesn't crash, but it is a structural smell worth untangling (see §13).

---

## 6. Brain AI / RAG Subsystem

### 6.1 Ingestion pipeline (`Backend/utils/brainIngest.ts`)

`ingestToBrain()` is the single entry point for every content type entering the knowledge base (`BrainSourceKind`: `text`, `url`, `file`, `meeting`, `chat`, `chat_file`, `calendar`, `qa`, `document`). It chunks content (500 chars, 100-char overlap), embeds each chunk, upserts to Pinecone with retry (3 attempts, exponential backoff) and rich metadata (`title`, `chunk`, `department`, `accessLevel`, `organizationId`, `sourceKind`, `sourceRef`, `createdAtTs`), and persists an `OrgDocument` record tracking `embedStatus` (`embedded`/`failed`/`skipped`) so failures are visible and retryable via `reembedFailedDocs()`.

### 6.2 Vector store (`Backend/utils/pinecone.ts`, `embeddings.ts`)

Embeddings are generated **locally**, not via a hosted API: `@xenova/transformers` runs `Xenova/bge-small-en-v1.5` (384-dim, ONNX) in-process — this avoids a hard dependency on Hugging Face's hosted inference credits, at the cost of a ~30MB model download on first use and CPU embedding latency. `queryVectors()` enforces an `organizationId` metadata filter on every search, even when the Pinecone namespace itself should already isolate tenants — a deliberate belt-and-braces multi-tenancy guard (see the isolation test in §Testing).

### 6.3 Aida assistant (`Backend/controllers/aidaController.ts`, 1700+ lines)

LLM provider is **DeepSeek** via the OpenAI-compatible SDK pointed at `https://api.deepseek.com/v1`, model `deepseek-chat`. `retrieveOrgContext()` layers three fallbacks: Pinecone RAG (top-5) → MongoDB `$text` search on `OrgDocument` → tag/department keyword match → always includes at least one "general" baseline doc. `buildAidaSystemPrompt()` assembles user identity, current timestamp, RAG context, a workspace snapshot (recent files, today's/upcoming tasks, contacts), a capabilities list, and inline "action block" syntax (`[ACTION: {...}]`) that Aida can emit and the backend parses out and executes (schedule a task, find a file, open the calendar, schedule a call, create a template, etc. — `aidaController.ts:460-547`). When `DEEPSEEK_API_KEY` is missing, responses degrade to a canned message rather than erroring, and the missing-provider detail is never leaked to the client.

Direct-message conversations with the Aida bot are **never ingested** into the org Brain — this is called out explicitly in the code comments as an E2E-privacy boundary (`brainEventListener.ts:403-404`), and is now backed by the cryptographic guarantee described in §8 rather than just a code-path convention.

### 6.4 Event-driven ingestion (`Backend/utils/brainEventListener.ts`)

A Node `EventEmitter` bus wired once at boot (`initBrainEventListener()`) listens for `group_message_sent`, `meeting_ended`, `calendar_event_created`, `document_uploaded`, `chat_file_shared`, and `qa_resolved`, translating each into an `ingestToBrain()` call with type-appropriate tags/department. `chat_file_shared` type-sniffs the MIME/extension to decide handling: audio/video → Whisper transcription, text-like → raw read, PDF/DOCX → text extraction, images/binaries → explicitly skipped ("avoid poisoning" the knowledge base with non-text content). `qa_resolved` fires when a reply lands on a message flagged with `brainQuestionRef` (the "Knowledge Continuity Engine" expert-routing feature) and awards the answerer expertise points via `updateExpertiseRadar()`.

As of the uncommitted E2EE change, `group_message_sent` first checks `message.is_encrypted` and, if set, calls `decryptForBrain()` (§8) before ingesting — undecryptable messages are silently skipped rather than ingesting ciphertext.

---

## 7. Web Frontend (BUBBLESPACE)

### 7.1 Stack

React 19, Vite 8 (`dev`/`build` scripts), TanStack Router v1 (file-based, `routeTree.gen`), TanStack React Query v5 for server-state caching, Tailwind v4 + shadcn/ui (39 Radix packages), `next-themes` for dark mode, `socket.io-client`, LiveKit React components, React Hook Form + Zod, Motion.js for landing-page animation.

### 7.2 Routing (`src/routes/`)

Public: `/`, `/login`, `/signup`, `/verify-otp`, `/forgot-password`, `/reset-password`, `/auth/google/callback`, `/call/join` (signed-invite landing that auto-joins authenticated users or redirects to login), plus static `/privacy`, `/terms`, `/security`, `/status`. Onboarding: `/setup-profile` (multi-step wizard). Protected, under `/dashboard`: `all`, `chat.$chatId`, `work`, `friends`, `calls`, `archive`, `calendar`, `brain`, `profile`, `edit-profile`, with `/dashboard` itself redirecting to `/dashboard/all`.

### 7.3 Root & providers

`root.tsx` wraps everything in `QueryClientProvider`, flips theme to light on non-dashboard routes via `useTheme()` (marketing pages are always light regardless of user preference), and renders `<Outlet />`. App-level context providers (`AppContext.tsx`) supply `SocketContext`, `ChatContext`, and `NicknameContext`; `DashboardContext.tsx` holds dashboard-local UI state (active chat, panel visibility, background style).

### 7.4 API client (`src/lib/api.ts`, 2060 lines)

`customFetch()` wraps `fetch` with the same single-flight 401-refresh pattern described in §3.7; `handleResponse()` normalizes error bodies (`message`/`error` field) and treats 204 as `null`. Every domain (auth, users, chats, messages, meetings, workspace files, Aida, feed, community, notifications, tasks, invoices) has typed wrapper functions here — this file is the entire web-app's contract with the backend.

### 7.5 Key components

`dashboard.tsx` is the app shell coordinating nav/chat-list/chat-window/group-info and polling unread counts every 10s via React Query; `chat-list.tsx` renders the conversation sidebar with typing indicators and a context menu (pin/mute/archive/block/delete); `chat-window.tsx` is the message thread (send/edit/delete/react/reply/forward, voice-note waveform playback, Aida draft suggestions); `group-info.tsx` is the right-hand member/media/files/calls panel; `create-group-modal.tsx` and `setup-profile-view.tsx` handle group creation and the onboarding wizard respectively; `LiveKitMeetingModal.tsx`/`MeetingStatsModal.tsx` cover calling (§5.6).

### 7.6 Design system

`BUBBLESPACE/frontend/design-system/MASTER.md` is the source of truth: brand primary is a lavender-purple (`oklch(0.62 0.21 290)` light / `oklch(0.75 0.18 295)` dark), accent is a constant warm orange (`#f4663b`), typography is Poppins (body/UI) + Space Grotesk (display), base border-radius `1rem` ("bubble" feel), 150-300ms transitions respecting `prefers-reduced-motion`. Explicit anti-patterns documented: no emoji-as-icons (Lucide only), no new hues/fonts, no hardcoded hex outside the token file.

---

## 8. E2EE Key Management Subsystem (new, uncommitted)

This is a brand-new subsystem present in the working tree but **not yet committed to git** (`git status` shows `Backend/models/conversationKey.ts`, `Backend/scripts/generate-brain-keypair.ts`, `Backend/scripts/migrate-drop-private-keys.ts`, `Backend/utils/brainKeyService.ts` as untracked). It replaces a legacy design where the server generated and stored an RSA **private** key per user (incompatible with real end-to-end encryption) with a client-generated NaCl (Curve25519) keypair model.

### 8.1 Problem being solved

The Brain/Aida assistant needs to read **group** chat content (to ingest it and answer questions about it), but must be cryptographically incapable of reading **1:1 DM** content — that boundary needs to hold even if the server is compromised, not just be enforced by an `if` statement.

### 8.2 Design

- **Brain identity**: a NaCl box keypair whose private half lives only in the `BRAIN_PRIVATE_KEY` env var (never MongoDB) — generated once via `scripts/generate-brain-keypair.ts` and rotated by re-running it and re-wrapping keys client-side. `brainKeyService.ts` exposes `getBrainPublicKey()` for clients and caches the parsed keypair in a module singleton.
- **Per-conversation group key**: for a group chat, the client generates a symmetric `nacl.secretbox` key and wraps it individually to (a) every member's registered `nacl.box` public key, and (b) the Brain's public key — but **only for group chats**. `keyController.ts` enforces server-side that a `'brain'` recipient row is rejected for non-group conversations (`keyController.ts:86-89`), so a 1:1 DM's `ConversationKey` collection simply never has a Brain-readable row — the isolation is structural, not a runtime check that could be bypassed by a bug in one code path.
- **`conversationKey.ts` model**: `{ conversationId, recipientId (user id or literal 'brain'), encryptedKey (opaque nacl.box envelope), epoch, createdBy }`, unique on `(conversationId, recipientId, epoch)`. `epoch` increments on member removal so old messages stay decryptable under their original epoch's key while new messages use a rotated one.
- **`brainKeyService.decryptForBrain(conversationId, content)`**: parses the message's `{ v, alg, nonce, ciphertext, epoch }` envelope, fetches (and caches) the Brain's unwrapped group key for that epoch via `nacl.box.open()`, then opens the message via `nacl.secretbox.open()`. Returns `null` (not a throw) on any failure — callers treat undecryptable content as "skip, don't ingest."
- **Key exchange endpoints** (`keyController.ts`, new): `GET /chat/:chatId/keys` returns the caller's current epoch, their wrapped key, all members' public keys, and (for group chats) the Brain's public key. `POST /chat/:chatId/keys` lets a client upload freshly wrapped keys after a re-key event, with validation (participant-only, epoch must be a positive integer, ≤500 keys per call, ≤2048 bytes per wrapped key, `'brain'` recipient blocked outside group chats) and an idempotent `bulkWrite(..., { upsert: true })` so concurrent clients re-keying the same epoch don't conflict.

### 8.3 Migration (`scripts/migrate-drop-private-keys.ts`)

A one-time cleanup script removing the legacy server-held `User.privateKey` field and any legacy PEM-format `publicKey` values, forcing affected clients to re-register a proper NaCl public key on next login. Explicitly documented in-code as addressing the incompatible old RSA-on-server design.

### 8.4 Integration status — partial

**Wired (present in the tracked diff)**: routes registered in `chatRoutes.ts`; `aidaController.ts` calls `decryptForBrain()` via a `resolveMessageText()` helper when building transcripts for Aida (both live chat and summarization paths); `brainEventListener.ts`'s `group_message_sent` handler decrypts before ingestion.

**Not yet wired (still untracked/orphaned as of this audit)**:
- `Backend/models/conversationKey.ts`, `Backend/utils/brainKeyService.ts`, `Backend/controllers/keyController.ts`, and both new scripts are not committed — the feature cannot ship in this state.
- The `ConversationKey` model is not explicitly imported anywhere near `index.ts`'s model-registration path; if nothing else imports it before first use, Mongoose registration order is one required check (§13).
- No `.env.example`/deploy-doc entry exists yet for `BRAIN_PRIVATE_KEY`.
- No startup assertion (in `envCheck.ts`'s CRITICAL/FEATURE pattern) verifies `BRAIN_PRIVATE_KEY` is set before the Brain-ingestion path is exercised — currently a missing key would surface as a runtime `decryptForBrain` failure rather than a boot-time warning.

See §13 for the concrete pre-production checklist implied by these gaps.

---

## 9. Mobile App (Expo)

### 9.1 Stack

Expo SDK ~56, React Native 0.85, React 19, `expo-router` (file-based, `src/app/`), NativeWind (Tailwind on RN). Has native `android/` and `ios/` project directories — this is a **bare-workflow / dev-client** app (uses `@config-plugins/react-native-webrtc`, `@livekit/react-native`, `@livekit/react-native-webrtc`), not runnable inside plain Expo Go. Also depends on `@clerk/clerk-expo`, `socket.io-client`, `@react-native-async-storage/async-storage`.

### 9.2 Navigation (`src/app/`)

Root `_layout.tsx` hosts the global call overlay, `ClerkProvider`, theme provider, and push-notification setup, above a Stack (auth screens: index/login/signup/profile-setup/verify-otp/forgot-password/reset-password/splash, plus `call/join.tsx` for web-to-mobile deep-link call invites) → Tabs. The `(main)` tab layout shows four visible tabs (`messages`, `people`, `updates`, `profile`) plus hidden (`href: null`) routes reachable by navigation but not shown in the tab bar: `brain`, `calendar`, `calls`, `chat/[id]`. The tab bar polls `fetchActiveMeetings()` every 30s to badge an active-room indicator and hides itself entirely inside an open chat screen.

### 9.3 API/data layer (`src/lib/api.ts`, 2523 lines)

Same customFetch/getAuthHeaders/single-flight-refresh pattern as web (§3.7, §7.4), plus a cold-start preemptive refresh (`initApiFromStorage()`) and lazy dynamic imports of three socket-listener setup functions (`setupCallSocketListeners`, `setupPresenceListeners`, `setupTaskListeners`) to sidestep the `api.ts` ↔ `callManager.ts` import cycle noted in §5.7.

### 9.4 Offline cache (`src/lib/chatCache.ts`, 554 lines)

AsyncStorage-backed (not SQLite — chosen for JSON-serialization simplicity and small data volume) cache of chats, per-chat messages, contacts, and avatars, plus an **offline message queue** (`addToOfflineQueue`/`processOfflineQueue`) keyed by a client-generated `clientId` UUID so retried sends can't double-post. `dedupeChats()` collapses duplicate 1:1 conversation documents (newer `updatedAt` wins). A cloud-backup pair (`performCloudBackup`/`restoreCloudBackup`) uploads/restores the entire `bubble_cached_*` key set as one JSON blob, treating a 404 (no backup yet) as expected rather than an error.

### 9.5 Call manager — see §5.7.

### 9.6 Push notifications (`src/lib/pushNotifications.ts`)

Registers an Expo push token with the backend after permission grant; gracefully no-ops on web/simulator. The one concretely-implemented notification category is the daily-brief ("☀️ Your Morning Brief"), throttled to once per calendar day and triggered when the Calendar screen loads its digest. Incoming-call and chat-message notifications are driven by Socket.io events rather than this module directly.

### 9.7 Theming (`src/lib/theme.tsx`, `design-system/MASTER.md`)

Resolves system color scheme via `Appearance`, persists an explicit user override to AsyncStorage, and syncs NativeWind's `colorScheme` so `dark:` utility classes respond. Palette mirrors the web design system's lavender-purple brand color but is redefined independently as hex (not shared tokens) — light `#6c5ce7` / dark `#8b7cf0`. The mobile `MASTER.md` documents the same anti-patterns as web (no hardcoded hex, Lucide-only icons) plus RN-specific rules: touch targets ≥44px, contrast ≥4.5:1, `prefers-reduced-motion` respected.

---

## 10. End-to-End Data Flow Walkthroughs

**Sending a group chat message that becomes Brain-searchable:**
1. Web/mobile client calls `sendTextMessage()` (REST) or emits over the chat socket room.
2. `messageController` persists the `Message`, updates `Conversation.latestMessage`, broadcasts `new_message` to the chat's socket room and each recipient's personal room.
3. If the conversation is a group chat with `is_encrypted` content, `brainEventListener`'s `group_message_sent` handler fires, calls `decryptForBrain()` (§8.2) to get plaintext, then `ingestToBrain()` chunks/embeds/upserts to Pinecone and records an `OrgDocument`.
4. Aida's RAG search (`retrieveOrgContext()`) can now surface this message content in future answers for org members with appropriate access.

**Starting and ending a video call:**
1. Client emits `call_offer` (1:1) or calls `startGroupCall()` (mobile) → server relays `incoming_call` to target(s), each logged as `call_initiated`/`call_invited` in `ActivityLog`.
2. Callee accepts → `call_answer` relayed, `createMeeting()` called (idempotent by `roomId`), egress recording starts if enabled.
3. Client fetches a LiveKit token (`getLiveKitToken()`), joins the LiveKit room; live transcript chunks stream to the backend as they're finalized.
4. Either side ends the call → `endMeeting()` flips status immediately (fast UI feedback) → `runBackgroundMeetingAI()` runs asynchronously: stop egress, backstop-transcribe if needed, DeepSeek summarization, action-item extraction and Task creation, optional email/storage, Brain ingestion of the transcript, second `meeting_ended` broadcast with the enriched summary.

**Google sign-in, new user, choosing "organization":**
1. Passport `GoogleStrategy` (web) or `/auth/google/mobile` (mobile) resolves a Google identity → `findOrCreateGoogleUser()` creates a new `User` (`isVerified: true`, `onboardingStep` unset).
2. Client lands on `/setup-profile`; `stageFromUser()` resolves stage from the returned user object.
3. User picks "organization" → `POST /auth/account-type` sets `signupKind: 'organization'`, `role: 'admin'`.
4. Org-setup step creates the `Organization`, seeds the Brain (optional doc/URL ingestion), and generates an invite code for teammates.

---

## 11. Configuration, Dependencies & Infrastructure

- **Deployment**: Railway (`BUBBLESPACE/frontend/railway.json`: `pnpm build` → `npx serve -s dist -l $PORT`; `Backend/Dockerfile` builds/runs the API). `index.ts` explicitly sets `trust proxy=1` for Railway's reverse proxy. No CI gate on either pipeline (see `docs/TESTING.md` §1).
- **Third-party services**: MongoDB (primary datastore), Redis (cache + blocking queue), Pinecone (vector search), DeepSeek (chat LLM), OpenAI/Groq Whisper (transcription), LiveKit (calling + egress), Filebase/S3 (media + call-recording storage), Clerk (mobile auth on-ramp), Google OAuth, Stripe (payments), Resend (transactional email).
- **Local embeddings**: `@xenova/transformers` (ONNX, in-process) — the one AI capability that has no external API dependency once the model is cached locally.

---

## 12. Implementation Patterns & Conventions

- **Graceful degradation over hard failure**: missing `DEEPSEEK_API_KEY`, `PINECONE_API_KEY`, or `LIVEKIT_EGRESS_ENABLED` all produce reduced functionality (canned messages, skipped RAG, no recording) rather than errors — consistent with the CRITICAL-vs-FEATURE split in `envCheck.ts`.
- **Idempotent writes**: `createMeeting()` by `roomId`, `postConversationKeys()` by `(conversationId, recipientId, epoch)` upsert — both explicitly designed to tolerate concurrent/duplicate client calls.
- **Async-after-response for expensive work**: `runBackgroundMeetingAI()` is dispatched via `setImmediate` so `endMeeting()` returns fast; results are pushed later via a second socket broadcast rather than the client polling or blocking.
- **Audit trail as a first-class citizen**: `ActivityLog` captures a wide, enumerated set of actions (login, file ops, task ops, all call signaling states) with actor/metadata/IP/user-agent — used for both security review and (via `logActivity` calls threaded through many controllers) product analytics.
- **Cryptographic isolation over policy isolation** (new): the E2EE design (§8) deliberately makes DM privacy a structural property of the data model (`no 'brain' row exists`) rather than an `if (isGroupChat)` check that could be bypassed by a future code path.
- **Single-flight refresh**: both frontends independently implement the same "one in-flight token-refresh promise, everyone else waits on it" pattern to avoid a thundering herd of concurrent 401 refreshes — duplicated code, same design.

---

## 13. Assumptions, Technical Debt & Gaps

This section states explicitly what is inferred/uncertain vs. directly observed, and calls out concrete risk.

- **E2EE subsystem is not production-ready as committed.** The four new files (`conversationKey.ts`, `brainKeyService.ts`, `keyController.ts`, both scripts) are untracked in git. Before this can ship: commit them, add `BRAIN_PRIVATE_KEY` to `envCheck.ts`'s FEATURE list (or CRITICAL, if E2EE is meant to be mandatory) so misconfiguration is caught at boot instead of at first decrypt, add it to a `.env.example`, confirm the `ConversationKey` model is registered with Mongoose before first use, and run `migrate-drop-private-keys.ts` against every environment that has legacy RSA keys.
- **No shared HTTP client package between web and mobile.** `getAuthHeaders()`/`customFetch()`/`handleResponse()` are implemented twice, independently, with nearly identical logic (per the graph's god-node duplication signal). A shared `@bubble/api-client` package would remove an entire class of drift bugs (e.g. one platform's refresh logic diverging from the other's).
- **No backend-side shared response helper.** Every controller hand-rolls `res.status(...).json(...)`; a thin convention (or middleware) would reduce inconsistency in error shapes across 28 controllers.
- **Web token storage in `localStorage`** is XSS-exposed by design (any injected script can read it); mobile's `AsyncStorage` has OS-level encryption. This is a real, if common, security tradeoff worth an explicit decision record rather than an implicit one.
- **`api.ts` ↔ `callManager.ts` import cycle** on mobile is currently worked around with dynamic imports rather than resolved — functional today, but fragile to refactors that reintroduce a static import.
- **Health checks are shallow.** `/health/detailed` verifies MongoDB connectivity only; Redis is hardcoded `"disabled"` in the response regardless of actual state, and Pinecone/LiveKit/DeepSeek connectivity are not checked at all — an operator cannot currently distinguish "Brain is down" from "everything is fine" via the health endpoint.
- **No error-monitoring/observability service** (no Sentry or equivalent, no structured logging) is wired in anywhere in the stack — production issues are currently only visible via user reports or manual Railway log inspection (detailed further in `docs/TESTING.md`).
- **`Backend/models/feed.ts` is an empty file** — either dead code or an unfinished model; not resolved by this audit.
- **`ZEGO_APP_ID`/`ZEGO_SERVER_SECRET`** env vars are referenced but no corresponding calling code was found during this audit — likely a vestigial alternate-provider integration from before the LiveKit migration; worth confirming and removing if genuinely unused.
- **PRODUCTION_ORIGINS is hardcoded** to a single domain in `index.ts` rather than sourced from config — adding a second production domain (e.g. a new marketing site) requires a code change and redeploy, not a config change.
