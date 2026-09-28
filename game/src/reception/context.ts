import type { WorldStore } from '../world/store';
import type { ReceptionContext } from './lines';

/**
 * The receptionist's view of a building from the store: its floors top first,
 * running or asleep, and how many workers on each need you. `building` null is
 * the unassigned lot.
 */
export function receptionContext(store: WorldStore, building: string | null, now = new Date()): ReceptionContext {
  const b = building === null ? null : (store.buildings.get(building) ?? null);
  return {
    now,
    building: { id: b?.id ?? null, name: b?.name ?? 'Unassigned lot' },
    floors: store.stack(b ? b.id : null).map((f) => ({
      session: f.session,
      name: f.session,
      state: f.asleep ? 'asleep' : 'running',
      needsYou: f.counts.needsYou,
    })),
  };
}
