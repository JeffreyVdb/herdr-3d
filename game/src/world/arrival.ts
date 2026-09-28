/**
 * Walk-in and walk-out (M4) as a timeline: pure, so vitest covers it and the
 * renderer only draws what `poseAt` says. A worker sent home packs a
 * cardboard box at its desk, takes the laptop, stands up and walks
 * `walkOutRoute` out (fire escape, street, away east); a new hire walks the
 * same route reversed, carrying its box with the laptop on top, and sits
 * down. Heights come from the route's waypoints (`y`, feet above the street),
 * so taller floors and other flights need nothing here.
 */

import type { BuildingPlan } from './building';
import type { FloorLayout } from './layout';
import { walkOutRoute, type Waypoint } from './route';

export type ArrivalKind = 'in' | 'out';
export type Phase = 'pack' | 'stand' | 'walk' | 'vanish' | 'appear' | 'sit' | 'done';

/** Walking pace (m/s): a relaxed stroll, a bit slower than you walk. */
export const WALK_SPEED = 1.5;
export const PACK_S = 2.6;
/** Within the packing: the laptop is lifted off the desk onto the box. */
export const TAKE_LAPTOP_AT = 1.9;
export const LIFT_S = 0.35;
export const STAND_S = 0.6;
export const VANISH_S = 0.5;
export const APPEAR_S = 0.4;
export const SIT_S = 0.7;
/** When the items (mug, plant, photo) drop into the box during the packing. */
export const ITEM_AT = [0.45, 0.95, 1.45];
export const ITEMS = ITEM_AT.length;
/** The desk gets its "+" back once the worker is this far along the way out (out of the pod). */
export const PLUS_BACK_AFTER_M = 2.2;
/** Stride length (m) for the leg swing. */
export const STRIDE_M = 0.9;
/** The worker's origin above its feet: seated (the chair seat) and standing. */
export const SEAT_LIFT = 0.45;
export const STAND_LIFT = 0.15;

/** The walk-in: the walk-out reversed (street → fire escape → the floor's door → the desk). */
export function walkInRoute(layout: FloorLayout, plan: BuildingPlan, storey: number, desk: number): Waypoint[] {
  return walkOutRoute(layout, plan, storey, desk).reverse();
}

export interface Stage {
  phase: Exclude<Phase, 'done'>;
  t0: number;
  t1: number;
}

export interface Timeline {
  kind: ArrivalKind;
  route: Waypoint[];
  /** Cumulative distance (horizontal and vertical) at each waypoint. */
  at: number[];
  length: number;
  /** The desk slot's facing (the chair's yaw), for sitting down and standing up. */
  seatYaw: number;
  stages: Stage[];
  total: number;
}

export function cumulative(route: readonly Waypoint[]): number[] {
  const out: number[] = [];
  let d = 0;
  route.forEach((p, i) => {
    const q = route[i - 1];
    if (q) d += Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
    out.push(d);
  });
  return out;
}

/** `route`: the walk-out route for `out`, the walk-in route for `in`. */
export function timeline(kind: ArrivalKind, route: Waypoint[], seatYaw: number): Timeline {
  const at = cumulative(route);
  const length = at[at.length - 1] ?? 0;
  const walk = length / WALK_SPEED;
  const stages: Stage[] = [];
  let t = 0;
  const add = (phase: Stage['phase'], d: number) => {
    stages.push({ phase, t0: t, t1: t + d });
    t += d;
  };
  if (kind === 'out') {
    add('pack', PACK_S);
    add('stand', STAND_S);
    add('walk', walk);
    add('vanish', VANISH_S);
  } else {
    add('appear', APPEAR_S);
    add('walk', walk);
    add('sit', SIT_S);
  }
  return { kind, route, at, length, seatYaw, stages, total: t };
}

/** Facing along a direction in the xz plane (workers face +z at yaw 0). */
const yawOf = (dx: number, dz: number) => Math.atan2(dx, dz);

/** The point `d` metres along the route, and the facing of the segment it is on. */
export function sampleRoute(route: readonly Waypoint[], at: readonly number[], d: number): { x: number; y: number; z: number; yaw: number } {
  const first = route[0];
  if (!first) return { x: 0, y: 0, z: 0, yaw: 0 };
  let yaw = 0;
  const n = route.length;
  // Facing of the first segment that goes somewhere (for a start on the spot).
  for (let i = 1; i < n; i++) {
    const a = route[i - 1] as Waypoint;
    const b = route[i] as Waypoint;
    if (Math.hypot(b.x - a.x, b.z - a.z) > 1e-6) {
      yaw = yawOf(b.x - a.x, b.z - a.z);
      break;
    }
  }
  if (d <= 0 || n === 1) return { x: first.x, y: first.y, z: first.z, yaw };
  for (let i = 1; i < n; i++) {
    const a = route[i - 1] as Waypoint;
    const b = route[i] as Waypoint;
    const d0 = at[i - 1] as number;
    const d1 = at[i] as number;
    if (Math.hypot(b.x - a.x, b.z - a.z) > 1e-6) yaw = yawOf(b.x - a.x, b.z - a.z);
    if (d <= d1 || i === n - 1) {
      const k = d1 > d0 ? Math.min(1, Math.max(0, (d - d0) / (d1 - d0))) : 1;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, yaw };
    }
  }
  const last = route[n - 1] as Waypoint;
  return { x: last.x, y: last.y, z: last.z, yaw };
}

/** Shortest turn from `a` to `b`, `k` of the way. */
function turn(a: number, b: number, k: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

const ease = (k: number) => k * k * (3 - 2 * k);
const clamp01 = (k: number) => Math.min(1, Math.max(0, k));

/**
 * What the desk shows meanwhile: `busy` (chair out, laptop on it, the worker
 * drawn by the animation), `empty` (chair in, no laptop, no "+"), or `free`
 * (what the world says: "+" for a free desk, the worker for a taken one).
 */
export type DeskShow = 'busy' | 'empty' | 'free';

export interface ArrivalPose {
  phase: Phase;
  /** The worker's origin: feet + SEAT_LIFT seated, + STAND_LIFT standing (absolute, above the street). */
  x: number;
  y: number;
  z: number;
  yaw: number;
  seated: boolean;
  /** Stride phase (radians) while walking, null otherwise. */
  stride: number | null;
  /** 0..1: popping in on the sidewalk, fading out down the street. */
  scale: number;
  /** Where the box is: on the desk being packed, carried, or not there. */
  box: 'desk' | 'carried' | 'none';
  /** 0..1: the box (and the laptop on it) popping up on the desk, or set down when sitting. */
  boxScale: number;
  /** Items in the box so far (0..ITEMS). */
  items: number;
  /** The laptop: the desk's own (`desk`), lifted from the desk onto the box (`lift`, `k` of the way), on the carried box, or gone. */
  laptop: 'desk' | 'lift' | 'carried' | 'none';
  lift: number;
  /** Distance walked (m). */
  walked: number;
  desk: DeskShow;
}

function stageAt(tl: Timeline, t: number): { s: Stage; k: number } | null {
  for (const s of tl.stages) if (t < s.t1) return { s, k: clamp01((t - s.t0) / Math.max(1e-6, s.t1 - s.t0)) };
  return null;
}

export function poseAt(tl: Timeline, t: number): ArrivalPose {
  const route = tl.route;
  const cur = stageAt(tl, t);
  const seatEnd = tl.kind === 'out' ? route[0] : route[route.length - 1];
  const seat = seatEnd ?? { x: 0, y: 0, z: 0 };
  const base: ArrivalPose = {
    phase: 'done',
    x: seat.x,
    y: seat.y + STAND_LIFT,
    z: seat.z,
    yaw: tl.seatYaw,
    seated: false,
    stride: null,
    scale: 1,
    box: 'none',
    boxScale: 1,
    items: ITEMS,
    laptop: 'none',
    lift: 0,
    walked: 0,
    desk: 'free',
  };
  const walkAt = (d: number): Pick<ArrivalPose, 'x' | 'y' | 'z' | 'yaw' | 'walked'> => {
    const p = sampleRoute(route, tl.at, d);
    return { x: p.x, y: p.y + STAND_LIFT, z: p.z, yaw: p.yaw, walked: d };
  };
  if (!cur) {
    // Done: gone down the street, or sitting at the desk (the world's own seat takes over).
    if (tl.kind === 'out') {
      const end = walkAt(tl.length);
      return { ...base, ...end, scale: 0, desk: 'free' };
    }
    return { ...base, y: seat.y + SEAT_LIFT, seated: true, desk: 'free' };
  }
  const { s, k } = cur;
  const firstYaw = sampleRoute(route, tl.at, 0).yaw;
  switch (s.phase) {
    case 'pack': {
      const tt = t - s.t0;
      const items = ITEM_AT.filter((a) => tt >= a).length;
      const lifted = tt >= TAKE_LAPTOP_AT;
      return {
        ...base,
        phase: 'pack',
        y: seat.y + SEAT_LIFT,
        seated: true,
        box: 'desk',
        boxScale: ease(clamp01(tt / 0.3)),
        items,
        laptop: lifted ? (tt < TAKE_LAPTOP_AT + LIFT_S ? 'lift' : 'carried') : 'desk',
        lift: lifted ? clamp01((tt - TAKE_LAPTOP_AT) / LIFT_S) : 0,
        desk: lifted ? 'empty' : 'busy',
      };
    }
    case 'stand':
      return {
        ...base,
        phase: 'stand',
        y: seat.y + SEAT_LIFT + (STAND_LIFT - SEAT_LIFT) * ease(k),
        yaw: turn(tl.seatYaw, firstYaw, ease(k)),
        seated: k < 0.5,
        box: 'carried',
        laptop: 'carried',
        desk: 'empty',
      };
    case 'walk': {
      const d = tl.length * k;
      const p = walkAt(d);
      const deskShow: DeskShow = tl.kind === 'in' ? 'empty' : d >= PLUS_BACK_AFTER_M ? 'free' : 'empty';
      return { ...base, ...p, phase: 'walk', stride: (d / STRIDE_M) * Math.PI * 2, box: 'carried', laptop: 'carried', desk: deskShow };
    }
    case 'vanish':
      return { ...base, ...walkAt(tl.length), phase: 'vanish', scale: 1 - ease(k), box: 'carried', laptop: 'carried', desk: 'free' };
    case 'appear':
      return { ...base, ...walkAt(0), phase: 'appear', scale: ease(k), box: 'carried', laptop: 'carried', desk: 'empty' };
    case 'sit': {
      const lastYaw = sampleRoute(route, tl.at, tl.length).yaw;
      return {
        ...base,
        phase: 'sit',
        y: seat.y + STAND_LIFT + (SEAT_LIFT - STAND_LIFT) * ease(k),
        yaw: turn(lastYaw, tl.seatYaw, ease(clamp01(k * 1.6))),
        seated: k >= 0.5,
        // The worker sets the box and laptop down as it sits: the world's laptop takes over at the end.
        box: 'carried',
        boxScale: 1 - ease(k),
        laptop: 'carried',
        desk: 'empty',
      };
    }
  }
  return base;
}

/**
 * What each desk shows while walks run: one entry per desk. `ended` (walks
 * that just finished or were cancelled: the desk as the world says) come
 * first, then `walking` in the order the walks started, oldest first. The
 * newest walk on a desk owns it: a new hire walking in to the desk a worker
 * sent home is still walking out of keeps its desk empty, never the older
 * walk's "as the world says" (which would seat the new hire mid-walk).
 */
export function deskOwners<T extends { session: string; desk: number }>(ended: readonly T[], walking: readonly T[]): T[] {
  const by = new Map<string, T>();
  for (const d of [...ended, ...walking]) by.set(`${d.session}\u0000${d.desk}`, d);
  return [...by.values()];
}
