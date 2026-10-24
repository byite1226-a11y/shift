/**
 * Sound: generated SFX with stereo panning by field position, plus music. Music is a file loop when
 * public/assets/bgm.mp3 exists, otherwise a built-in chiptune loop (E minor, 132 BPM, four bars) in two fixed
 * arrangements chosen by the user on 2026-10-23: home = kick, snare and bass; in play = the same plus off-beat
 * hats and the square arpeggio. No level-driven layering (the LV8+ tier was not distinguishable). The loop pauses
 * with the game and fades out at the result.
 * No autoplay: the context is created/resumed and music started only from a user gesture; one toggle mutes all.
 * The visual brief's "no fatiguing highs, no excessive volume" holds: master 0.7 into a compressor, no long tones
 * above ~1.6 kHz, launches rate-limited by the caller.
 */
const KEY = 'shift.gate01.sound';
/** Drop a loop here to replace the built-in music (mp3; change the name/extension together with this constant). */
export const BGM_URL = `${import.meta.env.BASE_URL}assets/bgm.mp3`;
const FILE_VOLUME = 0.32;
const MUSIC_GAIN: Record<'home' | 'play', number> = { home: 0.12, play: 0.18 };

export type SfxKind =
  | 'near' | 'hit' | 'save' | 'hurt' | 'fail' | 'clear' | 'level' | 'start' | 'record'
  | 'launch' | 'launchFast' | 'launchHeavy' | 'volley' | 'row' | 'warn' | 'miss'
  | 'ui' | 'pause' | 'resume';
export type MusicState = 'off' | 'home' | 'play' | 'pause';

let ac: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let enabled = true;
try { enabled = (localStorage.getItem(KEY) ?? '1') === '1'; } catch { /* storage unavailable */ }

// ---- graph -----------------------------------------------------------------
function out(): GainNode | null {
  if (!ac) return null;
  if (!master) {
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.12;
    master = ac.createGain();
    master.gain.value = 0.7;
    master.connect(comp).connect(ac.destination);
  }
  return master;
}

/** Destination for one sound: the master, or a panner in front of it (pan −1 left … +1 right). */
function bus(pan: number): AudioNode | null {
  const m = out();
  if (!ac || !m) return null;
  if (!pan || typeof ac.createStereoPanner !== 'function') return m;
  const p = ac.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  p.connect(m);
  return p;
}

function toneAt(t0: number, freqFrom: number, freqTo: number, secs: number, type: OscillatorType, gain: number, dest: AudioNode) {
  if (!ac) return;
  const t1 = t0 + secs;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freqFrom, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, freqTo), t1);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.004); // 4 ms attack: no click, still snappy
  g.gain.exponentialRampToValueAtTime(0.0001, t1);
  o.connect(g).connect(dest);
  o.start(t0);
  o.stop(t1 + 0.02);
}

function noiseAt(t0: number, secs: number, gain: number, type: BiquadFilterType, freq: number, dest: AudioNode) {
  if (!ac) return;
  if (!noiseBuf) {
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t1 = t0 + secs;
  const src = ac.createBufferSource();
  src.buffer = noiseBuf;
  const f = ac.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = 0.8;
  const g = ac.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t1);
  src.connect(f).connect(g).connect(dest);
  src.start(t0, Math.random() * 0.5);
  src.stop(t1 + 0.02);
}

// ---- SFX -------------------------------------------------------------------
const detune = () => 0.94 + Math.random() * 0.12; // launches never sound like a machine

function sfx(kind: SfxKind, dest: AudioNode) {
  if (!ac) return;
  const now = ac.currentTime;
  const tone = (f0: number, f1: number, ms: number, type: OscillatorType, gain: number, at = 0) => toneAt(now + at / 1000, f0, f1, ms / 1000, type, gain, dest);
  const noise = (ms: number, gain: number, type: BiquadFilterType, freq: number, at = 0) => noiseAt(now + at / 1000, ms / 1000, gain, type, freq, dest);
  const d = detune();
  switch (kind) {
    // projectiles
    case 'launch':      noise(55, 0.16, 'bandpass', 2600); tone(900 * d, 480, 60, 'triangle', 0.1); break;                       // a lone dart leaves the edge
    case 'launchFast':  noise(45, 0.24, 'highpass', 3000); tone(1500 * d, 650, 50, 'sawtooth', 0.09); break;                     // fast tier: sharper crack
    case 'launchHeavy': noise(120, 0.2, 'lowpass', 900); tone(220 * d, 130, 150, 'triangle', 0.2); break;                       // large dart: low whoosh
    case 'volley':      noise(150, 0.2, 'bandpass', 1600); tone(720 * d, 320, 130, 'sawtooth', 0.08); tone(1050, 480, 110, 'triangle', 0.07, 40); break; // burst / fan: many at once
    case 'row':         noise(240, 0.2, 'lowpass', 1200); tone(150 * d, 85, 240, 'sawtooth', 0.13); break;                       // a wall or line sweeps in
    case 'warn':        tone(1250, 1250, 50, 'square', 0.06); break;                                                                // fast-shot telegraph: one soft tick
    // player
    case 'near':  noise(60, 0.14, 'highpass', 1400); tone(1200, 850, 50, 'sine', 0.08); break;
    case 'hit':   noise(60, 0.3, 'bandpass', 900); tone(620, 210, 90, 'square', 0.16); tone(300, 120, 120, 'triangle', 0.22); break;
    case 'save':  noise(60, 0.3, 'bandpass', 900); tone(620, 210, 90, 'square', 0.16); tone(880, 1320, 110, 'sine', 0.2, 70); tone(1320, 1320, 140, 'sine', 0.14, 150); break;
    case 'miss':  tone(520, 300, 40, 'square', 0.05); break;                                                                       // empty click: dry tick
    case 'hurt':  noise(140, 0.32, 'lowpass', 700); tone(260, 110, 200, 'triangle', 0.3); tone(130, 60, 240, 'sawtooth', 0.18, 20); break;
    case 'fail':  noise(260, 0.42, 'lowpass', 500); tone(170, 48, 380, 'sawtooth', 0.42); tone(85, 32, 460, 'triangle', 0.36, 40); noise(400, 0.2, 'lowpass', 220, 120); break;
    // progression / UI
    case 'level': tone(660, 660, 70, 'square', 0.1); tone(990, 990, 110, 'square', 0.1, 75); noise(50, 0.1, 'highpass', 2500, 75); break;
    case 'start': tone(440, 440, 60, 'square', 0.1); tone(660, 660, 60, 'square', 0.1, 70); tone(880, 880, 140, 'square', 0.12, 140); break;
    case 'clear': tone(523, 523, 100, 'sine', 0.22); tone(659, 659, 100, 'sine', 0.22, 110); tone(784, 784, 220, 'sine', 0.24, 220); noise(90, 0.12, 'highpass', 2000, 220); break;
    case 'record': [659, 784, 988, 1319].forEach((f, i) => tone(f, f, i === 3 ? 260 : 90, 'square', 0.12, i * 95)); noise(120, 0.1, 'highpass', 3000, 285); break;
    case 'ui':     tone(880, 880, 40, 'square', 0.08); tone(1320, 1320, 60, 'square', 0.06, 45); break;
    case 'pause':  tone(660, 440, 120, 'triangle', 0.12); break;
    case 'resume': tone(440, 660, 120, 'triangle', 0.12); break;
  }
}

// ---- music -----------------------------------------------------------------
const BPM = 132, STEP_S = 60 / BPM / 4, LOOP = 64; // 16th-note grid, four bars
// bar chords: Em · C · D · B — bass root, then the arpeggio notes
const CHORDS: [number, number[]][] = [
  [82.41, [329.63, 392.0, 493.88, 659.25]],
  [65.41, [261.63, 329.63, 392.0, 523.25]],
  [73.42, [293.66, 369.99, 440.0, 587.33]],
  [61.74, [246.94, 311.13, 369.99, 493.88]],
];
const BASS_HITS = new Set([0, 3, 6, 8, 11, 14]);
const ARP = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0, 1, 2, 3];

let musicBus: GainNode | null = null;
let want: MusicState = 'off';      // what the game asked for (applied once a gesture has unlocked audio)
let running: MusicState = 'off';   // what the loop is doing
let step = 0, nextT = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let file: HTMLAudioElement | null = null;
let fileAvailable: boolean | null = null; // null = not probed yet

function scheduleStep(i: number, t: number) {
  const m = musicBus;
  if (!ac || !m) return;
  const bar = Math.floor(i / 16) % 4, s = i % 16;
  const [root, arp] = CHORDS[bar];
  const home = running === 'home';
  // home: kick, snare, bass. In play: the same plus off-beat hats and the arpeggio.
  if (s % 4 === 0) toneAt(t, 150, 45, 0.11, 'sine', home ? 0.6 : 0.9, m);                                 // kick
  if (s === 4 || s === 12) { noiseAt(t, 0.08, home ? 0.12 : 0.18, 'bandpass', 1800, m); toneAt(t, 190, 120, 0.06, 'triangle', 0.14, m); } // snare
  if (!home && s % 4 === 2) noiseAt(t, 0.02, 0.08, 'highpass', 7000, m);                                   // off-beat hats
  if (BASS_HITS.has(s)) toneAt(t, root, root, 0.13, 'triangle', 0.5, m);                                   // bass
  if (!home) toneAt(t, arp[ARP[s]], arp[ARP[s]], 0.07, 'square', 0.1, m);                                 // arpeggio
}

function tick() {
  if (!ac) return;
  while (nextT < ac.currentTime + 0.15) {
    scheduleStep(step, nextT);
    nextT += STEP_S;
    step = (step + 1) % LOOP;
  }
}

function loopStart() {
  const m = out();
  if (!ac || !m) return;
  if (!musicBus) { musicBus = ac.createGain(); musicBus.gain.value = 0; musicBus.connect(m); }
  if (timer === null) { nextT = ac.currentTime + 0.05; timer = setInterval(tick, 40); }
}
function loopHold() { if (timer !== null) { clearInterval(timer); timer = null; } }
function loopStop(fadeS: number) {
  loopHold();
  if (ac && musicBus) { musicBus.gain.cancelScheduledValues(ac.currentTime); musicBus.gain.setTargetAtTime(0, ac.currentTime, Math.max(0.01, fadeS / 3)); }
  step = 0;
}

/** Make the loop (or the file) match `want`. */
function applyMusic() {
  if (!ac) return;
  const state: MusicState = enabled ? want : 'off';
  if (fileAvailable && file) {
    // a real track: play while home/playing, pause otherwise
    if (state === 'home' || state === 'play') { file.volume = state === 'home' ? FILE_VOLUME * 0.6 : FILE_VOLUME; void file.play().catch(() => { /* needs a gesture; retried on the next unlock */ }); }
    else file.pause();
    running = state;
    return;
  }
  if (state === 'off') loopStop(0.35);
  else if (state === 'pause') loopHold();
  else {
    loopStart();
    if (musicBus) { musicBus.gain.cancelScheduledValues(ac.currentTime); musicBus.gain.setTargetAtTime(MUSIC_GAIN[state], ac.currentTime, 0.15); }
  }
  running = state;
}

export const audio = {
  get enabled() { return enabled; },
  /** true once a bgm file was found; the built-in loop is used otherwise */
  get musicFile() { return fileAvailable === true; },
  toggle() {
    enabled = !enabled;
    try { localStorage.setItem(KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
    applyMusic();
    return enabled;
  },
  /** Call from any user gesture (click/keydown): creates/resumes the context, probes the bgm file, starts the music the game asked for. */
  unlock() {
    if (!ac) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor) ac = new Ctor();
    }
    if (ac && ac.state === 'suspended') void ac.resume();
    if (!file && typeof Audio !== 'undefined') {
      file = new Audio(BGM_URL);
      file.loop = true;
      file.preload = 'auto';
      file.addEventListener('canplaythrough', () => { fileAvailable = true; loopStop(0.05); applyMusic(); }, { once: true });
      file.addEventListener('error', () => { fileAvailable = false; }, { once: true });
    }
    applyMusic();
  },
  /** Game state → music: 'home' loop, 'play' loop, 'pause' holds, 'off' fades out. Remembered until audio is unlocked. */
  setMusic(state: MusicState) { want = state; applyMusic(); },
  /** Hidden tab: hold the music (the game pauses too); back: resume what was wanted. */
  background(hidden: boolean) {
    if (!ac) return;
    if (hidden) { if (fileAvailable && file) file.pause(); else loopHold(); }
    else applyMusic();
  },
  /** One event sound; pan −1 … +1 places it on the field. */
  play(kind: SfxKind, pan = 0) {
    if (!enabled || !ac) return;
    const dest = bus(pan);
    if (dest) sfx(kind, dest);
  },
};
