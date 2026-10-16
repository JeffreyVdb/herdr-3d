// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandArgs, Followup } from '../net/protocol';
import { FollowupCard, type FollowupMessage, type FollowupResult } from './followupCard';
import { FollowupDrafts } from './followupDrafts';
import { mountTranscript, type TranscriptView } from './transcriptRender';

// #90: the follow-up card: its questions stacked (the open one, the others folded to their answer), yes/no with a note,
// a choice with Other, an open textarea; only Send (or Ctrl+Enter) sends what is answered, saying how many of them;
// an ack makes it go; the hint says it was detected automatically.

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
const press = (c: FollowupCard, key: string, opts: KeyboardEventInit = {}) => c.key(new KeyboardEvent('keydown', { key, ...opts }));

describe('FollowupCard (#90)', () => {
  let card: FollowupCard | null = null;
  afterEach(() => {
    card?.destroy();
    card = null;
  });

  it('stacks the questions, says it was detected automatically, and sends what is answered (saying how many)', async () => {
    const t = host();
    const c = (card = new FollowupCard(t.h));
    document.body.append(c.el);
    c.set(followup());
    expect(c.el.hidden).toBe(false);
    expect(c.el.querySelector('.tx-fu-auto')?.textContent).toBe('Detected automatically');
    // The first open, the others folded to their question.
    expect(c.el.querySelector('.tx-ask-q .tx-ask-chip')?.textContent).toBe('Question 1');
    expect([...c.el.querySelectorAll('.tx-ask-row-text')].map((x) => x.textContent)).toEqual(['Ship now or wait?', 'Anything else?']);
    expect([...c.el.querySelectorAll('.tx-ask-opt-label')].map((x) => x.textContent)).toEqual(['Yes', 'No']);
    expect(c.el.querySelector('.tx-ask-send')?.getAttribute('aria-disabled')).toBe('true');
    // 2 picks No and moves on to the choice: its options and Other; the first folds to its answer.
    expect(press(c, '2')).toBe(true);
    expect(c.el.querySelector('.tx-ask-q .tx-ask-chip')?.textContent).toBe('Question 2');
    expect([...c.el.querySelectorAll('.tx-ask-opt-label')].map((x) => x.textContent)).toEqual(['Ship now', 'Wait', 'Other']);
    expect(c.el.querySelector('.tx-ask-row.is-done .tx-ask-row-text')?.textContent).toBe('No');
    expect(c.el.querySelector('.tx-ask-hint-text')?.textContent).toBe('1 of 3 answered: questions 2, 3 go as unanswered');
    expect(c.el.querySelector('.tx-ask-send')?.firstChild?.textContent).toBe('Send 1 of 3');
    // ← → change question; Tab and Enter on the timeline are not the card's (the focus, the prompt box).
    expect(press(c, 'Tab')).toBe(false);
    expect(press(c, 'ArrowRight')).toBe(true);
    expect(c.el.querySelector('textarea.tx-fu-text')).not.toBeNull();
    expect(c.el.querySelector('.tx-ask-keys')?.textContent).toMatch(/^← → question · .+ send · Esc back$/);
    expect(press(c, 'Enter')).toBe(false);
    await flush();
    expect(t.answers).toEqual([]);
    c.el.querySelector<HTMLButtonElement>('.tx-ask-send')!.click();
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
    c.el.querySelector<HTMLButtonElement>('.tx-ask-send')!.click();
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
    expect(c.el.querySelector('.tx-ask-stack')).toBeNull();
    c.suppress(true);
    expect(c.el.hidden).toBe(true);
    c.suppress(false);
    expect(c.el.hidden).toBe(false);
  });
});

// The keyboard on the transcript view with a card up: Tab moves the focus through the card and on to the prompt box
// (never cycles questions), ← → change question, Enter on the timeline is the page's (the prompt box), Enter in the
// card never sends: on an option it picks, in a text it moves on, on the question it says how to pick.
describe('FollowupCard keyboard in the transcript (#90)', () => {
  let view: TranscriptView | null = null;
  let root: HTMLDivElement;
  afterEach(() => {
    view?.destroy();
    view = null;
    root.remove();
  });

  function mount() {
    const answers: Array<CommandArgs['worker.answer_followup']> = [];
    root = document.createElement('div');
    document.body.append(root);
    view = mountTranscript(root, {
      images: null,
      onPromptSubmit: () => Promise.resolve(true),
      onAnswer: () => {},
      onAnswerAsk: async () => ({ ok: true, resolved: true }),
      onAnswerFollowup: (a) => (answers.push(a), Promise.resolve({ ok: true })),
      onSwitchToTerminal: () => {},
      loadSubagent: async () => [],
    });
    view.setFollowup(followup());
    return { answers, $: <E extends Element = HTMLElement>(sel: string) => root.querySelector<E>(sel)! };
  }
  const key = (target: Element, k: string, shiftKey = false, ctrlKey = false) => {
    const e = new KeyboardEvent('keydown', { key: k, shiftKey, ctrlKey, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  };
  const activeTab = () => root.querySelector('.tx-ask-q .tx-ask-chip')?.textContent;
  /** The Tab order (no positive tabindex here): enabled controls and tabindex 0, in document order. A browser puts
   * the prompt box (contenteditable) in it; jsdom reports its tabIndex as -1. */
  const tabbable = () =>
    [...root.querySelectorAll<HTMLElement>('button, input, textarea, [contenteditable="true"], [tabindex]')].filter(
      (el) => !(el as HTMLButtonElement).disabled && (el.tabIndex >= 0 || (el.getAttribute('contenteditable') === 'true' && !el.hasAttribute('tabindex'))) && !el.closest('[hidden]'),
    );

  it('Tab and Shift+Tab are never the card’s: not on the timeline, not in its texts, not on its buttons', () => {
    const { $ } = mount();
    for (const [sel, shift] of [['.tx-scroll', false], ['.tx-scroll', true], ['.tx-fu-text', false], ['.tx-fu-text', true], ['.tx-ask-opt', false], ['.tx-ask-dismiss', false]] as const) {
      const e = key($(sel), 'Tab', shift);
      expect(e.defaultPrevented, `${shift ? 'Shift+' : ''}Tab on ${sel}`).toBe(false);
      expect(activeTab()).toContain('Question 1');
    }
    // Question 3 (open): its textarea lets Tab go too.
    key($('.tx-scroll'), 'ArrowRight');
    key($('.tx-scroll'), 'ArrowRight');
    expect(activeTab()).toContain('Question 3');
    expect(key($('textarea.tx-fu-text'), 'Tab').defaultPrevented).toBe(false);
    expect(activeTab()).toContain('Question 3');
  });

  it('the Tab order runs through the open question, the folded ones, Dismiss, Send and the prompt box', () => {
    const { $ } = mount();
    key($('.tx-scroll'), '1'); // Yes: on to question 2, Send is on
    const order = tabbable();
    const at = (el: Element) => order.indexOf(el as HTMLElement);
    const opt = at($('.tx-ask-q .tx-ask-opt'));
    const other = at($('.tx-fu-text'));
    const rows = [...root.querySelectorAll('.tx-ask-row')].map(at);
    const dismiss = at($('.tx-ask-dismiss'));
    const send = at($('.tx-ask-send'));
    const prompt = at($('.tx-input'));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r >= 0)).toBe(true);
    expect([opt < other, (rows[1] as number) < dismiss, dismiss < send, send < prompt]).toEqual([true, true, true, true]);
  });

  it('the bug: a click on question 1, then Enter, sends nothing (the next question has the keyboard and says how to pick)', async () => {
    const { $, answers } = mount();
    $<HTMLButtonElement>('.tx-ask-opt[data-n="2"]').click(); // No
    expect(activeTab()).toBe('Question 2');
    expect(document.activeElement).toBe($('.tx-ask-q'));
    const e = key(document.activeElement!, 'Enter');
    expect(e.defaultPrevented).toBe(true);
    await flush();
    expect(answers).toEqual([]);
    expect($('.tx-ask-nudge.is-loud').textContent).toContain('Enter picks nothing here');
    expect(root.querySelector('.tx-ask-q .tx-ask-opt.is-on')).toBeNull();
  });

  it('the bug: an answer typed in question 1, then Enter, moves on and sends nothing', async () => {
    const { $, answers } = mount();
    key($('.tx-scroll'), 'ArrowRight'); // the choice
    const t = $<HTMLInputElement>('.tx-fu-text');
    t.focus();
    t.value = 'After lunch';
    t.dispatchEvent(new Event('input'));
    expect(key(t, 'Enter').defaultPrevented).toBe(true);
    await flush();
    expect(answers).toEqual([]);
    expect(activeTab()).toBe('Question 3'); // the next one without an answer
    expect(document.activeElement).toBe($('textarea.tx-fu-text'));
  });

  it('only Send or Ctrl+Enter sends, what is answered; Shift+Enter is a new line in an open answer', async () => {
    const { $, answers } = mount();
    key($('.tx-scroll'), 'ArrowRight');
    key($('.tx-scroll'), 'ArrowRight');
    const area = $<HTMLTextAreaElement>('textarea.tx-fu-text');
    area.focus();
    expect(key(area, 'Enter', true).defaultPrevented).toBe(false);
    area.value = 'Nope';
    area.dispatchEvent(new Event('input'));
    // Enter takes it and moves on to the first question without an answer: still nothing sent.
    key(area, 'Enter');
    await flush();
    expect(answers).toEqual([]);
    expect(activeTab()).toBe('Question 1');
    key(document.activeElement!, 'Enter', false, true);
    await flush();
    expect(answers).toEqual([{ id: '', turn_id: 't1', answers: [{ id: 'q3', value: 'Nope' }] }]);
  });

  it('Ctrl+Enter with nothing answered: nothing sent, the open question says why', async () => {
    const { $, answers } = mount();
    key($('.tx-scroll'), 'Enter', false, true);
    await flush();
    expect(answers).toEqual([]);
    expect($('.tx-ask-note').textContent).toBe('Answer at least one question first.');
  });

  it('Enter on the timeline is not the card’s: nothing is sent, the page takes it to the prompt box', async () => {
    const { $, answers } = mount();
    key($('.tx-scroll'), '2'); // No
    const e = key($('.tx-scroll'), 'Enter');
    expect(e.defaultPrevented).toBe(false);
    await flush();
    expect(answers).toEqual([]);
  });
});

// #60: a grill round (game/fixtures/followup-grill.json): labels, context, recommendations; R and Use all only fill;
// the foot says what goes unanswered; a fallback says why, retries, shows the message, and keeps what you wrote.
const grill = (): Followup => JSON.parse(readFileSync(resolve(import.meta.dirname, '../../fixtures/followup-grill.json'), 'utf8')) as Followup;
const fallbackOf = (g: Followup): Followup => ({
  turn_id: g.turn_id,
  score: g.score,
  source: 'fallback',
  at: g.at,
  tail: 'Q17 … 5 min grace.',
  error: 'the model used its whole completion budget (8192 of 8192 tokens, 8192 of them reasoning) before writing any text',
  questions: [{ id: 'q1', question: 'The agent asked you something', kind: 'open' }],
});

describe('FollowupCard, a grill round (#60)', () => {
  let card: FollowupCard | null = null;
  afterEach(() => {
    card?.destroy();
    card = null;
  });

  function grillHost(drafts = new FollowupDrafts(null)) {
    const t = host();
    const retries: string[] = [];
    let retry: () => FollowupResult = () => ({ ok: true });
    const h = {
      ...t.h,
      retry: (turn: string) => (retries.push(turn), Promise.resolve(retry())),
      message: (): Promise<FollowupMessage> => Promise.resolve({ ok: true, text: 'Round 2.\n\n- **Q8** first', cut: false }),
      drafts: { get: (turn: string) => drafts.get('w1', turn), set: (turn: string, d: Parameters<FollowupDrafts['set']>[2]) => drafts.set('w1', turn, d), clear: (turn: string) => drafts.clear('w1', turn) },
    };
    return { ...t, h, retries, drafts, onRetry: (fn: () => FollowupResult) => (retry = fn) };
  }

  it('names each question as the agent did, renders its context and shows its recommendation', () => {
    const t = grillHost();
    const c = (card = new FollowupCard(t.h));
    document.body.append(c.el);
    c.set(grill());
    expect(c.el.querySelector('.tx-ask-q .tx-ask-chip')?.textContent).toBe('Q8');
    expect([...c.el.querySelectorAll('.tx-ask-row-head')].map((x) => x.textContent)).toEqual(['Q9', 'Q10', 'Q11', 'Q12', 'Q13', 'Q14', 'Q15', 'Q16', 'Q17']);
    expect(c.el.querySelectorAll('.tx-fu-context li')).toHaveLength(2);
    expect(c.el.querySelector('.tx-fu-context code')?.textContent).toBe('worker.hire');
    expect(c.el.querySelector('.tx-fu-rec-text')?.textContent).toMatch(/^Store the full spec/);
    expect(c.el.querySelector('.tx-fu-progress')?.textContent).toBe('0 of 10 answered');
    expect(c.el.querySelector('.tx-ask-keys')?.textContent).toContain('R recommendation');
    // Q9: options with their Markdown, the recommended one marked.
    press(c, 'ArrowRight');
    const opts = [...c.el.querySelectorAll('button.tx-ask-opt')];
    expect(opts.map((o) => o.querySelector('.tx-ask-rec')?.textContent ?? '')).toEqual(['', '', 'Recommended']);
    expect(opts[1]!.querySelector('code')?.textContent).toBe('failed: floor_asleep');
  });

  it('R and Use all only fill; an override stays; the foot names what goes unanswered; one Send sends it all', async () => {
    const t = grillHost();
    const c = (card = new FollowupCard(t.h));
    document.body.append(c.el);
    c.set(grill());
    // R on Q8 (open): the whole recommendation in its text, the keyboard there to edit; nothing sent.
    expect(press(c, 'r')).toBe(true);
    expect((c.el.querySelector('textarea.tx-fu-text') as HTMLTextAreaElement).value).toMatch(/^Store the full spec.*not stored\.$/);
    expect(c.el.querySelector('.tx-fu-rec.is-using')).not.toBeNull();
    // Q9: R picks (c) and moves on; 1 (a) on Q10 overrides it.
    press(c, 'ArrowRight');
    press(c, 'r');
    expect(c.el.querySelector('.tx-ask-q .tx-ask-chip')?.textContent).toBe('Q10');
    press(c, '1');
    expect(c.el.querySelector('.tx-ask-hint-text')?.textContent).toBe('3 of 10 answered: Q11, Q12, Q13, Q14 and 3 more go as unanswered');
    expect(c.el.querySelector('.tx-ask-send')?.firstChild?.textContent).toBe('Send 3 of 10');
    await flush();
    expect(t.answers).toEqual([]);
    c.el.querySelector<HTMLButtonElement>('.tx-fu-all')!.click();
    expect(c.el.querySelector('.tx-fu-progress')?.textContent).toBe('10 of 10 answered');
    expect(c.el.querySelector('.tx-ask-note')?.textContent).toMatch(/^Filled 7 answers/);
    expect(c.el.querySelector<HTMLButtonElement>('.tx-fu-all')!.disabled).toBe(true);
    await flush();
    expect(t.answers).toEqual([]);
    press(c, 'Enter', { ctrlKey: true });
    await flush();
    expect(t.answers).toHaveLength(1);
    const sent = t.answers[0]!.answers;
    expect(sent).toHaveLength(10);
    expect(sent[2]).toEqual({ id: 'q3', value: '(a) Fail immediately with `failed: no_desk`.' });
    expect(c.shown).toBe(false);
  });

  it('a fallback says why, shows the whole message, retries, and keeps your reply as the round’s note', async () => {
    const drafts = new FollowupDrafts(null);
    const t = grillHost(drafts);
    const c = (card = new FollowupCard(t.h));
    document.body.append(c.el);
    const g = grill();
    c.set(fallbackOf(g));
    expect(c.el.querySelector('.tx-fu-fail-why')?.textContent).toContain('whole completion budget');
    const area = c.el.querySelector<HTMLTextAreaElement>('textarea.tx-fu-text')!;
    area.value = 'Q9: (a).';
    area.dispatchEvent(new Event('input'));
    // The whole message, on request, rendered.
    [...c.el.querySelectorAll('button')].find((b) => b.textContent === 'Show the whole message')!.click();
    await flush();
    expect(c.el.querySelector('.tx-fu-msg strong')?.textContent).toBe('Q8');
    expect(c.el.querySelector('.tx-fu-tail')).toBeNull();
    // Retry: refused, it says why and keeps the text.
    t.onRetry(() => ({ ok: false, code: 'invalid_state', message: 'Retried 3 times already.' }));
    c.el.querySelector<HTMLButtonElement>('[data-key="retry"]')!.click();
    await flush();
    expect(t.retries).toEqual([g.turn_id]);
    expect(c.el.querySelector('.tx-ask-note.is-error')?.textContent).toBe('Retried 3 times already.');
    expect(c.el.querySelector<HTMLTextAreaElement>('textarea.tx-fu-text')!.value).toBe('Q9: (a).');
    // A view made meanwhile (standing up and sitting down) gets the draft back.
    const again = new FollowupCard(t.h);
    again.set(fallbackOf(g));
    expect(again.el.querySelector<HTMLTextAreaElement>('textarea.tx-fu-text')!.value).toBe('Q9: (a).');
    again.destroy();
    // The retry's upsert reads the round: the reply is the round's note, sent after the answers.
    c.set(g);
    expect(c.el.querySelector<HTMLTextAreaElement>('textarea.tx-fu-note')!.value).toBe('Q9: (a).');
    expect(c.el.querySelector('.tx-ask-q textarea.tx-fu-text')).not.toBeNull();
    expect((c.el.querySelector('.tx-ask-q textarea.tx-fu-text') as HTMLTextAreaElement).value).toBe('');
    expect(c.el.querySelector('.tx-ask-send')?.firstChild?.textContent).toBe('Send your reply');
    press(c, 'ArrowRight');
    press(c, '1');
    c.el.querySelector<HTMLButtonElement>('.tx-ask-send')!.click();
    await flush();
    expect(t.answers).toEqual([{ id: '', turn_id: g.turn_id, answers: [{ id: 'q2', value: '(a) Auto-wake the floor, then hire.' }], note: 'Q9: (a).' }]);
    expect(drafts.get('w1', g.turn_id)).toBeNull(); // sent: the draft goes
  });

  it('says how many questions are only in the message', () => {
    const t = grillHost();
    const c = (card = new FollowupCard(t.h));
    document.body.append(c.el);
    c.set({ ...grill(), unlisted: 2 });
    expect(c.el.querySelector('.tx-fu-unlisted')?.textContent).toMatch(/^2 more questions are only in the agent’s message/);
  });

  it('a cut recommendation is shown with the whole message, never offered to use', () => {
    const t = grillHost();
    const c = (card = new FollowupCard(t.h));
    document.body.append(c.el);
    const f = grill();
    f.questions[0]!.recommendation = { text: 'Store the full spec …', cut: true };
    c.set(f);
    expect(c.el.querySelector('.tx-fu-rec-text')?.textContent).toMatch(/^Store the full spec/);
    expect(c.el.querySelector('.tx-fu-rec-cut')?.textContent).toMatch(/cannot be used as it is: Show the whole message has all of it\.$/);
    expect(c.el.querySelector('[data-key="use-rec"]')).toBeNull();
    expect(c.el.querySelector('.tx-ask-keys')?.textContent).not.toContain('R recommendation');
    press(c, 'r');
    expect(c.el.querySelector('.tx-fu-progress')?.textContent).toBe('0 of 10 answered');
    expect(c.el.querySelector('[data-key="message"]')).not.toBeNull();
  });
});
