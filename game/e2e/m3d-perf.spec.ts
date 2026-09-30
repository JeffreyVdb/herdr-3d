import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { frames, openGame, RESULTS, shot, watchErrors } from './game';

// M3d perf: the perf-city240 city (5 towers, 240 workers) with a logo on every building (`simlogos=1`: a made-up ring
// and three bars in a colour of its own) against the same city without. In the city that is one instanced draw for the
// sign plates and one quad a logo; in a lobby, the entrance sign and the reception wall are three small meshes each. The
// numbers go to test-results/m3d-perf.json (the server's WebGL2 llvmpipe run, which jitters by a millisecond or so under
// parallel specs; the Mac Metal run is `pnpm perf:mac`).

const SIM = 'play=none&sim=1&simms=150&simusage=0';

async function run(page: Page, logos: boolean, where: 'city' | 'lobby'): Promise<{ bench: Awaited<ReturnType<Window['__h3d']['bench']>>; signs: number }> {
  const key = `perf-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await openGame(page, 'perf-city240', '&open=none', `${SIM}&simlogo=${key}${logos ? '&simlogos=1' : ''}`);
  if (logos) await expect.poll(async () => (await page.evaluate(() => window.__h3d.logos()))?.city.length, { timeout: 30_000 }).toBe(5);
  if (where === 'lobby') {
    await page.evaluate(() => window.__h3d.enterLobby(null));
    await page.evaluate(() => window.__h3d.enterLobby('b_perf00000000'));
    await frames(page, 6);
    if (logos) await expect.poll(async () => (await page.evaluate(() => window.__h3d.logos()))?.lobby?.canopy.showing, { timeout: 15_000 }).toBe('logo');
  }
  await frames(page, 20);
  const bench = await page.evaluate(() => window.__h3d.bench({ frames: 40, warm: 10, pipelined: false, raf: false }));
  return { bench, signs: (await page.evaluate(() => window.__h3d.logos()))?.city.length ?? 0 };
}

for (const where of ['city', 'lobby'] as const) {
  test(`logos on every building of the ${where} stay in the frame budget`, async ({ page, browser }) => {
    // Two 50-frame benches (serialized only: the pipelined and rAF phases are not read here) at 90-200 ms a frame on
    // llvmpipe, and `make e2e` runs six tests at once on the same CPUs.
    test.setTimeout(300_000);
    const clean = watchErrors(page);
    const on = await run(page, true, where);
    expect(on.signs).toBe(5);
    await shot(page, `m3d-perf-${where}`);
    clean();
    // The baseline must not share the CPU with a page still rendering the city.
    await page.close();

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const off = await run(await ctx.newPage(), false, where);
    await ctx.close();
    expect(off.signs).toBe(0);
    const cost = {
      frameMsMed: +(on.bench.frameMs.med - off.bench.frameMs.med).toFixed(2),
      updateMsMed: +(on.bench.updateMs.med - off.bench.updateMs.med).toFixed(2),
      drawCalls: on.bench.drawCalls - off.bench.drawCalls,
      triangles: on.bench.triangles - off.bench.triangles,
    };
    mkdirSync(RESULTS, { recursive: true });
    writeFileSync(resolve(RESULTS, `m3d-perf-${where}.json`), JSON.stringify({ backend: on.bench.backend, where, with: on.bench, without: off.bench, cost }, null, 2));
    console.log(`m3d perf (${where}): with logos frame ${on.bench.frameMs.med} ms (p95 ${on.bench.frameMs.p95}), update ${on.bench.updateMs.med} ms, ${on.bench.drawCalls} draws; without ${off.bench.frameMs.med} ms, update ${off.bench.updateMs.med} ms, ${off.bench.drawCalls} draws; cost ${JSON.stringify(cost)}`);
    // City: one instanced draw for the plates and a quad per building. Lobby: three small meshes per sign.
    expect(cost.drawCalls).toBeLessThanOrEqual(where === 'city' ? 7 : 7);
    expect(cost.drawCalls).toBeGreaterThan(0);
    expect(cost.triangles).toBeLessThan(200);
    // Loose on purpose (llvmpipe under parallel specs jitters): the logos must not cost a frame's worth.
    expect(cost.updateMsMed).toBeLessThan(2);
    expect(on.bench.frameMs.med).toBeLessThan(off.bench.frameMs.med * 1.5 + 5);
  });
}
