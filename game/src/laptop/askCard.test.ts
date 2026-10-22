// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ask, CommandArgs } from '../net/protocol';
import { AskCard, type AskResult } from './askCard';
import { mountTranscript, type TranscriptView } from './transcriptRender';

// #57: the question card: an answer's ack changes only the ask it was sent for (upserts that come meanwhile are the
// worker's word), and its keys: Enter on an option picks it (never sends), the card moving on puts the keyboard on the
// next question (an Enter there picks nothing), only Send or Ctrl+Enter sends. #187: it is in the questions' sheet,
// which an ask opens by itself; Esc closes the sheet (the keyboard back on the timeline).

beforeEach(() => {
  // jsdom has no modal dialogs: open / close are what the sheet looks at, and close fires `close` as a browser does.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const ask = (id = 'a', question = 'Which color?'): Ask => ({
  tool_use_id: id,
  agent: 'claude',
  source: 'transcript',
  since: 1,
  questions: [
    { question, header: 'Color', multi: false, other: true, options: [{ label: 'Red' }, { label: 'Blue' }] },
    { question: 'Which extras?', header: 'Extras', multi: true, other: true, options: [{ label: 'Logs' }, { label: 'Metrics' }, { label: 'Traces' }] },
  ],
});

/** A host whose answers wait until the test settles them. */
function slowHost() {
  const pending: Array<{ args: CommandArgs['worker.answer_ask']; done: (r: AskResult) => void }> = [];
  let timeline = 0;
  const host = {
    answer: (args: CommandArgs['worker.answer_ask']) => new Promise<AskResult>((done) => pending.push({ args, done })),
    toTerminal: () => {},
    focusTimeline: () => timeline++,
    resized: () => {},
  };
  return { host, pending, timelines: () => timeline };
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};
const press = (c: AskCard, key: string, opts: KeyboardEventInit = {}) => c.key(new KeyboardEvent('keydown', { key, ...opts }));

describe('AskCard: an ack is about its own ask', () => {
  let card: AskCard | null = null;
  afterEach(() => {
    card?.destroy();
    card = null;
  });

  function sending(): { c: AskCard; pending: ReturnType<typeof slowHost>['pending'] } {
    const { host, pending } = slowHost();
    const c = new AskCard(host);
    card = c;
    document.body.append(c.el);
    c.set(ask('a'));
    press(c, '1');
    press(c, '1');
    expect(press(c, 'Enter')).toBe(false); // not the card's (a button's click): not sent
    expect(pending).toHaveLength(0);
    press(c, 'Enter', { ctrlKey: true });
    expect(pending).toHaveLength(1);
    expect(c.el.dataset.phase).toBe('sending');
    return { c, pending };
  }

  it('answered in the terminal while sending: it shows sending until the ack, then goes (a stale ack too)', async () => {
    const { c, pending } = sending();
    c.set(null);
    expect(c.shown).toBe(true);
    expect(c.el.dataset.phase).toBe('sending');
    pending[0]?.done({ ok: false, code: 'stale', message: 'answered' });
    await flush();
    expect(c.shown).toBe(false);
    expect(c.el.hidden).toBe(true);
  });

  it('another question while sending: it is shown at once, and the old ack (resolved or stale) leaves it', async () => {
    for (const r of [{ ok: true, resolved: true }, { ok: false, code: 'stale', message: 'another' }] as AskResult[]) {
      const { c, pending } = sending();
      c.set(ask('b', 'NEW QUESTION: which color?'));
      expect(c.toolUseId).toBe('b');
      expect(c.el.querySelector('.tx-ask-question')?.textContent).toBe('NEW QUESTION: which color?');
      expect(c.el.dataset.phase).toBe('pending');
      // Its picks start empty, and it waits for the old ack before it can be sent.
      expect(c.el.querySelector('.tx-ask-opt.is-on')).toBeNull();
      pending[0]?.done(r);
      await flush();
      expect(c.shown).toBe(true);
      expect(c.toolUseId).toBe('b');
      expect(c.el.dataset.phase).toBe('pending');
      if (!r.ok) expect(c.el.querySelector('.tx-ask-note')?.textContent).toContain('changed meanwhile');
      card?.destroy();
    }
  });

  it('resolved while its upsert without the ask is still on its way: gone, and the same ask again stays gone', async () => {
    const { c, pending } = sending();
    pending[0]?.done({ ok: true, resolved: true });
    await flush();
    expect(c.shown).toBe(false);
    c.set(ask('a'));
    expect(c.shown).toBe(false);
    c.set(null);
    c.set(ask('b'));
    expect(c.toolUseId).toBe('b');
  });

  it('stale for the ask it still shows: the card stays with the reason', async () => {
    const { c, pending } = sending();
    pending[0]?.done({ ok: false, code: 'stale', message: 'gone' });
    await flush();
    expect(c.toolUseId).toBe('a');
    expect(c.el.dataset.phase).toBe('pending');
    expect(c.el.querySelector('.tx-ask-note.is-error')?.textContent).toContain('answered or changed meanwhile');
  });

  it('dismissing: the same, a new question kept', async () => {
    const { host, pending } = slowHost();
    const c = new AskCard(host);
    card = c;
    document.body.append(c.el);
    c.set(ask('a'));
    c.el.querySelector<HTMLButtonElement>('.tx-ask-dismiss')?.click();
    expect(pending[0]?.args).toMatchObject({ tool_use_id: 'a', cancel: true });
    c.set(ask('b'));
    pending[0]?.done({ ok: true, resolved: true });
    await flush();
    expect(c.toolUseId).toBe('b');
  });
});

describe('the card in the transcript view: keys', () => {
  let view: TranscriptView | null = null;
  let el: HTMLElement | null = null;
  afterEach(() => {
    view?.destroy();
    el?.remove();
    view = null;
  });

  function mount(answer: (args: CommandArgs['worker.answer_ask']) => Promise<AskResult> = async () => ({ ok: true, resolved: true })) {
    el = document.createElement('div');
    document.body.append(el);
    const sent: Array<CommandArgs['worker.answer_ask']> = [];
    view = mountTranscript(el, {
      images: null,
      onPromptSubmit: async () => true,
      onAnswer: () => {},
      onAnswerAsk: (args) => {
        sent.push(args);
        return answer(args);
      },
      onSwitchToTerminal: () => {},
      loadSubagent: async () => [],
    });
    return { root: el, sent };
  }
  /** A keydown on whatever has the keyboard, as the browser sends it; true: nothing took it (the default action runs). */
  const key = (k: string, opts: KeyboardEventInit = {}) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));

  const open = () => document.querySelector('.tx-ask-q .tx-ask-chip')?.textContent;

  it('digits pick and move on; ← back to a question; all answered, Send has the keyboard; Ctrl+Enter sends', async () => {
    const { root, sent } = mount();
    view?.setAsk(ask('a'));
    view?.focus();
    key('1'); // Red, on to Extras: the question itself has the keyboard
    expect(open()).toBe('Extras');
    expect(document.activeElement?.classList.contains('tx-ask-q')).toBe(true);
    expect(document.querySelector('.tx-ask-row.is-done .tx-ask-row-text')?.textContent).toBe('Red');
    key('1'); // Logs (pick several: it stays)
    expect(open()).toBe('Extras');
    key('ArrowLeft'); // back to Color, its pick focused
    expect(open()).toBe('Color');
    expect(document.activeElement?.getAttribute('aria-checked')).toBe('true');
    key('2'); // Blue instead: every question answered, all folded, Send next
    expect(document.querySelector('.tx-ask-q')).toBeNull();
    expect(document.activeElement?.classList.contains('tx-ask-send')).toBe(true);
    expect(sent).toHaveLength(0);
    expect(key('Enter', { ctrlKey: true })).toBe(false);
    await flush();
    expect(sent).toEqual([{ id: '', tool_use_id: 'a', answers: [{ question: 0, choices: [2] }, { question: 1, choices: [1] }] }]);
    expect(document.querySelector('.tx-ask')?.hasAttribute('hidden')).toBe(true);
  });

  it('a click on the first question, then Enter: the next question has the keyboard, the Enter picks nothing and says how', async () => {
    const { root, sent } = mount();
    view?.setAsk(ask('a'));
    view?.focus();
    document.querySelector<HTMLButtonElement>('.tx-ask-opt[data-n="1"]')?.click(); // Red
    expect(open()).toBe('Extras');
    expect(document.activeElement?.classList.contains('tx-ask-q')).toBe(true);
    expect(key('Enter')).toBe(false); // the card's: no option is clicked
    await flush();
    expect(sent).toHaveLength(0);
    expect(document.querySelector('.tx-ask-opt.is-on')).toBeNull();
    expect(document.querySelector('.tx-ask-nudge.is-loud')?.textContent).toContain('Enter picks nothing here');
    expect(document.activeElement?.classList.contains('tx-ask-q')).toBe(true);
    // ↓ goes to its first option.
    key('ArrowDown');
    expect((document.activeElement as HTMLElement | null)?.dataset.n).toBe('1');
  });

  it('Enter on a focused option is its click (it picks), never a send; ↑ ↓ move through the options and the Other box', () => {
    const { root, sent } = mount();
    view?.setAsk(ask('a'));
    view?.focus();
    document.querySelector<HTMLElement>('.tx-ask-opt[data-n="1"]')?.focus();
    expect(key('Enter')).toBe(true); // left to the button
    expect(sent).toHaveLength(0);
    key('ArrowDown');
    expect((document.activeElement as HTMLElement | null)?.dataset.n).toBe('2');
    key('ArrowDown');
    expect(document.activeElement?.classList.contains('tx-ask-other-input')).toBe(true);
    key('ArrowUp');
    expect((document.activeElement as HTMLElement | null)?.dataset.n).toBe('2');
  });

  it('Other: Enter takes the text and moves on (nothing sent); an empty one stays', async () => {
    const { root, sent } = mount();
    view?.setAsk(ask('a'));
    view?.focus();
    key('3'); // Color's Other
    const input = document.activeElement as HTMLInputElement;
    expect(input.classList.contains('tx-ask-other-input')).toBe(true);
    key('Enter');
    expect(open()).toBe('Color');
    input.value = 'Teal';
    input.dispatchEvent(new Event('input'));
    key('Enter');
    await flush();
    expect(sent).toHaveLength(0);
    expect(open()).toBe('Extras');
    expect(document.querySelector('.tx-ask-row.is-done .tx-ask-row-text')?.textContent).toBe('Teal');
  });

  it('Send or Ctrl+Enter with a question unanswered: to it, nothing sent', () => {
    const { root, sent } = mount();
    view?.setAsk(ask('a'));
    view?.focus();
    key('ArrowRight'); // Extras
    key('2'); // Metrics
    key('Enter', { ctrlKey: true });
    expect(sent).toHaveLength(0);
    expect(open()).toBe('Color');
    expect(document.querySelector('.tx-ask-q.is-flash')).not.toBeNull();
    expect(document.querySelector('.tx-ask-note')?.textContent).toContain('Answer “Color” first');
    document.querySelector<HTMLButtonElement>('.tx-ask-send')?.click();
    expect(sent).toHaveLength(0);
  });

  it('Esc on an option or a folded question closes the sheet: the timeline has the keyboard, the seat is not left; Q opens it again', () => {
    mount();
    const stood: KeyboardEvent[] = [];
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) stood.push(e);
    };
    window.addEventListener('keydown', up);
    try {
      view?.setAsk(ask('a'));
      const sheet = document.querySelector('dialog.tx-qsheet') as HTMLDialogElement;
      expect(sheet.open).toBe(true);
      document.querySelector<HTMLElement>('.tx-ask-opt')?.focus();
      expect(key('Escape')).toBe(false);
      expect(sheet.open).toBe(false);
      expect(document.activeElement?.classList.contains('tx-scroll')).toBe(true);
      expect(key('q', { code: 'KeyQ' })).toBe(false);
      expect(sheet.open).toBe(true);
      document.querySelector<HTMLElement>('.tx-ask-row')?.focus();
      key('Escape');
      expect(sheet.open).toBe(false);
      expect(stood).toHaveLength(0);
      // From the timeline itself Esc is the seat's again.
      key('Escape');
      expect(stood).toHaveLength(1);
    } finally {
      window.removeEventListener('keydown', up);
    }
  });

  it('a stale ack for the old ask while a new one is up: its card stays, the prompt stays off', async () => {
    let done: (r: AskResult) => void = () => {};
    const { root } = mount(() => new Promise((r) => (done = r)));
    view?.setAsk(ask('a'));
    view?.focus();
    key('1');
    key('1');
    key('Enter', { ctrlKey: true });
    view?.setAsk(ask('b', 'NEW QUESTION: which color?'));
    done({ ok: false, code: 'stale', message: 'another question' });
    await flush();
    expect(document.querySelector('.tx-ask')?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('.tx-ask-question')?.textContent).toBe('NEW QUESTION: which color?');
    expect(root.querySelector<HTMLElement>('.tx-input')?.getAttribute('aria-disabled')).toBe('true');
  });
});
