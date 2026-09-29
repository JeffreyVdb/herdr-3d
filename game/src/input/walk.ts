import type * as THREE from 'three/webgpu';
import { moveWalker, type WalkWorld } from '../world/collide';
import { EYE_HEIGHT } from '../world/layout';

const WALK = 2.3; // m/s
const RUN = 4.6;
const LOOK = 0.0022; // rad per mouse count
/** ms after an unlock before the browser takes a new pointer lock request. */
const LOCK_COOLDOWN = 1300;
const TURN = 2; // rad/s with the arrow keys
export const RADIUS = 0.28;
export const PITCH_LIMIT = 1.35;
/** Eye height follows the feet up and down stairs with this rate (1/s): smooth, not a pop per step. */
const EYE_EASE = 14;
/** #20: sitting at your desk lowers the eye this much, eased at this rate (1/s). */
export const SIT_DROP = 0.36;
const SIT_EASE = 12;

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
  KeyA: [-1, 0],
  KeyD: [1, 0],
};

/** Left / right arrows turn (A / D strafe), so a keyboard alone can look around. */
const TURN_KEYS: Record<string, number> = {
  ArrowLeft: 1,
  ArrowRight: -1,
};

/**
 * First-person walking: WASD / up-down arrows, left-right arrows to turn,
 * Shift to run, Pointer Lock mouse look, height-aware AABB collision (floors,
 * landings, stair treads, the sidewalk). yaw 0 looks north (-z). `y` is the
 * feet above the street; the eye eases after it on stairs.
 */
export class Walker {
  x = 0;
  z = 0;
  /** Feet height, absolute (the street is 0). */
  y = 0;
  /** Eased feet height the camera follows. */
  eye = 0;
  yaw = 0;
  pitch = 0;
  locked = false;
  /** #20: sitting at your desk; walking (WASD) stands you up. */
  sitting = false;
  /** 0 standing .. 1 seated, eased. */
  private seatK = 0;
  /** False once the browser refused pointer lock (e.g. headless). */
  lockAvailable = true;
  /** Pointer lock has worked at least once: a later refusal is transient, not "this browser can't". */
  private everLocked = false;
  /** When the lock last dropped (Esc): browsers refuse a re-request for about a second after. */
  private unlockedAt = -Infinity;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly keys = new Set<string>();
  private run = false;
  private readonly ac = new AbortController();

  constructor(
    private readonly dom: HTMLElement,
    private readonly onActivity: () => void,
    private readonly onLockChange: (locked: boolean, error: boolean) => void,
  ) {
    const sig = { signal: this.ac.signal };
    document.addEventListener(
      'pointerlockchange',
      () => {
        this.locked = document.pointerLockElement === this.dom;
        if (this.locked) this.everLocked = true;
        else this.unlockedAt = performance.now();
        this.onLockChange(this.locked, false);
      },
      sig,
    );
    document.addEventListener('pointerlockerror', () => this.lockFailed(), sig);
    document.addEventListener(
      'mousemove',
      (e) => {
        if (!this.locked) return;
        this.yaw -= e.movementX * LOOK;
        this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - e.movementY * LOOK));
        this.onActivity();
      },
      sig,
    );
    window.addEventListener('blur', () => this.stop(), sig);
  }

  /** Feed key events (the app routes them; returns true when consumed). */
  key(e: KeyboardEvent, down: boolean): boolean {
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      this.run = down;
      return false;
    }
    if (!(e.code in MOVE_KEYS) && !(e.code in TURN_KEYS)) return false;
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
    this.onActivity();
    return true;
  }

  get moving(): boolean {
    return this.keys.size > 0;
  }

  /** A walking key is held (turning alone is not walking). */
  get walking(): boolean {
    for (const k of this.keys) if (k in MOVE_KEYS) return true;
    return false;
  }

  /** Sits down where the walker stands (the app places it at the chair first). */
  sit(): void {
    this.sitting = true;
  }

  stand(): void {
    this.sitting = false;
  }

  /** Forgets held keys (leaving the floor, a hidden tab): nothing keeps walking. */
  stop(): void {
    this.keys.clear();
    this.run = false;
  }

  requestLock(): void {
    if (!this.lockAvailable) {
      this.onLockChange(false, true);
      return;
    }
    // Chrome refuses a request right after the user left the lock with Esc; the click's
    // user activation outlives the wait, so ask again once the cooldown is over.
    const wait = LOCK_COOLDOWN - (performance.now() - this.unlockedAt);
    if (wait > 0) {
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.requestLock(), wait);
      return;
    }
    try {
      const p = this.dom.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => this.lockFailed());
    } catch {
      this.lockFailed();
    }
  }

  private lockFailed(): void {
    // It worked before, so this refusal is a hiccup: stay in the room, the next click retries.
    if (this.everLocked) return;
    this.lockAvailable = false;
    this.onLockChange(false, true);
  }

  release(): void {
    clearTimeout(this.retry);
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
  }

  place(x: number, z: number, yaw: number, pitch = 0, y = this.y): void {
    this.x = x;
    this.z = z;
    this.y = this.eye = y;
    this.sitting = false;
    this.seatK = 0;
    this.yaw = yaw;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
  }

  /** Advances by `dt` seconds; true if the walker moved, turned or its eye is still easing. */
  step(dt: number, world: WalkWorld): boolean {
    let easing = this.easeEye(dt);
    const want = this.sitting ? 1 : 0;
    if (this.seatK !== want) {
      const d = want - this.seatK;
      this.seatK = Math.abs(d) < 1e-3 ? want : this.seatK + d * (1 - Math.exp(-SIT_EASE * dt));
      easing = true;
    }
    let f = 0;
    let r = 0;
    let turn = 0;
    for (const k of this.keys) {
      const m = MOVE_KEYS[k];
      if (m) {
        r += m[0];
        f += m[1];
      }
      turn += TURN_KEYS[k] ?? 0;
    }
    if (turn) this.yaw += turn * TURN * dt;
    if (!f && !r) return turn !== 0 || easing;
    // Walking gets you up from your desk.
    this.sitting = false;
    const len = Math.hypot(f, r);
    const d = (this.run ? RUN : WALK) * dt;
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    // forward = (-sin, -cos), right = (cos, -sin)
    const dx = ((-sy * f + cy * r) / len) * d;
    const dz = ((-cy * f - sy * r) / len) * d;
    const p = moveWalker({ x: this.x, y: this.y, z: this.z }, { x: dx, z: dz }, RADIUS, world);
    const moved = p.x !== this.x || p.z !== this.z;
    this.x = p.x;
    this.z = p.z;
    this.y = p.y;
    return moved || turn !== 0 || easing;
  }

  private easeEye(dt: number): boolean {
    const d = this.y - this.eye;
    if (d === 0) return false;
    // Exponential smoothing; a big jump (a teleport) snaps.
    this.eye = Math.abs(d) < 1e-3 || Math.abs(d) > 1.2 ? this.y : this.eye + d * (1 - Math.exp(-EYE_EASE * dt));
    return true;
  }

  /** Camera at eye height; `base` is the height the scene is shifted down by (the floor with an interior). */
  applyTo(camera: THREE.PerspectiveCamera, base = 0): void {
    camera.position.set(this.x, this.eye - base + EYE_HEIGHT - SIT_DROP * this.seatK, this.z);
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
  }

  dispose(): void {
    this.ac.abort();
    this.release();
  }
}
