// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandArgs, Followup } from '../net/protocol';
import { FollowupCard, type FollowupResult } from './followupCard';

// #90: the follow-up card: tabs per question, yes/no with a note, a choice with Other, an open textarea; Send answers
// sends what is answered; an ack makes it go; the hint says it was detected automatically.

const followup = (turn = 't1'): Followup => ({
  turn_id: turn,
  score: 0.96,
  source: 'model',
  at: Date.now(),
  questions: [
    { id: 'q1', question: 'Does the importer still need v1?', kind: 'yes_no' },
    { id: 'q2', question: 'Ship now or wait?', kind: 'choice', options: ['Ship now', 'Wait'] },
    { id: 'q3', question: 'Anything else?', kind: 'open' },
  ],
});

function host() {
  const answers: Array<CommandArgs['worker.answer_followup']> = [];
  const dismissed: string[] = [];
  let result: FollowupResult = { ok: true };
  return {
    answers,
    dismissed,
    setResult: (r: FollowupResult) => (result = r),
    h: {
      answer: (args: CommandArgs['worker.answer_followup']) => (answers.push(args), Promise.resolve(result)),
      dismiss: (t: string) => (dismissed.push(t), Promise.resolve(result)),
      focusTimeline: () => {},
      resized: () => {},
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};
const press = (c: FollowupCard, key: string, shiftKey = false) => c.key(new KeyboardEvent('keydown', { key, shiftKey }));

describe('FollowupCard (#90)', () => {
  let card: FollowupCard | null = null;
  afterEach(() => {
    card?.destroy();
    card = null;
  });

  it('shows the questions as tabs, says it was detected automatically, and sends what is answered', async () => {
    const t = host();
    const c = (card = new FollowupCard(t.h));
    document.body.append(c.el);
    c.set(followup());
    expect(c.el.hidden).toBe(false);
    expect(c.el.querySelector('.tx-fu-auto')?.textContent).toBe('Detected automatically');
    expect([...c.el.querySelectorAll('.tx-ask-tab')].map((x) => x.textContent)).toEqual(['1Question 1', '2Question 2', '3Question 3']);
    expect([...c.el.querySelectorAll('.tx-ask-opt-label')].map((x) => x.textContent)).toEqual(['Yes', 'No']);
    expect(c.el.querySelector<HTMLButtonElement>('.tx-ask-send')!.disabled).toBe(true);
    // 2 picks No and moves on to the choice: its options and Other.
    expect(press(c, '2')).toBe(true);
    expect(c.el.querySelector('.tx-ask-tab.is-active')?.textContent).toContain('Question 2');
    expect([...c.el.querySelectorAll('.tx-ask-opt-label')].map((x) => x.textContent)).toEqual(['Ship now', 'Wait', 'Other']);
    expect(c.el.querySelector('.tx-ask-hint-text')?.textContent).toBe('1 of 3 answered: the rest are left out');
    press(c, 'Tab');
    expect(c.el.querySelector('textarea.tx-fu-text')).not.toBeNull();
    press(c, 'Enter');
    await flush();
    expect(t.answers).toEqual([{ id: '', turn_id: 't1', answers: [{ id: 'q1', value: 'No' }] }]);
    expect(c.shown).toBe(false); // acked: it goes, before its upsert
    c.set(followup()); // the upsert still on its way: not back
    expect(c.shown).toBe(false);
    c.set(followup('t2'));
    expect(c.shown).toBe(true);
  });

  it('keeps it on a failure and says why; Dismiss sends the turn', async () => {
    const t = host();
    const c = (card = new FollowupCard(t.h));
    document.body.append(c.el);
    c.set(followup());
    press(c, '1');
    t.setResult({ ok: false, code: 'prompt_failed', message: 'The prompt did not go through.' });
    press(c, 'Enter');
    await flush();
    expect(c.shown).toBe(true);
    expect(c.el.querySelector('.tx-ask-note.is-error')?.textContent).toBe('The prompt did not go through.');
    t.setResult({ ok: true });
    [...c.el.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')!.click();
    await flush();
    expect(t.dismissed).toEqual(['t1']);
    expect(c.shown).toBe(false);
  });

  it('a fallback shows the message’s end and takes a free answer; an ask’s card hides it', () => {
    const t = host();
    const c = (card = new FollowupCard(t.h));
    document.body.append(c.el);
    c.set({ ...followup(), source: 'fallback', tail: 'Should I keep v1?', questions: [{ id: 'q1', question: 'The agent asked you something', kind: 'open' }] });
    expect(c.el.querySelector('.tx-fu-tail')?.textContent).toBe('Should I keep v1?');
    expect(c.el.querySelector('.tx-ask-tab')).toBeNull();
    c.suppress(true);
    expect(c.el.hidden).toBe(true);
    c.suppress(false);
    expect(c.el.hidden).toBe(false);
  });
});
