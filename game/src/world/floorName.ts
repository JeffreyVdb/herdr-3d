import type { Floor, Worker } from '../net/protocol';

// #58: a floor's id is the key (a real floor's is its session's name, a virtual floor's `v-<12 hex>`); its name is what
// a person sees. Nothing here imports the store, so every module can name a floor.

/** A floor id the bridge minted for a virtual floor (never shown to a person). */
export const isVirtualFloorId = (id: string): boolean => /^v-[0-9a-f]{12}$/.test(id);

/** The name a person sees for a floor: its own (a virtual floor's), else its session's; never a `v-` id. */
export function floorName(f: Pick<Floor, 'session' | 'name' | 'virtual' | 'id'>): string {
  const n = f.name?.trim();
  if (n) return n;
  return f.virtual || isVirtualFloorId(f.id ?? f.session) ? 'Unnamed floor' : f.session;
}

/** The name of floor `id` in `floors` (a map keyed by floor id), also once it is gone: a `v-` id reads "That floor". */
export function floorNameOf(floors: { get(id: string): Pick<Floor, 'session' | 'name' | 'virtual' | 'id'> | undefined }, id: string): string {
  const f = floors.get(id);
  if (f) return floorName(f);
  return isVirtualFloorId(id) ? 'That floor' : id;
}

/** The floor a worker is on (an older bridge sends no `floor`: its session's). */
export const floorOf = (w: Pick<Worker, 'floor' | 'session'>): string => w.floor ?? w.session;
