// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandArgs, Followup } from '../net/protocol';
import { FollowupCard, type FollowupResult } from './followupCard';
import { mountTranscript, type TranscriptView } from './transcriptRender';

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
    // ← → change question; Tab and Enter on the timeline are not the card's (the focus, the prompt box).
    expect(press(c, 'Tab')).toBe(false);
    expect(press(c, 'ArrowRight')).toBe(true);
    expect(c.el.querySelector('textarea.tx-fu-text')).not.toBeNull();
    expect(c.el.querySelector('.tx-ask-keys')?.textContent).toBe('← → question · Esc back');
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
    expect(c.el.querySelector('.tx-ask-tab')).toBeNull();
    c.suppress(true);
    expect(c.el.hidden).toBe(true);
    c.suppress(false);
    expect(c.el.hidden).toBe(false);
  });
});

// The keyboard on the transcript view with a card up: Tab moves the focus through the card and on to the prompt box
// (never cycles questions), ← → on the tab list change question, Enter on the timeline is the page's (the prompt box).
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
  const key = (target: Element, k: string, shiftKey = false) => {
    const e = new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  };
  const activeTab = () => root.querySelector('.tx-ask-tab.is-active')?.textContent;
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

  it('the Tab order runs through the card (one tab stop for the tab list) to Dismiss, Send and the prompt box', () => {
    const { $ } = mount();
    // One stop for the tab list: the active tab.
    expect([...root.querySelectorAll<HTMLElement>('.tx-ask-tab')].map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    key($('.tx-scroll'), '1'); // Yes: Send is on
    key($('.tx-scroll'), 'ArrowLeft');
    const order = tabbable();
    const at = (el: Element) => order.indexOf(el as HTMLElement);
    const tab = at($('.tx-ask-tab.is-active'));
    const note = at($('.tx-fu-text'));
    const dismiss = at($('.tx-ask-dismiss'));
    const send = at($('.tx-ask-send'));
    const prompt = at($('.tx-input'));
    expect(tab).toBeGreaterThanOrEqual(0);
    expect([tab < note, note < dismiss, dismiss < send, send < prompt]).toEqual([true, true, true, true]);
  });

  it('← → on the tab list change question and keep the focus on the tabs; Home / End go to the ends', () => {
    const { $ } = mount();
    $('.tx-ask-tab.is-active').focus();
    expect(key(document.activeElement!, 'ArrowRight').defaultPrevented).toBe(true);
    expect(activeTab()).toContain('Question 2');
    expect(document.activeElement).toBe($('.tx-ask-tab.is-active'));
    expect($<HTMLElement>('.tx-ask-tab.is-active').tabIndex).toBe(0);
    key(document.activeElement!, 'End');
    expect(activeTab()).toContain('Question 3');
    key(document.activeElement!, 'Home');
    expect(activeTab()).toContain('Question 1');
    key(document.activeElement!, 'ArrowLeft');
    expect(activeTab()).toContain('Question 3');
    expect(document.activeElement).toBe($('.tx-ask-tab.is-active'));
  });

  it('Enter on the timeline is not the card’s: nothing is sent, the page takes it to the prompt box', async () => {
    const { $, answers } = mount();
    key($('.tx-scroll'), '2'); // No
    const e = key($('.tx-scroll'), 'Enter');
    expect(e.defaultPrevented).toBe(false);
    await Promise.resolve();
    expect(answers).toEqual([]);
    // In a text of the card it sends.
    key($('.tx-fu-text'), 'Enter');
    await Promise.resolve();
    expect(answers.length).toBe(1);
  });
});
