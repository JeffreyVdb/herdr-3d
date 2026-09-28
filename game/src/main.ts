import '@fontsource-variable/recursive/full.css';
import './ui/hud.css';
import './ui/panels.css';
import * as THREE from 'three/webgpu';
import { App, type LookAt, type Pose } from './app';
import { backendName, forceWebGLFromSearch, type BackendName } from './backend';
import { runBench, type BenchOptions, type BenchResult } from './bench';
import type { CommandName, WorldEvent } from './net/protocol';
import type { PanelSummary } from './ui/panels';
import { floorLayout } from './world/layout';

/** Debug/test hook, read by the Playwright tests and the Mac perf run. */
export interface H3DDebug {
  backend: BackendName | null;
  frames: number;
  error: string | null;
  /** True once a world snapshot has been rendered. */
  ready: boolean;
  /** `busy` while the elevator-door transition runs; `asleep`: the office's lights are off (null in the city). */
  view(): { mode: 'city' | 'floor'; floor: string | null; plan: boolean; busy: boolean; asleep: boolean | null };
  /** What the centre of the screen picks in first person (within 3 m), else null. */
  lookAt(): LookAt | null;
  /** Status shown on screen for a worker, and when (unix ms) it got there. */
  status(workerId: string): { status: string; at: number } | null;
  /**
   * Workers per floor as the store sees them: `name`/`desk` as shown, and
   * what the bridge sent for them (null from a bridge without those fields).
   */
  world(): Array<{
    session: string;
    asleep: boolean;
    desks: number;
    workers: Array<{ id: string; name: string; label: string; desk: number; status: string; bridgeName: string | null; bridgeDesk: number | null }>;
  }>;
  /** The office layout of a floor (for scripted camera paths). */
  layout(session: string): ReturnType<typeof floorLayout> | null;
  enterFloor(session: string, pose?: Pose): Promise<void>;
  /** Applies a protocol event as if the bridge had sent it (drives live updates deterministically). */
  inject(e: WorldEvent): void;
  leaveFloor(): Promise<void>;
  setPose(p: Pose): void;
  pose(): Pose | null;
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
  /** M3: what the open panel shows, null when none is open. */
  panel(): PanelSummary | null;
  /** M3: commands sent to the bridge so far, with their result once answered. */
  sent(): Array<{ t: CommandName; args: unknown; result?: { ok: boolean; code?: string } }>;
  /** M3: screen point of a floor itself in the city (to click its building). */
  floorPoint(session: string): { x: number; y: number } | null;
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
  }),
  lookAt: () => app?.lookAt() ?? null,
  status: (id) => app?.rendered.get(id) ?? null,
  world: () =>
    app
      ? app.store
          .city()
          .flatMap((b) => b.floors)
          .map((f) => ({
            session: f.session,
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
  layout: (s) => {
    const f = app?.store.floorView(s);
    return f ? floorLayout(f.desks) : null;
  },
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
  panel: () => app?.panels.summary() ?? null,
  sent: () => structuredClone(app?.sent ?? []),
  floorPoint: (s) => app?.floorPoint(s) ?? null,
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
