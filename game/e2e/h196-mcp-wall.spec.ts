import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// #196 on demo-m118 (the lab floor): the MCP & skills screen hangs on the north wall over the server rack. Looking at it
// asks the bridge for the inventory (mcp.inventory, every 20 s while you look); E opens the overview: both providers'
// servers by the merge rule, a checkout and Codex profile to pick, Refresh, Check connections, the expected list, the
// skills. The fixture simulator plays the bridge (tools/fixture-mcp.ts).

const SIM = 'play=none&sim=1&simms=150&simmcpcheckms=400';

type Info = NonNullable<Awaited<ReturnType<typeof window.__h3d.mcp>>>;
const mcp = (page: Page) => page.evaluate(() => window.__h3d.mcp()) as Promise<Info>;
const sent = async (page: Page) => (await mcp(page)).sent.map((s) => ({ t: s.t, profile: s.args.codex_profile ?? null, cwd: s.args.cwd, result: s.result ?? null }));

/** On the lab floor, at its south end facing south: the screen is behind you, out of view. */
async function onLab(page: Page, wsQuery = SIM): Promise<void> {
  await openGame(page, 'demo-m118', '', wsQuery);
  await page.evaluate(() => {
    const L = window.__h3d.layout('lab');
    return window.__h3d.enterFloor('lab', { x: (L?.width ?? 18) / 2, z: (L?.depth ?? 14) - 1.3, yaw: Math.PI, pitch: 0 });
  });
  await frames(page, 3);
}

/** In front of the rack, looking up at the screen over it from `dist` metres. */
async function faceScreen(page: Page, dist = 2.4): Promise<void> {
  await page.evaluate((dist) => {
    const b = window.__h3d.layout('lab')?.props.find((p) => p.id === 'screen.mcp')?.box;
    if (!b) throw new Error('no MCP screen');
    const mid = (b.min[1] + b.max[1]) / 2;
    window.__h3d.setPose({ x: (b.min[0] + b.max[0]) / 2, z: b.max[2] + dist, yaw: 0, pitch: Math.atan2(mid - 1.55, dist) });
  }, dist);
  await frames(page, 3);
}

async function openPage(page: Page): Promise<void> {
  await page.evaluate(() => window.__h3d.openMcp());
  await expect(page.locator('dialog.mcp[open]')).toBeVisible();
  await expect.poll(async () => (await mcp(page)).page.state, { timeout: 15_000 }).toBe('data');
}

test('looking at the wall asks for the inventory and shows it; E opens the overview, Esc closes it', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onLab(page);
  // Nobody has looked: the bridge was never asked.
  await page.waitForTimeout(600);
  expect(await sent(page)).toEqual([]);
  await faceScreen(page);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'prop', id: 'screen.mcp' });
  const bar = page.locator('.prompt');
  await expect(bar).toContainText('MCP & skills');
  await expect.poll(async () => (await sent(page)).map((s) => s.t).join()).toBe('mcp.inventory');
  await expect.poll(async () => (await mcp(page)).screen?.mode, { timeout: 15_000 }).toBe('data');
  const s = (await mcp(page)).screen;
  expect(s?.lines).toEqual(expect.arrayContaining(['MCP & skills', 'Claude Code', '4 MCP servers', '1 needs attention', 'Codex', '2 MCP servers', 'Nothing needs attention', '2+ skills', '3 skills']));
  expect(s?.lines.some((l) => /· Codex profile default$/.test(l))).toBe(true);
  await expect(bar).toContainText('Claude Code 4 MCP (1 needs you) · Codex 2 MCP');
  // Looking on: no redraw and no second request for 20 s.
  const draws = s?.draws ?? 0;
  await page.waitForTimeout(1500);
  expect((await mcp(page)).screen?.draws).toBe(draws);
  expect((await sent(page)).length).toBe(1);
  await shot(page, 'h196-wall');

  // E: the overview over the scene, its focus on the checkout; Esc closes it and the game has its keys again.
  await page.keyboard.press('KeyE');
  const dlg = page.locator('dialog.mcp[open]');
  await expect(dlg).toBeVisible();
  await expect(page.locator('#mcp-cwd')).toBeFocused();
  await expect(dlg.locator('.mcp-prov')).toHaveCount(2);
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-key="refresh"]')).toBeFocused();
  await shot(page, 'h196-overview');
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  expect((await mcp(page)).page.open).toBe(false);
  clean();
});

test('a missing expected server and a server that needs a sign-in: the expected list, Check connections', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onLab(page);
  await openPage(page);
  const dlg = page.locator('dialog.mcp[open]');
  // The expected list: add notion (and github), save; it is the floor's setting.
  await dlg.locator('#mcp-exp-input').fill('notion');
  await dlg.locator('#mcp-exp-input').press('Enter');
  await dlg.locator('#mcp-exp-input').fill('github');
  await dlg.locator('[data-key="exp-add"]').click();
  await dlg.locator('[data-key="exp-save"]').click();
  await expect(dlg.locator('.mcp-exp-msg')).toContainText('Saved');
  await expect.poll(async () => (await mcp(page)).page.rows.find((r) => r.name === 'notion')).toEqual({ name: 'notion', expected: true, claude: 'Expected, not configured in Claude Code', codex: 'Expected, not configured in Codex', missing: true });
  const p = (await mcp(page)).page;
  expect(p.providers.map((x) => x.attention)).toEqual([2, 1]); // Claude: linear (approval) + notion; Codex: notion
  // Not configured is not missing: linear is only in Claude Code, not expected.
  expect(p.rows.find((r) => r.name === 'linear')).toMatchObject({ claude: 'Needs approval', codex: 'Not configured in Codex', missing: false });

  // Check connections for Claude Code: the button says what it does, is disabled while it runs, then the probe's statuses.
  const check = dlg.locator('[data-key="check-claude"]');
  await expect(dlg.locator(`#${await check.getAttribute('aria-describedby')}`)).toContainText('Starts the configured servers');
  await check.click();
  await expect(dlg.locator('[data-key="check-claude"]')).toBeDisabled();
  await expect.poll(async () => (await mcp(page)).page.providers[0]?.check, { timeout: 10_000 }).toBe('ok');
  const rows = (await mcp(page)).page.rows;
  expect(rows.find((r) => r.name === 'sentry')).toMatchObject({ claude: 'Needs sign-in', codex: 'Configured' });
  expect(rows.find((r) => r.name === 'github')).toMatchObject({ claude: 'Connected' });
  expect(rows.find((r) => r.name === 'Gmail')).toMatchObject({ claude: 'Connected', codex: 'Not configured in Codex' });
  expect(rows.find((r) => r.name === 'linear')?.claude).toBe('Needs approval'); // never started
  await expect(dlg.locator('.mcp-row[data-name="sentry"] .mcp-cell[data-harness="claude"]')).toContainText('Sign in with /mcp in Claude Code.');
  // Only one check went, on request; the polls are inventories.
  expect((await sent(page)).filter((x) => x.t === 'mcp.check')).toHaveLength(1);
  await shot(page, 'h196-overview-checked');
  clean();
});

test('a stale result stays labelled, on the page and the wall; a failed read never says "not configured"', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onLab(page);
  await page.evaluate(() => window.__h3d.simMcp('sim.mcp', { stale: 'codex', fail: 'claude' }));
  await openPage(page);
  const p = (await mcp(page)).page;
  expect(p.providers.map((x) => x.tone)).toEqual(['failed', 'stale']);
  expect(p.rows.find((r) => r.name === 'sentry')).toMatchObject({ claude: 'Unknown', codex: 'Configured' });
  const dlg = page.locator('dialog.mcp[open]');
  await expect(dlg.locator('.mcp-prov[data-harness="codex"] .mcp-state')).toHaveText('Stale');
  await expect(dlg.locator('.mcp-status--ok')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await faceScreen(page);
  await expect.poll(async () => (await mcp(page)).screen?.lines ?? []).toEqual(expect.arrayContaining(['stale', 'Couldn’t read']));
  expect((await mcp(page)).screen?.tones.map((t) => t.ink)).toEqual(['text', 'grey']);
  // The read comes good again: Refresh shows it fresh.
  await page.evaluate(() => window.__h3d.simMcp('sim.mcp', { stale: null, fail: null }));
  await openPage(page);
  await page.locator('[data-key="refresh"]').click();
  await expect.poll(async () => (await mcp(page)).page.providers.map((x) => x.tone)).toEqual(['ok', 'ok']);
  clean();
});

test('switching the Codex profile while a slow reply for the old one is out: the late reply is dropped', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onLab(page, `${SIM}&simcodexprofiles=2`);
  await page.evaluate(() => window.__h3d.simMcp('sim.mcp', { delay: { codex_profile: 'work', ms: 3000 } }));
  await openPage(page);
  const prof = page.locator('#mcp-profile');
  await expect(prof).toBeVisible();
  await prof.selectOption('work');
  await expect.poll(async () => (await mcp(page)).page.state).toBe('loading');
  await prof.selectOption('spare');
  await expect.poll(async () => (await mcp(page)).page.context?.codex_profile).toBe('spare');
  expect((await mcp(page)).page.rows.every((r) => r.codex !== 'Configured')).toBe(true); // spare has no servers
  // work's reply arrives 3 s later: dropped, the page stays on spare.
  await expect.poll(async () => (await sent(page)).find((s) => s.profile === 'work')?.result, { timeout: 10_000 }).toBe('dropped');
  await page.waitForTimeout(300);
  expect((await mcp(page)).page.context?.codex_profile).toBe('spare');
  await expect(prof).toHaveValue('spare');
  // The other checkout: user scope only, no project servers.
  await page.locator('#mcp-cwd').selectOption({ label: 'User scope only (no project)' });
  await expect.poll(async () => (await mcp(page)).page.context?.cwd).toBeNull();
  expect((await mcp(page)).page.rows.map((r) => r.name)).not.toContain('linear');
  clean();
});

test('an old bridge: the calm "No MCP inventory on this bridge", on the wall and the page; never asked again', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onLab(page, `${SIM}&simfail=no_mcp`);
  await faceScreen(page);
  await expect.poll(async () => (await mcp(page)).screen?.mode, { timeout: 15_000 }).toBe('unsupported');
  await expect(page.locator('.prompt')).toContainText('No MCP inventory on this bridge');
  await page.waitForTimeout(800);
  expect((await sent(page)).map((s) => s.result)).toEqual(['unknown_command']);
  await page.evaluate(() => window.__h3d.openMcp());
  await expect(page.locator('dialog.mcp[open] .mcp-calm')).toContainText('Update herdr-world');
  clean();
});

test('works at 390 px: the providers and cells stack, nothing scrolls sideways', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await onLab(page);
  await faceScreen(page, 3.2);
  await expect.poll(async () => (await mcp(page)).screen?.mode, { timeout: 15_000 }).toBe('data');
  await shot(page, 'h196-wall-390');
  await openPage(page);
  await page.locator('[data-key="check-codex"]').click();
  await expect.poll(async () => (await mcp(page)).page.providers[1]?.check, { timeout: 10_000 }).toBe('ok');
  const box = await page.locator('dialog.mcp[open]').boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(390);
  const over = await page.evaluate(() => {
    const body = document.querySelector('dialog.mcp .sheet-body') as HTMLElement;
    const cells = [...document.querySelectorAll<HTMLElement>('dialog.mcp .mcp-prov')].map((e) => e.getBoundingClientRect());
    return { scroll: body.scrollWidth - body.clientWidth, stacked: cells.length === 2 && (cells[1]?.top ?? 0) > (cells[0]?.bottom ?? 0) - 1 };
  });
  expect(over).toEqual({ scroll: 0, stacked: true });
  await shot(page, 'h196-overview-390');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.mcp[open]')).toBeHidden();
});
