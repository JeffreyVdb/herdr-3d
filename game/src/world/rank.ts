/**
 * #140: the filter for named items (the completion popup's slash commands and skills, #147: the command palette's
 * commands and floors), pure. An item matches when its
 * name holds the query, ignoring case, and ranks in one of three tiers: the name starts with the query, then a word
 * of it does (a word starts after `:`, `-`, `_`, a space or `›`: `caveman:caveman-commit` has words at 8 and 16), then the query is
 * anywhere in it. Within a tier the items keep their order (the harness's own). An empty query keeps every item.
 *
 * Each match says which characters of the name it is (`hits`, UTF-16 offsets), for the row to highlight: the prefix,
 * the first word start, else the first occurrence. One linear pass per item, so a few hundred rank in well under a
 * frame on every keystroke.
 *
 * #247: opt-in (`subsequence`), a fourth tier after those: the query's characters in order, not next to each other
 * (`apsv` finds `api-server`), the leftmost such characters its hits. The palette and `/` commands do not ask for it.
 * `rankByKeys` ranks items with several names (a repo, its folder, its floor): the best tier on any key wins, an earlier
 * key breaks a tie, then the source order.
 */

export interface Ranked<T> {
  item: T;
  /** The offsets of the name's matched characters (none for an empty query). */
  hits: number[];
}

const WORD = new Set([':', '-', '_', ' ', '›']);

/** Lower case, unless that changes the length (offsets must stay the name's). */
const fold = (s: string): string => {
  const l = s.toLowerCase();
  return l.length === s.length ? l : s;
};

export interface RankOptions {
  /** #247: also match the query's characters in order with gaps, after every other tier. */
  subsequence?: boolean;
}

/** A match of one of an item's keys (`rankByKeys`): `hits` are offsets in that key. */
export interface KeyRanked<T> extends Ranked<T> {
  key: number;
}

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

/** The tier and hits of `q` (folded) in `name` (folded), or null; tier 3 (a subsequence) only when asked for. */
function matchOf(name: string, q: string, o: RankOptions): [tier: number, hits: number[]] | null {
  const [tier, at] = matchAt(name, q);
  if (at >= 0) return [tier, Array.from({ length: q.length }, (_, k) => at + k)];
  if (!o.subsequence) return null;
  const hits: number[] = [];
  let i = 0;
  for (const c of q) {
    i = name.indexOf(c, i);
    if (i < 0) return null;
    hits.push(i++);
  }
  return [3, hits];
}

export function rankByName<T>(items: readonly T[], query: string, name: (item: T) => string, o: RankOptions = {}): Ranked<T>[] {
  return rankByKeys(items, query, (item) => [name(item)], o).map(({ item, hits }) => ({ item, hits }));
}

export function rankByKeys<T>(items: readonly T[], query: string, keys: (item: T) => readonly (string | null | undefined)[], o: RankOptions = {}): KeyRanked<T>[] {
  if (query === '') return items.map((item) => ({ item, hits: [], key: 0 }));
  const q = fold(query);
  const found: { r: KeyRanked<T>; tier: number; i: number }[] = [];
  items.forEach((item, i) => {
    let best: { r: KeyRanked<T>; tier: number; i: number } | null = null;
    keys(item).forEach((k, key) => {
      if (!k) return;
      const m = matchOf(fold(k), q, o);
      if (m && (!best || m[0] < best.tier)) best = { r: { item, hits: m[1], key }, tier: m[0], i };
    });
    if (best) found.push(best);
  });
  return found.sort((a, b) => a.tier - b.tier || a.r.key - b.r.key || a.i - b.i).map((f) => f.r);
}
