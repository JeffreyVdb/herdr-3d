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

// #12: the issue's acceptance, entirely from the game: pair the bot, send a test, toggle the events, unpair, remove the
// token. The destination's one status says where things stand at each step.

/** The destination's status: its badge and its line. */
async function destination(tg: Locator, label: string, text: string | RegExp): Promise<void> {
  await expect(tg.locator('.settings-tg-dest')).toHaveCount(1);
  await expect(tg.locator('.settings-tg-dest-badge')).toHaveText(label);
  await expect(tg.locator('.settings-tg-dest-text')).toContainText(text);
}

/** The commands the game sent, notify.* only, with their args. */
async function notifySent(page: Page): Promise<Array<{ t: string; args: unknown }>> {
  const sent = await page.evaluate(() => window.__h3d.sent());
  return sent.filter((c) => c.t.startsWith('notify.')).map((c) => ({ t: c.t, args: (c as { args?: unknown }).args }));
}

async function noTokenAnywhere(page: Page): Promise<void> {
  expect(JSON.stringify(await page.evaluate(() => window.__h3d.sent()))).not.toContain('AAHdq');
  const everything = await page.evaluate(() => document.documentElement.outerHTML + [...document.querySelectorAll('input')].map((e) => e.value).join('|'));
  expect(everything).not.toContain('AAHdq');
}

test('pair the bot, send a test, toggle both events, unpair and remove the token, with one status throughout', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '', SIM);
  const tg = await telegram(page);
  const status = tg.locator('.settings-status');
  await destination(tg, 'Not configured', 'No bot token yet');
  await tg.getByLabel('Token from @BotFather').fill(TOKEN);
  await tg.getByRole('button', { name: 'Save token' }).click();
  await expect(status).toContainText('Token saved');
  await destination(tg, 'Not configured', 'pair your Telegram account');
  await tg.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(tg.getByLabel('Pairing code')).toHaveText('K7QM-4XPA');
  await destination(tg, 'Not configured', 'Waiting for the pairing code');
  await page.evaluate(() => window.__h3d.simTelegram({ pair: true }));
  await destination(tg, 'Paired', 'Alerts are off: nothing is sent to Ada.');
  // A change the phone made is said in the status line.
  await expect(status).toHaveText('Paired. Alerts are off: nothing is sent to Ada.');
  await tg.getByRole('button', { name: 'Send test message' }).click();
  await expect(status).toContainText('Test message delivered');
  const on = tg.getByLabel('Send Telegram notifications');
  await on.check();
  await destination(tg, 'Paired', 'Alerts are on: messages go to Ada through @herdr3d_bot.');
  // Both events, off then on again: the bridge's answer is what the boxes show.
  const needs = tg.getByLabel(/A worker needs you/);
  const done = tg.getByLabel(/A worker finishes/);
  await needs.uncheck();
  await expect(status).toHaveText('Saved.');
  await expect(needs).not.toBeChecked();
  await done.uncheck();
  await expect(done).not.toBeChecked();
  await expect(status).toHaveText('Saved.');
  await needs.check();
  await expect(needs).toBeChecked();
  const events = (await notifySent(page)).filter((c) => c.t === 'notify.set').map((c) => c.args);
  expect(events).toEqual(expect.arrayContaining([{ events: { needs_you: false } }, { events: { done: false } }, { events: { needs_you: true } }]));
  // A bounced message is the one status's Error, with the reason; a working test clears it.
  await page.evaluate(() => window.__h3d.simTelegram({ blocked: true }));
  await tg.getByRole('button', { name: 'Send test message' }).click();
  await destination(tg, 'Error', 'Last message not delivered: Telegram will not deliver to you');
  await shot(page, 'h12-telegram-status-error');
  // A phone: the status wraps under its badge, no sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await tg.locator('.settings-tg-dest').scrollIntoViewIfNeeded();
  await expect(tg.locator('.settings-tg-dest')).toBeInViewport();
  expect(await page.evaluate(() => { const b = document.querySelector('dialog.settings .settings-body')!; return b.scrollWidth <= b.clientWidth; })).toBe(true);
  await shot(page, 'h12-telegram-status-phone');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => window.__h3d.simTelegram({ blocked: false }));
  await tg.getByRole('button', { name: 'Send test message' }).click();
  await destination(tg, 'Paired', 'Alerts are on');
  // Unpair: back to not configured, the switch off with it.
  await tg.getByRole('button', { name: 'Unpair' }).click();
  await expect(status).toHaveText('Unpaired. Nothing is sent until you pair again.');
  await destination(tg, 'Not configured', 'pair your Telegram account');
  await expect(tg.getByRole('button', { name: 'Pair', exact: true })).toBeEnabled();
  await expect(tg.getByRole('button', { name: 'Unpair' })).toBeHidden();
  // Remove the token: it asks twice (the button's name changes in between).
  const remove = tg.getByRole('group', { name: '1. Bot token' }).getByRole('button', { name: /remove/i });
  await expect(remove).toHaveText('Remove token');
  await remove.click();
  await expect(remove).toHaveText('Click again to remove (unpairs too)');
  await remove.click();
  await expect(status).toContainText('Token removed');
  await destination(tg, 'Not configured', 'No bot token yet');
  await expect(tg.getByRole('button', { name: 'Remove token' })).toBeHidden();
  expect((await notifySent(page)).map((c) => c.t)).toEqual(
    expect.arrayContaining(['notify.token.set', 'notify.pair.start', 'notify.test', 'notify.set', 'notify.unpair', 'notify.token.clear']),
  );
  await noTokenAnywhere(page);
  clean();
});

test('keyboard only: the same journey with Tab, Shift+Tab, Enter and Space, the focus never dropped', async ({ page }) => {
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1366, height: 768 });
  await openGame(page, 'demo-m6', '', SIM);
  await page.locator('.btn--menu').focus();
  await page.keyboard.press(',');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  // The tab list, its last section (Telegram), then into it.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('End');
  await expect(dialog.getByRole('tab', { name: 'Telegram' })).toBeFocused();
  const tg = dialog.locator('.settings-section[data-section="telegram"]');
  await expect(tg).toBeVisible();
  const status = tg.locator('.settings-status');
  /** The focus is on `want`, inside the section (never the page's body). */
  const at = async (want: Locator) => {
    await expect(want).toBeFocused();
    expect(await tg.evaluate((s) => s.contains(document.activeElement) && document.activeElement !== document.body)).toBe(true);
  };
  await page.keyboard.press('Tab');
  const token = tg.getByLabel('Token from @BotFather');
  await at(token);
  await destination(tg, 'Not configured', 'No bot token yet');
  // Paste the token, Enter: on to the next step's Pair.
  await page.keyboard.insertText(TOKEN);
  await page.keyboard.press('Enter');
  await expect(status).toContainText('Token saved');
  const pair = tg.getByRole('button', { name: 'Pair', exact: true });
  await at(pair);
  await destination(tg, 'Not configured', 'pair your Telegram account');
  // Pair: the code shows, the keyboard on Cancel pairing while it waits.
  await page.keyboard.press('Enter');
  await expect(tg.getByLabel('Pairing code')).toHaveText('K7QM-4XPA');
  await at(tg.getByRole('button', { name: 'Cancel pairing' }));
  await destination(tg, 'Not configured', 'Waiting for the pairing code');
  // The phone sends the code: Cancel pairing goes, the keyboard moves on to the test.
  await page.evaluate(() => window.__h3d.simTelegram({ pair: true }));
  await destination(tg, 'Paired', 'Alerts are off');
  const test = tg.getByRole('button', { name: 'Send test message' });
  await at(test);
  await page.keyboard.press('Enter');
  await expect(status).toContainText('Test message delivered');
  await at(test);
  // The switch and both events, with Space.
  await page.keyboard.press('Tab');
  const on = tg.getByLabel('Send Telegram notifications');
  await at(on);
  await page.keyboard.press('Space');
  await expect(status).toContainText('On.');
  await expect(on).toBeChecked();
  await at(on);
  await destination(tg, 'Paired', 'Alerts are on');
  await page.keyboard.press('Tab');
  const needs = tg.getByLabel(/A worker needs you/);
  await at(needs);
  await page.keyboard.press('Space');
  await expect(status).toHaveText('Saved.');
  await expect(needs).not.toBeChecked();
  await at(needs);
  await page.keyboard.press('Tab');
  const done = tg.getByLabel(/A worker finishes/);
  await at(done);
  await page.keyboard.press('Space');
  await expect(done).not.toBeChecked();
  await at(done);
  const sets = (await notifySent(page)).filter((c) => c.t === 'notify.set').map((c) => c.args);
  expect(sets).toEqual([{ enabled: true }, { events: { needs_you: false } }, { events: { done: false } }]);
  // Back up past the switch and the test to Unpair.
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+Tab');
  const unpair = tg.getByRole('button', { name: 'Unpair' });
  await at(unpair);
  await page.keyboard.press('Enter');
  await expect(status).toHaveText('Unpaired. Nothing is sent until you pair again.');
  await at(pair);
  await destination(tg, 'Not configured', 'pair your Telegram account');
  // Remove token, asked twice: then the token field.
  await page.keyboard.press('Shift+Tab');
  const remove = tg.getByRole('group', { name: '1. Bot token' }).getByRole('button', { name: /remove/i });
  await expect(remove).toHaveText('Remove token');
  await at(remove);
  await page.keyboard.press('Enter');
  await expect(remove).toHaveText('Click again to remove (unpairs too)');
  await page.keyboard.press('Enter');
  await expect(status).toContainText('Token removed');
  await at(token);
  await destination(tg, 'Not configured', 'No bot token yet');
  await noTokenAnywhere(page);
  clean();
});
