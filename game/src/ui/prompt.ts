import type { PromptAck } from '../net/protocol';
import { CHIP_TEXT, modelText } from '../world/derive';
import { promptBlocker, promptTextError, willQueue } from '../world/prompt';
import { h, icon, ICON } from './dom';
import type { DialogHost } from './hire';
import { failureText } from './messages';
import { backdropPolicy } from './dismiss';
// #64 composer
import { mountComposer, type Composer } from './composer/composer';
import { Draft as PromptDraft, type Uploader } from './composer/draft';
import { failedImagesText, hasContent, heldRefusalText, markedText, notSentText, PASTE_HINT } from './composer/field';
import { WORKER_PROMPT_MAX_BYTES } from './composer/model';
import { HANDOVER_STALE, packupAction, packupStep, type PackupCheck } from './packupSend';
import { reviewKey, type Go } from './secretsFlow';
import { keyName } from '../input/shortcuts';
// #39 completion
import { CommandCatalogs } from '../laptop/commandCatalog';
import { CompletionScope, workerSources } from './dialogCompletion';

/** The overlay's host: the dialogs' plus one image to Drop Zone through the bridge (#64). */
export interface PromptHost extends DialogHost {
  upload: Uploader;
  /** #110: the pack-up check before a prompt goes (none: it goes at once). */
  packup?: PackupCheck;
  /** #39: the app's lists of commands and skills, shared with the transcript (absent: the overlay keeps its own). */
  catalogs?: CommandCatalogs;
}

/**
 * P, the prompt overlay (M5): look at a worker, press P, write, Enter. It
 * sends `worker.prompt` and stays open on the result — sent, queued (the
 * worker was mid-turn: its agent takes it next), sent after one more Enter,
 * or why it failed — with the worker's live status in the header, so you
 * can watch it pick the prompt up and follow up. The note is the shared
 * composer (#13, #64): paste a screenshot and it sits in the text as a chip,
 * the agent gets `[Image #n: <path>]` in its place. Each worker keeps its own
 * unsent draft (text, images, their uploads) while the overlay is closed. The
 * note you write is a speech bubble like the workers' own cards: yours, to them.
 *
 * #110: with pack up on request on, Send first asks whether the prompt also tells the worker to leave ("checking…",
 * the note kept and read-only, Esc cancels the send); a match opens its confirm over this overlay.
 *
 * #108: with "Review prompt secrets before sending" on, Send first scans the prompt for possible secrets
 * (`secretsFlow.ts`), before pack up's check; anything found opens the review over this overlay, and nothing goes
 * before its Confirm. "Review secrets" (Ctrl/⌘+Shift+X) opens it on purpose, to mark a value the scan missed. A prompt
 * that protects anything skips pack up's check in round 3 (its LLM would read the value). The note stays in memory.
 */

export type PromptState = 'ready' | 'checking' | 'reviewing' | 'sending' | 'sent' | 'failed';

export interface PromptResult {
  queued: boolean;
  retried: boolean;
}

/** What the prompt overlay shows (test hook, via `window.__h3d.panel()`). */
export interface PromptSummary {
  kind: 'prompt';
  id: string;
  name: string;
  /** The worker's status as shown in the header. */
  display: string;
  state: PromptState;
  /** The note as typed: each image a `[Image #n: <path>]` marker once it is uploaded, a bare `[Image #n]` before. */
  text: string;
  /** The images in the note (test hook). */
  images: Array<{ n: number; name: string; status: string; path: string | null }>;
  /** The "queued" chip is up (the worker is working, or the ack said so). */
  queued: boolean;
  result: PromptResult | null;
  /** Why Send is off, null when it can be pressed. */
  blocker: string | null;
  status: string;
  error: boolean;
  confirm: null;
}

/** The note's plate: a white speech bubble, the cards' own shape. */
const BUBBLE = '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5h-7l-4 3.5V16H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z"/><path d="M8 9.5h8M8 12.5h5"/>';

export class PromptOverlay {
  private readonly dialog = h('dialog', { class: 'desk-dlg desk-dlg--prompt', 'aria-labelledby': 'prompt-title', 'aria-describedby': 'prompt-sub' });
  private readonly head = h('header', { class: 'dd-head' });
  private readonly form = h('form', { class: 'dd-body pr-body', id: 'prompt-form', novalidate: true });
  private readonly composer: Composer;
  private readonly chip = h('p', { class: 'pr-queued', 'data-key': 'queued-chip' });
  private readonly statusEl = h('p', { class: 'dd-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private readonly actions = h('div', { class: 'dd-actions' });
  private id = '';
  private name = '';
  private state: PromptState = 'ready';
  private result: PromptResult | null = null;
  private statusText = '';
  private statusError = false;
  /** Unsent note per worker (text, images, their uploads), kept when the overlay closes; a send clears only what it sent. */
  private readonly drafts = new Map<string, PromptDraft>();
  /** The revision of the shown draft last seen: a change of the note (not an image's upload state) steps a result back. */
  private seen = 0;
  private gen = 0;
  /** #110: the pack-up check of the prompt being sent (aborted: Esc, the overlay closed). */
  private checking: AbortController | null = null;
  private headKey = '';
  /** #39: `/`, `@` and `@r:` of the worker the overlay is for, as its transcript has them (`dialogCompletion.ts`). */
  private ownCatalogs: CommandCatalogs | null = null;
  private lookupFor: { id: string; harness: string | undefined } | null = null;
  private readonly lookups = new CompletionScope(
    () => {
      if (!this.dialog.open || !this.id) return (this.lookupFor = null);
      this.lookupFor = { id: this.id, harness: this.host.store.workerView(this.id)?.harness };
      return JSON.stringify(['worker', this.lookupFor.id, this.lookupFor.harness ?? '']);
    },
    () => {
      const host = this.host;
      const l = this.lookupFor as { id: string; harness: string | undefined };
      return workerSources(
        { send: host.send.bind(host), catalogs: host.catalogs ?? (this.ownCatalogs ??= new CommandCatalogs({ send: (t, args) => host.send(t, args) })), repoRefs: host.store.repoRefs, repoDiscovery: host.store.repoDiscovery, floorName: (id) => host.store.floorName(id) },
        l.id,
        l.harness,
      );
    },
  );

  constructor(
    parent: HTMLElement,
    private readonly host: PromptHost,
  ) {
    this.alertEl.hidden = this.statusEl.hidden = true;
    this.composer = mountComposer({
      draft: this.newDraft(''),
      labelledBy: 'prompt-label',
      describedBy: 'prompt-keys',
      submitPolicy: 'enter',
      onSubmit: () => void this.send(),
      // Inside the form, which scrolls (and would clip it): above the caret when below has no room.
      complete: { sources: this.lookups.sources, bounds: () => this.form },
      onChange: (s) => {
        // Writing the next one: the last result steps back (and the "Will queue" chip is up again while it works).
        if (s.revision === this.seen) return;
        this.seen = s.revision;
        if (this.state === 'sent' || this.state === 'failed') {
          this.state = 'ready';
          this.render();
        }
      },
    });
    // The note takes the textarea's hooks: the label, the tests and the focus keys all know `#prompt-text`.
    this.composer.editor.id = 'prompt-text';
    this.composer.editor.dataset.key = 'text';
    this.form.append(
      h('label', { class: 'visually-hidden', id: 'prompt-label' }, 'Prompt'),
      h('div', { class: 'pr-note' }, this.composer.element),
      h(
        'p',
        { class: 'pr-keys field-hint', id: 'prompt-keys' },
        h('kbd', {}, 'Enter'),
        ' sends · ',
        h('kbd', {}, 'Shift'),
        '+',
        h('kbd', {}, 'Enter'),
        ` new line · ${PASTE_HINT} · `,
        h('kbd', {}, 'Esc'),
        ' closes',
      ),
    );
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.send();
    });
    // #108: the review of the prompt's secrets, now (with the switch on).
    this.form.addEventListener('keydown', (e) => {
      if (!reviewKey(e) || !this.host.secrets?.on) return;
      e.preventDefault();
      if (!e.repeat) void this.send(true);
    });
    host.secrets?.onChange(() => {
      if (this.dialog.open) this.renderActions();
    });
    this.dialog.append(this.head, this.form, h('footer', { class: 'dd-foot' }, this.chip, this.statusEl, this.alertEl, this.actions));
    // Closing makes a send still on its way answer in a toast (and keep a newer draft). Esc and close() count at
    // once: the 'close' event comes a task later, when P may have opened the overlay again, so it counts, and
    // lets go of the focus, only while the overlay is still shut.
    // #110: Esc while the prompt is being checked cancels the send and keeps the overlay (the first listener: the
    // ones below would count it as a close).
    this.dialog.addEventListener('cancel', (e) => {
      if (!this.checking) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.cancelCheck();
    });
    this.dialog.addEventListener('cancel', () => this.gen++);
    this.dialog.addEventListener('close', () => {
      if (!this.dialog.open) this.gen++;
    });
    // Closed, the note must not keep focus: the next key is the game's again.
    const letGo = () => {
      if (this.dialog.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    };
    this.dialog.addEventListener('cancel', letGo);
    this.dialog.addEventListener('close', () => {
      if (!this.dialog.open) letGo();
    });
    // #51: typed text or a consequential choice in here: only the close button and Esc close it, never the backdrop.
    backdropPolicy(this.dialog, 'none');
    parent.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  /** The worker the overlay is for (null when closed). */
  get worker(): string | null {
    return this.dialog.open ? this.id : null;
  }

  /** A worker's note: images upload with a hint that names the worker, so files of different notes tell apart. */
  private newDraft(id: string): PromptDraft {
    return new PromptDraft({ upload: (f, hint, signal) => this.host.upload(f, hint, signal), label: () => `prompt-${this.host.store.workerView(id)?.name ?? 'worker'}`, maxPromptBytes: WORKER_PROMPT_MAX_BYTES, holdRefused: true });
  }

  private draftOf(id: string): PromptDraft {
    let d = this.drafts.get(id);
    if (!d) {
      d = this.newDraft(id);
      this.drafts.set(id, d);
    }
    return d;
  }

  /**
   * #210: a background hire's first task that did not reach its worker becomes that worker's note, to send by hand (P).
   * Only into an empty note (what was typed there stays); images of `from` that went up come along as chips, not uploaded
   * again. True when the note holds it now.
   */
  holdTask(workerId: string, text: string, from?: PromptDraft): boolean {
    const d = this.draftOf(workerId);
    if (hasContent(d.snapshot())) return false;
    d.replaceAll(text, from);
    return true;
  }

  /** #110: drops the pack-up check under way: nothing is sent, the note stays. */
  private cancelCheck(): void {
    const c = this.checking;
    if (!c) return;
    c.abort();
    this.checking = null;
    if (this.state === 'checking') this.state = 'ready';
    this.setStatus('Not sent: the prompt is still here.');
    this.render();
    this.composer.focus();
  }

  close(): void {
    this.checking?.abort();
    this.checking = null;
    if (!this.dialog.open) return;
    if (this.dialog.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    this.gen++;
    this.dialog.close();
  }

  open(workerId: string): void {
    const v = this.host.store.workerView(workerId);
    if (!v) return;
    if (this.id !== workerId || !this.dialog.open) {
      this.state = 'ready';
      this.result = null;
      this.setStatus('');
    }
    this.id = workerId;
    this.name = v.name;
    const draft = this.draftOf(workerId);
    this.composer.setDraft(draft);
    this.seen = draft.revision;
    this.composer.setPlaceholder(`What should ${v.name} do next?`);
    this.headKey = '';
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.composer.focus();
  }

  private blocker(): string | null {
    const v = this.host.store.workerView(this.id);
    const f = v ? this.host.store.floorView(v.worker.floor) : null;
    return promptBlocker(v, f, this.host.unsupported('worker.prompt'));
  }

  /** The world changed: the header's status, the queued chip, whether it can still be sent. */
  refresh(): void {
    if (!this.dialog.open) return;
    if (!this.host.store.workers.has(this.id)) {
      const gone = this.drafts.get(this.id);
      this.drafts.delete(this.id);
      this.close();
      gone?.dispose();
      this.host.toast(`${this.name} has left the floor.`, 'info');
      return;
    }
    this.render();
  }

  /** The status line; `tape` leads it with a result chip (`Sent`, `Queued`). */
  private setStatus(msg: string, error = false, tape: { text: string; kind: string } | null = null): void {
    this.statusText = msg;
    this.statusError = error;
    this.alertEl.hidden = !error || !msg;
    this.statusEl.hidden = error || !msg;
    (error ? this.alertEl : this.statusEl).textContent = msg;
    (error ? this.statusEl : this.alertEl).textContent = '';
    if (tape && !error && msg) {
      const rest = msg.replace(/^[^:]*:\s*/, '');
      this.statusEl.replaceChildren(h('span', { class: 'pr-result' }, h('span', { class: `tape tape--${tape.kind}` }, tape.text), rest));
    }
  }

  private render(): void {
    // #39: another worker (or the same one's harness now known): an open popup follows it.
    this.lookups.check();
    const v = this.host.store.workerView(this.id);
    if (!v) return;
    const f = this.host.store.floorView(v.worker.floor);
    const sub = [`Desk ${v.desk + 1}`, this.host.store.floorName(v.worker.floor), modelText(v.harness, v.worker.model, v.worker.effort, this.host.store.hireOptions) || null].filter(Boolean).join(' · ');
    const key = JSON.stringify([v.name, sub, v.display]);
    if (key !== this.headKey) {
      this.headKey = key;
      this.head.replaceChildren(
        h('div', { class: 'dd-plate dd-plate--bubble', 'aria-hidden': 'true' }, icon(BUBBLE)),
        h('div', { class: 'dd-titles' }, h('h2', { id: 'prompt-title' }, `Prompt ${v.name}`), h('p', { id: 'prompt-sub' }, sub)),
        h('span', { class: `tape tape--${v.display}`, 'data-key': 'status', title: `${v.name} is ${CHIP_TEXT[v.display].toLowerCase()} right now` }, CHIP_TEXT[v.display]),
        h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close)),
      );
    }
    const blocker = promptBlocker(v, f, this.host.unsupported('worker.prompt'));
    // Up front while it works (its agent queues the prompt for the next turn); after a send, as the ack said.
    // After a send the status line says how it went; before one, the chip says it will wait for the turn.
    this.chip.hidden = this.state === 'sent' || !willQueue(v) || !!blocker;
    this.chip.replaceChildren(
      h('span', { class: 'tape tape--working' }, 'Will queue'),
      ` ${v.name} is working: ${v.harness === 'codex' ? 'Codex' : v.harness === 'claude' ? 'Claude' : 'the agent'} takes this on its next turn.`,
    );
    if (blocker) this.setStatus(blocker, true);
    else if (this.statusError && this.state !== 'failed') this.setStatus('');
    this.composer.setBusy(this.busy);
    this.renderActions();
  }

  /** A send is on its way, checked or reviewed: the note is read-only, Send does nothing. */
  private get busy(): boolean {
    return this.state === 'sending' || this.state === 'checking' || this.state === 'reviewing';
  }

  private renderActions(): void {
    const blocker = this.blocker();
    const why = this.state === 'sending' ? 'On its way…' : this.state === 'checking' ? 'Checking the prompt…' : this.state === 'reviewing' ? 'Reviewing its secrets…' : blocker;
    const had = document.activeElement instanceof HTMLElement && this.actions.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const close = h('button', { class: 'btn', 'data-key': 'cancel', onclick: () => this.close() }, 'Close');
    // #108: with the switch on, the review on purpose: to mark a value the scan would not find.
    const review = this.host.secrets?.on
      ? h(
          'button',
          {
            class: 'btn',
            'data-key': 'review',
            'aria-disabled': why ? 'true' : null,
            title: why ?? `Look over the prompt’s possible secrets now, and mark one the scan missed (${keyName('dialog.secrets')})`,
            onclick: () => {
              if (!this.busy && !this.blocker()) void this.send(true);
            },
          },
          'Review secrets',
        )
      : null;
    const send = h(
      'button',
      { class: 'btn btn--primary', type: 'submit', form: 'prompt-form', 'data-key': 'send', 'aria-disabled': why ? 'true' : null, 'aria-busy': this.busy ? 'true' : null, title: why },
      this.state === 'sending' ? 'Sending…' : this.state === 'checking' ? 'Checking…' : this.state === 'reviewing' ? 'Reviewing…' : `Send to ${this.name}`,
    );
    this.actions.replaceChildren(close, ...(review ? [review] : []), send);
    if (had) this.actions.querySelector<HTMLElement>(`[data-key="${had}"]`)?.focus();
  }

  /** `manual` (#108): "Review secrets": the review opens even when the scan finds nothing. */
  private async send(manual = false): Promise<void> {
    if (this.busy) return;
    const blocker = this.blocker();
    if (blocker) {
      this.setStatus(blocker, true);
      return;
    }
    const id = this.id;
    const name = this.name;
    const gen = this.gen;
    const draft = this.draftOf(id);
    const snap = draft.snapshot();
    // Nothing to send, or an image that did not upload: say so before anything goes (each chip has its Retry).
    // A file the note refused stays held until dismissed: the note does not go without the picture meant for it.
    const empty = heldRefusalText(snap, { nothing: 'sent', again: 'send' }) ?? (!hasContent(snap) ? 'Write something first.' : failedImagesText(snap));
    if (empty) {
      this.setStatus(empty, true);
      this.composer.focus();
      return;
    }
    this.state = 'sending';
    this.result = null;
    this.setStatus(snap.uploading ? `Uploading the images, then sending to ${name}…` : `Sending to ${name}…`);
    this.render();
    // Waits for the images that are still on their way (read-only meanwhile); never sends a partial prompt.
    const res = await draft.resolve({ maxBytes: WORKER_PROMPT_MAX_BYTES });
    const bad = res.ok ? promptTextError(res.text) : null;
    const stillHere = () => this.dialog.open && gen === this.gen && this.id === id;
    if (!res.ok || bad) {
      const msg = res.ok ? (bad as string) : notSentText(res, { nothing: 'sent', again: 'send' });
      if (!res.ok && res.reason === 'disposed') return;
      // A send that outlived its overlay (closed, maybe reopened for another worker) only toasts: the overlay's state,
      // busy flag and composer belong to whatever is on screen now, which may have a send of its own in flight.
      if (!stillHere()) {
        this.host.toast(msg, 'error');
        return;
      }
      this.state = 'failed';
      this.setStatus(msg, true);
      this.render();
      this.composer.focus();
      return;
    }
    // #108: first its possible secrets, before anything else reads the text (pack up's LLM included: round 4 gives it
    // the references, so its review says "Confirm and continue").
    const flow = this.host.secrets;
    const check = this.host.packup;
    const req = { key: id, text: res.text, target: name, manual, action: packupAction(check, id) };
    let go: Go = { kind: 'send', protects: 0, shown: res.text, review: null };
    if (flow && (flow.on || manual)) {
      if (!stillHere()) return;
      this.state = 'reviewing';
      this.setStatus(manual ? 'Opening the review of its secrets…' : 'Looking for secrets in the prompt…');
      this.render();
      const out = await flow.review(req);
      if (!stillHere()) return; // closed meanwhile (the worker left): nothing is sent
      if (out.kind === 'kept') {
        this.kept(out.why, out.message);
        return;
      }
      go = out;
      this.state = 'sending';
      this.setStatus(`Sending to ${name}…`);
      this.render();
    }
    // #110: whether it also tells the worker to leave (with the review: the check reads the protected values' references).
    let handover: { text: string; pending: string } | null = null;
    if (check && stillHere() && check.applies(id)) {
      const abort = new AbortController();
      this.checking = abort;
      this.state = 'checking';
      this.setStatus('Checking the prompt…');
      this.render();
      const step = await packupStep(check, flow, req, go, abort.signal);
      if (this.checking === abort) this.checking = null;
      if (abort.signal.aborted || !stillHere()) return; // Esc or closed: nothing is sent
      if (step.kind === 'kept') {
        this.kept(step.why, step.message);
        return;
      }
      if (step.kind === 'cancel') {
        this.state = 'ready';
        this.setStatus('');
        this.render();
        this.composer.focus();
        return;
      }
      if (step.kind === 'done') {
        draft.clearIf(res.revision);
        this.state = 'sent';
        this.result = { queued: false, retried: false };
        this.seen = draft.revision;
        this.setStatus(`Packing up: ${name} gets the task, then goes home once it reports CLEAN.`, false, { text: 'Packing up', kind: 'box' });
        this.render();
        this.composer.focus();
        return;
      }
      if (step.kind === 'send') go = step.go;
      else handover = step;
      this.state = 'sending';
      this.setStatus(`Sending to ${name}…`);
      this.render();
    }
    const send = (g: Go) => this.host.send('worker.prompt', { id, text: res.text, ...(g.secrets ? { secrets: g.secrets } : {}) });
    // #108: a stale review is reviewed again; the switch gone off keeps the note. Never an automatic send. The check's
    // hand-over goes as it is: refused as stale, nothing is sent (its files may be gone) and the note stays for a new review.
    const d = handover
      ? await this.host.send('worker.prompt', { id, text: handover.text, secrets_pending: handover.pending }).then((result) =>
          !result.ok && (result.code === 'secrets_review_stale' || result.code === 'secrets_review_off') ? ({ kind: 'kept', why: 'failed', message: HANDOVER_STALE } as const) : ({ kind: 'answered', result, go } as const),
        )
      : flow
        ? await flow.deliver(req, go, send)
        : ({ kind: 'answered', result: await send(go), go } as const);
    const still = stillHere();
    if (d.kind === 'kept') {
      if (!still) this.host.toast(d.message, 'error');
      else this.kept(d.why, d.message);
      return;
    }
    const r = d.result;
    if (r.ok) {
      const ack = (r.data ?? {}) as Partial<PromptAck>;
      const result = { queued: ack.queued === true, retried: ack.retried === true };
      // Sent: its draft goes (text and images), unless you wrote another one meanwhile (closed and opened the overlay again).
      draft.clearIf(res.revision);
      const msg = result.queued
        ? `Queued: ${name} takes it when it can.`
        : result.retried
          ? `Sent: ${name} is on it (herdr’s paste needed one more Enter).`
          : `Sent: ${name} is on it.`;
      if (!still) {
        this.host.toast(msg, 'info');
        return;
      }
      this.state = 'sent';
      this.result = result;
      this.seen = draft.revision;
      this.setStatus(msg, false, result.queued ? { text: 'Queued', kind: 'working' } : { text: 'Sent', kind: 'done' });
      this.render();
      this.composer.focus();
      return;
    }
    const msg =
      r.code === 'invalid_state'
        ? (this.blocker() ?? `${name} can’t take a prompt right now: ${r.message.replace(/^invalid state:\s*/, '')}.`)
        : failureText('worker.prompt', r.code, r.message, { worker: name });
    if (!still) {
      this.host.toast(msg, 'error');
      return;
    }
    this.state = 'failed';
    this.setStatus(msg, true);
    this.render();
    this.composer.focus();
  }

  /** #108: nothing was sent (the review cancelled, the switch changed, the protection failed): the note stays, and why. */
  private kept(why: 'cancel' | 'off' | 'changed' | 'failed', message: string): void {
    this.state = why === 'failed' ? 'failed' : 'ready';
    this.setStatus(why === 'cancel' ? 'Not sent: the prompt is still here.' : message, why === 'failed');
    this.render();
    this.composer.focus();
  }

  summary(): PromptSummary | null {
    if (!this.dialog.open) return null;
    const v = this.host.store.workerView(this.id);
    return {
      kind: 'prompt',
      id: this.id,
      name: this.name,
      display: v?.display ?? 'idle',
      state: this.state,
      text: markedText(this.composer.getSnapshot()),
      images: this.composer.getSnapshot().images.map((i) => ({ n: i.n, name: i.name, status: i.status, path: i.path })),
      queued: this.state === 'sent' ? !!this.result?.queued : !this.chip.hidden,
      result: this.result ? { ...this.result } : null,
      blocker: this.blocker(),
      status: this.statusText,
      error: this.statusError,
      confirm: null,
    };
  }
}
