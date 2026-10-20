import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { frames, openGame, watchErrors } from './game';

// #141: a floor entered again draws with the meshes and lamps of the floors before it (render/floorPool.ts). It must
// draw exactly what the same floor entered first, on a page of its own, draws: every pooled mesh's instances in use
// (count, matrices, colours), its material and shadows, the lamps; each mesh drawn from its own buffers (no two live
// meshes share a uuid, and the renderer's compiled state reads that mesh's arrays). demo-m6: scratchpad (6 desks), lab
// (14, a write-code crew with an in-tray), herdr-3d (20: the pool outgrows 16), depot-manager (asleep). Frames are
// compared at one fixed time with the loop paused (`floorPool({ t, hold })`), so the crowd's poses match.

type Probe = NonNullable<ReturnType<Window['__h3d']['floorPool']>>;

const T = 10;

/** The pool as one frame at `T` draws it, then the frame loop runs again (`shot`: the canvas of that frame too). */
async function probe(page: Page, shot = false): Promise<{ p: Probe; png: Buffer | null }> {
  const p = (await page.evaluate((t) => window.__h3d.floorPool({ data: true, t, hold: true }), T)) as Probe;
  const png = shot ? await page.screenshot({ style: '.hud, #debug { visibility: hidden !important; }' }) : null;
  await page.evaluate(() => window.__h3d.floorPool({ resume: true }));
  return { p, png };
}

/** What a fresh page and a pooled one must agree on, mesh by mesh (not uuids or capacities: those are the pool's). */
function differences(pooled: Probe, fresh: Probe): string[] {
  const out: string[] = [];
  const kits = new Map(pooled.kits.map((k) => [k.key, k]));
  for (const f of fresh.kits) {
    const k = kits.get(f.key);
    if (!k) {
      out.push(`${f.key}: no kit`);
      continue;
    }
    f.meshes.forEach((fm, i) => {
      const pm = k.meshes[i];
      if (!pm) return void out.push(`${f.key}.${fm.name}: missing`);
      for (const field of ['name', 'count', 'visible', 'castShadow', 'receiveShadow', 'inOffice'] as const) if (pm[field] !== fm[field]) out.push(`${fm.name}.${field}: ${String(pm[field])} != ${String(fm[field])}`);
      if (JSON.stringify(pm.material) !== JSON.stringify(fm.material)) out.push(`${fm.name}.material: ${JSON.stringify(pm.material)} != ${JSON.stringify(fm.material)}`);
      for (const field of ['matrix', 'color'] as const) {
        const a = pm[field] ?? null;
        const b = fm[field] ?? null;
        if (JSON.stringify(a) === JSON.stringify(b)) continue;
        const at = a && b ? a.findIndex((x, j) => Math.abs(x - (b[j] ?? NaN)) > 1e-3) : -1;
        if (at >= 0 || !a || !b || a.length !== b.length) out.push(`${fm.name}.${field} differs at ${at} (${a?.length} vs ${b?.length})`);
      }
    });
  }
  // A kit the floor does not use is not drawn.
  for (const k of pooled.kits) if (!fresh.kits.some((f) => f.key === k.key)) for (const m of k.meshes) if (m.inOffice) out.push(`${k.key}.${m.name}: drawn on a floor without it`);
  const lamp = (l: Probe['lamps'][number]) => ({ parent: l.parent, index: l.index, position: l.position, target: l.target, targetInScene: l.targetInScene, intensity: l.intensity });
  if (JSON.stringify(pooled.lamps.map(lamp)) !== JSON.stringify(fresh.lamps.map(lamp))) out.push(`lamps: ${JSON.stringify(pooled.lamps.map(lamp))} != ${JSON.stringify(fresh.lamps.map(lamp))}`);
  return out;
}

/** Each pooled mesh drawn here is drawn from its own buffers, and no uuid is drawn twice. */
function ownBuffers(p: Probe): string[] {
  const out = p.sharedUuids.map((u) => `uuid ${u} drawn twice`);
  for (const k of p.kits)
    for (const m of k.meshes) {
      if (!m.inOffice) continue;
      // A mesh drawn has a render object to check (none would make this check vacuous).
      if (m.visible && m.count > 0 && !m.bound.length) out.push(`${m.name}: drawn, but no render object of it was found`);
      for (const b of m.bound) if (!b.matrix || b.color === false) out.push(`${m.name}: its render state reads ${!b.matrix ? 'another matrix buffer' : 'another colour buffer'}`);
    }
  return out;
}

/** Share of differing pixels between two screenshots of the same size. */
function changed(a: Buffer, b: Buffer): number {
  const x = PNG.sync.read(a);
  const y = PNG.sync.read(b);
  let n = 0;
  for (let i = 0; i < x.data.length; i += 4) if (Math.abs((x.data[i] ?? 0) - (y.data[i] ?? 0)) + Math.abs((x.data[i + 1] ?? 0) - (y.data[i + 1] ?? 0)) + Math.abs((x.data[i + 2] ?? 0) - (y.data[i + 2] ?? 0)) > 24) n++;
  return n / (x.data.length / 4);
}

async function enter(page: Page, floor: string): Promise<void> {
  await page.evaluate((f) => window.__h3d.enterFloor(f), floor);
  await frames(page, 8);
}

/** The floor entered first on a page of its own: what a pooled re-entry must match (`then`: the same live changes after). */
async function freshProbe(browser: import('@playwright/test').Browser, floor: string, extra: string, then?: (page: Page) => Promise<void>): Promise<{ p: Probe; png: Buffer | null }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await openGame(page, 'demo-m6', extra);
  await enter(page, floor);
  if (then) await then(page);
  // Settled: what the boards and monitors fetch has arrived (two probes a second apart agree).
  let last = await probe(page, true);
  await expect.poll(async () => {
    await page.waitForTimeout(500);
    const next = await probe(page, true);
    const same = differences(next.p, last.p).length === 0;
    last = next;
    return same;
  }, { timeout: 20_000 }).toBe(true);
  await ctx.close();
  return last;
}

/** The pooled page matches the fresh one (polled: the boards and monitors fill in on their own time). */
async function matches(page: Page, fresh: { p: Probe; png: Buffer | null }, label: string): Promise<void> {
  let last: string[] = [];
  await expect
    .poll(
      async () => {
        const { p, png } = await probe(page, true);
        last = [...ownBuffers(p), ...differences(p, fresh.p)];
        if (!last.length && png && fresh.png) {
          const d = changed(png, fresh.png);
          if (d > 0.002) last.push(`screenshot: ${(d * 100).toFixed(2)} % of pixels differ`);
        }
        return last;
      },
      { message: label, timeout: 20_000 },
    )
    .toEqual([]);
}

for (const extra of ['', '&shadows=0']) {
  test(`a floor entered again draws what it draws entered first, on a new page${extra ? ' (shadows off)' : ''}`, async ({ page, browser }) => {
    test.setTimeout(300_000);
    const clean = watchErrors(page);
    await openGame(page, 'demo-m6', extra);
    // Through the city and floor to floor; herdr-3d outgrows the kits made for lab's 14 desks.
    const seq = extra ? ['lab', 'scratchpad', 'lab'] : ['scratchpad', 'lab', 'scratchpad', 'herdr-3d', 'lab', 'depot-manager', 'lab'];
    const seen = new Set<string>();
    const fresh = new Map<string, { p: Probe; png: Buffer | null }>();
    let grown = 0;
    for (const [i, floor] of seq.entries()) {
      if (i === 2) {
        await page.evaluate(() => window.__h3d.leaveFloor());
        await frames(page, 5);
      }
      await enter(page, floor);
      const { p } = await probe(page);
      expect(ownBuffers(p), `${floor}: every pooled mesh draws its own buffers`).toEqual([]);
      grown = p.grown;
      if (seen.has(floor) || floor === 'herdr-3d' || floor === 'depot-manager') {
        if (!fresh.has(floor)) fresh.set(floor, await freshProbe(browser, floor, extra));
        await matches(page, fresh.get(floor) as { p: Probe; png: Buffer | null }, `${floor} entered again (#${i + 1})`);
      }
      seen.add(floor);
    }
    if (!extra) expect(grown, 'herdr-3d grew the kits sized for lab').toBeGreaterThan(0);
    clean();
  });
}

test('live changes on a floor entered again show as on a new page: arrivals, leavers, status, a resize, asleep, the plan', async ({ page, browser }) => {
  test.setTimeout(300_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6');
  await enter(page, 'lab');
  await enter(page, 'herdr-3d');
  await enter(page, 'lab');
  const lab = await page.evaluate(() => window.__h3d.world().find((f) => f.session === 'lab')?.workers ?? []);
  const leaver = lab.find((w) => w.desk === 3) as { id: string };
  const mover = lab.find((w) => w.desk === 5) as { id: string };
  // The same changes, on the pooled page and on a new one: an arrival, a leaver, a desk change, a status change.
  const changes = async (p: Page) => {
    // The walks they start (the leaver packing up and out, the hire walking in) play fast and end before comparing.
    await p.evaluate(() => window.__h3d.arrivalRate(20));
    await p.evaluate(
      ({ leaver, mover }) => {
        const w = (id: string) => window.__h3d.worker(id) as NonNullable<ReturnType<Window['__h3d']['worker']>>;
        window.__h3d.inject({ t: 'worker.upsert', seq: 0, worker: { id: 'h141-new', session: 'lab', workspace_id: 'w141', label: 'new', name: 'Newt', desk_index: 12, status: 'working', harness: 'codex', model: 'gpt-6-sol' } } as never);
        window.__h3d.inject({ t: 'worker.removed', seq: 1_000_000, id: leaver, session: 'lab', workspace_id: w(leaver).workspace_id } as never);
        window.__h3d.inject({ t: 'worker.upsert', seq: 0, worker: { ...w(mover), desk_index: 13, status: 'blocked' } } as never);
      },
      { leaver: leaver.id, mover: mover.id },
    );
    await expect.poll(() => p.evaluate(() => window.__h3d.arrivals().length + window.__h3d.desks().filter((d) => d.away !== null).length), { timeout: 30_000 }).toBe(0);
    await frames(p, 8);
  };
  await changes(page);
  await matches(page, await freshProbe(browser, 'lab', '', changes), 'lab after arrivals, a leaver and a move');
  // The plan view, then back.
  await page.evaluate(() => window.__h3d.plan(true));
  await frames(page, 4);
  const plan = (await probe(page)).p;
  expect(plan.kits.find((k) => k.key === 'cards')?.meshes[0]?.visible, 'cards hide in the plan').toBe(false);
  await page.evaluate(() => window.__h3d.plan(false));
  await frames(page, 4);
  // A resize while you are on it (the office is rebuilt, from the pool), then asleep.
  const floor = (desks: number, state: string) => (p: Page) =>
    p.evaluate(({ desks, state }) => window.__h3d.inject({ t: 'floor.upsert', seq: 0, floor: { session: 'lab', state, building: 'b_3f09a1c2d4e5', index: 0, desks } } as never), { desks, state }).then(() => frames(p, 8));
  const resize = async (p: Page) => {
    await changes(p);
    await floor(17, 'running')(p);
  };
  await floor(17, 'running')(page);
  await matches(page, await freshProbe(browser, 'lab', '', resize), 'lab resized to 17 desks');
  const asleep = async (p: Page) => {
    await resize(p);
    await floor(17, 'asleep')(p);
  };
  await floor(17, 'asleep')(page);
  await matches(page, await freshProbe(browser, 'lab', '', asleep), 'lab asleep');
  clean();
});

test('ten rides between two floors leave nothing behind: geometries, textures, render objects, shaders stay flat', async ({ page }) => {
  test.setTimeout(240_000);
  await openGame(page, 'demo-m6');
  const rows: Probe['memory'][] = [];
  for (let i = 0; i < 10; i++) {
    for (const f of ['lab', 'pastry', 'lab']) await enter(page, f);
    rows.push((await probe(page)).p.memory);
  }
  console.log(`h141 memory per cycle: ${JSON.stringify(rows)}`);
  const first = rows[0] as Probe['memory'];
  for (const [i, r] of rows.slice(1).entries()) expect(r, `cycle ${i + 2} against the first`).toEqual(first);
});
