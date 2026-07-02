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
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { ArrowLeft, User, Mail, Lock, Eye, EyeOff, Building2, Sparkles, Briefcase } from "lucide-react-native";
import Svg, { Path, Rect, Ellipse, Circle, Text as SvgText } from "react-native-svg";
import { register as apiRegister, clerkSyncApi, checkUserStatus } from "../lib/api";
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

const INDUSTRIES = [
  "Technology & Software",
  "Healthcare & Life Sciences",
  "Finance & Banking",
  "Education & E-Learning",
  "Retail & E-commerce",
  "Real Estate & Construction",
  "Manufacturing & Logistics",
  "Media & Entertainment",
  "Marketing & Advertising",
  "Professional Services & Consulting",
  "Hospitality & Tourism",
  "Energy & Utilities",
  "Non-Profit & Government",
  "Other",
];

const PURPLE = "#6c5ce7";
const PURPLE_SOFT = "rgba(108,92,231,0.08)";
const BG_LIGHT = "#ffffff";
const CARD_BG = "#f8f9fc";
const INK_DARK = "#1f2030";
const INK_SOFT = "#7d7e96";

export default function Signup() {
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<"individual" | "organization">("individual");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [orgName, setOrgName] = useState("");
  const [orgIndustry, setOrgIndustry] = useState("");
  const [orgSize, setOrgSize] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
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

  const selectIndustry = () => {
    Alert.alert(
      "Select Industry",
      "Choose your organization's industry:",
      [
        ...INDUSTRIES.map(ind => ({
          text: ind,
          onPress: () => { setOrgIndustry(ind); setError(""); },
        })),
        { text: "Cancel", style: "cancel" as const },
      ],
      { cancelable: true }
    );
  };

  const selectCompanySize = () => {
    Alert.alert(
      "Select Company Size",
      "Choose the number of employees in your organization:",
      [
        { text: "Solo (1 employee)", onPress: () => { setOrgSize("solo"); setError(""); } },
        { text: "2 - 10 employees", onPress: () => { setOrgSize("2-10"); setError(""); } },
        { text: "11 - 50 employees", onPress: () => { setOrgSize("11-50"); setError(""); } },
        { text: "51 - 200 employees", onPress: () => { setOrgSize("51-200"); setError(""); } },
        { text: "201 - 500 employees", onPress: () => { setOrgSize("201-500"); setError(""); } },
        { text: "500+ employees", onPress: () => { setOrgSize("500+"); setError(""); } },
        { text: "Cancel", style: "cancel" }
      ],
      { cancelable: true }
    );
  };

  const handleSignup = async () => {
    setError("");

    // Validation
    if (activeTab === "individual") {
      if (!fullName.trim()) { setError("Please enter your full name."); return; }
      if (!email.trim()) { setError("Please enter your email address."); return; }
      if (!password) { setError("Please create a password."); return; }
      if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
      if (password !== confirmPassword) { setError("Passwords do not match."); return; }
    } else {
      if (!orgName.trim()) { setError("Please enter your organization name."); return; }
      if (!orgIndustry.trim()) { setError("Please enter your industry."); return; }
      if (!orgSize) { setError("Please select your company size."); return; }
      if (!fullName.trim()) { setError("Please enter your full name."); return; }
      if (!email.trim()) { setError("Please enter your email address."); return; }
      if (!password) { setError("Please create a password."); return; }
      if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
      if (password !== confirmPassword) { setError("Passwords do not match."); return; }
    }

    setLoading(true);
    try {
      const normalizedEmail = email.trim().toLowerCase();

      // Pre-flight: if this email already exists, route the user instead of POSTing
      // /register. Predictively prevents the "I already started signup" failure.
      try {
        const status = await checkUserStatus(normalizedEmail);
        if (status.exists) {
          if (status.nextAction === "verify_otp") {
            setError("We already started signup for this email — let's finish OTP verification.");
            router.push(`/verify-otp?email=${encodeURIComponent(normalizedEmail)}&mode=verify` as any);
            return;
          }
          if (status.nextAction === "login_then_setup" || status.nextAction === "login") {
            setError("An account with this email already exists. Please log in.");
            router.push(`/login?email=${encodeURIComponent(normalizedEmail)}` as any);
            return;
          }
        }
      } catch {
        // Probe is best-effort; if it fails we fall through to the normal register call.
      }

      const payload: any = {
        full_name: fullName.trim(),
        email: normalizedEmail,
        password,
        signupKind: activeTab, // 'individual' | 'organization'
      };

      if (activeTab === "individual") {
        if (inviteCode.trim()) {
          payload.inviteCode = inviteCode.trim();
        }
      } else {
        payload.org_name = orgName.trim();
        payload.org_industry = orgIndustry.trim();
        payload.org_size = orgSize;
      }

      await apiRegister(payload);

      // Navigate to OTP verification screen
      router.push(`/verify-otp?email=${encodeURIComponent(normalizedEmail)}&mode=verify` as any);
    } catch (err: any) {
      // Server may signal that the account already exists but is verified —
      // surface a useful nudge instead of a generic failure.
      if (err?.status === 409 && err?.data?.requiresLogin) {
        setError("An account with this email already exists. Please log in.");
        router.push(`/login?email=${encodeURIComponent(email.trim().toLowerCase())}` as any);
      } else {
        setError(err.message || "Registration failed. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  const { startOAuthFlow } = useOAuth({ strategy: 'oauth_google' });

  const handleGoogleSignup = async () => {
    setError("");
    setGoogleLoading(true);
    try {
      const redirectUrl = Linking.createURL("/", { scheme: "bubblechat" });
      const { createdSessionId, setActive } = await startOAuthFlow({ redirectUrl });
      if (!createdSessionId) return;
      if (setActive) await setActive({ session: createdSessionId });

      // Exchange Clerk session for our own app JWT.
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

      {/* Decorative Large Background Arcs */}
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

          {/* Form */}
          <View style={styles.form}>
            <Text style={styles.title}>Join the bubble</Text>
            <Text style={styles.subtitle}>
              {activeTab === "individual"
                ? "Create your Bubblespace account"
                : "Register your business workspace"}
            </Text>

            {/* Error Message */}
            {error ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            {/* Tab Selector */}
            <View style={styles.tabContainer}>
              <TouchableOpacity
                style={[styles.tabButton, activeTab === "individual" && styles.tabButtonActive]}
                onPress={() => {
                  setActiveTab("individual");
                  setError("");
                }}
                activeOpacity={0.8}
              >
                <Text style={[styles.tabText, activeTab === "individual" && styles.tabTextActive]}>
                  Individual
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.tabButton, activeTab === "organization" && styles.tabButtonActive]}
                onPress={() => {
                  setActiveTab("organization");
                  setError("");
                }}
                activeOpacity={0.8}
              >
                <Text style={[styles.tabText, activeTab === "organization" && styles.tabTextActive]}>
                  Organization
                </Text>
              </TouchableOpacity>
            </View>

            {/* Individual Tab Form */}
            {activeTab === "individual" && (
              <>
                {/* Full Name */}
                <View style={styles.inputRow}>
                  <User size={18} color={INK_SOFT} style={{ marginRight: 10 }} />
                  <TextInput
                    value={fullName}
                    onChangeText={t => { setFullName(t); setError(""); }}
                    placeholder="Full name"
                    placeholderTextColor="#b0b2c3"
                    autoCapitalize="words"
                    style={styles.input}
                    autoComplete="name"
                    importantForAutofill="yes"
                  />
                </View>

                {/* Invite Code */}
                <View style={styles.inputRow}>
                  <Sparkles size={18} color={INK_SOFT} style={{ marginRight: 10 }} />
                  <TextInput
                    value={inviteCode}
                    onChangeText={t => { setInviteCode(t); setError(""); }}
                    placeholder="Invite Code (optional)"
                    placeholderTextColor="#b0b2c3"
                    autoCapitalize="characters"
                    style={styles.input}
                    autoComplete="off"
                    importantForAutofill="no"
                  />
                </View>

                {/* Email */}
                <View style={styles.inputRow}>
                  <Mail size={18} color={INK_SOFT} style={{ marginRight: 10 }} />
                  <TextInput
                    value={email}
                    onChangeText={t => { setEmail(t); setError(""); }}
                    placeholder="Email address"
                    placeholderTextColor="#b0b2c3"
                    autoCapitalize="none"
                    keyboardType="email-address"
                    style={styles.input}
                    autoComplete="email"
                    importantForAutofill="yes"
                  />
                </View>

                {/* Password — FIX: autoComplete="new-password" prevents yellow autofill highlight */}
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
                    autoComplete="new-password"
                    importantForAutofill="no"
                    textContentType="newPassword"
                  />
                  <TouchableOpacity onPress={() => setShowPassword(v => !v)} style={{ padding: 4 }} activeOpacity={0.7}>
                    {showPassword ? <EyeOff size={18} color={INK_SOFT} /> : <Eye size={18} color={INK_SOFT} />}
                  </TouchableOpacity>
                </View>

                {/* Confirm Password — FIX: autoComplete="new-password" prevents yellow autofill highlight */}
                <View style={styles.inputRow}>
                  <Lock size={18} color={INK_SOFT} style={{ marginRight: 10 }} />
                  <TextInput
                    value={confirmPassword}
                    onChangeText={t => { setConfirmPassword(t); setError(""); }}
                    placeholder="Confirm Password"
                    placeholderTextColor="#b0b2c3"
                    secureTextEntry={!showConfirmPassword}
                    autoCapitalize="none"
                    keyboardType="default"
                    style={[styles.input, { flex: 1 }]}
                    autoComplete="new-password"
                    importantForAutofill="no"
                    textContentType="newPassword"
                  />
                  <TouchableOpacity onPress={() => setShowConfirmPassword(v => !v)} style={{ padding: 4 }} activeOpacity={0.7}>
                    {showConfirmPassword ? <EyeOff size={18} color={INK_SOFT} /> : <Eye size={18} color={INK_SOFT} />}
                  </TouchableOpacity>
                </View>
              </>
            )}

            {/* Organization Tab Form */}
            {activeTab === "organization" && (
              <>
                {/* Organization Name */}
                <View style={styles.inputRow}>
                  <Sparkles size={18} color={INK_SOFT} style={{ marginRight: 10 }} />
                  <TextInput
                    value={orgName}
                    onChangeText={t => { setOrgName(t); setError(""); }}
                    placeholder="Organization Name"
                    placeholderTextColor="#b0b2c3"
                    autoCapitalize="words"
                    style={styles.input}
                    autoComplete="organization"
                    importantForAutofill="yes"
                  />
                </View>

                {/* Industry & Company Size */}
                <View style={{ flexDirection: "row", gap: 12, marginBottom: 14 }}>
                  {/* Industry */}
                  <TouchableOpacity
                    style={[styles.inputRow, { flex: 1, marginBottom: 0 }]}
                    onPress={selectIndustry}
                    activeOpacity={0.7}
                  >
                    <Text
                      numberOfLines={1}
                      style={{
                        fontSize: 15,
                        fontFamily: "Poppins_500Medium",
                        color: orgIndustry ? INK_DARK : "#b0b2c3",
                        flex: 1,
                      }}
                    >
                      {orgIndustry || "Industry"}
                    </Text>
                  </TouchableOpacity>

                  {/* Company Size */}
                  <TouchableOpacity
                    style={[styles.inputRow, { flex: 1, marginBottom: 0 }]}
                    onPress={selectCompanySize}
                    activeOpacity={0.7}
                  >
                    <Text style={{
                      fontSize: 15,
                      fontFamily: "Poppins_500Medium",
                      color: orgSize ? INK_DARK : "#b0b2c3",
                      flex: 1
                    }}>
                      {orgSize ? (orgSize === "solo" ? "Solo (1)" : orgSize) : "Company Size"}
                    </Text>
                  </TouchableOpacity>
                </View>

                {/* Full name */}
                <View style={styles.inputRow}>
                  <User size={18} color={INK_SOFT} style={{ marginRight: 10 }} />
                  <TextInput
                    value={fullName}
                    onChangeText={t => { setFullName(t); setError(""); }}
                    placeholder="Full name"
                    placeholderTextColor="#b0b2c3"
                    autoCapitalize="words"
                    style={styles.input}
                    autoComplete="name"
                    importantForAutofill="yes"
                  />
                </View>

                {/* Email address */}
                <View style={styles.inputRow}>
                  <Mail size={18} color={INK_SOFT} style={{ marginRight: 10 }} />
                  <TextInput
                    value={email}
                    onChangeText={t => { setEmail(t); setError(""); }}
                    placeholder="Email address"
                    placeholderTextColor="#b0b2c3"
                    autoCapitalize="none"
                    keyboardType="email-address"
                    style={styles.input}
                    autoComplete="email"
                    importantForAutofill="yes"
                  />
                </View>

                {/* Password — FIX: autoComplete="new-password" prevents yellow autofill highlight */}
                <View style={styles.inputRow}>
                  <Lock size={18} color={INK_SOFT} style={{ marginRight: 10 }} />
                  <TextInput
                    value={password}
                    onChangeText={t => { setPassword(t); setError(""); }}
                    placeholder="Password"
                    placeholderTextColor="#b0b2c3"
                    secureTextEntry={!showPassword}
                    autoCapitalize="none"
                    keyboardType="default"
                    style={[styles.input, { flex: 1 }]}
                    autoComplete="new-password"
                    importantForAutofill="no"
                    textContentType="newPassword"
                  />
                  <TouchableOpacity onPress={() => setShowPassword(v => !v)} style={{ padding: 4 }} activeOpacity={0.7}>
                    {showPassword ? <EyeOff size={18} color={INK_SOFT} /> : <Eye size={18} color={INK_SOFT} />}
                  </TouchableOpacity>
                </View>

                {/* Confirm Password — FIX: autoComplete="new-password" prevents yellow autofill highlight */}
                <View style={styles.inputRow}>
                  <Lock size={18} color={INK_SOFT} style={{ marginRight: 10 }} />
                  <TextInput
                    value={confirmPassword}
                    onChangeText={t => { setConfirmPassword(t); setError(""); }}
                    placeholder="Confirm Password"
                    placeholderTextColor="#b0b2c3"
                    secureTextEntry={!showConfirmPassword}
                    autoCapitalize="none"
                    keyboardType="default"
                    style={[styles.input, { flex: 1 }]}
                    autoComplete="new-password"
                    importantForAutofill="no"
                    textContentType="newPassword"
                  />
                  <TouchableOpacity onPress={() => setShowConfirmPassword(v => !v)} style={{ padding: 4 }} activeOpacity={0.7}>
                    {showConfirmPassword ? <EyeOff size={18} color={INK_SOFT} /> : <Eye size={18} color={INK_SOFT} />}
                  </TouchableOpacity>
                </View>
              </>
            )}

            {/* Hint message */}
            <Text style={styles.hint}>
              Password needs: 8+ characters, uppercase, lowercase, number, special character
            </Text>

            {/* Submit Action Button */}
            <TouchableOpacity
              onPress={handleSignup}
              disabled={loading || googleLoading}
              activeOpacity={0.88}
              style={[styles.primaryBtn, (loading || googleLoading) && { opacity: 0.7 }]}
            >
              {loading ? (
                <ActivityIndicator color="#ffffff" size="small" />
              ) : (
                <Text style={styles.primaryBtnText}>Sign up</Text>
              )}
            </TouchableOpacity>

            {/* Divider */}
            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>OR CONTINUE WITH</Text>
              <View style={styles.dividerLine} />
            </View>

            {/* Google Signup Button */}
            <TouchableOpacity
              onPress={handleGoogleSignup}
              disabled={loading || googleLoading}
              activeOpacity={0.85}
              style={[styles.googleBtn, (loading || googleLoading) && { opacity: 0.7 }]}
            >
              {googleLoading ? (
                <ActivityIndicator color={PURPLE} size="small" />
              ) : (
                <View style={styles.googleBtnContent}>
                  <GoogleLogo size={18} />
                  <Text style={styles.googleBtnText}>Cotinue wwith Google</Text>
                </View>
              )}
            </TouchableOpacity>
          </View>

          {/* Footer Navigation */}
          <View style={styles.footer}>
            <TouchableOpacity onPress={() => router.push("/login" as any)} style={{ paddingVertical: 8 }} activeOpacity={0.7}>
              <Text style={styles.footerText}>
                Already have an account?{" "}
                <Text style={{ color: PURPLE, fontFamily: "Poppins_700Bold" }}>Sign in</Text>
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
  title: { fontSize: 28, fontFamily: "SpaceGrotesk_700Bold", color: INK_DARK, letterSpacing: -0.4, marginBottom: 8 },
  subtitle: { fontSize: 14, color: INK_SOFT, fontFamily: "Poppins_400Regular", marginBottom: 24 },
  errorBox: { backgroundColor: "#fff5f5", borderRadius: 16, padding: 14, borderWidth: 1.5, borderColor: "#ffe3e3", marginBottom: 18 },
  errorText: { color: "#e53e3e", fontSize: 13, fontFamily: "Poppins_600SemiBold" },
  inputRow: { flexDirection: "row", alignItems: "center", backgroundColor: CARD_BG, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 13, borderWidth: 1.5, borderColor: "rgba(0,0,0,0.03)", marginBottom: 14 },
  input: { flex: 1, fontSize: 15, fontFamily: "Poppins_500Medium", color: INK_DARK },
  tabContainer: {
    flexDirection: "row",
    backgroundColor: "rgba(108,92,231,0.08)",
    borderRadius: 20,
    padding: 4,
    marginBottom: 24,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
  },
  tabButtonActive: {
    backgroundColor: "#ffffff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  tabText: {
    fontSize: 14,
    fontFamily: "Poppins_600SemiBold",
    color: "#7d7e96",
  },
  tabTextActive: {
    color: "#1f2030",
  },
  hint: { fontSize: 11, color: INK_SOFT, fontFamily: "Poppins_400Regular", marginBottom: 20, lineHeight: 16 },
  primaryBtn: { backgroundColor: PURPLE, height: 56, borderRadius: 18, alignItems: "center", justifyContent: "center", shadowColor: PURPLE, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 10, elevation: 8 },
  primaryBtnText: { color: "#ffffff", fontFamily: "Poppins_700Bold", fontSize: 15 },
  dividerRow: { flexDirection: "row", alignItems: "center", marginVertical: 24, gap: 12 },
  dividerLine: { flex: 1, height: 1, backgroundColor: "rgba(0,0,0,0.06)" },
  dividerText: { fontSize: 11, color: INK_SOFT, fontFamily: "Poppins_600SemiBold", textTransform: "uppercase", letterSpacing: 1 },
  googleBtn: { backgroundColor: "#ffffff", borderWidth: 1.5, borderColor: "rgba(0,0,0,0.08)", height: 56, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  googleBtnContent: { flexDirection: "row", alignItems: "center", gap: 10 },
  googleBtnText: { fontSize: 15, fontFamily: "Poppins_700Bold", color: INK_DARK },
  footer: { alignItems: "center", marginTop: 16 },
  footerText: { fontSize: 14, color: INK_SOFT, fontFamily: "Poppins_500Medium" },
});