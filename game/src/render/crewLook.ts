import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CrewRole, CrewView, Lifecycle } from '../world/crew';
import { DESK_H } from '../world/layout';

/**
 * M6: what a write-code crew member wears and has about it, as instanced
 * rigid parts of the crowd (`crowd.ts` poses them; one InstancedMesh per
 * part for the whole crowd, hidden while nobody wears it, so a floor
 * without a run draws nothing more). The model cue (hat and laptop sticker)
 * stays as it is: "coders on Opus, reviewers on Sol" still reads at a glance.
 *
 * - ORCH: a headset, and on its desk a little pass board (three pips: lit
 *   in its phase colour per review pass; all red past the cap). Over the
 *   cap it sweats under a ringing red alarm clock.
 * - CODE: a hoodie's hood. REVIEW: a red bow tie, a clipboard on the desk.
 *   UX: a scarf, a tablet with swatches on the desk. GROUND: an explorer's
 *   backpack, a magnifier on the desk.
 * - Every crew member with a run wears a chest badge in the run's colour, so
 *   one run reads as a group; freelancers keep their briefcase by the chair.
 * - Lifecycle props: the brief (a scroll) while onboarding, the report folder
 *   held out towards the orchestrator (with the verdict's stamp on it).
 *
 * Worker space as in `crowd.ts`: origin at the chair seat, facing +z.
 */

export interface CrewLook {
  role: CrewRole;
  life: Lifecycle | null;
  /** The run's colour (chest badge), null: no run. */
  run: number | null;
  /** Reporting: the folder's stamp colour (the verdict), null for a report without one. */
  stamp: number | null;
  overCap: boolean;
  /** Orchestrators: review passes (the desk's pass board), null: unknown. */
  pass: number | null;
  /** Orchestrators: the lit pips' colour. */
  phaseColor: number;
  /** Reporting: how far (radians) it turns in its chair towards its orchestrator's desk. */
  turn: number;
}

export type CrewPartKey =
  | 'headset'
  | 'hood'
  | 'bowtie'
  | 'scarf'
  | 'backpack'
  | 'badge'
  | 'clipboard'
  | 'tablet'
  | 'magnifier'
  | 'passBoard'
  | 'pips'
  | 'scroll'
  | 'folder'
  | 'stamp'
  | 'briefcase'
  | 'sweat'
  | 'clock'
  | 'clockHands';

export interface CrewPartDef {
  key: CrewPartKey;
  /** Instances per member. */
  per: number;
  /** Per-instance colour (badge, pips, stamp); else vertex colours. */
  tinted: boolean;
  shadow: boolean;
  emissive?: number;
}

export const CREW_PARTS: readonly CrewPartDef[] = [
  { key: 'headset', per: 1, tinted: false, shadow: true },
  { key: 'hood', per: 1, tinted: false, shadow: true },
  { key: 'bowtie', per: 1, tinted: false, shadow: false },
  { key: 'scarf', per: 1, tinted: false, shadow: true },
  { key: 'backpack', per: 1, tinted: false, shadow: true },
  { key: 'badge', per: 1, tinted: true, shadow: false },
  { key: 'clipboard', per: 1, tinted: false, shadow: true },
  { key: 'tablet', per: 1, tinted: false, shadow: true },
  { key: 'magnifier', per: 1, tinted: false, shadow: true },
  { key: 'passBoard', per: 1, tinted: false, shadow: true },
  { key: 'pips', per: 3, tinted: true, shadow: false },
  { key: 'scroll', per: 1, tinted: false, shadow: true },
  { key: 'folder', per: 1, tinted: false, shadow: true },
  { key: 'stamp', per: 1, tinted: true, shadow: false },
  { key: 'briefcase', per: 1, tinted: false, shadow: true },
  { key: 'sweat', per: 2, tinted: false, shadow: false, emissive: 0x3a7fb0 },
  { key: 'clock', per: 1, tinted: false, shadow: false, emissive: 0x5a0c08 },
  { key: 'clockHands', per: 1, tinted: false, shadow: false },
];

/** What each role wears (body space) and has on its desk (seat space). */
export const WORN: Record<CrewRole, CrewPartKey> = { orch: 'headset', code: 'hood', review: 'bowtie', ux: 'scarf', ground: 'backpack' };
export const DESK_ITEM: Partial<Record<CrewRole, CrewPartKey>> = { review: 'clipboard', ux: 'tablet', ground: 'magnifier' };

/** Phase colours of the orchestrator's pass pips. */
export const PHASE_COLORS: Record<string, number> = {
  research: 0x8a3fc2,
  coding: 0x2f6bf0,
  review: 0xffb020,
  fixing: 0xff7a3d,
  waiting_user: 0xe8413a,
  pr: 0x12a26a,
  done: 0x12a26a,
};
export const PIP_OFF = 0xd4d8e2;
export const PIP_OVER = 0xe8413a;
/** The report folder's stamp per verdict (the card's stamp inks, a little brighter in 3D). */
export const STAMP_3D = { pass: 0x12a26a, changes: 0xe03a33, incomplete: 0x7a8398 } as const;

/** The crowd look of a crew member (`raw`: the orchestrator's raw phase, for the pips' colour). */
export function crewLookOf(c: CrewView, rawPhase: string | undefined, turn = 0): CrewLook {
  return {
    role: c.role,
    life: c.life,
    run: c.runColor,
    stamp: c.life === 'reporting' && c.stamp ? STAMP_3D[c.stamp.tone] : null,
    overCap: c.overCap,
    pass: c.pass,
    phaseColor: PHASE_COLORS[rawPhase ?? ''] ?? 0x2f6bf0,
    turn,
  };
}

/** Where the desk top is in seat space (the seat is SEAT_Y above the floor). */
export const DESK_TOP = DESK_H - 0.45;
/** The floor, in seat space. */
export const FLOOR_Y = -0.45;

/** A geometry painted one colour (vertex colours), so a multi-colour prop is one draw. */
function paint(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(color);
  const n = geo.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  geo.deleteAttribute('uv');
  return geo;
}

const merge = (...gs: THREE.BufferGeometry[]) => mergeGeometries(gs) as THREE.BufferGeometry;

export function crewGeometries(low: boolean): Record<CrewPartKey, THREE.BufferGeometry> {
  const n = (hi: number, lo: number) => (low ? lo : hi);
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: number) => paint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), color);

  // ORCH: a navy headset band over the hat, ear cups, a boom to the mouth with a yellow light.
  const headset = merge(
    paint(new THREE.TorusGeometry(0.265, 0.018, n(6, 3), n(18, 8), Math.PI).translate(0, 0.6, 0), 0x24406e),
    ...[-1, 1].map((s) => paint(new THREE.CylinderGeometry(0.075, 0.075, 0.06, n(14, 6)).rotateZ(Math.PI / 2).translate(s * 0.265, 0.6, 0), 0x1c2540)),
    paint(new THREE.CylinderGeometry(0.012, 0.012, 0.28, 6).rotateX(Math.PI / 2).rotateY(-0.55).translate(0.18, 0.5, 0.15), 0x1c2540),
    paint(new THREE.SphereGeometry(0.03, n(8, 4), n(6, 3)).translate(0.09, 0.47, 0.265), 0xffc233),
  );
  // CODE: a slate hood round the back of the head, drawstrings down the front.
  const hood = merge(
    paint(
      new THREE.SphereGeometry(0.29, n(18, 8), n(10, 4), 0, Math.PI, Math.PI * 0.3, Math.PI * 0.42).rotateY(Math.PI).translate(0, 0.55, -0.02),
      0x5b6782,
    ),
    paint(new THREE.TorusGeometry(0.262, 0.04, n(6, 3), n(20, 8)).rotateX(Math.PI / 2).translate(0, 0.33, 0), 0x5b6782),
    ...[-1, 1].map((s) => paint(new THREE.CylinderGeometry(0.009, 0.009, 0.13, 5).translate(s * 0.06, 0.26, 0.262), 0xffffff)),
  );
  // REVIEW: a red bow tie at the collar.
  const bowtie = merge(
    ...[-1, 1].map((s) => paint(new THREE.ConeGeometry(0.05, 0.09, n(4, 3)).rotateZ((s * Math.PI) / 2).translate(s * 0.048, 0.33, 0.262), 0xd8302c)),
    paint(new THREE.SphereGeometry(0.022, 6, 4).translate(0, 0.33, 0.272), 0xa81f1b),
  );
  // UX: a pink scarf with a striped tail.
  const scarf = merge(
    paint(new THREE.TorusGeometry(0.262, 0.05, n(6, 3), n(20, 8)).rotateX(Math.PI / 2).translate(0, 0.33, 0), 0xff6fa8),
    box(0.075, 0.19, 0.03, 0.12, 0.22, 0.27, 0xff6fa8),
    box(0.078, 0.025, 0.034, 0.12, 0.16, 0.27, 0xffd84a),
    box(0.078, 0.025, 0.034, 0.12, 0.21, 0.27, 0xffd84a),
  );
  // GROUND: an explorer's khaki backpack with a bedroll on top.
  const backpack = merge(
    box(0.34, 0.34, 0.14, 0, 0.38, -0.3, 0xb08d57),
    box(0.3, 0.12, 0.05, 0, 0.47, -0.385, 0x8a6a3d),
    paint(new THREE.CylinderGeometry(0.055, 0.055, 0.36, n(10, 5)).rotateZ(Math.PI / 2).translate(0, 0.6, -0.3), 0x3fa45b),
  );
  // The run badge on a lanyard: white card, the run's colour through instance colour on the stripe.
  const badge = new THREE.BoxGeometry(0.075, 0.095, 0.012).translate(-0.1, 0.3, 0.258);
  // Desk items, in seat space: the desk top is DESK_TOP up, the desk centre SEAT_OFFSET ahead.
  const clipboard = merge(
    box(0.2, 0.012, 0.27, 0, 0.006, 0, 0xa87440),
    box(0.17, 0.004, 0.22, 0, 0.014, 0.01, 0xffffff),
    ...[0, 1, 2].map((k) => box(0.12, 0.003, 0.012, -0.01, 0.017, 0.06 - k * 0.05, 0x9aa1ad)),
    box(0.07, 0.02, 0.03, 0, 0.018, -0.12, 0xc3cad6),
  ).rotateY(0.25);
  const tablet = merge(
    box(0.26, 0.014, 0.19, 0, 0.007, 0, 0x2b2f3a),
    ...[0xff6fa8, 0x4aa3f0, 0xffc21a, 0x3fa45b].map((c, k) => box(0.05, 0.003, 0.05, -0.085 + k * 0.057, 0.016, 0.02, c)),
    box(0.2, 0.003, 0.04, 0, 0.016, -0.055, 0xe9ecf2),
  ).rotateY(-0.3);
  const magnifier = merge(
    paint(new THREE.TorusGeometry(0.07, 0.013, n(6, 3), n(18, 8)).rotateX(Math.PI / 2).translate(0, 0.013, 0), 0xffc233),
    paint(new THREE.CylinderGeometry(0.065, 0.065, 0.006, n(18, 8)).translate(0, 0.012, 0), 0xcfe8ff),
    box(0.024, 0.024, 0.14, 0, 0.013, 0.14, 0x7a4a2a),
  ).rotateY(0.7);
  const passBoard = merge(box(0.26, 0.012, 0.08, 0, 0.006, 0, 0x24406e), box(0.26, 0.09, 0.012, 0, 0.05, -0.03, 0x24406e));
  const pips = new THREE.SphereGeometry(0.03, n(12, 6), n(8, 4));
  // Onboarding: the brief, a paper scroll held open in both hands.
  const scroll = merge(
    box(0.3, 0.2, 0.006, 0, 0, 0, 0xfff3d6),
    ...[-1, 1].map((s) => paint(new THREE.CylinderGeometry(0.018, 0.018, 0.23, n(8, 4)).translate(s * 0.155, 0, 0), 0xe0c38c)),
    ...[0, 1, 2].map((k) => box(0.2, 0.012, 0.004, 0, 0.05 - k * 0.045, 0.004, 0x9aa1ad)),
  );
  // Reporting: a manila folder held out; the stamp is a part of its own (the verdict's colour).
  const folder = merge(box(0.24, 0.3, 0.018, 0, 0, 0, 0xf2c46b), box(0.08, 0.03, 0.018, -0.07, 0.16, 0, 0xe0ae4f));
  const stamp = new THREE.BoxGeometry(0.15, 0.07, 0.006).rotateZ(0.18).translate(0.01, -0.04, 0.012);
  // The freelancer's briefcase; its origin is the handle, so it hangs from a hand.
  const briefcase = merge(
    box(0.34, 0.25, 0.1, 0, -0.165, 0, 0x7a4a2a),
    box(0.35, 0.02, 0.105, 0, -0.1, 0, 0x5c3620),
    paint(new THREE.TorusGeometry(0.045, 0.012, 5, n(10, 5), Math.PI).translate(0, -0.04, 0), 0x4a2c18),
    ...[-1, 1].map((s) => box(0.03, 0.03, 0.11, s * 0.09, -0.1, 0, 0xffc233)),
  );
  const sweat = paint(new THREE.SphereGeometry(0.026, n(8, 4), n(6, 3)).scale(0.8, 1.3, 0.8), 0x8fd3ff);
  // Over the cap: a red twin-bell alarm clock.
  const clock = merge(
    paint(new THREE.CylinderGeometry(0.13, 0.13, 0.07, n(20, 8)).rotateX(Math.PI / 2), 0xe8413a),
    paint(new THREE.CylinderGeometry(0.105, 0.105, 0.075, n(20, 8)).rotateX(Math.PI / 2).translate(0, 0, 0.004), 0xffffff),
    ...[-1, 1].map((s) => paint(new THREE.SphereGeometry(0.055, n(10, 5), n(6, 3), 0, Math.PI * 2, 0, Math.PI / 2).rotateZ(s * -0.6).translate(s * 0.09, 0.11, 0), 0xe8413a)),
    ...[-1, 1].map((s) => box(0.025, 0.06, 0.025, s * 0.08, -0.14, 0, 0x9e1f19)),
  );
  const clockHands = merge(box(0.014, 0.08, 0.006, 0, 0.035, 0, 0x1c2540), box(0.06, 0.012, 0.006, 0.025, 0, 0, 0x1c2540));
  return { headset, hood, bowtie, scarf, backpack, badge, clipboard, tablet, magnifier, passBoard, pips, scroll, folder, stamp, briefcase, sweat, clock, clockHands };
}
