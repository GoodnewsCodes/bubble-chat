import React, { useState } from "react";
import {
  Text,
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { ArrowLeft, Mail, KeyRound } from "lucide-react-native";
import { forgotPassword as apiForgotPassword } from "../lib/api";

const PURPLE = "#6c5ce7";

export default function ForgotPassword() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  const handleSubmit = async () => {
    setError("");
    if (!email.trim()) { setError("Please enter your email address."); return; }

    setLoading(true);
    try {
      await apiForgotPassword(email.trim().toLowerCase());
      setSent(true);
      // Navigate to OTP with reset mode
      setTimeout(() => {
        router.push(`/verify-otp?email=${encodeURIComponent(email.trim().toLowerCase())}&mode=reset` as any);
      }, 1200);
    } catch (err: any) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.container}
    >
      <ScrollView
        contentContainerStyle={{ flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.inner}>
          <TouchableOpacity onPress={() => router.canGoBack() ? router.back() : router.replace('/login')} style={styles.backBtn}>
            <ArrowLeft size={20} color="#6b7280" />
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>

          {/* Icon */}
          <View style={styles.iconCircle}>
            <KeyRound size={36} color={PURPLE} />
          </View>

          <Text style={styles.title}>Forgot Password?</Text>
          <Text style={styles.subtitle}>
            No worries — enter your email and we'll send you a reset code.
          </Text>

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {sent ? (
            <View style={styles.successBox}>
              <Text style={styles.successText}>✓ Code sent! Redirecting to verification…</Text>
            </View>
          ) : null}

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Email Address</Text>
            <View style={styles.inputRow}>
              <Mail size={18} color="#9ca3af" style={{ marginRight: 10 }} />
              <TextInput
                value={email}
                onChangeText={t => { setEmail(t); setError(""); }}
                placeholder="name@company.com"
                placeholderTextColor="#c4c8d8"
                autoCapitalize="none"
                keyboardType="email-address"
                style={styles.input}
                editable={!sent}
              />
            </View>
          </View>

          <TouchableOpacity
            onPress={handleSubmit}
            disabled={loading || sent}
            activeOpacity={0.88}
            style={[styles.primaryBtn, (loading || sent) && { opacity: 0.7 }]}
          >
            {loading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.primaryBtnText}>Send Reset Code</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity onPress={() => router.push("/login" as any)} style={styles.loginLink}>
            <Text style={styles.loginLinkText}>
              Remember it?{" "}
              <Text style={{ color: PURPLE, fontWeight: "700" }}>Log in</Text>
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fafafa" },
  inner: { flex: 1, paddingHorizontal: 28, paddingTop: 64, alignItems: "center" },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", marginBottom: 40 },
  backText: { fontSize: 14, fontWeight: "600", color: "#6b7280" },
  iconCircle: {
    width: 88, height: 88, borderRadius: 44,
    backgroundColor: PURPLE + "15",
    alignItems: "center", justifyContent: "center", marginBottom: 28,
  },
  title: { fontSize: 26, fontWeight: "800", color: "#111827", marginBottom: 10, textAlign: "center" },
  subtitle: { fontSize: 14, color: "#6b7280", textAlign: "center", lineHeight: 22, marginBottom: 28 },
  errorBox: { backgroundColor: "#fef2f2", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#fecaca", marginBottom: 16, width: "100%" },
  errorText: { color: "#dc2626", fontSize: 13, fontWeight: "500", textAlign: "center" },
  successBox: { backgroundColor: "#f0fdf4", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#86efac", marginBottom: 16, width: "100%" },
  successText: { color: "#16a34a", fontSize: 13, fontWeight: "600", textAlign: "center" },
  fieldGroup: { width: "100%", marginBottom: 20 },
  label: { fontSize: 12, fontWeight: "700", color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 },
  inputRow: { flexDirection: "row", alignItems: "center", backgroundColor: "#f3f4f6", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 14, borderWidth: 1, borderColor: "#e5e7eb" },
  input: { flex: 1, fontSize: 15, fontWeight: "500", color: "#111827" },
  primaryBtn: { backgroundColor: PURPLE, paddingVertical: 16, borderRadius: 20, alignItems: "center", width: "100%", shadowColor: PURPLE, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 10, elevation: 8, marginBottom: 20 },
  primaryBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  loginLink: { paddingVertical: 8 },
  loginLinkText: { fontSize: 14, color: "#6b7280" },
});
