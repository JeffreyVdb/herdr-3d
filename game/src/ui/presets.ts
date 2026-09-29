import type { CommandArgs, CommandName, Hire, Preset, PresetRoles } from '../net/protocol';
import type { CommandResult } from '../net/client';
import { modelsFor, resolveChoice } from '../world/hire';
import { PRESET_ROLES, ROLE_LABEL } from '../world/presets';
import { effortsFor } from '../world/settings';
import { presetBlocker, presetLines, presetPatch, type PresetDraft } from '../world/startRun';
import type { WorldStore } from '../world/store';
import { h, icon, ICON, replaceKeepingFocus } from './dom';
import { failureText } from './messages';

/**
 * Team presets (M6): list, create, edit (name and the five roles ×
 * harness / model / effort) and delete, confirmed. A modal like the M4
 * dialogs, over the start-run dialog when opened from it; the list follows
 * `preset.upsert` / `preset.removed` live. Esc in the editor goes back to the
 * list, Esc in the list closes, and focus returns to what opened it.
 */

export interface PresetsHost {
  readonly store: WorldStore;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  unsupported(t: CommandName): boolean;
  toast(msg: string, kind: 'info' | 'error'): void;
}

type View = { kind: 'list'; confirm: string | null } | { kind: 'edit'; id: string | null; draft: PresetDraft; error: { field: 'name' | 'roles'; why: string } | null; saving: boolean; seen: Preset | null };

/** What the presets panel shows (test hook). */
export interface PresetsSummary {
  kind: 'presets';
  /** `busy` while a save or a delete is on its way. */
  state: 'ready' | 'busy';
  view: 'list' | 'edit';
  presets: Array<{ id: string; name: string; seeded: boolean }>;
  /** The delete waiting for its confirmation. */
  confirm: string | null;
  editing: { id: string | null; draft: PresetDraft; error: { field: 'name' | 'roles'; why: string } | null; saving: boolean } | null;
  /** Why presets cannot be changed on this bridge, null when they can. */
  off: string | null;
  status: string;
  error: boolean;
}

const TEAM_ICON = '<circle cx="8.5" cy="8.5" r="2.7"/><circle cx="15.8" cy="9.5" r="2.2"/><path d="M3.8 18.5c.5-3 2.4-4.7 4.7-4.7s4.2 1.7 4.7 4.7"/><path d="M14 14.2c.6-.3 1.2-.4 1.8-.4 2 0 3.6 1.5 4 4.2"/>';

export class PresetsPanel {
  private readonly dialog = h('dialog', { class: 'desk-dlg desk-dlg--presets', 'aria-labelledby': 'presets-title', 'aria-describedby': 'presets-sub' });
  private readonly head = h('header', { class: 'dd-head' });
  private readonly body = h('form', { class: 'dd-body', id: 'presets-form', novalidate: true });
  private readonly statusEl = h('p', { class: 'dd-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private readonly actions = h('div', { class: 'dd-actions' });
  private readonly foot = h('footer', { class: 'dd-foot' }, this.statusEl, this.alertEl, this.actions);
  private view: View = { kind: 'list', confirm: null };
  private statusText = '';
  private statusError = false;
  private returnTo: HTMLElement | null = null;
  /** The dialog (or the document) `returnTo` was in. */
  private returnScope: ParentNode | null = null;
  private seenVersion = -1;
  private busy = false;

  constructor(
    parent: HTMLElement,
    private readonly host: PresetsHost,
  ) {
    this.alertEl.hidden = true;
    this.statusEl.hidden = true;
    this.dialog.append(this.head, this.body, this.foot);
    this.dialog.addEventListener('cancel', (e) => {
      // Esc: a pending delete or the editor first, then the panel.
      if (this.view.kind === 'edit' || this.view.confirm) {
        e.preventDefault();
        this.toList(this.view.kind === 'edit' ? this.view.id : this.view.confirm);
      }
    });
    this.dialog.addEventListener('close', () => {
      const back = this.returnTo;
      this.returnTo = null;
      if (!back) return;
      // The opener may have re-rendered meanwhile (the start-run dialog follows the presets): its twin by data-key.
      const twin = back.isConnected ? back : back.dataset.key ? this.returnScope?.querySelector<HTMLElement>(`[data-key="${CSS.escape(back.dataset.key)}"]`) : null;
      twin?.focus();
    });
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.close();
    });
    this.body.addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.view.kind === 'edit') void this.save();
    });
    parent.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  /** Opens the list (focus comes back to `from` on close). */
  open(from: HTMLElement | null = null): void {
    this.returnTo = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    this.returnScope = this.returnTo?.closest('dialog') ?? document;
    this.view = { kind: 'list', confirm: null };
    this.setStatus('');
    this.busy = false;
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.focusFirst();
  }

  private off(): string | null {
    const s = this.host.store.presets;
    if (!s.known || this.host.unsupported('preset.create') || this.host.unsupported('preset.update') || this.host.unsupported('preset.delete')) return failureText('preset.create', 'unknown_command', '');
    return null;
  }

  /** A preset changed or went (here or elsewhere): the list re-renders; an open editor says so. */
  refresh(): void {
    if (!this.dialog.open) return;
    const version = this.host.store.presets.version;
    if (version === this.seenVersion) return;
    const v = this.view;
    if (v.kind === 'edit' && v.id && !v.saving) {
      const now = this.host.store.presets.get(v.id);
      if (!now) this.setStatus(`“${v.seen?.name ?? v.draft.name}” was deleted meanwhile. Go back to the list, or save it as a new preset.`, true);
      else if (v.seen && JSON.stringify(now) !== JSON.stringify(v.seen)) this.setStatus(`“${now.name}” changed elsewhere meanwhile: saving replaces it with what you see here.`);
    }
    if (v.kind === 'list' && v.confirm && !this.host.store.presets.get(v.confirm)) this.view = { kind: 'list', confirm: null };
    this.render();
  }

  private setStatus(msg: string, error = false): void {
    this.statusText = msg;
    this.statusError = error && !!msg;
    this.alertEl.hidden = !error || !msg;
    this.statusEl.hidden = error || !msg;
    (error ? this.alertEl : this.statusEl).textContent = msg;
    (error ? this.statusEl : this.alertEl).textContent = '';
  }

  // ---- rendering ---------------------------------------------------------------------

  private render(): void {
    this.seenVersion = this.host.store.presets.version;
    const v = this.view;
    const editing = v.kind === 'edit';
    const title = !editing ? 'Team presets' : v.id ? `Edit “${v.seen?.name ?? v.draft.name}”` : 'New team preset';
    this.head.replaceChildren(
      ...(editing ? [h('button', { class: 'btn btn--icon', 'data-key': 'back', 'aria-label': 'Back to the presets', title: 'Back to the presets (Esc)', onclick: () => this.toList(v.id) }, icon(ICON.back))] : []),
      h('div', { class: 'dd-plate dd-plate--team', 'aria-hidden': 'true' }, icon(TEAM_ICON)),
      h('div', { class: 'dd-titles' }, h('h2', { id: 'presets-title' }, title), h('p', { id: 'presets-sub' }, editing ? 'The orchestrator, and who it hires for each job' : 'Who a run hires for each role · shared by every floor')),
      h('button', { class: 'btn btn--icon dd-close', 'data-key': 'close', 'aria-label': 'Close', title: 'Close', onclick: () => this.close() }, icon(ICON.close)),
    );
    if (v.kind === 'list') this.renderList(v.confirm);
    else this.renderEdit(v);
  }

  private renderList(confirm: string | null): void {
    const off = this.off();
    const list = this.host.store.presets.list();
    const rows: Node[] = [];
    if (off) rows.push(h('div', { class: 'dd-callout', role: 'note' }, h('p', {}, off)));
    else if (!list.length) rows.push(h('p', { class: 'pp-empty' }, 'No team presets. A run needs one: create it with New preset.'));
    const ul = h('ul', { class: 'pp-list', 'aria-label': 'Team presets' });
    for (const p of list) {
      const asking = confirm === p.id;
      const roles = h('dl', { class: 'pp-roles' });
      for (const r of presetLines(p)) roles.append(h('dt', {}, r.role), h('dd', {}, r.line));
      const tools = asking
        ? h(
            'div',
            { class: 'dd-callout dd-callout--error pp-confirm', role: 'alert' },
            h('p', {}, `Delete “${p.name}”? Floors that last started a run with it forget it. Runs it started keep going.`),
            h(
              'div',
              { class: 'pp-confirm-actions' },
              h('button', { class: 'btn btn--sm', 'data-key': `keep:${p.id}`, onclick: () => this.toList(p.id) }, 'Keep it'),
              h('button', { class: 'btn btn--sm btn--danger', 'data-key': `confirm-delete:${p.id}`, disabled: this.busy, onclick: () => void this.remove(p) }, this.busy ? 'Deleting…' : 'Delete preset'),
            ),
          )
        : h(
            'div',
            { class: 'pp-tools' },
            h('button', { class: 'btn btn--sm', 'data-key': `edit:${p.id}`, 'aria-label': `Edit ${p.name}`, disabled: !!off, onclick: () => this.edit(p) }, icon(ICON.pencil), h('span', {}, 'Edit')),
            h('button', { class: 'btn btn--sm btn--danger-quiet', 'data-key': `delete:${p.id}`, 'aria-label': `Delete ${p.name}`, disabled: !!off, onclick: () => this.ask(p.id) }, icon(ICON.trash), h('span', {}, 'Delete')),
          );
      ul.append(
        h(
          'li',
          { class: 'pp-row', 'data-id': p.id, 'data-confirm': asking ? 'true' : null },
          h('div', { class: 'pp-row-head' }, h('h3', {}, p.name), p.seeded ? h('span', { class: 'tape tape--note', title: 'herdr-world set this one up' }, 'Built in') : null),
          roles,
          tools,
        ),
      );
    }
    if (list.length) rows.push(ul);
    replaceKeepingFocus(this.body, rows, 'new');
    const close = h('button', { class: 'btn', 'data-key': 'done', onclick: () => this.close() }, 'Close');
    const add = h('button', { class: 'btn btn--primary', 'data-key': 'new', 'aria-disabled': off ? 'true' : null, title: off ?? 'Create a team preset', onclick: () => !off && this.edit(null) }, icon(ICON.plus), h('span', {}, 'New preset'));
    replaceKeepingFocus(this.actions, [close, add]);
  }

  private renderEdit(v: Extract<View, { kind: 'edit' }>): void {
    const options = this.host.store.hireOptions;
    const name = h('input', { id: 'preset-name', 'data-key': 'name', autocomplete: 'off', spellcheck: 'false', maxlength: 40, placeholder: 'e.g. Solo coder', 'aria-invalid': v.error?.field === 'name' ? 'true' : null, 'aria-describedby': 'preset-name-error' });
    name.value = v.draft.name;
    name.disabled = v.saving;
    name.addEventListener('input', () => {
      v.draft.name = name.value;
      if (v.error?.field === 'name') {
        v.error = null;
        name.removeAttribute('aria-invalid');
        const err = this.body.querySelector<HTMLElement>('#preset-name-error');
        if (err) err.textContent = '';
      }
    });
    const select = (key: string, label: string, values: string[], value: string, pick: (x: string) => void) => {
      const s = h('select', { 'data-key': key, 'aria-label': label, disabled: v.saving });
      for (const x of values) s.append(h('option', { value: x, selected: x === value ? true : null }, x));
      s.addEventListener('change', () => pick(s.value));
      return s;
    };
    const table = h('div', { class: 'pp-table', role: 'table', 'aria-label': 'Roles' }, h('div', { class: 'pp-tr pp-th', role: 'row' }, ...['Role', 'Harness', 'Model', 'Effort'].map((x) => h('span', { role: 'columnheader' }, x))));
    for (const r of PRESET_ROLES) {
      const c = v.draft.roles[r];
      const set = (p: Partial<Hire>) => {
        const next = resolveChoice(options, { ...c, ...p });
        if (!next) return;
        v.draft.roles[r] = next;
        if (v.error?.field === 'roles') v.error = null;
        this.render();
      };
      table.append(
        h(
          'div',
          { class: 'pp-tr', role: 'row', 'data-role': r },
          h('span', { class: 'pp-role', role: 'rowheader' }, ROLE_LABEL[r]),
          h('span', { role: 'cell' }, select(`role:${r}:harness`, `${ROLE_LABEL[r]} harness`, Object.keys(options), c.harness, (x) => set({ harness: x }))),
          h('span', { role: 'cell' }, select(`role:${r}:model`, `${ROLE_LABEL[r]} model`, modelsFor(options, c.harness), c.model, (x) => set({ model: x }))),
          h('span', { role: 'cell' }, select(`role:${r}:effort`, `${ROLE_LABEL[r]} effort`, effortsFor(options, c.harness, c.model), c.effort, (x) => set({ effort: x }))),
        ),
      );
    }
    replaceKeepingFocus(
      this.body,
      [
        h('div', { class: 'dd-field' }, h('label', { for: 'preset-name' }, 'Name'), name, h('p', { class: 'field-hint dd-field-error', id: 'preset-name-error', role: 'alert' }, v.error?.field === 'name' ? v.error.why : '')),
        h('div', { class: 'dd-field' }, h('span', { class: 'dd-label' }, 'Team'), table, h('p', { class: 'field-hint' }, 'The orchestrator starts the run; it hires the others as the run needs them.')),
        ...(v.error?.field === 'roles' ? [h('p', { class: 'dd-status dd-status--error', role: 'alert' }, v.error.why)] : []),
      ],
      'name',
    );
    const back = h('button', { class: 'btn', 'data-key': 'cancel', onclick: () => this.toList(v.id) }, 'Back');
    const gone = !!v.id && !this.host.store.presets.get(v.id);
    const save = h('button', { class: 'btn btn--primary', type: 'submit', form: 'presets-form', 'data-key': 'save', 'aria-disabled': gone || v.saving ? 'true' : null }, v.saving ? 'Saving…' : v.id ? 'Save preset' : 'Create preset');
    replaceKeepingFocus(this.actions, [back, save]);
  }

  private focusFirst(): void {
    const v = this.view;
    const sel = v.kind === 'edit' ? '#preset-name' : '[data-key^="edit:"]:not([disabled]), [data-key="new"]';
    this.dialog.querySelector<HTMLElement>(sel)?.focus();
  }

  // ---- actions ---------------------------------------------------------------------

  private toList(focusId: string | null = null): void {
    this.view = { kind: 'list', confirm: null };
    this.setStatus(this.statusError ? '' : this.statusText);
    this.render();
    const el = (focusId && this.dialog.querySelector<HTMLElement>(`[data-key="edit:${CSS.escape(focusId)}"]`)) || this.dialog.querySelector<HTMLElement>('[data-key="new"]');
    el?.focus();
  }

  private ask(id: string): void {
    this.view = { kind: 'list', confirm: id };
    this.setStatus('');
    this.render();
    this.dialog.querySelector<HTMLElement>(`[data-key="keep:${CSS.escape(id)}"]`)?.focus();
  }

  private edit(p: Preset | null): void {
    const book = this.host.store.presets;
    const base = p ?? book.defaultFor(undefined);
    const roles = Object.fromEntries(
      PRESET_ROLES.map((r) => [r, resolveChoice(this.host.store.hireOptions, base?.roles[r] ?? null) ?? { harness: '', model: '', effort: '' }]),
    ) as PresetRoles;
    this.view = { kind: 'edit', id: p?.id ?? null, draft: { name: p?.name ?? '', roles }, error: null, saving: false, seen: p ? structuredClone(p) : null };
    this.setStatus('');
    this.render();
    const name = this.dialog.querySelector<HTMLInputElement>('#preset-name');
    name?.focus();
    name?.select();
  }

  private async save(): Promise<void> {
    const v = this.view;
    if (v.kind !== 'edit' || v.saving) return;
    const book = this.host.store.presets;
    const current = v.id ? book.get(v.id) : null;
    if (v.id && !current) return;
    const bad = presetBlocker(v.draft, this.host.store.hireOptions, book, v.id ?? '');
    if (bad) {
      v.error = bad;
      this.render();
      this.dialog.querySelector<HTMLElement>(bad.field === 'name' ? '#preset-name' : '[data-key^="role:"]')?.focus();
      return;
    }
    const name = v.draft.name.trim();
    let r: CommandResult;
    if (current) {
      const patch = presetPatch(current, v.draft);
      if (!patch) {
        this.setStatus('Nothing changed.');
        this.toList(current.id);
        return;
      }
      v.saving = true;
      this.render();
      r = await this.host.send('preset.update', patch);
    } else {
      v.saving = true;
      this.render();
      r = await this.host.send('preset.create', { name, roles: structuredClone(v.draft.roles) });
    }
    if (this.view !== v) return;
    v.saving = false;
    if (r.ok) {
      const id = current?.id ?? (r.data as { id?: string } | undefined)?.id ?? null;
      this.setStatus(current ? `Saved “${name}”.` : `Created “${name}”.`);
      this.toList(id);
      return;
    }
    if (r.code === 'name_taken') v.error = { field: 'name', why: `Another preset is already called “${name}”.` };
    else if (r.code === 'bad_request') v.error = { field: 'roles', why: `herdr-world refused it: ${r.message.replace(/^bad args:\s*/, '')}` };
    else if (r.code === 'not_found') this.setStatus(`“${name}” was deleted meanwhile. Go back to the list, or save it as a new preset.`, true);
    else this.setStatus(failureText(current ? 'preset.update' : 'preset.create', r.code, r.message), true);
    if (r.code === 'not_found') {
      v.id = null;
      v.seen = null;
    }
    this.render();
    if (v.error?.field === 'name') this.dialog.querySelector<HTMLElement>('#preset-name')?.focus();
  }

  private async remove(p: Preset): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    const r = await this.host.send('preset.delete', { id: p.id });
    this.busy = false;
    if (!this.dialog.open) return;
    const list = this.host.store.presets.list();
    if (r.ok || r.code === 'not_found') {
      this.setStatus(`Deleted “${p.name}”.`);
      this.toList(list[0]?.id ?? null);
      return;
    }
    this.setStatus(failureText('preset.delete', r.code, r.message), true);
    this.view = { kind: 'list', confirm: null };
    this.render();
  }

  // ---- test hook ---------------------------------------------------------------------

  summary(): PresetsSummary | null {
    if (!this.dialog.open) return null;
    const v = this.view;
    return {
      kind: 'presets',
      state: this.busy || (v.kind === 'edit' && v.saving) ? 'busy' : 'ready',
      view: v.kind,
      presets: this.host.store.presets.list().map((p) => ({ id: p.id, name: p.name, seeded: !!p.seeded })),
      confirm: v.kind === 'list' ? v.confirm : null,
      editing: v.kind === 'edit' ? { id: v.id, draft: structuredClone(v.draft), error: v.error, saving: v.saving } : null,
      off: this.off(),
      status: this.statusText,
      error: this.statusError,
    };
  }
}
