import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BridgeClient, type ConnState, type SocketLike } from './net/client';
import { bridgeUrl, takeToken } from './net/endpoint';
import type { WorldEvent } from './net/protocol';
import { CityView } from './render/city';
import { shouldRender, targetHz } from './render/framePolicy';
import { OfficeView, REACH, type Target } from './render/office';
import { Hud, type PlanLabel } from './ui/hud';
import { Walker } from './input/walk';
import { blocked } from './world/collide';
import { EYE_HEIGHT } from './world/layout';
import type { Display } from './world/derive';
import { WorldStore, type Change, type Counts } from './world/store';

export interface AppOptions {
  renderer: THREE.WebGPURenderer;
  host: HTMLElement;
  params: URLSearchParams;
}

export interface LookAt {
  kind: Target['kind'];
  id: string;
  name?: string;
  label?: string;
}

export interface Pose {
  x: number;
  z: number;
  yaw: number;
  pitch?: number;
}

type Mode = 'city' | 'floor';

const CLIENT = 'herdr-3d-game/0.2';

/** Everything between the renderer and the bridge: views, input, HUD, frame pacing. */
export class App {
  readonly store = new WorldStore();
  readonly hud: Hud;
  readonly city: CityView;
  readonly client: BridgeClient;
  mode: Mode = 'city';
  office: OfficeView | null = null;
  /** Worker id → status on screen as of the last rendered frame, and when it got there. */
  readonly rendered = new Map<string, { status: Display; at: number }>();
  frames = 0;
  batterySaver = false;
  conn: ConnState = { phase: 'stopped' };
  readonly url: string;

  private readonly r: THREE.WebGPURenderer;
  private readonly cityCam: THREE.PerspectiveCamera;
  private readonly fpCam: THREE.PerspectiveCamera;
  private readonly planCam: THREE.OrthographicCamera;
  private readonly controls: OrbitControls;
  private readonly walker: Walker;
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
    this.batterySaver = o.params.get('battery') === '1';
    this.hud = new Hud(o.host);
    this.hud.setBattery(this.batterySaver);
    this.city = new CityView(this.hud.floorList, this.shadows, (s) => void this.enterFloor(s));
    this.city.badges = o.params.get('badges') !== '0';

    this.cityCam = new THREE.PerspectiveCamera(42, 1, 0.1, 600);
    this.fpCam = new THREE.PerspectiveCamera(70, 1, 0.05, 200);
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
        onEvent: (e) => this.applyChange(this.store.applyEvent(e)),
        onState: (s) => {
          this.conn = s;
          this.hud.setConn(s, this.fixture, Date.now());
          this.updateNotice();
        },
      },
    });

    this.hud.on('city', () => void this.leaveFloor());
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
      if (this.mode === 'floor' && this.office) {
        const fv = this.store.floorView(this.office.session);
        if (!fv) {
          this.hud.toast(`${this.office.session} is gone.`);
          void this.leaveFloor();
        } else if (!this.office.apply(fv)) {
          this.rebuildOffice();
        }
      }
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
  }

  private refreshTopbar(): void {
    if (this.mode === 'floor' && this.office) {
      const fv = this.store.floorView(this.office.session);
      if (fv) this.hud.setFloor(fv);
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
      this.office?.dispose();
      this.office = new OfficeView(fv, { shadows: this.shadows });
      this.mode = 'floor';
      this.hud.setMode('floor');
      this.city.setVisible(false);
      const L = this.office.layout;
      const p = opts.pose ?? { x: L.spawn.x, z: L.spawn.z, yaw: L.spawn.yaw, pitch: -0.05 };
      this.walker.place(p.x, p.z, p.yaw, p.pitch ?? 0);
      this.planCam.userData.fit = false;
      this.setPlan(false);
      this.refreshTopbar();
      this.statusDirty = true;
      this.cameraMoved = true;
      this.updateHint();
    };
    this.transitioning = true;
    try {
      if (opts.transition === false || reducedMotionTest()) swap();
      else await this.hud.doorsTransition(fv.level ? `${fv.level.number}` : fv.session, swap);
    } finally {
      this.transitioning = false;
      this.activity(true);
    }
  }

  async leaveFloor(): Promise<void> {
    if (this.mode !== 'floor' || this.transitioning) return;
    const session = this.office?.session ?? null;
    const swap = () => {
      this.walker.release();
      this.office?.dispose();
      this.office = null;
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
    this.transitioning = true;
    try {
      if (reducedMotionTest()) swap();
      else await this.hud.doorsTransition('CITY', swap);
    } finally {
      this.transitioning = false;
      this.activity(true);
    }
  }

  private rebuildOffice(): void {
    if (!this.office) return;
    const fv = this.store.floorView(this.office.session);
    if (!fv) return;
    const pose = { x: this.walker.x, z: this.walker.z, yaw: this.walker.yaw, pitch: this.walker.pitch };
    this.office.dispose();
    this.office = new OfficeView(fv, { shadows: this.shadows });
    const L = this.office.layout;
    if (blocked(pose, 0.28, this.office.obstacles()) || pose.x > L.width || pose.z > L.depth) {
      this.walker.place(L.spawn.x, L.spawn.z, L.spawn.yaw);
    }
    this.office.setPlan(this.planOpen);
    this.planCam.userData.fit = false;
    this.cameraMoved = true;
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
    if (this.mode !== 'floor' || !this.office) open = false;
    this.planOpen = open;
    this.office?.setPlan(open);
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
    const floor = this.office?.session ?? 'this floor';
    this.hud.sheet(`${which} · ${floor}`, `This overlay arrives in M7. It will list ${which === 'Issues' ? 'the open GitHub issues' : 'the open pull requests'} for ${floor}, so you can read them without walking to the board.`);
  }

  private updateHint(): void {
    if (this.mode === 'city') {
      this.hud.setHint(this.city.isEmpty ? null : 'Drag to orbit · Scroll to zoom · <strong>Click a floor</strong> to go inside');
      return;
    }
    if (this.planOpen) this.hud.setHint('<strong>Click</strong> the floor to walk there · WASD walks · <strong>Tab</strong> back to first person');
    else if (this.walker.locked) this.hud.setHint(null);
    else if (!this.walker.lockAvailable) this.hud.setHint('WASD walks · Shift runs · <strong>Tab</strong> floor plan (mouse look is unavailable here)');
    else this.hud.setHint('<strong>Click</strong> to look around · WASD walks · Shift runs · <strong>Tab</strong> floor plan · Esc releases the mouse');
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
    if (this.hud.sheetOpen) return;
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (typing) return;
    this.activity(true);
    if (this.mode === 'floor' && this.walker.key(e, down)) {
      e.preventDefault();
      return;
    }
    if (!down) return;
    if (e.code === 'Tab' && this.mode === 'floor') {
      e.preventDefault();
      this.setPlan(!this.planOpen);
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
      if (b !== null && this.focus !== b) this.focusBuilding(b);
      else void this.enterFloor(s);
      return;
    }
    if (!this.planOpen) this.walker.requestLock();
  }

  private onPlanClick(e: MouseEvent): void {
    if (!this.office || (e.target as HTMLElement).closest('.plan-card')) return;
    const rect = this.r.domElement.getBoundingClientRect();
    const p = new THREE.Vector3(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1, 0).unproject(this.planCam);
    const L = this.office.layout;
    if (p.x < 0 || p.z < 0 || p.x > L.width || p.z > L.depth || blocked({ x: p.x, z: p.z }, 0.28, this.office.obstacles())) {
      this.hud.toast('Something is in the way there.', 1600);
      return;
    }
    // Face the clicked point's nearest desk row: keep it simple, face north.
    this.walker.place(p.x, p.z, this.walker.yaw, this.walker.pitch);
    this.cameraMoved = true;
    this.activity(true);
  }

  private onVisibility(): void {
    if (document.hidden) {
      void this.r.setAnimationLoop(null);
      this.walker.release();
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
    const active = this.walker.moving || this.tween !== null || this.transitioning;
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
    if (this.mode === 'floor' && this.office) {
      if (this.walker.step(dt, this.office.obstacles())) this.cameraMoved = true;
      this.walker.applyTo(this.fpCam);
      const moved = this.cameraMoved;
      if (this.planOpen) this.fitPlan();
      this.office.frame(t, this.planOpen ? this.planCam : this.fpCam, this.fpCam, this.vp, moved);
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
    this.cameraMoved = false;
  }

  render(): void {
    if (this.mode === 'floor' && this.office) this.r.render(this.office.scene, this.planOpen ? this.planCam : this.fpCam);
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
    // The plan has its own labels; the prompt bar belongs to first person.
    this.hud.setTarget(this.planOpen ? null : t, w);
  }

  private computeLookAt(): Target | null {
    if (!this.office) return null;
    this.fpCam.getWorldDirection(this.ray);
    const o = this.fpCam.position;
    return this.office.pick([o.x, o.y, o.z], [this.ray.x, this.ray.y, this.ray.z], REACH);
  }

  // ---- test hooks --------------------------------------------------------------

  /** Applies a protocol event as if the bridge had sent it. */
  inject(e: WorldEvent): void {
    this.applyChange(this.store.applyEvent(e));
  }

  lookAt(): LookAt | null {
    if (this.mode !== 'floor') return null;
    this.walker.applyTo(this.fpCam);
    const t = this.computeLookAt();
    if (!t) return null;
    const out: LookAt = { kind: t.kind, id: t.id, label: t.label };
    if (t.kind === 'worker') out.name = t.name;
    return out;
  }

  setPose(p: Pose): void {
    this.walker.place(p.x, p.z, p.yaw, p.pitch ?? 0);
    this.walker.applyTo(this.fpCam);
    this.cameraMoved = true;
    this.activity(true);
  }

  pose(): Pose & { eye: number } {
    return { x: this.walker.x, z: this.walker.z, yaw: this.walker.yaw, pitch: this.walker.pitch, eye: EYE_HEIGHT };
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

  /** Screen point (CSS px) of a floor's badge in the city view. */
  badgePoint(session: string): { x: number; y: number } | null {
    return this.mode === 'city' ? this.city.badgePoint(this.cityCam, session, this.vp) : null;
  }
}

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
