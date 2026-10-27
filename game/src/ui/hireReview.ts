import type { CommandArgs, HandoffEntry, HandoffHire, HireGit, HireInterpretation, HirePrepare, WorkerHandoffHire } from '../net/protocol';
import { HANDOFF_PATH_RESERVE, hireWithHandoffTask, newOp } from '../world/handoff';
import { pendingHire } from '../world/handoffHire';
import type { WorldStore } from '../world/store';
import { capacityView, capBlocker, firstFreeDesk, formFromPrepare, hireArgs, hireBlocker, HARNESS_LABEL, modelsFor, newerGit, offeredOptions, OriginFetches, optionsBlocker, promptBlocker, resolveHireDesk, worktreeUsable, type CapacityView, type HireForm } from '../world/hire';
import {
  agentQuestion,
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
  pickAgent,
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
import { labelsOf, modelEntries, modelLabel } from '../world/modelLabel';
import type { HeldReview } from '../world/palette';
import { backdropPolicy } from './dismiss';
import { dialogChips, secretPreviewNodes, secretRefLine, secretsDirOf } from './secretChips';
import { h, icon, ICON, replaceKeepingFocus } from './dom';
import { mountComposer, type Composer } from './composer/composer';
import { Draft as PromptDraft, type DraftSnapshot } from './composer/draft';
import { HIRE_PROMPT_MAX_BYTES } from './composer/model';
import { CommandCatalogs } from '../laptop/commandCatalog';
import { CompletionScope, hireLookupKey, hireSources, type HireLookup } from './dialogCompletion';
import { capacityBlock, chips, gitView, modelField, mountHireRecovery, promptText, worktreeControl, type HireHost, type HireSummary } from './hire';
import { HandoffFiling, type FilingHire, type HandoffPlan, type HireCarry } from './handoffFiling';
import { backgroundOutcomeText, HireCoordinator, notPromptedBackgroundText, notPromptedText, notSentText, type HireOutcome } from './hireCoordinator';
import { promptAckOf } from './handoffHires';
import { hiredToast } from './hiredToast';
import { failureText } from './messages';
import { onReviewKey, reviewButton, type Go, type PromptSecretsFlow } from './secretsFlow';

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
 *
 * The task is the shared composer (#51), as in the hire dialog: pasted images, `/` skills, `@` files and `@r:`
 * repositories of the hire's context (#39). Hire resolves it first (its images uploaded, their paths in the text), so the
 * secrets review and `worker.hire` see the text the agent gets.
 *
 * #33: a background hire hands no draft to the coordinator, so the review keeps what was reviewed when Hire was pressed
 * (`Reviewed`). Refused or unanswered, it gives it back: the review opens again with it when nothing else is open (its
 * status line says what happened), else it is held in memory (lost on a reload) behind the toast's "Review again" and a
 * palette row, until it is opened. Giving it back never presses Hire; a new press is a new hire.
 *
 * #198 "Hire with handoff" (`open`'s `seed.handoff`): the review of the hire that follows a handoff the filing dialog's
 * step 1 chose. Its Hire is the one submission: it checks the hire, files the handoff (`HandoffFiling`: the request, its
 * op followed until it is filed, the final path read back), composes the task (`hireWithHandoffTask`), checks it again
 * (its size, its secrets, the desk) and only then starts the hire, keyed by the handoff's op. Closed while the handoff is
 * made, it stops waiting: nobody is hired from it, ever, and the handoff still goes to the cabinet. Filed but not hired
 * (a refusal, a full floor, a cancelled review), it keeps the filed path: Hire then hires only.
 *
 * #219: an agent's or LLM's handoff on a bridge with `handoff_hires` (and the app's announcer, ui/handoffHires.ts): the
 * bridge hires. Hire reviews the task's secrets first (the human's task, its images uploaded, without the line that
 * points to the handoff), then sends one `worker.handoff` with `hire`; the bridge holds the desk and hires once it is
 * filed. Hire in background on: the review closes on the bridge's ack, and a toast says who is hired where once it is
 * filed. Off: it shows the progress, and Continue in background (or Close, Esc) closes it and leaves the hire running.
 * While it is open it follows the op's record and says how it ended (hired: it closes; failed or cancelled: the task
 * stays here, with the path when it was filed: Hire then hires only). Closed, the announcer says it and gives the task
 * back here. Cancel request cancels the request and the hire together. This review never sends `worker.hire` for it.
 */

/** #198: the filed handoff a hire follows (its final path). */
type Filed = Pick<HandoffEntry, 'path'>;

/** #198: what the composed task shows for the handoff's path until it is filed. */
const PATH_PLACEHOLDER = '‹the handoff’s path, once it is filed›';
/** #198: the bytes of the composed task beyond the human's: the fixed words and a path as long as it may plausibly be. */
const HANDOFF_OVERHEAD = new TextEncoder().encode(hireWithHandoffTask('x'.repeat(HANDOFF_PATH_RESERVE), '')).length;
const MODE_WORDS = { literal: 'Save last message', agent: 'Ask the agent', llm: 'Use configured LLM' } as const;

/** The sections' titles. */
const TITLE: Record<ReviewSection, string> = { agent: 'Harness and model', effort: 'Effort', task: 'Task', where: 'Location and options' };

/** #198 `filing`: "Hire with handoff" files the handoff first; nothing is hired until it is filed. */
export type ReviewState = 'preparing' | 'ready' | 'filing' | 'hiring' | 'failed';

/** `open`'s starting point other than the proposal's (#223 "Hire from handoff", #198 "Hire with handoff"). */
export interface ReviewSeed {
  choice?: ReviewChoice;
  cwd?: string;
  /** #198: chosen already: kept over the bridge's defaults. */
  label?: string;
  worktree?: boolean;
  handoff?: HandoffPlan;
}

/**
 * #198 "Back to the handoff", then Continue: the review again with the hire's choices as they were, and step 1's task
 * (the human may have edited it there). The catalog and the desk are checked again as for any review.
 */
export function carriedSeed(c: HireCarry, task: string, handoff: HandoffPlan): ReviewSeed {
  return {
    choice: { ...c.choice, task, origin: { ...c.choice.origin, task: 'chosen' } },
    ...(c.cwd ? { cwd: c.cwd } : {}),
    ...(c.label !== undefined ? { label: c.label } : {}),
    ...(c.worktree !== undefined ? { worktree: c.worktree } : {}),
    handoff,
  };
}

/** What a request to the interpreter was made against: the answer is only for this review, as the human left it then. */
export interface ReviewTicket {
  readonly epoch: number;
  readonly rev: number;
}

/** What the review shows (test hook). */
export interface ReviewSummary {
  kind: 'hire-review';
  floor: string;
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
  /** #198: the handoff this hire follows (null: an ordinary review): how it is made, and its path once filed. */
  handoff: { worker: string; mode: HandoffPlan['mode']; instruction: string; sendHome: boolean; op: string; filed: string | null; composed: string; /** #219: the bridge's handoff hire it waits on. */ bridge: { op: string; accepted: boolean } | null } | null;
}

/** #33: what was reviewed when a background Hire was pressed: what a refused or unanswered hire gives back. */
interface Reviewed {
  floor: string;
  desk: number;
  choice: ReviewChoice;
  f: { label: string; cwd: string; worktree: boolean };
  changed: { label: boolean; cwd: boolean; worktree: boolean };
  prep: HirePrepare;
  pending: HireInterpretation | null;
  /** #108: the interpreter's hand-over for `pending` (null: none). */
  handover: string | null;
  /** The task's composer draft, its images too. */
  draft: PromptDraft;
  keep: Array<{ harness: string; model: string }>;
  openSet: Set<ReviewSection>;
  defaultCwd: string;
  checked: string | null;
  /** #198: the handoff it follows, its next op, and the filed entry (Hire then hires only). */
  plan: HandoffPlan | null;
  planOp: string;
  filed: Filed | null;
}

/** #219: a handoff hire this review sent to the bridge, while it is open on it. */
interface BridgeHire {
  op: string;
  plan: HandoffPlan;
  floor: string;
  desk: number;
  who: string;
  /** The bridge took it (its ack, or its record seen): Cancel request can name the op. */
  accepted: boolean;
}

type GivenBack = Extract<HireOutcome, { kind: 'failed' | 'unknown' }>;

/** #33: a review given back while something else was open: it waits for "Review again". */
interface Held {
  reviewed: Reviewed;
  outcome: GivenBack;
  /** What the outcome's message says (the status line once it is open again). */
  text: string;
  /** #219: the status line once it is open again, when not the outcome's own words. */
  status?: string;
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
  /**
   * #39: what the task's completion looks up: the floor, the harness and the folder `worker.hire` would get now, once
   * `hire.prepare` answered and a harness is chosen.
   */
  private lookup: HireLookup | null = null;
  private ownCatalogs: CommandCatalogs | null = null;
  private readonly lookups = new CompletionScope(
    () => this.lookupKey(),
    () => hireSources(this.lookupHost(), this.lookup as HireLookup),
  );
  /** The task: one editor for the whole review, never rebuilt (its caret and scroll stay while the rest redraws). */
  private readonly composer: Composer;
  /** Drafts of background hires on their way: a refusal gives them back, so they are not disposed meanwhile. */
  private readonly away = new Set<PromptDraft>();
  /** #108 round 4: under the task, the protected files its references point at (the box keeps them as written). */
  private readonly refLine = secretRefLine('review-task-refs', () => dialogChips(this.secretsDir(), (m, e) => this.setStatus(m, e)));
  private readonly panelKeys = new Map<string, string>();

  private floor = '';
  /** What `worker.hire` is doing, once it is sent (null: not yet): the status line under "Waking floor…" (#58). */
  private hiringText: string | null = null;
  /** #108: the review (`epoch`) whose Hire reviews its task now: nobody is hired yet, so closing hires nobody. */
  private reviewing = -1;
  /** `reviewing` is the upload of the task's images (not the secrets review): what the toast says on Esc. */
  private uploading = false;
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
  /**
   * #108 round 4: the interpreter's hand-over (`secrets_pending`) for `pending`, with prompt secrets reviewed: the next
   * dictated sentence goes back with it, and Hire sends it with the task (the task as answered needs no review again).
   */
  private handover: string | null = null;
  /** The choices to keep offered when Settings hides their model (the dictated one stays on the list). */
  private keep: Array<{ harness: string; model: string }> = [];
  private statusText = '';
  private statusError = false;
  private refetching = false;
  private modelQuery = '';
  /** Bumped by every open and close: an answer asked for earlier is for a review that is gone. */
  private epoch = 0;
  /** Only this opening may be restored after a background refusal. */
  private opening = 0;
  /** Bumped by every `hire.prepare` (the answer of the latest one is the one that counts). */
  private prepGen = 0;
  /** Bumped by every keystroke in the folder: a folder check is for the folder it was asked about, never a newer one. */
  private folderRev = 0;
  /** #134: the fetches for origin sent (a recheck, Fetch again): a folder typed or previewed meanwhile does not drop their answer. */
  private fetches = new OriginFetches();
  /** A check of a folder (or a fetch again) is on its way: Hire waits for it. */
  private checking = false;
  /** The folder the prepare's git and worktree state is for: a different one in the form waits for its own check. */
  private checked: string | null = null;
  /** What an empty Folder means: the folder the first prepare chose (the server's default for this floor). */
  private defaultCwd = '';
  private hadWhereIssue = false;
  /** #33: reviews given back while something else was open, by id, in the order they were held. */
  private readonly recoveryTray = h('aside', { class: 'hire-recovery-tray', 'aria-label': 'Hire reviews needing attention', hidden: true });
  private readonly unsafe = new Set<string>();
  private readonly outcomes = new Map<string, GivenBack>();
  private readonly held = new Map<string, Held>();
  private heldSerial = 0;
  private readonly hires: HireCoordinator;
  /** #198: the handoff step 1 chose (null: an ordinary review). */
  private plan: HandoffPlan | null = null;
  /** #198: the op of the plan's request: the same until a request definitely failed (a resend then files once). */
  private planOp = '';
  /** #198: the handoff, once filed: Hire then hires only, never files or writes it again (AC7). */
  private filed: Filed | null = null;
  /** #219: the handoff hire the bridge makes for this review, while it waits on it here (null: none). */
  private bg: BridgeHire | null = null;
  /** #219: drafts of handoff hires the bridge makes: a give-back needs them (a reload loses them; the hire goes on). */
  private readonly bgDrafts = new Set<PromptDraft>();
  /** #198: the handoff being made now (Cancel, the close, the source worker's updates). */
  private filing: HandoffFiling | null = null;
  /** #198: the hires tried for one filed handoff (each a new coordinator key). */
  private hireTries = 0;
  /** #198: what the composed task shows, and the task box's own label and hint (they say what the agent gets). */
  private readonly composedEl = h('pre', { class: 'rv-composed', 'data-hook': 'composed', 'aria-label': 'What the new agent receives', tabindex: '0', hidden: true });
  private readonly taskLabel = h('label', { id: 'review-task-label' }, 'The complete task');
  private readonly taskHint = h('p', { class: 'field-hint', id: 'review-task-hint' });
  private readonly handoffEl = h('div', { class: 'dd-callout dd-callout--box rv-handoff', 'data-hook': 'rv-handoff', hidden: true });
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
    this.host.modelPrefs?.onChange(() => this.dialog.open && !this.busy() && this.render());
    this.composer = mountComposer({
      draft: this.newDraft(''),
      // The popup stays inside the dialog's body (it scrolls, and would clip it).
      complete: { sources: this.lookups.sources, bounds: () => this.body },
      labelledBy: 'review-task-label',
      describedBy: 'review-task-refs review-task-hint',
      placeholder: 'What should the agent work on?',
      // Enter adds a line, and no key hires: only the Hire button does (#212).
      submitPolicy: 'mod-enter',
      onChange: (s) => this.taskChanged(s),
    });
    // The editor takes the textarea's hooks: the tests and the focus keys know `#review-task`.
    this.composer.editor.id = 'review-task';
    this.composer.editor.dataset.key = 'task';
    this.taskLabel.addEventListener('click', () => this.composer.focus());
    this.alertEl.hidden = true;
    this.statusEl.hidden = true;
    this.body.append(this.handoffEl);
    for (const id of REVIEW_SECTIONS) this.body.append(this.buildSection(id));
    this.buildTask();
    this.dialog.append(this.head, this.body, this.foot);
    this.dialog.addEventListener('close', () => {
      // #219: closed while the bridge's handoff hire runs: it goes on (Continue in background); the announcer says how it ends.
      const bg = this.bg;
      if (bg && this.state === 'filing') {
        this.bg = null;
        this.filing = null;
        this.state = 'ready';
        if (bg.accepted) this.host.toast(this.bgText(bg), 'info');
        this.host.handoffHires?.sync();
      }
      // #198: closed while the handoff is made: no agent is hired from it, ever; the bridge still files it.
      const f = this.filing;
      if (f && this.state === 'filing') {
        this.filing = null;
        this.state = 'ready';
        f.stop();
        this.host.toast(`No agent hired. ${f.plan.name}’s handoff will still be filed to the cabinet; hire from it there.`, 'info');
      }
      const outcome = this.outcomes.get(`${this.floor}:${this.desk}`);
      if (this.state === 'ready' && this.statusError && outcome && this.prep) this.holdReview(this.reviewed(), outcome, this.statusText);
      if (!this.dialog.open) this.epoch++;
      // An enlarged image is nested in this dialog: it goes with it (it holds a window key listener).
      this.composer.closePreview();
    });
    this.dialog.addEventListener('cancel', () => {
      // Esc while the hire is on its way: the hire still happens; the dialog just goes. (#108: not before its task was
      // reviewed: then nobody is hired.)
      if (this.state === 'hiring') {
        const why = this.uploading ? 'its images were uploaded' : 'its task was checked for secrets';
        const kept = this.filed ? ` The handoff is in the cabinet: ${this.filed.path}.` : '';
        this.host.toast(this.reviewing === this.epoch ? `Not hired: it was closed before ${why}.${kept}` : 'The hire is still on its way; the worker shows up at the desk when it is done.', 'info');
      }
    });
    // Typed text and consequential choices in here: only the close button, Cancel and Esc close it, never the backdrop.
    backdropPolicy(this.dialog, 'none');
    parent.append(this.dialog);
    mountHireRecovery(parent, this.recoveryTray);
    window.addEventListener('beforeunload', (e) => {
      if (this.recoveryTray.isConnected && (this.held.size > 0 || this.away.size > 0 || (this.statusError && this.choice.task))) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  /** A handoff being filed or a hire on its way: the choices are locked. */
  private busy(): boolean {
    return this.state === 'filing' || this.state === 'hiring';
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
  /** #108 round 4 `handover`: the interpreter's `secrets_pending` for `interp`. */
  /** #198 `seed.handoff`: "Hire with handoff": Hire files that handoff first, then hires with the composed task. */
  /** #198 `seed.label`, `seed.worktree`: chosen already (back from step 1, `carriedSeed`): kept over the bridge's defaults. */
  open(floor: string, interp: HireInterpretation, desk?: number, seed?: ReviewSeed, handover: string | null = null): boolean {
    const seat = resolveHireDesk(floor, this.host.store.floorView(floor), this.host.held(floor), desk);
    if (!seat.ok) {
      this.host.toast(seat.msg, 'info');
      return false;
    }
    this.epoch++;
    this.opening++;
    this.floor = floor;
    this.desk = seat.desk;
    this.prep = null;
    this.pending = interp;
    this.handover = handover;
    this.plan = seed?.handoff ?? null;
    this.planOp = this.plan ? newOp() : '';
    this.filed = null;
    this.bg = null;
    // An earlier submission's filing (already stopped by the close) ends here too: nothing is hired from it.
    this.filing?.stop();
    this.filing = null;
    this.hireTries = 0;
    this.choice = seed?.choice ?? fromInterpretation(interp, this.host.store.hireOptions);
    this.keep = [{ harness: this.choice.harness, model: this.choice.model }];
    this.openSet = needsAttention(this.choice, this.host.store.hireOptions, this.taskIssue());
    // #198: the new agent's harness and model start as the source's: shown open, so another is easy to choose.
    if (this.plan) this.openSet.add('agent');
    this.f = { label: seed?.label ?? '', cwd: seed?.cwd ?? '', worktree: seed?.worktree ?? false };
    this.changed = { label: seed?.label !== undefined, cwd: !!seed?.cwd, worktree: seed?.worktree !== undefined };
    this.modelQuery = '';
    this.refetching = false;
    this.hadWhereIssue = false;
    this.checking = false;
    this.checked = null;
    this.defaultCwd = '';
    this.state = 'preparing';
    this.panelKeys.clear();
    this.showDraft(this.newDraft(this.choice.task));
    // #134: a preview does not fetch origin, so the wait does not name it.
    this.setStatus(this.host.store.preparePreview ? 'Checking the floor and the folder…' : 'Checking the floor, the folder and origin…');
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

  /** #108 round 4: the hand-over of `pendingInterpretation()`, for the follow-up to send back (null: none). */
  pendingHandover(): string | null {
    return this.dialog.open ? this.handover : null;
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
  apply(interp: HireInterpretation, ticket: ReviewTicket, handover: string | null = null): boolean {
    if (!this.dialog.open || ticket.epoch !== this.epoch || this.busy()) return false;
    this.pending = interp;
    // #108: a follow-up keeps the hand-over (the bridge answers the same one); one first given now is taken.
    if (handover) this.handover = handover;
    this.keep.push({ harness: interp.harness.value ?? '', model: interp.model.value ?? '' });
    this.choice = applyInterpretation(this.choice, interp, this.host.store.hireOptions, ticket.rev);
    // The editor shows the task as it is; one the human is typing in is theirs and was not replaced (`edited`).
    if (promptText(this.composer.getSnapshot()) !== this.choice.task) this.showDraft(this.newDraft(this.choice.task));
    this.reopen();
    this.render();
    return true;
  }

  /**
   * An effort said instead of clicked (phase 4's follow-up, "high"): taken like a click when the model supports it, with
   * its source `dictated`. False (nothing changes, the section stays as it is) when it does not or no model is chosen.
   */
  answerEffort(effort: string): boolean {
    if (!this.dialog.open || this.busy()) return false;
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

  private async prepare(cwd?: string, fetch = false): Promise<void> {
    const gen = ++this.prepGen;
    const epoch = this.epoch;
    const folder = this.folderRev;
    if (this.host.unsupported('hire.prepare')) {
      this.state = 'failed';
      this.setStatus(failureText('hire.prepare', 'unknown_command', ''), true);
      this.render();
      return;
    }
    const args: CommandArgs['hire.prepare'] = { floor: this.floor };
    if (cwd) args.cwd = cwd;
    if (!fetch && this.host.store.preparePreview) args.preview = true;
    // #134: a fetch sent now is newer than a recheck on its way.
    if (!args.preview) this.fetches.start();
    this.checking = !!cwd && !!this.prep;
    const r = await this.host.send('hire.prepare', args);
    // A newer prepare, a closed or reopened review, a hire sent meanwhile, a folder typed since: this answer is not for what is on screen.
    if (gen !== this.prepGen || epoch !== this.epoch || !this.dialog.open || this.busy() || folder !== this.folderRev) return;
    this.checking = false;
    if (!r.ok) {
      this.state = this.prep && cwd ? 'ready' : 'failed';
      this.setStatus(failureText('hire.prepare', r.code, r.message, { floor: this.floorName() }), true);
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
  private adoptGit(got: HireGit | null): void {
    // #134: a preview of the same repository does not replace a fetch's answer (Fetch again, a recheck) shown already.
    const g = newerGit(this.prep?.git, got);
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
    return this.prepare(cwd, again);
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

  /** #58: the floor's name (never its id). */
  private floorName(): string {
    return this.host.store.floorName(this.floor);
  }

  /** #58 decision 3: a hire here wakes the floor's session first (an asleep virtual floor, or one already waking up). */
  private wakes(): boolean {
    const fv = this.host.store.floorView(this.floor);
    return !!fv && (fv.transition === 'waking' || (fv.asleep && fv.virtual));
  }

  /** The status line while `worker.hire` is on its way: "Waking floor…" first while the floor's session wakes. */
  private hiringStatus(): void {
    this.setStatus(this.wakes() ? `Waking floor ${this.floorName()}… then ${this.hiringText ?? 'hiring'}` : `${this.hiringText ?? ''}`);
  }

  /** The world changed: the desk may have been taken, the floor gone or asleep, a model left the catalog. */
  refresh(): void {
    if (!this.dialog.open) return;
    // #58 decision 3: the hire on an asleep virtual floor wakes its session first: the status follows the wake.
    if (this.state === 'hiring') {
      if (this.hiringText !== null) this.hiringStatus();
      this.render();
      return;
    }
    // #219: the bridge's handoff hire: its record says how far it is, and how it ended.
    if (this.state === 'filing' && this.bg) {
      this.followRecord();
      return;
    }
    // #198: the handoff being made follows its op on the source worker; nothing else changes meanwhile.
    if (this.state === 'filing') {
      this.filing?.feed();
      return;
    }
    const fv = this.host.store.floorView(this.floor);
    if (!fv) {
      this.close();
      this.host.toast(`${this.floorName()} is gone.`, 'info');
      return;
    }
    if (fv.asleep && !fv.virtual) {
      this.close();
      this.host.toast(`${this.floorName()} went to sleep; wake it to hire.`, 'info');
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
    const fv = this.host.store.floorView(this.floor);
    if (!fv || this.busy()) return null;
    const held = this.host.held(this.floor);
    const seat = fv.seats[this.desk];
    // #219: a desk the bridge holds for someone's handoff hire says whose.
    const hold = held.has(this.desk) ? (this.host.store.handoffHires as WorldStore['handoffHires'] | undefined)?.holding(this.floor, this.desk) : undefined;
    const why = seat ? `${seat.name} just sat down at Desk ${this.desk + 1}.` : hold ? `Desk ${this.desk + 1} is held for ${hold.worker_name}’s handoff hire.` : held.has(this.desk) ? `Another hire is already on its way to Desk ${this.desk + 1}.` : null;
    return why ? { why, next: firstFreeDesk(fv, held) } : null;
  }

  private capacity(): CapacityView | null {
    return this.prep ? capacityView(this.prep.capacity, this.floorName()) : null;
  }

  /** #108 round 4: the bridge's directory of protected files (null: not known, the references' shape alone). */
  private secretsDir(): string | null {
    return secretsDirOf(this.host.store);
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
    if (this.state === 'filing') return 'The handoff is being filed.';
    if (this.state === 'hiring') return 'The hire is on its way.';
    // #190: the interpreter's question offers models, each with its harness.
    if (!harnessOk(c, cat)) return agentQuestion(c, this.pending, cat)?.choices.length ? 'Choose a model.' : 'Choose a harness.';
    if (!modelOk(c, cat)) return 'Choose a model.';
    if (!effortOk(c, cat)) return 'Choose an effort.';
    if (!taskOk(c)) return 'Say what the agent should work on.';
    const taskIssue = this.taskIssue();
    if (taskIssue) return taskIssue;
    if (this.state === 'preparing') return 'Waiting for herdr-world…';
    if (this.state === 'failed') return this.statusText || 'herdr-world could not prepare the hire.';
    const taken = this.takenBy();
    if (taken) return taken.why;
    if (this.unsafe.has(`${this.floor}:${this.desk}`)) return 'Check the existing worker and its conversation before hiring again.';
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
    // #198: with a handoff, the task is sent after the line that points to it: the path counts, as long as it may be.
    const extra = this.plan ? (this.filed ? new TextEncoder().encode(this.composed(this.filed.path, '')).length : HANDOFF_OVERHEAD) : 0;
    if (new TextEncoder().encode(this.choice.task).length + extra > HIRE_PROMPT_MAX_BYTES) return this.plan ? 'The task is too long to send with the line that points to the handoff.' : 'The task is too long to send.';
    return promptBlocker(this.choice.task);
  }

  /** #198: the task the new agent receives: the handoff's path, then the human's task as written. */
  private composed(path: string, task = this.choice.task): string {
    return hireWithHandoffTask(path, task);
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
    // #108: the task's review on purpose, Ctrl/⌘+Shift+X (with the switch on); the switch shows or hides its button.
    onReviewKey(this.composer.editor, () => this.host.secrets, () => void this.hire(true));
    this.host.secrets?.onChange(() => {
      if (this.dialog.open) this.renderActions();
    });
    panel.append(
      h(
        'div',
        { class: 'dd-field rv-task' },
        this.taskLabel,
        this.composer.element,
        this.refLine.el,
        this.taskHint,
        this.composedEl,
      ),
      h('p', { class: 'rv-prov', 'data-hook': 'task-origin' }),
    );
  }

  /** The task changed (typing, an image added or removed, an upload finished or failed): only a new text is an edit. */
  private taskChanged(s: DraftSnapshot): void {
    const text = promptText(s);
    if (text === this.choice.task) return;
    this.choice = editTask(this.choice, text);
    this.syncSections();
    this.renderActions();
  }

  private newDraft(text: string): PromptDraft {
    const d = new PromptDraft({
      upload: (file, hint, signal) => this.host.upload(file, hint, signal),
      label: () => this.f.label.trim() || this.prep?.label || 'hire',
      maxPromptBytes: HIRE_PROMPT_MAX_BYTES,
    });
    if (text) d.replace(0, 0, text);
    return d;
  }

  /** Shows `d` in the editor; the draft it replaces goes, unless a hire on its way or a held review still has it. */
  private showDraft(d: PromptDraft): void {
    const old = this.composer.getDraft();
    if (old === d) return;
    this.composer.setDraft(d);
    this.drop(old);
  }

  /** Disposes `d` (its uploads, its images' URLs) when nothing holds it any more. */
  private drop(d: PromptDraft): void {
    if (d === this.composer.getDraft() || this.away.has(d) || this.bgDrafts.has(d) || [...this.held.values()].some((h) => h.reviewed.draft === d)) return;
    d.dispose();
  }

  /**
   * #39: the key of the completion's context now (null: not prepared yet, or no harness). Its folder and worktree are
   * `worker.hire`'s (`hireArgs`), as the hire dialog's.
   */
  private lookupKey(): string | null {
    const p = this.prep;
    if (!this.dialog.open || !p || !this.choice.harness || this.state === 'preparing' || this.state === 'failed') return (this.lookup = null);
    const a = hireArgs(this.floor, this.desk, this.form(), p.git);
    this.lookup = { floor: this.floor, harness: this.choice.harness, ...(a.cwd ? { cwd: a.cwd } : {}), worktree: !!a.worktree };
    return hireLookupKey(this.lookup);
  }

  private lookupHost() {
    const host = this.host;
    return {
      send: host.send.bind(host),
      unsupported: (t: Parameters<HireHost['unsupported']>[0]) => host.unsupported(t),
      catalogs: host.catalogs ?? (this.ownCatalogs ??= new CommandCatalogs({ send: (t, args) => host.send(t, args) })),
      repoRefs: host.store.repoRefs,
      repoDiscovery: host.store.repoDiscovery,
      floorName: (id: string) => host.store.floorName(id),
    };
  }

  /** The completion test hook: its context's generation (it steps on every change of floor, harness, folder or worktree). */
  get lookupGeneration(): number {
    return this.lookups.generation;
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
        const asked = !m && !!agentQuestion(c, this.pending, cat)?.choices.length;
        const miss = asked ? 'Choose a model' : !c.harness ? `Choose a harness${c.said.harness ? ` (“${c.said.harness}” is not available)` : ''}` : !m ? `no model chosen${c.said.model ? ` (“${c.said.model}” is not available)` : ''}` : '';
        return { sum: [h, m].filter(Boolean).join(' · ') + (miss ? `${h ? ' · ' : ''}${miss}` : ''), origins: [c.origin.harness, c.origin.model] };
      }
      case 'effort':
        return { sum: c.effort ? (effortOk(c, cat) || !c.model ? c.effort : `${c.effort} (not supported)`) : c.said.effort ? `Not chosen yet (“${c.said.effort}” is not supported)` : 'Not chosen yet', origins: [c.origin.effort] };
      case 'task':
        return { sum: c.task.trim() ? taskPreview(c.task) : 'No task yet', origins: [c.origin.task] };
      case 'where': {
        const fv = this.host.store.floorView(this.floor);
        const label = this.f.label.trim() || this.prep?.label;
        const wt = this.prep?.git ? (this.f.worktree && worktreeUsable(this.prep.git) ? 'own worktree' : 'no worktree') : null;
        const sum = [`Desk ${this.desk + 1}`, fv?.level ? `Floor ${fv.level.number}` : this.floorName(), label, this.f.cwd.trim(), wt].filter(Boolean).join(' · ');
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
      // #108 round 4: a dictated task with protected secrets holds their references: chips, never half a path.
      const dir = this.secretsDir();
      if (id === 'task' && this.choice.task.includes('[secret in file ')) s.sum.replaceChildren(...secretPreviewNodes(this.choice.task, dir, taskPreview));
      else s.sum.textContent = t.sum;
      s.sum.title = t.sum;
      s.tape.textContent = this.originText(id, t.origins);
      const bad = t.origins.some((o) => o === 'missing' || o === 'invalid') || (id === 'where' && issue);
      s.tape.dataset.origin = bad ? 'attention' : (t.origins[0] ?? 'default');
      s.toggle.setAttribute('aria-expanded', String(open));
      s.panel.hidden = !open;
      s.root.dataset.open = String(open);
      s.root.dataset.attention = String(need.has(id));
    }
    // The task box keeps its references as written; the line under it names their files (cheap: redrawn on a change only).
    this.refLine.update(this.choice.task);
    this.syncTaskText();
    const prov = this.sections.get('task')!.panel.querySelector<HTMLElement>('[data-hook="task-origin"]');
    if (prov) prov.replaceChildren(this.originTape(this.choice.origin.task), ' ', this.choice.origin.task === 'dictated' ? 'Cut from what you said, word for word.' : this.choice.origin.task === 'handoff' ? 'Reads the handoff file, then goes on with the work.' : '');
  }

  /** The task box's label and hint, and (#198, with a handoff) the composed task the agent receives. */
  private syncTaskText(): void {
    const plan = this.plan;
    this.taskLabel.textContent = plan ? 'Task for the new agent' : 'The complete task';
    const enter = [h('kbd', {}, 'Enter'), ' adds a line · paste a screenshot to add it.'];
    if (plan) this.taskHint.replaceChildren('It gets this after the line that points to the handoff, as shown below. Your words stay as written. ', ...enter);
    else this.taskHint.replaceChildren('Sent to the agent as its first task, exactly as written here. ', ...enter);
    this.composedEl.hidden = !plan;
    if (!plan) return;
    const path = this.filed?.path ?? PATH_PLACEHOLDER;
    const text = this.composed(path);
    const at = text.indexOf(path);
    this.composedEl.dataset.filed = this.filed ? 'true' : 'false';
    this.composedEl.replaceChildren(text.slice(0, at), h('span', { class: this.filed ? 'rv-path' : 'rv-path rv-path--pending' }, path), text.slice(at + path.length));
  }

  /** #198: the handoff this hire follows, above the sections: how it is made, from whom, and its path once filed. */
  private syncHandoff(): void {
    const p = this.plan;
    this.handoffEl.hidden = !p;
    if (!p) return;
    const filed = this.filed;
    const tape = filed ? h('span', { class: 'tape tape--idle' }, 'Filed') : this.state === 'filing' ? h('span', { class: 'tape tape--box' }, 'Filing') : h('span', { class: 'tape' }, 'Handoff');
    const how = p.mode === 'literal' ? `${p.name}’s last message, saved as written` : p.mode === 'agent' ? `written by ${p.name}’s agent` : `written by the configured LLM${p.llmModel ? ` (${p.llmModel})` : ''} from ${p.name}’s conversation`;
    this.handoffEl.replaceChildren(...[
      h('p', {}, tape, ' ', h('b', {}, MODE_WORDS[p.mode]), ` · ${how}. `, filed ? `Filed in the ${p.floorName} cabinet; the agent is hired with its path.` : `It is filed in the ${p.floorName} cabinet first; the agent is hired once it is.`),
      p.instruction && p.mode !== 'literal' ? h('p', { class: 'field-hint', 'data-hook': 'rv-handoff-instruction' }, `What to put in it: “${p.instruction}”`) : null,
      p.sendHome ? h('p', { class: 'field-hint', 'data-hook': 'rv-handoff-home' }, `${p.name} is sent home after filing, if it can go then. The new agent never takes ${p.name}’s desk.`) : null,
      filed ? h('p', { class: 'rv-handoff-path' }, 'Saved at ', h('code', { 'data-hook': 'rv-handoff-path' }, filed.path)) : null,
    ].filter((n): n is HTMLParagraphElement => !!n));
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
    const fv = this.host.store.floorView(this.floor);
    const where = fv?.level ? `Floor ${fv.level.number} of ${fv.level.count} · ${fv.building?.name ?? ''}` : 'Unassigned lot';
    this.head.replaceChildren(
      h('div', { class: 'dd-plate dd-plate--desk', 'aria-hidden': 'true' }, icon('<path d="M12 5v14M5 12h14"/>'), h('b', {}, String(this.desk + 1))),
      h('div', { class: 'dd-titles' }, h('h2', { id: 'review-title' }, this.plan ? `Hire with a handoff at Desk ${this.desk + 1}` : `Review the hire at Desk ${this.desk + 1}`), h('p', { id: 'review-sub' }, `${this.floorName()} · ${where}`)),
      h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close)),
    );
    const busy = this.busy();
    const c = this.choice;
    const cat = this.host.store.hireOptions;
    const offered = this.offered();
    const taken = this.takenBy();

    const ask = agentQuestion(c, this.pending, cat);
    this.panel('agent', [c.harness, c.model, c.origin.harness, c.origin.model, c.said.harness, c.said.model, labelsOf(cat, c.harness), this.host.modelPrefs?.version, busy, this.keep.length, ask], () => this.agentPanel(offered));
    this.panel('effort', [c.harness, c.model, c.effort, c.origin.effort, c.said.effort, busy, this.pending?.questions.find((q) => q.field === 'effort')?.text], () => this.effortPanel());
    this.panel('where', [this.floor, this.desk, this.state, this.prep, this.f.worktree, this.refetching, taken, this.host.store.limits.version, busy, where], () => this.wherePanel(taken));
    // Busy, not disabled, while the hire is on its way (#216 decisions row 14).
    this.composer.setBusy(busy);
    this.lookups.check();
    this.syncSections();
    this.syncHandoff();

    const notices: Node[] = [];
    if (taken && this.state === 'ready') {
      const alt = taken.next;
      notices.push(
        h(
          'div',
          { class: 'dd-callout dd-callout--error', role: 'alert' },
          h('p', {}, taken.why),
          this.unsafe.has(`${this.floor}:${this.desk}`) ? null : alt !== null ? h('button', { class: 'btn btn--sm', 'data-key': 'other-desk', onclick: () => this.moveTo(alt) }, `Hire at Desk ${alt + 1} instead`) : h('p', {}, 'No other desk is free on this floor.'),
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
    if (this.prep) notices.push(capacityBlock(this.capacity() as CapacityView, this.prep, this.floorName()));
    this.notices.replaceChildren(...notices);
    this.renderActions();
  }

  private agentPanel(offered: ReturnType<HireReviewDialog['offered']>): Node[] {
    const c = this.choice;
    const nodes: Node[] = [];
    const busy = this.busy();
    nodes.push(chips('harness', 'Harness', Object.keys(offered), c.harness, (v) => this.pick('harness', v)));
    const models = c.harness ? modelsFor(offered, c.harness) : [];
    // #190: the interpreter's question (a family that names several models, one it could not take): its words and
    // exactly its choices, until the human picks; a harness picked instead opens that harness's models.
    const ask = agentQuestion(c, this.pending, this.host.store.hireOptions);
    if (ask?.choices.length) {
      const cat = this.host.store.hireOptions;
      nodes.push(h('p', { class: 'rv-ask', id: 'review-model-q', 'data-hook': 'model-question' }, ask.text));
      const many = ask.choices.length > 1;
      for (const g of ask.choices) {
        const legend = many ? (HARNESS_LABEL[g.harness] ?? g.harness) : 'Model';
        const value = g.harness === c.harness ? c.model : '';
        const group = chips(many ? `model-${g.harness}` : 'model', legend, g.models, value, (v) => this.pickChoice(g.harness, v), null, modelEntries(g.harness, g.models, labelsOf(cat, g.harness)));
        group.setAttribute('aria-describedby', 'review-model-q');
        nodes.push(group);
      }
    } else if (c.harness && models.length) nodes.push(modelField(c.harness, models, c.model, labelsOf(this.host.store.hireOptions, c.harness), this.modelQuery, (v) => this.pick('model', v), (q) => (this.modelQuery = q)));
    else if (c.harness) nodes.push(h('p', { class: 'dd-callout', 'data-hook': 'no-models', role: 'status' }, `Every ${HARNESS_LABEL[c.harness] ?? c.harness} model is hidden in Settings, so there is none to choose.`));
    else nodes.push(h('p', { class: 'field-hint' }, 'Choose a harness to see its models.'));
    // A name that matches nothing; the question says what else went wrong (several matches, a harness said with another's).
    const say = (what: string, o: Origin, said?: string) => h('li', {}, `${what} `, this.originTape(o), said && !ask?.choices.length && (o === 'invalid' || o === 'missing') ? ` “${said}” is not in the catalog.` : '');
    nodes.push(h('ul', { class: 'rv-prov-list', 'data-hook': 'agent-origin' }, say('Harness', c.origin.harness, c.said.harness), say('Model', c.origin.model, c.said.model)));
    if (busy) for (const el of nodes) if (el instanceof HTMLElement) for (const i of el.querySelectorAll<HTMLInputElement>('input')) i.disabled = true;
    return nodes;
  }

  private effortPanel(): Node[] {
    const c = this.choice;
    const cat = this.host.store.hireOptions;
    const busy = this.busy();
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
    const fv = this.host.store.floorView(this.floor);
    const nodes: Node[] = [];
    const where = fv?.level ? `Floor ${fv.level.number} of ${fv.level.count} · ${fv.building?.name ?? ''}` : this.floorName();
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
    // #134: the recheck's answer may draw this field again while it is typed in: the new one sends no `change`, so
    // leaving it checks a folder no check was sent for.
    cwd.addEventListener('blur', () => {
      if (this.dialog.open && !this.checking && this.checkFolder()) this.renderActions();
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
    if (this.busy() || this.refetching) for (const el of nodes) if (el instanceof HTMLElement) for (const i of el.querySelectorAll<HTMLInputElement>('input')) i.disabled = true;
    return nodes;
  }

  private renderActions(): void {
    const blocker = this.blocker();
    const label = this.f.label.trim() || this.prep?.label || '';
    // #219: the bridge hires once it is filed: closing leaves it running, and the button says so.
    const bg = this.state === 'filing' ? this.bg : null;
    const cancel = bg
      ? h('button', { class: 'btn', 'data-key': 'background', title: `Closes this review; ${bg.who} is still hired at Desk ${bg.desk + 1} once the handoff is filed`, onclick: () => this.close() }, 'Continue in background')
      : h('button', { class: 'btn', 'data-key': 'cancel', title: this.state === 'filing' ? 'Stop waiting: nobody is hired; the handoff is still filed' : null, onclick: () => this.close() }, this.busy() ? 'Close' : 'Cancel');
    // #198: with a handoff not filed yet, Hire files it first; once filed, it hires only.
    const text = this.state === 'filing' ? 'Filing the handoff…' : this.state === 'hiring' ? 'Hiring…' : this.plan && !this.filed ? 'File handoff and hire' : label ? `Hire ${label}` : 'Hire';
    // A hire in flight is busy, not disabled (#216 decisions row 14): it keeps its focus and colours, and `hire()` ignores a second press.
    const busy = this.busy();
    const hire = h('button', { class: 'btn btn--primary', 'data-key': 'hire', disabled: !!blocker && !busy, 'aria-disabled': blocker ? 'true' : null, 'aria-busy': busy ? 'true' : null, title: blocker, onclick: () => void this.hire() }, text);
    const had = document.activeElement === this.actions.querySelector('[data-key="hire"]');
    // #108: the task's review on purpose (with the switch on), then the hire.
    const review = reviewButton(this.host.secrets, busy ? (blocker ?? 'The hire is on its way.') : blocker, () => void this.hire(true), 'task');
    const hadReview = document.activeElement === this.actions.querySelector('[data-key="review"]');
    // #198: the agent's request or the LLM's job can be cancelled while it runs (a literal save is one quick request).
    const f = this.filing;
    const stop = bg
      ? h('button', { class: 'btn btn--danger-quiet', 'data-key': 'cancel-request', disabled: !bg.accepted, title: bg.accepted ? 'Cancels the request and the hire: nothing is filed, nobody is hired' : 'Wait for herdr-world to take the request', onclick: () => void this.cancelHandoffHire() }, 'Cancel request')
      : this.state === 'filing' && f && f.plan.mode !== 'literal'
        ? h('button', { class: 'btn btn--danger-quiet', 'data-key': 'cancel-request', title: 'Cancels the request: nothing is filed, nobody is hired', onclick: () => void this.cancelFiling() }, 'Cancel request')
        : null;
    // #198: before anything is filed, step 1 can be chosen again (another mode, the latest reply), the task and the
    // hire's choices kept (Continue restores them).
    const plan = this.plan;
    const backTo = this.host.handoffBack;
    const back =
      plan && backTo && !this.filed && !busy
        ? h('button', { class: 'btn btn--quiet rv-back', 'data-key': 'back', title: 'Choose how the handoff is made again; your task and hire settings are kept', onclick: () => (this.close(), backTo(plan, this.choice.task, this.carry())) }, 'Back to the handoff')
        : null;
    const copy = this.statusError ? h('button', { class: 'btn', type: 'button', onclick: () => {
      void this.composer.getDraft().resolve({ hint: false }).then((r) => {
        if (!r.ok) { this.host.toast('Finish uploading the images before copying this task.', 'error'); return; }
        void (navigator.clipboard ? navigator.clipboard.writeText(r.text) : Promise.reject(new Error('clipboard unavailable'))).then(() => this.host.toast('Prompt copied.', 'info'), () => this.host.toast('Select the task and copy it.', 'error'));
      });
    } }, 'Copy prompt') : null;
    const checked = !busy && !this.takenBy() && this.unsafe.has(`${this.floor}:${this.desk}`) ? h('button', { class: 'btn', type: 'button', onclick: () => {
      this.unsafe.delete(`${this.floor}:${this.desk}`); this.render();
    } }, 'I checked: nothing was hired') : null;
    const outcome = this.outcomes.get(`${this.floor}:${this.desk}`);
    const data = outcome?.kind === 'failed' ? outcome.data : undefined;
    const mcp = this.statusError && data?.startup?.length && this.host.mcpDetails ? h('button', { class: 'btn', type: 'button', onclick: () => {
      this.close(); this.host.mcpDetails?.(this.floor, data.cwd ?? this.f.cwd, data.codex_profile ?? '');
    } }, 'MCP details') : null;
    this.actions.replaceChildren(...[back, copy, mcp, checked, cancel, stop, review, hire].filter((x): x is HTMLButtonElement => !!x));
    if (had && (!blocker || busy)) hire.focus();
    if (hadReview) review?.focus();
    // Why Hire is off, said where the button is (a title is not enough): the model's or effort's own section says the rest.
    if (!this.statusError && !this.statusText) {
      this.statusEl.hidden = !blocker || this.state !== 'ready';
      this.statusEl.textContent = this.statusEl.hidden ? '' : (blocker ?? '');
    }
  }

  /** #190: one of the interpreter's choices: its harness and model together. */
  private pickChoice(harness: string, model: string): void {
    this.modelQuery = '';
    this.choice = pickAgent(this.choice, harness, model, this.host.store.hireOptions);
    this.keep.push({ harness: this.choice.harness, model: this.choice.model });
    this.reopen();
    this.render();
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
    if (this.unsafe.has(`${this.floor}:${this.desk}`)) return;
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
  private async hire(manual = false): Promise<void> {
    if (this.state !== 'ready' || !this.prep) return;
    const blocker = this.blocker();
    if (blocker) {
      this.setStatus(blocker, true);
      this.renderActions();
      return;
    }
    const floor = this.floor;
    const desk = this.desk;
    const args = hireArgs(floor, desk, this.form(), this.prep.git);
    if (manual && !args.prompt) {
      this.setStatus('Write the task first, then review its secrets.', true);
      return;
    }
    const epoch0 = this.epoch;
    const live = () => this.dialog.open && epoch0 === this.epoch;
    const plan = this.plan;
    // #198: the line that points to the handoff counts against the limit (its path as long as it may be, until filed).
    const overhead = plan ? (this.filed ? new TextEncoder().encode(this.composed(this.filed.path, '')).length : HANDOFF_OVERHEAD) : 0;
    // The task as the agent gets it: its images uploaded, their paths (and the files' mentions) in the text. Nothing is
    // held or sent before; a failed upload keeps the review as it is, each failed image with its Retry.
    if (args.prompt) {
      const doc = this.composer.getDraft();
      const waiting = doc.snapshot().images.filter((i) => i.status === 'pending' || i.status === 'uploading').length;
      // A second press meanwhile is the same hire (`state`), and the box is busy: what is typed now is not sent.
      this.state = 'hiring';
      if (waiting) this.setStatus(`Uploading ${waiting === 1 ? 'the image' : `${waiting} images`}…`);
      this.render();
      this.reviewing = epoch0;
      this.uploading = true;
      const res = await doc.resolve({ maxBytes: HIRE_PROMPT_MAX_BYTES - overhead });
      this.uploading = false;
      if (this.reviewing === epoch0) this.reviewing = -1;
      if (!live()) return;
      this.state = 'ready';
      if (!res.ok) {
        this.setStatus(this.afterFiling(notSentText(res, '') || 'Not hired: the task could not be made.'), true);
        this.render();
        return;
      }
      args.prompt = res.text;
    }
    // #219: the bridge hires once it is filed: the task is reviewed now, then one request carries both.
    if (plan && this.bridgeHires(plan)) {
      await this.sendWithHire(plan, args, manual, live);
      return;
    }
    // #198: the handoff is filed first (or was, by an earlier press): the agent is hired with its final path only.
    if (plan) {
      const path = await this.fileHandoff(plan, live);
      if (path === null) return;
      args.prompt = this.composed(path, args.prompt ?? '');
      const why = this.launchBlocker(args.prompt);
      if (why) {
        this.state = 'ready';
        this.setStatus(this.afterFiling(why), true);
        this.render();
        return;
      }
    }
    // #108 round 4: the task, reviewed before anything of it goes, unless it is the interpreter's as it answered it (the
    // hand-over covers that: what you left as typed is not proposed twice). The hand-over goes with any task (its files
    // are the new worker's). #198: with a handoff, the composed task is the one reviewed.
    const flow = this.host.secrets;
    const handover = args.prompt ? this.handover : null;
    const covered = handover !== null && args.prompt === this.pending?.task.value;
    let secrets: { flow: PromptSecretsFlow; req: { key: string; text: string; target: string; manual: boolean }; go: Go } | undefined;
    if (args.prompt && flow && (manual || (flow.on && !covered))) {
      const req = { key: plan ? `handoff:${this.planOp}` : `review:${floor}:${desk}`, text: args.prompt, target: `${args.label ?? this.prep.label} at Desk ${desk + 1}`, manual };
      this.state = 'hiring';
      this.setStatus(manual ? 'Opening the review of its secrets…' : 'Looking for secrets in the task…');
      this.render();
      // (Closed meanwhile: no review opens for it. The coordinator's copy has no `live`: the hire is on its way then.)
      this.reviewing = epoch0;
      const out = await flow.review({ ...req, live });
      if (this.reviewing === epoch0) this.reviewing = -1;
      if (!live()) return;
      this.state = 'ready';
      if (out.kind === 'kept') {
        this.setStatus(this.afterFiling(out.why === 'cancel' ? 'Not hired: the review was cancelled. The task is still here.' : out.message), out.why === 'failed' || !!this.filed);
        this.render();
        return;
      }
      secrets = { flow, req, go: out };
    }
    if (handover) args.secrets_pending = handover;
    const who = args.label ?? this.prep.label;
    const epoch = this.epoch;
    // Read once, here: a change in Settings while the hire is on its way does not change how it ends. (#198: after the
    // handoff was filed: the review stays open while it is made, whatever the setting.)
    const opening = this.opening;
    const background = this.host.hirePrefs?.hireInBackground === true;
    // #33: the coordinator gets no draft: what was reviewed is kept here, for a background hire that is refused or unanswered.
    const reviewed = this.reviewed();
    // #198: this hire's filed handoff, as it is now: the review may be closed and opened for another hire before it ends.
    const filed = this.filed;
    this.away.add(reviewed.draft);
    this.state = 'hiring';
    this.hiringText = null;
    this.setStatus(filed ? `Filed ${filed.path}. Hiring…` : '');
    // #198: one hire per filed handoff and press: a repeated update or click is the operation on its way.
    const key = plan ? `handoff:${this.planOp}:${++this.hireTries}` : `review:${this.id}:${epoch}`;
    const op = this.hires.start(
      { key, floor, where: this.floorName(), desk, args, who, prompt: null, background, kept: true, ...(secrets ? { secrets } : {}) },
      {
        hiring: (sent) => {
          if (background || !this.dialog.open || epoch !== this.epoch) return;
          const steps = [sent.worktree ? 'creating the worktree' : null, `starting ${sent.harness}`, sent.prompt ? 'handing over the first task' : null].filter(Boolean);
          this.hiringText = `Hiring ${who}: ${steps.join(', ')}…`;
          this.hiringStatus();
          this.render();
        },
      },
    );
    if (background) {
      // The review goes now and the player plays on; the coordinator says how it ended (one toast, a beep on success).
      // #58 decision 3: a hire on an asleep virtual floor wakes it first, which takes a while: say so now.
      if (this.wakes()) this.host.toast(`Waking floor ${this.floorName()}… ${who} is hired once it is up.`, 'info');
      this.close();
      const o = await op.done;
      this.recordOutcome(o, floor, desk);
      this.away.delete(reviewed.draft);
      if (o.kind === 'failed' || o.kind === 'unknown') this.giveBack(reviewed, o, backgroundOutcomeText(op.request, o));
      else if (o.kind === 'not_sent' && opening === this.opening && !document.querySelector('dialog[open]')) {
        this.dialog.showModal();
        this.landed(o, { floor, desk, who, epoch: this.epoch, filed });
        this.focusFirst();
      }
      this.drop(reviewed.draft);
      return;
    }
    this.render();
    const outcome = await op.done;
    this.recordOutcome(outcome, floor, desk);
    this.away.delete(reviewed.draft);
    if ((outcome.kind === 'failed' || outcome.kind === 'unknown') && (!this.dialog.open || epoch !== this.epoch)) this.giveBack(reviewed, outcome, backgroundOutcomeText(op.request, outcome));
    else this.landed(outcome, { floor, desk, who, epoch, filed });
    this.drop(reviewed.draft);
  }

  /**
   * #198: files the plan's handoff (once: an earlier press that filed it is reused) and gives its final path; null when
   * nothing is to be hired now (it failed, was cancelled, or the review closed: the status or a toast said so).
   */
  private async fileHandoff(plan: HandoffPlan, live: () => boolean): Promise<string | null> {
    if (this.filed) return this.filed.path;
    const f = new HandoffFiling(
      {
        send: (t, a) => this.host.send(t, a),
        worker: (id) => this.host.store.workers.get(id),
        secrets: this.host.secrets,
        moved: () => {
          if (this.filing === f && live()) {
            this.setStatus(f.progress());
            this.render();
          }
        },
      },
      plan,
      this.planOp,
      live,
    );
    this.filing = f;
    this.state = 'filing';
    this.setStatus(f.progress());
    this.render();
    const o = await f.run();
    if (this.filing === f) this.filing = null;
    // Closed or opened again meanwhile: the close said it (no agent is hired from it).
    if (!live()) return null;
    if (o.kind !== 'filed') {
      this.state = 'ready';
      // A request that may still be filed keeps its op (a resend is the same request); any other end needs a new one.
      if (o.kind !== 'failed' || !o.retry) this.planOp = newOp();
      if (o.kind === 'failed') this.setStatus(o.message, true);
      this.render();
      this.focusFirst();
      return null;
    }
    this.filed = o.entry;
    this.hireTries = 0;
    this.state = 'hiring';
    this.setStatus(`Filed ${o.entry.path}. Hiring…`);
    this.render();
    return o.entry.path;
  }

  // ---- #219: the bridge hires once it is filed ---------------------------------------

  /** An agent's or LLM's handoff not filed yet, on a bridge that hires after it (and an app that says how it ended). */
  private bridgeHires(plan: HandoffPlan): boolean {
    return plan.mode !== 'literal' && !this.filed && !!this.host.handoffHires && this.host.store.handoffHires.known;
  }

  /** The toast of a handoff hire left running: who is hired where, once it is filed. */
  private bgText(bg: Pick<BridgeHire, 'plan' | 'who' | 'desk'>): string {
    return `Writing ${bg.plan.name}’s handoff. ${bg.who} is hired at Desk ${bg.desk + 1} once it is filed.`;
  }

  /** The status line while the bridge's handoff hire runs (`r`: its record now). */
  private bgProgress(bg: BridgeHire, r: HandoffHire | undefined): string {
    if (r?.state === 'hiring') return `Filed${r.path ? ` ${r.path}` : ''}. Hiring ${bg.who} at Desk ${bg.desk + 1}…`;
    const p = bg.plan;
    const then = `then ${bg.who} is hired at Desk ${bg.desk + 1}.`;
    if (!bg.accepted) return `Sending the request to herdr-world… ${then}`;
    return p.mode === 'agent' ? `Asking ${p.name}’s agent… it is filed once its turn ends with the handoff written; ${then}` : `The LLM${p.llmModel ? ` (${p.llmModel})` : ''} is writing the handoff… ${then}`;
  }

  /**
   * #219: Hire for a handoff the bridge hires after: the task's secrets review (the task as typed, its images uploaded,
   * before anything goes), then one `worker.handoff` with `hire` (the same op until it definitely failed). The task and
   * settings stay here for a give-back until the op ends (`session`); a reload loses them, never the hire.
   */
  private async sendWithHire(plan: HandoffPlan, args: CommandArgs['worker.hire'], manual: boolean, live: () => boolean): Promise<void> {
    const announcer = this.host.handoffHires as NonNullable<HireHost['handoffHires']>;
    const prep = this.prep as HirePrepare;
    const floor = this.floor;
    const desk = this.desk;
    const epoch0 = this.epoch;
    const flow = this.host.secrets;
    const handover = args.prompt ? this.handover : null;
    const covered = handover !== null && args.prompt === this.pending?.task.value;
    let review: FilingHire['review'] = null;
    if (args.prompt && flow && (manual || (flow.on && !covered))) {
      const req = { key: `handoff-hire:${this.planOp}`, text: args.prompt, target: `${args.label ?? prep.label} at Desk ${desk + 1}`, manual };
      this.state = 'hiring';
      this.setStatus(manual ? 'Opening the review of its secrets…' : 'Looking for secrets in the task…');
      this.render();
      this.reviewing = epoch0;
      const out = await flow.review({ ...req, live });
      if (this.reviewing === epoch0) this.reviewing = -1;
      if (!live()) return;
      this.state = 'ready';
      if (out.kind === 'kept') {
        this.setStatus(out.why === 'cancel' ? 'Not sent: the review was cancelled. Nothing was filed and nobody was hired; the task is still here.' : out.message, out.why === 'failed');
        this.render();
        return;
      }
      review = { flow, req: { ...req, live }, go: out };
    }
    const op = this.planOp;
    const who = args.label ?? prep.label;
    const hire: WorkerHandoffHire = { ...args, ...(handover ? { secrets_pending: handover } : {}), origin: announcer.origin };
    // Read once, here (a change in Settings meanwhile does not change how it ends).
    const background = this.host.hirePrefs?.hireInBackground === true;
    const reviewed = this.reviewed();
    const task = args.prompt ?? '';
    this.bgDrafts.add(reviewed.draft);
    announcer.session(op, {
      task,
      watching: () => this.dialog.open && this.bg?.op === op,
      giveBack: (r) => this.handoffGiveBack(reviewed, r),
      done: () => {
        this.bgDrafts.delete(reviewed.draft);
        this.drop(reviewed.draft);
      },
    });
    const bg: BridgeHire = { op, plan, floor, desk, who, accepted: false };
    const f = new HandoffFiling(
      {
        send: (t, a) => this.host.send(t, a),
        worker: (id) => this.host.store.workers.get(id),
        secrets: this.host.secrets,
      },
      plan,
      op,
      live,
      { args: hire, review },
    );
    this.bg = bg;
    this.filing = f;
    this.state = 'filing';
    this.setStatus(this.bgProgress(bg, undefined));
    this.render();
    const o = await f.run();
    if (this.filing === f) this.filing = null;
    // An answer that never came may still have been taken: the world's record for the op says so.
    const seen = o.kind === 'failed' && o.retry ? this.host.store.handoffHires.get(op) : undefined;
    if (o.kind === 'accepted' || seen) {
      bg.accepted = true;
      if (this.bg !== bg || !live()) {
        // Closed while it was sent: it runs on; say so now that it is taken.
        if (this.bg === bg) this.bg = null;
        this.host.toast(this.bgText(bg), 'info');
        announcer.sync();
        return;
      }
      if (background) {
        // The review goes now and the player plays on; the announcer says how it ends.
        this.close();
        return;
      }
      this.followRecord();
      return;
    }
    // Not taken: nobody is hired from this press.
    if (this.bg === bg) this.bg = null;
    const retry = o.kind === 'failed' && o.retry;
    if (!retry) {
      announcer.claim(op);
      if (op === this.planOp) this.planOp = newOp();
    }
    if (o.kind === 'gone') return;
    const message = o.kind === 'failed' ? o.message : 'Nobody was hired.';
    if (!live()) {
      // Closed while it was sent, and refused: the task comes back.
      this.giveBack({ ...reviewed, planOp: retry ? op : this.planOp }, { kind: 'failed', code: 'handoff', message }, message, message);
      return;
    }
    this.state = 'ready';
    this.setStatus(message, true);
    this.render();
    this.focusFirst();
  }

  /** #219: the record of the handoff hire this review waits on: its progress, or (it ended) the outcome, said here. */
  private followRecord(): void {
    const bg = this.bg;
    if (!bg || this.state !== 'filing') return;
    const r = this.host.store.handoffHires.get(bg.op);
    if (r) bg.accepted = true;
    if (!r || pendingHire(r)) {
      this.setStatus(this.bgProgress(bg, r));
      this.render();
      return;
    }
    // It ended while open: said here, and by nobody else.
    this.bg = null;
    this.host.handoffHires?.claim(bg.op);
    if (r.state === 'hired') {
      this.state = 'ready';
      const w = r.hired ? this.host.store.workerView(r.hired) : null;
      const name = w?.name ?? bg.who;
      const at = `Desk ${(w?.desk ?? bg.desk) + 1}`;
      // The review closes, so a task that did not reach the agent goes to their Prompt (P) note.
      const task = this.choice.task;
      const held = r.prompted === false && r.delivery !== 'unknown' && !!r.hired && !!r.path && this.host.holdTask?.(r.hired, hireWithHandoffTask(r.path, task), null) === true;
      const notSent = r.prompted === false ? notPromptedBackgroundText(promptAckOf(r), held) : '';
      const home = r.send_home_result === 'skipped' ? ` ${r.worker_name} was not sent home: ${(r.send_home_reason ?? '').trim() || 'it could not go then.'}` : '';
      this.close();
      if (r.hired) this.host.goTo?.(r.hired);
      const t = hiredToast(`Hired ${name} at ${at}. Here they come.`, undefined, notSent);
      this.host.toast(`${t.text}${home}`, home && t.kind === 'info' ? 'warn' : t.kind);
      return;
    }
    this.state = 'ready';
    const why = recordReason(r);
    if (r.path) {
      // Filed, not hired: the handoff stays in the cabinet; Hire now hires only (#198).
      this.filed = { path: r.path };
      this.hireTries = 0;
      this.setStatus(this.afterFiling(why), true);
    } else {
      this.planOp = newOp();
      this.setStatus(`${why} Your task and settings are still here.`, true);
    }
    this.render();
    this.focusFirst();
  }

  /** #219: Cancel request: the request and its hire, cancelled together by the bridge; its record then says how it ended. */
  private async cancelHandoffHire(): Promise<void> {
    const bg = this.bg;
    if (!bg || !bg.accepted || this.state !== 'filing') return;
    this.setStatus(`Cancelling ${bg.plan.name}’s handoff request and the hire…`);
    this.render();
    const r = await this.host.send('worker.handoff_cancel', { worker: bg.plan.worker, op: bg.op });
    if (this.bg !== bg) return;
    if (!r.ok) {
      const filing = r.code === 'busy' ? ` It is being filed already; ${bg.who} is hired at Desk ${bg.desk + 1} once it is.` : '';
      this.setStatus(`${failureText('worker.handoff_cancel', r.code, r.message, { worker: bg.plan.name })}${filing}`, true);
      this.render();
      return;
    }
    // The record may have come before the answer.
    this.followRecord();
  }

  /**
   * #219: a handoff hire that ended without a hire while this review was closed: the task and settings come back (the
   * review opens again, or waits behind "Review again"), with the path when it was filed (Hire then hires only).
   */
  private handoffGiveBack(r0: Reviewed, rec: HandoffHire): void {
    const filed = rec.path ? { path: rec.path } : null;
    const reviewed: Reviewed = { ...r0, filed, planOp: filed ? r0.planOp : newOp() };
    const why = recordReason(rec);
    const text = filed ? this.afterFiling(why, filed) : `${why} Your task and settings are kept.`;
    this.giveBack(reviewed, { kind: 'failed', code: rec.code ?? 'handoff', message: why }, text, why);
  }

  /**
   * #198: Cancel request: nobody is hired from this submission from the click on, whatever the bridge answers later (the
   * filing ends now: `fileHandoff` gives the review back). The bridge's answer then says how the request ended.
   */
  private async cancelFiling(): Promise<void> {
    const f = this.filing;
    if (!f || this.state !== 'filing') return;
    const epoch0 = this.epoch;
    this.filing = null;
    const answer = f.cancel();
    // Settled by the cancel: what the status says until the bridge answers.
    const now = await f.run();
    const r = await answer;
    if (!r) return;
    if (!this.dialog.open || epoch0 !== this.epoch) {
      // Closed meanwhile: a handoff that is (or may be) in the cabinet is still worth a word.
      if (r.kind !== 'cancelled') this.host.toast(r.message, 'info');
      return;
    }
    // A newer press or message since: it stands.
    if (this.busy() || now.kind !== 'failed' || this.statusText !== now.message) return;
    this.setStatus(r.message, true);
    this.render();
  }

  /** #198: right before the hire, with the handoff filed: the composed task's size, the desk and the floor's caps again. */
  private launchBlocker(task: string): string | null {
    const bytes = new TextEncoder().encode(task).length;
    if (bytes > HIRE_PROMPT_MAX_BYTES) return `With the line that points to the handoff, the task is ${(bytes / 1024).toFixed(1)} KB; the limit is ${Math.round(HIRE_PROMPT_MAX_BYTES / 1024)} KB. Shorten the task, then hire again.`;
    const seat = resolveHireDesk(this.floor, this.host.store.floorView(this.floor), this.host.held(this.floor), this.desk);
    if (!seat.ok) return seat.msg;
    return capBlocker(this.capacity());
  }

  /** #198: a message after the handoff was filed says where it is, and that Hire now hires only. */
  private afterFiling(msg: string, filed: Filed | null = this.filed): string {
    if (!filed) return msg;
    return `The handoff is saved at ${filed.path}. ${msg.trim()} Hire again hires only: the handoff is not made again.`;
  }

  /** A hire waited for here ended: this dialog, or (closed meanwhile) a toast, says how; the go-to on success. */
  private landed(o: HireOutcome, hh: { floor: string; desk: number; who: string; epoch: number; filed?: Filed | null }): void {
    const still = this.dialog.open && hh.epoch === this.epoch;
    if (still) this.state = 'ready';
    if (o.kind === 'hired' || o.kind === 'not_prompted') {
      const ack = o.ack;
      const w = ack?.id ? this.host.store.workerView(ack.id) : null;
      const branch = ack?.branch ? ` on ${ack.branch}` : '';
      // #198: the review closes, so a composed task that did not reach the worker goes to their Prompt (P) note (AC8).
      const held = o.kind === 'not_prompted' && !!hh.filed && !!o.prompt && !!o.ack.id && this.host.holdTask?.(o.ack.id, o.prompt, null) === true;
      const notSent = o.kind === 'not_prompted' ? (hh.filed ? notPromptedBackgroundText(o.ack, held) : notPromptedText(o.ack)) : '';
      if (still) this.close();
      if (still && ack?.id) this.host.goTo?.(ack.id);
      const t = hiredToast(`Hired ${w?.name ?? hh.who} at Desk ${(w?.desk ?? hh.desk) + 1}${branch}. Here they come.`, ack, notSent);
      this.host.toast(t.text, t.kind);
      return;
    }
    const msg = o.kind === 'not_sent' ? o.message : o.kind === 'unknown' ? o.message : failureText('worker.hire', o.code, o.message, { floor: this.host.store.floorName(hh.floor), desk: hh.desk + 1 });
    if (!still) {
      if (msg) this.host.toast(this.afterFiling(msg, hh.filed ?? null), 'error');
      return;
    }
    // Back to the review as it was: nothing was cleared, a new press is a new hire (never after an unknown outcome unasked).
    this.setStatus(this.afterFiling(o.kind === 'unknown' ? `${msg} Look at the desk before you hire again.` : msg, hh.filed ?? null), true);
    this.render();
    if (o.kind === 'failed' && o.code === 'fetch_failed') void this.recheck();
  }

  /** #134: after a fetch refusal (the review opened on a preview): origin as it is now; the refusal stays in the status. */
  private async recheck(): Promise<void> {
    const [ticket, epoch] = [this.fetches.start(), this.epoch];
    const r = await this.host.send('hire.prepare', { floor: this.floor, ...(this.checked ? { cwd: this.checked } : {}) });
    if (r.ok) this.fetched(ticket, epoch, r.data as HirePrepare);
  }

  /**
   * #134: the recheck's answer, when no newer fetch was sent: origin and the caps as they are now, while the review shows
   * the same repository (a folder typed or previewed meanwhile does not drop it); the folder checked and the status stay.
   */
  private fetched(ticket: number, epoch: number, p: HirePrepare): void {
    if (!this.prep || !this.dialog.open || epoch !== this.epoch || this.state !== 'ready' || !this.fetches.current(ticket, this.prep.git, p.git)) return;
    this.adoptGit(p.git);
    this.prep = { ...this.prep, capacity: p.capacity };
    this.render();
  }

  // ---- a task given back (#33) -----------------------------------------------------------

  /** #198: the hire's choices for "Back to the handoff" (the label, folder and worktree only when chosen). */
  private carry(): HireCarry {
    const c = this.changed;
    return {
      floor: this.floor,
      desk: this.desk,
      choice: { ...this.choice },
      ...(c.label ? { label: this.f.label } : {}),
      ...(c.cwd ? { cwd: this.f.cwd } : {}),
      ...(c.worktree ? { worktree: this.f.worktree } : {}),
    };
  }

  private reviewed(): Reviewed {
    return {
      floor: this.floor,
      desk: this.desk,
      choice: { ...this.choice },
      f: { ...this.f },
      changed: { ...this.changed },
      prep: this.prep as HirePrepare,
      pending: this.pending,
      handover: this.handover,
      draft: this.composer.getDraft(),
      keep: [...this.keep],
      openSet: new Set(this.openSet),
      defaultCwd: this.defaultCwd,
      checked: this.checked,
      plan: this.plan,
      planOp: this.planOp,
      filed: this.filed,
    };
  }

  /**
   * A background hire was refused or got no answer (the coordinator said nothing: `kept`). The review opens again with
   * what was reviewed when nothing else is open and its floor can take a hire; else it is held, and the toast says so
   * with "Review again" (the palette lists it too). A review being edited is never closed, reset or overwritten.
   */
  /** #219 `status`: the status line once it is open again, when not the outcome's own words. */
  private giveBack(r: Reviewed, o: GivenBack, text: string, status?: string): void {
    if (!document.querySelector('dialog[open]') && !this.unavailable(r.floor)) {
      this.restore(r, status ?? (o.kind === 'failed' ? failureText('worker.hire', o.code, o.message, { floor: this.host.store.floorName(r.floor), desk: r.desk + 1 }) : text));
      return;
    }
    const id = this.holdReview(r, o, text, status);
    this.host.toast(`${text} The task is kept: review it again here or from the command palette.`, o.kind === 'failed' ? 'error' : 'warn', { label: 'Review again', run: () => void this.reopenHeld(id) });
  }

  private recordOutcome(o: HireOutcome, floor: string, desk: number): void {
    const key = `${floor}:${desk}`;
    if (o.kind === 'failed' || o.kind === 'unknown') this.outcomes.set(key, o);
    else this.outcomes.delete(key);
    if (o.kind === 'unknown' || o.kind === 'not_prompted' || (o.kind === 'failed' && o.data?.retryable === false)) this.unsafe.add(key);
    else this.unsafe.delete(key);
  }

  private holdReview(reviewed: Reviewed, outcome: GivenBack, text: string, status?: string): string {
    const existing = [...this.held].find(([, hld]) => hld.reviewed.draft === reviewed.draft)?.[0];
    const id = existing ?? String(++this.heldSerial);
    this.held.set(id, { reviewed, outcome, text, ...(status !== undefined ? { status } : {}) });
    this.renderRecoveryTray();
    return id;
  }

  private renderRecoveryTray(): void {
    this.recoveryTray.hidden = this.held.size === 0;
    this.recoveryTray.replaceChildren(...[...this.held].map(([id, hld]) => h('button', { class: 'btn', type: 'button', onclick: () => this.reopenHeld(id) }, `Review hire · ${this.host.store.floorName(hld.reviewed.floor)} · Desk ${hld.reviewed.desk + 1}`)));
  }

  /** The reviews held now (the palette's rows). */
  heldReviews(): HeldReview[] {
    return [...this.held].map(([id, h]) => ({ id, desk: h.reviewed.desk, where: this.host.store.floorName(h.reviewed.floor), task: h.reviewed.choice.task, outcome: h.outcome.kind }));
  }

  /**
   * Opens held review `id` again ("Review again", its palette row): from then on an ordinary review. While another
   * dialog is open, or its floor cannot take a hire now, the toast says so and it stays held (false).
   */
  reopenHeld(id: string): boolean {
    const h = this.held.get(id);
    if (!h) return false;
    const r = h.reviewed;
    const at = `Desk ${r.desk + 1} of ${this.host.store.floorName(r.floor)}`;
    const why = this.dialog.open ? 'A hire review is open: finish or close it first.' : document.querySelector('dialog[open]') ? 'Close the open dialog first.' : this.unavailable(r.floor);
    if (why) {
      this.host.toast(`${why} The task for ${at} is still kept.`, 'info');
      return false;
    }
    this.held.delete(id);
    this.renderRecoveryTray();
    this.restore(r, h.status ?? (h.outcome.kind === 'failed' ? failureText('worker.hire', h.outcome.code, h.outcome.message, { floor: this.host.store.floorName(r.floor), desk: r.desk + 1 }) : h.text));
    return true;
  }

  /** Why the floor cannot take a hire now (gone, or asleep and not virtual), as `refresh` would close the review for it. */
  private unavailable(floor: string): string | null {
    const fv = this.host.store.floorView(floor);
    if (!fv) return `${this.host.store.floorName(floor)} is not there right now.`;
    if (fv.asleep && !fv.virtual) return `${this.host.store.floorName(floor)} is asleep; wake it to hire.`;
    return null;
  }

  /** The review as it was reviewed, open again in `ready` with `status` (Hire never pressed: a new press is a new hire). */
  private restore(r: Reviewed, status: string): void {
    this.epoch++;
    this.opening++;
    this.floor = r.floor;
    this.desk = r.desk;
    this.prep = r.prep;
    this.pending = r.pending;
    this.handover = r.handover;
    this.choice = r.choice;
    this.keep = [...r.keep];
    this.openSet = new Set(r.openSet);
    this.f = { ...r.f };
    this.changed = { ...r.changed };
    this.defaultCwd = r.defaultCwd;
    this.checked = r.checked;
    this.plan = r.plan;
    this.planOp = r.planOp;
    this.filed = r.filed;
    this.bg = null;
    this.filing?.stop();
    this.filing = null;
    this.modelQuery = '';
    this.refetching = false;
    this.hadWhereIssue = false;
    this.checking = false;
    this.hiringText = null;
    this.state = 'ready';
    this.panelKeys.clear();
    this.showDraft(r.draft);
    const memory = 'This review stays in this tab only; copy the task before refreshing.';
    this.setStatus(this.afterFiling(status.endsWith(memory) ? status : `${status} ${memory}`), true);
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.focusFirst();
  }

  // ---- test hook ------------------------------------------------------------------------

  summary(): ReviewSummary | null {
    if (!this.dialog.open) return null;
    return {
      kind: 'hire-review',
      floor: this.floor,
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
      handoff: this.plan
        ? {
            worker: this.plan.worker,
            mode: this.plan.mode,
            instruction: this.plan.instruction,
            sendHome: this.plan.sendHome,
            op: this.planOp,
            filed: this.filed?.path ?? null,
            composed: this.composed(this.filed?.path ?? PATH_PLACEHOLDER),
            bridge: this.bg ? { op: this.bg.op, accepted: this.bg.accepted } : null,
          }
        : null,
    };
  }
}

/** #219: why a handoff hire ended without a hire, as one sentence that says nobody was hired. */
function recordReason(r: HandoffHire): string {
  const why = (r.reason ?? '').trim() || (r.state === 'cancelled' ? 'Cancelled: nothing was filed.' : 'It stopped.');
  const end = /[.!?…]$/.test(why) ? why : `${why}.`;
  return /nobody (was|is) hired|\bnot hired\b/i.test(end) ? end : `${end} Nobody was hired.`;
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
