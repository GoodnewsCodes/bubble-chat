/**
 * On-device live call transcription (mobile parity with the web meeting modal's
 * Web Speech API). Wraps `expo-speech-recognition` behind a tiny, crash-safe API:
 *
 *  - In a dev/release build the native module is present → real speech-to-text.
 *  - In Expo Go (no native module) every call is a silent no-op, so the app never
 *    crashes; captions simply don't generate there (media can't run in Expo Go
 *    anyway).
 *
 * Only the LOCAL speaker's mic is transcribed on this device, so each client is
 * the authoritative speaker for its own chunks — exactly like the web, which
 * stamps every chunk with the local user's id and relays it to peers over the
 * `meeting_transcript_chunk` socket event.
 */

// Dynamic, guarded import: importing a missing native module must not throw at
// module-eval time (that would take down the whole call screen in Expo Go).
let mod: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  mod = require('expo-speech-recognition');
} catch {
  mod = null;
}

const Module = () => mod?.ExpoSpeechRecognitionModule || null;

export const isTranscriptionAvailable = (): boolean => !!Module();

const START_OPTS = {
  lang: 'en-US',
  interimResults: false, // only final chunks — matches the web (interimResults=false)
  continuous: true,      // keep listening for the whole call
  requiresOnDeviceRecognition: false,
  addsPunctuation: true,
};

export class LiveTranscriber {
  private subs: { remove?: () => void }[] = [];
  private active = false;
  private readonly onFinal: (text: string) => void;

  constructor(onFinal: (text: string) => void) {
    this.onFinal = onFinal;
  }

  /** Request permission and begin continuous recognition. Returns false if the
   *  native module is unavailable or permission was denied. */
  async start(): Promise<boolean> {
    const M = Module();
    if (!M || this.active) return false;

    try {
      const perm = await M.requestPermissionsAsync();
      if (perm && perm.granted === false) return false;
    } catch {
      return false;
    }

    this.active = true;

    try {
      const onResult = M.addListener('result', (e: any) => {
        if (!e?.isFinal) return;
        const text = String(e?.results?.[0]?.transcript || '').trim();
        if (text) {
          try { this.onFinal(text); } catch { /* consumer error must not kill STT */ }
        }
      });
      // Android often auto-stops after a pause; restart while the call is live so
      // recognition is effectively continuous (the web relies on the same trick).
      const onEnd = M.addListener('end', () => {
        if (this.active) {
          try { M.start(START_OPTS); } catch { /* will retry on next end */ }
        }
      });
      const onError = M.addListener('error', (e: any) => {
        // "no-speech"/"no-match" are normal during silence — the 'end' handler
        // restarts. Only a hard error (e.g. permission revoked) stops us.
        const code = e?.error || e?.code;
        if (code === 'not-allowed' || code === 'service-not-allowed') this.active = false;
      });
      this.subs.push(onResult, onEnd, onError);

      M.start(START_OPTS);
      return true;
    } catch {
      this.active = false;
      this.dispose();
      return false;
    }
  }

  /** Stop recognition and remove listeners. Idempotent. */
  stop(): void {
    this.active = false;
    try { Module()?.stop?.(); } catch { /* already stopped */ }
    this.dispose();
  }

  private dispose(): void {
    for (const s of this.subs) { try { s?.remove?.(); } catch { /* noop */ } }
    this.subs = [];
  }
}
