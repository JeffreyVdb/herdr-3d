import { expect, test, type Page } from '@playwright/test';
import { openGame, shot, watchErrors } from './game';

// #100: Settings → Notifications. The browser's notification permission is stubbed before the page loads (a
// headless Chromium has no prompt to answer), and AudioContext.createOscillator is counted, so Test is seen to
// synthesize the chime in the real Web Audio graph.

async function stub(page: Page, permission: NotificationPermission, answer: NotificationPermission = 'granted') {
  await page.addInitScript(
    ({ permission, answer }) => {
      const w = window as unknown as { __asked: number; __tones: number; Notification: unknown };
      w.__asked = 0;
      w.__tones = 0;
      const N = function Notification() {} as unknown as { permission: string; requestPermission: () => Promise<string> };
      N.permission = permission;
      N.requestPermission = () => {
        w.__asked++;
        N.permission = answer;
        return Promise.resolve(answer);
      };
      Object.defineProperty(window, 'Notification', { value: N, configurable: true, writable: true });
      const make = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function (this: AudioContext) {
        w.__tones++;
        return make.call(this);
      };
    },
    { permission, answer },
  );
}

async function openSection(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  const section = dialog.locator('[data-section="notifications"]');
  await section.scrollIntoViewIfNeeded();
  return { dialog, section };
}

const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('h3d.inbox') ?? 'null') as Record<string, unknown> | null);

test('Notifications: Allow… asks the browser, the switches are kept per browser, Test plays the chime', async ({ page }) => {
  const clean = watchErrors(page);
  await stub(page, 'default', 'granted');
  await openGame(page);
  const { section } = await openSection(page);
  await expect(section.getByRole('heading', { name: 'Notifications', level: 3 })).toBeVisible();
  await expect(section.locator('.settings-store')).toHaveText('This browser');

  // Not asked yet: the tag says so and Allow… asks, from the click.
  const tag = section.locator('.settings-nt-head .settings-badge');
  await expect(tag).toHaveText('Not asked');
  await section.getByRole('button', { name: 'Allow…' }).click();
  await expect(tag).toHaveText('Allowed');
  await expect(section.getByRole('button', { name: 'Allow…' })).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(1);

  await expect(section.getByLabel('Desktop notifications')).toBeChecked();
  await expect(section.getByLabel('Chime', { exact: true })).toBeChecked();
  await expect(section.getByLabel('Needs you')).toBeChecked();
  await expect(section.getByLabel('Finished')).toBeChecked();
  await expect(section.getByLabel('Include freelancers when they finish')).not.toBeChecked();
  const vol = section.getByLabel('Chime volume');
  await expect(vol).toHaveValue('60');
  await shot(page, 'm100-settings');

  // Each control writes h3d.inbox.
  await section.getByLabel('Finished').uncheck();
  await section.getByLabel('Include freelancers when they finish').check();
  await vol.fill('35');
  await expect(section.locator('output')).toHaveText('35%');
  expect(await stored(page)).toMatchObject({ onFinished: false, freelancers: true, chimeVolume: 0.35 });

  // Test: the click unlocks sound and the needs chime's two tones are made.
  await section.getByRole('button', { name: 'Test' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __tones: number }).__tones)).toBe(2);

  // Kept across a reload.
  await page.reload();
  await page.waitForFunction(() => window.__h3d?.ready);
  const again = await openSection(page);
  await expect(again.section.getByLabel('Finished')).not.toBeChecked();
  await expect(again.section.getByLabel('Chime volume')).toHaveValue('35');
  clean();
});

test('Notifications: a blocked permission says how to unblock, and the section fits a phone', async ({ page }) => {
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 360, height: 640 });
  await stub(page, 'denied');
  await openGame(page);
  const { dialog, section } = await openSection(page);
  await expect(section.locator('.settings-nt-head .settings-badge')).toHaveText('Blocked');
  await expect(section).toContainText('Site settings');
  await expect(section.getByRole('button', { name: 'Allow…' })).toBeHidden();
  const d = (await dialog.boundingBox())!;
  for (const box of await section.locator('input:visible, button:visible, output:visible').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect))) {
    expect(box.x).toBeGreaterThanOrEqual(d.x);
    expect(box.x + box.width).toBeLessThanOrEqual(d.x + d.width);
  }
  await shot(page, 'm100-settings-narrow');
  clean();
});
