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
import { h, icon } from '../ui/dom';
import { zoomKey } from './keys';

const CHECK = '<path d="M5.5 12.5l4 4 9-9"/>';
/** An option's key cap: its digit, or a tick when a multi-select one is picked. */
const keyCap = (n: number, ticked: boolean): Node => (ticked ? icon(CHECK) : document.createTextNode(String(n)));

/**
 * #57: an agent's structured question (Claude's AskUserQuestion, Codex's request_user_input) in the transcript view.
 * `AskCard` is the one you answer, pinned above the prompt box while the worker waits on it: its header chips as tabs
 * (several questions), the question, the options as rows with their key cap (round: pick one, square: pick several)
 * and description, "(Recommended)" as a quiet badge, a typed "Other" answer, and Send — off until every question has
 * an answer. `askItem` is its entry in the timeline: what it asked and, from the transcript's result, what was
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
  private active = 0;
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
      this.note = null;
    }
    this.render();
  }

  destroy(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.el.remove();
  }

  focus(): void {
    // The picked option, else the first (a selector list would take the first in the document either way).
    const b = this.el.querySelector<HTMLElement>('button.tx-ask-opt[aria-checked="true"]:not(:disabled)') ?? this.el.querySelector<HTMLElement>('button.tx-ask-opt:not(:disabled)');
    b?.focus({ preventScroll: true });
  }

  // --- keys --------------------------------------------------------------------------------------------------

  /**
   * A key on the transcript (not in a text box): digits pick, Tab / ← → change question, Enter sends. True: it was the
   * card's. On the card itself (`inCard`: an option, a tab, a button) Esc goes back to the timeline, and Enter on an
   * option or a tab sends too (Space picks the focused option, Enter on Dismiss or Send is that button's).
   */
  key(e: KeyboardEvent, inCard = false): boolean {
    const a = this.shownAsk;
    if (!a || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (inCard && e.key === 'Escape' && !e.shiftKey) {
      this.host.focusTimeline();
      return true;
    }
    if (inCard && e.key === 'Enter' && !(e.target as HTMLElement | null)?.closest?.('.tx-ask-opt, .tx-ask-tab')) return false;
    if (this.sending) return inCard && e.key === 'Enter'; // nothing to pick while it is sent
    const q = a.questions[this.active];
    if (!q) return false;
    const several = a.questions.length > 1;
    if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
      const n = Number(e.key);
      if (n <= q.options.length) this.choose(n);
      else if (n === q.options.length + 1 && q.other) this.focusOther();
      else return false;
      return true;
    }
    if (several && (e.key === 'Tab' || e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const back = e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey);
      this.go((this.active + (back ? a.questions.length - 1 : 1)) % a.questions.length);
      return true;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      this.submitOrNext();
      return true;
    }
    return false;
  }

  private choose(n: number): void {
    const a = this.shownAsk;
    if (!a || this.sending) return;
    const q = a.questions[this.active] as AskQuestion;
    this.picks = pickOption(a, this.picks, this.active, n);
    this.note = null;
    // A single-select answer moves on to the next question without one, like the dialog does.
    const next = !q.multi && a.questions.length > 1 ? firstUnanswered(a, this.picks) : -1;
    this.render(next >= 0 ? next : null);
  }

  private go(i: number): void {
    this.active = i;
    this.render();
    this.focus();
  }

  private focusOther(): void {
    const a = this.shownAsk;
    if (!a) return;
    if (this.picks[this.active]?.other === null) {
      this.picks = pickOther(a, this.picks, this.active, '');
      this.render();
    }
    this.otherEl?.focus({ preventScroll: true });
  }

  private submitOrNext(): void {
    const a = this.shownAsk;
    if (!a) return;
    const gap = firstUnanswered(a, this.picks);
    if (gap >= 0) {
      this.note = { text: `Answer “${a.questions[gap]?.header || `question ${gap + 1}`}” first.`, error: false };
      this.go(gap);
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

  private onOtherKey(e: KeyboardEvent, input: HTMLInputElement): void {
    if (zoomKey(e)) return; // #59: the text zoom works from here too
    e.stopPropagation(); // what is typed here is the answer's, not the game's or the timeline's
    const a = this.shownAsk;
    if (!a) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!input.value.trim()) {
        this.picks = pickOther(a, this.picks, this.active, null);
        this.paintPicks();
      }
      this.host.focusTimeline();
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      this.submitOrNext();
    } else if (e.key === 'Tab' && a.questions.length > 1) {
      e.preventDefault();
      this.go((this.active + (e.shiftKey ? a.questions.length - 1 : 1)) % a.questions.length);
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

  private render(goTo: number | null = null): void {
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
    if (goTo !== null) this.active = goTo;
    const hadFocus = this.el.contains(document.activeElement);
    const focusedOther = !!this.otherEl && document.activeElement === this.otherEl;
    const q = a.questions[this.active] as AskQuestion;
    const sending = this.sending;
    // Another answer still on its way (this ask came meanwhile): this one waits for its ack.
    const busy = sending || !!this.sent;
    const who = askAgent(a);
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
    const parts: HTMLElement[] = [top];
    if (a.questions.length > 1) {
      const tabs = h('div', { class: 'tx-ask-tabs', role: 'tablist', 'aria-label': 'Questions' });
      a.questions.forEach((qq, i) => {
        const done = answered(a, this.picks, i);
        tabs.append(
          h(
            'button',
            {
              class: `tx-ask-tab${i === this.active ? ' is-active' : ''}${done ? ' is-done' : ''}`,
              role: 'tab',
              'aria-selected': String(i === this.active),
              title: done ? `${qq.question} → ${pickedText(a, this.picks, i)}` : qq.question,
              onclick: () => this.go(i),
            },
            h('span', { class: 'tx-ask-tab-mark', 'aria-hidden': 'true' }, keyCap(i + 1, done)),
            qq.header || `Question ${i + 1}`,
          ),
        );
      });
      parts.push(tabs);
    } else if (q.header) {
      parts.push(h('div', { class: 'tx-ask-tabs' }, h('span', { class: 'tx-ask-chip' }, q.header)));
    }
    const body = h('div', { class: 'tx-ask-body' }, h('p', { class: 'tx-ask-question', id: 'tx-ask-q' }, q.question));
    parts.push(body);
    const pick = this.picks[this.active] as AskPick;
    const list = h('div', { class: `tx-ask-opts${q.multi ? ' is-multi' : ''}`, role: q.multi ? 'group' : 'radiogroup', 'aria-labelledby': 'tx-ask-q' });
    q.options.forEach((o, i) => {
      const n = i + 1;
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
    this.otherEl = null;
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
    body.append(list);
    const ready = complete(a, this.picks);
    const send = h(
      'button',
      { class: 'tx-ask-send', disabled: !ready || busy, onclick: () => void this.submit() },
      sending ? 'Sending…' : a.questions.length > 1 ? 'Send answers' : 'Send answer',
    );
    const keys = `1–${q.options.length + (q.other ? 1 : 0)} pick${a.questions.length > 1 ? ' · Tab next question' : ''} · Enter send · Esc back`;
    parts.push(
      h(
        'div',
        { class: 'tx-ask-foot' },
        h('span', { class: 'tx-ask-hint' }, h('span', { class: 'tx-ask-hint-text' }, this.hint()), h('span', { class: 'tx-ask-keys' }, keys)),
        h('button', { class: 'tx-link tx-ask-dismiss', disabled: busy, title: 'Esc on its dialog: the agent is told you declined', onclick: () => void this.dismiss() }, 'Dismiss'),
        send,
      ),
    );
    if (this.note) parts.push(h('div', { class: `tx-ask-note${this.note.error ? ' is-error' : ''}`, role: this.note.error ? 'alert' : 'status' }, this.note.text));
    this.el.replaceChildren(...parts);
    this.showActiveTab();
    this.tick();
    // Redrawn under the keyboard: it stays in the card (the text box, else the question's options).
    // While it is sent its controls are off: the keyboard goes back to the timeline, not to <body> (Esc there stands you up).
    if (focusedOther && !sending) this.otherEl?.focus({ preventScroll: true });
    else if (hadFocus) {
      this.focus();
      if (!this.el.contains(document.activeElement)) this.host.focusTimeline();
    }
    this.host.resized();
  }

  /** On a narrow screen the tabs scroll sideways: the active one is brought into the strip. */
  private showActiveTab(): void {
    const strip = this.el.querySelector<HTMLElement>('.tx-ask-tabs');
    const tab = strip?.querySelector<HTMLElement>('.tx-ask-tab.is-active');
    if (!strip || !tab || strip.scrollWidth <= strip.clientWidth) return;
    const s = strip.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    strip.scrollLeft += t.left - s.left - (s.width - t.width) / 2;
  }

  /** What the foot says: what is left to answer, or that it is being sent. */
  private hint(): string {
    const a = this.shownAsk;
    if (!a) return '';
    if (this.sending) return `${askAgent(a)}’s dialog is being answered in its terminal…`;
    if (this.sent) return 'The answer to the question before is still on its way…';
    const left = a.questions.filter((_, i) => !answered(a, this.picks, i)).length;
    if (!left) return a.questions.length > 1 ? 'All answered: send them' : 'Ready to send';
    if (a.questions.length > 1) return `${left} of ${a.questions.length} still to answer`;
    return a.questions[0]?.multi ? 'Pick one or more' : 'Pick one';
  }

  /** Repaints what the picks show without redrawing the text box you type in. */
  private paintPicks(): void {
    const a = this.shownAsk;
    if (!a) return;
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
    if (send) send.disabled = !ready || !!this.sent;
    this.el.querySelectorAll('.tx-ask-tab').forEach((t, i) => {
      const done = answered(a, this.picks, i);
      t.classList.toggle('is-done', done);
      t.querySelector('.tx-ask-tab-mark')?.replaceChildren(keyCap(i + 1, done));
    });
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
