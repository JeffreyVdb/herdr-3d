import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { INK } from '../render/palette';

/**
 * The receptionist: the workers' rigid-part build (docs/decisions.md), but
 * its own character so it never reads as one of them. It stands instead of
 * sitting, has two open eyes instead of goggles, a curl of hair, a navy
 * blazer in the building's signage colour with a sun-yellow name badge, and
 * a headset with a boom mic whose tip lights while it talks.
 *
 * Parts are merged by what moves together and coloured per vertex, so the
 * whole character is seven draws. Origin at the feet, facing +z, 1 unit = 1 m.
 */

export const COLORS = {
  skin: 0xff8a6b, // coral: none of the workers' tints
  blazer: 0x24406e,
  trousers: 0x1f2a45,
  shoes: 0x14192b,
  shirt: 0xf6f8fc,
  badge: 0xffc233,
  hair: 0x3b2748,
  headset: 0x2b2f3a,
  cup: 0x4a5163,
  eye: 0xffffff,
  mic: 0xffc233,
} as const;

/** Top of the head (the bubble anchors a little above it). */
export const HEAD_TOP = 1.53;
/** World point, in model space, the voice comes from and the bubble points at. */
export const MOUTH = new THREE.Vector3(0, 1.17, 0.2);
export const BUBBLE_ANCHOR = new THREE.Vector3(0, 1.68, 0);

const BODY_R = 0.27;
const BODY_Y = 1.0; // capsule centre
const SHOULDER = new THREE.Vector3(0.315, 0.98, 0.02);
/** Centre of the head's hemisphere. */
const CROWN_Y = BODY_Y + 0.26;
const EYE_Y = 1.27;
const EYE_X = 0.1;

const color = new THREE.Color();

/** Bakes a flat vertex colour into a (non-indexed-agnostic) geometry. */
function paint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  color.set(hex);
  for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** Merges painted parts; drops attributes not all of them share (uv2 etc.). */
function merge(parts: Array<[THREE.BufferGeometry, number]>): THREE.BufferGeometry {
  const gs = parts.map(([g, hex]) => {
    const p = paint(g.index ? g.toNonIndexed() : g, hex);
    for (const k of Object.keys(p.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color') p.deleteAttribute(k);
    return p;
  });
  const m = mergeGeometries(gs);
  if (!m) throw new Error('receptionist: merge failed');
  return m;
}

function torsoGeometry(): THREE.BufferGeometry {
  // Lapels along the edges of the jacket's front opening.
  const lapel = (s: number) =>
    new THREE.BoxGeometry(0.06, 0.25, 0.016)
      .rotateZ(s * 0.3)
      .translate(s * 0.062, 0.97, BODY_R + 0.012);
  const band = new THREE.TorusGeometry(0.285, 0.02, 6, 24, Math.PI).translate(0, CROWN_Y, 0);
  const cup = (s: number) => new THREE.CylinderGeometry(0.075, 0.075, 0.07, 16).rotateZ(Math.PI / 2).translate(s * 0.285, CROWN_Y - 0.02, 0);
  const cushion = (s: number) => new THREE.CylinderGeometry(0.062, 0.062, 0.03, 16).rotateZ(Math.PI / 2).translate(s * 0.255, CROWN_Y - 0.02, 0);
  // Boom from the left ear cup round the cheek to the mouth.
  const boomPath = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.3, EYE_Y - 0.05, 0.02),
    new THREE.Vector3(-0.27, EYE_Y - 0.12, 0.14),
    new THREE.Vector3(-0.18, MOUTH.y - 0.01, 0.25),
    new THREE.Vector3(-0.07, MOUTH.y - 0.02, 0.29),
  ]);
  const boom = new THREE.TubeGeometry(boomPath, 16, 0.012, 6, false);
  // A single curl of hair springing from the crown: a tightening spiral, seen side-on from the front.
  const spiral: THREE.Vector3[] = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2.4;
    const r = 0.075 * (1 - (i / 24) * 0.62);
    spiral.push(new THREE.Vector3(Math.sin(a) * r, 0.02 + (1 - Math.cos(a)) * r, 0));
  }
  const curl = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(spiral), 48, 0.024, 8, false).rotateY(-1.1).translate(0, HEAD_TOP - 0.035, 0.02);
  const root = new THREE.SphereGeometry(0.05, 12, 8).scale(1.3, 0.6, 1.1).translate(0, HEAD_TOP - 0.01, 0.01);
  return merge([
    [new THREE.CapsuleGeometry(BODY_R, 0.52, 6, 20).translate(0, BODY_Y, 0), COLORS.skin],
    // Blazer: a short open cylinder round the lower body, open at the front where the shirt shows.
    [new THREE.CylinderGeometry(BODY_R + 0.018, BODY_R + 0.028, 0.46, 24, 1, true, 0.3, Math.PI * 2 - 0.6).translate(0, 0.86, 0), COLORS.blazer],
    [new THREE.TorusGeometry(BODY_R + 0.012, 0.013, 6, 24).rotateX(Math.PI / 2).translate(0, 1.09, 0), COLORS.shirt],
    [new THREE.BoxGeometry(0.19, 0.44, 0.02).translate(0, 0.86, BODY_R - 0.006), COLORS.shirt],
    // Trousers over the round bottom, below the jacket's hem.
    [new THREE.SphereGeometry(BODY_R + 0.004, 20, 8, 0, Math.PI * 2, Math.PI / 2 + 0.35, Math.PI / 2 - 0.35).translate(0, BODY_Y - 0.26, 0), COLORS.trousers],
    [lapel(-1), COLORS.blazer],
    [lapel(1), COLORS.blazer],
    // Name badge on the left breast, turned to the jacket's surface.
    [new THREE.BoxGeometry(0.08, 0.042, 0.012).rotateY(-0.55).translate(-0.155, 1.0, 0.252), COLORS.badge],
    [band, COLORS.headset],
    [cup(-1), COLORS.headset],
    [cup(1), COLORS.headset],
    [cushion(-1), COLORS.cup],
    [cushion(1), COLORS.cup],
    [boom, COLORS.headset],
    [curl, COLORS.hair],
    [root, COLORS.hair],
  ]);
}

function legsGeometry(): THREE.BufferGeometry {
  const leg = (s: number) => new THREE.CapsuleGeometry(0.075, 0.32, 4, 10).translate(s * 0.11, 0.3, 0);
  const shoe = (s: number) => new THREE.SphereGeometry(0.09, 12, 8).scale(1, 0.55, 1.5).translate(s * 0.11, 0.05, 0.04);
  return merge([
    [leg(-1), COLORS.trousers],
    [leg(1), COLORS.trousers],
    [shoe(-1), COLORS.shoes],
    [shoe(1), COLORS.shoes],
  ]);
}

function eyesGeometry(): THREE.BufferGeometry {
  const parts: Array<[THREE.BufferGeometry, number]> = [];
  for (const s of [-1, 1]) {
    parts.push([new THREE.SphereGeometry(0.068, 16, 12).scale(1, 1.12, 0.6).translate(s * EYE_X, 0, 0), COLORS.eye]);
    parts.push([new THREE.SphereGeometry(0.034, 12, 8).scale(1, 1.1, 0.5).translate(s * EYE_X, -0.004, 0.036), INK]);
    // A catchlight keeps the eyes friendly at a distance.
    parts.push([new THREE.SphereGeometry(0.011, 8, 6).translate(s * EYE_X + 0.012, 0.016, 0.053), COLORS.eye]);
  }
  return merge(parts);
}

function armGeometry(): THREE.BufferGeometry {
  // Hangs from the shoulder pivot along -y.
  return merge([
    [new THREE.CapsuleGeometry(0.055, 0.26, 4, 10).translate(0, -0.17, 0), COLORS.blazer],
    [new THREE.SphereGeometry(0.06, 12, 8).translate(0, -0.35, 0), COLORS.skin],
  ]);
}

export interface Pose {
  /** Seconds since start. */
  t: number;
  /** 0..1: how much of a talk the character is in (mouth, mic light). */
  talk: number;
  /** 0..1: the wave of a greeting or goodbye. */
  wave: number;
  /** Yaw toward the player, radians (0 = straight ahead, +z). */
  look: number;
}

/** The receptionist's meshes and the matrix math that animates them. */
export class ReceptionistModel {
  readonly object = new THREE.Group();
  private readonly torso = new THREE.Group();
  private readonly eyes: THREE.Mesh;
  private readonly mouth: THREE.Mesh;
  private readonly micTip: THREE.Mesh;
  private readonly micMat: THREE.MeshToonMaterial;
  private readonly armL = new THREE.Group();
  private readonly armR = new THREE.Group();
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private micGlow = false;

  constructor(shadows = true) {
    this.object.name = 'receptionist';
    const toon = () => {
      const m = new THREE.MeshToonMaterial({ vertexColors: true });
      this.materials.push(m);
      return m;
    };
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, name: string, cast = shadows) => {
      this.geometries.push(g);
      const x = new THREE.Mesh(g, m);
      x.name = `receptionist.${name}`;
      x.castShadow = cast;
      return x;
    };
    const skinMat = toon();
    const legs = mesh(legsGeometry(), skinMat, 'legs');
    this.torso.add(mesh(torsoGeometry(), skinMat, 'torso'));
    this.eyes = mesh(eyesGeometry(), skinMat, 'eyes', false);
    this.eyes.position.set(0, EYE_Y, BODY_R - 0.02);
    this.torso.add(this.eyes);
    const mouthMat = new THREE.MeshToonMaterial({ color: INK });
    this.materials.push(mouthMat);
    // A smile: a half torus, and an open mouth (ellipsoid) that scales with speech.
    const smile = mesh(new THREE.TorusGeometry(0.05, 0.012, 5, 12, Math.PI).rotateZ(Math.PI), mouthMat, 'smile', false);
    smile.position.set(0, MOUTH.y + 0.02, BODY_R + 0.002);
    this.torso.add(smile);
    this.mouth = mesh(new THREE.SphereGeometry(0.04, 12, 8).scale(1, 0.7, 0.35), mouthMat, 'mouth', false);
    this.mouth.position.set(0, MOUTH.y + 0.005, BODY_R - 0.002);
    this.torso.add(this.mouth);
    this.micMat = new THREE.MeshToonMaterial({ color: COLORS.headset });
    this.materials.push(this.micMat);
    this.micTip = mesh(new THREE.SphereGeometry(0.026, 12, 8).scale(1.3, 1, 1), this.micMat, 'mic', false);
    this.micTip.position.set(-0.06, MOUTH.y - 0.02, 0.29);
    this.torso.add(this.micTip);
    const arm = armGeometry();
    for (const [g, s] of [
      [this.armL, -1],
      [this.armR, 1],
    ] as const) {
      g.position.set(s * SHOULDER.x, SHOULDER.y, SHOULDER.z);
      g.add(mesh(s < 0 ? arm : arm.clone(), skinMat, s < 0 ? 'armL' : 'armR'));
      this.torso.add(g);
    }
    this.object.add(legs, this.torso);
    this.pose({ t: 0, talk: 0, wave: 0, look: 0 });
  }

  /** Sets every moving part for a moment; cheap (a handful of transforms). */
  pose(p: Pose): void {
    const { t } = p;
    const breathe = Math.sin(t * 1.9) * 0.006;
    this.torso.position.y = breathe + p.talk * Math.abs(Math.sin(t * 5.5)) * 0.006;
    this.torso.rotation.set(Math.sin(t * 0.7) * 0.012 - p.talk * 0.03, p.look, Math.sin(t * 0.55) * 0.02);
    // Blink every ~4 s, a quick 120 ms close.
    const c = (t + 1.3) % 4.1;
    const blink = c < 0.12 ? Math.sin((c / 0.12) * Math.PI) : 0;
    this.eyes.scale.set(1, 1 - blink * 0.9, 1);
    // Talking: a syllable rhythm from two detuned sines, never quite regular.
    const syl = Math.max(0, Math.sin(t * 13.1) * 0.6 + Math.sin(t * 7.3 + 1.1) * 0.5);
    const open = p.talk * (0.25 + syl * 0.75);
    this.mouth.scale.set(1 - open * 0.15, 0.15 + open * 1.1, 1);
    this.mouth.visible = open > 0.02;
    const glow = p.talk > 0.05;
    if (glow !== this.micGlow) {
      this.micGlow = glow;
      this.micMat.color.set(glow ? COLORS.mic : COLORS.headset);
      this.micMat.emissive.set(glow ? COLORS.mic : 0x000000).multiplyScalar(glow ? 0.6 : 0);
    }
    // Arms: relaxed at the sides; the right one waves on a greeting, both gesture a little while talking.
    const sway = Math.sin(t * 1.9 + 0.5) * 0.03;
    this.armL.rotation.set(-0.1 - p.talk * 0.25 * (0.5 + 0.5 * Math.sin(t * 2.3)), 0, -0.14 + sway);
    const up = p.wave;
    this.armR.rotation.set(-0.1 - up * 0.2, 0, 0.14 - sway + up * (2.5 + Math.sin(t * 9) * 0.35));
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
