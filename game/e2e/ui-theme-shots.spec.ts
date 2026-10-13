import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from '@playwright/test';
import { RESULTS, watchErrors } from './game';
import { boot, DESKTOP, NARROW, SURFACES, type UiTheme } from './ui-surfaces';

// #216: the screenshots of every application surface in Quiet and in Ubuntu, desktop and 390 px. `H3D_UI_SET=before-quiet`
// (with `H3D_DIST` pointing at a build of the commit before the UI theme) records the "before" set instead: Quiet only,
// written to <dir>/before-quiet/. Output: test-results/ui-theme/<set>/<size>/<surface>.png (H3D_UI_SHOTS moves it).

const OUT = process.env.H3D_UI_SHOTS ?? resolve(RESULTS, 'ui-theme');
const SET = process.env.H3D_UI_SET;
const SETS: Array<{ name: string; ui: UiTheme }> = SET ? [{ name: SET, ui: 'quiet' }] : [{ name: 'quiet', ui: 'quiet' }, { name: 'ubuntu', ui: 'ubuntu' }];
const SIZES = [{ name: 'desktop', ...DESKTOP }, { name: 'narrow', ...NARROW }];

for (const set of SETS) {
  for (const size of SIZES) {
    for (const s of SURFACES) {
      if (s.skipNarrow && size.name === 'narrow') continue;
      test(`${set.name} ${size.name}: ${s.name}`, { tag: '@visual' }, async ({ page }) => {
        test.setTimeout(180_000);
        const clean = watchErrors(page);
        await boot(page, s.fixture, { ui: set.ui }, s.extra ?? '', s.wsQuery, size);
        await s.open(page);
        await page.waitForTimeout(250);
        const dir = resolve(OUT, set.name, size.name);
        mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: resolve(dir, `${s.name}.png`) });
        clean();
      });
    }
  }
}
