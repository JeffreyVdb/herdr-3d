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

async function boot(page: Page, key: string, o: { request?: string; ui?: 'quiet' | 'ubuntu'; terminal?: string[]; sim?: string } = {}): Promise<void> {
  if (o.ui) await page.addInitScript((ui) => localStorage.setItem('h3d.theme.ui', ui), o.ui);
  await page.addInitScript(() => localStorage.setItem('h3d.monitors', 'terminal'));
  await openGame(page, 'demo-m5', '&prints=0&open=none', `play=none&sim=1&simms=150&simusage=0&simlimits=ok&simmanual=${key}${o.request ? `&simcmdreq=${o.request}` : ''}${o.sim ?? ''}`);
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

test('the rail and every chord swap the four views from the terminal, keeping its box, font, keys and focus', { tag: '@smoke' }, async ({ page }) => {
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
  await expect(page.locator('.seat-rail').getByRole('button', { name: 'Leave the laptop' })).toBeVisible();
  const before = await box(page);
  const sent = await resizes(page);
  await snap(page, 'terminal-quiet-1280');
  // Plain keys in Terminal mode still go to the pane.
  const keys = () => page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.keys').length);
  const k0 = await keys();
  await page.keyboard.type('ls');
  await expect.poll(keys).toBeGreaterThan(k0);
  // Everything that reached the pane, as text and key names (the keys typed while the first was on its way go later,
  // in one batch: so what went is compared, not how many sends).
  const typed = () => page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.keys').flatMap((c) => (c.args as { input: Array<{ text?: string; key?: string }> }).input.map((i) => i.text ?? `<${i.key}>`)).join(''));
  // Each chord, from the terminal and from each view: by physical key (Ctrl+Shift+1 is Ctrl+! by `key`).
  for (const [digit, want] of [['2', 'transcript'], ['3', 'images'], ['4', 'runs'], ['1', 'terminal'], ['4', 'runs'], ['2', 'transcript'], ['1', 'terminal']] as const) {
    await page.keyboard.press(`Control+Shift+Digit${digit}`);
    await expect.poll(() => mode(page)).toBe(want);
    await expect(rail.getByRole('tab', { selected: true })).toHaveAttribute('data-mode', want);
    expect(await box(page), `the terminal's box after Ctrl+Shift+${digit}`).toEqual(before);
  }
  // Nothing of the chords reached the pane: only the "ls" typed before them.
  await expect.poll(typed).toBe('ls');
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
  const files = page.locator('.seat-rail').getByRole('button', { name: 'Files' });
  await page.keyboard.press('Escape'); // the drawer's own Esc (its filter has the keyboard)
  await expect(drawer).toHaveAttribute('data-open', 'false');
  await expect(files).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(zippy.id);
  expect(await page.evaluate(focused)).toContain('seat-input');
  // The seat's Esc closes it first too, with the keyboard back on the terminal; the chord toggles it shut.
  await page.keyboard.press('Control+Shift+KeyE');
  await expect(drawer).toHaveAttribute('data-open', 'true');
  await page.locator('.seat-input').focus();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveAttribute('data-open', 'false');
  await expect(files).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(zippy.id);
  await page.keyboard.press('Control+Shift+KeyE');
  await expect(drawer).toHaveAttribute('data-open', 'true');
  await page.keyboard.press('Control+Shift+KeyE');
  await expect(drawer).toHaveAttribute('data-open', 'false');
  await expect(files).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(focused)).toContain('seat-input');
  expect(await box(page)).toEqual(before);
  // AC2: not one resize command for the swaps, the rail and the drawer.
  expect(await resizes(page), 'resize commands from view swaps or the drawer').toBe(sent);
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
  // The line's rows only: at most one resize as it came and one as it went.
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
  // The bridge's answer to the filter has replaced the tree (the unfiltered rows are gone) before a row takes the keyboard.
  await expect(tree.getByRole('treeitem', { name: /^cmd\b/ })).toHaveCount(0);
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

test('the files drawer while the worker asks: nothing goes in, the drawer says why; once answered, it goes in', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 900, height: 700 });
  await boot(page, `files-ask-${Date.now()}`, { terminal: [zippy.id] });
  await sit(page, zippy.id);
  const ask = { tool_use_id: 'toolu_h216_ask', agent: 'claude', questions: [{ header: 'Color', question: 'Which color?', multi: false, other: false, options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }] }] };
  expect((await page.evaluate((a) => window.__h3d.simAsk({ id: a.id, ask: a.ask }), { id: zippy.id, ask })).ok).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().ask)).not.toBeNull();
  await page.keyboard.press('Control+Shift+KeyE');
  const drawer = page.locator('.fdr');
  await expect(drawer).toHaveAttribute('data-open', 'true');
  const readme = drawer.getByRole('treeitem', { name: /README\.md/i }).first();
  await readme.focus();
  await page.keyboard.press('Enter');
  const said = drawer.locator('.fdr-said');
  await expect(said).toBeVisible();
  await expect(said).toHaveText(/Zippy is waiting for your answer/);
  expect(await contrast(page, '.fdr-said')).toBeGreaterThanOrEqual(4.5);
  expect(await mode(page)).toBe('terminal'); // no view swap, no "Added"
  expect(await page.evaluate(() => window.__h3d.seat().note)).not.toMatch(/Added/);
  await snap(page, 'drawer-refused-quiet-900');
  // Answered (the ask goes): the next Enter puts the chip in.
  await page.evaluate((id) => window.__h3d.simAsk({ id, ask: null }), zippy.id);
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().ask)).toBeNull();
  await readme.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => mode(page)).toBe('transcript');
  await expect(said).toBeHidden();
  await expect(page.locator('.seat-transcript .tx-prompt .cmp-chip, .seat-transcript .tx-prompt [data-chip]')).toHaveCount(1);
  clean();
});

test('an older bridge (no transcripts): a Runs view restored on sitting stays up with its terminal; Chat says why', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot(page, `old-${Date.now()}`, { sim: '&simfail=no_m16' });
  await page.evaluate((id) => localStorage.setItem('h3d.seat.runs', JSON.stringify([id])), zippy.id);
  await start(page, zippy.id, 'o-1', 'pnpm vitest run src/laptop');
  await sit(page, zippy.id);
  await expect.poll(() => mode(page)).toBe('runs');
  // The conversation's watch is refused (unknown_command): Runs stays, its terminal too, and nothing says error.
  await expect.poll(() => page.evaluate(() => window.__h3d.watchLog().some((c) => c.t === 'transcript.watch' && c.result?.code === 'unknown_command'))).toBe(true);
  await frames(page, 20);
  await page.waitForTimeout(500);
  expect(await mode(page)).toBe('runs');
  await expect(page.locator('.seat-runs .xterm-rows')).toBeVisible();
  expect(await page.evaluate(() => window.__h3d.seat().state)).not.toBe('error');
  // Chat cannot open here (it says why) and Runs stays; Ctrl+Esc goes to the terminal and back to Runs.
  await page.keyboard.press('Control+Shift+Digit2');
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().state)).toBe('error');
  expect(await mode(page)).toBe('runs');
  await page.keyboard.press('Control+Escape');
  await expect.poll(() => mode(page)).toBe('terminal');
  await page.keyboard.press('Control+Escape');
  await expect.poll(() => mode(page)).toBe('runs');
  await expect(page.locator('.seat-runs .xterm-rows')).toBeVisible();
  clean();
});

/** What of the Runs view is in sight (px high, inside its scrolling body and the window): its run terminal, its card; the picked row whole? */
const sight = (page: Page) =>
  page.evaluate(() => {
    const body = document.querySelector('.seat-runs-body')!.getBoundingClientRect();
    const list = document.querySelector('.seat-runs-list')!.getBoundingClientRect();
    const top = Math.max(body.top, 0);
    const bottom = Math.min(body.bottom, innerHeight);
    const seen = (r: DOMRect) => Math.round(Math.max(0, Math.min(r.bottom, bottom) - Math.max(r.top, top)));
    const term = document.querySelector('.seat-runs-term')!.getBoundingClientRect();
    const row = document.querySelector('.seat-run--on')!.getBoundingClientRect();
    const card = document.querySelector('.seat-runs .mp-request');
    return { term: seen(term), termH: Math.round(term.height), card: card ? seen(card.getBoundingClientRect()) : 0, row: row.top >= Math.max(top, list.top) - 1 && row.bottom <= Math.min(bottom, list.bottom) + 1 };
  });

for (const ui of ['quiet', 'ubuntu'] as const) {
  test(`${ui}: Open terminal with the request card and three runs shows the run's terminal whole at 900×700, 1280×800 and on a phone`, async ({ page }) => {
    test.setTimeout(180_000);
    const clean = watchErrors(page);
    await page.setViewportSize({ width: 900, height: 700 });
    await boot(page, `fit-${ui}-${Date.now()}`, { ui, request: 'sudo', terminal: [zippy.id] });
    await sit(page, zippy.id);
    await start(page, zippy.id, 'f-1', 'echo b');
    await start(page, zippy.id, 'f-2', 'echo c');
    const asking = await start(page, zippy.id, 'f-3', 'read -p "Name? " name');
    await attention(page, asking, 'confirmed');
    for (const size of [{ width: 900, height: 700 }, { width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      await page.keyboard.press('Control+Shift+Digit1');
      await expect.poll(() => mode(page)).toBe('terminal');
      await page.setViewportSize(size);
      await frames(page, 6);
      await page.waitForTimeout(300);
      await page.locator('.seat-needs').getByRole('button', { name: /^Open the terminal of/ }).click();
      await expect.poll(() => mode(page)).toBe('runs');
      await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('mp-terminal-input') ?? false)).toBe(true);
      await expect(page.locator('.seat-runs .mp-request')).toBeVisible();
      await expect(page.locator('.seat-runs .seat-run')).toHaveCount(3);
      await page.waitForTimeout(300);
      const s = await sight(page);
      await snap(page, `runs-open-${ui}-${size.width}`);
      // The focused terminal is on the screen, whole, at a usable height; the picked row shows; the card does too (in part).
      expect(s.term, `${size.width}: ${JSON.stringify(s)}`).toBeGreaterThanOrEqual(150);
      expect(s.term, `${size.width}: ${JSON.stringify(s)}`).toBeGreaterThanOrEqual(s.termH - 1);
      expect(s.row, `${size.width}: ${JSON.stringify(s)}`).toBe(true);
      if (size.width > 560) expect(s.card, `${size.width}: ${JSON.stringify(s)}`).toBeGreaterThanOrEqual(80);
      // A row's own Open terminal (another run) takes the same path.
      const other = page.locator('.seat-runs .seat-run').nth(2);
      await other.getByRole('button', { name: /^Open the terminal of/ }).click();
      await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('mp-terminal-input') ?? false)).toBe(true);
      await page.waitForTimeout(300);
      const t = await sight(page);
      expect(t.term, `${size.width} row: ${JSON.stringify(t)}`).toBeGreaterThanOrEqual(Math.min(150, t.termH));
      expect(t.term, `${size.width} row: ${JSON.stringify(t)}`).toBeGreaterThanOrEqual(t.termH - 1);
      expect(t.row, `${size.width} row: ${JSON.stringify(t)}`).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    clean();
  });
}

/** The contrast of an element's text (or `prop`) on the first opaque background behind it (WCAG 2 relative luminance). */
async function contrast(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => {
    const rgb = (c: string) => {
      const srgb = c.match(/color\(srgb ([^)]+)\)/);
      const parts = (srgb ? srgb[1]! : c.match(/rgba?\(([^)]+)\)/)![1]!).split(/[ ,/]+/).filter(Boolean).map(Number);
      const [r, g, b] = srgb ? parts.slice(0, 3).map((v) => v * 255) : parts;
      return [r!, g!, b!, parts[3] ?? 1] as const;
    };
    const lum = ([r, g, b]: readonly number[]) => { const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!); };
    let bg: readonly number[] | null = null;
    for (let e: Element | null = el; e && !bg; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c[3] >= 0.99) bg = c; }
    const fg = rgb(getComputedStyle(el).color);
    const blend = fg[3] < 1 && bg ? [0, 1, 2].map((i) => fg[i]! * fg[3] + bg![i]! * (1 - fg[3])) : fg;
    const [a, b] = [lum(blend), lum(bg ?? [0, 0, 0])].sort((x, y) => y - x);
    return (a! + 0.05) / (b! + 0.05);
  });
}

for (const ui of ['quiet', 'ubuntu'] as const) {
  test(`${ui}: every view with and without the needs-you line, the drawer, a phone's Runs; text contrast of the new surfaces`, { tag: '@visual' }, async ({ page }) => {
    test.setTimeout(240_000);
    const clean = watchErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await boot(page, `shots-${ui}-${Date.now()}`, { ui, request: 'sudo', terminal: [zippy.id] });
    await sit(page, zippy.id);
    const asking = await start(page, zippy.id, 's-1', 'sudo -A tailscale serve --https=8443 http://127.0.0.1:39525');
    await start(page, zippy.id, 's-2', 'pnpm vitest run src/laptop');
    const ended = await start(page, zippy.id, 's-3', 'make lint');
    await page.evaluate((id) => window.__h3d.simManual('sim.manual_finish', { id, exit_code: 0 }), ended);
    const views = [['1', 'terminal'], ['2', 'chat'], ['3', 'images'], ['4', 'runs']] as const;
    for (const size of [{ width: 1280, height: 800 }, { width: 900, height: 700 }]) {
      await page.setViewportSize(size);
      await frames(page, 6);
      for (const needs of [true, false]) {
        await attention(page, asking, needs ? 'confirmed' : 'clear');
        await expect(page.locator('.seat-needs')).toBeVisible({ visible: needs });
        // The episode's toast would cover the line in the shots.
        await expect.poll(() => page.evaluate(() => window.__h3d.toastState()?.shown ?? false), { timeout: 15_000 }).toBe(false);
        for (const [d, name] of views) {
          await page.keyboard.press(`Control+Shift+Digit${d}`);
          await frames(page, 4);
          await page.waitForTimeout(250);
          await snap(page, `${name}${needs ? '-needs' : ''}-${ui}-${size.width}`);
        }
      }
      await page.keyboard.press('Control+Shift+Digit1');
      await page.keyboard.press('Control+Shift+KeyE');
      await expect(page.locator('.fdr[data-open="true"] [role="treeitem"]').first()).toBeVisible();
      await page.waitForTimeout(250);
      await snap(page, `drawer-${ui}-${size.width}`);
      await page.keyboard.press('Escape');
    }
    // Text contrast on the new surfaces, measured (≥ 4.5:1).
    await page.setViewportSize({ width: 1280, height: 800 });
    await attention(page, asking, 'confirmed');
    await page.keyboard.press('Control+Shift+Digit4');
    await expect(page.locator('.seat-runs .seat-run')).toHaveCount(3);
    const texts = ['.seat-rail-view[aria-selected="true"] .seat-rail-word', '.seat-rail-view:not([aria-selected="true"]) .seat-rail-word', '.seat-rail-host .seat-rail-word', '.seat-rail-view[data-mode="runs"] .seat-rail-badge', '.seat-needs-who', '.seat-needs-cmd', '.seat-needs-more', '.seat-runs .seat-strip-name', '.seat-runs .seat-strip-sub', '.seat-run-cmd', '.seat-run-state', '.seat-run-state[data-attn]', '.seat-run-time', '.seat-runs-head-cmd', '.seat-runs-head-meta', '.seat-runs-new'];
    const low: string[] = [];
    for (const t of texts) {
      if (!(await page.locator(t).count())) continue;
      const r = await contrast(page, t);
      if (r < 4.5) low.push(`${t}: ${r.toFixed(2)}`);
    }
    await page.keyboard.press('Control+Shift+Digit1');
    for (const t of ['.seat-term-strip .seat-strip-name', '.seat-term-strip .seat-strip-sub']) {
      const r = await contrast(page, t);
      if (r < 4.5) low.push(`${t}: ${r.toFixed(2)}`);
    }
    expect(low, `${ui}: text under 4.5:1`).toEqual([]);
    // A phone: the Runs view stacks and scrolls, nothing off the page.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('Control+Shift+Digit4');
    await frames(page, 6);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await snap(page, `runs-needs-${ui}-390`);
    clean();
  });
}
