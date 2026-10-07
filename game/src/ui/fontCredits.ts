/**
 * #59: the fonts the game ships, for the credits panel (`credits.ts`) and for `FONT_LICENSES.txt`, which the build
 * writes next to the bundle (vite.config.ts) with each font's licence file in full: the OFL, the Ubuntu Font Licence
 * and the Bitstream Vera licence ask that their text go with every copy of the fonts. Pure data (the build imports it).
 */

/** Where the licence texts ship, next to index.html (the credits panel links it). */
export const FONT_LICENSES_FILE = 'FONT_LICENSES.txt';

/** A font the game ships, its copyright line and licence (the SIL Open Font License 1.1 unless it says otherwise: #172, the Ubuntu fonts' is the Ubuntu Font Licence 1.0, not the OFL). */
export interface FontCredit {
  name: string;
  /** Its licence file, from the game's directory (the npm package's, or the vendored copy's): the build ships its text. */
  licenseFile: string;
  /** What it is for in the game. */
  role: string;
  /** The copyright line of its licence file. */
  copyright: string;
  source: string;
  license?: { name: string; url: string };
}

export const OFL = { name: 'SIL OFL 1.1', url: 'https://openfontlicense.org/open-font-license-official-text/' };
/** #172: the licence of the Ubuntu and Ubuntu Mono files (their packages' LICENSE is its full text). */
export const UFL = { name: 'Ubuntu Font Licence 1.0', url: 'https://ubuntu.com/legal/font-licence' };

/** #59: the fonts: Recursive for the HUD, then each transcript preset's mono and prose faces (ui/themes.ts; Departure Mono and Archivo stay for the floor overview). */
export const FONT_CREDITS: readonly FontCredit[] = [
  { name: 'Recursive', licenseFile: 'node_modules/@fontsource-variable/recursive/LICENSE', role: 'The HUD, panels and dialogs', copyright: 'Copyright 2019 The Recursive Project Authors', source: 'https://github.com/arrowtype/recursive' },
  { name: 'Departure Mono', licenseFile: 'src/fonts/departure-mono/LICENSE', role: 'The floor overview’s figures (ids, times, counts)', copyright: 'Copyright 2022–2024 Helena Zhang (helenazhang.com)', source: 'https://github.com/rektdeckard/departure-mono' },
  { name: 'Archivo', licenseFile: 'node_modules/@fontsource-variable/archivo/LICENSE', role: 'The floor overview’s names (condensed)', copyright: 'Copyright 2020 The Archivo Project Authors', source: 'https://github.com/Omnibus-Type/Archivo' },
  { name: 'JetBrains Mono', licenseFile: 'node_modules/@fontsource-variable/jetbrains-mono/LICENSE', role: 'Quiet preset, monospace', copyright: 'Copyright 2020 The JetBrains Mono Project Authors', source: 'https://github.com/JetBrains/JetBrainsMono' },
  { name: 'Atkinson Hyperlegible Next', licenseFile: 'node_modules/@fontsource-variable/atkinson-hyperlegible-next/LICENSE', role: 'Quiet preset, text', copyright: 'Copyright 2020–2024 The Atkinson Hyperlegible Next Project Authors', source: 'https://github.com/googlefonts/atkinson-hyperlegible-next' },
  {
    name: 'Ubuntu', licenseFile: 'node_modules/@fontsource/ubuntu/LICENSE', role: 'Ubuntu preset, text (the classic family, 0.83, not Ubuntu Sans)',
    copyright: 'Copyright 2011 Canonical Ltd.', source: 'https://design.ubuntu.com/font', license: UFL,
  },
  {
    name: 'Ubuntu Mono', licenseFile: 'node_modules/@fontsource/ubuntu-mono/LICENSE', role: 'Ubuntu preset, monospace (the classic family, 0.80, not Ubuntu Sans Mono)',
    copyright: 'Copyright 2011 Canonical Ltd.', source: 'https://design.ubuntu.com/font', license: UFL,
  },
  {
    name: 'H3D Box (DejaVu Sans Mono)', licenseFile: 'src/fonts/h3d-box/LICENSE',
    role: 'Box drawing in tool output, Quiet and Ubuntu presets',
    copyright: 'Copyright 2003 Bitstream, Inc.; DejaVu changes are in the public domain; subset and renamed',
    source: 'https://github.com/dejavu-fonts/dejavu-fonts',
    license: { name: 'Bitstream Vera licence', url: 'https://dejavu-fonts.github.io/License.html' },
  },
];

/**
 * M13 (#15): the fonts the whiteboard's editor ships (@excalidraw/excalidraw 0.18.1, every family it packages, also the
 * ones its font picker hides: they are all in the build, assets/excalidraw-0.18.1/fonts/). Not all OFL: Comic Shanns
 * is MIT, the Liberation Sans it ships is the old 1.05, GPLv2 with the font exception, and Cascadia is Microsoft's
 * OFL-based licence. The licence files (src/fonts/excalidraw/) carry each font's copyright as its own files state it
 * (their name tables), and the licence texts in full. docs/research/excalidraw-integration.md, section 9.
 */
const MIT = { name: 'MIT', url: 'https://opensource.org/license/mit' };
const XL = (name: string) => `src/fonts/excalidraw/${name}/LICENSE`;
export const EXCALIDRAW_FONT_CREDITS: readonly FontCredit[] = [
  { name: 'Excalifont', licenseFile: XL('Excalifont'), role: 'Whiteboard, hand-drawn text (its default)', copyright: 'Copyright (c) 2024 by Excalidraw', source: 'https://github.com/excalidraw/excalidraw/tree/v0.18.1/packages/excalidraw/fonts/Excalifont' },
  { name: 'Virgil', licenseFile: XL('Virgil'), role: 'Whiteboard, hand-drawn text (older boards)', copyright: 'Copyright (c) 2011 by Your Own Font Foundry', source: 'https://github.com/excalidraw/virgil' },
  { name: 'Xiaolai', licenseFile: XL('Xiaolai'), role: 'Whiteboard, Chinese, Japanese and Korean in the hand-drawn text', copyright: 'Copyright © 2020 LXGW', source: 'https://github.com/lxgw/kose-font' },
  { name: 'Nunito', licenseFile: XL('Nunito'), role: 'Whiteboard, normal text', copyright: 'Copyright 2014 The Nunito Project Authors', source: 'https://github.com/googlefonts/nunito' },
  { name: 'Lilita One', licenseFile: XL('Lilita'), role: 'Whiteboard, a display text style', copyright: 'Copyright (c) 2011 Juan Montoreano', source: 'https://fonts.google.com/specimen/Lilita+One' },
  { name: 'Assistant', licenseFile: XL('Assistant'), role: 'Whiteboard, the editor’s own menus and dialogs', copyright: 'Copyright 2020 The Assistant Project Authors', source: 'https://github.com/hafontia/Assistant' },
  {
    name: 'Comic Shanns', licenseFile: XL('ComicShanns'), role: 'Whiteboard, code text',
    copyright: 'Copyright (c) 2018 Shannon Miwa; 2023 Jesus Gonzalez, Rodrigo Batista de Moraes; 2024 Fini Jastrow, Kyle Beechly',
    source: 'https://github.com/jesusmgg/comic-shanns-mono', license: MIT,
  },
  {
    name: 'Cascadia Code', licenseFile: XL('Cascadia'), role: 'Whiteboard, code text (older boards)',
    copyright: '© 2020 Microsoft Corporation', source: 'https://github.com/microsoft/cascadia-code',
    license: { name: 'Microsoft OFL-based licence', url: 'https://github.com/microsoft/cascadia-code/blob/main/LICENSE' },
  },
  {
    name: 'Liberation Sans 1.05', licenseFile: XL('Liberation'), role: 'Whiteboard, sans-serif text in exported pictures',
    copyright: 'Digitized data (c) 2007 Ascender Corporation; Copyright © 2007-2011 Red Hat, Inc.', source: 'https://github.com/liberationfonts',
    license: { name: 'GPLv2 with font exception', url: 'https://github.com/liberationfonts/liberation-sans-narrow/blob/5462920fee502b688604472e65af49af951bdd56/License.txt' },
  },
];

/** M13: the whiteboard's editor itself (MIT): its notice ships with the fonts it brings. */
export const EXCALIDRAW_NOTICE = { name: 'Excalidraw 0.18.1 (the whiteboard editor)', licenseFile: 'src/fonts/excalidraw/EXCALIDRAW-LICENSE', source: 'https://github.com/excalidraw/excalidraw', license: MIT };

/** Every font the build ships: the game's and the whiteboard's. */
export const ALL_FONT_CREDITS: readonly FontCredit[] = [...FONT_CREDITS, ...EXCALIDRAW_FONT_CREDITS];

/** `FONT_LICENSES.txt`: each font, what it is for, and its licence file's text in full (`read`: a file's text by path). */
export function fontLicensesText(read: (file: string) => string, fonts: readonly FontCredit[] = ALL_FONT_CREDITS): string {
  const rule = '='.repeat(78);
  const head = [
    'herdr-3d: the fonts this build ships and their licences, in full.',
    'Each font file is the upstream one, unmodified, except H3D Box: a renamed subset of DejaVu Sans Mono (see its entry).',
    'The Ubuntu and Ubuntu Mono files are Fontsource’s copies of the classic Ubuntu font family (0.83 and 0.80), unmodified:',
    'Copyright 2011 Canonical Ltd., licensed under the Ubuntu Font Licence 1.0 (its text is in their entries).',
  ];
  const parts = fonts.map((f) => [rule, `${f.name}: ${f.role}`, `Source: ${f.source}`, `Copyright: ${f.copyright}`, `Licence: ${(f.license ?? OFL).name}`, rule, '', read(f.licenseFile).trim()].join('\n'));
  // M13: the editor whose package ships the whiteboard's fonts (MIT asks for its notice with every copy).
  const n = EXCALIDRAW_NOTICE;
  if (fonts.some((f) => EXCALIDRAW_FONT_CREDITS.includes(f))) parts.push([rule, n.name, `Source: ${n.source}`, `Licence: ${n.license.name}`, rule, '', read(n.licenseFile).trim()].join('\n'));
  return `${[head.join('\n'), ...parts].join('\n\n')}\n`;
}
