// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Ask, CodexBatch, CodexQuestion, CommandArgs, Followup, WorkerCodex } from '../net/protocol';
import { AsyncCard, type AsyncResult } from './asyncCard';
import { AsyncDrafts } from './asyncDrafts';
import { mountTranscript, type TranscriptView } from './transcriptRender';

// #157: a Codex worker's async questions on the transcript: a card per batch (the open one stacked, the others folded),
// suggested answers picked and texts typed without anything sent, one explicit Send that sends once, every reply state
// from the bridge's evidence (announced politely), the answer kept through refusals, drops and remounts, Hide that only
// hides here, read-only batches answered in the terminal.

const W = 'w-pixel';
const q = (index: number, over: Partial<CodexQuestion> = {}): CodexQuestion => ({ index, title: `Question ${index}?`, state: 'pending', ...over });
const color = (over: Partial<CodexQuestion> = {}) => q(0, { title: 'Which fixture color?', options: ['Green', 'Blue'], ...over });
const context = (over: Partial<CodexQuestion> = {}) => q(1, { title: 'Any context for the fixture?', ...over });
const batch = (id: string, questions: CodexQuestion[], over: Partial<CodexBatch> = {}): CodexBatch => ({ batch: id, turn: 't1', seen: ['live'], at: Date.now() - 5000, questions, ...over });
const codex = (questions: CodexBatch[], over: Partial<WorkerCodex> = {}): WorkerCodex => ({ mode: 'shared', server: 'running', attached: true, thread: 'th1', turn: 't1', questions, ...over });

function host(drafts = new AsyncDrafts(null)) {
  const answers: Array<CommandArgs['worker.answer_async']> = [];
  const dismissed: Array<CommandArgs['worker.dismiss_async']> = [];
  let result: AsyncResult = { ok: true };
  let hold: Promise<void> | null = null;
  let terminal = 0;
  return {
    answers,
    dismissed,
    drafts,
    terminal: () => terminal,
    setResult: (r: AsyncResult) => (result = r),
    hold: (p: Promise<void> | null) => (hold = p),
    h: {
      answer: async (args: CommandArgs['worker.answer_async']) => {
        answers.push(args);
        if (hold) await hold;
        return result;
      },
      dismiss: (args: CommandArgs['worker.dismiss_async']) => (dismissed.push(args), Promise.resolve(result)),
      toTerminal: () => void terminal++,
      focusTimeline: () => {},
      resized: () => {},
      drafts,
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const press = (c: AsyncCard, key: string, opts: KeyboardEventInit = {}) => c.key(new KeyboardEvent('keydown', { key, ...opts }));
const sendKey = (c: AsyncCard) => press(c, 'Enter', { ctrlKey: true });
const type = (c: AsyncCard, text: string) => {
  const t = c.el.querySelector<HTMLTextAreaElement>('textarea.tx-aq-text');
  if (!t) throw new Error('no text box');
  t.value = text;
  t.dispatchEvent(new Event('input'));
};
const state = (c: AsyncCard) => c.el.querySelector('.tx-ask-q .tx-aq-state')?.textContent ?? '';
const send = (c: AsyncCard) => c.el.querySelector<HTMLButtonElement>('.tx-ask-send[data-key="send"]');

describe('AsyncCard (#157)', () => {
  let card: AsyncCard | null = null;
  const mount = (t: ReturnType<typeof host>) => {
    const c = (card = new AsyncCard(t.h));
    document.body.append(c.el, c.live);
    return c;
  };
  afterEach(() => {
    card?.destroy();
    card = null;
  });

  it('shows a batch while Codex works on, picks and types without sending, and sends once on Send', async () => {
    const t = host();
    const c = mount(t);
    c.set(W, codex([batch('call_3', [color(), context()])]));
    expect(c.shown).toBe(true);
    expect(c.el.getAttribute('role')).toBe('region');
    expect(c.el.getAttribute('aria-label')).toBe('Codex’s questions');
    expect(c.el.querySelector('.tx-aq-tag')?.textContent).toBe('Codex asked');
    expect(c.el.querySelector('.tx-aq-work')?.textContent).toBe('still working');
    expect(c.el.querySelector('.tx-aq-ago')?.textContent).toMatch(/^asked \ds ago$/);
    // Suggested answers as radios, no free text beside them (the bridge takes one of them exactly).
    expect([...c.el.querySelectorAll('[role="radio"]')].map((x) => x.textContent)).toEqual(['1Green', '2Blue']);
    expect(c.el.querySelector('textarea')).toBeNull();
    expect(send(c)?.getAttribute('aria-disabled')).toBe('true');
    // 2 picks Blue and moves on to the open question: nothing is sent.
    expect(press(c, '2')).toBe(true);
    await flush();
    expect(t.answers).toEqual([]);
    expect(c.el.querySelector('.tx-ask-q .tx-ask-chip')?.textContent).toBe('Question 2');
    expect(c.el.querySelector('.tx-ask-row .tx-ask-row-text')?.textContent).toBe('Blue');
    expect(c.el.querySelector('.tx-ask-row .tx-ask-row-act')?.textContent).toBe('ready');
    expect(send(c)?.firstChild?.textContent).toBe('Send 1 of 2');
    // An Enter in the text box takes it and moves on, never sends.
    type(c, 'Use the staging bucket.');
    c.el.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(t.answers).toEqual([]);
    expect(send(c)?.firstChild?.textContent).toBe('Send answers');
    // Ctrl+Enter twice (a double press while the first is on its way) sends once.
    let release!: () => void;
    t.hold(new Promise<void>((r) => (release = r)));
    expect(sendKey(c)).toBe(true);
    expect(sendKey(c)).toBe(true);
    send(c)?.click();
    await flush();
    expect(t.answers).toEqual([{ id: W, thread: 'th1', batch: 'call_3', answers: [{ index: 0, answer: 'Blue' }, { index: 1, answer: 'Use the staging bucket.' }] }]);
    expect(send(c)?.textContent).toBe('Sending…');
    release();
    await flush();
    // Acked, before the upsert: still not sent again.
    sendKey(c);
    await flush();
    expect(t.answers).toHaveLength(1);
  });

  it('says every reply state from the bridge, announces the changes, and drops a draft only once answered', async () => {
    const t = host();
    const c = mount(t);
    c.set(W, codex([batch('call_3', [context({ index: 0 })])]));
    type(c, 'Keep v1 for now.');
    c.set(W, codex([batch('call_3', [context({ index: 0, state: 'sending' })])]));
    expect(state(c)).toBe('Sending…');
    await flush();
    expect(c.live.textContent).toBe('Sending your answer.');
    c.set(W, codex([batch('call_3', [context({ index: 0, state: 'sent' })])]));
    expect(state(c)).toBe('Sent — Codex will read it with its next step');
    expect(c.el.querySelector('.tx-aq-sent')?.textContent).toBe('Keep v1 for now.');
    expect(send(c)?.disabled).toBe(true);
    // The turn ended before Codex read it: the answer is kept, and may go again.
    c.set(W, codex([batch('call_3', [context({ index: 0, state: 'sent', undelivered: true })])], { turn: '' }));
    expect(state(c)).toMatch(/^Not delivered — the turn ended before Codex read it/);
    expect(c.el.querySelector('.tx-aq-work')).toBeNull(); // no running turn: not "still working"
    expect(c.el.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Keep v1 for now.');
    await flush();
    expect(c.live.textContent).toMatch(/not delivered/);
    sendKey(c);
    await flush();
    expect(t.answers.at(-1)?.answers).toEqual([{ index: 0, answer: 'Keep v1 for now.' }]);
    // Answered in the terminal: said so, with the answer; the draft goes.
    c.set(W, codex([batch('call_3', [context({ index: 0, state: 'answered', answer: 'typed-in-terminal', answered_by: 'other' })])]));
    expect(state(c)).toBe('Answered elsewhere');
    expect(c.el.querySelector('.tx-aq-sent')?.textContent).toBe('typed-in-terminal');
    expect(t.drafts.get(W, 'th1', 'call_3', 0)).toBe('');
    await flush();
    expect(c.live.textContent).toBe('Question answered elsewhere.');
    // Nothing left: it stays (it was open while you looked) until cleared.
    expect(c.shown).toBe(true);
    c.el.querySelector<HTMLButtonElement>('[data-key="clear"]')!.click();
    expect(c.shown).toBe(false);
  });

  // The bridge says sending and sent before it acks (internal/server/codexquestions.go, then input.go acks); a send
  // whose questions moved meanwhile leaves no guard, so a later return to the state they had (not delivered again, or
  // pending after a bridge restart) takes Send again. Acked before any move, it still sends once.
  describe('a second send once the bridge moved the question', () => {
    const undelivered = (over: Partial<CodexQuestion> = {}) => context({ index: 0, state: 'sent', undelivered: true, ...over });
    const returns = {
      'not delivered again': { from: undelivered(), back: undelivered() },
      'pending after a bridge restart': { from: context({ index: 0 }), back: context({ index: 0 }) },
    };
    for (const [name, { from, back }] of Object.entries(returns)) {
      for (const order of ['the upserts before the ack', 'the ack before the upserts'] as const) {
        it(`${name}, ${order}`, async () => {
          const t = host();
          const c = mount(t);
          const at = (q: CodexQuestion) => c.set(W, codex([batch('call_3', [q])]));
          at(from);
          type(c, 'Keep v1 for now.');
          let release!: () => void;
          t.hold(new Promise<void>((r) => (release = r)));
          send(c)!.click();
          send(c)!.click(); // a double click: one send
          await flush();
          expect(t.answers).toHaveLength(1);
          if (order === 'the upserts before the ack') {
            at(context({ index: 0, state: 'sending' }));
            at(context({ index: 0, state: 'sent' }));
            release();
            await flush();
          } else {
            release();
            await flush();
            // Acked, nothing moved yet: still not sent again.
            sendKey(c);
            await flush();
            expect(t.answers).toHaveLength(1);
            expect(c.el.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true);
            at(context({ index: 0, state: 'sending' }));
            at(context({ index: 0, state: 'sent' }));
          }
          expect(send(c)?.disabled).toBe(true); // sent: nothing to answer
          t.hold(null);
          at(back);
          expect(c.el.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
          expect(c.el.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Keep v1 for now.');
          expect(send(c)?.disabled).toBe(false);
          sendKey(c);
          sendKey(c); // queued twice: one send
          await flush();
          expect(t.answers).toHaveLength(2);
          expect(t.answers[1]?.answers).toEqual([{ index: 0, answer: 'Keep v1 for now.' }]);
        });
      }
    }
  });

  it('keeps the answer when the bridge refuses it, says why, and lets it go again', async () => {
    const t = host();
    const c = mount(t);
    c.set(W, codex([batch('call_3', [context({ index: 0 })])]));
    type(c, 'Retry me');
    t.setResult({ ok: false, code: 'input_failed', message: 'Not sent: Codex refused it (busy). Send it again.' });
    send(c)!.click();
    await flush();
    expect(c.el.querySelector('.tx-ask-note.is-error')?.textContent).toBe('Not sent: Codex refused it (busy). Send it again.');
    expect(c.el.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Retry me');
    expect(c.live.textContent).toBe('Not sent: Codex refused it (busy). Send it again.');
    // The bridge's own record of it: pending with its error.
    c.set(W, codex([batch('call_3', [context({ index: 0, error: 'turn/start refused the answer' })])]));
    expect(state(c)).toMatch(/^Not sent: turn\/start refused the answer\. Your answer is kept/);
    t.setResult({ ok: true });
    send(c)!.click();
    await flush();
    expect(t.answers).toHaveLength(2);
    expect(t.answers[1]?.answers).toEqual([{ index: 0, answer: 'Retry me' }]);
  });

  it('leaves the terminal toggle (Ctrl+Esc) to the seat from its text box; a bare Esc goes back to the timeline', () => {
    const t = host();
    let back = 0;
    const c = (card = new AsyncCard({ ...t.h, focusTimeline: () => void back++ }));
    document.body.append(c.el, c.live);
    c.set(W, codex([batch('call_3', [context({ index: 0 })])]));
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent) => seen.push(`${e.ctrlKey ? 'Ctrl+' : ''}${e.key}`);
    window.addEventListener('keydown', onKey);
    try {
      const area = c.el.querySelector('textarea')!;
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', ctrlKey: true, bubbles: true }));
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      area.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    } finally {
      window.removeEventListener('keydown', onKey);
    }
    expect(seen).toEqual(['Ctrl+Escape']);
    expect(back).toBe(1);
  });

  it('checks the answer as the bridge does before sending', async () => {
    const t = host();
    const c = mount(t);
    c.set(W, codex([batch('call_3', [context({ index: 0 })])]));
    send(c)!.click();
    expect(c.el.querySelector('.tx-ask-note')?.textContent).toBe('Answer at least one question first.');
    type(c, 'bell\u0007');
    send(c)!.click();
    await flush();
    expect(t.answers).toEqual([]);
    expect(c.el.querySelector('.tx-ask-note.is-error')?.textContent).toMatch(/control character/);
  });

  it('keeps drafts across a remount and a reconnect, with one card per batch', async () => {
    const drafts = new AsyncDrafts(null);
    const t = host(drafts);
    let c = mount(t);
    c.set(W, codex([batch('call_3', [color(), context()])]));
    press(c, '1');
    type(c, 'half-written');
    // The view goes (the terminal toggle) and comes back.
    c.destroy();
    c = mount(host(drafts));
    c.set(W, codex([batch('call_3', [color(), context()])]));
    // Both answered: the first is open, with its pick; the second folded to what was typed.
    expect(c.el.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('1Green');
    expect(c.el.querySelector('.tx-ask-row .tx-ask-row-text')?.textContent).toBe('half-written');
    // A reconnect: no codex for a moment, then the snapshot's (the same batch, seen again from the history).
    c.set(W, null);
    expect(c.shown).toBe(false);
    c.set(W, codex([batch('call_3', [color(), context()], { seen: ['live', 'history'] })]));
    expect(c.el.querySelectorAll('.tx-aq-batch')).toHaveLength(1);
    expect(c.el.querySelectorAll('.tx-aq-fold')).toHaveLength(0);
    press(c, 'ArrowRight');
    expect(c.el.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('half-written');
    expect(c.el.querySelector('.tx-ask-row .tx-ask-row-text')?.textContent).toBe('Green');
    expect(send(c)?.firstChild?.textContent).toBe('Send answers');
    // Another thread (a /new in the terminal): its drafts go.
    c.set(W, codex([], { thread: 'th2' }));
    expect(drafts.get(W, 'th1', 'call_3', 1)).toBe('');
  });

  it('folds the other batches, ← → walk through every question, and a twin pair is one card', () => {
    const t = host();
    const c = mount(t);
    c.set(W, codex([batch('call_3', [color()], { twin: 'item-9' }), batch('item-9', [color()], { seen: ['history'], twin: 'call_3' }), batch('call_8', [context({ index: 0 })], { turn: 't2' })]));
    expect(c.el.querySelectorAll('.tx-aq-batch')).toHaveLength(1);
    const folds = [...c.el.querySelectorAll<HTMLElement>('.tx-aq-fold')];
    expect(folds.map((f) => f.dataset.batch)).toEqual(['call_8']);
    expect(folds[0]?.textContent).toMatch(/1 question.*Any context for the fixture\?.*1 to answer/);
    expect(press(c, 'ArrowRight')).toBe(true);
    expect(c.el.querySelector<HTMLElement>('.tx-aq-batch')?.dataset.batch).toBe('call_8');
    expect(c.el.querySelector('textarea')).not.toBeNull();
    expect(press(c, 'ArrowLeft')).toBe(true);
    expect(c.el.querySelector<HTMLElement>('.tx-aq-batch')?.dataset.batch).toBe('call_3');
  });

  it('hides here only, and lists the hidden ones on demand, read-only', async () => {
    const t = host();
    const c = mount(t);
    c.set(W, codex([batch('call_3', [color(), context()])]));
    const hide = c.el.querySelector<HTMLButtonElement>('[data-key="hide"]')!;
    expect(hide.textContent).toBe('Hide');
    expect(hide.title).toBe('Hide these questions on this card. Codex still has them: nothing is sent to it.');
    hide.click();
    await flush();
    expect(t.dismissed).toEqual([{ id: W, thread: 'th1', batch: 'call_3', indexes: [0, 1] }]);
    c.set(W, codex([batch('call_3', [color({ state: 'dismissed' }), context({ state: 'dismissed' })])]));
    expect(c.shown).toBe(false);
    c.set(W, codex([batch('call_3', [color({ state: 'dismissed' }), context({ state: 'dismissed' })]), batch('call_8', [q(0)])]));
    const toggle = c.el.querySelector<HTMLButtonElement>('.tx-aq-hidden')!;
    expect(toggle.textContent).toBe('2 hidden');
    toggle.click();
    expect(toggle.isConnected).toBe(false);
    expect(c.el.querySelector('.tx-aq-hidden')?.getAttribute('aria-pressed')).toBe('true');
    expect(c.el.querySelectorAll('.tx-aq-fold, .tx-aq-batch')).toHaveLength(2);
  });

  it('is read-only for a conflict, and while not joined to the thread: answer in the terminal', () => {
    const t = host();
    const c = mount(t);
    c.set(W, codex([batch('call_3', [color()], { conflict: true })]));
    expect(c.el.querySelector('.tx-aq-ro')?.textContent).toMatch(/^Codex’s live view and its history disagree/);
    expect(c.el.querySelector('[data-key="send"]')).toBeNull();
    expect(c.el.querySelector<HTMLButtonElement>('[role="radio"]')?.disabled).toBe(true);
    expect(press(c, '1')).toBe(false);
    c.el.querySelector<HTMLButtonElement>('[data-key="term"]')!.click();
    expect(t.terminal()).toBe(1);
    c.set(W, codex([batch('call_3', [color()])], { attached: false, turn: '' }));
    expect(c.el.querySelector('.tx-aq-ro')?.textContent).toMatch(/^herdr-3d is not connected to Codex’s thread right now/);
    expect(c.el.querySelector('[data-key="term"]')?.textContent).toBe('Answer in the terminal');
  });

  it('shows nothing for a legacy worker', () => {
    const c = mount(host());
    c.set(W, { mode: 'legacy', questions: [batch('call_3', [color()])] });
    expect(c.shown).toBe(false);
    expect(c.el.hidden).toBe(true);
  });
});

describe('the transcript view with async questions (#157)', () => {
  let view: TranscriptView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
    document.body.replaceChildren();
  });

  const ask: Ask = {
    tool_use_id: 'toolu_1',
    source: 'transcript',
    agent: 'codex',
    since: Date.now(),
    questions: [{ header: '', question: 'Proceed?', multi: false, other: false, options: [{ label: 'Yes', description: '' }] }],
  };

  it('keeps the prompt box on beside the card, and gives way to a blocking ask', () => {
    const box = document.createElement('div');
    document.body.append(box);
    view = mountTranscript(box, { images: null, onPromptSubmit: () => {}, onAnswer: () => {}, onAnswerAsk: () => Promise.resolve({ ok: true, resolved: true }), onSwitchToTerminal: () => {}, loadSubagent: () => Promise.resolve([]) });
    view.setCodex(W, codex([batch('call_3', [color()])]));
    const tx = box.querySelector<HTMLElement>('.tx')!;
    expect(tx.querySelector<HTMLElement>('.tx-aq')?.hidden).toBe(false);
    expect(tx.hasAttribute('data-asyncq')).toBe(true);
    expect(tx.querySelector('.tx-send')?.hasAttribute('disabled')).toBe(false);
    expect(tx.querySelector('.tx-aq-live')?.getAttribute('aria-live')).toBe('polite');
    view.setAsk(ask);
    expect(tx.querySelector<HTMLElement>('.tx-aq')?.hidden).toBe(true);
    view.setAsk(null);
    expect(tx.querySelector<HTMLElement>('.tx-aq')?.hidden).toBe(false);
  });

  // An idle Codex worker can keep its last turn's async questions and have a follow-up too: one card open, the other
  // a tab away (a phone's screen has no room for two), the keys the open one's, and what you wrote on each kept.
  it('opens one of the follow-up’s card and the async questions’ at a time, with tabs to switch, and keeps both drafts', () => {
    const box = document.createElement('div');
    document.body.append(box);
    view = mountTranscript(box, { images: null, onPromptSubmit: () => {}, onAnswer: () => {}, onAnswerAsk: () => Promise.resolve({ ok: true, resolved: true }), onSwitchToTerminal: () => {}, loadSubagent: () => Promise.resolve([]) });
    const tx = box.querySelector<HTMLElement>('.tx')!;
    const tabs = tx.querySelector<HTMLElement>('.tx-qtabs')!;
    const tab = (k: string) => tx.querySelector<HTMLButtonElement>(`.tx-qtab[data-card="${k}"]`)!;
    const key = (target: Element, k: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const followup: Followup = {
      turn_id: 'turn-9',
      score: 0.96,
      source: 'model',
      at: Date.now(),
      questions: [
        { id: 'q1', question: 'Ship this release?', kind: 'yes_no' },
        { id: 'q2', question: 'Any release context?', kind: 'open' },
      ],
    };
    // The async questions alone: no tabs.
    view.setCodex(W, codex([batch('call_3', [context({ index: 0 })])], { turn: '' }));
    expect(tabs.hidden).toBe(true);
    expect(tx.dataset.front).toBeUndefined();
    tx.querySelector<HTMLTextAreaElement>('textarea.tx-aq-text')!.value = 'async draft';
    tx.querySelector<HTMLTextAreaElement>('textarea.tx-aq-text')!.dispatchEvent(new Event('input'));
    // A follow-up comes: the card you had stays open, the follow-up waits behind its tab.
    view.setFollowup(followup);
    expect(tabs.hidden).toBe(false);
    expect(tabs.getAttribute('role')).toBe('tablist');
    expect(tx.dataset.front).toBe('asyncq');
    expect(tab('asyncq').getAttribute('aria-selected')).toBe('true');
    expect(tab('asyncq').tabIndex).toBe(0);
    expect(tab('followup').getAttribute('aria-selected')).toBe('false');
    expect(tab('followup').tabIndex).toBe(-1);
    expect(tab('followup').getAttribute('aria-controls')).toBe(tx.querySelector('.tx-fu')!.id);
    expect(tab('followup').textContent).toBe('Open questions2');
    expect(tab('asyncq').textContent).toBe('Codex asked1');
    // The follow-up's tab: it opens, the keyboard on it; the timeline's digits are its own now.
    tab('followup').click();
    expect(tx.dataset.front).toBe('followup');
    expect(tx.querySelector('.tx-fu')!.contains(document.activeElement)).toBe(true);
    const scroll = tx.querySelector<HTMLElement>('.tx-scroll')!;
    scroll.focus();
    key(scroll, '2'); // No
    expect(tx.querySelector('.tx-fu .tx-ask-row .tx-ask-row-text')?.textContent).toBe('No');
    tx.querySelector<HTMLTextAreaElement>('.tx-fu textarea.tx-fu-text')!.value = 'follow-up draft';
    tx.querySelector<HTMLTextAreaElement>('.tx-fu textarea.tx-fu-text')!.dispatchEvent(new Event('input'));
    // ← → on the tabs switch, the keyboard stays there; both drafts are where they were.
    tab('followup').focus();
    key(tab('followup'), 'ArrowRight');
    expect(tx.dataset.front).toBe('asyncq');
    expect(document.activeElement).toBe(tab('asyncq'));
    expect(tx.querySelector<HTMLTextAreaElement>('textarea.tx-aq-text')?.value).toBe('async draft');
    key(tab('asyncq'), 'ArrowLeft');
    expect(tx.dataset.front).toBe('followup');
    expect(tx.querySelector<HTMLTextAreaElement>('.tx-fu textarea.tx-fu-text')?.value).toBe('follow-up draft');
    expect(tx.querySelector('.tx-fu .tx-ask-row .tx-ask-row-text')?.textContent).toBe('No');
    // The follow-up goes: the async card is the only one, no tabs.
    view.setFollowup(null);
    expect(tabs.hidden).toBe(true);
    expect(tx.dataset.front).toBeUndefined();
    expect(tx.querySelector<HTMLElement>('.tx-aq')?.hidden).toBe(false);
  });
});
