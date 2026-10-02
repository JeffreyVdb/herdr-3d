/**
 * Arrivals as a timeline: pure, so vitest covers it and the renderer only
 * draws what `poseAt` says. M4: a worker sent home packs a cardboard box at
 * its desk (M6b: its things go in one by one from where they stand on the
 * desk, then the laptop out of its dock), stands up and walks `walkOutRoute`
 * out (fire escape, street, away east). Heights come from the route's
 * waypoints (`y`, feet above the street), so taller floors and other flights
 * need nothing here.
 *
 * M6b: a new hire no longer walks in. It drops into its chair from above
 * (`drop`: under a second, a squash as it lands, a puff of dust). The desk
 * is the worker's from the first frame (never `away`): its card, look-at,
 * sitting at its screen and prompts all work while it plays, so the drop is
 * only for looks.
 */

import type { Waypoint } from './route';

/** M6c: `deliver`: a freelancer walks its report to the orchestrator's desk and back. */
export type ArrivalKind = 'in' | 'out' | 'deliver';
export type Phase = 'pack' | 'stand' | 'walk' | 'vanish' | 'drop' | 'done' | 'wave' | 'hand' | 'sit';

/**
 * M6: what the walker carries. `box`: an employee (one sent home packs up).
 * `briefcase`: a write-code freelancer walks out with its briefcase in hand,
 * and waves goodbye at its desk before it leaves (no packing).
 */
export type Carry = 'box' | 'briefcase';
/** M6: the goodbye wave at the desk. */
export const WAVE_S = 1.4;

/** Walking pace (m/s): a relaxed stroll, a bit slower than you walk. */
export const WALK_SPEED = 1.5;
export const PACK_S = 2.6;
/** Within the packing: the laptop is lifted out of its dock onto the box. */
export const TAKE_LAPTOP_AT = 1.9;
export const LIFT_S = 0.35;
export const STAND_S = 0.6;
export const VANISH_S = 0.5;
/** M6b: the drop-in: it falls for `FALL_S` from `DROP_H` above the seat, lands, and settles by `DROP_S`. */
export const DROP_S = 0.85;
export const FALL_S = 0.36;
export const DROP_H = 1.6;
/** M6b: the dust puff of the landing, and the landing shadow on the seat meanwhile. */
export const PUFF_S = 0.42;
/** M6b: how long one keepsake takes from the desk into the box. */
export const ITEM_LIFT_S = 0.26;
/** The desk's items (mug, plant, photo…) a box holds by default (the M4 three). */
export const ITEMS = 3;
/** When item `i` of `n` leaves the desk for the box during the packing: all of them before the laptop. */
export function itemAt(i: number, n: number): number {
  return n <= 1 ? 0.3 : 0.3 + (i * 1.2) / (n - 1);
}
/** The desk gets its "+" back once the worker is this far along the way out (out of the pod). */
export const PLUS_BACK_AFTER_M = 2.2;
/**
 * M6c: the report's walk. Stand up with the folder (the chair pushed back), walk to the hand-over spot at a brisk
 * pace (2 to 3 s on a normal pod), hand it over, walk back and sit down.
 */
export const DELIVER_SPEED = 1.9;
export const HAND_S = 1.1;
export const SIT_S = 0.5;
/** Within the hand-over (0..1): when the orchestrator swivels round and back, reaches, and the folder flies to the tray (it lands at `LAND`). */
export const HAND_SWIVEL_IN = 0.25;
export const HAND_SWIVEL_OUT = 0.82;
export const HAND_FLY = { from: 0.3, to: 0.78 } as const;
/** An orchestrator that does not turn (busy elsewhere): the freelancer puts the folder on the tray itself, earlier. */
export const HAND_FLY_SELF = { from: 0.18, to: 0.62 } as const;
/** Stride length (m) for the leg swing. */
export const STRIDE_M = 0.9;
/** The worker's origin above its feet: seated (the chair seat) and standing. */
export const SEAT_LIFT = 0.45;
export const STAND_LIFT = 0.15;

export interface Stage {
  phase: Exclude<Phase, 'done'>;
  t0: number;
  t1: number;
  /** A walk: the stretch of the route it covers (m); the whole route when absent. */
  d0?: number;
  d1?: number;
}

export interface Timeline {
  kind: ArrivalKind;
  /** The walk-out route (`out`); for `in`, just the seat. */
  route: Waypoint[];
  /** Cumulative distance (horizontal and vertical) at each waypoint. */
  at: number[];
  length: number;
  /** The desk slot's facing (the chair's yaw), for sitting down and standing up. */
  seatYaw: number;
  stages: Stage[];
  total: number;
  /** M6 */
  carry: Carry;
  /** M6b: the desk's items the packing puts in the box. */
  items: number;
  /** M6c: a delivery: the facing at the hand-over spot, and whether the orchestrator turns to take the folder. */
  deliver?: { handYaw: number; swivels: boolean };
  /** M6c: a walk-out that starts on its feet away from the desk (mid-delivery): no packing, standing up or waving. */
  standing?: boolean;
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

/** `route`: the walk-out route for `out`, the seat for `in` (only its first point counts). `items`: what the packing takes off the desk. */
export function timeline(kind: ArrivalKind, route: Waypoint[], seatYaw: number, carry: Carry = 'box', items = ITEMS, standing = false): Timeline {
  if (kind === 'in') {
    const seat = route.at(-1) ?? { x: 0, y: 0, z: 0 };
    return { kind, route: [seat], at: [0], length: 0, seatYaw, stages: [{ phase: 'drop', t0: 0, t1: DROP_S }], total: DROP_S, carry, items: 0 };
  }
  const at = cumulative(route);
  const length = at[at.length - 1] ?? 0;
  const walk = length / WALK_SPEED;
  const stages: Stage[] = [];
  let t = 0;
  const add = (phase: Stage['phase'], d: number) => {
    stages.push({ phase, t0: t, t1: t + d });
    t += d;
  };
  if (kind === 'out' && standing) {
    add('walk', walk);
    add('vanish', VANISH_S);
  } else if (kind === 'out' && carry === 'briefcase') {
    add('stand', STAND_S);
    add('wave', WAVE_S);
    add('walk', walk);
    add('vanish', VANISH_S);
  } else {
    add('pack', PACK_S);
    add('stand', STAND_S);
    add('walk', walk);
    add('vanish', VANISH_S);
  }
  return { kind, route, at, length, seatYaw, stages, total: t, carry, items: carry === 'briefcase' ? 0 : Math.max(0, items), ...(standing ? { standing } : {}) };
}

/**
 * M6c: a delivery. `route` goes from the seat to the hand-over spot; the way back is the same route reversed, so the
 * timeline's own route is both, end to end. `handYaw`: the way the freelancer faces at the spot; `swivels`: the
 * orchestrator turns in its chair to take the folder (else the freelancer puts it on the tray itself).
 */
export function deliveryTimeline(route: Waypoint[], seatYaw: number, o: { handYaw: number; swivels: boolean }): Timeline {
  const there = route;
  const full = [...there, ...[...there].reverse().slice(1)];
  const at = cumulative(full);
  const length = at[at.length - 1] ?? 0;
  const half = (at[there.length - 1] as number | undefined) ?? 0;
  const stages: Stage[] = [];
  let t = 0;
  const add = (phase: Stage['phase'], d: number, d0?: number, d1?: number) => {
    stages.push({ phase, t0: t, t1: t + d, ...(d0 !== undefined ? { d0, d1: d1 as number } : {}) });
    t += d;
  };
  add('stand', STAND_S);
  add('walk', half / DELIVER_SPEED, 0, half);
  add('hand', HAND_S);
  add('walk', (length - half) / DELIVER_SPEED, half, length);
  add('sit', SIT_S);
  return { kind: 'deliver', route: full, at, length, seatYaw, stages, total: t, carry: 'briefcase', items: 0, deliver: o };
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
  /** 0..1: the box popping up on the desk. */
  boxScale: number;
  /** Items in the box so far (0..the timeline's `items`). */
  items: number;
  /** M6b: 0..1 of the way the next item (index `items`) is from the desk into the box; 0 while it is still on the desk. */
  itemLift: number;
  /** The laptop: in its dock on the desk (`desk`), lifted out onto the box (`lift`, `k` of the way), on the carried box, or gone. */
  laptop: 'desk' | 'lift' | 'carried' | 'none';
  lift: number;
  /** Distance walked (m). */
  walked: number;
  desk: DeskShow;
  /** M6: the freelancer's briefcase, in its hand or not there. */
  briefcase: 'hand' | 'none';
  /** M6: waving goodbye. */
  wave: boolean;
  /** M6b, dropping in: the height above the seat (m), the squash (1: none; under 1 flattened, over 1 stretched). */
  dy: number;
  squash: number;
  /** M6b: the landing's dust puff, 0..1 of the way (null: none), and the landing shadow on the seat, 0..1 (0: none). */
  puff: number | null;
  shadow: number;
  /**
   * M6c, a delivery: the report folder (against the chest walking, held out at the hand-over, flying to the tray, or
   * not there), how far along the flight it is, how far the orchestrator has swivelled to the spot and reaches (0..1),
   * how far the freelancer's chair is pushed back (0..1), and whether the folder has landed on the tray.
   */
  folder: 'carry' | 'out' | 'flight' | 'none';
  flight: number;
  swivel: number;
  reach: number;
  chair: number;
  landed: boolean;
}

function stageAt(tl: Timeline, t: number): { s: Stage; k: number } | null {
  for (const s of tl.stages) if (t < s.t1) return { s, k: clamp01((t - s.t0) / Math.max(1e-6, s.t1 - s.t0)) };
  return null;
}

export function poseAt(tl: Timeline, t: number): ArrivalPose {
  if (tl.kind === 'deliver') return deliverPoseAt(tl, t);
  const p = boxPoseAt(tl, t);
  if (tl.carry !== 'briefcase') return p;
  // M6: the briefcase replaces the box and the laptop; it is in hand from standing up to sitting down.
  if (tl.kind === 'in') return p;
  return { ...p, box: 'none', boxScale: 1, laptop: 'none', lift: 0, items: 0, itemLift: 0, briefcase: p.phase === 'done' ? 'none' : 'hand', wave: p.phase === 'wave' };
}

/** A pose with everything off: standing on the spot at `seat`, facing `yaw`. */
function blankPose(seat: Waypoint, yaw: number, items: number): ArrivalPose {
  return {
    phase: 'done',
    x: seat.x,
    y: seat.y + STAND_LIFT,
    z: seat.z,
    yaw,
    seated: false,
    stride: null,
    scale: 1,
    box: 'none',
    boxScale: 1,
    items,
    itemLift: 0,
    laptop: 'none',
    lift: 0,
    walked: 0,
    desk: 'free',
    briefcase: 'none',
    wave: false,
    dy: 0,
    squash: 1,
    puff: null,
    shadow: 0,
    folder: 'none',
    flight: 0,
    swivel: 0,
    reach: 0,
    chair: 0,
    landed: false,
  };
}

/** 0 → 1 over `a`..`b`, eased. */
const ramp = (k: number, a: number, b: number) => ease(clamp01((k - a) / Math.max(1e-6, b - a)));

/**
 * M6c: a delivery's pose. The desk stays the world's (`desk: 'free'`: the laptop screen stays live), only the
 * figure is the walker's. The hand-over: the freelancer holds the folder out facing the orchestrator, who (if it
 * turns at all) swivels round, reaches, takes it and drops it on the tray as the chair swings back; otherwise the
 * freelancer drops it there itself.
 */
function deliverPoseAt(tl: Timeline, t: number): ArrivalPose {
  const route = tl.route;
  const seat = route[0] ?? { x: 0, y: 0, z: 0 };
  const o = tl.deliver as NonNullable<Timeline['deliver']>;
  const cur = stageAt(tl, t);
  const firstYaw = sampleRoute(route, tl.at, 0).yaw;
  const base: ArrivalPose = { ...blankPose(seat, tl.seatYaw, 0), y: seat.y + SEAT_LIFT, seated: true };
  const walkAt = (d: number): Pick<ArrivalPose, 'x' | 'y' | 'z' | 'yaw' | 'walked'> => {
    const p = sampleRoute(route, tl.at, d);
    return { x: p.x, y: p.y + STAND_LIFT, z: p.z, yaw: p.yaw, walked: d };
  };
  if (!cur) return { ...base, phase: 'done', landed: true };
  const { s, k } = cur;
  const half = (tl.stages.find((x) => x.phase === 'hand') as Stage | undefined) ? ((tl.stages.find((x) => x.phase === 'walk') as Stage).d1 as number) : 0;
  const lastYaw = sampleRoute(route, tl.at, Math.max(0, half - 1e-3)).yaw;
  const backYaw = sampleRoute(route, tl.at, half + 1e-3).yaw;
  switch (s.phase) {
    case 'stand':
      return {
        ...base,
        phase: 'stand',
        y: seat.y + SEAT_LIFT + (STAND_LIFT - SEAT_LIFT) * ease(k),
        yaw: turn(tl.seatYaw, firstYaw, ease(k)),
        seated: k < 0.5,
        folder: 'carry',
        chair: ease(k),
      };
    case 'walk': {
      const d = (s.d0 ?? 0) + ((s.d1 ?? tl.length) - (s.d0 ?? 0)) * k;
      const p = walkAt(d);
      // On the way back the folder is on the tray.
      const back = (s.d0 ?? 0) > 0;
      return { ...base, ...p, phase: 'walk', seated: false, stride: (d / STRIDE_M) * Math.PI * 2, folder: back ? 'none' : 'carry', chair: 1, landed: back };
    }
    case 'hand': {
      const p = walkAt(half);
      // Turns to face the orchestrator on arriving, and to the way back before leaving.
      const yaw = k < 0.5 ? turn(lastYaw, o.handYaw, ramp(k, 0, 0.18)) : turn(o.handYaw, backYaw, ramp(k, 0.82, 1));
      const fly = o.swivels ? HAND_FLY : HAND_FLY_SELF;
      const flying = k >= fly.from && k < fly.to;
      const gone = k >= fly.to;
      return {
        ...base,
        ...p,
        yaw,
        phase: 'hand',
        seated: false,
        stride: 0,
        folder: gone ? 'none' : flying ? 'flight' : 'out',
        flight: clamp01((k - fly.from) / (fly.to - fly.from)),
        swivel: o.swivels ? ramp(k, 0, HAND_SWIVEL_IN) * (1 - ramp(k, HAND_SWIVEL_OUT, 1)) : 0,
        reach: o.swivels ? ramp(k, HAND_SWIVEL_IN - 0.05, HAND_SWIVEL_IN + 0.15) * (1 - ramp(k, HAND_FLY.to - 0.12, HAND_SWIVEL_OUT)) : 0,
        chair: 1,
        landed: gone,
      };
    }
    case 'sit': {
      const e = ease(k);
      return {
        ...base,
        ...walkAt(tl.length),
        phase: 'sit',
        y: seat.y + STAND_LIFT + (SEAT_LIFT - STAND_LIFT) * e,
        yaw: turn(sampleRoute(route, tl.at, tl.length).yaw, tl.seatYaw, e),
        seated: k > 0.5,
        stride: null,
        chair: 1 - e,
        landed: true,
      };
    }
  }
  return { ...base, landed: true };
}

function boxPoseAt(tl: Timeline, t: number): ArrivalPose {
  const route = tl.route;
  const cur = stageAt(tl, t);
  const seatEnd = tl.kind === 'out' ? route[0] : route[route.length - 1];
  const seat = seatEnd ?? { x: 0, y: 0, z: 0 };
  const base = blankPose(seat, tl.seatYaw, tl.items);
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
      let items = 0;
      let itemLift = 0;
      for (let i = 0; i < tl.items; i++) {
        const a = itemAt(i, tl.items);
        if (tt >= a + ITEM_LIFT_S) items = i + 1;
        else {
          if (tt >= a) itemLift = clamp01((tt - a) / ITEM_LIFT_S);
          break;
        }
      }
      const lifted = tt >= TAKE_LAPTOP_AT;
      return {
        ...base,
        phase: 'pack',
        y: seat.y + SEAT_LIFT,
        seated: true,
        box: 'desk',
        boxScale: ease(clamp01(tt / 0.3)),
        items,
        itemLift,
        laptop: lifted ? (tt < TAKE_LAPTOP_AT + LIFT_S ? 'lift' : 'carried') : 'desk',
        lift: lifted ? clamp01((tt - TAKE_LAPTOP_AT) / LIFT_S) : 0,
        desk: lifted ? 'empty' : 'busy',
      };
    }
    case 'wave':
      // M6: standing by the chair, turned to the way out, waving.
      return { ...base, phase: 'wave', yaw: firstYaw, desk: 'empty' };
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
      const deskShow: DeskShow = d >= PLUS_BACK_AFTER_M || tl.standing ? 'free' : 'empty';
      return { ...base, ...p, phase: 'walk', stride: (d / STRIDE_M) * Math.PI * 2, box: 'carried', laptop: 'carried', desk: deskShow };
    }
    case 'vanish':
      return { ...base, ...walkAt(tl.length), phase: 'vanish', scale: 1 - ease(k), box: 'carried', laptop: 'carried', desk: 'free' };
    case 'drop': {
      // Falls (a little stretched), lands flattened on the seat, springs back up and settles.
      const tt = t - s.t0;
      const fall = clamp01(tt / FALL_S);
      const u = Math.max(0, tt - FALL_S);
      const rest = Math.max(1e-6, DROP_S - FALL_S);
      const squash = tt < FALL_S ? 1 + 0.16 * fall * fall : 1 - 0.3 * Math.exp(-6 * u) * Math.cos(15 * u) * (1 - u / rest) ** 2;
      return {
        ...base,
        phase: 'drop',
        y: seat.y + SEAT_LIFT + DROP_H * (1 - fall * fall),
        seated: true,
        dy: DROP_H * (1 - fall * fall),
        squash,
        puff: tt >= FALL_S && u < PUFF_S ? u / PUFF_S : null,
        shadow: tt < FALL_S ? 0.25 + 0.75 * fall : 0,
        desk: 'free',
      };
    }
  }
  return base;
}

/**
 * What each desk shows while walks run: one entry per desk. `ended` (walks
 * that just finished or were cancelled: the desk as the world says) come
 * first, then `walking` in the order the walks started, oldest first. The
 * newest walk on a desk owns it: a walk-out that started after another walk
 * there shows its packing, and a new hire dropping in to the desk a worker
 * sent home is still leaving shows the new hire (as the world says), never
 * the older walk's empty desk. (The older walk gives that desk up for good,
 * `Arrivals.yieldDesk`: it is not in `walking` any more, so it cannot take
 * the desk back once the drop is over.)
 */
export function deskOwners<T extends { session: string; desk: number }>(ended: readonly T[], walking: readonly T[]): T[] {
  const by = new Map<string, T>();
  for (const d of [...ended, ...walking]) by.set(`${d.session}\u0000${d.desk}`, d);
  return [...by.values()];
}
