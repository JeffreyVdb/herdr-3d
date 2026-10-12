/**
 * #247: the shared "Repositories from other buildings" switch (`worker.repos` lists every building's floors), as the
 * snapshot's `repo_refs` and the `repo_refs.update` events carry it (`RepoRefsBook`). Pure.
 */

import type { RepoRefsState } from '../net/protocol';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A well-formed switch (unknown keys dropped), else null. */
export function repoRefsStateOf(v: unknown): RepoRefsState | null {
  if (!isObj(v) || typeof v.all_buildings !== 'boolean') return null;
  return { all_buildings: v.all_buildings };
}

/** The switch, and who listens for changes. */
export class RepoRefsBook {
  private cur: RepoRefsState | null = null;
  private readonly listeners = new Set<() => void>();

  /** null: an older bridge, without the switch. */
  get state(): RepoRefsState | null {
    return this.cur;
  }

  reset(v: unknown): void {
    this.cur = repoRefsStateOf(v);
    this.emit();
  }

  upsert(v: unknown): boolean {
    const next = repoRefsStateOf(v);
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

/** Plain words for a `repo_refs.*` failure. */
export function repoRefsFailureText(code: string, message: string): string {
  switch (code) {
    case 'unknown_command':
      return 'This bridge can’t list repositories from other buildings yet. Update it to use this.';
    case 'offline':
    case 'disconnected':
      return 'Not connected to herdr-world. Try again once it reconnects.';
    default:
      return message.trim() || code;
  }
}
