import type { CommandResult } from '../net/client';
import type { CommandArgs, CommandName, HireAck, HireGit, HirePrepare } from '../net/protocol';
import {
  baseText,
  capacityView,
  choiceNote,
  fetchNote,
  firstFreeDesk,
  formFromPrepare,
  hireArgs,
  hireBlocker,
  modelsFor,
  resolveChoice,
  taskKey,
  worktreeUsable,
  type CapacityView,
  type HireForm,
} from '../world/hire';
import { effortsFor } from '../world/settings';
import type { WorldStore } from '../world/store';
import { h, icon, ICON } from './dom';
import { failureText } from './messages';
// M10 limits
import { planLimits } from './limits';
// M6 start
import { deskTabs } from './deskTabs';

/**
 * The hire dialog (M4): E on an empty desk's "+", or the top bar's Hire for
 * the first free desk. It asks the bridge (`hire.prepare`) for the defaults —
 * the preselected harness / model / effort, the next name, the folder, the
 * git base and the caps — and sends `worker.hire`. The desk plate in the
 * header is the green "+" floating over the desk in the office.
 */

export interface DialogHost {
  readonly store: WorldStore;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  unsupported(t: CommandName): boolean;
  toast(msg: string, kind: 'info' | 'error'): void;
  now(): number;
}

export interface HireHost extends DialogHost {
  /** A hire is on its way to `desk` (its "+" goes); the returned function ends this hire's hold only. */
  reserve(session: string, desk: number): () => void;
  /** Desks of a floor a hire (or a walk) is already on its way to: not free for this one. */
  held(session: string): ReadonlySet<number>;
  /** M6 start: the "Hire orchestrator" tab (ui/startRun.ts): why it is off, and opening it for the same desk. */
  orchestrate?: { off(): string | null; open(session: string, desk: number): void };
}

/** M7: what "Ask a worker…" and "Review with a worker" start the dialog with. */
export interface HirePrefill {
  prompt?: string;
  choice?: { harness: string; model: string; effort: string };
}

export type HireState = 'preparing' | 'ready' | 'hiring' | 'failed';

/** What the hire dialog shows (test hook). */
export interface HireSummary {
  kind: 'hire';
  session: string;
  desk: number;
  title: string;
  state: HireState;
  form: HireForm;
  /** The worktree option as shown (null: hidden, the folder is no git repo); `usable` false after a failed fetch. */
  git: { base: string; usable: boolean; note: string | null; noteError: boolean } | null;
  /** "Fetch again" is on its way. */
  refetching: boolean;
  choiceNote: string | null;
  capacity: CapacityView | null;
  /** Why Hire is off, null when it can be pressed. */
  blocker: string | null;
  status: string;
  error: boolean;
}

const DESK_PLUS = '<path d="M12 5v14M5 12h14"/>';

/** A group of radio chips: label-maker tape for the chosen one, blank tape for the rest. */
export function chips(name: string, legend: string, values: string[], value: string, onPick: (v: string) => void, note: HTMLElement | null = null): HTMLFieldSetElement {
  const row = h('div', { class: 'dd-chips' });
  for (const v of values) {
    const input = h('input', { type: 'radio', name, value: v, class: 'visually-hidden', 'data-key': `${name}:${v}` });
    input.checked = v === value;
    input.addEventListener('change', () => input.checked && onPick(v));
    row.append(h('label', { class: 'dd-chip' }, input, h('span', {}, v)));
  }
  return h('fieldset', { class: 'dd-pick', 'data-pick': name }, h('legend', {}, legend, note), row);
}

export class HireDialog {
  private readonly dialog = h('dialog', { class: 'desk-dlg desk-dlg--hire', 'aria-labelledby': 'hire-title', 'aria-describedby': 'hire-sub' });
  private readonly head = h('header', { class: 'dd-head' });
  /** M6 start: Hire worker | Hire orchestrator. */
  private readonly tabs = h('div', { class: 'dd-tabs-slot' });
  private readonly form = h('form', { class: 'dd-body', id: 'hire-form', novalidate: true });
  private readonly statusEl = h('p', { class: 'dd-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private readonly actions = h('div', { class: 'dd-actions' });
  /** What must be seen before pressing Hire (a failed fetch, the caps, a taken desk): by the buttons, never scrolled away. */
  private readonly notices = h('div', { class: 'dd-notices' });
  private readonly foot = h('footer', { class: 'dd-foot' }, this.notices, this.statusEl, this.alertEl, this.actions);
  private session = '';
  private desk = 0;
  private prefill: HirePrefill = {};
  private state: HireState = 'preparing';
  private prep: HirePrepare | null = null;
  private f: HireForm = { prompt: '', harness: '', model: '', effort: '', label: '', cwd: '', worktree: false };
  /** The choice as prepared: the note ("Floor default") shows while the form still has it. */
  private prepared: { harness: string; model: string; effort: string } | null = null;
  private statusText = '';
  private statusError = false;
  /** Bumped on every open / prepare, so a late answer for an older one is dropped. */
  private gen = 0;
  private hireBtn: HTMLButtonElement | null = null;
  private renderedKey = '';
  private refetching = false;

  constructor(
    parent: HTMLElement,
    private readonly host: HireHost,
  ) {
    this.alertEl.hidden = true;
    this.statusEl.hidden = true;
    this.dialog.append(this.head, this.tabs, this.form, this.foot);
    // A late answer (a prepare, or a hire sent before Esc) is for a dialog that is gone: it never touches the next one.
    this.dialog.addEventListener('close', () => {
      if (!this.dialog.open) this.gen++;
    });
    this.dialog.addEventListener('cancel', () => {
      // Esc while the hire is on its way: the hire still happens; the dialog just goes.
      if (this.state === 'hiring') this.host.toast('The hire is still on its way; the worker shows up at the desk when it is done.', 'info');
    });
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.close();
    });
    // Enter in the label or folder submits (Hire is the form's default button); a new folder is checked first.
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const cwd = this.f.cwd.trim();
      if (this.state === 'ready' && this.prep && cwd && cwd.startsWith('/') && cwd !== this.prep.cwd) {
        this.setStatus('Checking the folder…');
        void this.prepare(cwd);
        return;
      }
      void this.hire();
    });
    parent.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  /** M6 start: the Orchestrator tab handed over: focus on this dialog's Worker tab, as in one tab list. */
  focusTab(): void {
    this.dialog.querySelector<HTMLElement>('[data-key="tab:worker"]')?.focus();
  }

  /**
   * Opens the dialog for a desk of a floor and asks the bridge for the defaults. M7: `prefill` starts the form with a
   * first task ("Ask a worker…", "Review with a worker") and, for the review, the reviewer's harness / model / effort.
   */
  open(session: string, desk: number, prefill: HirePrefill = {}): void {
    this.session = session;
    this.desk = desk;
    this.prep = null;
    this.prepared = null;
    this.prefill = prefill;
    this.f = { prompt: prefill.prompt ?? '', harness: '', model: '', effort: '', label: '', cwd: '', worktree: false };
    this.state = 'preparing';
    this.renderedKey = '';
    this.refetching = false;
    this.setStatus('Checking the floor, the folder and origin…');
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.form.querySelector<HTMLElement>('#hire-task')?.focus();
    void this.prepare();
  }

  private title(): string {
    return `Hire a worker at Desk ${this.desk + 1}`;
  }

  private async prepare(cwd?: string): Promise<void> {
    const gen = ++this.gen;
    if (this.host.unsupported('hire.prepare')) {
      this.state = 'failed';
      this.setStatus(failureText('hire.prepare', 'unknown_command', ''), true);
      this.render();
      return;
    }
    const args: CommandArgs['hire.prepare'] = { session: this.session };
    if (cwd) args.cwd = cwd;
    const r = await this.host.send('hire.prepare', args);
    // A hire sent meanwhile: its form stays as sent.
    if (gen !== this.gen || !this.dialog.open || this.state === 'hiring') return;
    if (!r.ok) {
      // A folder that did not check out keeps the rest of the form.
      if (this.prep && cwd) {
        this.state = 'ready';
        this.setStatus(failureText('hire.prepare', r.code, r.message, { floor: this.session }), true);
        this.render();
        return;
      }
      this.state = 'failed';
      this.setStatus(failureText('hire.prepare', r.code, r.message, { floor: this.session }), true);
      this.render();
      return;
    }
    const p = r.data as HirePrepare;
    const options = this.host.store.hireOptions;
    if (this.prep && cwd) {
      // Same form, new folder (or origin fetched again): its git base, and the checkbox follows whether a worktree can be made.
      this.adoptGit(p.git);
      this.prep = { ...this.prep, cwd: p.cwd, capacity: p.capacity };
      this.f.cwd = p.cwd;
    } else {
      this.prep = p;
      const prompt = this.f.prompt;
      this.f = { ...formFromPrepare(p, options), prompt };
      this.prepared = resolveChoice(options, p.choice ?? null);
      // A reviewer's model wins over the floor's default (and is no longer "the floor default").
      const want = this.prefill.choice ? resolveChoice(options, this.prefill.choice) : null;
      if (want) {
        Object.assign(this.f, want);
        this.prepared = null;
      }
    }
    this.state = 'ready';
    this.setStatus('');
    this.render();
  }

  /** A new git answer: no worktree after a failed fetch; ticked again once it can be made again. */
  private adoptGit(g: HireGit | null): void {
    const was = this.prep ? worktreeUsable(this.prep.git) : false;
    if (this.prep) this.prep = { ...this.prep, git: g };
    if (!worktreeUsable(g)) this.f.worktree = false;
    else if (!was) this.f.worktree = true;
  }

  /** "Fetch again": `hire.prepare` for the same folder, keeping the form. */
  private async refetch(): Promise<void> {
    if (this.state !== 'ready' || !this.prep || this.refetching) return;
    this.refetching = true;
    this.setStatus('Fetching origin again…');
    this.render();
    await this.prepare(this.prep.cwd);
    if (!this.refetching) return;
    this.refetching = false;
    if (this.dialog.open) {
      this.render();
      this.dialog.querySelector<HTMLElement>(worktreeUsable(this.prep?.git ?? null) ? '#hire-worktree' : '[data-key="refetch"]')?.focus();
    }
  }

  /** The world changed: the desk may have been taken, the floor gone or asleep. */
  refresh(): void {
    if (!this.dialog.open || this.state === 'hiring') return;
    const fv = this.host.store.floorView(this.session);
    if (!fv) {
      this.close();
      this.host.toast(`${this.session} is gone.`, 'info');
      return;
    }
    if (fv.asleep) {
      this.close();
      this.host.toast(`${this.session} went to sleep; wake it to hire.`, 'info');
      return;
    }
    this.render();
  }

  /** Someone else sat down at this desk meanwhile, or another hire is on its way there: why, and the desk to offer instead. */
  private takenBy(): { why: string; next: number | null } | null {
    const fv = this.host.store.floorView(this.session);
    if (!fv || this.state === 'hiring') return null;
    const held = this.host.held(this.session);
    const seat = fv.seats[this.desk];
    const why = seat ? `${seat.name} just sat down at Desk ${this.desk + 1}.` : held.has(this.desk) ? `Another hire is already on its way to Desk ${this.desk + 1}.` : null;
    return why ? { why, next: firstFreeDesk(fv, held) } : null;
  }

  private setStatus(msg: string, error = false): void {
    this.statusText = msg;
    this.statusError = error;
    this.alertEl.hidden = !error || !msg;
    this.statusEl.hidden = error || !msg;
    (error ? this.alertEl : this.statusEl).textContent = msg;
    (error ? this.statusEl : this.alertEl).textContent = '';
  }

  private capacity(): CapacityView | null {
    return this.prep ? capacityView(this.prep.capacity, this.session) : null;
  }

  private blocker(): string | null {
    if (this.state === 'preparing') return 'Waiting for herdr-world…';
    if (this.state === 'failed') return this.statusText || 'herdr-world could not prepare the hire.';
    if (this.state === 'hiring') return 'The hire is on its way.';
    const taken = this.takenBy();
    if (taken) return taken.why;
    if (this.host.unsupported('worker.hire')) return failureText('worker.hire', 'unknown_command', '');
    return hireBlocker(this.f, this.host.store.hireOptions, this.capacity());
  }

  private gitView(g: HireGit | null): HireSummary['git'] {
    if (!g) return null;
    const n = fetchNote(g);
    return { base: baseText(g, this.host.now()), usable: worktreeUsable(g), note: n?.text ?? null, noteError: n?.error ?? false };
  }

  private noteNow(): string | null {
    const p = this.prepared;
    const same = !!p && p.harness === this.f.harness && p.model === this.f.model && p.effort === this.f.effort;
    return this.prep ? choiceNote(this.prep.choice_source, same) : null;
  }

  // ---- rendering ---------------------------------------------------------------

  private render(): void {
    const fv = this.host.store.floorView(this.session);
    const where = fv?.level ? `Floor ${fv.level.number} of ${fv.level.count} · ${fv.building?.name ?? ''}` : 'Unassigned lot';
    const taken = this.takenBy();
    const key = JSON.stringify([this.session, this.desk, this.state, this.prep, this.f.harness, this.f.model, this.f.effort, this.f.worktree, where, taken, this.statusText, this.refetching, this.host.store.limits.version]);
    // Typing (task, label, folder) only needs the button; everything else re-renders.
    if (key === this.renderedKey) {
      this.renderActions();
      return;
    }
    this.renderedKey = key;
    const a = document.activeElement;
    const focusKey = a instanceof HTMLElement && this.dialog.contains(a) ? (a.dataset.key ?? a.id) : null;

    this.head.replaceChildren(
      h('div', { class: 'dd-plate dd-plate--desk', 'aria-hidden': 'true' }, icon(DESK_PLUS), h('b', {}, String(this.desk + 1))),
      h('div', { class: 'dd-titles' }, h('h2', { id: 'hire-title' }, this.title()), h('p', { id: 'hire-sub' }, `${this.session} · ${where}`)),
      h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close)),
    );
    // M6 start: the orchestrator tab opens the start-run dialog for this desk.
    const orch = this.host.orchestrate;
    this.tabs.hidden = !orch;
    if (orch)
      this.tabs.replaceChildren(
        deskTabs(
          'worker',
          () => {
            if (this.state === 'hiring') return;
            this.close();
            orch.open(this.session, this.desk);
          },
          orch.off(),
        ),
      );

    const ready = this.state === 'ready';
    const busy = this.state === 'hiring' || this.state === 'preparing';
    const options = this.host.store.hireOptions;

    // First task: Enter hires, Shift+Enter is a new line.
    const task = h('textarea', {
      id: 'hire-task',
      'data-key': 'task',
      rows: 3,
      spellcheck: 'true',
      placeholder: 'What should they start on?',
      'aria-describedby': 'hire-task-hint',
    });
    task.value = this.f.prompt;
    task.disabled = this.state === 'hiring';
    task.addEventListener('input', () => {
      this.f.prompt = task.value;
      this.renderActions();
    });
    task.addEventListener('keydown', (e) => {
      const k = taskKey(e);
      if (k === 'send') {
        e.preventDefault();
        void this.hire();
      }
    });
    const taskField = h(
      'div',
      { class: 'dd-field dd-task' },
      h('label', { for: 'hire-task' }, 'First task ', h('span', { class: 'dd-optional' }, 'optional')),
      task,
      h('p', { class: 'field-hint', id: 'hire-task-hint' }, h('kbd', {}, 'Enter'), ' hires · ', h('kbd', {}, 'Shift'), '+', h('kbd', {}, 'Enter'), ' adds a line'),
    );

    const nodes: Node[] = [taskField];
    const notices: Node[] = [];

    if (this.prep) {
      const note = this.noteNow();
      const noteTape = note ? h('span', { class: 'tape tape--note', title: note === 'Floor default' ? 'The floor’s default hire (floor settings)' : 'What was hired on this floor last time' }, note) : null;
      const agent = h(
        'div',
        { class: 'dd-agent' },
        chips('harness', 'Harness', Object.keys(options), this.f.harness, (v) => this.pick({ harness: v }), noteTape),
        chips('model', 'Model', modelsFor(options, this.f.harness), this.f.model, (v) => this.pick({ model: v })),
        chips('effort', 'Effort', effortsFor(options, this.f.harness, this.f.model), this.f.effort, (v) => this.pick({ effort: v })),
      );
      const limits = planLimits(this.host.store.limits, [this.f.harness], this.host.now());
      const slot = h('div', { class: 'dd-plan-limits', 'data-hook': 'plan-limits' });
      if (limits) slot.append(limits);
      else slot.hidden = true;

      const label = h('input', { id: 'hire-label', 'data-key': 'label', autocomplete: 'off', spellcheck: 'false', maxlength: 64, placeholder: this.prep.label });
      label.value = this.f.label;
      label.addEventListener('input', () => {
        this.f.label = label.value;
        this.renderActions();
      });
      const cwd = h('input', { id: 'hire-cwd', 'data-key': 'cwd', autocomplete: 'off', spellcheck: 'false', placeholder: '/home/…', 'aria-describedby': 'hire-cwd-hint' });
      cwd.value = this.f.cwd;
      cwd.addEventListener('input', () => {
        this.f.cwd = cwd.value;
        this.renderActions();
      });
      // A new folder: check again whether it is a repo, and its base.
      cwd.addEventListener('change', () => {
        const v = cwd.value.trim();
        if (v && v.startsWith('/') && v !== this.prep?.cwd) {
          this.setStatus('Checking the folder…');
          void this.prepare(v);
        }
      });
      const ids = h(
        'div',
        { class: 'dd-grid' },
        h('div', { class: 'dd-field' }, h('label', { for: 'hire-label' }, 'Label'), label, h('p', { class: 'field-hint' }, 'Its workspace label in herdr.')),
        h('div', { class: 'dd-field' }, h('label', { for: 'hire-cwd' }, 'Folder'), cwd, h('p', { class: 'field-hint', id: 'hire-cwd-hint' }, 'Where the agent starts, on the server.')),
      );
      nodes.push(agent, slot, ids);

      const g = this.gitView(this.prep.git);
      if (g) {
        const on = this.f.worktree && g.usable;
        const box = h('input', { type: 'checkbox', id: 'hire-worktree', 'data-key': 'worktree', 'aria-describedby': g.usable ? 'hire-worktree-base' : 'hire-worktree-base hire-fetch' });
        box.checked = on;
        // No worktree from a stale origin: off until a fetch goes through.
        box.disabled = !g.usable;
        box.addEventListener('change', () => {
          this.f.worktree = box.checked;
          this.render();
        });
        const wt = h(
          'div',
          { class: 'dd-worktree', 'data-on': on ? 'true' : 'false', 'data-off': g.usable ? null : 'true' },
          h('label', { class: 'dd-check', for: 'hire-worktree' }, box, h('span', { class: 'dd-check-box', 'aria-hidden': 'true' }), h('span', {}, 'Work in its own git worktree & branch')),
          h(
            'p',
            { class: 'dd-base', id: 'hire-worktree-base' },
            !g.usable ? 'Off: origin could not be fetched. Last fetched ' : on ? 'A new h3d/… branch from ' : 'Would branch from ',
            h('code', {}, g.base),
          ),
        );
        nodes.push(wt);
        if (g.note)
          notices.push(
            h(
              'div',
              { class: 'dd-callout dd-callout--error dd-fetch', id: 'hire-fetch', role: 'alert' },
              h('p', {}, g.note),
              h('button', { class: 'btn btn--sm', 'data-key': 'refetch', disabled: this.refetching || this.state !== 'ready', onclick: () => void this.refetch() }, this.refetching ? 'Fetching…' : 'Fetch again'),
            ),
          );
      }
      notices.push(this.capacityBlock());
    } else {
      nodes.push(h('div', { class: 'dd-skeleton', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
    }
    if (taken && ready) {
      const alt = taken.next;
      notices.unshift(
        h(
          'div',
          { class: 'dd-callout dd-callout--error', role: 'alert' },
          h('p', {}, taken.why),
          alt !== null ? h('button', { class: 'btn btn--sm', 'data-key': 'other-desk', onclick: () => this.moveTo(alt) }, `Hire at Desk ${alt + 1} instead`) : h('p', {}, 'No other desk is free on this floor.'),
        ),
      );
    }
    this.form.replaceChildren(...nodes);
    this.notices.replaceChildren(...notices);
    for (const el of this.form.querySelectorAll<HTMLInputElement>('input, textarea')) if ((busy || this.refetching) && el.id !== 'hire-task') el.disabled = true;
    this.renderActions();
    if (focusKey) {
      const back = this.dialog.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`) ?? this.dialog.querySelector<HTMLElement>(`#${CSS.escape(focusKey)}`);
      back?.focus();
      // A chip group re-rendered on another pick: focus its checked chip.
      if (!back && focusKey.includes(':')) this.form.querySelector<HTMLElement>(`[data-pick="${focusKey.split(':')[0]}"] input:checked`)?.focus();
    }
  }

  private capacityBlock(): HTMLElement {
    const c = this.capacity() as CapacityView;
    const p = this.prep as HirePrepare;
    const facts = `${this.session}: ${p.capacity.floor.count} of ${p.capacity.floor.soft} · host: ${p.capacity.host.count} of ${p.capacity.host.soft}${c.load ? ` · ${c.load}` : ''}`;
    if (c.level === 'ok') return h('p', { class: 'dd-capacity', 'data-level': 'ok' }, facts);
    const tape = c.level === 'full' ? 'At the hard cap' : 'Over the soft cap';
    return h(
      'div',
      { class: 'dd-capacity dd-callout', 'data-level': c.level, role: c.level === 'full' ? 'alert' : null },
      h('p', {}, h('span', { class: `tape tape--cap-${c.level}` }, tape), ' ', c.lines.join(' ')),
      h('p', { class: 'dd-capacity-facts' }, facts),
    );
  }

  private renderActions(): void {
    const blocker = this.blocker();
    const label = this.f.label.trim() || this.prep?.label || '';
    const cancel = h('button', { class: 'btn', 'data-key': 'cancel', onclick: () => this.close() }, this.state === 'hiring' ? 'Close' : 'Cancel');
    const text = this.state === 'hiring' ? 'Hiring…' : label ? `Hire ${label}` : 'Hire';
    const hire = h('button', { class: 'btn btn--primary', type: 'submit', form: 'hire-form', 'data-key': 'hire', 'aria-disabled': blocker ? 'true' : null, title: blocker }, text);
    const had = document.activeElement === this.hireBtn;
    this.hireBtn = hire;
    const retry = this.state === 'failed' && !this.host.unsupported('hire.prepare') ? h('button', { class: 'btn', 'data-key': 'retry', onclick: () => this.retry() }, 'Try again') : null;
    this.actions.replaceChildren(...[retry, cancel, hire].filter((x): x is HTMLButtonElement => !!x));
    if (had) hire.focus();
  }

  private retry(): void {
    this.state = 'preparing';
    this.setStatus('Checking the floor, the folder and origin…');
    this.render();
    void this.prepare();
  }

  private pick(p: Partial<Pick<HireForm, 'harness' | 'model' | 'effort'>>): void {
    const options = this.host.store.hireOptions;
    const next = resolveChoice(options, { harness: p.harness ?? this.f.harness, model: p.model ?? this.f.model, effort: p.effort ?? this.f.effort });
    if (!next) return;
    this.f = { ...this.f, ...next };
    this.render();
  }

  private moveTo(desk: number): void {
    this.desk = desk;
    this.setStatus('');
    this.render();
    this.form.querySelector<HTMLElement>('#hire-task')?.focus();
  }

  private async hire(): Promise<void> {
    if (this.state !== 'ready' || !this.prep) return;
    const blocker = this.blocker();
    if (blocker) {
      this.setStatus(blocker, true);
      this.renderActions();
      return;
    }
    const session = this.session;
    const desk = this.desk;
    const args = hireArgs(session, desk, this.f, this.prep.git);
    const who = args.label ?? this.prep.label;
    this.state = 'hiring';
    const release = this.host.reserve(session, desk);
    const steps = [args.worktree ? 'creating the worktree' : null, `starting ${args.harness}`, args.prompt ? 'handing over the first task' : null].filter(Boolean);
    this.setStatus(`Hiring ${who}: ${steps.join(', ')}…`);
    this.render();
    const gen = this.gen;
    const r = await this.host.send('worker.hire', args);
    release();
    // Esc'd meanwhile (and maybe another hire opened): only a toast, this dialog is someone else's now.
    const still = this.dialog.open && gen === this.gen;
    if (still) this.state = 'ready';
    if (r.ok) {
      const ack = r.data as HireAck | undefined;
      const w = ack?.id ? this.host.store.workerView(ack.id) : null;
      const name = w?.name ?? who;
      const branch = ack?.branch ? ` on ${ack.branch}` : '';
      const extra = [
        ack?.prompted === false ? `The first task was not sent (${ack.prompt_error ?? 'no reason given'}): prompt them yourself.` : '',
      ].filter(Boolean);
      if (still) this.close();
      this.host.toast([`Hired ${name} at Desk ${(w?.desk ?? desk) + 1}${branch}. Here they come.`, ...extra].join(' '), extra.length ? 'error' : 'info');
      return;
    }
    const msg = failureText('worker.hire', r.code, r.message, { floor: session, desk: desk + 1 });
    if (!still) {
      this.host.toast(msg, 'error');
      return;
    }
    this.setStatus(msg, true);
    this.render();
    if (r.code === 'capacity' || r.code === 'fetch_failed') void this.recheck();
  }

  /** After a capacity or fetch refusal: the caps and origin as they are now (the refusal stays in the status). */
  private async recheck(): Promise<void> {
    const gen = this.gen;
    const args: CommandArgs['hire.prepare'] = { session: this.session };
    if (this.prep?.cwd) args.cwd = this.prep.cwd;
    const r = await this.host.send('hire.prepare', args);
    if (!r.ok || !this.prep || !this.dialog.open || gen !== this.gen || this.state !== 'ready') return;
    const p = r.data as HirePrepare;
    this.adoptGit(p.git);
    this.prep = { ...this.prep, capacity: p.capacity };
    this.render();
  }

  // ---- test hook -----------------------------------------------------------------

  summary(): HireSummary | null {
    if (!this.dialog.open) return null;
    return {
      kind: 'hire',
      session: this.session,
      desk: this.desk,
      title: this.title(),
      state: this.state,
      form: { ...this.f },
      git: this.prep ? this.gitView(this.prep.git) : null,
      refetching: this.refetching,
      choiceNote: this.noteNow(),
      capacity: this.capacity(),
      blocker: this.blocker(),
      status: this.statusText,
      error: this.statusError,
    };
  }
}
