// Isolated real transcript renderer (no 3D scene, no network): times what the view does with a watch ack.
// Run from the repo root after open.go wrote first pages to a private OUT directory:
//   portlease run --project herdr-3d --worktree . --name bench --service transcript-open -- \
//     node docs/research/transcript-open-bench/browser.mjs PRIVATE_OUT_DIR
// Prints file names, sizes and timings only.
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
    const r = await page.evaluate(async (items) => {
      const root = document.getElementById('root');
      const long = [];
      const po = new PerformanceObserver((l) => long.push(...l.getEntries().map((x) => x.duration)));
      po.observe({ type: 'longtask', buffered: false });
      const host = { onPromptSubmit: async () => true, onAnswer: () => {}, onAnswerAsk: async () => ({ ok: true, resolved: true }), onSwitchToTerminal: () => {}, loadSubagent: async () => [] };
      const t0 = performance.now();
      const view = window.mountTranscript(root, host);
      const mountMs = performance.now() - t0;
      const t1 = performance.now();
      view.setItems(items);
      const setItemsMs = performance.now() - t1;
      // The first frame after the ack: style, layout and paint of the whole timeline.
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      const firstFrameMs = performance.now() - t1;
      await new Promise((r) => setTimeout(r, 300)); // late work (highlighting) shows as long tasks
      po.disconnect();
      const nodes = root.querySelectorAll('*').length;
      view.destroy();
      root.replaceChildren();
      return { mountMs, setItemsMs, firstFrameMs, nodes, longTasks: long.length, maxLongTask: Math.max(0, ...long) };
    }, ack.items);
    const round = (x) => Math.round(x);
    console.log(JSON.stringify({ pass, f, mb: ack.file_mb, items: ack.items.length, server_ms: round(ack.build_ms + ack.page_ms), mount: round(r.mountMs), setItems: round(r.setItemsMs), firstFrame: round(r.firstFrameMs), nodes: r.nodes, longTasks: r.longTasks, maxLongTask: round(r.maxLongTask) }));
  }
}
await browser.close();
await server.close();
