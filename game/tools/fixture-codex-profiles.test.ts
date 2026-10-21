import { describe, expect, it } from 'vitest';
import type { Limits, Worker } from '../src/net/protocol.ts';
import { loadFixture } from './fixture-server.ts';
import { SimWorld } from './fixture-sim.ts';
import { CodexProfilesSim } from './fixture-codex-profiles.ts';
import { LimitsSim, readings } from './fixture-limits.ts';

class CmdError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const NOW = Date.UTC(2026, 9, 21, 9, 0);

function sim(n = 2) {
  const sent: Array<Record<string, unknown>> = [];
  const s = new CodexProfilesSim({ emit: (send, m) => send(m), error: (code, message) => new CmdError(code, message), now: () => NOW }, n);
  const limits = new LimitsSim('ok', true, () => NOW, (send, m) => send(m), (code, message) => new CmdError(code, message), s);
  const run = (t: string, a: Record<string, unknown> = {}) => {
    let acked: unknown;
    s.handle(t, a, (m) => sent.push(m), (d) => (acked = d), () => limits.codexBase());
    return acked as { profiles: Array<{ key: string; name: string; hidden: boolean }> };
  };
  const world: Record<string, unknown> = {};
  limits.decorate(world);
  s.decorate(world);
  return { s, sent, run, world };
}

describe('the fixture’s Codex profiles (#138)', () => {
  it('simcodexprofiles=2: two visible profiles on the meter (work stale), a hidden and an added one in Settings', () => {
    const { world } = sim();
    const l = world.limits as Limits[];
    expect(l.map((x) => [x.provider, x.account?.key, x.stale])).toEqual([
      ['claude', undefined, false],
      ['codex', 'codex', false],
      ['codex', 'work', true],
      ['codex', 'spare', false],
    ]);
    expect(l[2]!.at).toBe(NOW - 50 * 60_000);
    expect(l[3]!.error).toBe('no_plan');
    const p = (world.codex_profiles as { profiles: Array<{ key: string; hidden: boolean; added: boolean }> }).profiles;
    expect(p.map((x) => [x.key, x.hidden, x.added])).toEqual([
      ['codex', false, false],
      ['work', false, false],
      ['old', true, false],
      ['spare', false, true],
    ]);
  });

  it('simcodexprofiles=1: the default only, the scenario’s reading with its account', () => {
    const { world } = sim(1);
    const l = world.limits as Limits[];
    expect(l.map((x) => x.account?.key ?? x.provider)).toEqual(['claude', 'codex']);
    expect({ ...l[1], account: undefined }).toEqual({ ...readings('ok', NOW)[1], account: undefined });
  });

  it('shows the profile hidden from the start (Settings > Show old)', () => {
    const { run, sent } = sim();
    expect(run('codex_profiles.set', { key: 'old', hidden: false }).profiles.find((p) => p.key === 'old')!.hidden).toBe(false);
    expect(sent.map((m) => m.t)).toEqual(['codex_profiles.update', 'limits.update']);
    expect(run('codex_profiles.set', { key: 'old', hidden: true, remove: false }).profiles.find((p) => p.key === 'old')!.hidden).toBe(true);
  });

  it('renames (with the reading again), hides and shows, refuses as herdr-world, adds and removes', () => {
    const { run, sent } = sim();
    expect(run('codex_profiles.set', { key: 'work', name: 'Work seat' }).profiles[1]!.name).toBe('Work seat');
    expect(sent.map((m) => m.t)).toEqual(['limits.update', 'codex_profiles.update']);
    expect((sent[0]!.account as { name: string }).name).toBe('Work seat');
    expect(() => run('codex_profiles.set', { key: 'codex', hidden: true })).toThrow(/cannot be hidden/);
    expect(() => run('codex_profiles.set', { key: 'work', remove: true })).toThrow(/only hidden/);
    expect(() => run('codex_profiles.set', { key: 'work', name: 'CODEX' })).toThrow(/Another profile/);
    expect(() => run('codex_profiles.set', { add: '~/nothing' })).toThrow(/no folder there/);
    expect(() => run('codex_profiles.set', { add: 'rel' })).toThrow(/absolute path/);
    expect(() => run('codex_profiles.set', { key: 'nope', hidden: true })).toThrow(/no Codex profile/);
    expect(run('codex_profiles.set', { key: 'work', hidden: true }).profiles[1]!.hidden).toBe(true);
    expect(() => run('codex_profiles.set', { key: 'work', hidden: false, remove: true })).toThrow(/exactly one/);
    sent.length = 0;
    expect(run('codex_profiles.set', { key: 'work', hidden: false }).profiles[1]!.hidden).toBe(false);
    expect(sent.map((m) => [m.t, (m.account as { key: string } | undefined)?.key])).toEqual([
      ['codex_profiles.update', undefined],
      ['limits.update', 'work'],
    ]);
    const added = run('codex_profiles.set', { add: '~/.codex-team' }).profiles;
    expect(added.at(-1)).toMatchObject({ key: 'team', added: true });
    expect(run('codex_profiles.set', { key: 'team', remove: true }).profiles.map((p) => p.key)).toEqual(['codex', 'work', 'old', 'spare']);
  });
});

describe('the fixture’s Codex profiles on a hire (#139)', () => {
  type Msg = Record<string, unknown> & { t: string; req_id?: string; data?: Record<string, unknown>; code?: string };
  function world(n?: number) {
    const timers: Array<() => void> = [];
    const { snapshot } = loadFixture('demo');
    const sim = new SimWorld(snapshot as never, { ...(n ? { codexProfiles: n } : {}), setTimeout: (fn) => timers.push(fn), clearTimeout: () => {} });
    let k = 0;
    const cmd = (t: string, args: unknown): Msg | undefined => {
      const out: Msg[] = [];
      const req_id = `r${++k}`;
      sim.handle({ t, req_id, args }, (m) => out.push(m as Msg));
      while (timers.length) (timers.shift() as () => void)();
      return out.find((m) => (m.t === 'ack' || m.t === 'error') && m.req_id === req_id);
    };
    const snap = sim.snapshot() as unknown as { world: { workers: Worker[]; codex_profiles?: { hire?: boolean } } };
    return { cmd, snap };
  }
  const hire = (desk: number, more: Record<string, unknown>) => ({ floor: 'herdr-3d', desk_index: desk, harness: 'codex', model: 'gpt-6-sol', effort: 'high', ...more });

  it('says the bridge takes a profile on a hire, and seeds the seat lines', () => {
    const { snap } = world(2);
    expect(snap.world.codex_profiles?.hire).toBe(true);
    const by = (name: string) => snap.world.workers.find((w) => w.name === name)?.codex;
    expect(by('Pixel')).toMatchObject({ profile: 'work', account: 'confirmed' });
    expect(by('Sprocket')?.profile_note).toContain('is gone: woke on codex');
    expect(by('Bean')).toMatchObject({ profile: 'work', account: 'mismatch' });
    expect(by('Pip')?.profile).toBeUndefined();
  });

  it('a hire on a profile carries it; not signed in fails, an unknown one is not found; an older bridge refuses the field', () => {
    const { cmd } = world(2);
    const r = cmd('worker.hire', hire(5, { codex_profile: 'work' }));
    expect(r, JSON.stringify(r)).toBeDefined();
    expect(r?.data?.codex, JSON.stringify(r)).toMatchObject({ profile: 'work', account: 'confirmed', plan: 'team' });
    const spare = cmd('worker.hire', hire(12, { codex_profile: 'spare' }));
    expect([spare?.code, spare?.message]).toEqual(['hire_failed', 'hire_failed: spare is not signed in. Run `CODEX_HOME=/srv/codex-spare codex login` in a terminal.']);
    expect(cmd('worker.hire', hire(12, { codex_profile: 'nope' }))?.code).toBe('not_found');
    expect(cmd('worker.hire', hire(12, { harness: 'claude', model: 'claude-opus-5-5', codex_profile: 'work' }))?.code).toBe('bad_request');
    expect(world().cmd('worker.hire', hire(12, { codex_profile: 'work' }))?.code).toBe('bad_request');
  });
});
