import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FONT_CREDITS, fontLicensesText } from './fontCredits';

const GAME = join(import.meta.dirname, '..', '..');
const read = (f: string) => readFileSync(join(GAME, f), 'utf8');
const dash = (s: string) => s.replace(/[–—]/g, '-');

describe('FONT_LICENSES.txt (#59)', () => {
  it('names every shipped font and carries its licence file in full', () => {
    const text = fontLicensesText(read);
    for (const f of FONT_CREDITS) {
      const lic = read(f.licenseFile);
      expect(text, f.name).toContain(`${f.name}: ${f.role}`);
      expect(text, f.name).toContain(lic.trim());
      // The panel's copyright line is the licence file's own.
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
});
