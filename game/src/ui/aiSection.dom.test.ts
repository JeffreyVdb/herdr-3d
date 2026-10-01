// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import { AiBook } from '../world/ai';
import { aiSection } from './aiSection';

const cls = (over: Record<string, unknown> = {}) => ({ state: 'off', model: '', key_set: false, key_hint: '', env: [], ...over });
const llm = (over: Record<string, unknown> = {}) => ({ state: 'off', base_url: '', model: '', key_set: false, key_hint: '', json_mode: null, env: [], ...over });

type Sent = { t: string; args: Record<string, unknown> };

function mount(state: { classifier?: Record<string, unknown>; llm?: Record<string, unknown> } | null, answers: Record<string, (args: Record<string, unknown>) => CommandResult> = {}) {
  document.body.replaceChildren();
  const book = new AiBook();
  book.reset(state && { classifier: cls(state.classifier), llm: llm(state.llm) });
  const sent: Sent[] = [];
  const body = document.createElement('div');
  document.body.append(body);
  const handle = aiSection({
    book,
    send: ((t: string, args: Record<string, unknown>) => {
      sent.push({ t, args });
      return Promise.resolve((answers[t] ?? (() => ({ ok: true, data: {} })))(args));
    }) as never,
  })(body);
  handle.open?.();
  const role = (n: number) => body.querySelectorAll<HTMLElement>('.settings-role')[n]!;
  const btn = (r: HTMLElement, name: string) => [...r.querySelectorAll('button')].find((b) => b.textContent === name)!;
  const input = (r: HTMLElement, label: string) => {
    const l = [...r.querySelectorAll('label')].find((x) => x.textContent === label)!;
    return document.getElementById(l.htmlFor) as HTMLInputElement & HTMLSelectElement;
  };
  const type = (el: HTMLInputElement, v: string) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { book, body, sent, role, btn, input, type, flush, handle };
}

describe('the AI integration section (#92)', () => {
  it('says the bridge has no AI integration when it sent none, and hides the forms', () => {
    const m = mount(null);
    expect(m.body.textContent).toContain('no AI integration');
    expect(m.role(0).hidden).toBe(true);
  });

  it('uses password inputs for both keys and never puts a key in the DOM, even a saved one', () => {
    const m = mount({ classifier: { state: 'ready', model: 'jev-latest', key_set: true, key_hint: 'abcd' }, llm: { state: 'ready', base_url: 'https://x/v1', model: 'm', key_set: true, key_hint: 'wxyz' } });
    for (let i = 0; i < 2; i++) {
      const key = m.role(i).querySelector<HTMLInputElement>('input[type="password"]')!;
      expect(key.value).toBe('');
      expect(key.autocomplete).toBe('new-password');
    }
    expect(m.role(0).textContent).toContain('ending in abcd');
    expect(m.role(0).textContent).toContain('Leave blank to keep it');
  });

  it('Save needs a passing test of exactly what the fields hold; any edit takes it away again', async () => {
    const m = mount({}, { 'ai.test': () => ({ ok: true, data: { ok: true, latency_ms: 350, score: 0.9 } }) });
    const r = m.role(0);
    const save = m.btn(r, 'Save');
    const test = m.btn(r, 'Test');
    expect(test.disabled).toBe(true);
    expect(save.disabled).toBe(true);
    m.type(m.input(r, 'Key'), 'secret-key-123456');
    // The classifier’s model comes from the list: Load models first.
    m.book.reset({ classifier: cls(), llm: llm() });
    expect(test.disabled).toBe(true);
    const models = m.btn(r, 'Load models');
    expect(models.disabled).toBe(false);
  });

  it('loads Jev models with the typed key, preselects jev-latest and shows “Key rejected” for a 401', async () => {
    let n = 0;
    const m = mount({}, {
      'ai.models': () => (n++ === 0 ? { ok: false, code: 'auth_failed', message: 'the key was rejected (HTTP 401)' } : { ok: true, data: { models: [{ id: 'jev-preview', description: 'p' }, { id: 'jev-latest', description: 'l' }] } }),
      'ai.test': () => ({ ok: true, data: { ok: true, latency_ms: 350, score: 0.9 } }),
      'ai.set': () => ({ ok: true, data: {} }),
    });
    const r = m.role(0);
    m.type(m.input(r, 'Key'), 'bad-key-1234567');
    m.btn(r, 'Load models').click();
    await m.flush();
    expect(r.textContent).toContain('Key rejected');
    expect(m.sent[0]).toEqual({ t: 'ai.models', args: { role: 'classifier', key: 'bad-key-1234567' } });
    m.type(m.input(r, 'Key'), 'good-key-1234567');
    m.btn(r, 'Load models').click();
    await m.flush();
    const sel = m.input(r, 'Model');
    expect(sel.value).toBe('jev-latest');
    expect(m.btn(r, 'Test').disabled).toBe(false);
    expect(m.btn(r, 'Save').disabled).toBe(true);
    m.btn(r, 'Test').click();
    await m.flush();
    expect(r.textContent).toContain('Test passed in 350 ms');
    expect(m.sent.at(-1)).toEqual({ t: 'ai.test', args: { role: 'classifier', key: 'good-key-1234567', model: 'jev-latest' } });
    expect(m.btn(r, 'Save').disabled).toBe(false);
    // An edit after the test: Save is off again.
    m.type(m.input(r, 'Key'), 'other-key-1234567');
    expect(m.btn(r, 'Save').disabled).toBe(true);
    m.type(m.input(r, 'Key'), 'good-key-1234567');
    expect(m.btn(r, 'Save').disabled).toBe(false);
    m.btn(r, 'Save').click();
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'ai.set', args: { role: 'classifier', key: 'good-key-1234567', model: 'jev-latest' } });
    // The key field is emptied after the save: the game keeps no key.
    expect(m.input(r, 'Key').value).toBe('');
    expect(r.textContent).toContain('Saved');
  });

  it('a blank key on an already keyed role is “keep the current key”: no key is sent', async () => {
    const m = mount({ classifier: { state: 'ready', model: 'jev-latest', key_set: true, key_hint: 'abcd' } }, { 'ai.test': () => ({ ok: true, data: { ok: true, latency_ms: 20 } }) });
    const r = m.role(0);
    m.btn(r, 'Test').click();
    await m.flush();
    expect(m.sent[0]).toEqual({ t: 'ai.test', args: { role: 'classifier', model: 'jev-latest' } });
    expect('key' in m.sent[0]!.args).toBe(false);
  });

  it('the LLM: the base URL placeholder, model list from the bridge (with the resolved URL), a typed model, extra fields', async () => {
    const m = mount({}, {
      'ai.models': () => ({ ok: true, data: { models: [{ id: 'mimo-v2.6-flash' }], base_url: 'https://api.example.com/v1' } }),
      'ai.test': () => ({ ok: true, data: { ok: true, latency_ms: 1600, json_mode: false, base_url: 'https://api.example.com/v1' } }),
    });
    const r = m.role(1);
    const base = m.input(r, 'Base URL');
    expect(base.placeholder).toBe('https://api.xiaomimimo.com/v1');
    m.type(base, 'https://api.example.com');
    m.type(m.input(r, 'API key'), 'sk-abcdefghijkl');
    m.btn(r, 'Load models').click();
    await m.flush();
    expect(m.sent[0]).toEqual({ t: 'ai.models', args: { role: 'llm', base_url: 'https://api.example.com', key: 'sk-abcdefghijkl' } });
    expect(base.value).toBe('https://api.example.com/v1');
    expect(r.querySelectorAll('datalist option')).toHaveLength(1);
    m.type(m.input(r, 'Model'), 'mimo-v2.6-flash');
    m.type(m.input(r, 'Extra request fields (JSON)'), '{"thinking": {"type": "disabled"}}');
    m.btn(r, 'Test').click();
    await m.flush();
    expect(m.sent.at(-1)!.args).toEqual({ role: 'llm', base_url: 'https://api.example.com/v1', key: 'sk-abcdefghijkl', model: 'mimo-v2.6-flash', extra_body: { thinking: { type: 'disabled' } } });
    expect(r.textContent).toContain('ignores JSON mode');
    // Bad extra JSON is said, not sent.
    const before = m.sent.length;
    m.type(m.input(r, 'Extra request fields (JSON)'), '[1]');
    expect(m.btn(r, 'Test').disabled).toBe(true);
    m.btn(r, 'Test').click();
    await m.flush();
    expect(m.sent).toHaveLength(before);
    expect(r.textContent).toContain('must be a JSON object');
  });

  it('Test before Load models: the resolved base URL replaces the typed one and Save sends exactly that', async () => {
    const m = mount({}, {
      'ai.test': () => ({ ok: true, data: { ok: true, latency_ms: 40, json_mode: true, base_url: 'https://api.example.com/v1' } }),
      'ai.set': () => ({ ok: true, data: {} }),
    });
    const r = m.role(1);
    const base = m.input(r, 'Base URL');
    m.type(base, 'https://api.example.com');
    m.type(m.input(r, 'API key'), 'sk-abcdefghijkl');
    m.type(m.input(r, 'Model'), 'mimo-v2.6-flash');
    expect(m.btn(r, 'Save').disabled).toBe(true);
    m.btn(r, 'Test').click();
    await m.flush();
    expect(m.sent[0]).toEqual({ t: 'ai.test', args: { role: 'llm', base_url: 'https://api.example.com', key: 'sk-abcdefghijkl', model: 'mimo-v2.6-flash' } });
    expect(base.value).toBe('https://api.example.com/v1');
    expect(m.btn(r, 'Save').disabled).toBe(false);
    m.btn(r, 'Save').click();
    await m.flush();
    expect(m.sent.at(-1)).toEqual({ t: 'ai.set', args: { role: 'llm', base_url: 'https://api.example.com/v1', key: 'sk-abcdefghijkl', model: 'mimo-v2.6-flash' } });
  });

  it('a missing /models offers the typed id; an LLM may be tested without a key', async () => {
    const m = mount({}, { 'ai.models': () => ({ ok: false, code: 'no_models_endpoint', message: 'x' }), 'ai.test': () => ({ ok: true, data: { ok: true, latency_ms: 5 } }) });
    const r = m.role(1);
    m.type(m.input(r, 'Base URL'), 'http://127.0.0.1:11434/v1');
    m.btn(r, 'Load models').click();
    await m.flush();
    expect(r.textContent).toContain('Type the model id instead');
    m.type(m.input(r, 'Model'), 'llama3');
    expect(m.btn(r, 'Test').disabled).toBe(false);
    m.btn(r, 'Test').click();
    await m.flush();
    expect(m.sent.at(-1)!.args).toEqual({ role: 'llm', base_url: 'http://127.0.0.1:11434/v1', model: 'llama3' });
  });

  it('fields the bridge environment sets are read-only and not sent', async () => {
    const m = mount({ classifier: { state: 'ready', model: 'jev-preview', key_set: true, key_hint: 'abcd', env: ['key', 'model'] } }, { 'ai.test': () => ({ ok: true, data: { ok: true, latency_ms: 20 } }) });
    const r = m.role(0);
    expect(m.input(r, 'Key').disabled).toBe(true);
    expect(m.input(r, 'Model').disabled).toBe(true);
    expect(r.textContent).toContain('Set by the bridge environment');
    m.btn(r, 'Test').click();
    await m.flush();
    expect(m.sent[0]).toEqual({ t: 'ai.test', args: { role: 'classifier' } });
  });

  it('shows a paused role with the reason, and Clear asks twice', async () => {
    const m = mount({ classifier: { state: 'ready', model: 'jev-latest', key_set: true, key_hint: 'abcd' } }, { 'ai.clear': () => ({ ok: true, data: {} }) });
    m.book.upsert({ t: 'ai.update', classifier: cls({ state: 'invalid', model: 'jev-latest', key_set: true, key_hint: 'abcd' }), llm: llm(), last_error: { role: 'classifier', kind: 'auth_failed', message: 'x', at: 1, runtime: true } });
    const r = m.role(0);
    expect(r.querySelector('.settings-badge')!.textContent).toBe('Paused');
    expect(r.textContent).toContain('Key rejected');
    const clear = m.btn(r, 'Clear');
    clear.click();
    expect(m.sent).toHaveLength(0);
    expect(clear.textContent).toBe('Click again to clear');
    clear.click();
    await m.flush();
    expect(m.sent[0]).toEqual({ t: 'ai.clear', args: { role: 'classifier' } });
  });

  it('opening the dialog drops a half-typed key', () => {
    const m = mount({});
    m.type(m.input(m.role(0), 'Key'), 'half-typed-key');
    m.handle.open?.();
    expect(m.input(m.role(0), 'Key').value).toBe('');
  });
});
