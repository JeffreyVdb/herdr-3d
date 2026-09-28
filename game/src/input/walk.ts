import type * as THREE from 'three/webgpu';
import { moveWithCollision } from '../world/collide';
import { EYE_HEIGHT, type Rect } from '../world/layout';

const WALK = 2.3; // m/s
const RUN = 4.6;
const LOOK = 0.0022; // rad per mouse count
const RADIUS = 0.28;
export const PITCH_LIMIT = 1.35;

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

/**
 * First-person walking: WASD / arrows, Shift to run, Pointer Lock mouse look,
 * AABB collision. yaw 0 looks north (-z).
 */
export class Walker {
  x = 0;
  z = 0;
  yaw = 0;
  pitch = 0;
  locked = false;
  /** False once the browser refused pointer lock (e.g. headless). */
  lockAvailable = true;
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
    if (!(e.code in MOVE_KEYS)) return false;
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
    this.onActivity();
    return true;
  }

  get moving(): boolean {
    return this.keys.size > 0;
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
    try {
      const p = this.dom.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => this.lockFailed());
    } catch {
      this.lockFailed();
    }
  }

  private lockFailed(): void {
    this.lockAvailable = false;
    this.onLockChange(false, true);
  }

  release(): void {
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
  }

  place(x: number, z: number, yaw: number, pitch = 0): void {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
  }

  /** Advances by `dt` seconds; true if the walker moved. */
  step(dt: number, obstacles: readonly Rect[]): boolean {
    let f = 0;
    let r = 0;
    for (const k of this.keys) {
      const m = MOVE_KEYS[k];
      if (m) {
        r += m[0];
        f += m[1];
      }
    }
    if (!f && !r) return false;
    const len = Math.hypot(f, r);
    const d = (this.run ? RUN : WALK) * dt;
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    // forward = (-sin, -cos), right = (cos, -sin)
    const dx = ((-sy * f + cy * r) / len) * d;
    const dz = ((-cy * f - sy * r) / len) * d;
    const p = moveWithCollision({ x: this.x, z: this.z }, { x: dx, z: dz }, RADIUS, obstacles);
    const moved = p.x !== this.x || p.z !== this.z;
    this.x = p.x;
    this.z = p.z;
    return moved;
  }

  applyTo(camera: THREE.PerspectiveCamera): void {
    camera.position.set(this.x, EYE_HEIGHT, this.z);
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
  }

  dispose(): void {
    this.ac.abort();
    this.release();
  }
}
