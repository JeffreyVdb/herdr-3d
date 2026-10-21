// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deskTabs, type DeskTab } from './deskTabs';

// Pinned hire presets in the desk dialogs' tab bar: after the fixed tabs, in pin order, picked like any tab, and moved
// with Shift+← / Shift+→ (focus stays on the moved tab).

const PINS = [
  { id: 'a', name: 'Deploy', title: 'Deploy · Codex · x-1 · low' },
  { id: 'b', name: 'Review', title: 'Review · Codex · x-1 · low' },
];
const THREE = [...PINS, { id: 'c', name: 'Triage', title: 'Triage · Codex · x-1 · low' }];
const drag = (el: Element, type: string, clientX = 0) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }));

const keys = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[role="tab"]')].map((t) => t.dataset.key);
const key = (el: HTMLElement, k: string, shift = false) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true }));

afterEach(() => document.body.replaceChildren());

describe('desk tabs with pinned presets', () => {
  it('show the pins after the fixed tabs, named, with the preset’s choice as the tooltip', () => {
    const el = deskTabs('worker', vi.fn(), null, true, { list: PINS });
    expect(keys(el)).toEqual(['tab:worker', 'tab:orch', 'tab:preset', 'tab:pin:a', 'tab:pin:b']);
    const a = el.querySelector<HTMLElement>('[data-key="tab:pin:a"]')!;
    expect(a.textContent).toBe('Deploy');
    expect(a.title).toBe('Deploy · Codex · x-1 · low');
    expect(a.getAttribute('aria-selected')).toBe('false');
  });

  it('show no pins without the preset tab (a bridge without hire presets)', () => {
    expect(keys(deskTabs('worker', vi.fn(), false, false, { list: PINS }))).toEqual(['tab:worker']);
  });

  it('pick a pin by click, and mark the one a form came from as selected', () => {
    const pick = vi.fn<(t: DeskTab) => void>();
    const el = deskTabs('pin:b', pick, null, true, { list: PINS });
    expect(el.querySelector('[data-key="tab:pin:b"]')?.getAttribute('aria-selected')).toBe('true');
    el.querySelector<HTMLElement>('[data-key="tab:pin:b"]')!.click();
    expect(pick).not.toHaveBeenCalled();
    el.querySelector<HTMLElement>('[data-key="tab:pin:a"]')!.click();
    expect(pick).toHaveBeenCalledWith('pin:a');
  });

  it('reach the pins with the arrow keys, wrapping round', () => {
    const pick = vi.fn<(t: DeskTab) => void>();
    const el = deskTabs('pin:b', pick, 'busy', true, { list: PINS });
    key(el, 'ArrowRight');
    expect(pick).toHaveBeenLastCalledWith('worker');
    key(el, 'ArrowLeft');
    expect(pick).toHaveBeenLastCalledWith('pin:a');
  });

  it('move the focused pin with Shift+← / Shift+→ and keep focus on it', () => {
    const dlg = document.createElement('dialog');
    document.body.append(dlg);
    let list = [...PINS];
    const render = () => dlg.replaceChildren(deskTabs('worker', vi.fn(), null, true, { list, move }));
    const move = vi.fn((id: string, to: number) => {
      const p = list.find((x) => x.id === id)!;
      list = list.filter((x) => x !== p);
      list.splice(to, 0, p);
      render();
    });
    render();
    const a = dlg.querySelector<HTMLElement>('[data-key="tab:pin:a"]')!;
    a.focus();
    key(a, 'ArrowRight', true);
    expect(move).toHaveBeenCalledWith('a', 1);
    // Past the end: asked, refused by the pins (the fake leaves the list alone at an out-of-range place).
    key(dlg.querySelector<HTMLElement>('[data-key="tab:pin:a"]')!, 'ArrowLeft', true);
    expect(move).toHaveBeenLastCalledWith('a', 0);
    key(dlg.querySelector<HTMLElement>('[data-key="tab:pin:a"]')!, 'ArrowRight', true);
    expect(keys(dlg.firstElementChild as HTMLElement).slice(3)).toEqual(['tab:pin:b', 'tab:pin:a']);
    expect((document.activeElement as HTMLElement).dataset.key).toBe('tab:pin:a');
  });

  it('move nothing with Shift+arrows on a fixed tab, and leave Alt+arrows (the browser’s Back) alone', () => {
    const move = vi.fn();
    const pick = vi.fn();
    const el = deskTabs('worker', pick, null, true, { list: PINS, move });
    document.body.append(el);
    const w = el.querySelector<HTMLElement>('[data-key="tab:worker"]')!;
    w.focus();
    key(w, 'ArrowRight', true);
    const a = el.querySelector<HTMLElement>('[data-key="tab:pin:a"]')!;
    a.focus();
    const alt = new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true });
    a.dispatchEvent(alt);
    expect(alt.defaultPrevented).toBe(false);
    expect(move).not.toHaveBeenCalled();
    expect(pick).not.toHaveBeenCalled();
  });

  it('drag a pin before or after another (by the pointer’s side of its middle), never onto a fixed tab', () => {
    const move = vi.fn();
    const el = deskTabs('worker', vi.fn(), null, true, { list: THREE, move });
    document.body.append(el);
    const t = (id: string) => el.querySelector<HTMLElement>(`[data-key="tab:${id}"]`)!;
    expect(t('pin:a').draggable).toBe(true);
    expect(t('worker').draggable).toBe(false);
    // jsdom's tabs have no size: a pointer left of 0 is the tab's first half, right of it the second.
    drag(t('pin:a'), 'dragstart');
    drag(t('pin:c'), 'dragover', 1);
    expect(t('pin:c').dataset.drop).toBe('after');
    drag(t('pin:c'), 'drop', 1);
    expect(move).toHaveBeenLastCalledWith('a', 2);
    expect(el.querySelector('[data-drop]')).toBeNull();
    drag(t('pin:c'), 'dragstart');
    drag(t('pin:b'), 'drop', -1);
    expect(move).toHaveBeenLastCalledWith('c', 1);
    drag(t('pin:b'), 'dragstart');
    const onFixed = new MouseEvent('dragover', { bubbles: true, cancelable: true });
    t('preset').dispatchEvent(onFixed);
    expect(onFixed.defaultPrevented).toBe(false);
    drag(t('preset'), 'drop');
    drag(t('pin:b'), 'drop', 1);
    expect(move).toHaveBeenCalledTimes(2);
  });
});
