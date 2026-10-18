import './test/fakeCanvas';
import { describe, expect, it } from 'vitest';
import { SecretsSim } from '../tools/fixture-secrets.ts';
import { App } from './app';
import type { CommandResult } from './net/client';
import type { HireInterpretation } from './net/protocol';
import { HANDOVER_EXPIRED, PENDING_UNREVIEWED } from './ui/dictationModel';
import { PromptSecretsFlow } from './ui/secretsFlow';
import type { SecretsReviewRequest } from './ui/secretsReview';
import { PromptSecretsBook } from './world/promptSecrets';
import { FULL } from './world/hireReviewFixtures';

/**
 * #108 round 4: a dictated sentence (`App.interpretDictation`) with "Review prompt secrets" on: reviewed before the
 * interpreter's LLM reads it ("Confirm and continue"), its hand-over kept with the proposal and sent back with the next
 * sentence. No App test builds a whole App: this takes its prototype and gives it the parts the method reads.
 */

const SENTENCE = 'Hire a Claude agent to deploy with TOKEN=ghp_abcdefghijklmnopqrstu1';

/** `goneAtScan`: the bar is closed (or closed and opened again) as that scan is asked. */
function parts(o: { on?: boolean; open?: { pending: HireInterpretation; handover: string | null }; answers?: CommandResult[]; goneAtScan?: number } = {}) {
  const book = new PromptSecretsBook();
  book.reset({ enabled: o.on ?? true, available: true });
  const sim = new SecretsSim({ emit: () => {}, error: (code, message) => Object.assign(new Error(message), { code }), takeFailure: () => false }, { on: o.on ?? true });
  const reviews: SecretsReviewRequest[] = [];
  const sent: Array<[string, Record<string, unknown>]> = [];
  const answers = [...(o.answers ?? [])];
  let scans = 0;
  let alive = true;
  const send = async (t: string, args: Record<string, unknown>): Promise<CommandResult> => {
    sent.push([t, args]);
    if (t === 'prompt_secrets.scan' && ++scans === o.goneAtScan) alive = false;
    if (t === 'prompt_secrets.scan') return new Promise((resolve) => sim.handle(t, { ...args }, () => {}, (data) => resolve({ ok: true, data })));
    return answers.shift() ?? { ok: true, data: { text: args.text, intent: 'hire', hire: FULL, secrets_pending: 'tok-1' } };
  };
  const secrets = new PromptSecretsFlow({ book, unsupported: () => false, send: send as never, review: (req) => (reviews.push(req), Promise.resolve({ kind: 'confirm', review: req.review })) });
  const opened: Array<{ hire: HireInterpretation; handover: string | null }> = [];
  const applied: Array<string | null> = [];
  const self = {
    secrets,
    send,
    hireReview: {
      begin: () => (o.open ? { epoch: 1, rev: 0 } : null),
      pendingInterpretation: () => o.open?.pending ?? null,
      pendingHandover: () => o.open?.handover ?? null,
      apply: (_h: HireInterpretation, _t: unknown, handover: string | null) => (applied.push(handover), true),
      isOpen: !!o.open,
    },
    dictation: { close: () => {} },
    hereFloor: () => 'f1',
    openDictatedReview: async (_floor: string, hire: HireInterpretation, _live: unknown, handover: string | null) => (opened.push({ hire, handover }), { kind: 'done' }),
  };
  const run = (text: string, manual = false) => (App.prototype as unknown as { interpretDictation(this: unknown, text: string, live: () => boolean, manual: boolean): Promise<unknown> }).interpretDictation.call(self, text, () => alive, manual);
  return { run, reviews, sent, opened, applied };
}

describe('App.interpretDictation and prompt secrets (#108 round 4)', () => {
  it('a sentence with a secret: reviewed first (“Confirm and continue”), hire.interpret carries the review, the hand-over goes to the review it opens', async () => {
    const p = parts();
    await p.run(SENTENCE);
    expect(p.reviews.map((r) => [r.action, r.target])).toEqual([['Confirm and continue', 'the hire interpreter']]);
    const [, args] = p.sent.find(([t]) => t === 'hire.interpret')!;
    expect(args).toMatchObject({ text: SENTENCE, secrets: { decisions: [{ candidate: 'c1', action: 'protect' }] } });
    expect(args).not.toHaveProperty('secrets_pending');
    expect(p.opened).toEqual([{ hire: FULL, handover: 'tok-1' }]);
  });

  it('a follow-up to an open review goes back with its proposal and hand-over; the answer’s hand-over is kept', async () => {
    const p = parts({ open: { pending: FULL, handover: 'tok-0' } });
    await p.run('High effort, please.');
    const [, args] = p.sent.find(([t]) => t === 'hire.interpret')!;
    expect(args).toEqual({ text: 'High effort, please.', pending: FULL, secrets_pending: 'tok-0' });
    expect(p.applied).toEqual(['tok-1']);
  });

  it('an open proposal whose sentences were never reviewed: the bar says so, never a review again', async () => {
    const p = parts({ open: { pending: FULL, handover: null }, answers: [{ ok: false, code: 'secrets_review_required', message: 'pending.sources[0]: 1 possible secret: review them' }] });
    expect(await p.run('High effort, please.')).toEqual({ kind: 'say', text: PENDING_UNREVIEWED, error: true });
    expect(p.sent.filter(([t]) => t === 'hire.interpret')).toHaveLength(1);
  });

  it('off: no scan, no review, the sentence as today', async () => {
    const p = parts({ on: false });
    await p.run(SENTENCE);
    expect(p.reviews).toEqual([]);
    expect(p.sent.map(([t]) => t)).toEqual(['hire.interpret']);
  });

  it('“Review secrets” on the bar (or its chord): the review opens with nothing found, then the sentence goes with it', async () => {
    const p = parts();
    await p.run('Hire an agent with the code 4471', true);
    expect(p.reviews.map((r) => [r.manual, r.review.counts().found, r.action])).toEqual([[true, 0, 'Confirm and continue']]);
    expect(p.sent.map(([t]) => t)).toEqual(['prompt_secrets.scan', 'hire.interpret']);
  });

  // #108 round 4 fix (D2): a hand-over refused as stale (expired, the bridge restarted, the switch changed) cannot be
  // renewed by a review of the new sentence: that submission ends there, the bar keeps the sentence and says to start over.
  const STALE: CommandResult = { ok: false, code: 'secrets_review_stale', message: 'secrets_pending: unknown or expired' };

  it('a follow-up whose hand-over expired: asked once, never reviewed again, the bar says to dictate the hire again', async () => {
    const p = parts({ open: { pending: FULL, handover: 'expired-token' }, answers: [STALE, STALE, STALE] });
    expect(await p.run('High effort, please.')).toEqual({ kind: 'say', text: HANDOVER_EXPIRED, error: true });
    expect(p.sent.filter(([t]) => t === 'hire.interpret')).toHaveLength(1);
    expect(p.reviews).toEqual([]);
    expect(p.applied).toEqual([]);
  });

  it('a reviewed follow-up whose hand-over expired: its one review, asked once, the same line', async () => {
    const p = parts({ open: { pending: FULL, handover: 'expired-token' }, answers: [STALE, STALE] });
    expect(await p.run(SENTENCE)).toEqual({ kind: 'say', text: HANDOVER_EXPIRED, error: true });
    expect(p.reviews).toHaveLength(1);
    expect(p.sent.filter(([t]) => t === 'hire.interpret')).toHaveLength(1);
  });

  it('the switch off with a hand-over the bridge no longer takes: the same line, not “send it again”', async () => {
    const p = parts({ on: false, open: { pending: FULL, handover: 'tok-0' }, answers: [STALE, STALE] });
    expect(await p.run('High effort, please.')).toEqual({ kind: 'say', text: HANDOVER_EXPIRED, error: true });
    expect(p.sent.map(([t]) => t)).toEqual(['hire.interpret']);
  });

  it('a first sentence refused as stale (no hand-over) is still reviewed again', async () => {
    const p = parts({ answers: [{ ok: false, code: 'secrets_review_stale', message: 'stale' }] });
    await p.run(SENTENCE);
    expect(p.reviews).toHaveLength(2);
    expect(p.opened).toEqual([{ hire: FULL, handover: 'tok-1' }]);
  });

  it('the bar closed while a refused sentence is scanned again: asked once, no review opens', async () => {
    const p = parts({ answers: [{ ok: false, code: 'secrets_review_stale', message: 'stale' }], goneAtScan: 2 });
    expect(await p.run(SENTENCE)).toEqual({ kind: 'done' });
    expect(p.reviews).toHaveLength(1);
    expect(p.sent.filter(([t]) => t === 'hire.interpret')).toHaveLength(1);
  });
});
