import { describe, expect, it } from 'vitest';
import type { ScheduleSuggestion, ScheduleSuggestionsState, Worker } from '../src/net/protocol.ts';
import { knownZone, tomorrowAt1045 } from './fixture-schedsuggest.ts';
import { SimWorld, type SimOptions } from './fixture-sim.ts';

// #66: the simulator's schedule suggestions follow the bridge's rules: the setting's states, the zone, the chip's
// suggestion (sim.suggest, the seed), dismiss, a save from it, and the transcript going on.

const T = Date.UTC(2026, 9, 18, 10, 52);
const world = {
  buildings: [{ id: 'b1', name: 'HQ', sort: 0, floors: ['f1'] }],
  unassigned: [],
  floors: [{ session: 'f1', state: 'running', building: 'b1', index: 0, desks: 3 }],
  workers: [
    { id: 'A', session: 'f1', workspace_id: 'w1', label: 'zippy', name: 'Zippy', status: 'idle', agent_kind: 'claude', harness: 'claude', desk_index: 0, cwd: '/home/dev/herdr-3d' },
    { id: 'B', session: 'f1', workspace_id: 'w2', label: 'pixel', name: 'Pixel', status: 'idle', agent_kind: 'claude', harness: 'claude', desk_index: 1 },
  ],
};

function rig(o: SimOptions = {}) {
  const sim = new SimWorld({ seq: 1, world: structuredClone(world) }, { stepMs: 1, now: () => T, manualClock: true, ...o });
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
    return { data: a.data as Record<string, unknown>, events: got.filter((m) => m.t !== 'ack') };
  };
  const err = (t: string, args: Record<string, unknown>) => cmd(t, args).find((m) => m.t === 'error') as { code: string; message: string } | undefined;
  const snap = () => sim.snapshot().world as { schedule_suggestions?: ScheduleSuggestionsState; workers: Worker[] };
  const sug = (id: string) => snap().workers.find((w) => w.id === id)?.schedule_suggestion;
  return { sim, cmd, ack, err, snap, sug };
}

describe('fixture schedule suggestions', () => {
  it('fixes the setting’s states with no models', () => {
    expect(rig({ schedSuggest: 'on' }).snap().schedule_suggestions).toMatchObject({ enabled: true, state: 'ready', env: [] });
    expect(rig({ schedSuggest: 'off' }).snap().schedule_suggestions).toMatchObject({ enabled: false, state: 'off' });
    expect(rig({ schedSuggest: 'incomplete' }).snap().schedule_suggestions).toMatchObject({ enabled: true, state: 'incomplete', missing: ['llm'], roles: { classifier: 'ready', llm: 'off' } });
    expect(rig({ schedSuggest: 'env' }).snap().schedule_suggestions).toMatchObject({ enabled: true, state: 'ready', env: ['enabled'] });
    const none = rig({ schedSuggest: 'none' });
    expect(none.snap().schedule_suggestions).toBeUndefined();
    expect(none.err('schedule_suggestions.get', {})?.code).toBe('unknown_command');
  });

  it('switches like the bridge: no test, a missing model refused, the environment read-only; each change an update', () => {
    const r = rig({ schedSuggest: 'off' });
    const on = r.ack('schedule_suggestions.set', { enabled: true, threshold: 0.8 });
    expect(on.data).toMatchObject({ enabled: true, threshold: 0.8, state: 'ready' });
    expect(on.events.map((e) => e.t)).toEqual(['schedule_suggestions.update']);
    expect(r.err('schedule_suggestions.set', { threshold: 2 })?.code).toBe('bad_request');
    expect(rig({ schedSuggest: 'env' }).err('schedule_suggestions.set', { enabled: false })?.code).toBe('env_locked');
    const inc = rig({ schedSuggest: 'incomplete' });
    inc.ack('schedule_suggestions.set', { enabled: false });
    expect(inc.err('schedule_suggestions.set', { enabled: true })?.code).toBe('incomplete');
    // Without a knob: the AI integration's models, none set up here.
    expect(rig().snap().schedule_suggestions).toMatchObject({ enabled: false, state: 'off', missing: ['classifier', 'llm'] });
  });

  it('keeps an IANA zone and refuses anything else', () => {
    const r = rig({ schedSuggest: 'on' });
    expect(r.ack('schedule_suggestions.zone', { zone: 'Europe/Brussels' }).data).toMatchObject({ zone: 'Europe/Brussels' });
    for (const z of ['Local', '', 'Mars/Base', '+02:00']) expect(r.err('schedule_suggestions.zone', { zone: z })?.code).toBe('bad_request');
    expect(knownZone('UTC')).toBe(true);
  });

  it('sim.suggest puts a suggestion on the worker’s reply; × and a new turn take it away; a stale id is refused', () => {
    const r = rig({ schedSuggest: 'on' });
    r.ack('sim.final', { id: 'A', text: 'Soak until 10:45 UTC tomorrow.' });
    const s = r.ack('sim.suggest', { id: 'A' }).data.suggestion as ScheduleSuggestion;
    expect(s).toMatchObject({ message: r.snap().workers[0]?.handoff?.message, due_at: tomorrowAt1045(T) });
    expect(r.err('worker.dismiss_schedule_suggestion', { id: 'A', suggestion: 'nope' })?.code).toBe('stale');
    expect(r.err('worker.dismiss_schedule_suggestion', { id: 'Z', suggestion: s.id })?.code).toBe('unknown_worker');
    const d = r.ack('worker.dismiss_schedule_suggestion', { id: 'A', suggestion: s.id });
    expect(d.events.map((e) => e.t)).toEqual(['worker.upsert']);
    expect(r.sug('A')).toBeUndefined();
    r.ack('sim.suggest', { id: 'A' });
    r.ack('sim.prompt_turn', { id: 'A' });
    expect(r.sug('A')).toBeUndefined();
  });

  it('a save from the suggestion closes it; another source leaves it', () => {
    const r = rig({ schedSuggest: 'on' });
    r.ack('sim.final', { id: 'A', text: 'Soak until 10:45 UTC tomorrow.' });
    const s = r.ack('sim.suggest', { id: 'A' }).data.suggestion as ScheduleSuggestion;
    const spec = { floor: 'f1', title: s.title, prompt: s.draft_prompt, due_at: s.due_at, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', cwd: '/home/dev/herdr-3d' };
    r.ack('schedule.create', { ...spec, source: { kind: 'transcript', worker: 'A', message: s.message } });
    expect(r.sug('A')?.id).toBe(s.id);
    const c = r.ack('schedule.create', { ...spec, source: { kind: 'suggestion', worker: 'A', message: s.message } });
    expect(c.events.map((e) => e.t)).toEqual(['schedule.upsert', 'worker.upsert']);
    expect(r.sug('A')).toBeUndefined();
  });

  it('simsuggest=<key> seeds Zippy’s reply and suggestion, never again once dismissed (a reload is a new world)', () => {
    const key = `k-${Math.random()}`;
    const r = rig({ schedSuggest: 'on', suggestKey: key });
    const s = r.sug('A');
    expect(s).toMatchObject({ title: 'Post-soak cleanup: Vector 0.59 rollout', due_at: tomorrowAt1045(T) });
    expect(s?.message).toBe(r.snap().workers[0]?.handoff?.message);
    expect(rig({ schedSuggest: 'on', suggestKey: key }).sug('A')).toBeDefined(); // a reload: still open
    r.ack('worker.dismiss_schedule_suggestion', { id: 'A', suggestion: s?.id });
    expect(rig({ schedSuggest: 'on', suggestKey: key }).sug('A')).toBeUndefined();
  });
});
