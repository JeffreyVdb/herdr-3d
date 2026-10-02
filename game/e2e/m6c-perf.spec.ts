import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { frames, openGame, RESULTS } from './game';

// M6c perf: a full floor (perf-floor60: 60 workers, shadows on) with two crews, and two reports on their way to two
// orchestrators at once (stand-up, walks, hand-overs, folders in flight): the frame and its draw calls against the same floor
// with the two crews seated. The walkers are the instanced crowd's and the arrivals' (one InstancedMesh per part, however many
// walk), so the draw calls must not grow with the walkers. The numbers go to test-results/m6c-perf.json (the server's
// WebGL2 llvmpipe run; the Mac Metal run is the author's).

type Bench = Awaited<ReturnType<Window['__h3d']['bench']>>;

/** Two orchestrators (desks 0 and 8), each with a freelancer in the pod (desks 1 and 9) whose report is pending. */
async function crews(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const f = window.__h3d.world().find((x) => x.session === 'perf-floor');
    if (!f) throw new Error('no floor');
    const at = (d: number) => f.workers.find((w) => w.desk === d);
    const specs: Array<[number, Record<string, unknown>]> = [
      [0, { role: 'orch', run: 'perf-a', label: 'ORCH|a|1', status: 'working', phase: 'review', pass: 1 }],
      [8, { role: 'orch', run: 'perf-b', label: 'ORCH|b|1', status: 'working', phase: 'review', pass: 1 }],
      [1, { role: 'review', run: 'perf-a', label: 'REVIEW|a|1|r1', status: 'working', report: { state: 'pending' } }],
      [9, { role: 'code', run: 'perf-b', label: 'CODE|b|1|r1', status: 'working', report: { state: 'pending' } }],
    ];
    const ids: string[] = [];
    let seq = 9_000_000;
    for (const [desk, extra] of specs) {
      const w = at(desk);
      if (!w) throw new Error(`no worker at ${desk}`);
      ids.push(w.id);
      const orch = desk === 1 ? at(0)?.id : desk === 9 ? at(8)?.id : undefined;
      window.__h3d.inject({ t: 'worker.upsert', seq: seq++, worker: { id: w.id, session: 'perf-floor', workspace_id: `p-${w.id}`, name: w.name, desk_index: w.desk, harness: 'claude', model: 'claude-opus-5-5', ...(orch ? { orch_id: orch } : {}), ...extra } } as never);
    }
    return ids;
  });
}

test('two reports in flight on a full floor stay in the frame budget of the same floor seated', async ({ page }) => {
  test.setTimeout(240_000);
  await openGame(page, 'perf-floor60', '', 'play=none');
  await page.evaluate(() => window.__h3d.enterFloor('perf-floor'));
  const L = (await page.evaluate(() => window.__h3d.layout('perf-floor')))!;
  const ids = await crews(page);
  await frames(page, 10);
  // From the aisle, looking across the first two pods.
  const s0 = L.slots[0]!.seat;
  await page.evaluate(([x, z]) => window.__h3d.setPose({ x: x as number, z: z as number - 3.2, yaw: Math.PI, pitch: -0.1 }), [s0.x + 1.5, s0.z] as const);
  await frames(page, 10);
  const run = () => page.evaluate(() => window.__h3d.bench({ frames: 40, warm: 10, pipelined: false, raf: false }));
  const seated: Bench = await run();
  expect(await page.evaluate(() => window.__h3d.arrivals().filter((a) => a.kind === 'deliver').length)).toBe(0);
  // Slowed right down, so both stay in flight for the whole run; the two reports come in.
  await page.evaluate(() => window.__h3d.arrivalRate(0.05));
  await page.evaluate(
    ([oa, a, ob, b]) => {
      const name = (id: string) => window.__h3d.world()[0]?.workers.find((w) => w.id === id)?.name;
      window.__h3d.inject({ t: 'worker.upsert', seq: 9_100_000, worker: { id: a, session: 'perf-floor', workspace_id: `p-${a}`, name: name(a), harness: 'claude', model: 'claude-opus-5-5', role: 'review', run: 'perf-a', orch_id: oa, label: 'REVIEW|a|1|r1', status: 'done', desk_index: 1, report: { state: 'ready', at: 5, verdict: 'PASS' } } } as never);
      window.__h3d.inject({ t: 'worker.upsert', seq: 9_100_001, worker: { id: b, session: 'perf-floor', workspace_id: `p-${b}`, name: name(b), harness: 'claude', model: 'claude-opus-5-5', role: 'code', run: 'perf-b', orch_id: ob, label: 'CODE|b|1|r1', status: 'done', desk_index: 9, report: { state: 'ready', at: 6, summary: 'Done.' } } } as never);
    },
    [ids[0] as string, ids[2] as string, ids[1] as string, ids[3] as string] as const,
  );
  await frames(page, 5);
  const walking = await page.evaluate(() => window.__h3d.arrivals().filter((a) => a.kind === 'deliver').map((a) => a.phase));
  expect(walking).toHaveLength(2);
  const flying: Bench = await run();
  const still = await page.evaluate(() => window.__h3d.arrivals().filter((a) => a.kind === 'deliver').length);
  expect(still).toBe(2);
  const summary = {
    backend: seated.backend,
    workers: seated.workers,
    seatedFrameMs: seated.frameMs,
    flyingFrameMs: flying.frameMs,
    seatedDraws: seated.drawCalls,
    flyingDraws: flying.drawCalls,
    seatedTriangles: seated.triangles,
    flyingTriangles: flying.triangles,
  };
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(resolve(RESULTS, 'm6c-perf.json'), JSON.stringify({ summary, seated, flying }, null, 2));
  console.log(`m6c perf: ${JSON.stringify(summary)}`);
  // Instanced: the walkers and the flying folders add a handful of draws (their parts, and the shadows), never one per walker.
  expect(flying.drawCalls - seated.drawCalls).toBeLessThanOrEqual(40);
  expect(flying.frameMs.med).toBeLessThan(seated.frameMs.med * 1.5 + 5);
});
