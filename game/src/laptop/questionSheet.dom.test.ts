// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ask, Followup } from '../net/protocol';
import type { AskResult } from './askCard';
import { mountTranscript, type TranscriptView } from './transcriptRender';

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
  box = document.createElement('div');
  document.body.append(box);
  view = mountTranscript(box, {
    images: null,
    onPromptSubmit: () => Promise.resolve(true),
    onAnswer: () => {},
    onAnswerAsk: () => answer(),
    onAnswerFollowup: async () => ({ ok: true }),
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

  it('a refused answer keeps it open with the reason (the keyboard stays in it while it is sent)', async () => {
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
