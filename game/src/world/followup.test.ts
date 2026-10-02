import { describe, expect, it } from 'vitest';
import type { Followup } from '../net/protocol';
import {
  answerFollowupArgs,
  emptyFollowupPicks,
  followupLine,
  followupOf,
  followupPrompt,
  FollowupsBook,
  followupsStateOf,
  pickValue,
  setText,
} from './followup';

const f = (over: Partial<Followup> = {}): Followup => ({
  turn_id: 't1',
  score: 0.96,
  source: 'model',
  at: 1,
  questions: [
    { id: 'q1', question: 'Does X still need Y?', kind: 'yes_no' },
    { id: 'q2', question: 'Ship now or wait for the e2e-live run?', kind: 'choice', options: ['Ship now', 'Wait for e2e-live'] },
    { id: 'q3', question: 'Anything else?', kind: 'open' },
  ],
  ...over,
});

describe('follow-up questions (#90)', () => {
  it('takes only well-formed follow-ups', () => {
    expect(followupOf({ followup: f() })).not.toBeNull();
    expect(followupOf({})).toBeNull();
    expect(followupOf({ followup: { ...f(), turn_id: '' } })).toBeNull();
    expect(followupOf({ followup: { ...f(), questions: [] } })).toBeNull();
    expect(followupOf({ followup: { ...f(), questions: [{ id: 'q1', question: 'x', kind: 'multi' }] } as never })).toBeNull();
    expect(followupOf({ followup: { ...f(), questions: [{ id: 'q1', question: 'x', kind: 'choice' }] } })).toBeNull();
  });

  it('says it in one line for the desk card', () => {
    expect(followupLine(f())).toBe('3 questions: Does X still need Y?');
    expect(followupLine(f({ questions: [{ id: 'q1', question: '  Ship\n it? ', kind: 'yes_no' }] }))).toBe('Ship it?');
    expect(followupLine(f({ source: 'fallback' }))).toBe('The agent asked you something');
  });

  it('formats the answers as the bridge does, leaving out the unanswered', () => {
    const x = f();
    let p = emptyFollowupPicks(x);
    expect(answerFollowupArgs('w', x, p)).toBeNull();
    p = pickValue(x, p, 0, 'No');
    p = setText(x, p, 0, 'not any more');
    p = pickValue(x, p, 1, 'Wait for e2e-live');
    expect(answerFollowupArgs('w', x, p)).toEqual({
      id: 'w',
      turn_id: 't1',
      answers: [
        { id: 'q1', value: 'No', note: 'not any more' },
        { id: 'q2', value: 'Wait for e2e-live' },
      ],
    });
    expect(followupPrompt(x, p)).toBe('Answers to your open questions:\n1. Does X still need Y? → No not any more\n2. Ship now or wait for the e2e-live run? → Wait for e2e-live');
    // A typed Other replaces the picked option; picking the same again drops it; Maybe is no yes/no answer.
    p = setText(x, p, 1, 'Ship on Monday');
    expect(answerFollowupArgs('w', x, p)?.answers[1]).toEqual({ id: 'q2', value: 'Ship on Monday' });
    expect(pickValue(x, p, 0, 'Maybe')).toBe(p);
    expect(pickValue(x, p, 0, 'No')[0]?.value).toBeNull();
    p = setText(x, p, 2, 'No');
    expect(answerFollowupArgs('w', x, p)?.answers).toHaveLength(3);
  });

  it('sends a fallback’s free answer as it is', () => {
    const x = f({ source: 'fallback', questions: [{ id: 'q1', question: 'The agent asked you something', kind: 'open' }] });
    const p = setText(x, emptyFollowupPicks(x), 0, '  Keep v1.  ');
    expect(followupPrompt(x, p)).toBe('Keep v1.');
  });

  it('reads the feature’s state and tells its listeners', () => {
    expect(followupsStateOf({ enabled: 'yes' })).toBeNull();
    const s = followupsStateOf({ enabled: true, threshold: 0.7, state: 'incomplete', missing: ['llm', 'x'], roles: { classifier: 'ready', llm: 'invalid' }, env: ['enabled'], tested: false, extra: 1 });
    expect(s).toEqual({ enabled: true, threshold: 0.7, state: 'incomplete', missing: ['llm'], roles: { classifier: 'ready', llm: 'invalid' }, env: ['enabled'], tested: false });
    const b = new FollowupsBook();
    let n = 0;
    b.onChange(() => n++);
    b.reset(undefined);
    expect(b.known).toBe(false);
    expect(b.upsert({ enabled: false, threshold: 0.7, state: 'off', roles: {}, env: [] })).toBe(true);
    expect(b.known).toBe(true);
    expect(n).toBe(2);
  });
});
