// Isolated real transcript renderer (no 3D scene, no network): times what the view does with a watch ack.
// Run from the repo root after open.go wrote first pages to a private OUT directory:
//   portlease run --project herdr-3d --worktree . --name bench --service transcript-open -- \
//     node docs/research/transcript-open-bench/browser.mjs PRIVATE_OUT_DIR
// Prints file names, sizes and timings only. #126: the first frame is the newest rows'; the older ones are built after it
// (`data-building` on the view until the last): `filled` is when that ended. The long tasks and long animation frames
// are counted over the whole of it; `fillLoaf` is the longest frame that started after the first one (`maxLoaf` includes
// the first, which also holds the mount and this script's copy of the items).
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
const { createServer } = await import(pathToFileURL(resolve('game/node_modules/vite/dist/node/index.js')));
const { chromium } = await import(pathToFileURL(resolve('game/node_modules/@playwright/test/index.mjs')));
const dir = process.argv[2];
const port = Number(process.env.PORTLEASE_BENCH_PORT);
if (!dir || !port) throw Error('usage: portlease run ... --name bench -- node browser.mjs PRIVATE_OUT_DIR');
const server = await createServer({ root: resolve('game'), logLevel: 'error', server: { host: '127.0.0.1', port, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error(e.message));
await page.route('**/__bench', (route) => route.fulfill({ contentType: 'text/html', body: `<style>html,body,#root{height:100%;margin:0}#root{width:1000px}</style><link rel="stylesheet" href="/src/ui/themes.css"><link rel="stylesheet" href="/src/ui/uiTheme.css"><link rel="stylesheet" href="/src/laptop/transcript.css"><div id="root"></div><script type="module">window.loadMs=performance.now();const m=await import('/src/laptop/transcriptRender.ts');window.loadMs=performance.now()-window.loadMs;window.mountTranscript=m.mountTranscript;window.ready=true;</script>` }));
await page.goto(`http://127.0.0.1:${port}/__bench`);
await page.waitForFunction(() => window.ready);
console.log('browser', browser.version(), 'render module import (vite dev, not a build):', Math.round(await page.evaluate(() => window.loadMs)), 'ms');
const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
for (let pass = 0; pass < 2; pass++) {
  for (const f of files) {
    const ack = JSON.parse(await readFile(`${dir}/${f}`, 'utf8'));
    // #126: the items are copied into the page first, and the view mounted a frame before they are set (as in the app,
    // where it mounts before the watch answers): the tasks and frames counted are the open's alone.
    await page.evaluate((items) => (window.benchItems = items), ack.items);
    const r = await page.evaluate(async () => {
      const items = window.benchItems;
      const root = document.getElementById('root');
      const host = { onPromptSubmit: async () => true, onAnswer: () => {}, onAnswerAsk: async () => ({ ok: true, resolved: true }), onSwitchToTerminal: () => {}, loadSubagent: async () => [] };
      const t0 = performance.now();
      const view = window.mountTranscript(root, host);
      const mountMs = performance.now() - t0;
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      const long = [];
      const loaf = [];
      const po = new PerformanceObserver((l) => long.push(...l.getEntries().map((x) => x.duration)));
      po.observe({ type: 'longtask', buffered: false });
      const lo = new PerformanceObserver((l) => loaf.push(...l.getEntries()));
      lo.observe({ type: 'long-animation-frame', buffered: false });
      const t1 = performance.now();
      view.setItems(items);
      const setItemsMs = performance.now() - t1;
      // The first frame after the ack: style, layout and paint of the whole timeline.
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      const firstFrameMs = performance.now() - t1;
      const painted = performance.now();
      const firstNodes = root.querySelectorAll('*').length;
      while (root.querySelector('.tx[data-building]') && performance.now() - t1 < 60_000) await new Promise((r) => setTimeout(r, 20));
      const filledMs = performance.now() - t1;
      await new Promise((r) => setTimeout(r, 300)); // late work (highlighting) shows as long tasks
      po.disconnect();
      lo.disconnect();
      const nodes = root.querySelectorAll('*').length;
      view.destroy();
      root.replaceChildren();
      return { mountMs, setItemsMs, firstFrameMs, firstNodes, filledMs, nodes, longTasks: long.length, maxLongTask: Math.max(0, ...long), maxLoaf: Math.max(0, ...loaf.map((e) => e.duration)), fillLoaf: Math.max(0, ...loaf.filter((e) => e.startTime >= painted - 1).map((e) => e.duration)) };
    });
    const round = (x) => Math.round(x);
    console.log(JSON.stringify({ pass, f, mb: ack.file_mb, items: ack.items.length, server_ms: round(ack.build_ms + ack.page_ms), mount: round(r.mountMs), setItems: round(r.setItemsMs), firstFrame: round(r.firstFrameMs), firstNodes: r.firstNodes, filled: round(r.filledMs), nodes: r.nodes, longTasks: r.longTasks, maxLongTask: round(r.maxLongTask), maxLoaf: round(r.maxLoaf), fillLoaf: round(r.fillLoaf) }));
  }
}
await browser.close();
await server.close();
