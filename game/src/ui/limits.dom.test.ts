// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LimitBook } from '../world/limits';
import { CornerWatch } from './corner';
import { LimitsWidget } from './limits';
import { LimitsPrefs } from './limitsPrefs';

// #147: the command palette is a screen for the plan-limits plate: it steps out into the edge tab over any view, the tab lives in the
// palette (the topmost modal, so its inertness cannot reach it), and the plate is what the prefs say once the palette closes.

const NOW = Date.UTC(2026, 9, 5, 12, 0);
const WIDTH = 1280;

beforeEach(() => {
  Object.defineProperty(document.documentElement, 'clientWidth', { value: WIDTH, configurable: true });
  // jsdom has no layout: a dialog's `right` is what the test says it is (default: the palette's, 640 px centred).
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const right = Number((this as HTMLElement).dataset?.right ?? 0);
    return { left: 0, top: 0, right, bottom: 0, width: right, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  localStorage.clear();
});

/** A dialog the way jsdom can have it: `open` is all the game's code looks at. */
function dialog(cls: string, right: number): HTMLDialogElement {
  const d = document.createElement('dialog');
  d.className = cls;
  d.dataset.right = String(right);
  document.body.append(d);
  return d;
}
const openIt = (d: HTMLDialogElement) => d.setAttribute('open', '');
const closeIt = (d: HTMLDialogElement) => d.removeAttribute('open');
/** The MutationObserver's microtask. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
/** The palette: 640 px, centred in the viewport. */
const PAL_RIGHT = (WIDTH + 640) / 2;

function widget() {
  const book = new LimitBook();
  book.upsert({ provider: 'claude', plan: 'team', windows: [{ label: '5h', pct: 73, resets_at: NOW + 3600_000, window_mins: 300 }], at: NOW, stale: false, source: 'probe' });
  const parent = document.createElement('div');
  document.body.append(parent);
  const prefs = new LimitsPrefs();
  const w = new LimitsWidget(parent, book, { now: () => NOW, refresh: async () => ({ ok: true }) as never, toast: () => undefined }, prefs);
  return { w, parent, prefs };
}

describe('CornerWatch with the command palette (#147)', () => {
  it('counts an open palette as a screen, and its own change as one', async () => {
    const changed = vi.fn();
    const corner = new CornerWatch(changed);
    const pal = dialog('credits palette', PAL_RIGHT);
    expect(corner.screen).toBe(false);
    openIt(pal);
    await settle();
    expect(corner.screen).toBe(true);
    expect(corner.topScreen()).toBe(pal);
    expect(changed).toHaveBeenLastCalledWith(true);
    closeIt(pal);
    await settle();
    expect(corner.screen).toBe(false);
    expect(corner.topScreen()).toBeNull();
    corner.dispose();
  });

  it('the palette is the topmost screen over a dialog that opened before it, whatever their order in the document', async () => {
    const corner = new CornerWatch(() => undefined);
    const pal = dialog('credits palette', PAL_RIGHT);
    const hire = dialog('desk-dlg desk-dlg--hire', WIDTH - 16);
    openIt(hire);
    await settle();
    openIt(pal);
    await settle();
    expect(corner.topScreen()).toBe(pal);
    closeIt(pal);
    await settle();
    expect(corner.topScreen()).toBe(hire);
    corner.dispose();
  });

  it('a dialog that opens after the palette is the topmost screen; the palette is again when it closes', async () => {
    const corner = new CornerWatch(() => undefined);
    const hire = dialog('desk-dlg desk-dlg--hire', WIDTH - 16);
    const pal = dialog('credits palette', PAL_RIGHT);
    const keys = dialog('shortcuts', 520);
    openIt(hire);
    openIt(pal);
    await settle();
    openIt(keys);
    await settle();
    expect(corner.topScreen()).toBe(keys);
    expect(corner.clearOf()).toEqual([pal, keys]); // the sheet under the palette is not one to clear
    closeIt(keys);
    await settle();
    expect(corner.topScreen()).toBe(pal);
    openIt(keys); // and a dialog that opens again is above it again
    await settle();
    expect(corner.topScreen()).toBe(keys);
    corner.dispose();
  });

  it('is folded on a narrow viewport, palette or not', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    const corner = new CornerWatch(() => undefined);
    openIt(dialog('credits palette', 300));
    expect(corner.folded).toBe(true);
    corner.dispose();
  });
});

describe('the plan-limits plate over the command palette (#147)', () => {
  it('is its edge tab, inside the palette, and the saved state is back when it closes', async () => {
    const { w, parent, prefs } = widget();
    expect(w.root.dataset.dock).toBe('');
    expect(prefs.open).toBe(false);
    const pal = dialog('credits palette', PAL_RIGHT);
    openIt(pal);
    await settle();
    expect(w.root.dataset.dock).toBe('tab');
    expect(w.root.dataset.fit).toBe('full');
    expect(w.root.parentElement).toBe(pal); // in the topmost modal: its inertness does not reach it
    expect(w.isOpen).toBe(false);
    closeIt(pal);
    await settle();
    expect(w.root.dataset.dock).toBe('');
    expect(w.root.parentElement).toBe(parent);
    expect(prefs.open).toBe(false); // nothing saved changed
    w.dispose();
  });

  it('is the tab even over a hire sheet that leaves no gutter of its own, in the palette', async () => {
    const { w } = widget();
    const hire = dialog('desk-dlg desk-dlg--hire', WIDTH - 16);
    openIt(hire);
    await settle();
    expect(w.root.dataset.dock).toBe('away'); // (by itself the sheet leaves no room)
    expect(w.root.parentElement).toBe(hire);
    const pal = dialog('credits palette', PAL_RIGHT);
    openIt(pal);
    await settle();
    expect(w.root.dataset.dock).toBe('tab');
    expect(w.root.parentElement).toBe(pal);
    closeIt(pal);
    await settle();
    expect(w.root.dataset.dock).toBe('away'); // back to the sheet's
    expect(w.root.parentElement).toBe(hire);
    w.dispose();
  });

  it('measures the palette: a thin gutter is the snug tab, none is away', async () => {
    const { w } = widget();
    const pal = dialog('credits palette', WIDTH - 30);
    openIt(pal);
    await settle();
    expect([w.root.dataset.dock, w.root.dataset.fit]).toEqual(['tab', 'snug']);
    pal.dataset.right = String(WIDTH - 10);
    window.dispatchEvent(new Event('resize'));
    expect(w.root.dataset.dock).toBe('away');
    w.dispose();
  });

  it('#216: the Ubuntu UI theme’s snug tab is 32 px and needs 34 px of room; a live switch places it again', async () => {
    const { w } = widget();
    const pal = dialog('credits palette', WIDTH - 30);
    openIt(pal);
    await settle();
    expect([w.root.dataset.dock, w.root.dataset.fit]).toEqual(['tab', 'snug']);
    document.documentElement.dataset.uiTheme = 'ubuntu';
    await settle();
    expect(w.root.dataset.dock).toBe('away'); // 30 px is room for Quiet's 22 px tab, not for Ubuntu's 32
    pal.dataset.right = String(WIDTH - 34);
    window.dispatchEvent(new Event('resize'));
    expect([w.root.dataset.dock, w.root.dataset.fit]).toEqual(['tab', 'snug']);
    delete document.documentElement.dataset.uiTheme;
    await settle();
    expect([w.root.dataset.dock, w.root.dataset.fit]).toEqual(['tab', 'snug']);
    w.dispose();
  });

  it('a click on the tab peeks the plate over the palette; closing the palette ends the peek and gives the saved plate back', async () => {
    const { w, prefs } = widget();
    const pal = dialog('credits palette', PAL_RIGHT);
    openIt(pal);
    await settle();
    w.root.querySelector<HTMLButtonElement>('.lm-tab')?.click();
    expect(w.root.dataset.peek).toBe('true');
    expect(w.isOpen).toBe(true);
    expect(w.root.dataset.dock).toBe('');
    expect(prefs.open).toBe(false);
    closeIt(pal);
    await settle();
    expect(w.root.dataset.peek).toBe('false');
    expect(w.isOpen).toBe(false);
    expect(w.root.dataset.dock).toBe('');
    w.dispose();
  });

  it('keeps an open saved plate open after the palette closes', async () => {
    const { w, prefs } = widget();
    prefs.open = true;
    w.update();
    expect(w.isOpen).toBe(true);
    const pal = dialog('credits palette', PAL_RIGHT);
    openIt(pal);
    await settle();
    expect(w.isOpen).toBe(false);
    expect(w.root.dataset.dock).toBe('tab');
    closeIt(pal);
    await settle();
    expect(w.isOpen).toBe(true);
    expect(w.root.dataset.dock).toBe('');
    w.dispose();
  });

  it('a peek started over a hire sheet ends when the palette opens on top of it', async () => {
    const { w } = widget();
    const hire = dialog('desk-dlg desk-dlg--board', 800);
    openIt(hire);
    await settle();
    w.root.querySelector<HTMLButtonElement>('.lm-tab')?.click();
    expect(w.root.dataset.peek).toBe('true');
    const pal = dialog('credits palette', PAL_RIGHT);
    openIt(pal);
    await settle();
    expect(w.root.dataset.peek).toBe('false');
    expect(w.root.dataset.dock).toBe('tab');
    w.dispose();
  });

  it('a modal opened after the palette hosts the plate; a click on the tab there peeks, and closing it gives the plate back to the palette', async () => {
    const { w, prefs } = widget();
    const pal = dialog('credits palette', PAL_RIGHT);
    const keys = dialog('shortcuts', 520);
    openIt(pal);
    await settle();
    expect(w.root.parentElement).toBe(pal);
    openIt(keys);
    await settle();
    expect(w.root.parentElement).toBe(keys); // the palette is inert now: the tab must live in the dialog that took its place
    expect(w.root.dataset.dock).toBe('tab');
    w.root.querySelector<HTMLButtonElement>('.lm-tab')?.click();
    expect(w.root.dataset.peek).toBe('true');
    expect(w.isOpen).toBe(true);
    closeIt(keys);
    await settle();
    expect(w.root.parentElement).toBe(pal);
    expect(w.root.dataset.peek).toBe('false'); // the peek was over the shortcut list
    expect(w.root.dataset.dock).toBe('tab');
    expect(prefs.open).toBe(false);
    closeIt(pal);
    await settle();
    expect(w.root.dataset.dock).toBe('');
    w.dispose();
  });

  it('measures the dialogs over the palette, not the ones under it', async () => {
    const { w } = widget();
    const hire = dialog('desk-dlg desk-dlg--hire', WIDTH - 16);
    const pal = dialog('credits palette', PAL_RIGHT);
    const keys = dialog('shortcuts', WIDTH - 30);
    openIt(hire);
    openIt(pal);
    await settle();
    expect([w.root.dataset.dock, w.root.dataset.fit]).toEqual(['tab', 'full']);
    openIt(keys);
    await settle();
    expect([w.root.dataset.dock, w.root.dataset.fit]).toEqual(['tab', 'snug']);
    w.dispose();
  });
});
