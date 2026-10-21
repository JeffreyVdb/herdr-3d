import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Worker } from '../src/net/protocol.ts';
import { AiSim } from './fixture-ai.ts';
import { HirePresetSim } from './fixture-hirepreset.ts';
import { PackupSim } from './fixture-packup.ts';

const error = (code: string, message: string) => Object.assign(new Error(message), { code });
const TASK = 'Roll the upgrade out: start an agent for each service.';

function ready(scenario?: 'packup' | 'hiring') {
  const ai = new AiSim('http://model.test', 'on', () => {}, error, scenario);
  // As after Settings has tested and saved both models; the endpoint setup has its own HTTP integration tests.
  Object.assign(ai, { cls: { model: 'jev-latest', key: 'fixture-key' }, llm: { model: 'fixture-llm', key: 'fixture-key', base_url: 'http://model.test/v1', extra: null, json_mode: true } });
  return ai;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('in-process model replies for UI fixtures', () => {
  it('keeps a positive schedule check independent of a busy HTTP provider', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const ai = ready('hiring');
    const sim = new HirePresetSim({ hasFloor: () => true, hire: {}, emit: () => {}, error, now: Date.now, ai }, true, null);
    const answer = new Promise((ack) => sim.handle('hire_preset.check', { prompt: TASK }, () => {}, ack));
    await vi.advanceTimersByTimeAsync(1201);
    expect(await answer).toEqual({ delegates: true, score: 0.97 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a pack-up match and exact cut independent of a busy HTTP provider', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const ai = ready('packup');
    const sim = new PackupSim({ workers: [{ id: 'w', agent_kind: 'claude' }] as Worker[], ai, emit: () => {}, error, now: Date.now });
    Object.assign(sim, { enabled: true });
    const prompt = 'Fix the header with PASSWORD=[secret in file /tmp/fixture], then go home.';
    const answer = new Promise((ack) => sim.handle('packup.detect', { id: 'w', text: prompt }, () => {}, ack, (e) => { throw e; }));
    await vi.advanceTimersByTimeAsync(1201);
    expect(await answer).toMatchObject({ matched: true, score: 0.97, task: 'Fix the header with PASSWORD=[secret in file /tmp/fixture].' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still classifies ordinary tasks as negative', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(await ready('hiring').classify({ prompt: 'Tidy up the README and fix the typos.' }, 'Starts agents?')).toBe(0.03);
    expect(await ready('packup').classify({ prompt: 'Fix the header.' }, 'Wrap up and leave?')).toBe(0.03);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps an explicit SLOW pack-up check on HTTP and preserves its classifier deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const ai = ready('packup');
    const sim = new PackupSim({ workers: [{ id: 'w', agent_kind: 'claude' }] as Worker[], ai, emit: () => {}, error, now: Date.now });
    Object.assign(sim, { enabled: true });
    const text = 'SLOW: make a PR and end your turn';
    const answer = new Promise((ack) => sim.handle('packup.detect', { id: 'w', text }, () => {}, ack, (e) => { throw e; }));
    await vi.advanceTimersByTimeAsync(1201);
    expect(await answer).toEqual({ matched: false, score: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)).toMatchObject({ state: { prompt: text } });
  });

  it('keeps Settings model discovery and its test on the HTTP transport', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/models') ? { models: [{ name: 'jev-latest' }] } : { answers: { question: { noul: 0.9 } } }))));
    const ai = ready('hiring');
    const command = (t: string) => new Promise((ack, reject) => ai.handle(t, { role: 'classifier' }, () => {}, ack, reject));
    expect(await command('ai.models')).toEqual({ models: [{ id: 'jev-latest', description: '' }] });
    expect(await command('ai.test')).toMatchObject({ ok: true, score: 0.9 });
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['http://model.test/v1/models', 'http://model.test/v1/systemone']);
  });

  it('preserves the HTTP timeout fallback when no model fixture is selected', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const sim = new HirePresetSim({ hasFloor: () => true, hire: {}, emit: () => {}, error, now: Date.now, ai: ready() }, true, null);
    const answer = new Promise((ack) => sim.handle('hire_preset.check', { prompt: TASK }, () => {}, ack));
    await vi.advanceTimersByTimeAsync(1201);
    expect(await answer).toEqual({ delegates: false, score: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
