import { expect, test, type Page } from '@playwright/test';
import { frames, leftInTerminal, openGame, watchErrors } from './game';

// #52 on demo-m4 with the simulator (sim=1): herdr-3d is the top floor of Work (20 desks). A laptop's glass shows the
// screen of whoever sits at that desk now, or nothing (its glow, or a pending screen) until that screen has a frame:
// never the previous worker's or the previous pane's. `sim.swap` plays herdr changing what is under a desk in one
// observation (a new worker at the desk, or a new pane under the same worker), with the new pane's first frame held back;
// `screenTrace` records every desk's glass at every rendered frame in between.

// #98: the monitors show their terminals, not the activity cards.
// A small window: software GL draws it fast enough that several frames fall within one 250 ms plan of the screens.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('h3d.monitors', 'terminal'));
  await page.setViewportSize({ width: 480, height: 320 });
});

type Layout = NonNullable<ReturnType<Window['__h3d']['layout']>>;
type Screen = ReturnType<Window['__h3d']['screens']>[number];
type Trace = ReturnType<Window['__h3d']['screenTrace']>;

const FLOOR = 'herdr-3d';
/** How long the new pane's first frame is held back: the interim the glass must keep blank. */
const HOLD = 1500;

async function enter(page: Page, query = ''): Promise<Layout> {
  await openGame(page, 'demo-m4', query, 'play=none&sim=1&simms=150');
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const L = await page.evaluate((s) => window.__h3d.layout(s), FLOOR);
  if (!L) throw new Error('no layout');
  return L;
}

async function look(page: Page, x: number, z: number, tx: number, ty: number, tz: number): Promise<void> {
  const p = await page.evaluate(() => window.__h3d.pose());
  if (!p) throw new Error('not walking');
  const yaw = Math.atan2(-(tx - x), -(tz - z));
  const pitch = Math.atan2(ty - p.eye, Math.hypot(tx - x, tz - z));
  await page.evaluate(([yy, pp, xx, zz]) => window.__h3d.setPose({ x: xx, z: zz, yaw: yy, pitch: pp }), [yaw, pitch, x, z] as const);
  await frames(page, 2);
}

/** From behind a desk's chair, close enough to sit. */
async function faceDesk(page: Page, L: Layout, desk: number): Promise<void> {
  const s = L.slots[desk];
  if (!s) throw new Error(`no desk ${desk}`);
  await look(page, s.seat.x - Math.sin(s.yaw) * 1.4, s.seat.z - Math.cos(s.yaw) * 1.4, s.seat.x, 0.95, s.seat.z);
}

const screens = (page: Page) => page.evaluate(() => window.__h3d.screens());
const atDesk = async (page: Page, desk: number) => (await screens(page)).find((s) => s.desk === desk);

/** A desk of the south pod whose laptop is live (looking into the pod from the lobby side). */
async function liveDesk(page: Page, L: Layout): Promise<Screen> {
  await look(page, L.width / 2, L.depth - 4.3, L.width / 2, 0.8, L.depth - 7.5);
  await expect.poll(async () => (await screens(page)).filter((s) => s.state === 'live').length, { timeout: 15_000 }).toBeGreaterThan(0);
  const live = (await screens(page)).find((s) => s.state === 'live' && s.shows === `${s.id}@${s.pane}`);
  if (!live) throw new Error('no live laptop shows its own screen');
  return live;
}

async function swap(page: Page, args: Record<string, unknown>): Promise<{ id: string; pane: string }> {
  const r = await page.evaluate((a) => window.__h3d.simSwap(a), args);
  expect(r.ok).toBe(true);
  return r.data as { id: string; pane: string };
}

/** Every desk at every recorded frame: its glass shows nothing, or the screen of the worker and pane there now. */
function expectOwnScreens(trace: Trace): void {
  expect(trace.length).toBeGreaterThan(10);
  const wrong = trace.flatMap((t) => t.screens.filter((s) => s.shows !== null && s.shows !== `${s.id}@${s.pane}`).map((s) => ({ frame: t.frame, desk: s.desk, worker: `${s.id}@${s.pane}`, shows: s.shows, state: s.state })));
  expect(wrong.slice(0, 5)).toEqual([]);
}

/** The desk's samples from the first frame `who` sits there. */
const deskFrom = (trace: Trace, desk: number, who: { id: string; pane: string }) => {
  const all = trace.map((t) => t.screens.find((s) => s.desk === desk));
  const i = all.findIndex((s) => s?.id === who.id && s.pane === who.pane);
  return i < 0 ? [] : all.slice(i);
};

for (const name of [null, 'Zephyr']) {
  test(`a new worker at a reused desk (${name ? 'another name' : 'the same name'}) shows a blank screen until its own, never the old one's`, async ({ page }) => {
    test.setTimeout(90_000);
    const clean = watchErrors(page);
    const L = await enter(page);
    let at = await liveDesk(page, L);
    const rebuilds = await page.evaluate(() => window.__h3d.officeRebuilds());
    // A few times over: the old screen could only show between two plans of the screens (250 ms), so one swap may miss it.
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.__h3d.screenTrace(true));
      const now = await swap(page, { id: at.id, hold: HOLD, ...(name ? { name: `${name}${'abc'[i]}` } : {}) });
      expect(now.id).not.toBe(at.id);
      await expect.poll(() => atDesk(page, at.desk).then((s) => s?.shows), { timeout: 15_000 }).toBe(`${now.id}@${now.pane}`);
      const trace = await page.evaluate(() => window.__h3d.screenTrace(false));
      expectOwnScreens(trace);
      const desk = deskFrom(trace, at.desk, now);
      // From its first frame at the desk: blank while its screen is on its way (watched, nothing yet), then its own.
      expect(desk[0]?.shows).toBeNull();
      expect(desk.some((s) => s?.state === 'pending' && s.shows === null)).toBe(true);
      expect(desk.at(-1)?.state).toBe('live');
      at = { ...at, id: now.id, pane: now.pane };
    }
    // The office seated the new workers in place.
    expect(await page.evaluate(() => window.__h3d.officeRebuilds())).toBe(rebuilds);
    clean();
  });
}

test('sitting down at the new worker of a reused desk: blank until its first frame, then its own screen', async ({ page }) => {
  test.setTimeout(90_000);
  const clean = watchErrors(page);
  const L = await enter(page);
  const old = await liveDesk(page, L);
  await faceDesk(page, L, old.desk);
  await page.evaluate(() => window.__h3d.screenTrace(true));
  const now = await swap(page, { id: old.id, hold: HOLD });
  await leftInTerminal(page, now.id); // #98: the terminal, not the conversation
  await expect.poll(() => page.evaluate((id) => window.__h3d.sitAt(id), now.id)).toBe(true);
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(now.id);
  await expect.poll(() => atDesk(page, old.desk).then((s) => s?.shows), { timeout: 15_000 }).toBe(`${now.id}@${now.pane}`);
  const trace = await page.evaluate(() => window.__h3d.screenTrace(false));
  expectOwnScreens(trace);
  const desk = deskFrom(trace, old.desk, now);
  expect(desk.some((s) => s?.state === 'pending' && s.shows === null)).toBe(true);
  expect(desk.at(-1)?.state).toBe('live');
  clean();
});

test('a new pane under the same worker (pane_changed): the old pane’s screen goes at once, the new one shows when it comes', async ({ page }) => {
  test.setTimeout(90_000);
  const clean = watchErrors(page);
  const L = await enter(page);
  const old = await liveDesk(page, L);
  await faceDesk(page, L, old.desk);
  await leftInTerminal(page, old.id);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), old.id)).toBe(true);
  await expect.poll(() => atDesk(page, old.desk).then((s) => s?.state)).toBe('live');
  await page.evaluate(() => window.__h3d.screenTrace(true));
  const now = await swap(page, { id: old.id, pane: true, hold: HOLD });
  expect(now.id).toBe(old.id);
  await expect.poll(() => atDesk(page, old.desk).then((s) => s?.shows), { timeout: 15_000 }).toBe(`${now.id}@${now.pane}`);
  const trace = await page.evaluate(() => window.__h3d.screenTrace(false));
  // Still seated at the same worker all along.
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(old.id);
  expectOwnScreens(trace);
  const desk = deskFrom(trace, old.desk, now);
  expect(desk[0]?.shows).toBeNull();
  expect(desk.some((s) => s?.state === 'pending' && s.shows === null)).toBe(true);
  expect(desk.at(-1)?.state).toBe('live');
  clean();
});

test('the same worker and pane: getting up keeps its last frame on the laptop (screens=0)', async ({ page }) => {
  const clean = watchErrors(page);
  const L = await enter(page, '&screens=0');
  const w = (await screens(page)).find((s) => s.desk === 0);
  if (!w) throw new Error('nobody at desk 0');
  await leftInTerminal(page, w.id);
  await faceDesk(page, L, 0);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  await expect.poll(() => atDesk(page, 0).then((s) => s?.state)).toBe('live');
  await frames(page, 3);
  await page.evaluate(() => window.__h3d.screenTrace(true));
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  await frames(page, 20);
  const trace = await page.evaluate(() => window.__h3d.screenTrace(false));
  expectOwnScreens(trace);
  expect(await atDesk(page, 0)).toMatchObject({ state: 'frozen', shows: `${w.id}@${w.pane}` });
  expect(await page.evaluate((id) => window.__h3d.frozenInk(id), w.id)).toBeGreaterThan(0.005);
  clean();
});
