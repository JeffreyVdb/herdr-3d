import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { runScoped } from '../tools/herdr-throwaway.ts';

// Run through tools/live-latency.ts, which owns the throwaway herdr session,
// the private bridge and the WS proxy. The bridge is whatever this worktree
// builds: an M1 bridge (no name/desk_index, so the game's fallbacks show) or
// the M2 bridge (its own names and desks); both must pass.
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} unset: run via \`pnpm test:live\``);
  return v;
};

test('a herdr status change reaches the rendered state within 1 s', async ({ page }) => {
  const session = env('H3D_LIVE_SESSION');
  const pane = env('H3D_LIVE_PANE');
  const label = env('H3D_LIVE_LABEL');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`/?backend=webgl2&ws=${encodeURIComponent(env('H3D_LIVE_WS'))}`);
  // The throwaway floor shows up (unassigned lot) with our worker at a local desk.
  const id = await page.waitForFunction(
    ([s, l]) => window.__h3d.world().find((f) => f.session === s)?.workers.find((w) => w.label === l)?.id ?? null,
    [session, label] as const,
    { timeout: 30_000 },
  );
  const workerId = (await id.jsonValue()) as string;
  const seen = await page.evaluate((s) => window.__h3d.world().find((f) => f.session === s), session);
  const w = seen?.workers.find((x) => x.id === workerId);
  if (!w) throw new Error('worker vanished');
  // Contract: the bridge's name, else the label; its desk_index, else the
  // lowest free local slot (0, the only worker); one worker → 6 desks either way.
  console.log(`live: bridge sent name=${JSON.stringify(w.bridgeName)} desk_index=${JSON.stringify(w.bridgeDesk)}`);
  if (w.bridgeName !== null) expect(w.bridgeName).not.toBe('');
  expect(w.name).toBe(w.bridgeName ?? label);
  expect(w.desk).toBe(w.bridgeDesk ?? 0);
  expect(seen?.desks).toBe(6);
  await page.evaluate((s) => window.__h3d.enterFloor(s), session);
  // Let the new floor compile its shaders and settle before timing anything.
  const f0 = await page.evaluate(() => window.__h3d.frames);
  await page.waitForFunction((n) => window.__h3d.frames > n + 20, f0, { timeout: 30_000 });

  const report = (state: string) =>
    runScoped(session, ['--session', session, 'pane', 'report-agent', pane, '--source', 'custom:h3d-live', '--agent', 'h3d-live', '--state', state]);
  const shown: Record<string, string> = { working: 'working', blocked: 'needs_you', idle: 'idle' };
  const samples: Array<{ state: string; beforeMs: number; afterCliMs: number }> = [];
  for (const state of ['working', 'blocked', 'idle', 'working', 'blocked', 'idle', 'working']) {
    const want = shown[state] as string;
    const t0 = Date.now();
    report(state);
    const t1 = Date.now();
    const h = await page.waitForFunction(
      ([w, s]) => {
        const r = window.__h3d.status(w);
        return r && r.status === s ? r.at : null;
      },
      [workerId, want] as const,
      { timeout: 5000, polling: 'raf' },
    );
    const at = (await h.jsonValue()) as number;
    samples.push({ state, beforeMs: at - t0, afterCliMs: at - t1 });
    console.log(`live: ${state.padEnd(8)} on screen ${at - t0} ms after the herdr call started (${at - t1} ms after it returned)`);
  }
  const worst = Math.max(...samples.map((s) => s.beforeMs));
  writeFileSync(env('H3D_LIVE_OUT'), JSON.stringify({ session, worstMs: worst, samples }, null, 2));
  expect(worst, 'status change → rendered frame').toBeLessThan(1000);
  expect(errors).toEqual([]);
});
