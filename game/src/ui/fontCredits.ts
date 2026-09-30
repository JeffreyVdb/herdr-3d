/**
 * #59: the fonts the game ships, for the credits panel (`credits.ts`) and for `FONT_LICENSES.txt`, which the build
 * writes next to the bundle (vite.config.ts) with each font's licence file in full: the OFL and the Bitstream Vera
 * licence ask that their text go with every copy of the fonts. Pure data (the build imports it).
 */

/** Where the licence texts ship, next to index.html (the credits panel links it). */
export const FONT_LICENSES_FILE = 'FONT_LICENSES.txt';

/** A font the game ships, its copyright line and licence (the SIL Open Font License 1.1 unless it says otherwise). */
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

/** #59: the fonts: Recursive for the HUD, then each transcript preset's mono and prose faces (ui/themes.ts). */
export const FONT_CREDITS: readonly FontCredit[] = [
  { name: 'Recursive', licenseFile: 'node_modules/@fontsource-variable/recursive/LICENSE', role: 'The HUD, panels and dialogs', copyright: 'Copyright 2019 The Recursive Project Authors', source: 'https://github.com/arrowtype/recursive' },
  { name: 'Departure Mono', licenseFile: 'src/fonts/departure-mono/LICENSE', role: 'Terminal preset, monospace', copyright: 'Copyright 2022–2024 Helena Zhang (helenazhang.com)', source: 'https://github.com/rektdeckard/departure-mono' },
  { name: 'Archivo', licenseFile: 'node_modules/@fontsource-variable/archivo/LICENSE', role: 'Terminal preset, text', copyright: 'Copyright 2020 The Archivo Project Authors', source: 'https://github.com/Omnibus-Type/Archivo' },
  { name: 'JetBrains Mono', licenseFile: 'node_modules/@fontsource-variable/jetbrains-mono/LICENSE', role: 'Quiet preset, monospace', copyright: 'Copyright 2020 The JetBrains Mono Project Authors', source: 'https://github.com/JetBrains/JetBrainsMono' },
  { name: 'Atkinson Hyperlegible Next', licenseFile: 'node_modules/@fontsource-variable/atkinson-hyperlegible-next/LICENSE', role: 'Quiet preset, text', copyright: 'Copyright 2020–2024 The Atkinson Hyperlegible Next Project Authors', source: 'https://github.com/googlefonts/atkinson-hyperlegible-next' },
  { name: 'Space Mono', licenseFile: 'node_modules/@fontsource/space-mono/LICENSE', role: 'Paper preset, monospace', copyright: 'Copyright 2016 The Space Mono Project Authors', source: 'https://github.com/googlefonts/spacemono' },
  { name: 'Newsreader', licenseFile: 'node_modules/@fontsource-variable/newsreader/LICENSE', role: 'Paper preset, text', copyright: 'Copyright 2020 The Newsreader Project Authors', source: 'https://github.com/productiontype/Newsreader' },
  {
    name: 'H3D Box (DejaVu Sans Mono)', licenseFile: 'src/fonts/h3d-box/LICENSE',
    role: 'Box drawing in tool output, Quiet and Paper presets',
    copyright: 'Copyright 2003 Bitstream, Inc.; DejaVu changes are in the public domain; subset and renamed',
    source: 'https://github.com/dejavu-fonts/dejavu-fonts',
    license: { name: 'Bitstream Vera licence', url: 'https://dejavu-fonts.github.io/License.html' },
  },
];

/** `FONT_LICENSES.txt`: each font, what it is for, and its licence file's text in full (`read`: a file's text by path). */
export function fontLicensesText(read: (file: string) => string, fonts: readonly FontCredit[] = FONT_CREDITS): string {
  const rule = '='.repeat(78);
  const head = [
    'herdr-3d: the fonts this build ships and their licences, in full.',
    'Each font file is the upstream one, unmodified, except H3D Box: a renamed subset of DejaVu Sans Mono (see its entry).',
  ];
  const parts = fonts.map((f) => [rule, `${f.name}: ${f.role}`, `Source: ${f.source}`, `Licence: ${(f.license ?? OFL).name}`, rule, '', read(f.licenseFile).trim()].join('\n'));
  return `${[head.join('\n'), ...parts].join('\n\n')}\n`;
}
