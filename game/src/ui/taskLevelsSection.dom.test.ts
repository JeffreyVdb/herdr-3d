// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HireOptions } from '../net/protocol';
import { HireModelPrefs } from './hireModelPrefs';
import { TaskLevels } from './taskLevels';
import { taskLevelsSection } from './taskLevelsSection';

// #248, #40: Settings → Task levels. Fixture slugs and names only.

const CAT: HireOptions = {
  codex: { models: ['x-1', 'x-2', 'x-3'], efforts: ['low', 'high'], extra_efforts: { 'x-2': ['ultra'] } },
  claude: { models: ['y-1', 'y-2'], efforts: ['low', 'medium', 'high'], model_labels: { 'y-1': 'Why One' } },
};

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

function mount(cat: HireOptions = CAT, names: string[] = []) {
  document.body.replaceChildren();
  const prefs = new HireModelPrefs(memory());
  let n = 0;
  const levels = new TaskLevels(memory(), () => `id-${++n}`);
  for (const name of names) levels.add(name);
  let catalog = cat;
  const body = document.createElement('div');
  document.body.append(body);
  const handle = taskLevelsSection({ levels, prefs, options: () => catalog })(body);
  const row = (id: string) => body.querySelector<HTMLElement>(`.tl-level[data-level="${id}"]`)!;
  const input = (key: string) => body.querySelector<HTMLInputElement>(`[data-key="${key}"]`);
  const button = (key: string) => body.querySelector<HTMLButtonElement>(`[data-key="${key}"]`)!;
  const names_ = () => [...body.querySelectorAll<HTMLInputElement>('.tl-level .tl-name')].map((i) => i.value);
  const type = (id: string, value: string) => {
    const f = input(`tl-${id}-name`)!;
    f.focus();
    f.value = value;
    f.dispatchEvent(new Event('input'));
    return f;
  };
  const key = (target: HTMLElement, k: string) => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  };
  return { body, prefs, levels, handle, row, input, button, names: names_, type, key, setCatalog: (c: HireOptions) => (catalog = c) };
}

describe('Settings → Task levels (#248, #40)', () => {
  beforeEach(() => vi.stubGlobal('CSS', { escape: (s: string) => s }));
  afterEach(() => vi.unstubAllGlobals());

  it('starts with no levels: no rows, a hint, and Add level', () => {
    const m = mount();
    expect(m.body.querySelectorAll('.tl-level')).toHaveLength(0);
    expect(m.body.querySelector<HTMLElement>('.tl-empty')!.hidden).toBe(false);
    expect(m.button('tl-add').textContent).toBe('Add level');
  });

  it('Add level appends a level that is not set yet, with a free name, and puts the keyboard on its name', () => {
    const m = mount(CAT, ['Level 1']);
    m.button('tl-add').click();
    expect(m.names()).toEqual(['Level 1', 'Level 2']);
    expect(m.levels.list()[1]).toEqual({ id: 'id-2', name: 'Level 2', harness: '', model: '', effort: '' });
    expect(document.activeElement).toBe(m.input('tl-id-2-name'));
    const r = m.row('id-2');
    expect(r.querySelector('.settings-badge')!.textContent).toBe('Not set');
    expect(r.querySelector('[data-pick="tl-id-2-harness"]')).not.toBeNull();
    expect(r.querySelector('[data-pick="tl-id-2-model"]')).toBeNull();
    expect(m.button('tl-id-2-clear').getAttribute('aria-disabled')).toBe('true');
    expect(m.body.querySelector<HTMLElement>('.tl-empty')!.hidden).toBe(true);
  });

  it('Add level stops at 20, with why', () => {
    const m = mount(CAT, Array.from({ length: 19 }, (_, i) => `L${i}`));
    m.button('tl-add').click();
    expect(m.levels.list()).toHaveLength(20);
    const add = m.button('tl-add');
    expect(add.getAttribute('aria-disabled')).toBe('true');
    const hint = m.body.querySelector<HTMLElement>(`#${add.getAttribute('aria-describedby')}`)!;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toMatch(/At most 20 levels/);
    add.click();
    expect(m.levels.list()).toHaveLength(20);
    m.levels.remove('id-1');
    expect(add.getAttribute('aria-disabled')).toBeNull();
    expect(hint.hidden).toBe(true);
  });

  it('renames a level in place on Enter or when the field is left; the controls are named after it', () => {
    const m = mount(CAT, ['Level 1', 'Docs']);
    const f = m.type('id-1', '  Quick fix ');
    expect(m.key(f, 'Enter').defaultPrevented).toBe(true);
    expect(m.levels.get('id-1')?.name).toBe('Quick fix');
    expect(f.value).toBe('Quick fix');
    // The same field, still focused.
    expect(m.input('tl-id-1-name')).toBe(f);
    expect(document.activeElement).toBe(f);
    expect(m.button('tl-id-1-remove').getAttribute('aria-label')).toBe('Remove Quick fix');
    expect(m.button('tl-id-1-up').getAttribute('aria-label')).toBe('Move Quick fix up');
    expect(m.button('tl-id-1-down').getAttribute('aria-label')).toBe('Move Quick fix down');
    expect(m.button('tl-id-1-clear').getAttribute('aria-label')).toBe('Clear Quick fix');
    expect(m.input('tl-id-1-default')!.getAttribute('aria-label')).toBe('Default level: Quick fix');
    expect(f.getAttribute('aria-label')).toBe('Name of level 1 of 2');
    m.type('id-2', 'Docs and notes');
    m.input('tl-id-2-name')!.blur();
    expect(m.levels.get('id-2')?.name).toBe('Docs and notes');
  });

  it('a name that cannot be used shows why on its row and is not saved; Esc goes back to the saved name', () => {
    const m = mount(CAT, ['Quick fix', 'Docs']);
    const f = m.type('id-2', 'quick FIX');
    m.key(f, 'Enter');
    expect(m.levels.get('id-2')?.name).toBe('Docs');
    const err = m.row('id-2').querySelector<HTMLElement>('.tl-name-error')!;
    expect(err.hidden).toBe(false);
    expect(err.textContent).toMatch(/already a level called/);
    expect(f.getAttribute('aria-invalid')).toBe('true');
    expect(f.getAttribute('aria-describedby')).toBe(err.id);
    // What was typed stays to be fixed, over a redraw another row causes.
    m.levels.set('id-1', { harness: 'codex', model: 'x-1', effort: 'low' });
    expect(f.value).toBe('quick FIX');
    expect(m.row('id-1').querySelector<HTMLElement>('.tl-name-error')!.hidden).toBe(true);
    m.type('id-2', '');
    m.key(f, 'Enter');
    expect(err.textContent).toMatch(/needs a name/);
    m.type('id-2', 'x'.repeat(41));
    m.key(f, 'Enter');
    expect(err.textContent).toMatch(/40 characters/);
    expect(m.key(f, 'Escape').defaultPrevented).toBe(true);
    expect(f.value).toBe('Docs');
    expect(err.hidden).toBe(true);
    expect(f.getAttribute('aria-invalid')).toBe('false');
    // Nothing typed: Esc is the dialog's.
    expect(m.key(f, 'Escape').defaultPrevented).toBe(false);
    expect(m.levels.get('id-2')?.name).toBe('Docs');
  });

  it('moves a level up and down; the ends are off, and the focus stays on the button', () => {
    const m = mount(CAT, ['A', 'B', 'C']);
    expect(m.button('tl-id-1-up').getAttribute('aria-disabled')).toBe('true');
    expect(m.button('tl-id-3-down').getAttribute('aria-disabled')).toBe('true');
    expect(m.button('tl-id-2-up').getAttribute('aria-disabled')).toBeNull();
    const up = m.button('tl-id-3-up');
    up.focus();
    up.click();
    expect(m.names()).toEqual(['A', 'C', 'B']);
    expect(document.activeElement).toBe(up);
    up.click();
    expect(m.names()).toEqual(['C', 'A', 'B']);
    expect(up.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(up);
    // At the end it does nothing.
    up.click();
    expect(m.names()).toEqual(['C', 'A', 'B']);
    m.button('tl-id-1-down').click();
    expect(m.names()).toEqual(['C', 'B', 'A']);
    expect(m.levels.list().map((l) => l.name)).toEqual(['C', 'B', 'A']);
  });

  it('marks one level the default; with none marked the first shows as the default', () => {
    const m = mount(CAT, ['A', 'B', 'C']);
    const checked = () => [...m.body.querySelectorAll<HTMLInputElement>('.tl-default input')].map((i) => i.checked);
    expect(checked()).toEqual([true, false, false]);
    expect(m.levels.defaultMark).toBeNull();
    m.input('tl-id-3-default')!.click();
    expect(m.levels.defaultMark).toBe('id-3');
    expect(checked()).toEqual([false, false, true]);
    m.input('tl-id-2-default')!.click();
    expect(checked()).toEqual([false, true, false]);
    // One group: arrow keys move the mark like any radio group.
    const radios = [...m.body.querySelectorAll<HTMLInputElement>('.tl-default input')];
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
  });

  it('removes a level at once; the focus goes to the next name, else the previous one, else Add level', () => {
    const m = mount(CAT, ['A', 'B', 'C']);
    m.input('tl-id-2-default')!.click();
    m.button('tl-id-2-remove').click();
    expect(m.names()).toEqual(['A', 'C']);
    expect(document.activeElement).toBe(m.input('tl-id-3-name'));
    // The default went with it: the first is the default again.
    expect(m.input('tl-id-1-default')!.checked).toBe(true);
    m.button('tl-id-3-remove').click();
    expect(document.activeElement).toBe(m.input('tl-id-1-name'));
    m.button('tl-id-1-remove').click();
    expect(document.activeElement).toBe(m.button('tl-add'));
    expect(m.levels.list()).toEqual([]);
  });

  it('sets a level by its harness, then model and effort, with per-model efforts and readable names; rows stay apart', () => {
    const m = mount(CAT, ['Quick fix', 'Docs']);
    m.input('tl-id-1-harness:codex')!.click();
    expect(m.levels.get('id-1')).toMatchObject({ harness: 'codex', model: 'x-1', effort: 'high' });
    expect(m.levels.get('id-2')).toMatchObject({ harness: '', model: '', effort: '' });
    m.input('tl-id-1-model:x-2')!.click();
    expect([...m.row('id-1').querySelectorAll<HTMLInputElement>('[data-pick="tl-id-1-effort"] input')].map((i) => i.value)).toEqual(['low', 'high', 'ultra']);
    m.input('tl-id-1-effort:ultra')!.click();
    expect(m.levels.get('id-1')).toMatchObject({ harness: 'codex', model: 'x-2', effort: 'ultra' });
    expect(m.row('id-1').querySelector('.settings-badge')!.textContent).toBe('Set');
    m.input('tl-id-2-harness:claude')!.click();
    expect(m.row('id-2').textContent).toContain('Why One');
    expect(m.levels.get('id-2')).toMatchObject({ harness: 'claude', model: 'y-1', effort: 'high' });
    expect(m.levels.get('id-1')).toMatchObject({ harness: 'codex', model: 'x-2', effort: 'ultra' });
  });

  it('a chip pick keeps the focus on the picked chip of the redrawn group', () => {
    const m = mount(CAT, ['Quick fix']);
    const chip = m.input('tl-id-1-harness:codex')!;
    chip.focus();
    chip.click();
    expect(document.activeElement).toBe(m.input('tl-id-1-harness:codex'));
  });

  it('changes the effort alone, and a model that lacks it falls back', () => {
    const m = mount(CAT, ['Quick fix']);
    m.levels.set('id-1', { harness: 'codex', model: 'x-2', effort: 'ultra' });
    m.input('tl-id-1-effort:low')!.click();
    expect(m.levels.get('id-1')).toMatchObject({ harness: 'codex', model: 'x-2', effort: 'low' });
    m.levels.set('id-1', { harness: 'codex', model: 'x-2', effort: 'ultra' });
    m.input('tl-id-1-model:x-3')!.click();
    expect(m.levels.get('id-1')).toMatchObject({ harness: 'codex', model: 'x-3', effort: 'high' });
  });

  it('clears a level: it stays, with its name, not set', () => {
    const m = mount(CAT, ['Quick fix']);
    m.levels.set('id-1', { harness: 'claude', model: 'y-2', effort: 'high' });
    const clear = m.button('tl-id-1-clear');
    expect(clear.getAttribute('aria-disabled')).toBeNull();
    clear.focus();
    clear.click();
    expect(m.levels.get('id-1')).toEqual({ id: 'id-1', name: 'Quick fix', harness: '', model: '', effort: '' });
    expect(m.row('id-1').querySelector('.settings-badge')!.textContent).toBe('Not set');
    expect(clear.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(clear);
  });

  it('offers only shown models, and a level whose model is hidden or gone shows its slug with a warning', () => {
    const m = mount(CAT, ['Quick fix', 'Old']);
    m.prefs.setShown('codex', 'x-2', false);
    m.levels.set('id-1', { harness: 'codex', model: 'x-2', effort: 'ultra' });
    expect(m.input('tl-id-1-model:x-2')).toBeNull();
    const warn = m.row('id-1').querySelector('.tl-stale')!;
    expect(warn.querySelector('code')!.textContent).toBe('x-2');
    expect(warn.textContent).toMatch(/hidden in Settings → Harness models/);
    expect(m.row('id-1').querySelector('.settings-badge')!.textContent).toBe('Can’t be used');
    // Kept as it is: the model comes back when it is shown again.
    expect(m.levels.get('id-1')).toMatchObject({ harness: 'codex', model: 'x-2', effort: 'ultra' });
    m.prefs.setShown('codex', 'x-2', true);
    expect(m.row('id-1').querySelector('.tl-stale')).toBeNull();

    m.levels.set('id-2', { harness: 'claude', model: 'gone-1', effort: 'low' });
    expect(m.row('id-2').querySelector('.tl-stale code')!.textContent).toBe('gone-1');
    expect(m.row('id-2').querySelector('.tl-stale')!.textContent).toMatch(/does not offer gone-1/);
  });

  it('follows the catalog when Settings opens again', () => {
    const m = mount({}, ['Quick fix']);
    expect(m.body.querySelector<HTMLElement>('.settings-status')!.hidden).toBe(false);
    m.setCatalog(CAT);
    m.handle.open?.();
    expect(m.body.querySelector<HTMLElement>('.settings-status')!.hidden).toBe(true);
    expect(m.input('tl-id-1-harness:codex')).not.toBeNull();
  });

  it('a harness with every model hidden cannot be set, and says why', () => {
    const m = mount(CAT, ['Quick fix']);
    for (const x of CAT.claude!.models) m.prefs.setShown('claude', x, false);
    m.input('tl-id-1-harness:claude')!.click();
    expect(m.levels.get('id-1')).toMatchObject({ harness: '', model: '', effort: '' });
    expect(m.row('id-1').textContent).toMatch(/Every Claude Code model is hidden/);
  });
});
