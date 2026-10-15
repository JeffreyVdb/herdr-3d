import './addFloor.css';
import type { CommandResult } from '../net/client';
import type { CommandArgs, CommandName, Floor } from '../net/protocol';
import { baseSessions, FLOOR_KINDS, floorNameError, MAX_FLOOR_NAME, MAX_SESSION_NAME, newSessionNameError, type FloorKind } from '../world/addFloor';
import type { WorldStore } from '../world/store';
import { h, icon, ICON } from './dom';
import { failureText } from './messages';
import { backdropPolicy } from './dismiss';
import type { Hud } from './hud';

/**
 * #58 Add floor: a new floor from the city (the top bar's Add floor, the Buildings panel) or Settings → Floors. Two
 * kinds: a **new herdr session** (a session name; `session.create`, answered once the floor is in the world) and, stage
 * 4, a **virtual floor on an existing session** (free-text name and a base session picked from the real floors;
 * `floor.create`). A virtual floor stands in its session's building, so nothing asks for one (decision 4). On success
 * the dialog hands the new floor to `added` (the opener's own, else the host's). A modal like the M4 dialogs: Enter
 * adds, Esc closes, focus returns to what opened it; a result that comes after it closed is a toast.
 */

export interface AddFloorHost {
  readonly store: WorldStore;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  unsupported(t: CommandName): boolean;
  toast(msg: string, kind: 'info' | 'error'): void;
  /** The new floor (its id) is in the world: show it (a new session's floor waits in the lot for a building). */
  added(floor: string, kind: FloorKind['id']): void;
  /** The herdr session of the floor you are on (the base the picker starts on), else null. */
  here?(): string | null;
}

/** How an opener wants the dialog: a kind to start on, and its own `added`. */
export interface AddFloorOpen {
  kind?: FloorKind['id'];
  added?(floor: string, kind: FloorKind['id']): void;
}

/** What the dialog shows (test hook `window.__h3d.dialog()`). */
export interface AddFloorSummary {
  kind: 'add-floor';
  /** `busy` while `session.create` is on its way. */
  state: 'ready' | 'busy';
  floorKind: FloorKind['id'];
  name: string;
  /** A virtual floor's base session (null: none to pick); the sessions the picker offers. */
  base: string | null;
  bases: string[];
  /** The name field's error ('' when it has none). */
  error: string;
  status: string;
  statusError: boolean;
  /** Why floors cannot be added on this bridge, null when they can. */
  off: string | null;
}

/** The city's top bar button, next to Buildings. */
export function addFloorButton(hud: Hud, open: (from: HTMLElement) => void): HTMLButtonElement {
  const b = h('button', { class: 'btn', 'data-action': 'add-floor', title: 'Add floor: a new herdr session, or a virtual floor on one' }, icon(ICON.plus), h('span', {}, 'Add floor'));
  b.addEventListener('click', () => open(b));
  hud.addTopbarButton(b, 'buildings', (mode) => mode === 'city');
  return b;
}

/** What each kind's fields say. */
const WORDS: Record<FloorKind['id'], { label: string; hint: string; placeholder: string; sub: string; max: number }> = {
  session: { label: 'Session name', hint: 'Lowercase letters, digits, “_” and “-”. It names the floor and its herdr session.', placeholder: 'e.g. billing-api', sub: 'It starts empty, in the Unassigned lot.', max: MAX_SESSION_NAME },
  virtual: {
    label: 'Floor name',
    hint: `Any name, up to ${MAX_FLOOR_NAME} bytes. Only the game shows it: herdr never sees it.`,
    placeholder: 'e.g. Frontend',
    sub: 'It starts empty, in its session’s building.',
    max: MAX_FLOOR_NAME,
  },
};
const BASE_HINT = 'Its workers’ workspaces open in this herdr session, and the floor stands in its building. A sleeping session wakes on the first hire.';

export class AddFloorDialog {
  private readonly dialog = h('dialog', { class: 'desk-dlg desk-dlg--addfloor', 'aria-labelledby': 'af-title', 'aria-describedby': 'af-sub' });
  private readonly body = h('form', { class: 'dd-body', id: 'af-form', novalidate: true });
  private readonly kinds = h('fieldset', { class: 'dd-choices' }, h('legend', {}, 'Kind'));
  private readonly input = h('input', {
    id: 'af-name',
    class: 'af-name',
    name: 'name',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    maxlength: MAX_SESSION_NAME + 1,
    placeholder: 'e.g. billing-api',
    'aria-describedby': 'af-name-hint',
  });
  private readonly nameLabel = h('label', { for: 'af-name', id: 'af-name-label' }, WORDS.session.label);
  private readonly hint = h('p', { id: 'af-name-hint', class: 'field-hint' }, WORDS.session.hint);
  private readonly sub = h('p', { id: 'af-sub' }, WORDS.session.sub);
  private readonly base = h('select', { id: 'af-base', 'data-key': 'base', 'aria-describedby': 'af-base-hint' });
  private readonly baseHint = h('p', { id: 'af-base-hint', class: 'field-hint' }, BASE_HINT);
  private readonly baseField = h('div', { class: 'dd-field af-base' }, h('label', { for: 'af-base' }, 'Base session'), this.base, this.baseHint);
  private readonly offEl = h('div', { class: 'dd-callout', role: 'note' }, h('p', {}));
  private readonly statusEl = h('p', { class: 'dd-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private readonly add = h('button', { class: 'btn btn--primary', type: 'submit', form: 'af-form', 'data-key': 'add' }, icon(ICON.plus), h('span', {}, 'Add floor'));
  private floorKind: FloorKind['id'] = FLOOR_KINDS[0]!.id;
  /** The base session picked (kept while the picker re-renders). */
  private baseValue: string | null = null;
  private baseError = '';
  /** The opener's own `added`, for this opening. */
  private onAdded: AddFloorOpen['added'] | null = null;
  private error = '';
  /** The name was submitted once: from then on every keystroke is checked (before, only what is typed wrong). */
  private tried = false;
  private busy = false;
  private statusText = '';
  private statusError = false;
  private returnTo: HTMLElement | null = null;

  constructor(
    parent: HTMLElement,
    private readonly host: AddFloorHost,
  ) {
    const close = h('button', { class: 'btn btn--icon dd-close', type: 'button', 'data-key': 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => this.close() }, icon(ICON.close));
    const head = h(
      'header',
      { class: 'dd-head' },
      // The free desk's green "+", on a building: something new goes in here.
      h('div', { class: 'dd-plate dd-plate--desk dd-plate--floor', 'aria-hidden': 'true' }, icon(ICON.plus), icon(ICON.building)),
      h('div', { class: 'dd-titles' }, h('h2', { id: 'af-title' }, 'Add floor'), this.sub),
      close,
    );
    for (const k of FLOOR_KINDS) {
      const radio = h('input', { type: 'radio', name: 'af-kind', id: `af-kind-${k.id}`, value: k.id, 'aria-describedby': `af-kind-${k.id}-hint` });
      radio.addEventListener('change', () => {
        if (radio.checked) this.setKind(k.id);
      });
      this.kinds.append(
        h(
          'label',
          { class: 'dd-choice', for: `af-kind-${k.id}` },
          radio,
          h('span', { class: 'dd-radio', 'aria-hidden': 'true' }),
          h('span', { class: 'dd-choice-text' }, h('span', {}, k.label), h('span', { class: 'field-hint', id: `af-kind-${k.id}-hint` }, k.hint)),
        ),
      );
    }
    this.body.append(this.offEl, this.kinds, h('div', { class: 'dd-field' }, this.nameLabel, this.input, this.hint), this.baseField);
    const cancel = h('button', { class: 'btn', type: 'button', 'data-key': 'cancel', onclick: () => this.close() }, 'Cancel');
    const foot = h('footer', { class: 'dd-foot' }, this.statusEl, this.alertEl, h('div', { class: 'dd-actions' }, cancel, this.add));
    this.dialog.append(head, this.body, foot);
    this.input.addEventListener('input', () => this.check(false));
    this.base.addEventListener('change', () => {
      this.baseValue = this.base.value || null;
      this.setBaseError('');
    });
    this.body.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit();
    });
    this.dialog.addEventListener('close', () => {
      const back = this.returnTo;
      this.returnTo = null;
      if (back?.isConnected) back.focus();
    });
    // Typed text: only the close button, Cancel and Esc close it, never the backdrop.
    backdropPolicy(this.dialog, 'none');
    parent.append(this.dialog);
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  /**
   * Opens it empty (focus comes back to `from` on close), on `o.kind` (else a new session), the picker on the session
   * of the floor you are on. While a floor is still being added it opens as it is.
   */
  open(from: HTMLElement | null = null, o: AddFloorOpen = {}): void {
    this.returnTo = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (!this.busy) {
      this.onAdded = o.added ?? null;
      this.input.value = '';
      this.baseValue = this.host.here?.() ?? null;
      this.setBaseError('');
      this.setStatus('');
      this.setKind(o.kind ?? FLOOR_KINDS[0]!.id);
    }
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.input.focus();
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  /** The world changed: a floor that appeared meanwhile may have taken the name. */
  refresh(): void {
    if (!this.dialog.open) return;
    this.render();
    if (!this.busy && this.input.value) this.check(false);
  }

  summary(): AddFloorSummary | null {
    if (!this.dialog.open) return null;
    return {
      kind: 'add-floor',
      state: this.busy ? 'busy' : 'ready',
      floorKind: this.floorKind,
      name: this.input.value,
      base: this.floorKind === 'virtual' ? this.pickedBase() : null,
      bases: this.bases().map((b) => b.session),
      error: this.error || this.baseError,
      status: this.statusText,
      statusError: this.statusError,
      off: this.off(),
    };
  }

  private command(): 'session.create' | 'floor.create' {
    return this.floorKind === 'virtual' ? 'floor.create' : 'session.create';
  }

  private off(): string | null {
    const t = this.command();
    return this.host.unsupported(t) ? failureText(t, 'unknown_command', '') : null;
  }

  private bases() {
    return baseSessions(this.host.store.floors.values());
  }

  /** The base session the picker shows: the one picked while it is still there, else the first. */
  private pickedBase(): string | null {
    const all = this.bases();
    return all.find((b) => b.session === this.baseValue)?.session ?? all[0]?.session ?? null;
  }

  /** Switches the kind: the name field's label, rule and hint, and the base picker. What is typed stays. */
  private setKind(kind: FloorKind['id']): void {
    this.floorKind = kind;
    const w = WORDS[kind];
    this.nameLabel.textContent = w.label;
    this.input.placeholder = w.placeholder;
    this.input.maxLength = w.max + 1;
    this.input.classList.toggle('af-name--free', kind === 'virtual');
    this.sub.textContent = w.sub;
    this.tried = false;
    this.setError('');
    this.setBaseError('');
    if (!this.busy) this.setStatus('');
    this.render();
    if (this.input.value) this.check(false);
  }

  private render(): void {
    const off = this.off();
    this.offEl.hidden = !off;
    this.offEl.querySelector('p')!.textContent = off ?? '';
    for (const r of this.kinds.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
      r.checked = r.value === this.floorKind;
      r.disabled = this.busy;
    }
    this.input.disabled = this.busy;
    this.baseField.hidden = this.floorKind !== 'virtual';
    this.renderBases();
    const blocked = this.busy || !!off;
    this.add.setAttribute('aria-disabled', blocked ? 'true' : 'false');
    if (this.busy) this.add.setAttribute('aria-busy', 'true');
    else this.add.removeAttribute('aria-busy');
    this.add.querySelector('span')!.textContent = this.busy ? (this.floorKind === 'virtual' ? 'Adding floor…' : 'Starting floor…') : 'Add floor';
  }

  /** The picker's sessions (by their floor's name; asleep ones said so), the picked one selected. */
  private renderBases(): void {
    const all = this.bases();
    const picked = this.pickedBase();
    const key = JSON.stringify([all, picked]);
    if (this.base.dataset.key !== key) {
      this.base.dataset.key = key;
      this.base.replaceChildren(
        ...(all.length
          ? all.map((b) => h('option', { value: b.session, selected: b.session === picked }, `${b.name === b.session ? b.name : `${b.name} (session ${b.session})`}${b.asleep ? ' · asleep' : ''}`))
          : [h('option', { value: '', disabled: true, selected: true }, 'No herdr sessions yet')]),
      );
      this.base.value = picked ?? '';
    }
    this.base.disabled = this.busy || !all.length;
  }

  /** Checks the name: a wrong character or a taken name at once, the rest (empty) only once submitted. */
  private check(submitting: boolean): string {
    const v = this.input.value;
    const err = this.floorKind === 'virtual' ? floorNameError(v) : newSessionNameError(v, this.host.store.floors.keys());
    this.setError(submitting || this.tried || (err && v.trim()) ? err : '');
    return err;
  }

  private setError(msg: string): void {
    this.error = msg;
    this.input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    this.hint.textContent = msg || WORDS[this.floorKind].hint;
    this.hint.classList.toggle('field-error', !!msg);
  }

  private setBaseError(msg: string): void {
    this.baseError = msg;
    this.base.setAttribute('aria-invalid', msg ? 'true' : 'false');
    this.baseHint.textContent = msg || BASE_HINT;
    this.baseHint.classList.toggle('field-error', !!msg);
  }

  private setStatus(msg: string, error = false): void {
    this.statusText = msg;
    this.statusError = error && !!msg;
    this.alertEl.hidden = !error || !msg;
    this.statusEl.hidden = error || !msg;
    (error ? this.alertEl : this.statusEl).textContent = msg;
    (error ? this.statusEl : this.alertEl).textContent = '';
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const off = this.off();
    if (off) {
      this.setStatus(off, true);
      return;
    }
    this.tried = true;
    if (this.check(true)) {
      this.input.focus();
      return;
    }
    if (this.floorKind === 'virtual') {
      await this.submitVirtual();
      return;
    }
    const name = this.input.value;
    this.busy = true;
    this.setStatus(`Starting a herdr server for “${name}”…`);
    this.render();
    const r = await this.host.send('session.create', { name });
    this.busy = false;
    const open = this.dialog.open;
    if (r.ok) {
      this.setStatus('');
      this.render();
      this.close();
      this.added(name, 'session');
      return;
    }
    const msg = failureText('session.create', r.code, r.message, { name });
    this.render();
    if (open && r.code === 'unknown_command' && this.off()) {
      this.setStatus(''); // the callout says it
      return;
    }
    if (!open) {
      this.host.toast(msg, 'error');
      return;
    }
    // The name's own problems belong to the field; herdr's failures to the footer.
    if (r.code === 'bad_request' || r.code === 'name_taken') {
      this.setStatus('');
      this.setError(msg);
      this.input.focus();
    } else {
      this.setStatus(msg, true);
      this.add.focus();
    }
  }

  /** The new floor goes to the opener's `added`, else the host's. */
  private added(floor: string, kind: FloorKind['id']): void {
    const to = this.onAdded;
    this.onAdded = null;
    if (to) to(floor, kind);
    else this.host.added(floor, kind);
  }

  /** `floor.create`: a virtual floor on the picked session, acked with the new floor (its `floor.upsert` came first). */
  private async submitVirtual(): Promise<void> {
    const base = this.pickedBase();
    if (!base) {
      this.setBaseError('There is no herdr session to add it to yet: start one as a new herdr session first.');
      this.base.focus();
      return;
    }
    const name = this.input.value.trim();
    this.busy = true;
    this.setStatus(`Adding “${name}” on session ${base}…`);
    this.render();
    const r = await this.host.send('floor.create', { name, base_session: base });
    this.busy = false;
    const open = this.dialog.open;
    if (r.ok) {
      const id = (r.data as Floor | undefined)?.id;
      this.setStatus('');
      this.render();
      this.close();
      if (id) this.added(id, 'virtual');
      return;
    }
    const msg = failureText('floor.create', r.code, r.message, { floor: name });
    this.render();
    if (open && r.code === 'unknown_command' && this.off()) {
      this.setStatus('');
      return;
    }
    if (!open) {
      this.host.toast(msg, 'error');
      return;
    }
    if (r.code === 'bad_request') {
      this.setStatus('');
      this.setError(msg);
      this.input.focus();
    } else if (r.code === 'unknown_session') {
      this.setStatus('');
      this.setBaseError(msg);
      this.base.focus();
    } else {
      this.setStatus(msg, true);
      this.add.focus();
    }
  }
}
