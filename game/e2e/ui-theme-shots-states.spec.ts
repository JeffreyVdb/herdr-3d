import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { frames, openMenu, RESULTS, watchErrors } from './game';
import { boot, DESKTOP, NARROW, SURFACES, sitAtTofu, type Themes, type UiTheme } from './ui-surfaces';

// #216: the screenshots of states (success, warning, error, offline, disabled, busy, invalid, focus), of mixed themes
// (UI, transcript and terminal picked apart) and of the same surfaces before and after a live switch.
// Output: test-results/ui-theme/<set>/<size>/<name>.png like ui-theme-shots.spec.ts (H3D_UI_SHOTS, H3D_UI_SET the same).

const OUT = process.env.H3D_UI_SHOTS ?? resolve(RESULTS, 'ui-theme');
const SET = process.env.H3D_UI_SET;
const SIZES = [{ name: 'desktop', ...DESKTOP }, { name: 'narrow', ...NARROW }];
const MANUAL = 'play=none&sim=1&simms=150&simusage=0&simclock=manual';

async function shotTo(page: Page, set: string, size: string, name: string): Promise<void> {
  const dir = resolve(OUT, set, size);
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(dir, `${name}.png`) });
}

interface State {
  name: string;
  fixture: string;
  wsQuery?: string;
  extra?: string;
  open(page: Page): Promise<void>;
}

const hireOpen = async (page: Page) => {
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  await page.evaluate(() => window.__h3d.openHire(5));
  await expect.poll(async () => ((await page.evaluate(() => window.__h3d.dialog())) as { state?: string } | null)?.state).toBe('ready');
};

const STATES: State[] = [
  {
    // Keyboard focus on the primary action: the ring and the keyline.
    name: 'state-focus-primary',
    fixture: 'demo-m4',
    open: async (page) => {
      await hireOpen(page);
      await page.locator('#hire-task').fill('Rework the header so it no longer overlaps the logo on mobile.');
      await page.keyboard.press('Shift');
      await page.locator('dialog.desk-dlg--hire [data-key="hire"]').focus();
    },
  },
  {
    // Busy: Hire pressed, the bridge's ack held (a manual simulator clock): the button keeps its colours and says Hiring…
    name: 'state-busy-hiring',
    fixture: 'demo-m4',
    wsQuery: MANUAL,
    open: async (page) => {
      await hireOpen(page);
      await page.locator('#hire-task').fill('Rework the header so it no longer overlaps the logo on mobile.');
      await page.locator('dialog.desk-dlg--hire [data-key="hire"]').click();
      await expect(page.locator('dialog.desk-dlg--hire [data-key="hire"]')).toHaveText('Hiring…');
    },
  },
  {
    // Disabled: the AI integration's Test, Save and Clear wait for a configured model (native disabled), beside an enabled secondary.
    name: 'state-disabled-ai',
    fixture: 'demo-m5',
    open: async (page) => {
      await openMenu(page);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const section = page.getByRole('dialog', { name: 'Settings' }).locator('[data-section="ai"]');
      await section.scrollIntoViewIfNeeded();
      await expect(section.locator('button:disabled').first()).toBeVisible();
    },
  },
  {
    // Invalid, focus in a field and disabled buttons, in Settings.
    name: 'state-settings-invalid',
    fixture: 'demo-m5',
    open: async (page) => {
      await openMenu(page);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const dlg = page.getByRole('dialog', { name: 'Settings' });
      const zone = dlg.getByLabel('Timezone');
      await zone.scrollIntoViewIfNeeded();
      await zone.fill('Not/AZone');
      await zone.press('Enter');
      await expect(zone).toHaveAttribute('aria-invalid', 'true');
      await page.keyboard.press('Shift');
      await dlg.getByLabel('Latitude').focus();
    },
  },
  {
    // Success, warning and error together: the three toast kinds are separate surfaces; here the inbox chip (needs you / done) on the bar.
    name: 'state-offline',
    fixture: 'demo-m5',
    open: async (page) => {
      await page.context().setOffline(true);
      await page.evaluate(() => window.__h3d.reconnect());
      await expect.poll(() => page.evaluate(() => window.__h3d.connection().phase), { timeout: 20_000 }).not.toBe('live');
    },
  },
];

for (const set of SET ? [{ name: SET, ui: 'quiet' as UiTheme }] : [{ name: 'quiet', ui: 'quiet' as UiTheme }, { name: 'ubuntu', ui: 'ubuntu' as UiTheme }]) {
  for (const size of SIZES) {
    for (const s of STATES) {
      test(`${set.name} ${size.name}: ${s.name}`, { tag: '@visual' }, async ({ page }) => {
        test.setTimeout(180_000);
        const clean = s.name === 'state-offline' ? () => undefined : watchErrors(page);
        await boot(page, s.fixture, { ui: set.ui }, s.extra ?? '', s.wsQuery, size);
        await s.open(page);
        await shotTo(page, set.name, size.name, s.name);
        clean();
      });
    }
  }
}

// ---- mixed themes: the three picks apart ---------------------------------------------------------------------------

const MIXED: Array<{ name: string; themes: Themes }> = [
  { name: 'mixed-quietui-ubuntu-views', themes: { ui: 'quiet', transcript: 'ubuntu', terminal: 'ubuntu' } },
  { name: 'mixed-ubuntuui-quiet-views', themes: { ui: 'ubuntu', transcript: 'quiet', terminal: 'quiet' } },
  { name: 'all-ubuntu', themes: { ui: 'ubuntu', transcript: 'ubuntu', terminal: 'ubuntu' } },
];
if (!SET) {
  for (const m of MIXED) {
    for (const size of SIZES) {
      for (const name of ['seat-transcript', 'seat-terminal', 'settings', 'hire']) {
        const s = SURFACES.find((x) => x.name === name)!;
        test(`${m.name} ${size.name}: ${name}`, { tag: '@visual' }, async ({ page }) => {
          test.setTimeout(180_000);
          const clean = watchErrors(page);
          await boot(page, s.fixture, m.themes, s.extra ?? '', s.wsQuery, size);
          await s.open(page);
          await shotTo(page, m.name, size.name, name);
          clean();
        });
      }
    }
  }

  // ---- the same surface before and after a live switch (nothing reloaded) ------------------------------------------
  for (const size of SIZES) {
    for (const name of ['settings', 'hire', 'seat-transcript', 'board-issues', 'palette']) {
      const s = SURFACES.find((x) => x.name === name)!;
      test(`switch ${size.name}: ${name} before and after`, { tag: '@visual' }, async ({ page }) => {
        test.setTimeout(180_000);
        const clean = watchErrors(page);
        await boot(page, s.fixture, {}, s.extra ?? '', s.wsQuery, size);
        await s.open(page);
        await shotTo(page, 'switch-before', size.name, name);
        await page.evaluate(() => window.__h3d.setUiTheme('ubuntu'));
        await page.evaluate(() => window.__h3d.themeLoaded());
        await frames(page, 3);
        await shotTo(page, 'switch-after', size.name, name);
        await page.evaluate(() => window.__h3d.setUiTheme('quiet'));
        await frames(page, 3);
        await shotTo(page, 'switch-back', size.name, name);
        clean();
      });
    }
  }
}
