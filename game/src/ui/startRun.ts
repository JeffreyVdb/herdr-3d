import type { CommandArgs, Hire, HireGit, Preset, RunPrepare, RunStartAck } from '../net/protocol';
import { baseText, capacityView, fetchNote, firstFreeDesk, freeDesks, modelsFor, resolveChoice, worktreeUsable, type CapacityView } from '../world/hire';
import { effortsFor } from '../world/settings';
import {
  emptyPreview,
  parseTicket,
  prepareArgs,
  previewEdited,
  previewGenerated,
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
import { deskTabs } from './deskTabs';
import { chips, type HireHost } from './hire';
import { failureText } from './messages';

/**
 * The start-run dialog (M6): the "Hire orchestrator" tab of the hire dialog
 * on an empty desk, the top bar's Run (the floor's first free desk), and
 * `openStartRun` for M7's "Hand to a worker". It hires an orchestrator (the
 * M4 hire) whose first prompt starts a /write-code run with a team preset.
 * The prompt preview comes from `run.prepare` on every field change; once
 * edited it is the user's, and field changes only say that it differs.
 */

export interface StartRunHost extends HireHost {
  /** The Worker tab: the M4 hire dialog for the same desk. */
  hireAt(session: string, desk: number): void;
  /** The presets panel, over this dialog (focus comes back to `from`). */
  openPresets(from: HTMLElement | null): void;
  /** The run started: the view follows the new orchestrator. M7: `workItem` when it started on a board card. */
  started(workerId: string, workItem?: { provider: string; id: string }): void;
}

export interface StartRunOptions {
  session: string;
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
  session: string;
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
  git: { base: string; usable: boolean; note: string | null } | null;
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

  private session = '';
  private desk = 0;
  private state: StartRunState = 'preparing';
  private prep: RunPrepare | null = null;
  private f: RunForm = blankForm();
  private preview: Preview = emptyPreview();
  /** The user picked the orchestrator's harness / model / effort: a new preset no longer changes it. */
  private orchTouched = false;
  private ticketError: string | null = null;
  private statusText = '';
  private statusError = false;
  /** Bumped on every open and prepare, so a late answer for an older one is dropped. */
  private gen = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private presetsSeen = -1;
  private renderedKey = '';
  private startBtn: HTMLButtonElement | null = null;
  /** Where focus goes back to when the dialog closes (not when it hands over to the Worker tab). */
  private returnTo: HTMLElement | null = null;

  constructor(
    parent: HTMLElement,
    private readonly host: StartRunHost,
  ) {
    this.alertEl.hidden = true;
    this.statusEl.hidden = true;
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
      if (this.state === 'starting') this.host.toast('The run is still starting; its orchestrator shows up at the desk when it is hired.', 'info');
    });
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.close();
    });
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
    this.session = o.session;
    this.desk = o.desk;
    this.prep = null;
    this.f = blankForm();
    this.f.desk = o.desk;
    if (o.issue !== undefined) this.f.ticket = typeof o.issue === 'number' ? `#${o.issue}` : o.issue;
    this.f.workItem = o.workItem ?? null;
    this.preview = emptyPreview();
    this.orchTouched = false;
    this.ticketError = null;
    this.renderedKey = '';
    this.presetsSeen = this.host.store.presets.version;
    this.clearTimer();
    this.inFlight = false;
    const off = runUnsupported(this.host);
    this.state = off ? 'failed' : 'preparing';
    this.setStatus(off ?? 'Asking herdr-world for the team, the folder and origin…', !!off);
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
    const fv = this.host.store.floorView(this.session);
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

  private async prepare(): Promise<void> {
    const gen = ++this.gen;
    this.inFlight = true;
    const r = await this.host.send('run.prepare', prepareArgs(this.session, this.f, this.ticket()));
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
        this.setStatus(failureText('run.prepare', r.code, r.message, { floor: this.session }), true);
      } else {
        this.state = 'failed';
        this.setStatus(failureText('run.prepare', r.code, r.message, { floor: this.session }), true);
      }
      this.render();
      return;
    }
    const p = r.data as RunPrepare;
    const first = !this.prep;
    this.prep = p;
    if (first) {
      this.f.preset = p.preset;
      this.f.orch = resolveChoice(this.host.store.hireOptions, p.orch);
      this.f.worktree = worktreeUsable(p.git);
    } else if (!worktreeUsable(p.git)) this.f.worktree = false;
    this.ticketError = null;
    this.preview = previewGenerated(this.preview, p.prompt);
    this.state = 'ready';
    if (!this.statusError || first) this.setStatus('');
    this.render();
  }

  /** The world changed: the desk may be taken, the floor gone or asleep, a preset changed or gone. */
  refresh(): void {
    if (!this.dialog.open || this.state === 'starting') return;
    const fv = this.host.store.floorView(this.session);
    if (!fv) {
      this.close();
      this.host.toast(`${this.session} is gone.`, 'info');
      return;
    }
    if (fv.asleep) {
      this.close();
      this.host.toast(`${this.session} went to sleep; wake it to start a run.`, 'info');
      return;
    }
    const book = this.host.store.presets;
    if (book.version !== this.presetsSeen) {
      this.presetsSeen = book.version;
      if (this.prep && this.state === 'ready') {
        if (!book.get(this.f.preset)) {
          const next = book.defaultFor(fv.floor.last_preset);
          this.f.preset = next?.id ?? '';
          if (next && !this.orchTouched) this.f.orch = resolveChoice(this.host.store.hireOptions, next.roles.orch);
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
    return this.prep ? capacityView(this.prep.capacity, this.session) : null;
  }

  private takenBy(): { why: string; next: number | null } | null {
    const fv = this.host.store.floorView(this.session);
    if (!fv || this.state === 'starting') return null;
    const held = this.host.held(this.session);
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
    return startBlocker(this.f, t, this.preview, this.host.store.hireOptions, this.host.store.presets);
  }

  private gitView(g: HireGit | null): StartRunSummary['git'] {
    if (!g) return null;
    return { base: baseText(g, this.host.now()), usable: worktreeUsable(g), note: fetchNote(g)?.text ?? null };
  }

  private preset(): Preset | null {
    return this.host.store.presets.get(this.f.preset);
  }

  // ---- rendering ----------------------------------------------------------------------

  private render(): void {
    const fv = this.host.store.floorView(this.session);
    const where = fv?.level ? `Floor ${fv.level.number} of ${fv.level.count} · ${fv.building?.name ?? ''}` : 'Unassigned lot';
    const book = this.host.store.presets;
    const free = fv ? freeDesks(fv).filter((d) => d === this.f.desk || !this.host.held(this.session).has(d)) : [];
    const key = JSON.stringify([this.session, this.f.desk, this.state, this.f.workItem?.id ?? null, this.prep && { ...this.prep, prompt: '', label: '' }, this.f.preset, this.f.orch, this.f.worktree, where, this.takenBy(), this.statusText, book.version, free, this.ticketError !== null]);
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
      h('div', { class: 'dd-titles' }, h('h2', { id: 'run-title' }, this.title()), h('p', { id: 'run-sub' }, `${this.session} · ${where}`)),
      h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close)),
    );
    this.tabsSlot.replaceChildren(
      deskTabs(
        'orch',
        () => {
          if (this.state === 'starting') return;
          // The Worker tab takes over, focus and all; what opened this dialog is the hire dialog's to restore.
          this.returnTo = null;
          this.close();
          this.host.hireAt(this.session, this.f.desk);
        },
        null,
      ),
    );

    const busy = this.state === 'starting' || this.state === 'preparing' || this.state === 'failed';
    const nodes: Node[] = [this.ticketField()];
    const notices: Node[] = [];
    const options = this.host.store.hireOptions;

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
    nodes.push(
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
    );

    // The orchestrator itself.
    if (this.f.orch) {
      const o = this.f.orch;
      const p = this.preset()?.roles.orch;
      const same = !!p && p.harness === o.harness && p.model === o.model && p.effort === o.effort;
      const note = same ? h('span', { class: 'tape tape--note', title: 'The orchestrator of the chosen preset' }, 'Preset') : null;
      nodes.push(
        h(
          'div',
          { class: 'dd-agent', role: 'group', 'aria-label': 'Orchestrator' },
          h('p', { class: 'dd-agent-title' }, 'Orchestrator'),
          chips('orch-harness', 'Harness', Object.keys(options), o.harness, (v) => this.pickOrch({ harness: v }), note),
          chips('orch-model', 'Model', modelsFor(options, o.harness), o.model, (v) => this.pickOrch({ model: v })),
          chips('orch-effort', 'Effort', effortsFor(options, o.harness, o.model), o.effort, (v) => this.pickOrch({ effort: v })),
        ),
      );
    } else nodes.push(h('div', { class: 'dd-skeleton', 'aria-hidden': 'true' }, h('i'), h('i')));

    const extra = h('textarea', { id: 'run-extra', 'data-key': 'extra', rows: 2, spellcheck: 'true', placeholder: 'Anything the orchestrator should know: scope, constraints, taste' });
    extra.value = this.f.extra;
    extra.addEventListener('input', () => {
      this.f.extra = extra.value;
      this.schedule();
    });
    const label = h('input', { id: 'run-label', 'data-key': 'label', autocomplete: 'off', spellcheck: 'false', maxlength: 64, placeholder: this.prep?.label || 'ORCH|…' });
    label.value = this.f.label;
    label.addEventListener('input', () => {
      this.f.label = label.value;
      this.renderActions();
    });
    nodes.push(
      h('div', { class: 'dd-field' }, h('label', { for: 'run-extra' }, 'Extra instructions ', h('span', { class: 'dd-optional' }, 'optional')), extra),
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
          h('p', { class: 'dd-base', id: 'run-worktree-base' }, !g.usable ? 'Off: origin could not be fetched. Last fetched ' : on ? 'A new h3d/… branch from ' : 'Would branch from ', h('code', {}, g.base)),
        ),
      );
      if (g.note)
        notices.push(
          h(
            'div',
            { class: 'dd-callout dd-callout--error dd-fetch', role: 'alert' },
            h('p', {}, g.note.replace('hire without one', 'start without one')),
            h('button', { class: 'btn btn--sm', 'data-key': 'refetch', disabled: this.state !== 'ready', onclick: () => void this.prepare() }, 'Fetch again'),
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
    this.form.replaceChildren(...nodes);
    this.notices.replaceChildren(...notices);
    for (const el of this.form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea, button')) {
      // The ticket and the texts stay typeable while the bridge answers; the rest waits for it.
      const typeable = el.id === 'run-ticket' || el.id === 'run-extra' || el.id === 'run-label';
      // The presets stay reachable unless a start is on its way (on an older bridge the panel says why they are off).
      if (el.dataset.key === 'presets' ? this.state === 'starting' : (busy && !typeable) || this.state === 'starting' || this.state === 'failed') el.disabled = true;
    }
    this.renderLive();
    if (focusKey) {
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
    const ta = h('textarea', { id: 'run-prompt', 'data-key': 'prompt', class: 'dd-prompt', rows: 9, spellcheck: 'false', 'aria-describedby': 'run-prompt-note', placeholder: 'The first prompt appears here once there is a ticket.' });
    ta.value = this.preview.text;
    ta.addEventListener('input', () => {
      this.preview = previewEdited(this.preview, ta.value);
      this.renderPreviewState();
      this.renderActions();
    });
    const reset = h('button', { class: 'btn btn--sm', 'data-key': 'reset-prompt', onclick: () => this.resetPrompt() }, 'Reset to generated');
    return h(
      'div',
      { class: 'dd-field dd-preview' },
      h('div', { class: 'dd-preview-head' }, h('label', { for: 'run-prompt' }, 'First prompt'), h('span', { class: 'tape dd-preview-tape' }), reset),
      h('div', { class: 'dd-slip' }, ta),
      h('p', { class: 'field-hint', id: 'run-prompt-note' }),
    );
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
    const ta = this.dialog.querySelector<HTMLTextAreaElement>('#run-prompt');
    // A custom prompt is what the user typed: only a generated one follows the bridge.
    if (ta && !this.preview.custom && ta.value !== this.preview.text) ta.value = this.preview.text;
    const label = this.dialog.querySelector<HTMLInputElement>('#run-label');
    if (label && this.prep) label.placeholder = this.prep.label || 'ORCH|…';
    this.renderPreviewState();
    this.renderActions();
  }

  private renderPreviewState(): void {
    const tape = this.dialog.querySelector<HTMLElement>('.dd-preview-tape');
    const note = this.dialog.querySelector<HTMLElement>('#run-prompt-note');
    const reset = this.dialog.querySelector<HTMLButtonElement>('[data-key="reset-prompt"]');
    const wrap = this.dialog.querySelector<HTMLElement>('.dd-preview');
    if (!tape || !note || !reset || !wrap) return;
    const p = this.preview;
    const waiting = this.timer !== null || this.inFlight;
    const stale = previewStale(p);
    wrap.dataset.state = p.custom ? 'custom' : 'generated';
    tape.textContent = p.custom ? 'Edited' : waiting && this.prep ? 'Updating…' : 'Generated';
    tape.classList.toggle('tape--note', p.custom);
    reset.hidden = !p.custom;
    reset.disabled = this.state === 'starting';
    note.textContent = p.custom
      ? stale
        ? 'Your edit is kept: the fields above now make a different prompt. Start sends yours as it is.'
        : 'Your edit is kept and sent as it is.'
      : 'Made from the fields above. Edit it to send your own.';
    note.dataset.stale = stale ? 'true' : 'false';
  }

  private capacityBlock(): HTMLElement {
    const c = this.capacity() as CapacityView;
    const p = this.prep as RunPrepare;
    const facts = `${this.session}: ${p.capacity.floor.count} of ${p.capacity.floor.soft} · host: ${p.capacity.host.count} of ${p.capacity.host.soft}${c.load ? ` · ${c.load}` : ''}`;
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
      { class: 'btn btn--primary', 'data-key': 'start', 'aria-disabled': blocker ? 'true' : null, title: blocker ?? 'Start the run (Ctrl+Enter)', onclick: () => void this.start() },
      this.state === 'starting' ? 'Starting…' : 'Start run',
    );
    const had = document.activeElement === this.startBtn;
    this.startBtn = start;
    const retry = this.state === 'failed' && !runUnsupported(this.host) ? h('button', { class: 'btn', 'data-key': 'retry', onclick: () => this.retry() }, 'Try again') : null;
    this.actions.replaceChildren(...[retry, cancel, start].filter((x): x is HTMLButtonElement => !!x));
    if (had) start.focus();
  }

  // ---- actions --------------------------------------------------------------------------

  private retry(): void {
    this.state = 'preparing';
    this.setStatus('Asking herdr-world for the team, the folder and origin…');
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

  private pickPreset(id: string): void {
    this.f.preset = id;
    const p = this.host.store.presets.get(id);
    if (p && !this.orchTouched) this.f.orch = resolveChoice(this.host.store.hireOptions, p.roles.orch);
    this.render();
    this.schedule();
  }

  private pickOrch(p: Partial<Hire>): void {
    const o = this.f.orch;
    const next = resolveChoice(this.host.store.hireOptions, { ...o, ...p });
    if (!next) return;
    this.f.orch = next;
    this.orchTouched = true;
    this.render();
    this.schedule();
  }

  private resetPrompt(): void {
    this.preview = previewReset(this.preview);
    const ta = this.dialog.querySelector<HTMLTextAreaElement>('#run-prompt');
    if (ta) {
      ta.value = this.preview.text;
      ta.focus();
    }
    this.renderPreviewState();
    this.renderActions();
  }

  private async start(): Promise<void> {
    if (this.state !== 'ready' || !this.prep) return;
    const blocker = this.blocker();
    if (blocker) {
      this.setStatus(blocker, true);
      this.renderActions();
      return;
    }
    this.clearTimer();
    const session = this.session;
    const desk = this.f.desk;
    const t = this.ticket();
    const args: CommandArgs['run.start'] = startArgs(session, this.f, t, this.preview, this.prep, worktreeUsable(this.prep.git));
    const who = args.label ?? this.prep.label;
    this.state = 'starting';
    const release = this.host.reserve(session, desk);
    const steps = [args.worktree ? 'creating the worktree' : null, `starting ${args.orch.harness}`, 'handing over the prompt'].filter(Boolean);
    this.setStatus(`Starting ${who}: ${steps.join(', ')}…`);
    this.render();
    const gen = this.gen;
    const r = await this.host.send('run.start', args);
    release();
    const still = this.dialog.open && gen === this.gen;
    if (still) this.state = 'ready';
    if (r.ok) {
      const ack = r.data as RunStartAck | undefined;
      const w = ack?.id ? this.host.store.workerView(ack.id) : null;
      const name = w?.name ?? who;
      const on = t.kind === 'issue' ? ` on #${t.number}` : t.kind === 'work_item' ? ` on ${t.item.key}` : '';
      const extra = ack?.prompted === false ? ` The prompt was not sent (${ack.prompt_error ?? 'no reason given'}): prompt them yourself (P).` : '';
      if (still) this.close();
      this.host.toast(`Started a run${on}: ${name} takes Desk ${(w?.desk ?? desk) + 1}. Here they come.${extra}`, extra ? 'error' : 'info');
      if (ack?.id) this.host.started(ack.id, t.kind === 'work_item' ? { provider: t.item.provider, id: t.item.id } : undefined);
      return;
    }
    const msg = r.code === 'not_found' ? 'That team preset was deleted meanwhile: pick another one.' : failureText('run.start', r.code, r.message, { floor: session, desk: desk + 1 }).replace('hire without a worktree', 'start without one');
    if (!still) {
      this.host.toast(msg, 'error');
      return;
    }
    this.setStatus(msg, true);
    this.render();
    if (r.code === 'capacity' || r.code === 'fetch_failed') void this.prepare();
  }

  // ---- test hook ------------------------------------------------------------------------

  summary(): StartRunSummary | null {
    if (!this.dialog.open) return null;
    const t = this.ticket();
    return {
      kind: 'start-run',
      session: this.session,
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
      git: this.prep ? this.gitView(this.prep.git) : null,
      capacity: this.capacity(),
      blocker: this.blocker(),
      status: this.statusText,
      error: this.statusError,
    };
  }
}

function blankForm(): RunForm {
  return { ticket: '', desk: 0, preset: '', orch: null, extra: '', worktree: true, label: '', workItem: null };
}
