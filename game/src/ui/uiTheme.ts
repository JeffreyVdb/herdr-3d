/**
 * #216: the application UI theme: what the menus, dialogs, bars, panels, boards and controls look like, and the
 * office's walls, furniture and screens (their colours: render/palette.ts, `officePalette`). Separate from
 * the transcript and terminal presets (ui/themes.ts): the three are chosen independently and nothing here reads or
 * writes theirs. Two themes, hard-coded: Quiet (the default, the navy shell the app always had) and Ubuntu (aubergine
 * surfaces, orange actions, Ubuntu and Ubuntu Mono).
 *
 * The colours and fonts themselves are CSS (ui/uiTheme.css): `:root` is Quiet, `:root[data-ui-theme='ubuntu']`
 * overrides the same custom properties, so the saved theme can style the very first frame (the inline script in
 * index.html sets the attribute before any CSS paints) and a switch is one attribute write. This module holds what the
 * script and the picker need: the ids, the storage key, the swatches' colours and the copy.
 */

export type UiThemeId = 'quiet' | 'ubuntu';

export const DEFAULT_UI_THEME: UiThemeId = 'quiet';

/** The localStorage key (also read by the inline script in index.html: keep the two in step). */
export const UI_THEME_KEY = 'h3d.theme.ui';

/** The root element's attribute (`data-ui-theme`), not `data-theme` (the transcript's). */
export const UI_THEME_ATTR = 'uiTheme';

export interface UiThemePreset {
  readonly id: UiThemeId;
  readonly label: string;
  /** The picker's description of it. */
  readonly blurb: string;
  /** The colours of its swatch (a decorative miniature: the name and the blurb carry the meaning): surface, bar, raised, action, text. */
  readonly swatch: { readonly surface: string; readonly chrome: string; readonly raised: string; readonly action: string; readonly text: string };
  /** The browser chrome colour (`<meta name="theme-color">`): the bars' colour. */
  readonly themeColor: string;
}

export const UI_THEMES: readonly [UiThemePreset, UiThemePreset] = [
  {
    id: 'quiet',
    label: 'Quiet',
    blurb: 'The current navy interface.',
    swatch: { surface: '#1c2540', chrome: '#1c2540', raised: '#2a355a', action: '#ffc233', text: '#eef2fb' },
    themeColor: '#1c2540',
  },
  {
    id: 'ubuntu',
    label: 'Ubuntu',
    blurb: 'Ubuntu purple, orange accents, Ubuntu and Ubuntu Mono.',
    swatch: { surface: '#300a24', chrome: '#2c001e', raised: '#3b1330', action: '#e95420', text: '#ffffff' },
    themeColor: '#2c001e',
  },
];

/** The picker's field label and its description. */
export const UI_THEME_FIELD = 'UI theme';
export const UI_THEME_HINT = 'Colors and fonts for menus, dialogs, bars, and controls, and the colors of the office. Transcript and terminal appearance are set separately.';

export function isUiThemeId(v: unknown): v is UiThemeId {
  return v === 'quiet' || v === 'ubuntu';
}

export function uiThemeById(id: UiThemeId): UiThemePreset {
  return UI_THEMES.find((t) => t.id === id) ?? (UI_THEMES[0] as UiThemePreset);
}
