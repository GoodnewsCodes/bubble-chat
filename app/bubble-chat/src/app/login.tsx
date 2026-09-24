import React, { useState, useRef, useEffect } from "react";
import {
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  ActivityIndicator,
  StatusBar,
  Animated,
  Dimensions,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ArrowLeft, Mail, Lock, Eye, EyeOff } from "lucide-react-native";
import Svg, { Path, Rect, Ellipse, Circle, Text as SvgText } from "react-native-svg";
import { login as apiLogin, clerkSyncApi } from "../lib/api";
import { useOAuth } from "@clerk/clerk-expo";
import { authStorage } from "../lib/authStorage";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";

// Dismisses the in-app browser and returns to the app once Clerk's OAuth
// redirect completes. Must run at module scope (Clerk/Expo requirement).
WebBrowser.maybeCompleteAuthSession();

const BubbleLogo = ({ size = 40 }: { size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 16 16">
    <Rect width="16" height="16" rx="3.5" fill="#1a1a2e" />
    <Ellipse
      cx="8"
      cy="8"
      rx="6"
      ry="2.2"
      fill="none"
      stroke="#7C5CFC"
      strokeWidth={1.2}
      rotation={-30}
      origin="8, 8"
    />
    <Circle cx="13" cy="5.2" r="1" fill="#C3ABFF" />
    <SvgText
      x="8"
      y="11.2"
      fontFamily="System"
      fontSize="9"
      fontWeight="700"
      fill="white"
      textAnchor="middle"
    >
      b
    </SvgText>
  </Svg>
);

const GoogleLogo = ({ size = 18 }: { size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    <Path
      fill="#4285F4"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
    />
    <Path
      fill="#34A853"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
    />
    <Path
      fill="#FBBC05"
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
    />
    <Path
      fill="#EA4335"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
    />
  </Svg>
);

const { width: W, height: H } = Dimensions.get("window");

const PURPLE = "#6c5ce7";
const PURPLE_SOFT = "rgba(108,92,231,0.08)";
const BG_LIGHT = "#ffffff";
const CARD_BG = "#f8f9fc";
const INK_DARK = "#1f2030";
const INK_SOFT = "#7d7e96";

// Map signup-state to the screen we should land on after login.
const routeForStep = (step?: string, onboardingComplete?: boolean): any => {
  if (onboardingComplete || step === "complete") return "/(main)/messages";
  if (step === "awaiting_org" || step === "awaiting_profile") return "/profile-setup";
  return "/profile-setup";
};

export default function Login() {
  const router = useRouter();
  const params = useLocalSearchParams<{ email?: string }>();
  const [email, setEmail] = useState(typeof params.email === "string" ? params.email : "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState("");

  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 500,
      useNativeDriver: true,
    }).start();
  }, []);

  const handleLogin = async () => {
    setError("");
    if (!email.trim()) { setError("Please enter your email."); return; }
    if (!password) { setError("Please enter your password."); return; }

    setLoading(true);
    try {
      const res = await apiLogin({ email: email.trim().toLowerCase(), password });
      const { data } = res;

      if (data?.requiresVerification) {
        // Account not verified — send to OTP verification screen
        router.push(`/verify-otp?email=${encodeURIComponent(email.trim().toLowerCase())}&mode=verify` as any);
        return;
      }

      if (data?.accessToken && data?.refreshToken) {
        await authStorage.setSession(data.accessToken, data.refreshToken, data.user);

        // Silent restore E2E cloud backup if exists
        try {
          const { chatCache } = await import("../lib/chatCache");
          await chatCache.restoreCloudBackup();
        } catch (restoreErr) {
          console.warn("Failed silent restore on login:", restoreErr);
        }

        // Dynamic redirection — resume at the exact step the user is on.
        const target = routeForStep(data.user?.onboardingStep, data.user?.onboardingComplete);
        if (target === "/(main)/messages") {
          router.replace("/(main)/messages" as any);
        } else {
          router.replace("/profile-setup" as any);
        }
      }
    } catch (err: any) {
      setError(err.message || "Login failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const { startOAuthFlow } = useOAuth({ strategy: 'oauth_google' });

  const handleGoogleLogin = async () => {
    setError("");
    setGoogleLoading(true);
    try {
      // Pass an explicit app redirect (bubblechat://) so the OAuth browser
      // reliably returns to the app on native builds instead of stranding on
      // the web callback.
      const redirectUrl = Linking.createURL("/", { scheme: "bubblechat" });
      const { createdSessionId, setActive } = await startOAuthFlow({ redirectUrl });
      if (!createdSessionId) {
        // User cancelled or OAuth flow didn't complete
        return;
      }
      if (setActive) await setActive({ session: createdSessionId });

      // Send the Clerk session ID to our backend, which verifies it against Clerk's API
      // and returns our own app JWT tied to this user's DB record.
      const data = await clerkSyncApi(createdSessionId);
      await authStorage.setSession(data.accessToken, data.refreshToken, data.user);

      try {
        const { chatCache } = await import("../lib/chatCache");
        await chatCache.restoreCloudBackup();
      } catch { /* best-effort */ }

      if (data.user?.onboardingComplete) {
        router.replace("/(main)/messages" as any);
      } else {
        router.replace("/profile-setup" as any);
      }
    } catch (err: any) {
      setError(err.message || "Google sign-in was cancelled or failed.");
    } finally {
      setGoogleLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.container}
    >
      <StatusBar barStyle="dark-content" backgroundColor={BG_LIGHT} />

      {/* Symmetrical Curved Background Arcs */}
      <View style={styles.glowBottom} />

      <ScrollView
        contentContainerStyle={{ flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Animated.View style={[styles.inner, { opacity: fadeAnim }]}>
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity onPress={() => router.canGoBack() ? router.back() : router.replace('/login')} style={styles.backBtn}>
              <ArrowLeft size={18} color={INK_DARK} />
              <Text style={styles.backText}>Back</Text>
            </TouchableOpacity>

            <BubbleLogo size={40} />
          </View>

          {/* Form Container */}
          <View style={styles.form}>
            <Text style={styles.title}>Welcome back</Text>
            <Text style={styles.subtitle}>Sign in to your Bubblespace account</Text>

            {/* Error Message Box */}
            {error ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            {/* Email Field */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Email Address</Text>
              <View style={styles.inputRow}>
                <Mail size={18} color={INK_SOFT} style={{ marginRight: 10 }} />
                <TextInput
                  value={email}
                  onChangeText={t => { setEmail(t); setError(""); }}
                  placeholder="name@company.com"
                  placeholderTextColor="#b0b2c3"
                  autoCapitalize="none"
                  keyboardType="email-address"
                  style={styles.input}
                  autoComplete="email"
                />
              </View>
            </View>

            {/* Password Field */}
            <View style={styles.fieldGroup}>
              <View style={styles.labelRow}>
                <Text style={styles.label}>Password</Text>
                <TouchableOpacity onPress={() => router.push("/forgot-password" as any)} activeOpacity={0.7}>
                  <Text style={styles.forgotLink}>Forgot?</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.inputRow}>
                <Lock size={18} color={INK_SOFT} style={{ marginRight: 10 }} />
                <TextInput
                  value={password}
                  onChangeText={t => { setPassword(t); setError(""); }}
                  placeholder="Enter your password"
                  placeholderTextColor="#b0b2c3"
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  style={[styles.input, { flex: 1 }]}
                  autoComplete="password"
                />
                <TouchableOpacity onPress={() => setShowPassword(v => !v)} style={{ padding: 4 }} activeOpacity={0.7}>
                  {showPassword ? <EyeOff size={18} color={INK_SOFT} /> : <Eye size={18} color={INK_SOFT} />}
                </TouchableOpacity>
              </View>
            </View>

            {/* Log In Action Button */}
            <TouchableOpacity
              onPress={handleLogin}
              disabled={loading || googleLoading}
              activeOpacity={0.88}
              style={[styles.primaryBtn, (loading || googleLoading) && { opacity: 0.7 }]}
            >
              {loading ? (
                <ActivityIndicator color="#ffffff" size="small" />
              ) : (
                <Text style={styles.primaryBtnText}>Log In</Text>
              )}
            </TouchableOpacity>

            {/* Styled Divider */}
            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>OR CONTINUE WITH</Text>
              <View style={styles.dividerLine} />
            </View>

            {/* Google Authentication Action Button */}
            <TouchableOpacity
              onPress={handleGoogleLogin}
              disabled={loading || googleLoading}
              activeOpacity={0.85}
              style={[styles.googleBtn, (loading || googleLoading) && { opacity: 0.7 }]}
            >
              {googleLoading ? (
                <ActivityIndicator color={PURPLE} size="small" />
              ) : (
                <View style={styles.googleBtnContent}>
                  <GoogleLogo size={18} />
                  <Text style={styles.googleBtnText}>Continue with Google</Text>
                </View>
              )}
            </TouchableOpacity>
          </View>

          {/* Footer Navigation */}
          <View style={styles.footer}>
            <TouchableOpacity onPress={() => router.push("/signup" as any)} style={{ paddingVertical: 8 }} activeOpacity={0.7}>
              <Text style={styles.footerText}>
                Don't have an account?{" "}
                <Text style={{ color: PURPLE, fontFamily: "Poppins_700Bold" }}>Sign up</Text>
              </Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG_LIGHT },

  glowBottom: {
    position: "absolute",
    bottom: -W * 1.85,
    left: -W * 0.5,
    width: W * 2,
    height: W * 2,
    borderRadius: W,
    backgroundColor: "rgba(14,165,233,0.03)",
    zIndex: 0,
  },
  inner: { flex: 1, justifyContent: "space-between", paddingHorizontal: 24, paddingTop: H * 0.07, paddingBottom: H * 0.04, zIndex: 10 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8 },
  backText: { fontSize: 15, fontFamily: "Poppins_600SemiBold", color: INK_DARK },

  form: { flex: 1, paddingVertical: 20 },
  title: {
    fontSize: 28, fontFamily: "SpaceGrotesk_700Bold", color: INK_DARK,
    letterSpacing: -0.4, marginBottom: 8,
  },
  subtitle: { fontSize: 14, color: INK_SOFT, fontFamily: "Poppins_400Regular", marginBottom: 28 },
  errorBox: {
    backgroundColor: "#fff5f5", borderRadius: 16, padding: 14,
    borderWidth: 1.5, borderColor: "#ffe3e3", marginBottom: 18,
  },
  errorText: { color: "#e53e3e", fontSize: 13, fontFamily: "Poppins_600SemiBold" },
  fieldGroup: { marginBottom: 18 },
  label: { fontSize: 11, fontFamily: "Poppins_700Bold", color: INK_SOFT, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 },
  labelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  forgotLink: { fontSize: 13, fontFamily: "Poppins_700Bold", color: PURPLE },
  inputRow: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: CARD_BG, borderRadius: 18,
    paddingHorizontal: 16, paddingVertical: 14,
    borderWidth: 1.5, borderColor: "rgba(0,0,0,0.03)",
  },
  input: { flex: 1, fontSize: 15, fontFamily: "Poppins_500Medium", color: INK_DARK },
  primaryBtn: {
    backgroundColor: PURPLE, height: 56,
    borderRadius: 18, alignItems: "center", justifyContent: "center",
    marginTop: 8,
    shadowColor: PURPLE,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3, shadowRadius: 10, elevation: 8,
  },
  primaryBtnText: { color: "#ffffff", fontFamily: "Poppins_700Bold", fontSize: 15 },
  dividerRow: { flexDirection: "row", alignItems: "center", marginVertical: 24, gap: 12 },
  dividerLine: { flex: 1, height: 1, backgroundColor: "rgba(0,0,0,0.06)" },
  dividerText: { fontSize: 11, color: INK_SOFT, fontFamily: "Poppins_600SemiBold", textTransform: "uppercase", letterSpacing: 1 },
  googleBtn: {
    backgroundColor: "#ffffff", borderWidth: 1.5, borderColor: "rgba(0,0,0,0.08)",
    height: 56, borderRadius: 18, alignItems: "center", justifyContent: "center",
  },
  googleBtnContent: {
    flexDirection: "row", alignItems: "center", gap: 10,
  },

  googleBtnText: { fontSize: 15, fontFamily: "Poppins_700Bold", color: INK_DARK },
  footer: { alignItems: "center", marginTop: 16 },
  footerText: { fontSize: 14, color: INK_SOFT, fontFamily: "Poppins_500Medium" },
});
