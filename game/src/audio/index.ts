import type * as THREE from 'three/webgpu';

/**
 * The game's sound: Web Audio, positional, one master gain. Clips are MP3s
 * under `public/voices/` fetched and decoded the first time they play (the
 * decode runs on the browser's decoding thread, not in a frame). The
 * AudioContext is created on the first user gesture (Chrome's autoplay rule),
 * so nothing plays before the player has clicked, locked the pointer or
 * pressed a key. Without Web Audio (headless tests) every call is a no-op.
 */
export interface GameAudio {
  /** Make / resume the AudioContext (call it from a user gesture); the first click / pointer-lock / key does this by itself. */
  unlock(): Promise<void>;
  /**
   * Lazily load + decode (off the frame path) and play a clip positioned at a
   * world point. The handle says when it actually starts and ends (a cold
   * clip starts only once it has loaded); callers that don't care ignore it.
   */
  playAt(clip: string, pos: { x: number; y: number; z: number }): Playback;
  /** Called once per frame with the camera (listener position + orientation). */
  setListener(camera: THREE.Camera): void;
  muted: boolean; // persisted per browser
  volume: number; // 0..1, persisted per browser
  dispose(): void;
  /** False when the browser has no Web Audio: nothing will ever sound. */
  readonly available: boolean;
  /** `idle` until the first gesture, `running` once sound can play, `locked` if the browser refused. */
  readonly state: 'idle' | 'locked' | 'running' | 'none';
  /** Silences what is playing and drops clips still loading. */
  stop(): void;
  /** Fetch + decode a clip ahead of time (once unlocked). */
  preload(clip: string): void;
  /** Seconds, once the clip is decoded; null before (or without audio). */
  duration(clip: string): number | null;
  /** Mute, volume or state changed; returns the unsubscribe. */
  onChange(fn: () => void): () => void;
}

/** One `playAt`: when the clip really sounds, and when it's over. */
export interface Playback {
  /** True once the clip starts sounding; false when it never will (muted, locked, stopped or cancelled first, failed to load). */
  readonly started: Promise<boolean>;
  /** Settles when the clip has played out, was stopped or cancelled, or never started. */
  readonly ended: Promise<void>;
  /** Drops the clip while it loads, stops it while it plays. */
  cancel(): void;
}

/** The handle of a clip that won't sound. */
const SILENT: Playback = { started: Promise.resolve(false), ended: Promise.resolve(), cancel: () => undefined };

/** Everything the module touches in the browser, so tests can fake it. */
export interface AudioDeps {
  /** Makes the AudioContext; null or throwing: no audio. Default: `new AudioContext()` when the browser has one. */
  context?: (() => AudioContext | null) | null;
  /** Fetches a clip's bytes. */
  load?: (url: string) => Promise<ArrayBuffer>;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Where the unlock gestures are heard (window). */
  events?: EventTarget | null;
  /** Clip key → URL. */
  url?: (clip: string) => string;
}

export const AUDIO_PREFS_KEY = 'h3d.audio';
const DEFAULT_VOLUME = 0.8;
/** A voice from the desk: full level within 2 m, about a quarter at 10 m. */
const REF_DISTANCE = 2;
const ROLLOFF = 0.75;
const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'click', 'touchend', 'pointerlockchange'] as const;

interface Prefs {
  muted: boolean;
  volume: number;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_VOLUME);

function readPrefs(s: AudioDeps['storage']): Prefs {
  try {
    const p = JSON.parse(s?.getItem(AUDIO_PREFS_KEY) ?? 'null') as Partial<Prefs> | null;
    return { muted: p?.muted === true, volume: typeof p?.volume === 'number' ? clamp01(p.volume) : DEFAULT_VOLUME };
  } catch {
    return { muted: false, volume: DEFAULT_VOLUME };
  }
}

function defaultStorage(): AudioDeps['storage'] {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // blocked site data
  }
}

function defaultContext(): (() => AudioContext | null) | null {
  const Ctor = typeof window === 'undefined' ? undefined : (window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  return Ctor ? () => new Ctor({ latencyHint: 'interactive' }) : null;
}

const setParam = (p: AudioParam | undefined, v: number) => {
  if (p && p.value !== v) p.value = v;
};

interface Voice {
  src: AudioBufferSourceNode;
  panner: PannerNode;
  /** Settles its Playback (whether or not the browser still fires `ended`, e.g. in a suspended context). */
  done: () => void;
}

class WebGameAudio implements GameAudio {
  readonly available: boolean;
  private readonly makeContext: (() => AudioContext | null) | null;
  private readonly load: (url: string) => Promise<ArrayBuffer>;
  private readonly storage: AudioDeps['storage'];
  private readonly events: EventTarget | null;
  private readonly url: (clip: string) => string;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private failed = false;
  private readonly clips = new Map<string, Promise<AudioBuffer | null>>();
  private readonly decoded = new Map<string, AudioBuffer>();
  private readonly voices = new Set<Voice>();
  private readonly listeners = new Set<() => void>();
  private prefs: Prefs;
  /** Bumped by stop(): clips that finish loading afterwards don't play. */
  private gen = 0;
  private camera: THREE.Camera | null = null;
  private readonly lastListener = new Float64Array(9).fill(Number.NaN);
  private disposed = false;
  private creating = false;
  /**
   * Making the first AudioContext costs ~35 ms of main thread (Chromium), too
   * much inside a key or click handler at 120 Hz: after the first gesture the
   * page has sticky activation, so it is made at the next idle moment instead.
   * Later gestures resume it synchronously (cheap), which Safari needs.
   */
  private readonly onGesture = () => {
    if (this.ctx || this.failed) {
      void this.unlock();
      return;
    }
    if (this.creating) return;
    this.creating = true;
    const run = () => {
      this.creating = false;
      void this.unlock();
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 400 });
    else setTimeout(run, 0);
  };

  constructor(d: AudioDeps) {
    this.makeContext = d.context === undefined ? defaultContext() : d.context;
    this.available = !!this.makeContext;
    this.load = d.load ?? (async (url) => (await fetch(url)).arrayBuffer());
    this.storage = d.storage === undefined ? defaultStorage() : d.storage;
    this.events = d.events === undefined ? (typeof window === 'undefined' ? null : window) : d.events;
    // A clip name with an extension is a file as it is (`gong.wav`); without, an MP3.
    this.url = d.url ?? ((clip) => `${import.meta.env.BASE_URL}voices/${/\.[a-z0-9]{2,4}$/i.test(clip) ? clip : `${clip}.mp3`}`);
    this.prefs = readPrefs(this.storage);
    if (this.available) this.armGestures();
  }

  get state(): GameAudio['state'] {
    if (!this.available) return 'none';
    if (!this.ctx) return this.failed ? 'locked' : 'idle';
    return this.ctx.state === 'running' ? 'running' : 'locked';
  }

  get muted(): boolean {
    return this.prefs.muted;
  }

  set muted(m: boolean) {
    if (m === this.prefs.muted) return;
    this.prefs = { ...this.prefs, muted: m };
    if (m) this.stop();
    this.applyGain();
    this.save();
  }

  get volume(): number {
    return this.prefs.volume;
  }

  set volume(v: number) {
    const c = clamp01(v);
    if (c === this.prefs.volume) return;
    this.prefs = { ...this.prefs, volume: c };
    this.applyGain();
    this.save();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  private save(): void {
    try {
      this.storage?.setItem(AUDIO_PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      // Private window or blocked storage: the setting lasts for this page only.
    }
    this.changed();
  }

  private applyGain(): void {
    const g = this.master?.gain;
    if (!g || !this.ctx) return;
    const v = this.prefs.muted ? 0 : this.prefs.volume;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  }

  /** The context, made inside the first unlock gesture (made earlier, Chrome would start it suspended and warn). */
  private context(): AudioContext | null {
    if (this.ctx || this.failed || !this.makeContext || this.disposed) return this.ctx;
    try {
      this.ctx = this.makeContext();
    } catch {
      this.ctx = null;
    }
    if (!this.ctx) {
      this.failed = true;
      return null;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.prefs.muted ? 0 : this.prefs.volume;
    this.master.connect(this.ctx.destination);
    this.ctx.addEventListener?.('statechange', () => {
      // Interrupted later (another tab, the OS): the next gesture resumes it again.
      if (this.ctx?.state === 'running') this.dropGestures();
      else if (this.ctx?.state === 'suspended' && !this.disposed) this.armGestures();
      this.changed();
    });
    return this.ctx;
  }

  private armGestures(): void {
    for (const e of UNLOCK_EVENTS) this.events?.addEventListener(e, this.onGesture, { capture: true, passive: true });
  }

  private dropGestures(): void {
    for (const e of UNLOCK_EVENTS) this.events?.removeEventListener(e, this.onGesture, { capture: true });
  }

  async unlock(): Promise<void> {
    const ctx = this.context();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        // Not a user gesture yet: the next one tries again.
      }
    }
    if (ctx.state === 'running') this.dropGestures();
    this.changed();
  }

  private buffer(clip: string): Promise<AudioBuffer | null> {
    let p = this.clips.get(clip);
    if (p) return p;
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve(null); // before the first gesture nothing can sound anyway
    p = this.load(this.url(clip))
      .then((bytes) => ctx.decodeAudioData(bytes))
      .then((b) => {
        this.decoded.set(clip, b);
        return b;
      })
      .catch(() => null);
    this.clips.set(clip, p);
    return p;
  }

  preload(clip: string): void {
    if (!this.disposed) void this.buffer(clip);
  }

  duration(clip: string): number | null {
    return this.decoded.get(clip)?.duration ?? null;
  }

  playAt(clip: string, pos: { x: number; y: number; z: number }): Playback {
    if (this.disposed || this.prefs.muted || !this.available) return SILENT;
    const gen = this.gen;
    const at = { x: pos.x, y: pos.y, z: pos.z };
    let voice: Voice | null = null;
    let over = false;
    let started!: (ok: boolean) => void;
    let ended!: () => void;
    const pb: Playback = {
      started: new Promise((r) => (started = r)),
      ended: new Promise((r) => (ended = r)),
      cancel: () => (voice ? this.silence(voice) : finish()),
    };
    // Settles both (a no-op once they have): nothing sounds after this.
    function finish() {
      over = true;
      started(false);
      ended();
    }
    void this.buffer(clip).then((buf) => {
      const ctx = this.ctx;
      const master = this.master;
      // Stopped, muted, cancelled or disposed while it loaded, or still locked: a late line would sound out of place.
      if (over || !buf || !ctx || !master || gen !== this.gen || this.disposed || this.prefs.muted || ctx.state !== 'running') {
        finish();
        return;
      }
      voice = this.start(ctx, master, buf, at, finish);
      started(true);
    });
    return pb;
  }

  private silence(v: Voice): void {
    try {
      v.src.stop();
    } catch {
      // Already ended.
    }
    v.done();
  }

  private start(ctx: AudioContext, master: GainNode, buf: AudioBuffer, at: { x: number; y: number; z: number }, onEnded: () => void): Voice {
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = REF_DISTANCE;
    panner.rolloffFactor = ROLLOFF;
    if (panner.positionX) {
      panner.positionX.value = at.x;
      panner.positionY.value = at.y;
      panner.positionZ.value = at.z;
    } else panner.setPosition(at.x, at.y, at.z);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(panner);
    panner.connect(master);
    const v: Voice = { src, panner, done: onEnded };
    this.voices.add(v);
    src.onended = () => {
      this.voices.delete(v);
      src.disconnect();
      panner.disconnect();
      onEnded();
    };
    this.lastListener.fill(Number.NaN);
    if (this.camera) this.setListener(this.camera);
    src.start();
    return v;
  }

  setListener(camera: THREE.Camera): void {
    this.camera = camera;
    // Only while something plays: the listener is re-placed when a voice starts.
    const l = this.ctx?.listener;
    if (!l || this.voices.size === 0) return;
    const e = camera.matrixWorld.elements;
    const px = e[12] ?? 0;
    const py = e[13] ?? 0;
    const pz = e[14] ?? 0;
    // Forward is -Z, up is +Y of the camera's world matrix.
    let fx = -(e[8] ?? 0);
    let fy = -(e[9] ?? 0);
    let fz = -(e[10] ?? 1);
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl;
    fy /= fl;
    fz /= fl;
    let ux = e[4] ?? 0;
    let uy = e[5] ?? 1;
    let uz = e[6] ?? 0;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const now = [px, py, pz, fx, fy, fz, ux, uy, uz];
    let same = true;
    for (let i = 0; i < 9; i++) if (Math.abs((this.lastListener[i] ?? 0) - (now[i] ?? 0)) > 1e-4 || Number.isNaN(this.lastListener[i])) same = false;
    if (same) return;
    this.lastListener.set(now);
    if (l.positionX) {
      setParam(l.positionX, px);
      setParam(l.positionY, py);
      setParam(l.positionZ, pz);
      setParam(l.forwardX, fx);
      setParam(l.forwardY, fy);
      setParam(l.forwardZ, fz);
      setParam(l.upX, ux);
      setParam(l.upY, uy);
      setParam(l.upZ, uz);
    } else {
      l.setPosition(px, py, pz);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  stop(): void {
    this.gen++;
    for (const v of this.voices) this.silence(v);
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.dropGestures();
    this.listeners.clear();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
  }
}

export function createGameAudio(deps: AudioDeps = {}): GameAudio {
  return new WebGameAudio(deps);
}
