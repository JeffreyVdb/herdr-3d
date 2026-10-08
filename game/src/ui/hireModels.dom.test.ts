// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hire, HireOptions, HirePrepare } from '../net/protocol';
import type { Draft } from './composer/draft';
import { HireDialog, type HireHost, type HireSummary } from './hire';
import { HireModelPrefs } from './hireModelPrefs';

// #194: the Hire dialog offers the models Settings leaves shown. Fixture slugs only; nothing here is an app default.

const CAT: HireOptions = {
  codex: { models: ['x-1', 'x-2', 'x-3'], efforts: ['low', 'high'], extra_efforts: { 'x-2': ['ultra'] } },
  claude: { models: ['y-1', 'y-2'], efforts: ['low', 'high', 'max'] },
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

const prepOf = (choice: Hire | null, source: HirePrepare['choice_source'] = 'floor_default'): HirePrepare => ({
  cwd: '/home/test',
  label: 'default',
  git: null,
  choice,
  choice_source: source,
  capacity: { floor: { count: 0, soft: 10, hard: 20 }, host: { count: 0, soft: 10, hard: 20 } },
});

interface Setup {
  dlg: HireDialog;
  prefs: HireModelPrefs;
  store: { hireOptions: HireOptions };
  showModelSettings: ReturnType<typeof vi.fn>;
  inner: { hire(): Promise<void> };
  send: ReturnType<typeof vi.fn>;
}

function setup(
  choice: Hire | null = { harness: 'codex', model: 'x-2', effort: 'ultra' },
  source: HirePrepare['choice_source'] = 'floor_default',
  upload: () => Promise<unknown> = () => new Promise(() => {}),
): Setup {
  const prefs = new HireModelPrefs(memory());
  const store = { hireOptions: CAT, floorView: () => ({ seats: Array(10).fill(null) }), limits: { version: 0, list: () => [] }, workerView: () => null };
  const showModelSettings = vi.fn();
  const send = vi.fn(async (t: string) => (t === 'hire.prepare' ? { ok: true, data: prepOf(choice, source) } : await new Promise(() => {})));
  const host = {
    store,
    modelPrefs: prefs,
    showModelSettings,
    send,
    unsupported: () => false,
    reserve: () => () => {},
    held: () => new Set<number>(),
    toast: () => {},
    now: () => Date.now(),
    upload,
  } as unknown as HireHost;
  const dlg = new HireDialog(document.body, host);
  return { dlg, prefs, store, showModelSettings, inner: dlg as unknown as { hire(): Promise<void> }, send };
}

const summary = (dlg: HireDialog): HireSummary => dlg.summary() as HireSummary;
const modelKeys = () => [...document.querySelectorAll<HTMLInputElement>('[data-pick="model"] input')].map((i) => i.value);
const chipOf = (name: string, value: string) => document.querySelector<HTMLInputElement>(`[data-key="${name}:${value}"]`);

describe('HireDialog: the models Settings leaves shown (#194)', () => {
  beforeEach(() => {
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

  it('with nothing hidden, every catalog model is a chip, and the preselected choice is the floor default', async () => {
    const { dlg } = setup();
    dlg.open('floor', 0);
    await tick();
    expect(modelKeys()).toEqual(['x-1', 'x-2', 'x-3']);
    expect(summary(dlg).form).toMatchObject({ harness: 'codex', model: 'x-2', effort: 'ultra' });
    expect(summary(dlg).choiceNote).toBe('Floor default');
  });

  it('a hidden floor default opens on the first shown model, effort normalized against it, and is not labelled the floor default', async () => {
    const { dlg, prefs } = setup();
    prefs.setShown('codex', 'x-2', false);
    dlg.open('floor', 0);
    await tick();
    expect(modelKeys()).toEqual(['x-1', 'x-3']);
    expect(summary(dlg).form).toMatchObject({ model: 'x-1', effort: 'high' });
    expect(summary(dlg).choiceNote).toBeNull();
  });

  it('hiding the model on screen moves the open form to the first shown one, and the chips follow', async () => {
    const { dlg, prefs } = setup();
    dlg.open('floor', 0);
    await tick();
    prefs.setShown('codex', 'x-2', false);
    expect(modelKeys()).toEqual(['x-1', 'x-3']);
    expect(summary(dlg).form).toMatchObject({ model: 'x-1', effort: 'high' });
    expect(summary(dlg).choiceNote).toBeNull();
    expect(summary(dlg).blocker).toBeNull();
  });

  it('a hidden model in the form cannot be hired: the form never holds it, and effort falls back when the new model lacks it', async () => {
    const { dlg, prefs } = setup();
    dlg.open('floor', 0);
    await tick();
    prefs.setShown('codex', 'x-2', false);
    prefs.setShown('codex', 'x-1', false);
    expect(summary(dlg).form).toMatchObject({ model: 'x-3', effort: 'high' });
    expect(summary(dlg).blocker).toBeNull();
  });

  it('keeps harnesses apart: hiding a Claude model leaves the Codex chips alone', async () => {
    const { dlg, prefs } = setup();
    dlg.open('floor', 0);
    await tick();
    prefs.setShown('claude', 'y-1', false);
    expect(modelKeys()).toEqual(['x-1', 'x-2', 'x-3']);
    expect(chipOf('harness', 'claude')).not.toBeNull();
  });

  it('a prefill for a hidden model takes the first shown one of that harness', async () => {
    const { dlg, prefs } = setup();
    prefs.setShown('codex', 'x-1', false);
    dlg.open('floor', 0, { choice: { harness: 'codex', model: 'x-1', effort: 'ultra' } });
    await tick();
    expect(summary(dlg).form).toMatchObject({ model: 'x-2', effort: 'ultra' });
  });

  it('a harness with every model hidden: empty state, Hire blocked, a way to Settings, and switching harness still works', async () => {
    const { dlg, prefs, showModelSettings } = setup();
    for (const m of CAT.codex!.models) prefs.setShown('codex', m, false);
    dlg.open('floor', 0);
    await tick();
    expect(document.querySelector('[data-hook="no-models"]')?.textContent).toContain('All 3 Codex models are hidden');
    expect(modelKeys()).toEqual([]);
    expect(summary(dlg).blocker).toMatch(/hidden/);
    document.querySelector<HTMLButtonElement>('[data-key="show-models"]')!.click();
    expect(showModelSettings).toHaveBeenCalledTimes(1);
    chipOf('harness', 'claude')!.click();
    expect(summary(dlg).form).toMatchObject({ harness: 'claude', model: 'y-1', effort: 'high' });
    expect(summary(dlg).blocker).toBeNull();
    expect(document.querySelector('[data-hook="no-models"]')).toBeNull();
  });

  it('Show all recovers an all-hidden harness; a model is never restored silently', async () => {
    const { dlg, prefs } = setup();
    for (const m of CAT.codex!.models) prefs.setShown('codex', m, false);
    dlg.open('floor', 0);
    await tick();
    expect(summary(dlg).blocker).not.toBeNull();
    prefs.showAll('codex');
    expect(modelKeys()).toEqual(['x-1', 'x-2', 'x-3']);
    expect(summary(dlg).form).toMatchObject({ model: 'x-1', effort: 'high' });
    expect(summary(dlg).blocker).toBeNull();
  });

  it('a settings change while the form is open takes effect in it; a hire already sent keeps what it sent', async () => {
    const { dlg, prefs, inner } = setup();
    dlg.open('floor', 0);
    await tick();
    const pending = inner.hire();
    await tick();
    expect(summary(dlg).state).toBe('hiring');
    prefs.setShown('codex', 'x-2', false);
    expect(summary(dlg).form).toMatchObject({ model: 'x-2', effort: 'ultra' });
    void pending;
  });

  it('a model the bridge discovers later shows; a hidden one that disappears and returns stays hidden', async () => {
    const { dlg, prefs, store } = setup();
    prefs.setShown('codex', 'x-9', false);
    store.hireOptions = { ...CAT, codex: { ...CAT.codex!, models: [...CAT.codex!.models, 'x-4', 'x-9'] } };
    dlg.open('floor', 0);
    await tick();
    expect(modelKeys()).toEqual(['x-1', 'x-2', 'x-3', 'x-4']);
    store.hireOptions = CAT;
    dlg.close();
    dlg.open('floor', 0);
    await tick();
    store.hireOptions = { ...CAT, codex: { ...CAT.codex!, models: [...CAT.codex!.models, 'x-9'] } };
    dlg.close();
    dlg.open('floor', 0);
    await tick();
    expect(modelKeys()).toEqual(['x-1', 'x-2', 'x-3']);
    expect(prefs.hidden('codex').has('x-9')).toBe(true);
  });

  it('the catalog is kept whole: nothing hidden changes what the bridge sent', async () => {
    const { dlg, prefs, store } = setup();
    prefs.setShown('codex', 'x-1', false);
    dlg.open('floor', 0);
    await tick();
    expect(store.hireOptions.codex?.models).toEqual(['x-1', 'x-2', 'x-3']);
  });

  it('a hire the bridge refuses returns to the editable form, resolved against Settings: the sent choice stays while pending', async () => {
    const { dlg, prefs, inner, send } = setup();
    dlg.open('floor', 0);
    await tick();
    let answer!: (r: unknown) => void;
    send.mockImplementation(async (t: string) => (t === 'hire.prepare' ? { ok: true, data: prepOf({ harness: 'codex', model: 'x-2', effort: 'ultra' }) } : new Promise((r) => (answer = r))));
    const pending = inner.hire();
    await tick();
    expect(summary(dlg).state).toBe('hiring');
    expect(send.mock.calls.find(([t]) => t === 'worker.hire')?.[1]).toMatchObject({ harness: 'codex', model: 'x-2', effort: 'ultra' });
    prefs.setShown('codex', 'x-2', false);
    expect(summary(dlg).form).toMatchObject({ model: 'x-2', effort: 'ultra' });
    answer({ ok: false, code: 'busy', message: 'Failed' });
    await pending;
    expect(summary(dlg).state).toBe('ready');
    expect(summary(dlg).error).toBe(true);
    expect(summary(dlg).form).toMatchObject({ harness: 'codex', model: 'x-1', effort: 'high' });
    expect(modelKeys()).toEqual(['x-1', 'x-3']);
    expect(summary(dlg).blocker).toBeNull();
  });

  it('an image upload that fails before the hire returns to the editable form resolved the same way', async () => {
    let fail!: (e: Error) => void;
    const { dlg, prefs, inner } = setup(undefined, undefined, () => new Promise((_, reject) => (fail = reject)));
    dlg.open('floor', 0);
    await tick();
    const draft = (dlg as unknown as { editor: { draft: Draft } }).editor.draft;
    draft.addImages([new File(['x'], 'shot.png', { type: 'image/png' })]);
    await tick();
    const pending = inner.hire();
    await tick();
    expect(summary(dlg).state).toBe('hiring');
    prefs.setShown('codex', 'x-2', false);
    expect(summary(dlg).form).toMatchObject({ model: 'x-2', effort: 'ultra' });
    fail(new Error('down'));
    await pending;
    expect(summary(dlg).state).toBe('ready');
    expect(summary(dlg).form).toMatchObject({ harness: 'codex', model: 'x-1', effort: 'high' });
    expect(summary(dlg).blocker).toBeNull();
  });
});
