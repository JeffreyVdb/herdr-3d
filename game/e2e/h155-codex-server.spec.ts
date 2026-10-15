import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, shot, watchErrors, openMenu, settingsSection } from './game';

// #155: the Settings window's “Codex workers” switch against the fixture bridge (`sim=1`,
// tools/fixture-codex-server.ts): off by default, switched on and off through codex_server.set, and disabled with
// why on a bridge that cannot start the servers (`simfail=no_codex_run`).

async function openSection(page: Page): Promise<Locator> {
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  // #49: one section at a time: show Codex workers.
  return settingsSection(page, 'codex');
}

test('off by default; on and off again, each saying what changes', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', 'play=none&sim=1&simusage=0');
  const section = await openSection(page);
  await expect(section.getByRole('heading', { name: 'Codex workers', level: 3 })).toBeVisible();
  await expect(section.locator('.settings-store')).toHaveText('Bridge');
  const toggle = section.getByRole('checkbox', { name: 'Give new Codex workers their own Codex server' });
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAccessibleDescription(/Codex workers hired from now on/);
  await expect(section).toContainText('approvals stay in the terminal');

  await toggle.check();
  await expect(section.locator('.settings-status')).toHaveText('On. The next Codex hire gets its own server.');
  await section.scrollIntoViewIfNeeded();
  await shot(page, 'settings-codex-server-on');
  await toggle.uncheck();
  await expect(section.locator('.settings-status')).toHaveText('Off. New Codex workers use the server built into their terminal.');
  await expect(toggle).not.toBeChecked();
  clean();
});

test('a bridge that cannot start the servers: disabled, with why', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '', 'play=none&sim=1&simusage=0&simfail=no_codex_run');
  const section = await openSection(page);
  const toggle = section.getByRole('checkbox', { name: 'Give new Codex workers their own Codex server' });
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAccessibleDescription(/can’t start them/);
  clean();
});

// #155 R2 (U1): the seat bar's Codex notice keeps the phone layout. At 390 px the notice takes the question's row and
// whose laptop it is shares the next with Stand up, all inside the screen; a wide window keeps its three columns.
test('the seat bar’s Codex notice fits a phone, and a wide window keeps its row', async ({ page }) => {
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openGame(page, 'demo-m5', '', 'play=none&sim=1&simusage=0');
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as {
    world: { workers: Worker[] };
  };
  const w = snap.world.workers.find((x) => x.name === 'Pebble');
  if (!w) throw new Error('no Pebble in demo-m5');
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  const seat = page.locator('.seat');
  const stand = seat.getByRole('button', { name: /Stand up/ });
  await expect(stand).toBeVisible();
  const notice = seat.locator('.seat-codex');
  let seq = 2_000_000;
  for (const codex of [
    { mode: 'shared', server: 'down' },
    { mode: 'legacy', note: 'shared Codex server: .envrc is blocked: /home/u/repo/.envrc (run `direnv allow` there); started the usual way' },
  ] as const) {
    await page.evaluate(([x, s]) => window.__h3d.inject({ t: 'worker.upsert', seq: s, worker: x }), [{ ...w, codex }, seq++] as const);
    await expect(notice).toBeVisible();
    const [sb, nb] = await Promise.all([stand.boundingBox(), notice.boundingBox()]);
    expect(sb && sb.x + sb.width <= 390 && sb.x >= 0).toBe(true);
    expect(nb && nb.x + nb.width <= 390 && nb.x >= 0).toBe(true);
    expect(await seat.evaluate((el) => getComputedStyle(el).gridTemplateAreas)).toBe('"ask ask" "line stand" "mode mode" "keys keys"');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
  await shot(page, 'seat-codex-notice-phone');
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(notice).toBeVisible();
  expect(await seat.evaluate((el) => getComputedStyle(el).gridTemplateAreas)).toBe('"ask ask ask" "line mode stand" "keys keys keys"');
  clean();
});

// #186: a Codex hire that asked for its own server and got Codex's built-in one (`simfail=codex_unverified`: a
// codex-cli 0.163.0 the shared server is not verified with) is hired: a warning toast, with its own sign, that names the
// version and what it costs, not the red of a failed hire.
test('a hire that falls back to Codex’s built-in server is a warning, not an error', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  // Stay on the floor (#116 off), so the toast is in view for the shot.
  await page.addInitScript(() => localStorage.setItem('h3d.hire.goto', 'off'));
  await openGame(page, 'demo-m4', '', 'play=none&sim=1&simms=150&simusage=0&simfail=codex_unverified');
  const section = await openSection(page);
  await section.getByRole('checkbox', { name: 'Give new Codex workers their own Codex server' }).check();
  await expect(section.locator('.settings-status')).toHaveText('On. The next Codex hire gets its own server.');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
  await page.evaluate(() => window.__h3d.enterFloor('pastry'));
  await frames(page, 3);
  const L = await page.evaluate(() => window.__h3d.layout('pastry'));
  const s = L?.slots[14];
  if (!L || !s) throw new Error('no desk 14');
  await page.evaluate(([x, z]) => window.__h3d.setPose({ x, z, yaw: 0 }), [s.seat.x - Math.sin(s.yaw) * 1.1, s.seat.z - Math.cos(s.yaw) * 1.1] as const);
  await frames(page, 2);
  await page.evaluate(() => window.__h3d.openHire(14));
  await expect.poll(() => page.evaluate(() => window.__h3d.dialog()?.kind === 'hire' && window.__h3d.dialog()?.state), { timeout: 10_000 }).toBe('ready');
  // The floor's default is Claude: Codex, from the keyboard (arrows pick, as in m4.spec).
  await page.locator('[data-key="harness:claude"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => (window.__h3d.dialog() as { form?: { harness?: string } } | null)?.form?.harness)).toBe('codex');
  await page.locator('#hire-task').focus();
  await page.keyboard.type('Label the loaves');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__h3d.dialog())).toBeNull();
  const toast = page.locator('.toast');
  await expect(toast).toHaveText(
    /^Hired .* at Desk 15 .*Here they come\. No own Codex server: the shared Codex server is not verified with Codex 0\.162\.0 yet \(verified: 0\.160\.x or 0\.161\.x\)\. It runs on Codex’s built-in server, so its async questions can’t be answered from the transcript\.$/,
  );
  await expect(toast).toHaveAttribute('data-kind', 'warn');
  // Not colour alone: the warning's drawn sign.
  expect(await toast.evaluate((el) => getComputedStyle(el, '::before').maskImage || getComputedStyle(el, '::before').webkitMaskImage)).toContain('svg');
  // Clear of the limits plate, which the hire dialog folded and which is back now.
  const [tb, lb] = await Promise.all([toast.boundingBox(), page.locator('[data-hook="limits"]').boundingBox()]);
  expect(tb && lb && (tb.y >= lb.y + lb.height || tb.x + tb.width <= lb.x)).toBe(true);
  await shot(page, 'hire-codex-fallback-warning');
  clean();
});
