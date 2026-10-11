import type { CommandArgs, HireGit, HireInterpretation, HirePrepare } from '../net/protocol';
import { capacityView, capBlocker, firstFreeDesk, formFromPrepare, hireArgs, hireBlocker, HARNESS_LABEL, modelsFor, offeredOptions, optionsBlocker, promptBlocker, resolveHireDesk, worktreeUsable, type CapacityView, type HireForm } from '../world/hire';
import {
  applyInterpretation,
  editTask,
  effortChoices,
  effortOk,
  EFFORT_QUESTION,
  fromInterpretation,
  harnessOk,
  modelOk,
  needsAttention,
  ORIGIN_LABEL,
  pickEffort,
  pickHarness,
  pickModel,
  revalidate,
  REVIEW_SECTIONS,
  taskOk,
  taskPreview,
  type Origin,
  type ReviewChoice,
  type ReviewSection,
} from '../world/hireReview';
import { labelsOf, modelLabel } from '../world/modelLabel';
import { backdropPolicy } from './dismiss';
import { h, icon, ICON, replaceKeepingFocus } from './dom';
import { HIRE_PROMPT_MAX_BYTES } from './composer/model';
import { capacityBlock, chips, gitView, modelField, worktreeControl, type HireHost, type HireSummary } from './hire';
import { HireCoordinator, notPromptedText, type HireOutcome } from './hireCoordinator';
import { hiredToast } from './hiredToast';
import { failureText } from './messages';

/**
 * #212: the review of a dictated hire. One accordion dialog over a pending hire: the interpreter's proposal (#211) → review
 * → an explicit Hire → the hire coordinator (#210), the one way a hire is launched. Opening it, interpreting, picking a
 * value, answering a follow-up, folding a section and pressing Enter in a field never send `worker.hire`; only the Hire
 * button does, once.
 *
 * What it reuses from the hire dialog (ui/hire.ts, world/hire.ts): the chip and model pickers with their readable names (#200)
 * and Settings' hidden models (#194), `hire.prepare` for the folder, label, worktree and caps, the desk rules
 * (`resolveHireDesk`), `hireArgs` and `hireBlocker`, and the coordinator for the desk's hold, background mode and outcomes.
 *
 * What it does not: `resolveChoice` / `resolveVisibleChoice`. Those pick a model and an effort for a form that must be
 * valid; here a value that is missing or not valid stays empty, its section stays open, and only the human fills it
 * (world/hireReview.ts). Sections start collapsed when their value is valid and open when it is not.
 *
 * Late answers (the interpreter's, `hire.prepare`'s) are guarded by a counter: an `epoch` that every open and close bumps,
 * and the review's edit count (`ticket`), so a reply never changes a field the human edited after it was asked for.
 */

/** The sections' titles. */
const TITLE: Record<ReviewSection, string> = { agent: 'Harness and model', effort: 'Effort', task: 'Task', where: 'Location and options' };

export type ReviewState = 'preparing' | 'ready' | 'hiring' | 'failed';

/** What a request to the interpreter was made against: the answer is only for this review, as the human left it then. */
export interface ReviewTicket {
  readonly epoch: number;
  readonly rev: number;
}

/** What the review shows (test hook). */
export interface ReviewSummary {
  kind: 'hire-review';
  session: string;
  desk: number;
  state: ReviewState;
  choice: ReviewChoice;
  form: HireForm;
  sections: Array<{ id: ReviewSection; title: string; open: boolean; attention: boolean; summary: string; origin: string }>;
  git: HireSummary['git'];
  capacity: CapacityView | null;
  /** Why Hire is off, null when it can be pressed. */
  blocker: string | null;
  status: string;
  error: boolean;
}

export class HireReviewDialog {
  private readonly dialog = h('dialog', { class: 'desk-dlg desk-dlg--review', 'aria-labelledby': 'review-title', 'aria-describedby': 'review-sub' });
  private readonly head = h('header', { class: 'dd-head' });
  private readonly body = h('div', { class: 'dd-body rv-body' });
  private readonly statusEl = h('p', { class: 'dd-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private readonly notices = h('div', { class: 'dd-notices' });
  private readonly actions = h('div', { class: 'dd-actions' });
  private readonly foot = h('footer', { class: 'dd-foot' }, this.notices, this.statusEl, this.alertEl, this.actions);
  private readonly sections = new Map<ReviewSection, { root: HTMLElement; toggle: HTMLButtonElement; panel: HTMLElement; sum: HTMLElement; tape: HTMLElement }>();
  /** The task: one editor for the whole review, never rebuilt (its caret and scroll stay while the rest redraws). */
  private readonly taskEl = h('textarea', { id: 'review-task', class: 'rv-task', 'data-key': 'task', rows: 6, spellcheck: 'true', 'aria-describedby': 'review-task-hint', 'aria-label': 'Task, the complete text' });
  private readonly panelKeys = new Map<string, string>();

  private session = '';
  private desk = 0;
  private state: ReviewState = 'preparing';
  private prep: HirePrepare | null = null;
  private choice: ReviewChoice = fromInterpretation(EMPTY, {});
  /** Sections the human has open (several at once); it grows when a section needs a choice, and only the human closes one. */
  private openSet = new Set<ReviewSection>();
  private f = { label: '', cwd: '', worktree: false };
  /** What of the options the human changed: the rest is the bridge's default. */
  private changed = { label: false, cwd: false, worktree: false };
  /** The interpretation as it came (a follow-up goes back to the interpreter with it). */
  private pending: HireInterpretation | null = null;
  /** The choices to keep offered when Settings hides their model (the dictated one stays on the list). */
  private keep: Array<{ harness: string; model: string }> = [];
  private statusText = '';
  private statusError = false;
  private refetching = false;
  private modelQuery = '';
  /** Bumped by every open and close: an answer asked for earlier is for a review that is gone. */
  private epoch = 0;
  /** Bumped by every `hire.prepare` (the answer of the latest one is the one that counts). */
  private prepGen = 0;
  /** Bumped by every keystroke in the folder: a folder check is for the folder it was asked about, never a newer one. */
  private folderRev = 0;
  /** A check of a folder (or a fetch again) is on its way: Hire waits for it. */
  private checking = false;
  /** The folder the prepare's git and worktree state is for: a different one in the form waits for its own check. */
  private checked: string | null = null;
  /** What an empty Folder means: the folder the first prepare chose (the server's default for this floor). */
  private defaultCwd = '';
  private hadWhereIssue = false;
  private readonly hires: HireCoordinator;
  private static serial = 0;
  private readonly id = ++HireReviewDialog.serial;

  constructor(
    parent: HTMLElement,
    private readonly host: HireHost,
  ) {
    this.hires =
      host.hires ??
      new HireCoordinator({
        send: (t, args) => host.send(t, args),
        reserve: (s, d) => host.reserve(s, d),
        toast: (m, kind) => host.toast(m, kind),
        beep: () => host.beep?.(),
        workerView: (id) => host.store.workerView(id),
        holdTask: (id, text, from) => host.holdTask?.(id, text, from) ?? false,
      });
    this.host.modelPrefs?.onChange(() => this.dialog.open && this.state !== 'hiring' && this.render());
    this.alertEl.hidden = true;
    this.statusEl.hidden = true;
    for (const id of REVIEW_SECTIONS) this.body.append(this.buildSection(id));
    this.buildTask();
    this.dialog.append(this.head, this.body, this.foot);
    this.dialog.addEventListener('close', () => {
      if (!this.dialog.open) this.epoch++;
    });
    this.dialog.addEventListener('cancel', () => {
      // Esc while the hire is on its way: the hire still happens; the dialog just goes.
      if (this.state === 'hiring') this.host.toast('The hire is still on its way; the worker shows up at the desk when it is done.', 'info');
    });
    // Typed text and consequential choices in here: only the close button, Cancel and Esc close it, never the backdrop.
    backdropPolicy(this.dialog, 'none');
    parent.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  /** Cancel: the pending hire is dropped (nothing was sent; a hire already on its way is not undone). */
  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  // ---- the pending hire -----------------------------------------------------------

  /**
   * Opens the review of `interp` for a desk of a floor (no `desk`: the first free one). A floor that is asleep, a desk
   * somebody sits at or another hire is on its way to is not opened: the toast says why (false). Nothing is sent but
   * `hire.prepare` (the folder, the name, the caps).
   */
  /** #223 `seed`: "Hire from handoff": the starting choice (`fromHandoff`) and the folder, instead of the proposal's. */
  open(session: string, interp: HireInterpretation, desk?: number, seed?: { choice?: ReviewChoice; cwd?: string }): boolean {
    const seat = resolveHireDesk(session, this.host.store.floorView(session), this.host.held(session), desk);
    if (!seat.ok) {
      this.host.toast(seat.msg, 'info');
      return false;
    }
    this.epoch++;
    this.session = session;
    this.desk = seat.desk;
    this.prep = null;
    this.pending = interp;
    this.choice = seed?.choice ?? fromInterpretation(interp, this.host.store.hireOptions);
    this.keep = [{ harness: this.choice.harness, model: this.choice.model }];
    this.openSet = needsAttention(this.choice, this.host.store.hireOptions, this.taskIssue());
    this.f = { label: '', cwd: seed?.cwd ?? '', worktree: false };
    this.changed = { label: false, cwd: !!seed?.cwd, worktree: false };
    this.modelQuery = '';
    this.refetching = false;
    this.hadWhereIssue = false;
    this.checking = false;
    this.checked = null;
    this.defaultCwd = '';
    this.state = 'preparing';
    this.panelKeys.clear();
    this.taskEl.value = this.choice.task;
    this.setStatus('Checking the floor, the folder and origin…');
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.focusFirst();
    void this.prepare(seed?.cwd || undefined);
    return true;
  }

  /**
   * #213: the proposal this review holds, for a dictated follow-up ("high") to go back to the interpreter with as
   * `pending`. The review owns it: closed (Cancel, Esc, a hire that landed), there is none.
   */
  pendingInterpretation(): HireInterpretation | null {
    return this.dialog.open ? this.pending : null;
  }

  /** The state of the review now, for a request to the interpreter: its answer goes to `apply` with this ticket. */
  begin(): ReviewTicket | null {
    return this.dialog.open ? { epoch: this.epoch, rev: this.choice.rev } : null;
  }

  /**
   * A later interpretation (a follow-up reply, a slow answer) for a `ticket` taken when the request was made. It fills
   * or changes only what the human did not edit since, never launches, and opens a section that needs a choice. False:
   * the review it was for is gone.
   */
  apply(interp: HireInterpretation, ticket: ReviewTicket): boolean {
    if (!this.dialog.open || ticket.epoch !== this.epoch || this.state === 'hiring') return false;
    this.pending = interp;
    this.keep.push({ harness: interp.harness.value ?? '', model: interp.model.value ?? '' });
    this.choice = applyInterpretation(this.choice, interp, this.host.store.hireOptions, ticket.rev);
    // The editor shows the task as it is; one the human is typing in is theirs and was not replaced (`edited`).
    if (this.taskEl.value !== this.choice.task) this.taskEl.value = this.choice.task;
    this.reopen();
    this.render();
    return true;
  }

  /**
   * An effort said instead of clicked (phase 4's follow-up, "high"): taken like a click when the model supports it, with
   * its source `dictated`. False (nothing changes, the section stays as it is) when it does not or no model is chosen.
   */
  answerEffort(effort: string): boolean {
    if (!this.dialog.open || this.state === 'hiring') return false;
    const next = pickEffort(this.choice, effort, this.host.store.hireOptions, 'dictated');
    if (!next) return false;
    this.choice = next;
    this.render();
    return true;
  }

  /** Sections that need a choice are opened; the human's open ones stay open. */
  private reopen(): void {
    for (const s of needsAttention(this.choice, this.host.store.hireOptions, this.taskIssue())) this.openSet.add(s);
  }

  // ---- prepare -----------------------------------------------------------------------

  private async prepare(cwd?: string): Promise<void> {
    const gen = ++this.prepGen;
    const epoch = this.epoch;
    const folder = this.folderRev;
    if (this.host.unsupported('hire.prepare')) {
      this.state = 'failed';
      this.setStatus(failureText('hire.prepare', 'unknown_command', ''), true);
      this.render();
      return;
    }
    const args: CommandArgs['hire.prepare'] = { session: this.session };
    if (cwd) args.cwd = cwd;
    this.checking = !!cwd && !!this.prep;
    const r = await this.host.send('hire.prepare', args);
    // A newer prepare, a closed or reopened review, a hire sent meanwhile, a folder typed since: this answer is not for what is on screen.
    if (gen !== this.prepGen || epoch !== this.epoch || !this.dialog.open || this.state === 'hiring' || folder !== this.folderRev) return;
    this.checking = false;
    if (!r.ok) {
      this.state = this.prep && cwd ? 'ready' : 'failed';
      this.setStatus(failureText('hire.prepare', r.code, r.message, { floor: this.session }), true);
      this.render();
      return;
    }
    const p = r.data as HirePrepare;
    if (this.prep && cwd) {
      // Same review, new folder (or origin fetched again): its git base; the worktree follows whether it can be made.
      this.adoptGit(p.git);
      this.prep = { ...this.prep, cwd: p.cwd, capacity: p.capacity };
      this.checked = p.cwd;
      // An empty Folder stays the default; a typed one is shown as the server read it.
      if (this.f.cwd.trim()) this.f.cwd = p.cwd;
    } else {
      this.prep = p;
      this.checked = p.cwd;
      this.defaultCwd = p.cwd;
      // The bridge's defaults for the options (name, folder, worktree): the agent's choice is never taken from them.
      const d = formFromPrepare(p, this.host.store.hireOptions, this.host.hirePrefs?.worktreeByDefault);
      if (!this.changed.label) this.f.label = d.label;
      if (!this.changed.cwd) this.f.cwd = d.cwd;
      if (!this.changed.worktree) this.f.worktree = d.worktree;
    }
    this.state = 'ready';
    this.setStatus('');
    this.render();
  }

  /** A new git answer: no worktree after a failed fetch; restore the configured default once it can be made again. */
  private adoptGit(g: HireGit | null): void {
    const was = this.prep ? worktreeUsable(this.prep.git) : false;
    if (this.prep) this.prep = { ...this.prep, git: g };
    if (!worktreeUsable(g)) this.f.worktree = false;
    else if (!was) this.f.worktree = this.host.hirePrefs?.worktreeByDefault ?? true;
  }

  /** The folder the form stands for: what is typed, or the default when it is empty (null: not an absolute path, optionsBlocker says so). */
  private effectiveCwd(): string | null {
    const v = this.f.cwd.trim();
    if (!v) return this.defaultCwd || null;
    return v.startsWith('/') ? v : null;
  }

  /**
   * The one way a prepare for a folder starts after the first: for the folder the form stands for now. The git and
   * worktree state stays that of `checked`, and Hire waits (folderBlocker) until the answer for this folder replaces it;
   * an answer for any other folder or revision is dropped. `again`: the same folder once more (origin fetched again).
   */
  private checkFolder(again = false): Promise<void> | null {
    if (!this.prep) return null;
    const cwd = this.effectiveCwd();
    if (!cwd || (cwd === this.checked && !again)) return null;
    this.setStatus(again ? 'Fetching origin again…' : 'Checking the folder…');
    return this.prepare(cwd);
  }

  private async refetch(): Promise<void> {
    if (this.state !== 'ready' || !this.prep || this.refetching) return;
    this.refetching = true;
    const check = this.checkFolder(true);
    this.render();
    await check;
    this.refetching = false;
    if (this.dialog.open) this.render();
  }

  /** The world changed: the desk may have been taken, the floor gone or asleep, a model left the catalog. */
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
    // A model or harness that left the catalog is cleared and asked for again; what is still there stays as the human left it.
    const next = revalidate(this.choice, this.host.store.hireOptions);
    if (next !== this.choice) {
      this.choice = next;
      this.reopen();
    }
    this.render();
  }

  /** Someone sat down at the desk meanwhile, or another hire is on its way there: why, and the desk to offer instead. */
  private takenBy(): { why: string; next: number | null } | null {
    const fv = this.host.store.floorView(this.session);
    if (!fv || this.state === 'hiring') return null;
    const held = this.host.held(this.session);
    const seat = fv.seats[this.desk];
    const why = seat ? `${seat.name} just sat down at Desk ${this.desk + 1}.` : held.has(this.desk) ? `Another hire is already on its way to Desk ${this.desk + 1}.` : null;
    return why ? { why, next: firstFreeDesk(fv, held) } : null;
  }

  private capacity(): CapacityView | null {
    return this.prep ? capacityView(this.prep.capacity, this.session) : null;
  }

  private setStatus(msg: string, error = false): void {
    this.statusText = msg;
    this.statusError = error;
    this.alertEl.hidden = !error || !msg;
    this.statusEl.hidden = error || !msg;
    (error ? this.alertEl : this.statusEl).textContent = msg;
    (error ? this.statusEl : this.alertEl).textContent = '';
  }

  // ---- what the form says ------------------------------------------------------------

  /** The catalog the pickers offer: the models Settings leaves shown, and the ones this review holds even when hidden. */
  private offered() {
    const cat = this.host.store.hireOptions;
    const prefs = this.host.modelPrefs;
    return prefs ? offeredOptions(cat, (harness) => prefs.hidden(harness), [...this.keep, { harness: this.choice.harness, model: this.choice.model }]) : cat;
  }

  private form(): HireForm {
    return { prompt: this.choice.task, harness: this.choice.harness, model: this.choice.model, effort: this.choice.effort, label: this.f.label, cwd: this.f.cwd, worktree: this.f.worktree };
  }

  /** Why Hire is off, in the order of the sections. */
  private blocker(): string | null {
    const cat = this.host.store.hireOptions;
    const c = this.choice;
    if (this.state === 'hiring') return 'The hire is on its way.';
    if (!harnessOk(c, cat)) return 'Choose a harness.';
    if (!modelOk(c, cat)) return 'Choose a model.';
    if (!effortOk(c, cat)) return 'Choose an effort.';
    if (!taskOk(c)) return 'Say what the agent should work on.';
    const taskIssue = this.taskIssue();
    if (taskIssue) return taskIssue;
    if (this.state === 'preparing') return 'Waiting for herdr-world…';
    if (this.state === 'failed') return this.statusText || 'herdr-world could not prepare the hire.';
    const taken = this.takenBy();
    if (taken) return taken.why;
    const folder = this.folderBlocker();
    if (folder) return folder;
    if (this.host.unsupported('worker.hire')) return failureText('worker.hire', 'unknown_command', '');
    return hireBlocker(this.form(), cat, this.capacity());
  }

  /**
   * Hire waits for the folder as it stands: its repo check and the options that follow from it (a worktree) are for the
   * folder that was checked, never for another typed since (the hire dialog sends only after the same check).
   */
  private folderBlocker(): string | null {
    if (this.checking) return 'Checking the folder…';
    const cwd = this.effectiveCwd();
    if (this.prep && cwd && cwd !== this.checked) return 'The folder has not been checked yet: press Tab or click away from it.';
    return null;
  }

  /** The options' own problem (a folder, a label, a taken desk, the caps, no prepare): its section opens. */
  private whereIssue(): string | null {
    if (this.state === 'failed') return this.statusText || 'herdr-world could not prepare the hire.';
    const taken = this.takenBy();
    if (taken) return taken.why;
    return this.prep ? (capBlocker(this.capacity()) ?? optionsBlocker(this.form())) : null;
  }

  /** The task's own problem beyond being empty: herdr would read it as a flag, or it is too long. */
  private taskIssue(): string | null {
    if (new TextEncoder().encode(this.choice.task).length > HIRE_PROMPT_MAX_BYTES) return 'The task is too long to send.';
    return promptBlocker(this.choice.task);
  }

  // ---- rendering ---------------------------------------------------------------------

  private buildSection(id: ReviewSection): HTMLElement {
    const sum = h('span', { class: 'rv-sum' });
    const tape = h('span', { class: 'tape rv-origin' });
    const toggle = h(
      'button',
      {
        class: 'rv-toggle',
        id: `review-${id}-h`,
        'data-key': `sec:${id}`,
        'aria-expanded': 'false',
        'aria-controls': `review-${id}-p`,
        onclick: () => this.toggle(id),
      },
      h('span', { class: 'rv-chev', 'aria-hidden': 'true' }, icon(ICON.chevron)),
      h('span', { class: 'rv-title' }, TITLE[id]),
      sum,
      tape,
    );
    const panel = h('div', { class: 'rv-panel', id: `review-${id}-p`, role: 'region', 'aria-labelledby': `review-${id}-h`, hidden: true });
    const root = h('section', { class: 'rv-sec', 'data-section': id }, h('h3', { class: 'rv-h' }, toggle), panel);
    this.sections.set(id, { root, toggle, panel, sum, tape });
    return root;
  }

  private buildTask(): void {
    const panel = this.sections.get('task')!.panel;
    this.taskEl.addEventListener('input', () => {
      this.choice = editTask(this.choice, this.taskEl.value);
      this.syncSections();
      this.renderActions();
    });
    panel.append(
      h('div', { class: 'dd-field' }, h('label', { for: 'review-task' }, 'The complete task'), this.taskEl, h('p', { class: 'field-hint', id: 'review-task-hint' }, 'Sent to the agent as its first task, exactly as written here. ', h('kbd', {}, 'Enter'), ' adds a line.')),
      h('p', { class: 'rv-prov', 'data-hook': 'task-origin' }),
    );
  }

  private toggle(id: ReviewSection): void {
    if (this.openSet.has(id)) this.openSet.delete(id);
    else this.openSet.add(id);
    this.syncSections();
  }

  /** The value of each section as its collapsed header says it, and where it came from. */
  private sectionText(id: ReviewSection): { sum: string; origins: Origin[]; extra?: string } {
    const c = this.choice;
    const cat = this.host.store.hireOptions;
    switch (id) {
      case 'agent': {
        const h = c.harness ? (HARNESS_LABEL[c.harness] ?? c.harness) : '';
        const m = c.model ? modelLabel(c.harness, c.model, labelsOf(cat, c.harness)) : '';
        const miss = !c.harness ? `Choose a harness${c.said.harness ? ` (“${c.said.harness}” is not available)` : ''}` : !m ? `no model chosen${c.said.model ? ` (“${c.said.model}” is not available)` : ''}` : '';
        return { sum: [h, m].filter(Boolean).join(' · ') + (miss ? `${h ? ' · ' : ''}${miss}` : ''), origins: [c.origin.harness, c.origin.model] };
      }
      case 'effort':
        return { sum: c.effort ? (effortOk(c, cat) || !c.model ? c.effort : `${c.effort} (not supported)`) : c.said.effort ? `Not chosen yet (“${c.said.effort}” is not supported)` : 'Not chosen yet', origins: [c.origin.effort] };
      case 'task':
        return { sum: c.task.trim() ? taskPreview(c.task) : 'No task yet', origins: [c.origin.task] };
      case 'where': {
        const fv = this.host.store.floorView(this.session);
        const label = this.f.label.trim() || this.prep?.label;
        const wt = this.prep?.git ? (this.f.worktree && worktreeUsable(this.prep.git) ? 'own worktree' : 'no worktree') : null;
        const sum = [`Desk ${this.desk + 1}`, fv?.level ? `Floor ${fv.level.number}` : this.session, label, this.f.cwd.trim(), wt].filter(Boolean).join(' · ');
        const mine = this.changed.label || this.changed.cwd || this.changed.worktree;
        return { sum, origins: [mine ? 'chosen' : 'default'] };
      }
    }
  }

  private originText(id: ReviewSection, origins: Origin[]): string {
    if (id === 'where') return origins[0] === 'chosen' ? 'Floor · your choices' : 'Floor · defaults';
    return [...new Set(origins)].map((o) => ORIGIN_LABEL[o]).join(' · ');
  }

  /** Headers (summary, origin, open, attention) of every section, from the state: cheap, it never touches a panel. */
  private syncSections(): void {
    const need = needsAttention(this.choice, this.host.store.hireOptions, this.taskIssue());
    const issue = !!this.whereIssue();
    if (issue && !this.hadWhereIssue) this.openSet.add('where');
    this.hadWhereIssue = issue;
    if (issue) need.add('where');
    for (const id of REVIEW_SECTIONS) {
      const s = this.sections.get(id)!;
      const t = this.sectionText(id);
      const open = this.openSet.has(id);
      s.sum.textContent = t.sum;
      s.sum.title = t.sum;
      s.tape.textContent = this.originText(id, t.origins);
      const bad = t.origins.some((o) => o === 'missing' || o === 'invalid') || (id === 'where' && issue);
      s.tape.dataset.origin = bad ? 'attention' : (t.origins[0] ?? 'default');
      s.toggle.setAttribute('aria-expanded', String(open));
      s.panel.hidden = !open;
      s.root.dataset.open = String(open);
      s.root.dataset.attention = String(need.has(id));
    }
    const prov = this.sections.get('task')!.panel.querySelector<HTMLElement>('[data-hook="task-origin"]');
    if (prov) prov.replaceChildren(this.originTape(this.choice.origin.task), ' ', this.choice.origin.task === 'dictated' ? 'Cut from what you said, word for word.' : this.choice.origin.task === 'handoff' ? 'Reads the handoff file, then goes on with the work.' : '');
  }

  private originTape(o: Origin, text = ORIGIN_LABEL[o]): HTMLElement {
    return h('span', { class: 'tape rv-origin', 'data-origin': o === 'missing' || o === 'invalid' ? 'attention' : o }, text);
  }

  /** A panel is rebuilt only when what it shows changed; the focus stays on the same control. */
  private panel(id: ReviewSection, key: unknown, build: () => Node[]): void {
    const k = JSON.stringify(key);
    if (this.panelKeys.get(id) === k) return;
    this.panelKeys.set(id, k);
    replaceKeepingFocus(this.sections.get(id)!.panel, build());
  }

  private render(): void {
    const fv = this.host.store.floorView(this.session);
    const where = fv?.level ? `Floor ${fv.level.number} of ${fv.level.count} · ${fv.building?.name ?? ''}` : 'Unassigned lot';
    this.head.replaceChildren(
      h('div', { class: 'dd-plate dd-plate--desk', 'aria-hidden': 'true' }, icon('<path d="M12 5v14M5 12h14"/>'), h('b', {}, String(this.desk + 1))),
      h('div', { class: 'dd-titles' }, h('h2', { id: 'review-title' }, `Review the hire at Desk ${this.desk + 1}`), h('p', { id: 'review-sub' }, `${this.session} · ${where}`)),
      h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close)),
    );
    const busy = this.state === 'hiring';
    const c = this.choice;
    const cat = this.host.store.hireOptions;
    const offered = this.offered();
    const taken = this.takenBy();

    this.panel('agent', [c.harness, c.model, c.origin.harness, c.origin.model, c.said.harness, c.said.model, labelsOf(cat, c.harness), this.host.modelPrefs?.version, busy, this.keep.length], () => this.agentPanel(offered));
    this.panel('effort', [c.harness, c.model, c.effort, c.origin.effort, c.said.effort, busy, this.pending?.questions.find((q) => q.field === 'effort')?.text], () => this.effortPanel());
    this.panel('where', [this.session, this.desk, this.state, this.prep, this.f.worktree, this.refetching, taken, this.host.store.limits.version, busy, where], () => this.wherePanel(taken));
    this.taskEl.disabled = busy;
    this.syncSections();

    const notices: Node[] = [];
    if (taken && this.state === 'ready') {
      const alt = taken.next;
      notices.push(
        h(
          'div',
          { class: 'dd-callout dd-callout--error', role: 'alert' },
          h('p', {}, taken.why),
          alt !== null ? h('button', { class: 'btn btn--sm', 'data-key': 'other-desk', onclick: () => this.moveTo(alt) }, `Hire at Desk ${alt + 1} instead`) : h('p', {}, 'No other desk is free on this floor.'),
        ),
      );
    }
    const g = this.prep ? gitView(this.prep.git, this.host.now()) : null;
    if (g?.note)
      notices.push(
        h(
          'div',
          { class: 'dd-callout dd-callout--error dd-fetch', id: 'hire-fetch', role: 'alert' },
          h('p', {}, g.note),
          h('button', { class: 'btn btn--sm', 'data-key': 'refetch', disabled: this.refetching || this.state !== 'ready', onclick: () => void this.refetch() }, this.refetching ? 'Fetching…' : 'Fetch again'),
        ),
      );
    if (this.prep) notices.push(capacityBlock(this.capacity() as CapacityView, this.prep, this.session));
    this.notices.replaceChildren(...notices);
    this.renderActions();
  }

  private agentPanel(offered: ReturnType<HireReviewDialog['offered']>): Node[] {
    const c = this.choice;
    const nodes: Node[] = [];
    const busy = this.state === 'hiring';
    nodes.push(chips('harness', 'Harness', Object.keys(offered), c.harness, (v) => this.pick('harness', v)));
    const models = c.harness ? modelsFor(offered, c.harness) : [];
    if (c.harness && models.length) nodes.push(modelField(c.harness, models, c.model, labelsOf(this.host.store.hireOptions, c.harness), this.modelQuery, (v) => this.pick('model', v), (q) => (this.modelQuery = q)));
    else if (c.harness) nodes.push(h('p', { class: 'dd-callout', 'data-hook': 'no-models', role: 'status' }, `Every ${HARNESS_LABEL[c.harness] ?? c.harness} model is hidden in Settings, so there is none to choose.`));
    else nodes.push(h('p', { class: 'field-hint' }, 'Choose a harness to see its models.'));
    const say = (what: string, o: Origin, said?: string) => h('li', {}, `${what} `, this.originTape(o), said && (o === 'invalid' || o === 'missing') ? ` “${said}” is not in the catalog.` : '');
    nodes.push(h('ul', { class: 'rv-prov-list', 'data-hook': 'agent-origin' }, say('Harness', c.origin.harness, c.said.harness), say('Model', c.origin.model, c.said.model)));
    if (busy) for (const el of nodes) if (el instanceof HTMLElement) for (const i of el.querySelectorAll<HTMLInputElement>('input')) i.disabled = true;
    return nodes;
  }

  private effortPanel(): Node[] {
    const c = this.choice;
    const cat = this.host.store.hireOptions;
    const busy = this.state === 'hiring';
    const levels = effortChoices(cat, c.harness, c.model);
    const nodes: Node[] = [];
    if (!levels.length) {
      nodes.push(h('p', { class: 'field-hint' }, 'Choose a model first: each model supports its own effort levels.'));
    } else {
      const bad = !effortOk(c, cat);
      const q = this.pending?.questions.find((x) => x.field === 'effort');
      const ask = c.said.effort ? `“${c.said.effort}” is not supported by ${modelLabel(c.harness, c.model, labelsOf(cat, c.harness))}. Which level should this agent use?` : (q?.text ?? EFFORT_QUESTION);
      if (bad) nodes.push(h('p', { class: 'rv-ask', id: 'review-effort-q' }, ask));
      const group = chips('effort', 'Level', levels, effortOk(c, cat) ? c.effort : '', (v) => this.pick('effort', v));
      if (bad) group.setAttribute('aria-describedby', 'review-effort-q');
      nodes.push(group);
    }
    nodes.push(h('p', { class: 'rv-prov', 'data-hook': 'effort-origin' }, this.originTape(c.origin.effort)));
    if (busy) for (const el of nodes) if (el instanceof HTMLElement) for (const i of el.querySelectorAll<HTMLInputElement>('input')) i.disabled = true;
    return nodes;
  }

  private wherePanel(taken: { why: string; next: number | null } | null): Node[] {
    const fv = this.host.store.floorView(this.session);
    const nodes: Node[] = [];
    const where = fv?.level ? `Floor ${fv.level.number} of ${fv.level.count} · ${fv.building?.name ?? ''}` : this.session;
    nodes.push(
      h(
        'dl',
        { class: 'dd-facts rv-place', 'data-hook': 'place' },
        h('dt', {}, 'Floor'),
        h('dd', {}, where, ' ', this.originTape('default', 'The floor you are on')),
        h('dt', {}, 'Desk'),
        h('dd', {}, `Desk ${this.desk + 1}`, taken ? ' (taken)' : ''),
      ),
    );
    if (!this.prep) {
      nodes.push(h('div', { class: 'dd-skeleton', 'aria-hidden': 'true' }, h('i'), h('i')));
      return nodes;
    }
    const label = h('input', { id: 'review-label', 'data-key': 'label', autocomplete: 'off', spellcheck: 'false', maxlength: 64, placeholder: this.prep.label });
    label.value = this.f.label;
    label.addEventListener('input', () => {
      this.f.label = label.value;
      this.changed.label = true;
      this.syncSections();
      this.renderActions();
    });
    const cwd = h('input', { id: 'review-cwd', 'data-key': 'cwd', autocomplete: 'off', spellcheck: 'false', placeholder: '/home/…', 'aria-describedby': 'review-cwd-hint' });
    cwd.value = this.f.cwd;
    cwd.addEventListener('input', () => {
      this.f.cwd = cwd.value;
      this.changed.cwd = true;
      // A new folder is not the one a check on its way was asked about: its answer is dropped, and Hire waits for a check of this one.
      this.folderRev++;
      if (this.checking || this.refetching) this.setStatus('');
      this.checking = false;
      this.syncSections();
      this.renderActions();
    });
    // A new folder: check again whether it is a repo, and its base (never a hire).
    cwd.addEventListener('change', () => {
      // Not a render: a button clicked right now (Fetch again) is still there; the answer renders.
      if (this.checkFolder()) this.renderActions();
    });
    // Enter in a field is not a hire (there is no form): only the Hire button is.
    for (const el of [label, cwd]) el.addEventListener('keydown', (e) => e.key === 'Enter' && e.preventDefault());
    nodes.push(
      h(
        'div',
        { class: 'dd-grid' },
        h('div', { class: 'dd-field' }, h('label', { for: 'review-label' }, 'Label'), label, h('p', { class: 'field-hint' }, 'Its workspace label in herdr. ', this.originTape(this.changed.label ? 'chosen' : 'default'))),
        h('div', { class: 'dd-field' }, h('label', { for: 'review-cwd' }, 'Folder'), cwd, h('p', { class: 'field-hint', id: 'review-cwd-hint' }, 'Where the agent starts, on the server. ', this.originTape(this.changed.cwd ? 'chosen' : 'default'))),
      ),
    );
    const g = gitView(this.prep.git, this.host.now());
    if (g) {
      const on = this.f.worktree && g.usable;
      nodes.push(
        worktreeControl(
          g,
          on,
          (v) => {
            this.f.worktree = v;
            this.changed.worktree = true;
            this.render();
          },
          'review-worktree',
        ),
      );
    }
    if (this.state === 'hiring' || this.refetching) for (const el of nodes) if (el instanceof HTMLElement) for (const i of el.querySelectorAll<HTMLInputElement>('input')) i.disabled = true;
    return nodes;
  }

  private renderActions(): void {
    const blocker = this.blocker();
    const label = this.f.label.trim() || this.prep?.label || '';
    const cancel = h('button', { class: 'btn', 'data-key': 'cancel', onclick: () => this.close() }, this.state === 'hiring' ? 'Close' : 'Cancel');
    const text = this.state === 'hiring' ? 'Hiring…' : label ? `Hire ${label}` : 'Hire';
    // A hire in flight is busy, not disabled (#216 decisions row 14): it keeps its focus and colours, and `hire()` ignores a second press.
    const busy = this.state === 'hiring';
    const hire = h('button', { class: 'btn btn--primary', 'data-key': 'hire', disabled: !!blocker && !busy, 'aria-disabled': blocker ? 'true' : null, 'aria-busy': busy ? 'true' : null, title: blocker, onclick: () => void this.hire() }, text);
    const had = document.activeElement === this.actions.querySelector('[data-key="hire"]');
    this.actions.replaceChildren(cancel, hire);
    if (had && (!blocker || busy)) hire.focus();
    // Why Hire is off, said where the button is (a title is not enough): the model's or effort's own section says the rest.
    if (!this.statusError && !this.statusText) {
      this.statusEl.hidden = !blocker || this.state !== 'ready';
      this.statusEl.textContent = this.statusEl.hidden ? '' : (blocker ?? '');
    }
  }

  /** The pick of a harness, model or effort: a section that needs a choice opens, the others stay as the human left them. */
  private pick(what: 'harness' | 'model' | 'effort', v: string): void {
    const cat = this.host.store.hireOptions;
    if (what === 'harness') {
      this.modelQuery = '';
      this.choice = pickHarness(this.choice, v, cat);
    } else if (what === 'model') this.choice = pickModel(this.choice, v, cat);
    else this.choice = pickEffort(this.choice, v, cat) ?? this.choice;
    this.keep.push({ harness: this.choice.harness, model: this.choice.model });
    this.reopen();
    this.render();
  }

  /** Another desk: what was reviewed goes with it. */
  private moveTo(desk: number): void {
    this.desk = desk;
    this.setStatus('');
    this.render();
  }

  private focusFirst(): void {
    const first = REVIEW_SECTIONS.find((id) => this.openSet.has(id)) ?? REVIEW_SECTIONS[0]!;
    // The first section that needs a choice (never Hire: the Enter that opened this review must not press it).
    this.sections.get(first)?.toggle.focus();
  }

  // ---- Hire ---------------------------------------------------------------------------

  /**
   * The explicit confirmation, the only way `worker.hire` is sent from here. What was reviewed is read now and handed to
   * the coordinator, which holds the desk and sends it once (the same hire's second press is the operation on its way).
   */
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
    const args = hireArgs(session, desk, this.form(), this.prep.git);
    const who = args.label ?? this.prep.label;
    const epoch = this.epoch;
    // Read once, here: a change in Settings while the hire is on its way does not change how it ends.
    const background = this.host.hirePrefs?.hireInBackground === true;
    this.state = 'hiring';
    this.setStatus('');
    const op = this.hires.start(
      { key: `review:${this.id}:${epoch}`, session, desk, args, who, prompt: null, background },
      {
        hiring: (sent) => {
          if (background || !this.dialog.open || epoch !== this.epoch) return;
          const steps = [sent.worktree ? 'creating the worktree' : null, `starting ${sent.harness}`, sent.prompt ? 'handing over the first task' : null].filter(Boolean);
          this.setStatus(`Hiring ${who}: ${steps.join(', ')}…`);
          this.render();
        },
      },
    );
    if (background) {
      // The review goes now and the player plays on; the coordinator says how it ended (one toast, a beep on success).
      this.close();
      await op.done;
      return;
    }
    this.render();
    this.landed(await op.done, { session, desk, who, epoch });
  }

  /** A hire waited for here ended: this dialog, or (closed meanwhile) a toast, says how; the go-to on success. */
  private landed(o: HireOutcome, hh: { session: string; desk: number; who: string; epoch: number }): void {
    const still = this.dialog.open && hh.epoch === this.epoch;
    if (still) this.state = 'ready';
    if (o.kind === 'hired' || o.kind === 'not_prompted') {
      const ack = o.ack;
      const w = ack?.id ? this.host.store.workerView(ack.id) : null;
      const branch = ack?.branch ? ` on ${ack.branch}` : '';
      const notSent = o.kind === 'not_prompted' ? notPromptedText(o.ack) : '';
      if (still) this.close();
      if (still && ack?.id) this.host.goTo?.(ack.id);
      const t = hiredToast(`Hired ${w?.name ?? hh.who} at Desk ${(w?.desk ?? hh.desk) + 1}${branch}. Here they come.`, ack, notSent);
      this.host.toast(t.text, t.kind);
      return;
    }
    const msg = o.kind === 'not_sent' ? o.message : o.kind === 'unknown' ? o.message : failureText('worker.hire', o.code, o.message, { floor: hh.session, desk: hh.desk + 1 });
    if (!still) {
      if (msg) this.host.toast(msg, 'error');
      return;
    }
    // Back to the review as it was: nothing was cleared, a new press is a new hire (never after an unknown outcome unasked).
    this.setStatus(o.kind === 'unknown' ? `${msg} Look at the desk before you hire again.` : msg, true);
    this.render();
  }

  // ---- test hook ------------------------------------------------------------------------

  summary(): ReviewSummary | null {
    if (!this.dialog.open) return null;
    return {
      kind: 'hire-review',
      session: this.session,
      desk: this.desk,
      state: this.state,
      choice: { ...this.choice },
      form: this.form(),
      sections: REVIEW_SECTIONS.map((id) => {
        const s = this.sections.get(id)!;
        return { id, title: TITLE[id], open: this.openSet.has(id), attention: s.root.dataset.attention === 'true', summary: s.sum.textContent ?? '', origin: s.tape.textContent ?? '' };
      }),
      git: this.prep ? gitView(this.prep.git, this.host.now()) : null,
      capacity: this.capacity(),
      blocker: this.blocker(),
      status: this.statusText,
      error: this.statusError,
    };
  }
}

/** A proposal with nothing in it: the review's state before the first `open`. */
const EMPTY: HireInterpretation = {
  sources: [],
  harness: { provenance: 'missing' },
  model: { provenance: 'missing' },
  effort: { provenance: 'missing' },
  task: { provenance: 'missing' },
  questions: [],
  ready_for_review: false,
};
