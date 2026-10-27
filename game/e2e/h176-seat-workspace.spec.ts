import { expect, test, type Page } from '@playwright/test';
import { frames, leftInTerminal, openGame, shot, watchErrors } from './game';

// #176: sitting opens the full-window seated workspace with a real xterm widget. The simulating server owns the seated
// pane like the bridge (tools/fixture-screen.ts: `control`, `terminal.resize`, `terminal.scroll`, `sim.write`,
// `simcontrol=busy` for the read-only fallback).

const FLOOR = 'herdr-3d';
const SIM = (extra = '') => `play=none&sim=1&simms=500&simusage=0&simlimits=ok${extra}`;

async function sitAt(page: Page, name = 'Tofu', sim = ''): Promise<string> {
  await page.addInitScript(() => localStorage.setItem('h3d.monitors', 'terminal'));
  await openGame(page, 'demo-m5', '&prints=0&open=none', SIM(sim));
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const id = await page.evaluate((n) => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === n)?.id ?? '', name);
  await leftInTerminal(page, id);
  expect(await page.evaluate((i) => window.__h3d.face(i), id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
  await expect.poll(() => page.evaluate(() => window.__h3d.seatTerminal()?.opened ?? false)).toBe(true);
  return id;
}

const term = (page: Page) => page.evaluate(() => window.__h3d.seatTerminal());
const sent = (page: Page, t: string) => page.evaluate((c) => window.__h3d.watchLog().filter((e) => e.t === c), t);
const simTerm = async (page: Page, id: string) =>
  (await page.evaluate((i) => window.__h3d.simTerm('sim.terminal', { id: i }), id)).data as { watched: boolean; control: { mode: string; cols: number; rows: number; offset: number; resizes: Array<[number, number]>; scrolls: string[] } | null };

/** Where on the page cell (col, row) of the seated terminal is (its screen's top left plus whole cells). */
async function cellAt(page: Page, col: number, row: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([c, r]) => {
      const screen = document.querySelector('.seat-term .xterm-screen') as HTMLElement;
      const rect = screen.getBoundingClientRect();
      const t = window.__h3d.seatTerminal();
      const w = rect.width / (t?.cols ?? 80);
      const h = rect.height / (t?.rows ?? 24);
      return { x: rect.left + (c + 0.5) * w, y: rect.top + (r + 0.5) * h };
    },
    [col, row] as const,
  );
}

test('sitting opens the full-window workspace; the PTY gets the fitted grid and the font stays; standing up restores the game', { tag: '@smoke' }, async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const before = await page.evaluate(() => document.activeElement?.tagName ?? null);
  const id = await sitAt(page);
  // The workspace covers the window; its content area is most of it.
  const box = await page.locator('.seat-content').boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width / 1280).toBeGreaterThan(0.85);
  expect(box!.height / 800).toBeGreaterThan(0.75);
  await expect(page.locator('.seat')).toBeVisible();
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  // The game behind it is inert; the seat's keyboard has the focus.
  expect(await page.evaluate(() => (document.querySelector('canvas') as HTMLElement).inert)).toBe(true);
  await expect(page.locator('.seat-input')).toBeFocused();
  // The seat owns the pane at the grid its terminal fits.
  await expect.poll(async () => (await term(page))?.control?.mode).toBe('control');
  const t0 = (await term(page))!;
  const watch = (await sent(page, 'terminal.watch')).filter((e) => (e.args as { id: string }).id === id).at(-1)!.args as { control?: boolean; cols?: number; rows?: number; fullscreen?: boolean };
  expect(watch).toMatchObject({ control: true, cols: t0.grid!.cols, rows: t0.grid!.rows, fullscreen: false });
  expect(t0.grid!.cols).toBeGreaterThan(100);
  expect(t0.grid!.rows).toBeGreaterThan(30);
  await expect.poll(async () => (await term(page))?.cols).toBe(t0.grid!.cols);
  await expect.poll(async () => (await simTerm(page, id)).control?.cols).toBe(t0.grid!.cols);
  // The status and the view switch are there; no zoom chip while the seat owns the pane.
  await expect(page.locator('.seat-status')).toBeVisible();
  await expect(page.locator('.seat-rail').getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true'); // #216: the rail
  expect(await page.evaluate(() => window.__h3d.seat().fullscreen)).toBeNull();
  await shot(page, 'h176-seated-1280');

  // A narrower window: fewer columns at the same font size, sent to the PTY once.
  const px = t0.font!.px;
  await page.setViewportSize({ width: 900, height: 700 });
  await expect.poll(async () => (await simTerm(page, id)).control?.cols).toBeLessThan(t0.grid!.cols);
  const t1 = (await term(page))!;
  expect(t1.font!.px).toBe(px);
  expect(t1.grid!.cols).toBeLessThan(t0.grid!.cols);
  await expect.poll(async () => (await term(page))?.cols).toBe(t1.grid!.cols);
  const resizes = (await sent(page, 'terminal.resize')).map((e) => e.args as { cols: number; rows: number });
  expect(resizes.at(-1)).toMatchObject({ cols: t1.grid!.cols, rows: t1.grid!.rows });
  await shot(page, 'h176-seated-900');
  // The text size control changes the font (and the grid with it).
  await page.getByRole('button', { name: 'Larger terminal text' }).click();
  await expect.poll(async () => (await term(page))?.font?.px).toBeGreaterThan(px);
  await expect.poll(async () => (await term(page))?.grid?.cols).toBeLessThan(t1.grid!.cols);
  await page.locator('.seat-zoom-level').click();
  await expect.poll(async () => (await term(page))?.font?.px).toBe(px);

  // Stand up: the game is live again, the focus goes back, the controller goes (the watch observes again).
  await page.locator('.seat').getByRole('button', { name: /Stand up/ }).click();
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  await expect(page.locator('.seat')).toBeHidden();
  expect(await page.evaluate(() => (document.querySelector('canvas') as HTMLElement).inert)).toBe(false);
  expect(await page.evaluate(() => document.activeElement?.tagName ?? null)).toBe(before);
  await expect.poll(async () => (await simTerm(page, id)).control).toBeNull();
  clean();
});

test('links open through the app’s opener on Ctrl+click: plain, soft-wrapped and OSC 8; http does not', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const id = await sitAt(page);
  await expect.poll(async () => (await term(page))?.control?.mode).toBe('control');
  const cols = (await term(page))!.cols;
  const long = `https://example.com/${'a'.repeat(cols)}/end`;
  await page.evaluate(
    ([i, l]) =>
      window.__h3d.simTerm('sim.write', {
        id: i,
        data: `\x1b[2J\x1b[1;1Hplain https://example.com/plain here\r\n\x1b]8;;https://example.com/named\x1b\\named link\x1b]8;;\x1b\\\r\nhttp http://example.com/insecure\r\n${l}\r\n`,
      }),
    [id, long] as const,
  );
  await expect.poll(async () => (await term(page))?.lines[0]).toContain('https://example.com/plain');
  const opened = () => page.evaluate(() => window.__h3d.opened().map((o) => o.url));
  const ctrlClick = async (col: number, row: number) => {
    const p = await cellAt(page, col, row);
    await page.mouse.move(p.x, p.y);
    await frames(page, 2);
    await page.keyboard.down('Control');
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up('Control');
  };
  // A plain click selects; it opens nothing.
  const p0 = await cellAt(page, 10, 0);
  await page.mouse.click(p0.x, p0.y);
  await ctrlClick(10, 0);
  await expect.poll(opened).toEqual(['https://example.com/plain']);
  await ctrlClick(2, 1);
  await expect.poll(opened).toEqual(['https://example.com/plain', 'https://example.com/named']);
  await ctrlClick(8, 2);
  // The soft-wrapped one, clicked on its second row.
  await ctrlClick(3, 4);
  await expect.poll(opened).toEqual(['https://example.com/plain', 'https://example.com/named', long]);
  expect(await page.evaluate(() => window.__h3d.opened().every((o) => o.url.startsWith('https://')))).toBe(true);
  // The keyboard stays the seat's.
  await expect(page.locator('.seat-input')).toBeFocused();
  clean();
});

test('the wheel scrolls herdr’s history; the indicator goes back to live; typing does too', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const id = await sitAt(page);
  await expect.poll(async () => (await term(page))?.control?.mode).toBe('control');
  const mid = await cellAt(page, 20, 10);
  await page.mouse.move(mid.x, mid.y);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120);
  await expect.poll(async () => (await simTerm(page, id)).control?.offset ?? 0).toBeGreaterThan(0);
  const indicator = page.locator('.seat-history');
  await expect(indicator).toBeVisible();
  await expect(indicator).toContainText(/\d+ lines? up/);
  const scrolls = (await sent(page, 'terminal.scroll')).map((e) => e.args as { direction?: string; lines?: number });
  expect(scrolls.every((s) => s.direction === 'up' && (s.lines ?? 0) > 0)).toBe(true);
  await shot(page, 'h176-history');
  await indicator.click();
  await expect(indicator).toBeHidden();
  await expect.poll(async () => (await simTerm(page, id)).control?.offset).toBe(0);
  await expect(page.locator('.seat-input')).toBeFocused();
  // Up again, then a key: back to live.
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.wheel(0, -240);
  await expect(indicator).toBeVisible();
  await page.locator('.seat-input').focus();
  await page.keyboard.press('ArrowRight');
  await expect(indicator).toBeHidden();
  // Ctrl+wheel stays the text size, not the history.
  const n = (await sent(page, 'terminal.scroll')).length;
  await page.mouse.move(mid.x, mid.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await expect(page.locator('.seat-zoom-level')).toHaveText('120%'); // 60 px a step
  expect((await sent(page, 'terminal.scroll')).length).toBe(n);
  clean();
});

test('a drag selects and Ctrl+Shift+C copies; Ctrl+C still goes to the pane', async ({ page, context }) => {
  test.setTimeout(150_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const id = await sitAt(page);
  await expect.poll(async () => (await term(page))?.control?.mode).toBe('control');
  await page.evaluate((i) => window.__h3d.simTerm('sim.write', { id: i, data: '\x1b[2J\x1b[1;1Hcopy me please\r\n' }), id);
  await expect.poll(async () => (await term(page))?.lines[0]).toBe('copy me please');
  const a = await cellAt(page, 0, 0);
  const b = await cellAt(page, 6, 0);
  await page.mouse.move(a.x - 2, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x + 2, b.y, { steps: 6 });
  await page.mouse.up();
  await page.locator('.seat-input').focus();
  await page.keyboard.press('Control+Shift+C');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('copy me');
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().note)).toMatch(/^Copied/);
  const keys = (await page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.keys').length));
  await page.keyboard.press('Control+C');
  await expect.poll(() => page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.keys').map((c) => JSON.stringify(c.args)))).toContainEqual(expect.stringContaining('ctrl+c'));
  expect(await page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.keys').length)).toBeGreaterThan(keys);
  clean();
});

test('another client owns the pane: read only, the pane at its own size, the herdr zoom chip; nothing resized', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const id = await sitAt(page, 'Tofu', '&simcontrol=busy&simzoom=split');
  await expect.poll(async () => (await term(page))?.control?.mode).toBe('observe');
  await expect(page.locator('.seat-readonly')).toContainText('Another client controls this terminal');
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().fullscreen?.label ?? null)).toMatch(/^Zoom herdr tab/);
  await expect.poll(async () => (await term(page))?.cols).toBe(120);
  await page.setViewportSize({ width: 900, height: 700 });
  await frames(page, 6);
  await page.waitForTimeout(400);
  expect(await sent(page, 'terminal.resize')).toEqual([]);
  expect((await simTerm(page, id)).control?.mode).toBe('observe');
  await shot(page, 'h176-readonly');
  // Typing still reaches the pane.
  await page.locator('.seat-input').focus();
  await page.keyboard.type('ls');
  await expect.poll(() => page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.keys').length)).toBeGreaterThan(0);
  clean();
});

test('a bridge before #176: the seat watches as before', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const id = await sitAt(page, 'Tofu', '&simcontrol=old');
  await expect.poll(async () => (await simTerm(page, id)).watched).toBe(true);
  expect((await simTerm(page, id)).control).toBeNull();
  await expect.poll(async () => (await term(page))?.lines.some((l) => l.trim().length > 0)).toBe(true);
  expect((await term(page))?.control).toBeNull();
  clean();
});

test('narrow windows: whose laptop it is gives way, never Stand up; its whole button takes the click (Quiet and Ubuntu)', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 560, height: 800 });
  await sitAt(page);
  await page.locator('.seat-rail').getByRole('tab', { name: 'Terminal' }).click(); // #216: the rail
  await expect(page.locator('.seat-status')).toBeVisible();
  // Stand up's centre is Stand up, it shares no pixel with the line's tapes, the line's parts stay inside the line and
  // the header inside the window.
  const layout = () =>
    page.evaluate(() => {
      const stand = document.querySelector('.seat-stand') as HTMLElement;
      const s = stand.getBoundingClientRect();
      const hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
      const line = (document.querySelector('.seat-line') as HTMLElement).getBoundingClientRect();
      const parts = [...document.querySelectorAll<HTMLElement>('.seat-line > *')].filter((e) => e.getClientRects().length > 0);
      const overlaps = parts.filter((e) => {
        const r = e.getBoundingClientRect();
        return r.right > s.left + 0.5 && r.left < s.right - 0.5 && r.bottom > s.top + 0.5 && r.top < s.bottom - 0.5;
      });
      const head = document.querySelector('.seat-head') as HTMLElement;
      return {
        hit: !!hit?.closest('.seat-stand'),
        overlaps: overlaps.map((e) => e.className),
        outside: parts.filter((e) => e.getBoundingClientRect().right > line.right + 1).map((e) => e.className),
        headFits: head.scrollWidth <= head.clientWidth + 1 && s.right <= window.innerWidth,
        // A phone's width keeps Stand up on the first row, beside the name; a wider one may wrap it.
        standRow1: window.innerWidth > 560 || (s.top < line.bottom && s.bottom > line.top),
      };
    });
  const ok = { hit: true, overlaps: [], outside: [], headFits: true, standRow1: true };
  for (const theme of ['quiet', 'ubuntu'] as const) {
    await page.evaluate((t) => window.__h3d.setUiTheme(t), theme);
    for (const width of [560, 390, 360, 700]) {
      await page.setViewportSize({ width, height: 800 });
      await frames(page, 3);
      expect({ theme, width, ...(await layout()) }).toEqual({ theme, width, ...ok });
      // A long name too.
      await page.evaluate(() => {
        const tape = document.querySelector('.seat-tape') as HTMLElement;
        tape.dataset.was = tape.textContent ?? '';
        tape.textContent = 'At Bartholomew-the-very-long-named-worker’s laptop';
      });
      await frames(page, 2);
      expect({ theme, width, long: true, ...(await layout()) }).toEqual({ theme, width, long: true, ...ok });
      await page.evaluate(() => {
        const tape = document.querySelector('.seat-tape') as HTMLElement;
        tape.textContent = tape.dataset.was ?? '';
      });
    }
  }
  await page.setViewportSize({ width: 560, height: 800 });
  await frames(page, 3);
  await shot(page, 'h176-narrow-560');
  // A real click on it stands you up.
  await page.locator('.seat-stand').click();
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  clean();
});

test('read only in a narrow window: the pane keeps its size and scrolls inside the content area (wheel, keys); its far links still open', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 560, height: 800 });
  const id = await sitAt(page, 'Tofu', '&simcontrol=busy&simzoom=split');
  await expect.poll(async () => (await term(page))?.control?.mode).toBe('observe');
  await expect.poll(async () => (await term(page))?.cols).toBe(120);
  const px = (await term(page))!.font!.px;
  await page.evaluate((i) => window.__h3d.simTerm('sim.write', { id: i, data: `\x1b[2J\x1b[1;1H${'x'.repeat(96)}https://example.com/far\r\n` }), id);
  await expect.poll(async () => (await term(page))?.lines[0]).toContain('https://example.com/far');
  const host = page.locator('.seat-term');
  const scroll = () => host.evaluate((e) => ({ left: e.scrollLeft, width: e.scrollWidth, client: e.clientWidth }));
  const s0 = await scroll();
  expect(s0.width).toBeGreaterThan(s0.client + 100);
  expect(s0.left).toBe(0);
  // A sideways wheel pans it (nothing goes to the bridge: the pane is not ours to scroll).
  const box = (await host.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 60);
  await page.mouse.wheel(200, 0);
  await expect.poll(async () => (await scroll()).left).toBeGreaterThan(0);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => host.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  expect(await sent(page, 'terminal.scroll')).toEqual([]);
  await host.evaluate((e) => e.scrollTo(0, 0));
  // The keyboard: tabbed to (a focusable region), the arrows scroll it; letters still go to the pane.
  await host.focus();
  await expect(host).toHaveAttribute('aria-label', /read only/);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await scroll()).left).toBeGreaterThan(0);
  await page.keyboard.press('End');
  await expect.poll(() => host.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  const keysBefore = await page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.keys').length);
  await page.keyboard.type('l');
  await expect.poll(() => page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.keys').length)).toBeGreaterThan(keysBefore);
  // Scrolled to the right end (and back to the top: End took it to the bottom), the last column is in the content area,
  // and the far link opens on Ctrl+click.
  await host.evaluate((e) => e.scrollTo(e.scrollWidth, 0));
  const last = await cellAt(page, 119, 0);
  const content = (await page.locator('.seat-content').boundingBox())!;
  expect(last.x).toBeLessThan(content.x + content.width);
  expect(last.x).toBeGreaterThan(content.x);
  const link = await cellAt(page, 100, 0);
  await page.mouse.move(link.x, link.y);
  await frames(page, 2);
  const at = (await scroll()).left;
  await page.keyboard.down('Control');
  await page.mouse.click(link.x, link.y);
  await page.keyboard.up('Control');
  await expect.poll(() => page.evaluate(() => window.__h3d.opened().map((o) => o.url))).toEqual(['https://example.com/far']);
  // The press kept the pane where it was scrolled, and the keyboard is the seat's again.
  expect((await scroll()).left).toBe(at);
  await expect(page.locator('.seat-input')).toBeFocused();
  // A click beside the cells (a wide window: the pane is narrower than the area) leaves the keyboard the seat's: Enter
  // still types.
  await page.setViewportSize({ width: 1600, height: 900 });
  await frames(page, 3);
  const beside = await page.evaluate(() => {
    const x = (document.querySelector('.seat-term .xterm') as HTMLElement).getBoundingClientRect();
    const h = (document.querySelector('.seat-term') as HTMLElement).getBoundingClientRect();
    return { x: (x.right + h.right) / 2, y: h.top + 80, room: h.right - x.right };
  });
  expect(beside.room).toBeGreaterThan(40);
  await page.mouse.click(beside.x, beside.y);
  await expect(page.locator('.seat-input')).toBeFocused();
  const enters = await page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.keys').length);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.keys').length)).toBeGreaterThan(enters);
  // The font never changed for it, and nothing was resized.
  expect((await term(page))!.font!.px).toBe(px);
  expect(await sent(page, 'terminal.resize')).toEqual([]);
  await shot(page, 'h176-readonly-560');
  clean();
});
