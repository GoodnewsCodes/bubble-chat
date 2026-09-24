import React, { useRef, useState, useEffect } from "react";
import {
  Text,
  View,
  TouchableOpacity,
  Dimensions,
  ScrollView,
  StyleSheet,
  StatusBar,
  Animated,
} from "react-native";
import { useRouter } from "expo-router";
import {
  Bot,
  Phone,
  Mic,
  Volume2,
  Folder,
  Send,
  Sparkles,
  ChevronRight,
} from "lucide-react-native";
import { authStorage } from "../lib/authStorage";

const { width: W, height: H } = Dimensions.get("window");

const PURPLE = "#6c5ce7";
const PURPLE_SOFT = "rgba(108,92,231,0.08)";
const BG_LIGHT = "#ffffff";
const CARD_BG = "#f8f9fc";
const INK_DARK = "#1f2030";
const INK_SOFT = "#7d7e96";

const SLIDES = [
  {
    title: "Connect in Real-Time",
    subtitle: "Communicate with your organization through secure channels and DMs.",
    type: "chat",
  },
  {
    title: "AI-Powered Workspaces",
    subtitle: "Organize tasks and get smart summaries of your channels with Aida.",
    type: "workspace",
  },
  {
    title: "High-Quality Call Parity",
    subtitle: "Experience crystal-clear voice and video calls with picture-in-picture mode.",
    type: "call",
  },
];

export default function Splash() {
  const router = useRouter();
  const scrollRef = useRef<ScrollView>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // Micro-animation values
  const arrowAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    // Arrow slide animation
    Animated.loop(
      Animated.sequence([
        Animated.timing(arrowAnim, {
          toValue: 6,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(arrowAnim, {
          toValue: 0,
          duration: 800,
          useNativeDriver: true,
        }),
      ])
    ).start();

    // Pulse animation for call mockup
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.15,
          duration: 1200,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1200,
          useNativeDriver: true,
        }),
      ])
    ).start();
  }, []);

  const handleScroll = (e: any) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / W);
    setActiveIndex(idx);
  };

  const handleGetStarted = async () => {
    await authStorage.setOnboardingSeen();
    router.push("/signup" as any);
  };

  const handleLogin = async () => {
    await authStorage.setOnboardingSeen();
    router.push("/login" as any);
  };

  // Mock phone renderer based on slide type (Light Mode)
  const renderPhoneMockup = (type: string) => {
    if (type === "chat") {
      return (
        <View style={styles.mockPhoneInner}>
          {/* Dynamic Island */}
          <View style={styles.dynamicIsland} />
          {/* Mock Header */}
          <View style={styles.mockHeader}>
            <View style={styles.mockHeaderDot} />
            <Text style={styles.mockHeaderText}>Marketing Room</Text>
          </View>
          {/* Mock Chat Thread */}
          <View style={styles.mockChatList}>
            {/* Bubble 1 */}
            <View style={styles.chatRowLeft}>
              <View style={[styles.miniAvatar, { backgroundColor: "#3b82f6" }]}>
                <Text style={styles.miniAvatarText}>AL</Text>
              </View>
              <View style={styles.chatBubbleLeft}>
                <Text style={styles.chatTextLeft}>Let's review the final slides for the presentation today.</Text>
              </View>
            </View>
            {/* Bubble 2 */}
            <View style={styles.chatRowRight}>
              <View style={styles.chatBubbleRight}>
                <Text style={styles.chatTextRight}>Sure! Uploaded them to the Product Workspace. 🚀</Text>
              </View>
            </View>
            {/* Bubble 3 (Aida) */}
            <View style={styles.chatRowLeft}>
              <View style={[styles.miniAvatar, { backgroundColor: PURPLE }]}>
                <Bot size={11} color="#ffffff" />
              </View>
              <View style={[styles.chatBubbleLeft, { borderColor: "rgba(108,92,231,0.2)", borderWidth: 1, backgroundColor: "rgba(108,92,231,0.03)" }]}>
                <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 2 }}>
                  <Sparkles size={10} color={PURPLE} style={{ marginRight: 3 }} />
                  <Text style={{ fontSize: 9, fontFamily: "Poppins_700Bold", color: PURPLE }}>Aida AI</Text>
                </View>
                <Text style={styles.chatTextLeft}>Summarized key slides into 3 action points.</Text>
              </View>
            </View>
          </View>
          {/* Mock Input Bar */}
          <View style={styles.mockInputBar}>
            <View style={styles.mockTextInputPlaceholder} />
            <View style={styles.mockSendBtn}>
              <Send size={10} color="#ffffff" />
            </View>
          </View>
        </View>
      );
    }

    if (type === "workspace") {
      return (
        <View style={styles.mockPhoneInner}>
          <View style={styles.dynamicIsland} />
          {/* Mock Header */}
          <View style={styles.mockHeader}>
            <View style={styles.mockHeaderDot} />
            <Text style={styles.mockHeaderText}>Bubble Space</Text>
          </View>
          {/* Mock Dashboard */}
          <View style={{ padding: 12, gap: 10, flex: 1 }}>
            <Text style={styles.mockSectionTitle}>WORKSPACES</Text>
            {/* Folder 1 */}
            <View style={styles.workspaceCard}>
              <View style={styles.workspaceIconWrapper}>
                <Folder size={16} color={PURPLE} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.workspaceName}>Product Design</Text>
                <Text style={styles.workspaceMeta}>4 members • 12 files</Text>
              </View>
            </View>
            {/* Folder 2 */}
            <View style={styles.workspaceCard}>
              <View style={[styles.workspaceIconWrapper, { backgroundColor: "rgba(14,165,233,0.08)" }]}>
                <Folder size={16} color="#0ea5e9" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.workspaceName}>Engineering Hub</Text>
                <Text style={styles.workspaceMeta}>8 members • 45 files</Text>
              </View>
            </View>
            {/* AI Assistant Card */}
            <View style={styles.aiWorkspaceCard}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <Sparkles size={14} color={PURPLE} />
                <Text style={styles.aiWorkspaceTitle}>Aida Active</Text>
              </View>
              <Text style={styles.aiWorkspaceBody}>Changelog and release notes extracted successfully.</Text>
            </View>
          </View>
        </View>
      );
    }

    // Call Mockup
    return (
      <View style={[styles.mockPhoneInner, { justifyContent: "center", alignItems: "center" }]}>
        <View style={styles.dynamicIsland} />
        {/* Call Info */}
        <View style={{ alignItems: "center", marginTop: 20 }}>
          <Text style={styles.mockCallType}>VOICE CALL</Text>
          <Text style={styles.mockCallName}>Desmond Ubi</Text>
          <Text style={styles.mockCallStatus}>Active • 00:45</Text>
        </View>

        {/* Pulsing Avatar Frame */}
        <View style={styles.pulsingContainer}>
          <Animated.View style={[styles.pulseRing, { transform: [{ scale: pulseAnim }], opacity: 0.15 }]} />
          <View style={styles.mockCallAvatar}>
            <Text style={styles.mockAvatarText}>DU</Text>
          </View>
        </View>

        {/* Call Actions */}
        <View style={styles.mockCallActions}>
          <View style={styles.mockCallButton}>
            <Mic size={14} color={INK_DARK} />
          </View>
          <View style={[styles.mockCallButton, { backgroundColor: "#ef4444" }]}>
            <Phone size={14} color="#ffffff" style={{ transform: [{ rotate: "135deg" }] }} />
          </View>
          <View style={styles.mockCallButton}>
            <Volume2 size={14} color={INK_DARK} />
          </View>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={BG_LIGHT} />

      {/* Decorative Large Arc Borders (Top & Bottom curves) */}
      <View style={styles.glowTop} />
      <View style={styles.glowBottom} />

      {/* Scrollable Slides containing Phone Mockups & Headings */}
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleScroll}
        scrollEventThrottle={16}
        style={{ flex: 1 }}
      >
        {SLIDES.map((slide, i) => (
          <View key={i} style={[styles.slide, { width: W }]}>
            {/* Phone Mockup Frame wrapper */}
            <View style={styles.phoneMockupFrame}>
              {renderPhoneMockup(slide.type)}
            </View>

            {/* Content Text Block */}
            <View style={styles.textBlock}>
              <Text style={styles.slideTitle}>{slide.title}</Text>
              <Text style={styles.slideSubtitle}>{slide.subtitle}</Text>
            </View>
          </View>
        ))}
      </ScrollView>

      {/* Fixed bottom controls container */}
      <View style={styles.fixedBottomContainer}>
        {/* Pagination Indicators (Dashes) */}
        <View style={styles.dotsRow}>
          {SLIDES.map((s, i) => (
            <View
              key={i}
              style={[
                styles.dot,
                i === activeIndex && { width: 32, backgroundColor: PURPLE },
              ]}
            />
          ))}
        </View>

        {/* Action Buttons */}
        <View style={styles.cta}>
          <TouchableOpacity
            onPress={handleGetStarted}
            activeOpacity={0.88}
            style={styles.btnPrimary}
          >
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Text style={styles.btnPrimaryText}>Create Account</Text>
              <Animated.View style={{ transform: [{ translateX: arrowAnim }] }}>
                <ChevronRight size={18} color="#ffffff" style={{ marginLeft: 4 }} />
              </Animated.View>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleLogin}
            activeOpacity={0.8}
            style={styles.btnSecondary}
          >
            <Text style={styles.btnSecondaryText}>Log In</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BG_LIGHT,
  },
  glowTop: {
    position: "absolute",
    top: -W * 1.85,
    left: -W * 0.5,
    width: W * 2,
    height: W * 2,
    borderRadius: W,
    backgroundColor: "rgba(108,92,231,0.05)",
    zIndex: 0,
  },
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
  slide: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingHorizontal: 28,
    paddingTop: H * 0.08,
  },
  phoneMockupFrame: {
    width: W * 0.75,
    height: H * 0.46,
    borderRadius: 36,
    borderWidth: 6,
    borderColor: "#1f2030", // sleek phone hardware border
    backgroundColor: "#ffffff",
    shadowColor: PURPLE,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.07,
    shadowRadius: 20,
    elevation: 10,
    overflow: "hidden",
    marginBottom: H * 0.04,
  },
  mockPhoneInner: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  dynamicIsland: {
    width: 90,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#1f2030",
    alignSelf: "center",
    marginTop: 6,
    zIndex: 10,
  },
  mockHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0,0,0,0.04)",
  },
  mockHeaderDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#22c55e",
    marginRight: 6,
  },
  mockHeaderText: {
    color: INK_DARK,
    fontSize: 11.5,
    fontFamily: "Poppins_600SemiBold",
  },
  mockChatList: {
    flex: 1,
    padding: 10,
    gap: 8,
  },
  chatRowLeft: {
    flexDirection: "row",
    gap: 6,
    alignItems: "flex-end",
  },
  chatRowRight: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  miniAvatar: {
    width: 18,
    height: 18,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  miniAvatarText: {
    color: "#ffffff",
    fontSize: 8,
    fontFamily: "Poppins_700Bold",
  },
  chatBubbleLeft: {
    backgroundColor: "#f1f3f9",
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 12,
    borderBottomLeftRadius: 2,
    maxWidth: "80%",
  },
  chatBubbleRight: {
    backgroundColor: PURPLE,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 12,
    borderBottomRightRadius: 2,
    maxWidth: "80%",
  },
  chatTextLeft: {
    color: INK_DARK,
    fontSize: 9.5,
    lineHeight: 13.5,
    fontFamily: "Poppins_400Regular",
  },
  chatTextRight: {
    color: "#ffffff",
    fontSize: 9.5,
    lineHeight: 13.5,
    fontFamily: "Poppins_400Regular",
  },
  mockInputBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: "rgba(0,0,0,0.04)",
    gap: 8,
  },
  mockTextInputPlaceholder: {
    flex: 1,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#f1f3f9",
  },
  mockSendBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: PURPLE,
    alignItems: "center",
    justifyContent: "center",
  },
  mockSectionTitle: {
    fontSize: 8.5,
    fontFamily: "Poppins_700Bold",
    color: INK_SOFT,
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  workspaceCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: CARD_BG,
    padding: 10,
    borderRadius: 14,
    gap: 10,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.03)",
  },
  workspaceIconWrapper: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: PURPLE_SOFT,
    alignItems: "center",
    justifyContent: "center",
  },
  workspaceName: {
    color: INK_DARK,
    fontSize: 11.5,
    fontFamily: "Poppins_600SemiBold",
  },
  workspaceMeta: {
    color: INK_SOFT,
    fontSize: 9,
    fontFamily: "Poppins_400Regular",
    marginTop: 1,
  },
  aiWorkspaceCard: {
    backgroundColor: "rgba(108,92,231,0.04)",
    borderWidth: 1,
    borderColor: "rgba(108,92,231,0.15)",
    padding: 10,
    borderRadius: 14,
    marginTop: 6,
  },
  aiWorkspaceTitle: {
    color: PURPLE,
    fontSize: 11,
    fontFamily: "Poppins_700Bold",
  },
  aiWorkspaceBody: {
    color: "#5b5d72",
    fontSize: 9,
    lineHeight: 13,
    fontFamily: "Poppins_400Regular",
  },
  mockCallType: {
    color: PURPLE,
    fontSize: 9,
    fontFamily: "SpaceGrotesk_700Bold",
    letterSpacing: 1,
  },
  mockCallName: {
    color: INK_DARK,
    fontSize: 16,
    fontFamily: "Poppins_700Bold",
    marginTop: 4,
  },
  mockCallStatus: {
    color: INK_SOFT,
    fontSize: 10,
    fontFamily: "Poppins_400Regular",
    marginTop: 2,
  },
  pulsingContainer: {
    position: "relative",
    width: 120,
    height: 120,
    alignItems: "center",
    justifyContent: "center",
    marginVertical: H * 0.03,
  },
  pulseRing: {
    position: "absolute",
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: PURPLE,
  },
  mockCallAvatar: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: "#f1f3f9",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: PURPLE,
    zIndex: 2,
  },
  mockAvatarText: {
    color: PURPLE,
    fontSize: 18,
    fontFamily: "Poppins_700Bold",
  },
  mockCallActions: {
    flexDirection: "row",
    gap: 14,
    alignItems: "center",
  },
  mockCallButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#f1f3f9",
    alignItems: "center",
    justifyContent: "center",
  },
  textBlock: {
    alignItems: "center",
    paddingHorizontal: 12,
  },
  slideTitle: {
    fontSize: 24,
    fontFamily: "SpaceGrotesk_700Bold",
    color: INK_DARK,
    textAlign: "center",
    letterSpacing: -0.4,
    marginBottom: 10,
  },
  slideSubtitle: {
    fontSize: 14,
    color: INK_SOFT,
    textAlign: "center",
    lineHeight: 20,
    fontFamily: "Poppins_400Regular",
  },
  fixedBottomContainer: {
    width: "100%",
    paddingHorizontal: 28,
    paddingBottom: H * 0.05,
    backgroundColor: "transparent",
    zIndex: 10,
  },
  dotsRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    marginBottom: 24,
  },
  dot: {
    width: 12,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(108,92,231,0.15)",
  },
  cta: {
    gap: 12,
  },
  btnPrimary: {
    width: "100%",
    height: 56,
    borderRadius: 16,
    backgroundColor: PURPLE,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: PURPLE,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 8,
  },
  btnPrimaryText: {
    color: "#ffffff",
    fontFamily: "Poppins_700Bold",
    fontSize: 15,
    letterSpacing: 0.1,
  },
  btnSecondary: {
    width: "100%",
    height: 56,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: PURPLE,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  btnSecondaryText: {
    fontSize: 15,
    color: PURPLE,
    fontFamily: "Poppins_700Bold",
  },
});
