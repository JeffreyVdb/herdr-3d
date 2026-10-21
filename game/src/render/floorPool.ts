import * as THREE from 'three/webgpu';

/**
 * #141: the GPU objects an office part draws with, taken from the pool rather than made per office: its instanced
 * meshes (each with its geometry, material and textures) sized for `capacity` desks. One kit per part; the part drawing
 * with it now is its `holder`, and a part that is no longer the holder (the office you just left) writes nothing to it.
 */
export interface PoolKit {
  readonly capacity: number;
  readonly meshes: readonly THREE.InstancedMesh[];
  holder: object | null;
  dispose(): void;
}

/** Desks a kit is sized for: in steps of `POOL_STEP`, and half as much again as the kit it replaces (rarely regrown). */
export const POOL_STEP = 16;

export function poolCapacity(need: number, had = 0): number {
  const want = Math.max(1, need, Math.ceil(had * 1.5));
  return Math.ceil(want / POOL_STEP) * POOL_STEP;
}

/**
 * #141: what stays alive from one floor to the next (docs/decisions.md). three r186 keys an instanced mesh's compiled
 * state by its uuid and captures its instance buffers when it builds, and every lit material's state by the lights'
 * ids, so an office made of new instanced meshes and new lamps rebuilt every shader on each floor entry. The office's
 * instanced parts therefore take their meshes from here, and the lamps are the same two lights on every floor:
 *
 * - one live mesh per uuid; a kit's meshes keep their `instanceMatrix` / `instanceColor` attributes and arrays;
 * - a kit's capacity is fixed: a floor that needs more desks gets a new, larger kit (new meshes, new uuids) and the
 *   old one is disposed (`poolCapacity` says how much larger);
 * - a part writes its floor into the kit (`count`, matrices, colours) and never disposes it: only the pool does.
 */
export class FloorPool {
  /** M17: the office's lamps, the same objects (and targets) on every floor (see `LAMPS`). */
  readonly lamps: readonly THREE.SpotLight[];
  private readonly held = new Map<string, PoolKit>();
  /** Every mesh a kit of this pool held: never disposed by an office (an outgrown kit is the pool's to dispose). */
  private readonly pooled = new WeakSet<THREE.Object3D>();
  /** Kits replaced by a larger one (test hook). */
  grown = 0;

  constructor(lamps: () => THREE.SpotLight[]) {
    this.lamps = lamps();
  }

  /** The kit `key` with room for `desks`, now drawn by `holder`: the one held when it has the room, else a new one from `make`. */
  take<K extends PoolKit>(key: string, desks: number, holder: object, make: (capacity: number) => K): K {
    let kit = this.held.get(key) as K | undefined;
    if (!kit || kit.capacity < desks) {
      const had = kit?.capacity ?? 0;
      if (kit) {
        kit.dispose();
        this.grown++;
      }
      kit = make(poolCapacity(desks, had));
      for (const m of kit.meshes) this.pooled.add(m);
      this.held.set(key, kit);
    }
    kit.holder = holder;
    return kit;
  }

  /** Whether `o` is a pooled mesh (an office's dispose leaves it alone). */
  owns(o: THREE.Object3D): boolean {
    return this.pooled.has(o);
  }

  /** The kits held, by key (test hook). */
  kits(): Array<{ key: string; kit: PoolKit }> {
    return [...this.held].map(([key, kit]) => ({ key, kit }));
  }

  dispose(): void {
    for (const k of this.held.values()) k.dispose();
    this.held.clear();
    for (const l of this.lamps) {
      l.removeFromParent();
      l.target.removeFromParent();
      l.dispose();
    }
  }
}

/**
 * A kit's mesh made ready for a new part: `count` instances (at most its capacity), shown, its bounds
 * computed again, and its buffers uploaded again once the part has written them. The part sets the rest (name,
 * shadows, matrices, colours), as it would on a new mesh.
 */
export function reuse(mesh: THREE.InstancedMesh, count: number): THREE.InstancedMesh {
  mesh.count = Math.max(0, Math.min(count, mesh.instanceMatrix.count));
  mesh.visible = true;
  mesh.boundingBox = null;
  mesh.boundingSphere = null;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

/** A kit of instanced meshes, disposed with their geometries and materials (`dispose`: whatever else it holds). */
export function meshKit<K extends Record<string, unknown>>(capacity: number, meshes: THREE.InstancedMesh[], extra: K, dispose: () => void = () => {}): PoolKit & K {
  return {
    ...extra,
    capacity,
    meshes,
    holder: null,
    dispose() {
      for (const m of meshes) {
        m.removeFromParent();
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
        m.dispose();
      }
      dispose();
    },
  };
}
