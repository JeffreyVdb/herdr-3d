import type { CodexProfile, CodexProfilesState, CodexRule, CommandArgs, CommandName } from '../net/protocol';
import type { CommandResult } from '../net/client';
import {
  codexProfilesFailureText,
  PROFILE_MAX_NAME,
  profileNameProblem,
  profilePathProblem,
  ruleProfileProblem,
  ruleRefusal,
  RULES_MAX,
  rulesProblem,
  type CodexProfilesBook,
} from '../world/codexProfiles';
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
const RULES_LEDE =
  'An Auto hire takes the first rule that matches its repo on GitHub or its folder. With none, it takes the profile with the most left of those that may be used for anything, else the default.';
const RULES_EMPTY = 'No rules yet.';
const MATCH_HINT = 'github.com/<owner>/*, github.com/<owner>/<repo>, or a folder: /… or ~/…';

/**
 * #138: the “Codex profiles” section of the Settings window. A profile is a Codex home folder with its own sign-in:
 * the bridge's own ($CODEX_HOME, else ~/.codex), every ~/.codex-* folder with an auth.json, and the folders added
 * here. Each row has its name (Rename in place), its folder, its plan when a reading had one, whether it is signed in,
 * the default marker, Hide / Show (not the default) and Remove (added folders only); under the list, Add folder with
 * the bridge's refusal under the field. Kept on the bridge, so every client sees the same; a hidden profile's limits
 * are not read. A row is a column (its line, then its folder), so per-profile options can go under it later.
 * #140, on a bridge with Auto: under each folder, "May be used for anything" (one change, sent at once); under the
 * list, the Auto rules: an ordered list edited as a draft (each row a match and the profile it hires on; add, move,
 * remove), saved whole with one `codex_profiles.set` so a new order lands at once, the bridge's refusal under its row.
 */
export function codexProfilesSection(host: CodexProfilesSectionHost): (body: HTMLElement, section: SectionControl) => SectionHandle {
  return (body, section) => {
    const id = `settings-cp-${++serial}`;
    const lede = el('p', 'settings-lede', 'A profile is a Codex home folder with its own sign-in. Add one with ');
    lede.append(el('code', 'settings-cp-cmd', 'mkdir ~/.codex-<name> && CODEX_HOME=~/.codex-<name> codex login'), '.');

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

    // #140: the Auto rules.
    const rulesBlock = el('div', 'settings-role settings-cp settings-cp-auto');
    rulesBlock.setAttribute('role', 'group');
    const rulesHead = el('div', 'settings-role-head');
    const rulesTitle = el('h4', 'settings-role-title', 'Auto rules');
    rulesTitle.id = `${id}-rh`;
    rulesBlock.setAttribute('aria-labelledby', rulesTitle.id);
    rulesHead.append(rulesTitle);
    const rulesLede = el('p', 'settings-field-hint settings-used', RULES_LEDE);
    const rulesList = el('ol', 'settings-cp-rules');
    rulesList.setAttribute('aria-label', 'Auto rules');
    const rulesEmpty = el('p', 'settings-field-hint settings-cp-rules-empty', RULES_EMPTY);
    const rulesTools = el('div', 'settings-cp-rules-tools');
    const addRule = button('Add rule', 'rule-add');
    const saveRules = button('Save rules', 'rules-save', 'btn btn--sm btn--primary');
    const discardRules = button('Discard changes', 'rules-discard');
    rulesTools.append(addRule, saveRules, discardRules);
    const rulesStatus = el('p', 'settings-status');
    rulesStatus.setAttribute('role', 'status');
    rulesStatus.setAttribute('aria-live', 'polite');
    rulesBlock.append(rulesHead, rulesLede, rulesList, rulesEmpty, rulesTools, rulesStatus);
    body.append(lede, block, rulesBlock);

    /** The profile being renamed, its field and the refusal under it. */
    let rename: { key: string; input: HTMLInputElement; error: string | null } | null = null;
    const busy = new Set<string>();
    let adding = false;
    let addError: string | null = null;
    let note: { text: string; error: boolean } | null = null;
    /** #140: the rules being edited (null: as the bridge has them), what is wrong with one (its row) or all, saving. */
    let draft: CodexRule[] | null = null;
    let ruleError: { index: number | null; text: string } | null = null;
    let rulesNote: { text: string; error: boolean } | null = null;
    let savingRules = false;

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
      if (st()?.auto) li.append(anythingSwitch(p, waiting));
      if (rename?.key === p.key) li.append(renameForm(p, all));
      return li;
    }

    /** #140: "May be used for anything": sent at once, like Hide. */
    function anythingSwitch(p: CodexProfile, waiting: boolean): HTMLElement {
      const sw = el('label', 'settings-switch settings-cp-anything');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = p.anything === true;
      box.disabled = waiting;
      box.dataset.key = `anything:${p.key}`;
      box.addEventListener('change', () => {
        const on = box.checked;
        void change({ key: p.key, anything: on }, p.key, on ? `Auto may hire on ${p.name} when no rule matches.` : `Auto hires on ${p.name} only by a rule.`, `anything:${p.key}`);
      });
      sw.append(box, el('span', '', 'May be used for anything'));
      sw.title = 'An Auto hire that no rule decides may land on this profile';
      return sw;
    }

    const rulesNow = (): CodexRule[] => draft ?? st()?.rules ?? [];

    /** The rules to edit: a copy of the bridge's on the first change. */
    function editing(): CodexRule[] {
      if (!draft) draft = rulesNow().map((r) => ({ ...r }));
      return draft;
    }

    function ruleRow(r: CodexRule, i: number, n: number, profiles: readonly CodexProfile[]): HTMLLIElement {
      const li = el('li', 'settings-cp-rule settings-field');
      li.dataset.rule = String(i);
      const line = el('div', 'settings-cp-rule-line');
      const num = el('span', 'settings-cp-rule-n', String(i + 1));
      num.setAttribute('aria-hidden', 'true');
      const match = el('input', 'settings-cp-match');
      match.type = 'text';
      match.value = r.match;
      match.placeholder = 'github.com/acme/*';
      match.spellcheck = false;
      match.autocomplete = 'off';
      match.setAttribute('autocapitalize', 'off');
      match.dataset.key = `rule-match:${i}`;
      match.setAttribute('aria-label', `Rule ${i + 1}: repo or folder`);
      match.disabled = savingRules;
      match.addEventListener('input', () => {
        editing()[i]!.match = match.value;
        if (ruleError) ruleError = null;
        rulesNote = null;
        syncRuleTools();
      });
      match.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        void save();
      });
      const pick = el('select', 'settings-cp-rule-profile');
      pick.dataset.key = `rule-profile:${i}`;
      pick.setAttribute('aria-label', `Rule ${i + 1}: profile`);
      pick.disabled = savingRules;
      if (!r.profile) pick.append(new Option('Choose a profile', '', true, true));
      for (const p of profiles) pick.append(new Option(p.hidden ? `${p.name} (hidden)` : p.name, p.key, false, p.key === r.profile));
      if (r.profile && !profiles.some((p) => p.key === r.profile)) pick.append(new Option(`${r.profile} (gone)`, r.profile, false, true));
      pick.addEventListener('change', () => {
        editing()[i]!.profile = pick.value;
        if (ruleError) ruleError = null;
        rulesNote = null;
        syncRules();
      });
      const tools = el('div', 'settings-cp-tools');
      const up = button('Up', `rule-up:${i}`);
      up.setAttribute('aria-label', `Move rule ${i + 1} up`);
      up.disabled = savingRules || i === 0;
      up.addEventListener('click', () => move(i, -1));
      const down = button('Down', `rule-down:${i}`);
      down.setAttribute('aria-label', `Move rule ${i + 1} down`);
      down.disabled = savingRules || i === n - 1;
      down.addEventListener('click', () => move(i, 1));
      const rm = button('Remove', `rule-remove:${i}`, 'btn btn--sm btn--danger-quiet');
      rm.setAttribute('aria-label', `Remove rule ${i + 1}`);
      rm.disabled = savingRules;
      rm.addEventListener('click', () => {
        editing().splice(i, 1);
        ruleError = null;
        rulesNote = null;
        syncRules();
        focusRule(Math.min(i, rulesNow().length - 1), 'rule-remove', 'rule-add');
      });
      tools.append(up, down, rm);
      line.append(num, match, pick, tools);
      li.append(line);
      const err = ruleError?.index === i ? ruleError.text : null;
      const warn = err ? null : r.profile ? ruleProfileProblem(r.profile, profiles) : null;
      match.setAttribute('aria-invalid', String(!!err));
      if (err || warn) {
        const hint = el('p', `settings-field-hint${err ? ' settings-field-error' : ''}`, err ?? warn ?? '');
        hint.id = `${id}-rule-${i}`;
        match.setAttribute('aria-describedby', hint.id);
        li.append(hint);
      }
      return li;
    }

    function move(i: number, by: number): void {
      const rules = editing();
      const j = i + by;
      if (j < 0 || j >= rules.length) return;
      [rules[i], rules[j]] = [rules[j]!, rules[i]!];
      ruleError = null;
      rulesNote = null;
      syncRules();
      // The focus follows the rule; at an end it stays on the other button.
      focusRule(j, by < 0 ? 'rule-up' : 'rule-down', by < 0 ? `rule-down:${j}` : `rule-up:${j}`);
    }

    /** Focuses row i's `what` button, else `fallback` (a full key). */
    function focusRule(i: number, what: string, fallback: string): void {
      const b = rulesList.querySelector<HTMLButtonElement>(`[data-key="${CSS.escape(`${what}:${i}`)}"]`);
      if (b && !b.disabled) b.focus({ preventScroll: true });
      else rulesBlock.querySelector<HTMLElement>(`[data-key="${CSS.escape(fallback)}"]`)?.focus({ preventScroll: true });
    }

    async function save(): Promise<void> {
      const s = st();
      if (!s || !draft || savingRules) return;
      const rules = draft.map((r) => ({ match: r.match.trim(), profile: r.profile }));
      const problem = rulesProblem(rules, s.profiles);
      if (problem) {
        ruleError = problem;
        rulesNote = null;
        syncRules();
        rulesList.querySelector<HTMLElement>(`[data-key="${CSS.escape(`rule-match:${problem.index}`)}"]`)?.focus();
        return;
      }
      savingRules = true;
      rulesNote = null;
      syncRules();
      const res = await host.send('codex_profiles.set', { rules });
      savingRules = false;
      if (res.ok) {
        host.book.upsert(res.data);
        draft = null;
        ruleError = null;
        rulesNote = { text: rules.length ? `Saved ${rules.length === 1 ? 'the rule' : `${rules.length} rules`}.` : 'Saved: no rules.', error: false };
        syncRules();
        focusKey('rule-add');
        return;
      }
      const why = codexProfilesFailureText(res.code, res.message);
      const row = res.code === 'bad_request' ? ruleRefusal(why) : null;
      if (row) ruleError = row;
      else rulesNote = { text: why, error: true };
      syncRules();
      if (row) rulesList.querySelector<HTMLElement>(`[data-key="${CSS.escape(`rule-match:${row.index}`)}"]`)?.focus();
    }

    function focusKey(key: string): void {
      const b = rulesBlock.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
      if (b && !(b as HTMLButtonElement).disabled) b.focus({ preventScroll: true });
    }

    /** The Add, Save and Discard buttons, as the draft is now (typing does not rebuild the rows). */
    function syncRuleTools(): void {
      const n = rulesNow().length;
      addRule.disabled = savingRules || n >= RULES_MAX;
      addRule.title = n >= RULES_MAX ? `At most ${RULES_MAX} rules` : '';
      saveRules.hidden = discardRules.hidden = !draft;
      saveRules.disabled = discardRules.disabled = savingRules;
      saveRules.textContent = savingRules ? 'Saving…' : 'Save rules';
      rulesStatus.textContent = (ruleError?.index === null ? ruleError.text : rulesNote?.text) ?? '';
      rulesStatus.classList.toggle('settings-field-error', ruleError?.index === null || !!rulesNote?.error);
      rulesStatus.hidden = !rulesStatus.textContent;
    }

    function syncRules(): void {
      const s = st();
      rulesBlock.hidden = !s?.auto;
      if (!s?.auto) return;
      // Rebuilt rows keep the focus and the caret where they were.
      const active = document.activeElement instanceof HTMLElement && rulesList.contains(document.activeElement) ? document.activeElement : null;
      const key = active?.dataset.key;
      const caret = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
      const rules = rulesNow();
      rulesList.replaceChildren(...rules.map((r, i) => ruleRow(r, i, rules.length, s.profiles)));
      rulesList.hidden = rules.length === 0;
      rulesEmpty.hidden = rules.length > 0;
      syncRuleTools();
      if (key && !rulesList.contains(document.activeElement)) {
        const back = rulesList.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
        back?.focus({ preventScroll: true });
        if (back instanceof HTMLInputElement && caret) back.setSelectionRange(caret[0] ?? null, caret[1] ?? null);
      }
    }

    addRule.addEventListener('click', () => {
      const rules = editing();
      if (rules.length >= RULES_MAX) return;
      rules.push({ match: '', profile: '' });
      ruleError = null;
      rulesNote = null;
      syncRules();
      rulesList.querySelector<HTMLElement>(`[data-key="${CSS.escape(`rule-match:${rules.length - 1}`)}"]`)?.focus();
    });
    saveRules.addEventListener('click', () => void save());
    discardRules.addEventListener('click', () => {
      draft = null;
      ruleError = null;
      rulesNote = { text: 'Back to the saved rules.', error: false };
      syncRules();
      focusKey('rule-add');
    });

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
      syncRules();
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
        draft = null;
        ruleError = null;
        rulesNote = null;
        sync();
      },
      dispose: off,
    };
  };
}
