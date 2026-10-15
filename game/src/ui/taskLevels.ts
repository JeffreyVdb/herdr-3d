/**
 * #248, #40: Settings → Task levels, remembered per browser: the player's own levels, in their order, each a name and
 * the harness / model / effort it stands for, and which one is the default. A fresh browser has none. A level's model is
 * kept while the bridge does not list it (or Settings hides it), so the level works again when the model comes back;
 * until then the dialogs show it as unusable.
 * Guarded like `hireModelPrefs.ts`: storage can be missing, throw or hold something malformed, and then there are no
 * levels; a malformed level is dropped and the good ones kept.
 *
 * Stored as `{ "v": 2, "levels": [{id, name, harness, model, effort}, …], "default": id | null }`, a level that is not
 * set yet with empty strings. The value #248 stored (one object keyed `very_trivial` / `trivial` / `slightly_complex`)
 * is migrated when read: each set slot becomes a level with the name it had, in that order, Trivial the default.
 */

import { effectiveDefault, isComplete, MAX_LEVELS, nameProblem, type TaskLevel, type TaskLevelCombination, type TaskLevelId } from '../world/taskLevels';
import { bridgeKey } from '../net/bridgeScope';

export type { TaskLevel, TaskLevelCombination, TaskLevelId } from '../world/taskLevels';

const KEY = 'h3d.hire.taskLevels';

/** #248's slots, small to large, and the names they had. */
const LEGACY: ReadonlyArray<readonly [string, string]> = [
  ['very_trivial', 'Very trivial'],
  ['trivial', 'Trivial'],
  ['slightly_complex', 'Slightly complex'],
];

/** The stored value read back. `migrated`: it was #248's value, and the new shape should be stored. */
export interface ParsedTaskLevels {
  levels: TaskLevel[];
  default: TaskLevelId | null;
  migrated: boolean;
}

/** A new level's id: random and opaque. */
export function newLevelId(): TaskLevelId {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* an insecure context: the fallback below */
  }
  return `tl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const filled = (v: unknown): v is string => typeof v === 'string' && v !== '';
const NOT_SET: TaskLevelCombination = { harness: '', model: '', effort: '' };

/** A combination as stored: three non-empty strings, else not set; null when a field is not a string at all. */
function parseCombination(v: Record<string, unknown>): TaskLevelCombination | null {
  const { harness, model, effort } = v;
  if (![harness, model, effort].every((x) => x === undefined || typeof x === 'string')) return null;
  return filled(harness) && filled(model) && filled(effort) ? { harness, model, effort } : { ...NOT_SET };
}

function parseV2(v: Record<string, unknown>): ParsedTaskLevels {
  const levels: TaskLevel[] = [];
  for (const e of Array.isArray(v.levels) ? v.levels : []) {
    if (levels.length >= MAX_LEVELS) break;
    if (!record(e) || !filled(e.id) || typeof e.name !== 'string') continue;
    const { id, name } = e;
    if (levels.some((l) => l.id === id) || nameProblem(name, levels.map((l) => l.name))) continue;
    const c = parseCombination(e);
    if (c) levels.push({ id, name: name.trim(), ...c });
  }
  const d = v.default;
  return { levels, default: typeof d === 'string' && levels.some((l) => l.id === d) ? d : null, migrated: false };
}

function parseLegacy(v: Record<string, unknown>, newId: () => TaskLevelId): ParsedTaskLevels {
  const levels: TaskLevel[] = [];
  let def: TaskLevelId | null = null;
  for (const [key, name] of LEGACY) {
    const e = v[key];
    const c = record(e) ? parseCombination(e) : null;
    if (!c || !isComplete(c)) continue;
    const id = newId();
    levels.push({ id, name, ...c });
    if (key === 'trivial') def = id;
  }
  return { levels, default: def, migrated: true };
}

/** The stored value read back (see the file's comment); anything unreadable is no levels. */
export function parseTaskLevels(raw: string | null, newId: () => TaskLevelId = newLevelId): ParsedTaskLevels {
  const none: ParsedTaskLevels = { levels: [], default: null, migrated: false };
  if (!raw) return none;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return none;
  }
  if (!record(v)) return none;
  if (v.v === 2) return parseV2(v);
  // #248 stored no version: any other version is not ours to read.
  return 'v' in v ? none : parseLegacy(v, newId);
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
  private levels: TaskLevel[];
  private mark: TaskLevelId | null;
  private rev = 0;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = defaultStorage(),
    private readonly newId: () => TaskLevelId = newLevelId,
  ) {
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(bridgeKey(KEY)) ?? null;
    } catch {
      raw = null;
    }
    const made = new Set<TaskLevelId>();
    const p = parseTaskLevels(raw, () => {
      let id = this.newId();
      while (!id || made.has(id)) id = this.newId();
      made.add(id);
      return id;
    });
    this.levels = p.levels;
    this.mark = p.default;
    if (p.migrated) this.persist();
  }

  /** Bumped on every change: a view that drew the levels can tell it is out of date. */
  get version(): number {
    return this.rev;
  }

  /** Every level in the player's order, set or not (copies). */
  list(): TaskLevel[] {
    return this.levels.map((l) => ({ ...l }));
  }

  /** The level, null when there is none with that id. */
  get(id: TaskLevelId): TaskLevel | null {
    const l = this.levels.find((x) => x.id === id);
    return l ? { ...l } : null;
  }

  /** Whether any level is set. */
  get any(): boolean {
    return this.levels.some(isComplete);
  }

  /** At the cap: no level can be added. */
  get full(): boolean {
    return this.levels.length >= MAX_LEVELS;
  }

  /** The level marked as the default, null when none is. */
  get defaultMark(): TaskLevelId | null {
    return this.mark;
  }

  /** The default level: the marked one, else the first; null without levels. */
  get defaultId(): TaskLevelId | null {
    return effectiveDefault(this.levels, this.mark);
  }

  /** A name no level has: "Level 1", "Level 2", … */
  suggestName(): string {
    const names = this.levels.map((l) => l.name);
    for (let n = 1; ; n++) if (!nameProblem(`Level ${n}`, names)) return `Level ${n}`;
  }

  /** Adds a level that is not set yet at the end; null (nothing added) at the cap or for a name that cannot be used. */
  add(name: string): TaskLevelId | null {
    if (this.full || nameProblem(name, this.levels.map((l) => l.name))) return null;
    const id = this.freshId(this.levels);
    this.write([...this.levels, { id, name: name.trim(), ...NOT_SET }], this.mark);
    return id;
  }

  /** Renames the level; why not (nothing changes) when the name cannot be used. */
  rename(id: TaskLevelId, name: string): string | null {
    const cur = this.levels.find((l) => l.id === id);
    if (!cur) return null;
    const why = nameProblem(
      name,
      this.levels.filter((l) => l.id !== id).map((l) => l.name),
    );
    if (why) return why;
    const n = name.trim();
    if (n !== cur.name) this.write(this.levels.map((l) => (l.id === id ? { ...l, name: n } : l)), this.mark);
    return null;
  }

  /** Sets the level's harness, model and effort. */
  set(id: TaskLevelId, c: TaskLevelCombination): void {
    const cur = this.levels.find((l) => l.id === id);
    if (!cur || (cur.harness === c.harness && cur.model === c.model && cur.effort === c.effort)) return;
    this.write(this.levels.map((l) => (l.id === id ? { ...l, harness: c.harness, model: c.model, effort: c.effort } : l)), this.mark);
  }

  /** Unsets the level's combination; the level and its name stay. */
  clear(id: TaskLevelId): void {
    const cur = this.levels.find((l) => l.id === id);
    if (cur && isComplete(cur)) this.set(id, NOT_SET);
  }

  /** Removes the level (and its default mark). */
  remove(id: TaskLevelId): void {
    if (!this.levels.some((l) => l.id === id)) return;
    this.write(
      this.levels.filter((l) => l.id !== id),
      this.mark === id ? null : this.mark,
    );
  }

  /** Moves the level one place earlier (-1) or later (1); nothing past an end. */
  move(id: TaskLevelId, dir: -1 | 1): void {
    const i = this.levels.findIndex((l) => l.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.levels.length) return;
    const next = [...this.levels];
    [next[i], next[j]] = [next[j] as TaskLevel, next[i] as TaskLevel];
    this.write(next, this.mark);
  }

  /** Marks the level as the default (the mark leaves the one that had it). */
  setDefault(id: TaskLevelId): void {
    if (this.mark === id || !this.levels.some((l) => l.id === id)) return;
    this.write(this.levels, id);
  }

  /** Called when the levels change (the Settings section and an open Hire dialog keep in step). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private freshId(taken: readonly TaskLevel[]): TaskLevelId {
    for (;;) {
      const id = this.newId();
      if (id && !taken.some((l) => l.id === id)) return id;
    }
  }

  private write(next: TaskLevel[], mark: TaskLevelId | null): void {
    this.levels = next;
    this.mark = mark;
    this.rev++;
    this.persist();
    for (const fn of this.listeners) fn();
  }

  private persist(): void {
    try {
      // No levels leaves no key behind.
      if (this.levels.length) this.storage?.setItem(bridgeKey(KEY), JSON.stringify({ v: 2, levels: this.levels, default: this.mark }));
      else this.storage?.removeItem(bridgeKey(KEY));
    } catch {
      /* not remembered past this page */
    }
  }
}
