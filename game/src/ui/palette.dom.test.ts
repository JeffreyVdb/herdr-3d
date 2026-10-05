// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scope } from '../input/shortcuts';
import type { Building, Floor, Snapshot, Worker } from '../net/protocol';
import { paletteCommands, type PaletteCommand } from '../world/palette';
import { WorldStore } from '../world/store';
import { Palette, type PaletteHost } from './palette';

beforeEach(() => {
  // jsdom has no modal dialogs: open / close are what the game's code looks at.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});
afterEach(() => void (document.body.innerHTML = ''));

const floor = (session: string, building: string | null, over: Partial<Floor> = {}): Floor => ({ session, state: 'running', building, index: 0, ...over });
const worker = (id: string, session: string, status: string): Worker => ({ id, session, workspace_id: `ws-${id}`, label: id, status });
const B = (id: string, name: string, floors: string[], sort = 0): Building => ({ id, name, sort, floors });

function setup(opts: { here?: string | null; online?: boolean; scopes?: Scope[] } = {}) {
  const store = new WorldStore(0);
  const snap: Snapshot = {
    t: 'world.snapshot',
    seq: 1,
    world: {
      buildings: [B('zeta', 'Zeta', ['z-top', 'z-low'], 1), B('acme', 'Acme', ['a-two', 'a-one'], 0)],
      unassigned: [],
      floors: [floor('z-top', 'zeta'), floor('z-low', 'zeta', { index: 1 }), floor('a-two', 'acme'), floor('a-one', 'acme', { index: 1 })],
      workers: [worker('w1', 'z-low', 'blocked'), worker('w2', 'a-two', 'working'), worker('w3', 'a-two', 'working'), worker('w4', 'a-one', 'idle')],
    },
  };
  store.applySnapshot(snap);
  const state = { here: opts.here ?? null, online: opts.online ?? true };
  const run = vi.fn<(c: PaletteCommand, f: string | null) => void>();
  const goTo = vi.fn<(s: string) => void>();
  const host: PaletteHost = { commands: () => paletteCommands(new Set<Scope>(opts.scopes ?? ['any', 'city']), false), store, here: () => state.here, online: () => state.online, run, goTo };
  const field = document.createElement('input');
  document.body.append(field);
  const palette = new Palette(document.body, host);
  const dlg = document.querySelector('dialog.palette') as HTMLDialogElement;
  const input = dlg.querySelector('input') as HTMLInputElement;
  const rows = () => [...dlg.querySelectorAll<HTMLElement>('[role="option"]')];
  const names = () => rows().map((r) => r.querySelector('.pal-name')?.textContent);
  const press = (key: string, o: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...o });
    input.dispatchEvent(e);
    return e;
  };
  const type = (text: string) => {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const active = () => rows().find((r) => r.getAttribute('aria-selected') === 'true');
  return { palette, store, dlg, input, rows, names, press, type, active, run, goTo, state, field };
}

describe('the command palette (#147)', () => {
  it('opens a modal with a combobox over a listbox, and lists the commands, the first one active', () => {
    const t = setup();
    t.field.focus();
    t.palette.open(t.field);
    expect(t.palette.isOpen).toBe(true);
    expect(t.dlg.getAttribute('aria-label')).toBe('Command palette');
    expect(t.input.getAttribute('role')).toBe('combobox');
    expect(t.input.getAttribute('aria-controls')).toBe(t.dlg.querySelector('[role="listbox"]')?.id);
    expect(t.input.getAttribute('aria-autocomplete')).toBe('list');
    expect(document.activeElement).toBe(t.input);
    expect(t.names().slice(0, 3)).toEqual(['Hire', 'Issues', 'Pull requests']);
    expect(t.active()?.id).toBe(t.input.getAttribute('aria-activedescendant'));
    expect(t.rows().filter((r) => r.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(t.names()[0]).toBe('Hire');
    // A floor command off a floor says it asks.
    expect(t.rows()[0]?.textContent).toContain('pick a floor');
  });

  it('↑ ↓ move the active row and wrap; the key stays in the field', () => {
    const t = setup();
    t.palette.open(null);
    const n = t.rows().length;
    const e = t.press('ArrowDown');
    expect(e.defaultPrevented).toBe(true);
    expect(t.rows().indexOf(t.active() as HTMLElement)).toBe(1);
    t.press('ArrowUp');
    t.press('ArrowUp');
    expect(t.rows().indexOf(t.active() as HTMLElement)).toBe(n - 1);
    t.press('ArrowDown');
    expect(t.rows().indexOf(t.active() as HTMLElement)).toBe(0);
    expect(t.input.getAttribute('aria-activedescendant')).toBe(t.rows()[0]?.id);
    // A modified arrow is the field's.
    expect(t.press('ArrowDown', { shiftKey: true }).defaultPrevented).toBe(false);
  });

  it('filters as you type and Enter runs the active command: "hire" first, closing the palette', () => {
    const t = setup({ here: 'a-one', scopes: ['any', 'floor'] });
    t.palette.open(null);
    t.type('hire');
    expect(t.names()[0]).toBe('Hire');
    expect(t.rows()[0]?.querySelector('.pal-hit')?.textContent).toBe('Hire');
    t.press('Enter');
    expect(t.run).toHaveBeenCalledTimes(1);
    expect(t.run.mock.calls[0]?.[0].id).toBe('hire');
    expect(t.run.mock.calls[0]?.[1]).toBeNull();
    expect(t.palette.isOpen).toBe(false);
  });

  it('says so when nothing matches, and Enter does nothing then', () => {
    const t = setup();
    t.palette.open(null);
    t.type('zzzz');
    expect(t.rows()).toHaveLength(0);
    expect(t.dlg.querySelector('.pal-status')?.textContent).toBe('No command matches “zzzz”.');
    expect(t.press('Enter').defaultPrevented).toBe(true);
    expect(t.palette.isOpen).toBe(true);
    expect(t.run).not.toHaveBeenCalled();
  });

  it('a floor-scoped command off a floor turns into "which floor?", and the pick runs it there', () => {
    const t = setup({ here: null });
    t.palette.open(null);
    t.type('hire');
    t.press('Enter');
    expect(t.run).not.toHaveBeenCalled();
    expect(t.palette.isOpen).toBe(true);
    expect(t.input.value).toBe('@');
    expect(t.dlg.querySelector('.pal-title')?.textContent).toBe('Hire on which floor?');
    expect(t.dlg.querySelector('.pal-title')?.hasAttribute('hidden')).toBe(false);
    expect(t.input.getAttribute('aria-label')).toBe('Hire on which floor?');
    expect(t.names()).toEqual(['Zeta › z-low', 'Acme › a-one', 'Acme › a-two', 'Zeta › z-top']);
    t.press('ArrowDown');
    t.press('Enter');
    expect(t.run).toHaveBeenCalledTimes(1);
    expect(t.run.mock.calls[0]?.[0].id).toBe('hire');
    expect(t.run.mock.calls[0]?.[1]).toBe('a-one');
    expect(t.goTo).not.toHaveBeenCalled();
    expect(t.palette.isOpen).toBe(false);
  });

  it('deleting the @ in the pick step goes back to the commands and forgets the question', () => {
    const t = setup();
    t.palette.open(null);
    t.type('issues');
    t.press('Enter');
    expect(t.input.value).toBe('@');
    t.type('');
    expect(t.dlg.querySelector('.pal-title')?.hasAttribute('hidden')).toBe(true);
    expect(t.names()[0]).toBe('Hire');
    // Typing the @ again is a plain floor list: a pick travels, it does not run Issues.
    t.type('@');
    expect(t.dlg.querySelector('.pal-title')?.hasAttribute('hidden')).toBe(true);
    t.press('Enter');
    expect(t.run).not.toHaveBeenCalled();
    expect(t.goTo).toHaveBeenCalledWith('z-low');
  });

  it('a leading @ lists the floors with their counts, those that need you first, then by name', () => {
    const t = setup({ here: 'a-two' });
    t.palette.open(null);
    expect(t.dlg.querySelector('.pal-hint')?.hasAttribute('hidden')).toBe(false);
    expect(t.dlg.querySelector('.pal-hint')?.textContent).toBe('1 floor needs you · type @');
    t.type('@');
    expect(t.names()).toEqual(['Zeta › z-low', 'Acme › a-one', 'Acme › a-two', 'Zeta › z-top']);
    expect(t.dlg.querySelector('.pal-hint')?.hasAttribute('hidden')).toBe(true);
    const chips = (i: number) => [...(t.rows()[i] as HTMLElement).querySelectorAll('.pal-chip')].map((c) => c.textContent);
    expect(chips(0)).toEqual(['1 need you']);
    expect(chips(1)).toEqual(['1 idle']);
    expect(chips(2)).toEqual(['2 working']);
    expect(chips(3)).toEqual([]);
    expect(t.rows()[2]?.textContent).toContain('You are here');
    expect(t.rows()[2]?.getAttribute('aria-current')).toBe('location');
    t.type('@acme');
    expect(t.names()).toEqual(['Acme › a-one', 'Acme › a-two']);
    t.type('@nope');
    expect(t.dlg.querySelector('.pal-status')?.textContent).toBe('No floor matches “nope”.');
    // The @ gone: commands again.
    t.type('');
    expect(t.names()[0]).toBe('Hire');
  });

  it('Enter on a floor takes you there; on the floor you are on it only closes', () => {
    const t = setup({ here: 'a-two' });
    t.field.focus();
    t.palette.open(t.field);
    t.type('@zeta');
    t.press('Enter');
    expect(t.goTo).toHaveBeenCalledWith('z-low');
    expect(t.palette.isOpen).toBe(false);
    t.goTo.mockClear();
    t.palette.open(null);
    t.type('@a-two');
    t.press('Enter');
    expect(t.goTo).not.toHaveBeenCalled();
    expect(t.palette.isOpen).toBe(false);
  });

  it('the counts update live and the rows stay where they are', () => {
    const t = setup();
    t.palette.open(null);
    t.type('@');
    const before = t.names();
    t.press('ArrowDown');
    const keyed = t.active()?.dataset.session;
    t.store.applyEvent({ t: 'worker.status', seq: 2, id: 'w4', session: 'a-one', workspace_id: 'ws-w4', status: 'blocked' });
    t.store.applyEvent({ t: 'worker.status', seq: 3, id: 'w1', session: 'z-low', workspace_id: 'ws-w1', status: 'idle' });
    t.palette.refresh();
    expect(t.names()).toEqual(before);
    expect(t.active()?.dataset.session).toBe(keyed);
    const chips = (s: string) => [...(t.dlg.querySelector(`[data-session="${s}"]`) as HTMLElement).querySelectorAll('.pal-chip')].map((c) => c.textContent);
    expect(chips('a-one')).toEqual(['1 need you']);
    expect(chips('z-low')).toEqual(['1 idle']);
  });

  it('a floor that goes drops its row; the active row moves to one that is left', () => {
    const t = setup();
    t.palette.open(null);
    t.type('@');
    expect(t.active()?.dataset.session).toBe('z-low');
    t.store.applyEvent({ t: 'floor.removed', seq: 2, session: 'z-low' });
    t.palette.refresh();
    expect(t.names()).toEqual(['Acme › a-one', 'Acme › a-two', 'Zeta › z-top']);
    expect(t.active()?.dataset.session).toBe('a-one');
  });

  it('without the bridge the floors grey out and cannot be picked, and the commands still run', () => {
    const t = setup({ online: false });
    t.palette.open(null);
    t.type('@');
    expect(t.rows().every((r) => r.getAttribute('aria-disabled') === 'true')).toBe(true);
    expect(t.dlg.querySelector('.pal-note')?.textContent).toMatch(/Not connected/);
    t.press('Enter');
    t.rows()[0]?.click();
    expect(t.goTo).not.toHaveBeenCalled();
    expect(t.palette.isOpen).toBe(true);
    t.type('settings');
    t.press('Enter');
    expect(t.run.mock.calls[0]?.[0].id).toBe('settings');
  });

  it('no floors yet is an empty state', () => {
    const t = setup();
    t.store.applySnapshot({ t: 'world.snapshot', seq: 9, world: { buildings: [], unassigned: [], floors: [], workers: [] } });
    t.palette.open(null);
    t.type('@');
    expect(t.rows()).toHaveLength(0);
    expect(t.dlg.querySelector('.pal-status')?.textContent).toMatch(/No floors yet/);
  });

  it('Esc closes only the palette and puts the focus back where it was', () => {
    const t = setup();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    t.field.focus();
    t.palette.open(t.field);
    expect(document.activeElement).toBe(t.input);
    const e = t.press('Escape');
    expect(e.defaultPrevented).toBe(true);
    expect(t.palette.isOpen).toBe(false);
    expect(document.activeElement).toBe(t.field);
    // Nothing behind the palette saw a key.
    expect(outer).not.toHaveBeenCalled();
  });

  it('a pick that runs something does not take the focus back', () => {
    const t = setup();
    t.field.focus();
    t.palette.open(t.field);
    t.type('settings');
    t.press('Enter');
    expect(document.activeElement).not.toBe(t.field);
  });

  it('a click on a row picks it, and the field keeps the focus meanwhile', () => {
    const t = setup();
    t.palette.open(null);
    t.type('settings');
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    t.rows()[0]?.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    t.rows()[0]?.click();
    expect(t.run.mock.calls[0]?.[0].id).toBe('settings');
  });

  it('does not take Enter or the arrows from an IME, and keeps Tab in the field', () => {
    const t = setup();
    t.palette.open(null);
    expect(t.press('Enter', { isComposing: true }).defaultPrevented).toBe(false);
    expect(t.press('ArrowDown', { isComposing: true }).defaultPrevented).toBe(false);
    expect(t.run).not.toHaveBeenCalled();
    expect(t.press('Tab').defaultPrevented).toBe(true);
  });

  it('opens again from scratch: empty field, commands, no old question', () => {
    const t = setup();
    t.palette.open(null);
    t.type('hire');
    t.press('Enter');
    t.palette.close();
    t.palette.open(null);
    expect(t.input.value).toBe('');
    expect(t.names()[0]).toBe('Hire');
    expect(t.dlg.querySelector('.pal-title')?.hasAttribute('hidden')).toBe(true);
  });

  it('the hint switches to the floors when clicked', () => {
    const t = setup();
    t.palette.open(null);
    (t.dlg.querySelector('.pal-hint') as HTMLButtonElement).click();
    expect(t.input.value).toBe('@');
    expect(t.names()[0]).toBe('Zeta › z-low');
  });
});
