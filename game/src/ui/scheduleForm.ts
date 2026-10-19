import './schedules.css';
import type { HandoffAck, HandoffCandidate, HandoffEntry, HandoffListAck, HireGit, HireOptions, HirePrepare, Schedule, ScheduleSource } from '../net/protocol';
import { snippetRuns } from '../world/handoff';
import { formFromPrepare, resolveVisibleChoice, modelsFor, visibleOptions, worktreeUsable } from '../world/hire';
import { labelsOf } from '../world/modelLabel';
import { inboxWhere } from '../world/inbox';
import { scheduleBlocker, scheduleFailureText, scheduleSpec, type ScheduleForm } from '../world/schedule';
import { countdownText, parseWhen, utcHint, wallText, whenText, type When } from '../world/scheduleTime';
import { browserZone } from '../world/daylight';
import { effortsFor } from '../world/settings';
import { newOp } from '../world/handoff';
import { backdropPolicy } from './dismiss';
import { h, icon, ICON, replaceKeepingFocus } from './dom';
import { chips, gitView, modelField, worktreeControl, type DialogHost } from './hire';
import type { HireModelPrefs } from './hireModelPrefs';
import type { HirePrefs } from './hirePrefs';
import { failureText } from './messages';
import { onReviewKey, reviewButton, type Go } from './secretsFlow';
import { mountComposer, type Composer } from './composer/composer';
import { Draft as PromptDraft, type Uploader } from './composer/draft';
import { HIRE_PROMPT_MAX_BYTES, mentionOf } from './composer/model';

/**
 * #64 schedules (part 3 of #61): the create / edit form of a scheduled agent, one component for "+ New", Edit and
 * "Schedule follow-up…" (Part 5's chip will open it with a prefill too). Title, prompt (the shared composer), when
 * (typed: `world/scheduleTime.ts`, or the picker; the absolute time it resolves to is shown before Save is enabled),
 * the hire spec prefilled as the hire dialog is (`hire.prepare`), wake the floor, the missed-window policy and the
 * handoff the worker reads: none, one from the floor's cabinet, or (from a transcript row) that message, filed as a
 * literal handoff on Save with one op for the form's life, so a re-save never files it twice.
 */

export interface ScheduleFormHost extends DialogHost {
  /** Images in the prompt go to the bridge's drop zone (absent: none can be added). */
  upload?: Uploader;
  /** Settings → Harness models: the models offered (all of them without it). */
  modelPrefs?: HireModelPrefs;
  /** Settings → Display: the worktree's initial choice (absent: on). */
  hirePrefs?: Partial<Pick<HirePrefs, 'worktreeByDefault'>>;
  /** Saved: the schedule as the bridge acked it (`created` false for an edit). */
  saved?(s: Schedule, created: boolean): void;
}

/** What a form opens with (Part 5 hands one in too). Every field is optional. */
export interface ScheduleFormPrefill {
  title?: string;
  prompt?: string;
  /** #66: when (unix ms), as a suggestion has it: shown on the zone's clock, its instant kept; passed, it is flagged. */
  dueAt?: number;
  choice?: { harness: string; model: string; effort: string };
  cwd?: string;
  source?: ScheduleSource;
  /** From a transcript row: that reply can be attached ("Attach this message as a handoff", on by default). */
  transcript?: { worker: string; name: string; candidate: HandoffCandidate };
}

export interface ScheduleFormOpen {
  floor: string;
  /** Edit this one (it must be `scheduled`). */
  edit?: Schedule;
  prefill?: ScheduleFormPrefill;
  /** Opened over the laptop you sit at (a transcript's follow-up): the seat stays. */
  seated?: boolean;
}

type HandoffMode = 'none' | 'keep' | 'cabinet' | 'transcript';

/** What the form shows (test hook `window.__h3d.scheduleForm()`). */
export interface ScheduleFormSummary {
  open: boolean;
  mode: 'create' | 'edit';
  floor: string;
  title: string;
  when: string;
  due: number | null;
  resolved: string;
  preparing: boolean;
  harness: string;
  model: string;
  effort: string;
  cwd: string;
  worktree: boolean;
  wakeFloor: boolean;
  onMiss: 'run_late' | 'skip';
  maxLateHours: string;
  handoff: HandoffMode;
  handoffPath: string | null;
  cabinet: Array<{ id: number; title: string }>;
  blocker: string | null;
  note: string | null;
  status: string;
  error: boolean;
  saving: boolean;
}

const CLOCK_ICON = '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>';
const SEARCH_MS = 180;
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Radio chips with words (the hire's `chips` print their values). */
function wordChips(name: string, legend: string, opts: Array<{ v: string; label: string; off?: string | null }>, value: string, onPick: (v: string) => void): HTMLFieldSetElement {
  const row = h('div', { class: 'dd-chips' });
  for (const o of opts) {
    const input = h('input', { type: 'radio', name, value: o.v, class: 'visually-hidden', 'data-key': `${name}:${o.v}` });
    input.checked = o.v === value;
    input.disabled = !!o.off;
    input.addEventListener('change', () => input.checked && onPick(o.v));
    row.append(h('label', { class: 'dd-chip', title: o.off ?? null, 'data-off': o.off ? 'true' : null }, input, h('span', {}, o.label)));
  }
  return h('fieldset', { class: 'dd-pick', 'data-pick': name }, h('legend', {}, legend), row);
}

export class ScheduleFormDialog {
  private readonly dialog = h('dialog', { class: 'desk-dlg desk-dlg--sched', 'aria-labelledby': 'sf-title', 'aria-describedby': 'sf-sub' });
  private readonly head = h('header', { class: 'dd-head' });
  private readonly form = h('form', { class: 'dd-body', id: 'sf-form', novalidate: true });
  private readonly titleIn = h('input', { id: 'sf-title-in', 'data-key': 'title', autocomplete: 'off', placeholder: 'What it is, as the list shows it' }) as HTMLInputElement;
  private readonly whenIn = h('input', { id: 'sf-when', 'data-key': 'when', autocomplete: 'off', spellcheck: 'false', placeholder: 'in 24h · tomorrow 10:45 · tomorrow 10:45 UTC · 2026-10-18 10:45', 'aria-describedby': 'sf-resolved' }) as HTMLInputElement;
  private readonly picker = h('input', { type: 'datetime-local', 'data-key': 'when-picker', 'aria-label': 'Pick a date and time' }) as HTMLInputElement;
  private readonly resolvedEl = h('p', { class: 'sf-resolved', id: 'sf-resolved', 'aria-live': 'polite', 'data-hook': 'sf-resolved' });
  private readonly composer: Composer;
  private readonly floorSel = h('select', { id: 'sf-floor', 'data-key': 'floor' }) as HTMLSelectElement;
  private readonly cwdIn = h('input', { id: 'sf-cwd', 'data-key': 'cwd', autocomplete: 'off', spellcheck: 'false', placeholder: '/home/…' }) as HTMLInputElement;
  private readonly wakeIn = h('input', { type: 'checkbox', id: 'sf-wake', 'data-key': 'wake' }) as HTMLInputElement;
  private readonly lateIn = h('input', { type: 'number', id: 'sf-late', 'data-key': 'late-hours', min: '0', step: '0.5', inputmode: 'decimal', placeholder: 'any' }) as HTMLInputElement;
  private readonly cabSearch = h('input', { type: 'search', 'data-key': 'cab-search', autocomplete: 'off', spellcheck: 'false', placeholder: 'Search this floor’s cabinet', 'aria-label': 'Search this floor’s cabinet' }) as HTMLInputElement;
  /** The handoff's choice and its note; the cabinet's search box stays mounted below it, so typing in it survives a redraw. */
  private readonly handoffPick = h('div', { class: 'sf-handoff-pick' });
  private readonly cabResults = h('div', { class: 'sf-cab-results' });
  private readonly cabBox = h('div', { class: 'sf-cab' }, this.cabSearch, this.cabResults);
  private readonly agentSlot = h('div', { class: 'dd-agent' });
  private readonly worktreeSlot = h('div');
  private readonly missSlot = h('div', { class: 'sf-row' });
  private readonly handoffSlot = h('div', { class: 'sf-handoff' });
  private readonly notices = h('div', { class: 'dd-notices' });
  private readonly statusEl = h('p', { class: 'dd-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private readonly actions = h('div', { class: 'dd-actions' });
  private readonly zone = browserZone();

  private mode: 'create' | 'edit' = 'create';
  private seated = false;
  private editId = '';
  private f: ScheduleForm = this.blank('');
  private prefill: ScheduleFormPrefill = {};
  private prep: HirePrepare | null = null;
  /** Why `hire.prepare` did not answer (an asleep floor, a folder that is not there): the form goes on without it. */
  private prepNote: string | null = null;
  private preparing = false;
  /** The form's identity: a new open or a close ends whatever the last one had in flight. */
  private formGen = 0;
  /** The latest `hire.prepare`: an older answer is dropped (a save is not). */
  private prepGen = 0;
  /** An edit's own instant and how the field shows it: while the field reads so, the instant is kept as it is (seconds, an overlap's second showing). */
  private kept: { text: string; at: number } | null = null;
  private handoffMode: HandoffMode = 'none';
  private picked: HandoffEntry | null = null;
  private cabRows: HandoffEntry[] = [];
  private cabGen = 0;
  private cabTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The transcript reply's filing: one op per reply (its candidate and revision), and the path once filed, kept for the
   * page's life: a re-save, or the form opened again on the same reply after a Cancel, never files it twice.
   */
  private readonly filings = new Map<string, { op: string; path: string | null }>();
  private filing: { op: string; path: string | null } | null = null;
  private get filedPath(): string | null {
    return this.filing?.path ?? null;
  }
  private saving = false;
  /** #108: the form (`formGen`) whose `schedule.create`/`schedule.update` is at the bridge now: Esc then leaves a save that still lands. */
  private sending = -1;
  private statusText = '';
  private statusError = false;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private modelQuery = '';
  /** When the time field was last read. */
  private parsedAt = 0;

  constructor(
    parent: HTMLElement,
    private readonly host: ScheduleFormHost,
  ) {
    this.composer = mountComposer({
      draft: this.newDraft(''),
      labelledBy: 'sf-prompt-label',
      describedBy: 'sf-prompt-hint',
      placeholder: 'What should the agent do when it starts?',
      submitPolicy: 'mod-enter',
      onSubmit: () => void this.save(),
      onChange: () => this.changed(),
    });
    this.composer.editor.id = 'sf-prompt';
    this.composer.editor.dataset.key = 'prompt';
    this.alertEl.hidden = this.statusEl.hidden = true;
    const whenField = h(
      'div',
      { class: 'dd-field' },
      h('label', { for: 'sf-when' }, 'When'),
      h('div', { class: 'sf-when-row' }, this.whenIn, this.picker),
      this.resolvedEl,
    );
    const promptField = h(
      'div',
      { class: 'dd-field sf-prompt' },
      h('label', { id: 'sf-prompt-label', onclick: () => this.composer.focus() }, 'Prompt'),
      this.composer.element,
      h('p', { class: 'field-hint', id: 'sf-prompt-hint' }, 'The new worker’s first prompt, sent when it starts. At most 32 KiB; it may stay empty when a handoff is attached.'),
    );
    const place = h(
      'div',
      { class: 'dd-grid' },
      h('div', { class: 'dd-field' }, h('label', { for: 'sf-floor' }, 'Floor'), this.floorSel),
      h('div', { class: 'dd-field' }, h('label', { for: 'sf-cwd' }, 'Folder'), this.cwdIn, h('p', { class: 'field-hint' }, 'Where the agent starts, on the server. It must exist when you save and when it starts.')),
    );
    const wake = h('label', { class: 'dd-check', for: 'sf-wake' }, this.wakeIn, h('span', { class: 'dd-check-box', 'aria-hidden': 'true' }), h('span', {}, 'Wake the floor if it is asleep'));
    this.form.append(h('div', { class: 'dd-field' }, h('label', { for: 'sf-title-in' }, 'Title'), this.titleIn), whenField, promptField, this.agentSlot, place, this.worktreeSlot, wake, this.missSlot, this.handoffSlot);
    this.handoffSlot.append(this.handoffPick, this.cabBox);
    this.dialog.append(this.head, this.form, h('footer', { class: 'dd-foot' }, this.notices, this.statusEl, this.alertEl, this.actions));

    this.titleIn.addEventListener('input', () => {
      this.f.title = this.titleIn.value;
      this.changed();
    });
    this.whenIn.addEventListener('input', () => this.reparse());
    this.picker.addEventListener('change', () => {
      if (!this.picker.value) return;
      this.whenIn.value = this.picker.value.replace('T', ' ').slice(0, 16);
      this.reparse();
    });
    this.cwdIn.addEventListener('input', () => {
      this.f.cwd = this.cwdIn.value;
      this.changed();
    });
    this.cwdIn.addEventListener('change', () => {
      const v = this.cwdIn.value.trim();
      if (v.startsWith('/') && v !== this.prep?.cwd) void this.prepare(v, false);
    });
    this.floorSel.addEventListener('change', () => {
      this.f.floor = this.floorSel.value;
      this.picked = null;
      this.cabRows = [];
      if (this.handoffMode === 'cabinet') this.cabQuery();
      void this.prepare(this.f.cwd.trim() || undefined, true);
    });
    this.wakeIn.addEventListener('change', () => {
      this.f.wakeFloor = this.wakeIn.checked;
      this.changed();
    });
    this.lateIn.addEventListener('input', () => {
      this.f.maxLateHours = this.lateIn.value;
      this.changed();
    });
    this.cabSearch.addEventListener('input', () => {
      if (this.cabTimer) clearTimeout(this.cabTimer);
      this.cabTimer = setTimeout(() => this.cabQuery(), SEARCH_MS);
    });
    this.cabSearch.addEventListener('keydown', (e) => {
      // Esc clears the search before it closes anything; Enter never saves from here.
      if (e.key === 'Enter') e.preventDefault();
      if (e.key === 'Escape' && this.cabSearch.value) {
        e.preventDefault();
        e.stopPropagation();
        this.cabSearch.value = '';
        this.cabQuery();
      }
    });
    // #108: the prompt's review on purpose (Ctrl/⌘+Shift+X, with the switch on); the switch shows or hides its button.
    onReviewKey(this.form, () => this.host.secrets, () => void this.save(true));
    host.secrets?.onChange(() => {
      if (this.dialog.open) this.renderActions();
    });
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.save();
    });
    this.dialog.addEventListener('close', () => {
      this.formGen++;
      this.prepGen++;
      this.cabGen++;
      if (this.cabTimer) clearTimeout(this.cabTimer);
      if (this.ticker) clearInterval(this.ticker);
      this.ticker = null;
      this.composer.closePreview();
    });
    this.dialog.addEventListener('cancel', () => {
      // Esc while the save is on its way: it still lands; the form just goes. (#108: not while its prompt is resolved,
      // scanned or scanned again after a refusal, nor while the message is filed: then nothing is saved, and nothing is said.)
      if (this.sending === this.formGen) this.host.toast('The schedule is still being saved; the list shows it once herdr-world answers.', 'info');
    });
    // Typed text in here: only the close button and Esc close it, never the backdrop.
    backdropPolicy(this.dialog, 'none');
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

  private blank(floor: string): ScheduleForm {
    return { floor, title: '', prompt: '', due: null, dueError: '', harness: '', model: '', effort: '', cwd: '', worktree: false, wakeFloor: true, onMiss: 'run_late', maxLateHours: '', handoff: { kind: 'none' } };
  }

  private newDraft(text: string): PromptDraft {
    const d = new PromptDraft({
      upload: (file, hint, signal) => (this.host.upload ? this.host.upload(file, hint, signal) : Promise.resolve({ ok: false, code: 'unsupported', message: 'images can’t be added here' })),
      label: 'schedule',
      maxPromptBytes: HIRE_PROMPT_MAX_BYTES,
    });
    if (text) d.replace(0, 0, text);
    return d;
  }

  /** Opens it: "+ New" (`floor` only), a prefilled create (a transcript row, Part 5), or Edit. */
  open(o: ScheduleFormOpen): void {
    this.formGen++;
    const e = o.edit;
    this.mode = e ? 'edit' : 'create';
    this.seated = o.seated === true;
    this.editId = e?.id ?? '';
    this.prefill = o.prefill ?? {};
    const p = this.prefill;
    this.f = this.blank(o.floor);
    this.prep = null;
    this.prepNote = null;
    this.picked = null;
    this.cabRows = [];
    this.cabSearch.value = '';
    const c = p.transcript?.candidate;
    const key = c ? `${p.transcript?.worker}/${c.id}/${c.revision}` : '';
    this.filing = c ? (this.filings.get(key) ?? { op: newOp(), path: null }) : null;
    if (c && this.filing) this.filings.set(key, this.filing);
    // A save the last open left in flight is over for this form (its answer is dropped).
    this.saving = false;
    this.composer.setBusy(false);
    this.modelQuery = '';
    this.setStatus('');
    if (e) {
      Object.assign(this.f, {
        title: e.title,
        prompt: e.prompt,
        harness: e.harness,
        model: e.model,
        effort: e.effort,
        cwd: e.cwd,
        worktree: e.worktree,
        wakeFloor: e.wake_floor,
        onMiss: e.on_miss,
        maxLateHours: e.max_lateness_ms ? String(Math.round((e.max_lateness_ms / 3_600_000) * 100) / 100) : '',
      });
      this.handoffMode = e.handoff_path ? 'keep' : 'none';
    } else {
      this.f.title = p.title ?? '';
      this.f.prompt = p.prompt ?? '';
      this.handoffMode = p.transcript ? 'transcript' : 'none';
    }
    this.composer.setDraft(this.newDraft(this.f.prompt));
    this.titleIn.value = this.f.title;
    // The time has no default (a plain follow-up's included); an edit (#66: or a suggestion) shows its own on the zone's
    // clock, and keeps its instant until the field reads otherwise: the wall clock read back could be the overlap's
    // other showing, and has no seconds.
    const at = e ? e.due_at : p.dueAt;
    this.whenIn.value = at ? wallText(at, this.zone) : '';
    this.kept = at ? { text: this.whenIn.value, at } : null;
    this.cwdIn.value = this.f.cwd || p.cwd || '';
    this.f.cwd = this.cwdIn.value;
    this.wakeIn.checked = this.f.wakeFloor;
    this.lateIn.value = this.f.maxLateHours;
    this.fillFloors();
    this.reparse(false);
    this.renderAll();
    if (!this.dialog.open) this.dialog.showModal();
    if (!this.ticker) this.ticker = setInterval(() => this.reparse(), 15_000);
    (this.f.title ? this.whenIn : this.titleIn).focus();
    void this.prepare(this.f.cwd.trim() || undefined, !e);
  }

  /** The world changed: the edited schedule may have moved on or gone; the floor may have gone. */
  refresh(): void {
    if (!this.dialog.open) return;
    this.renderNotices();
    this.renderActions();
  }

  private options(): HireOptions {
    const cat = this.host.store.hireOptions;
    const prefs = this.host.modelPrefs;
    return prefs ? visibleOptions(cat, (harness) => prefs.hidden(harness)) : cat;
  }

  private fillFloors(): void {
    const ids = this.host.store.city().flatMap((b) => b.floors.map((f) => f.id));
    if (!ids.includes(this.f.floor)) ids.unshift(this.f.floor);
    this.floorSel.replaceChildren(...ids.map((id) => h('option', { value: id }, inboxWhere(this.host.store, id))));
    this.floorSel.value = this.f.floor;
    // A schedule's floor cannot change once made.
    this.lockPlace();
  }

  /** A schedule's floor cannot change once made; while saving, neither Floor nor Folder moves (each starts a prepare). */
  private lockPlace(): void {
    this.floorSel.disabled = this.mode === 'edit' || this.saving;
    this.cwdIn.readOnly = this.saving;
  }

  /**
   * `hire.prepare` for the floor (and a folder): `full` adopts its defaults (the choice, the folder, the worktree), as
   * the hire dialog opens; else only the git base of a new folder. Refused (an asleep floor, a folder that is not
   * there): the form keeps what it has, falling back to the floor's settings, and says so.
   */
  private async prepare(cwd: string | undefined, full: boolean): Promise<void> {
    const gen = ++this.prepGen;
    this.preparing = true;
    this.renderActions();
    const r = this.host.unsupported('hire.prepare') ? { ok: false as const, code: 'unknown_command', message: '' } : await this.host.send('hire.prepare', { floor: this.f.floor, ...(cwd ? { cwd } : {}) });
    if (gen !== this.prepGen || !this.dialog.open) return;
    this.preparing = false;
    const options = this.options();
    if (!r.ok) {
      this.prep = null;
      this.prepNote = `herdr-world could not prepare this floor now (${failureText('hire.prepare', r.code, r.message, { floor: this.host.store.floorName(this.f.floor) }).replace(/\.$/, '')}). The folder and the worktree are checked when you save and when it starts.`;
      if (full && this.mode === 'create') {
        const fv = this.host.store.floorView(this.f.floor);
        const choice = resolveVisibleChoice(options, this.prefill.choice ?? fv?.settings.default_hire ?? null);
        Object.assign(this.f, choice);
        if (!this.f.cwd.trim()) this.f.cwd = this.prefill.cwd ?? fv?.settings.default_cwd ?? fv?.suggested.default_cwd ?? '';
        this.cwdIn.value = this.f.cwd;
      }
      this.renderAll();
      return;
    }
    const p = r.data as HirePrepare;
    this.prepNote = null;
    if (full && this.mode === 'create') {
      const d = formFromPrepare(p, options, this.host.hirePrefs?.worktreeByDefault);
      const want = this.prefill.choice ? resolveVisibleChoice(options, this.prefill.choice) : null;
      Object.assign(this.f, { harness: d.harness, model: d.model, effort: d.effort, worktree: d.worktree, cwd: p.cwd }, want ?? {});
      this.cwdIn.value = this.f.cwd;
    } else {
      this.f.cwd = p.cwd;
      this.cwdIn.value = p.cwd;
      // An edit keeps its own worktree choice while one can be made.
      if (!worktreeUsable(p.git)) this.f.worktree = false;
      else if (!this.prep && this.mode === 'create') this.f.worktree = this.host.hirePrefs?.worktreeByDefault ?? true;
    }
    this.prep = p;
    this.renderAll();
  }

  private git(): HireGit | null | undefined {
    // undefined: not known (no prepare answered); null: not a git repository.
    return this.prep ? this.prep.git : undefined;
  }

  private changed(): void {
    // The prompt as the checks see it: the text, an image as its marker, a file as its mention.
    let n = 0;
    this.f.prompt = this.composer.getSnapshot().segments.map((g) => (g.kind === 'text' ? g.text : g.kind === 'image' ? `[Image #${++n}]` : mentionOf(g.path))).join('');
    this.renderActions();
  }

  /** Reads the time field again (also every 15 s, so "in 2h" and the countdown stay true). */
  private reparse(render = true): void {
    // One instant for the reading and its countdown: "in 2h" says "in 2 h", not "in 1 h 59 min" a millisecond later.
    this.parsedAt = this.host.now();
    const k = this.kept;
    const r: When = k && this.whenIn.value.trim() === k.text && k.at > this.parsedAt ? { ok: true, at: k.at, zone: this.zone, relative: false } : parseWhen(this.whenIn.value, this.parsedAt, this.zone);
    this.f.due = r.ok ? r.at : null;
    // #66: a suggestion's time that passed (before the form opened, or while it is open) says so.
    const passed = !r.ok && k && this.mode === 'create' && k.at === this.prefill.dueAt && this.whenIn.value.trim() === k.text;
    this.f.dueError = r.ok ? '' : passed ? 'The suggested time has passed: type or pick a new one.' : r.error;
    if (r.ok) this.picker.value = wallText(r.at, this.zone, 'T');
    this.picker.min = wallText(this.host.now(), this.zone, 'T');
    this.renderResolved();
    if (render) this.renderActions();
  }

  private renderResolved(): void {
    const el = this.resolvedEl;
    if (this.f.due !== null) {
      el.dataset.error = 'false';
      el.replaceChildren(h('b', {}, whenText(this.f.due, this.zone)), h('span', {}, utcHint(this.f.due, this.zone)), h('span', {}, countdownText(this.f.due, this.parsedAt)));
    } else if (this.whenIn.value.trim()) {
      el.dataset.error = 'true';
      el.replaceChildren(this.f.dueError);
    } else {
      el.dataset.error = 'false';
      el.replaceChildren(h('span', {}, 'Type when it should start, or pick a date and time. Your zone: ', h('b', { class: 'sf-zone' }, this.zone), '.'));
    }
  }

  private renderAll(): void {
    this.renderHead();
    this.renderAgent();
    this.renderWorktree();
    this.renderMiss();
    this.renderHandoff();
    this.renderNotices();
    this.renderActions();
  }

  private renderHead(): void {
    const t = this.prefill.transcript;
    const title = this.mode === 'edit' ? 'Edit scheduled agent' : t ? `Schedule a follow-up to ${t.name}` : 'Schedule an agent';
    this.head.replaceChildren(
      h('div', { class: 'dd-plate sch-plate', 'aria-hidden': 'true' }, icon(CLOCK_ICON)),
      h('div', { class: 'dd-titles' }, h('h2', { id: 'sf-title' }, title), h('p', { id: 'sf-sub' }, `${inboxWhere(this.host.store, this.f.floor)} · a fresh worker is hired at that time`)),
      h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close)),
    );
  }

  private renderAgent(): void {
    const options = this.options();
    const harnesses = Object.keys(options);
    const models = modelsFor(options, this.f.harness);
    const nodes: Node[] = [];
    if (!harnesses.length) nodes.push(h('p', { class: 'sf-note' }, 'herdr-world offers no harness to hire with.'));
    else {
      nodes.push(chips('sf-harness', 'Harness', harnesses, this.f.harness, (v) => this.pick({ harness: v })));
      if (models.length) {
        nodes.push(
          modelField(this.f.harness, models, this.f.model, labelsOf(this.host.store.hireOptions, this.f.harness), this.modelQuery, (v) => this.pick({ model: v }), (q) => (this.modelQuery = q), 'sf-model'),
          chips('sf-effort', 'Effort', effortsFor(options, this.f.harness, this.f.model), this.f.effort, (v) => this.pick({ effort: v })),
        );
      } else nodes.push(h('p', { class: 'sf-note' }, 'Every model of this harness is hidden in Settings → Harness models.'));
    }
    replaceKeepingFocus(this.agentSlot, nodes);
  }

  private pick(c: Partial<{ harness: string; model: string; effort: string }>): void {
    if (c.harness && c.harness !== this.f.harness) this.modelQuery = '';
    const next = resolveVisibleChoice(this.options(), { harness: c.harness ?? this.f.harness, model: c.harness ? '' : (c.model ?? this.f.model), effort: c.effort ?? this.f.effort });
    Object.assign(this.f, next);
    const group = c.harness ? 'sf-harness' : c.model ? 'sf-model' : 'sf-effort';
    this.renderAgent();
    this.agentSlot.querySelector<HTMLElement>(`[data-pick="${group}"] input:checked`)?.focus();
    this.renderActions();
  }

  private renderWorktree(): void {
    const g = this.git();
    if (g === null) {
      this.f.worktree = false;
      this.worktreeSlot.replaceChildren();
      return;
    }
    if (g === undefined) {
      // Not prepared: a plain checkbox; the bridge checks the repository when it starts.
      const box = h('input', { type: 'checkbox', id: 'sf-worktree', 'data-key': 'worktree' }) as HTMLInputElement;
      box.checked = this.f.worktree;
      box.addEventListener('change', () => {
        this.f.worktree = box.checked;
        this.renderActions();
      });
      replaceKeepingFocus(this.worktreeSlot, [
        h(
          'div',
          { class: 'dd-worktree', 'data-on': this.f.worktree ? 'true' : 'false' },
          h('label', { class: 'dd-check', for: 'sf-worktree' }, box, h('span', { class: 'dd-check-box', 'aria-hidden': 'true' }), h('span', {}, 'Work in its own git worktree & branch')),
          h('p', { class: 'dd-base' }, 'The folder’s repository is not checked yet.'),
        ),
      ]);
      return;
    }
    const v = gitView(g, this.host.now());
    if (!v) return;
    const on = this.f.worktree && v.usable;
    const wt = worktreeControl(
      v,
      on,
      (x) => {
        this.f.worktree = x;
        this.renderWorktree();
        this.renderActions();
      },
      'sf-worktree',
    );
    // The hire dialog's fetch callout is not in this form: the base line says it.
    wt.querySelector('#sf-worktree')?.setAttribute('aria-describedby', 'sf-worktree-base');
    replaceKeepingFocus(this.worktreeSlot, [wt]);
  }

  private renderMiss(): void {
    const run = this.f.onMiss === 'run_late';
    this.lateIn.disabled = !run;
    const nodes: Node[] = [
      wordChips(
        'sf-miss',
        'If missed',
        [
          { v: 'run_late', label: 'Run late' },
          { v: 'skip', label: 'Skip it' },
        ],
        this.f.onMiss,
        (v) => {
          this.f.onMiss = v === 'skip' ? 'skip' : 'run_late';
          this.renderMiss();
          this.missSlot.querySelector<HTMLElement>('[data-pick="sf-miss"] input:checked')?.focus();
          this.renderActions();
        },
      ),
    ];
    if (run) nodes.push(h('label', { class: 'sf-late', for: 'sf-late' }, 'only if less than', this.lateIn, 'h late'));
    nodes.push(h('p', { class: 'sf-note' }, run ? 'herdr-world was off or asleep at its time: it still starts, told how late it is.' : 'herdr-world was off or asleep at its time: it does not start, and shows here as skipped.'));
    this.missSlot.replaceChildren(...nodes);
  }

  private renderHandoff(): void {
    const t = this.prefill.transcript;
    const cabinet = this.host.store.handoffs.known;
    const opts: Array<{ v: HandoffMode; label: string; off?: string | null }> = [{ v: 'none', label: 'None' }];
    if (this.editedPath()) opts.push({ v: 'keep', label: 'Keep attached' });
    opts.push({ v: 'cabinet', label: 'From the cabinet', off: cabinet ? null : 'This herdr-world has no filing cabinet (start it with --handoff-dir).' });
    if (t) opts.push({ v: 'transcript', label: 'This message' });
    const nodes: Node[] = [
      wordChips('sf-handoff', 'Handoff', opts, this.handoffMode, (v) => {
        this.handoffMode = v as HandoffMode;
        if (v === 'cabinet' && !this.cabRows.length) this.cabQuery();
        this.renderHandoff();
        this.handoffSlot.querySelector<HTMLElement>('[data-pick="sf-handoff"] input:checked')?.focus();
        this.renderActions();
      }),
    ];
    if (this.handoffMode === 'keep') {
      const path = this.editedPath();
      nodes.push(h('p', { class: 'sf-note' }, 'It reads ', h('code', {}, path ?? ''), ' when it starts.'));
    } else if (this.handoffMode === 'transcript' && t) {
      nodes.push(
        h(
          'p',
          { class: 'sf-note', 'data-hook': 'sf-attach' },
          ...(this.filedPath ? ['Filed as ', h('code', {}, this.filedPath), '; saving again uses it.'] : [`Attach this message as a handoff: ${t.name}’s reply is filed as written (no AI call) when you save, and the agent reads it when it starts.`]),
        ),
      );
    }
    replaceKeepingFocus(this.handoffPick, nodes);
    this.cabBox.hidden = this.handoffMode !== 'cabinet';
    if (this.handoffMode === 'cabinet') {
      const rows = this.cabRows.map((e) =>
        h(
          'li',
          {},
          h(
            'button',
            { class: 'sf-cab-row', 'data-id': String(e.id), 'data-key': `cab-row:${e.id}`, 'aria-pressed': this.picked?.id === e.id ? 'true' : 'false', onclick: () => this.pickEntry(e) },
            h('b', {}, e.title),
            h('span', {}, `${e.worker_name} · ${new Date(e.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}`),
            e.snippet ? h('span', {}, ...snippetRuns(e.snippet).map((r) => (r.hit ? h('mark', {}, r.text) : document.createTextNode(r.text)))) : null,
          ),
        ),
      );
      const list = rows.length ? h('ol', { class: 'sf-cab-list', 'aria-label': 'Handoffs' }, ...rows) : h('p', { class: 'sf-note' }, this.cabSearch.value.trim() ? `Nothing matches “${this.cabSearch.value.trim()}”.` : 'The cabinet of this floor is empty.');
      replaceKeepingFocus(this.cabResults, [list, ...(this.picked ? [h('p', { class: 'sf-note' }, 'It reads ', h('code', {}, this.picked.path), ' when it starts.')] : [])], undefined, { keepScroll: true });
    }
  }

  private editedPath(): string | null {
    return this.mode === 'edit' ? (this.host.store.schedules.get(this.editId)?.handoff_path ?? null) : null;
  }

  private pickEntry(e: HandoffEntry): void {
    this.picked = e;
    this.renderHandoff();
    this.handoffSlot.querySelector<HTMLElement>(`.sf-cab-row[data-id="${e.id}"]`)?.focus();
    this.renderActions();
  }

  private cabQuery(): void {
    this.cabTimer = null;
    void this.cabLoad(this.cabSearch.value);
  }

  /** The cabinet's search (`handoff.list`, as the cabinet does): a late answer for an older query is dropped. */
  private async cabLoad(q: string): Promise<void> {
    const gen = ++this.cabGen;
    const r = await this.host.send('handoff.list', { floor: this.f.floor, ...(q.trim() ? { q } : {}) });
    if (gen !== this.cabGen || !this.dialog.open) return;
    if (!r.ok) {
      this.cabRows = [];
      this.setStatus(failureText('handoff.list', r.code, r.message, { floor: this.host.store.floorName(this.f.floor) }), true);
    } else this.cabRows = (r.data as HandoffListAck).handoffs ?? [];
    if (this.handoffMode === 'cabinet') this.renderHandoff();
  }

  /** The handoff as the spec sends it. */
  private handoff(): ScheduleForm['handoff'] {
    switch (this.handoffMode) {
      case 'keep': {
        const p = this.editedPath();
        return p ? { kind: 'path', path: p } : { kind: 'none' };
      }
      case 'cabinet':
        return this.picked ? { kind: 'path', path: this.picked.path, title: this.picked.title } : { kind: 'none' };
      case 'transcript':
        return { kind: 'transcript' };
      default:
        return { kind: 'none' };
    }
  }

  /** Why the edited schedule can't be saved any more (null: it can, or this is a create). */
  private stale(): string | null {
    if (this.mode !== 'edit') return null;
    const s = this.host.store.schedules.get(this.editId);
    if (!s) return 'This schedule was cancelled or removed meanwhile: there is nothing to save it to.';
    if (s.state !== 'scheduled') return `This schedule is ${s.state === 'running' ? 'starting' : s.state} now: only one that is still scheduled can be edited.`;
    return null;
  }

  blocker(): string | null {
    if (this.host.unsupported(this.mode === 'edit' ? 'schedule.update' : 'schedule.create') || !this.host.store.schedules.known) return 'This herdr-world can’t schedule agents yet: it is older than scheduled agents.';
    const gone = this.stale();
    if (gone) return gone;
    if (this.saving) return 'Saving…';
    if (this.preparing && !this.f.harness) return 'Waiting for herdr-world…';
    // The cabinet's pick is asked for last: the rest of the spec is checked as if it were made.
    const choosing = this.handoffMode === 'cabinet' && !this.picked;
    const f = { ...this.f, handoff: choosing ? { kind: 'path' as const, path: '/' } : this.handoff() };
    return scheduleBlocker(f, this.options(), this.host.now(), bytes(this.f.prompt)) ?? (choosing ? 'Pick a handoff from the cabinet, or choose None.' : null);
  }

  private renderNotices(): void {
    const nodes: Node[] = [];
    const gone = this.stale();
    if (gone) nodes.push(h('div', { class: 'dd-callout dd-callout--error', role: 'alert', 'data-hook': 'sf-stale' }, h('p', {}, gone)));
    if (this.prepNote) nodes.push(h('div', { class: 'dd-callout', 'data-hook': 'sf-prep' }, h('p', {}, this.prepNote)));
    this.notices.replaceChildren(...nodes);
  }

  private renderActions(): void {
    const why = this.blocker();
    const label = this.mode === 'edit' ? 'Save changes' : this.handoffMode === 'transcript' && !this.filedPath ? 'File and schedule' : 'Schedule';
    const btn = h('button', { type: 'submit', form: 'sf-form', class: 'btn btn--primary', 'data-key': 'save', 'aria-disabled': why ? 'true' : null, 'aria-describedby': 'sf-why' }, label);
    const hint = h('p', { class: 'dd-status', id: 'sf-why', 'data-hook': 'sf-why', hidden: !why || this.statusText !== '' }, why ?? '');
    const a = document.activeElement;
    const had = a instanceof HTMLElement && this.actions.contains(a) ? a.dataset.key : null;
    // #108: the stored prompt's review on purpose (with the switch on), then the save.
    const review = reviewButton(this.host.secrets, this.saving ? 'Saving…' : why, () => void this.save(true), 'prompt');
    const cancel = h('button', { class: 'btn', 'data-key': 'cancel', onclick: () => this.close() }, 'Cancel');
    this.actions.replaceChildren(hint, cancel, ...(review ? [review] : []), btn);
    if (had) this.actions.querySelector<HTMLElement>(`[data-key="${had}"]`)?.focus();
    this.renderNotices();
  }

  /**
   * Save: the time read again (relative input counts from now), the prompt resolved, the message filed, then the schedule.
   * #108 round 4: with the switch on (or `manual`: "Review secrets"), the prompt is reviewed after it is resolved and before
   * anything is filed or saved: a saved prompt keeps no protected file, so every match stays as typed (the dialog says
   * so) and the save carries that review; Cancel saves nothing.
   */
  async save(manual = false): Promise<void> {
    if (this.saving || !this.dialog.open) return;
    this.reparse(false);
    const why = this.blocker();
    if (why) {
      this.setStatus(why, true);
      this.renderActions();
      return;
    }
    const gen = this.formGen;
    // The spec as it is now: what changes while saving is for the next Save.
    const form: ScheduleForm = { ...this.f, handoff: this.handoff() };
    const handoffMode = this.handoffMode;
    this.saving = true;
    this.lockPlace();
    this.setStatus(handoffMode === 'transcript' && !this.filedPath ? 'Filing the message…' : 'Saving…');
    this.composer.setBusy(true);
    this.renderActions();
    const end = (msg: string, error: boolean) => {
      this.saving = false;
      this.lockPlace();
      this.composer.setBusy(false);
      this.setStatus(msg, error);
      this.renderHandoff();
      this.renderActions();
    };
    const text = await this.composer.resolve({ maxBytes: HIRE_PROMPT_MAX_BYTES });
    if (gen !== this.formGen || !this.dialog.open) return;
    if (!text.ok) return end(text.reason === 'upload' ? 'An image did not upload: retry it or remove it.' : text.reason === 'refused' ? text.message : 'The prompt could not be read.', true);
    const flow = this.host.secrets;
    // (Closed meanwhile, or opened again: nothing of it goes, no review opens.)
    const sreq = { key: `schedule:${this.mode === 'edit' ? this.editId : 'new'}`, text: text.text, target: `“${form.title.trim() || 'the schedule'}”`, stored: true, manual, live: () => gen === this.formGen && this.dialog.open };
    let go: Go = { kind: 'send', protects: 0, shown: text.text, review: null };
    if (manual && !text.text) return end('Write a prompt first, then review its secrets.', true);
    if (text.text && flow && (flow.on || manual)) {
      this.setStatus(manual ? 'Opening the review of its secrets…' : 'Looking for secrets in the prompt…');
      const out = await flow.review(sreq);
      if (gen !== this.formGen || !this.dialog.open) return;
      if (out.kind === 'kept') return end(out.why === 'cancel' ? 'Not saved: the prompt is still here.' : out.message, out.why === 'failed');
      go = out;
      this.setStatus(handoffMode === 'transcript' && !this.filedPath ? 'Filing the message…' : 'Saving…');
    }
    let path: string | null = null;
    const t = this.prefill.transcript;
    if (handoffMode === 'transcript' && t) {
      if (!this.filedPath) {
        const c = t.candidate;
        const filing = this.filing ?? { op: newOp(), path: null };
        const a = await this.host.send('worker.handoff', { worker: t.worker, mode: 'literal', session: c.session, candidate: c.id, revision: c.revision, op: filing.op });
        // Filed is filed, whether or not this form is still open: the reply's record keeps the path (#64 decision 8).
        if (a.ok) filing.path = (a.data as HandoffAck).handoff.path;
        // The form opened again on this reply meanwhile: it says so now.
        if (a.ok && gen !== this.formGen && this.dialog.open && this.filing === filing && !this.saving) {
          this.renderHandoff();
          this.renderActions();
        }
        if (gen !== this.formGen || !this.dialog.open) return;
        if (!a.ok) return end(`${failureText('worker.handoff', a.code, a.message, { worker: t.name })} Nothing was scheduled.`, true);
        this.filing = filing;
      }
      path = this.filedPath;
      this.setStatus('Saving…');
    }
    const spec = scheduleSpec(form, text.text, path, this.mode === 'create' ? (this.prefill.source ?? (t ? { kind: 'transcript', worker: t.worker, ...(t.candidate.message ? { message: t.candidate.message } : {}) } : undefined)) : undefined);
    const cmd = this.mode === 'edit' ? 'schedule.update' : 'schedule.create';
    const send = (g: Go) => {
      this.sending = gen;
      const sent = this.mode === 'edit' ? this.host.send('schedule.update', { id: this.editId, ...spec, ...(g.secrets ? { secrets: g.secrets } : {}) }) : this.host.send('schedule.create', { ...spec, ...(g.secrets ? { secrets: g.secrets } : {}) });
      return sent.finally(() => {
        if (this.sending === gen) this.sending = -1;
      });
    };
    const d = flow ? await flow.deliver(sreq, go, send) : ({ kind: 'answered', result: await send(go) } as const);
    if (gen !== this.formGen || !this.dialog.open) return;
    if (d.kind === 'kept') return end(d.message, d.why === 'failed');
    const r = d.result;
    if (!r.ok) return end(`${scheduleFailureText(cmd, r.code, r.message, spec.title)}${this.filedPath ? ' The message is filed; saving again uses it.' : ''}`, true);
    const s = r.data as Schedule;
    this.saving = false;
    this.lockPlace();
    this.composer.setBusy(false);
    this.close();
    this.host.toast(this.mode === 'edit' ? `Saved “${s.title}”.` : `Scheduled “${s.title}” for ${whenText(s.due_at, this.zone)}.`, 'info');
    this.host.saved?.(s, this.mode === 'create');
  }

  private setStatus(msg: string, error = false): void {
    this.statusText = msg;
    this.statusError = error;
    this.alertEl.hidden = !error || !msg;
    this.statusEl.hidden = error || !msg;
    (error ? this.alertEl : this.statusEl).textContent = msg;
    (error ? this.statusEl : this.alertEl).textContent = '';
  }

  summary(): ScheduleFormSummary {
    const hf = this.handoff();
    return {
      open: this.dialog.open,
      mode: this.mode,
      floor: this.f.floor,
      title: this.f.title,
      when: this.whenIn.value,
      due: this.f.due,
      resolved: this.resolvedEl.textContent ?? '',
      preparing: this.preparing,
      harness: this.f.harness,
      model: this.f.model,
      effort: this.f.effort,
      cwd: this.f.cwd,
      worktree: this.f.worktree,
      wakeFloor: this.f.wakeFloor,
      onMiss: this.f.onMiss,
      maxLateHours: this.f.maxLateHours,
      handoff: this.handoffMode,
      handoffPath: hf.kind === 'path' ? hf.path : hf.kind === 'transcript' ? this.filedPath : null,
      cabinet: this.cabRows.map((e) => ({ id: e.id, title: e.title })),
      blocker: this.blocker(),
      note: this.prepNote,
      status: this.statusText,
      error: this.statusError,
      saving: this.saving,
    };
  }
}
