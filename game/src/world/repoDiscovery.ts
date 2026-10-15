/**
 * #54: repository discovery's settings and the scans' status, as the snapshot's `repo_discovery` and the
 * `repo_discovery.update` events carry it (`RepoDiscoveryBook`), and the checks the Settings section makes before it
 * sends roots (the bridge makes them too). Pure.
 */

import type { RepoDiscoveryRoot, RepoDiscoveryState, RepoDiscoveryStatus } from '../net/protocol';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const time = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The limits of the settings (the bridge's: `proto.RepoDiscovery*`). */
export const DISCOVERY_DEFAULT_INTERVAL = 10;
export const DISCOVERY_MAX_INTERVAL = 24 * 60;
export const DISCOVERY_MAX_ROOTS = 32;
const MAX_ROOT = 4096;

const STATES = new Set(['off', 'idle', 'scanning']);
const ROOT_STATES = new Set(['pending', 'ok', 'stale', 'error']);

function rootOf(v: unknown): RepoDiscoveryRoot | null {
  if (!isObj(v) || typeof v.path !== 'string' || typeof v.state !== 'string' || !ROOT_STATES.has(v.state)) return null;
  const canonical = str(v.canonical);
  const error = str(v.error);
  const warning = str(v.warning);
  return {
    path: v.path,
    state: v.state as RepoDiscoveryRoot['state'],
    checkouts: isCount(v.checkouts) ? v.checkouts : 0,
    last_success_at: time(v.last_success_at),
    ...(canonical ? { canonical } : {}),
    ...(error ? { error } : {}),
    ...(warning ? { warning } : {}),
  };
}

function statusOf(v: unknown): RepoDiscoveryStatus | null {
  if (!isObj(v) || typeof v.state !== 'string' || !STATES.has(v.state) || !isCount(v.revision)) return null;
  const st: RepoDiscoveryStatus = {
    state: v.state as RepoDiscoveryStatus['state'],
    revision: v.revision,
    repositories: isCount(v.repositories) ? v.repositories : 0,
    checkouts: isCount(v.checkouts) ? v.checkouts : 0,
    last_scan_at: time(v.last_scan_at),
    last_success_at: time(v.last_success_at),
    roots: Array.isArray(v.roots) ? v.roots.map(rootOf).filter((r): r is RepoDiscoveryRoot => r !== null) : [],
  };
  if (isCount(v.last_duration_ms)) st.last_duration_ms = v.last_duration_ms;
  const next = time(v.next_scan_at);
  if (next !== null) st.next_scan_at = next;
  const p = v.progress;
  if (isObj(p) && (p.phase === 'walking' || p.phase === 'checking') && isCount(p.done) && isCount(p.total)) st.progress = { phase: p.phase, done: p.done, total: p.total };
  return st;
}

/** A well-formed state (unknown keys dropped, malformed roots left out), else null. */
export function repoDiscoveryStateOf(v: unknown): RepoDiscoveryState | null {
  if (!isObj(v) || !Array.isArray(v.roots) || !v.roots.every((r) => typeof r === 'string')) return null;
  if (typeof v.interval_minutes !== 'number' || !Number.isInteger(v.interval_minutes) || v.interval_minutes < 1) return null;
  const status = statusOf(v.status);
  if (!status) return null;
  return { roots: [...(v.roots as string[])], interval_minutes: v.interval_minutes, status };
}

/** The discovery state, and who listens for changes; `revision` tells a change of the discovered repositories apart. */
export class RepoDiscoveryBook {
  private cur: RepoDiscoveryState | null = null;
  private readonly listeners = new Set<() => void>();

  /** null: an older bridge, or one that cannot scan. */
  get state(): RepoDiscoveryState | null {
    return this.cur;
  }

  /** The discovered repositories' revision (null: no discovery). */
  get revision(): number | null {
    return this.cur?.status.revision ?? null;
  }

  reset(v: unknown): void {
    this.cur = repoDiscoveryStateOf(v);
    this.emit();
  }

  upsert(v: unknown): boolean {
    const next = repoDiscoveryStateOf(v);
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

/** Why `path` cannot be added to `roots` (as the bridge would say it), or null: it can. */
export function rootProblem(path: string, roots: readonly string[]): string | null {
  const p = path.trim();
  if (!p) return 'Type the folder’s path on the bridge host.';
  if (/[\0\n\r]/.test(p)) return 'A folder path cannot have a line break in it.';
  if (!p.startsWith('/')) return 'Use an absolute path on the bridge host, starting with /.';
  if (p.length > MAX_ROOT) return `That path is longer than ${MAX_ROOT} characters.`;
  const clean = cleanRoot(p);
  if (roots.some((r) => cleanRoot(r) === clean)) return 'That folder is already scanned.';
  if (roots.length >= DISCOVERY_MAX_ROOTS) return `At most ${DISCOVERY_MAX_ROOTS} folders can be scanned; remove one first.`;
  return null;
}

/** `path` as the bridge keeps it: `.` and `..` resolved, repeated and trailing slashes dropped (Go's `filepath.Clean`). */
export function cleanRoot(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

/** Why `text` is not a refresh interval, or null. */
export function intervalProblem(text: string): string | null {
  const t = text.trim();
  if (!/^\d+$/.test(t) || +t < 1 || +t > DISCOVERY_MAX_INTERVAL) return `Use a whole number of minutes from 1 to ${DISCOVERY_MAX_INTERVAL}.`;
  return null;
}

/** Plain words for a `repo_discovery.*` failure. */
export function repoDiscoveryFailureText(code: string, message: string): string {
  switch (code) {
    case 'unknown_command':
    case 'unsupported':
      return 'This bridge can’t scan for repositories. Update it to use this.';
    case 'offline':
    case 'disconnected':
      return 'Not connected to herdr-world. Try again once it reconnects.';
    default:
      return message.trim() || code;
  }
}
