import { CornerWatch } from './corner';
import { h } from './dom';
import './inbox.css';

/**
 * #100: the inbox chip, `Inbox 3`, under the plan-limits plate: how many workers need you or are done
 * (world/inbox.ts). Not there at zero. A click takes you to the first of them (App.goInbox). It sits where the plate
 * would be when the plate is not shown (switched off, no reading yet), and goes away where the plate steps aside or
 * folds (corner.ts): over a screen dialog, the reading overlay, at a laptop, under a dialog on a narrow screen.
 */
export class InboxChip {
  readonly root: HTMLButtonElement;
  private readonly count = h('b', { class: 'ib-n' });
  private state: { count: number; blocked: boolean } | null = null;
  private readonly corner = new CornerWatch(() => this.sync());
  /** The plate's height moves the chip down (inbox.css `--ib-lift`); 0 while it is not drawn. */
  private readonly plateSize: ResizeObserver | null;

  constructor(parent: HTMLElement, plate: HTMLElement, go: () => void) {
    this.root = h('button', { class: 'inbox', 'data-hook': 'inbox', 'data-key': 'inbox' }, h('span', { class: 'ib-lab' }, 'Inbox'), this.count);
    this.root.addEventListener('click', go);
    this.root.hidden = true;
    parent.append(this.root);
    this.plateSize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.lift(plate)) : null;
    this.plateSize?.observe(plate);
    this.lift(plate);
  }

  /** What to show (world/inbox.ts `inboxChip`); null hides the chip. */
  set(state: { count: number; blocked: boolean } | null): void {
    this.state = state;
    if (state) {
      this.count.textContent = String(state.count);
      this.root.dataset.blocked = String(state.blocked);
      const why = state.blocked ? 'someone needs you' : 'finished work to look at';
      this.root.setAttribute('aria-label', `Inbox: ${state.count}, ${why}. Sit at the first one’s laptop.`);
      this.root.title = `Inbox: ${why}. Click to sit at the first one’s laptop.`;
    }
    this.sync();
  }

  private sync(): void {
    this.root.hidden = !this.state || this.corner.screen || this.corner.folded;
    this.root.dataset.beside = this.corner.beside;
  }

  private lift(plate: HTMLElement): void {
    const r = plate.getBoundingClientRect();
    this.root.style.setProperty('--ib-lift', r.height > 0 ? `${(r.height + 6).toFixed(1)}px` : '0px');
  }

  /** What the chip shows (test hook). */
  summary(): { shown: boolean; count: number; blocked: boolean } {
    return { shown: !this.root.hidden, count: this.state?.count ?? 0, blocked: this.state?.blocked ?? false };
  }

  dispose(): void {
    this.corner.dispose();
    this.plateSize?.disconnect();
    this.root.remove();
  }
}
