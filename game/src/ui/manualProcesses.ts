import './manualProcesses.css';
import type { CommandResult } from '../net/client';
import type { CommandArgs, CommandName, ConnMessage, ManualProcess } from '../net/protocol';
import { SeatTerminal } from '../laptop/seatTerm';
import { seatedKey } from '../laptop/keys';
import type { WorldStore } from '../world/store';
import { newOp } from '../world/handoff';
import { askpassEligible, askpassForm } from '../world/askpass';
import { h, replaceKeepingFocus } from './dom';
import { failureText } from './messages';

export { askpassEligible, askpassForm };
export function newManualOp(): string {
  try { if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `mp-${crypto.randomUUID()}`; } catch { /* A non-secure browser context uses the game's regular operation IDs. */ }
  return newOp().replace(/^ho-/, 'mp-');
}
const terminalState = (p: ManualProcess) => ['exited', 'stopped', 'failed'].includes(p.state);
const dismissible = (p: ManualProcess) => terminalState(p) && ['none', 'done'].includes(p.cleanup);
const keyBytes: Record<string, string> = { enter: '\r', tab: '\t', 'shift+tab': '\x1b[Z', esc: '\x1b', backspace: '\x7f', delete: '\x1b[3~', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~', space: ' ', 'shift+enter': '\x1b[13;2u', 'alt+enter': '\x1b\r', 'alt+backspace': '\x1b\x7f', 'ctrl+left': '\x1b[1;5D', 'ctrl+right': '\x1b[1;5C', 'alt+left': '\x1b[1;3D', 'alt+right': '\x1b[1;3C', 'shift+up': '\x1b[1;2A', 'shift+down': '\x1b[1;2B', 'shift+left': '\x1b[1;2D', 'shift+right': '\x1b[1;2C' };
for (let i = 1; i <= 26; i++) keyBytes[`ctrl+${String.fromCharCode(96 + i)}`] = String.fromCharCode(i);
for (const [i, seq] of ['OP', 'OQ', 'OR', 'OS', '[15~', '[17~', '[18~', '[19~', '[20~', '[21~', '[23~', '[24~'].entries()) keyBytes[`f${i + 1}`] = `\x1b${seq}`;

interface ManualHost {
  store: WorldStore;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  input(args: CommandArgs['terminal.input']): Promise<CommandResult>;
  watch<T extends 'terminal.watch' | 'terminal.unwatch' | 'terminal.resize' | 'terminal.scroll'>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  changed(): void;
  external(url: string): void;
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
  private terminalStateLabel: HTMLElement | null = null;
  private terminal: SeatTerminal | null = null;
  private terminalId: string | null = null;
  private terminalGeneration = 0;
  private terminalInput: HTMLTextAreaElement | null = null;
  private busy = new Set<string>();
  private entryOp = '';
  private entrySpec = '';
  private listVersion = -1;
  private entryWorker = '';
  private returnTo: HTMLElement | null = null;

  constructor(parent: HTMLElement, private readonly host: ManualHost) {
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
      if (p) this.updateTerminalState(p);
    }
  }
  private list(): void { this.viewGeneration++; this.detach(); this.view = 'list'; this.status.textContent = ''; this.renderList(); }
  private renderList(): void {
    this.title.textContent = this.worker ? 'Manual processes' : 'All manual processes';
    const records = this.host.store.manualProcesses.all().filter((p) => !this.worker || p.worker === this.worker).sort((a, b) => b.created_at - a.created_at);
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
    actions.append(h('button', { class: 'btn', 'data-key': `open:${p.id}`, onclick: () => void this.openTerminal(p) }, 'Open terminal'));
    if (!terminalState(p) || p.cleanup === 'needed' || p.cleanup === 'failed') actions.append(h('button', { class: 'btn', 'data-key': `stop:${p.id}`, disabled: this.busy.has(p.id), onclick: () => void this.stop(p) }, 'Stop'));
    if (dismissible(p)) actions.append(h('button', { class: 'btn', 'data-key': `dismiss:${p.id}`, disabled: this.busy.has(p.id), onclick: () => void this.action('manual_process.dismiss', p.id) }, 'Dismiss'));
    return h('article', { class: 'mp-row', 'data-process': p.id }, h('h3', {}, p.title), h('p', {}, `${p.worker_name} · ${p.host}`), h('p', {}, `State: ${p.state}${p.exit_code !== undefined ? ` · Exit code ${p.exit_code}` : ''}`), h('p', {}, 'Started ', h('time', { title: new Date(started).toLocaleString(), datetime: new Date(started).toISOString() }, relative)), h('p', {}, `Cleanup: ${p.cleanup}${p.cleanup_note ? ` — ${p.cleanup_note}` : ''}`), ...(p.error ? [h('p', {}, p.error)] : []), ...(p.effects ?? []).map((e) => h('p', {}, `${e.kind}: ${e.endpoint} (${e.state}); cleanup: ${e.cleanup_command}`)), actions);
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
  entry(worker: string, command = '', cwd?: string): void {
    if (!this.isOpen) this.open(worker);
    const generation = ++this.viewGeneration;
    this.detach(); this.worker = worker; this.view = 'entry'; this.entryOp = ''; this.entrySpec = ''; this.title.textContent = 'Run a command'; this.status.textContent = '';
    const field = h('textarea', { class: 'mp-command-input', rows: 5, 'aria-label': 'Command', spellcheck: 'false' }); field.value = command;
    const folder = h('input', { type: 'text', 'aria-label': 'Folder' }); folder.value = cwd ?? this.host.store.workers.get(worker)?.cwd ?? '';
    const check = h('input', { type: 'checkbox', checked: true });
    const option = h('label', { class: 'mp-askpass' }, check, ' Ask for the password in a dialog');
    const preview = h('pre', { class: 'mp-code' });
    // #213: a field keeps line breaks as LF: the reviewed command goes as it came (a CR in it too) until it is edited.
    const value = () => (field.value === command.replace(/\r\n?/g, '\n') ? command : field.value);
    const update = () => { option.hidden = !askpassEligible(value()); preview.hidden = option.hidden || !check.checked; preview.textContent = askpassForm(value()); };
    field.addEventListener('input', update); check.addEventListener('change', update); update();
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
    this.body.replaceChildren(h('p', {}, `Machine: ${this.host.store.host || 'Bridge host'}`), h('label', {}, 'Command', field), h('label', {}, 'Folder', folder), option, preview, h('div', { class: 'mp-actions' }, h('button', { class: 'btn', onclick: () => this.list() }, 'Back'), run));
    field.focus();
  }
  private async openTerminal(p: ManualProcess): Promise<void> {
    this.viewGeneration++; this.detach(); this.view = 'terminal'; this.title.textContent = p.title; this.status.textContent = '';
    const id = `mp:${p.id}`; this.terminalId = id;
    const generation = ++this.terminalGeneration;
    const current = () => this.terminalId === id && this.terminalGeneration === generation;
    const screen = h('div', { class: 'mp-terminal', 'aria-label': 'Process terminal' });
    const input = h('textarea', { class: 'mp-terminal-input', 'aria-label': 'Terminal input', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', rows: 1 }); this.terminalInput = input;
    const state = h('p', { 'aria-live': 'polite' }); this.terminalStateLabel = state;
    this.updateTerminalState(p);
    const back = h('button', { class: 'btn', onclick: () => this.list() }, 'Back to processes');
    this.body.replaceChildren(state, screen, input, h('p', {}, 'Ctrl Esc releases the keyboard to Back. Tab and Esc are sent to the process.'), h('p', {}, 'Closing this view does not stop the process.'), back);
    input.focus();
    let inputQueue = Promise.resolve();
    const sendText = (text: string) => {
      let part = ''; let bytes = 0;
      const flush = () => {
        if (!part) return;
        const chunk = part; part = ''; bytes = 0;
        inputQueue = inputQueue.then(async () => {
          if (!current()) return;
          const result = await this.host.input({ id, text: chunk });
          if (!result.ok && current()) this.status.textContent = 'Could not send terminal input. Try again.';
        });
      };
      for (const ch of text) { const n = new TextEncoder().encode(ch).length; if (bytes + n > 16384) flush(); part += ch; bytes += n; }
      flush();
    };
    input.addEventListener('compositionend', (e) => { if (e.data) sendText(e.data); input.value = ''; });
    input.addEventListener('input', (e) => {
      const event = e as InputEvent;
      if (event.isComposing) return;
      const text = event.inputType === 'insertFromComposition' ? '' : input.value;
      input.value = ''; sendText(text);
    });
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); back.focus(); return; }
      // In this modal Ctrl+P belongs to the process, not the game's palette.
      if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); sendText('\x10'); return; }
      const key = seatedKey(e, /Mac/.test(navigator.platform));
      if (key.items.length && key.items.some((it) => 'key' in it)) { e.preventDefault(); sendText(key.items.map((it) => 'text' in it ? it.text : keyBytes[it.key] ?? '').join('')); }
      else if (e.key === 'Escape') { e.preventDefault(); sendText('\x1b'); }
    });
    let watched = false;
    const term = new SeatTerminal(screen, { mac: /Mac/.test(navigator.platform), grid: (g) => { if (watched && current()) void this.host.watch('terminal.resize', { id, cols: g.cols, rows: g.rows }); }, wheel: (lines, column, row, modifiers) => { if (current()) void this.host.watch('terminal.scroll', { id, direction: lines > 0 ? 'up' : 'down', lines: Math.abs(lines), column, row, modifiers }); }, open: (url) => this.host.external(url), paste: (text) => sendText(text), keyboard: () => { if (current()) input.focus(); } });
    this.terminal = term;
    await term.mount();
    if (!current()) { term.dispose(); return; }
    screen.querySelector('.xterm-helper-textarea')?.setAttribute('aria-hidden', 'true');
    const grid = term.grid;
    const r = await this.host.watch('terminal.watch', { id, fps: 10, control: true, ...(grid ? { cols: grid.cols, rows: grid.rows } : {}) });
    if (!current()) return;
    watched = r.ok;
    if (!r.ok) this.status.textContent = failureText('terminal.watch', r.code, r.message);
    else { const gridNow = term.grid; if (gridNow) void this.host.watch('terminal.resize', { id, cols: gridNow.cols, rows: gridNow.rows }); }
  }
  private updateTerminalState(p: ManualProcess): void {
    if (!this.terminalStateLabel) return;
    const result = p.state === 'exited' ? `Exited${p.exit_code !== undefined ? ` with code ${p.exit_code}` : ''} — output stays until you dismiss it` : p.state;
    this.terminalStateLabel.textContent = `${p.host} · ${result} · Cleanup: ${p.cleanup}${p.cleanup_note ? ` — ${p.cleanup_note}` : ''}${p.error ? ` — ${p.error}` : ''}`;
  }
  onConn(m: ConnMessage): boolean {
    if (!('id' in m) || typeof m.id !== 'string' || !m.id.startsWith('mp:')) return false;
    if (m.id === this.terminalId && m.t === 'terminal.frame') this.terminal?.frame(m);
    if (m.id === this.terminalId && m.t === 'terminal.control' && this.terminalInput) {
      this.terminalInput.disabled = m.mode !== 'control';
      this.status.textContent = m.mode === 'control' ? '' : 'This terminal is read only because another client controls it.';
    }
    if (m.id === this.terminalId && m.t === 'terminal.closed') this.status.textContent = 'The terminal closed.';
    return true;
  }
  reconnect(): void { const p = this.terminalId && this.host.store.manualProcesses.get(this.terminalId.slice(3)); if (p && this.isOpen) void this.openTerminal(p); }
  private detach(): void {
    const id = this.terminalId; this.terminalId = null; this.terminalInput = null; this.terminalStateLabel = null; this.terminalGeneration++;
    this.terminal?.dispose(); this.terminal = null;
    if (id) void this.host.watch('terminal.unwatch', { id });
  }
}
