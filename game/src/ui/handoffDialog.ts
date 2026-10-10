import './handoff.css';
import type { HandoffAck, HandoffCandidate, HandoffPreviewAck } from '../net/protocol';
import { candidateOf, newOp, noCandidateWhy, omittedNote } from '../world/handoff';
import { backdropPolicy } from './dismiss';
import { h, icon, ICON } from './dom';
import type { DialogHost } from './hire';
import { failureText } from './messages';

/**
 * #223: the filing dialog. A literal handoff files the worker's latest completed reply exactly as written: the preview
 * is that text (the bridge read it back from the transcript, the first 64 KiB of it), with where it comes from and an
 * optional "Send home after filing". No model is asked and nothing is sent to the worker; the send home, when ticked,
 * starts only after the handoff was filed, and the bridge checks again then whether the worker may go.
 *
 * Opened by the transcript's inline button or by F at the worker. Without a candidate it says why and offers nothing
 * else: never a summary in its place. A newer reply (or none) while it is open makes the preview stale: File is off
 * until you load the new one. One operation id per preview, so a repeated submit (a dropped connection) files once.
 */

export interface HandoffDialogHost extends DialogHost {
  /** Puts text on the clipboard; false when the browser refused. */
  copy(text: string): Promise<boolean>;
  /** Opens the floor's filing cabinet (after a filing, "Open the cabinet"). */
  openCabinet(floor: string, select?: number): void;
}

type State = 'none' | 'loading' | 'ready' | 'filing' | 'filed' | 'failed';

/** What the dialog shows (test hook `window.__h3d.handoffDialog()`). */
export interface HandoffDialogSummary {
  open: boolean;
  state: State;
  worker: string;
  candidate: string | null;
  text: string;
  truncated: boolean;
  title: string;
  stale: boolean;
  sendHome: boolean;
  canSendHome: boolean;
  status: string;
  error: boolean;
  path: string;
}

const kb = (n: number) => (n < 1024 ? `${n} bytes` : n < 1 << 20 ? `${Math.round(n / 102.4) / 10} KB` : `${Math.round(n / 104857.6) / 10} MB`);
const shortId = (s: string) => (s.length > 12 ? `${s.slice(0, 8)}…` : s);

export class HandoffDialog {
  private readonly dialog = h('dialog', { class: 'desk-dlg desk-dlg--handoff', 'aria-labelledby': 'ho-title', 'aria-describedby': 'ho-sub' });
  private readonly head = h('header', { class: 'dd-head' });
  private readonly body = h('div', { class: 'dd-body ho-body' });
  private readonly statusEl = h('p', { class: 'dd-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private readonly actions = h('div', { class: 'dd-actions' });
  private readonly sendBox = h('input', { type: 'checkbox', id: 'ho-send-home', 'data-key': 'send-home', 'aria-describedby': 'ho-send-hint' }) as HTMLInputElement;
  private id = '';
  private name = '';
  private session = '';
  private state: State = 'loading';
  private cand: HandoffCandidate | null = null;
  private preview: HandoffPreviewAck | null = null;
  private ack: HandoffAck | null = null;
  private why = '';
  private op = '';
  private stale = false;
  /** The latest candidate the stale note was drawn for ("": none). */
  private latest = '';
  private statusText = '';
  private statusError = false;
  private gen = 0;
  /** Opened over the laptop you sit at (the seat stays). */
  private seated = false;

  constructor(
    parent: HTMLElement,
    private readonly host: HandoffDialogHost,
  ) {
    this.alertEl.hidden = this.statusEl.hidden = true;
    this.dialog.append(this.head, this.body, h('footer', { class: 'dd-foot' }, this.statusEl, this.alertEl, this.actions));
    this.dialog.addEventListener('close', () => this.gen++);
    // A consequential choice in here (the send home): only Esc and the buttons close it.
    backdropPolicy(this.dialog, 'none');
    this.sendBox.addEventListener('change', () => this.renderActions());
    parent.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  /** Opened over the laptop you sit at: the seat stays. */
  get keepsSeat(): boolean {
    return this.dialog.open && this.seated;
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  /** Opens for a worker's latest completed reply (`c`: the one its button showed; else its current one). */
  open(workerId: string, opts: { seated?: boolean; candidate?: HandoffCandidate } = {}): void {
    const v = this.host.store.workerView(workerId);
    if (!v) return;
    this.id = workerId;
    this.name = v.name;
    this.session = v.worker.session;
    this.seated = opts.seated === true;
    this.ack = null;
    this.sendBox.checked = false;
    this.start(opts.candidate ?? candidateOf(v.worker));
    if (!this.dialog.open) this.dialog.showModal();
    this.focusFirst();
  }

  private start(c: HandoffCandidate | null): void {
    const v = this.host.store.workerView(this.id);
    this.cand = c;
    this.preview = null;
    this.stale = false;
    this.setStatus('');
    this.why = v ? (c ? '' : noCandidateWhy(v.worker, this.name, this.host.store.handoffs.known)) : `${this.name} has left.`;
    if (c?.too_large) this.why = noCandidateWhy({ ...(v?.worker ?? { id: this.id, session: this.session, workspace_id: '', label: '', status: '' }), handoff: c }, this.name, true);
    if (this.why || !c) {
      this.state = 'none';
      this.render();
      return;
    }
    this.op = newOp();
    this.state = 'loading';
    this.render();
    void this.load(c);
  }

  private async load(c: HandoffCandidate): Promise<void> {
    const op = this.op; // this preview's: a newer one (another reply, a reopen) has another
    if (this.host.unsupported('worker.handoff_preview')) {
      this.state = 'failed';
      this.setStatus(failureText('worker.handoff_preview', 'unknown_command', ''), true);
      this.render();
      return;
    }
    const r = await this.host.send('worker.handoff_preview', { worker: this.id, candidate: c.id });
    if (op !== this.op || this.state !== 'loading' || !this.dialog.open) return;
    if (!r.ok) {
      this.state = 'failed';
      this.setStatus(failureText('worker.handoff_preview', r.code, r.message, { worker: this.name, floor: this.session }), true);
      this.render();
      return;
    }
    this.preview = r.data as HandoffPreviewAck;
    this.state = 'ready';
    this.render();
    this.focusFirst();
  }

  /** The world changed: the worker gone, or its reply replaced (a new turn): the preview is stale. */
  refresh(): void {
    if (!this.dialog.open || this.state === 'filing' || this.state === 'filed') return;
    const v = this.host.store.workerView(this.id);
    if (!v) {
      if (this.state === 'none') return;
      this.state = 'none';
      this.why = `${this.name} has left, so there is no reply to file.`;
      this.render();
      return;
    }
    const now = candidateOf(v.worker);
    const same = !!now && !!this.cand && now.id === this.cand.id && now.revision === this.cand.revision;
    if (this.state === 'none') {
      if (now) this.start(now);
      return;
    }
    const latest = now ? `${now.id}/${now.revision}` : '';
    if (same === !this.stale && (same || latest === this.latest)) return;
    this.stale = !same;
    this.latest = latest;
    this.render();
  }

  private focusFirst(): void {
    const k = this.state === 'ready' && !this.stale ? 'file' : this.state === 'filed' ? 'done' : 'cancel';
    this.actions.querySelector<HTMLElement>(`[data-key="${k}"]`)?.focus();
  }

  private setStatus(msg: string, error = false): void {
    this.statusText = msg;
    this.statusError = error;
    this.alertEl.hidden = !error || !msg;
    this.statusEl.hidden = error || !msg;
    (error ? this.alertEl : this.statusEl).textContent = msg;
    (error ? this.statusEl : this.alertEl).textContent = '';
  }

  private render(): void {
    const v = this.host.store.workerView(this.id);
    const sub = [this.session, v ? `Desk ${v.desk + 1}` : null, v?.worker.branch ?? null].filter(Boolean).join(' · ');
    this.head.replaceChildren(
      h('div', { class: 'dd-plate dd-plate--folder', 'aria-hidden': 'true' }, icon(ICON.folder)),
      h('div', { class: 'dd-titles' }, h('h2', { id: 'ho-title' }, `File a handoff from ${this.name}`), h('p', { id: 'ho-sub' }, sub)),
      h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close)),
    );
    this.body.replaceChildren(...this.bodyNodes());
    this.renderActions();
  }

  private bodyNodes(): Node[] {
    if (this.state === 'none') {
      return [h('p', { class: 'ho-lede ho-lede--none', 'data-hook': 'ho-why' }, this.why), h('p', { class: 'ho-hint' }, 'A handoff files the agent’s last completed reply as written. Ask it for a summary first if you want one, then file that.')];
    }
    if (this.state === 'filed' && this.ack) return this.filedNodes(this.ack);
    const p = this.preview;
    const c = this.cand;
    const lede = h('p', { class: 'ho-lede' }, h('b', {}, 'Saved exactly as written'), ' · no AI call. The reply goes into the floor’s cabinet as Markdown, unchanged; where it came from goes in the file’s front matter.');
    if (!p || !c) return [lede, h('div', { class: 'dd-skeleton', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))];
    const nodes: Node[] = [lede];
    if (this.stale) {
      nodes.push(
        h(
          'div',
          { class: 'ho-stale', role: 'note', 'data-hook': 'ho-stale' },
          h('span', {}, `${this.name}’s latest reply changed since this preview (a new turn, or a newer reply).`),
          candidateOf(this.host.store.workers.get(this.id)) ? h('button', { class: 'btn btn--sm', 'data-key': 'reload', onclick: () => this.start(candidateOf(this.host.store.workers.get(this.id))) }, 'Show the latest reply') : null,
        ),
      );
    }
    const sheet = h('pre', { class: 'ho-sheet', tabindex: '0', 'aria-label': `The reply, as it will be filed${p.truncated ? ' (the first 64 KB shown)' : ''}`, 'data-hook': 'ho-text' });
    sheet.textContent = p.text;
    nodes.push(h('figure', { class: 'ho-file' }, h('figcaption', { class: 'ho-tab', title: 'The title it gets: its first heading, else its first line' }, icon(ICON.folder), h('span', { 'data-hook': 'ho-title' }, p.title)), sheet));
    const notes: string[] = [];
    if (p.truncated) notes.push(`The preview shows the first ${kb(new TextEncoder().encode(p.text).length)} of ${kb(c.bytes)}; the whole reply is filed.`);
    const om = omittedNote(c);
    if (om) notes.push(om);
    if (notes.length) nodes.push(h('p', { class: 'ho-hint', 'data-hook': 'ho-notes' }, notes.join(' ')));
    const pr = p.provenance;
    const from = [pr.harness, pr.model].filter(Boolean).join(' · ');
    nodes.push(
      h(
        'dl',
        { class: 'ho-prov', 'data-hook': 'ho-prov' },
        h('dt', {}, 'From'),
        h('dd', {}, `${pr.worker_name}${pr.label && pr.label !== pr.worker_name ? ` (${pr.label})` : ''}${from ? ` · ${from}` : ''}`),
        pr.branch ? h('dt', {}, 'Branch') : null,
        pr.branch ? h('dd', {}, h('code', {}, pr.branch)) : null,
        h('dt', {}, 'Source'),
        h('dd', {}, `Last completed reply · ${kb(c.bytes)}`, pr.session ? ` · session ${shortId(pr.session)}` : ''),
        h('dt', {}, 'Into'),
        h('dd', {}, `The ${pr.floor} cabinet`),
      ),
    );
    this.sendBox.disabled = !p.can_send_home || this.state === 'filing';
    if (!p.can_send_home) this.sendBox.checked = false;
    nodes.push(
      h(
        'div',
        { class: 'ho-home', 'data-on': this.sendBox.checked ? 'true' : 'false', 'data-off': p.can_send_home ? null : 'true' },
        h('label', { class: 'dd-check', for: 'ho-send-home' }, this.sendBox, h('span', { class: 'dd-check-box', 'aria-hidden': 'true' }), h('span', {}, `Send ${this.name} home after filing`)),
        h(
          'p',
          { class: 'dd-base', id: 'ho-send-hint' },
          p.can_send_home ? 'Only once the handoff is filed; the worktree is kept. If it can’t go then, it stays and you are told why.' : `Not now: ${p.send_home_blocked ?? 'it can’t be sent home'}.`,
        ),
      ),
    );
    return nodes;
  }

  private filedNodes(a: HandoffAck): Node[] {
    const path = h('code', { class: 'ho-path', 'data-hook': 'ho-path' }, a.handoff.path);
    const home =
      a.send_home === 'started'
        ? `${this.name} is on the way home; the worktree is kept.`
        : a.send_home === 'skipped'
          ? `${this.name} was not sent home: ${a.send_home_reason ?? 'it can’t go now'}.`
          : null;
    const out: Node[] = [
      h('p', { class: 'ho-lede' }, a.existing ? 'Already in the cabinet: this reply was filed before, so nothing was filed twice.' : `In the ${a.handoff.floor} cabinet as “${a.handoff.title}”.`),
      h('div', { class: 'ho-where' }, path, h('button', { class: 'btn btn--sm', 'data-key': 'copy', onclick: () => void this.copyPath(a.handoff.path) }, 'Copy path')),
    ];
    if (home) out.push(h('p', { class: a.send_home === 'skipped' ? 'ho-hint ho-hint--warn' : 'ho-hint', 'data-hook': 'ho-home' }, home));
    return out;
  }

  private async copyPath(path: string): Promise<void> {
    const ok = await this.host.copy(path);
    this.setStatus(ok ? 'Path copied.' : 'The browser did not allow copying: select the path and copy it.', !ok);
  }

  private renderActions(): void {
    const filing = this.state === 'filing';
    const home = this.body.querySelector<HTMLElement>('.ho-home');
    if (home) home.dataset.on = this.sendBox.checked ? 'true' : 'false';
    if (this.state === 'filed') {
      const a = this.ack;
      this.actions.replaceChildren(
        h('button', { class: 'btn', 'data-key': 'cabinet', onclick: () => (this.close(), a && this.host.openCabinet(a.handoff.floor, a.handoff.id)) }, 'Open the cabinet'),
        h('button', { class: 'btn btn--primary', 'data-key': 'done', onclick: () => this.close() }, 'Done'),
      );
      return;
    }
    const cancel = h('button', { class: 'btn', 'data-key': 'cancel', onclick: () => this.close() }, this.state === 'none' ? 'Close' : 'Cancel');
    if (this.state === 'none') {
      this.actions.replaceChildren(cancel);
      return;
    }
    const why = this.state === 'loading' ? 'Reading the reply…' : this.stale ? 'The reply changed: show the latest one first' : this.state === 'failed' && !this.preview ? 'The reply could not be read' : '';
    const label = filing ? 'Filing…' : this.sendBox.checked ? 'File, then send home' : 'File handoff';
    const file = h('button', { class: 'btn btn--primary', 'data-key': 'file', 'aria-disabled': why || filing ? 'true' : null, title: why || null, onclick: () => void this.file() }, icon(ICON.folder), label);
    this.actions.replaceChildren(cancel, file);
  }

  private async file(): Promise<void> {
    const c = this.cand;
    if (!c || !this.preview || this.stale || this.state === 'filing' || this.state === 'loading') return;
    const gen = this.gen;
    this.state = 'filing';
    this.setStatus('Filing…');
    this.render();
    const sendHome = this.sendBox.checked;
    const r = await this.host.send('worker.handoff', { worker: this.id, mode: 'literal', session: c.session, candidate: c.id, revision: c.revision, op: this.op, ...(sendHome ? { send_home: true } : {}) });
    if (gen !== this.gen) {
      // Closed meanwhile: the outcome still matters.
      if (r.ok) this.host.toast(`Filed ${this.name}’s handoff.`, 'info');
      else this.host.toast(failureText('worker.handoff', r.code, r.message, { worker: this.name }), 'error');
      return;
    }
    if (!r.ok) {
      this.state = 'ready';
      // The bridge said the candidate is not current: the preview is stale (File stays off until the new one).
      if (r.code === 'handoff_unavailable' || r.code === 'handoff_source') this.stale = true;
      this.setStatus(failureText('worker.handoff', r.code, r.message, { worker: this.name, floor: this.session }), true);
      this.render();
      this.focusFirst();
      return;
    }
    this.ack = r.data as HandoffAck;
    this.state = 'filed';
    this.setStatus('');
    this.render();
    this.focusFirst();
  }

  summary(): HandoffDialogSummary {
    return {
      open: this.dialog.open,
      state: this.state,
      worker: this.id,
      candidate: this.cand?.id ?? null,
      text: this.preview?.text ?? '',
      truncated: this.preview?.truncated === true,
      title: this.preview?.title ?? '',
      stale: this.stale,
      sendHome: this.sendBox.checked,
      canSendHome: this.preview?.can_send_home === true,
      status: this.statusText,
      error: this.statusError,
      path: this.ack?.handoff.path ?? '',
    };
  }
}
