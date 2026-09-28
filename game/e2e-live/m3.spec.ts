import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { LiveBridge } from '../tools/live-bridge.ts';

// Run through tools/live-m3.ts (`pnpm test:live:m3`), which owns the throwaway
// herdr session h3d-m3game-<random> and the WS proxy. This spec owns the
// private bridge, so it can restart it. The buildings test passes on the M2
// bridge too; the sleep/wake test needs floor.wake / floor.sleep and skips on
// a bridge that answers unknown_command.
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} unset: run via \`pnpm test:live:m3\``);
  return v;
};

test.describe.configure({ mode: 'serial' });

const session = env('H3D_LIVE_SESSION');
const labels = JSON.parse(env('H3D_LIVE_LABELS')) as string[];
const bridge = new LiveBridge({
  bin: env('H3D_LIVE_BRIDGE_BIN'),
  socket: env('H3D_LIVE_SOCKET'),
  db: env('H3D_LIVE_DB'),
  session,
  log: join(env('H3D_LIVE_OUT'), 'bridge.log'),
});

test.beforeAll(async () => {
  await bridge.start();
});
test.afterAll(async () => {
  await bridge.stop();
});

/** One command over a fresh connection (not the game's): the bridge's answer. */
function command(t: string, args: object): Promise<{ t: string; code?: string; message?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(env('H3D_LIVE_WS'));
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`no answer to ${t}`));
    }, 30_000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', proto: 1, client: 'h3d-live-m3' }));
      ws.send(JSON.stringify({ t, req_id: 'probe', args }));
    });
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as { t: string; req_id?: string; code?: string; message?: string };
      if (m.req_id !== 'probe') return;
      clearTimeout(timer);
      ws.close();
      resolve(m);
    });
    ws.on('error', reject);
  });
}

async function open(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/?backend=webgl2&ws=${encodeURIComponent(env('H3D_LIVE_WS'))}`);
  await page.waitForFunction(
    ([s, want]) => {
      const f = window.__h3d.world().find((x) => x.session === s);
      return !!f && want.every((l) => f.workers.some((w) => w.label === l));
    },
    [session, labels] as const,
    { timeout: 30_000 },
  );
  test.info().annotations.push({ type: 'page errors', description: JSON.stringify(errors) });
}

const floorOf = (page: Page) => page.evaluate((s) => window.__h3d.world().find((f) => f.session === s) ?? null, session);
const seats = async (page: Page) => Object.fromEntries((await floorOf(page))?.workers.map((w) => [w.id, w.desk]) ?? []);

test('buildings made in the game survive a bridge restart', async ({ page }) => {
  await open(page);
  expect((await floorOf(page))?.building).toBeNull();
  const name = `Live ${session.slice(-4)}`;

  await page.keyboard.press('m');
  await expect(page.locator('#dir-new-name')).toBeFocused();
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await expect(page.locator('dialog.panel .dir-bname', { hasText: name })).toBeVisible();
  const id = await page.evaluate((n) => {
    const p = window.__h3d.panel();
    return p?.kind === 'buildings' ? (p.buildings.find((b) => b.name === n)?.id ?? null) : null;
  }, name);
  if (!id) throw new Error('building not listed');

  await page.locator(`dialog.panel [data-key="move:${session}"]`).focus();
  await page.keyboard.press('Enter');
  await page.locator(`dialog.panel [data-key="to:${session}:${id}"]`).focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await floorOf(page))?.building, { timeout: 10_000 }).toBe(name);
  await page.keyboard.press('Escape');

  const before = await page.evaluate(() => window.__h3d.connection().epoch);
  await bridge.restart();
  await page.waitForFunction((e) => {
    const c = window.__h3d.connection();
    return c.phase === 'live' && c.epoch !== null && c.epoch !== e;
  }, before, { timeout: 30_000 });
  // A fresh snapshot from the restarted bridge, read from its database.
  await expect.poll(async () => (await floorOf(page))?.building, { timeout: 10_000 }).toBe(name);
  await page.evaluate(() => window.__h3d.openBuildings());
  const p = await page.evaluate(() => window.__h3d.panel());
  expect(p?.kind === 'buildings' && p.buildings.find((b) => b.id === id)?.floors).toEqual([session]);
});

test('sleep puts the workers to sleep at their desks, wake brings them back to the same desks', async ({ page }) => {
  test.setTimeout(240_000);
  // Waking a running floor is refused without touching it: invalid_state on
  // an M3 bridge, unknown_command on an older one.
  const probe = await command('floor.wake', { session });
  if (probe.code === 'unknown_command') {
    const why = `this bridge has no floor.wake yet (${probe.message ?? ''}); run with an M3 bridge: H3D_LIVE_BRIDGE=<path>`;
    console.log(`live-m3: SKIP sleep/wake: ${why}`);
    test.skip(true, why);
  }
  expect(probe).toMatchObject({ t: 'error', code: 'invalid_state' });

  await open(page);
  await page.evaluate((s) => window.__h3d.enterFloor(s), session);
  const seated = await seats(page);
  expect(Object.keys(seated)).toHaveLength(labels.length);
  await page.evaluate(() => window.__h3d.openElevator());

  await page.getByRole('button', { name: `Sleep floor ${session}` }).click();
  await expect(page.locator('dialog.confirm h2')).toHaveText(`Put ${session} to sleep?`);
  await page.locator('dialog.confirm').getByRole('button', { name: 'Sleep floor' }).click();
  await expect.poll(async () => (await floorOf(page))?.asleep, { timeout: 60_000 }).toBe(true);
  expect(await page.evaluate(() => window.__h3d.view())).toMatchObject({ mode: 'floor', floor: session, asleep: true });
  expect(await seats(page)).toEqual(seated);
  await expect(page.locator('dialog.panel .panel-status[role="status"]')).toHaveText(`${session} is asleep. Its agents resume when you wake it.`, { timeout: 30_000 });

  await page.getByRole('button', { name: `Wake floor ${session}` }).click();
  await expect.poll(async () => (await floorOf(page))?.asleep, { timeout: 90_000 }).toBe(false);
  await expect(page.locator('dialog.panel .panel-status[role="status"]')).toHaveText(new RegExp(`^${session} is awake`), { timeout: 90_000 });
  expect(await page.evaluate(() => window.__h3d.view())).toMatchObject({ floor: session, asleep: false });
  await expect.poll(() => seats(page), { timeout: 15_000 }).toEqual(seated);
});

test('floor settings saved from the panel are stored by the bridge and survive a restart', async ({ page }) => {
  // An empty patch changes nothing: ack on an M3 bridge, unknown_command before.
  const probe = await command('floor.settings.set', { session });
  if (probe.code === 'unknown_command') {
    const why = `this bridge has no floor.settings.set yet (${probe.message ?? ''})`;
    console.log(`live-m3: SKIP settings: ${why}`);
    test.skip(true, why);
  }
  expect(probe).toMatchObject({ t: 'ack' });

  await open(page);
  const cwd = env('H3D_LIVE_CWD');
  await page.evaluate((s) => window.__h3d.openSettings(s), session);
  await page.locator('#set-repo').fill('JeffreyVdb/herdr-3d');
  await page.locator('#set-projectOwner').fill('JeffreyVdb');
  await page.locator('#set-projectNumber').fill('3');
  await page.locator('#set-defaultCwd').fill(cwd);
  await page.locator('#set-harness').selectOption('claude');
  await page.locator('#set-model').selectOption('claude-opus-5-5');
  await page.locator('#set-effort').selectOption('high');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('dialog.panel .panel-status[role="status"]')).toHaveText('Saved the repo, project, status field, default folder, default hire.');
  const want = {
    repo: 'JeffreyVdb/herdr-3d',
    projectOwner: 'JeffreyVdb',
    projectNumber: '3',
    statusName: 'Status',
    statusOptions: 'Todo, Doing, QA, Done',
    defaultCwd: cwd,
    harness: 'claude',
    model: 'claude-opus-5-5',
    effort: 'high',
  };
  await page.keyboard.press('Escape');

  const before = await page.evaluate(() => window.__h3d.connection().epoch);
  await bridge.restart();
  await page.waitForFunction((e) => {
    const c = window.__h3d.connection();
    return c.phase === 'live' && c.epoch !== null && c.epoch !== e;
  }, before, { timeout: 30_000 });
  // Opened again after the restart, the form shows what the bridge stored.
  await page.evaluate((s) => window.__h3d.openSettings(s), session);
  const p = await page.evaluate(() => window.__h3d.panel());
  expect(p).toMatchObject({ kind: 'settings', session, repoSuggested: false, form: want });
});
