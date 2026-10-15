import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { frames, leftInTerminal, openGame, shot, watchErrors, openMenu, settingsSection } from './game';

// M10 (#12) on demo-m4 and the simulating fixture server (tools/fixture-limits.ts): the always-on plan limits widget in the
// city, on a floor, over an overlay; its colours, panel, staleness, refresh and switch-off; and the limits inside the
// hire and start-run dialogs. Readings: `simlimits=ok` is Claude team 5h 11 % / week 61 % (+ Opus 34 %, Fable 3 %) and Codex
// prolite week 19 %.

const SIM = (scenario = 'ok') => `play=none&sim=1&simms=150&simlimits=${scenario}`;

const widget = (page: Page) => page.evaluate(() => window.__h3d.limits());
const sent = (page: Page) => page.evaluate(() => window.__h3d.sent());
const limits = (page: Page) => page.locator('.limits');

async function withReadings(page: Page): Promise<NonNullable<Awaited<ReturnType<typeof widget>>>> {
  await expect.poll(async () => (await widget(page))?.lines.length, { message: 'readings arrived', timeout: 10_000 }).toBe(2);
  return (await widget(page))!;
}

async function enter(page: Page, session: string): Promise<void> {
  await page.evaluate((s) => window.__h3d.enterFloor(s), session);
  await frames(page, 3);
}

/** The widget is what a click at its middle would reach (nothing, not even a modal's backdrop, covers it). */
async function onTop(page: Page): Promise<boolean> {
  const r = await page.evaluate(() => {
    const box = document.querySelector('.limits')?.getBoundingClientRect();
    if (!box || !box.width) return { ok: false, why: 'no box' };
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { ok: !!hit?.closest('.limits'), why: `${hit?.tagName}.${hit?.className} at ${JSON.stringify(box)}` };
  });
  if (!r.ok) console.log(`widget covered by ${r.why}`);
  return r.ok;
}

/** The plate's own navy (#1c2540) where nothing is drawn on it: a modal's backdrop over it would dim it. */
async function undimmed(page: Page): Promise<boolean> {
  const r = (await limits(page).boundingBox())!;
  const png = PNG.sync.read(await page.screenshot({ clip: { x: r.x + r.width - 14, y: r.y + 1, width: 4, height: 4 } }));
  const [R, G, B] = [png.data[0]!, png.data[1]!, png.data[2]!];
  return Math.abs(R - 28) <= 3 && Math.abs(G - 37) <= 3 && Math.abs(B - 64) <= 3;
}

test('the widget shows in the city, top right under the bar, with both providers', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM());
  const w = await withReadings(page);
  expect(w).toMatchObject({ hidden: false, open: false });
  expect(w.lines.map((l) => [l.provider, l.stale, l.reached])).toEqual([['claude', false, false], ['codex', false, false]]);
  expect(w.lines[0]!.windows).toEqual([{ label: '5h', pct: '11%', sev: 'ok' }, { label: 'week', pct: '61%', sev: 'warn' }]);
  expect(w.lines[1]!.windows).toEqual([{ label: 'week', pct: '19%', sev: 'ok' }]);
  await expect(limits(page)).toBeVisible();
  const box = (await limits(page).boundingBox())!;
  const bar = (await page.locator('.topbar').boundingBox())!;
  expect(box.x + box.width).toBeGreaterThan(1280 - 24);
  expect(box.y).toBeGreaterThanOrEqual(bar.y + bar.height);
  expect(box.width).toBeLessThan(560);
  await expect(limits(page).locator('.lm-tape').first()).toHaveText('Claude');
  await shot(page, 'm10-city');
  clean();
});

test('click or Shift+L opens the panel: model weeks, credits, last read, refresh; it is remembered', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM());
  await withReadings(page);
  await page.locator('.lm-strip').click();
  expect((await widget(page))!.open).toBe(true);
  const panel = page.locator('.lm-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.lm-rowlab')).toHaveText(['5h', 'week', 'week · Opus', 'week · Fable', 'week']);
  await expect(panel.locator('.lm-sec[data-provider="codex"] .lm-meta')).toHaveText('CreditsNone');
  await expect(panel.locator('.lm-sec[data-provider="claude"] .lm-read')).toHaveText(/^Read \d\d:\d\d \(just now\)$/);
  // Reset times are local clock times.
  await expect(panel.locator('.lm-sec[data-provider="claude"] .lm-row').first().locator('.lm-rs')).toHaveText(/^resets (\w{3} )?\d\d:\d\d$/); // "Wed 00:06" when the reset falls on the next day
  await shot(page, 'm10-expanded');

  await page.locator('[data-key="limits-refresh"]').click();
  await expect.poll(async () => (await sent(page)).filter((c) => c.t === 'limits.refresh').map((c) => c.result?.ok)).toEqual([true]);
  // A second one right away is answered "just read".
  await page.locator('[data-key="limits-refresh"]').click();
  await expect(page.locator('.lm-status')).toHaveText('Just read; try again in a few seconds.');

  expect(await page.evaluate(() => localStorage.getItem('h3d.limits.open'))).toBe('1');
  await page.reload();
  await page.waitForFunction(() => window.__h3d?.ready && window.__h3d.frames >= 3);
  await withReadings(page);
  expect((await widget(page))!.open).toBe(true);
  await page.keyboard.press('Shift+L');
  expect((await widget(page))!.open).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('h3d.limits.open'))).toBeNull();
  await page.keyboard.press('Shift+L');
  expect((await widget(page))!.open).toBe(true);
  clean();
});

test('it stays on a floor, while walking and over an open overlay', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM());
  await withReadings(page);
  await enter(page, 'herdr-3d');
  await expect(limits(page)).toBeVisible();
  await page.keyboard.down('KeyW');
  await frames(page, 3); // (the slim top bar: a longer walk ends at the board's bare cork, which the shot calls blank)
  await page.keyboard.up('KeyW');
  expect(await onTop(page)).toBe(true);
  await shot(page, 'm10-walk');
  // Plain L is still the elevator; the widget is not in its way.
  await page.evaluate(() => window.__h3d.openSettings('herdr-3d'));
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.panel()))?.kind).toBeTruthy();
  await expect(limits(page)).toBeVisible();
  await expect(limits(page)).toHaveAttribute('data-dock', 'tab'); // a panel has the screen (#47): the plate is an edge tab
  await expect.poll(() => undimmed(page), { message: 'in the top layer above the modal’s backdrop' }).toBe(true); // once its slide-in is over
  await shot(page, 'm10-overlay');
  clean();
});

test('colours change at the thresholds, and a reached limit pulses', async ({ page }) => {
  test.setTimeout(120_000);
  await openGame(page, 'demo-m4', '', SIM('hot'));
  let w = await withReadings(page);
  expect(w.lines[0]!.windows).toEqual([{ label: '5h', pct: '40%', sev: 'ok' }, { label: 'week', pct: '91%', sev: 'high' }]);
  expect(w.lines[1]!.windows.map((x) => x.sev)).toEqual(['high', 'warn']);
  await expect(limits(page)).toHaveAttribute('data-worst', 'high');
  await expect(limits(page)).toHaveAttribute('data-reached', 'false');
  const fill = (n: number) => limits(page).locator('.lm-line').first().locator('.lm-bar i').nth(n).evaluate((e) => getComputedStyle(e).backgroundColor);
  expect([await fill(0), await fill(1)]).toEqual(['rgb(47, 196, 106)', 'rgb(255, 96, 88)']);
  await shot(page, 'm10-hot');

  await openGame(page, 'demo-m4', '', SIM('reached'));
  w = await withReadings(page);
  expect(w.lines[1]).toMatchObject({ provider: 'codex', reached: true });
  await expect(limits(page)).toHaveAttribute('data-reached', 'true');
  expect(await limits(page).evaluate((e) => getComputedStyle(e).animationName)).toBe('lm-pulse');
  await shot(page, 'm10-reached');
});

test('old and transcript readings are dimmed with the time they are as of', async ({ page }) => {
  test.setTimeout(120_000);
  await openGame(page, 'demo-m4', '', SIM('old'));
  let w = await withReadings(page);
  expect(w.lines.map((l) => l.stale)).toEqual([true, false]);
  await expect(limits(page).locator('.lm-line[data-provider="claude"] .lm-asof')).toHaveText(/^as of \d\d:\d\d$/);
  expect(await limits(page).locator('.lm-line[data-provider="claude"] .lm-wins').evaluate((e) => getComputedStyle(e).opacity)).toBe('0.72');
  await openGame(page, 'demo-m4', '', SIM('transcript'));
  w = await withReadings(page);
  expect(w.lines.map((l) => l.stale)).toEqual([false, true]);
  await page.locator('.lm-strip').click();
  await expect(page.locator('.lm-sec[data-provider="codex"] .lm-read')).toHaveText(/^As of \d\d:\d\d, from the last Codex session log$/);
  await shot(page, 'm10-stale');
});

test('it can be hidden from the panel, comes back in Settings and with Shift+L, and is absent from an older bridge', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM());
  await withReadings(page);
  await page.locator('.lm-strip').click();
  await page.locator('[data-key="limits-hide"]').click();
  await expect(limits(page)).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('h3d.limits.hidden'))).toBe('1');
  await expect(page.locator('.toast')).toHaveText('Plan limits hidden. Show them again in Settings.');
  // Settings has the switch (Display).
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsSection(page, 'display'); // #49: one section at a time
  const box = page.locator('#settings-limits');
  await expect(box).not.toBeChecked();
  await box.check();
  await expect(box).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(limits(page)).toBeVisible();
  await expect(page.locator('[data-key="limits-hide"]')).toBeVisible(); // the panel was open when it went
  await page.locator('[data-key="limits-hide"]').click();
  await expect(limits(page)).toBeHidden();
  await page.keyboard.press('Shift+L');
  await expect(limits(page)).toBeVisible();
  expect((await widget(page))!.open).toBe(true);

  // A bridge from before M10 sends no limits: no widget, and no error.
  await page.evaluate(() => localStorage.clear());
  await openGame(page, 'demo-m4', '', `${SIM()}&simfail=no_m10`);
  await expect(limits(page)).toBeHidden();
  clean();
});

test('the hire dialog shows the chosen harness’s limits and warns above 85 %', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM('hot'));
  await withReadings(page);
  await enter(page, 'herdr-3d');
  await page.evaluate(() => window.__h3d.openHire(5));
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.dialog()))?.kind === 'hire' && (await page.evaluate(() => window.__h3d.dialog()))!.state).toBe('ready');
  const slot = page.locator('[data-hook="plan-limits"]');
  await expect(slot).toBeVisible();
  await expect(slot.locator('.lm-line')).toHaveCount(1);
  await expect(slot.locator('.lm-line')).toContainText('Claude');
  await expect(slot.locator('.lm-warn')).toHaveText(/^Claude week limit is at 91%, resets /);
  // #51: the hire dialog is a screen dialog now (a near-full-screen sheet): the corner plate steps out of it (no gutter for the edge tab), and the dialog's own line is the limits.
  await expect(limits(page)).toHaveAttribute('data-dock', 'away');
  await expect(limits(page)).toBeHidden();
  await shot(page, 'm10-hire-warn');
  // Codex: its own limits and its own warning.
  await page.locator('[data-key="harness:codex"]').check({ force: true });
  await expect(slot.locator('.lm-line')).toHaveCount(1);
  await expect(slot.locator('.lm-line')).toContainText('Codex');
  await expect(slot.locator('.lm-warn')).toHaveText(/^Codex 5h limit is at 88%, resets /);
  clean();
});

test('the hire dialog has no warning below 85 %, and the start-run dialog shows the team’s harnesses', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM());
  await withReadings(page);
  await enter(page, 'herdr-3d');
  await page.evaluate(() => window.__h3d.openHire(5));
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.dialog()))?.kind).toBe('hire');
  const slot = page.locator('[data-hook="plan-limits"]');
  await expect(slot.locator('.lm-line')).toHaveCount(1);
  await expect(slot.locator('.lm-warn')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.dialog())).toBeNull();

  // Build team: a Claude orchestrator with Codex reviewers: both providers.
  await page.evaluate(() => window.__h3d.openStartRun({ session: 'herdr-3d', desk: 5 }));
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.dialog()))?.kind === 'start-run' && (await page.evaluate(() => window.__h3d.dialog()))!.state).toBe('ready');
  const run = page.locator('dialog.desk-dlg--run [data-hook="plan-limits"]');
  await expect(run.locator('.lm-line')).toHaveCount(2);
  await expect(run.locator('.lm-line').nth(0)).toContainText('Claude');
  await expect(run.locator('.lm-line').nth(1)).toContainText('Codex');
  await shot(page, 'm10-start-run');
  clean();
});

test('the Changes panel keeps the right column: the widget steps aside and both stay clickable', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM());
  await withReadings(page);
  await enter(page, 'herdr-3d');
  const w = await page.evaluate(() => window.__h3d.world().find((f) => f.session === 'herdr-3d')?.workers.find((x) => x.status === 'working'));
  await page.evaluate((id) => window.__h3d.openChanges(id), w!.id);
  await expect(page.locator('dialog.changes')).toBeVisible();
  await expect(limits(page)).toHaveAttribute('data-beside', 'changes');
  const a = (await limits(page).boundingBox())!;
  const b = (await page.locator('dialog.changes').boundingBox())!;
  expect(a.x + a.width).toBeLessThanOrEqual(b.x);
  await page.locator('.lm-strip').click(); // still clickable
  expect((await widget(page))!.open).toBe(true);
  await shot(page, 'm10-beside-changes');
  clean();
});

test('a bridge with limits off (--no-limits) shows no widget and no inline limits; one with no reading yet says it is reading', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  // --no-limits: the snapshot has no `limits` key at all, and limits.refresh is unsupported.
  await openGame(page, 'demo-m4', '', SIM('off'));
  await frames(page, 3);
  await expect(limits(page)).toBeHidden();
  expect(await widget(page)).toMatchObject({ hidden: true, lines: [] });
  await page.keyboard.press('Shift+L'); // nothing to open
  await expect(limits(page)).toBeHidden();
  await enter(page, 'herdr-3d');
  await page.evaluate(() => window.__h3d.openHire(5));
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.dialog()))?.kind === 'hire' && (await page.evaluate(() => window.__h3d.dialog()))!.state).toBe('ready');
  await expect(page.locator('[data-hook="plan-limits"]')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.dialog())).toBeNull();
  await page.evaluate(() => window.__h3d.openStartRun({ session: 'herdr-3d', desk: 5 }));
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.dialog()))?.kind === 'start-run' && (await page.evaluate(() => window.__h3d.dialog()))!.state).toBe('ready');
  await expect(page.locator('dialog.desk-dlg--run [data-hook="plan-limits"]')).toBeHidden();

  // A bridge that reads limits but has no reading yet (`limits: []`): the widget is there, and says so.
  await page.evaluate(() => localStorage.clear());
  await openGame(page, 'demo-m4', '', SIM('none'));
  await expect(limits(page)).toBeVisible();
  await expect(limits(page)).toContainText('Plan limits · reading…');
  expect(await widget(page)).toMatchObject({ hidden: false, lines: [] });
  clean();
});

test('the dialog’s limits include the chosen model’s own window and warn about it', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM('model')); // Claude week 61 %, its Opus week 96 %
  await withReadings(page);
  await enter(page, 'herdr-3d');
  await page.evaluate(() => window.__h3d.openHire(5));
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.dialog()))?.kind === 'hire' && (await page.evaluate(() => window.__h3d.dialog()))!.state).toBe('ready');
  const slot = page.locator('[data-hook="plan-limits"]');
  await page.locator('[data-key="harness:claude"]').check({ force: true });
  await page.locator('[data-key="model:claude-opus-5-5"]').check({ force: true });
  await expect(slot.locator('.lm-line .lm-lab')).toHaveText(['5h', 'week', 'week · Opus']);
  await expect(slot.locator('.lm-warn')).toHaveText(/^Claude week · Opus limit is at 96%, resets /);
  // Another model: its own window (Fable, 3 %), and nothing to warn about.
  await page.locator('[data-key="model:claude-fable-5-1"]').check({ force: true });
  await expect(slot.locator('.lm-line .lm-lab')).toHaveText(['5h', 'week', 'week · Fable']);
  await expect(slot.locator('.lm-warn')).toHaveCount(0);
  clean();
});

// Narrow viewports: the open panel fits and keeps its buttons in reach, and it never sits over an open dialog.

const inViewport = (b: { x: number; y: number; width: number; height: number }, vp: { width: number; height: number }) => b.x >= 0 && b.y >= 0 && b.x + b.width <= vp.width + 0.5 && b.y + b.height <= vp.height + 0.5;

test('at 320x400 the open panel stays inside the viewport: its body scrolls, Refresh and Hide stay clickable', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const vp = { width: 320, height: 400 };
  await page.setViewportSize(vp);
  await openGame(page, 'demo-m4', '', SIM());
  await withReadings(page);
  await page.locator('.lm-strip').click();
  expect((await widget(page))!.open).toBe(true);
  const box = (await limits(page).boundingBox())!;
  expect(inViewport(box, vp), `panel ${JSON.stringify(box)}`).toBe(true);
  for (const key of ['limits-refresh', 'limits-hide']) {
    const b = (await page.locator(`[data-key="${key}"]`).boundingBox())!;
    expect(inViewport(b, vp), `${key} ${JSON.stringify(b)}`).toBe(true);
  }
  const scroll = await page.locator('.lm-body').evaluate((e) => ({ scrolls: e.scrollHeight > e.clientHeight, overflowY: getComputedStyle(e).overflowY }));
  expect(scroll).toEqual({ scrolls: true, overflowY: 'auto' });
  await page.locator('.lm-body').evaluate((e) => (e.scrollTop = e.scrollHeight)); // the last provider is reachable too
  await expect(page.locator('.lm-sec[data-provider="codex"] .lm-read')).toBeInViewport();
  await shot(page, 'm10-narrow-320');
  await page.locator('[data-key="limits-refresh"]').click();
  await expect.poll(async () => (await sent(page)).filter((c) => c.t === 'limits.refresh').length).toBe(1);
  await page.locator('[data-key="limits-hide"]').click();
  await expect(limits(page)).toBeHidden();
  clean();
});

test('at 390x640 an open panel folds away while a dialog is open, and comes back when it closes', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const vp = { width: 390, height: 640 };
  await page.setViewportSize(vp);
  await page.addInitScript(() => localStorage.setItem('h3d.limits.open', '1')); // it was left open last time
  await openGame(page, 'demo-m4', '', SIM());
  await withReadings(page);
  expect((await widget(page))!.open).toBe(true);
  await enter(page, 'herdr-3d');
  await page.evaluate(() => window.__h3d.openHire(5));
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.dialog()))?.kind === 'hire' && (await page.evaluate(() => window.__h3d.dialog()))!.state).toBe('ready');
  // The plate steps out of the dialog: nothing of it is on screen, and the state says its panel is not open.
  expect((await widget(page))!.open).toBe(false);
  await expect(limits(page)).toBeHidden();
  await expect(limits(page)).toHaveAttribute('data-folded', 'true');
  // The dialog carries the chosen harness's limits itself, and its controls are all reachable.
  await expect(page.locator('[data-hook="plan-limits"] .lm-line')).toHaveCount(1);
  for (const sel of ['[data-key="task"]', '[data-key="close"]', '[data-key="hire"]']) await expect(page.locator(sel)).toBeInViewport();
  await shot(page, 'm10-narrow-hire');
  // Shift+L does not flip a hidden panel behind the dialog.
  await page.keyboard.press('Shift+L');
  expect((await widget(page))!.open).toBe(false);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.dialog())).toBeNull();
  await expect.poll(async () => (await widget(page))!.open).toBe(true); // restored
  await expect(page.locator('.lm-panel')).toBeVisible();
  await expect(limits(page)).toHaveAttribute('data-folded', 'false');
  expect(await page.evaluate(() => localStorage.getItem('h3d.limits.open'))).toBe('1');
  clean();
});

test('at 390x640 the widget does not cover the Changes panel’s Close control', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const vp = { width: 390, height: 640 };
  await page.setViewportSize(vp);
  await page.addInitScript(() => localStorage.setItem('h3d.limits.open', '1'));
  await openGame(page, 'demo-m4', '', SIM());
  await withReadings(page);
  await enter(page, 'herdr-3d');
  const w = await page.evaluate(() => window.__h3d.world().find((f) => f.session === 'herdr-3d')?.workers.find((x) => x.status === 'working'));
  await page.evaluate((id) => window.__h3d.openChanges(id), w!.id);
  await expect(page.locator('dialog.changes')).toBeVisible();
  expect((await widget(page))!.open).toBe(false);
  await expect(limits(page)).toBeHidden(); // it does not sit over Close
  await expect(page.locator('dialog.changes [data-key="close"]')).toBeInViewport();
  await page.locator('dialog.changes [data-key="close"]').click(); // and it is clickable
  await expect(page.locator('dialog.changes')).toBeHidden();
  await expect.poll(async () => (await widget(page))!.open).toBe(true);
  await expect(page.locator('.lm-panel')).toBeVisible();
  await shot(page, 'm10-narrow-changes');
  clean();
});

// Screen-filling dialogs (#47): the Issues / Pull requests boards and the M3 panels. The plate steps out of them into an
// edge tab (or away when the viewport leaves no gutter), Shift+L or a click on the tab peeks it, and closing the dialog
// puts it back exactly as it was. Boards need the boards fixture (demo-m6, floor `lab`) next to the limits simulation.

const BOARDS = `${SIM()}&simusage=0`;
type Box = { x: number; y: number; width: number; height: number };
const apart = (a: Box, b: Box) => a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 || a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5;
const dock = (page: Page) => limits(page).getAttribute('data-dock');
const savedOpen = (page: Page) => page.evaluate(() => localStorage.getItem('h3d.limits.open'));

async function openIssues(page: Page): Promise<void> {
  await openGame(page, 'demo-m6', '&open=none', BOARDS);
  await withReadings(page);
  await enter(page, 'lab');
  await page.evaluate(() => window.__h3d.openBoard('issues'));
  await expect(page.locator('dialog.desk-dlg--board')).toBeVisible();
  await expect(page.locator('dialog.desk-dlg--board .bd-card').first()).toBeVisible();
}

/** What a click at the middle of `sel` would reach is `sel` itself (or inside it). */
const reachable = (page: Page, sel: string) =>
  page.evaluate((s) => {
    const b = document.querySelector(s)?.getBoundingClientRect();
    if (!b) return false;
    return !!document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest(s);
  }, sel);

for (const expanded of [false, true]) {
  test(`at 2000x860 an Issues board ${expanded ? 'with the panel expanded' : 'with the strip'}: the widget is an edge tab clear of the board, and comes back as it was`, async ({ page }) => {
    test.setTimeout(120_000);
    const clean = watchErrors(page);
    await page.setViewportSize({ width: 2000, height: 860 });
    if (expanded) await page.addInitScript(() => localStorage.setItem('h3d.limits.open', '1'));
    await openGame(page, 'demo-m6', '&open=none', BOARDS);
    await withReadings(page);
    expect((await widget(page))!.open).toBe(expanded);
    await expect(page.locator('.lm-panel')).toBeVisible({ visible: expanded });
    await enter(page, 'lab');
    await page.evaluate(() => window.__h3d.openBoard('issues'));
    await expect(page.locator('dialog.desk-dlg--board .bd-card').first()).toBeVisible();

    // The plate stepped out: an edge tab, no panel, and nothing saved changed.
    await expect(limits(page)).toHaveAttribute('data-dock', 'tab');
    await expect(limits(page)).toBeVisible();
    expect((await widget(page))!.open).toBe(false);
    await expect(page.locator('.lm-panel')).toBeHidden();
    await expect(page.locator('.lm-strip')).toBeHidden();
    expect(await savedOpen(page)).toBe(expanded ? '1' : null);
    await expect(page.locator('.lm-tab-pct')).toHaveText('61%'); // the worst window
    // It covers nothing the board shows: not the dialog, its close button, nor its first row of cards.
    const hud = (await limits(page).boundingBox())!;
    const dlg = (await page.locator('dialog.desk-dlg--board').boundingBox())!;
    const closeBtn = page.locator('dialog.desk-dlg--board [data-key="close"]');
    const close = (await closeBtn.boundingBox())!;
    expect(apart(hud, dlg), `hud ${JSON.stringify(hud)} dialog ${JSON.stringify(dlg)}`).toBe(true);
    expect(apart(hud, close)).toBe(true);
    for (const card of await page.locator('dialog.desk-dlg--board .bd-col-cards > :first-child').all()) expect(apart(hud, (await card.boundingBox())!)).toBe(true);
    expect(await reachable(page, 'dialog.desk-dlg--board [data-key="close"]')).toBe(true);
    await shot(page, `m10-board-${expanded ? 'expanded' : 'strip'}`);

    // Close it with the mouse: the plate is back in the state it was.
    await closeBtn.click();
    await expect(page.locator('dialog.desk-dlg--board')).toBeHidden();
    await expect(limits(page)).toHaveAttribute('data-dock', '');
    await expect(page.locator('.lm-panel')).toBeVisible({ visible: expanded });
    await expect(page.locator('.lm-strip')).toBeVisible();
    expect((await widget(page))!.open).toBe(expanded);
    expect(await savedOpen(page)).toBe(expanded ? '1' : null);
    expect(await page.evaluate(() => !!document.activeElement?.closest('.limits'))).toBe(false); // it took no focus
    clean();
  });
}

test('over a board a held Shift+L peeks once: auto-repeat does not toggle it back (#124)', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 2000, height: 860 });
  await openIssues(page);
  await expect(limits(page)).toHaveAttribute('data-dock', 'tab');
  await page.keyboard.down('Shift');
  await page.keyboard.down('L');
  await expect(limits(page)).toHaveAttribute('data-peek', 'true');
  for (let i = 0; i < 3; i++) await page.keyboard.down('L'); // the key held: Playwright sends these with repeat set
  await frames(page, 3);
  await expect(limits(page)).toHaveAttribute('data-peek', 'true');
  await page.keyboard.up('L');
  await page.keyboard.up('Shift');
  await frames(page, 2);
  await expect(limits(page)).toHaveAttribute('data-peek', 'true'); // the release changes nothing either
  clean();
});

test('over a board a click on the tab or Shift+L peeks the panel above it without touching the saved state', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 2000, height: 860 });
  await openIssues(page);
  await expect(limits(page)).toHaveAttribute('data-dock', 'tab');

  await page.locator('[data-key="limits-tab"]').click(); // a click reaches it above the modal
  await expect(limits(page)).toHaveAttribute('data-peek', 'true');
  expect((await widget(page))!.open).toBe(true);
  await expect(page.locator('.lm-panel')).toBeVisible();
  expect(await onTop(page)).toBe(true);
  expect(await savedOpen(page)).toBeNull();
  await shot(page, 'm10-board-peek');
  await page.locator('.lm-strip').click(); // its header ends the peek
  await expect(limits(page)).toHaveAttribute('data-dock', 'tab');
  expect((await widget(page))!.open).toBe(false);

  // Shift+L: the same peek, and again to end it (the board owns the other keys).
  await page.keyboard.press('Shift+L');
  await expect(limits(page)).toHaveAttribute('data-peek', 'true');
  expect((await widget(page))!.open).toBe(true);
  await page.keyboard.press('Shift+L');
  await expect(limits(page)).toHaveAttribute('data-peek', 'false');
  await expect(limits(page)).toHaveAttribute('data-dock', 'tab');

  // A click on the board ends it too; Esc closes the board and the peek with it.
  await page.keyboard.press('Shift+L');
  await expect(page.locator('.lm-panel')).toBeVisible();
  await page.locator('dialog.desk-dlg--board .dd-titles').click();
  await expect(limits(page)).toHaveAttribute('data-peek', 'false');
  await page.keyboard.press('Shift+L');
  await expect(page.locator('.lm-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.desk-dlg--board')).toBeHidden();
  await expect(limits(page)).toHaveAttribute('data-peek', 'false');
  await expect(limits(page)).toHaveAttribute('data-dock', '');
  expect((await widget(page))!.open).toBe(false); // the saved state: the strip
  await expect(page.locator('.lm-panel')).toBeHidden();
  expect(await savedOpen(page)).toBeNull();
  clean();
});

test('a peek ends when the dialog that owned it closes, even if the board under it stays open', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1200, height: 860 }); // no gutter: the plate is away over the board
  await openIssues(page);
  await expect(limits(page)).toHaveAttribute('data-dock', 'away');
  const board = page.locator('dialog.desk-dlg--board');
  const item = page.locator('dialog.desk-dlg--item');
  const openItem = async () => {
    await board.locator('.bd-card', { hasText: '#7' }).first().click();
    await expect(item).toBeVisible();
  };

  // Peek over the item modal, then close only the item: the board is still open but the peek is over.
  await openItem();
  await page.keyboard.press('Shift+L');
  await expect(limits(page)).toHaveAttribute('data-peek', 'true');
  expect((await widget(page))!.open).toBe(true);
  await page.keyboard.press('Escape'); // closes the item only
  await expect(item).toBeHidden();
  await expect(board).toBeVisible();
  await expect(limits(page)).toHaveAttribute('data-peek', 'false');
  await expect(limits(page)).toHaveAttribute('data-dock', 'away');
  expect((await widget(page))!.open).toBe(false);
  await expect(page.locator('.lm-panel')).toBeHidden();
  expect(await savedOpen(page)).toBeNull(); // the saved state never moved
  expect(await page.evaluate(() => !!document.activeElement?.closest('.limits'))).toBe(false); // no focus taken
  // Nothing of the board is under the plate: its Close button is reachable and the first cards are clear.
  const hud = await limits(page).boundingBox();
  if (hud) {
    expect(apart(hud, (await board.locator('[data-key="close"]').boundingBox())!)).toBe(true);
    for (const card of await board.locator('.bd-col-cards > :first-child').all()) expect(apart(hud, (await card.boundingBox())!)).toBe(true);
  }
  expect(await reachable(page, 'dialog.desk-dlg--board [data-key="close"]')).toBe(true);

  // The mirror: a peek started over the board ends when an item opens on top of it (the plate docks for the item).
  await page.keyboard.press('Shift+L');
  await expect(limits(page)).toHaveAttribute('data-peek', 'true');
  await page.evaluate(() => window.__h3d.openBoardItem('issues', 'JeffreyVdb/lab#7'));
  await expect(item).toBeVisible();
  await expect(limits(page)).toHaveAttribute('data-peek', 'false');
  await expect(limits(page)).toHaveAttribute('data-dock', 'away');
  await page.keyboard.press('Escape');
  await expect(item).toBeHidden();
  await expect(limits(page)).toHaveAttribute('data-peek', 'false');
  await expect(limits(page)).toHaveAttribute('data-dock', 'away');
  await page.keyboard.press('Escape');
  await expect(board).toBeHidden();
  await expect(limits(page)).toHaveAttribute('data-dock', '');
  await expect(page.locator('.lm-strip')).toBeVisible();
  expect(await savedOpen(page)).toBeNull();
  clean();
});

test('a board wider than the room beside it folds the widget away; Shift+L still peeks; it comes back on close', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1200, height: 800 }); // the board is 1168 wide: 16 px each side, no room for the tab
  await page.addInitScript(() => localStorage.setItem('h3d.limits.open', '1'));
  await openIssues(page);
  await expect(limits(page)).toHaveAttribute('data-dock', 'away');
  await expect(limits(page)).toBeHidden();
  expect((await widget(page))!.open).toBe(false);
  await page.keyboard.press('Shift+L');
  await expect(limits(page)).toBeVisible();
  await expect(page.locator('.lm-panel')).toBeVisible();
  expect(await onTop(page)).toBe(true);
  expect(await savedOpen(page)).toBe('1');
  // More room (a wider window): the tab takes over from the fold.
  await page.keyboard.press('Shift+L');
  await expect(limits(page)).toBeHidden();
  await page.setViewportSize({ width: 1400, height: 800 });
  await expect(limits(page)).toHaveAttribute('data-dock', 'tab');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.desk-dlg--board')).toBeHidden();
  await expect(limits(page)).toHaveAttribute('data-dock', '');
  await expect(page.locator('.lm-panel')).toBeVisible(); // it was expanded
  expect(await savedOpen(page)).toBe('1');
  clean();
});

test('an M3 panel (settings) at any width also gets the edge tab; the hire sheet folds it away, small dialogs (start-run) keep the plate', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM());
  await withReadings(page);
  await enter(page, 'herdr-3d');
  await page.evaluate(() => window.__h3d.openSettings('herdr-3d'));
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.panel()))?.kind).toBeTruthy();
  await expect(limits(page)).toHaveAttribute('data-dock', 'tab');
  const hud = (await limits(page).boundingBox())!;
  expect(apart(hud, (await page.locator('dialog.panel').boundingBox())!)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.panel')).toBeHidden();
  await expect(limits(page)).toHaveAttribute('data-dock', '');
  await expect(page.locator('.lm-strip')).toBeVisible();

  // #51: the hire dialog is a near-full-screen sheet, so a screen dialog too: no gutter for the tab, the plate is away (its limits are inline).
  await page.evaluate(() => window.__h3d.openHire(5));
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.dialog()))?.kind).toBe('hire');
  await expect(limits(page)).toHaveAttribute('data-dock', 'away');
  await expect(page.locator('[data-hook="plan-limits"] .lm-line')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.dialog())).toBeNull();
  await expect(limits(page)).toHaveAttribute('data-dock', '');

  // A small dialog (start-run) keeps the plate as it was, above it.
  await page.evaluate(() => window.__h3d.openStartRun({ session: 'herdr-3d', desk: 5 }));
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.dialog()))?.kind).toBe('start-run');
  await expect(limits(page)).toHaveAttribute('data-dock', ''); // today's behaviour: the plate stays, above the dialog
  await expect(page.locator('.lm-strip')).toBeVisible();
  expect(await undimmed(page)).toBe(true);
  clean();
});

// #49: Settings is a workspace (up to 1200 px wide, 90 % of the height), so it is a screen for the corner: on a laptop the
// plate would sit on its header and Close. It steps out into the edge tab in the gutter beside it, and the inbox chip goes
// with it; both are back when Settings closes. Demo-m5 has workers waiting on you, so the chip is up to begin with.
for (const theme of ['quiet', 'ubuntu'] as const) {
  test(`at 1366x768 (${theme}) Settings keeps its header and Close clear: the plate is an edge tab beside it, the inbox chip steps out`, async ({ page }) => {
    test.setTimeout(120_000);
    const clean = watchErrors(page);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.addInitScript((t) => localStorage.setItem('h3d.theme.ui', t), theme);
    await openGame(page, 'demo-m5', '&prints=0', SIM());
    await withReadings(page);
    await expect.poll(async () => (await page.evaluate(() => window.__h3d.inbox()))?.shown).toBe(true);
    await openMenu(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();

    await expect(limits(page)).toHaveAttribute('data-dock', 'tab');
    await expect(limits(page)).toHaveAttribute('data-fit', 'full');
    await expect(page.locator('.inbox')).toBeHidden();
    const hud = (await limits(page).boundingBox())!;
    const dlg = (await dialog.boundingBox())!;
    const close = dialog.getByRole('button', { name: 'Close' });
    expect(apart(hud, dlg), `hud ${JSON.stringify(hud)} dialog ${JSON.stringify(dlg)}`).toBe(true);
    expect(apart(hud, (await close.boundingBox())!)).toBe(true);
    expect(await reachable(page, 'dialog.settings .panel-close')).toBe(true);
    // The tab, inside Settings (the top modal), is still a control: a click peeks the plate.
    expect(await reachable(page, '.limits')).toBe(true);
    await shot(page, `m10-settings-1366-${theme}`);

    await close.click();
    await expect(dialog).toBeHidden();
    await expect(limits(page)).toHaveAttribute('data-dock', '');
    await expect(page.locator('.lm-strip')).toBeVisible();
    await expect.poll(async () => (await page.evaluate(() => window.__h3d.inbox()))?.shown).toBe(true);
    clean();
  });
}

// Seated at a worker's laptop (#53): the laptop's screen fills the view, so the plate is its edge tab, and standing up gives
// back what the prefs say. Peeks (the tab, Shift+L) leave the prefs alone. demo-m5 has the floor and the workers to sit at.

/** The first worker of demo-m5's floor. */
const firstWorker = (): string => {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Array<{ id: string }> } };
  return snap.world.workers[0]!.id;
};
const savedHidden = (page: Page) => page.evaluate(() => localStorage.getItem('h3d.limits.hidden'));

async function sitAtLaptop(page: Page): Promise<void> {
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const id = firstWorker();
  // #98: these start in the terminal (sat down as someone who left it there; else its conversation opens).
  await leftInTerminal(page, id);
  expect(await page.evaluate((w) => window.__h3d.face(w), id)).toBe(true);
  await frames(page, 3);
  await page.keyboard.press('e');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
  await frames(page, 10);
}

async function standUp(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
}

/** The monitor's glass on the viewport: the conversation overlay is laid over exactly it. Leaves the seat in the terminal view it found. */
async function glassBox(page: Page): Promise<Box> {
  const mode = () => page.evaluate(() => window.__h3d.transcript()?.mode);
  await page.keyboard.press('Control+Escape');
  await expect.poll(mode).toBe('transcript');
  await expect.poll(() => page.evaluate(() => window.__h3d.transcript()?.box ?? null)).not.toBeNull();
  await frames(page, 10);
  const b = (await page.evaluate(() => window.__h3d.transcript()!.box))!;
  await page.keyboard.press('Control+Escape');
  await expect.poll(mode).toBe('terminal');
  await frames(page, 10);
  return { x: b.left, y: b.top, width: b.width, height: b.height };
}

// The tab never covers the glass, and it stays: in the gutter right of the monitor it is the full tab where that has room
// (1600x700), else a snug one fitted to the thin gutter (1280x900, 1024x768 and 800x600 leave 39, 30 and 27 px). Clickable
// in both views, peeking without touching the saved state, and a peeked plate hands back to the tab.
for (const [w, h, want] of [
  [1024, 768, 'snug'],
  [1280, 900, 'snug'],
  [800, 600, null], // the gutter depends on the seat's camera: snug or full, never away
  [1600, 700, 'full'],
] as const) {
  test(`seated at ${w}x${h} the limits tab sits clear of the glass${want ? ` (${want})` : ''}, in the terminal and in the conversation`, async ({ page }) => {
    test.setTimeout(120_000);
    const clean = watchErrors(page);
    await page.setViewportSize({ width: w, height: h });
    await openGame(page, 'demo-m5', '', `${SIM()}&simusage=0`);
    await withReadings(page);
    await sitAtLaptop(page);
    const glass = await glassBox(page);
    // The full tab needs 48 px right of the glass, the snug one 27 (limits.ts); the glass is measured independently of the widget.
    const gutter = w - (glass.x + glass.width);
    const fit = gutter >= 48 ? 'full' : 'snug';
    test.info().annotations.push({ type: 'gutter', description: `${w}x${h}: glass ${JSON.stringify(glass)}, gutter ${gutter}px, fit ${fit}` });
    expect(gutter, `gutter right of the glass ${JSON.stringify(glass)}`).toBeGreaterThanOrEqual(27);
    if (want) expect(fit).toBe(want);

    const tabClearOfGlass = async (view: string): Promise<void> => {
      await expect(limits(page), `${view}: dock`).toHaveAttribute('data-dock', 'tab');
      await expect(limits(page), `${view}: fit`).toHaveAttribute('data-fit', fit);
      await expect(page.locator('[data-key="limits-tab"]'), `${view}: tab`).toBeVisible();
      await expect(page.locator('.lm-tab-pct'), `${view}: worst %`).toBeVisible();
      await expect(page.locator('.lm-tab-bar'), `${view}: severity bar`).toBeVisible();
      // (it fades in from the edge: measure once it has settled)
      let tab!: Box;
      await expect.poll(async () => {
        tab = (await limits(page).boundingBox())!;
        return tab.x + tab.width <= w && apart(tab, glass);
      }, { message: `${view}: tab clear of glass ${JSON.stringify(glass)}` }).toBe(true);
      expect(tab.width, `${view}: hit target`).toBeGreaterThanOrEqual(20);
      const pct = (await page.locator('.lm-tab-pct').boundingBox())!;
      expect(pct.x, `${view}: % inside the tab`).toBeGreaterThanOrEqual(tab.x - 0.5);
      expect(pct.x + pct.width, `${view}: % inside the tab`).toBeLessThanOrEqual(tab.x + tab.width + 0.5);
    };

    const peeks = async (view: string): Promise<void> => {
      await page.locator('[data-key="limits-tab"]').click();
      await expect(limits(page), `${view}: peek`).toHaveAttribute('data-peek', 'true');
      await expect(page.locator('.lm-panel')).toBeVisible();
      expect(await savedOpen(page)).toBeNull();
      // The peeked plate is not a trap: its header hands back to the tab.
      await page.locator('.lm-strip').click();
      await expect(limits(page), `${view}: peek ended`).toHaveAttribute('data-peek', 'false');
      await expect(limits(page)).toHaveAttribute('data-fit', fit);
      expect(await savedOpen(page)).toBeNull();
      await tabClearOfGlass(view);
    };

    await tabClearOfGlass('terminal');
    await peeks('terminal');

    // The conversation is laid over the same glass.
    await page.keyboard.press('Control+Escape');
    await expect.poll(() => page.evaluate(() => window.__h3d.transcript()?.mode)).toBe('transcript');
    await frames(page, 10);
    expect(await page.evaluate(() => window.__h3d.transcript()!.box)).toMatchObject({ left: glass.x, top: glass.y, width: glass.width, height: glass.height });
    await tabClearOfGlass('conversation');
    await peeks('conversation');

    // Shift+L peeks from the conversation too, and a click outside ends it; standing up gives the plate back.
    await page.keyboard.press('Shift+L');
    await expect(limits(page)).toHaveAttribute('data-peek', 'true');
    await expect(page.locator('.lm-panel')).toBeVisible();
    expect(await savedOpen(page)).toBeNull();
    await standUp(page);
    await expect(limits(page)).toHaveAttribute('data-dock', '');
    await expect(limits(page)).toHaveAttribute('data-fit', '');
    await expect(limits(page)).toHaveAttribute('data-peek', 'false');
    await expect(page.locator('.lm-strip')).toBeVisible();
    clean();
  });
}

for (const expanded of [false, true]) {
  test(`sitting at a laptop ${expanded ? 'with the panel expanded' : 'with the strip'}: the widget is the edge tab, and standing up gives it back as saved`, async ({ page }) => {
    test.setTimeout(120_000);
    const clean = watchErrors(page);
    if (expanded) await page.addInitScript(() => localStorage.setItem('h3d.limits.open', '1'));
    await openGame(page, 'demo-m5', '', `${SIM()}&simusage=0`);
    await withReadings(page);
    await expect(page.locator('.lm-panel')).toBeVisible({ visible: expanded });

    await sitAtLaptop(page);
    await expect(limits(page)).toHaveAttribute('data-dock', 'tab');
    await expect(limits(page)).toBeVisible();
    await expect(page.locator('.lm-panel')).toBeHidden();
    await expect(page.locator('.lm-strip')).toBeHidden();
    await expect(page.locator('.lm-tab-pct')).toHaveText('61%');
    expect((await widget(page))!.open).toBe(false);
    // The tab is a sliver in the corner, not the plate.
    expect((await limits(page).boundingBox())!.width).toBeLessThan(48);
    expect(await savedOpen(page)).toBe(expanded ? '1' : null);
    await shot(page, `m10-seated-${expanded ? 'expanded' : 'strip'}`);

    await standUp(page);
    await expect(limits(page)).toHaveAttribute('data-dock', '');
    await expect(page.locator('.lm-panel')).toBeVisible({ visible: expanded });
    await expect(page.locator('.lm-strip')).toBeVisible();
    expect((await widget(page))!.open).toBe(expanded);
    expect(await savedOpen(page)).toBe(expanded ? '1' : null);
    clean();
  });
}

test('seated, a click on the tab or Shift+L peeks the panel without touching the saved state, and standing up ends the peek', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const keys = () => page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.keys'));
  await openGame(page, 'demo-m5', '', `${SIM()}&simusage=0`);
  await withReadings(page);
  await sitAtLaptop(page);

  // At the terminal Shift+L is an L for the pane, as in any text box: no peek.
  await page.keyboard.press('Shift+L');
  await expect.poll(async () => JSON.stringify(await keys())).toContain('"text":"L"');
  await expect(limits(page)).toHaveAttribute('data-peek', 'false');

  await page.locator('[data-key="limits-tab"]').click();
  await expect(limits(page)).toHaveAttribute('data-peek', 'true');
  await expect(page.locator('.lm-panel')).toBeVisible();
  expect((await widget(page))!.open).toBe(true);
  expect(await onTop(page)).toBe(true);
  expect(await savedOpen(page)).toBeNull();
  await shot(page, 'm10-seated-peek');

  // Shift+L (focus is on the plate now) ends it and brings it back; so does the header and a click outside.
  await page.keyboard.press('Shift+L');
  await expect(limits(page)).toHaveAttribute('data-peek', 'false');
  await expect(limits(page)).toHaveAttribute('data-dock', 'tab');
  await page.keyboard.press('Shift+L');
  await expect(limits(page)).toHaveAttribute('data-peek', 'true');
  await page.locator('.lm-strip').click();
  await expect(limits(page)).toHaveAttribute('data-peek', 'false');
  await page.locator('[data-key="limits-tab"]').click();
  await expect(page.locator('.lm-panel')).toBeVisible();
  await page.mouse.click(300, 400);
  await expect(limits(page)).toHaveAttribute('data-peek', 'false');
  expect(await savedOpen(page)).toBeNull();

  // Standing up with a peek open ends it; the plate is the docked strip again.
  await page.locator('[data-key="limits-tab"]').click();
  await expect(limits(page)).toHaveAttribute('data-peek', 'true');
  await standUp(page);
  await expect(limits(page)).toHaveAttribute('data-peek', 'false');
  await expect(limits(page)).toHaveAttribute('data-dock', '');
  await expect(page.locator('.lm-panel')).toBeHidden();
  await expect(page.locator('.lm-strip')).toBeVisible();
  expect(await savedOpen(page)).toBeNull();
  clean();
});

test('seated, a meter the user hid stays hidden', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await page.addInitScript(() => localStorage.setItem('h3d.limits.hidden', '1'));
  await openGame(page, 'demo-m5', '', `${SIM()}&simusage=0`);
  await expect.poll(async () => (await widget(page))?.hidden).toBe(true);
  await sitAtLaptop(page);
  await expect(limits(page)).toBeHidden();
  await standUp(page);
  await expect(limits(page)).toBeHidden();
  expect(await savedHidden(page)).toBe('1');
  clean();
});

test('seated on a narrow viewport the glass leaves no gutter: the widget is away, and still peeks from the conversation', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 420, height: 800 });
  await openGame(page, 'demo-m5', '', `${SIM()}&simusage=0`);
  await withReadings(page);
  await sitAtLaptop(page);
  await expect(limits(page)).toHaveAttribute('data-dock', 'away');
  await expect(limits(page)).toBeHidden();
  await page.keyboard.press('Control+Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.transcript()?.mode)).toBe('transcript');
  await frames(page, 10);
  await page.keyboard.press('Shift+L');
  await expect(limits(page)).toHaveAttribute('data-peek', 'true');
  await expect(page.locator('.lm-panel')).toBeVisible();
  // (it fades in from the edge: wait for it to settle)
  await expect.poll(async () => {
    const box = (await limits(page).boundingBox())!;
    return box.x >= 0 && box.x + box.width <= 420;
  }).toBe(true);
  await standUp(page);
  await expect(limits(page)).toHaveAttribute('data-dock', '');
  await expect(page.locator('.lm-strip')).toBeVisible();
  clean();
});
