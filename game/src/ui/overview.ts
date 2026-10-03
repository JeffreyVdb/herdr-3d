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
 */

import { BLINK_MS, orchWords, sinceText, visibleRows, type CountItem, type OverviewData, type OverviewRow, type OverviewWorkerRow, type VisibleRow } from '../world/overview';
import { h, icon, ICON } from './dom';
import type { OverviewPrefs } from './overviewPrefs';
import './overview.css';

/** The grow out of the wall screen, and back. */
const GROW_MS = 420;
/** A collapsing group's rows fold away under it this long (each a little after the one below it). */
const FOLD_MS = 300;
const FOLD_STAGGER_MS = 22;

/** A rectangle on the viewport, in CSS pixels. */
export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}


export interface OverviewHost {
  data(session: string): OverviewData | null;
  /** A worker row: sit at its laptop with its conversation on screen (`App.goToWorker(id, 'transcript')`). */
  goTo(id: string): void;
  /** A ticket: the in-game issue window over the page. */
  openTicket(session: string, id: string): void;
  /** The empty floor's Hire. */
  hire(): void;
  /** Battery saver (B): no blinking. */
  calm(): boolean;
  /** Where the wall screen is on the view now (null: not in view): the close shrinks into it. */
  screenRect(session: string): ViewRect | null;
  /** The page closed (the game takes keys again). */
  closed(): void;
  now?(): number;
}

/** What a test can read of the page. */
export interface OverviewInfo {
  open: boolean;
  floor: string | null;
  rows: Array<{ key: string; depth: number; display: string | null; text: string; expanded: boolean | null }>;
  focused: string | null;
  empty: boolean;
  calm: boolean;
  /** Where the open began: the wall screen's rectangle, or null for the centre. */
  from: ViewRect | null;
}

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** The row's own signature: it is rebuilt only when this changes. */
function rowSig(v: VisibleRow): string {
  const r = v.row;
  return JSON.stringify([r, v.depth, v.expandable, v.expanded]);
}

export class OverviewOverlay {
  private readonly root: HTMLDivElement;
  private readonly floorEl: HTMLHeadingElement;
  private readonly whereEl: HTMLParagraphElement;
  private readonly countsEl: HTMLDivElement;
  private readonly board: HTMLDivElement;
  private readonly emptyEl: HTMLDivElement;
  private readonly cols: HTMLDivElement;
  private session: string | null = null;
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
  /** Rows of a group just collapsed, folding away under it (inert, out of the tree): the group's key. */
  private leaving = new Map<HTMLElement, string>();

  constructor(
    parent: HTMLElement,
    private readonly host: OverviewHost,
    private readonly prefs: OverviewPrefs,
  ) {
    this.floorEl = h('h2', { class: 'ov-floor', id: 'ov-floor' });
    this.whereEl = h('p', { class: 'ov-where' });
    this.countsEl = h('div', { class: 'ov-counts', role: 'group', 'aria-label': 'Counts' });
    const expand = h('button', { class: 'ov-btn', title: 'Expand every group (Shift+→)', onclick: () => this.setAll(false) }, 'Expand all');
    const collapse = h('button', { class: 'ov-btn', title: 'Collapse every group (Shift+←)', onclick: () => this.setAll(true) }, 'Collapse all');
    const close = h('button', { class: 'ov-btn ov-btn--icon', 'aria-label': 'Close the overview (Esc)', title: 'Close (Esc)', onclick: () => void this.close() }, icon(ICON.close));
    this.cols = h(
      'div',
      { class: 'ov-cols', 'aria-hidden': 'true' },
      h('span', {}, ''),
      h('span', {}, 'Worker'),
      h('span', {}, 'Ticket · task · now'),
      h('span', { class: 'ov-cols-since' }, 'Since'),
    );
    this.board = h('div', { class: 'ov-board', role: 'tree', 'aria-labelledby': 'ov-floor' });
    this.board.addEventListener('click', (e) => this.onClick(e));
    this.board.addEventListener('focusin', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.ov-row');
      if (row?.dataset.key) this.setFocus(row.dataset.key, false);
    });
    const hire = h('button', { class: 'ov-btn ov-btn--go', onclick: () => this.hireHere() }, icon('<circle cx="9.5" cy="8" r="3.2"/><path d="M3.8 19.5c.6-3.4 2.8-5.3 5.7-5.3 1.4 0 2.6.4 3.6 1.2"/><path d="M18 13.5v6M15 16.5h6"/>'), 'Hire');
    this.emptyEl = h(
      'div',
      { class: 'ov-empty', hidden: true },
      h('p', { class: 'ov-empty-title' }, 'Nobody’s here yet'),
      h('p', { class: 'ov-empty-text' }, 'Every desk on this floor is free. Hire a worker and they show up on this board.'),
      hire,
    );
    const keys = h(
      'footer',
      { class: 'ov-keys', 'aria-hidden': 'true' },
      ...(
        [
          ['↑ ↓', 'move'],
          ['↵', 'open transcript'],
          ['→ ←', 'expand · collapse'],
          ['t', 'open ticket'],
          ['Esc', 'close'],
        ] as const
      ).map(([k, t]) => h('span', {}, h('kbd', {}, k), t)),
    );
    this.root = h(
      'div',
      { class: 'ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Floor overview', hidden: true },
      h(
        'div',
        { class: 'ov-frame' },
        h('header', { class: 'ov-head' }, h('div', { class: 'ov-title' }, this.floorEl, this.whereEl), this.countsEl, h('div', { class: 'ov-tools' }, expand, collapse, close)),
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
    return this.session !== null;
  }

  get floor(): string | null {
    return this.session;
  }

  /** Opens a floor's overview, growing out of `from` (the wall screen on your view), else out of the centre. */
  open(session: string, from: ViewRect | null = null): void {
    if (this.closing) return;
    if (this.session === session) return;
    this.session = session;
    this.from = from;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.rows.clear();
    this.leaving.clear();
    this.board.replaceChildren();
    this.focusKey = null;
    this.root.hidden = false;
    this.root.setAttribute('open', ''); // the corner's plate and inbox chip step aside (ui/corner.ts)
    this.inertBackground(true);
    window.addEventListener('keydown', this.onKeyCapture, true);
    this.root.classList.add('ov--enter');
    this.refresh();
    this.grow(true);
    this.board.querySelector<HTMLElement>('.ov-row')?.focus({ preventScroll: true });
    if (!this.board.querySelector('.ov-row')) this.emptyEl.querySelector('button')?.focus();
    this.timer = setInterval(() => this.refresh(), 20_000); // the since column
    setTimeout(() => this.root.classList.remove('ov--enter'), 1200);
  }

  /** Esc: shrinks back into the wall screen (when it is still in view) and closes. */
  close(): Promise<void> {
    if (!this.session) return Promise.resolve();
    if (this.closing) return this.closing;
    const session = this.session;
    this.closing = (async () => {
      this.from = this.from ? (this.host.screenRect(session) ?? null) : null;
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
    if (!this.session) return;
    this.session = null;
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

  /** Reads the floor again and updates the page in place. */
  refresh(): void {
    const s = this.session;
    if (!s) return;
    const d = this.host.data(s);
    const calm = this.calm();
    this.root.toggleAttribute('data-calm', calm);
    if (!d) {
      void this.close();
      return;
    }
    this.floorEl.textContent = s;
    this.root.setAttribute('aria-label', `Floor overview · ${s}`);
    this.whereEl.textContent = `${d.where} · ${d.tree.total} ${d.tree.total === 1 ? 'worker' : 'workers'}`;
    this.renderCounts(d.counts);
    const wasIn = new Map(this.visible.map((v) => [v.row.key, v.parent]));
    this.visible = visibleRows(d.tree, this.prefs.set);
    this.sizes = new Map(d.tree.nodes.map((n) => [n.row.key, n.children.length]));
    const empty = this.visible.length === 0;
    this.emptyEl.hidden = !empty;
    this.board.hidden = empty;
    this.cols.hidden = empty;
    const now = this.host.now?.() ?? Date.now();
    const seen = new Set<string>();
    const order: HTMLElement[] = [];
    this.visible.forEach((v, i) => {
      const key = v.row.key;
      seen.add(key);
      const sig = `${rowSig(v)}${v.depth && this.lastChild(v) ? '|last' : ''}`;
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
    // A group that unfolds again takes its rows back at once: the ones still folding away go.
    for (const [el, p] of this.leaving) {
      if (!this.prefs.collapsed(p) || !this.rows.has(p)) this.drop(el);
    }
    const fold: HTMLElement[] = [];
    for (const [k, e] of this.rows) {
      if (!seen.has(k)) {
        // A row of a group you just collapsed folds away under it; one that left the floor goes at once.
        const p = wasIn.get(k);
        if (!calm && p && seen.has(p) && this.prefs.collapsed(p) && typeof e.el.animate === 'function') {
          this.leaving.set(e.el, p);
          fold.push(e.el);
        } else e.el.remove();
        this.rows.delete(k);
      }
    }
    // Moves only when the order changed (a new or departed row, a fold): a focused row keeps its focus.
    const cur = [...this.board.children].filter((c) => !this.leaving.has(c as HTMLElement));
    if (cur.length !== order.length || cur.some((c, i) => c !== order[i]) || fold.length) {
      const a = document.activeElement;
      this.board.replaceChildren(...order);
      // The folding rows stay under their group (in their order) until they are gone.
      const after = new Map<string, HTMLElement>();
      for (const [el, p] of this.leaving) {
        const anchor = after.get(p) ?? this.rows.get(p)?.el;
        if (!anchor?.isConnected) {
          this.drop(el);
          continue;
        }
        anchor.after(el);
        after.set(p, el);
      }
      if (a instanceof HTMLElement && this.board.contains(a) && !this.leaving.has(a) && document.activeElement !== a) a.focus({ preventScroll: true });
    }
    this.foldAway(fold);
    if (!this.focusKey || !this.rows.has(this.focusKey)) this.setFocus(this.visible[0]?.row.key ?? null, false);
    else this.setFocus(this.focusKey, false);
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
    el.className = `ov-row ov-row--${r.kind}${v.depth ? ' ov-row--child' : ''}`;
    el.dataset.depth = String(v.depth);
    el.setAttribute('aria-level', String(v.depth + 1));
    if (v.expandable) el.setAttribute('aria-expanded', String(v.expanded));
    else el.removeAttribute('aria-expanded');
    const last = v.depth === 1 && this.lastChild(v);
    const wire = v.depth
      ? svgEl(
          `<svg class="ov-wire" aria-hidden="true"><line x1="10" y1="0" x2="10" y2="${last ? '22' : '100%'}" pathLength="1"/><line x1="10" y1="22" x2="24" y2="22" pathLength="1"/></svg>`,
        )
      : null;
    const fold = v.expandable ? h('span', { class: 'ov-fold', 'aria-hidden': 'true', 'data-fold': '1', title: v.expanded ? 'Collapse (←)' : 'Expand (→)' }, icon(ICON.chevron)) : null;
    if (r.kind === 'worker') {
      el.dataset.display = r.display;
      el.style.setProperty('--run', r.runColor !== null ? `#${r.runColor.toString(16).padStart(6, '0')}` : 'transparent');
      const label = [r.name, r.tag, r.model, r.ticket ? `${r.ticket.key}${r.ticket.title ? ` ${r.ticket.title}` : ''}` : null, r.task ? `Task: ${r.task.text}` : null, r.now ? `Now: ${r.now.text}` : null, sinceText(r.display, r.since, now)]
        .filter(Boolean)
        .join(' · ');
      el.setAttribute('aria-label', label);
      const who = h(
        'div',
        { class: 'ov-who' },
        h('span', { class: 'ov-name' }, r.name),
        r.tag ? h('span', { class: 'ov-tag' }, r.tag) : null,
        r.floor ? h('span', { class: 'ov-floortag' }, r.floor) : null,
        h(
          'span',
          { class: 'ov-meta' },
          r.model || r.harness || '',
          ...orchWords(r.orch).map((w) => ` · ${w}`),
        ),
        r.orch?.overCap ? h('span', { class: 'ov-cap' }, 'Over cap') : null,
      );
      const what = h(
        'div',
        { class: 'ov-what' },
        r.ticket ? this.ticketEl(r) : null,
        r.task ? lineEl('ov-task', 'Task', r.task.text, r.task.llm) : null,
        r.now || r.activity ? this.nowEl(r) : null,
        !r.ticket && !r.task && !r.now && !r.activity ? h('p', { class: 'ov-line ov-quiet' }, 'No turn yet') : null,
      );
      el.replaceChildren(h('span', { class: 'ov-light', 'aria-hidden': 'true' }), wire ?? '', fold ?? '', who, what, h('span', { class: 'ov-since' }, sinceText(r.display, r.since, now)), h('span', { class: 'ov-hint', 'aria-hidden': 'true' }, 'Open transcript ', h('kbd', {}, '↵')));
      return;
    }
    delete el.dataset.display;
    if (r.kind === 'ghost') {
      el.setAttribute('aria-label', `Orchestrator ${r.name} · ${r.floor}: go there`);
      el.replaceChildren(
        h('span', { class: 'ov-light ov-light--ghost', 'aria-hidden': 'true' }),
        fold ?? '',
        h('div', { class: 'ov-who' }, h('span', { class: 'ov-ghost-label' }, 'Orchestrator'), h('span', { class: 'ov-name' }, r.name), h('span', { class: 'ov-floortag' }, r.floor)),
        h('div', { class: 'ov-what' }, h('p', { class: 'ov-line ov-quiet' }, 'Runs on another floor; its freelancers here are below.')),
        h('span', { class: 'ov-since' }, ''),
        h('span', { class: 'ov-hint', 'aria-hidden': 'true' }, 'Go there ', h('kbd', {}, '↵')),
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
      h('span', { class: 'ov-since' }, ''),
    );
  }

  private ticketEl(r: OverviewWorkerRow): HTMLElement {
    const t = r.ticket as NonNullable<OverviewWorkerRow['ticket']>;
    const body = [h('span', { class: 'ov-ticket-key' }, t.key), t.title ? h('span', { class: 'ov-ticket-title' }, t.title) : null];
    if (!t.item) return h('p', { class: 'ov-ticket ov-ticket--plain' }, ...body);
    return h('button', { class: 'ov-ticket', tabindex: '-1', 'data-ticket': '1', title: `Open ${t.key} (t)` }, ...body);
  }

  private nowEl(r: OverviewWorkerRow): HTMLElement {
    const p = h('p', { class: 'ov-line ov-now' }, h('b', {}, 'Now'));
    if (r.now) p.append(h('span', { class: 'ov-now-text' }, r.now.text));
    if (r.now?.llm) p.append(h('span', { class: 'ov-llm', title: 'Summarised by the AI model' }, 'AI'));
    if (r.activity) p.append(h('span', { class: 'ov-act' }, r.activity));
    return p;
  }

  private since(el: HTMLElement, r: OverviewRow, now: number): void {
    if (r.kind !== 'worker') return;
    const s = el.querySelector('.ov-since');
    const t = sinceText(r.display, r.since, now);
    if (s && s.textContent !== t) s.textContent = t;
  }

  private lastChild(v: VisibleRow): boolean {
    const i = this.visible.indexOf(v);
    const next = this.visible[i + 1];
    return !next || next.parent !== v.parent;
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
    } else if (k === 'Enter' && v) {
      // Enter on a focused button (the close, Expand all) presses it.
      if (document.activeElement instanceof HTMLButtonElement && !document.activeElement.closest('.ov-row')) handled = false;
      else this.activate(v.row);
    } else if (k === 't' && v?.row.kind === 'worker') this.ticket(v.row);
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
    else this.activate(v.row);
  }

  private activate(r: OverviewRow): void {
    if (r.kind === 'unlinked') {
      this.toggle(r.key, !this.prefs.collapsed(r.key));
      return;
    }
    // The go-to shuts the page itself (no shrink: you are going somewhere else), O brings it back.
    const id = r.id;
    this.closeNow();
    this.host.goTo(id);
  }

  private ticket(r: OverviewWorkerRow): void {
    const item = r.ticket?.item;
    if (!item) return;
    this.host.openTicket(item.session, item.id);
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
    this.prefs.setCollapsed(key, collapse);
    this.refresh();
    this.setFocus(key);
  }

  private setAll(collapse: boolean): void {
    const s = this.session;
    const d = s ? this.host.data(s) : null;
    if (!d) return;
    this.prefs.setAll(
      d.tree.nodes.filter((n) => n.children.length).map((n) => n.row.key),
      collapse,
    );
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
        if (sib === node || !(sib instanceof HTMLElement) || sib.inert || sib instanceof HTMLScriptElement) continue;
        sib.inert = true;
        this.inerted.push(sib);
      }
    }
  }

  info(): OverviewInfo {
    return {
      open: this.isOpen,
      floor: this.session,
      rows: this.visible.map((v) => ({
        key: v.row.key,
        depth: v.depth,
        display: v.row.kind === 'worker' ? v.row.display : null,
        text: this.rows.get(v.row.key)?.el.textContent ?? '',
        expanded: v.expandable ? v.expanded : null,
      })),
      focused: this.focusKey,
      empty: this.isOpen && this.visible.length === 0,
      calm: this.root.hasAttribute('data-calm'),
      from: this.from,
    };
  }
}

function lineEl(cls: string, label: string, text: string, llm: boolean): HTMLElement {
  return h('p', { class: `ov-line ${cls}` }, h('b', {}, label), h('span', {}, text), llm ? h('span', { class: 'ov-llm', title: 'Summarised by the AI model' }, 'AI') : null);
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
