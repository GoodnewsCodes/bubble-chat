# Bubble Chat — Testing & Validation Documentation

This document describes the **actual** testing approach used on this codebase, and separately provides a structured test-case catalog for validating the system as implemented. It is grounded entirely in what exists in the repository as of 2026-07-02 (commit `83e85a6` + uncommitted E2EE subsystem). Nothing here describes a testing capability the codebase doesn't have — where automation is absent, that is stated plainly rather than implied.

Companion document: [`docs/IMPLEMENTATION.md`](./IMPLEMENTATION.md) — read that first for architecture context; this document assumes it.

## Table of Contents

1. [Testing Methodology (Ground Truth)](#1-testing-methodology-ground-truth)
2. [Engineering Principles & Standards Reflected in the Implementation](#2-engineering-principles--standards-reflected-in-the-implementation)
3. [User Interface Design](#3-user-interface-design)
4. [System Testing](#4-system-testing)
5. [Integration Testing](#5-integration-testing)
6. [UI Testing](#6-ui-testing)
7. [Test Case Catalog](#7-test-case-catalog)

---

## 1. Testing Methodology (Ground Truth)

**There is no automated test suite anywhere in this repository.** This is a direct, verified finding, not an inference:

- `Backend/package.json:10` — `"test": "echo \"Error: no test specified\" && exit 1"`. No `jest`, `vitest`, `mocha`, `supertest`, or `@testing-library/*` in any of the three `package.json` dependency trees (`Backend/`, `BUBBLESPACE/frontend/`, `app/bubble-chat/`).
- `BUBBLESPACE/frontend/package.json` has no `test` script at all — only `dev`, `build`, `lint`, `preview`.
- `app/bubble-chat/package.json` has no `test` script — only `start`, `reset-project`, `android`, `ios`, `web`, `lint`.
- No `.github/workflows/`, `.gitlab-ci.yml`, `.circleci/`, or any CI config exists. `BUBBLESPACE/frontend/railway.json` is deploy configuration (`pnpm build` → `npx serve -s dist`), not a test gate.
- No `.husky/` directory, no `lint-staged` config, no pre-commit hook of any kind. ESLint and `tsc --strict` are available (`Backend/tsconfig.json:7` sets `"strict": true`; the web app's `tsconfig.app.json:30-32` adds `noUnusedLocals`/`noUnusedParameters`) but are **developer-invoked tools, not enforced gates** — nothing blocks a commit or deploy on lint/type errors.
- No error-monitoring or structured-logging service (no Sentry, no Winston/Pino/Bunyan) is integrated anywhere; `grep` for `sentry` across all three projects returns zero hits.

**What validation actually happens** is a set of seven **manual, developer-invoked Node/TypeScript scripts** in `Backend/scripts/` (plus one loose script at `Backend/test_avatar.js`), each written as a standalone program you run by hand against a live (usually local, sometimes production) backend instance. None of them are wired into any automated pipeline; they exist to be read and run by a human during development, typically after a related feature change.

| Script | Run command | What it exercises |
|---|---|---|
| `Backend/scripts/test-endpoints.mjs` | `node test-endpoints.mjs` | Smoke-tests a broad slice of REST endpoints (auth, user, cross-org messaging, chat, Aida, feed/stories) against the **production** URL by default |
| `Backend/scripts/test-services.ts` | `npx ts-node scripts/test-services.ts` | Third-party connectivity: LiveKit `listRooms()`, OpenAI model list, DeepSeek chat completion |
| `Backend/scripts/test-call-transcript.ts` | `BASE_URL=http://localhost:3000 npx ts-node scripts/test-call-transcript.ts` | Full call lifecycle: socket signaling → meeting creation → transcript chunking → grace-window trailing chunk → meeting end → (conditionally) action-item extraction |
| `Backend/scripts/test-isolation.ts` | `npx ts-node scripts/test-isolation.ts` | Cross-org Brain data isolation — creates two orgs, ingests a document with a canary string in Org A, asserts Org B's search cannot see it |
| `Backend/scripts/test-continuity.ts` | `npx ts-node scripts/test-continuity.ts` | Knowledge Continuity Engine: onboarding brief generation, question routing to an expert, closed-loop Q&A resolution, expertise-score increment |
| `Backend/scripts/test-transcoder.ts` | `npx ts-node scripts/test-transcoder.ts` | ffmpeg + Whisper transcription pipeline against a synthetically generated 1-second WAV |
| `Backend/test_avatar.js` | `node test_avatar.js` | Single endpoint check: avatar upload with a fake JPEG `FormData` payload |

Three of these scripts (`test-call-transcript.ts`, `test-isolation.ts`, `test-continuity.ts`) follow a consistent internal convention worth noting because it's the closest thing this codebase has to a test framework: a local `assert(condition, message)` helper that increments a `passCount`/`failCount`, colored ✓/✗ console output, a `finally` block that deletes the fixtures it created (test users/orgs/documents) and closes the Mongo connection, and a non-zero **process exit code on any failure** (so a human — or, in principle, a script — can check `$?`). `test-endpoints.mjs` and `test-services.ts` are looser: they log ✅/❌ per check but do not tally a final pass/fail count or set a meaningful exit code.

**Seed data**: `Backend/scripts/seed-user.ts` creates one unverified test user for manually walking the registration → OTP → onboarding UI flow by hand. It refuses to run against a non-local `MONGODB_URI` unless `SEED_FORCE=1` is set, which is a real safety rail against accidentally seeding production. Defaults (`SEED_EMAIL=founder@bubble.test`, `SEED_PASSWORD=BubbleTest2026!`, `SEED_KIND=organization`) are overridable via env vars.

**Health checks** (`Backend/controllers/healthController.ts`) provide the only always-on runtime verification: `GET /api/v1/health` is an unconditional "healthy" liveness ping; `GET /api/v1/health/detailed` additionally checks `mongoose.connection.readyState === 1` and reports Redis as a hardcoded `"disabled"` string regardless of actual Redis state — i.e. it verifies MongoDB connectivity only. Pinecone, LiveKit, and DeepSeek connectivity are not checked by any endpoint.

**Conclusion**: this is an early-stage-startup testing posture — feature velocity has been prioritized over regression safety. Every scenario in §7 below is written to be runnable by a human today (via the manual scripts where one exists, or via direct UI/API interaction where it doesn't), and is explicit about which category it falls into so that a reader isn't misled into thinking a fully automated suite exists.

---

## 2. Engineering Principles & Standards Reflected in the Implementation

The codebase does not reference an explicit style guide or named methodology (no CONTRIBUTING.md, no documented RFC process). The following principles are inferred from **repeated, consistent patterns** in the code itself, each cited to concrete evidence:

- **Defensive/graceful degradation over hard failure.** `Backend/utils/envCheck.ts` explicitly tiers environment variables into CRITICAL (hard-exit) vs. FEATURE (warn-and-degrade) — e.g. a missing `DEEPSEEK_API_KEY` produces a canned Aida response instead of a 500, a missing `PINECONE_API_KEY` returns empty search results instead of throwing. This is a deliberate, repeated design choice, not an accident (see `docs/IMPLEMENTATION.md` §12).
- **Idempotency at write boundaries.** `createMeeting()` de-dupes by `roomId` (`meetingController.ts:179-195`); `postConversationKeys()` upserts by `(conversationId, recipientId, epoch)`; Google sign-in recovers from E11000 races by re-querying rather than failing the request. These are the kind of races that only get found by thinking through concurrent clients, not by single-user manual testing — evidence of design-time reasoning about production conditions.
- **Security-relevant defaults removed rather than papered over.** Commit `83e85a6` deleted a hardcoded JWT fallback secret (`'bubble_default_refresh_key'`) in favor of a hard throw at startup if the real secret is unset — a fail-closed rather than fail-open choice.
- **Audit-first for sensitive actions.** `ActivityLog` (`Backend/models/activityLog.ts`) enumerates a wide, explicit set of actions (auth, calling signaling, file ops, task ops) and is threaded through controllers consistently enough to function as a security/product audit trail, not just a debug log.
- **Privacy as a structural (not policy) property, where it matters most.** The E2EE design (`docs/IMPLEMENTATION.md` §8) goes out of its way to make DM privacy a property of what rows can exist in the database (`no 'brain' ConversationKey row for a 1:1 chat`) rather than an `if` check — the strongest standard evident anywhere in the codebase, and the clearest signal of where the team has decided correctness matters most.
- **TypeScript `strict` mode is on everywhere it can be** (`Backend/tsconfig.json:7`, web `tsconfig.app.json:30`) — but, per §1, it's not enforced as a gate, so it functions as an editor-time aid rather than a CI safety net today.
- **No consistent shared-code discipline across platforms.** The auth-header/token-refresh logic (§12 of the implementation doc) is duplicated near-verbatim between web and mobile rather than extracted to a shared package — the codebase optimizes for shipping each platform independently over cross-platform consistency.

---

## 3. User Interface Design

Design tokens and conventions are governed by two checked-in `design-system/MASTER.md` files — `BUBBLESPACE/frontend/design-system/MASTER.md` (web) and `app/bubble-chat/design-system/MASTER.md` (mobile) — both of which this audit read directly rather than inferring from screenshots.

- **Layout & navigation**: Web uses a persistent dashboard shell (`dashboard.tsx`) with a left nav sidebar (`nav-sidebar.tsx`: All/Work/Friends/Events & Meets/Archived, plus profile at the bottom) and a two/three-pane layout (chat list → chat window → optional group-info panel) that collapses to a mobile-menu toggle below a breakpoint. Mobile uses a bottom tab bar (`(main)/_layout.tsx`: Messages/People/Updates/Profile visible, Brain/Calendar/Calls/Chat reachable via navigation but hidden from the tab bar) with a floating "+" FAB for new chats, and the tab bar itself hides while inside an open chat thread to maximize message-view space.
- **Responsiveness**: The web app is a single responsive SPA (no separate mobile web build) — Tailwind breakpoints drive the dashboard's mobile-menu collapse. The "true" mobile experience is the separate native Expo app, not a responsive fallback of the web app.
- **Visual identity**: Brand primary is a lavender-purple (`oklch(0.62 0.21 290)` light / `oklch(0.75 0.18 295)` dark on web; `#6c5ce7`/`#8b7cf0` hex on mobile — same hue, independently defined per platform, see gap noted in the implementation doc), constant warm-orange accent (`#f4663b`), Poppins for body/UI text, Space Grotesk for display/headings. Base border-radius is `1rem`, deliberately chosen for a rounded "bubble" feel consistent with the product name.
- **Component consistency**: Web is built entirely on shadcn/ui (Radix primitives) — Dialog, Dropdown, ContextMenu, Accordion, Toast (Sonner), Carousel, Chart, Form (React Hook Form + Zod resolvers) all present as generated shadcn components under `src/components/ui/`, giving consistent focus/keyboard/ARIA behavior for free from Radix. Mobile has no equivalent third-party primitive library — components are hand-built (`ParticipantAvatar`, `RingtonePlayer`, the call overlay's control buttons) against the shared `theme.tsx` color tokens.
- **Dark mode**: Web uses `next-themes` (class-based) with light forced on marketing/landing routes regardless of user OS preference (`root.tsx`) and user-selectable on the dashboard. Mobile resolves `Appearance.getColorScheme()` by default with an explicit user override persisted to `AsyncStorage`, syncing NativeWind's `colorScheme` so `dark:` utility classes respond app-wide.
- **Accessibility considerations found in the code**: the mobile `MASTER.md` explicitly documents a pre-delivery checklist including touch targets ≥44px, contrast ratio ≥4.5:1, and respecting `prefers-reduced-motion` — this is a written standard, not just an aspiration, though this audit did not find automated enforcement (e.g. no axe-core, no contrast-checking lint rule) of any of the three. Both design systems explicitly ban emoji-as-icons in favor of Lucide SVG icons, which is itself partly an accessibility/consistency decision (SVGs can carry proper `aria-label`s; emoji rendering varies by OS and can't be programmatically labeled).
- **Motion**: Both design systems specify 150-300ms transitions and explicit `prefers-reduced-motion` compliance as a written rule, applied in practice via Motion.js on the web landing page and `Animated` APIs for the mobile call reactions/overlay.

**Gap**: there is no visual regression tooling (no Chromatic/Percy/Storybook), no accessibility audit tooling, and no responsive-breakpoint test matrix — UI correctness during development has been verified by hand in a browser/simulator, not by any automated check. See §6 for how UI testing should be approached given this reality.

---

## 4. System Testing

System testing here means: exercising the application end-to-end (real HTTP/socket calls against a running backend, real UI where applicable) to confirm complete user-facing scenarios work, as opposed to testing a function in isolation. Given §1, this is done manually today; the scenarios below describe *what to check* and *what already has a runnable script*, distinguished explicitly.

### 4.1 Major functional scenarios covered

| # | Scenario | Automation status | Reference |
|---|---|---|---|
| 1 | New user registers, verifies OTP, completes profile, lands on dashboard | Manual only (`seed-user.ts` can pre-seed the unverified-user state to skip ahead) | `authController.ts:148-422`, web `routes/signup.tsx`+`verify-otp.tsx` |
| 2 | Google sign-in (web) creates or links a user, routes correctly by onboarding stage | Manual only | `googleAuth.ts`, `routes/google-callback.tsx` |
| 3 | 1:1 call: offer → accept → live transcript → end → AI summary appears | Scripted (`test-call-transcript.ts`), backend-only; UI portion manual | `meetingController.ts`, `LiveKitMeetingModal.tsx`, `liveKitCall.tsx` |
| 4 | Document ingested into Org A's Brain is unsearchable from Org B | Scripted (`test-isolation.ts`) | `brainIngest.ts`, `pinecone.ts:queryVectors` |
| 5 | Third-party service reachability (LiveKit, OpenAI, DeepSeek) | Scripted (`test-services.ts`) | `test-services.ts` |
| 6 | Audio file transcodes and transcribes correctly | Scripted (`test-transcoder.ts`) | `test-transcoder.ts`, Whisper integration |
| 7 | Question escalated to an expert, answered, ingested into Brain, expertise score incremented | Scripted (`test-continuity.ts`) | `continuityController.ts`, `brainEventListener.ts` (`qa_resolved`) |
| 8 | Broad endpoint smoke test across auth/user/chat/aida/feed | Scripted (`test-endpoints.mjs`), production URL by default — **run against staging/local, not prod, unless intentional** | `test-endpoints.mjs` |
| 9 | Avatar upload | Scripted (`test_avatar.js`) | `profileController.ts` |
| 10 | Cross-platform call parity (web ↔ mobile in the same room) | Manual only | `docs/IMPLEMENTATION.md` §5 |
| 11 | E2EE group key exchange and re-key on member removal | **No script exists** — feature is uncommitted (§8 of implementation doc); this is new ground | `keyController.ts`, `conversationKey.ts` |

### 4.2 Pass/fail criteria (general)

- **Pass**: the scripted assertion helpers (`assert()` in the three scripts that have them) report `failCount === 0` and the process exits `0`; for scripts without a tally (`test-endpoints.mjs`, `test-services.ts`, `test_avatar.js`), pass means every logged check shows ✅ and no unhandled exception/stack trace appears in the output.
- **Fail**: any ❌/✗ in script output, any non-zero exit code from a script that sets one, any unhandled promise rejection, or (for manual scenarios) any deviation from the expected result described in the relevant test case in §7.
- **Error handling verification**: because there's no monitoring service, "does the system fail gracefully" must be checked by deliberately triggering the failure (missing env var, invalid input, service outage) and confirming the FEATURE-tier graceful-degradation behavior described in `docs/IMPLEMENTATION.md` §12, rather than by watching a dashboard.

---

## 5. Integration Testing

Integration testing here covers the seams between subsystems: frontend ↔ backend REST, frontend ↔ backend Socket.io, backend ↔ MongoDB, backend ↔ Redis, backend ↔ third-party APIs (Pinecone, DeepSeek, LiveKit, Clerk, Google, Filebase/S3), and — newly — backend ↔ client-side cryptography (E2EE).

### 5.1 What's verified today, and how

- **Backend ↔ third-party APIs**: `test-services.ts` is the only script that directly pings LiveKit, OpenAI, and DeepSeek in isolation, confirming credentials are valid and the SDKs are wired correctly — this is the cheapest, fastest integration check in the repo and should be run first whenever any `*_API_KEY` changes.
- **Backend ↔ MongoDB, full request lifecycle**: `test-call-transcript.ts`, `test-isolation.ts`, and `test-continuity.ts` all create real Mongoose documents, exercise real controller logic against them (not mocks), and clean up in a `finally` block — this is closer to a true integration test than a unit test, since nothing is stubbed.
- **Backend ↔ Socket.io**: `test-call-transcript.ts` connects a real `socket.io-client` and asserts on `call_offer`/`call_answer`/`call_accepted`/`call_ended` round-trips — the only script that touches the real-time layer at all.
- **Frontend ↔ backend REST**: no automated coverage exists; this seam is verified by manually using the web/mobile app against a running backend and observing network requests/responses in devtools.
- **Backend ↔ Redis**: no dedicated test exists. Because the cache layer is designed to fail through to MongoDB on any Redis error (`docs/IMPLEMENTATION.md` §2.7), the practical integration check is: stop Redis, confirm the app still functions (just slower / with cache misses), which is a manual exercise.
- **Backend ↔ Clerk / Google OAuth**: no scripted coverage; verified manually by completing each sign-in flow in a real browser/device against real Clerk/Google test accounts.
- **Backend ↔ Filebase/S3**: no scripted coverage of the upload/egress path beyond what's incidentally exercised by `test-call-transcript.ts` (transcript, not media, in that script) — file/avatar/call-recording upload correctness is currently a manual check.
- **E2EE key exchange (new)**: no scripted or documented integration coverage exists yet. Given this is the newest and most security-sensitive subsystem in the codebase, this is the single highest-priority gap to close before the feature ships — see Test Cases TC-E2EE-01 through TC-E2EE-06 in §7.6, which are written to guide a first script (e.g. `test-e2ee.ts`, following the existing `assert()`/fixture/`finally`-cleanup convention already established by the other three scripted tests).

### 5.2 Data-flow verification points

For each integration scenario, the concrete thing to check (not just "it works") is listed:

| Seam | Verify specifically |
|---|---|
| Client → REST → Mongo → REST response | Response DTO shape matches what the client expects (e.g. `formatUser()` fields); write is actually persisted (re-fetch after write) |
| Client → Socket.io → other client | Event payload shape, delivery to the correct room only (not broadcast to unrelated users), ordering under rapid-fire sends |
| Backend → Pinecone → backend | Metadata filter (`organizationId`) is actually applied — verified by TC-ISO-01/02 in §7 |
| Backend → DeepSeek → backend | Graceful fallback text appears (not a stack trace) when `DEEPSEEK_API_KEY` is unset |
| Client → LiveKit token endpoint → LiveKit room | Token grants match intent (canPublish/canSubscribe), `joinToken` verification actually rejects a tampered/expired link |
| Client (encrypt) → backend (store) → Brain (decrypt) | Brain can decrypt group messages; Brain **cannot** decrypt DM content even if it tries (this must be proven negative, not just assumed) |

---

## 6. UI Testing

There is no automated UI test tooling (no Playwright/Cypress/Detox/RNTL) anywhere in the repo. UI correctness has been, and per this document should continue to be until tooling is added, verified through structured manual passes:

- **Usability**: walk each primary flow (send a message, start a call, create a group, ingest a Brain document, complete onboarding) as a first-time user would, without prior knowledge of where things are.
- **Responsiveness**: on web, resize the browser across the Tailwind breakpoints used by `dashboard.tsx`'s mobile-menu toggle and confirm no layout break; on mobile, test on at least one small-screen device/simulator and one tablet-class device, since the tab bar and call overlay both use fixed pixel dimensions in places (`liveKitCall.tsx`'s `PILL_W/H = 142/184` for the minimized call pill, for example) that could clip on unusual aspect ratios.
- **Navigation**: confirm every route in `docs/IMPLEMENTATION.md` §7.2 (web) and §9.2 (mobile) is reachable from the UI (not just addressable by URL) and that back-navigation/deep-linking (`/call/join`, Google OAuth callback deep link) behaves correctly.
- **Consistency**: since shadcn/ui (web) and the hand-rolled mobile components both draw from a documented token file, a useful check is literally opening both `design-system/MASTER.md` files side-by-side against the running apps and confirming no ad-hoc hex colors, non-Lucide icons, or off-scale border-radii have crept in — this is exactly the check the "Anti-patterns" section of each `MASTER.md` is written to make possible for a human reviewer.
- **Accessibility**: manually verify tab-order and focus rings on web (shadcn/Radix should give this for free — confirm it hasn't been overridden), and manually measure touch targets/contrast on mobile against the ≥44px/≥4.5:1 standard the mobile `MASTER.md` documents, since nothing currently checks this automatically.
- **Visual correctness**: compare rendered screens against the design-system token values (colors, type scale, radius) rather than against mockups, since no Figma/mockup source was found linked in the repo — the `MASTER.md` files are the design source of truth here.

---

## 7. Test Case Catalog

Format per case: **ID · Objective · Prerequisites · Steps · Input · Expected Result · Implementation Under Test · Pass/Fail Criteria.** IDs are grouped by domain. "Automation" notes whether a runnable script already covers this case (§1) or it is manual-only today.

### 7.1 Authentication & Authorization

**TC-AUTH-01 — Register with valid credentials**
- Objective: confirm a new account can be created and enters the OTP-verification stage.
- Prerequisites: email not already registered; backend running with `JWT_KEY` set.
- Steps: `POST /api/v1/auth/register` with a fresh email/password/full_name/phone_number.
- Input: `{ email: "new.user+tc01@test.com", password: "Str0ng!Pass1", full_name: "TC One", phone_number: "+15551110001" }`
- Expected: `201`, body includes `requiresVerification: true`; an `Otp` document is created with 10-minute expiry; user's `isVerified` is `false`.
- Implementation: `authController.ts:148-364`.
- Pass/Fail: pass if status/body match and the Otp record exists in Mongo; fail otherwise.
- Automation: manual (no script covers registration directly).

**TC-AUTH-02 — Register rejects weak password**
- Objective: confirm password policy is enforced.
- Prerequisites: none.
- Steps: `POST /auth/register` with a password missing a special character.
- Input: `password: "weakpass1"`
- Expected: `400` with a validation message; no user or OTP created.
- Implementation: `authController.ts:91-99` (regex check).
- Pass/Fail: pass if `400` returned and no DB record created.
- Automation: manual.

**TC-AUTH-03 — Re-registering an unverified email resends OTP instead of erroring**
- Objective: confirm the "resume" branch works, not a 409 conflict.
- Prerequisites: an unverified user already exists from TC-AUTH-01.
- Steps: `POST /auth/register` again with the same email.
- Input: same email, any valid password.
- Expected: `201`/success response, a **new** OTP replaces the old one (old OTP no longer verifies).
- Implementation: `authController.ts:192-232`.
- Pass/Fail: pass if the old OTP fails verification afterward and a new one succeeds.
- Automation: manual.

**TC-AUTH-04 — OTP verification issues tokens and advances onboarding**
- Objective: confirm the full verify → token → onboarding-stage transition.
- Prerequisites: TC-AUTH-01 completed; OTP value known (test env only).
- Steps: `POST /auth/verify-otp` with the correct code.
- Input: `{ email, otp: "<5-digit code>" }`
- Expected: `200`, response includes `accessToken`, `refreshToken`, and user with `isVerified: true`, `onboardingStep: "awaiting_profile"`.
- Implementation: `authController.ts:368-422`.
- Pass/Fail: pass if all three fields are correct and a subsequent authenticated request with the returned `accessToken` succeeds.

**TC-AUTH-05 — Expired/used OTP is rejected**
- Objective: confirm OTP single-use and expiry enforcement.
- Prerequisites: an OTP that has already been used (replay TC-AUTH-04's code a second time).
- Steps: `POST /auth/verify-otp` with the already-used code.
- Expected: `400`/`401` rejection, no new tokens issued.
- Implementation: `authController.ts:388-394` (`isUsed`/expiry check).
- Pass/Fail: pass if rejected; fail if a second token pair is issued from a reused code.

**TC-AUTH-06 — Login rejects Google-only account with password attempt**
- Objective: confirm accounts created via Google (no password hash) cannot be logged into via the password path.
- Prerequisites: a user created via Google sign-in (TC-AUTH-08) exists.
- Steps: `POST /auth/login` with that account's email and any password.
- Expected: rejection directing the user to sign in with Google, not a generic "invalid credentials"/crash.
- Implementation: `authController.ts:529-534`.
- Pass/Fail: pass if the specific Google-redirect message is returned.

**TC-AUTH-07 — Refresh token rotation and reuse prevention**
- Objective: confirm an old refresh token stops working once rotated.
- Prerequisites: a logged-in user with a valid refresh token (call it R1).
- Steps: (1) `POST /auth/refresh-token` with R1 → expect success and a new pair (A2/R2). (2) Immediately retry `POST /auth/refresh-token` with R1 again.
- Expected: step 1 succeeds; step 2 is rejected because the stored `User.refreshToken` no longer matches R1.
- Implementation: `authController.ts:736-771`, especially the DB-comparison at line 754.
- Pass/Fail: pass if step 2 is rejected.

**TC-AUTH-08 — Google sign-in creates a new user on first login**
- Objective: confirm `findOrCreateGoogleUser()` creates rather than errors for a first-time Google identity.
- Prerequisites: a Google identity/email never seen by the system before.
- Steps: complete the Google OAuth flow (web `/auth/google` or mobile `/auth/google/mobile`).
- Expected: a new `User` document is created with `isVerified: true`, `googleId` set, `password: null`.
- Implementation: `googleAuth.ts:70-82`.
- Pass/Fail: pass if the user record matches and a valid token pair is returned.
- Automation: manual (requires a real/test Google account).

**TC-AUTH-09 — Concurrent first-time Google sign-in does not duplicate users (race recovery)**
- Objective: confirm the E11000 recovery path.
- Prerequisites: ability to fire two near-simultaneous first-time Google sign-in requests for the same email (e.g. two rapid clicks, or a small concurrency script).
- Steps: send two `findOrCreateGoogleUser()`-triggering requests for the same never-before-seen email at effectively the same time.
- Expected: exactly one `User` document exists afterward; neither request 500s.
- Implementation: `googleAuth.ts:84-102`.
- Pass/Fail: pass if `User.countDocuments({ email })` after both requests complete equals 1.
- Automation: manual, ideally scripted (no existing script covers this concurrency case — a gap).

**TC-AUTH-10 — Account-type endpoint is single-use and role-consistent**
- Objective: confirm `POST /auth/account-type` can't be called after onboarding completes or an org already exists.
- Prerequisites: a Google-authenticated user in `awaiting_profile`/pre-org state.
- Steps: (1) call with `accountType: "organization"` → expect `role: "admin"`, `signupKind: "organization"`. (2) Call again with `accountType: "individual"`.
- Expected: step 1 succeeds; step 2 returns `409` because `organizationId` (or `onboardingComplete`/`role === 'admin'`) now gates it.
- Implementation: `authController.ts:796-840`, guard at line 815.
- Pass/Fail: pass if step 2 is rejected with 409.

**TC-AUTH-11 — JWT with tampered signature is rejected**
- Objective: confirm the JWT strategy actually verifies signature, not just shape.
- Prerequisites: a valid access token.
- Steps: modify one character of the token's signature segment; call any authenticated endpoint (e.g. `GET /profile/me`) with it.
- Expected: `401 Unauthorized`.
- Implementation: `middleware/passport.ts:66-81` (JwtStrategy verify).
- Pass/Fail: pass if rejected.

**TC-AUTH-12 — Missing `JWT_KEY` fails closed at token issuance**
- Objective: confirm the post-`83e85a6` behavior — no silent fallback secret.
- Prerequisites: a test environment where `JWT_KEY` can be unset.
- Steps: unset `JWT_KEY`, attempt login.
- Expected: token generation throws / request fails loudly, rather than silently signing with a hardcoded default.
- Implementation: `authController.ts:28-31` (`generateAccessToken`).
- Pass/Fail: pass if the request fails rather than succeeding with a token signed by a known-fallback secret.

### 7.2 Chat & Messaging (CRUD)

**TC-CHAT-01 — Create a 1:1 chat (access-or-create semantics)**
- Objective: confirm calling "access chat" twice with the same two users returns the same conversation, not two.
- Steps: call `accessOrCreateChat(userB)` twice from user A's session.
- Expected: both calls return the same `conversationId`.
- Implementation: `chatController.ts` `accessChat`, `Backend/models/conversations.ts`.
- Pass/Fail: pass if `conversationId` is identical both times.

**TC-CHAT-02 — Create a group chat with initial members**
- Steps: `POST /chat/group` with a name and ≥2 member IDs.
- Expected: `201`, conversation has `isGroupChat: true`, correct `participants` array, creator set as admin.
- Implementation: `chatController.ts` `createGroupChat`.
- Pass/Fail: pass if participants and admin match input.

**TC-CHAT-03 — Send a text message and receive it in real time on the recipient's socket**
- Steps: user A sends a text message via `POST /message`; user B has an active socket connection to the same conversation.
- Expected: user B's client receives a `new_message` event with matching content within a few seconds; message is also fetchable via `GET /message/:chatId` afterward.
- Implementation: `messageController.ts`, `socket.ts` broadcast.
- Pass/Fail: pass if both the real-time event and the persisted fetch match.
- Automation: partially — `test-call-transcript.ts` proves the socket pattern works for call events; no equivalent exists for plain chat messages (gap).

**TC-CHAT-04 — Edit a message updates `edit_history` and broadcasts `message_updated`**
- Steps: send a message, then call the update/edit endpoint with new text.
- Expected: message content changes, original text preserved in `edit_history`, other participants receive `message_updated`.
- Implementation: `messageController.ts` `editMessage`, `models/messages.ts` edit-history field.
- Pass/Fail: pass if history array grows by one entry containing the pre-edit text.

**TC-CHAT-05 — Delete for me vs. delete for everyone**
- Steps: (a) sender deletes "for me" — confirm only sender's view hides it, recipient still sees it. (b) sender deletes "for everyone" — confirm all participants' views hide it.
- Expected: per-user soft-delete flag behaves independently for (a); global tombstone for (b).
- Implementation: `messageController.ts` `deleteMessageForMe`/`deleteMessageForEveryone`.
- Pass/Fail: pass if the two deletion scopes are correctly isolated.

**TC-CHAT-06 — Cross-org message request gating**
- Objective: confirm a user from a different org cannot DM freely without going through a message request.
- Steps: user in Org A attempts to message a user in Org B who hasn't accepted a request.
- Expected: message is blocked/queued as a `MessageRequest` (`pending`) rather than delivered directly; recipient can accept/decline.
- Implementation: `messageRequestController.ts`, `models/messageRequest.ts`.
- Pass/Fail: pass if the first message is held as a request until accepted.

**TC-CHAT-07 — Unread count reflects `readBy` state correctly**
- Objective: confirm the recently-modified unread-count logic (commit `83e85a6`) is correct.
- Steps: send 3 unread messages to user B, then call `getUnreadChatCount` for user B; then mark them read; call again.
- Expected: first call returns 3 (or the correct aggregate), second call returns 0.
- Implementation: `chatController.ts` unread-count query (indexed on `readBy`).
- Pass/Fail: pass if counts match exactly before/after.

### 7.3 Calling (LiveKit)

**TC-CALL-01 — 1:1 call full lifecycle** *(scripted — `test-call-transcript.ts`)*
- Objective: confirm offer → answer → transcript → end works end-to-end.
- Prerequisites: local backend running, `LIVEKIT_*` env vars set (or the script's fallback path exercised).
- Steps: run `BASE_URL=http://localhost:3000 npx ts-node scripts/test-call-transcript.ts`.
- Expected: script reports all assertions passed, exit code `0`.
- Implementation: `meetingController.ts`, `socket.ts` call signaling.
- Pass/Fail: pass if `passCount` equals total assertions and `failCount === 0`.

**TC-CALL-02 — Duplicate `createMeeting()` calls for the same room don't create duplicate Meeting documents**
- Steps: both call participants independently call `createMeeting({ roomId: "R1", ... })` within a short window.
- Expected: only one `Meeting` document with `roomId: "R1"` and `status: "live"` exists; the second caller is added as an attendee of the existing one.
- Implementation: `meetingController.ts:179-195`.
- Pass/Fail: pass if `Meeting.countDocuments({ roomId: "R1", status: "live" })` equals 1.

**TC-CALL-03 — Non-host cannot end a group call for everyone**
- Steps: in a 3+ attendee call, a non-host attendee calls `endMeeting()`.
- Expected: response indicates `left: true`; `Meeting.status` remains `"live"`; other attendees are unaffected.
- Implementation: `meetingController.ts:764-771`.
- Pass/Fail: pass if the meeting is still live and other attendees still see it active.

**TC-CALL-04 — Host ending a call flips status immediately, AI runs asynchronously**
- Steps: host calls `endMeeting()`; measure response time; then poll the Meeting document for `summary`/`actionItems` population.
- Expected: HTTP response returns quickly (not blocked on AI); `status` is `"ended"` immediately; `summary`/`actionItems` populate some seconds later.
- Implementation: `meetingController.ts:774-844` (`setImmediate(runBackgroundMeetingAI)`).
- Pass/Fail: pass if the response returns before AI fields are populated, and they populate shortly after.

**TC-CALL-05 — Knock-to-join: non-participant is admitted only with explicit acceptance**
- Steps: user C (not in the meeting) emits `room_knock` for an active room; a current participant emits `room_knock_response` with `accepted: true`.
- Expected: user C is added to `Meeting.attendees`; user C receives a `room_knock_response` allowing join; if instead `accepted: false`, user C is not added and receives a denial.
- Implementation: `socket.ts:507-573`.
- Pass/Fail: pass if attendee list and notification match the accept/deny branch taken.

**TC-CALL-06 — Invite link with tampered token is rejected**
- Steps: generate a valid invite link via `createInviteLink()`; modify one character of the `t=` (joinToken) query param; attempt `GET /meet/livekit-token` with it.
- Expected: `403`, no LiveKit token issued.
- Implementation: `meetController.ts:265-277`.
- Pass/Fail: pass if rejected with 403.

**TC-CALL-07 — Invite link expires after 24 hours**
- Steps: generate an invite link; wait past (or simulate past, e.g. via a manually crafted expired JWT in a test) its 24h expiry; attempt to use it.
- Expected: rejected as expired.
- Implementation: `meetController.ts:237-254` (24h expiry on `scope: 'room-join'` JWT).
- Pass/Fail: pass if rejected once expired.

**TC-CALL-08 — Egress recording starts and stops correctly**
- Objective: confirm no orphaned (still-billing) recordings after a call ends.
- Prerequisites: `LIVEKIT_EGRESS_ENABLED=true`.
- Steps: start a call, confirm `Meeting.egressId`/`recordingKey` populate; end the call; confirm `stopRoomAudioEgress()` is called (check LiveKit dashboard/API for egress status `ENDING`/`COMPLETE`).
- Implementation: `livekitEgress.ts:46-104`, `meetingController.ts:920-927`.
- Pass/Fail: pass if egress is confirmed stopped shortly after call end.

**TC-CALL-09 — Backstop transcription fires only when live transcript is thin**
- Steps: (a) end a call with a rich live transcript (>20 chars) — confirm Whisper backstop is *not* invoked (no extra latency/log entry). (b) end a call with an empty/near-empty live transcript and egress enabled — confirm Whisper backstop *is* invoked and populates `transcriptRaw`.
- Implementation: `meetingController.ts:930-947`.
- Pass/Fail: pass if backstop only fires in case (b).

**TC-CALL-10 — Action items become synced Calendar Tasks**
- Steps: end a call whose transcript clearly states an assignable action ("Alice will send the deck by Friday"); after AI processing completes, check `Task` collection.
- Expected: a `Task` with `source: "meeting"`, correct `assignedTo` (resolved from "Alice"), linked via `taskRef` on the Meeting's `actionItems`.
- Implementation: `meetingController.ts:955-1046`.
- Pass/Fail: pass if the Task exists with correct fields and linkage.

### 7.4 Brain AI / RAG

**TC-BRAIN-01 — Cross-org search isolation** *(scripted — `test-isolation.ts`)*
- Objective: confirm Org B cannot retrieve Org A's ingested content.
- Steps: run `npx ts-node scripts/test-isolation.ts`.
- Expected: script's canary-string check (`"PHOENIX-SEC-999"`) confirms Org B's search never surfaces Org A's document; exit code `0`.
- Implementation: `pinecone.ts:queryVectors` organizationId filter, `brainIngest.ts`.
- Pass/Fail: pass if the script reports 0 failures.

**TC-BRAIN-02 — Document ingestion creates retrievable vectors**
- Steps: ingest a short text document via `ingestToBrain()`/the `/org/ingest` endpoint; then query with a phrase from that document.
- Expected: the document (or its chunk) appears in Aida's RAG context / `searchBrain()` results with a reasonable similarity score.
- Implementation: `brainIngest.ts:54-149`, `aidaController.ts:152-247`.
- Pass/Fail: pass if the ingested content is retrievable.

**TC-BRAIN-03 — Failed embedding is marked and retryable**
- Steps: simulate a Pinecone failure during ingestion (e.g. temporarily invalid `PINECONE_API_KEY`); confirm the `OrgDocument.embedStatus` is `"failed"`; restore the key and run `reembedFailedDocs()`.
- Expected: after reembedding, `embedStatus` becomes `"embedded"` and the content is searchable.
- Implementation: `brainIngest.ts:117-132, 156-208`.
- Pass/Fail: pass if the document transitions from failed to embedded and becomes searchable.

**TC-BRAIN-04 — Aida degrades gracefully without `DEEPSEEK_API_KEY`**
- Steps: unset `DEEPSEEK_API_KEY`; send a chat message to Aida.
- Expected: a friendly canned response is returned (not a 500, not a leaked provider error).
- Implementation: `aidaController.ts:54-57` (`hasKey()`), meeting summary equivalent at `meetingController.ts:38-48`.
- Pass/Fail: pass if the response is the canned fallback text with a `200`.

**TC-BRAIN-05 — DM content is never ingested into the Brain**
- Steps: exchange messages in a 1:1 DM between two org members; search the Brain afterward for phrases unique to that DM.
- Expected: no results — DM content never appears in Brain search.
- Implementation: `brainEventListener.ts:403-404` (explicit exclusion), reinforced structurally by §7.6's E2EE cases once that subsystem is committed.
- Pass/Fail: pass if DM content is provably absent from Brain search results.

**TC-BRAIN-06 — Image/binary file shares are skipped, not ingested as garbage**
- Steps: share a `.png` in a group chat; check ingestion logs/`IngestionJob` for that file.
- Expected: explicitly skipped (no `OrgDocument` created, no garbled binary-as-text content in the index).
- Implementation: `brainEventListener.ts:295-300`.
- Pass/Fail: pass if no document is created for the image.

**TC-BRAIN-07 — Closed-loop Q&A resolution updates expertise score** *(scripted — `test-continuity.ts`)*
- Steps: run `npx ts-node scripts/test-continuity.ts`.
- Expected: script confirms `onboardingBrief` generation, question routing, `resolveQAExchange()` creates a document, and the answerer's `ExpertiseRadar` score for the relevant topic increases by the expected amount (10 points per `brainEventListener.ts:391`).
- Pass/Fail: pass if the script reports 0 failures.

### 7.5 Workspace Files, Tasks, Calendar (CRUD)

**TC-FILE-01 — Upload and retrieve a workspace file**
- Steps: `POST /workspace/upload` with a file; then `GET` it back via the returned URL/key.
- Expected: file is retrievable, correct `mimeType`/`fileType` recorded.
- Implementation: `workspaceController.ts`, `middleware/upload.ts` (Multer, 1GB cap).
- Pass/Fail: pass if content round-trips correctly.

**TC-FILE-02 — Upload rejects executable file types**
- Steps: attempt to upload a `.exe`/`.sh` file.
- Expected: rejected by Multer's file filter before it reaches storage.
- Implementation: `middleware/upload.ts:24-25`.
- Pass/Fail: pass if rejected.

**TC-FILE-03 — File sharing/access control (block a user from a shared file)**
- Steps: share a file with user B; then call `blockFileUser`/`blockWorkspaceFileUser` for user B; attempt access as user B.
- Expected: access denied after blocking, despite the prior share.
- Implementation: `workspaceController.ts`, `models/workspaceFile.ts` (`blockedUsers`).
- Pass/Fail: pass if access is denied post-block.

**TC-TASK-01 — Create, snooze, and complete a task**
- Steps: create a task; snooze it to a future time; confirm it doesn't surface as due; complete it.
- Expected: status transitions correctly (`todo` → snoozed state → `done`).
- Implementation: `taskController.ts`, `models/task.ts`.
- Pass/Fail: pass if state machine transitions match.

**TC-CAL-01 — Recurring holiday events are seeded without duplication**
- Steps: call `bulkImportHolidays()`/`ensureNigerianHolidays()` twice for the same org/year.
- Expected: second call does not create duplicate holiday events.
- Implementation: `calendarController.ts`.
- Pass/Fail: pass if event count is stable across repeated calls.

### 7.6 E2EE Key Management (new subsystem — currently uncommitted)

These cases have no existing script; they are written to define correctness for a subsystem that isn't fully wired yet (`docs/IMPLEMENTATION.md` §8.4) and should be the template for a new `test-e2ee.ts` following the existing `assert()`/fixture/cleanup convention.

**TC-E2EE-01 — Group key upload and retrieval round-trip**
- Objective: confirm `POST`/`GET /chat/:chatId/keys` work together correctly.
- Prerequisites: a group chat with ≥2 members, each with a registered NaCl public key; `BRAIN_PRIVATE_KEY` configured.
- Steps: (1) client wraps a fresh symmetric key to every member + `'brain'`; `POST /chat/:chatId/keys` with `epoch: 1`. (2) A member calls `GET /chat/:chatId/keys`.
- Expected: `GET` returns `epoch: 1`, that member's correct wrapped key, all members' public keys, and a non-null `brainPublicKey`.
- Implementation: `keyController.ts:19-121`.
- Pass/Fail: pass if the retrieved epoch/key/brainPublicKey exactly match what was uploaded.

**TC-E2EE-02 — `'brain'` recipient key is rejected for a 1:1 DM**
- Objective: prove the structural DM-privacy boundary at the API layer.
- Steps: `POST /chat/:dmChatId/keys` including a `recipientId: 'brain'` entry for a non-group conversation.
- Expected: request rejected (that specific key entry refused), no `ConversationKey` row with `recipientId: 'brain'` created for the DM.
- Implementation: `keyController.ts:86-89`.
- Pass/Fail: pass if no such row exists afterward — this is the single most important test case in this catalog given the stated privacy goal.

**TC-E2EE-03 — Brain can decrypt a group message, given a valid key chain**
- Steps: upload group keys (TC-E2EE-01); post an encrypted group message (`is_encrypted: true` with a valid `nacl.secretbox` envelope); trigger `group_message_sent` ingestion.
- Expected: `decryptForBrain()` returns the correct plaintext; the message is ingested into the Brain (searchable afterward).
- Implementation: `brainKeyService.ts:70-133`, `brainEventListener.ts:84-91`.
- Pass/Fail: pass if plaintext matches and ingestion succeeds.

**TC-E2EE-04 — Brain cannot decrypt a DM even if a message is mistakenly marked encrypted-group-style**
- Objective: negative-path proof — the isolation must hold even under a malformed/adversarial input, not just the happy path.
- Steps: construct a DM message with an encrypted envelope and attempt `decryptForBrain(dmConversationId, content)` directly.
- Expected: returns `null` (no `ConversationKey` row with `recipientId: 'brain'` exists for that conversation to unwrap against).
- Implementation: `brainKeyService.ts:70-101` (returns null when no Brain key row found).
- Pass/Fail: pass if `null` is returned and no plaintext is ever produced.

**TC-E2EE-05 — Epoch rotation on member removal preserves old-message decryptability**
- Steps: (1) upload epoch-1 keys, post an encrypted message tagged epoch 1. (2) Remove a member, upload epoch-2 keys (new wrapped keys, `epoch: 2`). (3) Attempt to decrypt the original epoch-1 message.
- Expected: the epoch-1 message still decrypts correctly using the cached/fetched epoch-1 key, even though current epoch is now 2.
- Implementation: `conversationKey.ts` epoch field + unique index, `brainKeyService.ts` epoch-aware cache key (`${conversationId}:${epoch}`).
- Pass/Fail: pass if the old message decrypts correctly post-rotation.

**TC-E2EE-06 — Malformed/oversized key upload is rejected**
- Steps: (a) `POST /chat/:chatId/keys` with a non-positive `epoch`. (b) with a wrapped key >2048 bytes. (c) with >500 keys in one call.
- Expected: all three rejected with a validation error, no partial write.
- Implementation: `keyController.ts:70-74`.
- Pass/Fail: pass if all three are rejected and no `ConversationKey` rows are created from the attempt.

### 7.7 Navigation, Responsive & Error-Handling (Web + Mobile)

**TC-UI-01 — Unauthenticated user is redirected away from `/dashboard/*`**
- Steps: clear tokens, navigate directly to `/dashboard/all`.
- Expected: redirected to `/login` (or equivalent), not a blank/broken dashboard.
- Implementation: web route guards + `resumeFromUser()`/`stageFromUser()` logic.
- Pass/Fail: pass if redirected correctly.

**TC-UI-02 — Onboarding-incomplete user is routed to `/setup-profile`, not the dashboard**
- Steps: log in as a user with `onboardingStep: "awaiting_profile"`.
- Expected: routed to `/setup-profile`, dashboard is not reachable until onboarding completes.
- Implementation: `onboarding.ts` `routeForStage()`.
- Pass/Fail: pass if routing matches the stage.

**TC-UI-03 — Session-expired banner appears after a failed silent refresh**
- Steps: force refresh-token failure (e.g. revoke it server-side, or corrupt the stored value); trigger any authenticated action.
- Expected: user is logged out and shown a "session expired" indicator (web `login.tsx` checks a `reason=expired` param) rather than a silent failure or infinite spinner.
- Implementation: `api.ts` refresh-failure branch (web and mobile both clear credentials on failure).
- Pass/Fail: pass if the expected message/redirect appears.

**TC-UI-04 — Mobile tab bar hides inside an open chat thread**
- Steps: navigate mobile app into `chat/[id]`.
- Expected: bottom tab bar is hidden, maximizing chat area; navigating back out restores it.
- Implementation: `(main)/_layout.tsx:79-81`.
- Pass/Fail: pass if tab bar visibility toggles correctly.

**TC-UI-05 — Web dashboard collapses to mobile-menu layout below breakpoint**
- Steps: resize browser window across the responsive breakpoint used by `dashboard.tsx`.
- Expected: nav collapses into a mobile-menu toggle; no horizontal scroll/overlap.
- Implementation: `dashboard.tsx` (`isMobileMenuOpen` state + Tailwind breakpoints).
- Pass/Fail: pass if layout adapts cleanly with no visual overlap/clipping.

**TC-UI-06 — Call minimized pill remains draggable and stays within screen bounds**
- Steps: minimize an active call on mobile; drag the pill to each screen edge/corner.
- Expected: pill's pan responder clamps position so it never goes fully off-screen.
- Implementation: `_layout.tsx:112-129` (pan responder clamp).
- Pass/Fail: pass if the pill never becomes undraggable/off-screen.

**TC-UI-07 — Rate limiting returns a clear error, not a silent hang, when exceeded**
- Steps: exceed the strict limiter (100 req/15min) on an auth endpoint from one IP (scripted burst).
- Expected: `429`-class response with a clear message once the limit is hit; client surfaces this rather than retrying silently forever.
- Implementation: `index.ts:115-130` (strictLimiter).
- Pass/Fail: pass if the limiter triggers at the documented threshold and the client handles it visibly.

**TC-UI-08 — Health endpoint reflects a real MongoDB outage**
- Steps: stop MongoDB (test/staging only); call `GET /health/detailed`.
- Expected: `services.database.status` reports the outage and overall status is `"degraded"`, HTTP status `503`.
- Implementation: `healthController.ts:24-46`.
- Pass/Fail: pass if the degraded state is correctly reported (and, as a known gap, confirm Redis/Pinecone are *not* reflected here — expected per `docs/IMPLEMENTATION.md` §13, not a bug to "fix" in this test, just to document).
