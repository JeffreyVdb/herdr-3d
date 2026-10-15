/**
 * #58 stage 4: what Settings → Floors lists, from the world the client holds: every herdr session's real floor and the
 * virtual floors on it, with who works on each (a delete moves them) and whether a hidden floor shows anyway
 * (decision 2). `FloorListBook` tells the section when any of that changed (a floor added, renamed, hidden or deleted
 * by any client, a worker arriving or leaving), not on every status change. Pure.
 */

import { floorName } from './floorName';
import type { StoredFloor, StoredWorker } from './store';

/** One floor's row. */
export interface FloorRow {
  id: string;
  /** The name a person sees (a virtual floor's own, a real floor's session name). */
  name: string;
  /** The herdr session it lives in. */
  session: string;
  virtual: boolean;
  /** The stored hidden setting. */
  hidden: boolean;
  asleep: boolean;
  /** The names of the workers on it, in desk order. */
  workers: string[];
}

/** A herdr session's floors: its real floor (null while only its virtual floors are known) first, then its virtual floors. */
export interface FloorGroup {
  session: string;
  real: FloorRow | null;
  virtual: FloorRow[];
}

const byName = (a: FloorRow, b: FloorRow) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The floors in the world, grouped by session (sessions by their floor's name, virtual floors by name). */
export function floorGroups(floors: Iterable<StoredFloor>, workers: Iterable<StoredWorker>): FloorGroup[] {
  const on = new Map<string, StoredWorker[]>();
  for (const w of workers) {
    const list = on.get(w.floor);
    if (list) list.push(w);
    else on.set(w.floor, [w]);
  }
  const groups = new Map<string, FloorGroup>();
  for (const f of floors) {
    const ws = (on.get(f.id) ?? []).slice().sort((a, b) => (a.desk_index ?? 0) - (b.desk_index ?? 0));
    const row: FloorRow = {
      id: f.id,
      name: floorName(f),
      session: f.base_session,
      virtual: f.virtual,
      hidden: f.hidden,
      asleep: f.state === 'asleep',
      workers: ws.map((w) => w.name || w.label),
    };
    let g = groups.get(row.session);
    if (!g) groups.set(row.session, (g = { session: row.session, real: null, virtual: [] }));
    if (row.virtual) g.virtual.push(row);
    else g.real = row;
  }
  const out = [...groups.values()];
  for (const g of out) g.virtual.sort(byName);
  const label = (g: FloorGroup) => g.real?.name ?? g.session;
  return out.sort((a, b) => label(a).localeCompare(label(b)) || (a.session < b.session ? -1 : 1));
}

/** The rows the Floors section shows, and who listens: it tells only when they changed. */
export class FloorListBook {
  private cur: FloorGroup[] = [];
  private key = '[]';
  private readonly listeners = new Set<() => void>();

  constructor(private readonly read: () => FloorGroup[]) {}

  get groups(): readonly FloorGroup[] {
    return this.cur;
  }

  /** A floor row by id. */
  row(id: string): FloorRow | null {
    for (const g of this.cur) {
      if (g.real?.id === id) return g.real;
      const v = g.virtual.find((r) => r.id === id);
      if (v) return v;
    }
    return null;
  }

  /** Reads the world again; true (and the listeners told) when the rows changed. */
  refresh(): boolean {
    const next = this.read();
    const key = JSON.stringify(next);
    if (key === this.key) return false;
    this.cur = next;
    this.key = key;
    for (const fn of [...this.listeners]) fn();
    return true;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}
