// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxChip, type InboxEntry } from './inbox';
import { InboxPrefs } from './inboxPrefs';
import { LimitsPrefs } from './limitsPrefs';
import { displaySection } from './settingsSections';

const tick = () => new Promise((r) => setTimeout(r, 0));
const NOW = 1_800_000_000_000;

function mount(plateHeight = 40): { chip: InboxChip; go: ReturnType<typeof vi.fn<(id: string) => void>>; dismiss: ReturnType<typeof vi.fn<(id: string) => void>>; plate: HTMLElement; now: { t: number } } {
  const plate = document.createElement('aside');
  // jsdom has no layout: the plate is as tall as the test says.
  plate.getBoundingClientRect = () => ({ left: 900, top: 72, right: 1268, bottom: 72 + plateHeight, width: plateHeight ? 368 : 0, height: plateHeight, x: 900, y: 72, toJSON: () => ({}) });
  document.body.append(plate);
  const go = vi.fn<(id: string) => void>();
  const dismiss = vi.fn<(id: string) => void>();
  const now = { t: NOW };
  const chip = new InboxChip(document.body, plate, { go, dismiss, now: () => now.t });
  return { chip, go, dismiss, plate, now };
}

const entry = (id: string, over: Partial<InboxEntry> = {}): InboxEntry => ({ id, name: id, harness: 'claude', where: 'Herdr 3D › h3d-sesame-3', reason: 'Needs you', blocked: true, since: NOW - 4 * 60_000, ...over });
const done = (id: string, over: Partial<InboxEntry> = {}): InboxEntry => entry(id, { reason: 'Finished', blocked: false, dismissable: true, ...over });
const xOf = (c: InboxChip) => [...c.root.querySelectorAll<HTMLButtonElement>('.ib-x')];
const chipOf = (c: InboxChip) => c.root.querySelector<HTMLButtonElement>('.ib-chip')!;
const rowsOf = (c: InboxChip) => [...c.root.querySelectorAll<HTMLButtonElement>('.ib-row')];
const key = (el: Element, k: string) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-seated');
});

describe('InboxChip', () => {
  it('is not there at zero', () => {
    const { chip } = mount();
    expect(chip.root.hidden).toBe(true);
    chip.set([]);
    expect(chip.summary()).toEqual({ shown: false, count: 0, blocked: false, open: false, rows: [] });
  });

  it('says Inbox and the count, red only while someone needs you', () => {
    const { chip } = mount();
    chip.set([entry('a'), entry('b'), entry('c', { blocked: false, reason: 'Finished' })]);
    expect(chip.root.hidden).toBe(false);
    expect(chipOf(chip).textContent).toBe('Inbox3');
    expect(chip.root.dataset.blocked).toBe('true');
    expect(chipOf(chip).getAttribute('aria-label')).toBe('Inbox: 3, someone needs you.');
    chip.set([entry('c', { blocked: false, reason: 'Finished' })]);
    expect(chipOf(chip).textContent).toBe('Inbox1');
    expect(chip.root.dataset.blocked).toBe('false');
    chip.set([]);
    expect(chip.root.hidden).toBe(true);
  });

  it('a click opens the list: a row per worker, in order, with its sticker, where, why and how long', () => {
    const { chip } = mount();
    chip.set([entry('Chirp', { reason: 'Question' }), entry('Nutmeg', { harness: 'codex', where: 'Unassigned › scratch', reason: 'Finished', blocked: false, since: NOW - 2 * 3_600_000 })]);
    expect(chip.root.querySelector<HTMLElement>('.ib-list')!.hidden).toBe(true);
    chipOf(chip).click();
    expect(chipOf(chip).getAttribute('aria-expanded')).toBe('true');
    expect(chip.root.querySelector<HTMLElement>('.ib-list')!.hidden).toBe(false);
    const rows = rowsOf(chip);
    expect(rows.map((r) => [r.querySelector('.ib-name')?.textContent, r.querySelector('.ib-where')?.textContent, r.querySelector('.ib-why')?.textContent, r.querySelector('.ib-age')?.textContent])).toEqual([
      ['Chirp', 'Herdr 3D › h3d-sesame-3', 'Question', '4 min'],
      ['Nutmeg', 'Unassigned › scratch', 'Finished', '2 h'],
    ]);
    expect(rows[0]!.querySelector('.ib-why')!.classList.contains('tape--needs_you')).toBe(true);
    expect(rows[1]!.querySelector('.ib-why')!.classList.contains('tape--done')).toBe(true);
    expect(rows.map((r) => r.querySelector('.ib-stk circle')?.getAttribute('fill'))).toEqual(['#f6f1e7', '#11141c']);
    expect(rows[1]!.getAttribute('aria-label')).toBe('Nutmeg, Codex: Finished. Unassigned › scratch, 2 h ago. Go to its laptop.');
    expect(chip.summary()).toMatchObject({ open: true, rows: [{ id: 'Chirp', reason: 'Question' }, { id: 'Nutmeg', where: 'Unassigned › scratch' }] });
    chipOf(chip).click();
    expect(chip.summary().open).toBe(false);
  });

  it('a row’s click shuts the list and goes to that worker', () => {
    const { chip, go } = mount();
    chip.set([entry('a'), entry('b')]);
    chipOf(chip).click();
    rowsOf(chip)[1]!.querySelector('.ib-where')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(go).toHaveBeenCalledExactlyOnceWith('b');
    expect(chip.summary().open).toBe(false);
  });

  it('a finished row has a × (a real button, named for the worker); a row that needs you has none (#106)', () => {
    const { chip } = mount();
    chip.set([entry('Chirp'), done('Nutmeg')]);
    chipOf(chip).click();
    expect(rowsOf(chip)).toHaveLength(2);
    expect(xOf(chip).map((x) => [x.tagName, x.type, x.dataset.id, x.getAttribute('aria-label')])).toEqual([['BUTTON', 'button', 'Nutmeg', 'Dismiss Nutmeg']]);
    // Beside the row's button, not inside it (a button cannot hold one).
    expect(xOf(chip)[0]!.closest('.ib-row')).toBeNull();
    expect(chip.summary().rows.map((r) => r.dismissable)).toEqual([false, true]);
  });

  it('the × dismisses and does not go to the worker; the list stays open (#106)', () => {
    const { chip, go, dismiss } = mount();
    chip.set([done('a'), done('b')]);
    chipOf(chip).click();
    xOf(chip)[1]!.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dismiss).toHaveBeenCalledExactlyOnceWith('b');
    expect(go).not.toHaveBeenCalled();
    expect(chip.summary().open).toBe(true);
    // The row leaves when the host says so (the bridge's event), and the focus moves to a neighbour's ×.
    xOf(chip)[1]!.focus();
    xOf(chip)[1]!.click();
    chip.set([done('a')]);
    expect(rowsOf(chip).map((r) => r.dataset.id)).toEqual(['a']);
    expect(document.activeElement).toBe(xOf(chip)[0]);
  });

  it('the arrows walk each row and then its × (#106)', () => {
    const { chip } = mount();
    chip.set([entry('a'), done('b'), done('c')]);
    chipOf(chip).focus();
    key(chipOf(chip), 'ArrowDown');
    const at = () => (document.activeElement as HTMLElement).dataset.key;
    expect(at()).toBe('row:a');
    key(document.activeElement!, 'ArrowDown');
    expect(at()).toBe('row:b');
    key(document.activeElement!, 'ArrowDown');
    expect(at()).toBe('x:b');
    key(document.activeElement!, 'ArrowDown');
    expect(at()).toBe('row:c');
    key(document.activeElement!, 'End');
    expect(at()).toBe('x:c');
    key(document.activeElement!, 'ArrowUp');
    expect(at()).toBe('row:c');
  });

  it('live: the open list follows the inbox, keeping focus on the same row', () => {
    const { chip } = mount();
    chip.set([entry('a'), entry('b')]);
    chipOf(chip).click();
    rowsOf(chip)[1]!.focus();
    chip.set([entry('z'), entry('a'), entry('b')]);
    expect(rowsOf(chip).map((r) => r.dataset.id)).toEqual(['z', 'a', 'b']);
    expect((document.activeElement as HTMLElement).dataset.id).toBe('b');
  });

  it('ages tick while open, every 20 s', () => {
    vi.useFakeTimers();
    try {
      const { chip, now } = mount();
      chip.set([entry('a', { since: NOW - 30_000 })]);
      chipOf(chip).click();
      expect(rowsOf(chip)[0]!.querySelector('.ib-age')!.textContent).toBe('now');
      now.t += 60_000;
      vi.advanceTimersByTime(20_000);
      expect(rowsOf(chip)[0]!.querySelector('.ib-age')!.textContent).toBe('1 min');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Esc shuts it and gives the focus back to the chip; the arrows walk the rows; the walker gets none of those keys', () => {
    const { chip } = mount();
    chip.set([entry('a'), entry('b')]);
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    chipOf(chip).focus();
    expect(key(chipOf(chip), 'ArrowDown').defaultPrevented).toBe(true);
    expect(chip.summary().open).toBe(true);
    expect(document.activeElement).toBe(rowsOf(chip)[0]);
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(rowsOf(chip)[1]);
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(rowsOf(chip)[1]);
    key(document.activeElement!, 'Home');
    expect(document.activeElement).toBe(rowsOf(chip)[0]);
    key(document.activeElement!, ' ');
    key(document.activeElement!, 'Escape');
    expect(chip.summary().open).toBe(false);
    expect(document.activeElement).toBe(chipOf(chip));
    expect(seen).not.toHaveBeenCalled();
    // Other keys are the game's (WASD while the chip has focus).
    key(chipOf(chip), 'w');
    expect(seen).toHaveBeenCalledOnce();
    window.removeEventListener('keydown', seen);
  });

  it('opened with the mouse, Esc shuts it wherever the focus is, but a dialog’s or a field’s Esc is theirs', () => {
    const { chip } = mount();
    chip.set([entry('a')]);
    chipOf(chip).click();
    const d = document.createElement('dialog');
    const field = document.createElement('input');
    d.append(field);
    document.body.append(d);
    key(field, 'Escape');
    expect(chip.summary().open).toBe(true);
    expect(key(document.body, 'Escape').defaultPrevented).toBe(true);
    expect(chip.summary().open).toBe(false);
    // Shut, Esc is the game's again.
    expect(key(document.body, 'Escape').defaultPrevented).toBe(false);
  });

  it('a click elsewhere shuts it; a click inside does not', () => {
    const { chip } = mount();
    chip.set([entry('a')]);
    chipOf(chip).click();
    chip.root.querySelector('.ib-list')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(chip.summary().open).toBe(true);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(chip.summary().open).toBe(false);
  });

  it('openList opens it, but not while the chip is not shown; emptied, it shuts', () => {
    const { chip } = mount();
    chip.openList();
    expect(chip.summary().open).toBe(false);
    chip.set([entry('a')]);
    chip.openList();
    expect(chip.summary().open).toBe(true);
    chip.set([]);
    expect(chip.summary()).toMatchObject({ shown: false, open: false });
  });

  it('Settings can turn it off, list and all', () => {
    const { chip } = mount();
    chip.set([entry('a')]);
    chip.openList();
    chip.enabled = false;
    expect(chip.summary()).toMatchObject({ shown: false, open: false, count: 1 });
    chip.enabled = true;
    expect(chip.summary()).toMatchObject({ shown: true, open: false });
  });

  it('pulse marks it for a moment, only while shown', () => {
    vi.useFakeTimers();
    try {
      const { chip } = mount();
      chip.pulse();
      expect(chip.root.dataset.pulse).toBeUndefined();
      chip.set([entry('a')]);
      chip.pulse();
      expect(chip.root.dataset.pulse).toBe('true');
      vi.advanceTimersByTime(1500);
      expect(chip.root.dataset.pulse).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sits under the plate, or in its spot when the plate is not drawn', () => {
    expect(mount(40).chip.root.style.getPropertyValue('--ib-lift')).toBe('46.0px');
    expect(mount(0).chip.root.style.getPropertyValue('--ib-lift')).toBe('0px');
  });

  it('goes away at a laptop and over a screen dialog (shutting the list), and comes back after', async () => {
    const { chip } = mount();
    chip.set([entry('a')]);
    chip.openList();
    document.documentElement.setAttribute('data-seated', '1200');
    await tick();
    expect(chip.root.hidden).toBe(true);
    expect(chip.summary().open).toBe(false);
    document.documentElement.removeAttribute('data-seated');
    await tick();
    expect(chip.root.hidden).toBe(false);
    const d = document.createElement('dialog');
    d.className = 'panel';
    document.body.append(d);
    d.setAttribute('open', '');
    await tick();
    expect(chip.root.hidden).toBe(true);
    d.removeAttribute('open');
    await tick();
    expect(chip.root.hidden).toBe(false);
  });

  it('stays beside a small dialog on a wide screen, and moves left of the Changes panel', async () => {
    const { chip } = mount();
    chip.set([entry('a', { blocked: false, reason: 'Finished' })]);
    const small = document.createElement('dialog');
    small.className = 'confirm';
    document.body.append(small);
    small.setAttribute('open', '');
    await tick();
    expect(chip.root.hidden).toBe(false);
    small.remove();
    const changes = document.createElement('dialog');
    changes.className = 'changes';
    document.body.append(changes);
    changes.setAttribute('open', '');
    await tick();
    expect(chip.root.dataset.beside).toBe('changes');
  });
});

describe('Settings → Display: Show inbox', () => {
  it('is bound to the inbox prefs both ways', () => {
    const store = new Map<string, string>();
    const prefs = new InboxPrefs({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) });
    const body = document.createElement('div');
    const handle = displaySection(new LimitsPrefs(null), undefined, prefs)(body);
    const box = body.querySelector<HTMLInputElement>('#settings-inbox')!;
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(prefs.settings.show).toBe(false);
    prefs.set({ show: true });
    expect(box.checked).toBe(true);
    handle.dispose?.();
    prefs.set({ show: false });
    expect(box.checked).toBe(true);
  });
});
