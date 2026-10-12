/**
 * #248: task levels, a named harness / model / effort for small jobs ("Resolve conflicts with a worker" asks for one).
 * The three levels and their names are fixed; which combination each holds is the player's, per browser
 * (`ui/taskLevels.ts`). Whether a level can be used now, and which one a request falls back to, are pure (vitest).
 */

import type { HireOptions } from '../net/protocol';
import { HARNESS_LABEL } from './hire';
import { labelsOf, modelLabel } from './modelLabel';
import { effortsFor } from './settings';

/** Small to large. A rename only changes the label: the ids are what is stored. */
export const TASK_LEVELS = ['very_trivial', 'trivial', 'slightly_complex'] as const;
export type TaskLevelId = (typeof TASK_LEVELS)[number];

export const TASK_LEVEL_LABEL: Record<TaskLevelId, string> = { very_trivial: 'Very trivial', trivial: 'Trivial', slightly_complex: 'Slightly complex' };

/** One level's combination, as stored. */
export interface TaskLevel {
  harness: string;
  model: string;
  effort: string;
}

/**
 * Why a level cannot be hired with now (null: it can). Its model hidden in Settings → Harness models wins over every
 * other reason; then a harness or model the bridge does not list; then an effort the model does not take (its harness's
 * efforts plus its own extra ones).
 */
export function levelProblem(level: TaskLevel, catalog: HireOptions, hidden: (harness: string) => ReadonlySet<string>): string | null {
  const name = modelLabel(level.harness, level.model, labelsOf(catalog, level.harness));
  if (hidden(level.harness).has(level.model)) return `${name} is hidden in Settings → Harness models.`;
  const h = catalog[level.harness];
  if (!h) return `This bridge cannot hire with ${HARNESS_LABEL[level.harness] ?? level.harness}.`;
  if (!h.models.includes(level.model)) return `The bridge does not offer ${level.model} any more.`;
  if (!effortsFor(catalog, level.harness, level.model).includes(level.effort)) return `${name} does not take effort ${level.effort}.`;
  return null;
}

/** The levels a request falls back through: itself, then the nearest ones, the smaller before the larger at each distance. */
export function levelOrder(requested: TaskLevelId): TaskLevelId[] {
  const i = TASK_LEVELS.indexOf(requested);
  const out: TaskLevelId[] = [requested];
  for (let d = 1; out.length < TASK_LEVELS.length; d++) {
    for (const j of [i - d, i + d]) {
      const l = TASK_LEVELS[j];
      if (l) out.push(l);
    }
  }
  return out;
}

/** The level a dialog opens with: the requested one when usable, else the nearest usable one; null when none is. */
export function preselectLevel(requested: TaskLevelId, usable: (id: TaskLevelId) => boolean): TaskLevelId | null {
  return levelOrder(requested).find(usable) ?? null;
}

/** "Trivial — Haiku 5.5 · medium": the level, its model's readable name (#200), its effort. */
export function levelChipText(id: TaskLevelId, level: TaskLevel, catalog: HireOptions): string {
  return `${TASK_LEVEL_LABEL[id]} — ${modelLabel(level.harness, level.model, labelsOf(catalog, level.harness))} · ${level.effort}`;
}
