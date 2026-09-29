import type * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { Genre, Track } from './tracks';
import { AUDIO_PREFS_KEY, createGameAudio, type AudioDeps, type Playback } from './index';

/** Just enough of an AudioContext to watch what the module does with it. */
class FakeParam {
  value = 0;
  targets: number[] = [];
  /** Linear ramps asked for: where to, and how many seconds from the context's clock. */
  ramps: Array<{ to: number; secs: number }> = [];
  private from = 0;
  setTargetAtTime(v: number) {
    this.targets.push(v);
    this.value = v;
  }
  setValueAtTime(v: number, t: number) {
    this.value = v;
    this.from = t;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.ramps.push({ to: v, secs: Math.round((t - this.from) * 1000) / 1000 });
    this.value = v;
  }
  cancelScheduledValues() {}
}

class FakeNode {
  connected: FakeNode[] = [];
  connect(n: FakeNode) {
    this.connected.push(n);
    return n;
  }
  disconnect() {
    this.connected = [];
  }
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
  started = 0;
  stopped = 0;
  onended: (() => void) | null = null;
  start() {
    this.started++;
  }
  stop() {
    this.stopped++;
    this.onended?.();
  }
}

class FakePanner extends FakeNode {
  panningModel = '';
  distanceModel = '';
  refDistance = 1;
  rolloffFactor = 1;
  positionX = new FakeParam();
  positionY = new FakeParam();
  positionZ = new FakeParam();
}

class FakeContext {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 0;
  destination = new FakeNode();
  listener = Object.fromEntries(['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ'].map((k) => [k, new FakeParam()])) as Record<string, FakeParam>;
  gains: Array<FakeNode & { gain: FakeParam }> = [];
  sources: FakeSource[] = [];
  panners: FakePanner[] = [];
  decoded: number[] = [];
  resumes = 0;
  /** A browser that refuses to resume outside a gesture. */
  refuse = false;
  private handlers: Array<() => void> = [];
  createGain() {
    const g = Object.assign(new FakeNode(), { gain: new FakeParam() });
    this.gains.push(g);
    return g;
  }
  mediaSources = 0;
  createMediaElementSource(_el: unknown) {
    this.mediaSources++;
    return new FakeNode();
  }
  createPanner() {
    const p = new FakePanner();
    this.panners.push(p);
    return p;
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  async decodeAudioData(b: ArrayBuffer) {
    this.decoded.push(b.byteLength);
    return { duration: b.byteLength / 1000 };
  }
  async resume() {
    this.resumes++;
    if (this.refuse) throw new Error('NotAllowedError');
    this.state = 'running';
    for (const h of this.handlers) h();
  }
  async close() {
    this.state = 'closed';
  }
  addEventListener(_: string, h: () => void) {
    this.handlers.push(h);
  }
}

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

function setup(over: Partial<AudioDeps> & { made?: FakeContext[] } = {}) {
  const made = over.made ?? [];
  const loads: string[] = [];
  const events = new EventTarget();
  const storage = new MemoryStorage();
  const audio = createGameAudio({
    context: () => {
      const c = new FakeContext();
      made.push(c);
      return c as unknown as AudioContext;
    },
    load: async (url) => {
      loads.push(url);
      return new ArrayBuffer(2500);
    },
    storage,
    events,
    url: (c) => `/voices/${c}.mp3`,
    ...over,
  });
  return { audio, made, loads, events, storage };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Clip loads the test resolves by hand, in any order. */
function heldLoads() {
  const held = new Map<string, () => void>();
  const load = (url: string) => new Promise<ArrayBuffer>((r) => held.set(url, () => r(new ArrayBuffer(2500))));
  const release = (clip: string) => held.get(`/voices/${clip}.mp3`)?.();
  return { load, release };
}

/** What a Playback has reported so far. */
function watch(pb: Playback) {
  const w = { started: null as boolean | null, ended: false };
  void pb.started.then((ok) => (w.started = ok));
  void pb.ended.then(() => (w.ended = true));
  return w;
}

/** A camera at (x, y, z) looking down -Z, as a world matrix. */
const camera = (x: number, y: number, z: number) =>
  ({ matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1] } }) as unknown as THREE.Camera;

describe('game audio', () => {
  it('degrades to silence without Web Audio', async () => {
    const audio = createGameAudio({ context: null, storage: null, events: null });
    expect(audio.available).toBe(false);
    expect(audio.state).toBe('none');
    await audio.unlock();
    audio.playAt('receptionist/goodbye-1', { x: 0, y: 1, z: 0 });
    audio.setListener(camera(0, 1.5, 3));
    audio.volume = 0.3;
    audio.muted = true;
    expect(audio.duration('receptionist/goodbye-1')).toBeNull();
    audio.dispose();
    // The default in Node (no window): no AudioContext either.
    expect(createGameAudio({ storage: null }).available).toBe(false);
  });

  it('makes the context after the first gesture, not before, and stops listening once running', async () => {
    const { audio, made, events, loads } = setup();
    expect(audio.state).toBe('idle');
    audio.playAt('receptionist/a', { x: 0, y: 0, z: 0 });
    await flush();
    expect(made).toHaveLength(0);
    expect(loads).toEqual([]); // nothing loads before a gesture: it couldn't play anyway
    events.dispatchEvent(new Event('pointerdown'));
    // Not inside the handler (it costs a few frames): right after it.
    expect(made).toHaveLength(0);
    events.dispatchEvent(new Event('keydown'));
    await flush();
    expect(made).toHaveLength(1);
    expect(made[0]?.resumes).toBe(1);
    expect(audio.state).toBe('running');
    events.dispatchEvent(new Event('keydown'));
    events.dispatchEvent(new Event('pointerlockchange'));
    await flush();
    expect(made).toHaveLength(1);
    expect(made[0]?.resumes).toBe(1);
  });

  it('retries the unlock on the next gesture when the browser refused', async () => {
    const made: FakeContext[] = [];
    const { audio, events } = setup({
      context: () => {
        const c = new FakeContext();
        c.refuse = true;
        made.push(c);
        return c as unknown as AudioContext;
      },
    });
    events.dispatchEvent(new Event('keydown'));
    await flush();
    expect(audio.state).toBe('locked');
    const ctx = made[0];
    if (!ctx) throw new Error('no context');
    ctx.refuse = false;
    events.dispatchEvent(new Event('pointerdown'));
    await flush();
    expect(made).toHaveLength(1);
    expect(ctx.resumes).toBe(2);
    expect(audio.state).toBe('running');
  });

  it('loads and decodes a clip lazily, once, and plays it at the given point', async () => {
    const { audio, made, loads } = setup();
    await audio.unlock();
    const ctx = made[0];
    if (!ctx) throw new Error('no context');
    expect(loads).toEqual([]);
    expect(audio.duration('receptionist/welcome')).toBeNull();
    audio.playAt('receptionist/welcome', { x: 1, y: 1.6, z: -2 });
    // Nothing happens synchronously: fetch + decode resolve later.
    expect(ctx.sources).toHaveLength(0);
    await flush();
    expect(loads).toEqual(['/voices/receptionist/welcome.mp3']);
    expect(ctx.decoded).toEqual([2500]);
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]?.started).toBe(1);
    expect(audio.duration('receptionist/welcome')).toBe(2.5);
    const p = ctx.panners[0];
    expect(p).toMatchObject({ panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 2, rolloffFactor: 0.75 });
    expect([p?.positionX.value, p?.positionY.value, p?.positionZ.value]).toEqual([1, 1.6, -2]);
    // source → panner → master → destination
    expect(ctx.sources[0]?.connected[0]).toBe(p);
    expect(p?.connected[0]).toBe(ctx.gains[0]);
    expect(ctx.gains[0]?.connected[0]).toBe(ctx.destination);

    audio.playAt('receptionist/welcome', { x: 0, y: 0, z: 0 });
    await flush();
    expect(loads).toHaveLength(1);
    expect(ctx.decoded).toHaveLength(1);
    expect(ctx.sources).toHaveLength(2);
  });

  it('places the listener at the camera, only while something plays', async () => {
    const { audio, made } = setup();
    await audio.unlock();
    const ctx = made[0];
    if (!ctx) throw new Error('no context');
    audio.setListener(camera(4, 1.55, 6));
    expect(ctx.listener.positionX?.value).toBe(0);
    audio.playAt('receptionist/x', { x: 0, y: 1.5, z: 0 });
    await flush();
    const L = ctx.listener;
    expect([L.positionX?.value, L.positionY?.value, L.positionZ?.value]).toEqual([4, 1.55, 6]);
    expect([L.forwardX?.value, L.forwardY?.value, L.forwardZ?.value]).toEqual([0, 0, -1]);
    expect([L.upX?.value, L.upY?.value, L.upZ?.value]).toEqual([0, 1, 0]);
    audio.setListener(camera(5, 1.55, 6));
    expect(L.positionX?.value).toBe(5);
    ctx.sources[0]?.onended?.();
    audio.setListener(camera(9, 1.55, 6));
    expect(L.positionX?.value).toBe(5);
  });

  it('remembers mute and volume per browser, and applies them to the master gain', async () => {
    const { audio, made, storage } = setup();
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBe(0.8);
    let changes = 0;
    const off = audio.onChange(() => changes++);
    audio.volume = 0.35;
    audio.muted = true;
    expect(JSON.parse(storage.getItem(AUDIO_PREFS_KEY) ?? '{}')).toEqual({ muted: true, volume: 0.35, music: { volume: 0.4, muted: false, genre: 'house' } });
    expect(changes).toBe(2);
    off();
    audio.volume = 7;
    expect(audio.volume).toBe(1);
    expect(changes).toBe(2);

    // A new page in the same browser.
    const again = setup({ storage });
    expect(again.audio.muted).toBe(true);
    expect(again.audio.volume).toBe(1);
    await again.audio.unlock();
    const g = again.made[0]?.gains[0];
    expect(g?.gain.value).toBe(0);
    again.audio.muted = false;
    expect(g?.gain.targets.at(-1)).toBe(1);
    again.audio.volume = 0.5;
    expect(g?.gain.targets.at(-1)).toBe(0.5);
    expect(made).toHaveLength(0);
  });

  it('survives broken or blocked storage', () => {
    const junk = new MemoryStorage();
    junk.setItem(AUDIO_PREFS_KEY, '{nope');
    expect(setup({ storage: junk }).audio.volume).toBe(0.8);
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const { audio } = setup({ storage: blocked });
    expect(audio.muted).toBe(false);
    audio.muted = true;
    expect(audio.muted).toBe(true);
  });

  it('muted: loads and plays nothing; muting stops what plays', async () => {
    const { audio, made, loads } = setup();
    await audio.unlock();
    const ctx = made[0];
    if (!ctx) throw new Error('no context');
    audio.playAt('receptionist/a', { x: 0, y: 0, z: 0 });
    await flush();
    expect(ctx.sources[0]?.started).toBe(1);
    audio.muted = true;
    expect(ctx.sources[0]?.stopped).toBe(1);
    audio.playAt('receptionist/b', { x: 0, y: 0, z: 0 });
    await flush();
    expect(loads).toEqual(['/voices/receptionist/a.mp3']);
    expect(ctx.sources).toHaveLength(1);
  });

  it('stop() drops a clip still loading; dispose() closes the context', async () => {
    const { audio, made } = setup();
    await audio.unlock();
    const ctx = made[0];
    if (!ctx) throw new Error('no context');
    audio.playAt('receptionist/a', { x: 0, y: 0, z: 0 });
    audio.stop();
    await flush();
    expect(ctx.sources).toHaveLength(0);
    audio.preload('receptionist/a');
    audio.playAt('receptionist/a', { x: 0, y: 0, z: 0 });
    await flush();
    expect(ctx.sources).toHaveLength(1);
    audio.dispose();
    expect(ctx.state).toBe('closed');
    expect(ctx.sources[0]?.stopped).toBe(1);
    audio.playAt('receptionist/a', { x: 0, y: 0, z: 0 });
    await flush();
    expect(ctx.sources).toHaveLength(1);
  });

  it('playAt reports when the clip really starts (after its load) and when it ends', async () => {
    const loads = heldLoads();
    const { audio, made } = setup({ load: loads.load });
    await audio.unlock();
    const ctx = made[0];
    if (!ctx) throw new Error('no context');
    const a = watch(audio.playAt('receptionist/a', { x: 0, y: 0, z: 0 }));
    const b = watch(audio.playAt('receptionist/b', { x: 0, y: 0, z: 0 }));
    await flush();
    expect(a).toEqual({ started: null, ended: false });
    // Out of order: b's load comes back first, so b sounds first (the caller sequences lines, see reception/sequence.ts).
    loads.release('receptionist/b');
    await flush();
    expect(b).toEqual({ started: true, ended: false });
    expect(a.started).toBeNull();
    loads.release('receptionist/a');
    await flush();
    expect(a).toEqual({ started: true, ended: false });
    expect(ctx.sources).toHaveLength(2);
    ctx.sources[1]?.onended?.();
    await flush();
    expect(a.ended).toBe(true);
    expect(b.ended).toBe(false);
  });

  it('a cancelled clip never starts, even when its load comes back later; cancel() stops one playing', async () => {
    const loads = heldLoads();
    const { audio, made } = setup({ load: loads.load });
    await audio.unlock();
    const ctx = made[0];
    if (!ctx) throw new Error('no context');
    const pa = audio.playAt('receptionist/a', { x: 0, y: 0, z: 0 });
    const a = watch(pa);
    pa.cancel();
    await flush();
    expect(a).toEqual({ started: false, ended: true });
    loads.release('receptionist/a');
    await flush();
    expect(ctx.sources).toHaveLength(0);

    const pb = audio.playAt('receptionist/b', { x: 0, y: 0, z: 0 });
    const b = watch(pb);
    loads.release('receptionist/b');
    await flush();
    expect(b).toEqual({ started: true, ended: false });
    pb.cancel();
    await flush();
    expect(ctx.sources[0]?.stopped).toBe(1);
    expect(b.ended).toBe(true);
  });

  it('stop() settles clips still loading and playing, even without an ended event', async () => {
    const loads = heldLoads();
    const { audio, made } = setup({ load: loads.load });
    await audio.unlock();
    const ctx = made[0];
    if (!ctx) throw new Error('no context');
    const a = watch(audio.playAt('receptionist/a', { x: 0, y: 0, z: 0 }));
    loads.release('receptionist/a');
    await flush();
    const b = watch(audio.playAt('receptionist/b', { x: 0, y: 0, z: 0 }));
    // A suspended context doesn't fire `ended` for a stopped source.
    const src = ctx.sources[0];
    if (!src) throw new Error('no source');
    src.stop = () => {
      src.stopped++;
    };
    audio.stop();
    loads.release('receptionist/b');
    await flush();
    expect(a).toEqual({ started: true, ended: true });
    expect(b).toEqual({ started: false, ended: true });
    expect(ctx.sources).toHaveLength(1);
  });

  it('muted, locked or without Web Audio: the handle says at once that nothing will sound', async () => {
    const none = watch(createGameAudio({ context: null, storage: null, events: null }).playAt('receptionist/a', { x: 0, y: 0, z: 0 }));
    const idle = setup();
    const locked = watch(idle.audio.playAt('receptionist/a', { x: 0, y: 0, z: 0 }));
    const muted = setup();
    muted.audio.muted = true;
    const m = watch(muted.audio.playAt('receptionist/a', { x: 0, y: 0, z: 0 }));
    await flush();
    for (const w of [none, locked, m]) expect(w).toEqual({ started: false, ended: true });
  });

  it('a clip that fails to load stays silent', async () => {
    const { audio, made } = setup({
      load: async () => {
        throw new Error('404');
      },
    });
    await audio.unlock();
    audio.playAt('receptionist/missing', { x: 0, y: 0, z: 0 });
    await flush();
    expect(made[0]?.sources).toHaveLength(0);
    expect(audio.duration('receptionist/missing')).toBeNull();
  });
});

// ---- the office radio (M15) ---------------------------------------------------------------------------

/** An `HTMLAudioElement` that streams from a set of files: unknown URLs fail like a 404. */
class FakeElement extends EventTarget {
  paused = true;
  currentTime = 0;
  duration = Number.NaN;
  preload = '';
  plays = 0;
  private attrs = new Map<string, string>();
  constructor(private readonly exists: (url: string) => boolean) {
    super();
  }
  get src(): string {
    return this.attrs.get('src') ?? '';
  }
  set src(v: string) {
    this.attrs.set('src', v);
  }
  getAttribute(n: string) {
    return this.attrs.get(n) ?? null;
  }
  removeAttribute(n: string) {
    this.attrs.delete(n);
  }
  load() {}
  pause() {
    this.paused = true;
  }
  async play() {
    this.plays++;
    this.paused = false;
    await Promise.resolve();
    if (!this.exists(this.src)) {
      this.paused = true;
      this.dispatchEvent(new Event('error'));
      throw Object.assign(new Error('The element has no supported sources.'), { name: 'NotSupportedError' });
    }
    this.dispatchEvent(new Event('playing'));
  }
  /** The stream is `left` seconds from its end. */
  nearEnd(left: number) {
    this.duration = 200;
    this.currentTime = 200 - left;
    this.dispatchEvent(new Event('timeupdate'));
  }
}

const GENRE_IDS: Genre[] = ['house', 'jazz', 'rock', 'pop', 'rap'];
const catalogue = (g: Genre): Track[] => Array.from({ length: 5 }, (_, i) => ({ id: `${g}-${i + 1}`, genre: g, title: `${g} ${i + 1}`, artist: 'Artist', durationSec: 200 }));

/** A manual clock for the fade-out pause and the crossfade cleanup. */
function manualTimers() {
  let now = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  return {
    set: (fn: () => void, ms: number) => {
      pending.set(next, { at: now + ms, fn });
      return next++;
    },
    clear: (h: unknown) => void pending.delete(h as number),
    /** Runs what falls due within `ms`. */
    advance(ms: number) {
      now += ms;
      for (const [k, t] of [...pending]) if (t.at <= now) (pending.delete(k), t.fn());
    },
    get count() {
      return pending.size;
    },
  };
}

/** A seeded shuffle, so a failing run replays. */
const lcg = (seed = 7) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

function radio(over: { missing?: (url: string) => boolean; storage?: MemoryStorage; context?: AudioDeps['context'] } = {}) {
  const els: FakeElement[] = [];
  const timers = manualTimers();
  const s = setup({
    ...(over.storage ? { storage: over.storage } : {}),
    ...(over.context !== undefined ? { context: over.context } : {}),
    music: {
      element: () => {
        const e = new FakeElement((url) => !over.missing?.(url));
        els.push(e);
        return e as unknown as HTMLAudioElement;
      },
      url: (t) => `/music/${t.genre}/${t.id}.ogg`,
      tracks: catalogue,
      random: lcg(),
      timer: timers,
    },
  });
  const started: string[] = [];
  s.audio.music.onTrack((n) => started.push(n.track.id));
  const bus = () => (s.made[0] as FakeContext).gains[1] as { gain: FakeParam };
  const fade = () => (s.made[0] as FakeContext).gains[2] as { gain: FakeParam };
  const deckGain = (i: number) => (s.made[0] as FakeContext).gains[3 + i] as { gain: FakeParam };
  /** Enter the floor with the radio: unlock (the first gesture), radio on, let the decks start. */
  const enter = async () => {
    await s.audio.unlock();
    s.audio.music.setActive(true);
    await flush();
  };
  return { ...s, els, timers, started, bus, fade, deckGain, enter, music: s.audio.music };
}

describe('the office radio', () => {
  it('is Melodic house at 0.4 for a first-time player, and its settings are the music bus’s own, saved with the others', async () => {
    const r = radio();
    expect(r.music.state).toMatchObject({ genre: 'house', volume: 0.4, muted: false });
    r.music.volume = 0.25;
    r.music.muted = true;
    r.music.setGenre('rock');
    expect(JSON.parse(r.storage.getItem(AUDIO_PREFS_KEY) as string)).toEqual({ muted: false, volume: 0.8, music: { volume: 0.25, muted: true, genre: 'rock' } });
    // Its own gain: the master slider and the music slider do not touch each other.
    await r.audio.unlock();
    expect(r.bus().gain.value).toBe(0);
    r.music.muted = false;
    expect(r.bus().gain.targets.at(-1)).toBe(0.25);
    r.audio.volume = 0.5;
    expect((r.made[0] as FakeContext).gains[0]?.gain.targets.at(-1)).toBe(0.5);
    expect(r.bus().gain.targets.at(-1)).toBe(0.25);
    // A new page reads them back; the old master-only shape still loads.
    const again = radio({ storage: r.storage });
    expect(again.music.state).toMatchObject({ genre: 'rock', volume: 0.25, muted: false });
    const old = new MemoryStorage();
    old.setItem(AUDIO_PREFS_KEY, JSON.stringify({ muted: true, volume: 0.3 }));
    const legacy = radio({ storage: old });
    expect(legacy.audio.muted).toBe(true);
    expect(legacy.music.state).toMatchObject({ genre: 'house', volume: 0.4, muted: false });
  });

  it('streams the first track once you are on a floor and the first gesture unlocked sound', async () => {
    const r = radio();
    r.music.setActive(true);
    await flush();
    expect(r.els).toHaveLength(0); // nothing before the gesture
    expect(r.music.state.playing).toBe(false);
    await r.enter();
    expect(r.els).toHaveLength(2);
    expect(r.made[0]?.mediaSources).toBe(2);
    const live = r.els.find((e) => !e.paused) as FakeElement;
    expect(live.src).toMatch(/^\/music\/house\/house-[1-5]\.ogg$/);
    expect(r.music.state).toMatchObject({ genre: 'house', playing: true, trackId: live.src.split('/').pop()?.replace('.ogg', '') });
    expect(r.started).toEqual([r.music.state.trackId]);
    // The radio comes from its place, HRTF, not from the listener.
    r.music.setPosition({ x: 0.3, y: 1, z: 4.6 });
    const panner = r.made[0]?.panners.at(-1) as FakePanner;
    expect([panner.positionX.value, panner.positionY.value, panner.positionZ.value]).toEqual([0.3, 1, 4.6]);
    expect(panner.panningModel).toBe('HRTF');
  });

  it('stop() (the receptionist’s) leaves the music playing', async () => {
    const r = radio();
    await r.enter();
    r.audio.stop();
    expect(r.els.some((e) => !e.paused)).toBe(true);
    expect(r.music.state.playing).toBe(true);
  });

  it('crossfades two decks on a genre change: the new genre fades in while the old fades out, then the old is emptied', async () => {
    const r = radio();
    await r.enter();
    const [a, b] = r.els as [FakeElement, FakeElement];
    r.music.setGenre('jazz');
    await flush();
    // The old deck kept playing until the new one sounded; now both are on.
    expect(a.paused).toBe(false);
    expect(b.paused).toBe(false);
    expect(a.src).toContain('/house/');
    expect(b.src).toContain('/jazz/');
    expect(r.deckGain(0).gain.ramps.at(-1)).toEqual({ to: 0, secs: 1.5 });
    expect(r.deckGain(1).gain.ramps.at(-1)).toEqual({ to: 1, secs: 1.5 });
    expect(r.music.state.genre).toBe('jazz');
    r.timers.advance(1700);
    expect(a.paused).toBe(true);
    expect(a.getAttribute('src')).toBeNull();
    expect(b.paused).toBe(false);
    expect(r.started).toHaveLength(2);
    // And back: the decks swap roles.
    r.music.setGenre('house');
    await flush();
    expect(a.src).toContain('/house/');
    expect(r.deckGain(0).gain.ramps.at(-1)).toEqual({ to: 1, secs: 1.5 });
    expect(r.deckGain(1).gain.ramps.at(-1)).toEqual({ to: 0, secs: 1.5 });
  });

  it('E goes Off → Melodic house → Soft jazz → Rock → Pop → Rap → Off, saved; Off stops the stream', async () => {
    const r = radio();
    r.music.setGenre('off');
    expect(r.music.state).toMatchObject({ genre: 'off', trackId: null, playing: false });
    await r.enter();
    expect(r.els.every((e) => e.paused)).toBe(true);
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) seen.push(r.music.cycleGenre());
    expect(seen).toEqual(['house', 'jazz', 'rock', 'pop', 'rap', 'off']);
    await flush();
    r.timers.advance(2000);
    expect(r.els.every((e) => e.paused && e.getAttribute('src') === null)).toBe(true);
    expect(JSON.parse(r.storage.getItem(AUDIO_PREFS_KEY) as string).music.genre).toBe('off');
    expect(r.music.events.filter((e) => e.kind === 'genre').map((e) => e.genre)).toEqual(['off', 'house', 'jazz', 'rock', 'pop', 'rap', 'off']);
  });

  it('shuffles: no track repeats until the whole genre has played, and a new round never opens with the last track', async () => {
    const r = radio();
    await r.enter();
    const picks = [r.music.state.trackId as string];
    for (let i = 0; i < 14; i++) {
      r.music.nextTrack();
      picks.push(r.music.state.trackId as string);
    }
    const rounds = [picks.slice(0, 5), picks.slice(5, 10), picks.slice(10, 15)];
    for (const round of rounds) expect(new Set(round).size).toBe(5);
    expect(rounds[1]?.[0]).not.toBe(rounds[0]?.[4]);
    expect(rounds[2]?.[0]).not.toBe(rounds[1]?.[4]);
    // Every skip started the next track on the idle deck.
    await flush();
    expect(r.music.state).toMatchObject({ playing: true, trackId: picks[14] });
  });

  it('returning to a genre resumes from its next track, not from the start', async () => {
    const r = radio();
    await r.enter();
    const firstHouse = r.music.state.trackId as string;
    r.music.setGenre('jazz');
    const firstJazz = r.music.state.trackId as string;
    r.music.setGenre('house');
    const secondHouse = r.music.state.trackId as string;
    expect(secondHouse).not.toBe(firstHouse);
    r.music.setGenre('jazz');
    const secondJazz = r.music.state.trackId as string;
    expect(secondJazz).not.toBe(firstJazz);
    // The queue kept its place: five distinct house tracks before any repeats.
    const house = new Set([firstHouse, secondHouse]);
    r.music.setGenre('house');
    for (let i = 0; i < 3; i++) {
      house.add(r.music.state.trackId as string);
      r.music.nextTrack();
    }
    house.add(r.music.state.trackId as string);
    expect(house.size).toBe(5);
  });

  it('fades out on floor unload (0.5 s), stops streaming, and fades back in with the same track and no new announcement', async () => {
    const r = radio();
    await r.enter();
    const track = r.music.state.trackId;
    const live = r.els.find((e) => !e.paused) as FakeElement;
    expect(r.fade().gain.ramps.at(-1)).toEqual({ to: 1, secs: 0.5 });
    r.music.setActive(false);
    expect(r.music.state.playing).toBe(false);
    expect(r.fade().gain.ramps.at(-1)).toEqual({ to: 0, secs: 0.5 });
    expect(live.paused).toBe(false); // still fading
    r.timers.advance(700);
    expect(live.paused).toBe(true);
    expect(live.src).toContain(String(track)); // it resumes where it stopped
    r.music.setActive(true);
    await flush();
    expect(live.paused).toBe(false);
    expect(r.music.state).toMatchObject({ playing: true, trackId: track });
    expect(r.fade().gain.ramps.at(-1)).toEqual({ to: 1, secs: 0.5 });
    expect(r.started).toHaveLength(1);
    expect(r.music.events.filter((e) => e.kind === 'fade').map((e) => e.detail)).toEqual(['in', 'out', 'in']);
    // Coming back before the fade-out finished cancels the pause.
    r.music.setActive(false);
    r.timers.advance(200);
    r.music.setActive(true);
    r.timers.advance(2000);
    expect(live.paused).toBe(false);
  });

  it('a missing track file is skipped to the next track, without throwing; none at all stays quiet', async () => {
    const r = radio({ missing: (url) => url.includes('house-1') || url.includes('house-2') });
    let first: string | null = null;
    r.music.onTrack((n) => (first ??= n.track.id));
    await r.enter();
    await flush();
    await flush();
    expect(r.music.state.playing).toBe(true);
    expect(first).not.toMatch(/house-[12]$/);
    const skipped = r.music.events.filter((e) => e.kind === 'skip').map((e) => e.trackId);
    for (const id of skipped) expect(['house-1', 'house-2']).toContain(id);

    const none = radio({ missing: () => true });
    await none.enter();
    for (let i = 0; i < 12; i++) await flush();
    expect(none.music.state.playing).toBe(false);
    expect(none.music.events.filter((e) => e.kind === 'skip')).toHaveLength(5); // each track once, no loop
    expect(none.music.events.some((e) => e.kind === 'unavailable')).toBe(true);
    expect(none.started).toEqual([]);
    // Another genre is tried afresh.
    none.music.setGenre('jazz');
    await flush();
    expect(none.music.events.filter((e) => e.kind === 'skip')).toBeTruthy();
  });

  it('moves on by itself: the next track crossfades in near the end of this one, and after it if the stream just ends', async () => {
    const r = radio();
    await r.enter();
    const first = r.music.state.trackId;
    const live = r.els.find((e) => !e.paused) as FakeElement;
    live.nearEnd(60);
    expect(r.music.state.trackId).toBe(first);
    live.nearEnd(1.2);
    await flush();
    const second = r.music.state.trackId;
    expect(second).not.toBe(first);
    expect(r.started).toEqual([first, second]);
    const next = r.els.find((e) => e !== live && !e.paused) as FakeElement;
    live.nearEnd(1.0); // the old deck is fading out: not the live one any more
    expect(r.music.state.trackId).toBe(second);
    r.timers.advance(1700);
    next.dispatchEvent(new Event('ended'));
    await flush();
    expect(r.music.state.trackId).not.toBe(second);
  });

  it('mutes: music mute or master mute pauses the stream, unmuting brings it back', async () => {
    const r = radio();
    await r.enter();
    const live = r.els.find((e) => !e.paused) as FakeElement;
    r.music.muted = true;
    expect(r.music.state).toMatchObject({ muted: true, playing: false });
    r.timers.advance(700);
    expect(live.paused).toBe(true);
    r.music.muted = false;
    await flush();
    expect(live.paused).toBe(false);
    expect(r.music.state.playing).toBe(true);
    r.audio.muted = true;
    expect(r.music.state.playing).toBe(false);
    r.timers.advance(700);
    expect(live.paused).toBe(true);
    r.audio.muted = false;
    await flush();
    expect(r.music.state.playing).toBe(true);
    expect(r.started).toHaveLength(1);
  });

  it('is silent, and never throws, without Web Audio, before the first gesture, or when the browser keeps the context locked', async () => {
    const none = createGameAudio({ context: null, storage: null, events: null });
    none.music.setActive(true);
    none.music.setGenre('rock');
    none.music.nextTrack();
    none.music.setPosition({ x: 1, y: 1, z: 1 });
    expect(none.music.cycleGenre()).toBe('pop');
    expect(none.music.state.playing).toBe(false);
    none.dispose();

    let ctx!: FakeContext;
    const locked = radio({
      context: () => {
        ctx = new FakeContext();
        ctx.refuse = true;
        return ctx as unknown as AudioContext;
      },
    });
    locked.music.setActive(true);
    await locked.audio.unlock();
    locked.music.setGenre('jazz');
    await flush();
    expect(locked.audio.state).toBe('locked');
    expect(locked.els.every((e) => e.paused && e.plays === 0)).toBe(true);
    expect(locked.music.state).toMatchObject({ genre: 'jazz', playing: false });
    // The gesture that finally unlocks it starts the radio.
    ctx.refuse = false;
    await locked.audio.unlock();
    await flush();
    expect(locked.music.state.playing).toBe(true);
  });

  it('keeps the listener on the camera while only the radio plays', async () => {
    const r = radio();
    await r.enter();
    r.audio.setListener(camera(2, 1.6, 5));
    const l = (r.made[0] as FakeContext).listener;
    expect([l.positionX?.value, l.positionZ?.value]).toEqual([2, 5]);
    r.audio.setListener(camera(3, 1.6, 6));
    expect(l.positionX?.value).toBe(3);
  });

  it('every genre of the catalogue has tracks to shuffle (the default catalogue is the manifest)', async () => {
    for (const g of GENRE_IDS) expect(catalogue(g)).toHaveLength(5);
  });
});
