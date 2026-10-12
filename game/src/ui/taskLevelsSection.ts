import type { HireOptions } from '../net/protocol';
import { HARNESS_LABEL, modelsFor, resolveVisibleChoice, visibleOptions } from '../world/hire';
import { labelsOf } from '../world/modelLabel';
import { effortsFor } from '../world/settings';
import { isComplete, levelProblem, MAX_LEVELS, type TaskLevel, type TaskLevelId } from '../world/taskLevels';
import { h, ICON, icon } from './dom';
import { chips, modelField } from './hire';
import type { HireModelPrefs } from './hireModelPrefs';
import { el, type SectionHandle } from './settings';
import type { TaskLevels } from './taskLevels';

/** What the section reads: the levels, the bridge's catalog (as it is when the dialog opens) and the hidden models. */
export interface TaskLevelsHost {
  levels: TaskLevels;
  prefs: HireModelPrefs;
  options: () => HireOptions;
}

/** One level's row. Its head (name, badge, tools) lives as long as the level; its fields are redrawn when they change. */
interface Row {
  root: HTMLElement;
  name: HTMLInputElement;
  error: HTMLElement;
  badge: HTMLElement;
  def: HTMLInputElement;
  up: HTMLButtonElement;
  down: HTMLButtonElement;
  clear: HTMLButtonElement;
  remove: HTMLButtonElement;
  body: HTMLElement;
  /** What the fields were drawn from: the same again leaves them alone. */
  drawn: string;
}

let serial = 0;

/** `aria-disabled`, not `disabled`: a button that reaches an end (or the cap) keeps the focus. */
const off = (b: HTMLElement, yes: boolean) => {
  if (yes) b.setAttribute('aria-disabled', 'true');
  else b.removeAttribute('aria-disabled');
};
const isOff = (b: HTMLElement) => b.getAttribute('aria-disabled') === 'true';

/** The nearest ancestor that scrolls (the Settings body): the only box a focus move may scroll. */
function scroller(e: HTMLElement): HTMLElement | null {
  for (let p = e.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === 'auto' || y === 'scroll') return p;
  }
  return null;
}

/**
 * Focuses `e` without letting the browser scroll anything (#40: a plain `focus()` can scroll the dialog itself, which
 * clips, and hide its header and body), then brings it into view inside its own scroller only.
 */
function focusInPlace(e: HTMLElement): void {
  e.focus({ preventScroll: true });
  // A chip's radio is a 1 px box: its label is what has to be seen.
  const box = (e.closest('label') ?? e) as HTMLElement;
  const sc = scroller(box);
  if (!sc) return;
  const r = box.getBoundingClientRect();
  const s = sc.getBoundingClientRect();
  const pad = 8;
  if (r.top < s.top + pad) sc.scrollTop -= s.top + pad - r.top;
  else if (r.bottom > s.bottom - pad) sc.scrollTop += Math.min(r.bottom - (s.bottom - pad), r.top - (s.top + pad));
}

/**
 * Settings → Task levels (#248, #40): the player's own levels, in their order. Each row is a name (renamed in place),
 * whether it is the default, Move up / Move down, Clear and Remove, then the Hire dialog's own Harness chips, Model field
 * (its filter for a long list, readable names) and Effort chips. Add level appends one that is not set yet. Only shown
 * models are offered. A level whose model is hidden or no longer listed keeps it, and says so beside its slug, so it
 * works again when the model comes back.
 */
export function taskLevelsSection(host: TaskLevelsHost): (body: HTMLElement) => SectionHandle {
  return (body) => {
    const { levels, prefs } = host;
    const group = `tl-default-${++serial}`;
    const lede = el(
      'p',
      'settings-lede',
      'A task level names a kind of small job and the harness, model and effort it gets. Resolve conflicts with a worker offers your set levels, in this order, instead of the usual model choice, starting from the default one.',
    );
    const status = el('p', 'settings-status', 'The bridge has not listed any models yet.');
    const empty = el('p', 'settings-field-hint tl-empty', 'No task levels yet. Add one for each kind of job you hand out.');
    const rowsEl = el('div', 'tl-levels');
    const add = h('button', { type: 'button', class: 'btn btn--sm tl-add', 'data-key': 'tl-add' }, icon(ICON.plus), h('span', {}, 'Add level'));
    const capHint = el('p', 'settings-field-hint', `At most ${MAX_LEVELS} levels: remove one to add another.`);
    capHint.id = `${group}-cap`;
    /** A harness picked for a level that could not be set with it yet (not set, or every model of it hidden). */
    const harnessOf = new Map<TaskLevelId, string>();
    const queries = new Map<TaskLevelId, string>();
    /** A name being typed (and why it cannot be saved, once tried): kept over any redraw until saved or reverted. */
    const drafts = new Map<TaskLevelId, { value: string; error: string | null }>();
    const rows = new Map<TaskLevelId, Row>();
    let cat: HireOptions = {};
    let catGen = 0;

    const shown = () => visibleOptions(cat, (harness) => prefs.hidden(harness));

    const pick = (id: TaskLevelId, p: { harness?: string; model?: string; effort?: string }) => {
      const cur = levels.get(id);
      if (!cur) return;
      const set = isComplete(cur);
      // Only the effort: the level keeps its model, even one that is hidden or gone.
      if (p.effort !== undefined && set && !harnessOf.has(id)) {
        levels.set(id, { ...cur, effort: p.effort });
        return;
      }
      const harness = p.harness ?? harnessOf.get(id) ?? cur.harness;
      if (p.harness !== undefined && p.harness !== (harnessOf.get(id) ?? cur.harness)) queries.delete(id);
      const model = p.model ?? (set && harness === cur.harness ? cur.model : null);
      const effort = p.effort ?? (set ? cur.effort : null);
      const c = resolveVisibleChoice(shown(), { harness, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      harnessOf.set(id, c.harness);
      if (c.model && c.effort) {
        harnessOf.delete(id);
        levels.set(id, c);
      }
      render();
    };

    /** Saves the typed name, or keeps it with why not. */
    const commit = (id: TaskLevelId) => {
      const d = drafts.get(id);
      if (!d || !rows.has(id)) return;
      const why = levels.rename(id, d.value);
      if (why) drafts.set(id, { value: d.value, error: why });
      else drafts.delete(id);
      render();
    };

    /** The level's fields: the chips, the model field, why it cannot be used. */
    const fields = (id: TaskLevelId, cur: TaskLevel): Node[] => {
      const set = isComplete(cur);
      const options = shown();
      const problem = set ? levelProblem(cur, cat, (harness) => prefs.hidden(harness)) : null;
      const harness = harnessOf.get(id) ?? cur.harness;
      const box = h('div', { class: 'tl-fields' }, chips(`tl-${id}-harness`, 'Harness', Object.keys(options), harness, (v) => pick(id, { harness: v })));
      const models = modelsFor(options, harness);
      const model = set && cur.harness === harness ? cur.model : '';
      if (harness && models.length) {
        box.append(
          modelField(harness, models, model, labelsOf(cat, harness), queries.get(id) ?? '', (v) => pick(id, { model: v }), (q) => queries.set(id, q), `tl-${id}-model`),
          chips(`tl-${id}-effort`, 'Effort', model ? effortsFor(cat, harness, model) : [], set ? cur.effort : '', (v) => pick(id, { effort: v })),
        );
      } else if (harness) {
        const total = cat[harness]?.models.length ?? 0;
        box.append(el('p', 'settings-field-hint', total ? `Every ${HARNESS_LABEL[harness] ?? harness} model is hidden in Harness models.` : 'This harness has no models to hire with.'));
      }
      // Why it cannot be used, under its name: the stored slug stays, so it works again when the model comes back.
      const stale = set && problem ? h('p', { class: 'settings-field-error tl-stale', role: 'note' }, 'Uses ', h('code', {}, cur.model), `: ${problem} Choose another model, or clear the level.`) : null;
      return stale ? [stale, box] : [box];
    };

    const tool = (paths: string, key: string, fn: () => void, extra = '') => {
      const b = h('button', { type: 'button', class: `btn btn--icon btn--sm${extra}`, 'data-key': key }, icon(paths));
      b.addEventListener('click', () => !isOff(b) && fn());
      return b;
    };

    const make = (id: TaskLevelId): Row => {
      const name = h('input', { type: 'text', class: 'tl-name', 'data-key': `tl-${id}-name`, autocomplete: 'off', spellcheck: 'false' });
      const error = h('p', { class: 'settings-field-error tl-name-error', id: `${group}-${id}-error`, role: 'alert' });
      name.addEventListener('input', () => drafts.set(id, { value: name.value, error: drafts.get(id)?.error ?? null }));
      name.addEventListener('change', () => commit(id));
      name.addEventListener('blur', () => commit(id));
      name.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(id);
        } else if (e.key === 'Escape' && drafts.has(id)) {
          // Back to the saved name; the dialog stays open (a second Esc closes it).
          e.preventDefault();
          drafts.delete(id);
          name.value = levels.get(id)?.name ?? '';
          render();
        }
      });
      const def = h('input', { type: 'radio', name: group, 'data-key': `tl-${id}-default` });
      def.addEventListener('change', () => def.checked && levels.setDefault(id));
      const clear = h('button', { type: 'button', class: 'btn btn--sm', 'data-key': `tl-${id}-clear` }, 'Clear');
      clear.addEventListener('click', () => {
        if (isOff(clear)) return;
        harnessOf.delete(id);
        queries.delete(id);
        levels.clear(id);
      });
      const r: Row = {
        root: h('div', { class: 'settings-role tl-level', 'data-level': id }),
        name,
        error,
        badge: el('span', 'settings-badge'),
        def,
        up: tool(ICON.up, `tl-${id}-up`, () => levels.move(id, -1)),
        down: tool(ICON.down, `tl-${id}-down`, () => levels.move(id, 1)),
        clear,
        remove: tool(ICON.trash, `tl-${id}-remove`, () => removeLevel(id), ' btn--danger-quiet'),
        body: h('div', { class: 'tl-body' }),
        drawn: '',
      };
      r.root.append(
        h('div', { class: 'tl-head' }, h('div', { class: 'settings-field tl-name-field' }, name), r.badge),
        error,
        h('div', { class: 'tl-tools' }, h('label', { class: 'settings-switch tl-default' }, def, h('span', {}, 'Default')), h('div', { class: 'tl-tools-end' }, r.up, r.down, clear, r.remove)),
        r.body,
      );
      return r;
    };

    /** Brings the row up to date in place: what it says, its name, its tools; the fields only when they changed. */
    const update = (r: Row, l: TaskLevel, i: number, n: number, isDefault: boolean) => {
      const d = drafts.get(l.id);
      if (document.activeElement !== r.name || !d) r.name.value = d?.value ?? l.name;
      r.name.setAttribute('aria-label', `Name of level ${i + 1} of ${n}`);
      r.error.textContent = d?.error ?? '';
      r.error.hidden = !d?.error;
      r.name.setAttribute('aria-invalid', d?.error ? 'true' : 'false');
      if (d?.error) r.name.setAttribute('aria-describedby', r.error.id);
      else r.name.removeAttribute('aria-describedby');
      const set = isComplete(l);
      const problem = set ? levelProblem(l, cat, (harness) => prefs.hidden(harness)) : null;
      r.badge.textContent = !set ? 'Not set' : problem ? 'Can’t be used' : 'Set';
      r.badge.dataset.state = !set ? 'incomplete' : problem ? 'invalid' : 'ready';
      r.def.checked = isDefault;
      r.def.setAttribute('aria-label', `Default level: ${l.name}`);
      for (const [b, label] of [
        [r.up, `Move ${l.name} up`],
        [r.down, `Move ${l.name} down`],
        [r.clear, `Clear ${l.name}`],
        [r.remove, `Remove ${l.name}`],
      ] as const) {
        b.setAttribute('aria-label', label);
        b.title = label;
      }
      off(r.up, i === 0);
      off(r.down, i === n - 1);
      off(r.clear, !set);
      const drawn = JSON.stringify([l.harness, l.model, l.effort, harnessOf.get(l.id) ?? null, catGen, prefs.version]);
      if (drawn !== r.drawn) {
        r.drawn = drawn;
        r.body.replaceChildren(...fields(l.id, l));
      }
    };

    const render = () => {
      const a = document.activeElement;
      const focusKey = a instanceof HTMLElement && body.contains(a) ? (a.dataset.key ?? null) : null;
      const list = levels.list();
      const ids = new Set(list.map((l) => l.id));
      for (const [id, r] of rows) {
        if (ids.has(id)) continue;
        // Forgotten before its name field goes (a focused one blurs, and there is nothing left to save).
        rows.delete(id);
        drafts.delete(id);
        harnessOf.delete(id);
        queries.delete(id);
        r.root.remove();
      }
      const def = levels.defaultId;
      list.forEach((l, i) => {
        let r = rows.get(l.id);
        if (!r) {
          r = make(l.id);
          rows.set(l.id, r);
        }
        update(r, l, i, list.length, l.id === def);
        // Only what moved is moved: a row that stays keeps its nodes (and a click on its way to one of them).
        const at = rowsEl.children[i] ?? null;
        if (at !== r.root) rowsEl.insertBefore(r.root, at);
      });
      status.hidden = Object.keys(cat).length > 0;
      empty.hidden = list.length > 0;
      off(add, levels.full);
      add.title = levels.full ? `At most ${MAX_LEVELS} levels` : 'Add a level at the end';
      capHint.hidden = !levels.full;
      if (levels.full) add.setAttribute('aria-describedby', capHint.id);
      else add.removeAttribute('aria-describedby');
      // A redraw or a move took the focus with it: put it back where it was, scrolling only the Settings body.
      if (focusKey && document.activeElement !== a) {
        const back = body.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`);
        // A chip group redrawn on another pick: its checked chip.
        const chip = !back && focusKey.includes(':') ? body.querySelector<HTMLElement>(`[data-pick="${CSS.escape(focusKey.split(':')[0] ?? '')}"] input:checked`) : null;
        const to = back ?? chip;
        if (to) focusInPlace(to);
      }
    };

    /** Removes the level; the focus goes to the next row's name, else the previous one's, else Add level. */
    const removeLevel = (id: TaskLevelId) => {
      const order = levels.list().map((l) => l.id);
      const i = order.indexOf(id);
      levels.remove(id);
      const next = order[i + 1] ?? order[i - 1];
      focusInPlace((next !== undefined ? rows.get(next)?.name : undefined) ?? add);
    };

    add.addEventListener('click', () => {
      if (isOff(add)) return;
      const id = levels.add(levels.suggestName());
      const r = id ? rows.get(id) : undefined;
      if (!r) return;
      focusInPlace(r.name);
      r.name.select();
    });

    const open = () => {
      cat = host.options();
      catGen++;
      render();
    };

    body.append(lede, status, rowsEl, empty, h('div', { class: 'tl-add-row' }, add, capHint));
    open();
    const offLevels = levels.onChange(render);
    const offPrefs = prefs.onChange(render);
    return {
      open,
      dispose: () => {
        offLevels();
        offPrefs();
      },
    };
  };
}
