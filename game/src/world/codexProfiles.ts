/**
 * #138: the Codex profiles (Codex home folders, each with its own sign-in) as the snapshot's `codex_profiles` and the
 * `codex_profiles.update` events carry them (`CodexProfilesBook`), and the checks the Settings section makes before it
 * sends a change (the bridge makes them too). #139: the profiles a Codex hire can pick from, and what a Codex worker's
 * seat says about its profile. Pure.
 */

import type { CodexDrift, CodexProfile, CodexProfilesState, CodexRule, Worker } from '../net/protocol';
import type { CodexNotice } from './codexServer';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The limits of the settings (the bridge's: `codexaccount.Max*`). */
export const PROFILE_MAX_NAME = 40;
export const PROFILES_MAX_ADDED = 16;
export const RULES_MAX = 32;

/** #140: `codex_profile` for Auto: the bridge picks the profile at hire (no profile is ever keyed so). */
export const AUTO_PROFILE = 'auto';

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
  if (v.anything === true) p.anything = true;
  if (v.share === true) p.share = true;
  if (Array.isArray(v.drift)) {
    const drift = v.drift.filter((d): d is CodexDrift => isObj(d) && typeof d.kind === 'string' && typeof d.name === 'string' && typeof d.text === 'string').map((d) => ({ kind: d.kind, name: d.name, text: d.text }));
    if (drift.length && p.share && !p.hidden) p.drift = drift;
  }
  return p;
}

function ruleOf(v: unknown): CodexRule | null {
  return isObj(v) && typeof v.match === 'string' && typeof v.profile === 'string' ? { match: v.match, profile: v.profile } : null;
}

/** A well-formed list (malformed profiles left out), else null. */
export function codexProfilesOf(v: unknown): CodexProfilesState | null {
  if (!isObj(v) || !Array.isArray(v.profiles)) return null;
  const out: CodexProfilesState = { profiles: v.profiles.map(profileOf).filter((p): p is CodexProfile => p !== null) };
  if (v.hire === true) out.hire = true;
  if (v.share === true) out.share = true;
  if (v.runs === true) out.runs = true; // #167
  if (v.auto === true) {
    out.auto = true;
    out.rules = Array.isArray(v.rules) ? v.rules.map(ruleOf).filter((r): r is CodexRule => r !== null) : [];
  }
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

const OWNER = /^[A-Za-z0-9-]{1,39}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const FORMS = 'github.com/<owner>/* or github.com/<owner>/<repo>';

/**
 * #140: why `match` is none of a rule's forms (the bridge's words, without its "Rule N: "), or null: a GitHub owner
 * (`github.com/<owner>/*`), a repo (`github.com/<owner>/<repo>`), or a folder (`/…`, `~/…`).
 */
export function ruleMatchProblem(match: string): string | null {
  const m = match.trim();
  if (!m) return `Type a repo (${FORMS}) or a folder (/… or ~/…).`;
  if (/[\u0000-\u001f\u007f]/.test(m)) return 'A match cannot have a line break or a tab in it.';
  if (m.slice(0, 11).toLowerCase() === 'github.com/') {
    const rest = m.slice(11);
    const slash = rest.indexOf('/');
    const owner = slash < 0 ? rest : rest.slice(0, slash);
    const repo = slash < 0 ? '' : rest.slice(slash + 1);
    if (!OWNER.test(owner)) return `“${owner}” is not a GitHub owner: use ${FORMS}.`;
    if (repo !== '*' && (!REPO.test(repo) || repo === '.' || repo === '..')) return `“${repo}” is not a GitHub repo: use ${FORMS}.`;
    return null;
  }
  if (m === '~' || m.startsWith('~/') || m.startsWith('/')) return null;
  return `Use ${FORMS}, or a folder starting with / or ~/.`;
}

/**
 * #140: the first problem of `rules` the editor can see before it sends them (the bridge checks them too): which rule
 * (its index) and why, or null.
 */
export function rulesProblem(rules: readonly CodexRule[], profiles: readonly CodexProfile[]): { index: number; text: string } | null {
  if (rules.length > RULES_MAX) return { index: rules.length - 1, text: `At most ${RULES_MAX} rules; remove one first.` };
  const seen = new Map<string, number>();
  for (const [i, r] of rules.entries()) {
    const why = ruleMatchProblem(r.match);
    if (why) return { index: i, text: why };
    const norm = dupKey(r.match);
    const j = seen.get(norm);
    if (j !== undefined) return { index: i, text: `Rule ${j + 1} already matches this.` };
    seen.set(norm, i);
    if (!r.profile) return { index: i, text: 'Choose the profile it hires on.' };
    if (!profiles.some((p) => p.key === r.profile)) return { index: i, text: `There is no Codex profile “${r.profile}”.` };
  }
  return null;
}

/** Two matches with the same key are one rule, as the bridge says: a GitHub match ignoring case (GitHub does), a folder exactly (the picker compares it so). */
function dupKey(m: string): string {
  const n = normRule(m);
  return n.startsWith('github.com/') ? n.toLowerCase() : n;
}

/** A match as the bridge stores it, near enough to tell two of them apart (github.com in lower case, a folder without a trailing /). */
function normRule(m: string): string {
  const t = m.trim();
  if (t.slice(0, 11).toLowerCase() === 'github.com/') return 'github.com/' + t.slice(11);
  return t.length > 1 ? t.replace(/\/+$/, '') : t;
}

/** #140: a refusal of `codex_profiles.set`'s rules ("Rule 2: …"): the row (0-based) and the words without the number, or null. */
export function ruleRefusal(text: string): { index: number; text: string } | null {
  const m = /^Rule (\d+): (.*)$/s.exec(text);
  if (!m) return null;
  const why = m[2] ?? '';
  return { index: Number(m[1]) - 1, text: why.charAt(0).toUpperCase() + why.slice(1) };
}

/** #140: what keeps a rule's profile from being used at hire (it is passed over, with a note), or null. */
export function ruleProfileProblem(key: string, profiles: readonly CodexProfile[]): string | null {
  const p = profiles.find((x) => x.key === key);
  if (!p || p.missing) return `${p?.name ?? key} is gone: Auto passes this rule over.`;
  if (p.hidden) return `${p.name} is hidden: Auto passes this rule over.`;
  if (!p.signed_in) return `${p.name} is not signed in: Auto passes this rule over.`;
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

/** #140: the bridge takes Auto (`codex_profile: "auto"`): the hire dialog and the preset editor offer it first. */
export function autoOffered(state: CodexProfilesState | null): boolean {
  return state?.auto === true;
}

/**
 * #139: the profile a form starts with: `want` (a preset's) while it can be picked, else the default. `gone` names a
 * `want` that is no longer offered (hidden, removed, or its folder gone): the form says it fell back. #140: with `auto`
 * (the bridge takes it), a new form (`want` undefined) and an Auto preset start on Auto; a preset with no profile (`''`)
 * keeps meaning the default.
 */
export function pickProfile(list: readonly CodexProfile[], want?: string, auto = false): { key: string; gone: string | null } {
  if (auto && (want === undefined || want === AUTO_PROFILE)) return { key: AUTO_PROFILE, gone: null };
  if (want === AUTO_PROFILE) want = undefined; // an older bridge: the default, nothing gone
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
  if (!state?.hire || !want || want === AUTO_PROFILE || hireProfiles(state)) return null;
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
 * runs on the default one, but (#167) one the bridge did not start on the profile its workspace's `h3d_codex_profile`
 * token names.
 */
export function profileNotice(w: Pick<Worker, 'codex' | 'harness' | 'agent_kind' | 'tokens'>, state: CodexProfilesState | null): CodexNotice | null {
  const c = w.codex;
  if (usableProfiles(state).length < 2) {
    // A wake on the default because its profile was gone says so also with only the default left (its only note).
    const def = state?.profiles.find((p) => p.default);
    return c?.profile && c.profile_note && c.profile === def?.key ? { tone: 'note', text: c.profile_note } : null;
  }
  if (w.harness !== 'codex' && w.agent_kind !== 'codex' && !w.codex) return null;
  const key = c ? c.profile : w.tokens?.h3d_codex_profile;
  if (!key) {
    const def = state?.profiles.find((p) => p.default);
    return def ? { tone: 'note', text: `Runs on the default profile (${def.name}).` } : null;
  }
  const name = profileName(state, key);
  const text = c?.profile_note ? `${name}. ${c.profile_note}` : name;
  return { tone: c?.account === 'mismatch' ? 'down' : 'note', text };
}

/**
 * #167: what the limits meter says of profile `key`'s shared setup when it drifted (only from a bridge with sharing):
 * the plain list, and where to fix it (Settings → Codex profiles, which has Fix). null: nothing to say.
 */
export function profileDrift(state: CodexProfilesState | null, key: string): { text: string } | null {
  if (!state?.share) return null;
  const p = state.profiles.find((x) => x.key === key);
  if (!p?.drift?.length) return null;
  const def = state.profiles.find((x) => x.default);
  return { text: `${p.name}’s shared setup differs from ${def?.name ?? 'the default'}’s: ${p.drift.map((d) => d.text).join('; ')}. Fix it in Settings → Codex profiles.` };
}
