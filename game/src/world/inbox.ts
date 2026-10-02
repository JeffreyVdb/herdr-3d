/**
 * #100: the inbox, the HUD chip under the plan limits and its list. Who is in
 * it: every worker that needs you (any role), and every employee that is done
 * (a freelancer's done is its run's business, not yours, unless Settings says
 * to list them). N's queue without the "your building first" tier: needs-you
 * before done, the longest wait first, wherever you are. Workers on a sleeping
 * floor and #98's waiting ones are not in it (their display is neither). What
 * a row says: why (`inboxReason`), where (`inboxWhere`), since when
 * (`inboxAge`). Pure.
 */

import type { Building, Floor } from '../net/protocol';
import { askOf } from './ask';
import { isFreelancer, type CrewRole } from './crew';
import { followupOf } from './followup';
import { needQueue, type NeedCandidate, type NeedItem } from './next';
import type { WorkerView } from './store';
import { wrapUpOf } from './wrapup';

export interface InboxCandidate extends NeedCandidate {
  /** The crew role (crew.ts `crewRole`); null: an employee. */
  role: CrewRole | null;
}

export interface InboxOptions {
  /** Freelancers that are done are listed too (Settings → Notifications, `InboxSettings.freelancers`). */
  freelancers?: boolean;
}

/** The inbox in the order its list shows it. */
export function inboxQueue(workers: Iterable<InboxCandidate>, opts: InboxOptions = {}): NeedItem[] {
  const keep: NeedCandidate[] = [];
  for (const { role, ...w } of workers) if (w.display === 'needs_you' || (w.display === 'done' && (opts.freelancers || !isFreelancer(role)))) keep.push(w);
  return needQueue(keep);
}

/** Why a worker is in the inbox, as its row (and a notification) says it. */
export type InboxReason = 'Needs you' | 'Question' | 'Follow-up' | 'Wrap-up stuck' | 'Report asks' | 'Finished';

/**
 * Why `view` is in the inbox: done is Finished; needing you, the first of the fields `WorldStore.workerView` ORs
 * into needs_you that is set (#57 ask, #90 follow-up, #83 stuck wrap-up, a freelancer's report asking), else
 * Needs you (blocked, an orchestrator over its cap).
 */
export function inboxReason(view: Pick<WorkerView, 'display' | 'worker' | 'crew'>): InboxReason {
  if (view.display === 'done') return 'Finished';
  const w = view.worker;
  if (askOf(w)) return 'Question';
  if (followupOf(w)) return 'Follow-up';
  if (wrapUpOf(w)?.state === 'needs_you') return 'Wrap-up stuck';
  if (view.crew?.ask) return 'Report asks';
  return 'Needs you';
}

/**
 * Where a floor is, as you know it: `Herdr 3D › h3d-sesame-3` (the building, then the floor's session), and
 * `Unassigned › scratch` in the unassigned lot (or a building the store does not have). Takes the store's maps
 * (`WorldStore` fits).
 */
export function inboxWhere(store: { readonly buildings: ReadonlyMap<string, Building>; readonly floors: ReadonlyMap<string, Floor> }, session: string): string {
  const b = store.floors.get(session)?.building;
  return `${(b ? store.buildings.get(b)?.name : null) ?? 'Unassigned'} › ${session}`;
}

/** How long it has been in the inbox, coarsely: `now`, `4 min`, `2 h`, `3 d` (`since`, `now`: unix ms). */
export function inboxAge(since: number, now: number): string {
  const m = Math.floor(Math.max(0, now - since) / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}
