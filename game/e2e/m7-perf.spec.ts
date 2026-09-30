import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { frames, openGame, RESULTS, shot, watchErrors } from './game';
import { enter, faceBoard, wall, type Wall } from './m7';

// M7 perf: a floor with 60 workers whose boards hold 100 issues and 20 pull requests (`perf-boards`, simulated repo
// JeffreyVdb/bench). The wall draws what fits (four notes a column, eighteen PRs): two instanced batches, a text atlas
// each, nothing written on a quiet frame. The same run against a bridge without boards (`simfail=no_m7`) is the
// baseline; the numbers go to test-results/m7-perf.json (the server's WebGL2 llvmpipe run; the Mac Metal run is
// `pnpm perf:mac`, job `boards100`).

const SIM = 'play=none&sim=1&simms=150&simusage=0';

async function run(page: Page, fail: string): Promise<{ bench: Awaited<ReturnType<Window['__h3d']['bench']>>; wall: Wall | null }> {
  await openGame(page, 'perf-boards', '&open=none', fail ? `${SIM}&simfail=${fail}` : SIM);
  await enter(page, 'perf-floor');
  if (!fail) await expect.poll(async () => ((await wall(page))?.issues.length ?? 0) + ((await wall(page))?.prs.length ?? 0), { timeout: 15_000 }).toBeGreaterThan(20);
  await faceBoard(page, 'perf-floor', 'issues', 3, 0.02);
  await frames(page, 30);
  const w = await wall(page);
  expect((await page.evaluate(() => window.__h3d.pose()))?.area, 'on the floor, facing the boards').toBe('floor');
  const bench = await page.evaluate(() => window.__h3d.bench({ frames: 40, warm: 10, pipelined: false, raf: false }));
  return { bench, wall: w };
}

test('100 issue notes and 20 PR notes stay in the frame budget: two instanced draws, nothing written on a quiet frame', async ({ page, browser }) => {
  // Two 50-frame benches (serialized only: the pipelined and rAF phases are not read here) at 90-200 ms a frame on
  // llvmpipe, and `make e2e` runs six tests at once on the same CPUs.
  test.setTimeout(300_000);
  const clean = watchErrors(page);
  const on = await run(page, '');
  const w = on.wall as Wall;
  // The data is 100 cards and 20 PRs; what the wall draws is what fits, and "+N more" says the rest.
  expect(w.batches).toBe(2);
  expect(w.issues.length).toBeGreaterThanOrEqual(12);
  expect(w.issues.length).toBeLessThanOrEqual(24);
  expect(w.prs.length).toBe(18);
  await shot(page, 'm7-perf-boards');
  // A quiet frame writes nothing.
  const before = (await wall(page)) as Wall;
  await frames(page, 30);
  const after = (await wall(page)) as Wall;
  expect([after.issuesWrites, after.prsWrites]).toEqual([before.issuesWrites, before.prsWrites]);
  clean();
  // The baseline must not share the CPU with a page still rendering the floor.
  await page.close();

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const base = await run(await ctx.newPage(), 'no_m7');
  await ctx.close();
  const cost = {
    frameMsMed: +(on.bench.frameMs.med - base.bench.frameMs.med).toFixed(2),
    updateMsMed: +(on.bench.updateMs.med - base.bench.updateMs.med).toFixed(2),
    drawCalls: on.bench.drawCalls - base.bench.drawCalls,
    triangles: on.bench.triangles - base.bench.triangles,
  };
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(resolve(RESULTS, 'm7-perf.json'), JSON.stringify({ backend: on.bench.backend, boards: { issues: w.issues.length, prs: w.prs.length, data: { issues: 100, prs: 20 } }, with: on.bench, without: base.bench, cost }, null, 2));
  console.log(`m7 perf: with boards frame ${on.bench.frameMs.med} ms (p95 ${on.bench.frameMs.p95}), update ${on.bench.updateMs.med} ms, ${on.bench.drawCalls} draws; without ${base.bench.frameMs.med} ms, update ${base.bench.updateMs.med} ms, ${base.bench.drawCalls} draws; cost ${JSON.stringify(cost)}`);
  // The notes are two draws (plus a few small meshes for the gong); the update step barely moves. The update bound is
  // loose on purpose: llvmpipe under H3D_WORKERS parallel specs jitters by about 1 ms (the Mac Metal run is the budget check).
  expect(cost.drawCalls).toBeLessThanOrEqual(6);
  expect(cost.updateMsMed).toBeLessThan(2);
});
