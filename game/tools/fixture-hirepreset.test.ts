import { describe, expect, it } from 'vitest';
import type { HirePreset } from '../src/net/protocol.ts';
import { SimWorld, type SimOptions } from './fixture-sim.ts';

// #93: the simulator's hire presets follow the bridge's rules: the checks and their codes, scoped names, the events,
// a key's connections sharing them, a deleted virtual floor's own presets going with it, and an older bridge.

const world = {
  buildings: [{ id: 'b1', name: 'HQ', sort: 0, floors: ['f1', 'f2'] }],
  unassigned: [],
  floors: [
    { session: 'f1', state: 'running', building: 'b1', index: 0, desks: 2 },
    { session: 'f2', state: 'running', building: 'b1', index: 1, desks: 2 },
  ],
  workers: [],
};

let keys = 0;
function rig(o: SimOptions = {}) {
  const sim = new SimWorld({ seq: 1, world: structuredClone(world) }, { stepMs: 1, now: () => 1000, manualClock: true, ...o });
  const out: Record<string, unknown>[] = [];
  sim.start((m) => out.push(m), { usageMs: 0 });
  let n = 0;
  const cmd = (t: string, args: Record<string, unknown>) => {
    const from = out.length;
    sim.handle({ t, req_id: `r${++n}`, args }, (m) => out.push(m));
    return out.slice(from);
  };
  const ack = (t: string, args: Record<string, unknown>) => {
    const got = cmd(t, args);
    const a = got.find((m) => m.t === 'ack' || m.t === 'error') as Record<string, unknown>;
    if (a.t !== 'ack') throw new Error(JSON.stringify(a));
    return { data: a.data as HirePreset, events: got.filter((m) => m.t !== 'ack') };
  };
  const err = (t: string, args: Record<string, unknown>) => (cmd(t, args).find((m) => m.t === 'error') as { code: string } | undefined)?.code;
  const view = () => (sim.snapshot().world as { hire_presets?: HirePreset[] }).hire_presets;
  return { sim, cmd, ack, err, view, out };
}
const spec = (over: Record<string, unknown> = {}) => ({ name: 'Deploy', floor: 'f1', prompt: 'Deploy to A, B and C.', harness: 'codex', model: 'gpt-6-sol', effort: 'high', ...over });

describe('fixture hire presets (#93)', () => {
  it('creates, updates and deletes with the bridge’s checks, events and scoped names', () => {
    const r = rig();
    expect(r.view()).toEqual([]);
    const { data, events } = r.ack('hire_preset.create', spec());
    expect(data).toMatchObject({ name: 'Deploy', floor: 'f1', model: 'gpt-6-sol' });
    expect(events.map((e) => e.t)).toEqual(['hire_preset.upsert']);
    expect(r.err('hire_preset.create', spec({ name: 'DEPLOY' }))).toBe('name_taken');
    r.ack('hire_preset.create', spec({ floor: 'f2' }));
    const global = r.ack('hire_preset.create', spec({ floor: undefined })).data;
    expect(global).not.toHaveProperty('floor');
    expect(r.err('hire_preset.create', spec({ floor: 'nope' }))).toBe('unknown_session');
    expect(r.err('hire_preset.create', spec({ name: 'x', prompt: '--x' }))).toBe('bad_request');
    expect(r.err('hire_preset.create', spec({ name: 'x', prompt: '' }))).toBe('bad_request');
    expect(r.err('hire_preset.create', spec({ name: 'x', effort: 'ultra', model: 'gpt-6-luna' }))).toBe('bad_request');
    expect(r.err('hire_preset.create', spec({ name: 'x', building: 'b1' }))).toBe('bad_request');
    expect(r.ack('hire_preset.update', { id: data.id, ...spec() }).events).toEqual([]);
    const up = r.ack('hire_preset.update', { id: data.id, ...spec({ prompt: 'Only A.' }) });
    expect(up.data.updated_at).toBeGreaterThan(data.updated_at);
    expect(r.err('hire_preset.update', { id: 'hp_x', ...spec() })).toBe('not_found');
    expect(r.ack('hire_preset.delete', { id: global.id }).events).toEqual([expect.objectContaining({ t: 'hire_preset.removed', id: global.id })]);
    expect(r.view()?.map((p) => p.floor)).toEqual(['f1', 'f2']);
  });

  it('shares a key’s presets between connections (and a reload), never another key’s', () => {
    const key = `t${++keys}`;
    const a = rig({ hirePresets: key });
    const b = rig({ hirePresets: key });
    const other = rig({ hirePresets: `${key}-other` });
    const made = a.ack('hire_preset.create', spec()).data;
    expect(b.out.some((m) => m.t === 'hire_preset.upsert')).toBe(true);
    expect(b.view()?.map((p) => p.id)).toEqual([made.id]);
    expect(rig({ hirePresets: key }).view()?.map((p) => p.id)).toEqual([made.id]);
    expect(other.view()).toEqual([]);
  });

  it('a deleted virtual floor takes its own presets; a bridge before #93 has none', () => {
    const r = rig();
    const v = r.ack('floor.create', { name: 'Web', base_session: 'f1' }).data as unknown as { id: string };
    const own = r.ack('hire_preset.create', spec({ floor: v.id })).data;
    r.ack('hire_preset.create', spec({ floor: undefined }));
    const { events } = r.ack('floor.delete', { floor: v.id });
    expect(events).toContainEqual(expect.objectContaining({ t: 'hire_preset.removed', id: own.id }));
    expect(r.view()?.map((p) => p.floor ?? '')).toEqual(['']);
    const old = rig({ fail: 'no_hire_presets' });
    expect(old.view()).toBeUndefined();
    expect(old.err('hire_preset.create', spec())).toBe('unknown_command');
  });
});
