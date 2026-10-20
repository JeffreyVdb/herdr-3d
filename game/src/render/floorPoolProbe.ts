import * as THREE from 'three/webgpu';
import type { FloorPool } from './floorPool';

/** #141: a pooled mesh as drawn (test hook): its instances in use, its material, and whether the renderer draws its own buffers. */
export interface PooledMeshProbe {
  name: string;
  uuid: string;
  count: number;
  capacity: number;
  visible: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
  /** The used part of `instanceMatrix` / `instanceColor` (with `data`), rounded. */
  matrix?: number[];
  color?: number[] | null;
  material: { type: string; color: number | null; emissive: number | null; map: string | null };
  /** In the office drawn now (under `root`). */
  inOffice: boolean;
  /** It and every parent shown (an asleep floor hides its screens' group, and with it the frozen screens). */
  shown: boolean;
  /**
   * Render objects of this mesh and whether each one's compiled state reads this mesh's own `instanceMatrix` array (a
   * uniform buffer or a vertex buffer) and its own `instanceColor` array (null: the mesh has none).
   */
  bound: Array<{ matrix: boolean; color: boolean | null }>;
}

export interface PoolProbe {
  kits: Array<{ key: string; capacity: number; meshes: PooledMeshProbe[] }>;
  grown: number;
  lamps: Array<{ name: string; parent: string | null; index: number; position: number[]; target: number[]; targetInScene: boolean; intensity: number; id: number }>;
  /** Instanced meshes under `scene` sharing a uuid (must be none). */
  sharedUuids: string[];
  /** What the renderer holds: `renderer.info.memory`, its render objects, compiled states and pipelines (a leak shows here). */
  memory: { geometries: number; textures: number; attributes: number; programs: number; renderObjects: number; states: number; pipelines: number };
}

interface RendererInternals {
  _objects?: { _renderObjects?: Set<RenderObjectLike> };
  _nodes?: { nodeBuilderCache?: Map<unknown, unknown> };
  _pipelines?: { caches?: Map<unknown, unknown> };
}

interface RenderObjectLike {
  object: THREE.Object3D;
  getAttributes(): Array<THREE.BufferAttribute | THREE.InterleavedBufferAttribute>;
  getBindings(): Array<{ bindings: Array<{ buffer?: unknown }> }>;
}

const size = (img: unknown) => {
  const i = img as { width?: number; height?: number } | null;
  return `${i?.width ?? 0}x${i?.height ?? 0}`;
};
const round = (a: ArrayLike<number>, n: number) => Array.from({ length: n }, (_, i) => Math.round((a[i] ?? 0) * 1e4) / 1e4);

/** Whether a render object's state reads `array`: as a uniform buffer or a vertex buffer. */
function reads(ro: RenderObjectLike, array: ArrayLike<number>): boolean {
  for (const a of ro.getAttributes()) {
    const arr = (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute ? (a as THREE.InterleavedBufferAttribute).data.array : (a as THREE.BufferAttribute).array;
    if (arr === array) return true;
  }
  for (const g of ro.getBindings()) for (const b of g.bindings) if (b.buffer === array) return true;
  return false;
}

export function probePool(pool: FloorPool, renderer: THREE.WebGPURenderer, scene: THREE.Object3D, root: THREE.Object3D | null, data: boolean): PoolProbe {
  const internals = renderer as unknown as RendererInternals;
  const objects = internals._objects?._renderObjects ?? new Set<RenderObjectLike>();
  const byObject = new Map<THREE.Object3D, RenderObjectLike[]>();
  for (const ro of objects) {
    const l = byObject.get(ro.object) ?? [];
    l.push(ro);
    byObject.set(ro.object, l);
  }
  const under = (o: THREE.Object3D, top: THREE.Object3D | null): boolean => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === top) return true;
    return false;
  };
  const shown = (o: THREE.Object3D): boolean => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  };
  const hex = (c: unknown) => (c instanceof THREE.Color ? c.getHex() : null);
  const kits = pool.kits().map(({ key, kit }) => ({
    key,
    capacity: kit.capacity,
    meshes: kit.meshes.map((m): PooledMeshProbe => {
      const mat = m.material as THREE.MeshToonMaterial;
      const p: PooledMeshProbe = {
        name: m.name,
        uuid: m.uuid,
        count: m.count,
        capacity: m.instanceMatrix.count,
        visible: m.visible,
        castShadow: m.castShadow,
        receiveShadow: m.receiveShadow,
        material: { type: mat.type, color: hex(mat.color), emissive: hex(mat.emissive), map: mat.map ? size(mat.map.image) : null },
        inOffice: under(m, root),
        shown: shown(m),
        bound: (byObject.get(m) ?? []).map((ro) => ({ matrix: reads(ro, m.instanceMatrix.array), color: m.instanceColor ? reads(ro, m.instanceColor.array) : null })),
      };
      if (data) {
        p.matrix = round(m.instanceMatrix.array, m.count * 16);
        p.color = m.instanceColor ? round(m.instanceColor.array, m.count * 3) : null;
      }
      return p;
    }),
  }));
  const seen = new Map<string, number>();
  scene.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh) seen.set(o.uuid, (seen.get(o.uuid) ?? 0) + 1);
  });
  const v = new THREE.Vector3();
  return {
    kits,
    grown: pool.grown,
    lamps: pool.lamps.map((l) => ({
      name: l.name,
      parent: l.parent?.name ?? null,
      index: l.parent ? l.parent.children.indexOf(l) : -1,
      position: l.getWorldPosition(v).toArray().map((x) => +x.toFixed(4)),
      target: l.target.getWorldPosition(v).toArray().map((x) => +x.toFixed(4)),
      targetInScene: under(l.target, scene),
      intensity: +l.intensity.toFixed(4),
      id: l.id,
    })),
    sharedUuids: [...seen].filter(([, n]) => n > 1).map(([u]) => u),
    memory: {
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      attributes: renderer.info.memory.attributes,
      programs: renderer.info.memory.programs,
      renderObjects: objects.size,
      states: internals._nodes?.nodeBuilderCache?.size ?? -1,
      pipelines: internals._pipelines?.caches?.size ?? -1,
    },
  };
}
