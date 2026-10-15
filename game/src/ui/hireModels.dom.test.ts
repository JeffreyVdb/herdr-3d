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
  const store = {
    floorName: (id: string) => id, hireOptions: CAT, floorView: () => ({ seats: Array(10).fill(null) }), limits: { version: 0, list: () => [] }, workerView: () => null };
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

// #200: readable model names. The names are presentation; the radio value, the selection and the hire stay the exact id.

const NAMED: HireOptions = {
  claude: {
    models: ['claude-opus-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-future'],
    efforts: ['low', 'high'],
    model_labels: { 'claude-opus-5': 'Opus 5', 'claude-opus-5-5': 'Opus 5.5', 'claude-future': '<img src=x onerror=alert(1)>' },
  },
  codex: { models: ['gpt-6.1-sol', 'gpt-6-sol'], efforts: ['high'], model_labels: { 'gpt-6.1-sol': 'GPT-6.1-Sol', 'gpt-6-sol': 'GPT-6-Sol' } },
};
// More models than a row of chips holds: the searchable grid.
const MANY_IDS = Array.from({ length: 12 }, (_, i) => `claude-lab-${String(i + 1).padStart(2, '0')}`);
const MANY: HireOptions = {
  claude: {
    models: ['claude-opus-5', 'claude-opus-5-5', ...MANY_IDS, 'twin-a', 'twin-b'],
    efforts: ['low', 'high'],
    model_labels: { 'claude-opus-5': 'Opus 5', 'claude-opus-5-5': 'Opus 5.5', 'twin-a': 'Twin', 'twin-b': 'Twin' },
  },
};

describe('HireDialog: readable model names (#200)', () => {
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

  const chipTexts = () => [...document.querySelectorAll<HTMLElement>('[data-pick="model"] .dd-chip')].filter((l) => !l.hidden).map((l) => l.querySelector('span')!.firstChild!.textContent);
  const open = async (catalog: HireOptions, choice: Hire | null) => {
    const t = setup(choice);
    t.store.hireOptions = catalog;
    t.dlg.open('floor', 0);
    await tick();
    return t;
  };

  it('chip row: a label names the chip, a Codex token reads as words, the exact id is the tooltip and the value', async () => {
    await open(NAMED, { harness: 'claude', model: 'claude-opus-5', effort: 'high' });
    expect(document.querySelector('[data-pick="model"]')!.classList.contains('dd-pick--models')).toBe(false);
    expect(chipTexts()).toEqual(['Opus 5', 'Opus 5.5', 'Fable 5.1', '<img src=x onerror=alert(1)>']);
    expect(modelKeys()).toEqual(['claude-opus-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-future']);
    expect(chipOf('model', 'claude-opus-5')!.closest('label')!.title).toBe('claude-opus-5');
    chipOf('harness', 'codex')!.click();
    expect(chipTexts()).toEqual(['GPT 6.1 Sol', 'GPT 6 Sol']);
    expect(modelKeys()).toEqual(['gpt-6.1-sol', 'gpt-6-sol']);
  });

  it('labels are plain text, never markup', async () => {
    await open(NAMED, { harness: 'claude', model: 'claude-future', effort: 'high' });
    expect(document.querySelector('[data-pick="model"] img')).toBeNull();
    expect(chipOf('model', 'claude-future')!.closest('label')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('without labels (an older bridge, the fallback catalog) a recognised Claude or GPT slug is formatted and anything else is the exact id', async () => {
    const bare: HireOptions = {
      claude: { models: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-4-20250514'], efforts: ['high'] },
      codex: { models: ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-sol-2026-08-01'], efforts: ['high'] },
    };
    await open(bare, { harness: 'claude', model: 'claude-opus-5-5', effort: 'high' });
    expect(chipTexts()).toEqual(['Opus 5.5', 'Fable 5.1', 'claude-sonnet-4-20250514']);
    expect(chipOf('model', 'claude-sonnet-4-20250514')!.closest('label')!.title).toBe('');
    chipOf('harness', 'codex')!.click();
    // #229: a GPT slug is named by rule, as its tidied label would be; its exact id stays the value and the tooltip.
    expect(chipTexts()).toEqual(['GPT 6 Sol', 'GPT 6.1 Sol', 'gpt-6-sol-2026-08-01']);
    expect(chipOf('model', 'gpt-6-sol')!.closest('label')!.title).toBe('gpt-6-sol');
    expect(chipOf('model', 'gpt-6-sol-2026-08-01')!.closest('label')!.title).toBe('');
  });

  it('picking a named chip selects, and hires with, the exact id', async () => {
    const { dlg, inner, send } = await open(NAMED, { harness: 'claude', model: 'claude-opus-5', effort: 'high' });
    chipOf('model', 'claude-opus-5-5')!.click();
    expect(summary(dlg).form).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5', effort: 'high' });
    void inner.hire();
    await tick();
    expect(send.mock.calls.find(([t]) => t === 'worker.hire')?.[1]).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  });

  it('searchable grid: names, a filter by name (with spaces) or by exact id, the checked model stays, the value is the id', async () => {
    const { dlg } = await open(MANY, { harness: 'claude', model: 'claude-opus-5', effort: 'high' });
    const grid = document.querySelector('.dd-chips--grid');
    expect(grid).not.toBeNull();
    expect(chipTexts().slice(0, 3)).toEqual(['Opus 5', 'Opus 5.5', 'claude-lab-01']);
    const search = document.querySelector<HTMLInputElement>('[data-key="model-search"]')!;
    const type = (v: string) => {
      search.value = v;
      search.dispatchEvent(new Event('input', { bubbles: true }));
    };
    type('opus 5.5');
    expect(chipTexts()).toEqual(['Opus 5', 'Opus 5.5']); // the checked Opus 5 stays visible
    type('OPUS 5');
    expect(chipTexts()).toEqual(['Opus 5', 'Opus 5.5']);
    type('claude-opus-5-5');
    expect(chipTexts()).toEqual(['Opus 5', 'Opus 5.5']);
    type('lab-1');
    expect(chipTexts()).toEqual(['Opus 5', 'claude-lab-10', 'claude-lab-11', 'claude-lab-12']);
    type('nothing like it');
    expect(document.querySelector('.dd-none')!.textContent).toContain('No model matches');
    type('');
    chipOf('model', 'claude-opus-5-5')!.click();
    expect(summary(dlg).form.model).toBe('claude-opus-5-5');
  });

  it('colliding names show the id beside them, in both layouts', async () => {
    await open(MANY, { harness: 'claude', model: 'twin-a', effort: 'high' });
    const twin = (id: string) => chipOf('model', id)!.closest('label')!;
    expect(twin('twin-a').textContent).toBe('Twintwin-a');
    expect(twin('twin-a').querySelector('.dd-chip-id')!.textContent).toBe('twin-a');
    expect(twin('twin-b').querySelector('.dd-chip-id')!.textContent).toBe('twin-b');
    expect(chipOf('model', 'claude-opus-5')!.closest('label')!.querySelector('.dd-chip-id')).toBeNull();
    document.body.replaceChildren();
    const small: HireOptions = { claude: { models: ['twin-a', 'twin-b', 'solo'], efforts: ['high'], model_labels: { 'twin-a': 'Twin', 'twin-b': 'Twin' } } };
    await open(small, { harness: 'claude', model: 'twin-a', effort: 'high' });
    expect([...document.querySelectorAll('.dd-chip-id')].map((e) => e.textContent)).toEqual(['twin-a', 'twin-b']);
  });
});
