import { User } from '../models/users';

export interface GoogleProfileInput {
  googleId: string;
  email?: string | null;
  fullName?: string | null;
  avatar?: string | null;
}

const TAG_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const generateUniqueTag = async (): Promise<string> => {
  let tag: string;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    tag = 'bubble-' + Array.from({ length: 8 }, () => TAG_CHARS[Math.floor(Math.random() * TAG_CHARS.length)]).join('');
    if (!(await User.findOne({ uniqueTag: tag }).select('_id'))) return tag;
  }
};

// E2EE keypairs are generated CLIENT-SIDE (tweetnacl) and only the public key is
// uploaded via PUT /profile/me. The server must never hold a user's private key —
// the previous server-generated RSA pair (private key stored in the User doc)
// defeated the purpose of E2EE and has been removed. Legacy `privateKey` values
// are cleaned up by scripts/migrate-drop-private-keys.ts.

/**
 * Resolve (find, link, or create) the Bubble user behind a Google identity.
 *
 * This is the single source of truth shared by the web passport strategy and the
 * native mobile handler. It is hardened against the failure that made Google
 * sign-in work for some users but not others: an unhandled duplicate-key error
 * (E11000) when a row already exists for the same email/googleId. On that race we
 * re-query and link instead of surfacing a generic auth failure.
 */
export const findOrCreateGoogleUser = async (input: GoogleProfileInput) => {
  const googleId = input.googleId;
  const normalizedEmail = input.email ? input.email.toLowerCase().trim() : undefined;

  if (!googleId) {
    throw new Error('Google profile is missing a stable account id (sub).');
  }

  // 1. Existing Google user.
  let user = await User.findOne({ googleId });
  if (user) {
    // console.log(`[googleAuth] Matched existing googleId for user ${user._id}`);
    return user;
  }

  // 2. Existing local/email user → link the Google identity idempotently.
  if (normalizedEmail) {
    user = await User.findOne({ email: normalizedEmail });
    if (user) {
      if (!user.googleId) user.googleId = googleId;
      if (!user.avatar && input.avatar) user.avatar = input.avatar;
      try {
        await user.save();
        // console.log(`[googleAuth] Linked googleId to existing email account ${user._id}`);
      } catch (linkErr: any) {
        // Another concurrent login may have linked it first — re-read and return.
        console.warn(`[googleAuth] Link save failed (${linkErr.code || linkErr.message}); re-reading.`);
        user = await User.findOne({ $or: [{ googleId }, { email: normalizedEmail }] });
        if (user) return user;
      }
      if (user) return user;
    }
  }

  // 3. Brand-new Google user.
  try {
    const uniqueTag = await generateUniqueTag();
    user = await User.create({
      googleId,
      full_name: input.fullName || '',
      email: normalizedEmail,
      avatar: input.avatar || '',
      isVerified: true, // Google has already verified the email.
      uniqueTag,
      role: 'employee',
    });
    // console.log(`[googleAuth] Created new Google user ${user._id}`);
    return user;
  } catch (createErr: any) {
    // E11000: a row for this googleId/email/uniqueTag was created in parallel, or
    // an email row exists we didn't see in step 2. Recover by linking instead of failing.
    if (createErr?.code === 11000) {
      console.warn(`[googleAuth] Duplicate key on create (${JSON.stringify(createErr.keyValue)}); recovering by lookup.`);
      const recovered = await User.findOne({
        $or: [
          { googleId },
          ...(normalizedEmail ? [{ email: normalizedEmail }] : []),
        ],
      });
      if (recovered) {
        if (!recovered.googleId) {
          recovered.googleId = googleId;
          await recovered.save().catch(() => undefined);
        }
        return recovered;
      }
    }
    console.error('[googleAuth] Unrecoverable error resolving Google user:', createErr.message);
    throw createErr;
  }
};
