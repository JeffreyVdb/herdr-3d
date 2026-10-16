import { expect, test, type Locator, type Page } from '@playwright/test';
import { openGame, openMenu, settingsSection, shot, watchErrors } from './game';

// #11: Settings → Telegram against the simulating fixture server (tools/fixture-telegram.ts): save a bot token, pair
// your account with a one-time code (the sim pairs Ada on `sim.telegram {pair: true}`), send the test message, switch
// notifications on and pick what they say. `simtelegram=` sets where it starts (`env`: the bridge environment's).

const SIM = 'play=none&sim=1&simms=150&simusage=0';
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

async function telegram(page: Page): Promise<Locator> {
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  return settingsSection(page, 'telegram');
}

test('set up Telegram: a token, the pairing code, a test message, then the switch; the token never stays in the page', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '', SIM);
  const tg = await telegram(page);
  await expect(tg.locator('.settings-store')).toHaveText('Bridge');
  const on = tg.getByLabel('Send Telegram notifications');
  await expect(on).toBeDisabled();
  await expect(tg.getByRole('button', { name: 'Pair', exact: true })).toBeDisabled();
  // A token that is not one, then the real one.
  const token = tg.getByLabel('Token from @BotFather');
  await token.fill('not-a-token');
  await tg.getByRole('button', { name: 'Save token' }).click();
  await expect(tg.locator('.settings-status')).toContainText('not a bot token');
  await token.fill(TOKEN);
  await token.press('Enter');
  await expect(tg.locator('.settings-status')).toContainText('Token saved');
  await expect(token).toHaveValue('');
  await expect(tg).toContainText('ending Dsaw, for @herdr3d_bot');
  // Pair: the code, where to send it, the bot's chat.
  await tg.getByRole('button', { name: 'Pair', exact: true }).click();
  const code = tg.getByLabel('Pairing code');
  await expect(code).toHaveText('K7QM-4XPA');
  await expect(tg).toContainText('Send this code to @herdr3d_bot on Telegram');
  await expect(tg).toContainText('expires in 9 min');
  await expect(tg.getByRole('link', { name: 'Open the bot in Telegram' })).toHaveAttribute('href', 'https://t.me/herdr3d_bot');
  await shot(page, 'h11-telegram-pairing');
  await page.evaluate(() => window.__h3d.simTelegram({ pair: true }));
  await expect(tg).toContainText('Paired with Ada');
  await expect(code).toBeHidden();
  // The switch waits for a delivered test.
  await expect(on).toBeDisabled();
  await tg.getByRole('button', { name: 'Send test message' }).click();
  await expect(tg.locator('.settings-status')).toContainText('Test message delivered');
  await expect(on).toBeEnabled();
  await on.check();
  await expect(tg.locator('.settings-status')).toContainText('On.');
  await tg.getByLabel('Quiet: deliver without a sound').check();
  await expect(tg.locator('.settings-status')).toContainText('without a sound');
  await tg.getByLabel(/A worker finishes/).uncheck();
  await expect(tg.locator('.settings-status')).toHaveText('Saved.');
  await shot(page, 'h11-telegram-on');
  const sent = await page.evaluate(() => window.__h3d.sent());
  expect(sent.filter((c) => c.t.startsWith('notify.')).map((c) => c.t)).toEqual(
    expect.arrayContaining(['notify.token.set', 'notify.pair.start', 'notify.test', 'notify.set']),
  );
  expect(JSON.stringify(sent)).not.toContain('AAHdq');
  const everything = await page.evaluate(() => document.documentElement.outerHTML + [...document.querySelectorAll('input')].map((e) => e.value).join('|'));
  expect(everything).not.toContain('AAHdq');
  // A phone: the section fits, the code reads, no sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await tg.getByRole('button', { name: 'Pair again', exact: true }).click();
  await expect(code).toBeInViewport({ ratio: 0.5 });
  expect(await page.evaluate(() => { const b = document.querySelector('dialog.settings .settings-body')!; return b.scrollWidth <= b.clientWidth; })).toBe(true);
  await shot(page, 'h11-telegram-phone');
  await tg.getByRole('button', { name: 'Cancel pairing' }).click();
  await expect(code).toBeHidden();
  clean();
});

test('Telegram set by the bridge environment, a blocked bot, an expired code', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '', `${SIM}&simtelegram=env`);
  const tg = await telegram(page);
  await expect(tg.getByLabel('Send Telegram notifications')).toBeChecked();
  await expect(tg.getByLabel('Send Telegram notifications')).toBeDisabled();
  await expect(tg).toContainText('HERDR_WORLD_NOTIFY_ENABLED');
  await expect(tg.getByLabel('Token from @BotFather')).toBeDisabled();
  await expect(tg).toContainText('HERDR_WORLD_TELEGRAM_KEY_FILE');
  await expect(tg.getByRole('button', { name: 'Remove token' })).toBeHidden();
  await page.evaluate(() => window.__h3d.simTelegram({ blocked: true }));
  await tg.getByRole('button', { name: 'Send test message' }).click();
  await expect(tg.locator('.settings-status')).toContainText('press Start');
  await expect(tg).toContainText('Last message not delivered');
  await tg.getByRole('button', { name: 'Pair again', exact: true }).click();
  await page.evaluate(() => window.__h3d.simTelegram({ expire: true }));
  // Still paired with Ada (an unused code changes nothing), and the line says the code expired.
  await expect(tg.locator('.settings-badge', { hasText: 'Paired' })).toBeVisible();
  await expect(tg).toContainText('The code expired before it arrived: start pairing again.');
  await expect(tg.getByLabel('Pairing code')).toBeHidden();
  await expect(tg.getByRole('button', { name: 'Pair again', exact: true })).toBeEnabled();
  clean();
});
