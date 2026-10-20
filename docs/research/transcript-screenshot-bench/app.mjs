// #125: the screenshot-heavy transcript in the full game (3D scene, seat, conversation view, prints), cold and warm.
//
//   make screenshot-bench CORPUS=/private/corpus      (builds the game, leases the port, runs this)
//   portlease run --project herdr-3d --worktree . --name preview --service screenshot-bench -- \
//     node docs/research/transcript-screenshot-bench/app.mjs /private/corpus [--reps N] [--policy new,legacy]
//
// The corpus is capture.mjs's directory (watch.json, refs.json, capture-results.json, images/, thumbs/). The world is
// the e2e fixture bridge's demo-m5 (sim=1); you sit at Tofu, whose transcript.watch / page / item / images are
// answered with the captured conversation (page.routeWebSocket, as the e2e specs patch the fixture), and whose
// transcript.image comes from `thumbs.go serve`: a real imgcache.Cache with a fresh cache directory, so the bridge's
// cache states are real ones: cold (empty directory), restart (memory lost, disk kept) and memory (warm process).
// `--policy legacy` serves the code before #125 (PNG BestSpeed, previews in memory only) for comparison. The browser
// is cold in a new context, warm when you stand up and sit down again in the same page (which asks the bridge for
// nothing: its ImageFeed still holds the previews). Run on the GPU the page reports (printed). What it does not include:
// the bridge's transcript parsing and its websocket (the watch is the captured one), and network delay.
//
// It prints aggregates only (no image bytes, hashes or text) and writes them to <corpus>/app-results.json.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const game = join(root, 'game');
const { preview } = await import(pathToFileURL(join(game, 'node_modules/vite/dist/node/index.js')));
const { chromium } = await import(pathToFileURL(join(game, 'node_modules/@playwright/test/index.mjs')));

const args = process.argv.slice(2);
const corpus = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a) && !/^(new|legacy)(,(new|legacy))*$/.test(a));
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const reps = Number(opt('reps', '1'));
const policies = opt('policy', 'legacy,new').split(',');
const port = Number(process.env.PORTLEASE_PREVIEW_PORT);
if (!corpus || !port) {
  console.error('usage: portlease run ... --name preview -- node app.mjs /private/corpus [--reps N] [--policy legacy,new]');
  process.exit(2);
}
if (!existsSync(join(game, 'dist/index.html'))) {
  console.error('no game/dist: run `make game-build` first (make screenshot-bench does)');
  process.exit(2);
}

const watch = JSON.parse(await readFile(join(corpus, 'watch.json'), 'utf8'));
const refs = JSON.parse(await readFile(join(corpus, 'refs.json'), 'utf8'));
delete watch._wire;
delete refs._wire;
watch.has_more = false;

// --- the image servers ---

const work = await mkdtemp(join(tmpdir(), 'h3d-app-bench-'));
const bin = join(work, 'thumbs');
execFileSync('go', ['build', '-o', bin, 'docs/research/transcript-screenshot-bench/thumbs.go'], { cwd: root, stdio: 'inherit' });

function startServer(policy) {
  const p = spawn(bin, ['serve', ...(policy === 'legacy' ? ['-legacy'] : []), corpus], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((ok, fail) => {
    p.on('error', fail);
    p.stdout.on('data', (b) => {
      const m = /listening (\S+)/.exec(String(b));
      if (m) ok({ proc: p, url: `http://${m[1]}` });
    });
  });
}

// --- the page ---

const NOON = '2026-09-30T12:00';
const CHROMIUM_ARGS = (process.env.H3D_BENCH_CHROMIUM_ARGS ?? (process.platform === 'linux' ? '--use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist' : '--ignore-gpu-blocklist'))
  .split(' ')
  .filter(Boolean);

/** A new context and page in the game, the conversation of Tofu answered from the corpus, its images from `img`. */
async function newPage(browser, img, live) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let tofu = '';
  const counts = { thumbs: 0, full: 0, bytes: 0 };
  await page.routeWebSocket(/\/fixture\//, (ws) => {
    const server = ws.connectToServer();
    live.push = (frame) => ws.send(JSON.stringify(frame));
    server.onMessage((m) => {
      if (typeof m === 'string' && !tofu) {
        const f = JSON.parse(m);
        const w = f.t === 'world.snapshot' ? f.world.workers.find((x) => x.name === 'Tofu') : null;
        if (w) tofu = w.id;
      }
      ws.send(m);
    });
    ws.onMessage(async (m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (!f || !tofu || f.args?.id !== tofu || !String(f.t).startsWith('transcript.') || f.args?.child) return server.send(m);
      const ack = (data) => ws.send(JSON.stringify({ t: 'ack', req_id: f.req_id, data }));
      switch (f.t) {
        case 'transcript.watch':
          live.items = structuredClone(watch.items);
          return ack(structuredClone(watch));
        case 'transcript.unwatch':
          return ack(undefined);
        case 'transcript.page':
          return ack({ items: [], cursor: 'c:1', has_more: false });
        case 'transcript.images':
          return ack(structuredClone(refs));
        case 'transcript.item': {
          const it = (live.items ?? watch.items).find((x) => x.id === f.args.item);
          return it ? ack({ item: it }) : ws.send(JSON.stringify({ t: 'error', req_id: f.req_id, code: 'not_found', message: 'no item' }));
        }
        case 'transcript.image': {
          const size = f.args.size === 'full' ? 'full' : 'thumb';
          const r = await fetch(`${img.url}/${size}?hash=${f.args.hash}`);
          if (!r.ok) return ws.send(JSON.stringify({ t: 'error', req_id: f.req_id, code: 'not_found', message: 'the image is not available' }));
          const data = await r.json();
          counts[size === 'full' ? 'full' : 'thumbs']++;
          counts.bytes += data.bytes;
          return ack(data);
        }
      }
      return server.send(m);
    });
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.goto(`http://127.0.0.1:${port}/?backend=webgl2&ws=${encodeURIComponent('/fixture/demo-m5?play=none&sim=1&simms=500&simusage=0')}&time=${NOON}`);
  await page.waitForFunction(() => window.__h3d?.error || (window.__h3d?.ready && window.__h3d.frames >= 3), undefined, { timeout: 90_000 });
  const err = await page.evaluate(() => window.__h3d.error);
  if (err) throw new Error(`the game did not start: ${err}`);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await page.waitForFunction(() => window.__h3d.world().flatMap((f) => f.workers).some((w) => w.name === 'Tofu'));
  const gpu = await page.evaluate(() => {
    const g = document.createElement('canvas').getContext('webgl2');
    const ext = g?.getExtension('WEBGL_debug_renderer_info');
    return ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  return { ctx, page, cdp, errors, counts, gpu, tofu: () => tofu };
}

/**
 * The in-page recorder: frame times (rAF), long tasks, and per thumbnail when it first became visible (an
 * IntersectionObserver against the screen, which the scroller clips) and when its picture loaded. Nothing in it reads
 * layout per frame.
 */
function installRecorder() {
  const b = (window.__bench = { frames: [], long: [], seen: new Map(), shown: new Map(), on: true });
  const tick = (t) => {
    if (!b.on) return;
    b.frames.push(t);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  b.po = new PerformanceObserver((l) => b.long.push(...l.getEntries().map((e) => e.duration)));
  b.po.observe({ type: 'longtask' });
  b.io = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting && !b.seen.has(e.target)) b.seen.set(e.target, performance.now());
  });
  const add = (el) => {
    b.io.observe(el);
    if (el.classList.contains('tx-imgcard')) b.shown.set(el, performance.now());
    const img = el.querySelector('img');
    if (img?.complete && img.naturalWidth > 0) b.shown.set(el, performance.now());
  };
  document.querySelectorAll('.seat-transcript .tx-thumb, .seat-transcript .tx-imgcard').forEach(add);
  b.mo = new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) [n, ...n.querySelectorAll('.tx-thumb, .tx-imgcard')].filter((x) => x.matches('.seat-transcript .tx-thumb, .seat-transcript .tx-imgcard')).forEach(add);
  });
  b.mo.observe(document.body, { childList: true, subtree: true });
  b.onload = (e) => {
    const btn = e.target instanceof HTMLImageElement && e.target.closest('.tx-thumb');
    if (btn && !b.shown.has(btn)) b.shown.set(btn, performance.now());
  };
  document.addEventListener('load', b.onload, true);
}

/** What the recorder saw since `from` (performance.now()), and stops it. */
function readRecorder(from) {
  const b = window.__bench;
  b.on = false;
  b.po.disconnect();
  b.io.disconnect();
  b.mo.disconnect();
  document.removeEventListener('load', b.onload, true);
  const f = b.frames.filter((t) => t >= from);
  const gaps = f.slice(1).map((t, i) => t - f[i]);
  const lat = [];
  let never = 0;
  for (const [el, seen] of b.seen) {
    if (seen < from) continue;
    const shown = b.shown.get(el);
    if (shown === undefined) never++;
    else lat.push(Math.max(0, shown - seen));
  }
  return { gaps, lat, never, long: b.long };
}

const q = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10;
};
const summ = (gaps) => ({ frames: gaps.length, p50: q(gaps, 0.5), p95: q(gaps, 0.95), p99: q(gaps, 0.99), max: q(gaps, 1), over50: gaps.filter((g) => g > 50).length });

/** Inclusive ms of the functions named `name` in a CDP CPU profile, and the busy (non-idle) ms. */
function profileTime(profile, names) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const out = Object.fromEntries(names.map((n) => [n, 0]));
  let busy = 0;
  profile.samples.forEach((id, i) => {
    const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000;
    const top = byId.get(id)?.callFrame.functionName;
    if (top !== '(idle)' && top !== '(program)') busy += dt;
    const hit = new Set();
    for (let n = id; n !== undefined; n = parent.get(n)) {
      const fn = byId.get(n)?.callFrame.functionName;
      if (fn in out) hit.add(fn);
    }
    for (const fn of hit) out[fn] += dt;
  });
  return { busyMs: Math.round(busy), ...Object.fromEntries(Object.entries(out).map(([k, v]) => [`${k}Ms`, Math.round(v * 10) / 10])) };
}

/** Sits at Tofu and measures: opening, a scroll to the top and back at a steady speed, then live updates. */
async function session(h, live) {
  const { page, cdp } = h;
  const id = h.tofu();
  if (await page.evaluate(() => window.__h3d.seated())) {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__h3d.seated());
  }
  if (!(await page.evaluate((i) => window.__h3d.face(i), id))) throw new Error('cannot face Tofu');
  await page.waitForFunction((n) => window.__h3d.frames >= n, (await page.evaluate(() => window.__h3d.frames)) + 5);
  const before = { ...h.counts };
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  await page.evaluate(installRecorder);
  const t0 = await page.evaluate((i) => {
    const t = performance.now();
    window.__h3d.sitAt(i);
    return t;
  }, id);
  // Opening: until the view is mounted and every thumbnail in the first screen is shown (or 20 s).
  const open = await page.evaluate(
    async ({ t0 }) => {
      const until = (f, ms) =>
        new Promise((ok) => {
          const end = performance.now() + ms;
          const step = () => (f() || performance.now() > end ? ok(performance.now()) : requestAnimationFrame(step));
          step();
        });
      const mounted = (await until(() => document.querySelector('.seat-transcript .tx .tx-scroll')?.childElementCount, 20_000)) - t0;
      await new Promise((r) => setTimeout(r, 300));
      const b = window.__bench;
      const ready = (await until(() => [...b.seen.keys()].every((el) => b.shown.has(el)), 20_000)) - t0;
      return { mountedMs: Math.round(mounted), firstScreenThumbs: b.seen.size, firstScreenShownMs: Math.round(ready) };
    },
    { t0 },
  );
  const tOpen = await page.evaluate(() => performance.now());
  const opening = await page.evaluate((f) => {
    const b = window.__bench;
    const f2 = b.frames.filter((t) => t >= f);
    return f2.slice(1).map((t, i) => t - f2[i]);
  }, t0);
  // Traversal: to the top at 2 screens a second, then back to the bottom (the conversation's images, warm or not).
  const traverse = await page.evaluate(async () => {
    const sc = document.querySelector('.seat-transcript .tx .tx-scroll');
    const speed = (2 * sc.clientHeight) / 1000;
    const glide = (from, to) =>
      new Promise((ok) => {
        const t0 = performance.now();
        const step = (t) => {
          const y = from + Math.sign(to - from) * Math.min(Math.abs(to - from), speed * (t - t0));
          sc.scrollTop = y;
          if (y === to) ok();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    const start = performance.now();
    const bottom = sc.scrollTop;
    await glide(bottom, 0);
    await new Promise((r) => setTimeout(r, 500));
    const up = performance.now() - start;
    await glide(0, sc.scrollHeight - sc.clientHeight);
    await new Promise((r) => setTimeout(r, 500));
    return { scrollHeight: sc.scrollHeight, viewport: sc.clientHeight, upMs: Math.round(up), thumbs: sc.querySelectorAll('.tx-thumb').length };
  });
  const rec = await page.evaluate(`(${readRecorder})(${tOpen})`);
  // Live updates: six items with images arrive half a second apart (the images already fetched: what regroup costs).
  await page.evaluate(installRecorder);
  const tLive = await page.evaluate(() => performance.now());
  const withImages = (live.items ?? watch.items).filter((it) => it.tool?.images?.length);
  let seq = Math.max(...(live.items ?? watch.items).map((it) => it.seq));
  for (let i = 0; i < 6; i++) {
    const src = withImages[i % withImages.length];
    const it = { ...structuredClone(src), id: `bench-live-${Date.now()}-${i}`, seq: ++seq, ts: Date.now() };
    live.items?.push(it);
    live.push({ t: 'transcript.items', id, items: [it], updates: [] });
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 500));
  const liveRec = await page.evaluate(`(${readRecorder})(${tLive})`);
  const { profile } = await cdp.send('Profiler.stop');
  const mem = await cdp.send('Performance.getMetrics').catch(() => null);
  const heap = mem?.metrics?.find((m) => m.name === 'JSHeapUsedSize')?.value;
  return {
    ...open,
    openingFrameGaps: summ(opening),
    traverse: { scrollHeight: traverse.scrollHeight, viewport: traverse.viewport, thumbs: traverse.thumbs, upMs: traverse.upMs },
    visibleThumbLatency: { thumbs: rec.lat.length + rec.never, p50: q(rec.lat, 0.5), p95: q(rec.lat, 0.95), max: q(rec.lat, 1), neverShown: rec.never, waited: rec.lat.filter((x) => x > 17).length },
    scrollFrameGaps: summ(rec.gaps),
    scrollLongTasks: { count: rec.long.length, max: q(rec.long, 1) },
    liveFrameGaps: summ(liveRec.gaps),
    requests: { thumbs: h.counts.thumbs - before.thumbs, full: h.counts.full - before.full, bytes: h.counts.bytes - before.bytes },
    profile: profileTime(profile, ['regroup']), // a method keeps its name in the bundle; top-level functions do not
    jsHeapMB: heap ? Math.round(heap / 1e5) / 10 : null,
  };
}

// --- the matrix ---

const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
const server = await preview({ root: game, configFile: join(game, 'vite.config.ts'), logLevel: 'warn', preview: { host: '127.0.0.1', port, strictPort: true } });
const results = [];
let gpu = '';
const browserVersion = browser.version();
try {
  for (let rep = 0; rep < reps; rep++) {
    for (const policy of policies) {
      const img = await startServer(policy);
      const reset = async (bridge) => {
        const r = await fetch(`${img.url}/reset?bridge=${bridge}`);
        if (!r.ok) throw new Error(await r.text());
      };
      const bridgeStats = async () => (await fetch(`${img.url}/stats?clear=1`)).json();
      const run = async (h, live, bridge, browserState) => {
        await bridgeStats(); // what the page fetched before sitting (its desk's prints) is not this session's
        const r = await session(h, live);
        const s = await bridgeStats();
        results.push({ rep, policy, bridge, browser: browserState, ...r, bridgeThumbMs: s.thumb_ms ?? null });
        const v = results.at(-1);
        console.log(
          `${policy.padEnd(6)} bridge ${bridge.padEnd(7)} browser ${browserState.padEnd(4)}  first screen ${v.firstScreenShownMs} ms (${v.firstScreenThumbs} thumbs)  visible-thumb p50/p95/max ${v.visibleThumbLatency.p50}/${v.visibleThumbLatency.p95}/${v.visibleThumbLatency.max} ms  scroll gaps p95/max ${v.scrollFrameGaps.p95}/${v.scrollFrameGaps.max} ms  live max ${v.liveFrameGaps.max} ms  regroup ${v.profile.regroupMs} ms  ${v.requests.thumbs} thumbs ${Math.round(v.requests.bytes / 1000)} kB`,
        );
      };
      // A cold browser (a new context) through the bridge's states, then the same page warm. A warm page asks the
      // bridge for nothing (its ImageFeed holds the previews), so the bridge's state does not matter to it.
      await reset('cold');
      let live = {};
      let h = await newPage(browser, img, live);
      gpu = h.gpu;
      await run(h, live, 'cold', 'cold');
      await run(h, live, 'memory', 'warm');
      if (h.errors.length) console.error('page errors:', h.errors);
      await h.ctx.close();
      for (const bridge of ['memory', 'restart']) {
        if (bridge === 'restart') await reset('restart');
        live = {};
        h = await newPage(browser, img, live);
        await run(h, live, bridge, 'cold');
        if (h.errors.length) console.error('page errors:', h.errors);
        await h.ctx.close();
      }
      img.proc.kill();
    }
  }
} finally {
  await browser.close();
  await server.close();
  await rm(work, { recursive: true, force: true });
}
// The summary: per policy and state, the median over the reps of each figure.
const med = (xs) => {
  const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};
const cells = new Map();
for (const r of results) {
  const k = `${r.policy} | bridge ${r.bridge} | browser ${r.browser}`;
  cells.set(k, [...(cells.get(k) ?? []), r]);
}
const summary = [...cells].map(([cell, rs]) => ({
  cell,
  reps: rs.length,
  mountedMs: med(rs.map((r) => r.mountedMs)),
  visibleThumbP95Ms: med(rs.map((r) => r.visibleThumbLatency.p95)),
  visibleThumbMaxMs: med(rs.map((r) => r.visibleThumbLatency.max)),
  thumbsWaitedFor: med(rs.map((r) => r.visibleThumbLatency.waited)),
  scrollGapP95Ms: med(rs.map((r) => r.scrollFrameGaps.p95)),
  scrollGapMaxMs: med(rs.map((r) => r.scrollFrameGaps.max)),
  scrollGapsOver50: med(rs.map((r) => r.scrollFrameGaps.over50)),
  openGapMaxMs: med(rs.map((r) => r.openingFrameGaps.max)),
  liveGapMaxMs: med(rs.map((r) => r.liveFrameGaps.max)),
  regroupMs: med(rs.map((r) => r.profile.regroupMs)),
  bridgeThumbP50Ms: med(rs.map((r) => r.bridgeThumbMs?.median_ms)),
  bridgeThumbP95Ms: med(rs.map((r) => r.bridgeThumbMs?.p95_ms)),
  previewKB: med(rs.map((r) => Math.round(r.requests.bytes / 1000))),
  jsHeapMB: med(rs.map((r) => r.jsHeapMB)),
}));
console.log('\nmedian over reps:');
console.table(summary.map(({ cell, ...v }) => ({ cell, ...v })));
const out = { browser: browserVersion, gpu, viewport: '1280x900 DPR 1', summary, results };
await writeFile(join(corpus, 'app-results.json'), JSON.stringify(out, null, 2));
console.log(`GPU: ${gpu}`);
console.log(`raw results: ${join(corpus, 'app-results.json')}`);
