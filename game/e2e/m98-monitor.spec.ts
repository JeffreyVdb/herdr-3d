import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { frames, openGame, RESULTS, shot, watchErrors, openMenu, settingsSection } from './game';

// #98: the desk monitor shows what the agent is doing. demo-m5 with the simulating fixture server (sim=1): `sim.activity`
// (tools/fixture-activity.ts) gives a worker an activity, a status and an image as the bridge would send them. A
// working Claude's monitor shows the crab and "Testing" with its detail and counter, a Codex one the cloud; idle on its
// background tasks is WAITING (its own band row and HUD count, not idle, not in N); an image the agent looks at (a Claude
// Read of a png, Codex's view_image, a Codex code-mode exec calling tools.view_image) fills a near monitor; reduced
// motion holds the mascots still; the Terminal preference brings the glance back. perf-floor60 with every working agent
// labelled (`simactivity=all`): no canvas is drawn and no texture uploaded while the whole floor's cards animate.

const FLOOR = 'herdr-3d';
const SIM = 'play=none&sim=1&simms=500&simusage=0';

type Monitors = NonNullable<Awaited<ReturnType<typeof monitorsOf>>>;
type DeskInfo = Monitors['desks'][number];
const monitorsOf = (page: Page) => page.evaluate(() => window.__h3d.monitors());
const deskOf = async (page: Page, id: string): Promise<DeskInfo | null> => (await monitorsOf(page))?.desks.find((d) => d.id === id) ?? null;

async function open(page: Page, extra = '', ws = SIM): Promise<Record<string, { id: string; desk: number }>> {
  await openGame(page, 'demo-m5', extra, ws);
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const ws2 = await page.evaluate((s) => window.__h3d.world().find((f) => f.session === s)?.workers ?? [], FLOOR);
  return Object.fromEntries(ws2.map((w) => [w.name, { id: w.id, desk: w.desk }]));
}

const sim = async (page: Page, args: Record<string, unknown>) => {
  const r = await page.evaluate((a) => window.__h3d.simActivity(a), args);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r.data as { activity: { image?: { hash: string; w: number; h: number } } | null };
};

/**
 * Stands at a point of a desk’s slot space (default: beside the chair, clear of the worker’s head) and looks at its monitor's terminal
 * area. Slot space: the worker faces +z; a slot turned `yaw` maps (x, z) to (x cos + z sin, -x sin + z cos).
 */
async function lookAtMonitor(page: Page, desk: number, from: { x: number; z: number } = { x: 0.52, z: 0.12 }): Promise<void> {
  await page.evaluate(
    ([d, f]) => {
      const p = window.__h3d.pose();
      const L = window.__h3d.layout(window.__h3d.view().floor as string);
      const s = L?.slots[d as number];
      if (!p || !s) throw new Error('no pose');
      const fr = f as { x: number; z: number };
      const at = (x: number, z: number) => ({ x: s.seat.x + x * Math.cos(s.yaw) + z * Math.sin(s.yaw), z: s.seat.z - x * Math.sin(s.yaw) + z * Math.cos(s.yaw) });
      const c = at(fr.x, fr.z);
      // The monitor's terminal area: a little under the panel's centre (deskKit.ts MONITOR), on the desk's far side.
      const t = at(0, 0.78);
      const dx = t.x - c.x;
      const dz = t.z - c.z;
      window.__h3d.setPose({ x: c.x, z: c.z, yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(1.03 - p.eye, Math.hypot(dx, dz)) });
    },
    [desk, from] as const,
  );
  await frames(page, 4);
}

/** A part of the monitor's terminal area on the page (0–1 of its bounding box across and down), as a screenshot clip. */
async function areaClip(page: Page, id: string, u0 = 0, u1 = 1, v0 = 0, v1 = 1): Promise<{ x: number; y: number; width: number; height: number }> {
  const r = await page.evaluate((i) => window.__h3d.monitorRect(i), id);
  expect(r, 'the monitor is on screen').not.toBeNull();
  const b = r as { left: number; top: number; width: number; height: number };
  return { x: Math.round(b.left + b.width * u0), y: Math.round(b.top + b.height * v0), width: Math.max(1, Math.round(b.width * (u1 - u0))), height: Math.max(1, Math.round(b.height * (v1 - v0))) };
}

/** Share of differing pixels between two PNG screenshots of the same size. */
function changed(a: Buffer, b: Buffer): number {
  const x = PNG.sync.read(a);
  const y = PNG.sync.read(b);
  let n = 0;
  for (let i = 0; i < x.data.length; i += 4) if (Math.abs((x.data[i] ?? 0) - (y.data[i] ?? 0)) + Math.abs((x.data[i + 1] ?? 0) - (y.data[i + 1] ?? 0)) + Math.abs((x.data[i + 2] ?? 0) - (y.data[i + 2] ?? 0)) > 24) n++;
  return n / (x.data.length / 4);
}

test('a working agent’s monitor shows what it is doing: the crab for Claude, the cloud for Codex, the word, the detail, the time', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const w = await open(page);
  const nibble = w.Nibble as { id: string; desk: number };
  const pixel = w.Pixel as { id: string; desk: number };
  await sim(page, { id: nibble.id, activity: { kind: 'testing', detail: 'pytest -n auto', since: Date.now() - 83_000 } });
  await sim(page, { id: pixel.id, activity: { kind: 'thinking' } });
  await expect.poll(async () => (await deskOf(page, nibble.id))?.word).toBe('Testing');
  const n = (await deskOf(page, nibble.id)) as DeskInfo;
  expect(n).toMatchObject({ mode: 'card', pose: 'testing', detail: 'pytest -n auto', badge: null });
  expect(n.timer).toMatch(/^1:2\d$/);
  await expect.poll(async () => (await deskOf(page, pixel.id))?.pose).toBe('thinking');
  expect(await deskOf(page, pixel.id)).toMatchObject({ mode: 'card', word: 'Thinking', detail: '' });
  // The status bar stays as it was.
  expect((await page.evaluate((d) => window.__h3d.deskArt(d), nibble.desk))?.band).toBe('working');
  // The card replaces the glance: the covered desks' terminals are not watched.
  await lookAtMonitor(page, nibble.desk);
  await frames(page, 6);
  const s = await page.evaluate(() => window.__h3d.screens());
  expect(s.find((x) => x.id === nibble.id)?.fps).toBeNull();
  await shot(page, 'm98-card-claude');
  // The counter ticks (once a second, no canvas drawn for it).
  const t0 = (await deskOf(page, nibble.id))?.timer;
  await expect.poll(async () => (await deskOf(page, nibble.id))?.timer, { timeout: 5000 }).not.toBe(t0);
  await lookAtMonitor(page, pixel.desk);
  await shot(page, 'm98-card-codex');

  // An unknown kind is Working; the label cleared and the worker done: the crab rests.
  await sim(page, { id: nibble.id, activity: { kind: 'juggling', detail: 'make juggle' } });
  await expect.poll(async () => (await deskOf(page, nibble.id))?.word).toBe('Working');
  await sim(page, { id: nibble.id, status: 'done', activity: null });
  await expect.poll(async () => (await deskOf(page, nibble.id))?.mode).toBe('rest');
  expect(await deskOf(page, nibble.id)).toMatchObject({ pose: 'rest', word: 'All done' });
  // Working with no activity (an older bridge, no transcript): the terminal glance as before.
  await sim(page, { id: nibble.id, status: 'working', activity: null });
  await expect.poll(async () => (await deskOf(page, nibble.id))?.mode).toBe('glance');
  // A plain shell keeps its terminal whatever it does.
  const sprout = w.Sprout as { id: string };
  expect((await deskOf(page, sprout.id))?.mode).toBe('glance');
  clean();
});

test('waiting on its background tasks: the WAITING band, its own HUD count, not idle, not in N, what it waits on as a badge', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const w = await open(page);
  const pebble = w.Pebble as { id: string; desk: number };
  const idleBefore = Number(await page.locator('.topbar-counts .count--idle b').textContent());
  await expect(page.locator('.topbar-counts .count--waiting')).toHaveCount(0);
  await sim(page, { id: pebble.id, status: 'idle', activity: { kind: 'waiting', detail: 'Testing in the background', tasks: 2, source: 'derived', since: Date.now() - 125_000 } });
  await expect(page.locator('.topbar-counts .count--waiting')).toHaveAttribute('title', '1 waiting on their background tasks');
  await expect(page.locator('.topbar-counts .count--waiting b')).toHaveText('1');
  await expect(page.locator('.topbar-counts .count--idle b')).toHaveText(String(idleBefore - 1));
  expect((await page.evaluate((d) => window.__h3d.deskArt(d), pebble.desk))?.band).toBe('waiting');
  expect(await page.evaluate(() => window.__h3d.needs().map((x) => x.name))).not.toContain('Pebble');
  await expect.poll(async () => (await deskOf(page, pebble.id))?.badge).toBe('Testing in the background · 2 tasks');
  expect(await deskOf(page, pebble.id)).toMatchObject({ mode: 'card', pose: 'waiting', word: 'Waiting' });
  expect((await deskOf(page, pebble.id))?.timer).toMatch(/^2:0\d$/);
  await lookAtMonitor(page, pebble.desk);
  await shot(page, 'm98-waiting');
  // The tasks report back: plain idle again (the crab rests), back in the idle count.
  await sim(page, { id: pebble.id, activity: null });
  await expect(page.locator('.topbar-counts .count--waiting')).toHaveCount(0);
  await expect(page.locator('.topbar-counts .count--idle b')).toHaveText(String(idleBefore));
  await expect.poll(async () => (await deskOf(page, pebble.id))?.mode).toBe('rest');
  expect((await page.evaluate((d) => window.__h3d.deskArt(d), pebble.desk))?.band).toBe('idle');
  clean();
});

for (const c of [
  { name: 'a Claude Read of a png', worker: 'Nibble', via: 'read', seed: 51, w: 1280, h: 800, caption: 'needs-you-desk.png' },
  { name: 'Codex’s view_image', worker: 'Pixel', via: 'view_image', seed: 52, w: 900, h: 900, caption: 'monitor-card.png' },
  { name: 'a Codex code-mode exec calling tools.view_image', worker: 'Pip', via: 'exec', seed: 53, w: 1600, h: 600, caption: 'waiting-band.png' },
] as const) {
  test(`the image the agent looks at fills a near monitor, letterboxed with its name: ${c.name}`, async ({ page }) => {
    test.setTimeout(150_000);
    const clean = watchErrors(page);
    const w = await open(page);
    const me = w[c.worker] as { id: string; desk: number };
    await lookAtMonitor(page, me.desk);
    const r = await sim(page, { id: me.id, image: { seed: c.seed, w: c.w, h: c.h, via: c.via } });
    expect(r.activity?.image?.hash).toMatch(/^[0-9a-f]{64}$/);
    await expect.poll(async () => (await deskOf(page, me.id))?.image, { timeout: 15_000 }).toBe('shown');
    const d = (await deskOf(page, me.id)) as DeskInfo;
    expect(d).toMatchObject({ mode: 'image', word: 'Looking at an image', detail: c.caption });
    expect(d.aspect).toBeCloseTo(c.w / c.h, 1);
    // Fetched by hash for this desk only, through the existing command; no transcript watch needed.
    const log = await page.evaluate(() => window.__h3d.watchLog());
    const asked = log.filter((x) => x.t === 'transcript.image').map((x) => x.args as { id: string; hash: string; size: string });
    expect(asked).toContainEqual({ id: me.id, hash: r.activity?.image?.hash, size: 'thumb' });
    await frames(page, 4);
    if (c.via === 'read') await shot(page, 'm98-image');
    const st = (await monitorsOf(page))?.stats;
    expect(st?.alive).toBe(2);
    // The label moves on: the image goes, its textures disposed and its bitmap closed.
    await sim(page, { id: me.id, activity: { kind: 'writing', detail: 'card.ts' } });
    await expect.poll(async () => (await monitorsOf(page))?.stats?.alive).toBe(0);
    expect((await monitorsOf(page))?.stats?.ledger).toMatchObject({ created: 2, disposed: 2, closed: 1 });
    expect((await deskOf(page, me.id))?.word).toBe('Writing');
    clean();
  });
}

test('far desks say "Looking at an image"; a fetch that fails says the same, never a broken texture', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const w = await open(page);
  const near = w.Bean as { id: string; desk: number };
  const far = w.Fidget as { id: string; desk: number };
  await lookAtMonitor(page, near.desk);
  await sim(page, { id: far.id, image: { seed: 61 } });
  // An image whose bytes the bridge will not serve (not this worker's current image: a made-up hash).
  await sim(page, { id: near.id, activity: { kind: 'image', detail: 'gone.png', image: { hash: 'f'.repeat(64), w: 640, h: 400 } } });
  await expect.poll(async () => (await deskOf(page, near.id))?.image, { timeout: 15_000 }).toBe('failed');
  expect(await deskOf(page, near.id)).toMatchObject({ mode: 'image', word: 'Looking at an image', pose: 'image', detail: 'gone.png' });
  expect(await deskOf(page, far.id)).toMatchObject({ mode: 'image', image: 'far', word: 'Looking at an image' });
  expect((await monitorsOf(page))?.stats?.alive).toBe(0);
  const log = await page.evaluate(() => window.__h3d.watchLog());
  expect(log.filter((x) => x.t === 'transcript.image' && (x.args as { id: string }).id === far.id)).toEqual([]);
  await shot(page, 'm98-image-failed');
  clean();
});

test('prefers-reduced-motion holds every mascot on its first frame; with motion they move', async ({ browser }) => {
  test.setTimeout(150_000);
  const run = async (reduced: boolean): Promise<number> => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    const page = await ctx.newPage();
    // Hold the elapsed counter and daylight fixed while rAF keeps driving the mascot shader. A perspective crop
    // can include a few counter pixels; their clock must not look like reduced-motion animation.
    await page.clock.setFixedTime(new Date('2026-10-20T12:00:00Z'));
    const clean = watchErrors(page);
    const w = await open(page);
    const nibble = w.Nibble as { id: string; desk: number };
    await sim(page, { id: nibble.id, activity: { kind: 'writing', detail: 'store.ts' } });
    await expect.poll(async () => (await deskOf(page, nibble.id))?.word).toBe('Writing');
    expect((await monitorsOf(page))?.stats?.motion).toBe(!reduced);
    await lookAtMonitor(page, nibble.desk, { x: 0.45, z: 0.3 });
    await frames(page, 4);
    // The mascot's part only (the counter on the right ticks either way), clear of the bezel.
    const clip = await areaClip(page, nibble.id, 0.08, 0.36, 0.12, 0.88);
    let most = 0;
    const first = await page.screenshot({ clip });
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(300);
      await frames(page, 2);
      most = Math.max(most, changed(first, await page.screenshot({ clip })));
    }
    mkdirSync(RESULTS, { recursive: true });
    writeFileSync(resolve(RESULTS, `m98-${reduced ? 'reduced' : 'full'}-motion.png`), first);
    console.log(`m98 motion (${reduced ? 'reduced' : 'full'}): ${(most * 100).toFixed(2)} % of the mascot's pixels changed`);
    clean();
    await ctx.close();
    return most;
  };
  expect(await run(true)).toBe(0);
  expect(await run(false)).toBeGreaterThan(0.01);
});

test('Settings → Display → Desk monitors: Terminal brings the glance back everywhere, Activity the cards; it is remembered', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const w = await open(page);
  const nibble = w.Nibble as { id: string; desk: number };
  await sim(page, { id: nibble.id, activity: { kind: 'testing', detail: 'go test ./...' } });
  await expect.poll(async () => (await deskOf(page, nibble.id))?.mode).toBe('card');
  await lookAtMonitor(page, nibble.desk);
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const pick = (await settingsSection(page, 'display')).getByLabel('Desk monitors'); // #49: one section at a time
  await expect(pick).toHaveValue('activity');
  await expect(dialog.locator('#settings-monitors-hint')).toHaveText('Sitting at a desk always shows its screen.');
  await shot(page, 'm98-settings');
  await pick.selectOption('terminal');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await monitorsOf(page))?.desks.every((d) => d.mode === 'glance')).toBe(true);
  // The glance is back: the terminal near you is watched and painted again.
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.screens())).find((x) => x.id === nibble.id)?.state, { timeout: 15_000 }).toBe('live');
  expect(await page.evaluate(() => localStorage.getItem('h3d.monitors'))).toBe('terminal');
  await page.reload();
  await page.waitForFunction(() => window.__h3d?.ready && window.__h3d.frames >= 3, undefined, { timeout: 60_000 });
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  await expect.poll(async () => (await monitorsOf(page))?.desks.length ?? 0).toBeGreaterThan(0);
  expect((await monitorsOf(page))?.desks.every((d) => d.mode === 'glance')).toBe(true);
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await (await settingsSection(page, 'display')).getByLabel('Desk monitors').selectOption('activity');
  await page.keyboard.press('Escape');
  // Back to the cards: the done and idle Claude and Codex workers rest.
  await expect.poll(async () => (await monitorsOf(page))?.desks.filter((d) => d.mode === 'rest').length ?? 0).toBeGreaterThan(0);
  expect(await page.evaluate(() => localStorage.getItem('h3d.monitors'))).toBeNull();
  clean();
});

test('a floor of 60 desks animates every card with no canvas drawn and no texture uploaded; one mesh for all of them', async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  // Count every 2D canvas draw on the page.
  await page.addInitScript(() => {
    const w = window as unknown as { __draws: number };
    w.__draws = 0;
    const P = CanvasRenderingContext2D.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const k of ['fillText', 'strokeText', 'drawImage', 'putImageData', 'fillRect']) {
      const orig = P[k] as (...a: unknown[]) => unknown;
      P[k] = function (this: unknown, ...a: unknown[]) {
        w.__draws++;
        return orig.apply(this, a);
      };
    }
  });
  await openGame(page, 'perf-floor60', '&screens=0', 'play=none&sim=1&simusage=0&simactivity=all');
  const floor = await page.evaluate(() => window.__h3d.world()[0]?.session as string);
  await page.evaluate((s) => window.__h3d.enterFloor(s), floor);
  await frames(page, 6);
  await expect.poll(async () => (await monitorsOf(page))?.desks.filter((d) => d.mode === 'card').length ?? 0).toBeGreaterThanOrEqual(30);
  const m = (await monitorsOf(page)) as Monitors;
  const cards = m.desks.filter((d) => d.mode !== 'glance').length;
  // A row of desks in view, from behind one of them.
  await lookAtMonitor(page, (m.desks.find((d) => d.mode === 'card') as DeskInfo).desk, { x: 1.6, z: -1.6 });
  // Let the first upload of the text cells go, then watch: ~3 s of frames.
  await page.waitForTimeout(800);
  await frames(page, 4);
  const before = await page.evaluate(() => ({ draws: (window as unknown as { __draws: number }).__draws, frames: window.__h3d.frames, m: window.__h3d.monitors()?.stats }));
  await page.waitForTimeout(3000);
  await frames(page, 10);
  const after = await page.evaluate(() => ({ draws: (window as unknown as { __draws: number }).__draws, frames: window.__h3d.frames, m: window.__h3d.monitors()?.stats }));
  const drawn = after.frames - before.frames;
  console.log(`m98 ledger: ${cards} cards, ${drawn} frames, canvas draws ${after.draws - before.draws}, cells ${after.m?.ledger.cells} (+${(after.m?.ledger.cells ?? 0) - (before.m?.ledger.cells ?? 0)}), uploads +${(after.m?.ledger.uploads ?? 0) - (before.m?.ledger.uploads ?? 0)}, counter writes +${(after.m?.ledger.timerWrites ?? 0) - (before.m?.ledger.timerWrites ?? 0)}`);
  expect(drawn).toBeGreaterThan(10);
  expect(after.m?.ledger.cells).toBe(before.m?.ledger.cells);
  expect(after.m?.ledger.uploads).toBe(before.m?.ledger.uploads);
  expect(after.m?.textures).toEqual(before.m?.textures);
  // Nothing else on the page draws a canvas meanwhile either (the clock draws once a minute at most).
  expect(after.draws - before.draws).toBeLessThanOrEqual(40);
  // One instanced draw for every card; with the Terminal preference (no cards) not even that.
  expect(after.m?.meshes).toBe(1);
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await (await settingsSection(page, 'display')).getByLabel('Desk monitors').selectOption('terminal');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await monitorsOf(page))?.desks.every((d) => d.mode === 'glance')).toBe(true);
  await frames(page, 4);
  expect((await monitorsOf(page))?.stats?.meshes).toBe(0);
  clean();
});

// #42: the draw-call and frame-time bench of the same floor (the ledger, the canvas draws and the one mesh are checked above).
test('bench: the cards of a 60-desk floor cost a draw or two and stay in the frame budget (Activity against Terminal)', { tag: '@perf' }, async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  await openGame(page, 'perf-floor60', '&screens=0', 'play=none&sim=1&simusage=0&simactivity=all');
  const floor = await page.evaluate(() => window.__h3d.world()[0]?.session as string);
  await page.evaluate((s) => window.__h3d.enterFloor(s), floor);
  await frames(page, 6);
  await expect.poll(async () => (await monitorsOf(page))?.desks.filter((d) => d.mode === 'card').length ?? 0).toBeGreaterThanOrEqual(30);
  const m = (await monitorsOf(page)) as Monitors;
  await lookAtMonitor(page, (m.desks.find((d) => d.mode === 'card') as DeskInfo).desk, { x: 1.6, z: -1.6 });
  await page.waitForTimeout(800);
  await frames(page, 4);
  await shot(page, 'm98-perf-floor60');
  const bench = () => page.evaluate(() => window.__h3d.bench({ frames: 8, warm: 3, pipelined: false, raf: false }));
  const on = await bench();
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await (await settingsSection(page, 'display')).getByLabel('Desk monitors').selectOption('terminal');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await monitorsOf(page))?.desks.every((d) => d.mode === 'glance')).toBe(true);
  await frames(page, 4);
  const off = await bench();
  console.log(`m98 perf: ${on.drawCalls} draw calls with the cards (frame ${on.frameMs.med} ms), ${off.drawCalls} without (frame ${off.frameMs.med} ms)`);
  expect((await monitorsOf(page))?.stats?.meshes).toBe(0);
  // The rest of the frame moves a little between benches (cards, walks): loose, the cards cost no more than a draw or two.
  expect(on.drawCalls).toBeLessThanOrEqual(off.drawCalls + 3);
  expect(on.frameMs.med).toBeLessThan(off.frameMs.med * 1.5 + 5);
  clean();
});
