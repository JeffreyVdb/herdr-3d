// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HireOptions, HirePreset } from '../net/protocol';
import { HirePresetBook } from '../world/hirePresets';
import { HirePresetsDialog, type HirePresetsHost, type HirePresetsSummary } from './hirePresets';
import { HireModelPrefs } from './hireModelPrefs';

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

/** `list` null: a bridge before #93 (no `hire_presets`). */
function setup(list: HirePreset[] | null = [], unsent: { text: string; images: number } | null = null) {
  const book = new HirePresetBook();
  book.reset(list ?? undefined);
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
    store: { hirePresets: book, hireOptions: CAT, floorName: (id: string) => (id === 'web' ? 'Web' : id), floorView: () => ({}) } as unknown as HirePresetsHost['store'],
    send: send as unknown as HirePresetsHost['send'],
    unsupported: () => false,
    toast: (m) => void toasts.push(m),
    now: () => 0,
    modelPrefs: new HireModelPrefs(memory()),
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
});
