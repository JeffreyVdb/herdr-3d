import { expect, test } from '@playwright/test';
import { openGame, openMenu, settingsSection, shot, watchErrors } from './game';

// #91: the Settings window (the gear in the top bar, `,`): Display and Day and night, each labelled with where it is
// kept. The limits switch and the time fields themselves are exercised in m10-limits and m17-daynight.
// #49: one section at a time, picked from a grouped list down the side (a picker below 800px wide).

// The gear became a row of the top bar's Menu: open the menu, then the row.
const gear = (page: import('@playwright/test').Page) => page.locator('.topbar-menu button[aria-label="Settings"]');
const menuButton = (page: import('@playwright/test').Page) => page.locator('.btn--menu');

test('the gear opens Settings with its sections, each saying where it is kept; Esc and Close shut it', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page);
  const button = gear(page);
  await expect(button).toHaveAttribute('title', /Settings/);
  await openMenu(page);
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();

  const display = await settingsSection(page, 'display');
  await expect(display.getByRole('heading', { name: 'Display', level: 3 })).toBeVisible();
  await expect(display.locator('.settings-store')).toHaveText('This browser');
  await expect(display.getByLabel('Show plan limits (Claude and Codex) in the corner')).toBeChecked();
  const time = await settingsSection(page, 'time');
  await expect(display).toBeHidden();
  await expect(time.getByRole('heading', { name: 'Day and night', level: 3 })).toBeVisible();
  await expect(time.locator('.settings-store')).toHaveText('This browser');
  await expect(time.getByLabel('Timezone')).toBeVisible();
  await expect(time.getByLabel('Latitude')).toBeVisible();
  await shot(page, 'settings');

  // Esc: shut, and the Menu button (which the gear is a row of) has focus again.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(menuButton(page)).toBeFocused();

  // The Close button does the same.
  await openMenu(page);
  await button.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(menuButton(page)).toBeFocused();
  clean();
});

test('a click on the backdrop never closes Settings, not even a real press and release there', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page);
  await openMenu(page);
  await gear(page).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  // A half-typed field survives a stray click outside.
  await settingsSection(page, 'time');
  const zone = dialog.getByLabel('Timezone');
  await zone.fill('Europe/Bru');
  await page.mouse.click(4, 4);
  await expect(dialog).toBeVisible();
  await expect(zone).toHaveValue('Europe/Bru');
  // Press on the backdrop, release inside, and the other way round: stays.
  const b = (await dialog.boundingBox())!;
  await page.mouse.move(4, 4);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(4, 4, { steps: 10 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  clean();
});

test('"," opens Settings from the scene and from a focused button, and types a comma in a field', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page);
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await page.keyboard.press(',');
  await expect(dialog).toBeVisible();
  // A comma typed in a field is typed: it neither reopens nor closes anything.
  await settingsSection(page, 'time');
  const lat = dialog.getByLabel('Latitude');
  await lat.focus();
  await page.keyboard.type('5,0');
  await expect(lat).toHaveValue('5,0');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // From a focused top-bar button (not a field) the comma still opens it.
  await menuButton(page).focus();
  await page.keyboard.press(',');
  await expect(dialog).toBeVisible();
  clean();
});

test('Settings fits a narrow screen', async ({ page }) => {
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 360, height: 640 });
  await openGame(page);
  await openMenu(page);
  await gear(page).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await dialog.evaluate((d) => Promise.all(d.getAnimations().map((a) => a.finished)));
  const b = (await dialog.boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(360);
  expect(b.y + b.height).toBeLessThanOrEqual(640);
  // #49: nearly the whole screen, the section picker in place of the list.
  expect(b.width).toBeGreaterThanOrEqual(340);
  await expect(dialog.getByRole('tablist')).toBeHidden();
  await expect(dialog.getByLabel('Section', { exact: true })).toBeVisible();
  await shot(page, 'settings-narrow');
  clean();
});

test('on a floor at 360 px every top-bar button is on screen and a real click on the menu’s Settings row opens Settings', async ({ page }) => {
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 360, height: 640 });
  await openGame(page);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await expect(page.locator('.hud')).toHaveAttribute('data-mode', 'floor');
  const buttons = page.locator('.topbar button:visible');
  expect(await buttons.count()).toBeGreaterThanOrEqual(3); // City, the floor plate, Menu
  for (const [i, box] of (await buttons.evaluateAll((bs) => bs.map((b) => ({ label: b.getAttribute('aria-label') ?? b.textContent, r: b.getBoundingClientRect().toJSON() })))).entries()) {
    expect(box.r.x, `button ${i} (${box.label}) left edge`).toBeGreaterThanOrEqual(0);
    expect(box.r.x + box.r.width, `button ${i} (${box.label}) right edge`).toBeLessThanOrEqual(360);
    expect(box.r.y + box.r.height, `button ${i} (${box.label}) bottom edge`).toBeLessThanOrEqual(640);
  }
  // A real pointer click at the Settings row's centre (not a scrolled-into-view or keyboard shortcut open), the menu inside the screen.
  await menuButton(page).click();
  const menu = (await page.locator('.topbar-menu').boundingBox())!;
  expect(menu.x).toBeGreaterThanOrEqual(0);
  expect(menu.x + menu.width).toBeLessThanOrEqual(360);
  const g = (await gear(page).boundingBox())!;
  await page.mouse.click(g.x + g.width / 2, g.y + g.height / 2);
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  clean();
});

// ---- #49: the section navigator ---------------------------------------------------------------------------------

const ids = (page: import('@playwright/test').Page) =>
  page.locator('dialog.settings select.settings-pick-select option').evaluateAll((os) => os.filter((o) => !(o as HTMLOptionElement).hidden).map((o) => (o as HTMLOptionElement).value));

/** Every rule of a layout: in the screen, Close in it, the frame never scrolled, no section wider than the window. */
async function fits(page: import('@playwright/test').Page, w: number, h: number) {
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  // Measured at rest, after the entrance slide.
  await dialog.evaluate((d) => Promise.all(d.getAnimations().map((a) => a.finished)));
  const b = (await dialog.boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(w);
  expect(b.y + b.height).toBeLessThanOrEqual(h);
  const close = (await dialog.getByRole('button', { name: 'Close' }).boundingBox())!;
  expect(close.x + close.width).toBeLessThanOrEqual(b.x + b.width);
  expect(close.y).toBeGreaterThanOrEqual(b.y);
  expect(await dialog.evaluate((d) => d.scrollTop)).toBe(0);
  expect(await dialog.locator('.settings-body').evaluate((x) => x.scrollWidth - x.clientWidth)).toBeLessThanOrEqual(0);
  return b;
}

for (const [w, h] of [
  [1366, 768],
  [1440, 900],
] as const) {
  test(`at ${w}×${h} Settings is a wide workspace: the grouped list beside one section, which scrolls by itself`, async ({ page }) => {
    const clean = watchErrors(page);
    await page.setViewportSize({ width: w, height: h });
    await openGame(page, 'demo-m5', '', 'play=none&sim=1');
    await page.keyboard.press(',');
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    const b = await fits(page, w, h);
    expect(b.width).toBe(Math.min(1200, w - 32));
    expect(b.height).toBeGreaterThan(h * 0.85);

    // The list: a named vertical tablist that holds only tabs (the group names are for the eye), in its four groups.
    const list = dialog.getByRole('tablist', { name: 'Settings sections' });
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute('aria-orientation', 'vertical');
    await expect(dialog.getByLabel('Section', { exact: true })).toBeHidden();
    const tree = await list.ariaSnapshot();
    expect(tree.split('\n').slice(1).every((l) => /^\s+- tab "/.test(l)), tree).toBe(true);
    await expect(dialog.locator('.settings-nav-label:visible')).toHaveText(['General', 'Workers', 'AI', 'Integrations']);
    expect(await ids(page)).toEqual(['appearance', 'display', 'floors', 'time', 'notifications', 'harness-models', 'task-levels', 'codex', 'ai', 'followups', 'packup', 'activity', 'digest', 'handoff-llm', 'repos', 'kaneo']);
    const tabs = list.getByRole('tab');
    expect(await tabs.count()).toBe(16);

    // Each tab shows its section, named by the tab, and only that one.
    for (const id of await ids(page)) {
      const name = (await dialog.locator(`[role="tab"][data-tab="${id}"]`).textContent())!;
      await list.getByRole('tab', { name, exact: true }).click();
      await expect(list.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(dialog.getByRole('tabpanel', { name, exact: true })).toBeVisible();
      await expect(dialog.locator('.settings-section:visible')).toHaveCount(1);
    }

    // A long section (AI integration) scrolls inside its pane: header and list stay where they are.
    await settingsSection(page, 'ai');
    const body = dialog.locator('.settings-body');
    expect(await body.evaluate((x) => x.scrollHeight > x.clientHeight)).toBe(true);
    const before = await page.evaluate(() => [document.querySelector('dialog.settings .panel-head')!.getBoundingClientRect().top, document.querySelector('dialog.settings .settings-nav')!.getBoundingClientRect().top]);
    await body.evaluate((x) => (x.scrollTop = x.scrollHeight));
    await page.mouse.move(b.x + b.width - 100, b.y + b.height / 2);
    await page.mouse.wheel(0, 400);
    expect(await page.evaluate(() => [document.querySelector('dialog.settings .panel-head')!.getBoundingClientRect().top, document.querySelector('dialog.settings .settings-nav')!.getBoundingClientRect().top])).toEqual(before);
    expect(await dialog.evaluate((d) => d.scrollTop)).toBe(0);
    await shot(page, `settings-wide-${w}`);
    clean();
  });
}

for (const [w, h, what] of [
  [360, 640, 'a phone'],
  [683, 384, 'a 1366×768 laptop at 200% zoom'],
] as const) {
  test(`on ${what} (${w}×${h}) every section is reachable from the picker, nothing runs off the side, Close stays`, async ({ page }) => {
    const clean = watchErrors(page);
    await page.setViewportSize({ width: w, height: h });
    await openGame(page, 'demo-m5', '', 'play=none&sim=1');
    await page.keyboard.press(',');
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('tablist')).toBeHidden();
    const picker = dialog.getByLabel('Section', { exact: true });
    await expect(picker).toBeVisible();
    await expect(picker.locator('optgroup')).toHaveCount(4);
    for (const id of await ids(page)) {
      await picker.selectOption(id);
      await expect(dialog.locator(`.settings-section[data-section="${id}"]`)).toBeVisible();
      await expect(dialog.locator('.settings-section:visible')).toHaveCount(1);
      await fits(page, w, h);
      // No row of the section wider than its pane.
      const wide = await dialog.locator(`.settings-section[data-section="${id}"] *`).evaluateAll((els, right) => els.filter((e) => e.getBoundingClientRect().right > right + 0.5 && getComputedStyle(e).position !== 'fixed').map((e) => e.className), w);
      expect(wide, id).toEqual([]);
    }
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    clean();
  });
}

for (const theme of ['quiet', 'ubuntu'] as const) {
  test(`keyboard only, ${theme}: Shift+Tab to the list, arrows pick, Tab into the section, Esc restores the focus`, async ({ page }) => {
    const clean = watchErrors(page);
    if (theme === 'ubuntu') await page.addInitScript(() => localStorage.setItem('h3d.theme.ui', 'ubuntu'));
    await page.setViewportSize({ width: 1366, height: 768 });
    await openGame(page);
    await menuButton(page).focus();
    await page.keyboard.press(',');
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    // The body has the focus; the selected tab is the list's one tab stop, just before it.
    await page.keyboard.press('Shift+Tab');
    const appearance = dialog.getByRole('tab', { name: 'Appearance' });
    await expect(appearance).toBeFocused();
    await expect(appearance).toHaveAttribute('tabindex', '0');
    await page.keyboard.press('ArrowDown');
    const display = dialog.getByRole('tab', { name: 'Display' });
    await expect(display).toBeFocused();
    await expect(display).toHaveAttribute('aria-selected', 'true');
    await expect(appearance).toHaveAttribute('tabindex', '-1');
    await expect(dialog.getByRole('tabpanel', { name: 'Display' })).toBeVisible();
    await expect(dialog.getByRole('tabpanel', { name: 'Appearance' })).toBeHidden();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    // Wraps to the last section in the list.
    await expect(dialog.getByRole('tab').last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(appearance).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(dialog.getByRole('tab', { name: 'Day and night' })).toBeFocused();
    // Tab goes into the section showing (the hidden ones are out of the order), never to another tab.
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement;
      return { section: a.closest<HTMLElement>('.settings-section')?.dataset.section, role: a.getAttribute('role') };
    });
    expect(focused).toEqual({ section: 'time', role: null });
    await expect(page.locator('dialog.settings')).toHaveJSProperty('scrollTop', 0);
    await shot(page, `settings-keyboard-${theme}`);
    // The game's keys are inert while it is open; Esc closes and gives the focus back.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(menuButton(page)).toBeFocused();
    clean();
  });
}

test('a switch, a resize and a reopen keep half-typed fields, each section’s scroll and the section chosen', async ({ page }) => {
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1366, height: 768 });
  await openGame(page, 'demo-m5', '', 'play=none&sim=1');
  await page.keyboard.press(',');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  // A draft in an API field, never saved.
  const ai = await settingsSection(page, 'ai');
  const base = ai.getByRole('group', { name: /^LLM/ }).getByLabel('Base URL');
  await base.fill('http://127.0.0.1:9/draft');
  const body = dialog.locator('.settings-body');
  await body.evaluate((x) => (x.scrollTop = 180));
  const time = await settingsSection(page, 'time');
  await time.getByLabel('Timezone').fill('Europe/Bru');
  expect(await body.evaluate((x) => x.scrollTop)).toBe(0);
  // Wide to narrow: the picker shows the same section, still with its draft.
  await page.setViewportSize({ width: 360, height: 640 });
  await expect(dialog.getByLabel('Section', { exact: true })).toHaveValue('time');
  await expect(time.getByLabel('Timezone')).toHaveValue('Europe/Bru');
  await settingsSection(page, 'ai');
  await expect(base).toHaveValue('http://127.0.0.1:9/draft');
  // Narrow to wide: the list has the same selection.
  await page.setViewportSize({ width: 1366, height: 768 });
  await expect(dialog.getByRole('tab', { name: 'AI integration' })).toHaveAttribute('aria-selected', 'true');
  expect(await body.evaluate((x) => x.scrollTop)).toBe(180);
  // Close and reopen: the same section (whose open hook drops its drafts, as it always did on an open).
  await page.keyboard.press('Escape');
  await page.keyboard.press(',');
  await expect(dialog.getByRole('tabpanel', { name: 'AI integration' })).toBeVisible();
  // Nothing was sent for the switches: no AI test or save.
  const sent = await page.evaluate(() => window.__h3d.sent().map((c) => c.t));
  expect(sent.filter((t) => /^ai\.(test|set|clear)/.test(t))).toEqual([]);
  expect(await dialog.evaluate((d) => d.scrollTop)).toBe(0);
  clean();
});
