import { Terminal } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import { loadFixture } from './fixture-server';
import { loadRecording, SIM_MAX_WATCHES } from './fixture-screen';
import { SimWorld } from './fixture-sim';

type Msg = Record<string, unknown>;

/** A sim on demo-m4 with a fake clock: `advance(ms)` runs what is due, in order. */
function rig(fail?: string) {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const { snapshot } = loadFixture('demo-m4');
  const sim = new SimWorld(snapshot as never, {
    fail,
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
async function screen(frames: Array<{ full: boolean; data: string }>): Promise<string[]> {
  let t = new Terminal({ cols: 120, rows: 36, scrollback: 0 });
  for (const f of frames) {
    if (f.full) {
      t.dispose();
      t = new Terminal({ cols: 120, rows: 36, scrollback: 0 });
    }
    await new Promise<void>((r) => t.write(Buffer.from(f.data, 'base64'), r));
  }
  const b = t.buffer.active;
  const lines = Array.from({ length: 36 }, (_, y) => (b.getLine(y)?.translateToString(true) ?? '').trimEnd());
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
