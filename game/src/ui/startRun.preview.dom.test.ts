// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { Hire, HireGit, HireOptions, Preset, RunPrepare } from '../net/protocol';
import { flush, installDialogs, secretsBridge } from '../test/secretsBridge';
import { PresetBook } from '../world/presets';
import { StartRunDialog, type StartRunHost } from './startRun';

// #134: Start a run opens, and follows every edit, on a preview of the local refs where the bridge takes one
// (`prepare_preview`); Fetch again and the recheck after a refusal fetch origin; an older bridge is never sent `preview`.

const CAT: HireOptions = { claude: { models: ['claude-fable-5-1'], efforts: ['high'] } };
const role = (): Hire => ({ harness: 'claude', model: 'claude-fable-5-1', effort: 'high' });
const PRESET: Preset = { id: 'p_000000000001', name: 'Team', roles: { orch: role(), coder: role(), reviewer: role(), ux: role(), researcher: role() } };
const GIT: HireGit = { repo_root: '/home/test', default_branch: 'main', base_sha: '1a2b3c4d5e6f', base_time: Date.now() - 3 * 3600_000, fetched: true };

/** `supported`: the snapshot's `prepare_preview`. `origin`: what a fetch finds. `hold`: run.prepare answers wait for `release`. */
function setup(o: { supported?: boolean } = {}) {
  document.body.replaceChildren();
  const b = secretsBridge({ on: false });
  const state = { origin: 'up' as 'up' | 'down', hold: false, starts: [] as CommandResult[] };
  const held: Array<() => void> = [];
  const prepares: Array<Record<string, unknown>> = [];
  const book = new PresetBook();
  book.reset([PRESET]);
  const store = {
    floorName: (id: string) => id,
    hireOptions: CAT,
    presets: book,
    preparePreview: o.supported ?? true,
    floorView: () => ({ seats: Array(10).fill(null), floor: {}, settings: {}, suggested: {} }),
    limits: { version: 0, list: () => [] },
    workerView: () => null,
    repoRefs: { state: { all_buildings: false }, onChange: () => () => {} },
  };
  const send = (t: string, args: Record<string, unknown>): Promise<CommandResult> => {
    if (t === 'run.prepare') {
      // The preset and orchestrator the first answer chose are not what these tests look at.
      const { preset: _p, orch: _o, ...rest } = args;
      prepares.push(rest);
      const git: HireGit = args.preview ? { ...GIT, fetched: false, preview: true } : state.origin === 'up' ? GIT : { ...GIT, fetched: false, fetch_error: 'origin is offline' };
      const prep: RunPrepare = { prompt: '$write-code the ticket', label: 'ORCH|run', preset: PRESET.id, orch: PRESET.roles.orch, cwd: '/home/test', git, capacity: { floor: { count: 0, soft: 10, hard: 20 }, host: { count: 0, soft: 10, hard: 20 } } };
      const answer: CommandResult = { ok: true, data: prep };
      return state.hold ? new Promise((r) => held.push(() => r(answer))) : Promise.resolve(answer);
    }
    if (t === 'run.start') return Promise.resolve(state.starts.shift() ?? { ok: true, data: { id: 'w9', launch_id: 'l1', prompt: 'p', prompted: true } });
    return Promise.resolve({ ok: true, data: {} });
  };
  const host = { store, send, unsupported: () => false, reserve: () => () => {}, held: () => new Set<number>(), toast: () => {}, now: () => Date.now(), upload: () => new Promise(() => {}), hireAt: () => {}, openPresets: () => {}, started: () => {}, secrets: b.flow } as unknown as StartRunHost;
  const dlg = new StartRunDialog(document.body, host);
  const release = () => held.splice(0).forEach((r) => r());
  return { dlg, state, prepares, release, held };
}

const base = () => document.querySelector('#run-worktree-base')?.textContent ?? '';
const refetch = () => document.querySelector<HTMLButtonElement>('[data-key="refetch"]');
const settle = async () => {
  await vi.advanceTimersByTimeAsync(300); // the debounced run.prepare
  await flush();
};
function type(text: string) {
  const ta = document.querySelector<HTMLTextAreaElement>('#run-ticket')!;
  ta.value = text;
  ta.dispatchEvent(new Event('input'));
}

describe('StartRunDialog: the base as a preview (#134)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    installDialogs();
    vi.stubGlobal('CSS', { escape: (s: string) => s });
  });
  afterEach(() => {
    for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('opens and follows an edit on a preview, says the base is the last fetched one, and keeps the worktree on', async () => {
    const t = setup();
    t.state.hold = true;
    t.dlg.open({ floor: 'floor', desk: 0 });
    expect(t.dlg.summary()?.status).toBe('Asking herdr-world for the team and the folder…');
    t.release();
    await flush();
    type('Tidy the lobby');
    t.state.hold = false;
    await settle();
    expect(t.prepares).toEqual([{ floor: 'floor', preview: true }, { floor: 'floor', text: 'Tidy the lobby', preview: true }]);
    expect(t.dlg.summary()?.git).toMatchObject({ usable: true, note: null, hint: 'last fetched; refreshed before branching' });
    expect(t.dlg.summary()?.form.worktree).toBe(true);
    expect(base()).toMatch(/^A new h3d\/… branch from origin\/main @ 1a2b3c4, 3 h old \(last fetched; refreshed before branching\)$/);
    expect(refetch()).toBeNull();
    t.dlg.close();
  });

  it('an older bridge (no prepare_preview) is never sent preview: every prepare fetches, as before', async () => {
    const t = setup({ supported: false });
    t.dlg.open({ floor: 'floor', desk: 0 });
    expect(t.dlg.summary()?.status).toBe('Asking herdr-world for the team, the folder and origin…');
    await flush();
    type('Tidy the lobby');
    await settle();
    expect(t.prepares).toEqual([{ floor: 'floor' }, { floor: 'floor', text: 'Tidy the lobby' }]);
    expect(t.dlg.summary()?.git).toMatchObject({ hint: null, usable: true });
    expect(base()).toMatch(/^A new h3d\/… branch from origin\/main @ 1a2b3c4, 3 h old$/);
    t.dlg.close();
  });

  it('a fetch refusal fetches origin again; an edit after it keeps the failure; Fetch again fetches and turns it back', async () => {
    const t = setup();
    t.state.origin = 'down';
    t.state.starts.push({ ok: false, code: 'fetch_failed', message: 'git fetch origin failed: origin is offline' });
    t.dlg.open({ floor: 'floor', desk: 0 });
    await flush();
    type('Tidy the lobby');
    await settle();
    expect(t.dlg.summary()?.form.worktree).toBe(true);
    document.querySelector<HTMLElement>('[data-key="start"]')!.click();
    await flush();
    await flush();
    // The recheck: a real fetch, which fails: the worktree goes off and says why.
    expect(t.prepares.at(-1)).toEqual({ floor: 'floor', text: 'Tidy the lobby' });
    expect(t.dlg.summary()?.git).toMatchObject({ usable: false, hint: null, note: expect.stringContaining('git fetch origin failed: origin is offline') });
    expect(t.dlg.summary()?.form.worktree).toBe(false);
    expect(base()).toMatch(/^Off: origin could not be fetched\. Last fetched origin\/main @/);
    // An edit's preview does not paper over that failure.
    type('Tidy the lobby, then the roof');
    await settle();
    expect(t.prepares.at(-1)).toEqual({ floor: 'floor', text: 'Tidy the lobby, then the roof', preview: true });
    expect(t.dlg.summary()?.git).toMatchObject({ usable: false, note: expect.stringContaining('origin is offline') });
    expect(refetch()).not.toBeNull();
    // Fetch again: no preview; origin is back.
    t.state.origin = 'up';
    refetch()!.click();
    await flush();
    expect(t.prepares.at(-1)).toEqual({ floor: 'floor', text: 'Tidy the lobby, then the roof' });
    expect(t.dlg.summary()?.git).toMatchObject({ usable: true, note: null, hint: null });
    expect(refetch()).toBeNull();
    t.dlg.close();
  });

  it.each([
    { name: 'answered, then an edit', before: true, order: [0], origin: 'down' as const, fetches: false },
    { name: 'on its way, an edit, then the fetch fails', before: false, order: [0, 1], origin: 'down' as const, fetches: true },
    { name: 'on its way, an edit answered first, then the fetch fails', before: false, order: [1, 0], origin: 'down' as const, fetches: true },
    { name: 'on its way, an edit, then the fetch finds origin', before: false, order: [0, 1], origin: 'up' as const, fetches: true },
  ])('#134 R1: the recheck after a fetch refusal $name: the edit never hides what origin is', async (c) => {
    const t = setup();
    t.state.origin = 'down';
    t.state.starts.push({ ok: false, code: 'fetch_failed', message: 'git fetch origin failed: origin is offline' });
    t.dlg.open({ floor: 'floor', desk: 0 });
    await flush();
    type('Tidy the lobby');
    await settle();
    t.state.origin = c.origin;
    t.state.hold = true;
    document.querySelector<HTMLElement>('[data-key="start"]')!.click();
    await flush();
    await flush();
    expect(t.prepares.at(-1)).toEqual({ floor: 'floor', text: 'Tidy the lobby' });
    if (c.before) t.release();
    await flush();
    type('Tidy the roof');
    await vi.advanceTimersByTimeAsync(300);
    // An edit while the recheck is on its way fetches too (the recheck's answer is dropped); after it, a preview.
    expect(t.prepares.at(-1)).toEqual({ floor: 'floor', text: 'Tidy the roof', ...(c.fetches ? {} : { preview: true }) });
    t.state.hold = false;
    const held = t.held.splice(0);
    for (const i of c.order) held[i]!();
    await flush();
    const usable = c.origin === 'up';
    expect(t.dlg.summary()?.git).toMatchObject({ usable, note: usable ? null : expect.stringContaining('origin is offline') });
    expect(t.dlg.summary()?.form.worktree).toBe(usable);
    expect(!!refetch()).toBe(!usable);
    if (!usable) {
      t.state.origin = 'up';
      refetch()!.click();
      await flush();
      expect(t.prepares.at(-1)).toEqual({ floor: 'floor', text: 'Tidy the roof' });
      expect(t.dlg.summary()?.git).toMatchObject({ usable: true, note: null });
      expect(refetch()).toBeNull();
    }
    t.dlg.close();
  });

  it('a field typed while Fetch again is on its way: the prepare that replaces it fetches too', async () => {
    const t = setup();
    t.state.origin = 'down';
    t.state.starts.push({ ok: false, code: 'fetch_failed', message: 'git fetch origin failed: origin is offline' });
    t.dlg.open({ floor: 'floor', desk: 0 });
    await flush();
    type('Tidy the lobby');
    await settle();
    document.querySelector<HTMLElement>('[data-key="start"]')!.click();
    await flush();
    await flush();
    expect(refetch()).not.toBeNull();
    t.state.origin = 'up';
    t.state.hold = true;
    refetch()!.click();
    type('Tidy the roof');
    await vi.advanceTimersByTimeAsync(300);
    t.state.hold = false;
    t.release();
    await flush();
    // Both without preview: the first answer is dropped (a newer prepare), the second is the fetch.
    expect(t.prepares.slice(-2)).toEqual([
      { floor: 'floor', text: 'Tidy the lobby' },
      { floor: 'floor', text: 'Tidy the roof' },
    ]);
    expect(t.dlg.summary()?.git).toMatchObject({ usable: true, note: null });
    // Fetched: later edits are previews again.
    type('Tidy the roof today');
    await settle();
    expect(t.prepares.at(-1)).toEqual({ floor: 'floor', text: 'Tidy the roof today', preview: true });
    t.dlg.close();
  });
});
