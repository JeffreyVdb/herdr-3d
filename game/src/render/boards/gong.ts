import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * M7: the merge gong: a brass disc hung in a small wooden frame against the board wall, under the pull request board.
 * `ring` makes it swing and hum for a couple of seconds; the caller plays the sound.
 */

const toon = (color: number) => new THREE.MeshToonMaterial({ color });

const RING_MS = 2600;

export class Gong {
  readonly group = new THREE.Group();
  private readonly pivot = new THREE.Group();
  private readonly disc: THREE.Mesh;
  private t0 = -Infinity;
  /** How many times it rang (test hook). */
  rings = 0;

  /** `x` centre, `z` the wall's face; the frame stands on the floor and is `height` tall. */
  constructor(x: number, z: number, height = 0.78) {
    this.group.name = 'board.gong';
    this.group.position.set(x, 0, z);
    const wood = toon(0x7a5230);
    const half = 0.36;
    const posts = new THREE.Mesh(
      mergeBoxes([
        [0.05, height, 0.05, -half, height / 2, 0.03],
        [0.05, height, 0.05, half, height / 2, 0.03],
        [half * 2 + 0.1, 0.05, 0.06, 0, height - 0.02, 0.03],
        [0.05, 0.05, 0.16, -half, 0.03, 0.09],
        [0.05, 0.05, 0.16, half, 0.03, 0.09],
      ]),
      wood,
    );
    posts.castShadow = true;
    this.group.add(posts);
    // The disc hangs from the crossbar on two cords and swings about it.
    this.pivot.position.set(0, height - 0.02, 0.1);
    const R = 0.27;
    const brass = new THREE.MeshToonMaterial({ color: 0xe6b230 });
    this.disc = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.03, 40).rotateX(Math.PI / 2), brass);
    this.disc.position.set(0, -0.06 - R - 0.02, 0);
    const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.045, 24).rotateX(Math.PI / 2), new THREE.MeshToonMaterial({ color: 0xffd45c }));
    boss.position.z = 0.012;
    this.disc.add(boss);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R * 0.72, 0.01, 6, 40), new THREE.MeshToonMaterial({ color: 0xb98514 }));
    rim.position.z = 0.017;
    this.disc.add(rim);
    const cords = new THREE.Mesh(
      mergeBoxes([
        [0.008, 0.1, 0.008, -0.13, -0.045, 0],
        [0.008, 0.1, 0.008, 0.13, -0.045, 0],
      ]),
      toon(0x3a2a18),
    );
    this.disc.castShadow = true;
    this.pivot.add(this.disc, cords);
    this.group.add(this.pivot);
  }

  ring(now: number): void {
    this.t0 = now;
    this.rings++;
  }

  get busy(): boolean {
    return this.angle !== 0;
  }

  private angle = 0;

  /** Returns whether it still swings. */
  frame(now: number): boolean {
    const t = (now - this.t0) / 1000;
    const on = t >= 0 && t * 1000 < RING_MS;
    const a = on ? 0.5 * Math.exp(-1.6 * t) * Math.sin(t * Math.PI * 2 * 2.6) : 0;
    if (a === this.angle && !on) return false;
    this.angle = a;
    this.pivot.rotation.x = a;
    // A shimmer while it hums.
    this.disc.scale.setScalar(on ? 1 + 0.012 * Math.sin(t * 90) * Math.exp(-2 * t) : 1);
    return on;
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
      }
    });
    this.group.removeFromParent();
  }
}

/** Boxes `[w, h, d, x, y, z]` merged into one geometry. */
function mergeBoxes(boxes: ReadonlyArray<readonly [number, number, number, number, number, number]>): THREE.BufferGeometry {
  return mergeGeometries(boxes.map(([w, h, d, x, y, z]) => new THREE.BoxGeometry(w, h, d).translate(x, y, z)));
}
