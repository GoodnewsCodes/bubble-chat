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
import { useRouter, useLocalSearchParams } from "expo-router";
import { ArrowLeft, Lock, Eye, EyeOff, CheckCircle2 } from "lucide-react-native";
import { resetPassword as apiResetPassword } from "../lib/api";

const PURPLE = "#6c5ce7";

export default function ResetPassword() {
  const router = useRouter();
  const { email, otp } = useLocalSearchParams<{ email: string; otp: string }>();

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const handleReset = async () => {
    setError("");
    if (!newPassword) { setError("Please enter a new password."); return; }
    if (newPassword !== confirmPassword) { setError("Passwords do not match."); return; }
    if (!email || !otp) { setError("Invalid reset session. Please try forgot password again."); return; }

    setLoading(true);
    try {
      await apiResetPassword({ email, otp, newPassword });
      setDone(true);
      setTimeout(() => router.replace("/login" as any), 2000);
    } catch (err: any) {
      setError(err.message || "Reset failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <View style={[styles.container, { alignItems: "center", justifyContent: "center" }]}>
        <CheckCircle2 size={64} color="#10b981" />
        <Text style={[styles.title, { color: "#10b981", marginTop: 20 }]}>Password Reset!</Text>
        <Text style={styles.subtitle}>Redirecting you to login…</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.container}
    >
      <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={styles.inner}>
          <TouchableOpacity onPress={() => router.canGoBack() ? router.back() : router.replace('/login')} style={styles.backBtn}>
            <ArrowLeft size={20} color="#6b7280" />
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>

          <Text style={styles.title}>Create New Password</Text>
          <Text style={styles.subtitle}>
            Choose a strong password for your Bubblespace account.
          </Text>

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {/* New Password */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>New Password</Text>
            <View style={styles.inputRow}>
              <Lock size={18} color="#9ca3af" style={{ marginRight: 10 }} />
              <TextInput
                value={newPassword}
                onChangeText={t => { setNewPassword(t); setError(""); }}
                placeholder="Enter new password"
                placeholderTextColor="#c4c8d8"
                secureTextEntry={!showNew}
                autoCapitalize="none"
                style={[styles.input, { flex: 1 }]}
              />
              <TouchableOpacity onPress={() => setShowNew(v => !v)} style={{ padding: 4 }}>
                {showNew ? <EyeOff size={18} color="#9ca3af" /> : <Eye size={18} color="#9ca3af" />}
              </TouchableOpacity>
            </View>
          </View>

          {/* Confirm Password */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Confirm Password</Text>
            <View style={styles.inputRow}>
              <Lock size={18} color="#9ca3af" style={{ marginRight: 10 }} />
              <TextInput
                value={confirmPassword}
                onChangeText={t => { setConfirmPassword(t); setError(""); }}
                placeholder="Re-enter new password"
                placeholderTextColor="#c4c8d8"
                secureTextEntry={!showConfirm}
                autoCapitalize="none"
                style={[styles.input, { flex: 1 }]}
              />
              <TouchableOpacity onPress={() => setShowConfirm(v => !v)} style={{ padding: 4 }}>
                {showConfirm ? <EyeOff size={18} color="#9ca3af" /> : <Eye size={18} color="#9ca3af" />}
              </TouchableOpacity>
            </View>
          </View>

          <Text style={styles.hint}>
            Password needs: 8+ chars, uppercase, lowercase, number, special character
          </Text>

          <TouchableOpacity
            onPress={handleReset}
            disabled={loading}
            activeOpacity={0.88}
            style={[styles.primaryBtn, loading && { opacity: 0.7 }]}
          >
            {loading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.primaryBtnText}>Reset Password</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fafafa" },
  inner: { flex: 1, paddingHorizontal: 28, paddingTop: 64 },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 40 },
  backText: { fontSize: 14, fontWeight: "600", color: "#6b7280" },
  title: { fontSize: 28, fontWeight: "800", color: "#111827", letterSpacing: -0.5, marginBottom: 8 },
  subtitle: { fontSize: 14, color: "#6b7280", lineHeight: 22, marginBottom: 28 },
  errorBox: { backgroundColor: "#fef2f2", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#fecaca", marginBottom: 16 },
  errorText: { color: "#dc2626", fontSize: 13, fontWeight: "500" },
  fieldGroup: { marginBottom: 16 },
  label: { fontSize: 12, fontWeight: "700", color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 },
  inputRow: { flexDirection: "row", alignItems: "center", backgroundColor: "#f3f4f6", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 14, borderWidth: 1, borderColor: "#e5e7eb" },
  input: { flex: 1, fontSize: 15, fontWeight: "500", color: "#111827" },
  hint: { fontSize: 11, color: "#9ca3af", marginBottom: 24, lineHeight: 16 },
  primaryBtn: { backgroundColor: PURPLE, paddingVertical: 16, borderRadius: 20, alignItems: "center", shadowColor: PURPLE, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 10, elevation: 8 },
  primaryBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
