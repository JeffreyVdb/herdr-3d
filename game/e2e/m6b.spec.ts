import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, seatMode, shot, watchErrors } from './game';

// M6b on demo-m4 with the simulator (sim=1): hires drop in to their chairs instead of walking in, and every desk
// has a monitor (the live screen, big and in its glance view), a wireless keyboard and mouse, and a vertical dock
// on its pod's outer side with the worker's laptop in it, its sticker the worker's harness. herdr-3d (top floor,
// 20 desks, 5 and 12 empty): claude and codex workers; pastry (bottom, 16 desks, 14 and 15 empty).

const SIM = 'play=none&sim=1&simms=150';
type Layout = NonNullable<ReturnType<Window['__h3d']['layout']>>;

async function enter(page: Page, session: string): Promise<Layout> {
  await page.evaluate((s) => window.__h3d.enterFloor(s), session);
  await frames(page, 3);
  const L = await page.evaluate((s) => window.__h3d.layout(s), session);
  if (!L) throw new Error('no layout');
  return L;
}

/** Stands at (x, z) on this floor looking at (tx, ty, tz); `ty` is above this floor. */
async function look(page: Page, x: number, z: number, tx: number, ty: number, tz: number): Promise<void> {
  const p = await page.evaluate(() => window.__h3d.pose());
  if (!p) throw new Error('not walking');
  const yaw = Math.atan2(-(tx - x), -(tz - z));
  const pitch = Math.atan2(ty - p.eye, Math.hypot(tx - x, tz - z));
  await page.evaluate(([yy, pp, xx, zz]) => window.__h3d.setPose({ x: xx, z: zz, yaw: yy, pitch: pp }), [yaw, pitch, x, z] as const);
  await frames(page, 2);
}

/** Behind a desk's chair, facing its "+" (an empty desk) or the back of whoever sits there. */
async function faceDesk(page: Page, L: Layout, desk: number, back = 0.45, pitch = -0.28): Promise<void> {
  const s = L.slots[desk];
  if (!s) throw new Error(`no desk ${desk}`);
  const fx = Math.sin(s.yaw);
  const fz = Math.cos(s.yaw);
  await page.evaluate(([x, z, yaw, p]) => window.__h3d.setPose({ x, z, yaw, pitch: p }), [s.seat.x - fx * back, s.seat.z - fz * back, Math.atan2(-fx, -fz), pitch] as const);
  await frames(page, 2);
}

const liveIds = async (page: Page) => (await page.evaluate(() => window.__h3d.screens())).filter((s) => s.state === 'live').map((s) => s.id);

test('a hire drops in at an empty desk, and you sit at its screen while it lands, within a second of the hire', async ({ page }) => {
  test.setTimeout(90_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  const L = await enter(page, 'pastry');
  await faceDesk(page, L, 14);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'desk', id: 'desk-14' });
  await page.keyboard.press('e');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.dialog()))?.state, { timeout: 15_000 }).toBe('ready');
  // Slowed down, so the sitting happens while the drop still plays (it is only for looks).
  await page.evaluate(() => window.__h3d.arrivalRate(0.25));
  await page.locator('#hire-task').focus();
  await page.keyboard.press('Enter');
  // As soon as the hire lands in the world (the next frame): sit at the new worker's screen, as E does.
  const r = await page.evaluate(
    () =>
      new Promise<{ id: string; ok: boolean; dropping: boolean; phase: string | null; away: string | null; seated: string | null; ms: number } | null>((resolve) => {
        const t0 = performance.now();
        const tick = () => {
          const d = window.__h3d.desks()[14];
          if (d?.worker) {
            const t1 = performance.now();
            const ok = window.__h3d.sitAt(d.worker);
            const dropping = window.__h3d.deskArt(14)?.dropping ?? false;
            resolve({ id: d.worker, ok, dropping, phase: window.__h3d.arrivals().find((a) => a.desk === 14)?.phase ?? null, away: d.away, seated: window.__h3d.seated(), ms: performance.now() - t1 });
          } else if (performance.now() - t0 > 30_000) resolve(null);
          else requestAnimationFrame(tick);
        };
        tick();
      }),
  );
  expect(r).not.toBeNull();
  const got = r as NonNullable<typeof r>;
  expect(got).toMatchObject({ ok: true, dropping: true, phase: 'drop', away: null, seated: got.id });
  expect(got.ms).toBeLessThan(1000);
  // #98: a worker never sat at opens its conversation; the terminal is a Ctrl+Esc away.
  await seatMode(page, 'terminal');
  // Seated at its monitor: watched at the seated fps, the whole terminal on the monitor (not the glance view).
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.screens())).find((s) => s.id === got.id)?.fps, { timeout: 10_000 }).toBe(10);
  await expect.poll(async () => (await page.evaluate((id) => window.__h3d.screenMesh(id), got.id))?.glance, { timeout: 10_000 }).toBe(false);
  await page.evaluate(() => window.__h3d.arrivalRate(4));
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.arrivalLog())).find((l) => l.id === got.id), { timeout: 10_000 }).toMatchObject({ kind: 'in', played: true });
  expect((await page.evaluate(() => window.__h3d.deskArt(14)))?.dropping).toBe(false);
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(got.id);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  clean();
});

test('a live screen is on the desk monitor, big, in its glance view; the docked laptop’s sticker is the worker’s harness', async ({ page }) => {
  const clean = watchErrors(page);
  // #98: the terminal glance on every monitor (Settings → Display → Desk monitors: Terminal), not the activity cards
  // that idle and done agents rest on by default (e2e/m98-monitor.spec.ts).
  await page.addInitScript(() => localStorage.setItem('h3d.monitors', 'terminal'));
  await openGame(page, 'demo-m4', '', SIM);
  const L = await enter(page, 'herdr-3d');
  // From the lobby side, looking north into the south pod: its monitors face you.
  await look(page, L.width / 2, L.depth - 4.3, L.width / 2, 0.8, L.depth - 7.5);
  await expect.poll(() => liveIds(page), { timeout: 20_000 }).toHaveLength(4);
  for (const id of await liveIds(page)) {
    const m = await page.evaluate((w) => window.__h3d.screenMesh(w), id);
    expect(m, id).not.toBeNull();
    const s = m as NonNullable<typeof m>;
    expect(s).toMatchObject({ texture: true, glance: true });
    expect(s.mesh).toBe(`screens.live.${s.desk}`);
    // Exactly over the monitor's terminal area, the size of it: far bigger than the M5 lid's 0.31 × 0.2 m.
    expect(Math.hypot(s.center.x - s.monitor.center.x, s.center.y - s.monitor.center.y, s.center.z - s.monitor.center.z)).toBeLessThan(0.01);
    expect(s.size.width).toBeCloseTo(s.monitor.width, 2);
    expect(s.size.height).toBeCloseTo(s.monitor.height, 2);
    expect(s.size.width * s.size.height).toBeGreaterThan(3 * 0.31 * 0.2);
  }
  // Stickers: Claude Code's spark, Codex's prompt, by the worker's harness; the rim is the hat's colour.
  const floor = (await page.evaluate(() => window.__h3d.world())).find((f) => f.session === 'herdr-3d');
  const logos = new Set<string>();
  for (const w of floor?.workers ?? []) {
    const art = await page.evaluate((d) => window.__h3d.deskArt(d), w.desk);
    const want = w.harness === 'claude' ? 'claude' : w.harness === 'codex' ? 'codex' : 'plain';
    expect(art?.sticker?.logo, `${w.name} (${w.harness})`).toBe(want);
    expect(art?.parts).toMatchObject({ laptop: 1, sticker: 1, monitor: 1 });
    logos.add(want);
  }
  expect([...logos].sort()).toEqual(expect.arrayContaining(['claude', 'codex']));
  // An empty desk keeps the office's furniture (monitor, keyboard, mouse, dock, cables) and its "+", not the worker's things.
  const empty = await page.evaluate(() => window.__h3d.deskArt(5));
  expect(empty?.sticker).toBeNull();
  expect(Object.keys(empty?.parts ?? {}).sort()).toEqual(['chair', 'chairBase', 'led', 'legs', 'monitor', 'plus', 'screen', 'top', empty?.side === 1 ? 'kitR' : 'kitL'].sort());
  expect((await page.evaluate(() => window.__h3d.desks()))[5]).toMatchObject({ worker: null, plus: true });
  clean();
});

test.describe('screenshots at the Mac’s resolution (1512 × 945 at 2×)', () => {
  test.use({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 2 });

  test('a row while walking, a desk up close, the stickers, an empty desk, the drop-in', async ({ page }) => {
    test.setTimeout(240_000);
    const clean = watchErrors(page);
    await openGame(page, 'demo-m4', '', SIM);
    const L = await enter(page, 'herdr-3d');
    // Walking the aisle between the pod rows, looking along the north-facing row ahead (its monitors 2–5 m away).
    const row = L.slots.filter((s) => s.yaw === 0 && s.seat.z > 6).sort((a, b) => a.seat.x - b.seat.x);
    const d = row[0] as Layout['slots'][number];
    await look(page, d.seat.x - 1.4, d.seat.z - 1.35, d.seat.x + 2.2, 0.95, d.seat.z + 1.06);
    await expect.poll(async () => (await liveIds(page)).length, { timeout: 20_000 }).toBeGreaterThan(1);
    await page.waitForTimeout(2000);
    await frames(page, 3);
    await shot(page, 'm6b-row');
    // One desk up close: the monitor, keyboard and mouse, the worker's photos, mug, plant and notebook.
    const s4 = L.slots[4] as Layout['slots'][number];
    await look(page, s4.desk.x + 1.0, s4.seat.z - 0.5, s4.desk.x - 0.1, 0.72, s4.desk.z);
    await page.waitForTimeout(1200);
    await shot(page, 'm6b-desk');
    // The aisle between two pods: the docks on their outer sides, a Codex laptop (left) and a Claude one (right).
    await look(page, 10.7, 6.2, 10.7, 0.8, 4.5);
    await page.waitForTimeout(600);
    await shot(page, 'm6b-stickers');
    // An empty desk: the monitor on standby, the empty dock, the cables along the back edge, the "+".
    const s5 = L.slots[5] as Layout['slots'][number];
    await look(page, s5.seat.x + 0.8, s5.seat.z - 1.6, s5.desk.x, 0.9, s5.desk.z);
    await shot(page, 'm6b-empty-desk');
    // A hire drops in to that desk (slowed down): mid-fall over its chair, then the landing's puff of dust.
    await look(page, s5.seat.x + 1.7, s5.seat.z - 1.2, s5.seat.x, 1.25, s5.seat.z + 0.2);
    await page.evaluate(() => window.__h3d.arrivalRate(0.06));
    const w = { id: 'kazoo-1', session: 'herdr-3d', workspace_id: 'wk1', label: 'fresh', status: 'idle', name: 'Kazoo', desk_index: 5, harness: 'codex', model: 'gpt-6-sol', pane_id: 'wk1:p1', hired_at: Date.now() - 500 };
    await page.evaluate((x) => window.__h3d.inject({ t: 'worker.upsert', seq: 9100, worker: x } as never), w);
    await page.waitForFunction(() => (window.__h3d.arrivals().find((a) => a.id === 'kazoo-1')?.dy ?? 9) < 0.8);
    expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'worker', name: 'Kazoo' });
    await shot(page, 'm6b-drop-in');
    await page.waitForFunction(() => {
      const a = window.__h3d.arrivals().find((x) => x.id === 'kazoo-1');
      return !!a && a.dy === 0 && a.t > 0.44;
    });
    await shot(page, 'm6b-drop-land');
    clean();
  });
});
