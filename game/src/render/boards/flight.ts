import * as THREE from 'three/webgpu';

/**
 * M7: a note in flight. A peeled-off issue note is carried from its board to the orchestrator's desk; a merged PR's
 * note flies off the board. Each flight is one quad with its own small canvas (a note's face drawn once), a handful at
 * a time at most; they live in the office's group, in its own coordinates.
 */

export interface FlightSpec {
  id: string;
  kind: 'peel' | 'merged';
  /** Draws the note's face over the whole canvas. */
  draw(g: CanvasRenderingContext2D, w: number, h: number): void;
  px: { w: number; h: number };
  /** The note's size in metres. */
  size: { w: number; h: number };
  from: THREE.Vector3;
  to: THREE.Vector3;
  /** The note's tilt when it leaves. */
  rot?: number;
  ms?: number;
}

interface Flight {
  spec: FlightSpec;
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  tex: THREE.CanvasTexture;
  t0: number;
  ms: number;
}

export const PEEL_MS = 1500;
export const FLY_MS = 1700;
const MAX_FLIGHTS = 8;

const smooth = (k: number) => k * k * (3 - 2 * k);

export interface FlightInfo {
  id: string;
  kind: 'peel' | 'merged';
  /** 0..1 */
  progress: number;
  at: { x: number; y: number; z: number };
}

export class NoteFlights {
  readonly group = new THREE.Group();
  private readonly flights: Flight[] = [];
  /** Flights that have ended (test hook). */
  readonly log: Array<{ id: string; kind: 'peel' | 'merged' }> = [];

  constructor() {
    this.group.name = 'board.flights';
  }

  get count(): number {
    return this.flights.length;
  }

  launch(spec: FlightSpec, now: number): void {
    if (this.flights.length >= MAX_FLIGHTS) this.end(this.flights[0] as Flight);
    const c = document.createElement('canvas');
    c.width = spec.px.w;
    c.height = spec.px.h;
    const g = c.getContext('2d');
    if (g) spec.draw(g, c.width, c.height);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.renderOrder = 4;
    mesh.frustumCulled = false;
    mesh.position.copy(spec.from);
    mesh.scale.set(spec.size.w, spec.size.h, 1);
    mesh.rotation.z = spec.rot ?? 0;
    this.group.add(mesh);
    this.flights.push({ spec, mesh, mat, tex, t0: now, ms: spec.ms ?? (spec.kind === 'peel' ? PEEL_MS : FLY_MS) });
  }

  private end(f: Flight): void {
    const i = this.flights.indexOf(f);
    if (i >= 0) this.flights.splice(i, 1);
    f.mesh.removeFromParent();
    f.mesh.geometry.dispose();
    f.mat.dispose();
    f.tex.dispose();
    this.log.push({ id: f.spec.id, kind: f.spec.kind });
  }

  /** Moves every flight; returns whether any is still in the air. */
  frame(now: number): boolean {
    for (const f of [...this.flights]) {
      const k = Math.min(1, (now - f.t0) / f.ms);
      const s = f.spec;
      if (s.kind === 'peel') {
        const e = smooth(k);
        f.mesh.position.lerpVectors(s.from, s.to, e);
        // Carried up and over: an arc, a lean into the direction of travel, a wobble.
        f.mesh.position.y += Math.sin(Math.PI * e) * 0.5;
        f.mesh.rotation.y = Math.atan2(s.to.x - s.from.x, s.to.z - s.from.z) * 0.25 * Math.sin(Math.PI * e);
        f.mesh.rotation.z = (s.rot ?? 0) * (1 - e) + Math.sin(e * Math.PI * 4) * 0.12 * (1 - e);
        const sc = 1 - 0.55 * e;
        f.mesh.scale.set(s.size.w * sc, s.size.h * sc, 1);
        f.mat.opacity = k > 0.88 ? 1 - (k - 0.88) / 0.12 : 1;
      } else {
        // Off the board and up, turning as it goes: the merge is done.
        const e = k * k * (3 - 2 * k);
        f.mesh.position.set(s.from.x + (s.to.x - s.from.x) * e, s.from.y + (s.to.y - s.from.y) * e + Math.sin(Math.PI * Math.min(1, k * 1.4)) * 0.25, s.from.z + (s.to.z - s.from.z) * e);
        f.mesh.rotation.z = (s.rot ?? 0) + e * Math.PI * 3;
        f.mesh.rotation.y = e * Math.PI * 1.5;
        const sc = 1 + 0.25 * Math.sin(Math.PI * k);
        f.mesh.scale.set(s.size.w * sc, s.size.h * sc, 1);
        f.mat.opacity = k > 0.6 ? 1 - smooth((k - 0.6) / 0.4) : 1;
      }
      if (k >= 1) this.end(f);
    }
    return this.flights.length > 0;
  }

  info(now: number): FlightInfo[] {
    return this.flights.map((f) => ({ id: f.spec.id, kind: f.spec.kind, progress: Math.min(1, (now - f.t0) / f.ms), at: { x: f.mesh.position.x, y: f.mesh.position.y, z: f.mesh.position.z } }));
  }

  clear(): void {
    for (const f of [...this.flights]) this.end(f);
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
  }
}
