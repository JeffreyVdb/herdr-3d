import type { CommandResult } from '../net/client';
import type { CommandArgs, CommandName, HireAck, HireGit, HireOptions, HirePrepare } from '../net/protocol';
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
  resolveChoice,
  resolveVisibleChoice,
  visibleOptions,
  worktreeUsable,
  type CapacityView,
  type HireForm,
} from '../world/hire';
import { labelsOf, modelEntries, modelMatches, type ModelEntry, type ModelLabels } from '../world/modelLabel';
import { effortsFor } from '../world/settings';
import type { WorldStore } from '../world/store';
import { h, icon, ICON } from './dom';
import { failureText } from './messages';
import { hiredToast } from './hiredToast';
import { HireCoordinator, notPromptedText, type HireCoordinatorHost, type HireOutcome } from './hireCoordinator';
import type { HireModelPrefs } from './hireModelPrefs';
import type { HirePrefs } from './hirePrefs';
import type { ToastKind } from './hud';
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
  toast(msg: string, kind: ToastKind): void;
  now(): number;
}

export interface HireHost extends DialogHost {
  /** A hire is on its way to `desk` (its "+" goes); the returned function ends this hire's hold only. */
  reserve(session: string, desk: number): () => void;
  /** Desks of a floor a hire (or a walk) is already on its way to: not free for this one. */
  held(session: string): ReadonlySet<number>;
  /** #51: one image to Drop Zone through the bridge (`net/upload.ts`), for the first task's composer. */
  upload: Uploader;
  /** M6 start: the "Hire orchestrator" tab (ui/startRun.ts): why it is off, and opening it for the same desk. */
  orchestrate?: { off(): string | null; open(session: string, desk: number): void };
  /** #116: a hire was acknowledged while this dialog was still the one that sent it: take the player to the new worker (the host decides whether, and when it is ready). */
  goTo?(id: string): void;
  /** Settings → Harness models: which models this dialog offers (all of them without it). */
  modelPrefs?: HireModelPrefs;
  /** The empty state's way to Settings → Harness models. */
  showModelSettings?(): void;
  /** #210: Settings → Display "Hire in background", read once when Hire is pressed (absent: in the foreground). */
  hirePrefs?: Pick<HirePrefs, 'hireInBackground'>;
  /** #210: the game's hire coordinator (shared with other ways to hire); absent: the dialog makes its own from this host. */
  hires?: HireCoordinator;
  /** #210: the beep of a hire made in the background (absent: silent). */
  beep?(): void;
  /** #210: a background hire's undelivered first task into the new worker's Prompt (P) note (`HireCoordinatorHost.holdTask`). */
  holdTask?: HireCoordinatorHost['holdTask'];
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
  /** The first task's images in document order (`n` is the marker's number). */
  images: Array<{ n: number; name: string; status: string; path: string | null }>;
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
export function capacityBlock(c: CapacityView, p: HirePrepare, session: string): HTMLElement {
  const facts = `${session}: ${p.capacity.floor.count} of ${p.capacity.floor.soft} · host: ${p.capacity.host.count} of ${p.capacity.host.soft}${c.load ? ` · ${c.load}` : ''}`;
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
): HTMLFieldSetElement {
  const count = h('span', { class: 'dd-count', 'aria-live': 'polite' });
  const none = h('p', { class: 'field-hint dd-none' });
  const row = h('div', { class: 'dd-chips dd-chips--grid' });
  const chipsByValue: Array<[ModelEntry, HTMLLabelElement, HTMLInputElement]> = [];
  for (const e of modelEntries(harness, values, labels)) {
    const v = e.id;
    const input = h('input', { type: 'radio', name: 'model', value: v, class: 'visually-hidden', 'data-key': `model:${v}` });
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
  const search = h('input', { type: 'text', class: 'dd-search', 'data-key': 'model-search', autocomplete: 'off', spellcheck: 'false', 'aria-label': `Filter ${values.length} models`, placeholder: `Filter ${values.length} models` });
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
  return h('fieldset', { class: 'dd-pick dd-pick--models', 'data-pick': 'model' }, h('legend', {}, 'Model ', count), h('div', { class: 'dd-models' }, search, row, none));
}

/** Up to a row of chips; a long list gets a filter and a grid (`modelList`). */
export function modelField(harness: string, models: string[], value: string, labels: ModelLabels, query: string, onPick: (v: string) => void, onQuery: (q: string) => void): HTMLElement {
  if (models.length <= MODEL_LIST_AT) return chips('model', 'Model', models, value, onPick, null, modelEntries(harness, models, labels));
  return modelList(models, value, query, onPick, onQuery, harness, labels);
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

  constructor(handlers: { change(s: DraftSnapshot): void; send(): void; upload: Uploader }) {
    this.composer = mountComposer({
      draft: new PromptDraft({ upload: handlers.upload, maxPromptBytes: HIRE_PROMPT_MAX_BYTES }),
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
  /** The first task: its own pane, never re-rendered; harness, model, effort, folder and label sit in the options pane beside (or below) it. */
  private readonly editor = new TaskEditor({
    upload: (file, hint, signal) => this.host.upload(file, hint, signal),
    change: (s) => this.taskChanged(s),
    send: () => void this.hire(),
  });
  private readonly editorPane = h('div', { class: 'hire-editor-pane' }, this.editor.el);
  private readonly optionsPane = h('div', { class: 'hire-options-pane' });
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
  /** #51: what was typed and not hired yet, per desk of a floor (memory, and localStorage where allowed): the text and label. */
  private readonly drafts = new Drafts('hire');
  /**
   * The first task's composer draft per desk (text, images, their uploads): kept in memory while the page lives; images do not survive a reload.
   * The entry is also the owner of the desk's stored draft: whoever saves it (a task or label edit, the desk's own draft on open, a move) is registered here.
   */
  private readonly docs = new Map<string, PromptDraft>();
  /** The last hire attempt stopped on a failed upload: the message stays until every image is uploaded or gone. */
  private uploadFailed = false;
  /** The label the user typed (the prepared name is only a default), restored over the prepared one. */
  private typedLabel: string | null = null;
  /** The model filter of a long list; a harness switch clears it. */
  private modelQuery = '';
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
    // Settings changed which models show: an open form follows it (a hire on its way keeps what it sent).
    this.host.modelPrefs?.onChange(() => this.visibilityChanged());
    this.alertEl.hidden = true;
    this.statusEl.hidden = true;
    this.form.append(this.editorPane, this.optionsPane);
    this.dialog.append(this.head, this.tabs, this.form, this.foot);
    // A late answer (a prepare, or a hire sent before Esc) is for a dialog that is gone: it never touches the next one.
    this.dialog.addEventListener('close', () => {
      if (!this.dialog.open) this.gen++;
      // An enlarged image is nested in this dialog: it goes with it (it holds a window key listener).
      this.editor.closePreview();
    });
    this.dialog.addEventListener('cancel', () => {
      // Esc while the hire is on its way: the hire still happens; the dialog just goes.
      if (this.state === 'hiring') this.host.toast('The hire is still on its way; the worker shows up at the desk when it is done.', 'info');
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
    // #51: the desk's draft comes back; a first task handed in ("Ask a worker…") starts this one instead and leaves the draft alone until it is edited.
    const draft = this.drafts.get(this.draftKey());
    this.typedLabel = draft?.fields?.label ?? null;
    this.modelQuery = '';
    this.uploadFailed = false;
    // The desk's composer draft (images too) if it is still in memory, else the text storage kept; a first task handed in starts a draft of its own.
    this.editor.show(prefill.prompt !== undefined ? this.newDoc(prefill.prompt) : this.deskDoc(this.draftKey(), draft?.text ?? ''));
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
    const options = this.options();
    if (this.prep && cwd) {
      // Same form, new folder (or origin fetched again): its git base, and the checkbox follows whether a worktree can be made.
      this.adoptGit(p.git);
      this.prep = { ...this.prep, cwd: p.cwd, capacity: p.capacity };
      this.f.cwd = p.cwd;
    } else {
      this.prep = p;
      const prompt = this.f.prompt;
      this.f = { ...formFromPrepare(p, options), prompt };
      if (this.typedLabel !== null) this.f.label = this.typedLabel;
      // The note ("Floor default") is about the saved choice on the whole catalog, so it is not shown for a replacement.
      this.prepared = resolveChoice(this.host.store.hireOptions, p.choice ?? null);
      // A reviewer's model wins over the floor's default (and is no longer "the floor default").
      const want = this.prefill.choice ? resolveVisibleChoice(options, this.prefill.choice) : null;
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

  /** The catalog as the dialog offers it: the models Settings leaves shown (the whole catalog without Settings). */
  private options(): HireOptions {
    const cat = this.host.store.hireOptions;
    const prefs = this.host.modelPrefs;
    return prefs ? visibleOptions(cat, (harness) => prefs.hidden(harness)) : cat;
  }

  /** The form holds a shown model: one it holds that is hidden falls to the first shown one (effort normalized). */
  private resolveForm(): void {
    this.f = { ...this.f, ...resolveVisibleChoice(this.options(), this.f) };
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
    const taken = this.takenBy();
    if (taken) return taken.why;
    if (this.host.unsupported('worker.hire')) return failureText('worker.hire', 'unknown_command', '');
    return hireBlocker(this.f, this.options(), this.capacity());
  }

  private gitView(g: HireGit | null): HireSummary['git'] {
    return gitView(g, this.host.now());
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
    const key = JSON.stringify([this.session, this.desk, this.state, this.prep, this.f.harness, this.f.model, this.f.effort, this.f.worktree, where, taken, this.statusText, this.refetching, this.host.store.limits.version, this.host.modelPrefs?.version, labelsOf(this.host.store.hireOptions, this.f.harness)]);
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
    const options = this.options();

    this.editor.busy = this.state === 'hiring';

    const nodes: Node[] = [];
    const notices: Node[] = [];

    if (this.prep) {
      const note = this.noteNow();
      const noteTape = note ? h('span', { class: 'tape tape--note', title: note === 'Floor default' ? 'The floor’s default hire (floor settings)' : 'What was hired on this floor last time' }, note) : null;
      const models = modelsFor(options, this.f.harness);
      const agent = h(
        'div',
        { class: 'dd-agent' },
        chips('harness', 'Harness', Object.keys(options), this.f.harness, (v) => this.pick({ harness: v }), noteTape),
        ...(models.length ? [this.modelField(models), chips('effort', 'Effort', effortsFor(options, this.f.harness, this.f.model), this.f.effort, (v) => this.pick({ effort: v }))] : [this.noModels()]),
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
      notices.push(capacityBlock(this.capacity() as CapacityView, this.prep, this.session));
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

  private draftKey(session = this.session, desk = this.desk): string {
    return `${session}:${desk}`;
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
    const next = resolveVisibleChoice(this.options(), { harness: p.harness ?? this.f.harness, model: p.model ?? this.f.model, effort: p.effort ?? this.f.effort });
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
    // The draft as sent: an acknowledged hire clears exactly this (a newer edit after Esc stays).
    const sent = this.draftNow();
    const doc = this.editor.draft;
    const args = hireArgs(session, desk, this.f, this.prep.git);
    const who = args.label ?? this.prep.label;
    const gen = this.gen;
    const revision = doc.revision;
    // #210: read once, here: a change in Settings while the hire is on its way does not change how it ends.
    const background = this.host.hirePrefs?.hireInBackground === true;
    this.state = 'hiring';
    this.uploadFailed = false;
    const waiting = args.prompt ? doc.snapshot().images.filter((i) => i.status === 'pending' || i.status === 'uploading').length : 0;
    // The desk is held from here, the images go up, then `worker.hire` (the coordinator); the draft is read now.
    const op = this.hires.start(
      { key: `hire:${this.id}:${gen}`, session, desk, args, who, prompt: args.prompt ? doc : null, background },
      {
        hiring: (sentArgs) => {
          // (The dialog may have been closed, even reopened for another desk, while the images went up: then it is not ours to touch.)
          if (background || !this.dialog.open || gen !== this.gen) return;
          const steps = [sentArgs.worktree ? 'creating the worktree' : null, `starting ${sentArgs.harness}`, sentArgs.prompt ? 'handing over the first task' : null].filter(Boolean);
          this.setStatus(`Hiring ${who}: ${steps.join(', ')}…`);
          this.render();
        },
      },
    );
    if (background) {
      // #210: the dialog goes now and the player plays on; the coordinator says how it ended (one toast, a beep on success).
      this.close();
      const o = await op.done;
      if (o.kind === 'hired') this.clearSent(doc, o.revision ?? revision, sent);
      return;
    }
    if (op.phase === 'uploading') {
      this.setStatus(waiting ? `Uploading ${waiting === 1 ? 'the image' : `${waiting} images`} for ${who}…` : `Preparing ${who}’s first task…`);
      this.render();
    }
    this.landed(await op.done, { session, desk, who, gen, doc, revision, sent });
  }

  /** A hire waited for in the dialog ended: the dialog, or (closed meanwhile) a toast, says how; the go-to on success. */
  private landed(o: HireOutcome, h: { session: string; desk: number; who: string; gen: number; doc: PromptDraft; revision: number; sent: { text: string; fields?: Record<string, string> } }): void {
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
    const msg = failureText('worker.hire', o.code, o.message, { floor: h.session, desk: h.desk + 1 });
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
      images: this.editor.draft.snapshot().images.map((i) => ({ n: i.n, name: i.name, status: i.status, path: i.path })),
    };
  }
}
