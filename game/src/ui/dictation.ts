import type { HireInterpretation } from '../net/protocol';
import { floorList, floorRow, type FloorItem, type FloorRow, type FloorSource } from '../world/palette';
import { barKey, FLOOR_QUESTION } from './dictationModel';
import { backdropPolicy } from './dismiss';
import { h, icon, ICON } from './dom';
import { reviewKey } from './secretsFlow';
import type { CardSecrets } from '../laptop/askStack';
import { listKey, paintActiveRow, wrapIndex } from './listbox';
import './credits.css';
import './palette.css';
import './dictation.css';

/**
 * #213 (phase 4 of #209): the dictation bar. A modal `<dialog>` with one `<textarea>` that takes what dictation software
 * types or pastes into it (Wispr Flow pastes: a real Ctrl/⌘+V), and Enter sends it to the interpreter (`hire.interpret`,
 * through the game). It is the palette's input (ui/palette.ts: a modal, the field focused, its keys kept from the game,
 * the opener's focus restored on Esc) without the palette's matching: dictated prose never runs a command.
 *
 * The field is one element for the bar's life: it is never disabled, made read-only or rebuilt, whatever the bar says
 * beside it, so a paste or keystrokes that are still arriving land in it. Its value is whatever `input` left there.
 * Enter sends (an IME composing a word keeps it: `barKey`); Shift+Enter is a new line. Another Enter while an answer is
 * on its way does nothing: one request at a time.
 *
 * The game answers each send (`DictationHost.submit`): the bar closed for the review (`done`), a line to show with the
 * text kept (`say`: "Not supported yet.", "Your intent is unclear.", an error), or a hire with no floor to go to
 * (`floor`): the floor list under the question, as the palette's floor-scoped commands ask it. Editing the text drops the
 * question. Esc closes the bar from any state, the floor question included; an answer that comes after is dropped, and
 * the game is told so before it acts on it (`live`: a closed bar's request opens nothing, applies nothing, closes nothing).
 */

/** `handover` (#108 round 4): the interpreter's `secrets_pending` for `hire`, handed to the review with it. */
export type DictationReply = { kind: 'done' } | { kind: 'say'; text: string; error: boolean } | { kind: 'floor'; hire: HireInterpretation; handover?: string };

/** The request is still the bar's: it was not closed (Esc, the chord, the backdrop) or reopened since it went. */
export type DictationLive = () => boolean;

export interface DictationHost {
  /**
   * Interprets `text` and routes the answer (a hire goes to the review, and the game closes the bar for it). The game
   * asks `live` when the answer comes, before it does anything with it: not live, it does nothing.
   */
  submit(text: string, live: DictationLive, o?: { review?: boolean }): Promise<DictationReply>;
  /** #108 round 4: "Review prompt secrets before sending", for the bar's "Review secrets" (absent: no such control). */
  secrets?: CardSecrets | null;
  /** The floor picked for a hire that had none: the game checks it can take the hire, then opens the review there. */
  pickFloor(floor: string, hire: HireInterpretation, live: DictationLive, handover: string | null): Promise<DictationReply>;
  store: FloorSource;
  /** The floor id of the office floor you are on, else null. */
  here(): string | null;
  /** The bridge answers: floors can be reached. */
  online(): boolean;
}

export type DictationState = 'editing' | 'pending' | 'floor';

/** What the bar shows (test hook). */
export interface DictationSummary {
  kind: 'dictation';
  state: DictationState;
  text: string;
  /** The line beside the field ('' when none). */
  status: string;
  error: boolean;
  /** The floor list's question and rows, while it asks. */
  question: string;
  floors: Array<{ floor: string; label: string; enabled: boolean; active: boolean }>;
}

type Row = { floor: string; el: HTMLElement; enabled: boolean };

export class DictationBar {
  private readonly dialog = h('dialog', { class: 'credits dictation', 'aria-labelledby': 'dict-label' });
  private readonly field = h('textarea', {
    id: 'dict-field',
    class: 'dict-field',
    rows: 3,
    autocomplete: 'off',
    spellcheck: 'true',
    'aria-describedby': 'dict-status',
    placeholder: 'Say or type what to do, like “Hire a Claude agent on Sonnet 5.5 with high effort to fix the login bug.”',
  });
  private readonly sendBtn = h('button', { class: 'btn btn--primary dict-send', type: 'button' }, 'Send');
  /** #108 round 4: the sentence's review on purpose (with the switch on), then its send; Ctrl/⌘+Shift+X in the field too. */
  private readonly reviewBtn = h(
    'button',
    { class: 'btn dict-review', type: 'button', 'data-key': 'review', title: 'Review secrets: look over the sentence’s possible secrets now, and mark one the scan missed (Ctrl/⌘+Shift+X)' },
    icon(ICON.lock),
    'Review secrets',
  );
  private readonly spinner = h('span', { class: 'dict-pending', 'aria-hidden': 'true', hidden: true });
  private readonly status = h('p', { id: 'dict-status', class: 'dict-status', role: 'status', 'aria-live': 'polite' });
  private readonly question = h('p', { class: 'pal-title dict-question', id: 'dict-question', hidden: true });
  private readonly list = h('ul', { class: 'pal-list dict-floors', id: 'dict-floors', role: 'listbox', 'aria-labelledby': 'dict-question', hidden: true });

  private opener: HTMLElement | null = null;
  private state: DictationState = 'editing';
  private statusText = '';
  private statusError = false;
  /** The hire the floor list is for (until a floor is picked, the text is edited, or the bar closes). */
  private hire: HireInterpretation | null = null;
  /** #108 round 4: the interpreter's hand-over for `hire` (null: none). */
  private handover: string | null = null;
  private floors: FloorItem[] = [];
  private rows: Row[] = [];
  private active = '';
  /** An IME is composing (with a beat after it ends: Safari's committing Enter comes after `compositionend`). */
  private composing = false;
  /** Bumped by every open and close: an answer for an earlier one is dropped. */
  private gen = 0;
  /** The close was handled (by `close`, or the `close` event of an Esc the dialog took itself). */
  private shut = true;

  constructor(
    parent: HTMLElement,
    private readonly host: DictationHost,
  ) {
    const head = h(
      'div',
      { class: 'dict-head' },
      h('label', { id: 'dict-label', class: 'dict-label', for: 'dict-field' }, 'Say a command'),
      this.field,
      h('div', { class: 'dict-row' }, this.spinner, this.status, this.reviewBtn, this.sendBtn),
    );
    const foot = h(
      'footer',
      { class: 'pal-foot dict-foot' },
      h('span', { class: 'dict-scope' }, 'Hiring is understood for now; you check every hire before it starts.'),
      h('span', { class: 'pal-keys', 'aria-hidden': 'true' }, h('kbd', {}, 'Enter'), ' send · ', h('kbd', {}, 'Shift'), '+', h('kbd', {}, 'Enter'), ' new line · ', h('kbd', {}, 'Esc'), ' close'),
    );
    this.dialog.append(head, this.question, this.list, foot);
    this.field.addEventListener('input', () => this.edited());
    this.field.addEventListener('keydown', (e) => this.key(e));
    this.field.addEventListener('compositionstart', () => (this.composing = true));
    this.field.addEventListener('compositionend', () => setTimeout(() => (this.composing = false), 0));
    this.sendBtn.addEventListener('click', () => void this.submit());
    this.reviewBtn.addEventListener('click', () => void this.submit(true));
    const showReview = () => (this.reviewBtn.hidden = !host.secrets?.on);
    showReview();
    host.secrets?.onChange(showReview);
    // What is pressed here is the bar's: the game, the seated terminal and the dialog under it must not see it.
    this.dialog.addEventListener('keydown', (e) => e.stopPropagation());
    // A press on a floor keeps the keyboard in the field.
    this.list.addEventListener('mousedown', (e) => e.preventDefault());
    this.list.addEventListener('click', (e) => {
      const row = this.rows[this.rowAt(e.target)];
      if (row?.enabled) void this.pick(row.floor);
    });
    // (The `close` event of a `close()` comes a task later: by then the bar may be open again, and that one is not closed.)
    this.dialog.addEventListener('close', () => {
      if (!this.dialog.open) this.closed();
    });
    backdropPolicy(this.dialog, 'sheet', () => this.close());
    parent.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  /** Opens it, empty (`from`: where the keyboard goes back to). Open already: nothing. */
  open(from: HTMLElement | null = null): void {
    if (this.dialog.open) return;
    this.gen++;
    this.opener = from;
    this.field.value = '';
    this.state = 'editing';
    this.hire = null;
    this.handover = null;
    this.say('', false);
    this.drawFloors();
    this.dialog.showModal();
    this.shut = false;
    this.field.focus();
  }

  /** Closes it; the keyboard goes back to where it was unless `restore` is false (the review is taking it). */
  close(restore = true): void {
    if (!this.dialog.open) return;
    if (!restore) this.opener = null;
    this.dialog.close();
    // (The `close` event comes a task later: the keyboard goes back now, before anything else takes it.)
    this.closed();
  }

  dispose(): void {
    this.close(false);
    this.dialog.remove();
  }

  /** The world changed: the floor list's rows are read again (a floor that went drops out). */
  refresh(): void {
    if (this.dialog.open && this.state === 'floor') this.drawFloors();
  }

  /** Types into the field as dictation would (tests). */
  setText(text: string): void {
    this.field.value = text;
    this.field.setSelectionRange(text.length, text.length);
    this.field.focus();
    this.edited();
  }

  summary(): DictationSummary | null {
    if (!this.dialog.open) return null;
    return {
      kind: 'dictation',
      state: this.state,
      text: this.field.value,
      status: this.statusText,
      error: this.statusError,
      question: this.state === 'floor' ? FLOOR_QUESTION : '',
      floors: this.state === 'floor' ? this.rows.map((r) => ({ floor: r.floor, label: r.el.querySelector('.pal-name')?.textContent ?? r.floor, enabled: r.enabled, active: r.floor === this.active })) : [],
    };
  }

  // ---- input -------------------------------------------------------------------------------

  private edited(): void {
    // A changed command is a new question: the floor list was for the old one.
    if (this.state === 'floor') {
      this.state = 'editing';
      this.hire = null;
      this.handover = null;
      this.drawFloors();
      this.say('', false);
    }
  }

  private key(e: KeyboardEvent): void {
    if (this.composing && (e.key === 'Enter' || e.key === 'Escape')) return;
    // #108: the sentence's review on purpose, then its send.
    if (reviewKey(e) && this.host.secrets?.on) {
      e.preventDefault();
      if (!e.repeat) void this.submit(true);
      return;
    }
    if (this.state === 'floor') {
      const ix = this.rows.findIndex((r) => r.floor === this.active);
      const k = listKey(e, { rows: this.rows.some((r) => r.enabled), can: ix >= 0 && !!this.rows[ix]?.enabled });
      if (k === 'next' || k === 'prev') {
        e.preventDefault();
        const live = this.rows.filter((r) => r.enabled);
        const to = live[wrapIndex(live.findIndex((r) => r.floor === this.active), live.length, k === 'next' ? 1 : -1)];
        if (to) this.setActive(to.floor);
        return;
      }
      if (k === 'pick' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        void this.pick(this.active);
        return;
      }
      if (k === 'enter-empty') {
        e.preventDefault();
        return;
      }
    }
    const k = barKey(e);
    if (!k) return;
    e.preventDefault();
    if (k === 'close') this.close();
    else void this.submit();
  }

  // ---- sending -----------------------------------------------------------------------------

  /** `review` (#108): "Review secrets": the sentence's review opens even when the scan finds nothing. */
  private async submit(review = false): Promise<void> {
    // One request at a time: another Enter while it is on its way sends nothing.
    if (this.state === 'pending') return;
    const text = this.field.value;
    if (!text.trim()) {
      this.say('Say or type a command first.', false);
      return;
    }
    const gen = this.gen;
    this.state = 'pending';
    this.hire = null;
    this.handover = null;
    this.drawFloors();
    this.say('Reading the command…', false);
    const live = this.liveFor(gen);
    const reply = await (review ? this.host.submit(text, live, { review: true }) : this.host.submit(text, live));
    if (!live()) return;
    this.answer(reply);
  }

  private async pick(floor: string): Promise<void> {
    const hire = this.hire;
    if (this.state !== 'floor' || !hire || !floor) return;
    const live = this.liveFor(this.gen);
    const reply = await this.host.pickFloor(floor, hire, live, this.handover);
    if (!live()) return;
    // A floor that cannot take the hire: the list stays up to pick another, with the reason.
    if (reply.kind === 'say') return this.say(reply.text, reply.error);
    this.answer(reply);
  }

  /** True while the bar is still the one that was open at `gen` (every open and close bumps it). */
  private liveFor(gen: number): DictationLive {
    return () => gen === this.gen && this.dialog.open;
  }

  private answer(reply: DictationReply): void {
    if (reply.kind === 'done') {
      this.state = 'editing';
      return;
    }
    if (reply.kind === 'floor') {
      this.state = 'floor';
      this.hire = reply.hire;
      this.handover = reply.handover ?? null;
      this.floors = floorList(this.host.store, '');
      this.active = '';
      this.drawFloors();
      this.say('Pick the floor for this hire (↑ ↓ and Enter), or change the text.', false);
      return;
    }
    this.state = 'editing';
    this.say(reply.text, reply.error);
  }

  private say(text: string, error: boolean): void {
    this.statusText = text;
    this.statusError = error;
    this.status.textContent = text;
    this.status.dataset.tone = error ? 'error' : 'info';
    this.status.hidden = text === '';
    const pending = this.state === 'pending';
    this.spinner.hidden = !pending;
    this.sendBtn.setAttribute('aria-disabled', String(pending));
    this.dialog.setAttribute('aria-busy', String(pending));
  }

  // ---- the floor list ----------------------------------------------------------------------

  private drawFloors(): void {
    const asking = this.state === 'floor';
    this.question.hidden = this.list.hidden = !asking;
    this.question.textContent = asking ? FLOOR_QUESTION : '';
    if (!asking) {
      this.rows = [];
      this.list.replaceChildren();
      this.field.removeAttribute('aria-activedescendant');
      this.field.removeAttribute('aria-controls');
      return;
    }
    const online = this.host.online();
    const here = this.host.here();
    const rows: Row[] = [];
    for (const item of this.floors) {
      const f = floorRow(this.host.store, item, here);
      if (f) rows.push(this.floorRow(f, online));
    }
    this.rows = rows;
    this.list.replaceChildren(...rows.map((r, i) => ((r.el.id = `dict-floor-${i}`), r.el)));
    if (!rows.some((r) => r.floor === this.active && r.enabled)) this.active = rows.find((r) => r.enabled)?.floor ?? '';
    this.field.setAttribute('aria-controls', 'dict-floors');
    this.paintActive();
  }

  private floorRow(f: FloorRow, online: boolean): Row {
    const state = f.transition === 'waking' ? 'Waking up' : f.transition === 'sleeping' ? 'Going to sleep' : f.asleep ? 'Asleep' : '';
    const el = h(
      'li',
      { class: 'pal-opt pal-opt--floor', role: 'option', 'aria-selected': 'false', 'aria-disabled': online ? null : 'true', 'data-floor': f.floor },
      h('span', { class: 'pal-name' }, f.label),
      h('span', { class: 'pal-meta' }, state ? h('span', { class: `tape tape--${f.asleep && !f.transition ? 'asleep' : (f.transition ?? 'asleep')}` }, state) : null),
    );
    return { floor: f.floor, el, enabled: online };
  }

  private setActive(floor: string): void {
    this.active = floor;
    this.paintActive();
  }

  private paintActive(): void {
    const row = paintActiveRow(this.list, this.rows.findIndex((r) => r.floor === this.active));
    if (row) this.field.setAttribute('aria-activedescendant', row.id);
    else this.field.removeAttribute('aria-activedescendant');
  }

  private rowAt(t: EventTarget | null): number {
    const li = (t as Element | null)?.closest?.('li.pal-opt');
    return li ? [...this.list.children].indexOf(li) : -1;
  }

  private closed(): void {
    if (this.shut) return;
    this.shut = true;
    this.gen++;
    const back = this.opener;
    this.opener = null;
    this.state = 'editing';
    this.hire = null;
    this.handover = null;
    this.drawFloors();
    // Back to where the keyboard was (the seat's input, the review, the canvas); gone: the page.
    const now = document.activeElement;
    if (back?.isConnected && (!now || now === document.body || this.dialog.contains(now))) back.focus();
    // Nowhere to go back to (the page had it): the closed box must not keep it, or the game's keys would think you type.
    if (this.dialog.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }
}
