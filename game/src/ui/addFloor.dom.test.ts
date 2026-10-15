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

function setup(o: { unsupported?: boolean | ((t: string) => boolean); here?: string } = {}) {
  const store = new WorldStore(0);
  const front: Floor = { id: 'v-00000000f0e1', name: 'Frontend', session: 'herdr-3d', base_session: 'herdr-3d', virtual: true, state: 'running', building: null, index: null };
  const snap: Snapshot = {
    t: 'world.snapshot',
    seq: 1,
    world: { buildings: [], unassigned: ['pastry', 'herdr-3d', front.id!], floors: [floor('pastry'), { ...floor('herdr-3d'), state: 'asleep' }, front], workers: [] },
  };
  store.applySnapshot(snap);
  const replies: Array<ReturnType<typeof later<CommandResult>>> = [];
  const send = vi.fn(() => {
    const l = later<CommandResult>();
    replies.push(l);
    return l.p;
  });
  const unsupported = (t: string) => (typeof o.unsupported === 'function' ? o.unsupported(t) : !!o.unsupported);
  const host: AddFloorHost = { store, send: send as unknown as AddFloorHost['send'], unsupported, toast: vi.fn(), added: vi.fn(), here: () => o.here ?? null };
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
  const base = el.querySelector('#af-base') as HTMLSelectElement;
  const baseHint = el.querySelector('#af-base-hint') as HTMLElement;
  const pick = (kind: 'session' | 'virtual') => {
    const r = el.querySelector(`#af-kind-${kind}`) as HTMLInputElement;
    r.checked = true;
    r.dispatchEvent(new Event('change', { bubbles: true }));
  };
  return { store, host, send, replies, opener, dlg, el, input, hint, add, type, submit, flush, base, baseHint, pick };
}

describe('AddFloorDialog (#58)', () => {
  it('opens on a new herdr session, with focus in the name', () => {
    const t = setup();
    t.dlg.open(t.opener);
    expect(t.el.open).toBe(true);
    expect(document.activeElement).toBe(t.input);
    const kinds = [...t.el.querySelectorAll<HTMLInputElement>('input[name="af-kind"]')];
    expect(kinds.map((k) => [k.value, k.checked])).toEqual([
      ['session', true],
      ['virtual', false],
    ]);
    expect(t.el.querySelector('.dd-choice')?.textContent).toContain('New herdr session');
    expect((t.el.querySelector('.af-base') as HTMLElement).hidden).toBe(true);
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
    expect(t.host.added).toHaveBeenCalledWith('billing-api', 'session');
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

  describe('a virtual floor on an existing session (stage 4)', () => {
    it('asks for a free-text name and a base session, never a building', () => {
      const t = setup({ here: 'pastry' });
      t.dlg.open(t.opener);
      t.pick('virtual');
      expect(t.el.querySelector('#af-name-label')?.textContent).toBe('Floor name');
      expect(t.el.querySelector('#af-sub')?.textContent).toBe('It starts empty, in its session’s building.');
      expect(t.input.classList.contains('af-name--free')).toBe(true);
      expect((t.el.querySelector('.af-base') as HTMLElement).hidden).toBe(false);
      // The real floors' sessions (asleep said so), never a virtual floor; the floor you are on picked.
      expect([...t.base.options].map((o) => [o.value, o.textContent])).toEqual([
        ['herdr-3d', 'herdr-3d · asleep'],
        ['pastry', 'pastry'],
      ]);
      expect(t.base.value).toBe('pastry');
      // No building to pick (decision 4): the name and the session are the only fields.
      expect([...t.el.querySelectorAll('input:not([type="radio"]), select')].filter((e) => !(e.closest('[hidden]'))).map((e) => e.id)).toEqual(['af-name', 'af-base']);
      // Free text: what a session name refuses is fine here; blank is not.
      t.type('Back office');
      expect(t.dlg.summary()).toMatchObject({ floorKind: 'virtual', base: 'pastry', bases: ['herdr-3d', 'pastry'], error: '' });
      t.type('   ');
      t.submit();
      expect(t.dlg.summary()?.error).toBe('Give the floor a name.');
      expect(t.send).not.toHaveBeenCalled();
      // Back to a new session: the session rule again.
      t.type('Back office');
      t.pick('session');
      expect(t.el.querySelector('#af-name-label')?.textContent).toBe('Session name');
      expect(t.dlg.summary()?.error).toBe('Use only lowercase letters, digits, “_” and “-”.');
    });

    it('sends floor.create with the trimmed name and the picked session, and hands the new floor on', async () => {
      const t = setup();
      t.dlg.open(t.opener, { kind: 'virtual' });
      expect((t.el.querySelector('#af-kind-virtual') as HTMLInputElement).checked).toBe(true);
      t.base.value = 'herdr-3d';
      t.base.dispatchEvent(new Event('change', { bubbles: true }));
      t.type('  Frontend 2  ');
      t.submit();
      expect(t.send).toHaveBeenCalledWith('floor.create', { name: 'Frontend 2', base_session: 'herdr-3d' });
      expect(t.dlg.summary()).toMatchObject({ state: 'busy', status: 'Adding “Frontend 2” on session herdr-3d…' });
      expect(t.add.textContent).toBe('Adding floor…');
      expect(t.base.disabled).toBe(true);
      t.replies[0]!.done({ ok: true, data: { id: 'v-0000000000aa', name: 'Frontend 2', session: 'herdr-3d', base_session: 'herdr-3d', virtual: true, state: 'asleep', building: null, index: null } });
      await t.flush();
      expect(t.el.open).toBe(false);
      expect(t.host.added).toHaveBeenCalledWith('v-0000000000aa', 'virtual');
      expect(document.activeElement).toBe(t.opener);
    });

    it('an opener’s own added takes the new floor instead of the host’s', async () => {
      const t = setup();
      const mine = vi.fn();
      t.dlg.open(t.opener, { kind: 'virtual', added: mine });
      t.type('Docs');
      t.submit();
      t.replies[0]!.done({ ok: true, data: { id: 'v-0000000000ab', name: 'Docs', session: 'herdr-3d', state: 'running', building: null, index: null } });
      await t.flush();
      expect(mine).toHaveBeenCalledWith('v-0000000000ab', 'virtual');
      expect(t.host.added).not.toHaveBeenCalled();
      // The next opening without one goes back to the host's.
      t.dlg.open(t.opener);
      t.type('next');
      t.submit();
      t.replies[1]!.done({ ok: true, data: { session: 'next' } });
      await t.flush();
      expect(t.host.added).toHaveBeenCalledWith('next', 'session');
    });

    it('puts the bridge’s refusals where they belong: the name, the session, else the footer', async () => {
      const t = setup();
      t.dlg.open(null, { kind: 'virtual' });
      t.type('Docs');
      t.submit();
      t.replies[0]!.done({ ok: false, code: 'bad_request', message: 'invalid argument: floor name has control characters' });
      await t.flush();
      expect(t.dlg.summary()?.error).toBe('Floor name has control characters.');
      expect(t.input.getAttribute('aria-invalid')).toBe('true');
      t.submit();
      t.replies[1]!.done({ ok: false, code: 'unknown_session', message: 'unknown session: "herdr-3d" is outside the sessions this bridge watches (--sessions h3d-*)' });
      await t.flush();
      expect(t.baseHint.textContent).toBe('"herdr-3d" is outside the sessions this bridge watches (--sessions h3d-*).');
      expect(t.base.getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(t.base);
      t.submit();
      t.replies[2]!.done({ ok: false, code: 'internal', message: 'database is locked' });
      await t.flush();
      expect(t.dlg.summary()).toMatchObject({ status: 'herdr-world failed: database is locked. Safe to retry.', statusError: true });
    });

    it('a bridge without floor.create says so for that kind only', () => {
      const t = setup({ unsupported: (c) => c === 'floor.create' });
      t.dlg.open();
      expect(t.dlg.summary()?.off).toBeNull();
      t.pick('virtual');
      expect(t.dlg.summary()?.off).toBe('This herdr-world can’t add virtual floors yet. Update the bridge to use it.');
      t.type('Docs');
      t.submit();
      expect(t.send).not.toHaveBeenCalled();
    });
  });
});
