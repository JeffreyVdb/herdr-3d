import type { InboxReason } from '../world/inbox';
import { HARNESS_LABEL } from '../world/hire';
import { inboxAge } from '../world/inbox';
import { CornerWatch } from './corner';
import { h, icon, ICON, replaceKeepingFocus } from './dom';
import { keyName } from '../input/shortcuts';
import './inbox.css';

/** One row of the list: who, on which harness, where, why and since when (App builds it from world/inbox.ts). */
export interface InboxEntry {
  id: string;
  name: string;
  harness: string | undefined;
  /** `inboxWhere`: `Herdr 3D › h3d-sesame-3`. */
  where: string;
  reason: InboxReason;
  /** It needs you (the red), else it is done. */
  blocked: boolean;
  /** #106: a finished row has a ×, to dismiss it; a row that needs you has none. */
  dismissable?: boolean;
  /** Unix ms, when it came in. */
  since: number;
}

export interface InboxHost {
  /** A row's click: go to that worker (App.goToWorker). */
  go(id: string): void;
  /** #106: a finished row's ×: dismiss it (App sends `inbox.dismiss`; the row goes when the bridge says so). */
  dismiss(id: string): void;
  now(): number;
}

/** The ages are minutes: redrawn this often while the list is open, and not at all while it is shut. */
const AGE_MS = 20_000;
const PULSE_MS = 1300;

/**
 * #100: the inbox chip, `Inbox 3`, under the plan-limits plate: how many workers need you or are done
 * (world/inbox.ts). Not there at zero, nor when Settings → Display turns it off. A click opens its list under it, the
 * same plate grown: one row per worker, needs-you first, a row's click takes you to its laptop (App.goToWorker); Esc
 * or a click elsewhere shuts it. It sits where the plate would be when the plate is not shown (switched off, no
 * reading yet), and goes away where the plate steps aside or folds (corner.ts): over a screen dialog, the reading
 * overlay, at a laptop, under a dialog on a narrow screen.
 */
export class InboxChip {
  readonly root: HTMLElement;
  private readonly chip: HTMLButtonElement;
  private readonly count = h('b', { class: 'ib-n' });
  private readonly list: HTMLElement;
  private readonly rows = h('ul', { class: 'ib-rows' });
  private entries: readonly InboxEntry[] = [];
  /** What the open list last drew (skips identical redraws on every world event). */
  private drawn = '';
  private on = true;
  private open = false;
  private ages: ReturnType<typeof setInterval> | null = null;
  private pulsing: ReturnType<typeof setTimeout> | null = null;
  private readonly corner = new CornerWatch(() => this.sync());
  /** The plate's height moves the chip down (inbox.css `--ib-lift`); 0 while it is not drawn. */
  private readonly plateSize: ResizeObserver | null;

  constructor(
    parent: HTMLElement,
    plate: HTMLElement,
    private readonly host: InboxHost,
  ) {
    this.chip = h('button', { class: 'ib-chip', 'data-key': 'inbox', 'aria-expanded': 'false', 'aria-controls': 'ib-list' }, h('span', { class: 'ib-lab' }, 'Inbox'), this.count, icon(ICON.chevron));
    this.chip.querySelector('svg')?.classList.add('ib-chev');
    this.list = h('div', { class: 'ib-list', id: 'ib-list', role: 'region', 'aria-label': 'Inbox' }, this.rows);
    this.list.hidden = true;
    this.root = h('div', { class: 'inbox', 'data-hook': 'inbox' }, this.chip, this.list);
    this.root.hidden = true;
    this.chip.addEventListener('click', () => this.toggle(!this.open));
    this.rows.addEventListener('click', (e) => {
      const t = e.target instanceof Element ? e.target : null;
      // #106: the × is its own button beside the row's, so dismissing never goes to the worker.
      const x = t?.closest<HTMLElement>('.ib-x');
      if (x?.dataset.id) {
        this.dismissing(x.dataset.id);
        this.host.dismiss(x.dataset.id);
        return;
      }
      const id = t?.closest<HTMLElement>('.ib-row')?.dataset.id;
      if (!id) return;
      this.toggle(false, false);
      this.host.go(id);
    });
    this.root.addEventListener('keydown', this.onKey);
    parent.append(this.root);
    this.plateSize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.lift(plate)) : null;
    this.plateSize?.observe(plate);
    this.lift(plate);
  }

  /** Who is in the inbox, in its order; empty hides the chip. */
  set(entries: readonly InboxEntry[]): void {
    this.entries = entries;
    const n = entries.length;
    const blocked = entries.some((e) => e.blocked);
    this.count.textContent = String(n);
    this.root.dataset.blocked = String(blocked);
    if (n) {
      const why = blocked ? 'someone needs you' : 'finished work to look at';
      this.chip.setAttribute('aria-label', `Inbox: ${n}, ${why}.`);
      this.chip.title = `Inbox: ${why}. Click for who and where (${keyName('inbox')}).`;
    }
    this.sync();
    if (this.open) this.draw();
  }

  /** Settings → Display "Show inbox". */
  set enabled(on: boolean) {
    this.on = on;
    this.sync();
  }

  /** #100 contract: draws the eye to the chip (a new entry while the window is in front). */
  pulse(): void {
    if (this.root.hidden) return;
    if (this.pulsing) clearTimeout(this.pulsing);
    delete this.root.dataset.pulse;
    void this.root.offsetWidth; // restart the animation
    this.root.dataset.pulse = 'true';
    this.pulsing = setTimeout(() => {
      this.pulsing = null;
      delete this.root.dataset.pulse;
    }, PULSE_MS);
  }

  /** #100 contract: opens the chip's list (a collapsed notification's click); nothing while the chip is not shown. */
  openList(focus = false): void {
    if (this.root.hidden) return;
    this.toggle(true, false);
    // #124: from the keyboard (Shift+N) the focus goes into the list, on the first row: arrows walk it, Enter goes there.
    if (focus) (this.rows.querySelector<HTMLElement>('.ib-row') ?? this.chip).focus();
  }

  /** #124: shuts the list, the focus back on the chip when it was inside. */
  closeList(): void {
    this.toggle(false);
  }

  private toggle(open: boolean, focusChip = true): void {
    if (open === this.open) return;
    this.open = open;
    this.root.dataset.open = String(open);
    this.chip.setAttribute('aria-expanded', String(open));
    this.list.hidden = !open;
    if (this.ages) clearInterval(this.ages);
    this.ages = null;
    if (open) {
      this.drawn = '';
      this.draw();
      this.ages = setInterval(() => this.draw(), AGE_MS);
      document.addEventListener('pointerdown', this.onOutside, true);
      document.addEventListener('keydown', this.onEsc, true);
    } else {
      document.removeEventListener('pointerdown', this.onOutside, true);
      document.removeEventListener('keydown', this.onEsc, true);
      if (focusChip && this.root.contains(document.activeElement) && !this.root.hidden) this.chip.focus();
    }
  }

  /** Where the focus goes when the × just pressed takes its row away: the next row's ×, else the previous one's. */
  private focusAfter: string | undefined;

  private dismissing(id: string): void {
    const i = this.entries.findIndex((e) => e.id === id);
    const near = this.entries[i + 1] ?? this.entries[i - 1];
    this.focusAfter = near ? (near.dismissable ? `x:${near.id}` : `row:${near.id}`) : undefined;
  }

  private draw(): void {
    const now = this.host.now();
    const key = this.entries.map((e) => [e.id, e.name, e.harness, e.where, e.reason, e.dismissable, inboxAge(e.since, now)].join('\u0001')).join('\u0000');
    if (key === this.drawn) return;
    this.drawn = key;
    replaceKeepingFocus(this.rows, this.entries.map((e) => row(e, now)), this.focusAfter);
    this.focusAfter = undefined;
  }

  private sync(): void {
    this.root.hidden = !this.on || !this.entries.length || this.corner.screen || this.corner.folded;
    this.root.dataset.beside = this.corner.beside;
    if (this.root.hidden) this.toggle(false, false);
  }

  private lift(plate: HTMLElement): void {
    const r = plate.getBoundingClientRect();
    this.root.style.setProperty('--ib-lift', r.height > 0 ? `${(r.height + 6).toFixed(1)}px` : '0px');
  }

  /** The list's keys are its own (the walker would take the arrows, Space and Enter): the arrows walk the rows. */
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') {
      if (!this.open) {
        if (k !== 'ArrowDown') return;
        this.toggle(true, false);
      }
      e.preventDefault();
      const all = [this.chip, ...this.rows.querySelectorAll<HTMLButtonElement>('.ib-row, .ib-x')]; // #106: each ×, after its row
      const i = all.indexOf(document.activeElement as HTMLButtonElement);
      const to = k === 'Home' ? 1 : k === 'End' ? all.length - 1 : Math.min(all.length - 1, Math.max(0, i + (k === 'ArrowDown' ? 1 : -1)));
      all[to]?.focus();
    } else if (k !== 'Enter' && k !== ' ') return;
    e.stopPropagation();
  };

  /** Open, Esc shuts it wherever the focus is (opened with the mouse, it may be on the page), but not a dialog's or a field's Esc. */
  private readonly onEsc = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && !this.root.contains(t) && t.closest('dialog, input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    e.stopPropagation();
    this.toggle(false);
  };

  private readonly onOutside = (e: Event): void => {
    if (!(e.target instanceof Node) || !this.root.contains(e.target)) this.toggle(false, false);
  };

  /** What the chip shows (test hook): shown, how many, whether someone needs you, the list open and its rows. */
  summary(): { shown: boolean; count: number; blocked: boolean; open: boolean; rows: Array<{ id: string; name: string; where: string; reason: InboxReason; dismissable: boolean }> } {
    return {
      shown: !this.root.hidden,
      count: this.entries.length,
      blocked: this.entries.some((e) => e.blocked),
      open: this.open,
      rows: this.open ? this.entries.map(({ id, name, where, reason, dismissable }) => ({ id, name, where, reason, dismissable: !!dismissable })) : [],
    };
  }

  dispose(): void {
    this.toggle(false, false);
    if (this.pulsing) clearTimeout(this.pulsing);
    this.root.removeEventListener('keydown', this.onKey);
    this.corner.dispose();
    this.plateSize?.disconnect();
    this.root.remove();
  }
}


function row(e: InboxEntry, now: number): HTMLLIElement {
  const age = inboxAge(e.since, now);
  const agent = (e.harness && HARNESS_LABEL[e.harness]) || e.harness || 'Agent';
  const label = `${e.name}, ${agent}: ${e.reason}. ${e.where}, ${age === 'now' ? 'just now' : `${age} ago`}. Go to its laptop.`;
  return h(
    'li',
    { class: 'ib-item', 'data-dismissable': String(!!e.dismissable) },
    h(
      'button',
      { class: 'ib-row', 'data-id': e.id, 'data-key': `row:${e.id}`, 'data-blocked': String(e.blocked), 'aria-label': label, title: `${e.name} · ${agent} · ${e.where}` },
      sticker(e.harness),
      h('span', { class: 'ib-name' }, e.name),
      h('span', { class: `tape ib-why tape--${e.blocked ? 'needs_you' : 'done'}` }, e.reason),
      h('span', { class: 'ib-where' }, e.where),
      h('span', { class: 'ib-age' }, age),
    ),
    e.dismissable ? dismissButton(e) : null,
  );
}

/** #106: the × of a finished row, a sibling of the row's button (a button cannot hold one). */
function dismissButton(e: InboxEntry): HTMLButtonElement {
  return h('button', { class: 'ib-x', type: 'button', 'data-id': e.id, 'data-key': `x:${e.id}`, 'aria-label': `Dismiss ${e.name}`, title: 'Dismiss: hide until it finishes again' }, icon(ICON.close));
}

/** The laptop sticker (render/deskArt.ts): the Claude Code spark on cream, the Codex `>_` on ink, a plain disc for the rest. */
const SPARK = Array.from({ length: 11 }, (_, i) => {
  const a = (i / 11) * Math.PI * 2 - Math.PI / 2 + (i % 3) * 0.05;
  const r = 6.4;
  const len = r * (i % 2 ? 0.78 : 1);
  const p = (d: number) => `${(12 + Math.cos(a) * d).toFixed(2)} ${(12 + Math.sin(a) * d).toFixed(2)}`;
  return `<path d="M${p(r * 0.12)}L${p(len)}" stroke-width="${(r * (i % 2 ? 0.2 : 0.24)).toFixed(2)}"/>`;
}).join('');
const STICKERS: Record<'claude' | 'codex' | 'plain', string> = {
  claude: `<circle cx="12" cy="12" r="10" fill="#f6f1e7"/><g stroke="#d97757" stroke-linecap="round">${SPARK}</g>`,
  codex: '<circle cx="12" cy="12" r="10" fill="#11141c"/><path d="M7.2 7.9 11.8 12l-4.6 4.1" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/><rect x="13.1" y="14.3" width="4.8" height="2" rx=".8" fill="#fff"/>',
  plain: '<circle cx="12" cy="12" r="10" fill="#5b6685"/>',
};

function sticker(harness: string | undefined): SVGSVGElement {
  const t = document.createElement('template');
  const logo = harness === 'claude' || harness === 'codex' ? harness : 'plain';
  t.innerHTML = `<svg class="ib-stk" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${STICKERS[logo]}</svg>`;
  return t.content.firstElementChild as SVGSVGElement;
}
