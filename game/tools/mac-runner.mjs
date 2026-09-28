// Runs ON THE MAC (piped over ssh by tools/mac-perf.ts, nothing is copied):
// headless Chrome through ~/h3d-tools playwright-core, one page per job, one
// JSON line per job on stdout (bench result, optional base64 PNG).
//   argv[2]: base64 JSON { base, jobs: [{ name, path, floor?, pose?, bench?, shot?, settle? }] }
//   pose: overview | row (on the floor) | street | landing | window (M3b: outside, the top landing, a south window)
const cfg = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8'));
const { chromium } = await import('playwright-core');
const exe = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--enable-unsafe-webgpu', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
});
try {
  for (const job of cfg.jobs) {
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
      if (job.bench) out.bench = await page.evaluate((o) => window.__h3d.bench(o), job.bench);
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
