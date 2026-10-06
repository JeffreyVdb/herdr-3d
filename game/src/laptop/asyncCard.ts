import type { CodexQuestion, CommandArgs, WorkerCodex } from '../net/protocol';
import { h } from '../ui/dom';
import { answerAsyncArgs, answerProblem, asyncBatches, phaseAnnouncement, phaseText, questionWord, replyPhase, wantsAnswer, type AsyncCardBatch, type ReplyPhase } from '../world/codexQuestions';
import { focusQuestion, isSendKey, mark, moveIn, openQuestion, reveal, SEND_KEY } from './askStack';
import type { AsyncDrafts } from './asyncDrafts';
import { zoomKey } from './keys';

export type AsyncResult = { ok: true } | { ok: false; code: string; message: string };

export interface AsyncCardHost {
  /** Sends `worker.answer_async` (the args are whole: the card knows the worker). */
  answer(args: CommandArgs['worker.answer_async']): Promise<AsyncResult>;
  /** Sends `worker.dismiss_async`. */
  dismiss(args: CommandArgs['worker.dismiss_async']): Promise<AsyncResult>;
  /** The terminal (where a question the card cannot answer is answered). */
  toTerminal(): void;
  /** The keyboard back to the timeline (Esc in the card). */
  focusTimeline(): void;
  /** The card's height changed. */
  resized(): void;
  /** What you wrote, and what this page has seen of the batches (kept above the view). */
  drafts: AsyncDrafts;
}

type FocusTo = 'q' | 'send' | 'first' | `opt:${number}` | `fold:${string}`;

/** A question's state as its signature: each change of it is a step the bridge took (see `gens`). */
const sigOf = (q: CodexQuestion) => `${q.state}|${q.undelivered ? 1 : 0}|${q.error ?? ''}`;
/** A value inside a `[data-key="…"]` selector (batch ids are plain: `[A-Za-z0-9_.:-]`). */
const attr = (s: string) => s.replace(/["\\]/g, '\\$&');
const unresolved = (q: CodexQuestion) => q.state === 'pending' || q.state === 'sending' || q.state === 'sent';

/** What a folded question says of its reply, in a word or two. */
const SHORT: Record<ReplyPhase, string> = {
  open: 'answer',
  failed: 'not sent',
  sending: 'sending…',
  sent: 'sent',
  unconfirmed: 'not confirmed',
  undelivered: 'not delivered',
  answered: 'answered',
  hidden: 'hidden',
};

function agoText(at: number, now: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return `asked ${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `asked ${m}m ago` : `asked ${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m ago`;
}

/**
 * #157: a shared Codex worker's async questions, pinned above the prompt box while it works on (docs/protocol.md
 * "Codex async questions"). Codex asked them and did not stop: the prompt box stays on, and the terminal is a click
 * (or Ctrl+Esc) away. One section per batch, oldest first, the open one with its questions stacked as on the ask card
 * (askStack.ts) and the others folded to a line. A question with suggested answers takes one of them (a digit, a
 * click: picking never sends); one without takes a text. Only Send (or Ctrl/⌘+Enter) sends, the answered questions of
 * the open batch in one `worker.answer_async`, once: a second press while it is on its way sends nothing. What each
 * reply says comes from the bridge's evidence only: sent is accepted, not read; not delivered keeps the answer to send
 * again; a refusal keeps it too. Hide puts questions away here only (`worker.dismiss_async`: Codex still has them).
 * A conflict batch, or every batch while the bridge is not joined to the thread, is read-only: answer in the terminal.
 * Its look is the ask card's family in the working blue: the agent asks, and goes on.
 */
export class AsyncCard {
  readonly el: HTMLElement;
  /** The polite announcements of reply states (a sibling of the card: it is never redrawn). */
  readonly live: HTMLElement;
  private worker: string | null = null;
  private codex: WorkerCodex | null = null;
  private suppressed = false;
  private openKey: string | null = null;
  /** The open question: its position among the open batch's listed questions. */
  private active = 0;
  private nudged = false;
  private flash = -1;
  private focusTo: FocusTo | null = null;
  private note: { key: string; text: string; error: boolean } | null = null;
  /** Batches with a send or a hide on its way (no ack yet), and the questions it is for. */
  private readonly busy = new Map<string, Set<number>>();
  /**
   * Each question's last signature and how many times it changed while this card watched: the bridge's steps. A
   * return to an earlier state (sent again, or pending after a bridge restart) is a step too, never the old one.
   */
  private readonly gens = new Map<string, { sig: string; gen: number }>();
  /**
   * Questions an acked send was for, with their step at the send: not answerable again until the bridge moves them.
   * The bridge says sending / sent before it acks, so a send whose questions moved meanwhile leaves no guard.
   */
  private readonly guard = new Map<string, number>();
  /** Each listed question's reply phase as last drawn, for the announcements. */
  private phases = new Map<string, ReplyPhase>();
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: AsyncCardHost) {
    this.el = h('section', { class: 'tx-aq', hidden: true, role: 'region', 'aria-label': 'Codex’s questions' });
    this.live = h('div', { class: 'tx-aq-live', role: 'status', 'aria-live': 'polite' });
  }

  private get drafts(): AsyncDrafts {
    return this.host.drafts;
  }

  /** The worker's Codex launch now (null: none, or another worker's seat). Another worker starts afresh; drafts stay. */
  set(worker: string | null, codex: WorkerCodex | null): void {
    const same = worker === this.worker;
    if (!same) {
      this.worker = worker;
      this.openKey = null;
      this.active = 0;
      this.note = null;
      this.busy.clear();
      this.gens.clear();
      this.guard.clear();
      this.phases = new Map();
    }
    this.codex = codex;
    // No launch for a moment (a reconnect): what comes back is the bridge's word, not a send of ours still on its way.
    if (!codex) this.guard.clear();
    if (worker && codex) {
      this.drafts.prune(worker, codex);
      for (const b of asyncBatches({ codex })) if (b.questions.some(unresolved)) this.drafts.sawOpen(worker, b.key);
      const seen = new Set<string>();
      for (const b of asyncBatches({ codex })) {
        for (const q of b.questions) {
          const k = this.qkey(b, q);
          seen.add(k);
          const was = this.gens.get(k);
          const sig = sigOf(q);
          if (!was) this.gens.set(k, { sig, gen: 0 });
          else if (was.sig !== sig) this.gens.set(k, { sig, gen: was.gen + 1 });
          if (this.guard.has(k) && this.guard.get(k) !== this.gen(k)) this.guard.delete(k);
        }
      }
      for (const k of [...this.gens.keys()]) {
        if (seen.has(k)) continue;
        this.gens.delete(k);
        this.guard.delete(k);
      }
    }
    this.announce(same);
    this.render();
  }

  /** Hidden while an ask's card is up (the dialog the agent waits on goes first). */
  suppress(on: boolean): void {
    if (on === this.suppressed) return;
    this.suppressed = on;
    this.render();
  }

  get shown(): boolean {
    return !this.suppressed && this.batches().length > 0;
  }

  /** How many of its questions still want an answer (0 while it is not shown). */
  get toAnswer(): number {
    if (!this.shown) return 0;
    return this.batches().reduce((n, b) => n + this.listed(b).filter(wantsAnswer).length, 0);
  }

  destroy(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.el.remove();
    this.live.remove();
  }

  // --- model ---------------------------------------------------------------------------------------------------

  private qkey(b: Pick<AsyncCardBatch, 'key'>, q: Pick<CodexQuestion, 'index'>): string {
    return `${b.key}\u0000${q.index}`;
  }

  private gen(k: string): number {
    return this.gens.get(k)?.gen ?? 0;
  }

  /** A batch's questions as the card lists them: not the hidden ones, unless you asked to see them. */
  private listed(b: AsyncCardBatch): CodexQuestion[] {
    const all = !!this.worker && this.drafts.hiddenShown(this.worker);
    return b.questions.filter((q) => all || q.state !== 'dismissed');
  }

  /**
   * The batches on the card: those with a question to answer or a reply on its way, and those this page saw so that
   * have nothing left since (answered while you looked), until you clear them.
   */
  private batches(): AsyncCardBatch[] {
    const w = this.worker;
    if (!w || !this.codex) return [];
    return asyncBatches({ codex: this.codex }).filter((b) => {
      const qs = this.listed(b);
      if (!qs.length) return false;
      if (qs.some(unresolved)) return true;
      return qs.some((q) => q.state === 'dismissed') || (this.drafts.wasOpen(w, b.key) && !this.drafts.isCleared(w, b.key));
    });
  }

  private hiddenCount(): number {
    let n = 0;
    for (const b of asyncBatches({ codex: this.codex })) for (const q of b.questions) if (q.state === 'dismissed') n++;
    return n;
  }

  private draft(b: AsyncCardBatch, q: CodexQuestion): string {
    return this.worker ? this.drafts.get(this.worker, b.thread, b.batch, q.index) : '';
  }

  private inFlight(b: AsyncCardBatch, q: CodexQuestion): boolean {
    const k = this.qkey(b, q);
    return !!this.busy.get(b.key)?.has(q.index) || this.guard.get(k) === this.gen(k);
  }

  /** It can take an answer from here now. */
  private answerable(b: AsyncCardBatch, q: CodexQuestion): boolean {
    return !b.readOnly && wantsAnswer(q) && !this.inFlight(b, q);
  }

  /** What would go for question q (null: nothing yet). */
  private ready(b: AsyncCardBatch, q: CodexQuestion): string | null {
    if (!this.answerable(b, q)) return null;
    const d = this.draft(b, q);
    if (q.options?.length) return q.options.includes(d) ? d : null;
    return d.trim() ? d.trim() : null;
  }

  private open(): AsyncCardBatch | null {
    const bs = this.batches();
    let b = bs.find((x) => x.key === this.openKey) ?? null;
    if (!b) {
      b = bs.find((x) => this.listed(x).some((q) => this.answerable(x, q))) ?? bs.find((x) => this.listed(x).some(unresolved)) ?? bs[0] ?? null;
      this.openKey = b?.key ?? null;
      this.active = b ? this.firstOpen(b) : 0;
    }
    const n = b ? this.listed(b).length : 0;
    if (this.active >= n) this.active = Math.max(0, n - 1);
    return b;
  }

  private firstOpen(b: AsyncCardBatch): number {
    const qs = this.listed(b);
    const i = qs.findIndex((q) => this.answerable(b, q) && this.ready(b, q) === null);
    if (i >= 0) return i;
    const j = qs.findIndex((q) => this.answerable(b, q));
    return j >= 0 ? j : 0;
  }

  /** Reply states that changed since the last drawing, said politely (none for the first look at a worker). */
  private announce(same: boolean): void {
    const next = new Map<string, ReplyPhase>();
    const said: string[] = [];
    for (const b of asyncBatches({ codex: this.codex })) {
      for (const q of b.questions) {
        const k = this.qkey(b, q);
        const p = replyPhase(q);
        next.set(k, p);
        const was = this.phases.get(k);
        if (same && was !== undefined && was !== p) {
          const text = phaseAnnouncement(q);
          if (text && !said.includes(text)) said.push(text);
        }
      }
    }
    this.phases = next;
    if (said.length) this.say(said.join(' '));
  }

  private say(text: string): void {
    // Emptied first, so the same words twice are announced twice.
    this.live.textContent = '';
    queueMicrotask(() => (this.live.textContent = text));
  }

  // --- actions -------------------------------------------------------------------------------------------------

  /** Send (its click, Ctrl/⌘+Enter): what is answered in the open batch goes, once. */
  private trySend(): void {
    const b = this.open();
    const w = this.worker;
    if (!b || !w || b.readOnly || this.busy.has(b.key)) return;
    const qs = this.listed(b);
    const answers: Array<{ index: number; answer: string; pos: number; q: CodexQuestion }> = [];
    qs.forEach((q, pos) => {
      const a = this.ready(b, q);
      if (a !== null) answers.push({ index: q.index, answer: a, pos, q });
    });
    if (!answers.length) {
      if (!qs.some((q) => this.answerable(b, q))) return;
      this.note = { key: b.key, text: 'Answer at least one question first.', error: false };
      this.flash = this.active;
      this.focusTo = 'q';
      this.render();
      return;
    }
    for (const a of answers) {
      const why = answerProblem(a.q, a.answer);
      if (!why) continue;
      this.note = { key: b.key, text: qs.length > 1 ? `Question ${a.pos + 1}: ${why}` : why, error: true };
      this.active = a.pos;
      this.flash = a.pos;
      this.focusTo = 'q';
      this.render();
      return;
    }
    // Acked: each question that has not moved since (no sending / sent seen yet) waits for the bridge's next step.
    const at = new Map(answers.map((a) => [this.qkey(b, a.q), this.gen(this.qkey(b, a.q))]));
    void this.run(b, new Set(answers.map((a) => a.index)), () => this.host.answer(answerAsyncArgs(w, b, answers)), (ok) => {
      if (ok) for (const [k, g] of at) if (this.gen(k) === g) this.guard.set(k, g);
    });
  }

  /** Hide: the open batch's questions that can be put away, in the bridge only. */
  private hide(): void {
    const b = this.open();
    const w = this.worker;
    if (!b || !w || this.busy.has(b.key)) return;
    const indexes = this.listed(b)
      .filter((q) => (q.state === 'pending' || q.state === 'sent') && !this.inFlight(b, q))
      .map((q) => q.index);
    if (!indexes.length) return;
    void this.run(b, new Set(indexes), () => this.host.dismiss({ id: w, thread: b.thread, batch: b.batch, indexes }));
  }

  /** Runs one command about batch b; refused, the note says why and the answers stay. */
  private async run(b: AsyncCardBatch, indexes: Set<number>, cmd: () => Promise<AsyncResult>, done?: (ok: boolean) => void): Promise<void> {
    const worker = this.worker;
    this.busy.set(b.key, indexes);
    this.note = null;
    const hadFocus = this.el.contains(document.activeElement);
    this.render();
    let r: AsyncResult;
    try {
      r = await cmd();
    } catch (e) {
      r = { ok: false, code: 'internal', message: e instanceof Error ? e.message : String(e) };
    }
    if (this.worker !== worker) return;
    this.busy.delete(b.key);
    done?.(r.ok);
    if (!r.ok) {
      this.note = { key: b.key, text: r.message, error: true };
      this.say(r.message);
    }
    if (hadFocus && !this.el.contains(document.activeElement)) this.focusTo = 'first';
    this.render();
  }

  private clearDone(b: AsyncCardBatch): void {
    if (!this.worker) return;
    const hadFocus = this.el.contains(document.activeElement);
    this.drafts.clear(this.worker, b.key);
    this.openKey = null;
    this.render();
    if (hadFocus && !this.el.contains(document.activeElement)) (this.shown ? this.focus() : this.host.focusTimeline());
  }

  private openBatch(key: string): void {
    const b = this.batches().find((x) => x.key === key);
    if (!b) return;
    this.openKey = key;
    this.active = this.firstOpen(b);
    this.nudged = false;
    this.focusTo = 'first';
    this.render();
  }

  private openAt(pos: number): void {
    this.active = pos;
    this.nudged = false;
    this.focusTo = 'first';
    this.render();
  }

  /** Picks option v of the open question (the same again takes it back). Never sends. */
  private choose(v: string): void {
    const b = this.open();
    const q = b ? this.listed(b)[this.active] : undefined;
    if (!b || !q || !this.worker || !this.answerable(b, q)) return;
    const next = this.draft(b, q) === v ? '' : v;
    this.drafts.set(this.worker, b.thread, b.batch, q.index, next);
    if (this.note?.key === b.key && !this.note.error) this.note = null;
    this.nudged = false;
    if (next) {
      this.advance();
      return;
    }
    this.focusTo = `opt:${(q.options ?? []).indexOf(v) + 1}`;
    this.render();
  }

  /** The open question has its answer: on to the next one without one (the keyboard on it), else to Send. */
  private advance(): void {
    const b = this.open();
    if (!b) return;
    const qs = this.listed(b);
    let next = -1;
    for (let k = 1; k <= qs.length && next < 0; k++) {
      const j = (this.active + k) % qs.length;
      const q = qs[j] as CodexQuestion;
      if (this.answerable(b, q) && this.ready(b, q) === null) next = j;
    }
    if (next >= 0 && next !== this.active) {
      this.active = next;
      this.focusTo = 'q';
    } else this.focusTo = 'send';
    this.nudged = false;
    this.render();
  }

  /** ← → : the question before / after, across the batches (a batch opens as you reach it). */
  private step(d: 1 | -1): boolean {
    const bs = this.batches();
    const at: Array<[string, number]> = bs.flatMap((b) => this.listed(b).map((_, i): [string, number] => [b.key, i]));
    if (at.length < 2) return false;
    const cur = at.findIndex(([k, i]) => k === this.openKey && i === this.active);
    const to = at[cur + d];
    if (!to) return true;
    this.openKey = to[0];
    this.active = to[1];
    this.nudged = false;
    this.focusTo = 'first';
    this.render();
    return true;
  }

  // --- keys ----------------------------------------------------------------------------------------------------

  /** The keyboard on the card: the open question's picked option, else its first (or its text box), else its action. */
  focus(): void {
    const q = this.el.querySelector<HTMLElement>('.tx-ask-q');
    const b =
      q?.querySelector<HTMLElement>('button.tx-ask-opt[aria-checked="true"]:not(:disabled)') ??
      q?.querySelector<HTMLElement>('button.tx-ask-opt:not(:disabled), .tx-aq-text:not(:disabled)') ??
      this.el.querySelector<HTMLElement>('.tx-aq-act:not(:disabled), .tx-ask-send:not(:disabled)') ??
      q ??
      null;
    b?.focus({ preventScroll: true });
    if (b) reveal(b);
  }

  /**
   * A key on the transcript (not in a text box): digits pick on the open question, ← → go to the question before /
   * after, Ctrl/⌘+Enter sends. On the card itself (`inCard`) also: ↑ ↓ through the open question's options, Enter on
   * the question itself only says how to pick, Esc back to the timeline. Enter / Space on an option is its click: it
   * picks, never sends. Tab and Enter on the timeline stay the page's (the prompt box). True: it was the card's.
   */
  key(e: KeyboardEvent, inCard = false): boolean {
    if (!this.shown) return false;
    if (isSendKey(e)) {
      this.trySend();
      return true;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (inCard && e.key === 'Escape' && !e.shiftKey) {
      this.host.focusTimeline();
      return true;
    }
    const b = this.open();
    const q = b ? this.listed(b)[this.active] : undefined;
    const t = e.target as HTMLElement | null;
    const open = this.el.querySelector<HTMLElement>('.tx-ask-q');
    if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
      const opts = b && q && this.answerable(b, q) ? (q.options ?? []) : [];
      const v = opts[Number(e.key) - 1];
      if (v === undefined) return false;
      this.choose(v);
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
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return this.step(e.key === 'ArrowLeft' ? -1 : 1);
    return false;
  }

  /** The text box: Enter takes the text and moves on (never sends; Shift+Enter is a new line). */
  private onTextKey(e: KeyboardEvent): void {
    if (zoomKey(e)) return; // #59: the text zoom works from here too
    if (e.key === 'Escape' && (e.ctrlKey || e.metaKey)) return; // the terminal toggle (Ctrl/⌘+Esc) is the seat's
    e.stopPropagation(); // what is typed here is the answer's, not the game's or the timeline's
    if (isSendKey(e)) {
      e.preventDefault();
      this.trySend();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.host.focusTimeline();
    } else if (e.key === 'Enter' && !e.isComposing && !e.shiftKey) {
      e.preventDefault();
      const b = this.open();
      const q = b ? this.listed(b)[this.active] : undefined;
      if (b && q && this.ready(b, q) !== null) this.advance();
    }
  }

  // --- drawing -------------------------------------------------------------------------------------------------

  private render(): void {
    const bs = this.suppressed ? [] : this.batches();
    const b = bs.length ? this.open() : null;
    const wasShown = !this.el.hidden;
    this.el.hidden = !b;
    if (!b) {
      const hadFocus = this.el.contains(document.activeElement);
      this.el.replaceChildren();
      if (hadFocus) this.host.focusTimeline();
      if (this.ticker) clearInterval(this.ticker);
      this.ticker = null;
      if (wasShown) this.host.resized();
      return;
    }
    const focused = document.activeElement instanceof HTMLElement && this.el.contains(document.activeElement) ? document.activeElement : null;
    const focusedKey = focused?.dataset.key ?? null;
    const caret: [number, number] | null = focused instanceof HTMLTextAreaElement ? [focused.selectionStart, focused.selectionEnd] : null;
    const qs = this.listed(b);
    const sending = this.busy.has(b.key);
    const answerableN = qs.filter((q) => this.answerable(b, q)).length;
    const done = !qs.some(unresolved);
    this.el.dataset.phase = sending ? 'sending' : b.readOnly ? 'readonly' : done ? 'done' : 'open';
    this.el.setAttribute('aria-busy', String(sending));
    const working = !!this.codex?.turn;
    const hidden = this.hiddenCount();
    const showingHidden = !!this.worker && this.drafts.hiddenShown(this.worker);
    const top = h(
      'div',
      { class: 'tx-ask-top' },
      h('span', { class: 'tx-banner-tag tx-ask-tag tx-aq-tag' }, 'Codex asked'),
      working ? h('span', { class: 'tx-aq-work', title: 'Codex goes on working: answer whenever you like, or prompt it as usual.' }, h('span', { class: 'tx-aq-dot', 'aria-hidden': 'true' }), 'still working') : null,
      h('span', { class: 'tx-ask-wait tx-aq-ago', 'data-at': String(b.at) }, agoText(b.at, Date.now())),
      h('span', { class: 'tx-spacer' }),
      hidden
        ? h(
            'button',
            {
              class: 'tx-link tx-aq-hidden',
              'aria-pressed': String(showingHidden),
              title: showingHidden ? 'Stop listing the questions you hid here' : 'List the questions you hid here (Codex still has them; they cannot be answered from here)',
              onclick: () => {
                if (!this.worker) return;
                this.drafts.toggleHidden(this.worker);
                this.openKey = null;
                this.render();
              },
            },
            `${hidden} hidden`,
          )
        : null,
      h('button', { class: 'tx-link tx-to-term', title: 'Switch to the terminal (Ctrl+Esc)', onclick: () => this.host.toTerminal() }, 'Switch to terminal'),
    );
    const body = h('div', { class: 'tx-ask-body' });
    const stack = h('div', { class: 'tx-aq-stack' });
    for (const x of bs) stack.append(x.key === b.key ? this.openSection(x, sending) : this.foldedBatch(x));
    body.append(stack);
    const parts: HTMLElement[] = [top, body, this.foot(b, qs, sending, answerableN, done)];
    if (this.note?.key === b.key) parts.push(h('div', { class: `tx-ask-note${this.note.error ? ' is-error' : ''}`, role: this.note.error ? 'alert' : 'status' }, this.note.text));
    this.el.replaceChildren(...parts);
    this.flash = -1;
    this.tick();
    const to = this.focusTo;
    this.focusTo = null;
    if (to) this.applyFocus(to);
    else if (focused) {
      const again = focusedKey ? this.el.querySelector<HTMLElement>(`[data-key="${attr(focusedKey)}"]`) : null;
      if (again && !(again as HTMLButtonElement).disabled) {
        again.focus({ preventScroll: true });
        if (caret && again instanceof HTMLTextAreaElement) again.setSelectionRange(caret[0], caret[1]);
      } else this.focus();
      if (!this.el.contains(document.activeElement)) this.host.focusTimeline();
    }
    this.host.resized();
  }

  private applyFocus(to: FocusTo): void {
    if (to === 'q') focusQuestion(this.el.querySelector<HTMLElement>('.tx-ask-q'));
    else if (to === 'first') this.focus();
    else if (to === 'send') (this.el.querySelector<HTMLElement>('.tx-ask-send:not(:disabled)') ?? this.el.querySelector<HTMLElement>('.tx-ask-q'))?.focus({ preventScroll: true });
    else {
      const el = this.el.querySelector<HTMLElement>(`[data-key="${attr(to)}"]`);
      el?.focus({ preventScroll: true });
      if (el) reveal(el);
    }
    if (!this.el.contains(document.activeElement)) this.focus();
  }

  /** A batch that is not the open one: one line (how many, what is left, its first question); a click opens it. */
  private foldedBatch(b: AsyncCardBatch): HTMLElement {
    const qs = this.listed(b);
    const left = qs.filter((q) => wantsAnswer(q)).length;
    const away = qs.filter((q) => q.state === 'sending' || (q.state === 'sent' && !q.undelivered)).length;
    const what = [left ? `${left} to answer` : '', away ? `${away} sent` : '', !left && !away ? 'answered' : ''].filter(Boolean).join(' · ');
    const first = (qs.find(wantsAnswer) ?? qs[0]) as CodexQuestion;
    return h(
      'button',
      { class: `tx-ask-row tx-aq-fold${left ? '' : ' is-done'}`, 'data-key': `fold:${b.batch}`, 'data-batch': b.batch, title: qs.map((q) => q.title).join('\n'), onclick: () => this.openBatch(b.key) },
      h('span', { class: `tx-ask-mark${left ? '' : ' is-done'}`, 'aria-hidden': 'true' }, mark(qs.length, !left && !away)),
      h('span', { class: 'tx-ask-row-head' }, questionWord(qs.length)),
      h('span', { class: 'tx-ask-row-text' }, first.title),
      h('span', { class: 'tx-ask-row-act' }, what),
    );
  }

  /** The open batch: its read-only note, then its questions (the open one boxed, the others folded). */
  private openSection(b: AsyncCardBatch, sending: boolean): HTMLElement {
    const qs = this.listed(b);
    const sec = h('div', { class: 'tx-aq-batch', 'data-batch': b.batch, ...(b.readOnly ? { 'data-readonly': b.readOnly } : {}) });
    if (b.readOnly) {
      sec.append(
        h(
          'p',
          { class: 'tx-aq-ro' },
          b.readOnly === 'conflict'
            ? 'Codex’s live view and its history disagree on these questions, so herdr-3d does not answer them. Answer in the terminal while it shows them.'
            : 'herdr-3d is not connected to Codex’s thread right now, so it cannot send answers. Answer in the terminal while it shows them.',
        ),
      );
    }
    if (qs.length > 1) {
      const stack = h('div', { class: 'tx-ask-stack' });
      qs.forEach((q, i) => stack.append(i === this.active ? this.openQuestion(b, q, i, qs.length, sending) : this.foldedQuestion(b, q, i, sending)));
      sec.append(stack);
    } else sec.append(this.openQuestion(b, qs[0] as CodexQuestion, 0, 1, sending));
    return sec;
  }

  /** What a question's reply says now: the bridge's evidence, or "Sending…" while our command has no answer yet. */
  private phaseOf(b: AsyncCardBatch, q: CodexQuestion): { phase: ReplyPhase; text: string } {
    if (this.busy.get(b.key)?.has(q.index) && wantsAnswer(q)) return { phase: 'sending', text: 'Sending…' };
    return { phase: replyPhase(q), text: phaseText(q) };
  }

  private foldedQuestion(b: AsyncCardBatch, q: CodexQuestion, pos: number, sending: boolean): HTMLElement {
    const { phase } = this.phaseOf(b, q);
    const answer = q.state === 'answered' ? (q.answer ?? '') : (this.ready(b, q) ?? (unresolved(q) && !wantsAnswer(q) ? this.draft(b, q) : ''));
    const done = q.state === 'answered';
    return h(
      'button',
      {
        class: `tx-ask-row${done ? ' is-done' : ''}`,
        'data-key': `row:${pos}`,
        'data-index': String(q.index),
        'data-phase': phase,
        disabled: sending,
        title: answer ? `${q.title} → ${answer}` : q.title,
        onclick: () => this.openAt(pos),
      },
      h('span', { class: `tx-ask-mark${done ? ' is-done' : ''}`, 'aria-hidden': 'true' }, mark(pos + 1, done)),
      h('span', { class: 'tx-ask-row-head' }, `Question ${pos + 1}`),
      h('span', { class: 'tx-ask-row-text' }, answer || q.title),
      h('span', { class: 'tx-ask-row-act' }, phase === 'open' && answer ? 'ready' : phase === 'answered' && q.answered_by === 'other' ? 'answered elsewhere' : SHORT[phase]),
    );
  }

  /** The open question: what its reply says (first: a short screen shows it), then its options or its text box (or what went). */
  private openQuestion(b: AsyncCardBatch, q: CodexQuestion, pos: number, n: number, sending: boolean): HTMLElement {
    const can = this.answerable(b, q) && !sending;
    const d = this.draft(b, q);
    const opts = q.options ?? [];
    const qid = `tx-aq-q-${b.batch}-${q.index}`;
    const picked = q.state === 'answered' ? (q.answer ?? '') : d;
    let list: HTMLElement | null = null;
    if (opts.length) {
      list = h('div', { class: 'tx-ask-opts', role: 'radiogroup', 'aria-labelledby': qid });
      opts.forEach((v, k) => {
        const on = picked === v;
        (list as HTMLElement).append(
          h(
            'button',
            {
              class: `tx-ask-opt${on ? ' is-on' : ''}`,
              role: 'radio',
              'aria-checked': String(on),
              disabled: !can,
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
    let text: HTMLElement | null = null;
    if (!opts.length && (can || (wantsAnswer(q) && !b.readOnly))) {
      const area = h('textarea', { rows: '3' });
      area.className = 'tx-aq-text tx-ask-other-input tx-fu-area';
      area.placeholder = 'Type your answer…';
      area.setAttribute('aria-label', 'Your answer');
      area.dataset.key = `text:${b.batch}:${q.index}`;
      area.autocomplete = 'off';
      area.spellcheck = true;
      area.disabled = !can;
      area.value = d;
      area.addEventListener('input', () => {
        if (!this.worker) return;
        this.drafts.set(this.worker, b.thread, b.batch, q.index, area.value);
        if (this.note?.key === b.key) {
          this.note = null;
          this.el.querySelector('.tx-ask-note')?.remove();
        }
        this.paint();
      });
      area.addEventListener('keydown', (e) => this.onTextKey(e as KeyboardEvent));
      text = h('div', { class: 'tx-fu-field' }, area);
    } else if (!opts.length && (q.state === 'answered' ? q.answer : d)) {
      // What went (or what is kept for the terminal): quoted, read-only.
      text = h('blockquote', { class: 'tx-aq-sent', 'aria-label': q.state === 'answered' ? 'The answer' : 'Your answer' }, q.state === 'answered' ? (q.answer ?? '') : d);
    }
    const { phase, text: said } = this.phaseOf(b, q);
    const state = said ? h('div', { class: 'tx-aq-state', 'data-phase': phase }, said) : null;
    const el = openQuestion(
      {
        index: pos,
        line: { header: n > 1 ? `Question ${pos + 1}` : '', question: q.title, done: q.state === 'answered', answer: picked },
        several: n > 1,
        options: can ? opts.length : 0,
        nudged: this.nudged,
        flash: this.flash === pos,
        qid,
      },
      state,
      list,
      text,
    );
    el.dataset.index = String(q.index);
    el.dataset.phase = phase;
    return el;
  }

  private foot(b: AsyncCardBatch, qs: CodexQuestion[], sending: boolean, answerableN: number, done: boolean): HTMLElement {
    const readyN = qs.filter((q) => this.ready(b, q) !== null).length;
    const q = qs[this.active];
    const opts = q && this.answerable(b, q) ? (q.options ?? []).length : 0;
    const several = this.batches().reduce((n, x) => n + this.listed(x).length, 0) > 1;
    const keys = `${opts ? `1–${opts} or ↑↓ Enter pick · ` : ''}${several ? '← → question · ' : ''}${answerableN ? `${SEND_KEY} send · ` : ''}Esc back`;
    const hint = b.readOnly
      ? 'Answer it in the terminal'
      : sending
        ? 'Sending your answers to Codex…'
        : done
          ? 'Nothing left to answer here'
          : !answerableN
            ? 'Nothing to answer until Codex replies'
            : !readyN
              ? 'Not answered yet'
              : readyN < answerableN
                ? `${readyN} of ${answerableN} ready: the rest stay open`
                : 'Ready: Enter on Send';
    const actions: HTMLElement[] = [];
    if (b.readOnly) {
      actions.push(h('button', { class: 'tx-ask-send tx-aq-act', 'data-key': 'term', onclick: () => this.host.toTerminal() }, 'Answer in the terminal'));
    } else if (done) {
      actions.push(h('button', { class: 'tx-ask-send tx-aq-act', 'data-key': 'clear', title: 'Take it off this card (its questions stay answered)', onclick: () => this.clearDone(b) }, 'Clear'));
    } else {
      const hideable = qs.some((x) => (x.state === 'pending' || x.state === 'sent') && !this.inFlight(b, x));
      actions.push(
        h('button', { class: 'tx-link tx-ask-dismiss tx-aq-hide', 'data-key': 'hide', disabled: sending || !hideable, title: 'Hide these questions on this card. Codex still has them: nothing is sent to it.', onclick: () => this.hide() }, 'Hide'),
        h(
          'button',
          {
            class: `tx-ask-send${readyN ? '' : ' is-blocked'}`,
            'data-key': 'send',
            disabled: sending || !answerableN,
            'aria-disabled': sending || !answerableN ? null : String(!readyN),
            onclick: () => this.trySend(),
          },
          sending ? 'Sending…' : this.sendLabel(readyN, answerableN),
          sending ? null : h('kbd', { class: 'tx-ask-kbd' }, SEND_KEY),
        ),
      );
    }
    return h('div', { class: 'tx-ask-foot' }, h('span', { class: 'tx-ask-hint' }, h('span', { class: 'tx-ask-hint-text' }, hint), h('span', { class: 'tx-ask-keys' }, keys)), ...actions);
  }

  private sendLabel(readyN: number, answerableN: number): string {
    if (readyN > 0 && readyN < answerableN) return `Send ${readyN} of ${answerableN}`;
    return answerableN > 1 ? 'Send answers' : 'Send answer';
  }

  /** Repaints Send and the hint as you type, without redrawing the text box. */
  private paint(): void {
    const b = this.open();
    if (!b) return;
    const qs = this.listed(b);
    const readyN = qs.filter((q) => this.ready(b, q) !== null).length;
    const answerableN = qs.filter((q) => this.answerable(b, q)).length;
    const send = this.el.querySelector<HTMLButtonElement>('.tx-ask-send[data-key="send"]');
    if (send && !send.disabled) {
      send.classList.toggle('is-blocked', !readyN);
      send.setAttribute('aria-disabled', String(!readyN));
      send.firstChild?.replaceWith(document.createTextNode(this.sendLabel(readyN, answerableN)));
    }
    const hint = this.el.querySelector('.tx-ask-hint-text');
    if (hint) hint.textContent = !readyN ? 'Not answered yet' : readyN < answerableN ? `${readyN} of ${answerableN} ready: the rest stay open` : 'Ready: Enter on Send';
  }

  private tick(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      const el = this.el.querySelector<HTMLElement>('.tx-aq-ago');
      if (el) el.textContent = agoText(Number(el.dataset.at), Date.now());
    }, 1000);
  }
}
