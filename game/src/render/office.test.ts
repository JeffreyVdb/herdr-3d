import '../test/fakeCanvas';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { Floor, Worker } from '../net/protocol';
import { DROP_S, FALL_S } from '../world/arrival';
import type { V3 } from '../world/collide';
import { deskKit } from '../world/deskKit';
import { floorLayout } from '../world/layout';
import { WorldStore } from '../world/store';
import { Arrivals, type ArrivalSpec } from './arrivals';
import { DeskSet } from './desks';
import { memberOf, OfficeView } from './office';

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
    const spec: ArrivalSpec = { id: 'new', kind: 'in', session: 'top', desk: 3, name: v.name, route: [{ x: s.seat.x, y: 0, z: s.seat.z }], seatYaw: s.yaw, tint: m.tint, cue: m.cue, display: m.display, phase: m.phase, harness: 'codex' };
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
