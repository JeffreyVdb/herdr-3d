/**
 * #59: the transcript's three presets. A preset sets the monospace font (the terminal canvas, the transcript's code
 * and tool rows, the limits widget, the HUD's numbers: every `--font-mono`), the transcript's prose font and size, the
 * transcript's colours (the `--tx-*` set) and the terminal's background, text and cursor. The 16 ANSI colours stay
 * (agents' TUIs keep their meaning), and the HUD, panels and dialogs keep Recursive (`--font`).
 *
 * Exactly three, hard-coded: nothing creates, edits or imports another. Quiet is the default and today's navy screen.
 */

/** What every mono stack falls back to: system monospace faces that have the box-drawing set (DejaVu, Menlo). */
export const SYSTEM_MONO = 'ui-monospace, "SF Mono", Menlo, "DejaVu Sans Mono", "Liberation Mono", monospace';

export type ThemeId = 'terminal' | 'quiet' | 'paper';

/** The transcript's colours, as `--tx-<name>` custom properties. */
export type TxToken =
  | 'bg'
  | 'bg-2'
  | 'bg-3'
  | 'line'
  | 'text'
  | 'text-2'
  | 'text-3'
  /** The accent: links, focus, Send, running tools, hunk headers. */
  | 'blue'
  /** Text on the accent. */
  | 'on-accent'
  /** Text on the sun (and the green of a done step). */
  | 'on-sun'
  | 'green'
  | 'red'
  /** "Waiting for you": the tape and the question card's key caps. */
  | 'sun'
  /** The sun as text on the screen's background (a light screen needs a darker one). */
  | 'sun-text'
  | 'add-bg'
  | 'del-bg'
  | 'add-text'
  | 'del-text'
  | 'code-bg'
  | 'code-text'
  /** `r g b` of the overlays drawn on the screen (white on a dark one, ink on paper), used with an alpha. */
  | 'tint'
  | 'banner-bg'
  | 'ask-bg'
  | 'hl-comment'
  | 'hl-keyword'
  | 'hl-string'
  | 'hl-number'
  | 'hl-title'
  | 'hl-attr'
  | 'hl-meta';

export interface FontFaceSpec {
  weight: 400 | 700;
  italic: boolean;
}

export interface ThemePreset {
  readonly id: ThemeId;
  readonly label: string;
  /** What the picker's swatch says of it (its tooltip and accessible description). */
  readonly blurb: string;
  readonly mono: {
    /** The family the preset ships (loaded before the terminal paints with it). */
    readonly family: string;
    /** The whole stack: the family, then the system's monospace faces. */
    readonly stack: string;
    /** The transcript's mono size at 100% (px). */
    readonly size: number;
    /** A pixel font's grid (px): its sizes are whole multiples of it, or it blurs (Departure Mono: 11). */
    readonly grid?: number;
    /** The faces the terminal draws with (bold and italic are the browser's where the font has none). */
    readonly faces: readonly FontFaceSpec[];
  };
  readonly prose: {
    readonly family: string;
    readonly stack: string;
    /** The transcript's body size at 100% (px); every other size scales with it. */
    readonly size: number;
  };
  readonly palette: Readonly<Record<TxToken, string>>;
  /** The terminal canvas: background, default text, cursor (0xRRGGBB). */
  readonly screen: { readonly bg: number; readonly fg: number; readonly cursor: number };
}

const REGULAR_BOLD_ITALIC: readonly FontFaceSpec[] = [
  { weight: 400, italic: false },
  { weight: 700, italic: false },
  { weight: 400, italic: true },
  { weight: 700, italic: true },
];

const QUIET: ThemePreset = {
  id: 'quiet',
  label: 'Quiet',
  blurb: 'Slate blue, JetBrains Mono and Atkinson Hyperlegible Next',
  mono: { family: 'JetBrains Mono Variable', stack: `"JetBrains Mono Variable", "H3D Box Quiet", ${SYSTEM_MONO}`, size: 11.5, faces: REGULAR_BOLD_ITALIC },
  prose: { family: 'Atkinson Hyperlegible Next Variable', stack: '"Atkinson Hyperlegible Next Variable", system-ui, sans-serif', size: 13.5 },
  palette: {
    bg: '#0f1526',
    'bg-2': '#161e35',
    'bg-3': '#1f2a47',
    line: 'rgb(255 255 255 / 9%)',
    text: '#e4e9f6',
    'text-2': '#9aa5c3',
    'text-3': '#76819f',
    blue: '#6f9bff',
    'on-accent': '#0b1020',
    'on-sun': '#1c2540',
    green: '#4cd88a',
    red: '#ff7a72',
    sun: '#ffc233',
    'sun-text': '#ffc233',
    'add-bg': 'rgb(47 196 106 / 15%)',
    'del-bg': 'rgb(232 65 58 / 16%)',
    'add-text': '#b5f2cc',
    'del-text': '#ffc4bf',
    'code-bg': '#0a0f1c',
    'code-text': '#cdd5ea',
    tint: '255 255 255',
    'banner-bg': '#2a2413',
    'ask-bg': '#221f16',
    'hl-comment': '#76819f',
    'hl-keyword': '#c792ea',
    'hl-string': '#a5e075',
    'hl-number': '#f7a26b',
    'hl-title': '#82aaff',
    'hl-attr': '#ffcb6b',
    'hl-meta': '#ff8b82',
  },
  screen: { bg: 0x10162a, fg: 0xdde4f3, cursor: 0xffc233 },
};

const TERMINAL: ThemePreset = {
  id: 'terminal',
  label: 'Terminal',
  blurb: 'Phosphor green on black, Departure Mono and Archivo',
  // Departure Mono has one weight: bold and italic are synthesised (the canvas asks for them all the same).
  mono: { family: 'Departure Mono', stack: `"Departure Mono", ${SYSTEM_MONO}`, size: 11, grid: 11, faces: [{ weight: 400, italic: false }] },
  prose: { family: 'Archivo Variable', stack: '"Archivo Variable", system-ui, sans-serif', size: 13.5 },
  palette: {
    bg: '#050b07',
    'bg-2': '#0a1510',
    'bg-3': '#12281c',
    line: 'rgb(120 255 170 / 13%)',
    text: '#c2f7d0',
    'text-2': '#7fd39c',
    'text-3': '#5a9c72',
    blue: '#ffb000',
    'on-accent': '#0a0700',
    'on-sun': '#0a0700',
    green: '#39ff88',
    red: '#ff5f4a',
    sun: '#ffb000',
    'sun-text': '#ffb000',
    'add-bg': 'rgb(57 255 136 / 12%)',
    'del-bg': 'rgb(255 95 74 / 15%)',
    'add-text': '#a8ffc6',
    'del-text': '#ffb8ab',
    'code-bg': '#020604',
    'code-text': '#a9efbd',
    tint: '160 255 190',
    'banner-bg': '#1d1604',
    'ask-bg': '#171204',
    'hl-comment': '#5a9c72',
    'hl-keyword': '#ffb000',
    'hl-string': '#9dff5c',
    'hl-number': '#ffd166',
    'hl-title': '#5cffd6',
    'hl-attr': '#e6ff7a',
    'hl-meta': '#ff8a6b',
  },
  screen: { bg: 0x050b07, fg: 0xc2f7d0, cursor: 0xffb000 },
};

const PAPER: ThemePreset = {
  id: 'paper',
  label: 'Paper',
  blurb: 'Ink on warm paper, Space Mono and Newsreader',
  mono: { family: 'Space Mono', stack: `"Space Mono", "H3D Box Paper", ${SYSTEM_MONO}`, size: 12, faces: REGULAR_BOLD_ITALIC },
  prose: { family: 'Newsreader Variable', stack: '"Newsreader Variable", Georgia, serif', size: 15 },
  palette: {
    bg: '#f2ead8',
    'bg-2': '#e9dfc7',
    'bg-3': '#dccfb0',
    line: 'rgb(58 40 12 / 16%)',
    text: '#231d14',
    'text-2': '#54493a',
    'text-3': '#6c604d',
    blue: '#274b96',
    'on-accent': '#fbf6ea',
    'on-sun': '#231d14',
    green: '#2d7240',
    red: '#ae3226',
    sun: '#e7ad2e',
    'sun-text': '#865400',
    'add-bg': 'rgb(45 114 64 / 13%)',
    'del-bg': 'rgb(174 50 38 / 12%)',
    'add-text': '#1f5a31',
    'del-text': '#8a261c',
    'code-bg': '#faf5e9',
    'code-text': '#2a2319',
    tint: '58 40 12',
    'banner-bg': '#f7e3ad',
    'ask-bg': '#f5e6bf',
    'hl-comment': '#7a6d57',
    'hl-keyword': '#7b2d8b',
    'hl-string': '#2d6b1f',
    'hl-number': '#a4460f',
    'hl-title': '#274b96',
    'hl-attr': '#8a5a00',
    'hl-meta': '#ae3226',
  },
  screen: { bg: 0xf2ead8, fg: 0x231d14, cursor: 0x274b96 },
};

/** The three presets, in the picker's order. */
export const THEMES: readonly [ThemePreset, ThemePreset, ThemePreset] = [TERMINAL, QUIET, PAPER];

export const DEFAULT_THEME: ThemeId = 'quiet';

export function isThemeId(v: unknown): v is ThemeId {
  return v === 'terminal' || v === 'quiet' || v === 'paper';
}

export function themeById(id: ThemeId): ThemePreset {
  return THEMES.find((t) => t.id === id) ?? QUIET;
}

// ---- zoom -----------------------------------------------------------------------------------------------------

/** The font zoom, in percent: 70–200 in steps of 10, 100 is the preset's own size. */
export const ZOOM = { min: 70, max: 200, step: 10, reset: 100 } as const;

/** A zoom level from anything (a stored string, a stray number): on a step, within the range; junk is 100. */
export function clampZoom(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return ZOOM.reset;
  const stepped = Math.round(n / ZOOM.step) * ZOOM.step;
  return Math.min(ZOOM.max, Math.max(ZOOM.min, stepped));
}

/** One step in (+1) or out (−1), stopping at the ends. */
export function stepZoom(z: number, dir: 1 | -1): number {
  return clampZoom(clampZoom(z) + dir * ZOOM.step);
}

/**
 * The transcript's mono size (px) for a preset at a zoom: its size times the zoom, and for a pixel font the nearest
 * whole multiple of its grid, never under one grid (Departure Mono: 11, 22 or 33 px; 16.5 would blur).
 */
export function monoPx(t: ThemePreset, zoom: number): number {
  const px = t.mono.size * (clampZoom(zoom) / 100);
  const g = t.mono.grid;
  if (!g) return Math.round(px * 2) / 2;
  return Math.max(g, Math.round(px / g) * g);
}

/** The transcript's body size (px) for a preset at a zoom. */
export function prosePx(t: ThemePreset, zoom: number): number {
  return Math.round(t.prose.size * (clampZoom(zoom) / 100) * 4) / 4;
}

/**
 * The custom properties a preset at a zoom puts on the page: the two fonts, the transcript's sizes and colours.
 * `--tx-k` scales the transcript's other sizes (written against a 13.5px body); `--tx-mono-fs` is the mono size.
 */
export function themeVars(t: ThemePreset, zoom: number): Record<string, string> {
  const z = clampZoom(zoom);
  const vars: Record<string, string> = {
    '--font-mono': t.mono.stack,
    '--tx-mono': 'var(--font-mono)',
    '--tx-prose': t.prose.stack,
    '--tx-zoom': String(z / 100),
    '--tx-fs': `${prosePx(t, z)}px`,
    '--tx-k': String(+((t.prose.size / 13.5) * (z / 100)).toFixed(4)),
    '--tx-mono-fs': `${monoPx(t, z)}px`,
  };
  for (const [k, v] of Object.entries(t.palette)) vars[`--tx-${k}`] = v;
  return vars;
}

/** The canvas font strings a preset's terminal draws with (for `document.fonts.load`). */
export function canvasFaces(t: ThemePreset, px = 16): string[] {
  return t.mono.faces.map((f) => `${f.italic ? 'italic ' : ''}${f.weight} ${px}px "${t.mono.family}"`);
}
