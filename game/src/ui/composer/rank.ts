/**
 * #140: the completion popup's filter for named items (slash commands and skills), pure. An item matches when its
 * name holds the query, ignoring case, and ranks in one of three tiers: the name starts with the query, then a word
 * of it does (a word starts after `:`, `-` or `_`: `caveman:caveman-commit` has words at 8 and 16), then the query is
 * anywhere in it. Within a tier the items keep their order (the harness's own). An empty query keeps every item.
 *
 * Each match says which characters of the name it is (`hits`, UTF-16 offsets), for the row to highlight: the prefix,
 * the first word start, else the first occurrence. One linear pass per item, so a few hundred rank in well under a
 * frame on every keystroke.
 */

export interface Ranked<T> {
  item: T;
  /** The offsets of the name's matched characters (none for an empty query). */
  hits: number[];
}

const WORD = new Set([':', '-', '_']);

/** Lower case, unless that changes the length (offsets must stay the name's). */
const fold = (s: string): string => {
  const l = s.toLowerCase();
  return l.length === s.length ? l : s;
};

/** 0: prefix, 1: word start, 2: substring; and where (-1: no match). */
function matchAt(name: string, q: string): [tier: number, at: number] {
  const first = name.indexOf(q);
  if (first < 0) return [3, -1];
  if (first === 0) return [0, 0];
  for (let i = first; i >= 0; i = name.indexOf(q, i + 1)) {
    if (WORD.has(name[i - 1] as string)) return [1, i];
  }
  return [2, first];
}

export function rankByName<T>(items: readonly T[], query: string, name: (item: T) => string): Ranked<T>[] {
  if (query === '') return items.map((item) => ({ item, hits: [] }));
  const q = fold(query);
  const tiers: Ranked<T>[][] = [[], [], []];
  for (const item of items) {
    const [tier, at] = matchAt(fold(name(item)), q);
    if (at < 0) continue;
    tiers[tier]?.push({ item, hits: Array.from({ length: q.length }, (_, k) => at + k) });
  }
  return tiers.flat();
}
