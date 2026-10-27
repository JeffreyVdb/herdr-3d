import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, seatMode, watchErrors } from './game';

/**
 * #213: the command suggestion card (a terminal command preview) and the manual runs asking for input, on the fixture
 * bridge (tools/fixture-manualproc.ts): `simcmdreq=sudo-k` is the user's real launch shape with its trailing line break,
 * `sim.manual_attention` plays input episodes, the askpass request is a credential episode. Screenshots go to
 * H3D_213_SHOTS (default test-results/h213).
 */
const shots = process.env.H3D_213_SHOTS ?? resolve(import.meta.dirname, '../test-results/h213');
mkdirSync(shots, { recursive: true });
const workers = (JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0]!) as { world: { workers: Worker[] } }).world.workers;
const zippy = workers.find((w) => w.name === 'Zippy')!;
const pebble = workers.find((w) => w.name === 'Pebble')!;
const USER_COMMAND = 'sudo -k python3 tools/hello_world_server.py 80\n';
const sent = (page: Page) => page.evaluate(() => window.__h3d.sent());
const starts = async (page: Page) => (await sent(page)).filter((x) => x.t === 'manual_process.start');
const snap = (page: Page, name: string) => page.screenshot({ path: `${shots}/${name}.png`, animations: 'disabled' });
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

async function boot(page: Page, key: string, request = '', themes?: { ui: string; transcript: string }): Promise<void> {
  if (themes) await page.addInitScript((t) => { localStorage.setItem('h3d.theme.ui', t.ui); localStorage.setItem('h3d.theme.transcript', t.transcript); }, themes);
  await openGame(page, 'demo-m5', '', `play=none&sim=1&simms=150&simusage=0&simmanual=${key}${request ? `&simcmdreq=${request}` : ''}`);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d')); await frames(page, 3);
}
async function sit(page: Page, id: string, mode: 'terminal' | 'transcript' = 'transcript'): Promise<void> {
  expect(await page.evaluate((w) => window.__h3d.face(w), id)).toBe(true); await frames(page, 3);
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true); await frames(page, 20);
  await seatMode(page, mode);
}
async function start(page: Page, worker: string, op: string, command: string, askpass = false): Promise<string> {
  const r = await page.evaluate((a) => window.__h3d.simManual('manual_process.start', a), { op, worker, command, askpass });
  expect(r.ok).toBe(true);
  return (r.data as { process: { id: string } }).process.id;
}
const attention = (page: Page, id: string, kind: 'confirmed' | 'uncertain' | 'sudo' | 'odd' | 'clear') => page.evaluate((a) => window.__h3d.simManual('sim.manual_attention', a), { id, attention: kind });

/** The contrast of an element's text on the first opaque background behind it (WCAG 2 relative luminance). */
async function contrast(page: Page, selector: string, prop: 'color' | 'border-top-color' | 'background-color' = 'color'): Promise<number> {
  return page.locator(selector).first().evaluate((el, p) => {
    // rgb()/rgba() in 0–255, or color(srgb …) in 0–1 (what color-mix() computes to).
    const rgb = (c: string) => {
      const srgb = c.match(/color\(srgb ([^)]+)\)/);
      const parts = (srgb ? srgb[1]! : c.match(/rgba?\(([^)]+)\)/)![1]!).split(/[ ,/]+/).filter(Boolean).map(Number);
      const [r, g, b] = srgb ? parts.slice(0, 3).map((v) => v * 255) : parts;
      return [r!, g!, b!, parts[3] ?? 1] as const;
    };
    const lum = ([r, g, b]: readonly number[]) => { const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!); };
    let bg: readonly number[] | null = null;
    for (let e: Element | null = p === 'color' ? el : el.parentElement; e && !bg; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c[3] >= 0.99) bg = c; }
    const fg = rgb(getComputedStyle(el).getPropertyValue(p));
    const blend = fg[3] < 1 && bg ? [0, 1, 2].map((i) => fg[i]! * fg[3] + bg![i]! * (1 - fg[3])) : fg;
    const [a, b] = [lum(blend), lum(bg ?? [0, 0, 0])].sort((x, y) => y - x);
    return (a! + 0.05) / (b! + 0.05);
  }, prop);
}

test('card → Edit and run… opens the form prefilled with the exact command, editable; nothing runs without Run', async ({ page }) => {
  const clean = watchErrors(page);
  await boot(page, `edit-${Date.now()}`, 'sudo-k');
  await sit(page, zippy.id);
  const card = page.locator('.mp-request');
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Command Preview from Zippy' })).toBeVisible();
  await expect(card.locator('.mp-request-ask')).toHaveText('Run this command?');
  expect(await card.locator('.mp-well pre').first().textContent()).toBe(USER_COMMAND);
  await expect(card.locator('.mp-launched')).toContainText('sudo -A -k python3 tools/hello_world_server.py 80');
  await expect(card.getByRole('button', { name: 'Copy command' })).toBeVisible();
  await card.getByRole('button', { name: 'Edit and run…' }).click();
  const dlg = page.locator('dialog.mp-dialog');
  const field = dlg.getByLabel('Command');
  await expect(field).toHaveValue(USER_COMMAND);
  await expect(field).toBeEditable();
  await expect(dlg.locator('.mp-askpass')).toBeVisible();
  await expect(dlg.locator('pre')).toContainText('sudo -A -k python3 tools/hello_world_server.py 80');
  await field.press('End'); await field.pressSequentially('# reviewed');
  await expect(field).toHaveValue(`${USER_COMMAND}# reviewed`);
  await field.fill(USER_COMMAND);
  await page.waitForTimeout(400);
  expect(await starts(page)).toHaveLength(0);
  await snap(page, 'edit-and-run-form');
  await dlg.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Password requested' })).toBeVisible();
  const s = await starts(page);
  expect(s).toHaveLength(1);
  expect(s[0]!.args).toMatchObject({ command: USER_COMMAND, askpass: true, source: { kind: 'manual' } });
  await page.getByRole('dialog', { name: 'Password requested' }).getByRole('button', { name: 'Cancel' }).click();
  clean();
});

test('the card runs nothing by itself, and Run starts exactly the reviewed bytes once', async ({ page }) => {
  await boot(page, `run-${Date.now()}`, 'sudo-k');
  await sit(page, zippy.id);
  const card = page.locator('.mp-request');
  await expect(card).toBeVisible(); await page.waitForTimeout(500);
  expect(await starts(page)).toHaveLength(0);
  await card.getByRole('button', { name: 'Run', exact: true }).dblclick({ delay: 0 });
  await expect(page.getByRole('dialog', { name: 'Password requested' })).toBeVisible();
  const s = await starts(page);
  expect(s).toHaveLength(1);
  expect(s[0]!.args).toMatchObject({ command: USER_COMMAND, askpass: true, source: { kind: 'suggestion', index: 0 } });
});

test('a card out of sight: the seat bar says a command waits, one press shows it and focuses Run; no scrolling by itself', async ({ page }) => {
  await boot(page, `review-${Date.now()}`, 'sudo');
  await sit(page, zippy.id, 'terminal');
  const chip = page.locator('.seat-cmdreq');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText('Command to review');
  await snap(page, 'review-chip-terminal');
  await chip.click();
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().mode)).toBe('transcript');
  const run = page.locator('.mp-request').getByRole('button', { name: 'Run', exact: true });
  await expect(run).toBeFocused();
  await expect(page.locator('.mp-request')).toBeInViewport();
  await expect(chip).toBeHidden();
  // Back to the terminal: the chip again (Ctrl+Esc).
  await page.keyboard.press('Control+Escape');
  await expect(chip).toBeVisible();
  // The images: the chip too.
  expect(await starts(page)).toHaveLength(0);
});

test('a password request is in the top bar from another floor; Respond opens its dialog; it clears when answered', async ({ page }) => {
  const clean = watchErrors(page);
  await boot(page, `global-${Date.now()}`);
  await start(page, zippy.id, 'g-1', 'sudo id', true);
  const chip = page.locator('.mpa--top');
  await expect(chip).toBeVisible();
  await expect(chip.locator('.mpa-tape')).toHaveText('Password requested');
  await expect(chip.locator('.mpa-what')).toHaveText('Zippy · sudo id');
  await expect.poll(() => page.evaluate(() => window.__h3d.toastState()?.text)).toBe('Password requested · Zippy · sudo id');
  await page.evaluate(() => window.__h3d.enterFloor('depot-manager')); await frames(page, 5);
  await expect(chip).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Password requested' })).toBeHidden();
  await snap(page, 'attention-top-other-floor');
  await chip.getByRole('button', { name: 'Respond to the password request of “sudo id” (Zippy)' }).click();
  const dlg = page.getByRole('dialog', { name: 'Password requested' });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('sudo -A id');
  await expect(dlg).toContainText('Host: fixture-bridge');
  await dlg.getByLabel('Password').fill('fixture-pass'); await dlg.getByRole('button', { name: 'Submit' }).click();
  await expect(dlg).toBeHidden();
  await expect(chip).toBeHidden();
  expect(JSON.stringify(await sent(page))).not.toContain('fixture-pass');
  clean();
});

test('input: wording by certainty, Open terminal, the seat chips, several runs, clearing, and no repeated toast after a reconnect', async ({ page }) => {
  const clean = watchErrors(page);
  await boot(page, `input-${Date.now()}`);
  const a = await start(page, pebble.id, 'i-1', 'read -p "Name? " name');
  const chip = page.locator('.mpa--top');
  await expect(page.locator('.mpa')).toHaveCount(3);
  await expect(chip).toBeHidden();
  await attention(page, a, 'uncertain');
  await expect(chip.locator('.mpa-tape')).toHaveText('May be waiting for input');
  await attention(page, a, 'confirmed');
  await expect(chip.locator('.mpa-tape')).toHaveText('Waiting for input');
  await expect(chip).not.toContainText(/password/i);
  await expect.poll(() => page.evaluate(() => window.__h3d.toastState()?.text)).toBe('Waiting for input · Pebble · read -p "Name? " name');
  // A reconnect's snapshot brings the same episode back: no toast for it again.
  await page.evaluate(() => window.__h3d.toast('marker'));
  await page.evaluate(() => window.__h3d.reconnect());
  await expect.poll(() => page.evaluate(() => window.__h3d.connection().phase), { timeout: 20_000 }).toBe('live');
  await expect(chip).toBeVisible();
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.__h3d.toastState()?.text)).toBe('marker');
  // Open terminal: that run's terminal, with what the bridge cannot see said.
  await chip.getByRole('button', { name: 'Open the terminal of “read -p "Name? " name” (Pebble)' }).click();
  const dlg = page.locator('dialog.mp-dialog');
  await expect(dlg).toContainText('Waiting for input');
  await expect(dlg).toContainText('Other prompts may not be detected on this machine');
  await expect(dlg.locator('.mp-terminal')).toBeVisible();
  await expect.poll(async () => ((await page.evaluate(() => window.__h3d.simTerm('sim.watches', {}))).data as { ids: string[] }).ids).toContain(`mp:${a}`);
  await dlg.getByRole('button', { name: 'Close' }).click();
  // Two runs: one count; the list names them and puts them first.
  const b = await start(page, zippy.id, 'i-2', 'sudo id', true);
  await expect(chip.locator('.mpa-count')).toHaveText('2 runs need you');
  await snap(page, 'attention-top-two');
  // Seated at Pebble: its run beside its process control, Zippy's in the notices row too.
  await sit(page, pebble.id);
  await expect(page.locator('.seat-processes')).toHaveAttribute('data-attn', '');
  await expect(page.locator('.mpa--own .mpa-tape')).toHaveText('Waiting for input');
  await expect(page.locator('.mpa--others .mpa-what')).toHaveText('Zippy · sudo id');
  await snap(page, 'attention-seat');
  await page.keyboard.press('Escape'); await frames(page, 5);
  await chip.locator('.mpa-count').click();
  const rows = page.locator('dialog.mp-dialog .mp-row--attn');
  await expect(rows).toHaveCount(2);
  // (Opening the list of every process also offers the password dialog, as before #213; it is answered here.)
  const pw = page.getByRole('dialog', { name: 'Password requested' });
  if (await pw.isVisible()) await pw.getByRole('button', { name: 'Cancel' }).click();
  await expect(rows).toHaveCount(1);
  await snap(page, 'attention-list');
  // Clearing: the episode ends, everything about it goes.
  await attention(page, a, 'clear');
  await expect(rows).toHaveCount(0);
  await expect(chip).toBeHidden();
  void b;
  clean();
});

test('an unknown reason is shown generically', async ({ page }) => {
  await boot(page, `odd-${Date.now()}`);
  const a = await start(page, pebble.id, 'o-1', 'make');
  await attention(page, a, 'odd');
  const chip = page.locator('.mpa--top');
  await expect(chip.locator('.mpa-tape')).toHaveText('Waiting for input');
  expect(await chip.getAttribute('title')).not.toContain('fixture_new_code');
});

for (const ui of ['quiet', 'ubuntu']) for (const transcript of ['quiet', 'ubuntu']) {
  test(`card in ui=${ui} transcript=${transcript}: deliberate at desktop and 390 px, text 4.5:1, controls 3:1`, async ({ page }) => {
    await boot(page, `look-${ui}-${transcript}-${Date.now()}`, 'tailscale-bg', { ui, transcript });
    await sit(page, zippy.id);
    const card = page.locator('.mp-request');
    await card.scrollIntoViewIfNeeded();
    await snap(page, `card-${ui}-ui-${transcript}-transcript-desktop`);
    for (const sel of ['.mp-request-title', '.mp-request-from', '.mp-request-ask', '.mp-meta dt', '.mp-meta dd', '.mp-meta-note', '.mp-why', '.mp-well pre', '.mp-launched-label', '.mp-variant-note', '.mp-request .btn--primary', '.mp-request .btn:not(.btn--primary)', '.mp-askpass span'])
      expect(await contrast(page, sel), `${sel} text`).toBeGreaterThanOrEqual(4.5);
    expect(await contrast(page, '.mp-request .btn:not(.btn--primary)', 'border-top-color'), 'a secondary action’s edge').toBeGreaterThanOrEqual(3);
    expect(await contrast(page, '.mp-request .btn--primary', 'background-color'), 'the primary action on the card').toBeGreaterThanOrEqual(3);
    // The focus ring on the primary action.
    await card.getByRole('button', { name: 'Run', exact: true }).focus();
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    const ring = await card.getByRole('button', { name: 'Run', exact: true }).evaluate((e) => getComputedStyle(e).outlineStyle);
    expect(ring).not.toBe('none');
    await page.setViewportSize({ width: 390, height: 844 }); await frames(page, 10);
    await card.scrollIntoViewIfNeeded();
    await noOverflow(page);
    await snap(page, `card-${ui}-ui-${transcript}-transcript-390`);
  });
}

test('other machine: copy and dismiss only', async ({ page }) => {
  await boot(page, `other-${Date.now()}`, 'other-host');
  await sit(page, zippy.id);
  const card = page.locator('.mp-request');
  await expect(card.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Edit and run…' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Copy command' })).toBeEnabled();
  await expect(card).toContainText('The agent asked to run this on the build machine');
  await expect(card.locator('.mp-well pre').first()).not.toHaveAttribute('tabindex');
  await snap(page, 'card-other-host');
});

test('a long line scrolls sideways and takes the keyboard; a short one is no tab stop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, `long-${Date.now()}`, 'tailscale-bg');
  await sit(page, zippy.id);
  const card = page.locator('.mp-request');
  await card.scrollIntoViewIfNeeded();
  const pre = card.locator('.mp-well pre').first();
  await expect.poll(() => pre.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  await expect(pre).toHaveAttribute('tabindex', '0');
  await pre.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await expect.poll(() => pre.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
});
