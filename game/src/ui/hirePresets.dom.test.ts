// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexProfile, CodexProfilesState, HireOptions, HirePreset } from '../net/protocol';
import { HirePresetBook } from '../world/hirePresets';
import { HirePresetsDialog, type HirePresetsHost, type HirePresetsSummary } from './hirePresets';
import { HireModelPrefs } from './hireModelPrefs';
import { HirePins } from './hirePins';

// #93: the "Hire preset" tab: this floor's presets and the global ones, Use (asking before an unsent task goes), and
// create / edit / delete with scoped names and live changes from other clients. Fixture slugs only.

const CAT: HireOptions = {
  codex: { models: ['x-1', 'x-2'], efforts: ['low', 'high'], extra_efforts: { 'x-2': ['ultra'] } },
  claude: { models: ['y-1'], efforts: ['low', 'high'] },
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

let n = 0;
const preset = (name: string, floor: string | null, over: Partial<HirePreset> = {}): HirePreset => {
  const p: HirePreset = { id: `hp_${++n}`, name, prompt: `${name}: do the thing.`, harness: 'codex', model: 'x-1', effort: 'low', created_at: 1, updated_at: 1, ...over };
  return floor ? { ...p, floor } : p;
};

/**
 * `list` null: a bridge before #93 (no `hire_presets`). #95 `o.instructions`: the bridge adds the herdr hiring
 * instructions; `o.classifier`: the AI integration's classifier state (absent: none).
 */
function setup(
  list: HirePreset[] | null = [],
  unsent: { text: string; images: number } | null = null,
  o: { instructions?: boolean; classifier?: string; profiles?: CodexProfilesState } = {},
) {
  const book = new HirePresetBook();
  book.reset(list ?? undefined, o.instructions);
  const sent: Array<[string, unknown]> = [];
  const replies: Record<string, (args: Record<string, unknown>) => unknown> = {};
  const send = vi.fn(async (t: string, args: Record<string, unknown>) => {
    sent.push([t, args]);
    const r = replies[t];
    if (r) return r(args);
    if (t === 'hire_preset.create') {
      const p = { id: `hp_new${sent.length}`, created_at: 5, updated_at: 5, ...args } as HirePreset;
      book.upsert(p);
      return { ok: true, data: p };
    }
    if (t === 'hire_preset.update') {
      const p = { created_at: 1, updated_at: 9, ...args } as HirePreset;
      book.upsert(p);
      return { ok: true, data: p };
    }
    if (t === 'hire_preset.delete') {
      book.remove(args.id as string);
      return { ok: true };
    }
    return { ok: false, code: 'unknown_command', message: '' };
  });
  const toasts: string[] = [];
  const host: HirePresetsHost = {
    store: {
      hirePresets: book,
      hireOptions: CAT,
      floorName: (id: string) => (id === 'web' ? 'Web' : id),
      floorView: () => ({}),
      ai: { state: o.classifier ? { classifier: { state: o.classifier } } : null },
      codexProfiles: { state: o.profiles ?? null },
    } as unknown as HirePresetsHost['store'],
    send: send as unknown as HirePresetsHost['send'],
    unsupported: () => false,
    toast: (m) => void toasts.push(m),
    now: () => 0,
    modelPrefs: new HireModelPrefs(memory()),
    pins: new HirePins(memory()),
    hireAt: vi.fn(),
    use: vi.fn(),
    unsent: vi.fn(() => unsent),
  };
  const dlg = new HirePresetsDialog(document.body, host);
  return { dlg, book, host, sent, replies, toasts };
}

const summary = (d: HirePresetsDialog) => d.summary() as HirePresetsSummary;
const click = (key: string) => (document.querySelector(`[data-key="${key}"]`) as HTMLElement).click();
const type = (sel: string, text: string) => {
  const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement;
  el.value = text;
  el.dispatchEvent(new Event('input'));
};
const pick = (key: string) => {
  const c = document.querySelector(`[data-key="${key}"]`) as HTMLInputElement;
  c.checked = true;
  c.dispatchEvent(new Event('change'));
};
const submit = async () => {
  (document.querySelector('#hp-form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
  await tick();
};

describe('HirePresetsDialog (#93)', () => {
  beforeEach(() => {
    n = 0;
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

  it('lists this floor’s own presets and the global ones, never another floor’s, with the model and the prompt’s start', () => {
    const { dlg } = setup([preset('Deploy', 'web'), preset('Deploy', null, { model: 'x-2', effort: 'ultra' }), preset('Other floor', 'api'), preset('Broken', 'web', { model: 'x-gone' })]);
    dlg.open('web', 2);
    const s = summary(dlg);
    expect(s.groups.floor.map((r) => r.name)).toEqual(['Broken', 'Deploy']);
    expect(s.groups.global.map((r) => [r.name, r.choice])).toEqual([['Deploy', 'Codex · x-2 · ultra']]);
    expect(s.groups.floor[0]?.problem?.field).toBe('model');
    expect(s.groups.floor[1]?.preview).toBe('Deploy: do the thing.');
    expect(document.querySelector('[data-group="floor"] h3')?.textContent).toBe('This floor');
    expect(document.querySelector('[data-group="floor"]')?.textContent).toContain('Only on Web');
    expect(document.querySelector('[data-group="global"] h3')?.textContent).toBe('Global');
    expect(document.querySelector('[data-key="tab:preset"]')?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement?.getAttribute('data-key')).toBe(`use:${s.groups.floor[0]?.id}`);
  });

  it('fuzzy searches preset names across both scopes and clears on Escape', () => {
    const { dlg } = setup([preset('Deploy release', 'web'), preset('Daily report', null), preset('Other', 'web')]);
    dlg.open('web', 0);
    const search = document.querySelector<HTMLInputElement>('#hp-search')!;
    expect(search).not.toBeNull();
    search.focus();
    type('#hp-search', 'dpr');
    expect([...document.querySelectorAll('.hp-row h4')].map((el) => el.textContent)).toEqual(['Deploy release', 'Daily report']);
    expect(document.activeElement?.id).toBe('hp-search');
    type('#hp-search', 'zzzz');
    expect(document.querySelector('[data-hook="hp-no-matches"]')).not.toBeNull();
    document.querySelector<HTMLInputElement>('#hp-search')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.querySelector<HTMLInputElement>('#hp-search')!.value).toBe('');
    expect(document.querySelectorAll('.hp-row')).toHaveLength(3);
  });

  it('has an empty state that creates, and an older bridge’s unavailable state', () => {
    let { dlg } = setup([]);
    dlg.open('web', 0);
    expect(document.querySelector('[data-hook="hp-empty"]')).not.toBeNull();
    click('empty-new');
    expect(summary(dlg).view).toBe('edit');
    document.body.replaceChildren();
    ({ dlg } = setup(null));
    dlg.open('web', 0);
    expect(summary(dlg).off).toMatch(/can’t keep hire presets yet/);
    expect(document.querySelector('[data-hook="hp-off"]')?.textContent).toContain('Hire worker and Hire orchestrator work as before');
    expect(document.querySelector('[data-key="new"]')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('Use opens the hire form with the preset at once on an empty desk; an unsent task is replaced only when asked', () => {
    const p = preset('Deploy', 'web');
    let s = setup([p]);
    s.dlg.open('web', 2);
    click(`use:${p.id}`);
    expect(s.host.use).toHaveBeenCalledWith('web', 2, p, false);
    expect(s.dlg.isOpen).toBe(false);
    document.body.replaceChildren();

    s = setup([p], { text: 'my half-written task', images: 2 });
    s.dlg.open('web', 2);
    click(`use:${p.id}`);
    expect(s.host.use).not.toHaveBeenCalled();
    const ask = document.querySelector('[data-hook="hp-replace"]') as HTMLElement;
    expect(ask.textContent).toContain('my half-written task');
    expect(ask.textContent).toContain('2 images');
    click(`keep-task:${p.id}`);
    expect(s.host.use).not.toHaveBeenCalled();
    expect(summary(s.dlg).replacing).toBeNull();
    click(`use:${p.id}`);
    click(`replace:${p.id}`);
    expect(s.host.use).toHaveBeenCalledWith('web', 2, p, true);
  });

  it('creates on this floor by default, Global without a floor; names are checked within the scope only', async () => {
    const { dlg, sent } = setup([preset('Deploy', 'web'), preset('Nightly', null)]);
    dlg.open('web', 0);
    click('new');
    type('#hp-name', ' deploy ');
    type('#hp-prompt', 'Ship it.');
    await submit();
    expect(summary(dlg).editing?.error).toMatchObject({ field: 'name' });
    expect(sent).toEqual([]);
    // The same name in Global is fine; a Global name taken is not.
    pick('preset-scope:global');
    await submit();
    expect(sent).toEqual([['hire_preset.create', { name: 'deploy', prompt: 'Ship it.', harness: 'codex', model: 'x-1', effort: 'high' }]]);
    expect(summary(dlg).view).toBe('list');
    expect(summary(dlg).groups.global.map((r) => r.name)).toEqual(['deploy', 'Nightly']);
    click('new');
    type('#hp-name', 'Audit');
    type('#hp-prompt', '--force');
    await submit();
    expect(summary(dlg).editing?.error).toMatchObject({ field: 'prompt' });
    type('#hp-prompt', 'Audit the deps.');
    pick('preset-harness:claude');
    await submit();
    expect(sent[1]).toEqual(['hire_preset.create', { name: 'Audit', floor: 'web', prompt: 'Audit the deps.', harness: 'claude', model: 'y-1', effort: 'high' }]);
  });

  it('an editor whose preset changed elsewhere says so and can load it; one deleted elsewhere saves as a new preset', async () => {
    const p = preset('Deploy', 'web');
    const { dlg, book, sent } = setup([p]);
    dlg.open('web', 0);
    click(`edit:${p.id}`);
    type('#hp-prompt', 'My edit.');
    book.upsert({ ...p, prompt: 'Their edit.', updated_at: 7 });
    dlg.refresh();
    expect(summary(dlg).editing?.stale).toBe('changed');
    expect(document.querySelector('[data-hook="hp-stale"]')?.textContent).toContain('changed elsewhere');
    click('reload');
    expect(summary(dlg).editing?.draft.prompt).toBe('Their edit.');
    expect(summary(dlg).editing?.stale).toBeNull();
    book.remove(p.id);
    dlg.refresh();
    expect(summary(dlg).editing?.stale).toBe('deleted');
    expect(document.querySelector('[data-key="save"]')?.textContent).toBe('Save as new preset');
    await submit();
    expect(sent.map((x) => x[0])).toEqual(['hire_preset.create']);
  });

  it('keeps a saved choice the catalog lost: shown with why, never replaced, until the player picks', async () => {
    const p = preset('Old', 'web', { model: 'x-gone', effort: 'high' });
    const { dlg, sent } = setup([p]);
    dlg.open('web', 0);
    click(`edit:${p.id}`);
    expect(summary(dlg).editing?.draft).toMatchObject({ model: 'x-gone', effort: 'high' });
    expect(document.querySelector('[data-hook="hp-problem"]')?.textContent).toContain('x-gone');
    await submit();
    expect(sent).toEqual([]);
    expect(summary(dlg).editing?.error).toMatchObject({ field: 'choice' });
    pick('preset-model:x-2');
    await submit();
    expect(sent[0]).toEqual(['hire_preset.update', { id: p.id, name: 'Old', floor: 'web', prompt: p.prompt, harness: 'codex', model: 'x-2', effort: 'high' }]);
  });

  it('deletes after a confirmation; the list follows other clients’ changes live', async () => {
    const p = preset('Deploy', 'web');
    const { dlg, book, sent } = setup([p]);
    dlg.open('web', 0);
    click(`delete:${p.id}`);
    expect(summary(dlg).confirm).toBe(p.id);
    click(`keep:${p.id}`);
    expect(sent).toEqual([]);
    click(`delete:${p.id}`);
    click(`confirm-delete:${p.id}`);
    await tick();
    expect(sent).toEqual([['hire_preset.delete', { id: p.id }]]);
    book.upsert(preset('From elsewhere', null));
    dlg.refresh();
    expect(summary(dlg).groups.global.map((r) => r.name)).toEqual(['From elsewhere']);
  });

  it('a delete reply leaves an editor opened meanwhile as it is, also after a close and reopen', async () => {
    for (const reopen of [false, true]) {
      document.body.replaceChildren();
      const a = preset('Audit', 'web');
      const b = preset('Build', 'web');
      const { dlg, book, replies } = setup([a, b]);
      let resolve = (_: unknown) => {};
      replies['hire_preset.delete'] = () => new Promise((r) => (resolve = r));
      dlg.open('web', 0);
      click(`delete:${a.id}`);
      click(`confirm-delete:${a.id}`);
      if (reopen) {
        dlg.close();
        dlg.open('web', 0);
      } else click(`keep:${a.id}`);
      click(`edit:${b.id}`);
      type('#hp-name', 'Build all');
      book.remove(a.id);
      dlg.refresh();
      resolve({ ok: true });
      await tick();
      const s = summary(dlg);
      expect(s.view).toBe('edit');
      expect(s.editing).toMatchObject({ id: b.id, draft: { name: 'Build all' } });
      expect((document.querySelector('#hp-name') as HTMLInputElement).value).toBe('Build all');
      expect(s.state).toBe('ready');
    }
  });

  it('keeps focus on the header and the tabs when the list or the editor re-renders live', () => {
    const p = preset('Deploy', 'web');
    const { dlg, book } = setup([p]);
    dlg.open('web', 0);
    for (const key of ['close', 'tab:preset', 'tab:worker']) {
      (document.querySelector(`[data-key="${key}"]`) as HTMLElement).focus();
      book.upsert(preset(`Other ${key}`, null));
      dlg.refresh();
      expect((document.activeElement as HTMLElement).dataset.key).toBe(key);
    }
    click(`edit:${p.id}`);
    for (const key of ['back', 'close']) {
      (document.querySelector(`[data-key="${key}"]`) as HTMLElement).focus();
      book.upsert(preset(`Editing ${key}`, null));
      dlg.refresh();
      expect((document.activeElement as HTMLElement).dataset.key).toBe(key);
    }
  });

  it('opened from the hire form, the editor saves and goes back to it with a toast', async () => {
    const { dlg, sent, toasts } = setup([]);
    const from = document.body.appendChild(document.createElement('button'));
    dlg.create({ floor: 'web', prompt: 'Audit the deps.', harness: 'codex', model: 'x-2', effort: 'ultra', imagesLeftOut: 1 }, from);
    expect(summary(dlg).desk).toBeNull();
    expect(document.querySelector('.hp-note')?.textContent).toContain('image of the first task is not saved');
    type('#hp-name', 'Audit');
    await submit();
    expect(sent[0]).toEqual(['hire_preset.create', { name: 'Audit', floor: 'web', prompt: 'Audit the deps.', harness: 'codex', model: 'x-2', effort: 'ultra' }]);
    expect(dlg.isOpen).toBe(false);
    expect(toasts).toEqual(['Created hire preset “Audit” (this floor).']);
    expect(document.activeElement).toBe(from);
  });

  it('says why the bridge refused a name it knows is taken', async () => {
    const { dlg, replies } = setup([]);
    replies['hire_preset.create'] = () => ({ ok: false, code: 'name_taken', message: 'name already used: a hire preset on this floor is called "X"' });
    dlg.open('web', 0);
    click('new');
    type('#hp-name', 'X');
    type('#hp-prompt', 'p');
    await submit();
    expect(summary(dlg).editing?.error).toEqual({ field: 'name', why: 'Another preset on this floor is called “X”.' });
  });

  it('shows on the name field a clash only the bridge sees (its case folding joins STRASSE and straße)', async () => {
    const other = preset('straße', 'web');
    const mine = preset('Notes', 'web');
    const { dlg, sent, replies } = setup([other, mine]);
    replies['hire_preset.update'] = (a) =>
      a.name === 'STRASSE' ? { ok: false, code: 'name_taken', message: 'name already used: a hire preset on this floor is called "STRASSE"' } : { ok: true, data: { ...mine, ...a } };
    dlg.open('web', 0);
    click(`edit:${mine.id}`);
    type('#hp-name', 'STRASSE');
    await submit();
    expect(sent.map((x) => x[0])).toEqual(['hire_preset.update']);
    const s = summary(dlg);
    expect([s.view, s.editing?.id, s.editing?.draft.name, s.editing?.saving]).toEqual(['edit', mine.id, 'STRASSE', false]);
    const input = document.querySelector<HTMLInputElement>('#hp-name')!;
    expect(input.value).toBe('STRASSE');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('#hp-name-error')?.textContent).toBe('Another preset on this floor is called “STRASSE”.');
    expect(document.activeElement).toBe(input);
    // Another name saves as usual.
    type('#hp-name', 'Strasse notes');
    await submit();
    expect(sent[1]).toEqual(['hire_preset.update', expect.objectContaining({ id: mine.id, name: 'Strasse notes' })]);
    expect(summary(dlg).view).toBe('list');
  });
});

// #95: "Add herdr hiring instructions" in the editor, and the classifier's nudge on Save.
describe('HirePresetsDialog: herdr hiring instructions (#95)', () => {
  beforeEach(() => {
    n = 0;
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

  const DEPENDABOT = 'Merge all dependabot pull requests: for each pull request, spawn a gpt-6-luna subagent on high reasoning.';
  const ready = { instructions: true, classifier: 'ready' };
  const box = () => document.querySelector<HTMLInputElement>('#hp-instructions');
  const tickBox = (on: boolean) => {
    const b = box() as HTMLInputElement;
    b.checked = on;
    b.dispatchEvent(new Event('change'));
  };
  const cancel = () => (document.querySelector('dialog') as HTMLDialogElement).dispatchEvent(new Event('cancel', { cancelable: true }));
  /** A new preset with `prompt`, saved. */
  const fresh = async (dlg: HirePresetsDialog, prompt: string) => {
    dlg.open('web', 0);
    click('new');
    type('#hp-name', 'Dependabot');
    type('#hp-prompt', prompt);
    await submit();
  };
  const created = (sent: Array<[string, unknown]>) => sent.filter(([t]) => t === 'hire_preset.create').map(([, a]) => a as Record<string, unknown>);

  it('saves the box with the preset (off by default), opens a preset with its box, and updates it as part of the spec', async () => {
    const p = preset('Deploy', 'web', { herdr_instructions: true });
    const { dlg, sent } = setup([p], null, { instructions: true });
    dlg.open('web', 0);
    click('new');
    expect(box()?.checked).toBe(false);
    expect(document.querySelector('#hp-instructions-hint')?.textContent).toContain('tagged with the floor it’s used on');
    type('#hp-name', 'Nightly');
    type('#hp-prompt', 'Run the nightly checks.');
    tickBox(true);
    await submit();
    expect(created(sent)[0]).toMatchObject({ prompt: 'Run the nightly checks.', herdr_instructions: true });
    click(`edit:${p.id}`);
    expect(box()?.checked).toBe(true);
    tickBox(false);
    await submit();
    expect(sent.at(-1)).toEqual(['hire_preset.update', expect.objectContaining({ id: p.id, herdr_instructions: false })]);
  });

  it('asks before saving a prompt that starts other agents: Turn on and save saves it ticked', async () => {
    const { dlg, sent, replies } = setup([], null, ready);
    replies['hire_preset.check'] = () => ({ ok: true, data: { delegates: true, score: 0.93 } });
    await fresh(dlg, DEPENDABOT);
    expect(sent.map(([t]) => t)).toEqual(['hire_preset.check']);
    expect(sent[0]?.[1]).toEqual({ prompt: DEPENDABOT });
    expect(summary(dlg).editing?.nudge).toBe(true);
    expect(document.querySelector('[data-hook="hp-nudge"]')?.textContent).toContain('This task starts other agents');
    expect(document.activeElement?.getAttribute('data-key')).toBe('nudge-on');
    expect(box()?.checked).toBe(false);
    click('nudge-on');
    await tick();
    expect(created(sent)).toEqual([expect.objectContaining({ prompt: DEPENDABOT, herdr_instructions: true })]);
    expect(sent.filter(([t]) => t === 'hire_preset.check')).toHaveLength(1);
  });

  it('Save as is saves it unticked and does not ask again for the same text; another text is asked about', async () => {
    const { dlg, sent, replies } = setup([], null, ready);
    replies['hire_preset.check'] = () => ({ ok: true, data: { delegates: true, score: 0.93 } });
    replies['hire_preset.create'] = () => ({ ok: false, code: 'internal', message: 'disk full' });
    await fresh(dlg, DEPENDABOT);
    click('nudge-as-is');
    await tick();
    expect(created(sent)).toEqual([expect.objectContaining({ herdr_instructions: false })]);
    // Refused: a Save again with the same text goes straight to the bridge.
    await submit();
    expect(sent.filter(([t]) => t === 'hire_preset.check')).toHaveLength(1);
    expect(created(sent)).toHaveLength(2);
    type('#hp-prompt', `${DEPENDABOT} Then report.`);
    await submit();
    expect(sent.filter(([t]) => t === 'hire_preset.check')).toHaveLength(2);
    expect(summary(dlg).editing?.nudge).toBe(true);
  });

  it('Save as is outlives the editor: the saved preset is not asked about again for that text, an edited text is', async () => {
    const p = preset('Dependabot', 'web', { prompt: DEPENDABOT });
    const { dlg, sent, replies } = setup([p], null, ready);
    replies['hire_preset.check'] = () => ({ ok: true, data: { delegates: true, score: 0.93 } });
    const checks = () => sent.filter(([t]) => t === 'hire_preset.check').length;
    dlg.open('web', 0);
    click(`edit:${p.id}`);
    await submit();
    expect(summary(dlg).editing?.nudge).toBe(true);
    click('nudge-as-is');
    await tick();
    expect(summary(dlg).view).toBe('list');
    // Reopened, the same text saves with no question (a new name or model is no new text).
    click(`edit:${p.id}`);
    type('#hp-name', 'Dependabot sweep');
    await submit();
    expect(checks()).toBe(1);
    expect(sent.at(-1)).toEqual(['hire_preset.update', expect.objectContaining({ id: p.id, name: 'Dependabot sweep', herdr_instructions: false })]);
    // Also after a close and reopen of the dialog.
    dlg.close();
    dlg.open('web', 0);
    click(`edit:${p.id}`);
    await submit();
    expect(checks()).toBe(1);
    expect(summary(dlg).view).toBe('list');
    // Another text is asked about.
    click(`edit:${p.id}`);
    type('#hp-prompt', `${DEPENDABOT} Then report.`);
    await submit();
    expect(checks()).toBe(2);
    expect(summary(dlg).editing?.nudge).toBe(true);
  });

  it('Save as is on a new preset (also one saved from the hire form) carries over to the preset the bridge created', async () => {
    for (const fromForm of [false, true]) {
      const { dlg, sent, replies } = setup([], null, ready);
      replies['hire_preset.check'] = () => ({ ok: true, data: { delegates: true, score: 0.93 } });
      const checks = () => sent.filter(([t]) => t === 'hire_preset.check').length;
      if (fromForm) {
        dlg.create({ floor: 'web', prompt: DEPENDABOT, harness: 'codex', model: 'x-1', effort: 'low', imagesLeftOut: 0 });
        type('#hp-name', 'Dependabot');
        await submit();
      } else await fresh(dlg, DEPENDABOT);
      click('nudge-as-is');
      await tick();
      expect(created(sent), String(fromForm)).toEqual([expect.objectContaining({ prompt: DEPENDABOT, herdr_instructions: false })]);
      dlg.open('web', 0);
      const id = summary(dlg).groups.floor.find((r) => r.name === 'Dependabot')?.id as string;
      click(`edit:${id}`);
      await submit();
      expect(checks(), String(fromForm)).toBe(1);
      expect(sent.at(-1), String(fromForm)).toEqual(['hire_preset.update', expect.objectContaining({ id, prompt: DEPENDABOT })]);
      document.body.replaceChildren();
    }
  });

  it('Esc closes the question and goes back to the editor without saving (also over the hire form)', async () => {
    for (const fromForm of [false, true]) {
      const { dlg, sent, replies } = setup([], null, ready);
      replies['hire_preset.check'] = () => ({ ok: true, data: { delegates: true, score: 0.93 } });
      if (fromForm) {
        dlg.create({ floor: 'web', prompt: DEPENDABOT, harness: 'codex', model: 'x-1', effort: 'low', imagesLeftOut: 0 });
        type('#hp-name', 'Dependabot');
        await submit();
      } else await fresh(dlg, DEPENDABOT);
      expect(summary(dlg).editing?.nudge).toBe(true);
      cancel();
      expect(dlg.isOpen).toBe(true);
      expect(summary(dlg).view).toBe('edit');
      expect(summary(dlg).editing?.nudge).toBe(false);
      expect(document.querySelector('[data-hook="hp-nudge"]')).toBeNull();
      expect(document.activeElement?.id).toBe('hp-instructions');
      expect(created(sent)).toEqual([]);
      document.body.replaceChildren();
    }
  });

  it('saves with no question when the box is ticked, the prompt has h3d_floor, the classifier is not ready, says no, fails or times out', async () => {
    const cases: Array<[string, Parameters<typeof setup>[2], (r: Record<string, (a: Record<string, unknown>) => unknown>) => void, string]> = [
      ['no', ready, (r) => (r['hire_preset.check'] = () => ({ ok: true, data: { delegates: false, score: 0.2 } })), DEPENDABOT],
      ['error', ready, (r) => (r['hire_preset.check'] = () => ({ ok: false, code: 'internal', message: 'boom' })), DEPENDABOT],
      ['timeout', ready, (r) => (r['hire_preset.check'] = () => ({ ok: false, code: 'timeout', message: '' })), DEPENDABOT],
      ['own token', ready, () => {}, `${DEPENDABOT} Tag them h3d_floor=v-1.`],
      ['not ready', { instructions: true, classifier: 'invalid' }, () => {}, DEPENDABOT],
      ['no classifier', { instructions: true }, () => {}, DEPENDABOT],
    ];
    for (const [name, o, reply, prompt] of cases) {
      const { dlg, sent, replies } = setup([], null, o);
      reply(replies);
      await fresh(dlg, prompt);
      expect(created(sent), name).toEqual([expect.objectContaining({ prompt, herdr_instructions: false })]);
      expect(sent.filter(([t]) => t === 'hire_preset.check').length, name).toBe(['no', 'error', 'timeout'].includes(name) ? 1 : 0);
      document.body.replaceChildren();
    }
    const { dlg, sent } = setup([], null, ready);
    dlg.open('web', 0);
    click('new');
    type('#hp-name', 'Dependabot');
    type('#hp-prompt', DEPENDABOT);
    tickBox(true);
    await submit();
    expect(sent.map(([t]) => t)).toEqual(['hire_preset.create']);
  });

  it('“Save as preset…” seeds the box from the form it came from', () => {
    const { dlg } = setup([], null, ready);
    dlg.create({ floor: 'web', prompt: 'x', harness: 'codex', model: 'x-1', effort: 'low', imagesLeftOut: 0, instructions: true });
    expect(box()?.checked).toBe(true);
    dlg.close();
    dlg.create({ floor: 'web', prompt: 'x', harness: 'codex', model: 'x-1', effort: 'low', imagesLeftOut: 0 });
    expect(box()?.checked).toBe(false);
  });

  it('a bridge before #95 shows no box and no question, says to update it, and is never sent the field or the check', async () => {
    const { dlg, sent, replies } = setup([], null, { classifier: 'ready' });
    replies['hire_preset.check'] = () => ({ ok: true, data: { delegates: true, score: 0.99 } });
    await fresh(dlg, DEPENDABOT);
    expect(box()).toBeNull();
    expect(summary(dlg).instructions).toBe(false);
    expect(sent.map(([t]) => t)).toEqual(['hire_preset.create']);
    expect(created(sent)[0]).not.toHaveProperty('herdr_instructions');
    dlg.open('web', 0);
    click('new');
    expect(document.querySelector('[data-hook="hp-instructions-off"]')?.textContent).toBe('This herdr-world can’t add hiring instructions yet. Update the bridge to use it.');
  });
});

// #139: a Codex preset's profile, as the hire dialog picks it.
describe('HirePresetsDialog: Codex profile (#139)', () => {
  beforeEach(() => {
    n = 0;
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
  const prof = (key: string, more: Partial<CodexProfile> = {}): CodexProfile => ({
    key,
    name: key,
    path: `/h/.codex-${key}`,
    display: `~/.codex-${key}`,
    plan: '',
    signed_in: true,
    default: key === 'codex',
    hidden: false,
    added: false,
    ...more,
  });
  const TWO: CodexProfilesState = { hire: true, profiles: [prof('codex'), prof('work')] };

  it('keeps the profile a preset has, and saves the one picked', async () => {
    const p = preset('Review', 'web', { codex_profile: 'work' });
    const { dlg, sent } = setup([p], null, { profiles: TWO });
    dlg.open('web', 0);
    click(`edit:${p.id}`);
    expect((document.querySelector('[data-key="preset-profile:work"]') as HTMLInputElement).checked).toBe(true);
    await submit();
    expect(sent.at(-1)).toEqual(['hire_preset.update', expect.objectContaining({ codex_profile: 'work' })]);
    click(`edit:${p.id}`);
    pick('preset-profile:codex');
    await submit();
    expect(sent.at(-1)).toEqual(['hire_preset.update', expect.objectContaining({ codex_profile: 'codex' })]);
  });

  it('a gone profile shows the default and says so; with one profile no picker, the note, and the key kept; an older bridge gets none', async () => {
    const p = preset('Review', 'web', { codex_profile: 'old' });
    let { dlg, sent } = setup([p], null, { profiles: TWO });
    dlg.open('web', 0);
    click(`edit:${p.id}`);
    expect((document.querySelector('[data-key="preset-profile:codex"]') as HTMLInputElement).checked).toBe(true);
    expect(document.querySelector('[data-hook="profile-gone"]')?.textContent).toBe('This preset’s Codex profile “old” is gone: it hires on codex.');
    document.body.replaceChildren();
    ({ dlg, sent } = setup([p], null, { profiles: { hire: true, profiles: [prof('codex')] } }));
    dlg.open('web', 0);
    click(`edit:${p.id}`);
    expect(document.querySelector('[data-pick="preset-profile"]')).toBeNull();
    expect(document.querySelector('[data-hook="profile-gone"]')?.textContent).toBe('This preset’s Codex profile “old” is gone: it hires on codex.');
    await submit();
    expect(sent.at(-1)?.[1]).toMatchObject({ codex_profile: 'old' });
    document.body.replaceChildren();
    ({ dlg, sent } = setup([p], null, { profiles: { profiles: TWO.profiles } }));
    dlg.open('web', 0);
    click(`edit:${p.id}`);
    expect(document.querySelector('[data-pick="preset-profile"]')).toBeNull();
    expect(document.querySelector('[data-hook="profile-gone"]')).toBeNull();
    await submit();
    expect(sent.at(-1)?.[1]).not.toHaveProperty('codex_profile');
  });

  // #140: Auto, first; a new Codex preset starts on it and stores "auto"; one with none keeps meaning the default.
  it('a new Codex preset starts on Auto and stores "auto"; an Auto preset keeps it; one with none stays on the default', async () => {
    const AUTO: CodexProfilesState = { ...TWO, auto: true, rules: [] };
    const none = preset('Plain', 'web');
    const auto = preset('Auto', 'web', { codex_profile: 'auto' });
    const { dlg, sent } = setup([none, auto], null, { profiles: AUTO });
    dlg.open('web', 0);
    click('new');
    expect([...document.querySelectorAll('[data-pick="preset-profile"] .dd-chip')].map((c) => c.textContent)).toEqual(['Auto', 'codex', 'work']);
    expect((document.querySelector('[data-key="preset-profile:auto"]') as HTMLInputElement).checked).toBe(true);
    type('#hp-name', 'Fresh');
    type('#hp-prompt', 'Ship it.');
    await submit();
    expect(sent.at(-1)).toEqual(['hire_preset.create', expect.objectContaining({ name: 'Fresh', codex_profile: 'auto' })]);
    click(`edit:${auto.id}`);
    expect((document.querySelector('[data-key="preset-profile:auto"]') as HTMLInputElement).checked).toBe(true);
    await submit();
    expect(sent.at(-1)).toEqual(['hire_preset.update', expect.objectContaining({ codex_profile: 'auto' })]);
    click(`edit:${none.id}`);
    expect((document.querySelector('[data-key="preset-profile:codex"]') as HTMLInputElement).checked).toBe(true);
    pick('preset-profile:auto');
    await submit();
    expect(sent.at(-1)).toEqual(['hire_preset.update', expect.objectContaining({ codex_profile: 'auto' })]);
  });

  it('an old preset with no profile, edited and saved again untouched, is never saved as Auto', async () => {
    const none = preset('Plain', 'web');
    const { dlg, sent } = setup([none], null, { profiles: { ...TWO, auto: true, rules: [] } });
    dlg.open('web', 0);
    click(`edit:${none.id}`);
    expect((document.querySelector('[data-key="preset-profile:auto"]') as HTMLInputElement).checked).toBe(false);
    type('#hp-prompt', 'Review it again.');
    await submit();
    expect(sent.at(-1)?.[0]).toBe('hire_preset.update');
    expect(sent.at(-1)?.[1]).not.toMatchObject({ codex_profile: 'auto' });
    expect(sent.at(-1)?.[1]).toMatchObject({ codex_profile: 'codex' });
  });
});

describe('HirePresetsDialog pins', () => {
  beforeEach(() => {
    n = 0;
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

  const tabKeys = () => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].map((t) => t.dataset.key);

  it('pins and unpins a preset from its row, and the tab bar follows: this floor’s and the global pins, in pin order', () => {
    const { dlg, host } = setup([preset('Deploy', 'web'), preset('Global', null), preset('Other floor', 'api')]);
    host.pins!.pin('hp_3');
    dlg.open('web', 0);
    const pinBtn = () => document.querySelector<HTMLElement>('[data-key="pin:hp_1"]')!;
    expect(pinBtn().getAttribute('aria-pressed')).toBe('false');
    pinBtn().focus();
    pinBtn().click();
    click('pin:hp_2');
    expect(summary(dlg).pins).toEqual(['hp_1', 'hp_2']);
    expect(summary(dlg).groups.floor[0]?.pinned).toBe(true);
    expect(pinBtn().getAttribute('aria-pressed')).toBe('true');
    expect((document.activeElement as HTMLElement).dataset.key).toBe('pin:hp_1');
    expect(tabKeys()).toEqual(['tab:worker', 'tab:preset', 'tab:pin:hp_1', 'tab:pin:hp_2']);
    pinBtn().click();
    expect(summary(dlg).pins).toEqual(['hp_2']);
    expect(host.pins!.ids).toEqual(['hp_3', 'hp_2']);
  });

  it('a pinned tab hires with its preset as Use does, straight to the hire form when the desk has no unsent task', () => {
    const { dlg, host } = setup([preset('Deploy', 'web')]);
    host.pins!.pin('hp_1');
    dlg.open('web', 3);
    click('tab:pin:hp_1');
    expect(dlg.isOpen).toBe(false);
    expect(host.use).toHaveBeenCalledWith('web', 3, expect.objectContaining({ id: 'hp_1', name: 'Deploy' }), false);
    // From another dialog's tab bar, the list never opens.
    dlg.usePinned('web', 1, 'hp_1');
    expect(dlg.isOpen).toBe(false);
    expect(host.use).toHaveBeenLastCalledWith('web', 1, expect.objectContaining({ id: 'hp_1' }), false);
  });

  it('a pinned tab of this dialog goes through the app’s hook when it has one (the hire form’s tab takes the focus)', () => {
    const { dlg, host } = setup([preset('Deploy', 'web')]);
    host.pins!.pin('hp_1');
    host.usePinned = vi.fn();
    dlg.open('web', 3);
    click('tab:pin:hp_1');
    expect(host.usePinned).toHaveBeenCalledWith('web', 3, 'hp_1');
    expect(host.use).not.toHaveBeenCalled();
  });

  it('a pinned tab on a desk with an unsent task asks first, in the list', () => {
    const { dlg, host } = setup([preset('Deploy', 'web')], { text: 'my own task', images: 0 });
    dlg.usePinned('web', 2, 'hp_1');
    expect(dlg.isOpen).toBe(true);
    expect(summary(dlg).replacing).toBe('hp_1');
    expect(host.use).not.toHaveBeenCalled();
    click('replace:hp_1');
    expect(host.use).toHaveBeenCalledWith('web', 2, expect.objectContaining({ id: 'hp_1' }), true);
  });

  it('a pinned preset deleted meanwhile says so and opens nothing', () => {
    const { dlg, host, toasts } = setup([]);
    dlg.usePinned('web', 0, 'hp_gone');
    expect(dlg.isOpen).toBe(false);
    expect(host.use).not.toHaveBeenCalled();
    expect(toasts).toEqual(['That hire preset is gone.']);
  });
});
