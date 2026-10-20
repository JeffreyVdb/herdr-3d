import { expect, type Locator, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pixelStats } from './pixels';

export const RESULTS = resolve(import.meta.dirname, '../test-results');
/** M17: the pinned time every spec opens at unless it asks for another (`&time=` in `extra`): full daylight, as before the time of day, on a fixed date. */
export const NOON = '2026-09-30T12:00';

/** Collects page errors; call `expectClean()` at the end of a test. */
export function watchErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.log(`page error: ${e.message}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (m.type() === 'warning' && !m.text().includes('GL Driver Message')) console.log(`page warning: ${m.text()}`);
  });
  return () => expect(errors).toEqual([]);
}

/**
 * Opens the built game on the WebGL2 backend against a recorded fixture, waits
 * for the first world frame. `wsQuery` goes to the fixture server (e.g.
 * `sim=1` to simulate commands).
 */
export async function openGame(page: Page, fixture = 'demo', extra = '', wsQuery = 'play=none'): Promise<void> {
  const ws = encodeURIComponent(`/fixture/${fixture}?${wsQuery}`);
  // M17: never the wall clock's light: noon unless the test pins its own time.
  const time = /[?&]time=/.test(extra) ? '' : `&time=${NOON}`;
  await page.goto(`/?backend=webgl2&ws=${ws}${time}${extra}`);
  await page.waitForFunction(() => window.__h3d?.error || (window.__h3d?.ready && window.__h3d.frames >= 3), undefined, {
    timeout: 60_000,
  });
  expect(await page.evaluate(() => window.__h3d.error)).toBeNull();
  expect(await page.evaluate(() => window.__h3d.backend)).toBe('webgl2');
}

/** Waits for `n` more rendered frames. */
export async function frames(page: Page, n = 3): Promise<void> {
  const start = await page.evaluate(() => window.__h3d.frames);
  await page.waitForFunction((want) => window.__h3d.frames >= want, start + n, { timeout: 30_000 });
}

/**
 * #43: the bridge sends world events before its acknowledgement. Parallel pages can spend several
 * seconds applying and rendering those events before dispatching the ack. The fixture uses a 150 ms Node timer.
 * Allow 20 s for this end-to-end state change; keep ordinary UI assertions at their own bound.
 */
export async function expectCommandDone(page: Page, command: 'worker.hire' | 'worker.fire' | 'run.start'): Promise<void> {
  await expect.poll(() => page.evaluate((t) => ({
    result: window.__h3d.sent().filter((c) => c.t === t).at(-1)?.result,
    dialog: window.__h3d.dialog(),
  }), command), { message: `${command} is acknowledged and its dialog closes`, timeout: 20_000 }).toMatchObject({
    result: { ok: true },
    dialog: null,
  });
}

/**
 * Saves a full screenshot to test-results/<name>.png and checks the canvas
 * alone (HUD and debug overlay hidden) is not blank.
 */
export async function shot(page: Page, name: string): Promise<string> {
  const path = resolve(RESULTS, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, await page.screenshot());
  const bare = await page.screenshot({ style: '.hud, #debug { visibility: hidden !important; }' });
  const stats = pixelStats(PNG.sync.read(bare).data);
  console.log(`shot: ${path} ${JSON.stringify(stats)}`);
  expect(stats.variance, `${name} looks blank`).toBeGreaterThan(100);
  expect(stats.distinctColors, `${name} looks flat`).toBeGreaterThan(50);
  return path;
}

/**
 * #98: sitting down at a Claude or Codex worker opens its conversation. A test of the terminal sits down as someone
 * who left that worker in the terminal last time (the game remembers it per worker): call this before `sitAt`. With
 * the page's storage blocked nothing is remembered (`seatMode` then).
 */
export async function leftInTerminal(page: Page, ...ids: string[]): Promise<void> {
  await page.evaluate((list) => {
    try {
      localStorage.setItem('h3d.seat.terminal', JSON.stringify(list));
    } catch {
      /* blocked: the conversation opens */
    }
  }, ids);
}

/** Seated: switches with Ctrl+Esc and waits for the requested view, including the conversation's lazy renderer. */
export async function seatMode(page: Page, mode: 'terminal' | 'transcript'): Promise<void> {
  if ((await page.evaluate(() => window.__h3d.seat().mode)) !== mode) await page.keyboard.press('Control+Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().mode)).toBe(mode);
  if (mode === 'transcript') {
    await expect.poll(() => page.evaluate(() => {
      const transcript = window.__h3d.transcript();
      if (transcript?.mounted) return true;
      return JSON.stringify({
        transcript, seat: window.__h3d.seat(), error: window.__h3d.error,
        sent: window.__h3d.sent().slice(-10).map(({ t, result }) => ({ t, result })),
      });
    }), {
      message: 'the conversation renderer is mounted', timeout: 20_000,
    }).toBe(true);
    await expect(page.locator('.seat-transcript .txl:visible'), 'the conversation has its first rows or empty state').toHaveCount(0, { timeout: 20_000 });
  }
}

/** A schedule's hire preparation completed; the form exposes its resolved choices. */
export async function expectScheduleReady(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const form = window.__h3d.scheduleForm();
    if (form?.open === true && form.preparing === false) return true;
    return JSON.stringify({
      form: form ? { open: form.open, mode: form.mode, floor: form.floor, preparing: form.preparing } : null,
      prepare: window.__h3d.sent().filter(({ t }) => t === 'hire.prepare').at(-1)?.result,
    });
  }), { message: 'the schedule form finished preparing', timeout: 20_000 }).toBe(true);
}

/**
 * The top bar keeps only state; its commands are rows of the Menu button's popover. Opens it (when it is not open) so a
 * row can be clicked: the menu closes itself when a row does something.
 */
export async function openMenu(page: Page): Promise<void> {
  const menu = page.locator('.topbar-menu');
  if (await menu.evaluate((e) => e.matches(':popover-open'))) return;
  await page.locator('.btn--menu').click();
  await expect(menu).toBeVisible();
}

/**
 * #49: Settings shows one section at a time. Shows section `id` (its `data-section`) the way the window offers it: its
 * tab down the side, or the Section picker on a narrow screen. Settings must be open; returns the section's panel.
 */
export async function settingsSection(page: Page, id: string) {
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  const tab = dialog.locator(`[role="tab"][data-tab="${id}"]`);
  if (await tab.isVisible()) await tab.click();
  else await dialog.getByLabel('Section', { exact: true }).selectOption(id);
  const panel = dialog.locator(`.settings-section[data-section="${id}"]`);
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * #127: the in-dialog question (Hire's, the schedule form's) at a phone's width and a desktop's: its text and both
 * answers inside the dialog, which clips (nothing scrolls sideways); at a desktop's, the answers on one row. Each size
 * leaves `<name>-<width>.png` in test-results; the viewport is put back after.
 */
export async function askFits(page: Page, dialog: Locator, ask: Locator, name: string): Promise<void> {
  const was = page.viewportSize();
  for (const [width, height] of [[390, 844], [360, 740], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    await frames(page, 2);
    await expect(ask).toBeVisible();
    const path = resolve(RESULTS, `${name}-${width}.png`);
    mkdirSync(dirname(path), { recursive: true });
    await page.screenshot({ path });
    const dlg = (await dialog.boundingBox())!;
    const buttons = await ask.getByRole('button').all();
    expect(buttons).toHaveLength(2);
    for (const part of [ask, ask.locator('p'), ...buttons]) {
      const b = (await part.boundingBox())!;
      const what = `${name} at ${width}px: ${await part.evaluate((e) => e.textContent?.slice(0, 30))}`;
      expect(b.x, what).toBeGreaterThanOrEqual(dlg.x);
      expect(b.x + b.width, what).toBeLessThanOrEqual(dlg.x + dlg.width);
    }
    if (width > 560) {
      const [a, b] = await Promise.all(buttons.map(async (x) => (await x.boundingBox())!.y));
      expect(a, `${name} at ${width}px: the answers on one row`).toBe(b);
    }
  }
  if (was) await page.setViewportSize(was);
  await frames(page, 2);
}
