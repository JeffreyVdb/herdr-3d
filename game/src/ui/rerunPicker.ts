import './rerun.css';
import type { HireOptions } from '../net/protocol';
import type { WorldStore } from '../world/store';
import { HARNESS_LABEL, resolveChoice, modelsFor, visibleOptions } from '../world/hire';
import { labelsOf, modelEntries, modelLabel } from '../world/modelLabel';
import { effortsFor } from '../world/settings';
import { h } from './dom';
import { duotone } from './duotone';
import { chips, type HirePrefill } from './hire';

/**
 * Run elsewhere: a message you wrote to a worker, sent as a new worker's first task on another harness or model. The
 * picker asks only the harness, model and effort (the other harness first); Hire hands the rest to the Hire dialog with
 * `go`, which checks the floor, reviews the task's secrets and hires as a pressed Hire does, over the seat. Nothing else
 * of the conversation goes with it: a later message says so.
 */

/** What the conversation hands over: the worker, the message's full text, whether it is the conversation's first. */
export interface RerunRequest {
  worker: string;
  text: string;
  first: boolean;
  /** The element to sit under (the message's button); null: the middle of the window. */
  anchor: HTMLElement | null;
  /** The message has images: only its text goes (the picker says so). */
  images?: boolean;
}

export interface RerunPickerHost {
  store: WorldStore;
  /** Settings → Harness models (none: every model shows). */
  modelPrefs?: { hidden(harness: string): ReadonlySet<string> } | null;
  /** The desk the new worker would take on `floor`, or why there is none. */
  desk(floor: string): { desk: number } | { why: string };
  /** Opens the Hire dialog over the seat with `prefill`. */
  hire(floor: string, desk: number, prefill: HirePrefill): void;
}

type Choice = { harness: string; model: string; effort: string };

/**
 * The choice the picker starts on: the first harness of the catalog other than the worker's, at its floor-agnostic
 * default (an effort the worker had when that model takes it); the worker's own harness when it is the only one.
 */
export function startChoice(options: HireOptions, was: { harness?: string | undefined; model?: string | undefined; effort?: string | undefined }): Choice | null {
  const other = Object.keys(options).find((k) => k !== was.harness && modelsFor(options, k).length > 0);
  const want: Partial<Choice> = { harness: other ?? was.harness ?? '' };
  if (!other && was.model) want.model = was.model;
  if (was.effort) want.effort = was.effort;
  return resolveChoice(options, want);
}

export class RerunPicker {
  readonly dialog = h('dialog', { class: 'rerun-pick', 'aria-labelledby': 'rerun-title' });
  private req: RerunRequest | null = null;
  private floor = '';
  private choice: Choice | null = null;

  constructor(
    layer: HTMLElement,
    private readonly host: RerunPickerHost,
  ) {
    this.dialog.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest('button')) return; // a focused button is pressed as itself
      e.preventDefault();
      this.go(true);
    });
    // A click on the backdrop (outside the box) closes it, as Esc does.
    this.dialog.addEventListener('mousedown', (e) => {
      if (e.target === this.dialog) this.close();
    });
    layer.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  /** It opens from a seat and leaves you there. */
  get keepsSeat(): boolean {
    return this.dialog.open;
  }

  open(req: RerunRequest): boolean {
    const w = this.host.store.workerView(req.worker);
    if (!w || !req.text.trim()) return false;
    this.req = req;
    this.floor = w.worker.floor;
    this.choice = startChoice(this.options(), { harness: w.harness ?? w.worker.harness, model: w.worker.model, effort: w.worker.effort });
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.place();
    this.dialog.querySelector<HTMLElement>('[data-key="rerun-hire"]')?.focus();
    return true;
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
    this.req = null;
  }

  private options(): HireOptions {
    const cat = this.host.store.hireOptions;
    const prefs = this.host.modelPrefs;
    return prefs ? visibleOptions(cat, (harness) => prefs.hidden(harness)) : cat;
  }

  /** Under the anchor, its right edges lined up, kept inside the window; above it when there is no room below. */
  private place(): void {
    const a = this.req?.anchor;
    const d = this.dialog;
    if (!a?.isConnected) {
      d.style.removeProperty('left');
      d.style.removeProperty('top');
      d.dataset.placed = 'false';
      return;
    }
    const r = a.getBoundingClientRect();
    const box = d.getBoundingClientRect();
    const pad = 12;
    const left = Math.min(Math.max(pad, r.right - box.width), window.innerWidth - box.width - pad);
    const below = r.bottom + 8;
    const top = below + box.height + pad <= window.innerHeight ? below : Math.max(pad, r.top - box.height - 8);
    d.style.left = `${Math.round(left)}px`;
    d.style.top = `${Math.round(top)}px`;
    d.dataset.placed = 'true';
  }

  private render(): void {
    const req = this.req;
    const w = req ? this.host.store.workerView(req.worker) : null;
    if (!req || !w) return;
    const options = this.options();
    const c = this.choice;
    const labels = c ? labelsOf(this.host.store.hireOptions, c.harness) : undefined;
    const harness = w.harness ?? w.worker.harness ?? '';
    const now = [HARNESS_LABEL[harness] ?? harness, w.worker.model ? modelLabel(harness, w.worker.model, labelsOf(this.host.store.hireOptions, harness)) : '', w.worker.effort ?? '']
      .filter(Boolean)
      .join(' · ');
    const pick = (next: Partial<Choice>) => {
      this.choice = resolveChoice(options, { ...this.choice, ...next });
      this.render();
      this.dialog.querySelector<HTMLInputElement>(`[data-pick="${Object.keys(next)[0]}"] input:checked`)?.focus();
    };
    const seat = this.host.desk(this.floor);
    const where = 'why' in seat ? seat.why : `Desk ${seat.desk + 1}, the free desk nearest you · its own worktree when the folder is a git checkout.`;
    const cwd = w.worker.worktree?.repo_root ?? w.worker.cwd ?? '';
    const blocked = !c || 'why' in seat;
    this.dialog.replaceChildren(
      h(
        'div',
        { class: 'rerun-body' },
        h('h2', { id: 'rerun-title' }, req.first ? `Run ${w.name}’s first message elsewhere` : 'Run this message elsewhere'),
        h(
          'p',
          { class: 'rerun-sub' },
          req.first ? 'It becomes a new worker’s first task. Nothing else from this conversation goes with it.' : 'Only this message goes, as a new worker’s first task: the turns before it stay here.',
        ),
        now ? h('p', { class: 'rerun-now' }, `${w.name} runs ${now}.`) : null,
        req.images ? h('p', { class: 'rerun-where', 'data-error': 'true' }, 'An image in this message is not text: only the words go. Edit first to add it again.') : null,
        c
          ? h(
              'div',
              { class: 'rerun-picks' },
              chips('rerun-harness', 'Harness', Object.keys(options), c.harness, (v) => pick({ harness: v, model: '' })),
              chips('rerun-model', 'Model', modelsFor(options, c.harness), c.model, (v) => pick({ model: v }), null, modelEntries(c.harness, modelsFor(options, c.harness), labels)),
              chips('rerun-effort', 'Effort', effortsFor(options, c.harness, c.model), c.effort, (v) => pick({ effort: v })),
            )
          : h('p', { class: 'rerun-where', 'data-error': 'true' }, 'This bridge offers no model to hire on.'),
        h('p', { class: 'rerun-where', 'data-error': String('why' in seat) }, where),
        cwd ? h('p', { class: 'rerun-cwd', title: cwd }, cwd) : null,
      ),
      h(
        'div',
        { class: 'rerun-actions' },
        h('button', { type: 'button', class: 'btn rerun-edit', 'data-key': 'rerun-edit', disabled: blocked, onclick: () => this.go(false) }, 'Edit first…'),
        h('button', { type: 'button', class: 'btn', 'data-key': 'rerun-cancel', onclick: () => this.close() }, 'Cancel'),
        h(
          'button',
          { type: 'button', class: 'btn btn--primary', 'data-key': 'rerun-hire', disabled: blocked, onclick: () => this.go(true) },
          duotone('fork'),
          c ? `Hire on ${modelLabel(c.harness, c.model, labels)}` : 'Hire',
          h('kbd', {}, 'Enter'),
        ),
      ),
    );
    if (this.dialog.open) this.place();
  }

  /** Hire (`go`) or Edit first: the Hire dialog takes over at the desk, with the message, the choice and the folder. */
  private go(go: boolean): void {
    const req = this.req;
    const c = this.choice;
    const w = req ? this.host.store.workerView(req.worker) : null;
    if (!req || !c || !w) return;
    const seat = this.host.desk(this.floor);
    if ('why' in seat) return;
    const cwd = w.worker.worktree?.repo_root ?? w.worker.cwd;
    const prefill: HirePrefill = { prompt: req.text, choice: c, worktree: true, seated: true, rerunOf: req.worker, ...(cwd ? { cwd } : {}), ...(go ? { go: true } : {}) };
    const floor = this.floor;
    this.close();
    this.host.hire(floor, seat.desk, prefill);
  }
}
