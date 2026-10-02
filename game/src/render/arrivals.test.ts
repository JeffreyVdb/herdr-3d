import '../test/fakeCanvas';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { buildingPlan } from '../world/building';
import { DELIVER_SPEED, DROP_S, FALL_S, HAND_FLY, HAND_S, PACK_S, PLUS_BACK_AFTER_M, SIT_S, STAND_S, WALK_SPEED, type Carry } from '../world/arrival';
import { floorY } from '../world/building';
import { deskKit } from '../world/deskKit';
import { floorLayout, outlineOf } from '../world/layout';
import { deskToDeskRoute, handOver, walkOutRoute } from '../world/route';
import { trayFolderAt } from '../world/delivery';
import { Arrivals, type ArrivalSpec, type DeskAway, type DeliverSpec } from './arrivals';
import { PEN_AT } from './desks';

const counts = [12, 8];
const outline = outlineOf(counts);
const floors = counts.map((n) => floorLayout(n, outline));
const plan = buildingPlan(outline, counts.length, floors[0]!.fireDoor);
const DESK = 5;

function spec(id: string, kind: 'in' | 'out', desk = DESK, carry?: Carry): ArrivalSpec {
  const slot = floors[1]!.slots[desk]!;
  const route = kind === 'out' ? walkOutRoute(floors[1]!, plan, 1, desk) : [{ x: slot.seat.x, y: floorY(1), z: slot.seat.z }];
  return { id, kind, session: 'f', desk, name: id, route, seatYaw: slot.yaw, tint: 0x88aaff, cue: { family: 'opus', color: 0xff8844, hat: 'none' }, display: 'working', phase: 0, harness: 'codex', ...(carry ? { carry } : {}) };
}

const part = (a: Arrivals, key: string) => a.group.getObjectByName(`arrivals.${key}`) as THREE.InstancedMesh;
const matrixAt = (m: THREE.InstancedMesh, i: number) => {
  const e = new THREE.Matrix4();
  m.getMatrixAt(i, e);
  return e;
};
/** What the arrivals say desk `DESK` shows (undefined: nothing, as the office has it). */
const onDesk = (out: DeskAway[]) => out.find((d) => d.session === 'f' && d.desk === DESK);

const zero = (m: THREE.InstancedMesh, i: number) => {
  const e = new THREE.Matrix4();
  m.getMatrixAt(i, e);
  return e.elements.every((x, k) => (k === 15 ? x === 1 : x === 0));
};

describe('Arrivals', () => {
  it('a hire dropping in to the desk a worker is still leaving: the desk is the new hire’s at once (not away), only its figure drops', () => {
    const a = new Arrivals(false);
    a.start(spec('pip', 'out'), 0);
    // Packing: the desk is Pip's, busy, with its codex sticker, the first things packed as they go.
    expect(a.update(0.1, 0)).toEqual([{ session: 'f', desk: DESK, away: { show: 'busy', display: 'working', cue: 0xff8844, harness: 'codex', packed: 0 } }]);
    const packing = a.update(1.2, 1.2)[0]!.away!;
    expect(packing.packed).toBeGreaterThan(0);
    expect(packing.packed).toBeLessThanOrEqual(deskKit({ index: DESK, yaw: floors[1]!.slots[DESK]!.yaw }).items.length);
    // Pip is past the point where the desk gets its "+" back: the desk is as the world says...
    const past = PACK_S + STAND_S + (PLUS_BACK_AFTER_M + 1) / WALK_SPEED;
    expect(a.update(past, 0)).toEqual([{ session: 'f', desk: DESK, away: null }]);
    // ...and the world now seats Gumdrop there, who drops in: never away, the figure falling onto the seat.
    a.start(spec('gumdrop', 'in'), past);
    const first = a.update(past, past);
    expect(first).toEqual([{ session: 'f', desk: DESK, away: null, drop: { dy: expect.any(Number), squash: expect.any(Number) } }]);
    expect(first[0]!.drop!.dy).toBeGreaterThan(1);
    const landed = a.update(past + FALL_S + 0.05, past)[0]!;
    expect(landed).toMatchObject({ away: null, drop: { dy: 0 } });
    expect(landed.drop!.squash).toBeLessThan(1);
    // Done in under a second: the desk as the world says, sitting as usual.
    expect(a.update(past + DROP_S + 0.01, past)).toEqual([{ session: 'f', desk: DESK, away: null, drop: null }]);
    expect(a.log.at(-1)).toMatchObject({ id: 'gumdrop', kind: 'in', played: true });
    expect(a.count).toBe(1);
  });

  describe('a hire dropping in to the desk of a worker still packing up there (M6b)', () => {
    const outTotal = (a: Arrivals, id: string, now: number) => a.info(now).find((x) => x.id === id)!.total;

    for (const carry of ['box', 'briefcase'] as const) {
      it(`${carry}: the walk-out gives the desk up for good, before and after the drop is over`, () => {
        const a = new Arrivals(false);
        a.start(spec('pip', 'out', DESK, carry), 10);
        expect(onDesk(a.update(10.05, 0))?.away).toMatchObject({ show: carry === 'box' ? 'busy' : 'empty' });
        // Pip is gone by then at the latest (it only gets quicker).
        const gone = 10 + outTotal(a, 'pip', 10.05) + 0.01;
        // The world seats Gumdrop at Pip's desk while Pip is still at it: Gumdrop drops in.
        a.start(spec('gumdrop', 'in'), 10.1);
        const samples = [10.1, 10.2, 10.5, 10.9, 10.96, 11, 11.5, 12, 14, 20, gone - 1, gone];
        for (const t of samples) {
          const d = onDesk(a.update(t, t));
          // Never away again: during the drop, as it ends, and while Pip is still on its way out.
          expect(d?.away ?? null, `t=${t}`).toBeNull();
          if (t < 10.1 + DROP_S) expect(d?.drop, `t=${t}`).toMatchObject({ dy: expect.any(Number) });
          const pip = a.info(t).find((x) => x.id === 'pip');
          if (pip) {
            // Pip gets up and goes at once: no more packing at (or waving from) Gumdrop's desk, nothing lifted out of its dock.
            expect(pip, `t=${t}`).toMatchObject({ yielded: true, items: 0 });
            expect(['walk', 'vanish'], `t=${t}`).toContain(pip.phase);
            expect(pip.laptop, `t=${t}`).not.toBe('lift');
          }
        }
        expect(a.count).toBe(0);
        expect(a.log.map((l) => [l.id, l.played])).toEqual([
          ['gumdrop', true],
          ['pip', true],
        ]);
      });
    }

    it('the walk-out ends first, during the drop: the drop plays to the end, the desk never away', () => {
      const a = new Arrivals(false);
      a.start(spec('pip', 'out'), 0);
      a.update(1, 1);
      const end = outTotal(a, 'pip', 1);
      // Gumdrop drops in as Pip vanishes down the street.
      const t0 = end - 0.3;
      a.start(spec('gumdrop', 'in'), t0);
      for (const t of [t0, t0 + 0.2, end + 0.01, end + 0.2, t0 + DROP_S - 0.02]) {
        const d = onDesk(a.update(t, t));
        expect(d?.away ?? null, `t=${t}`).toBeNull();
        // Pip's walk ending does not cut Gumdrop's drop short.
        expect(d?.drop, `t=${t}`).toMatchObject({ dy: expect.any(Number), squash: expect.any(Number) });
      }
      expect(a.log.at(-1)).toMatchObject({ id: 'pip', played: true });
      expect(onDesk(a.update(t0 + DROP_S + 0.01, 0))).toEqual({ session: 'f', desk: DESK, away: null, drop: null });
      expect(a.count).toBe(0);
    });

    it('mid-packing: its box keeps what it packed, the laptop on top; nothing more leaves the desk', () => {
      const a = new Arrivals(false);
      a.start(spec('pip', 'out'), 0);
      const t0 = 1.2;
      const packed = onDesk(a.update(t0, t0))!.away!.packed!;
      expect(packed).toBeGreaterThan(0);
      a.start(spec('gumdrop', 'in'), t0);
      const kit = deskKit({ index: DESK, yaw: floors[1]!.slots[DESK]!.yaw });
      const slot = 0;
      for (const t of [t0 + 0.1, t0 + 0.5, t0 + 1, t0 + 3]) {
        expect(onDesk(a.update(t, t))?.away ?? null).toBeNull();
        expect(a.info(t).find((x) => x.id === 'pip')).toMatchObject({ items: packed, box: 'carried', laptop: 'carried' });
        // In the box: the things it had packed; the rest stay on the desk (they are the new hire's now).
        const inBox = kit.items.filter((item, n) => n < packed).length;
        const drawn = kit.items.filter((item) => !zero(part(a, item.kind), item.kind === 'photo' ? slot * 2 + item.n : slot)).length;
        expect(drawn, `t=${t}`).toBe(inBox);
        expect(zero(part(a, 'laptop'), slot)).toBe(false);
      }
    });

    it('someone moved to the desk (no drop-in): the same, from the next update', () => {
      const a = new Arrivals(false);
      a.start(spec('pip', 'out'), 10);
      expect(onDesk(a.update(10.5, 0))?.away).not.toBeNull();
      // A worker on its own desk (or Pip itself) does not count.
      expect(a.yieldDesk('f', DESK + 1, 'mover', 10.6)).toBe(false);
      expect(a.yieldDesk('f', DESK, 'pip', 10.6)).toBe(false);
      expect(a.yieldDesk('f', DESK, 'mover', 10.6)).toBe(true);
      expect(a.yieldDesk('f', DESK, 'mover', 10.6)).toBe(false);
      expect(onDesk(a.update(10.6, 0))).toEqual({ session: 'f', desk: DESK, away: null, drop: null });
      for (const t of [11, 12, 15, 30]) expect(onDesk(a.update(t, 0)), `t=${t}`).toBeUndefined();
    });
  });

  it('a packed notebook takes both its pens along, each where it lies on it', () => {
    // A desk whose notebook has two pens.
    const desk = floors[1]!.slots.findIndex((s) => deskKit(s).items.some((i) => i.kind === 'notebook' && i.pens === 2));
    expect(desk).toBeGreaterThanOrEqual(0);
    const a = new Arrivals(false);
    a.start(spec('pip', 'out', desk), 0);
    // Everything packed, carried out.
    const t = PACK_S + STAND_S + 1;
    a.update(t, t);
    expect(a.info(t)[0]).toMatchObject({ phase: 'walk', box: 'carried' });
    const nb = matrixAt(part(a, 'notebook'), 0);
    expect(zero(part(a, 'notebook'), 0)).toBe(false);
    for (let k = 0; k < 2; k++) {
      const want = nb.clone().multiply(PEN_AT[k]!);
      const got = matrixAt(part(a, 'pens'), k);
      got.elements.forEach((x, i) => expect(x, `pen ${k} [${i}]`).toBeCloseTo(want.elements[i]!, 4));
    }
  });

  it('draws the props as one InstancedMesh per part, one instance per walker, hidden when nobody walks', () => {
    const a = new Arrivals(false);
    const meshes: THREE.Object3D[] = [];
    a.group.traverse((o) => o instanceof THREE.Mesh && meshes.push(o));
    expect(meshes.length).toBeGreaterThan(10);
    expect(meshes.every((m) => m instanceof THREE.InstancedMesh)).toBe(true);
    expect(a.group.visible).toBe(false);
    const props = meshes.filter((m) => m.name.startsWith('arrivals.')) as THREE.InstancedMesh[];
    expect(props.map((m) => m.name).sort()).toEqual(['body', 'flaps', 'fold', 'foldEdge', 'laptop', 'mug', 'notebook', 'pens', 'photo', 'plant', 'puff', 'shadow', 'sticker', 'tape'].map((k) => `arrivals.${k}`).sort());
    for (let i = 0; i < 8; i++) a.start(spec(`w${i}`, 'out'), 0);
    // A ninth walker at once is skipped (the desk resolves at once), with no new objects.
    expect(a.start(spec('w8', 'out'), 0)).toBe(false);
    a.update(1, 1);
    expect(a.group.visible).toBe(true);
    let after = 0;
    a.group.traverse((o) => o instanceof THREE.Mesh && after++);
    expect(after).toBe(meshes.length);
    const body = props.find((m) => m.name === 'arrivals.body')!;
    expect(body.count).toBe(8);
    for (let i = 0; i < 8; i++) expect(zero(body, i)).toBe(false);
    a.clear();
    for (let i = 0; i < 8; i++) expect(zero(body, i)).toBe(true);
    expect(a.group.visible).toBe(false);
  });
});

describe('Arrivals: a report on its way (M6c)', () => {
  const L = floors[1]!;
  const FROM = 5;
  const TO = 2;
  function delivery(swivels: boolean, id = 'deliver:w@1'): ArrivalSpec {
    const slot = L.slots[FROM]!;
    const ho = handOver(L, { slot: TO })!;
    const route = deskToDeskRoute(L, 1, FROM, { slot: TO });
    const deliver: DeliverSpec = {
      key: 'w@1',
      handYaw: ho.yaw,
      swivels,
      orchDesk: TO,
      turn: ho.swivel,
      hand: { x: ho.seat.x, y: floorY(1) + 0.95, z: ho.seat.z },
      tray: trayFolderAt({ x: ho.seat.x, y: floorY(1), z: ho.seat.z, yaw: ho.seatYaw, side: ho.side }, 0),
      edge: 0xe03a33,
    };
    return { id, kind: 'deliver', session: 'f', desk: FROM, name: 'w', route, seatYaw: slot.yaw, tint: 0x88aaff, cue: { family: 'opus', color: 0xff8844, hat: 'none' }, display: 'done', phase: 0, deliver };
  }
  const total = (a: Arrivals) => a.info(0)[0]!.total;

  it('the freelancer stands up, walks, hands over, walks back and sits: the desk is its own the whole way (out of the chair only)', () => {
    const a = new Arrivals(false);
    expect(a.start(delivery(true), 0)).toBe(true);
    const seen = new Set<string>();
    const T = total(a);
    for (let t = 0; t < T; t += 0.1) {
      const out = a.update(t, t);
      const i = a.info(t)[0]!;
      seen.add(i.phase);
      // Never `away`: the laptop screen stays live, the card stays, the desk is as the world says; only the chair moves.
      expect(onDesk(out), `t=${t}`).toMatchObject({ away: null, out: { chair: expect.any(Number) } });
    }
    expect([...seen]).toEqual(['stand', 'walk', 'hand', 'sit']);
    // Walking 2-3 s each way on a normal pod, about a second to hand over.
    const info = a.info(0)[0]!;
    expect(info.kind).toBe('deliver');
    expect(HAND_S).toBeGreaterThanOrEqual(1);
    expect(info.length / 2 / DELIVER_SPEED).toBeGreaterThan(1.5);
    expect(info.length / 2 / DELIVER_SPEED).toBeLessThan(8);
    expect(T).toBeCloseTo(STAND_S + info.length / DELIVER_SPEED + HAND_S + SIT_S, 6);
    // Done: back in the chair, empty-handed; the desk hears it.
    const end = a.update(T + 0.01, T);
    expect(onDesk(end)).toMatchObject({ away: null, out: null });
    expect(a.count).toBe(0);
    expect(a.log.at(-1)).toMatchObject({ id: 'deliver:w@1', kind: 'deliver', played: true });
  });

  it('the folder lands on the tray in the middle of the hand-over (reported once), the orchestrator swivels there and back', () => {
    const a = new Arrivals(false);
    a.start(delivery(true), 0);
    const walkTo = STAND_S + a.info(0)[0]!.length / 2 / DELIVER_SPEED;
    expect(a.takeLanded()).toEqual([]);
    a.update(walkTo + 0.02, 0);
    // The chair has only started to turn.
    expect(a.swivels[0]?.swivel?.turn ?? 0).toBeLessThan(0.1);
    expect(a.info(walkTo + 0.02)[0]).toMatchObject({ phase: 'hand', folder: 'out', landed: false });
    // Swivelled round and reaching, the folder in the air...
    const mid = walkTo + HAND_S * ((HAND_FLY.from + HAND_FLY.to) / 2);
    a.update(mid, mid);
    expect(a.info(mid)[0]).toMatchObject({ folder: 'flight', swivel: 1 });
    expect(a.swivels).toHaveLength(1);
    expect(a.swivels[0]).toMatchObject({ session: 'f', desk: TO, swivel: { turn: expect.any(Number), reach: expect.any(Number) } });
    expect(Math.abs(a.swivels[0]!.swivel!.turn)).toBeCloseTo(Math.PI / 2, 2);
    expect(a.takeLanded()).toEqual([]);
    // ...landed a little later: once...
    const later = walkTo + HAND_S * (HAND_FLY.to + 0.02);
    a.update(later, later);
    expect(a.takeLanded()).toEqual(['w@1']);
    a.update(later + 0.01, later);
    expect(a.takeLanded()).toEqual([]);
    // ...and the chair swings back to the desk by the end of the hand-over.
    const done = walkTo + HAND_S + 0.01;
    a.update(done, done);
    expect(a.swivels).toEqual([{ session: 'f', desk: TO, swivel: null }]);
    a.update(done + 0.01, done);
    expect(a.swivels).toEqual([]);
  });

  it('an orchestrator that does not turn (waiting for you, asleep): no swivel, the freelancer puts the folder on the tray itself', () => {
    const a = new Arrivals(false);
    a.start(delivery(false), 0);
    const walkTo = STAND_S + a.info(0)[0]!.length / 2 / DELIVER_SPEED;
    let landedAt = -1;
    for (let t = walkTo; t < walkTo + HAND_S; t += 0.02) {
      a.update(t, t);
      expect(a.swivels, `t=${t}`).toEqual([]);
      if (landedAt < 0 && a.takeLanded().length) landedAt = t - walkTo;
    }
    expect(landedAt).toBeGreaterThan(0);
    expect(landedAt).toBeLessThan(HAND_S);
  });

  it('a delivery with a walk-out to follow: when the hand-over is done it ends and the walk-out takes over, from where it stands', () => {
    const a = new Arrivals(false);
    a.start(delivery(true), 0);
    const walkTo = STAND_S + a.info(0)[0]!.length / 2 / DELIVER_SPEED;
    const spot = handOver(L, { slot: TO })!;
    const out = spec('w', 'out', FROM, 'briefcase');
    out.route = [{ x: spot.x, y: floorY(1), z: spot.z }, ...out.route.slice(3)];
    out.standing = true;
    expect(a.chain('deliver:w@1', out)).toBe(true);
    a.update(walkTo + 0.3, 0);
    expect(a.has('deliver:w@1')).toBe(true);
    a.update(walkTo + HAND_S + 0.01, 0);
    expect(a.has('deliver:w@1')).toBe(false);
    expect(a.has('w')).toBe(true);
    const i = a.info(walkTo + HAND_S + 0.011)[0]!;
    expect(i).toMatchObject({ kind: 'out', phase: 'walk', desk_show: 'free' });
    // Standing: no packing, no standing up, no wave; it starts at the spot.
    expect(Math.hypot(i.x - spot.x, i.z - spot.z)).toBeLessThan(0.3);
    expect(a.takeLanded()).toEqual(['w@1']);
    expect(a.takeEnded()).toEqual(['deliver:w@1']);
  });

  it('cancelled halfway: the desk comes back at once and its swivel ends', () => {
    const a = new Arrivals(false);
    a.start(delivery(true), 0);
    const walkTo = STAND_S + a.info(0)[0]!.length / 2 / DELIVER_SPEED;
    const t = walkTo + HAND_S * 0.5;
    a.update(t, t);
    expect(a.swivels).toHaveLength(1);
    a.cancel('deliver:w@1');
    const out = a.update(t + 0.01, t);
    expect(onDesk(out)).toMatchObject({ away: null, out: null });
    expect(a.swivels).toEqual([{ session: 'f', desk: TO, swivel: null }]);
  });

  it('queued reports: two walkers at once never share a slot', () => {
    const a = new Arrivals(false);
    a.start(delivery(true, 'deliver:a@1'), 0);
    a.start({ ...delivery(true, 'deliver:b@1'), desk: 6, name: 'b' }, 0);
    expect(a.count).toBe(2);
    expect(new Set(a.info(0).map((i) => i.id)).size).toBe(2);
  });
});
