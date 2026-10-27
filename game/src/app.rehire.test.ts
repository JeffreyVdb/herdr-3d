import './test/fakeCanvas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { Arrivals, type ArrivalSpec, type DeskAway } from './render/arrivals';
import type { AwaySeat } from './render/office';
import { PACK_S, PLUS_BACK_AFTER_M, STAND_S, WALK_SPEED } from './world/arrival';
import { buildingPlan, floorY } from './world/building';
import { trayFolderAt } from './world/delivery';
import { Reservations, resolveHireDesk } from './world/hire';
import { floorLayout, outlineOf, type FloorLayout } from './world/layout';
import { deskToDeskRoute, handOver, walkOutRoute } from './world/route';
import type { FloorView } from './world/store';
import { HandoffHireBook } from './world/handoffHire';

/**
 * #53: the hire gate (`App.heldDesks` → `resolveHireDesk`) with a worker sent home still walking out: real `Arrivals`,
 * `walkOutRoute` and `Reservations`. (No App test builds a whole App, which needs a renderer and a page: these take its
 * prototype and give it the parts the gate reads.)
 */

const DESKS = 12;
const DESK = 5;
const LOOK = { tint: 0x88aaff, cue: { family: 'opus', color: 0xff8844, hat: 'none' }, display: 'working', phase: 0, harness: 'codex' } as const;
/** The first moment the walk-out's desk has its "+" back (the probe in the issue). */
const PLUS_BACK = PACK_S + STAND_S + (PLUS_BACK_AFTER_M + 1) / WALK_SPEED;

/** The parts of App the gate and the reserved look use. */
interface Inside {
  arrivals: Arrivals;
  reserved: Reservations;
  office: unknown;
  reserve(floor: string, desk: number): () => void;
  applyReserve(): void;
  walkAway(o: unknown, d: DeskAway): AwaySeat | null;
}

/** A building whose top floor is storey `storey` (zero based), 12 desks a floor. */
function building(storey: number): FloorLayout & { plan: ReturnType<typeof buildingPlan> } {
  const counts = Array.from({ length: storey + 1 }, () => DESKS);
  const outline = outlineOf(counts);
  const layout = floorLayout(DESKS, outline);
  return Object.assign(layout, { plan: buildingPlan(outline, counts.length, layout.fireDoor) });
}

function walkOut(storey: number, id = 'pip', desk = DESK): ArrivalSpec {
  const L = building(storey);
  return { id, kind: 'out', floor: 'f', desk, name: id, route: walkOutRoute(L, L.plan, storey, desk), seatYaw: L.slots[desk]!.yaw, ...LOOK };
}

function dropIn(storey: number, id: string, desk: number): ArrivalSpec {
  const L = building(storey);
  const slot = L.slots[desk]!;
  return { id, kind: 'in', floor: 'f', desk, name: id, route: [{ x: slot.seat.x, y: floorY(storey), z: slot.seat.z }], seatYaw: slot.yaw, ...LOOK };
}

/** A freelancer at `DESK` on its way to hand a report to the orchestrator at desk 2. */
function delivery(storey: number): ArrivalSpec {
  const L = building(storey);
  const ho = handOver(L, { slot: 2 })!;
  const seat = { x: ho.seat.x, y: floorY(storey), z: ho.seat.z };
  return {
    id: 'deliver:w@1',
    kind: 'deliver',
    floor: 'f',
    desk: DESK,
    name: 'w',
    route: deskToDeskRoute(L, storey, DESK, { slot: 2 }),
    seatYaw: L.slots[DESK]!.yaw,
    ...LOOK,
    deliver: { key: 'w@1', handYaw: ho.yaw, swivels: false, orchDesk: 2, turn: ho.swivel, hand: { ...seat, y: seat.y + 0.95 }, tray: trayFolderAt({ ...seat, yaw: ho.seatYaw, side: ho.side }, 0), edge: 0xe03a33 },
  };
}

/** A floor nobody sits on (the bridge has removed the worker sent home), or with these desks taken. */
function floor(taken: Record<number, string> = {}): FloorView {
  const seats = Array.from({ length: DESKS }, (_, i) => (taken[i] ? { name: taken[i] } : null));
  return { name: 'Floor 1', asleep: false, transition: null, seats } as unknown as FloorView;
}

function scenario(...walks: ArrivalSpec[]) {
  const arrivals = new Arrivals(false);
  for (const w of walks) arrivals.start(w, 0);
  const app = Object.create(App.prototype) as App;
  const inside = app as unknown as Inside;
  // #219: no handoff hire holds a desk here.
  Object.assign(inside, { arrivals, reserved: new Reservations(), store: { handoffHires: new HandoffHireBook() } });
  /** The clock at `s` seconds; the walks advanced to it (a walk past its end is over). */
  const tick = (s: number) => {
    vi.spyOn(performance, 'now').mockReturnValue(s * 1000);
    return arrivals.update(s, s);
  };
  /** Hire at `desk` (none: the top bar's first free desk) at `s` seconds. */
  const hire = (s: number, fv = floor(), desk: number | undefined = DESK) => {
    tick(s);
    return resolveHireDesk('f', fv, app.heldDesks('f'), desk);
  };
  return { app, inside, arrivals, tick, hire };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('App.heldDesks: the desk of a worker sent home (#53)', () => {
  it.each([
    [0, PLUS_BACK],
    [0, 10],
    [0, 60],
    [6, PLUS_BACK],
    [6, 10],
    [6, 60],
  ])('storey %i, %fs after the bridge removed it: hireable at that desk and by the top bar', (storey, s) => {
    const h = scenario(walkOut(storey));
    const total = h.arrivals.info(0)[0]!.total;
    expect(h.hire(s)).toEqual({ ok: true, desk: DESK });
    // Still walking out, unless the route is over (storey 0 takes ~55 s, storey 6 ~123 s).
    expect(h.arrivals.has('pip')).toBe(s < total);
    if (s < total) expect(h.arrivals.info(s)[0]).toMatchObject({ phase: 'walk', desk_show: 'free' });
    // The top bar's Hire takes the first free desk: every other desk is taken.
    const others = Object.fromEntries(Array.from({ length: DESKS }, (_, i) => [i, i === DESK ? '' : `w${i}`]));
    expect(h.hire(s, floor(others), undefined)).toEqual({ ok: true, desk: DESK });
  });

  it.each([0, 6])('storey %i: hireable from the moment the bridge removed it, while it still packs', (storey) => {
    const h = scenario(walkOut(storey));
    expect(h.hire(0.1)).toEqual({ ok: true, desk: DESK });
    expect(h.arrivals.info(0.1)[0]!.phase).toBe('pack');
  });

  it.each([0, 6])('storey %i: hireable once the walk-out is over', (storey) => {
    const h = scenario(walkOut(storey));
    const total = h.arrivals.info(0)[0]!.total;
    expect(h.hire(total + 0.01)).toEqual({ ok: true, desk: DESK });
    expect(h.arrivals.count).toBe(0);
  });

  it('a report still being handed over by a freelancer the bridge removed does not hold its desk either', () => {
    const h = scenario(delivery(6));
    expect(h.hire(1)).toEqual({ ok: true, desk: DESK });
    expect(h.arrivals.info(1)[0]!.kind).toBe('deliver');
  });

  it('control: a hire on its way to the desk holds it, during the walk-out and after it', () => {
    const h = scenario(walkOut(6));
    h.inside.reserved.add('f', DESK);
    expect(h.hire(10)).toEqual({ ok: false, msg: 'Someone is already on the way to Desk 6.', ms: 2000 });
    const total = h.arrivals.info(0)[0]!.total;
    expect(h.hire(total + 1).ok).toBe(false);
  });

  it('control: a desk somebody sits at refuses', () => {
    const h = scenario(walkOut(6));
    expect(h.hire(10, floor({ [DESK]: 'Gumdrop' }))).toEqual({ ok: false, msg: 'Gumdrop sits at Desk 6.', ms: 2000 });
  });

  it('control: a new hire dropping in to a desk holds it', () => {
    const h = scenario(walkOut(6), dropIn(6, 'gumdrop', 7));
    expect(h.hire(0.1, floor(), 7)).toEqual({ ok: false, msg: 'Someone is already on the way to Desk 8.', ms: 2000 });
    expect([...h.app.heldDesks('f')]).toEqual([7]);
  });
});

describe('App: a hire on its way to a desk a worker sent home is still leaving (#53)', () => {
  /** The office as the reserved look and the walks drive it: what each frame set on `DESK`. */
  function office(h: ReturnType<typeof scenario>) {
    const seats: Array<{ name: string } | null> = Array(DESKS).fill(null);
    const frames: Array<Array<AwaySeat | null>> = [[]];
    // (A value set again as it is changes nothing: `OfficeView.setAway` returns early. A frame lists each change.)
    const o = {
      id: 'f',
      seat: (i: number) => seats[i] ?? null,
      setAway: (d: number, a: AwaySeat | null) => {
        const f = frames.at(-1)!;
        if (d === DESK && (!f.length || JSON.stringify(f.at(-1)) !== JSON.stringify(a))) f.push(a);
      },
    };
    h.inside.office = o;
    /** One frame at `s` seconds, as `App.stepArrivals` applies it. */
    const frame = (s: number) => {
      frames.push([]);
      for (const d of h.tick(s)) if (d.floor === o.id) o.setAway(d.desk, h.inside.walkAway(o, d));
      h.inside.applyReserve();
      return frames.at(-1)!;
    };
    return { seats, frames, frame };
  }
  const RESERVED = { show: 'empty', display: 'idle', cue: 0xffffff };

  it('while it packs, the desk is the walk’s (its things, its laptop, chair out); then reserved, never "+" in between', () => {
    const h = scenario(walkOut(6));
    const o = office(h);
    o.frame(1.2);
    h.inside.reserve('f', DESK);
    // Reserving does not empty the desk under the packing worker.
    expect(o.frames.at(-1)!.every((a) => a?.show === 'busy')).toBe(true);
    expect(o.frame(1.3)).toEqual([expect.objectContaining({ show: 'busy', packed: expect.any(Number) })]);
    // Its "+" would be back now: the desk is reserved instead, and stays so frame after frame (no "+" flip each frame).
    for (const s of [PLUS_BACK, PLUS_BACK + 0.1, 30]) expect(o.frame(s)).toEqual([RESERVED]);
  });

  it('the hire fails while it packs: the walk goes on as it was and the "+" comes back with it', () => {
    const h = scenario(walkOut(6));
    const o = office(h);
    const release = h.inside.reserve('f', DESK);
    o.frame(1.2);
    release();
    expect(o.frame(1.3)).toEqual([expect.objectContaining({ show: 'busy' })]);
    expect(o.frame(PLUS_BACK)).toEqual([null]);
    expect(h.app.heldDesks('f').has(DESK)).toBe(false);
  });

  it('the hire fails once the "+" was due: the "+" comes back on the next frame', () => {
    const h = scenario(walkOut(6));
    const o = office(h);
    const release = h.inside.reserve('f', DESK);
    expect(o.frame(PLUS_BACK)).toEqual([RESERVED]);
    release();
    expect(o.frame(PLUS_BACK + 0.1)).toEqual([null]);
  });

  it('the hire fails after the walk-out is over: the closure gives the desk back at once', () => {
    const h = scenario(walkOut(0));
    const o = office(h);
    const release = h.inside.reserve('f', DESK);
    const total = h.arrivals.info(0)[0]!.total;
    expect(o.frame(total + 1)).toEqual([RESERVED]);
    o.frames.push([]);
    release();
    expect(o.frames.at(-1)).toEqual([null]);
  });

  it('the new worker sits down mid-pack: the walk-out gives the desk up for good, never packing or showing it again', () => {
    const h = scenario(walkOut(6));
    const o = office(h);
    h.inside.reserve('f', DESK);
    o.frame(1.2);
    // Its upsert: the store seats Gumdrop, `App.yieldTakenDesks` makes the walk give the desk up.
    o.seats[DESK] = { name: 'Gumdrop' };
    expect(h.arrivals.yieldDesk('f', DESK, 'gumdrop', 1.25)).toBe(true);
    expect(h.arrivals.info(1.25)[0]).toMatchObject({ yielded: true, phase: 'walk' });
    expect(o.frame(1.3)).toEqual([null]);
    for (const s of [2, PLUS_BACK, 60]) expect(o.frame(s)).toEqual([]);
    const total = h.arrivals.info(0)[0]!.total;
    expect(o.frame(total + 1)).toEqual([null]);
  });
});
