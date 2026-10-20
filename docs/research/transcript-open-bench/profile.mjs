// CPU profile of one first render (mountTranscript + setItems + first frame) in Chromium: the top self and inclusive
// functions, and the most common element classes. Run from the repo root on one of open.go's private page files:
//   portlease run --project herdr-3d --worktree . --name bench --service transcript-open -- \
//     node docs/research/transcript-open-bench/profile.mjs PRIVATE_OUT_DIR/claude-03.json
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
const { createServer } = await import(pathToFileURL(resolve('game/node_modules/vite/dist/node/index.js')));
const { chromium } = await import(pathToFileURL(resolve('game/node_modules/@playwright/test/index.mjs')));
const [file] = process.argv.slice(2);
const port = Number(process.env.PORTLEASE_BENCH_PORT);
if (!file || !port) throw Error('usage: portlease run ... --name bench -- node profile.mjs PAGE.json');
const server = await createServer({ root: resolve('game'), logLevel: 'error', server: { host: '127.0.0.1', port, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
await page.route('**/__bench', (route) => route.fulfill({ contentType: 'text/html', body: `<style>html,body,#root{height:100%;margin:0}#root{width:1000px}</style><link rel="stylesheet" href="/src/ui/themes.css"><link rel="stylesheet" href="/src/ui/uiTheme.css"><link rel="stylesheet" href="/src/laptop/transcript.css"><div id="root"></div><script type="module">const m=await import('/src/laptop/transcriptRender.ts');window.mountTranscript=m.mountTranscript;window.ready=true;</script>` }));
await page.goto(`http://127.0.0.1:${port}/__bench`);
await page.waitForFunction(() => window.ready);
const items = JSON.parse(await readFile(file, 'utf8')).items;
const kinds = {};
let hidden = 0;
for (const it of items) {
  kinds[it.kind] = (kinds[it.kind] || 0) + 1;
  if (it.hidden) hidden++;
}
console.log('kinds', kinds, 'hidden', hidden);
const run = () =>
  page.evaluate(async (items) => {
    const root = document.getElementById('root');
    const view = window.mountTranscript(root, { onPromptSubmit: async () => true, onAnswer: () => {}, onAnswerAsk: async () => ({ ok: true, resolved: true }), onSwitchToTerminal: () => {}, loadSubagent: async () => [] });
    view.setItems(items);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const counts = {};
    for (const el of root.querySelectorAll('[class]')) counts[el.classList[0]] = (counts[el.classList[0]] || 0) + 1;
    view.destroy();
    root.replaceChildren();
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, items);
await run(); // warm-up
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
const classes = await run();
const { profile } = await cdp.send('Profiler.stop');
console.log('top classes', JSON.stringify(classes));
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
const name = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop().split('?')[0]}:${n.callFrame.lineNumber + 1}`;
const self = new Map();
const incl = new Map();
profile.samples.forEach((id, i) => {
  const ms = (profile.timeDeltas[i] || 0) / 1000;
  self.set(name(byId.get(id)), (self.get(name(byId.get(id))) || 0) + ms);
  const seen = new Set();
  for (let x = id; x !== undefined; x = parent.get(x)) {
    const k = name(byId.get(x));
    if (!seen.has(k)) incl.set(k, (incl.get(k) || 0) + ms);
    seen.add(k);
  }
});
const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${Math.round(v)} ms ${k}`).join('\n');
console.log('SELF\n' + top(self, 15) + '\nINCLUSIVE\n' + top(incl, 30));
await browser.close();
await server.close();
