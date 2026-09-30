import * as THREE from 'three/webgpu';
import type { DeskSlot } from '../world/layout';
import { DESK_H } from '../world/layout';
import { layoutPrints, TRAY_H, TRAY_RECT, type PrintPick, type PrintPlace, type Tray } from '../world/prints';

/**
 * M16 phase 2: the prints on the desks (world/prints.ts says where). A desk with prints has two shallow trays and, per
 * print, a paper plane (white for what the user sent, sun-coloured for what the agent viewed or made) with the picture
 * plane on it: the decoded thumbnail as a `THREE.Texture`, or a blank tinted card while it loads and for an image with
 * nothing to show. Only the desks that are near have any (the controller in laptop/prints.ts asks); everything of a
 * desk, textures included, is disposed when it stops having them.
 *
 * The textures are counted (`ledger`): made, disposed, alive. No texture leaks past a desk that lost its prints.
 */

const PAPER: Record<Tray, number> = { in: 0xf6f4ee, out: 0x5b8cff };
const BLANK: Record<Tray, number> = { in: 0xc9cfdc, out: 0xf3e2b0 };
const TRAY: Record<Tray, number> = { in: 0xe4e0d4, out: 0xd99a1e };

export interface PrintInfo {
  key: string;
  tray: Tray;
  blank: boolean;
  loaded: boolean;
  x: number;
  z: number;
  yaw: number;
}

interface Item {
  place: PrintPlace;
  pick: PrintPick;
  paper: THREE.Mesh;
  face: THREE.Mesh;
  texture: THREE.Texture | null;
}

interface DeskPrints {
  worker: string;
  group: THREE.Group;
  items: Item[];
}

export interface Ledger {
  created: number;
  disposed: number;
  /** Bitmaps closed. */
  closed: number;
}

export class PrintMeshes {
  readonly group = new THREE.Group();
  readonly ledger: Ledger = { created: 0, disposed: 0, closed: 0 };
  private readonly desks = new Map<number, DeskPrints>();
  /** Flat, facing up: a unit square in x and z (a mesh scales it). */
  private readonly plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private readonly trayGeo = new THREE.BoxGeometry(1, 1, 1);
  private readonly paperMat = new Map<Tray, THREE.MeshBasicMaterial>();
  private readonly blankMat = new Map<Tray, THREE.MeshBasicMaterial>();
  private readonly trayMat = new Map<Tray, THREE.MeshBasicMaterial>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(private readonly slots: readonly DeskSlot[]) {
    this.group.name = 'prints';
    for (const t of ['in', 'out'] as const) {
      this.paperMat.set(t, new THREE.MeshBasicMaterial({ color: PAPER[t] }));
      this.blankMat.set(t, new THREE.MeshBasicMaterial({ color: BLANK[t] }));
      this.trayMat.set(t, new THREE.MeshBasicMaterial({ color: TRAY[t] }));
    }
  }

  /** A desk's slot transform (the same as its desk art). */
  private slotMatrix(desk: number, out: THREE.Matrix4): THREE.Matrix4 {
    const s = this.slots[desk];
    if (!s) return out.makeScale(0, 0, 0);
    this.q.setFromAxisAngle(this.up, s.yaw);
    return out.compose(this.v.set(s.seat.x, 0, s.seat.z), this.q, this.one);
  }

  // --- textures (counted) ---

  /** A texture of a decoded thumbnail; the caller hands it to `setTexture` (or `release`s it). */
  texture(bitmap: ImageBitmap): THREE.Texture {
    const t = new THREE.Texture(bitmap);
    t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.flipY = false;
    t.needsUpdate = true;
    this.ledger.created++;
    return t;
  }

  release(t: THREE.Texture): void {
    const img = t.image as { close?: () => void } | null;
    t.dispose();
    this.ledger.disposed++;
    if (img && typeof img.close === 'function') {
      img.close();
      this.ledger.closed++;
    }
  }

  get texturesAlive(): number {
    return this.ledger.created - this.ledger.disposed;
  }

  // --- desks ---

  /**
   * A desk's prints: these picks (oldest first), for this worker. Prints already there keep their textures; the others are
   * removed and their textures disposed.
   */
  setDesk(desk: number, worker: string, picks: readonly PrintPick[]): void {
    let d = this.desks.get(desk);
    if (d && d.worker !== worker) {
      this.clearDesk(desk);
      d = undefined;
    }
    if (!picks.length) {
      this.clearDesk(desk);
      return;
    }
    if (!d) {
      const g = new THREE.Group();
      g.name = `prints.${desk}`;
      g.matrixAutoUpdate = false;
      this.slotMatrix(desk, g.matrix);
      g.frustumCulled = false;
      d = { worker, group: g, items: [] };
      this.desks.set(desk, d);
      this.group.add(g);
      for (const t of ['in', 'out'] as const) g.add(this.tray(t));
    }
    const keep = new Map(d.items.map((it) => [it.pick.key, it]));
    const places = layoutPrints(worker, picks);
    const next: Item[] = [];
    picks.forEach((pick, i) => {
      const place = places[i] as PrintPlace;
      const old = keep.get(pick.key);
      if (old) {
        keep.delete(pick.key);
        this.place(old, place, pick);
        next.push(old);
        return;
      }
      next.push(this.make(d as DeskPrints, place, pick));
    });
    for (const gone of keep.values()) this.drop(d, gone);
    d.items = next;
  }

  private tray(t: Tray): THREE.Mesh {
    const r = TRAY_RECT[t];
    const mesh = new THREE.Mesh(this.trayGeo, this.trayMat.get(t));
    mesh.name = `prints.tray.${t}`;
    mesh.scale.set(r.x1 - r.x0, TRAY_H, r.z1 - r.z0);
    mesh.position.set((r.x0 + r.x1) / 2, DESK_H + TRAY_H / 2, (r.z0 + r.z1) / 2);
    return mesh;
  }

  private make(d: DeskPrints, place: PrintPlace, pick: PrintPick): Item {
    const paper = new THREE.Mesh(this.plane, this.paperMat.get(pick.tray));
    paper.name = 'prints.paper';
    const face = new THREE.Mesh(this.plane, this.blankMat.get(pick.tray));
    face.name = 'prints.face';
    face.userData.print = true;
    d.group.add(paper, face);
    const it: Item = { place, pick, paper, face, texture: null };
    this.place(it, place, pick);
    return it;
  }

  private place(it: Item, place: PrintPlace, pick: PrintPick): void {
    it.place = place;
    it.pick = pick;
    // Turned half a turn so the picture's top is away from the chair (see the plane's orientation).
    const yaw = place.yaw + Math.PI;
    it.paper.position.set(place.x, place.y, place.z);
    it.paper.rotation.set(0, yaw, 0);
    it.paper.scale.set(place.paperW, 1, place.paperH);
    it.face.position.set(place.x, place.y + 0.0004, place.z);
    it.face.rotation.set(0, yaw, 0);
    it.face.scale.set(place.w, 1, place.h);
  }

  /** Gives the print `key` of a desk its picture (the desk owns the texture from now on); false: it is not there. */
  setTexture(desk: number, key: string, tex: THREE.Texture): boolean {
    const it = this.desks.get(desk)?.items.find((x) => x.pick.key === key);
    if (!it) return false;
    if (it.texture) this.release(it.texture);
    it.texture = tex;
    const old = it.face.material as THREE.MeshBasicMaterial;
    if (old !== this.blankMat.get(it.pick.tray)) old.dispose();
    it.face.material = new THREE.MeshBasicMaterial({ map: tex });
    return true;
  }

  private drop(d: DeskPrints, it: Item): void {
    d.group.remove(it.paper, it.face);
    if (it.texture) {
      this.release(it.texture);
      it.texture = null;
      (it.face.material as THREE.Material).dispose();
    }
  }

  clearDesk(desk: number): void {
    const d = this.desks.get(desk);
    if (!d) return;
    for (const it of d.items) this.drop(d, it);
    d.items = [];
    for (const c of [...d.group.children]) {
      d.group.remove(c);
    }
    this.group.remove(d.group);
    this.desks.delete(desk);
  }

  clearAll(): void {
    for (const desk of [...this.desks.keys()]) this.clearDesk(desk);
  }

  has(desk: number): boolean {
    return this.desks.has(desk);
  }

  deskIds(): number[] {
    return [...this.desks.keys()];
  }

  /** Keys of a desk's prints that have a picture. */
  loaded(desk: number): Set<string> {
    return new Set((this.desks.get(desk)?.items ?? []).filter((i) => i.texture).map((i) => i.pick.key));
  }

  info(desk: number): { worker: string; prints: PrintInfo[] } | null {
    const d = this.desks.get(desk);
    if (!d) return null;
    return {
      worker: d.worker,
      prints: d.items.map((i) => ({ key: i.pick.key, tray: i.pick.tray, blank: i.pick.blank, loaded: !!i.texture, x: i.place.x, z: i.place.z, yaw: i.place.yaw })),
    };
  }

  picks(desk: number): PrintPick[] {
    return (this.desks.get(desk)?.items ?? []).map((i) => i.pick);
  }

  /** The print a ray hits (its paper or its picture): the desk and its index (oldest first). */
  pick(ray: THREE.Raycaster): { desk: number; index: number } | null {
    let best: { desk: number; index: number; dist: number } | null = null;
    for (const [desk, d] of this.desks) {
      d.group.updateMatrixWorld(true);
      d.items.forEach((it, index) => {
        const hit = ray.intersectObject(it.face, false)[0] ?? ray.intersectObject(it.paper, false)[0];
        if (hit && (!best || hit.distance < best.dist)) best = { desk, index, dist: hit.distance };
      });
    }
    const b = best as { desk: number; index: number } | null;
    return b ? { desk: b.desk, index: b.index } : null;
  }

  /** World position of a print's centre (test hook: aiming a camera). */
  worldPosition(desk: number, index: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    const it = this.desks.get(desk)?.items[index];
    if (!it) return null;
    this.desks.get(desk)?.group.updateMatrixWorld(true);
    return it.face.getWorldPosition(out);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  dispose(): void {
    this.clearAll();
    this.group.removeFromParent();
    this.plane.dispose();
    this.trayGeo.dispose();
    for (const m of [...this.paperMat.values(), ...this.blankMat.values(), ...this.trayMat.values()]) m.dispose();
  }
}
