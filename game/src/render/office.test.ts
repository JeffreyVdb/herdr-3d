import '../test/fakeCanvas';
import * as THREE from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import type { Floor, Worker } from '../net/protocol';
import { DROP_S, FALL_S, PACK_S, TAKE_LAPTOP_AT } from '../world/arrival';
import { buildingPlan, floorY } from '../world/building';
import type { V3 } from '../world/collide';
import { deskKit } from '../world/deskKit';
import { floorLayout } from '../world/layout';
import { WorldStore } from '../world/store';
import { Arrivals, type ArrivalSpec, type DeskAway } from './arrivals';
import { DeskSet } from './desks';
import { lookOf, NOON } from './daylook';
import { STICKER_MARK, type StickerLogo } from './deskArt';
import { memberOf, OfficeView } from './office';
import { OutsideView } from './outside';

const floor: Floor = { session: 'top', state: 'running', building: 'b1', index: 0, desks: 8 };
const worker = (id: string, over: Partial<Worker>): Worker => ({ id, session: 'top', workspace_id: `ws-${id}`, label: `label-${id}`, status: 'idle', ...over });

function world(): WorldStore {
  const s = new WorldStore(1000);
  s.applySnapshot({
    t: 'world.snapshot',
    seq: 1,
    world: {
      buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['top'] }],
      unassigned: [],
      floors: [floor],
      workers: [worker('old', { name: 'Pip', desk_index: 0, harness: 'claude', model: 'claude-opus-5-5', status: 'working' })],
    },
  });
  return s;
}

describe('fire-escape doorway surfaces', () => {
  it.each(['continuous floor', 'no overlapping floor faces'] as const)('%s across the landing and threshold', (check) => {
    const office = new OfficeView(world().floorView('top')!, { shadows: false });
    const plan = buildingPlan(office.layout, 3, office.layout.fireDoor);
    const outside = new OutsideView(plan, office.layout.openings, {
      name: 'Work', tint: 0x6699bb,
      floors: [0, 1, 2].map((s) => ({ id: `floor-${s}`, name: `Floor ${s}`, asleep: false })),
    });
    try {
      office.setDoor(1);
      const d = office.layout.fireDoor;
      const failures: string[] = [];
      for (const storey of [0, 2]) {
        outside.setLoaded(storey);
        outside.group.position.y = -floorY(storey);
        office.root.updateMatrixWorld(true);
        outside.group.updateMatrixWorld(true);
        // Downward looks across the whole opening, including where the facade meets the landing.
        // Off-grid samples avoid triangle seams, which can legitimately return two identical hits.
        for (const x of [-0.4, -0.31, -0.28, -0.24, -0.19, -0.1, -0.01, 0.01, 0.2]) {
          for (const z of [d.z0 + 0.153, (d.z0 + d.z1) / 2, d.z1 - 0.173]) {
            const hits = new THREE.Raycaster(new THREE.Vector3(x, 0.5, z), new THREE.Vector3(0, -1, 0), 0, 1)
              .intersectObjects([office.root, outside.group], true);
            const at = `storey=${storey}, x=${x.toFixed(3)}, z=${z.toFixed(3)}`;
            if (check === 'continuous floor') {
              if (!hits.length || Math.abs(hits[0]!.point.y) > 0.03) failures.push(at);
            } else if (hits.length) {
              const nearest = hits.filter((hit) => Math.abs(hit.distance - hits[0]!.distance) < 1e-5);
              if (nearest.length > 1) failures.push(`${at}: ${nearest.map((hit) => hit.object.name).join(', ')}`);
            }
          }
        }
      }
      expect(failures.length, failures.slice(0, 5).join('\n')).toBe(0);
    } finally {
      office.dispose();
      outside.dispose();
    }
  });

  it.each(['north jamb', 'south jamb', 'lintel'] as const)('%s has no competing wall and trim faces', (edge) => {
    const office = new OfficeView(world().floorView('top')!, { shadows: false });
    try {
      office.setDoor(1);
      office.root.updateMatrixWorld(true);
      const d = office.layout.fireDoor;
      // Look along the reveal from inside the opening, where walking through exposes the frame's edges.
      for (const x of [-0.04, -0.02, -0.001, 0.001, 0.02, 0.04]) {
        const origin = edge === 'lintel'
          ? new THREE.Vector3(x, d.height - 0.1, (d.z0 + d.z1) / 2)
          : new THREE.Vector3(x, 1, edge === 'north jamb' ? d.z0 + 0.1 : d.z1 - 0.1);
        const direction = edge === 'lintel' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, edge === 'north jamb' ? -1 : 1);
        const hits = new THREE.Raycaster(origin, direction, 0, 0.2).intersectObject(office.root, true);
        expect(hits.length).toBeGreaterThan(0);
        // A triangle seam can yield two hits on one mesh; separate meshes at the same depth fight for pixels.
        const nearest = hits.filter((hit) => Math.abs(hit.distance - hits[0]!.distance) < 1e-5);
        expect(new Set(nearest.map((hit) => hit.object)).size, `${edge}, x=${x}`).toBe(1);
      }
    } finally {
      office.dispose();
    }
  });
});

/** A look-at ray from `back` metres behind a desk's chair, at eye height, towards the seated worker. */
function lookAtSeat(o: OfficeView, desk: number, back = 1.5): { origin: V3; dir: V3 } {
  const s = o.layout.slots[desk]!;
  const fx = Math.sin(s.yaw);
  const fz = Math.cos(s.yaw);
  const origin: V3 = [s.seat.x - fx * back, 1.55, s.seat.z - fz * back];
  const to: V3 = [s.seat.x, 0.95, s.seat.z];
  const d = [to[0] - origin[0], to[1] - origin[1], to[2] - origin[2]];
  const n = Math.hypot(...d);
  return { origin, dir: [d[0]! / n, d[1]! / n, d[2]! / n] };
}

describe('OfficeView while a hire drops in (M6b)', () => {
  it('picks the new worker and shows its card from the first frame, never away', () => {
    const store = world();
    const office = new OfficeView(store.floorView('top')!, { shadows: false });
    // The hire's first upsert: the world seats it at desk 3 at once.
    store.applyEvent({ t: 'worker.upsert', seq: 2, worker: worker('new', { name: 'Gumdrop', desk_index: 3, harness: 'codex', model: 'gpt-6-sol', hired_at: 999 }) });
    office.apply(store.floorView('top')!);
    const v = store.workerView('new')!;
    const s = office.layout.slots[3]!;
    const m = memberOf(v);
    const spec: ArrivalSpec = { id: 'new', kind: 'in', floor: 'top', desk: 3, name: v.name, route: [{ x: s.seat.x, y: 0, z: s.seat.z }], seatYaw: s.yaw, tint: m.tint, cue: m.cue, display: m.display, phase: m.phase, harness: 'codex' };
    const arrivals = new Arrivals(false);
    expect(arrivals.start(spec, 0)).toBe(true);
    // As the app's frame loop does: what the arrivals say each desk shows.
    const step = (t: number) => {
      for (const d of arrivals.update(t, t)) {
        office.setAway(d.desk, d.away);
        if (d.drop !== undefined) office.setDrop(d.desk, d.drop);
      }
    };
    for (const t of [0, 0.05, FALL_S * 0.5, FALL_S + 0.02, FALL_S + 0.2, DROP_S - 0.05]) {
      step(t);
      expect(arrivals.info(t)[0]?.phase, `t=${t}`).toBe('drop');
      expect(office.awayDesks().has(3), `t=${t}`).toBe(false);
      expect(office.dropping()).toEqual([3]);
      const ray = lookAtSeat(office, 3);
      expect(office.pick(ray.origin, ray.dir), `t=${t}`).toMatchObject({ kind: 'worker', id: 'new', name: 'Gumdrop', desk: 3 });
      expect(office.cards.card(3), `t=${t}`).toMatchObject({ name: 'Gumdrop' });
      // Its desk is set up already: the laptop in the dock with the Codex sticker, the monitor's status bar.
      expect(office.deskInfo(3)?.sticker?.logo).toBe('codex');
      expect(office.deskInfo(3)?.parts).toMatchObject({ laptop: 1, band: 1, monitor: 1 });
    }
    step(DROP_S + 0.01);
    expect(arrivals.count).toBe(0);
    expect(office.dropping()).toEqual([]);
    expect(arrivals.log.at(-1)).toMatchObject({ id: 'new', kind: 'in', played: true });
    office.dispose();
    arrivals.dispose();
  });
});

/** Pip (desk 0) sent home: its walk-out, as the app starts one (the desk busy at once, then the world forgets Pip). */
function sendHome(store: WorldStore, office: OfficeView, arrivals: Arrivals, now: number): void {
  const v = store.workerView('old')!;
  const s = office.layout.slots[0]!;
  const m = memberOf(v);
  const route = [
    { x: s.seat.x, y: 0, z: s.seat.z },
    { x: s.seat.x + 6, y: 0, z: s.seat.z },
  ];
  const spec: ArrivalSpec = { id: 'old', kind: 'out', floor: 'top', desk: 0, name: v.name, route, seatYaw: s.yaw, tint: m.tint, cue: m.cue, display: m.display, phase: m.phase, harness: 'claude' };
  expect(arrivals.start(spec, now)).toBe(true);
  office.setAway(0, { show: 'busy', display: spec.display, cue: spec.cue.color, harness: spec.harness, packed: 0 });
  store.applyEvent({ t: 'worker.removed', seq: 10, id: 'old', session: 'top', workspace_id: 'ws-old', reason: 'sent_home' });
  office.apply(store.floorView('top')!);
}

/** As the app's frame loop does: what the arrivals say each desk shows (returned too). */
function stepper(office: OfficeView, arrivals: Arrivals): (t: number) => DeskAway[] {
  return (t) => {
    const out = arrivals.update(t, t);
    for (const d of out) {
      office.setAway(d.desk, d.away);
      if (d.drop !== undefined) office.setDrop(d.desk, d.drop);
    }
    return out;
  };
}

/** The worker's own things on a desk (the office draws them). */
const things = (o: OfficeView, desk: number) => {
  const p = o.deskInfo(desk)!.parts;
  return (p.photo ?? 0) + (p.mug ?? 0) + (p.plant ?? 0) + (p.notebook ?? 0);
};

describe('OfficeView while a worker packs up (M6b)', () => {
  it('each thing leaves the desk as its packing starts, one by one, then the laptop', () => {
    const store = world();
    const office = new OfficeView(store.floorView('top')!, { shadows: false });
    const arrivals = new Arrivals(false);
    const kit = office.kits[0]!;
    // Working: every one of Pip's things is on the desk, its mug too.
    expect(things(office, 0)).toBe(kit.items.length);
    sendHome(store, office, arrivals, 0);
    const step = stepper(office, arrivals);
    const seen: number[] = [];
    for (let t = 0; t < TAKE_LAPTOP_AT; t += 0.02) {
      const packed = step(t).find((d) => d.desk === 0)!.away!.packed!;
      if (seen.at(-1) !== packed) seen.push(packed);
      expect(things(office, 0), `t=${t.toFixed(2)}`).toBe(kit.items.length - packed);
      expect(office.deskInfo(0)!.parts.laptop, `t=${t.toFixed(2)}`).toBe(1);
    }
    // Every count on the way, from all on the desk to all in the box.
    expect(seen).toEqual(kit.items.map((_, n) => n).concat(kit.items.length));
    step(PACK_S - 0.1);
    expect(things(office, 0)).toBe(0);
    expect(office.deskInfo(0)!.parts.laptop).toBeUndefined();
    office.dispose();
    arrivals.dispose();
  });
});

describe('OfficeView: a new worker at the desk of one still packing up (M6b)', () => {
  const samples = [10.1, 10.2, 10.5, 10.9, 10.96, 11, 11.5, 12, 13, 14, 16, 20];

  function expectNewWorker(office: OfficeView, t: number, name: string): void {
    const at = `t=${t}`;
    expect(office.awayDesks().has(0), at).toBe(false);
    const ray = lookAtSeat(office, 0);
    expect(office.pick(ray.origin, ray.dir), at).toMatchObject({ kind: 'worker', id: 'new', name, desk: 0 });
    expect(office.cards.card(0), at).toMatchObject({ name });
    // Its own laptop in the dock, all its things on the desk: the old worker's walk-out does not touch them.
    expect(office.deskInfo(0)!.parts.laptop, at).toBe(1);
    expect(things(office, 0), at).toBe(office.kits[0]!.items.length);
  }

  for (const late of [false, true]) {
    it(`a hire drops in ${late ? 'as the laptop comes out of its dock' : 'right after'}: picked, carded and set up at every frame, during and after the drop`, () => {
      const store = world();
      const office = new OfficeView(store.floorView('top')!, { shadows: false });
      const arrivals = new Arrivals(false);
      const t0 = late ? TAKE_LAPTOP_AT - 0.1 : 0;
      sendHome(store, office, arrivals, 10 - t0);
      const step = stepper(office, arrivals);
      step(10.05);
      expect(office.awayDesks().get(0)).toBe('busy');
      // The bridge freed the desk as Pip went: the world seats Gumdrop there, who drops in.
      store.applyEvent({ t: 'worker.upsert', seq: 11, worker: worker('new', { name: 'Gumdrop', desk_index: 0, harness: 'codex', model: 'gpt-6-sol', status: 'working', hired_at: 999 }) });
      office.apply(store.floorView('top')!);
      const s = office.layout.slots[0]!;
      const v = store.workerView('new')!;
      const m = memberOf(v);
      const spec: ArrivalSpec = { id: 'new', kind: 'in', floor: 'top', desk: 0, name: v.name, route: [{ x: s.seat.x, y: 0, z: s.seat.z }], seatYaw: s.yaw, tint: m.tint, cue: m.cue, display: m.display, phase: m.phase, harness: 'codex' };
      expect(arrivals.start(spec, 10.1)).toBe(true);
      for (const t of samples) {
        step(t);
        expectNewWorker(office, t, 'Gumdrop');
        expect(office.dropping(), `t=${t}`).toEqual(t < 10.1 + DROP_S ? [0] : []);
      }
      // Pip is long gone: nothing changes.
      expect(arrivals.info(20).find((a) => a.id === 'old')).toBeUndefined();
      step(60);
      expectNewWorker(office, 60, 'Gumdrop');
      expect(arrivals.count).toBe(0);
      office.dispose();
      arrivals.dispose();
    });
  }

  it('a freelancer re-seated at the desk (no drop-in): the desk is its own at once', () => {
    const store = world();
    store.applyEvent({ t: 'worker.upsert', seq: 2, worker: worker('new', { name: 'Nib', desk_index: 5, status: 'working' }) });
    const office = new OfficeView(store.floorView('top')!, { shadows: false });
    const arrivals = new Arrivals(false);
    sendHome(store, office, arrivals, 10);
    const step = stepper(office, arrivals);
    step(10.05);
    // The world moves Nib to Pip's desk: as the app does, the walk gives the desk up and the office shows it as the world says.
    store.applyEvent({ t: 'worker.upsert', seq: 11, worker: worker('new', { name: 'Nib', desk_index: 0, status: 'working' }) });
    office.apply(store.floorView('top')!);
    expect(arrivals.yieldDesk('top', 0, 'new', 10.1)).toBe(true);
    office.setAway(0, null);
    expectNewWorker(office, 10.1, 'Nib');
    for (const t of samples) {
      step(t);
      expectNewWorker(office, t, 'Nib');
    }
    office.dispose();
    arrivals.dispose();
  });
});

describe('desk kits on the office floor (M6b)', () => {
  it('a taken desk: the laptop with its harness’s sticker, the worker’s things; an empty one: only the furniture', () => {
    const store = world();
    store.applyEvent({ t: 'worker.upsert', seq: 2, worker: worker('cx', { name: 'Hopper', desk_index: 2, harness: 'codex', model: 'gpt-6-luna' }) });
    store.applyEvent({ t: 'worker.upsert', seq: 3, worker: worker('sh', { name: 'Shell', desk_index: 4 }) });
    const office = new OfficeView(store.floorView('top')!, { shadows: false });
    const claude = office.deskInfo(0)!;
    expect(claude.sticker).toMatchObject({ logo: 'claude' });
    // The rim is the model family's colour (opus), as the hat.
    expect(claude.sticker?.rim).toBe(memberOf(store.workerView('old')!).cue.color);
    expect(office.deskInfo(2)?.sticker?.logo).toBe('codex');
    expect(office.deskInfo(4)?.sticker?.logo).toBe('plain');
    // #229: the cells' marks: Claude's, OpenAI's for Codex, none.
    expect([0, 2, 4].map((i) => STICKER_MARK[office.deskInfo(i)!.sticker!.logo as StickerLogo])).toEqual(['claude', 'openai', null]);
    const kit = office.kits[0]!;
    const photos = kit.items.filter((i) => i.kind === 'photo').length;
    // Working: its mug is on the desk (idle, it is in its hand).
    expect(claude.parts).toMatchObject({ monitor: 1, screen: 1, band: 1, laptop: 1, sticker: 1, led: 2, photo: photos, mug: 1, notebook: 1 });
    expect(claude.parts[kit.side === 1 ? 'kitR' : 'kitL']).toBe(1);
    expect(claude.parts[kit.side === 1 ? 'kitL' : 'kitR']).toBeUndefined();
    const idle = office.deskInfo(2)!;
    expect(idle.parts.mug).toBeUndefined();
    const empty = office.deskInfo(5)!;
    expect(Object.keys(empty.parts).sort()).toEqual(['chair', 'chairBase', 'led', 'legs', 'monitor', 'screen', 'top', empty.side === 1 ? 'kitR' : 'kitL'].sort());
    expect(empty.sticker).toBeNull();
    // Packing at desk 0: what is packed is off the desk; once the laptop is taken, only the furniture is left.
    office.setAway(0, { show: 'busy', display: 'working', cue: 0xff7a3d, harness: 'claude', packed: 2 });
    const packing = office.deskInfo(0)!.parts;
    const left = kit.items.slice(2);
    expect((packing.photo ?? 0) + (packing.mug ?? 0) + (packing.plant ?? 0) + (packing.notebook ?? 0)).toBe(left.length);
    expect(packing.laptop).toBe(1);
    office.setAway(0, { show: 'empty', display: 'working', cue: 0xff7a3d });
    expect(office.deskInfo(0)!.parts.laptop).toBeUndefined();
    expect(office.deskInfo(0)!.parts.photo).toBeUndefined();
    office.dispose();
  });
});

describe('desk art frame budget (M6b)', () => {
  const meshesOf = (d: DeskSet) => d.group.children.filter((o): o is THREE.InstancedMesh => o instanceof THREE.InstancedMesh);

  it('one InstancedMesh per part whatever the desk count; only the desk, chair and monitor cast shadows; low-poly items', () => {
    const small = new DeskSet(6, true, { plus: true, kits: floorLayout(6).slots.map((s) => deskKit(s)) });
    const big = new DeskSet(96, true, { plus: true, kits: floorLayout(96).slots.map((s) => deskKit(s)) });
    const names = (d: DeskSet) => meshesOf(d).map((m) => m.name).sort();
    expect(names(big)).toEqual(names(small));
    expect(meshesOf(big).length).toBe(18);
    expect(meshesOf(big).filter((m) => m.castShadow).map((m) => m.name).sort()).toEqual(['desks.chair', 'desks.chairBase', 'desks.legs', 'desks.monitor', 'desks.top']);
    // Triangles one desk draws at most (every part, both photos and pens): the crowd's worker is ~4k.
    const tris = (m: THREE.InstancedMesh) => (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;
    const perDesk = meshesOf(big)
      .filter((m) => m.name !== 'desks.kitL')
      .reduce((n, m) => n + tris(m) * (m.name === 'desks.photo' || m.name === 'desks.pens' || m.name === 'desks.led' ? 2 : 1), 0);
    console.log(`desk art: ${perDesk} triangles a desk at most`);
    expect(perDesk).toBeLessThan(2000);
    for (const m of meshesOf(big)) expect(m.count % 96).toBe(0);
    // The city: the desk, the chair and the monitor with its glow only.
    const city = new DeskSet(240, true, { plus: false });
    expect(meshesOf(city).map((m) => m.name).sort()).toEqual(['desks.chair', 'desks.chairBase', 'desks.legs', 'desks.monitor', 'desks.screen', 'desks.top']);
    for (const d of [small, big, city]) d.dispose();
  });
});

describe('OfficeView day and night (M17)', () => {
  const NIGHT = { day: 0, warmth: 0, azimuth: 0, elevation: -40 };

  it('the wall clock is looked at like a prop, with nothing to do (no milestone), and shows what it is told', () => {
    const office = new OfficeView(world().floorView('top')!, { shadows: false });
    const c = office.layout.props.find((p) => p.id === 'clock')!;
    const mid: V3 = [(c.box.min[0] + c.box.max[0]) / 2, (c.box.min[1] + c.box.max[1]) / 2, c.box.min[2]];
    const origin: V3 = [mid[0], 1.55, mid[2] - 2.2];
    const d = [mid[0] - origin[0], mid[1] - origin[1], mid[2] - origin[2]];
    const n = Math.hypot(...d);
    expect(office.pick(origin, [d[0]! / n, d[1]! / n, d[2]! / n])).toMatchObject({ kind: 'prop', id: 'clock', label: 'Clock', milestone: null });
    office.setClock({ time: '23:00', date: 'Wed 30 Sep' });
    office.setDaylight(lookOf(NIGHT));
    expect(office.lightInfo().clock).toEqual({ time: '23:00', date: 'Wed 30 Sep', day: false });
    office.dispose();
  });

  it('the lamps are full at night, a little by day and off on an asleep floor, whichever changes first', () => {
    const store = world();
    const office = new OfficeView(store.floorView('top')!, { shadows: false });
    office.setDaylight(lookOf(NIGHT));
    const night = office.lightInfo().lamps;
    office.setDaylight(lookOf(NOON));
    const day = office.lightInfo().lamps;
    expect(night.length).toBe(2);
    expect(night[0]).toBeGreaterThan(day[0]! * 2);
    expect(day[0]).toBeGreaterThan(0);
    // The floor goes to sleep at night: off; the light changing again does not turn them back on.
    office.setDaylight(lookOf(NIGHT));
    store.applyEvent({ t: 'floor.upsert', seq: 3, floor: { ...floor, state: 'asleep' } });
    office.apply(store.floorView('top')!);
    expect(office.isAsleep).toBe(true);
    expect(office.lightInfo().lamps).toEqual([0, 0]);
    office.setDaylight(lookOf(NOON));
    expect(office.lightInfo().lamps).toEqual([0, 0]);
    office.dispose();
  });
});

describe('OfficeView.updateUsage (#144)', () => {
  it('redraws the looked-at worker’s card with its usage line; another desk keeps the new view for its next redraw', () => {
    const store = world();
    store.applyEvent({ t: 'worker.upsert', seq: 2, worker: worker('two', { name: 'Bix', desk_index: 1, status: 'working' }) });
    const office = new OfficeView(store.floorView('top')!, { shadows: false });
    const card = (desk: number) => (office as unknown as { cards: { card(i: number): { usage?: string } | null } }).cards.card(desk);
    const used = (id: string, tokens: number) => {
      store.applyEvent({ t: 'worker.usage', seq: 3 + tokens, id, session: 'top', usage: { tokens, cost_usd_est: 0, priced: 'unknown' } });
      return store.workerView(id)!;
    };
    office.setFocus('old');
    expect(card(0)?.usage).toBeUndefined(); // nothing known yet
    office.updateUsage(used('old', 37_000));
    expect(card(0)?.usage).toContain('37k tokens');
    // Bix is not looked at: no card shows its usage, so none is drawn again…
    const seats = vi.spyOn(office as unknown as { setSeat(i: number, v: unknown): void }, 'setSeat');
    office.updateUsage(used('two', 52_000));
    expect(seats).not.toHaveBeenCalled();
    expect(card(1)?.usage).toBeUndefined();
    // …but a look at it shows the latest.
    office.setFocus('two');
    expect(card(1)?.usage).toContain('52k tokens');
    expect(card(0)?.usage).toBeUndefined();
  });
});
