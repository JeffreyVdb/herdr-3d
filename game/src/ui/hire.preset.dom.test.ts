// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HireOptions, HirePrepare } from '../net/protocol';
import type { Draft } from './composer/draft';
import { HireDialog, type HireHost, type HirePrefill, type HireSummary } from './hire';
import { HireModelPrefs } from './hireModelPrefs';
import { HirePresetBook } from '../world/hirePresets';

// #93: a form opened from a hire preset holds the preset's exact choice: a hidden model stays offered and picked, a
// removed model or an effort the model lacks is shown and blocks Hire until the player picks; nothing is resolved to
// another choice. Edits are this hire's only. Fixture slugs only.

const CAT: HireOptions = {
  codex: { models: ['x-1', 'x-2', 'x-3'], efforts: ['low', 'high'], extra_efforts: { 'x-2': ['ultra'] } },
  claude: { models: ['y-1', 'y-2'], efforts: ['low', 'high', 'max'] },
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

const prep: HirePrepare = {
  cwd: '/home/test',
  label: 'default',
  git: null,
  choice: { harness: 'claude', model: 'y-1', effort: 'low' },
  choice_source: 'floor_default',
  capacity: { floor: { count: 0, soft: 10, hard: 20 }, host: { count: 0, soft: 10, hard: 20 } },
};

const PROMPT = 'Deploy the release to A, B and C.';
const fromPreset = (choice: { harness: string; model: string; effort: string }, over: Partial<HirePrefill> = {}): HirePrefill => ({
  prompt: PROMPT,
  choice,
  preset: { id: 'hp_1', name: 'Deploy', scope: 'floor' },
  ...over,
});

/** #95: `lines` are hire.prepare's herdr hiring instructions (null: a bridge before #95, which has no marker either). */
function setup(o: { lines?: string | null } = {}) {
  const lines = o.lines === undefined ? null : o.lines;
  const prefs = new HireModelPrefs(memory());
  const hires: unknown[] = [];
  const send = vi.fn(async (t: string, args: unknown) => {
    if (t === 'hire.prepare') return { ok: true, data: lines === null ? prep : { ...prep, herdr_instructions: lines } };
    if (t === 'worker.hire') {
      hires.push(args);
      return { ok: true, data: { id: `w${hires.length}`, prompted: true } };
    }
    return { ok: false, code: 'unknown_command', message: '' };
  });
  const store = { floorName: (id: string) => id, hireOptions: CAT, floorView: () => ({ seats: Array(10).fill(null) }), limits: { version: 0, list: () => [] }, workerView: () => null, hirePresets: { known: true, instructions: lines !== null } };
  const host = {
    store,
    modelPrefs: prefs,
    send,
    unsupported: () => false,
    reserve: () => () => {},
    held: () => new Set<number>(),
    toast: () => {},
    now: () => Date.now(),
    upload: () => new Promise(() => {}),
    savePreset: vi.fn(),
  } as unknown as HireHost;
  const dlg = new HireDialog(document.body, host);
  return { dlg, prefs, hires, host, inner: dlg as unknown as { hire(): Promise<void>; editor: { draft: Draft } } };
}

const summary = (dlg: HireDialog): HireSummary => dlg.summary() as HireSummary;
const chip = (name: string, value: string) => document.querySelector<HTMLInputElement>(`[data-key="${name}:${value}"]`);
const pick = (name: string, value: string) => {
  const c = chip(name, value) as HTMLInputElement;
  c.checked = true;
  c.dispatchEvent(new Event('change'));
};

describe('HireDialog from a hire preset (#93)', () => {
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

  it('opens with the saved prompt and exact choice over the floor default, marked as the preset’s', async () => {
    const { dlg } = setup();
    dlg.open('floor', 0, fromPreset({ harness: 'codex', model: 'x-2', effort: 'ultra' }));
    await tick();
    const s = summary(dlg);
    expect(s.form).toMatchObject({ prompt: PROMPT, harness: 'codex', model: 'x-2', effort: 'ultra' });
    expect(s.choiceNote).toBe('From preset');
    expect(s.preset).toEqual({ id: 'hp_1', name: 'Deploy', saved: { harness: 'codex', model: 'x-2', effort: 'ultra' }, problem: null });
    expect(s.blocker).toBeNull();
    expect(document.querySelector('[data-hook="preset"]')?.textContent).toContain('Deploy');
  });

  it('keeps a model Settings hides: offered, picked and hireable, where a plain prefill would take another', async () => {
    const { dlg, prefs } = setup();
    prefs.setShown('codex', 'x-2', false);
    dlg.open('floor', 0, fromPreset({ harness: 'codex', model: 'x-2', effort: 'ultra' }));
    await tick();
    expect(chip('model', 'x-2')?.checked).toBe(true);
    expect(summary(dlg).form).toMatchObject({ model: 'x-2', effort: 'ultra' });
    expect(summary(dlg).blocker).toBeNull();
    // Hiding another model while the form is open changes nothing either.
    prefs.setShown('codex', 'x-1', false);
    expect(summary(dlg).form).toMatchObject({ model: 'x-2', effort: 'ultra' });
  });

  it('a removed model is kept and shown with why; Hire waits; an effort picked leaves it; a model picked repairs it', async () => {
    const { dlg, inner, hires } = setup();
    dlg.open('floor', 0, fromPreset({ harness: 'codex', model: 'x-gone', effort: 'high' }));
    await tick();
    let s = summary(dlg);
    expect(s.form).toMatchObject({ harness: 'codex', model: 'x-gone', effort: 'high' });
    expect(s.preset?.problem?.field).toBe('model');
    expect(s.blocker).toMatch(/no longer offers .*Choose a model/);
    const callout = document.querySelector('[data-hook="preset"]') as HTMLElement;
    expect(callout.getAttribute('role')).toBe('alert');
    expect(callout.textContent).toContain('x-gone');
    // No chip is checked for a model the catalog lacks.
    expect(document.querySelector('[data-pick="model"] input:checked')).toBeNull();
    await inner.hire();
    expect(hires).toEqual([]);
    pick('effort', 'low');
    expect(summary(dlg).form).toMatchObject({ model: 'x-gone', effort: 'low' });
    expect(summary(dlg).blocker).not.toBeNull();
    pick('model', 'x-3');
    s = summary(dlg);
    expect(s.form).toMatchObject({ model: 'x-3', effort: 'low' });
    expect(s.preset?.problem).toBeNull();
    expect(s.blocker).toBeNull();
  });

  it('an effort the model does not take is kept and blocks Hire; a removed harness shows no model list', async () => {
    const { dlg } = setup();
    dlg.open('floor', 0, fromPreset({ harness: 'codex', model: 'x-1', effort: 'ultra' }));
    await tick();
    expect(summary(dlg).form.effort).toBe('ultra');
    expect(summary(dlg).preset?.problem?.field).toBe('effort');
    expect(summary(dlg).blocker).toMatch(/Choose an effort/);
    dlg.open('floor', 1, fromPreset({ harness: 'gemini', model: 'g-1', effort: 'low' }));
    await tick();
    expect(summary(dlg).form).toMatchObject({ harness: 'gemini', model: 'g-1' });
    expect(summary(dlg).preset?.problem?.field).toBe('harness');
    expect(document.querySelector('[data-hook="no-models"]')).toBeNull();
    expect(document.querySelector('[data-pick="harness"] input:checked')).toBeNull();
  });

  it('hires exactly what the form shows, once; a per-launch edit is this hire’s only and the preset again restores the saved values', async () => {
    const { dlg, inner, hires } = setup();
    const saved = { harness: 'codex', model: 'x-2', effort: 'ultra' };
    dlg.open('floor', 0, fromPreset(saved));
    await tick();
    pick('effort', 'low');
    inner.editor.draft.replace(PROMPT.length, PROMPT.length, ' Then tag it.');
    await inner.hire();
    expect(hires).toEqual([expect.objectContaining({ floor: 'floor', desk_index: 0, harness: 'codex', model: 'x-2', effort: 'low', prompt: `${PROMPT} Then tag it.` })]);
    dlg.open('floor', 1, fromPreset(saved));
    await tick();
    expect(summary(dlg).form).toMatchObject({ prompt: PROMPT, ...saved });
    await inner.hire();
    expect(hires).toHaveLength(2);
    expect(hires[1]).toMatchObject({ desk_index: 1, ...saved, prompt: PROMPT });
  });

  it('leaves the desk’s unsent task alone unless asked to replace it', async () => {
    const { dlg, inner } = setup();
    dlg.open('floor', 2);
    await tick();
    inner.editor.draft.replace(0, 0, 'my own half-written task');
    dlg.close();
    expect(dlg.unsent('floor', 2)).toMatchObject({ text: 'my own half-written task', images: 0 });
    expect(dlg.unsent('floor', 3)).toBeNull();
    // Opened from the preset without replacing: the preset's text shows, the desk's draft stays the desk's.
    dlg.open('floor', 2, fromPreset({ harness: 'codex', model: 'x-1', effort: 'low' }));
    await tick();
    expect(summary(dlg).form.prompt).toBe(PROMPT);
    dlg.close();
    expect(dlg.unsent('floor', 2)?.text).toBe('my own half-written task');
    // Replacing it (the player chose so): the preset's text is the desk's draft now.
    dlg.open('floor', 2, fromPreset({ harness: 'codex', model: 'x-1', effort: 'low' }, { replaceDraft: true }));
    await tick();
    dlg.close();
    expect(dlg.unsent('floor', 2)?.text).toBe(PROMPT);
  });

  it('an edit or a deletion of the preset elsewhere never rewrites the open form', async () => {
    const { dlg, host } = setup();
    const book = new HirePresetBook();
    book.reset([{ id: 'hp_1', name: 'Deploy', floor: 'floor', prompt: PROMPT, harness: 'codex', model: 'x-2', effort: 'ultra', created_at: 1, updated_at: 1 }]);
    (host.store as unknown as { hirePresets: HirePresetBook }).hirePresets = book;
    dlg.open('floor', 0, fromPreset({ harness: 'codex', model: 'x-2', effort: 'ultra' }));
    await tick();
    const before = summary(dlg);
    book.upsert({ id: 'hp_1', name: 'Deploy v2', floor: 'floor', prompt: 'Something else.', harness: 'claude', model: 'y-1', effort: 'low', created_at: 1, updated_at: 2 });
    dlg.refresh();
    expect(summary(dlg).form).toEqual(before.form);
    expect(summary(dlg).preset).toEqual(before.preset);
    book.remove('hp_1');
    dlg.refresh();
    expect(summary(dlg).form).toEqual(before.form);
    expect(summary(dlg).blocker).toBeNull();
  });

  it('“Save as preset…” hands the editor the form’s text, choice and floor, images left out and counted', async () => {
    const { dlg, inner, host } = setup();
    dlg.open('floor', 0);
    await tick();
    inner.editor.draft.replace(0, 0, 'Audit the deps. ');
    inner.editor.draft.addImages([new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })]);
    (document.querySelector('[data-key="save-preset"]') as HTMLButtonElement).click();
    expect(host.savePreset).toHaveBeenCalledWith({ floor: 'floor', prompt: 'Audit the deps.', harness: 'claude', model: 'y-1', effort: 'low', imagesLeftOut: 1, instructions: false }, expect.any(HTMLElement));
  });
});

// #95: a form from a preset has its own "Add herdr hiring instructions", ticked to match the preset: the exact lines for
// this floor (hire.prepare's) under "What's added", the byte count with them, and only the flag goes to the bridge.
const LINES = 'Start every agent you hire in its own herdr workspace or tab.\n\nAlso tag every herdr workspace you create with the token h3d_floor=v-0123456789ab.';
const enc = new TextEncoder();

describe('HireDialog from a hire preset: herdr hiring instructions (#95)', () => {
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
  const ticked = (over: Partial<HirePrefill> = {}) => fromPreset({ harness: 'claude', model: 'y-1', effort: 'low' }, { preset: { id: 'hp_1', name: 'Deploy', scope: 'global', instructions: true }, ...over });
  const box = () => document.querySelector<HTMLInputElement>('#hire-instructions');

  it('ticks the box to match the preset and shows the exact lines with this floor’s id, counted in the prompt’s bytes', async () => {
    const { dlg } = setup({ lines: LINES });
    dlg.open('v-0123456789ab', 0, ticked());
    await tick();
    expect(box()?.checked).toBe(true);
    const bytes = enc.encode(PROMPT).length + 2 + enc.encode(LINES).length;
    expect(summary(dlg).instructions).toEqual({ on: true, lines: LINES, bytes });
    const details = document.querySelector('[data-hook="instructions-lines"]') as HTMLDetailsElement;
    expect(details.querySelector('summary')?.textContent).toBe('What’s added');
    expect(details.querySelector('pre')?.textContent).toBe(LINES);
    expect(document.querySelector('[data-hook="instructions-bytes"]')?.textContent).toContain(bytes.toLocaleString('en-US'));
  });

  it('sends the flag with the typed prompt, never the lines; unticked for one hire it sends neither', async () => {
    const { dlg, inner, hires } = setup({ lines: LINES });
    dlg.open('v-0123456789ab', 0, ticked());
    await tick();
    await inner.hire();
    expect(hires[0]).toMatchObject({ prompt: PROMPT, herdr_instructions: true });
    dlg.open('v-0123456789ab', 1, ticked());
    await tick();
    const b = box() as HTMLInputElement;
    b.checked = false;
    b.dispatchEvent(new Event('change'));
    expect(summary(dlg).instructions?.on).toBe(false);
    expect(document.querySelector('[data-hook="instructions-lines"]')).toBeNull();
    expect(document.querySelector('[data-hook="instructions"]')?.textContent).toContain('Off for this hire only');
    await inner.hire();
    expect(hires[1]).toMatchObject({ prompt: PROMPT });
    expect(hires[1]).not.toHaveProperty('herdr_instructions');
  });

  it('a preset with the box off opens it unticked; ticking it is this hire’s only', async () => {
    const { dlg, inner, hires } = setup({ lines: LINES });
    dlg.open('floor', 0, fromPreset({ harness: 'claude', model: 'y-1', effort: 'low' }));
    await tick();
    expect(box()?.checked).toBe(false);
    await inner.hire();
    expect(hires[0]).not.toHaveProperty('herdr_instructions');
  });

  it('blocks Hire with a reason when the prompt is over the limit only with the lines, and with no task to add them to', async () => {
    const { dlg, inner } = setup({ lines: LINES });
    const room = 32 * 1024 - 2 - enc.encode(LINES).length;
    dlg.open('floor', 0, ticked({ prompt: 'x'.repeat(room + 1) }));
    await tick();
    expect(summary(dlg).blocker).toContain('over 32 KiB');
    expect(document.querySelector('[data-key="hire"]')?.getAttribute('aria-disabled')).toBe('true');
    const b = box() as HTMLInputElement;
    b.checked = false;
    b.dispatchEvent(new Event('change'));
    expect(summary(dlg).blocker).toBeNull();
    dlg.open('floor', 1, ticked({ prompt: 'x'.repeat(room) }));
    await tick();
    expect(summary(dlg).blocker).toBeNull();
    inner.editor.draft.replace(0, inner.editor.draft.snapshot().text.length, '');
    expect(summary(dlg).blocker).toContain('first task');
  });

  it('“Save as preset…” seeds the box from the form, never the lines', async () => {
    const { dlg, host } = setup({ lines: LINES });
    dlg.open('floor', 0, ticked());
    await tick();
    (document.querySelector('[data-key="save-preset"]') as HTMLButtonElement).click();
    expect(host.savePreset).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: PROMPT, instructions: true }), expect.any(HTMLElement));
    const b = box() as HTMLInputElement;
    b.checked = false;
    b.dispatchEvent(new Event('change'));
    (document.querySelector('[data-key="save-preset"]') as HTMLButtonElement).click();
    expect(host.savePreset).toHaveBeenLastCalledWith(expect.objectContaining({ instructions: false }), expect.any(HTMLElement));
  });

  it('a plain hire has the box, off, with the plain-form hint, and nothing is sent while it is off', async () => {
    const { dlg, inner, hires } = setup({ lines: LINES });
    dlg.open('v-0123456789ab', 0, { prompt: PROMPT });
    await tick();
    expect(box()?.checked).toBe(false);
    expect(summary(dlg).instructions).toEqual({ on: false, lines: LINES, bytes: enc.encode(PROMPT).length + 2 + enc.encode(LINES).length });
    expect(document.querySelector('[data-hook="instructions"]')?.textContent).toContain('Tick it if this task starts other agents');
    expect(document.querySelector('[data-hook="instructions"]')?.textContent).not.toContain('preset');
    expect(document.querySelector('[data-hook="instructions-lines"]')).toBeNull();
    await inner.hire();
    expect(hires[0]).toMatchObject({ prompt: PROMPT });
    expect(hires[0]).not.toHaveProperty('herdr_instructions');
  });

  it('ticking the box on a plain hire shows the exact lines and the plain-form hint, and sends the flag with the typed prompt, never the lines', async () => {
    const { dlg, inner, hires } = setup({ lines: LINES });
    dlg.open('v-0123456789ab', 0, { prompt: PROMPT });
    await tick();
    const b = box() as HTMLInputElement;
    b.checked = true;
    b.dispatchEvent(new Event('change'));
    const bytes = enc.encode(PROMPT).length + 2 + enc.encode(LINES).length;
    expect(summary(dlg).instructions).toEqual({ on: true, lines: LINES, bytes });
    const hook = document.querySelector('[data-hook="instructions"]');
    expect(hook?.textContent).toContain('Each agent this worker starts gets its own herdr workspace or tab');
    expect(hook?.textContent).not.toContain('for this hire only');
    expect(document.querySelector('[data-hook="instructions-lines"] pre')?.textContent).toBe(LINES);
    expect(document.querySelector('[data-hook="instructions-bytes"]')?.textContent).toContain(bytes.toLocaleString('en-US'));
    await inner.hire();
    expect(hires[0]).toEqual(expect.objectContaining({ floor: 'v-0123456789ab', prompt: PROMPT, herdr_instructions: true }));
    expect(JSON.stringify(hires[0])).not.toContain('h3d_floor');
  });

  it('a plain hire blocks Hire with a reason when the task is over 32 KiB only with the lines, and the box can be unticked', async () => {
    const { dlg } = setup({ lines: LINES });
    const room = 32 * 1024 - 2 - enc.encode(LINES).length;
    dlg.open('floor', 0, { prompt: 'x'.repeat(room + 1) });
    await tick();
    expect(summary(dlg).blocker).toBeNull();
    const b = box() as HTMLInputElement;
    b.checked = true;
    b.dispatchEvent(new Event('change'));
    expect(summary(dlg).blocker).toContain('over 32 KiB');
    expect(document.querySelector('[data-key="hire"]')?.getAttribute('aria-disabled')).toBe('true');
    b.checked = false;
    b.dispatchEvent(new Event('change'));
    expect(summary(dlg).blocker).toBeNull();
  });

  it('“Save as preset…” on a plain hire carries the box as the form has it', async () => {
    const { dlg, host } = setup({ lines: LINES });
    dlg.open('floor', 0, { prompt: PROMPT });
    await tick();
    (document.querySelector('[data-key="save-preset"]') as HTMLButtonElement).click();
    expect(host.savePreset).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: PROMPT, instructions: false }), expect.any(HTMLElement));
    const b = box() as HTMLInputElement;
    b.checked = true;
    b.dispatchEvent(new Event('change'));
    (document.querySelector('[data-key="save-preset"]') as HTMLButtonElement).click();
    expect(host.savePreset).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: PROMPT, instructions: true }), expect.any(HTMLElement));
  });

  it('a bridge before #95 has no box, plain or from a preset, and nothing sends the flag', async () => {
    const plain = setup();
    plain.dlg.open('floor', 0, { prompt: PROMPT });
    await tick();
    expect(box()).toBeNull();
    expect(summary(plain.dlg).instructions).toBeUndefined();
    await plain.inner.hire();
    expect(plain.hires[0]).not.toHaveProperty('herdr_instructions');
    document.body.replaceChildren();
    const old = setup();
    old.dlg.open('floor', 0, ticked());
    await tick();
    expect(box()).toBeNull();
    await old.inner.hire();
    expect(old.hires[0]).not.toHaveProperty('herdr_instructions');
  });
});
