import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';

type Player = ReturnType<typeof createAudioPlayer>;

const SOURCES = {
  incoming: require('../../assets/sounds/ringtone-incoming.wav'),
  outgoing: require('../../assets/sounds/ringtone-outgoing.wav'),
};

let audioModeConfigured = false;
const configureAudioMode = async () => {
  if (audioModeConfigured) return;
  audioModeConfigured = true;
  // Ring through the speaker even when the device is on silent.
  try {
    await setAudioModeAsync({ playsInSilentMode: true });
  } catch {}
};

export class RingtonePlayer {
  private player: Player | null = null;
  private isPlaying = false;

  startRinging(type: 'incoming' | 'outgoing') {
    if (this.isPlaying) return;
    this.isPlaying = true;
    configureAudioMode();

    try {
      const player = createAudioPlayer(SOURCES[type]);
      player.loop = true;
      player.volume = 1;
      player.play();
      this.player = player;
    } catch (e) {
      console.log('Ringtone playback unavailable on this platform:', e);
    }
  }

  stop() {
    // Flip the guard FIRST so a late startRinging() (e.g. a duplicate socket event
    // arriving mid-teardown) can't resurrect this same instance while we're tearing
    // it down. Muting before pause/remove kills the looping audio even if one of the
    // native calls throws or resolves asynchronously.
    this.isPlaying = false;
    const player = this.player;
    this.player = null;
    if (player) {
      try { player.volume = 0; } catch {}
      try { player.loop = false; } catch {}
      try { player.pause(); } catch {}
      try { player.remove(); } catch {}
    }
  }
}
