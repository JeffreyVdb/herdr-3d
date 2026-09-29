import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BridgeClient, type CommandResult, type ConnState, type SocketLike } from './net/client';
import { bridgeUrl, takeToken } from './net/endpoint';
import type { CommandArgs, CommandName, WorldEvent } from './net/protocol';
import { CityView } from './render/city';
import { shouldRender, targetHz } from './render/framePolicy';
import { Arrivals, type ArrivalSpec } from './render/arrivals';
import { memberOf, OfficeView, REACH, type Target } from './render/office';
import { OutsideView } from './render/outside';
import { BUILDING_TINTS, LOT_TINT } from './render/palette';
import { WalkView } from './render/walk';
import { createGameAudio, createReception, receptionContext, type GameAudio, type Reception, type ReceptionEvent } from './reception';
import { Hud, type PlanLabel } from './ui/hud';
import { HireDialog } from './ui/hire';
import { Panels } from './ui/panels';
import { SendHomeDialog } from './ui/sendHome';
import { RADIUS, Walker } from './input/walk';
import { Laptops } from './laptop';
import { SeatBar } from './ui/seat';
import { blocked, blocked3, groundAt, type WalkWorld } from './world/collide';
import { buildingPlan, floorY, loadedFloor, placeAt, walkWorld, type Area, type BuildingPlan, type Place } from './world/building';
import { EYE_HEIGHT, floorLayout as floorLayoutIn, openingsFor, outlineOf, overlookReach, type Opening, type Outline } from './world/layout';
import { walkInRoute, type ArrivalKind } from './world/arrival';
import type { Display } from './world/derive';
import { firstFreeDesk, isFreshHire, Reservations } from './world/hire';
import { walkOutRoute } from './world/route';
import { WorldStore, type Change, type Counts, type FloorView } from './world/store';

export interface AppOptions {
  renderer: THREE.WebGPURenderer;
  host: HTMLElement;
  params: URLSearchParams;
}

export interface LookAt {
  kind: Target['kind'];
  id: string;
  /** A worker's name; for your own desk (#20), the name on its plate. */
  name?: string;
  label?: string;
}

export interface Pose {
  x: number;
  z: number;
  yaw: number;
  pitch?: number;
  /** Feet above the street (absolute). Left out: stay at the current level. */
  y?: number;
}

type Mode = 'city' | 'floor';

/** The building you walk around in: its floors (ground first), outline, plan and look. */
interface BuildingCtx {
  id: string | null;
  name: string;
  tint: number;
  floors: FloorView[];
  outline: Outline;
  openings: Opening[];
  plan: BuildingPlan;
  /** Changes when the outside has to be rebuilt (floors, their order, size, name, colour). */
  shape: string;
}

const CLIENT = 'herdr-3d-game/0.2';

/** Everything between the renderer and the bridge: views, input, HUD, frame pacing. */
export class App {
  readonly store = new WorldStore();
  readonly hud: Hud;
  readonly city: CityView;
  readonly client: BridgeClient;
  readonly panels: Panels;
  /** M4: the hire and send-home dialogs, and the workers walking in and out. */
  readonly hire: HireDialog;
  readonly sendHome: SendHomeDialog;
  readonly arrivals: Arrivals;
  /** M4: hires on their way: their desks' "+" is hidden until the worker walks in. */
  private readonly reserved = new Reservations();
  /** Commands sent to the bridge, in order (test hook). */
  readonly sent: Array<{ t: CommandName; args: unknown; result?: CommandResult }> = [];
  /** Commands the bridge answered `unknown_command` for: an older bridge. */
  private readonly unsupported = new Set<CommandName>();
  mode: Mode = 'city';
  /** The floor with an interior: the one you are on, or (outside) the one you last left; null in the lobby. */
  office: OfficeView | null = null;
  /** Where you are in the building (walk mode). */
  place: Place = { area: 'floor', storey: null };
  /** Reception events the app detected, in order (test hook), and the receptionist once coder B's module is in. */
  readonly receptionEvents: Array<{ ev: ReceptionEvent; at: number; building: string | null }> = [];
  readonly audio: GameAudio;
  readonly reception: Reception;
  /** Worker id → status on screen as of the last rendered frame, and when it got there. */
  readonly rendered = new Map<string, { status: Display; at: number }>();
  frames = 0;
  batterySaver = false;
  conn: ConnState = { phase: 'stopped' };
  readonly url: string;
  /** #20: the name on your desk's name plate (`?me=`; the bridge sends no user name yet). */
  readonly owner: string;
  /** M5 screen: live laptop screens, sitting at a worker's laptop, and the bar while you do. */
  readonly laptops: Laptops;
  readonly seatBar: SeatBar;

  private readonly r: THREE.WebGPURenderer;
  private readonly cityCam: THREE.PerspectiveCamera;
  private readonly fpCam: THREE.PerspectiveCamera;
  private readonly planCam: THREE.OrthographicCamera;
  private readonly controls: OrbitControls;
  private readonly walker: Walker;
  private readonly walk: WalkView;
  private building: BuildingCtx | null = null;
  /** Storey of the floor with an interior (null: none, e.g. in the lobby). */
  private loaded: number | null = null;
  private worldCache: { key: unknown[]; world: WalkWorld } | null = null;
  private fireDoor = 0;
  private mezzDoor = 0;
  /** Whether the hint on screen is the seated one. */
  private hintSitting = false;
  private readonly shadows: boolean;
  private planOpen = false;
  private lastActivity = 0;
  private lastRender = -Infinity;
  private lastT = 0;
  private statusDirty = true;
  private cameraMoved = true;
  private focus: number | null = null;
  private tween: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; t0: number; ms: number } | null = null;
  private target: Target | null = null;
  private transitioning = false;
  private readonly fixture: boolean;
  private readonly vp = { width: 1, height: 1 };
  private readonly ray = new THREE.Vector3();
  private down: { x: number; y: number } | null = null;
  private planLabelsKey = '';
  /** World data behind the plan labels changed (status, names, seats). */
  private planDirty = false;

  constructor(o: AppOptions) {
    this.r = o.renderer;
    this.shadows = o.params.get('shadows') !== '0';
    this.owner = (o.params.get('me') ?? '').trim().slice(0, 40) || 'You';
    this.batterySaver = o.params.get('battery') === '1';
    this.hud = new Hud(o.host);
    this.hud.setBattery(this.batterySaver);
    // Sound (the first click, key or pointer lock unlocks it) and the receptionist in every lobby.
    this.audio = createGameAudio();
    this.hud.mountAudio(this.audio);
    this.reception = createReception({ audio: this.audio, overlay: this.hud.root, shadows: this.shadows });
    this.city = new CityView(
      this.hud.floorList,
      this.shadows,
      (s) => void this.enterFloor(s),
      this.hud.buildingList,
      (b) => this.openElevator(b),
    );
    this.city.badges = o.params.get('badges') !== '0';

    this.cityCam = new THREE.PerspectiveCamera(42, 1, 0.1, 600);
    this.fpCam = new THREE.PerspectiveCamera(70, 1, 0.05, 320);
    this.walk = new WalkView(this.shadows);
    this.planCam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
    this.controls = new OrbitControls(this.cityCam, this.r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = 1.38;
    this.controls.minAzimuthAngle = -0.45;
    this.controls.maxAzimuthAngle = 1.95;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 220;
    this.controls.addEventListener('change', () => this.activity(true));
    this.controls.addEventListener('start', () => (this.tween = null));

    this.walker = new Walker(
      this.r.domElement,
      () => this.activity(true),
      (locked, error) => {
        if (error && this.mode === 'floor') {
          this.setPlan(true);
          this.hud.toast('Mouse look needs pointer lock, which this browser refused. The floor plan works instead.');
        }
        this.updateHint();
        this.activity(false);
      },
    );

    this.fixture = /\/fixture\//.test(o.params.get('ws') ?? '');
    const token = takeToken(window.location, safeSession(), (u) => history.replaceState(null, '', u));
    this.url = bridgeUrl(window.location, token);
    this.client = new BridgeClient({
      url: this.url,
      clientName: CLIENT,
      socket: (u) => new WebSocket(u) as unknown as SocketLike,
      handlers: {
        onSnapshot: (s) => this.applyChange(this.store.applySnapshot(s)),
        onEvent: (e) => this.onWorldEvent(e),
        onConn: (m) => this.laptops.onConn(m),
        onState: (s) => {
          this.conn = s;
          // M5 screen: a dropped connection took every watch with it; the next live one watches again.
          this.laptops.setConnected(s.phase === 'live');
          this.hud.setConn(s, this.fixture, Date.now());
          this.updateNotice();
        },
      },
    });

    this.panels = new Panels(o.host, {
      store: this.store,
      here: () => this.hereSession(),
      inLobby: () => this.mode === 'floor' && this.place.area === 'lobby',
      send: (t, args) => this.send(t, args),
      unsupported: (t) => this.unsupported.has(t),
      travel: (s) => {
        this.panels.close();
        void this.enterFloor(s);
      },
      travelLobby: (b) => {
        this.panels.close();
        void this.enterLobby(b);
      },
      toast: (m, kind) => this.hud.toast(m, kind === 'error' ? 6500 : 3600, kind),
    });

    const dialogHost = {
      store: this.store,
      send: <T extends CommandName>(t: T, args: CommandArgs[T]) => this.send(t, args),
      unsupported: (t: CommandName) => this.unsupported.has(t),
      toast: (m: string, kind: 'info' | 'error') => this.hud.toast(m, kind === 'error' ? 6500 : 3600, kind),
      now: () => Date.now(),
    };
    this.hire = new HireDialog(o.host, { ...dialogHost, reserve: (s, d) => this.reserve(s, d), held: (s) => this.heldDesks(s) });
    this.sendHome = new SendHomeDialog(o.host, dialogHost);
    this.arrivals = new Arrivals(this.shadows);
    this.walk.scene.add(this.arrivals.group);
    this.seatBar = new SeatBar(this.hud.root, { text: (t) => this.laptops.typeText(t), paste: (t) => this.laptops.paste(t), stand: () => this.laptops.stand() });
    this.laptops = new Laptops(
      {
        store: this.store,
        send: (t, args) => this.send(t, args),
        // `worker.prompt` is declared by the M5 panels' protocol block; paste only needs to send it.
        sendPrompt: (id, text) => this.send('worker.prompt' as CommandName, { id, text } as never),
        unsupported: (t) => this.unsupported.has(t),
        toast: (m, kind) => this.hud.toast(m, kind === 'error' ? 5200 : 3200, kind),
        seat: this.seatBar,
        insets: () => ({ top: parseFloat(this.hud.root.style.getPropertyValue('--topbar-bottom')) || 70, bottom: this.seatBar.el.getBoundingClientRect().height + 18 }),
      },
      o.params,
    );

    this.hud.on('city', () => void this.leaveFloor());
    this.hud.on('hire', () => this.openHire());
    this.hud.on('buildings', () => this.openBuildings());
    this.hud.on('elevator', () => !this.transitioning && this.openElevator());
    this.hud.on('battery', () => this.toggleBattery());
    this.hud.on('issues', () => this.openBoard('Issues'));
    this.hud.on('prs', () => this.openBoard('Pull requests'));
    this.bindInput();
    this.resize();
    this.hud.setCity(0, 0, zero());
    this.updateNotice();
    this.updateHint();
  }

  start(): void {
    this.client.start();
    void this.r.setAnimationLoop((t) => this.tick(t));
  }

  /** Stops the frame loop (the benchmark drives frames itself). */
  pause(): void {
    void this.r.setAnimationLoop(null);
  }

  resume(): void {
    this.lastRender = -Infinity;
    void this.r.setAnimationLoop((t) => this.tick(t));
  }

  // ---- world -> views --------------------------------------------------------

  private applyChange(c: Change): void {
    this.statusDirty = true;
    this.planDirty = true;
    this.activity(false);
    if (c.structure) {
      const firstWorld = this.city.isEmpty;
      this.city.build(this.store.city());
      if (firstWorld) this.frameCity(false);
      if (this.mode === 'floor') this.syncWalk();
    } else {
      for (const id of c.workers) {
        const v = this.store.workerView(id);
        if (!v) continue;
        this.city.updateWorker(v);
        if (this.office?.session === v.worker.session) this.office.updateWorker(v);
      }
      for (const s of c.sessions) {
        const fv = this.store.floorView(s);
        if (fv) this.city.updateFloor(fv);
      }
    }
    this.refreshTopbar();
    this.updateNotice();
    if (this.mode === 'floor') this.updateHint();
    this.panels.refresh();
    this.hire.refresh();
    this.sendHome.refresh();
  }

  // ---- M4: hire, send home, walking in and out ------------------------------------

  /**
   * A world event, with what M4 plays for it: a fresh hire's first upsert
   * walks it in, a `sent_home` removal walks it out (captured before the
   * store forgets the worker). Workers you cannot see resolve at once.
   */
  private onWorldEvent(e: WorldEvent): void {
    let after: (() => void) | null = null;
    if (e.t === 'worker.upsert' && !this.store.workers.has(e.worker.id) && isFreshHire(e.worker.hired_at, Date.now())) {
      const id = e.worker.id;
      after = () => this.startArrival('in', id);
    } else if (e.t === 'worker.removed' && e.reason === 'sent_home' && this.store.workers.has(e.id)) {
      const spec = this.arrivalSpec('out', e.id);
      const v = this.store.workerView(e.id);
      this.arrivals.cancel(e.id);
      if (spec) this.beginArrival(spec);
      else if (v) this.arrivals.skip({ id: e.id, kind: 'out', session: v.worker.session, desk: v.desk });
    } else if (e.t === 'worker.removed' || e.t === 'floor.removed') {
      // Gone some other way: a walk-in stops where it is.
      if (e.t === 'worker.removed') this.arrivals.cancel(e.id);
    } else if (e.t === 'worker.upsert' && this.arrivals.has(e.worker.id)) {
      const old = this.store.workers.get(e.worker.id);
      if (old && (old.session !== e.worker.session || old.desk_index !== e.worker.desk_index)) this.arrivals.cancel(e.worker.id);
    }
    this.applyChange(this.store.applyEvent(e));
    after?.();
  }

  /** What a walk needs: the worker's look, desk and route in the building you are in (null: not visible from here). */
  private arrivalSpec(kind: ArrivalKind, id: string): ArrivalSpec | null {
    const v = this.store.workerView(id);
    const ctx = this.building;
    if (!v || this.mode !== 'floor' || !ctx) return null;
    const session = v.worker.session;
    const storey = ctx.floors.findIndex((f) => f.session === session);
    if (storey < 0) return null;
    const L = this.office?.session === session ? this.office.layout : this.layoutOf(session);
    const slot = L?.slots[v.desk];
    if (!L || !slot) return null;
    const route = kind === 'out' ? walkOutRoute(L, ctx.plan, storey, v.desk) : walkInRoute(L, ctx.plan, storey, v.desk);
    const m = memberOf(v);
    return { id, kind, session, desk: v.desk, name: v.name, route, seatYaw: slot.yaw, tint: m.tint, cue: m.cue, display: m.display, phase: m.phase };
  }

  private startArrival(kind: ArrivalKind, id: string): void {
    const spec = this.arrivalSpec(kind, id);
    if (spec) this.beginArrival(spec);
    else {
      const v = this.store.workerView(id);
      if (v) this.arrivals.skip({ id, kind, session: v.worker.session, desk: v.desk });
    }
  }

  private beginArrival(spec: ArrivalSpec): void {
    if (!this.arrivals.start(spec, performance.now() / 1000)) return;
    // The desk changes at once (no "+" flash before the next frame).
    if (this.office?.session === spec.session) this.office.setAway(spec.desk, { show: spec.kind === 'out' ? 'busy' : 'empty', display: spec.display, cue: spec.cue.color });
    this.activity(true);
  }

  /** A hire is on its way to `desk`; the returned function ends this hire's hold (its ack came). */
  private reserve(session: string, desk: number): () => void {
    const release = this.reserved.add(session, desk);
    this.applyReserve();
    return () => {
      // Another hire still holding the desk, or a walk on it, keeps it as it is.
      if (!release() || this.office?.session !== session) return;
      const walking = this.arrivals.info(performance.now() / 1000).some((a) => a.session === session && a.desk === desk);
      if (!walking) this.office.setAway(desk, null);
    };
  }

  private applyReserve(): void {
    const o = this.office;
    if (!o) return;
    for (const r of this.reserved.all()) if (o.session === r.session && !o.seat(r.desk)) o.setAway(r.desk, { show: 'empty', display: 'idle', cue: 0xffffff });
  }

  /** Desks of a floor that are not free for another hire: a hire or a walk is on its way there. */
  heldDesks(session: string): Set<number> {
    const out = this.reserved.desks(session);
    for (const a of this.arrivals.info(performance.now() / 1000)) if (a.session === session) out.add(a.desk);
    return out;
  }

  /** The hire dialog for a desk of the floor you are on; no desk: the first free one (the top bar's Hire). */
  openHire(desk?: number): void {
    const s = this.hereSession();
    const fv = s ? this.store.floorView(s) : null;
    if (!s || !fv) {
      this.hud.toast('Walk onto an office floor to hire someone there.', 2400);
      return;
    }
    if (fv.asleep || fv.transition) {
      this.hud.toast(`${s} is ${fv.transition === 'waking' ? 'waking up' : fv.transition === 'sleeping' ? 'going to sleep' : 'asleep'}. Wake it from the elevator (L) to hire.`, 3200);
      return;
    }
    const held = this.heldDesks(s);
    const d = desk ?? firstFreeDesk(fv, held);
    if (d === null) {
      this.hud.toast(`No free desk on ${s} right now.`, 2400);
      return;
    }
    if (held.has(d) && !fv.seats[d]) {
      this.hud.toast(`Someone is already on the way to Desk ${d + 1}.`, 2000);
      return;
    }
    const seat = fv.seats[d];
    if (seat) {
      this.hud.toast(`${seat.name} sits at Desk ${d + 1}.`, 2000);
      return;
    }
    this.walker.release();
    this.walker.stop();
    this.panels.close();
    this.hire.open(s, d);
  }

  /** The send-home dialog for a worker. */
  openSendHome(id: string): void {
    if (!this.store.workerView(id)) return;
    this.walker.release();
    this.walker.stop();
    this.panels.close();
    this.sendHome.open(id);
  }

  /** M4 dialogs are open (keys go to them). */
  get dialogOpen(): boolean {
    return this.hire.isOpen || this.sendHome.isOpen;
  }

  /** The desks of the floor with an interior as shown: who sits there, whether its "+" is up, what the walk animation holds (test hook). */
  deskStates(): Array<{ desk: number; worker: string | null; plus: boolean; away: 'busy' | 'empty' | null }> {
    const o = this.office;
    if (!o) return [];
    const away = o.awayDesks();
    return Array.from({ length: o.desksCount }, (_, i) => {
      const w = o.seat(i);
      const a = away.get(i) ?? null;
      return { desk: i, worker: w?.worker.id ?? null, plus: !w && !a, away: a };
    });
  }

  // ---- commands and panels ------------------------------------------------------

  /** Sends a command; remembers commands an older bridge does not know. */
  async send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult> {
    const entry: (typeof this.sent)[number] = { t, args };
    this.sent.push(entry);
    const r = await this.client.request(t, args);
    entry.result = r;
    if (!r.ok && r.code === 'unknown_command') this.unsupported.add(t);
    return r;
  }

  /** The elevator panel of a building (null: the unassigned lot); walking around, of the building you are in. */
  openElevator(building?: string | null): void {
    const b = building !== undefined ? building : this.mode === 'floor' && this.building ? this.building.id : null;
    this.walker.release();
    this.walker.stop();
    this.panels.openElevator(b);
  }

  openBuildings(): void {
    this.walker.release();
    this.walker.stop();
    this.panels.openBuildings();
  }

  private refreshTopbar(): void {
    if (this.mode === 'floor') {
      // On a floor, or its landing: that floor. In the lobby, on the street or the stairs: the building.
      const ctx = this.building;
      const p = this.place;
      const s = p.storey !== null ? ctx?.floors[p.storey]?.session : undefined;
      const fv = s ? this.store.floorView(s) : null;
      if (fv) this.hud.setFloor(fv, p.area === 'fire-escape' ? 'fire-escape' : 'floor');
      else if (ctx) {
        const total = zero();
        for (const f of ctx.floors) {
          const v = this.store.floorView(f.session);
          if (!v || v.asleep) continue;
          total.working += v.counts.working;
          total.needsYou += v.counts.needsYou;
          total.idle += v.counts.idle;
          total.total += v.counts.total;
        }
        this.hud.setBuilding(ctx.name, p.area, ctx.floors.length, total);
      }
      return;
    }
    const city = this.store.city();
    const total = zero();
    let floors = 0;
    for (const b of city)
      for (const f of b.floors) {
        floors++;
        if (f.asleep) continue;
        total.working += f.counts.working;
        total.needsYou += f.counts.needsYou;
        total.idle += f.counts.idle;
        total.total += f.counts.total;
      }
    this.hud.setCity(city.filter((b) => b.building).length, floors, total);
  }

  private updateNotice(): void {
    if (this.store.snapshots > 0) {
      if (this.city.isEmpty && this.mode === 'city') this.hud.setNotice('No floors yet', 'herdr-world is connected but sees no herdr sessions. Start one with <code>herdr</code> and it shows up here.');
      else this.hud.setNotice(null);
      return;
    }
    const s = this.conn;
    const where = `<code>${escapeHtml(this.url.replace(/token=[^&]+/, 'token=…'))}</code>`;
    if (s.phase === 'failed') this.hud.setNotice('The bridge refused this game', `${escapeHtml(s.reason)}. Update the game or the bridge so their protocol versions match.`);
    else if (s.phase === 'waiting') this.hud.setNotice('Waiting for herdr-world', `No answer from ${where}. Retrying with backoff; check that the helper tunnel is up.`);
    else this.hud.setNotice('Connecting to herdr-world', `Opening ${where}…`);
  }

  // ---- modes -------------------------------------------------------------------

  async enterFloor(session: string, opts: { transition?: boolean; pose?: Pose } = {}): Promise<void> {
    const fv = this.store.floorView(session);
    if (!fv || this.transitioning) return;
    const swap = () => {
      // Read the floor again: events keep arriving while the doors close, and
      // until the office exists nothing else applies them to it.
      const now = this.store.floorView(session);
      const ctx = now ? this.buildingFor(session) : null;
      if (!now || !ctx) {
        this.hud.toast(`${session} is gone.`);
        return;
      }
      this.walker.stop();
      this.setBuilding(ctx);
      const storey = ctx.floors.findIndex((f) => f.session === session);
      this.loadFloor(storey, now);
      this.enterWalk();
      const L = (this.office as OfficeView).layout;
      const p = opts.pose ?? { x: L.spawn.x, z: L.spawn.z, yaw: L.spawn.yaw, pitch: -0.05 };
      this.walker.place(p.x, p.z, p.yaw, p.pitch ?? 0, p.y ?? floorY(storey));
      this.afterPlace();
    };
    await this.ride(fv.level ? `${fv.level.number}` : fv.session, swap, opts.transition);
  }

  /** The elevator to a building's lobby (null: the unassigned lot's). */
  async enterLobby(building: string | null, opts: { transition?: boolean } = {}): Promise<void> {
    if (this.transitioning || !this.buildingById(building)) return;
    const swap = () => {
      const ctx = this.buildingById(building);
      if (!ctx) {
        this.hud.toast('That building is gone.');
        return;
      }
      this.walker.stop();
      this.setBuilding(ctx);
      this.unloadFloor();
      this.enterWalk();
      const s = ctx.plan.lobby.spawn;
      this.walker.place(s.x, s.z, s.yaw, -0.05, 0);
      this.afterPlace();
      this.receptionEvent('arrive-elevator');
    };
    await this.ride('L', swap, opts.transition);
  }

  /** Elevator doors close, `swap` runs, doors open (or at once, for tests and reduced motion). */
  private async ride(label: string, swap: () => void, transition = true): Promise<void> {
    this.transitioning = true;
    try {
      if (transition === false || reducedMotionTest()) swap();
      else await this.hud.doorsTransition(label, swap);
    } finally {
      this.transitioning = false;
      this.activity(true);
    }
  }

  private enterWalk(): void {
    this.mode = 'floor';
    this.hud.setMode('floor');
    this.city.setVisible(false);
    this.planCam.userData.fit = false;
    this.setPlan(false);
  }

  /** After a teleport (arrival, setPose): where you are, and everything that shows it. */
  private afterPlace(): void {
    this.place = { area: 'floor', storey: null };
    this.updatePlace(false, true);
    this.walker.applyTo(this.fpCam, this.walk.base);
    this.refreshTopbar();
    this.statusDirty = true;
    this.cameraMoved = true;
    this.updateHint();
  }

  async leaveFloor(): Promise<void> {
    if (this.mode !== 'floor' || this.transitioning) return;
    const session = this.office?.session ?? this.building?.floors[0]?.session ?? null;
    const swap = () => {
      this.walker.release();
      this.walker.stop();
      this.unloadFloor();
      this.dropOutside();
      this.arrivals.clear();
      this.building = null;
      this.mode = 'city';
      this.setPlan(false);
      this.hud.setMode('city');
      this.city.setVisible(true);
      this.refreshTopbar();
      const b = session ? this.city.buildingOf(session) : null;
      if (b !== null) this.focusBuilding(b, false);
      this.statusDirty = true;
      this.cameraMoved = true;
      this.updateHint();
      this.updateNotice();
    };
    await this.ride('CITY', swap);
  }

  // ---- the building around you -------------------------------------------------------

  /** The building a floor is in (the unassigned lot's floors make one too). */
  private buildingFor(session: string): BuildingCtx | null {
    return this.store.floors.has(session) ? this.buildingById(this.panels.buildingOf(session)) : null;
  }

  private buildingById(id: string | null): BuildingCtx | null {
    const store = this.store;
    if (id !== null && !store.buildings.has(id)) return null;
    const floors = id === null ? store.stack(null) : store.stack(id).reverse();
    if (!floors.length) return null;
    // The city view's colour for it, so the facade matches the dollhouse.
    const bi = store.city().findIndex((b) => (b.building?.id ?? null) === id);
    const tint = id === null ? LOT_TINT : (BUILDING_TINTS[Math.max(0, bi) % BUILDING_TINTS.length] ?? 0xffb8b0);
    const outline = outlineOf(floors.map((f) => f.desks));
    const openings = openingsFor(outline.width, outline.depth);
    const door = openings.find((o) => o.kind === 'door') as Opening;
    const plan = buildingPlan(outline, floors.length, { z0: door.u0, z1: door.u1, height: door.y1 });
    const name = id === null ? 'Unassigned lot' : (store.buildings.get(id)?.name ?? 'Building');
    return { id, name, tint, floors, outline, openings, plan, shape: JSON.stringify([id, name, tint, outline, floors.map((f) => f.session)]) };
  }

  /** Switches to a building (or a new shape of it): rebuilds the outside only when its shape changed. */
  private setBuilding(ctx: BuildingCtx): void {
    const prev = this.building;
    // Walks belong to their building: in another one they are over.
    if (prev && prev.id !== ctx.id) this.arrivals.clear();
    this.building = ctx;
    let o = this.walk.outside;
    if (!o || !prev || prev.shape !== ctx.shape) {
      this.dropOutside();
      o = new OutsideView(ctx.plan, ctx.openings, { name: ctx.name, tint: ctx.tint, floors: ctx.floors.map((f) => ({ session: f.session, asleep: f.asleep })) });
      o.lobby.setReceptionist(this.reception.object);
      this.walk.setOutside(o);
      o.setLoaded(this.loaded);
      this.walk.setOffice(this.office, this.loaded === null ? 0 : floorY(this.loaded));
    }
    o.setFloors(ctx.floors.map((f) => f.asleep));
    this.worldCache = null;
  }

  private dropOutside(): void {
    const o = this.walk.outside;
    if (!o) return;
    // The receptionist is not ours to dispose.
    o.lobby.slot.clear();
    this.walk.setOutside(null);
    o.dispose();
  }

  /** Gives floor `storey` of the current building its interior (the one you are on or about to enter). */
  private loadFloor(storey: number, view?: FloorView): void {
    const ctx = this.building;
    const f = ctx?.floors[storey];
    const fv = view ?? (f ? this.store.floorView(f.session) : null);
    if (!ctx || !fv) return;
    const old = this.office;
    this.office = new OfficeView(fv, { shadows: this.shadows, outline: ctx.outline, owner: this.owner });
    this.loaded = storey;
    this.mezzDoor = 0;
    this.fireDoor = 0;
    this.walk.setOffice(this.office, floorY(storey));
    this.walk.outside?.setLoaded(storey);
    old?.dispose();
    this.office.setPlan(this.planOpen);
    this.worldCache = null;
    this.planCam.userData.fit = false;
    this.statusDirty = true;
    this.cameraMoved = true;
  }

  private unloadFloor(): void {
    if (!this.office) return;
    this.office.dispose();
    this.office = null;
    this.loaded = null;
    this.walk.setOffice(null, 0);
    this.walk.outside?.setLoaded(null);
    this.worldCache = null;
    this.statusDirty = true;
  }

  /** The world changed while walking: follow the building (floors moved, added, resized, asleep). */
  private syncWalk(): void {
    const session = this.office?.session ?? null;
    const ctx = session ? this.buildingFor(session) : this.building ? this.buildingById(this.building.id) : null;
    const fv = session ? this.store.floorView(session) : null;
    if (!ctx || (session && !fv)) {
      this.hud.toast(`${session ?? this.building?.name ?? 'That building'} is gone.`);
      void this.leaveFloor();
      return;
    }
    const was = this.loaded;
    this.setBuilding(ctx);
    if (this.office && fv) {
      const storey = ctx.floors.findIndex((f) => f.session === fv.session);
      if (storey !== was && was !== null) {
        // The floor moved in its building: inside it, you move with it.
        if (this.place.area === 'floor') this.walker.place(this.walker.x, this.walker.z, this.walker.yaw, this.walker.pitch, floorY(storey));
        this.loaded = storey;
        this.walk.setOffice(this.office, floorY(storey));
        this.walk.outside?.setLoaded(storey);
      }
      if (!this.office.apply(fv, ctx.outline)) this.rebuildOffice();
    }
    // Anything moved under you (the fire escape changed shape, the room shrank): back to safety.
    if (blocked3(this.walker, RADIUS, this.walkWorldNow())) {
      const L = this.office?.layout;
      if (L && this.loaded !== null) this.walker.place(L.spawn.x, L.spawn.z, L.spawn.yaw, 0, floorY(this.loaded));
      else this.walker.place(ctx.plan.lobby.spawn.x, ctx.plan.lobby.spawn.z, 0, 0, 0);
    }
    this.updatePlace(false, true);
    this.cameraMoved = true;
  }

  private rebuildOffice(): void {
    const ctx = this.building;
    if (!this.office || this.loaded === null || !ctx) return;
    const fv = this.store.floorView(this.office.session);
    if (!fv) return;
    const old = this.office;
    this.office = new OfficeView(fv, { shadows: this.shadows, outline: ctx.outline, owner: this.owner });
    this.walk.setOffice(this.office, floorY(this.loaded));
    old.dispose();
    this.office.setDoor(this.fireDoor);
    this.office.setMezzDoor(this.mezzDoor);
    this.office.setPlan(this.planOpen);
    this.worldCache = null;
    this.planCam.userData.fit = false;
    this.cameraMoved = true;
  }

  /** What the walker touches now (rebuilt when the floor with an interior or its seats change). */
  private walkWorldNow(): WalkWorld {
    const ctx = this.building;
    if (!ctx) return { supports: [], solids: [] };
    const obstacles = this.office?.obstacles() ?? null;
    const key: unknown[] = [ctx.plan, this.loaded, obstacles];
    const c = this.worldCache;
    if (!c || key.some((k, i) => k !== c.key[i])) {
      const loaded = this.loaded !== null && obstacles && this.office ? loadedFloor(this.office.layout, this.loaded, obstacles) : null;
      this.worldCache = { key, world: walkWorld(ctx.plan, loaded) };
    }
    return (this.worldCache as { world: WalkWorld }).world;
  }

  /**
   * Where the walker is now, and what follows from it: a landing gives its
   * floor the interior (its door opens onto it), the lobby needs none;
   * crossing the lobby's front door is what the receptionist hears about.
   */
  private updatePlace(walked: boolean, force = false): void {
    const ctx = this.building;
    if (!ctx) return;
    const prev = this.place;
    const next = placeAt(this.walker, ctx.plan);
    if (next.area === 'fire-escape' && next.storey !== null && next.storey !== this.loaded) this.loadFloor(next.storey);
    if (next.area === 'floor' && next.storey !== null && next.storey !== this.loaded) this.loadFloor(next.storey);
    if (next.area === 'lobby' && this.office) this.unloadFloor();
    if (this.office) this.office.root.visible = next.area === 'floor' || next.area === 'fire-escape';
    if (!force && next.area === prev.area && next.storey === prev.storey) return;
    this.place = next;
    if (walked && prev.area === 'street' && next.area === 'lobby') this.receptionEvent('arrive-street');
    if (walked && prev.area === 'lobby' && next.area === 'street') this.receptionEvent('leave-front');
    if (next.area !== 'floor' && this.planOpen) this.setPlan(false);
    this.hud.setArea(next.area);
    this.refreshTopbar();
    this.updateHint();
    this.panels.refresh();
    this.statusDirty = true;
  }

  /** The session of the floor you are on (inside it), else null. */
  private hereSession(): string | null {
    return this.mode === 'floor' && this.place.area === 'floor' && this.office ? this.office.session : null;
  }

  private receptionEvent(ev: ReceptionEvent): void {
    const ctx = this.building;
    if (!ctx) return;
    this.receptionEvents.push({ ev, at: Date.now(), building: ctx.id });
    this.reception.handle(ev, receptionContext(this.store, ctx.id, new Date()));
  }

  /** Fire-escape door of the floor with an interior: open while you are near it. */
  private animateDoors(dt: number): void {
    const o = this.office;
    const ctx = this.building;
    if (o && ctx && this.loaded !== null) {
      const e = ctx.plan.escape;
      const dz = (e.door.z0 + e.door.z1) / 2;
      const near = Math.abs(this.walker.y - floorY(this.loaded)) < 1 && Math.hypot(this.walker.x, this.walker.z - dz) < 2.4;
      const want = near ? 1 : 0;
      if (this.fireDoor !== want) {
        const k = 1 - Math.exp(-dt * 9);
        this.fireDoor = Math.abs(want - this.fireDoor) < 0.01 ? want : this.fireDoor + (want - this.fireDoor) * k;
        o.setDoor(this.fireDoor);
        this.cameraMoved = true;
      }
      // The corner office's glass door: open while you are at the head of the stair or just inside.
      const m = o.layout.mezzanine;
      const dx = (m.door.x0 + m.door.x1) / 2;
      const up = this.walker.y - floorY(this.loaded);
      const atDoor = up > m.y - 1.2 && up < m.y + 0.5 && Math.hypot(this.walker.x - dx, this.walker.z - m.door.z) < 1.9;
      const mWant = atDoor ? 1 : 0;
      if (this.mezzDoor !== mWant) {
        const k = 1 - Math.exp(-dt * 9);
        this.mezzDoor = Math.abs(mWant - this.mezzDoor) < 0.01 ? mWant : this.mezzDoor + (mWant - this.mezzDoor) * k;
        o.setMezzDoor(this.mezzDoor);
        this.cameraMoved = true;
      }
    }
    if (this.walk.outside?.lobby.update(dt, this.walker)) this.cameraMoved = true;
  }

  /** City camera: frame everything, or one building. */
  focusBuilding(i: number | null, animate = true): void {
    const f = i === null ? this.city.frameAll() : this.city.building(i);
    if (!f) return;
    this.focus = i;
    const dist = (f.radius / Math.sin(THREE.MathUtils.degToRad(this.cityCam.fov) / 2)) * (i === null ? 0.64 : 0.82);
    // From the south-east, low enough to look into the open floors.
    const dir = new THREE.Vector3().setFromSphericalCoords(1, 1.28, 0.5);
    const toPos = f.center.clone().addScaledVector(dir, dist);
    if (!animate) {
      this.controls.target.copy(f.center);
      this.cityCam.position.copy(toPos);
      this.controls.update();
      this.tween = null;
    } else {
      this.tween = { from: [this.controls.target.clone(), this.cityCam.position.clone()], to: [f.center.clone(), toPos], t0: performance.now(), ms: 650 };
    }
    this.activity(true);
  }

  private frameCity(animate: boolean): void {
    this.focusBuilding(null, animate);
  }

  setPlan(open: boolean): void {
    if (this.mode !== 'floor' || !this.office || this.place.area !== 'floor') open = false;
    this.planOpen = open;
    this.office?.setPlan(open);
    this.walk.setPlan(open);
    this.hud.setPlan(open, this.office?.session ?? '');
    if (open) this.walker.release();
    this.planLabelsKey = '';
    this.cameraMoved = true;
    this.updateHint();
    this.activity(true);
  }

  get plan(): boolean {
    return this.planOpen;
  }

  get busy(): boolean {
    return this.transitioning;
  }

  private toggleBattery(): void {
    this.batterySaver = !this.batterySaver;
    this.hud.setBattery(this.batterySaver);
    this.hud.toast(this.batterySaver ? 'Battery saver on: 60 fps moving, 30 fps idle' : 'Battery saver off: 120 fps moving, 60 fps idle', 2200);
  }

  private openBoard(which: string): void {
    this.walker.release();
    this.walker.stop();
    this.panels.close();
    const floor = this.office?.session ?? 'this floor';
    this.hud.sheet(`${which} · ${floor}`, `This overlay arrives in M7. It will list ${which === 'Issues' ? 'the open GitHub issues' : 'the open pull requests'} for ${floor}, so you can read them without walking to the board.`);
  }

  private updateHint(): void {
    this.hintSitting = this.walker.sitting;
    if (this.mode === 'city') {
      this.hud.setHint(this.city.isEmpty ? null : 'Drag to orbit · Scroll to zoom · <strong>Click a floor</strong> to go inside');
      return;
    }
    const area = this.place.area;
    const look = this.walker.locked ? '' : this.walker.lockAvailable ? '<strong>Click</strong> to look around · ' : '';
    if (area === 'lobby') {
      this.hud.setHint(this.walker.locked ? null : `${look}WASD walks · <strong>E</strong> at the desk: the floor directory · <strong>L</strong> elevator · the glass doors lead outside`);
      return;
    }
    if (area === 'street') {
      this.hud.setHint(this.walker.locked ? null : `${look}WASD walks · the glass doors lead into the lobby, the fire escape up the side · <strong>L</strong> elevator`);
      return;
    }
    if (area === 'fire-escape') {
      this.hud.setHint(this.walker.locked ? null : `${look}WASD walks · a floor's door opens as you walk up to it · <strong>L</strong> elevator`);
      return;
    }
    const fv = this.office ? this.store.floorView(this.office.session) : null;
    const asleep = fv?.asleep && !fv.transition ? 'This floor is asleep: the elevator (<strong>L</strong>) wakes it · ' : '';
    if (this.walker.sitting && !this.planOpen) this.hud.setHint(this.walker.locked ? 'At your desk · <strong>WASD</strong> gets up' : `At your desk · ${look}<strong>WASD</strong> or <strong>Esc</strong> gets up`);
    else if (this.planOpen) this.hud.setHint('<strong>Click</strong> the floor to walk there · WASD walks · <strong>L</strong> elevator · <strong>Tab</strong> back to first person');
    else if (this.walker.locked) this.hud.setHint(null);
    else if (asleep) this.hud.setHint(`${asleep}<strong>Click</strong> to look around · WASD walks · <strong>← →</strong> turn`);
    else if (!this.walker.lockAvailable) this.hud.setHint('WASD walks · <strong>← →</strong> turn · <strong>L</strong> elevator · <strong>Tab</strong> floor plan (mouse look is unavailable here)');
    else this.hud.setHint('<strong>Click</strong> to look around · WASD walks · <strong>← →</strong> turn · <strong>L</strong> elevator · <strong>Tab</strong> floor plan · Esc releases the mouse');
  }

  // ---- input -------------------------------------------------------------------

  private bindInput(): void {
    const canvas = this.r.domElement;
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => this.onVisibility());
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    canvas.addEventListener('pointerdown', (e) => (this.down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointermove', (e) => {
      if (this.mode === 'city' && !this.down) this.city.setHover(this.cityPick(e));
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
      this.onClick(e);
    });
    canvas.addEventListener('wheel', () => this.activity(true), { passive: true });
    this.hud.planElement.addEventListener('click', (e) => this.onPlanClick(e));
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    // A release always reaches the walker, whatever the view, focus or open
    // sheet: a key let go anywhere else must not stay held.
    if (!down) {
      if (this.walker.key(e, false) && this.mode === 'floor') e.preventDefault();
      return;
    }
    // Open dialogs (sheet, panels, confirmations, hire / send home) handle their own keys.
    if (this.hud.sheetOpen || this.panels.open || this.dialogOpen) return;
    // M5 screen: at a worker's laptop every key goes to its terminal (Esc gets you up).
    if (this.laptops.key(e)) return;
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (typing) return;
    this.activity(true);
    if (this.mode === 'floor' && this.walker.key(e, true)) {
      e.preventDefault();
      return;
    }
    if (e.code === 'Tab' && this.mode === 'floor') {
      // From the scene: Tab toggles the plan, Shift+Tab moves focus into the
      // top bar (City, Issues, PRs, …). From a focused HUD control, or with
      // another modifier, Tab moves focus as usual.
      if (e.altKey || e.ctrlKey || e.metaKey || !this.sceneFocused()) return;
      e.preventDefault();
      if (!e.shiftKey && this.place.area !== 'floor') this.hud.toast('The floor plan is for office floors.', 1800);
      else if (!e.shiftKey) this.setPlan(!this.planOpen);
      else {
        this.walker.release();
        this.hud.focusTopbar();
      }
    } else if (e.code === 'KeyE' && this.mode === 'floor' && !e.metaKey && !e.ctrlKey && !this.planOpen && this.target?.kind === 'prop' && this.target.id === 'elevator') {
      e.preventDefault();
      this.openElevator();
    } else if (e.code === 'KeyE' && this.mode === 'floor' && !e.metaKey && !e.ctrlKey && !this.planOpen && this.target?.kind === 'own-desk') {
      e.preventDefault();
      this.sit();
    } else if (e.code === 'Escape' && this.mode === 'floor' && this.walker.sitting) {
      this.standUp();
    } else if (e.code === 'KeyE' && this.mode === 'floor' && !e.metaKey && !e.ctrlKey && this.target?.kind === 'prop' && this.target.id === 'reception') {
      // The receptionist answers, and the elevator panel is the building's floor directory.
      e.preventDefault();
      this.receptionEvent('interact');
      this.openElevator();
    } else if (e.code === 'KeyE' && this.mode === 'floor' && !e.metaKey && !e.ctrlKey && !this.planOpen && this.target?.kind === 'desk') {
      // M4: E on an empty desk's "+" hires someone there.
      e.preventDefault();
      this.openHire(this.target.desk);
    } else if (e.code === 'KeyE' && this.mode === 'floor' && !e.metaKey && !e.ctrlKey && !this.planOpen && this.target?.kind === 'worker') {
      // M5: E looking at a worker: sit at its laptop.
      e.preventDefault();
      this.sitAt(this.target.id);
    } else if (e.code === 'KeyX' && this.mode === 'floor' && !e.metaKey && !e.ctrlKey && !e.altKey && !this.planOpen && this.target?.kind === 'worker') {
      // M4: X looking at a worker: send it home.
      e.preventDefault();
      this.openSendHome(this.target.id);
    } else if (e.code === 'KeyL' && this.mode === 'floor' && !this.transitioning && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // The elevator from anywhere on the floor (the top bar has it too).
      e.preventDefault();
      this.openElevator();
    } else if (e.code === 'KeyM' && this.mode === 'city' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.openBuildings();
    } else if (e.code === 'KeyB' && !e.metaKey && !e.ctrlKey) {
      this.toggleBattery();
    } else if (e.code === 'Backspace' && this.mode === 'floor') {
      e.preventDefault();
      void this.leaveFloor();
    } else if (e.code === 'Escape' && this.mode === 'floor' && this.planOpen) {
      this.setPlan(false);
    } else if (e.code === 'Escape' && this.mode === 'city' && this.focus !== null) {
      this.focusBuilding(null);
    }
  }

  /** Nothing but the scene has keyboard focus (no HUD control). */
  private sceneFocused(): boolean {
    const a = document.activeElement;
    return !a || a === document.body || a === this.r.domElement;
  }

  private cityRayFloor(e: { clientX: number; clientY: number }): string | null {
    const rect = this.r.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.cityCam);
    return this.city.pickFloor(rc.ray.origin, rc.ray.direction);
  }

  /** Floor under the pointer in the city: its badge, else the floor itself. */
  private cityPick(e: { clientX: number; clientY: number }): string | null {
    const rect = this.r.domElement.getBoundingClientRect();
    return this.city.pickBadge(this.cityCam, e.clientX - rect.left, e.clientY - rect.top, this.vp) ?? this.cityRayFloor(e);
  }

  private onClick(e: PointerEvent): void {
    if (this.mode === 'city') {
      const rect = this.r.domElement.getBoundingClientRect();
      const badge = this.city.pickBadge(this.cityCam, e.clientX - rect.left, e.clientY - rect.top, this.vp);
      if (badge) {
        void this.enterFloor(badge);
        return;
      }
      const s = this.cityRayFloor(e);
      if (!s) return;
      const b = this.city.buildingOf(s);
      // First click on a building: focus it and open its elevator panel; on
      // the focused building, a click on a floor goes straight inside.
      if (b !== null && this.focus !== b) {
        this.focusBuilding(b);
        const id = this.city.buildingId(b);
        if (id !== undefined) this.openElevator(id);
      } else void this.enterFloor(s);
      return;
    }
    // M5 screen: seated, a click keeps the keyboard on the laptop (no mouse look).
    if (this.laptops.seated) return this.seatBar.focus();
    if (!this.planOpen) this.walker.requestLock();
  }

  private onPlanClick(e: MouseEvent): void {
    if (!this.office || (e.target as HTMLElement).closest('.plan-card')) return;
    const rect = this.r.domElement.getBoundingClientRect();
    const p = new THREE.Vector3(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1, 0).unproject(this.planCam);
    const L = this.office.layout;
    const fy = floorY(this.loaded ?? 0);
    if (p.x < 0 || p.z < 0 || p.x > L.width || p.z > L.depth || blocked({ x: p.x, z: p.z }, 0.28, this.office.obstacles()) || blocked3({ x: p.x, y: fy, z: p.z }, RADIUS, this.walkWorldNow())) {
      this.hud.toast('Something is in the way there.', 1600);
      return;
    }
    // Face the clicked point's nearest desk row: keep it simple, face north.
    this.walker.place(p.x, p.z, this.walker.yaw, this.walker.pitch, fy);
    this.cameraMoved = true;
    this.activity(true);
  }

  private onVisibility(): void {
    if (document.hidden) {
      void this.r.setAnimationLoop(null);
      this.walker.release();
      this.walker.stop();
    } else {
      this.resume();
    }
  }

  private activity(camera: boolean): void {
    this.lastActivity = performance.now();
    if (camera) this.cameraMoved = true;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.vp.width = w;
    this.vp.height = h;
    this.r.setSize(w, h);
    this.cityCam.aspect = this.fpCam.aspect = w / h;
    this.cityCam.updateProjectionMatrix();
    this.fpCam.updateProjectionMatrix();
    this.planCam.userData.fit = false;
    this.cameraMoved = true;
  }

  // ---- frame -------------------------------------------------------------------

  /** Animation-loop callback: frame pacing, then update + render. */
  tick(now: number): void {
    const active = this.walker.moving || this.tween !== null || this.transitioning || this.arrivals.count > 0;
    const hz = targetHz({ hidden: document.hidden, batterySaver: this.batterySaver, sinceActivity: active ? 0 : now - this.lastActivity });
    if (!shouldRender(now, this.lastRender, hz)) return;
    const dt = Math.min(0.1, this.lastRender === -Infinity ? 1 / 60 : (now - this.lastRender) / 1000);
    this.lastRender = now;
    this.step(dt, now / 1000);
    this.render();
  }

  /** One update at `dt` seconds of game time `t`. Also used by the benchmark. */
  step(dt: number, t: number): void {
    this.lastT = t;
    if (this.mode === 'floor' && this.building) {
      if (this.walker.step(dt, this.walkWorldNow())) {
        this.cameraMoved = true;
        this.updatePlace(true);
      }
      // Sat down or got up (walking, Esc, a teleport): the hint follows.
      if (this.hintSitting !== this.walker.sitting) this.updateHint();
      // Up on the mezzanine (or near the top of its stair): look-at reaches down over the floor, cards read as nearer.
      this.office?.setOverlook(this.overlooking);
      this.animateDoors(dt);
      const area = this.place.area;
      this.walk.setDim(!!this.office?.isAsleep && (area === 'floor' || area === 'fire-escape'));
      this.walker.applyTo(this.fpCam, this.walk.base);
      this.stepArrivals(t);
      const moved = this.cameraMoved;
      if (this.planOpen) this.fitPlan();
      if (this.office?.root.visible) this.office.frame(t, this.planOpen ? this.planCam : this.fpCam, this.fpCam, this.vp, moved);
      // The receptionist looks at you and places the bubble while the lobby can be seen (hud.css hides it elsewhere).
      if (area === 'lobby' || area === 'street') this.reception.update(dt, this.fpCam);
      this.audio.setListener(this.fpCam);
      this.updateLookAt();
      if (this.planOpen && (moved || this.planDirty)) this.layoutPlanLabels();
    } else {
      if (this.tween) {
        const k = Math.min(1, (performance.now() - this.tween.t0) / this.tween.ms);
        const e = 1 - (1 - k) ** 3;
        this.controls.target.lerpVectors(this.tween.from[0], this.tween.to[0], e);
        this.cityCam.position.lerpVectors(this.tween.from[1], this.tween.to[1], e);
        if (k >= 1) this.tween = null;
        this.cameraMoved = true;
      }
      this.controls.update();
      this.city.frame(t, this.cityCam);
    }
    // M5 screen: live laptop screens, and the camera at the laptop you sit at.
    const onFloor = this.mode === 'floor' && (this.place.area === 'floor' || this.place.area === 'fire-escape');
    const blocked = this.planOpen || this.panels.open || this.dialogOpen || this.hud.sheetOpen || this.transitioning;
    this.laptops.frame({ now: performance.now(), office: this.office, onFloor, camera: this.fpCam, walker: this.walker, blocked });
    if (this.laptops.animating) this.activity(true);
    this.cameraMoved = false;
  }

  /** Walkers in and out, and what their desks show meanwhile. */
  private stepArrivals(t: number): void {
    this.arrivals.group.position.y = -this.walk.base;
    const o = this.office;
    for (const d of this.arrivals.update(performance.now() / 1000, t)) if (o?.session === d.session) o.setAway(d.desk, d.away);
    this.applyReserve();
  }

  render(): void {
    if (this.mode === 'floor') this.r.render(this.walk.scene, this.planOpen ? this.planCam : this.fpCam);
    else this.r.render(this.city.scene, this.cityCam);
    this.frames++;
    if (this.statusDirty) {
      this.statusDirty = false;
      const at = Date.now();
      const applied = this.mode === 'floor' && this.office ? this.office.applied : this.city.applied;
      for (const [id, status] of applied) {
        const prev = this.rendered.get(id);
        if (!prev || prev.status !== status) this.rendered.set(id, { status, at });
      }
    }
  }

  private fitPlan(): void {
    if (!this.office || this.planCam.userData.fit) return;
    const L = this.office.layout;
    const aspect = this.vp.width / this.vp.height;
    const pad = 1.6;
    // Leave room for the top bar and the plan card on the left.
    let halfH = L.depth / 2 + pad;
    let halfW = halfH * aspect;
    if (halfW < L.width / 2 + pad) {
      halfW = L.width / 2 + pad;
      halfH = halfW / aspect;
    }
    const cx = L.width / 2 - halfW * 0.12;
    Object.assign(this.planCam, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
    this.planCam.position.set(cx, 30, L.depth / 2 - halfH * 0.06);
    this.planCam.up.set(0, 0, -1);
    this.planCam.lookAt(cx, 0, L.depth / 2 - halfH * 0.06);
    this.planCam.updateProjectionMatrix();
    this.planCam.updateMatrixWorld();
    this.planCam.userData.fit = true;
  }

  private layoutPlanLabels(): void {
    const o = this.office;
    if (!o) return;
    this.planDirty = false;
    const toScreen = (x: number, y: number, z: number) => {
      const v = new THREE.Vector3(x, y, z).project(this.planCam);
      return { x: ((v.x + 1) / 2) * this.vp.width, y: ((1 - v.y) / 2) * this.vp.height };
    };
    const labels: PlanLabel[] = [];
    for (const p of o.layout.props) {
      const c = toScreen((p.box.min[0] + p.box.max[0]) / 2, 0, (p.box.min[2] + p.box.max[2]) / 2);
      labels.push({ ...c, text: p.label, kind: 'prop' });
    }
    o.layout.slots.forEach((s, i) => {
      const v = o.seat(i);
      if (v) labels.push({ ...toScreen(s.seat.x, 1.2, s.seat.z), text: v.name, kind: 'worker', display: v.display });
      else labels.push({ ...toScreen(s.desk.x, 0.8, s.desk.z), text: `+ ${i + 1}`, kind: 'desk' });
    });
    // #20: the corner office on its mezzanine, its stair, your desk.
    const m = o.layout.mezzanine;
    labels.push({ ...toScreen((m.rect.x0 + m.rect.x1) / 2 + 1.2, m.y, m.rect.z1 - 0.8), text: 'Corner office (mezzanine)', kind: 'prop' });
    labels.push({ ...toScreen((m.stair.x0 + m.stair.x1) / 2, 1.5, (m.stair.top + m.stair.bottom) / 2), text: 'Stair', kind: 'prop' });
    labels.push({ ...toScreen(m.desk.desk.x, m.y + 0.8, m.desk.desk.z - 1.2), text: 'Your desk', kind: 'prop' });
    const me = toScreen(this.walker.x, 0, this.walker.z);
    // Everything the labels show, so a status or seat change redraws them too.
    const key = JSON.stringify([labels.map((l) => [l.kind, l.text, l.display ?? '', l.x | 0, l.y | 0]), me.x | 0, me.y | 0, this.walker.yaw.toFixed(2)]);
    if (key === this.planLabelsKey) return;
    this.planLabelsKey = key;
    this.hud.setPlanLabels(labels, { ...me, angle: -this.walker.yaw });
  }

  private updateLookAt(): void {
    const t = this.computeLookAt();
    this.target = t;
    const w = t?.kind === 'worker' ? this.store.workerView(t.id) : null;
    // M5 screen: E sits at the worker's laptop, or says why it cannot.
    const why = w ? this.laptops.whyNot(w.worker.id, this.office) : null;
    this.hud.setKeyState('E', w ? (why ? { live: false, why } : { live: true }) : null);
    // The plan has its own labels; the prompt bar belongs to first person.
    this.hud.setTarget(this.planOpen ? null : t, w);
  }

  private computeLookAt(): Target | null {
    this.fpCam.getWorldDirection(this.ray);
    const o = this.fpCam.position;
    const area = this.place.area;
    if (area === 'floor' && this.office) {
      // Your desk only from inside your office, standing (E sits you down).
      return this.office.pick([o.x, o.y, o.z], [this.ray.x, this.ray.y, this.ray.z], this.overlooking ? overlookReach(this.office.layout) : REACH, this.inOffice() && !this.walker.sitting);
    }
    const lobby = this.walk.outside?.lobby;
    if (area === 'lobby' && lobby) {
      const t = lobby.pick([o.x, o.y + this.walk.base, o.z], [this.ray.x, this.ray.y, this.ray.z], REACH);
      return t ? LOBBY_TARGETS[t] : null;
    }
    return null;
  }

  // ---- test hooks --------------------------------------------------------------

  /** Applies a protocol event as if the bridge had sent it. */
  inject(e: WorldEvent): void {
    this.onWorldEvent(e);
  }

  lookAt(): LookAt | null {
    if (this.mode !== 'floor') return null;
    this.walker.applyTo(this.fpCam, this.walk.base);
    const t = this.computeLookAt();
    if (!t) return null;
    const out: LookAt = { kind: t.kind, id: t.id, label: t.label };
    if (t.kind === 'worker' || t.kind === 'own-desk') out.name = t.name;
    return out;
  }

  // ---- the corner office (#20) -------------------------------------------------------

  /** Up on the mezzanine or high on its stair: look-at reaches the whole floor, cards read as nearer. */
  get overlooking(): boolean {
    return this.mode === 'floor' && this.place.area === 'floor' && this.loaded !== null && !!this.office && this.walker.y - floorY(this.loaded) > 1.5;
  }

  /** Inside the glass office on the mezzanine. */
  private inOffice(): boolean {
    const o = this.office;
    if (!o || this.loaded === null || this.place.area !== 'floor') return false;
    const m = o.layout.mezzanine;
    const w = this.walker;
    return w.y - floorY(this.loaded) > m.y - 0.1 && w.x > m.rect.x0 && w.x < m.rect.x1 && w.z > m.rect.z0 && w.z < m.rect.z1;
  }

  get seated(): boolean {
    return this.walker.sitting;
  }

  /** Sits you at your desk, facing the floor over the glass; false when you are not in your office. */
  sit(): boolean {
    const o = this.office;
    if (!o || this.loaded === null || !this.inOffice()) return false;
    const m = o.layout.mezzanine;
    this.walker.place(m.sit.x, m.sit.z, m.sit.yaw, m.sit.pitch, floorY(this.loaded) + m.y);
    this.walker.sit();
    this.cameraMoved = true;
    this.statusDirty = true;
    this.updateHint();
    this.activity(true);
    return true;
  }

  standUp(): void {
    if (!this.walker.sitting) return;
    this.walker.stand();
    this.updateHint();
    this.activity(true);
  }

  // ---- M5 screen: sitting at a worker's laptop ----------------------------------------

  /** E on a worker: sits you at its laptop; false (and a toast saying why) when you cannot. */
  sitAt(id: string): boolean {
    if (this.mode !== 'floor' || this.place.area !== 'floor' || this.transitioning) return false;
    const why = this.laptops.whyNot(id, this.office);
    if (why) {
      this.hud.toast(why, 3000);
      return false;
    }
    this.walker.release();
    this.walker.stop();
    this.walker.stand();
    this.laptops.sit(id, this.office, this.fpCam, this.walker);
    this.activity(true);
    return true;
  }

  /** Places the walker: `y` (feet, absolute) puts you on any floor, the fire escape, the street or in the lobby; without it you stay at your level. */
  setPose(p: Pose): void {
    let y = p.y;
    if (y === undefined) y = this.building ? (groundAt(this.walkWorldNow().supports, p.x, p.z, this.walker.y + 0.05) ?? this.walker.y) : this.walker.y;
    const ctx = this.building;
    if (ctx) {
      // Onto another floor: it gets the interior first, so its walls and desks are there.
      const next = placeAt({ x: p.x, y, z: p.z }, ctx.plan);
      if ((next.area === 'floor' || next.area === 'fire-escape') && next.storey !== null && next.storey !== this.loaded) this.loadFloor(next.storey);
    }
    this.walker.place(p.x, p.z, p.yaw, p.pitch ?? 0, y);
    this.updatePlace(false);
    this.walker.applyTo(this.fpCam, this.walk.base);
    this.cameraMoved = true;
    this.activity(true);
  }

  pose(): Pose & { eye: number; y: number; area: Area; storey: number | null; floor: string | null; seated: boolean } {
    const s = this.place.storey;
    return {
      x: this.walker.x,
      z: this.walker.z,
      yaw: this.walker.yaw,
      pitch: this.walker.pitch,
      eye: EYE_HEIGHT,
      y: this.walker.y,
      area: this.place.area,
      storey: s,
      floor: s !== null ? (this.building?.floors[s]?.session ?? null) : null,
      seated: this.walker.sitting,
    };
  }

  /** The building you walk around in (test hook). */
  get where(): { building: string | null; name: string; floors: string[]; loaded: string | null } | null {
    const b = this.building;
    return this.mode === 'floor' && b ? { building: b.id, name: b.name, floors: b.floors.map((f) => f.session), loaded: this.office?.session ?? null } : null;
  }

  /** The layout of a floor as walked: in its building's outline. */
  layoutOf(session: string): OfficeView['layout'] | null {
    const f = this.store.floorView(session);
    const ctx = f ? this.buildingFor(session) : null;
    return f ? floorLayoutIn(f.desks, ctx?.outline) : null;
  }

  /** The building plan you walk around in (test hook: the fire escape, the lobby, the street). */
  get plan3(): BuildingPlan | null {
    return this.mode === 'floor' ? (this.building?.plan ?? null) : null;
  }

  get cameraCity(): THREE.PerspectiveCamera {
    return this.cityCam;
  }

  get orbit(): OrbitControls {
    return this.controls;
  }

  get time(): number {
    return this.lastT;
  }

  /** Screen point (CSS px) of a floor itself in the city view (to click its building). */
  floorPoint(session: string): { x: number; y: number } | null {
    return this.mode === 'city' ? this.city.floorPoint(this.cityCam, session, this.vp) : null;
  }

  /** Lights of the office on screen: off on an asleep floor. */
  get officeAsleep(): boolean | null {
    return this.office?.isAsleep ?? null;
  }

  /** Screen point (CSS px) of a floor's badge in the city view. */
  badgePoint(session: string): { x: number; y: number } | null {
    return this.mode === 'city' ? this.city.badgePoint(this.cityCam, session, this.vp) : null;
  }
}

const LOBBY_TARGETS: Record<'reception' | 'elevator', Target> = {
  reception: { kind: 'prop', id: 'reception', label: 'Reception', milestone: 'M3b' },
  elevator: { kind: 'prop', id: 'elevator', label: 'Elevator', milestone: 'M3' },
};

function zero(): Counts {
  return { working: 0, needsYou: 0, idle: 0, done: 0, total: 0 };
}

function safeSession(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function reducedMotionTest(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
