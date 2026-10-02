import '../test/fakeCanvas';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { Floor, Worker } from '../net/protocol';
import type { V3 } from '../world/collide';
import { MEZZ_Y, seatRect } from '../world/layout';
import { TRAY_CAP } from '../world/delivery';
import { WorldStore } from '../world/store';
import { STAMP_3D } from './crewLook';
import { OfficeView, seatOf } from './office';
import { NO_VERDICT } from './tray';

// M6c on the office floor: a freelancer out of its chair with a report keeps its desk, its card and its pick; the
// orchestrator's in-tray; who holds a folder out; the corner seat.

const floor: Floor = { session: 'top', state: 'running', building: 'b1', index: 0, desks: 8 };
const worker = (id: string, over: Partial<Worker>): Worker => ({ id, session: 'top', workspace_id: `ws-${id}`, label: `label-${id}`, status: 'idle', ...over });

function world(orch: Partial<Worker> = {}): WorldStore {
  const s = new WorldStore(1000);
  s.applySnapshot({
    t: 'world.snapshot',
    seq: 1,
    world: {
      buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['top'] }],
      unassigned: [],
      floors: [floor],
      workers: [
        worker('orch', { name: 'Boss', desk_index: 0, role: 'orch', run: 'r1', label: 'ORCH|x|1', harness: 'claude', model: 'claude-opus-5-5', status: 'working', phase: 'review', pass: 1, ...orch }),
        worker('code', { name: 'Pip', desk_index: 1, role: 'code', run: 'r1', label: 'CODE|x|1|r1', orch_id: 'orch', harness: 'claude', model: 'claude-opus-5-5', status: 'done', report: { state: 'ready', at: 5, summary: 'done' } }),
        worker('rev', { name: 'Fig', desk_index: 2, role: 'review', run: 'r1', label: 'REVIEW|x|1|r1', orch_id: 'orch', harness: 'codex', model: 'gpt-6-sol', status: 'done', report: { state: 'ready', at: 6, verdict: 'CHANGES_REQUIRED', blockers: 1 } }),
      ],
    },
  });
  return s;
}

function lookAtSeat(o: OfficeView, desk: number, back = 1.5): { origin: V3; dir: V3 } {
  const at = seatOf(o.layout, desk, o.seat(desk))!;
  const s = at.slot;
  const fx = Math.sin(s.yaw);
  const fz = Math.cos(s.yaw);
  const origin: V3 = [s.seat.x - fx * back, at.y + 1.55, s.seat.z - fz * back];
  const to: V3 = [s.seat.x, at.y + 0.95, s.seat.z];
  const d = [to[0] - origin[0], to[1] - origin[1], to[2] - origin[2]];
  const n = Math.hypot(...d);
  return { origin, dir: [d[0]! / n, d[1]! / n, d[2]! / n] };
}

const cam = new THREE.PerspectiveCamera(60, 1.5, 0.1, 100);
/** One rendered frame: the crowd poses its crew parts. */
const frame = (o: OfficeView) => o.frame(0, cam, cam, { width: 900, height: 600 }, false);
const member = (o: OfficeView, desk: number) => {
  frame(o);
  return o.crewInfo().members.find((m) => m.desk === desk)!;
};

describe('a freelancer out with its report (M6c)', () => {
  it('its desk stays its own: pick still reaches it, its card shows, the laptop stays in its dock; only the figure is gone, and the chair is out', () => {
    const store = world();
    const o = new OfficeView(store.floorView('top')!, { shadows: false });
    const before = o.deskInfo(1)!;
    expect(member(o, 1).parts.length).toBeGreaterThan(0);
    o.setOut(1, { chair: 0 });
    expect(o.outDesks()).toEqual([1]);
    expect(o.awayDesks().size).toBe(0);
    const ray = lookAtSeat(o, 1);
    expect(o.pick(ray.origin, ray.dir)).toMatchObject({ kind: 'worker', id: 'code', name: 'Pip', desk: 1 });
    expect(o.cards.card(1)).toMatchObject({ name: 'Pip' });
    // The laptop screen stays live: the desk shows the worker's status, the laptop, its sticker.
    const during = o.deskInfo(1)!;
    expect(during.parts).toMatchObject({ laptop: 1, sticker: 1, monitor: 1, band: 1 });
    expect(during.sticker).toEqual(before.sticker);
    expect(during.band).toBe(before.band);
    expect(member(o, 1)).toMatchObject({ out: true, parts: [] });
    // The chair is pushed back as the walker rises, and back in when it sits.
    const chair = (d: number) => o.deskInfo(d)!.parts.chair;
    expect(chair(1)).toBe(1);
    o.setOut(1, { chair: 0.6 });
    expect(o.outDesks()).toEqual([1]);
    o.setOut(1, null);
    expect(o.outDesks()).toEqual([]);
    expect(member(o, 1).parts.length).toBeGreaterThan(0);
    o.dispose();
  });
});

describe('the report folder at a desk (M6c)', () => {
  it('a freelancer whose orchestrator is on the floor sits empty-handed after handing in; one waiting its turn holds the folder out; one whose orchestrator is elsewhere holds it out', () => {
    const store = world();
    const o = new OfficeView(store.floorView('top')!, { shadows: false });
    // Snapshot: already ready, the folder is on the tray.
    expect(member(o, 1).parts).not.toContain('folder');
    expect(member(o, 2).parts).not.toContain('folder');
    o.setWaiting([1]);
    expect(member(o, 1).parts).toContain('folder');
    expect(member(o, 2).parts).not.toContain('folder');
    o.setWaiting([]);
    expect(member(o, 1).parts).not.toContain('folder');
    o.dispose();
    // Its orchestrator is on another floor: as ever, it holds the folder out (stamp and all).
    const s2 = new WorldStore(1000);
    s2.applySnapshot({
      t: 'world.snapshot',
      seq: 1,
      world: {
        buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['top'] }],
        unassigned: [],
        floors: [floor],
        workers: [worker('rev', { name: 'Fig', desk_index: 2, role: 'review', label: 'REVIEW|x|1|r1', orch_id: 'gone', status: 'done', report: { state: 'ready', at: 6, verdict: 'PASS' } })],
      },
    });
    const o2 = new OfficeView(s2.floorView('top')!, { shadows: false });
    expect(member(o2, 2).parts).toEqual(expect.arrayContaining(['folder', 'stamp']));
    o2.dispose();
  });
});

describe('the orchestrator’s in-tray (M6c)', () => {
  it('every orchestrator desk has one; reports handed in lie in it with the verdict colour on the edge, five at most; nobody else has one', () => {
    const store = world();
    const o = new OfficeView(store.floorView('top')!, { shadows: false });
    expect(o.trayInfo(0)).toEqual({ tray: true, folders: 0, edges: [] });
    expect(o.trayInfo(1)).toEqual({ tray: false, folders: 0, edges: [] });
    o.setTray(0, ['pass', 'changes', null]);
    expect(o.trayInfo(0)).toEqual({ tray: true, folders: 3, edges: [STAMP_3D.pass, STAMP_3D.changes, NO_VERDICT] });
    o.setTray(0, ['pass', 'pass', 'pass', 'pass', 'pass', 'incomplete', 'changes']);
    const t = o.trayInfo(0);
    expect(t.folders).toBe(TRAY_CAP);
    expect(t.edges).toEqual([STAMP_3D.pass, STAMP_3D.pass, STAMP_3D.pass, STAMP_3D.incomplete, STAMP_3D.changes]);
    o.setTray(0, []);
    expect(o.trayInfo(0).folders).toBe(0);
    // The trays are instanced like the other crew props: three meshes, whatever the folders.
    const names: string[] = [];
    o.root.traverse((x) => x.name.startsWith('tray.') && names.push(x.name));
    expect(names.sort()).toEqual(['tray.body', 'tray.edges', 'tray.folders']);
    o.dispose();
  });

  it('an orchestrator’s desk has no notebook (the tray stands there)', () => {
    const o = new OfficeView(world().floorView('top')!, { shadows: false });
    expect(o.deskInfo(0)!.parts.notebook).toBeUndefined();
    expect(o.deskInfo(1)!.parts.notebook).toBeUndefined();
    o.dispose();
  });
});

describe('the corner seat (M6c, game-only)', () => {
  it('an orchestrator flagged `corner` sits at the mezzanine desk: picked, with its card and its tray up there; its floor desk is gone', () => {
    const store = world({ corner: true });
    const o = new OfficeView(store.floorView('top')!, { shadows: false });
    const L = o.layout;
    const at = seatOf(L, 0, o.seat(0))!;
    expect(at).toMatchObject({ corner: true, y: MEZZ_Y });
    expect(at.slot.seat).toEqual(L.mezzanine.orch.seat);
    // From beside its desk, up in the corner office (the walls are behind it).
    const origin: V3 = [at.slot.seat.x + 1.6, MEZZ_Y + 1.55, at.slot.seat.z];
    const dir: V3 = [-1, -(1.55 - 0.95) / 1.6, 0];
    const n = Math.hypot(...dir);
    expect(o.pick(origin, [dir[0] / n, dir[1] / n, dir[2] / n])).toMatchObject({ kind: 'worker', id: 'orch', desk: 0 });
    expect(o.cards.card(0)).toMatchObject({ name: 'Boss' });
    expect(o.cornerDesks()).toEqual([0]);
    expect(o.trayInfo(0).tray).toBe(true);
    // Nobody bumps into the desk it left, or into a chair that is not there; the others keep theirs.
    const obs = o.obstacles();
    expect(obs[0]).not.toEqual(expect.objectContaining({ x0: L.slots[0]!.desk.x - 0.7 }));
    expect(obs.some((r) => r.x0 === seatRect(L.slots[0]!).x0 && r.z0 === seatRect(L.slots[0]!).z0)).toBe(false);
    expect(obs.some((r) => r.x0 === seatRect(L.slots[1]!).x0 && r.z0 === seatRect(L.slots[1]!).z0)).toBe(true);
    o.dispose();
  });

  it('only an orchestrator takes the corner seat', () => {
    const store = world();
    store.applyEvent({ t: 'worker.upsert', seq: 2, worker: { ...store.workers.get('code')!, corner: true } });
    const o = new OfficeView(store.floorView('top')!, { shadows: false });
    expect(o.cornerDesks()).toEqual([]);
    o.dispose();
  });
});
