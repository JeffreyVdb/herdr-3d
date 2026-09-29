import * as THREE from 'three/webgpu';
import type { CommandResult } from '../net/client';
import type { CommandArgs, CommandName, ConnMessage, KeyItem } from '../net/protocol';
import { screenFrame } from '../render/desks';
import type { OfficeView } from '../render/office';
import { ScreenMeshes } from '../render/screens';
import { failureText } from '../ui/messages';
import type { WorldStore } from '../world/store';
import { DEFAULT_SCREENS, screensParam, WatchPlanner, type Candidate, type ScreenConfig } from '../world/screens';
import { InputQueue, seatedKey, textItems } from './keys';
import { LaptopTerminal, LIVE_SIZE } from './terminal';
import { Watches } from './watches';

export { screensParam };

/** What a laptop shows (test hook): live (watched, painted), pending (watched, no frame yet), frozen, glow, dark (asleep). */
export type ScreenState = 'live' | 'pending' | 'frozen' | 'glow' | 'dark';

export interface LaptopHost {
  store: WorldStore;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** The watches the game makes by itself (kept out of the log of what you did). */
  watch<T extends 'terminal.watch' | 'terminal.unwatch'>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  unsupported(t: CommandName): boolean;
  toast(msg: string, kind: 'info' | 'error'): void;
  /** The seat bar (ui/seat.ts). */
  seat: SeatView;
  /** CSS px the HUD covers at the top (the top bar) and the bottom (the seat bar): the laptop goes between. */
  insets(): { top: number; bottom: number };
}

/** The HUD while you sit at a laptop. */
export interface SeatView {
  show(name: string, mac: boolean): void;
  hide(): void;
  status(kind: 'ok' | 'busy' | 'error' | 'offline', text: string | null): void;
  focus(): void;
}

/** Where the game is this frame (what the controller needs to plan and to keep you seated). */
export interface LaptopFrame {
  now: number;
  office: OfficeView | null;
  /** On the floor of `office` (not in the lobby, on the stairs, in the plan…). */
  onFloor: boolean;
  camera: THREE.PerspectiveCamera;
  /** The walker's feet and yaw: a teleport while seated stands you up. */
  walker: { x: number; y: number; z: number; yaw: number };
  /** A panel, dialog or the plan is open (you get up for it). */
  blocked: boolean;
}

interface Seat {
  id: string;
  desk: number;
  office: OfficeView;
  name: string;
  walker: { x: number; y: number; z: number; yaw: number };
  t0: number;
  from: { pos: THREE.Vector3; quat: THREE.Quaternion } | null;
  to: { pos: THREE.Vector3; quat: THREE.Quaternion };
  /** The view the pose was fitted to (a resize fits it again). */
  view: string;
}

/** Sitting down and getting up glide the camera this long (ms); with reduced motion it cuts. */
const GLIDE_MS = 520;
const glideMs = () => (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : GLIDE_MS);
/** How often the planner runs (ms). */
const PLAN_MS = 250;

const SCREEN = screenFrame();
const viewKey = (cam: THREE.PerspectiveCamera) => `${cam.aspect.toFixed(4)}:${window.innerHeight}`;
const smooth = (k: number) => k * k * (3 - 2 * k);

function isMac(): boolean {
  const n = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  const p = n?.userAgentData?.platform ?? n?.platform ?? '';
  return /mac|iphone|ipad/i.test(p);
}

/**
 * M5: laptop screens and sitting at a worker's laptop. Plans which laptops
 * are live (`world/screens.ts`), keeps the bridge's watches in step
 * (`watches.ts`), feeds frames to an xterm per live screen (`terminal.ts`)
 * and puts them on the desks (`render/screens.ts`). Sitting (E on a worker)
 * glides the camera to its laptop, which it watches at a higher fps, and
 * sends what you type (`keys.ts`) until you stand up: Esc, a teleport, the
 * elevator, another floor, a panel, the worker leaving or its floor going to
 * sleep. Standing up ends the seated watch at once.
 */
export class Laptops {
  readonly cfg: ScreenConfig;
  readonly planner: WatchPlanner;
  readonly watches: Watches;
  readonly mac = isMac();
  private readonly terms = new Map<string, LaptopTerminal>();
  private readonly pool: LaptopTerminal[] = [];
  private meshes: ScreenMeshes | null = null;
  private attached: OfficeView | null = null;
  /** Worker id → desk on the attached floor, as last planned. */
  private desks = new Map<string, number>();
  /** Worker id → the desk its live screen is shown on. */
  private readonly liveAt = new Map<string, number>();
  private seat: Seat | null = null;
  /** The camera gliding back after you stood up. */
  private leaving: { t0: number; from: { pos: THREE.Vector3; quat: THREE.Quaternion } } | null = null;
  private input: InputQueue | null = null;
  private lastPlan = -Infinity;
  private asleep = false;
  private connected = false;
  private seatedSize = { width: 1280, height: 826 };
  private readonly v = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly sphere = new THREE.Sphere(new THREE.Vector3(), 0.22);
  private readonly normal = new THREE.Vector3();
  private readonly toEye = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();
  private readonly camQuat = new THREE.Quaternion();
  /** Frames painted, for the bench. */
  paints = 0;

  constructor(
    private readonly host: LaptopHost,
    params: URLSearchParams,
  ) {
    this.cfg = { ...DEFAULT_SCREENS, live: screensParam(params.get('screens')) };
    this.planner = new WatchPlanner(this.cfg);
    this.watches = new Watches({
      send: (t, args) => this.host.watch(t, args),
      sink: { frame: (id, f) => this.onFrame(id, f), stop: (id) => this.onStop(id) },
      failed: (id, code, message) => this.onFailed(id, code, message),
      closed: (id, reason) => this.onClosed(id, reason),
      now: () => performance.now(),
    });
  }

  // ---- bridge -------------------------------------------------------------------

  onConn(m: ConnMessage): void {
    if (m.t === 'terminal.frame') this.watches.frame(m);
    else this.watches.closed(m);
  }

  /** The connection is up (again) or down: down, the bridge forgot every watch; up, the next plan watches again. */
  setConnected(live: boolean): void {
    if (live === this.connected) return;
    this.connected = live;
    if (!live) {
      this.watches.lost();
      this.planner.clear();
      if (this.seat) this.host.seat.status('offline', 'Not connected to herdr-world: what you type is not sent');
    } else {
      this.lastPlan = -Infinity;
      if (this.seat) this.host.seat.status('ok', null);
    }
  }

  private onFrame(id: string, f: Parameters<LaptopTerminal['frame']>[0]): void {
    let t = this.terms.get(id);
    if (!t) {
      t = this.pool.pop() ?? new LaptopTerminal();
      const size = this.seat?.id === id ? this.seatedSize : LIVE_SIZE;
      t.setSize(size.width, size.height);
      this.terms.set(id, t);
    }
    t.frame(f);
  }

  /** A watch ended: its laptop keeps the last frame (frozen), the terminal goes back to the pool. */
  private onStop(id: string): void {
    const t = this.terms.get(id);
    if (!t) return;
    this.terms.delete(id);
    const at = this.liveAt.get(id);
    this.liveAt.delete(id);
    if (this.meshes) {
      if (at !== undefined) this.meshes.setLive(at, null);
      const desk = this.desks.get(id);
      if (desk !== undefined && t.painted) this.meshes.freeze(desk, t.canvas);
    }
    t.reset();
    if (this.pool.length < this.cfg.live + 2) this.pool.push(t);
    else t.dispose();
  }

  private onFailed(id: string, code: string, message: string): void {
    this.planner.failed(id, performance.now());
    if (this.seat?.id === id && code !== 'observer_failed') {
      this.stand(this.watchFailure(code, message), true);
    }
  }

  private onClosed(id: string, reason: string): void {
    this.planner.forget(id);
    if (this.seat?.id !== id) return;
    const name = this.seat.name;
    if (reason === 'worker_removed') this.stand(`${name} went home, so you got up.`, true);
    else if (reason === 'asleep') this.stand(`${name}’s floor went to sleep, so you got up.`, true);
    else if (reason === 'observer_failed') this.host.seat.status('error', `${name}’s screen stopped updating. It comes back when herdr-world restarts the observer.`);
    // pane_changed: the next sync watches the new pane.
  }

  private watchFailure(code: string, message: string): string {
    const name = this.seat?.name ?? 'That worker';
    if (code === 'invalid_state') return `${name} has no terminal to sit at right now (${message.replace(/^invalid state:\s*/, '')}).`;
    if (code === 'capacity') return `herdr-world is watching as many screens as it allows. Try again in a moment.`;
    return failureText('terminal.watch', code, message, { worker: name });
  }

  // ---- sitting ----------------------------------------------------------------------

  get seated(): string | null {
    return this.seat?.id ?? null;
  }

  /** Gliding in or out (the frame loop keeps rendering). */
  get animating(): boolean {
    const now = performance.now();
    return (!!this.seat && now - this.seat.t0 < glideMs()) || !!this.leaving;
  }

  /** Why E cannot sit at this worker's laptop right now, or null when it can. */
  whyNot(id: string, office: OfficeView | null): string | null {
    if (this.watches.disabled || this.host.unsupported('terminal.watch')) return failureText('terminal.watch', 'unknown_command', '');
    const v = this.host.store.workerView(id);
    if (!v || !office || office.session !== v.worker.session) return 'Walk up to its desk first.';
    if (office.isAsleep) return 'This floor is asleep: wake it from the elevator (L) to use its laptops.';
    if (!v.worker.pane_id) return `${v.name} has no terminal to sit at.`;
    if (office.awayDesks().has(v.desk)) return `${v.name} is not at the desk right now.`;
    return null;
  }

  /** E on a worker: sits you at its laptop. The reason when you cannot. */
  sit(id: string, office: OfficeView | null, camera: THREE.PerspectiveCamera, walker: Seat['walker']): string | null {
    const why = this.whyNot(id, office);
    if (why) return why;
    const v = this.host.store.workerView(id);
    if (!v || !office) return 'Walk up to its desk first.';
    if (this.seat) this.stand(null, true);
    this.attach(office);
    this.seat = {
      id,
      desk: v.desk,
      office,
      name: v.name,
      walker: { ...walker },
      t0: performance.now(),
      from: { pos: camera.position.clone(), quat: camera.quaternion.clone() },
      to: { pos: camera.position.clone(), quat: camera.quaternion.clone() },
      view: '',
    };
    this.leaving = null;
    office.setLean(v.desk);
    office.setAtLaptop(true);
    // The seated screen: sized to the view, sharp from up close.
    const h = Math.round(Math.min(1400, Math.max(560, window.innerHeight * Math.min(2, window.devicePixelRatio || 1) * 0.9)));
    this.seatedSize = { width: Math.round(h * 1.55), height: h };
    this.terms.get(id)?.setSize(this.seatedSize.width, this.seatedSize.height);
    this.input = new InputQueue(
      {
        keys: (input) => this.host.send('worker.keys', { id, input }),
        prompt: (text) => this.host.send('worker.prompt', { id, text }),
        done: (kind, r) => this.inputDone(id, kind, r),
      },
      () => !this.host.store.workers.get(id)?.agent_kind,
    );
    this.host.seat.show(v.name, this.mac);
    this.host.seat.status('ok', null);
    this.host.seat.focus();
    // With the seat bar up, the laptop fits between it and the top bar.
    this.seat.to = this.seatPose(office, v.desk, camera);
    this.seat.view = viewKey(camera);
    this.lastPlan = -Infinity;
    this.syncWatches();
    return null;
  }

  /** Gets you up: the seated watch ends at once; `why` says so in a toast (a teleport snaps the camera back). */
  stand(why: string | null = null, snap = false): void {
    const s = this.seat;
    if (!s) return;
    this.seat = null;
    this.input?.clear();
    this.input = null;
    s.office.setLean(null);
    s.office.setAtLaptop(false);
    this.terms.get(s.id)?.setSize(LIVE_SIZE.width, LIVE_SIZE.height);
    this.host.seat.hide();
    this.leaving = snap ? null : { t0: performance.now(), from: { pos: this.camPos.clone(), quat: this.camQuat.clone() } };
    if (why) this.host.toast(why, 'error');
    this.syncWatches();
  }

  /** Where the camera goes to have the laptop fill the view: square on to the screen, from the chair's side. */
  private seatPose(office: OfficeView, desk: number, camera: THREE.PerspectiveCamera): { pos: THREE.Vector3; quat: THREE.Quaternion } {
    const meshes = this.meshes as ScreenMeshes;
    const M = this.m.multiplyMatrices(office.root.matrixWorld, meshes.slotMatrix(desk, new THREE.Matrix4()));
    const center = SCREEN.center.clone().applyMatrix4(M);
    const normal = SCREEN.normal.clone().transformDirection(M);
    const up = SCREEN.up.clone().transformDirection(M);
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const tanH = tanV * camera.aspect;
    // The screen fills the height between the top bar and the seat bar (or ~94 % of the width on a
    // tall window), centred there: the camera shifts along the screen's up, still square on.
    const H = Math.max(1, window.innerHeight);
    const ins = this.host.insets();
    const top = Math.min(H * 0.3, ins.top + 10);
    const bottom = Math.min(H * 0.35, ins.bottom + 10);
    const fill = (H - top - bottom) / H;
    const mid = 1 - (2 * (top + (H - top - bottom) / 2)) / H;
    const d = Math.max(SCREEN.height / fill / (2 * tanV), SCREEN.width / 0.94 / (2 * tanH));
    const pos = center.clone().addScaledVector(normal, d).addScaledVector(up, -mid * d * tanV);
    const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, pos.clone().sub(normal), up));
    return { pos, quat };
  }

  private inputDone(id: string, kind: 'keys' | 'prompt', r: CommandResult): void {
    if (this.seat?.id !== id) return;
    const name = this.seat.name;
    if (r.ok) {
      if (kind === 'prompt') this.host.seat.status('ok', `Pasted into ${name}’s terminal`);
      else this.host.seat.status('ok', null);
      return;
    }
    if (r.code === 'unknown_worker') return this.stand(`${name} is no longer on the floor, so you got up.`, true);
    if (r.code === 'invalid_state' && kind === 'keys') return this.stand(`${name} has no terminal any more (${r.message.replace(/^invalid state:\s*/, '')}), so you got up.`, true);
    if (r.code === 'offline' || r.code === 'disconnected') return this.host.seat.status('offline', 'Not connected to herdr-world: what you type is not sent');
    if (r.code === 'unknown_command') return this.host.seat.status('error', kind === 'keys' ? 'This herdr-world can’t take typing yet: update the bridge. The screen still shows.' : 'This herdr-world can’t take a paste yet: update the bridge.');
    const why = r.message.replace(/^(input_failed|prompt_failed|bad args|bad_request):\s*/, '') || r.code;
    this.host.seat.status('error', kind === 'keys' ? `${name}’s terminal didn’t take that: ${why}` : `The paste didn’t reach ${name}: ${why}`);
  }

  /** A keydown while seated: true when it was consumed (nothing else sees it). */
  key(e: KeyboardEvent): boolean {
    if (!this.seat) return false;
    const k = seatedKey(e, this.mac);
    if (k.prevent) e.preventDefault();
    if (k.action === 'stand') this.stand();
    else if (k.items.length) this.type(k.items);
    return true;
  }

  /** Typed text from composition (IME, dead keys) or the seat bar's input. */
  typeText(text: string): void {
    this.type(textItems(text));
  }

  private type(items: KeyItem[]): void {
    if (!this.seat || !this.input || !items.length) return;
    this.host.seat.status('busy', null);
    this.input.keys(items);
  }

  /** A paste while seated (Cmd/Ctrl+V): `worker.prompt` for an agent, typed for a plain shell. */
  paste(text: string): void {
    if (!this.seat || !this.input) return;
    if (!this.input.paste(text)) this.host.seat.status('error', 'That paste is over 16 KiB: paste less at a time.');
    else this.host.seat.status('busy', null);
  }

  // ---- per frame ---------------------------------------------------------------------

  /** Screens for the floor you are on: made when the floor changes. */
  private attach(office: OfficeView | null): void {
    if (office === this.attached) return;
    // A floor's screens are its own: the old floor's watches go, and a seat there ends.
    if (this.seat && this.seat.office !== office) this.stand(null, true);
    this.meshes?.dispose();
    this.meshes = null;
    this.attached = office;
    this.desks = new Map();
    this.liveAt.clear();
    this.planner.clear();
    if (office) {
      this.meshes = new ScreenMeshes(office.layout.slots);
      office.root.add(this.meshes.group);
    }
    this.syncWatches();
  }

  /** Once per rendered frame: keep seated, plan, paint, and move the camera when seated or gliding. */
  frame(f: LaptopFrame): void {
    const office = f.onFloor ? f.office : null;
    this.attach(office);
    const s = this.seat;
    if (s) {
      const w = f.walker;
      const moved = Math.abs(w.x - s.walker.x) > 1e-4 || Math.abs(w.z - s.walker.z) > 1e-4 || Math.abs(w.y - s.walker.y) > 1e-4;
      const v = this.host.store.workerView(s.id);
      if (moved || f.blocked) this.stand(null, true);
      else if (!v || v.worker.session !== s.office.session) this.stand(`${s.name} is no longer on the floor, so you got up.`, true);
      else if (s.office.isAsleep) this.stand(`${s.name}’s floor went to sleep, so you got up.`, true);
      else if (!v.worker.pane_id) this.stand(`${s.name} has no terminal any more, so you got up.`, true);
      else if (v.desk !== s.desk) this.stand(`${s.name} moved desks, so you got up.`, true);
    }
    const meshes = this.meshes;
    if (office && meshes) {
      const asleep = office.isAsleep;
      if (asleep !== this.asleep) {
        this.asleep = asleep;
        meshes.setVisible(!asleep);
      }
      if (f.now - this.lastPlan >= PLAN_MS) {
        this.lastPlan = f.now;
        this.plan(f, office, meshes);
      }
      // Paint what changed: the seated screen at its fps, live ones at theirs.
      for (const [id, t] of this.terms) {
        const desk = this.desks.get(id);
        const seated = this.seat?.id === id;
        const fps = seated ? this.cfg.seatedFps : this.cfg.fps;
        if (t.draw(f.now, 1000 / fps - 4)) this.paints++;
        const at = this.liveAt.get(id);
        if (at !== undefined && at !== desk) {
          meshes.setLive(at, null);
          this.liveAt.delete(id);
        }
        if (desk !== undefined && t.painted && at !== desk) {
          meshes.setLive(desk, t.texture);
          this.liveAt.set(id, desk);
        }
      }
      // M4 walks: a desk whose laptop is packed away (or not yet unpacked) shows no screen.
      for (const [d, show] of office.awayDesks()) {
        if (show !== 'empty') continue;
        meshes.unfreeze(d);
        meshes.setLive(d, null);
      }
      meshes.update(f.now);
    }
    this.moveCamera(f.camera, f.now);
  }

  private plan(f: LaptopFrame, office: OfficeView, meshes: ScreenMeshes): void {
    const cam = f.camera;
    this.frustum.setFromProjectionMatrix(this.m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    cam.getWorldPosition(this.v);
    const eye = this.v.clone();
    const cands: Candidate[] = [];
    const desks = new Map<string, number>();
    const away = office.awayDesks();
    const M = new THREE.Matrix4();
    for (let i = 0; i < office.desksCount; i++) {
      const w = office.seat(i);
      if (!w) continue;
      desks.set(w.worker.id, i);
      if (office.isAsleep || !w.worker.pane_id || away.has(i) || this.seat?.id === w.worker.id) continue;
      M.multiplyMatrices(office.root.matrixWorld, meshes.slotMatrix(i, new THREE.Matrix4()));
      this.sphere.center.copy(SCREEN.center).applyMatrix4(M);
      // In view, and facing you (from behind you see the lid).
      const facing = this.normal.copy(SCREEN.normal).transformDirection(M).dot(this.toEye.subVectors(eye, this.sphere.center)) > 0;
      cands.push({ id: w.worker.id, dist: this.sphere.center.distanceTo(eye), visible: facing && this.frustum.intersectsSphere(this.sphere) });
    }
    // A desk whose worker changed (left, moved, someone new) forgets its frozen screen.
    const now = new Map([...desks].map(([id, d]) => [d, id]));
    for (const [id, d] of this.desks) if (now.get(d) !== id) meshes.unfreeze(d);
    this.desks = desks;
    if (this.connected && !this.watches.disabled) this.planner.plan(f.now, cands, this.cfg.live);
    this.syncWatches();
  }

  /** The watches the bridge should have: the live laptops, and the one you sit at at its fps. */
  private syncWatches(): void {
    if (!this.connected) return;
    const want = new Map<string, number>();
    if (this.attached && !this.attached.isAsleep) for (const id of this.planner.live) want.set(id, this.cfg.fps);
    if (this.seat) want.set(this.seat.id, this.cfg.seatedFps);
    this.watches.sync(want);
  }

  private moveCamera(cam: THREE.PerspectiveCamera, now: number): void {
    const s = this.seat;
    if (s && s.view !== viewKey(cam)) {
      // The window changed size: fit the laptop to the new view.
      s.to = this.seatPose(s.office, s.desk, cam);
      s.view = viewKey(cam);
    }
    const glide = glideMs();
    if (s) {
      const k = glide ? smooth(Math.min(1, (now - s.t0) / glide)) : 1;
      if (s.from && k < 1) {
        cam.position.lerpVectors(s.from.pos, s.to.pos, k);
        cam.quaternion.slerpQuaternions(s.from.quat, s.to.quat, k);
      } else {
        cam.position.copy(s.to.pos);
        cam.quaternion.copy(s.to.quat);
        s.from = null;
      }
      cam.updateMatrixWorld();
    } else if (this.leaving) {
      const k = glide ? smooth(Math.min(1, (now - this.leaving.t0) / glide)) : 1;
      if (k >= 1) this.leaving = null;
      else {
        // The walker's camera is where the glide ends.
        const toPos = cam.position.clone();
        const toQuat = cam.quaternion.clone();
        cam.position.lerpVectors(this.leaving.from.pos, toPos, k);
        cam.quaternion.slerpQuaternions(this.leaving.from.quat, toQuat, k);
        cam.updateMatrixWorld();
      }
    }
    this.camPos.copy(cam.position);
    this.camQuat.copy(cam.quaternion);
  }

  // ---- test hooks ----------------------------------------------------------------------

  /** Per worker on the floor you are on: what its laptop shows, and the fps it is watched at. */
  screens(): Array<{ id: string; desk: number; state: ScreenState; fps: number | null }> {
    const out: Array<{ id: string; desk: number; state: ScreenState; fps: number | null }> = [];
    const o = this.attached;
    if (!o) return out;
    for (let i = 0; i < o.desksCount; i++) {
      const w = o.seat(i);
      if (!w) continue;
      const id = w.worker.id;
      const fps = this.watches.fps(id);
      const t = this.terms.get(id);
      let state: ScreenState = 'glow';
      if (o.isAsleep) state = 'dark';
      else if (fps !== null) state = t?.painted ? 'live' : 'pending';
      else if (this.meshes?.isFrozen(i)) state = 'frozen';
      out.push({ id, desk: i, state, fps });
    }
    return out;
  }

  /** The text on a live laptop's screen, one string per row (null when it is not live). */
  text(id: string): string[] | null {
    return this.terms.get(id)?.lines() ?? null;
  }

  get watchCount(): number {
    return this.watches.count;
  }

  dispose(): void {
    this.stand(null, true);
    this.attach(null);
    for (const t of [...this.terms.values(), ...this.pool]) t.dispose();
    this.terms.clear();
    this.pool.length = 0;
  }
}
