// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import { flush, installDialogs, secretsBridge } from '../test/secretsBridge';
import { TranscriptMode, type MountTranscript, type TranscriptRenderHost } from './transcriptMode';

// #108 round 4: the transcript's answers (an ask's Other and its prompt, a follow-up's values and notes, a Codex async
// answer) through the review, each text alone; the command carries a review per text keyed by its path.

const SECRET = 'TOKEN=ghp_abcdefghijklmnopqrstu1';

async function harness() {
  document.body.replaceChildren();
  const b = secretsBridge();
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  let host: TranscriptRenderHost | null = null;
  const mount: MountTranscript = (_box, h) => {
    host = h;
    return { setItems() {}, applyUpdates() {}, setBlocked() {}, setAsk() {}, setFollowup() {}, setCodex() {}, setUsage() {}, setActivity() {}, setPending() {}, attachTabs() {}, hasItem: () => false, scrollToItem: () => false, focus() {}, focusPrompt() {}, destroy() {} } as never;
  };
  const tx = new TranscriptMode({
    feed: () => null,
    send: ((t: string, args: Record<string, unknown>) => (sent.push({ t, args }), Promise.resolve<CommandResult>({ ok: true, data: { sent: [], resolved: true } }))) as never,
    renderer: () => Promise.resolve(mount),
    overlay: () => document.body.appendChild(document.createElement('div')),
    storage: null,
    status: () => {},
    modeChanged: () => {},
    secrets: b.flow,
  });
  tx.sit('a', 'Ada', true, 'claude');
  await flush();
  const of = (t: string) => sent.filter((x) => x.t === t).map((x) => x.args);
  return { b, tx, of, host: () => host as unknown as TranscriptRenderHost };
}

describe('TranscriptMode: answers and prompt secrets (#108 round 4)', () => {
  beforeEach(installDialogs);
  afterEach(() => document.body.replaceChildren());

  it('an ask: the Other answer reviewed (“your answer to question 2”), sent with its review keyed by path', async () => {
    const h = await harness();
    const other = `use ${SECRET}`;
    const r = h.host().onAnswerAsk({ id: '', tool_use_id: 'tu1', answers: [{ question: 0, choices: [1] }, { question: 1, other }] });
    await flush();
    expect(h.b.open()).toMatchObject({ target: 'Ada', field: 'your answer to question 2', counts: { found: 1 } });
    expect(h.of('worker.answer_ask')).toEqual([]);
    h.b.confirm();
    await expect(r).resolves.toMatchObject({ ok: true });
    const [args] = h.of('worker.answer_ask');
    expect(Object.keys(args!.secrets as object)).toEqual(['answers[1].other']);
    expect(h.b.gate(other, (args!.secrets as Record<string, unknown>)['answers[1].other'], 'a', { field: 'answers[1].other' })).toMatchObject({ protected: 1 });
  });

  it('a follow-up: an answer’s value and the round’s note, reviewed in turn; Cancel keeps the answer and sends nothing', async () => {
    const h = await harness();
    const args = { id: '', turn_id: 't1', answers: [{ id: 'q1', value: `deploy with ${SECRET}` }], note: 'and PASSWORD=hunter22 for staging' };
    const r = h.host().onAnswerFollowup!(args);
    await flush();
    expect(h.b.open()?.field).toBe('your answer to question 1');
    h.b.confirm();
    await flush();
    expect(h.b.open()?.field).toBe('your note');
    h.b.confirm();
    await expect(r).resolves.toMatchObject({ ok: true });
    expect(Object.keys(h.of('worker.answer_followup')[0]!.secrets as object).sort()).toEqual(['answers[0].value', 'note']);
    const c = h.host().onAnswerFollowup!(args);
    await flush();
    h.b.cancel();
    await expect(c).resolves.toEqual({ ok: false, code: 'secrets_kept', message: 'Not sent: the review was cancelled. Your answer is still here.' });
    expect(h.of('worker.answer_followup')).toHaveLength(1);
  });

  it('a Codex async answer: keyed by its place in the args; “Review secrets” opens the review with nothing found', async () => {
    const h = await harness();
    const r = h.host().onAnswerAsync!({ id: '', thread: 'th', batch: 'b1', answers: [{ index: 0, answer: 'fine' }, { index: 3, answer: SECRET }] });
    await flush();
    expect(h.b.open()?.field).toBe('your answer to question 4');
    h.b.confirm();
    await expect(r).resolves.toMatchObject({ ok: true });
    expect(Object.keys(h.of('worker.answer_async')[0]!.secrets as object)).toEqual(['answers[1].answer']);
    const m = h.host().onAnswerAsync!({ id: '', thread: 'th', batch: 'b2', answers: [{ index: 0, answer: 'the code is 4471' }] }, { review: true });
    await flush();
    expect(h.b.open()).toMatchObject({ manual: true, counts: { found: 0 } });
    h.b.confirm();
    await expect(m).resolves.toMatchObject({ ok: true });
    expect(h.of('worker.answer_async')[1]).not.toHaveProperty('secrets');
  });
});
