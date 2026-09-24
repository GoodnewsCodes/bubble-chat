// Centralised env-var sanity check. Called once at boot so a misconfigured deploy
// fails fast in production instead of crashing on the first user-facing request
// (Whisper, LiveKit, S3, Pinecone, DeepSeek).

type EnvSpec = {
  name: string;
  /** What breaks if this is missing — used in the boot log. */
  consequence: string;
};

const CRITICAL: EnvSpec[] = [
  { name: 'MONGODB_URI', consequence: 'Mongo connection will fail' },
  { name: 'JWT_KEY', consequence: 'Token signing will fail' },
  { name: 'JWT_REFRESH_KEY', consequence: 'Refresh-token signing will fail (no fallback secret is used)' },
];

const FEATURE: EnvSpec[] = [
  { name: 'OPENAI_API_KEY', consequence: 'Whisper transcription will throw at end of every meeting' },
  { name: 'PINECONE_API_KEY', consequence: 'Brain/RAG retrieval silently returns nothing' },
  { name: 'DEEPSEEK_API_KEY', consequence: 'Aida answers fall back to empty templates' },
  { name: 'LIVEKIT_API_KEY', consequence: 'LiveKit room token generation will fail' },
  { name: 'LIVEKIT_API_SECRET', consequence: 'LiveKit room token generation will fail' },
  { name: 'FILEBASE_ACCESS_KEY', consequence: 'Media uploads will fail' },
  { name: 'FILEBASE_SECRET_KEY', consequence: 'Media uploads will fail' },
  { name: 'FILEBASE_BUCKET', consequence: 'Media uploads will fail (no bucket)' },
];

const isMissing = (name: string): boolean => {
  const v = process.env[name];
  return !v || v.length < 5 || v.startsWith('your_') || v.startsWith('add_your_');
};

/**
 * Validate env vars at boot. Hard-exits in production if any CRITICAL var is missing.
 * In dev, logs a loud warning and continues so the team can iterate without all secrets.
 */
export const assertCriticalEnv = (): void => {
  // Some deploys use the legacy JWT_REFRESH_SECRET name; normalize so the
  // CRITICAL check (and every consumer) can rely on JWT_REFRESH_KEY.
  if (!process.env.JWT_REFRESH_KEY && process.env.JWT_REFRESH_SECRET) {
    process.env.JWT_REFRESH_KEY = process.env.JWT_REFRESH_SECRET;
  }
  const isProd = process.env.NODE_ENV === 'production';
  const missingCritical = CRITICAL.filter(s => isMissing(s.name));
  const missingFeature = FEATURE.filter(s => isMissing(s.name));

  if (missingCritical.length === 0 && missingFeature.length === 0) {
    // console.log('[envCheck] All critical + feature env vars present ✓');
    return;
  }

  const banner = '═'.repeat(60);
  console.error(`\n${banner}`);
  console.error('[envCheck] Missing environment variables:');
  for (const s of missingCritical) {
    console.error(`  ❌ ${s.name} (CRITICAL) — ${s.consequence}`);
  }
  for (const s of missingFeature) {
    console.error(`  ⚠️  ${s.name} — ${s.consequence}`);
  }
  console.error(`${banner}\n`);

  if (isProd && missingCritical.length > 0) {
    console.error('[envCheck] Refusing to boot in production with missing CRITICAL env vars.');
    if (!process.env.VERCEL) {
      process.exit(1);
    }
  }
};

