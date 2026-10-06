import type { CommandArgs, Followup, FollowupQuestion } from '../net/protocol';
import { waitingText } from '../world/ask';
import {
  answeredFollowup,
  answerFollowupArgs,
  answerOf,
  emptyFollowupPicks,
  followupAnswers,
  pickValue,
  setText,
  YES_NO,
  type FollowupPick,
} from '../world/followup';
import { h } from '../ui/dom';
import { focusQuestion, foldedRow, isSendKey, mark, moveIn, openQuestion, reveal, SEND_KEY, type StackLine } from './askStack';
import { zoomKey } from './keys';

export type FollowupResult = { ok: true } | { ok: false; code: string; message: string };

export interface FollowupCardHost {
  /** Sends `worker.answer_followup` (`id` is filled in by the host). */
  answer(args: CommandArgs['worker.answer_followup']): Promise<FollowupResult>;
  /** Sends `worker.dismiss_followup`. */
  dismiss(turnId: string): Promise<FollowupResult>;
  /** The keyboard back to the timeline (Esc in the card). */
  focusTimeline(): void;
  /** The card's height changed. */
  resized(): void;
}

/**
 * #90: the open questions of the agent's final message, pinned above the prompt box while the worker has them. The
 * bridge found them with the AI integration's models (a classifier said the message asks you something, an LLM
 * listed the questions), so the card says it was detected automatically and stays out of the way: the prompt box
 * stays on, and a prompt typed there clears it. Its questions stacked as on the ask card (askStack.ts): yes/no takes
 * Yes or No and a note, a choice its options or Other, an open question a text. Send sends what is answered as one
 * prompt (it says how many of them: the rest are left out, on purpose only); Dismiss drops it. Its look is the ask
 * card's (#57), drawn dashed: inferred, not a dialog the agent waits on.
 */
type FocusTo = 'q' | 'send' | 'first' | `opt:${number}`;

export class FollowupCard {
  readonly el: HTMLElement;
  private followup: Followup | null = null;
  /** The turn whose answers (or dismissal) are on their way. */
  private sent: string | null = null;
  /** A turn the bridge acked as answered or dismissed: not shown again while its upsert is on its way. */
  private gone: string | null = null;
  private picksFor: string | null = null;
  private picks: FollowupPick[] = [];
  /** The open question (-1: every one folded, all answered: Send is next). */
  private active = 0;
  private nudged = false;
  private flash = -1;
  private focusTo: FocusTo | null = null;
  private note: { text: string; error: boolean } | null = null;
  private suppressed = false;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private waitEl: HTMLElement | null = null;

  constructor(private readonly host: FollowupCardHost) {
    this.el = h('section', { class: 'tx-fu', hidden: true, 'aria-label': 'Open questions' });
  }

  private get shownFollowup(): Followup | null {
    const f = this.followup;
    if (!f || f.turn_id === this.gone || this.suppressed) return null;
    return f;
  }

  get shown(): boolean {
    return !!this.shownFollowup;
  }

  /** How many questions it asks (0 while it is not shown). */
  get count(): number {
    return this.shownFollowup?.questions.length ?? 0;
  }

  get turnId(): string | null {
    return this.shownFollowup?.turn_id ?? null;
  }

  private get sending(): boolean {
    return this.sent !== null && this.sent === this.shownFollowup?.turn_id;
  }

  /** The worker's follow-up now (null: none). Another turn starts afresh; the same keeps what you picked. */
  set(f: Followup | null): void {
    this.followup = f;
    if (f?.turn_id !== this.gone) this.gone = null;
    this.sync();
  }

  /** Hidden while an ask's card is up (the dialog the agent waits on goes first). */
  suppress(on: boolean): void {
    if (on === this.suppressed) return;
    this.suppressed = on;
    this.sync();
  }

  private sync(): void {
    const f = this.shownFollowup;
    const id = f?.turn_id ?? null;
    if (id !== this.picksFor) {
      this.picksFor = id;
      this.picks = f ? emptyFollowupPicks(f) : [];
      this.active = 0;
      this.nudged = false;
      this.note = null;
    }
    this.render();
  }

  destroy(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.el.remove();
  }

  /** The keyboard on the card: the open question's picked option, else its first (or its text); all folded, Send. */
  focus(): void {
    const q = this.el.querySelector<HTMLElement>('.tx-ask-q');
    const b = q
      ? (q.querySelector<HTMLElement>('button.tx-ask-opt[aria-checked="true"]:not(:disabled)') ?? q.querySelector<HTMLElement>('button.tx-ask-opt:not(:disabled), .tx-fu-text:not(:disabled)'))
      : this.el.querySelector<HTMLElement>('.tx-ask-send:not(:disabled)');
    b?.focus({ preventScroll: true });
    if (b) reveal(b);
  }

  // --- keys --------------------------------------------------------------------------------------------------

  /**
   * A key on the transcript (not in a text box): digits pick on the open question, ← → open the question before /
   * after, Ctrl/⌘+Enter sends. On the card itself (`inCard`) also: ↑ ↓ move through the open question's options,
   * Enter on the question itself only says how to pick, Esc goes back to the timeline. Enter / Space on an option is
   * its click: it picks, never sends. Tab is never the card's, nor is Enter on the timeline: it goes to the prompt
   * box, which a typed prompt clears the card from. True: it was the card's.
   */
  key(e: KeyboardEvent, inCard = false): boolean {
    const f = this.shownFollowup;
    if (!f) return false;
    if (isSendKey(e)) {
      if (!this.sent) this.trySend();
      return true;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (inCard && e.key === 'Escape' && !e.shiftKey) {
      this.host.focusTimeline();
      return true;
    }
    if (this.sending) return false;
    const t = e.target as HTMLElement | null;
    const open = this.el.querySelector<HTMLElement>('.tx-ask-q');
    const q = f.questions[this.active];
    if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
      if (!q) return false;
      const vals = valuesOf(q);
      const n = Number(e.key);
      if (n <= vals.length) this.choose(vals[n - 1] as string);
      else if (n === vals.length + 1 && q.kind !== 'open') this.focusText();
      else return false;
      return true;
    }
    if (inCard && t && t === open && (e.key === 'Enter' || e.key === ' ')) {
      this.nudged = true;
      this.focusTo = 'q';
      this.render();
      return true;
    }
    if (inCard && t && open?.contains(t) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      moveIn(open, t, e.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    const n = f.questions.length;
    if (n > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const back = e.key === 'ArrowLeft';
      const from = this.active >= 0 ? this.active : back ? n : -1;
      const to = from + (back ? -1 : 1);
      if (to >= 0 && to < n) this.openAt(to);
      return true;
    }
    return false;
  }

  private choose(v: string): void {
    const f = this.shownFollowup;
    if (!f || this.sending) return;
    const q = f.questions[this.active] as FollowupQuestion;
    this.picks = pickValue(f, this.picks, this.active, v);
    if (q.kind === 'choice' && this.picks[this.active]?.value) this.picks = this.picks.map((p, i) => (i === this.active ? { ...p, text: '' } : p));
    this.note = null;
    this.nudged = false;
    if (this.picks[this.active]?.value) {
      this.advance();
      return;
    }
    // The same again took it back: it stays, the keyboard on that option.
    this.focusTo = `opt:${valuesOf(q).indexOf(v) + 1}`;
    this.render();
  }

  /** The open question is answered: on to the next one without an answer (the keyboard on it), else to Send. */
  private advance(): void {
    const f = this.shownFollowup;
    if (!f) return;
    const n = f.questions.length;
    let next = -1;
    for (let k = 1; k <= n && next < 0; k++) {
      const j = (this.active + k) % n;
      if (!answeredFollowup(f, this.picks, j)) next = j;
    }
    if (next >= 0) {
      this.active = next;
      this.focusTo = 'q';
    } else {
      if (n > 1) this.active = -1;
      this.focusTo = 'send';
    }
    this.nudged = false;
    this.render();
  }

  private openAt(i: number): void {
    this.active = i;
    this.nudged = false;
    this.focusTo = 'first';
    this.render();
  }

  private focusText(): void {
    const t = this.el.querySelector<HTMLElement>('.tx-fu-text');
    t?.focus({ preventScroll: true });
    if (t) reveal(t);
  }

  /** Send (its click, Ctrl/⌘+Enter): what is answered goes; with nothing answered, the open question says so. */
  private trySend(): void {
    const f = this.shownFollowup;
    if (!f || this.sent) return;
    if (!followupAnswers(f, this.picks).length) {
      this.note = { text: 'Answer at least one question first.', error: false };
      if (this.active < 0) this.active = 0;
      this.flash = this.active;
      this.focusTo = 'q';
      this.render();
      return;
    }
    void this.submit();
  }

  private async submit(): Promise<void> {
    const f = this.shownFollowup;
    if (!f || this.sent) return;
    const args = answerFollowupArgs('', f, this.picks);
    if (!args) return;
    const r = await this.send(f, () => this.host.answer(args));
    if (r && !r.ok) this.note = { text: r.message, error: true };
    this.render();
  }

  private async dismiss(): Promise<void> {
    const f = this.shownFollowup;
    if (!f || this.sent) return;
    const r = await this.send(f, () => this.host.dismiss(f.turn_id));
    if (r && !r.ok) this.note = { text: r.message, error: true };
    this.render();
  }

  /** Runs one command about follow-up f; done, the card goes (its upsert without it may still be on its way). */
  private async send(f: Followup, run: () => Promise<FollowupResult>): Promise<FollowupResult | null> {
    this.sent = f.turn_id;
    this.note = null;
    this.render();
    let r: FollowupResult;
    try {
      r = await run();
    } catch (e) {
      r = { ok: false, code: 'internal', message: e instanceof Error ? e.message : String(e) };
    }
    if (this.sent === f.turn_id) this.sent = null;
    if (r.ok || r.code === 'stale') {
      this.gone = f.turn_id;
      const hadFocus = this.el.contains(document.activeElement);
      this.sync();
      if (hadFocus) this.host.focusTimeline();
      return null;
    }
    return this.followup?.turn_id === f.turn_id ? r : null;
  }

  /** The text box: Enter takes the text and moves on (never sends; Shift+Enter is a new line in an open answer). */
  private onTextKey(e: KeyboardEvent, multiline: boolean): void {
    if (zoomKey(e)) return; // #59: the text zoom works from here too
    e.stopPropagation(); // what is typed here is the answer's, not the game's or the timeline's
    const f = this.shownFollowup;
    if (!f) return;
    if (isSendKey(e)) {
      e.preventDefault();
      this.trySend();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.host.focusTimeline();
    } else if (e.key === 'Enter' && !e.isComposing && (!multiline || !e.shiftKey)) {
      e.preventDefault();
      if (answeredFollowup(f, this.picks, this.active)) this.advance();
    } else if (!multiline && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      moveIn((e.target as HTMLElement).closest<HTMLElement>('.tx-ask-q'), e.target as HTMLElement, e.key === 'ArrowDown' ? 1 : -1);
    }
  }

  // --- drawing -----------------------------------------------------------------------------------------------

  private line(f: Followup, i: number): StackLine {
    const q = f.questions[i] as FollowupQuestion;
    const a = answerOf(f, this.picks, i);
    const several = f.questions.length > 1;
    return {
      header: several ? `Question ${i + 1}` : '',
      question: f.source === 'fallback' ? 'The agent asked you something. Your answer goes back as a prompt.' : q.question,
      done: !!a,
      answer: a ? (a.note ? `${a.value} (${a.note})` : a.value) : '',
    };
  }

  private render(): void {
    const f = this.shownFollowup;
    this.el.hidden = !f;
    if (!f) {
      const hadFocus = this.el.contains(document.activeElement);
      this.el.replaceChildren();
      if (hadFocus) this.host.focusTimeline();
      if (this.ticker) clearInterval(this.ticker);
      this.ticker = null;
      this.host.resized();
      return;
    }
    const focused = document.activeElement instanceof HTMLElement && this.el.contains(document.activeElement) ? document.activeElement : null;
    const focusedKey = focused?.dataset.key ?? null;
    const focusedText = !!focused?.classList.contains('tx-fu-text');
    const sending = this.sending;
    const several = f.questions.length > 1;
    if (!several) this.active = 0;
    this.el.setAttribute('aria-busy', String(sending));
    this.el.dataset.phase = sending ? 'sending' : 'pending';
    this.el.dataset.source = f.source;
    this.waitEl = h('span', { class: 'tx-ask-wait' }, waitingText(f.at, Date.now()));
    const top = h(
      'div',
      { class: 'tx-ask-top' },
      h('span', { class: 'tx-banner-tag tx-ask-tag' }, several ? `${f.questions.length} open questions` : 'Open question'),
      this.waitEl,
      h('span', { class: 'tx-spacer' }),
      h(
        'span',
        {
          class: 'tx-fu-auto',
          title: `Found in the agent’s last message by the AI integration (score ${f.score.toFixed(2)}). It can be wrong: ignore it and type a prompt, or dismiss it.`,
        },
        'Detected automatically',
      ),
    );
    const body = h('div', { class: 'tx-ask-body' });
    if (f.source === 'fallback' && f.tail) {
      body.append(h('blockquote', { class: 'tx-fu-tail', 'aria-label': 'The end of the agent’s message' }, f.tail));
    }
    if (several) {
      const stack = h('div', { class: 'tx-ask-stack' });
      f.questions.forEach((_, i) => stack.append(i === this.active ? this.openSection(f, i, sending) : foldedRow(i, this.line(f, i), () => this.openAt(i), sending)));
      body.append(stack);
    } else body.append(this.openSection(f, 0, sending));
    const answeredN = followupAnswers(f, this.picks).length;
    const ready = answeredN > 0;
    const send = h(
      'button',
      {
        class: `tx-ask-send${ready ? '' : ' is-blocked'}`,
        'data-key': 'send',
        disabled: !!this.sent,
        'aria-disabled': this.sent ? null : String(!ready),
        onclick: () => this.trySend(),
      },
      sending ? 'Sending…' : this.sendLabel(f, answeredN),
      sending ? null : h('kbd', { class: 'tx-ask-kbd' }, SEND_KEY),
    );
    const q = f.questions[this.active];
    const vals = q ? valuesOf(q) : [];
    const pickKeys = vals.length ? `1–${vals.length + (q?.kind === 'choice' ? 1 : 0)} or ↑↓ Enter pick · ` : '';
    const keys = `${pickKeys}${several ? '← → question · ' : ''}${SEND_KEY} send · Esc back`;
    const parts: HTMLElement[] = [
      top,
      body,
      h(
        'div',
        { class: 'tx-ask-foot' },
        h('span', { class: 'tx-ask-hint' }, h('span', { class: 'tx-ask-hint-text' }, this.hint()), h('span', { class: 'tx-ask-keys' }, keys)),
        h('button', { class: 'tx-link tx-ask-dismiss', 'data-key': 'dismiss', disabled: !!this.sent, title: 'Drop these questions: nothing is sent to the agent', onclick: () => void this.dismiss() }, 'Dismiss'),
        send,
      ),
    ];
    if (this.note) parts.push(h('div', { class: `tx-ask-note${this.note.error ? ' is-error' : ''}`, role: this.note.error ? 'alert' : 'status' }, this.note.text));
    this.el.replaceChildren(...parts);
    this.flash = -1;
    this.tick();
    const to = this.focusTo;
    this.focusTo = null;
    if (sending) {
      if (focused) this.host.focusTimeline();
    } else if (to) this.applyFocus(to);
    else if (focusedText) (this.el.querySelector('.tx-fu-text') as HTMLElement | null)?.focus({ preventScroll: true });
    else if (focused) {
      const again = focusedKey ? this.el.querySelector<HTMLElement>(`[data-key="${focusedKey}"]`) : null;
      if (again && !(again as HTMLButtonElement).disabled) again.focus({ preventScroll: true });
      else this.focus();
      if (!this.el.contains(document.activeElement)) this.host.focusTimeline();
    }
    this.host.resized();
  }

  private applyFocus(to: FocusTo): void {
    if (to === 'q') focusQuestion(this.el.querySelector<HTMLElement>('.tx-ask-q'));
    else if (to === 'first') this.focus();
    else {
      const el = this.el.querySelector<HTMLElement>(`[data-key="${to}"]`);
      el?.focus({ preventScroll: true });
      if (el) reveal(el);
    }
    if (!this.el.contains(document.activeElement)) this.focus();
  }

  /** Question i, open: its values as rows (Yes / No, a choice's options), then its text (a note, Other, the answer). */
  private openSection(f: Followup, i: number, sending: boolean): HTMLElement {
    const q = f.questions[i] as FollowupQuestion;
    const pick = this.picks[i] as FollowupPick;
    const qid = `tx-fu-q-${f.turn_id}`;
    const vals = valuesOf(q);
    let list: HTMLElement | null = null;
    if (vals.length) {
      const opts = h('div', { class: 'tx-ask-opts', role: 'radiogroup', 'aria-labelledby': qid });
      list = opts;
      vals.forEach((v, k) => {
        const on = pick.value === v;
        opts.append(
          h(
            'button',
            {
              class: `tx-ask-opt${on ? ' is-on' : ''}`,
              role: 'radio',
              'aria-checked': String(on),
              disabled: sending,
              'data-n': String(k + 1),
              'data-key': `opt:${k + 1}`,
              onclick: () => this.choose(v),
            },
            h('span', { class: 'tx-ask-key', 'aria-hidden': 'true' }, String(k + 1)),
            h('span', { class: 'tx-ask-opt-text' }, h('span', { class: 'tx-ask-opt-label' }, v)),
          ),
        );
      });
    }
    // yes/no: a note after the answer; a choice: Other; open: the answer itself.
    const multiline = q.kind === 'open';
    const text = (multiline ? h('textarea', { rows: '3' }) : h('input', { type: 'text' })) as HTMLInputElement | HTMLTextAreaElement;
    text.className = `tx-fu-text tx-ask-other-input${multiline ? ' tx-fu-area' : ''}`;
    text.placeholder = q.kind === 'yes_no' ? 'Add a note (optional)' : q.kind === 'choice' ? 'Or type your own answer…' : 'Type your answer…';
    text.setAttribute('aria-label', q.kind === 'yes_no' ? 'Note' : q.kind === 'choice' ? 'Your own answer' : 'Your answer');
    text.maxLength = 4000;
    text.autocomplete = 'off';
    text.spellcheck = true;
    text.disabled = sending;
    text.value = pick.text;
    text.addEventListener('input', () => {
      const cur = this.shownFollowup;
      if (!cur) return;
      this.picks = setText(cur, this.picks, this.active, text.value);
      this.note = null;
      this.paint();
    });
    text.addEventListener('keydown', (e) => this.onTextKey(e as KeyboardEvent, multiline));
    const textRow =
      q.kind === 'choice'
        ? h('label', { class: `tx-ask-opt tx-ask-other${pick.value === null && pick.text.trim() ? ' is-on' : ''}`, 'data-n': String(vals.length + 1) }, h('span', { class: 'tx-ask-key', 'aria-hidden': 'true' }, String(vals.length + 1)), h('span', { class: 'tx-ask-opt-text' }, h('span', { class: 'tx-ask-opt-label' }, 'Other'), text))
        : h('div', { class: 'tx-fu-field' }, text);
    if (q.kind === 'choice' && list) list.append(textRow);
    return openQuestion(
      { index: i, line: this.line(f, i), several: f.questions.length > 1, options: vals.length, nudged: this.nudged, flash: this.flash === i, qid },
      list,
      q.kind === 'choice' && list ? null : textRow,
    );
  }

  /** Send says how many go when some are left out. */
  private sendLabel(f: Followup, answeredN: number): string {
    const all = f.questions.length;
    if (answeredN > 0 && answeredN < all) return `Send ${answeredN} of ${all}`;
    return all > 1 ? 'Send answers' : 'Send answer';
  }

  /** What the foot says: what is answered, or that it is being sent. */
  private hint(): string {
    const f = this.shownFollowup;
    if (!f) return '';
    if (this.sending) return 'Sending your answers as a prompt…';
    const n = followupAnswers(f, this.picks).length;
    const all = f.questions.length;
    if (all === 1) return n ? 'Ready: Enter on Send' : 'Not answered yet';
    if (!n) return `None of ${all} answered yet`;
    return n === all ? 'All answered: Enter on Send' : `${n} of ${all} answered: the rest are left out`;
  }

  /** Repaints the picks without redrawing the text box you type in. */
  private paint(): void {
    const f = this.shownFollowup;
    if (!f || this.active < 0) return;
    const pick = this.picks[this.active] as FollowupPick;
    for (const b of this.el.querySelectorAll<HTMLElement>('button.tx-ask-opt')) {
      const on = b.querySelector('.tx-ask-opt-label')?.textContent === pick.value;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
    }
    this.el.querySelector('.tx-ask-other')?.classList.toggle('is-on', pick.value === null && !!pick.text.trim());
    const n = followupAnswers(f, this.picks).length;
    const send = this.el.querySelector<HTMLButtonElement>('.tx-ask-send');
    if (send && !this.sent) {
      send.classList.toggle('is-blocked', !n);
      send.setAttribute('aria-disabled', String(!n));
      send.firstChild?.replaceWith(document.createTextNode(this.sendLabel(f, n)));
    }
    const done = answeredFollowup(f, this.picks, this.active);
    const m = this.el.querySelector('.tx-ask-q-head .tx-ask-mark');
    m?.classList.toggle('is-done', done);
    m?.replaceChildren(mark(this.active + 1, done));
    const hint = this.el.querySelector('.tx-ask-hint-text');
    if (hint) hint.textContent = this.hint();
  }

  private tick(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      const f = this.shownFollowup;
      if (!f || !this.waitEl) return;
      this.waitEl.textContent = waitingText(f.at, Date.now());
    }, 1000);
  }
}

/** The values a question offers as rows: Yes / No, a choice's options, none for an open one. */
function valuesOf(q: FollowupQuestion): string[] {
  if (q.kind === 'yes_no') return [...YES_NO];
  if (q.kind === 'choice') return q.options ?? [];
  return [];
}
