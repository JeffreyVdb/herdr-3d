// #126: the open of a big transcript in the real app, with the 3D scene running: the Vite dev server (`make dev`'s, with
// the fixture server), demo-m5 with the simulating bridge serving a page dump as every worker's transcript
// (`simtx=file`, tools/fixture-transcript.ts), then sitting down at a worker (the conversation is what you sit down to).
// Times from the sit to the first painted rows of the timeline, and the longest gap between two frames over the next
// seconds (and the long animation frames). Run from the repo root on one of open.go's private dumps:
//   portlease run --project herdr-3d --worktree . --name bench --service transcript-open -- \
//     node docs/research/transcript-open-bench/app.mjs PRIVATE_OUT_DIR/claude-NN.json [RUNS]
// H3D_BENCH_HEADED=1 opens a window; the default is headless Chromium (ANGLE/Vulkan). H3D_BENCH_SIT=0 does not sit: the
// scene's own frames over the same seconds, to compare with. Prints timings only.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [file, runsArg] = process.argv.slice(2);
const port = Number(process.env.PORTLEASE_BENCH_PORT);
if (!file || !port) throw Error('usage: portlease run ... --name bench -- node app.mjs PRIVATE_OUT_DIR/FILE.json [RUNS]');
process.env.H3D_SIMTX_FILE = resolve(file);
const { createServer } = await import(pathToFileURL(resolve('game/node_modules/vite/dist/node/index.js')));
const { chromium } = await import(pathToFileURL(resolve('game/node_modules/@playwright/test/index.mjs')));
const server = await createServer({ root: resolve('game'), configFile: resolve('game/vite.config.ts'), logLevel: 'error', server: { host: '127.0.0.1', port, strictPort: true } });
await server.listen();
const headed = process.env.H3D_BENCH_HEADED === '1';
const sit = process.env.H3D_BENCH_SIT !== '0';
const browser = await chromium.launch({ headless: !headed, args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] });
const ws = encodeURIComponent('/fixture/demo-m5?play=none&sim=1&simms=500&simusage=0&simtx=file');
const url = `http://127.0.0.1:${port}/?backend=webgl2&ws=${ws}&time=2026-09-30T12:00&prints=0`;
const runs = Number(runsArg) || 3;
const round = (x) => Math.round(x);
for (let run = 0; run < runs; run++) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__h3d?.error || (window.__h3d?.ready && window.__h3d.frames >= 3), undefined, { timeout: 120_000 });
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  const id = await page.evaluate(() => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === 'Tofu')?.id ?? '');
  await page.evaluate((i) => window.__h3d.face(i), id);
  // The scene settles (shaders compiled, the floor drawn) before the open is timed.
  await page.waitForTimeout(3000);
  const r = await page.evaluate(async (i) => {
    const out = { firstRows: -1, loader: -1, built: -1, maxGap: 0, frames: 0, loaf: 0, loafs: 0, worst: [] };
    let last = 0;
    let seen = -1;
    let stop = false;
    const t0 = performance.now();
    const frame = (t) => {
      if (stop) return;
      if (last) out.maxGap = Math.max(out.maxGap, t - last);
      last = t;
      out.frames++;
      const tx = document.querySelector('.tx');
      if (out.loader < 0 && document.querySelector('.txl:not([hidden])')) out.loader = performance.now() - t0;
      if (seen < 0 && document.querySelector('.tx-list:not(.tx-nested) > .tx-item')) seen = t;
      else if (seen >= 0 && out.firstRows < 0) out.firstRows = t - t0; // the frame after the rows came: they are painted
      if (out.firstRows >= 0 && out.built < 0 && tx && !tx.hasAttribute('data-building')) out.built = performance.now() - t0;
      requestAnimationFrame(frame);
    };
    const po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        out.loafs++;
        if (e.duration <= out.loaf) continue;
        out.loaf = e.duration;
        // What the longest frame ran: its scripts (where they came from, what started them) and its own rendering.
        const at = (u) => (u || '').split('/').pop().split('?')[0];
        out.worst = [
          { at: Math.round(e.startTime - t0), render: Math.round(e.renderStart ? e.startTime + e.duration - e.renderStart : 0) },
          ...[...e.scripts].sort((a, b) => b.duration - a.duration).slice(0, 4).map((x) => ({ ms: Math.round(x.duration), forced: Math.round(x.forcedStyleAndLayoutDuration), by: x.invoker, src: `${at(x.sourceURL)}:${x.sourceFunctionName}` })),
        ];
      }
    });
    po.observe({ type: 'long-animation-frame' });
    requestAnimationFrame(frame);
    if (i) window.__h3d.sitAt(i);
    await new Promise((res) => setTimeout(res, 8000));
    stop = true;
    po.disconnect();
    out.nodes = document.querySelector('.tx')?.querySelectorAll('*').length ?? 0;
    return out;
  }, sit ? id : '');
  console.log(JSON.stringify({ run, firstRowsMs: round(r.firstRows), loaderMs: round(r.loader), builtMs: round(r.built), maxFrameGapMs: round(r.maxGap), frames8s: r.frames, maxLoafMs: round(r.loaf), loafs: r.loafs, nodes: r.nodes, worstFrame: r.worst }));
  await page.close();
}
await browser.close();
await server.close();
