import { describe, expect, it } from 'vitest';
import { BODY_H, blocked, blocked3, groundAt, moveWalker, pickNearest, STEP_UP, type V3, type V3p, type WalkWorld } from './collide';
import { buildingPlan, floorY, loadedFloor, placeAt, walkWorld } from './building';
import { EYE_HEIGHT, floorLayout, GLASS_H, MEZZ_Y, outlineOf, overlookReach, POST_W, slotBoxes, slotRect, type Box3, type FloorLayout, type Rect } from './layout';
import { walkOutRoute } from './route';

const R = 0.28;
const COUNTS = [0, 1, 4, 6, 7, 9, 13, 20, 28, 41, 62, 96];
const rectOf = (b: Box3): Rect => ({ x0: b.min[0], z0: b.min[2], x1: b.max[0], z1: b.max[2] });
const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
const overlaps3 = (a: Box3, b: Box3) => [0, 1, 2].every((i) => a.min[i]! < b.max[i]! && a.max[i]! > b.min[i]!);
const postRect = (p: { x: number; z: number }): Rect => ({ x0: p.x - POST_W / 2, z0: p.z - POST_W / 2, x1: p.x + POST_W / 2, z1: p.z + POST_W / 2 });

/** One floor as its own building (storey 0), walked with its mezzanine. */
function single(L: FloorLayout) {
  const plan = buildingPlan({ width: L.width, depth: L.depth }, 1, L.fireDoor);
  return { plan, world: walkWorld(plan, loadedFloor(L, 0)), y: floorY(0) };
}

function walk(w: WalkWorld, from: V3p, to: { x: number; z: number }, stepLen = 0.04): V3p {
  let p = from;
  for (let i = 0; i < 4000; i++) {
    const dx = to.x - p.x;
    const dz = to.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) break;
    const k = Math.min(1, stepLen / d);
    const next = moveWalker(p, { x: dx * k, z: dz * k }, R, w);
    if (next.x === p.x && next.z === p.z) break;
    p = next;
  }
  return p;
}

describe('mezzanine layout', () => {
  const layouts: Array<[string, FloorLayout]> = [
    ...COUNTS.map((n): [string, FloorLayout] => [`${n} desks`, floorLayout(n)]),
    // A small floor in a big building's outline, and every floor of a mixed one.
    ['6 desks in a 96-desk outline', floorLayout(6, outlineOf([96]))],
    ...[6, 20, 41].map((n): [string, FloorLayout] => [`${n} desks in a mixed outline`, floorLayout(n, outlineOf([6, 20, 41, 62]))]),
  ];

  it.each(layouts)('%s: ~7 x 5 m in the north-east corner, inside the room, with headroom under it', (_, L) => {
    const m = L.mezzanine;
    expect(m.rect.x1).toBe(L.width);
    expect(m.rect.z0).toBe(0);
    expect(m.rect.x1 - m.rect.x0).toBeCloseTo(7, 6);
    expect(m.rect.z1 - m.rect.z0).toBeCloseTo(5, 6);
    expect(m.rect.x0).toBeGreaterThan(L.width / 2);
    expect(m.y).toBeCloseTo(3, 6);
    expect(m.under).toBeGreaterThanOrEqual(2.4);
    // Standing room on top too, under the ceiling.
    expect(L.height - m.y).toBeGreaterThanOrEqual(3);
    expect(m.y + GLASS_H).toBeLessThan(L.height);
    // Over the filing cabinet.
    const filing = L.props.find((p) => p.id === 'filing')!;
    expect(overlaps(rectOf(filing.box), m.rect)).toBe(true);
    expect(filing.box.max[1]).toBeLessThan(m.under);
  });

  it.each(layouts)('%s: posts and stair clear of desks, lounge, cabinet, elevator and board wall; the slab over everything', (_, L) => {
    const m = L.mezzanine;
    expect(m.posts.length).toBeGreaterThanOrEqual(1);
    const stair: Rect = { x0: m.stair.x0 - 0.07, z0: m.stair.top, x1: m.stair.x1, z1: m.stair.bottom };
    const things: Array<[string, Rect]> = [
      ...L.slots.map((s): [string, Rect] => [`desk ${s.index}`, slotRect(s)]),
      ...L.props.map((p): [string, Rect] => [p.id, rectOf(p.box)]),
      ['board wall', L.boardWall],
      ['coffee counter', { x0: 0, z0: 3.4, x1: 0.65, z1: 4.8 }],
    ];
    for (const [name, r] of things) {
      for (const p of m.posts) expect(overlaps(postRect(p), r), `post at ${p.x},${p.z} vs ${name}`).toBe(false);
      expect(overlaps(stair, r), `stair vs ${name}`).toBe(false);
    }
    // Posts stand under the mezzanine, inside the room; the stair runs up the east wall to the office door.
    for (const p of m.posts) {
      expect(p.x).toBeGreaterThanOrEqual(m.rect.x0);
      expect(p.z).toBeLessThanOrEqual(m.rect.z1);
      expect(p.z).toBeGreaterThan(0.2);
    }
    expect(m.stair.x1).toBeLessThanOrEqual(L.width);
    expect(m.stair.top).toBe(m.rect.z1);
    expect(m.stair.bottom).toBeLessThan(L.boardWall.z0);
    expect(m.door.x0).toBeGreaterThanOrEqual(m.stair.x0 - 1e-9);
    expect(m.door.x1).toBeLessThanOrEqual(m.stair.x1 + 1e-9);
    // The slab (and the office on it) is above every desk, chair, prop and the board wall.
    for (const s of L.slots) for (const b of Object.values(slotBoxes(s))) expect(overlaps3(b, m.slab)).toBe(false);
    for (const p of L.props) expect(overlaps3(p.box, m.slab), p.id).toBe(false);
    expect(overlaps3(L.walls[4]!, m.slab)).toBe(false);
    // Your desk is in the office, its chair right at the glass.
    for (const p of [m.desk.desk, m.desk.seat]) {
      expect(p.x).toBeGreaterThan(m.rect.x0 + 0.5);
      expect(p.x).toBeLessThan(m.rect.x1 - 0.5);
      expect(p.z).toBeGreaterThan(m.rect.z0 + 0.5);
      expect(p.z).toBeLessThan(m.rect.z1 - 0.5);
    }
    expect(Math.min(m.desk.seat.x - m.rect.x0, m.rect.z1 - m.desk.seat.z)).toBeLessThan(1);
  });

  it('the stair: a riser under a step up, treads meeting the mezzanine at the top', () => {
    const m = floorLayout(20).mezzanine;
    expect(m.stair.rise).toBeLessThan(STEP_UP);
    expect(m.stair.rise).toBeLessThan(0.19);
    const top = m.stair.treads.at(-1)!;
    expect(top.rect.z0).toBeCloseTo(m.rect.z1, 6);
    expect(MEZZ_Y - top.y).toBeCloseTo(m.stair.rise, 6);
    expect(m.stair.treads[0]!.rect.z1).toBeCloseTo(m.stair.bottom, 6);
  });
});

describe('walking the mezzanine', () => {
  const L = floorLayout(20);
  const m = L.mezzanine;
  const { plan, world, y } = single(L);
  const sx = (m.stair.x0 + m.stair.x1) / 2;

  it('stands on each tread of the stair and on the mezzanine; the floor under it stays the floor', () => {
    let prev = y;
    for (const t of m.stair.treads) {
      const cz = (t.rect.z0 + t.rect.z1) / 2;
      const g = groundAt(world.supports, sx, cz, prev);
      expect(g).toBeCloseTo(y + t.y, 6);
      prev = g as number;
    }
    expect(groundAt(world.supports, m.rect.x0 + 2, 2, prev)).toBeCloseTo(y + MEZZ_Y, 6);
    // From the floor below, the mezzanine is far overhead: not ground.
    expect(groundAt(world.supports, m.rect.x0 + 2, 2, y)).toBeCloseTo(y, 6);
    // Up there is still this floor.
    expect(placeAt({ x: m.rect.x0 + 2, y: y + MEZZ_Y, z: 2 }, plan)).toEqual({ area: 'floor', storey: 0 });
  });

  it('does not block walking under it: only its posts, the stair and what stands below do', () => {
    // Every spot under the mezzanine that is free on the floor plan (desks, walls, props) and clear of posts and the stair is free.
    let checked = 0;
    for (const n of COUNTS) {
      const Ln = floorLayout(n);
      const mn = Ln.mezzanine;
      const stair: Rect = { x0: mn.stair.x0 - 0.07, z0: mn.stair.top, x1: mn.stair.x1, z1: mn.stair.bottom };
      const w = single(Ln);
      for (let x = mn.rect.x0 + 0.1; x < mn.rect.x1; x += 0.2)
        for (let z = 0.1; z < mn.rect.z1 + 0.3; z += 0.2) {
          if (blocked({ x, z }, R, Ln.colliders)) continue;
          if (mn.posts.some((p) => overlaps({ x0: x - R, z0: z - R, x1: x + R, z1: z + R }, postRect(p)))) continue;
          if (overlaps({ x0: x - R, z0: z - R, x1: x + R, z1: z + R }, stair)) continue;
          expect(blocked3({ x, y: w.y, z }, R, w.world), `${n} desks at ${x.toFixed(1)},${z.toFixed(1)}`).toBe(false);
          checked++;
        }
    }
    expect(checked).toBeGreaterThan(500);
    // A straight walk across under it, west to east, clear of posts: nothing overhead stops you.
    const L6 = floorLayout(6);
    const w6 = single(L6);
    const z = L6.mezzanine.posts.some((p) => Math.abs(p.z - 2.2) < 0.6) ? 3.6 : 2.2;
    const across = walk(w6.world, { x: L6.mezzanine.rect.x0 - 1, y: w6.y, z }, { x: L6.width - 1.6, z });
    expect(across.x).toBeCloseTo(L6.width - 1.6, 2);
    expect(across.y).toBeCloseTo(w6.y, 6);
    // Posts and the stair do block.
    for (const p of m.posts) expect(blocked3({ x: p.x, y, z: p.z }, R, world)).toBe(true);
    expect(blocked3({ x: sx, y, z: m.stair.top + 1.5 }, R, world)).toBe(true);
  });

  it('walks from the elevator up the stair, through the glass door, to your desk', () => {
    let p: V3p = { x: L.spawn.x, y, z: L.spawn.z };
    const legs = [
      { x: L.spawn.x, z: L.depth - 2.6 },
      { x: sx, z: L.depth - 2.6 },
      { x: sx, z: m.stair.bottom + 0.4 },
      { x: sx, z: m.rect.z1 - 0.6 },
      { x: m.rect.x0 + 1, z: m.desk.desk.z - 1.1 },
      { x: m.desk.seat.x, z: m.desk.seat.z - 0.6 },
    ];
    for (const leg of legs) {
      p = walk(world, p, leg);
      expect(Math.hypot(p.x - leg.x, p.z - leg.z), `to ${JSON.stringify(leg)}`).toBeLessThan(0.02);
    }
    expect(p.y).toBeCloseTo(y + MEZZ_Y, 6);
    // And back down again.
    p = walk(world, p, { x: m.rect.x0 + 1, z: m.desk.desk.z - 1.1 });
    p = walk(world, p, { x: sx, z: m.rect.z1 - 0.6 });
    p = walk(world, p, { x: sx, z: m.stair.bottom + 0.5 });
    expect(p.y).toBeCloseTo(y, 6);
  });

  it('glass walls block walking up there; the edge never lets you drop', () => {
    const on: V3p = { x: m.rect.x0 + 2, y: y + MEZZ_Y, z: 2.5 };
    const west = walk(world, on, { x: m.rect.x0 - 3, z: 2.5 });
    expect(west.x).toBeGreaterThan(m.rect.x0 + 0.05);
    expect(west.y).toBeCloseTo(y + MEZZ_Y, 6);
    const south = walk(world, on, { x: m.rect.x0 + 2, z: m.rect.z1 + 3 });
    expect(south.z).toBeLessThan(m.rect.z1 - 0.05);
    expect(south.y).toBeCloseTo(y + MEZZ_Y, 6);
    // The glass is low enough to stand under the ceiling and high enough to stop a body.
    expect(GLASS_H).toBeGreaterThan(BODY_H);
    // Your desk is solid.
    expect(blocked3({ x: m.desk.desk.x, y: y + MEZZ_Y, z: m.desk.desk.z }, R, world)).toBe(true);
    expect(blocked3({ x: m.desk.seat.x, y: y + MEZZ_Y, z: m.desk.seat.z }, R, world)).toBe(false);
  });

  it('glass does not block look-at: from the glass, a worker at a desk below', () => {
    const blockers = [...L.walls, m.slab];
    const targets = L.slots.map((s) => ({ boxes: [slotBoxes(s).seat, slotBoxes(s).desk], value: s.index }));
    // At the west glass, eye height, looking down at the nearest desk to the south-west.
    const eye = [m.rect.x0 + 0.5, MEZZ_Y + EYE_HEIGHT, 3] as const;
    const s = [...L.slots].sort((a, b) => Math.hypot(a.seat.x - eye[0], a.seat.z - eye[2]) - Math.hypot(b.seat.x - eye[0], b.seat.z - eye[2])).find((q) => q.seat.x < m.rect.x0 || q.seat.z > m.rect.z1)!;
    const to = [s.seat.x - eye[0], 0.9 - eye[1], s.seat.z - eye[2]];
    const len = Math.hypot(...to);
    const dir = to.map((v) => v / len) as [number, number, number];
    // The ray passes through the glass...
    const glassHit = m.glass.some((g) => {
      const t = (g.min[0] - eye[0]) / dir[0];
      return t > 0 && t < len;
    });
    expect(glassHit || m.glass.some((g) => (g.min[2] - eye[2]) / dir[2] > 0)).toBe(true);
    // ...and picks the worker, 3 m reach is not enough, the overlook's is.
    expect(len).toBeGreaterThan(3);
    expect(pickNearest(eye, dir, targets, overlookReach(L), blockers)?.value).toBe(s.index);
    expect(pickNearest(eye, dir, targets, 3, blockers)).toBeNull();
    // Looking straight down through the slab picks nothing under it.
    const under = L.slots.find((q) => overlaps(slotRect(q), m.rect));
    if (under) expect(pickNearest([under.seat.x, MEZZ_Y + EYE_HEIGHT, under.seat.z], [0, -1, 0], targets, overlookReach(L), blockers)).toBeNull();
  });

  it('sitting faces the floor, out over the glass, from close enough to see down past the edge', () => {
    const f = { x: -Math.sin(m.sit.yaw), z: -Math.cos(m.sit.yaw) };
    const c = { x: (L.deskArea.x0 + L.deskArea.x1) / 2 - m.sit.x, z: (L.deskArea.z0 + L.deskArea.z1) / 2 - m.sit.z };
    expect((f.x * c.x + f.z * c.z) / Math.hypot(c.x, c.z)).toBeGreaterThan(0.99);
    expect(m.sit.pitch).toBeLessThan(0);
    // Seated eye (~1.2 m up) over the mezzanine's edge: the floor shows from a few metres past it.
    const edge = Math.min(Math.abs((m.rect.x0 - m.sit.x) / f.x), Math.abs((m.rect.z1 - m.sit.z) / f.z));
    const hidden = (edge * (MEZZ_Y + 1.2)) / 1.2 - edge;
    expect(hidden).toBeLessThan(3.5);
  });
});

describe('overlook reach (#20): every desk of the floor from up on the mezzanine', () => {
  const SIT_DROP = 0.36; // input/walk.ts: the seated eye sits this much lower
  // Where on a slot you might aim: the worker's head and chest, the desk top, the "+".
  const aims = (b: ReturnType<typeof slotBoxes>, worker: boolean): V3p[] => {
    const top = (q: Box3, dy: number): V3p => ({ x: (q.min[0] + q.max[0]) / 2, y: q.max[1] - dy, z: (q.min[2] + q.max[2]) / 2 });
    return worker ? [top(b.seat, 0.05), top(b.seat, 0.5), top(b.desk, 0.02)] : [top(b.plus, 0.05), top(b.desk, 0.02)];
  };

  for (const n of [20, 62, 96]) {
    const L = floorLayout(n);
    const m = L.mezzanine;
    const reach = overlookReach(L);
    const blockers = [...L.walls, m.slab];
    const poses: Array<[string, V3]> = [
      ['the west glass', [m.rect.x0 + 0.5, MEZZ_Y + EYE_HEIGHT, (m.rect.z0 + m.rect.z1) / 2]],
      ['the south glass', [(m.rect.x0 + m.rect.x1) / 2, MEZZ_Y + EYE_HEIGHT, m.rect.z1 - 0.5]],
      ['your seat', [m.sit.x, MEZZ_Y + EYE_HEIGHT - SIT_DROP, m.sit.z]],
    ];
    for (const worker of [true, false]) {
      const targets = L.slots.map((s) => {
        const b = slotBoxes(s);
        return { boxes: worker ? [b.seat, b.desk] : [b.desk, b.plus], value: s.index };
      });
      for (const [where, eye] of poses) {
        it(`${n} desks, ${worker ? 'workers' : 'empty desks'}, from ${where}`, () => {
          const picks = (s: (typeof L.slots)[number], block: readonly Box3[]) =>
            aims(slotBoxes(s), worker).some((a) => {
              const to = [a.x - eye[0], a.y - eye[1], a.z - eye[2]];
              const len = Math.hypot(...to);
              return pickNearest(eye, to.map((v) => v / len) as [number, number, number], targets, reach, block)?.value === s.index;
            });
          const shown = L.slots.filter((s) => picks(s, blockers));
          // Only the mezzanine's own floor hides a desk (the pod tucked under it): never the distance.
          const hidden = L.slots.filter((s) => !shown.includes(s));
          expect(hidden.filter((s) => !picks(s, L.walls)).map((s) => s.index)).toEqual([]);
          expect(hidden.every((s) => s.seat.x > m.rect.x0 - 4 && s.seat.z < m.rect.z1 + 4)).toBe(true);
          expect(shown.length).toBeGreaterThanOrEqual(L.slots.length - 8);
          // Big floors have desks past the old fixed 20 m, and they are picked.
          const far = Math.max(...shown.map((s) => Math.hypot(s.seat.x - eye[0], 1 - eye[1], s.seat.z - eye[2])));
          if (n >= 62) expect(far).toBeGreaterThan(20);
        });
      }
    }
  }

  it('reaches the far corner of every supported floor', () => {
    for (const n of COUNTS) {
      const L = floorLayout(n);
      expect(overlookReach(L)).toBeGreaterThanOrEqual(Math.hypot(L.width, L.depth));
    }
  });
});

describe('walk-out route (M4) on the tall floors', () => {
  it.each([6, 20, 41, 62, 96])('%i desks, a two-floor building: every desk walks out past the mezzanine posts and stair', (n) => {
    const outline = outlineOf([n, 6]);
    const floors = [floorLayout(6, outline), floorLayout(n, outline)];
    const plan = buildingPlan(outline, 2, floors[0]!.fireDoor);
    const L = floors[1]!;
    const w = walkWorld(plan, loadedFloor(L, 1));
    for (const s of L.slots.filter((_, i) => i % 3 === 0 || i === L.desks - 1)) {
      const route = walkOutRoute(L, plan, 1, s.index);
      expect(route.at(-1)!.y).toBe(0);
      let p: V3p = route[0]!;
      for (const next of route.slice(1)) {
        const end = walk(w, p, next, 0.05);
        expect(Math.hypot(end.x - next.x, end.z - next.z), `desk ${s.index} to ${JSON.stringify(next)}`).toBeLessThan(0.03);
        expect(end.y).toBeCloseTo(next.y, 6);
        p = end;
      }
    }
  });
});
