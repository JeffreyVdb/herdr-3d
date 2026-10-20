// Isolated real transcript renderer: first frame after setItems today, with `.tx-item { content-visibility: auto }`,
// and with only the newest 150 items. Run from the repo root on open.go's private OUT directory:
//   portlease run --project herdr-3d --worktree . --name bench --service transcript-open -- \
//     node docs/research/transcript-open-bench/experiments.mjs PRIVATE_OUT_DIR [FILE.json...]
// Prints file names and timings only.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
const { createServer } = await import(pathToFileURL(resolve('game/node_modules/vite/dist/node/index.js')));
const { chromium } = await import(pathToFileURL(resolve('game/node_modules/@playwright/test/index.mjs')));
const [dir, ...only] = process.argv.slice(2);
const port = Number(process.env.PORTLEASE_BENCH_PORT);
if (!dir || !port) throw Error('usage: portlease run ... --name bench -- node experiments.mjs PRIVATE_OUT_DIR [FILE.json...]');
const server = await createServer({ root: resolve('game'), logLevel: 'error', server: { host: '127.0.0.1', port, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error(e.message));
await page.route('**/__bench', (route) => route.fulfill({ contentType: 'text/html', body: `<style>html,body,#root{height:100%;margin:0}#root{width:1000px}</style><style id="cv"></style><link rel="stylesheet" href="/src/ui/themes.css"><link rel="stylesheet" href="/src/ui/uiTheme.css"><link rel="stylesheet" href="/src/laptop/transcript.css"><div id="root"></div><script type="module">const m=await import('/src/laptop/transcriptRender.ts');window.mountTranscript=m.mountTranscript;window.ready=true;</script>` }));
await page.goto(`http://127.0.0.1:${port}/__bench`);
await page.waitForFunction(() => window.ready);
const run = (items, cv) =>
  page.evaluate(async ({ items, cv }) => {
    document.getElementById('cv').textContent = cv ? '.tx-item{content-visibility:auto;contain-intrinsic-size:auto 80px}' : '';
    const root = document.getElementById('root');
    const view = window.mountTranscript(root, { onPromptSubmit: async () => true, onAnswer: () => {}, onAnswerAsk: async () => ({ ok: true, resolved: true }), onSwitchToTerminal: () => {}, loadSubagent: async () => [] });
    const t = performance.now();
    view.setItems(items);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const ms = performance.now() - t;
    view.destroy();
    root.replaceChildren();
    return Math.round(ms);
  }, { items, cv });
const files = only.length ? only : (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
for (const f of files) {
  const items = JSON.parse(await readFile(`${dir}/${f}`, 'utf8')).items;
  await run(items, false); // warm-up
  const today = await run(items, false);
  const contentVisibility = await run(items, true);
  const newest150 = await run(items.slice(-150), false);
  console.log(JSON.stringify({ f, items: items.length, today, contentVisibility, newest150 }));
}
await browser.close();
await server.close();
