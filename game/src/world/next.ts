/**
 * M5: N, the next worker that needs you. The queue is the oldest `blocked`
 * worker first (by `status_since`), then the oldest `done`, on the floors of
 * the building you are in, then everyone else's; repeated N walks along it
 * and wraps round. Pure.
 */

import type { Display } from './derive';

export interface NeedCandidate {
  id: string;
  session: string;
  /** Building id, null for the unassigned lot. */
  building: string | null;
  display: Display;
  /** When the current status started (unix ms). */
  since: number;
  desk: number;
  name: string;
}

export interface NeedItem extends NeedCandidate {
  /** Why it is in the queue. */
  reason: 'blocked' | 'done';
}

/**
 * Who needs you, in the order N visits them: blocked before done, the
 * building you are in (`here`, undefined: none, e.g. in the city) before any
 * other, then the longest wait first (ties: floor, desk).
 */
export function needQueue(workers: Iterable<NeedCandidate>, here?: string | null): NeedItem[] {
  const out: NeedItem[] = [];
  for (const w of workers) {
    if (w.display === 'needs_you') out.push({ ...w, reason: 'blocked' });
    else if (w.display === 'done') out.push({ ...w, reason: 'done' });
  }
  const tier = (w: NeedItem) => (here !== undefined && w.building !== here ? 2 : 0) + (w.reason === 'blocked' ? 0 : 1);
  return out.sort((a, b) => tier(a) - tier(b) || a.since - b.since || a.session.localeCompare(b.session) || a.desk - b.desk || a.id.localeCompare(b.id));
}

/** The next one after `last` (the one N visited before), wrapping; the first when `last` left the queue. */
export function nextNeed(queue: readonly NeedItem[], last: string | null): NeedItem | null {
  if (!queue.length) return null;
  const i = last === null ? -1 : queue.findIndex((w) => w.id === last);
  return queue[(i + 1) % queue.length] ?? null;
}

export interface Spot {
  x: number;
  z: number;
  /** Facing the worker. */
  yaw: number;
  pitch: number;
}

/**
 * Where to stand to face a seated worker, best first: behind the chair (you
 * see the laptop over its shoulder), beside it either way, across the desk.
 * `seatYaw` is the layout's (0: the worker faces south, +z; it looks along
 * (sin, cos) of it); a spot's `yaw` is the walker's (0: north, -z).
 */
export function faceSpots(seat: { x: number; z: number }, seatYaw: number): Spot[] {
  const fx = Math.sin(seatYaw);
  const fz = Math.cos(seatYaw);
  const spot = (dx: number, dz: number, pitch: number): Spot => {
    const x = seat.x + dx;
    const z = seat.z + dz;
    return { x: round(x), z: round(z), yaw: round(Math.atan2(-(seat.x - x), -(seat.z - z))), pitch };
  };
  // Beside the worker: its forward turned a quarter.
  const rx = -fz;
  const rz = fx;
  // Far enough back that its card (a question's choices stand tall over its head) is in view, near
  // enough that look-at still picks it (within reach, the ray through the chair).
  return [
    spot(-fx * 1.8, -fz * 1.8, -0.13),
    spot(rx * 1.5, rz * 1.5, -0.14),
    spot(-rx * 1.5, -rz * 1.5, -0.14),
    spot(fx * 2, fz * 2, -0.12),
  ];
}

const round = (v: number) => Math.round(v * 1e4) / 1e4 || 0;
