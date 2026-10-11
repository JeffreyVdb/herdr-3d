// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxChip, type InboxEntry } from './inbox';
import { InboxPrefs } from './inboxPrefs';
import { LimitsPrefs } from './limitsPrefs';
import { displaySection } from './settingsSections';
import { HirePrefs } from './hirePrefs';

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

  it('a report request: who decides, and a keyboard-reachable disclosure for the whole text that survives redraws (#215)', () => {
    const { chip, go } = mount();
    const text = `${'x'.repeat(600)} Or accept the existing evidence: ORCHESTRATOR ACCEPTANCE.`;
    const request = { text, truncated: false, who: 'Asked of the orchestrator (Cog)' };
    chip.set([entry('a', { reason: 'Report request', request }), entry('b')]);
    chip.openList();
    const more = chip.root.querySelectorAll<HTMLButtonElement>('.ib-more');
    expect(more).toHaveLength(1); // only the request row has one
    const btn = more[0]!;
    expect(btn.textContent).toBe('Show full request');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    const body = chip.root.querySelector<HTMLElement>(`#${btn.getAttribute('aria-controls')}`)!;
    expect(body.hidden).toBe(true);
    expect(chip.root.querySelector('.ib-who')?.textContent).toBe('Asked of the orchestrator (Cog)');
    expect(rowsOf(chip)[0]!.getAttribute('aria-label')).toContain('Report request, asked of the orchestrator (Cog)');
    btn.focus();
    btn.click();
    expect(go).not.toHaveBeenCalled(); // the disclosure is not the row
    const open = chip.root.querySelector<HTMLButtonElement>('.ib-more')!;
    expect(open.textContent).toBe('Hide full request');
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(open); // focus kept across the redraw
    const shown = chip.root.querySelector<HTMLElement>(`#${open.getAttribute('aria-controls')}`)!;
    expect(shown.hidden).toBe(false);
    expect(shown.textContent).toContain('ORCHESTRATOR ACCEPTANCE'); // text after byte 500
    expect(shown.getAttribute('tabindex')).toBe('0'); // scrollable by keyboard
    // Still open after the inbox updates; a cut one says so.
    chip.set([entry('a', { reason: 'Report request', request: { ...request, truncated: true } }), entry('b')]);
    expect(chip.root.querySelector<HTMLElement>('.ib-req')!.hidden).toBe(false);
    expect(chip.root.querySelector('.ib-req-cut')?.textContent).toContain('Cut at 8 KiB');
    // The arrows walk row → disclosure.
    const all = [...chip.root.querySelectorAll<HTMLElement>('.ib-row, .ib-more')];
    expect(all.map((e) => e.className)).toEqual(['ib-row', 'ib-more', 'ib-row']);
    // It closes again, and a resolved request is gone from the list.
    chip.root.querySelector<HTMLButtonElement>('.ib-more')!.click();
    expect(chip.root.querySelector<HTMLElement>('.ib-req')!.hidden).toBe(true);
    chip.set([entry('b')]);
    expect(chip.root.querySelector('.ib-more')).toBeNull();
  });

  describe('the full request reader (#215)', () => {
    const request = { text: `${'x'.repeat(600)} ORCHESTRATOR ACCEPTANCE.`, truncated: false, who: 'Asked of the orchestrator (Cog)' };
    const opened = () => {
      const m = mount();
      m.chip.set([entry('a', { reason: 'Report request', request }), entry('b')]);
      m.chip.openList();
      m.chip.root.querySelector<HTMLButtonElement>('.ib-more')!.click();
      const req = m.chip.root.querySelector<HTMLElement>('.ib-req')!;
      req.focus();
      return { ...m, req };
    };

    it('its scroll keys are native: not row navigation, not the walker’s (they never reach the window)', () => {
      const { req } = opened();
      const reached: KeyboardEvent[] = [];
      const spy = (e: KeyboardEvent) => reached.push(e);
      window.addEventListener('keydown', spy);
      for (const k of ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ']) {
        for (const shiftKey of k === ' ' ? [false, true] : [false]) {
          const e = new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true });
          req.dispatchEvent(e);
          expect(e.defaultPrevented, k).toBe(false); // the browser scrolls it
          expect(document.activeElement, k).toBe(req); // the focus stays on the reader
        }
      }
      expect(reached).toHaveLength(0);
      // Tab is not swallowed: it reaches the page as ever (the browser moves the focus).
      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      req.dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(false);
      expect(reached).toHaveLength(1);
      window.removeEventListener('keydown', spy);
    });

    it('Esc folds the request first, the focus on its disclosure; the next Esc shuts the list', () => {
      const { chip, req } = opened();
      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      req.dispatchEvent(esc);
      expect(esc.defaultPrevented).toBe(true);
      expect(chip.summary().open).toBe(true);
      expect(chip.root.querySelector<HTMLElement>('.ib-req')!.hidden).toBe(true);
      expect(document.activeElement).toBe(chip.root.querySelector('.ib-more'));
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(chip.summary().open).toBe(false);
    });

    it('a redraw keeps the reader focused and where it was scrolled', () => {
      const { chip, req, now } = opened();
      req.scrollTop = 90;
      now.t += 5 * 60_000; // the ages move: the list redraws
      chip.set([entry('a', { reason: 'Report request', request }), entry('b'), entry('c')]); // and a worker comes in
      const again = chip.root.querySelector<HTMLElement>('.ib-req')!;
      expect(again).not.toBe(req); // it is a new element
      expect(document.activeElement).toBe(again);
      expect(again.scrollTop).toBe(90);
    });
  });

  it('the Shift+N command opens the list with "Show the inbox" off, and the chip goes again when it closes (#215)', () => {
    const { chip } = mount();
    chip.enabled = false;
    chip.set([entry('a')]);
    expect(chip.root.hidden).toBe(true);
    chip.openList(true); // a passive open (a notification's click) stays governed by the setting
    expect(chip.summary().open).toBe(false);
    expect(chip.openList(true, true)).toBe(true);
    expect(chip.root.hidden).toBe(false);
    expect(chip.summary().open).toBe(true);
    expect(document.activeElement).toBe(rowsOf(chip)[0]);
    chip.closeList();
    expect(chip.summary()).toMatchObject({ shown: false, open: false });
    // Nothing in the inbox: nothing opens, whatever the command.
    chip.set([]);
    expect(chip.openList(true, true)).toBe(false);
    expect(chip.root.hidden).toBe(true);
    // An entry that goes away while it is forced open takes the list with it.
    chip.set([entry('a')]);
    chip.openList(true, true);
    chip.set([]);
    expect(chip.root.hidden).toBe(true);
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

describe('Settings → Display: Go to a new hire after hiring (#116)', () => {
  it('is bound to the hire prefs both ways', () => {
    const prefs = new HirePrefs(null);
    const body = document.createElement('div');
    const handle = displaySection(new LimitsPrefs(null), undefined, undefined, prefs)(body);
    const box = body.querySelector<HTMLInputElement>('#settings-hire-goto')!;
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(prefs.goToNew).toBe(false);
    prefs.goToNew = true;
    expect(box.checked).toBe(true);
    handle.dispose?.();
    prefs.goToNew = false;
    expect(box.checked).toBe(true);
  });
});

describe('Settings → Display: Hire in background (#210)', () => {
  it('sits right after the go-to row, off by default, bound to the hire prefs both ways', () => {
    const prefs = new HirePrefs(null);
    const body = document.createElement('div');
    const handle = displaySection(new LimitsPrefs(null), undefined, undefined, prefs)(body);
    const goTo = body.querySelector<HTMLInputElement>('#settings-hire-goto')!;
    const box = body.querySelector<HTMLInputElement>('#settings-hire-background')!;
    expect(goTo.closest('label')!.nextElementSibling).toBe(box.closest('label'));
    expect(box.closest('label')!.className).toBe(goTo.closest('label')!.className);
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(prefs.hireInBackground).toBe(true);
    expect(prefs.goToNew).toBe(true);
    prefs.hireInBackground = false;
    expect(box.checked).toBe(false);
    handle.dispose?.();
    prefs.hireInBackground = true;
    expect(box.checked).toBe(false);
  });
});


describe('Settings → Display: Worktree default', () => {
  it('updates the hire preference and stays in sync until disposed', () => {
    const prefs = new HirePrefs(null);
    const body = document.createElement('div');
    const handle = displaySection(new LimitsPrefs(null), undefined, undefined, prefs)(body);
    const box = body.querySelector<HTMLInputElement>('#settings-hire-worktree')!;
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(prefs.worktreeByDefault).toBe(false);
    prefs.worktreeByDefault = true;
    expect(box.checked).toBe(true);
    handle.dispose?.();
    prefs.worktreeByDefault = false;
    expect(box.checked).toBe(true);
  });
});
