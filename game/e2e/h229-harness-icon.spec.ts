import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// #229 on demo-m118 (the lab floor: Sprout and Juniper orchestrating, their crews, Turnip) and demo-m4 (herdr-3d's
// Claude and Codex laptops). The bridge's Codex labels are added on the way in (the fixtures carry none). The overview
// shows each worker's harness as a white mark before its name (Claude's, OpenAI's for Codex) and under the name the
// model's readable name and effort, nothing else; the wall screen does the same; the laptops' stickers carry the marks.

const SIM = 'play=none&sim=1&simms=150';
const LABELS = { 'gpt-6-sol': 'GPT-6-Sol', 'gpt-6-luna': 'GPT-6-Luna', 'gpt-6-astra': 'GPT-6-Astra' };
const UBUNTU = { 'h3d.theme.ui': 'ubuntu', 'h3d.theme.transcript': 'ubuntu', 'h3d.theme.terminal': 'ubuntu' };

/** The bridge's Codex labels in the snapshot's hire options. */
async function withLabels(page: Page): Promise<void> {
  await page.routeWebSocket(/\/fixture\//, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m !== 'string') return ws.send(m);
      const f = JSON.parse(m);
      if (f.t === 'world.snapshot') {
        const h = (f.world.hire_options ??= {
          claude: { models: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
          codex: { models: Object.keys(LABELS), efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        });
        if (h.codex) h.codex.model_labels = LABELS;
      }
      ws.send(JSON.stringify(f));
    });
  });
}

async function overview(page: Page): Promise<void> {
  await withLabels(page);
  await openGame(page, 'demo-m118', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('lab'));
  await frames(page, 3);
  await page.keyboard.press('KeyO');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.overview()))?.page?.open).toBe(true);
  await expect(page.locator('.ov')).not.toHaveClass(/ov--enter/, { timeout: 5000 });
}

/** Every worker row: its mark's label, its name, its meta line, and the mark's box against the name's. */
const rows = (page: Page) =>
  page.locator('.ov-row--worker').evaluateAll((els) =>
    els.map((r) => {
      const m = r.querySelector('.ov-who > .ov-mark');
      const n = r.querySelector('.ov-name') as HTMLElement;
      const mb = m?.getBoundingClientRect();
      const nb = n.getBoundingClientRect();
      return {
        mark: m?.getAttribute('aria-label') ?? null,
        first: r.querySelector('.ov-who')?.firstElementChild === m,
        name: n.textContent ?? '',
        meta: r.querySelector('.ov-meta')?.textContent ?? '',
        label: r.getAttribute('aria-label') ?? '',
        orch: !!r.querySelector('.ov-tag')?.textContent?.startsWith('ORCH'),
        box: mb ? { h: mb.height, gap: nb.left - mb.right, top: mb.top - nb.top, bottom: nb.bottom - mb.bottom } : null,
      };
    }),
  );

for (const theme of ['quiet', 'ubuntu'] as const) {
  test(`the overview: the harness is a mark before the name, the model its name and effort, no run words (${theme}, #229)`, async ({ page }) => {
    test.setTimeout(150_000);
    const clean = watchErrors(page);
    if (theme === 'ubuntu') await page.addInitScript((kv) => Object.entries(kv).forEach(([k, v]) => localStorage.setItem(k, v)), UBUNTU);
    await overview(page);
    const all = await rows(page);
    expect(all.length).toBeGreaterThan(5);
    for (const r of all) {
      expect(r.mark, r.name).toMatch(/^(Claude|Codex)$/);
      expect(r.first, r.name).toBe(true);
      // The meta line: the model's name and effort only (no harness word, no slug, no phase, round or pass).
      expect(r.meta, r.name).not.toMatch(/claude|codex|opus-5|gpt-6|·|round|pass|waiting|coding|review/i);
      expect(r.meta, r.name).toMatch(/^(Opus|Fable|Sonnet|Haiku) \d(\.\d)? \w+$|^GPT 6 (Sol|Luna|Astra) \w+$/);
      expect(r.label, r.name).toContain(` · ${r.mark} · ${r.meta}`);
      // As tall as the name's capitals, inside the name's line box, close to it.
      expect(r.box!.h).toBeGreaterThanOrEqual(14);
      expect(r.box!.h).toBeLessThanOrEqual(18);
      expect(r.box!.top).toBeGreaterThanOrEqual(0);
      expect(r.box!.bottom).toBeGreaterThanOrEqual(0);
      expect(r.box!.gap).toBeGreaterThanOrEqual(4);
      expect(r.box!.gap).toBeLessThanOrEqual(8);
    }
    expect(all.filter((r) => r.orch).length).toBe(2);
    expect(all.some((r) => r.mark === 'Codex' && r.meta.startsWith('GPT 6 '))).toBe(true);
    expect(all.some((r) => r.mark === 'Claude')).toBe(true);
    // Sprout is over its pass cap: the chip says it, the meta line does not.
    await expect(page.locator('.ov-row', { hasText: 'Sprout' }).locator('.ov-cap')).toHaveText('Over cap');
    // The marks are white.
    expect(await page.locator('.ov-mark').first().evaluate((e) => getComputedStyle(e).fill)).toBe('rgb(255, 255, 255)');
    await shot(page, `h229-overview-${theme}`);
    for (const width of [760, 480]) {
      await page.setViewportSize({ width, height: 900 });
      await frames(page, 2);
      for (const r of await rows(page)) expect(r.first && r.box!.top >= 0 && r.box!.bottom >= 0, `${r.name} at ${width}`).toBe(true);
      await shot(page, `h229-overview-${theme}-${width}`);
    }
    clean();
  });
}

test('the wall screen draws the same marks and meta lines (#229)', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await withLabels(page);
  await openGame(page, 'demo-m118', '', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('lab'));
  await frames(page, 3);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.overview()))?.wall).toMatchObject({ lit: true });
  await page.evaluate(() => {
    const L = window.__h3d.layout('lab');
    const b = L?.props.find((p) => p.id === 'screen.overview')?.box;
    if (!b) throw new Error('no overview screen');
    window.__h3d.setPose({ x: 2.2, z: (b.min[2] + b.max[2]) / 2, yaw: Math.PI / 2, pitch: 0.42 });
  });
  await frames(page, 6);
  await page.waitForTimeout(800);
  await shot(page, 'h229-wall');
  clean();
});

test.describe('the laptop stickers, up close (#229)', () => {
  test.use({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 2 });

  test('a Codex laptop and a Claude one carry the OpenAI and Claude marks', async ({ page }) => {
    test.setTimeout(150_000);
    const clean = watchErrors(page);
    await openGame(page, 'demo-m4', '', SIM);
    await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
    await frames(page, 3);
    const floor = (await page.evaluate(() => window.__h3d.world())).find((f) => f.session === 'herdr-3d');
    const logos = new Set<string>();
    for (const w of floor?.workers ?? []) logos.add((await page.evaluate((d) => window.__h3d.deskArt(d), w.desk))?.sticker?.logo ?? '');
    expect([...logos]).toEqual(expect.arrayContaining(['claude', 'codex']));
    // The aisle between two pods (m6b's sticker view, closer): a Codex laptop on the left, a Claude one on the right.
    const p = await page.evaluate(() => window.__h3d.pose());
    const [x, z, tx, ty, tz] = [10.7, 5.55, 10.7, 0.8, 4.5];
    await page.evaluate(([yaw, pitch, x, z]) => window.__h3d.setPose({ x, z, yaw, pitch }), [Math.atan2(-(tx - x), -(tz - z)), Math.atan2(ty - (p?.eye ?? 1.6), Math.hypot(tx - x, tz - z)), x, z] as const);
    await frames(page, 4);
    await page.waitForTimeout(800);
    await shot(page, 'h229-stickers');
    clean();
  });
});
