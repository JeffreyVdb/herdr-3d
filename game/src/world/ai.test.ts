import { describe, expect, it, vi } from 'vitest';
import { WorldStore } from './store';
import { AiBook, aiChip, aiFailureText, aiStateOf, pausedNotice } from './ai';

const cls = (over: Record<string, unknown> = {}) => ({ state: 'off', model: '', key_set: false, key_hint: '', env: [], ...over });
const llm = (over: Record<string, unknown> = {}) => ({ state: 'off', base_url: '', model: '', key_set: false, key_hint: '', json_mode: null, env: [], ...over });
const st = (c = {}, l = {}, extra: Record<string, unknown> = {}) => ({ classifier: cls(c), llm: llm(l), ...extra });

describe('aiStateOf (#92)', () => {
  it('keeps the known fields only: a key that slipped into a frame is not kept', () => {
    const s = aiStateOf(st({ state: 'ready', key: 'sk-secret', key_set: true, key_hint: '1234' }, { api_key: 'x', extra_body: { thinking: { type: 'disabled' } } }));
    expect(JSON.stringify(s)).not.toContain('secret');
    expect(JSON.stringify(s)).not.toContain('"x"');
    expect(s?.classifier).toEqual({ state: 'ready', model: '', key_set: true, key_hint: '1234', env: [] });
    expect(s?.llm.extra_body).toEqual({ thinking: { type: 'disabled' } });
  });
  it('refuses what is not a state and falls back to off for an unknown role state', () => {
    expect(aiStateOf(null)).toBeNull();
    expect(aiStateOf({ classifier: {} })).toBeNull();
    expect(aiStateOf(st({ state: 'weird' }))?.classifier.state).toBe('off');
  });
});

describe('aiChip', () => {
  it('shows nothing for off and ready', () => {
    expect(aiChip(null)).toBeNull();
    expect(aiChip(aiStateOf(st()))).toBeNull();
    expect(aiChip(aiStateOf(st({ state: 'ready' }, { state: 'ready' })))).toBeNull();
  });
  it('says paused for a rejected key and unfinished for a missing part', () => {
    const paused = aiChip(aiStateOf(st({ state: 'invalid' }, {}, { last_error: { role: 'classifier', kind: 'auth_failed', message: 'the key was rejected', at: 1 } })));
    expect(paused).toMatchObject({ text: 'AI paused', level: 'error' });
    expect(paused?.title).toContain('Classification model');
    expect(aiChip(aiStateOf(st({}, { state: 'incomplete' })))).toMatchObject({ text: 'AI setup unfinished', level: 'warn' });
    // paused wins over unfinished
    expect(aiChip(aiStateOf(st({ state: 'incomplete' }, { state: 'invalid' })))?.text).toBe('AI paused');
  });
});

describe('the paused toast', () => {
  const ready = aiStateOf(st({ state: 'ready' }, { state: 'ready' }))!;
  const stopped = (kind = 'auth_failed', runtime = true) => aiStateOf(st({ state: 'invalid' }, { state: 'ready' }, { last_error: { role: 'classifier', kind, message: 'm', at: 1, runtime } }))!;
  it('names the role whose key a feature’s call just had rejected', () => {
    expect(pausedNotice(ready, stopped())).toBe('AI integration paused: classification key rejected');
    const l = aiStateOf(st({ state: 'ready' }, { state: 'invalid' }, { last_error: { role: 'llm', kind: 'auth_failed', message: 'm', at: 1, runtime: true } }))!;
    expect(pausedNotice(ready, l)).toBe('AI integration paused: LLM key rejected');
  });
  it('stays quiet for a test, an already paused role and a snapshot', () => {
    expect(pausedNotice(ready, stopped('auth_failed', false))).toBeNull();
    expect(pausedNotice(stopped(), stopped())).toBeNull();
    expect(pausedNotice(null, stopped())).toBe('AI integration paused: classification key rejected');
    const book = new AiBook();
    const fn = vi.fn();
    book.onChange(fn);
    book.reset(stopped());
    expect(fn).toHaveBeenLastCalledWith(null);
    book.upsert({ ...ready, t: 'ai.update' });
    book.upsert({ ...stopped(), t: 'ai.update' });
    expect(fn).toHaveBeenLastCalledWith('AI integration paused: classification key rejected');
  });
});

describe('the store', () => {
  it('reads the snapshot’s ai and its updates, and is not known from an older bridge', () => {
    const store = new WorldStore();
    expect(store.ai.known).toBe(false);
    store.applySnapshot({ t: 'world.snapshot', seq: 1, world: { buildings: [], unassigned: [], floors: [], workers: [], ai: st({ state: 'ready', model: 'jev-latest' }) } } as never);
    expect(store.ai.known).toBe(true);
    expect(store.ai.state?.classifier.model).toBe('jev-latest');
    const v = store.ai.version;
    store.applyEvent({ t: 'ai.update', seq: 2, ...st({ state: 'invalid' }) } as never);
    expect(store.ai.state?.classifier.state).toBe('invalid');
    expect(store.ai.version).toBe(v + 1);
    store.applySnapshot({ t: 'world.snapshot', seq: 3, world: { buildings: [], unassigned: [], floors: [], workers: [] } } as never);
    expect(store.ai.known).toBe(false);
  });
});

describe('aiFailureText', () => {
  it('says what to do and never repeats a key', () => {
    expect(aiFailureText('auth_failed', 'the key was rejected (HTTP 401)')).toBe('Key rejected. Check it and try again.');
    expect(aiFailureText('no_models_endpoint', '')).toMatch(/Type the model id/);
    expect(aiFailureText('test_required', '')).toMatch(/Test these settings/);
    expect(aiFailureText('unknown_command', 'x')).toMatch(/Update it/);
  });
});
