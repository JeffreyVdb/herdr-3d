import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, float, mix, texture, uv, vec2, vec3 } from 'three/tsl';
import type { Display } from '../world/derive';
import { CABLE_R, DOCK, KEYBOARD, LAPTOP, monitorFrame, MONITOR, MOUSE, STICKER_D, type DeskItem, type DeskKit, type DockSide, type ItemKind } from '../world/deskKit';
import { deskKit } from '../world/deskKit';
import { CHAIR_IN_OFFSET, DESK_D, DESK_H, DESK_W, SEAT_OFFSET } from '../world/layout';
import { BAND_COLOR, BAND_WORDS, bandAtlas, stickerAtlas, stickerLogo, STICKER_LOGOS, type BandStatus } from './deskArt';
import { OFFICE } from './palette';

/**
 * Desks, chairs and what stands on them, instanced per part. Slot space:
 * origin on the floor under the seat, the worker faces +z, the desk centre is
 * at z = SEAT_OFFSET. Empty desks push their chair in and grow a floating
 * green "+".
 *
 * M6b: every desk has a monitor (its terminal area glows in the status's
 * tint where no live screen covers it, under a status bar with the status's
 * word), a wireless keyboard and mouse, a vertical dock on the pod's outer
 * side with its two cables to the monitor (`world/deskKit.ts` says where).
 * A taken desk adds the worker's laptop standing closed in the dock, its
 * harness's sticker on the lid, and the worker's own things (photos, mug,
 * plant, notebook and pens); a freelancer brings no keepsakes. The keyboard,
 * mouse, dock and cables are one merged mesh per dock side. Only the desk,
 * the chair and the monitor cast shadows. The city (`low`) draws the desk,
 * the chair and the monitor with its glow.
 */

export interface DeskState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  /** null = empty desk. */
  display: Display | null;
  cueColor: number;
  /** M4: false hides an empty desk's "+" (a hire is on its way to it, or someone just packed up). */
  plus?: boolean;
  /** M6b: the harness on the docked laptop's sticker (`resolveHarness`); none: a plain sticker. */
  harness?: string | undefined;
  /** M6b: the worker's own things are on the desk (a freelancer has none). Default: a taken desk has them. */
  personal?: boolean;
  /** M6b: this many of them are packed away already (the walk-out's box). */
  packed?: number;
  /** M6c: an orchestrator has no notebook (its in-tray stands there). */
  notebook?: boolean;
  /** M6c: the chair pushed back this far (0..1) while its worker is out delivering a report. */
  chair?: number;
}

type Key =
  | 'top'
  | 'legs'
  | 'chair'
  | 'chairBase'
  | 'plus'
  | 'monitor'
  | 'screen'
  | 'band'
  | 'kitL'
  | 'kitR'
  | 'laptop'
  | 'sticker'
  | 'led'
  | 'photo'
  | 'notebook'
  | 'pens'
  | 'mug'
  | 'plant';

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const SCREEN: Record<Display, number> = {
  working: 0xcfe2ff,
  done: 0xbff0d8,
  needs_you: 0xffb2aa,
  idle: 0x8a96b3,
  asleep: 0x161a26,
  waiting: 0x9fe0dc,
};
/** A monitor with nothing plugged in (an empty desk, a laptop packed away). */
const SCREEN_OFF = 0x0d1119;
const LED_ON = 0x3ddc84;
const LED_IDLE = 0x33403a;
const POWER_ON = 0xcfe2ff;
const POWER_STANDBY = 0xffb020;
const PEN_TINTS = [0x24406e, 0xe8413a, 0xffc233, 0x12a26a];
const C = {
  graphite: 0x262a35,
  housing: 0xaeb6c4,
  silver: 0xc3cad6,
  steel: OFFICE.steel,
  key: 0xf4f6fb,
  ink: 0x2b2f3a,
  groove: 0x1c2540,
  paper: 0xfbf7ec,
  sky: 0x9fd3f0,
  grass: 0x8fcf7f,
  coffee: 0x6b4226,
  soil: 0x6b4a32,
};
/** Per-instance attributes of a part (a custom colour mix, an atlas cell). */
type Attr = { name: string; size: number };
const PARTS: Record<Key, { per: number; shadow: boolean; low: boolean; attrs?: Attr[] }> = {
  top: { per: 1, shadow: true, low: true },
  legs: { per: 1, shadow: true, low: true },
  chair: { per: 1, shadow: true, low: true },
  chairBase: { per: 1, shadow: true, low: true },
  plus: { per: 1, shadow: false, low: false },
  monitor: { per: 1, shadow: true, low: true },
  screen: { per: 1, shadow: false, low: true },
  band: { per: 1, shadow: false, low: false, attrs: [{ name: 'aBand', size: 3 }, { name: 'aWord', size: 1 }] },
  kitL: { per: 1, shadow: false, low: false },
  kitR: { per: 1, shadow: false, low: false },
  laptop: { per: 1, shadow: false, low: false },
  sticker: { per: 1, shadow: false, low: false, attrs: [{ name: 'aRim', size: 3 }, { name: 'aLogo', size: 1 }] },
  led: { per: 2, shadow: false, low: false },
  photo: { per: 2, shadow: false, low: false, attrs: [{ name: 'aTint', size: 3 }] },
  notebook: { per: 1, shadow: false, low: false, attrs: [{ name: 'aTint', size: 3 }] },
  pens: { per: 2, shadow: false, low: false },
  mug: { per: 1, shadow: false, low: false },
  plant: { per: 1, shadow: false, low: false },
};

// ---- geometry ---------------------------------------------------------------------

/** Merges pieces painted one colour each (vertex `color`), with an optional `aMask` (1: takes the instance's tint). */
class Paint {
  private readonly pieces: THREE.BufferGeometry[] = [];

  add(g: THREE.BufferGeometry, hex: number, m?: THREE.Matrix4, mask = 0): this {
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    if (m) geo.applyMatrix4(m);
    const n = geo.getAttribute('position').count;
    const c = new THREE.Color(hex);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aMask', new THREE.BufferAttribute(new Float32Array(n).fill(mask), 1));
    for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color' && k !== 'aMask') geo.deleteAttribute(k);
    this.pieces.push(geo);
    return this;
  }

  build(): THREE.BufferGeometry {
    const out = mergeGeometries(this.pieces) as THREE.BufferGeometry;
    for (const p of this.pieces) p.dispose();
    return out;
  }
}

const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const T = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
const RY = (a: number) => new THREE.Matrix4().makeRotationY(a);

/** A rounded rectangle `w` × `h` (in x, y), `d` thick along z, centred. */
function rounded(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 2 }).translate(0, 0, -d / 2);
}

/** The monitor panel's transform in slot space: tilted back, at its place on the desk. */
function panelMatrix(): THREE.Matrix4 {
  return T(0, MONITOR.y, MONITOR.z).multiply(new THREE.Matrix4().makeRotationX(MONITOR.tilt));
}

/**
 * The monitor: a graphite bezel round the glass, an aluminium body and back
 * (light from behind, like the laptops and the dock: a pod's middle stays
 * bright), a silver neck and foot (slot space; also the corner office's).
 */
export function monitorPieces(): Array<{ geo: THREE.BufferGeometry; color: number }> {
  const M = MONITOR;
  const W = M.glassW + 2 * M.bezel;
  const H = M.glassH + 2 * M.bezel;
  const P = panelMatrix();
  const neckTop = M.y + 0.02;
  const neckZ = M.z + 0.055;
  const bezel = 0.007;
  const foot = rounded(M.footW, M.footD, 0.008, 0.035)
    .rotateX(Math.PI / 2)
    .translate(0, DESK_H + 0.008, M.footZ);
  return [
    { geo: rounded(W, H, bezel, 0.02).translate(0, 0, -M.depth / 2 + bezel / 2).applyMatrix4(P), color: C.graphite },
    { geo: rounded(W, H, M.depth - bezel, 0.02).translate(0, 0, bezel / 2).applyMatrix4(P), color: C.silver },
    { geo: rounded(W * 0.66, H * 0.64, 0.032, 0.035).translate(0, -0.01, M.depth / 2 + 0.016).applyMatrix4(P), color: C.housing },
    { geo: box(0.058, neckTop - DESK_H, 0.024, 0, (neckTop + DESK_H) / 2, neckZ), color: C.silver },
    { geo: foot, color: C.silver },
  ];
}

/** The wireless keyboard: a silver slab with white key rows (flat, on top), the space bar in the front one. */
export function keyboardPieces(): Array<{ geo: THREE.BufferGeometry; color: number }> {
  const K = KEYBOARD;
  const y = DESK_H + 0.005;
  const top = (w: number, x: number, z: number) => new THREE.PlaneGeometry(w, 0.019).rotateX(-Math.PI / 2).translate(x, y + 0.0056, z);
  const out: Array<{ geo: THREE.BufferGeometry; color: number }> = [{ geo: box(K.w, 0.01, K.d, K.x, y, K.z), color: C.silver }];
  for (let r = 0; r < 4; r++) out.push({ geo: top(K.w - 0.03, K.x, K.z + 0.045 - r * 0.024), color: C.key });
  const fz = K.z - 0.051;
  for (const [x0, x1] of [
    [-0.195, -0.085],
    [-0.075, 0.095],
    [0.105, 0.195],
  ] as const) {
    out.push({ geo: top(x1 - x0, K.x + (x0 + x1) / 2, fz), color: C.key });
  }
  return out;
}

/** The desk's own furniture for a dock side: keyboard, mouse, dock and its cables (one merged mesh). */
function kitGeometry(side: DockSide): THREE.BufferGeometry {
  const kit = deskKit({ index: side === 1 ? 1 : 0, yaw: 0 });
  const p = new Paint();
  for (const k of keyboardPieces()) p.add(k.geo, k.color);
  const mouse = new THREE.SphereGeometry(1, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2).scale(MOUSE.w / 2, MOUSE.h, MOUSE.d / 2);
  p.add(mouse, C.key, T(kit.mouse.x, DESK_H, kit.mouse.z).multiply(RY(kit.mouse.yaw)));
  // The dock: a foot plate, a low body with a rounded top gripping the laptop (a groove along it), ports on its back end.
  const D = T(kit.dock.x, DESK_H, kit.dock.z).multiply(RY(kit.dock.yaw));
  const body = 0.018;
  const r = 0.024;
  p.add(box(DOCK.w, DOCK.plate, DOCK.len, 0, DOCK.plate / 2, 0), C.steel, D);
  p.add(box(2 * r, body, DOCK.len - 0.02, 0, DOCK.plate + body / 2, 0), C.silver, D);
  const ridge = new THREE.CylinderGeometry(r, r, DOCK.len - 0.02, 8, 1, false, 0, Math.PI).rotateX(Math.PI / 2).rotateZ(Math.PI / 2);
  p.add(ridge, C.silver, D.clone().multiply(T(0, DOCK.plate + body, 0)));
  p.add(box(LAPTOP.t + 0.004, 0.004, DOCK.len - 0.05, 0, DOCK.plate + body + r - 0.001, 0), C.groove, D);
  for (const x of [-0.011, 0.011]) p.add(box(0.012, 0.007, 0.004, x, DOCK.plate + 0.012, (DOCK.len - 0.02) / 2 + 0.001), C.groove, D);
  for (const c of kit.cables) {
    const curve = new THREE.CatmullRomCurve3(c.map((q) => new THREE.Vector3(q.x, q.y, q.z)), false, 'centripetal');
    p.add(new THREE.TubeGeometry(curve, 12, CABLE_R, 3, false), C.ink);
  }
  return p.build();
}

/** The closed laptop, standing: origin at the middle of its bottom edge, the lid facing +x, its length along z. */
function laptopGeometry(): THREE.BufferGeometry {
  return new Paint()
    .add(box(LAPTOP.t, LAPTOP.h, LAPTOP.len, 0, LAPTOP.h / 2, 0), OFFICE.laptop)
    .add(box(LAPTOP.t + 0.001, 0.012, LAPTOP.len - 0.03, 0, LAPTOP.h - 0.008, 0), 0x9aa1ad)
    .add(box(0.003, LAPTOP.h - 0.03, LAPTOP.len - 0.03, -LAPTOP.t / 2 - 0.001, LAPTOP.h / 2, 0), 0x8f97a8)
    .build();
}
/** The sticker's place on the lid (laptop space). */
const STICKER_AT = T(LAPTOP.t / 2 + 0.0009, LAPTOP.h * 0.56, 0.035);

/** A framed photo of two friends, leaning back on its strut (item space: on the desk, facing the chair). The frame takes the tint. */
function photoGeometry(): THREE.BufferGeometry {
  const w = 0.135;
  const h = 0.105;
  const lean = new THREE.Matrix4().makeRotationX(0.2);
  const face = -0.0061;
  const pic = (g: THREE.BufferGeometry, dz: number) => g.rotateY(Math.PI).translate(0, 0, face - dz);
  const half = (r: number) => new THREE.CircleGeometry(r, 8, 0, Math.PI);
  return new Paint()
    .add(box(w, h, 0.012, 0, h / 2, 0), 0xffffff, lean, 1)
    .add(box(0.018, 0.085, 0.005, 0, 0.04, 0.035).rotateX(-0.45), 0xffffff, undefined, 1)
    .add(pic(new THREE.PlaneGeometry(0.105, 0.075).translate(0, h / 2, 0), 0.0004), C.sky, lean)
    .add(pic(new THREE.PlaneGeometry(0.105, 0.016).translate(0, h / 2 - 0.0295, 0), 0.0008), C.grass, lean)
    .add(pic(half(0.019).translate(-0.02, 0.016, 0), 0.0012), 0x2f6bf0, lean)
    .add(pic(half(0.017).translate(0.022, 0.016, 0), 0.0012), 0xe8413a, lean)
    .add(pic(new THREE.CircleGeometry(0.012, 8).translate(-0.02, 0.048, 0), 0.0012), 0xffd84a, lean)
    .add(pic(new THREE.CircleGeometry(0.011, 8).translate(0.022, 0.045, 0), 0.0012), 0xffc98f, lean)
    .build();
}

/** A5 notebook, closed, with an elastic band (item space; the covers take the tint). */
function notebookGeometry(): THREE.BufferGeometry {
  return new Paint()
    .add(box(0.15, 0.003, 0.2, 0, 0.0015, 0), 0xffffff, undefined, 1)
    .add(box(0.144, 0.009, 0.194, 0.002, 0.0075, 0), C.paper)
    .add(box(0.15, 0.003, 0.2, 0, 0.0135, 0), 0xffffff, undefined, 1)
    .add(box(0.007, 0.015, 0.2, -0.0715, 0.0075, 0), 0xffffff, undefined, 1)
    .add(box(0.006, 0.0155, 0.201, 0.058, 0.0078, 0), C.groove)
    .build();
}

/** A pen lying along x (the body takes the instance colour; the tip and clip stay dark). */
function penGeometry(): THREE.BufferGeometry {
  return new Paint()
    .add(new THREE.CylinderGeometry(0.0045, 0.0045, 0.12, 5, 1, true).rotateZ(Math.PI / 2), 0xffffff)
    .add(new THREE.ConeGeometry(0.0045, 0.018, 5, 1, true).rotateZ(-Math.PI / 2).translate(0.069, 0, 0), 0x3a3f4d)
    .add(box(0.04, 0.002, 0.003, -0.035, 0.005, 0), 0x9aa1ad)
    .build();
}
/** Where the pens lie on the notebook (item space). */
const PEN_AT = [T(0.005, 0.0205, 0.03).multiply(RY(0.55)), T(-0.01, 0.0205, -0.045).multiply(RY(-0.25))];

/** The mug the worker sips from (white: the instance colour tints it), coffee in it. */
function mugGeometry(): THREE.BufferGeometry {
  return new Paint()
    .add(new THREE.CylinderGeometry(0.042, 0.038, 0.095, 10).translate(0, 0.0475, 0), 0xffffff)
    .add(new THREE.CircleGeometry(0.037, 10).rotateX(-Math.PI / 2).translate(0, 0.086, 0), C.coffee)
    .add(new THREE.TorusGeometry(0.024, 0.008, 4, 6, Math.PI).rotateZ(-Math.PI / 2).translate(0.041, 0.05, 0), 0xffffff)
    .build();
}

/** The little plant: a cream pot, soil, a bushy top. */
function plantGeometry(): THREE.BufferGeometry {
  return new Paint()
    .add(new THREE.CylinderGeometry(0.052, 0.04, 0.085, 9, 1, true).translate(0, 0.0425, 0), OFFICE.pot)
    .add(new THREE.CircleGeometry(0.047, 9).rotateX(-Math.PI / 2).translate(0, 0.08, 0), C.soil)
    .add(new THREE.IcosahedronGeometry(0.068, 0).translate(0, 0.14, 0), OFFICE.plant)
    .add(new THREE.IcosahedronGeometry(0.046, 0).translate(0.032, 0.195, -0.012), 0x5cbf73)
    .add(new THREE.IcosahedronGeometry(0.04, 0).translate(-0.036, 0.18, 0.022), OFFICE.plant)
    .build();
}

/** M6b: the desk items' art (shared with the walk-out's box). */
export function itemGeometry(kind: ItemKind): THREE.BufferGeometry {
  switch (kind) {
    case 'photo':
      return photoGeometry();
    case 'notebook':
      return notebookGeometry();
    case 'mug':
      return mugGeometry();
    case 'plant':
      return plantGeometry();
  }
}

/** M6b: the laptop and its pens (shared with the walk-out's box). */
export { laptopGeometry, penGeometry, PEN_AT };

/** Toon material that mixes the vertex colour with a per-instance `aTint` where `aMask` is 1. */
export function tintMaterial(): THREE.MeshToonNodeMaterial {
  const m = new THREE.MeshToonNodeMaterial();
  m.colorNode = mix(attribute('color', 'vec3'), attribute('aTint', 'vec3'), attribute('aMask', 'float'));
  return m;
}

/** Toon material for vertex-coloured parts (times the instance colour, if any). */
const vertexMaterial = () => new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true });

/**
 * M5/M6b: the monitor's terminal area in slot space, a plane facing the
 * chair under the status bar; `lift` raises it off the glass along its
 * normal (a live screen's texture sits a hair in front of the flat glow).
 */
export function screenGeometry(lift = 0): THREE.BufferGeometry {
  const f = monitorFrame(lift);
  return new THREE.PlaneGeometry(f.width, f.height).rotateY(Math.PI).rotateX(MONITOR.tilt).translate(f.center.x, f.center.y, f.center.z);
}

/** The whole glass, status bar and terminal area: what the screen you sit at covers (a hair in front of `screenGeometry`'s). */
export function glassGeometry(lift = 0): THREE.BufferGeometry {
  const f = monitorFrame(lift);
  return new THREE.PlaneGeometry(f.width, f.glass.height).rotateY(Math.PI).rotateX(MONITOR.tilt).translate(f.glass.center.x, f.glass.center.y, f.glass.center.z);
}

/** M6b: the status bar across the top of the glass. */
function bandGeometry(): THREE.BufferGeometry {
  const f = monitorFrame(0.0004);
  return new THREE.PlaneGeometry(f.width, f.band.height).rotateY(Math.PI).rotateX(MONITOR.tilt).translate(f.band.center.x, f.band.center.y, f.band.center.z);
}

/** M5/M6b: the screen's size, centre, normal (towards the chair) and up, in slot space. */
export function screenFrame(): { width: number; height: number; center: THREE.Vector3; normal: THREE.Vector3; up: THREE.Vector3 } {
  const f = monitorFrame();
  const v = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z);
  return { width: f.width, height: f.height, center: v(f.center), normal: v(f.normal), up: v(f.up) };
}

/** The whole glass (bar included) in slot space: the screen you sit at fills it. */
export function glassFrame(): { width: number; height: number; center: THREE.Vector3; normal: THREE.Vector3; up: THREE.Vector3 } {
  const f = monitorFrame();
  const v = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z);
  return { width: f.width, height: f.glass.height, center: v(f.glass.center), normal: v(f.normal), up: v(f.up) };
}

/** The desk and chair art in slot space (shared with your own desk on the mezzanine). */
export function deskGeometries(): Record<'top' | 'legs' | 'chair' | 'chairBase' | 'plus', THREE.BufferGeometry> {
  const legH = DESK_H - 0.045;
  return {
    top: new THREE.BoxGeometry(DESK_W, 0.045, DESK_D).translate(0, DESK_H - 0.0225, SEAT_OFFSET),
    legs: mergeGeometries([
      new THREE.BoxGeometry(0.05, legH, DESK_D - 0.08).translate(-DESK_W / 2 + 0.06, legH / 2, SEAT_OFFSET),
      new THREE.BoxGeometry(0.05, legH, DESK_D - 0.08).translate(DESK_W / 2 - 0.06, legH / 2, SEAT_OFFSET),
      new THREE.BoxGeometry(DESK_W - 0.16, 0.3, 0.025).translate(0, 0.33, SEAT_OFFSET + DESK_D / 2 - 0.05),
    ]),
    chair: mergeGeometries([
      new THREE.BoxGeometry(0.46, 0.06, 0.44).translate(0, 0.42, 0),
      new THREE.BoxGeometry(0.44, 0.4, 0.05).translate(0, 0.71, -0.24),
    ]),
    chairBase: mergeGeometries([
      new THREE.CylinderGeometry(0.028, 0.028, 0.36, 8).translate(0, 0.21, 0),
      new THREE.BoxGeometry(0.5, 0.03, 0.06).translate(0, 0.03, 0),
      new THREE.BoxGeometry(0.06, 0.03, 0.5).translate(0, 0.03, 0),
    ]),
    plus: mergeGeometries([new THREE.BoxGeometry(0.36, 0.11, 0.07), new THREE.BoxGeometry(0.11, 0.36, 0.07)]),
  };
}

/** The "+" floats this high over an empty desk's centre (clear of the monitor). */
export const PLUS_Y = 1.45;

/** The worker holds its mug while idle or done (crowd.ts), #98: or waiting on its background tasks: then it is not on the desk. */
const mugInHand = (d: Display | null) => d === 'idle' || d === 'done' || d === 'waiting';

/** Per desk: the fixed local matrices of its kit's parts (slot space). */
interface DeskLocal {
  kit: DeskKit;
  laptop: THREE.Matrix4;
  sticker: THREE.Matrix4;
  dockLed: THREE.Matrix4;
  items: Array<{ item: DeskItem; m: THREE.Matrix4 }>;
  pens: THREE.Matrix4[];
}

const POWER_LED = panelMatrix().multiply(T(0, -(MONITOR.glassH / 2 + MONITOR.bezel / 2), -MONITOR.depth / 2 - 0.001));

/** A desk item's matrix in slot space (photos scaled by their size). */
export function itemMatrix(item: DeskItem): THREE.Matrix4 {
  const s = item.size;
  return T(item.x, DESK_H, item.z).multiply(RY(item.yaw)).multiply(new THREE.Matrix4().makeScale(s, s, s));
}

/** The docked laptop's matrix in slot space (its lid facing out of the pod). */
export function laptopMatrix(kit: DeskKit): THREE.Matrix4 {
  return T(kit.laptop.x, DESK_H + LAPTOP.sit, kit.laptop.z).multiply(RY(kit.laptop.yaw + (kit.side === 1 ? 0 : Math.PI)));
}

export class DeskSet {
  readonly group = new THREE.Group();
  private readonly meshes: Partial<Record<Key, THREE.InstancedMesh>>;
  private readonly attrs = new Map<string, THREE.InstancedBufferAttribute>();
  private readonly states: Array<DeskState | null>;
  private readonly local: Array<DeskLocal | null>;
  private readonly withPlus: boolean;
  private readonly low: boolean;
  private readonly m = new THREE.Matrix4();
  private readonly base = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly camPos = new THREE.Vector3();

  /**
   * `kits`: each desk's things (the office); none: the city's low desks.
   * `plus`: empty desks show their "+".
   */
  constructor(
    readonly capacity: number,
    shadows: boolean,
    o: { plus: boolean; kits?: readonly DeskKit[] },
  ) {
    this.withPlus = o.plus;
    this.low = !o.kits;
    const n = Math.max(1, capacity);
    this.local = Array.from({ length: n }, (_, i) => (o.kits?.[i] ? this.localOf(o.kits[i] as DeskKit) : null));
    const art = deskGeometries();
    const band = bandAtlas();
    const stickers = stickerAtlas();
    const geo = (k: Key): THREE.BufferGeometry => {
      switch (k) {
        case 'top':
        case 'legs':
        case 'chair':
        case 'chairBase':
        case 'plus':
          return art[k];
        case 'monitor': {
          const p = new Paint();
          if (this.low) {
            // The city: a few pixels tall, so a plain panel on a neck.
            const M = MONITOR;
            p.add(box(M.glassW + 2 * M.bezel, M.glassH + 2 * M.bezel, M.depth), C.graphite, panelMatrix());
            p.add(box(0.06, M.y - DESK_H, 0.03, 0, (M.y + DESK_H) / 2, M.z + 0.05), C.silver);
          } else for (const x of monitorPieces()) p.add(x.geo, x.color);
          return p.build();
        }
        case 'screen':
          return screenGeometry();
        case 'band':
          return bandGeometry();
        case 'kitL':
          return kitGeometry(-1);
        case 'kitR':
          return kitGeometry(1);
        case 'laptop':
          return laptopGeometry();
        case 'sticker':
          return new THREE.CircleGeometry(STICKER_D / 2, 18).rotateY(Math.PI / 2);
        case 'led':
          return box(0.009, 0.0045, 0.009);
        case 'pens':
          return penGeometry();
        default:
          return itemGeometry(k);
      }
    };
    const mat = (k: Key): THREE.Material => {
      switch (k) {
        case 'top':
          return new THREE.MeshToonMaterial({ color: OFFICE.deskTop });
        case 'legs':
          return new THREE.MeshToonMaterial({ color: OFFICE.deskLeg });
        case 'chair':
          return new THREE.MeshToonMaterial({ color: OFFICE.chair });
        case 'chairBase':
          return new THREE.MeshToonMaterial({ color: OFFICE.chairBase });
        case 'plus':
          return new THREE.MeshToonMaterial({ color: OFFICE.plus, emissive: new THREE.Color(OFFICE.plus).multiplyScalar(0.45) });
        case 'screen':
        case 'led':
          return new THREE.MeshBasicMaterial({ color: 0xffffff });
        case 'band': {
          // The bar's colour, the word in white on it (the atlas row this desk's status picks; the canvas's top row is v = 1).
          const m = new THREE.MeshBasicNodeMaterial();
          const row = float(BAND_WORDS.length - 1).sub(attribute('aWord', 'float'));
          const t = texture(band, vec2(uv().x, row.add(uv().y).div(BAND_WORDS.length)));
          m.colorNode = mix(attribute('aBand', 'vec3'), vec3(1, 1, 1), t.a);
          return m;
        }
        case 'sticker': {
          // The logo in its cell, the model family's colour in the ring round it.
          const m = new THREE.MeshToonNodeMaterial();
          const t = texture(stickers, vec2(attribute('aLogo', 'float').add(uv().x).div(STICKER_LOGOS.length), uv().y));
          m.colorNode = mix(attribute('aRim', 'vec3'), t.rgb, t.a);
          return m;
        }
        case 'photo':
        case 'notebook':
          return tintMaterial();
        default:
          return vertexMaterial();
      }
    };
    const meshes: Partial<Record<Key, THREE.InstancedMesh>> = {};
    for (const k of Object.keys(PARTS) as Key[]) {
      const d = PARTS[k];
      if (this.low && !d.low) continue;
      if (k === 'plus' && !o.plus) continue;
      const g = geo(k);
      for (const a of d.attrs ?? []) {
        const attr = new THREE.InstancedBufferAttribute(new Float32Array(n * d.per * a.size), a.size);
        g.setAttribute(a.name, attr);
        this.attrs.set(`${k}.${a.name}`, attr);
      }
      const mesh = new THREE.InstancedMesh(g, mat(k), n * d.per);
      mesh.name = `desks.${k}`;
      mesh.frustumCulled = false;
      mesh.castShadow = shadows && d.shadow;
      mesh.receiveShadow = k === 'top';
      for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, ZERO);
      if (k === 'screen' || k === 'led' || k === 'pens' || k === 'mug') for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i, this.c.set(0xffffff));
      this.group.add(mesh);
      meshes[k] = mesh;
    }
    this.meshes = meshes;
    this.states = Array.from({ length: n }, () => null);
  }

  private localOf(kit: DeskKit): DeskLocal {
    const laptop = laptopMatrix(kit);
    const tilt = new THREE.Matrix4().makeRotationX(kit.stickerTilt);
    const dock = T(kit.dock.x, DESK_H, kit.dock.z).multiply(RY(kit.dock.yaw));
    const items = kit.items.map((item) => ({ item, m: itemMatrix(item) }));
    const nb = items.find((x) => x.item.kind === 'notebook');
    const pens = nb ? PEN_AT.slice(0, nb.item.pens).map((p) => nb.m.clone().multiply(p)) : [];
    return {
      kit,
      laptop,
      sticker: laptop.clone().multiply(STICKER_AT).multiply(tilt),
      dockLed: dock.multiply(T(0.02, DOCK.plate + 0.018 + 0.0025, -(DOCK.len - 0.02) / 2 + 0.018)),
      items,
      pens,
    };
  }

  /** M6b: a desk's things (null for the city's desks). */
  kit(i: number): DeskKit | null {
    return this.local[i]?.kit ?? null;
  }

  get(i: number): DeskState | null {
    return this.states[i] ?? null;
  }

  /** The instance colours / attributes of a part at `i`. */
  private attr(k: Key, name: string): THREE.InstancedBufferAttribute | undefined {
    return this.attrs.get(`${k}.${name}`);
  }

  private put(k: Key, i: number, m: THREE.Matrix4 | null): void {
    const mesh = this.meshes[k];
    if (mesh) mesh.setMatrixAt(i, m ?? ZERO);
  }

  /** null hides the desk slot entirely. */
  set(i: number, d: DeskState | null): void {
    if (i < 0 || i >= this.capacity) return;
    this.states[i] = d;
    const M = this.meshes;
    if (!d) {
      for (const [k, mesh] of Object.entries(M) as Array<[Key, THREE.InstancedMesh]>) for (let p = 0; p < PARTS[k].per; p++) mesh.setMatrixAt(i * PARTS[k].per + p, ZERO);
    } else {
      this.q.setFromAxisAngle(this.v.set(0, 1, 0), d.yaw);
      this.base.compose(this.v.set(d.x, d.y, d.z), this.q, this.s.set(d.scale, d.scale, d.scale));
      const B = this.base;
      const taken = d.display !== null;
      for (const k of ['top', 'legs', 'monitor', 'screen'] as const) this.put(k, i, B);
      const seat = taken ? ((d.chair ?? 0) > 0 ? this.chairOut(d.chair as number) : B) : this.chairIn();
      this.put('chairBase', i, seat);
      this.put('chair', i, seat);
      M.screen?.setColorAt(i, this.c.set(d.display ? SCREEN[d.display] : SCREEN_OFF));
      if (d.display || d.plus === false) this.put('plus', i, null);
      const L = this.local[i];
      if (L) this.setKit(i, d, L, B);
    }
    for (const mesh of Object.values(M)) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** M6b: the monitor's bar, the dock's laptop and sticker, the LEDs and the worker's things. */
  private setKit(i: number, d: DeskState, L: DeskLocal, B: THREE.Matrix4): void {
    const M = this.meshes;
    const at = (m: THREE.Matrix4) => this.m.multiplyMatrices(B, m);
    const taken = d.display !== null;
    this.put('kitL', i, L.kit.side === -1 ? B : null);
    this.put('kitR', i, L.kit.side === 1 ? B : null);
    // The status bar: its colour and word (asleep or empty: dark, no bar).
    const bar = d.display && d.display !== 'asleep' ? (d.display as BandStatus) : null;
    this.put('band', i, bar ? B : null);
    if (bar) {
      this.c.set(BAND_COLOR[bar]);
      this.attr('band', 'aBand')?.setXYZ(i, this.c.r, this.c.g, this.c.b);
      this.attr('band', 'aWord')?.setX(i, BAND_WORDS.indexOf(bar));
    }
    this.put('laptop', i, taken ? at(L.laptop) : null);
    this.put('sticker', i, taken ? at(L.sticker) : null);
    if (taken) {
      this.c.set(d.cueColor);
      this.attr('sticker', 'aRim')?.setXYZ(i, this.c.r, this.c.g, this.c.b);
      this.attr('sticker', 'aLogo')?.setX(i, STICKER_LOGOS.indexOf(stickerLogo(d.harness)));
    }
    // LEDs: the dock's green with a laptop in it, the monitor's power light white (amber on standby).
    this.put('led', i * 2, at(L.dockLed));
    this.put('led', i * 2 + 1, at(POWER_LED));
    M.led?.setColorAt(i * 2, this.c.set(taken ? LED_ON : LED_IDLE));
    M.led?.setColorAt(i * 2 + 1, this.c.set(taken ? POWER_ON : POWER_STANDBY));
    // The worker's own things, minus what is packed already; the mug is in its hand while it is idle or done.
    const personal = taken && d.personal !== false;
    const packed = d.packed ?? 0;
    for (const k of ['mug', 'plant', 'notebook'] as const) this.put(k, i, null);
    for (let p = 0; p < 2; p++) {
      this.put('photo', i * 2 + p, null);
      this.put('pens', i * 2 + p, null);
    }
    const h = (i * 2654435761) >>> 0;
    L.items.forEach(({ item, m }, n) => {
      // Packing (`packed` set), the worker's hands are on the box: its mug is on the desk until it goes in.
      const show = personal && n >= packed && !(item.kind === 'mug' && d.packed === undefined && mugInHand(d.display)) && !(item.kind === 'notebook' && d.notebook === false);
      if (!show) return;
      this.c.set(item.tint);
      if (item.kind === 'photo') {
        this.put('photo', i * 2 + item.n, at(m));
        this.attr('photo', 'aTint')?.setXYZ(i * 2 + item.n, this.c.r, this.c.g, this.c.b);
      } else if (item.kind === 'notebook') {
        this.put('notebook', i, at(m));
        this.attr('notebook', 'aTint')?.setXYZ(i, this.c.r, this.c.g, this.c.b);
        L.pens.forEach((pm, k) => {
          this.put('pens', i * 2 + k, at(pm));
          M.pens?.setColorAt(i * 2 + k, this.c.set(PEN_TINTS[(h >>> (k * 4)) % PEN_TINTS.length] as number));
        });
      } else {
        this.put(item.kind, i, at(m));
        if (item.kind === 'mug') M.mug?.setColorAt(i, this.c);
      }
    });
    for (const a of this.attrs.values()) a.needsUpdate = true;
  }

  /** M6c: the chair pulled back from the desk, `k` of the way (0..1). */
  private chairOut(k: number): THREE.Matrix4 {
    return this.m.multiplyMatrices(this.base, new THREE.Matrix4().makeTranslation(0, 0, -0.34 * k));
  }

  private chairIn(): THREE.Matrix4 {
    return this.m.multiplyMatrices(this.base, new THREE.Matrix4().makeTranslation(0, 0, CHAIR_IN_OFFSET));
  }

  /** Screen flicker for working desks, and the bobbing "+" turned to the camera. */
  update(t: number, camera: THREE.Camera | null): void {
    const M = this.meshes;
    let colors = false;
    let plus = false;
    if (camera) camera.getWorldPosition(this.camPos);
    for (let i = 0; i < this.capacity; i++) {
      const d = this.states[i];
      if (!d) continue;
      if (d.display === 'working') {
        const f = 0.82 + 0.18 * Math.abs(Math.sin(t * 9.1 + i * 1.7) * Math.sin(t * 3.3 + i));
        M.screen?.setColorAt(i, this.c.set(SCREEN.working).multiplyScalar(f));
        colors = true;
      } else if (!d.display && this.withPlus && d.plus !== false) {
        // Desk centre in world space, then the "+" above it.
        const cx = d.x + Math.sin(d.yaw) * SEAT_OFFSET * d.scale;
        const cz = d.z + Math.cos(d.yaw) * SEAT_OFFSET * d.scale;
        const y = d.y + (PLUS_Y + Math.sin(t * 2 + i) * 0.05) * d.scale;
        const face = camera ? Math.atan2(this.camPos.x - cx, this.camPos.z - cz) : 0;
        this.q.setFromAxisAngle(this.v.set(0, 1, 0), face);
        M.plus?.setMatrixAt(i, this.m.compose(this.v.set(cx, y, cz), this.q, this.s.set(d.scale, d.scale, d.scale)));
        plus = true;
      }
    }
    if (colors && M.screen?.instanceColor) M.screen.instanceColor.needsUpdate = true;
    if (plus && M.plus) M.plus.instanceMatrix.needsUpdate = true;
  }

  /** Test hook: what a desk's laptop sticker shows (null: no laptop there). */
  sticker(i: number): { logo: string; rim: number } | null {
    const d = this.states[i];
    if (!d?.display || !this.local[i]) return null;
    const a = this.attr('sticker', 'aRim');
    const logo = this.attr('sticker', 'aLogo');
    if (!a || !logo) return null;
    return { logo: STICKER_LOGOS[logo.getX(i)] ?? 'plain', rim: this.c.setRGB(a.getX(i), a.getY(i), a.getZ(i)).getHex() };
  }

  /** Test hook (#98): the status word the monitor's bar shows (null: no bar). */
  band(i: number): string | null {
    const d = this.states[i];
    if (!d?.display || d.display === 'asleep' || !this.meshes.band) return null;
    const w = this.attr('band', 'aWord');
    return w ? (BAND_WORDS[w.getX(i)] ?? null) : null;
  }

  /** Test hook: the parts drawn at desk `i` (instances with a non-zero matrix), photos and pens counted. */
  drawn(i: number): Partial<Record<Key, number>> {
    const out: Partial<Record<Key, number>> = {};
    for (const [k, mesh] of Object.entries(this.meshes) as Array<[Key, THREE.InstancedMesh]>) {
      let n = 0;
      for (let p = 0; p < PARTS[k].per; p++) {
        mesh.getMatrixAt(i * PARTS[k].per + p, this.m);
        if (Math.abs(this.m.determinant()) > 1e-12) n++;
      }
      if (n) out[k] = n;
    }
    return out;
  }

  dispose(): void {
    for (const mesh of Object.values(this.meshes)) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
  }
}
