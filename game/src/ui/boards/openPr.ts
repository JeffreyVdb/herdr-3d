import type { OpenPrAck, OpenPrPrepare } from '../../net/protocol';
import { h, icon, ICON } from '../dom';
import type { DialogHost } from '../hire';
import { failureText } from '../messages';
import './boards.css';
import { backdropPolicy } from '../dismiss';

/**
 * M7: "Open PR" for a plain worker (from its Changes panel): `worker.open_pr.prepare` says what would be pushed and
 * opened (its branch, the base, how far ahead, a title and body drawn from its commits, or the PR that already exists),
 * the user edits the title and body and confirms, and `worker.open_pr` pushes the branch and opens the PR. Provider
 * neutral: the copy says `provider_name`; the button only shows where the floor's PR board says it can.
 */

export interface OpenPrHost extends DialogHost {
  /** What the provider is called (`GitHub`) on this floor. */
  /** #58: of floor `floor` (an id). */
  providerName(floor: string): string;
  external(url: string): void;
}

export type OpenPrState = 'preparing' | 'ready' | 'opening' | 'done' | 'failed';

export interface OpenPrSummary {
  kind: 'open-pr';
  worker: string;
  state: OpenPrState;
  title: string;
  body: string;
  branch: string | null;
  base: string | null;
  ahead: number | null;
  existing: string | null;
  blocker: string | null;
  status: string;
  error: boolean;
  result: { key: string; url: string | null; existed: boolean; pushed: boolean } | null;
}

const bytes = (s: string) => new TextEncoder().encode(s).length;
const PR = '<circle cx="7" cy="6" r="2.2"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="18" r="2.2"/><path d="M7 8.2v7.6M17 15.8V10a3 3 0 0 0-3-3h-3.5M12.5 5 10.5 7l2 2"/>';

export class OpenPrDialog {
  private readonly dialog = h('dialog', { class: 'desk-dlg desk-dlg--openpr', 'aria-labelledby': 'openpr-title', 'aria-describedby': 'openpr-sub' });
  private readonly head = h('header', { class: 'dd-head' });
  private readonly form = h('form', { class: 'dd-body', novalidate: true });
  private readonly statusEl = h('p', { class: 'dd-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private readonly actions = h('div', { class: 'dd-actions' });
  private readonly foot = h('footer', { class: 'dd-foot' }, this.statusEl, this.alertEl, this.actions);
  private worker = '';
  private name = '';
  private floor = '';
  private state: OpenPrState = 'preparing';
  private prep: OpenPrPrepare | null = null;
  private title = '';
  private body = '';
  private result: OpenPrSummary['result'] = null;
  private statusText = '';
  private statusError = false;
  private gen = 0;
  private returnTo: HTMLElement | null = null;
  private readonly titleInput = h('input', { id: 'openpr-title-in', 'data-key': 'title', maxlength: 256, autocomplete: 'off', spellcheck: 'true' });
  private readonly bodyInput = h('textarea', { id: 'openpr-body', 'data-key': 'body', rows: 7, spellcheck: 'true' });

  constructor(
    parent: HTMLElement,
    private readonly host: OpenPrHost,
  ) {
    this.alertEl.hidden = true;
    this.statusEl.hidden = true;
    this.dialog.append(this.head, this.form, this.foot);
    this.dialog.addEventListener('close', () => {
      if (this.dialog.open) return;
      this.gen++;
      const back = this.returnTo;
      this.returnTo = null;
      if (back?.isConnected) back.focus();
    });
    // #51: typed text or a consequential choice in here: only the close button and Esc close it, never the backdrop.
    backdropPolicy(this.dialog, 'none');
    this.form.addEventListener('submit', (e) => e.preventDefault());
    this.titleInput.addEventListener('input', () => {
      this.title = this.titleInput.value;
      this.renderActions();
    });
    this.bodyInput.addEventListener('input', () => {
      this.body = this.bodyInput.value;
      this.renderActions();
    });
    this.dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        void this.confirm();
      }
    });
    parent.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  open(workerId: string): void {
    const v = this.host.store.workerView(workerId);
    if (!v) return;
    if (!this.dialog.open) {
      const a = document.activeElement;
      this.returnTo = a instanceof HTMLElement && a !== document.body ? a : null;
    }
    this.worker = workerId;
    this.name = v.name;
    this.floor = v.worker.floor;
    this.state = 'preparing';
    this.prep = null;
    this.result = null;
    this.title = '';
    this.body = '';
    this.titleInput.value = '';
    this.bodyInput.value = '';
    this.setStatus(`Asking herdr-world what ${v.name}’s branch holds…`);
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    void this.prepare();
  }

  private async prepare(): Promise<void> {
    const gen = ++this.gen;
    if (this.host.unsupported('worker.open_pr.prepare')) {
      this.fail(failureText('worker.open_pr.prepare', 'unknown_command', ''));
      return;
    }
    const r = await this.host.send('worker.open_pr.prepare', { id: this.worker });
    if (gen !== this.gen || !this.dialog.open) return;
    if (!r.ok) {
      this.fail(failureText('worker.open_pr.prepare', r.code, r.message, { worker: this.name, provider: this.host.providerName(this.floor) }));
      return;
    }
    const p = r.data as OpenPrPrepare;
    this.prep = p;
    this.title = p.title ?? '';
    this.body = p.body ?? '';
    this.titleInput.value = this.title;
    this.bodyInput.value = this.body;
    this.state = 'ready';
    this.setStatus('');
    this.render();
    (p.existing ? this.actions.querySelector<HTMLElement>('[data-key="open-existing"]') : this.titleInput)?.focus();
  }

  private fail(msg: string): void {
    this.state = 'failed';
    this.setStatus(msg, true);
    this.render();
  }

  private setStatus(msg: string, error = false): void {
    this.statusText = msg;
    this.statusError = error && !!msg;
    this.alertEl.hidden = !error || !msg;
    this.statusEl.hidden = error || !msg;
    (error ? this.alertEl : this.statusEl).textContent = msg;
    (error ? this.statusEl : this.alertEl).textContent = '';
  }

  private blocker(): string | null {
    const p = this.prep;
    if (this.state === 'preparing') return 'Waiting for herdr-world…';
    if (this.state === 'opening') return 'Opening the pull request…';
    if (this.state !== 'ready' || !p) return this.statusText || 'It can’t be opened.';
    if (p.existing) return `${p.existing.key} already covers this branch.`;
    if (!p.can_open) return p.reason ?? 'The branch can’t be opened as a pull request now.';
    if (!this.title.trim()) return 'Give the pull request a title.';
    if (bytes(this.title) > 256) return 'The title is at most 256 bytes.';
    if (bytes(this.body) > 65_536) return 'The description is at most 64 KiB.';
    return null;
  }

  private render(): void {
    const name = this.host.providerName(this.floor);
    this.head.replaceChildren(
      h('div', { class: 'dd-plate dd-plate--board', 'aria-hidden': 'true' }, icon(PR)),
      h('div', { class: 'dd-titles' }, h('h2', { id: 'openpr-title' }, `Open a pull request for ${this.name}`), h('p', { id: 'openpr-sub' }, this.prep?.branch ? `${this.prep.branch} → ${this.prep.base ?? '…'} on ${name}` : `On ${name}`)),
      h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close)),
    );
    const p = this.prep;
    const nodes: Node[] = [];
    if (p) {
      const facts = h('dl', { class: 'dd-facts' }, h('dt', {}, 'Branch'), h('dd', {}, h('code', {}, p.branch ?? '')), h('dt', {}, 'Into'), h('dd', {}, h('code', {}, p.base ?? '')), h('dt', {}, 'New commits'), h('dd', {}, String(p.ahead ?? 0)));
      nodes.push(facts);
      if (p.existing) {
        nodes.push(h('div', { class: 'dd-callout', role: 'note' }, h('p', {}, `${name} already has ${p.existing.key} for this branch. Nothing new is pushed or opened.`)));
      } else if (p.dirty || !p.can_open) {
        nodes.push(h('div', { class: 'dd-callout dd-callout--error', role: 'alert' }, h('p', {}, p.reason ?? (p.dirty ? 'The checkout has uncommitted changes: commit them first.' : 'There is nothing to open.'))));
      }
      nodes.push(
        h('div', { class: 'dd-field' }, h('label', { for: 'openpr-title-in' }, 'Title'), this.titleInput),
        h('div', { class: 'dd-field' }, h('label', { for: 'openpr-body' }, 'Description ', h('span', { class: 'dd-optional' }, 'optional')), this.bodyInput, h('p', { class: 'field-hint' }, 'Markdown. It starts as the list of the branch’s commits.')),
        h('p', { class: 'field-hint' }, `This pushes ${p.branch ?? 'the branch'} to its remote and opens the pull request on ${name}. `, h('kbd', {}, 'Ctrl'), '+', h('kbd', {}, 'Enter'), ' confirms.'),
      );
    } else if (this.state === 'preparing') nodes.push(h('div', { class: 'dd-skeleton', 'aria-hidden': 'true' }, h('i'), h('i')));
    this.titleInput.disabled = this.bodyInput.disabled = this.state !== 'ready' || !!p?.existing || (p ? !p.can_open : true);
    this.form.replaceChildren(...nodes);
    this.renderActions();
  }

  private renderActions(): void {
    const p = this.prep;
    const blocker = this.blocker();
    const nodes: HTMLElement[] = [h('button', { class: 'btn', 'data-key': 'cancel', onclick: () => this.close() }, this.state === 'done' ? 'Close' : 'Cancel')];
    if (this.state === 'done' && this.result?.url) nodes.push(h('button', { class: 'btn', 'data-key': 'open-result', onclick: () => this.host.external(this.result?.url as string) }, `Open ${this.result.key} in ${this.host.providerName(this.floor)}`));
    else if (p?.existing?.url) nodes.push(h('button', { class: 'btn btn--primary', 'data-key': 'open-existing', onclick: () => this.host.external(p.existing?.url as string) }, `Open ${p.existing.key} in ${this.host.providerName(this.floor)}`));
    if (this.state !== 'done' && !p?.existing) {
      nodes.push(
        h('button', { class: 'btn btn--primary', 'data-key': 'confirm', 'aria-disabled': blocker ? 'true' : null, 'aria-busy': this.state === 'opening' ? 'true' : null, title: blocker ?? 'Push the branch and open the pull request (Ctrl+Enter)', onclick: () => void this.confirm() }, this.state === 'opening' ? 'Opening…' : 'Push and open PR'),
      );
    }
    this.actions.replaceChildren(...nodes);
  }

  private async confirm(): Promise<void> {
    const blocker = this.blocker();
    if (this.state !== 'ready') return;
    if (blocker) {
      this.setStatus(blocker, true);
      return;
    }
    this.state = 'opening';
    this.setStatus(`Pushing ${this.prep?.branch ?? 'the branch'} and opening the pull request…`);
    this.render();
    const gen = this.gen;
    const r = await this.host.send('worker.open_pr', { id: this.worker, title: this.title.trim(), body: this.body, confirm: true });
    if (gen !== this.gen && !this.dialog.open) {
      if (r.ok) this.host.toast('Pull request opened.', 'info');
      return;
    }
    if (!r.ok) {
      this.state = 'ready';
      this.setStatus(failureText('worker.open_pr', r.code, r.message, { worker: this.name, provider: this.host.providerName(this.floor) }), true);
      this.render();
      return;
    }
    const ack = r.data as OpenPrAck;
    this.result = { key: ack.pr.key, url: ack.pr.url ?? null, existed: ack.existed, pushed: ack.pushed };
    this.state = 'done';
    this.setStatus(ack.existed ? `${ack.pr.key} already existed for this branch; nothing was opened again.` : `Opened ${ack.pr.key}${ack.pushed ? ' and pushed the branch' : ''}.`);
    this.host.toast(ack.existed ? `${ack.pr.key} already covers ${this.name}’s branch.` : `Opened ${ack.pr.key} for ${this.name}.`, 'info');
    this.render();
    this.actions.querySelector<HTMLElement>('[data-key="open-result"], [data-key="cancel"]')?.focus();
  }

  summary(): OpenPrSummary | null {
    if (!this.dialog.open) return null;
    return {
      kind: 'open-pr',
      worker: this.worker,
      state: this.state,
      title: this.title,
      body: this.body,
      branch: this.prep?.branch ?? null,
      base: this.prep?.base ?? null,
      ahead: this.prep?.ahead ?? null,
      existing: this.prep?.existing?.key ?? null,
      blocker: this.blocker(),
      status: this.statusText,
      error: this.statusError,
      result: this.result,
    };
  }
}
