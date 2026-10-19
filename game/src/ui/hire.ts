import type { CommandResult } from '../net/client';
import type { CommandArgs, CommandName, HireAck, HireGit, HireOptions, HirePresetCheckAck, HirePrepare } from '../net/protocol';
import {
  baseText,
  capacityView,
  choiceNote,
  fetchNote,
  firstFreeDesk,
  formFromPrepare,
  hireArgs,
  HARNESS_LABEL,
  hireBlocker,
  modelsFor,
  offeredOptions,
  resolveChoice,
  resolveVisibleChoice,
  visibleOptions,
  worktreeUsable,
  type CapacityView,
  type HireForm,
} from '../world/hire';
import { labelsOf, modelEntries, modelMatches, type ModelEntry, type ModelLabels } from '../world/modelLabel';
import { effortsFor } from '../world/settings';
import { isComplete, levelChipText, levelProblem, preselectLevel, type TaskLevelId } from '../world/taskLevels';
import { exactProblem, instructionsBlocker, nudgeWanted, pickExact, presetChoiceText, type ExactProblem } from '../world/hirePresets';
import type { WorldStore } from '../world/store';
import { h, icon, ICON } from './dom';
import { failureText } from './messages';
import { hiredToast } from './hiredToast';
import { HireCoordinator, notPromptedText, notSentText, type HireCoordinatorHost, type HireOutcome } from './hireCoordinator';
import type { HireModelPrefs } from './hireModelPrefs';
import type { HirePrefs } from './hirePrefs';
import type { TaskLevels } from './taskLevels';
import type { ToastAction, ToastKind } from './hud';
// M10 limits
import { planLimits } from './limits';
// M6 start
import { deskTabs } from './deskTabs';
// #51 drafts
import { Drafts } from './drafts';
import { backdropPolicy } from './dismiss';
// #51 composer
import { mountComposer, type Composer } from './composer/composer';
import { Draft as PromptDraft, type DraftSnapshot, type ResolveResult, type Uploader } from './composer/draft';
import { HIRE_PROMPT_MAX_BYTES, mentionOf } from './composer/model';
// #39 completion
import type { Source } from './composer/complete';
import { CommandCatalogs } from '../laptop/commandCatalog';
import { CompletionScope, hireLookupKey, hireSources, type HireLookup } from './dialogCompletion';
import { classifierView, onReviewKey, reviewButton, type Go, type PromptSecretsFlow } from './secretsFlow';

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
  /** #33 `action`: the toast is a control (a held review's "Review again"). */
  toast(msg: string, kind: ToastKind, action?: ToastAction): void;
  now(): number;
  /** #108: the send flow every composer's text goes through with "Review prompt secrets before sending" on (absent: as today). */
  secrets?: PromptSecretsFlow;
}

export interface HireHost extends DialogHost {
  /** A hire is on its way to `desk` (its "+" goes); the returned function ends this hire's hold only. */
  reserve(floor: string, desk: number): () => void;
  /** Desks of a floor a hire (or a walk) is already on its way to: not free for this one. */
  held(floor: string): ReadonlySet<number>;
  /** #51: one image to Drop Zone through the bridge (`net/upload.ts`), for the first task's composer. */
  upload: Uploader;
  /** M6 start: the "Hire orchestrator" tab (ui/startRun.ts): why it is off, and opening it for the same desk. */
  orchestrate?: { off(): string | null; open(floor: string, desk: number): void };
  /** #116: a hire was acknowledged while this dialog was still the one that sent it: take the player to the new worker (the host decides whether, and when it is ready). */
  goTo?(id: string): void;
  /** Settings → Harness models: which models this dialog offers (all of them without it). */
  modelPrefs?: HireModelPrefs;
  /** The empty state's way to Settings → Harness models. */
  showModelSettings?(): void;
  /** #248: Settings → Task levels, for a hire that asks for a level (none: no level is set). */
  taskLevels?: TaskLevels;
  /** #248: the way to Settings → Task levels when no level can be used. */
  showTaskLevelSettings?(): void;
  /** Settings → Display: background hiring and the initial worktree choice (absent: foreground, worktree on). */
  hirePrefs?: Partial<Pick<HirePrefs, 'hireInBackground' | 'worktreeByDefault'>>;
  /** #210: the game's hire coordinator (shared with other ways to hire); absent: the dialog makes its own from this host. */
  hires?: HireCoordinator;
  /** #210: the beep of a hire made in the background (absent: silent). */
  beep?(): void;
  /** #210: a background hire's undelivered first task into the new worker's Prompt (P) note (`HireCoordinatorHost.holdTask`). */
  holdTask?: HireCoordinatorHost['holdTask'];
  /** #39: the app's lists of commands and skills (shared with the transcript); absent: the dialog keeps its own. */
  catalogs?: CommandCatalogs;
  /** #93: the "Hire preset" tab: the floor's and the global hire presets for this desk (absent: no such tab). */
  presetsAt?(floor: string, desk: number): void;
  /** #93: "Save as preset…": the preset editor over this dialog, with the form's prompt and choice (absent: no such button). */
  savePreset?(seed: HirePresetSeed, from: HTMLElement): void;
}

/** #93: what "Save as preset…" hands the preset editor: the form's text (images are never saved), choice and floor. */
export interface HirePresetSeed {
  floor: string;
  prompt: string;
  harness: string;
  model: string;
  effort: string;
  /** Images of the first task left out (a preset keeps text only). */
  imagesLeftOut: number;
  /** #95: the form's "Add herdr hiring instructions" (#117: every form has one, on a bridge that adds them; absent: off). */
  instructions?: boolean;
}

/** M7: what "Ask a worker…" and "Review with a worker" start the dialog with. */
export interface HirePrefill {
  prompt?: string;
  choice?: { harness: string; model: string; effort: string };
  /**
   * #248, #40: open in task-level mode with this level picked (or the nearest usable one by list position): the levels
   * instead of the harness, model and effort fields. `'default'` asks for the player's default level (the one marked so in
   * Settings → Task levels, else the first); an id no longer in the list does too. `choice` never applies then.
   */
  level?: 'default' | TaskLevelId;
  /** #248: a worktree whenever one can be made, whatever Settings → Display says. */
  worktree?: true;
  /**
   * #93: the form comes from this hire preset: `choice` is its exact harness / model / effort, never resolved to another
   * one (a hidden model stays offered; a removed one or an effort it does not take is shown and blocks Hire until the
   * player picks). `prompt` is its prompt.
   */
  preset?: { id: string; name: string; scope: 'floor' | 'global'; instructions?: boolean };
  /** #93: the player chose to replace the desk's unsent first task with `prompt`: the new text is the desk's draft at once. */
  replaceDraft?: true;
}

/**
 * #248: how a hire that asks for a level shows the choice: the level chips (`levels`), the usual pickers the player
 * switched to (`more`), or the usual pickers because no level can be used (`none`).
 */
export type LevelMode = 'levels' | 'more' | 'none';

/** One level as the dialog shows it (test hook). */
export interface LevelChip {
  id: TaskLevelId;
  text: string;
  /** Why it cannot be picked, null when it can. */
  problem: string | null;
}

export type HireState = 'preparing' | 'ready' | 'hiring' | 'failed';

/** #117: the question a plain hire asks, with the box off, when the classifier says the first task starts other agents. */
export const HIRE_ASK_TEXT = 'This task starts other agents (workers or subagents). Add herdr hiring instructions so they get their own workspace on this floor?';

/** What the hire dialog shows (test hook). */
export interface HireSummary {
  kind: 'hire';
  floor: string;
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
  /** The first task's images in document order (`n` is the marker's number). */
  images: Array<{ n: number; name: string; status: string; path: string | null }>;
  /** #248: a hire that asks for a task level: the mode, the picked level and the set levels; absent for a plain hire. */
  level?: { mode: LevelMode; picked: TaskLevelId | null; chips: LevelChip[] };
  /** #93: the form came from a hire preset: which, its saved choice, and what of that choice cannot be hired now (null: all of it can). */
  preset?: { id: string; name: string; saved: { harness: string; model: string; effort: string }; problem: ExactProblem | null };
  /**
   * #95: the form's "Add herdr hiring instructions" (#117: any form, on a bridge that adds them): ticked or not for
   * this hire, the exact lines hire.prepare gave for this floor, and the first prompt's bytes with them while ticked.
   */
  instructions?: { on: boolean; lines: string; bytes: number };
  /** #117: the question the hire waits on (the classifier said the task starts other agents, the box was off); absent when none is open. */
  asking?: true;
}

/** The worktree option as shown (null: hidden, the folder is no git repo). */
export function gitView(g: HireGit | null, now: number): HireSummary['git'] {
  if (!g) return null;
  const n = fetchNote(g);
  return { base: baseText(g, now), usable: worktreeUsable(g), note: n?.text ?? null, noteError: n?.error ?? false };
}

const DESK_PLUS = '<path d="M12 5v14M5 12h14"/>';

/**
 * One model's chip text (#200): its readable name, the exact id as the tooltip, and the id in small type beside the
 * name only when another model of the list has the same name. The radio's value stays the exact id.
 */
function modelChip(input: HTMLInputElement, e: ModelEntry): HTMLLabelElement {
  return h('label', { class: 'dd-chip', title: e.named ? e.id : null }, input, h('span', {}, e.label, e.collides ? h('small', { class: 'dd-chip-id' }, e.id) : null));
}

/**
 * A group of radio chips: label-maker tape for the chosen one, blank tape for the rest. `entries` (the model chips)
 * name each value; without them a chip shows its value.
 */
export function chips(
  name: string,
  legend: string,
  values: string[],
  value: string,
  onPick: (v: string) => void,
  note: HTMLElement | null = null,
  entries: readonly ModelEntry[] | null = null,
): HTMLFieldSetElement {
  const row = h('div', { class: 'dd-chips' });
  for (const [i, v] of values.entries()) {
    const input = h('input', { type: 'radio', name, value: v, class: 'visually-hidden', 'data-key': `${name}:${v}` });
    input.checked = v === value;
    input.addEventListener('change', () => input.checked && onPick(v));
    const e = entries?.[i];
    row.append(e ? modelChip(input, e) : h('label', { class: 'dd-chip' }, input, h('span', {}, v)));
  }
  return h('fieldset', { class: 'dd-pick', 'data-pick': name }, h('legend', {}, legend, note), row);
}

/** The caps of a floor and the host, and what one more hire does to them: a line, or a callout past a cap. */
export function capacityBlock(c: CapacityView, p: HirePrepare, floor: string): HTMLElement {
  // (`floor`: the floor's name.)
  const facts = `${floor}: ${p.capacity.floor.count} of ${p.capacity.floor.soft} · host: ${p.capacity.host.count} of ${p.capacity.host.soft}${c.load ? ` · ${c.load}` : ''}`;
  if (c.level === 'ok') return h('p', { class: 'dd-capacity', 'data-level': 'ok' }, facts);
  const tape = c.level === 'full' ? 'At the hard cap' : 'Over the soft cap';
  return h(
    'div',
    { class: 'dd-capacity dd-callout', 'data-level': c.level, role: c.level === 'full' ? 'alert' : null },
    h('p', {}, h('span', { class: `tape tape--cap-${c.level}` }, tape), ' ', c.lines.join(' ')),
    h('p', { class: 'dd-capacity-facts' }, facts),
  );
}

/**
 * The worktree option: a checkbox (off, and disabled, after a failed fetch) and the base it would branch from.
 * `id` names the checkbox, so the dialogs that show it keep their own hooks.
 */
export function worktreeControl(g: NonNullable<HireSummary['git']>, on: boolean, onChange: (v: boolean) => void, id = 'hire-worktree'): HTMLElement {
  const box = h('input', { type: 'checkbox', id, 'data-key': 'worktree', 'aria-describedby': g.usable ? `${id}-base` : `${id}-base hire-fetch` });
  box.checked = on;
  // No worktree from a stale origin: off until a fetch goes through.
  box.disabled = !g.usable;
  box.addEventListener('change', () => onChange(box.checked));
  return h(
    'div',
    { class: 'dd-worktree', 'data-on': on ? 'true' : 'false', 'data-off': g.usable ? null : 'true' },
    h('label', { class: 'dd-check', for: id }, box, h('span', { class: 'dd-check-box', 'aria-hidden': 'true' }), h('span', {}, 'Work in its own git worktree & branch')),
    h(
      'p',
      { class: 'dd-base', id: `${id}-base` },
      !g.usable ? 'Off: origin could not be fetched. Last fetched ' : on ? 'A new h3d/… branch from ' : 'Would branch from ',
      h('code', {}, g.base),
    ),
  );
}

/** More models than this get a filter box and a multi-column list instead of one row of chips. */
const MODEL_LIST_AT = 10;

/**
 * The model chooser of a harness with many models: a filter above the same radio chips, laid out in a grid that
 * uses the width (the options pane scrolls as a whole, so there is no small scroll box of its own). Filtering only
 * hides chips, so it never re-renders (focus and the checked model stay); the checked one always stays visible, so
 * a filter never looks like a changed choice. Enter in the filter must not hire; Esc clears it before it closes anything.
 */
export function modelList(
  values: string[],
  value: string,
  query: string,
  onPick: (v: string) => void,
  onQuery: (q: string) => void,
  harness = '',
  labels?: ModelLabels,
  name = 'model',
): HTMLFieldSetElement {
  const count = h('span', { class: 'dd-count', 'aria-live': 'polite' });
  const none = h('p', { class: 'field-hint dd-none' });
  const row = h('div', { class: 'dd-chips dd-chips--grid' });
  const chipsByValue: Array<[ModelEntry, HTMLLabelElement, HTMLInputElement]> = [];
  for (const e of modelEntries(harness, values, labels)) {
    const v = e.id;
    const input = h('input', { type: 'radio', name, value: v, class: 'visually-hidden', 'data-key': `${name}:${v}` });
    input.checked = v === value;
    input.addEventListener('change', () => input.checked && onPick(v));
    const label = modelChip(input, e);
    chipsByValue.push([e, label, input]);
    row.append(label);
  }
  const apply = (raw: string) => {
    const q = raw.trim();
    let shown = 0;
    for (const [e, label, input] of chipsByValue) {
      const hit = modelMatches(q, e);
      if (hit) shown++;
      label.hidden = !hit && !input.checked;
    }
    count.textContent = q ? `${shown} of ${values.length}` : `${values.length}`;
    none.textContent = q && !shown ? `No model matches “${raw.trim()}”.` : '';
    none.hidden = !none.textContent;
  };
  const search = h('input', { type: 'text', class: 'dd-search', 'data-key': `${name}-search`, autocomplete: 'off', spellcheck: 'false', 'aria-label': `Filter ${values.length} models`, placeholder: `Filter ${values.length} models` });
  search.value = query;
  search.addEventListener('input', () => {
    onQuery(search.value);
    apply(search.value);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
    else if (e.key === 'Escape' && search.value) {
      e.preventDefault();
      e.stopPropagation();
      search.value = '';
      onQuery('');
      apply('');
    }
  });
  apply(query);
  return h('fieldset', { class: 'dd-pick dd-pick--models', 'data-pick': name }, h('legend', {}, 'Model ', count), h('div', { class: 'dd-models' }, search, row, none));
}

/** Up to a row of chips; a long list gets a filter and a grid (`modelList`). `name` keeps several on one page apart. */
export function modelField(harness: string, models: string[], value: string, labels: ModelLabels, query: string, onPick: (v: string) => void, onQuery: (q: string) => void, name = 'model'): HTMLElement {
  if (models.length <= MODEL_LIST_AT) return chips(name, 'Model', models, value, onPick, null, modelEntries(harness, models, labels));
  return modelList(models, value, query, onPick, onQuery, harness, labels, name);
}

/** #93: the prompt as a preset keeps it: the text and file mentions; images are left out (a preset holds no uploads). */
function presetText(s: DraftSnapshot): string {
  return s.segments
    .map((g) => (g.kind === 'text' ? g.text : g.kind === 'image' ? '' : mentionOf(g.path)))
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** The prompt as the form sees it: the text, each image a bare `[Image #n]` (the paths only exist once uploaded, at send time). */
function promptText(s: DraftSnapshot): string {
  let n = 0;
  return s.segments.map((g) => (g.kind === 'text' ? g.text : g.kind === 'image' ? `[Image #${++n}]` : mentionOf(g.path))).join('');
}

/**
 * The first-task editor: the shared composer (#13) in its own pane that a re-render of the options never touches, so
 * its caret, selection and scroll survive a model or limits update. The dialog shows it a `PromptDraft` per desk (text,
 * images, uploads), focuses it and marks it busy; Enter asks the dialog to hire, Shift+Enter adds a line.
 */
class TaskEditor {
  readonly el: HTMLElement;
  private readonly composer: Composer;

  constructor(handlers: { change(s: DraftSnapshot): void; send(): void; upload: Uploader; sources: readonly Source[]; bounds: () => Element | null }) {
    this.composer = mountComposer({
      draft: new PromptDraft({ upload: handlers.upload, maxPromptBytes: HIRE_PROMPT_MAX_BYTES }),
      // #39: `/` skills, `@` files and `@r:` repositories of the hire's context (`dialogCompletion.ts`).
      // The popup stays inside the dialog's body (it scrolls, and would clip it), above the caret when below has no room.
      complete: { sources: handlers.sources, bounds: handlers.bounds },
      labelledBy: 'hire-task-label',
      describedBy: 'hire-task-hint',
      placeholder: 'What should they start on?',
      submitPolicy: 'enter',
      onSubmit: handlers.send,
      onChange: handlers.change,
    });
    // The editor takes the textarea's hooks: the label, the tests and the focus keys all know `#hire-task`.
    this.composer.editor.id = 'hire-task';
    this.composer.editor.dataset.key = 'task';
    this.el = h(
      'div',
      { class: 'dd-field dd-task' },
      h('label', { id: 'hire-task-label', onclick: () => this.focus() }, 'First task ', h('span', { class: 'dd-optional' }, 'optional')),
      this.composer.element,
      h('p', { class: 'field-hint', id: 'hire-task-hint' }, h('kbd', {}, 'Enter'), ' hires · ', h('kbd', {}, 'Shift'), '+', h('kbd', {}, 'Enter'), ' adds a line · paste a screenshot to add it'),
    );
  }

  get draft(): PromptDraft {
    return this.composer.getDraft();
  }

  /** Shows a desk's draft (its uploads go on wherever they are). */
  show(d: PromptDraft): void {
    if (this.composer.getDraft() !== d) this.composer.setDraft(d);
  }

  get text(): string {
    return promptText(this.composer.getSnapshot());
  }

  resolve(): Promise<ResolveResult> {
    return this.composer.resolve({ maxBytes: HIRE_PROMPT_MAX_BYTES });
  }

  set busy(b: boolean) {
    this.composer.setBusy(b);
  }

  get previewOpen(): boolean {
    return this.composer.previewOpen;
  }

  focus(): void {
    this.composer.focus();
  }

  closePreview(): void {
    this.composer.closePreview();
  }

  /** The dialog's DOM is going: a preview holds a window listener. */
  dispose(): void {
    this.composer.dispose();
  }
}

export class HireDialog {
  private readonly dialog = h('dialog', { class: 'desk-dlg desk-dlg--hire', 'aria-labelledby': 'hire-title', 'aria-describedby': 'hire-sub' });
  private readonly head = h('header', { class: 'dd-head' });
  /** M6 start: Hire worker | Hire orchestrator. */
  private readonly tabs = h('div', { class: 'dd-tabs-slot' });
  private readonly form = h('form', { class: 'dd-body', id: 'hire-form', novalidate: true });
  /**
   * #39: what the first task's completion looks up: the floor, the harness and the folder `worker.hire` would get now
   * (a worktree hire's repository root), once `hire.prepare` answered. Never asked before `/` or `@` opens a popup.
   */
  private lookup: HireLookup | null = null;
  private ownCatalogs: CommandCatalogs | null = null;
  private readonly lookups = new CompletionScope(
    () => this.lookupKey(),
    () => hireSources(this.lookupHost(), this.lookup as HireLookup),
  );
  /** The first task: its own pane, never re-rendered; harness, model, effort, folder and label sit in the options pane beside (or below) it. */
  private readonly editor = new TaskEditor({
    upload: (file, hint, signal) => this.host.upload(file, hint, signal),
    change: (s) => this.taskChanged(s),
    send: () => void this.hire(),
    sources: this.lookups.sources,
    bounds: () => this.form,
  });
  private readonly editorPane = h('div', { class: 'hire-editor-pane' }, this.editor.el);
  private readonly optionsPane = h('div', { class: 'hire-options-pane' });
  private readonly statusEl = h('p', { class: 'dd-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private readonly actions = h('div', { class: 'dd-actions' });
  /** What must be seen before pressing Hire (a failed fetch, the caps, a taken desk): by the buttons, never scrolled away. */
  private readonly notices = h('div', { class: 'dd-notices' });
  /** #117: the question a plain hire asks before it hires (below the notices, by the buttons). */
  private readonly askEl = h('div', { class: 'dd-asking' });
  private readonly foot = h('footer', { class: 'dd-foot' }, this.notices, this.askEl, this.statusEl, this.alertEl, this.actions);
  private floor = '';
  private desk = 0;
  private prefill: HirePrefill = {};
  private state: HireState = 'preparing';
  /** What `worker.hire` is doing, once it is sent (null: not yet): the status line under "Waking floor…" (#58). */
  private hiringText: string | null = null;
  private prep: HirePrepare | null = null;
  private f: HireForm = { prompt: '', harness: '', model: '', effort: '', label: '', cwd: '', worktree: false };
  /** The choice as prepared: the note ("Floor default") shows while the form still has it. */
  private prepared: { harness: string; model: string; effort: string } | null = null;
  private statusText = '';
  private statusError = false;
  /** Bumped on every open / prepare, so a late answer for an older one is dropped. */
  private gen = 0;
  /** Opening a newer form prevents a late background failure from restoring the old one. */
  private opening = 0;
  private hireBtn: HTMLButtonElement | null = null;
  private renderedKey = '';
  private refetching = false;
  /**
   * #51: what was typed and not hired yet, per desk of a floor (memory, and localStorage where allowed): the text and
   * label. #108 round 4: memory only while "Review prompt secrets before sending" is on (it may hold a secret).
   */
  private readonly drafts = new Drafts('hire', undefined, () => !this.host.secrets?.on);
  /**
   * The first task's composer draft per desk (text, images, their uploads): kept in memory while the page lives; images do not survive a reload.
   * The entry is also the owner of the desk's stored draft: whoever saves it (a task or label edit, the desk's own draft on open, a move) is registered here.
   */
  private readonly docs = new Map<string, PromptDraft>();
  /** The last hire attempt stopped on a failed upload: the message stays until every image is uploaded or gone. */
  private uploadFailed = false;
  /** #108: the opening (`gen`) whose Hire resolves and reviews its first task now: nobody is hired yet, so closing hires nobody. */
  private reviewing = -1;
  /** #117: `reviewing` is the classifier's check (not the secrets review): what the toast says on Esc. */
  private classifying = false;
  /** The label the user typed (the prepared name is only a default), restored over the prepared one. */
  private typedLabel: string | null = null;
  /** The model filter of a long list; a harness switch clears it. */
  private modelQuery = '';
  /** #248: a hire that asks for a level: how the choice is shown (null: a plain hire), and the level picked. Never saved. */
  private levelMode: LevelMode | null = null;
  private level: TaskLevelId | null = null;
  /** #93: the hire preset this form came from and its exact choice (null: none): no resolver ever replaces that choice. */
  private exact: { id: string; name: string; scope: 'floor' | 'global'; instructions?: boolean; saved: { harness: string; model: string; effort: string } } | null = null;
  /** #95: this hire adds the herdr hiring instructions: ticked to match the preset, unticked for this hire only. */
  private addLines = false;
  /** #95: the first prompt's byte count with the lines, kept current while typing (null: not shown). */
  private bytesEl: HTMLElement | null = null;
  /** #95: "What's added" stays open across a re-render of the options. */
  private linesOpen = false;
  /**
   * #117: the question open in the dialog (the classifier said the first task starts other agents, the box was off): what
   * the hire needs to go on with either answer, and the form it was asked about (`key`: a change to it drops the question).
   */
  private asking: { gen: number; key: string; go: (withLines: boolean) => void } | null = null;
  /** #117: per desk draft, the first task "Hire without" was answered for: not asked again for exactly that text. */
  private readonly declined = new Map<string, string>();
  /** #210: holds the desk, uploads, sends `worker.hire`: the same for a hire waited for here and one in the background. */
  private readonly hires: HireCoordinator;
  /** This dialog among others (a hire's key is the dialog and its generation). */
  private static serial = 0;
  private readonly id = ++HireDialog.serial;

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
    // #108: the switch changed: the drafts leave storage (on), or are written again (off).
    host.secrets?.onChange(() => this.drafts.persistChanged());
    // Settings changed which models show: an open form follows it (a hire on its way keeps what it sent).
    this.host.modelPrefs?.onChange(() => this.visibilityChanged());
    // #248: so does a change of the task levels, for a hire that asks for one (a plain hire never looks at them).
    this.host.taskLevels?.onChange(() => {
      if (this.levelMode) this.visibilityChanged();
    });
    this.alertEl.hidden = true;
    this.statusEl.hidden = true;
    this.form.append(this.editorPane, this.optionsPane);
    this.dialog.append(this.head, this.tabs, this.form, this.foot);
    // A late answer (a prepare, or a hire sent before Esc) is for a dialog that is gone: it never touches the next one.
    this.dialog.addEventListener('close', () => {
      if (!this.dialog.open) this.gen++;
      this.asking = null;
      this.askEl.replaceChildren();
      // An enlarged image is nested in this dialog: it goes with it (it holds a window key listener).
      this.editor.closePreview();
    });
    this.dialog.addEventListener('cancel', (e) => {
      // #117: Esc on the question goes back to the form, keeping the task; nobody is hired.
      if (this.asking) {
        e.preventDefault();
        this.asking = null;
        this.renderActions();
        this.setStatus('Not hired: the first task is still here.');
        this.editor.focus();
        return;
      }
      // Esc while the hire is on its way: the hire still happens; the dialog just goes. (#108: not before its first task
      // was reviewed: then nobody is hired.)
      if (this.state === 'hiring') {
        const unsent = this.reviewing === this.gen;
        const why = this.classifying ? 'checked' : 'checked for secrets';
        this.host.toast(unsent ? `Not hired: it was closed before its first task was ${why}.` : 'The hire is still on its way; the worker shows up at the desk when it is done.', 'info');
      }
    });
    // #51: typed text or a consequential choice in here: only the close button and Esc close it, never the backdrop.
    backdropPolicy(this.dialog, 'none');
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
    // #108: the first task's review on purpose (Ctrl/⌘+Shift+X, with the switch on), as its "Review secrets".
    onReviewKey(this.form, () => this.host.secrets, () => void this.hire(true));
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
  open(floor: string, desk: number, prefill: HirePrefill = {}): void {
    this.opening++;
    this.floor = floor;
    this.desk = desk;
    this.prep = null;
    this.prepared = null;
    this.prefill = prefill;
    // #51: the desk's draft comes back; a first task handed in ("Ask a worker…") starts this one instead and leaves the draft alone until it is edited.
    const draft = this.drafts.get(this.draftKey());
    this.typedLabel = draft?.fields?.label ?? null;
    this.modelQuery = '';
    this.levelMode = null;
    this.level = null;
    this.exact = prefill.preset && prefill.choice ? { ...prefill.preset, saved: { ...prefill.choice } } : null;
    this.addLines = this.exact?.instructions === true;
    this.asking = null;
    this.askEl.replaceChildren();
    this.linesOpen = false;
    this.uploadFailed = false;
    // The desk's composer draft (images too) if it is still in memory, else the text storage kept; a first task handed in starts a draft of its own.
    this.editor.show(prefill.prompt !== undefined ? this.newDoc(prefill.prompt) : this.deskDoc(this.draftKey(), draft?.text ?? ''));
    if (prefill.replaceDraft && prefill.prompt !== undefined) {
      // #93: the player chose to replace the desk's unsent task: the preset's text owns the desk now (its images go).
      const old = this.docs.get(this.draftKey());
      this.saveDraft();
      if (old && old !== this.editor.draft) old.dispose();
    }
    this.f = { prompt: this.editor.text, harness: '', model: '', effort: '', label: this.typedLabel ?? '', cwd: '', worktree: false };
    this.state = 'preparing';
    this.renderedKey = '';
    this.refetching = false;
    this.setStatus('Checking the floor, the folder and origin…');
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.editor.focus();
    void this.prepare();
  }

  private title(): string {
    return `Hire a worker at Desk ${this.desk + 1}`;
  }

  /**
   * #39: the key of the completion's context now (null: not prepared yet, or no harness). Its folder and worktree are
   * `worker.hire`'s (`hireArgs`), as typed: a Folder still being checked, or cleared back to the floor's default, is
   * already the context (the bridge translates the first prompt with that folder's skills), never the last one checked.
   */
  private lookupKey(): string | null {
    const p = this.prep;
    if (!this.dialog.open || !p || !this.f.harness || this.state === 'preparing' || this.state === 'failed') return (this.lookup = null);
    const a = hireArgs(this.floor, this.desk, this.f, p.git);
    this.lookup = { floor: this.floor, harness: this.f.harness, ...(a.cwd ? { cwd: a.cwd } : {}), worktree: !!a.worktree };
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

  private async prepare(cwd?: string): Promise<void> {
    const gen = ++this.gen;
    if (this.host.unsupported('hire.prepare')) {
      this.state = 'failed';
      this.setStatus(failureText('hire.prepare', 'unknown_command', ''), true);
      this.render();
      return;
    }
    const args: CommandArgs['hire.prepare'] = { floor: this.floor };
    if (cwd) args.cwd = cwd;
    const r = await this.host.send('hire.prepare', args);
    // A hire sent meanwhile: its form stays as sent.
    if (gen !== this.gen || !this.dialog.open || this.state === 'hiring') return;
    if (!r.ok) {
      // A folder that did not check out keeps the rest of the form.
      if (this.prep && cwd) {
        this.state = 'ready';
        this.setStatus(failureText('hire.prepare', r.code, r.message, { floor: this.floorName() }), true);
        this.render();
        return;
      }
      this.state = 'failed';
      this.setStatus(failureText('hire.prepare', r.code, r.message, { floor: this.floorName() }), true);
      this.render();
      return;
    }
    const p = r.data as HirePrepare;
    const options = this.options();
    if (this.prep && cwd) {
      // Same form, new folder (or origin fetched again): its git base, and the checkbox follows whether a worktree can be made.
      this.adoptGit(p.git);
      this.prep = { ...this.prep, cwd: p.cwd, capacity: p.capacity };
      this.f.cwd = p.cwd;
    } else {
      this.prep = p;
      const prompt = this.f.prompt;
      this.f = { ...formFromPrepare(p, options, this.host.hirePrefs?.worktreeByDefault), prompt };
      if (this.typedLabel !== null) this.f.label = this.typedLabel;
      // The note ("Floor default") is about the saved choice on the whole catalog, so it is not shown for a replacement.
      this.prepared = resolveChoice(this.host.store.hireOptions, p.choice ?? null);
      if (this.exact) {
        // #93: the preset's choice exactly as saved, whether the catalog still has it or not (`exactProblem` says).
        Object.assign(this.f, this.exact.saved);
        this.prepared = null;
      } else if (this.prefill.level !== undefined) {
        // #248: a level, never a reviewer's model; no usable level leaves the floor's choice in the usual pickers.
        this.syncLevels();
      } else {
        // A reviewer's model wins over the floor's default (and is no longer "the floor default").
        const want = this.prefill.choice ? resolveVisibleChoice(options, this.prefill.choice) : null;
        if (want) {
          Object.assign(this.f, want);
          this.prepared = null;
        }
      }
      // #248: a hire that must not touch the shared checkout takes a worktree whenever one can be made.
      if (this.prefill.worktree) this.f.worktree = worktreeUsable(p.git);
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
    else if (!was) this.f.worktree = this.prefill.worktree ?? this.host.hirePrefs?.worktreeByDefault ?? true;
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
    if (!this.dialog.open) return;
    const fv = this.host.store.floorView(this.floor);
    // #58 decision 3: the hire on an asleep virtual floor wakes its session first: the status follows the wake.
    if (this.state === 'hiring') {
      if (this.hiringText !== null) this.hiringStatus();
      this.render();
      return;
    }
    if (!fv) {
      this.close();
      this.host.toast(`${this.host.store.floorName(this.floor)} is gone.`, 'info');
      return;
    }
    if (fv.asleep && !fv.virtual) {
      this.close();
      this.host.toast(`${this.floorName()} went to sleep; wake it to hire.`, 'info');
      return;
    }
    this.render();
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

  /** Someone else sat down at this desk meanwhile, or another hire is on its way there: why, and the desk to offer instead. */
  private takenBy(): { why: string; next: number | null } | null {
    const fv = this.host.store.floorView(this.floor);
    if (!fv || this.state === 'hiring') return null;
    const held = this.host.held(this.floor);
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
    return this.prep ? capacityView(this.prep.capacity, this.floorName()) : null;
  }

  /**
   * The catalog as the dialog offers it: the models Settings leaves shown (the whole catalog without Settings). #93: a
   * preset's saved model stays offered while it is hidden (`offeredOptions`), so using the preset never swaps it.
   */
  private options(): HireOptions {
    const cat = this.host.store.hireOptions;
    const prefs = this.host.modelPrefs;
    if (this.exact) return offeredOptions(cat, prefs && ((harness) => prefs.hidden(harness)), [this.exact.saved]);
    return prefs ? visibleOptions(cat, (harness) => prefs.hidden(harness)) : cat;
  }

  /** #93: what of the form's choice cannot be hired now, for a form from a preset (null: all of it can, or no preset). */
  private exactProblem(): ExactProblem | null {
    return this.exact ? exactProblem(this.host.store.hireOptions, this.f) : null;
  }

  /**
   * The form holds a shown model: one it holds that is hidden falls to the first shown one (effort normalized).
   * #248: with the levels on screen (or none usable), the levels decide instead (`syncLevels`).
   */
  private resolveForm(): void {
    // #93: a preset's choice is never resolved to another one: valid, it stays; not, the player repairs it.
    if (this.exact) return;
    if (this.levelMode === 'levels' || this.levelMode === 'none') {
      this.syncLevels();
      return;
    }
    this.f = { ...this.f, ...resolveVisibleChoice(this.options(), this.f) };
  }

  /** #248, #40: the set levels in the player's order, each with why it cannot be used now (null: it can). */
  private levelChips(): LevelChip[] {
    const levels = this.host.taskLevels;
    if (!levels) return [];
    const cat = this.host.store.hireOptions;
    const prefs = this.host.modelPrefs;
    const hidden = (harness: string): ReadonlySet<string> => prefs?.hidden(harness) ?? new Set();
    return levels
      .list()
      .filter(isComplete)
      .map((l) => ({ id: l.id, text: levelChipText(l, cat), problem: levelProblem(l, cat, hidden) }));
  }

  /**
   * #248: the levels as they are now: the picked level while it can be used, else the one asked for or the nearest usable
   * one (its harness, model and effort into the form); none usable: the usual pickers, with the form resolved as usual.
   */
  private syncLevels(): void {
    const want = this.prefill.level;
    if (want === undefined) return;
    const ok = new Set(this.levelChips().flatMap((c) => (c.problem ? [] : [c.id])));
    // #40: the fallback goes by position in the whole list (a level not set yet counts as a place, never as a pick).
    const ids = this.host.taskLevels?.list().map((l) => l.id) ?? [];
    const requested = want !== 'default' && ids.includes(want) ? want : (this.host.taskLevels?.defaultId ?? null);
    const id = this.level && ok.has(this.level) ? this.level : requested !== null ? preselectLevel(ids, requested, (l) => ok.has(l)) : null;
    const l = id ? this.host.taskLevels?.get(id) : null;
    if (id && l) {
      this.levelMode = 'levels';
      this.level = id;
      this.f = { ...this.f, ...resolveVisibleChoice(this.options(), l) };
      return;
    }
    this.levelMode = 'none';
    this.level = null;
    this.f = { ...this.f, ...resolveVisibleChoice(this.options(), this.f) };
  }

  /** #248: a level chip was picked. */
  private pickLevel(id: TaskLevelId): void {
    this.level = id;
    this.syncLevels();
    this.render();
  }

  /** #248: "Choose a more complex model…": the usual pickers, holding the picked level's choice; or back to the levels. */
  private switchLevels(to: 'levels' | 'more'): void {
    if (this.state !== 'ready') return;
    if (to === 'more') this.levelMode = 'more';
    else this.syncLevels();
    this.render();
    const pick = this.levelMode === 'levels' ? 'level' : 'harness';
    this.optionsPane.querySelector<HTMLElement>(`[data-pick="${pick}"] input:checked`)?.focus();
  }

  /** Settings changed what is shown: an open form that holds a hidden model takes the first shown one, and the chips redraw. */
  private visibilityChanged(): void {
    if (!this.dialog.open || this.state === 'hiring' || this.state === 'preparing') return;
    this.resolveForm();
    this.render();
  }

  private blocker(): string | null {
    if (this.state === 'preparing') return 'Waiting for herdr-world…';
    if (this.state === 'failed') return this.statusText || 'herdr-world could not prepare the hire.';
    if (this.state === 'hiring') return 'The hire is on its way.';
    if (this.asking) return 'Answer the question above first.';
    const taken = this.takenBy();
    if (taken) return taken.why;
    if (this.host.unsupported('worker.hire')) return failureText('worker.hire', 'unknown_command', '');
    const bad = this.exactProblem();
    if (bad) return `${bad.why} Choose ${bad.field === 'effort' ? 'an effort' : `a ${bad.field}`} to hire with.`;
    const lines = this.addLines ? this.instructionLines() : null;
    return hireBlocker(this.f, this.options(), this.capacity()) ?? (lines !== null ? instructionsBlocker(this.f.prompt, lines) : null);
  }

  private gitView(g: HireGit | null): HireSummary['git'] {
    return gitView(g, this.host.now());
  }

  private noteNow(): string | null {
    // #93: "From preset" while the form holds the preset's choice.
    if (this.exact) {
      const c = this.exact.saved;
      return c.harness === this.f.harness && c.model === this.f.model && c.effort === this.f.effort ? 'From preset' : null;
    }
    const p = this.prepared;
    const same = !!p && p.harness === this.f.harness && p.model === this.f.model && p.effort === this.f.effort;
    return this.prep ? choiceNote(this.prep.choice_source, same) : null;
  }

  // ---- rendering ---------------------------------------------------------------

  private render(): void {
    // #39: a change of the floor, harness, folder or worktree box: an open popup follows it (its old rows never go in).
    this.lookups.check();
    const fv = this.host.store.floorView(this.floor);
    const where = fv?.level ? `Floor ${fv.level.number} of ${fv.level.count} · ${fv.building?.name ?? ''}` : 'Unassigned lot';
    const taken = this.takenBy();
    const key = JSON.stringify([this.floor, this.desk, this.state, this.prep, this.f.harness, this.f.model, this.f.effort, this.f.worktree, where, taken, this.statusText, this.refetching, this.host.store.limits.version, this.host.modelPrefs?.version, labelsOf(this.host.store.hireOptions, this.f.harness), this.levelMode, this.level, this.levelMode ? this.host.taskLevels?.version : null, this.exact, this.host.store.hirePresets?.known, this.addLines, this.host.store.hirePresets?.instructions]);
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
      h('div', { class: 'dd-titles' }, h('h2', { id: 'hire-title' }, this.title()), h('p', { id: 'hire-sub' }, `${this.floorName()} · ${where}`)),
      h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close)),
    );
    // M6 start: the orchestrator tab opens the start-run dialog for this desk; #93 the preset tab the desk's hire presets.
    const orch = this.host.orchestrate;
    const presets = this.host.presetsAt;
    this.tabs.hidden = !orch && !presets;
    if (orch || presets)
      this.tabs.replaceChildren(
        deskTabs(
          'worker',
          (t) => {
            if (this.state === 'hiring') return;
            const { floor, desk } = this;
            this.close();
            if (t === 'orch') orch?.open(floor, desk);
            else if (t === 'preset') presets?.(floor, desk);
          },
          orch ? orch.off() : false,
          !!presets,
        ),
      );

    const ready = this.state === 'ready';
    const busy = this.state === 'hiring' || this.state === 'preparing';
    const options = this.options();

    this.editor.busy = this.state === 'hiring';

    const nodes: Node[] = [];
    const notices: Node[] = [];

    if (this.prep) {
      const note = this.noteNow();
      const noteTitle = note === 'Floor default' ? 'The floor’s default hire (floor settings)' : note === 'From preset' ? `As saved in “${this.exact?.name ?? ''}”` : 'What was hired on this floor last time';
      const noteTape = note ? h('span', { class: 'tape tape--note', title: noteTitle }, note) : null;
      const models = modelsFor(options, this.f.harness);
      // #93: a preset whose harness is gone shows no model list (it has none): the callout above says why.
      const problem = this.exactProblem();
      const levels = this.levelMode ? this.levelChips() : [];
      const agent =
        this.levelMode === 'levels'
          ? h(
              'div',
              { class: 'dd-agent', 'data-hook': 'levels' },
              this.levelField(levels),
              h('div', { class: 'dd-level-switch' }, h('button', { type: 'button', class: 'btn btn--sm', 'data-key': 'levels-more', disabled: busy, onclick: () => this.switchLevels('more') }, 'Choose a more complex model…')),
            )
          : h(
              'div',
              { class: 'dd-agent' },
              this.levelMode === 'none' && levels.length ? this.levelsOff() : null,
              chips('harness', 'Harness', Object.keys(options), this.f.harness, (v) => this.pick({ harness: v }), noteTape),
              ...(models.length ? [this.modelField(models), chips('effort', 'Effort', effortsFor(options, this.f.harness, this.f.model), this.f.effort, (v) => this.pick({ effort: v }))] : problem?.field === 'harness' ? [] : [this.noModels()]),
              this.levelMode === 'more' && levels.some((c) => !c.problem)
                ? h('div', { class: 'dd-level-switch' }, h('button', { type: 'button', class: 'btn btn--sm btn--quiet', 'data-key': 'levels-back', disabled: busy, onclick: () => this.switchLevels('levels') }, 'Back to task levels'))
                : null,
            );
      const limits = planLimits(this.host.store.limits, [{ harness: this.f.harness, model: this.f.model }], this.host.now());
      const slot = h('div', { class: 'dd-plan-limits', 'data-hook': 'plan-limits' });
      if (limits) slot.append(limits);
      else slot.hidden = true;

      const label = h('input', { id: 'hire-label', 'data-key': 'label', autocomplete: 'off', spellcheck: 'false', maxlength: 64, placeholder: this.prep.label });
      label.value = this.f.label;
      label.addEventListener('input', () => {
        this.f.label = label.value;
        this.typedLabel = label.value;
        this.saveDraft();
        this.renderActions();
      });
      const cwd = h('input', { id: 'hire-cwd', 'data-key': 'cwd', autocomplete: 'off', spellcheck: 'false', placeholder: '/home/…', 'aria-describedby': 'hire-cwd-hint' });
      cwd.value = this.f.cwd;
      cwd.addEventListener('input', () => {
        this.f.cwd = cwd.value;
        // #39: another folder is another completion context at once (its check may take a while, or never come: cleared).
        this.lookups.check();
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
      if (this.exact) nodes.push(this.presetNote(problem));
      const lines = this.instructionLines();
      this.bytesEl = null;
      if (lines !== null) nodes.push(this.instructionsControl(lines));
      nodes.push(agent, slot, ids);

      const g = this.gitView(this.prep.git);
      if (g) {
        const on = this.f.worktree && g.usable;
        const wt = worktreeControl(g, on, (v) => {
          this.f.worktree = v;
          this.render();
        });
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
      notices.push(capacityBlock(this.capacity() as CapacityView, this.prep, this.floorName()));
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
    this.optionsPane.replaceChildren(...nodes);
    this.notices.replaceChildren(...notices);
    for (const el of this.optionsPane.querySelectorAll<HTMLInputElement>('input')) if (busy || this.refetching) el.disabled = true;
    this.renderActions();
    if (focusKey) {
      const back = this.dialog.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`) ?? this.dialog.querySelector<HTMLElement>(`#${CSS.escape(focusKey)}`);
      back?.focus();
      // A chip group re-rendered on another pick: focus its checked chip.
      if (!back && focusKey.includes(':')) this.optionsPane.querySelector<HTMLElement>(`[data-pick="${focusKey.split(':')[0]}"] input:checked`)?.focus();
    }
  }

  /**
   * #93: where the form came from (the preset, its scope), and, when its saved choice cannot be hired now, the saved
   * values and why: nothing else was picked in their place, so Hire waits for the player's own pick.
   */
  private presetNote(problem: ExactProblem | null): HTMLElement {
    const x = this.exact as NonNullable<HireDialog['exact']>;
    const scope = x.scope === 'floor' ? 'This floor' : 'Global';
    const from = h('p', { class: 'dd-preset-from' }, 'Preset ', h('b', {}, x.name), h('span', { class: 'dd-preset-scope' }, ` · ${scope}`));
    if (!problem) return h('div', { class: 'dd-field dd-preset', 'data-hook': 'preset' }, from, h('p', { class: 'field-hint' }, 'Edits here are for this hire only; the preset stays as saved.'));
    return h(
      'div',
      { class: 'dd-field dd-preset dd-callout dd-callout--error', 'data-hook': 'preset', 'data-problem': problem.field, role: 'alert' },
      from,
      h('p', {}, 'Saved with ', h('code', {}, presetChoiceText(this.host.store.hireOptions, x.saved)), `. ${problem.why}`),
      h('p', {}, `Nothing else was picked for you: choose ${problem.field === 'effort' ? 'an effort' : `a ${problem.field}`} below to hire with. The preset stays as saved.`),
    );
  }

  /**
   * #95: the herdr hiring instructions this hire would add (hire.prepare's, for this floor), null when the form has no
   * box: a bridge that does not add them (nothing sends it the flag). #117: a plain form has the box too, off.
   */
  private instructionLines(): string | null {
    const lines = this.prep?.herdr_instructions;
    return lines && this.host.store.hirePresets?.instructions ? lines : null;
  }

  /** #95: the first prompt's bytes as the bridge sends it with the lines: the task, a blank line, the lines. */
  private bytesWithLines(lines: string): number {
    const enc = new TextEncoder();
    return enc.encode(this.f.prompt).length + 2 + enc.encode(lines).length;
  }

  private bytesText(lines: string): string {
    return `With them, the first task is ${this.bytesWithLines(lines).toLocaleString('en-US')} of ${HIRE_PROMPT_MAX_BYTES.toLocaleString('en-US')} bytes.`;
  }

  /**
   * #95: the per-hire "Add herdr hiring instructions" under the preset note (#117: or first, on a plain form), ticked to
   * match the preset (a plain form: off); while ticked,
   * "What's added" shows the exact lines with this floor's id, and the byte count includes them.
   */
  private instructionsControl(lines: string): HTMLElement {
    const box = h('input', { type: 'checkbox', id: 'hire-instructions', 'data-key': 'instructions', 'aria-describedby': 'hire-instructions-hint' });
    box.checked = this.addLines;
    box.addEventListener('change', () => {
      this.addLines = box.checked;
      this.render();
    });
    const saved = this.exact?.instructions === true;
    const hint =
      this.exact && this.addLines !== saved
        ? `${this.addLines ? 'On' : 'Off'} for this hire only; the preset has it ${saved ? 'on' : 'off'}.`
        : this.addLines
          ? 'Each agent this worker starts gets its own herdr workspace or tab, tagged with this floor.'
          : 'Tick it if this task starts other agents: they get their own herdr workspace or tab on this floor.';
    const panel = h(
      'div',
      { class: 'dd-field dd-instructions', 'data-hook': 'instructions', 'data-on': this.addLines ? 'true' : 'false' },
      h('label', { class: 'dd-check', for: 'hire-instructions' }, box, h('span', { class: 'dd-check-box', 'aria-hidden': 'true' }), h('span', {}, 'Add herdr hiring instructions')),
      h('p', { class: 'field-hint dd-base', id: 'hire-instructions-hint' }, hint),
    );
    if (this.addLines) {
      this.bytesEl = h('p', { class: 'field-hint dd-instructions-bytes', 'data-hook': 'instructions-bytes' }, this.bytesText(lines));
      const details = h(
        'details',
        { class: 'dd-instructions-lines', 'data-hook': 'instructions-lines', open: this.linesOpen },
          h('summary', { 'data-key': 'instructions-lines' }, 'What’s added'),
          h('p', { class: 'field-hint dd-instructions-intro' }, 'After the first task and a blank line, the worker gets:'),
        h('pre', {}, lines),
        this.bytesEl,
      );
      details.addEventListener('toggle', () => (this.linesOpen = details.open));
      panel.append(details);
    }
    return panel;
  }

  /** #248: one chip per set level; one that cannot be used now is shown off, with why as its tooltip. */
  private levelField(list: LevelChip[]): HTMLFieldSetElement {
    const row = h('div', { class: 'dd-chips' });
    for (const c of list) {
      const l = this.host.taskLevels?.get(c.id);
      const exact = l ? `${HARNESS_LABEL[l.harness] ?? l.harness} · ${l.model} · ${l.effort}` : null;
      const input = h('input', { type: 'radio', name: 'level', value: c.id, class: 'visually-hidden', 'data-key': `level:${c.id}`, title: c.problem });
      input.checked = c.id === this.level;
      input.disabled = !!c.problem;
      input.addEventListener('change', () => input.checked && this.pickLevel(c.id));
      row.append(h('label', { class: 'dd-chip', title: c.problem ?? exact, 'data-off': c.problem ? 'true' : null }, input, h('span', {}, c.text)));
    }
    return h('fieldset', { class: 'dd-pick', 'data-pick': 'level' }, h('legend', {}, 'Level'), row);
  }

  /** #248: levels are set, but none can be used now: the usual pickers, and the way to Settings → Task levels. */
  private levelsOff(): HTMLElement {
    const open = this.host.showTaskLevelSettings ? h('button', { type: 'button', class: 'btn btn--sm', 'data-key': 'show-levels', onclick: () => this.host.showTaskLevelSettings?.() }, 'Open Task levels') : null;
    return h('div', { class: 'dd-field dd-callout', 'data-hook': 'levels-off', role: 'status' }, h('p', {}, 'None of your task levels can be used right now, so choose the model here.'), open);
  }

  /** A harness whose models are all hidden: why nothing can be picked, and the way to Settings. */
  private noModels(): HTMLElement {
    const total = this.host.store.hireOptions[this.f.harness]?.models.length ?? 0;
    const label = HARNESS_LABEL[this.f.harness] ?? this.f.harness;
    const text = total ? `All ${total} ${label} models are hidden, so there is nothing to hire with.` : 'This harness has no models to hire with.';
    const open = this.host.showModelSettings && total ? h('button', { class: 'btn btn--sm', 'data-key': 'show-models', onclick: () => this.host.showModelSettings?.() }, 'Open Harness models') : null;
    return h('div', { class: 'dd-field dd-callout', 'data-hook': 'no-models', role: 'status' }, h('p', {}, text), open);
  }

  private modelField(models: string[]): HTMLElement {
    return modelField(this.f.harness, models, this.f.model, labelsOf(this.host.store.hireOptions, this.f.harness), this.modelQuery, (v) => this.pick({ model: v }), (q) => (this.modelQuery = q));
  }

  private draftKey(floor = this.floor, desk = this.desk): string {
    return `${floor}:${desk}`;
  }

  /** What the form holds that is worth keeping across a reload: the task's text (not its images), and a label the user typed. */
  private draftNow(): { text: string; fields?: Record<string, string> } {
    const text = this.editor.draft.snapshot().text;
    return this.typedLabel ? { text, fields: { label: this.typedLabel } } : { text };
  }

  /** Saves what is on screen as the desk's draft, and makes that draft the desk's owner: a first task handed in only takes the desk here. */
  private saveDraft(): void {
    this.docs.set(this.draftKey(), this.editor.draft);
    this.drafts.set(this.draftKey(), this.draftNow());
  }

  /** The desk's own draft: the one in memory, else a new one that starts from the stored text. */
  private deskDoc(key: string, text: string): PromptDraft {
    let d = this.docs.get(key);
    if (!d) {
      d = this.newDoc(text);
      this.docs.set(key, d);
    }
    return d;
  }

  private newDoc(text = ''): PromptDraft {
    const d = new PromptDraft({
      upload: (file, hint, signal) => this.host.upload(file, hint, signal),
      label: () => this.f.label.trim() || this.prep?.label || 'hire',
      maxPromptBytes: HIRE_PROMPT_MAX_BYTES,
    });
    if (text) d.replace(0, 0, text);
    return d;
  }

  /** The task changed (typing, an image added or removed, an upload finished or failed). */
  private taskChanged(s: DraftSnapshot): void {
    this.f.prompt = promptText(s);
    // The draft belongs to its desk from the first save on (a first task handed in stays out of the way until then).
    this.saveDraft();
    if (this.uploadFailed && !s.failed) {
      this.uploadFailed = false;
      this.setStatus('');
    }
    this.renderActions();
  }

  /**
   * A hire was acknowledged: what was sent is gone, unless it was edited since (`revision`), and the desk's stored text goes with it.
   * Only the draft that owns a desk clears it: a newer one that took the desk while this hire was pending (Esc, a reopen with a first task, then a text or label edit) is its own, whatever it says.
   */
  private clearSent(doc: PromptDraft, revision: number, sent: { text: string; fields?: Record<string, string> }): void {
    const key = [...this.docs].find(([, d]) => d === doc)?.[0];
    if (key === undefined || !doc.clearIf(revision)) return;
    this.docs.delete(key);
    const now = this.drafts.get(key);
    if (!now) return;
    // The label typed since stays.
    this.drafts.set(key, JSON.stringify(now.fields ?? {}) === JSON.stringify(sent.fields ?? {}) ? { text: '' } : { text: '', ...(now.fields ? { fields: now.fields } : {}) });
  }

  private renderActions(): void {
    this.renderAsk();
    const blocker = this.blocker();
    // #95: the byte count with the lines follows the typing (a re-render of the options never runs for it).
    const lines = this.bytesEl && this.instructionLines();
    if (this.bytesEl && lines) this.bytesEl.textContent = this.bytesText(lines);
    const label = this.f.label.trim() || this.prep?.label || '';
    const cancel = h('button', { class: 'btn', 'data-key': 'cancel', onclick: () => this.close() }, this.state === 'hiring' ? 'Close' : 'Cancel');
    const text = this.state === 'hiring' ? 'Hiring…' : label ? `Hire ${label}` : 'Hire';
    const hire = h('button', { class: 'btn btn--primary', type: 'submit', form: 'hire-form', 'data-key': 'hire', 'aria-disabled': blocker ? 'true' : null, 'aria-busy': this.state === 'hiring' ? 'true' : null, title: blocker }, text);
    const had = document.activeElement === this.hireBtn;
    this.hireBtn = hire;
    const retry = this.state === 'failed' && !this.host.unsupported('hire.prepare') ? h('button', { class: 'btn', 'data-key': 'retry', onclick: () => this.retry() }, 'Try again') : null;
    const save = this.savePresetButton();
    const hadSave = !!save && document.activeElement?.getAttribute('data-key') === 'save-preset' && this.actions.contains(document.activeElement);
    // #108: the first task's review on purpose (with the switch on), then the hire.
    const review = reviewButton(this.host.secrets, this.state === 'preparing' ? 'Checking the floor first…' : this.state !== 'ready' ? 'The hire is on its way.' : blocker, () => void this.hire(true), 'first task');
    const hadReview = document.activeElement?.getAttribute('data-key') === 'review' && this.actions.contains(document.activeElement);
    this.actions.replaceChildren(...[save, retry, cancel, review, hire].filter((x): x is HTMLButtonElement => !!x));
    if (hadReview) review?.focus();
    if (hadSave) save?.focus();
    if (had) hire.focus();
  }

  /** #93: "Save as preset…" while the form is ready, on a bridge that keeps hire presets (an older one: the tab says why). */
  private savePresetButton(): HTMLButtonElement | null {
    const save = this.host.savePreset;
    if (!save || !this.host.store.hirePresets?.known || this.host.unsupported('hire_preset.create')) return null;
    const ready = this.state === 'ready';
    const b = h(
      'button',
      { type: 'button', class: 'btn btn--quiet dd-save-preset', 'data-key': 'save-preset', 'aria-disabled': ready ? null : 'true', title: 'Save this first task, harness, model and effort as a hire preset' },
      'Save as preset…',
    );
    b.addEventListener('click', () => {
      if (this.state !== 'ready') return;
      const s = this.editor.draft.snapshot();
      // #95: the box as this form has it (off from a form that has none); never the lines themselves.
      const instructions = this.instructionLines() !== null && this.addLines;
      save({ floor: this.floor, prompt: presetText(s), harness: this.f.harness, model: this.f.model, effort: this.f.effort, imagesLeftOut: s.images.length, instructions }, b);
    });
    return b;
  }

  /**
   * #93: the desk's unsent first task (its text, images and file chips, in memory or kept in storage), null when it has
   * none: using a preset there asks before replacing it.
   */
  unsent(floor: string, desk: number): { text: string; images: number } | null {
    const key = this.draftKey(floor, desk);
    const doc = this.docs.get(key);
    const snap = doc?.snapshot();
    const text = snap ? snap.text : (this.drafts.get(key)?.text ?? '');
    const images = snap ? snap.images.length : 0;
    return text.trim() || images || (doc?.doc.chips.length ?? 0) > 0 ? { text, images } : null;
  }

  private retry(): void {
    this.state = 'preparing';
    this.setStatus('Checking the floor, the folder and origin…');
    this.render();
    void this.prepare();
  }

  private pick(p: Partial<Pick<HireForm, 'harness' | 'model' | 'effort'>>): void {
    // #93: a preset's form follows exactly what is picked: an effort picked never moves a model the catalog lacks.
    const next = this.exact
      ? pickExact(this.options(), this.f, p)
      : resolveVisibleChoice(this.options(), { harness: p.harness ?? this.f.harness, model: p.model ?? this.f.model, effort: p.effort ?? this.f.effort });
    if (next.harness !== this.f.harness) this.modelQuery = '';
    this.f = { ...this.f, ...next };
    this.render();
  }

  /** Another desk: what is typed goes with it (an empty form takes that desk's own draft instead). */
  private moveTo(desk: number): void {
    const mine = this.draftNow();
    const doc = this.editor.draft;
    const from = this.draftKey();
    this.desk = desk;
    if (mine.text.trim() || mine.fields || doc.doc.chips.length > 0) {
      const there = this.docs.get(this.draftKey());
      this.docs.delete(from);
      this.docs.set(this.draftKey(), doc);
      if (there && there !== doc) there.dispose();
      this.drafts.clear(from);
      this.saveDraft();
    } else {
      const there = this.drafts.get(this.draftKey());
      this.typedLabel = there?.fields?.label ?? null;
      this.editor.show(this.deskDoc(this.draftKey(), there?.text ?? ''));
      this.f.prompt = this.editor.text;
      if (this.typedLabel !== null) this.f.label = this.typedLabel;
    }
    this.setStatus('');
    this.render();
    this.editor.focus();
  }

  /**
   * Hire: what the form holds goes to the coordinator. #108 round 4: with the switch on (or `manual`, "Review secrets"),
   * the first task is resolved first (its images uploaded: their paths are in the text `worker.hire` carries) and
   * reviewed, before the desk is held and before a background hire closes the dialog; the coordinator then sends that
   * text with its review. Cancel keeps the form as it was.
   */
  private async hire(manual = false): Promise<void> {
    if (this.state !== 'ready' || !this.prep) return;
    // #117: the question is open: it is answered first (an Enter or a click on Hire never answers it).
    this.renderAsk();
    if (this.asking) {
      this.focusAsk();
      return;
    }
    const blocker = this.blocker();
    if (blocker) {
      this.setStatus(blocker, true);
      this.renderActions();
      return;
    }
    const floor = this.floor;
    const desk = this.desk;
    this.saveDraft(); // also keep a prefilled task that has not been edited
    // The draft as sent: an acknowledged hire clears exactly this (a newer edit after Esc stays).
    const sent = this.draftNow();
    const doc = this.editor.draft;
    const args = hireArgs(floor, desk, this.f, this.prep.git);
    // #95: the flag, never the lines: the bridge adds them for the floor it hires on. Read once, here (#93 decision 8).
    const lines = this.addLines ? this.instructionLines() : null;
    const added = lines !== null && args.prompt ? 2 + new TextEncoder().encode(lines).length : 0;
    if (added) args.herdr_instructions = true;
    const who = args.label ?? this.prep.label;
    const gen = this.gen;
    const revision = doc.revision;
    const opening = this.opening;
    // #210: read once, here: a change in Settings while the hire is on its way does not change how it ends.
    const background = this.host.hirePrefs?.hireInBackground === true;
    this.state = 'hiring';
    this.hiringText = null;
    this.uploadFailed = false;
    const waiting = args.prompt ? doc.snapshot().images.filter((i) => i.status === 'pending' || i.status === 'uploading').length : 0;
    const flow = this.host.secrets;
    const still = () => this.dialog.open && gen === this.gen;
    let reviewed: { text: string; revision: number; secrets: { flow: PromptSecretsFlow; req: { key: string; text: string; target: string }; go: Go } } | null = null;
    if (manual && !args.prompt) {
      this.state = 'ready';
      this.setStatus('Write the first task first, then review its secrets.', true);
      this.render();
      return;
    }
    // No first task: nothing to review, hired as today.
    if (flow && (flow.on || manual) && args.prompt) {
      this.setStatus(waiting ? `Uploading ${waiting === 1 ? 'the image' : `${waiting} images`}, then looking for secrets in the first task…` : manual ? 'Opening the review of its secrets…' : 'Looking for secrets in the first task…');
      this.render();
      this.reviewing = gen;
      const res = await doc.resolve({ maxBytes: HIRE_PROMPT_MAX_BYTES - added });
      if (!still()) return;
      if (!res.ok) {
        this.reviewing = -1;
        this.state = 'ready';
        this.resolveForm();
        this.uploadFailed = res.reason === 'upload';
        this.setStatus(notSentText(res, '', added), true);
        this.render();
        return;
      }
      const req = { key: `hire:${floor}:${desk}`, text: res.text, target: `${who} at Desk ${desk + 1}`, manual };
      // (Closed meanwhile: no review opens for it. The coordinator's copy has no `live`: a background hire closes this.)
      const out = await flow.review({ ...req, live: still });
      if (this.reviewing === gen) this.reviewing = -1;
      if (!still()) return;
      if (out.kind === 'kept') {
        this.state = 'ready';
        this.resolveForm();
        this.setStatus(out.why === 'cancel' ? 'Not hired: the first task is still here.' : out.message, out.why === 'failed');
        this.render();
        this.editor.focus();
        return;
      }
      reviewed = { text: res.text, revision: res.revision, secrets: { flow, req, go: out } };
    }
    // #117: a plain form with the box off: does the first task start other agents? Only a "yes" in time stops the hire, to ask.
    if (args.prompt && this.askWanted()) {
      this.setStatus('Checking whether the first task starts other agents…');
      this.render();
      this.reviewing = gen;
      this.classifying = true;
      const asked = reviewed ? classifierView(reviewed.text, reviewed.secrets.go) : { prompt: args.prompt };
      const yes = await this.delegates(asked.prompt, asked.secrets);
      this.classifying = false;
      if (this.reviewing === gen) this.reviewing = -1;
      if (!still()) return;
      if (yes) {
        this.state = 'ready';
        this.resolveForm();
        this.setStatus('');
        this.render();
        this.ask(gen, (withLines) => {
          const lines = this.instructionLines();
          let sending = args;
          let extra = added;
          if (withLines && lines !== null) {
            // The box as the question answered it, before anything that can stop the hire, so the form says what was asked.
            this.addLines = true;
            const blocked = instructionsBlocker(reviewed?.text ?? this.f.prompt, lines);
            if (blocked) {
              this.setStatus(blocked, true);
              this.render();
              this.dialog.querySelector<HTMLElement>('#hire-instructions')?.focus();
              return;
            }
            sending = { ...args, herdr_instructions: true };
            extra = 2 + new TextEncoder().encode(lines).length;
          } else this.declined.set(this.draftKey(), this.f.prompt);
          this.state = 'hiring';
          this.hiringText = null;
          this.uploadFailed = false;
          this.render();
          void this.hireNow(floor, desk, sending, who, gen, revision, opening, background, sent, doc, extra, waiting, reviewed);
        });
        return;
      }
      this.setStatus('');
    }
    return this.hireNow(floor, desk, args, who, gen, revision, opening, background, sent, doc, added, waiting, reviewed);
  }

  /**
   * #117: whether Hire asks the classifier if the first task starts other agents (`nudgeWanted`, as the preset editor's
   * Save): a plain form (a preset's own choice is the player's), on a bridge with the box and the check, the classifier
   * ready, the box off, and the player did not already answer "Hire without" for exactly this text.
   */
  private askWanted(): boolean {
    if (this.exact || this.instructionLines() === null) return false;
    const supported = !!this.host.store.hirePresets?.instructions && !this.host.unsupported('hire_preset.check');
    const ready = supported && this.host.store.ai?.state?.classifier.state === 'ready';
    return nudgeWanted({ prompt: this.f.prompt, instructions: this.addLines }, { supported, ready, dismissed: this.declined.get(this.draftKey()) ?? null });
  }

  /** #117: the classifier's say on the first task (`classifierView` of the text the review saw: its `secrets`, or the text redacted where the review protects): false for anything but a "yes" (a refusal, a timeout, an older bridge's `unknown_command`). Never logged. */
  private async delegates(prompt: string, secrets?: Go['secrets']): Promise<boolean> {
    const r = await this.host.send('hire_preset.check', { prompt, ...(secrets ? { secrets } : {}) });
    return r.ok && (r.data as HirePresetCheckAck | undefined)?.delegates === true;
  }

  /** The form the question was asked about: any change to it takes the question back (`go` would hire something else). */
  private askKey(): string {
    return JSON.stringify([this.floor, this.desk, this.f, this.addLines]);
  }

  /** #117: the question, in the dialog by the buttons: "Hire with instructions" / "Hire without"; focus goes to the first only now, after the answer arrived. */
  private ask(gen: number, go: (withLines: boolean) => void): void {
    this.asking = { gen, key: this.askKey(), go };
    const without = h('button', { type: 'button', class: 'btn btn--sm', 'data-key': 'ask-without', title: 'Hire as typed; this text is not asked about again', onclick: () => this.answer(false) }, 'Hire without');
    const withLines = h('button', { type: 'button', class: 'btn btn--sm btn--primary', 'data-key': 'ask-with', onclick: () => this.answer(true) }, 'Hire with instructions');
    // The key held down since Hire (Enter repeats) must not land here as an answer: only a fresh press does.
    for (const b of [without, withLines])
      b.addEventListener('keydown', (e) => {
        if (e.repeat) e.preventDefault();
      });
    this.askEl.replaceChildren(
      h('div', { class: 'dd-callout pp-confirm', role: 'alert', 'data-hook': 'hire-ask' }, h('p', {}, HIRE_ASK_TEXT), h('div', { class: 'pp-confirm-actions' }, without, withLines)),
    );
    this.renderActions();
    this.focusAsk();
  }

  private focusAsk(): void {
    this.askEl.querySelector<HTMLElement>('[data-key="ask-with"]')?.focus();
  }

  private answer(withLines: boolean): void {
    this.renderAsk();
    const a = this.asking;
    if (!a) return;
    this.asking = null;
    this.renderAsk();
    a.go(withLines);
  }

  /** The question goes when its form changed (typing, a pick, the box), or its dialog did. */
  private renderAsk(): void {
    const a = this.asking;
    if (a && (a.gen !== this.gen || !this.dialog.open || a.key !== this.askKey())) this.asking = null;
    if (!this.asking) this.askEl.replaceChildren();
  }

  /** The hire, once its first task was reviewed (`reviewed`: its resolved text and review; null: as the form has it). */
  private async hireNow(
    floor: string,
    desk: number,
    args: CommandArgs['worker.hire'],
    who: string,
    gen: number,
    revision: number,
    opening: number,
    background: boolean,
    sent: { text: string; fields?: Record<string, string> },
    doc: PromptDraft,
    added: number,
    waiting: number,
    reviewed: { text: string; revision: number; secrets: { flow: PromptSecretsFlow; req: { key: string; text: string; target: string }; go: Go } } | null,
  ): Promise<void> {
    if (reviewed) revision = reviewed.revision;
    // The desk is held from here, the images go up, then `worker.hire` (the coordinator); the draft is read now.
    const op = this.hires.start(
      reviewed
        ? { key: `hire:${this.id}:${gen}`, floor, where: this.floorName(), desk, args: { ...args, prompt: reviewed.text }, who, prompt: null, background, secrets: reviewed.secrets, ...(added ? { added } : {}) }
        : { key: `hire:${this.id}:${gen}`, floor, where: this.floorName(), desk, args, who, prompt: args.prompt ? doc : null, background, ...(added ? { added } : {}) },
      {
        hiring: (sentArgs) => {
          // (The dialog may have been closed, even reopened for another desk, while the images went up: then it is not ours to touch.)
          if (background || !this.dialog.open || gen !== this.gen) return;
          const steps = [sentArgs.worktree ? 'creating the worktree' : null, `starting ${sentArgs.harness}`, sentArgs.prompt ? 'handing over the first task' : null].filter(Boolean);
          this.hiringText = `Hiring ${who}: ${steps.join(', ')}…`;
          this.hiringStatus();
          this.render();
        },
      },
    );
    if (background) {
      // #210: the dialog goes now and the player plays on; the coordinator says how it ended (one toast, a beep on success).
      // #58 decision 3: a hire on an asleep virtual floor wakes it first, which takes a while: say so now.
      if (this.wakes()) this.host.toast(`Waking floor ${this.floorName()}… ${who} is hired once it is up.`, 'info');
      this.close();
      const o = await op.done;
      if (o.kind === 'hired') this.clearSent(doc, o.revision ?? revision, sent);
      // A refusal must leave a usable form, including images and choices.
      // Never replace a newer form or open over another modal; uncertain
      // outcomes stay a warning so they cannot encourage a duplicate hire.
      if ((o.kind === 'failed' || o.kind === 'not_sent') && opening === this.opening && !document.querySelector('dialog[open]')) {
        this.dialog.showModal();
        this.landed(o, { floor, desk, who, gen: this.gen, doc, revision, sent });
        this.editor.focus();
      }
      return;
    }
    if (op.phase === 'uploading' && !reviewed) {
      this.setStatus(waiting ? `Uploading ${waiting === 1 ? 'the image' : `${waiting} images`} for ${who}…` : `Preparing ${who}’s first task…`);
      this.render();
    }
    this.landed(await op.done, { floor, desk, who, gen, doc, revision, sent });
  }

  /** A hire waited for in the dialog ended: the dialog, or (closed meanwhile) a toast, says how; the go-to on success. */
  private landed(o: HireOutcome, h: { floor: string; desk: number; who: string; gen: number; doc: PromptDraft; revision: number; sent: { text: string; fields?: Record<string, string> } }): void {
    // Esc'd meanwhile (and maybe another hire opened): only a toast, this dialog is someone else's now.
    const still = this.dialog.open && h.gen === this.gen;
    if (o.kind === 'not_sent') {
      // No worker.hire: the whole prompt stays, each failed chip says why and has its Retry.
      // Back to the editable form: what was typed stays, and the choice is resolved against what Settings shows now.
      if (still) {
        this.state = 'ready';
        this.resolveForm();
      }
      if (o.message && still) {
        this.uploadFailed = o.result.reason === 'upload';
        this.setStatus(o.message, true);
      } else if (o.message) this.host.toast(o.message, 'error');
      else if (still) this.setStatus('');
      if (still) this.render();
      return;
    }
    if (still) this.state = 'ready';
    if (o.kind === 'hired' || o.kind === 'not_prompted') {
      const ack = o.ack;
      const w = ack?.id ? this.host.store.workerView(ack.id) : null;
      const name = w?.name ?? h.who;
      const branch = ack?.branch ? ` on ${ack.branch}` : '';
      // The worker exists but never got the task (`prompted: false`): the text stays, so it can be copied or sent by hand.
      if (o.kind === 'hired') this.clearSent(h.doc, o.revision ?? h.revision, h.sent);
      // #155/#186: a Codex hire that runs on the built-in server instead of its own is a warning; a task not sent, an error.
      const notSent = o.kind === 'not_prompted' ? notPromptedText(o.ack) : '';
      if (still) this.close();
      // #116: also when the first task was not sent (so it can be prompted); never from a late ack (`still`).
      if (still && ack?.id) this.host.goTo?.(ack.id);
      const t = hiredToast(`Hired ${name} at Desk ${(w?.desk ?? h.desk) + 1}${branch}. Here they come.`, ack, notSent);
      this.host.toast(t.text, t.kind);
      return;
    }
    const msg = failureText('worker.hire', o.code, o.message, { floor: this.host.store.floorName(h.floor), desk: h.desk + 1 });
    if (!still) {
      this.host.toast(msg, 'error');
      return;
    }
    // Back to the editable form: the submitted choice is kept until now, then resolved against what Settings shows.
    this.resolveForm();
    this.setStatus(msg, true);
    this.render();
    if (o.code === 'capacity' || o.code === 'fetch_failed') void this.recheck();
  }

  /** After a capacity or fetch refusal: the caps and origin as they are now (the refusal stays in the status). */
  private async recheck(): Promise<void> {
    const gen = this.gen;
    const args: CommandArgs['hire.prepare'] = { floor: this.floor };
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
      floor: this.floor,
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
      images: this.editor.draft.snapshot().images.map((i) => ({ n: i.n, name: i.name, status: i.status, path: i.path })),
      ...(this.levelMode ? { level: { mode: this.levelMode, picked: this.level, chips: this.levelChips() } } : {}),
      ...(this.exact ? { preset: { id: this.exact.id, name: this.exact.name, saved: { ...this.exact.saved }, problem: this.exactProblem() } } : {}),
      ...(this.asking ? { asking: true as const } : {}),
      ...(this.instructionLines() !== null ? { instructions: { on: this.addLines, lines: this.instructionLines() as string, bytes: this.bytesWithLines(this.instructionLines() as string) } } : {}),
    };
  }
}
