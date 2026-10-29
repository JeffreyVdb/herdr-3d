import type { StoredWorker } from './store';

/**
 * Run elsewhere: the other runs of the message worker `id` was hired with or was asked: the worker it repeats (first),
 * then the workers that repeat it or repeat the same worker, oldest hire first. Never `id` itself; empty when it has none.
 */
export function rerunSiblings(id: string, workers: Iterable<StoredWorker>): StoredWorker[] {
  const all = [...workers];
  const self = all.find((w) => w.id === id);
  if (!self) return [];
  const root = self.rerun_of ?? id;
  const out = all.filter((w) => w.id !== id && (w.id === root || w.rerun_of === root || w.rerun_of === id));
  return out.sort((a, b) => Number(b.id === root) - Number(a.id === root) || (a.hired_at ?? 0) - (b.hired_at ?? 0) || a.id.localeCompare(b.id));
}
