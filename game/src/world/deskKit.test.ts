import { describe, expect, it } from 'vitest';
import { CABLE_R, deskKit, DESK_TOP_RECT, dockSide, footOf, inside, KEYBOARD, monitorFrame, MONITOR, overlaps, PACK_BOX, type DeskKit } from './deskKit';
import { DESK_H, floorLayout, SEAT_OFFSET, type Rect } from './layout';

const COUNTS = [1, 4, 6, 7, 12, 20, 33, 60, 96];
const all = COUNTS.flatMap((n) => floorLayout(n).slots.map((s) => ({ n, slot: s, kit: deskKit(s) })));

/** A cable's run over the desk: the points lying on it (the rest rises behind the monitor or out of the dock). */
const onDesk = (k: DeskKit) => k.cables.flatMap((c) => c.filter((p) => p.y <= DESK_H + CABLE_R + 0.004));
const cableFoot = (p: { x: number; z: number }): Rect => ({ x0: p.x - CABLE_R, z0: p.z - CABLE_R, x1: p.x + CABLE_R, z1: p.z + CABLE_R });

describe('desk kit layout (M6b)', () => {
  it('keeps the furniture, the dock, the cables and every item on the desktop, across desk counts', () => {
    for (const { n, slot, kit } of all) {
      const where = `${n} desks, desk ${slot.index}`;
      for (const r of [kit.monitor, kit.keyboard.foot, kit.mouse.foot, kit.dock.foot, kit.laptop.foot, ...kit.items.map((i) => i.foot), ...kit.keepClear, kit.crewItem]) {
        expect(inside(r, DESK_TOP_RECT), `${where}: ${JSON.stringify(r)}`).toBe(true);
      }
      for (const c of kit.cables) {
        for (const p of c) expect(inside(cableFoot(p), DESK_TOP_RECT), `${where}: cable at ${JSON.stringify(p)}`).toBe(true);
        // Starts at the dock, ends inside the back of the monitor, never below the desk top.
        expect(overlaps(cableFoot(c[0]!), kit.laptop.foot), where).toBe(true);
        expect(c.at(-1)!.z).toBeGreaterThan(MONITOR.z);
        expect(Math.abs(c.at(-1)!.x)).toBeLessThan(0.2);
        for (const p of c) expect(p.y).toBeGreaterThanOrEqual(DESK_H + CABLE_R);
      }
    }
  });

  it('keeps the dock, the cables and the items clear of the monitor, keyboard and mouse, and of each other', () => {
    for (const { n, slot, kit } of all) {
      const where = `${n} desks, desk ${slot.index}`;
      const fixed: Array<[string, Rect]> = [
        ['monitor', kit.monitor],
        ['keyboard', kit.keyboard.foot],
        ['mouse', kit.mouse.foot],
      ];
      for (const [a, r] of fixed) for (const [b, q] of fixed) if (a < b) expect(overlaps(r, q), `${where}: ${a} / ${b}`).toBe(false);
      const things: Array<[string, Rect]> = [['laptop', kit.laptop.foot], ...kit.items.map((i): [string, Rect] => [`${i.kind}${i.n}`, i.foot])];
      for (const [a, r] of things) {
        for (const [b, q] of fixed) expect(overlaps(r, q), `${where}: ${a} / ${b}`).toBe(false);
        for (const z of kit.keepClear) expect(overlaps(r, z), `${where}: ${a} / the pass board`).toBe(false);
      }
      for (let i = 0; i < things.length; i++) {
        for (let j = i + 1; j < things.length; j++) expect(overlaps(things[i]![1], things[j]![1]), `${where}: ${things[i]![0]} / ${things[j]![0]}`).toBe(false);
      }
      // The cables run along the back edge: behind the keyboard, the mouse and every item, outside the monitor's foot.
      for (const p of onDesk(kit)) {
        const f = cableFoot(p);
        for (const [b, q] of [...fixed, ...things.filter(([a]) => a !== 'laptop')]) expect(overlaps(f, q), `${where}: cable / ${b} at ${JSON.stringify(p)}`).toBe(false);
        if (!overlaps(f, kit.laptop.foot)) expect(p.z, `${where}: cable across the desk`).toBeGreaterThan(SEAT_OFFSET + 0.3);
      }
      // A freelancer's item (instead of the notebook) is clear of the furniture and the dock.
      for (const [b, q] of [...fixed, ['laptop', kit.laptop.foot] as [string, Rect]]) expect(overlaps(kit.crewItem, q), `${where}: crew item / ${b}`).toBe(false);
      // The walk-out's box sits on the keyboard, clear of the monitor and the dock.
      const box = footOf(PACK_BOX.x, PACK_BOX.z, 0.44, 0.32, 0);
      expect(inside(box, DESK_TOP_RECT)).toBe(true);
      for (const q of [kit.monitor, kit.laptop.foot]) expect(overlaps(box, q), where).toBe(false);
      expect(overlaps(box, kit.keyboard.foot)).toBe(true);
    }
  });

  it('puts the dock on the pod’s outer side, so the laptops face the aisles', () => {
    for (const n of [8, 40]) {
      const L = floorLayout(n);
      for (const s of L.slots) {
        const side = dockSide(s);
        // The dock's world x, against the pod's centre.
        const worldX = s.seat.x + Math.cos(s.yaw) * deskKit(s).dock.x;
        const pod = L.slots.filter((o) => o.pod === s.pod);
        const cx = pod.reduce((a, o) => a + o.desk.x, 0) / pod.length;
        expect(Math.sign(worldX - cx), `desk ${s.index}`).toBe(Math.sign(s.desk.x - cx));
        expect(Math.abs(side)).toBe(1);
      }
    }
  });

  it('varies the worker’s things from the desk index, the same for the same desk', () => {
    const L = floorLayout(24);
    const kits = L.slots.map((s) => deskKit(s));
    expect(deskKit(L.slots[5]!)).toEqual(kits[5]);
    const sig = (k: DeskKit) => k.items.map((i) => `${i.kind}${i.n}:${i.tint}:${i.yaw}`).join('|');
    expect(new Set(kits.map(sig)).size).toBeGreaterThan(12);
    // Every desk has a photo, a mug and a notebook with a pen or two; some a second photo, most a plant.
    for (const k of kits) {
      expect(k.items.filter((i) => i.kind === 'photo').length).toBeGreaterThanOrEqual(1);
      expect(k.items.filter((i) => i.kind === 'mug')).toHaveLength(1);
      const nb = k.items.find((i) => i.kind === 'notebook');
      expect(nb?.pens === 1 || nb?.pens === 2).toBe(true);
    }
    expect(kits.some((k) => k.items.filter((i) => i.kind === 'photo').length === 2)).toBe(true);
    expect(kits.some((k) => !k.items.some((i) => i.kind === 'plant'))).toBe(true);
    expect(kits.filter((k) => k.items.some((i) => i.kind === 'plant')).length).toBeGreaterThan(kits.length / 2);
    expect(new Set(kits.map((k) => k.items.find((i) => i.kind === 'photo')?.tint)).size).toBeGreaterThan(3);
  });

  it('frames the monitor’s terminal under its status bar, facing the chair', () => {
    const f = monitorFrame();
    expect(f.width).toBeCloseTo(MONITOR.glassW, 6);
    expect(f.height + f.band.height).toBeCloseTo(MONITOR.glassH, 6);
    // Much bigger than the M5 lid (0.31 × 0.2).
    expect(f.width * f.height).toBeGreaterThan(3 * 0.31 * 0.2);
    expect(f.normal.z).toBeLessThan(-0.9);
    expect(f.band.center.y).toBeGreaterThan(f.center.y);
    // Above the keyboard, below the worker's hat line (~1.3 m) so the model cue shows over it.
    expect(f.center.y - f.height / 2).toBeGreaterThan(DESK_H + 0.08);
    expect(f.band.center.y + f.band.height / 2 + MONITOR.bezel).toBeLessThan(1.2);
    expect(KEYBOARD.z).toBeLessThan(f.center.z);
  });
});
