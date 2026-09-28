/** Reordering buildings and floors (M3): the command args for one step up or down. Pure. */

/**
 * `floor.assign` args that move `session` one floor up (-1, towards the top)
 * or down (+1) among the floors shown, top to bottom; null at either end.
 *
 * The bridge removes the floor and re-inserts it at `index`, and indexes also
 * count assigned sessions that are gone right now. Taking the neighbour's own
 * index passes that neighbour, whatever gaps lie between them.
 */
export function floorMove(
  stack: ReadonlyArray<{ session: string; floor: { index: number | null } }>,
  session: string,
  building: string,
  dir: -1 | 1,
): { session: string; building: string; index: number } | null {
  const i = stack.findIndex((f) => f.session === session);
  const n = i < 0 ? undefined : stack[i + dir];
  if (!n) return null;
  return { session, building, index: n.floor.index ?? i + dir };
}

/** `building.reorder` ids with `id` swapped one place up (-1) or down (+1); null at either end. */
export function buildingOrder(ids: readonly string[], id: string, dir: -1 | 1): string[] | null {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return null;
  const out = [...ids];
  [out[i], out[j]] = [out[j] as string, out[i] as string];
  return out;
}
