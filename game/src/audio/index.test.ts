import type * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { AUDIO_PREFS_KEY, createGameAudio, type AudioDeps, type Playback } from './index';

/** Just enough of an AudioContext to watch what the module does with it. */
class FakeParam {
  value = 0;
  targets: number[] = [];
  setTargetAtTime(v: number) {
    this.targets.push(v);
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
    expect(JSON.parse(storage.getItem(AUDIO_PREFS_KEY) ?? '{}')).toEqual({ muted: true, volume: 0.35 });
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
