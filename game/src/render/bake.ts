import * as THREE from 'three/webgpu';

/**
 * Collects static, unlit geometry into one vertex-coloured buffer: every box,
 * quad and shape added here becomes part of a single mesh (one draw call).
 * Shading is baked per face in toon steps (tops brightest, the sun side
 * next, the far side darker, undersides darkest), so the outside keeps the
 * office's cartoon look without lights, and the office's lights (dimmed on
 * an asleep floor) never touch it.
 */

const tmp = new THREE.Color();
// The sun comes from the south-east, as in the office.
const SUN = new THREE.Vector3(0.55, 0, 0.83).normalize();

export function shadeOf(nx: number, ny: number, nz: number): number {
  if (ny > 0.7) return 1;
  if (ny < -0.7) return 0.62;
  const d = nx * SUN.x + nz * SUN.z;
  return d > 0.35 ? 0.93 : d > -0.35 ? 0.83 : 0.73;
}

export class Baker {
  private pos: number[] = [];
  private col: number[] = [];

  get vertices(): number[] {
    return this.pos;
  }

  private tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, r: number, g: number, b: number): void {
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    this.col.push(r, g, b, r, g, b, r, g, b);
  }

  /** A quad a→b→c→d (counter-clockwise seen from its front), flat shaded from its normal unless `flat`. */
  quad(a: THREE.Vector3Like, b: THREE.Vector3Like, c: THREE.Vector3Like, d: THREE.Vector3Like, hex: number, flat = false): void {
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const uz = b.z - a.z;
    const vx = d.x - a.x;
    const vy = d.y - a.y;
    const vz = d.z - a.z;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const k = flat ? 1 : shadeOf(nx, ny, nz);
    tmp.set(hex);
    const [r, g, bl] = [tmp.r * k, tmp.g * k, tmp.b * k];
    this.tri(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, r, g, bl);
    this.tri(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z, r, g, bl);
  }

  /**
   * An axis-aligned box. `skip` leaves faces out (they are never seen):
   * any of 'px' 'nx' 'py' 'ny' 'pz' 'nz'.
   */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, hex: number, skip = ''): void {
    const v = (x: number, y: number, z: number) => ({ x, y, z });
    if (!skip.includes('py')) this.quad(v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0), v(x0, y1, z0), hex);
    if (!skip.includes('ny')) this.quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1), hex);
    if (!skip.includes('pz')) this.quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1), hex);
    if (!skip.includes('nz')) this.quad(v(x1, y0, z0), v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0), hex);
    if (!skip.includes('px')) this.quad(v(x1, y0, z1), v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), hex);
    if (!skip.includes('nx')) this.quad(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0), hex);
  }

  /** Any geometry, already placed (a matrix applied), shaded per vertex normal. */
  geo(g: THREE.BufferGeometry, hex: number, m?: THREE.Matrix4): void {
    let src = g.index ? g.toNonIndexed() : g;
    if (m) src = src === g ? g.clone().applyMatrix4(m) : src.applyMatrix4(m);
    if (!src.getAttribute('normal')) src.computeVertexNormals();
    const p = src.getAttribute('position');
    const n = src.getAttribute('normal');
    tmp.set(hex);
    for (let i = 0; i < p.count; i++) {
      const k = shadeOf(n.getX(i), n.getY(i), n.getZ(i));
      this.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      this.col.push(tmp.r * k, tmp.g * k, tmp.b * k);
    }
    if (src !== g) src.dispose();
  }

  /** Recolours `count` vertices from `start` (a range returned by `mark`). */
  static paint(geo: THREE.BufferGeometry, start: number, count: number, hex: number, k = 1): void {
    const c = geo.getAttribute('color') as THREE.BufferAttribute;
    tmp.set(hex);
    for (let i = start; i < start + count; i++) c.setXYZ(i, tmp.r * k, tmp.g * k, tmp.b * k);
    c.needsUpdate = true;
  }

  /** Vertex index where the next thing added starts. */
  mark(): number {
    return this.pos.length / 3;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** The unlit vertex-colour material every baked mesh uses. */
export function bakedMaterial(extra: THREE.MeshBasicNodeMaterialParameters = {}): THREE.MeshBasicNodeMaterial {
  return new THREE.MeshBasicNodeMaterial({ vertexColors: true, ...extra });
}
