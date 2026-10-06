import type { CommandResult } from '../../net/client';
import type { BoardComment, BoardIssues, BoardLabel, BoardPrs, IssueCard, IssueDetail, PrDetail, PullRequest, CloseReason, MergeMethod, CommentAck } from '../../net/protocol';
import { can, CHECKS_WORD, CLOSE_REASONS, columnViews, type ColumnView, closesText, freshness, holdersOf, keysById, MERGEABLE_WORD, mergeBlocker, paperOf, pinOf, PRIORITY_WORD, readableInk, REVIEW_WORD, timeAgo, verdictOf } from '../../world/boards';
import type { WorkerView } from '../../world/store';
import { h, icon, ICON, replaceKeepingFocus } from '../dom';
import { failureText } from '../messages';
import type { DialogHost } from '../hire';
import './boards.css';
import { setMarkdown } from './markdown';
import { backdropPolicy } from '../dismiss';
import { CardDrag } from './cardDrag';
import { placeMoves, showsMove, type PendingMove } from './drag';

/**
 * M7: the Issues and Pull requests overlays and their item modals. The overlay lists what the floor's board says (the
 * provider's columns and cards, or the open PRs); an item opens a modal with its body (markdown, sanitised), comments
 * and the actions the provider allows. Everything here is provider-neutral: the copy says `provider_name`, actions
 * follow the `capabilities` flags (hidden when false), ids are opaque and never parsed.
 */

export interface BoardOff {
  text: string;
  sub?: string;
}

export interface BoardState {
  issues: BoardIssues | null;
  prs: BoardPrs | null;
  off: BoardOff | null;
}

export interface BoardsHost extends DialogHost {
  /** The floor you are on (null: none). */
  session(): string | null;
  state(session: string): BoardState;
  /** `board.refresh`. */
  refresh(session: string): void;
  external(url: string): void;
  /** "Hand to a worker": the start-run dialog on the nearest free desk, pre-filled. */
  handTo(session: string, card: IssueCard, provider: string): void;
  /** "Ask a worker…": the hire dialog with a first prompt. */
  ask(session: string, card: IssueCard): void;
  /** "Review with a worker": the hire dialog with a reviewer and its first prompt. */
  review(session: string, pr: PullRequest): void;
  /** Why an action that starts a run or hires is off (null: it works). */
  whyNoRun(session: string): string | null;
  whyNoHire(session: string): string | null;
  /** A holder's tag: take me to that worker, its transcript on screen. */
  goTo(workerId: string): void;
}

type Which = 'issues' | 'prs';

type Detail<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'error'; message: string };

type MergeStep = { step: 'confirm' | 'override1' | 'override2'; method: MergeMethod };

/**
 * #52: a card the game moved by a drag. It shows at once; on a failure it goes back. Once acknowledged it stays until a
 * board polled after the write (any non-initial board.issues that arrives after the ack: the bridge never shows a poll
 * that began before a write) shows it there, or until `MOVE_HOLD_MS` have passed, whatever that board says.
 */
interface Move extends PendingMove {
  seq: number;
  acked: boolean;
  /** The board at the ack: a later one is the bridge's refresh. */
  seen: BoardIssues | null;
  until: number;
}

const MOVE_HOLD_MS = 20_000;

const GLYPH = {
  issues: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>',
  prs: '<circle cx="7" cy="6" r="2.2"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="18" r="2.2"/><path d="M7 8.2v7.6M17 15.8V10a3 3 0 0 0-3-3h-3.5M12.5 5 10.5 7l2 2"/>',
  refresh: '<path d="M19 12a7 7 0 1 1-2.2-5.1M19 4.5V8h-3.5"/>',
  external: '<path d="M13.5 5H19v5.5M19 5l-8 8M17 14v4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18V9a1.5 1.5 0 0 1 1.5-1.5H10"/>',
};

const MERGE_METHODS: ReadonlyArray<{ id: MergeMethod; label: string }> = [
  { id: 'squash', label: 'Squash and merge' },
  { id: 'merge', label: 'Create a merge commit' },
  { id: 'rebase', label: 'Rebase and merge' },
];

const bytes = (s: string) => new TextEncoder().encode(s).length;
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export interface BoardSummary {
  kind: 'issues' | 'prs';
  session: string;
  title: string;
  provider: string;
  /** Issues: the columns and the keys of their cards; PRs: one column of keys. */
  columns: Array<{ id: string; name: string; keys: string[] }>;
  notice: string | null;
  /** #52: why the last drop did not land (shown above the columns). */
  alert: string | null;
  off: string | null;
  item: ItemSummary | null;
}

export interface ItemSummary {
  kind: 'issue' | 'pr';
  id: string;
  key: string;
  title: string;
  state: 'loading' | 'ready' | 'error';
  error: string | null;
  /** The actions on screen (their `data-key`s), in order. */
  actions: string[];
  /** The open confirmation, if any. */
  confirm: string | null;
  comments: number;
  busy: string | null;
  bodyText: string;
}

export class BoardsPanel {
  private readonly dialog = h('dialog', { class: 'desk-dlg desk-dlg--board', 'aria-labelledby': 'board-title', 'aria-describedby': 'board-sub' });
  private readonly head = h('header', { class: 'dd-head' });
  private readonly notice = h('div', { class: 'bd-notice', role: 'status' });
  /** #52: why the last drop did not land, in the board itself (the HUD's toast is under the modal board). */
  private readonly alert = h('div', { class: 'bd-alert' });
  private readonly body = h('div', { class: 'bd-body' });
  private readonly item = h('dialog', { class: 'desk-dlg desk-dlg--item', 'aria-labelledby': 'item-title' });
  private readonly itemHead = h('header', { class: 'dd-head' });
  private readonly itemBody = h('div', { class: 'bd-item' });
  private readonly itemFoot = h('footer', { class: 'dd-foot bd-foot' });

  private which: Which = 'issues';
  private session = '';
  // The open item.
  private itemId: string | null = null;
  private issueDetail: Detail<IssueDetail> = { state: 'loading' };
  private prDetail: Detail<PrDetail> = { state: 'loading' };
  private gen = 0;
  private busy: string | null = null;
  private moveTo = '';
  private closing: CloseReason | null = null;
  private merging: MergeStep | null = null;
  private method: MergeMethod = 'squash';
  private actionError = '';
  private extraComments: BoardComment[] = [];
  /** Kept between renders: what is typed is never lost to a poll. */
  private readonly commentBox = h('textarea', { id: 'bd-comment', 'data-key': 'comment-text', rows: 3, spellcheck: 'true', placeholder: 'Write a comment (Markdown)…', 'aria-label': 'Comment' });
  private returnTo: HTMLElement | null = null;
  /** #52: dragging cards; the moves it made that the board does not show yet, and the writes in order. */
  private readonly drag: CardDrag;
  private readonly moves = new Map<string, Move>();
  private moveSeq = 0;
  private writes: Promise<unknown> = Promise.resolve();
  private held = false;

  constructor(
    parent: HTMLElement,
    private readonly host: BoardsHost,
  ) {
    this.dialog.append(this.head, this.notice, this.alert, this.body);
    this.drag = new CardDrag(this.body, this.dialog, {
      canDrag: (id) => this.canDrag(id),
      ordered: (id) => {
        const board = this.state().issues;
        return can(board, board?.cards.find((c) => c.id === id), 'order');
      },
      drop: (id, column, after) => this.dropCard(id, column, after),
      live: (on) => {
        if (on) this.alert.replaceChildren(); // a new drag: the last one's error is over
        if (on || !this.held) return;
        this.held = false;
        this.render();
      },
    });
    // The Esc that ends a drag is not the one that closes the board.
    this.dialog.addEventListener('cancel', (e) => {
      if (this.drag.active || this.drag.swallowing) e.preventDefault();
    });
    this.item.append(this.itemHead, this.itemBody, this.itemFoot);
    // The board is read-only: the backdrop closes it only when the press and the click both began there (#51).
    // The item modal holds the comment box: only its close button and Esc close it.
    backdropPolicy(this.dialog, 'sheet', () => this.dialog.close());
    backdropPolicy(this.item, 'none');
    this.dialog.addEventListener('close', () => {
      if (this.dialog.open) return;
      this.drag.cancel();
      this.alert.replaceChildren();
      this.item.close();
      const back = this.returnTo;
      this.returnTo = null;
      if (back?.isConnected) back.focus();
      // Nothing to go back to: focus must not stay on a card of the dialog that just closed (the scene takes the keys).
      else if (document.activeElement instanceof HTMLElement && this.dialog.contains(document.activeElement)) document.activeElement.blur();
    });
    this.item.addEventListener('close', () => {
      // The event is queued: an item opened again meanwhile is not the one that closed.
      if (this.item.open) return;
      this.itemId = null;
      this.gen++;
      this.busy = null;
      this.closing = null;
      this.merging = null;
    });
    this.item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target === this.commentBox) {
        e.preventDefault();
        void this.postComment();
      }
    });
    // Links in a body go to the user's browser, not into this window.
    this.item.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement | null)?.closest('a[href]');
      if (!(a instanceof HTMLAnchorElement)) return;
      e.preventDefault();
      this.host.external(a.href);
    });
    parent.append(this.dialog, this.item);
  }

  get isOpen(): boolean {
    return this.dialog.open || this.item.open;
  }

  close(): void {
    if (this.item.open) this.item.close();
    if (this.dialog.open) this.dialog.close();
  }

  // ---- opening ----------------------------------------------------------------------------------

  /** A card being dragged goes back where it was, with no drop (the command palette opened over the board). */
  cancelDrag(): void {
    this.drag.cancel();
  }

  open(which: Which, session: string): void {
    if (!this.dialog.open) {
      const a = document.activeElement;
      this.returnTo = a instanceof HTMLElement && a !== document.body ? a : null;
    }
    this.drag.cancel();
    if (session !== this.session) this.moves.clear();
    if (session !== this.session || which !== this.which) this.alert.replaceChildren();
    const fresh = !this.dialog.open || session !== this.session || which !== this.which;
    this.which = which;
    this.session = session;
    if (this.item.open) this.item.close();
    this.render();
    // Another list starts at its top; a redraw of the same one (refresh) keeps where it was scrolled to.
    if (fresh) {
      this.body.scrollTop = 0;
      this.body.scrollLeft = 0;
    }
    if (!this.dialog.open) this.dialog.showModal();
    (this.body.querySelector<HTMLElement>('.bd-card, .bd-pr') ?? this.head.querySelector<HTMLElement>('[data-key="close"]'))?.focus();
  }

  /** The board's data changed (a poll, a world event): the lists redraw; an open item follows its card. */
  refresh(): void {
    if (!this.dialog.open) return;
    if (!this.host.session() || this.host.session() !== this.session) {
      // The floor is not the one you are on any more.
      const s = this.host.session();
      if (!s) {
        this.close();
        return;
      }
      this.drag.cancel();
      this.moves.clear();
      this.alert.replaceChildren();
      this.session = s;
    }
    this.settleMoves();
    this.render();
    if (this.item.open) this.renderItem();
  }

  private state(): BoardState {
    return this.host.state(this.session);
  }

  private message(): BoardIssues | BoardPrs | null {
    const s = this.state();
    return this.which === 'issues' ? s.issues : s.prs;
  }

  private providerName(): string {
    const s = this.state();
    return (s.issues ?? s.prs)?.provider_name ?? 'The provider';
  }

  // ---- the overlay ---------------------------------------------------------------------------------

  /** Redraws the lists; the scroller keeps its place (an emptied scroller may clamp to 0, a refocused card may scroll itself into view). */
  private render(): void {
    const { scrollTop, scrollLeft } = this.body;
    this.draw();
    this.body.scrollTop = scrollTop;
    this.body.scrollLeft = scrollLeft;
  }

  private draw(): void {
    const st = this.state();
    const m = this.message();
    const name = m?.provider_name ?? '';
    const workers = this.host.store.floorView(this.session)?.workers ?? [];
    const title = this.which === 'issues' ? 'Issues' : 'Pull requests';
    const count = this.which === 'issues' ? (st.issues?.cards.filter((c) => c.state === 'open').length ?? 0) : (st.prs?.prs.length ?? 0);
    const sub = m && m.fetched_at ? `${this.session}${name ? ` · ${name}` : ''} · ${count} open · updated ${timeAgo(m.fetched_at, this.host.now()) || 'just now'}` : `${this.session}${name ? ` · ${name}` : ''}`;
    this.head.replaceChildren(
      h('div', { class: 'dd-plate dd-plate--board', 'aria-hidden': 'true' }, icon(GLYPH[this.which])),
      h('div', { class: 'dd-titles' }, h('h2', { id: 'board-title' }, `${title} · ${this.session}`), h('p', { id: 'board-sub' }, sub)),
      h(
        'button',
        { class: 'btn btn--icon', 'data-key': 'refresh', title: `Ask ${name || 'the provider'} for the latest now`, 'aria-label': 'Refresh', disabled: !m || undefined, onclick: () => this.host.refresh(this.session) },
        icon(GLYPH.refresh),
      ),
      h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close)),
    );
    const notes: string[] = [];
    if (m) {
      const f = freshness(m, this.host.now(), clock);
      if (f) notes.push(f);
    }
    this.notice.hidden = notes.length === 0;
    this.notice.textContent = notes.join(' ');
    this.notice.dataset.tone = m?.stale ? 'warn' : 'info';

    // The columns go away under a live drag: it ends, dropping nothing.
    if (st.off || !m || (m.fetched_at === 0 && count === 0) || this.which !== 'issues') this.drag.cancel();
    if (st.off) {
      this.body.replaceChildren(h('div', { class: 'bd-off' }, h('h3', {}, st.off.text), st.off.sub ? h('p', {}, st.off.sub) : null));
      return;
    }
    if (!m || (m.fetched_at === 0 && count === 0)) {
      this.body.replaceChildren(h('div', { class: 'bd-off' }, h('h3', {}, `Waiting for ${name || 'the provider'}…`), h('p', {}, 'herdr-world is fetching the board; it appears here as soon as it has it.')));
      return;
    }
    if (this.which === 'issues') this.renderIssues(st.issues as BoardIssues, workers);
    else this.renderPrs(st.prs as BoardPrs, st.issues, workers);
  }

  private renderIssues(m: BoardIssues, workers: readonly WorkerView[]): void {
    // A live drag keeps the columns it measures: what came meanwhile is drawn when it ends.
    if (this.drag.active) {
      this.held = true;
      return;
    }
    const cols = this.issueViews(m);
    const holders = holdersOf(m.cards, workers);
    // A card can land in any status column but "No status" (it can leave it).
    const drops = m.cards.some((c) => can(m, c, 'set_status'));
    const nodes = cols.map((c) =>
      h(
        'section',
        { class: 'bd-col', 'data-done': c.done ? 'true' : null, 'data-col': c.id, 'data-drop': drops && c.id !== '' ? 'true' : null, 'aria-label': `${c.name}, ${c.cards.length}` },
        h('h3', { class: 'bd-col-head' }, h('span', {}, c.name), h('b', {}, String(c.cards.length))),
        h(
          'div',
          { class: 'bd-col-cards' },
          ...(c.cards.length ? c.cards.map((card) => this.issueButton(card, holders.get(card.id) ?? null)) : [h('p', { class: 'bd-empty' }, 'Nothing here')]),
        ),
      ),
    );
    replaceKeepingFocus(this.body, [h('div', { class: 'bd-cols' }, ...nodes)]);
  }

  private issueButton(card: IssueCard, holder: { id: string; name: string } | null): HTMLElement {
    const meta = h('div', { class: 'bd-card-meta' });
    if (card.priority) meta.append(h('span', { class: `tape tape--prio tape--prio-${card.priority}` }, PRIORITY_WORD[card.priority]));
    // A button inside the card's button is not valid, so the tag is a link by role; the modal's is a real button (keyboard).
    if (holder) {
      meta.append(
        h(
          'span',
          {
            class: 'bd-holder bd-holder--go',
            role: 'link',
            'data-key': `holder:${card.id}`,
            title: `${holder.name} is working on it: go to their transcript`,
            onclick: (e: Event) => {
              e.stopPropagation();
              this.host.goTo(holder.id);
            },
          },
          holder.name,
        ),
      );
    }
    for (const a of card.assignees.slice(0, 2)) meta.append(h('span', { class: 'bd-assignee' }, a.name));
    const pending = this.moves.get(card.id);
    const b = h(
      'button',
      {
        class: 'bd-card',
        'data-key': `card:${card.id}`,
        'data-id': card.id,
        'data-state': card.state,
        'data-drag': can(this.state().issues, card, 'set_status') ? 'true' : null,
        'data-moving': pending && !pending.acked ? 'true' : null,
        onclick: (e: Event) => this.openIssue(card.id, e.currentTarget as HTMLElement),
      },
      h('span', { class: 'bd-pin', 'aria-hidden': 'true' }),
      h('span', { class: 'bd-card-top' }, h('span', { class: 'bd-key' }, card.key), card.state === 'closed' ? h('span', { class: 'bd-closed' }, 'closed') : null),
      h('span', { class: 'bd-card-title' }, card.title),
      card.labels.length ? h('span', { class: 'bd-labels' }, ...card.labels.map(labelChip)) : null,
      meta.childElementCount ? meta : null,
    );
    // The wall's paper and pin, so a note and its card read as one thing.
    b.style.setProperty('--paper', paperOf(card));
    b.style.setProperty('--pin', pinOf(card));
    return b;
  }

  // ---- #52: moving cards by dragging them ---------------------------------------------------------------

  /** The columns as the board says, with the moves the bridge has not shown yet applied. */
  private issueViews(m: BoardIssues): ColumnView[] {
    if (!this.moves.size) return columnViews(m);
    const moves = [...this.moves.values()];
    const to = new Map(moves.map((x) => [x.id, x.column]));
    const cards = m.cards.map((c) => (to.has(c.id) ? { ...c, column: to.get(c.id) as string } : c));
    return placeMoves(columnViews({ columns: m.columns, cards }), moves);
  }

  private canDrag(id: string): boolean {
    const board = this.state().issues;
    const card = board?.cards.find((c) => c.id === id);
    // One write per card at a time.
    return this.which === 'issues' && !this.item.open && !!card && can(board, card, 'set_status') && !(this.moves.get(id) && !this.moves.get(id)?.acked);
  }

  private dropCard(id: string, column: string, after: string | null | undefined): void {
    const board = this.state().issues;
    const card = board?.cards.find((c) => c.id === id);
    if (!board || !card) return;
    const session = this.session;
    const move: Move = { id, column, ...(after !== undefined ? { after } : {}), seq: ++this.moveSeq, acked: false, seen: null, until: 0 };
    this.moves.delete(id);
    this.moves.set(id, move);
    this.render();
    const args = { session, id, column, ...(after !== undefined ? { after } : {}) };
    // In order: a drop can be anchored on a card that the one before it moved.
    this.writes = this.writes.then(async () => {
      const r = await this.host.send('issue.set_status', args);
      if (this.moves.get(id) !== move || this.session !== session) return;
      if (!r.ok) {
        this.moves.delete(id);
        const text = failureText('issue.set_status', r.code, r.message, { item: card.key, provider: this.providerName() });
        if (this.dialog.open) this.moveFailed(id, text);
        else this.host.toast(text, 'error');
      } else {
        move.acked = true;
        move.seen = this.state().issues;
        move.until = this.host.now() + MOVE_HOLD_MS;
        window.setTimeout(() => this.refresh(), MOVE_HOLD_MS + 50);
      }
      if (this.dialog.open) this.render();
    });
  }

  /** A drop that did not land says why above the columns, until it is dismissed or the next drag starts. */
  private moveFailed(id: string, text: string): void {
    const dismiss = () => {
      this.alert.replaceChildren();
      this.body.querySelector<HTMLElement>(`.bd-card[data-id="${CSS.escape(id)}"]`)?.focus();
    };
    this.alert.replaceChildren(h('p', { class: 'bd-alert-text', role: 'alert' }, text), h('button', { class: 'btn btn--sm', 'data-key': 'dismiss-move-error', onclick: dismiss }, 'Dismiss'));
  }

  /** Forgets the moves a board polled after their write shows, and the ones held long enough. */
  private settleMoves(): void {
    if (!this.moves.size) return;
    const board = this.state().issues;
    const now = this.host.now();
    const views = board ? columnViews(board) : [];
    for (const [id, m] of this.moves) {
      if (!m.acked) continue;
      const fresh = board !== null && board !== m.seen && !board.initial;
      if (now >= m.until || (fresh && showsMove(views, m))) this.moves.delete(id);
    }
  }

  private renderPrs(m: BoardPrs, issues: BoardIssues | null, workers: readonly WorkerView[]): void {
    const keys = keysById(issues);
    const rows = m.prs.length
      ? m.prs.map((pr) => this.prRow(pr, closesText(pr.closes, keys), verdictOf(pr, workers)))
      : [h('div', { class: 'bd-off' }, h('h3', {}, 'No open pull requests'), h('p', {}, `${m.provider_name} has none for this floor’s repository right now.`))];
    replaceKeepingFocus(this.body, [h('div', { class: 'bd-prs' }, ...rows)]);
  }

  private prRow(pr: PullRequest, closes: string, stamp: { tone: string; text: string } | null): HTMLElement {
    return h(
      'button',
      { class: 'bd-pr', 'data-key': `pr:${pr.id}`, 'data-id': pr.id, onclick: (e: Event) => this.openPr(pr.id, e.currentTarget as HTMLElement) },
      h('span', { class: 'bd-key' }, pr.key),
      h('span', { class: 'bd-pr-main' }, h('span', { class: 'bd-card-title' }, pr.draft ? `[draft] ${pr.title}` : pr.title), h('span', { class: 'bd-pr-sub' }, pr.head_branch, closes ? ` · ${closes}` : '')),
      h('span', { class: `bd-ci bd-ci--${pr.checks}`, title: CHECKS_WORD[pr.checks] }, h('i', { 'aria-hidden': 'true' }), CHECKS_WORD[pr.checks]),
      h('span', { class: `bd-review bd-review--${pr.review}` }, REVIEW_WORD[pr.review]),
      stamp ? h('span', { class: `bd-stamp bd-stamp--${stamp.tone}` }, stamp.text.replace('_', ' ')) : null,
    );
  }

  // ---- an item -----------------------------------------------------------------------------------------

  private resetItem(id: string, from: HTMLElement | null): void {
    this.itemId = id;
    this.gen++;
    this.busy = null;
    this.closing = null;
    this.merging = null;
    this.actionError = '';
    this.extraComments = [];
    this.moveTo = '';
    this.commentBox.value = '';
    this.issueDetail = { state: 'loading' };
    this.prDetail = { state: 'loading' };
    if (from) this.returnTo = this.returnTo ?? from;
  }

  private openIssue(id: string, from: HTMLElement | null = null): void {
    this.resetItem(id, from);
    this.renderItem();
    if (!this.item.open) this.item.showModal();
    void this.loadIssue(id);
  }

  private openPr(id: string, from: HTMLElement | null = null): void {
    this.resetItem(id, from);
    this.renderItem();
    if (!this.item.open) this.item.showModal();
    void this.loadPr(id);
  }

  /** Opens an item's modal directly (from a note on the wall, or a test). */
  openItem(which: Which, session: string, id: string): void {
    this.open(which, session);
    if (which === 'issues') this.openIssue(id);
    else this.openPr(id);
  }

  private async loadIssue(id: string): Promise<void> {
    const gen = this.gen;
    const r = await this.host.send('issue.get', { session: this.session, id });
    if (gen !== this.gen || !this.item.open) return;
    this.issueDetail = r.ok ? { state: 'ready', data: r.data as IssueDetail } : { state: 'error', message: failureText('issue.get', r.code, r.message, { item: this.card()?.key, provider: this.providerName() }) };
    this.renderItem();
  }

  private async loadPr(id: string): Promise<void> {
    const gen = this.gen;
    const r = await this.host.send('pr.get', { session: this.session, id });
    if (gen !== this.gen || !this.item.open) return;
    this.prDetail = r.ok ? { state: 'ready', data: r.data as PrDetail } : { state: 'error', message: failureText('pr.get', r.code, r.message, { item: this.pr()?.key, provider: this.providerName() }) };
    this.renderItem();
  }

  /** The card as the board says now (else as the detail said). */
  private card(): IssueCard | null {
    const live = this.state().issues?.cards.find((c) => c.id === this.itemId);
    if (live) return live;
    return this.issueDetail.state === 'ready' ? this.issueDetail.data.card : null;
  }

  private pr(): PullRequest | null {
    const live = this.state().prs?.prs.find((p) => p.id === this.itemId);
    if (live) return live;
    return this.prDetail.state === 'ready' ? this.prDetail.data.pr : null;
  }

  private renderItem(): void {
    // A poll may redraw while a comment is being typed: the box is kept, and so is the caret.
    // The item's own scroll is kept too, and the box's (a detached textarea loses it).
    const typing = document.activeElement === this.commentBox;
    const at = [this.commentBox.selectionStart, this.commentBox.selectionEnd] as const;
    const { scrollTop, scrollLeft } = this.itemBody;
    const boxTop = this.commentBox.scrollTop;
    if (this.which === 'issues') this.renderIssueItem();
    else this.renderPrItem();
    this.itemBody.scrollTop = scrollTop;
    this.itemBody.scrollLeft = scrollLeft;
    if (typing && this.commentBox.isConnected) {
      this.commentBox.focus({ preventScroll: true });
      this.commentBox.setSelectionRange(at[0], at[1]);
    }
    this.commentBox.scrollTop = boxTop;
  }

  private detailState(): 'loading' | 'ready' | 'error' {
    return (this.which === 'issues' ? this.issueDetail : this.prDetail).state;
  }

  private commentsOf(): BoardComment[] {
    const d = this.which === 'issues' ? this.issueDetail : this.prDetail;
    return d.state === 'ready' ? [...d.data.comments, ...this.extraComments] : [];
  }

  private md(text: string): HTMLElement {
    const e = h('div', { class: 'bd-md' });
    setMarkdown(e, text);
    return e;
  }

  private commentsBlock(canComment: boolean): HTMLElement {
    const list = this.commentsOf();
    const d = this.which === 'issues' ? this.issueDetail : this.prDetail;
    const truncated = d.state === 'ready' && d.data.comments_truncated;
    const wrap = h('section', { class: 'bd-comments', 'aria-label': 'Comments' }, h('h3', {}, `Comments · ${list.length}${truncated ? '+' : ''}`));
    for (const c of list) {
      wrap.append(
        h('article', { class: 'bd-comment', 'data-id': c.id }, h('header', {}, h('b', {}, c.author.name), h('span', {}, timeAgo(c.created_at, this.host.now()))), this.md(c.body)),
      );
    }
    if (truncated) wrap.append(h('p', { class: 'bd-empty' }, `Only the first comments are shown; open it in ${this.providerName()} for the rest.`));
    if (!list.length && d.state === 'ready') wrap.append(h('p', { class: 'bd-empty' }, 'No comments yet.'));
    if (canComment) {
      wrap.append(
        h(
          'div',
          { class: 'bd-comment-form' },
          this.commentBox,
          h(
            'div',
            { class: 'bd-comment-actions' },
            h('span', { class: 'field-hint' }, h('kbd', {}, 'Ctrl'), '+', h('kbd', {}, 'Enter'), ' posts it.'),
            h('button', { class: 'btn', 'data-key': 'comment', onclick: () => void this.postComment(), 'aria-disabled': this.busy ? 'true' : null }, this.busy === 'comment' ? 'Posting…' : 'Comment'),
          ),
        ),
      );
    }
    return wrap;
  }

  private async postComment(): Promise<void> {
    const body = this.commentBox.value;
    const id = this.itemId;
    if (!id || this.busy) return;
    if (!body.trim()) {
      this.setError('Write something first.');
      return;
    }
    if (bytes(body) > 65_536) {
      this.setError('A comment is at most 64 KiB.');
      return;
    }
    const issue = this.which === 'issues';
    this.busy = 'comment';
    this.actionError = '';
    this.renderItem();
    const key = (issue ? this.card()?.key : this.pr()?.key) ?? 'it';
    const r: CommandResult = issue ? await this.host.send('issue.comment', { session: this.session, id, body }) : await this.host.send('pr.comment', { session: this.session, id, body });
    this.busy = null;
    if (id !== this.itemId) return;
    if (r.ok) {
      const c = (r.data as CommentAck | undefined)?.comment;
      if (c) this.extraComments.push(c);
      this.commentBox.value = '';
      this.host.toast(`Commented on ${key}.`, 'info');
      this.renderItem();
      return;
    }
    this.setError(failureText(issue ? 'issue.comment' : 'pr.comment', r.code, r.message, { item: key, provider: this.providerName() }));
  }

  private setError(msg: string): void {
    this.actionError = msg;
    this.renderItem();
  }

  private labelsRow(labels: BoardLabel[]): HTMLElement | null {
    return labels.length ? h('div', { class: 'bd-labels' }, ...labels.map(labelChip)) : null;
  }

  // ---- an issue ----------------------------------------------------------------------------------------------

  private renderIssueItem(): void {
    const card = this.card();
    const board = this.state().issues;
    const d = this.issueDetail;
    const name = this.providerName();
    if (!card) {
      this.itemHead.replaceChildren(h('div', { class: 'dd-titles' }, h('h2', { id: 'item-title' }, 'Issue')), closeButton(() => this.item.close()));
      this.itemBody.replaceChildren(h('p', { class: 'bd-empty' }, d.state === 'error' ? d.message : 'Loading…'));
      this.itemFoot.replaceChildren();
      return;
    }
    const col = board?.columns.find((c) => c.id === card.column);
    const author = d.state === 'ready' ? d.data.author.name : (card.author ?? '');
    const created = d.state === 'ready' ? timeAgo(d.data.created_at, this.host.now()) : '';
    this.itemHead.replaceChildren(
      h(
        'div',
        { class: 'dd-titles' },
        h('h2', { id: 'item-title' }, card.title),
        h('p', {}, `${card.key} · ${card.state === 'open' ? 'open' : 'closed'}${col ? ` · ${col.name}` : ''}${author ? ` · ${author}` : ''}${created ? ` · ${created}` : ''}`),
      ),
      closeButton(() => this.item.close()),
    );
    const body: Node[] = [];
    const meta = h('div', { class: 'bd-meta' }, h('span', { class: `tape tape--state tape--${card.state}` }, card.state === 'open' ? 'Open' : 'Closed'));
    if (col) meta.append(h('span', { class: 'tape tape--note' }, col.name));
    if (card.priority) meta.append(h('span', { class: `tape tape--prio tape--prio-${card.priority}` }, PRIORITY_WORD[card.priority]));
    const holder = holdersOf([card], this.host.store.floorView(this.session)?.workers ?? []).get(card.id);
    if (holder) {
      meta.append(
        h('button', { class: 'bd-holder bd-holder--go', type: 'button', 'data-key': 'holder', title: `Go to ${holder.name}'s transcript`, onclick: () => this.host.goTo(holder.id) }, `${holder.name} is on it`),
      );
    }
    for (const a of card.assignees) meta.append(h('span', { class: 'bd-assignee' }, `@${a.name}`));
    body.push(meta);
    const labels = this.labelsRow(card.labels);
    if (labels) body.push(labels);
    if (d.state === 'loading') body.push(h('p', { class: 'bd-loading' }, `Reading it from ${name}…`));
    else if (d.state === 'error') body.push(h('p', { class: 'bd-error', role: 'alert' }, d.message), h('button', { class: 'btn btn--sm', 'data-key': 'retry', onclick: () => void this.retryLoad() }, 'Try again'));
    else body.push(this.md(d.data.body || '_No description._'));
    body.push(this.commentsBlock(can(board, card, 'comment') && d.state === 'ready'));
    this.itemBody.replaceChildren(...body);
    this.renderIssueFoot(card);
  }

  private async retryLoad(): Promise<void> {
    if (!this.itemId) return;
    this.which === 'issues' ? ((this.issueDetail = { state: 'loading' }), this.renderItem(), await this.loadIssue(this.itemId)) : ((this.prDetail = { state: 'loading' }), this.renderItem(), await this.loadPr(this.itemId));
  }

  private renderIssueFoot(card: IssueCard): void {
    const board = this.state().issues;
    const name = this.providerName();
    const session = this.session;
    const busy = this.busy;
    const notices: Node[] = [];
    if (this.actionError) notices.push(h('p', { class: 'dd-status dd-status--error', role: 'alert' }, this.actionError));
    const actions: HTMLElement[] = [];
    const open = card.state === 'open';
    const noRun = this.host.whyNoRun(session);
    const noHire = this.host.whyNoHire(session);
    const btn = (key: string, label: string, onclick: () => void, o: { cls?: string; why?: string | null; title?: string } = {}) =>
      h(
        'button',
        { class: `btn${o.cls ? ` ${o.cls}` : ''}`, 'data-key': key, title: o.why ?? o.title ?? label, 'aria-disabled': o.why || busy ? 'true' : null, onclick: () => (o.why ? this.setError(o.why) : busy ? undefined : onclick()) },
        label,
      );
    if (open) actions.push(btn('hand', 'Hand to a worker', () => this.host.handTo(session, card, board?.provider ?? ''), { cls: 'btn--primary', why: noRun, title: 'Start a run on this issue at the free desk nearest to you' }));
    if (open) actions.push(btn('ask', 'Ask a worker…', () => this.host.ask(session, card), { why: noHire, title: 'Hire a worker to look into it and report back, without changing code' }));
    if (can(board, card, 'set_status') && board) {
      const cols = board.columns.filter((c) => c.id !== '' && c.id !== card.column);
      if (cols.length) {
        const sel = h('select', { 'data-key': 'move-to', 'aria-label': 'Move to column', onchange: (e: Event) => (this.moveTo = (e.target as HTMLSelectElement).value) });
        sel.append(h('option', { value: '' }, 'Move to…'));
        for (const c of cols) sel.append(h('option', { value: c.id, selected: c.id === this.moveTo ? true : null }, c.name));
        actions.push(h('span', { class: 'bd-move' }, sel, btn('move', 'Move', () => void this.move(card), {})));
      }
    }
    if (open && can(board, card, 'close')) actions.push(btn('close-issue', 'Close issue…', () => ((this.closing = this.closing ? null : 'completed'), this.renderItem()), { cls: 'btn--quiet' }));
    if (card.url) actions.push(btn('open', `Open in ${name}`, () => this.host.external(card.url as string), { cls: 'btn--quiet' }));
    if (this.closing) notices.unshift(this.closeConfirm(card));
    this.itemFoot.replaceChildren(h('div', { class: 'bd-notices' }, ...notices), h('div', { class: 'dd-actions bd-actions' }, ...actions));
  }

  private closeConfirm(card: IssueCard): HTMLElement {
    const reason = this.closing ?? 'completed';
    const radios = CLOSE_REASONS.map((r) => {
      const input = h('input', { type: 'radio', name: 'close-reason', value: r.id, 'data-key': `reason:${r.id}` });
      input.checked = r.id === reason;
      input.addEventListener('change', () => {
        this.closing = r.id;
        this.renderItem();
      });
      return h('label', { class: 'dd-chip' }, input, h('span', {}, r.label));
    });
    return h(
      'div',
      { class: 'bd-confirm', role: 'group', 'aria-label': `Close ${card.key}` },
      h('p', {}, `Close ${card.key} on ${this.providerName()}? Say why:`),
      h('fieldset', { class: 'dd-pick' }, h('legend', { class: 'visually-hidden' }, 'Reason'), h('div', { class: 'dd-chips' }, ...radios)),
      h(
        'div',
        { class: 'bd-confirm-actions' },
        h('button', { class: 'btn', 'data-key': 'close-cancel', onclick: () => ((this.closing = null), this.renderItem()) }, 'Keep it open'),
        h('button', { class: 'btn btn--danger', 'data-key': 'close-confirm', 'aria-disabled': this.busy ? 'true' : null, onclick: () => void this.closeIssue(card) }, this.busy === 'close' ? 'Closing…' : `Close ${card.key}`),
      ),
    );
  }

  private async closeIssue(card: IssueCard): Promise<void> {
    if (this.busy || !this.closing) return;
    const reason = this.closing;
    this.busy = 'close';
    this.actionError = '';
    this.renderItem();
    const r = await this.host.send('issue.close', { session: this.session, id: card.id, reason, confirm: true });
    this.busy = null;
    if (card.id !== this.itemId) return;
    if (r.ok) {
      this.host.toast(`Closed ${card.key}.`, 'info');
      this.item.close();
      return;
    }
    this.closing = null;
    this.setError(failureText('issue.close', r.code, r.message, { item: card.key, provider: this.providerName() }));
  }

  private async move(card: IssueCard): Promise<void> {
    if (!this.moveTo) {
      this.setError('Pick a column first.');
      return;
    }
    const board = this.state().issues;
    const to = this.moveTo;
    const colName = board?.columns.find((c) => c.id === to)?.name ?? 'that column';
    this.busy = 'move';
    this.actionError = '';
    this.renderItem();
    const r = await this.host.send('issue.set_status', { session: this.session, id: card.id, column: to });
    this.busy = null;
    if (card.id !== this.itemId) return;
    this.moveTo = '';
    if (r.ok) {
      this.host.toast(`Moved ${card.key} to ${colName}.`, 'info');
      this.renderItem();
      return;
    }
    this.setError(failureText('issue.set_status', r.code, r.message, { item: card.key, provider: this.providerName() }));
  }

  // ---- a pull request -----------------------------------------------------------------------------------------------

  private renderPrItem(): void {
    const pr = this.pr();
    const d = this.prDetail;
    const name = this.providerName();
    if (!pr) {
      this.itemHead.replaceChildren(h('div', { class: 'dd-titles' }, h('h2', { id: 'item-title' }, 'Pull request')), closeButton(() => this.item.close()));
      this.itemBody.replaceChildren(h('p', { class: 'bd-empty' }, d.state === 'error' ? d.message : 'Loading…'));
      this.itemFoot.replaceChildren();
      return;
    }
    const author = d.state === 'ready' ? d.data.author.name : (pr.author ?? '');
    this.itemHead.replaceChildren(
      h('div', { class: 'dd-titles' }, h('h2', { id: 'item-title' }, pr.title), h('p', {}, `${pr.key} · ${pr.head_branch} → ${pr.base_branch ?? '…'}${author ? ` · ${author}` : ''}`)),
      closeButton(() => this.item.close()),
    );
    const issues = this.state().issues;
    const closes = closesText(pr.closes, keysById(issues));
    const workers = this.host.store.floorView(this.session)?.workers ?? [];
    const stamp = verdictOf(pr, workers);
    const meta = h(
      'div',
      { class: 'bd-meta' },
      h('span', { class: `bd-ci bd-ci--${pr.checks}` }, h('i', { 'aria-hidden': 'true' }), CHECKS_WORD[pr.checks]),
      h('span', { class: `bd-review bd-review--${pr.review}` }, REVIEW_WORD[pr.review]),
      h('span', { class: `bd-merge bd-merge--${pr.mergeable}` }, MERGEABLE_WORD[pr.mergeable]),
      pr.draft ? h('span', { class: 'tape tape--note' }, 'Draft') : null,
      closes ? h('span', { class: 'bd-closes' }, closes) : null,
      stamp ? h('span', { class: `bd-stamp bd-stamp--${stamp.tone}` }, stamp.text.replace('_', ' ')) : null,
      pr.additions !== undefined ? h('span', { class: 'bd-diffstat' }, h('b', { class: 'plus' }, `+${pr.additions}`), ' ', h('b', { class: 'minus' }, `−${pr.deletions ?? 0}`), ` in ${pr.changed_files ?? '?'} files`) : null,
    );
    const body: Node[] = [meta];
    if (d.state === 'loading') body.push(h('p', { class: 'bd-loading' }, `Reading it from ${name}…`));
    else if (d.state === 'error') body.push(h('p', { class: 'bd-error', role: 'alert' }, d.message), h('button', { class: 'btn btn--sm', 'data-key': 'retry', onclick: () => void this.retryLoad() }, 'Try again'));
    else {
      const data = d.data;
      if (data.checks.length) {
        body.push(
          h(
            'section',
            { class: 'bd-checks', 'aria-label': 'Checks' },
            h('h3', {}, 'Checks'),
            h('ul', {}, ...data.checks.map((c) => h('li', { 'data-state': c.state }, h('i', { 'aria-hidden': 'true' }), c.url ? h('a', { href: c.url, rel: 'noopener noreferrer' }, c.name) : c.name, h('span', {}, c.state)))),
          ),
        );
      }
      body.push(
        h(
          'section',
          { class: 'bd-files', 'aria-label': 'Files changed' },
          h('h3', {}, `Files changed · ${data.files.length}${data.files_truncated ? '+' : ''}`),
          h('ul', {}, ...data.files.map((f) => h('li', {}, h('code', {}, f.path), h('span', {}, h('b', { class: 'plus' }, `+${f.additions}`), ' ', h('b', { class: 'minus' }, `−${f.deletions}`))))),
        ),
      );
      body.push(this.md(data.body || '_No description._'));
    }
    body.push(this.commentsBlock(can(this.state().prs, pr, 'comment') && d.state === 'ready'));
    this.itemBody.replaceChildren(...body);
    this.renderPrFoot(pr);
  }

  private renderPrFoot(pr: PullRequest): void {
    const board = this.state().prs;
    const name = this.providerName();
    const session = this.session;
    const busy = this.busy;
    const notices: Node[] = [];
    if (this.actionError) notices.push(h('p', { class: 'dd-status dd-status--error', role: 'alert' }, this.actionError));
    const btn = (key: string, label: string, onclick: () => void, o: { cls?: string; why?: string | null; title?: string } = {}) =>
      h(
        'button',
        { class: `btn${o.cls ? ` ${o.cls}` : ''}`, 'data-key': key, title: o.why ?? o.title ?? label, 'aria-disabled': o.why || busy ? 'true' : null, onclick: () => (o.why ? this.setError(o.why) : busy ? undefined : onclick()) },
        label,
      );
    const actions: HTMLElement[] = [];
    const noHire = this.host.whyNoHire(session);
    actions.push(btn('review', 'Review with a worker', () => this.host.review(session, pr), { cls: 'btn--primary', why: noHire, title: 'Hire a reviewer with the last team’s reviewer model' }));
    if (can(board, pr, 'comment')) actions.push(btn('comment-focus', 'Comment', () => this.commentBox.focus(), { title: 'Write a comment below' }));
    if (can(board, pr, 'merge')) {
      const blocker = mergeBlocker(pr);
      const sel = h('select', { 'data-key': 'merge-method', 'aria-label': 'Merge method', onchange: (e: Event) => (this.method = (e.target as HTMLSelectElement).value as MergeMethod) });
      for (const m of MERGE_METHODS) sel.append(h('option', { value: m.id, selected: m.id === this.method ? true : null }, m.label));
      actions.push(
        h(
          'span',
          { class: 'bd-move' },
          sel,
          btn('merge', 'Merge…', () => ((this.merging = { step: 'confirm', method: this.method }), this.renderItem()), { cls: 'btn--quiet', why: blocker?.why ?? null }),
          blocker?.overridable ? btn('merge-anyway', 'Merge anyway…', () => ((this.merging = { step: 'override1', method: this.method }), this.renderItem()), { cls: 'btn--quiet btn--warn', title: 'Merge although it is not ready: asks twice' }) : null,
        ),
      );
    }
    if (pr.url) actions.push(btn('open', `Open in ${name}`, () => this.host.external(pr.url as string), { cls: 'btn--quiet' }));
    if (this.merging) notices.unshift(this.mergeConfirm(pr, this.merging));
    this.itemFoot.replaceChildren(h('div', { class: 'bd-notices' }, ...notices), h('div', { class: 'dd-actions bd-actions' }, ...actions));
  }

  private mergeConfirm(pr: PullRequest, m: MergeStep): HTMLElement {
    const how = MERGE_METHODS.find((x) => x.id === m.method)?.label.toLowerCase() ?? m.method;
    const blocker = mergeBlocker(pr);
    const cancel = h('button', { class: 'btn', 'data-key': 'merge-cancel', onclick: () => ((this.merging = null), this.renderItem()) }, 'Not now');
    if (m.step === 'confirm') {
      return h(
        'div',
        { class: 'bd-confirm', role: 'group', 'aria-label': `Merge ${pr.key}` },
        h('p', {}, `Merge ${pr.key} into ${pr.base_branch ?? 'its base'} (${how})? This can’t be undone from here.`),
        h('div', { class: 'bd-confirm-actions' }, cancel, h('button', { class: 'btn btn--danger', 'data-key': 'merge-confirm', 'aria-disabled': this.busy ? 'true' : null, onclick: () => void this.mergeNow(pr, m, false) }, this.busy === 'merge' ? 'Merging…' : `Merge ${pr.key}`)),
      );
    }
    if (m.step === 'override1') {
      return h(
        'div',
        { class: 'bd-confirm bd-confirm--warn', role: 'group', 'aria-label': `Merge ${pr.key} anyway` },
        h('p', {}, blocker?.why ?? `${pr.key} is not ready.`, ' Merging it now skips what the repository asked for.'),
        h('div', { class: 'bd-confirm-actions' }, cancel, h('button', { class: 'btn btn--warn', 'data-key': 'merge-override-1', onclick: () => ((this.merging = { ...m, step: 'override2' }), this.renderItem()) }, 'I understand, continue…')),
      );
    }
    return h(
      'div',
      { class: 'bd-confirm bd-confirm--warn', role: 'group', 'aria-label': `Really merge ${pr.key} anyway` },
      h('p', {}, h('b', {}, `Really merge ${pr.key} (${how}) although it is not ready?`), ' Second confirmation: this is recorded in the audit log as an override.'),
      h('div', { class: 'bd-confirm-actions' }, cancel, h('button', { class: 'btn btn--danger', 'data-key': 'merge-override-2', 'aria-disabled': this.busy ? 'true' : null, onclick: () => void this.mergeNow(pr, m, true) }, this.busy === 'merge' ? 'Merging…' : `Merge ${pr.key} anyway`)),
    );
  }

  private async mergeNow(pr: PullRequest, m: MergeStep, override: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = 'merge';
    this.actionError = '';
    this.renderItem();
    const args = { session: this.session, id: pr.id, method: m.method, confirm: true as const, ...(override ? { override: true, confirm_override: true as const } : {}) };
    const r = await this.host.send('pr.merge', args);
    this.busy = null;
    if (pr.id !== this.itemId) return;
    if (r.ok) {
      this.host.toast(`Merged ${pr.key}.`, 'info');
      this.item.close();
      return;
    }
    this.merging = null;
    this.setError(failureText('pr.merge', r.code, r.message, { item: pr.key, provider: this.providerName() }));
  }

  // ---- test hook -------------------------------------------------------------------------------------------------------

  summary(): BoardSummary | null {
    if (!this.dialog.open) return null;
    const st = this.state();
    const m = this.message();
    const columns =
      this.which === 'issues'
        ? st.issues
          ? this.issueViews(st.issues).map((c) => ({ id: c.id, name: c.name, keys: c.cards.map((x) => x.key) }))
          : []
        : [{ id: '', name: 'Open', keys: st.prs?.prs.map((p) => p.key) ?? [] }];
    let item: ItemSummary | null = null;
    if (this.item.open && this.itemId) {
      const c = this.which === 'issues' ? this.card() : this.pr();
      const d = this.which === 'issues' ? this.issueDetail : this.prDetail;
      item = {
        kind: this.which === 'issues' ? 'issue' : 'pr',
        id: this.itemId,
        key: c?.key ?? '',
        title: c?.title ?? '',
        state: d.state,
        error: d.state === 'error' ? d.message : null,
        actions: [...this.itemFoot.querySelectorAll<HTMLElement>('.bd-actions [data-key]')].map((e) => e.dataset.key ?? ''),
        confirm: this.itemFoot.querySelector<HTMLElement>('.bd-confirm')?.getAttribute('aria-label') ?? null,
        comments: this.commentsOf().length,
        busy: this.busy,
        bodyText: this.itemBody.querySelector('.bd-md')?.textContent ?? '',
      };
    }
    return {
      kind: this.which,
      session: this.session,
      title: `${this.which === 'issues' ? 'Issues' : 'Pull requests'} · ${this.session}`,
      provider: m?.provider_name ?? '',
      columns,
      notice: this.notice.hidden ? null : (this.notice.textContent ?? ''),
      alert: this.alert.querySelector('.bd-alert-text')?.textContent ?? null,
      off: st.off ? st.off.text : null,
      item,
    };
  }
}

function labelChip(l: BoardLabel): HTMLElement {
  const e = h('span', { class: 'bd-label' }, l.name);
  e.style.setProperty('--c', l.color);
  e.style.setProperty('--ink', readableInk(l.color));
  return e;
}

function closeButton(onclick: () => void): HTMLElement {
  return h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick }, icon(ICON.close));
}
