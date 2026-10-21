/** Scene colours. HUD colours live in ui/uiTheme.css; status colours are shared. */

import type { Display } from '../world/derive';
import type { UiThemeId } from '../ui/uiTheme';
import { FONT } from './cards/layout';

export const SKY = 0x9fd6ff;
export const SKY_NIGHT = 0x1d2447;
export const GRASS = 0x8fcf7f;
export const ROAD = 0x9aa1ad;
export const INK = 0x1c2540;

/** Status colours: card chips, floor badges, laptop glow. Keep in sync with ui/uiTheme.css (Quiet). */
export const STATUS_COLOR: Record<Display, number> = {
  working: 0x2f6bf0,
  done: 0x12a26a,
  needs_you: 0xe8413a,
  idle: 0x7a8398,
  asleep: 0x5a5fa8,
  // #98: calm, cool and clearly not "done": the agent waits on its own background work.
  waiting: 0x1e9aa0,
};

export const STATUS_CSS: Record<Display, string> = Object.fromEntries(
  Object.entries(STATUS_COLOR).map(([k, v]) => [k, `#${v.toString(16).padStart(6, '0')}`]),
) as Record<Display, string>;

/** The same hues deepened where they carry white text (card tape, the blocked card): >= 4.5:1. Keep in sync with ui/uiTheme.css (Quiet). */
/** #83: the cardboard tape of a worker wrapping up (white text on it: 4.9:1). */
export const BOX_TAPE = '#94632f';

export const STATUS_CHIP_CSS: Record<Display, string> = { ...STATUS_CSS, done: '#0b8454', needs_you: '#d8302c', idle: '#6b7388', waiting: '#0f7378' };

/** Body tints for workers: a sunny, varied crew. */
export const BODY_TINTS = [0xffd84a, 0xffc98f, 0xa6e3c4, 0xcdb6ff, 0xa9d6ff, 0xfff0a0, 0xffb3c1];

/**
 * #118, #65: the office's screens (the floor overview on the lounge wall, the departures boards): the page's colours
 * (ui/overview.css), on canvas. The lobby's board is always Quiet's, like the lobby.
 */
export interface WallPalette {
  /** The glass. */
  ink: string;
  /** The header's rule, a chip without a run colour. */
  ink3: string;
  text: string;
  text2: string;
  text3: string;
  /** The floor's name, the departures' clocks. */
  accent: string;
  /** A split-flap digit's ground. */
  flap: string;
  /** The rules' hue (`r,g,b`): the lines that tie a child to its parent, the departures' row rules. */
  rule: string;
  /** The bezel round the glass. */
  housing: number;
  /** The face it writes with. */
  font: string;
}

export const WALL: Readonly<WallPalette> = {
  ink: '#0b1022',
  ink3: '#1c2540',
  text: '#eef2fb',
  text2: '#b9c3dc',
  text3: '#7d89ab',
  accent: '#ffc233',
  flap: '#1a2342',
  rule: '185,195,220',
  housing: 0x141a2b,
  // The HUD's face, loaded with the game: the page's condensed Archivo and Departure Mono are fetched only when the
  // page opens (a fresh load fetches the transcript preset's fonts only, #59).
  font: FONT,
};

/**
 * Ubuntu's screens: the page's Ubuntu tokens (`--ov-*` on `--surface`, `--raised`, `--hover`, `--text*`, the accent
 * text), the glass the darkest aubergine (`--chrome`, #2C001E) so the status red reads at 4.5:1 on it (4.37 on
 * `--surface`), in Ubuntu with the HUD's face behind it (Ubuntu UI loads 400 and 700 with the theme).
 */
export const WALL_UBUNTU: Readonly<WallPalette> = {
  ink: '#2c001e',
  ink3: '#5e2750',
  text: '#ffffff',
  text2: '#e8d5e2',
  text3: '#cdb1c6',
  accent: '#ff9b76',
  flap: '#3b1330',
  rule: '232,213,226',
  housing: 0x2c001e,
  font: `"Ubuntu", ${FONT}`,
};

/**
 * The office's colours. The street, the city's windows and the lobby always draw with `OFFICE` (Quiet's); a floor's
 * interior takes the UI theme's (`officePalette`), so Ubuntu's office is aubergine and orange like its menus.
 */
export interface OfficePalette {
  floor: number;
  lobby: number;
  wall: number;
  /** The board partition, the skirting, the window frames, the fire door and the mezzanine's steel. */
  boardWall: number;
  ceiling: number;
  deskTop: number;
  deskLeg: number;
  chair: number;
  chairBase: number;
  laptop: number;
  rug: number;
  sofa: number;
  cushion: number;
  wood: number;
  plant: number;
  pot: number;
  steel: number;
  plus: number;
  /** The fire door's push bar, the mezzanine's handrails and name plate. */
  accent: number;
  /** The mezzanine's glass frames and post feet, the name plate's rule and text. */
  frame: number;
  /** The fire-escape sign (and the drop zone's, in white): its ground and its words; the elevator's floor panel. */
  sign: { readonly ground: string; readonly text: string };
  liftSign: { readonly ground: string; readonly text: string };
  /** Its screens: the floor overview on the lounge wall, the departures board on the partition. */
  screens: Readonly<WallPalette>;
}

export const OFFICE: Readonly<OfficePalette> = {
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
  cushion: 0x27a3a3,
  wood: 0xb98552,
  plant: 0x3fa45b,
  pot: 0xe8e2d4,
  steel: 0xb4bcc8,
  plus: 0x2fc46a,
  accent: 0xffc233,
  frame: 0x1c2540,
  sign: { ground: '#1c2540', text: '#ffc233' },
  liftSign: { ground: '#101626', text: '#ffc233' },
  screens: WALL,
};

/**
 * Ubuntu's office: the UI theme's aubergines where Quiet has navy (`--chrome` #2C001E, `--hover` #5E2750, Canonical's
 * #77216F and #772953 for the chairs and the sofa), its orange (#E95420) where Quiet has yellow, warm grey (#AEA79F)
 * for the steel and the carpet, warm whites for the walls. Wood, plants, pots and the "+" stay: they are things, not
 * the brand, and so are the laptops.
 */
export const OFFICE_UBUNTU: Readonly<OfficePalette> = {
  ...OFFICE,
  floor: 0xcdc5bc,
  lobby: 0xe4d9e0,
  wall: 0xf7f3f0,
  boardWall: 0x5e2750,
  ceiling: 0xfdfbfa,
  deskTop: 0xfbf9f7,
  deskLeg: 0x333333,
  chair: 0x77216f,
  chairBase: 0x2c001e,
  rug: 0xe95420,
  sofa: 0x772953,
  cushion: 0x8e3a6c,
  steel: 0xaea79f,
  accent: 0xe95420,
  frame: 0x2c001e,
  sign: { ground: '#2c001e', text: '#ff9b76' },
  liftSign: { ground: '#2c001e', text: '#ff9b76' },
  screens: WALL_UBUNTU,
};

/** The office interior's colours for a UI theme. */
export function officePalette(theme: UiThemeId): Readonly<OfficePalette> {
  return theme === 'ubuntu' ? OFFICE_UBUNTU : OFFICE;
}

/** Building facade pastels, picked per building by position. */
export const BUILDING_TINTS = [0xffb8b0, 0xb6dcff, 0xbff0c9, 0xffdcb0, 0xdac3ff, 0xfff1a6];
export const LOT_TINT = 0xc9ced8;
