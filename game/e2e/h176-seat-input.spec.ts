import { expect, test, type Page } from '@playwright/test';
import { frames, leftInTerminal, openGame, shot, watchErrors } from './game';

// #176 part 2: what the seat puts into the pane it owns through the controller, on the fixture server
// (tools/fixture-screen.ts: `worker.paste`, `terminal.mouse`, `sim.terminal`'s `pastes` and `clicks`; `simcontrol=nomouse`
// for herdr 0.9.1, `part1` for a bridge of #176 part 1), and the history scrollbar.

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

const mode = (page: Page) => page.evaluate(() => window.__h3d.seatTerminal()?.control?.mode ?? null);
const sentOf = (page: Page, t: string) => page.evaluate((c) => window.__h3d.sent().filter((e) => e.t === c), t);
type SimControl = { offset: number; max: number; pastes: string[]; clicks: string[]; scrolls: string[] };
const simTerm = async (page: Page, id: string) => ((await page.evaluate((i) => window.__h3d.simTerm('sim.terminal', { id: i }), id)).data as { control: SimControl | null }).control;

async function cellAt(page: Page, col: number, row: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([c, r]) => {
      const rect = (document.querySelector('.seat-term .xterm-screen') as HTMLElement).getBoundingClientRect();
      const t = window.__h3d.seatTerminal();
      return { x: rect.left + (c + 0.5) * (rect.width / (t?.cols ?? 80)), y: rect.top + (r + 0.5) * (rect.height / (t?.rows ?? 24)) };
    },
    [col, row] as const,
  );
}

test('a paste with Ctrl+V from a header button is inserted once, in order with the keys around it, never submitted', { tag: '@smoke' }, async ({ page, context }) => {
  test.setTimeout(150_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const id = await sitAt(page, 'Nibble'); // a Claude worker
  await expect.poll(() => mode(page)).toBe('control');
  const text = 'first line\nsecond line ✓ 日本\n\tindented';
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.locator('.seat-input').focus();
  await page.keyboard.type('a');
  // The focus on a header button: the paste is still the terminal's.
  await page.locator('.seat-mode').getByRole('button', { name: 'Terminal' }).focus();
  await page.keyboard.press('Control+V');
  await page.locator('.seat-input').focus();
  await page.keyboard.type('b');
  await expect.poll(async () => (await simTerm(page, id))?.pastes).toEqual([text]);
  await expect.poll(async () => (await sentOf(page, 'worker.keys')).length).toBeGreaterThanOrEqual(2);
  const order = (await page.evaluate(() => window.__h3d.sent()))
    .filter((c) => c.t === 'worker.keys' || c.t === 'worker.paste' || c.t === 'worker.prompt')
    .map((c) => (c.t === 'worker.keys' ? (c.args as { input: Array<{ text?: string }> }).input.map((i) => i.text ?? '').join('') : c.t));
  expect(order).toEqual(['a', 'worker.paste', 'b']);
  expect(await sentOf(page, 'worker.prompt')).toEqual([]);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.seatTerminal()?.lines ?? [])).join('\n')).toContain('second line ✓ 日本');
  // Over 16 KiB: refused as before, nothing sent.
  await page.evaluate(() => navigator.clipboard.writeText('x'.repeat(16 * 1024 + 1)));
  await page.keyboard.press('Control+V');
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().note)).toMatch(/over 16 KiB/);
  expect((await simTerm(page, id))?.pastes).toHaveLength(1);
  await shot(page, 'h176-paste');
  clean();
});

test('a paste on a bridge of #176 part 1 or a read-only seat takes today’s way (worker.prompt for an agent)', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const id = await sitAt(page, 'Nibble', '&simcontrol=part1');
  await expect.poll(() => mode(page)).toBe('control');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'Run the tests.');
    document.querySelector('.seat-input')?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => (await sentOf(page, 'worker.prompt')).map((c) => c.args)).toEqual([{ id, text: 'Run the tests.' }]);
  expect(await sentOf(page, 'worker.paste')).toEqual([]);
  // Nothing says clicks need a newer herdr: this bridge says nothing of them.
  expect(await page.evaluate(() => window.__h3d.seat().clicks)).toBeNull();
  clean();
});

test('a click on a cell reaches the pane; a drag selects and sends none; Ctrl+click on a link opens it, no click', async ({ page, context }) => {
  test.setTimeout(150_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const id = await sitAt(page);
  await expect.poll(() => mode(page)).toBe('control');
  await expect.poll(() => page.evaluate(() => window.__h3d.seatTerminal()?.control?.mouse)).toBe(true);
  await page.evaluate((i) => window.__h3d.simTerm('sim.write', { id: i, data: '\x1b[2J\x1b[1;1Hselect me https://example.com/x\r\n' }), id);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.seatTerminal()?.lines ?? []))[0]).toContain('select me');
  await page.locator('.seat-input').focus();
  await page.keyboard.type('k');
  const p = await cellAt(page, 5, 2);
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await simTerm(page, id))?.clicks).toEqual(['left 5,2']);
  // In order after what was typed before it.
  const order = (await page.evaluate(() => window.__h3d.sent())).map((c) => c.t).filter((t) => t === 'worker.keys' || t === 'terminal.mouse');
  expect(order).toEqual(['worker.keys', 'terminal.mouse']);
  // A drag: a selection, no click.
  const a = await cellAt(page, 0, 0);
  const b = await cellAt(page, 6, 0);
  await page.mouse.move(a.x - 2, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x + 2, b.y, { steps: 6 });
  await page.mouse.up();
  await frames(page, 3);
  expect(await page.evaluate(() => window.__h3d.seatTerminal()?.lines[0] ?? '')).toContain('select me');
  // A double click selects a word: its first click goes in, and herdr's full frame after it keeps the selection.
  const w = await cellAt(page, 2, 0);
  const clicks = (await simTerm(page, id))!.clicks.length;
  await page.mouse.dblclick(w.x, w.y);
  await expect.poll(async () => (await simTerm(page, id))?.clicks.length).toBe(clicks + 1);
  await page.waitForTimeout(300); // the frame has come
  await page.locator('.seat-input').focus();
  await page.keyboard.press('Control+Shift+C');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('select');
  // Ctrl+click on the link: opened, no click.
  const l = await cellAt(page, 14, 0);
  await page.mouse.move(l.x, l.y);
  await frames(page, 2);
  await page.keyboard.down('Control');
  await page.mouse.click(l.x, l.y);
  await page.keyboard.up('Control');
  await expect.poll(() => page.evaluate(() => window.__h3d.opened().map((o) => o.url))).toEqual(['https://example.com/x']);
  await page.waitForTimeout(300);
  expect((await simTerm(page, id))?.clicks).toEqual(['left 5,2', 'left 2,0']);
  // The keyboard stays the seat's.
  await expect(page.locator('.seat-input')).toBeFocused();
  // The footer says clicks reach an app that takes the mouse.
  await expect(page.locator('.seat-keys')).toContainText('a click goes to an app that uses the mouse');
  clean();
});

test('herdr before 0.9.2: a click sends nothing, and the footer says why', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const id = await sitAt(page, 'Tofu', '&simcontrol=nomouse');
  await expect.poll(() => mode(page)).toBe('control');
  await expect(page.locator('.seat-clicks')).toHaveText('Mouse clicks need herdr 0.9.2 or newer');
  const p = await cellAt(page, 5, 2);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(300);
  expect(await sentOf(page, 'terminal.mouse')).toEqual([]);
  expect((await simTerm(page, id))?.clicks).toEqual([]);
  await shot(page, 'h176-no-clicks');
  clean();
});

test('the history scrollbar: shows herdr’s place, drags, pages, keys, follows new output and goes back to live', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const id = await sitAt(page);
  await expect.poll(() => mode(page)).toBe('control');
  const bar = page.locator('.seat-scroll');
  await expect(bar).toBeHidden(); // no history read yet
  // A wheel up: the history shows, and the scrollbar with it.
  const mid = await cellAt(page, 20, 10);
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.wheel(0, -120);
  await expect(bar).toBeVisible();
  await expect.poll(async () => (await simTerm(page, id))?.offset ?? 0).toBeGreaterThan(0);
  await expect(bar).toHaveAttribute('role', 'scrollbar');
  await expect(bar).toHaveAttribute('aria-controls', 'seat-term');
  await expect(bar).toHaveAttribute('aria-valuemax', '200');
  await shot(page, 'h176-scrollbar');
  // Drag the thumb to the top: the whole history up (wheel lines, as herdr takes them), the keyboard stays the seat's.
  await page.locator('.seat-input').focus();
  const thumb = (await page.locator('.seat-scroll-thumb').boundingBox())!;
  const rail = (await bar.boundingBox())!;
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumb.x + thumb.width / 2, rail.y - 50, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await simTerm(page, id))?.offset).toBe(200);
  await expect(page.locator('.seat-input')).toBeFocused();
  // The track below the thumb pages down.
  await page.mouse.click(rail.x + rail.width / 2, rail.y + rail.height - 4);
  await expect.poll(async () => (await simTerm(page, id))?.offset).toBeLessThan(200);
  // Keys while it has the focus: End is live, Home the top; PageDown a screen.
  await bar.focus();
  await page.keyboard.press('End');
  await expect.poll(async () => (await simTerm(page, id))?.offset).toBe(0);
  await page.keyboard.press('Home');
  await expect.poll(async () => (await simTerm(page, id))?.offset).toBe(200);
  await page.keyboard.press('PageDown');
  await expect.poll(async () => (await simTerm(page, id))?.offset).toBeLessThan(200);
  // PageDown was the scrollbar's, not the pane's.
  expect(JSON.stringify(await sentOf(page, 'worker.keys'))).not.toContain('pagedown');
  // New output while up the history: further up, a longer history.
  const before = (await simTerm(page, id))!.offset;
  await page.evaluate((i) => window.__h3d.simTerm('sim.write', { id: i, data: 'one\r\ntwo\r\nthree\r\n' }), id);
  await expect(bar).toHaveAttribute('aria-valuemax', '203');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.seat().scrollbar))?.offset).toBe(before + 3);
  // Back to live (the pill): the thumb at the bottom.
  await page.locator('.seat-history').click();
  await expect.poll(async () => (await simTerm(page, id))?.offset).toBe(0);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.seat().scrollbar))?.offset).toBe(0);
  await expect(bar).toHaveAttribute('aria-valuetext', 'Live');
  clean();
});
