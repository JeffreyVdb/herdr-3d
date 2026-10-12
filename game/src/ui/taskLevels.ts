/**
 * #248: Settings → Task levels, remembered per browser: the harness / model / effort each level stands for. Every level
 * is unset until the player sets it. A level's model is kept while the bridge does not list it (or Settings hides it),
 * so the level works again when the model comes back; until then the dialogs show it as unusable.
 * Guarded like `hireModelPrefs.ts`: storage can be missing, throw or hold something malformed, and then the level is unset.
 */

import { TASK_LEVELS, type TaskLevel, type TaskLevelId } from '../world/taskLevels';

export type { TaskLevel, TaskLevelId } from '../world/taskLevels';

const KEY = 'h3d.hire.taskLevels';

/** The levels as stored: only the set ones appear. */
export type TaskLevelMap = Partial<Record<TaskLevelId, TaskLevel>>;

const text = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** A level as stored: anything that is not `{harness, model, effort}` of non-empty strings is unset. */
function parseLevel(v: unknown): TaskLevel | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const { harness, model, effort } = v as Record<string, unknown>;
  return text(harness) && text(model) && text(effort) ? { harness, model, effort } : null;
}

/** The stored value read back: unknown keys and malformed levels are dropped, the good ones kept. */
export function parseTaskLevels(raw: string | null): TaskLevelMap {
  if (!raw) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const out: TaskLevelMap = {};
  for (const id of TASK_LEVELS) {
    const l = parseLevel((v as Record<string, unknown>)[id]);
    if (l) out[id] = l;
  }
  return out;
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class TaskLevels {
  private readonly listeners = new Set<() => void>();
  private levels: TaskLevelMap;
  private rev = 0;

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = defaultStorage()) {
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(KEY) ?? null;
    } catch {
      raw = null;
    }
    this.levels = parseTaskLevels(raw);
  }

  /** Bumped on every change: a view that drew the levels can tell it is out of date. */
  get version(): number {
    return this.rev;
  }

  /** The level's combination, null while it is unset. */
  get(id: TaskLevelId): TaskLevel | null {
    const l = this.levels[id];
    return l ? { ...l } : null;
  }

  /** Whether any level is set. */
  get any(): boolean {
    return TASK_LEVELS.some((id) => this.levels[id]);
  }

  set(id: TaskLevelId, level: TaskLevel): void {
    const cur = this.levels[id];
    if (cur && cur.harness === level.harness && cur.model === level.model && cur.effort === level.effort) return;
    this.write({ ...this.levels, [id]: { harness: level.harness, model: level.model, effort: level.effort } });
  }

  /** Unsets the level. */
  clear(id: TaskLevelId): void {
    if (!this.levels[id]) return;
    const { [id]: _, ...rest } = this.levels;
    this.write(rest);
  }

  /** Called when a level changes (the Settings section and an open Hire dialog keep in step). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private write(next: TaskLevelMap): void {
    this.levels = next;
    this.rev++;
    try {
      // Only set levels are stored: none set leaves no key behind.
      if (Object.keys(next).length) this.storage?.setItem(KEY, JSON.stringify(next));
      else this.storage?.removeItem(KEY);
    } catch {
      /* not remembered past this page */
    }
    for (const fn of this.listeners) fn();
  }
}
