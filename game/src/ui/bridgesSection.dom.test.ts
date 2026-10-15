// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeApi, BridgeBook, type BridgeEntry, type BridgeFields, type BridgeList } from '../net/bridges';
import { bridgesSection } from './bridgesSection';
import { SettingsDialog } from './settings';

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

type Row = Omit<BridgeEntry, 'active' | 'address'>;

/** A helper that keeps the list and refuses like h3d-helper does (its words), behind `fetch`. */
function fakeHelper(rows: Row[], active: string) {
  let n = 0;
  const state = { rows: rows.map((r) => ({ ...r })), active };
  const calls: Array<{ method: string; url: string; body?: unknown; token: string | undefined }> = [];
  const list = (): BridgeList => ({
    active: state.active,
    bridges: state.rows.map((r) => ({ ...r, active: r.id === state.active, address: r.kind === 'local' ? (r.socket ?? '') : r.remote_socket ? `${r.host}:${r.remote_socket}` : (r.host ?? '') })),
  });
  const answer = (status: number, body: unknown) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });
  const refuse = (status: number, message: string) => answer(status, { t: 'error', code: 'invalid', message });
  const check = (f: BridgeFields, id: string | null): string | null => {
    const name = f.name.trim();
    if (!name) return 'name is empty';
    if (state.rows.some((r) => r.id !== id && r.name.toLowerCase() === name.toLowerCase())) return `a bridge named "${name}" exists already: pick another name`;
    if (f.kind === 'ssh' && !f.host) return 'host is empty: want [user@]host';
    if (f.kind === 'ssh' && f.host?.startsWith('-')) return `host "${f.host}" starts with '-': want [user@]host`;
    if (f.kind === 'local' && !f.socket?.startsWith('/')) return `socket "${f.socket}" is not an absolute path (it starts with /)`;
    return null;
  };
  const fetch = vi.fn((url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(String(init.body)) as BridgeFields) : undefined;
    calls.push({ method, url, ...(body ? { body } : {}), token: (init.headers as Record<string, string>)['x-h3d-token'] });
    const m = /^\/api\/bridges(?:\/(\w+))?(\/activate)?$/.exec(url);
    const id = m?.[1] ?? null;
    const row = state.rows.find((r) => r.id === id);
    if (method === 'GET') return answer(200, list());
    if (method === 'POST' && !id && body) {
      const why = check(body, null);
      if (why) return refuse(400, why);
      const r: Row = { id: `b${++n}`.padEnd(10, '0'), name: body.name.trim(), kind: body.kind, ...(body.kind === 'local' ? { socket: body.socket ?? '' } : { host: body.host ?? '', remote_socket: body.remote_socket ?? '' }), state: 'connecting' };
      state.rows.push(r);
      if (!state.active) state.active = r.id;
      return answer(200, list());
    }
    if (!row) return refuse(404, `no bridge ${id}`);
    if (method === 'PUT' && body) {
      const why = check(body, row.id);
      if (why) return refuse(400, why);
      Object.assign(row, { name: body.name.trim(), kind: body.kind, host: body.host, remote_socket: body.remote_socket, socket: body.socket });
      return answer(200, list());
    }
    if (method === 'DELETE') {
      if (row.id === state.active) return refuse(409, `${row.name} is the bridge in use: switch to another bridge before removing it`);
      state.rows = state.rows.filter((r) => r !== row);
      return answer(200, list());
    }
    if (method === 'POST' && m?.[2]) {
      state.active = row.id;
      return answer(200, list());
    }
    return refuse(405, 'method not allowed');
  });
  return { fetch, calls, state, list };
}

const devbox: Row = { id: 'aaaaaaaaaa', name: 'devbox', kind: 'ssh', host: 'dev@devbox', state: 'up', version: 'v1.2.0' };
const laptop: Row = { id: 'bbbbbbbbbb', name: 'Laptop', kind: 'local', socket: '/run/user/1000/herdr-world/bridge.sock', state: 'backoff', last_error: 'dial unix /run/user/1000/herdr-world/bridge.sock: connect: no such file or directory' };

async function mount(rows: Row[], active: string, helper = true) {
  const fake = fakeHelper(rows, active);
  const book = new BridgeBook(helper ? new BridgeApi('t0k', fake.fetch) : null, 60_000);
  if (helper) await book.refresh();
  const switchTo = vi.fn<(b: BridgeEntry) => void>();
  const reconnect = vi.fn<(b: BridgeEntry) => void>();
  const dialog = new SettingsDialog(document.body);
  dialog.addSection('time', 'Day and night', () => {}, { store: 'browser', group: 'general' });
  dialog.addSection('bridges', 'Bridges', bridgesSection({ book, switchTo, reconnect }), { store: 'helper', group: 'general' });
  dialog.open();
  dialog.reveal('bridges');
  const root = document.querySelector<HTMLElement>('[data-section="bridges"]')!;
  const rowsEl = () => [...root.querySelectorAll<HTMLElement>('.settings-br-row')];
  const rowOf = (name: string) => rowsEl().find((r) => r.querySelector('.settings-br-name')?.textContent === name)!;
  const btn = (name: string, label: string) => rowOf(name).querySelector<HTMLButtonElement>(`button[aria-label="${label} ${name}"]`)!;
  const addForm = root.querySelector<HTMLFormElement>('form[aria-label="Add a bridge"]')!;
  const field = (form: HTMLElement, label: string) => {
    const l = [...form.querySelectorAll('label')].find((x) => x.textContent === label)!;
    return form.querySelector<HTMLInputElement | HTMLSelectElement>(`#${CSS.escape(l.htmlFor)}`)!;
  };
  const set = (input: HTMLInputElement | HTMLSelectElement, v: string) => {
    input.value = v;
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  };
  const submit = async (form: HTMLFormElement) => {
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(root.querySelector('.settings-status')?.textContent).not.toBe('Saving…'));
  };
  const status = () => root.querySelector<HTMLElement>('.settings-status')!;
  return { fake, book, dialog, root, rowsEl, rowOf, btn, addForm, field, set, submit, status, switchTo, reconnect };
}

describe('Settings → Bridges (#57)', () => {
  it('is kept by the helper, lists each bridge with its state, address and the one in use', async () => {
    const t = await mount([devbox, laptop], devbox.id);
    expect(t.root.hidden).toBe(false);
    expect(t.root.querySelector('.settings-store')?.textContent).toBe('This helper');
    expect(t.rowsEl().map((r) => r.querySelector('.settings-br-name')?.textContent)).toEqual(['devbox', 'Laptop']);
    const d = t.rowOf('devbox');
    expect(d.querySelector('.settings-badge')?.textContent).toBe('In use');
    expect(d.querySelector('.br-dot')?.getAttribute('data-tone')).toBe('up');
    expect(d.querySelector('.settings-br-meta')?.textContent).toBe('dev@devbox · Online · v1.2.0');
    expect(d.querySelector('button[aria-label="Use devbox"]')).toBeNull();
    const l = t.rowOf('Laptop');
    expect(l.querySelector('.settings-badge')).toBeNull();
    expect(l.querySelector('.br-dot')?.getAttribute('data-tone')).toBe('down');
    expect(l.querySelector('.settings-br-meta')?.textContent).toBe('/run/user/1000/herdr-world/bridge.sock · Offline, retrying');
    expect(l.querySelector('.settings-br-why')?.textContent).toContain('no such file or directory');
    // Every request carries the token in its header, never in the URL.
    expect(t.fake.calls.every((c) => c.token === 't0k' && !c.url.includes('t0k'))).toBe(true);
  });

  it('has no section on a page no helper serves', async () => {
    const t = await mount([], '', false);
    expect(t.dialog.sectionIds).toContain('bridges');
    expect(t.root.hidden).toBe(true);
    expect(document.querySelector('[data-tab="bridges"]')?.hasAttribute('hidden')).toBe(true);
  });

  it('adds ssh and local bridges, showing the helper’s refusal under the form in its words', async () => {
    const t = await mount([devbox], devbox.id);
    const f = t.addForm;
    t.set(t.field(f, 'Name'), 'Bad');
    t.set(t.field(f, 'ssh destination'), '-oProxyCommand=x');
    await t.submit(f);
    const err = f.querySelector<HTMLElement>('.settings-br-error')!;
    expect(err.hidden).toBe(false);
    expect(err.textContent).toBe(`Host "-oProxyCommand=x" starts with '-': want [user@]host.`);
    expect(t.field(f, 'ssh destination').getAttribute('aria-invalid')).toBe('true');
    expect(t.rowsEl()).toHaveLength(1);
    // Typing again clears it.
    t.set(t.field(f, 'ssh destination'), 'me@gpu-box');
    expect(err.hidden).toBe(true);
    t.set(t.field(f, 'Name'), 'GPU box');
    await t.submit(f);
    expect(t.rowsEl().map((r) => r.querySelector('.settings-br-name')?.textContent)).toEqual(['devbox', 'GPU box']);
    expect(t.fake.calls.at(-1)).toMatchObject({ method: 'POST', url: '/api/bridges', body: { name: 'GPU box', kind: 'ssh', host: 'me@gpu-box', remote_socket: '' } });
    expect(t.status().textContent).toContain('Added GPU box.');
    // A local one: the kind swaps the fields.
    t.set(t.field(f, 'Where it runs'), 'local');
    expect(t.field(f, 'ssh destination').closest('.settings-field')?.hasAttribute('hidden')).toBe(true);
    t.set(t.field(f, 'Name'), 'Here');
    t.set(t.field(f, 'Bridge socket'), 'bridge.sock');
    await t.submit(f);
    expect(f.querySelector('.settings-br-error')?.textContent).toContain('not an absolute path');
    t.set(t.field(f, 'Bridge socket'), '/run/user/1000/herdr-world/bridge.sock');
    await t.submit(f);
    expect(t.fake.calls.at(-1)?.body).toEqual({ name: 'Here', kind: 'local', socket: '/run/user/1000/herdr-world/bridge.sock' });
    expect(t.rowsEl()).toHaveLength(3);
    expect(t.reconnect).not.toHaveBeenCalled();
  });

  it('connects at once to the first bridge added to an empty helper', async () => {
    const t = await mount([], '');
    expect(t.root.querySelector('.settings-br-empty')?.textContent).toBe('No bridge configured: add the machine that runs herdr-world below.');
    t.set(t.field(t.addForm, 'Name'), 'devbox');
    t.set(t.field(t.addForm, 'ssh destination'), 'dev@devbox');
    await t.submit(t.addForm);
    expect(t.reconnect).toHaveBeenCalledWith(expect.objectContaining({ name: 'devbox', active: true }));
  });

  it('renames and edits a bridge in place; a new address for the one in use reconnects', async () => {
    const t = await mount([devbox, laptop], devbox.id);
    t.btn('Laptop', 'Rename').click();
    const rename = t.rowOf('Laptop').querySelector<HTMLFormElement>('form[aria-label="Rename Laptop"]')!;
    expect(document.activeElement).toBe(t.field(rename, 'Name'));
    // Only the name: no address fields.
    expect(t.field(rename, 'ssh destination').closest('.settings-field')?.hasAttribute('hidden')).toBe(true);
    expect(t.field(rename, 'Bridge socket').closest('.settings-field')?.hasAttribute('hidden')).toBe(true);
    t.set(t.field(rename, 'Name'), 'DEVBOX');
    await t.submit(rename);
    expect(rename.querySelector('.settings-br-error')?.textContent).toBe('A bridge named "DEVBOX" exists already: pick another name.');
    // A poll while the form is open keeps what was typed and where the keyboard is.
    t.field(rename, 'Name').focus();
    await t.book.refresh();
    expect(t.rowOf('Laptop').querySelector('form')).toBe(rename);
    expect(document.activeElement).toBe(t.field(rename, 'Name'));
    t.set(t.field(rename, 'Name'), 'Desk');
    await t.submit(rename);
    expect(t.fake.calls.at(-1)).toMatchObject({ method: 'PUT', url: '/api/bridges/bbbbbbbbbb', body: { name: 'Desk', kind: 'local', socket: laptop.socket } });
    expect(t.rowOf('Desk').querySelector('form')).toBeNull();

    t.btn('devbox', 'Edit').click();
    const edit = t.rowOf('devbox').querySelector<HTMLFormElement>('form[aria-label="Edit devbox"]')!;
    expect(t.field(edit, 'ssh destination').value).toBe('dev@devbox');
    t.set(t.field(edit, 'Bridge socket on that host (optional)'), '/run/user/1001/herdr-world/bridge.sock');
    await t.submit(edit);
    expect(t.fake.calls.at(-1)?.body).toEqual({ name: 'devbox', kind: 'ssh', host: 'dev@devbox', remote_socket: '/run/user/1001/herdr-world/bridge.sock' });
    expect(t.reconnect).toHaveBeenCalledWith(expect.objectContaining({ id: devbox.id }));
  });

  it('removes a bridge, and refuses to remove the one in use without asking the helper', async () => {
    const t = await mount([devbox, laptop], devbox.id);
    const rm = t.btn('devbox', 'Remove');
    expect(rm.getAttribute('aria-disabled')).toBe('true');
    expect(rm.disabled).toBe(false); // focusable: it says why
    const before = t.fake.calls.length;
    rm.click();
    await Promise.resolve();
    expect(t.fake.calls.length).toBe(before);
    expect(t.status().textContent).toBe('devbox is the bridge in use: switch to another bridge before removing it.');
    expect(t.status().classList.contains('settings-field-error')).toBe(true);
    expect(t.rowsEl()).toHaveLength(2);
    t.btn('Laptop', 'Remove').click();
    await vi.waitFor(() => expect(t.rowsEl()).toHaveLength(1));
    expect(t.fake.calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/bridges/bbbbbbbbbb' });
    expect(t.status().textContent).toBe('Removed Laptop.');
  });

  it('shows the helper’s refusal when it refuses a removal itself', async () => {
    const t = await mount([devbox, laptop], devbox.id);
    // Another tab switched to the laptop meanwhile: this page still thinks devbox is in use.
    t.fake.state.active = laptop.id;
    t.btn('Laptop', 'Remove').click();
    await vi.waitFor(() => expect(t.status().textContent).toBe('Laptop is the bridge in use: switch to another bridge before removing it.'));
    expect(t.rowsEl()).toHaveLength(2);
  });

  it('Use switches through the game', async () => {
    const t = await mount([devbox, laptop], devbox.id);
    t.btn('Laptop', 'Use').click();
    expect(t.switchTo).toHaveBeenCalledWith(expect.objectContaining({ id: laptop.id, name: 'Laptop' }));
  });

  it('reads the states again while Settings is open, and stops when it closes', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeHelper([devbox, laptop], devbox.id);
      const book = new BridgeBook(new BridgeApi('t0k', fake.fetch), 2000);
      await book.refresh();
      const dialog = new SettingsDialog(document.body);
      dialog.addSection('bridges', 'Bridges', bridgesSection({ book, switchTo: () => {}, reconnect: () => {} }), { store: 'helper', group: 'general' });
      dialog.open();
      const gets = () => fake.calls.filter((c) => c.method === 'GET').length;
      const start = gets();
      fake.state.rows[1]!.state = 'up';
      await vi.advanceTimersByTimeAsync(2100);
      expect(gets()).toBeGreaterThan(start);
      expect(document.querySelector('.settings-br-row[data-id="bbbbbbbbbb"] .br-dot')?.getAttribute('data-tone')).toBe('up');
      dialog.close();
      const after = gets();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(gets()).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });
});
