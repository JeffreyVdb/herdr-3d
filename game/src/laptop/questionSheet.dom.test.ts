// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ask, Followup, WorkerCodex } from '../net/protocol';
import type { AskResult } from './askCard';
import type { AsyncResult } from './asyncCard';
import type { FollowupResult } from './followupCard';
import { mountTranscript, type BlockedQuestion, type TranscriptView } from './transcriptRender';

// #187: the questions' sheet of a transcript view: the button in the prompt box, the lanes, what opens it (a mandatory
// question once, the button, Q) and what never does (an optional question, a hidden view), and the view's own room.

const ask = (id = 'tu-a'): Ask => ({
  tool_use_id: id,
  agent: 'claude',
  source: 'transcript',
  since: 1,
  questions: [{ question: 'Which color?', header: 'Color', multi: false, other: true, options: [{ label: 'Red' }, { label: 'Blue' }] }],
});
const followup = (): Followup => ({ turn_id: 't1', score: 0.9, source: 'model', at: 1, questions: [{ id: 'q1', question: 'Keep v1?', kind: 'yes_no' }] });

let view: TranscriptView | null = null;
let box: HTMLDivElement;
let terminal = 0;
let answer: () => Promise<AskResult> = async () => ({ ok: true, resolved: true });
let fuAnswer: () => Promise<FollowupResult> = async () => ({ ok: true });
let aqAnswer: () => Promise<AsyncResult> = async () => ({ ok: true });
/** The answers each card sent (the screen's question: its picks). */
let calls = { ask: 0, blocked: 0, followup: 0, asyncq: 0 };

beforeEach(() => {
  // jsdom has no modal dialogs: open / close are what the sheet looks at.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
  terminal = 0;
  answer = async () => ({ ok: true, resolved: true });
  fuAnswer = async () => ({ ok: true });
  aqAnswer = async () => ({ ok: true });
  calls = { ask: 0, blocked: 0, followup: 0, asyncq: 0 };
  box = document.createElement('div');
  document.body.append(box);
  view = mountTranscript(box, {
    images: null,
    onPromptSubmit: () => Promise.resolve(true),
    onAnswer: () => void calls.blocked++,
    onAnswerAsk: () => (calls.ask++, answer()),
    onAnswerFollowup: () => (calls.followup++, fuAnswer()),
    onAnswerAsync: () => (calls.asyncq++, aqAnswer()),
    onSwitchToTerminal: () => void terminal++,
    loadSubagent: async () => [],
  });
});
afterEach(() => {
  view?.destroy();
  view = null;
  document.body.replaceChildren();
});

const sheet = () => document.querySelector<HTMLDialogElement>('dialog.tx-qsheet');
const button = () => box.querySelector<HTMLButtonElement>('.tx-qbtn')!;
const key = (target: Element, k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
const name = () => sheet()!.getAttribute('aria-label') ?? sheet()!.querySelector('.sheet-title')?.textContent;

describe('the questions’ sheet (#187)', () => {
  it('the view keeps its whole height: the button is in the prompt box, no question sits between the timeline and it', () => {
    view!.setAsk(ask());
    view!.setFollowup(followup());
    sheet()!.querySelector<HTMLButtonElement>('.sheet-close')!.click();
    const tx = box.querySelector<HTMLElement>('.tx')!;
    const kids = [...tx.children].map((c) => c.className);
    const main = kids.indexOf('tx-main');
    expect(kids[main + 1]).toBe('tx-prompt');
    expect(tx.querySelector('.tx-ask, .tx-fu, .tx-aq, .tx-bq, .tx-banner')).toBeNull();
    expect(button().closest('.tx-prompt')).not.toBeNull();
    expect(button().getAttribute('aria-controls')).toBe(sheet()!.id);
    // Its live region is the view's (a closed dialog says nothing).
    expect(tx.querySelector('.tx-qbtn-live')?.getAttribute('aria-live')).toBe('polite');
  });

  it('an optional question never opens it; the button (calm) or Q does, not Q typed in a text field', () => {
    view!.setFollowup(followup());
    expect(sheet()?.open ?? false).toBe(false);
    expect([button().hidden, button().dataset.lane]).toEqual([false, 'optional']);
    const input = box.querySelector<HTMLElement>('.tx-input')!;
    input.focus();
    key(input, 'q', { code: 'KeyQ' });
    expect(sheet()?.open ?? false).toBe(false);
    const scroll = box.querySelector<HTMLElement>('.tx-scroll')!;
    expect(key(scroll, 'q', { code: 'KeyQ', shiftKey: true }).defaultPrevented).toBe(false);
    expect(key(scroll, 'q', { code: 'KeyQ' }).defaultPrevented).toBe(true);
    expect(sheet()?.open).toBe(true);
    expect(button().getAttribute('aria-expanded')).toBe('true');
    expect(name()).toBe('Open questions');
    // Nothing waits: Q is the page's again.
    view!.setFollowup(null);
    expect(sheet()?.open).toBe(false);
    expect(button().hidden).toBe(true);
    expect(key(scroll, 'q', { code: 'KeyQ' }).defaultPrevented).toBe(false);
  });

  it('names itself per lane, both lanes each under its name, urgent first', () => {
    view!.setAsk(ask());
    expect(name()).toBe('Answer to continue');
    view!.setFollowup(followup());
    expect(sheet()!.hasAttribute('data-lanes')).toBe(true);
    expect(name()).toBe('Answer to continue, and open questions');
    const heads = [...sheet()!.querySelectorAll('.tx-qlane')].map((l) => [l.getAttribute('data-lane'), l.querySelector('.tx-qlane-head')?.textContent]);
    expect(heads).toEqual([
      ['urgent', 'Answer to continue'],
      ['optional', 'Open questions'],
    ]);
  });

  it('a hidden view never opens it, and closes it; shown again, a mandatory question not opened for opens it', () => {
    const v = view as TranscriptView & { setVisible(on: boolean): void };
    v.setVisible(false);
    v.setAsk(ask());
    expect(sheet()?.open ?? false).toBe(false);
    v.setVisible(true);
    expect(sheet()?.open).toBe(true);
    v.setVisible(false);
    expect(sheet()?.open).toBe(false);
    expect(button().click()).toBeUndefined();
    expect(sheet()?.open).toBe(false); // not over the terminal
    v.setVisible(true);
    expect(sheet()?.open).toBe(false); // opened for already: the button keeps it
  });

  it('an ask answered while it is open closes it (the keyboard back on the timeline); Esc closes it without standing you up', async () => {
    const stood: KeyboardEvent[] = [];
    const up = (e: KeyboardEvent) => void stood.push(e);
    window.addEventListener('keydown', up);
    try {
      view!.setAsk(ask());
      key(document.activeElement!, 'Escape');
      expect(sheet()?.open).toBe(false);
      expect(stood).toHaveLength(0);
      button().click();
      key(document.activeElement!, '1'); // Red: the one question answered, Send next
      key(document.activeElement!, 'Enter', { ctrlKey: true });
      for (let i = 0; i < 6; i++) await Promise.resolve();
      expect(sheet()?.open).toBe(false);
      expect(document.activeElement?.classList.contains('tx-scroll')).toBe(true);
      expect(button().hidden).toBe(true);
      expect(stood).toHaveLength(0);
    } finally {
      window.removeEventListener('keydown', up);
    }
  });

  it('a refused answer keeps it open with the reason, the keyboard back on the card: Ctrl+Enter sends again (R2)', async () => {
    let done: (r: AskResult) => void = () => {};
    answer = () => new Promise((r) => (done = r));
    view!.setAsk(ask());
    key(document.activeElement!, '1');
    key(document.activeElement!, 'Enter', { ctrlKey: true });
    expect(sheet()?.open).toBe(true);
    expect(sheet()!.contains(document.activeElement)).toBe(true);
    done({ ok: false, code: 'refused', message: 'The worker is away.' });
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(sheet()?.open).toBe(true);
    expect(sheet()!.querySelector('.tx-ask-note.is-error')?.textContent).toBe('The worker is away.');
    expect(sheet()!.querySelector('.tx-ask')!.contains(document.activeElement)).toBe(true);
    key(document.activeElement!, 'Enter', { ctrlKey: true });
    expect(calls.ask).toBe(2);
  });

  it('keys on the sheet itself (its card’s controls off, a press on its padding) go to that card', async () => {
    answer = () => new Promise(() => {});
    view!.setAsk(ask());
    view!.setFollowup(followup());
    sheet()!.querySelector<HTMLElement>('.tx-fu .tx-ask-opt')!.focus();
    sheet()!.focus();
    key(sheet()!, '1');
    expect(sheet()!.querySelector('.tx-fu .tx-ask-opt[data-n="1"]')?.getAttribute('aria-checked')).toBe('true');
    expect(sheet()!.querySelector('.tx-ask .tx-ask-opt[aria-checked="true"]')).toBeNull();
    // Enter alone is no card's there (nor is Esc: the dialog's own cancel takes it).
    expect(key(sheet()!, 'Enter').defaultPrevented).toBe(false);
    expect(key(sheet()!, 'Escape').defaultPrevented).toBe(false);
  });

  it('goes with its view, open or not: nothing is left on the page', () => {
    view!.setAsk(ask());
    expect(document.querySelectorAll('dialog').length).toBe(1);
    view!.destroy();
    view = null;
    expect(document.querySelectorAll('dialog').length).toBe(0);
    expect(document.querySelector('.tx-ask, .tx-qbtn')).toBeNull();
  });
});

// #187 R1, R2: whatever changes the sheet's contents while it is open, the keyboard stays on a card's control (or, that
// card's controls off while its answer is on its way, on the sheet itself, whose keys go to that card): never on <body>,
// where a digit is lost and Esc stands you up. One row per change: the state the sheet is open on, the step, and where
// the keyboard is after it (the card that also takes its keys, the sheet, or the timeline once the sheet closed). Every
// row is checked with a digit, Ctrl+Enter and Esc pressed where the keyboard is.
describe('the questions’ sheet keeps the keyboard in a card whatever its contents become (#187)', () => {
  type Lane = 'ask' | 'blocked' | 'followup' | 'asyncq';
  type Where = Lane | 'sheet' | 'timeline';
  interface Row {
    name: string;
    given(v: TranscriptView): void;
    step(v: TranscriptView): void | Promise<void>;
    then: Where;
  }
  const CARD: Record<Lane, string> = { ask: '.tx-ask', blocked: '.tx-bq', followup: '.tx-fu', asyncq: '.tx-aq' };
  const LANES = Object.keys(CARD) as Lane[];
  const Q: BlockedQuestion = { kind: 'permission', text: 'Allow?', excerpt: [], choices: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }], hash: 'screen1' };
  const codex = (): WorkerCodex => ({
    mode: 'shared',
    server: 'running',
    attached: true,
    thread: 'th1',
    turn: 't1',
    questions: [{ batch: 'b1', turn: 't1', seen: ['live'], at: Date.now() - 5000, questions: [{ index: 0, title: 'Which fixture color?', state: 'pending', options: ['Green', 'Blue'] }] }],
  });
  const refused = { ok: false, code: 'refused', message: 'The worker is away.' } as const;
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const at = () => document.activeElement as HTMLElement;
  /** The keyboard on a card's option (the screen's question: its choice). */
  const on = (lane: Lane, n = 1) => document.querySelector<HTMLElement>(`${CARD[lane]} :is(.tx-ask-opt, .tx-choice)[data-n="${n}"]`)!.focus();
  /** The first option picked on the card, then Ctrl+Enter. */
  const send = (lane: Lane) => {
    on(lane);
    key(at(), '1');
    key(at(), 'Enter', { ctrlKey: true });
  };

  const rows: Row[] = [
    { name: 'the screen’s question → an ask (its card emptied under the keyboard)', given: (v) => v.setBlocked(Q), step: (v) => v.setAsk(ask()), then: 'ask' },
    { name: 'mounted the other way: an ask, then the screen’s question behind it', given: (v) => v.setAsk(ask()), step: (v) => v.setBlocked(Q), then: 'ask' },
    { name: 'an ask answered here while the screen’s question waits', given: (v) => (v.setBlocked(Q), v.setAsk(ask())), step: async () => (send('ask'), await settle()), then: 'blocked' },
    { name: 'an ask answered in the terminal while the screen’s question waits', given: (v) => (v.setBlocked(Q), v.setAsk(ask())), step: (v) => v.setAsk(null), then: 'blocked' },
    { name: 'the screen’s question redrawn without the choice the keyboard was on', given: (v) => (v.setBlocked(Q), on('blocked', 2)), step: (v) => v.setBlocked({ ...Q, choices: [{ n: 1, label: 'Yes' }] }), then: 'blocked' },
    { name: 'an ask answered with an optional card left (the urgent lane empties: it closes)', given: (v) => (v.setFollowup(followup()), v.setAsk(ask())), step: async () => (send('ask'), await settle()), then: 'timeline' },
    { name: 'an ask refused', given: (v) => v.setAsk(ask()), step: async () => ((answer = async () => refused), send('ask'), await settle()), then: 'ask' },
    { name: 'an ask on its way (its controls off)', given: (v) => v.setAsk(ask()), step: () => ((answer = () => new Promise(() => {})), send('ask')), then: 'sheet' },
    { name: 'a follow-up refused', given: (v) => (v.setFollowup(followup()), button().click()), step: async () => ((fuAnswer = async () => refused), send('followup'), await settle()), then: 'followup' },
    { name: 'a follow-up refused under an ask (back on the follow-up, not the ask)', given: (v) => (v.setAsk(ask()), v.setFollowup(followup())), step: async () => ((fuAnswer = async () => refused), send('followup'), await settle()), then: 'followup' },
    { name: 'Codex’s async answer refused', given: (v) => (v.setCodex('w1', codex(), true), button().click()), step: async () => ((aqAnswer = async () => refused), send('asyncq'), await settle()), then: 'asyncq' },
    { name: 'the last urgent question gone (it closes)', given: (v) => v.setAsk(ask()), step: (v) => v.setAsk(null), then: 'timeline' },
    { name: 'the screen’s question gone (it closes)', given: (v) => v.setBlocked(Q), step: (v) => v.setBlocked(null), then: 'timeline' },
    { name: 'an optional card cleared under the keyboard, another left', given: (v) => (v.setFollowup(followup()), v.setCodex('w1', codex(), true), button().click(), on('followup')), step: (v) => v.setFollowup(null), then: 'asyncq' },
    { name: 'an optional card cleared under the keyboard, an ask left', given: (v) => (v.setAsk(ask()), v.setFollowup(followup()), on('followup')), step: (v) => v.setFollowup(null), then: 'ask' },
    { name: 'a new ask while it is open on an optional card (the keyboard stays there)', given: (v) => (v.setFollowup(followup()), button().click()), step: (v) => v.setAsk(ask()), then: 'followup' },
    { name: 'a new ask id replacing the ask', given: (v) => v.setAsk(ask('tu-a')), step: (v) => v.setAsk(ask('tu-b')), then: 'ask' },
  ];

  const seen: string[] = [];
  const onWin = (e: KeyboardEvent) => void seen.push(e.key);
  beforeEach(() => {
    seen.length = 0;
    window.addEventListener('keydown', onWin);
  });
  afterEach(() => window.removeEventListener('keydown', onWin));

  /** What each card shows and sent: the cards a key changed. */
  const snap = () => LANES.map((l) => `${document.querySelector(CARD[l])?.innerHTML ?? ''}\u0000${calls[l]}`);
  const changed = (before: string[]) => {
    const after = snap();
    return LANES.filter((_, i) => before[i] !== after[i]);
  };
  /** Esc where the keyboard is; not taken by a card, it is the dialog's `cancel` (what a browser does, jsdom does not). */
  const esc = () => {
    const e = key(at(), 'Escape');
    if (!e.defaultPrevented && sheet()?.open) sheet()!.dispatchEvent(new Event('cancel', { cancelable: true }));
  };

  async function run(r: Row): Promise<void> {
    r.given(view!);
    expect(sheet()?.open).toBe(true);
    await r.step(view!);
    expect(at()).not.toBe(document.body);
    if (r.then === 'timeline') {
      expect(sheet()?.open).toBe(false);
      expect(at().classList.contains('tx-scroll')).toBe(true);
    } else {
      expect(sheet()?.open).toBe(true);
      if (r.then === 'sheet') expect(at()).toBe(sheet());
      else expect(document.querySelector(CARD[r.then])!.contains(at())).toBe(true);
    }
    expect(seen).toEqual([]);
  }

  it.each(rows)('$name', async (r) => run(r));

  const open = rows.filter((r) => r.then !== 'timeline');
  it.each(open)('a digit there: $name', async (r) => {
    await run(r);
    const before = snap();
    key(at(), '1');
    // The card the keyboard is on takes it; its controls off, nothing does (nothing is picked while it is sent).
    expect(changed(before)).toEqual(r.then === 'sheet' ? [] : [r.then]);
    expect(seen).toEqual([]);
  });

  it.each(open.filter((r) => r.then !== 'blocked'))('Ctrl+Enter there: $name', async (r) => {
    await run(r);
    answer = fuAnswer = aqAnswer = () => new Promise(() => {}) as never;
    const before = snap();
    key(at(), 'Enter', { ctrlKey: true });
    // That card sends (or says what it lacks); one on its way sends nothing more.
    expect(changed(before)).toEqual(r.then === 'sheet' ? [] : [r.then]);
    expect(seen).toEqual([]);
  });

  it.each(open)('Esc there closes the sheet only: $name', async (r) => {
    await run(r);
    esc();
    expect(sheet()?.open).toBe(false);
    expect(at()).not.toBe(document.body);
    expect(box.querySelector('.tx')!.contains(at())).toBe(true);
    expect(seen).toEqual([]);
  });
});
