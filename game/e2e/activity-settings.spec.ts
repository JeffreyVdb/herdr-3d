import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openGame, shot, watchErrors, openMenu, settingsSection } from './game';

// #98: the Settings window's “Classify unknown commands” against the fixture bridge (`sim=1`,
// tools/fixture-activity-settings.ts), whose AI integration calls a fake Jev started here on an OS-leased loopback
// port. The section sits under AI integration (after Follow-up questions), the privacy note above its switch; switched
// on without the classifier it waits (and links to it), with it it is ready, at the daily cap it says rules only. The
// environment's switch is read-only; a bridge without the AI service has no section.

const JEV_KEY = 'jev-test-key-0123456789';

interface Fake {
  url: string;
  close(): Promise<void>;
}

function fakeJev(): Promise<Fake> {
  const server: Server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${JEV_KEY}`) return void res.writeHead(401).end('{"error":"unauthorized"}');
    if (req.url === '/v1/models') return void res.end('{"models":[{"name":"jev-latest","description":"Newest"}]}');
    req.resume();
    req.on('end', () => res.end(JSON.stringify({ answers: { question: { noul: 0.97 } } })));
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      done({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))) });
    });
  });
}

async function openSettings(page: Page, show = 'activity'): Promise<{ dialog: Locator; section: Locator }> {
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  // #49: one section at a time.
  await settingsSection(page, show);
  return { dialog, section: dialog.locator('[data-section="activity"]') };
}

const state = (section: Locator) => section.locator('.settings-act-state');

test('under AI integration, the privacy note above its switch: waiting without the classifier, ready with it, capped at the cap', async ({ page }) => {
  const clean = watchErrors(page);
  const jev = await fakeJev();
  try {
    await openGame(page, 'demo-m5', '', `play=none&sim=1&simusage=0&simjev=${encodeURIComponent(jev.url)}`);
    const { dialog, section } = await openSettings(page);
    await expect(section.getByRole('heading', { name: 'Classify unknown commands', level: 3 })).toBeVisible();
    await expect(section.locator('.settings-store')).toHaveText('Bridge');
    // Below AI integration, after the other features on its models (Follow-up questions, #110 Pack up on request).
    const order = await dialog.locator('.settings-section').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.section));
    expect(order.indexOf('activity')).toBeGreaterThan(order.indexOf('ai'));
    expect(order.indexOf('activity')).toBe(order.indexOf('packup') + 1);
    // The AI section says who uses the classifier (#49: shown, then back).
    await settingsSection(page, 'ai');
    await expect(dialog.getByRole('group', { name: /Classification model/ })).toContainText('Classify unknown commands');
    await settingsSection(page, 'activity');

    // Off by default; the privacy note above the switch, which it describes.
    const toggle = section.getByRole('checkbox', { name: 'Classify unknown commands' });
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeEnabled();
    const privacy = section.locator('.settings-act-privacy');
    await expect(privacy).toContainText('TypeSafe');
    await expect(privacy).toContainText('Tool output is never sent');
    const [note, sw] = await Promise.all([privacy.boundingBox(), toggle.boundingBox()]);
    expect(note && sw && note.y + note.height <= sw.y).toBe(true);
    await expect(state(section).locator('.settings-badge').first()).toHaveText('Off');

    // On, with no classifier: waiting, with its state and the way to it.
    await toggle.check();
    await expect(section.locator('.settings-status')).toHaveText('On. Nothing is sent until the classification model is ready.');
    await expect(state(section)).toHaveAttribute('data-state', 'incomplete');
    await expect(state(section)).toContainText('Needs the classification model, which is not set up.');
    const link = section.getByRole('button', { name: 'Set up in AI integration' });
    await expect(link).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    await shot(page, 'settings-activity-incomplete');
    await link.click();
    await expect(dialog.locator('[data-section="ai"] h3')).toBeFocused();

    // The classifier set up in the AI section: ready.
    const classifier = dialog.getByRole('group', { name: /Classification model/ });
    await classifier.getByLabel('Key', { exact: true }).fill(JEV_KEY);
    await classifier.getByRole('button', { name: 'Load models' }).click();
    await expect(classifier.getByLabel('Model')).toHaveValue('jev-latest');
    await classifier.getByRole('button', { name: 'Test' }).click();
    await expect(classifier).toContainText('Test passed');
    await classifier.getByRole('button', { name: 'Save' }).click();
    await expect(classifier.locator('.settings-badge')).toHaveText('Ready');
    // #49: back to the section, which kept its state across the switch.
    await settingsSection(page, 'activity');
    await expect(toggle).toBeChecked();
    await expect(state(section)).toHaveAttribute('data-state', 'ready');
    await expect(state(section)).toContainText('Commands the rules can’t place are classified');
    await expect(link).toBeHidden();
    expect(await page.evaluate(() => window.__h3d.activitySettings())).toMatchObject({ model_enabled: true, state: 'ready', classifier: 'ready' });

    // The numbers: checked here, saved one by one.
    const threshold = section.getByLabel('Minimum confidence');
    await expect(threshold).toHaveAccessibleDescription(/Higher accepts fewer labels\. Default 0\.60\./);
    await threshold.fill('1.5');
    await threshold.press('Enter');
    await expect(threshold).toHaveAttribute('aria-invalid', 'true');
    await expect(section.locator('.settings-status')).toHaveText('The minimum confidence must be between 0.05 and 0.99.');
    await threshold.fill('0.7');
    await threshold.press('Enter');
    await expect(section.locator('.settings-status')).toHaveText('Minimum confidence saved: 0.70.');
    await section.getByLabel('Daily cap').fill('500');
    await section.getByLabel('Daily cap').press('Enter');
    await expect(section.locator('.settings-status')).toHaveText('Daily cap saved: 500.');
    expect(await page.evaluate(() => window.__h3d.activitySettings())).toMatchObject({ threshold: 0.7, margin: 0.2, daily_cap: 500 });

    // The day's calls reach the cap: rules only today, the ledger full.
    await page.evaluate(() => window.__h3d.simActivitySettings({ calls_today: 500, cache_size: 214 }));
    await expect(state(section)).toHaveAttribute('data-state', 'capped');
    await expect(state(section)).toContainText('Daily cap reached, rules only today.');
    await expect(section.locator('.settings-act-figure')).toHaveText(['500 of 500', '214']);
    await expect(section.locator('.settings-act-ledger')).toContainText('Cached classifications214Saved answers for distinct normalised commands');
    await expect(section.locator('.settings-act-bar')).toHaveAttribute('data-level', 'full');
    await section.scrollIntoViewIfNeeded();
    await shot(page, 'settings-activity-capped');

    // Off again: nothing is sent.
    await toggle.uncheck();
    await expect(state(section)).toHaveAttribute('data-state', 'off');
    await expect(section.locator('.settings-status')).toHaveText('Off. Nothing is sent.');
    clean();
  } finally {
    await jev.close();
  }
});

test('a switch set by the bridge environment is read-only and says so, on a phone too', async ({ page }) => {
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 360, height: 640 });
  await openGame(page, 'demo-m5', '', 'play=none&sim=1&simusage=0');
  await page.evaluate(() => window.__h3d.simActivitySettings({ env: ['model_enabled'], model_enabled: true }));
  const { section } = await openSettings(page);
  const toggle = section.getByRole('checkbox', { name: 'Classify unknown commands' });
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeDisabled();
  await expect(section).toContainText('Set by the bridge environment (HERDR_WORLD_ACTIVITY_MODEL): read-only here.');
  // On, but the classifier is not set up: still waiting, and the numbers stay editable.
  await expect(state(section)).toHaveAttribute('data-state', 'incomplete');
  await expect(section.getByLabel('Minimum score gap')).toBeEnabled();
  // Nothing overflows the phone's width.
  await section.scrollIntoViewIfNeeded();
  const wide = await section.evaluate((root) => [...root.querySelectorAll<HTMLElement>('*')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5).map((e) => e.className));
  expect(wide).toEqual([]);
  await shot(page, 'settings-activity-env-360');
  clean();
});

test('a bridge without the AI service has no “Classify unknown commands” section', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', 'play=none&sim=1&simusage=0&simai=off');
  const { dialog, section } = await openSettings(page, 'ai');
  await expect(dialog.locator('[data-section="ai"]')).toBeVisible();
  await expect(section).toBeHidden();
  // #49: not in the section list either.
  await expect(dialog.locator('[role="tab"][data-tab="activity"]')).toBeHidden();
  expect(await page.evaluate(() => window.__h3d.activitySettings())).toBeNull();
  clean();
});
