# Bubble-Chat Production Readiness Report

_Last updated: 2026-07-02 — after the Pass-2 production-readiness implementation (Waves 1–5)._

## Verdict: 🟡 CONDITIONAL GO (staging), NO-GO for general availability

The system is materially closer to production than at the start of this pass: the
fake E2EE has been replaced with real cryptography (DMs private, groups
Brain-readable), long-meeting intelligence no longer truncates, action items no
longer duplicate on reprocessing, notification preferences are enforced
end-to-end, and mobile has drafts, a correct Archive tab, full settings, brain
uploads and a leak-free call teardown.

**Go for a staged/beta rollout** behind the E2EE feature flag once the manual E2E
checklist below passes on staging. **Not yet GA** until the blockers clear
(secrets provisioned, migration run, load test executed, broader automated
coverage).

---

## What shipped this pass

### Wave 1 — Backend correctness
- **Long-meeting AI**: `extractMeetingIntelligence` now map-reduces the full
  transcript (chunk → per-chunk extract → merge + union) instead of reading only
  the first 3000 chars. Long meetings keep their late-meeting agenda/action items.
  `Backend/controllers/meetingController.ts`.
- **No duplicate tasks on reprocess**: open meeting tasks are deleted before
  re-creation (`Task.deleteMany({ meetingRef, source:'meeting', status ∉ [done,cancelled] })`).
- **Brain ingestion resilience**: 3-try Pinecone upsert with backoff; failures
  set `OrgDocument.embedStatus='failed'` and a 5-minute scheduler job re-embeds
  them (`brainIngest.reembedFailedDocs`, wired in `scheduler.ts`).
- **Preferences enforced**: `digestPreferences` accepted by `PUT /profile/me`;
  all meeting/digest/reminder emails gate on `privacy_settings.email_notifications`;
  the daily digest runs hourly and honors each user's `digestPreferences.notifyTime`.
- **Seed script guard**: refuses non-local / production DBs unless `SEED_FORCE=1`
  and a `SEED_PASSWORD` is set.

### Wave 2 — Real E2EE (tweetnacl)
- **DMs**: `nacl.box` between participants. The server and Brain hold no key —
  private by cryptography.
- **Groups**: per-conversation `nacl.secretbox` key, wrapped (`nacl.box`) to each
  member **and** to the org Brain, so Aida/Brain group features keep working.
  New `ConversationKey` model + `GET/POST /chat/:id/keys` (`keyController.ts`).
- **Brain key service** (`utils/brainKeyService.ts`): the only server component
  that can read group ciphertext; private key in `BRAIN_PRIVATE_KEY` env, never
  in Mongo. `decryptForBrain` only accepts `nacl.secretbox` → structurally cannot
  read DMs.
- **Server no longer holds user private keys**: RSA generation removed from
  `googleAuth.ts`; `scripts/migrate-drop-private-keys.ts` clears legacy values.
- **Aida** decrypts group messages via the key service and returns an
  "end-to-end encrypted, cannot summarize" response for private DMs.
- Clients (`BUBBLESPACE/frontend/src/lib/e2ee.ts`, `app/bubble-chat/src/lib/e2ee.ts`)
  share identical envelope formats; keys in localStorage (web) / expo-secure-store
  (mobile). Verified interop by the crypto contract tests.

### Wave 3 — Mobile UX
- Per-chat **drafts** persist across navigation and restarts, with a "Draft:"
  preview in the list.
- **Archive tab** now uses the real `archivedBy` flag, decoupled from mute.
- **Sync-failure banner** replaces silent catches on the messages list.
- Full **Notifications & Privacy settings** (digest, email, read receipts, online
  status, sounds, previews) wired to `PUT /profile/me`.
- **Brain upload** on mobile: URL/YouTube import added alongside the existing file
  picker in the Knowledge Base card.
- **Call listener teardown** on root-layout unmount (`teardownCallSocketListeners`).

### Wave 4 — Updates & parity
- Mobile **Updates** shows the AI Morning Brief digest; calendar-consistent color
  system was already in place.
- **"Hosted by {name}"** on live-room cards, web + mobile.
- Dark mode persists locally (survives re-login on device).

### Wave 5 — Tests
- Backend Vitest suite: 8 tests, all passing — E2EE DM/group round-trips, brain
  wrap/unwrap, privacy-boundary shape, action-item map-reduce union/dedup.
  `npm test` in `Backend/`.

---

## Blockers before GA

1. **Provision `BRAIN_PRIVATE_KEY`** per environment (`npx ts-node
   scripts/generate-brain-keypair.ts`) and set `JWT_REFRESH_KEY`. Without the
   brain key, group AI silently degrades (messages still send, but Brain can't
   read them).
2. **Run `scripts/migrate-drop-private-keys.ts`** against each DB to purge
   server-held RSA private keys and legacy PEM public keys.
3. **Load testing** — none has been run. Do a k6 pass on socket fan-out and
   unread updates before GA.
4. **Automated coverage is thin** — crypto + one reducer are tested; the socket
   layer, auth, and REST endpoints still have no integration tests.

## Known limitations / accepted tradeoffs (v1)

- **Attachments are not encrypted** — media stays on the presigned-proxy flow.
  Text messages are E2E-encrypted; file encryption is a v2 item.
- **Web private keys live in localStorage** (XSS-exposed). Mobile uses the device
  keychain. v2: IndexedDB + passphrase-wrapped keys on web.
- **No multi-device key sync / key backup** — a new device generates a fresh
  keypair; prior DM history on other devices isn't readable until re-keyed. v2.
- **Search over encrypted content is client-side only** (server sees ciphertext).
- **No call heartbeat** — dead-host rooms close on the 45s empty-room grace.
- **Pinecone vectors are derived plaintext** for group content (by design — the
  Brain is a group member). Private DMs are never ingested.
- **Mixed plaintext/ciphertext history**: messages sent before the flag stay
  plaintext; rendering keys off each message's `is_encrypted`.

## Manual E2E checklist (run on staging before beta)

1. Two accounts, DM: send a message → confirm both sides read it, and
   `db.messages.find({is_encrypted:true})` shows only envelope JSON (no plaintext).
2. Group chat with 3 members + Brain configured: send messages → Aida group
   summary still works (Brain decrypts); private DM summary returns the
   "encrypted, cannot summarize" response.
3. Meeting >3000 chars of transcript → summary + action items cover the whole
   meeting; reprocess (or scheduler catch-up) does **not** duplicate tasks.
4. Toggle "Email notifications" off → no digest/meeting emails arrive.
5. Set `digestPreferences.notifyTime` → digest arrives in that UTC hour.
6. Mobile: type a draft, background the app, reopen → draft restored; archive a
   chat → shows only under Archive; kill network → sync banner appears.

## How to verify

```bash
# Backend
cd Backend && npx tsc --noEmit && npm test
# Web
cd BUBBLESPACE/frontend && npx tsc --noEmit
# Mobile
cd app/bubble-chat && npx tsc --noEmit
```
All three type-check clean; backend tests pass (8/8) as of this report.
