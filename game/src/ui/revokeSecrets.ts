import './revokeSecrets.css';
import type { CommandResult } from '../net/client';
import type { CommandArgs, CommandName, PromptSecretsRevokeAck } from '../net/protocol';
import { revokedText, revokeWhat, secretFilesOf, secretFilesText } from '../world/revokeSecrets';
import type { WorldStore } from '../world/store';
import { backdropPolicy } from './dismiss';
import { h, icon, ICON } from './dom';
import { failureText } from './messages';

/**
 * #108 round 4: "Remove protected files": the confirmation before a worker's protected files go now
 * (`prompt_secrets.revoke`, round 5's bridge command). The seat bar's chip opens it ("3 protected files", at the
 * laptop of a worker that holds some: `Worker.secret_files`). It says what removing does: the files go, the worker
 * keeps running, the references in its earlier prompts point at nothing, and it cannot be undone. Cancel has the
 * keyboard first; Esc and the close button cancel. A small desk dialog: you stay seated under it. The count follows
 * the worker while it is open; a worker that left, or holds none any more, closes it.
 */

export interface RevokeSecretsHost {
  readonly store: WorldStore;
  send(t: 'prompt_secrets.revoke', args: CommandArgs['prompt_secrets.revoke']): Promise<CommandResult>;
  unsupported(t: CommandName): boolean;
  toast(msg: string, kind: 'info' | 'error'): void;
}

/** What the dialog shows (test hook, via `window.__h3d.dialog()`). */
export interface RevokeSecretsSummary {
  kind: 'revoke-secrets';
  /** `busy` while the command is on its way. */
  state: 'ready' | 'busy';
  worker: string;
  name: string;
  files: number;
  what: string[];
  status: string;
  error: boolean;
}

/** The plate: a padlocked file with a stroke through it (the file goes). */
const FILE_GONE = '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2H11"/><path d="M14 3.5V8h4.5V11"/><rect x="13" y="14" width="7.5" height="6" rx="1.2"/><path d="M14.8 14v-1.6a1.95 1.95 0 0 1 3.9 0V14"/><path d="M4 21 21 4"/>';

export class RevokeSecretsDialog {
  private readonly dialog = h('dialog', { class: 'desk-dlg desk-dlg--revoke', 'aria-labelledby': 'rv-sec-title', 'aria-describedby': 'rv-sec-what' });
  private readonly titleEl = h('h2', { id: 'rv-sec-title' });
  private readonly subEl = h('p', { id: 'rv-sec-sub' });
  private readonly what = h('div', { class: 'dd-callout dd-callout--error rv-sec-what', id: 'rv-sec-what', 'data-hook': 'revoke-what' });
  private readonly statusEl = h('p', { class: 'dd-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private readonly cancelBtn = h('button', { class: 'btn', 'data-key': 'cancel', onclick: () => this.close() }, 'Cancel');
  private readonly removeBtn = h('button', { class: 'btn btn--danger', 'data-key': 'remove', onclick: () => void this.remove() });
  private worker = '';
  private name = '';
  private files = 0;
  private busy = false;
  private statusText = '';
  private statusError = false;
  private returnTo: HTMLElement | null = null;

  constructor(
    parent: HTMLElement,
    private readonly host: RevokeSecretsHost,
  ) {
    this.alertEl.hidden = this.statusEl.hidden = true;
    const head = h(
      'header',
      { class: 'dd-head' },
      h('div', { class: 'dd-plate dd-plate--lock', 'aria-hidden': 'true' }, icon(FILE_GONE)),
      h('div', { class: 'dd-titles' }, this.titleEl, this.subEl),
      h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Cancel: nothing is removed', title: 'Cancel (Esc): nothing is removed', onclick: () => this.close() }, icon(ICON.close)),
    );
    this.dialog.append(head, h('div', { class: 'dd-body' }, this.what), h('footer', { class: 'dd-foot' }, this.statusEl, this.alertEl, h('div', { class: 'dd-actions' }, this.cancelBtn, this.removeBtn)));
    this.dialog.addEventListener('close', () => {
      const back = this.returnTo;
      this.returnTo = null;
      if (back?.isConnected) back.focus({ preventScroll: true });
    });
    // A click beside it is no answer to "remove them?": only Cancel, Esc and the close button close it.
    backdropPolicy(this.dialog, 'none');
    parent.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  /** Opened from a seat (the bar's chip): you stay seated under it. */
  get keepsSeat(): boolean {
    return this.dialog.open;
  }

  /** For `workerId`'s files (`from` gets the keyboard back). False: nothing to remove, or a bridge without the command. */
  open(workerId: string, from: HTMLElement | null = null): boolean {
    const v = this.host.store.workerView(workerId);
    const n = secretFilesOf(this.host.store.workers.get(workerId));
    if (!v || !n || this.host.unsupported('prompt_secrets.revoke')) return false;
    this.worker = workerId;
    this.name = v.name;
    this.files = n;
    this.busy = false;
    this.setStatus('');
    this.returnTo = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    // Cancel first: Enter right away removes nothing.
    this.cancelBtn.focus();
    return true;
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  /** The world changed: the count follows the worker; a worker that left or holds none closes it. */
  refresh(): void {
    if (!this.dialog.open || this.busy) return;
    const n = secretFilesOf(this.host.store.workers.get(this.worker));
    if (!this.host.store.workerView(this.worker) || !n) {
      this.close();
      return;
    }
    if (n === this.files) return;
    this.files = n;
    this.render();
  }

  private render(): void {
    const n = this.files;
    // Short enough for a phone's header; whose files, and how many, on the line under it.
    this.titleEl.textContent = n === 1 ? 'Remove the protected file' : 'Remove protected files';
    this.subEl.textContent = `${this.name} · ${secretFilesText(n)} on the bridge host`;
    this.what.replaceChildren(...revokeWhat(this.name, n).map((t) => h('p', {}, t)));
    this.removeBtn.replaceChildren(icon(ICON.trash), h('span', {}, n === 1 ? 'Remove the file' : `Remove ${n} files`));
    this.removeBtn.toggleAttribute('disabled', this.busy);
    this.removeBtn.setAttribute('aria-busy', String(this.busy));
    this.cancelBtn.toggleAttribute('disabled', this.busy);
  }

  private async remove(): Promise<void> {
    if (this.busy) return;
    const worker = this.worker;
    const name = this.name;
    this.busy = true;
    this.setStatus(`Removing ${name}’s protected files…`);
    this.render();
    const r = await this.host.send('prompt_secrets.revoke', { worker });
    this.busy = false;
    const still = this.dialog.open && this.worker === worker;
    if (r.ok) {
      const removed = (r.data as Partial<PromptSecretsRevokeAck> | undefined)?.removed;
      this.close();
      this.host.toast(revokedText(name, typeof removed === 'number' ? removed : this.files), 'info');
      return;
    }
    const msg = failureText('prompt_secrets.revoke', r.code, r.message, { worker: name });
    // A bridge without the command: the control goes (the app marked it unsupported); say why where you look.
    if (!still || r.code === 'unknown_command') {
      this.close();
      this.host.toast(msg, 'error');
      return;
    }
    this.setStatus(msg, true);
    this.render();
    this.cancelBtn.focus();
  }

  private setStatus(msg: string, error = false): void {
    this.statusText = msg;
    this.statusError = error;
    this.alertEl.hidden = !error || !msg;
    this.statusEl.hidden = error || !msg;
    (error ? this.alertEl : this.statusEl).textContent = msg;
    (error ? this.statusEl : this.alertEl).textContent = '';
  }

  summary(): RevokeSecretsSummary | null {
    if (!this.dialog.open) return null;
    return { kind: 'revoke-secrets', state: this.busy ? 'busy' : 'ready', worker: this.worker, name: this.name, files: this.files, what: revokeWhat(this.name, this.files), status: this.statusText, error: this.statusError };
  }
}
