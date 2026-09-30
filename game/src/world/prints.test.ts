import { describe, expect, it } from 'vitest';
import type { ImageRef } from '../net/protocol';
import { deskKit, DESK_TOP_RECT, inside, overlaps, MONITOR } from './deskKit';
import { layoutPrints, MAX_TRAY, pickPrints, printSize, PRINT_LONG, TRAY_RECT, trayOf } from './prints';
import { SEAT_OFFSET } from './layout';

const ref = (o: Partial<ImageRef> & { n: number }): ImageRef => ({
  source: 'inline',
  origin: 'input',
  hash: `h${o.n}`.padEnd(64, '0'),
  mime: 'image/png',
  width: 640,
  height: 400,
  item_id: `i${o.n}`,
  seq: o.n,
  ts: 1000 + o.n,
  ...o,
});

describe('pickPrints', () => {
  it('splits by origin, keeps the newest five of each, oldest first (the last lies on top)', () => {
    const refs: ImageRef[] = [];
    for (let n = 1; n <= 9; n++) refs.push(ref({ n, origin: n % 2 ? 'input' : 'agent' }));
    const picks = pickPrints(refs);
    expect(picks.length).toBeLessThanOrEqual(2 * MAX_TRAY);
    const ins = picks.filter((p) => p.tray === 'in').map((p) => p.ref.seq);
    const outs = picks.filter((p) => p.tray === 'out').map((p) => p.ref.seq);
    expect(ins).toEqual([1, 3, 5, 7, 9]);
    expect(outs).toEqual([2, 4, 6, 8]);
    // In first, then out.
    expect(picks.map((p) => p.tray)).toEqual(['in', 'in', 'in', 'in', 'in', 'out', 'out', 'out', 'out']);
  });

  it('caps a tray at five however many images there are', () => {
    const refs = Array.from({ length: 40 }, (_, i) => ref({ n: i + 1, origin: 'agent' }));
    const picks = pickPrints(refs);
    expect(picks).toHaveLength(MAX_TRAY);
    expect(picks.map((p) => p.ref.seq)).toEqual([36, 37, 38, 39, 40]);
  });

  it('shows the same image once (the newest sending), the same hash in the other tray separately', () => {
    const a = ref({ n: 1 });
    const b = ref({ n: 2, hash: a.hash as string });
    const c = ref({ n: 3, hash: a.hash as string, origin: 'agent' });
    const picks = pickPrints([a, b, c]);
    expect(picks.map((p) => [p.tray, p.ref.seq])).toEqual([['in', 2], ['out', 3]]);
  });

  it('blank prints: unavailable, binary, no hash — each its own card, never fetched', () => {
    const picks = pickPrints([ref({ n: 1, unavailable: true, hash: '', reason: 'not_allowed', path: '/etc/x.png' }), ref({ n: 2, mime: 'binary' }), ref({ n: 3 })]);
    expect(picks.map((p) => p.blank)).toEqual([true, true, false]);
    expect(new Set(picks.map((p) => p.key)).size).toBe(3);
  });

  it('trayOf: input is IN, everything the agent did is OUT', () => {
    expect(trayOf({ origin: 'input' })).toBe('in');
    expect(trayOf({ origin: 'agent' })).toBe('out');
  });
});

describe('layoutPrints', () => {
  it('is deterministic and keeps a print where it fell when others come', () => {
    const many = Array.from({ length: 6 }, (_, i) => ref({ n: i + 1, origin: i % 2 ? 'agent' : 'input' }));
    const a = layoutPrints('w1', pickPrints(many.slice(0, 4)));
    const b = layoutPrints('w1', pickPrints(many.slice(0, 4)));
    expect(a).toEqual(b);
    const c = layoutPrints('w2', pickPrints(many.slice(0, 4)));
    expect(c).not.toEqual(a);
    // The turn and the offset come from the worker and the image, not from what else is there.
    const p1 = a.find((p) => p.key === many[0]?.hash);
    const p2 = layoutPrints('w1', pickPrints(many)).find((p) => p.key === many[0]?.hash);
    expect(p1?.yaw).toBe(p2?.yaw);
    expect(p1?.z).toBe(p2?.z);
  });

  it('IN is on slot +x (the left of the chair), OUT on -x; newest on top', () => {
    const picks = pickPrints(Array.from({ length: 10 }, (_, i) => ref({ n: i + 1, origin: i < 5 ? 'input' : 'agent' })));
    const places = layoutPrints('w', picks);
    for (const p of places) expect(Math.sign(p.x)).toBe(p.tray === 'in' ? 1 : -1);
    const ys = places.filter((p) => p.tray === 'in').map((p) => p.y);
    expect([...ys].sort((x, y) => x - y)).toEqual(ys);
    expect(new Set(ys).size).toBe(ys.length);
  });

  it('sizes keep the aspect, longest side PRINT_LONG', () => {
    expect(printSize({ width: 1280, height: 720 })).toEqual({ w: PRINT_LONG, h: Math.round(720 * (PRINT_LONG / 1280) * 1e4) / 1e4 });
    const t = printSize({ width: 375, height: 667 });
    expect(t.h).toBe(PRINT_LONG);
    expect(t.w).toBeLessThan(t.h);
    expect(printSize({})).toEqual({ w: PRINT_LONG, h: Math.round(3 * (PRINT_LONG / 4) * 1e4) / 1e4 });
  });

  // Every print of every desk lies on the desktop, in its tray, and clear of the desk's things — the worst case: ten
  // portrait/landscape mixes, every desk index, both ways round.
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])('desk %i: all ten prints stay on the desk and clear of its things', (index) => {
    for (const yaw of [0, Math.PI]) {
      const kit = deskKit({ index, yaw });
      const shapes = [{ width: 1280, height: 720 }, { width: 375, height: 667 }, { width: 500, height: 500 }, { width: 100, height: 1600 }, { width: 1600, height: 100 }];
      for (let seed = 0; seed < 12; seed++) {
        const refs = Array.from({ length: 10 }, (_, i) => ref({ n: seed * 100 + i + 1, origin: i < 5 ? 'input' : 'agent', ...shapes[(i + seed) % shapes.length] }));
        for (const worker of [`w-${seed}`, `worker-${index}-${seed}`]) {
          const places = layoutPrints(worker, pickPrints(refs));
          expect(places).toHaveLength(10);
          const things = [kit.keyboard.foot, kit.mouse.foot, kit.dock.foot, kit.laptop.foot, kit.monitor, kit.crewItem, ...kit.keepClear, ...kit.items.map((i) => i.foot)];
          for (const p of places) {
            expect(inside(p.foot, DESK_TOP_RECT), `${worker} ${p.key} on the desk`).toBe(true);
            const tray = TRAY_RECT[p.tray];
            expect(p.foot.x0).toBeGreaterThanOrEqual(tray.x0 - 0.012);
            expect(p.foot.x1).toBeLessThanOrEqual(tray.x1 + 0.012);
            expect(p.foot.z0).toBeGreaterThanOrEqual(tray.z0 - 0.012);
            expect(p.foot.z1).toBeLessThanOrEqual(tray.z1 + 0.012);
            for (const t of things) expect(overlaps(p.foot, t), `${worker} ${p.key} ${JSON.stringify(p.foot)} overlaps ${JSON.stringify(t)}`).toBe(false);
            expect(p.z).toBeLessThan(SEAT_OFFSET + MONITOR.footD);
          }
        }
      }
    }
  });
});
