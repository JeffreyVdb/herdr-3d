// Runs ON THE MAC (piped over ssh by tools/mac-perf.ts, nothing is copied):
// headless Chrome through ~/h3d-tools playwright-core, one page per job, one
// JSON line per job on stdout (bench result, optional base64 PNG).
//   argv[2]: base64 JSON { base, jobs: [{ name, path, floor?, pose?, bench?, shot?, settle?, entry? }] }
//   entry (#141): { floors, rounds }: each floor entered (and left for the city) `rounds` times, timed from enterFloor
//         to the next drawn frame, with the longest long-animation-frame of the 1.5 s after it; the first entry of a
//         floor is cold, the others warm
//   pose: overview | row (on the floor) | street | landing | window (M3b: outside, the top landing, a south window) | laptop (M5: seated at one)
//         mezz | desk (M3c: at the corner office's glass on the mezzanine, seated at your desk)
//         boards (M7: south of the board wall, facing the issues board)
//   overview: { ms } (#145: the overview page alone, the scene stopped: `overview()` below)
//   startup: { launches } (#146: `startup()` below: Chrome launched that many times on one profile, fresh at the first)
/** #141: floor entries timed in the page (see the header). */
async function entries(page, { floors, rounds }) {
  await page.evaluate(() => {
    window.__loaf = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__loaf.push({ at: e.startTime, ms: e.duration });
    }).observe({ type: 'long-animation-frame', buffered: false });
  });
  const out = [];
  const seen = new Set();
  for (let r = 0; r < rounds; r++) {
    for (const floor of floors) {
      const e = await page.evaluate(async (fl) => {
        const f0 = window.__h3d.frames;
        const t0 = performance.now();
        await window.__h3d.enterFloor(fl);
        await new Promise((res) => {
          const chk = () => (window.__h3d.frames > f0 ? res() : requestAnimationFrame(chk));
          requestAnimationFrame(chk);
        });
        const first = performance.now() - t0;
        await new Promise((res) => setTimeout(res, 1500));
        const loafs = window.__loaf.filter((x) => x.at + x.ms >= t0 && x.at <= t0 + 1500).map((x) => x.ms);
        return { firstFrameMs: Math.round(first), maxLoafMs: Math.round(Math.max(0, ...loafs)) };
      }, floor);
      out.push({ floor, cold: !seen.has(floor), ...e });
      seen.add(floor);
      await page.evaluate(() => window.__h3d.leaveFloor());
      await page.waitForTimeout(800);
    }
  }
  return out;
}

/**
 * #146: start-up, on Chrome launched `launches` times one after the other on one profile (fresh at the first launch, so
 * the second shows what Chrome kept on disk: the HTTP cache, compiled code, WebGPU's pipeline cache). Each launch loads
 * the page once: `__h3d.startup` (the first frame that drew the city, ready, the renderer's programs then) and the
 * long animation frames until ready: the one that drew the city first, and the longest. A build from before #146 has
 * no `startup`: ready is timed here, and its first city frame is the one ready came with (it drew the city whole).
 */
async function startup(path, { launches }) {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'h3d-startup-'));
  const out = [];
  try {
    for (let i = 0; i < launches; i++) {
      const ctx = await chromium.launchPersistentContext(dir, { executablePath: exe, headless: true, args: ARGS, viewport: { width: 1512, height: 945 }, deviceScaleFactor: 2 });
      try {
        const page = ctx.pages()[0] ?? (await ctx.newPage());
        await page.addInitScript(() => {
          // When `ready` turns true, whatever the build reports itself.
          let real;
          Object.defineProperty(window, '__h3d', {
            configurable: true,
            get: () => real,
            set(v) {
              real = v;
              let ready = v.ready;
              Object.defineProperty(v, 'ready', { get: () => ready, set: (x) => ((ready = x), x && (window.__readyAt ??= performance.now())) });
            },
          });
          window.__loaf = [];
          new PerformanceObserver((l) => {
            for (const e of l.getEntries()) window.__loaf.push({ at: e.startTime, ms: e.duration });
          }).observe({ type: 'long-animation-frame', buffered: true });
        });
        await page.goto(cfg.base + path);
        await page.waitForFunction(() => window.__h3d?.error || (window.__h3d?.ready && window.__h3d.frames > 2), null, { timeout: 90_000 });
        await page.waitForTimeout(300);
        out.push(
          await page.evaluate((launch) => {
            const s = window.__h3d.startup ?? { cityAt: window.__readyAt, readyAt: window.__readyAt, cityPrograms: null, readyPrograms: null };
            const upTo = window.__loaf.filter((x) => s.readyAt !== null && x.at <= s.readyAt);
            const city = s.cityAt === null ? undefined : window.__loaf.find((x) => x.at <= s.cityAt && x.at + x.ms >= s.cityAt - 1);
            const r = (x) => (x === null || x === undefined ? null : Math.round(x));
            return {
              launch,
              backend: window.__h3d.backend,
              error: window.__h3d.error,
              cityAtMs: r(s.cityAt),
              readyMs: r(s.readyAt),
              cityPrograms: s.cityPrograms,
              readyPrograms: s.readyPrograms,
              cityFrameMs: r(city?.ms ?? 0),
              longestFrameMs: r(Math.max(0, ...upTo.map((x) => x.ms))),
            };
          }, i + 1),
        );
      } finally {
        await ctx.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

const cfg = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8'));
const { chromium } = await import('playwright-core');
const exe = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * #145: the overview page alone. The scene is stopped first (the document reads as hidden, so the app stops its frame
 * loop as for a hidden tab); then O opens the page four times (closed between): the time from the key to the end of
 * the first frame after it, the first open and again; then the open page is left alone for `ms`: the renderer's main
 * thread per second and per frame (this Chrome runs without vsync, so its frame rate is its own), and its layers.
 */
async function overview(page, o) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.__h145 = [];
    addEventListener('keydown', (e) => e.code === 'KeyO' && requestAnimationFrame(() => setTimeout(() => window.__h145.push(Math.round((performance.now() - e.timeStamp) * 10) / 10))), true);
  });
  await page.waitForTimeout(500);
  const shown = () => page.waitForFunction(() => window.__h3d.overview()?.page?.open && !document.querySelector('.ov.ov--enter'), null, { timeout: 10_000 });
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('KeyO');
    await shown();
    if (i === 3) break;
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__h3d.overview()?.page?.open, null, { timeout: 10_000 });
    await page.waitForTimeout(1000);
  }
  const opens = await page.evaluate(() => window.__h145);
  const cdp = await page.context().newCDPSession(page);
  let layers = [];
  cdp.on('LayerTree.layerTreeDidChange', (e) => e.layers && (layers = e.layers));
  await cdp.send('LayerTree.enable');
  await cdp.send('Performance.enable');
  await page.waitForTimeout(1000);
  const m = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  await page.evaluate(() => {
    window.__h145f = 0;
    const tick = () => (window.__h145f++, requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
  const a = await m();
  await page.waitForTimeout(o.ms);
  const b = await m();
  const frames = await page.evaluate(() => window.__h145f);
  const per = (k, n) => Math.round(((b[k] - a[k]) / n) * (k.endsWith('Duration') ? 1e6 : 1e3)) / 1e3;
  const keys = ['TaskDuration', 'RecalcStyleDuration', 'RecalcStyleCount', 'LayoutDuration', 'LayoutCount'];
  const s = o.ms / 1000;
  return {
    rows: await page.evaluate(() => window.__h3d.overview()?.page?.rows.length),
    openMs: { first: opens[0], again: opens.slice(1) },
    seconds: s,
    frames,
    // Durations in ms, counts as counts: per second, and per frame.
    perSecond: Object.fromEntries(keys.map((k) => [k, per(k, s)])),
    perFrame: Object.fromEntries(keys.map((k) => [k, per(k, frames)])),
    layers: layers.length,
  };
}

const ARGS = ['--enable-unsafe-webgpu', '--disable-frame-rate-limit', '--disable-gpu-vsync'];
const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ARGS,
});
try {
  for (const job of cfg.jobs) {
    if (job.startup) {
      const out = { job: job.name };
      try {
        out.startup = await startup(job.path, job.startup);
      } catch (e) {
        out.failed = String(e && e.message ? e.message : e);
      }
      console.log(JSON.stringify(out));
      continue;
    }
    const page = await browser.newPage({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 2 });
    const logs = [];
    page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && logs.push(`console: ${m.text()}`));
    const out = { job: job.name };
    try {
      await page.goto(cfg.base + job.path);
      await page.waitForFunction(() => window.__h3d?.error || (window.__h3d?.ready && window.__h3d.frames > 2), null, { timeout: 90_000 });
      out.backend = await page.evaluate(() => window.__h3d.backend);
      out.error = await page.evaluate(() => window.__h3d.error);
      out.secure = await page.evaluate(() => window.isSecureContext);
      if (job.floor) await page.evaluate((s) => window.__h3d.enterFloor(s), job.floor);
      if (job.pose) {
        await page.evaluate(
          ([floor, kind]) => {
            const L = window.__h3d.layout(floor);
            if (!L) return;
            if (kind === 'overview') {
              // Lobby side of the desk grid, looking north over every pod row.
              const z = Math.max(...L.slots.map((s) => s.seat.z)) + 1.1;
              window.__h3d.setPose({ x: L.width / 2 + 0.3, z, yaw: 0, pitch: -0.2 });
            } else if (kind === 'mezz' || kind === 'desk') {
              // M3c: up on the mezzanine, at the west glass or at your desk, looking down over the floor.
              const B = window.__h3d.building();
              const w = window.__h3d.where();
              if (!B || !w) return;
              const m = L.mezzanine;
              const y = (w.floors.indexOf(floor) + 1) * B.storey + m.y;
              if (kind === 'desk') {
                window.__h3d.setPose({ x: m.sit.x, z: m.sit.z, y, yaw: m.sit.yaw, pitch: m.sit.pitch });
                window.__h3d.sit();
              } else window.__h3d.setPose({ x: m.rect.x0 + 0.45, z: m.rect.z1 - 1.2, y, yaw: m.sit.yaw, pitch: -0.4 });
            } else if (kind === 'laptop') {
              // M5: seated at the laptop of the worker nearest the lobby side, looking at its terminal.
              const z = Math.max(...L.slots.map((s) => s.seat.z)) + 1.1;
              window.__h3d.setPose({ x: L.width / 2 + 0.3, z, yaw: 0, pitch: -0.2 });
              const f = window.__h3d.world().find((x) => x.session === floor);
              const near = f?.workers.map((w) => ({ w, s: L.slots[w.desk] })).filter((x) => x.s).sort((a, b) => b.s.seat.z - a.s.seat.z)[0];
              if (near) window.__h3d.sitAt(near.w.id);
            } else if (kind === 'boards') {
              // M7: three metres from the issues board (the room is 4.1 m deep there), level with it: the corkboard and half the PR board in view.
              const b = L.props.find((p) => p.id === 'board.issues');
              if (b) window.__h3d.setPose({ x: (b.box.min[0] + b.box.max[0]) / 2 + 1.2, z: b.box.max[2] + 3, yaw: 0, pitch: 0.02 });
            } else if (kind === 'row') {
              const s = L.slots[6];
              window.__h3d.setPose({ x: s.seat.x + 1.2, z: s.seat.z + 2.6, yaw: 0.35, pitch: -0.12 });
            } else {
              // M3b: outside the building of this floor (see window.__h3d.building()).
              const B = window.__h3d.building();
              if (!B) return;
              const e = B.escape;
              const top = B.floors * B.storey;
              const dz = (e.door.z0 + e.door.z1) / 2;
              if (kind === 'street') window.__h3d.setPose({ x: B.width / 2 - 1, z: B.depth + 5.8, y: 0, yaw: 0.5, pitch: 0.32 });
              else if (kind === 'landing') window.__h3d.setPose({ x: (e.inner.x0 + e.inner.x1) / 2, z: dz, y: top, yaw: 0.3, pitch: -0.45 });
              else if (kind === 'window') window.__h3d.setPose({ x: 3.2, z: B.depth - 0.9, y: top, yaw: Math.PI, pitch: -0.45 });
            }
          },
          [job.floor, job.pose],
        );
      }
      await page.waitForTimeout(job.settle ?? 1500);
      if (job.entry) out.entries = await entries(page, job.entry);
      if (job.bench) out.bench = await page.evaluate((o) => window.__h3d.bench(o), job.bench);
      if (job.overview) out.overview = await overview(page, job.overview);
      if (job.shot) out.png = (await page.screenshot()).toString('base64');
    } catch (e) {
      out.failed = String(e && e.message ? e.message : e);
    }
    out.logs = logs;
    console.log(JSON.stringify(out));
    await page.close();
  }
} finally {
  await browser.close();
}
