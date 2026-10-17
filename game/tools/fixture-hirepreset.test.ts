import { describe, expect, it } from 'vitest';
import type { HirePreset } from '../src/net/protocol.ts';
import { HirePresetSim } from './fixture-hirepreset.ts';
import { SimWorld, type SimOptions } from './fixture-sim.ts';
import { herdrInstructions, PLACEMENT_LINE } from './fixture-start.ts';

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
    const equipe = r.ack('hire_preset.create', spec({ name: 'Équipe' })).data;
    expect(r.err('hire_preset.create', spec({ name: 'équipe' }))).toBe('name_taken');
    r.ack('hire_preset.delete', { id: equipe.id });
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

describe('fixture herdr hiring instructions (#95)', () => {
  it('stores the flag (left out when off) and the snapshot says the bridge takes it', () => {
    const r = rig();
    expect((r.sim.snapshot().world as { herdr_instructions?: boolean }).herdr_instructions).toBe(true);
    const on = r.ack('hire_preset.create', spec({ herdr_instructions: true })).data;
    expect(on.herdr_instructions).toBe(true);
    const plain = r.ack('hire_preset.create', spec({ name: 'Plain' })).data;
    expect(plain).not.toHaveProperty('herdr_instructions');
    const off = r.ack('hire_preset.update', { id: on.id, ...spec({ herdr_instructions: false }) });
    expect(off.data).not.toHaveProperty('herdr_instructions');
    expect(off.events.map((e) => e.t)).toEqual(['hire_preset.upsert']);
    expect(r.err('hire_preset.create', spec({ name: 'x', herdr_instructions: 'yes' }))).toBe('bad_request');
  });

  it('worker.hire adds the lines for the floor it hires on, and hire.prepare shows them', () => {
    const r = rig();
    const v = (r.ack('floor.create', { name: 'Web', base_session: 'f1' }).data as unknown as { id: string }).id;
    const prep = r.ack('hire.prepare', { floor: v }).data as unknown as { herdr_instructions: string };
    expect(prep.herdr_instructions).toBe(herdrInstructions(v));
    expect(prep.herdr_instructions.startsWith(`${PLACEMENT_LINE}\n\nAlso tag every herdr workspace you create with the token h3d_floor=${v},`)).toBe(true);
    const hire = (floor: string, desk: number, flag?: boolean) => r.cmd('worker.hire', { floor, desk_index: desk, harness: 'codex', model: 'gpt-6-sol', effort: 'high', prompt: 'Spawn reviewers.', ...(flag === undefined ? {} : { herdr_instructions: flag }) });
    hire(v, 0, true);
    hire('f1', 0, true);
    hire('f2', 0);
    const first = r.ack('sim.first_prompts', {}).data as unknown as Array<{ floor: string; prompt: string }>;
    expect(first.map((x) => [x.floor, x.prompt])).toEqual([
      [v, `Spawn reviewers.\n\n${herdrInstructions(v)}`],
      ['f1', `Spawn reviewers.\n\n${herdrInstructions('f1')}`],
      ['f2', 'Spawn reviewers.'],
    ]);
    expect(r.err('worker.hire', { floor: 'f2', desk_index: 1, harness: 'codex', model: 'gpt-6-sol', effort: 'high', herdr_instructions: true })).toBe('bad_request');
    expect(r.err('worker.hire', { floor: 'f2', desk_index: 1, harness: 'codex', model: 'gpt-6-sol', effort: 'high', prompt: 'x'.repeat(32 * 1024 - 10), herdr_instructions: true })).toBe('bad_request');
  });

  it('a #93 bridge has no marker, refuses the field and the check', () => {
    const old = rig({ fail: 'no_herdr_instructions' });
    expect(old.sim.snapshot().world).not.toHaveProperty('herdr_instructions');
    expect(old.view()).toEqual([]);
    expect(old.err('hire_preset.create', spec({ herdr_instructions: true }))).toBe('bad_request');
    expect(old.err('hire_preset.check', { prompt: 'Spawn workers.' })).toBe('unknown_command');
    expect(old.ack('hire.prepare', { floor: 'f1' }).data).not.toHaveProperty('herdr_instructions');
    expect(old.err('worker.hire', { floor: 'f1', desk_index: 0, harness: 'codex', model: 'gpt-6-sol', effort: 'high', prompt: 'x', herdr_instructions: true })).toBe('bad_request');
  });

  it('hire_preset.check asks the classifier and fails open', async () => {
    const host = (score: number | Error | null) => {
      const asked: unknown[] = [];
      const sim = new HirePresetSim(
        {
          hasFloor: () => true,
          hire: {},
          emit: () => {},
          error: (code, message) => Object.assign(new Error(message), { code }),
          now: () => 1,
          ai: {
            ready: () => score !== null,
            classify: async (state, q) => {
              asked.push([state, q]);
              if (score instanceof Error) throw score;
              return score ?? 0;
            },
          },
        },
        true,
        null,
      );
      const check = (prompt: string) => new Promise((done) => sim.handle('hire_preset.check', { prompt }, () => {}, done));
      return { check, asked };
    };
    const yes = host(0.9);
    expect(await yes.check('For each PR, spawn a subagent.')).toEqual({ delegates: true, score: 0.9 });
    expect(yes.asked).toEqual([[{ prompt: 'For each PR, spawn a subagent.' }, expect.stringContaining('subagents, workers')]]);
    expect(await host(0.69).check('Deploy.')).toEqual({ delegates: false, score: 0.69 });
    expect(await host(new Error('provider failed')).check('Deploy.')).toEqual({ delegates: false, score: 0 });
    const unready = host(null);
    expect(await unready.check('Spawn workers.')).toEqual({ delegates: false, score: 0 });
    expect(unready.asked).toEqual([]);
  });
});
