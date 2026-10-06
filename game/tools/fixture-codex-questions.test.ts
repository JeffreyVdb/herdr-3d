import { describe, expect, it } from 'vitest';
import type { Snapshot, Worker, WorldEvent } from '../src/net/protocol';
import { WorldStore } from '../src/world/store';
import { SIM_CODEX_THREAD, SIM_CODEX_WORKER } from './fixture-codex-questions';
import { loadFixture } from './fixture-server';
import { SimWorld, type SimOptions } from './fixture-sim';

type Msg = Record<string, unknown>;

/** A sim on demo-m5 with Pixel asking (`simcodex=ask`), a store fed by it, and manual timers. */
function rig(extra: Partial<SimOptions> = {}) {
  const timers: Array<() => void> = [];
  const { snapshot } = loadFixture('demo-m5');
  const sim = new SimWorld(snapshot as never, { codex: 'ask', setTimeout: (fn) => timers.push(fn), clearTimeout: () => {}, ...extra });
  const store = new WorldStore(0);
  store.applySnapshot(sim.snapshot() as unknown as Snapshot);
  const out: Msg[] = [];
  let n = 0;
  const send = (m: Msg) => {
    out.push(m);
    if (typeof m.seq === 'number') store.applyEvent(m as unknown as WorldEvent);
  };
  const cmd = (t: string, args: unknown) => {
    const req_id = `r${++n}`;
    sim.handle({ t, req_id, args }, send);
    return req_id;
  };
  const reply = (req_id: string) => out.find((m) => m.req_id === req_id);
  const settle = () => {
    while (timers.length) timers.shift()?.();
  };
  const tick = () => timers.shift()?.();
  const pixel = () => store.workers.get(SIM_CODEX_WORKER) as Worker;
  const q = (batch = 'call_3', i = 0) => pixel().codex?.questions?.find((b) => b.batch === batch)?.questions[i];
  return { sim, store, out, cmd, reply, settle, tick, pixel, q };
}

const answer = (i: number, text: string, batch = 'call_3', thread = SIM_CODEX_THREAD) => ({ id: SIM_CODEX_WORKER, thread, batch, answers: [{ index: i, answer: text }] });

describe('the fixture’s Codex async questions (#157)', () => {
  it('seeds a shared worker blocked only by its question on every connection (a reconnect’s snapshot replays it)', () => {
    for (let k = 0; k < 2; k++) {
      const r = rig();
      expect(r.pixel()).toMatchObject({ status: 'blocked', codex: { mode: 'shared', attached: true, thread: SIM_CODEX_THREAD, turn: 'turn-1', async_blocked: true } });
      expect(r.pixel().codex?.questions?.map((b) => [b.batch, b.questions.map((x) => [x.title, x.options ?? null, x.state])])).toEqual([
        [
          'call_3',
          [
            ['Which fixture color?', ['Green', 'Blue'], 'pending'],
            ['Any context for the fixture?', null, 'pending'],
          ],
        ],
      ]);
      expect(r.store.workerView(SIM_CODEX_WORKER)).toMatchObject({ display: 'working', asks: 2 });
    }
  });

  it('answers like the bridge: sending at once, sent with the ack, answered by the bridge later', () => {
    const r = rig();
    const id = r.cmd('worker.answer_async', answer(0, 'Green'));
    expect(r.q()?.state).toBe('sending');
    expect(r.reply(id)).toBeUndefined();
    r.tick();
    expect(r.q()?.state).toBe('sent');
    expect(r.reply(id)).toMatchObject({ t: 'ack', data: { state: 'sent', via: 'turn/steer', turn: 'turn-1' } });
    // The upsert went before the ack.
    const at = (pred: (m: Msg) => boolean) => r.out.findIndex(pred);
    expect(at((m) => m.t === 'worker.upsert' && (m.worker as Worker).codex?.questions?.[0]?.questions[0]?.state === 'sent')).toBeLessThan(at((m) => m.req_id === id));
    r.settle();
    expect(r.q()).toMatchObject({ state: 'answered', answer: 'Green', answered_by: 'bridge' });
    // Sent twice: stale.
    const again = r.cmd('worker.answer_async', answer(0, 'Blue'));
    expect(r.reply(again)).toMatchObject({ t: 'error', code: 'stale' });
  });

  it('checks an answer as the bridge does', () => {
    const r = rig();
    const code = (args: unknown) => (r.reply(r.cmd('worker.answer_async', args)) as { code?: string })?.code;
    expect(code(answer(0, 'Purple'))).toBe('bad_request');
    expect(code(answer(1, '   '))).toBe('bad_request');
    expect(code(answer(1, 'a\u0007'))).toBe('bad_request');
    expect(code(answer(0, 'Green', 'call_99'))).toBe('stale');
    expect(code(answer(0, 'Green', 'call_3', 'another-thread'))).toBe('stale');
    expect(code({ ...answer(0, 'Green'), id: 'nobody' })).toBe('unknown_worker');
    r.cmd('sim.codex', { id: SIM_CODEX_WORKER, ask: { batch: 'call_7', conflict: true, questions: [{ title: 'Which?' }] } });
    expect(code(answer(0, 'x', 'call_7'))).toBe('invalid_state');
    r.cmd('sim.codex', { id: SIM_CODEX_WORKER, codex: { attached: false } });
    expect(code(answer(1, 'x'))).toBe('invalid_state');
    expect(r.pixel().codex?.async_blocked).toBeUndefined();
    expect(r.pixel().status).not.toBe('blocked');
    expect(r.out.filter((m) => m.t === 'ack')).toHaveLength(2); // the two sim.codex
  });

  it('plays the failures: refused, unconfirmed, undelivered (then sent again), stale', () => {
    const r = rig();
    r.cmd('sim.codex', { id: SIM_CODEX_WORKER, fail: 'input_failed' });
    const refused = r.cmd('worker.answer_async', answer(1, 'first try'));
    r.settle();
    expect(r.reply(refused)).toMatchObject({ t: 'error', code: 'input_failed' });
    expect(r.q('call_3', 1)).toMatchObject({ state: 'pending', error: expect.stringMatching(/refused the answer/) });

    r.cmd('sim.codex', { id: SIM_CODEX_WORKER, fail: 'unconfirmed' });
    const unconfirmed = r.cmd('worker.answer_async', answer(1, 'second try'));
    r.settle();
    expect(r.reply(unconfirmed)).toMatchObject({ t: 'ack', data: { state: 'sent', unconfirmed: true } });
    expect(r.q('call_3', 1)).toMatchObject({ state: 'sent', unconfirmed: true });
    expect(r.q('call_3', 1)).not.toHaveProperty('error');

    r.cmd('sim.codex', { id: SIM_CODEX_WORKER, fail: 'undelivered' });
    r.cmd('worker.answer_async', answer(0, 'Blue'));
    r.settle();
    expect(r.q()).toMatchObject({ state: 'sent', undelivered: true });
    expect(r.pixel().codex?.turn).toBe('');
    const again = r.cmd('worker.answer_async', answer(0, 'Blue'));
    r.tick();
    expect(r.reply(again)).toMatchObject({ t: 'ack', data: { state: 'sent', via: 'turn/start' } });
    r.settle();
    expect(r.q()).toMatchObject({ state: 'answered', answer: 'Blue' });

    const rr = rig({ fail: 'async_stale' });
    expect(rr.reply(rr.cmd('worker.answer_async', answer(0, 'Green')))).toMatchObject({ code: 'stale' });
    expect(rr.q()?.state).toBe('pending');
  });

  it('takes the terminal’s answer, hides here only, and tells a real block from an async one', () => {
    const r = rig();
    r.cmd('sim.codex_answer', { id: SIM_CODEX_WORKER, batch: 'call_3', index: 1, answer: 'typed-in-terminal' });
    expect(r.q('call_3', 1)).toMatchObject({ state: 'answered', answer: 'typed-in-terminal', answered_by: 'other' });
    expect(r.pixel().codex?.async_blocked).toBe(true); // question 0 still open
    r.cmd('worker.dismiss_async', { id: SIM_CODEX_WORKER, thread: SIM_CODEX_THREAD, batch: 'call_3' });
    expect(r.q()?.state).toBe('dismissed');
    expect(r.reply(r.cmd('worker.dismiss_async', { id: SIM_CODEX_WORKER, thread: SIM_CODEX_THREAD, batch: 'call_3', indexes: [1] }))).toMatchObject({ code: 'stale' });
    // A prompt goes through the app-server while it is blocked only by the question; an approval is a real block.
    const p = r.cmd('worker.prompt', { id: SIM_CODEX_WORKER, text: 'keep going' });
    r.settle();
    expect(r.reply(p)).toMatchObject({ t: 'ack', data: { queued: true, via: 'app_server' } });
    r.cmd('sim.codex', { id: SIM_CODEX_WORKER, approval: true });
    expect(r.pixel()).toMatchObject({ status: 'blocked' });
    expect(r.pixel().codex?.async_blocked).toBeUndefined();
    expect(r.store.workerView(SIM_CODEX_WORKER)?.display).toBe('needs_you');
    expect(r.reply(r.cmd('worker.prompt', { id: SIM_CODEX_WORKER, text: 'again' }))).toMatchObject({ code: 'invalid_state' });
    r.cmd('sim.codex', { id: SIM_CODEX_WORKER, approval: false });
    r.cmd('sim.codex_turn_end', { id: SIM_CODEX_WORKER });
    expect(r.pixel()).toMatchObject({ status: 'idle', codex: { turn: '' } });
  });
});
