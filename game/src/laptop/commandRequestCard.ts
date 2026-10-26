import type { CommandArgs, CommandRequest } from '../net/protocol';
import type { CommandResult } from '../net/client';
import { askpassEligible, askpassForm, newManualOp } from '../ui/manualProcesses';
import { h } from '../ui/dom';

export interface CommandRequestCardHost {
  worker: string;
  host(): string;
  start(args: CommandArgs['manual_process.start']): Promise<CommandResult>;
  dismiss(key: string): Promise<CommandResult>;
  edit(command: string, cwd: string): void;
}

// Keep each reviewed command's operation across view remounts and reconnects. It is never regenerated on retry.
const operations = new Map<string, string>();

export class CommandRequestCard {
  readonly el = h('section', { class: 'mp-request', 'aria-label': 'Command requested by the agent' });
  private request: CommandRequest | null = null;
  private busy = false;
  private gone = '';
  private message = '';
  private readonly askpass = new Map<string, boolean>();
  constructor(private readonly host: CommandRequestCardHost) { this.el.hidden = true; }
  set(request: CommandRequest | null): void {
    const changed = request?.key !== this.request?.key;
    this.request = request;
    if (changed) { this.busy = false; this.message = ''; this.gone = ''; this.askpass.clear(); }
    this.render();
  }
  private op(key: string, index: number, command: string): string {
    const k = JSON.stringify([this.host.worker, key, index, command]);
    let op = operations.get(k);
    if (!op) { op = newManualOp(); operations.set(k, op); }
    return op;
  }
  private async start(index: number, command: string): Promise<void> {
    const r = this.request; const c = r?.commands[index];
    if (!r || !c || c.host !== 'bridge' || this.busy) return;
    const eligible = askpassEligible(command);
    this.busy = true; this.message = ''; this.render();
    const result = await this.host.start({ op: this.op(r.key, index, command), worker: this.host.worker, command, ...(c.cwd ? { cwd: c.cwd } : {}), source: { kind: 'suggestion', key: r.key, index }, askpass: eligible && (this.askpass.get(command) ?? true) });
    this.busy = false;
    if (this.request?.key !== r.key) return;
    if (result.ok) this.gone = r.key;
    else if (result.code === 'stale') this.message = 'This request is out of date';
    else if (result.code === 'bad_args' || result.code === 'bad_request') { this.message = `${result.message} You can run without the password dialog.`; this.askpass.set(command, false); }
    else this.message = result.message || 'Could not start the command. Try again.';
    this.render();
  }
  private async dismiss(): Promise<void> {
    const r = this.request; if (!r || this.busy) return;
    this.busy = true; this.render();
    const result = await this.host.dismiss(r.key);
    this.busy = false;
    if (this.request?.key !== r.key) return;
    if (result.ok) this.gone = r.key;
    else this.message = result.code === 'stale' ? 'This request is out of date' : result.message;
    this.render();
  }
  private render(): void {
    const r = this.request;
    this.el.hidden = !r || r.key === this.gone;
    if (!r || this.el.hidden) { this.el.replaceChildren(); return; }
    const cards = r.commands.map((c, index) => {
      const command = h('pre', { class: 'mp-code' }, c.command);
      const copy = h('button', { class: 'btn', onclick: () => { void (navigator.clipboard?.writeText(c.command) ?? Promise.reject()).then(() => { copy.textContent = 'Copied'; }, () => { this.message = 'Could not copy the command. Select it to copy.'; this.render(); }); } }, 'Copy');
      const option = (value: string) => {
        if (!askpassEligible(value)) return null;
        const check = h('input', { type: 'checkbox' }); check.checked = this.askpass.get(value) ?? true;
        const launched = h('pre', { class: 'mp-code' }, askpassForm(value)); launched.hidden = !check.checked;
        check.addEventListener('change', () => { this.askpass.set(value, check.checked); launched.hidden = !check.checked; });
        return h('div', {}, h('label', { class: 'mp-askpass' }, check, ' Ask for the password in a dialog'), launched);
      };
      const disabled = this.busy || c.host !== 'bridge';
      return h('div', { class: 'mp-request-command' }, command, copy,
        h('p', {}, `Machine: ${c.host === 'bridge' ? this.host.host() || 'Bridge host' : c.host_text || 'unknown'}`),
        h('p', {}, `Folder: ${c.cwd || 'agent’s folder'} (${c.cwd_named ? 'named in the reply' : 'agent’s folder'})`),
        c.why ? h('p', {}, c.why) : null,
        c.host !== 'bridge' ? h('p', { class: 'mp-warning' }, `The agent asked to run this on ${c.host_text || 'an unknown machine'}`) : null,
        option(c.command),
        h('div', { class: 'mp-actions' }, h('button', { class: 'btn btn--primary', disabled, onclick: () => void this.start(index, c.command) }, this.busy ? 'Starting…' : 'Run'), c.host === 'bridge' ? h('button', { class: 'btn', disabled: this.busy, onclick: () => this.host.edit(c.command, c.cwd) }, 'Edit and run…') : null),
        ...(c.variants ?? []).map((v) => h('div', { class: 'mp-variant' }, h('p', {}, v.note), h('pre', { class: 'mp-code' }, v.command), option(v.command), h('button', { class: 'btn', disabled, onclick: () => void this.start(index, v.command) }, `Run ${v.label}`))));
    });
    this.el.replaceChildren(h('h3', {}, 'Run this command?'), ...cards, h('div', { class: 'mp-actions' }, h('button', { class: 'btn', disabled: this.busy, onclick: () => void this.dismiss() }, 'Dismiss')), h('p', { role: 'alert', class: 'mp-warning' }, this.message));
  }
}
