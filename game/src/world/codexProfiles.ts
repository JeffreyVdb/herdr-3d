/**
 * #138: the Codex profiles (Codex home folders, each with its own sign-in) as the snapshot's `codex_profiles` and the
 * `codex_profiles.update` events carry them (`CodexProfilesBook`), and the checks the Settings section makes before it
 * sends a change (the bridge makes them too). Pure.
 */

import type { CodexProfile, CodexProfilesState } from '../net/protocol';

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
  return { profiles: v.profiles.map(profileOf).filter((p): p is CodexProfile => p !== null) };
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
