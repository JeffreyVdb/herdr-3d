import type { CommandResult } from '../net/client';
import type { CommandArgs, ManualProcess } from '../net/protocol';
import { backdropPolicy } from './dismiss';
import { h } from './dom';

export interface ManualCredentialSummary { kind: 'manual-credential'; state: 'ready' | 'busy'; id: string; request: string; attempt: number }

/** The secret lives only in the input until the request is sent. */
export class ManualCredentialDialog {
  private readonly dialog = h('dialog', { class: 'desk-dlg mp-credential', 'aria-labelledby': 'mp-credential-title' });
  private readonly body = h('div', { class: 'dd-body' });
  private readonly input = h('input', { type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Password' });
  private readonly status = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private process: ManualProcess | null = null;
  private busy = false;
  private answered = '';
  private returnTo: HTMLElement | null = null;

  constructor(parent: HTMLElement, private readonly send: (args: CommandArgs['manual_process.credential']) => Promise<CommandResult>, private readonly toast: (s: string) => void) {
    const cancel = h('button', { class: 'btn', onclick: () => void this.answer(true) }, 'Cancel');
    const submit = h('button', { class: 'btn btn--primary', onclick: () => void this.answer(false) }, 'Submit');
    this.dialog.append(h('header', { class: 'dd-head' }, h('div', { class: 'dd-titles' }, h('h2', { id: 'mp-credential-title' }, 'Password requested'))), this.body, h('footer', { class: 'dd-foot' }, h('div', { class: 'dd-actions' }, cancel, submit)));
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void this.answer(false); } });
    this.dialog.addEventListener('cancel', (e) => { e.preventDefault(); void this.answer(true); });
    this.dialog.addEventListener('close', () => { this.input.value = ''; const back = this.returnTo; this.returnTo = null; if (back?.isConnected) back.focus({ preventScroll: true }); });
    backdropPolicy(this.dialog, 'none');
    parent.append(this.dialog);
  }
  get isOpen(): boolean { return this.dialog.open; }
  refresh(process: ManualProcess | undefined): void {
    const c = process?.credential;
    if (!process || !c || c.request === this.answered) { if (this.dialog.open) this.dialog.close(); this.process = null; return; }
    if (this.process?.id === process.id && this.process.credential?.request === c.request && this.dialog.open) return;
    this.input.value = '';
    this.process = process;
    this.busy = false;
    this.status.textContent = '';
    this.body.replaceChildren(h('p', {}, `Host: ${process.host}`), h('p', {}, `User: ${c.user}`), h('pre', {}, process.launched || process.command), h('p', {}, c.prompt), h('p', {}, c.attempt > 1 ? `Wrong password, try again (attempt ${c.attempt})` : `Attempt ${c.attempt}`), this.input, this.status);
    if (!this.dialog.open) { this.returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null; this.dialog.showModal(); }
    this.input.focus();
  }
  private async answer(cancel: boolean): Promise<void> {
    const p = this.process;
    const c = p?.credential;
    if (!p || !c || this.busy) return;
    const secret = this.input.value;
    this.input.value = '';
    this.busy = true;
    const result = await this.send(cancel ? { id: p.id, request: c.request, cancel: true } : { id: p.id, request: c.request, secret });
    this.busy = false;
    if (!result.ok && result.code === 'stale') this.toast('This password request is out of date.');
    if (this.process?.credential?.request !== c.request) return;
    if (result.ok || result.code === 'stale') {
      this.answered = c.request;
      this.process = null;
      if (this.dialog.open) this.dialog.close();
    } else {
      // Never display bridge error text: it could contain credential material.
      this.status.textContent = 'Could not send the answer. Try again.';
      this.input.focus();
    }
  }
  summary(): ManualCredentialSummary | null {
    const c = this.process?.credential;
    return this.dialog.open && this.process && c ? { kind: 'manual-credential', state: this.busy ? 'busy' : 'ready', id: this.process.id, request: c.request, attempt: c.attempt } : null;
  }
}
