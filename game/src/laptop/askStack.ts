import { h, icon } from '../ui/dom';

/**
 * The questions of a question card (the ask's #57, the follow-up's #90, #187: in the questions' sheet) stacked: the open one with its options, the
 * others folded to one line (its answer, or the question still to answer), so every question is in view and none
 * waits behind a tab. One meaning per key: Enter / Space on an option picks it, Enter in a text box takes the text
 * and moves on, and only Send (or Ctrl/⌘+Enter) sends. When the card moves on by itself the keyboard lands on the
 * next question, not on one of its options, so the Enter that follows a click picks nothing (the question says how
 * to pick instead). Shared by askCard.ts and followupCard.ts; each card owns its picks and its options.
 */

const CHECK = '<path d="M5.5 12.5l4 4 9-9"/>';

/** A question's (or an option's) mark: its number, or a tick once answered. */
export const mark = (n: number, done: boolean): Node => (done ? icon(CHECK) : document.createTextNode(String(n)));

/** The send shortcut as this keyboard says it. */
export const SEND_KEY = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform) ? '⌘↩' : 'Ctrl+Enter';

/** Ctrl/⌘+Enter: send from anywhere on the card. */
export const isSendKey = (e: KeyboardEvent): boolean => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && !e.isComposing;

/** #108 round 4: how a card's answer goes: `review` ("Review secrets", Ctrl/⌘+Shift+X), its texts reviewed on purpose. */
export interface AnswerOptions {
  review?: boolean;
}

/** #108 round 4: the "Review prompt secrets before sending" switch, for a card's "Review secrets" (absent: no such control). */
export interface CardSecrets {
  readonly on: boolean;
  onChange(fn: () => void): () => void;
}

/**
 * #108 round 4: a card's "Review secrets" (null with the switch off): the texts of its answer reviewed now, also when the
 * scan finds nothing (to mark a value it missed), then sent. Ctrl/⌘+Shift+X on the card does the same (`reviewKey`).
 */
export function reviewLink(secrets: CardSecrets | null | undefined, disabled: boolean, run: () => void): HTMLButtonElement | null {
  if (!secrets?.on) return null;
  return h(
    'button',
    { class: 'tx-link tx-card-review', 'data-key': 'review', disabled, title: 'Look over the answer’s possible secrets now, and mark one the scan missed (Ctrl/⌘+Shift+X)', onclick: run },
    'Review secrets',
  ) as HTMLButtonElement;
}

export interface StackLine {
  header: string;
  question: string;
  done: boolean;
  /** What is answered, as the agent will read it. */
  answer: string;
}

/** A folded question: its mark, header and answer (or question); a click opens it. */
export function foldedRow(i: number, l: StackLine, open: () => void, disabled: boolean): HTMLButtonElement {
  return h(
    'button',
    {
      class: `tx-ask-row${l.done ? ' is-done' : ''}`,
      'data-key': `row:${i}`,
      disabled,
      title: l.done ? `${l.question} → ${l.answer}` : l.question,
      onclick: open,
    },
    h('span', { class: `tx-ask-mark${l.done ? ' is-done' : ''}`, 'aria-hidden': 'true' }, mark(i + 1, l.done)),
    h('span', { class: 'tx-ask-row-head' }, l.header),
    h('span', { class: 'tx-ask-row-text' }, l.done ? l.answer : l.question),
    h('span', { class: 'tx-ask-row-act' }, l.done ? 'change' : 'answer'),
  );
}

export interface OpenQuestion {
  index: number;
  line: StackLine;
  /** Several questions: the mark and header lead it (one question: its header chip only, when it has one). */
  several: boolean;
  /** "pick several", for a multi-select question. */
  kind?: string | null;
  /** How many options a digit picks from (0: an open question, a text box only). */
  options: number;
  /** Enter landed on the question itself: the nudge says how to pick, louder. */
  nudged: boolean;
  /** Send was tried without this answer: it flashes once. */
  flash: boolean;
  /** The id its question text gets (the options' group is labelled by it). */
  qid: string;
}

/** The open question: focusable itself (the card lands here when it moves on), its head, its question, then `parts`. */
export function openQuestion(o: OpenQuestion, ...parts: Array<Node | null>): HTMLElement {
  const head = h('div', { class: 'tx-ask-q-head' });
  if (o.several) head.append(h('span', { class: `tx-ask-mark${o.line.done ? ' is-done' : ''}`, 'aria-hidden': 'true' }, mark(o.index + 1, o.line.done)));
  if (o.line.header) head.append(h('span', { class: 'tx-ask-chip' }, o.line.header));
  if (o.kind) head.append(h('span', { class: 'tx-ask-kind' }, o.kind));
  const nudge = o.options
    ? h('div', { class: `tx-ask-nudge${o.nudged ? ' is-loud' : ''}`, 'aria-live': 'polite' }, o.nudged ? `Enter picks nothing here: ↓ to an option, then Enter; or press 1–${o.options}` : `↓ or 1–${o.options} to pick`)
    : null;
  return h(
    'div',
    {
      class: `tx-ask-q${o.flash ? ' is-flash' : ''}`,
      'data-key': 'q',
      tabindex: '-1',
      role: 'group',
      'aria-labelledby': o.qid,
    },
    head.childNodes.length ? head : null,
    h('p', { class: 'tx-ask-question', id: o.qid }, o.line.question),
    nudge,
    ...parts,
  );
}

/** The open question's controls in order: its options, its text box, its Done. */
function controls(q: HTMLElement): HTMLElement[] {
  return [...q.querySelectorAll<HTMLElement>('button.tx-ask-opt, .tx-ask-other-input, .tx-ask-done')].filter((e) => !(e as HTMLButtonElement).disabled);
}

/** ↑ / ↓ on the open question or one of its controls: the control before / after (from the question: its first). */
export function moveIn(q: HTMLElement | null, from: Element, d: 1 | -1): boolean {
  if (!q) return false;
  const all = controls(q);
  const to = all[(from === q ? -1 : all.indexOf(from as HTMLElement)) + d];
  if (!to || (from !== q && !all.includes(from as HTMLElement))) return false;
  to.focus({ preventScroll: true });
  reveal(to);
  return true;
}

/** Puts the keyboard on the open question (one without options: its text box). */
export function focusQuestion(q: HTMLElement | null): void {
  if (!q) return;
  const target = q.querySelector('button.tx-ask-opt') ? q : (controls(q)[0] ?? q);
  target.focus({ preventScroll: true });
  reveal(target);
}

/** A question card: what a reveal looks for `el` in. */
const CARD = '.tx-ask, .tx-fu, .tx-aq';

/**
 * The box that scrolls `el` on its card: the card's body, or (#187) the questions' sheet's, the dialog it is in (never
 * past it: the page around it never moves).
 */
function scrollerOf(el: Element): HTMLElement | null {
  const card = el.closest<HTMLElement>(CARD);
  if (!card) return null;
  const stop = card.closest('dialog') ?? card;
  for (let e = el.parentElement; e; e = e.parentElement) {
    if (e.scrollHeight > e.clientHeight + 1 && /^(auto|scroll)$/.test(getComputedStyle(e).overflowY)) return e;
    if (e === stop) break;
  }
  return null;
}

/** Where a box shows what it scrolls: its inside, less what sticks over it (a sticky top line or foot). */
function bandOf(box: HTMLElement): { top: number; bottom: number } {
  const r = box.getBoundingClientRect();
  let top = r.top + box.clientTop;
  let bottom = top + box.clientHeight;
  for (const c of box.children) {
    const s = getComputedStyle(c);
    if (s.position !== 'sticky' || s.display === 'none') continue;
    const cr = c.getBoundingClientRect();
    if (s.top !== 'auto') top = Math.max(top, cr.bottom);
    else if (s.bottom !== 'auto') bottom = Math.min(bottom, cr.top);
  }
  return { top, bottom };
}

/** How far to scroll so `r` is inside `band` (its top first, when it is the taller). */
export function revealBy(band: { top: number; bottom: number }, r: { top: number; bottom: number }, pad = 4): number {
  if (r.top < band.top) return r.top - band.top - pad;
  if (r.bottom > band.bottom) return Math.min(r.bottom - band.bottom + pad, r.top - band.top - pad);
  return 0;
}

/**
 * Scrolls the card, or the sheet it is in (only them: the transcript and the page around never move) so `el` is in
 * view, clear of a sticky top line and foot: a focus with preventScroll leaves a question below the fold hidden.
 */
export function reveal(el: Element): void {
  const box = scrollerOf(el);
  if (!box) return;
  const d = revealBy(bandOf(box), el.getBoundingClientRect());
  if (d) box.scrollTop += d;
}
