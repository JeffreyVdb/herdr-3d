import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// M4 on the demo-m4 fixture and the simulating fixture server
// (tools/fixture-sim.ts): Work holds herdr-3d (top), depot-manager (asleep)
// and pastry (bottom, 14 workers on desks 0-13 of 16); scratchpad is in the
// lot with 3 workers, capped here at soft 3 / hard 4, in a folder that is no
// git repo. In the simulation a `working` worker has a dirty tree; Jellybean
// (pastry desk 1, working) and Marble (desk 3, done) have linked worktrees.

const SIM = 'play=none&sim=1&simms=150&simcap=scratchpad:3:4';

type Dialog = NonNullable<ReturnType<Window['__h3d']['dialog']>>;
type Hire = Extract<Dialog, { kind: 'hire' }>;
type Home = Extract<Dialog, { kind: 'send-home' }>;
type Arrival = ReturnType<Window['__h3d']['arrivals']>[number];

const dialog = (page: Page) => page.evaluate(() => window.__h3d.dialog());
const sent = (page: Page) => page.evaluate(() => window.__h3d.sent());
const arrivals = (page: Page) => page.evaluate(() => window.__h3d.arrivals());
const desks = (page: Page) => page.evaluate(() => window.__h3d.desks());

async function hireDialog(page: Page, state: Hire['state'] = 'ready'): Promise<Hire> {
  await expect.poll(async () => (await dialog(page))?.kind === 'hire' && (await dialog(page))?.state, { message: `hire dialog ${state}`, timeout: 10_000 }).toBe(state);
  return (await dialog(page)) as Hire;
}

async function homeDialog(page: Page): Promise<Home> {
  await expect.poll(async () => (await dialog(page))?.kind === 'send-home' && (await dialog(page))?.state, { message: 'send-home dialog ready', timeout: 10_000 }).toBe('ready');
  return (await dialog(page)) as Home;
}

async function enter(page: Page, session: string): Promise<void> {
  await page.evaluate((s) => window.__h3d.enterFloor(s), session);
  await frames(page, 3);
}

/** Stands `back` metres behind a desk's seat, facing the desk (the "+" of a free one, the back of whoever sits there). */
async function faceDesk(page: Page, session: string, desk: number, back = 0.45, pitch = -0.28): Promise<void> {
  await page.evaluate(
    ([s, d, b, p]) => {
      const L = window.__h3d.layout(s);
      const slot = L?.slots[d];
      if (!slot) throw new Error(`no desk ${d} on ${s}`);
      const fx = Math.sin(slot.yaw);
      const fz = Math.cos(slot.yaw);
      window.__h3d.setPose({ x: slot.seat.x - fx * b, z: slot.seat.z - fz * b, yaw: Math.atan2(-fx, -fz), pitch: p });
    },
    [session, desk, back, pitch] as const,
  );
  await frames(page, 2);
}

/** Turns the camera to look at a point from where you stand (feet level y), keeping your position. */
async function lookTowards(page: Page, x: number, y: number, z: number): Promise<void> {
  await page.evaluate(
    ([x, y, z]) => {
      const p = window.__h3d.pose();
      if (!p) return;
      const dx = x - p.x;
      const dz = z - p.z;
      const eye = p.y + p.eye;
      window.__h3d.setPose({ x: p.x, z: p.z, y: p.y, yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(y - eye, Math.hypot(dx, dz)) });
    },
    [x, y, z] as const,
  );
  await frames(page, 2);
}

/** Waits until a walker satisfies `fn`. */
async function walker(page: Page, fn: (a: Arrival) => boolean, what: string, timeout = 30_000): Promise<Arrival> {
  let hit: Arrival | undefined;
  await expect
    .poll(
      async () => {
        hit = (await arrivals(page)).find(fn);
        return !!hit;
      },
      { message: what, timeout, intervals: [30] },
    )
    .toBe(true);
  return hit as Arrival;
}

const focusedKey = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return !a || a === document.body ? 'BODY' : (a.dataset.key ?? a.id);
  });

test('E on an empty desk: the hire dialog from the keyboard, then the worker walks in and sits down', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  await enter(page, 'pastry');
  await faceDesk(page, 'pastry', 14);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'desk', id: 'desk-14', label: 'Desk 15' });
  await expect(page.locator('.prompt')).toHaveAttribute('aria-label', 'Desk 15 · E Hire');
  await expect(page.locator('.prompt .key:not([aria-disabled])')).toHaveText(['EHire']);
  expect((await desks(page))[14]).toEqual({ desk: 14, worker: null, plus: true, away: null });

  await page.keyboard.press('e');
  let d = await hireDialog(page);
  await expect(page.locator('dialog.desk-dlg--hire h2')).toHaveText('Hire a worker at Desk 15');
  await expect(page.locator('#hire-sub')).toHaveText('pastry · Floor 1 of 3 · Work');
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
  expect(await focusedKey(page)).toBe('task');
  // Nothing hired on pastry yet and no floor default: claude / opus / high; the next name; the floor's folder; a repo.
  expect(d.form).toEqual({ prompt: '', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', label: 'Gumdrop', cwd: '/home/dev/pastry', worktree: true });
  expect(d.choiceNote).toBeNull();
  expect(d.git?.base).toMatch(/^origin\/main @ [0-9a-f]{7}, 3 h old$/);
  expect(d.capacity).toMatchObject({ level: 'ok', lines: [] });
  expect(d.blocker).toBeNull();
  await expect(page.locator('.dd-capacity')).toHaveText('pastry: 14 of 24 · host: 35 of 60 · load 2.4 on 16 CPUs · memory 41 %');
  await expect(page.locator('#hire-worktree')).toBeChecked();
  await expect(page.locator('.dd-base')).toContainText('A new h3d/… branch from origin/main @');
  await expect(page.locator('[data-hook="plan-limits"]')).toBeHidden();

  // The first task: typing never reaches the game (e, l, x, Tab-free); Shift+Enter is a new line.
  await page.keyboard.type('Label the loaves, extra seeds');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('then bake');
  expect(await page.evaluate(() => window.__h3d.panel())).toBeNull();
  d = (await dialog(page)) as Hire;
  expect(d.form.prompt).toBe('Label the loaves, extra seeds\nthen bake');
  // Harness → model → effort from the keyboard: Tab into each chip group, arrows pick.
  await page.keyboard.press('Tab');
  expect(await focusedKey(page)).toBe('harness:claude');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => ((await dialog(page)) as Hire).form.harness).toBe('codex');
  expect(await focusedKey(page)).toBe('harness:codex');
  expect(((await dialog(page)) as Hire).form).toMatchObject({ model: 'gpt-6-sol', effort: 'high' });
  await expect(page.locator('[data-pick="effort"] .dd-chip')).toHaveText(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  await page.keyboard.press('Tab');
  expect(await focusedKey(page)).toBe('model:gpt-6-sol');
  await page.keyboard.press('Tab');
  expect(await focusedKey(page)).toBe('effort:high');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => ((await dialog(page)) as Hire).form.effort).toBe('xhigh');
  await page.keyboard.press('Tab');
  expect(await focusedKey(page)).toBe('label');
  await page.keyboard.press('Tab');
  expect(await focusedKey(page)).toBe('cwd');
  await page.keyboard.press('Tab');
  expect(await focusedKey(page)).toBe('worktree');
  await expect(page.locator('dialog.desk-dlg--hire [data-key="hire"]')).toHaveText('Hire Gumdrop');
  await shot(page, 'm4-hire-dialog');

  // Back in the task, Enter hires.
  await page.locator('#hire-task').focus();
  await page.keyboard.press('Enter');
  const hire = (await sent(page)).filter((c) => c.t === 'worker.hire');
  expect(hire.map((c) => c.args)).toEqual([
    { session: 'pastry', desk_index: 14, harness: 'codex', model: 'gpt-6-sol', effort: 'xhigh', label: 'Gumdrop', cwd: '/home/dev/pastry', worktree: true, prompt: 'Label the loaves, extra seeds\nthen bake' },
  ]);
  // The "+" goes as the hire starts, and stays gone while the worker walks in.
  expect((await desks(page))[14]).toMatchObject({ plus: false, away: 'empty' });
  await expect.poll(() => dialog(page)).toBeNull();
  await expect(page.locator('.toast')).toHaveText(/^Hired Gumdrop at Desk 15 on h3d\/gumdrop-[0-9a-f]{6}\. Here they come\.$/);
  const w = await walker(page, (a) => a.kind === 'in' && a.desk === 14, 'Gumdrop walks in');
  expect(w).toMatchObject({ session: 'pastry', name: 'Gumdrop', desk_show: 'empty', box: 'carried', laptop: 'carried' });
  // From the street (the reversed walk-out route).
  const route = await page.evaluate(() => window.__h3d.route('pastry', 14));
  const start = route.at(-1) as { x: number; y: number; z: number };
  expect(w.walked).toBeLessThan(6);
  expect(start.y).toBe(0);
  expect((await desks(page))[14]).toMatchObject({ plus: false, away: 'empty', worker: w.id });

  // Hurry, then catch it inside the office, a few metres from the desk.
  await page.evaluate(() => window.__h3d.arrivalRate(4));
  const inside = await walker(page, (a) => a.kind === 'in' && a.length - a.walked < 5.5 && a.phase === 'walk', 'Gumdrop in the office');
  await page.evaluate(() => window.__h3d.arrivalRate(0.02));
  const L = await page.evaluate(() => window.__h3d.layout('pastry'));
  const seat = L?.slots[14]?.seat as { x: number; z: number };
  // Ahead of it, between it and its desk, looking back at it (a little from above).
  const dx = seat.x - inside.x;
  const dz = seat.z - inside.z;
  const n = Math.hypot(dx, dz) || 1;
  const feet = inside.y - 0.15;
  await page.evaluate(([x, z, y]) => window.__h3d.setPose({ x, z, y, yaw: 0, pitch: 0 }), [inside.x + (dx / n) * 3, inside.z + (dz / n) * 3, feet + 0.35] as const);
  await lookTowards(page, inside.x, feet + 0.55, inside.z);
  await frames(page, 4);
  await shot(page, 'm4-walk-in');
  await page.evaluate(() => window.__h3d.arrivalRate(4));
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.arrivalLog())).find((l) => l.id === w.id), { timeout: 30_000 }).toMatchObject({ kind: 'in', played: true });
  // Sitting at its desk, with its card; the desk is the world's again.
  expect((await desks(page))[14]).toEqual({ desk: 14, worker: w.id, plus: false, away: null });
  const pastry = (await page.evaluate(() => window.__h3d.world())).find((f) => f.session === 'pastry');
  expect(pastry?.workers.find((x) => x.id === w.id)).toMatchObject({ name: 'Gumdrop', desk: 14 });
  await faceDesk(page, 'pastry', 14, 1.4, -0.2);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'worker', name: 'Gumdrop' });

  // The first task set it working; the next hire here starts from this one ("Last hire here").
  await page.evaluate(() => window.__h3d.openHire());
  d = await hireDialog(page);
  expect(d.desk).toBe(15);
  expect(d.form).toMatchObject({ harness: 'codex', model: 'gpt-6-sol', effort: 'xhigh', label: 'Hopper' });
  expect(d.choiceNote).toBe('Last hire here');
  await expect(page.locator('.tape--note')).toHaveText('Last hire here');
  await page.keyboard.press('Escape');
  await expect.poll(() => dialog(page)).toBeNull();
  expect((await desks(page))[15]).toMatchObject({ plus: true, away: null });
  clean();
});

test('X on a worker with unsaved work: delete is off, with the warning; Esc sends nobody home', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  await enter(page, 'pastry');
  await faceDesk(page, 'pastry', 0, 1.1, -0.3);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'worker', name: 'Jellybean' });
  await page.keyboard.press('x');
  const d = await homeDialog(page);
  await expect(page.locator('dialog.desk-dlg--home h2')).toHaveText('Send Jellybean home');
  expect(d.prep).toMatchObject({ branch: 'h3d/brioche-levain', worktree: { path: '/home/dev/pastry-wt/brioche', linked: true }, unpushed: 2, can_delete: false });
  expect(d.options?.enabled).toEqual({ keep: true, delete: false, delete_branch: false });
  expect(d.choice).toBe('keep');
  await expect(page.locator('.dd-porcelain li')).toHaveText([' M game/src/app.ts', ' M game/src/ui/hud.ts', '?? notes/todo.md']);
  await expect(page.locator('.dd-desk')).toContainText('2 commits not on any remote');
  await expect(page.locator('.dd-callout')).toHaveText(
    'Deleting is off: the worktree has uncommitted changes and 2 commits are not on any remote. The worktree stays; commit and push first to delete it.',
  );
  await expect(page.locator('#home-delete')).toBeDisabled();
  await expect(page.locator('#home-delete_branch')).toBeDisabled();
  // Keyboard lands on the (safe) keep choice; the arrows cannot reach the disabled ones.
  expect(await focusedKey(page)).toBe('wt:keep');
  await page.keyboard.press('ArrowDown');
  expect(((await dialog(page)) as Home).choice).toBe('keep');
  await page.locator('label[for="home-delete"]').click({ force: true });
  expect(((await dialog(page)) as Home).choice).toBe('keep');
  await shot(page, 'm4-send-home-dirty');
  await page.keyboard.press('Escape');
  await expect.poll(() => dialog(page)).toBeNull();
  expect((await sent(page)).map((c) => c.t)).toEqual(['worker.fire.prepare']);
  expect((await page.evaluate(() => window.__h3d.world())).find((f) => f.session === 'pastry')?.workers.some((w) => w.name === 'Jellybean')).toBe(true);
  clean();
});

test('send home a clean worker: delete worktree + branch, it packs a box, takes the laptop and walks out; the desk is a "+" again', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  await enter(page, 'pastry');
  await faceDesk(page, 'pastry', 2, 1.1, -0.3);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'worker', name: 'Marble' });
  const id = (await page.evaluate(() => window.__h3d.lookAt()))?.id as string;
  await page.keyboard.press('x');
  let d = await homeDialog(page);
  expect(d.options).toEqual({ offered: true, enabled: { keep: true, delete: true, delete_branch: true }, warning: null });
  await expect(page.locator('.dd-desk .tape')).toHaveText('All pushed');
  // Pick "delete the worktree and the branch": Enter on it does not send (only the button does).
  expect(await focusedKey(page)).toBe('wt:keep');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  expect(((await dialog(page)) as Home).choice).toBe('delete_branch');
  await page.keyboard.press('Enter');
  expect((await sent(page)).map((c) => c.t)).toEqual(['worker.fire.prepare']);
  await expect(page.locator('dialog.desk-dlg--home [data-key="send"]')).toHaveText('Send Marble home and delete');
  await shot(page, 'm4-send-home-clean');
  await page.keyboard.press('Tab');
  expect(await focusedKey(page)).toBe('cancel');
  await page.keyboard.press('Tab');
  expect(await focusedKey(page)).toBe('send');
  // Slow motion, to watch it pack.
  await page.evaluate(() => window.__h3d.arrivalRate(0.5));
  await page.keyboard.press('Enter');
  await expect.poll(() => dialog(page)).toBeNull();
  expect((await sent(page)).filter((c) => c.t === 'worker.fire').map((c) => c.args)).toEqual([{ id, worktree: 'delete_branch' }]);
  await expect(page.locator('.toast')).toHaveText('Sent Marble home. Its worktree and branch are deleted.');
  // Gone from the world, but packing at the desk: chair out, laptop open, no "+".
  expect((await page.evaluate(() => window.__h3d.world())).find((f) => f.session === 'pastry')?.workers.some((w) => w.id === id)).toBe(false);
  const packing = await walker(page, (a) => a.id === id && a.phase === 'pack' && a.items >= 2, 'Marble packs', 10_000);
  expect(packing).toMatchObject({ kind: 'out', desk: 2, box: 'desk', laptop: 'desk', desk_show: 'busy' });
  expect((await desks(page))[2]).toEqual({ desk: 2, worker: null, plus: false, away: 'busy' });
  const L = await page.evaluate(() => window.__h3d.layout('pastry'));
  const slot = L?.slots[2] as { seat: { x: number; z: number }; yaw: number };
  // From across the desk, looking at Marble and the box.
  const fx = Math.sin(slot.yaw);
  const fz = Math.cos(slot.yaw);
  const p0 = await page.evaluate(() => window.__h3d.pose());
  await page.evaluate(([x, z, y]) => window.__h3d.setPose({ x, z, y, yaw: 0, pitch: 0 }), [slot.seat.x + fx * 2.3 + fz * 1.2, slot.seat.z + fz * 2.3 - fx * 1.2, p0?.y ?? 0] as const);
  await lookTowards(page, slot.seat.x + fx * 0.4, (p0?.y ?? 0) + 0.7, slot.seat.z + fz * 0.4);
  await page.evaluate(() => window.__h3d.arrivalRate(0.02));
  await frames(page, 4);
  await shot(page, 'm4-walk-out-pack');
  // Laptop onto the box, up, and away: catch it in the aisle carrying the box.
  await page.evaluate(() => window.__h3d.arrivalRate(1.5));
  const carrying = await walker(page, (a) => a.id === id && a.phase === 'walk' && a.walked > 2.5, 'Marble walks off with the box', 15_000);
  await page.evaluate(() => window.__h3d.arrivalRate(0.02));
  expect(carrying).toMatchObject({ box: 'carried', laptop: 'carried', items: 3, desk_show: 'free' });
  expect((await desks(page))[2]).toEqual({ desk: 2, worker: null, plus: true, away: null });
  await lookTowards(page, carrying.x, carrying.y + 0.4, carrying.z);
  await frames(page, 4);
  await shot(page, 'm4-walk-out');

  // Down the fire escape on the route's heights, to the street, and gone.
  await page.evaluate(() => window.__h3d.arrivalRate(5));
  const floorY = (await page.evaluate(() => window.__h3d.building()))?.storey ?? 0;
  let minY = Infinity;
  let onStairs = false;
  await expect
    .poll(
      async () => {
        const a = (await arrivals(page)).find((x) => x.id === id);
        if (a) {
          minY = Math.min(minY, a.y);
          if (a.y > 0.6 && a.y < floorY - 0.3) onStairs = true;
        }
        return (await page.evaluate(() => window.__h3d.arrivalLog())).find((l) => l.id === id)?.played ?? null;
      },
      { timeout: 40_000, intervals: [25] },
    )
    .toBe(true);
  expect(onStairs).toBe(true);
  expect(minY).toBeLessThan(0.3);
  expect(await arrivals(page)).toEqual([]);
  expect((await desks(page))[2]).toEqual({ desk: 2, worker: null, plus: true, away: null });
  await faceDesk(page, 'pastry', 2);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'desk', id: 'desk-2' });
  clean();
});

test('the top bar’s Hire opens the first free desk; a worker with no worktree has no worktree choices', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  await enter(page, 'herdr-3d');
  expect(await focusedKey(page)).toBe('BODY');
  await page.keyboard.press('Shift+Tab');
  for (const want of ['Issues', 'PRs', 'Elevator', 'Hire']) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe(want);
  }
  await page.keyboard.press('Enter');
  const d = await hireDialog(page);
  // Desks 5 and 12 are free: the first.
  expect(d).toMatchObject({ session: 'herdr-3d', desk: 5, title: 'Hire a worker at Desk 6' });
  expect((await desks(page))[5]).toMatchObject({ plus: true });
  await page.keyboard.press('Escape');
  await expect.poll(() => dialog(page)).toBeNull();
  // Nacho has no git checkout of its own: nothing to keep or delete; Enter sends it home.
  await enter(page, 'pastry');
  const nacho = (await page.evaluate(() => window.__h3d.world())).find((f) => f.session === 'pastry')?.workers.find((w) => w.name === 'Nacho');
  await page.evaluate((id) => window.__h3d.openSendHome(id), nacho?.id as string);
  let h = await homeDialog(page);
  expect(h.options).toEqual({ offered: false, enabled: { keep: true, delete: false, delete_branch: false }, warning: null });
  expect(h.blocked).toBeNull();
  await expect(page.locator('.dd-choices')).toHaveCount(0);
  await expect(page.locator('.dd-facts')).toContainText('not a git worktree');
  expect(await focusedKey(page)).toBe('send');
  await page.keyboard.press('Escape');
  await expect.poll(() => dialog(page)).toBeNull();
  // Pebble works in herdr-3d's main checkout while four of its worktrees are open: herdr would not close it.
  await enter(page, 'herdr-3d');
  const pebble = (await page.evaluate(() => window.__h3d.world())).find((f) => f.session === 'herdr-3d')?.workers.find((w) => w.name === 'Pebble');
  await page.evaluate((id) => window.__h3d.openSendHome(id), pebble?.id as string);
  h = await homeDialog(page);
  expect(h.options?.offered).toBe(false);
  expect(h.blocked).toMatch(/main checkout and 4 of its worktrees are still open here/);
  await expect(page.locator('dialog.desk-dlg--home .dd-callout--error')).toContainText('Pebble can’t go home yet');
  await expect(page.locator('dialog.desk-dlg--home [data-key="send"]')).toHaveAttribute('aria-disabled', 'true');
  expect(await focusedKey(page)).toBe('cancel');
  await page.keyboard.press('Escape');
  expect((await sent(page)).filter((c) => c.t === 'worker.fire')).toEqual([]);
  clean();
});

test('capacity: a warning above the soft cap, a refusal at the hard cap; no worktree option outside a repo (1024×640)', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1024, height: 640 });
  await openGame(page, 'demo-m4', '', SIM);
  await enter(page, 'scratchpad');
  await page.evaluate(() => window.__h3d.openHire());
  let d = await hireDialog(page);
  expect(d).toMatchObject({ session: 'scratchpad', desk: 3, git: null, blocker: null });
  expect(d.form).toMatchObject({ cwd: '/home/dev/scratch', worktree: false });
  expect(d.capacity).toMatchObject({ level: 'warn', floor: 'warn', lines: ['scratchpad will have 4 workers, over its soft cap of 3 (hard cap 4).'] });
  await expect(page.locator('#hire-worktree')).toHaveCount(0);
  await expect(page.locator('.dd-capacity .tape')).toHaveText('Over the soft cap');
  // Readable at 1024×640: the dialog fits, its actions in view.
  const box = await page.locator('dialog.desk-dlg--hire').boundingBox();
  expect(box && box.y >= 0 && box.y + box.height <= 640).toBe(true);
  await expect(page.locator('dialog.desk-dlg--hire [data-key="hire"]')).toBeInViewport();
  await shot(page, 'm4-hire-capacity-warn');
  await page.locator('dialog.desk-dlg--hire [data-key="hire"]').click();
  await expect.poll(() => dialog(page)).toBeNull();
  expect((await sent(page)).filter((c) => c.t === 'worker.hire').map((c) => c.args)).toEqual([
    { session: 'scratchpad', desk_index: 3, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', label: 'Gumdrop', cwd: '/home/dev/scratch' },
  ]);

  // Now at the hard cap: Hire is off and says why; Enter in the task sends nothing.
  await page.evaluate(() => window.__h3d.openHire());
  d = await hireDialog(page);
  expect(d.capacity).toMatchObject({ level: 'full', floor: 'full' });
  expect(d.blocker).toBe('Over the hard cap: send someone home first.');
  await expect(page.locator('dialog.desk-dlg--hire [data-key="hire"]')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('.dd-capacity[role="alert"]')).toContainText('scratchpad has 4 workers: its hard cap is 4.');
  await page.keyboard.type('One more?');
  await page.keyboard.press('Enter');
  await expect(page.locator('dialog.desk-dlg--hire .dd-status--error')).toHaveText('Over the hard cap: send someone home first.');
  expect((await sent(page)).filter((c) => c.t === 'worker.hire')).toHaveLength(1);
  await shot(page, 'm4-hire-capacity-full');
  await page.keyboard.press('Escape');
  clean();
});

test('walks you cannot see resolve at once; only a fresh hire walks in', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  await enter(page, 'pastry');
  const world = await page.evaluate(() => window.__h3d.world());
  // A worker of the lot sent home while you are in Work: nothing to watch.
  const hopper = world.find((f) => f.session === 'scratchpad')?.workers.find((w) => w.name === 'Hopper');
  await page.evaluate((id) => window.__h3d.inject({ t: 'worker.removed', seq: 9001, id, session: 'scratchpad', workspace_id: 'w1', reason: 'sent_home' } as never), hopper?.id as string);
  expect(await page.evaluate(() => window.__h3d.arrivalLog())).toEqual([{ id: hopper?.id, kind: 'out', played: false, session: 'scratchpad', desk: 0 }]);
  expect(await arrivals(page)).toEqual([]);
  // A fresh hire on the top floor of this building walks in from the street; an old one (hired an hour ago) does not.
  const fresh = { id: 'fresh-1', session: 'herdr-3d', workspace_id: 'wf1', label: 'fresh', status: 'idle', name: 'Kazoo', desk_index: 5, hired_at: Date.now() - 1000 };
  const stale = { ...fresh, id: 'stale-1', workspace_id: 'wf2', name: 'Lentil', desk_index: 12, hired_at: Date.now() - 3600_000 };
  await page.evaluate(([a, b]) => {
    window.__h3d.inject({ t: 'worker.upsert', seq: 9002, worker: a } as never);
    window.__h3d.inject({ t: 'worker.upsert', seq: 9003, worker: b } as never);
  }, [fresh, stale] as const);
  expect((await arrivals(page)).map((a) => [a.id, a.kind, a.session, a.desk])).toEqual([['fresh-1', 'in', 'herdr-3d', 5]]);
  // Its route climbs every flight to the top floor.
  const route = await page.evaluate(() => window.__h3d.route('herdr-3d', 5));
  const storey = (await page.evaluate(() => window.__h3d.building()))?.storey ?? 0;
  expect(route[0]?.y).toBeCloseTo(3 * storey, 3);
  await page.evaluate(() => window.__h3d.arrivalRate(40));
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.arrivalLog())).find((l) => l.id === 'fresh-1')?.played, { timeout: 20_000 }).toBe(true);
  clean();
});

test('an older, read-only bridge: the hire dialog says hiring is not there yet', async ({ page }) => {
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4');
  await enter(page, 'pastry');
  await page.evaluate(() => window.__h3d.openHire(14));
  const d = await hireDialog(page, 'failed');
  expect(d.status).toBe('This herdr-world can’t hire workers yet (the fixture server is read-only). Update the bridge to use it.');
  await expect(page.locator('dialog.desk-dlg--hire [role="alert"]')).toHaveText(d.status);
  await expect(page.locator('dialog.desk-dlg--hire [data-key="hire"]')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await expect.poll(() => dialog(page)).toBeNull();
  // The desk keeps its "+".
  expect((await desks(page))[14]).toMatchObject({ plus: true, away: null });
  clean();
});
