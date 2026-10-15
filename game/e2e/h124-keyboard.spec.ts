import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Worker } from '../src/net/protocol';
import { frames, openGame, watchErrors, openMenu } from './game';

// #124: keyboard-only play on demo-m5 with the simulator: the shortcut list (?), a key each for Hire, Issues, Pull
// requests, Start Run and the Inbox list, picking a worker without the mouse (T), looking up and down, and the whole
// hire → conversation → Issues → Inbox walk with the keyboard alone. Work holds herdr-3d (top), depot-manager (asleep)
// and pastry; scratchpad is in the unassigned lot.

const SIM = 'play=none&sim=1&simms=150&simlimits=ok';
const FLOOR = 'herdr-3d';
// The simulator of the boards and the runs: demo-m6 (the `herdr-3d` floor has a board and two free desks; `pastry` two free desks and no repo).
const SIM6 = 'play=none&sim=1&simms=150&simusage=0';

const workers = (): Worker[] => (JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/demo-m5.jsonl'), 'utf8').split('\n')[0] ?? '{}') as { world: { workers: Worker[] } }).world.workers;

async function onFloor(page: Page, floor = FLOOR): Promise<void> {
  await openGame(page, 'demo-m5', '&prints=0', SIM);
  await page.evaluate((f) => window.__h3d.enterFloor(f), floor);
  await frames(page, 3);
}

const dialog = (page: Page) => page.evaluate(() => window.__h3d.dialog());
const target = (page: Page) => page.evaluate(() => window.__h3d.target());
const help = (page: Page) => page.locator('dialog.shortcuts');

test('? opens the shortcut list from the floor and the city: grouped, labelled, Esc closes it and the focus comes back', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page);
  // On a floor, from a focused top bar button: the focus goes into the dialog and Esc gives it back.
  await page.keyboard.press('Shift+Tab');
  const first = await page.evaluate(() => (document.activeElement as HTMLElement).textContent);
  expect(first).toBeTruthy();
  await page.keyboard.press('Shift+?');
  await expect(help(page)).toBeVisible();
  expect(await page.evaluate(() => window.__h3d.shortcutsOpen())).toBe(true);
  await expect(help(page)).toHaveAttribute('aria-labelledby', 'shortcuts-title');
  await expect(page.locator('#shortcuts-title')).toHaveText('Keyboard shortcuts');
  await expect(help(page).locator('h3')).toHaveText(['On a floor', 'In the city', 'Aimed at something', 'Dialogs and fields', 'At a laptop']);
  await expect(help(page)).toContainText('pause the moment a text field has it');
  await expect(help(page)).toContainText('Esc stands you up; then ? opens this list.');
  // Focus is trapped: Tab goes round the dialog (its list, its Close) or out to the browser, never to the top bar behind it, and the floor plan does not open.
  const seen = new Set<string>();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    seen.add(await page.evaluate(() => (document.activeElement?.closest('.hud') ? 'behind' : document.activeElement?.closest('dialog.shortcuts') ? (document.activeElement as HTMLElement).className : 'out')));
  }
  expect([...seen]).not.toContain('behind');
  expect((await page.evaluate(() => window.__h3d.view())).plan).toBe(false);
  // The focus is back inside for the keys below.
  await page.evaluate(() => (document.querySelector('.sc-body') as HTMLElement).focus());
  // A game key does nothing behind it, and `?` again does not stack another.
  await page.keyboard.press('KeyH');
  await page.keyboard.press('Shift+?');
  expect(await dialog(page)).toBeNull();
  await expect(help(page)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(help(page)).toBeHidden();
  expect(await page.evaluate(() => (document.activeElement as HTMLElement).textContent)).toBe(first);

  // In the city.
  await page.evaluate(() => window.__h3d.leaveFloor());
  await frames(page, 3);
  expect((await page.evaluate(() => window.__h3d.view())).mode).toBe('city');
  await page.keyboard.press('Shift+?');
  await expect(help(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help(page)).toBeHidden();
  clean();
});

const idOf = async (page: Page, name: string): Promise<string> => {
  const id = await page.evaluate((n) => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === n)?.id ?? null, name);
  if (!id) throw new Error(`no worker ${name}`);
  return id;
};

test('H, I, G, Shift+R and Shift+N each open their thing without aiming, and the top bar says which key', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '&open=none', SIM6);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 4);
  // The titles name the keys (the Inbox chip's too once it shows).
  await expect(page.locator('.btn--hire')).toHaveAttribute('title', /\(H\), or look at a desk/);
  await expect(page.locator('.topbar button', { hasText: 'Issues' })).toHaveAttribute('title', /board as a list \(I\)$/);
  await expect(page.locator('.topbar button', { hasText: 'PRs' })).toHaveAttribute('title', /pull requests as a list \(G\)$/);
  await expect(page.locator('.btn--run')).toHaveAttribute('title', /first free desk \(Shift\+R\), or pick/);
  await expect(page.locator('.ib-chip')).toHaveAttribute('title', /Click for who and where \(Shift\+N\)\.$/);
  // (Spawned facing the wall boards: E would open one, but nothing is picked.)
  expect((await target(page))?.picked ?? false).toBe(false);

  // H: the dialog of the first free desk, as the Hire button's.
  const free = await page.evaluate(() => window.__h3d.desks().find((d) => d.plus)?.desk);
  expect(free).toBeGreaterThanOrEqual(0);
  // Not with the wrong modifiers (exact matching), nor held (no auto-repeat re-fire is needed to see this: one press, one dialog).
  for (const k of ['Shift+H', 'Control+h', 'Alt+h', 'Meta+h']) {
    await page.keyboard.press(k);
    await frames(page, 2);
    expect(await dialog(page), k).toBeNull();
  }
  await page.keyboard.press('h');
  await expect.poll(async () => (await dialog(page))?.kind === 'hire' && (await dialog(page))?.state, { timeout: 10_000 }).toBe('ready');
  expect(await dialog(page)).toMatchObject({ kind: 'hire', floor: 'herdr-3d', desk: free });
  await page.keyboard.press('Escape');
  await expect.poll(() => dialog(page)).toBeNull();
  await expect(page.locator('dialog[open]')).toHaveCount(0);

  // I and G: the board lists.
  await page.keyboard.press('i');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.board()))?.kind).toBe('issues');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.board())).toBeNull();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await page.keyboard.press('g');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.board()))?.kind).toBe('prs');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.board())).toBeNull();
  await expect(page.locator('dialog[open]')).toHaveCount(0);

  // Shift+R: Start Run; plain R does nothing off the radio.
  await page.keyboard.press('r');
  await frames(page, 2);
  expect(await dialog(page)).toBeNull();
  await page.keyboard.press('Shift+R');
  await expect.poll(async () => (await dialog(page))?.kind).toBe('start-run');
  expect(await dialog(page)).toMatchObject({ floor: 'herdr-3d', desk: free });
  await page.keyboard.press('Escape');
  await expect.poll(() => dialog(page)).toBeNull();
  await expect(page.locator('dialog[open]')).toHaveCount(0);

  // Shift+N: the inbox list, with the focus on its first row; it is not N (which goes to the next who needs you, and moves you).
  const before = await page.evaluate(() => window.__h3d.pose());
  expect(await page.evaluate(() => window.__h3d.inbox())).toMatchObject({ shown: true, open: false });
  await page.keyboard.press('Shift+N');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.inbox()))?.open).toBe(true);
  expect(await page.evaluate(() => document.activeElement?.classList.contains('ib-row'))).toBe(true);
  expect(await page.evaluate(() => window.__h3d.pose())).toEqual(before);
  expect(await page.evaluate(() => window.__h3d.panel())).toBeNull();
  await page.keyboard.press('Shift+N');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.inbox()))?.open).toBe(false);
  await page.keyboard.press('Shift+N');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.inbox()))?.open).toBe(false);
  clean();
});

test('Shift+N with nothing in the inbox says so', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const all = workers();
  await openGame(page, 'demo-m5', '&prints=0', SIM);
  let seq = 2_000_000;
  for (const w of all) {
    if (w.status !== 'blocked' && w.status !== 'done') continue;
    await page.evaluate(([x, n]) => window.__h3d.inject({ t: 'worker.status', seq: n, id: x.id, session: x.session, workspace_id: x.workspace_id, status: 'working', prev_status: x.status, status_since: Date.now(), title: '' }), [w, seq++] as const);
  }
  await expect.poll(() => page.evaluate(() => window.__h3d.inbox())).toMatchObject({ shown: false, count: 0 });
  await page.keyboard.press('Shift+N');
  await expect(page.locator('.toast')).toContainText('Nothing in the inbox');
  clean();
});

test('T picks a worker without the mouse: the same prompt, then E P C X and the answer digits work on it', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m5', '&prints=0', 'play=none&sim=1&simms=500&simusage=0');
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 4);
  const tofu = await idOf(page, 'Tofu');
  expect((await target(page))?.picked ?? false).toBe(false);
  // T goes through the workers and free desks of the floor; Shift+T goes back.
  const seen: string[] = [];
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('t');
    await frames(page, 1);
    const t = await target(page);
    expect(t?.picked).toBe(true);
    seen.push(`${t?.kind}:${t?.id}`);
    if (t?.id === tofu) break;
  }
  expect(seen.at(-1)).toBe(`worker:${tofu}`);
  expect(new Set(seen).size).toBe(seen.length);
  const prompt = page.locator('.prompt');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('Tofu');
  // The same highlight as aiming: the question's choices and the keys on its prompt bar.
  await expect(prompt.locator('.key')).toContainText(['Changes', 'Prompt', 'Send home']);
  await expect(prompt.locator('.key--approve')).toBeVisible();
  // Shift+T: back one, and forward again.
  await page.keyboard.press('Shift+T');
  await frames(page, 1);
  expect((await target(page))?.id).toBe(seen.at(-2)?.split(':')[1]);
  await page.keyboard.press('t');
  await frames(page, 1);
  expect((await target(page))?.id).toBe(tofu);
  // The answer digit goes to the picked worker (no aiming).
  await page.keyboard.press('1');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === 'worker.answer').at(-1)?.args).toMatchObject({ id: tofu, choice: 1 });
  // C: its Changes panel; Esc shuts it.
  await page.keyboard.press('c');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.panel()))?.kind).toBe('changes');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.panel())).toBeNull();
  // Esc lets go of the pick: back to what the crosshair says.
  await page.keyboard.press('Escape');
  await frames(page, 2);
  expect((await target(page))?.picked ?? false).toBe(false);
  await page.keyboard.press('t');
  await frames(page, 1);
  expect((await target(page))?.picked).toBe(true);
  // Moving lets go of it as well.
  await page.keyboard.down('KeyA');
  await frames(page, 4);
  await page.keyboard.up('KeyA');
  await frames(page, 2);
  expect((await target(page))?.picked ?? false).toBe(false);
  clean();
});

test('looking up and down from the keyboard: a worker is out of the arrows’ reach at the default pitch; Page Down brings it in, Home levels the view', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await onFloor(page);
  const pebble = await idOf(page, 'Pebble');
  expect(await page.evaluate((i) => window.__h3d.face(i), pebble)).toBe(true);
  await frames(page, 3);
  // The spawn's own pitch (-0.05, a little down): from where facing Pebble works, the ray passes over the chair.
  const at = await page.evaluate(() => window.__h3d.pose());
  expect(at).not.toBeNull();
  const stand = { x: at!.x, z: at!.z, yaw: at!.yaw };
  await page.evaluate((s) => window.__h3d.setPose({ ...s, pitch: -0.05 }), stand);
  await frames(page, 3);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toBeNull();
  // The arrows only turn: turning away and back leaves it out of reach.
  await page.keyboard.down('ArrowLeft');
  await frames(page, 3);
  await page.keyboard.up('ArrowLeft');
  await page.evaluate((s) => window.__h3d.setPose({ ...s, pitch: -0.05 }), stand);
  await frames(page, 3);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toBeNull();
  // Page Down, held: the view tips down until the worker is under the crosshair.
  await page.keyboard.down('PageDown');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.lookAt()))?.id, { timeout: 20_000 }).toBe(pebble);
  await page.keyboard.up('PageDown');
  const down = (await page.evaluate(() => window.__h3d.pose()))!;
  expect(down.pitch).toBeLessThan(-0.05);
  expect([down.x, down.z, down.yaw]).toEqual([stand.x, stand.z, stand.yaw]);
  // Ctrl+Page Down is the browser's (tabs): the view does not move.
  await page.keyboard.press('Control+PageDown');
  await frames(page, 3);
  expect((await page.evaluate(() => window.__h3d.pose()))!.pitch).toBe(down.pitch);
  // Page Up, held, tips it up; Home levels it.
  await page.keyboard.down('PageUp');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.pose()))!.pitch, { timeout: 20_000 }).toBeGreaterThan(0.1);
  await page.keyboard.up('PageUp');
  await page.keyboard.press('Home');
  await frames(page, 2);
  expect((await page.evaluate(() => window.__h3d.pose()))!.pitch).toBe(0);
  clean();
});

test('T reaches the radio and the elevator too (the radio is below the default view): E and R then work on them', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await onFloor(page);
  const pickUntil = async (id: string) => {
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('t');
      await frames(page, 1);
      if ((await target(page))?.id === id) return;
    }
    throw new Error(`T never reached ${id}`);
  };
  await pickUntil('radio');
  await expect(page.locator('.prompt')).toContainText('Radio');
  const genre = (await page.evaluate(() => window.__h3d.radio()))?.genre;
  await page.keyboard.press('e');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.radio()))?.genre).not.toBe(genre);
  const track = (await page.evaluate(() => window.__h3d.radioEvents())).length;
  await page.keyboard.press('r');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.radioEvents())).length).toBeGreaterThan(track);
  await pickUntil('elevator');
  await page.keyboard.press('e');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.panel()))?.kind).toBe('elevator');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.panel())).toBeNull();
  // The boards, by key: T to the Issues board, E opens it (as aiming does).
  await pickUntil('board.issues');
  await page.keyboard.press('e');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.board()))?.kind ?? (await page.locator('.toast').allTextContents()).join()).toMatch(/issues|bridge/);
  clean();
});

test('keyboard only: from the city into a floor, hire, pick the new worker and open its conversation, then Issues, then the Inbox', { tag: '@smoke' }, async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  // The hire leaves you where you stand (Settings → Display "Go to a new hire after hiring" off): the way to its laptop is the keyboard's.
  await page.addInitScript(() => localStorage.setItem('h3d.hire.goto', 'off'));
  await openGame(page, 'demo-m6', '&open=none', SIM6);
  expect((await page.evaluate(() => window.__h3d.view())).mode).toBe('city');
  // City → floor with no pointer: Tab walks the floor list, Enter goes inside (the 3D pick is the mouse's; this is the keyboard's way).
  let focused = '';
  for (let i = 0; i < 20 && !/pastry/.test(focused); i++) {
    await page.keyboard.press('Tab');
    focused = await page.evaluate(() => (document.activeElement?.closest('.floor-list') ? (document.activeElement as HTMLElement).textContent ?? '' : ''));
  }
  expect(focused).toMatch(/pastry/);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.view())).floor, { timeout: 30_000 }).toBe('pastry');
  await frames(page, 4);
  // The top bar is reachable by Shift+Tab and its focus is drawn.
  await page.keyboard.press('Shift+Tab');
  const outline = await page.evaluate(() => {
    const e = document.activeElement as HTMLElement | null;
    return { inBar: !!e?.closest('.topbar'), width: e ? getComputedStyle(e).outlineWidth : '0px', style: e ? getComputedStyle(e).outlineStyle : 'none' };
  });
  expect(outline).toMatchObject({ inBar: true, style: 'solid' });
  expect(parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());

  // Hire at the first free desk: H, type the task, Enter.
  const free = await page.evaluate(() => window.__h3d.desks().find((d) => d.plus)?.desk);
  expect(free).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('h');
  await expect.poll(async () => (await dialog(page))?.kind === 'hire' && (await dialog(page) as { state: string }).state, { timeout: 10_000 }).toBe('ready');
  await expect(page.locator('#hire-task')).toBeFocused();
  await page.keyboard.type('Label the loaves');
  await page.keyboard.press('Enter');
  await expect.poll(() => dialog(page)).toBeNull();
  const worker = await expect
    .poll(() => page.evaluate((d) => window.__h3d.desks()[d as number]?.worker ?? null, free), { timeout: 30_000 })
    .not.toBeNull()
    .then(() => page.evaluate((d) => window.__h3d.desks()[d as number]?.worker as string, free));
  await expect.poll(() => page.evaluate(() => window.__h3d.arrivals().length), { timeout: 30_000 }).toBe(0);
  expect(await page.evaluate(() => window.__h3d.seated())).toBeNull();
  // T to the new worker, E to sit at its laptop: its conversation is on screen.
  let picked = '';
  for (let i = 0; i < 60 && picked !== worker; i++) {
    await page.keyboard.press('t');
    await frames(page, 1);
    picked = (await target(page))?.id ?? '';
  }
  expect(picked).toBe(worker);
  await page.keyboard.press('e');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated()), { timeout: 20_000 }).toBe(worker);
  await expect(page.locator('.seat-transcript')).toBeVisible();
  expect(await page.evaluate(() => window.__h3d.seat().mode)).toBe('transcript');
  // Esc stands you up (the one seated key that is ours), then I: the Issues list.
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  await frames(page, 3);
  await page.keyboard.press('i');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.board()))?.kind, { timeout: 15_000 }).toBe('issues');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.board())).toBeNull();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await frames(page, 2);
  // Shift+N: the Inbox list, the focus in it.
  await page.keyboard.press('Shift+N');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.inbox()))?.open).toBe(true);
  expect(await page.evaluate(() => document.activeElement?.classList.contains('ib-row'))).toBe(true);
  clean();
});

test('the issues board without the mouse: Tab reaches a card, Enter opens it, and its "Move to column" control stands in for dragging', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m6', '&open=none', SIM6);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 4);
  await page.keyboard.press('i');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.board()))?.kind, { timeout: 15_000 }).toBe('issues');
  const tabTo = async (sel: string, max = 40): Promise<void> => {
    for (let i = 0; i < max; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate((s) => !!document.activeElement?.matches(s), sel)) return;
    }
    throw new Error(`Tab never reached ${sel}`);
  };
  await tabTo('.bd-card');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.board()))?.item?.state, { timeout: 15_000 }).toBe('ready');
  await tabTo('[data-key="move-to"]');
  await expect(page.locator('[data-key="move-to"]')).toBeFocused();
  await expect(page.locator('[data-key="move-to"]')).toHaveAccessibleName('Move to column');
  clean();
});

test('? opens over About, Settings and the elevator panel (not a field of them), over a dialog, and not at a seat', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await onFloor(page);
  // Settings, whose dialog stops every key: ? still reaches the game, the list opens on top, Esc closes only it.
  await page.keyboard.press(',');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await page.evaluate(() => (document.querySelector('dialog.settings .panel-body, dialog[aria-labelledby="settings-title"] .panel-body') as HTMLElement | null)?.focus());
  await page.keyboard.press('Shift+Slash');
  await expect(help(page)).toBeVisible();
  await expect(settings).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help(page)).toBeHidden();
  await expect(settings).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  // About (the info button).
  await openMenu(page);
  await page.getByRole('button', { name: 'About', exact: true }).click();
  const about = page.getByRole('dialog', { name: 'About' });
  await expect(about).toBeVisible();
  await page.keyboard.press('Shift+Slash');
  await expect(help(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help(page)).toBeHidden();
  await expect(about).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(about).toBeHidden();
  // The elevator panel: a row has the focus.
  await page.keyboard.press('l');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.panel()))?.kind).toBe('elevator');
  await page.keyboard.press('Shift+Slash');
  await expect(help(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help(page)).toBeHidden();
  expect((await page.evaluate(() => window.__h3d.panel()))?.kind).toBe('elevator');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.panel())).toBeNull();
  // A dialog (Start Run), focus on its first button-like control: the same.
  await page.keyboard.press('Shift+R');
  await expect.poll(async () => (await dialog(page))?.kind).toBe('start-run');
  await page.evaluate(() => (document.querySelector('dialog[open] button') as HTMLElement | null)?.focus());
  await page.keyboard.press('Shift+Slash');
  await expect(help(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help(page)).toBeHidden();
  expect((await dialog(page))?.kind).toBe('start-run');
  await page.keyboard.press('Escape');
  await expect.poll(() => dialog(page)).toBeNull();
  await expect(page.locator('dialog[open]')).toHaveCount(0);

  // Seated: no help key. The conversation's scroller has the keyboard; ? is the terminal's (the timeline's).
  const pebble = await idOf(page, 'Pebble');
  expect(await page.evaluate((i) => window.__h3d.face(i), pebble)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((i) => window.__h3d.sitAt(i), pebble)).toBe(true);
  await frames(page, 10);
  await page.keyboard.press('Shift+Slash');
  await page.keyboard.press('Control+Slash');
  await frames(page, 3);
  await expect(help(page)).toBeHidden();
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(pebble);
  // Esc, then ?: the list from a standing position.
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBeNull();
  await frames(page, 3);
  await page.keyboard.press('Shift+Slash');
  await expect(help(page)).toBeVisible();
  clean();
});

test('a held key does not re-fire a toggle (B, Tab, H): one press, one change', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page);
  const battery = page.locator('.btn--battery');
  await expect(battery).toHaveAttribute('aria-pressed', 'false');
  // Playwright sends auto-repeat for a key pressed again with no release in between.
  for (let i = 0; i < 4; i++) await page.keyboard.down('KeyB');
  await page.keyboard.up('KeyB');
  await expect(battery).toHaveAttribute('aria-pressed', 'true');
  for (let i = 0; i < 3; i++) await page.keyboard.down('Tab');
  await page.keyboard.up('Tab');
  expect((await page.evaluate(() => window.__h3d.view())).plan).toBe(true);
  await page.keyboard.press('Tab');
  expect((await page.evaluate(() => window.__h3d.view())).plan).toBe(false);
  for (let i = 0; i < 4; i++) await page.keyboard.down('KeyH');
  await page.keyboard.up('KeyH');
  await expect.poll(async () => (await dialog(page))?.kind).toBe('hire');
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  clean();
});
