import * as THREE from 'three/webgpu';
import type { Daylight } from '../world/daylight';

/**
 * M17 (#50): the light of the time of day as the scenes use it. `DaylightEase`
 * eases the minute-sampled target (daylight, warmth, the sun's direction) over
 * a few seconds so nothing pops; `lookOf` turns that state into colours and
 * intensities. The scenes only ever change colours and intensities of a light
 * set they built once (three.js recompiles when lights come or go, not when
 * they dim): see docs/decisions.md.
 */

export interface SkyState {
  /** 0 night … 1 day. */
  day: number;
  /** 0 … 1: dawn's and dusk's warm tint. */
  warmth: number;
  /** The sun's compass bearing and altitude, degrees. */
  azimuth: number;
  elevation: number;
}

export const NOON: SkyState = { day: 1, warmth: 0, azimuth: 180, elevation: 57 };

/** Seconds for the eased light to cover about 95 % of a change. */
export const EASE_S = 3;

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
/** Shortest turn from a to b, degrees. */
const turn = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;

export class DaylightEase {
  private cur: SkyState = { ...NOON };
  private goal: SkyState = { ...NOON };

  get state(): Readonly<SkyState> {
    return this.cur;
  }

  get target(): Readonly<SkyState> {
    return this.goal;
  }

  /** A new target; `snap` jumps there (first load, a pinned time: screenshots start where they will stay). */
  set(d: Pick<Daylight, 'daylight' | 'warmth' | 'azimuth' | 'elevation'>, snap: boolean): void {
    this.goal = { day: d.daylight, warmth: d.warmth, azimuth: d.azimuth, elevation: d.elevation };
    if (snap) this.cur = { ...this.goal };
  }

  /** Eases `dt` seconds towards the target; true when the state moved (the scenes need the new look). */
  step(dt: number): boolean {
    const c = this.cur;
    const g = this.goal;
    if (c.day === g.day && c.warmth === g.warmth && c.azimuth === g.azimuth && c.elevation === g.elevation) return false;
    const k = 1 - Math.exp((-3 * Math.max(0, dt)) / EASE_S);
    const near = (a: number, b: number, eps: number) => Math.abs(a - b) < eps;
    const next: SkyState = {
      day: lerp(c.day, g.day, k),
      warmth: lerp(c.warmth, g.warmth, k),
      azimuth: (c.azimuth + turn(c.azimuth, g.azimuth) * k + 360) % 360,
      elevation: lerp(c.elevation, g.elevation, k),
    };
    // Close enough: land on the target, so a settled sky stops costing anything.
    if (near(next.day, g.day, 5e-3) && near(next.warmth, g.warmth, 5e-3) && Math.abs(turn(next.azimuth, g.azimuth)) < 0.5 && near(next.elevation, g.elevation, 0.5)) this.cur = { ...g };
    else this.cur = next;
    return true;
  }
}

export interface Look {
  day: number;
  warmth: number;
  /** Street lamps and lit neighbour windows: 0 off (day) … 1 on (night). */
  lamps: number;
  /** Background and fog of the walk scene, and of the city. */
  sky: THREE.Color;
  citySky: THREE.Color;
  /** Multiplies the baked street and facade (white by day). */
  outside: THREE.Color;
  /** Multiplies the lobby's baked interior: its own lights keep it warm and bright at night. */
  inside: THREE.Color;
  /** The office's window glass from inside: the sky's colour, and more opaque in the dark. */
  glass: THREE.Color;
  glassOpacity: number;
  /** Where the sun (or, at night, the moon) shines from, before a scene turns it (compass: +x east, +z south). */
  sunDir: THREE.Vector3;
  /** Sunlight's colour: white by day, warm low down, the moon's blue at night. */
  sunColor: THREE.Color;
}

const C = (hex: number) => new THREE.Color(hex);
const PAL = {
  sky: { day: C(0xcfe6f6), night: C(0x0c1531), dusk: C(0xf2a377) },
  citySky: { day: C(0x9fd6ff), night: C(0x0a1230), dusk: C(0xe99873) },
  outside: { night: new THREE.Color(0.1, 0.12, 0.24), dusk: new THREE.Color(1, 0.74, 0.58) },
  inside: { night: new THREE.Color(0.82, 0.76, 0.64) },
  glass: C(0x9fd3f0),
  sun: { day: C(0xfff3dc), low: C(0xffb877), moon: C(0x9fb0ff) },
};
const WHITE = new THREE.Color(1, 1, 1);

/** The moon's (or the night's) direction: high, from where the noon sun stands. */
const MOON = { azimuth: 180, elevation: 60 };

/** A compass direction (towards the light) for a bearing and an altitude. */
export function compassDir(azimuth: number, elevation: number, out = new THREE.Vector3()): THREE.Vector3 {
  const a = (azimuth * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
}

export function lookOf(s: SkyState): Look {
  const { day, warmth } = s;
  const mix = (p: { day: THREE.Color; night: THREE.Color; dusk: THREE.Color }) => p.night.clone().lerp(p.day, day).lerp(p.dusk, warmth * 0.6);
  const sky = mix(PAL.sky);
  // Low sun light is warm; the moon takes over as the day goes.
  const sunDay = PAL.sun.day.clone().lerp(PAL.sun.low, warmth);
  const sunColor = PAL.sun.moon.clone().lerp(sunDay, Math.min(1, day * 1.6));
  // The sun's direction, never lower than 15° over the room (walls do not cast shadows); the moon's at night.
  const sun = compassDir(s.azimuth, Math.max(15, s.elevation));
  const moon = compassDir(MOON.azimuth, MOON.elevation);
  const w = Math.min(1, day * 2);
  const sunDir = moon.multiplyScalar(1 - w).add(sun.multiplyScalar(w)).normalize();
  return {
    day,
    warmth,
    lamps: 1 - smooth(0.25, 0.7, day),
    sky,
    citySky: mix(PAL.citySky),
    outside: PAL.outside.night.clone().lerp(WHITE, day).lerp(PAL.outside.dusk, warmth * 0.45),
    inside: PAL.inside.night.clone().lerp(WHITE, day),
    glass: sky.clone().lerp(PAL.glass, day * (1 - warmth * 0.5)),
    glassOpacity: lerp(0.34, 0.16, day),
    sunDir,
    sunColor,
  };
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Turns a compass direction into a scene's: the scene was lit from
 * `noonHeading` (degrees, compass) before M17, so the noon sun keeps coming
 * from there and the morning and evening sun swing around it.
 */
export function sceneDir(dir: THREE.Vector3, noonHeading: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(dir).applyAxisAngle(new THREE.Vector3(0, 1, 0), -((noonHeading - 180) * Math.PI) / 180);
}
