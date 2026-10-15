import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { fakeHelper, TOKEN, type FakeBridge } from './bridges';
import { openGame, openMenu, settingsSection, watchErrors } from './game';

// #57: several bridges, named in Settings → Bridges (kept by the helper) and switched from ⌘P → Switch bridge. The helper
// is faked (e2e/bridges.ts): its /api/bridges answers from this process, so the list survives the page's reloads, and the
// game's world stays the fixture's (`?ws=`), whichever bridge is "in use". What follows a switch here is what the game
// owns: the reload, the per-bridge keys, the chip, About and the palette.

const SIM = 'play=none&sim=1&simms=150&simusage=0';
const devbox: FakeBridge = { id: 'aaaaaaaaaa', name: 'devbox', kind: 'ssh', host: 'dev@devbox', state: 'up', version: 'v9.9.9' };
const laptop: FakeBridge = { id: 'bbbbbbbbbb', name: 'Laptop', kind: 'local', socket: '/run/user/1000/herdr-world/bridge.sock', state: 'backoff', last_error: 'dial unix: no such file or directory' };
const gpu: FakeBridge = { id: 'cccccccccc', name: 'gpu box', kind: 'ssh', host: 'me@gpu', state: 'up' };

const palette = (page: Page) => page.locator('dialog.palette');
const names = (page: Page) => palette(page).locator('.pal-opt .pal-name');

async function openSwitch(page: Page): Promise<void> {
  await page.keyboard.press('Control+KeyP');
  await expect(palette(page)).toBeVisible();
  await page.keyboard.type('switch bridge');
  await expect(names(page).first()).toHaveText('Switch bridge');
  await page.keyboard.press('Enter');
  await expect(palette(page).locator('.pal-title')).toHaveText('Switch to which bridge?');
}

async function openBridges(page: Page) {
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return settingsSection(page, 'bridges');
}

test('Settings → Bridges: add, rename and remove bridges kept by the helper; the one in use cannot go', async ({ page }) => {
  // The helper's refusal is a 400 the browser logs; only script errors count here.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const expectClean = () => expect(errors).toEqual([]);
  const helper = await fakeHelper(page, [devbox, laptop], devbox.id);
  await openGame(page, 'demo-m6', '', SIM);
  const section = await openBridges(page);
  await expect(section.locator('.settings-store')).toHaveText('This helper');
  await expect(section.locator('.settings-br-name')).toHaveText(['devbox', 'Laptop']);
  await expect(section.locator('.settings-br-row', { hasText: 'devbox' }).locator('.settings-badge')).toHaveText('In use');
  await expect(section.locator('.settings-br-row', { hasText: 'Laptop' }).locator('.settings-br-meta')).toHaveText('/run/user/1000/herdr-world/bridge.sock · Offline, retrying');

  // The helper's refusal, in its words, under the form.
  const add = section.getByRole('form', { name: 'Add a bridge' });
  await add.getByLabel('Name', { exact: true }).fill('GPU');
  await add.getByLabel('ssh destination').fill('-oProxyCommand=x');
  await add.getByRole('button', { name: 'Add bridge' }).click();
  await expect(add.locator('.settings-br-error')).toHaveText(`Host "-oProxyCommand=x" starts with '-': want [user@]host.`);
  await add.getByLabel('ssh destination').fill('me@gpu');
  await add.getByRole('button', { name: 'Add bridge' }).click();
  await expect(section.locator('.settings-br-name')).toHaveText(['devbox', 'Laptop', 'GPU']);

  // Rename.
  await section.getByRole('button', { name: 'Rename GPU' }).click();
  const rename = section.getByRole('form', { name: 'Rename GPU' });
  await rename.getByLabel('Name', { exact: true }).fill('gpu box');
  await rename.getByRole('button', { name: 'Save name' }).click();
  await expect(section.locator('.settings-br-name')).toHaveText(['devbox', 'Laptop', 'gpu box']);

  // The one in use stays; another goes.
  // aria-disabled, still focusable and clickable: it says why.
  await expect(section.getByRole('button', { name: 'Remove devbox' })).toHaveAttribute('aria-disabled', 'true');
  await section.getByRole('button', { name: 'Remove devbox' }).click({ force: true });
  await expect(section.locator('.settings-status')).toHaveText('devbox is the bridge in use: switch to another bridge before removing it.');
  await section.getByRole('button', { name: 'Remove Laptop' }).click();
  await expect(section.locator('.settings-br-name')).toHaveText(['devbox', 'gpu box']);

  // The list is the helper's: a reload shows it as it was left.
  await page.reload();
  await page.waitForFunction(() => window.__h3d?.ready);
  const again = await openBridges(page);
  await expect(again.locator('.settings-br-name')).toHaveText(['devbox', 'gpu box']);
  expect(helper.calls.every((c) => c.token === TOKEN && !c.path.includes(TOKEN))).toBe(true);
  expectClean();
});

test('⌘P → Switch bridge: the others, online first; an offline one asks; the game reloads on it and keeps each bridge’s seats apart', async ({ page }) => {
  const expectClean = watchErrors(page);
  const helper = await fakeHelper(page, [devbox, laptop, gpu, { ...gpu, id: 'dddddddddd', name: 'Attic', state: 'connecting' }], devbox.id, { activateMs: 600 });
  // A browser from before #57: its seat keys are unscoped, once.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('h57-seeded')) return;
    sessionStorage.setItem('h57-seeded', '1');
    localStorage.setItem('h3d.seat.terminal', '["w-old"]');
  });
  await openGame(page, 'demo-m6', '', SIM);
  // They moved into the first bridge's namespace; client preferences and the token did not.
  const keys = () => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('h3d.b.') || k === 'h3d.seat.terminal' || k === 'h3d.token').map((k) => [k, localStorage.getItem(k)])));
  expect(await keys()).toEqual({ 'h3d.b.aaaaaaaaaa.seat.terminal': '["w-old"]', 'h3d.token': TOKEN });
  await expect(page.locator('.conn')).toHaveAttribute('title', /· Bridge: devbox$/);

  await openSwitch(page);
  // Every bridge but devbox: online first, then the rest, each by name without regard to case.
  await expect(names(page)).toHaveText(['gpu box', 'Attic', 'Laptop']);
  await expect(palette(page).locator('.br-dot')).toHaveCount(3);
  // A bridge that goes up while the list shows: its dot, not its place.
  helper.state.bridges.find((b) => b.id === laptop.id)!.state = 'up';
  await expect(palette(page).locator('.pal-opt[data-bridge="bbbbbbbbbb"] .br-dot')).toHaveAttribute('data-tone', 'up', { timeout: 6000 });
  await expect(names(page)).toHaveText(['gpu box', 'Attic', 'Laptop']);
  helper.state.bridges.find((b) => b.id === laptop.id)!.state = 'backoff';
  await expect(palette(page).locator('.pal-opt[data-bridge="bbbbbbbbbb"] .br-dot')).toHaveAttribute('data-tone', 'down', { timeout: 6000 });

  // Laptop is offline: it asks first. Cancel keeps everything.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('dialog', { name: 'Laptop is offline. Switch anyway?' });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  expect(helper.state.active).toBe(devbox.id);

  await openSwitch(page);
  await page.keyboard.type('lap');
  await page.keyboard.press('Enter');
  await confirm.getByRole('button', { name: 'Switch anyway' }).click();
  // The chip says so while the helper switches; then the page reloads on Laptop.
  await expect(page.locator('.conn')).toHaveText('Switching to Laptop…');
  await page.waitForEvent('load');
  await page.waitForFunction(() => window.__h3d?.ready);
  expect(helper.state.active).toBe(laptop.id);
  await expect(page.locator('.conn')).toHaveAttribute('title', /· Bridge: Laptop$/);
  // devbox's seats are not Laptop's.
  await page.evaluate(() => localStorage.setItem('h3d.b.bbbbbbbbbb.seat.terminal', '["w-laptop"]'));
  expect(await keys()).toEqual({ 'h3d.b.aaaaaaaaaa.seat.terminal': '["w-old"]', 'h3d.b.bbbbbbbbbb.seat.terminal': '["w-laptop"]', 'h3d.token': TOKEN });

  // About names it next to the bridge's version.
  await openMenu(page);
  await page.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'About' }).locator('.about-value').nth(2)).toHaveText(/· Laptop$/);
  await page.keyboard.press('Escape');

  // And back: an online one switches without asking.
  await openSwitch(page);
  await expect(names(page)).toHaveText(['devbox', 'gpu box', 'Attic']);
  await page.keyboard.press('Enter');
  await page.waitForEvent('load');
  await page.waitForFunction(() => window.__h3d?.ready);
  expect(helper.state.active).toBe(devbox.id);
  await expect(page.locator('.conn')).toHaveAttribute('title', /· Bridge: devbox$/);
  expectClean();
});

test('a switch made in another tab: this page starts over on the new bridge, from a dropped connection or the list it polls', async ({ page }) => {
  const expectClean = watchErrors(page);
  const helper = await fakeHelper(page, [devbox, { ...laptop, state: 'up' }], devbox.id);
  // The page's /ws, passed through to the fixture: the test closes it the way the helper does on a switch.
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/fixture\//, (ws) => {
    ws.connectToServer();
    sockets.push(ws);
  });
  const bridgeOf = (ws: WebSocketRoute | undefined) => (ws ? new URL(ws.url()).searchParams.get('bridge') : null);
  // What the chip said, across the reload.
  await page.addInitScript(() => {
    let last = '';
    new MutationObserver(() => {
      const t = document.querySelector('.conn')?.textContent ?? '';
      if (t === last) return;
      last = t;
      sessionStorage.setItem('h57-chips', JSON.stringify([...(JSON.parse(sessionStorage.getItem('h57-chips') ?? '[]') as string[]), t]));
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await openGame(page, 'demo-m6', '', SIM);
  // The page names the bridge its drafts and seats belong to: the helper connects it to that one only.
  expect(bridgeOf(sockets.at(-1))).toBe(devbox.id);

  // Another tab switches to Laptop and the helper drops this page's connection. A tab in the background polls
  // nothing: the drop is what tells it, and it starts over on Laptop instead of reconnecting under devbox's keys.
  helper.state.active = laptop.id;
  const load = page.waitForEvent('load');
  await sockets.at(-1)!.close({ code: 1006 });
  await load;
  await page.waitForFunction(() => window.__h3d?.ready);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('h57-chips') ?? '[]') as string[])).toContain('Switching to Laptop…');
  await expect(page.locator('.conn')).toHaveAttribute('title', /· Bridge: Laptop$/);
  expect(bridgeOf(sockets.at(-1))).toBe(laptop.id);

  // Back to devbox, elsewhere again: this time the switch list (it polls while open) says so first.
  helper.state.active = devbox.id;
  const back = page.waitForEvent('load');
  await page.keyboard.press('Control+KeyP');
  await page.keyboard.type('switch bridge');
  await expect(names(page).first()).toHaveText('Switch bridge');
  await page.keyboard.press('Enter');
  await back;
  await page.waitForFunction(() => window.__h3d?.ready);
  await expect(page.locator('.conn')).toHaveAttribute('title', /· Bridge: devbox$/);
  expect(bridgeOf(sockets.at(-1))).toBe(devbox.id);
  expectClean();
});

test('on a phone the switch list keeps a bridge’s state in view next to a long address', async ({ page }) => {
  const expectClean = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const far: FakeBridge = { id: 'eeeeeeeeee', name: 'Far away', kind: 'ssh', host: 'someone@a-rather-long-hostname.internal.example.net', remote_socket: '/run/user/1000/herdr-world/bridge.sock', state: 'backoff' };
  await fakeHelper(page, [devbox, far], devbox.id);
  await openGame(page, 'demo-m6', '', SIM);
  await openSwitch(page);
  const row = palette(page).locator('.pal-opt[data-bridge="eeeeeeeeee"]');
  await expect(row.locator('.pal-br-state')).toHaveText('Offline, retrying');
  const [r, st] = await Promise.all([row.boundingBox(), row.locator('.pal-br-state').boundingBox()]);
  expect(st!.x + st!.width).toBeLessThanOrEqual(r!.x + r!.width);
  expect(await row.locator('.pal-br-addr').evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  expectClean();
});

test('a helper with no bridge: the game says to add one, and Switch bridge leads to Settings → Bridges', async ({ page }) => {
  const expectClean = watchErrors(page);
  await fakeHelper(page, [], '');
  await page.goto(`/?backend=webgl2&ws=${encodeURIComponent(`/fixture/demo-m6?${SIM}`)}&time=2026-09-30T12:00`);
  await expect(page.locator('.notice h2')).toHaveText('No bridge configured');
  await expect(page.locator('.notice p')).toContainText('Add one in Settings');
  await expect(page.locator('.conn')).toHaveText('No bridge');
  await expect(page.locator('.conn')).toHaveAttribute('title', 'No bridge configured: add one in Settings');
  await openSwitch(page);
  await expect(names(page)).toHaveText(['No other bridges: add one in Settings']);
  await page.keyboard.press('Enter');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expect(settings.locator('.settings-section[data-section="bridges"]')).toBeVisible();
  await expect(settings.locator('.settings-br-empty')).toHaveText('No bridge configured: add the machine that runs herdr-world below.');
  expectClean();
});

test('a page no helper serves has neither Switch bridge nor Settings → Bridges', async ({ page }) => {
  const expectClean = watchErrors(page);
  await openGame(page, 'demo-m6', '', SIM);
  await page.keyboard.press('Control+KeyP');
  await page.keyboard.type('switch bridge');
  await expect(palette(page).locator('.pal-status')).toHaveText('No command matches “switch bridge”.');
  await page.keyboard.press('Escape');
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' }).locator('[role="tab"][data-tab="bridges"]')).toBeHidden();
  expectClean();
});
