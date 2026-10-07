// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { KaneoBook } from '../world/kaneo';
import { kaneoSection } from './kaneoSection';

const saved = (over: Record<string, unknown> = {}) => ({
  state: 'ready',
  available: true,
  url: 'https://tasks.example.test',
  api_base: 'https://tasks.example.test/api',
  web_origin: 'https://tasks.example.test',
  key_set: true,
  default_workspace: { id: 'ws1', name: 'Studio' },
  generation: 1,
  ...over,
});
const off = (over: Record<string, unknown> = {}) => ({ state: 'off', available: true, url: '', api_base: '', web_origin: '', key_set: false, default_workspace: null, generation: 0, ...over });
const passed = (workspaces = [{ id: 'ws1', name: 'Studio' }, { id: 'ws2', name: 'Home' }]): CommandResult => ({
  ok: true,
  data: { ok: true, latency_ms: 120, url: 'https://tasks.example.test', api_base: 'https://tasks.example.test/api', web_origin: 'https://tasks.example.test', workspaces, user: 'Theo' },
});

type Sent = { t: string; args: Record<string, unknown> };

function mount(state: Record<string, unknown> | null, answers: Record<string, (args: Record<string, unknown>) => CommandResult | Promise<CommandResult>> = {}) {
  document.body.replaceChildren();
  const book = new KaneoBook();
  book.reset(state);
  const sent: Sent[] = [];
  const body = document.createElement('div');
  document.body.append(body);
  const handle = kaneoSection({
    book,
    send: ((t: string, args: Record<string, unknown>) => {
      sent.push({ t, args });
      return Promise.resolve((answers[t] ?? (() => ({ ok: true, data: {} })))(args));
    }) as never,
  })(body);
  handle.open?.();
  const btn = (name: string) => [...body.querySelectorAll('button')].find((b) => b.textContent === name)!;
  const input = (label: string) => {
    const l = [...body.querySelectorAll('label')].find((x) => x.textContent === label)!;
    return document.getElementById(l.htmlFor) as HTMLInputElement & HTMLSelectElement;
  };
  const type = (el: HTMLInputElement, v: string) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const status = () => body.querySelector('.settings-status')!.textContent ?? '';
  return { book, body, sent, btn, input, type, flush, handle, status };
}

describe('the Kaneo section (#184)', () => {
  it('says the bridge has no Kaneo support when it sent no state', () => {
    const m = mount(null);
    expect(m.body.textContent).toContain('no Kaneo support');
    expect(m.body.querySelector<HTMLElement>('.settings-kaneo')!.hidden).toBe(true);
  });

  it('masks the key, never shows a saved one, and links Kaneo’s key help', () => {
    const m = mount(saved());
    const key = m.input('API key');
    expect(key.type).toBe('password');
    expect(key.value).toBe('');
    expect(m.body.textContent).toContain('Leave blank to keep it');
    expect(m.body.querySelector<HTMLAnchorElement>('a.settings-link')!.href).toContain('kaneo.app/docs');
    expect(m.input('Instance address').value).toBe('https://tasks.example.test');
  });

  it('Save needs a passing test of exactly the fields; an edit takes it back; the default comes from the test', async () => {
    const m = mount(off(), { 'kaneo.test': () => passed(), 'kaneo.set': () => ({ ok: true, data: saved({ default_workspace: { id: 'ws2', name: 'Home' } }) }) });
    expect(m.btn('Save').disabled).toBe(true);
    expect(m.btn('Test connection').disabled).toBe(true); // no address, no key
    m.type(m.input('Instance address'), 'https://tasks.example.test');
    expect(m.btn('Test connection').disabled).toBe(true); // a first connection needs its key
    m.type(m.input('API key'), 'secret-key-0001');
    expect(m.input('Default workspace').disabled).toBe(true);
    m.btn('Test connection').click();
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'kaneo.test', args: { url: 'https://tasks.example.test', key: 'secret-key-0001' } });
    expect(m.status()).toContain('2 workspaces');
    expect(m.btn('Save').disabled).toBe(false);
    const ws = m.input('Default workspace');
    expect(ws.disabled).toBe(false);
    expect([...ws.options].map((o) => o.textContent)).toEqual(['No default', 'Studio', 'Home']);

    // Editing the key undoes the test.
    m.type(m.input('API key'), 'secret-key-0002');
    expect(m.btn('Save').disabled).toBe(true);
    expect(m.status()).toContain('test again');
    m.type(m.input('API key'), 'secret-key-0001');
    m.btn('Test connection').click();
    await m.flush();
    ws.value = 'ws2';
    ws.dispatchEvent(new Event('change'));
    m.btn('Save').click();
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'kaneo.set', args: { url: 'https://tasks.example.test', key: 'secret-key-0001', default_workspace: 'ws2' } });
    expect(m.input('API key').value).toBe('');
    expect(m.status()).toContain('Saved');
    expect(m.book.state?.default_workspace?.name).toBe('Home');
  });

  it('keeps the saved key for the saved address only: a new address needs its key typed', async () => {
    const m = mount(saved(), { 'kaneo.test': () => passed() });
    expect(m.btn('Test connection').disabled).toBe(false); // blank key: the saved one, same instance
    m.btn('Test connection').click();
    await m.flush();
    expect(m.sent.at(-1)!.args).toEqual({ url: 'https://tasks.example.test' });
    m.type(m.input('Instance address'), 'https://other.example.test');
    expect(m.btn('Test connection').disabled).toBe(true);
    expect(m.body.textContent).toContain('A new address needs its own key');
    m.type(m.input('Instance address'), 'https://tasks.example.test/api');
    expect(m.btn('Test connection').disabled).toBe(false); // the same instance by its API address
  });

  it('a failed test says why and saves nothing; reopening the window drops what was typed', async () => {
    const m = mount(saved(), { 'kaneo.test': () => ({ ok: false, code: 'unauthorized', message: 'x' }) });
    m.type(m.input('API key'), 'bad-key-0001');
    m.btn('Test connection').click();
    await m.flush();
    expect(m.status()).toContain('refused the API key');
    expect(m.status()).toContain('quota');
    expect(m.btn('Save').disabled).toBe(true);
    expect(m.sent.some((s) => s.t === 'kaneo.set')).toBe(false);
    m.type(m.input('Instance address'), 'https://elsewhere.example.test');
    m.handle.open?.(); // closed and opened again: cancel
    expect(m.input('Instance address').value).toBe('https://tasks.example.test');
    expect(m.input('API key').value).toBe('');
  });

  it('an empty workspace list is a working key that cannot link a floor yet', async () => {
    const m = mount(off(), { 'kaneo.test': () => passed([]), 'kaneo.set': () => ({ ok: true, data: saved({ default_workspace: null }) }) });
    m.type(m.input('Instance address'), 'https://tasks.example.test');
    m.type(m.input('API key'), 'secret-key-0001');
    m.btn('Test connection').click();
    await m.flush();
    expect(m.status()).toContain('reaches no workspace');
    expect(m.body.textContent).toContain('no floor can be linked');
    // Saved all the same: the warning stays, never "floors can now use Kaneo".
    m.btn('Save').click();
    await m.flush();
    expect(m.status()).toContain('still reaches no workspace');
    expect(m.status()).not.toContain('can now use Kaneo');
  });

  it('Disconnect asks twice', async () => {
    const m = mount(saved(), { 'kaneo.clear': () => ({ ok: true, data: off({ generation: 2 }) }) });
    m.btn('Disconnect').click();
    expect(m.sent).toHaveLength(0);
    m.btn('Click again to disconnect').click();
    await m.flush();
    expect(m.sent.at(-1)!.t).toBe('kaneo.clear');
    expect(m.book.state?.state).toBe('off');
  });

  it('shows a run-time pause with what to do', () => {
    const m = mount(saved({ state: 'paused', paused_until: Date.now() + 60_000, last_error: { kind: 'unauthorized', message: 'm', at: 1, runtime: true } }));
    expect(m.body.querySelector('.settings-badge')!.textContent).toBe('Paused');
    expect(m.status()).toContain('Test again');
  });
});
