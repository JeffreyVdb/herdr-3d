import { describe, expect, it } from 'vitest';
import type { CodexBatch, CodexQuestion, WorkerCodex } from '../net/protocol';
import { answerAsyncArgs, answerProblem, askingText, asyncAttention, asyncBatches, asyncBlockedOnly, effectiveStatus, phaseAnnouncement, phaseText, replyPhase, sharedCodex, wantsAnswer } from './codexQuestions';

const q = (index: number, over: Partial<CodexQuestion> = {}): CodexQuestion => ({ index, title: `Question ${index}?`, state: 'pending', ...over });
const batch = (id: string, questions: CodexQuestion[], over: Partial<CodexBatch> = {}): CodexBatch => ({ batch: id, turn: 't1', seen: ['live'], at: 1000, questions, ...over });
const shared = (over: Partial<WorkerCodex> = {}): WorkerCodex => ({ mode: 'shared', server: 'running', attached: true, thread: 'th1', turn: 't1', ...over });

describe('a worker blocked only by an async question (#157)', () => {
  it('keeps working when the bridge says the block is only the question’s', () => {
    const w = { status: 'blocked', codex: shared({ async_blocked: true }) };
    expect(asyncBlockedOnly(w)).toBe(true);
    expect(effectiveStatus(w)).toBe('working');
  });

  it('is blocked for real otherwise: an approval open, a legacy worker, another harness, not blocked at all', () => {
    expect(effectiveStatus({ status: 'blocked', codex: shared({ async_blocked: false }) })).toBe('blocked');
    expect(effectiveStatus({ status: 'blocked', codex: shared() })).toBe('blocked');
    expect(effectiveStatus({ status: 'blocked', codex: { mode: 'legacy', async_blocked: true } })).toBe('blocked');
    expect(effectiveStatus({ status: 'blocked' })).toBe('blocked');
    expect(effectiveStatus({ status: 'idle', codex: shared({ async_blocked: true }) })).toBe('idle');
    expect(asyncBlockedOnly({ status: 'working', codex: shared({ async_blocked: true }) })).toBe(false);
  });

  it('reads the codex object defensively', () => {
    expect(sharedCodex({ codex: null })).toBeNull();
    expect(sharedCodex({ codex: 'shared' as unknown as WorkerCodex })).toBeNull();
    expect(asyncBatches({ codex: shared({ questions: 'x' as unknown as CodexBatch[] }) })).toEqual([]);
    // A malformed batch is left out, the rest kept.
    const ok = batch('call_2', [q(0)]);
    expect(asyncBatches({ codex: shared({ questions: [{ batch: 'call_1', questions: [{ index: 3, title: 'x', state: 'pending' }] } as unknown as CodexBatch, ok] }) }).map((b) => b.batch)).toEqual(['call_2']);
  });
});

describe('how many questions want an answer', () => {
  it('counts pending (failed ones too) and undelivered, not what is on its way, answered or hidden', () => {
    const codex = shared({
      questions: [
        batch('call_1', [q(0), q(1, { state: 'pending', error: 'refused' }), q(2, { state: 'sending' })]),
        batch('call_2', [q(0, { state: 'sent' }), q(1, { state: 'sent', undelivered: true }), q(2, { state: 'sent', unconfirmed: true })]),
        batch('call_3', [q(0, { state: 'answered', answer: 'x', answered_by: 'other' }), q(1, { state: 'dismissed' })]),
      ],
    });
    expect(asyncAttention({ codex })).toBe(3);
    expect(wantsAnswer(q(0, { state: 'sent' }))).toBe(false);
    expect(askingText(1)).toBe('asks 1 question');
    expect(askingText(3)).toBe('asks 3 questions');
  });

  it('is none for a legacy worker or one without a thread', () => {
    expect(asyncAttention({ codex: { mode: 'legacy', questions: [batch('call_1', [q(0)])] } })).toBe(0);
    expect(asyncAttention({ codex: shared({ thread: '', questions: [batch('call_1', [q(0)])] }) })).toBe(0);
  });
});

describe('the card’s batches', () => {
  it('keys each by thread and batch, oldest first', () => {
    const bs = asyncBatches({ codex: shared({ questions: [batch('call_1', [q(0)]), batch('call_2', [q(0)], { at: 2000 })] }) });
    expect(bs.map((b) => [b.key, b.batch, b.readOnly])).toEqual([
      ['th1\u0000call_1', 'call_1', null],
      ['th1\u0000call_2', 'call_2', null],
    ]);
  });

  it('shows a twin pair as one card, answered when either is', () => {
    const codex = shared({
      questions: [
        batch('call_3', [q(0), q(1)], { twin: 'item-7' }),
        batch('item-7', [q(0, { state: 'answered', answer: 'Blue', answered_by: 'other' }), q(1)], { seen: ['history'], twin: 'call_3' }),
      ],
    });
    const bs = asyncBatches({ codex });
    expect(bs).toHaveLength(1);
    expect(bs[0]?.batch).toBe('call_3');
    expect(bs[0]?.twin).toBe('item-7');
    expect(bs[0]?.questions.map((x) => x.state)).toEqual(['answered', 'pending']);
    expect(asyncAttention({ codex })).toBe(1);
  });

  it('is read-only for a conflict, and while the bridge is not joined to the thread', () => {
    expect(asyncBatches({ codex: shared({ questions: [batch('call_1', [q(0)], { conflict: true })] }) })[0]?.readOnly).toBe('conflict');
    expect(asyncBatches({ codex: shared({ attached: false, questions: [batch('call_1', [q(0)])] }) })[0]?.readOnly).toBe('detached');
  });
});

describe('what a reply’s state says', () => {
  it('names each state from the bridge’s evidence only', () => {
    expect(replyPhase(q(0))).toBe('open');
    expect(phaseText(q(0))).toBe('');
    expect(replyPhase(q(0, { error: 'turn/start refused' }))).toBe('failed');
    expect(phaseText(q(0, { error: 'turn/start refused' }))).toMatch(/^Not sent: turn\/start refused\. Your answer is kept/);
    expect(phaseText(q(0, { state: 'sending' }))).toBe('Sending…');
    expect(phaseText(q(0, { state: 'sent' }))).toBe('Sent — Codex will read it with its next step');
    expect(replyPhase(q(0, { state: 'sent', unconfirmed: true }))).toBe('unconfirmed');
    expect(phaseText(q(0, { state: 'sent', unconfirmed: true }))).toMatch(/not confirmed/);
    expect(replyPhase(q(0, { state: 'sent', undelivered: true }))).toBe('undelivered');
    expect(phaseText(q(0, { state: 'sent', undelivered: true }))).toMatch(/^Not delivered — the turn ended before Codex read it/);
    expect(phaseText(q(0, { state: 'answered', answered_by: 'bridge' }))).toBe('Answered');
    expect(phaseText(q(0, { state: 'answered', answered_by: 'other' }))).toBe('Answered elsewhere');
    expect(replyPhase(q(0, { state: 'dismissed' }))).toBe('hidden');
    // Hiding is only ours: never "cancelled", never resolved in Codex.
    expect(phaseText(q(0, { state: 'dismissed' }))).toBe('Hidden here: Codex still has it');
  });

  it('announces what changed', () => {
    expect(phaseAnnouncement(q(0))).toBeNull();
    expect(phaseAnnouncement(q(0, { state: 'sent' }))).toMatch(/^Answer sent/);
    expect(phaseAnnouncement(q(0, { state: 'answered', answered_by: 'other' }))).toBe('Question answered elsewhere.');
    expect(phaseAnnouncement(q(0, { error: 'nope' }))).toBe('Answer not sent: nope.');
    expect(phaseAnnouncement(q(0, { state: 'sent', undelivered: true }))).toMatch(/not delivered/);
  });
});

describe('an answer, checked as the bridge does', () => {
  it('takes one of the suggested answers exactly when there are some', () => {
    const withOpts = { options: ['Green', 'Blue'] };
    expect(answerProblem(withOpts, 'Green')).toBeNull();
    expect(answerProblem(withOpts, 'green')).toBe('Pick one of the suggested answers.');
    expect(answerProblem(withOpts, '')).toBe('Pick one of the suggested answers.');
  });

  it('takes 1–4096 bytes of text that is not blank, line ends and tabs but no other control characters', () => {
    expect(answerProblem({}, 'Use the v2 importer.\n\tThanks')).toBeNull();
    expect(answerProblem({}, '   \n')).toBe('Write an answer first.');
    expect(answerProblem({}, 'a\u0007b')).toMatch(/control character/);
    expect(answerProblem({}, 'a\rb')).toMatch(/control character/);
    expect(answerProblem({}, 'a\u0085b')).toMatch(/control character/);
    expect(answerProblem({}, 'x\uD800y')).toMatch(/broken character/);
    expect(answerProblem({}, '😀'.repeat(1024))).toBeNull(); // 4096 bytes
    expect(answerProblem({}, `${'😀'.repeat(1024)}a`)).toBe('Too long: 4097 bytes, the most is 4096.');
  });

  it('builds worker.answer_async in index order', () => {
    expect(answerAsyncArgs('w1', { thread: 'th1', batch: 'call_3' }, [{ index: 2, answer: 'b' }, { index: 0, answer: 'a' }])).toEqual({
      id: 'w1',
      thread: 'th1',
      batch: 'call_3',
      answers: [
        { index: 0, answer: 'a' },
        { index: 2, answer: 'b' },
      ],
    });
  });
});
