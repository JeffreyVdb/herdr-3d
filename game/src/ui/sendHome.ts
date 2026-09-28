import type { FireAck, FirePrepare, FireWorktree } from '../net/protocol';
import { fireArgs, fireOptions, leftovers, type FireOptions } from '../world/hire';
import { h, icon, ICON } from './dom';
import type { DialogHost } from './hire';
import { failureText } from './messages';

/**
 * Send home (M4), the gentle fire: X looking at a worker. It asks the bridge
 * what is left on the desk (`worker.fire.prepare`: branch, uncommitted
 * changes, commits not on any remote), offers keep / delete worktree /
 * delete worktree + branch for a worker in a worktree of its own (delete only
 * when that is safe), then `worker.fire`. The header's plate is the
 * cardboard box they leave with.
 */

export type SendHomeState = 'preparing' | 'ready' | 'sending' | 'failed';

export interface SendHomeSummary {
  kind: 'send-home';
  id: string;
  name: string;
  title: string;
  state: SendHomeState;
  prep: FirePrepare | null;
  options: FireOptions | null;
  choice: FireWorktree;
  status: string;
  error: boolean;
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

/** Porcelain lines shown before "and N more". */
const SHOW_DIRTY = 6;

export class SendHomeDialog {
  private readonly dialog = h('dialog', { class: 'desk-dlg desk-dlg--home', 'aria-labelledby': 'home-title', 'aria-describedby': 'home-sub' });
  private readonly head = h('header', { class: 'dd-head' });
  private readonly form = h('form', { class: 'dd-body', id: 'home-form', novalidate: true });
  private readonly statusEl = h('p', { class: 'dd-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private readonly actions = h('div', { class: 'dd-actions' });
  private id = '';
  private name = '';
  private desk = 0;
  private session = '';
  private state: SendHomeState = 'preparing';
  private prep: FirePrepare | null = null;
  private choice: FireWorktree = 'keep';
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
    });
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.close();
    });
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.send();
    });
    // Enter on the (safe) keep choice sends home; with a delete chosen, only the button does.
    this.form.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement) || e.target.type !== 'radio') return;
      e.preventDefault();
      if (this.choice === 'keep') void this.send();
      else this.setStatus('Enter only confirms when the worktree is kept: to delete, use the button.', false);
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
    this.id = workerId;
    this.name = v.name;
    this.desk = v.desk;
    this.session = v.worker.session;
    this.prep = null;
    this.choice = 'keep';
    this.state = 'preparing';
    this.setStatus('Looking at what is on the desk…');
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.actions.querySelector<HTMLElement>('[data-key="cancel"]')?.focus();
    void this.prepare();
  }

  private title(): string {
    return `Send ${this.name} home`;
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
      this.setStatus(failureText('worker.fire.prepare', r.code, r.message, { worker: this.name, floor: this.session }), true);
      this.render();
      return;
    }
    this.prep = r.data as FirePrepare;
    this.name = this.prep.name || this.name;
    this.state = 'ready';
    this.setStatus('');
    this.render();
    // Keyboard: on the keep choice (Enter sends home, safely), else on Send home itself.
    const first = this.form.querySelector<HTMLElement>('input[name="home-worktree"]:checked') ?? this.actions.querySelector<HTMLElement>('[data-key="send"]');
    first?.focus();
  }

  /** The world changed: the worker may be gone (sent home elsewhere, closed in herdr). */
  refresh(): void {
    if (!this.dialog.open || this.state === 'sending') return;
    if (!this.host.store.workers.has(this.id)) {
      this.close();
      this.host.toast(`${this.name} has already left.`, 'info');
    }
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
    const sub = [`Desk ${this.desk + 1}`, this.session, v?.worker.label && v.worker.label !== this.name ? v.worker.label : null].filter(Boolean).join(' · ');
    this.head.replaceChildren(
      h('div', { class: 'dd-plate dd-plate--box', 'aria-hidden': 'true' }, icon(BOX)),
      h('div', { class: 'dd-titles' }, h('h2', { id: 'home-title' }, this.title()), h('p', { id: 'home-sub' }, sub)),
      h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close)),
    );
    const p = this.prep;
    const nodes: Node[] = [];
    if (!p) {
      nodes.push(h('div', { class: 'dd-skeleton', 'aria-hidden': 'true' }, h('i'), h('i')));
    } else {
      const o = fireOptions(p);
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
        const set = h('fieldset', { class: 'dd-choices' }, h('legend', {}, 'The worktree'));
        for (const c of CHOICES) {
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
        nodes.push(set);
        if (o.warning) nodes.push(h('div', { class: 'dd-callout', 'data-level': 'warn', role: 'note' }, h('p', {}, o.warning)));
      }
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
    this.renderActions();
  }

  private renderActions(): void {
    const ready = this.state === 'ready' && !!this.prep;
    const deleting = this.choice !== 'keep';
    const text = this.state === 'sending' ? 'Sending home…' : deleting ? `Send ${this.name} home and delete` : `Send ${this.name} home`;
    const why = !ready ? (this.state === 'sending' ? 'On the way out.' : 'Waiting for herdr-world…') : this.host.unsupported('worker.fire') ? failureText('worker.fire', 'unknown_command', '') : null;
    const had = document.activeElement instanceof HTMLElement && this.actions.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const cancel = h('button', { class: 'btn', 'data-key': 'cancel', onclick: () => this.close() }, 'Cancel');
    const retry = this.state === 'failed' && !this.host.unsupported('worker.fire.prepare') ? h('button', { class: 'btn', 'data-key': 'retry', onclick: () => this.retry() }, 'Try again') : null;
    const send = h('button', { class: 'btn btn--danger', type: 'submit', form: 'home-form', 'data-key': 'send', 'aria-disabled': why ? 'true' : null, title: why }, text);
    this.actions.replaceChildren(...[retry, cancel, send].filter((x): x is HTMLButtonElement => !!x));
    if (had) this.actions.querySelector<HTMLElement>(`[data-key="${had}"]`)?.focus();
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
      const wt = (r.data as FireAck | undefined)?.worktree;
      const what = wt === 'deleted' ? ' Its worktree is deleted; the branch stays.' : wt === 'deleted_branch' ? ' Its worktree and branch are deleted.' : p.worktree?.linked ? ' Its worktree is kept.' : '';
      this.close();
      this.host.toast(`Sent ${name} home.${what}`, 'info');
      return;
    }
    const msg = failureText('worker.fire', r.code, r.message, { worker: name, floor: this.session });
    if (!still) {
      this.host.toast(msg, 'error');
      return;
    }
    this.setStatus(msg, true);
    // The tree may have changed since the prepare: look again.
    if (r.code === 'not_clean') {
      this.choice = 'keep';
      void this.prepare().then(() => this.setStatus(msg, true));
      return;
    }
    this.render();
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
      choice: this.choice,
      status: this.statusText,
      error: this.statusError,
    };
  }
}
