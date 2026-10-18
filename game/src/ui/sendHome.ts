import type { CommandResult } from '../net/client';
import type { FireAck, FirePrepare, FireWorktree, PackupRange, WrapUp, WrapUpAck } from '../net/protocol';
import { fireArgs, fireBlocked, fireOptions, leftovers, scheduleHold, type FireOptions } from '../world/hire';
import { armedText, defaultChoice, WRAPUP_AGAIN_PROMPT, WRAPUP_PROMPT, worktreeFate, wrapUpOf } from '../world/wrapup';
import { packupChoice, packupPrompt, struckParts } from '../world/packup';
import { h, icon, ICON } from './dom';
import type { DialogHost } from './hire';
import { failureText } from './messages';
import { backdropPolicy } from './dismiss';
import { onReviewKey, reviewButton, type Go } from './secretsFlow';

/**
 * Send home (M4), the gentle fire: X looking at a worker. It asks the bridge
 * what is left on the desk (`worker.fire.prepare`: branch, uncommitted
 * changes, commits not on any remote), offers keep / delete worktree /
 * delete worktree + branch for a worker in a worktree of its own (delete only
 * when that is safe, and preselected then), then `worker.fire`. The header's
 * plate is the cardboard box they leave with.
 *
 * #83: "Wrap up, then send home" gives the agent one last cleanup prompt
 * first (`worker.wrapup`), the worktree choice made up front; the bridge
 * sends it home once it reports CLEAN. While a wrap-up is armed the dialog
 * offers to cancel it; once it needs you, to wrap up again or dismiss it.
 * Enter never deletes at once: with a delete chosen it opens a confirm step
 * whose Cancel has the focus. Enter in the prompt adds a line.
 *
 * #110: pack up on request opens it in its third mode (`openPackup`), built on the wrap-up: the prompt you sent with
 * the leaving part struck out, the task left in an editable box, the worktree choice (the worktree and its branch
 * preselected when that is possible) with the same warnings. "Send and go home" is a `worker.wrapup` of the task
 * and the cleanup request; "Send as written (stay)" and Cancel hand the choice back to the composer.
 *
 * #108 round 4: the last prompt is reviewed for secrets like any other (with the switch on; "Review secrets" or
 * Ctrl/⌘+Shift+X on purpose). A pack-up whose check read the protected values' references sends its task with the
 * check's hand-over (`secrets_pending`): the task as the check answered it needs no review again, and the files become
 * the worker's before the wrap-up arms; an edited task is reviewed as usual.
 */

export type SendHomeState = 'preparing' | 'ready' | 'sending' | 'failed';

/** #83: sending home now, or wrapping up first. #110: or a prompt's task first (pack up on request). */
export type SendHomeMode = 'home' | 'wrapup' | 'packup';

/** #110: the prompt pack up on request looked at: as you sent it, the task left, and what was cut. */
export interface PackupConfirm {
  original: string;
  task: string;
  removed: PackupRange[];
  /** #108 round 4: the check's hand-over (`secrets_pending`): "Send and go home" sends the task with it. */
  pending?: string;
}

/** #110: how the pack-up confirm ended: the task went and the worker goes home after it, send as written, or nothing. */
export type PackupChoice = 'done' | 'stay' | 'cancel';

export interface SendHomeSummary {
  kind: 'send-home';
  id: string;
  name: string;
  title: string;
  state: SendHomeState;
  prep: FirePrepare | null;
  options: FireOptions | null;
  /** Why it cannot be sent home at all (herdr would not close its workspace), null when it can. */
  blocked: string | null;
  choice: FireWorktree;
  status: string;
  error: boolean;
  /** #83 */
  mode: SendHomeMode;
  /** The inline "Delete the worktree…?" step is open. */
  confirming: boolean;
  /** The Wrap up prompt as typed. */
  prompt: string;
  /** The worker's wrap-up, armed or needing you. */
  wrapup: WrapUp | null;
  /** #110: the prompt the pack-up confirm is about (null: not that mode). */
  packup: PackupConfirm | null;
}

/** Room for "Handoff first" (M9, #11): nothing yet. */
export function renderHandoff(_p: FirePrepare): HTMLElement | null {
  return null;
}

/** Room for the worker's running services and "Also stop its services" (#14): nothing yet. */
export function renderServices(_p: FirePrepare): HTMLElement | null {
  return null;
}

/** An authored cardboard box: body, open flaps, the tape. */
const BOX = '<path d="M4.5 9.5h15v9.2a1.3 1.3 0 0 1-1.3 1.3H5.8a1.3 1.3 0 0 1-1.3-1.3z"/><path d="M4.5 9.5 2.8 6.2l6.4-1.6 2.8 4.9M19.5 9.5l1.7-3.3-6.4-1.6L12 9.5"/><path d="M10 13h4"/>';

const CHOICES: Array<{ v: FireWorktree; label: string; hint: string }> = [
  { v: 'keep', label: 'Keep the worktree and its branch', hint: 'Nothing on disk changes: pick it up later.' },
  { v: 'delete', label: 'Delete the worktree, keep the branch', hint: 'herdr worktree remove; the branch stays on origin.' },
  { v: 'delete_branch', label: 'Delete the worktree and the branch', hint: 'Removes both: only once the work is merged.' },
];

/** #108: pack up's hand-over refused (expired, the setting changed): nothing went, its files may be gone. */
const HANDOVER_GONE = 'Nothing was sent: the check of the prompt’s secrets no longer holds (it expired, or the setting changed). Cancel, then send the prompt again to review it.';
/** #108: a bridge from before round 5 refuses the hand-over on a wrap-up (an unknown field): nothing was sent. */
const OLD_BRIDGE = 'Nothing was sent: this herdr-world can’t hand a pack-up’s protected secrets to a wrap-up yet. Update the bridge, or send the prompt as written (stay).';

/** Porcelain lines shown before "and N more". */
const SHOW_DIRTY = 6;

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export class SendHomeDialog {
  private readonly dialog = h('dialog', { class: 'desk-dlg desk-dlg--home', 'aria-labelledby': 'home-title', 'aria-describedby': 'home-sub' });
  private readonly head = h('header', { class: 'dd-head' });
  /** #83: the worker's wrap-up, armed or needing you (kept apart from the form, so a live update leaves the form alone). */
  private readonly wrapEl = h('div', { class: 'dd-wrap-state', 'data-key': 'wrap-state' });
  private readonly form = h('form', { class: 'dd-body', id: 'home-form', novalidate: true });
  private readonly statusEl = h('p', { class: 'dd-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private readonly actions = h('div', { class: 'dd-actions' });
  /** #83: the cleanup prompt; one element, so what you typed survives a re-render. */
  private readonly promptEl = h('textarea', {
    id: 'home-wrap-prompt',
    'data-key': 'wrap-prompt',
    rows: 4,
    spellcheck: true,
    'aria-describedby': 'home-wrap-hint',
  }) as HTMLTextAreaElement;
  private id = '';
  private name = '';
  private desk = 0;
  /** #58: the floor's name (the messages, the sub line). */
  private floorName = '';
  private state: SendHomeState = 'preparing';
  private prep: FirePrepare | null = null;
  private choice: FireWorktree = 'keep';
  private mode: SendHomeMode = 'home';
  private confirming = false;
  /** The wrap-up the banner shows (to redraw it only when it changes). */
  private shownWrap = '';
  /** #110: the pack-up confirm's prompt, and who waits for how it ends. */
  private pk: PackupConfirm | null = null;
  /** #110: opened by a pack-up check (its confirm, or the send home for a prompt with nothing left): you stay seated. */
  private fromPackup = false;
  private settle: ((c: PackupChoice) => void) | null = null;
  private statusText = '';
  private statusError = false;
  private gen = 0;

  constructor(
    parent: HTMLElement,
    private readonly host: DialogHost,
  ) {
    this.alertEl.hidden = this.statusEl.hidden = true;
    this.dialog.append(this.head, this.form, h('footer', { class: 'dd-foot' }, this.statusEl, this.alertEl, this.actions));
    this.dialog.addEventListener('close', () => {
      if (!this.dialog.open) this.gen++;
      this.settleWith('cancel'); // #110: Esc, Cancel, the close button, the worker gone
    });
    // Esc in the confirm step steps back to the dialog; it does not close it.
    this.dialog.addEventListener('cancel', (e) => {
      if (!this.confirming) return;
      e.preventDefault();
      this.closeConfirm();
    });
    // #51: typed text or a consequential choice in here: only the close button and Esc close it, never the backdrop.
    backdropPolicy(this.dialog, 'none');
    // A click on the send button (or Space on it): it sends, with the choice in plain sight.
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit(false);
    });
    // Enter on a choice or on the send button sends with keep; with a delete chosen it opens the confirm step (its
    // Cancel focused, so a second stray Enter cancels). In the prompt Enter and Shift+Enter add a line, never send.
    this.dialog.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || this.confirming) return;
      const t = e.target;
      if (t instanceof HTMLTextAreaElement) return;
      const sends = (t instanceof HTMLInputElement && t.type === 'radio') || (t instanceof HTMLElement && t.dataset.key === 'send');
      if (!sends) return;
      e.preventDefault();
      this.submit(true);
    });
    this.promptEl.addEventListener('input', () => {
      if (this.statusError) this.setStatus('');
      this.renderActions();
    });
    // #108: the review of the last prompt's secrets, now (with the switch on).
    onReviewKey(this.promptEl, () => this.host.secrets, () => this.reviewNow());
    host.secrets?.onChange(() => {
      if (this.dialog.open) this.renderActions();
    });
    parent.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  open(workerId: string, opts: { fromPackup?: boolean } = {}): void {
    this.settleWith('cancel');
    this.pk = null;
    this.fromPackup = opts.fromPackup === true;
    this.start(workerId, 'home');
  }

  /** #110: open for a pack-up check, which keeps you at the laptop you sent the prompt from (its draft stays). */
  get keepsSeat(): boolean {
    return this.dialog.open && this.fromPackup;
  }

  /**
   * #110: the pack-up confirm for a prompt to `workerId`. Resolves `done` once the task went out as a wrap-up (the
   * worker goes home on CLEAN), `stay` for "Send as written (stay)" (the composer sends it), `cancel` for nothing.
   */
  openPackup(workerId: string, pk: PackupConfirm): Promise<PackupChoice> {
    this.settleWith('cancel');
    if (!this.host.store.workerView(workerId)) return Promise.resolve('cancel');
    const done = new Promise<PackupChoice>((resolve) => (this.settle = resolve));
    this.pk = { original: pk.original, task: pk.task, removed: pk.removed.map((r) => ({ ...r })), ...(pk.pending ? { pending: pk.pending } : {}) };
    this.fromPackup = true;
    this.start(workerId, 'packup');
    return done;
  }

  private settleWith(c: PackupChoice): void {
    const s = this.settle;
    this.settle = null;
    s?.(c);
  }

  private start(workerId: string, mode: SendHomeMode): void {
    const v = this.host.store.workerView(workerId);
    if (!v) return;
    this.id = workerId;
    this.name = v.name;
    this.desk = v.desk;
    this.floorName = this.host.store.floorName(v.worker.floor);
    this.prep = null;
    this.choice = 'keep';
    this.mode = mode;
    this.confirming = false;
    this.promptEl.value = mode === 'packup' && this.pk ? this.pk.task : WRAPUP_PROMPT;
    this.state = 'preparing';
    this.setStatus('Looking at what is on the desk…');
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.actions.querySelector<HTMLElement>('[data-key="cancel"]')?.focus();
    void this.prepare();
  }

  private title(): string {
    if (this.mode === 'packup') return `Send the task, then send ${this.name} home`;
    return this.mode === 'wrapup' ? `Wrap up ${this.name}, then send home` : `Send ${this.name} home`;
  }

  /** #83, #110: a last prompt goes first (wrap up, or a prompt's task). */
  private prompting(): boolean {
    return this.mode !== 'home';
  }

  private wrap(): WrapUp | null {
    const w = this.host.store.workers.get(this.id);
    return w ? wrapUpOf(w) : null;
  }

  private linked(): boolean {
    return !!(this.prep?.worktree?.linked ?? this.host.store.workers.get(this.id)?.worktree?.linked);
  }

  private async prepare(): Promise<void> {
    const gen = ++this.gen;
    if (this.host.unsupported('worker.fire.prepare')) {
      this.state = 'failed';
      this.setStatus(failureText('worker.fire.prepare', 'unknown_command', ''), true);
      this.render();
      return;
    }
    const r = await this.host.send('worker.fire.prepare', { id: this.id });
    if (gen !== this.gen || !this.dialog.open) return;
    if (!r.ok) {
      this.state = 'failed';
      this.setStatus(failureText('worker.fire.prepare', r.code, r.message, { worker: this.name, floor: this.floorName }), true);
      this.render();
      return;
    }
    this.prep = r.data as FirePrepare;
    this.name = this.prep.name || this.name;
    // Delete is preselected whenever it is safe; the choice stays if the prepare is asked again and it still is.
    // #110: pack up deletes the branch too whenever it may (the prompt asked to leave, not to keep anything).
    if (!fireOptions(this.prep).enabled[this.choice] || this.choice === 'keep') this.choice = this.mode === 'packup' ? packupChoice(this.prep) : defaultChoice(this.prep);
    this.state = 'ready';
    this.setStatus('');
    this.render();
    this.focusFirst();
  }

  /** Keyboard: on the chosen worktree (Enter: send home, or the confirm step for a delete), else on the action. */
  private focusFirst(): void {
    if (!this.prep) return;
    if (this.prompting()) {
      this.promptEl.focus();
      return;
    }
    const first = fireBlocked(this.prep)
      ? this.actions.querySelector<HTMLElement>('[data-key="cancel"]')
      : (this.form.querySelector<HTMLElement>('input[name="home-worktree"]:checked') ?? this.actions.querySelector<HTMLElement>('[data-key="send"]'));
    first?.focus();
  }

  /** The world changed: the worker may be gone (sent home elsewhere, closed in herdr), or its wrap-up moved on. */
  refresh(): void {
    if (!this.dialog.open || this.state === 'sending') return;
    if (!this.host.store.workers.has(this.id)) {
      this.close();
      this.host.toast(`${this.name} has already left.`, 'info');
      return;
    }
    if (this.wrapKey() !== this.shownWrap) {
      this.renderWrap();
      this.renderActions();
    }
  }

  private wrapKey(): string {
    const u = this.wrap();
    return u ? `${u.state}|${u.worktree}|${u.armed_at}|${u.reason ?? ''}` : '';
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
    const sub = [`Desk ${this.desk + 1}`, this.floorName, v?.worker.label && v.worker.label !== this.name ? v.worker.label : null].filter(Boolean).join(' · ');
    this.head.replaceChildren(
      h('div', { class: 'dd-plate dd-plate--box', 'aria-hidden': 'true' }, icon(BOX)),
      h('div', { class: 'dd-titles' }, h('h2', { id: 'home-title' }, this.title()), h('p', { id: 'home-sub' }, sub)),
      h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close)),
    );
    const p = this.prep;
    const nodes: Node[] = [this.wrapEl];
    if (!p) {
      nodes.push(h('div', { class: 'dd-skeleton', 'aria-hidden': 'true' }, h('i'), h('i')));
    } else {
      const o = fireOptions(p);
      if (this.mode === 'packup' && this.pk) nodes.push(...this.packupNodes(this.pk));
      else if (this.mode === 'wrapup') {
        // The last prompt first: it is what this mode is for.
        this.promptEl.disabled = this.state === 'sending';
        nodes.push(
          h(
            'div',
            { class: 'dd-field dd-wrap-prompt' },
            h('label', { for: 'home-wrap-prompt' }, 'Last prompt'),
            this.promptEl,
            h('p', { class: 'field-hint', id: 'home-wrap-hint' }, 'herdr-world adds the line it reads the result from. On CLEAN it sends ', h('b', {}, this.name), ' home; anything else waits for you.'),
          ),
        );
      }
      const facts = h('dl', { class: 'dd-facts' });
      const fact = (k: string, val: Node | string) => facts.append(h('dt', {}, k), h('dd', {}, val));
      if (p.branch) fact('Branch', h('code', {}, p.branch));
      if (p.worktree) fact(p.worktree.linked ? 'Worktree' : 'Folder', h('code', {}, p.worktree.path));
      else fact('Folder', 'not a git worktree');
      nodes.push(facts);

      // What is left on the desk: uncommitted changes, commits no remote has.
      const left = leftovers(p);
      const desk = h('section', { class: 'dd-desk', 'aria-labelledby': 'home-left' });
      desk.append(
        h(
          'h3',
          { id: 'home-left' },
          'On the desk ',
          left ? h('span', { class: 'tape tape--needs_you' }, 'Unsaved work') : h('span', { class: 'tape tape--done' }, p.worktree ? 'All pushed' : 'Nothing to save'),
        ),
      );
      if (p.dirty.length) {
        const ul = h('ul', { class: 'dd-porcelain', 'aria-label': 'Uncommitted changes' });
        for (const line of p.dirty.slice(0, SHOW_DIRTY)) ul.append(h('li', {}, h('code', {}, line)));
        desk.append(h('p', {}, `${p.dirty.length} uncommitted ${p.dirty.length === 1 ? 'change' : 'changes'}`), ul);
        if (p.dirty.length > SHOW_DIRTY) desk.append(h('p', { class: 'field-hint' }, `and ${p.dirty.length - SHOW_DIRTY} more`));
      }
      if (p.unpushed > 0) desk.append(h('p', {}, `${p.unpushed} ${p.unpushed === 1 ? 'commit' : 'commits'} not on any remote`));
      if (!left) desk.append(h('p', { class: 'field-hint' }, p.worktree ? 'Everything is committed and pushed.' : 'No git checkout of its own: nothing is deleted.'));
      nodes.push(desk);

      if (o.offered) {
        const set = h('fieldset', { class: 'dd-choices' }, h('legend', {}, this.prompting() ? 'The worktree, once it reports CLEAN' : 'The worktree'));
        for (const c of CHOICES.filter((x) => o.choices.includes(x.v))) {
          const on = o.enabled[c.v];
          const input = h('input', { type: 'radio', name: 'home-worktree', value: c.v, id: `home-${c.v}`, 'data-key': `wt:${c.v}`, 'aria-describedby': `home-${c.v}-hint` });
          input.checked = this.choice === c.v;
          input.disabled = !on || this.state === 'sending';
          input.addEventListener('change', () => {
            if (!input.checked) return;
            this.choice = c.v;
            this.renderActions();
          });
          set.append(
            h(
              'label',
              { class: 'dd-choice', for: `home-${c.v}`, 'data-disabled': on ? null : 'true' },
              input,
              h('span', { class: 'dd-radio', 'aria-hidden': 'true' }),
              h('span', { class: 'dd-choice-text' }, h('span', {}, c.label), h('span', { class: 'field-hint', id: `home-${c.v}-hint` }, c.hint)),
            ),
          );
        }
        if (o.branchNote) set.append(h('p', { class: 'field-hint', 'data-key': 'branch-note' }, o.branchNote));
        nodes.push(set);
        if (o.warning) nodes.push(h('div', { class: 'dd-callout', 'data-level': 'warn', role: 'note' }, h('p', {}, o.warning)));
      }
      const blocked = fireBlocked(p);
      if (blocked) nodes.push(h('div', { class: 'dd-callout dd-callout--error', role: 'alert' }, h('p', {}, `${this.name} can’t go home yet: ${blocked}.`)));
      // Hooks for the later tickets (hidden until they fill them).
      for (const [hook, el] of [
        ['handoff', renderHandoff(p)],
        ['services', renderServices(p)],
      ] as const) {
        const slot = h('div', { class: 'dd-hook', 'data-hook': hook });
        if (el) slot.append(el);
        else slot.hidden = true;
        nodes.push(slot);
      }
    }
    this.form.replaceChildren(...nodes);
    this.renderWrap();
    this.renderActions();
  }

  /** #110: the prompt as you sent it with the leaving part struck out, then the task it goes as, editable. */
  private packupNodes(pk: PackupConfirm): Node[] {
    this.promptEl.disabled = this.state === 'sending';
    const original = h('p', { class: 'dd-pk-original', id: 'home-pk-original', 'data-key': 'pk-original' });
    for (const part of struckParts(pk.original, pk.removed)) {
      original.append(part.struck ? h('del', { title: 'Cut: not sent' }, part.text) : document.createTextNode(part.text));
    }
    return [
      h('div', { class: 'dd-field dd-pk' }, h('p', { class: 'dd-pk-label', id: 'home-pk-label' }, 'Your prompt'), original, h('p', { class: 'field-hint' }, 'The struck part asks ', h('b', {}, this.name), ' to leave: it is not sent. herdr-world sends it home instead.')),
      h(
        'div',
        { class: 'dd-field dd-wrap-prompt' },
        h('label', { for: 'home-wrap-prompt' }, `What ${this.name} gets`),
        this.promptEl,
        h('p', { class: 'field-hint', id: 'home-wrap-hint' }, 'Then a request to stop what it started, and the line herdr-world reads the result from. On CLEAN it sends ', h('b', {}, this.name), ' home; if the task did not complete, it stays and needs you.'),
      ),
    ];
  }

  /** #83: the worker's wrap-up on top of the form: what it waits for, or why it needs you. */
  private renderWrap(): void {
    this.shownWrap = this.wrapKey();
    const u = this.wrap();
    const busy = this.state === 'sending';
    if (!u) {
      this.wrapEl.replaceChildren();
      this.wrapEl.hidden = true;
      return;
    }
    this.wrapEl.hidden = false;
    if (u.state === 'armed') {
      this.wrapEl.replaceChildren(
        h(
          'div',
          { class: 'dd-callout dd-callout--box dd-wrap', role: 'status' },
          h('p', {}, h('span', { class: 'tape tape--box' }, 'Wrapping up'), ` since ${clock(u.armed_at)}`),
          h('p', {}, armedText(this.name, u, this.linked())),
          h('div', { class: 'dd-wrap-actions' }, h('button', { type: 'button', class: 'btn btn--danger-quiet', 'data-key': 'wrap-cancel', 'aria-disabled': busy ? 'true' : null, onclick: () => void this.cancelWrap('cancel') }, 'Cancel wrap-up')),
        ),
      );
      return;
    }
    this.wrapEl.replaceChildren(
      h(
        'div',
        { class: 'dd-callout dd-callout--error dd-wrap', role: 'alert' },
        h('p', {}, h('span', { class: 'tape tape--needs_you' }, 'Needs you'), ' The wrap-up stopped. Nothing was sent home.'),
        h('p', { class: 'dd-wrap-reason', 'data-key': 'wrap-reason' }, u.reason || 'It stopped without a result.'),
        h(
          'div',
          { class: 'dd-wrap-actions' },
          h('button', { type: 'button', class: 'btn btn--quiet', 'data-key': 'wrap-dismiss', 'aria-disabled': busy ? 'true' : null, onclick: () => void this.cancelWrap('dismiss') }, 'Dismiss'),
          h('button', { type: 'button', class: 'btn', 'data-key': 'wrap-again', 'aria-disabled': busy || !this.prep ? 'true' : null, onclick: () => this.wrapAgain(u) }, 'Wrap up again'),
        ),
      ),
    );
  }

  /** What blocks the send right now (shown on the button), null when it may go. */
  private why(): string | null {
    const ready = this.state === 'ready' && !!this.prep;
    const blocked = this.prep ? fireBlocked(this.prep) : null;
    const cmd = this.prompting() ? 'worker.wrapup' : 'worker.fire';
    if (!ready) return this.state === 'sending' ? (this.prompting() ? 'Sending the last prompt.' : 'On the way out.') : 'Waiting for herdr-world…';
    if (this.host.unsupported(cmd)) return failureText(cmd, 'unknown_command', '');
    if (blocked) return `${this.name} can’t go home yet: ${blocked}.`;
    if (this.prompting() && this.wrap()?.state === 'armed') return `${this.name} is wrapping up already: cancel it first.`;
    if (this.mode === 'wrapup' && !this.promptEl.value.trim()) return 'Write the last prompt first.';
    if (this.mode === 'packup' && !this.promptEl.value.trim()) return 'Write the task first, or send the prompt as written.';
    return null;
  }

  private deleting(): boolean {
    return this.choice !== 'keep' && !!this.prep && fireOptions(this.prep).enabled[this.choice];
  }

  private renderActions(): void {
    const had = document.activeElement instanceof HTMLElement && this.actions.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    if (this.confirming && this.prep?.worktree) {
      this.renderConfirm(this.prep.worktree.path);
      return;
    }
    this.actions.classList.remove('dd-actions--confirm');
    const deleting = this.deleting();
    const wrapping = this.mode === 'wrapup';
    const sending = this.state === 'sending';
    if (this.mode === 'packup') {
      this.renderPackupActions(sending, had);
      return;
    }
    const text = sending
      ? wrapping
        ? 'Sending the prompt…'
        : 'Sending home…'
      : wrapping
        ? 'Wrap up, then send home'
        : deleting
          ? `Send ${this.name} home and delete`
          : `Send ${this.name} home`;
    const why = this.why();
    const cancel = h('button', { type: 'button', class: 'btn', 'data-key': 'cancel', onclick: () => this.close() }, 'Cancel');
    const retry =
      this.state === 'failed' && !this.host.unsupported('worker.fire.prepare') ? h('button', { type: 'button', class: 'btn', 'data-key': 'retry', onclick: () => this.retry() }, 'Try again') : null;
    // #83: the second action, and the way back from it.
    const armed = this.wrap()?.state === 'armed';
    const toWrap =
      !wrapping && this.prep && !armed && !this.host.unsupported('worker.wrapup')
        ? h('button', { type: 'button', class: 'btn', 'data-key': 'wrap', 'aria-disabled': this.state !== 'ready' || fireBlocked(this.prep) ? 'true' : null, onclick: () => this.setMode('wrapup') }, 'Wrap up, then send home')
        : null;
    const back = wrapping ? h('button', { type: 'button', class: 'btn btn--quiet', 'data-key': 'back', 'aria-disabled': sending ? 'true' : null, onclick: () => this.setMode('home') }, icon(ICON.back), 'Send home now') : null;
    const send = h('button', { class: 'btn btn--danger', type: 'submit', form: 'home-form', 'data-key': 'send', 'aria-disabled': why ? 'true' : null, title: why }, text);
    const review = wrapping ? reviewButton(this.host.secrets, why, () => this.reviewNow(), 'last prompt') : null;
    this.actions.replaceChildren(...[back, retry, cancel, toWrap, review, send].filter((x): x is HTMLButtonElement => !!x));
    if (had) this.actions.querySelector<HTMLElement>(`[data-key="${had}"]`)?.focus();
  }

  /** #110: Cancel, "Send as written (stay)", and "Send and go home" (the form's submit: Enter on it with a delete asks first). */
  private renderPackupActions(sending: boolean, had: string | undefined | null): void {
    const why = this.why();
    const cancel = h('button', { type: 'button', class: 'btn', 'data-key': 'cancel', onclick: () => this.close() }, 'Cancel');
    const stay = h(
      'button',
      { type: 'button', class: 'btn', 'data-key': 'stay', 'aria-disabled': sending ? 'true' : null, title: `Sends the prompt as you wrote it; ${this.name} stays`, onclick: () => this.stay() },
      'Send as written (stay)',
    );
    const send = h('button', { class: 'btn btn--danger', type: 'submit', form: 'home-form', 'data-key': 'send', 'aria-disabled': why ? 'true' : null, title: why }, sending ? 'Sending the task…' : 'Send and go home');
    const review = reviewButton(this.host.secrets, why, () => this.reviewNow(), 'task');
    this.actions.replaceChildren(...[cancel, stay, review, send].filter((x): x is HTMLButtonElement => !!x));
    if (had) this.actions.querySelector<HTMLElement>(`[data-key="${had}"]`)?.focus();
  }

  /** #110: send the prompt as written: the composer sends it, the worker stays. */
  private stay(): void {
    if (this.state === 'sending' || this.mode !== 'packup') return;
    this.settleWith('stay');
    this.close();
  }

  /** The inline warning before a delete: Cancel focused, the danger button one Tab away. */
  private renderConfirm(path: string): void {
    this.actions.classList.add('dd-actions--confirm');
    const wrapping = this.prompting();
    const cancel = h('button', { type: 'button', class: 'btn', 'data-key': 'confirm-cancel', onclick: () => this.closeConfirm() }, 'Cancel');
    const go = h(
      'button',
      { type: 'button', class: 'btn btn--danger', 'data-key': 'confirm', onclick: () => this.confirmed() },
      this.mode === 'packup' ? 'Send and delete' : wrapping ? 'Wrap up and delete' : `Send ${this.name} home and delete`,
    );
    this.actions.replaceChildren(
      h(
        'div',
        { class: 'dd-callout dd-callout--error dd-confirm', role: 'alertdialog', 'aria-labelledby': 'home-confirm-q', 'data-key': 'confirm-step' },
        h('p', { id: 'home-confirm-q' }, 'Delete the worktree at ', h('code', {}, path), '? This cannot be undone.'),
        wrapping ? h('p', { class: 'field-hint' }, `It goes once ${this.name} reports CLEAN.`) : null,
        h('div', { class: 'dd-wrap-actions' }, cancel, go),
      ),
    );
    cancel.focus();
  }

  private openConfirm(): void {
    this.confirming = true;
    this.renderActions();
  }

  private closeConfirm(): void {
    this.confirming = false;
    this.renderActions();
    this.actions.querySelector<HTMLElement>('[data-key="send"]')?.focus();
  }

  private confirmed(): void {
    this.confirming = false;
    void (this.prompting() ? this.wrapUp() : this.send());
  }

  /** Enter (`viaEnter`) with a delete chosen asks first; a click sends. */
  private submit(viaEnter: boolean): void {
    if (this.state !== 'ready' || !this.prep) return;
    const why = this.why();
    if (why) {
      this.setStatus(why, true);
      if (this.prompting() && !this.promptEl.value.trim()) this.promptEl.focus();
      return;
    }
    if (viaEnter && this.deleting() && this.prep.worktree) {
      this.openConfirm();
      return;
    }
    void (this.prompting() ? this.wrapUp() : this.send());
  }

  private setMode(mode: SendHomeMode): void {
    if (this.state === 'sending' || this.mode === mode || this.mode === 'packup') return;
    this.mode = mode;
    this.confirming = false;
    this.setStatus('');
    this.render();
    if (mode === 'wrapup') this.promptEl.focus();
    else this.focusFirst();
  }

  /** "Wrap up again": the short follow-up, the choice it had (when still possible). */
  private wrapAgain(u: WrapUp): void {
    if (this.state !== 'ready' || !this.prep) return;
    this.promptEl.value = WRAPUP_AGAIN_PROMPT;
    if (fireOptions(this.prep).enabled[u.worktree]) this.choice = u.worktree;
    this.mode = 'home';
    this.setMode('wrapup');
    this.promptEl.select();
  }

  private retry(): void {
    this.state = 'preparing';
    this.setStatus('Looking at what is on the desk…');
    this.render();
    void this.prepare();
  }

  private async send(): Promise<void> {
    const p = this.prep;
    if (this.state !== 'ready' || !p) return;
    if (this.host.unsupported('worker.fire')) {
      this.setStatus(failureText('worker.fire', 'unknown_command', ''), true);
      return;
    }
    const blocked = fireBlocked(p);
    if (blocked) {
      this.setStatus(`${this.name} can’t go home yet: ${blocked}.`, true);
      return;
    }
    const args = fireArgs(this.id, p, this.choice);
    const name = this.name;
    this.state = 'sending';
    this.setStatus(`${name} is saving and exiting ${this.host.store.workerView(this.id)?.harness ?? 'the agent'}…`);
    this.render();
    const gen = this.gen;
    const r = await this.host.send('worker.fire', args);
    const still = this.dialog.open && gen === this.gen;
    this.state = 'ready';
    if (r.ok) {
      const ack = r.data as FireAck | undefined;
      const wt = ack?.worktree;
      const what = wt === 'deleted' ? ' Its worktree is deleted; the branch stays.' : wt === 'deleted_branch' ? ' Its worktree and branch are deleted.' : p.worktree?.linked ? ' Its worktree is kept.' : '';
      const how = ack?.released === false ? ` ${this.host.store.workerView(this.id)?.harness ?? 'The agent'} did not exit by itself and was stopped.` : '';
      const note = ack?.note ? ` ${ack.note.charAt(0).toUpperCase()}${ack.note.slice(1)}${/[.!?]$/.test(ack.note) ? '' : '.'}` : '';
      this.close();
      this.host.toast(`Sent ${name} home.${what}${how}${note}`, 'info');
      return;
    }
    const msg = failureText('worker.fire', r.code, r.message, { worker: name, floor: this.floorName });
    if (!still) {
      this.host.toast(msg, 'error');
      return;
    }
    this.setStatus(msg, true);
    // The tree may have changed since the prepare, or a scheduled agent came to hold the worktree (#63): look again.
    if (r.code === 'not_clean' || (r.code === 'invalid_state' && scheduleHold(r.message))) {
      this.choice = 'keep';
      void this.prepare().then(() => this.setStatus(msg, true));
      return;
    }
    this.render();
  }

  /** #108: "Review secrets": the last prompt's review on purpose, then its send (as a click on the send button). */
  private reviewNow(): void {
    if (this.prompting() && !this.why()) void this.wrapUp(true);
  }

  /**
   * #83: the last prompt goes out; the bridge sends the worker home once it reports CLEAN. #108: reviewed first (`manual`:
   * on purpose); a pack-up's task as its check answered it goes with the check's hand-over instead (see the top).
   */
  private async wrapUp(manual = false): Promise<void> {
    const p = this.prep;
    if (this.state !== 'ready' || !p || this.why()) return;
    const choice = fireArgs(this.id, p, this.choice).worktree;
    const packing = this.mode === 'packup';
    const prompt = packing ? packupPrompt(this.promptEl.value) : this.promptEl.value;
    const id = this.id;
    const name = this.name;
    const gen = this.gen;
    const pending = packing ? (this.pk?.pending ?? null) : null;
    // The check's task, as it answered it (`packupPrompt` trims): the hand-over covers it, no review again.
    const covered = pending !== null && this.promptEl.value.trim() === this.pk?.task.trim();
    const flow = this.host.secrets;
    const req = { key: id, text: prompt, target: name, manual };
    let go: Go = { kind: 'send', protects: 0, shown: prompt, review: null };
    this.state = 'sending';
    if (flow && (manual || (flow.on && !covered))) {
      this.setStatus(manual ? 'Opening the review of its secrets…' : 'Looking for secrets in the prompt…');
      this.render();
      const out = await flow.review(req);
      if (!(this.dialog.open && gen === this.gen)) return;
      if (out.kind === 'kept') {
        this.state = 'ready';
        this.setStatus(out.why === 'cancel' ? 'Not sent: the prompt is still here.' : out.message, out.why === 'failed');
        this.render();
        this.promptEl.focus();
        return;
      }
      go = out;
    }
    this.setStatus(packing ? `Sending ${name} the task…` : `Sending ${name} its last prompt…`);
    this.render();
    // A refused hand-over is not reviewed again here: its files may be gone, and the composer still has the draft.
    const send = async (g: Go): Promise<CommandResult> => {
      const r = await this.host.send('worker.wrapup', { id, prompt, ...(choice ? { worktree: choice } : {}), ...(g.secrets ? { secrets: g.secrets } : {}), ...(pending ? { secrets_pending: pending } : {}) });
      return pending && !r.ok && r.code === 'secrets_review_stale' ? { ok: false, code: 'handover_stale', message: r.message } : r;
    };
    const d = flow ? await flow.deliver(req, go, send) : ({ kind: 'answered', result: await send(go), go } as const);
    const still = this.dialog.open && gen === this.gen;
    this.state = 'ready';
    if (d.kind === 'kept') {
      if (!still) this.host.toast(d.message, 'error');
      else {
        this.setStatus(d.why === 'cancel' ? 'Not sent: the prompt is still here.' : d.message, d.why === 'failed');
        this.render();
      }
      return;
    }
    const r = d.result;
    if (r.ok) {
      const queued = (r.data as WrapUpAck | undefined)?.queued === true;
      const fate = worktreeFate(choice ?? 'keep', !!p.worktree?.linked);
      if (packing) this.settleWith('done');
      this.close();
      this.host.toast(
        packing
          ? `Sent ${name} the task${queued ? ' for its next turn' : ''}. Once it reports CLEAN it goes home.${fate ? ` ${fate}` : ''}`
          : `${name} is wrapping up${queued ? ' after its current turn' : ''}. Once it reports CLEAN it goes home.${fate ? ` ${fate}` : ''}`,
        'info',
      );
      return;
    }
    const msg =
      r.code === 'handover_stale'
        ? HANDOVER_GONE
        : pending && r.code === 'bad_request' && /secrets_pending/.test(r.message)
          ? OLD_BRIDGE
          : failureText('worker.wrapup', r.code, r.message, { worker: name, floor: this.floorName });
    if (!still) {
      this.host.toast(msg, 'error');
      return;
    }
    this.setStatus(msg, true);
    if (r.code === 'not_clean' || (r.code === 'invalid_state' && scheduleHold(r.message))) {
      void this.prepare().then(() => this.setStatus(msg, true));
      return;
    }
    this.render();
  }

  /** #83: cancel an armed wrap-up, or dismiss one that needs you. */
  private async cancelWrap(how: 'cancel' | 'dismiss'): Promise<void> {
    if (this.state === 'sending') return;
    const name = this.name;
    const r = await this.host.send('worker.wrapup.cancel', { id: this.id });
    if (!r.ok) {
      this.setStatus(failureText('worker.wrapup.cancel', r.code, r.message, { worker: name, floor: this.floorName }), true);
      return;
    }
    this.setStatus(how === 'cancel' ? `Cancelled ${name}’s wrap-up. It stays at its desk.` : `Dismissed. ${name} stays at its desk.`);
  }

  summary(): SendHomeSummary | null {
    if (!this.dialog.open) return null;
    return {
      kind: 'send-home',
      id: this.id,
      name: this.name,
      title: this.title(),
      state: this.state,
      prep: this.prep ? structuredClone(this.prep) : null,
      options: this.prep ? fireOptions(this.prep) : null,
      blocked: this.prep ? fireBlocked(this.prep) : null,
      choice: this.choice,
      status: this.statusText,
      error: this.statusError,
      mode: this.mode,
      confirming: this.confirming,
      prompt: this.promptEl.value,
      wrapup: this.wrap(),
      packup: this.mode === 'packup' && this.pk ? { ...this.pk, removed: this.pk.removed.map((r) => ({ ...r })) } : null,
    };
  }
}
