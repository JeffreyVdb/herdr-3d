import '@fontsource-variable/recursive/full.css';
import './ui/hud.css';
import './ui/panels.css';
import * as THREE from 'three/webgpu';
import { App, type LookAt, type Pose } from './app';
import { backendName, forceWebGLFromSearch, type BackendName } from './backend';
import { runBench, type BenchOptions, type BenchResult } from './bench';
import type { CommandName, WorldEvent } from './net/protocol';
import type { PanelSummary } from './ui/panels';
import type { Area, BuildingPlan } from './world/building';
import type { floorLayout } from './world/layout';
import { walkOutRoute, type Waypoint } from './world/route';

/** Debug/test hook, read by the Playwright tests and the Mac perf run. */
export interface H3DDebug {
  backend: BackendName | null;
  frames: number;
  error: string | null;
  /** True once a world snapshot has been rendered. */
  ready: boolean;
  /**
   * `busy` while the elevator-door transition runs; `asleep`: the office's lights are off (null in the city).
   * `floor` is the floor with an interior (the one you are on, or outside the one you last left; null in the
   * lobby); M3b: `area` where you are walking, `building` its name.
   */
  view(): {
    mode: 'city' | 'floor';
    floor: string | null;
    plan: boolean;
    busy: boolean;
    asleep: boolean | null;
    area: Area | null;
    building: string | null;
    /** M3c: sitting at your desk in the corner office. */
    seated: boolean;
    /** M3c: up on the mezzanine (look-at reaches ~20 m, cards read as nearer). */
    overlook: boolean;
  };
  /** What the centre of the screen picks in first person (within 3 m; ~20 m up on the mezzanine), else null. */
  lookAt(): LookAt | null;
  /** M3c: sits you at your desk (as E on it does); false unless you stand in your corner office. */
  sit(): boolean;
  /** Status shown on screen for a worker, and when (unix ms) it got there. */
  status(workerId: string): { status: string; at: number } | null;
  /**
   * Workers per floor as the store sees them: `name`/`desk` as shown, and
   * what the bridge sent for them (null from a bridge without those fields).
   */
  world(): Array<{
    session: string;
    /** M3: the building's name, null in the lot. */
    building: string | null;
    asleep: boolean;
    desks: number;
    workers: Array<{ id: string; name: string; label: string; desk: number; status: string; bridgeName: string | null; bridgeDesk: number | null }>;
  }>;
  /** The office layout of a floor, in its building's outline (for scripted camera paths). */
  layout(session: string): ReturnType<typeof floorLayout> | null;
  /** M3b: the building you walk around in (fire escape, lobby, street), null in the city. */
  building(): BuildingPlan | null;
  /** M3b: the building's id (null: the lot), name, floors ground first, and the floor with an interior. */
  where(): { building: string | null; name: string; floors: string[]; loaded: string | null } | null;
  /** M3b: rides the elevator to a building's lobby (null: the lot); no argument: the current building's. */
  enterLobby(building?: string | null): Promise<void>;
  /** M3b: the walk-out route (M4) from a desk of a floor, as waypoints. */
  route(session: string, desk: number): Waypoint[];
  /** M3b: the receptionist's state: what it said (and when), the clip ids played, the cooldown ends, the bubble text. */
  reception(): ReturnType<import('./reception').Reception['debug']> | null;
  /** M3b: reception events the game detected (front door in / out, elevator arrival, E at the desk). */
  receptionEvents(): Array<{ ev: string; at: number; building: string | null }>;
  enterFloor(session: string, pose?: Pose): Promise<void>;
  /** Applies a protocol event as if the bridge had sent it (drives live updates deterministically). */
  inject(e: WorldEvent): void;
  leaveFloor(): Promise<void>;
  /** `y` (feet above the street) places you on any floor, landing, the street or in the lobby. */
  setPose(p: Pose): void;
  /** M3b: with `y` (feet above the street), `area` and `storey` (the floor, or the landing's floor). */
  pose(): (Pose & { eye: number; y: number; area: Area; storey: number | null; floor: string | null; seated: boolean }) | null;
  plan(open: boolean): void;
  focusBuilding(i: number | null): void;
  /** Speech-bubble cards on screen and what they say. */
  cards(): Array<{ desk: number; name: string; display: string; task: string }>;
  /** Screen point of a floor's badge in the city (to click it). */
  badgePoint(session: string): { x: number; y: number } | null;
  bench(o?: BenchOptions): Promise<BenchResult>;
  /** M3: opens the elevator panel of a building id (null: the lot); no argument: the current floor's building. */
  openElevator(building?: string | null): void;
  /** M3: opens the buildings panel. */
  openBuildings(): void;
  /** M3: opens a floor's settings panel. */
  openSettings(session: string): void;
  /** M3: what the open panel shows, null when none is open. */
  panel(): PanelSummary | null;
  /** M3: commands sent to the bridge so far, with their result once answered. */
  sent(): Array<{ t: CommandName; args: unknown; result?: { ok: boolean; code?: string } }>;
  /** M3: screen point of a floor itself in the city (to click its building). */
  floorPoint(session: string): { x: number; y: number } | null;
  /** M3: connection phase and the bridge epoch (changes when the bridge restarts). */
  connection(): { phase: string; epoch: string | null };
}

declare global {
  interface Window {
    __h3d: H3DDebug;
  }
}

const params = new URLSearchParams(window.location.search);
let app: App | null = null;
let renderer: THREE.WebGPURenderer | null = null;

const h3d: H3DDebug = {
  backend: null,
  frames: 0,
  error: null,
  ready: false,
  view: () => ({
    mode: app?.mode ?? 'city',
    floor: app?.office?.session ?? null,
    plan: app?.plan ?? false,
    busy: app?.busy ?? false,
    asleep: app?.officeAsleep ?? null,
    area: app?.mode === 'floor' ? app.place.area : null,
    building: app?.where?.name ?? null,
    seated: app?.seated ?? false,
    overlook: app?.overlooking ?? false,
  }),
  sit: () => app?.sit() ?? false,
  lookAt: () => app?.lookAt() ?? null,
  status: (id) => app?.rendered.get(id) ?? null,
  world: () =>
    app
      ? app.store
          .city()
          .flatMap((b) => b.floors)
          .map((f) => ({
            session: f.session,
            building: f.building?.name ?? null,
            asleep: f.asleep,
            desks: f.desks,
            workers: f.workers.map((w) => ({
              id: w.worker.id,
              name: w.name,
              label: w.worker.label,
              desk: w.desk,
              status: w.worker.status,
              bridgeName: w.worker.name ?? null,
              bridgeDesk: w.worker.desk_index ?? null,
            })),
          }))
      : [],
  layout: (s) => app?.layoutOf(s) ?? null,
  building: () => app?.plan3 ?? null,
  where: () => app?.where ?? null,
  enterLobby: async (b) => {
    if (!app) return;
    await app.enterLobby(b === undefined ? (app.where?.building ?? null) : b, { transition: false });
  },
  route: (s, desk) => {
    const L = app?.layoutOf(s);
    const w = app?.where;
    const plan = app?.plan3;
    const storey = w ? w.floors.indexOf(s) : -1;
    return L && plan && storey >= 0 ? walkOutRoute(L, plan, storey, desk) : [];
  },
  reception: () => app?.reception.debug() ?? null,
  receptionEvents: () => structuredClone(app?.receptionEvents ?? []),
  enterFloor: async (s, pose) => {
    await app?.enterFloor(s, pose ? { transition: false, pose } : { transition: false });
  },
  leaveFloor: async () => app?.leaveFloor(),
  inject: (e) => app?.inject(e),
  setPose: (p) => app?.setPose(p),
  pose: () => (app?.mode === 'floor' ? app.pose() : null),
  plan: (open) => app?.setPlan(open),
  focusBuilding: (i) => app?.focusBuilding(i, false),
  cards: () => app?.office?.shownCards() ?? [],
  badgePoint: (s) => app?.badgePoint(s) ?? null,
  openElevator: (b) => (b === undefined ? app?.openElevator() : app?.openElevator(b)),
  openBuildings: () => app?.openBuildings(),
  openSettings: (s) => app?.panels.openSettings(s),
  panel: () => app?.panels.summary() ?? null,
  sent: () => structuredClone(app?.sent ?? []),
  floorPoint: (s) => app?.floorPoint(s) ?? null,
  connection: () => ({ phase: app?.conn.phase ?? 'stopped', epoch: app?.client.resume.epoch ?? null }),
  bench: async (o) => {
    if (!app || !renderer) throw new Error('not started');
    return runBench(app, renderer, o);
  },
};
window.__h3d = h3d;

async function start(): Promise<void> {
  const r = new THREE.WebGPURenderer({
    antialias: true,
    forceWebGL: forceWebGLFromSearch(window.location.search),
    trackTimestamp: params.has('ts'),
  });
  renderer = r;
  r.setPixelRatio(window.devicePixelRatio);
  r.setSize(window.innerWidth, window.innerHeight);
  r.shadowMap.enabled = params.get('shadows') !== '0';
  r.shadowMap.type = THREE.PCFShadowMap;
  document.body.appendChild(r.domElement);
  await r.init();

  h3d.backend = backendName(r.backend);
  const overlay = document.getElementById('debug');
  if (overlay) overlay.textContent = `backend: ${h3d.backend}`;

  // Canvas text (boards, cards) needs the font before it is drawn.
  await Promise.race([
    Promise.all(['800 32px "Recursive Variable"', '500 25px "Recursive Variable"'].map((f) => document.fonts.load(f))),
    new Promise((res) => setTimeout(res, 1500)),
  ]);

  app = new App({ renderer: r, host: document.body, params });
  const a = app;
  const origRender = a.render.bind(a);
  a.render = () => {
    origRender();
    h3d.frames = a.frames;
    if (!h3d.ready && a.store.snapshots > 0) h3d.ready = true;
  };
  a.start();
  const floor = params.get('floor');
  if (floor) {
    const wait = setInterval(() => {
      if (a.store.floorView(floor)) {
        clearInterval(wait);
        void a.enterFloor(floor, { transition: false }).then(() => {
          if (params.get('plan') === '1') a.setPlan(true);
        });
      }
    }, 50);
  }
}

start().catch((err: unknown) => {
  h3d.error = String(err);
  console.error('h3d: renderer failed to start', err);
  const overlay = document.getElementById('debug');
  if (overlay) overlay.textContent = `renderer error: ${String(err)}`;
});
