import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { build } from 'vite';
import { frames, openGame, shot, watchErrors } from './game';

// M16: the transcript view (src/laptop/transcriptRender.ts) drawn over a seated laptop on the WebGL2 path.
//
// The renderer is bundled on its own here and mounted over the screen the way the seated view's transcript mode
// does (a container over the monitor, between the top bar and the seat bar), fed a fixture timeline that covers
// every item kind, so the screenshot and the checks do not depend on the bridge side. The host records what the
// view asked for.

const GAME = resolve(import.meta.dirname, '..');
const FLOOR = 'herdr-3d';

/** transcriptRender.ts as one classic script defining `window.__h3dTranscript`, and its CSS. */
async function bundle(): Promise<{ js: string; css: string }> {
  const out = await build({
    configFile: false,
    root: GAME,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      emptyOutDir: false,
      cssCodeSplit: false,
      lib: { entry: resolve(GAME, 'src/laptop/transcriptRender.ts'), formats: ['iife'], name: '__h3dTranscript', fileName: 'transcript' },
    },
  });
  const outputs = (Array.isArray(out) ? out : [out]).flatMap((o) => ('output' in o ? o.output : []));
  const js = outputs.find((o) => o.type === 'chunk');
  const css = outputs.find((o) => o.type === 'asset' && o.fileName.endsWith('.css'));
  if (!js || js.type !== 'chunk') throw new Error('no transcript bundle');
  const source = css && css.type === 'asset' ? css.source : '';
  return { js: `${js.code}\nwindow.__h3dTranscript = __h3dTranscript;`, css: typeof source === 'string' ? source : new TextDecoder().decode(source) };
}

let code: { js: string; css: string };
test.beforeAll(async () => {
  code = await bundle();
});

type Layout = NonNullable<ReturnType<Window['__h3d']['layout']>>;

async function look(page: Page, x: number, z: number, tx: number, ty: number, tz: number): Promise<void> {
  const p = await page.evaluate(() => window.__h3d.pose());
  if (!p) throw new Error('not walking');
  const yaw = Math.atan2(-(tx - x), -(tz - z));
  const pitch = Math.atan2(ty - p.eye, Math.hypot(tx - x, tz - z));
  await page.evaluate(([yy, pp, xx, zz]) => window.__h3d.setPose({ x: xx, z: zz, yaw: yy, pitch: pp }), [yaw, pitch, x, z] as const);
  await frames(page, 2);
}

async function sitAtDesk(page: Page, desk: number): Promise<string> {
  await openGame(page, 'demo-m4', '', 'play=none&sim=1&simms=150');
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const L = (await page.evaluate((s) => window.__h3d.layout(s), FLOOR)) as Layout;
  const s = L.slots[desk];
  if (!s) throw new Error(`no desk ${desk}`);
  await look(page, s.seat.x - Math.sin(s.yaw) * 1.4, s.seat.z - Math.cos(s.yaw) * 1.4, s.seat.x, 0.95, s.seat.z);
  const id = await page.evaluate(() => window.__h3d.lookAt()?.id ?? '');
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
  await expect(page.locator('.seat')).toBeVisible();
  await frames(page, 30);
  return id;
}

/** Mounts the view over the seated screen with a recording host, and feeds it the fixture timeline. */
async function mount(page: Page, worker: string): Promise<void> {
  await page.addStyleTag({ content: code.css });
  await page.addScriptTag({ content: code.js });
  await page.evaluate((id) => {
    type Item = Record<string, unknown>;
    const now = Date.now();
    let seq = 0;
    const it = (kind: string, extra: Item): Item => ({ id: `t${++seq}`, seq, ts: now - (40 - seq) * 20_000, kind, ...extra });
    const items: Item[] = [
      it('user', { parts: [{ text: 'The HUD overlaps the laptop screen on small windows. Can you fix it and add a test?' }, { image_omitted: true }] }),
      it('thinking', { parts: [{ text: 'The seat pose uses `insets()`; the overlap is probably the seat bar height.' }] }),
      it('assistant', { parts: [{ text: "I'll look at how the seated camera is placed. The relevant code is in `seatPose`:\n\n```ts\nconst top = Math.min(H * 0.3, ins.top + 10);\nconst bottom = Math.min(H * 0.35, ins.bottom + 10);\n```" }] }),
      it('tool', { tool: { name: 'Grep', input_summary: 'insets\\(\\) in src/', status: 'ok', output_text: 'src/app.ts:361\nsrc/laptop/index.ts:343' } }),
      it('tool', { tool: { name: 'Read', input_summary: 'src/laptop/index.ts', status: 'ok', output_text: '…' } }),
      it('notice', { notice: { text: 'Turn took 41s' } }),
      it('tool', {
        tool: {
          name: 'Edit',
          input_summary: 'src/laptop/index.ts',
          status: 'ok',
          diff: {
            path: 'src/laptop/index.ts',
            hunks: [{ oldStart: 341, oldLines: 4, newStart: 341, newLines: 4, lines: ['     const H = Math.max(1, window.innerHeight);', '     const ins = this.host.insets();', '-    const top = Math.min(H * 0.3, ins.top + 10);', '+    const top = Math.min(H * 0.3, ins.top + 14);', '     const bottom = Math.min(H * 0.35, ins.bottom + 10);'] }],
          },
        },
      }),
      it('compaction', { notice: { text: 'Conversation compacted' } }),
      it('subagent', { subagent: { agent_id: 'agent-7f3', description: 'Check the other seated overlays', status: 'completed' } }),
      it('tool', { tool: { name: 'Bash', input_summary: 'pnpm vitest run src/laptop', status: 'error', output_text: '\u001b[31m FAIL \u001b[39m src/laptop/keys.test.ts > seatedKey\n\u001b[2mAssertionError: expected none(true)\u001b[22m\n\n Tests  1 failed | 41 passed', output_truncated: false } }),
      it('assistant', { parts: [{ text: 'One test fails because of **the Esc mapping**. See <script>window.__pwned = 1</script> [details](javascript:window.__pwned=2) and <img src=x onerror="window.__pwned=3">.' }] }),
      it('tool', { tool: { name: 'Bash', input_summary: 'pnpm vitest run src/laptop --reporter dot', status: 'running' } }),
      it('unknown', { raw_type: 'queue-operation' }),
    ];
    const calls: unknown[][] = [];
    const container = document.createElement('div');
    container.id = 'tx-e2e';
    // Over the monitor: the screen fills the height between the top bar and the seat bar, at the glass's aspect.
    const H = window.innerHeight;
    const W = window.innerWidth;
    const hud = document.querySelector<HTMLElement>('.hud');
    const topbar = parseFloat(hud?.style.getPropertyValue('--topbar-bottom') ?? '') || 70;
    const seat = document.querySelector('.seat')?.getBoundingClientRect().height ?? 60;
    const top = Math.min(H * 0.3, topbar + 10);
    const bottom = Math.min(H * 0.35, seat + 18 + 10);
    const mesh = window.__h3d.screenMesh(id);
    const aspect = mesh ? mesh.size.width / mesh.size.height : 1.6;
    const height = H - top - bottom;
    const width = Math.min(W * 0.94, height * aspect);
    Object.assign(container.style, { position: 'fixed', left: `${(W - width) / 2}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`, zIndex: '5', borderRadius: '4px', overflow: 'hidden' });
    document.body.append(container);
    const mod = (window as unknown as { __h3dTranscript: { mountTranscript: (c: HTMLElement, h: unknown) => unknown } }).__h3dTranscript;
    const view = mod.mountTranscript(container, {
      onPromptSubmit: (t: string) => calls.push(['prompt', t]),
      onAnswer: (hash: string, n: number | null, cancel?: boolean) => calls.push(['answer', hash, n, cancel ?? false]),
      onSwitchToTerminal: () => calls.push(['terminal']),
      loadSubagent: async (agent: string) => {
        calls.push(['load', agent]);
        return [
          { id: 's1', seq: 1, ts: now, kind: 'assistant', parts: [{ text: 'Checked `changes.ts` and `prompt.ts`: both use the same insets.' }] },
          { id: 's2', seq: 2, ts: now, kind: 'tool', tool: { name: 'Glob', input_summary: 'src/ui/*.ts', status: 'ok' } },
        ];
      },
    }) as { setItems(i: unknown[]): void; applyUpdates(i: unknown[]): void; setBlocked(q: unknown): void; focusPrompt(): void };
    view.setItems(items);
    Object.assign(window, { __tx: { view, calls } });
  }, worker);
}

test('transcript mode over a seated laptop: every kind renders, untrusted text stays inert, the banner answers', async ({ page }) => {
  const clean = watchErrors(page);
  const worker = await sitAtDesk(page, 0);
  await mount(page, worker);
  const tx = page.locator('#tx-e2e .tx');
  await expect(tx).toBeVisible();
  const txCalls = () => page.evaluate(() => (window as unknown as { __tx: { calls: unknown[][] } }).__tx.calls);

  // Rows: user bubble with the image placeholder, collapsed reasoning, tools, a divider; notices hidden.
  await expect(tx.locator('.tx-user .tx-bubble')).toContainText('HUD overlaps');
  await expect(tx.locator('.tx-img-chip')).toHaveText(/image — not shown yet/);
  await expect(tx.locator('.tx-thinking-body')).toBeHidden();
  await expect(tx.locator('.tx-compaction')).toBeVisible();
  await expect(tx.locator('.tx-notice')).toBeHidden();
  await expect(tx.locator('.tx-unknown')).toBeHidden();
  await expect(tx.locator('.tx-tool[data-status="running"] .tx-tool-status')).toHaveText('running');

  // Expand the edit (a coloured diff), the failing command (ANSI stripped) and the subagent (loaded, nested).
  await tx.locator('.tx-tool', { hasText: 'Edit' }).locator('.tx-tool-row').click();
  await expect(tx.locator('.tx-diff .tx-add')).toHaveCount(1);
  await expect(tx.locator('.tx-diff .tx-del')).toHaveCount(1);
  const addBg = await tx.locator('.tx-diff .tx-add').evaluate((e) => getComputedStyle(e).backgroundColor);
  const delBg = await tx.locator('.tx-diff .tx-del').evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(addBg).not.toBe(delBg);
  await tx.locator('.tx-tool[data-status="error"] .tx-tool-row').click();
  await expect(tx.locator('.tx-tool[data-status="error"] .tx-out')).toContainText('FAIL  src/laptop/keys.test.ts');
  expect(await tx.locator('.tx-tool[data-status="error"] .tx-out').textContent()).not.toContain('\u001b');
  await tx.locator('.tx-sub-row').click();
  await expect(tx.locator('.tx-nested')).toContainText('both use the same insets');
  expect(await txCalls()).toEqual([['load', 'agent-7f3']]);

  // Untrusted markdown: nothing ran, nothing live.
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await tx.locator('script, img, [onerror], a[href^="javascript"]').count()).toBe(0);

  // Code blocks get highlighted once the lazy highlighter loads.
  await expect(tx.locator('.tx-said pre code.hljs')).toHaveCount(1, { timeout: 15_000 });

  // A blocked worker: the banner with numbered chips.
  await page.evaluate(() =>
    (window as unknown as { __tx: { view: { setBlocked(q: unknown): void } } }).__tx.view.setBlocked({
      kind: 'permission',
      text: 'Allow Bash to run `pnpm vitest run src/laptop`?',
      excerpt: ['Bash command', '  pnpm vitest run src/laptop', 'Do you want to proceed?', '❯ 1. Yes', "  2. Yes, and don't ask again for pnpm vitest", '  3. No, and tell Claude what to do differently'],
      choices: [
        { n: 1, label: 'Yes' },
        { n: 2, label: "Yes, and don't ask again" },
        { n: 3, label: 'No' },
      ],
      selected: 1,
      hash: 'q-e2e',
    }),
  );
  await expect(tx.locator('.tx-banner')).toBeVisible();
  await expect(tx.locator('.tx-choice')).toHaveCount(3);
  // Framed on the edit's diff, with the highlighted code block above it.
  await tx.locator('.tx-said pre').evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await frames(page, 6);
  await shot(page, 'm16-transcript');

  await tx.locator('.tx-choice', { hasText: 'No' }).click();
  expect((await txCalls()).at(-1)).toEqual(['answer', 'q-e2e', 3, false]);
  await tx.locator('.tx-to-term').click();
  expect((await txCalls()).at(-1)).toEqual(['terminal']);

  // Keys inside the view scroll it, and do not reach the laptop's terminal.
  const sentKeys = () => page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.keys').length);
  const keysBefore = await sentKeys();
  await tx.locator('.tx-scroll').focus();
  const scrollTop = () => tx.locator('.tx-scroll').evaluate((e) => e.scrollTop);
  const bottom = await scrollTop();
  await page.keyboard.press('Home');
  expect(await scrollTop()).toBe(0);
  await page.keyboard.press('j');
  expect(await scrollTop()).toBeGreaterThan(0);
  await page.keyboard.press('End');
  expect(await scrollTop()).toBeGreaterThanOrEqual(bottom - 2);

  // Scrolled up, a new item shows the chip instead of moving the view.
  await page.keyboard.press('Home');
  await page.evaluate(() =>
    (window as unknown as { __tx: { view: { applyUpdates(i: unknown[]): void } } }).__tx.view.applyUpdates([
      { id: 't99', seq: 99, ts: Date.now(), kind: 'assistant', parts: [{ text: 'All green now.' }] },
    ]),
  );
  await expect(tx.locator('.tx-jump')).toHaveText('1 new · jump to latest');
  expect(await scrollTop()).toBe(0);
  await tx.locator('.tx-jump').click();
  await expect(tx.locator('.tx-jump')).toBeHidden();
  expect(await scrollTop()).toBeGreaterThan(0);

  // The prompt: typed text goes to the host on Enter, not to the terminal.
  await page.evaluate(() => (window as unknown as { __tx: { view: { focusPrompt(): void } } }).__tx.view.focusPrompt());
  await page.keyboard.type('please rerun the tests');
  await page.keyboard.press('Enter');
  expect((await txCalls()).at(-1)).toEqual(['prompt', 'please rerun the tests']);
  expect(await sentKeys()).toBe(keysBefore);
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(worker);

  // "Show system" reveals the notice and the unknown entry.
  await tx.locator('.tx-sys-toggle').click();
  await expect(tx.locator('.tx-notice')).toBeVisible();
  await expect(tx.locator('.tx-unknown')).toContainText('queue-operation');
  clean();
});
