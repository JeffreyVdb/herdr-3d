import type { CodexProfile, CodexProfilesState, CommandArgs, CommandName } from '../net/protocol';
import type { CommandResult } from '../net/client';
import { codexProfilesFailureText, PROFILE_MAX_NAME, profileNameProblem, profilePathProblem, type CodexProfilesBook } from '../world/codexProfiles';
import { el } from './settings';
import type { SectionControl, SectionHandle } from './settings';

/** What the “Codex profiles” section needs: the bridge's list, and the commands. */
export interface CodexProfilesSectionHost {
  book: CodexProfilesBook;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
}

let serial = 0;

function button(text: string, key: string, cls = 'btn btn--sm'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.dataset.key = key;
  return b;
}

function badge(text: string, state: string): HTMLElement {
  const b = el('span', 'settings-badge', text);
  b.dataset.state = state;
  return b;
}

const ADD_HINT = 'A Codex home folder on the bridge host: an absolute path, or one under ~/.';

/**
 * #138: the “Codex profiles” section of the Settings window. A profile is a Codex home folder with its own sign-in:
 * the bridge's own ($CODEX_HOME, else ~/.codex), every ~/.codex-* folder with an auth.json, and the folders added
 * here. Each row has its name (Rename in place), its folder, its plan when a reading had one, whether it is signed in,
 * the default marker, Hide / Show (not the default) and Remove (added folders only); under the list, Add folder with
 * the bridge's refusal under the field. Kept on the bridge, so every client sees the same; a hidden profile's limits
 * are not read. A row is a column (its line, then its folder), so per-profile options can go under it later.
 */
export function codexProfilesSection(host: CodexProfilesSectionHost): (body: HTMLElement, section: SectionControl) => SectionHandle {
  return (body, section) => {
    const id = `settings-cp-${++serial}`;
    const lede = el('p', 'settings-lede', 'A profile is a Codex home folder with its own sign-in. Add one with ');
    lede.append(el('code', '', 'CODEX_HOME=~/.codex-<name> codex login'), '.');

    const block = el('div', 'settings-role settings-cp');
    block.setAttribute('role', 'group');
    const head = el('div', 'settings-role-head');
    const title = el('h4', 'settings-role-title', 'Profiles');
    title.id = `${id}-h`;
    block.setAttribute('aria-labelledby', title.id);
    head.append(title);
    const summary = el('p', 'settings-field-hint settings-used');
    summary.setAttribute('aria-live', 'polite');
    const list = el('ul', 'settings-cp-list');
    list.setAttribute('aria-label', 'Codex profiles');

    const addField = el('div', 'settings-field');
    const addLabel = el('label', 'settings-field-label', 'Add a folder');
    const add = el('input');
    add.type = 'text';
    add.id = addLabel.htmlFor = `${id}-add`;
    add.placeholder = '~/.codex-team';
    add.spellcheck = false;
    add.autocomplete = 'off';
    add.dataset.key = 'add-input';
    add.setAttribute('autocapitalize', 'off');
    const addBtn = button('Add folder', 'add');
    const addRow = el('div', 'settings-row');
    addRow.append(add, addBtn);
    const addHint = el('p', 'settings-field-hint', ADD_HINT);
    addHint.id = `${id}-add-hint`;
    add.setAttribute('aria-describedby', addHint.id);
    addField.append(addLabel, addRow, addHint);

    const status = el('p', 'settings-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    block.append(head, summary, list, addField, status);
    body.append(lede, block);

    /** The profile being renamed, its field and the refusal under it. */
    let rename: { key: string; input: HTMLInputElement; error: string | null } | null = null;
    const busy = new Set<string>();
    let adding = false;
    let addError: string | null = null;
    let note: { text: string; error: boolean } | null = null;

    const st = (): CodexProfilesState | null => host.book.state;

    function stateBadges(p: CodexProfile): HTMLElement[] {
      const out: HTMLElement[] = [];
      if (p.default) out.push(badge('Default', 'ready'));
      if (p.hidden) out.push(badge('Hidden', 'off'));
      if (p.missing) out.push(badge('Folder not found', 'invalid'));
      else out.push(p.signed_in ? badge('Signed in', 'ready') : badge('Not signed in', 'incomplete'));
      return out;
    }

    function rowItem(p: CodexProfile, all: readonly CodexProfile[]): HTMLLIElement {
      const li = el('li', 'settings-cp-row');
      li.dataset.profile = p.key;
      if (p.hidden) li.dataset.hidden = 'true';
      const line = el('div', 'settings-cp-line');
      const name = el('span', 'settings-cp-name', p.name);
      const states = el('span', 'settings-cp-states');
      states.append(...stateBadges(p));
      const tools = el('div', 'settings-cp-tools');
      const waiting = busy.has(p.key);
      const ren = button('Rename', `rename:${p.key}`);
      ren.setAttribute('aria-label', `Rename ${p.name}`);
      ren.disabled = waiting || rename?.key === p.key;
      ren.addEventListener('click', () => startRename(p));
      tools.append(ren);
      if (!p.default) {
        const hide = button(p.hidden ? 'Show' : 'Hide', `hide:${p.key}`);
        hide.setAttribute('aria-label', `${p.hidden ? 'Show' : 'Hide'} ${p.name}`);
        hide.title = p.hidden ? `Read ${p.name}'s limits again` : `Stop reading ${p.name}'s limits and take it off the meter`;
        hide.disabled = waiting;
        hide.addEventListener('click', () => void change({ key: p.key, hidden: !p.hidden }, p.key, p.hidden ? `${p.name} is read again.` : `${p.name} is hidden: its limits are not read.`, `hide:${p.key}`));
        tools.append(hide);
      }
      if (p.added) {
        const rm = button('Remove', `remove:${p.key}`, 'btn btn--sm btn--danger-quiet');
        rm.setAttribute('aria-label', `Remove ${p.name}`);
        rm.title = 'Remove this folder from the list (the folder itself stays)';
        rm.disabled = waiting;
        rm.addEventListener('click', () => void change({ key: p.key, remove: true }, p.key, `Removed ${p.name}. The folder itself is untouched.`, 'add-input'));
        tools.append(rm);
      }
      line.append(name, states, tools);
      const where = el('p', 'settings-cp-where');
      where.append(el('code', 'settings-cp-path', p.display));
      if (p.plan) where.append(el('span', 'settings-cp-plan', `${p.plan} plan`));
      where.title = p.path;
      li.append(line, where);
      if (rename?.key === p.key) li.append(renameForm(p, all));
      return li;
    }

    function renameForm(p: CodexProfile, all: readonly CodexProfile[]): HTMLElement {
      const r = rename!;
      const form = el('div', 'settings-field settings-cp-edit');
      form.setAttribute('role', 'group');
      form.setAttribute('aria-label', `Rename ${p.name}`);
      const hint = el('p', `settings-field-hint${r.error ? ' settings-field-error' : ''}`, r.error ?? `Up to ${PROFILE_MAX_NAME} characters. Its folder keeps its name.`);
      hint.id = `${id}-rn-hint`;
      r.input.setAttribute('aria-describedby', hint.id);
      r.input.setAttribute('aria-invalid', String(!!r.error));
      r.input.disabled = busy.has(p.key);
      const save = button(busy.has(p.key) ? 'Saving…' : 'Save', `rename-save:${p.key}`, 'btn btn--sm btn--primary');
      save.disabled = busy.has(p.key);
      save.addEventListener('click', () => void saveRename(p, all));
      const cancel = button('Cancel', `rename-cancel:${p.key}`);
      cancel.disabled = busy.has(p.key);
      cancel.addEventListener('click', () => endRename(p.key));
      const row = el('div', 'settings-row');
      row.append(r.input, save, cancel);
      form.append(row, hint);
      return form;
    }

    function startRename(p: CodexProfile): void {
      const input = el('input', 'settings-cp-input');
      input.type = 'text';
      input.value = p.name;
      input.maxLength = PROFILE_MAX_NAME + 8;
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.dataset.key = `rename-input:${p.key}`;
      input.setAttribute('aria-label', `New name for ${p.name}`);
      input.addEventListener('input', () => {
        if (rename?.error) {
          rename.error = null;
          sync();
        }
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const s = st();
          if (s) void saveRename(p, s.profiles);
        } else if (e.key === 'Escape') {
          // The rename ends, the Settings window stays.
          e.preventDefault();
          e.stopPropagation();
          endRename(p.key);
        }
      });
      rename = { key: p.key, input, error: null };
      note = null;
      sync();
      input.focus();
      input.select();
    }

    function endRename(key: string): void {
      rename = null;
      sync();
      focusByKey(`rename:${key}`);
    }

    async function saveRename(p: CodexProfile, all: readonly CodexProfile[]): Promise<void> {
      const r = rename;
      if (!r || r.key !== p.key || busy.has(p.key)) return;
      const name = r.input.value.trim();
      if (name === p.name) return endRename(p.key);
      r.error = profileNameProblem(r.input.value, p.key, all);
      if (r.error) {
        sync();
        r.input.focus();
        return;
      }
      busy.add(p.key);
      sync();
      const res = await host.send('codex_profiles.set', { key: p.key, name });
      busy.delete(p.key);
      if (res.ok) {
        host.book.upsert(res.data);
        note = { text: `Renamed ${p.name} to ${name}.`, error: false };
        if (rename?.key === p.key) rename = null;
        sync();
        focusByKey(`rename:${p.key}`);
        return;
      }
      const why = codexProfilesFailureText(res.code, res.message);
      if (rename?.key === p.key && res.code === 'bad_request') {
        rename.error = why;
        sync();
        rename.input.focus();
        return;
      }
      note = { text: why, error: true };
      sync();
    }

    /** Sends one change of profile `key`; `focus` is the control that takes the focus after. */
    async function change(args: CommandArgs['codex_profiles.set'], key: string, done: string, focus: string): Promise<void> {
      if (busy.has(key)) return;
      busy.add(key);
      note = null;
      sync();
      const res = await host.send('codex_profiles.set', args);
      busy.delete(key);
      if (res.ok) host.book.upsert(res.data);
      else if (res.code === 'not_found') void host.send('codex_profiles.get', {}).then((r) => r.ok && host.book.upsert(r.data));
      note = res.ok ? { text: done, error: false } : { text: codexProfilesFailureText(res.code, res.message), error: true };
      sync();
      focusByKey(focus);
    }

    async function addFolder(): Promise<void> {
      const s = st();
      if (!s || adding) return;
      addError = profilePathProblem(add.value, s.profiles);
      if (addError) {
        note = null;
        sync();
        add.focus();
        return;
      }
      adding = true;
      note = null;
      sync();
      const res = await host.send('codex_profiles.set', { add: add.value.trim() });
      adding = false;
      if (res.ok) {
        const before = new Set(s.profiles.map((p) => p.key));
        host.book.upsert(res.data);
        const added = host.book.state?.profiles.find((p) => !before.has(p.key));
        note = { text: added ? `Added ${added.display} as ${added.name}.${added.signed_in ? '' : ' It is not signed in yet.'}` : 'Added the folder.', error: false };
        add.value = '';
      } else if (res.code === 'bad_request') addError = codexProfilesFailureText(res.code, res.message);
      else note = { text: codexProfilesFailureText(res.code, res.message), error: true };
      sync();
      add.focus({ preventScroll: true });
    }

    function focusByKey(key: string): void {
      const b = block.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
      if (b && !(b as HTMLButtonElement).disabled) b.focus({ preventScroll: true });
    }

    function sync(): void {
      const s = st();
      section.setHidden(!s);
      if (!s) return;
      if (rename && !s.profiles.some((p) => p.key === rename!.key)) rename = null;
      const had = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
      const typing = !!rename && document.activeElement === rename.input;
      list.replaceChildren(...s.profiles.map((p) => rowItem(p, s.profiles)));
      const hidden = s.profiles.filter((p) => p.hidden).length;
      summary.textContent = `Codex profiles: ${s.profiles.length}${hidden ? ` (${hidden} hidden)` : ''}`;
      add.disabled = addBtn.disabled = adding;
      addBtn.textContent = adding ? 'Adding…' : 'Add folder';
      add.setAttribute('aria-invalid', String(!!addError));
      addHint.textContent = addError ?? ADD_HINT;
      addHint.classList.toggle('settings-field-error', !!addError);
      status.textContent = note?.text ?? '';
      status.classList.toggle('settings-field-error', !!note?.error);
      status.hidden = !note;
      // The list was rebuilt: focus goes back to the control that had it (the rename field keeps its caret).
      if (typing && rename) rename.input.focus({ preventScroll: true });
      else if (had && !list.contains(document.activeElement)) focusByKey(had);
    }

    add.addEventListener('input', () => {
      if (!addError) return;
      addError = null;
      sync();
    });
    add.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      void addFolder();
    });
    addBtn.addEventListener('click', () => void addFolder());

    const off = host.book.onChange(sync);
    sync();
    return {
      open() {
        note = null;
        addError = null;
        rename = null;
        sync();
      },
      dispose: off,
    };
  };
}
