import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { frames, openGame, shot, watchErrors } from './game';

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
  await expect(panel.locator('.lm-sec[data-provider="claude"] .lm-row').first().locator('.lm-rs')).toHaveText(/^resets \d\d:\d\d$/);
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
  await frames(page, 6);
  await page.keyboard.up('KeyW');
  expect(await onTop(page)).toBe(true);
  await shot(page, 'm10-walk');
  // Plain L is still the elevator; the widget is not in its way.
  await page.evaluate(() => window.__h3d.openSettings('herdr-3d'));
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.panel()))?.kind).toBeTruthy();
  await expect(limits(page)).toBeVisible();
  expect(await undimmed(page)).toBe(true); // in the top layer above the modal's backdrop
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

test('it can be hidden from the panel, comes back in About and with Shift+L, and is absent from an older bridge', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM());
  await withReadings(page);
  await page.locator('.lm-strip').click();
  await page.locator('[data-key="limits-hide"]').click();
  await expect(limits(page)).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('h3d.limits.hidden'))).toBe('1');
  await expect(page.locator('.toast')).toHaveText('Plan limits hidden. Show them again in About.');
  // About has the switch.
  await page.locator('button[aria-label="About"]').click();
  const box = page.locator('#about-limits');
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
  expect(await undimmed(page)).toBe(true); // the corner widget is above the modal dialog's backdrop
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

test('the panel opens and closes when browser storage is unavailable', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await page.addInitScript(() => {
    const boom = () => {
      throw new Error('storage blocked');
    };
    for (const k of ['getItem', 'setItem', 'removeItem'] as const) Storage.prototype[k] = boom;
  });
  await openGame(page, 'demo-m4', '', SIM());
  await withReadings(page);
  await page.locator('.lm-strip').click();
  expect((await widget(page))!.open).toBe(true);
  await page.locator('.lm-strip').click();
  expect((await widget(page))!.open).toBe(false);
  await page.keyboard.press('Shift+L');
  expect((await widget(page))!.open).toBe(true);
  await page.locator('[data-key="limits-hide"]').click();
  await expect(limits(page)).toBeHidden();
  await page.keyboard.press('Shift+L'); // and back
  await expect(limits(page)).toBeVisible();
  clean();
});

// Narrow viewports: the open panel fits and keeps its buttons in reach, and it never sits over an open dialog.

const inViewport = (b: { x: number; y: number; width: number; height: number }, vp: { width: number; height: number }) => b.x >= 0 && b.y >= 0 && b.x + b.width <= vp.width + 0.5 && b.y + b.height <= vp.height + 0.5;

test('at 320x480 the open panel stays inside the viewport: its body scrolls, Refresh and Hide stay clickable', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const vp = { width: 320, height: 480 };
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
