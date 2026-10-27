import type { CommandResult } from '../net/client';
import type { ManualProcess } from '../net/protocol';
import { h, replaceKeepingFocus } from '../ui/dom';
import { duotone, type DuotoneName } from '../ui/duotone';
import { failureText } from '../ui/messages';
import { attentionLabel, attentionOf, commandRequestOf, shortCommand } from '../world/manualProcess';
import type { WorldStore } from '../world/store';
import { CommandRequestCard, type CommandRequestCardHost } from './commandRequestCard';
import { waited } from '../ui/needsYou';
import './runsView.css';

/** #216: a run's live terminal as the Runs view mounts it (the run terminal the dialog uses too, `ui/runTerminal.ts`). */
export interface RunTerminalLike {
  readonly el: HTMLElement;
  update(p: ManualProcess): void;
  focus(): void;
  activate(): void;
  reconnect(): void;
  dispose(): void;
}

export interface RunsViewHost {
  worker: string;
  store: WorldStore;
  name(): string;
  send(t: 'manual_process.stop' | 'manual_process.dismiss', args: { id: string }): Promise<CommandResult>;
  /** The request card's host: the same callbacks (and so the same operations) as the conversation's card. */
  card: CommandRequestCardHost;
  /** A run's password dialog (the app's Respond). */
  respond(id: string, from: HTMLElement): void;
  /** "Run a command…": the dialog's manual entry for this worker. */
  runCommand(from: HTMLElement): void;
  /** Mounts a run's terminal (none: a quiet placeholder where it goes). `release`: Ctrl+Esc in it (back to the rows). */
  terminal?(p: ManualProcess, release: () => void): RunTerminalLike | null;
  confirm?(text: string): boolean;
  now?(): number;
}

/** Scrolls `box` the least that shows `el` whole (its top, when it is taller than the box). */
function intoSight(box: HTMLElement, el: HTMLElement): void {
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.bottom > b.bottom) box.scrollTop += Math.min(r.bottom - b.bottom, r.top - b.top);
  else if (r.top < b.top) box.scrollTop -= b.top - r.top;
}

const ended = (p: ManualProcess) => p.state === 'exited' || p.state === 'stopped' || p.state === 'failed';
/** As the dialog's: a live run can be stopped, and an ended one whose cleanup is needed or failed. */
const stoppable = (p: ManualProcess) => !ended(p) || p.cleanup === 'needed' || p.cleanup === 'failed';
/** As the dialog's: an ended run whose cleanup is none or done. */
const dismissible = (p: ManualProcess) => ended(p) && (p.cleanup === 'none' || p.cleanup === 'done');

/** A run's state in a few words ("Running", "Exited 0 · cleaned up", "Password requested"). */
export function runStateText(p: ManualProcess): string {
  const a = attentionOf(p);
  if (a) return attentionLabel(a);
  const base = p.state === 'exited' ? `Exited${p.exit_code !== undefined ? ` ${p.exit_code}` : ''}` : p.state === 'unknown' ? 'State unknown' : p.state.charAt(0).toUpperCase() + p.state.slice(1);
  const cleanup = p.cleanup === 'needed' ? ' · cleanup needed' : p.cleanup === 'failed' ? ' · cleanup failed' : p.cleanup === 'pending' ? ' · cleaning up' : p.cleanup === 'done' && ended(p) ? ' · cleaned up' : '';
  return `${base}${cleanup}`;
}

/** Its dot: asks for you, runs, ended well, ended badly, stopped. */
function tone(p: ManualProcess): 'attn' | 'live' | 'ok' | 'bad' | 'off' {
  if (attentionOf(p)) return 'attn';
  if (!ended(p)) return 'live';
  if (p.state === 'failed' || (p.exit_code !== undefined && p.exit_code !== 0) || p.cleanup === 'failed' || p.cleanup === 'needed') return 'bad';
  return p.state === 'stopped' ? 'off' : 'ok';
}

/**
 * #216: the Runs view, a seat view beside the manual-processes dialog (which keeps the floor-wide list): the seated worker's
 * runs only. A 44 px strip ("Runs · 2 running · 1 finished", Run a command…), the agent's "Run this command?" card when it
 * has one (a second instance of the conversation's, fed the same request with the same host, so Run and Dismiss in either
 * are one operation), the runs as compact rows (a status dot, the command, its state, how long; Respond, Open terminal,
 * Stop, Dismiss as the dialog has them: Stop asks first for a live run, Dismiss only for an ended one), and the picked run's
 * header and live terminal filling the rest. ↑ ↓ pick a run, Enter opens its terminal (the keyboard goes into it);
 * Ctrl+Esc there gives it back to the rows. Its terminal is mounted only while the view is up.
 */
export class RunsView {
  readonly el: HTMLElement;
  private readonly sub = h('span', { class: 'seat-strip-sub' });
  private readonly status = h('p', { class: 'seat-runs-status', role: 'alert' });
  private readonly list = h('ul', { class: 'seat-runs-list' });
  private readonly panel = h('section', { class: 'seat-runs-panel' });
  private readonly panelHead = h('div', { class: 'seat-runs-head' });
  private readonly termBox = h('div', { class: 'seat-runs-term' });
  private readonly body: HTMLElement;
  private readonly card: CommandRequestCard;
  private selected: string | null = null;
  private term: RunTerminalLike | null = null;
  private termId: string | null = null;
  private readonly busy = new Set<string>();
  private version = -1;
  private requestKey = '';
  private visible = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  /** Watches the card's size (and its content's) for its "more below" fade. */
  private readonly sized: ResizeObserver | null;
  /** Open terminal asked for the keyboard in the run's terminal before the view could take it (not placed yet). */
  private termFocus = false;

  constructor(private readonly host: RunsViewHost) {
    this.card = new CommandRequestCard(host.card);
    this.list.setAttribute('aria-label', `${host.name()}’s runs`);
    const run: HTMLButtonElement = h('button', { class: 'btn seat-runs-new', 'data-action': 'manual-entry', 'aria-haspopup': 'dialog', onclick: () => host.runCommand(run) }, duotone('play'), h('span', {}, 'Run a command…'));
    const strip = h('div', { class: 'seat-strip seat-runs-strip' }, duotone('play', 'seat-strip-ic'), h('span', { class: 'seat-strip-name' }, 'Runs'), this.sub, run);
    this.panel.append(this.panelHead, this.termBox);
    this.body = h('div', { class: 'seat-runs-body' }, this.card.el, this.status, this.list, this.panel);
    this.el = h('div', { class: 'seat-pane seat-runs', role: 'region', 'aria-label': `${host.name()}’s runs`, tabindex: '-1' }, strip, this.body);
    this.el.hidden = true;
    this.status.hidden = true;
    this.list.addEventListener('keydown', (e) => this.onListKey(e));
    // In a short column the card is compact and scrolls inside: its bottom fades while more of it is below.
    const more = () => this.card.el.toggleAttribute('data-more', this.card.el.scrollHeight - this.card.el.scrollTop - this.card.el.clientHeight > 1);
    this.card.el.addEventListener('scroll', more, { passive: true });
    this.sized = typeof ResizeObserver === 'function' ? new ResizeObserver(more) : null;
    this.sized?.observe(this.card.el);
    new MutationObserver(more).observe(this.card.el, { childList: true });
  }

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  /** This worker's runs: the ones asking for you first (the oldest episode first), then the newest. */
  private runs(): ManualProcess[] {
    const asking = (p: ManualProcess) => attentionOf(p)?.since ?? Infinity;
    const live = (p: ManualProcess) => (ended(p) ? 1 : 0);
    return this.host.store.manualProcesses
      .all()
      .filter((p) => p.worker === this.host.worker)
      .sort((a, b) => asking(a) - asking(b) || live(a) - live(b) || b.created_at - a.created_at);
  }

  /** The store or the request changed (each frame: it draws only what changed). */
  update(force = false): void {
    if (this.disposed) return;
    const r = commandRequestOf(this.host.store.workers.get(this.host.worker));
    const key = r ? JSON.stringify(r) : '';
    if (key !== this.requestKey) {
      this.requestKey = key;
      this.card.set(r);
    }
    const v = this.host.store.manualProcesses.version;
    if (!force && v === this.version) return;
    this.version = v;
    this.render();
  }

  private render(): void {
    const runs = this.runs();
    const running = runs.filter((p) => !ended(p)).length;
    this.sub.textContent = runs.length ? `${running} running · ${runs.length - running} finished` : '';
    if (this.selected && !runs.some((p) => p.id === this.selected)) this.selected = null;
    this.selected ??= runs[0]?.id ?? null;
    const rows = runs.map((p) => this.row(p));
    // How many rows the list keeps in sight in a short column (runsView.css: two at most).
    this.list.style.setProperty('--seat-runs-n', String(rows.length));
    replaceKeepingFocus(this.list, rows.length ? rows : [h('li', { class: 'seat-runs-empty' }, `No manual runs for ${this.host.name()} yet: run a command, or the one the agent asks for.`)], undefined, { keepScroll: true });
    this.renderPanel();
    this.tick();
  }

  private row(p: ManualProcess): HTMLElement {
    const a = attentionOf(p);
    const on = p.id === this.selected;
    const what = shortCommand(p, 200);
    const pick: HTMLButtonElement = h(
      'button',
      { class: 'seat-run-pick', 'data-key': `pick:${p.id}`, 'aria-current': on ? 'true' : null, tabindex: on ? '0' : '-1', title: `${p.command || p.title}\n${p.host}`, onclick: () => this.select(p.id, false) },
      h('span', { class: 'seat-run-dot', 'data-tone': tone(p), 'aria-hidden': 'true' }),
      h('span', { class: 'seat-run-cmd', translate: 'no' }, what),
      h('span', { class: 'seat-run-state', 'data-attn': a ? (a.confidence === 'uncertain' ? 'maybe' : 'sure') : null }, runStateText(p)),
      h('span', { class: 'seat-run-time', 'data-since': String(p.started_at || p.created_at), 'data-until': ended(p) && p.ended_at ? String(p.ended_at) : null }),
    );
    pick.setAttribute('aria-label', `${what}: ${runStateText(p)}`);
    const acts = h('span', { class: 'seat-run-acts' }, ...this.actions(p, `“${shortCommand(p)}”`, 'icon'));
    return h('li', { class: on ? 'seat-run seat-run--on' : 'seat-run', 'data-process': p.id, 'data-tone': tone(p) }, pick, acts);
  }

  /** The run's actions, as the dialog has them: icon buttons on a row, labelled ones in the picked run's header. */
  private actions(p: ManualProcess, what: string, style: 'icon' | 'label'): HTMLButtonElement[] {
    const a = attentionOf(p);
    const out: HTMLButtonElement[] = [];
    const busy = this.busy.has(p.id);
    const btn = (key: string, ic: DuotoneName, label: string, name: string, fn: (b: HTMLButtonElement) => void, primary = false, extra: Record<string, string> = {}) => {
      const b: HTMLButtonElement = h(
        'button',
        { class: style === 'icon' ? `seat-run-act${primary ? ' seat-run-act--primary' : ''}` : `btn seat-runs-btn${primary ? ' btn--primary' : ''}`, 'data-key': `${style}-${key}:${p.id}`, 'aria-label': name, title: name, ...extra, onclick: () => fn(b) },
        duotone(ic),
        style === 'label' ? h('span', {}, label) : null,
      );
      if (busy && (key === 'stop' || key === 'dismiss')) b.disabled = true;
      return b;
    };
    if (a?.kind === 'credential') out.push(btn('respond', 'reply', 'Respond', `Respond to the password request of ${what}`, (b) => this.host.respond(p.id, b), true, { 'aria-haspopup': 'dialog' }));
    if (style === 'icon') out.push(btn('open', 'terminal', 'Open terminal', `Open the terminal of ${what}`, () => this.select(p.id, true), a?.kind === 'input'));
    if (stoppable(p)) out.push(btn('stop', 'stop', 'Stop', `Stop ${what}`, () => void this.stop(p)));
    if (dismissible(p)) out.push(btn('dismiss', 'x', 'Dismiss', `Dismiss ${what}`, () => void this.action('manual_process.dismiss', p.id)));
    return out;
  }

  private renderPanel(): void {
    const p = this.selected ? this.host.store.manualProcesses.get(this.selected) : undefined;
    this.panel.hidden = !p;
    if (!p) {
      this.drop();
      this.panelHead.replaceChildren();
      return;
    }
    const started = p.started_at || p.created_at;
    replaceKeepingFocus(
      this.panelHead,
      [
        duotone('terminal', 'seat-runs-head-ic'),
        h('span', { class: 'seat-runs-head-cmd', translate: 'no', title: p.command || p.title }, shortCommand(p, 200)),
        h('span', { class: 'seat-runs-head-meta' }, `${p.host} · started `, h('time', { datetime: new Date(started).toISOString(), title: new Date(started).toLocaleString(), class: 'seat-run-time', 'data-since': String(started), 'data-until': ended(p) && p.ended_at ? String(p.ended_at) : null }), ended(p) ? '' : ' ago'),
        h('span', { class: 'seat-runs-head-acts' }, ...this.actions(p, `“${shortCommand(p)}”`, 'label')),
      ],
      undefined,
      { keepScroll: true },
    );
    this.panel.setAttribute('aria-label', `The terminal of “${shortCommand(p)}”`);
    if (this.visible) this.mountTerm(p);
  }

  /** The picked run's terminal, while the view is up (another run picked: the old one goes; the same: its state). */
  private mountTerm(p: ManualProcess): void {
    if (this.termId === p.id && this.term) {
      this.term.update(p);
      return;
    }
    this.drop();
    this.termId = p.id;
    const t = this.host.terminal?.(p, () => this.focusRow()) ?? null;
    this.term = t;
    if (t) this.termBox.replaceChildren(t.el);
    else this.termBox.replaceChildren(h('p', { class: 'seat-runs-placeholder' }, 'The run’s terminal shows here.'));
  }

  private drop(): void {
    this.term?.dispose();
    this.term = null;
    this.termId = null;
    this.termBox.replaceChildren();
  }

  /** Picks run `id` (its row, its header, its terminal); `focus`: the keyboard goes into its terminal. */
  select(id: string, focus: boolean): void {
    if (!this.host.store.manualProcesses.get(id)) return;
    if (id !== this.selected) {
      this.selected = id;
      this.render();
    }
    if (focus) {
      this.termFocus = true;
      this.focusTerm();
    }
  }

  /** The keyboard into the picked run's terminal; false while it cannot have it yet (the view is not on the screen). */
  private focusTerm(): boolean {
    this.term?.focus();
    const done = !!this.term && document.activeElement instanceof Node && this.el.contains(document.activeElement) && document.activeElement !== this.el;
    if (done) {
      this.termFocus = false;
      this.reveal();
    }
    return done;
  }

  /**
   * The picked row into its list's sight, and the terminal into the column's, where they scroll (the terminal's input is
   * a clipped 1 px element: focusing it scrolls nothing by itself). Only these two boxes move, never the page.
   */
  private reveal(): void {
    const row = this.list.querySelector<HTMLElement>('.seat-run--on');
    if (row) intoSight(this.list, row);
    intoSight(this.body, this.panel);
  }

  get selectedId(): string | null {
    return this.selected;
  }

  /** The keyboard to the view: its picked row (or the view itself). */
  focus(): void {
    if (this.termFocus && this.focusTerm()) return;
    if (!this.focusRow()) this.el.focus({ preventScroll: true });
  }

  private focusRow(): boolean {
    const b = this.list.querySelector<HTMLElement>('.seat-run-pick[aria-current="true"]') ?? this.list.querySelector<HTMLElement>('.seat-run-pick');
    b?.focus({ preventScroll: true });
    return !!b;
  }

  /** `t` is in a run's terminal (its keys are the process's). */
  ownsTerminal(t: EventTarget | null): boolean {
    return t instanceof Node && this.termBox.contains(t);
  }

  /** The view is up (its terminal mounts) or not (it goes: no watch behind another view). */
  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    this.el.hidden = !on;
    if (on) {
      this.update(true);
      this.timer ??= setInterval(() => this.tick(), 1000);
    } else {
      this.drop();
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const now = this.now();
    for (const t of this.el.querySelectorAll<HTMLElement>('.seat-run-time')) {
      const since = Number(t.dataset.since);
      const until = t.dataset.until ? Number(t.dataset.until) : now;
      t.textContent = since > 0 ? waited(until - since) : '';
    }
  }

  private onListKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return;
    const picks = [...this.list.querySelectorAll<HTMLButtonElement>('.seat-run-pick')];
    const i = picks.indexOf(e.target as HTMLButtonElement);
    if (i < 0) return;
    const to = e.key === 'ArrowDown' ? Math.min(picks.length - 1, i + 1) : e.key === 'ArrowUp' ? Math.max(0, i - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? picks.length - 1 : -1;
    if (to >= 0) {
      e.preventDefault();
      const id = picks[to]?.closest<HTMLElement>('[data-process]')?.dataset.process;
      if (id) this.select(id, false);
      this.focusRow();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const id = picks[i]?.closest<HTMLElement>('[data-process]')?.dataset.process;
      if (id) this.select(id, true);
    }
  }

  private async stop(p: ManualProcess): Promise<void> {
    const confirm = this.host.confirm ?? ((t: string) => window.confirm(t));
    if (!ended(p) && !confirm(`Stop “${p.title}”?`)) return;
    await this.action('manual_process.stop', p.id);
  }

  private async action(t: 'manual_process.stop' | 'manual_process.dismiss', id: string): Promise<void> {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    this.update(true);
    const r = await this.host.send(t, { id });
    this.busy.delete(id);
    if (this.disposed) return;
    this.status.textContent = r.ok ? '' : failureText(t, r.code, r.message);
    this.status.hidden = r.ok;
    this.update(true);
  }

  /** What it shows (test hook). */
  summary(): { rows: string[]; selected: string | null; terminal: boolean; card: boolean; sub: string } {
    return {
      rows: [...this.list.querySelectorAll<HTMLElement>('.seat-run')].map((r) => `${r.dataset.process}:${r.querySelector('.seat-run-state')?.textContent ?? ''}`),
      selected: this.selected,
      terminal: !!this.term,
      card: this.card.shown,
      sub: this.sub.textContent ?? '',
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.drop();
    this.sized?.disconnect();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.el.remove();
  }
}
