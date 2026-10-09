/**
 * #59 (#172): the two presets, picked apart for the two seated views. For the transcript a preset sets the monospace
 * font (its code and tool rows: `--tx-mono`), the prose font and size and the colours (the `--tx-*` set); for the
 * terminal it sets the canvas's font, background, text and cursor. The 16 ANSI colours stay (agents' TUIs keep their
 * meaning). The HUD, panels and dialogs are not themed here: #216's UI theme (ui/uiTheme.ts, ui/uiTheme.css) owns
 * `--font` and `--font-mono`, so a transcript preset never reaches the shell.
 *
 * Exactly two, hard-coded: nothing creates, edits or imports another. Quiet is the default and today's navy screen;
 * Ubuntu (#172) is the classic Ubuntu terminal purple with Ubuntu's own fonts (it replaced the Terminal and Paper presets).
 */

/** What every mono stack falls back to: system monospace faces that have the box-drawing set (DejaVu, Menlo). */
export const SYSTEM_MONO = 'ui-monospace, "SF Mono", Menlo, "DejaVu Sans Mono", "Liberation Mono", monospace';

export type ThemeId = 'ubuntu' | 'quiet';

/** The transcript's colours, as `--tx-<name>` custom properties. */
export type TxToken =
  | 'bg'
  | 'bg-2'
  | 'bg-3'
  | 'line'
  | 'text'
  | 'text-2'
  | 'text-3'
  /** The accent: focus, Send, the fill of an active control, running tools, hunk headers. */
  | 'blue'
  /** The accent as text on the screen's surfaces (links, running tools, hunk headers): a lighter one where the fill's own colour is short of 4.5:1. */
  | 'blue-text'
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
  /**
   * #206: the added and deleted rows' bands, over the code ground. The terminal's green and red as strong as the
   * highlighted tokens on them allow (every one 4.5:1); Ubuntu's green is the terminal's hue, not grey on the purple.
   */
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
    'blue-text': '#6f9bff',
    'on-accent': '#0b1020',
    'on-sun': '#1c2540',
    green: '#4cd88a',
    red: '#ff7a72',
    sun: '#ffc233',
    'sun-text': '#ffc233',
    'add-bg': 'rgb(20 200 60 / 22%)',
    'del-bg': 'rgb(232 65 58 / 30%)',
    'add-text': '#b5f2cc',
    'del-text': '#ffc4bf',
    'code-bg': '#0a0f1c',
    'code-text': '#cdd5ea',
    tint: '255 255 255',
    'banner-bg': '#2a2413',
    'ask-bg': '#221f16',
    'hl-comment': '#8e99b8',
    'hl-keyword': '#c792ea',
    'hl-string': '#a5e075',
    'hl-number': '#f7a26b',
    'hl-title': '#82aaff',
    'hl-attr': '#ffcb6b',
    'hl-meta': '#ff8b82',
  },
  screen: { bg: 0x10162a, fg: 0xdde4f3, cursor: 0xffc233 },
};

/**
 * #172: the classic Ubuntu terminal: its purple (`#300A24`, the terminal's own RGB 48, 10, 36, not a brand swatch) with
 * white text, Ubuntu orange (`#E95420`) for the accent and Ubuntu's dark and mid aubergine (`#2C001E`, `#5E2750`) for
 * the surfaces. Every text / surface pairing is 4.5:1 or better and the accent as a fill or focus ring 3:1 on the
 * surfaces it sits on, except the orange as text on the raised surfaces, which is why links use the lighter
 * `blue-text`; white on the orange fill is 3.65:1, so `on-accent` is the dark aubergine (5.1:1).
 * Ubuntu Mono has an advance of 0.5 em, narrower than JetBrains Mono's 0.6, and a small x-height: at 12 px it read as
 * small print beside the 13.5 px prose. 14 px gives it the prose's x-height and a whole 7 px cell (Quiet's is 6.9 px);
 * a half-pixel advance (13 px: 6.5) is rounded per font on platforms without subpixel text, and the box fallback
 * rounded the other way.
 */
const UBUNTU: ThemePreset = {
  id: 'ubuntu',
  label: 'Ubuntu',
  blurb: 'Classic Ubuntu purple, Ubuntu and Ubuntu Mono',
  mono: { family: 'Ubuntu Mono', stack: `"Ubuntu Mono", "H3D Box Ubuntu", "H3D Symbols Ubuntu", "H3D Symbols Ubuntu 2", "H3D Symbols Ubuntu Consolas", ${SYSTEM_MONO}`, size: 14, faces: REGULAR_BOLD_ITALIC },
  prose: { family: 'Ubuntu', stack: '"Ubuntu", system-ui, sans-serif', size: 13.5 },
  palette: {
    bg: '#300a24',
    'bg-2': '#3b1330',
    'bg-3': '#5e2750',
    line: 'rgb(255 255 255 / 14%)',
    text: '#ffffff',
    'text-2': '#e8d5e2',
    'text-3': '#cdb1c6',
    blue: '#e95420',
    'blue-text': '#ff9b76',
    'on-accent': '#2c001e',
    'on-sun': '#2c001e',
    green: '#6be08f',
    red: '#ff8a80',
    sun: '#ffc83d',
    'sun-text': '#ffc83d',
    'add-bg': 'rgb(20 200 60 / 36%)',
    'del-bg': 'rgb(232 65 58 / 36%)',
    'add-text': '#b8f5cb',
    'del-text': '#ffc9c4',
    'code-bg': '#2c001e',
    'code-text': '#f3e6ef',
    tint: '255 255 255',
    'banner-bg': '#3f2312',
    'ask-bg': '#3a1a24',
    'hl-comment': '#c9a8c0',
    'hl-keyword': '#ff9b76',
    'hl-string': '#a6e887',
    'hl-number': '#ffcb6b',
    'hl-title': '#8ec9ff',
    'hl-attr': '#f7e27a',
    'hl-meta': '#ff9ac1',
  },
  screen: { bg: 0x300a24, fg: 0xffffff, cursor: 0xe95420 },
};

/** The two presets, in the picker's order. */
export const THEMES: readonly [ThemePreset, ThemePreset] = [UBUNTU, QUIET];

export const DEFAULT_THEME: ThemeId = 'quiet';

export function isThemeId(v: unknown): v is ThemeId {
  return v === 'ubuntu' || v === 'quiet';
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

/** The transcript's mono size (px) for a preset at a zoom: its size times the zoom, to the half pixel. */
export function monoPx(t: ThemePreset, zoom: number): number {
  return Math.round(t.mono.size * (clampZoom(zoom) / 100) * 2) / 2;
}

/** The transcript's body size (px) for a preset at a zoom. */
export function prosePx(t: ThemePreset, zoom: number): number {
  return Math.round(t.prose.size * (clampZoom(zoom) / 100) * 4) / 4;
}

/**
 * The custom properties a preset at a zoom puts on the page: the transcript's two fonts, sizes and colours.
 * `--tx-k` scales the transcript's other sizes (written against a 13.5px body); `--tx-mono-fs` is the mono size.
 */
export function themeVars(t: ThemePreset, zoom: number): Record<string, string> {
  const z = clampZoom(zoom);
  const vars: Record<string, string> = {
    '--tx-mono': t.mono.stack,
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
