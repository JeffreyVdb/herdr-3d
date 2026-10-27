import type { CommandArgs, CommandRequest, RequestedCommand } from '../net/protocol';
import type { CommandResult } from '../net/client';
import { askpassEligible, askpassForm, newManualOp } from '../ui/manualProcesses';
import { h, icon, ICON, replaceKeepingFocus } from '../ui/dom';
import './commandRequestCard.css';

export interface CommandRequestCardHost {
  worker: string;
  /** #213: the worker's name, for the card's heading and the controls' names. */
  name?(): string;
  host(): string;
  start(args: CommandArgs['manual_process.start']): Promise<CommandResult>;
  dismiss(key: string): Promise<CommandResult>;
  edit(command: string, cwd: string): void;
}

// Keep each reviewed command's operation across view remounts and reconnects. It is never regenerated on retry.
const operations = new Map<string, string>();

/** A button with its icon before its label (the label is what a screen reader names it, unless `label` says more). */
function iconButton(cls: string, ic: string, text: string, attrs: Record<string, string | boolean | ((e: Event) => void) | undefined>): HTMLButtonElement {
  return h('button', { class: cls, ...attrs }, icon(ic), h('span', { class: 'mp-btn-text' }, text));
}

/**
 * #207, #213: an agent's reply asks you to run a command: the card under that reply, a command preview in the terminal's
 * terms. Each command (up to 3) shows its exact text in a mono well (the `$` is drawn, never selected or copied), the
 * machine and folder it runs in, the agent's reason, the password dialog's option with the launched form while it is on,
 * and Run, Edit and run…, Copy; a variant (Tailscale's foreground form) has its own text, note, option and Run. Nothing
 * runs without a click. Another machine's command can be copied, never run or edited here.
 */
export class CommandRequestCard {
  readonly el = h('section', { class: 'mp-request', tabindex: '-1' });
  private request: CommandRequest | null = null;
  /** What is in flight: `run:<index>:<command>` or `dismiss` (its button says so; the others wait). */
  private busy = '';
  private gone = '';
  private message = '';
  private readonly askpass = new Map<string, boolean>();
  private readonly copied = new Set<string>();
  private readonly overflow: ResizeObserver | null = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => { for (const e of entries) scrollable(e.target as HTMLElement); }) : null;
  private static n = 0;
  private readonly titleId = `mp-request-title-${++CommandRequestCard.n}`;
  constructor(private readonly host: CommandRequestCardHost) {
    this.el.hidden = true;
    this.el.setAttribute('aria-labelledby', this.titleId);
  }
  /** The card is up (a request that was not run or dismissed here). */
  get shown(): boolean { return !this.el.hidden; }
  set(request: CommandRequest | null): void {
    const changed = request?.key !== this.request?.key;
    this.request = request;
    if (changed) { this.busy = ''; this.message = ''; this.gone = ''; this.askpass.clear(); this.copied.clear(); }
    this.render();
  }
  /** #213: brought into view on request (the seat's chip): the card scrolls into view and its first action takes the focus. */
  reveal(): void {
    if (!this.shown) return;
    this.el.scrollIntoView?.({ block: 'nearest' });
    const first = this.el.querySelector<HTMLElement>('button:not(:disabled)') ?? this.el;
    first.focus({ preventScroll: true });
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
    this.busy = `run:${index}:${command}`; this.message = ''; this.render();
    const result = await this.host.start({ op: this.op(r.key, index, command), worker: this.host.worker, command, ...(c.cwd ? { cwd: c.cwd } : {}), source: { kind: 'suggestion', key: r.key, index }, askpass: eligible && (this.askpass.get(command) ?? true) });
    this.busy = '';
    if (this.request?.key !== r.key) return;
    if (result.ok) this.gone = r.key;
    else if (result.code === 'stale') this.message = 'This request is out of date: the agent has moved on, or it was already run.';
    else if (result.code === 'bad_args' || result.code === 'bad_request') { this.message = `${result.message} You can run without the password dialog: sudo then asks in the run’s terminal.`; this.askpass.set(command, false); }
    else this.message = result.message || 'Could not start the command. Try again.';
    this.render();
  }
  private async dismiss(): Promise<void> {
    const r = this.request; if (!r || this.busy) return;
    this.busy = 'dismiss'; this.message = ''; this.render();
    const result = await this.host.dismiss(r.key);
    this.busy = '';
    if (this.request?.key !== r.key) return;
    if (result.ok) this.gone = r.key;
    else this.message = result.code === 'stale' ? 'This request is out of date: the agent has moved on, or it was already run.' : result.message || 'Could not dismiss the request. Try again.';
    this.render();
  }
  private copy(key: string, command: string): void {
    void (navigator.clipboard?.writeText(command) ?? Promise.reject(new Error('no clipboard'))).then(() => {
      this.copied.add(key); this.render();
      setTimeout(() => { this.copied.delete(key); this.render(); }, 2000);
    }, () => { this.message = 'Could not copy the command. Select it in the box to copy it.'; this.render(); });
  }
  private render(): void {
    const r = this.request;
    this.el.hidden = !r || r.key === this.gone;
    this.overflow?.disconnect();
    if (!r || this.el.hidden) { this.el.replaceChildren(); return; }
    const name = this.host.name?.() ?? '';
    const many = r.commands.length > 1;
    const lone = !many && !r.commands[0]?.variants?.length;
    const head = h('header', { class: 'mp-request-head' },
      h('h3', { class: 'mp-request-title', id: this.titleId }, h('span', { class: 'mp-request-icon' }, icon(ICON.terminal)), h('span', {}, 'Command Preview'), name ? h('span', { class: 'mp-request-from' }, `from ${name}`) : null),
      h('p', { class: 'mp-request-ask' }, many ? `Run these ${r.commands.length} commands?` : 'Run this command?'));
    const dismiss = iconButton('btn mp-dismiss', ICON.close, this.busy === 'dismiss' ? 'Dismissing…' : 'Dismiss', { 'data-key': 'dismiss', 'aria-disabled': this.busy ? 'true' : undefined, 'aria-label': 'Dismiss this request', onclick: () => void this.dismiss() });
    const blocks = r.commands.map((c, index) => this.command(c, index, many, lone ? dismiss : null));
    const alert = h('p', { class: 'mp-alert', role: 'alert' }, this.message ? icon(ICON.alert) : null, this.message);
    replaceKeepingFocus(this.el, [head, ...blocks, ...(lone ? [] : [h('footer', { class: 'mp-request-foot' }, dismiss)]), alert], 'dismiss');
    for (const pre of this.el.querySelectorAll<HTMLElement>('.mp-well pre')) { scrollable(pre); this.overflow?.observe(pre); }
  }
  /** One command: its well, where it runs, why, the dialog option, its actions, then its variants. */
  private command(c: RequestedCommand, index: number, many: boolean, dismiss: HTMLButtonElement | null): HTMLElement {
    const bridge = c.host === 'bridge';
    const which = many ? ` ${index + 1}` : '';
    const machine = bridge ? this.host.host() || 'Bridge host' : c.host_text || 'an unknown machine';
    // Another machine: Run is off for good. In flight: held with aria-disabled, so the pressed button keeps the focus.
    const disabled = !bridge;
    const held = this.busy ? 'true' : undefined;
    const runText = (command: string, idle: string) => (this.busy === `run:${index}:${command}` ? 'Starting…' : idle);
    const copyKey = `copy:${index}:`;
    const actions = h('div', { class: 'mp-actions' },
      iconButton('btn btn--primary', ICON.play, runText(c.command, 'Run'), { 'data-key': `run:${index}:`, disabled, 'aria-disabled': held, ...(many ? { 'aria-label': `Run command${which}` } : {}), onclick: () => void this.start(index, c.command) }),
      bridge ? iconButton('btn', ICON.pencil, 'Edit and run…', { 'data-key': `edit:${index}`, 'aria-disabled': held, 'aria-haspopup': 'dialog', ...(many ? { 'aria-label': `Edit and run command${which}…` } : {}), onclick: () => { if (!this.busy) this.host.edit(c.command, c.cwd); } }) : null,
      iconButton('btn', ICON.copy, this.copied.has(copyKey) ? 'Copied' : 'Copy', { 'data-key': copyKey, 'aria-label': this.copied.has(copyKey) ? `Copied command${which}` : `Copy command${which}`, onclick: () => this.copy(copyKey, c.command) }),
      dismiss);
    const variants = (c.variants ?? []).map((v, vi) => {
      const key = `copy:${index}:${vi}`;
      return h('div', { class: 'mp-variant' },
        h('p', { class: 'mp-variant-note' }, h('b', {}, `${v.label[0]?.toUpperCase() ?? ''}${v.label.slice(1)}: `), v.note),
        well(v.command, `${v.label} command`),
        this.option(v.command),
        h('div', { class: 'mp-actions' },
          iconButton('btn', ICON.play, runText(v.command, `Run ${v.label}`), { 'data-key': `run:${index}:${vi}`, disabled, 'aria-disabled': held, onclick: () => void this.start(index, v.command) }),
          iconButton('btn', ICON.copy, this.copied.has(key) ? 'Copied' : 'Copy', { 'data-key': key, 'aria-label': `Copy ${v.label} command`, onclick: () => this.copy(key, v.command) })));
    });
    return h('div', { class: 'mp-request-command', role: many ? 'group' : null, 'aria-label': many ? `Command${which}` : null },
      many ? h('p', { class: 'mp-request-n' }, `Command${which}`) : null,
      well(c.command, `Command${which}`),
      h('dl', { class: 'mp-meta' },
        h('dt', {}, 'Machine:'), h('dd', {}, machine),
        h('dt', {}, 'Folder:'), h('dd', {}, c.cwd || 'the agent’s folder', h('span', { class: 'mp-meta-note' }, c.cwd_named ? ' (named in the reply)' : ' (agent’s folder)'))),
      c.why ? h('p', { class: 'mp-why' }, c.why) : null,
      bridge ? null : h('p', { class: 'mp-warning' }, icon(ICON.alert), h('span', {}, `The agent asked to run this on ${c.host_text || 'an unknown machine'}. This bridge cannot run it here: copy it to run it there.`)),
      bridge ? this.option(c.command) : null,
      actions,
      ...variants);
  }
  /** The password dialog's option for an eligible sudo command, and the launched form while it is on. */
  private option(value: string): HTMLElement | null {
    if (!askpassEligible(value)) return null;
    const on = this.askpass.get(value) ?? true;
    const check = h('input', { type: 'checkbox', 'data-key': `askpass:${value}` }); check.checked = on;
    const launched = h('div', { class: 'mp-launched' }, h('span', { class: 'mp-launched-label' }, 'Launched form'), well(askpassForm(value), 'Launched form', false));
    launched.hidden = !on;
    check.addEventListener('change', () => { this.askpass.set(value, check.checked); launched.hidden = !check.checked; });
    return h('div', { class: 'mp-option' }, h('label', { class: 'mp-askpass' }, check, h('span', {}, 'Ask for the password in a dialog')), launched);
  }
}

/** The exact text in a mono well; `prompt`: the drawn `$` before it (a pseudo-element: never selected, never copied). */
function well(text: string, label: string, prompt = true): HTMLElement {
  return h('div', { class: prompt ? 'mp-well mp-well--prompt' : 'mp-well' }, h('pre', { 'data-label': label }, text));
}

/** A well that scrolls sideways takes the keyboard (arrow keys scroll it); one that fits is no tab stop. */
function scrollable(pre: HTMLElement): void {
  if (pre.scrollWidth > pre.clientWidth + 1) { pre.tabIndex = 0; pre.setAttribute('role', 'region'); pre.setAttribute('aria-label', pre.dataset.label ?? 'Command'); }
  else for (const a of ['tabindex', 'role', 'aria-label']) pre.removeAttribute(a);
}
