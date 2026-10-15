// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scope } from '../input/shortcuts';
import { BridgeApi, BridgeBook, type BridgeEntry, type BridgeList } from '../net/bridges';
import { paletteCommands, type PaletteCommand } from '../world/palette';
import { WorldStore } from '../world/store';
import { Palette, type PaletteHost } from './palette';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});
afterEach(() => void (document.body.innerHTML = ''));

const entry = (id: string, name: string, state: string, active = false): BridgeEntry => ({ id, name, kind: 'ssh', host: `dev@${id}`, address: `dev@${id}`, active, state });
const list = (active: string, ...bridges: BridgeEntry[]): BridgeList => ({ active, bridges: bridges.map((b) => ({ ...b, active: b.id === active })) });

function setup(start: BridgeList) {
  let current = start;
  const fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(current) }));
  const book = new BridgeBook(new BridgeApi('t0k', fetch), 60_000);
  book.set(start);
  const switchTo = vi.fn<(b: BridgeEntry) => void>();
  const openSettings = vi.fn();
  const run = vi.fn<(c: PaletteCommand, f: string | null) => void>();
  const host: PaletteHost = {
    commands: () => paletteCommands(new Set<Scope>(['any', 'city']), false),
    store: new WorldStore(0),
    here: () => null,
    online: () => true,
    run,
    goTo: vi.fn(),
    bridges: { book, switchTo, openSettings },
  };
  const palette = new Palette(document.body, host);
  const dlg = document.querySelector('dialog.palette') as HTMLDialogElement;
  const input = dlg.querySelector('input') as HTMLInputElement;
  const rows = () => [...dlg.querySelectorAll<HTMLElement>('[role="option"]')];
  const names = () => rows().map((r) => r.querySelector('.pal-name')?.textContent);
  const dots = () => rows().map((r) => r.querySelector('.br-dot')?.getAttribute('data-tone'));
  const type = (text: string) => {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const press = (key: string) => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const openBridges = () => {
    palette.open();
    type('switch br');
    expect(names()[0]).toBe('Switch bridge');
    press('Enter');
  };
  return { palette, book, dlg, input, rows, names, dots, type, press, openBridges, switchTo, openSettings, run, fetch, setList: (l: BridgeList) => (current = l) };
}

describe('⌘P → Switch bridge (#57)', () => {
  const A = entry('aaaaaaaaaa', 'devbox', 'up');
  const B = entry('bbbbbbbbbb', 'zeta', 'up');
  const C = entry('cccccccccc', 'Alpha', 'backoff');
  const D = entry('dddddddddd', 'beta', 'up');
  const E = entry('eeeeeeeeee', 'Gamma', 'connecting');

  it('is found by its aliases', () => {
    const t = setup(list(A.id, A, B));
    t.palette.open();
    for (const word of ['bridge', 'server', 'machine', 'host', 'connect']) {
      t.type(word);
      expect(t.names(), word).toContain('Switch bridge');
    }
  });

  it('lists every bridge but the one in use: online first, each group by name without regard to case', () => {
    const t = setup(list(A.id, A, B, C, D, E));
    t.openBridges();
    expect(t.palette.isOpen).toBe(true);
    expect(t.dlg.querySelector('.pal-title')?.textContent).toBe('Switch to which bridge?');
    expect(t.input.value).toBe('');
    expect(t.names()).toEqual(['beta', 'zeta', 'Alpha', 'Gamma']);
    expect(t.dots()).toEqual(['up', 'up', 'down', 'wait']);
    expect(t.rows()[2]?.textContent).toContain('Offline, retrying');
    expect(t.rows()[0]?.textContent).toContain('dev@dddddddddd');
    expect(t.run).not.toHaveBeenCalled();
    // The text filters, never reorders.
    t.type('a');
    expect(t.names()).toEqual(['beta', 'zeta', 'Alpha', 'Gamma']);
    t.type('ta');
    expect(t.names()).toEqual(['beta', 'zeta']);
    t.type('nope');
    expect(t.rows()).toHaveLength(0);
    expect(t.dlg.querySelector('.pal-status')?.textContent).toBe('No bridge matches “nope”.');
  });

  it('keeps the order while open and changes only the dots as bridges go up and down', async () => {
    const t = setup(list(A.id, A, B, C, D));
    t.openBridges();
    expect(t.names()).toEqual(['beta', 'zeta', 'Alpha']);
    // Opening it asked the helper again (its answer is from memory: no ssh in the way).
    expect(t.fetch).toHaveBeenCalled();
    t.setList(list(A.id, A, { ...B, state: 'backoff' }, { ...C, state: 'up' }, D));
    await t.book.refresh();
    expect(t.names()).toEqual(['beta', 'zeta', 'Alpha']);
    expect(t.dots()).toEqual(['up', 'down', 'up']);
    // A fresh query orders it again.
    t.type('');
    t.type(' ');
    expect(t.names()).toEqual(['Alpha', 'beta', 'zeta']);
  });

  it('switches to the picked bridge, offline ones too (the game asks first)', () => {
    const t = setup(list(A.id, A, B, C));
    t.openBridges();
    t.press('ArrowDown');
    t.press('Enter');
    expect(t.palette.isOpen).toBe(false);
    expect(t.switchTo).toHaveBeenCalledWith(expect.objectContaining({ id: C.id, name: 'Alpha', state: 'backoff' }));
  });

  it('says when there is no other bridge, and that row opens Settings → Bridges', () => {
    const t = setup(list(A.id, A));
    t.openBridges();
    expect(t.names()).toEqual(['No other bridges: add one in Settings']);
    t.press('Enter');
    expect(t.palette.isOpen).toBe(false);
    expect(t.openSettings).toHaveBeenCalledOnce();
    expect(t.switchTo).not.toHaveBeenCalled();
  });

  it('stops reading the list when it closes', async () => {
    vi.useFakeTimers();
    try {
      const t = setup(list(A.id, A, B));
      (t.book as unknown as { pollMs: number }).pollMs = 2000;
      t.openBridges();
      await vi.advanceTimersByTimeAsync(4100);
      const n = t.fetch.mock.calls.length;
      expect(n).toBeGreaterThanOrEqual(2);
      t.palette.close();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(t.fetch.mock.calls.length).toBe(n);
    } finally {
      vi.useRealTimers();
    }
  });
});
