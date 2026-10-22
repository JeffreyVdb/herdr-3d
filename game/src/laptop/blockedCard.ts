import { h } from '../ui/dom';

/** A question read off the worker's terminal screen (a permission prompt, a menu): it blocks the agent like an ask. */
export interface BlockedQuestion {
  kind: string;
  text: string;
  excerpt: string[];
  choices: { n: number; label: string }[];
  selected?: number;
  hash: string;
}

export interface BlockedCardHost {
  /** Picks choice n of the question (`worker.answer`), or cancels it. */
  answer(hash: string, choice: number | null, cancel?: boolean): void;
  toTerminal(): void;
}

/**
 * #187: the screen's blocked question, in the urgent lane of the questions' sheet (it was the banner at the top of the
 * transcript): the question, the last lines of the screen, its numbered choices (a click or the digit picks one),
 * Cancel, and the terminal. The excerpt comes in as plain text (the view strips the terminal's escapes and keeps the
 * tail). Its id is the bridge's hash of the question: the same prompt in the same blocked spell keeps it (not the
 * cursor), so the sheet opens once for it.
 */
export class BlockedCard {
  readonly el: HTMLElement;
  private q: BlockedQuestion | null = null;

  constructor(private readonly host: BlockedCardHost) {
    this.el = h('section', { class: 'tx-bq', hidden: true, 'aria-label': 'Waiting for you on the terminal' });
  }

  get shown(): boolean {
    return !!this.q;
  }

  /** The question's id for the sheet (null: none). */
  get id(): string | null {
    return this.q ? `screen:${this.q.hash}` : null;
  }

  set(q: BlockedQuestion | null): void {
    this.q = q;
    this.render();
  }

  destroy(): void {
    this.el.remove();
  }

  /** The keyboard on the card: the highlighted choice, else the first, else the terminal. */
  focus(): void {
    const b = this.el.querySelector<HTMLElement>('.tx-choice-sel') ?? this.el.querySelector<HTMLElement>('.tx-choice, .tx-to-term');
    b?.focus({ preventScroll: true });
  }

  /** A digit on the card picks that choice. True: it was the card's. */
  key(e: KeyboardEvent): boolean {
    const q = this.q;
    if (!q || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || !/^[1-9]$/.test(e.key)) return false;
    const n = Number(e.key);
    if (!q.choices.some((c) => c.n === n)) return false;
    this.host.answer(q.hash, n);
    return true;
  }

  private render(): void {
    const q = this.q;
    const a = document.activeElement;
    const had = a instanceof HTMLElement && this.el.contains(a) ? (a.dataset.key ?? null) : null;
    this.el.hidden = !q;
    if (!q) {
      this.el.replaceChildren();
      return;
    }
    const choices = (Array.isArray(q.choices) ? q.choices : []).filter((c) => c && Number.isInteger(c.n));
    const chips = choices.map((c) =>
      h(
        'button',
        { class: c.n === q.selected ? 'tx-choice tx-choice-sel' : 'tx-choice', 'data-n': String(c.n), 'data-key': `n:${c.n}`, onclick: () => this.host.answer(q.hash, c.n) },
        h('span', { class: 'tx-choice-n' }, String(c.n)),
        h('span', { class: 'tx-choice-label' }, String(c.label ?? '')),
      ),
    );
    const excerpt = Array.isArray(q.excerpt) ? q.excerpt : [];
    const parts: HTMLElement[] = [
      h('div', { class: 'tx-banner-head' }, h('span', { class: 'tx-banner-tag' }, 'Waiting for you'), h('span', { class: 'tx-banner-text' }, String(q.text ?? '').trim() || 'Waiting for input')),
    ];
    if (excerpt.length) parts.push(h('pre', { class: 'tx-banner-excerpt' }, excerpt.join('\n')));
    parts.push(
      h(
        'div',
        { class: 'tx-banner-actions' },
        ...chips,
        h('span', { class: 'tx-spacer' }),
        choices.length ? h('button', { class: 'tx-link', 'data-key': 'cancel', onclick: () => this.host.answer(q.hash, null, true) }, 'Cancel') : null,
        h('button', { class: 'tx-link tx-to-term', 'data-key': 'term', onclick: () => this.host.toTerminal() }, 'Switch to terminal'),
      ),
    );
    this.el.replaceChildren(...parts);
    // Redrawn under the keyboard (the cursor moved): it stays on the same control.
    if (had) this.el.querySelector<HTMLElement>(`[data-key="${had}"]`)?.focus({ preventScroll: true });
  }
}
