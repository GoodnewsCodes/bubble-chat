// @ts-nocheck
import dotenv from 'dotenv';
dotenv.config();

import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as LocalStrategy } from 'passport-local';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import { User } from '../models/users';
import bcrypt from 'bcryptjs';

//import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, JWT_SECRET, SERVER_URL } from "./env.js";

passport.use(new LocalStrategy(
    { usernameField: 'email' },
    async (email, password, done) => {
        try {
            const user = await User.findOne({
                $or: [{ email }, { phone_number: email }]
            }).select('+password');
            if (!user) return done(null, false, { message: 'Incorrect email or password' });
            if (!user.password) return done(null, false, { message: 'Incorrect email or password' });

            const isMatch = await bcrypt.compare(password, user.password as string);
            if (!isMatch) return done(null, false, { message: 'Incorrect email or password' });

            return done(null, user);
        } catch (err) {
            return done(err);
        }
    }
));

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        // Env-driven: set GOOGLE_CALLBACK_URL (or SERVER_URL) to the Bubble Space
        // backend domain in production. No hardcoded host — must match the Authorized
        // redirect URI in Google Cloud Console. Falls back to localhost for dev only.
        callbackURL: process.env.GOOGLE_CALLBACK_URL ||
            `${process.env.SERVER_URL || 'http://localhost:3000'}/api/v1/auth/google/callback`,
        // proxy: true makes passport trust the exact callbackURL you specified,
        // preventing query-string drift like ?flowName=GeneralOAuthFlow
        proxy: true,
    }, async (accessToken, refreshToken, profile, done) => {

        try {
            const { findOrCreateGoogleUser } = await import('../utils/googleAuth');
            const user = await findOrCreateGoogleUser({
                googleId: profile.id,
                email: profile.emails?.[0]?.value,
                fullName: profile.displayName || `${profile.name?.givenName || ''} ${profile.name?.familyName || ''}`.trim(),
                avatar: profile.photos?.[0]?.value || '',
            });
            return done(null, user);
        } catch (err) {
            console.error('[passport][google] Sign-in failed:', (err as any)?.message);
            return done(err);
        }
    }));
} else {
    console.warn("⚠️ Google OAuth credentials missing. Google login strategy won't be loaded.");
}

if (process.env.JWT_KEY) {
    passport.use(new JwtStrategy({
        jwtFromRequest: ExtractJwt.fromExtractors([
            (req: any) => req?.cookies?.access_token || null,
            ExtractJwt.fromAuthHeaderAsBearerToken(),
            (req: any) => req?.headers?.['x-auth-token']
        ]),
        secretOrKey: process.env.JWT_KEY
    }, async (payload, done) => {
        try {
            const user = await User.findById(payload.id).select('+currentSessionId');
            if (!user) return done(null, false);
            // Enforce single active session: invalidate token if user logged in on another device
            if (payload.sessionId && user.currentSessionId && payload.sessionId !== user.currentSessionId) {
                return done(null, false, { message: 'Session expired: logged in on another device.' });
            }
            return done(null, user);
        } catch (err) {
            return done(err);
        }
    }));
} else {
    console.warn("⚠️ JWT_KEY is missing. JWT authentication strategy won't be loaded.");
}

export default passport;