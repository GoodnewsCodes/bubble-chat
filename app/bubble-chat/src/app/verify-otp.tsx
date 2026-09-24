import React, { useState, useRef, useEffect } from "react";
import {
  Text,
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ArrowLeft, Mail } from "lucide-react-native";
import { verifyOTP as apiVerifyOTP, resendOTP as apiResendOTP } from "../lib/api";
import { authStorage } from "../lib/authStorage";

const PURPLE = "#6c5ce7";
const OTP_LENGTH = 5;

export default function VerifyOTP() {
  const router = useRouter();
  const { email, mode } = useLocalSearchParams<{ email: string; mode: "verify" | "reset" }>();

  const [otp, setOtp] = useState<string[]>(Array(OTP_LENGTH).fill(""));
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState("");
  const [countdown, setCountdown] = useState(60);
  const [canResend, setCanResend] = useState(false);
  const inputRefs = useRef<(TextInput | null)[]>([]);

  // Countdown timer for resend
  useEffect(() => {
    if (countdown <= 0) { setCanResend(true); return; }
    const timer = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const handleChange = (value: string, index: number) => {
    const cleaned = value.replace(/\D/g, "").slice(-1);
    const newOtp = [...otp];
    newOtp[index] = cleaned;
    setOtp(newOtp);
    setError("");

    if (cleaned && index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
    // Auto-submit when all filled
    if (cleaned && index === OTP_LENGTH - 1 && newOtp.every(d => d)) {
      handleVerify(newOtp.join(""));
    }
  };

  const handleKeyPress = (e: any, index: number) => {
    if (e.nativeEvent.key === "Backspace" && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleVerify = async (code?: string) => {
    const otpCode = code || otp.join("");
    if (otpCode.length < OTP_LENGTH) { setError("Please enter all 5 digits."); return; }
    if (!email) { setError("Email missing. Please go back and try again."); return; }

    setLoading(true);
    setError("");
    try {
      const res = await apiVerifyOTP(email, otpCode);
      const { data } = res;

      if (mode === "reset") {
        // For password reset: move to reset-password page with otp
        router.replace(`/reset-password?email=${encodeURIComponent(email)}&otp=${otpCode}` as any);
        return;
      }

      // For account verification: store session
      if (data?.accessToken && data?.refreshToken) {
        await authStorage.setSession(data.accessToken, data.refreshToken, data.user);
        
        // Silent restore E2E cloud backup if exists
        try {
          const { chatCache } = await import("../lib/chatCache");
          await chatCache.restoreCloudBackup();
        } catch (restoreErr) {
          console.warn("Failed silent restore on OTP verification:", restoreErr);
        }
        
        // Check if profile setup is needed
        if (!data.user?.onboardingComplete) {
          router.replace("/profile-setup" as any);
        } else {
          router.replace("/(main)/messages" as any);
        }
      }
    } catch (err: any) {
      setError(err.message || "Invalid or expired code. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (!canResend || !email) return;
    setResending(true);
    setError("");
    try {
      await apiResendOTP(email);
      setCountdown(60);
      setCanResend(false);
      setOtp(Array(OTP_LENGTH).fill(""));
      inputRefs.current[0]?.focus();
    } catch (err: any) {
      setError(err.message || "Failed to resend OTP.");
    } finally {
      setResending(false);
    }
  };

  const maskedEmail = email
    ? email.replace(/(.{2})(.*)(?=@)/, (_, a, b) => a + "*".repeat(Math.min(b.length, 4)))
    : "";

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.container}
    >
      <View style={styles.inner}>
        {/* Back */}
        <TouchableOpacity onPress={() => router.canGoBack() ? router.back() : router.replace('/login')} style={styles.backBtn}>
          <ArrowLeft size={20} color="#6b7280" />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>

        {/* Icon */}
        <View style={styles.iconWrap}>
          <View style={styles.iconCircle}>
            <Mail size={32} color={PURPLE} />
          </View>
        </View>

        <Text style={styles.title}>
          {mode === "reset" ? "Reset Code" : "Verify Your Email"}
        </Text>
        <Text style={styles.subtitle}>
          {mode === "reset"
            ? "We sent a password reset code to"
            : "We sent a verification code to"}
        </Text>
        <Text style={styles.email}>{maskedEmail}</Text>

        {/* OTP Boxes */}
        <View style={styles.otpRow}>
          {Array(OTP_LENGTH).fill(0).map((_, i) => (
            <TextInput
              key={i}
              ref={r => { inputRefs.current[i] = r; }}
              value={otp[i]}
              onChangeText={v => handleChange(v, i)}
              onKeyPress={e => handleKeyPress(e, i)}
              maxLength={1}
              keyboardType="number-pad"
              style={[
                styles.otpBox,
                otp[i] ? styles.otpBoxFilled : undefined,
                error ? styles.otpBoxError : undefined,
              ]}
              selectTextOnFocus
              caretHidden
            />
          ))}
        </View>

        {/* Error */}
        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {/* Verify Button */}
        <TouchableOpacity
          onPress={() => handleVerify()}
          disabled={loading || otp.some(d => !d)}
          activeOpacity={0.88}
          style={[styles.primaryBtn, (loading || otp.some(d => !d)) && { opacity: 0.6 }]}
        >
          {loading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.primaryBtnText}>
              {mode === "reset" ? "Confirm Code" : "Verify Email"}
            </Text>
          )}
        </TouchableOpacity>

        {/* Resend */}
        <View style={styles.resendRow}>
          <Text style={styles.resendLabel}>Didn't receive it? </Text>
          {canResend ? (
            <TouchableOpacity onPress={handleResend} disabled={resending}>
              {resending ? (
                <ActivityIndicator size="small" color={PURPLE} />
              ) : (
                <Text style={[styles.resendLink]}>Resend Code</Text>
              )}
            </TouchableOpacity>
          ) : (
            <Text style={styles.countdownText}>Resend in {countdown}s</Text>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fafafa" },
  inner: { flex: 1, paddingHorizontal: 28, paddingTop: 64, alignItems: "center" },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", marginBottom: 40 },
  backText: { fontSize: 14, fontWeight: "600", color: "#6b7280" },
  iconWrap: { marginBottom: 24 },
  iconCircle: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: PURPLE + "15",
    alignItems: "center", justifyContent: "center",
  },
  title: { fontSize: 26, fontWeight: "800", color: "#111827", marginBottom: 10, textAlign: "center" },
  subtitle: { fontSize: 14, color: "#6b7280", fontWeight: "500", textAlign: "center" },
  email: { fontSize: 15, fontWeight: "700", color: PURPLE, marginTop: 4, marginBottom: 36, textAlign: "center" },
  otpRow: { flexDirection: "row", gap: 12, marginBottom: 24 },
  otpBox: {
    width: 52, height: 60, borderRadius: 16,
    backgroundColor: "#f3f4f6", borderWidth: 2, borderColor: "#e5e7eb",
    fontSize: 24, fontWeight: "700", color: "#111827",
    textAlign: "center",
  },
  otpBoxFilled: { borderColor: PURPLE, backgroundColor: PURPLE + "0D" },
  otpBoxError: { borderColor: "#ef4444" },
  errorBox: { backgroundColor: "#fef2f2", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#fecaca", marginBottom: 16, width: "100%" },
  errorText: { color: "#dc2626", fontSize: 13, fontWeight: "500", textAlign: "center" },
  primaryBtn: {
    backgroundColor: PURPLE, paddingVertical: 16, borderRadius: 20,
    alignItems: "center", width: "100%",
    shadowColor: PURPLE, shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3, shadowRadius: 10, elevation: 8,
    marginBottom: 20,
  },
  primaryBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  resendRow: { flexDirection: "row", alignItems: "center" },
  resendLabel: { fontSize: 14, color: "#6b7280" },
  resendLink: { fontSize: 14, color: PURPLE, fontWeight: "700" },
  countdownText: { fontSize: 14, color: "#9ca3af", fontWeight: "600" },
});
