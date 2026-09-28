/** Scene colours. HUD colours live in ui/hud.css; status colours are shared. */

import type { Display } from '../world/derive';

export const SKY = 0x9fd6ff;
export const SKY_NIGHT = 0x1d2447;
export const GRASS = 0x8fcf7f;
export const ROAD = 0x9aa1ad;
export const INK = 0x1c2540;

/** Status colours: card chips, floor badges, laptop glow. Keep in sync with hud.css. */
export const STATUS_COLOR: Record<Display, number> = {
  working: 0x2f6bf0,
  done: 0x12a26a,
  needs_you: 0xe8413a,
  idle: 0x7a8398,
  asleep: 0x5a5fa8,
};

export const STATUS_CSS: Record<Display, string> = Object.fromEntries(
  Object.entries(STATUS_COLOR).map(([k, v]) => [k, `#${v.toString(16).padStart(6, '0')}`]),
) as Record<Display, string>;

/** Body tints for workers: a sunny, varied crew. */
export const BODY_TINTS = [0xffd84a, 0xffc98f, 0xa6e3c4, 0xcdb6ff, 0xa9d6ff, 0xfff0a0, 0xffb3c1];

export const OFFICE = {
  floor: 0xd8c29a,
  lobby: 0xc9d3e3,
  wall: 0xf1f4fa,
  boardWall: 0x24406e,
  ceiling: 0xfbfcff,
  deskTop: 0xfdfdfb,
  deskLeg: 0x39425a,
  chair: 0x4b5d86,
  chairBase: 0x2a3143,
  laptop: 0xc7ccd6,
  rug: 0xf0b43c,
  sofa: 0x1f8c8c,
  wood: 0xb98552,
  plant: 0x3fa45b,
  pot: 0xe8e2d4,
  steel: 0xb4bcc8,
  plus: 0x2fc46a,
};

/** Building facade pastels, picked per building by position. */
export const BUILDING_TINTS = [0xffb8b0, 0xb6dcff, 0xbff0c9, 0xffdcb0, 0xdac3ff, 0xfff1a6];
export const LOT_TINT = 0xc9ced8;
