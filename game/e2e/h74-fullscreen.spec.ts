import { expect, test, type Page } from '@playwright/test';
import { frames, leftInTerminal, openGame, shot, watchErrors } from './game';

// #74: a laptop at a split herdr pane shows it at its own (narrow) size. Sitting down asks the bridge to zoom the
// pane's tab (`terminal.watch` with `fullscreen: true`), and the seat bar's chip states the pane's state and switches
// it (`terminal.zoom`). The fixture simulator plays the bridge's zoom with `simzoom=` (tools/fixture-screen.ts).

const FLOOR = 'herdr-3d';
const SIM = (zoom: string) => `play=none&sim=1&simms=500&simusage=0&simlimits=ok${zoom ? `&simzoom=${zoom}` : ''}`;

async function sitAt(page: Page, zoom: string, name = 'Tofu', init: Record<string, string> = {}): Promise<string> {
  if (Object.keys(init).length) await page.addInitScript((kv) => Object.entries(kv).forEach(([k, v]) => localStorage.setItem(k, v)), init);
  await openGame(page, 'demo-m5', '&prints=0', SIM(zoom));
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const id = await page.evaluate((n) => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === n)?.id ?? '', name);
  // #98: these are the terminal's: sit down as someone who left it in the terminal (else its conversation opens).
  await leftInTerminal(page, id);
  expect(await page.evaluate((i) => window.__h3d.face(i), id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
  await expect.poll(() => page.evaluate(() => (window.__h3d.screenText(window.__h3d.seated() ?? '') ?? []).join('').trim().length)).toBeGreaterThan(0);
  if (zoom === 'split') {
    // Screen text may arrive from the ambient watch before the seated watch applies its fullscreen preference.
    await expect.poll(() => fs(page), { message: 'the seated terminal watch applied its fullscreen preference' }).toMatchObject({
      pressed: init['h3d.term.fullscreen'] !== '0', unavailable: false,
    });
  } else await frames(page, 5);
  return id;
}

const chip = (page: Page) => page.locator('.seat .seat-fs');
const fs = (page: Page) => page.evaluate(() => window.__h3d.seat().fullscreen ?? null);
const log = (page: Page, t: string) => page.evaluate((tt) => window.__h3d.watchLog().filter((c) => c.t === tt), t);
const stored = (page: Page) => page.evaluate(() => localStorage.getItem('h3d.term.fullscreen'));

test('sitting at a split pane zooms it: only the seated watch asks, and the chip says Fullscreen', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const id = await sitAt(page, 'split');
  await expect.poll(() => fs(page)).toEqual({ label: 'Fullscreen', pressed: true, unavailable: false });
  await expect(chip(page)).toHaveAttribute('aria-pressed', 'true');
  const watches = await log(page, 'terminal.watch');
  // The ambient watches of the floor's other laptops show their panes as they are.
  expect(watches.filter((w) => (w.args as { fullscreen?: boolean }).fullscreen === true).map((w) => (w.args as { id: string }).id)).toEqual([id]);
  expect(watches.filter((w) => (w.args as { id: string }).id !== id).every((w) => !('fullscreen' in (w.args as object)))).toBe(true);
  await shot(page, 'h74-fullscreen-on');
  clean();
});

test('the chip is a toggle: Split pane fact when off, terminal.zoom both ways, remembered', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const id = await sitAt(page, 'split');
  await chip(page).click();
  await expect.poll(() => fs(page)).toEqual({ label: 'Split pane 120×36', pressed: false, unavailable: false });
  await expect(chip(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(chip(page)).toHaveAttribute('aria-label', 'Fullscreen, off. Split pane 120 by 36');
  expect(await log(page, 'terminal.zoom')).toMatchObject([{ args: { id, on: false } }]);
  expect(await stored(page)).toBe('0');
  const watched = (await log(page, 'terminal.watch')).length;
  // The click did not restart the watch (the toggle is a terminal.zoom, the watch keeps its place) and the keyboard is back on the pane.
  expect(await page.evaluate(() => document.activeElement?.className)).toContain('seat-input');
  await shot(page, 'h74-fullscreen-split');
  await chip(page).click();
  await expect.poll(() => fs(page)).toMatchObject({ label: 'Fullscreen', pressed: true });
  expect(await log(page, 'terminal.zoom')).toMatchObject([{ args: { id, on: false } }, { args: { id, on: true } }]);
  expect(await stored(page)).toBeNull();
  expect(await log(page, 'terminal.watch')).toHaveLength(watched);
  clean();
});

test('with the preference off the seated watch asks for no zoom, and the chip offers it', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const id = await sitAt(page, 'split', 'Tofu', { 'h3d.term.fullscreen': '0' });
  await expect.poll(() => fs(page)).toMatchObject({ label: 'Split pane 120×36', pressed: false });
  expect((await log(page, 'terminal.watch')).some((w) => (w.args as { fullscreen?: boolean }).fullscreen === true)).toBe(false);
  // The seated watch says "no" in so many words (the bridge then follows the pane for the chip); the ambient ones say nothing.
  const watches = await log(page, 'terminal.watch');
  expect(watches.filter((w) => (w.args as { fullscreen?: boolean }).fullscreen === false).map((w) => (w.args as { id: string }).id)).toEqual([id]);
  expect(watches.filter((w) => (w.args as { id: string }).id !== id).every((w) => !('fullscreen' in (w.args as object)))).toBe(true);
  await chip(page).click();
  await expect.poll(() => fs(page)).toMatchObject({ label: 'Fullscreen', pressed: true });
  expect(await log(page, 'terminal.zoom')).toMatchObject([{ args: { id, on: true } }]);
  clean();
});

test('the human unzooming the tab reaches the chip (terminal.state), and it can be asked for again', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const id = await sitAt(page, 'split');
  await expect.poll(() => fs(page)).toMatchObject({ pressed: true });
  expect(await page.evaluate((i) => window.__h3d.simUnzoom(i), id)).toBe(true);
  await expect.poll(() => fs(page)).toEqual({ label: 'Split pane 120×36', pressed: false, unavailable: false });
  // Nobody re-applied it: the game did not ask again by itself.
  expect(await log(page, 'terminal.zoom')).toEqual([]);
  await chip(page).click();
  await expect.poll(() => fs(page)).toMatchObject({ pressed: true });
  clean();
});

test('a zoom that cannot widen the pane (no herdr screen attached) says so and does nothing', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await sitAt(page, 'headless');
  await expect.poll(() => fs(page)).toEqual({ label: 'Fullscreen unavailable', pressed: false, unavailable: true });
  await expect(chip(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(chip(page)).toHaveAttribute('title', /no herdr screen/);
  // aria-disabled: Playwright waits for such a control to be enabled; the click is meant to find it inert.
  await chip(page).click({ force: true });
  await frames(page, 3);
  expect(await log(page, 'terminal.zoom')).toEqual([]);
  expect(await fs(page)).toMatchObject({ unavailable: true });
  await shot(page, 'h74-fullscreen-unavailable');
  clean();
});

test('a single-pane tab, a bridge before the zoom and one that refuses the argument show no chip and no error', async ({ page }) => {
  test.setTimeout(150_000);
  for (const zoom of ['single', '', 'old']) {
    const clean = watchErrors(page);
    const id = await sitAt(page, zoom);
    expect(await fs(page), zoom).toBeNull();
    await expect(chip(page)).toBeHidden();
    if (zoom === 'old') {
      // Asked with the argument, refused, asked again without it, and never again with it.
      const mine = (await log(page, 'terminal.watch')).filter((w) => (w.args as { id: string }).id === id).map((w) => 'fullscreen' in (w.args as object));
      expect(mine.slice(-2)).toEqual([true, false]);
    }
    expect(await page.evaluate(() => window.__h3d.seat().state)).toBe('ok');
    clean();
    await page.reload();
  }
});

test('the chip is reached with Ctrl+, and Tab like the other controls, Enter presses it, Esc goes back', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const id = await sitAt(page, 'split');
  const focused = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? '');
  await page.keyboard.press('Control+,');
  expect(await focused()).toContain('seat-theme');
  // Swatch group, then A− / level / A+ (three stops), then the chip.
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
  expect(await focused()).toContain('seat-fs');
  await page.keyboard.press('Enter');
  await expect.poll(() => fs(page)).toMatchObject({ pressed: false });
  expect(await log(page, 'terminal.zoom')).toMatchObject([{ args: { id, on: false } }]);
  // Pressing it hands the keyboard back to the pane; from the chip, Esc does too.
  expect(await focused()).toContain('seat-input');
  await chip(page).focus();
  await page.keyboard.press('Escape');
  expect(await focused()).toContain('seat-input');
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(id);
  clean();
});

test('the chip does not make the seat bar taller at 1280, and a narrow window keeps it inside the window', async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  const height = () => page.evaluate(() => document.querySelector('.seat')!.getBoundingClientRect().height);
  for (const width of [1280, 700]) {
    await page.setViewportSize({ width, height: 720 });
    await sitAt(page, 'single');
    const without = await height();
    await shot(page, `h74-bar-nochip-${width}`);
    await page.reload();
    await sitAt(page, 'split');
    await expect(chip(page)).toBeVisible();
    // At a narrow window the keys row wrapped before the chip, too: only the wide bar is held to its height.
    if (width >= 1280) expect(await height(), `${width}px`).toBeCloseTo(without, 0);
    const inside = await page.evaluate(() => {
      const c = document.querySelector('.seat .seat-fs')!.getBoundingClientRect();
      return c.left >= 0 && c.right <= document.documentElement.clientWidth;
    });
    expect(inside, `${width}px`).toBe(true);
    await shot(page, `h74-bar-chip-${width}`);
    await page.reload();
  }
  clean();
});

// U1: at a phone's width the chip used to run past the bar and the window (the look group did not wrap or shrink), so
// the state and the switch were clipped. Every state, at a phone, a small phone and a wide window: the chip is inside
// the bar, the bar inside the window, and what is at the chip's centre is the chip (a tap lands on it).
for (const [state, zoom, init] of [
  ['zoomed', 'split', {}],
  ['split', 'split', { 'h3d.term.fullscreen': '0' }],
  ['unavailable', 'headless', {}],
] as const) {
  test(`the ${state} chip stays inside the seat bar and the window at 320, 390 and 1280 px`, async ({ page }) => {
    test.setTimeout(150_000);
    const clean = watchErrors(page);
    await sitAt(page, zoom, 'Tofu', init);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 720 });
      await frames(page, 3);
      await expect(chip(page)).toBeVisible();
      const m = await page.evaluate(() => {
        const r = (e: Element) => e.getBoundingClientRect();
        const seat = r(document.querySelector('.seat')!);
        const c = document.querySelector<HTMLElement>('.seat .seat-fs')!;
        const b = r(c);
        const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return { seat: [seat.left, seat.right], chip: [b.left, b.right, b.width], view: document.documentElement.clientWidth, hit: !!at && c.contains(at), text: c.textContent };
      });
      const why = `${state} at ${width}px: ${JSON.stringify(m)}`;
      expect(m.seat[0], why).toBeGreaterThanOrEqual(0);
      expect(m.seat[1], why).toBeLessThanOrEqual(m.view);
      expect(m.chip[0], why).toBeGreaterThanOrEqual(m.seat[0] as number);
      expect(m.chip[1], why).toBeLessThanOrEqual(m.seat[1] as number);
      expect(m.chip[2], why).toBeGreaterThan(40);
      expect(m.hit, why).toBe(true);
      await shot(page, `h74-chip-${state}-${width}`);
    }
    clean();
  });
}

test('the chip keeps AA contrast in every state at all three presets, and the bar stays one piece', async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  await sitAt(page, 'split');
  const ratio = () =>
    page.evaluate(() => {
      const lum = (c: number[]) => {
        const [r, g, b] = c.map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
      };
      const rgba = (css: string) => (css.match(/[\d.]+/g) ?? ['0', '0', '0', '1']).map(Number) as number[];
      const over = (top: number[], under: number[]) => {
        const a = top[3] ?? 1;
        return [0, 1, 2].map((i) => (top[i] as number) * a + (under[i] as number) * (1 - a));
      };
      const el = document.querySelector<HTMLElement>('.seat .seat-fs')!;
      const seat = rgba(getComputedStyle(document.querySelector('.seat')!).backgroundColor);
      const bg = over(rgba(getComputedStyle(el).backgroundColor), over(seat, [0, 0, 0]));
      const fg = rgba(getComputedStyle(el).color).slice(0, 3);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    });
  const checkStates = async (name: string) => {
    expect(await ratio(), `${name}: on`).toBeGreaterThanOrEqual(4.5);
    await chip(page).click();
    await expect.poll(() => fs(page)).toMatchObject({ pressed: false });
    expect(await ratio(), `${name}: split`).toBeGreaterThanOrEqual(4.5);
    await chip(page).click();
    await expect.poll(() => fs(page)).toMatchObject({ pressed: true });
  };
  for (const t of ['Ubuntu', 'Quiet']) {
    await page.locator(`.seat [role="radio"][aria-label="${t}"]`).click();
    await page.evaluate(() => window.__h3d.themeLoaded());
    await checkStates(t);
    const box = await page.evaluate(() => {
      const seat = document.querySelector('.seat')!.getBoundingClientRect();
      const c = document.querySelector('.seat .seat-fs')!.getBoundingClientRect();
      return { inside: c.left >= seat.left && c.right <= seat.right && c.top >= seat.top && c.bottom <= seat.bottom, h: seat.height };
    });
    expect(box.inside, t).toBe(true);
    if (t === 'Ubuntu') await shot(page, 'h74-fullscreen-ubuntu');
  }
  // The bar's height does not depend on the chip's state or wording.
  const heights: number[] = [];
  heights.push(await page.evaluate(() => document.querySelector('.seat')!.getBoundingClientRect().height));
  await chip(page).click();
  await expect.poll(() => fs(page)).toMatchObject({ pressed: false });
  heights.push(await page.evaluate(() => document.querySelector('.seat')!.getBoundingClientRect().height));
  expect(Math.abs((heights[0] as number) - (heights[1] as number))).toBeLessThan(1);
  clean();
});
