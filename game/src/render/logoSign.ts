import * as THREE from 'three/webgpu';
import { letterbox } from './logoFit';
import type { LogoEntry } from './logos';

/**
 * M3d: a sign that shows the building's logo where it used to show the
 * building's name. The logo goes on the sign's own plate (a lit, unshaded
 * panel with a bezel) letterboxed and never stretched; with no logo, or once
 * it is gone, the name board comes back. The name mesh is only hidden, so
 * flipping between the two costs no material or geometry rebuild.
 */

export interface PlateStyle {
  plate: number;
  bezel: number;
  /** Fraction of the plate kept free round the logo. */
  pad: number;
  /** How far the bezel reaches past the plate (world units). */
  rim: number;
}

/**
 * A logo's material: unlit, drawn with premultiplied alpha, because the
 * texture is premultiplied (see `fetchLogo`): dark hidden colour under the
 * transparent edge never bleeds into the mipmaps.
 */
export function logoMaterial(texture: THREE.Texture): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ map: texture, transparent: true, depthWrite: false });
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -2;
  return m;
}

const flat = (hex: number) => {
  const m = new THREE.MeshBasicNodeMaterial({ color: hex });
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -1;
  return m;
};

export class LogoSign {
  /** Holds the plate, the bezel and the logo, placed like the name board. */
  readonly group = new THREE.Group();
  private readonly logo: THREE.Mesh;
  private shown: LogoEntry | null = null;
  private readonly own: THREE.Material[] = [];

  /**
   * `name` is the sign's name board, already placed in its parent; the plate
   * takes its place (same position, rotation and size) in the same parent.
   */
  constructor(
    private readonly name: THREE.Mesh,
    private readonly width: number,
    private readonly height: number,
    private readonly style: PlateStyle,
  ) {
    const g = this.group;
    g.name = 'logo.sign';
    g.position.copy(name.position);
    g.quaternion.copy(name.quaternion);
    g.visible = false;
    const { rim } = style;
    const bezel = new THREE.Mesh(new THREE.PlaneGeometry(width + rim * 2, height + rim * 2), flat(style.bezel));
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(width, height), flat(style.plate));
    plate.position.z = 0.004;
    this.logo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicNodeMaterial());
    this.logo.position.z = 0.008;
    this.logo.renderOrder = 1;
    this.logo.name = 'logo.image';
    this.own.push(bezel.material as THREE.Material, plate.material as THREE.Material);
    g.add(bezel, plate, this.logo);
    name.parent?.add(g);
  }

  /** Shows a logo on the plate, or the name board when null (or when the logo has no usable size). */
  set(entry: LogoEntry | null): void {
    const fit = entry ? letterbox(entry.width, entry.height, this.width, this.height, this.style.pad) : null;
    const show = entry !== null && fit !== null && fit.w > 0;
    if (show && this.shown !== entry) {
      (this.logo.material as THREE.Material).dispose();
      this.logo.material = logoMaterial(entry.texture);
      this.shown = entry;
    }
    if (!show) this.shown = null;
    if (show) {
      this.logo.scale.set(fit.w, fit.h, 1);
      this.logo.position.set(fit.x + fit.w / 2 - this.width / 2, this.height / 2 - fit.y - fit.h / 2, 0.008);
    }
    this.group.visible = show;
    this.name.visible = !show;
  }

  /** Which of the two shows (test and `__h3d` hook). */
  get showing(): 'logo' | 'name' {
    return this.group.visible ? 'logo' : 'name';
  }

  /** The hash on the plate, null when the name shows. */
  get hash(): string | null {
    return this.shown?.hash ?? null;
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const m of this.own) m.dispose();
    (this.logo.material as THREE.Material).dispose();
  }
}
