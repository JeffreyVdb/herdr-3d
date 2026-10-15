import type { CommandResult } from '../net/client';
import type { CommandArgs, CommandName } from '../net/protocol';
import { floorNameError, MAX_FLOOR_NAME, type FloorKind } from '../world/addFloor';
import type { FloorListBook, FloorRow } from '../world/floorList';
import { failureText } from './messages';
import { el } from './settings';
import type { SectionControl, SectionHandle } from './settings';

/** What the “Floors” section needs: the floors the world holds, the commands, and the Add floor dialog. */
export interface FloorsSectionHost {
  book: FloorListBook;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** The bridge said it has no such command. */
  unsupported(t: CommandName): boolean;
  /** Opens the Add floor dialog over Settings (focus comes back to `from`); the new floor goes to `added`. */
  addFloor(from: HTMLElement, added: (floor: string, kind: FloorKind['id']) => void): void;
}

let serial = 0;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** “Mochi”, “Mochi and Pixel”, “Mochi, Pixel and Tofu”. */
function names(list: readonly string[]): string {
  if (list.length < 2) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function button(text: string, key: string, cls = 'btn btn--sm'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.dataset.key = key;
  return b;
}

const HIDE_HINT =
  'A hidden floor is left out of the city, the buildings, the elevator and the lists while nobody works on it, for a session whose work all happens on its virtual floors. It shows again as soon as a worker is on it (a workspace opened in herdr itself lands on the session’s own floor), and while you stand on it.';

/** A row being renamed or deleted. */
type Edit = { id: string; kind: 'rename'; input: HTMLInputElement; error: string | null } | { id: string; kind: 'delete'; error: string | null; force: boolean };

/**
 * #58 stage 4: the “Floors” section of the Settings window. Every herdr session's own floor and the virtual floors on
 * it, grouped by session: Add floor (the dialog, on a virtual floor), Rename and Delete a virtual floor (inline; a
 * delete names the workers on it and, when there are any, moves them to the session's own floor with
 * `move_workers`, said so on the button), and Hide / Show for any floor (decision 2). Kept on the bridge, so a change
 * any client makes shows here at once. Only floors whose session is here are listed: the others come back with it.
 */
export function floorsSection(host: FloorsSectionHost): (body: HTMLElement, section: SectionControl) => SectionHandle {
  return (body) => {
    const id = `settings-fl-${++serial}`;
    const lede = el(
      'p',
      'settings-lede',
      'Every herdr session is a floor. A virtual floor is a floor of your own inside a session: its own name, desks, repository, board and whiteboard, while its workers’ workspaces open in that session. A floor whose session is away is listed again when it comes back.',
    );

    const block = el('div', 'settings-role settings-fl');
    block.setAttribute('role', 'group');
    const head = el('div', 'settings-role-head');
    const title = el('h4', 'settings-role-title', 'By herdr session');
    title.id = `${id}-h`;
    block.setAttribute('aria-labelledby', title.id);
    const add = button('Add floor', 'add-floor');
    add.setAttribute('aria-haspopup', 'dialog');
    head.append(title, add);
    const summary = el('p', 'settings-field-hint settings-used');
    const list = el('ul', 'settings-fl-sessions');
    list.setAttribute('aria-label', 'Floors by herdr session');
    const empty = el('p', 'settings-field-hint settings-fl-empty', 'No floors yet: herdr-world has found no herdr session. Add one as a new herdr session.');
    const status = el('p', 'settings-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const hideHint = el('p', 'settings-field-hint', HIDE_HINT);
    hideHint.id = `${id}-hide-hint`;
    block.append(head, summary, list, empty, status, hideHint);
    body.append(lede, block);

    let edit: Edit | null = null;
    /** Rows with a command on its way (their controls wait). */
    const busy = new Set<string>();
    let note: { text: string; error: boolean } | null = null;

    const off = (t: CommandName) => (host.unsupported(t) ? failureText(t, 'unknown_command', '') : null);

    function meta(r: FloorRow): string {
      const where = r.virtual ? `Virtual floor on session ${r.session}` : 'The herdr session’s own floor';
      const who = r.workers.length ? plural(r.workers.length, 'worker') : 'Nobody works here';
      return `${where} · ${who}${r.asleep ? ' · asleep' : ''}`;
    }

    function badge(text: string, state: string): HTMLElement {
      const b = el('span', 'settings-badge', text);
      b.dataset.state = state;
      return b;
    }

    function rowItem(r: FloorRow): HTMLLIElement {
      const li = el('li', 'settings-fl-row');
      li.dataset.floor = r.id;
      if (r.virtual) li.dataset.virtual = 'true';
      const line = el('div', 'settings-fl-line');
      const text = el('div', 'settings-fl-text');
      const name = el('span', `settings-fl-name${r.virtual ? '' : ' settings-fl-name--session'}`, r.name);
      const sub = el('span', 'settings-fl-meta', meta(r));
      text.append(name, sub);
      line.append(text);
      if (r.hidden) line.append(badge('Hidden', r.workers.length ? 'incomplete' : 'off'));
      const tools = el('div', 'settings-fl-tools');
      const waiting = busy.has(r.id) || (!!edit && edit.id === r.id);

      const hideOff = off('floor.hide');
      const hide = button(r.hidden ? 'Show' : 'Hide', `hide:${r.id}`);
      hide.setAttribute('aria-label', `${r.hidden ? 'Show' : 'Hide'} ${r.name}`);
      hide.setAttribute('aria-describedby', hideHint.id);
      hide.title = hideOff ?? (r.hidden ? `List ${r.name} again everywhere` : `Leave ${r.name} out of the lists while nobody works on it`);
      hide.disabled = busy.has(r.id) || !!hideOff;
      hide.addEventListener('click', () => void setHidden(r, !r.hidden));
      tools.append(hide);

      if (r.virtual) {
        const rename = button('Rename', `rename:${r.id}`);
        rename.setAttribute('aria-label', `Rename ${r.name}`);
        rename.disabled = waiting || !!off('floor.rename');
        if (off('floor.rename')) rename.title = off('floor.rename')!;
        rename.addEventListener('click', () => startRename(r));
        const del = button('Delete', `delete:${r.id}`, 'btn btn--sm btn--danger-quiet');
        del.setAttribute('aria-label', `Delete ${r.name}`);
        del.disabled = waiting || !!off('floor.delete');
        if (off('floor.delete')) del.title = off('floor.delete')!;
        del.addEventListener('click', () => startDelete(r));
        tools.append(rename, del);
      }
      line.append(tools);
      li.append(line);

      if (r.hidden && r.workers.length) li.append(el('p', 'settings-field-hint', `Hidden, but listed while ${names(r.workers)} ${r.workers.length === 1 ? 'works' : 'work'} on it.`));
      if (edit?.id === r.id && edit.kind === 'rename') li.append(renameForm(r, edit));
      if (edit?.id === r.id && edit.kind === 'delete') li.append(deleteConfirm(r, edit));
      return li;
    }

    function renameForm(r: FloorRow, e: Extract<Edit, { kind: 'rename' }>): HTMLElement {
      const form = el('div', 'settings-field settings-fl-edit');
      form.setAttribute('role', 'group');
      form.setAttribute('aria-label', `Rename ${r.name}`);
      const hint = el('p', `settings-field-hint${e.error ? ' settings-field-error' : ''}`, e.error ?? `Any name, up to ${MAX_FLOOR_NAME} bytes. Only the game shows it.`);
      hint.id = `${id}-rn-hint`;
      e.input.setAttribute('aria-describedby', hint.id);
      e.input.setAttribute('aria-invalid', String(!!e.error));
      e.input.disabled = busy.has(r.id);
      const save = button(busy.has(r.id) ? 'Saving…' : 'Save', `rename-save:${r.id}`, 'btn btn--sm btn--primary');
      save.disabled = busy.has(r.id);
      save.addEventListener('click', () => void saveRename(r.id));
      const cancel = button('Cancel', `rename-cancel:${r.id}`);
      cancel.disabled = busy.has(r.id);
      cancel.addEventListener('click', () => endEdit(`rename:${r.id}`));
      const row = el('div', 'settings-row');
      row.append(e.input, save, cancel);
      form.append(row, hint);
      return form;
    }

    function deleteConfirm(r: FloorRow, e: Extract<Edit, { kind: 'delete' }>): HTMLElement {
      const box = el('div', 'settings-fl-confirm');
      box.setAttribute('role', 'group');
      const q = el('p', 'settings-fl-confirm-title', `Delete ${r.name}?`);
      q.id = `${id}-del-${r.id}`;
      box.setAttribute('aria-labelledby', q.id);
      const n = r.workers.length;
      const move = n > 0 || e.force;
      const real = host.book.row(r.session)?.name ?? r.session;
      const what = move
        ? n > 0
          ? `${names(r.workers)} ${n === 1 ? 'works' : 'work'} on it. Deleting it moves ${n === 1 ? 'that worker' : `these ${n} workers`} to ${real}, session ${r.session}’s own floor, at its free desks; a name already taken there changes.`
          : `herdr-world counts workers on it this client does not show. Deleting it moves them to ${real}, session ${r.session}’s own floor.`
        : 'Nobody works on it.';
      const body = el('p', 'settings-field-hint', `${what} Its desks, settings, board and last hire go with it; its whiteboard and filed handoffs stay on the bridge.`);
      body.id = `${id}-del-${r.id}-body`;
      box.setAttribute('aria-describedby', body.id);
      box.append(q, body);
      if (e.error) {
        const err = el('p', 'settings-field-hint settings-field-error', e.error);
        err.setAttribute('role', 'alert');
        box.append(err);
      }
      const actions = el('div', 'settings-fl-confirm-actions');
      const keep = button('Keep it', `delete-cancel:${r.id}`);
      keep.disabled = busy.has(r.id);
      keep.addEventListener('click', () => endEdit(`delete:${r.id}`));
      const label = busy.has(r.id) ? 'Deleting…' : move ? (n > 0 ? `Move ${plural(n, 'worker')} and delete` : 'Move its workers and delete') : 'Delete floor';
      const ok = button(label, `delete-ok:${r.id}`, 'btn btn--sm btn--danger');
      ok.disabled = busy.has(r.id);
      ok.addEventListener('click', () => void remove(r.id, move));
      actions.append(keep, ok);
      box.append(actions);
      return box;
    }

    function sync(): void {
      const groups = host.book.groups;
      // A row that went (another client deleted it) takes its edit along.
      if (edit && !host.book.row(edit.id)) edit = null;
      const had = document.activeElement instanceof HTMLElement && block.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
      const typing = edit?.kind === 'rename' && document.activeElement === edit.input;
      const items = groups.map((g) => {
        const li = el('li', 'settings-fl-session');
        const rows = el('ul', 'settings-fl-rows');
        rows.setAttribute('aria-label', `Session ${g.session}`);
        if (g.real) rows.append(rowItem(g.real));
        for (const v of g.virtual) rows.append(rowItem(v));
        li.append(rows);
        return li;
      });
      list.replaceChildren(...items);
      list.hidden = groups.length === 0;
      empty.hidden = groups.length > 0;
      const total = groups.reduce((n, g) => n + (g.real ? 1 : 0) + g.virtual.length, 0);
      const virtual = groups.reduce((n, g) => n + g.virtual.length, 0);
      const hidden = groups.reduce((n, g) => n + [g.real, ...g.virtual].filter((r) => r?.hidden).length, 0);
      summary.textContent = groups.length
        ? `${plural(total, 'floor')} on ${plural(groups.length, 'herdr session')}: ${plural(virtual, 'virtual floor')}${hidden ? `, ${hidden} hidden` : ''}.`
        : '';
      summary.hidden = !groups.length;
      add.disabled = false;
      status.textContent = note?.text ?? '';
      status.classList.toggle('settings-field-error', !!note?.error);
      status.hidden = !note;
      // The DOM was rebuilt: focus goes back to the control that had it (the rename field keeps its caret).
      if (typing && edit?.kind === 'rename') edit.input.focus({ preventScroll: true });
      else if (had && !block.contains(document.activeElement)) focusByKey(had);
    }

    function focusByKey(key: string): void {
      const b = block.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
      if (b && !(b as HTMLButtonElement).disabled) b.focus({ preventScroll: true });
    }

    function startRename(r: FloorRow): void {
      const input = el('input', 'settings-fl-input');
      input.type = 'text';
      input.value = r.name;
      input.maxLength = MAX_FLOOR_NAME + 1;
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.dataset.key = `rename-input:${r.id}`;
      input.setAttribute('aria-label', `New name for ${r.name}`);
      input.addEventListener('input', () => {
        if (edit?.kind === 'rename' && edit.error) {
          edit.error = null;
          sync();
        }
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void saveRename(r.id);
        } else if (e.key === 'Escape') {
          // The rename ends, the Settings window stays.
          e.preventDefault();
          e.stopPropagation();
          endEdit(`rename:${r.id}`);
        }
      });
      edit = { id: r.id, kind: 'rename', input, error: null };
      note = null;
      sync();
      input.focus();
      input.select();
    }

    function startDelete(r: FloorRow): void {
      edit = { id: r.id, kind: 'delete', error: null, force: false };
      note = null;
      sync();
      focusByKey(`delete-cancel:${r.id}`);
    }

    function endEdit(focus: string): void {
      edit = null;
      sync();
      focusByKey(focus);
    }

    async function saveRename(floor: string): Promise<void> {
      if (edit?.kind !== 'rename' || edit.id !== floor || busy.has(floor)) return;
      const r = host.book.row(floor);
      if (!r) return;
      const name = edit.input.value.trim();
      const why = floorNameError(edit.input.value);
      if (why) {
        edit.error = why;
        sync();
        edit.input.focus();
        return;
      }
      if (name === r.name) {
        endEdit(`rename:${floor}`);
        return;
      }
      busy.add(floor);
      sync();
      const res = await host.send('floor.rename', { floor, name });
      busy.delete(floor);
      if (res.ok) {
        note = { text: `Renamed ${r.name} to ${name}.`, error: false };
        if (edit?.id === floor) edit = null;
        sync();
        focusByKey(`rename:${floor}`);
        return;
      }
      const msg = failureText('floor.rename', res.code, res.message, { floor: r.name });
      if (edit?.kind === 'rename' && edit.id === floor && res.code === 'bad_request') {
        edit.error = msg;
        sync();
        edit.input.focus();
        return;
      }
      note = { text: msg, error: true };
      sync();
      if (edit?.kind === 'rename' && edit.id === floor) edit.input.focus();
    }

    async function remove(floor: string, move: boolean): Promise<void> {
      if (busy.has(floor)) return;
      const r = host.book.row(floor);
      if (!r) return;
      busy.add(floor);
      sync();
      const res = await host.send('floor.delete', move ? { floor, move_workers: true } : { floor });
      busy.delete(floor);
      if (res.ok) {
        if (edit?.id === floor) edit = null;
        const moved = move && r.workers.length ? ` ${names(r.workers)} moved to ${host.book.row(r.session)?.name ?? r.session}.` : '';
        note = { text: `Deleted ${r.name}.${moved}`, error: false };
        sync();
        add.focus({ preventScroll: true });
        return;
      }
      const msg = failureText('floor.delete', res.code, res.message, { floor: r.name });
      if (edit?.kind === 'delete' && edit.id === floor) {
        edit.error = msg;
        // The bridge counts workers this client does not see (an away session's, a hire on its way): offer the move.
        if (res.code === 'invalid_state') edit.force = true;
        sync();
        focusByKey(`delete-ok:${floor}`);
        return;
      }
      note = { text: msg, error: true };
      sync();
    }

    async function setHidden(r: FloorRow, hidden: boolean): Promise<void> {
      if (busy.has(r.id)) return;
      busy.add(r.id);
      sync();
      const res = await host.send('floor.hide', { floor: r.id, hidden });
      busy.delete(r.id);
      if (res.ok) {
        const shows = r.workers.length ? ` It stays listed while ${names(r.workers)} ${r.workers.length === 1 ? 'works' : 'work'} on it.` : '';
        note = { text: hidden ? `${r.name} is hidden.${shows}` : `${r.name} is listed again.`, error: false };
      } else note = { text: failureText('floor.hide', res.code, res.message, { floor: r.name }), error: true };
      sync();
      focusByKey(`hide:${r.id}`);
    }

    add.addEventListener('click', () =>
      host.addFloor(add, (floor, kind) => {
        const r = host.book.row(floor);
        // A virtual floor's id is never shown: its row (its floor.upsert came before the ack) names it.
        const text = kind === 'session' ? `Added ${r?.name ?? floor}. It waits in the Unassigned lot: move it into a building from Buildings.` : r ? `Added ${r.name} on session ${r.session}.` : 'Added the floor.';
        note = { text, error: false };
        sync();
      }),
    );

    const offChange = host.book.onChange(sync);
    sync();
    return {
      open() {
        note = null;
        edit = null;
        sync();
      },
      dispose: offChange,
    };
  };
}
