import './secretsReview.css';
import { keyName, pressesBinding } from '../input/shortcuts';
import { kindsText, type Mark, type PromptSecretsBook, type ReviewCounts, type SecretReview } from '../world/promptSecrets';
import { backdropPolicy } from './dismiss';
import { h, icon, ICON, replaceKeepingFocus } from './dom';

/** What the review shows and changes. */
export interface SecretsReviewRequest {
  /** The decisions on the scan of the exact text that will be sent (`SecretReview`): the dialog changes it in place. */
  review: SecretReview;
  /** Whom the prompt goes to (the title). */
  target: string;
  /** Why it shows again (the bridge refused the last Confirm), above the prompt. */
  notice: string | null;
  /** Opened on purpose (the prompt box's "Review secrets"): with nothing found, it says to select text. */
  manual: boolean;
  /** The final action's words: "Confirm and send" (round 4: "Confirm and continue" before an AI step). */
  action: string;
}

export type SecretsReviewOutcome = { kind: 'confirm'; review: SecretReview } | { kind: 'cancel' } | { kind: 'changed'; message: string };

/** What the review shows (test hook, via `window.__h3d.dialog()`): never the prompt's text, only where its marks are. */
export interface SecretsReviewSummary {
  kind: 'secrets-review';
  /** Open: the decisions are being made (the other dialogs' summaries have a `state` too). */
  state: 'reviewing';
  target: string;
  /** The text's length in UTF-16 code units. */
  length: number;
  marks: Array<{ key: string; candidate: string | null; start: number; end: number; state: Mark['state']; encoded: boolean }>;
  /** The match the strip is about (null: none). */
  current: string | null;
  counts: ReviewCounts;
  notice: string | null;
  manual: boolean;
  status: string;
  error: boolean;
}

const CHANGED = 'Review prompt secrets was switched off while you reviewed: nothing was sent. Send it again to send it as written.';

/** The header's plate: a padlock on a folder, the file the value goes to. */
const LOCKED_FILE = '<path d="M3.5 18V6.5a1.5 1.5 0 0 1 1.5-1.5h4l1.8 2H17a1.5 1.5 0 0 1 1.5 1.5V10"/><path d="M3.5 18.5h8"/><rect x="13" y="13.5" width="8" height="6.5" rx="1.2"/><path d="M15 13.5v-1.8a2 2 0 0 1 4 0v1.8"/>';
const RIGHT = '<path d="M9.5 6 15.5 12l-6 6"/>';
const LEFT = ICON.back;

/** A key on a match or in the prompt that is the review's, not the browser's. */
const plainKey = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;

/**
 * #108 round 3: the review of a prompt's possible secrets before it is sent (issue #108 "Required confirmation and
 * review flow", steps 2–5). The **whole** prompt, exactly as it will be sent (monospace, white space, line ends,
 * tabs and Unicode as they are), scrolls in a well; each candidate is a focusable highlight at its exact boundaries
 * with its state printed on label-maker tape ("Protected" on the warning tape, solid edge; "Ignored" on grey, dashed
 * edge: text and shape, never colour alone). The strip under the well is about the current match: previous and next
 * (N, Shift+N), Protect as file / Ignore this occurrence (Space or Enter on it), its start and end a character at a
 * time (← → the end, Shift+← → the start), and "Mark the selection as secret" (M) for text the scan missed, which
 * Delete takes away again. Counts beside Confirm say what goes to files and what stays plain text. Confirm sends
 * (ignoring the last match never does); Cancel and Esc send nothing. On a short screen (a laptop at 200% zoom) the
 * body scrolls under the header and the footer, so every control is reached by scrolling it.
 *
 * The prompt is a `contenteditable` that refuses every edit (`beforeinput`, paste, drop, cut, a composition put
 * back): it is there for the caret, so the keyboard selects text with Shift+arrows like anywhere else, and a touch
 * selects it with the platform's handles (`inputmode="none"`: no on-screen keyboard). A selection maps back to UTF-16
 * offsets through its text nodes, the tags left out. The switch changing meanwhile closes it: nothing is sent.
 * One dialog serves every composer (`secretsFlow.ts`); nothing of the prompt is kept once it closes.
 */
export class SecretsReviewDialog {
  private readonly dialog = h('dialog', { class: 'desk-dlg desk-dlg--secrets', 'aria-labelledby': 'sr-title', 'aria-describedby': 'sr-sum' });
  private readonly titleEl = h('h2', { id: 'sr-title' }, 'Review prompt secrets');
  private readonly subEl = h('p', { id: 'sr-sub' });
  private readonly noticeEl = h('div', { class: 'dd-callout sr-notice', role: 'alert' });
  private readonly sum = h('p', { class: 'sr-sum', id: 'sr-sum' });
  private readonly prompt = h('div', {
    class: 'sr-prompt',
    'data-key': 'prompt',
    role: 'textbox',
    'aria-readonly': 'true',
    'aria-multiline': 'true',
    'aria-label': 'Your prompt, as it will be sent',
    'aria-describedby': 'sr-keys',
    contenteditable: 'true',
    inputmode: 'none',
    spellcheck: 'false',
    autocapitalize: 'off',
    tabindex: '0',
  });
  private readonly strip = h('div', { class: 'sr-strip', role: 'group', 'aria-label': 'The current match' });
  private readonly keysEl = h('p', { class: 'field-hint sr-keys', id: 'sr-keys' });
  private readonly statusEl = h('p', { class: 'dd-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private readonly actions = h('div', { class: 'dd-actions' });
  private req: SecretsReviewRequest | null = null;
  private settle: ((o: SecretsReviewOutcome) => void) | null = null;
  /** The match the strip is about. */
  private current: string | null = null;
  /** The last text selected in the prompt (offsets), kept while a tap on the strip takes the selection away. */
  private picked: { start: number; end: number } | null = null;
  /** Each prompt text node's offset in the text (the tags have none). */
  private offsets = new WeakMap<Text, number>();
  private offBook: (() => void) | null = null;
  private opener: HTMLElement | null = null;
  private statusText = '';
  private statusError = false;
  /** The mark whose tape was just reprinted (its state changed): it gets the stamp once. */
  private stamped: string | null = null;

  constructor(
    parent: HTMLElement,
    private readonly host: { book: PromptSecretsBook },
  ) {
    this.alertEl.hidden = this.statusEl.hidden = this.noticeEl.hidden = true;
    const head = h(
      'header',
      { class: 'dd-head' },
      h('div', { class: 'dd-plate dd-plate--lock', 'aria-hidden': 'true' }, icon(LOCKED_FILE)),
      h('div', { class: 'dd-titles' }, this.titleEl, this.subEl),
      h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Cancel: nothing is sent', title: 'Cancel (Esc): nothing is sent', onclick: () => this.finish({ kind: 'cancel' }) }, icon(ICON.close)),
    );
    // The counts sit in the footer beside Confirm (what it sends), so a short screen that scrolls the body keeps them in view.
    const body = h('div', { class: 'dd-body sr-body' }, this.noticeEl, this.prompt, this.strip, this.keysEl);
    this.dialog.append(head, body, h('footer', { class: 'dd-foot' }, this.statusEl, this.alertEl, this.sum, this.actions));
    this.keysEl.append(h('kbd', {}, 'N'), ' next match · ', h('kbd', {}, 'Space'), ' protect or ignore it · ', h('kbd', {}, '←'), h('kbd', {}, '→'), ' its end, with ', h('kbd', {}, 'Shift'), ' its start · select text, then ', h('kbd', {}, 'M'), ' marks it');
    this.wirePrompt();
    this.dialog.addEventListener('keydown', (e) => this.onKey(e));
    // Esc (and any close the platform asks for) is Cancel: nothing is sent. A close event that comes late, after the
    // review opened again, is not this one's.
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.finish({ kind: 'cancel' });
    });
    this.dialog.addEventListener('close', () => {
      if (this.settle && !this.dialog.open) this.finish({ kind: 'cancel' });
    });
    // #51: what you decide in here is never thrown away by a click beside it.
    backdropPolicy(this.dialog, 'none');
    parent.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  /** Shows `req` (a review still open is cancelled first) and resolves how it ended. */
  open(req: SecretsReviewRequest): Promise<SecretsReviewOutcome> {
    if (this.settle) this.finish({ kind: 'cancel' });
    const done = new Promise<SecretsReviewOutcome>((resolve) => (this.settle = resolve));
    this.req = req;
    this.picked = null;
    this.stamped = null;
    this.current = req.review.marks()[0]?.key ?? null;
    this.setStatus('');
    const was = this.host.book.on;
    this.offBook = this.host.book.onChange(() => {
      // A change of the switch makes every review made before it stale: nothing is sent, the draft stays.
      if (this.host.book.on !== was) this.finish({ kind: 'changed', message: CHANGED });
    });
    const a = document.activeElement;
    this.opener = a instanceof HTMLElement && a !== document.body ? a : null;
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.prompt.scrollTop = 0;
    const first = this.markEl(this.current);
    if (first) this.focusMark(first, true);
    else this.prompt.focus();
    return done;
  }

  /** Cancel: nothing is sent. */
  close(): void {
    if (this.settle) this.finish({ kind: 'cancel' });
  }

  private finish(o: SecretsReviewOutcome): void {
    const settle = this.settle;
    this.settle = null;
    this.offBook?.();
    this.offBook = null;
    // Nothing of the prompt stays in the page once the review is over.
    this.req = null;
    this.picked = null;
    this.prompt.replaceChildren();
    this.offsets = new WeakMap();
    if (this.dialog.open) this.dialog.close();
    const back = this.opener;
    this.opener = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
    settle?.(o);
  }

  // ---- the prompt ----------------------------------------------------------------------------------------------

  private wirePrompt(): void {
    const p = this.prompt;
    // Read-only: it is there for the caret and the selection. Every edit is refused; a composition the platform does
    // not let us refuse is put back as soon as it ends.
    p.addEventListener('beforeinput', (e) => e.preventDefault());
    for (const t of ['paste', 'drop', 'cut', 'dragstart'] as const) p.addEventListener(t, (e) => e.preventDefault());
    p.addEventListener('input', () => this.renderPrompt());
    p.addEventListener('compositionend', () => this.renderPrompt());
    document.addEventListener('selectionchange', () => {
      if (!this.req) return;
      const s = document.getSelection();
      if (!s || !s.rangeCount || !p.contains(s.anchorNode)) return;
      // A caret placed in the prompt forgets the last selection; one elsewhere (a tap on the strip) keeps it.
      this.picked = this.readSelection();
      this.renderMarkButton();
    });
    p.addEventListener('click', (e) => {
      const m = (e.target as Element | null)?.closest<HTMLElement>('.sr-mark');
      if (m?.dataset.key) this.select(m.dataset.key, false);
    });
  }

  private text(s: string, at: number): Text {
    const t = document.createTextNode(s);
    this.offsets.set(t, at);
    return t;
  }

  /** The prompt again from the review: text runs and highlights, each text node's offset recorded. */
  private renderPrompt(): void {
    const r = this.req?.review;
    if (!r) return;
    const text = r.text;
    const marks = r.marks();
    this.offsets = new WeakMap();
    const nodes: Node[] = [];
    let at = 0;
    // Counted as the strip counts them: the matches the scan found (#108 A1); a mark of yours has no number.
    const found = r.counts().found;
    let n = 0;
    for (const m of marks) {
      if (m.start > at) nodes.push(this.text(text.slice(at, m.start), at));
      nodes.push(this.markNode(m, m.candidate ? ++n : 0, found));
      at = m.end;
    }
    if (at < text.length) nodes.push(this.text(text.slice(at), at));
    const a = document.activeElement;
    const focused = a instanceof HTMLElement && a.classList.contains('sr-mark') && this.prompt.contains(a) ? a.dataset.key : undefined;
    const top = this.prompt.scrollTop;
    this.prompt.replaceChildren(...nodes);
    this.prompt.scrollTop = top;
    if (focused) this.markEl(focused)?.focus({ preventScroll: true });
  }

  /** `nth` of `found`: the match's place among the scan's (0 for a mark of yours). */
  private markNode(m: Readonly<Mark>, nth: number, found: number): HTMLElement {
    const text = (this.req as SecretsReviewRequest).review.text;
    const word = m.state === 'protect' ? 'Protected' : 'Ignored';
    const value = this.text(text.slice(m.start, m.end), m.start);
    // An encoded value goes to its file with its escapes as typed: its tape says so (the strip says what that means).
    const tape = m.state === 'protect' && m.encoded ? 'Protected as typed' : word;
    const el = h(
      'span',
      {
        class: 'sr-mark',
        'data-key': m.key,
        'data-state': m.state,
        'data-manual': m.candidate ? null : 'true',
        'data-current': m.key === this.current ? 'true' : null,
        'data-stamp': m.key === this.stamped ? 'true' : null,
        contenteditable: 'false',
        role: 'button',
        tabindex: m.key === this.current ? '0' : '-1',
        'aria-roledescription': 'possible secret',
        'aria-describedby': 'sr-what',
        title: `${m.candidate ? `Match ${nth} of ${found}` : 'Marked by you'}: ${word.toLowerCase()}${m.encoded ? ', stored as typed' : ''}`,
      },
      h('span', { class: 'sr-tag' }, tape),
      h('span', { class: 'sr-val' }, value),
    );
    el.addEventListener('keydown', (e) => this.onMarkKey(e, m.key));
    return el;
  }

  private markEl(key: string | null): HTMLElement | null {
    return key ? this.prompt.querySelector<HTMLElement>(`.sr-mark[data-key="${CSS.escape(key)}"]`) : null;
  }

  private focusMark(el: HTMLElement, scroll: boolean): void {
    el.focus({ preventScroll: true });
    if (scroll) el.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  /**
   * The offset in the text of a DOM position in the prompt: in a prompt text node, its own offset plus the position;
   * anywhere else (between nodes, in a tag), the start of the first prompt text after it (the end of the text, none).
   */
  offsetOf(node: Node, offset: number): number {
    const len = this.req?.review.text.length ?? 0;
    if (node instanceof Text) {
      const at = this.offsets.get(node);
      if (at !== undefined) return at + Math.min(offset, node.data.length);
    }
    const pos = document.createRange();
    pos.setStart(node, offset);
    const walk = document.createTreeWalker(this.prompt, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      const at = this.offsets.get(t as Text);
      if (at === undefined) continue;
      if (pos.comparePoint(t, 0) >= 0) return at;
    }
    return len;
  }

  /** The text selected in the prompt, as offsets (null: none, or a caret). */
  private readSelection(): { start: number; end: number } | null {
    const s = document.getSelection();
    if (!s || !s.rangeCount || s.isCollapsed) return null;
    const r = s.getRangeAt(0);
    if (!this.prompt.contains(r.startContainer) || !this.prompt.contains(r.endContainer)) return null;
    const start = this.offsetOf(r.startContainer, r.startOffset);
    const end = this.offsetOf(r.endContainer, r.endOffset);
    return start < end ? { start, end } : null;
  }

  // ---- keys and actions ----------------------------------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    if (!this.req || e.defaultPrevented) return;
    if (pressesBinding(e, 'dialog.submit')) {
      e.preventDefault();
      this.confirm();
      return;
    }
    if (!plainKey(e) || e.repeat) return;
    if (e.code === 'KeyN') {
      e.preventDefault();
      this.step(e.shiftKey ? -1 : 1);
    } else if (e.code === 'KeyM' && !e.shiftKey) {
      e.preventDefault();
      this.markSelection();
    } else if (e.target === this.prompt && (e.key === 'Enter' || e.key === ' ')) {
      // Nothing to type in here (beforeinput refuses it anyway); Space must not scroll the dialog away either.
      e.preventDefault();
    }
  }

  private onMarkKey(e: KeyboardEvent, key: string): void {
    if (!plainKey(e)) return;
    const r = this.req?.review;
    const m = r?.get(key);
    if (!r || !m) return;
    // N and M are the dialog's (below); these are the highlight's own.
    if (e.key === 'Enter' || e.key === ' ') {
      if (!e.repeat) this.toggle(key);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      this.nudge(key, e.shiftKey ? 'start' : 'end', e.key === 'ArrowLeft' ? -1 : 1);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !e.shiftKey) {
      if (m.candidate) this.setStatus('A match the scan found stays: ignore it instead (Space).');
      else this.unmark(key);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** Makes `key` the current match: the strip follows, the highlight takes the focus (and comes into view). */
  private select(key: string, scroll: boolean): void {
    this.current = key;
    for (const el of this.prompt.querySelectorAll<HTMLElement>('.sr-mark')) {
      const on = el.dataset.key === key;
      el.tabIndex = on ? 0 : -1;
      if (on) el.setAttribute('data-current', 'true');
      else el.removeAttribute('data-current');
    }
    this.renderStrip();
    const el = this.markEl(key);
    if (el && document.activeElement !== el) this.focusMark(el, scroll);
    else if (el && scroll) el.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  /** The next (1) or previous (-1) match, round the end. */
  private step(dir: 1 | -1): void {
    const marks = this.req?.review.marks() ?? [];
    if (!marks.length) {
      this.setStatus('No matches: select text in the prompt and press M to mark it.');
      return;
    }
    const i = marks.findIndex((m) => m.key === this.current);
    const next = marks[(i < 0 ? (dir > 0 ? 0 : marks.length - 1) : (i + dir + marks.length) % marks.length)] as Readonly<Mark>;
    this.select(next.key, true);
  }

  private toggle(key: string): void {
    const r = this.req?.review;
    const m = r?.get(key);
    if (!r || !m) return;
    if (!m.candidate) {
      this.setStatus('A mark you made: Delete takes it away.');
      return;
    }
    this.setState(key, m.state === 'protect' ? 'ignore' : 'protect');
  }

  private setState(key: string, state: Mark['state']): void {
    const r = this.req?.review;
    if (!r) return;
    // Space, Enter and the strip's button all come here: the same refusal, said the same way (#108 C1).
    const blocker = state === 'ignore' ? r.ignoreBlocker(key) : null;
    if (blocker) {
      this.setStatus(ignoreRefusal(r, blocker), true);
      return;
    }
    if (!r.setState(key, state)) return;
    this.stamped = key;
    this.current = key;
    this.render();
    const c = r.counts();
    this.setStatus(`${state === 'protect' ? 'Protected: it goes to a file' : 'Ignored: it is sent as typed'}. ${countsLine(c)}`);
  }

  private nudge(key: string, edge: 'start' | 'end', dir: 1 | -1): void {
    const r = this.req?.review;
    const m = r?.get(key);
    if (!r || !m) return;
    if (!r.nudge(key, edge, dir)) {
      this.setStatus(nudgeRefusal(r, m, edge, dir), true);
      return;
    }
    this.current = key;
    this.render();
    const now = r.get(key) as Readonly<Mark>;
    const n = [...r.text.slice(now.start, now.end)].length;
    this.setStatus(`${edge === 'start' ? 'Starts' : 'Ends'} one character ${dir < 0 ? 'earlier' : 'later'}: ${n} ${n === 1 ? 'character' : 'characters'} now.`);
  }

  private markSelection(): void {
    const r = this.req?.review;
    if (!r) return;
    const sel = this.readSelection() ?? this.picked;
    if (!sel) {
      this.setStatus('Select some text in the prompt first, then mark it.', true);
      return;
    }
    const out = r.mark(sel.start, sel.end);
    if (!out.ok) {
      this.setStatus(out.reason, true);
      return;
    }
    this.picked = null;
    document.getSelection()?.removeAllRanges();
    this.current = out.key;
    this.stamped = out.key;
    this.render();
    const el = this.markEl(out.key);
    if (el) this.focusMark(el, false);
    this.setStatus(`Marked: it goes to a file. ${countsLine(r.counts())}`);
  }

  private unmark(key: string): void {
    const r = this.req?.review;
    if (!r) return;
    const marks = r.marks();
    const i = marks.findIndex((m) => m.key === key);
    if (!r.unmark(key)) return;
    const left = r.marks();
    this.current = (left[Math.min(i, left.length - 1)] ?? null)?.key ?? null;
    this.render();
    const el = this.markEl(this.current);
    if (el) this.focusMark(el, false);
    else this.prompt.focus();
    this.setStatus(`Mark taken away: that text is sent as typed. ${countsLine(r.counts())}`);
  }

  private confirm(): void {
    const r = this.req?.review;
    if (r) this.finish({ kind: 'confirm', review: r });
  }

  // ---- drawing -------------------------------------------------------------------------------------------------

  private setStatus(msg: string, error = false): void {
    this.statusText = msg;
    this.statusError = error;
    this.alertEl.hidden = !error || !msg;
    this.statusEl.hidden = error || !msg;
    (error ? this.alertEl : this.statusEl).textContent = msg;
    (error ? this.statusEl : this.alertEl).textContent = '';
  }

  private render(): void {
    const req = this.req;
    if (!req) return;
    const c = req.review.counts();
    this.titleEl.textContent = 'Review prompt secrets';
    this.subEl.textContent = `To ${req.target} · ${c.found ? `${c.found} possible ${c.found === 1 ? 'secret' : 'secrets'} found` : 'nothing found'}`;
    this.noticeEl.hidden = !req.notice;
    this.noticeEl.replaceChildren(h('p', {}, req.notice ?? ''));
    this.sum.replaceChildren(
      ...(c.protect || c.ignore
        ? [h('b', {}, `${c.protect} protected`), ` as ${c.protect === 1 ? 'a file' : 'files'} on the bridge host${c.manual ? ` (${c.manual} marked by you)` : ''}, `, h('b', {}, `${c.ignore} ignored`), '. Ignored matches are sent as plain text.']
        : [req.manual || !c.found ? 'Nothing was found. Select text in the prompt and mark it to send it as a file instead.' : '']),
    );
    this.renderPrompt();
    this.renderStrip();
    const had = document.activeElement instanceof HTMLElement && this.actions.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    this.actions.replaceChildren(
      h('button', { class: 'btn', 'data-key': 'cancel', onclick: () => this.finish({ kind: 'cancel' }) }, 'Cancel'),
      h('button', { class: 'btn btn--primary', 'data-key': 'confirm', title: `${req.action} (${keyName('dialog.submit')})`, onclick: () => this.confirm() }, req.action),
    );
    if (had) this.actions.querySelector<HTMLElement>(`[data-key="${had}"]`)?.focus();
    // The stamp is for the one change it shows.
    this.stamped = null;
  }

  private renderStrip(): void {
    const r = this.req?.review;
    if (!r) return;
    const marks = r.marks();
    const i = marks.findIndex((m) => m.key === this.current);
    const m = marks[i];
    // `refused`: unavailable, and why (its title); a press still goes to `on`, which says so (a touch has no hover).
    const btn = (key: string, label: string, title: string, on: () => void, opts: { icon?: string; pressed?: boolean; disabled?: boolean; refused?: string | null; cls?: string } = {}) =>
      h(
        'button',
        {
          class: `btn sr-btn${opts.cls ? ` ${opts.cls}` : ''}${opts.icon && !label ? ' btn--icon' : ''}`,
          'data-key': key,
          title: opts.refused ?? title,
          'aria-label': label ? null : title,
          'aria-pressed': opts.pressed === undefined ? null : String(opts.pressed),
          'aria-disabled': opts.disabled || opts.refused ? 'true' : null,
          onclick: () => {
            if (!opts.disabled) on();
          },
        },
        opts.icon ? icon(opts.icon) : null,
        label || null,
      );
    const nav = h(
      'div',
      { class: 'sr-nav' },
      btn('prev', '', 'Previous match (Shift+N)', () => this.step(-1), { icon: LEFT, disabled: !marks.length }),
      h('span', { class: 'sr-pos' }, m ? (m.candidate ? `Match ${marks.filter((x) => x.candidate).indexOf(m) + 1} of ${r.counts().found}` : 'Your mark') : marks.length ? `${marks.length} ${marks.length === 1 ? 'match' : 'matches'}` : 'No matches'),
      btn('next', '', 'Next match (N)', () => this.step(1), { icon: RIGHT, disabled: !marks.length }),
    );
    const what = h('p', { class: 'sr-what', id: 'sr-what' });
    const parts: Node[] = [nav, what];
    if (m) {
      what.append(m.candidate ? `Found by ${kindsText(m.kinds)}.` : 'Marked by you.');
      if (m.encoded) what.append(' ', h('b', {}, 'Stored as typed:'), ' its escapes, percent-encoding or indentation go into the file exactly as you see them.');
      const blocker = m.candidate && m.state === 'protect' ? r.ignoreBlocker(m.key) : null;
      const state = m.candidate
        ? h(
            'div',
            { class: 'sr-state', role: 'group', 'aria-label': 'This match' },
            btn('protect', 'Protect as file', 'Protect as file: it goes to a file on the bridge host, and the prompt says where (Space)', () => this.setState(m.key, 'protect'), { pressed: m.state === 'protect', cls: 'sr-choice' }),
            btn('ignore', 'Ignore this occurrence', 'Ignore this occurrence: it is sent as typed (Space)', () => this.setState(m.key, 'ignore'), {
              pressed: m.state === 'ignore',
              refused: blocker && ignoreRefusal(r, blocker),
              cls: 'sr-choice',
            }),
          )
        : h('div', { class: 'sr-state' }, btn('unmark', 'Remove this mark', 'Remove this mark: that text is sent as typed (Delete)', () => this.unmark(m.key), { icon: ICON.trash }));
      const edges = m.state === 'protect';
      const edge = (k: string, edgeName: 'start' | 'end', dir: 1 | -1, title: string) =>
        btn(k, '', `${title} (${edgeName === 'start' ? 'Shift+' : ''}${dir < 0 ? '←' : '→'})`, () => this.nudge(m.key, edgeName, dir), { icon: dir < 0 ? LEFT : RIGHT, disabled: !edges || !r.canNudge(m.key, edgeName, dir), cls: 'sr-nudge' });
      parts.push(
        state,
        h(
          'div',
          { class: 'sr-edges', role: 'group', 'aria-label': edges ? 'Its edges' : 'Its edges (protect it to correct them)' },
          h('span', { class: 'sr-edge' }, h('span', { class: 'sr-edge-name' }, 'Start'), edge('start-left', 'start', -1, 'Start one character earlier'), edge('start-right', 'start', 1, 'Start one character later')),
          h('span', { class: 'sr-edge' }, h('span', { class: 'sr-edge-name' }, 'End'), edge('end-left', 'end', -1, 'End one character earlier'), edge('end-right', 'end', 1, 'End one character later')),
        ),
      );
    } else {
      what.append(marks.length ? 'Pick a match in the prompt, or step through them.' : 'Select text in the prompt the scan missed, then mark it.');
    }
    parts.push(h('div', { class: 'sr-markrow' }, btn('mark', 'Mark the selection as secret', 'Mark the text selected in the prompt as a secret (M)', () => this.markSelection(), { icon: ICON.plus, cls: 'sr-markbtn' })));
    replaceKeepingFocus(this.strip, parts);
    this.renderMarkButton();
  }

  /** "Mark the selection" says whether there is one. */
  private renderMarkButton(): void {
    const b = this.strip.querySelector<HTMLElement>('[data-key="mark"]');
    if (!b) return;
    const has = !!this.picked;
    b.setAttribute('aria-disabled', has ? 'false' : 'true');
    b.title = has ? 'Mark the text selected in the prompt as a secret (M)' : 'Select text in the prompt first, then mark it (M)';
  }

  summary(): SecretsReviewSummary | null {
    const req = this.req;
    if (!this.dialog.open || !req) return null;
    return {
      kind: 'secrets-review',
      state: 'reviewing',
      target: req.target,
      length: req.review.text.length,
      marks: req.review.marks().map((m) => ({ key: m.key, candidate: m.candidate, start: m.start, end: m.end, state: m.state, encoded: m.encoded })),
      current: this.current,
      counts: req.review.counts(),
      notice: req.notice,
      manual: req.manual,
      status: this.statusText,
      error: this.statusError,
    };
  }
}

function countsLine(c: ReviewCounts): string {
  return `${c.protect} protected, ${c.ignore} ignored.`;
}

/** Why a match cannot be ignored: `blocker` took part of its found range (#108 C1). */
function ignoreRefusal(r: SecretReview, blocker: Readonly<Mark>): string {
  if (!blocker.candidate) return 'Ignoring sends the whole match as typed, and your mark covers part of it: take that mark away first (Delete on it).';
  const n = r.marks().filter((x) => x.candidate).indexOf(blocker) + 1;
  return `Ignoring sends the whole match as typed, and match ${n} now covers part of it: move its edge back first.`;
}

/** Moving `edge` in `dir` makes the range longer. */
const grew = (edge: 'start' | 'end', dir: 1 | -1) => (edge === 'start' ? dir < 0 : dir > 0);

/** Why an edge cannot move. */
function nudgeRefusal(r: SecretReview, m: Readonly<Mark>, edge: 'start' | 'end', dir: 1 | -1): string {
  if (m.state !== 'protect') return 'An ignored match is sent exactly as typed: protect it to correct its edges.';
  if (!grew(edge, dir)) return 'A match keeps at least one character: ignore it instead.';
  const marks = r.marks();
  const i = marks.findIndex((x) => x.key === m.key);
  const touching = edge === 'start' ? (marks[i - 1]?.end ?? -1) === m.start : (marks[i + 1]?.start ?? -1) === m.end;
  if (touching) return edge === 'start' ? 'The match before it ends there.' : 'The next match starts there.';
  return edge === 'start' ? 'It already starts at the beginning of the prompt.' : 'It already ends at the end of the prompt.';
}
