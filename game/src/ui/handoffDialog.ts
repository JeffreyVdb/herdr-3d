import './handoff.css';
import type { AgentHandoff, AgentHandoffAck, HandoffAck, HandoffCandidate, HandoffGetAck, HandoffPreviewAck, LLMHandoff, LLMHandoffAck } from '../net/protocol';
import { cacheCopy, cacheState, candidateOf, newOp, noCandidateWhy, omittedNote } from '../world/handoff';
import { coverageText, jobText, llmModeWhy, omittedText, payloadText, redactionText } from '../world/handoffLlm';
import { backdropPolicy } from './dismiss';
import { dialogChips, secretsDirOf, secretTextNodes } from './secretChips';
import { h, icon, ICON } from './dom';
import type { DialogHost } from './hire';
import { failureText } from './messages';
import type { CommandResult } from '../net/client';
import { onReviewKey, reviewButton, type Go } from './secretsFlow';

/**
 * #223: the filing dialog. A literal handoff files the worker's latest completed reply exactly as written: the preview
 * is that text (the bridge read it back from the transcript, the first 64 KiB of it), with where it comes from and an
 * optional "Send home after filing". No model is asked and nothing is sent to the worker; the send home, when ticked,
 * starts only after the handoff was filed, and the bridge checks again then whether the worker may go.
 *
 * Opened by the transcript's inline button or by F at the worker. Without a candidate it says why and offers nothing
 * else: never a summary in its place. A newer reply (or none) while it is open makes the preview stale: File is off
 * until you load the new one. One operation id per preview, so a repeated submit (a dropped connection) files once.
 *
 * #224: three ways to file, chosen here and never switched for you: "Save last message" (the literal one above, the
 * default), "Ask the agent" (the worker's own agent writes it with its handoff skill: an optional instruction, the
 * cache estimate said as an estimate, the request followed on `Worker.agent_handoff` until it is filed or fails) and
 * "Use configured LLM". Each says what happens and who receives what.
 *
 * #9: "Use configured LLM" can be chosen once LLM handoffs are on and tested (else it says exactly why, with a way to
 * Settings); it is never chosen for you. Its preview names the recipient (the model and the endpoint's host), how much
 * of the conversation goes (size, estimated tokens, what was left out and why, the coverage gaps) and what the scrub
 * took out; an optional instruction says what to focus on. The bridge writes it with the LLM, never the worker's agent;
 * the job is followed on `Worker.llm_handoff`. A failure keeps the dialog open with the reason; "Try again" is a new
 * request (a new op), and says so.
 */

export interface HandoffDialogHost extends DialogHost {
  /** Puts text on the clipboard; false when the browser refused. */
  copy(text: string): Promise<boolean>;
  /** Opens the floor's filing cabinet (after a filing, "Open the cabinet"). */
  openCabinet(floor: string, select?: number): void;
  /** #9: opens Settings at a section ("handoff-llm", "ai"). */
  openSettings?(section: string): void;
}

type State = 'none' | 'loading' | 'ready' | 'filing' | 'pending' | 'filed' | 'failed';
/** #224: how the handoff is made. */
export type HandoffMode = 'literal' | 'agent' | 'llm';

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
  /** #224 */
  mode: HandoffMode;
  canAsk: boolean;
  cannotAsk: string;
  call: string;
  instruction: string;
  cache: string;
  cacheLine: string;
  request: AgentHandoff | null;
  /** #9 */
  llmOff: string;
  llmReady: boolean;
  llmWhy: string;
  recipient: string;
  payload: string;
  coverage: string;
  redactions: string;
  job: LLMHandoff | null;
}

/** #9: how long after an LLM job failed the dialog reopens on it (later: a fresh dialog). */
const LLM_FAILED_SHOWN = 10 * 60_000;

const kb = (n: number) => (n < 1024 ? `${n} bytes` : n < 1 << 20 ? `${Math.round(n / 102.4) / 10} KB` : `${Math.round(n / 104857.6) / 10} MB`);
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const shortId = (s: string) => (s.length > 12 ? `${s.slice(0, 8)}…` : s);

export class HandoffDialog {
  private readonly dialog = h('dialog', { class: 'desk-dlg desk-dlg--handoff', 'aria-labelledby': 'ho-title', 'aria-describedby': 'ho-sub' });
  private readonly head = h('header', { class: 'dd-head' });
  private readonly body = h('div', { class: 'dd-body ho-body' });
  private readonly statusEl = h('p', { class: 'dd-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private readonly actions = h('div', { class: 'dd-actions' });
  private readonly sendBox = h('input', { type: 'checkbox', id: 'ho-send-home', 'data-key': 'send-home', 'aria-describedby': 'ho-send-hint' }) as HTMLInputElement;
  /** #224: the instruction the agent's handoff skill gets (blank: its default). */
  private readonly instrEl = h('textarea', { id: 'ho-instruction', 'data-key': 'instruction', rows: '2', maxlength: '4096', placeholder: 'summarize the conversation', 'aria-describedby': 'ho-instruction-hint' }) as HTMLTextAreaElement;
  private mode: HandoffMode = 'literal';
  /** #224: the agent preview, and the request this dialog follows. */
  private agentPv: HandoffPreviewAck | null = null;
  private req: AgentHandoff | null = null;
  /** #9: the LLM preview, and the job this dialog follows. */
  private llmPv: HandoffPreviewAck | null = null;
  private job: LLMHandoff | null = null;
  private id = '';
  private name = '';
  /** #58: the worker's floor's name (the messages, the sub line; never its id). */
  private floorName = '';
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
    // #108: the instruction's review on purpose (Ctrl/⌘+Shift+X, with the switch on), then the request.
    onReviewKey(this.instrEl, () => this.host.secrets, () => void (this.mode === 'llm' ? this.writeLlm(true) : this.mode === 'agent' ? this.ask(true) : null));
    host.secrets?.onChange(() => {
      if (this.dialog.open) this.renderActions();
    });
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
    this.floorName = this.host.store.floorName(v.worker.floor);
    this.seated = opts.seated === true;
    this.ack = null;
    this.sendBox.checked = false;
    this.instrEl.value = '';
    // A request of this worker that runs or failed: show it; else the literal save, the default.
    const a = v.worker.agent_handoff;
    const j = v.worker.llm_handoff;
    this.job = null;
    if (j && (j.state === 'running' || j.state === 'queued' || ((j.state === 'failed' || j.state === 'cancelled') && this.host.now() - j.updated_at < LLM_FAILED_SHOWN))) {
      this.mode = 'llm';
      this.req = null;
      this.job = j;
      this.cand = candidateOf(v.worker);
      this.state = j.state === 'running' || j.state === 'queued' ? 'pending' : 'failed';
      this.setStatus('');
      this.render();
    } else if (a && a.state !== 'filed') {
      this.mode = 'agent';
      this.req = a;
      this.cand = candidateOf(v.worker);
      this.state = a.state === 'failed' ? 'failed' : 'pending';
      this.setStatus('');
      this.render();
    } else {
      this.mode = 'literal';
      this.req = null;
      this.start(opts.candidate ?? candidateOf(v.worker));
    }
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
    if (c?.too_large) this.why = noCandidateWhy({ ...(v?.worker ?? { id: this.id, session: '', workspace_id: '', label: '', status: '' }), handoff: c }, this.name, true);
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
      this.setStatus(failureText('worker.handoff_preview', r.code, r.message, { worker: this.name, floor: this.floorName }), true);
      this.render();
      return;
    }
    this.preview = r.data as HandoffPreviewAck;
    this.state = 'ready';
    this.render();
    this.focusFirst();
  }

  /** #224: chooses how to file; never done for you. */
  private setMode(m: HandoffMode): void {
    if (m === this.mode || this.state === 'filing' || this.state === 'pending') return;
    this.mode = m;
    this.req = null;
    this.job = null;
    this.setStatus('');
    if (m === 'literal') {
      this.start(candidateOf(this.host.store.workers.get(this.id)));
      return;
    }
    if (m === 'llm') {
      this.startLlm();
      return;
    }
    this.cand = candidateOf(this.host.store.workers.get(this.id));
    this.agentPv = null;
    this.op = newOp();
    this.state = 'loading';
    this.render();
    void this.loadAgent();
  }

  private async loadAgent(): Promise<void> {
    const op = this.op;
    if (this.host.unsupported('worker.handoff_preview')) {
      this.state = 'failed';
      this.setStatus(failureText('worker.handoff_preview', 'unknown_command', ''), true);
      this.render();
      return;
    }
    const r = await this.host.send('worker.handoff_preview', { worker: this.id, mode: 'agent', ...(this.cand ? { candidate: this.cand.id } : {}) });
    if (op !== this.op || this.mode !== 'agent' || this.state !== 'loading' || !this.dialog.open) return;
    if (!r.ok) {
      this.state = 'failed';
      this.setStatus(failureText('worker.handoff_preview', r.code, r.message, { worker: this.name, floor: this.floorName }), true);
      this.render();
      return;
    }
    this.agentPv = r.data as HandoffPreviewAck;
    this.state = 'ready';
    this.render();
    this.focusFirst();
  }

  /** #9: the LLM preview of the worker's current candidate (the snapshot it would be written from). */
  private startLlm(): void {
    const v = this.host.store.workerView(this.id);
    this.cand = v ? candidateOf(v.worker) : null;
    this.llmPv = null;
    this.job = null;
    this.stale = false;
    this.latest = '';
    this.op = newOp();
    if (!v || !this.cand) {
      this.state = 'none';
      this.why = v ? `${this.name} has no completed turn to hand off now: an LLM handoff is written from the conversation up to its latest completed reply. Wait until its turn ends.` : `${this.name} has left.`;
      this.render();
      return;
    }
    this.state = 'loading';
    this.render();
    void this.loadLlm(this.cand);
  }

  private async loadLlm(c: HandoffCandidate): Promise<void> {
    const op = this.op;
    if (this.host.unsupported('worker.handoff_preview')) {
      this.state = 'failed';
      this.setStatus(failureText('worker.handoff_preview', 'unknown_command', ''), true);
      this.render();
      return;
    }
    const r = await this.host.send('worker.handoff_preview', { worker: this.id, mode: 'llm', candidate: c.id });
    if (op !== this.op || this.mode !== 'llm' || this.state !== 'loading' || !this.dialog.open) return;
    if (!r.ok) {
      this.state = 'failed';
      this.setStatus(failureText('worker.handoff_preview', r.code, r.message, { worker: this.name, floor: this.floorName }), true);
      this.render();
      return;
    }
    this.llmPv = r.data as HandoffPreviewAck;
    this.state = 'ready';
    this.render();
    this.focusFirst();
  }

  /** #9: the job this dialog follows changed on the worker: filed (its handoff read back), failed or cancelled. */
  private followJob(j: LLMHandoff | undefined): void {
    if (!this.job || !j || j.op !== this.job.op) return;
    const was = this.job;
    this.job = j;
    if (j.state === 'filed' && was.state !== 'filed' && j.handoff) {
      void this.loadFiled({ handoff: j.handoff, send_home_result: j.send_home_result, send_home_reason: j.send_home_reason }, j.op);
      return;
    }
    if ((j.state === 'failed' || j.state === 'cancelled') && this.state !== 'failed') {
      this.state = 'failed';
      this.setStatus('');
      this.render();
      this.focusFirst();
    }
  }

  /** #224: the request this dialog follows changed on the worker: pending, filed (its handoff read back) or failed. */
  private follow(a: AgentHandoff | undefined): void {
    if (!this.req || (a && a.op !== this.req.op)) return;
    if (!a) return;
    const was = this.req;
    this.req = a;
    if (a.state === 'filed' && was.state !== 'filed' && a.handoff) {
      void this.loadFiled({ handoff: a.handoff, send_home_result: a.send_home_result, send_home_reason: a.send_home_reason }, a.op);
      return;
    }
    if (a.state === 'failed' && this.state !== 'failed') {
      this.state = 'failed';
      this.setStatus('');
      this.render();
      this.focusFirst();
      return;
    }
    if (this.state === 'pending' && (a.state !== was.state)) this.render();
  }

  private async loadFiled(a: { handoff: number; send_home_result?: 'started' | 'skipped' | undefined; send_home_reason?: string | undefined }, op: string): Promise<void> {
    const r = await this.host.send('handoff.get', { id: a.handoff });
    if (!this.dialog.open || (this.req?.op ?? this.job?.op) !== op) return;
    if (!r.ok) {
      this.state = 'filed';
      this.ack = null;
      this.setStatus(`Filed, but it could not be read back: ${failureText('handoff.get', r.code, r.message, { floor: this.floorName })}`, true);
      this.render();
      return;
    }
    const g = r.data as HandoffGetAck;
    this.ack = { handoff: g.handoff, ...(a.send_home_result ? { send_home: a.send_home_result } : {}), ...(a.send_home_reason ? { send_home_reason: a.send_home_reason } : {}) };
    this.state = 'filed';
    this.setStatus('');
    this.render();
    this.focusFirst();
  }

  /** The world changed: the worker gone, or its reply replaced (a new turn): the preview is stale. */
  refresh(): void {
    if (!this.dialog.open) return;
    if (this.mode === 'llm') {
      const w = this.host.store.workers.get(this.id);
      if (this.job) this.followJob(w?.llm_handoff);
      if (!w && this.state !== 'filed' && this.state !== 'pending' && this.state !== 'none') {
        this.state = 'none';
        this.why = `${this.name} has left.`;
        this.render();
        return;
      }
      if (this.state === 'ready' && this.cand) {
        const now = candidateOf(w);
        const same = !!now && now.id === this.cand.id && now.revision === this.cand.revision;
        const latest = now ? `${now.id}/${now.revision}` : '';
        if (same === !this.stale && (same || latest === this.latest)) return;
        this.stale = !same;
        this.latest = latest;
        this.render();
      }
      return;
    }
    if (this.mode === 'agent') {
      const w = this.host.store.workers.get(this.id);
      if (this.req) this.follow(w?.agent_handoff);
      if (!w && this.state !== 'filed' && this.state !== 'pending' && this.state !== 'none') {
        this.state = 'none';
        this.why = `${this.name} has left.`;
        this.render();
      }
      return;
    }
    if (this.state === 'filing' || this.state === 'filed') return;
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
    const k =
      this.state === 'ready' && !this.stale && (this.mode === 'literal' || (this.mode === 'agent' && this.agentPv?.agent?.can_ask) || (this.mode === 'llm' && this.llmPv?.llm?.ready))
        ? 'file'
        : this.state === 'filed'
          ? 'done'
          : this.mode === 'llm' && this.state === 'failed' && this.job
            ? 'retry'
            : 'cancel';
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
    const sub = [this.floorName, v ? `Desk ${v.desk + 1}` : null, v?.worker.branch ?? null].filter(Boolean).join(' · ');
    this.head.replaceChildren(
      h('div', { class: 'dd-plate dd-plate--folder', 'aria-hidden': 'true' }, icon(ICON.folder)),
      h('div', { class: 'dd-titles' }, h('h2', { id: 'ho-title' }, `File a handoff from ${this.name}`), h('p', { id: 'ho-sub' }, sub)),
      h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close)),
    );
    this.body.replaceChildren(...this.bodyNodes());
    this.renderActions();
  }

  /** #224: the three ways to file, each saying what happens and who receives what. */
  private modeNodes(): Node[] {
    if (this.state === 'filing' || this.state === 'pending' || this.state === 'filed') return [];
    const w = this.host.store.workers.get(this.id);
    const who = [w?.harness || w?.agent_kind, w?.model].filter(Boolean).join(' · ');
    const llmOff = llmModeWhy(this.host.store.handoffLlm.state, this.host.store.handoffLlm.known);
    const llmModel = this.host.store.ai.state?.llm.model;
    const choices: Array<{ v: HandoffMode; label: string; hint: string; off?: boolean }> = [
      { v: 'literal', label: 'Save last message', hint: 'The last reply, as written. Nothing is sent to any model.' },
      { v: 'agent', label: 'Ask the agent', hint: `${this.name}’s agent${who ? ` (${who})` : ''} writes it; its provider reads the conversation.` },
      {
        v: 'llm',
        label: 'Use configured LLM',
        hint: `The bridge sends a reduced, scrubbed copy of the conversation to the LLM set in Settings${llmModel ? ` (${llmModel})` : ''}, not ${this.name}’s agent.${llmOff ? ` ${llmOff}` : ''}`,
        off: !!llmOff,
      },
    ];
    const set = h('fieldset', { class: 'dd-choices ho-modes', 'data-hook': 'ho-modes' }, h('legend', {}, 'How to make it'));
    for (const c of choices) {
      const input = h('input', { type: 'radio', name: 'ho-mode', value: c.v, id: `ho-mode-${c.v}`, 'data-key': `mode:${c.v}`, 'aria-describedby': `ho-mode-${c.v}-hint` }) as HTMLInputElement;
      input.checked = this.mode === c.v;
      input.disabled = !!c.off;
      input.addEventListener('change', () => input.checked && this.setMode(c.v));
      set.append(
        h(
          'label',
          { class: 'dd-choice', for: `ho-mode-${c.v}`, 'data-disabled': c.off ? 'true' : null },
          input,
          h('span', { class: 'dd-radio', 'aria-hidden': 'true' }),
          h('span', { class: 'dd-choice-text' }, h('span', {}, c.label), h('span', { class: 'field-hint', id: `ho-mode-${c.v}-hint` }, c.hint)),
        ),
      );
    }
    const out: Node[] = [set];
    if (llmOff && this.host.openSettings) {
      const where = this.host.store.handoffLlm.state?.state === 'incomplete' ? 'ai' : 'handoff-llm';
      out.push(
        h(
          'p',
          { class: 'ho-hint ho-llm-off', 'data-hook': 'ho-llm-off' },
          h('button', { type: 'button', class: 'btn btn--sm btn--quiet', 'data-key': 'llm-settings', onclick: () => (this.close(), this.host.openSettings?.(where)) }, where === 'ai' ? 'Set up the LLM' : 'Open LLM handoffs settings'),
        ),
      );
    }
    return out;
  }

  private bodyNodes(): Node[] {
    if (this.state === 'filed' && this.ack) return this.filedNodes(this.ack);
    if (this.mode === 'agent') return this.agentNodes();
    if (this.mode === 'llm') return this.llmNodes();
    if (this.state === 'none') {
      return [...this.modeNodes(), h('p', { class: 'ho-lede ho-lede--none', 'data-hook': 'ho-why' }, this.why), h('p', { class: 'ho-hint' }, 'Saving files the agent’s last completed reply as written. To get a fresh summary, choose Ask the agent.')];
    }
    const p = this.preview;
    const c = this.cand;
    const lede = h('p', { class: 'ho-lede' }, h('b', {}, 'Saved exactly as written'), ' · no AI call. The reply goes into the floor’s cabinet as Markdown, unchanged; where it came from goes in the file’s front matter.');
    if (!p || !c) return [...this.modeNodes(), lede, h('div', { class: 'dd-skeleton', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))];
    const nodes: Node[] = [...this.modeNodes(), lede];
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
    sheet.textContent = p.text ?? '';
    nodes.push(h('figure', { class: 'ho-file' }, h('figcaption', { class: 'ho-tab', title: 'The title it gets: its first heading, else its first line' }, icon(ICON.folder), h('span', { 'data-hook': 'ho-title' }, p.title ?? '')), sheet));
    const notes: string[] = [];
    if (p.truncated) notes.push(`The preview shows the first ${kb(new TextEncoder().encode(p.text ?? '').length)} of ${kb(c.bytes)}; the whole reply is filed.`);
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
        h('dd', {}, `The ${this.host.store.floorName(pr.floor)} cabinet`),
      ),
    );
    nodes.push(this.homeNode(p));
    return nodes;
  }

  /** "Send home after filing", as the preview allows it. */
  private homeNode(p: HandoffPreviewAck): Node {
    this.sendBox.disabled = !p.can_send_home || this.state === 'filing';
    if (!p.can_send_home) this.sendBox.checked = false;
    return h(
        'div',
        { class: 'ho-home', 'data-on': this.sendBox.checked ? 'true' : 'false', 'data-off': p.can_send_home ? null : 'true' },
        h('label', { class: 'dd-check', for: 'ho-send-home' }, this.sendBox, h('span', { class: 'dd-check-box', 'aria-hidden': 'true' }), h('span', {}, `Send ${this.name} home after filing`)),
        h(
          'p',
          { class: 'dd-base', id: 'ho-send-hint' },
          p.can_send_home ? 'Only once the handoff is filed; the worktree is kept. If it can’t go then, it stays and you are told why.' : `Not now: ${p.send_home_blocked ?? 'it can’t be sent home'}.`,
        ),
      );
  }

  /** #224: Ask the agent: who gets the request, the instruction, the cache estimate; then the request as it runs. */
  private agentNodes(): Node[] {
    const r = this.req;
    if (this.state === 'pending' && r) {
      const since = new Date(r.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return [
        h(
          'div',
          { class: 'dd-callout dd-callout--box ho-request', role: 'status', 'data-hook': 'ho-request' },
          h('p', {}, h('span', { class: 'tape tape--box' }, r.state === 'filing' ? 'Filing' : 'Asked'), ` since ${since}`),
          h('p', {}, `Waiting for ${this.name}’s agent to finish its turn with the handoff written. It is filed when both are done, within 10 minutes; prompting or answering ${this.name} meanwhile stops it.`),
          // #108 round 4: an instruction with protected secrets was stored with their references: chips.
          r.instruction ? h('p', { class: 'ho-hint', 'data-hook': 'ho-instruction' }, 'Instruction: ', ...secretTextNodes(r.instruction, dialogChips(secretsDirOf(this.host.store), (m, e) => this.setStatus(m, e), (t) => this.host.copy(t)))) : null,
        ),
      ];
    }
    if (this.state === 'failed' && r) {
      return [
        ...this.modeNodes(),
        h(
          'div',
          { class: 'dd-callout dd-callout--error ho-request', role: 'alert', 'data-hook': 'ho-request' },
          h('p', {}, h('span', { class: 'tape tape--needs_you' }, 'Not filed'), ` ${this.name} stays; nobody was sent home.`),
          h('p', { class: 'dd-wrap-reason', 'data-hook': 'ho-reason' }, r.reason || 'It stopped without a handoff.'),
        ),
      ];
    }
    const p = this.agentPv;
    const lede = h('p', { class: 'ho-lede' }, h('b', {}, 'Written by the agent'), ` · one request to its handoff skill; herdr-world files the result in the ${this.floorName} cabinet.`);
    if (!p || !p.agent) return [...this.modeNodes(), lede, this.state === 'loading' ? h('div', { class: 'dd-skeleton', 'aria-hidden': 'true' }, h('i'), h('i')) : null].filter((n): n is HTMLElement => !!n);
    const a = p.agent;
    const nodes: Node[] = [...this.modeNodes(), lede];
    if (!a.can_ask) nodes.push(h('div', { class: 'dd-callout dd-callout--error', role: 'note', 'data-hook': 'ho-cannot' }, h('p', {}, `${this.name}’s agent can’t be asked now: ${a.cannot_ask ?? 'unknown'}.`)));
    this.instrEl.disabled = this.state === 'filing' || !a.can_ask;
    this.instrEl.placeholder = a.instruction;
    nodes.push(
      h(
        'div',
        { class: 'dd-field ho-instruction' },
        h('label', { for: 'ho-instruction' }, 'Handoff instruction ', h('span', { class: 'dd-optional' }, 'optional')),
        this.instrEl,
        h('p', { class: 'field-hint', id: 'ho-instruction-hint' }, `Blank: “${a.instruction}”. Yours replaces it. Sent as `, h('code', {}, `${a.call ?? '/handoff'} …`), ' with where to save it.'),
      ),
    );
    const est = p.cache?.state ?? 'unknown';
    const copy = cacheCopy(p.cache?.evidence, est, this.host.store.workers.get(this.id)?.usage?.context_tokens);
    nodes.push(
      h(
        'div',
        { class: 'dd-callout ho-cache', 'data-level': est === 'warm' ? 'ok' : 'warn', role: 'note', 'data-hook': 'ho-cache', 'data-state': est },
        h('p', {}, h('span', { class: 'tape tape--idle' }, `Estimate · ${copy.label}`), ' ', copy.line),
        h('p', { class: 'ho-hint', 'data-hook': 'ho-cache-evidence' }, copy.evidence),
        this.cand ? h('button', { type: 'button', class: 'btn btn--sm btn--quiet', 'data-key': 'use-literal', onclick: () => this.setMode('literal') }, 'Save the last message instead') : null,
      ),
    );
    nodes.push(this.homeNode(p));
    return nodes;
  }

  /** #9: Use configured LLM: who receives what, the focus; then the job as it runs, or why it failed. */
  private llmNodes(): Node[] {
    const j = this.job;
    if (this.state === 'pending' && j) {
      const to = `${j.model || 'The configured LLM'}${j.host ? ` at ${j.host}` : ''}`;
      const secs = this.host.store.handoffLlm.state?.timeout_s ?? 90;
      return [
        h(
          'div',
          { class: 'dd-callout dd-callout--box ho-request', role: 'status', 'data-hook': 'ho-job', 'data-state': j.state },
          h('p', {}, h('span', { class: 'tape tape--box' }, 'Writing'), ` since ${clock(j.started_at)}`),
          h('p', {}, `${to} is writing the handoff from ${this.name}’s conversation; ${this.name} is not asked. It is filed once the answer has its title and every section, within ${secs} seconds.`),
          h('p', { class: 'ho-hint' }, 'Cancel stops the wait and files nothing; the provider may still bill a request it already received.'),
        ),
      ];
    }
    if (this.state === 'failed' && j) {
      return [
        ...this.modeNodes(),
        h(
          'div',
          { class: 'dd-callout dd-callout--error ho-request', role: 'alert', 'data-hook': 'ho-job', 'data-state': j.state },
          h('p', {}, h('span', { class: 'tape tape--needs_you' }, j.state === 'cancelled' ? 'Cancelled' : 'Not filed'), ` ${this.name} stays; nobody was sent home.`),
          h('p', { class: 'dd-wrap-reason', 'data-hook': 'ho-reason' }, jobText(j)),
        ),
      ];
    }
    if (this.state === 'none') return [...this.modeNodes(), h('p', { class: 'ho-lede ho-lede--none', 'data-hook': 'ho-why' }, this.why)];
    const lede = h(
      'p',
      { class: 'ho-lede' },
      h('b', {}, 'Written by the configured LLM'),
      ` · one request from herdr-world; ${this.name}’s agent is not asked. It is filed in the ${this.floorName} cabinet once it has a title and every section.`,
    );
    const p = this.llmPv;
    const l = p?.llm;
    if (!p || !l) return [...this.modeNodes(), lede, this.state === 'loading' ? h('div', { class: 'dd-skeleton', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')) : null].filter((n): n is HTMLElement => !!n);
    const nodes: Node[] = [...this.modeNodes(), lede];
    if (this.stale) {
      nodes.push(
        h(
          'div',
          { class: 'ho-stale', role: 'note', 'data-hook': 'ho-stale' },
          h('span', {}, `${this.name} finished another turn since this preview: the handoff would leave it out.`),
          h('button', { class: 'btn btn--sm', 'data-key': 'reload', onclick: () => this.startLlm() }, 'Read it again'),
        ),
      );
    }
    if (!l.ready) nodes.push(h('div', { class: 'dd-callout dd-callout--error', role: 'note', 'data-hook': 'ho-llm-cannot' }, h('p', {}, `It can’t be written now: ${l.unavailable ?? 'LLM handoffs are not available'}.`)));
    const omitted = omittedText(l);
    const red = redactionText(l.redactions);
    const sess = p.provenance.session;
    nodes.push(
      h(
        'dl',
        { class: 'ho-prov ho-llm-prov', 'data-hook': 'ho-llm-prov' },
        h('dt', {}, 'To'),
        h('dd', { 'data-hook': 'ho-recipient' }, h('b', {}, l.model || 'the configured model'), ` at ${l.host || 'the configured endpoint'}`),
        l.reduced ? h('dt', {}, 'Sends') : null,
        l.reduced ? h('dd', { 'data-hook': 'ho-payload' }, payloadText(l)) : null,
        l.reduced ? h('dt', {}, 'Covers') : null,
        l.reduced ? h('dd', { 'data-hook': 'ho-coverage' }, coverageText(l), omitted.length ? h('span', { class: 'ho-hint ho-llm-omitted' }, ` Left out: ${omitted.join('; ')}.`) : null) : null,
        l.reduced && l.coverage.gaps.length ? h('dt', {}, 'Gaps') : null,
        l.reduced && l.coverage.gaps.length ? h('dd', { 'data-hook': 'ho-gaps' }, l.coverage.gaps.join('; ')) : null,
        l.reduced ? h('dt', {}, 'Scrubbed') : null,
        l.reduced ? h('dd', { 'data-hook': 'ho-redactions' }, red ? `Removed before sending: ${red}.` : 'Nothing matched the secret patterns.') : null,
        h('dt', {}, 'From'),
        h('dd', {}, `${this.name}’s conversation up to its latest completed reply${sess ? ` · session ${shortId(sess)}` : ''}`),
        h('dt', {}, 'Into'),
        h('dd', {}, `The ${this.host.store.floorName(p.provenance.floor)} cabinet`),
      ),
    );
    nodes.push(
      h(
        'details',
        { class: 'ho-llm-sent', 'data-hook': 'ho-llm-sent' },
        h('summary', {}, 'What is sent'),
        h('ul', {}, ...l.categories.map((c) => h('li', {}, c))),
        h('p', { class: 'ho-hint' }, `Secrets are removed by pattern, which can miss one. Prompt ${l.prompt_version}; the reply may take up to ${l.timeout_s} seconds and ${l.max_tokens.toLocaleString('en-US')} tokens.`),
      ),
    );
    this.instrEl.disabled = this.state === 'filing' || !l.ready;
    this.instrEl.placeholder = 'e.g. what is left to verify before the PR';
    nodes.push(
      h(
        'div',
        { class: 'dd-field ho-instruction' },
        h('label', { for: 'ho-instruction' }, 'What to focus on ', h('span', { class: 'dd-optional' }, 'optional')),
        this.instrEl,
        h('p', { class: 'field-hint', id: 'ho-instruction-hint' }, 'Sent to the LLM as data beside the conversation, scrubbed the same way; never kept in the audit log.'),
      ),
    );
    nodes.push(this.homeNode(p));
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
      h('p', { class: 'ho-lede' }, a.existing ? 'Already in the cabinet: this reply was filed before, so nothing was filed twice.' : `In the ${this.host.store.floorName(a.handoff.floor)} cabinet as “${a.handoff.title}”.`),
      h('div', { class: 'ho-where' }, path, h('button', { class: 'btn btn--sm', 'data-key': 'copy', onclick: () => void this.copyPath(a.handoff.path) }, 'Copy path')),
    ];
    if (this.mode === 'llm' && this.job?.model) out.push(h('p', { class: 'ho-hint', 'data-hook': 'ho-written-by' }, `Written by ${this.job.model}${this.job.host ? ` at ${this.job.host}` : ''}; ${this.name} was not asked.`));
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
    const settled = (this.mode === 'agent' && this.state === 'failed' && this.req) || (this.mode === 'llm' && this.state === 'failed' && this.job);
    const cancel = h('button', { class: 'btn', 'data-key': 'cancel', onclick: () => this.close() }, this.state === 'none' || this.state === 'pending' || settled ? 'Close' : 'Cancel');
    if (this.mode === 'agent') {
      this.agentActions(cancel);
      return;
    }
    if (this.mode === 'llm') {
      this.llmActions(cancel);
      return;
    }
    if (this.state === 'none') {
      this.actions.replaceChildren(cancel);
      return;
    }
    const why = this.state === 'loading' ? 'Reading the reply…' : this.stale ? 'The reply changed: show the latest one first' : this.state === 'failed' && !this.preview ? 'The reply could not be read' : '';
    const label = filing ? 'Filing…' : this.sendBox.checked ? 'File, then send home' : 'File handoff';
    const file = h('button', { class: 'btn btn--primary', 'data-key': 'file', 'aria-disabled': why || filing ? 'true' : null, title: why || null, onclick: () => void this.file() }, icon(ICON.folder), label);
    this.actions.replaceChildren(cancel, file);
  }

  /** #224: Ask (then send home); a running request can be cancelled, a failed one asked again (a new request). */
  private agentActions(cancel: HTMLElement): void {
    const r = this.req;
    if (this.state === 'pending' && r) {
      const off = r.state === 'filing';
      this.actions.replaceChildren(cancel, h('button', { class: 'btn btn--danger-quiet', 'data-key': 'cancel-request', 'aria-disabled': off ? 'true' : null, title: off ? 'It is being filed' : null, onclick: () => void this.cancelRequest() }, 'Cancel request'));
      return;
    }
    if (this.state === 'failed' && r) {
      this.actions.replaceChildren(
        cancel,
        h('button', { class: 'btn btn--quiet', 'data-key': 'dismiss', onclick: () => void this.cancelRequest() }, 'Dismiss'),
        h('button', { class: 'btn btn--primary', 'data-key': 'ask-again', onclick: () => this.askAgain() }, 'Ask again'),
      );
      return;
    }
    const a = this.agentPv?.agent;
    const why = this.state === 'loading' ? 'Looking up its handoff skill…' : !a ? 'The agent can’t be asked' : !a.can_ask ? (a.cannot_ask ?? 'It can’t be asked now') : '';
    const label = this.state === 'filing' ? 'Asking…' : this.sendBox.checked ? 'Ask, then send home' : 'Ask the agent';
    const ask = h('button', { class: 'btn btn--primary', 'data-key': 'file', 'aria-disabled': why || this.state === 'filing' ? 'true' : null, title: why || null, onclick: () => void this.ask() }, icon(ICON.folder), label);
    const review = reviewButton(this.host.secrets, why || (this.state === 'filing' ? 'Asking…' : null), () => void this.ask(true), 'instruction');
    this.actions.replaceChildren(...[cancel, review, ask].filter((x): x is HTMLButtonElement => !!x));
  }

  /** #9: Write (then send home); a running job can be cancelled, a failed one tried again (a new request). */
  private llmActions(cancel: HTMLElement): void {
    const j = this.job;
    if (this.state === 'pending' && j) {
      this.actions.replaceChildren(cancel, h('button', { class: 'btn btn--danger-quiet', 'data-key': 'cancel-request', onclick: () => void this.cancelJob() }, 'Cancel request'));
      return;
    }
    if (this.state === 'failed' && j) {
      this.actions.replaceChildren(
        cancel,
        h('button', { class: 'btn btn--quiet', 'data-key': 'dismiss', onclick: () => void this.cancelJob() }, 'Dismiss'),
        h('button', { class: 'btn btn--primary', 'data-key': 'retry', title: 'Reads the conversation again and sends a new request to the LLM', onclick: () => this.startLlm() }, 'Try again (new request)'),
      );
      return;
    }
    if (this.state === 'none') {
      this.actions.replaceChildren(cancel);
      return;
    }
    const l = this.llmPv?.llm;
    const why =
      this.state === 'loading'
        ? 'Reading the conversation…'
        : this.stale
          ? 'Another turn finished: read it again first'
          : !l
            ? 'The preview could not be read'
            : !l.ready
              ? (l.unavailable ?? 'It can’t be written now')
              : '';
    const label = this.state === 'filing' ? 'Sending…' : this.sendBox.checked ? 'Write, then send home' : 'Write with the LLM';
    const write = h('button', { class: 'btn btn--primary', 'data-key': 'file', 'aria-disabled': why || this.state === 'filing' ? 'true' : null, title: why || null, onclick: () => void this.writeLlm() }, icon(ICON.folder), label);
    const review = reviewButton(this.host.secrets, why || (this.state === 'filing' ? 'Sending…' : null), () => void this.writeLlm(true), 'instruction');
    this.actions.replaceChildren(...[cancel, review, write].filter((x): x is HTMLButtonElement => !!x));
  }

  /**
   * #108 round 4: the instruction's review (with the switch on, or `manual`: "Review secrets"), then `send` with it (a
   * stale review is reviewed again). A blank instruction is the default one: nothing to review. Null: kept (said here).
   */
  private async reviewed(instruction: string, manual: boolean, send: (g: Go) => Promise<CommandResult>): Promise<CommandResult | null> {
    const flow = this.host.secrets;
    const req = { key: this.id, text: instruction, target: this.name, manual };
    let go: Go = { kind: 'send', protects: 0, shown: instruction, review: null };
    const gen = this.gen;
    const kept = (why: string, message: string) => {
      if (gen !== this.gen) return null;
      this.state = 'ready';
      this.setStatus(why === 'cancel' ? 'Not sent: the instruction is still here.' : message, why === 'failed');
      this.render();
      this.instrEl.focus();
      return null;
    };
    if (manual && !instruction) return kept('failed', 'Write an instruction first, then review its secrets.');
    if (instruction && flow && (flow.on || manual)) {
      const out = await flow.review(req);
      if (out.kind === 'kept') return kept(out.why, out.message);
      go = out;
    }
    if (!flow || !instruction) return send(go);
    const d = await flow.deliver(req, go, send);
    return d.kind === 'kept' ? kept(d.why, d.message) : d.result;
  }

  private async writeLlm(manual = false): Promise<void> {
    const c = this.cand;
    const l = this.llmPv?.llm;
    if (!c || !l?.ready || this.stale || this.state !== 'ready') return;
    const gen = this.gen;
    this.state = 'filing';
    this.setStatus(`Sending to ${l.model || 'the LLM'}…`);
    this.render();
    const instruction = this.instrEl.value.trim();
    const r = await this.reviewed(instruction, manual, (g) =>
      this.host.send('worker.handoff', {
        worker: this.id,
        mode: 'llm',
        session: c.session,
        candidate: c.id,
        revision: c.revision,
        op: this.op,
        ...(instruction ? { instruction } : {}),
        ...(this.sendBox.checked ? { send_home: true } : {}),
        ...(g.secrets ? { secrets: g.secrets } : {}),
      }),
    );
    if (!r) return;
    if (gen !== this.gen) {
      if (!r.ok) this.host.toast(failureText('worker.handoff', r.code, r.message, { worker: this.name }), 'error');
      return;
    }
    if (!r.ok) {
      this.state = 'ready';
      if (r.code === 'handoff_unavailable' || r.code === 'handoff_source') this.stale = true;
      this.setStatus(failureText('worker.handoff', r.code, r.message, { worker: this.name, floor: this.floorName }), true);
      this.render();
      this.focusFirst();
      return;
    }
    const ack = r.data as LLMHandoffAck;
    this.job = ack.job;
    this.setStatus('');
    if (ack.job.state === 'filed' && ack.job.handoff) {
      this.state = 'pending';
      void this.loadFiled({ handoff: ack.job.handoff, send_home_result: ack.job.send_home_result, send_home_reason: ack.job.send_home_reason }, ack.job.op);
      return;
    }
    this.state = ack.job.state === 'failed' || ack.job.state === 'cancelled' ? 'failed' : 'pending';
    this.render();
    this.focusFirst();
    this.followJob(this.host.store.workers.get(this.id)?.llm_handoff);
  }

  private async cancelJob(): Promise<void> {
    const j = this.job;
    if (!j) return;
    // A settled job is dismissed, a running one cancelled (its update may come before the ack).
    const dismiss = this.state === 'failed';
    const res = await this.host.send('worker.handoff_cancel', { worker: this.id, op: j.op });
    if (!this.dialog.open || this.job?.op !== j.op) return;
    if (!res.ok) {
      this.setStatus(failureText('worker.handoff_cancel', res.code, res.message, { worker: this.name }), true);
      return;
    }
    if (dismiss) {
      // Dismissed: back to a fresh preview (nothing is sent until you write).
      this.startLlm();
      return;
    }
    this.followJob(res.data as LLMHandoff);
    this.followJob(this.host.store.workers.get(this.id)?.llm_handoff);
  }

  private async ask(manual = false): Promise<void> {
    const a = this.agentPv?.agent;
    if (!a?.can_ask || this.state !== 'ready') return;
    const gen = this.gen;
    this.state = 'filing';
    this.setStatus(`Asking ${this.name}’s agent…`);
    this.render();
    const instruction = this.instrEl.value.trim();
    const r = await this.reviewed(instruction, manual, (g) =>
      this.host.send('worker.handoff', { worker: this.id, mode: 'agent', op: this.op, ...(instruction ? { instruction } : {}), ...(this.sendBox.checked ? { send_home: true } : {}), ...(g.secrets ? { secrets: g.secrets } : {}) }),
    );
    if (!r) return;
    if (gen !== this.gen) {
      if (!r.ok) this.host.toast(failureText('worker.handoff', r.code, r.message, { worker: this.name }), 'error');
      return;
    }
    if (!r.ok) {
      this.state = 'ready';
      this.setStatus(failureText('worker.handoff', r.code, r.message, { worker: this.name, floor: this.floorName }), true);
      this.render();
      this.focusFirst();
      return;
    }
    const ack = r.data as AgentHandoffAck;
    this.req = ack.request;
    this.state = ack.request.state === 'failed' ? 'failed' : 'pending';
    this.setStatus('');
    this.render();
    this.follow(this.host.store.workers.get(this.id)?.agent_handoff);
    if (ack.request.state === 'filed' && ack.request.handoff) {
      const q = ack.request;
      void this.loadFiled({ handoff: q.handoff as number, send_home_result: q.send_home_result, send_home_reason: q.send_home_reason }, q.op);
    }
  }

  private async cancelRequest(): Promise<void> {
    const r = this.req;
    if (!r) return;
    const res = await this.host.send('worker.handoff_cancel', { worker: this.id, op: r.op });
    if (!this.dialog.open || this.req?.op !== r.op) return;
    if (!res.ok) {
      this.setStatus(failureText('worker.handoff_cancel', res.code, res.message, { worker: this.name }), true);
      return;
    }
    if (this.state === 'failed') {
      // Dismissed: back to a fresh ask.
      this.askAgain();
      return;
    }
    this.req = res.data as AgentHandoff;
    this.state = 'failed';
    this.render();
  }

  /** A new request (a new op): the failed one stays as it was. */
  private askAgain(): void {
    this.req = null;
    this.mode = 'literal';
    this.setMode('agent');
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
      this.setStatus(failureText('worker.handoff', r.code, r.message, { worker: this.name, floor: this.floorName }), true);
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
      canSendHome: (this.mode === 'llm' ? this.llmPv : this.mode === 'agent' ? this.agentPv : this.preview)?.can_send_home === true,
      status: this.statusText,
      error: this.statusError,
      path: this.ack?.handoff.path ?? '',
      mode: this.mode,
      canAsk: this.agentPv?.agent?.can_ask === true,
      cannotAsk: this.agentPv?.agent?.cannot_ask ?? '',
      call: this.agentPv?.agent?.call ?? '',
      instruction: this.instrEl.value,
      cache: this.agentPv?.cache?.state ?? '',
      cacheLine: this.body.querySelector('[data-hook="ho-cache"]')?.textContent ?? '',
      request: this.req,
      llmOff: llmModeWhy(this.host.store.handoffLlm.state, this.host.store.handoffLlm.known),
      llmReady: this.llmPv?.llm?.ready === true,
      llmWhy: this.llmPv?.llm?.unavailable ?? '',
      recipient: this.body.querySelector('[data-hook="ho-recipient"]')?.textContent ?? '',
      payload: this.body.querySelector('[data-hook="ho-payload"]')?.textContent ?? '',
      coverage: this.body.querySelector('[data-hook="ho-coverage"]')?.textContent ?? '',
      redactions: this.body.querySelector('[data-hook="ho-redactions"]')?.textContent ?? '',
      job: this.job,
    };
  }
}
