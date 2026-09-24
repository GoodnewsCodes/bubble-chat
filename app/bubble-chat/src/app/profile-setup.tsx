import React, { useState, useEffect, useRef } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
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
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import {
  User, Briefcase, FileText, Check, ChevronRight, ArrowLeft, Camera,
  Sparkles, Globe, MapPin, Smile, Bookmark, Plus, Copy, Share, Info, Trash2
} from "lucide-react-native";
import { authStorage } from "../lib/authStorage";
import {
  getMyProfile, setupProfile, onboardOrgBrain,
  ingestOrgDocument, ingestOrgDocumentFromUrl, ingestOrgDocumentFromFile,
  getOrgInviteCode,
} from "../lib/api";
import { Clipboard } from "react-native";
import * as DocumentPicker from "expo-document-picker";

const PURPLE = "#6c5ce7";
const INK = "#1f2030";
const INK_SOFT = "#9a9aab";
const BG = "#f8f7ff";
const PURPLE_SOFT = "rgba(108,92,231,0.08)";

const AVATARS = [
  "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=150&auto=format&fit=crop",
];

const ROLE_OPTIONS = [
  "Developer", "Designer", "Product Manager", "Marketing",
  "Sales", "Operations", "Finance", "HR", "CEO / Founder", "Other",
];

const INDUSTRIES = [
  "Technology", "Healthcare", "Finance", "Education", "Retail", "Services", "Other"
];

const ORG_SIZES = [
  "solo", "2-10", "11-50", "51-200", "201-500", "500+"
];

// Per-user storage key so multiple test accounts on the same device don't collide.
const draftKeyFor = (id?: string) => `bubble_profile_setup_draft_v1_${id || "anon"}`;

export default function ProfileSetup() {
  const router = useRouter();

  const [currentUser, setCurrentUser] = useState<any>(null);
  const [loadingProfile, setLoadingProfile] = useState(true);

  // Step state
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Step 1 Details
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [phone, setPhone] = useState("");
  const [bio, setBio] = useState("");
  const [role, setRole] = useState("");
  const [selectedAvatar, setSelectedAvatar] = useState(AVATARS[0]);

  // Step 2 Details (Admin only)
  const [orgName, setOrgName] = useState("");
  const [orgIndustry, setOrgIndustry] = useState("");
  const [orgSize, setOrgSize] = useState<any>("");
  const [businessDesc, setBusinessDesc] = useState("");

  // Step 3 Details (Admin only)
  const [docTitle, setDocTitle] = useState("");
  const [docContent, setDocContent] = useState("");
  const [documents, setDocuments] = useState<{ title: string; content: string }[]>([]);

  // Queued files (PDF/TXT/MD) and URLs (YouTube + web pages) to ingest after onboard.
  const [pendingFiles, setPendingFiles] = useState<{ uri: string; name: string; type: string }[]>([]);
  const [pendingUrls, setPendingUrls] = useState<{ url: string; title: string }[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [urlTitleInput, setUrlTitleInput] = useState("");
  const [ingestProgress, setIngestProgress] = useState("");

  // Step 4 Details
  const [inviteCode, setInviteCode] = useState("");
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  // Draft persistence: only start writing AFTER we've hydrated from disk, so the
  // first render doesn't blow away a saved draft with empty initial state.
  const hydratedRef = useRef(false);
  const draftUserKeyRef = useRef<string>("");

  useEffect(() => {
    async function loadUser() {
      try {
        const res = await getMyProfile();
        if (res?.data) {
          const u = res.data;

          // Authoritative stage gate (mirrors web): the backend profile decides.
          // If onboarding is already complete, skip setup entirely so a returning
          // user never re-submits a finished stage (the source of duplicate/409s).
          // Keep the stored user fresh so index/login routing uses the latest stage.
          await authStorage.updateUser(u);
          if (u.onboardingComplete) {
            router.replace("/(main)/messages" as any);
            return;
          }

          setCurrentUser(u);
          setFullName(u.full_name || "");
          setOrgName(u.organization || "");
          if (u.username) setUsername(u.username);
          if (u.phone_number) setPhone(u.phone_number);
          if (u.bio) setBio(u.bio);
          if (u.org_role) setRole(u.org_role);
          if (u.avatar) setSelectedAvatar(u.avatar);
          if (u.org_industry) setOrgIndustry(u.org_industry);
          if (u.org_size) setOrgSize(u.org_size);

          // Resume the wizard at the step the backend says the user is on.
          // 'awaiting_org' means profile was saved before — jump straight to org setup.
          if (u.onboardingStep === "awaiting_org") {
            setStep(2);
          }

          // ── Hydrate any locally-saved draft (form fields the user typed but
          // never submitted). Draft fields win over server values only when they
          // contain something. pendingFiles intentionally excluded — file URIs
          // from DocumentPicker are ephemeral and won't survive an app restart.
          const userKey = u.id || u._id || u.email || "anon";
          draftUserKeyRef.current = userKey;
          try {
            const raw = await AsyncStorage.getItem(draftKeyFor(userKey));
            if (raw) {
              const d = JSON.parse(raw);
              if (typeof d.fullName === "string" && d.fullName) setFullName(d.fullName);
              if (typeof d.username === "string" && d.username) setUsername(d.username);
              if (typeof d.phone === "string" && d.phone) setPhone(d.phone);
              if (typeof d.bio === "string" && d.bio) setBio(d.bio);
              if (typeof d.role === "string" && d.role) setRole(d.role);
              if (typeof d.selectedAvatar === "string" && d.selectedAvatar) setSelectedAvatar(d.selectedAvatar);
              if (typeof d.orgName === "string" && d.orgName) setOrgName(d.orgName);
              if (typeof d.orgIndustry === "string" && d.orgIndustry) setOrgIndustry(d.orgIndustry);
              if (d.orgSize) setOrgSize(d.orgSize);
              if (typeof d.businessDesc === "string" && d.businessDesc) setBusinessDesc(d.businessDesc);
              if (typeof d.docTitle === "string") setDocTitle(d.docTitle);
              if (typeof d.docContent === "string") setDocContent(d.docContent);
              if (Array.isArray(d.documents)) setDocuments(d.documents);
              if (Array.isArray(d.pendingUrls)) setPendingUrls(d.pendingUrls);
              if (typeof d.urlInput === "string") setUrlInput(d.urlInput);
              if (typeof d.urlTitleInput === "string") setUrlTitleInput(d.urlTitleInput);
              if (d.step === 2 || d.step === 3) setStep(d.step);
            }
          } catch {
            // Corrupt draft — ignore. Worst case is the user re-types.
          }
        }
      } catch (err: any) {
        setError("Could not load user profile details.");
      } finally {
        setLoadingProfile(false);
        hydratedRef.current = true;
      }
    }
    loadUser();
  }, []);

  // Auto-save the draft to AsyncStorage on every meaningful change. Skipped
  // until hydration completes so we never overwrite a saved draft with empties.
  useEffect(() => {
    if (!hydratedRef.current || !draftUserKeyRef.current) return;
    const draft = {
      fullName, username, phone, bio, role, selectedAvatar,
      orgName, orgIndustry, orgSize, businessDesc,
      docTitle, docContent, documents,
      pendingUrls, urlInput, urlTitleInput,
      step,
    };
    AsyncStorage.setItem(draftKeyFor(draftUserKeyRef.current), JSON.stringify(draft)).catch(() => {});
  }, [
    fullName, username, phone, bio, role, selectedAvatar,
    orgName, orgIndustry, orgSize, businessDesc,
    docTitle, docContent, documents,
    pendingUrls, urlInput, urlTitleInput,
    step,
  ]);

  // Wipe the draft once setup truly succeeds, so the next account starts clean.
  const clearDraft = async () => {
    if (!draftUserKeyRef.current) return;
    try { await AsyncStorage.removeItem(draftKeyFor(draftUserKeyRef.current)); } catch {}
  };

  const generateUsername = () => {
    const base = fullName.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 10) || "bubble";
    const rand = Math.floor(1000 + Math.random() * 9000);
    setUsername(`${base}_${rand}`);
    setError("");
  };

  const handleNextStep1 = () => {
    setError("");
    if (!fullName.trim()) {
      setError("Please enter your full name.");
      return;
    }
    if (!username.trim()) {
      setError("Please enter a username.");
      return;
    }
    if (username.trim().length < 3) {
      setError("Username must be at least 3 characters.");
      return;
    }

    if (currentUser?.role === "admin") {
      setStep(2);
    } else {
      handleCompleteEmployee();
    }
  };

  const handleCompleteEmployee = async () => {
    setError("");
    setLoading(true);
    try {
      const res = await setupProfile({
        full_name: fullName.trim(),
        username: username.trim().toLowerCase(),
        phone_number: phone.trim() || undefined,
        bio: bio.trim(),
        org_role: role || undefined,
        avatar: selectedAvatar,
        onboardingComplete: true,
      });

      if (res?.data) {
        await authStorage.updateUser(res.data);
      }
      await clearDraft();
      setStep(4);
    } catch (err: any) {
      setError(err.message || "Failed to save profile. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleNextStep2 = () => {
    setError("");
    if (!orgName.trim()) {
      setError("Please enter organization name.");
      return;
    }
    if (!businessDesc.trim() || businessDesc.trim().length < 10) {
      setError("Please write a detailed business description (min 10 characters).");
      return;
    }
    setStep(3);
  };

  const handleAddDocument = () => {
    setError("");
    if (!docTitle.trim() || !docContent.trim()) {
      setError("Document title and content are required.");
      return;
    }
    setDocuments(prev => [...prev, { title: docTitle.trim(), content: docContent.trim() }]);
    setDocTitle("");
    setDocContent("");
  };

  const handleRemoveDocument = (idx: number) => {
    setDocuments(prev => prev.filter((_, i) => i !== idx));
  };

  // Pick one or more PDF/TXT/MD files to queue for ingestion.
  const handlePickFiles = async () => {
    setError("");
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          "application/pdf",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "text/plain", "text/markdown", "text/csv",
        ],
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const picked = (result.assets || []).map(a => ({
        uri: a.uri,
        name: a.name || "document",
        type: a.mimeType || "application/octet-stream",
      }));
      setPendingFiles(prev => [...prev, ...picked]);
    } catch (err: any) {
      setError(err.message || "Could not open the document picker.");
    }
  };

  const handleRemoveFile = (idx: number) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== idx));
  };

  // Queue a YouTube / web URL — extraction happens on the server during onboarding.
  const handleAddUrl = () => {
    setError("");
    const url = urlInput.trim();
    if (!url) {
      setError("Paste a URL (YouTube, ChatGPT share link, article, etc.) to add it.");
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      setError("URL must start with http:// or https://");
      return;
    }
    setPendingUrls(prev => [...prev, { url, title: urlTitleInput.trim() }]);
    setUrlInput("");
    setUrlTitleInput("");
  };

  const handleRemoveUrl = (idx: number) => {
    setPendingUrls(prev => prev.filter((_, i) => i !== idx));
  };

  const handleCompleteAdmin = async () => {
    setError("");
    setLoading(true);
    try {
      // 1. Setup profile info
      const profileRes = await setupProfile({
        full_name: fullName.trim(),
        username: username.trim().toLowerCase(),
        phone_number: phone.trim() || undefined,
        bio: bio.trim(),
        avatar: selectedAvatar,
        organization: orgName.trim(),
        org_role: role || "CEO",
        org_industry: orgIndustry || undefined,
        org_size: orgSize || undefined,
        onboardingComplete: true,
      });

      // 2. Onboard AI Brain
      const brainRes = await onboardOrgBrain(businessDesc.trim());
      const inviteCodeVal = brainRes?.organization?.inviteCode || "";
      setInviteCode(inviteCodeVal);

      // 3. Drain all three brain-ingestion queues. Partial failures are reported
      // but do not abort the whole flow — onboarding is the priority.
      const ingestionFailures: string[] = [];
      let embedWarnings = 0; // saved but not embedded (searchable)
      const totalAssets = documents.length + pendingFiles.length + pendingUrls.length;
      let done = 0;

      for (const doc of documents) {
        done++;
        setIngestProgress(`Ingesting ${done}/${totalAssets}: ${doc.title}`);
        try {
          const r = await ingestOrgDocument({
            title: doc.title,
            content: doc.content,
            department: "general",
            accessLevel: "public",
            tags: ["onboarding", "mobile-text"],
          });
          if (r?.warning) embedWarnings++;
        } catch (e: any) {
          ingestionFailures.push(`text "${doc.title}"`);
        }
      }

      for (const f of pendingFiles) {
        done++;
        setIngestProgress(`Ingesting ${done}/${totalAssets}: ${f.name}`);
        try {
          const r = await ingestOrgDocumentFromFile({
            file: f,
            department: "general",
            accessLevel: "public",
            tags: ["onboarding", "mobile-file"],
          });
          if (r?.warning) embedWarnings++;
        } catch (e: any) {
          ingestionFailures.push(`file "${f.name}"`);
        }
      }

      for (const u of pendingUrls) {
        done++;
        setIngestProgress(`Ingesting ${done}/${totalAssets}: ${u.title || u.url}`);
        try {
          const r = await ingestOrgDocumentFromUrl({
            url: u.url,
            title: u.title || undefined,
            department: "general",
            accessLevel: "public",
            tags: ["onboarding", "mobile-url"],
          });
          if (r?.warning) embedWarnings++;
        } catch (e: any) {
          ingestionFailures.push(`url "${u.url}"`);
        }
      }

      setIngestProgress("");

      if (profileRes?.data) {
        await authStorage.updateUser(profileRes.data);
      }

      if (ingestionFailures.length > 0) {
        setError(`Workspace created, but ${ingestionFailures.length} item(s) could not be ingested: ${ingestionFailures.join(", ")}. You can re-add them later in the Brain section.`);
      } else if (embedWarnings > 0) {
        setError(`Workspace created, but ${embedWarnings} item(s) were saved without being made searchable (embeddings unavailable). Aida can't recall them yet — re-add later from the Brain section.`);
      }

      await clearDraft();
      setStep(4);
    } catch (err: any) {
      setError(err.message || "Failed to onboard organization. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleCopyCode = () => {
    if (!inviteCode) return;
    Clipboard.setString(inviteCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleCopyLink = () => {
    const link = `https://bubblespace.app/signup?inviteCode=${inviteCode}`;
    Clipboard.setString(link);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const handleEnterWorkspace = () => {
    router.replace("/(main)/messages" as any);
  };

  if (loadingProfile) {
    return (
      <View style={{ flex: 1, backgroundColor: BG, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" color={PURPLE} />
        <Text style={{ marginTop: 14, fontFamily: "Poppins_500Medium", color: INK_SOFT, fontSize: 14 }}>
          Loading profile settings...
        </Text>
      </View>
    );
  }

  const isAdmin = currentUser?.role === "admin";
  const totalSteps = isAdmin ? 3 : 1;

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

          {/* Header Progress indicator (only on steps 1-3) */}
          {step <= 3 && (
            <View style={styles.header}>
              <View style={styles.progressRow}>
                {Array.from({ length: totalSteps }).map((_, i) => {
                  const stepNum = i + 1;
                  const isActive = step === stepNum;
                  const isDone = step > stepNum;
                  return (
                    <React.Fragment key={stepNum}>
                      <View style={[
                        styles.progressStep,
                        isActive && styles.progressActive,
                        isDone && styles.progressDone,
                      ]}>
                        {isDone ? (
                          <Check size={10} color="#fff" />
                        ) : (
                          <Text style={[styles.progressStepText, isActive && { color: "#fff" }]}>
                            {stepNum}
                          </Text>
                        )}
                      </View>
                      {stepNum < totalSteps && (
                        <View style={[styles.progressLine, isDone && styles.progressLineDone]} />
                      )}
                    </React.Fragment>
                  );
                })}
              </View>
              <Text style={styles.wizardLabel}>
                {step === 1 ? "Step 1: Personal Profile" : step === 2 ? "Step 2: Business Info" : "Step 3: Train AI Brain"}
              </Text>
            </View>
          )}

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {/* STEP 1: Personal Details */}
          {step === 1 && (
            <View style={styles.stepContent}>
              <Text style={styles.title}>Your Profile Details</Text>
              <Text style={styles.subtitle}>Bubble up your profile with your info and select an avatar 🫧</Text>

              {/* Avatar Picker */}
              <View style={styles.avatarSection}>
                <View style={styles.avatarMainBorder}>
                  <Image source={{ uri: selectedAvatar }} style={styles.avatarMain} />
                  <View style={styles.cameraBadge}>
                    <Camera size={14} color="#fff" />
                  </View>
                </View>
                <Text style={styles.avatarLabel}>Choose an Avatar</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.avatarGrid}>
                  {AVATARS.map((url) => {
                    const isSel = selectedAvatar === url;
                    return (
                      <TouchableOpacity
                        key={url}
                        onPress={() => setSelectedAvatar(url)}
                        style={[styles.avatarThumbnailWrap, isSel && styles.avatarThumbnailActive]}
                      >
                        <Image source={{ uri: url }} style={styles.avatarThumbnail} />
                        {isSel && (
                          <View style={styles.avatarCheckBadge}>
                            <Check size={10} color="#fff" />
                          </View>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>

              {/* Fields */}
              <Field label="Full Name" icon={<User size={16} color={INK_SOFT} />}>
                <TextInput
                  value={fullName}
                  onChangeText={(t) => { setFullName(t); setError(""); }}
                  placeholder="John Doe"
                  placeholderTextColor="#b0b4c6"
                  style={styles.input}
                />
              </Field>

              <Field label="Username" icon={<Globe size={16} color={INK_SOFT} />} extra={
                <TouchableOpacity onPress={generateUsername} style={styles.generateBtn}>
                  <Sparkles size={12} color={PURPLE} style={{ marginRight: 4 }} />
                  <Text style={styles.generateBtnText}>Auto</Text>
                </TouchableOpacity>
              }>
                <TextInput
                  value={username}
                  onChangeText={(t) => { setUsername(t.toLowerCase().replace(/[^a-z0-9_]/g, "")); setError(""); }}
                  placeholder="john_doe"
                  placeholderTextColor="#b0b4c6"
                  autoCapitalize="none"
                  style={[styles.input, { flex: 1 }]}
                />
              </Field>

              <Field label="Phone Number" icon={<MapPin size={16} color={INK_SOFT} />}>
                <TextInput
                  value={phone}
                  onChangeText={(t) => { setPhone(t); setError(""); }}
                  placeholder="+1 234 567 890"
                  keyboardType="phone-pad"
                  placeholderTextColor="#b0b4c6"
                  style={styles.input}
                />
              </Field>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>BIO / Tagline</Text>
                <View style={styles.textAreaRow}>
                  <FileText size={16} color={INK_SOFT} style={{ marginRight: 10, marginTop: 2 }} />
                  <TextInput
                    value={bio}
                    onChangeText={setBio}
                    placeholder="Short description of what you do..."
                    placeholderTextColor="#b0b4c6"
                    multiline
                    numberOfLines={3}
                    maxLength={200}
                    style={styles.textArea}
                  />
                </View>
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Your Role</Text>
                <View style={styles.rolesContainer}>
                  {ROLE_OPTIONS.map((opt) => {
                    const isSel = role === opt;
                    return (
                      <TouchableOpacity
                        key={opt}
                        onPress={() => setRole(opt)}
                        style={[styles.roleChip, isSel && styles.roleChipActive]}
                      >
                        <Text style={[styles.roleChipText, isSel && styles.roleChipTextActive]}>{opt}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <TouchableOpacity
                onPress={handleNextStep1}
                disabled={loading}
                style={[styles.primaryBtn, loading && { opacity: 0.7 }]}
              >
                {loading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <Text style={styles.primaryBtnText}>
                      {isAdmin ? "Continue to Org Info" : "Complete Profile Setup"}
                    </Text>
                    <ChevronRight size={18} color="#fff" style={{ marginLeft: 6 }} />
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}

          {/* STEP 2: Business Info (Admin only) */}
          {step === 2 && (
            <View style={styles.stepContent}>
              <TouchableOpacity onPress={() => setStep(1)} style={styles.backLink}>
                <ArrowLeft size={16} color={PURPLE} />
                <Text style={styles.backLinkLabel}>Personal Profile</Text>
              </TouchableOpacity>

              <Text style={styles.title}>Configure Organization</Text>
              <Text style={styles.subtitle}>Define your workspace settings and describe your organization 🏢</Text>

              <Field label="Organization Name" icon={<Briefcase size={16} color={INK_SOFT} />}>
                <TextInput
                  value={orgName}
                  onChangeText={(t) => { setOrgName(t); setError(""); }}
                  placeholder="Acme Corp"
                  placeholderTextColor="#b0b4c6"
                  style={styles.input}
                />
              </Field>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Workspace Industry</Text>
                <View style={styles.rolesContainer}>
                  {INDUSTRIES.map((ind) => {
                    const isSel = orgIndustry === ind;
                    return (
                      <TouchableOpacity
                        key={ind}
                        onPress={() => setOrgIndustry(ind)}
                        style={[styles.roleChip, isSel && styles.roleChipActive]}
                      >
                        <Text style={[styles.roleChipText, isSel && styles.roleChipTextActive]}>{ind}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Team Size</Text>
                <View style={styles.rolesContainer}>
                  {ORG_SIZES.map((sz) => {
                    const isSel = orgSize === sz;
                    return (
                      <TouchableOpacity
                        key={sz}
                        onPress={() => setOrgSize(sz)}
                        style={[styles.roleChip, isSel && styles.roleChipActive]}
                      >
                        <Text style={[styles.roleChipText, isSel && styles.roleChipTextActive]}>{sz}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Detailed Company Description</Text>
                <Text style={styles.helpText}>
                  Aida, your workspace bot, will study this description to automatically answer team questions and index workspace materials.
                </Text>
                <View style={styles.textAreaRow}>
                  <FileText size={16} color={INK_SOFT} style={{ marginRight: 10, marginTop: 2 }} />
                  <TextInput
                    value={businessDesc}
                    onChangeText={(t) => { setBusinessDesc(t); setError(""); }}
                    placeholder="We build web & mobile applications for logistics teams. We are based in SF with a remote team..."
                    placeholderTextColor="#b0b4c6"
                    multiline
                    numberOfLines={4}
                    style={styles.textArea}
                  />
                </View>
              </View>

              <TouchableOpacity
                onPress={handleNextStep2}
                style={styles.primaryBtn}
              >
                <Text style={styles.primaryBtnText}>Continue to Knowledge Setup</Text>
                <ChevronRight size={18} color="#fff" style={{ marginLeft: 6 }} />
              </TouchableOpacity>
            </View>
          )}

          {/* STEP 3: Train AI Brain (Admin only) */}
          {step === 3 && (
            <View style={styles.stepContent}>
              <TouchableOpacity onPress={() => setStep(2)} style={styles.backLink}>
                <ArrowLeft size={16} color={PURPLE} />
                <Text style={styles.backLinkLabel}>Organization Info</Text>
              </TouchableOpacity>

              <Text style={styles.title}>Train Workspace Brain</Text>
              <Text style={styles.subtitle}>Add documents, policies, or guidelines to initialize the collective team knowledge base 🧠</Text>

              <View style={styles.documentForm}>
                <Text style={styles.formSubLabel}>Quick Upload Text Document</Text>
                <TextInput
                  value={docTitle}
                  onChangeText={setDocTitle}
                  placeholder="e.g. Employee Handbook, Mission, Tech Stack"
                  placeholderTextColor="#b0b4c6"
                  style={styles.docTitleInput}
                />
                <TextInput
                  value={docContent}
                  onChangeText={setDocContent}
                  placeholder="Paste or write document details here..."
                  placeholderTextColor="#b0b4c6"
                  multiline
                  numberOfLines={4}
                  style={styles.docContentInput}
                />
                <TouchableOpacity onPress={handleAddDocument} style={styles.addDocBtn}>
                  <Plus size={16} color="#fff" style={{ marginRight: 6 }} />
                  <Text style={styles.addDocBtnText}>Add Document to Brain</Text>
                </TouchableOpacity>
              </View>

              {/* ── File Upload (PDF / TXT / MD) ── */}
              <View style={styles.documentForm}>
                <Text style={styles.formSubLabel}>Upload Files (PDF, TXT, MD)</Text>
                <Text style={styles.helpText}>Pick one or more documents — handbooks, briefs, policies, transcripts.</Text>
                <TouchableOpacity onPress={handlePickFiles} style={styles.addDocBtn}>
                  <Plus size={16} color="#fff" style={{ marginRight: 6 }} />
                  <Text style={styles.addDocBtnText}>Pick Files</Text>
                </TouchableOpacity>
              </View>

              {pendingFiles.length > 0 && (
                <View style={styles.documentListSection}>
                  <Text style={styles.label}>Files Queued ({pendingFiles.length})</Text>
                  {pendingFiles.map((f, idx) => (
                    <View key={idx} style={styles.docCard}>
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <Text style={styles.docCardTitle} numberOfLines={1}>{f.name}</Text>
                        <Text style={styles.docCardSnippet} numberOfLines={1}>{f.type}</Text>
                      </View>
                      <TouchableOpacity onPress={() => handleRemoveFile(idx)} style={styles.deleteDocBtn}>
                        <Trash2 size={16} color="red" />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              )}

              {/* ── URL / YouTube / Article Link ── */}
              <View style={styles.documentForm}>
                <Text style={styles.formSubLabel}>Import from URL</Text>
                <Text style={styles.helpText}>
                  Paste a YouTube link (we fetch the transcript), a ChatGPT share link, or any public article URL.
                </Text>
                <TextInput
                  value={urlTitleInput}
                  onChangeText={setUrlTitleInput}
                  placeholder="Optional title (e.g. Q3 Strategy Talk)"
                  placeholderTextColor="#b0b4c6"
                  style={styles.docTitleInput}
                />
                <TextInput
                  value={urlInput}
                  onChangeText={setUrlInput}
                  placeholder="https://youtube.com/watch?v=…  or  https://…"
                  placeholderTextColor="#b0b4c6"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  style={styles.docTitleInput}
                />
                <TouchableOpacity onPress={handleAddUrl} style={styles.addDocBtn}>
                  <Plus size={16} color="#fff" style={{ marginRight: 6 }} />
                  <Text style={styles.addDocBtnText}>Add URL to Brain</Text>
                </TouchableOpacity>
              </View>

              {pendingUrls.length > 0 && (
                <View style={styles.documentListSection}>
                  <Text style={styles.label}>URLs Queued ({pendingUrls.length})</Text>
                  {pendingUrls.map((u, idx) => (
                    <View key={idx} style={styles.docCard}>
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <Text style={styles.docCardTitle} numberOfLines={1}>{u.title || u.url}</Text>
                        <Text style={styles.docCardSnippet} numberOfLines={1}>{u.url}</Text>
                      </View>
                      <TouchableOpacity onPress={() => handleRemoveUrl(idx)} style={styles.deleteDocBtn}>
                        <Trash2 size={16} color="red" />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              )}

              {/* Document List (pasted text) */}
              {documents.length > 0 && (
                <View style={styles.documentListSection}>
                  <Text style={styles.label}>Documents to Ingest ({documents.length})</Text>
                  {documents.map((doc, idx) => (
                    <View key={idx} style={styles.docCard}>
                      <View style={{ flex: 1, marginRight: 8 }}>
                        <Text style={styles.docCardTitle} numberOfLines={1}>{doc.title}</Text>
                        <Text style={styles.docCardSnippet} numberOfLines={1}>{doc.content}</Text>
                      </View>
                      <TouchableOpacity onPress={() => handleRemoveDocument(idx)} style={styles.deleteDocBtn}>
                        <Trash2 size={16} color="red" />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              )}

              {ingestProgress ? (
                <Text style={[styles.helpText, { textAlign: "center", marginTop: 8 }]}>{ingestProgress}</Text>
              ) : null}

              <TouchableOpacity
                onPress={handleCompleteAdmin}
                disabled={loading}
                style={[styles.primaryBtn, loading && { opacity: 0.7 }]}
              >
                {loading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <Text style={styles.primaryBtnText}>Onboard & Create Workspace</Text>
                    <Check size={18} color="#fff" style={{ marginLeft: 6 }} />
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}

          {/* STEP 4: Success Screen */}
          {step === 4 && (
            <View style={[styles.stepContent, { alignItems: "center", paddingTop: 40 }]}>
              <View style={styles.successCheckWrap}>
                <Check size={40} color="#fff" strokeWidth={3} />
              </View>

              <Text style={styles.successTitle}>
                {isAdmin ? "Workspace Created!" : "Profile Complete!"}
              </Text>
              <Text style={styles.successSubtitle}>
                {isAdmin
                  ? `Your organization "${orgName}" is fully onboarded. Share the invite code below to bring in your team.`
                  : "Welcome to Bubble Space! You have successfully completed your profile. Enter to start chatting."}
              </Text>

              {isAdmin && inviteCode && (
                <View style={styles.inviteContainer}>
                  <Text style={styles.inviteLabel}>WORKSPACE INVITE CODE</Text>
                  <View style={{ backgroundColor: '#ffffff', borderWidth: 1, borderColor: 'rgba(108,92,231,0.15)', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12, marginBottom: 18, width: '100%', alignItems: 'center' }}>
                    <Text style={{ fontSize: 13, fontFamily: 'SpaceGrotesk_700Bold', color: PURPLE, letterSpacing: 0.5 }} numberOfLines={1}>
                      {inviteCode}
                    </Text>
                  </View>

                  <View style={styles.successActions}>
                    <TouchableOpacity
                      onPress={handleCopyCode}
                      style={[styles.actionBtn, copiedCode && styles.actionBtnSuccess]}
                    >
                      <Copy size={16} color={copiedCode ? "#fff" : PURPLE} style={{ marginRight: 6 }} />
                      <Text style={[styles.actionBtnText, copiedCode && { color: "#fff" }]}>
                        {copiedCode ? "Copied!" : "Copy Code"}
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      onPress={handleCopyLink}
                      style={[styles.actionBtn, copiedLink && styles.actionBtnSuccess]}
                    >
                      <Share size={16} color={copiedLink ? "#fff" : PURPLE} style={{ marginRight: 6 }} />
                      <Text style={[styles.actionBtnText, copiedLink && { color: "#fff" }]}>
                        {copiedLink ? "Copied!" : "Copy Link"}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              <TouchableOpacity
                onPress={handleEnterWorkspace}
                style={[styles.primaryBtn, { width: "100%", marginTop: 24 }]}
              >
                <Text style={styles.primaryBtnText}>Enter Bubble Space</Text>
                <ChevronRight size={18} color="#fff" style={{ marginLeft: 6 }} />
              </TouchableOpacity>
            </View>
          )}

        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, icon, extra, children }: { label: string; icon: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.inputRow}>
        <View style={{ marginRight: 10 }}>{icon}</View>
        {children}
        {extra}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#ffffff" },
  inner: { flex: 1, paddingHorizontal: 24, paddingTop: 40, paddingBottom: 40 },
  header: { marginBottom: 30, alignItems: "center" },
  progressRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", marginBottom: 12 },
  progressStep: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#e5e7eb",
    alignItems: "center",
    justifyContent: "center",
  },
  progressStepText: { fontSize: 11, fontFamily: "Poppins_600SemiBold", color: "#6b7280" },
  progressActive: { backgroundColor: PURPLE },
  progressDone: { backgroundColor: "#10b981" },
  progressLine: { width: 44, height: 3, backgroundColor: "#e5e7eb" },
  progressLineDone: { backgroundColor: "#10b981" },
  wizardLabel: { fontSize: 12, fontFamily: "Poppins_600SemiBold", color: INK_SOFT, textTransform: "uppercase", letterSpacing: 0.8 },
  stepContent: { flex: 1 },
  title: { fontSize: 26, fontFamily: "SpaceGrotesk_700Bold", color: INK, marginBottom: 8, textAlign: "center" },
  subtitle: { fontSize: 13.5, fontFamily: "Poppins_400Regular", color: INK_SOFT, textAlign: "center", lineHeight: 20, marginBottom: 28, paddingHorizontal: 6 },
  errorBox: { backgroundColor: "#fef2f2", borderRadius: 14, padding: 12, borderWidth: 1, borderColor: "#fecaca", marginBottom: 20 },
  errorText: { color: "#dc2626", fontSize: 13, fontFamily: "Poppins_500Medium", textAlign: "center" },
  avatarSection: { alignItems: "center", marginBottom: 24 },
  avatarMainBorder: {
    width: 90,
    height: 90,
    borderRadius: 45,
    borderWidth: 3,
    borderColor: PURPLE_SOFT,
    position: "relative",
    marginBottom: 8,
  },
  avatarMain: { width: 84, height: 84, borderRadius: 42 },
  cameraBadge: {
    position: "absolute",
    bottom: -2,
    right: -2,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: PURPLE,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#fff",
  },
  avatarLabel: { fontSize: 12, fontFamily: "Poppins_600SemiBold", color: INK_SOFT, marginBottom: 12 },
  avatarGrid: { gap: 10, paddingHorizontal: 10, paddingVertical: 4 },
  avatarThumbnailWrap: {
    width: 50,
    height: 50,
    borderRadius: 25,
    position: "relative",
    borderWidth: 2,
    borderColor: "transparent",
  },
  avatarThumbnailActive: { borderColor: PURPLE },
  avatarThumbnail: { width: 46, height: 46, borderRadius: 23 },
  avatarCheckBadge: {
    position: "absolute",
    bottom: -2,
    right: -2,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "#10b981",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#fff",
  },
  fieldGroup: { marginBottom: 18 },
  label: { fontSize: 11.5, fontFamily: "Poppins_700Bold", color: INK_SOFT, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f3f4f6",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === "ios" ? 13 : 8,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  input: { flex: 1, fontSize: 14.5, fontFamily: "Poppins_500Medium", color: INK, padding: 0 },
  generateBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: PURPLE_SOFT,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  generateBtnText: { fontSize: 11, fontFamily: "Poppins_700Bold", color: PURPLE },
  textAreaRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: "#f3f4f6",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  textArea: { flex: 1, fontSize: 14.5, fontFamily: "Poppins_500Medium", color: INK, minHeight: 70, padding: 0, textAlignVertical: "top" },
  rolesContainer: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  roleChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: "#e5e7eb",
    backgroundColor: "#f9fafb",
  },
  roleChipActive: { backgroundColor: PURPLE, borderColor: PURPLE },
  roleChipText: { fontSize: 12.5, fontFamily: "Poppins_600SemiBold", color: "#6b7280" },
  roleChipTextActive: { color: "#fff" },
  primaryBtn: {
    backgroundColor: PURPLE,
    paddingVertical: 16,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    shadowColor: PURPLE,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 6,
    marginTop: 12,
  },
  primaryBtnText: { color: "#fff", fontFamily: "Poppins_700Bold", fontSize: 15.5 },
  backLink: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", marginBottom: 20, gap: 4 },
  backLinkLabel: { fontSize: 13, fontFamily: "Poppins_600SemiBold", color: PURPLE },
  helpText: { fontSize: 12, fontFamily: "Poppins_400Regular", color: INK_SOFT, lineHeight: 18, marginBottom: 8 },
  documentForm: {
    backgroundColor: "#fdfdfd",
    borderWidth: 1,
    borderColor: "rgba(108,92,231,0.12)",
    borderRadius: 20,
    padding: 16,
    marginBottom: 20,
  },
  formSubLabel: { fontSize: 12.5, fontFamily: "Poppins_700Bold", color: INK, marginBottom: 10 },
  docTitleInput: {
    backgroundColor: "#f3f4f6",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13.5,
    fontFamily: "Poppins_500Medium",
    color: INK,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  docContentInput: {
    backgroundColor: "#f3f4f6",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13.5,
    fontFamily: "Poppins_500Medium",
    color: INK,
    minHeight: 80,
    textAlignVertical: "top",
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  addDocBtn: {
    backgroundColor: PURPLE,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
  },
  addDocBtnText: { color: "#fff", fontFamily: "Poppins_700Bold", fontSize: 12.5 },
  documentListSection: { marginBottom: 20 },
  docCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(108,92,231,0.04)",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "rgba(108,92,231,0.08)",
  },
  docCardTitle: { fontSize: 13.5, fontFamily: "Poppins_600SemiBold", color: INK },
  docCardSnippet: { fontSize: 11.5, fontFamily: "Poppins_400Regular", color: INK_SOFT, marginTop: 1 },
  deleteDocBtn: { padding: 4 },
  successCheckWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "#10b981",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
    shadowColor: "#10b981",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 8,
  },
  successTitle: { fontSize: 28, fontFamily: "SpaceGrotesk_700Bold", color: INK, marginBottom: 12 },
  successSubtitle: { fontSize: 14, fontFamily: "Poppins_400Regular", color: INK_SOFT, textAlign: "center", lineHeight: 22, paddingHorizontal: 14, marginBottom: 20 },
  inviteContainer: {
    width: "100%",
    backgroundColor: "rgba(108,92,231,0.04)",
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "rgba(108,92,231,0.1)",
    padding: 20,
    alignItems: "center",
    marginTop: 10,
  },
  inviteLabel: { fontSize: 10.5, fontFamily: "Poppins_700Bold", color: INK_SOFT, letterSpacing: 1, marginBottom: 12 },
  codeRow: { flexDirection: "row", gap: 6, marginBottom: 18 },
  codeCharBox: {
    width: 34,
    height: 40,
    borderRadius: 8,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "rgba(108,92,231,0.15)",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: PURPLE,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  codeCharText: { fontSize: 18, fontFamily: "SpaceGrotesk_700Bold", color: PURPLE },
  successActions: { flexDirection: "row", gap: 10, width: "100%" },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffffff",
    borderWidth: 1.5,
    borderColor: "rgba(108,92,231,0.2)",
    paddingVertical: 12,
    borderRadius: 14,
  },
  actionBtnSuccess: {
    backgroundColor: "#10b981",
    borderColor: "#10b981",
  },
  actionBtnText: { fontSize: 13, fontFamily: "Poppins_700Bold", color: PURPLE },
});
