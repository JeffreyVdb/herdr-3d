import { describe, expect, it } from 'vitest';
import type { Followup } from '../net/protocol';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  acceptAllRecommendations,
  acceptRecommendation,
  answerFollowupArgs,
  emptyFollowupPicks,
  followupLine,
  followupOf,
  followupPrompt,
  FollowupsBook,
  followupsStateOf,
  isRecommended,
  pickValue,
  recommendationsLeft,
  recommendedPick,
  setText,
  unansweredNames,
  validFollowup,
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
    expect(followupPrompt(x, p)).toBe('Answers to your open questions:\n1. Does X still need Y? → No not any more\n2. Ship now or wait for the e2e-live run? → Wait for e2e-live\nUnanswered: 3');
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

// #60: a grill round as the bridge reads it (game/fixtures/followup-grill.json, from internal/followup's golden test).

const grill = (): Followup => JSON.parse(readFileSync(resolve(import.meta.dirname, '../../fixtures/followup-grill.json'), 'utf8')) as Followup;

describe('grill rounds (#60)', () => {
  it('keeps the labels, context and recommendations, and takes a follow-up from an older bridge', () => {
    const f = validFollowup(grill())!;
    expect(f.questions.map((q) => q.label)).toEqual(['Q8', 'Q9', 'Q10', 'Q11', 'Q12', 'Q13', 'Q14', 'Q15', 'Q16', 'Q17']);
    expect(f.questions[1]!.recommendation).toEqual({ text: expect.stringMatching(/^\(c\), default on\./), option: 2 });
    expect(f.questions[0]!.context).toContain('- worktree flag: the default?');
    // An older bridge: none of the new fields, still a follow-up.
    expect(validFollowup({ turn_id: 't', score: 1, source: 'model', at: 1, questions: [{ id: 'q1', question: 'x?', kind: 'open' }] })).not.toBeNull();
    // Malformed new fields are dropped, not the follow-up.
    const odd = validFollowup({ ...f, unlisted: -2, questions: [{ id: 'q1', question: 'x?', kind: 'choice', options: ['a', 'b'], label: 3, recommendation: { text: 'b', option: 9 } }] })!;
    expect(odd.questions[0]).toEqual({ id: 'q1', question: 'x?', kind: 'choice', options: ['a', 'b'], recommendation: { text: 'b' } });
    expect(odd.unlisted).toBeUndefined();
  });

  it('accepts one recommendation, all of them (yours stay), and pairs the answers by label', () => {
    const f = grill();
    let p = emptyFollowupPicks(f);
    // Q8 open: its whole text; Q9 a choice: the option it names.
    expect(recommendedPick(f, 0)).toEqual({ value: null, text: f.questions[0]!.recommendation!.text });
    p = acceptRecommendation(f, p, 1);
    expect(p[1]).toEqual({ value: '(c) Per-schedule checkbox "wake floor if asleep", default on.', text: '' });
    expect(isRecommended(f, p, 1)).toBe(true);
    // Overridden: Q10 (a).
    p = pickValue(f, p, 2, f.questions[2]!.options![0]!);
    expect(unansweredNames(f, p)).toEqual(['Q8', 'Q11', 'Q12', 'Q13', 'Q14', 'Q15', 'Q16', 'Q17']);
    expect(followupPrompt(f, p)).toBe(
      'Answers to your open questions:\n' +
        '- Q9 Asleep floor at fire time → (c) Per-schedule checkbox "wake floor if asleep", default on. (your recommendation)\n' +
        '- Q10 Desks full at fire time → (a) Fail immediately with `failed: no_desk`.\n' +
        'Unanswered: Q8, Q11, Q12, Q13, Q14, Q15, Q16, Q17',
    );
    const all = acceptAllRecommendations(f, p);
    expect(all.filled).toBe(8);
    expect(all.picks[2]!.value).toBe(f.questions[2]!.options![0]); // yours stays
    expect(answerFollowupArgs('w', f, all.picks)?.answers).toHaveLength(10);
    // A note on it is no acceptance; editing an open one's text neither.
    expect(isRecommended(f, setText(f, all.picks, 0, `${f.questions[0]!.recommendation!.text} Also X.`), 0)).toBe(false);
    // The round's note ends the prompt.
    expect(followupPrompt(f, emptyFollowupPicks(f), 'Later.')).toMatch(/\nUnanswered: Q8, .*Q17\n\nLater\.$/);
    expect(answerFollowupArgs('w', f, emptyFollowupPicks(f), ' Later. ')).toEqual({ id: 'w', turn_id: f.turn_id, answers: [], note: 'Later.' });
  });

  it('copies a long recommendation whole, and never accepts a cut one', () => {
    const long = 'Prepare audit rows before cutover. '.repeat(40) + 'Never delete the existing production database.';
    const cutText = `${'Prepare audit rows before cutover. '.repeat(228)}…`;
    const f = validFollowup({ turn_id: 't', score: 1, source: 'parsed', at: 1, questions: [
      { id: 'q1', label: 'Q1', question: 'Cutover?', kind: 'open', recommendation: { text: long } },
      { id: 'q2', label: 'Q2', question: 'Old data?', kind: 'open', recommendation: { text: cutText, cut: true } },
      { id: 'q3', label: 'Q3', question: 'Which?', kind: 'choice', options: ['(a) Keep', '(b) Drop'], recommendation: { text: `(a). ${cutText}`, option: 0, cut: true } },
      { id: 'q4', label: 'Q4', question: 'How?', kind: 'choice', options: ['(a) Fast', '(b) Slow'], recommendation: { text: cutText, cut: true } },
    ] })!;
    expect(f.questions[1]!.recommendation).toEqual({ text: cutText, cut: true });
    // One accepted: all of it, the agent's recommendation.
    const one = acceptRecommendation(f, emptyFollowupPicks(f), 0);
    expect(one[0]).toEqual({ value: null, text: long });
    expect(followupPrompt(f, one)).toContain(`- Q1 Cutover? → ${long} (your recommendation)\n`);
    // A cut text is not offered (its option, sent whole, is).
    expect([1, 2, 3].map((i) => recommendedPick(f, i))).toEqual([null, { value: '(a) Keep', text: '' }, null]);
    expect(recommendationsLeft(f, emptyFollowupPicks(f))).toBe(2);
    const all = acceptAllRecommendations(f, emptyFollowupPicks(f));
    expect(all.filled).toBe(2);
    expect(all.picks.map((p) => p.value ?? p.text)).toEqual([long, '', '(a) Keep', '']);
    expect(followupPrompt(f, all.picks)).toBe(
      'Answers to your open questions:\n' + `- Q1 Cutover? → ${long} (your recommendation)\n` + '- Q3 Which? → (a) Keep (your recommendation)\n' + 'Unanswered: Q2, Q4',
    );
    // Typed out as it is shown, it is your answer, not the agent's.
    expect(isRecommended(f, setText(f, all.picks, 1, cutText), 1)).toBe(false);
  });

  it('a yes / no recommendation picks Yes or No when it says one', () => {
    const f: Followup = { turn_id: 't', score: 1, source: 'model', at: 1, questions: [
      { id: 'q1', question: 'Both?', kind: 'yes_no', recommendation: { text: '**Yes to both.** Because.' } },
      { id: 'q2', question: 'Ship?', kind: 'yes_no', recommendation: { text: 'Depends on CI.' } },
    ] };
    expect(recommendedPick(f, 0)).toEqual({ value: 'Yes', text: '' });
    expect(recommendedPick(f, 1)).toBeNull();
  });
});
