import type { CommandArgs, Hire, HireGit, HireOptions, Preset, RunPrepare, RunStartAck } from '../net/protocol';
import { baseHint, baseText, capacityView, fetchNote, firstFreeDesk, freeDesks, HARNESS_LABEL, modelsFor, newerGit, offeredOptions, resolveVisibleChoice, worktreeUsable, type CapacityView } from '../world/hire';
import { labelsOf, modelEntries } from '../world/modelLabel';
import { effortsFor } from '../world/settings';
import {
  emptyPreview,
  EXTRA_MAX,
  parseTicket,
  prepareArgs,
  previewEdited,
  previewGenerated,
  previewLocked,
  previewReset,
  previewStale,
  startArgs,
  startBlocker,
  ticketLine,
  type Preview,
  type RunForm,
  type TicketInput,
  type WorkItemRef,
} from '../world/startRun';
import { h, icon, ICON } from './dom';
import './start.css';
import { deskTabs, pinIdOf } from './deskTabs';
import { chips, profileChips, profileGoneNote, type HireHost } from './hire';
// #167 run profiles
import { roleGoneText, roleLoneGone, roleProfileChoice, withProfile, type RoleProfileChoice } from '../world/runProfiles';
import { deskPins } from './hirePins';
import { failureText } from './messages';
import { onReviewKey, reviewButton, type FieldText, type GoFields } from './secretsFlow';
import { hiredToast } from './hiredToast';
// M10 limits
import { planLimits } from './limits';
import { backdropPolicy } from './dismiss';
// #64 composer
import { mountComposer, type Composer } from './composer/composer';
import { Draft as PromptDraft } from './composer/draft';
import { failedImagesText, heldRefusalText, markedText, notSentText, PASTE_HINT } from './composer/field';
import { HIRE_PROMPT_MAX_BYTES } from './composer/model';
// #39 completion
import { CommandCatalogs } from '../laptop/commandCatalog';
import { CompletionScope, hireLookupKey, hireSources, type HireLookup } from './dialogCompletion';

/**
 * The start-run dialog (M6): the "Hire orchestrator" tab of the hire dialog
 * on an empty desk, the top bar's Run (the floor's first free desk), and
 * `openStartRun` for M7's "Hand to a worker". It hires an orchestrator (the
 * M4 hire) whose first prompt starts a /write-code run with a team preset.
 * The prompt preview comes from `run.prepare` on every field change; once
 * edited it is the user's, and field changes only say that it differs.
 * #64: Extra instructions and the First prompt are the shared composer: paste
 * a screenshot and it sits in the text as a chip, the orchestrator gets
 * `[Image #n: <path>]` in its place. The generated prompt shows the extra's
 * images as chips too. The Ticket is text only (its words make the label and
 * the issue reference; images belong in Extra).
 */

export interface StartRunHost extends HireHost {
  /** The Worker tab: the M4 hire dialog for the same desk. */
  hireAt(floor: string, desk: number): void;
  /** The presets panel, over this dialog (focus comes back to `from`). */
  openPresets(from: HTMLElement | null): void;
  /** The run started: the view follows the new orchestrator. M7: `workItem` when it started on a board card. */
  started(workerId: string, workItem?: { provider: string; id: string }): void;
}

export interface StartRunOptions {
  floor: string;
  /** M7: an issue to start on (a number of the floor's repo, `#n`, or an issue URL). */
  issue?: number | string;
  /** M7: "Hand to a worker": a card of the issue board to start on (the ticket is this card, sent as `work_item`). */
  workItem?: WorkItemRef;
  /** A desk of the floor; absent: the first free one. */
  desk?: number;
}

export type StartRunState = 'preparing' | 'ready' | 'starting' | 'failed';

/** What the start-run dialog shows (test hook). */
export interface StartRunSummary {
  kind: 'start-run';
  floor: string;
  desk: number;
  title: string;
  state: StartRunState;
  form: RunForm;
  ticket: TicketInput;
  /** The ticket as the dialog reads it back. */
  ticketLine: string;
  /** The bridge refused the ticket (e.g. no linked repo), null otherwise. */
  ticketError: string | null;
  preview: Preview & { stale: boolean };
  /** A `run.prepare` is on its way (or waiting out the debounce). */
  preparing: boolean;
  label: string;
  /** #167: the orchestrator's Codex profile as `run.start` sends it (null: none sent, the default). */
  profile: string | null;
  /** `hint` (#134): a preview's base is the last fetched one, or not known yet (null: a fetch's answer). */
  git: { base: string; hint: string | null; usable: boolean; note: string | null } | null;
  capacity: CapacityView | null;
  blocker: string | null;
  status: string;
  error: boolean;
}

/** Why the orchestrator tab / Run is off on this bridge (null: it is there). */
export function runUnsupported(host: Pick<HireHost, 'store' | 'unsupported'>): string | null {
  if (host.unsupported('run.prepare') || host.unsupported('run.start') || !host.store.presets.known) return failureText('run.start', 'unknown_command', '');
  return null;
}

const DESK_PLUS = '<path d="M12 5v14M5 12h14"/>';
/** Wait this long after the last keystroke before asking for a new preview. */
const DEBOUNCE_MS = 250;


export class StartRunDialog {
  private readonly dialog = h('dialog', { class: 'desk-dlg desk-dlg--run', 'aria-labelledby': 'run-title', 'aria-describedby': 'run-sub' });
  private readonly head = h('header', { class: 'dd-head' });
  private readonly tabsSlot = h('div', { class: 'dd-tabs-slot' });
  private readonly form = h('form', { class: 'dd-body', id: 'run-form', novalidate: true, role: 'tabpanel', 'aria-label': 'Hire orchestrator' });
  private readonly statusEl = h('p', { class: 'dd-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private readonly actions = h('div', { class: 'dd-actions' });
  private readonly notices = h('div', { class: 'dd-notices' });
  private readonly foot = h('footer', { class: 'dd-foot' }, this.notices, this.statusEl, this.alertEl, this.actions);

  private floor = '';
  /** What `run.start` is doing, once it is sent (null: not yet): the status line under "Waking floor…" (#58). */
  private startingText: string | null = null;
  private desk = 0;
  private state: StartRunState = 'preparing';
  private prep: RunPrepare | null = null;
  private f: RunForm = blankForm();
  private preview: Preview = emptyPreview();
  /** The user picked the orchestrator's harness / model / effort: a new preset no longer changes it. */
  private orchTouched = false;
  /** #167: the orchestrator's Codex profile as picked here (null: the preset's, else the default). */
  private orchProfile: string | null = null;
  private ticketError: string | null = null;
  private statusText = '';
  private statusError = false;
  /** Bumped on every open and prepare, so a late answer for an older one is dropped. */
  private gen = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  /**
   * #134: Fetch again or a fetch refusal asked for origin, and no answer that fetched has come back yet: until one
   * does, every prepare fetches (a field typed meanwhile drops the first answer, never the fetch).
   */
  private fetchWanted = false;
  private presetsSeen = -1;
  private renderedKey = '';
  private startBtn: HTMLButtonElement | null = null;
  /** Where focus goes back to when the dialog closes (not when it hands over to the Worker tab). */
  private returnTo: HTMLElement | null = null;
  /** #64: the Extra instructions and the First prompt, each a composer over a draft of its own (text, images, uploads). */
  private readonly extraC: Composer;
  private readonly promptC: Composer;
  private extraDraft: PromptDraft;
  private promptDraft: PromptDraft;
  /** The dialog is putting the generated prompt into its composer: that is not an edit. */
  private syncing = false;
  /** Start is waiting for the images (read-only meanwhile), then sends. */
  private resolving = false;
  /** Bumped by every open: an answer for an older one is dropped. */
  private opened = 0;
  /** #108: the opening (`opened`) whose `run.start` is at the bridge now: Esc then leaves a run that still starts. */
  private sending = -1;
  /**
   * The two composer fields are built once and stay in the form across re-renders (`keepChildren`): a composer that is
   * detached loses its caret, its selection (a drag in progress) and its focus, which a textarea could be given back.
   */
  private readonly extraEl: HTMLElement;
  private promptEl: HTMLElement | null = null;
  /**
   * #39: `/`, `@` and `@r:` in Extra instructions and the First prompt: the orchestrator's hire as it would be made (the
   * floor, its harness, the floor's folder, a worktree's repository root), shared by both fields.
   */
  private lookup: HireLookup | null = null;
  private ownCatalogs: CommandCatalogs | null = null;
  private readonly lookups = new CompletionScope(
    () => {
      const p = this.prep;
      const harness = this.f.orch?.harness;
      if (!this.dialog.open || !p || !harness || this.state === 'preparing' || this.state === 'failed') return (this.lookup = null);
      this.lookup = { floor: this.floor, harness, cwd: p.cwd, worktree: this.f.worktree && worktreeUsable(p.git) };
      return hireLookupKey(this.lookup);
    },
    () => {
      const host = this.host;
      const catalogs = host.catalogs ?? (this.ownCatalogs ??= new CommandCatalogs({ send: (t, args) => host.send(t, args) }));
      return hireSources({ send: host.send.bind(host), unsupported: (t) => host.unsupported(t), catalogs, repoRefs: host.store.repoRefs, repoDiscovery: host.store.repoDiscovery, floorName: (id) => host.store.floorName(id) }, this.lookup as HireLookup);
    },
  );

  constructor(
    parent: HTMLElement,
    private readonly host: StartRunHost,
  ) {
    this.alertEl.hidden = true;
    this.statusEl.hidden = true;
    // #108: the run's texts reviewed on purpose (Ctrl/⌘+Shift+X, with the switch on); the switch shows or hides the button.
    onReviewKey(this.dialog, () => this.host.secrets, () => void this.start(true));
    host.secrets?.onChange(() => {
      if (this.dialog.open) this.renderActions();
    });
    // Settings → Harness models changed what the orchestrator chips offer.
    this.host.modelPrefs?.onChange(() => this.visibilityChanged());
    // #167: the profiles changed (one signed in, hidden, renamed): the orchestrator's chips follow.
    this.host.store.codexProfiles?.onChange(() => {
      if (this.dialog.open) this.render();
    });
    // A pin added, removed or moved (a drag in this tab bar too): the tab bar follows.
    this.host.pins?.onChange(() => {
      if (this.dialog.open) this.render();
    });
    this.extraDraft = this.newDraft('run-extra', EXTRA_MAX);
    this.promptDraft = this.newDraft('run-prompt', HIRE_PROMPT_MAX_BYTES);
    this.extraC = mountComposer({
      draft: this.extraDraft,
      labelledBy: 'run-extra-label',
      describedBy: 'run-extra-hint',
      placeholder: 'Anything the orchestrator should know: scope, constraints, taste',
      // Enter adds a line; Ctrl/⌘+Enter starts the run from anywhere in the dialog (its own key handler, below).
      submitPolicy: 'mod-enter',
      // Inside the form, which scrolls (and would clip it): above the caret when below has no room.
      complete: { sources: this.lookups.sources, bounds: () => this.form },
      onChange: (s) => {
        if (this.syncing) return;
        const text = markedText(s);
        if (text !== this.f.extra) {
          this.f.extra = text;
          this.schedule();
        }
        this.renderActions();
      },
    });
    this.extraC.editor.id = 'run-extra';
    this.extraC.editor.dataset.key = 'extra';
    this.promptC = mountComposer({
      draft: this.promptDraft,
      labelledBy: 'run-prompt-label',
      describedBy: 'run-prompt-note',
      placeholder: 'The first prompt appears here once there is a ticket.',
      submitPolicy: 'mod-enter',
      // Inside the form, which scrolls (and would clip it): above the caret when below has no room.
      complete: { sources: this.lookups.sources, bounds: () => this.form },
      onChange: (s) => {
        if (this.syncing) return;
        const text = markedText(s);
        if (text !== this.preview.text) {
          this.preview = previewEdited(this.preview, text);
          this.renderPreviewState();
        }
        this.renderActions();
      },
    });
    this.promptC.editor.id = 'run-prompt';
    this.promptC.editor.dataset.key = 'prompt';
    this.extraEl = h(
      'div',
      { class: 'dd-field dd-extra' },
      h('label', { id: 'run-extra-label', onclick: () => this.extraC.focus() }, 'Extra instructions ', h('span', { class: 'dd-optional' }, 'optional')),
      this.extraC.element,
      h('p', { class: 'field-hint', id: 'run-extra-hint' }, h('kbd', {}, 'Ctrl'), '+', h('kbd', {}, 'Enter'), ` starts the run · ${PASTE_HINT}`),
    );
    this.dialog.append(this.head, this.tabsSlot, this.form, this.foot);
    this.dialog.addEventListener('close', () => {
      if (this.dialog.open) return;
      this.gen++;
      this.clearTimer();
      const back = this.returnTo;
      this.returnTo = null;
      if (back?.isConnected && !this.dialog.contains(back)) back.focus();
    });
    this.dialog.addEventListener('cancel', () => {
      // Esc while the run.start is on its way: the run still starts; the dialog just goes. (#108: not while its texts are
      // scanned, or scanned again after a refusal: then nothing starts, and nothing is said.)
      if (this.sending === this.opened) this.host.toast('The run is still starting; its orchestrator shows up at the desk when it is hired.', 'info');
    });
    // #51: typed text or a consequential choice in here: only the close button and Esc close it, never the backdrop.
    backdropPolicy(this.dialog, 'none');
    // Ctrl+Enter (⌘+Enter) starts from anywhere in the dialog; plain Enter never does.
    this.dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        void this.start();
      }
    });
    this.form.addEventListener('submit', (e) => e.preventDefault());
    parent.append(this.dialog);
  }

  /** A composer draft whose uploads say which field they came from (`h3d-run-extra-1.png`). */
  private newDraft(label: string, maxPromptBytes: number): PromptDraft {
    return new PromptDraft({ upload: (f, hint, signal) => this.host.upload(f, hint, signal), label, maxPromptBytes, holdRefused: true });
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  /** The element the dialog lives in (the presets panel opens over it). */
  get element(): HTMLDialogElement {
    return this.dialog;
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  /** `fromTab`: the Worker tab handed over (focus goes to this dialog's tab, as in one tab list). */
  open(o: StartRunOptions & { desk: number }, fromTab = false): void {
    if (!this.dialog.open && !fromTab) {
      const a = document.activeElement;
      this.returnTo = a instanceof HTMLElement && a !== document.body ? a : null;
    }
    this.floor = o.floor;
    this.desk = o.desk;
    this.prep = null;
    this.f = blankForm();
    this.f.desk = o.desk;
    if (o.issue !== undefined) this.f.ticket = typeof o.issue === 'number' ? `#${o.issue}` : o.issue;
    this.f.workItem = o.workItem ?? null;
    this.preview = emptyPreview();
    // A new run starts from empty fields: the last one's drafts (and their uploads) go.
    this.opened++;
    this.resolving = false;
    this.extraDraft.dispose();
    this.promptDraft.dispose();
    this.extraDraft = this.newDraft('run-extra', EXTRA_MAX);
    this.promptDraft = this.newDraft('run-prompt', HIRE_PROMPT_MAX_BYTES);
    this.extraC.setDraft(this.extraDraft);
    this.promptC.setDraft(this.promptDraft);
    this.orchTouched = false;
    this.orchProfile = null;
    this.ticketError = null;
    this.renderedKey = '';
    this.presetsSeen = this.host.store.presets.version;
    this.clearTimer();
    this.inFlight = false;
    this.fetchWanted = false;
    const off = runUnsupported(this.host);
    this.state = off ? 'failed' : 'preparing';
    this.setStatus(off ?? this.askingText(), !!off);
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.dialog.querySelector<HTMLElement>(fromTab ? '[data-key="tab:orch"]' : '#run-ticket')?.focus();
    if (!off) void this.prepare();
  }

  private title(): string {
    return `Start a run at Desk ${this.desk + 1}`;
  }

  private ticket(): TicketInput {
    if (this.f.workItem) return { kind: 'work_item', item: this.f.workItem, why: null };
    return parseTicket(this.f.ticket, this.repo());
  }

  private repo(): string | null {
    const fv = this.host.store.floorView(this.floor);
    return fv?.settings.repo ?? fv?.suggested.repo ?? null;
  }

  // ---- the bridge -------------------------------------------------------------------

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** A field that changes the prompt changed: a new preview once typing pauses. */
  private schedule(): void {
    if (this.state === 'failed' || this.state === 'starting') return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.prepare();
    }, DEBOUNCE_MS);
    this.renderPreviewState();
  }

  /** #134: the wait names origin only when the bridge fetches it (an older bridge, on every prepare). */
  private askingText(): string {
    return this.host.store.preparePreview ? 'Asking herdr-world for the team and the folder…' : 'Asking herdr-world for the team, the folder and origin…';
  }

  /** `fetch` (Fetch again, after a fetch refusal): origin fetched now; else (#134) a preview of the local refs, where the bridge has one. */
  private async prepare(fetch = false): Promise<void> {
    const gen = ++this.gen;
    this.inFlight = true;
    if (fetch) this.fetchWanted = true;
    const fetches = this.fetchWanted || !this.host.store.preparePreview;
    const args = prepareArgs(this.floor, this.f, this.ticket());
    if (!fetches) args.preview = true;
    const r = await this.host.send('run.prepare', args);
    if (gen !== this.gen || !this.dialog.open || this.state === 'starting') return;
    this.inFlight = false;
    if (!r.ok) {
      if (r.code === 'unknown_command') {
        this.state = 'failed';
        this.setStatus(failureText('run.prepare', r.code, r.message), true);
      } else if (this.prep && r.code === 'bad_request') {
        // The fields as they are cannot make a prompt (e.g. an issue number without a repo): say so by the ticket.
        this.state = 'ready';
        this.ticketError = r.message.replace(/^bad args:\s*/, '');
        this.preview = previewGenerated(this.preview, '');
      } else if (this.prep) {
        this.state = 'ready';
        this.setStatus(failureText('run.prepare', r.code, r.message, { floor: this.floorName() }), true);
      } else {
        this.state = 'failed';
        this.setStatus(failureText('run.prepare', r.code, r.message, { floor: this.floorName() }), true);
      }
      this.render();
      return;
    }
    if (fetches) this.fetchWanted = false;
    const first = !this.prep;
    // #134: an edit's preview does not replace what a fetch said (the folder is the floor's, the same repository).
    const p = { ...(r.data as RunPrepare), ...(this.prep ? { git: newerGit(this.prep.git, (r.data as RunPrepare).git) } : {}) };
    this.prep = p;
    if (first) {
      this.f.preset = p.preset;
      this.f.orch = resolveVisibleChoice(this.options(), p.orch);
      this.f.worktree = (this.host.hirePrefs?.worktreeByDefault ?? true) && worktreeUsable(p.git);
    } else if (!worktreeUsable(p.git)) this.f.worktree = false;
    this.ticketError = null;
    this.preview = previewGenerated(this.preview, p.prompt);
    this.state = 'ready';
    if (!this.statusError || first) this.setStatus('');
    this.render();
  }

  /** #58: the floor's name (never its id). */
  private floorName(): string {
    return this.host.store.floorName(this.floor);
  }

  /** The status line while `run.start` is on its way: "Waking floor…" first while the floor's session wakes (#58 decision 3). */
  private startingStatus(): void {
    const fv = this.host.store.floorView(this.floor);
    const wakes = !!fv && (fv.transition === 'waking' || (fv.asleep && fv.virtual));
    this.setStatus(wakes ? `Waking floor ${this.floorName()}… then ${this.startingText ?? 'starting'}` : (this.startingText ?? ''));
  }

  /** The world changed: the desk may be taken, the floor gone or asleep, a preset changed or gone. */
  refresh(): void {
    if (!this.dialog.open) return;
    // #58 decision 3: a run on an asleep virtual floor wakes its session first: the status follows the wake.
    if (this.state === 'starting') {
      if (this.startingText !== null) this.startingStatus();
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
      this.host.toast(`${this.floorName()} went to sleep; wake it to start a run.`, 'info');
      return;
    }
    const book = this.host.store.presets;
    if (book.version !== this.presetsSeen) {
      this.presetsSeen = book.version;
      if (this.prep && this.state === 'ready') {
        if (!book.get(this.f.preset)) {
          const next = book.defaultFor(fv.floor.last_preset);
          this.f.preset = next?.id ?? '';
          if (next && !this.orchTouched) this.f.orch = resolveVisibleChoice(this.options(next), next.roles.orch);
        }
        // Its roles may have changed: the team lines with them.
        if (this.f.preset) this.schedule();
      }
    }
    this.render();
  }

  // ---- state -----------------------------------------------------------------------

  private setStatus(msg: string, error = false): void {
    this.statusText = msg;
    this.statusError = error && !!msg;
    this.alertEl.hidden = !error || !msg;
    this.statusEl.hidden = error || !msg;
    (error ? this.alertEl : this.statusEl).textContent = msg;
    (error ? this.statusEl : this.alertEl).textContent = '';
  }

  private capacity(): CapacityView | null {
    return this.prep ? capacityView(this.prep.capacity, this.floorName()) : null;
  }

  private takenBy(): { why: string; next: number | null } | null {
    const fv = this.host.store.floorView(this.floor);
    if (!fv || this.state === 'starting') return null;
    const held = this.host.held(this.floor);
    const seat = fv.seats[this.f.desk];
    const why = seat ? `${seat.name} just sat down at Desk ${this.f.desk + 1}.` : held.has(this.f.desk) ? `Another hire is already on its way to Desk ${this.f.desk + 1}.` : this.f.desk >= fv.desks ? `Desk ${this.f.desk + 1} is gone.` : null;
    return why ? { why, next: firstFreeDesk(fv, held) } : null;
  }

  private blocker(): string | null {
    if (this.state === 'failed') return this.statusText || 'herdr-world could not prepare the run.';
    if (this.state === 'preparing' || !this.prep) return 'Waiting for herdr-world…';
    if (this.state === 'starting') return 'The run is starting.';
    const taken = this.takenBy();
    if (taken) return taken.why;
    if (this.capacity()?.level === 'full') return 'Over the hard cap: send someone home first.';
    const t = this.ticket();
    if (this.ticketError && t.kind !== 'empty') return this.ticketError;
    // An image that did not upload: its chip says why and has its Retry; nothing starts until it is uploaded or gone.
    // A file a field refused stays held until the user dismisses it: the run does not start without the picture meant for it.
    const held = { nothing: 'started', again: 'start' };
    const refused = heldRefusalText(this.extraDraft.snapshot(), held);
    if (refused) return `Extra instructions: ${refused}`;
    const refusedPrompt = heldRefusalText(this.promptDraft.snapshot(), held);
    if (refusedPrompt) return `First prompt: ${refusedPrompt}`;
    const bad = failedImagesText(this.extraDraft.snapshot());
    if (bad) return `Extra instructions: ${bad}`;
    const badPrompt = this.preview.custom ? failedImagesText(this.promptDraft.snapshot()) : null;
    if (badPrompt) return `First prompt: ${badPrompt}`;
    return startBlocker(this.f, t, this.preview, this.host.store.hireOptions, this.host.store.presets);
  }

  private gitView(g: HireGit | null): StartRunSummary['git'] {
    if (!g) return null;
    return { base: baseText(g, this.host.now()), hint: baseHint(g), usable: worktreeUsable(g), note: fetchNote(g)?.text ?? null };
  }

  private preset(): Preset | null {
    return this.host.store.presets.get(this.f.preset);
  }

  /**
   * The catalog the orchestrator chips offer: the models Settings leaves shown, plus the orchestrator `preset` names,
   * so a preset's choice is never swapped for another model behind its back.
   */
  private options(preset: Preset | null = this.preset()): HireOptions {
    const prefs = this.host.modelPrefs;
    return offeredOptions(this.host.store.hireOptions, prefs && ((harness) => prefs.hidden(harness)), [preset?.roles.orch]);
  }

  /** Every model of the orchestrator's harness is hidden in Settings: say so where the model chips would be. */
  private noModels(harness: string): HTMLElement {
    const total = this.host.store.hireOptions[harness]?.models.length ?? 0;
    const label = HARNESS_LABEL[harness] ?? harness;
    const text = total ? `All ${total} ${label} models are hidden, so there is nothing to start with.` : 'This harness has no models to start with.';
    const open = this.host.showModelSettings && total ? h('button', { class: 'btn btn--sm', 'data-key': 'show-models', onclick: () => this.host.showModelSettings?.() }, 'Open Harness models') : null;
    return h('div', { class: 'dd-field dd-callout', 'data-hook': 'no-models', role: 'status' }, h('p', {}, text), open);
  }

  /** Settings changed what is shown: an orchestrator on a model now hidden (and not the preset's) takes the first shown one. */
  private visibilityChanged(): void {
    if (!this.dialog.open || this.state !== 'ready' || !this.f.orch) return;
    const was = this.f.orch;
    this.f.orch = resolveVisibleChoice(this.options(), was);
    this.render();
    if (this.f.orch.model !== was.model || this.f.orch.effort !== was.effort) this.schedule();
  }

  // ---- rendering ----------------------------------------------------------------------

  private render(): void {
    // #39: another harness, folder or worktree choice: an open popup follows it (its old rows never go in).
    this.lookups.check();
    const fv = this.host.store.floorView(this.floor);
    const where = fv?.level ? `Floor ${fv.level.number} of ${fv.level.count} · ${fv.building?.name ?? ''}` : 'Unassigned lot';
    const book = this.host.store.presets;
    const free = fv ? freeDesks(fv).filter((d) => d === this.f.desk || !this.host.held(this.floor).has(d)) : [];
    const key = JSON.stringify([this.floor, this.f.desk, this.state, this.f.workItem?.id ?? null, this.prep && { ...this.prep, prompt: '', label: '' }, this.f.preset, this.f.orch, this.f.worktree, where, this.takenBy(), this.statusText, book.version, free, this.ticketError !== null, this.host.store.limits.version, this.host.modelPrefs?.version, this.f.orch && labelsOf(this.host.store.hireOptions, this.f.orch.harness), this.host.store.hirePresets?.version, this.host.pins?.version, this.profileChoice(), this.loneGone()]);
    if (key === this.renderedKey) {
      this.renderLive();
      return;
    }
    this.renderedKey = key;
    const a = document.activeElement;
    const focusKey = a instanceof HTMLElement && this.dialog.contains(a) ? (a.dataset.key ?? a.id) : null;
    // A live re-render while typing keeps the caret where it was.
    const caret = a instanceof HTMLTextAreaElement || (a instanceof HTMLInputElement && a.type !== 'checkbox' && a.type !== 'radio') ? [a.selectionStart, a.selectionEnd, a.scrollTop] : null;

    this.head.replaceChildren(
      h('div', { class: 'dd-plate dd-plate--desk', 'aria-hidden': 'true' }, icon(DESK_PLUS), h('b', {}, String(this.desk + 1))),
      h('div', { class: 'dd-titles' }, h('h2', { id: 'run-title' }, this.title()), h('p', { id: 'run-sub' }, `${this.floorName()} · ${where}`)),
      h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close)),
    );
    this.tabsSlot.replaceChildren(
      deskTabs(
        'orch',
        (t) => {
          if (this.state === 'starting') return;
          // The Worker (or #93 Preset, or a pinned preset's) tab takes over, focus and all; what opened this dialog is that dialog's to restore.
          this.returnTo = null;
          const { floor } = this;
          const { desk } = this.f;
          this.close();
          const pin = pinIdOf(t);
          if (t === 'preset') this.host.presetsAt?.(floor, desk);
          else if (pin !== null) this.host.usePinned?.(floor, desk, pin);
          else this.host.hireAt(floor, desk);
        },
        null,
        !!this.host.presetsAt,
        this.host.usePinned ? deskPins(this.host.pins, this.host.store.hirePresets, this.host.store.hireOptions, this.floor) : undefined,
      ),
    );

    const busy = this.state === 'starting' || this.state === 'preparing' || this.state === 'failed';
    const nodes: Node[] = [h('div', { class: 'run-writing' }, this.ticketField(), this.extraEl)];
    const notices: Node[] = [];
    const options = this.options();

    // Desk and team.
    const desk = h('select', { id: 'run-desk', 'data-key': 'desk', 'aria-describedby': 'run-desk-hint' });
    for (const d of free.length ? free : [this.f.desk]) desk.append(h('option', { value: String(d), selected: d === this.f.desk ? true : null }, `Desk ${d + 1}`));
    desk.addEventListener('change', () => this.moveTo(Number(desk.value)));
    const preset = h('select', { id: 'run-preset', 'data-key': 'preset', 'aria-describedby': 'run-preset-hint' });
    const list = book.list();
    if (!list.length) preset.append(h('option', { value: '' }, 'No presets yet'));
    for (const p of list) preset.append(h('option', { value: p.id, selected: p.id === this.f.preset ? true : null }, p.name));
    preset.addEventListener('change', () => this.pickPreset(preset.value));
    const edit = h('button', { class: 'btn btn--sm', 'data-key': 'presets', title: 'Create, edit and delete team presets', onclick: (e: Event) => this.host.openPresets(e.currentTarget as HTMLElement) }, icon(ICON.pencil), h('span', {}, 'Presets'));
    const last = this.f.preset && fv?.floor.last_preset === this.f.preset ? 'Last run here' : null;
    const setup: Node[] = [
      h(
        'div',
        { class: 'dd-grid dd-grid--run' },
        h('div', { class: 'dd-field' }, h('label', { for: 'run-desk' }, 'Desk'), desk, h('p', { class: 'field-hint', id: 'run-desk-hint' }, 'Where the orchestrator sits.')),
        h(
          'div',
          { class: 'dd-field' },
          h('label', { for: 'run-preset' }, 'Team preset ', last ? h('span', { class: 'tape tape--note' }, last) : null),
          h('div', { class: 'field-row' }, preset, edit),
          h('p', { class: 'field-hint', id: 'run-preset-hint' }, 'Who it hires for coding, reviews, UX and research.'),
        ),
      ),
    ];

    // The orchestrator itself.
    if (this.f.orch) {
      const o = this.f.orch;
      const p = this.preset()?.roles.orch;
      const same = !!p && p.harness === o.harness && p.model === o.model && p.effort === o.effort;
      const note = same ? h('span', { class: 'tape tape--note', title: 'The orchestrator of the chosen preset' }, 'Preset') : null;
      // The run uses both the orchestrator's and the team preset's harnesses.
      const roles = this.preset()?.roles;
      const inline = planLimits(this.host.store.limits, [o, ...(roles ? Object.values(roles) : [])].map((r) => ({ harness: r.harness, model: r.model })), this.host.now());
      const limits = h('div', { class: 'dd-plan-limits', 'data-hook': 'plan-limits' }, inline);
      limits.hidden = !inline;
      setup.push(
        h(
          'div',
          { class: 'dd-agent', role: 'group', 'aria-label': 'Orchestrator' },
          h('p', { class: 'dd-agent-title' }, 'Orchestrator'),
          chips('orch-harness', 'Harness', Object.keys(options), o.harness, (v) => this.pickOrch({ harness: v }), note),
          ...(o.model
            ? [
                chips('orch-model', 'Model', modelsFor(options, o.harness), o.model, (v) => this.pickOrch({ model: v }), null, modelEntries(o.harness, modelsFor(options, o.harness), labelsOf(options, o.harness))),
                chips('orch-effort', 'Effort', effortsFor(options, o.harness, o.model), o.effort, (v) => this.pickOrch({ effort: v })),
              ]
            : [this.noModels(o.harness)]),
          limits,
          ...this.profileNodes(),
        ),
      );
    } else setup.push(h('div', { class: 'dd-skeleton', 'aria-hidden': 'true' }, h('i'), h('i')));
    nodes.push(h('div', { class: 'run-setup' }, ...setup));

    const label = h('input', { id: 'run-label', 'data-key': 'label', autocomplete: 'off', spellcheck: 'false', maxlength: 64, placeholder: this.prep?.label || 'ORCH|…' });
    label.value = this.f.label;
    label.addEventListener('input', () => {
      this.f.label = label.value;
      this.renderActions();
    });
    nodes.push(
      h(
        'div',
        { class: 'dd-grid' },
        h('div', { class: 'dd-field' }, h('label', { for: 'run-label' }, 'Label'), label, h('p', { class: 'field-hint' }, 'Its workspace label in herdr.')),
        h('div', { class: 'dd-field' }, h('span', { class: 'dd-label' }, 'Folder'), h('code', { class: 'dd-fact', id: 'run-cwd' }, this.prep?.cwd ?? '…'), h('p', { class: 'field-hint' }, 'The floor’s default folder, on the server.')),
      ),
    );

    const g = this.prep ? this.gitView(this.prep.git) : null;
    if (g) {
      const on = this.f.worktree && g.usable;
      const box = h('input', { type: 'checkbox', id: 'run-worktree', 'data-key': 'worktree', 'aria-describedby': 'run-worktree-base' });
      box.checked = on;
      box.disabled = !g.usable;
      box.addEventListener('change', () => {
        this.f.worktree = box.checked;
        this.render();
      });
      nodes.push(
        h(
          'div',
          { class: 'dd-worktree', 'data-on': on ? 'true' : 'false', 'data-off': g.usable ? null : 'true' },
          h('label', { class: 'dd-check', for: 'run-worktree' }, box, h('span', { class: 'dd-check-box', 'aria-hidden': 'true' }), h('span', {}, 'Work in its own git worktree & branch')),
          h(
            'p',
            { class: 'dd-base', id: 'run-worktree-base' },
            !g.usable ? 'Off: origin could not be fetched. Last fetched ' : on ? 'A new h3d/… branch from ' : 'Would branch from ',
            h('code', {}, g.base),
            g.hint ? ` (${g.hint})` : null,
          ),
        ),
      );
      if (g.note)
        notices.push(
          h(
            'div',
            { class: 'dd-callout dd-callout--error dd-fetch', role: 'alert' },
            h('p', {}, g.note.replace('hire without one', 'start without one')),
            h('button', { class: 'btn btn--sm', 'data-key': 'refetch', disabled: this.state !== 'ready', onclick: () => void this.prepare(true) }, 'Fetch again'),
          ),
        );
    }
    nodes.push(this.promptField());
    if (this.prep) notices.push(this.capacityBlock());
    const taken = this.state === 'ready' ? this.takenBy() : null;
    if (taken) {
      const alt = taken.next;
      notices.unshift(
        h(
          'div',
          { class: 'dd-callout dd-callout--error', role: 'alert' },
          h('p', {}, taken.why),
          alt !== null ? h('button', { class: 'btn btn--sm', 'data-key': 'other-desk', onclick: () => this.moveTo(alt) }, `Start at Desk ${alt + 1} instead`) : h('p', {}, 'No other desk is free on this floor.'),
        ),
      );
    }
    keepChildren(this.form, nodes);
    this.notices.replaceChildren(...notices);
    for (const el of this.form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea, button')) {
      // The composers' own chip buttons are theirs (`setBusy` / `setDisabled` below).
      if (el.closest('.cmp')) continue;
      // The ticket and the texts stay typeable while the bridge answers; the rest waits for it.
      const typeable = el.id === 'run-ticket' || el.id === 'run-label';
      // The presets stay reachable unless a start is on its way (on an older bridge the panel says why they are off).
      if (el.dataset.key === 'presets' ? this.state === 'starting' : (busy && !typeable) || this.state === 'starting' || this.state === 'failed') el.disabled = true;
    }
    this.extraC.setBusy(this.state === 'starting' || this.resolving);
    this.promptC.setBusy(this.state === 'starting' || this.resolving);
    this.extraC.setDisabled(this.state === 'failed');
    this.promptC.setDisabled(this.state === 'failed' || previewLocked(this.preview, this.extraDraft.snapshot()));
    this.renderLive();
    if (focusKey === 'extra' || focusKey === 'prompt') (focusKey === 'extra' ? this.extraC : this.promptC).focus();
    else if (focusKey) {
      const back = this.dialog.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`) ?? this.dialog.querySelector<HTMLElement>(`#${CSS.escape(focusKey)}`);
      back?.focus();
      if (caret && (back instanceof HTMLTextAreaElement || back instanceof HTMLInputElement)) {
        back.setSelectionRange(caret[0] ?? null, caret[1] ?? null);
        back.scrollTop = caret[2] ?? 0;
      }
      if (!back && focusKey.includes(':')) this.form.querySelector<HTMLElement>(`[data-pick="${focusKey.split(':')[0]}"] input:checked`)?.focus();
    }
  }

  private ticketField(): HTMLElement {
    const item = this.f.workItem;
    if (item) {
      // M7: the ticket is a card of the board: named, not typed.
      return h(
        'div',
        { class: 'dd-field dd-task dd-workitem' },
        h('span', { class: 'dd-label' }, 'Work item'),
        h('p', { class: 'dd-ticket', id: 'run-ticket-read', 'aria-live': 'polite' }),
        h(
          'p',
          { class: 'field-hint', id: 'run-ticket-hint' },
          `A card of the ${item.provider_name ?? 'issue'} board. `,
          h('button', { class: 'btn btn--sm', 'data-key': 'other-ticket', onclick: () => this.dropWorkItem() }, 'Use another ticket'),
        ),
      );
    }
    const ta = h('textarea', {
      id: 'run-ticket',
      'data-key': 'ticket',
      rows: 2,
      spellcheck: 'false',
      placeholder: this.repo() ? `#7, an issue URL, or what to build` : 'An issue URL, or what to build',
      'aria-describedby': 'run-ticket-read run-ticket-hint',
    });
    ta.value = this.f.ticket;
    ta.addEventListener('input', () => {
      this.f.ticket = ta.value;
      this.ticketError = null;
      this.schedule();
    });
    return h(
      'div',
      { class: 'dd-field dd-task' },
      h('label', { for: 'run-ticket' }, 'Ticket'),
      ta,
      h('p', { class: 'dd-ticket', id: 'run-ticket-read', 'aria-live': 'polite' }),
      h('p', { class: 'field-hint', id: 'run-ticket-hint' }, this.repo() ? `A number is an issue of ${this.repo()}. ` : 'This floor has no linked repo: paste the issue’s URL. ', h('kbd', {}, 'Ctrl'), '+', h('kbd', {}, 'Enter'), ' starts the run.'),
    );
  }

  private promptField(): HTMLElement {
    if (this.promptEl) return this.promptEl;
    const reset = h('button', { class: 'btn btn--sm', 'data-key': 'reset-prompt', onclick: () => this.resetPrompt() }, 'Reset to generated');
    this.promptEl = h(
      'div',
      { class: 'dd-field dd-preview' },
      h('div', { class: 'dd-preview-head' }, h('label', { id: 'run-prompt-label', onclick: () => this.promptC.focus() }, 'First prompt'), h('span', { class: 'tape dd-preview-tape' }), reset),
      h('div', { class: 'dd-slip' }, this.promptC.element),
      h('p', { class: 'field-hint', id: 'run-prompt-note' }),
    );
    return this.promptEl;
  }

  /** What changes while typing, without a re-render: the ticket read-back, the preview, the button. */
  private renderLive(): void {
    const t = this.ticket();
    const read = this.dialog.querySelector<HTMLElement>('#run-ticket-read');
    if (read) {
      const why = t.kind === 'empty' ? null : (this.ticketError ?? t.why);
      read.replaceChildren(
        t.kind === 'empty' ? '' : h('span', { class: `tape tape--ticket tape--${t.kind}` }, t.kind === 'issue' ? `#${t.number}` : t.kind === 'work_item' ? t.item.key : 'Text'),
        ' ',
        ticketLine(t),
      );
      read.dataset.kind = t.kind;
      if (why) read.append(h('span', { class: 'dd-ticket-why', role: 'alert' }, why));
    }
    // A custom prompt is what the user typed: only a generated one follows the bridge.
    if (!this.preview.custom && markedText(this.promptC.getSnapshot()) !== this.preview.text) this.showPreview();
    const label = this.dialog.querySelector<HTMLInputElement>('#run-label');
    if (label && this.prep) label.placeholder = this.prep.label || 'ORCH|…';
    this.renderPreviewState();
    this.renderActions();
  }

  /**
   * Puts the preview text into the First prompt composer. The extra's uploaded images come back as chips there (their
   * markers name the paths the extra's draft holds), so the prompt shows a picture where the orchestrator will read one.
   */
  private showPreview(): void {
    this.syncing = true;
    try {
      this.promptDraft.replaceAll(this.preview.text, this.extraDraft);
    } finally {
      this.syncing = false;
    }
  }

  private renderPreviewState(): void {
    const tape = this.dialog.querySelector<HTMLElement>('.dd-preview-tape');
    const note = this.dialog.querySelector<HTMLElement>('#run-prompt-note');
    const reset = this.dialog.querySelector<HTMLButtonElement>('[data-key="reset-prompt"]');
    const wrap = this.dialog.querySelector<HTMLElement>('.dd-preview');
    if (!tape || !note || !reset || !wrap) return;
    const p = this.preview;
    const locked = previewLocked(p, this.extraDraft.snapshot());
    this.promptC.setDisabled(this.state === 'failed' || locked);
    const waiting = this.timer !== null || this.inFlight;
    const stale = previewStale(p);
    wrap.dataset.state = p.custom ? 'custom' : 'generated';
    tape.textContent = p.custom ? 'Edited' : waiting && this.prep ? 'Updating…' : 'Generated';
    tape.classList.toggle('tape--note', p.custom);
    reset.hidden = !p.custom;
    reset.disabled = this.state === 'starting';
    const paste = `${PASTE_HINT[0]?.toUpperCase()}${PASTE_HINT.slice(1)}.`;
    note.textContent = locked
      ? 'Read-only until the image in Extra instructions has uploaded (retry or remove it there if it failed): an edit now would send its marker without the file.'
      : `${
          p.custom
            ? stale
              ? 'Your edit is kept: the fields above now make a different prompt. Start sends yours as it is.'
              : 'Your edit is kept and sent as it is.'
            : 'Made from the fields above. Edit it to send your own.'
        } ${paste}`;
    note.dataset.stale = stale ? 'true' : 'false';
  }

  private capacityBlock(): HTMLElement {
    const c = this.capacity() as CapacityView;
    const p = this.prep as RunPrepare;
    const facts = `${this.floorName()}: ${p.capacity.floor.count} of ${p.capacity.floor.soft} · host: ${p.capacity.host.count} of ${p.capacity.host.soft}${c.load ? ` · ${c.load}` : ''}`;
    if (c.level === 'ok') return h('p', { class: 'dd-capacity', 'data-level': 'ok' }, facts);
    const tape = c.level === 'full' ? 'At the hard cap' : 'Over the soft cap';
    return h(
      'div',
      { class: 'dd-capacity dd-callout', 'data-level': c.level, role: c.level === 'full' ? 'alert' : null },
      h('p', {}, h('span', { class: `tape tape--cap-${c.level}` }, tape), ' ', c.lines.join(' '), ' A run hires more workers as it goes.'),
      h('p', { class: 'dd-capacity-facts' }, facts),
    );
  }

  private renderActions(): void {
    const blocker = this.blocker();
    const cancel = h('button', { class: 'btn', 'data-key': 'cancel', onclick: () => this.close() }, this.state === 'starting' ? 'Close' : 'Cancel');
    const start = h(
      'button',
      { class: 'btn btn--primary', 'data-key': 'start', 'aria-disabled': blocker ? 'true' : null, 'aria-busy': this.state === 'starting' ? 'true' : null, title: blocker ?? 'Start the run (Ctrl+Enter)', onclick: () => void this.start() },
      this.state === 'starting' ? 'Starting…' : 'Start run',
    );
    const had = document.activeElement === this.startBtn;
    this.startBtn = start;
    const retry = this.state === 'failed' && !runUnsupported(this.host) ? h('button', { class: 'btn', 'data-key': 'retry', onclick: () => this.retry() }, 'Try again') : null;
    // #108: the run's texts reviewed on purpose (with the switch on), then the start.
    const review = reviewButton(this.host.secrets, this.state !== 'ready' || this.resolving ? 'The run is on its way.' : blocker, () => void this.start(true), 'run');
    this.actions.replaceChildren(...[retry, cancel, review, start].filter((x): x is HTMLButtonElement => !!x));
    if (had) start.focus();
  }

  // ---- actions --------------------------------------------------------------------------

  private retry(): void {
    this.state = 'preparing';
    this.setStatus(this.askingText());
    this.render();
    void this.prepare();
  }

  /** M7: back to a typed ticket (the card is not the ticket any more). */
  private dropWorkItem(): void {
    this.f.workItem = null;
    this.f.ticket = '';
    this.ticketError = null;
    this.render();
    this.schedule();
    this.dialog.querySelector<HTMLElement>('#run-ticket')?.focus();
  }

  private moveTo(desk: number): void {
    this.f.desk = desk;
    this.desk = desk;
    this.setStatus('');
    this.render();
  }

  /**
   * #167: the orchestrator's "Codex profile", as a Codex hire's (Auto included; none with one usable profile or on a
   * bridge that takes none): picked here, else the preset orchestrator's while it can be picked, else the default.
   */
  private profileChoice(): RoleProfileChoice | null {
    const o = this.f.orch;
    if (!o) return null;
    return roleProfileChoice(this.host.store.codexProfiles?.state ?? null, o.harness, this.preset()?.roles.orch.codex_profile, this.orchProfile);
  }

  /** #167: the preset orchestrator's gone profile with no picker to say so. */
  private loneGone(): string | null {
    const o = this.f.orch;
    return o ? roleLoneGone(this.host.store.codexProfiles?.state ?? null, o.harness, this.preset()?.roles.orch.codex_profile) : null;
  }

  private profileNodes(): HTMLElement[] {
    const c = this.profileChoice();
    if (!c) {
      const lone = this.loneGone();
      return lone ? [profileGoneNote(lone)] : [];
    }
    const note = roleGoneText(this.host.store.codexProfiles?.state ?? null, c);
    return [
      profileChips('orch-profile', c.list, c.key, (key) => {
        this.orchProfile = key;
        this.orchTouched = true;
        this.render();
      }, note, c.auto),
    ];
  }

  private pickPreset(id: string): void {
    this.f.preset = id;
    const p = this.host.store.presets.get(id);
    if (!this.orchTouched) this.orchProfile = null; // #167: the new preset's
    if (p && !this.orchTouched) this.f.orch = resolveVisibleChoice(this.options(p), p.roles.orch);
    this.render();
    this.schedule();
  }

  private pickOrch(p: Partial<Hire>): void {
    const o = this.f.orch;
    this.f.orch = resolveVisibleChoice(this.options(), { ...o, ...p });
    this.orchTouched = true;
    this.render();
    this.schedule();
  }

  private resetPrompt(): void {
    this.preview = previewReset(this.preview);
    this.showPreview();
    this.promptC.focus();
    this.renderPreviewState();
    this.renderActions();
  }

  /**
   * Start run. #108 round 4: with the switch on (or `manual`: "Review secrets"), the texts `run.start` carries are each
   * reviewed before anything of them goes (the ticket's text; the extra instructions, beside no edited prompt; the edited
   * prompt), and go as a review per text keyed by its path; Cancel starts nothing.
   */
  private async start(manual = false): Promise<void> {
    if (this.state !== 'ready' || !this.prep || this.resolving) return;
    const blocker = this.blocker();
    if (blocker) {
      this.setStatus(blocker, true);
      this.renderActions();
      // A refusal is held by a field that may be scrolled out of sight: show it.
      (this.extraDraft.refusal !== null ? this.extraC : this.promptDraft.refusal !== null ? this.promptC : null)?.revealRefusal();
      return;
    }
    this.clearTimer();
    const floor = this.floor;
    const desk = this.f.desk;
    const t = this.ticket();
    // #64: the images first. Uploads still on their way are waited for (the fields are read-only meanwhile); one that
    // failed, or a text too long with the paths in it, stops the start with the fields as they are.
    const opened = this.opened;
    const custom = this.preview.custom;
    this.resolving = true;
    this.extraC.setBusy(true);
    this.promptC.setBusy(true);
    if (this.extraDraft.snapshot().uploading || (custom && this.promptDraft.snapshot().uploading)) this.setStatus('Uploading the images, then starting the run…');
    this.renderActions();
    const [extra, prompt] = await Promise.all([this.extraDraft.resolve({ maxBytes: EXTRA_MAX }), custom ? this.promptDraft.resolve({ maxBytes: HIRE_PROMPT_MAX_BYTES }) : Promise.resolve(null)]);
    if (opened !== this.opened) return; // another run's dialog: its own fields
    this.resolving = false;
    this.extraC.setBusy(false);
    this.promptC.setBusy(false);
    const bad = !extra.ok ? { field: 'Extra instructions', r: extra } : prompt && !prompt.ok ? { field: 'First prompt', r: prompt } : null;
    if (bad || !extra.ok || (prompt && !prompt.ok)) {
      const msg = bad && bad.r.reason !== 'disposed' ? `${bad.field}: ${notSentText(bad.r, { nothing: 'started', again: 'start' })}` : '';
      if (msg && this.dialog.open) this.setStatus(msg, true);
      this.renderActions();
      return;
    }
    if (!this.dialog.open) return;
    // What the bridge is sent: the extra with its final markers, and (edited prompts only) the prompt as resolved.
    const form: RunForm = { ...this.f, extra: extra.text };
    const preview: Preview = prompt ? { ...this.preview, text: prompt.text } : this.preview;
    const args: CommandArgs['run.start'] = startArgs(floor, form, t, preview, this.prep, worktreeUsable(this.prep.git));
    args.orch = withProfile(args.orch, this.profileChoice()?.key); // #167: only to a bridge that takes it, with a choice to make
    const who = args.label ?? this.prep.label;
    // #108: the texts the bridge reads (`extra` is in the composed prompt only, so not beside an edited one).
    const flow = this.host.secrets;
    const fields: FieldText[] = [
      ...(args.text ? [{ path: 'text', text: args.text, label: 'the ticket' }] : []),
      ...(args.extra && args.prompt === undefined ? [{ path: 'extra', text: args.extra, label: 'the extra instructions' }] : []),
      ...(args.prompt ? [{ path: 'prompt', text: args.prompt, label: 'the edited first prompt' }] : []),
    ];
    // (Closed meanwhile, or opened again: nothing of it goes, no review opens.)
    const freq = { key: `run:${floor}:${desk}`, target: `${who} at Desk ${desk + 1}`, manual, fields, live: () => opened === this.opened && this.dialog.open };
    let go: GoFields | null = null;
    if (manual && !fields.length) {
      this.setStatus('Nothing typed to review: the issue or the card is read on the bridge.', true);
      return;
    }
    if (flow && (flow.on || manual) && fields.length) {
      this.setStatus(manual ? 'Opening the review of its secrets…' : 'Looking for secrets in the run’s texts…');
      // Busy meanwhile: a second Start is not another review.
      this.resolving = true;
      const out = await flow.reviewFields(freq);
      if (opened !== this.opened || !this.dialog.open) return;
      this.resolving = false;
      if (out.kind === 'kept') {
        this.setStatus(out.why === 'cancel' ? 'Not started: the review was cancelled. Everything is still here.' : out.message, out.why === 'failed');
        this.renderActions();
        return;
      }
      this.setStatus('');
      go = out;
    }
    this.state = 'starting';
    const release = this.host.reserve(floor, desk);
    const steps = [args.worktree ? 'creating the worktree' : null, `starting ${args.orch.harness}`, 'handing over the prompt'].filter(Boolean);
    this.startingText = `Starting ${who}: ${steps.join(', ')}…`;
    this.startingStatus();
    this.render();
    const gen = this.gen;
    const send = (g: GoFields | null) => {
      this.sending = opened;
      return this.host.send('run.start', g?.secrets ? { ...args, secrets: g.secrets } : args).finally(() => {
        if (this.sending === opened) this.sending = -1;
      });
    };
    const d = flow && go ? await flow.deliverFields(freq, go, send) : ({ kind: 'answered', result: await send(null) } as const);
    release();
    // Closed while a refusal was reviewed again: nothing started, nothing to say.
    if (d.kind === 'kept' && d.why === 'gone') return;
    // Kept by the flow (a review again cancelled, the switch changed): nothing started, its words say why.
    const r = d.kind === 'kept' ? ({ ok: false, code: 'secrets_kept', message: d.message } as const) : d.result;
    const still = this.dialog.open && gen === this.gen;
    if (still) this.state = 'ready';
    if (r.ok) {
      const ack = r.data as RunStartAck | undefined;
      const w = ack?.id ? this.host.store.workerView(ack.id) : null;
      const name = w?.name ?? who;
      const on = t.kind === 'issue' ? ` on #${t.number}` : t.kind === 'work_item' ? ` on ${t.item.key}` : '';
      const notSent = ack?.prompted === false ? `The prompt was not sent (${ack.prompt_error ?? 'no reason given'}): prompt them yourself (P).` : '';
      if (still) this.close();
      // Sent: the fields' drafts (and their uploads) are done with.
      if (opened === this.opened) {
        this.extraDraft.dispose();
        this.promptDraft.dispose();
      }
      // #186: as a hire's (hiredToast): a run on Codex's built-in server is a warning, a prompt not sent an error.
      const toast = hiredToast(`Started a run${on}: ${name} takes Desk ${(w?.desk ?? desk) + 1}. Here they come.`, ack, notSent);
      // #167: what the team's Codex roles run on: Auto's picks, then their homes that run no herdr hook (a warning).
      if (ack?.codex_team_reason) toast.text += ` Team: ${ack.codex_team_reason}.`;
      if (ack?.codex_team_note) {
        toast.text += ` ${ack.codex_team_note}`;
        if (toast.kind === 'info') toast.kind = 'warn';
      }
      this.host.toast(toast.text, toast.kind);
      if (ack?.id) this.host.started(ack.id, t.kind === 'work_item' ? { provider: t.item.provider, id: t.item.id } : undefined);
      return;
    }
    const msg = r.code === 'not_found' ? 'That team preset was deleted meanwhile: pick another one.' : failureText('run.start', r.code, r.message, { floor: this.host.store.floorName(floor), desk: desk + 1 }).replace('hire without a worktree', 'start without one');
    if (!still) {
      this.host.toast(msg, 'error');
      return;
    }
    this.setStatus(msg, true);
    this.render();
    // The caps and origin as they are now (#134: fetched, as the dialog may have opened on a preview).
    if (r.code === 'capacity' || r.code === 'fetch_failed') void this.prepare(true);
  }

  // ---- test hook ------------------------------------------------------------------------

  summary(): StartRunSummary | null {
    if (!this.dialog.open) return null;
    const t = this.ticket();
    return {
      kind: 'start-run',
      floor: this.floor,
      desk: this.f.desk,
      title: this.title(),
      state: this.state,
      form: structuredClone(this.f),
      ticket: t,
      ticketLine: ticketLine(t),
      ticketError: this.ticketError,
      preview: { ...this.preview, stale: previewStale(this.preview) },
      preparing: this.timer !== null || this.inFlight,
      label: this.f.label.trim() || this.prep?.label || '',
      profile: this.profileChoice()?.key ?? null,
      git: this.prep ? this.gitView(this.prep.git) : null,
      capacity: this.capacity(),
      blocker: this.blocker(),
      status: this.statusText,
      error: this.statusError,
    };
  }
}

/**
 * Makes `parent`'s children exactly `nodes`, in order, without detaching a node that is already there (a
 * `replaceChildren` would, and a composer loses its caret, selection and focus when it is detached).
 */
function keepChildren(parent: HTMLElement, nodes: readonly Node[]): void {
  const keep = new Set<Node>(nodes);
  for (const c of [...parent.childNodes]) if (!keep.has(c)) c.remove();
  let ref: ChildNode | null = parent.firstChild;
  for (const n of nodes) {
    if (n === ref) ref = ref.nextSibling;
    else parent.insertBefore(n, ref);
  }
}

function blankForm(): RunForm {
  return { ticket: '', desk: 0, preset: '', orch: null, extra: '', worktree: true, label: '', workItem: null };
}
