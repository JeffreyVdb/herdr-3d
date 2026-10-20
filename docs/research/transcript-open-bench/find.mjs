// #126: the open's two promises on synthetic pages, in headless Chromium (no private text): find in page (Ctrl+F's
// `window.find`) finds every changed file's line the view shows open once the open settles, without scrolling; and with
// "Hide tool calls" on, no frame shows the timeline blank while the loader is gone (4x CPU slowdown).
//   portlease run --project herdr-3d --worktree . --name bench --service transcript-open -- \
//     node docs/research/transcript-open-bench/find.mjs
// Prints one JSON line per check and exits non-zero if one fails.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { createServer } = await import(pathToFileURL(resolve('game/node_modules/vite/dist/node/index.js')));
const { chromium } = await import(pathToFileURL(resolve('game/node_modules/@playwright/test/index.mjs')));
const port = Number(process.env.PORTLEASE_BENCH_PORT);
if (!port) throw Error('usage: portlease run ... --name bench -- node find.mjs');
const server = await createServer({ root: resolve('game'), logLevel: 'error', server: { host: '127.0.0.1', port, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error(e.message));
await page.route('**/__find', (route) => route.fulfill({ contentType: 'text/html', body: `<style>html,body,#root{height:100%;margin:0}#root{width:1000px}</style><link rel="stylesheet" href="/src/ui/themes.css"><link rel="stylesheet" href="/src/ui/uiTheme.css"><link rel="stylesheet" href="/src/laptop/transcript.css"><div id="root"></div><script type="module">const m=await import('/src/laptop/transcriptRender.ts');window.mountTranscript=m.mountTranscript;window.ViewPrefs=(await import('/src/ui/themePrefs.ts')).ViewPrefs;window.ready=true;</script>` }));
await page.goto(`http://127.0.0.1:${port}/__find`);
await page.waitForFunction(() => window.ready);
let failed = 0;
const report = (name, ok, r) => {
  if (!ok) failed++;
  console.log(JSON.stringify({ check: name, ok, ...r }));
};

// Changed files open (#21's default) at the top, in the middle and among the newest rows, between 600 prose rows; one
// with 2,100 lines (the first 2,000 show, the rest behind "Show next"). Found from the bottom once the open settled.
const find = await page.evaluate(async () => {
  const at = { top: 0, middle: 300, newest: 590, long: 150 };
  const diff = (tag, n = 3) => ({ path: `src/${tag}.ts`, hunks: [{ old_start: 1, old_lines: 0, new_start: 1, new_lines: n, lines: Array.from({ length: n }, (_, i) => `+const ${tag} = ${i};${i === 1 ? ` // FINDME_${tag.toUpperCase()}` : ''}${i === 1999 ? ' // FINDME_LAST_SHOWN' : ''}${i === 2050 ? ' // FINDME_PAST_CUT' : ''}`) }] });
  const items = [];
  for (let i = 0; i < 600; i++) {
    const tag = Object.keys(at).find((k) => at[k] === i);
    items.push(tag ? { id: `e${i}`, seq: i, ts: 1e12 + i, kind: 'tool', tool: { name: 'Edit', input_summary: `src/${tag}.ts`, status: 'ok', diff: diff(tag, tag === 'long' ? 2100 : 3) } } : { id: `a${i}`, seq: i, ts: 1e12 + i, kind: 'assistant', parts: [{ text: `Synthetic prose row ${i}, long enough to wrap in a narrow view and fill the screen.` }] });
  }
  const root = document.getElementById('root');
  const host = { prefs: new window.ViewPrefs(null), onPromptSubmit: async () => true, onAnswer: () => {}, onAnswerAsk: async () => ({ ok: true }), onSwitchToTerminal: () => {}, loadSubagent: async () => [] };
  const view = window.mountTranscript(root, host);
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const t0 = performance.now();
  view.setItems(items);
  while (root.querySelector('.tx[data-building]')) await new Promise((r) => setTimeout(r, 20));
  const filled = performance.now() - t0;
  while (root.querySelector('.tx[data-drawing]')) await new Promise((r) => setTimeout(r, 20));
  const drawn = performance.now() - t0;
  const s = root.querySelector('.tx-scroll');
  const bottom = s.scrollHeight - s.scrollTop - s.clientHeight;
  const lines = root.querySelectorAll('.tx-dl:not(.tx-dh)').length;
  const found = {};
  for (const w of ['TOP', 'MIDDLE', 'NEWEST', 'LONG', 'LAST_SHOWN', 'PAST_CUT']) {
    getSelection().removeAllRanges();
    s.scrollTop = s.scrollHeight;
    found[w] = window.find(`FINDME_${w}`, true, false, true);
  }
  view.destroy();
  root.replaceChildren();
  return { filled: Math.round(filled), drawn: Math.round(drawn), bottom, lines, found };
});
const f = find.found;
report('find-in-page', f.TOP && f.MIDDLE && f.NEWEST && f.LONG && f.LAST_SHOWN && !f.PAST_CUT && find.lines === 3 * 3 + 2000 && find.bottom <= 1, find);

// "Hide tool calls" on, 4x slower: one assistant row, then 199 finished Bash calls. Every frame from setItems on shows a
// row or the loader.
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
for (const visible of [true, false]) {
  const r = await page.evaluate(async (visible) => {
    const items = [];
    if (visible) items.push({ id: 'a0', seq: 0, ts: 1e12, kind: 'assistant', parts: [{ text: 'The one row that shows.' }] });
    for (let i = 1; i < 200; i++) items.push({ id: `t${i}`, seq: i, ts: 1e12 + i, kind: 'tool', tool: { name: 'Bash', input_summary: `ls ${i}`, status: 'ok', output_text: `out ${i}` } });
    const root = document.getElementById('root');
    const prefs = new window.ViewPrefs(null);
    prefs.hideTools = true;
    const host = { prefs, loading: true, onPromptSubmit: async () => true, onAnswer: () => {}, onAnswerAsk: async () => ({ ok: true }), onSwitchToTerminal: () => {}, loadSubagent: async () => [] };
    const view = window.mountTranscript(root, host);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const frames = [];
    let on = true;
    const look = () => {
      const rows = [...root.querySelectorAll('.tx-list > .tx-item')];
      const shown = rows.filter((e) => e.getClientRects().length > 0).length;
      const loader = !root.querySelector('.txl').hidden;
      frames.push({ rows: rows.length, shown, loader, building: !!root.querySelector('.tx[data-building]') });
      if (on) requestAnimationFrame(look);
    };
    view.setItems(items);
    view.setLoading(false);
    requestAnimationFrame(look);
    while (root.querySelector('.tx[data-building]')) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    on = false;
    const empty = !root.querySelector('.tx-empty').hidden;
    view.destroy();
    root.replaceChildren();
    return { first: frames[0], blank: frames.filter((x) => x.shown === 0 && !x.loader && x.building).length, frames: frames.length, last: frames.at(-1), empty };
  }, visible);
  // Nothing shows: blank as before #126 (no loader, not "No conversation yet.").
  const ok = visible ? r.blank === 0 && r.last.shown > 0 && !r.last.loader : r.last.shown === 0 && !r.last.loader && !r.empty;
  report(visible ? 'hide-tools-loader' : 'hide-tools-nothing-shows', ok, r);
}
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
