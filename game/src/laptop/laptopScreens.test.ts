// @vitest-environment jsdom
// #52: what a desk's laptop shows, through the real controller: bridge messages (`Laptops.onConn`) go through the real
// `Watches` to `Laptops`, and `Laptops.frame` puts screens on the glass. The terminal emulator and the screen meshes are
// faked (jsdom has no 2D canvas): a fake terminal "paints" the text of its frames, the fake meshes keep what each desk
// shows, so every rendered frame can be read back.
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import type { ScreenOwner } from '../render/screens';
import { Laptops } from './index';

vi.mock('./terminal', () => {
  class LaptopTerminal {
    painted = false;
    pane: string | null = null;
    glancing = true;
    fontStack = '';
    /** What the emulator holds, and what the last paint drew. */
    private text = '';
    shown = '';
    private dirty = false;
    readonly canvas = { term: this };
    readonly texture = { term: this };
    frame(f: { pane: string; full: boolean; data: string }): boolean {
      this.pane = f.pane;
      this.text = (f.full ? '' : this.text) + atob(f.data);
      this.dirty = true;
      return true;
    }
    draw(): boolean {
      if (!this.dirty) return false;
      this.dirty = false;
      this.shown = this.text;
      this.painted = true;
      return true;
    }
    reset(): void {
      this.painted = false;
      this.pane = null;
      this.text = '';
      this.dirty = false;
    }
    lines(): string[] {
      return [this.text];
    }
    setSize(): void {}
    setGlance(): void {}
    setLook(): void {}
    setZoom(): void {}
    dispose(): void {}
  }
  return { LaptopTerminal, LIVE_SIZE: { width: 768, height: 322 } };
});

type Term = { shown: string };
type Seated = { worker: { id: string; pane_id?: string; session: string }; name: string; desk: number };

function harness() {
  let seat: Seated | null = { worker: { id: 'old', pane_id: 'p1', session: 'floor' }, name: 'Nibble', desk: 0 };
  const live = new Map<number, { term: Term }>();
  const frozen = new Map<number, { text: string; owner: ScreenOwner }>();
  const meshes = {
    setLive(desk: number, tex: { term: Term } | null) {
      if (tex) live.set(desk, tex);
      else live.delete(desk);
    },
    freeze(desk: number, canvas: { term: Term }, owner: ScreenOwner) {
      frozen.set(desk, { text: canvas.term.shown, owner: { ...owner } });
    },
    unfreeze(desk: number) {
      frozen.delete(desk);
    },
    frozenOwner: (desk: number) => frozen.get(desk)?.owner ?? null,
    isLive: (desk: number) => live.has(desk),
    isFrozen: (desk: number) => frozen.has(desk),
    slotMatrix: (_desk: number, out: THREE.Matrix4) => out.identity(),
    update() {},
    setCovered() {},
    setVisible() {},
    setFull() {},
  };
  const office = {
    isAsleep: false,
    session: 'floor',
    desksCount: 1,
    root: new THREE.Group(),
    cornerDesks: () => [],
    awayDesks: () => new Map(),
    seat: (i: number) => (i === 0 ? seat : null),
  };
  const host = {
    store: {},
    layer: document.createElement('div'),
    watch: () => new Promise(() => {}),
    send: () => new Promise(() => {}),
    unsupported: () => false,
    insets: () => ({ top: 0, bottom: 0 }),
    seat: { status() {} },
  };
  const laptops = new Laptops(host as never, new URLSearchParams('screens=0&prints=0'));
  // The floor is attached already (no new scene in any of these), and nothing else is planned: the tests watch.
  Object.assign(laptops, {
    attached: office,
    meshes,
    monitors: { frame() {}, plan() {}, covers: () => false, lost() {} },
    prints: { update() {}, wants: () => [], clear() {}, planner: { clear() {} } },
  });
  let now = 1000;
  const glass = () => live.get(0)?.term.shown ?? frozen.get(0)?.text ?? 'blank';
  /** Renders a frame (16 ms after the last) and says what desk 0's laptop shows in it. */
  const frame = () => {
    now += 16;
    laptops.frame({ now, office, onFloor: true, camera: new THREE.PerspectiveCamera(), walker: { x: 0, y: 0, z: 0, yaw: 0 }, blocked: false } as never);
    return glass();
  };
  const watch = (...ids: string[]) => laptops.watches.sync(new Map(ids.map((id) => [id, 4])));
  let n = 0;
  const output = (id: string, pane: string, text: string, full = true) => laptops.onConn({ t: 'terminal.frame', id, pane, n: full ? (n = 1) : ++n, full, cols: 120, rows: 36, data: btoa(text) });
  const closed = (id: string, reason: string) => laptops.onConn({ t: 'terminal.closed', id, reason });
  return {
    laptops,
    frame,
    watch,
    output,
    closed,
    glass,
    live,
    frozen,
    sit: (s: Seated | null) => (seat = s),
    /** Frames until the next plan has run too (the plan's pace is not what keeps the glass right). */
    frames: (k: number) => Array.from({ length: k }, frame),
    connected: (on: boolean) => Object.assign(laptops, { connected: on }),
  };
}

/** The old worker's screen live on desk 0. */
function oldLive() {
  const h = harness();
  h.watch('old');
  h.output('old', 'p1', 'OLD AGENT OUTPUT');
  expect(h.frame()).toBe('OLD AGENT OUTPUT');
  return h;
}

describe('a desk someone else sits at now', () => {
  it.each(['Nibble', 'Pixel'])('goes blank in the next frame, a new worker named %s, until its own screen has a frame', (name) => {
    const h = oldLive();
    // The office seats someone else at the desk (no new scene); the plan does not run before the next frame.
    h.sit({ worker: { id: 'new', pane_id: 'p9', session: 'floor' }, name, desk: 0 });
    expect(h.frame()).toBe('blank');
    // The bridge ends the old watch afterwards: nothing of it comes back.
    h.closed('old', 'worker_removed');
    h.watch('new');
    // The new worker's first frame takes a while: every frame meanwhile is blank.
    expect(h.frames(20)).toEqual(Array(20).fill('blank'));
    h.output('new', 'p9', 'NEW AGENT OUTPUT');
    expect(h.frame()).toBe('NEW AGENT OUTPUT');
  });

  it('also when the old watch ends before that frame (its last frame is frozen against the desk it had)', () => {
    const h = oldLive();
    h.sit({ worker: { id: 'new', pane_id: 'p9', session: 'floor' }, name: 'Nibble', desk: 0 });
    h.closed('old', 'worker_removed');
    expect(h.frame()).toBe('blank');
    h.watch('new');
    expect(h.frames(20)).toEqual(Array(20).fill('blank'));
    h.output('new', 'p9', 'NEW AGENT OUTPUT');
    expect(h.frame()).toBe('NEW AGENT OUTPUT');
  });

  it('forgets the frozen screen of the worker who left, in the next frame', () => {
    const h = oldLive();
    h.watch(); // walked away: the old worker's screen is frozen
    expect(h.frame()).toBe('OLD AGENT OUTPUT');
    h.sit({ worker: { id: 'new', pane_id: 'p9', session: 'floor' }, name: 'Nibble', desk: 0 });
    expect(h.frame()).toBe('blank');
    h.sit(null);
    expect(h.frame()).toBe('blank');
  });
});

describe('a new pane under the same worker (pane_changed)', () => {
  it('goes blank at once and stays blank until the new pane’s first frame, when the watch closes first', () => {
    const h = oldLive();
    h.closed('old', 'pane_changed');
    expect(h.glass()).toBe('blank');
    expect(h.frozen.size).toBe(0);
    expect(h.frame()).toBe('blank');
    // Then the worker's new pane arrives, and the next sync watches it; its first frame takes a while.
    h.sit({ worker: { id: 'old', pane_id: 'p2', session: 'floor' }, name: 'Nibble', desk: 0 });
    h.watch('old');
    expect(h.frames(20)).toEqual(Array(20).fill('blank'));
    expect(h.laptops.text('old')).toBeNull();
    h.output('old', 'p2', 'NEW PANE OUTPUT');
    expect(h.frame()).toBe('NEW PANE OUTPUT');
  });

  it('goes blank in the next frame when the new pane is known first, and late frames of the old pane stay off the glass', () => {
    const h = oldLive();
    h.sit({ worker: { id: 'old', pane_id: 'p2', session: 'floor' }, name: 'Nibble', desk: 0 });
    expect(h.frame()).toBe('blank');
    h.output('old', 'p1', ' MORE OF THE OLD PANE', false);
    expect(h.frame()).toBe('blank');
    h.closed('old', 'pane_changed');
    h.watch('old');
    expect(h.frames(20)).toEqual(Array(20).fill('blank'));
    h.output('old', 'p2', 'NEW PANE OUTPUT');
    expect(h.frame()).toBe('NEW PANE OUTPUT');
  });

  it('forgets a frozen screen of the old pane once the worker has another', () => {
    const h = oldLive();
    h.watch();
    expect(h.frame()).toBe('OLD AGENT OUTPUT');
    h.sit({ worker: { id: 'old', pane_id: 'p2', session: 'floor' }, name: 'Nibble', desk: 0 });
    expect(h.frame()).toBe('blank');
  });
});

describe('the same worker and pane', () => {
  it('walking away keeps its last frame on the laptop, past the next plan, and shows it until it is live again', () => {
    const h = oldLive();
    h.watch(); // an ordinary unwatch: out of range
    expect(h.frames(20)).toEqual(Array(20).fill('OLD AGENT OUTPUT'));
    expect(h.frozen.get(0)?.owner).toEqual({ id: 'old', pane: 'p1' });
    h.watch('old');
    expect(h.frames(5)).toEqual(Array(5).fill('OLD AGENT OUTPUT'));
    h.output('old', 'p1', 'OLD AGENT, LATER');
    expect(h.frame()).toBe('OLD AGENT, LATER');
  });

  it('a dropped connection keeps its last frame; watched again after the reconnect, it goes on', () => {
    const h = oldLive();
    h.connected(true);
    h.laptops.setConnected(false);
    expect(h.frames(20)).toEqual(Array(20).fill('OLD AGENT OUTPUT'));
    h.watch('old');
    h.output('old', 'p1', 'OLD AGENT, LATER');
    expect(h.frame()).toBe('OLD AGENT, LATER');
  });

  it('a worker with no pane now keeps the screen of its last one', () => {
    const h = oldLive();
    h.closed('old', 'worker_removed');
    h.sit({ worker: { id: 'old', session: 'floor' }, name: 'Nibble', desk: 0 });
    expect(h.frames(20)).toEqual(Array(20).fill('OLD AGENT OUTPUT'));
  });
});
