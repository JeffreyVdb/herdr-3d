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
  it('lists every catalog model per harness, all shown with no preference, with the exact slug and the Show in Hire switch', () => {
    const m = mount();
    expect(m.groups().map((g) => g.querySelector('h4')!.textContent)).toEqual(['Codex', 'Claude Code']);
    const codex = m.group('codex');
    expect(m.rows(codex).map((r) => r.querySelector('code')!.textContent)).toEqual(['x-1', 'x-2', 'x-3']);
    expect(m.rows(codex).every((r) => r.textContent!.includes('Show in Hire'))).toBe(true);
    expect(m.rows(codex).every((r) => (r.querySelector('input') as HTMLInputElement).checked)).toBe(true);
    expect(m.count(codex)).toBe('3 of 3 shown in Hire');
    expect(m.showAll(codex).disabled).toBe(true);
  });

  it('hides and restores one model with its switch, per harness, and keeps it listed', () => {
    const m = mount();
    const codex = m.group('codex');
    m.toggle(m.box(codex, 'x-2'), false);
    expect(m.prefs.isShown('codex', 'x-2')).toBe(false);
    expect(m.box(codex, 'x-2').checked).toBe(false);
    expect(m.rows(codex).length).toBe(3);
    expect(m.count(codex)).toBe('2 of 3 shown in Hire');
    expect(m.showAll(codex).disabled).toBe(false);
    expect(m.prefs.isShown('claude', 'y-1')).toBe(true);
    m.toggle(m.box(codex, 'x-2'), true);
    expect(m.count(codex)).toBe('3 of 3 shown in Hire');
  });

  it('Show all restores the harness only', () => {
    const m = mount();
    const codex = m.group('codex');
    const claude = m.group('claude');
    m.toggle(m.box(codex, 'x-1'), false);
    m.toggle(m.box(codex, 'x-3'), false);
    m.toggle(m.box(claude, 'y-2'), false);
    m.showAll(codex).click();
    expect(m.count(codex)).toBe('3 of 3 shown in Hire');
    expect(m.showAll(codex).disabled).toBe(true);
    expect(m.count(claude)).toBe('1 of 2 shown in Hire');
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
    expect(m.count(codex)).toBe('3 of 3 shown in Hire');
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
    expect(m.count(codex)).toBe('3 of 4 shown in Hire');
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
    expect(m.count(codex)).toBe('2 of 3 shown in Hire');
    expect(m.showAll(codex).disabled).toBe(false);
  });
});
