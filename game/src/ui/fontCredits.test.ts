import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { ALL_FONT_CREDITS as FONT_CREDITS, EXCALIDRAW_FONT_CREDITS, EXCALIDRAW_NOTICE, fontLicensesText, UFL } from './fontCredits';

const GAME = join(import.meta.dirname, '..', '..');
const read = (f: string) => readFileSync(join(GAME, f), 'utf8');
const dash = (s: string) => s.replace(/[–—]/g, '-');

describe('FONT_LICENSES.txt (#59)', () => {
  // #172: only the fonts the game still uses are credited, the Ubuntu pair under the Ubuntu Font Licence.
  it('credits the Ubuntu pair under the UFL and none of the retired presets’ fonts', () => {
    const names = FONT_CREDITS.map((f) => f.name);
    expect(FONT_CREDITS.filter((f) => f.license === UFL).map((f) => f.name)).toEqual(['Ubuntu', 'Ubuntu Mono']);
    expect(names).not.toContain('Space Mono');
    expect(names).not.toContain('Newsreader');
    const text = fontLicensesText(read);
    expect(text).toContain('Licence: Ubuntu Font Licence 1.0');
    expect(text).not.toContain('Space Mono');
  });

  it('names every shipped font and carries its licence file in full', () => {
    const text = fontLicensesText(read);
    for (const f of FONT_CREDITS) {
      const lic = read(f.licenseFile);
      expect(text, f.name).toContain(`${f.name}: ${f.role}`);
      expect(text, f.name).toContain(lic.trim());
      // The panel's copyright line is the licence file's own.
      if (EXCALIDRAW_FONT_CREDITS.includes(f)) continue; // M13: checked below
      if (f.license === UFL) {
        // #172: the Ubuntu Font Licence in full, which is not the OFL; the package's file has no copyright line, so the
        // notice rides in the entry's own header.
        expect(lic).toContain('UBUNTU FONT LICENCE Version 1.0');
        expect(lic).toContain('Original Version');
        expect(lic).toContain('"Font Software" refers to the set of files');
        expect(lic).not.toContain('SIL OPEN FONT LICENSE');
        expect(text).toContain(`Copyright: ${f.copyright}`);
        expect(f.copyright).toBe('Copyright 2011 Canonical Ltd.');
        continue;
      }
      expect(dash(lic), f.name).toContain(f.license ? 'Copyright (c) 2003 by Bitstream, Inc.' : dash(f.copyright));
      if (f.license) {
        // Bitstream Vera: the permission and trademark notices it asks to go with every copy.
        expect(lic).toContain('The above copyright and trademark notices and this permission notice shall');
        expect(lic).toContain('Bitstream Vera is');
      } else {
        // The OFL in full, not a pointer to it: its conditions (clause 2 wants them with every copy) and its disclaimer.
        expect(lic).toContain('SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007');
        expect(lic).toContain('2) Original or Modified Versions of the Font Software may be bundled,');
        expect(lic).toContain('THE FONT SOFTWARE IS PROVIDED "AS IS"');
      }
    }
  });

  // M13: the whiteboard's fonts, one entry per family Excalidraw packages, each with its own licence in full.
  it('covers every font family the whiteboard ships, with the right licence', () => {
    const shipped = readdirSync(join(GAME, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts')).sort();
    const named = EXCALIDRAW_FONT_CREDITS.map((f) => /src\/fonts\/excalidraw\/([^/]+)\/LICENSE$/.exec(f.licenseFile)?.[1]).sort();
    expect(named).toEqual(shipped);
    const text = fontLicensesText(read);
    for (const f of EXCALIDRAW_FONT_CREDITS) {
      const lic = read(f.licenseFile);
      expect(text, f.name).toContain(lic.trim());
      const kind = f.license?.name ?? 'OFL';
      if (kind === 'MIT') expect(lic).toContain('Permission is hereby granted, free of charge, to any person obtaining a copy');
      else if (kind.startsWith('GPLv2')) {
        expect(lic).toContain('As a special exception, if you create a document which uses this font');
        expect(lic).toContain('GNU GENERAL PUBLIC LICENSE');
        expect(lic).toContain('Version 2, June 1991');
      } else expect(lic).toContain('2) Original or Modified Versions of the Font Software may be bundled');
    }
    // The editor's own MIT notice goes with them.
    expect(text).toContain(read(EXCALIDRAW_NOTICE.licenseFile).trim());
    expect(read(EXCALIDRAW_NOTICE.licenseFile)).toContain('Copyright (c) 2020 Excalidraw');
  });
});
