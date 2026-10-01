import * as THREE from 'three/webgpu';
import { lookOf, NOON, sceneDir, type Look } from './daylook';
import { normalBiasFor, SHADOW_MAP } from './toonSun';
import type { OfficeView } from './office';
import { STREET, type OutsideView } from './outside';

/**
 * The room light (M17): by day the sun and the sky, a little brighter than
 * before; at night a dim moon and the office's own warm light (with its
 * lamps, `OfficeView.setDaylight`). An asleep floor is darker at every hour:
 * the lights are off, only what comes in through the windows is left.
 */
const ROOM = {
  awake: { hemi: [0.5, 1.6], sun: [0.22, 2.1], sky: [0xffd9ad, 0xffffff], ground: [0x4a4150, 0xcdb58c] },
  dim: { hemi: [0.1, 0.5], sun: [0.07, 0.35], sky: [0x3c4677, 0x8f9bd6], ground: [0x1e2030, 0xcdb58c] },
} as const;
const DIM_SUN = new THREE.Color(0x9fb0ff);

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
  private dim = false;
  private look: Look = lookOf(NOON);
  /** The sun's pre-M17 bearing and distance over the room at the origin (its noon, see `sceneDir`). */
  private sunFrame = { heading: 69, dist: 10.7, target: new THREE.Vector3() };
  private readonly tmp = new THREE.Vector3();
  private readonly tc = new THREE.Color();

  constructor(shadows: boolean) {
    this.scene.name = 'walk';
    this.scene.background = new THREE.Color(STREET.sky);
    this.scene.fog = new THREE.Fog(STREET.sky, 60, 230);
    this.sun.castShadow = shadows;
    this.sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    this.sun.shadow.bias = -0.0006;
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.apply();
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
      o.setDaylight(this.look);
    }
  }

  /** The floor with an interior (or none), and the height it stands at. */
  setOffice(o: OfficeView | null, base: number): void {
    if (this.officeView !== o) {
      this.officeView?.root.removeFromParent();
      this.officeView = o;
      if (o) {
        this.scene.add(o.root);
        o.setDaylight(this.look);
      }
    }
    this.baseY = base;
    if (this.outsideView) this.outsideView.group.position.y = -base;
    // The sun lights (and shadows) the room at the origin: the office, or the lobby when there is none.
    const L = o?.layout ?? (this.outsideView ? { width: this.outsideView.plan.width, depth: this.outsideView.plan.depth } : { width: 18, depth: 14 });
    // Before M17 the sun stood at (0.8 W, 9, 0.35 D): that stays its noon.
    const ox = L.width * 0.3;
    const oz = -L.depth * 0.15;
    this.sunFrame = { heading: (Math.atan2(ox, -oz) * 180) / Math.PI, dist: Math.hypot(ox, 9, oz), target: new THREE.Vector3(L.width / 2, 0, L.depth / 2) };
    this.sun.target.position.copy(this.sunFrame.target);
    this.placeSun();
    const half = Math.max(L.width, L.depth) * 0.62;
    Object.assign(this.sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 0.5, far: 40 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.normalBias = normalBiasFor(half);
  }

  /** Room light off (an asleep floor, seen from inside or its landing). Composes with the time of day. */
  setDim(dim: boolean): void {
    if (this.dim === dim) return;
    this.dim = dim;
    this.apply();
  }

  /** M17: the time of day's light: the sky and fog, the room light, the baked street's tint, the office's lamps. */
  setDaylight(look: Look): void {
    this.look = look;
    this.apply();
    this.outsideView?.setDaylight(look);
    this.officeView?.setDaylight(look);
  }

  private apply(): void {
    const k = this.look.day;
    const r = this.dim ? ROOM.dim : ROOM.awake;
    const bg = this.scene.background as THREE.Color;
    bg.copy(this.look.sky);
    (this.scene.fog as THREE.Fog).color.copy(this.look.sky);
    this.hemi.intensity = r.hemi[0] + (r.hemi[1] - r.hemi[0]) * k;
    this.hemi.color.set(r.sky[0]).lerp(this.tc.set(r.sky[1]), k);
    this.hemi.groundColor.set(r.ground[0]).lerp(this.tc.set(r.ground[1]), k);
    this.sun.intensity = r.sun[0] + (r.sun[1] - r.sun[0]) * k;
    this.sun.color.copy(this.dim ? this.tc.copy(this.look.sunColor).lerp(DIM_SUN, 0.7) : this.look.sunColor);
    this.placeSun();
  }

  private placeSun(): void {
    const f = this.sunFrame;
    sceneDir(this.look.sunDir, f.heading, this.tmp);
    this.sun.position.copy(f.target).addScaledVector(this.tmp, f.dist);
  }

  /** Floor plan: only the room, from above. */
  setPlan(on: boolean): void {
    if (this.outsideView) this.outsideView.group.visible = !on;
  }

  dispose(): void {
    this.sun.shadow.map?.dispose();
  }
}
