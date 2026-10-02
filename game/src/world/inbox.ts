/**
 * #100: the inbox, the HUD chip under the plan limits. Who is in it: every
 * worker that needs you (any role), and every employee that is done (a
 * freelancer's done is its run's business, not yours). N's queue without the
 * "your building first" tier: needs-you before done, the longest wait first,
 * wherever you are. Workers on a sleeping floor and #98's waiting ones are
 * not in it (their display is neither). Pure.
 */

import { isFreelancer, type CrewRole } from './crew';
import { needQueue, type NeedCandidate, type NeedItem } from './next';

export interface InboxCandidate extends NeedCandidate {
  /** The crew role (crew.ts `crewRole`); null: an employee. */
  role: CrewRole | null;
}

/** The inbox in the order its clicks visit it. */
export function inboxQueue(workers: Iterable<InboxCandidate>): NeedItem[] {
  const keep: NeedCandidate[] = [];
  for (const { role, ...w } of workers) if (w.display === 'needs_you' || (w.display === 'done' && !isFreelancer(role))) keep.push(w);
  return needQueue(keep);
}

/** What the chip shows: how many, and whether any of them needs you (the accent); null hides it. */
export function inboxChip(queue: readonly NeedItem[]): { count: number; blocked: boolean } | null {
  return queue.length ? { count: queue.length, blocked: queue.some((w) => w.reason === 'blocked') } : null;
}
