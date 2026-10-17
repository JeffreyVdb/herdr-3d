import { describe, expect, it } from 'vitest';
import type { Snapshot, WorldEvent } from '../src/net/protocol';
import { WorldStore } from '../src/world/store';
import { loadFixture } from './fixture-server';
import { SimWorld } from './fixture-sim';
import { composePrompt, ISSUE_STATUS_LINE, itemRef, PLACEMENT_LINE, runLabel, SIM_BUILD_TEAM } from './fixture-start';

type Msg = Record<string, unknown>;

/** A sim on demo-m4 (herdr-3d: repo JeffreyVdb/herdr-3d, desks 5 and 12 free), a store fed by it, manual timers. */
function rig(fail?: string) {
  const timers: Array<() => void> = [];
  const { snapshot } = loadFixture('demo-m4');
  const sim = new SimWorld(snapshot as never, { fail, setTimeout: (fn) => timers.push(fn), clearTimeout: () => {} });
  const store = new WorldStore(0);
  store.applySnapshot(sim.snapshot() as unknown as Snapshot);
  const out: Msg[] = [];
  let n = 0;
  const send = (m: Msg) => {
    out.push(m);
    if (typeof m.seq === 'number') {
      expect(m.seq).toBe(store.seq + 1);
      store.applyEvent(m as unknown as WorldEvent);
    }
  };
  const cmd = (t: string, args: unknown) => {
    const req_id = `r${++n}`;
    const from = out.length;
    sim.handle({ t, req_id, args }, send);
    return { req_id, got: () => out.slice(from) };
  };
  const settle = () => {
    while (timers.length) (timers.shift() as () => void)();
  };
  return { sim, store, cmd, settle };
}

const last = (ms: Msg[]) => ms[ms.length - 1] as Msg;
const data = (m: Msg | undefined) => (m?.t === 'ack' ? (m.data as Record<string, unknown>) : undefined);
const ROLES = SIM_BUILD_TEAM.roles;
const TEAM = ['Team:', '- coders: claude claude-opus-5-5, effort medium', '- reviewers: codex gpt-6-sol, reasoning high', '- ux reviewers: codex gpt-6-sol, reasoning high', '- researchers: codex gpt-6-sol, reasoning low', '', PLACEMENT_LINE];

describe('composePrompt (contract 2.2)', () => {
  const url = 'https://github.com/JeffreyVdb/lab/issues/3';
  it('claude ORCH, issue, no extra', () => {
    expect(composePrompt(ROLES.orch, url, ROLES, '', true)).toBe([`/write-code ${url}`, '', ...TEAM, '', ISSUE_STATUS_LINE].join('\n'));
  });
  it('codex ORCH, issue, extra (trimmed)', () => {
    expect(composePrompt({ harness: 'codex', model: 'gpt-6-sol', effort: 'high' }, url, ROLES, '  Keep the diff small.\n', true)).toBe([`$write-code ${url}`, '', ...TEAM, '', ISSUE_STATUS_LINE, '', 'Keep the diff small.'].join('\n'));
  });
  it('free text spanning lines, trimmed; a blank extra leaves no block', () => {
    expect(composePrompt(ROLES.orch, '  Add a dark mode\nto settings ', ROLES, ' \n ')).toBe(['/write-code Add a dark mode\nto settings', '', ...TEAM].join('\n'));
    expect(composePrompt({ harness: 'codex', model: 'gpt-6-luna', effort: 'low' }, 'Fix it', ROLES, 'x')).toBe(['$write-code Fix it', '', ...TEAM, '', 'x'].join('\n'));
  });
  it('#102: names an item by its URL, else "<Provider> task <key>", with no status line', () => {
    const it3 = { provider: 'kaneo', id: 't3', key: 'HRD-3', title: 'Lobby', url: 'https://k.test/dashboard/workspace/w/project/p/task/t3' };
    expect(composePrompt(ROLES.orch, itemRef('Kaneo', it3), ROLES, 'x')).toBe([`/write-code ${it3.url}`, '', ...TEAM, '', 'x'].join('\n'));
    expect(itemRef('Kaneo', { ...it3, url: '' })).toBe('Kaneo task HRD-3');
  });
  it('labels a run ORCH|issue-<n> or ORCH|<slug>, at most 10 characters after the bar', () => {
    expect(runLabel({ kind: 'issue', number: 3 })).toBe('ORCH|issue-3');
    expect(runLabel({ kind: 'issue', number: 123456 })).toBe('ORCH|issue-1234');
    expect(runLabel({ kind: 'text', text: 'Add a dark mode, please' })).toBe('ORCH|add-a-dark');
    expect(runLabel({ kind: 'text', text: '✨' })).toBe('ORCH|run');
    // Whole words only; a first word longer than 10 bytes is cut.
    expect(runLabel({ kind: 'text', text: 'Make it purple' })).toBe('ORCH|make-it');
    expect(runLabel({ kind: 'text', text: 'Internationalise everything' })).toBe('ORCH|internatio');
  });
});

describe('SimWorld presets (M6)', () => {
  it('seeds Build team into the snapshot', () => {
    const r = rig();
    expect(r.store.presets.known).toBe(true);
    expect(r.store.presets.list()).toEqual([SIM_BUILD_TEAM]);
  });

  it('creates, renames, re-roles and deletes, with name_taken and no event for a no-op update', () => {
    const r = rig();
    const c = r.cmd('preset.create', { name: ' Tiny team ', roles: { ...ROLES, coder: { harness: 'codex', model: 'gpt-6-luna', effort: 'low' } } });
    const [ev, ack] = c.got();
    expect(ev).toMatchObject({ t: 'preset.upsert', preset: { name: 'Tiny team' } });
    const id = (data(ack) as { id: string }).id;
    expect(id).toMatch(/^p_[0-9a-f]{12}$/);
    expect(r.store.presets.list().map((p) => p.name)).toEqual(['Build team', 'Tiny team']);
    expect(r.cmd('preset.create', { name: 'BUILD TEAM', roles: ROLES }).got()[0]).toMatchObject({ t: 'error', code: 'name_taken' });
    expect(r.cmd('preset.create', { name: 'x', roles: { orch: ROLES.orch } }).got()[0]).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('preset.create', { name: 'x', roles: { ...ROLES, ux: { harness: 'codex', model: 'gpt-6-luna', effort: 'ultra' } } }).got()[0]).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('preset.create', { name: 'x'.repeat(41), roles: ROLES }).got()[0]).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('preset.update', { id, name: 'build team' }).got()[0]).toMatchObject({ code: 'name_taken' });
    expect(r.cmd('preset.update', { id, name: 'Tiny team' }).got()).toEqual([{ t: 'ack', req_id: expect.any(String) }]);
    r.cmd('preset.update', { id, name: 'Small team', roles: ROLES });
    expect(r.store.presets.get(id)).toMatchObject({ name: 'Small team', roles: ROLES });
    expect(r.cmd('preset.update', { id: 'p_nope', name: 'x' }).got()[0]).toMatchObject({ code: 'not_found' });
    expect(r.cmd('preset.delete', { id }).got()[0]).toMatchObject({ t: 'preset.removed', id });
    expect(r.store.presets.get(id)).toBeNull();
    expect(r.cmd('preset.delete', { id }).got()[0]).toMatchObject({ code: 'not_found' });
  });

  it('plays an M5 bridge with simfail=no_m6', () => {
    const r = rig('no_m6');
    expect(r.store.presets.known).toBe(false);
    for (const t of ['preset.create', 'run.prepare', 'run.start']) expect(r.cmd(t, { session: 'herdr-3d' }).got()[0]).toMatchObject({ t: 'error', code: 'unknown_command' });
  });
});

describe('SimWorld runs (M6)', () => {
  it('prepares: no ticket yet, an issue number of the floor’s repo, free text, an issue URL', () => {
    const r = rig();
    const none = data(r.cmd('run.prepare', { session: 'herdr-3d' }).got()[0]);
    expect(none).toMatchObject({ prompt: '', label: '', ticket: null, preset: SIM_BUILD_TEAM.id, orch: ROLES.orch, cwd: '/home/dev/devel/herdr-3d', capacity: { floor: { count: 18 } } });
    expect(none?.git).toMatchObject({ fetched: true });
    const url = 'https://github.com/JeffreyVdb/herdr-3d/issues/7';
    expect(data(r.cmd('run.prepare', { session: 'herdr-3d', issue: '#7' }).got()[0])).toMatchObject({
      prompt: [`/write-code ${url}`, '', ...TEAM, '', ISSUE_STATUS_LINE].join('\n'),
      label: 'ORCH|issue-7',
      ticket: { kind: 'issue', repo: 'JeffreyVdb/herdr-3d', number: 7, url },
    });
    expect(data(r.cmd('run.prepare', { session: 'herdr-3d', text: 'Make it purple', orch: { harness: 'codex', model: 'gpt-6-sol', effort: 'high' }, extra: 'Small diff.' }).got()[0])).toMatchObject({
      prompt: ['$write-code Make it purple', '', ...TEAM, '', 'Small diff.'].join('\n'),
      label: 'ORCH|make-it',
      ticket: { kind: 'text', text: 'Make it purple' },
    });
    // pastry has no repo: a number is refused, a URL carries its own.
    expect(r.cmd('run.prepare', { session: 'pastry', issue: 3 }).got()[0]).toMatchObject({ code: 'bad_request', message: "bad args: the floor has no linked repo: set its repo, or give the issue's URL" });
    expect(data(r.cmd('run.prepare', { session: 'pastry', issue: 'https://github.com/a/b/issues/9' }).got()[0])).toMatchObject({ ticket: { repo: 'a/b', number: 9 } });
    expect(r.cmd('run.prepare', { session: 'herdr-3d', issue: 3, text: 'x' }).got()[0]).toMatchObject({ code: 'bad_request' });
    expect(r.cmd('run.prepare', { session: 'herdr-3d', preset: 'p_nope' }).got()[0]).toMatchObject({ code: 'not_found' });
    expect(r.cmd('run.prepare', { session: 'depot-manager' }).got()[0]).toMatchObject({ code: 'invalid_state' });
  });

  it('starts: the M4 hire at the desk with the prompt as first task, the ORCH role, last_preset', () => {
    const r = rig();
    const c = r.cmd('run.start', { session: 'herdr-3d', desk_index: 5, issue: 7, orch: ROLES.orch, preset: SIM_BUILD_TEAM.id });
    r.settle();
    const got = c.got();
    const ack = data(got.find((m) => m.t === 'ack'));
    const url = 'https://github.com/JeffreyVdb/herdr-3d/issues/7';
    expect(ack).toMatchObject({ trust: 'approved', prompted: true, launch_id: expect.stringMatching(/^l_[0-9a-f]{16}$/), prompt: [`/write-code ${url}`, '', ...TEAM, '', ISSUE_STATUS_LINE].join('\n') });
    const w = r.store.workers.get(ack?.id as string);
    expect(w).toMatchObject({ desk_index: 5, label: 'ORCH|issue-7', role: 'orch', run: 'issue-7', harness: 'claude', model: 'claude-opus-5-5', effort: 'medium', status: 'working' });
    expect(r.store.floors.get('herdr-3d')?.last_preset).toBe(SIM_BUILD_TEAM.id);
    // The floor.upsert with last_preset and the ORCH's upsert come before the ack.
    const i = got.findIndex((m) => m.t === 'ack');
    expect(got.slice(0, i).some((m) => m.t === 'floor.upsert' && (m.floor as Msg).last_preset === SIM_BUILD_TEAM.id)).toBe(true);
    // Deleting the preset forgets it on the floor.
    const del = r.cmd('preset.delete', { id: SIM_BUILD_TEAM.id }).got();
    expect(del.map((m) => m.t)).toEqual(['preset.removed', 'floor.upsert', 'ack']);
    expect(r.store.floors.get('herdr-3d')?.last_preset).toBeUndefined();
    // With no preset left: preset "", orch as asked (else null), no prompt.
    expect(data(r.cmd('run.prepare', { session: 'herdr-3d', issue: 7 }).got()[0])).toMatchObject({ prompt: '', label: 'ORCH|issue-7', preset: '', orch: null });
    expect(data(r.cmd('run.prepare', { session: 'herdr-3d', issue: 7, orch: ROLES.orch }).got()[0])).toMatchObject({ prompt: '', preset: '', orch: ROLES.orch });
  });

  it('sends an edited prompt as is, takes the label, refuses taken desks like a hire', () => {
    const r = rig();
    const c = r.cmd('run.start', { session: 'herdr-3d', desk_index: 12, text: 'Tidy', orch: ROLES.orch, preset: SIM_BUILD_TEAM.id, label: 'ORCH|tidy', worktree: false, prompt: '/write-code Tidy, gently' });
    r.settle();
    const ack = data(c.got().find((m) => m.t === 'ack'));
    expect(ack?.prompt).toBe('/write-code Tidy, gently');
    expect(r.store.workers.get(ack?.id as string)).toMatchObject({ label: 'ORCH|tidy', desk_index: 12, title: '/write-code Tidy, gently' });
    expect(r.store.workers.get(ack?.id as string)?.branch).toBeUndefined();
    expect(r.cmd('run.start', { session: 'herdr-3d', desk_index: 0, text: 'x', orch: ROLES.orch, preset: SIM_BUILD_TEAM.id }).got()[0]).toMatchObject({ code: 'desk_taken' });
    expect(r.cmd('run.start', { session: 'herdr-3d', desk_index: 5, text: 'x', orch: ROLES.orch, preset: 'p_nope' }).got()[0]).toMatchObject({ code: 'not_found' });
    expect(r.cmd('run.start', { session: 'herdr-3d', desk_index: 5, orch: ROLES.orch, preset: SIM_BUILD_TEAM.id }).got()[0]).toMatchObject({ code: 'bad_request' });
    expect(last(r.cmd('run.start', { session: 'herdr-3d', desk_index: 5, text: 'x', orch: ROLES.orch, preset: SIM_BUILD_TEAM.id, prompt: '--help' }).got())).toMatchObject({ code: 'bad_request' });
  });
});
