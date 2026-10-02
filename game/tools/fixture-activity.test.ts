import { describe, expect, it } from 'vitest';
import type { Activity, Snapshot, Worker } from '../src/net/protocol';
import { WorldStore } from '../src/world/store';
import { loadFixture } from './fixture-server';
import { SimWorld } from './fixture-sim';

// #98: `sim.activity` and `simactivity=` on the simulating fixture server (tools/fixture-activity.ts).

type Msg = Record<string, unknown>;

function rig(activity?: string) {
  const { snapshot } = loadFixture('demo-m5');
  const sim = new SimWorld(snapshot as never, { stepMs: 100, usageMs: 0, now: () => 50_000, ...(activity ? { activity } : {}) });
  const out: Msg[] = [];
  let n = 0;
  const cmd = (t: string, args: unknown) => {
    const req_id = `r${++n}`;
    const from = out.length;
    sim.handle({ t, req_id, args }, (m) => out.push(m));
    return { got: () => out.slice(from), reply: () => out.find((m) => m.req_id === req_id) as Msg | undefined };
  };
  const workers = () => (sim.snapshot() as unknown as Snapshot).world.workers;
  return { sim, cmd, workers };
}

const named = (ws: Worker[], name: string) => ws.find((w) => w.name === name) as Worker;

describe('sim.activity', () => {
  it('sets a worker’s activity and sends worker.activity before its ack; null clears it', () => {
    const { cmd, workers } = rig();
    const nibble = named(workers(), 'Nibble');
    const r = cmd('sim.activity', { id: nibble.id, activity: { kind: 'testing', detail: 'pytest -n auto' } });
    const got = r.got();
    expect(got[0]).toMatchObject({ t: 'worker.activity', id: nibble.id, session: 'herdr-3d', activity: { kind: 'testing', detail: 'pytest -n auto', since: 50_000, source: 'rule' } });
    expect(got[1]).toMatchObject({ t: 'ack' });
    expect(named(workers(), 'Nibble').activity?.kind).toBe('testing');
    const c = cmd('sim.activity', { id: nibble.id, activity: null }).got();
    expect(c[0]).toMatchObject({ t: 'worker.activity', id: nibble.id });
    expect(c[0]).not.toHaveProperty('activity');
    expect(named(workers(), 'Nibble')).not.toHaveProperty('activity');
  });

  it('changes the status first when asked (a waiting worker is idle)', () => {
    const { cmd, workers } = rig();
    const id = named(workers(), 'Nibble').id;
    const got = cmd('sim.activity', { id, status: 'idle', activity: { kind: 'waiting', detail: 'Monitor: e2e log', tasks: 1, source: 'derived' } }).got();
    expect(got.map((m) => m.t)).toEqual(['worker.status', 'worker.activity', 'ack']);
    expect(got[0]).toMatchObject({ status: 'idle', prev_status: 'working' });
    // The store reads it as waiting.
    const s = new WorldStore();
    s.applySnapshot(rig().sim.snapshot() as unknown as Snapshot);
    for (const m of got.slice(0, 2)) s.applyEvent(m as never);
    expect(s.workerView(id)?.display).toBe('waiting');
  });

  it('makes an image the agent looks at, a real PNG served to the connection without a watch', () => {
    const { cmd, workers } = rig();
    const pip = named(workers(), 'Pip');
    const a = (cmd('sim.activity', { id: pip.id, image: { seed: 41, w: 900, h: 600, via: 'exec' } }).reply()?.data as { activity: Activity }).activity;
    expect(a).toMatchObject({ kind: 'image', detail: 'waiting-band.png', image: { w: 900, h: 600 } });
    const hash = a.image?.hash as string;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const img = cmd('transcript.image', { id: pip.id, hash, size: 'thumb' }).reply();
    expect(img).toMatchObject({ t: 'ack', data: { mime: 'image/png', size: 'thumb', width: 480, height: 320 } });
    // Another worker's hash, or one no longer shown, is not.
    expect(cmd('transcript.image', { id: named(workers(), 'Nibble').id, hash, size: 'thumb' }).reply()).toMatchObject({ t: 'error', code: 'invalid_state' });
    cmd('sim.activity', { id: pip.id, activity: null });
    expect(cmd('transcript.image', { id: pip.id, hash, size: 'thumb' }).reply()).toMatchObject({ t: 'error', code: 'invalid_state' });
  });

  it('refuses what it cannot do', () => {
    const { cmd, workers } = rig();
    expect(cmd('sim.activity', { id: 'nobody', activity: { kind: 'testing' } }).reply()).toMatchObject({ t: 'error', code: 'unknown_worker' });
    expect(cmd('sim.activity', { id: named(workers(), 'Pip').id, status: 'asleep' }).reply()).toMatchObject({ t: 'error', code: 'bad_request' });
    expect(cmd('sim.activity', { id: named(workers(), 'Pip').id, activity: { detail: 'x' } }).reply()).toMatchObject({ t: 'error', code: 'bad_request' });
  });
});

describe('simactivity=', () => {
  it('demo: working Claude and Codex workers have a label each, one idle Claude waits, one Codex looks at an image', () => {
    const ws = rig('demo').workers().filter((w) => w.session === 'herdr-3d');
    const working = ws.filter((w) => w.status === 'working' && (w.harness === 'claude' || w.harness === 'codex'));
    expect(working.length).toBeGreaterThan(5);
    expect(working.every((w) => !!w.activity)).toBe(true);
    expect(new Set(working.map((w) => w.activity?.kind)).size).toBeGreaterThan(5);
    expect(working.filter((w) => w.activity?.kind === 'image')).toHaveLength(1);
    expect(ws.filter((w) => w.activity?.kind === 'waiting').map((w) => [w.status, w.harness])).toEqual([['idle', 'claude']]);
    expect(ws.filter((w) => w.status !== 'working' && w.activity?.kind !== 'waiting' && w.activity)).toEqual([]);
  });

  it('none without it', () => {
    expect(rig().workers().some((w) => w.activity)).toBe(false);
  });
});
