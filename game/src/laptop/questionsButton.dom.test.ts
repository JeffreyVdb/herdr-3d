// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionsButton, type QuestionsState } from './questionsButton';

afterEach(() => void (document.body.innerHTML = ''));

const none: QuestionsState = { urgent: 0, followup: 0, asyncq: 0, open: false };
const state = (s: Partial<QuestionsState>): QuestionsState => ({ ...none, ...s });

function make(controls?: string) {
  const onOpen = vi.fn();
  const b = new QuestionsButton(controls === undefined ? { onOpen } : { onOpen, controls });
  document.body.append(b.el, b.live);
  return { b, onOpen };
}
const name = (b: QuestionsButton) => b.el.getAttribute('aria-label');
const shown = (b: QuestionsButton) => b.el.querySelector('.tx-qbtn-label')?.textContent;
const count = (b: QuestionsButton) => b.el.querySelector('.tx-qbtn-count')?.textContent;
const iconOf = (b: QuestionsButton) => b.el.querySelector('svg')?.dataset.icon;
/** The live region's words once its microtask has run (it is emptied first, so the same words are said again). */
async function said(b: QuestionsButton): Promise<string> {
  await Promise.resolve();
  return b.live.textContent ?? '';
}

describe('QuestionsButton (#187)', () => {
  it('is a hidden button with no questions, a polite status beside it', () => {
    const { b } = make();
    expect(b.el.tagName).toBe('BUTTON');
    expect(b.el.type).toBe('button');
    expect(b.el.hidden).toBe(true);
    b.set(none);
    expect(b.el.hidden).toBe(true);
    expect(b.live.getAttribute('role')).toBe('status');
    expect(b.live.getAttribute('aria-live')).toBe('polite');
  });

  it('urgent: "Answer to continue" with the count, its own lane, icon and name', () => {
    const { b } = make();
    b.set(state({ urgent: 2 }));
    expect(b.el.hidden).toBe(false);
    expect(b.el.dataset.lane).toBe('urgent');
    expect(shown(b)).toBe('Answer to continue');
    expect(count(b)).toBe('2');
    expect(iconOf(b)).toBe('stop');
    expect(name(b)).toBe('Answer to continue: 2 questions');
    b.set(state({ urgent: 1 }));
    expect(name(b)).toBe('Answer to continue: 1 question');
  });

  it('optional: each lane its label, both together one short label, a different icon from urgent', () => {
    const { b } = make();
    b.set(state({ followup: 3 }));
    expect(b.el.dataset.lane).toBe('optional');
    expect([shown(b), count(b), name(b)]).toEqual(['Open questions', '3', 'Open questions: 3']);
    expect(iconOf(b)).toBe('bubble');
    b.set(state({ asyncq: 1 }));
    expect([shown(b), count(b), name(b)]).toEqual(['Codex asked', '1', 'Codex asked 1 question']);
    expect(iconOf(b)).toBe('bubble');
    b.set(state({ followup: 3, asyncq: 1 }));
    expect([shown(b), count(b), name(b)]).toEqual(['Questions', '4', 'Questions: 3 open, 1 from Codex']);
  });

  it('urgent wins over the optional lanes, and its name says they wait too', () => {
    const { b } = make();
    b.set(state({ urgent: 1, followup: 2, asyncq: 1 }));
    expect(b.el.dataset.lane).toBe('urgent');
    expect(shown(b)).toBe('Answer to continue');
    expect(count(b)).toBe('1');
    expect(iconOf(b)).toBe('stop');
    expect(name(b)).toBe('Answer to continue: 1 question (3 optional questions wait too)');
  });

  it('aria-expanded follows open, aria-controls names the sheet, a click opens it', () => {
    const { b, onOpen } = make('sheet-7');
    expect(b.el.getAttribute('aria-controls')).toBe('sheet-7');
    b.set(state({ urgent: 1 }));
    expect(b.el.getAttribute('aria-expanded')).toBe('false');
    b.set(state({ urgent: 1, open: true }));
    expect(b.el.getAttribute('aria-expanded')).toBe('true');
    b.el.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(make().b.el.hasAttribute('aria-controls')).toBe(false);
  });

  it('the live region speaks when the button appears and when the lane changes, not on a count change', async () => {
    const { b } = make();
    b.set(state({ followup: 3 }));
    expect(await said(b)).toBe('Open questions: 3');
    b.live.textContent = '';
    b.set(state({ followup: 4 }));
    b.set(state({ followup: 4, asyncq: 1 }));
    b.set(state({ followup: 4, asyncq: 1, open: true }));
    expect(await said(b)).toBe('');
    b.set(state({ urgent: 2, followup: 4 }));
    expect(await said(b)).toBe('The agent is waiting for your answer: 2 questions');
    b.live.textContent = '';
    b.set(state({ urgent: 1, followup: 4 }));
    expect(await said(b)).toBe('');
    b.set(state({ followup: 4 }));
    expect(await said(b)).toBe('Open questions: 4');
    b.live.textContent = '';
    // Gone: nothing said; back: said again.
    b.set(none);
    expect(b.el.hidden).toBe(true);
    expect(await said(b)).toBe('');
    b.set(state({ asyncq: 1 }));
    expect(await said(b)).toBe('Codex asked 1 question');
  });

  it('destroy removes the button and its live region', () => {
    const { b } = make();
    b.set(state({ urgent: 1 }));
    b.destroy();
    expect(b.el.isConnected).toBe(false);
    expect(b.live.isConnected).toBe(false);
  });
});
