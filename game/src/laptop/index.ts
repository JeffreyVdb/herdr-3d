import * as THREE from 'three/webgpu';
import type { CommandResult } from '../net/client';
import type { Ask, CommandArgs, CommandName, ConnMessage, KeyItem } from '../net/protocol';
import { glassFrame, screenFrame } from '../render/desks';
import type { OfficeView } from '../render/office';
import { PrintMeshes } from '../render/prints';
import { ScreenMeshes } from '../render/screens';
import type { Uploader } from '../ui/composer/draft';
import { failureText } from '../ui/messages';
import { askAgent, askOf } from '../world/ask';
import type { WorldStore } from '../world/store';
import { DESK_H, SEAT_OFFSET } from '../world/layout';
import { DEFAULT_SCREENS, screensParam, WatchPlanner, type Candidate, type ScreenConfig } from '../world/screens';
import { InputLanes, InputQueue, seatedKey, textItems, type ZoomAction } from './keys';
import { pasteImages } from './pasteImages';
import { screenTheme } from './paint';
import type { ThemeLoader } from '../ui/themeLoader';
import { stepZoom, ZOOM, type ThemePreset } from '../ui/themes';
import { ImageFeeds, type ImageFeed } from './imageFeed';
import { decodeBitmap, Prints, printsParam, PRINT_WATCH_LIMIT } from './prints';
import { LaptopTerminal, LIVE_SIZE } from './terminal';
import { createSeatTabs, FLIP_KEY } from './seatTabs';
import { loadImagesTab, loadRenderer, TranscriptMode, type OverlayRect, type SeatMode } from './transcriptMode';
import { TranscriptWatches, WATCH_LIMIT } from './transcriptWatches';
import { Watches } from './watches';

export { screensParam };
export type { ImageFeed };

/** M6b (test hook): where a live screen is drawn, against its desk monitor's terminal area (world coordinates, metres). */
export interface ScreenMeshInfo {
  desk: number;
  mesh: string;
  /** The live plane shows this terminal's canvas, in the glance view (standing) or the whole screen (sitting). */
  texture: boolean;
  glance: boolean;
  center: { x: number; y: number; z: number };
  size: { width: number; height: number };
  monitor: { center: { x: number; y: number; z: number }; width: number; height: number };
}

/** What a laptop shows (test hook): live (watched, painted), pending (watched, no frame yet), frozen, glow, dark (asleep). */
export type ScreenState = 'live' | 'pending' | 'frozen' | 'glow' | 'dark';

/** The watches the game makes by itself. */
export type WatchCommand = 'terminal.watch' | 'terminal.unwatch' | 'transcript.watch' | 'transcript.unwatch' | 'transcript.image' | 'transcript.images';

export interface LaptopHost {
  store: WorldStore;
  send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** The watches the game makes by itself (kept out of the log of what you did). */
  watch<T extends WatchCommand>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  unsupported(t: CommandName): boolean;
  toast(msg: string, kind: 'info' | 'error'): void;
  /** #64: one image to Drop Zone through the bridge: a pasted screenshot in the transcript's prompt box or the terminal. */
  upload?: Uploader;
  /** The seat bar (ui/seat.ts). */
  seat: SeatView;
  /** CSS px the HUD covers at the top (the top bar) and the bottom (the seat bar): the laptop goes between. */
  insets(): { top: number; bottom: number };
  /** M16: where the transcript overlay goes (the HUD, fixed over the viewport). */
  layer: HTMLElement;
  /** #59: the transcript's and the terminal's presets and zooms, hidden tool calls; none: Quiet at 100% (tests). */
  themes?: ThemeLoader;
}

/** The HUD while you sit at a laptop. */
export interface SeatView {
  show(name: string, mac: boolean): void;
  hide(): void;
  status(kind: 'ok' | 'busy' | 'error' | 'offline', text: string | null): void;
  focus(): void;
  /** M16: the terminal or the conversation is up. */
  setMode(mode: SeatMode): void;
  /**
   * #57: the worker's agent asks a question (null: it does not): in terminal mode a line says so and how to answer it
   * in the transcript view (`key`: T while you have not typed into the terminal since, else Ctrl+Esc).
   */
  asking?(ask: { who: string; key: 'T' | 'Ctrl+Esc' } | null): void;
  /** #59: one of the bar's own controls has the keyboard (the terminal's preset and zoom). */
  owns?(t: EventTarget | null): boolean;
  /** #59: the keyboard to the terminal's preset and zoom (Ctrl+,); false when there are none. */
  focusLook?(): boolean;
  /** #59: `t` is one of those controls. */
  inLook?(t: EventTarget | null): boolean;
}

/** Keys a focused control of the seat bar keeps (moving between its controls, pressing one). */
const CONTROL_KEYS = new Set(['Tab', 'Enter', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

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
/** Where a desk's prints lie, in slot space (world/prints.ts): the middle of the strip in front of the keyboard. */
const PRINT_SPOT = new THREE.Vector3(0, DESK_H, SEAT_OFFSET - 0.28);
/** The screen you sit at covers the whole glass, the status bar's strip too: the terminal gets all of it. */
const GLASS = glassFrame();
/** The seated terminal's watch while you read the transcript: kept alive, so switching back shows it at once. */
const READING_FPS = 1;
const viewKey = (cam: THREE.PerspectiveCamera) => `${cam.aspect.toFixed(4)}:${window.innerHeight}`;
const smooth = (k: number) => k * k * (3 - 2 * k);

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** A text box has the keyboard: its letters are its own (the seat bar's hidden keyboard is not one: it only catches keys for the terminal). */
const inText = (t: EventTarget | null): boolean => t instanceof Element && !t.classList.contains('seat-input') && !!t.closest('input, textarea, select, [contenteditable]');

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
 * sleep. Standing up ends the seated watch at once. M16: seated, Ctrl+Esc
 * swaps the terminal for the worker's conversation (`transcriptMode.ts`),
 * drawn in a DOM overlay over the monitor; its transcript is watched
 * (`transcriptWatches.ts`) from the moment you sit, and the terminal stays
 * watched at 1 fps behind it (the monitor shows it frozen).
 */
export class Laptops {
  readonly cfg: ScreenConfig;
  readonly planner: WatchPlanner;
  readonly watches: Watches;
  readonly transcripts: TranscriptWatches;
  readonly transcript: TranscriptMode;
  /** M16 phase 2: the images of the watched transcripts (the conversation, the Images tab, the desk prints). */
  readonly feeds: ImageFeeds;
  /** M16 phase 2: the prints on the desks near you. */
  readonly prints: Prints;
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
  /** #57: the seated worker's ask (its tool_use_id), whether T still answers it, and what the seat bar says of it. */
  private askId: string | null = null;
  private askArmed = false;
  private askShown = '';
  /** The camera gliding back after you stood up. */
  private leaving: { t0: number; from: { pos: THREE.Vector3; quat: THREE.Quaternion } } | null = null;
  private input: InputQueue | null = null;
  /** Seated input per worker: kept after you stand up until it is sent. */
  private readonly lanes = new InputLanes(
    (id, settled) =>
      new InputQueue(
        {
          keys: (input) => this.host.send('worker.keys', { id, input }),
          prompt: (text) => this.host.send('worker.prompt', { id, text }),
          done: (kind, r) => {
            this.inputDone(id, kind, r);
            settled();
          },
        },
        () => !this.host.store.workers.get(id)?.agent_kind,
      ),
  );
  private lastPlan = -Infinity;
  private asleep = false;
  private connected = false;
  private seatedSize = { width: 1280, height: 826 };
  private readonly v = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly sphere = new THREE.Sphere(new THREE.Vector3(), 0.4);
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
    this.feeds = new ImageFeeds({ send: (t, args) => this.host.watch(t, args) });
    this.prints = new Prints({ feeds: this.feeds, ready: (id) => this.transcripts.ready(id), decode: decodeBitmap }, printsParam(params.get('prints')));
    this.transcript = new TranscriptMode({
      send: (t, args) => this.host.send(t, args),
      feed: (id) => this.feeds.get(id),
      renderer: loadRenderer,
      imagesRenderer: loadImagesTab,
      tabs: (pick) => createSeatTabs(pick),
      pane: (box) => {
        const pane = document.createElement('div');
        pane.className = 'seat-pane';
        pane.hidden = true;
        box.append(pane);
        return pane;
      },
      overlay: () => {
        const box = document.createElement('div');
        box.className = 'seat-transcript';
        box.tabIndex = -1;
        box.hidden = true;
        box.setAttribute('role', 'region');
        box.setAttribute('aria-label', 'Conversation');
        this.host.layer.append(box);
        return box;
      },
      storage: storage(),
      ...(this.host.upload ? { upload: this.host.upload } : {}),
      status: (kind, text) => this.host.seat.status(kind, text),
      modeChanged: (mode) => this.onMode(mode),
      ...(host.themes ? { prefs: host.themes.prefs } : {}),
    });
    this.transcripts = new TranscriptWatches({
      send: (t, args) => this.host.watch(t, args),
      sink: {
        reset: (id, ack) => {
          // A new watch (or a new session after /clear): what the feed knew is stale.
          this.feeds.peek(id)?.reset();
          this.feeds.get(id).note(ack.items);
          this.transcript.reset(id, ack);
        },
        push: (id, items, updates, head) => {
          this.feeds.get(id).note([...items, ...updates]);
          this.transcript.push(id, items, updates, head);
        },
        stop: (id) => {
          if (this.seat?.id !== id) this.feeds.drop(id);
        },
      },
      failed: (id, code, message) => this.onTranscriptFailed(id, code, message),
      closed: (id, reason) => this.onTranscriptClosed(id, reason),
      now: () => performance.now(),
    });
    // #59: the screens follow the preset once its font can draw, and the seated one the zoom.
    host.themes?.onReady((t) => this.setLook(t));
    host.themes?.prefs.onChange((what) => {
      if (what === 'terminalZoom') for (const t of this.terms.values()) t.setZoom(this.zoom);
    });
  }

  /** The terminal's own zoom (the transcript has another). */
  private get zoom(): number {
    return this.host.themes?.prefs.zoom('terminal') ?? ZOOM.reset;
  }

  /** #59: every screen (live and pooled) in the preset's font and colours. */
  private setLook(t: ThemePreset): void {
    for (const term of [...this.terms.values(), ...this.pool]) term.setLook(t.mono.stack, screenTheme(t.screen));
  }

  /**
   * #59: A−, A+ and reset, from the keys or the wheel, for the view that is up: the transcript's zoom while you read
   * (its strip shows the level), the terminal's otherwise (the seat bar shows it). The Images tab has no zoom.
   */
  zoomBy(a: ZoomAction): void {
    const prefs = this.host.themes?.prefs;
    if (!prefs || !this.seat) return;
    const mode = this.transcript.mode;
    if (mode === 'images') return;
    const view = mode === 'transcript' ? 'transcript' : 'terminal';
    prefs.setZoom(view, a === 'zoom-reset' ? ZOOM.reset : stepZoom(prefs.zoom(view), a === 'zoom-in' ? 1 : -1));
  }

  /** Ctrl+wheel (a trackpad's pinch too) over the view while seated: a step per notch, the rest carried over. */
  private wheelAcc = 0;
  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.seat || !e.ctrlKey || !e.cancelable) return;
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
    this.wheelAcc += px;
    const step = 60;
    while (Math.abs(this.wheelAcc) >= step) {
      const dir = this.wheelAcc > 0 ? -1 : 1;
      this.wheelAcc -= -dir * step;
      this.zoomBy(dir > 0 ? 'zoom-in' : 'zoom-out');
    }
  };

  // ---- bridge -------------------------------------------------------------------

  onConn(m: ConnMessage): void {
    if (m.t === 'terminal.frame') this.watches.frame(m);
    else if (m.t === 'terminal.closed') this.watches.closed(m);
    else if (m.t === 'transcript.items') this.transcripts.items(m);
    else this.transcripts.closed(m);
  }

  /** The connection is up (again) or down: down, the bridge forgot every watch; up, the next plan watches again. */
  setConnected(live: boolean): void {
    if (live === this.connected) return;
    this.connected = live;
    if (!live) {
      this.watches.lost();
      this.transcripts.lost();
      this.planner.clear();
      this.prints.clear();
      this.prints.planner.clear();
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
      const look = this.host.themes?.ready;
      if (look) t.setLook(look.mono.stack, screenTheme(look.screen));
      t.setZoom(this.zoom);
      const seated = this.seat?.id === id;
      const size = seated ? this.seatedSize : LIVE_SIZE;
      t.setSize(size.width, size.height);
      t.setGlance(!seated);
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

  // ---- M16: the transcript ----------------------------------------------------------

  /** Why Ctrl+Esc cannot show the conversation, or null when it can. */
  private whyNoTranscript(): string | null {
    const why = this.transcripts.disabled ?? (this.host.unsupported('transcript.watch') ? '' : null);
    return why === null ? null : failureText('transcript.watch', 'unknown_command', why);
  }

  /** Ctrl+Esc or the seat bar's switch: the terminal or the conversation. */
  toggleTranscript(): void {
    if (!this.seat) return;
    if (this.transcript.mode === 'terminal') {
      const why = this.whyNoTranscript();
      if (why) return this.host.seat.status('error', why);
    }
    this.transcript.toggle();
  }

  private onMode(mode: SeatMode): void {
    this.host.seat.setMode(mode);
    const s = this.seat;
    if (s && this.meshes) {
      const t = this.terms.get(s.id);
      if (mode !== 'terminal') {
        // The monitor behind the overlay holds the screen as it was ("reading"); the watch goes on at 1 fps.
        const at = this.liveAt.get(s.id);
        if (at !== undefined) this.meshes.setLive(at, null);
        this.liveAt.delete(s.id);
        if (t?.painted) this.meshes.freeze(s.desk, t.canvas);
      } else this.meshes.unfreeze(s.desk);
    }
    if (mode === 'terminal') this.host.seat.focus();
    this.syncWatches();
  }

  private onTranscriptFailed(id: string, code: string, message: string): void {
    this.prints.failed(id, performance.now());
    if (this.seat?.id !== id) return;
    const name = this.seat.name;
    if (code === 'unknown_command') {
      this.transcript.stop(id);
      this.host.seat.status('error', failureText('transcript.watch', code, message));
    } else if (this.transcript.mode !== 'terminal') {
      this.host.seat.status('error', code === 'capacity' ? 'herdr-world is reading as many conversations as it allows. Trying again in a moment.' : failureText('transcript.watch', code, message, { worker: name }));
    }
  }

  private onTranscriptClosed(id: string, reason: string): void {
    this.prints.forget(id);
    if (this.seat?.id !== id) return;
    // The terminal's own close (or the frame loop) stands you up; the overlay goes back to the terminal meanwhile.
    if (reason === 'worker_removed' || reason === 'asleep') this.transcript.stop(id);
    else if (reason === 'session_changed' && this.transcript.mode !== 'terminal') this.host.seat.status('ok', `${this.seat.name} started a new session`);
  }

  /** Where the monitor's glass is on the viewport (CSS px), between the top bar and the seat bar. */
  private glassRect(cam: THREE.PerspectiveCamera): OverlayRect | null {
    const s = this.seat;
    if (!s || !this.meshes) return null;
    const M = this.m.multiplyMatrices(s.office.root.matrixWorld, this.meshes.slotMatrix(s.desk, new THREE.Matrix4()));
    const center = this.v.copy(GLASS.center).applyMatrix4(M);
    const normal = GLASS.normal.clone().transformDirection(M);
    const up = GLASS.up.clone().transformDirection(M);
    const right = new THREE.Vector3().crossVectors(up, normal).normalize();
    const W = window.innerWidth;
    const H = window.innerHeight;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    cam.updateMatrixWorld();
    for (const [a, b] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      const p = center
        .clone()
        .addScaledVector(right, (a * GLASS.width) / 2)
        .addScaledVector(up, (b * GLASS.height) / 2)
        .project(cam);
      if (p.z < -1 || p.z > 1) return null;
      const x = ((p.x + 1) / 2) * W;
      const y = ((1 - p.y) / 2) * H;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    // Never under the top bar or the seat bar, nor off the window.
    const ins = this.host.insets();
    x0 = Math.max(0, x0);
    x1 = Math.min(W, x1);
    y0 = Math.max(ins.top, y0);
    y1 = Math.min(H - ins.bottom, y1);
    if (x1 - x0 < 40 || y1 - y0 < 40) return null;
    return { left: Math.round(x0), top: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
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
    // The seated screen: the whole terminal over the whole glass, sized to the view, sharp from up close (the monitor's shape, at most 2400 wide).
    const aspect = GLASS.width / GLASS.height;
    const h = Math.round(Math.min(1400, 2400 / aspect, Math.max(560, window.innerHeight * Math.min(2, window.devicePixelRatio || 1) * 0.9)));
    this.seatedSize = { width: Math.round(h * aspect), height: h };
    const term = this.terms.get(id);
    term?.setSize(this.seatedSize.width, this.seatedSize.height);
    term?.setGlance(false);
    this.meshes?.setFull(v.desk);
    this.input = this.lanes.sit(id);
    // #59: Ctrl+wheel zooms the text while seated only (a non-passive listener, so it can keep the browser's zoom off).
    this.wheelAcc = 0;
    window.addEventListener('wheel', this.onWheel, { passive: false });
    this.host.seat.show(v.name, this.mac);
    this.host.seat.status('ok', null);
    this.host.seat.focus();
    // M16: its transcript is watched from now on (the first Ctrl+Esc shows it at once); its last mode comes back.
    this.transcript.sit(id, v.name, !this.whyNoTranscript());
    // Its view starts empty: a watch a desk print kept since you last sat here is made again, for its ack's history.
    this.transcripts.refresh(id);
    // With the seat bar up, the laptop fits between it and the top bar.
    this.seat.to = this.seatPose(office, v.desk, camera);
    this.seat.view = viewKey(camera);
    this.lastPlan = -Infinity;
    this.syncWatches();
    return null;
  }

  /**
   * Gets you up: the seated watch ends at once; `why` says so in a toast (a
   * teleport snaps the camera back). What you typed that has not gone out
   * yet still goes, in order (a failure then is a toast).
   */
  stand(why: string | null = null, snap = false): void {
    const s = this.seat;
    if (!s) return;
    this.seat = null;
    window.removeEventListener('wheel', this.onWheel);
    this.lanes.stand();
    this.input = null;
    this.transcript.stand();
    this.markReading(null);
    this.meshes?.unfreeze(s.desk);
    s.office.setLean(null);
    s.office.setAtLaptop(false);
    const term = this.terms.get(s.id);
    term?.setSize(LIVE_SIZE.width, LIVE_SIZE.height);
    term?.setGlance(true);
    this.meshes?.setFull(null);
    this.askId = null;
    this.askShown = '';
    this.host.seat.asking?.(null);
    this.host.seat.hide();
    this.leaving = snap ? null : { t0: performance.now(), from: { pos: this.camPos.clone(), quat: this.camQuat.clone() } };
    if (why) this.host.toast(why, 'error');
    this.syncWatches();
  }

  /** Where the camera goes to have the monitor's terminal fill the view: square on to the screen, from the chair's side. */
  private seatPose(office: OfficeView, desk: number, camera: THREE.PerspectiveCamera): { pos: THREE.Vector3; quat: THREE.Quaternion } {
    const meshes = this.meshes as ScreenMeshes;
    const M = this.m.multiplyMatrices(office.root.matrixWorld, meshes.slotMatrix(desk, new THREE.Matrix4()));
    const center = GLASS.center.clone().applyMatrix4(M);
    const normal = GLASS.normal.clone().transformDirection(M);
    const up = GLASS.up.clone().transformDirection(M);
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
    const d = Math.max(GLASS.height / fill / (2 * tanV), GLASS.width / 0.94 / (2 * tanH));
    const pos = center.clone().addScaledVector(normal, d).addScaledVector(up, -mid * d * tanV);
    const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, pos.clone().sub(normal), up));
    return { pos, quat };
  }

  private inputDone(id: string, kind: 'keys' | 'prompt', r: CommandResult): void {
    if (this.seat?.id !== id) {
      // Sent after you stood up: only a failure is worth a word.
      if (r.ok) return;
      const who = this.host.store.workerView(id)?.name ?? 'the worker';
      const why = r.code === 'offline' || r.code === 'disconnected' ? 'not connected to herdr-world' : r.message.replace(/^(input_failed|prompt_failed|bad args|bad_request):\s*/, '') || r.code;
      this.host.toast(kind === 'keys' ? `What you typed didn’t reach ${who}: ${why}` : `Your paste didn’t reach ${who}: ${why}`, 'error');
      return;
    }
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

  /**
   * #57: the seated worker's ask. The transcript view gets it (a pinned card); in terminal mode the seat bar says
   * so, and T switches to the transcript until you type into the terminal (then T is a letter again).
   */
  private syncAsk(ask: Ask | null): void {
    this.transcript.asked(ask);
    const id = ask?.tool_use_id ?? null;
    if (id !== this.askId) {
      this.askId = id;
      this.askArmed = !!id;
    }
    const line = ask && this.transcript.mode === 'terminal' ? { who: askAgent(ask), key: this.askArmed ? ('T' as const) : ('Ctrl+Esc' as const) } : null;
    const key = line ? `${line.who}\u0000${line.key}` : '';
    if (key === this.askShown) return;
    this.askShown = key;
    this.host.seat.asking?.(line);
  }

  /** A keydown while seated: true when it was consumed (nothing else sees it). */
  key(e: KeyboardEvent): boolean {
    if (!this.seat) return false;
    const k = seatedKey(e, this.mac);
    if (k.action === 'zoom-in' || k.action === 'zoom-out' || k.action === 'zoom-reset') {
      e.preventDefault();
      this.zoomBy(k.action);
      return true;
    }
    // #59: Ctrl+, from any view: the terminal's preset and zoom on the seat bar (works without a transcript, leaves the
    // pane its Tab); Esc there hands the keyboard back to the view that is up instead of standing you up.
    if (k.action === 'look') {
      e.preventDefault();
      this.host.seat.focusLook?.();
      return true;
    }
    if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && this.host.seat.inLook?.(e.target)) {
      e.preventDefault();
      if (this.transcript.shown) this.transcript.focus();
      else this.host.seat.focus();
      return true;
    }
    // #59: on the seat bar's own controls (the terminal's preset and zoom), moving and pressing are theirs.
    if (CONTROL_KEYS.has(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && this.host.seat.owns?.(e.target)) return true;
    if (this.transcript.shown) return this.readingKey(e, k.action === 'toggle-transcript');
    // #57: T answers the question in the transcript view (once you type into the terminal, T is a letter again).
    if (this.askId && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
      if (this.askArmed && e.key.toLowerCase() === 't' && !e.shiftKey) {
        e.preventDefault();
        if (!this.whyNoTranscript()) {
          this.transcript.setMode('transcript');
          return true;
        }
      }
      if (k.items.length) this.askArmed = false;
    }
    if (k.prevent) e.preventDefault();
    if (k.action === 'stand') this.stand();
    else if (k.action === 'toggle-transcript') this.toggleTranscript();
    else if (k.items.length) this.type(k.items);
    return true;
  }

  /**
   * M16: a keydown while you read the transcript. Nothing goes to the pane:
   * Ctrl+Esc goes back to the terminal, Esc stands you up, Enter goes to the
   * prompt box; every other key (scrolling, typing in the prompt box) is the
   * transcript's own, as is a key it already took (`defaultPrevented`).
   */
  private readingKey(e: KeyboardEvent, toggle: boolean): boolean {
    if (toggle) {
      e.preventDefault();
      this.toggleTranscript();
      return true;
    }
    if (e.defaultPrevented || e.isComposing) return true;
    const mods = e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;
    if (e.key === 'Escape' && !mods) {
      e.preventDefault();
      this.stand();
    } else if (e.key === 'Enter' && !mods && !this.transcriptOwns(e.target)) {
      e.preventDefault();
      this.transcript.focusPrompt();
    } else if (e.key.toLowerCase() === FLIP_KEY && !mods && !inText(e.target)) {
      // Conversation <-> Images. The prompt box (and any text field) keeps its letters.
      e.preventDefault();
      this.transcript.flip();
    }
    return true;
  }

  /** A key on a control in the transcript (its prompt box, a tool row's button, a link) is its own; on the timeline itself it is not. */
  private transcriptOwns(t: EventTarget | null): boolean {
    const box = this.transcript.box;
    if (!box || !(t instanceof Element) || !box.contains(t)) return false;
    const control = t.closest('button, a, input, textarea, select, [contenteditable]');
    return !!control && box.contains(control);
  }

  /** Where the keyboard goes while seated (a click on the view): the terminal's input, or the transcript. */
  focusSeat(): void {
    if (this.transcript.shown) this.transcript.focus();
    else this.host.seat.focus();
  }

  /** Typed text from composition (IME, dead keys) or the seat bar's input. */
  typeText(text: string): void {
    this.type(textItems(text));
  }

  private type(items: KeyItem[]): void {
    if (!this.seat || !this.input || !items.length || this.transcript.shown) return;
    this.host.seat.status('busy', null);
    this.input.keys(items);
  }

  /**
   * A paste while seated (Cmd/Ctrl+V): `worker.prompt` for an agent, typed for a plain shell. #64: a paste that carries
   * images (a screenshot) goes to an agent as `[Image #n: <path>]` markers once they are uploaded; a plain shell has no
   * agent to read a picture, so it is told so and nothing is typed.
   */
  paste(text: string, files: readonly File[] = []): void {
    if (!this.seat || !this.input || this.transcript.shown) return;
    if (files.length > 0) {
      this.pasteImages(files);
      return;
    }
    if (!this.input.paste(text)) this.host.seat.status('error', 'That paste is over 16 KiB: paste less at a time.');
    else this.host.seat.status('busy', null);
  }

  /** #64: the pasted images become markers in one paste (see `pasteImages`); standing up does not cancel it, only a failure is then a toast. */
  private pasteImages(files: readonly File[]): void {
    const seat = this.seat;
    const lane = this.input;
    if (!seat || !lane) return;
    const { id, name } = seat;
    void pasteImages(files, {
      name,
      agent: !!this.host.store.workers.get(id)?.agent_kind,
      upload: this.host.upload,
      paste: (text) => lane.paste(text),
      // The bar's note is a few words wide and ends in an ellipsis: an error is a toast as well, so it can be read whole.
      say: (kind, msg) => {
        if (this.seat?.id === id) this.host.seat.status(kind, msg);
        if (kind === 'error') this.host.toast(msg, 'error');
      },
    });
  }

  // ---- per frame ---------------------------------------------------------------------

  /** Screens for the floor you are on: made when the floor changes. */
  private attach(office: OfficeView | null): void {
    if (office === this.attached) return;
    // A floor's screens are its own: the old floor's watches go, and a seat there ends.
    if (this.seat && this.seat.office !== office) this.stand(null, true);
    this.meshes?.dispose();
    this.meshes = null;
    this.prints.setMeshes(null);
    this.attached = office;
    this.desks = new Map();
    this.liveAt.clear();
    this.planner.clear();
    if (office) {
      this.meshes = new ScreenMeshes(office.layout.slots);
      office.root.add(this.meshes.group);
      const prints = new PrintMeshes(office.layout.slots);
      office.root.add(prints.group);
      this.prints.setMeshes(prints);
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
      else {
        this.transcript.blocked(v.worker.status === 'blocked' ? (v.worker.question ?? null) : null);
        this.transcript.activity(v.worker.status, v.worker.status_since ?? null); // #58
        this.syncAsk(askOf(v.worker)); // #57
      }
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
        // M16: reading the transcript, the monitor behind it stays frozen (see onMode).
        if (seated && this.transcript.shown) continue;
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
    if (this.transcript.shown) {
      const rect = this.glassRect(f.camera);
      this.transcript.place(rect);
      this.markReading(rect);
    } else this.markReading(null);
  }

  /**
   * The page says a reading overlay is up and where it ends (its right edge, px): the plan-limits plate steps out of it
   * like out of a screen dialog (ui/limits.ts), and follows a resize.
   */
  private markReading(rect: OverlayRect | null): void {
    const el = document.documentElement;
    const v = rect ? String(Math.round(rect.left + rect.width)) : null;
    if (el.getAttribute('data-reading') === v) return;
    if (v === null) el.removeAttribute('data-reading');
    else el.setAttribute('data-reading', v);
  }

  private plan(f: LaptopFrame, office: OfficeView, meshes: ScreenMeshes): void {
    const cam = f.camera;
    this.frustum.setFromProjectionMatrix(this.m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    cam.getWorldPosition(this.v);
    const eye = this.v.clone();
    const cands: Candidate[] = [];
    const printCands: Candidate[] = [];
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
      // M16 phase 2: prints lie on desks of workers that have a conversation, in view (no matter which way the lid faces).
      if (w.worker.agent_kind || w.harness) {
        this.sphere.center.copy(PRINT_SPOT).applyMatrix4(M);
        printCands.push({ id: w.worker.id, dist: this.sphere.center.distanceTo(eye), visible: this.frustum.intersectsSphere(this.sphere) });
      }
    }
    // A desk whose worker changed (left, moved, someone new) forgets its frozen screen.
    const now = new Map([...desks].map(([id, d]) => [d, id]));
    for (const [id, d] of this.desks) if (now.get(d) !== id) meshes.unfreeze(d);
    this.desks = desks;
    if (this.connected && !this.watches.disabled) this.planner.plan(f.now, cands, this.cfg.live);
    this.prints.update(f.now, printCands, desks, this.seat?.id ?? null, this.connected && !office.isAsleep && !this.whyNoTranscript());
    this.syncWatches();
  }

  /** The watches the bridge should have: the live laptops, and the one you sit at at its fps. */
  private syncWatches(): void {
    if (!this.connected) return;
    const want = new Map<string, number>();
    if (this.attached && !this.attached.isAsleep) for (const id of this.planner.live) want.set(id, this.cfg.fps);
    if (this.seat) want.set(this.seat.id, this.transcript.shown ? READING_FPS : this.cfg.seatedFps);
    this.watches.sync(want);
    // M16: the transcript of the worker you sit at (not counted against the terminal watches), and a few items of the
    // desks that have prints (only their images matter).
    const tx = new Map<string, number>();
    if (!this.whyNoTranscript()) {
      for (const id of this.prints.wants()) tx.set(id, PRINT_WATCH_LIMIT);
      if (this.seat) tx.set(this.seat.id, WATCH_LIMIT);
    }
    this.transcripts.sync(tx);
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
      else if (this.seat?.id === id && this.transcript.shown) state = this.meshes?.isFrozen(i) ? 'frozen' : 'glow';
      else if (fps !== null) state = t?.painted ? 'live' : 'pending';
      else if (this.meshes?.isFrozen(i)) state = 'frozen';
      out.push({ id, desk: i, state, fps });
    }
    return out;
  }

  /** M6b: where a worker's live screen is drawn and where its monitor is (test hook). */
  screenMesh(id: string): ScreenMeshInfo | null {
    const desk = this.liveAt.get(id);
    const o = this.attached;
    const t = this.terms.get(id);
    const mesh = desk !== undefined ? this.meshes?.liveMesh(desk) : null;
    if (desk === undefined || !o || !mesh || !t || !this.meshes) return null;
    o.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    const c = box.getCenter(new THREE.Vector3());
    const M = new THREE.Matrix4().multiplyMatrices(o.root.matrixWorld, this.meshes.slotMatrix(desk, new THREE.Matrix4()));
    const mc = SCREEN.center.clone().applyMatrix4(M);
    const geo = mesh.geometry;
    geo.computeBoundingBox();
    const g = geo.boundingBox as THREE.Box3;
    const gs = g.getSize(new THREE.Vector3());
    const xy = (v: THREE.Vector3) => ({ x: +v.x.toFixed(4), y: +v.y.toFixed(4), z: +v.z.toFixed(4) });
    return {
      desk,
      mesh: mesh.name,
      texture: (mesh.material as THREE.MeshBasicMaterial).map === t.texture,
      glance: t.glancing,
      center: xy(c),
      // The plane lies in the slot's x and (tilted) y: its width along x, its height from y and z.
      size: { width: +gs.x.toFixed(4), height: +Math.hypot(gs.y, gs.z).toFixed(4) },
      monitor: { center: xy(mc), width: SCREEN.width, height: SCREEN.height },
    };
  }

  /** How much of a worker's frozen screen is not black (0–1; null: not frozen). */
  frozenInk(id: string): number | null {
    const desk = this.desks.get(id);
    return desk === undefined ? null : (this.meshes?.frozenInk(desk) ?? null);
  }

  /** The text on a live laptop's screen, one string per row (null when it is not live). */
  text(id: string): string[] | null {
    return this.terms.get(id)?.lines() ?? null;
  }

  /** #59: the font the seated screen draws with (test hook). */
  seatedFont(): string | null {
    return this.seat ? (this.terms.get(this.seat.id)?.fontStack ?? null) : null;
  }

  get watchCount(): number {
    return this.watches.count;
  }

  /** M16 phase 2: a click (the ray from the crosshair or the pointer) on a desk's print opens the lightbox. */
  clickPrint(ray: THREE.Raycaster): boolean {
    return !this.seat && this.prints.click(ray);
  }

  /** M16 phase 2: per desk with prints, what lies on it and how many pictures are loaded; and the textures' ledger (test hook). */
  printsState(): { desks: ReturnType<Prints['info']>; counts: ReturnType<Prints['counts']>; watches: string[]; lightboxes: number } {
    return { desks: this.prints.info(), counts: this.prints.counts(), watches: this.transcripts.ids(), lightboxes: this.prints.lightboxes };
  }

  /** M16 phase 2: where a print is in the world (test hook: aim a camera at it). */
  printWorld(desk: number, index: number): { x: number; y: number; z: number } | null {
    const m = this.prints.worldOf(desk, index);
    return m ? { x: m.x, y: m.y, z: m.z } : null;
  }

  /** M16: the seated view's mode, its transcript and overlay (test hook). */
  transcriptState(): {
    mode: SeatMode;
    watches: number;
    items: number;
    box: OverlayRect | null;
    mounted: boolean;
    /** M16 phase 2: the images tab is mounted; the distinct images the strip counts; views/tabs/overlays made and removed. */
    tabMounted: boolean;
    imageCount: number | null;
    counts: { mounted: number; destroyed: number; tabsMounted: number; tabsDestroyed: number; overlays: number; removed: number };
    /** #58: the cue the view shows (`thinking@<since>`, '' for none) and the pending prompts' states. */
    cue: string;
    pending: string[];
  } {
    const b = this.transcript.box;
    const r = b && !b.hidden ? b.getBoundingClientRect() : null;
    return {
      mode: this.transcript.mode,
      watches: this.transcripts.count,
      items: this.transcript.itemCount,
      box: r ? { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } : null,
      mounted: this.transcript.counts.mounted > this.transcript.counts.destroyed,
      tabMounted: this.transcript.tabMounted,
      imageCount: this.transcript.imageCount,
      counts: { ...this.transcript.counts },
      cue: this.transcript.cueState,
      pending: this.transcript.pending.map((p) => (p.late ? `${p.state}+late` : p.state)),
    };
  }

  dispose(): void {
    this.stand(null, true);
    this.lanes.clear();
    this.attach(null);
    this.prints.dispose();
    for (const t of [...this.terms.values(), ...this.pool]) t.dispose();
    this.terms.clear();
    this.pool.length = 0;
  }
}
