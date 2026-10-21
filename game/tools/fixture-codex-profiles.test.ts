import { describe, expect, it } from 'vitest';
import type { HirePreset, Limits, Worker } from '../src/net/protocol.ts';
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
    const snap = sim.snapshot() as unknown as { world: { workers: Worker[]; codex_profiles?: { hire?: boolean }; hire_presets?: HirePreset[] } };
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

  it('starts with a preset on a gone profile, with one profile or two; none without profiles', () => {
    for (const n of [1, 2]) {
      expect(world(n).snap.world.hire_presets?.filter((p) => p.codex_profile)).toEqual([
        expect.objectContaining({ name: 'Review on old-work', harness: 'codex', codex_profile: 'old-work' }),
      ]);
    }
    expect(world().snap.world.hire_presets?.some((p) => p.codex_profile)).toBe(false);
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

describe('the fixture’s Auto (#140)', () => {
  it('lists Auto, the seeded rule and the flag; checks and stores rules and the flag as herdr-world', () => {
    const { run, world } = sim();
    const v = world.codex_profiles as { auto?: boolean; rules?: unknown[]; profiles: Array<{ key: string; anything?: boolean }> };
    expect(v.auto).toBe(true);
    expect(v.rules).toEqual([{ match: 'github.com/acme/*', profile: 'work' }]);
    expect(v.profiles.filter((p) => p.anything).map((p) => p.key)).toEqual(['codex']);
    const ack = run('codex_profiles.set', { rules: [{ match: 'GitHub.com/JeffreyVdb/*', profile: 'work' }, { match: '~/scratch/', profile: 'codex' }] }) as unknown as { rules: unknown[] };
    expect(ack.rules).toEqual([{ match: 'github.com/JeffreyVdb/*', profile: 'work' }, { match: '~/scratch', profile: 'codex' }]);
    expect(() => run('codex_profiles.set', { rules: [{ match: '/a', profile: 'work' }, { match: 'acme/*', profile: 'work' }] })).toThrow(
      'Rule 2: use github.com/<owner>/* or github.com/<owner>/<repo>, or a folder starting with / or ~/.',
    );
    expect(() => run('codex_profiles.set', { rules: [{ match: '/a', profile: 'nope' }] })).toThrow('Rule 1: there is no Codex profile "nope".');
    // A folder keeps its case, as the bridge's; GitHub matches are one rule ignoring case.
    const cased = run('codex_profiles.set', { rules: [{ match: '/work/A', profile: 'work' }, { match: '/work/a/', profile: 'codex' }] }) as unknown as { rules: unknown[] };
    expect(cased.rules).toEqual([{ match: '/work/A', profile: 'work' }, { match: '/work/a', profile: 'codex' }]);
    expect(() => run('codex_profiles.set', { rules: [{ match: 'github.com/acme/*', profile: 'work' }, { match: 'github.com/ACME/*', profile: 'codex' }] })).toThrow('Rule 2: rule 1 already matches ACME/*.');
    run('codex_profiles.set', { rules: [{ match: 'GitHub.com/JeffreyVdb/*', profile: 'work' }, { match: '~/scratch/', profile: 'codex' }] });
    expect(() => run('codex_profiles.set', { key: 'work', rules: [] })).toThrow('rules takes no key');
    run('codex_profiles.set', { key: 'work', anything: true });
    expect(run('codex_profiles.get').profiles.filter((p) => (p as { anything?: boolean }).anything).map((p) => p.key)).toEqual(['codex', 'work']);
  });

  it('picks as the bridge does: a rule, else the flagged profile with a fresh reading, else the default', () => {
    const { s, run } = sim();
    const base = readings('ok', NOW)[1];
    expect(s.pick('/home/u/herdr-3d', base)).toEqual({ key: 'codex', reason: 'Account: codex (the only profile that may be used for anything)' });
    run('codex_profiles.set', { key: 'work', anything: true });
    // work's reading is stale, the scenario's has a week only: codex (fresh) has the more known left.
    expect(s.pick('/home/u/herdr-3d', base)).toEqual({ key: 'codex', reason: 'Account: codex (most left: 81% of the week)' });
    run('codex_profiles.set', { rules: [{ match: 'github.com/JeffreyVdb/*', profile: 'work' }] });
    expect(s.pick('/home/u/herdr-3d', base)).toEqual({ key: 'work', reason: 'Account: work (rule JeffreyVdb/*)' });
    run('codex_profiles.set', { rules: [{ match: 'github.com/JeffreyVdb/herdr-3d', profile: 'old' }] });
    expect(s.pick('/home/u/herdr-3d', base).reason).toMatch(/; rule JeffreyVdb\/herdr-3d names old, which is hidden\)$/);
    run('codex_profiles.set', { key: 'codex', anything: false });
    run('codex_profiles.set', { key: 'work', anything: false });
    run('codex_profiles.set', { rules: [] });
    expect(s.pick('/x', base)).toEqual({ key: 'codex', reason: 'Account: codex (no rule matched, no profile may be used for anything: the default)' });
  });
});


describe('the fixture’s shared setup (#167)', () => {
  type View = { profiles: Array<{ key: string; share?: boolean; drift?: Array<{ kind: string; name: string }> }>; share?: boolean; steps?: Array<{ name: string; action: string; backup?: string }>; report?: string };
  const run = (s: ReturnType<typeof sim>, t: string, a: Record<string, unknown>) => s.run(t, a) as unknown as View;
  const fails = (s: ReturnType<typeof sim>, t: string, a: Record<string, unknown>) => {
    try {
      s.run(t, a);
    } catch (e) {
      return (e as CmdError).message;
    }
    return 'acked';
  };
  const drift = (v: View, key: string) => v.profiles.find((p) => p.key === key)?.drift?.map((d) => `${d.kind}:${d.name}`) ?? [];

  it('says the bridge shares; work shares and drifted, old shares hidden (none), spare does not share', () => {
    const { world } = sim();
    const v = world.codex_profiles as View;
    expect(v.share).toBe(true);
    expect(v.profiles.map((p) => [p.key, p.share ?? false])).toEqual([
      ['codex', false],
      ['work', true],
      ['old', true],
      ['spare', false],
    ]);
    expect(drift(v, 'work')).toEqual(['link_replaced:config.toml', 'skill_only_default:infra']);
    expect(drift(v, 'old')).toEqual([]);
  });

  it('plans, refuses an unconfirmed replace, applies with its report, fixes, moves the skill, and shares off', () => {
    const s = sim();
    const plan = run(s, 'codex_profiles.share', { key: 'spare', share: true, dry_run: true });
    expect(plan.steps?.map((x) => `${x.name}:${x.action}`)).toEqual(['config.toml:replace', 'AGENTS.md:link', 'AGENTS.override.md:skip', 'rules/:skip', 'hooks.json:write']);
    expect(plan.steps?.[0]?.backup).toBe('config.toml.before-share-20261021-090000');
    expect(fails(s, 'codex_profiles.share', { key: 'spare', share: true })).toBe('bad args: /srv/codex-spare changed since you looked; look again.');
    expect(fails(s, 'codex_profiles.share', { key: 'codex', share: true })).toBe('bad args: The default profile is the one the others share from.');
    expect(fails(s, 'codex_profiles.share', { key: 'work' })).toBe('bad args: share is required');
    const on = run(s, 'codex_profiles.share', { key: 'spare', share: true, replace: ['config.toml'] });
    expect(on.report).toBe('Linked config.toml and AGENTS.md, wrote hooks.json, backed up the old config.toml to config.toml.before-share-20261021-090000. Codex will ask once to review the hooks of spare.');
    expect(drift(on, 'spare')).toEqual(['skill_only_default:infra']);
    expect(s.sent.at(-1)?.t).toBe('codex_profiles.update');
    const fix = run(s, 'codex_profiles.share', { key: 'work', share: true, replace: ['config.toml'] });
    expect(drift(fix, 'work')).toEqual(['skill_only_default:infra']);
    const moved = run(s, 'codex_profiles.move_skill', { key: 'codex', skill: 'infra' });
    expect(moved.report).toBe("Moved the skill infra to ~/.agents/skills/infra and left a link in codex's skills/: every Codex home sees it now.");
    expect(drift(moved, 'work')).toEqual([]);
    const off = run(s, 'codex_profiles.share', { key: 'work', share: false });
    expect(off.report).toBe('Copied config.toml and AGENTS.md from codex: work keeps them as its own and no longer follows codex. Its hooks.json stays.');
    expect(off.profiles.find((p) => p.key === 'work')?.share).toBe(false);
  });
});
