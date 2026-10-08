// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { HireOptions } from '../net/protocol';
import { HireModelPrefs } from './hireModelPrefs';
import { harnessModelsSection } from './harnessModelsSection';

// #194: Settings → Harness models. Fixture slugs only.

const CAT: HireOptions = {
  codex: { models: ['x-1', 'x-2', 'x-3'], efforts: ['high'] },
  claude: { models: ['y-1', 'y-2'], efforts: ['high'] },
};

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

function mount(cat: HireOptions = CAT, prefs = new HireModelPrefs(memory())) {
  document.body.replaceChildren();
  let catalog = cat;
  const body = document.createElement('div');
  document.body.append(body);
  const handle = harnessModelsSection({ prefs, options: () => catalog })(body);
  handle.open?.();
  const groups = () => [...body.querySelectorAll<HTMLElement>('.hm-group')];
  const group = (harness: string) => groups()[harness === 'codex' ? 0 : 1]!;
  const rows = (g: HTMLElement) => [...g.querySelectorAll<HTMLElement>('.hm-list > li')];
  const box = (g: HTMLElement, slug: string) => rows(g).find((r) => r.querySelector('code')?.textContent === slug)!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const count = (g: HTMLElement) => g.querySelector('.settings-badge')!.textContent;
  const showAll = (g: HTMLElement) => [...g.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Show all')!;
  const search = (g: HTMLElement) => g.querySelector<HTMLInputElement>('input[type="search"]')!;
  const type = (el: HTMLInputElement, v: string) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const toggle = (el: HTMLInputElement, on: boolean) => {
    el.checked = on;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  return {
    body,
    prefs,
    handle,
    groups,
    group,
    rows,
    box,
    count,
    showAll,
    search,
    type,
    toggle,
    setCatalog: (c: HireOptions) => (catalog = c),
    stale: (g: HTMLElement) => g.querySelector<HTMLElement>('.hm-stale')!,
  };
}

describe('Settings → Harness models (#194)', () => {
  it('lists every catalog model per harness, all shown with no preference, with the exact slug and the Show switch', () => {
    const m = mount();
    expect(m.groups().map((g) => g.querySelector('h4')!.textContent)).toEqual(['Codex', 'Claude Code']);
    const codex = m.group('codex');
    expect(m.rows(codex).map((r) => r.querySelector('code')!.textContent)).toEqual(['x-1', 'x-2', 'x-3']);
    expect(m.rows(codex).every((r) => r.textContent!.includes('Show'))).toBe(true);
    expect(m.rows(codex).every((r) => (r.querySelector('input') as HTMLInputElement).checked)).toBe(true);
    expect(m.count(codex)).toBe('3 of 3 shown');
    expect(m.showAll(codex).disabled).toBe(true);
  });

  it('hides and restores one model with its switch, per harness, and keeps it listed', () => {
    const m = mount();
    const codex = m.group('codex');
    m.toggle(m.box(codex, 'x-2'), false);
    expect(m.prefs.isShown('codex', 'x-2')).toBe(false);
    expect(m.box(codex, 'x-2').checked).toBe(false);
    expect(m.rows(codex).length).toBe(3);
    expect(m.count(codex)).toBe('2 of 3 shown');
    expect(m.showAll(codex).disabled).toBe(false);
    expect(m.prefs.isShown('claude', 'y-1')).toBe(true);
    m.toggle(m.box(codex, 'x-2'), true);
    expect(m.count(codex)).toBe('3 of 3 shown');
  });

  it('Show all restores the harness only', () => {
    const m = mount();
    const codex = m.group('codex');
    const claude = m.group('claude');
    m.toggle(m.box(codex, 'x-1'), false);
    m.toggle(m.box(codex, 'x-3'), false);
    m.toggle(m.box(claude, 'y-2'), false);
    m.showAll(codex).click();
    expect(m.count(codex)).toBe('3 of 3 shown');
    expect(m.showAll(codex).disabled).toBe(true);
    expect(m.count(claude)).toBe('1 of 2 shown');
  });

  it('search narrows the list and the rows the switches act on; Esc clears it before anything else', () => {
    const m = mount();
    const codex = m.group('codex');
    m.type(m.search(codex), 'X-2');
    expect(m.rows(codex).map((r) => r.hidden)).toEqual([true, false, true]);
    expect(codex.querySelector<HTMLElement>('.hm-none')!.hidden).toBe(true);
    m.type(m.search(codex), 'zzz');
    expect(codex.querySelector<HTMLElement>('.hm-none')!.textContent).toContain('No model matches');
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    m.search(codex).dispatchEvent(esc);
    expect(m.search(codex).value).toBe('');
    expect(m.rows(codex).every((r) => !r.hidden)).toBe(true);
    expect(codex.querySelector<HTMLElement>('.hm-none')!.hidden).toBe(true);
    expect(esc.defaultPrevented).toBe(true);
  });

  it('a hidden slug the bridge no longer lists sits under Not currently available, and Clear makes it shown', () => {
    const prefs = new HireModelPrefs(memory());
    prefs.setShown('codex', 'gone-1', false);
    const m = mount(CAT, prefs);
    const codex = m.group('codex');
    expect(m.stale(codex).hidden).toBe(false);
    expect(m.stale(codex).textContent).toContain('Not currently available');
    expect(m.stale(codex).textContent).toContain('gone-1');
    expect(m.count(codex)).toBe('3 of 3 shown');
    m.stale(codex).querySelector<HTMLButtonElement>('button')!.click();
    expect(prefs.isShown('codex', 'gone-1')).toBe(true);
    expect(m.stale(codex).hidden).toBe(true);
    expect(m.showAll(codex).disabled).toBe(true);
  });

  it('a stale hidden slug that comes back is still hidden, and is not listed as unavailable', () => {
    const prefs = new HireModelPrefs(memory());
    prefs.setShown('codex', 'x-9', false);
    const m = mount(CAT, prefs);
    m.setCatalog({ ...CAT, codex: { ...CAT.codex!, models: [...CAT.codex!.models, 'x-9'] } });
    m.handle.open?.();
    const codex = m.group('codex');
    expect(m.rows(codex).length).toBe(4);
    expect(m.box(codex, 'x-9').checked).toBe(false);
    expect(m.stale(codex).hidden).toBe(true);
    expect(m.count(codex)).toBe('3 of 4 shown');
  });

  it('a model the bridge discovers is listed and shown; the list follows the catalog when the dialog opens', () => {
    const m = mount();
    m.setCatalog({ ...CAT, claude: { ...CAT.claude!, models: ['y-1', 'y-2', 'y-3'] } });
    m.handle.open?.();
    const claude = m.group('claude');
    expect(m.rows(claude).length).toBe(3);
    expect(m.box(claude, 'y-3').checked).toBe(true);
  });

  it('an empty catalog says the bridge has listed no models', () => {
    const m = mount({});
    expect(m.body.textContent).toContain('has not listed any models yet');
  });

  it('a change made elsewhere (the Hire dialog, another control) moves the switches and the counts while the section is open', () => {
    const m = mount();
    const codex = m.group('codex');
    m.prefs.setShown('codex', 'x-1', false);
    expect(m.box(codex, 'x-1').checked).toBe(false);
    expect(m.count(codex)).toBe('2 of 3 shown');
    expect(m.showAll(codex).disabled).toBe(false);
  });
});

// #200: the same readable names as Hire, with the exact slug kept beside them.

describe('Settings → Harness models: readable names (#200)', () => {
  const NAMED: HireOptions = {
    codex: { models: ['gpt-6.1-sol', 'twin-a', 'twin-b'], efforts: ['high'], model_labels: { 'gpt-6.1-sol': 'GPT-6.1-Sol', 'twin-a': '<b>Twin</b>', 'twin-b': '<b>Twin</b>' } },
    claude: { models: ['claude-opus-5', 'claude-opus-5-5', 'claude-lab'], efforts: ['high'], model_labels: { 'claude-opus-5': 'Opus 5' } },
  };
  const names = (g: HTMLElement) => [...g.querySelectorAll('.hm-list > li')].map((r) => [r.querySelector('.hm-name')?.textContent ?? null, r.querySelector('code')!.textContent]);

  it('shows the readable name over the exact slug; a slug with no name of its own stands alone', () => {
    const m = mount(NAMED);
    expect(names(m.group('claude'))).toEqual([
      ['Opus 5', 'claude-opus-5'],
      ['Opus 5.5', 'claude-opus-5-5'],
      [null, 'claude-lab'],
    ]);
    expect(names(m.group('codex'))[0]).toEqual(['GPT 6.1 Sol', 'gpt-6.1-sol']);
  });

  it('renders labels as text, and tells two rows with the same name apart by their slugs', () => {
    const m = mount(NAMED);
    const codex = m.group('codex');
    expect(codex.querySelector('.hm-list b')).toBeNull();
    expect(names(codex).slice(1)).toEqual([
      ['<b>Twin</b>', 'twin-a'],
      ['<b>Twin</b>', 'twin-b'],
    ]);
  });

  it('the filter takes the readable name (spaces included) or the exact slug, and the switch still acts on the slug', () => {
    const m = mount(NAMED);
    const claude = m.group('claude');
    m.type(m.search(claude), 'opus 5.5');
    expect(m.rows(claude).map((r) => r.hidden)).toEqual([true, false, true]);
    m.type(m.search(claude), 'CLAUDE-OPUS-5');
    expect(m.rows(claude).map((r) => r.hidden)).toEqual([false, false, true]);
    m.type(m.search(claude), 'opus 5');
    m.toggle(m.box(claude, 'claude-opus-5-5'), false);
    expect([...m.prefs.hidden('claude')]).toEqual(['claude-opus-5-5']);
    m.type(m.search(m.group('codex')), 'gpt 6.1');
    expect(m.rows(m.group('codex')).map((r) => r.hidden)).toEqual([false, true, true]);
  });

  it('a hidden slug the bridge no longer lists keeps a readable fallback and its exact id', () => {
    const prefs = new HireModelPrefs(memory());
    prefs.setShown('claude', 'claude-fable-5-1', false);
    prefs.setShown('claude', 'claude-old-thing', false);
    const m = mount(NAMED, prefs);
    const stale = m.stale(m.group('claude'));
    const rows = [...stale.querySelectorAll('.hm-row')].map((r) => [r.querySelector('.hm-name')?.textContent ?? null, r.querySelector('code')!.textContent]);
    expect(rows).toEqual([
      ['Fable 5.1', 'claude-fable-5-1'],
      [null, 'claude-old-thing'],
    ]);
  });

  it('without labels the catalog still reads: formatted Claude slugs, other ids as they are', () => {
    const m = mount({ claude: { models: ['claude-opus-5', 'sonnet'], efforts: ['high'] } });
    expect(names(m.groups()[0]!)).toEqual([
      ['Opus 5', 'claude-opus-5'],
      [null, 'sonnet'],
    ]);
  });
});
