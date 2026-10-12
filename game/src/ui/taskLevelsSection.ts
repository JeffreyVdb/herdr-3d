import type { HireOptions } from '../net/protocol';
import { HARNESS_LABEL, modelsFor, resolveVisibleChoice, visibleOptions } from '../world/hire';
import { labelsOf } from '../world/modelLabel';
import { effortsFor } from '../world/settings';
import { levelProblem, TASK_LEVELS, TASK_LEVEL_LABEL, type TaskLevelId } from '../world/taskLevels';
import { h } from './dom';
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

/**
 * Settings → Task levels (#248): the harness / model / effort each level stands for, one row per level with the Hire
 * dialog's own Harness chips, Model field (its filter for a long list, readable names) and Effort chips, plus Clear.
 * Only shown models are offered. A level whose model is hidden or no longer listed keeps it, and says so beside its
 * slug, so it works again when the model comes back.
 */
export function taskLevelsSection(host: TaskLevelsHost): (body: HTMLElement) => SectionHandle {
  return (body) => {
    const { levels, prefs } = host;
    const lede = el('p', 'settings-lede', 'A task level is a harness, model and effort for a kind of small job. Resolve conflicts with a worker offers your levels instead of the usual model choice, starting from Trivial. A level is unset until you set it.');
    const rowsEl = el('div', 'tl-levels');
    /** A harness picked for a level that could not be set with it yet (unset, or every model of it hidden). */
    const harnessOf = new Map<TaskLevelId, string>();
    const queries = new Map<TaskLevelId, string>();
    let cat: HireOptions = {};

    const shown = () => visibleOptions(cat, (harness) => prefs.hidden(harness));

    const pick = (id: TaskLevelId, p: { harness?: string; model?: string; effort?: string }) => {
      const cur = levels.get(id);
      // Only the effort: the level keeps its model, even one that is hidden or gone.
      if (p.effort !== undefined && cur && !harnessOf.has(id)) {
        levels.set(id, { ...cur, effort: p.effort });
        return;
      }
      const harness = p.harness ?? harnessOf.get(id) ?? cur?.harness ?? '';
      if (p.harness !== undefined && p.harness !== (harnessOf.get(id) ?? cur?.harness)) queries.delete(id);
      const model = p.model ?? (harness === cur?.harness ? cur.model : null);
      const effort = p.effort ?? cur?.effort ?? null;
      const c = resolveVisibleChoice(shown(), { harness, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      harnessOf.set(id, c.harness);
      if (c.model && c.effort) {
        harnessOf.delete(id);
        levels.set(id, c);
      }
      render();
    };

    const row = (id: TaskLevelId): HTMLElement => {
      const label = TASK_LEVEL_LABEL[id];
      const cur = levels.get(id);
      const options = shown();
      const problem = cur ? levelProblem(cur, cat, (harness) => prefs.hidden(harness)) : null;
      const root = el('div', 'settings-role tl-level');
      root.dataset.level = id;
      const head = el('div', 'settings-role-head');
      const badge = el('span', 'settings-badge', !cur ? 'Not set' : problem ? 'Can’t be used' : 'Set');
      badge.dataset.state = !cur ? 'incomplete' : problem ? 'invalid' : 'ready';
      const clear = el('button', 'btn btn--sm', 'Clear');
      clear.type = 'button';
      clear.dataset.key = `tl-${id}-clear`;
      clear.disabled = !cur;
      clear.setAttribute('aria-label', `Clear ${label}`);
      clear.addEventListener('click', () => {
        harnessOf.delete(id);
        queries.delete(id);
        levels.clear(id);
      });
      head.append(el('h4', 'settings-role-title', label), badge, clear);
      root.append(head);

      const harness = harnessOf.get(id) ?? cur?.harness ?? '';
      const fields = h('div', { class: 'tl-fields' }, chips(`tl-${id}-harness`, 'Harness', Object.keys(options), harness, (v) => pick(id, { harness: v })));
      const models = modelsFor(options, harness);
      const model = cur && cur.harness === harness ? cur.model : '';
      if (harness && models.length) {
        fields.append(
          modelField(harness, models, model, labelsOf(cat, harness), queries.get(id) ?? '', (v) => pick(id, { model: v }), (q) => queries.set(id, q), `tl-${id}-model`),
          chips(`tl-${id}-effort`, 'Effort', model ? effortsFor(cat, harness, model) : [], cur?.effort ?? '', (v) => pick(id, { effort: v })),
        );
      } else if (harness) {
        const total = cat[harness]?.models.length ?? 0;
        fields.append(el('p', 'settings-field-hint', total ? `Every ${HARNESS_LABEL[harness] ?? harness} model is hidden in Harness models.` : 'This harness has no models to hire with.'));
      }
      root.append(fields);
      if (cur && problem) {
        const warn = h('p', { class: 'settings-field-error tl-stale', role: 'note' }, 'Uses ', h('code', {}, cur.model), `: ${problem} Choose another model, or clear the level.`);
        root.append(warn);
      }
      return root;
    };

    const render = () => {
      const a = document.activeElement;
      const focusKey = a instanceof HTMLElement && body.contains(a) ? (a.dataset.key ?? null) : null;
      rowsEl.replaceChildren(...TASK_LEVELS.map(row));
      if (!Object.keys(cat).length) rowsEl.prepend(el('p', 'settings-status', 'The bridge has not listed any models yet.'));
      if (focusKey) {
        const back = rowsEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`);
        if (back) back.focus();
        // A chip group re-rendered on another pick: its checked chip.
        else if (focusKey.includes(':')) rowsEl.querySelector<HTMLElement>(`[data-pick="${CSS.escape(focusKey.split(':')[0] ?? '')}"] input:checked`)?.focus();
      }
    };

    const open = () => {
      cat = host.options();
      render();
    };

    body.append(lede, rowsEl);
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
