/**
 * #248, #40: task levels, named harness / model / effort combinations for small jobs ("Resolve conflicts with a worker"
 * asks for one). The player creates, names, orders and removes them, per browser (`ui/taskLevels.ts`). Whether a level
 * can be used now, the default, and which level a request falls back to are pure (vitest).
 */

import type { HireOptions } from '../net/protocol';
import { HARNESS_LABEL } from './hire';
import { labelsOf, modelLabel } from './modelLabel';
import { effortsFor } from './settings';

/** A level's id: generated, stable and opaque. Never shown, never derived from the name. */
export type TaskLevelId = string;

/** A harness, model and effort, as a level holds them. */
export interface TaskLevelCombination {
  harness: string;
  model: string;
  effort: string;
}

/** One level as stored: its id, its name and its combination (all three empty while it is not set yet). */
export interface TaskLevel extends TaskLevelCombination {
  id: TaskLevelId;
  name: string;
}

/** At most this many levels. */
export const MAX_LEVELS = 20;
/** A name's length, trimmed. */
export const MAX_LEVEL_NAME = 40;

/** Whether the level's combination is set: an incomplete level is shown in Settings, never offered by a hire. */
export function isComplete(l: TaskLevelCombination): boolean {
  return l.harness !== '' && l.model !== '' && l.effort !== '';
}

/** Why `name` cannot name a level (null: it can). `others` are the other levels' names. */
export function nameProblem(name: string, others: readonly string[]): string | null {
  const n = name.trim();
  if (!n) return 'A level needs a name.';
  if (n.length > MAX_LEVEL_NAME) return `A name is at most ${MAX_LEVEL_NAME} characters.`;
  const low = n.toLowerCase();
  if (others.some((o) => o.trim().toLowerCase() === low)) return `There is already a level called “${n}”.`;
  return null;
}

/**
 * Why a level cannot be hired with now (null: it can). Its model hidden in Settings → Harness models wins over every
 * other reason; then a harness or model the bridge does not list; then an effort the model does not take (its harness's
 * efforts plus its own extra ones).
 */
export function levelProblem(level: TaskLevelCombination, catalog: HireOptions, hidden: (harness: string) => ReadonlySet<string>): string | null {
  const name = modelLabel(level.harness, level.model, labelsOf(catalog, level.harness));
  if (hidden(level.harness).has(level.model)) return `${name} is hidden in Settings → Harness models.`;
  const h = catalog[level.harness];
  if (!h) return `This bridge cannot hire with ${HARNESS_LABEL[level.harness] ?? level.harness}.`;
  if (!h.models.includes(level.model)) return `The bridge does not offer ${level.model} any more.`;
  if (!effortsFor(catalog, level.harness, level.model).includes(level.effort)) return `${name} does not take effort ${level.effort}.`;
  return null;
}

/** The default level: the one marked so, else the first in the list; null without levels. */
export function effectiveDefault(levels: readonly TaskLevel[], marked: TaskLevelId | null): TaskLevelId | null {
  return (marked !== null && levels.some((l) => l.id === marked) ? marked : levels[0]?.id) ?? null;
}

/**
 * The levels a request falls back through, by their position in the player's list (`ids`): itself, then the nearest
 * ones, the earlier before the later at each distance. A level not in the list: the list as it is.
 */
export function levelOrder(ids: readonly TaskLevelId[], requested: TaskLevelId): TaskLevelId[] {
  const i = ids.indexOf(requested);
  if (i < 0) return [...ids];
  const out: TaskLevelId[] = [requested];
  for (let d = 1; out.length < ids.length; d++) {
    for (const j of [i - d, i + d]) {
      const l = ids[j];
      if (l !== undefined) out.push(l);
    }
  }
  return out;
}

/** The level a dialog opens with: the requested one when usable, else the nearest usable one; null when none is. */
export function preselectLevel(ids: readonly TaskLevelId[], requested: TaskLevelId, usable: (id: TaskLevelId) => boolean): TaskLevelId | null {
  return levelOrder(ids, requested).find(usable) ?? null;
}

/** "Quick fix — Haiku 5.5 · medium": the level's name, its model's readable name (#200), its effort. */
export function levelChipText(level: TaskLevel, catalog: HireOptions): string {
  return `${level.name} — ${modelLabel(level.harness, level.model, labelsOf(catalog, level.harness))} · ${level.effort}`;
}
