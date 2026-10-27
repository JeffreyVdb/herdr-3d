import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, leftInTerminal, openGame, watchErrors } from './game';

/**
 * #216: the seated laptop's rail (Terminal, Chat, Images, Runs; Files; Host, Leave), its chords (Ctrl+Shift+1…4 and
 * Ctrl+Shift+E by physical key, Ctrl+Esc to the last view), the needs-you line, the Runs view and the files drawer, on the
 * fixture bridge (tools/fixture-manualproc.ts for the runs, the sim world's files and Changes). The terminal keeps its box
 * through all of it: its columns, rows and font, and no resize command, except the needs-you line's rows. Screenshots go to
 * H3D_216_SHOTS (default test-results/h216).
 */
const shots = process.env.H3D_216_SHOTS ?? resolve(import.meta.dirname, '../test-results/h216');
mkdirSync(shots, { recursive: true });
const workers = (JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0]!) as { world: { workers: Worker[] } }).world.workers;
const zippy = workers.find((w) => w.name === 'Zippy')!;
const pebble = workers.find((w) => w.name === 'Pebble')!;
const snap = (page: Page, name: string) => page.screenshot({ path: `${shots}/${name}.png`, animations: 'disabled' });
const mode = (page: Page) => page.evaluate(() => window.__h3d.seat().mode);
const term = (page: Page) => page.evaluate(() => window.__h3d.seatTerminal());
const views = (page: Page) => page.evaluate(() => window.__h3d.seatViews());
const resizes = (page: Page) => page.evaluate(() => window.__h3d.watchLog().filter((e) => e.t === 'terminal.resize' && !String((e.args as { id: string }).id).startsWith('mp:')).length);
const focused = () => (document.activeElement as HTMLElement | null)?.className ?? '';

async function boot(page: Page, key: string, o: { request?: string; ui?: 'quiet' | 'ubuntu'; terminal?: string[] } = {}): Promise<void> {
  if (o.ui) await page.addInitScript((ui) => localStorage.setItem('h3d.theme.ui', ui), o.ui);
  await page.addInitScript(() => localStorage.setItem('h3d.monitors', 'terminal'));
  await openGame(page, 'demo-m5', '&prints=0&open=none', `play=none&sim=1&simms=150&simusage=0&simlimits=ok&simmanual=${key}${o.request ? `&simcmdreq=${o.request}` : ''}`);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  if (o.terminal) await leftInTerminal(page, ...o.terminal);
}
async function sit(page: Page, id: string): Promise<void> {
  expect(await page.evaluate((w) => window.__h3d.face(w), id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seatTerminal()?.opened ?? false)).toBe(true);
  await frames(page, 10);
}
async function start(page: Page, worker: string, op: string, command: string, askpass = false): Promise<string> {
  const r = await page.evaluate((a) => window.__h3d.simManual('manual_process.start', a), { op, worker, command, askpass });
  expect(r.ok).toBe(true);
  return (r.data as { process: { id: string } }).process.id;
}
const attention = (page: Page, id: string, kind: 'confirmed' | 'uncertain' | 'clear') => page.evaluate((a) => window.__h3d.simManual('sim.manual_attention', a), { id, attention: kind });
/** The seated terminal's box: its grid, the xterm's own size, its font; settled (the debounced fit has run). */
async function box(page: Page): Promise<{ cols: number; rows: number; px: number; w: number; h: number }> {
  await page.waitForTimeout(300);
  const t = await term(page);
  const r = await page.locator('.seat-term').evaluate((e) => e.getBoundingClientRect());
  return { cols: t!.cols, rows: t!.rows, px: t!.font!.px, w: Math.round(r.width), h: Math.round(r.height) };
}

test('the rail and every chord swap the four views from the terminal, keeping its box, font, keys and focus', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page, `rail-${Date.now()}`, { terminal: [zippy.id] });
  await sit(page, zippy.id);
  expect(await mode(page)).toBe('terminal');
  const rail = page.getByRole('tablist', { name: 'View' });
  await expect(rail.getByRole('tab')).toHaveText(['Terminal', 'Chat', 'Images', 'Runs']);
  await expect(page.locator('.seat-rail').getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.seat-rail').getByRole('button', { name: /^Runs on / })).toBeVisible();
  await expect(page.locator('.seat-rail').getByRole('button', { name: 'Stand up' })).toBeVisible();
  const before = await box(page);
  const sent = await resizes(page);
  await snap(page, 'terminal-quiet-1280');
  // Plain keys in Terminal mode still go to the pane.
  const keys = () => page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.keys').length);
  const k0 = await keys();
  await page.keyboard.type('ls');
  await expect.poll(keys).toBeGreaterThan(k0);
  await page.waitForTimeout(600); // the keys typed while the first was on its way go in one batch
  // Each chord, from the terminal and from each view: by physical key (Ctrl+Shift+1 is Ctrl+! by `key`).
  for (const [digit, want] of [['2', 'transcript'], ['3', 'images'], ['4', 'runs'], ['1', 'terminal'], ['4', 'runs'], ['2', 'transcript'], ['1', 'terminal']] as const) {
    const k1 = await keys();
    await page.keyboard.press(`Control+Shift+Digit${digit}`);
    await expect.poll(() => mode(page)).toBe(want);
    await expect(rail.getByRole('tab', { selected: true })).toHaveAttribute('data-mode', want);
    expect(await keys(), `Ctrl+Shift+${digit} went to the pane`).toBe(k1);
    expect(await box(page), `the terminal's box after Ctrl+Shift+${digit}`).toEqual(before);
  }
  expect(await page.evaluate(focused)).toContain('seat-input');
  // The rail, by click.
  for (const name of ['Runs', 'Images', 'Chat', 'Terminal'] as const) {
    await rail.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
    await expect.poll(() => mode(page)).toBe({ Runs: 'runs', Images: 'images', Chat: 'transcript', Terminal: 'terminal' }[name]);
    expect(await box(page)).toEqual(before);
  }
  // Ctrl+Esc: the terminal and the last view (Chat was read last).
  await page.keyboard.press('Control+Shift+Digit4');
  await expect.poll(() => mode(page)).toBe('runs');
  await page.keyboard.press('Control+Shift+Digit1');
  await page.keyboard.press('Control+Escape');
  await expect.poll(() => mode(page)).toBe('runs');
  await page.keyboard.press('Control+Escape');
  await expect.poll(() => mode(page)).toBe('terminal');
  expect(await page.evaluate(focused)).toContain('seat-input');
  // The drawer: over the stage, never resizing the terminal; Esc closes it first, then stands up.
  await page.keyboard.press('Control+Shift+KeyE');
  const drawer = page.locator('.fdr');
  await expect(drawer).toHaveAttribute('data-open', 'true');
  await expect(page.locator('.seat-rail').getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'true');
  expect(await box(page)).toEqual(before);
  await snap(page, 'drawer-quiet-1280');
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveAttribute('data-open', 'false');
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(zippy.id);
  expect(await page.evaluate(focused)).toContain('seat-input');
  expect(await box(page)).toEqual(before);
  // The needs-you line: rows only (the debounced fit), never the columns, the font or the focus.
  const run = await start(page, zippy.id, 'n-1', 'read -p "Name? " name');
  await attention(page, run, 'confirmed');
  await expect(page.locator('.seat-needs')).toBeVisible();
  const withLine = await box(page);
  expect({ cols: withLine.cols, px: withLine.px, w: withLine.w }).toEqual({ cols: before.cols, px: before.px, w: before.w });
  expect(await page.evaluate(focused)).toContain('seat-input');
  await attention(page, run, 'clear');
  await expect(page.locator('.seat-needs')).toBeHidden();
  expect(await box(page)).toEqual(before);
  // No resize command for any of it but the line's rows (at most one each way).
  expect((await resizes(page)) - sent).toBeLessThanOrEqual(2);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  clean();
});

test('the needs-you line: a password request in every view, Respond answers it; input wording; +1 more; disconnect clears', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page, `needs-${Date.now()}`, { terminal: [pebble.id] });
  await sit(page, pebble.id);
  const line = page.locator('.seat-needs');
  await expect(line).toBeHidden();
  // An input episode: never "password"; Open terminal is the action.
  const a = await start(page, pebble.id, 'n-a', 'read -p "Name? " name');
  await attention(page, a, 'uncertain');
  await expect(line).toContainText('Pebble’s run may be waiting for input');
  await attention(page, a, 'confirmed');
  await expect(line).toContainText('Pebble’s run is waiting for input');
  await expect(line).not.toContainText(/password|Respond/i);
  await expect(line.locator('.seat-needs-cmd')).toHaveText('read -p "Name? " name');
  await expect(line.getByRole('button', { name: /^Open the terminal of/ })).toHaveClass(/btn--primary/);
  expect(await page.evaluate(focused)).toContain('seat-input'); // it never took the keyboard
  // In every view.
  for (const d of ['2', '3', '4', '1']) {
    await page.keyboard.press(`Control+Shift+Digit${d}`);
    await expect(line).toBeVisible();
  }
  await snap(page, 'needs-input-terminal-quiet-1280');
  // A second: "+1 more", the oldest stays.
  const b = await start(page, pebble.id, 'n-b', 'sudo id', true);
  await expect(line.locator('.seat-needs-more')).toHaveText('+1 more');
  await expect(line).toContainText('Pebble’s run is waiting for input');
  await line.locator('.seat-needs-more').click();
  await expect.poll(() => mode(page)).toBe('runs');
  await page.keyboard.press('Control+Shift+Digit1');
  await attention(page, a, 'clear');
  // The password request alone now: Respond opens its own dialog; fixture-pass answers it; the line clears.
  await expect(line).toContainText('Pebble’s run asks for your password');
  await expect(line.locator('.seat-needs-more')).toHaveCount(0);
  // A request this tab did not start (no Run pressed here) waits on the line: no dialog over the seat by itself.
  const dlg = page.getByRole('dialog', { name: 'Password requested' });
  await expect(dlg).toBeHidden();
  await snap(page, 'needs-password-terminal-quiet-1280');
  await line.getByRole('button', { name: /^Respond to the password request/ }).click();
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('sudo -A id');
  await dlg.getByLabel('Password').fill('fixture-pass');
  await dlg.getByRole('button', { name: 'Submit' }).click();
  await expect(dlg).toBeHidden();
  await expect(line).toBeHidden();
  expect(JSON.stringify(await page.evaluate(() => window.__h3d.sent()))).not.toContain('fixture-pass');
  // A disconnect clears it; back live, it is back.
  const c = await start(page, pebble.id, 'n-d', 'read -p "Again? " x');
  await attention(page, c, 'confirmed');
  await expect(line).toBeVisible();
  await page.evaluate(() => window.__h3d.reconnect());
  await expect(line).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__h3d.connection().phase), { timeout: 20_000 }).toBe('live');
  await expect(line).toBeVisible();
  void b;
  clean();
});

test('the Runs view: rows, actions, the picked run’s terminal; Ctrl+Esc releases it; the dialog takes the run and gives it back', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  page.on('dialog', (d) => void d.accept());
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page, `runs-${Date.now()}`, { request: 'sudo', terminal: [zippy.id] });
  await sit(page, zippy.id);
  const first = await start(page, zippy.id, 'r-1', 'pnpm vitest run src/laptop');
  const asking = await start(page, zippy.id, 'r-2', 'read -p "Name? " name');
  await attention(page, asking, 'confirmed');
  await expect(page.locator('.seat-needs')).toBeVisible();
  // Open terminal on the line: the Runs view on that run, the keyboard in its terminal.
  await page.locator('.seat-needs').getByRole('button', { name: /^Open the terminal of/ }).click();
  await expect.poll(() => mode(page)).toBe('runs');
  await expect.poll(async () => (await views(page))?.runs?.selected).toBe(asking);
  const runs = page.locator('.seat-runs');
  await expect(runs.locator('.mp-request')).toBeVisible(); // the agent's request card, a second instance
  await expect(runs.locator('.seat-run')).toHaveCount(2);
  await expect(runs.locator('.seat-run').first()).toHaveAttribute('data-process', asking); // asking first
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('mp-terminal-input') ?? false)).toBe(true);
  await expect.poll(async () => ((await page.evaluate(() => window.__h3d.simTerm('sim.watches', {}))).data as { ids: string[] }).ids).toContain(`mp:${asking}`);
  await snap(page, 'runs-quiet-1280');
  // Typing goes to the run, never to the worker; a chord from the run terminal swaps the view.
  const keys = () => page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.keys').length);
  const k0 = await keys();
  await page.keyboard.type('hello-run');
  await expect(runs.locator('.xterm-rows')).toContainText('hello-run');
  await page.keyboard.press('Escape'); // a bare Esc goes to the process: still seated, still Runs
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(zippy.id);
  expect(await mode(page)).toBe('runs');
  await page.keyboard.press('Control+Shift+Digit2');
  await expect.poll(() => mode(page)).toBe('transcript');
  await page.keyboard.press('Control+Shift+Digit4');
  await expect.poll(() => mode(page)).toBe('runs');
  expect(await keys()).toBe(k0);
  // Ctrl+Esc in the run's terminal: the keyboard back to the rows; again: the terminal view.
  await runs.locator('.seat-run-pick[aria-current="true"]').press('Enter');
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('mp-terminal-input') ?? false)).toBe(true);
  await page.keyboard.press('Control+Escape');
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('seat-run-pick') ?? false)).toBe(true);
  expect(await mode(page)).toBe('runs');
  // ↓ picks the next run, Enter opens it.
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await views(page))?.runs?.selected).toBe(first);
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await views(page))?.runs?.selected).toBe(asking);
  await page.keyboard.press('Control+Escape');
  await expect.poll(() => mode(page)).toBe('terminal');
  await page.keyboard.press('Control+Escape');
  await expect.poll(() => mode(page)).toBe('runs');
  // The dialog (Host) takes the run while its terminal is open, and hands it back when it closes.
  await page.locator('.seat-rail').getByRole('button', { name: /^Runs on / }).click();
  const dialog = page.locator('dialog.mp-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('All manual processes');
  await dialog.locator(`[data-process="${asking}"]`).getByRole('button', { name: /Open terminal|Open the terminal/ }).click();
  await expect(runs.locator('.seat-runs-held')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(runs.locator('.seat-runs-held')).toBeHidden();
  await expect(runs.locator('.xterm-rows')).toBeVisible();
  // Stop asks first for a live run; Dismiss only on an ended one.
  await runs.locator(`[data-process="${first}"]`).getByRole('button', { name: /^Stop/ }).click();
  await expect(runs.locator(`[data-process="${first}"] .seat-run-state`)).toHaveText(/Stopped/);
  await runs.locator(`[data-process="${first}"]`).getByRole('button', { name: /^Dismiss/ }).click();
  await expect(runs.locator(`[data-process="${first}"]`)).toHaveCount(0);
  await expect(page.locator('.seat-strip-sub', { hasText: 'running' })).toContainText('1 running · 0 finished');
  clean();
});

test('the files drawer: the worker’s tree, the filter, Enter puts a file chip in the prompt box, Esc closes it first', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page, `files-${Date.now()}`, { terminal: [zippy.id] });
  await sit(page, zippy.id);
  const before = await box(page);
  await page.locator('.seat-rail').getByRole('button', { name: 'Files' }).click();
  const drawer = page.locator('.fdr');
  await expect(drawer).toHaveAttribute('data-open', 'true');
  const tree = drawer.getByRole('tree');
  await expect(tree.getByRole('treeitem').first()).toBeVisible();
  expect(await box(page)).toEqual(before);
  // The filter asks the bridge; Enter on a file puts its chip in the box.
  const filter = drawer.getByRole('searchbox').or(drawer.locator('input')).first();
  await filter.fill('readme');
  await expect(tree.getByRole('treeitem', { name: /README\.md/i }).first()).toBeVisible();
  const keys = await page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.keys').length);
  await tree.getByRole('treeitem', { name: /README\.md/i }).first().focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => mode(page)).toBe('transcript');
  const chip = page.locator('.seat-transcript .tx-prompt .cmp-chip, .seat-transcript .tx-prompt [data-chip]').first();
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(/README\.md/i);
  expect(await page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.keys').length)).toBe(keys);
  await snap(page, 'drawer-chip-quiet-1280');
  // Esc: the drawer first (the keyboard to the prompt box with the chip), then the next Esc is the view's.
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveAttribute('data-open', 'false');
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(zippy.id);
  // Ctrl+Shift+E toggles it from the conversation too.
  await page.keyboard.press('Control+Shift+KeyE');
  await expect(drawer).toHaveAttribute('data-open', 'true');
  await page.keyboard.press('Control+Shift+KeyE');
  await expect(drawer).toHaveAttribute('data-open', 'false');
  clean();
});
