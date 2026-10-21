import './hirePresets.css';
import type { CommandResult } from '../net/client';
import type { HireOptions, HirePreset, HirePresetCheckAck } from '../net/protocol';
import { modelsFor, offeredOptions, resolveVisibleChoice } from '../world/hire';
import { draftBlocker, draftFrom, exactProblem, nudgeWanted, pickExact, presetChoiceText, presetSpec, promptPreview, type ExactProblem, type HirePresetDraft } from '../world/hirePresets';
import { labelsOf } from '../world/modelLabel';
import { effortsFor } from '../world/settings';
import { backdropPolicy } from './dismiss';
import { deskTabs, PIN_ICON, pinIdOf, PRESET_ICON } from './deskTabs';
import { h, icon, ICON, replaceKeepingFocus } from './dom';
import { chips, modelField, type DialogHost, type HirePresetSeed } from './hire';
import type { HireModelPrefs } from './hireModelPrefs';
import { deskPins, type HirePins } from './hirePins';
import { failureText } from './messages';
import { onReviewKey, reviewButton, type Go } from './secretsFlow';

/**
 * #93 hire presets: the "Hire preset" tab of an empty desk's dialog. It lists the floor's own presets and the global
 * ones (name, model and effort, the prompt's start); Use opens the ordinary hire form with the preset's prompt and exact
 * choice, ready to review and Hire. New, Edit and Delete (confirmed) manage them, live with every client's changes. The
 * editor also opens on its own over the hire form ("Save as preset…"); then Back and Save return to that form. A modal
 * like the M4 dialogs; Esc in the editor goes back to the list (or to the form it came from), Esc in the list closes.
 *
 * #95: the editor's "Add herdr hiring instructions" box, on a bridge that adds them (an older one: a hint to update it).
 * With the box off, Save first asks the classifier (`hire_preset.check`; Use never does, and Hire worker asks on a plain form only, #117) whether the prompt hands
 * work to other agents; when it does, the editor asks in place (Turn on and save / Save as is; Esc back to the editor).
 * The box is only ever ticked by a click, and anything but a "yes" in time saves the preset as it is.
 *
 * Pins: a row's Pin puts the preset on the desk dialogs' tab bar, after the fixed tabs, in this browser (ui/hirePins.ts);
 * its tab hires with it as Use does (`usePinned`, asking before a desk's unsent task goes). The pins are dragged, or moved
 * by Shift+← / Shift+→, to another place in the bar.
 */

/** #95: the copy of the editor's box, its hint, and what an older bridge says instead. */
export const INSTRUCTIONS_LABEL = 'Add herdr hiring instructions';
export const INSTRUCTIONS_HINT = 'Adds two lines when the preset is used: each agent it starts gets its own herdr workspace or tab, tagged with the floor it’s used on.';
export const INSTRUCTIONS_OLD_BRIDGE = 'This herdr-world can’t add hiring instructions yet. Update the bridge to use it.';
export const NUDGE_TEXT = 'This task starts other agents (workers or subagents). Add herdr hiring instructions so they get their own workspace on the floor it’s used on?';

export interface HirePresetsHost extends DialogHost {
  /** Settings → Harness models: the editor offers the models it leaves shown, plus the preset's own (absent: every model). */
  modelPrefs?: HireModelPrefs;
  /** The presets pinned to the desk dialogs' tab bar (absent: no Pin buttons and no pinned tabs). */
  pins?: HirePins;
  /** A pinned tab of this dialog's bar: the app's way, this dialog's `usePinned` and the focus after it (absent: `usePinned` alone). */
  usePinned?(floor: string, desk: number, id: string): void;
  /** The Worker tab: the hire dialog for the same desk. */
  hireAt(floor: string, desk: number): void;
  /** The Orchestrator tab (absent: none): why it is off, and the start-run dialog for the same desk. */
  orchestrate?: { off(): string | null; open(floor: string, desk: number): void };
  /** Use: the hire dialog for the desk with the preset's prompt and exact choice; `replace`: the desk's unsent task goes. */
  use(floor: string, desk: number, p: HirePreset, replace: boolean): void;
  /** The desk's unsent first task in the hire dialog (null: none). */
  unsent(floor: string, desk: number): { text: string; images: number } | null;
}

type EditView = {
  kind: 'edit';
  id: string | null;
  draft: HirePresetDraft;
  error: { field: 'name' | 'prompt' | 'choice'; why: string } | null;
  saving: boolean;
  /** The preset as the editor opened (or last loaded) it: a newer one in the store is a change made elsewhere. */
  seen: HirePreset | null;
  /** What the editor says it left out of the form it came from ("Save as preset…": its images). */
  note: string | null;
  /** #95: the classifier said the prompt hands work to other agents: the editor asks to tick the box before saving. */
  nudge: boolean;
  /** #95: the prompt "Save as is" was answered for: no asking again until the prompt changes. */
  dismissed: string | null;
  /** #108 round 4: the stored review of the prompt this Save is for (the check and the save both carry it). */
  reviewed?: { text: string; go: Go } | undefined;
};
type View = { kind: 'list'; confirm: string | null; replacing: string | null } | EditView;

/** One preset as the list shows it (test hook). */
export interface HirePresetRow {
  id: string;
  name: string;
  choice: string;
  preview: string;
  problem: ExactProblem | null;
  /** On the desk dialogs' tab bar. */
  pinned: boolean;
}

/** What the dialog shows (test hook). */
export interface HirePresetsSummary {
  kind: 'hire-presets';
  /** `busy` while a save or a delete is on its way. */
  state: 'ready' | 'busy';
  view: 'list' | 'edit';
  floor: string;
  /** The desk the list is for (null: the editor opened on its own, over the hire form). */
  desk: number | null;
  /** Why hire presets cannot be used on this bridge, null when they can. */
  off: string | null;
  groups: { floor: HirePresetRow[]; global: HirePresetRow[] };
  /** The ids of the pinned tabs this floor's tab bar shows, in order. */
  pins: string[];
  confirm: string | null;
  replacing: string | null;
  editing: { id: string | null; draft: HirePresetDraft; error: EditView['error']; saving: boolean; stale: 'changed' | 'deleted' | null; problem: ExactProblem | null; nudge: boolean } | null;
  /** #95: the bridge adds the herdr hiring instructions (the editor shows the box; false: the update hint). */
  instructions: boolean;
  status: string;
  error: boolean;
}

const DESK_PLUS = '<path d="M12 5v14M5 12h14"/>';

export class HirePresetsDialog {
  private readonly dialog = h('dialog', { class: 'desk-dlg desk-dlg--hire-presets', 'aria-labelledby': 'hp-title', 'aria-describedby': 'hp-sub' });
  private readonly head = h('header', { class: 'dd-head' });
  private readonly tabs = h('div', { class: 'dd-tabs-slot' });
  private readonly body = h('form', { class: 'dd-body', id: 'hp-form', novalidate: true });
  private readonly statusEl = h('p', { class: 'dd-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private readonly actions = h('div', { class: 'dd-actions' });
  private readonly foot = h('footer', { class: 'dd-foot' }, this.statusEl, this.alertEl, this.actions);
  private view: View = { kind: 'list', confirm: null, replacing: null };
  private floor = '';
  /** The desk of the list (null: the editor on its own, over the hire form). */
  private desk: number | null = null;
  private statusText = '';
  private statusError = false;
  private returnTo: HTMLElement | null = null;
  private returnScope: ParentNode | null = null;
  private seenVersion = -1;
  private busy = false;
  /** Counts the openings (open, create): a reply for an earlier one has no say in this one. */
  private opening = 0;
  /** The editor's model filter (a long list); a harness switch clears it. */
  private modelQuery = '';
  /** #95: per preset id, the prompt "Save as is" was answered for and saved with: its editors don't ask again for it. */
  private readonly declined = new Map<string, string>();

  constructor(
    parent: HTMLElement,
    private readonly host: HirePresetsHost,
  ) {
    this.alertEl.hidden = true;
    this.statusEl.hidden = true;
    this.dialog.append(this.head, this.tabs, this.body, this.foot);
    this.dialog.addEventListener('cancel', (e) => {
      // Esc: a pending confirmation or the editor of the list first, then the dialog.
      const v = this.view;
      if (v.kind === 'edit' && v.nudge) {
        // #95: the question first, back to the editor without saving (an editor over the hire form too).
        e.preventDefault();
        v.nudge = false;
        this.render();
        this.dialog.querySelector<HTMLElement>('#hp-instructions')?.focus();
      } else if (v.kind === 'edit' && this.desk !== null) {
        e.preventDefault();
        this.toList(v.id);
      } else if (v.kind === 'list' && (v.confirm || v.replacing)) {
        e.preventDefault();
        this.toList(v.confirm ?? v.replacing);
      }
    });
    this.dialog.addEventListener('close', () => {
      const back = this.returnTo;
      this.returnTo = null;
      if (!back) return;
      // The opener (the hire form's "Save as preset…") may have re-rendered meanwhile: its twin by data-key.
      const twin = back.isConnected ? back : back.dataset.key ? this.returnScope?.querySelector<HTMLElement>(`[data-key="${CSS.escape(back.dataset.key)}"]`) : null;
      twin?.focus();
    });
    // Typed text in here: only the close button and Esc close it, never the backdrop.
    backdropPolicy(this.dialog, 'none');
    this.body.addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.view.kind === 'edit') void this.save();
    });
    // #108: the prompt's review on purpose (Ctrl/⌘+Shift+X, with the switch on); the switch shows or hides its button.
    onReviewKey(this.body, () => this.host.secrets, () => {
      if (this.view.kind === 'edit') void this.save(true);
    });
    this.host.secrets?.onChange(() => {
      if (this.dialog.open) this.render();
    });
    this.host.modelPrefs?.onChange(() => {
      if (this.dialog.open) this.render();
    });
    this.host.pins?.onChange(() => {
      if (this.dialog.open) this.render();
    });
    parent.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  /** A desk tab handed over: focus on this dialog's Preset tab, as in one tab list. */
  focusTab(): void {
    this.dialog.querySelector<HTMLElement>('[data-key="tab:preset"]')?.focus();
  }

  /** The "Hire preset" tab of a desk: the floor's and the global presets. */
  open(floor: string, desk: number): void {
    this.floor = floor;
    this.desk = desk;
    this.returnTo = null;
    this.opening++;
    this.view = { kind: 'list', confirm: null, replacing: null };
    this.setStatus('');
    this.busy = false;
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.focusFirst();
  }

  /** "Save as preset…": the editor over the hire form, with its prompt and choice; focus goes back to `from`. */
  create(seed: HirePresetSeed, from: HTMLElement | null = null): void {
    this.floor = seed.floor;
    this.desk = null;
    this.returnTo = from;
    this.returnScope = from?.closest('dialog') ?? document;
    this.opening++;
    this.busy = false;
    const note = seed.imagesLeftOut ? `The ${seed.imagesLeftOut === 1 ? 'image' : `${seed.imagesLeftOut} images`} of the first task ${seed.imagesLeftOut === 1 ? 'is' : 'are'} not saved: a preset keeps text only.` : null;
    this.edit(null, { name: '', prompt: seed.prompt, harness: seed.harness, model: seed.model, effort: seed.effort, scope: 'floor', instructions: seed.instructions === true }, note);
    if (!this.dialog.open) this.dialog.showModal();
    this.focusEditor();
  }

  /**
   * A pinned preset's tab: the hire form for the desk with its prompt and exact choice, as Use. A desk with an unsent
   * first task opens the list instead, asking before it goes (Keep my task / Replace it).
   */
  usePinned(floor: string, desk: number, id: string): void {
    const p = this.host.store.hirePresets.get(id);
    if (!p) {
      this.host.toast('That hire preset is gone.', 'info');
      return;
    }
    if (!this.host.unsent(floor, desk)) {
      this.close();
      this.host.use(floor, desk, structuredClone(p), false);
      return;
    }
    this.open(floor, desk);
    this.use(p, false);
  }

  private off(): string | null {
    const b = this.host.store.hirePresets;
    if (!b.known || this.host.unsupported('hire_preset.create') || this.host.unsupported('hire_preset.update') || this.host.unsupported('hire_preset.delete')) return failureText('hire_preset.create', 'unknown_command', '');
    return null;
  }

  /** The world changed: a preset here or elsewhere (the list follows; an open editor says so), or the floor went. */
  refresh(): void {
    if (!this.dialog.open) return;
    if (!this.host.store.floorView(this.floor)) {
      this.close();
      this.host.toast(`${this.host.store.floorName(this.floor)} is gone.`, 'info');
      return;
    }
    const version = this.host.store.hirePresets.version;
    if (version === this.seenVersion) return;
    const v = this.view;
    if (v.kind === 'list' && v.confirm && !this.host.store.hirePresets.get(v.confirm)) v.confirm = null;
    if (v.kind === 'list' && v.replacing && !this.host.store.hirePresets.get(v.replacing)) v.replacing = null;
    this.render();
  }

  /** The catalog the editor's pickers offer: the models Settings leaves shown, plus the preset's saved one. */
  private options(seen: HirePreset | null): HireOptions {
    const prefs = this.host.modelPrefs;
    return offeredOptions(this.host.store.hireOptions, prefs && ((harness) => prefs.hidden(harness)), [seen]);
  }

  private setStatus(msg: string, error = false): void {
    this.statusText = msg;
    this.statusError = error && !!msg;
    this.alertEl.hidden = !error || !msg;
    this.statusEl.hidden = error || !msg;
    (error ? this.alertEl : this.statusEl).textContent = msg;
    (error ? this.statusEl : this.alertEl).textContent = '';
  }

  private floorName(): string {
    return this.host.store.floorName(this.floor);
  }

  /** A preset as the list shows it. */
  private row(p: HirePreset): HirePresetRow {
    const cat = this.host.store.hireOptions;
    return { id: p.id, name: p.name, choice: presetChoiceText(cat, p), preview: promptPreview(p.prompt), problem: exactProblem(cat, p), pinned: this.host.pins?.has(p.id) === true };
  }

  /** An editor's preset changed or went elsewhere since it was opened. */
  private stale(v: EditView): 'changed' | 'deleted' | null {
    if (!v.id) return null;
    const now = this.host.store.hirePresets.get(v.id);
    if (!now) return 'deleted';
    return v.seen && now.updated_at !== v.seen.updated_at ? 'changed' : null;
  }

  // ---- rendering ---------------------------------------------------------------------

  private render(): void {
    this.seenVersion = this.host.store.hirePresets.version;
    const v = this.view;
    const editing = v.kind === 'edit';
    const back = editing && this.desk !== null;
    const title = !editing ? `Hire a preset at Desk ${(this.desk ?? 0) + 1}` : v.id ? `Edit “${v.seen?.name ?? v.draft.name}”` : 'New hire preset';
    const fv = this.host.store.floorView(this.floor);
    const where = fv?.level ? `Floor ${fv.level.number} of ${fv.level.count} · ${fv.building?.name ?? ''}` : 'Unassigned lot';
    const plate = editing
      ? h('div', { class: 'dd-plate dd-plate--preset', 'aria-hidden': 'true' }, icon(PRESET_ICON))
      : h('div', { class: 'dd-plate dd-plate--desk', 'aria-hidden': 'true' }, icon(DESK_PLUS), h('b', {}, String((this.desk ?? 0) + 1)));
    // Header and tabs keep focus across a live re-render, as the body and the actions do.
    replaceKeepingFocus(
      this.head,
      [
        ...(back ? [h('button', { class: 'btn btn--icon', 'data-key': 'back', 'aria-label': 'Back to the presets', title: 'Back to the presets (Esc)', onclick: () => this.toList(v.id) }, icon(ICON.back))] : []),
        plate,
        h('div', { class: 'dd-titles' }, h('h2', { id: 'hp-title' }, title), h('p', { id: 'hp-sub' }, editing ? 'A first task and the model to hire it with' : `${this.floorName()} · ${where}`)),
        h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close)),
      ],
      'close',
    );
    // The desk's tabs, while the list is for a desk.
    this.tabs.hidden = editing || this.desk === null;
    if (!this.tabs.hidden) {
      const orch = this.host.orchestrate;
      replaceKeepingFocus(this.tabs, [
        deskTabs(
          'preset',
          (t) => {
            const { floor, desk } = this;
            if (desk === null) return;
            const pin = pinIdOf(t);
            // Through the host when it has the app's (the hire form's pinned tab takes the focus, as from the other dialogs).
            if (pin !== null) return this.host.usePinned ? this.host.usePinned(floor, desk, pin) : this.usePinned(floor, desk, pin);
            this.close();
            if (t === 'orch') orch?.open(floor, desk);
            else this.host.hireAt(floor, desk);
          },
          orch ? orch.off() : false,
          true,
          deskPins(this.host.pins, this.host.store.hirePresets, this.host.store.hireOptions, this.floor),
        ),
      ]);
    }
    if (v.kind === 'list') this.renderList(v);
    else this.renderEdit(v);
  }

  private renderList(v: Extract<View, { kind: 'list' }>): void {
    const off = this.off();
    const nodes: Node[] = [];
    if (off) {
      nodes.push(h('div', { class: 'dd-callout', role: 'note', 'data-hook': 'hp-off' }, h('p', {}, off), h('p', { class: 'field-hint' }, 'Hire worker and Hire orchestrator work as before.')));
    } else {
      const { floor, global } = this.host.store.hirePresets.forFloor(this.floor);
      if (!floor.length && !global.length)
        nodes.push(
          h(
            'div',
            { class: 'hp-empty', 'data-hook': 'hp-empty' },
            h('p', {}, 'No hire presets yet.'),
            h('p', { class: 'field-hint' }, 'Save a first task with the model to hire it with, then hire it again from here whenever the job comes back.'),
            h('button', { type: 'button', class: 'btn btn--sm', 'data-key': 'empty-new', onclick: () => this.edit(null) }, icon(ICON.plus), h('span', {}, 'New preset')),
          ),
        );
      else {
        nodes.push(this.group('floor', 'This floor', `Only on ${this.floorName()}`, floor, 'None on this floor yet.', v));
        nodes.push(this.group('global', 'Global', 'On every floor of every building', global, 'No global presets yet.', v));
      }
    }
    replaceKeepingFocus(this.body, nodes, 'new');
    const close = h('button', { type: 'button', class: 'btn', 'data-key': 'done', onclick: () => this.close() }, 'Close');
    const add = h('button', { type: 'button', class: 'btn btn--primary', 'data-key': 'new', 'aria-disabled': off ? 'true' : null, title: off ?? 'Create a hire preset', onclick: () => !off && this.edit(null) }, icon(ICON.plus), h('span', {}, 'New preset'));
    replaceKeepingFocus(this.actions, [close, add]);
  }

  private group(key: 'floor' | 'global', heading: string, sub: string, list: HirePreset[], empty: string, v: Extract<View, { kind: 'list' }>): HTMLElement {
    const id = `hp-group-${key}`;
    const ul = h('ul', { class: 'pp-list hp-list', 'aria-labelledby': id });
    for (const p of list) ul.append(this.presetRow(p, v));
    return h(
      'section',
      { class: 'hp-group', 'data-group': key },
      h('div', { class: 'hp-group-head' }, h('h3', { id }, heading), h('p', {}, sub)),
      list.length ? ul : h('p', { class: 'pp-empty hp-group-empty' }, empty),
    );
  }

  private presetRow(p: HirePreset, v: Extract<View, { kind: 'list' }>): HTMLElement {
    const r = this.row(p);
    const deleting = v.confirm === p.id;
    const replacing = v.replacing === p.id;
    const choice = r.problem
      ? h('span', { class: 'tape tape--cap-warn', title: r.problem.why }, 'Needs a new choice')
      : h('span', { class: 'hp-choice' }, r.choice);
    let tail: HTMLElement;
    if (deleting)
      tail = h(
        'div',
        { class: 'dd-callout dd-callout--error pp-confirm', role: 'alert' },
        h('p', {}, `Delete “${p.name}”? Workers hired with it keep working; a hire form already open with it keeps what it shows.`),
        h(
          'div',
          { class: 'pp-confirm-actions' },
          h('button', { type: 'button', class: 'btn btn--sm', 'data-key': `keep:${p.id}`, onclick: () => this.toList(p.id) }, 'Keep it'),
          h('button', { type: 'button', class: 'btn btn--sm btn--danger', 'data-key': `confirm-delete:${p.id}`, disabled: this.busy, 'aria-busy': this.busy ? 'true' : null, onclick: () => void this.remove(p) }, this.busy ? 'Deleting…' : 'Delete preset'),
        ),
      );
    else if (replacing) {
      const u = this.desk !== null ? this.host.unsent(this.floor, this.desk) : null;
      const what = u ? [u.text.trim() ? `“${promptPreview(u.text, 60)}”` : null, u.images ? `${u.images} ${u.images === 1 ? 'image' : 'images'}` : null].filter(Boolean).join(' and ') : '';
      tail = h(
        'div',
        { class: 'dd-callout pp-confirm', role: 'alert', 'data-hook': 'hp-replace' },
        h('p', {}, `Desk ${(this.desk ?? 0) + 1} has an unsent first task${what ? ` (${what})` : ''}. Using “${p.name}” replaces it with the preset’s prompt.`),
        h(
          'div',
          { class: 'pp-confirm-actions' },
          h('button', { type: 'button', class: 'btn btn--sm', 'data-key': `keep-task:${p.id}`, onclick: () => this.toList(p.id, 'use') }, 'Keep my task'),
          h('button', { type: 'button', class: 'btn btn--sm btn--primary', 'data-key': `replace:${p.id}`, onclick: () => this.use(p, true) }, 'Replace it'),
        ),
      );
    } else {
      const pins = this.host.pins;
      tail = h(
        'div',
        { class: 'pp-tools' },
        h('button', { type: 'button', class: 'btn btn--sm btn--primary', 'data-key': `use:${p.id}`, 'aria-label': `Use ${p.name}`, onclick: () => this.use(p, false) }, 'Use'),
        pins
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn--sm hp-pin',
                'data-key': `pin:${p.id}`,
                'aria-pressed': r.pinned ? 'true' : 'false',
                'aria-label': `Pin ${p.name} to the tabs`,
                title: r.pinned ? 'On the desk tabs: one click opens its hire form. Click to unpin.' : 'Put it on the desk tabs: one click opens its hire form',
                onclick: () => (r.pinned ? pins.unpin(p.id) : pins.pin(p.id)),
              },
              icon(PIN_ICON),
              h('span', {}, 'Pin'),
            )
          : null,
        h('button', { type: 'button', class: 'btn btn--sm', 'data-key': `edit:${p.id}`, 'aria-label': `Edit ${p.name}`, onclick: () => this.edit(p) }, icon(ICON.pencil), h('span', {}, 'Edit')),
        h('button', { type: 'button', class: 'btn btn--sm btn--danger-quiet', 'data-key': `delete:${p.id}`, 'aria-label': `Delete ${p.name}`, onclick: () => this.ask(p.id) }, icon(ICON.trash), h('span', {}, 'Delete')),
      );
    }
    return h(
      'li',
      { class: 'pp-row hp-row', 'data-id': p.id, 'data-confirm': deleting || replacing ? 'true' : null },
      h('div', { class: 'pp-row-head' }, h('h4', {}, p.name)),
      h('p', { class: 'hp-meta' }, choice),
      h('p', { class: 'hp-preview', title: p.prompt.length > r.preview.length ? p.prompt.slice(0, 600) : null }, r.preview),
      tail,
    );
  }

  private renderEdit(v: EditView): void {
    const options = this.options(v.seen);
    const d = v.draft;
    const name = h('input', { id: 'hp-name', 'data-key': 'name', autocomplete: 'off', spellcheck: 'false', maxlength: 40, placeholder: 'e.g. Deploy a release', 'aria-invalid': v.error?.field === 'name' ? 'true' : null, 'aria-describedby': 'hp-name-error' });
    name.value = d.name;
    name.disabled = v.saving;
    name.addEventListener('input', () => {
      d.name = name.value;
      this.clearError(v, 'name');
    });
    const prompt = h('textarea', { id: 'hp-prompt', 'data-key': 'prompt', rows: 7, spellcheck: 'true', placeholder: 'Deploy the release to A, B and C, and report each one.', 'aria-invalid': v.error?.field === 'prompt' ? 'true' : null, 'aria-describedby': 'hp-prompt-hint hp-prompt-error' });
    prompt.value = d.prompt;
    prompt.disabled = v.saving;
    prompt.addEventListener('input', () => {
      d.prompt = prompt.value;
      this.clearError(v, 'prompt');
    });
    const set = (p: Partial<Pick<HirePresetDraft, 'harness' | 'model' | 'effort'>>) => {
      if (p.harness !== undefined && p.harness !== d.harness) this.modelQuery = '';
      Object.assign(d, pickExact(options, d, p));
      if (v.error?.field === 'choice') v.error = null;
      this.render();
    };
    const models = modelsFor(options, d.harness);
    const problem = exactProblem(this.host.store.hireOptions, d);
    const choice: Node[] = [chips('preset-harness', 'Harness', Object.keys(options), d.harness, (x) => set({ harness: x }))];
    if (models.length) {
      choice.push(modelField(d.harness, models, d.model, labelsOf(options, d.harness), this.modelQuery, (x) => set({ model: x }), (q) => (this.modelQuery = q), 'preset-model'));
      choice.push(chips('preset-effort', 'Effort', effortsFor(options, d.harness, d.model), d.effort, (x) => set({ effort: x })));
    }
    const stale = this.stale(v);
    const nodes: Node[] = [];
    if (stale === 'deleted')
      nodes.push(h('div', { class: 'dd-callout dd-callout--error', role: 'alert', 'data-hook': 'hp-stale', 'data-stale': 'deleted' }, h('p', {}, `“${v.seen?.name ?? d.name}” was deleted elsewhere meanwhile. Save it as a new preset to keep it, or go back.`)));
    else if (stale === 'changed') {
      const now = this.host.store.hirePresets.get(v.id) as HirePreset;
      nodes.push(
        h(
          'div',
          { class: 'dd-callout', role: 'alert', 'data-hook': 'hp-stale', 'data-stale': 'changed' },
          h('p', {}, `“${now.name}” changed elsewhere meanwhile. Saving replaces that change with what you see here.`),
          h('button', { type: 'button', class: 'btn btn--sm', 'data-key': 'reload', onclick: () => this.reload(v) }, 'Load the saved version'),
        ),
      );
    }
    if (v.note) nodes.push(h('p', { class: 'dd-callout hp-note', role: 'note' }, v.note));
    const scope = this.scopeField(v);
    nodes.push(
      h('div', { class: 'dd-field' }, h('label', { for: 'hp-name' }, 'Name'), name, h('p', { class: 'field-hint dd-field-error', id: 'hp-name-error', role: 'alert' }, v.error?.field === 'name' ? v.error.why : '')),
      h(
        'div',
        { class: 'dd-field' },
        h('label', { for: 'hp-prompt' }, 'First task'),
        prompt,
        h('p', { class: 'field-hint', id: 'hp-prompt-hint' }, 'What the worker starts on, every time this preset is hired. Up to 32 KiB.'),
        h('p', { class: 'field-hint dd-field-error', id: 'hp-prompt-error', role: 'alert' }, v.error?.field === 'prompt' ? v.error.why : ''),
      ),
      ...this.instructionsField(v),
      ...(problem
        ? [
            h(
              'div',
              { class: 'dd-callout dd-callout--error', role: 'alert', 'data-hook': 'hp-problem', 'data-problem': problem.field },
              h('p', {}, 'Saved with ', h('code', {}, presetChoiceText(this.host.store.hireOptions, v.seen ?? d)), `. ${problem.why}`),
              h('p', {}, `Choose ${problem.field === 'effort' ? 'an effort' : `a ${problem.field}`} below; nothing else was picked for you.`),
            ),
          ]
        : []),
      h('div', { class: 'dd-agent' }, ...choice),
      ...(v.error?.field === 'choice' && !problem ? [h('p', { class: 'dd-status dd-status--error', role: 'alert' }, v.error.why)] : []),
      scope,
    );
    replaceKeepingFocus(this.body, nodes, 'name');
    for (const el of this.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')) if (v.saving) el.disabled = true;
    const cancel = h('button', { type: 'button', class: 'btn', 'data-key': 'cancel', onclick: () => (this.desk !== null ? this.toList(v.id) : this.close()) }, this.desk !== null ? 'Back' : 'Cancel');
    const text = v.saving ? 'Saving…' : stale === 'deleted' ? 'Save as new preset' : v.id ? 'Save preset' : 'Create preset';
    const save = h('button', { class: 'btn btn--primary', type: 'submit', form: 'hp-form', 'data-key': 'save', 'aria-disabled': v.saving ? 'true' : null, 'aria-busy': v.saving ? 'true' : null }, text);
    // #108: the stored prompt's review on purpose (with the switch on), then the save.
    const review = reviewButton(this.host.secrets, v.saving ? 'Saving…' : null, () => void this.save(true), 'prompt');
    replaceKeepingFocus(this.actions, review ? [cancel, review, save] : [cancel, save]);
  }

  /**
   * #95: "Add herdr hiring instructions" beside the prompt, and the question the classifier's "yes" asks under it. An
   * older bridge gets the hint to update it instead (nothing sends it the flag).
   */
  private instructionsField(v: EditView): HTMLElement[] {
    if (!this.host.store.hirePresets.instructions)
      return this.off() ? [] : [h('p', { class: 'field-hint hp-instructions-off', 'data-hook': 'hp-instructions-off' }, INSTRUCTIONS_OLD_BRIDGE)];
    const d = v.draft;
    const box = h('input', { type: 'checkbox', id: 'hp-instructions', 'data-key': 'instructions', 'aria-describedby': 'hp-instructions-hint' });
    box.checked = d.instructions;
    box.disabled = v.saving;
    box.addEventListener('change', () => {
      d.instructions = box.checked;
      if (d.instructions) v.nudge = false;
      this.render();
    });
    const field = h(
      'div',
      { class: 'dd-field hp-instructions', 'data-on': d.instructions ? 'true' : 'false' },
      h('label', { class: 'dd-check', for: 'hp-instructions' }, box, h('span', { class: 'dd-check-box', 'aria-hidden': 'true' }), h('span', {}, INSTRUCTIONS_LABEL)),
      h('p', { class: 'field-hint dd-base', id: 'hp-instructions-hint' }, INSTRUCTIONS_HINT),
    );
    if (!v.nudge) return [field];
    const ask = h(
      'div',
      { class: 'dd-callout pp-confirm hp-nudge', role: 'alert', 'data-hook': 'hp-nudge' },
      h('p', {}, NUDGE_TEXT),
      h(
        'div',
        { class: 'pp-confirm-actions' },
        h('button', { type: 'button', class: 'btn btn--sm', 'data-key': 'nudge-as-is', title: 'Save it without the instructions; this text is not asked about again', onclick: () => this.answerNudge(v, false) }, 'Save as is'),
        h('button', { type: 'button', class: 'btn btn--sm btn--primary', 'data-key': 'nudge-on', onclick: () => this.answerNudge(v, true) }, 'Turn on and save'),
      ),
    );
    return [field, ask];
  }

  /** #95: the question answered: tick the box (a click on Turn on and save) or keep it off for this text, then save. */
  private answerNudge(v: EditView, on: boolean): void {
    if (this.view !== v || !v.nudge) return;
    v.nudge = false;
    if (on) v.draft.instructions = true;
    else v.dismissed = v.draft.prompt;
    void this.save();
  }

  /** This floor (the default) or Global, said plainly: what each one means for where the preset shows. */
  private scopeField(v: EditView): HTMLElement {
    const row = h('div', { class: 'dd-chips' });
    for (const [value, text] of [
      ['floor', 'This floor'],
      ['global', 'Global'],
    ] as const) {
      const input = h('input', { type: 'radio', name: 'preset-scope', value, class: 'visually-hidden', 'data-key': `preset-scope:${value}`, 'aria-describedby': 'hp-scope-hint' });
      input.checked = v.draft.scope === value;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        v.draft.scope = value;
        this.clearError(v, 'name');
        this.render();
      });
      row.append(h('label', { class: 'dd-chip' }, input, h('span', {}, text)));
    }
    const hint = v.draft.scope === 'floor' ? `Only on ${this.floorName()}. Floors in the same session or building do not see it.` : 'On every floor of every building this herdr-world serves, beside each floor’s own presets.';
    return h('div', { class: 'dd-field hp-scope' }, h('fieldset', { class: 'dd-pick', 'data-pick': 'preset-scope' }, h('legend', {}, 'Scope'), row), h('p', { class: 'field-hint', id: 'hp-scope-hint' }, hint));
  }

  private clearError(v: EditView, field: 'name' | 'prompt'): void {
    if (v.error?.field !== field) return;
    v.error = null;
    const input = this.body.querySelector<HTMLElement>(field === 'name' ? '#hp-name' : '#hp-prompt');
    input?.removeAttribute('aria-invalid');
    const err = this.body.querySelector<HTMLElement>(`#hp-${field}-error`);
    if (err) err.textContent = '';
  }

  private focusFirst(): void {
    (this.dialog.querySelector<HTMLElement>('[data-key^="use:"], [data-key="empty-new"], [data-key="new"]:not([aria-disabled])') ?? this.dialog.querySelector<HTMLElement>('[data-key="done"]'))?.focus();
  }

  private focusEditor(): void {
    const name = this.dialog.querySelector<HTMLInputElement>('#hp-name');
    name?.focus();
    name?.select();
  }

  // ---- actions ---------------------------------------------------------------------

  private toList(focusId: string | null = null, which: 'edit' | 'use' = 'edit'): void {
    if (this.desk === null) {
      this.close();
      return;
    }
    this.view = { kind: 'list', confirm: null, replacing: null };
    this.setStatus(this.statusError ? '' : this.statusText);
    this.render();
    const el = (focusId && this.dialog.querySelector<HTMLElement>(`[data-key="${which}:${CSS.escape(focusId)}"]`)) || this.dialog.querySelector<HTMLElement>('[data-key^="use:"], [data-key="new"]');
    el?.focus();
  }

  private ask(id: string): void {
    this.view = { kind: 'list', confirm: id, replacing: null };
    this.setStatus('');
    this.render();
    this.dialog.querySelector<HTMLElement>(`[data-key="keep:${CSS.escape(id)}"]`)?.focus();
  }

  /** Use: the hire form for this desk with the preset's prompt and exact choice. A desk's unsent task is replaced only when asked to. */
  private use(p: HirePreset, replace: boolean): void {
    const desk = this.desk;
    if (desk === null) return;
    if (!replace && this.host.unsent(this.floor, desk)) {
      this.view = { kind: 'list', confirm: null, replacing: p.id };
      this.setStatus('');
      this.render();
      this.dialog.querySelector<HTMLElement>(`[data-key="keep-task:${CSS.escape(p.id)}"]`)?.focus();
      return;
    }
    const floor = this.floor;
    this.close();
    this.host.use(floor, desk, structuredClone(p), replace);
  }

  private edit(p: HirePreset | null, seed?: HirePresetDraft, note: string | null = null): void {
    const options = this.options(p);
    const draft: HirePresetDraft = p
      ? draftFrom(p, this.floor)
      : (seed ?? { name: '', prompt: '', ...resolveVisibleChoice(options, null), scope: 'floor', instructions: false });
    this.view = { kind: 'edit', id: p?.id ?? null, draft, error: null, saving: false, seen: p ? structuredClone(p) : null, note, nudge: false, dismissed: p ? (this.declined.get(p.id) ?? null) : null };
    this.modelQuery = '';
    this.setStatus('');
    this.render();
    this.focusEditor();
  }

  /** The stale editor takes the preset as it is saved now. */
  private reload(v: EditView): void {
    const now = v.id ? this.host.store.hirePresets.get(v.id) : null;
    if (!now) return;
    v.draft = draftFrom(now, this.floor);
    v.seen = structuredClone(now);
    v.error = null;
    v.nudge = false;
    this.render();
    this.focusEditor();
  }

  /**
   * Save. #108 round 4: with the switch on (or `manual`: "Review secrets"), the prompt is reviewed first: a preset's
   * prompt is stored, so every match stays as typed (it is protected when a hire uses it) and Protect says why. The
   * classifier's check and the save carry that review; it is kept while the prompt is unchanged (the check's question,
   * a refused save), so it opens once per text.
   */
  private async save(manual = false): Promise<void> {
    const v = this.view;
    if (v.kind !== 'edit' || v.saving) return;
    if (v.nudge) {
      // The question is open: it is answered first.
      this.dialog.querySelector<HTMLElement>('[data-key="nudge-on"]')?.focus();
      return;
    }
    const book = this.host.store.hirePresets;
    const off = this.off();
    if (off) {
      this.setStatus(off, true);
      return;
    }
    // A preset deleted elsewhere is saved as a new one.
    const current = v.id ? book.get(v.id) : null;
    const scopeFloor = v.draft.scope === 'floor' ? this.floor : '';
    const bad = draftBlocker(v.draft, this.host.store.hireOptions, (n) => book.nameTaken(n, scopeFloor, current?.id ?? ''));
    if (bad) {
      v.error = bad;
      this.render();
      this.dialog.querySelector<HTMLElement>(bad.field === 'name' ? '#hp-name' : bad.field === 'prompt' ? '#hp-prompt' : '[data-pick="preset-harness"] input')?.focus();
      return;
    }
    v.saving = true;
    this.render();
    // #108: this editor's save while it is up (closing leaves the view as it was): closed meanwhile, nothing is checked or
    // saved and no review opens.
    const live = () => this.view === v && this.dialog.open;
    const flow = this.host.secrets;
    const sreq = { key: `preset:${v.id ?? 'new'}`, text: v.draft.prompt, target: `“${v.draft.name.trim() || 'the preset'}”`, stored: true, manual, live };
    if (manual && !v.draft.prompt) {
      v.saving = false;
      this.setStatus('Write a prompt first, then review its secrets.', true);
      this.render();
      return;
    }
    if (v.reviewed?.text !== v.draft.prompt || manual) v.reviewed = undefined;
    if (!v.reviewed && v.draft.prompt && flow && (flow.on || manual)) {
      this.setStatus(manual ? 'Opening the review of its secrets…' : 'Looking for secrets in the prompt…');
      const out = await flow.review(sreq);
      if (!live()) return;
      if (out.kind === 'kept') {
        v.saving = false;
        this.setStatus(out.why === 'cancel' ? 'Not saved: the prompt is still here.' : out.message, out.why === 'failed');
        this.render();
        return;
      }
      this.setStatus('');
      v.reviewed = { text: v.draft.prompt, go: out };
    }
    const go: Go = v.reviewed?.go ?? { kind: 'send', protects: 0, shown: v.draft.prompt, review: null };
    // #95: the box off: does the prompt hand work to other agents? Only a "yes" in time stops the save, to ask.
    if (await this.delegates(v, go)) {
      if (!live()) return;
      v.saving = false;
      v.nudge = true;
      this.render();
      this.dialog.querySelector<HTMLElement>('[data-key="nudge-on"]')?.focus();
      return;
    }
    if (!live()) return;
    const spec = presetSpec(v.draft, this.floor, book.instructions);
    const send = (g: Go): Promise<CommandResult> => {
      const s = g.secrets ? { ...spec, secrets: g.secrets } : spec;
      return current ? this.host.send('hire_preset.update', { id: current.id, ...s }) : this.host.send('hire_preset.create', s);
    };
    const d = flow ? await flow.deliver(sreq, go, send) : ({ kind: 'answered', result: await send(go), go } as const);
    if (this.view !== v) return;
    v.saving = false;
    if (d.kind === 'kept' && d.why === 'gone') return;
    const r: CommandResult = d.kind === 'kept' ? { ok: false, code: 'secrets_kept', message: d.message } : d.result;
    if (d.kind === 'answered' && d.go !== go) v.reviewed = { text: v.draft.prompt, go: d.go };
    if (r.ok) {
      const saved = r.data as HirePreset | undefined;
      const id = saved?.id ?? current?.id;
      if (id && v.dismissed !== null) this.declined.set(id, v.dismissed);
      const done = `${current ? 'Saved' : 'Created'} hire preset “${spec.name}” (${spec.floor ? 'this floor' : 'global'}).`;
      if (this.desk === null) {
        this.close();
        this.host.toast(done, 'info');
        return;
      }
      this.setStatus(done);
      this.toList(saved?.id ?? current?.id ?? null);
      return;
    }
    const t = current ? 'hire_preset.update' : 'hire_preset.create';
    if (r.code === 'name_taken') v.error = { field: 'name', why: `Another preset ${spec.floor ? 'on this floor' : 'in Global'} is called “${spec.name}”.` };
    else if (r.code === 'not_found') {
      v.id = null;
      v.seen = null;
      this.setStatus(failureText(t, r.code, r.message), true);
    } else this.setStatus(failureText(t, r.code, r.message, { floor: this.floorName() }), true);
    this.render();
    if (v.error?.field === 'name') this.dialog.querySelector<HTMLElement>('#hp-name')?.focus();
  }

  /**
   * #95: the classifier's say on the draft's prompt, when Save should ask (`nudgeWanted`): false for anything but a "yes"
   * (a refusal, a timeout, an older bridge's `unknown_command`).
   */
  private async delegates(v: EditView, go: Go): Promise<boolean> {
    const supported = this.host.store.hirePresets.instructions && !this.host.unsupported('hire_preset.check');
    const ready = supported && this.host.store.ai.state?.classifier.state === 'ready';
    if (!nudgeWanted(v.draft, { supported, ready, dismissed: v.dismissed })) return false;
    // #108: with the review (the classifier reads the prompt as typed, every match left so).
    const r = await this.host.send('hire_preset.check', { prompt: v.draft.prompt, ...(go.secrets ? { secrets: go.secrets } : {}) });
    return r.ok && (r.data as HirePresetCheckAck | undefined)?.delegates === true;
  }

  private async remove(p: HirePreset): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    const v = this.view;
    const opening = this.opening;
    const r = await this.host.send('hire_preset.delete', { id: p.id });
    // Opened again meanwhile: that dialog is gone, and this one has its own busy.
    if (this.opening !== opening) return;
    this.busy = false;
    if (!this.dialog.open) return;
    const failed = !r.ok && r.code !== 'not_found';
    if (this.view !== v) {
      // The player moved on (Keep it, then an editor): that view stays as it is, the list following the store anyway.
      // Only a refusal is said, and only a list re-renders (its Delete buttons were held while busy).
      if (failed) this.setStatus(failureText('hire_preset.delete', r.code, r.message), true);
      if (this.view.kind === 'list') this.render();
      return;
    }
    if (!failed) {
      this.setStatus(`Deleted “${p.name}”.`);
      this.toList(null);
      return;
    }
    this.setStatus(failureText('hire_preset.delete', r.code, r.message), true);
    this.view = { kind: 'list', confirm: null, replacing: null };
    this.render();
  }

  // ---- test hook ---------------------------------------------------------------------

  summary(): HirePresetsSummary | null {
    if (!this.dialog.open) return null;
    const v = this.view;
    const { floor, global } = this.host.store.hirePresets.forFloor(this.floor);
    return {
      kind: 'hire-presets',
      state: this.busy || (v.kind === 'edit' && v.saving) ? 'busy' : 'ready',
      view: v.kind,
      floor: this.floor,
      desk: this.desk,
      off: this.off(),
      groups: { floor: floor.map((p) => this.row(p)), global: global.map((p) => this.row(p)) },
      pins: deskPins(this.host.pins, this.host.store.hirePresets, this.host.store.hireOptions, this.floor)?.list.map((t) => t.id) ?? [],
      confirm: v.kind === 'list' ? v.confirm : null,
      replacing: v.kind === 'list' ? v.replacing : null,
      editing: v.kind === 'edit' ? { id: v.id, draft: { ...v.draft }, error: v.error, saving: v.saving, stale: this.stale(v), problem: exactProblem(this.host.store.hireOptions, v.draft), nudge: v.nudge } : null,
      instructions: this.host.store.hirePresets.instructions,
      status: this.statusText,
      error: this.statusError,
    };
  }
}
