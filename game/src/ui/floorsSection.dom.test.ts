// @vitest-environment jsdom
// #58 stage 4: Settings → Floors. Every session's own floor and the virtual floors on it, from the store; Add floor
// opens the dialog, Rename and Delete act on virtual floors in place, Hide / Show on any floor (decision 2).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { Floor, Snapshot, Worker } from '../net/protocol';
import { WorldStore } from '../world/store';
import { floorsSection, type FloorsSectionHost } from './floorsSection';

afterEach(() => void (document.body.innerHTML = ''));

const V = 'v-00000000f0e1';
const D = 'v-00000000f0e2';

const floor = (id: string, over: Partial<Floor> = {}): Floor => ({ id, name: id, session: id, base_session: id, virtual: false, hidden: false, state: 'running', building: 'b1', index: 0, ...over });
const vfloor = (id: string, name: string, base: string, over: Partial<Floor> = {}): Floor => floor(id, { name, session: base, base_session: base, virtual: true, ...over });
const worker = (id: string, name: string, floorId: string, session: string, desk: number): Worker => ({ id, name, session, floor: floorId, workspace_id: `w-${id}`, label: id, status: 'idle', desk_index: desk });

function snap(): Snapshot {
  return {
    t: 'world.snapshot',
    seq: 1,
    world: {
      buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['herdr-3d', V, 'depot', D] }],
      unassigned: [],
      floors: [floor('herdr-3d'), vfloor(V, 'Frontend', 'herdr-3d', { index: 1 }), floor('depot', { index: 2, state: 'asleep' }), vfloor(D, 'Depot docs', 'depot', { index: 3, state: 'asleep' }), floor('pastry', { hidden: true, building: null, index: null })],
      workers: [worker('a', 'Nibble', 'herdr-3d', 'herdr-3d', 0), worker('b', 'Mochi', V, 'herdr-3d', 0), worker('c', 'Pixel', V, 'herdr-3d', 1)],
    },
  };
}

/** A promise the test resolves by hand: the bridge's answer, when the test says. */
function later<T>() {
  let done!: (v: T) => void;
  const p = new Promise<T>((r) => (done = r));
  return { p, done };
}

function mount(o: { unsupported?: string[] } = {}) {
  const store = new WorldStore(0);
  store.applySnapshot(snap());
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const replies: Array<ReturnType<typeof later<CommandResult>>> = [];
  const send = ((t: string, args: Record<string, unknown>) => {
    sent.push({ t, args });
    const l = later<CommandResult>();
    replies.push(l);
    return l.p;
  }) as FloorsSectionHost['send'];
  const addFloor = vi.fn<FloorsSectionHost['addFloor']>();
  const body = document.body.appendChild(document.createElement('div'));
  const handle = floorsSection({ book: store.floorList, send, unsupported: (t) => !!o.unsupported?.includes(t), addFloor })(body, { setHidden: vi.fn() });
  handle.open?.();
  const row = (id: string) => body.querySelector<HTMLElement>(`.settings-fl-row[data-floor="${id}"]`)!;
  const key = (k: string) => body.querySelector<HTMLButtonElement>(`[data-key="${k}"]`)!;
  const click = (k: string) => key(k).click();
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const status = () => body.querySelector('.settings-status')?.textContent ?? '';
  const answer = (r: CommandResult) => replies[replies.length - 1]!.done(r);
  return { store, body, sent, addFloor, row, key, click, flush, status, answer, handle };
}

describe('the Floors section (#58 stage 4)', () => {
  it('lists each session’s own floor, then its virtual floors, with their session and who works there', () => {
    const m = mount();
    const rows = [...m.body.querySelectorAll<HTMLElement>('.settings-fl-row')].map((r) => [r.dataset.floor, r.querySelector('.settings-fl-name')?.textContent, r.querySelector('.settings-fl-meta')?.textContent]);
    expect(rows).toEqual([
      ['depot', 'depot', 'The herdr session’s own floor · Nobody works here · asleep'],
      [D, 'Depot docs', 'Virtual floor on session depot · Nobody works here · asleep'],
      ['herdr-3d', 'herdr-3d', 'The herdr session’s own floor · 1 worker'],
      [V, 'Frontend', 'Virtual floor on session herdr-3d · 2 workers'],
      ['pastry', 'pastry', 'The herdr session’s own floor · Nobody works here'],
    ]);
    expect(m.body.querySelector('.settings-used')?.textContent).toBe('5 floors on 3 herdr sessions: 2 virtual floors, 1 hidden.');
    // Only virtual floors can be renamed or deleted; every floor can be hidden.
    expect(m.row('herdr-3d').querySelectorAll('button').length).toBe(1);
    expect([...m.row(V).querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Hide Frontend', 'Rename Frontend', 'Delete Frontend']);
    expect(m.row('pastry').querySelector('.settings-badge')?.textContent).toBe('Hidden');
    expect(m.key('hide:pastry').textContent).toBe('Show');
    // A virtual floor's id never shows to a person.
    const visible = [...m.body.querySelectorAll('*')].map((e) => `${e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3) ? e.textContent : ''} ${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('title') ?? ''}`).join(' ');
    expect(visible).not.toMatch(/v-[0-9a-f]{12}/);
  });

  it('Add floor opens the dialog; a floor added there is said in the status line', () => {
    const m = mount();
    m.click('add-floor');
    expect(m.addFloor).toHaveBeenCalledTimes(1);
    const [from, added] = m.addFloor.mock.calls[0]!;
    expect(from).toBe(m.key('add-floor'));
    m.store.applyEvent({ t: 'floor.upsert', seq: 2, floor: vfloor('v-0000000000aa', 'Billing', 'pastry', { building: null, index: null }) });
    added('v-0000000000aa', 'virtual');
    expect(m.status()).toBe('Added Billing on session pastry.');
    expect(m.row('v-0000000000aa').querySelector('.settings-fl-name')?.textContent).toBe('Billing');
  });

  it('shows another client’s changes at once: a rename, a hide, a delete', () => {
    const m = mount();
    m.store.applyEvent({ t: 'floor.upsert', seq: 2, floor: vfloor(V, 'Front end', 'herdr-3d', { index: 1, hidden: true }) });
    expect(m.row(V).querySelector('.settings-fl-name')?.textContent).toBe('Front end');
    expect(m.row(V).querySelector('.settings-badge')?.textContent).toBe('Hidden');
    // Hidden with workers on it: listed anyway, and said so.
    expect(m.row(V).textContent).toContain('Hidden, but listed while Mochi and Pixel work on it.');
    m.store.applyEvent({ t: 'floor.removed', seq: 3, session: 'depot', floor_id: D });
    expect(m.row(D)).toBeNull();
  });

  it('renames a virtual floor in place: Enter saves, the name is checked first, Esc keeps the Settings window', async () => {
    const m = mount();
    m.click(`rename:${V}`);
    const input = m.key(`rename-input:${V}`) as unknown as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Frontend');
    input.value = '   ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(m.sent).toEqual([]);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(m.row(V).querySelector('.settings-fl-edit .settings-field-error')?.textContent).toBe('Give the floor a name.');
    input.value = ' Web app ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(m.sent).toEqual([{ t: 'floor.rename', args: { floor: V, name: 'Web app' } }]);
    expect(m.key(`rename-save:${V}`).textContent).toBe('Saving…');
    // The bridge's floor.upsert comes before the ack.
    m.store.applyEvent({ t: 'floor.upsert', seq: 2, floor: vfloor(V, 'Web app', 'herdr-3d', { index: 1 }) });
    m.answer({ ok: true, data: {} });
    await m.flush();
    expect(m.status()).toBe('Renamed Frontend to Web app.');
    expect(m.body.querySelector('.settings-fl-edit')).toBeNull();
    expect(document.activeElement).toBe(m.key(`rename:${V}`));

    // Esc ends the rename and stops there (the Settings dialog would close on it).
    m.click(`rename:${D}`);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const outer = vi.fn();
    m.body.addEventListener('keydown', outer);
    (m.key(`rename-input:${D}`) as unknown as HTMLInputElement).dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    expect(m.body.querySelector('.settings-fl-edit')).toBeNull();
    expect(document.activeElement).toBe(m.key(`rename:${D}`));
  });

  it('deletes a floor nobody works on after a simple confirmation', async () => {
    const m = mount();
    m.click(`delete:${D}`);
    const box = m.row(D).querySelector<HTMLElement>('.settings-fl-confirm')!;
    expect(box.querySelector('.settings-fl-confirm-title')?.textContent).toBe('Delete Depot docs?');
    expect(box.textContent).toContain('Nobody works on it.');
    expect(document.activeElement).toBe(m.key(`delete-cancel:${D}`));
    // Keep it: nothing sent.
    m.click(`delete-cancel:${D}`);
    expect(m.row(D).querySelector('.settings-fl-confirm')).toBeNull();
    expect(m.sent).toEqual([]);
    m.click(`delete:${D}`);
    expect(m.key(`delete-ok:${D}`).textContent).toBe('Delete floor');
    m.click(`delete-ok:${D}`);
    expect(m.sent).toEqual([{ t: 'floor.delete', args: { floor: D } }]);
    m.store.applyEvent({ t: 'floor.removed', seq: 2, session: 'depot', floor_id: D });
    m.answer({ ok: true, data: {} });
    await m.flush();
    expect(m.status()).toBe('Deleted Depot docs.');
    expect(m.row(D)).toBeNull();
  });

  it('deleting a floor with workers says who moves where, and sends move_workers', async () => {
    const m = mount();
    m.click(`delete:${V}`);
    const box = m.row(V).querySelector<HTMLElement>('.settings-fl-confirm')!;
    expect(box.textContent).toContain('Mochi and Pixel work on it. Deleting it moves these 2 workers to herdr-3d, session herdr-3d’s own floor, at its free desks');
    expect(m.key(`delete-ok:${V}`).textContent).toBe('Move 2 workers and delete');
    m.click(`delete-ok:${V}`);
    expect(m.sent).toEqual([{ t: 'floor.delete', args: { floor: V, move_workers: true } }]);
    m.answer({ ok: true, data: {} });
    await m.flush();
    expect(m.status()).toBe('Deleted Frontend. Mochi and Pixel moved to herdr-3d.');
  });

  it('a plain delete the bridge refuses for workers this client does not see offers the move', async () => {
    const m = mount();
    m.click(`delete:${D}`);
    m.click(`delete-ok:${D}`);
    m.answer({ ok: false, code: 'invalid_state', message: 'invalid state: floor “Depot docs” has 1 worker: Tofu: send them home or move them to its base floor first' });
    await m.flush();
    const box = m.row(D).querySelector<HTMLElement>('.settings-fl-confirm')!;
    expect(box.querySelector('[role="alert"]')?.textContent).toBe('Floor “Depot docs” has 1 worker: Tofu: send them home or move them to its base floor first.');
    expect(m.key(`delete-ok:${D}`).textContent).toBe('Move its workers and delete');
    m.click(`delete-ok:${D}`);
    expect(m.sent[1]).toEqual({ t: 'floor.delete', args: { floor: D, move_workers: true } });
  });

  it('hides and shows a floor, and explains what a hidden floor does', async () => {
    const m = mount();
    expect(m.body.textContent).toContain('It shows again as soon as a worker is on it');
    m.click('hide:herdr-3d');
    expect(m.sent).toEqual([{ t: 'floor.hide', args: { floor: 'herdr-3d', hidden: true } }]);
    expect(m.key('hide:herdr-3d').disabled).toBe(true);
    m.store.applyEvent({ t: 'floor.upsert', seq: 2, floor: floor('herdr-3d', { hidden: true }) });
    m.answer({ ok: true, data: {} });
    await m.flush();
    expect(m.status()).toBe('herdr-3d is hidden. It stays listed while Nibble works on it.');
    expect(m.key('hide:herdr-3d').textContent).toBe('Show');
    expect(document.activeElement).toBe(m.key('hide:herdr-3d'));
    m.click('hide:pastry');
    expect(m.sent[1]).toEqual({ t: 'floor.hide', args: { floor: 'pastry', hidden: false } });
    m.answer({ ok: false, code: 'unknown_session', message: 'unknown session: "pastry"' });
    await m.flush();
    expect(m.status()).toBe('“pastry” is gone: its herdr session is away.');
    expect(m.body.querySelector('.settings-status')?.classList.contains('settings-field-error')).toBe(true);
  });

  it('a bridge without the commands: the controls say so and send nothing', () => {
    const m = mount({ unsupported: ['floor.rename', 'floor.delete', 'floor.hide'] });
    expect(m.key(`rename:${V}`).disabled).toBe(true);
    expect(m.key(`delete:${V}`).title).toBe('This herdr-world can’t delete virtual floors yet. Update the bridge to use it.');
    expect(m.key('hide:pastry').disabled).toBe(true);
  });
});
