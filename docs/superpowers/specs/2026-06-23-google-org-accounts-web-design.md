# Organization accounts for Google sign-in (web)

**Date:** 2026-06-23
**Scope:** BUBBLESPACE web frontend + Backend. Mobile is out of scope.

## Problem

On the web, a user can sign up as an **Individual** or an **Organization** via the
tabbed signup page. The organization path sets `role: 'admin'` +
`signupKind: 'organization'`, which is what unlocks the org onboarding steps and
org creation (`ensureOrganizationForFounder`).

Google sign-in users never get this choice. Both the web passport strategy
(`Backend/middleware/passport.ts`) and the mobile native handler
(`googleMobileLogin`) hardcode `role: 'employee'`, so a Google user always lands
in onboarding as an individual with no way to create an organization.

## Goal

Let users who sign in with Google **on the website** create an organization,
matching the capability the email signup flow already has.

## Decisions

- **Placement:** a new first step ("Choose account type") inside the existing
  `SetupProfileView` onboarding wizard. Picking *Organization* promotes the user
  to org-founder, after which the existing Personal → Business → Brain steps run
  unchanged.
- **Eligibility:** social (Google) accounts only. Email signups already chose
  their type on the signup page and must not see the chooser.
- **Edge case (returning, already-onboarded individual Google user):** does NOT
  see the chooser — it is pre-onboarding only. Such a user converts to/joins an
  org through normal in-app org features later. (Default kept simple per scope.)

## Design

### 1. Backend — expose a social-account flag
Add `isSocialAccount: !!u.googleId` to the user payload returned to the web:
- `Backend/controllers/profileController.ts` `formatUser` (used by `getMyProfile`,
  which feeds the setup-profile route).
- `Backend/controllers/authController.ts` `formatUser` (used by Google callback)
  for parity.

`googleId` is loaded by default (not `select: false`), so no query changes are
needed. We intentionally key on `googleId` rather than absence of a password,
since password is `select: false`.

### 2. Backend — `POST /api/v1/auth/account-type` (requireAuth)
- Body: `{ accountType: 'individual' | 'organization' }`.
- Guard (409) if the user has already completed onboarding, already belongs to an
  organization, or is already `admin`. This is a one-time, pre-onboarding promotion.
- `organization` → set `signupKind: 'organization'`, `role: 'admin'`. Leave
  `onboardingStep` at `awaiting_profile`. No Organization document is created here;
  that still happens during `setupProfile` via `ensureOrganizationForFounder`,
  exactly like the email flow.
- `individual` → set `signupKind: 'individual'`, `role: 'employee'` (idempotent).
- Returns the updated `formatUser` payload so the client can refresh local state.
- Registered in `Backend/routes/authRoutes.ts`.

### 3. Frontend — `SetupProfileView` step 0 chooser
- Render a `chooseType` step **before** step 1, only when:
  `user.isSocialAccount && !user.onboardingComplete && user.role !== 'admin' && !user.organization`.
- Two cards (Individual / Organization) using the wizard's existing visual
  language (purple panel, rounded cards, motion).
- **Organization selected:** call `setAccountType('organization')`, merge the
  returned user into local state, then advance into step 1. Because the user is
  now `role: admin`, `isAdmin` recomputes and the Business/Brain steps appear.
- **Individual selected:** advance locally into step 1 (no network call needed;
  the user is already an employee/individual). Step 1 completion finalizes as a
  normal individual.
- Resume behaviour preserved: once a type is committed (role becomes admin, or
  onboarding advances), the chooser no longer matches its gate.

### 4. API client
- Add `setAccountType(accountType)` to `BUBBLESPACE/frontend/src/lib/api.ts`.

## Out of scope / follow-up

- **Mobile Expo Google redirect bug:** the WebBrowser fallback OAuth flow
  (`startGoogleAuth` in `app/bubble-chat/src/lib/api.ts`) reportedly returns to
  the main website instead of deep-linking back into the app after auth. The
  `mobile_<redirectUri>` state round-trip exists in `googleCallback`, so this is a
  separate deep-link/redirect investigation tracked as a follow-up, not part of
  this web feature.
- Mobile org-creation-on-Google parity.

## Testing

- Backend: account-type endpoint sets fields correctly; rejects when onboarded /
  already in org / already admin; individual is idempotent.
- `formatUser` includes `isSocialAccount`.
- Frontend: chooser shows only for social, not-yet-onboarded users; Organization
  selection unlocks the 3-step wizard; Individual proceeds to single-step.
