// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HireOptions } from '../net/protocol';
import { HireModelPrefs } from './hireModelPrefs';
import { TaskLevels } from './taskLevels';
import { taskLevelsSection } from './taskLevelsSection';

// #248: Settings → Task levels. Fixture slugs only.

const CAT: HireOptions = {
  codex: { models: ['x-1', 'x-2', 'x-3'], efforts: ['low', 'high'], extra_efforts: { 'x-2': ['ultra'] } },
  claude: { models: ['y-1', 'y-2'], efforts: ['low', 'medium', 'high'], model_labels: { 'y-1': 'Why One' } },
};

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

function mount(cat: HireOptions = CAT) {
  document.body.replaceChildren();
  const prefs = new HireModelPrefs(memory());
  const levels = new TaskLevels(memory());
  let catalog = cat;
  const body = document.createElement('div');
  document.body.append(body);
  const handle = taskLevelsSection({ levels, prefs, options: () => catalog })(body);
  const row = (id: string) => body.querySelector<HTMLElement>(`.tl-level[data-level="${id}"]`)!;
  const input = (key: string) => body.querySelector<HTMLInputElement>(`[data-key="${key}"]`);
  return { body, prefs, levels, handle, row, input, setCatalog: (c: HireOptions) => (catalog = c) };
}

describe('Settings → Task levels (#248)', () => {
  beforeEach(() => vi.stubGlobal('CSS', { escape: (s: string) => s }));
  afterEach(() => vi.unstubAllGlobals());

  it('has one row per level, small to large, each unset with only the harness chips and Clear off', () => {
    const m = mount();
    expect([...m.body.querySelectorAll('.tl-level h4')].map((e) => e.textContent)).toEqual(['Very trivial', 'Trivial', 'Slightly complex']);
    const r = m.row('trivial');
    expect(r.querySelector('.settings-badge')!.textContent).toBe('Not set');
    expect(r.querySelector('[data-pick="tl-trivial-harness"]')).not.toBeNull();
    expect(r.querySelector('[data-pick="tl-trivial-model"]')).toBeNull();
    expect(r.querySelector<HTMLButtonElement>('[data-key="tl-trivial-clear"]')!.disabled).toBe(true);
  });

  it('sets a level by its harness, then model and effort, with per-model efforts and readable names; rows stay apart', () => {
    const m = mount();
    m.input('tl-trivial-harness:codex')!.click();
    expect(m.levels.get('trivial')).toEqual({ harness: 'codex', model: 'x-1', effort: 'high' });
    expect(m.levels.get('very_trivial')).toBeNull();
    m.input('tl-trivial-model:x-2')!.click();
    expect([...m.row('trivial').querySelectorAll<HTMLInputElement>('[data-pick="tl-trivial-effort"] input')].map((i) => i.value)).toEqual(['low', 'high', 'ultra']);
    m.input('tl-trivial-effort:ultra')!.click();
    expect(m.levels.get('trivial')).toEqual({ harness: 'codex', model: 'x-2', effort: 'ultra' });
    expect(m.row('trivial').querySelector('.settings-badge')!.textContent).toBe('Set');
    m.input('tl-very_trivial-harness:claude')!.click();
    expect(m.row('very_trivial').textContent).toContain('Why One');
    expect(m.levels.get('very_trivial')).toEqual({ harness: 'claude', model: 'y-1', effort: 'high' });
    expect(m.levels.get('trivial')).toEqual({ harness: 'codex', model: 'x-2', effort: 'ultra' });
  });

  it('changes the effort alone, and a model that lacks it falls back', () => {
    const m = mount();
    m.levels.set('trivial', { harness: 'codex', model: 'x-2', effort: 'ultra' });
    m.input('tl-trivial-effort:low')!.click();
    expect(m.levels.get('trivial')).toEqual({ harness: 'codex', model: 'x-2', effort: 'low' });
    m.levels.set('trivial', { harness: 'codex', model: 'x-2', effort: 'ultra' });
    m.input('tl-trivial-model:x-3')!.click();
    expect(m.levels.get('trivial')).toEqual({ harness: 'codex', model: 'x-3', effort: 'high' });
  });

  it('clears a level', () => {
    const m = mount();
    m.levels.set('slightly_complex', { harness: 'claude', model: 'y-2', effort: 'high' });
    m.row('slightly_complex').querySelector<HTMLButtonElement>('[data-key="tl-slightly_complex-clear"]')!.click();
    expect(m.levels.get('slightly_complex')).toBeNull();
    expect(m.row('slightly_complex').querySelector('.settings-badge')!.textContent).toBe('Not set');
  });

  it('offers only shown models, and a level whose model is hidden or gone shows its slug with a warning', () => {
    const m = mount();
    m.prefs.setShown('codex', 'x-2', false);
    m.levels.set('trivial', { harness: 'codex', model: 'x-2', effort: 'ultra' });
    expect(m.input('tl-trivial-model:x-2')).toBeNull();
    const warn = m.row('trivial').querySelector('.tl-stale')!;
    expect(warn.querySelector('code')!.textContent).toBe('x-2');
    expect(warn.textContent).toMatch(/hidden in Settings → Harness models/);
    expect(m.row('trivial').querySelector('.settings-badge')!.textContent).toBe('Can’t be used');
    // Kept as it is: the model comes back when it is shown again.
    expect(m.levels.get('trivial')).toEqual({ harness: 'codex', model: 'x-2', effort: 'ultra' });
    m.prefs.setShown('codex', 'x-2', true);
    expect(m.row('trivial').querySelector('.tl-stale')).toBeNull();

    m.levels.set('very_trivial', { harness: 'claude', model: 'gone-1', effort: 'low' });
    expect(m.row('very_trivial').querySelector('.tl-stale code')!.textContent).toBe('gone-1');
    expect(m.row('very_trivial').querySelector('.tl-stale')!.textContent).toMatch(/does not offer gone-1/);
  });

  it('follows the catalog when Settings opens again', () => {
    const m = mount({});
    expect(m.body.textContent).toContain('has not listed any models yet');
    m.setCatalog(CAT);
    m.handle.open?.();
    expect(m.input('tl-trivial-harness:codex')).not.toBeNull();
  });

  it('a harness with every model hidden cannot be set, and says why', () => {
    const m = mount();
    for (const x of CAT.claude!.models) m.prefs.setShown('claude', x, false);
    m.input('tl-trivial-harness:claude')!.click();
    expect(m.levels.get('trivial')).toBeNull();
    expect(m.row('trivial').textContent).toMatch(/Every Claude Code model is hidden/);
  });
});
