import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { backendId, Layers, metrics, summarise, trace } from './perfTrace';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, RESULTS, seatMode } from './game';

// #58 perf: does the transcript view's live cue ("Thinking…", an opacity-only CSS animation) add paint, main-thread,
// compositor or GPU work? Seated at Pebble (demo-m5, simulating server) in the conversation view, the same page is
// traced three times for H3D_PERF_MS (default 60 s) each: idle (no cue), working (the cue flashing, its time ticking at
// 1 Hz), idle again (the noise between two runs of the same state). Chrome's trace (devtools.timeline, toplevel, gpu)
// gives the paints (count, area), layouts, style recalcs, long tasks and each thread's busy time; Performance.getMetrics
// the renderer's totals; LayerTree the flashing label's own layer and how often it was painted. The numbers go to test-results/m58-perf.json. Opt-in (it
// takes ~4 minutes): H3D_PERF=1.

const SIM = 'play=none&sim=1&simms=500&simusage=0';
const MS = Number(process.env.H3D_PERF_MS) || 60_000;

test.skip(!process.env.H3D_PERF, 'perf run: H3D_PERF=1');

function pebble(): Worker {
  const snap = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } };
  return snap.world.workers.find((x) => x.name === 'Pebble') as Worker;
}

async function phase(page: Page, cdp: CDPSession, layers: Layers, label: number | null) {
  const before = await metrics(cdp);
  const f0 = await page.evaluate(() => window.__h3d.frames);
  const layer0 = label !== null ? layers.of(label) : null;
  const events = await trace(cdp, MS);
  const after = await metrics(cdp);
  const layer1 = label !== null ? layers.of(label) : null;
  // Durations are seconds (as ms here), counts are counts.
  const d = (k: string) => {
    const v = (after[k] ?? 0) - (before[k] ?? 0);
    return k.endsWith('Duration') ? Math.round(v * 1000) : v;
  };
  return {
    ...summarise(events, MS),
    gameFrames: (await page.evaluate(() => window.__h3d.frames)) - f0,
    metrics: { TaskDuration: d('TaskDuration'), ScriptDuration: d('ScriptDuration'), LayoutDuration: d('LayoutDuration'), RecalcStyleDuration: d('RecalcStyleDuration'), LayoutCount: d('LayoutCount'), RecalcStyleCount: d('RecalcStyleCount') },
    animations: await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && (a.effect as KeyframeEffect | null)?.target?.closest('.tx-activity')).length),
    // The flashing label's own compositor layer: how often its content was painted during the run (0: the flash is
    // composited, never repainted).
    labelLayer: layer0 && layer1 ? { size: `${Math.round(layer1.width)}x${Math.round(layer1.height)}`, paintsBefore: layer0.paintCount ?? null, paintsAfter: layer1.paintCount ?? null } : null,
    layerCount: layers.last.length,
  };
}

test('the live cue adds no paint, main-thread or GPU work beyond its 1 Hz time', { tag: '@perf' }, async ({ page }) => {
  test.setTimeout(MS * 3 + 180_000);
  const w = pebble();
  await openGame(page, 'demo-m5', '&prints=0', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  expect(await page.evaluate((i) => window.__h3d.face(i), w.id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((i) => window.__h3d.sitAt(i), w.id)).toBe(true);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.transcript()))?.items ?? 0).toBeGreaterThan(10);
  await seatMode(page, 'transcript'); // #98: up as you sit
  await expect(page.locator('.seat-transcript .tx')).toBeVisible();
  await frames(page, 30);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('DOM.enable');
  const layers = new Layers(cdp);
  await cdp.send('LayerTree.enable');
  const status = (s: string) =>
    page.evaluate(([x, st]) => window.__h3d.inject({ t: 'worker.status', seq: 1_000_000, id: x.id, session: x.session, workspace_id: x.workspace_id, status: st, prev_status: st === 'working' ? 'idle' : 'working', status_since: Date.now(), title: '' }), [w, s] as const);

  const idle = await phase(page, cdp, layers, null);
  await status('working');
  const cue = page.locator('.seat-transcript .tx-activity');
  await expect(cue).toHaveCount(1);
  await frames(page, 10);
  const label = await backendId(cdp, '.seat-transcript .tx-activity-label');
  const working = await phase(page, cdp, layers, label);
  await status('idle');
  await expect(cue).toHaveCount(0);
  const idleAgain = await phase(page, cdp, layers, null);
  const out = { ms: MS, idle, working, idleAgain };
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(resolve(RESULTS, 'm58-perf.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
  expect(working.animations).toBe(1);
  // The flash is composited: its layer is not repainted while it runs.
  expect(working.labelLayer?.paintsAfter).toBe(working.labelLayer?.paintsBefore);
  expect(working.longTasks).toBeLessThanOrEqual(idle.longTasks + idleAgain.longTasks + 1);
});
