// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { backdropPolicy } from './dismiss';
import { modelList } from './hire';

function dialog(): { d: HTMLDialogElement; inner: HTMLTextAreaElement } {
  const d = document.createElement('dialog');
  const inner = document.createElement('textarea');
  d.append(inner);
  document.body.append(d);
  // jsdom has no layout: the dialog's box is 100..500 x 50..350.
  d.getBoundingClientRect = () => ({ left: 100, top: 50, right: 500, bottom: 350, width: 400, height: 300, x: 100, y: 50, toJSON: () => ({}) });
  return { d, inner };
}

const ptr = (type: string, target: Element, x: number, y: number, over: PointerEventInit = {}) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, ...over }));
const down = (target: Element, x: number, y: number, over: { button?: number } = {}) => {
  const e = new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: over.button ?? 0 });
  Object.defineProperty(e, 'isPrimary', { value: true });
  target.dispatchEvent(e);
};

describe('backdropPolicy', () => {
  it('none: the backdrop never closes it, even for a press and click both on it', () => {
    const { d } = dialog();
    const close = vi.fn(); // jsdom has no dialog.close
    d.close = close;
    backdropPolicy(d, 'none');
    expect(d.getAttribute('closedby')).toBe('closerequest');
    down(d, 20, 20);
    ptr('click', d, 20, 20);
    expect(close).not.toHaveBeenCalled();
  });

  it('sheet: closes for a press and a click that both began on the backdrop', () => {
    const { d } = dialog();
    const close = vi.fn();
    backdropPolicy(d, 'sheet', close);
    down(d, 20, 20);
    ptr('click', d, 20, 20);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('sheet: a press inside (a text selection) released on the backdrop does not close (#51)', () => {
    const { d, inner } = dialog();
    const close = vi.fn();
    backdropPolicy(d, 'sheet', close);
    down(inner, 200, 200);
    ptr('click', d, 20, 20); // the click's target is the common ancestor: the dialog
    expect(close).not.toHaveBeenCalled();
  });

  it('sheet: a click on the dialog’s own padding, or with no press before it, does not close', () => {
    const { d } = dialog();
    const close = vi.fn();
    backdropPolicy(d, 'sheet', close);
    down(d, 300, 60);
    ptr('click', d, 300, 60);
    ptr('click', d, 20, 20);
    expect(close).not.toHaveBeenCalled();
  });

  it('sheet: a right-button press or a cancelled pointer does not arm it', () => {
    const { d } = dialog();
    const close = vi.fn();
    backdropPolicy(d, 'sheet', close);
    down(d, 20, 20, { button: 2 });
    ptr('click', d, 20, 20);
    down(d, 20, 20);
    d.dispatchEvent(new Event('pointercancel'));
    ptr('click', d, 20, 20);
    expect(close).not.toHaveBeenCalled();
  });
});

describe('modelList', () => {
  const models = ['claude-opus-5-5', 'claude-lab-01', 'claude-lab-02', 'claude-lab-10', 'gpt-x'];
  const build = (value = 'claude-opus-5-5', query = '') => {
    const picked: string[] = [];
    const queries: string[] = [];
    const el = modelList(models, value, query, (v) => picked.push(v), (q) => queries.push(q));
    document.body.append(el);
    const shown = () => [...el.querySelectorAll<HTMLLabelElement>('.dd-chip')].filter((l) => !l.hidden).map((l) => l.textContent);
    const search = el.querySelector<HTMLInputElement>('[data-key="model-search"]')!;
    const type = (v: string) => {
      search.value = v;
      search.dispatchEvent(new Event('input', { bubbles: true }));
    };
    return { el, picked, queries, shown, search, type, count: () => el.querySelector('.dd-count')!.textContent };
  };

  it('lists every model with its count, the current one checked', () => {
    const m = build();
    expect(m.shown()).toEqual(models);
    expect(m.count()).toBe('5');
    expect(m.el.querySelector<HTMLInputElement>('[data-key="model:claude-opus-5-5"]')!.checked).toBe(true);
  });

  it('filters by substring, keeps the checked model visible, counts, and says when nothing matches', () => {
    const m = build();
    m.type('lab-0');
    expect(m.shown()).toEqual(['claude-opus-5-5', 'claude-lab-01', 'claude-lab-02']);
    expect(m.count()).toBe('2 of 5');
    expect(m.queries).toEqual(['lab-0']);
    m.type('zzz');
    expect(m.shown()).toEqual(['claude-opus-5-5']);
    expect(m.el.querySelector('.dd-none')!.textContent).toBe('No model matches “zzz”.');
    m.type('');
    expect(m.shown()).toEqual(models);
  });

  it('starts with the remembered filter', () => {
    const m = build('claude-opus-5-5', 'gpt');
    expect(m.shown()).toEqual(['claude-opus-5-5', 'gpt-x']);
    expect(m.search.value).toBe('gpt');
  });

  it('Enter in the filter does not submit the form; Esc clears a filter and stops there, an empty one passes', () => {
    const m = build();
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    m.search.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    m.type('lab');
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    m.search.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(m.search.value).toBe('');
    const esc2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    m.search.dispatchEvent(esc2);
    expect(esc2.defaultPrevented).toBe(false);
  });

  it('picking a chip reports the model', () => {
    const m = build();
    const r = m.el.querySelector<HTMLInputElement>('[data-key="model:gpt-x"]')!;
    r.checked = true;
    r.dispatchEvent(new Event('change', { bubbles: true }));
    expect(m.picked).toEqual(['gpt-x']);
  });
});
