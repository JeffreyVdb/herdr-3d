import type { ChildState, TranscriptAvailability } from '../net/protocol';
import { h, icon, ICON } from '../ui/dom';

/**
 * #26: a native child's own conversation in the seated view: the transcript view's bar becomes a breadcrumb from the
 * worker to the child, with the child's state (the floor overview's pip and words) and the way back; the timeline's
 * empty space says why there is nothing to read (not opened yet, not written yet, none at all). Read only: a child
 * takes no prompts here.
 */

/** What the view shows of the child (the transcript mode keeps it current from the store and the watch). */
export interface ChildViewState {
  state: ChildState;
  /** Its state and time in the overview's words (`running 4m`, `completed in 3m`, `state unknown`). */
  since: string;
  /** Its log as its watch says (null: the watch has not answered yet). */
  availability: TranscriptAvailability | null;
  /** There are older items than the ones shown (`transcript.page` with its cursor). */
  hasMore: boolean;
}

/** The child view's host (`TranscriptRenderHost.child`). */
export interface ChildViewHost {
  /** The worker's name (the breadcrumb's first step and the way back). */
  worker: string;
  /** The child's name (its nickname or type) and its type when the name is something else. */
  name: string;
  type?: string | null;
  /** What it was asked (the breadcrumb's tooltip). */
  description?: string | null;
  /** Back to the worker's own conversation (the breadcrumb's first step, Esc). */
  onBack(): void;
  /** Its older items, merged into the timeline (resolves once they are). */
  loadOlder(): Promise<void>;
}

/** The empty timeline's words for a child, by what its watch said. */
export function childEmptyText(name: string, worker: string, a: TranscriptAvailability | null): { title: string; body: string } {
  if (a === null) return { title: `Opening ${name}’s conversation…`, body: '' };
  if (a === 'pending') return { title: `${name} hasn’t written anything yet`, body: 'Its conversation shows here as soon as it starts. You can stay on this page.' };
  if (a === 'unavailable') return { title: `${name} has no conversation to show`, body: `Its log was never kept, or it was cleaned up. ${worker}’s own conversation still has the call that started it.` };
  return { title: 'No conversation yet.', body: '' };
}

/** The breadcrumb, its state and the empty state's parts: what `Transcript` puts in its bar and timeline for a child. */
export class ChildBar {
  readonly el: HTMLElement;
  /** Under the bar: the read-only note with the way back (the prompt box's place). */
  readonly foot: HTMLElement;
  /** Above the timeline's first item: the older items' button. */
  readonly older: HTMLButtonElement;
  private readonly pip: HTMLElement;
  private readonly stateEl: HTMLElement;
  private readonly status: HTMLElement;
  private loading = false;
  private last = '';

  constructor(
    private readonly host: ChildViewHost,
    private readonly empty: HTMLElement,
    private readonly announce: (text: string) => void,
  ) {
    const back = h(
      'button',
      { class: 'tx-crumb-back', type: 'button', 'aria-label': `Back to ${host.worker}’s conversation`, title: `Back to ${host.worker}’s conversation (Esc)`, onclick: () => host.onBack() },
      icon(ICON.back),
      h('span', { class: 'tx-crumb-worker' }, host.worker),
    );
    this.pip = h('span', { class: 'tx-crumb-pip', 'aria-hidden': 'true' });
    this.stateEl = h('span', { class: 'tx-crumb-state' });
    const here = h(
      'span',
      { class: 'tx-crumb-here', 'aria-current': 'page', ...(host.description ? { title: host.description } : {}) },
      h('span', { class: 'tx-crumb-name' }, host.name),
      ...(host.type ? [h('span', { class: 'tx-crumb-type' }, host.type)] : []),
    );
    this.el = h(
      'nav',
      { class: 'tx-crumbs', 'aria-label': 'Conversation' },
      back,
      h('span', { class: 'tx-crumb-sep', 'aria-hidden': 'true' }, icon('<path d="M9.5 6l6 6-6 6"/>')),
      here,
      h('span', { class: 'tx-crumb-status' }, this.pip, this.stateEl),
    );
    this.status = h('span', { class: 'tx-child-note' }, 'Subagents take no prompts here.');
    this.foot = h(
      'div',
      { class: 'tx-child-foot' },
      this.status,
      h('button', { class: 'tx-child-back', type: 'button', onclick: () => host.onBack() }, `Back to ${host.worker}`),
    );
    this.older = h('button', { class: 'tx-older', type: 'button', hidden: true, onclick: () => void this.loadOlder() }, 'Show earlier messages');
  }

  set(s: ChildViewState): void {
    this.el.dataset.state = s.state;
    this.stateEl.textContent = s.since;
    this.older.hidden = !s.hasMore || s.availability !== 'available';
    const e = childEmptyText(this.host.name, this.host.worker, s.availability);
    const key = `${e.title}\u0000${e.body}`;
    if (key === this.last) return;
    this.last = key;
    this.empty.dataset.child = s.availability ?? 'opening';
    this.empty.replaceChildren(h('p', { class: 'tx-empty-title' }, e.title), ...(e.body ? [h('p', { class: 'tx-empty-body' }, e.body)] : []));
    // A change of what can be read is said once (the first answer is shown, not spoken).
    if (s.availability === 'unavailable' || (s.availability === 'available' && this.empty.dataset.was === 'pending')) this.announce(s.availability === 'available' ? `${this.host.name}’s conversation started.` : e.title);
    this.empty.dataset.was = s.availability ?? '';
  }

  private async loadOlder(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.older.disabled = true;
    this.older.textContent = 'Loading earlier messages…';
    try {
      await this.host.loadOlder();
    } finally {
      this.loading = false;
      this.older.disabled = false;
      this.older.textContent = 'Show earlier messages';
    }
  }
}
