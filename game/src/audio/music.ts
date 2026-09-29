import { GENRES, genreName, isGenre, nextGenre, ROWS, tracksOf, trackPath, type Genre, type RadioGenre, type Track } from './tracks';
import { ShuffleQueue } from './shuffle';

/**
 * The office radio's player: a music bus in the game's Web Audio graph.
 *
 *   deck A ─┐
 *           ├─ radio panner (HRTF, at the radio) ─ floor fade ─ music bus ─ master ─ speakers
 *   deck B ─┘
 *
 * A deck is an `HTMLAudioElement` streamed through a `MediaElementAudioSourceNode`
 * (nothing is decoded whole, nothing cached). Two decks crossfade (~1.5 s) on a
 * genre change and between tracks: the next track starts on the idle deck and
 * takes over once it sounds. Each genre has a shuffled queue that plays every
 * track before repeating and remembers its place while another genre plays.
 * The `floor fade` takes the radio out (0.5 s) when you are not on the floor
 * that has it, and pauses the decks; coming back resumes the same track.
 *
 * The genre, volume and mute are the player's, saved with the other audio
 * settings. Everything is a no-op until the first gesture has made the
 * AudioContext, and files that are missing are skipped, never thrown.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** What `window.__h3d.radio()` reports. */
export interface RadioState {
  genre: RadioGenre;
  trackId: string | null;
  /** The radio is (fading in and) sounding: a track is running, you are on its floor and nothing mutes it. */
  playing: boolean;
  /** The music volume, 0..1. */
  volume: number;
  muted: boolean;
}

export interface RadioEvent {
  /** `performance.now()`-style ms from the audio's clock. */
  at: number;
  kind: 'genre' | 'select' | 'start' | 'skip' | 'fade' | 'unavailable';
  genre?: RadioGenre;
  trackId?: string;
  detail?: string;
}

/** A track that has just started sounding (the "now playing" toast). */
export interface NowPlaying {
  track: Track;
  genre: Genre;
}

export interface Music {
  /** Music bus volume, 0..1; saved per browser. */
  volume: number;
  /** Music bus mute; saved per browser. */
  muted: boolean;
  readonly genre: RadioGenre;
  /** Tunes the radio (a genre, or `off`); saved per browser. */
  setGenre(g: RadioGenre): void;
  /** E: Off → Melodic house → Soft jazz → Rock → Pop → Rap → Off. Returns the new genre. */
  cycleGenre(): RadioGenre;
  /** R: skips to the next track of the genre. */
  nextTrack(): void;
  /** The radio's place in the world (it is a point source). */
  setPosition(at: Vec3): void;
  /** Whether you are on the floor that has the radio: false fades it out and pauses it, true brings it back. */
  setActive(active: boolean): void;
  readonly state: RadioState;
  readonly events: readonly RadioEvent[];
  /** A new track started sounding; returns the unsubscribe. */
  onTrack(fn: (n: NowPlaying) => void): () => void;
  /** Something sounds now (the listener must follow the camera). */
  readonly audible: boolean;
}

export interface MusicPrefs {
  volume: number;
  muted: boolean;
  genre: RadioGenre;
}

export const DEFAULT_MUSIC_PREFS: MusicPrefs = { volume: 0.4, muted: false, genre: 'house' };

/** What the player needs of the audio module around it. */
export interface MusicHost {
  /** The AudioContext once a gesture made it, else null. */
  context(): AudioContext | null;
  master(): GainNode | null;
  /** The master mute: the radio does not stream while it is on. */
  masterMuted(): boolean;
  prefs(): MusicPrefs;
  /** Saves and announces a change. */
  save(p: MusicPrefs): void;
  /** A track began sounding: place the listener. */
  soundStarted(): void;
}

export interface MusicDeps {
  /** A deck's element. Default `new Audio()`; null (no `Audio` in this environment): no radio. */
  element?: (() => HTMLAudioElement) | null;
  url?: (t: Track) => string;
  tracks?: (g: Genre) => Track[];
  random?: () => number;
  now?: () => number;
  /** Timers (the pause after a fade-out, a deck's cleanup after a crossfade). */
  timer?: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void };
}

/** Crossfade between tracks and on a genre change. */
export const CROSSFADE_S = 1.5;
/** Fade in / out when you come to or leave the radio's floor. */
export const FLOOR_FADE_S = 0.5;
/** Full level within 3 m of the radio, about 42 % at 10 m and 23 % at 20 m (the far pods): clear in the lounge, quiet but audible across the floor. */
export const RADIO_REF_DISTANCE = 3;
export const RADIO_ROLLOFF = 0.7;

const EVENT_CAP = 300;
const clamp01 = (v: number, dflt: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : dflt);

export function parseMusicPrefs(raw: unknown): MusicPrefs {
  const m = (raw ?? {}) as Partial<MusicPrefs>;
  return {
    volume: typeof m.volume === 'number' ? clamp01(m.volume, DEFAULT_MUSIC_PREFS.volume) : DEFAULT_MUSIC_PREFS.volume,
    muted: m.muted === true,
    genre: m.genre === 'off' || isGenre(m.genre) ? m.genre : DEFAULT_MUSIC_PREFS.genre,
  };
}

type Role = 'idle' | 'incoming' | 'live' | 'outgoing';

interface Deck {
  el: HTMLAudioElement;
  src: MediaElementAudioSourceNode;
  gain: GainNode;
  role: Role;
  track: Track | null;
  /** Bumped whenever the deck is given a new track or cleared: events of an older one are ignored. */
  gen: number;
  /** The deck's audio has started (a `playing` event since it was given its track). */
  sounding: boolean;
  /** Its cleanup after a crossfade. */
  cleanup: unknown;
}

export class MusicPlayer implements Music {
  private readonly makeElement: (() => HTMLAudioElement) | null;
  private readonly url: (t: Track) => string;
  private readonly tracksOf: (g: Genre) => Track[];
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly timer: NonNullable<MusicDeps['timer']>;
  private nodes: { bus: GainNode; fade: GainNode; panner: PannerNode; decks: [Deck, Deck] } | null = null;
  private ctx: AudioContext | null = null;
  private readonly queues = new Map<Genre, ShuffleQueue>();
  /** The track the radio is on (what should sound), whether or not anything does. */
  private current: Track | null = null;
  private active = false;
  private at: Vec3 = { x: 0, y: 1, z: 0 };
  private readonly log: RadioEvent[] = [];
  private readonly trackListeners = new Set<(n: NowPlaying) => void>();
  private pauseTimer: unknown = null;
  /** Tracks that failed to load in a row (a genre with no files at all gives up instead of looping). */
  private failures = 0;
  private wasWanted = false;
  private disposed = false;

  constructor(
    private readonly host: MusicHost,
    d: MusicDeps = {},
  ) {
    this.makeElement = d.element === undefined ? (typeof Audio === 'undefined' ? null : () => new Audio()) : d.element;
    this.url = d.url ?? ((t) => `${import.meta.env.BASE_URL}${trackPath(t)}`);
    this.tracksOf = d.tracks ?? ((g) => tracksOf(ROWS, g));
    this.random = d.random ?? Math.random;
    this.now = d.now ?? (() => Date.now());
    this.timer = d.timer ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    const genre = this.host.prefs().genre;
    // A saved genre means the radio is tuned: the first track is picked now, sounds at the first gesture on a floor.
    if (genre !== 'off') this.current = this.pick(genre);
  }

  // ---- settings ---------------------------------------------------------------------------

  get volume(): number {
    return this.host.prefs().volume;
  }

  set volume(v: number) {
    const c = clamp01(v, this.volume);
    if (c === this.volume) return;
    this.host.save({ ...this.host.prefs(), volume: c });
    this.applyBus();
  }

  get muted(): boolean {
    return this.host.prefs().muted;
  }

  set muted(m: boolean) {
    if (m === this.muted) return;
    this.host.save({ ...this.host.prefs(), muted: m });
    this.applyBus();
    this.sync();
  }

  get genre(): RadioGenre {
    return this.host.prefs().genre;
  }

  get audible(): boolean {
    return !!this.nodes && this.nodes.decks.some((d) => d.sounding);
  }

  get state(): RadioState {
    return {
      genre: this.genre,
      trackId: this.genre === 'off' ? null : (this.current?.id ?? null),
      playing: this.wanted() && this.audible,
      volume: this.volume,
      muted: this.muted,
    };
  }

  get events(): readonly RadioEvent[] {
    return this.log;
  }

  onTrack(fn: (n: NowPlaying) => void): () => void {
    this.trackListeners.add(fn);
    return () => this.trackListeners.delete(fn);
  }

  // ---- what the radio is tuned to ---------------------------------------------------------------

  setGenre(g: RadioGenre): void {
    if (this.disposed) return;
    if (g !== 'off' && !isGenre(g)) return;
    if (g === this.genre && (g === 'off' || this.current)) return;
    this.host.save({ ...this.host.prefs(), genre: g });
    this.failures = 0;
    this.event({ kind: 'genre', genre: g });
    // Coming back to a genre plays its next track: the queue kept its place while another genre played.
    this.current = g === 'off' ? null : this.pick(g);
    this.sync();
  }

  cycleGenre(): RadioGenre {
    const g = nextGenre(this.genre);
    this.setGenre(g);
    return g;
  }

  nextTrack(): void {
    if (this.disposed || this.genre === 'off') return;
    this.failures = 0;
    this.current = this.pick(this.genre);
    this.sync();
  }

  private queue(g: Genre): ShuffleQueue {
    let q = this.queues.get(g);
    if (!q) {
      q = new ShuffleQueue(
        this.tracksOf(g).map((t) => t.id),
        this.random,
      );
      this.queues.set(g, q);
    }
    return q;
  }

  /** The genre's next track, from its shuffled queue. */
  private pick(g: Genre): Track | null {
    const id = this.queue(g).next();
    const t = id ? (this.tracksOf(g).find((x) => x.id === id) ?? null) : null;
    if (t) this.event({ kind: 'select', genre: g, trackId: t.id });
    else this.event({ kind: 'unavailable', genre: g, detail: 'no tracks' });
    return t;
  }

  // ---- where it is and whether you can hear it --------------------------------------------------

  setPosition(at: Vec3): void {
    this.at = { x: at.x, y: at.y, z: at.z };
    const p = this.nodes?.panner;
    if (!p) return;
    if (p.positionX) {
      p.positionX.value = at.x;
      p.positionY.value = at.y;
      p.positionZ.value = at.z;
    } else p.setPosition(at.x, at.y, at.z);
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.sync();
  }

  // ---- the audio graph --------------------------------------------------------------------------

  /** The context exists (the first gesture made it): build the graph once. */
  attach(): void {
    if (this.nodes || this.disposed || !this.makeElement) return;
    const ctx = this.host.context();
    const master = this.host.master();
    if (!ctx || !master) return;
    this.ctx = ctx;
    const bus = ctx.createGain();
    const fade = ctx.createGain();
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = RADIO_REF_DISTANCE;
    panner.rolloffFactor = RADIO_ROLLOFF;
    fade.gain.value = 0;
    bus.gain.value = this.effectiveBus();
    panner.connect(fade);
    fade.connect(bus);
    bus.connect(master);
    const make = (): Deck => {
      const el = (this.makeElement as () => HTMLAudioElement)();
      el.preload = 'auto';
      const src = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain);
      gain.connect(panner);
      const deck: Deck = { el, src, gain, role: 'idle', track: null, gen: 0, sounding: false, cleanup: null };
      this.listen(deck);
      return deck;
    };
    this.nodes = { bus, fade, panner, decks: [make(), make()] };
    this.setPosition(this.at);
  }

  /** Reconciles what sounds with what is wanted: call after any change. */
  sync(): void {
    if (this.disposed) return;
    if (!this.nodes) this.attach();
    const n = this.nodes;
    if (!n || !this.ctx) return;
    const want = this.wanted();
    if (want !== this.wasWanted) {
      this.wasWanted = want;
      this.event({ kind: 'fade', detail: want ? 'in' : 'out' });
    }
    if (!want) {
      this.fadeOut();
      return;
    }
    if (this.pauseTimer) {
      this.timer.clear(this.pauseTimer);
      this.pauseTimer = null;
    }
    const cur = this.current;
    if (!cur) return;
    const live = this.deckWith('live');
    const incoming = this.deckWith('incoming');
    const alreadyOn = (live?.track?.id === cur.id && !incoming) || incoming?.track?.id === cur.id;
    if (!alreadyOn) this.crossTo(cur);
    else if (live && !incoming && live.el.paused) this.resume(live);
    else if (incoming && incoming.el.paused) this.resume(incoming);
    this.ramp(n.fade.gain, 1, FLOOR_FADE_S);
  }

  private wanted(): boolean {
    return this.genre !== 'off' && this.active && !this.muted && !this.host.masterMuted() && this.ctx?.state === 'running' && !!this.current;
  }

  private effectiveBus(): number {
    return this.muted ? 0 : this.volume;
  }

  private applyBus(): void {
    const g = this.nodes?.bus.gain;
    if (!g || !this.ctx) return;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setTargetAtTime(this.effectiveBus(), this.ctx.currentTime, 0.015);
  }

  /** Fades to `to` over `secs` from wherever the parameter is now. */
  private ramp(p: AudioParam, to: number, secs: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const from = p.value;
    p.cancelScheduledValues(t);
    p.setValueAtTime(from, t);
    p.linearRampToValueAtTime(to, t + secs);
  }

  private fadeOut(): void {
    const n = this.nodes;
    if (!n) return;
    if (n.fade.gain.value !== 0 || this.audible) this.ramp(n.fade.gain, 0, FLOOR_FADE_S);
    if (this.pauseTimer || !n.decks.some((d) => d.role !== 'idle')) return;
    // When it has faded, stop streaming: an unloaded floor or a muted radio costs no bandwidth. The live track resumes where it stopped.
    this.pauseTimer = this.timer.set(
      () => {
        this.pauseTimer = null;
        if (this.wanted()) return;
        for (const d of n.decks) this.settle(d);
      },
      FLOOR_FADE_S * 1000 + 60,
    );
  }

  /** Pauses a deck for good (fade over): a track still fading in becomes the live one, one fading out is dropped. */
  private settle(d: Deck): void {
    // Tuned off, or a track that never was: nothing to resume.
    if (d.role === 'outgoing' || !this.current) {
      this.clear(d);
      return;
    }
    if (d.role === 'incoming') {
      const live = this.deckWith('live');
      if (live) this.clear(live);
      d.role = 'live';
      d.gain.gain.cancelScheduledValues(this.ctx?.currentTime ?? 0);
      d.gain.gain.value = 1;
    }
    d.el.pause();
    d.sounding = false;
  }

  private deckWith(role: Role): Deck | null {
    return this.nodes?.decks.find((d) => d.role === role) ?? null;
  }

  /** Empties a deck: stops the stream and forgets its track. */
  private clear(d: Deck): void {
    if (d.cleanup) this.timer.clear(d.cleanup);
    d.cleanup = null;
    d.gen++;
    d.role = 'idle';
    d.track = null;
    d.sounding = false;
    d.gain.gain.cancelScheduledValues(this.ctx?.currentTime ?? 0);
    d.gain.gain.value = 0;
    try {
      d.el.pause();
      d.el.removeAttribute('src');
      d.el.load();
    } catch {
      // A torn-down element.
    }
  }

  /** Starts `t` on the idle deck; it takes over from the live one (crossfade) once it sounds. */
  private crossTo(t: Track): void {
    const n = this.nodes;
    if (!n) return;
    // An earlier request that never sounded is replaced.
    const stale = this.deckWith('incoming');
    if (stale) this.clear(stale);
    let deck = n.decks.find((d) => d.role === 'idle');
    if (!deck) {
      // Both busy (a crossfade is still running): the one fading out is cut.
      deck = n.decks.find((d) => d.role === 'outgoing') as Deck;
      this.clear(deck);
    }
    const d = deck;
    d.role = 'incoming';
    d.track = t;
    d.gen++;
    d.sounding = false;
    d.gain.gain.cancelScheduledValues(this.ctx?.currentTime ?? 0);
    d.gain.gain.value = 0;
    d.el.src = this.url(t);
    this.play(d);
  }

  private resume(d: Deck): void {
    this.play(d);
  }

  private play(d: Deck): void {
    const gen = d.gen;
    let p: Promise<void> | undefined;
    try {
      p = d.el.play();
    } catch (e) {
      this.playFailed(d, gen, e);
      return;
    }
    p?.catch((e: unknown) => this.playFailed(d, gen, e));
  }

  private playFailed(d: Deck, gen: number, e: unknown): void {
    if (this.disposed || d.gen !== gen) return;
    const name = (e as { name?: string } | null)?.name;
    // Autoplay refused (no gesture yet) or interrupted by a newer load: the next sync tries again.
    if (name === 'NotAllowedError' || name === 'AbortError') return;
    this.unplayable(d);
  }

  /** A track that cannot be loaded (its file is missing, or is not audio): skip to the next of the genre. */
  private unplayable(d: Deck): void {
    const t = d.track;
    if (!t || (d.role !== 'incoming' && d.role !== 'live')) return;
    this.event({ kind: 'skip', genre: t.genre, trackId: t.id, detail: 'unavailable' });
    this.clear(d);
    if (this.current?.id !== t.id) return;
    this.failures++;
    const size = this.queue(t.genre).size;
    if (this.failures >= size) {
      // Every track of the genre failed: stay quiet rather than loop.
      this.event({ kind: 'unavailable', genre: t.genre, detail: 'no track could be loaded' });
      return;
    }
    this.current = this.pick(t.genre);
    this.sync();
  }

  private listen(d: Deck): void {
    const el = d.el;
    el.addEventListener('playing', () => this.onPlaying(d));
    el.addEventListener('error', () => {
      if (d.track && el.getAttribute('src')) this.unplayable(d);
    });
    el.addEventListener('ended', () => {
      if (d.role === 'live' && this.current?.id === d.track?.id) this.advance();
    });
    el.addEventListener('timeupdate', () => {
      if (d.role !== 'live' || this.current?.id !== d.track?.id) return;
      const left = el.duration - el.currentTime;
      if (Number.isFinite(left) && left <= CROSSFADE_S + 0.25) this.advance();
    });
  }

  /** The current track is nearly over: the genre's next one crossfades in. */
  private advance(): void {
    const g = this.current?.genre;
    if (!g || this.genre === 'off') return;
    this.current = this.pick(g);
    this.sync();
  }

  private onPlaying(d: Deck): void {
    if (this.disposed || !this.nodes || !this.ctx) return;
    d.sounding = true;
    if (d.role === 'live') {
      // A resume after a floor fade or a stall: the same track, no announcement.
      this.host.soundStarted();
      return;
    }
    if (d.role !== 'incoming' || !d.track) return;
    this.failures = 0;
    const prev = this.deckWith('live');
    d.role = 'live';
    if (prev && prev.sounding) {
      prev.role = 'outgoing';
      this.ramp(prev.gain.gain, 0, CROSSFADE_S);
      this.ramp(d.gain.gain, 1, CROSSFADE_S);
      if (prev.cleanup) this.timer.clear(prev.cleanup);
      const pg = prev.gen;
      prev.cleanup = this.timer.set(() => {
        prev.cleanup = null;
        if (prev.gen === pg && prev.role === 'outgoing') this.clear(prev);
      }, CROSSFADE_S * 1000 + 150);
    } else {
      if (prev) this.clear(prev);
      d.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      d.gain.gain.value = 1;
    }
    this.host.soundStarted();
    this.event({ kind: 'start', genre: d.track.genre, trackId: d.track.id });
    for (const fn of this.trackListeners) fn({ track: d.track, genre: d.track.genre });
  }

  private event(e: Omit<RadioEvent, 'at'>): void {
    this.log.push({ at: this.now(), ...e });
    if (this.log.length > EVENT_CAP) this.log.shift();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pauseTimer) this.timer.clear(this.pauseTimer);
    this.trackListeners.clear();
    for (const d of this.nodes?.decks ?? []) {
      if (d.cleanup) this.timer.clear(d.cleanup);
      try {
        d.el.pause();
        d.el.removeAttribute('src');
        d.el.load();
      } catch {
        // Already gone.
      }
    }
    this.nodes = null;
  }
}

export { GENRES, genreName };
