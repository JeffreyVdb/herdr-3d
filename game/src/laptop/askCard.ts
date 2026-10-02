import type { Ask, AskQuestion, CommandArgs, TranscriptAsk, TranscriptItem } from '../net/protocol';
import {
  answerAskArgs,
  answered,
  answeredLines,
  askAgent,
  complete,
  emptyPicks,
  firstUnanswered,
  optionLabel,
  pickedText,
  pickOption,
  pickOther,
  waitingText,
  type AskPick,
} from '../world/ask';
import { h } from '../ui/dom';
import { focusQuestion, foldedRow, isSendKey, mark, moveIn, openQuestion, reveal, SEND_KEY, type StackLine } from './askStack';
import { zoomKey } from './keys';

/** An option's key cap: its digit, or a tick when a multi-select one is picked. */
const keyCap = (n: number, ticked: boolean): Node => mark(n, ticked);

/**
 * #57: an agent's structured question (Claude's AskUserQuestion, Codex's request_user_input) in the transcript view.
 * `AskCard` is the one you answer, pinned above the prompt box while the worker waits on it: its questions stacked
 * (askStack.ts: the open one with its options, the others folded to their answer), the options as rows with their key
 * cap (round: pick one, square: pick several) and description, "(Recommended)" as a quiet badge, a typed "Other"
 * answer, and Send, which goes only once every question has an answer (before that it takes you to the one missing). `askItem` is its entry in the timeline: what it asked and, from the transcript's result, what was
 * answered (here or in the terminal).
 *
 * States: pending → sending (the bridge drives the dialog) → gone once the bridge says it is resolved (the timeline
 * shows the answer); a refusal leaves it pending with the reason. It never says "answered" before the bridge does.
 */

export type AskResult = { ok: true; resolved: boolean } | { ok: false; code: string; message: string };

export interface AskCardHost {
  /** Sends `worker.answer_ask`. */
  answer(args: CommandArgs['worker.answer_ask']): Promise<AskResult>;
  toTerminal(): void;
  /** The keyboard back to the timeline (Esc in the card). */
  focusTimeline(): void;
  /** The card's height changed (the timeline keeps its bottom in view). */
  resized(): void;
}

const MAX_INPUT_JSON = 4000;

function inputJson(input: unknown): string {
  let json: string;
  try {
    json = typeof input === 'string' ? input : (JSON.stringify(input, null, 2) ?? '');
  } catch {
    json = String(input);
  }
  return json.length > MAX_INPUT_JSON ? `${json.slice(0, MAX_INPUT_JSON)}\n…` : json;
}

/** The raw call, collapsed ("Input"). */
function inputDisclosure(input: unknown): HTMLElement | null {
  if (input === undefined || input === null) return null;
  const pre = h('pre', { class: 'tx-out tx-input-json' });
  const d = h('details', { class: 'tx-ask-input' }, h('summary', {}, 'Input'), pre);
  d.addEventListener('toggle', () => {
    if (d.open && !pre.textContent) pre.textContent = inputJson(input);
  });
  return d;
}

const OUTCOME: Record<string, string> = {
  declined: 'Dismissed without an answer',
  clarify: 'You asked to talk about it first',
  interrupted: 'Interrupted before an answer',
};

/** The timeline's entry for an ask call. */
export function askItem(it: TranscriptItem, card: TranscriptAsk): HTMLElement {
  const who = askAgent(card);
  const qs = Array.isArray(card.questions) ? card.questions : [];
  const row = h('li', { class: 'tx-item tx-ask-item', 'data-outcome': String(card.outcome ?? '') });
  const head = h('div', { class: 'tx-ask-item-head' }, h('span', { class: 'tx-ask-item-who' }, `${who} asked`));
  for (const q of qs) if (q.header) head.append(h('span', { class: 'tx-ask-chip' }, q.header));
  row.append(head);
  if (card.outcome === 'answered') {
    const lines = answeredLines(card);
    const list = h('ul', { class: 'tx-ask-answers', 'aria-label': 'You answered' });
    for (const l of lines) {
      list.append(
        h(
          'li',
          {},
          h('span', { class: 'tx-ask-dot', 'aria-hidden': 'true' }, '●'),
          h('span', { class: 'tx-ask-said' }, 'You answered: '),
          h('span', { class: 'tx-ask-q' }, l.question),
          h('span', { class: 'tx-ask-arrow', 'aria-hidden': 'true' }, ' → '),
          h('strong', { class: 'tx-ask-a' }, l.answer),
          l.notes ? h('span', { class: 'tx-ask-notes' }, ` (notes: ${l.notes})`) : null,
        ),
      );
    }
    if (!lines.length) list.append(h('li', {}, h('span', { class: 'tx-ask-said' }, 'Answered (nothing picked)')));
    row.append(list);
  } else {
    const list = h('ul', { class: 'tx-ask-asked' });
    for (const q of qs) list.append(h('li', {}, q.question));
    row.append(list);
    const note = card.outcome === 'pending' ? 'Waiting for your answer: it is pinned above the prompt box.' : (OUTCOME[String(card.outcome)] ?? String(card.outcome ?? ''));
    row.append(h('div', { class: `tx-ask-state tx-ask-state--${String(card.outcome)}` }, note));
  }
  const input = inputDisclosure(it.tool?.input);
  if (input) row.append(input);
  return row;
}

/** Where the keyboard goes once the card is drawn: the open question, Send, an option's key (`opt:2`), or the first. */
type FocusTo = 'q' | 'send' | 'first' | `opt:${number}`;

/** The pinned card. */
export class AskCard {
  readonly el: HTMLElement;
  /** The worker's ask now: the bridge's word, from its upserts (null: none). */
  private ask: Ask | null = null;
  /** The ask whose answer (or dismissal) is on its way: its response is about that one only. */
  private sent: Ask | null = null;
  /** An ask the bridge said is resolved while its upsert without it has not come yet: not shown again. */
  private gone: string | null = null;
  /** Whose picks `picks` are (a tool_use_id). */
  private picksFor: string | null = null;
  private picks: AskPick[] = [];
  /** The open question (-1: every one folded, all answered: Send is next). */
  private active = 0;
  /** The open question got an Enter on itself: it says how to pick, louder. */
  private nudged = false;
  /** Send was tried without this question's answer: it flashes once. */
  private flash = -1;
  private focusTo: FocusTo | null = null;
  private note: { text: string; error: boolean } | null = null;
  private since = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private waitEl: HTMLElement | null = null;
  private otherEl: HTMLInputElement | null = null;

  constructor(private readonly host: AskCardHost) {
    this.el = h('section', { class: 'tx-ask', hidden: true, 'aria-label': 'Question' });
  }

  /**
   * The ask the card shows: the worker's, else (answered meanwhile, the ack not here yet) the one being sent, which
   * says how it went once its ack comes. Never one the bridge said is resolved.
   */
  private get shownAsk(): Ask | null {
    if (this.ask) return this.ask.tool_use_id === this.gone ? null : this.ask;
    return this.sent;
  }

  /** The shown ask's answer is on its way (the card waits for its ack). */
  private get sending(): boolean {
    return !!this.sent && this.shownAsk?.tool_use_id === this.sent.tool_use_id;
  }

  get shown(): boolean {
    return !!this.shownAsk;
  }

  get toolUseId(): string | null {
    return this.shownAsk?.tool_use_id ?? null;
  }

  /** The worker's ask now (null: none). A new one starts afresh; the same one keeps what you picked. */
  set(ask: Ask | null): void {
    this.ask = ask;
    if (ask?.tool_use_id !== this.gone) this.gone = null;
    this.sync();
  }

  /** Picks follow the shown ask: another one starts with none. */
  private sync(): void {
    const a = this.shownAsk;
    const id = a?.tool_use_id ?? null;
    if (id !== this.picksFor) {
      this.picksFor = id;
      this.picks = a ? emptyPicks(a) : [];
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

  /** The keyboard on the card: the open question's picked option, else its first; all folded, Send. */
  focus(): void {
    const q = this.el.querySelector<HTMLElement>('.tx-ask-q');
    const b = q
      ? (q.querySelector<HTMLElement>('button.tx-ask-opt[aria-checked="true"]:not(:disabled)') ?? q.querySelector<HTMLElement>('button.tx-ask-opt:not(:disabled)'))
      : this.el.querySelector<HTMLElement>('.tx-ask-send:not(:disabled)');
    b?.focus({ preventScroll: true });
    if (b) reveal(b);
  }

  // --- keys --------------------------------------------------------------------------------------------------

  /**
   * A key on the transcript (not in a text box): digits pick on the open question, ← → open the question before /
   * after, Enter takes the keyboard to the card (it never sends from here), Ctrl/⌘+Enter sends. True: it was the
   * card's. On the card itself (`inCard`) also: ↑ ↓ move through the open question's options, Enter on the question
   * itself only says how to pick, and Esc goes back to the timeline. Enter / Space on an option, a folded question,
   * Dismiss or Send are that button's (its click): an option is picked, never sent.
   */
  key(e: KeyboardEvent, inCard = false): boolean {
    const a = this.shownAsk;
    if (!a) return false;
    if (isSendKey(e)) {
      if (!this.sent) this.trySend();
      return true;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (inCard && e.key === 'Escape' && !e.shiftKey) {
      this.host.focusTimeline();
      return true;
    }
    if (this.sending) return false; // nothing to pick while it is sent
    const t = e.target as HTMLElement | null;
    const open = this.el.querySelector<HTMLElement>('.tx-ask-q');
    const q = a.questions[this.active];
    if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
      if (!q) return false;
      const n = Number(e.key);
      if (n <= q.options.length) this.choose(n);
      else if (n === q.options.length + 1 && q.other) this.focusOther();
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
    const n = a.questions.length;
    if (n > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const back = e.key === 'ArrowLeft';
      const from = this.active >= 0 ? this.active : back ? n : -1;
      const to = from + (back ? -1 : 1);
      if (to >= 0 && to < n) this.openAt(to);
      return true;
    }
    if (!inCard && e.key === 'Enter' && !e.shiftKey) {
      this.focusTo = this.active >= 0 ? 'q' : 'send';
      this.render();
      return true;
    }
    return false;
  }

  private choose(n: number): void {
    const a = this.shownAsk;
    if (!a || this.sending) return;
    const q = a.questions[this.active];
    if (!q) return;
    this.picks = pickOption(a, this.picks, this.active, n);
    this.note = null;
    this.nudged = false;
    if (q.multi) {
      // Several may be picked: it stays, the keyboard on the option ticked.
      this.focusTo = `opt:${n}`;
      this.render();
      return;
    }
    this.advance();
  }

  /** The open question is answered: on to the next one without an answer (the keyboard on it), else to Send. */
  private advance(): void {
    const a = this.shownAsk;
    if (!a) return;
    const n = a.questions.length;
    let next = -1;
    for (let k = 1; k <= n && next < 0; k++) {
      const j = (this.active + k) % n;
      if (!answered(a, this.picks, j)) next = j;
    }
    if (next >= 0) {
      this.active = next;
      this.focusTo = 'q';
    } else {
      if (n > 1) this.active = -1; // all folded: what you answered, one line each, over Send
      this.focusTo = 'send';
    }
    this.nudged = false;
    this.render();
  }

  /** Opens question i, the keyboard on its picked option (or its first). */
  private openAt(i: number): void {
    this.active = i;
    this.nudged = false;
    this.focusTo = 'first';
    this.render();
  }

  private focusOther(): void {
    const a = this.shownAsk;
    if (!a) return;
    if (this.picks[this.active]?.other === null) {
      this.picks = pickOther(a, this.picks, this.active, '');
      this.render();
    }
    this.otherEl?.focus({ preventScroll: true });
    if (this.otherEl) reveal(this.otherEl);
  }

  /** Send (its click, Ctrl/⌘+Enter): sent once every question has an answer, else to the first one without. */
  private trySend(): void {
    const a = this.shownAsk;
    if (!a || this.sent) return;
    const gap = firstUnanswered(a, this.picks);
    if (gap >= 0) {
      this.note = { text: `Answer “${a.questions[gap]?.header || `question ${gap + 1}`}” first.`, error: false };
      this.active = gap;
      this.flash = gap;
      this.nudged = false;
      this.focusTo = 'q';
      this.render();
      return;
    }
    void this.submit();
  }

  private async submit(): Promise<void> {
    const a = this.shownAsk;
    if (!a || this.sent) return;
    const args = answerAskArgs('', a, this.picks);
    if (!args) return;
    const r = await this.send(a, args);
    if (!r) return;
    if (r.ok) this.note = { text: `Sent. ${askAgent(a)} has not recorded it yet: look at the terminal if this stays.`, error: false };
    else if (r.code === 'stale') this.note = { text: 'That question was answered or changed meanwhile.', error: true };
    else this.note = { text: r.message || 'The answer did not go through.', error: true };
    this.render();
  }

  /**
   * Sends ask a's answer (or dismissal) and waits for its ack, which is about a only: the worker's ask may have gone or
   * changed meanwhile (its upserts are applied as they come), and then the card shows what it has now. The result, for
   * the caller to say, when a is still the one shown and the bridge did not resolve it; null otherwise.
   */
  private async send(a: Ask, args: CommandArgs['worker.answer_ask']): Promise<AskResult | null> {
    this.sent = a;
    this.note = null;
    this.render();
    let r: AskResult;
    try {
      r = await this.host.answer(args);
    } catch (e) {
      r = { ok: false, code: 'internal', message: e instanceof Error ? e.message : String(e) };
    }
    if (this.sent === a) this.sent = null;
    if (this.ask?.tool_use_id !== a.tool_use_id) {
      // Answered in the terminal, or another question now: the card shows what the worker has.
      this.sync();
      if (this.ask && !(r.ok && r.resolved)) {
        this.note = { text: 'The question changed meanwhile: this is the new one.', error: false };
        this.render();
      }
      return null;
    }
    if (r.ok && r.resolved) {
      // The bridge saw the answer in the transcript: the card goes (its upsert without the ask may still be on its way), the timeline has it.
      this.gone = a.tool_use_id;
      this.sync();
      this.host.focusTimeline();
      return null;
    }
    return r;
  }

  /** The Other text box: Enter takes the text and moves on (never sends), ↑ ↓ leave it for the options around it. */
  private onOtherKey(e: KeyboardEvent, input: HTMLInputElement): void {
    if (zoomKey(e)) return; // #59: the text zoom works from here too
    e.stopPropagation(); // what is typed here is the answer's, not the game's or the timeline's
    const a = this.shownAsk;
    if (!a) return;
    if (isSendKey(e)) {
      e.preventDefault();
      this.trySend();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (!input.value.trim()) {
        this.picks = pickOther(a, this.picks, this.active, null);
        this.paintPicks();
      }
      this.host.focusTimeline();
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      if (answered(a, this.picks, this.active)) this.advance();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveIn(input.closest<HTMLElement>('.tx-ask-q'), input, e.key === 'ArrowDown' ? 1 : -1);
    }
  }

  private async dismiss(): Promise<void> {
    const a = this.shownAsk;
    if (!a || this.sent) return;
    const r = await this.send(a, { id: '', tool_use_id: a.tool_use_id, cancel: true });
    if (!r) return;
    this.note = r.ok ? { text: 'Dismissed. It has not been recorded yet: look at the terminal if this stays.', error: false } : { text: r.code === 'stale' ? 'That question was answered or changed meanwhile.' : r.message, error: true };
    this.render();
  }

  // --- drawing -----------------------------------------------------------------------------------------------

  private line(a: Ask, i: number): StackLine {
    const q = a.questions[i] as AskQuestion;
    const done = answered(a, this.picks, i);
    return { header: q.header || `Question ${i + 1}`, question: q.question, done, answer: done ? pickedText(a, this.picks, i) : '' };
  }

  private render(): void {
    const a = this.shownAsk;
    this.el.hidden = !a;
    if (!a) {
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
    const focusedOther = !!this.otherEl && focused === this.otherEl;
    const sending = this.sending;
    // Another answer still on its way (this ask came meanwhile): this one waits for its ack.
    const busy = sending || !!this.sent;
    const who = askAgent(a);
    const several = a.questions.length > 1;
    if (!several) this.active = 0;
    this.el.setAttribute('aria-busy', String(sending));
    this.el.dataset.phase = sending ? 'sending' : 'pending';
    this.since = a.since;
    this.waitEl = h('span', { class: 'tx-ask-wait' }, waitingText(a.since, Date.now()));
    const top = h(
      'div',
      { class: 'tx-ask-top' },
      h('span', { class: 'tx-banner-tag tx-ask-tag' }, `${who} asks`),
      this.waitEl,
      h('span', { class: 'tx-spacer' }),
      h('button', { class: 'tx-link tx-to-term', disabled: sending, onclick: () => this.host.toTerminal() }, 'Answer in the terminal'),
    );
    this.otherEl = null;
    const body = h('div', { class: 'tx-ask-body' });
    if (several) {
      const stack = h('div', { class: 'tx-ask-stack' });
      a.questions.forEach((_, i) => stack.append(i === this.active ? this.openSection(a, i, sending) : foldedRow(i, this.line(a, i), () => this.openAt(i), sending)));
      body.append(stack);
    } else body.append(this.openSection(a, 0, sending));
    const ready = complete(a, this.picks);
    const send = h(
      'button',
      {
        class: `tx-ask-send${ready ? '' : ' is-blocked'}`,
        'data-key': 'send',
        disabled: busy,
        'aria-disabled': busy ? null : String(!ready),
        onclick: () => this.trySend(),
      },
      sending ? 'Sending…' : several ? 'Send answers' : 'Send answer',
      sending ? null : h('kbd', { class: 'tx-ask-kbd' }, SEND_KEY),
    );
    const q = a.questions[this.active];
    const pickKeys = q ? `1–${q.options.length + (q.other ? 1 : 0)} or ↑↓ Enter pick · ` : '';
    const keys = `${pickKeys}${several ? '← → question · ' : ''}${SEND_KEY} send · Esc back`;
    const foot = h(
      'div',
      { class: 'tx-ask-foot' },
      h('span', { class: 'tx-ask-hint' }, h('span', { class: 'tx-ask-hint-text' }, this.hint()), h('span', { class: 'tx-ask-keys' }, keys)),
      h('button', { class: 'tx-link tx-ask-dismiss', 'data-key': 'dismiss', disabled: busy, title: 'Esc on its dialog: the agent is told you declined', onclick: () => void this.dismiss() }, 'Dismiss'),
      send,
    );
    const parts: HTMLElement[] = [top, body, foot];
    if (this.note) parts.push(h('div', { class: `tx-ask-note${this.note.error ? ' is-error' : ''}`, role: this.note.error ? 'alert' : 'status' }, this.note.text));
    this.el.replaceChildren(...parts);
    this.flash = -1;
    this.tick();
    // Where the keyboard goes: where the card sent it (it moved on), else back where it was (redrawn under it), else
    // (the control it was on is gone) the open question's option. While it is sent its controls are off: the keyboard
    // goes back to the timeline, not to <body> (Esc there stands you up).
    const to = this.focusTo;
    this.focusTo = null;
    if (sending) {
      if (focused) this.host.focusTimeline();
    } else if (to) this.applyFocus(to);
    else if (focusedOther) this.el.querySelector<HTMLInputElement>('.tx-ask-other-input')?.focus({ preventScroll: true });
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

  /** Question i, open: its options, its Other, and (several questions, pick several) Done. */
  private openSection(a: Ask, i: number, sending: boolean): HTMLElement {
    const q = a.questions[i] as AskQuestion;
    const several = a.questions.length > 1;
    const pick = this.picks[i] as AskPick;
    const qid = 'tx-ask-q';
    const list = h('div', { class: `tx-ask-opts${q.multi ? ' is-multi' : ''}`, role: q.multi ? 'group' : 'radiogroup', 'aria-labelledby': qid });
    q.options.forEach((o, k) => {
      const n = k + 1;
      const on = pick.choices.includes(n);
      const l = optionLabel(o.label);
      list.append(
        h(
          'button',
          {
            class: `tx-ask-opt${on ? ' is-on' : ''}`,
            role: q.multi ? 'checkbox' : 'radio',
            'aria-checked': String(on),
            disabled: sending,
            'data-n': String(n),
            'data-key': `opt:${n}`,
            onclick: () => this.choose(n),
          },
          h('span', { class: 'tx-ask-key', 'aria-hidden': 'true' }, keyCap(n, on && q.multi)),
          h(
            'span',
            { class: 'tx-ask-opt-text' },
            h('span', { class: 'tx-ask-opt-label' }, l.text, l.recommended ? h('span', { class: 'tx-ask-rec' }, 'recommended') : null),
            o.description ? h('span', { class: 'tx-ask-opt-desc' }, o.description) : null,
            o.preview ? h('pre', { class: 'tx-ask-preview' }, o.preview) : null,
          ),
        ),
      );
    });
    if (q.other) {
      const n = q.options.length + 1;
      const on = pick.other !== null;
      const input = h('input', {
        class: 'tx-ask-other-input',
        type: q.secret ? 'password' : 'text',
        placeholder: q.multi ? 'Something else…' : 'Type your own answer…',
        'aria-label': 'Your own answer',
        maxlength: '4000',
        autocomplete: 'off',
        spellcheck: 'true',
        disabled: sending,
      }) as HTMLInputElement;
      input.value = pick.other ?? '';
      input.addEventListener('focus', () => {
        const a = this.shownAsk;
        if (a && this.picks[this.active]?.other === null) {
          this.picks = pickOther(a, this.picks, this.active, '');
          this.paintPicks();
        }
      });
      input.addEventListener('input', () => {
        const a = this.shownAsk;
        if (!a) return;
        this.picks = pickOther(a, this.picks, this.active, input.value);
        this.note = null;
        this.paintPicks();
      });
      input.addEventListener('keydown', (e) => this.onOtherKey(e, input));
      this.otherEl = input;
      list.append(
        h(
          'label',
          { class: `tx-ask-opt tx-ask-other${on ? ' is-on' : ''}`, 'data-n': String(n) },
          h('span', { class: 'tx-ask-key', 'aria-hidden': 'true' }, keyCap(n, on && q.multi)),
          h('span', { class: 'tx-ask-opt-text' }, h('span', { class: 'tx-ask-opt-label' }, 'Other'), input),
        ),
      );
    }
    const done =
      q.multi && several
        ? h('button', { class: 'tx-ask-done', 'data-key': 'done', disabled: sending, onclick: () => this.advance() }, 'Done, next question', h('span', { 'aria-hidden': 'true' }, ' →'))
        : null;
    return openQuestion(
      { index: i, line: this.line(a, i), several, kind: q.multi ? 'pick several' : null, options: q.options.length, nudged: this.nudged, flash: this.flash === i, qid },
      list,
      done,
    );
  }

  /** What the foot says: what is left to answer, or that it is being sent. */
  private hint(): string {
    const a = this.shownAsk;
    if (!a) return '';
    if (this.sending) return `${askAgent(a)}’s dialog is being answered in its terminal…`;
    if (this.sent) return 'The answer to the question before is still on its way…';
    const left = a.questions.filter((_, i) => !answered(a, this.picks, i)).length;
    if (!left) return a.questions.length > 1 ? 'All answered: Enter on Send' : 'Ready: Enter on Send';
    if (a.questions.length > 1) return `${left} of ${a.questions.length} still to answer`;
    return a.questions[0]?.multi ? 'Pick one or more' : 'Pick one';
  }

  /** Repaints what the picks show without redrawing the text box you type in. */
  private paintPicks(): void {
    const a = this.shownAsk;
    if (!a || this.active < 0) return;
    const pick = this.picks[this.active] as AskPick;
    const q = a.questions[this.active] as AskQuestion;
    const other = this.el.querySelector('.tx-ask-other');
    const on = pick.other !== null;
    other?.classList.toggle('is-on', on);
    const key = other?.querySelector('.tx-ask-key');
    key?.replaceChildren(keyCap(q.options.length + 1, on && q.multi));
    if (!q.multi) {
      for (const b of this.el.querySelectorAll<HTMLElement>('button.tx-ask-opt')) {
        const n = Number(b.dataset.n);
        const sel = pick.choices.includes(n);
        b.classList.toggle('is-on', sel);
        b.setAttribute('aria-checked', String(sel));
      }
    }
    const ready = complete(a, this.picks);
    const send = this.el.querySelector<HTMLButtonElement>('.tx-ask-send');
    if (send && !this.sent) {
      send.classList.toggle('is-blocked', !ready);
      send.setAttribute('aria-disabled', String(!ready));
    }
    const done = answered(a, this.picks, this.active);
    const m = this.el.querySelector('.tx-ask-q-head .tx-ask-mark');
    m?.classList.toggle('is-done', done);
    m?.replaceChildren(mark(this.active + 1, done));
    const hint = this.el.querySelector('.tx-ask-hint-text');
    if (hint) hint.textContent = this.hint();
  }

  private tick(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      if (!this.shownAsk || !this.waitEl) return;
      this.waitEl.textContent = waitingText(this.since, Date.now());
    }, 1000);
  }
}
