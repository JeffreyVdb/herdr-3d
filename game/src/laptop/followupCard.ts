import type { CommandArgs, Followup, FollowupQuestion } from '../net/protocol';
import { waitingText } from '../world/ask';
import {
  acceptAllRecommendations,
  acceptRecommendation,
  answeredFollowup,
  answerFollowupArgs,
  answerOf,
  emptyFollowupPicks,
  followupAnswers,
  isRecommended,
  pickValue,
  questionName,
  recommendationsLeft,
  recommendedPick,
  setText,
  unansweredNames,
  YES_NO,
  type FollowupPick,
} from '../world/followup';
import { h } from '../ui/dom';
import { focusQuestion, foldedRow, isSendKey, mark, moveIn, openQuestion, reveal, reviewLink, SEND_KEY, type AnswerOptions, type CardSecrets, type StackLine } from './askStack';
import { reviewKey } from '../ui/secretsFlow';
import type { FollowupDraft } from './followupDrafts';
import { zoomKey } from './keys';
import { renderMarkdown } from '../ui/boards/markdown';

export type FollowupResult = { ok: true } | { ok: false; code: string; message: string };

/** #60: the message a follow-up is of (`worker.followup_message`). */
export type FollowupMessage = { ok: true; text: string; cut: boolean } | { ok: false; code: string; message: string };

export interface FollowupCardHost {
  /** Sends `worker.answer_followup` (`id` is filled in by the host; #108 `o.review`: its texts reviewed on purpose first). */
  answer(args: CommandArgs['worker.answer_followup'], o?: AnswerOptions): Promise<FollowupResult>;
  /** #108 round 4: the switch, for "Review secrets" (absent: no such control). */
  secrets?: CardSecrets | null;
  /** Sends `worker.dismiss_followup`. */
  dismiss(turnId: string): Promise<FollowupResult>;
  /** #60: sends `worker.retry_followup` (none: no Retry). */
  retry?(turnId: string): Promise<FollowupResult>;
  /** #60: the whole message, `worker.followup_message` (none: only its end, a fallback's tail). */
  message?(turnId: string): Promise<FollowupMessage>;
  /** #60: what you picked and wrote, kept by the host across views (none: this card's own, which goes with it). */
  drafts?: { get(turn: string): FollowupDraft | null; set(turn: string, d: FollowupDraft): void; clear(turn: string): void };
  /** The keyboard back to the timeline (Esc in the card; #187: the sheet closes). */
  focusTimeline(): void;
  /** The card's height changed. */
  resized(): void;
}

/**
 * #90: the open questions of the agent's final message, in the questions' sheet's calm lane while the worker has them
 * (#187: it never opens the sheet by itself; questionSheet.ts). The
 * bridge found them with the AI integration's models (a classifier said the message asks you something, an LLM
 * listed the questions), so the card says it was detected automatically and stays out of the way: the prompt box
 * stays on, and a prompt typed there clears it. Its questions stacked as on the ask card (askStack.ts): yes/no takes
 * Yes or No and a note, a choice its options or Other, an open question a text. Send sends what is answered as one
 * prompt (it says how many of them: the rest are listed as unanswered); Dismiss drops it. Its look is the ask card's
 * (#57), drawn dashed: inferred, not a dialog the agent waits on.
 *
 * #60, a grill round: each question named as the agent did (Q9), its context rendered, the agent's recommendation
 * under its options with Use recommendation (R), and Use all recommendations for the round. Accepting only fills the
 * answers: Send (or Ctrl/⌘+Enter) is still the one way anything goes, and the foot says what goes and which questions
 * go unanswered. When the questions could not be read (a fallback), the card says so and why, offers Retry and the
 * whole message, and keeps your free answer: if a retry reads them, it goes along as a note after the answers. What
 * you pick and write is kept (the host's drafts) across a retry, a reconnect and standing up.
 */
type FocusTo = 'q' | 'send' | 'first' | `opt:${number}` | 'text';

type MessageState = { turn: string; open: boolean; text?: string; cut?: boolean; error?: string; loading?: boolean };

export class FollowupCard {
  readonly el: HTMLElement;
  private followup: Followup | null = null;
  /** The turn whose answers (or dismissal) are on their way. */
  private sent: string | null = null;
  /** A turn the bridge acked as answered or dismissed: not shown again while its upsert is on its way. */
  private gone: string | null = null;
  /** The follow-up the picks are of: its turn and its questions' ids. */
  private picksFor: string | null = null;
  /** The follow-up the picks are of (by index of its questions). */
  private pickedOf: Followup | null = null;
  private picks: FollowupPick[] = [];
  /** The round's note: a fallback's free answer, kept when a retry read its questions (sent after the answers). */
  private roundNote = '';
  /** The note's field is up (it stays while you empty it). */
  private noteShown = false;
  /** The open question (-1: every one folded, all answered: Send is next). */
  private active = 0;
  private nudged = false;
  private flash = -1;
  private focusTo: FocusTo | null = null;
  private note: { text: string; error: boolean } | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private waitEl: HTMLElement | null = null;
  /** The turn a retry runs for. */
  private retrying: string | null = null;
  private message: MessageState | null = null;

  constructor(private readonly host: FollowupCardHost) {
    this.el = h('section', { class: 'tx-fu', hidden: true, 'aria-label': 'Open questions' });
    // #108: the switch shows or hides "Review secrets".
    host.secrets?.onChange(() => {
      if (this.shownFollowup) this.render();
    });
  }

  private get shownFollowup(): Followup | null {
    const f = this.followup;
    if (!f || f.turn_id === this.gone) return null;
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

  private isFallback(f: Followup): boolean {
    return f.source === 'fallback' && f.questions.length === 1;
  }

  /** The worker's follow-up now (null: none). Another turn starts afresh; the same keeps what you picked. */
  set(f: Followup | null): void {
    this.followup = f;
    if (f?.turn_id !== this.gone) this.gone = null;
    this.sync();
  }

  private sync(): void {
    const f = this.shownFollowup;
    const id = f ? `${f.turn_id}\u0000${f.source}\u0000${f.questions.map((q) => q.id).join(',')}` : null;
    if (id !== this.picksFor) {
      const prev = f && this.pickedOf?.turn_id === f.turn_id ? this.draft() : null;
      this.picksFor = id;
      this.pickedOf = f;
      this.note = null;
      this.nudged = false;
      if (f) this.restore(f, prev);
      else this.picks = [];
      this.active = 0;
      if (f && f.turn_id !== this.message?.turn) this.message = null;
    }
    this.render();
  }

  /**
   * The picks of follow-up f: the same turn's (its questions read again: by question id) or the host's draft. A
   * fallback's free answer is no answer to the questions read later: it becomes the round's note.
   */
  private restore(f: Followup, same: FollowupDraft | null): void {
    const d = same ?? this.host.drafts?.get(f.turn_id) ?? null;
    this.picks = emptyFollowupPicks(f);
    this.roundNote = d?.note ?? '';
    this.noteShown = false;
    if (!d) return;
    if (d.source === 'fallback' && !this.isFallback(f)) {
      const free = Object.values(d.picks)
        .map((p) => p.text.trim())
        .filter(Boolean)
        .join('\n\n');
      this.roundNote = [this.roundNote.trim(), free].filter(Boolean).join('\n\n');
      this.noteShown = !!this.roundNote;
    } else {
      this.picks = f.questions.map((q) => d.picks[q.id] ?? { value: null, text: '' });
    }
    this.noteShown ||= !!this.roundNote.trim() && !this.isFallback(f);
    this.save();
  }

  /** What is picked and written now, by question id. */
  private draft(): FollowupDraft {
    const f = this.pickedOf;
    const picks: Record<string, FollowupPick> = {};
    f?.questions.forEach((q, i) => {
      const p = this.picks[i];
      if (p) picks[q.id] = p;
    });
    return { picks, note: this.roundNote, source: f?.source ?? '' };
  }

  private save(): void {
    const f = this.shownFollowup;
    if (f) this.host.drafts?.set(f.turn_id, this.draft());
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
   * A key in the questions' sheet (not in a text box): digits pick on the open question, R takes its recommendation
   * (#60), ← → open the question before / after, Ctrl/⌘+Enter sends. On the card itself (`inCard`) also: ↑ ↓ move
   * through the open question's options, Enter on the question itself only says how to pick, Esc leaves (the sheet
   * closes). Enter / Space on an option is its click: it picks, never sends; R only fills. Tab is never the card's.
   * True: it was the card's.
   */
  key(e: KeyboardEvent, inCard = false): boolean {
    const f = this.shownFollowup;
    if (!f) return false;
    if (isSendKey(e)) {
      if (!this.sent) this.trySend();
      return true;
    }
    // #108: the answers' review on purpose, then their send.
    if (reviewKey(e) && this.host.secrets?.on) {
      if (!this.sent && !e.repeat) this.trySend(true);
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
    if ((e.key === 'r' || e.key === 'R') && !e.shiftKey && q && !this.isFallback(f) && recommendedPick(f, this.active)) {
      this.useRecommendation(this.active);
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
    this.save();
    if (this.picks[this.active]?.value) {
      this.advance();
      return;
    }
    // The same again took it back: it stays, the keyboard on that option.
    this.focusTo = `opt:${valuesOf(q).indexOf(v) + 1}`;
    this.render();
  }

  /** #60: question qi takes the agent's recommendation (filled, never sent); a choice moves on, an open one stays to edit. */
  private useRecommendation(qi: number): void {
    const f = this.shownFollowup;
    if (!f || this.sending) return;
    this.picks = acceptRecommendation(f, this.picks, qi);
    this.note = null;
    this.nudged = false;
    this.save();
    this.active = qi;
    if (this.picks[qi]?.value) {
      this.advance();
      return;
    }
    this.focusTo = 'text';
    this.render();
  }

  /** #60: every unanswered question takes its recommendation; the answers you gave stay. Nothing is sent. */
  private useAll(): void {
    const f = this.shownFollowup;
    if (!f || this.sending) return;
    const { picks, filled } = acceptAllRecommendations(f, this.picks);
    this.picks = picks;
    this.save();
    const left = unansweredNames(f, picks);
    this.note = {
      text: `Filled ${filled} answer${filled === 1 ? '' : 's'} with the agent’s recommendation. Review them, then Send${left.length ? ` (${left.join(', ')} without one)` : ''}.`,
      error: false,
    };
    this.nudged = false;
    const next = f.questions.findIndex((_, i) => !answeredFollowup(f, picks, i));
    if (next >= 0) {
      this.active = next;
      this.focusTo = 'q';
    } else {
      if (f.questions.length > 1) this.active = -1;
      this.focusTo = 'send';
    }
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
    const t = this.el.querySelector<HTMLElement>('.tx-ask-q .tx-fu-text');
    t?.focus({ preventScroll: true });
    if (t) reveal(t);
  }

  /** Send (its click, Ctrl/⌘+Enter): what is answered goes; with nothing answered, the open question says so. */
  /** `review` (#108): "Review secrets": the answers' texts reviewed on purpose before they go. */
  private trySend(review = false): void {
    const f = this.shownFollowup;
    if (!f || this.sent) return;
    if (!followupAnswers(f, this.picks).length && !this.roundNote.trim()) {
      this.note = { text: 'Answer at least one question first.', error: false };
      if (this.active < 0) this.active = 0;
      this.flash = this.active;
      this.focusTo = 'q';
      this.render();
      return;
    }
    void this.submit(review);
  }

  private async submit(review = false): Promise<void> {
    const f = this.shownFollowup;
    if (!f || this.sent) return;
    const args = answerFollowupArgs('', f, this.picks, this.roundNote);
    if (!args) return;
    const r = await this.send(f, () => this.host.answer(args, review ? { review: true } : undefined));
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

  /** #60: Retry: the bridge reads the questions again; its upsert brings them (or the fallback again, with why). */
  private async retry(): Promise<void> {
    const f = this.shownFollowup;
    if (!f || this.sent || this.retrying || !this.host.retry) return;
    this.retrying = f.turn_id;
    this.note = null;
    this.render();
    let r: FollowupResult;
    try {
      r = await this.host.retry(f.turn_id);
    } catch (e) {
      r = { ok: false, code: 'internal', message: e instanceof Error ? e.message : String(e) };
    }
    if (this.retrying === f.turn_id) this.retrying = null;
    if (this.followup?.turn_id !== f.turn_id) return;
    if (!r.ok) this.note = { text: r.message, error: true };
    else if (this.followup && this.isFallback(this.followup)) this.note = { text: 'Still could not read the questions. Answer in your own words, or try again.', error: false };
    this.render();
  }

  /** #60: shows (fetched once) or hides the whole message. */
  private async toggleMessage(): Promise<void> {
    const f = this.shownFollowup;
    if (!f) return;
    const m = this.message?.turn === f.turn_id ? this.message : (this.message = { turn: f.turn_id, open: false });
    m.open = !m.open;
    if (!m.open || m.text !== undefined || m.loading || !this.host.message) {
      this.render();
      return;
    }
    m.loading = true;
    delete m.error;
    this.render();
    let r: FollowupMessage;
    try {
      r = await this.host.message(f.turn_id);
    } catch (e) {
      r = { ok: false, code: 'internal', message: e instanceof Error ? e.message : String(e) };
    }
    m.loading = false;
    if (r.ok) {
      m.text = r.text;
      m.cut = r.cut;
    } else m.error = r.message;
    if (this.message === m) this.render();
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
      this.host.drafts?.clear(f.turn_id);
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
    if (e.key === 'Escape' && (e.ctrlKey || e.metaKey)) return; // the terminal toggle (Ctrl/⌘+Esc) is the sheet's
    e.stopPropagation(); // what is typed here is the answer's, not the game's or the timeline's
    const f = this.shownFollowup;
    if (!f) return;
    if (isSendKey(e)) {
      e.preventDefault();
      this.trySend();
    } else if (reviewKey(e) && this.host.secrets?.on) {
      e.preventDefault();
      if (!e.repeat) this.trySend(true);
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
    const answer = a ? (a.note ? `${a.value} (${a.note})` : a.value) : '';
    return {
      header: q.label ?? (several ? `Question ${i + 1}` : ''),
      question: this.isFallback(f) ? 'The agent asked you something. Your answer goes back as a prompt.' : q.question,
      done: !!a,
      answer: a && isRecommended(f, this.picks, i) ? `${oneLine(answer)} · recommended` : oneLine(answer),
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
    const focusedText = focused?.classList.contains('tx-fu-text') ? (focused.dataset.key ?? 'text') : null;
    const sending = this.sending;
    const fallback = this.isFallback(f);
    const several = f.questions.length > 1;
    if (!several) this.active = 0;
    this.el.setAttribute('aria-busy', String(sending || this.retrying === f.turn_id));
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
          title:
            f.source === 'parsed'
              ? `Read from the agent’s last message as it was written (score ${f.score.toFixed(2)}). It can be wrong: ignore it and type a prompt, or dismiss it.`
              : `Found in the agent’s last message by the AI integration (score ${f.score.toFixed(2)}). It can be wrong: ignore it and type a prompt, or dismiss it.`,
        },
        'Detected automatically',
      ),
    );
    const body = h('div', { class: 'tx-ask-body' });
    if (fallback) body.append(...this.fallbackParts(f));
    else body.append(...this.roundParts(f));
    if (several) {
      const stack = h('div', { class: 'tx-ask-stack' });
      f.questions.forEach((_, i) => stack.append(i === this.active ? this.openSection(f, i, sending) : foldedRow(i, this.line(f, i), () => this.openAt(i), sending)));
      body.append(stack);
    } else body.append(this.openSection(f, 0, sending));
    if (this.noteShown && !fallback) body.append(this.noteField(sending));
    const answeredN = followupAnswers(f, this.picks).length;
    const ready = answeredN > 0 || !!this.roundNote.trim();
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
    const parts: HTMLElement[] = [
      top,
      body,
      h(
        'div',
        { class: 'tx-ask-foot' },
        h('span', { class: 'tx-ask-hint' }, h('span', { class: 'tx-ask-hint-text' }, this.hint()), h('span', { class: 'tx-ask-keys' }, this.keys(f))),
        h('button', { class: 'tx-link tx-ask-dismiss', 'data-key': 'dismiss', disabled: !!this.sent, title: 'Drop these questions: nothing is sent to the agent', onclick: () => void this.dismiss() }, 'Dismiss'),
        reviewLink(this.host.secrets, !!this.sent, () => this.trySend(true)),
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
    else if (focusedText) (this.el.querySelector(`.tx-fu-text[data-key="${focusedText}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
    else if (focused) {
      const again = focusedKey ? this.el.querySelector<HTMLElement>(`[data-key="${focusedKey}"]`) : null;
      if (again && !(again as HTMLButtonElement).disabled) again.focus({ preventScroll: true });
      else this.focus();
      if (!this.el.contains(document.activeElement)) this.host.focusTimeline();
    }
    this.host.resized();
  }

  /** #60: a fallback: why its questions could not be read, Retry, the message (its end, or all of it). */
  private fallbackParts(f: Followup): HTMLElement[] {
    const retrying = this.retrying === f.turn_id;
    const left = 3 - (f.retries ?? 0);
    const actions = h('span', { class: 'tx-fu-fail-acts' });
    if (this.host.retry && left > 0)
      actions.append(
        h(
          'button',
          { class: 'tx-fu-btn', 'data-key': 'retry', disabled: retrying || !!this.sent, title: 'Ask the bridge to read the questions again (nothing is sent to the agent)', onclick: () => void this.retry() },
          retrying ? 'Retrying…' : 'Retry',
        ),
      );
    actions.append(this.messageToggle(f));
    const fail = h(
      'div',
      { class: 'tx-fu-fail', role: 'note' },
      h('p', { class: 'tx-fu-fail-title' }, 'The questions could not be prepared as answers.'),
      h('p', { class: 'tx-fu-fail-why' }, f.error ? `Why: ${f.error}` : 'Answer in your own words: your reply goes back as a prompt.'),
      actions,
    );
    const m = this.message?.turn === f.turn_id && this.message.open ? this.message : null;
    if (m) return [fail, this.messageView(m)];
    return f.tail ? [fail, h('blockquote', { class: 'tx-fu-tail', 'aria-label': 'The end of the agent’s message' }, f.tail)] : [fail];
  }

  /** #60: a round's own line: how far you are, Use all recommendations, and the whole message. */
  private roundParts(f: Followup): HTMLElement[] {
    const out: HTMLElement[] = [];
    const several = f.questions.length > 1;
    const recs = f.questions.filter((q) => q.recommendation).length;
    if (several || recs || f.unlisted) {
      const answeredN = followupAnswers(f, this.picks).length;
      const left = recommendationsLeft(f, this.picks);
      const bar = h('div', { class: 'tx-fu-round' });
      if (several) bar.append(h('span', { class: 'tx-fu-progress', 'aria-live': 'polite' }, h('b', {}, String(answeredN)), ` of ${f.questions.length} answered`));
      bar.append(h('span', { class: 'tx-spacer' }));
      if (several && recs)
        bar.append(
          h(
            'button',
            {
              class: 'tx-fu-btn tx-fu-all',
              'data-key': 'use-all',
              disabled: !!this.sent || !left,
              title: left ? `Fill the ${left} unanswered question${left === 1 ? '' : 's'} with the agent’s recommendation. Nothing is sent until you press Send.` : 'Every question with a recommendation is answered',
              onclick: () => this.useAll(),
            },
            'Use all recommendations',
          ),
        );
      if (this.host.message) bar.append(this.messageToggle(f));
      out.push(bar);
    }
    if (f.unlisted)
      out.push(
        h('p', { class: 'tx-fu-unlisted', role: 'note' }, `${f.unlisted} more question${f.unlisted === 1 ? ' is' : 's are'} only in the agent’s message: read it, and answer ${f.unlisted === 1 ? 'it' : 'them'} in the prompt box.`),
      );
    const m = this.message?.turn === f.turn_id && this.message.open ? this.message : null;
    if (m) out.push(this.messageView(m));
    return out;
  }

  private messageToggle(f: Followup): HTMLElement {
    const open = this.message?.turn === f.turn_id && this.message.open;
    return h('button', { class: 'tx-link tx-fu-msg-toggle', 'data-key': 'message', 'aria-expanded': String(!!open), onclick: () => void this.toggleMessage() }, open ? 'Hide the message' : 'Show the whole message');
  }

  private messageView(m: MessageState): HTMLElement {
    const box = h('div', { class: 'tx-fu-msg', 'aria-label': 'The agent’s message', tabindex: '0' });
    if (m.loading) box.append(h('p', { class: 'tx-fu-msg-state' }, 'Loading the message…'));
    else if (m.error !== undefined) box.append(h('p', { class: 'tx-fu-msg-state is-error' }, m.error));
    else if (m.text !== undefined) {
      if (m.cut) box.append(h('p', { class: 'tx-fu-msg-state' }, 'The message is long: its last part is shown.'));
      box.append(markdown('tx-md tx-fu-msg-text', m.text));
    } else box.append(h('p', { class: 'tx-fu-msg-state' }, 'The message is not available here.'));
    return box;
  }

  /** #60: the round's note: a fallback's free answer kept after its questions were read, sent after the answers. */
  private noteField(sending: boolean): HTMLElement {
    const area = h('textarea', { rows: '2' }) as HTMLTextAreaElement;
    area.className = 'tx-fu-text tx-ask-other-input tx-fu-area tx-fu-note';
    area.dataset.key = 'note';
    area.setAttribute('aria-label', 'Your earlier reply, sent after the answers');
    area.maxLength = 8000;
    area.disabled = sending;
    area.value = this.roundNote;
    area.addEventListener('input', () => {
      this.roundNote = area.value;
      this.save();
      this.paint();
    });
    area.addEventListener('keydown', (e) => this.onTextKey(e as KeyboardEvent, true));
    return h('label', { class: 'tx-fu-carry' }, h('span', { class: 'tx-fu-carry-head' }, 'Your earlier reply · sent after the answers'), area);
  }

  private applyFocus(to: FocusTo): void {
    if (to === 'q') focusQuestion(this.el.querySelector<HTMLElement>('.tx-ask-q'));
    else if (to === 'first') this.focus();
    else if (to === 'text') this.focusText();
    else {
      const el = this.el.querySelector<HTMLElement>(`[data-key="${to}"]`);
      el?.focus({ preventScroll: true });
      if (el) reveal(el);
    }
    if (!this.el.contains(document.activeElement)) this.focus();
  }

  /** Question i, open: its context, its values as rows (Yes / No, a choice's options), the agent's recommendation, then its text. */
  private openSection(f: Followup, i: number, sending: boolean): HTMLElement {
    const q = f.questions[i] as FollowupQuestion;
    const pick = this.picks[i] as FollowupPick;
    const qid = `tx-fu-q-${f.turn_id}`;
    const vals = valuesOf(q);
    const recOption = q.kind === 'choice' && q.recommendation?.option !== undefined ? q.options?.[q.recommendation.option] : q.kind === 'yes_no' ? recommendedPick(f, i)?.value : undefined;
    let list: HTMLElement | null = null;
    if (vals.length) {
      const opts = h('div', { class: 'tx-ask-opts', role: 'radiogroup', 'aria-labelledby': qid });
      list = opts;
      vals.forEach((v, k) => {
        const on = pick.value === v;
        const label = h('span', { class: 'tx-ask-opt-label' });
        inlineMarkdown(label, v);
        if (v === recOption) label.append(h('span', { class: 'tx-ask-rec' }, 'Recommended'));
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
              'data-value': v,
              onclick: () => this.choose(v),
            },
            h('span', { class: 'tx-ask-key', 'aria-hidden': 'true' }, String(k + 1)),
            h('span', { class: 'tx-ask-opt-text' }, label),
          ),
        );
      });
    }
    // yes/no: a note after the answer; a choice: Other; open: the answer itself.
    const multiline = q.kind === 'open';
    const text = (multiline ? h('textarea', { rows: '3' }) : h('input', { type: 'text' })) as HTMLInputElement | HTMLTextAreaElement;
    text.className = `tx-fu-text tx-ask-other-input${multiline ? ' tx-fu-area' : ''}`;
    text.dataset.key = 'text';
    text.placeholder = q.kind === 'yes_no' ? 'Add a note (optional)' : q.kind === 'choice' ? 'Or type your own answer…' : 'Type your answer…';
    text.setAttribute('aria-label', q.kind === 'yes_no' ? 'Note' : q.kind === 'choice' ? 'Your own answer' : 'Your answer');
    text.maxLength = 8000;
    text.autocomplete = 'off';
    text.spellcheck = true;
    text.disabled = sending;
    text.value = pick.text;
    text.addEventListener('input', () => {
      const cur = this.shownFollowup;
      if (!cur) return;
      this.picks = setText(cur, this.picks, this.active, text.value);
      this.note = null;
      this.save();
      this.paint();
    });
    text.addEventListener('keydown', (e) => this.onTextKey(e as KeyboardEvent, multiline));
    const textRow =
      q.kind === 'choice'
        ? h('label', { class: `tx-ask-opt tx-ask-other${pick.value === null && pick.text.trim() ? ' is-on' : ''}`, 'data-n': String(vals.length + 1) }, h('span', { class: 'tx-ask-key', 'aria-hidden': 'true' }, String(vals.length + 1)), h('span', { class: 'tx-ask-opt-text' }, h('span', { class: 'tx-ask-opt-label' }, 'Other'), text))
        : h('div', { class: 'tx-fu-field' }, text);
    if (q.kind === 'choice' && list) list.append(textRow);
    const context = q.context && !this.isFallback(f) ? markdown('tx-md tx-fu-context', q.context) : null;
    return openQuestion(
      { index: i, line: this.line(f, i), several: f.questions.length > 1, options: vals.length, nudged: this.nudged, flash: this.flash === i, qid },
      context,
      list,
      this.recommendation(f, i, sending),
      q.kind === 'choice' && list ? null : textRow,
    );
  }

  /** #60: the agent's recommendation for question i, and Use recommendation (R) while it is not the answer already. */
  private recommendation(f: Followup, i: number, sending: boolean): HTMLElement | null {
    const r = f.questions[i]?.recommendation;
    if (!r || this.isFallback(f)) return null;
    const using = isRecommended(f, this.picks, i);
    const can = !!recommendedPick(f, i);
    const head = h('div', { class: 'tx-fu-rec-head' }, h('span', { class: 'tx-fu-rec-tag' }, 'Recommended'));
    head.append(h('span', { class: 'tx-spacer' }));
    if (using) head.append(h('span', { class: 'tx-fu-rec-using' }, 'Your answer'));
    else if (can)
      head.append(
        h(
          'button',
          { class: 'tx-fu-btn tx-fu-use', 'data-key': 'use-rec', disabled: sending, title: 'Fill this answer with the agent’s recommendation (R). Nothing is sent until you press Send.', onclick: () => this.useRecommendation(i) },
          'Use recommendation',
          h('kbd', { class: 'tx-ask-kbd' }, 'R'),
        ),
      );
    const box = h('div', { class: `tx-fu-rec${using ? ' is-using' : ''}` }, head, markdown('tx-md tx-fu-rec-text', r.text));
    if (r.cut)
      box.append(
        h('p', { class: 'tx-fu-rec-cut', role: 'note' }, `It is longer than an answer can be, so it is cut here and cannot be used as it is: ${this.host.message ? 'Show the whole message' : 'the agent’s message'} has all of it.`),
      );
    if (r.why) box.append(markdown('tx-md tx-fu-rec-why', r.why));
    return box;
  }

  /** Send says how many go when some are left out. */
  private sendLabel(f: Followup, answeredN: number): string {
    const all = f.questions.length;
    if (!answeredN && this.roundNote.trim() && !this.isFallback(f)) return 'Send your reply';
    if (answeredN > 0 && answeredN < all) return `Send ${answeredN} of ${all}`;
    return all > 1 ? 'Send answers' : 'Send answer';
  }

  /** What the foot says: what is answered, which go unanswered, or that it is being sent. */
  private hint(): string {
    const f = this.shownFollowup;
    if (!f) return '';
    if (this.sending) return 'Sending your answers as a prompt…';
    const n = followupAnswers(f, this.picks).length;
    const all = f.questions.length;
    if (all === 1) return n || this.roundNote.trim() ? 'Ready: Enter on Send' : 'Not answered yet';
    if (!n) return `None of ${all} answered yet`;
    if (n === all) return 'All answered: Enter on Send';
    const left = unansweredNames(f, this.picks);
    let names = left.length > 5 ? `${left.slice(0, 4).join(', ')} and ${left.length - 4} more` : left.join(', ');
    if (left.every((x) => /^\d+$/.test(x))) names = `${left.length === 1 ? 'question' : 'questions'} ${names}`;
    return `${n} of ${all} answered: ${names} ${left.length === 1 ? 'goes' : 'go'} as unanswered`;
  }

  private keys(f: Followup): string {
    const several = f.questions.length > 1;
    const q = f.questions[this.active];
    const vals = q ? valuesOf(q) : [];
    const pickKeys = vals.length ? `1–${vals.length + (q?.kind === 'choice' ? 1 : 0)} or ↑↓ Enter pick · ` : '';
    const rec = q && !this.isFallback(f) && recommendedPick(f, this.active) && !isRecommended(f, this.picks, this.active) ? 'R recommendation · ' : '';
    return `${pickKeys}${rec}${several ? '← → question · ' : ''}${SEND_KEY} send · Esc closes`;
  }

  /** Repaints the picks without redrawing the text box you type in. */
  private paint(): void {
    const f = this.shownFollowup;
    if (!f) return;
    const n = followupAnswers(f, this.picks).length;
    const send = this.el.querySelector<HTMLButtonElement>('.tx-ask-send');
    const ready = n > 0 || !!this.roundNote.trim();
    if (send && !this.sent) {
      send.classList.toggle('is-blocked', !ready);
      send.setAttribute('aria-disabled', String(!ready));
      send.firstChild?.replaceWith(document.createTextNode(this.sendLabel(f, n)));
    }
    const hint = this.el.querySelector('.tx-ask-hint-text');
    if (hint) hint.textContent = this.hint();
    const progress = this.el.querySelector('.tx-fu-progress b');
    if (progress) progress.textContent = String(n);
    const all = this.el.querySelector<HTMLButtonElement>('.tx-fu-all');
    if (all && !this.sent) all.disabled = !recommendationsLeft(f, this.picks);
    if (this.active < 0) return;
    const pick = this.picks[this.active] as FollowupPick;
    for (const b of this.el.querySelectorAll<HTMLElement>('button.tx-ask-opt')) {
      const on = b.dataset.value === pick.value;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
    }
    this.el.querySelector('.tx-ask-other')?.classList.toggle('is-on', pick.value === null && !!pick.text.trim());
    const done = answeredFollowup(f, this.picks, this.active);
    const m = this.el.querySelector('.tx-ask-q-head .tx-ask-mark');
    m?.classList.toggle('is-done', done);
    m?.replaceChildren(mark(this.active + 1, done));
    // Typed over (or back to) the recommendation: its box says whether it is your answer.
    const rec = this.el.querySelector('.tx-fu-rec');
    if (rec && rec.classList.contains('is-using') !== isRecommended(f, this.picks, this.active)) {
      const box = this.recommendation(f, this.active, false);
      if (box) rec.replaceWith(box);
    }
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

/** One line of the agent's Markdown as plain text, for a folded row: no code ticks or emphasis marks. */
const oneLine = (s: string) =>
  s
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();

/** The agent's Markdown in a block (sanitised by the transcript's rules; plain text where it cannot be). */
function markdown(cls: string, md: string): HTMLElement {
  const el = h('div', { class: cls });
  const frag = renderMarkdown(md);
  if (frag) el.replaceChildren(frag);
  else el.textContent = md;
  return el;
}

/** An option's one line: its Markdown's inline parts only (code, emphasis), never a block or a link in a button. */
function inlineMarkdown(el: HTMLElement, md: string): void {
  const frag = renderMarkdown(md);
  const p = frag?.firstElementChild;
  if (!frag || frag.childElementCount !== 1 || p?.tagName !== 'P') {
    el.textContent = md;
    return;
  }
  for (const a of p.querySelectorAll('a')) a.replaceWith(...a.childNodes);
  el.append(...p.childNodes);
}
