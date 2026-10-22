import type { CommandResult } from '../net/client';
import type { LimitBook, ProviderView, WindowView } from '../world/limits';
import type { LimitTarget } from '../world/limits';
import { harnessViews, limitsView, warningOf, windowName } from '../world/limits';
import { profileDrift, type CodexProfilesBook } from '../world/codexProfiles';
import { CornerWatch, READING, SCREEN, SEATED } from './corner';
import { h, icon, ICON } from './dom';
import { LimitsPrefs } from './limitsPrefs';
import { UI_THEME_ATTR } from './uiTheme';
import './limits.css';

/**
 * The plan-limits widget (M10, #12): the Claude and Codex windows in the top
 * right corner, over the city, the floors and every overlay. Plain DOM and
 * CSS, no WebGL. It renders from the views of world/limits.ts and only when
 * the bridge sends a reading (`limits.update`) or a reading crosses into
 * stale; `tick` is that second check and does nothing else.
 *
 * Over a screen-filling dialog (SCREEN, #47, #51; and since #147 the command palette, always the topmost modal) the plate would hide its close button and first row, so it
 * steps out of it, and so it does while you sit at a worker's laptop (#53, SEATED): into a slim edge tab (worst
 * percentage and a severity bar) when the viewport leaves a gutter right of the dialog for it, else away completely, like the narrow-viewport fold. Either way it
 * stays reachable: a click on the tab or Shift+L "peeks" the plate over the dialog (expanded, whatever the
 * saved state), and clicking the plate's header, Shift+L again, a click outside it, or closing the dialog
 * it was started over (or opening another one on top of it) ends the peek. A peek never touches the saved prefs, so when the dialog closes the plate is what it was.
 * Seated, the laptop's glass (terminal and conversation alike) is the screen to keep clear of: the plate is the tab in
 * the gutter right of it when there is room, else away (the same peek, which ends when you stand up), and standing up
 * gives back the docked or open plate the prefs say. At the terminal Shift+L is an L for the pane (as in any text
 * box), so the tab is the way in there when it shows; in the conversation Shift+L peeks.
 */

/** Free width the edge tab needs right of a screen dialog: its 32 px, 8 px from the edge, and 8 px clear of the dialog (limits.css). */
const TAB_ROOM = 48;

/** Free width the snug tab (22 px, 3 px from the edge, 2 px clear of the glass; data-fit='snug' in limits.css) needs where the full one does not fit. */
const TAB_ROOM_SNUG = 27;
/** #216: the Ubuntu UI theme's snug tab is a 32 px target (its smallest control size), flush with the edge, 2 px clear of the glass. */
const TAB_ROOM_SNUG_UBUNTU = 34;

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

/** #167: a Codex profile row's drifted shared setup (null: none, or a bridge without sharing). */
type Drift = { text: string } | null;

/**
 * #138: with two or more Codex profiles, the row's profile name; the bridge's own home is marked "default". #167: a
 * profile whose shared setup drifted is marked "drifted" (its words on hover; the panel says them and where to fix it).
 */
const profileTag = (v: ProviderView, drift: Drift = null): HTMLElement | null =>
  v.profile === null
    ? null
    : h(
        'span',
        { class: 'lm-acct', 'data-default': v.isDefault ? 'true' : null, title: v.isDefault ? `${v.profile}: the bridge’s own Codex home` : `Codex profile ${v.profile}` },
        h('span', { class: 'lm-acct-name' }, v.profile),
        v.isDefault ? h('span', { class: 'lm-acct-def' }, 'default') : null,
        drift ? h('span', { class: 'lm-acct-drift', 'data-hook': 'drift-badge', title: drift.text }, 'drifted') : null,
      );

/** The attributes a row carries: its provider (and with profiles its profile's key), stale, reached. */
const rowAttrs = (v: ProviderView, cls: string) => ({
  class: cls,
  'data-provider': v.provider,
  'data-account': v.profile !== null ? v.account : null,
  'data-stale': v.stale ? 'true' : null,
  'data-reached': v.reached ? 'true' : null,
});

/** The collapsed line of one provider; a dialog's line (`models`) adds the per-model windows that count for it. */
function providerLine(v: ProviderView, models = false, drift: Drift = null): HTMLElement {
  const shown = models ? [...v.windows, ...v.models] : v.windows;
  const wins = shown.length ? shown.map(windowChip) : [h('span', { class: 'lm-none' }, v.problem ?? 'No reading yet')];
  return h(
    'div',
    rowAttrs(v, 'lm-line'),
    providerTape(v),
    profileTag(v, drift),
    v.plan ? h('span', { class: 'lm-plan' }, v.plan) : null,
    h('span', { class: 'lm-wins' }, ...wins),
    v.asOf ? h('em', { class: 'lm-asof' }, v.asOf) : null,
  );
}

/** A window as a row of the expanded panel. */
function windowRow(w: WindowView): HTMLElement {
  return h('li', { class: 'lm-row', 'data-sev': w.severity }, h('span', { class: 'lm-rowlab' }, windowName(w)), bar(w), h('b', { class: 'lm-pct' }, w.pctText), h('span', { class: 'lm-rs' }, w.resets ? ['resets ', w.resets].join('') : ''));
}

function providerSection(v: ProviderView, drift: Drift = null): HTMLElement {
  return h(
    'section',
    rowAttrs(v, 'lm-sec'),
    h('header', {}, providerTape(v), profileTag(v, drift), v.plan ? h('span', { class: 'lm-plan' }, v.plan) : null, v.reached ? h('strong', { class: 'lm-hit' }, 'Limit reached') : null),
    v.windows.length || v.models.length ? h('ul', { class: 'lm-rows' }, ...v.windows.map(windowRow), ...v.models.map(windowRow)) : null,
    v.credits !== null ? h('p', { class: 'lm-meta' }, h('span', {}, 'Credits'), h('b', {}, v.credits)) : null,
    v.problem ? h('p', { class: 'lm-problem' }, v.problem) : null,
    v.readNote ? h('p', { class: 'lm-read' }, v.readNote) : null,
    drift ? h('p', { class: 'lm-problem lm-drift', 'data-hook': 'drift' }, drift.text) : null,
  );
}

const summary = (views: ProviderView[]): string =>
  views.length ? views.map((v) => `${v.name}${v.profile !== null ? ` ${v.profile}${v.isDefault ? ' (default)' : ''}` : ''}${v.plan ? ` ${v.plan}` : ''}: ${v.windows.map((w) => `${w.label} ${w.pctText}`).join(', ') || v.problem || 'no reading'}${v.stale ? ' (old reading)' : ''}`).join('; ') : 'reading';

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
    /** #167: the Codex profiles, for a drifted shared setup's mark on its row (absent: none). */
    private readonly profiles?: CodexProfilesBook,
  ) {
    this.strip = h('button', { class: 'lm-strip', 'aria-expanded': 'false', 'aria-controls': 'lm-panel', title: 'Plan limits: click for details (Shift+L)' }, this.lines, h('span', { class: 'lm-title' }, 'Plan limits'), icon(ICON.chevron));
    this.strip.lastElementChild?.classList.add('lm-chev');
    this.strip.addEventListener('click', () => this.toggle());
    this.tab = h('button', { class: 'lm-tab', 'data-key': 'limits-tab', title: 'Plan limits: click to peek (Shift+L)' }, this.tabPct, this.tabBar);
    this.tab.addEventListener('click', () => this.setPeek(true, true));
    this.refreshBtn.addEventListener('click', () => void this.refresh());
    const hide = h('button', { class: 'btn btn--sm lm-hide', 'data-key': 'limits-hide', title: 'Hide this meter (bring it back in Settings)' }, h('span', {}, 'Hide meter'));
    hide.addEventListener('click', () => {
      this.prefs.hidden = true;
      this.host.toast('Plan limits hidden. Show them again in Settings.');
    });
    this.panel.hidden = true;
    this.root = h('aside', { class: 'limits', 'data-hook': 'limits', popover: 'manual' }, this.tab, this.strip, this.panel);
    this.foot = h('div', { class: 'lm-foot' }, this.refreshBtn, hide, this.status);
    this.panel.append(this.body, this.foot);
    parent.append(this.root);
    this.home = parent;
    const offPrefs = this.prefs.onChange(() => this.sync());
    const offProfiles = this.profiles?.onChange(() => this.render());
    this.off = () => {
      offPrefs();
      offProfiles?.();
    };
    // The snug tab's room depends on the UI theme (its size): a live switch places the tab again.
    this.themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ui-theme'] }); // dataset[UI_THEME_ATTR]
    this.keepOnTop();
    this.sync();
    this.update();
  }

  private readonly foot: HTMLElement;
  /** Where the widget lives when no screen dialog holds it. */
  private readonly home: HTMLElement;
  /** What takes the corner away (corner.ts): a change re-places the plate, and a dialog that opened puts it back on top. */
  private readonly corner = new CornerWatch((opened) => {
    this.root.dataset.beside = this.corner.beside;
    this.relayout();
    if (opened) this.raise();
  });
  private readonly themeWatch = new MutationObserver(() => {
    if (this.screenOpen()) this.relayout();
  });
  /** A screen dialog may have more or less room beside it after a resize. */
  private readonly onResize = () => {
    if (this.screenOpen()) this.relayout();
  };
  /**
   * #144: where the plate goes may have changed since `sync` placed it (the corner's watch, a resize, the theme, a peek,
   * the prefs): `update` places it again. Placing asks the corner and measures the tab (a forced layout), too much for
   * every world event.
   */
  private moved = true;
  /** #144: what placing the plate read besides the page: the book's `known` (a bridge with limits shows it) and the prefs. */
  private placed = '';
  /** #144: what the last render read besides the time: the book's version, the profiles, open, refreshing. */
  private rendered: [number, unknown, boolean, boolean] | null = null;
  private readonly onOutside = (e: Event) => {
    if (!(e.target instanceof Node) || !this.root.contains(e.target)) this.setPeek(false);
  };

  /** A dialog (modal, or the Changes panel) is open, and the viewport is too narrow to sit beside it: the plate is out of the way. */
  private get folded(): boolean {
    return this.corner.folded;
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
    return this.corner.topScreen();
  }

  /** A screen-filling dialog is open, or you sit at a laptop (and the plate is on screen at all). */
  private screenOpen(): boolean {
    return !this.root.hidden && !this.folded && this.corner.screen;
  }

  /** The plate steps aside over a screen dialog or at a laptop (a peek excepted): Shift+L reaches it through the app even though the dialog or the laptop owns the keys. */
  get overScreen(): boolean {
    return this.screenOpen();
  }

  /** The edge tab that fits right of every open screen dialog and of the seated laptop's glass: the full one, a snug one in a thin gutter, or none. */
  private tabFit(): 'full' | 'snug' | null {
    const fit = (right: number) => {
      const room = document.documentElement.clientWidth - right;
      const snug = document.documentElement.dataset[UI_THEME_ATTR] === 'ubuntu' ? TAB_ROOM_SNUG_UBUNTU : TAB_ROOM_SNUG;
      return room >= TAB_ROOM ? 'full' : room >= snug ? 'snug' : null;
    };
    // #147: the command palette is a modal over whatever is up (a dimmed, inert hire sheet, the laptop's glass): the tab keeps clear of it and of what opened over it, and of nothing beneath.
    if (this.corner.palette) return fit(Math.max(0, ...this.corner.clearOf().map((d) => d.getBoundingClientRect().right)));
    let right = 0;
    for (const d of document.querySelectorAll(`${SCREEN}, ${READING}`)) right = Math.max(right, d.getBoundingClientRect().right);
    const seated = document.querySelector(SEATED);
    // The glass's right edge (laptop/index.ts); not measured yet (or off screen): assume it fills the view.
    if (seated) right = Math.max(right, Number(seated.getAttribute('data-seated') || Infinity));
    return fit(right);
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
    this.relayout();
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
    window.addEventListener('resize', this.onResize);
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
    this.relayout();
  }

  /** Brings the widget back or takes it away (from Settings, or the panel's Hide). */
  private sync(): void {
    this.moved = false;
    this.placed = this.placedKey();
    this.root.hidden = this.prefs.hidden || !this.book.known;
    const folded = this.folded;
    const screen = this.screenOpen();
    if (this.peek && (!screen || this.topScreen() !== this.peekOwner)) {
      // The dialog it was over is gone (you stood up, or another opened on top of it, or the meter was hidden): back to the docked/saved state.
      this.peek = false;
      this.peekOwner = null;
      this.watchOutside(false);
    }
    const open = !this.root.hidden && !folded && (screen ? this.peek : this.prefs.open);
    this.place();
    this.root.dataset.folded = String(folded);
    const fit = screen && !this.peek ? this.tabFit() : null;
    this.root.dataset.dock = screen && !this.peek ? (fit ? 'tab' : 'away') : '';
    this.root.dataset.fit = fit ?? '';
    this.root.dataset.peek = String(this.peek);
    this.panel.hidden = !open;
    this.strip.setAttribute('aria-expanded', String(open));
    this.root.dataset.open = String(open);
  }

  /**
   * The world changed (App.applyChange, every event but a usage one): render what changed. #144: the plate is placed
   * again only when where it goes may have moved, the bridge's `known` flipped or the prefs changed, and the limits are
   * read again only when the book (or the profiles, open, refreshing) changed; time alone is `tick`'s.
   */
  update(): void {
    if (this.moved || this.placed !== this.placedKey()) this.sync();
    this.render(false);
  }

  private placedKey(): string {
    return `${this.book.known} ${this.prefs.hidden} ${this.prefs.open}`;
  }

  /** The corner may have moved (a dialog, the seat, a resize, the theme, a peek): place the plate again and render. */
  private relayout(): void {
    this.moved = true;
    this.update();
  }

  /** Time passed: re-render only when a reading has crossed into stale (or a shown "ago" changed). */
  tick(): void {
    this.render();
  }

  dispose(): void {
    this.off();
    this.corner.dispose();
    this.themeWatch.disconnect();
    this.watchOutside(false);
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
  }

  /** What the widget shows (test hook). */
  summary(): { hidden: boolean; open: boolean; lines: Array<{ provider: string; account?: string; stale: boolean; reached: boolean; windows: Array<{ label: string; pct: string; sev: string }> }> } {
    return {
      hidden: this.root.hidden === true,
      open: this.isOpen,
      lines: [...this.lines.querySelectorAll<HTMLElement>('.lm-line[data-provider]')].map((l) => ({
        provider: l.dataset.provider ?? '',
        ...(l.dataset.account ? { account: l.dataset.account } : {}),
        stale: l.dataset.stale === 'true',
        reached: l.dataset.reached === 'true',
        windows: [...l.querySelectorAll<HTMLElement>('.lm-win')].map((w) => ({ label: w.querySelector('.lm-lab')?.textContent ?? '', pct: w.querySelector('.lm-pct')?.textContent ?? '', sev: w.dataset.sev ?? '' })),
      })),
    };
  }

  /** `timed`: the time may have changed what shows (`tick`, a refresh, the profiles); else only the inputs `rendered` keeps. */
  private render(timed = true): void {
    if (this.root.hidden) return;
    const open = this.isOpen;
    const inputs: [number, unknown, boolean, boolean] = [this.book.version, this.profiles?.state ?? null, open, this.refreshing];
    const same = !!this.rendered && inputs.every((x, i) => x === this.rendered![i]);
    if (!timed && same && this.key) return;
    this.rendered = inputs;
    const now = this.host.now();
    const views = limitsView(this.book, now);
    const drift = (v: ProviderView): Drift => (v.profile !== null && v.account ? profileDrift(this.profiles?.state ?? null, v.account) : null);
    const drifts = views.map(drift);
    // Everything that shows, and nothing else: no reading changing, no re-render.
    const key = JSON.stringify([views.map((v) => [v.key, v.profile, v.isDefault, v.plan, v.windows, v.models, v.stale, v.reached, v.asOf, v.problem, v.credits, open ? v.readNote : '']), drifts, open, this.refreshing]);
    if (key === this.key) return;
    this.key = key;
    this.root.dataset.reached = views.some((v) => v.reached) ? 'true' : 'false';
    this.root.dataset.worst = views.reduce<string>((s, v) => (v.worstSeverity === 'high' || (v.worstSeverity === 'warn' && s === 'ok') ? v.worstSeverity : s), 'ok');
    this.strip.setAttribute('aria-label', `Plan limits. ${summary(views)}.`);
    const worst = views.reduce((m, v) => [...v.windows, ...v.models].reduce((n, w) => Math.max(n, w.pct), m), 0);
    this.tabPct.textContent = views.some((v) => v.windows.length || v.models.length) ? `${Math.round(worst)}%` : '–';
    this.tabBar.style.setProperty('--frac', (Math.min(100, Math.max(0, worst)) / 100).toFixed(3));
    this.tab.setAttribute('aria-label', `Plan limits. ${summary(views)}. Show details (Shift+L).`);
    this.lines.replaceChildren(...(views.length ? views.map((v, i) => providerLine(v, false, drifts[i])) : [h('div', { class: 'lm-line lm-line--wait' }, h('span', { class: 'lm-none' }, 'Plan limits · reading…'))]));
    if (!open) return;
    this.refreshBtn.disabled = this.refreshing;
    this.refreshBtn.querySelector('span')!.textContent = this.refreshing ? 'Reading…' : 'Refresh';
    this.body.replaceChildren(...views.map((v, i) => providerSection(v, drifts[i])));
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
