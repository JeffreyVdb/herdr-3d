// Renders tools/icon.svg to public/icons/*.png with the Playwright Chromium.
//   any:      rounded square, transparent corners (Dock, Cmd-Tab)
//   maskable: full bleed, content inside the safe zone (Android/ChromeOS masks)
// Run: node tools/icons.mjs   (icons are committed; rerun only when the SVG changes)
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'tools/icon.svg'), 'utf8');
const out = join(root, 'public/icons');
mkdirSync(out, { recursive: true });

const html = (size, radius, scale) => `<!doctype html><body style="margin:0;background:transparent">
<div style="width:${size}px;height:${size}px;border-radius:${radius}px;overflow:hidden;background:#1c2540">
<div style="width:${size}px;height:${size}px;transform:scale(${scale});transform-origin:center">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div></div></body>`;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
const jobs = [
  ['icon-192.png', 192, 0.225, 1],
  ['icon-512.png', 512, 0.225, 1],
  ['icon-maskable-512.png', 512, 0, 0.8],
];
for (const [name, size, radiusFrac, scale] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(html(size, Math.round(size * radiusFrac), scale));
  await page.screenshot({ path: join(out, name), omitBackground: true });
  console.log('wrote', name);
}
await browser.close();
