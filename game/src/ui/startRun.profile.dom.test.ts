// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { CodexProfile, CodexProfilesState, Hire, HireOptions, Preset, PresetRoles, RunPrepare } from '../net/protocol';
import { flush, installDialogs } from '../test/secretsBridge';
import { CodexProfilesBook } from '../world/codexProfiles';
import { PresetBook } from '../world/presets';
import { PresetsPanel, type PresetsHost } from './presets';
import { StartRunDialog, type StartRunHost } from './startRun';

// #167: "Start a run" → Hire orchestrator shows the "Codex profile" chips of a Codex hire for a Codex orchestrator, with
// two or more usable profiles, on a bridge that takes a profile on runs; else the dialog is as before. The team preset
// editor shows them under each Codex role. Each sends `codex_profile` only to such a bridge. Fixture names only.

const CAT: HireOptions = { codex: { models: ['x-1'], efforts: ['low'] }, claude: { models: ['y-1'], efforts: ['low'] } };
const cx = (p?: string): Hire => ({ harness: 'codex', model: 'x-1', effort: 'low', ...(p ? { codex_profile: p } : {}) });
const cl = (): Hire => ({ harness: 'claude', model: 'y-1', effort: 'low' });
const roles = (orch: Hire, reviewer: Hire = cx()): PresetRoles => ({ orch, coder: cl(), reviewer, ux: cl(), researcher: cx() });
const prof = (key: string, more: Partial<CodexProfile> = {}): CodexProfile => ({
  key, name: key, path: `/home/test/.codex-${key}`, display: `~/.codex-${key}`, plan: '', signed_in: true, default: false, hidden: false, added: false, ...more,
});
const own = prof('codex', { default: true, name: 'Own', path: '/home/test/.codex' });
const RUNS: CodexProfilesState = { hire: true, auto: true, runs: true, rules: [], profiles: [own, prof('work', { name: 'Work' })] };
const { runs: _runs, ...NORUNS } = RUNS;

function setup(state: CodexProfilesState | null, preset: Preset) {
  document.body.replaceChildren();
  const book = new PresetBook();
  book.reset([preset]);
  const profiles = new CodexProfilesBook();
  profiles.reset(state);
  const starts: Array<Record<string, unknown>> = [];
  const prepares: Array<Record<string, unknown>> = [];
  const toasts: Array<[string, string]> = [];
  const store = {
    floorName: (id: string) => id,
    hireOptions: CAT,
    presets: book,
    codexProfiles: profiles,
    preparePreview: true,
    floorView: () => ({ seats: Array(10).fill(null), floor: {}, settings: {}, suggested: {} }),
    limits: { version: 0, list: () => [] },
    workerView: () => null,
    repoRefs: { state: { all_buildings: false }, onChange: () => () => {} },
  };
  let ack: Record<string, unknown> = { id: 'w9', launch_id: 'l1', prompt: 'p', prompted: true };
  const sent: Array<[string, unknown]> = [];
  const refusals: CommandResult[] = [];
  const send = (t: string, args: Record<string, unknown>): Promise<CommandResult> => {
    sent.push([t, args]);
    if (t.startsWith('preset.') && refusals.length) return Promise.resolve(refusals.shift()!);
    if (t === 'run.prepare') {
      prepares.push(args);
      const prep: RunPrepare = { prompt: '/write-code the ticket', label: 'ORCH|run', preset: preset.id, orch: preset.roles.orch, cwd: '/home/test', git: null,
        capacity: { floor: { count: 0, soft: 10, hard: 20 }, host: { count: 0, soft: 10, hard: 20 } } };
      return Promise.resolve({ ok: true, data: prep });
    }
    if (t === 'run.start') {
      starts.push(args);
      return Promise.resolve({ ok: true, data: ack });
    }
    return Promise.resolve({ ok: true, data: {} });
  };
  const host = { store, send, unsupported: () => false, reserve: () => () => {}, held: () => new Set<number>(), toast: (m: string, k: string) => toasts.push([m, k]), now: () => Date.now(),
    upload: () => new Promise(() => {}), hireAt: () => {}, openPresets: () => {}, started: () => {} } as unknown as StartRunHost;
  const dlg = new StartRunDialog(document.body, host);
  const panel = new PresetsPanel(document.body, { store, send, unsupported: () => false, toast: () => {} } as unknown as PresetsHost);
  return { dlg, panel, sent, refusals, starts, prepares, toasts, profiles, setAck: (a: Record<string, unknown>) => (ack = a) };
}

const orchChips = () => document.querySelector('.desk-dlg--run [data-pick="orch-profile"]');
const chipKeys = (scope: ParentNode | null) => [...(scope?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? [])].map((i) => (i.checked ? `*${i.value}` : i.value));
async function ticket(text: string) {
  const ta = document.querySelector<HTMLTextAreaElement>('#run-ticket')!;
  ta.value = text;
  ta.dispatchEvent(new Event('input'));
  await vi.advanceTimersByTimeAsync(300);
  await flush();
}
async function startRun() {
  document.querySelector<HTMLElement>('[data-key="start"]')!.click();
  await flush();
  await flush();
}

describe('Start a run: the orchestrator’s Codex profile (#167)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    installDialogs();
    vi.stubGlobal('CSS', { escape: (s: string) => s });
  });
  afterEach(() => {
    for (const d of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) d.close();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('a Codex orchestrator with two usable profiles: the chips, Auto first, the preset’s picked; run.start carries the pick', async () => {
    const t = setup(RUNS, { id: 'p_1', name: 'Team', roles: roles(cx('work')) });
    t.dlg.open({ floor: 'floor', desk: 0 });
    await flush();
    expect(chipKeys(orchChips())).toEqual(['auto', 'codex', '*work']);
    expect(orchChips()?.querySelector('legend')?.textContent).toBe('Codex profile');
    await ticket('Tidy the lobby');
    expect(t.prepares.every((a) => !a.orch || !('codex_profile' in (a.orch as object)))).toBe(true);
    document.querySelector<HTMLInputElement>('[data-key="orch-profile:auto"]')!.click();
    expect(t.dlg.summary()?.profile).toBe('auto');
    t.setAck({ id: 'w9', launch_id: 'l1', prompt: 'p', prompted: true, codex_team_reason: 'reviewers: Account: work (rule acme/*)', codex_team_note: 'work has no hooks.json with herdr’s hook.' });
    await startRun();
    expect(t.starts).toHaveLength(1);
    expect(t.starts[0]!.orch).toEqual(cx('auto'));
    expect(t.toasts.at(-1)).toEqual([expect.stringContaining('Team: reviewers: Account: work (rule acme/*). work has no hooks.json'), 'warn']);
  });

  it('as today with a Claude orchestrator, one usable profile, or a bridge that takes none: no chips, no codex_profile', async () => {
    for (const [state, orch] of [
      [RUNS, cl()],
      [{ ...RUNS, profiles: [own, prof('work', { hidden: true })] }, cx()],
      [NORUNS, cx('work')],
      [null, cx('work')],
    ] as const) {
      const t = setup(state as CodexProfilesState | null, { id: 'p_1', name: 'Team', roles: roles(orch) });
      t.dlg.open({ floor: 'floor', desk: 0 });
      await flush();
      expect(orchChips()).toBeNull();
      expect(document.querySelector('[data-hook="profile-gone"]')).toBeNull();
      await ticket('Tidy the lobby');
      await startRun();
      expect(t.starts.at(-1)?.orch).toEqual(orch.harness === 'codex' ? cx() : cl());
      t.dlg.close();
    }
  });

  it('a gone preset profile falls back to the default and says so (also with no picker left)', async () => {
    const t = setup(RUNS, { id: 'p_1', name: 'Team', roles: roles(cx('lab')) });
    t.dlg.open({ floor: 'floor', desk: 0 });
    await flush();
    expect(chipKeys(orchChips())).toEqual(['auto', '*codex', 'work']);
    expect(document.querySelector('[data-hook="profile-gone"]')?.textContent).toBe('This preset’s Codex profile “lab” is gone: it runs on Own.');
    t.dlg.close();
    const lone = setup({ ...RUNS, profiles: [own] }, { id: 'p_1', name: 'Team', roles: roles(cx('lab')) });
    lone.dlg.open({ floor: 'floor', desk: 0 });
    await flush();
    expect(orchChips()).toBeNull();
    expect(document.querySelector('[data-hook="profile-gone"]')?.textContent).toBe('This preset’s Codex profile “lab” is gone: it runs on Own.');
  });
});

describe('Team presets: a Codex role’s profile (#167)', () => {
  beforeEach(() => {
    installDialogs();
    vi.stubGlobal('CSS', { escape: (s: string) => s });
  });
  afterEach(() => {
    for (const d of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) d.close();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });
  const rowChips = (r: string) => document.querySelector(`[data-role-profile="${r}"]`);

  it('chips only under Codex roles, the stored one picked; a pick and a harness switch go to preset.update', async () => {
    const t = setup(RUNS, { id: 'p_1', name: 'Team', roles: roles(cx(), cx('work')) });
    t.panel.open();
    expect(document.querySelector('.pp-roles')?.textContent).toContain('codex · x-1 · low · Work');
    document.querySelector<HTMLButtonElement>('[data-key="edit:p_1"]')!.click();
    expect(['orch', 'reviewer', 'researcher'].map((r) => chipKeys(rowChips(r)))).toEqual([['auto', '*codex', 'work'], ['auto', 'codex', '*work'], ['auto', '*codex', 'work']]);
    expect(rowChips('coder')).toBeNull();
    expect(rowChips('ux')).toBeNull();
    document.querySelector<HTMLInputElement>('[data-key="role:researcher:profile:auto"]')!.click();
    const harness = document.querySelector<HTMLSelectElement>('[data-key="role:reviewer:harness"]')!;
    harness.value = 'claude';
    harness.dispatchEvent(new Event('change'));
    expect(rowChips('reviewer')).toBeNull();
    document.querySelector<HTMLFormElement>('#presets-form')!.requestSubmit();
    await flush();
    expect(t.sent).toEqual([['preset.update', { id: 'p_1', roles: { orch: cx(), coder: cl(), reviewer: cl(), ux: cl(), researcher: cx('auto') } }]]);
  });

  it('a role profile the bridge refuses is said under the roles; the editor stays on that preset', async () => {
    const t = setup(RUNS, { id: 'p_1', name: 'Team', roles: roles(cx(), cx()) });
    t.refusals.push({ ok: false, code: 'bad_request', message: 'bad args: roles.reviewer: no Codex profile "work"' });
    t.panel.open();
    document.querySelector<HTMLButtonElement>('[data-key="edit:p_1"]')!.click();
    document.querySelector<HTMLInputElement>('[data-key="role:reviewer:profile:work"]')!.click();
    document.querySelector<HTMLFormElement>('#presets-form')!.requestSubmit();
    await flush();
    expect(t.panel.summary()?.editing).toMatchObject({ id: 'p_1', error: { field: 'roles', why: 'herdr-world refused it: roles.reviewer: no Codex profile "work"' } });
  });

  it('a bridge that takes no profile on runs: no chips, and none sent', async () => {
    const t = setup(NORUNS, { id: 'p_1', name: 'Team', roles: roles(cx(), cx()) });
    t.panel.open();
    document.querySelectorAll<HTMLButtonElement>('[data-key="edit:p_1"]')[0]!.click();
    expect(document.querySelector('[data-role-profile]')).toBeNull();
  });

  // Review B-R1: a stored profile that is gone, not signed in or hidden shows the default checked; saving (the default
  // clicked or not) stores the default, what the chips show.
  for (const key of ['gone', 'work', 'hidden']) {
    it(`a role on a ${key === 'work' ? 'signed-out' : key} profile saves the default it shows`, async () => {
      const state = key === 'work' ? { ...RUNS, profiles: [own, prof('work', { signed_in: false })] }
        : key === 'hidden' ? { ...RUNS, profiles: [...RUNS.profiles, prof('hidden', { hidden: true })] } : RUNS;
      for (const click of [true, false]) {
        const t = setup(state, { id: 'p_1', name: 'Team', roles: roles(cx(), cx(key)) });
        t.panel.open();
        document.querySelector<HTMLButtonElement>('[data-key="edit:p_1"]')!.click();
        const def = document.querySelector<HTMLInputElement>('[data-key="role:reviewer:profile:codex"]')!;
        expect(def.checked).toBe(true);
        if (click) def.click();
        const name = document.querySelector<HTMLInputElement>('#preset-name')!;
        name.value = 'Renamed';
        name.dispatchEvent(new Event('input'));
        document.querySelector<HTMLFormElement>('#presets-form')!.requestSubmit();
        await flush();
        expect(t.sent).toEqual([['preset.update', { id: 'p_1', name: 'Renamed', roles: roles(cx(), cx('codex')) }]]);
        t.panel.close();
      }
    });
  }
});
