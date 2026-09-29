import type { CommandResult } from '../net/client';
import type { LimitBook, ProviderView, WindowView } from '../world/limits';
import type { LimitTarget } from '../world/limits';
import { harnessViews, limitsView, warningOf, windowName } from '../world/limits';
import { h, icon, ICON } from './dom';
import { LimitsPrefs } from './limitsPrefs';
import './limits.css';

/**
 * The plan-limits widget (M10, #12): the Claude and Codex windows in the top
 * right corner, over the city, the floors and every overlay. Plain DOM and
 * CSS, no WebGL. It renders from the views of world/limits.ts and only when
 * the bridge sends a reading (`limits.update`) or a reading crosses into
 * stale; `tick` is that second check and does nothing else.
 *
 * Over a screen-filling dialog (SCREEN, #47) the plate would hide its close button and first row, so it
 * steps out of it: into a slim edge tab (worst percentage and a severity bar) when the viewport leaves a
 * gutter right of the dialog for it, else away completely, like the narrow-viewport fold. Either way it
 * stays reachable: a click on the tab or Shift+L "peeks" the plate over the dialog (expanded, whatever the
 * saved state), and clicking the plate's header, Shift+L again, a click outside it, or closing the dialog
 * it was started over (or opening another one on top of it) ends the peek. A peek never touches the saved prefs, so when the dialog closes the plate is what it was.
 */

/** Below this width a dialog or the Changes panel spans the screen (limits.css follows the same line). */
const NARROW = '(max-width: 760px)';

/**
 * The dialogs that fill the screen (the M3 panels, the Issues / Pull requests boards and their item modal): at any
 * viewport width the plate steps out of them. The confirm, hire, start-run, send-home, prompt, presets and open-PR
 * dialogs are small and centred; they keep today's behaviour (the plate stays above them in the top layer, and the
 * hire and start-run ones show the limits inline as well).
 */
const SCREEN = 'dialog.panel[open], dialog.desk-dlg--board[open], dialog.desk-dlg--item[open]';

/** Free width the edge tab needs right of a screen dialog: its 32 px, 8 px from the edge, and 8 px clear of the dialog (limits.css). */
const TAB_ROOM = 48;

export interface LimitsHost {
  now(): number;
  /** `limits.refresh`. */
  refresh(): Promise<CommandResult>;
  toast(msg: string): void;
}

const bar = (w: WindowView): HTMLElement => h('span', { class: 'lm-bar', 'data-sev': w.severity, style: `--frac:${(Math.min(100, Math.max(0, w.pct)) / 100).toFixed(3)}`, 'aria-hidden': 'true' }, h('i'));

const resetIcon = () => {
  const i = icon(ICON.refresh);
  i.classList.add('lm-reset-ic');
  return i;
};

/** One window as a compact inline group: label, bar, percentage, reset time. */
function windowChip(w: WindowView): HTMLElement {
  return h('span', { class: 'lm-win', 'data-sev': w.severity }, h('span', { class: 'lm-lab' }, windowName(w)), bar(w), h('b', { class: 'lm-pct' }, w.pctText), w.resets ? h('span', { class: 'lm-rs' }, resetIcon(), w.resets) : null);
}

const providerTape = (v: ProviderView) => h('span', { class: `tape lm-tape lm-tape--${v.provider}` }, v.name);

/** The collapsed line of one provider; a dialog's line (`models`) adds the per-model windows that count for it. */
function providerLine(v: ProviderView, models = false): HTMLElement {
  const shown = models ? [...v.windows, ...v.models] : v.windows;
  const wins = shown.length ? shown.map(windowChip) : [h('span', { class: 'lm-none' }, v.problem ?? 'No reading yet')];
  return h(
    'div',
    { class: 'lm-line', 'data-provider': v.provider, 'data-stale': v.stale ? 'true' : null, 'data-reached': v.reached ? 'true' : null },
    providerTape(v),
    v.plan ? h('span', { class: 'lm-plan' }, v.plan) : null,
    h('span', { class: 'lm-wins' }, ...wins),
    v.asOf ? h('em', { class: 'lm-asof' }, v.asOf) : null,
  );
}

/** A window as a row of the expanded panel. */
function windowRow(w: WindowView): HTMLElement {
  return h('li', { class: 'lm-row', 'data-sev': w.severity }, h('span', { class: 'lm-rowlab' }, windowName(w)), bar(w), h('b', { class: 'lm-pct' }, w.pctText), h('span', { class: 'lm-rs' }, w.resets ? ['resets ', w.resets].join('') : ''));
}

function providerSection(v: ProviderView): HTMLElement {
  return h(
    'section',
    { class: 'lm-sec', 'data-provider': v.provider, 'data-stale': v.stale ? 'true' : null, 'data-reached': v.reached ? 'true' : null },
    h('header', {}, providerTape(v), v.plan ? h('span', { class: 'lm-plan' }, v.plan) : null, v.reached ? h('strong', { class: 'lm-hit' }, 'Limit reached') : null),
    v.windows.length || v.models.length ? h('ul', { class: 'lm-rows' }, ...v.windows.map(windowRow), ...v.models.map(windowRow)) : null,
    v.credits !== null ? h('p', { class: 'lm-meta' }, h('span', {}, 'Credits'), h('b', {}, v.credits)) : null,
    v.problem ? h('p', { class: 'lm-problem' }, v.problem) : null,
    v.readNote ? h('p', { class: 'lm-read' }, v.readNote) : null,
  );
}

const summary = (views: ProviderView[]): string =>
  views.length ? views.map((v) => `${v.name}${v.plan ? ` ${v.plan}` : ''}: ${v.windows.map((w) => `${w.label} ${w.pctText}`).join(', ') || v.problem || 'no reading'}${v.stale ? ' (old reading)' : ''}`).join('; ') : 'reading';

export class LimitsWidget {
  readonly root: HTMLElement;
  private readonly strip: HTMLButtonElement;
  /** The edge tab shown over a screen dialog (limits.css shows it only then). */
  private readonly tab: HTMLButtonElement;
  private readonly tabPct = h('span', { class: 'lm-tab-pct' });
  private readonly tabBar = h('span', { class: 'lm-tab-bar', 'aria-hidden': 'true' }, h('i'));
  /** Temporary: the plate opened over a screen dialog. Not a pref; it ends with the dialog. */
  private peek = false;
  /** The topmost screen dialog when the peek started: the peek lasts while it is still the topmost one. */
  private peekOwner: Element | null = null;
  private readonly lines = h('div', { class: 'lm-lines' });
  private readonly panel = h('div', { class: 'lm-panel', id: 'lm-panel', role: 'region', 'aria-label': 'Plan limits' });
  /** The part of the panel that scrolls on a short viewport; the action row under it never does. */
  private readonly body = h('div', { class: 'lm-body', tabindex: '0', role: 'group', 'aria-label': 'Plan limit details' });
  private readonly status = h('span', { class: 'lm-status', role: 'status' });
  private readonly refreshBtn = h('button', { class: 'btn btn--sm lm-refresh', 'data-key': 'limits-refresh', title: 'Read the limits now' }, icon(ICON.refresh), h('span', {}, 'Refresh'));
  private key = '';
  private refreshing = false;
  private off: () => void;

  constructor(
    parent: HTMLElement,
    private readonly book: LimitBook,
    private readonly host: LimitsHost,
    readonly prefs: LimitsPrefs = new LimitsPrefs(),
  ) {
    this.strip = h('button', { class: 'lm-strip', 'aria-expanded': 'false', 'aria-controls': 'lm-panel', title: 'Plan limits: click for details (Shift+L)' }, this.lines, h('span', { class: 'lm-title' }, 'Plan limits'), icon(ICON.chevron));
    this.strip.lastElementChild?.classList.add('lm-chev');
    this.strip.addEventListener('click', () => this.toggle());
    this.tab = h('button', { class: 'lm-tab', 'data-key': 'limits-tab', title: 'Plan limits: click to peek (Shift+L)' }, this.tabPct, this.tabBar);
    this.tab.addEventListener('click', () => this.setPeek(true, true));
    this.refreshBtn.addEventListener('click', () => void this.refresh());
    const hide = h('button', { class: 'btn btn--sm lm-hide', 'data-key': 'limits-hide', title: 'Hide this meter (bring it back in About)' }, h('span', {}, 'Hide meter'));
    hide.addEventListener('click', () => {
      this.prefs.hidden = true;
      this.host.toast('Plan limits hidden. Show them again in About.');
    });
    this.panel.hidden = true;
    this.root = h('aside', { class: 'limits', 'data-hook': 'limits', popover: 'manual' }, this.tab, this.strip, this.panel);
    this.foot = h('div', { class: 'lm-foot' }, this.refreshBtn, hide, this.status);
    this.panel.append(this.body, this.foot);
    parent.append(this.root);
    this.home = parent;
    this.off = this.prefs.onChange(() => this.sync());
    this.keepOnTop();
    this.sync();
    this.update();
  }

  private readonly foot: HTMLElement;
  /** Where the widget lives when no screen dialog holds it. */
  private readonly home: HTMLElement;
  private watcher: MutationObserver | null = null;
  /** Narrow viewports: a dialog or the Changes panel fills the screen, so the plate has no room beside it. */
  private readonly narrow = typeof matchMedia === 'function' ? matchMedia(NARROW) : null;
  private readonly onNarrow = () => this.update();
  /** A screen dialog may have more or less room beside it after a resize. */
  private readonly onResize = () => {
    if (this.screenOpen()) this.update();
  };
  private readonly onOutside = (e: Event) => {
    if (!(e.target instanceof Node) || !this.root.contains(e.target)) this.setPeek(false);
  };

  /** A dialog (modal, or the Changes panel) is open, and the viewport is too narrow to sit beside it: the plate is out of the way. */
  private get folded(): boolean {
    return !!this.narrow?.matches && !!document.querySelector('dialog[open]');
  }

  /** Puts the widget on top of the top layer (again). */
  private raise(): void {
    if (typeof this.root.showPopover !== 'function') return;
    try {
      this.root.hidePopover();
      this.root.showPopover();
    } catch {
      /* no popover support: it stays in the page */
    }
  }

  /**
   * A modal dialog makes the rest of the page inert, the top layer included: the tab and the peeking plate
   * could not be clicked over one. So while a screen dialog is open the widget lives inside it (it is still
   * fixed in the viewport corner, as a popover; the dialog's clip and transform do not reach the top layer),
   * and goes home when the last one closes.
   */
  private place(): void {
    const into = (!this.root.hidden && !this.folded && this.topScreen()) || this.home;
    if (this.root.parentElement === into) return;
    into.append(this.root); // leaving the document hides the popover
    this.raise();
  }

  /** The topmost open screen dialog (the last in the document, where a later one opens). */
  private topScreen(): Element | null {
    const dialogs = document.querySelectorAll(SCREEN);
    return dialogs[dialogs.length - 1] ?? null;
  }

  /** A screen-filling dialog is open (and the plate is on screen at all). */
  private screenOpen(): boolean {
    return !this.root.hidden && !this.folded && !!document.querySelector(SCREEN);
  }

  /** The plate steps aside over a screen dialog (a peek excepted): Shift+L reaches it through the app even though the dialog owns the keys. */
  get overScreen(): boolean {
    return this.screenOpen();
  }

  /** Room right of every open screen dialog for the edge tab. */
  private roomForTab(): boolean {
    let right = 0;
    for (const d of document.querySelectorAll(SCREEN)) right = Math.max(right, d.getBoundingClientRect().right);
    return document.documentElement.clientWidth - right >= TAB_ROOM;
  }

  /**
   * Starts or ends a peek. Focus stays where it is unless it was on the plate or the tab, which is the
   * control that just went away: then it follows to the one that took its place (`toFocus`: a click).
   */
  private setPeek(on: boolean, toFocus = false): void {
    if (on === this.peek || !this.screenOpen()) return;
    const had = this.root.contains(document.activeElement);
    this.peek = on;
    this.peekOwner = on ? this.topScreen() : null;
    this.watchOutside(on);
    this.key = '';
    this.update();
    if (had || toFocus) (on ? this.strip : this.tab).focus({ preventScroll: true });
  }

  private watchOutside(on: boolean): void {
    if (on) document.addEventListener('pointerdown', this.onOutside, true);
    else document.removeEventListener('pointerdown', this.onOutside, true);
  }

  /**
   * The widget lives in the browser's top layer (a manual popover), so a modal dialog's backdrop does not dim
   * it; a dialog that opens later would sit above it, so opening one puts the widget back on top. It also
   * follows dialogs: the Changes panel takes the right column (the plate steps aside), and on a narrow
   * viewport any open dialog has the whole screen, so the plate steps out of it (limits.css hides it) and
   * comes back, panel as the user left it, when the dialog closes. The hire and start-run dialogs carry
   * the limits of their harnesses inline meanwhile.
   */
  private keepOnTop(): void {
    this.raise();
    this.narrow?.addEventListener('change', this.onNarrow);
    window.addEventListener('resize', this.onResize);
    if (typeof MutationObserver === 'undefined') return;
    this.watcher = new MutationObserver((records) => {
      if (!records.some((r) => r.target instanceof HTMLDialogElement)) return;
      this.root.dataset.beside = document.querySelector('dialog.changes[open]') ? 'changes' : '';
      this.update();
      if (records.some((r) => r.target instanceof HTMLDialogElement && r.target.open)) this.raise();
    });
    this.watcher.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] });
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  get isHidden(): boolean {
    return this.root.hidden === true;
  }

  /** Shows or hides the panel (remembered). */
  toggle(open: boolean = !this.isOpen): void {
    if (this.root.hidden || this.folded) return;
    if (this.screenOpen()) return this.setPeek(open); // over a screen dialog the plate is a peek, not a pref
    this.prefs.open = open;
    this.sync();
    this.key = '';
    this.render();
  }

  /**
   * Shift+L: brings a hidden widget back with its panel open, else opens or closes the panel. Over a screen
   * dialog it peeks the plate (or ends the peek), leaving the prefs alone; a meter the user hid stays hidden.
   */
  toggleFromKey(): void {
    if (this.folded) return; // a dialog has the screen: the plate is away, and its state is left alone
    if (this.screenOpen()) {
      this.setPeek(!this.peek);
      return;
    }
    if (this.prefs.hidden) {
      this.prefs.open = true;
      this.prefs.hidden = false;
    } else this.toggle();
    this.update();
  }

  /** Brings the widget back or takes it away (from About, or the panel's Hide). */
  private sync(): void {
    this.root.hidden = this.prefs.hidden || !this.book.known;
    const folded = this.folded;
    const screen = this.screenOpen();
    if (this.peek && (!screen || this.topScreen() !== this.peekOwner)) {
      // The dialog it was over is gone (or another opened on top of it, or the meter was hidden): back to the docked/saved state.
      this.peek = false;
      this.peekOwner = null;
      this.watchOutside(false);
    }
    const open = !this.root.hidden && !folded && (screen ? this.peek : this.prefs.open);
    this.place();
    this.root.dataset.folded = String(folded);
    this.root.dataset.dock = screen && !this.peek ? (this.roomForTab() ? 'tab' : 'away') : '';
    this.root.dataset.peek = String(this.peek);
    this.panel.hidden = !open;
    this.strip.setAttribute('aria-expanded', String(open));
    this.root.dataset.open = String(open);
  }

  /** The bridge sent a reading (or a snapshot): render. */
  update(): void {
    this.sync();
    this.render();
  }

  /** Time passed: re-render only when a reading has crossed into stale (or a shown "ago" changed). */
  tick(): void {
    this.render();
  }

  dispose(): void {
    this.off();
    this.watcher?.disconnect();
    this.watchOutside(false);
    window.removeEventListener('resize', this.onResize);
    this.narrow?.removeEventListener('change', this.onNarrow);
    this.root.remove();
  }

  /** What the widget shows (test hook). */
  summary(): { hidden: boolean; open: boolean; lines: Array<{ provider: string; stale: boolean; reached: boolean; windows: Array<{ label: string; pct: string; sev: string }> }> } {
    return {
      hidden: this.root.hidden === true,
      open: this.isOpen,
      lines: [...this.lines.querySelectorAll<HTMLElement>('.lm-line[data-provider]')].map((l) => ({
        provider: l.dataset.provider ?? '',
        stale: l.dataset.stale === 'true',
        reached: l.dataset.reached === 'true',
        windows: [...l.querySelectorAll<HTMLElement>('.lm-win')].map((w) => ({ label: w.querySelector('.lm-lab')?.textContent ?? '', pct: w.querySelector('.lm-pct')?.textContent ?? '', sev: w.dataset.sev ?? '' })),
      })),
    };
  }

  private render(): void {
    if (this.root.hidden) return;
    const now = this.host.now();
    const views = limitsView(this.book, now);
    const open = this.isOpen;
    // Everything that shows, and nothing else: no reading changing, no re-render.
    const key = JSON.stringify([views.map((v) => [v.provider, v.plan, v.windows, v.models, v.stale, v.reached, v.asOf, v.problem, v.credits, open ? v.readNote : '']), open, this.refreshing]);
    if (key === this.key) return;
    this.key = key;
    this.root.dataset.reached = views.some((v) => v.reached) ? 'true' : 'false';
    this.root.dataset.worst = views.reduce<string>((s, v) => (v.worstSeverity === 'high' || (v.worstSeverity === 'warn' && s === 'ok') ? v.worstSeverity : s), 'ok');
    this.strip.setAttribute('aria-label', `Plan limits. ${summary(views)}.`);
    const worst = views.reduce((m, v) => [...v.windows, ...v.models].reduce((n, w) => Math.max(n, w.pct), m), 0);
    this.tabPct.textContent = views.some((v) => v.windows.length || v.models.length) ? `${Math.round(worst)}%` : '–';
    this.tabBar.style.setProperty('--frac', (Math.min(100, Math.max(0, worst)) / 100).toFixed(3));
    this.tab.setAttribute('aria-label', `Plan limits. ${summary(views)}. Show details (Shift+L).`);
    this.lines.replaceChildren(...(views.length ? views.map((v) => providerLine(v)) : [h('div', { class: 'lm-line lm-line--wait' }, h('span', { class: 'lm-none' }, 'Plan limits · reading…'))]));
    if (!open) return;
    this.refreshBtn.disabled = this.refreshing;
    this.refreshBtn.querySelector('span')!.textContent = this.refreshing ? 'Reading…' : 'Refresh';
    this.body.replaceChildren(...views.map(providerSection));
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    this.status.textContent = '';
    this.render();
    const r = await this.host.refresh();
    this.refreshing = false;
    this.status.textContent = r.ok ? ((r.data as { queued?: boolean } | undefined)?.queued === false ? 'Just read; try again in a few seconds.' : '') : 'Could not ask the bridge to read.';
    this.key = '';
    this.render();
  }
}

/**
 * The limits of the harnesses a dialog is about (hire: one; start-run: the
 * team's), inline, with the per-model windows of the chosen models and a
 * warning above 85 % (model windows count too). null when the bridge sent no
 * reading for them (the dialog hides its slot).
 */
export function planLimits(book: LimitBook, targets: ReadonlyArray<string | LimitTarget>, now: number): HTMLElement | null {
  const views = harnessViews(book, targets, now);
  if (!views.length) return null;
  const warnings = views.map(warningOf).filter(Boolean);
  return h(
    'div',
    { class: 'lm-inline', 'data-hot': warnings.length ? 'true' : 'false' },
    h('p', { class: 'lm-inline-title' }, 'Plan limits'),
    ...views.map((v) => providerLine(v, true)),
    ...warnings.map((w) => h('p', { class: 'lm-warn', role: 'status' }, w)),
  );
}
