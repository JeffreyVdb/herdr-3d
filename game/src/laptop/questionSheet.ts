import { h } from '../ui/dom';
import { Sheet } from '../ui/sheet';
import type { AskCard } from './askCard';
import type { AsyncCard } from './asyncCard';
import type { BlockedCard } from './blockedCard';
import type { FollowupCard } from './followupCard';
import { QuestionsButton, type QuestionsState } from './questionsButton';

/** The question cards of a transcript view, by lane: what the agent is blocked on, and what it only asked. */
export interface QuestionCards {
  /** Mandatory: Claude's AskUserQuestion, Codex's request_user_input. */
  ask: AskCard;
  /** Mandatory: the screen's question (shown only while there is no ask: the card wins over the screen's question). */
  blocked: BlockedCard;
  /** Optional: the open questions of the agent's last message. */
  followup: FollowupCard;
  /** Optional: a shared Codex worker's async questions (it works on). */
  asyncq: AsyncCard;
}

/** The ids of the mandatory questions the sheet has opened for already, kept above the view (per worker). */
export interface OpenedAsks {
  has(id: string): boolean;
  add(id: string): void;
}

export interface QuestionSheetHost {
  /** The asks opened for already (none: this view's own, which goes with it). */
  opened?: OpenedAsks | null;
  toTerminal(): void;
  /** The keyboard back to the conversation's timeline. */
  focusTimeline(): void;
}

type Card = QuestionCards[keyof QuestionCards];

/** Ids for the sheets (the button's aria-controls). */
let sheets = 0;

/** The one Esc, Ctrl/⌘+Esc: the sheet closes, the second goes on to the terminal. */
const isEsc = (e: KeyboardEvent) => e.key === 'Escape' && !e.altKey && !e.shiftKey;

/**
 * #187: a transcript view's questions, in one sheet (`ui/sheet.ts`: a dialog on a desktop, a bottom sheet on a phone)
 * behind one button in the prompt box (`questionsButton.ts`), instead of cards pinned between the conversation and the
 * prompt box. The conversation keeps its whole height.
 *
 * Two lanes. Mandatory (urgent): the agent cannot go on before it has an answer, an ask or the screen's question. A new
 * one opens the sheet by itself, once: its id (the ask's tool_use_id, the screen question's hash) goes into `opened`,
 * kept by the host per worker, so hiding the sheet (Esc, its ×, the backdrop) leaves the button and nothing opens it
 * again for that id, not a re-render, a reconnect or another seat. While the conversation is not the view on the screen
 * (the terminal, the images, a child's conversation) it waits, and opens once it is. Optional (calm): the follow-up's
 * open questions and Codex's async questions never open it: the button glows and its live region says so. With both
 * lanes up the sheet groups them, urgent first, each under its name.
 *
 * The sheet sits in the page's top layer (`document.body`), outside the view, so the cards' keys are routed from it:
 * the card the keyboard is on takes its digits, ↑ ↓, Enter, Ctrl/⌘+Enter and Ctrl/⌘+Shift+X; Esc closes the sheet and
 * Ctrl/⌘+Esc goes on to the terminal. A card that sends the keyboard back to the timeline (its Esc, an answer recorded)
 * closes the sheet, or moves to the next card when another one is still up.
 */
export class QuestionSheet {
  readonly button: QuestionsButton;
  /** The cards' box in the sheet (transcript.css styles the cards under it as under the view). */
  readonly cardsEl: HTMLElement;
  private readonly sheet: Sheet;
  private readonly urgentLane: HTMLElement;
  private readonly optionalLane: HTMLElement;
  private readonly opened: OpenedAsks;
  /** The conversation is the view on the screen (an auto-open waits for it). */
  private visible = true;
  /** The urgent lane had questions at the last sync (its last one gone closes the sheet). */
  private hadUrgent = false;
  /** An Esc is being handled in the sheet (a card's way back to the timeline is then a close). */
  private escaping = false;
  private destroyed = false;

  constructor(
    private readonly cards: QuestionCards,
    private readonly host: QuestionSheetHost,
  ) {
    this.opened = host.opened ?? new Set<string>();
    this.sheet = new Sheet({
      label: 'Questions for you',
      className: 'tx-qsheet',
      onClose: () => this.closed(),
      initialFocus: () => this.first(),
    });
    this.sheet.el.id ||= `tx-qsheet-${++sheets}`;
    this.button = new QuestionsButton({ onOpen: () => this.open(this.button.el), controls: this.sheet.el.id });
    const lane = (k: 'urgent' | 'optional', name: string, ...els: HTMLElement[]) =>
      h('section', { class: 'tx-qlane', 'data-lane': k, 'aria-label': name }, h('h3', { class: 'tx-qlane-head' }, name), ...els);
    this.urgentLane = lane('urgent', 'Answer to continue', cards.ask.el, cards.blocked.el);
    this.optionalLane = lane('optional', 'Optional', cards.followup.el, cards.asyncq.el);
    this.cardsEl = h('div', { class: 'tx-qcards' }, this.urgentLane, this.optionalLane);
    this.sheet.body.append(this.cardsEl);
    // Capture: a card's text box stops its own Esc before it bubbles here. Any other key or a press is not an Esc.
    this.sheet.el.addEventListener('keydown', (e) => (this.escaping = isEsc(e) && !e.ctrlKey && !e.metaKey), true);
    this.sheet.el.addEventListener('pointerdown', () => (this.escaping = false), true);
    this.sheet.el.addEventListener('keydown', (e) => this.onKey(e));
  }

  get isOpen(): boolean {
    return this.sheet.isOpen;
  }

  /** The button shows (something waits) and the conversation is on the screen: `Q` opens the sheet. */
  get canOpen(): boolean {
    return !this.destroyed && this.visible && !this.button.el.hidden;
  }

  /** The id of the mandatory question up (null: none). */
  private get urgentId(): string | null {
    const ask = this.cards.ask.toolUseId;
    return ask ? `ask:${ask}` : this.cards.blocked.id;
  }

  /** What the button counts: an ask's questions (the screen's question is one), the follow-up's, Codex's on its card. */
  private state(): QuestionsState {
    const { ask, blocked, followup, asyncq } = this.cards;
    return { urgent: ask.shown ? ask.count : blocked.shown ? 1 : 0, followup: followup.count, asyncq: asyncq.count, open: this.sheet.isOpen };
  }

  /** A card was drawn (shown, gone, another question): the button, the lanes and the sheet follow. */
  sync(): void {
    if (this.destroyed) return;
    const { ask, blocked, followup, asyncq } = this.cards;
    const s = this.state();
    // A lane is up while one of its cards is.
    const urgent = ask.shown || blocked.shown;
    const optional = followup.shown || asyncq.shown;
    this.urgentLane.hidden = !urgent;
    this.optionalLane.hidden = !optional;
    // Both lanes up: each under its name (one lane alone is what the sheet's title says).
    this.sheet.el.toggleAttribute('data-lanes', urgent && optional);
    const optName = followup.shown && asyncq.shown ? 'Open questions and Codex asked' : asyncq.shown ? 'Codex asked' : 'Open questions';
    // Both lanes: the title says both (each lane has its own heading), the name which ones.
    const name = urgent && !optional ? 'Answer to continue' : (urgent && optional) || (followup.shown && asyncq.shown) ? 'Questions for you' : optName;
    this.optionalLane.setAttribute('aria-label', optName);
    this.optionalLane.querySelector('.tx-qlane-head')!.textContent = optName;
    this.sheet.setLabel(urgent && optional ? `Answer to continue, and ${optName.replace(/^Open/, 'open')}` : name, name);
    // The urgent lane's last question went (answered, withdrawn): the sheet goes with it; so it does with nothing left.
    if (this.sheet.isOpen && ((this.hadUrgent && !urgent) || (!urgent && !optional))) this.sheet.close();
    this.hadUrgent = urgent;
    // A new mandatory question opens it, once (one that comes while it is open is seen there: it counts).
    const id = this.urgentId;
    if (id && this.visible && !this.opened.has(id)) {
      this.opened.add(id);
      if (!this.sheet.isOpen) this.sheet.open(null);
    }
    this.button.set({ ...s, open: this.sheet.isOpen });
  }

  /** The button, `Q`: the sheet, the keyboard on its first question (closed, back to `opener`, else where it was). */
  open(opener: HTMLElement | null = null): void {
    if (!this.canOpen) return;
    const id = this.urgentId;
    if (id) this.opened.add(id);
    this.sheet.open(opener);
    this.button.set({ ...this.state(), open: true });
  }

  /**
   * Whether the conversation is the view on the screen. Gone (the terminal, the images, a child's conversation), the
   * sheet closes (it would sit over the terminal: the button keeps the question); back, a mandatory question not opened
   * for yet opens it.
   */
  setVisible(on: boolean): void {
    if (this.destroyed || on === this.visible) return;
    this.visible = on;
    if (!on && this.sheet.isOpen) this.sheet.close();
    this.sync();
  }

  /**
   * A card's way back to the timeline. In the sheet: its Esc (or its text box's) closes it; its last question gone (an
   * answer recorded) puts the keyboard on the next card up, else closes it; its controls off while its answer is on its
   * way keep it open, the keyboard on the sheet itself (the card says how the answer went).
   */
  leave(card: Card): void {
    if (this.destroyed) return;
    if (!this.sheet.isOpen) return this.host.focusTimeline();
    if (this.escaping) return this.sheet.close();
    if (card.shown) return this.sheet.el.focus({ preventScroll: true });
    const next = this.first();
    if (next) return next.focus({ preventScroll: true });
    this.sheet.close();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.sheet.destroy();
    this.button.destroy();
  }

  /** The first card up, urgent first: its keyboard's place. */
  private first(): HTMLElement | null {
    const { ask, blocked, followup, asyncq } = this.cards;
    const card = [ask, blocked, followup, asyncq].find((c) => c.shown);
    if (!card) return null;
    card.focus();
    const a = document.activeElement;
    return a instanceof HTMLElement && card.el.contains(a) ? a : null;
  }

  private closed(): void {
    this.escaping = false; // an Esc in the sheet always ends here
    if (this.destroyed) return;
    this.button.set({ ...this.state(), open: false });
    // Nowhere else to be in the view (no opener, it went, the button now hidden, a control outside the view): the
    // conversation.
    const a = document.activeElement;
    const view = this.button.el.closest('.tx');
    if (!a || this.sheet.el.contains(a) || !!a.closest('[hidden]') || !view?.contains(a)) this.host.focusTimeline();
  }

  /** A key in the sheet: the card it is on takes it first; Esc closes, Ctrl/⌘+Esc goes on to the terminal. */
  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.isComposing) return;
    if (isEsc(e) && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      this.sheet.close();
      this.host.toTerminal();
      return;
    }
    const t = e.target instanceof Node ? e.target : null;
    const { ask, blocked, followup, asyncq } = this.cards;
    const card = t ? [ask, blocked, followup, asyncq].find((c) => c.el.contains(t)) : undefined;
    // Enter and Space on a button stay its click (an option is picked, never sent): no card takes them.
    if (card && (card === blocked ? blocked.key(e) : card.key(e, true))) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}
