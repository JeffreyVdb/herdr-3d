import './manualProcesses.css';
import type { CommandResult } from '../net/client';
import type { CommandArgs, CommandName, ConnMessage, ManualProcess } from '../net/protocol';
import type { WorldStore } from '../world/store';
import { newOp } from '../world/handoff';
import { askpassEligible, askpassForm } from '../world/askpass';
import { attentionAction, attentionDetail, attentionLabel, attentionOf, detectionNote } from '../world/manualProcess';
import { attentionActionName } from './manualAttention';
import { mountRunTerminal, RunTerminalBroker, type RunTerminalHandle } from './runTerminal';
import { h, replaceKeepingFocus } from './dom';
import { failureText } from './messages';

export { askpassEligible, askpassForm };
export function newManualOp(): string {
  try { if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `mp-${crypto.randomUUID()}`; } catch { /* A non-secure browser context uses the game's regular operation IDs. */ }
  return newOp().replace(/^ho-/, 'mp-');
}
const terminalState = (p: ManualProcess) => ['exited', 'stopped', 'failed'].includes(p.state);
const dismissible = (p: ManualProcess) => terminalState(p) && ['none', 'done'].includes(p.cleanup);

interface ManualHost {
  store: WorldStore;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  input(args: CommandArgs['terminal.input']): Promise<CommandResult>;
  watch<T extends 'terminal.watch' | 'terminal.unwatch' | 'terminal.resize' | 'terminal.scroll'>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  changed(): void;
  external(url: string): void;
  /** #213: a run's password dialog (its row's Respond). */
  respond?(id: string, from: HTMLElement): void;
  /** #216: the connection's run-terminal broker, shared with the seat's Runs view (none: the dialog's own). */
  runs?: RunTerminalBroker;
}

/** List, manual entry and the separate controlled terminal. */
export class ManualProcessesDialog {
  private readonly dialog = h('dialog', { class: 'desk-dlg mp-dialog', 'aria-labelledby': 'mp-title' });
  private readonly title = h('h2', { id: 'mp-title' }, 'Manual processes');
  private readonly body = h('div', { class: 'dd-body mp-body' });
  private readonly status = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private readonly closeBtn = h('button', { class: 'btn', onclick: () => this.close() }, 'Close');
  private worker: string | null = null;
  private view: 'list' | 'entry' | 'terminal' = 'list';
  private viewGeneration = 0;
  private terminal: RunTerminalHandle | null = null;
  private terminalId: string | null = null;
  /** #216: one live surface per run, across the dialog and the seat. */
  readonly runs: RunTerminalBroker;
  private busy = new Set<string>();
  private entryOp = '';
  private entrySpec = '';
  private listVersion = -1;
  private entryWorker = '';
  private returnTo: HTMLElement | null = null;

  constructor(parent: HTMLElement, private readonly host: ManualHost) {
    this.runs = host.runs ?? new RunTerminalBroker((t, args) => host.watch(t, args));
    this.dialog.append(h('header', { class: 'dd-head' }, h('div', { class: 'dd-titles' }, this.title)), this.body, h('footer', { class: 'dd-foot' }, this.status, h('div', { class: 'dd-actions' }, this.closeBtn)));
    this.dialog.addEventListener('cancel', (e) => { e.preventDefault(); if (this.view !== 'list') this.list(); else this.close(); });
    this.dialog.addEventListener('close', () => { this.viewGeneration++; this.detach(); this.returnTo?.focus({ preventScroll: true }); this.returnTo = null; this.host.changed(); });
    parent.append(this.dialog);
  }
  get isOpen(): boolean { return this.dialog.open; }
  get keepsSeat(): boolean { return this.isOpen; }
  get scope(): string | null | undefined { return this.isOpen ? this.worker : undefined; }
  open(worker: string | null, from?: HTMLElement | null): void {
    this.worker = worker;
    this.returnTo = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    this.viewGeneration++; this.detach(); this.view = 'list'; this.status.textContent = '';
    this.renderList();
    if (!this.dialog.open) this.dialog.showModal();
    this.host.changed();
  }
  close(): void { if (this.dialog.open) this.dialog.close(); }
  refresh(force = false): void {
    if (!this.isOpen) return;
    if (this.view === 'list' && (force || this.listVersion !== this.host.store.manualProcesses.version)) this.renderList();
    if (this.view === 'terminal' && this.terminalId) {
      const p = this.host.store.manualProcesses.get(this.terminalId.slice(3));
      if (p) this.terminal?.update(p);
    }
  }
  private list(): void { this.viewGeneration++; this.detach(); this.view = 'list'; this.status.textContent = ''; this.renderList(); }
  private renderList(): void {
    this.title.textContent = this.worker ? 'Manual processes' : 'All manual processes';
    // #213: the runs asking for you first (their oldest episode first), then the newest.
    const asking = (p: ManualProcess) => attentionOf(p)?.since ?? Infinity;
    const records = this.host.store.manualProcesses.all().filter((p) => !this.worker || p.worker === this.worker).sort((a, b) => asking(a) - asking(b) || b.created_at - a.created_at);
    const rows = records.map((p) => this.row(p));
    const workers = [...this.host.store.workers.values()];
    const entry: HTMLElement[] = [];
    if (this.worker && this.host.store.workers.has(this.worker)) entry.push(h('button', { class: 'btn', 'data-action': 'manual-entry', onclick: () => this.entry(this.worker!) }, 'Run a command…'));
    else if (!this.worker && workers.length) {
      const select = h('select', { 'aria-label': 'Worker for a new command', 'data-key': 'manual-worker' }, ...workers.map((w) => h('option', { value: w.id }, w.name || w.id)));
      if (!workers.some((w) => w.id === this.entryWorker)) this.entryWorker = workers[0]!.id;
      select.value = this.entryWorker;
      select.addEventListener('change', () => { this.entryWorker = select.value; });
      entry.push(h('label', {}, 'Worker for a new command', select), h('button', { class: 'btn', 'data-action': 'manual-entry', onclick: () => this.entry(this.entryWorker) }, 'Run a command…'));
    }
    this.listVersion = this.host.store.manualProcesses.version;
    replaceKeepingFocus(this.body, [...(rows.length ? rows : [h('p', { class: 'mp-empty' }, 'No manual processes yet.')]), ...entry], undefined, { keepScroll: true });
  }
  private row(p: ManualProcess): HTMLElement {
    const started = p.started_at || p.created_at;
    const age = Math.max(0, Date.now() - started);
    const relative = age < 60_000 ? 'just now' : age < 3_600_000 ? `${Math.floor(age / 60_000)}m ago` : `${Math.floor(age / 3_600_000)}h ago`;
    const actions = h('div', { class: 'mp-actions' });
    // #213: what the run asks for, by kind and certainty, and its direct action first.
    const a = attentionOf(p);
    const attention = a ? h('p', { class: `mp-attn${a.confidence === 'uncertain' ? ' mp-attn--maybe' : ''}` }, h('span', { class: 'mp-attn-tape' }, attentionLabel(a)), attentionDetail(a) ? h('span', {}, attentionDetail(a)) : null) : null;
    if (a?.kind === 'credential' && this.host.respond) {
      const respond: HTMLButtonElement = h('button', { class: 'btn btn--primary', 'data-key': `respond:${p.id}`, 'aria-haspopup': 'dialog', 'aria-label': attentionActionName({ process: p, attention: a }), onclick: () => this.host.respond?.(p.id, respond) }, attentionAction(a));
      actions.append(respond);
    }
    actions.append(h('button', { class: a?.kind === 'input' ? 'btn btn--primary' : 'btn', 'data-key': `open:${p.id}`, ...(a?.kind === 'input' ? { 'aria-label': attentionActionName({ process: p, attention: a }) } : {}), onclick: () => this.openTerminal(p) }, 'Open terminal'));
    const note = terminalState(p) ? null : detectionNote(p);
    if (!terminalState(p) || p.cleanup === 'needed' || p.cleanup === 'failed') actions.append(h('button', { class: 'btn', 'data-key': `stop:${p.id}`, disabled: this.busy.has(p.id), onclick: () => void this.stop(p) }, 'Stop'));
    if (dismissible(p)) actions.append(h('button', { class: 'btn', 'data-key': `dismiss:${p.id}`, disabled: this.busy.has(p.id), onclick: () => void this.action('manual_process.dismiss', p.id) }, 'Dismiss'));
    return h('article', { class: a ? 'mp-row mp-row--attn' : 'mp-row', 'data-process': p.id }, h('h3', {}, p.title), h('p', {}, `${p.worker_name} · ${p.host}`), attention, note ? h('p', { class: 'mp-detect' }, note) : null, h('p', {}, `State: ${p.state}${p.exit_code !== undefined ? ` · Exit code ${p.exit_code}` : ''}`), h('p', {}, 'Started ', h('time', { title: new Date(started).toLocaleString(), datetime: new Date(started).toISOString() }, relative)), h('p', {}, `Cleanup: ${p.cleanup}${p.cleanup_note ? ` — ${p.cleanup_note}` : ''}`), ...(p.error ? [h('p', {}, p.error)] : []), ...(p.effects ?? []).map((e) => h('p', {}, `${e.kind}: ${e.endpoint} (${e.state}); cleanup: ${e.cleanup_command}`)), actions);
  }
  private async stop(p: ManualProcess): Promise<void> {
    if (!terminalState(p) && !window.confirm(`Stop “${p.title}”?`)) return;
    await this.action('manual_process.stop', p.id);
  }
  private async action(t: 'manual_process.stop' | 'manual_process.dismiss', id: string): Promise<void> {
    if (this.busy.has(id)) return;
    const generation = this.viewGeneration;
    this.busy.add(id); this.refresh(true);
    const r = await this.host.send(t, { id });
    this.busy.delete(id);
    if (this.isOpen && this.viewGeneration === generation) this.status.textContent = r.ok ? '' : failureText(t, r.code, r.message);
    this.refresh(true);
  }
  /** #213: straight to one run's terminal (an attention chip, a toast, a notification): Back goes to its worker's list. */
  openRun(id: string, from?: HTMLElement | null): void {
    const p = this.host.store.manualProcesses.get(id);
    if (!p) return;
    this.open(p.worker, from);
    this.openTerminal(p);
  }
  entry(worker: string, command = '', cwd?: string): void {
    if (!this.isOpen) this.open(worker);
    const generation = ++this.viewGeneration;
    this.detach(); this.worker = worker; this.view = 'entry'; this.entryOp = ''; this.entrySpec = ''; this.title.textContent = 'Run a command'; this.status.textContent = '';
    const field = h('textarea', { class: 'mp-command-input', rows: 5, 'aria-label': 'Command', spellcheck: 'false' }); field.value = command;
    const folder = h('input', { type: 'text', 'aria-label': 'Folder' }); folder.value = cwd ?? this.host.store.workers.get(worker)?.cwd ?? '';
    const check = h('input', { type: 'checkbox', checked: true });
    const option = h('label', { class: 'mp-askpass' }, check, ' Ask for the password in a dialog');
    const preview = h('pre', { class: 'mp-code' });
    // #213: a field shows a CR as a line break: the reviewed command goes as it came (its CRs too) until any edit, then
    // exactly what the field holds (an edit back to the same text included); the notice says so. A change without an
    // input event counts as an edit too.
    const shown = field.value;
    let edited = false;
    const value = () => { edited ||= field.value !== shown; return edited ? field.value : command; };
    const crNote = /\r/.test(command) ? h('p', { class: 'mp-detect', id: 'mp-cr-note' }, 'This command has carriage returns, shown here as line breaks. Run it unedited and they are kept; once you edit it, it is sent as shown.') : null;
    const update = () => { option.hidden = !askpassEligible(value()); preview.hidden = option.hidden || !check.checked; preview.textContent = askpassForm(value()); };
    if (crNote) field.setAttribute('aria-describedby', crNote.id);
    field.addEventListener('input', () => { edited = true; update(); }); check.addEventListener('change', update); update();
    const run = h('button', { class: 'btn btn--primary', onclick: async () => {
      const text = value();
      if (run.disabled || !text.trim()) return;
      const spec = JSON.stringify([worker, text, folder.value, !option.hidden && check.checked]);
      if (spec !== this.entrySpec) { this.entrySpec = spec; this.entryOp = newManualOp(); }
      run.disabled = true;
      const r = await this.host.send('manual_process.start', { op: this.entryOp, worker, command: text, ...(folder.value ? { cwd: folder.value } : {}), source: { kind: 'manual' }, askpass: !option.hidden && check.checked });
      if (!this.isOpen || this.viewGeneration !== generation) return;
      run.disabled = false;
      if (r.ok) this.list();
      else if ((r.code === 'bad_args' || r.code === 'bad_request') && !option.hidden && check.checked) { check.checked = false; update(); this.status.textContent = `${r.message} You can run without the password dialog.`; }
      else this.status.textContent = r.code === 'stale' ? 'This request is out of date.' : failureText('manual_process.start', r.code, r.message);
    } }, 'Run');
    this.body.replaceChildren(h('p', {}, `Machine: ${this.host.store.host || 'Bridge host'}`), h('label', {}, 'Command', field), ...(crNote ? [crNote] : []), h('label', {}, 'Folder', folder), option, preview, h('div', { class: 'mp-actions' }, h('button', { class: 'btn', onclick: () => this.list() }, 'Back'), run));
    field.focus();
  }
  private openTerminal(p: ManualProcess): void {
    this.viewGeneration++; this.detach(); this.view = 'terminal'; this.title.textContent = p.title; this.status.textContent = '';
    this.terminalId = `mp:${p.id}`;
    const back = h('button', { class: 'btn', onclick: () => this.list() }, 'Back to processes');
    // #216: the run's terminal is the component the seat's Runs view shows too; opening it here takes the run.
    const term = mountRunTerminal({ broker: this.runs, input: (args) => this.host.input(args), watch: (t, args) => this.host.watch(t, args), external: (url) => this.host.external(url) }, p, { surface: 'dialog', releaseFocus: () => back.focus(), onStatus: (text) => { this.status.textContent = text; } });
    this.terminal = term;
    this.body.replaceChildren(term.el, h('p', {}, 'Ctrl Esc releases the keyboard to Back. Tab and Esc are sent to the process.'), h('p', {}, 'Closing this view does not stop the process.'), back);
    term.focus();
  }
  /** Routes a run's connection message to the surface holding it (every `mp:` message is the broker's). */
  onConn(m: ConnMessage): boolean { return this.runs.onConn(m); }
  reconnect(): void { this.runs.reconnect(); }
  private detach(): void {
    this.terminalId = null;
    // Hands the run back to the seat's surface (if one is mounted) or unwatches it; the process goes on.
    this.terminal?.dispose(); this.terminal = null;
  }
}
