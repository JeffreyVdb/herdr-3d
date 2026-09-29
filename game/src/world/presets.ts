/**
 * Team presets (M6): the world's `presets` and their `preset.upsert` /
 * `preset.removed` events, by name as the bridge orders them. `known` is
 * false while the bridge never sent a `presets` list (an older bridge).
 */

import type { Hire, Preset, PresetRole, PresetRoles } from '../net/protocol';

/** The five roles in the order the dialogs show them. */
export const PRESET_ROLES: readonly PresetRole[] = ['orch', 'coder', 'reviewer', 'ux', 'researcher'];

/** What each role is called in the dialogs. */
export const ROLE_LABEL: Record<PresetRole, string> = {
  orch: 'Orchestrator',
  coder: 'Coders',
  reviewer: 'Reviewers',
  ux: 'UX reviewers',
  researcher: 'Researchers',
};

/** The name the bridge seeds (the default preset when a floor has none). */
export const SEEDED_PRESET = 'Build team';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isHire = (v: unknown): v is Hire => isObj(v) && typeof v.harness === 'string' && typeof v.model === 'string' && typeof v.effort === 'string';

/** A preset with all five roles, else null (anything malformed is left out). */
export function presetOf(v: unknown): Preset | null {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.name !== 'string' || !isObj(v.roles)) return null;
  const roles = v.roles;
  if (!PRESET_ROLES.every((r) => isHire(roles[r]))) return null;
  const out: Preset = { id: v.id, name: v.name, roles: Object.fromEntries(PRESET_ROLES.map((r) => [r, { ...(roles[r] as Hire) }])) as PresetRoles };
  if (v.seeded === true) out.seeded = true;
  return out;
}

const byName = (a: Preset, b: Preset) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

export class PresetBook {
  private readonly map = new Map<string, Preset>();
  /** The bridge sent a `presets` list (an M6 bridge), so presets and runs are there. */
  known = false;
  /** Bumped on every change (dialogs re-render on it). */
  version = 0;

  /** From a snapshot's `world.presets`: undefined is an older bridge. */
  reset(list: unknown): void {
    this.map.clear();
    this.known = Array.isArray(list);
    if (Array.isArray(list))
      for (const v of list) {
        const p = presetOf(v);
        if (p) this.map.set(p.id, p);
      }
    this.version++;
  }

  upsert(v: unknown): boolean {
    const p = presetOf(v);
    if (!p) return false;
    this.known = true;
    this.map.set(p.id, p);
    this.version++;
    return true;
  }

  remove(id: string): boolean {
    const had = this.map.delete(id);
    if (had) this.version++;
    return had;
  }

  get(id: string | null | undefined): Preset | null {
    return (id && this.map.get(id)) || null;
  }

  /** By name, case-insensitive. */
  list(): Preset[] {
    return [...this.map.values()].sort(byName);
  }

  /** Another preset already called `name` (ignoring case), except `except`. */
  nameTaken(name: string, except = ''): boolean {
    const n = name.trim().toLowerCase();
    return [...this.map.values()].some((p) => p.id !== except && p.name.toLowerCase() === n);
  }

  /** What `run.prepare` would pick: the floor's last preset, else "Build team", else the first. */
  defaultFor(lastPreset: string | undefined): Preset | null {
    return this.get(lastPreset) ?? this.list().find((p) => p.name === SEEDED_PRESET) ?? this.list()[0] ?? null;
  }
}
