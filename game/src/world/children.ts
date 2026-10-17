import { type Child, type ChildRemoved, decodeChild } from '../net/protocol';

/**
 * #22 native child agents (docs/protocol.md "Native child agents"), the game's side: pure logic, no DOM. The bridge owns
 * them (`World.children`, `child.upsert` / `child.removed`, each worker's `child_generation`); this keeps them per worker
 * and generation (`ChildBook`) and builds a worker's tree (`childTree`). #24 (phase 3 of #20): the floor overview nests
 * that tree under its worker (world/overview.ts), on the page and the wall.
 */

/**
 * #22: every worker's native children. A worker's generation is the newest it has seen of it (its `child_generation`, or a
 * child's `generation`): anything of an older one is dropped, so a child of a replaced session never attaches to the new
 * one; a newer one first drops the worker's children (they belonged to the session it replaced). `known` false: a bridge
 * before #22 (its snapshot has no `children`, read as none).
 */
export class ChildBook {
  known = false;
  version = 0;
  private readonly gens = new Map<string, number>();
  private readonly byWorker = new Map<string, Map<string, Child>>();

  reset(list: readonly unknown[] | undefined, workers: Iterable<{ id: string; child_generation?: number }>): void {
    this.known = Array.isArray(list);
    this.gens.clear();
    this.byWorker.clear();
    for (const w of workers) this.raise(w.id, w.child_generation ?? 0);
    for (const c of list ?? []) this.upsert(c);
    this.version++;
  }

  /** `worker.upsert`: its `child_generation` (absent from an older bridge: nothing changes). */
  worker(id: string, generation: number | undefined): void {
    if (generation !== undefined && this.raise(id, generation)) this.version++;
  }

  /**
   * `worker.removed` (and a worker gone with its floor): its children go with it, and its generation is closed: anything
   * late of it is dropped, and should it come back its new generation is newer still (the bridge's counter only rises).
   */
  removeWorker(id: string): void {
    const g = this.gens.get(id);
    if (g !== undefined) this.gens.set(id, g + 1);
    if (this.byWorker.delete(id)) this.version++;
  }

  /** `child.upsert`'s child, read by `decodeChild`. False: dropped (not a child, or of an older generation than its worker's). */
  upsert(v: unknown): boolean {
    const c = decodeChild(v);
    if (!c) return false;
    this.known = true;
    if (c.generation < (this.gens.get(c.worker_id) ?? 0)) return false;
    this.raise(c.worker_id, c.generation);
    let m = this.byWorker.get(c.worker_id);
    if (!m) this.byWorker.set(c.worker_id, (m = new Map()));
    m.set(c.id, c);
    this.version++;
    return true;
  }

  /** `child.removed`. False: nothing removed (an older generation's, or a row not known). */
  removed(e: Pick<ChildRemoved, 'id' | 'worker_id' | 'generation'>): boolean {
    this.known = true;
    if (e.generation < (this.gens.get(e.worker_id) ?? 0)) return false;
    this.raise(e.worker_id, e.generation);
    if (!this.byWorker.get(e.worker_id)?.delete(e.id)) return false;
    this.version++;
    return true;
  }

  /** The worker's generation (0: none seen). */
  generation(workerId: string): number {
    return this.gens.get(workerId) ?? 0;
  }

  /** The worker's children, in the order first seen. */
  of(workerId: string): Child[] {
    return [...(this.byWorker.get(workerId)?.values() ?? [])];
  }

  get(workerId: string, id: string): Child | undefined {
    return this.byWorker.get(workerId)?.get(id);
  }

  /** A newer generation drops the worker's children; returns whether it moved. */
  private raise(id: string, generation: number): boolean {
    const cur = this.gens.get(id);
    if (cur !== undefined && generation <= cur) return false;
    this.gens.set(id, generation);
    this.byWorker.delete(id);
    return true;
  }
}

/** One child in a worker's tree, with its own children. */
export interface ChildTreeNode {
  child: Child;
  children: ChildTreeNode[];
}

/**
 * #22: a worker's children as a tree: the root's children and the unresolved ones at the top (shown under the root worker
 * until evidence resolves them), each child under its parent; siblings by start, native id, name, row id. A parent this
 * list does not have is read as unresolved, and so is one whose chain comes back to the child (the bridge sends no cycle;
 * should one arrive, its rows show at the top rather than vanish with their descendants). The bridge's
 * `childagentstest.Tree` builds the same.
 */
export function childTree(children: readonly Child[]): ChildTreeNode[] {
  const ids = new Set(children.map((c) => c.id));
  const up = new Map<string, string>();
  for (const c of children) up.set(c.id, c.parent === 'child' && c.parent_id && ids.has(c.parent_id) ? c.parent_id : '');
  const cyclic = (id: string): boolean => {
    let p = up.get(id) ?? '';
    for (let n = 0; p && n < up.size; n++, p = up.get(p) ?? '') if (p === id) return true;
    return false;
  };
  const kids = new Map<string, Child[]>();
  for (const c of children) {
    const p = cyclic(c.id) ? '' : (up.get(c.id) ?? '');
    let list = kids.get(p);
    if (!list) kids.set(p, (list = []));
    list.push(c);
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const build = (p: string): ChildTreeNode[] =>
    (kids.get(p) ?? [])
      .slice()
      .sort(
        (a, b) =>
          (a.started_at ?? 0) - (b.started_at ?? 0) ||
          cmp(a.native_id ?? '', b.native_id ?? '') ||
          cmp(a.name ?? '', b.name ?? '') ||
          cmp(a.id, b.id),
      )
      .map((child) => ({ child, children: build(child.id) }));
  return build('');
}
