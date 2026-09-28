import * as THREE from 'three/webgpu';
import type { OfficeView } from './office';
import { STREET, type OutsideView } from './outside';

/**
 * The first-person scene: the room light and the sun, the sky and its fog,
 * the building around you and the one floor with an interior. The floor with
 * an interior sits at y 0 (its own coordinates, unchanged); the building and
 * street are in absolute coordinates, shifted down by `base` (that floor's
 * height above the street), so moving to another floor re-bases both and
 * nothing on screen jumps.
 */
export class WalkView {
  readonly scene = new THREE.Scene();
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0xcdb58c, 1.5);
  private readonly sun = new THREE.DirectionalLight(0xfff3dc, 1.9);
  private outsideView: OutsideView | null = null;
  private officeView: OfficeView | null = null;
  private baseY = 0;
  private dim: boolean | null = null;

  constructor(shadows: boolean) {
    this.scene.name = 'walk';
    this.scene.background = new THREE.Color(STREET.sky);
    this.scene.fog = new THREE.Fog(STREET.sky, 60, 230);
    this.sun.castShadow = shadows;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.setDim(false);
  }

  get outside(): OutsideView | null {
    return this.outsideView;
  }

  get office(): OfficeView | null {
    return this.officeView;
  }

  get base(): number {
    return this.baseY;
  }

  setOutside(o: OutsideView | null): void {
    if (this.outsideView === o) return;
    this.outsideView?.group.removeFromParent();
    this.outsideView = o;
    if (o) {
      o.group.position.y = -this.baseY;
      this.scene.add(o.group);
    }
  }

  /** The floor with an interior (or none), and the height it stands at. */
  setOffice(o: OfficeView | null, base: number): void {
    if (this.officeView !== o) {
      this.officeView?.root.removeFromParent();
      this.officeView = o;
      if (o) this.scene.add(o.root);
    }
    this.baseY = base;
    if (this.outsideView) this.outsideView.group.position.y = -base;
    // The sun lights (and shadows) the room at the origin: the office, or the lobby when there is none.
    const L = o?.layout ?? (this.outsideView ? { width: this.outsideView.plan.width, depth: this.outsideView.plan.depth } : { width: 18, depth: 14 });
    this.sun.position.set(L.width * 0.8, 9, L.depth * 0.35);
    this.sun.target.position.set(L.width / 2, 0, L.depth / 2);
    const half = Math.max(L.width, L.depth) * 0.62;
    Object.assign(this.sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 0.5, far: 40 });
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  /** Room light off (an asleep floor, seen from inside or its landing). The street is baked: it stays daylit. */
  setDim(dim: boolean): void {
    if (this.dim === dim) return;
    this.dim = dim;
    this.hemi.intensity = dim ? 0.5 : 1.5;
    this.hemi.color.set(dim ? 0x8f9bd6 : 0xffffff);
    this.sun.intensity = dim ? 0.35 : 1.9;
    this.sun.color.set(dim ? 0x9fb0ff : 0xfff3dc);
  }

  /** Floor plan: only the room, from above. */
  setPlan(on: boolean): void {
    if (this.outsideView) this.outsideView.group.visible = !on;
  }

  dispose(): void {
    this.sun.shadow.map?.dispose();
  }
}
