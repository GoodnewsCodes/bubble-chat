# Bubble Chat (Mobile) — Design System (MASTER)

> Global source of truth for UI work in `app/bubble-chat` (Expo + React Native + NativeWind). Page/screen deviations go in `design-system/pages/<screen>.md` and override this file.
> **Live tokens** are defined in [`src/lib/theme.tsx`](../src/lib/theme.tsx) (`LIGHT`/`DARK` via `useTheme()`) and Tailwind classes in [`tailwind.config.js`](../tailwind.config.js) / [`src/global.css`](../src/global.css). When this doc and the code disagree, the code wins — update both together.
> ⚠️ Expo SDK 56: read https://docs.expo.dev/versions/v56.0.0/ before writing native code (see `AGENTS.md`).

## Product
Bubble Chat — a friendly mobile **chat + calling** app (LiveKit, WebRTC). Tone: warm, soft, playful-but-clean. Uses glassmorphism via `expo-glass-effect` / `expo-blur`.

## Brand & Color
Shared "bubble" identity with the web app: lavender-purple brand. Light and dark are both first-class — resolved through `useTheme().colors`; screens mix NativeWind `dark:` classes with inline `colors.*` for StyleSheet/lucide `color=` props.

| Role | Light | Dark | `ThemeColors` key |
|------|-------|------|-------------------|
| Brand (purple) | `#6c5ce7` | `#8b7cf0` | `purple` |
| Background | `#f8f7ff` | `#0f1018` | `bg` |
| Card | `#ffffff` | `#1a1b28` | `card` |
| Surface | `#f5f4fb` | `#23243a` | `surface` |
| Text | `#1f2030` | `#f4f5fb` | `text` |
| Text (soft) | `#9a9aab` | `#9a9bb6` | `textSoft` |
| Border | `rgba(0,0,0,0.06)` | `rgba(255,255,255,0.09)` | `border` |
| Border (strong) | `rgba(0,0,0,0.10)` | `rgba(255,255,255,0.16)` | `borderStrong` |
| Purple soft (tint) | `rgba(108,92,231,0.08)` | `rgba(139,124,240,0.14)` | `purpleSoft` |
| Danger | `#ef4444` | `#f87171` | `danger` |

**Always pull colors from `useTheme().colors`** — never hardcode a hex that won't flip in dark mode.

## Typography
- **Body / UI:** Poppins (`@expo-google-fonts/poppins`)
- **Display / headings:** Space Grotesk (`@expo-google-fonts/space-grotesk`)
- Reuse these two; don't add families. Icons: `lucide-react-native`.

## Shape, Surface, Motion
- **Radius:** rounded/"bubble" feel — prefer generous corners on cards, bubbles, sheets, buttons.
- **Glass:** use `expo-glass-effect` / `expo-blur` for overlays, nav bars, call controls — sparingly, as accents over content.
- **Motion:** `react-native-reanimated` worklets; keep transitions smooth and short; respect reduced-motion settings.

## Anti-patterns (avoid)
- Hardcoded hex in components — use `useTheme().colors` so dark mode works.
- Emoji as icons — use `lucide-react-native`.
- New color hues / font families outside the tokens above.
- Heavy blur stacks that hurt performance on low-end devices — glass as an accent, not everywhere.

## Pre-delivery checklist
- [ ] Colors via `useTheme().colors`; verified in light AND dark.
- [ ] Safe-area handled (`react-native-safe-area-context`).
- [ ] Touch targets ≥ 44px; pressed/active feedback present.
- [ ] Text contrast ≥ 4.5:1 in both schemes.
- [ ] Reduced-motion respected; animations smooth on device.
- [ ] Icons from lucide-react-native; no emoji glyphs.
- [ ] Checked against Expo SDK 56 docs before using native APIs.

---
*Generated with the `ui-ux-pro-max` skill as a reference, tailored to this repo's actual tokens. Regenerate fresh recommendations any time with:*
`python3 ~/.claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --stack react-native --domain style`
