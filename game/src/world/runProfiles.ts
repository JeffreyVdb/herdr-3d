/**
 * #167: the Codex profile of a run's orchestrator ("Start a run" → Hire orchestrator) and of each Codex role of a team
 * preset (the preset editor). The same choice as a Codex hire's (`codexProfiles.ts`: Auto first, hidden and gone ones not
 * offered, one not signed in shown and not pickable), offered only by a bridge that takes `codex_profile` on runs and
 * presets (`runs`). A role with no profile runs on the default, as before profiles. Pure.
 */

import type { CodexProfile, CodexProfilesState, Hire, PresetRoles } from '../net/protocol';
import { autoOffered, hireProfiles, loneProfileGone, pickProfile, profileBlocked, profileGoneText, profileName } from './codexProfiles';

/** A role's choice as its chips show it: the list, the key picked, a stored one no longer offered, and whether Auto is there. */
export interface RoleProfileChoice {
  list: CodexProfile[];
  key: string;
  gone: string | null;
  auto: boolean;
}

/** The bridge takes `codex_profile` on a run's orchestrator and on preset roles (#167). */
export function runsTakeProfiles(state: CodexProfilesState | null): boolean {
  return state?.runs === true && state.hire === true;
}

/**
 * The chips of a Codex role (null: none, the form as before profiles: not Codex, an older bridge, or fewer than two
 * profiles): `picked` (this form's own pick) while it can be picked, else `want` (the preset's), else the default. A
 * preset role with no profile (`undefined` or `''`) is on the default, never Auto.
 */
export function roleProfileChoice(state: CodexProfilesState | null, harness: string, want: string | undefined, picked: string | null = null): RoleProfileChoice | null {
  if (harness !== 'codex' || !runsTakeProfiles(state)) return null;
  const list = hireProfiles(state);
  if (!list) return null;
  const auto = autoOffered(state);
  if (picked !== null) {
    if (auto && picked === 'auto') return { list, key: picked, gone: null, auto };
    const cur = list.find((p) => p.key === picked && !profileBlocked(p));
    if (cur) return { list, key: cur.key, gone: null, auto };
  }
  return { list, ...pickProfile(list, want ?? '', auto), auto };
}

/** The note under a role's chips when its stored profile fell back (`gone`), else null. */
export function roleGoneText(state: CodexProfilesState | null, c: RoleProfileChoice): string | null {
  if (!c.gone) return null;
  return profileGoneText(state, c.gone, c.list.find((p) => p.default)?.name ?? '').replace('it hires on', 'it runs on');
}

/** A Codex role's stored profile that is gone with no picker to say so (only the default left), else null. */
export function roleLoneGone(state: CodexProfilesState | null, harness: string, want: string | undefined): string | null {
  if (harness !== 'codex' || !runsTakeProfiles(state)) return null;
  return loneProfileGone(state, want)?.replace('it hires on', 'it runs on') ?? null;
}

/** `h` without `codex_profile`, then with `key` when given (a bridge that takes it, a Codex role). */
export function withProfile(h: Hire, key?: string | null): Hire {
  const { codex_profile: _, ...rest } = h;
  return key && h.harness === 'codex' ? { ...rest, codex_profile: key } : rest;
}

/** `next` (a role re-picked from the catalog, which knows no profiles) keeping `prev`'s profile while it stays Codex. */
export function keepProfile(next: Hire, prev: Hire | null | undefined): Hire {
  return withProfile(next, next.harness === 'codex' && prev?.harness === 'codex' ? prev.codex_profile : null);
}

/** Preset roles as a bridge is sent them: profiles only on Codex roles, and none at all to a bridge without `runs`. */
export function rolesFor(state: CodexProfilesState | null, roles: PresetRoles): PresetRoles {
  const on = runsTakeProfiles(state);
  return Object.fromEntries(Object.entries(roles).map(([r, h]) => [r, withProfile(h, on ? h.codex_profile : null)])) as PresetRoles;
}

/** A role's profile for the preset list's line (" · Work"), '' on the default or with no choice shown. */
export function roleProfileLabel(state: CodexProfilesState | null, h: Hire): string {
  if (h.harness !== 'codex' || !h.codex_profile || !runsTakeProfiles(state) || !hireProfiles(state)) return '';
  if (h.codex_profile === 'auto') return 'Auto';
  const p = state?.profiles.find((x) => x.key === h.codex_profile);
  return p?.default ? '' : profileName(state, h.codex_profile);
}
