import type { CommandResult } from '../net/client';
import type { LimitBook, ProviderView, WindowView } from '../world/limits';
import { harnessViews, limitsView, warningOf } from '../world/limits';
import { h, icon, ICON } from './dom';
import { LimitsPrefs } from './limitsPrefs';
import './limits.css';

/**
 * The plan-limits widget (M10, #12): the Claude and Codex windows in the top
 * right corner, over the city, the floors and every overlay. Plain DOM and
 * CSS, no WebGL. It renders from the views of world/limits.ts and only when
 * the bridge sends a reading (`limits.update`) or a reading crosses into
 * stale; `tick` is that second check and does nothing else.
 */

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

/** "5h" or "week · Fable". */
const nameOf = (w: WindowView) => (w.model ? `${w.label} · ${w.model}` : w.label);

/** One window as a compact inline group: label, bar, percentage, reset time. */
function windowChip(w: WindowView): HTMLElement {
  return h('span', { class: 'lm-win', 'data-sev': w.severity }, h('span', { class: 'lm-lab' }, w.label), bar(w), h('b', { class: 'lm-pct' }, w.pctText), w.resets ? h('span', { class: 'lm-rs' }, resetIcon(), w.resets) : null);
}

const providerTape = (v: ProviderView) => h('span', { class: `tape lm-tape lm-tape--${v.provider}` }, v.name);

/** The collapsed line of one provider. */
function providerLine(v: ProviderView): HTMLElement {
  const wins = v.windows.length ? v.windows.map(windowChip) : [h('span', { class: 'lm-none' }, v.problem ?? 'No reading yet')];
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
  return h('li', { class: 'lm-row', 'data-sev': w.severity }, h('span', { class: 'lm-rowlab' }, nameOf(w)), bar(w), h('b', { class: 'lm-pct' }, w.pctText), h('span', { class: 'lm-rs' }, w.resets ? ['resets ', w.resets].join('') : ''));
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
  private readonly lines = h('div', { class: 'lm-lines' });
  private readonly panel = h('div', { class: 'lm-panel', id: 'lm-panel', role: 'region', 'aria-label': 'Plan limits' });
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
    this.refreshBtn.addEventListener('click', () => void this.refresh());
    const hide = h('button', { class: 'btn btn--sm lm-hide', 'data-key': 'limits-hide', title: 'Hide this meter (bring it back in About)' }, h('span', {}, 'Hide meter'));
    hide.addEventListener('click', () => {
      this.prefs.hidden = true;
      this.host.toast('Plan limits hidden. Show them again in About.');
    });
    this.panel.hidden = true;
    this.root = h('aside', { class: 'limits', 'data-hook': 'limits', popover: 'manual' }, this.strip, this.panel);
    this.foot = h('div', { class: 'lm-foot' }, this.refreshBtn, hide, this.status);
    parent.append(this.root);
    this.off = this.prefs.onChange(() => this.sync());
    this.keepOnTop();
    this.sync();
    this.update();
  }

  private readonly foot: HTMLElement;
  private watcher: MutationObserver | null = null;

  /**
   * The widget lives in the browser's top layer (a manual popover), so a modal dialog's backdrop does not dim
   * it; a dialog that opens later would sit above it, so opening one puts the widget back on top.
   */
  private keepOnTop(): void {
    const top = () => {
      try {
        this.root.hidePopover();
        this.root.showPopover();
      } catch {
        /* no popover support: it stays in the page */
      }
    };
    if (typeof this.root.showPopover !== 'function') return;
    top();
    if (typeof MutationObserver === 'undefined') return;
    this.watcher = new MutationObserver((records) => {
      if (!records.some((r) => r.target instanceof HTMLDialogElement)) return;
      // The Changes panel is not modal and takes the whole right column: the plate steps aside.
      this.root.dataset.beside = document.querySelector('dialog.changes[open]') ? 'changes' : '';
      if (records.some((r) => r.target instanceof HTMLDialogElement && r.target.open)) top();
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
    if (this.root.hidden) return;
    this.prefs.open = open;
    this.sync();
    this.key = '';
    this.render();
  }

  /** Shift+L: brings a hidden widget back with its panel open, else opens or closes the panel. */
  toggleFromKey(): void {
    if (this.prefs.hidden) {
      this.prefs.open = true;
      this.prefs.hidden = false;
    } else this.toggle();
    this.update();
  }

  /** Brings the widget back or takes it away (from About, or the panel's Hide). */
  private sync(): void {
    this.root.hidden = this.prefs.hidden || !this.book.known;
    const open = this.prefs.open && !this.root.hidden;
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
    this.root.remove();
  }

  /** What the widget shows (test hook). */
  summary(): { hidden: boolean; open: boolean; lines: Array<{ provider: string; stale: boolean; reached: boolean; windows: Array<{ label: string; pct: string; sev: string }> }> } {
    return {
      hidden: this.root.hidden === true,
      open: this.isOpen,
      lines: [...this.lines.querySelectorAll<HTMLElement>('.lm-line')].map((l) => ({
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
    this.lines.replaceChildren(...(views.length ? views.map(providerLine) : [h('div', { class: 'lm-line lm-line--wait' }, h('span', { class: 'lm-none' }, 'Plan limits · reading…'))]));
    if (!open) return;
    this.refreshBtn.disabled = this.refreshing;
    this.refreshBtn.querySelector('span')!.textContent = this.refreshing ? 'Reading…' : 'Refresh';
    this.panel.replaceChildren(...views.map(providerSection), this.foot);
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
 * team's), inline, with a warning above 85 %. null when the bridge sent no
 * reading for them (the dialog hides its slot).
 */
export function planLimits(book: LimitBook, harnesses: readonly string[], now: number): HTMLElement | null {
  const views = harnessViews(book, harnesses, now);
  if (!views.length) return null;
  const warnings = views.map(warningOf).filter(Boolean);
  return h(
    'div',
    { class: 'lm-inline', 'data-hot': warnings.length ? 'true' : 'false' },
    h('p', { class: 'lm-inline-title' }, 'Plan limits'),
    ...views.map(providerLine),
    ...warnings.map((w) => h('p', { class: 'lm-warn', role: 'status' }, w)),
  );
}
