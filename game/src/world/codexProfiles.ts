/**
 * #138: the Codex profiles (Codex home folders, each with its own sign-in) as the snapshot's `codex_profiles` and the
 * `codex_profiles.update` events carry them (`CodexProfilesBook`), and the checks the Settings section makes before it
 * sends a change (the bridge makes them too). #139: the profiles a Codex hire can pick from, and what a Codex worker's
 * seat says about its profile. Pure.
 */

import type { CodexProfile, CodexProfilesState, Worker } from '../net/protocol';
import type { CodexNotice } from './codexServer';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The limits of the settings (the bridge's: `codexaccount.Max*`). */
export const PROFILE_MAX_NAME = 40;
export const PROFILES_MAX_ADDED = 16;

function profileOf(v: unknown): CodexProfile | null {
  if (!isObj(v) || typeof v.key !== 'string' || !v.key || typeof v.path !== 'string') return null;
  const p: CodexProfile = {
    key: v.key,
    name: typeof v.name === 'string' && v.name ? v.name : v.key,
    path: v.path,
    display: typeof v.display === 'string' && v.display ? v.display : v.path,
    plan: typeof v.plan === 'string' ? v.plan : '',
    signed_in: v.signed_in === true,
    default: v.default === true,
    hidden: v.hidden === true,
    added: v.added === true,
  };
  if (v.missing === true) p.missing = true;
  return p;
}

/** A well-formed list (malformed profiles left out), else null. */
export function codexProfilesOf(v: unknown): CodexProfilesState | null {
  if (!isObj(v) || !Array.isArray(v.profiles)) return null;
  const out: CodexProfilesState = { profiles: v.profiles.map(profileOf).filter((p): p is CodexProfile => p !== null) };
  if (v.hire === true) out.hire = true;
  return out;
}

/** The Codex profiles, and who listens for changes. */
export class CodexProfilesBook {
  private cur: CodexProfilesState | null = null;
  private readonly listeners = new Set<() => void>();

  /** null: an older bridge. */
  get state(): CodexProfilesState | null {
    return this.cur;
  }

  /** The keys of the profiles that are read (null: no list, an older bridge). */
  visibleKeys(): Set<string> | null {
    return this.cur ? new Set(this.cur.profiles.filter((p) => !p.hidden).map((p) => p.key)) : null;
  }

  reset(v: unknown): void {
    this.cur = codexProfilesOf(v);
    this.emit();
  }

  upsert(v: unknown): boolean {
    const next = codexProfilesOf(v);
    if (!next) return false;
    this.cur = next;
    this.emit();
    return true;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}

/** Why `name` cannot be profile `key`'s name (as the bridge would say it), or null: it can. */
export function profileNameProblem(name: string, key: string, profiles: readonly CodexProfile[]): string | null {
  const n = name.trim();
  if (!n) return 'Type a name for the profile.';
  if ([...n].length > PROFILE_MAX_NAME) return `A profile name has at most ${PROFILE_MAX_NAME} characters.`;
  if (/[\u0000-\u001f\u007f]/.test(n)) return 'A profile name cannot have a line break or a tab in it.';
  const other = profiles.find((p) => p.key !== key && (p.name.toLowerCase() === n.toLowerCase() || p.key.toLowerCase() === n.toLowerCase()));
  return other ? `Another profile is called “${other.name}”.` : null;
}

/** Why `path` cannot be added (the checks that need no bridge), or null. */
export function profilePathProblem(path: string, profiles: readonly CodexProfile[]): string | null {
  const p = path.trim();
  if (!p) return 'Type the folder’s path on the bridge host.';
  if (/[\0\n\r]/.test(p)) return 'A folder path cannot have a line break in it.';
  if (!p.startsWith('/') && p !== '~' && !p.startsWith('~/')) return 'Use an absolute path on the bridge host, starting with / or ~/.';
  if (profiles.filter((x) => x.added).length >= PROFILES_MAX_ADDED) return `At most ${PROFILES_MAX_ADDED} folders can be added; remove one first.`;
  return null;
}

/** Plain words for a `codex_profiles.*` failure. */
export function codexProfilesFailureText(code: string, message: string): string {
  switch (code) {
    case 'unknown_command':
    case 'unsupported':
      return 'This bridge can’t list Codex profiles. Update it to use this.';
    case 'offline':
    case 'disconnected':
      return 'Not connected to herdr-world. Try again once it reconnects.';
    case 'not_found':
      return 'That profile is gone from the bridge. The list is up to date again.';
    default:
      return message.replace(/^bad args:\s*/, '').trim() || code;
  }
}

/**
 * #139: the profiles shown and usable: not hidden, and (an added folder) still there. With fewer than two there is no
 * choice to make, and nothing about profiles shows anywhere.
 */
function usableProfiles(state: CodexProfilesState | null): CodexProfile[] {
  return state ? state.profiles.filter((p) => !p.hidden && !p.missing) : [];
}

/**
 * #139: what a Codex hire can pick from (the hire dialog's and the preset editor's "Codex profile"), as listed (the
 * default first); null: no picker, the form is as before profiles: an older bridge (no `hire`), or fewer than two.
 */
export function hireProfiles(state: CodexProfilesState | null): CodexProfile[] | null {
  if (!state?.hire) return null;
  const list = usableProfiles(state);
  return list.length >= 2 ? list : null;
}

/** #139: why a profile cannot be picked (a chip shown disabled), or null. */
export function profileBlocked(p: CodexProfile): string | null {
  return p.signed_in ? null : 'not signed in';
}

/**
 * #139: the profile a form starts with: `want` (a preset's) while it can be picked, else the default. `gone` names a
 * `want` that is no longer offered (hidden, removed, or its folder gone): the form says it fell back.
 */
export function pickProfile(list: readonly CodexProfile[], want?: string): { key: string; gone: string | null } {
  const def = list.find((p) => p.default) ?? list[0];
  const wanted = want ? list.find((p) => p.key === want) : undefined;
  if (wanted && !profileBlocked(wanted)) return { key: wanted.key, gone: null };
  return { key: def?.key ?? '', gone: want && !wanted ? want : null };
}

/** #139: the note of a preset whose profile fell back (`pickProfile`'s `gone`), by that profile's name when still known. */
export function profileGoneText(state: CodexProfilesState | null, key: string, def: string): string {
  const name = state?.profiles.find((p) => p.key === key)?.name ?? key;
  return `This preset’s Codex profile “${name}” is gone: it hires on ${def}.`;
}

/**
 * #139: the note of a preset whose profile is gone when there is no picker (only the default is left to hire on): the
 * one exception to "nothing about profiles with one", so a preset never hires on another account without a word. Null
 * with two or more (the picker says it), for a preset on the default, and from a bridge that hires on no profile.
 */
export function loneProfileGone(state: CodexProfilesState | null, want?: string): string | null {
  if (!state?.hire || !want || hireProfiles(state)) return null;
  const list = usableProfiles(state);
  const { gone } = pickProfile(list, want);
  if (!gone) return null;
  const def = list.find((p) => p.default) ?? state.profiles.find((p) => p.default);
  return profileGoneText(state, gone, def?.name ?? '');
}

/** #139: a profile's name now (a rename follows), or its key when it is not listed. */
export function profileName(state: CodexProfilesState | null, key: string): string {
  return state?.profiles.find((p) => p.key === key)?.name ?? key;
}

/**
 * #139: what the seat bar says about a Codex worker's profile, with two or more profiles shown (else null, as before
 * profiles, but for a wake on the default because its profile was gone): the one it was hired on by its current name, and what its hire or last wake found (`profile_note`; another
 * account's sign-in needs you). A Codex worker with none (hired before profiles, or not by the bridge: write-code's)
 * runs on the default one.
 */
export function profileNotice(w: Pick<Worker, 'codex' | 'harness' | 'agent_kind'>, state: CodexProfilesState | null): CodexNotice | null {
  const c = w.codex;
  if (usableProfiles(state).length < 2) {
    // A wake on the default because its profile was gone says so also with only the default left (its only note).
    const def = state?.profiles.find((p) => p.default);
    return c?.profile && c.profile_note && c.profile === def?.key ? { tone: 'note', text: c.profile_note } : null;
  }
  if (w.harness !== 'codex' && w.agent_kind !== 'codex' && !w.codex) return null;
  if (!c?.profile) {
    const def = state?.profiles.find((p) => p.default);
    return def ? { tone: 'note', text: `Runs on the default profile (${def.name}).` } : null;
  }
  const name = profileName(state, c.profile);
  const text = c.profile_note ? `${name}. ${c.profile_note}` : name;
  return { tone: c.account === 'mismatch' ? 'down' : 'note', text };
}
