import './addFloor.css';
import type { CommandResult } from '../net/client';
import type { CommandArgs, CommandName } from '../net/protocol';
import { FLOOR_KINDS, MAX_SESSION_NAME, newSessionNameError, type FloorKind } from '../world/addFloor';
import type { WorldStore } from '../world/store';
import { h, icon, ICON } from './dom';
import { failureText } from './messages';
import { backdropPolicy } from './dismiss';
import type { Hud } from './hud';

/**
 * #58 Add floor: a new floor from the city (the top bar's Add floor, the Buildings panel). It lists the kinds of floor
 * (for now only a new herdr session; a virtual floor on an existing session joins the list later), takes the name, and
 * sends `session.create`. The bridge answers once the floor is in the world, so on success the dialog hands the new
 * floor to `added` (the Buildings panel, where it moves into a building). A modal like the M4 dialogs: Enter adds,
 * Esc closes, focus returns to what opened it; a result that comes after it closed is a toast.
 */

export interface AddFloorHost {
  readonly store: WorldStore;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  unsupported(t: CommandName): boolean;
  toast(msg: string, kind: 'info' | 'error'): void;
  /** The new floor is in the world: show it where it can be moved into a building. */
  added(session: string): void;
}

/** What the dialog shows (test hook `window.__h3d.dialog()`). */
export interface AddFloorSummary {
  kind: 'add-floor';
  /** `busy` while `session.create` is on its way. */
  state: 'ready' | 'busy';
  floorKind: FloorKind['id'];
  name: string;
  /** The name field's error ('' when it has none). */
  error: string;
  status: string;
  statusError: boolean;
  /** Why floors cannot be added on this bridge, null when they can. */
  off: string | null;
}

/** The city's top bar button, next to Buildings. */
export function addFloorButton(hud: Hud, open: (from: HTMLElement) => void): HTMLButtonElement {
  const b = h('button', { class: 'btn', 'data-action': 'add-floor', title: 'Add floor: start a new herdr session as a floor' }, icon(ICON.plus), h('span', {}, 'Add floor'));
  b.addEventListener('click', () => open(b));
  hud.addTopbarButton(b, 'buildings', (mode) => mode === 'city');
  return b;
}

const HINT = 'Lowercase letters, digits, “_” and “-”. It names the floor and its herdr session.';

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
  private readonly hint = h('p', { id: 'af-name-hint', class: 'field-hint' }, HINT);
  private readonly offEl = h('div', { class: 'dd-callout', role: 'note' }, h('p', {}));
  private readonly statusEl = h('p', { class: 'dd-status', role: 'status' });
  private readonly alertEl = h('p', { class: 'dd-status dd-status--error', role: 'alert' });
  private readonly add = h('button', { class: 'btn btn--primary', type: 'submit', form: 'af-form', 'data-key': 'add' }, icon(ICON.plus), h('span', {}, 'Add floor'));
  private floorKind: FloorKind['id'] = FLOOR_KINDS[0]!.id;
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
      h('div', { class: 'dd-titles' }, h('h2', { id: 'af-title' }, 'Add floor'), h('p', { id: 'af-sub' }, 'It starts empty, in the Unassigned lot.')),
      close,
    );
    for (const k of FLOOR_KINDS) {
      const radio = h('input', { type: 'radio', name: 'af-kind', id: `af-kind-${k.id}`, value: k.id, 'aria-describedby': `af-kind-${k.id}-hint` });
      radio.addEventListener('change', () => {
        if (radio.checked) this.floorKind = k.id;
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
    this.body.append(this.offEl, this.kinds, h('div', { class: 'dd-field' }, h('label', { for: 'af-name' }, 'Session name'), this.input, this.hint));
    const cancel = h('button', { class: 'btn', type: 'button', 'data-key': 'cancel', onclick: () => this.close() }, 'Cancel');
    const foot = h('footer', { class: 'dd-foot' }, this.statusEl, this.alertEl, h('div', { class: 'dd-actions' }, cancel, this.add));
    this.dialog.append(head, this.body, foot);
    this.input.addEventListener('input', () => this.check(false));
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

  /** Opens it empty (focus comes back to `from` on close). While a floor is still starting it opens as it is. */
  open(from: HTMLElement | null = null): void {
    this.returnTo = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (!this.busy) {
      this.floorKind = FLOOR_KINDS[0]!.id;
      this.input.value = '';
      this.tried = false;
      this.setError('');
      this.setStatus('');
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
    return { kind: 'add-floor', state: this.busy ? 'busy' : 'ready', floorKind: this.floorKind, name: this.input.value, error: this.error, status: this.statusText, statusError: this.statusError, off: this.off() };
  }

  private off(): string | null {
    return this.host.unsupported('session.create') ? failureText('session.create', 'unknown_command', '') : null;
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
    const blocked = this.busy || !!off;
    this.add.setAttribute('aria-disabled', blocked ? 'true' : 'false');
    if (this.busy) this.add.setAttribute('aria-busy', 'true');
    else this.add.removeAttribute('aria-busy');
    this.add.querySelector('span')!.textContent = this.busy ? 'Starting floor…' : 'Add floor';
  }

  /** Checks the name: a wrong character or a taken name at once, the rest (empty) only once submitted. */
  private check(submitting: boolean): string {
    const err = newSessionNameError(this.input.value, this.host.store.floors.keys());
    this.setError(submitting || this.tried || (err && this.input.value) ? err : '');
    return err;
  }

  private setError(msg: string): void {
    this.error = msg;
    this.input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    this.hint.textContent = msg || HINT;
    this.hint.classList.toggle('field-error', !!msg);
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
      this.host.added(name);
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
}
