import { expect, test, type Page } from '@playwright/test';
import { frames, leftInTerminal, openGame, shot, watchErrors } from './game';

// M5 screen, on demo-m4 with the simulator (sim=1): herdr-3d is the top floor of Work (20 desks, two pods of
// eight and four in the south pod). terminal.watch replays recorded herdr observe frames; worker.keys echoes.

type Layout = NonNullable<ReturnType<Window['__h3d']['layout']>>;
type Screen = ReturnType<Window['__h3d']['screens']>[number];

const FLOOR = 'herdr-3d';
const sim = (extra = '') => `play=none&sim=1&simms=150${extra}`;

async function enter(page: Page, query = '', wsExtra = ''): Promise<{ L: Layout; ids: Record<string, string> }> {
  await openGame(page, 'demo-m4', query, sim(wsExtra));
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const L = await page.evaluate((s) => window.__h3d.layout(s), FLOOR);
  if (!L) throw new Error('no layout');
  const w = (await page.evaluate(() => window.__h3d.world())).find((f) => f.session === FLOOR);
  const ids = Object.fromEntries((w?.workers ?? []).map((x) => [x.name, x.id]));
  return { L, ids };
}

/** Stands at (x, z) on this floor looking at (tx, ty, tz); `ty` is above this floor. */
async function look(page: Page, x: number, z: number, tx: number, ty: number, tz: number): Promise<void> {
  const p = await page.evaluate(() => window.__h3d.pose());
  if (!p) throw new Error('not walking');
  const yaw = Math.atan2(-(tx - x), -(tz - z));
  const pitch = Math.atan2(ty - p.eye, Math.hypot(tx - x, tz - z));
  await page.evaluate(([yy, pp, xx, zz]) => window.__h3d.setPose({ x: xx, z: zz, yaw: yy, pitch: pp }), [yaw, pitch, x, z] as const);
  await frames(page, 2);
}

const screens = (page: Page) => page.evaluate(() => window.__h3d.screens());
const byDesk = (s: Screen[]) => Object.fromEntries(s.map((x) => [x.desk, x.state]));
const liveDesks = async (page: Page) =>
  (await screens(page))
    .filter((s) => s.state === 'live')
    .map((s) => s.desk)
    .sort((a, b) => a - b);

/** Looks at a seated worker from behind its chair, close enough for look-at. */
async function faceWorker(page: Page, L: Layout, desk: number): Promise<void> {
  const s = L.slots[desk];
  if (!s) throw new Error(`no desk ${desk}`);
  const fx = Math.sin(s.yaw);
  const fz = Math.cos(s.yaw);
  await look(page, s.seat.x - fx * 1.4, s.seat.z - fz * 1.4, s.seat.x, 0.95, s.seat.z);
}

const sentOf = (page: Page, t: string) =>
  page.evaluate((tt) => (tt.startsWith('terminal.') ? window.__h3d.watchLog() : window.__h3d.sent()).filter((c) => c.t === tt), t);

test('the nearest four laptops you can see are live, the rest glow; screens=0 watches none', async ({ page }) => {
  const clean = watchErrors(page);
  const { L } = await enter(page);
  // From the lobby side, looking north into the south pod: its four laptops that face you are nearest.
  await look(page, L.width / 2, L.depth - 4.3, L.width / 2, 0.8, L.depth - 7.5);
  await expect.poll(() => liveDesks(page), { timeout: 15_000 }).toHaveLength(4);
  const s = await screens(page);
  expect(s.filter((x) => x.fps !== null).every((x) => x.fps === 4)).toBe(true);
  expect(s.filter((x) => x.state === 'glow').length).toBe(s.length - 4);
  expect((await page.evaluate(() => window.__h3d.watches())).sim).toBe(4);
  // Ambient watches are the game's own: `sent()` keeps to what you did.
  expect((await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t.startsWith('terminal.'))).toEqual([]);
  // The live screens show the recording (an agent's transcript, or a shell).
  const live = s.find((x) => x.state === 'live') as Screen;
  const text = (await page.evaluate((id) => window.__h3d.screenText(id), live.id)) ?? [];
  expect(text.join('\n')).toMatch(/Worker demo|\$ /);
  await shot(page, 'm5-screen-live');
  clean();
});

test('screens=0: nothing is watched while you walk the floor', async ({ page }) => {
  const clean = watchErrors(page);
  const { L } = await enter(page, '&screens=0');
  for (const [x, z] of [
    [L.width / 2, L.depth - 4.3],
    [L.width / 3, L.depth / 2],
    [L.width / 2, 2],
  ] as const) {
    await look(page, x, z, L.width / 2, 0.8, L.depth / 2);
    await page.waitForTimeout(400);
    expect(await liveDesks(page)).toEqual([]);
  }
  expect(await page.evaluate(() => window.__h3d.watches())).toEqual({ game: 0, sim: 0 });
  expect(await sentOf(page, 'terminal.watch')).toEqual([]);
  clean();
});

test('walking along the pod swaps live screens with hysteresis, the old ones stay frozen; a reconnect watches again', async ({ page }) => {
  const clean = watchErrors(page);
  const { L } = await enter(page, '&screens=2');
  const z = L.depth - 4.3;
  const at = (x: number) => look(page, x, z, x, 0.8, z - 3.4);
  // Facing the pod's middle: two live.
  await at(L.width / 2);
  await expect.poll(() => liveDesks(page), { timeout: 15_000 }).toHaveLength(2);
  const first = await liveDesks(page);
  // Standing still, looking a little left and right, changes nothing.
  const before = (await sentOf(page, 'terminal.watch')).length;
  for (const dx of [0.3, -0.3, 0.3, -0.3]) {
    await look(page, L.width / 2, z, L.width / 2 + dx, 0.8, z - 3.4);
    await page.waitForTimeout(300);
  }
  expect((await sentOf(page, 'terminal.watch')).length).toBe(before);
  expect(await liveDesks(page)).toEqual(first);
  // Walk west in small steps: the screens ahead take over one by one; the passed ones freeze.
  const west = L.slots.filter((s) => Math.abs(s.seat.z - z) < 6).reduce((m, s) => Math.min(m, s.seat.x), Infinity);
  for (let x = L.width / 2; x >= west - 1; x -= 0.6) {
    await at(x);
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(3500);
  const s = byDesk(await screens(page));
  const live = await liveDesks(page);
  expect(live).toHaveLength(2);
  for (const d of first) if (!live.includes(d)) expect(s[d]).toBe('frozen');
  const unwatches = (await sentOf(page, 'terminal.unwatch')).length;
  const watches = (await sentOf(page, 'terminal.watch')).length;
  console.log(`m5-screen: walked the pod: ${watches} watches, ${unwatches} unwatches, live ${live.join(',')}, ${JSON.stringify(s)}`);
  expect(watches - unwatches).toBe(2);
  // Everyone walked past was watched at most twice (no churn).
  const per = new Map<string, number>();
  for (const c of await sentOf(page, 'terminal.watch')) {
    const id = (c.args as { id: string }).id;
    per.set(id, (per.get(id) ?? 0) + 1);
  }
  expect(Math.max(...per.values())).toBeLessThanOrEqual(2);
  // From between the live pair and the frozen ones: both kinds in view, and neither side clearly nearer.
  const frozen = Object.entries(s).filter(([, v]) => v === 'frozen').map(([d]) => Number(d));
  expect(frozen.length).toBeGreaterThan(0);
  const shown = [...live, ...frozen].map((d) => L.slots[d]).filter((x) => !!x);
  const cx = shown.reduce((n, x) => n + x.seat.x, 0) / shown.length;
  await look(page, cx, z, cx, 0.7, z - 3.6);
  await page.waitForTimeout(800);
  const now = byDesk(await screens(page));
  for (const d of frozen) expect(now[d]).toBe('frozen');
  await shot(page, 'm5-screen-frozen');

  // A dropped connection: the bridge forgets every watch; the game watches again on the new one.
  await page.evaluate(() => window.__h3d.reconnect());
  await expect.poll(() => page.evaluate(() => window.__h3d.connection().phase), { timeout: 15_000 }).toBe('live');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.watches())).sim, { timeout: 15_000 }).toBe(2);
  await expect.poll(() => liveDesks(page), { timeout: 15_000 }).toHaveLength(2);
  clean();
});

test('E sits at a worker’s laptop: typed input echoes in its terminal, game keys stay in the terminal, Esc gets up', async ({ page }) => {
  const clean = watchErrors(page);
  const { L, ids } = await enter(page);
  const sprout = ids.Sprout as string; // desk 15, a plain shell
  const desk = (await page.evaluate(() => window.__h3d.world())).find((f) => f.session === FLOOR)?.workers.find((w) => w.id === sprout)?.desk as number;
  await faceWorker(page, L, desk);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'worker', id: sprout });
  const eKey = page.locator('.prompt .key', { hasText: 'Laptop' });
  await expect(eKey).not.toHaveAttribute('aria-disabled');
  const standing = await page.evaluate(() => window.__h3d.pose());
  await page.keyboard.press('KeyE');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(sprout);
  await expect.poll(async () => (await screens(page)).find((s) => s.id === sprout)?.fps).toBe(10);
  await expect(page.locator('.seat')).toBeVisible();
  await expect(page.locator('.seat-tape')).toHaveText(/At Sprout.s laptop/i);
  await expect(page.locator('.prompt')).toBeHidden();

  // Typing: text and Enter go to the pane, and echo on its screen.
  await page.keyboard.type('echo hi');
  await page.keyboard.press('Enter');
  await page.keyboard.type('ls');
  await expect.poll(async () => (await page.evaluate((id) => window.__h3d.screenText(id), sprout))?.includes('$ echo hi'), { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => (await page.evaluate((id) => window.__h3d.screenText(id), sprout))?.includes('$ ls')).toBe(true);
  const keys = (await sentOf(page, 'worker.keys')).flatMap((c) => (c.args as { input: unknown[] }).input);
  // The game batches what is typed while a command is on its way: compare the text, not the batching.
  const typed = keys.map((k) => ('text' in (k as object) ? (k as { text: string }).text : `<${(k as { key: string }).key}>`)).join('');
  expect(typed).toBe('echo hi<enter>ls');
  await frames(page, 6);
  await shot(page, 'm5-screen-seated');

  // The game's own keys go to the terminal too: no walking, no plan, no elevator, no battery saver, no send-home, no city.
  await page.keyboard.press('KeyW');
  await page.keyboard.press('KeyL');
  await page.keyboard.press('KeyB');
  await page.keyboard.press('KeyX');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Shift+Escape');
  await page.keyboard.press('Control+C');
  await page.keyboard.press('ArrowUp');
  await expect
    .poll(async () =>
      (await sentOf(page, 'worker.keys'))
        .flatMap((c) => (c.args as { input: Array<{ text?: string; key?: string }> }).input)
        .map((k) => k.text ?? `<${k.key}>`)
        .join(''),
    )
    .toBe('echo hi<enter>lswlbx<tab><shift+tab><backspace><esc><ctrl+c><up>');
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(sprout);
  expect(await page.evaluate(() => [window.__h3d.view().plan, window.__h3d.view().mode, window.__h3d.panel(), window.__h3d.dialog()])).toEqual([false, 'floor', null, null]);
  const still = await page.evaluate(() => window.__h3d.pose());
  expect([still?.x, still?.z, still?.yaw]).toEqual([standing?.x, standing?.z, standing?.yaw]);
  expect(await page.locator('.btn--icon[aria-label="Battery saver"]').getAttribute('aria-pressed')).toBe('false');

  // Paste (the browser's paste event) goes to the pane as typed keys for a plain shell.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'pwd\n');
    document.querySelector('.seat-input')?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => (await sentOf(page, 'worker.keys')).at(-1)?.args).toEqual({ id: sprout, input: [{ text: 'pwd' }, { key: 'enter' }] });

  // Esc stands you up and unwatches at once (screens=4: it may come back live at 4 fps as a nearby laptop).
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.__h3d.seated())).toBeNull();
  await expect(page.locator('.seat')).toBeHidden();
  await expect.poll(async () => (await screens(page)).find((s) => s.id === sprout)?.fps ?? null).not.toBe(10);
  await frames(page, 40);
  const back = await page.evaluate(() => window.__h3d.pose());
  expect([back?.x, back?.z, back?.yaw]).toEqual([standing?.x, standing?.z, standing?.yaw]);
  clean();
});

test('paste into an agent’s laptop sends worker.prompt; a failed key shows in the seat bar; the worker leaving stands you up', async ({ page }) => {
  const clean = watchErrors(page);
  const { L, ids } = await enter(page, '', '&simfail=input_failed');
  const nibble = ids.Nibble as string; // desk 0, claude
  await leftInTerminal(page, nibble); // #98: the terminal, not the conversation
  await faceWorker(page, L, 0);
  expect(await page.evaluate(() => window.__h3d.sitAt(window.__h3d.lookAt()?.id ?? ''))).toBe(true);
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(nibble);
  await page.keyboard.type('x');
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().state)).toBe('error');
  expect((await page.evaluate(() => window.__h3d.seat())).note).toMatch(/Nibble.s terminal didn.t take that/);
  // The next key goes through and the bar is back to normal.
  await page.keyboard.type('y');
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().state)).toBe('ok');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'Run the tests.');
    document.querySelector('.seat-input')?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => (await sentOf(page, 'worker.prompt')).map((c) => c.args)).toEqual([{ id: nibble, text: 'Run the tests.' }]);
  // Nibble goes home: you get up, with a word why.
  await page.evaluate((id) => window.__h3d.inject({ t: 'worker.removed', seq: 1_000_000, id, session: 'herdr-3d', workspace_id: 'w1' }), nibble);
  await frames(page, 3);
  expect(await page.evaluate(() => window.__h3d.seated())).toBeNull();
  await expect(page.locator('.toast')).toContainText(/no longer on the floor|went home/);
  clean();
});

test('standing up leaves the laptop showing its last frame, not a blank one (screens=0)', async ({ page }) => {
  const clean = watchErrors(page);
  const { L, ids } = await enter(page, '&screens=0');
  const bean = ids.Bean as string;
  await leftInTerminal(page, bean); // #98: the terminal, not the conversation
  const desk = (await page.evaluate(() => window.__h3d.world())).find((f) => f.session === FLOOR)?.workers.find((w) => w.id === bean)?.desk as number;
  await faceWorker(page, L, desk);
  await page.keyboard.press('KeyE');
  await expect.poll(async () => (await screens(page)).find((s) => s.id === bean)?.state).toBe('live');
  await expect.poll(async () => (await page.evaluate((id) => window.__h3d.screenText(id), bean))?.some((l) => l.trim() !== '')).toBe(true);
  await frames(page, 3);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await screens(page)).find((s) => s.id === bean)?.state).toBe('frozen');
  expect(await page.evaluate((id) => window.__h3d.frozenInk(id), bean)).toBeGreaterThan(0.005);
  clean();
});

test('standing up while a paste is on its way still sends what you typed after it, in order', async ({ page }) => {
  const clean = watchErrors(page);
  // demo-m5: Zippy (desk 18) is an idle claude; a slow simulator (1.5 s per step) holds the paste's worker.prompt.
  await openGame(page, 'demo-m5', '&screens=0', 'play=none&sim=1&simms=1500');
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const L = await page.evaluate((s) => window.__h3d.layout(s), FLOOR);
  if (!L) throw new Error('no layout');
  const zippy = (await page.evaluate(() => window.__h3d.world())).find((f) => f.session === FLOOR)?.workers.find((w) => w.name === 'Zippy');
  if (!zippy) throw new Error('no Zippy');
  await leftInTerminal(page, zippy.id); // #98: the terminal, not the conversation
  await faceWorker(page, L, zippy.desk);
  await page.keyboard.press('KeyE');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(zippy.id);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'First pasted prompt');
    document.querySelector('.seat-input')?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.keyboard.type('second input');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.__h3d.seated())).toBeNull();
  expect(await sentOf(page, 'worker.keys')).toEqual([]); // still behind the paste
  const typed = async () =>
    (await sentOf(page, 'worker.keys'))
      .flatMap((c) => (c.args as { input: Array<{ text?: string; key?: string }> }).input)
      .map((k) => k.text ?? `<${k.key}>`)
      .join('');
  await expect.poll(typed, { timeout: 10_000 }).toBe('second input<enter>');
  const order = (await page.evaluate(() => window.__h3d.sent())).map((c) => c.t).filter((t) => t === 'worker.prompt' || t === 'worker.keys');
  expect(order[0]).toBe('worker.prompt');
  expect(await sentOf(page, 'worker.prompt')).toEqual([expect.objectContaining({ args: { id: zippy.id, text: 'First pasted prompt' } })]);
  clean();
});

test('20 sit / stand cycles leave no watch behind (screens=0)', async ({ page }) => {
  const clean = watchErrors(page);
  const { L, ids } = await enter(page, '&screens=0');
  const bean = ids.Bean as string;
  await leftInTerminal(page, bean); // #98: the terminal, not the conversation
  const desk = (await page.evaluate(() => window.__h3d.world())).find((f) => f.session === FLOOR)?.workers.find((w) => w.id === bean)?.desk as number;
  await faceWorker(page, L, desk);
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('KeyE');
    await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(bean);
    // Half the cycles wait for the screen, half get up at once.
    if (i % 2) await expect.poll(async () => (await screens(page)).find((s) => s.id === bean)?.state).toBe('live');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.__h3d.seated())).toBeNull();
    await frames(page, 2);
  }
  await expect.poll(() => page.evaluate(() => window.__h3d.watches())).toEqual({ game: 0, sim: 0 });
  expect((await sentOf(page, 'terminal.watch')).length).toBe(20);
  expect((await sentOf(page, 'terminal.unwatch')).length).toBe(20);
  clean();
});

test('an older bridge (unknown_command): screens stay glowing and E says why', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', 'play=none');
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const L = await page.evaluate((s) => window.__h3d.layout(s), FLOOR);
  if (!L) throw new Error('no layout');
  await look(page, L.width / 2, L.depth - 4.3, L.width / 2, 0.8, L.depth - 7.5);
  await expect.poll(async () => (await sentOf(page, 'terminal.watch')).map((c) => c.result?.code)).toContain('unknown_command');
  await page.waitForTimeout(600);
  expect((await screens(page)).every((s) => s.state === 'glow')).toBe(true);
  await faceWorker(page, L, 0);
  const eKey = page.locator('.prompt .key', { hasText: 'Laptop' });
  await expect(eKey).toHaveAttribute('aria-disabled', 'true');
  await expect(eKey).toHaveAttribute('title', /can.t show laptop screens yet/);
  await page.keyboard.press('KeyE');
  expect(await page.evaluate(() => window.__h3d.seated())).toBeNull();
  await expect(page.locator('.toast')).toContainText(/can.t show laptop screens yet/);
  // It stops asking.
  const n = (await sentOf(page, 'terminal.watch')).length;
  await page.waitForTimeout(800);
  expect((await sentOf(page, 'terminal.watch')).length).toBe(n);
  clean();
});

test('on an asleep floor the laptops are dark and E says why', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', sim());
  await page.evaluate(() => window.__h3d.enterFloor('depot-manager'));
  await frames(page, 3);
  const L = await page.evaluate(() => window.__h3d.layout('depot-manager'));
  if (!L) throw new Error('no layout');
  await faceWorker(page, L, 0);
  await page.waitForTimeout(600);
  expect((await screens(page)).every((s) => s.state === 'dark')).toBe(true);
  await expect(page.locator('.prompt .key', { hasText: 'Laptop' })).toHaveAttribute('title', /asleep/);
  expect(await sentOf(page, 'terminal.watch')).toEqual([]);
  clean();
});

// Opt-in (H3D_BENCH=1): frame time on the busy 60-worker floor with 4 live screens against none, and seated at a
// laptop. WebGL2 on llvmpipe here: only the relative numbers mean something (the Mac jobs are in tools/mac-perf.ts).
test('bench: 4 live screens on perf-floor60 against none', async ({ page }) => {
  test.skip(!process.env.H3D_BENCH, 'set H3D_BENCH=1 to run');
  test.setTimeout(600_000);
  const out: Record<string, unknown> = {};
  for (const [name, screensQ, sit] of [
    ['screens0', '&screens=0', false],
    ['screens4', '&screens=4', false],
    ['seated', '&screens=4', true],
    ['screens0-again', '&screens=0', false],
  ] as const) {
    await openGame(page, 'perf-floor60', `&ts${screensQ}`, 'play=none&sim=1');
    await page.evaluate(() => window.__h3d.enterFloor('perf-floor'));
    await frames(page, 3);
    await page.evaluate(() => {
      const L = window.__h3d.layout('perf-floor');
      if (!L) return;
      const z = Math.max(...L.slots.map((s) => s.seat.z)) + 1.1;
      window.__h3d.setPose({ x: L.width / 2 + 0.3, z, yaw: 0, pitch: -0.2 });
    });
    if (screensQ.endsWith('4')) await expect.poll(() => liveDesks(page), { timeout: 20_000 }).toHaveLength(4);
    if (sit) {
      const id = (await screens(page)).find((s) => s.state === 'live')?.id as string;
      await leftInTerminal(page, id); // #98: the terminal, not the conversation
      expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
      await expect.poll(async () => (await screens(page)).find((s) => s.id === id)?.fps).toBe(10);
      await page.waitForTimeout(1500);
    }
    const r = await page.evaluate(() => window.__h3d.bench({ frames: 240, warm: 40, sway: false }));
    out[name] = { frameMs: r.frameMs, pipelinedMs: r.pipelinedMs, drawCalls: r.drawCalls, live: (await liveDesks(page)).length };
    console.log(`m5-bench ${name}: ${JSON.stringify(out[name])}`);
  }
});
