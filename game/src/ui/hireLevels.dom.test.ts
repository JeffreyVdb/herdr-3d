// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hire, HireGit, HireOptions, HirePrepare } from '../net/protocol';
import { HireDialog, type HireHost, type HirePrefill, type HireSummary } from './hire';
import { HireModelPrefs } from './hireModelPrefs';
import { TaskLevels } from './taskLevels';

// #248, #40: the Hire dialog in task-level mode. Fixture slugs and names only; nothing here is an app default.

const CAT: HireOptions = {
  codex: { models: ['x-1', 'x-2', 'x-3'], efforts: ['low', 'high'], extra_efforts: { 'x-2': ['ultra'] } },
  claude: { models: ['y-1', 'y-2'], efforts: ['low', 'medium', 'high'], model_labels: { 'y-1': 'Why One' } },
};
const GIT: HireGit = { repo_root: '/home/test', default_branch: 'main', base_sha: 'abcdef0123456789', base_time: 0, fetched: true };

const tick = () => new Promise((r) => setTimeout(r, 0));
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

const prepOf = (choice: Hire | null, git: HireGit | null): HirePrepare => ({
  cwd: '/home/test',
  label: 'default',
  git,
  choice,
  choice_source: 'floor_default',
  capacity: { floor: { count: 0, soft: 10, hard: 20 }, host: { count: 0, soft: 10, hard: 20 } },
});

function setup(o: { git?: HireGit | null; worktreeByDefault?: boolean } = {}) {
  const prefs = new HireModelPrefs(memory());
  let n = 0;
  const levels = new TaskLevels(memory(), () => `id-${++n}`);
  const store = {
    floorName: (id: string) => id, hireOptions: CAT, floorView: () => ({ seats: Array(10).fill(null) }), limits: { version: 0, list: () => [] }, workerView: () => null };
  const showTaskLevelSettings = vi.fn();
  const sent: Array<{ t: string; args: unknown }> = [];
  const send = vi.fn(async (t: string, args: unknown) => {
    sent.push({ t, args });
    return t === 'hire.prepare' ? { ok: true, data: prepOf({ harness: 'codex', model: 'x-3', effort: 'low' }, o.git === undefined ? GIT : o.git) } : await new Promise(() => {});
  });
  const host = {
    store,
    modelPrefs: prefs,
    taskLevels: levels,
    showTaskLevelSettings,
    hirePrefs: { worktreeByDefault: o.worktreeByDefault ?? true },
    send,
    unsupported: () => false,
    reserve: () => () => {},
    held: () => new Set<number>(),
    toast: () => {},
    now: () => Date.now(),
    upload: () => new Promise(() => {}),
  } as unknown as HireHost;
  const dlg = new HireDialog(document.body, host);
  const open = async (prefill: HirePrefill) => {
    dlg.open('floor', 0, prefill);
    await tick();
  };
  /** Adds a level and sets it (none: left not set); its id. */
  const level = (name: string, c?: { harness: string; model: string; effort: string }): string => {
    const id = levels.add(name)!;
    if (c) levels.set(id, c);
    return id;
  };
  return { dlg, prefs, levels, level, store, showTaskLevelSettings, sent, open, inner: dlg as unknown as { hire(): Promise<void> } };
}

const summary = (dlg: HireDialog): HireSummary => dlg.summary() as HireSummary;
const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const levelInput = (id: string) => q<HTMLInputElement>(`[data-key="level:${id}"]`);
const RESOLVE: HirePrefill = { prompt: 'resolve it', level: 'default', worktree: true };

describe('HireDialog: task levels (#248, #40)', () => {
  beforeEach(() => {
    localStorage.clear();
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
    vi.stubGlobal('CSS', { escape: (s: string) => s });
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('shows one chip per set level in the player’s order instead of the pickers, picks the default, and a chip sets all three', async () => {
    const s = setup();
    const tiny = s.level('Tiny', { harness: 'codex', model: 'x-1', effort: 'low' });
    // Not set yet: never a chip.
    s.level('Someday');
    const quick = s.level('Quick fix', { harness: 'claude', model: 'y-1', effort: 'medium' });
    s.levels.setDefault(quick);
    await s.open(RESOLVE);
    expect(q('[data-pick="harness"]')).toBeNull();
    expect(q('[data-pick="model"]')).toBeNull();
    expect(q('[data-pick="effort"]')).toBeNull();
    expect([...document.querySelectorAll('[data-pick="level"] label')].map((l) => l.textContent)).toEqual(['Tiny — x-1 · low', 'Quick fix — Why One · medium']);
    expect(summary(s.dlg).level).toMatchObject({ mode: 'levels', picked: quick });
    expect(summary(s.dlg).form).toMatchObject({ prompt: 'resolve it', harness: 'claude', model: 'y-1', effort: 'medium' });
    levelInput(tiny)!.click();
    expect(summary(s.dlg).form).toMatchObject({ harness: 'codex', model: 'x-1', effort: 'low' });
    expect(summary(s.dlg).level?.picked).toBe(tiny);
    expect(summary(s.dlg).blocker).toBeNull();
  });

  it('with no level marked default, the first one is; the chips follow a move', async () => {
    const s = setup();
    const a = s.level('A', { harness: 'codex', model: 'x-1', effort: 'low' });
    const b = s.level('B', { harness: 'claude', model: 'y-1', effort: 'medium' });
    await s.open(RESOLVE);
    expect(summary(s.dlg).level?.picked).toBe(a);
    s.levels.move(b, -1);
    expect(summary(s.dlg).level?.chips.map((c) => c.id)).toEqual([b, a]);
    s.dlg.close();
    await s.open(RESOLVE);
    expect(summary(s.dlg).level?.picked).toBe(b);
  });

  it('a default level that is not set yet: the nearest set one by position, the earlier first', async () => {
    const s = setup();
    const a = s.level('A', { harness: 'codex', model: 'x-1', effort: 'low' });
    const b = s.level('B');
    s.level('C', { harness: 'claude', model: 'y-1', effort: 'medium' });
    s.levels.setDefault(b);
    await s.open(RESOLVE);
    expect(summary(s.dlg).level?.picked).toBe(a);
  });

  it('asks for a level by id; an id no longer in the list asks for the default', async () => {
    const s = setup();
    const a = s.level('A', { harness: 'codex', model: 'x-1', effort: 'low' });
    const b = s.level('B', { harness: 'claude', model: 'y-1', effort: 'medium' });
    await s.open({ ...RESOLVE, level: b });
    expect(summary(s.dlg).level?.picked).toBe(b);
    s.dlg.close();
    await s.open({ ...RESOLVE, level: 'gone' });
    expect(summary(s.dlg).level?.picked).toBe(a);
  });

  it('“Choose a more complex model…” shows the usual pickers holding the level; “Back to task levels” returns; neither is saved', async () => {
    const s = setup();
    s.level('Quick fix', { harness: 'codex', model: 'x-2', effort: 'ultra' });
    await s.open(RESOLVE);
    q<HTMLButtonElement>('[data-key="levels-more"]')!.click();
    expect(summary(s.dlg).level?.mode).toBe('more');
    expect(q('[data-pick="level"]')).toBeNull();
    expect(q<HTMLInputElement>('[data-key="harness:codex"]')!.checked).toBe(true);
    expect(q<HTMLInputElement>('[data-key="model:x-2"]')!.checked).toBe(true);
    // Per-model efforts: x-2 takes its extra one.
    expect(q<HTMLInputElement>('[data-key="effort:ultra"]')!.checked).toBe(true);
    q<HTMLInputElement>('[data-key="model:x-3"]')!.click();
    expect(summary(s.dlg).form).toMatchObject({ model: 'x-3', effort: 'high' });
    q<HTMLButtonElement>('[data-key="levels-back"]')!.click();
    expect(summary(s.dlg).level?.mode).toBe('levels');
    expect(summary(s.dlg).form).toMatchObject({ harness: 'codex', model: 'x-2', effort: 'ultra' });
    q<HTMLButtonElement>('[data-key="levels-more"]')!.click();
    s.dlg.close();
    await s.open(RESOLVE);
    expect(summary(s.dlg).level?.mode).toBe('levels');
  });

  it('an unusable level is shown off with its reason, and the nearest usable one is picked (the earlier first)', async () => {
    const s = setup();
    const a = s.level('A', { harness: 'codex', model: 'x-1', effort: 'low' });
    const b = s.level('B', { harness: 'claude', model: 'y-1', effort: 'medium' });
    const c = s.level('C', { harness: 'claude', model: 'y-2', effort: 'high' });
    s.levels.setDefault(b);
    s.prefs.setShown('claude', 'y-1', false);
    await s.open(RESOLVE);
    expect(summary(s.dlg).level?.picked).toBe(a);
    expect(levelInput(b)!.disabled).toBe(true);
    expect(levelInput(b)!.closest('label')!.title).toMatch(/hidden in Settings → Harness models/);
    expect(summary(s.dlg).level?.chips.map((x) => x.id)).toEqual([a, b, c]);
  });

  it('follows a change of the levels while open: a picked level that goes stale falls back, a fixed one comes back', async () => {
    const s = setup();
    const a = s.level('A', { harness: 'claude', model: 'y-1', effort: 'medium' });
    const b = s.level('B', { harness: 'claude', model: 'y-2', effort: 'high' });
    await s.open(RESOLVE);
    s.levels.set(a, { harness: 'claude', model: 'y-1', effort: 'max' });
    expect(summary(s.dlg).level?.picked).toBe(b);
    expect(summary(s.dlg).form).toMatchObject({ model: 'y-2', effort: 'high' });
    expect(levelInput(a)!.disabled).toBe(true);
    // Renamed in Settings meanwhile: the chip says so.
    s.levels.rename(b, 'Bigger');
    expect(q('[data-pick="level"]')!.textContent).toContain('Bigger — y-2 · high');
    // Removed: the next one left.
    s.levels.set(a, { harness: 'claude', model: 'y-1', effort: 'low' });
    s.levels.remove(b);
    expect(summary(s.dlg).level?.picked).toBe(a);
  });

  it('no level set: the usual pickers with the floor’s choice, and no “Choose a more complex model…”', async () => {
    const s = setup();
    // A level that is named but not set does not count.
    s.level('Someday');
    await s.open(RESOLVE);
    expect(summary(s.dlg).level?.mode).toBe('none');
    expect(q('[data-pick="harness"]')).not.toBeNull();
    expect(q('[data-key="levels-more"]')).toBeNull();
    expect(q('[data-hook="levels-off"]')).toBeNull();
    expect(summary(s.dlg).form).toMatchObject({ harness: 'codex', model: 'x-3', effort: 'low' });
  });

  it('levels set but none usable: the usual pickers, a note and the way to Settings → Task levels', async () => {
    const s = setup();
    const a = s.level('A', { harness: 'claude', model: 'gone-1', effort: 'medium' });
    await s.open(RESOLVE);
    expect(summary(s.dlg).level?.mode).toBe('none');
    expect(q('[data-pick="harness"]')).not.toBeNull();
    expect(q('[data-hook="levels-off"]')!.textContent).toMatch(/None of your task levels can be used/);
    q<HTMLButtonElement>('[data-key="show-levels"]')!.click();
    expect(s.showTaskLevelSettings).toHaveBeenCalledTimes(1);
    // Fixed in Settings while the dialog is open: the levels come back.
    s.levels.set(a, { harness: 'claude', model: 'y-2', effort: 'medium' });
    expect(summary(s.dlg).level).toMatchObject({ mode: 'levels', picked: a });
  });

  it('never applies a reviewer’s choice in level mode', async () => {
    const s = setup();
    s.level('A', { harness: 'claude', model: 'y-1', effort: 'low' });
    await s.open({ ...RESOLVE, choice: { harness: 'codex', model: 'x-2', effort: 'ultra' } });
    expect(summary(s.dlg).form).toMatchObject({ harness: 'claude', model: 'y-1', effort: 'low' });
  });

  it('sends the level’s harness, model and effort as a plain worker.hire, with a worktree even when Settings says none', async () => {
    const s = setup({ worktreeByDefault: false });
    s.level('A', { harness: 'claude', model: 'y-1', effort: 'medium' });
    await s.open(RESOLVE);
    expect(summary(s.dlg).form.worktree).toBe(true);
    void s.inner.hire();
    await tick();
    await tick();
    const hire = s.sent.find((c) => c.t === 'worker.hire')?.args as Record<string, unknown>;
    expect(hire).toMatchObject({ harness: 'claude', model: 'y-1', effort: 'medium', worktree: true, prompt: 'resolve it' });
    expect(Object.keys(hire).some((k) => k.includes('level'))).toBe(false);
  });

  it('no worktree can be made: the hire goes out without one', async () => {
    const s = setup({ git: { ...GIT, fetched: false }, worktreeByDefault: true });
    s.level('A', { harness: 'claude', model: 'y-1', effort: 'medium' });
    await s.open(RESOLVE);
    expect(summary(s.dlg).form.worktree).toBe(false);
  });

  it('a plain hire knows nothing of levels, even with levels set', async () => {
    const s = setup({ worktreeByDefault: false });
    s.level('A', { harness: 'claude', model: 'y-1', effort: 'medium' });
    await s.open({});
    expect(summary(s.dlg).level).toBeUndefined();
    expect(q('[data-pick="level"]')).toBeNull();
    expect(q('[data-key="levels-more"]')).toBeNull();
    expect(summary(s.dlg).form).toMatchObject({ harness: 'codex', model: 'x-3', effort: 'low', worktree: false });
  });
});
