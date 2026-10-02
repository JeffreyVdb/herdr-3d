import type { CommandArgs, Followup, FollowupQuestion } from '../net/protocol';
import { waitingText } from '../world/ask';
import {
  answeredFollowup,
  answerFollowupArgs,
  emptyFollowupPicks,
  followupAnswers,
  pickValue,
  setText,
  YES_NO,
  type FollowupPick,
} from '../world/followup';
import { h, icon } from '../ui/dom';
import { zoomKey } from './keys';

const CHECK = '<path d="M5.5 12.5l4 4 9-9"/>';
const keyCap = (n: number, on: boolean): Node => (on ? icon(CHECK) : document.createTextNode(String(n)));

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
 * stays on, and a prompt typed there clears it. One tab per question; yes/no takes Yes or No and a note, a choice
 * its options or Other, an open question a text. Send answers sends what is answered as one prompt (the rest left
 * out); Dismiss drops it. Its look is the ask card's (#57), drawn dashed: inferred, not a dialog the agent waits on.
 */
export class FollowupCard {
  readonly el: HTMLElement;
  private followup: Followup | null = null;
  /** The turn whose answers (or dismissal) are on their way. */
  private sent: string | null = null;
  /** A turn the bridge acked as answered or dismissed: not shown again while its upsert is on its way. */
  private gone: string | null = null;
  private picksFor: string | null = null;
  private picks: FollowupPick[] = [];
  private active = 0;
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
    const b =
      this.el.querySelector<HTMLElement>('button.tx-ask-opt[aria-checked="true"]:not(:disabled)') ??
      this.el.querySelector<HTMLElement>('button.tx-ask-opt:not(:disabled), .tx-fu-text:not(:disabled)');
    b?.focus({ preventScroll: true });
  }

  // --- keys --------------------------------------------------------------------------------------------------

  /**
   * A key on the transcript (not in a text box): digits pick, Tab / ← → change question, Enter sends. On the card
   * itself (`inCard`) Esc goes back to the timeline. True: it was the card's.
   */
  key(e: KeyboardEvent, inCard = false): boolean {
    const f = this.shownFollowup;
    if (!f || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (inCard && e.key === 'Escape' && !e.shiftKey) {
      this.host.focusTimeline();
      return true;
    }
    if (inCard && e.key === 'Enter' && !(e.target as HTMLElement | null)?.closest?.('.tx-ask-opt, .tx-ask-tab')) return false;
    if (this.sending) return inCard && e.key === 'Enter';
    const q = f.questions[this.active];
    if (!q) return false;
    const several = f.questions.length > 1;
    if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
      const vals = valuesOf(q);
      const n = Number(e.key);
      if (n <= vals.length) this.choose(vals[n - 1] as string);
      else if (n === vals.length + 1 && q.kind !== 'open') this.focusText();
      else return false;
      return true;
    }
    if (several && (e.key === 'Tab' || e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const back = e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey);
      this.go((this.active + (back ? f.questions.length - 1 : 1)) % f.questions.length);
      return true;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      void this.submit();
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
    // A pick moves on to the next question without an answer, like the ask card.
    const next = this.picks[this.active]?.value && f.questions.length > 1 ? f.questions.findIndex((_, i) => i > this.active && !answeredFollowup(f, this.picks, i)) : -1;
    this.render(next >= 0 ? next : null);
  }

  private go(i: number): void {
    this.active = i;
    this.render();
    this.focus();
  }

  private focusText(): void {
    this.el.querySelector<HTMLElement>('.tx-fu-text')?.focus({ preventScroll: true });
  }

  private async submit(): Promise<void> {
    const f = this.shownFollowup;
    if (!f || this.sent) return;
    const args = answerFollowupArgs('', f, this.picks);
    if (!args) {
      this.note = { text: 'Answer at least one question first.', error: false };
      this.render();
      return;
    }
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

  private onTextKey(e: KeyboardEvent, multiline: boolean): void {
    if (zoomKey(e)) return; // #59: the text zoom works from here too
    e.stopPropagation(); // what is typed here is the answer's, not the game's or the timeline's
    const f = this.shownFollowup;
    if (!f) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.host.focusTimeline();
    } else if (e.key === 'Enter' && !e.isComposing && (!multiline || !e.shiftKey)) {
      e.preventDefault();
      void this.submit();
    } else if (e.key === 'Tab' && f.questions.length > 1) {
      e.preventDefault();
      this.go((this.active + (e.shiftKey ? f.questions.length - 1 : 1)) % f.questions.length);
    }
  }

  // --- drawing -----------------------------------------------------------------------------------------------

  private render(goTo: number | null = null): void {
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
    if (goTo !== null) this.active = goTo;
    const hadFocus = this.el.contains(document.activeElement);
    const focusedText = document.activeElement?.classList.contains('tx-fu-text') ?? false;
    const q = f.questions[this.active] as FollowupQuestion;
    const pick = this.picks[this.active] as FollowupPick;
    const sending = this.sending;
    this.el.setAttribute('aria-busy', String(sending));
    this.el.dataset.phase = sending ? 'sending' : 'pending';
    this.el.dataset.source = f.source;
    this.waitEl = h('span', { class: 'tx-ask-wait' }, waitingText(f.at, Date.now()));
    const top = h(
      'div',
      { class: 'tx-ask-top' },
      h('span', { class: 'tx-banner-tag tx-ask-tag' }, f.questions.length > 1 ? `${f.questions.length} open questions` : 'Open question'),
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
    const parts: HTMLElement[] = [top];
    if (f.questions.length > 1) {
      const tabs = h('div', { class: 'tx-ask-tabs', role: 'tablist', 'aria-label': 'Questions' });
      f.questions.forEach((qq, i) => {
        const done = answeredFollowup(f, this.picks, i);
        tabs.append(
          h(
            'button',
            {
              class: `tx-ask-tab${i === this.active ? ' is-active' : ''}${done ? ' is-done' : ''}`,
              role: 'tab',
              'aria-selected': String(i === this.active),
              title: qq.question,
              onclick: () => this.go(i),
            },
            h('span', { class: 'tx-ask-tab-mark', 'aria-hidden': 'true' }, keyCap(i + 1, done)),
            `Question ${i + 1}`,
          ),
        );
      });
      parts.push(tabs);
    }
    const qid = `tx-fu-q-${f.turn_id}`;
    const body = h('div', { class: 'tx-ask-body' });
    if (f.source === 'fallback' && f.tail) {
      body.append(h('blockquote', { class: 'tx-fu-tail', 'aria-label': 'The end of the agent’s message' }, f.tail));
    }
    body.append(h('p', { class: 'tx-ask-question', id: qid }, f.source === 'fallback' ? 'The agent asked you something. Your answer goes back as a prompt.' : q.question));
    const vals = valuesOf(q);
    let list: HTMLElement | null = null;
    if (vals.length) {
      const opts = h('div', { class: 'tx-ask-opts', role: 'radiogroup', 'aria-labelledby': qid });
      list = opts;
      vals.forEach((v, i) => {
        const on = pick.value === v;
        opts.append(
          h(
            'button',
            { class: `tx-ask-opt${on ? ' is-on' : ''}`, role: 'radio', 'aria-checked': String(on), disabled: sending, 'data-n': String(i + 1), onclick: () => this.choose(v) },
            h('span', { class: 'tx-ask-key', 'aria-hidden': 'true' }, String(i + 1)),
            h('span', { class: 'tx-ask-opt-text' }, h('span', { class: 'tx-ask-opt-label' }, v)),
          ),
        );
      });
      body.append(opts);
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
    else body.append(textRow);
    parts.push(body);
    const ready = followupAnswers(f, this.picks).length > 0;
    const send = h('button', { class: 'tx-ask-send', disabled: !ready || !!this.sent, onclick: () => void this.submit() }, sending ? 'Sending…' : f.questions.length > 1 ? 'Send answers' : 'Send answer');
    const pickKeys = vals.length ? `1–${vals.length + (q.kind === 'choice' ? 1 : 0)} pick · ` : '';
    const keys = `${pickKeys}${f.questions.length > 1 ? 'Tab next question · ' : ''}Enter send · Esc back`;
    parts.push(
      h(
        'div',
        { class: 'tx-ask-foot' },
        h('span', { class: 'tx-ask-hint' }, h('span', { class: 'tx-ask-hint-text' }, this.hint()), h('span', { class: 'tx-ask-keys' }, keys)),
        h('button', { class: 'tx-link tx-ask-dismiss', disabled: !!this.sent, title: 'Drop these questions: nothing is sent to the agent', onclick: () => void this.dismiss() }, 'Dismiss'),
        send,
      ),
    );
    if (this.note) parts.push(h('div', { class: `tx-ask-note${this.note.error ? ' is-error' : ''}`, role: this.note.error ? 'alert' : 'status' }, this.note.text));
    this.el.replaceChildren(...parts);
    this.tick();
    if (focusedText && !sending) (this.el.querySelector('.tx-fu-text') as HTMLElement | null)?.focus({ preventScroll: true });
    else if (hadFocus) {
      this.focus();
      if (!this.el.contains(document.activeElement)) this.host.focusTimeline();
    }
    this.host.resized();
  }

  /** What the foot says: what is answered, or that it is being sent. */
  private hint(): string {
    const f = this.shownFollowup;
    if (!f) return '';
    if (this.sending) return 'Sending your answers as a prompt…';
    const n = followupAnswers(f, this.picks).length;
    const all = f.questions.length;
    if (all === 1) return n ? 'Ready to send' : 'Not answered yet';
    if (!n) return `None of ${all} answered yet`;
    return n === all ? 'All answered: send them' : `${n} of ${all} answered: the rest are left out`;
  }

  /** Repaints the picks without redrawing the text box you type in. */
  private paint(): void {
    const f = this.shownFollowup;
    if (!f) return;
    const pick = this.picks[this.active] as FollowupPick;
    for (const b of this.el.querySelectorAll<HTMLElement>('button.tx-ask-opt')) {
      const on = b.querySelector('.tx-ask-opt-label')?.textContent === pick.value;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
    }
    this.el.querySelector('.tx-ask-other')?.classList.toggle('is-on', pick.value === null && !!pick.text.trim());
    const send = this.el.querySelector<HTMLButtonElement>('.tx-ask-send');
    if (send) send.disabled = !followupAnswers(f, this.picks).length || !!this.sent;
    this.el.querySelectorAll('.tx-ask-tab').forEach((t, i) => {
      const done = answeredFollowup(f, this.picks, i);
      t.classList.toggle('is-done', done);
      t.querySelector('.tx-ask-tab-mark')?.replaceChildren(keyCap(i + 1, done));
    });
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
