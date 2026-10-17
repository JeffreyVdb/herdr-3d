/**
 * #118: the floor overview page. The lounge wall's big screen brought up to fill the whole viewport (E at the screen,
 * O anywhere on an office floor, the top bar's Overview): every worker of the floor as a departures board, orchestrators
 * with their freelancers nested under them (world/overview.ts builds the tree). It grows out of the wall screen's
 * rectangle on your view (or the centre for O) and shrinks back into it on Esc.
 *
 * Like the whiteboard overlay (ui/whiteboard.ts) it is a fixed `inset: 0` layer above everything, the top bar included,
 * never the browser's Fullscreen API (the shell is a Chrome `--app` window, and fullscreen Chrome takes Esc for itself).
 * While it is open the game behind it is inert and its keys are this page's (capture phase); a modal dialog it opens on
 * top (a row's ticket: the issue window) gets the keys and the pointer until it closes.
 *
 * Live: the app calls `refresh()` on every world change while it is open. Rows are keyed by worker id and updated in
 * place: a status change flashes the row in its new colour once, a new now line flips in, the order never follows a
 * status. Motion goes under `prefers-reduced-motion` and battery saver (`data-calm`): no cascade, flap or blink.
 *
 * #188: the same page shows **all floors** too (O in the city or a lobby, the top bar's City Overview, `a` on a
 * floor's page): every floor of the city as a row over its workers (`buildCityOverview`), out of the centre, never the
 * wall screen. Both views have a filter, **Active only / All** (`f`, remembered per view): the rows it hides fold away
 * like a collapse and the header says what it hides (a click shows them).
 *
 * #24: the workers' native child agents nest under them as quieter conversation rows (a diamond pip for a lamp), to any
 * depth: wires per level, the indent capped at `NEST_MAX` levels (deeper rows say their level), collapse and keys as for
 * any group. Activating one goes to its worker until #26 opens the child's own transcript (`OverviewHost.goToChild`).
 */

import { lineStatusText } from '../world/digestSettings';
import {
  ageText,
  aiTitle,
  allNodes,
  BLINK_MS,
  CHILD_TRANSCRIPT_WORD,
  childSince,
  childSinceText,
  endedChildGroups,
  filterOverview,
  hiddenText,
  sinceText,
  sleepyFloors,
  spanText,
  visibleRows,
  type CityOverviewData,
  type CountItem,
  type OverviewAnyRow,
  type OverviewChildRow,
  type OverviewData,
  type OverviewFloorRow,
  type OverviewLine,
  type OverviewRow,
  type OverviewWorkerRow,
  type VisibleRow,
} from '../world/overview';
import { STATUS_WORD } from '../world/derive';
import { harnessName, markSvg } from '../render/brandMarks';
import { h, icon, ICON, type Child } from './dom';
import { OverviewFilterPrefs, type OverviewPrefs } from './overviewPrefs';
import './overview.css';

/** The grow out of the wall screen, and back. */
const GROW_MS = 420;
/** A collapsing group's rows fold away under it this long (each a little after the one below it). */
const FOLD_MS = 300;
const FOLD_STAGGER_MS = 22;
/** #24: nesting levels the indent follows; a deeper row stays at this one and says its level. */
export const NEST_MAX = 4;

/** A rectangle on the viewport, in CSS pixels. */
export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}


export interface OverviewHost {
  data(floor: string): OverviewData | null;
  /** #188: every floor of the city. */
  cityData(): CityOverviewData;
  /** #188: a floor row: go to that floor (the page closes first). */
  goToFloor(floor: string): void;
  /** A worker row: sit at its laptop with its conversation on screen (`App.goToWorker(id, 'transcript')`). */
  goTo(id: string): void;
  /**
   * #24: a native child's row. Until #26 opens the child's own transcript it seats at the worker that owns it, with that
   * worker's conversation (`App.goToWorker(workerId, 'transcript')`).
   */
  goToChild(workerId: string, childId: string): void;
  /** A ticket: the in-game issue window over the page. */
  openTicket(floor: string, id: string): void;
  /** #174: ask again for a worker's summary lines that failed (`digest.retry`). */
  retrySummary(id: string): void;
  /** The empty floor's Hire. */
  hire(): void;
  /** Battery saver (B): no blinking. */
  calm(): boolean;
  /** Where the wall screen is on the view now (null: not in view): the close shrinks into it. */
  screenRect(floor: string): ViewRect | null;
  /** #58: a floor id's name (the head and its aria label never show an id). */
  floorName(floor: string): string;
  /** The page closed (the game takes keys again). */
  closed(): void;
  now?(): number;
}

/** What the page shows: a floor's workers, or every floor's (#188). */
export type OverviewView = { kind: 'floor'; floor: string } | { kind: 'city' };

/** What a test can read of the page. */
export interface OverviewInfo {
  open: boolean;
  /** The floor of a floor's page (null on the all-floors page). */
  floor: string | null;
  view: 'floor' | 'city' | null;
  /** #188: Active only or All. */
  filter: 'active' | 'all';
  /** #188: the header's line of what the filter hides (empty: nothing). */
  hidden: string;
  rows: Array<{ key: string; kind: OverviewAnyRow['kind']; depth: number; display: string | null; text: string; expanded: boolean | null }>;
  focused: string | null;
  empty: boolean;
  calm: boolean;
  /** Where the open began: the wall screen's rectangle, or null for the centre. */
  from: ViewRect | null;
}

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** A worker row has a failed AI line that a retry can try again (#174). */
const retriable = (r: OverviewWorkerRow): boolean => [r.task, r.now].some((l) => l?.status && l.status.state !== 'pending');

/** #188: an asleep floor's mark, a crescent (drawn: no glyph stands in for it). */
const MOON = '<path d="M15.5 4.2a7.6 7.6 0 1 0 4.3 11.1 6.2 6.2 0 0 1-4.3-11.1z"/>';

/** The row's own signature: it is rebuilt only when this changes (#24: its wires, `more`, too). */
function rowSig(v: VisibleRow): string {
  const r = v.row;
  return JSON.stringify([r, v.depth, v.expandable, v.expanded, v.more]);
}

export class OverviewOverlay {
  private readonly root: HTMLDivElement;
  private readonly floorEl: HTMLHeadingElement;
  private readonly whereEl: HTMLParagraphElement;
  private readonly countsEl: HTMLDivElement;
  private readonly board: HTMLDivElement;
  private readonly emptyEl: HTMLDivElement;
  private readonly cols: HTMLDivElement;
  /** #188: Active only / All, its hidden line, and the floor page's way to every floor. */
  private readonly filterEl: HTMLDivElement;
  private readonly hiddenEl: HTMLButtonElement;
  private readonly allFloorsBtn: HTMLButtonElement;
  private readonly emptyTitle: HTMLParagraphElement;
  private readonly emptyText: HTMLParagraphElement;
  private readonly hireBtn: HTMLButtonElement;
  private readonly showAllBtn: HTMLButtonElement;
  private view: OverviewView | null = null;
  private keysEl: HTMLElement | null = null;
  private from: ViewRect | null = null;
  private rows = new Map<string, { el: HTMLElement; sig: string; display: string | null; now: string | null }>();
  private visible: VisibleRow[] = [];
  private focusKey: string | null = null;
  private inerted: HTMLElement[] = [];
  private returnFocus: HTMLElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closing: Promise<void> | null = null;
  private anim: Animation | null = null;
  private readonly onKeyCapture = (e: KeyboardEvent) => this.keyCapture(e);
  /** How many rows each group holds (also while it is collapsed). */
  private sizes = new Map<string, number>();
  /** Rows folding away (a group just collapsed, or hidden by the filter; inert, out of the tree): their own key. */
  private leaving = new Map<HTMLElement, string>();
  /** #188: the groups collapsed by default (the asleep floors of the all-floors page; #24: an ended child's children). */
  private defaults = new Set<string>();
  /** Every expandable group of the tree as it is, filter or not (Expand all / Collapse all). */
  private groups: string[] = [];

  constructor(
    parent: HTMLElement,
    private readonly host: OverviewHost,
    private readonly prefs: OverviewPrefs,
    private readonly filter: OverviewFilterPrefs = new OverviewFilterPrefs(),
  ) {
    this.floorEl = h('h2', { class: 'ov-floor', id: 'ov-floor' });
    this.whereEl = h('p', { class: 'ov-where' });
    this.countsEl = h('div', { class: 'ov-counts', role: 'group', 'aria-label': 'Counts' });
    const expand = h('button', { class: 'ov-btn', title: 'Expand every group (Shift+→)', onclick: () => this.setAll(false) }, 'Expand all');
    const collapse = h('button', { class: 'ov-btn', title: 'Collapse every group (Shift+←)', onclick: () => this.setAll(true) }, 'Collapse all');
    const close = h('button', { class: 'ov-btn ov-btn--icon', 'aria-label': 'Close the overview (Esc)', title: 'Close (Esc)', onclick: () => void this.close() }, icon(ICON.close));
    this.allFloorsBtn = h(
      'button',
      { class: 'ov-btn ov-btn--floors', title: 'Every floor’s workers (A)', 'aria-label': 'All floors', 'aria-keyshortcuts': 'A', onclick: () => this.showCity() },
      icon('<rect x="5" y="3.5" width="14" height="17" rx="1.5"/><path d="M5 9.2h14M5 14.8h14"/>'),
      h('span', { class: 'ov-btn-label' }, 'All floors'),
      h('kbd', { 'aria-hidden': 'true' }, 'A'),
    );
    // Active only / All: a two-position switch (each a pressed button), and what it hides, which shows them all.
    const seg = (active: boolean, label: string) =>
      h('button', { class: 'ov-seg', 'aria-pressed': 'false', 'data-active': String(active), onclick: () => this.setFilter(active) }, label);
    this.filterEl = h(
      'div',
      { class: 'ov-filter', role: 'group', 'aria-label': 'Show (F)', title: 'Active only or everyone (F)' },
      h('span', { class: 'ov-switch' }, seg(true, 'Active only'), seg(false, 'All')),
      h('kbd', { 'aria-hidden': 'true' }, 'F'),
    );
    this.hiddenEl = h('button', { class: 'ov-hidden', hidden: true, onclick: () => this.setFilter(false) });
    this.cols = h(
      'div',
      { class: 'ov-cols', 'aria-hidden': 'true' },
      h('span', {}, ''),
      h('span', {}, 'Worker'),
      h('span', {}, 'Working on'),
      h('span', { class: 'ov-cols-since' }, 'Doing · for'),
    );
    this.board = h('div', { class: 'ov-board', role: 'tree', 'aria-labelledby': 'ov-floor' });
    this.board.addEventListener('click', (e) => this.onClick(e));
    this.board.addEventListener('focusin', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.ov-row');
      if (row?.dataset.key) this.setFocus(row.dataset.key, false);
    });
    this.hireBtn = h('button', { class: 'ov-btn ov-btn--go', onclick: () => this.hireHere() }, icon('<circle cx="9.5" cy="8" r="3.2"/><path d="M3.8 19.5c.6-3.4 2.8-5.3 5.7-5.3 1.4 0 2.6.4 3.6 1.2"/><path d="M18 13.5v6M15 16.5h6"/>'), 'Hire');
    this.showAllBtn = h('button', { class: 'ov-btn', onclick: () => this.setFilter(false) }, 'Show everyone', h('kbd', { 'aria-hidden': 'true' }, 'F'));
    this.emptyTitle = h('p', { class: 'ov-empty-title' }, 'Nobody’s here yet');
    this.emptyText = h('p', { class: 'ov-empty-text' }, 'Every desk on this floor is free. Hire a worker and they show up on this board.');
    this.emptyEl = h('div', { class: 'ov-empty', hidden: true }, this.emptyTitle, this.emptyText, this.hireBtn, this.showAllBtn);
    const keys = h(
      'footer',
      { class: 'ov-keys', 'aria-hidden': 'true' },
      ...(
        [
          ['↑ ↓', 'move'],
          ['↵', 'open transcript'],
          ['→ ←', 'expand · collapse'],
          ['t', 'open ticket'],
          ['r', 'retry AI line'],
          ['f', 'active only · all'],
          ['a', 'all floors'],
          ['Esc', 'close'],
        ] as const
      ).map(([k, t]) => h('span', { 'data-k': k }, h('kbd', {}, k), t)),
    );
    this.keysEl = keys;
    this.root = h(
      'div',
      { class: 'ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Floor overview', hidden: true },
      h(
        'div',
        { class: 'ov-frame' },
        h(
          'header',
          { class: 'ov-head' },
          h('div', { class: 'ov-title' }, this.floorEl, this.whereEl),
          this.countsEl,
          h('div', { class: 'ov-filters' }, this.filterEl, this.hiddenEl),
          h('div', { class: 'ov-tools' }, this.allFloorsBtn, expand, collapse, close),
        ),
        this.cols,
        this.board,
        this.emptyEl,
        keys,
      ),
    );
    this.root.style.setProperty('--ov-blink', `${BLINK_MS}ms`);
    parent.append(this.root);
  }

  get isOpen(): boolean {
    return this.view !== null;
  }

  /** The floor of a floor's page; null on the all-floors page and when closed. */
  get floor(): string | null {
    return this.view?.kind === 'floor' ? this.view.floor : null;
  }

  /** Opens a floor's overview, growing out of `from` (the wall screen on your view), else out of the centre. */
  open(floor: string, from: ViewRect | null = null): void {
    this.show({ kind: 'floor', floor }, from);
  }

  /** #188: opens the all-floors overview, out of the centre (never the wall screen: that is one floor's). */
  openCity(): void {
    this.show({ kind: 'city' }, null);
  }

  private show(view: OverviewView, from: ViewRect | null): void {
    if (this.closing) return;
    if (this.view && sameView(this.view, view)) return;
    if (this.view) {
      this.switchTo(view);
      return;
    }
    this.view = view;
    this.from = from;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.reset();
    this.root.hidden = false;
    this.root.setAttribute('open', ''); // the corner's plate and inbox chip step aside (ui/corner.ts)
    this.inertBackground(true);
    window.addEventListener('keydown', this.onKeyCapture, true);
    this.root.classList.add('ov--enter');
    this.refresh();
    this.grow(true);
    this.focusFirst();
    this.timer = setInterval(() => this.refresh(), 20_000); // the since column
    setTimeout(() => this.root.classList.remove('ov--enter'), 1200);
  }

  /** #188: the open page shows another view in place (`a`): no grow, its rows cascade in again. */
  private switchTo(view: OverviewView): void {
    this.view = view;
    this.from = null; // the all-floors page closes into the centre
    this.reset();
    this.root.classList.add('ov--enter');
    this.refresh();
    this.focusFirst();
    setTimeout(() => this.root.classList.remove('ov--enter'), 1200);
  }

  private reset(): void {
    this.rows.clear();
    this.leaving.clear();
    this.board.replaceChildren();
    this.visible = [];
    this.focusKey = null;
  }

  private focusFirst(): void {
    const first = this.board.querySelector<HTMLElement>('.ov-row');
    if (first) first.focus({ preventScroll: true });
    else [...this.emptyEl.querySelectorAll('button')].find((b) => !b.hidden)?.focus();
  }

  /** Esc: shrinks back into the wall screen (when it is still in view) and closes. */
  close(): Promise<void> {
    const view = this.view;
    if (!view) return Promise.resolve();
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.from = this.from && view.kind === 'floor' ? (this.host.screenRect(view.floor) ?? null) : null;
      await this.grow(false);
      this.finish();
    })().finally(() => (this.closing = null));
    return this.closing;
  }

  /** Closes at once (a row's go-to: the teleport must not wait for an animation). */
  closeNow(): void {
    this.anim?.cancel();
    this.finish();
  }

  private finish(): void {
    if (!this.view) return;
    this.view = null;
    this.root.hidden = true;
    this.root.removeAttribute('open');
    this.inertBackground(false);
    window.removeEventListener('keydown', this.onKeyCapture, true);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.returnFocus?.focus?.();
    this.host.closed();
  }

  private calm(): boolean {
    return reducedMotion() || this.host.calm();
  }

  /** The grow (FLIP-style, on a clip path, so text never stretches) and its reverse. Resolves when it ends. */
  private grow(opening: boolean): Promise<void> {
    this.anim?.cancel();
    const w = window.innerWidth;
    const hh = window.innerHeight;
    const f = this.from;
    const r = f ? { l: f.left, t: f.top, r: w - (f.left + f.width), b: hh - (f.top + f.height) } : { l: w * 0.36, t: hh * 0.36, r: w * 0.36, b: hh * 0.36 };
    const small = `inset(${r.t.toFixed(1)}px ${r.r.toFixed(1)}px ${r.b.toFixed(1)}px ${r.l.toFixed(1)}px round 6px)`;
    const full = 'inset(0px 0px 0px 0px round 0px)';
    if (typeof this.root.animate !== 'function') return Promise.resolve();
    const quiet = this.calm();
    const frames: Keyframe[] = quiet ? [{ opacity: 0 }, { opacity: 1 }] : [{ clipPath: small, opacity: 0.6 }, { clipPath: full, opacity: 1 }];
    const anim = this.root.animate(opening ? frames : [...frames].reverse(), { duration: quiet ? 140 : opening ? GROW_MS : GROW_MS * 0.8, easing: opening ? 'cubic-bezier(0.16, 1, 0.3, 1)' : 'cubic-bezier(0.7, 0, 0.84, 0)', fill: opening ? 'none' : 'forwards' });
    this.anim = anim;
    return anim.finished.then(
      () => {
        if (!opening) anim.cancel();
      },
      () => undefined,
    );
  }

  // ---- render -------------------------------------------------------------------------------------------

  /** Reads the floor (or every floor) again and updates the page in place. */
  refresh(): void {
    const view = this.view;
    if (!view) return;
    const city = view.kind === 'city';
    const d = view.kind === 'floor' ? this.host.data(view.floor) : this.host.cityData();
    const calm = this.calm();
    this.root.toggleAttribute('data-calm', calm);
    if (!d) {
      void this.close();
      return;
    }
    const full = d.tree;
    const total = full.total;
    this.floorEl.textContent = view.kind === 'floor' ? this.host.floorName(view.floor) : 'All floors';
    this.root.setAttribute('aria-label', view.kind === 'floor' ? `Floor overview · ${this.host.floorName(view.floor)}` : 'All-floors overview');
    this.root.toggleAttribute('data-city', city);
    this.whereEl.textContent = `${d.where} · ${total} ${total === 1 ? 'worker' : 'workers'}`;
    this.renderCounts(d.counts);
    // #188: the filter, and what it hides (the header's counts above never are).
    const active = this.filter.activeOnly(view.kind);
    const { tree, hidden } = active ? filterOverview(full) : { tree: full, hidden: null };
    const hiddenLine = hidden ? hiddenText(hidden, view.kind) : '';
    this.renderFilter(active, hiddenLine);
    this.allFloorsBtn.hidden = city;
    this.keysEl?.querySelector<HTMLElement>('[data-k="a"]')?.toggleAttribute('hidden', city);
    this.keysEl?.querySelector<HTMLElement>('[data-k="↵"]')?.lastChild?.replaceWith(city ? 'open transcript · go to floor' : 'open transcript');
    // What the tree holds, filter or not: a row of it that is no longer shown folds away; one that left goes at once.
    const nodes = allNodes(full);
    const present = new Set<string>(nodes.map((n) => n.row.key));
    this.sizes = new Map(nodes.map((n) => [n.row.key, n.children.length]));
    this.groups = nodes.filter((n) => n.children.length).map((n) => n.row.key);
    this.defaults = new Set(endedChildGroups(full));
    if ('floors' in full) {
      for (const f of full.floors) present.add(f.row.key);
      this.groups.unshift(...full.floors.filter((f) => f.nodes.length).map((f) => f.row.key));
      for (const k of sleepyFloors(full)) this.defaults.add(k);
    }
    // Nobody in the whole system: the empty state whatever the filter (the city's tree still has its floors).
    this.visible = total === 0 ? [] : visibleRows(tree, this.prefs.effective(this.defaults));
    const empty = this.visible.length === 0;
    this.renderEmpty(view, total, hiddenLine);
    this.emptyEl.hidden = !empty;
    this.board.hidden = empty;
    this.cols.hidden = empty;
    const now = this.host.now?.() ?? Date.now();
    const seen = new Set<string>();
    const order: HTMLElement[] = [];
    this.visible.forEach((v, i) => {
      const key = v.row.key;
      seen.add(key);
      const sig = rowSig(v);
      let entry = this.rows.get(key);
      const display = v.row.kind === 'worker' ? v.row.display : null;
      const nowText = v.row.kind === 'worker' ? (v.row.now?.text ?? null) : null;
      if (!entry) {
        const el = h('div', { class: 'ov-row', role: 'treeitem', tabindex: '-1', 'data-key': key });
        entry = { el, sig: '', display, now: nowText };
        this.rows.set(key, entry);
        this.fill(el, v, now);
        entry.sig = sig;
        if (!this.root.classList.contains('ov--enter') && !calm) retrigger(el, 'ov-row--new');
      } else if (entry.sig !== sig) {
        const flash = !calm && display !== null && entry.display !== null && entry.display !== display;
        const flap = !calm && nowText !== null && entry.now !== nowText;
        this.fill(entry.el, v, now);
        entry.sig = sig;
        if (flash) retrigger(entry.el, 'ov-row--flash');
        if (flap) {
          const n = entry.el.querySelector<HTMLElement>('.ov-now');
          if (n) retrigger(n, 'ov-flip-in');
        }
      } else this.since(entry.el, v.row, now);
      entry.display = display;
      entry.now = nowText;
      entry.el.style.setProperty('--i', String(Math.min(i, 24)));
      entry.el.setAttribute('aria-posinset', String(i + 1));
      order.push(entry.el);
    });
    // A row that shows again (its group unfolds, the filter lets it back) comes back at once: the old one folding away goes.
    for (const [el, k] of this.leaving) if (seen.has(k)) this.drop(el);
    const before = [...this.board.children] as HTMLElement[];
    const fold: HTMLElement[] = [];
    for (const [k, e] of this.rows) {
      if (!seen.has(k)) {
        // A row of a group you just collapsed, or one the filter hides now, folds away where it was; one that left goes at once.
        if (!calm && present.has(k) && typeof e.el.animate === 'function') {
          this.leaving.set(e.el, k);
          fold.push(e.el);
        } else e.el.remove();
        this.rows.delete(k);
      }
    }
    // Moves only when the order changed (a new or departed row, a fold): a focused row keeps its focus.
    const cur = before.filter((c) => !this.leaving.has(c) && c.isConnected);
    if (cur.length !== order.length || cur.some((c, i) => c !== order[i]) || fold.length) {
      const a = document.activeElement;
      this.board.replaceChildren(...order);
      // The folding rows stay where they were (under their group, in their order) until they are gone: each goes back
      // after the nearest row above it that is still on the board.
      before.forEach((el, i) => {
        if (!this.leaving.has(el) || el.isConnected) return;
        let j = i - 1;
        while (j >= 0 && !before[j]?.isConnected) j--;
        const anchor = before[j];
        if (anchor) anchor.after(el);
        else this.board.prepend(el);
      });
      if (a instanceof HTMLElement && this.board.contains(a) && !this.leaving.has(a) && document.activeElement !== a) a.focus({ preventScroll: true });
    }
    this.foldAway(fold);
    if (!this.focusKey || !this.rows.has(this.focusKey)) this.setFocus(this.visible[0]?.row.key ?? null, false);
    else this.setFocus(this.focusKey, false);
  }

  /** #188: the switch's state, and the line of what it hides (a button that shows everyone). */
  private renderFilter(active: boolean, hidden: string): void {
    for (const b of this.filterEl.querySelectorAll<HTMLButtonElement>('.ov-seg')) b.setAttribute('aria-pressed', String((b.dataset.active === 'true') === active));
    this.filterEl.dataset.on = active ? 'active' : 'all';
    this.hiddenEl.hidden = !hidden;
    if (this.hiddenEl.dataset.text === hidden) return;
    this.hiddenEl.dataset.text = hidden;
    this.hiddenEl.title = 'Show everyone (F)';
    this.hiddenEl.replaceChildren(h('span', { class: 'ov-hidden-text' }, hidden), h('span', { class: 'ov-hidden-go' }, 'Show all'));
  }

  /** The empty board: a floor nobody works on (Hire), a city with nobody in it, or a filter that hides everyone. */
  private renderEmpty(view: OverviewView, total: number, hidden: string): void {
    const filtered = total > 0;
    this.emptyTitle.textContent = filtered ? 'All quiet' : 'Nobody’s here yet';
    this.emptyText.textContent = filtered
      ? `Nobody is working, waiting or needing you right now${hidden ? ` (${hidden})` : ''}.`
      : view.kind === 'floor'
        ? 'Every desk on this floor is free. Hire a worker and they show up on this board.'
        : 'No floor has a worker yet. Walk onto a floor and hire someone: every floor’s workers show up on this board.';
    this.hireBtn.hidden = filtered || view.kind === 'city';
    this.showAllBtn.hidden = !filtered;
  }

  /**
   * A collapse: the group's rows fold up under it, the last one first: their height and padding go with a slight
   * spring (a lift before they tuck away) as they fade, so the rows below glide up instead of jumping. Out of the tree
   * and the tab order at once (inert, hidden from assistive tech); calm never gets here (they go at once).
   */
  private foldAway(els: HTMLElement[]): void {
    els.forEach((el, i) => {
      el.inert = true;
      el.tabIndex = -1;
      el.setAttribute('aria-hidden', 'true');
      el.removeAttribute('role');
      el.classList.remove('ov-row--new', 'ov-row--flash');
      el.classList.add('ov-row--leaving');
      const h = el.offsetHeight;
      const cs = getComputedStyle(el);
      const anim = el.animate(
        [
          { height: `${h}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, opacity: 1, transform: 'translateY(0) scaleY(1)' },
          { opacity: 0, offset: 0.62 },
          { height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0, transform: 'translateY(-6px) scaleY(0.96)' },
        ],
        { duration: FOLD_MS, delay: (els.length - 1 - i) * FOLD_STAGGER_MS, easing: 'cubic-bezier(0.45, -0.22, 0.3, 1)', fill: 'forwards' },
      );
      anim.finished.then(
        () => this.drop(el),
        () => this.drop(el),
      );
    });
  }

  private drop(el: HTMLElement): void {
    this.leaving.delete(el);
    el.remove();
  }

  private renderCounts(items: CountItem[]): void {
    const key = JSON.stringify(items);
    if (this.countsEl.dataset.key === key) return;
    this.countsEl.dataset.key = key;
    this.countsEl.replaceChildren(
      ...items.map((c) =>
        h(
          'span',
          { class: `ov-count ov-count--${c.kind}`, title: `${c.n} ${c.label}` },
          h('span', { class: 'ov-flaps', 'aria-hidden': 'true' }, ...String(c.n).padStart(2, '0').split('').map((d) => h('span', { class: 'ov-flap' }, d))),
          h('span', { class: 'ov-count-label' }, h('i', { class: 'ov-dot' }), h('span', { class: 'ov-sr' }, `${c.n} `), c.label),
        ),
      ),
    );
  }

  /** Builds a row's content. */
  private fill(el: HTMLElement, v: VisibleRow, now: number): void {
    const r = v.row;
    // #188: on the all-floors page a floor is a band over its rows, which read as on a floor's page (no indent).
    const city = this.view?.kind === 'city' && r.kind !== 'floor';
    const nest = city ? v.depth - 1 : v.depth;
    el.className = `ov-row ov-row--${r.kind}${nest ? ' ov-row--nested' : ''}`;
    el.dataset.depth = String(v.depth);
    // #24: the indent follows the tree down to NEST_MAX levels; a deeper row stays there (its wires drawn compressed).
    if (nest) el.style.setProperty('--nest', String(Math.min(nest, NEST_MAX)));
    else el.style.removeProperty('--nest');
    el.setAttribute('aria-level', String(v.depth + 1));
    if (v.expandable) el.setAttribute('aria-expanded', String(v.expanded));
    else el.removeAttribute('aria-expanded');
    const wire = nest ? wireEl(city ? v.more.slice(1) : v.more, r.kind === 'child' ? CHILD_ELBOW_Y : ELBOW_Y, r.kind === 'child' && r.unresolved) : null;
    const fold = v.expandable ? h('span', { class: 'ov-fold', 'aria-hidden': 'true', 'data-fold': '1', title: v.expanded ? 'Collapse (←)' : 'Expand (→)' }, icon(ICON.chevron)) : null;
    if (r.kind === 'floor') {
      this.fillFloor(el, r, fold);
      return;
    }
    if (r.kind === 'worker') {
      el.dataset.display = r.display;
      el.style.setProperty('--run', r.runColor !== null ? `#${r.runColor.toString(16).padStart(6, '0')}` : 'transparent');
      el.setAttribute('aria-label', rowLabel(r, now));
      // #229: the harness is a mark before the name (a harness without one says its name in the meta line).
      const mark = markSvg(r.harness, 'ov-mark');
      const who = h(
        'div',
        { class: 'ov-who' },
        mark,
        h('span', { class: 'ov-name' }, r.name),
        r.tag ? h('span', { class: 'ov-tag' }, r.tag) : null,
        r.floor ? h('span', { class: 'ov-floortag' }, r.floor) : null,
        h('span', { class: 'ov-meta' }, [mark ? '' : r.harness, r.model].filter(Boolean).join(' ')),
        r.orch?.overCap ? h('span', { class: 'ov-cap' }, 'Over cap') : null,
      );
      const what = h(
        'div',
        { class: 'ov-what' },
        r.ticket ? this.ticketEl(r) : null,
        r.task ? lineEl('task', r.task, now) : null,
        r.now ? lineEl('now', r.now, now) : null,
        !r.ticket && !r.task && !r.now ? h('p', { class: 'ov-line ov-quiet' }, r.activity ? 'No summary yet' : 'No turn yet') : null,
      );
      el.replaceChildren(h('span', { class: 'ov-light', 'aria-hidden': 'true' }), wire ?? '', fold ?? '', who, what, workerSince(r, now));
      return;
    }
    delete el.dataset.display;
    if (r.kind === 'child') {
      this.fillChild(el, r, nest, wire, fold, now);
      return;
    }
    delete el.dataset.state;
    if (r.kind === 'ghost') {
      el.setAttribute('aria-label', `Orchestrator ${r.name} · ${r.floor}: go there`);
      el.replaceChildren(
        h('span', { class: 'ov-light ov-light--ghost', 'aria-hidden': 'true' }),
        fold ?? '',
        h('div', { class: 'ov-who' }, h('span', { class: 'ov-ghost-label' }, 'Orchestrator'), h('span', { class: 'ov-name' }, r.name), h('span', { class: 'ov-floortag' }, r.floor)),
        h('div', { class: 'ov-what' }, h('p', { class: 'ov-line ov-quiet' }, 'Runs on another floor; its freelancers here are below.')),
        sinceEl([], 'Go there'),
      );
      return;
    }
    const n = this.childCount(r.key);
    el.setAttribute('aria-label', `Unlinked freelancers: ${n}`);
    el.replaceChildren(
      h('span', { class: 'ov-light ov-light--ghost', 'aria-hidden': 'true' }),
      fold ?? '',
      h('div', { class: 'ov-who' }, h('span', { class: 'ov-name' }, 'Unlinked'), h('span', { class: 'ov-meta' }, `${n} freelancer${n === 1 ? '' : 's'} with no orchestrator`)),
      h('div', { class: 'ov-what' }),
      sinceEl([], null),
    );
  }

  /**
   * #24: a native child's row, quieter than a worker's and one line high: its state's pip, the provider's mark, its name
   * (its type beside a name), what it was asked and its transcript's availability, its state and time; one with no parent
   * known says so.
   */
  private fillChild(el: HTMLElement, r: OverviewChildRow, nest: number, wire: SVGSVGElement | null, fold: HTMLElement | null, now: number): void {
    el.dataset.state = r.state;
    el.style.removeProperty('--run');
    el.removeAttribute('title');
    el.setAttribute('aria-label', childLabel(r, nest, now));
    const mark = markSvg(r.provider, 'ov-mark');
    const who = h(
      'div',
      { class: 'ov-who' },
      mark,
      h('span', { class: 'ov-name' }, r.name),
      r.type ? h('span', { class: 'ov-ctype' }, r.type) : null,
      r.unresolved ? h('span', { class: 'ov-orphan', title: 'No parent known yet: shown under its worker until the provider names one' }, 'parent unknown') : null,
      nest > NEST_MAX ? h('span', { class: 'ov-level', title: `Nested ${nest} levels deep` }, `level ${nest}`) : null,
      mark ? null : h('span', { class: 'ov-ctype' }, r.provider),
    );
    // One line, so a long list stays dense: what it was asked (all of it on hover and focus), its transcript after it.
    const what = h(
      'div',
      { class: 'ov-what' },
      h(
        'p',
        { class: 'ov-line ov-desc' },
        r.description ? h('span', { class: 'ov-text ov-desc-text', title: r.description }, r.description) : h('span', { class: 'ov-text ov-quiet' }, 'No task description'),
        h('span', { class: `ov-ai-meta ov-tx ov-tx--${r.transcript}` }, CHILD_TRANSCRIPT_WORD[r.transcript]),
      ),
    );
    el.replaceChildren(h('span', { class: 'ov-pip', 'aria-hidden': 'true' }), wire ?? '', fold ?? '', who, what, childSinceEl(r, now));
  }

  /** #188: a floor's band: its name and place, its counts as chips (a zero quiet), the moon when it sleeps. */
  private fillFloor(el: HTMLElement, r: OverviewFloorRow, fold: HTMLElement | null): void {
    delete el.dataset.display;
    el.toggleAttribute('data-asleep', r.asleep);
    const counts = r.counts.map((c) => `${c.n} ${c.label}`).join(', ');
    el.setAttribute('aria-label', `${r.name}${r.label !== r.name ? ` · ${r.label}` : ''}${r.asleep ? ' · asleep' : ''} · ${counts}: go to this floor`);
    el.title = 'Go to this floor (↵)';
    el.replaceChildren(
      h('span', { class: 'ov-floor-fold' }, fold ?? ''),
      h(
        'div',
        { class: 'ov-who' },
        h('span', { class: 'ov-name' }, r.name),
        r.label !== r.name ? h('span', { class: 'ov-floor-label' }, r.label) : null,
        r.asleep ? h('span', { class: 'ov-asleep' }, icon(MOON), 'Asleep') : null,
      ),
      h(
        'div',
        { class: 'ov-chips' },
        ...r.counts.map((c) => h('span', { class: `ov-chip ov-count--${c.kind}${c.n ? '' : ' ov-chip--zero'}` }, h('i', { class: 'ov-dot' }), h('b', {}, String(c.n)), c.label)),
      ),
    );
  }

  private ticketEl(r: OverviewWorkerRow): HTMLElement {
    const t = r.ticket as NonNullable<OverviewWorkerRow['ticket']>;
    const body = [h('span', { class: 'ov-ticket-key' }, t.key), t.title ? h('span', { class: 'ov-ticket-title' }, t.title) : null];
    if (!t.item) return h('p', { class: 'ov-ticket ov-ticket--plain' }, ...body);
    return h('button', { class: 'ov-ticket', tabindex: '-1', 'data-ticket': '1', title: `Open ${t.key} (t)` }, ...body);
  }

  /**
   * The times of a row that did not change otherwise, in place: its since column's time, (#198) its AI now line's age and
   * its sparkle's words, and its spoken label.
   */
  private since(el: HTMLElement, r: OverviewAnyRow, now: number): void {
    if (r.kind === 'child') {
      const t = el.querySelector('.ov-since .ov-time');
      const time = childSince(r, now).time ?? '';
      if (t && t.textContent !== time) t.textContent = time;
      const label = childLabel(r, Number(el.style.getPropertyValue('--nest')) || 0, now);
      if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label);
      return;
    }
    if (r.kind !== 'worker') return;
    const t = el.querySelector('.ov-since .ov-time');
    const span = spanText(now - r.since);
    if (t && t.textContent !== span) t.textContent = span;
    if (r.now?.llm && r.now.at) {
      const age = el.querySelector('.ov-now .ov-age');
      const a = ageText(r.now.at, now);
      if (age && age.textContent !== a) age.textContent = a;
      const mark = el.querySelector<HTMLElement>('.ov-now .ov-ai');
      const title = aiTitle(r.now, now);
      if (mark && mark.title !== title) {
        mark.title = title;
        mark.setAttribute('aria-label', title);
      }
    }
    const label = rowLabel(r, now);
    if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label);
  }

  private childCount(key: string): number {
    return this.sizes.get(key) ?? 0;
  }

  // ---- focus, keys, clicks --------------------------------------------------------------------------------

  /** One row in the tab order (a roving tabindex); `move` also focuses it. */
  private setFocus(key: string | null, move = true): void {
    this.focusKey = key;
    for (const [k, e] of this.rows) e.el.tabIndex = k === key ? 0 : -1;
    if (move && key) {
      const el = this.rows.get(key)?.el;
      el?.focus();
      el?.scrollIntoView?.({ block: 'nearest' });
    }
  }

  private focused(): VisibleRow | null {
    return this.visible.find((v) => v.row.key === this.focusKey) ?? null;
  }

  private keyCapture(e: KeyboardEvent): void {
    if (!this.isOpen) return;
    // A dialog over the page (the issue window) owns the keys, Esc included.
    if (document.querySelector('dialog:modal')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // #174: Enter and Space on the focused Retry button press it (a native click), not the row's open or fold.
    if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof Element && e.target.closest('.ov-retry')) return;
    // #188: so do they on any focused button off the rows (the switch, the hidden line, All floors, Expand all, close).
    if ((e.key === 'Enter' || e.key === ' ') && document.activeElement instanceof HTMLButtonElement && !document.activeElement.closest('.ov-row')) return;
    const v = this.focused();
    const i = v ? this.visible.indexOf(v) : -1;
    const go = (j: number) => {
      const t = this.visible[Math.max(0, Math.min(this.visible.length - 1, j))];
      if (t) this.setFocus(t.row.key);
    };
    let handled = true;
    const k = e.key;
    if (k === 'Escape') void this.close();
    else if (k === 'ArrowDown' || (k === 'j' && !e.shiftKey)) go(i + 1);
    else if (k === 'ArrowUp' || (k === 'k' && !e.shiftKey)) go(i - 1);
    else if (k === 'Home') go(0);
    else if (k === 'End') go(this.visible.length - 1);
    else if (k === 'ArrowRight' && e.shiftKey) this.setAll(false);
    else if (k === 'ArrowLeft' && e.shiftKey) this.setAll(true);
    else if (k === 'ArrowRight' && v) {
      if (v.expandable && !v.expanded) this.toggle(v.row.key, false);
      else if (v.expanded) go(i + 1);
    } else if (k === 'ArrowLeft' && v) {
      if (v.expandable && v.expanded) this.toggle(v.row.key, true);
      else if (v.parent) this.setFocus(v.parent);
    } else if (k === ' ' && v) {
      if (v.expandable) this.toggle(v.row.key, v.expanded);
    } else if (k === 'Enter' && v) this.activate(v);
    else if (k === 'f' && !e.shiftKey) this.setFilter(!this.filter.activeOnly(this.view?.kind ?? 'floor'));
    else if (k === 'a' && !e.shiftKey && this.view?.kind === 'floor') this.showCity();
    else if (k === 't' && v?.row.kind === 'worker') this.ticket(v.row);
    else if (k === 'r' && v?.row.kind === 'worker' && retriable(v.row)) this.host.retrySummary(v.row.id);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>('.ov-row');
    const key = row?.dataset.key;
    const v = this.visible.find((x) => x.row.key === key);
    if (!v) return;
    this.setFocus(v.row.key, false);
    if (t.closest('[data-fold]')) this.toggle(v.row.key, v.expanded);
    else if (t.closest('[data-ticket]') && v.row.kind === 'worker') this.ticket(v.row);
    else if (t.closest('[data-retry]') && v.row.kind === 'worker') this.host.retrySummary(v.row.id);
    else this.activate(v);
  }

  private activate(v: VisibleRow): void {
    const r = v.row;
    if (r.kind === 'unlinked') {
      this.toggle(r.key, v.expanded);
      return;
    }
    // The go-to shuts the page itself (no shrink: you are going somewhere else), O brings it back.
    this.closeNow();
    if (r.kind === 'floor') this.host.goToFloor(r.floor);
    else if (r.kind === 'child') this.host.goToChild(r.workerId, r.id);
    else this.host.goTo(r.id);
  }

  /** #188: Active only (true) or All, for this view; remembered. */
  private setFilter(active: boolean): void {
    const view = this.view;
    if (!view || this.filter.activeOnly(view.kind) === active) return;
    this.filter.setActiveOnly(view.kind, active);
    const onRow = !!(document.activeElement as Element | null)?.closest?.('.ov-row');
    this.refresh();
    // From a row (f): focus stays on the board; from the switch or the hidden line, where you pressed it.
    if (this.focusKey && (onRow || !this.root.contains(document.activeElement))) this.setFocus(this.focusKey);
  }

  /** #188: from a floor's page to every floor's (`a`, the All floors button). Esc then closes the page. */
  private showCity(): void {
    if (this.view?.kind === 'floor') this.switchTo({ kind: 'city' });
  }

  private ticket(r: OverviewWorkerRow): void {
    const item = r.ticket?.item;
    if (!item) return;
    this.host.openTicket(item.floor, item.id);
    // The issue window is a modal dialog over the page: the background is live while it is up.
    const d = [...document.querySelectorAll<HTMLDialogElement>('dialog:modal')];
    if (!d.length) return;
    this.inertBackground(false);
    const watch = () => {
      if (!this.isOpen) return;
      if (document.querySelector('dialog:modal')) {
        setTimeout(watch, 150);
        return;
      }
      this.inertBackground(true);
      this.setFocus(this.focusKey);
    };
    setTimeout(watch, 150);
  }

  private toggle(key: string, collapse: boolean): void {
    this.prefs.setCollapsed(key, collapse, this.defaults.has(key));
    this.refresh();
    this.setFocus(key);
  }

  /** Expand all / Collapse all: every group of the tree (on the all-floors page its floors and their groups). */
  private setAll(collapse: boolean): void {
    if (!this.view) return;
    this.refresh(); // the groups as they are now
    this.prefs.setAll(this.groups, collapse, this.defaults);
    const keep = this.focusKey;
    this.refresh();
    const parent = this.visible.find((x) => x.row.key === keep) ? keep : (this.visible.find((x) => this.rows.get(x.row.key) && x.depth === 0)?.row.key ?? null);
    this.setFocus(parent);
  }

  private hireHere(): void {
    this.closeNow();
    this.host.hire();
  }

  /** While open, everything around the page up to the body is inert (focus and pointer stay in it). */
  private inertBackground(on: boolean): void {
    for (const el of this.inerted) el.inert = false;
    this.inerted = [];
    if (!on) return;
    for (let node: HTMLElement = this.root; node !== document.body && node.parentElement; node = node.parentElement) {
      for (const sib of node.parentElement.children) {
        // #147: the command palette is a modal of its own that opens over the page.
        if (sib === node || !(sib instanceof HTMLElement) || sib.inert || sib instanceof HTMLScriptElement || sib.matches('dialog.palette')) continue;
        sib.inert = true;
        this.inerted.push(sib);
      }
    }
  }

  info(): OverviewInfo {
    return {
      open: this.isOpen,
      floor: this.floor,
      view: this.view?.kind ?? null,
      filter: this.filter.activeOnly(this.view?.kind ?? 'floor') ? 'active' : 'all',
      hidden: this.hiddenEl.hidden ? '' : (this.hiddenEl.dataset.text ?? ''),
      rows: this.visible.map((v) => ({
        key: v.row.key,
        kind: v.row.kind,
        depth: v.depth,
        display: v.row.kind === 'worker' ? v.row.display : null,
        text: textOf(this.rows.get(v.row.key)?.el),
        expanded: v.expandable ? v.expanded : null,
      })),
      focused: this.focusKey,
      empty: this.isOpen && this.visible.length === 0,
      calm: this.root.hasAttribute('data-calm'),
      from: this.from,
    };
  }
}

/** An element's text as it reads (#229: a mark's `<title>` is its tooltip, not text of the row). */
function textOf(e: Node | undefined): string {
  if (!e) return '';
  if (e.nodeType === Node.TEXT_NODE) return e.textContent ?? '';
  return e instanceof Element && e.localName === 'title' ? '' : [...e.childNodes].map(textOf).join('');
}

/** A worker row's spoken label: who, the ticket, the lines with what became of them, the status and how long. */
function rowLabel(r: OverviewWorkerRow, now: number): string {
  const ai = (l: OverviewLine, kind: 'task' | 'now') =>
    l.llm ? ` (AI summary${l.at ? `, ${ageText(l.at, now)}` : ''}${l.status ? `; ${lineStatusText(l.status, kind, true).chip}` : ''})` : statusLabel(l, kind);
  return [r.name, r.tag, harnessName(r.harness), r.model, r.activity, r.ticket ? `${r.ticket.key}${r.ticket.title ? ` ${r.ticket.title}` : ''}` : null, r.task ? `Task: ${r.task.text}${ai(r.task, 'task')}` : null, r.now ? `Now: ${r.now.text}${ai(r.now, 'now')}` : null, sinceText(r.display, r.since, now)]
    .filter(Boolean)
    .join(' · ');
}

/**
 * #24: a child row's spoken label: what it is, whose, what it was asked, its state and time, its transcript, and where
 * activating it goes (its worker, until #26). `nest` past NEST_MAX: its level too (the indent no longer says it).
 */
function childLabel(r: OverviewChildRow, nest: number, now: number): string {
  return [
    `Subagent ${r.name}`,
    r.type,
    harnessName(r.provider) || null,
    r.unresolved ? 'parent unknown' : null,
    nest > NEST_MAX ? `level ${nest}` : null,
    r.description ? `Task: ${r.description}` : null,
    childSinceText(r, now),
    CHILD_TRANSCRIPT_WORD[r.transcript],
  ]
    .filter(Boolean)
    .join(' · ')
    .concat(': go to its worker');
}

/** #24: a child row's since column: its state in words and its time where one means something (`childSince`). */
function childSinceEl(r: OverviewChildRow, now: number): HTMLElement {
  const s = childSince(r, now);
  return sinceEl([h('span', { class: 'ov-state' }, s.word), h('span', { class: 'ov-sep' }, ' '), h('span', { class: 'ov-time' }, s.time ?? '')], 'Go to worker');
}

/** Where a nested row's elbow meets it (px from its top): a worker's name, a child's (its row is tighter). */
const ELBOW_Y = 22;
const CHILD_ELBOW_Y = 17;
/** #24: the indent per nesting level (overview.css `--ov-step`). */
const STEP = 20;

/**
 * #24: a nested row's wires: a line down each ancestor's level that runs on below it (`more`), and at its own level the
 * line from its parent to its elbow (on down when a sibling follows). Past NEST_MAX the deeper levels share the last
 * column. An unresolved child's elbow is detached and dashed: shown under the worker, never as started by it.
 */
function wireEl(more: readonly boolean[], y: number, detached: boolean): SVGSVGElement {
  const n = more.length;
  const vis = Math.min(n, NEST_MAX);
  const x = (level: number) => 10 + (level - 1) * STEP;
  const lines: string[] = [];
  for (let l = 1; l < vis; l++) if (more[l - 1]) lines.push(`<line x1="${x(l)}" y1="0" x2="${x(l)}" y2="100%" pathLength="1"/>`);
  const on = more.slice(vis - 1).some(Boolean);
  const own = x(vis);
  if (on) lines.push(`<line x1="${own}" y1="0" x2="${own}" y2="100%" pathLength="1"/>`);
  else if (!detached) lines.push(`<line x1="${own}" y1="0" x2="${own}" y2="${y}" pathLength="1"/>`);
  lines.push(detached ? `<line class="ov-wire-loose" x1="${own + 5}" y1="${y}" x2="${own + 14}" y2="${y}"/>` : `<line x1="${own}" y1="${y}" x2="${own + 14}" y2="${y}" pathLength="1"/>`);
  return svgEl(`<svg class="ov-wire" aria-hidden="true" style="width:${24 + (vis - 1) * STEP}px">${lines.join('')}</svg>`);
}

/**
 * #226, #232: the since column, and the row's hint, which goes on a line under it while the row is hovered or focused
 * (overview.css), never over another column.
 */
function sinceEl(parts: Child[], hint: string | null): HTMLElement {
  return h('span', { class: 'ov-since' }, parts.length ? h('span', { class: 'ov-doing' }, ...parts) : null, hint ? h('span', { class: 'ov-hint', 'aria-hidden': 'true' }, hint, h('kbd', {}, '↵')) : null);
}

/**
 * #232: a worker's since column: while it works with a usable activity, that in plain words (`Investigating · grep -n …`,
 * the detail giving way first, the whole of it in the title) and how long it has worked; else its status (`working`,
 * `needs you`, `idle`) and how long that held, never a stale activity. The time is a span of its own: the 20 s refresh
 * rewrites only it, and it keeps its place at the column's right edge.
 */
function workerSince(r: OverviewWorkerRow, now: number): HTMLElement {
  const act = r.display === 'working' ? r.act : null;
  const state = act
    ? h('span', { class: 'ov-state ov-state--act', title: r.activity }, h('span', { class: 'ov-verb' }, act.verb), act.detail ? h('span', { class: 'ov-detail' }, ` · ${act.detail}`) : null)
    : h('span', { class: 'ov-state' }, STATUS_WORD[r.display]);
  return sinceEl([state, h('span', { class: 'ov-sep' }, act ? ' · ' : ' '), h('span', { class: 'ov-time' }, spanText(now - r.since))], 'Open transcript');
}

/**
 * #226, #232: a task or now line: its label and, beside it, the sparkle of a line the AI model wrote (what it is in its
 * title and for a screen reader); the text; and at the line's end its quiet metadata: (#198) how long ago a model's now
 * line was written, and (#174) what became of the model's line, with Retry.
 */
function lineEl(kind: 'task' | 'now', line: OverviewLine, now: number): HTMLElement {
  const title = line.llm ? aiTitle(line, now, kind) : '';
  const meta = [line.llm && line.at ? h('span', { class: 'ov-age' }, ageText(line.at, now)) : null, ...statusEls(line, kind)].filter((e) => e !== null);
  return h(
    'p',
    { class: `ov-line ov-${kind}${line.status ? ' ov-line--status' : ''}` },
    h('b', {}, kind === 'task' ? 'Task' : 'Now', line.llm ? h('span', { class: 'ov-ai', title, role: 'img', 'aria-label': title }, icon(ICON.sparkle)) : null),
    h('span', { class: `ov-text ov-${kind}-text`, title: line.text }, line.text),
    meta.length ? h('span', { class: 'ov-ai-meta' }, ...meta) : null,
  );
}

/**
 * #174: what became of the model's line: pending as quiet words (#232), a failed one as a chip (its words in the title
 * and for a screen reader), and Retry when it helps. #198: on a model's now line, a failed refresh of it.
 */
function statusEls(line: OverviewLine, kind: 'task' | 'now'): HTMLElement[] {
  if (!line.status) return [];
  const t = lineStatusText(line.status, kind, line.llm);
  const chip = h('span', { class: `ov-ai-state ov-ai-state--${line.status.state}${line.llm ? ' ov-ai-state--kept' : ''}`, title: t.detail, role: 'img', 'aria-label': t.detail }, t.chip);
  return t.retry ? [chip, h('button', { class: 'ov-retry', tabindex: '-1', 'data-retry': '1', title: 'Try the AI summary again (R)' }, 'Retry')] : [chip];
}

/** The row's spoken label gets the chip's short words: the rest is on the chip. */
function statusLabel(line: OverviewLine, kind: 'task' | 'now'): string {
  return line.status ? ` (${lineStatusText(line.status, kind, line.llm).chip})` : '';
}

function sameView(a: OverviewView, b: OverviewView): boolean {
  return a.kind === b.kind && (a.kind === 'city' || a.floor === (b as { floor: string }).floor);
}

function svgEl(markup: string): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = markup;
  return t.content.firstElementChild as SVGSVGElement;
}

/** Plays a one-shot CSS animation class again. */
function retrigger(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}
