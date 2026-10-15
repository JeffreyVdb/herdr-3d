// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { Floor, Snapshot } from '../net/protocol';
import { WorldStore } from '../world/store';
import { AddFloorDialog, type AddFloorHost } from './addFloor';

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

const floor = (session: string): Floor => ({ session, state: 'running', building: null, index: 0 });

/** A promise the test resolves by hand: the bridge's answer, when the test says. */
function later<T>() {
  let done!: (v: T) => void;
  const p = new Promise<T>((r) => (done = r));
  return { p, done };
}

function setup(o: { unsupported?: boolean } = {}) {
  const store = new WorldStore(0);
  const snap: Snapshot = { t: 'world.snapshot', seq: 1, world: { buildings: [], unassigned: ['pastry'], floors: [floor('pastry')], workers: [] } };
  store.applySnapshot(snap);
  const replies: Array<ReturnType<typeof later<CommandResult>>> = [];
  const send = vi.fn(() => {
    const l = later<CommandResult>();
    replies.push(l);
    return l.p;
  });
  const host: AddFloorHost = { store, send: send as unknown as AddFloorHost['send'], unsupported: () => !!o.unsupported, toast: vi.fn(), added: vi.fn() };
  const opener = document.body.appendChild(document.createElement('button'));
  opener.focus();
  const dlg = new AddFloorDialog(document.body, host);
  const el = document.querySelector('dialog.desk-dlg--addfloor') as HTMLDialogElement;
  const input = el.querySelector('#af-name') as HTMLInputElement;
  const hint = el.querySelector('#af-name-hint') as HTMLElement;
  const add = el.querySelector('[data-key="add"]') as HTMLButtonElement;
  const form = el.querySelector('form') as HTMLFormElement;
  const type = (v: string) => {
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const submit = () => form.dispatchEvent(new Event('submit', { cancelable: true }));
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { store, host, send, replies, opener, dlg, el, input, hint, add, type, submit, flush };
}

describe('AddFloorDialog (#58)', () => {
  it('opens on the one kind there is, with focus in the name', () => {
    const t = setup();
    t.dlg.open(t.opener);
    expect(t.el.open).toBe(true);
    expect(document.activeElement).toBe(t.input);
    const kinds = [...t.el.querySelectorAll<HTMLInputElement>('input[name="af-kind"]')];
    expect(kinds.map((k) => [k.value, k.checked])).toEqual([['session', true]]);
    expect(t.el.querySelector('.dd-choice')?.textContent).toContain('New herdr session');
    expect(t.dlg.summary()).toMatchObject({ kind: 'add-floor', state: 'ready', floorKind: 'session', name: '', error: '', off: null });
  });

  it('checks the name as it is typed, like the bridge', () => {
    const t = setup();
    t.dlg.open();
    t.type('Billing');
    expect(t.input.getAttribute('aria-invalid')).toBe('true');
    expect(t.hint.textContent).toBe('Use only lowercase letters, digits, “_” and “-”.');
    expect(t.hint.classList.contains('field-error')).toBe(true);
    t.type('default');
    expect(t.hint.textContent).toBe('“default” is herdr’s own session: pick another name.');
    t.type('pastry');
    expect(t.hint.textContent).toBe('“pastry” is already a floor.');
    t.type('billing');
    expect(t.input.getAttribute('aria-invalid')).toBe('false');
    expect(t.hint.classList.contains('field-error')).toBe(false);
    // Empty is only an error once submitted, and nothing is sent.
    t.type('');
    expect(t.dlg.summary()?.error).toBe('');
    t.submit();
    expect(t.dlg.summary()?.error).toBe('Give the floor a name.');
    expect(t.send).not.toHaveBeenCalled();
  });

  it('sends session.create, shows it starting, and hands the new floor on', async () => {
    const t = setup();
    t.dlg.open(t.opener);
    t.type('billing-api');
    t.submit();
    expect(t.send).toHaveBeenCalledWith('session.create', { name: 'billing-api' });
    expect(t.dlg.summary()).toMatchObject({ state: 'busy', status: 'Starting a herdr server for “billing-api”…' });
    expect(t.add.textContent).toBe('Starting floor…');
    expect(t.add.getAttribute('aria-busy')).toBe('true');
    expect(t.input.disabled).toBe(true);
    t.submit(); // a second Enter sends nothing more
    expect(t.send).toHaveBeenCalledTimes(1);
    t.replies[0]!.done({ ok: true, data: { session: 'billing-api' } });
    await t.flush();
    expect(t.el.open).toBe(false);
    expect(t.host.added).toHaveBeenCalledWith('billing-api');
    expect(document.activeElement).toBe(t.opener);
  });

  it('puts the bridge’s word on a refused name in the field, and herdr’s failure in the footer', async () => {
    const t = setup();
    t.dlg.open();
    t.type('taken');
    t.submit();
    t.replies[0]!.done({ ok: false, code: 'name_taken', message: '“taken” is already a herdr session (asleep): wake its floor instead.' });
    await t.flush();
    expect(t.dlg.summary()).toMatchObject({ state: 'ready', error: '“taken” is already a herdr session (asleep): wake its floor instead.', status: '' });
    expect(t.input.disabled).toBe(false);
    expect(document.activeElement).toBe(t.input);

    t.type('slow');
    t.submit();
    t.replies[1]!.done({ ok: false, code: 'session_create_failed', message: 'herdr started slow, but its floor was not seen running within 10s; it was stopped and removed again.' });
    await t.flush();
    expect(t.dlg.summary()).toMatchObject({ error: '', status: 'herdr started slow, but its floor was not seen running within 10s; it was stopped and removed again.', statusError: true });
    expect(t.el.querySelector('[role="alert"]')?.textContent).toContain('was not seen running');
    expect(t.host.added).not.toHaveBeenCalled();
  });

  it('closed while the floor starts: the result is a toast', async () => {
    const t = setup();
    t.dlg.open();
    t.type('later');
    t.submit();
    t.dlg.close();
    t.replies[0]!.done({ ok: false, code: 'session_create_failed', message: 'herdr did not start later: exit status 1' });
    await t.flush();
    expect(t.host.toast).toHaveBeenCalledWith('herdr did not start later: exit status 1', 'error');
  });

  it('says so on a bridge without session.create, and sends nothing', () => {
    const t = setup({ unsupported: true });
    t.dlg.open();
    expect(t.dlg.summary()?.off).toBe('This herdr-world can’t start new herdr sessions yet. Update the bridge to use it.');
    expect(t.add.getAttribute('aria-disabled')).toBe('true');
    t.type('x');
    t.submit();
    expect(t.send).not.toHaveBeenCalled();
  });

  it('a floor that appears meanwhile takes the name', () => {
    const t = setup();
    t.dlg.open();
    t.type('race');
    expect(t.dlg.summary()?.error).toBe('');
    t.store.applyEvent({ t: 'floor.upsert', seq: 2, floor: floor('race') });
    t.dlg.refresh();
    expect(t.dlg.summary()?.error).toBe('“race” is already a floor.');
  });
});
