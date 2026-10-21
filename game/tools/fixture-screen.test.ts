import { Terminal } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import { KEY_NAMES } from '../src/laptop/keys';
import { loadFixture } from './fixture-server';
import { loadRecording, SIM_MAX_WATCHES } from './fixture-screen';
import { SimWorld } from './fixture-sim';

type Msg = Record<string, unknown>;

/** A sim on demo-m4 with a fake clock: `advance(ms)` runs what is due, in order. */
function rig(fail?: string, zoom?: 'old' | 'single' | 'split' | 'headless', screen?: 'narrow', control?: 'old' | 'none' | 'busy') {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const { snapshot } = loadFixture('demo-m4');
  const sim = new SimWorld(snapshot as never, {
    fail,
    ...(zoom ? { zoom } : {}),
    ...(screen ? { screen } : {}),
    ...(control ? { control } : {}),
    stepMs: 100,
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(++id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => timers.delete(h as number),
  });
  const out: Msg[] = [];
  let n = 0;
  const cmd = (t: string, args: unknown) => {
    const req_id = `r${++n}`;
    const from = out.length;
    sim.handle({ t, req_id, args }, (m) => out.push(m));
    return { req_id, got: () => out.slice(from), reply: () => out.find((m) => m.req_id === req_id) };
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
    }
    now = end;
  };
  const frames = (wid?: string) => out.filter((m) => m.t === 'terminal.frame' && (!wid || m.id === wid)) as Array<Msg & { n: number; full: boolean; data: string }>;
  const watches = () => (cmd('sim.watches', {}).reply()?.data as { watches: number }).watches;
  return { sim, out, cmd, advance, frames, watches, timers };
}

const NIBBLE = (snapshot: { world: { workers: Array<{ name?: string; id: string; session: string }> } }, name: string) =>
  snapshot.world.workers.find((w) => w.name === name)?.id as string;
const world = loadFixture('demo-m4').snapshot as unknown as { world: { workers: Array<{ name?: string; id: string; session: string }> } };
const agent = NIBBLE(world, 'Nibble'); // herdr-3d, claude
const shell = NIBBLE(world, 'Sprout'); // herdr-3d, no agent
const asleep = NIBBLE(world, 'Muffin'); // depot-manager, asleep

/** What the screen shows after applying frames in order (full resets), via a real xterm. */
async function screen(frames: Array<{ full: boolean; data: string }>, cols = 120, rows = 36): Promise<string[]> {
  let t = new Terminal({ cols, rows, scrollback: 0 });
  for (const f of frames) {
    if (f.full) {
      t.dispose();
      t = new Terminal({ cols, rows, scrollback: 0 });
    }
    await new Promise<void>((r) => t.write(Buffer.from(f.data, 'base64'), r));
  }
  const b = t.buffer.active;
  const lines = Array.from({ length: rows }, (_, y) => (b.getLine(y)?.translateToString(true) ?? '').trimEnd());
  t.dispose();
  return lines;
}

describe('recorded screens', () => {
  it('are real observe output: a full frame first, then diffs, at 120×36', () => {
    for (const name of ['shell', 'agent']) {
      const r = loadRecording(name);
      expect(r.cols).toBe(120);
      expect(r.rows).toBe(36);
      expect(r.frames[0]?.full).toBe(true);
      expect(r.frames.slice(1).every((f) => !f.full)).toBe(true);
      expect(r.frames.length).toBeGreaterThan(5);
    }
  });

  it('#175: the narrow one is a split pane, 60×40, with text from its first row to its last', async () => {
    const r = loadRecording('narrow');
    expect([r.cols, r.rows]).toEqual([60, 40]);
    expect(r.frames[0]?.full).toBe(true);
    const lines = await screen(r.frames.map((f) => ({ full: f.full, data: f.data.toString('base64') })), 60, 40);
    expect(lines[0]).toMatch(/^row {2}1 /);
    expect(lines[39]).toMatch(/^row 40 last row/);
  });
});

describe('SimScreens', () => {
  it('acks a watch, then sends a full frame and diffs at most fps a second', async () => {
    const r = rig();
    const c = r.cmd('terminal.watch', { id: agent, fps: 4 });
    const [ack, first] = c.got();
    expect(ack).toEqual({ t: 'ack', req_id: c.req_id, data: { pane: 'w1:p1', cols: 120, rows: 36 } });
    expect(first).toMatchObject({ t: 'terminal.frame', id: agent, pane: 'w1:p1', n: 1, full: true, cols: 120, rows: 36 });
    r.advance(5000);
    const fs = r.frames(agent);
    expect(fs.length).toBeGreaterThan(3);
    expect(fs.map((f) => f.n)).toEqual(fs.map((_, i) => i + 1));
    // The agent recording ticks every 250 ms: at 4 fps nothing is dropped, nothing faster than 250 ms apart.
    expect(fs.length).toBeLessThanOrEqual(1 + 5000 / 250);
    const text = (await screen(fs)).join('\n');
    expect(text).toContain('Worker demo');
    expect(r.watches()).toBe(1);
  });

  it('at 1 fps concatenates the diffs in between (the screen ends up the same)', async () => {
    const fast = rig();
    const slow = rig();
    fast.cmd('terminal.watch', { id: agent, fps: 30 });
    slow.cmd('terminal.watch', { id: agent, fps: 1 });
    fast.advance(3000);
    slow.advance(3000);
    expect(slow.frames().length).toBeLessThan(fast.frames().length);
    fast.cmd('terminal.unwatch', { id: agent });
    slow.cmd('terminal.unwatch', { id: agent });
    // Both saw the same bytes, in the same order.
    const bytes = (fs: Array<{ data: string }>) => Buffer.concat(fs.map((f) => Buffer.from(f.data, 'base64'))).toString('latin1');
    const f = bytes(fast.frames());
    const s = bytes(slow.frames());
    expect(f.startsWith(s)).toBe(true);
  });

  it('typed keys fast-forward the screen and echo, in order, into the watched screen', async () => {
    const r = rig();
    r.cmd('terminal.watch', { id: shell, fps: 10 });
    r.advance(500);
    expect(r.cmd('worker.keys', { id: shell, input: [{ text: 'echo hi' }, { key: 'enter' }, { text: 'ls' }] }).reply()).toMatchObject({ t: 'ack' });
    r.advance(500);
    const lines = await screen(r.frames(shell));
    expect(lines.join('\n')).toContain('ready for input');
    expect(lines).toContain('$ echo hi');
    expect(lines).toContain('$ ls');
    // A new watch starts from a full frame that has it all.
    r.cmd('terminal.watch', { id: shell, fps: 10 });
    const again = r.frames(shell).at(-1) as { full: boolean; data: string; n: number };
    expect(again).toMatchObject({ full: true, n: 1 });
    expect((await screen([again])).join('\n')).toContain('$ ls');
  });

  it('takes every key name the game sends', () => {
    const r = rig();
    for (const key of KEY_NAMES) expect(r.cmd('worker.keys', { id: agent, input: [{ key }] }).reply(), key).toMatchObject({ t: 'ack' });
  });

  it('validates keys like the bridge', () => {
    const r = rig();
    const code = (args: unknown) => r.cmd('worker.keys', args).reply()?.code;
    expect(code({ id: agent, input: [] })).toBe('bad_request');
    expect(code({ id: agent, input: [{ key: 'hyper+q' }] })).toBe('bad_request');
    expect(code({ id: agent, input: [{ text: 'a\u0003' }] })).toBe('bad_request');
    expect(code({ id: agent, input: [{ text: 'a', key: 'enter' }] })).toBe('bad_request');
    expect(code({ id: agent, input: [{ text: 'x'.repeat(4097) }] })).toBe('bad_request');
    expect(code({ id: 'nobody', input: [{ text: 'a' }] })).toBe('unknown_worker');
    expect(code({ id: asleep, input: [{ text: 'a' }] })).toBe('invalid_state');
    expect(code({ id: agent, input: [{ text: 'a' }, { key: 'ctrl+c' }, { key: 'shift+tab' }, { key: 'f12' }] })).toBeUndefined();
  });

  it('refuses asleep floors, unknown workers and over the cap', () => {
    const r = rig();
    expect(r.cmd('terminal.watch', { id: asleep }).reply()).toMatchObject({ code: 'invalid_state' });
    expect(r.cmd('terminal.watch', { id: 'nobody' }).reply()).toMatchObject({ code: 'unknown_worker' });
    expect(r.cmd('terminal.watch', { id: agent, fps: 0 }).reply()).toMatchObject({ code: 'bad_request' });
    const herdr = world.world.workers.filter((w) => w.session === 'herdr-3d').map((w) => w.id);
    for (const id of herdr.slice(0, SIM_MAX_WATCHES)) expect(r.cmd('terminal.watch', { id }).reply()).toMatchObject({ t: 'ack' });
    expect(r.cmd('terminal.watch', { id: herdr[SIM_MAX_WATCHES] }).reply()).toMatchObject({ code: 'capacity' });
    // Re-watching one already watched is a restart, not one more.
    expect(r.cmd('terminal.watch', { id: herdr[0] }).reply()).toMatchObject({ t: 'ack' });
    expect(r.watches()).toBe(SIM_MAX_WATCHES);
  });

  it('closes watches when the worker goes home or the floor sleeps; counts them', () => {
    const r = rig();
    const noodle = NIBBLE(world, 'Noodle');
    r.cmd('terminal.watch', { id: agent });
    r.cmd('terminal.watch', { id: noodle });
    expect(r.watches()).toBe(2);
    r.cmd('worker.fire', { id: noodle });
    r.advance(200);
    expect(r.out).toContainEqual({ t: 'terminal.closed', id: noodle, reason: 'worker_removed' });
    r.cmd('floor.sleep', { session: 'herdr-3d' });
    r.advance(200);
    expect(r.out).toContainEqual({ t: 'terminal.closed', id: agent, reason: 'asleep' });
    expect(r.watches()).toBe(0);
    // Unwatching is a no-op ack for one not watched.
    expect(r.cmd('terminal.unwatch', { id: agent }).reply()).toMatchObject({ t: 'ack' });
  });

  it('simfail=input_failed and observer_failed', () => {
    const k = rig('input_failed');
    expect(k.cmd('worker.keys', { id: agent, input: [{ text: 'a' }] }).reply()).toMatchObject({ code: 'input_failed' });
    expect(k.cmd('worker.keys', { id: agent, input: [{ text: 'a' }] }).reply()).toMatchObject({ t: 'ack' });
    const o = rig('observer_failed');
    const got = o.cmd('terminal.watch', { id: agent }).got();
    expect(got.map((m) => m.t)).toEqual(['ack', 'terminal.frame', 'terminal.closed']);
    expect(got[2]).toEqual({ t: 'terminal.closed', id: agent, reason: 'observer_failed' });
    expect(o.watches()).toBe(0);
  });

  it('stops every timer when the connection goes', () => {
    const r = rig();
    r.cmd('terminal.watch', { id: agent });
    r.cmd('terminal.watch', { id: shell });
    r.advance(1000);
    expect(r.timers.size).toBeGreaterThan(0);
    r.sim.dispose();
    expect(r.timers.size).toBe(0);
  });
});

// #175: simscreen=narrow shows the narrow recording on every laptop.
describe('SimScreens: a narrow screen (#175)', () => {
  it('watches of an agent and a shell both get the 60×40 recording', async () => {
    const r = rig(undefined, undefined, 'narrow');
    for (const id of [agent, shell]) {
      const c = r.cmd('terminal.watch', { id, fps: 10 });
      expect(c.got()[0]).toMatchObject({ t: 'ack', data: { cols: 60, rows: 40 } });
      expect(c.got()[1]).toMatchObject({ t: 'terminal.frame', full: true, cols: 60, rows: 40 });
    }
    r.advance(5000);
    expect((await screen(r.frames(shell), 60, 40))[39]).toMatch(/^row 40/);
  });
});

// #74: simzoom plays the bridge's pane zoom.
describe('SimScreens: pane zoom (#74)', () => {
  const zoomOf = (m?: Msg) => (m?.data as { zoom?: Msg } | undefined)?.zoom;

  it('a bridge before it ignores fullscreen, has no zoom in the ack and does not know terminal.zoom', () => {
    const r = rig();
    const c = r.cmd('terminal.watch', { id: agent, fps: 4, fullscreen: true });
    expect(zoomOf(c.reply())).toBeUndefined();
    const z = r.cmd('terminal.zoom', { id: agent, on: true });
    expect(z.reply()).toMatchObject({ t: 'error', code: 'unknown_command' });
  });

  it('simzoom=old refuses the fullscreen argument like a strict bridge', () => {
    const r = rig(undefined, 'old');
    expect(r.cmd('terminal.watch', { id: agent, fullscreen: true }).reply()).toMatchObject({ t: 'error', code: 'bad_request' });
    expect(zoomOf(r.cmd('terminal.watch', { id: agent }).reply())).toBeUndefined();
    expect(r.cmd('terminal.zoom', { id: agent, on: true }).reply()).toMatchObject({ code: 'unknown_command' });
  });

  it('a single-pane tab is single whatever is asked', () => {
    const r = rig(undefined, 'single');
    expect(zoomOf(r.cmd('terminal.watch', { id: agent, fullscreen: true }).reply())).toEqual({ state: 'single', applied: false });
    expect(zoomOf(r.cmd('terminal.zoom', { id: agent, on: true }).reply())).toEqual({ state: 'single', applied: false });
  });

  it('a split pane is zoomed by a fullscreen watch, a replacing watch without it restores, and unwatch restores', () => {
    const r = rig(undefined, 'split');
    expect(zoomOf(r.cmd('terminal.watch', { id: agent, fps: 4 }).reply())).toEqual({ state: 'split', applied: false });
    expect(zoomOf(r.cmd('terminal.watch', { id: agent, fps: 4, fullscreen: true }).reply())).toEqual({ state: 'zoomed', applied: true });
    expect(zoomOf(r.cmd('terminal.watch', { id: agent, fps: 1, fullscreen: true }).reply())).toEqual({ state: 'zoomed', applied: true });
    expect(zoomOf(r.cmd('terminal.watch', { id: agent, fps: 4 }).reply())).toEqual({ state: 'split', applied: false });
    r.cmd('terminal.watch', { id: agent, fullscreen: true });
    r.cmd('terminal.unwatch', { id: agent });
    expect(zoomOf(r.cmd('terminal.watch', { id: agent }).reply())).toEqual({ state: 'split', applied: false });
  });

  it('a re-watch of a fullscreen watch does not zoom again after the human unzoomed; terminal.zoom on does', () => {
    const r = rig(undefined, 'split');
    r.cmd('terminal.watch', { id: agent, fps: 4, fullscreen: true });
    r.cmd('sim.unzoom', { id: agent });
    expect(zoomOf(r.cmd('terminal.watch', { id: agent, fps: 2, fullscreen: true }).reply())).toEqual({ state: 'split', applied: false });
    expect(zoomOf(r.cmd('terminal.zoom', { id: agent, on: true }).reply())).toEqual({ state: 'zoomed', applied: true });
    // false is a watch that follows without zooming.
    expect(zoomOf(r.cmd('terminal.watch', { id: agent, fullscreen: false }).reply())).toEqual({ state: 'split', applied: false });
  });

  it('terminal.zoom switches a watched pane, validates its arguments, and needs a watch', () => {
    const r = rig(undefined, 'split');
    expect(r.cmd('terminal.zoom', { id: agent, on: true }).reply()).toMatchObject({ code: 'bad_request' });
    r.cmd('terminal.watch', { id: agent });
    expect(r.cmd('terminal.zoom', { id: agent }).reply()).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('terminal.zoom', { id: agent, on: 'yes' }).reply()).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('terminal.zoom', { id: agent, on: true, extra: 1 }).reply()).toMatchObject({ code: 'bad_request' });
    const on = r.cmd('terminal.zoom', { id: agent, on: true }).reply();
    expect(on?.data).toMatchObject({ pane: 'w1:p1', cols: 120, rows: 36, zoom: { state: 'zoomed', applied: true } });
    expect(zoomOf(r.cmd('terminal.zoom', { id: agent, on: false }).reply())).toEqual({ state: 'split', applied: false });
  });

  it('headless: the zoom is set but the pane does not widen', () => {
    const r = rig(undefined, 'headless');
    expect(zoomOf(r.cmd('terminal.watch', { id: agent, fullscreen: true }).reply())).toEqual({ state: 'zoomed', applied: true, headless: true });
  });

  it('sim.unzoom plays the human unzooming: a terminal.state to the watching connection', () => {
    const r = rig(undefined, 'split');
    r.cmd('terminal.watch', { id: agent, fullscreen: true });
    const c = r.cmd('sim.unzoom', { id: agent });
    expect(c.got().find((m) => m.t === 'terminal.state')).toEqual({ t: 'terminal.state', id: agent, pane: 'w1:p1', cols: 120, rows: 36, zoom: { state: 'split', applied: false } });
  });
});


// #176: the seated watch that owns its pane.
describe('SimScreens: control (#176)', () => {
  it('a control watch is owned at its grid; resize, scroll and typing as the bridge does them', () => {
    const r = rig();
    const c = r.cmd('terminal.watch', { id: shell, fps: 10, cols: 150, rows: 40, control: true });
    expect(c.got().map((m) => m.t)).toEqual(['ack', 'terminal.control', 'terminal.frame']);
    expect(c.got()[0]).toMatchObject({ data: { cols: 150, rows: 40, control: true } });
    expect(c.got()[1]).toMatchObject({ mode: 'control', cols: 150, rows: 40 });
    expect(c.got()[2]).toMatchObject({ full: true, cols: 150, rows: 40 });
    // One per connection.
    expect(r.cmd('terminal.watch', { id: agent, control: true, cols: 80, rows: 24 }).reply()).toMatchObject({ t: 'error', code: 'capacity' });
    const z = r.cmd('terminal.resize', { id: shell, cols: 100, rows: 30, cell_width_px: 9, cell_height_px: 18 });
    expect(z.reply()).toMatchObject({ t: 'ack', data: { cols: 100, rows: 30 } });
    r.advance(500);
    expect(r.frames(shell).at(-1)).toMatchObject({ full: true, cols: 100, rows: 30 });
    expect(r.cmd('terminal.resize', { id: shell, cols: 39, rows: 30 }).reply()).toMatchObject({ code: 'bad_request' });
    const up = r.cmd('terminal.scroll', { id: shell, direction: 'up', lines: 12 });
    expect(up.got().find((m) => m.t === 'terminal.history')).toMatchObject({ offset: 12, max: 200, rows: 30 });
    expect(r.cmd('terminal.scroll', { id: shell, bottom: true, lines: 1 }).reply()).toMatchObject({ code: 'bad_request' });
    r.cmd('terminal.scroll', { id: shell, direction: 'up', lines: 3 });
    const keys = r.cmd('worker.keys', { id: shell, input: [{ text: 'ls' }] });
    expect(keys.got().find((m) => m.t === 'terminal.history')).toMatchObject({ offset: 0 });
    const st = r.cmd('sim.terminal', { id: shell }).reply()?.data as { control: { resizes: unknown[]; scrolls: string[]; offset: number } };
    expect(st.control).toMatchObject({ resizes: [[100, 30]], scrolls: ['up 12', 'up 3'], offset: 0 });
    // A watch without control: no grid, no commands.
    r.cmd('terminal.watch', { id: shell, fps: 4 });
    expect(r.cmd('terminal.resize', { id: shell, cols: 100, rows: 30 }).reply()).toMatchObject({ code: 'bad_request' });
  });

  it('busy: read only at the recording’s size; none: acked without control; old: the argument refused', () => {
    const busy = rig(undefined, undefined, undefined, 'busy');
    const c = busy.cmd('terminal.watch', { id: shell, cols: 150, rows: 40, control: true });
    expect(c.got()[1]).toMatchObject({ t: 'terminal.control', mode: 'observe', reason: 'busy', cols: 120, rows: 36 });
    expect(c.got()[2]).toMatchObject({ t: 'terminal.frame', cols: 120, rows: 36 });
    expect(busy.cmd('terminal.resize', { id: shell, cols: 100, rows: 30 }).reply()).toMatchObject({ code: 'invalid_state' });
    expect(busy.cmd('terminal.scroll', { id: shell, bottom: true }).reply()).toMatchObject({ code: 'invalid_state' });
    const none = rig(undefined, undefined, undefined, 'none');
    const n = none.cmd('terminal.watch', { id: shell, cols: 150, rows: 40, control: true });
    expect((n.reply()?.data as Msg).control).toBeUndefined();
    expect(n.got().some((m) => m.t === 'terminal.control')).toBe(false);
    const old = rig(undefined, undefined, undefined, 'old');
    expect(old.cmd('terminal.watch', { id: shell, control: true }).reply()).toMatchObject({ code: 'bad_request' });
    expect(old.cmd('terminal.resize', { id: shell, cols: 100, rows: 30 }).reply()).toMatchObject({ code: 'unknown_command' });
  });
});
