// Capability experiment, not the production test suite. Known gaps are recorded, not hidden.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { serve } from './server.mjs';

const server = await serve();
const browser = await chromium.launch({ headless: true });
const results = [];
await mkdir(new URL('artifacts/', import.meta.url), { recursive: true });

async function grid(page) {
  return page.evaluate(() => {
    const term = window.spike.term;
    const node = document.querySelector('#terminal .xterm-screen') || document.querySelector('#terminal canvas');
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, cw: r.width / term.cols, ch: r.height / term.rows, cols: term.cols, rows: term.rows };
  });
}

try {
  for (const engine of ['xterm', 'ghostty', 'ghostty-next']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    console.log(`${engine}: boot, sizing and selection`);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (dialog) => dialog.accept()); // xterm confirms named OSC 8 targets.
    await page.addInitScript(() => {
      window.opened = [];
      window.open = (url) => {
        if (url) window.opened.push(String(url));
        return { opener: null, location: { set href(value) { window.opened.push(value); } } };
      };
    });
    await page.goto(`${server.url}/?engine=${engine}`);
    await page.waitForFunction(() => window.spike?.state.ready && window.spike.state.resizes.length);
    const full = await grid(page);
    await page.locator('#split').click();
    await page.waitForFunction((cols) => window.spike.term.cols < cols && window.spike.state.resizes.at(-1).cols === window.spike.term.cols, full.cols);
    const split = await grid(page);
    const fixedFontOnSplit = Math.abs(full.cw - split.cw) < 0.01 && Math.abs(full.ch - split.ch) < 0.01;
    assert.ok(fixedFontOnSplit, `${engine}: split must not enlarge font`);
    await page.locator('#split').click();
    await page.waitForFunction((cols) => window.spike.term.cols === cols, full.cols);
    // Fresh fixture text at the current width, after the resize round trip.
    await page.reload();
    await page.waitForFunction(() => window.spike?.state.ready);
    const g = await grid(page);
    const point = (col, row) => ({ x: g.x + (col - 0.5) * g.cw, y: g.y + (row - 0.5) * g.ch });
    const start = point(1, 4), end = point(13, 4);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await page.mouse.up();
    const selection = await page.evaluate(() => window.spike.term.getSelection());
    assert.ok(selection.includes('Select'), `${engine}: drag selection`);
    await page.evaluate(() => window.spike.term.clearSelection());
    await page.keyboard.down('Control');
    for (const row of [2, 3]) {
      const p = point(6, row);
      await page.mouse.move(p.x, p.y);
      await page.waitForTimeout(180); // Link detection is scheduled after pointer movement.
      await page.mouse.click(p.x, p.y);
    }
    await page.keyboard.up('Control');
    const links = await page.evaluate(() => window.opened);
    console.log(`${engine}: keyboard and clipboard; links=${JSON.stringify(links)}`);
    await page.evaluate(() => window.spike.term.focus());
    await page.keyboard.type('KEYBOARD');
    await page.waitForFunction(() => window.spike.state.inputs.join('').includes('KEYBOARD'));
    await page.evaluate(() => navigator.clipboard.writeText('PASTE ONE\nPASTE TWO'));
    await page.keyboard.press('Control+Shift+v'); // Linux terminal paste; Ctrl+V is literal ^V in xterm.
    await page.waitForFunction(() => window.spike.state.inputs.join('').includes('PASTE ONE'));
    const pastePacket = await page.evaluate(() => window.spike.state.inputs.find((s) => s.includes('PASTE ONE')));
    // xterm normalizes newlines to CR, Ghostty keeps LF; either is valid within the brackets.
    const bracketedPaste = /^\x1b\[200~PASTE ONE[\r\n]PASTE TWO\x1b\[201~$/.test(pastePacket);
    console.log(`${engine}: history and mouse`);
    await page.locator('#history').click();
    await page.waitForFunction(() => window.spike.state.output.includes('HISTORY END'));
    // Ghostty's buffer adapter viewportY stays zero; its terminal exposes the actual scroll offset.
    const beforeScroll = await page.evaluate(() => window.spike.term.viewportY ?? window.spike.term.buffer.active.viewportY);
    const center = point(30, 12);
    await page.mouse.move(center.x, center.y);
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(250);
    const afterScroll = await page.evaluate(() => window.spike.term.viewportY ?? window.spike.term.buffer.active.viewportY);
    assert.notEqual(beforeScroll, afterScroll, `${engine}: wheel must scroll history`);
    await page.screenshot({ path: new URL(`artifacts/${engine}-history.png`, import.meta.url).pathname });
    await page.evaluate(() => window.spike.term.scrollToBottom());
    await page.locator('#menu').click();
    await page.waitForFunction(() => window.spike.state.output.includes('Mouse-enabled TUI'));
    const option = point(8, 5);
    await page.mouse.click(option.x, option.y);
    await page.waitForTimeout(200);
    const mouse = await page.evaluate(() => ({ input: window.spike.state.inputs.filter((s) => s.includes('\x1b[<')), selected: window.spike.state.output.includes('SELECTED 1 by mouse') }));
    await page.keyboard.press('2');
    await page.waitForFunction(() => window.spike.state.output.includes('SELECTED 2 by keyboard'));
    await page.screenshot({ path: new URL(`artifacts/${engine}-menu.png`, import.meta.url).pathname });
    // RIS is what LaptopTerminal.frame(full) sends: local history cannot survive it.
    await page.evaluate(() => window.spike.send('q'));
    await page.waitForTimeout(100);
    await page.locator('#history').click();
    await page.waitForTimeout(150);
    const historyBeforeReset = await page.evaluate(() => window.spike.term.buffer.active.length);
    await page.evaluate(() => new Promise((resolve) => window.spike.term.write('\x1bcFresh full frame', resolve)));
    const historyAfterReset = await page.evaluate(() => window.spike.term.buffer.active.length);
    results.push({ engine, fixedFontOnSplit, full, split, selection, plainLink: links.includes('https://example.com/plain'), osc8Link: links.includes('https://example.com/osc8'), links, keyboard: true, bracketedPaste, pastePacket, scroll: { before: beforeScroll, after: afterScroll }, mouse, historyBeforeReset, historyAfterReset, errors });
    await context.close();
  }
  await writeFile(new URL('results.json', import.meta.url), `${JSON.stringify({ date: '2026-10-21', environment: 'Linux; headless Playwright Chromium; 1280x900; local Python PTY fixture, not Herdr', results }, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
  assert.ok(results.every((r) => !r.errors.length), 'Unexpected browser errors');
  for (const r of results.filter((r) => r.engine !== 'ghostty')) {
    assert.ok(r.mouse.selected && r.plainLink && r.osc8Link && r.bracketedPaste, `${r.engine}: interactive feature regression`);
  }
} finally {
  await browser.close();
  await server.close();
}
