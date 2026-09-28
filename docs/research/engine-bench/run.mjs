// usage: node run.mjs <chromePath> <outJsonl> <shotDir> "<query1>" "<query2>" ...
import { chromium } from 'playwright-core'; import fs from 'node:fs'; const BASE = process.env.BASE || 'http://127.0.0.1:18770';
const HEADED = !!process.env.HEADED;
const [exe, out, shotDir, ...queries] = process.argv.slice(2);
const srv = process.env.BASE ? null : await (await import('./serve.mjs')).serve(18770);
const extra = exe.includes('ms-playwright') ? ['--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader', '--enable-features=Vulkan'] : [];
const b = await chromium.launch({ executablePath: exe, headless: !HEADED, args: HEADED ? ['--enable-unsafe-webgpu', ...extra] : ['--enable-unsafe-webgpu', '--disable-frame-rate-limit', '--disable-gpu-vsync', ...extra] });
for (const q of queries) {
  const p = await b.newPage({ viewport: { width: +(process.env.VW||1512), height: +(process.env.VH||945) } });
  const t = Date.now(); await p.goto(BASE + '/?' + q);
  await p.waitForFunction('window.__done', null, { timeout: 600000 });
  const res = await p.evaluate('window.__result'); res.query = q; res.wallS = (Date.now() - t) / 1000; res.log = await p.evaluate('window.__log||[]');
  console.log(JSON.stringify(res)); fs.appendFileSync(out, JSON.stringify(res) + '\n');
  if (q.includes('shot')) await p.screenshot({ path: `${shotDir}/${q.replace(/[^a-z0-9]+/gi, '_')}.png` });
  await p.close();
}
await b.close(); srv?.close();
