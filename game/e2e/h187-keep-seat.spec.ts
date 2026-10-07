import { expect, test, type Page } from '@playwright/test';
import { frames, leftInTerminal, openGame, seatMode, watchErrors } from './game';

// #187 on demo-m6 with the simulator (sim=1): a background change of the world never takes you from the laptop you sit
// at. A floor's desk count or the building's outline changing rebuilds the floor's scene (a new OfficeView); the seat,
// its transcript, the prompt box (draft, image chips, focus, selection) and the terminal's keys go on over it. Another
// worker leaving or arriving, with the floor resizing, is the bridge's own sequence (`floor.upsert` next to the
// `worker.removed` / `worker.upsert`), injected here. Only your own Esc stands you up.

const SIM = 'play=none&sim=1&simms=150&simusage=0';
const FLOOR = 'lab';
const BUILDING = 'b_3f09a1c2d4e5';

interface W {
  id: string;
  name: string;
  desk: number;
}

const tx = (page: Page) => page.locator('.seat-transcript .tx');
const box = (page: Page) => tx(page).locator('.tx-input');

/** The floor's desk count and its building's other floors say what the bridge renders: this is its `floor.upsert`. */
const upsert = (page: Page, session: string, desks: number) =>
  page.evaluate(
    ([s, n]) => {
      const where = window.__h3d.where();
      if (!where) throw new Error('not in a building');
      window.__h3d.inject({ t: 'floor.upsert', seq: 0, floor: { session: s, state: 'running', building: where.building, index: where.floors.indexOf(s), desks: n } } as never);
    },
    [session, desks] as const,
  );

const rebuilds = (page: Page) => page.evaluate(() => window.__h3d.officeRebuilds());
const seated = (page: Page) => page.evaluate(() => window.__h3d.seated());
const tstate = (page: Page) => page.evaluate(() => window.__h3d.transcript());

/** The floor's workers (the simulator's own also come and go: the desk is what fixes who sits where). */
async function workers(page: Page): Promise<W[]> {
  return page.evaluate((s) => (window.__h3d.world().find((f) => f.session === s)?.workers ?? []).map((w) => ({ id: w.id, name: w.name, desk: w.desk })), FLOOR);
}

/** Enters the lab floor and sits at the worker of `desk` in `mode`. */
async function sitAt(page: Page, desk: number | 'last', mode: 'terminal' | 'transcript'): Promise<W> {
  await openGame(page, 'demo-m6', '&prints=0', SIM);
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 4);
  const all = await workers(page);
  const w = desk === 'last' ? all.reduce<W | undefined>((a, x) => (!a || x.desk > a.desk ? x : a), undefined) : all.find((x) => x.desk === desk);
  if (!w) throw new Error(`no worker at desk ${desk}`);
  if (mode === 'terminal') await leftInTerminal(page, w.id);
  expect(await page.evaluate((id) => window.__h3d.face(id), w.id), `facing ${w.name}`).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), w.id)).toBe(true);
  await expect.poll(() => seated(page)).toBe(w.id);
  await frames(page, 20);
  await seatMode(page, mode);
  return w;
}

/** Focuses the prompt box and types: the caret is in the box and the text is its draft. */
async function draft(page: Page, text: string): Promise<void> {
  await expect.poll(async () => (await tstate(page))?.mounted).toBe(true);
  await box(page).click();
  await page.keyboard.type(text);
  await expect(box(page)).toBeFocused();
}

/** What the page keeps of the prompt box: its text, whether it has the keyboard, and where the caret is. */
const promptState = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('.seat-transcript .tx-input') as HTMLElement | null;
    const sel = window.getSelection();
    return { text: el?.textContent?.replaceAll('\u200b', '') ?? null, focused: !!el && document.activeElement === el, caretIn: !!el && !!sel?.anchorNode && el.contains(sel.anchorNode), offset: sel?.anchorOffset ?? -1 };
  });

/** Still seated at `id`, in `mode`: the view up and mounted, the seat bar shown. */
async function stillThere(page: Page, id: string, mode: 'terminal' | 'transcript', away = false): Promise<void> {
  expect(await seated(page)).toBe(id);
  const t = await tstate(page);
  expect(t?.mode).toBe(mode);
  // (An away worker's conversation is not watched until it is back.)
  if (mode === 'transcript') expect({ mounted: t?.mounted, watches: t?.watches }).toEqual({ mounted: true, watches: away ? 0 : 1 });
  await expect(page.locator('.seat')).toBeVisible();
}

test('the issue’s repro: a floor.upsert with more desks keeps you at the laptop, in its transcript, with your draft', async ({ page }) => {
  const clean = watchErrors(page);
  const w = await sitAt(page, 0, 'transcript');
  await draft(page, 'half a sentence');
  const before = await promptState(page);
  expect(before).toMatchObject({ text: 'half a sentence', focused: true, caretIn: true });
  const built = await rebuilds(page);
  const desks = (await page.evaluate((s) => window.__h3d.layout(s)?.desks, FLOOR)) as number;
  await page.evaluate(() =>
    window.__h3d.inject({ t: 'floor.upsert', floor: { session: 'lab', state: 'running', building: 'b_3f09a1c2d4e5', index: 0, desks: 15 } } as never),
  );
  await frames(page, 6);
  expect(await rebuilds(page), 'the scene was rebuilt').toBe(built + 1);
  expect(await page.evaluate((s) => window.__h3d.layout(s)?.desks, FLOOR)).toBe(15);
  expect(desks).not.toBe(15);
  await stillThere(page, w.id, 'transcript');
  expect(await promptState(page)).toEqual(before);
  // It is still the live box: more typing lands after the draft, with no click.
  await page.keyboard.type(' and the rest');
  await expect(box(page)).toHaveText('half a sentence and the rest');
  clean();
});

test('same-size control: floor.upsert with the existing desk count changes nothing', async ({ page }) => {
  const clean = watchErrors(page);
  const w = await sitAt(page, 0, 'transcript');
  await draft(page, 'control');
  const built = await rebuilds(page);
  const desks = (await page.evaluate((s) => window.__h3d.layout(s)?.desks, FLOOR)) as number;
  await upsert(page, FLOOR, desks);
  await frames(page, 6);
  expect(await rebuilds(page)).toBe(built);
  await stillThere(page, w.id, 'transcript');
  expect(await promptState(page)).toMatchObject({ text: 'control', focused: true });
  clean();
});

test('the camera, the chair and the monitor follow the rebuilt scene: the view is still square on the laptop', async ({ page }) => {
  const clean = watchErrors(page);
  const w = await sitAt(page, 0, 'transcript');
  const rect = async () => (await tstate(page))?.box;
  const before = await rect();
  expect(before).toBeTruthy();
  await upsert(page, FLOOR, 16);
  await frames(page, 6);
  await stillThere(page, w.id, 'transcript');
  expect(await rect()).toEqual(before);
  expect(await page.evaluate(() => window.__h3d.seat().shown)).toBe(true);
  clean();
});

test('terminal mode: more desks do not stand you up, and your keys still reach the worker', async ({ page }) => {
  const clean = watchErrors(page);
  const w = await sitAt(page, 0, 'terminal');
  await page.keyboard.type('a');
  await expect.poll(() => page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.keys').length)).toBeGreaterThan(0);
  const sentKeys = () => page.evaluate(() => window.__h3d.sent().filter((c) => c.t === 'worker.keys').length);
  const n = await sentKeys();
  const built = await rebuilds(page);
  await upsert(page, FLOOR, 16);
  await frames(page, 6);
  expect(await rebuilds(page)).toBe(built + 1);
  await stillThere(page, w.id, 'terminal');
  await page.keyboard.type('b');
  await expect.poll(sentKeys).toBeGreaterThan(n);
  // The screen of the seat is live again on the new monitor (a rebuilt scene starts with none).
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.screens())).find((s) => s.id === w.id)?.state).toBe('live');
  clean();
});

test('another worker leaving with the floor shrinking, then one arriving with it growing, while you type', async ({ page }) => {
  const clean = watchErrors(page);
  const w = await sitAt(page, 0, 'transcript');
  const other = (await workers(page)).find((x) => x.id !== w.id);
  if (!other) throw new Error('no other worker');
  await draft(page, 'one ');
  const built = await rebuilds(page);
  // The bridge sizes a floor from its workers plus two spare desks: a departure shrinks it.
  await page.evaluate((id) => window.__h3d.inject({ t: 'worker.removed', seq: 1_000_000, id, session: 'lab', workspace_id: 'w1' } as never), other.id);
  await upsert(page, FLOOR, 12);
  await page.keyboard.type('two ');
  await frames(page, 6);
  await stillThere(page, w.id, 'transcript');
  // An arrival at a free desk grows it again.
  await page.evaluate(
    ([id, desk]) => {
      const base = window.__h3d.worker(window.__h3d.world().find((f) => f.session === 'lab')?.workers[0]?.id ?? '');
      if (!base) throw new Error('no worker to copy');
      window.__h3d.inject({ t: 'worker.upsert', seq: 0, worker: { ...base, id, label: 'CODE|h187', desk_index: desk, session: 'lab' } } as never);
    },
    ['h187-hire', 11] as const,
  );
  await upsert(page, FLOOR, 17);
  await page.keyboard.type('three');
  await frames(page, 6);
  expect(await rebuilds(page)).toBeGreaterThan(built);
  await stillThere(page, w.id, 'transcript');
  await expect(box(page)).toHaveText('one two three');
  await expect(box(page)).toBeFocused();
  clean();
});

test('the building’s outline changing because of another floor does not take you from yours', async ({ page }) => {
  const clean = watchErrors(page);
  const w = await sitAt(page, 0, 'transcript');
  await draft(page, 'outline');
  const built = await rebuilds(page);
  // Another floor of the building growing (or shrinking) moves the building's outline: this floor is rebuilt too.
  for (const desks of [40, 8]) {
    await upsert(page, 'herdr-3d', desks);
    await frames(page, 6);
    await stillThere(page, w.id, 'transcript');
  }
  expect(await rebuilds(page), 'the outline change rebuilt this floor').toBeGreaterThan(built);
  expect(await promptState(page)).toMatchObject({ text: 'outline', focused: true });
  clean();
});

test('your place in the conversation, its scroll position and an attached image survive the rebuild', async ({ page }) => {
  const clean = watchErrors(page);
  const w = await sitAt(page, 0, 'transcript');
  const scroll = tx(page).locator('.tx-scroll');
  await expect.poll(async () => (await tstate(page))?.items).toBeGreaterThan(3);
  // Up from the bottom: reading something older, which the next items must not pull away from.
  await scroll.evaluate((e) => {
    e.scrollTop = Math.max(0, e.scrollHeight - e.clientHeight - 120);
  });
  await frames(page, 3);
  const top = await scroll.evaluate((e) => e.scrollTop);
  await draft(page, 'see this');
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = 80;
    (c.getContext('2d') as CanvasRenderingContext2D).fillRect(0, 0, 120, 80);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
    document.querySelector('.seat-transcript .tx-input')?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const chips = tx(page).locator('.cmp-chip');
  await expect(chips).toHaveCount(1);
  await expect(chips.locator('.cmp-state')).toHaveText('Uploaded');
  const built = await rebuilds(page);
  await upsert(page, FLOOR, 18);
  await frames(page, 6);
  expect(await rebuilds(page)).toBeGreaterThan(built);
  await stillThere(page, w.id, 'transcript');
  await expect(chips).toHaveCount(1);
  await expect(chips.locator('.cmp-state')).toHaveText('Uploaded');
  await expect(box(page)).toContainText('see this');
  expect(Math.abs((await scroll.evaluate((e) => e.scrollTop)) - top)).toBeLessThan(4);
  clean();
});

test('a worker completing in the background while you type is no news to the view', async ({ page }) => {
  const clean = watchErrors(page);
  const w = await sitAt(page, 0, 'transcript');
  const other = (await workers(page)).find((x) => x.id !== w.id);
  if (!other) throw new Error('no other worker');
  await draft(page, 'typing ');
  await page.evaluate(
    (id) => {
      const o = window.__h3d.worker(id);
      if (!o) throw new Error('no worker');
      window.__h3d.inject({ t: 'worker.upsert', seq: 0, worker: { ...o, agent_status: 'done', display: 'done' } } as never);
    },
    other.id,
  );
  await page.keyboard.type('on');
  await upsert(page, FLOOR, 15);
  await page.keyboard.type('!');
  await frames(page, 6);
  await stillThere(page, w.id, 'transcript');
  await expect(box(page)).toHaveText('typing on!');
  clean();
});

test('your own Esc still stands you up (after a rebuild too), in both views', async ({ page }) => {
  const clean = watchErrors(page);
  for (const mode of ['transcript', 'terminal'] as const) {
    const w = await sitAt(page, 0, mode);
    await upsert(page, FLOOR, 15);
    await frames(page, 6);
    await stillThere(page, w.id, mode);
    if (mode === 'transcript') await expect(tx(page).locator('.tx-scroll')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect.poll(() => seated(page)).toBeNull();
    await expect(page.locator('.seat')).toBeHidden();
    if (mode === 'transcript') expect((await tstate(page))?.mounted).toBe(false);
  }
  clean();
});

const sentOf = (page: Page, t: string) => page.evaluate((x) => window.__h3d.sent().filter((c) => c.t === x).length, t);
const gone = (page: Page, id: string) => page.evaluate((i) => window.__h3d.inject({ t: 'worker.removed', seq: 1_000_000, id: i, session: 'lab', workspace_id: 'w1' } as never), id);

test('the worker you sit at going home keeps the conversation and your draft, says so, and refuses to send', async ({ page }) => {
  const clean = watchErrors(page);
  const w = await sitAt(page, 0, 'transcript');
  await draft(page, 'for the next one');
  const prompts = await sentOf(page, 'worker.prompt');
  await gone(page, w.id);
  await upsert(page, FLOOR, 12);
  await frames(page, 8);
  // Still there: the view, the draft, the keyboard; the bar says why nothing will be sent.
  expect(await seated(page)).toBe(w.id);
  expect((await tstate(page))?.mode).toBe('transcript');
  expect(await promptState(page)).toMatchObject({ text: 'for the next one', focused: true });
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.seat())).state).toBe('offline');
  expect((await page.evaluate(() => window.__h3d.seat())).note).toContain(`${w.name} is no longer on the floor.`);
  // Enter is refused where it stands: nothing goes out, the text stays in the box with the reason.
  await page.keyboard.press('Enter');
  await frames(page, 6);
  expect(await sentOf(page, 'worker.prompt')).toBe(prompts);
  await expect(box(page)).toContainText('for the next one');
  expect(await seated(page)).toBe(w.id);
  // The way out is still yours.
  await page.keyboard.press('Escape');
  await expect.poll(() => seated(page)).toBeNull();
  clean();
});

test('terminal mode: the worker going home keeps the screen up and sends none of your keys', async ({ page }) => {
  const clean = watchErrors(page);
  const w = await sitAt(page, 0, 'terminal');
  await gone(page, w.id);
  await frames(page, 8);
  expect(await seated(page)).toBe(w.id);
  expect((await tstate(page))?.mode).toBe('terminal');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.seat())).state).toBe('offline');
  const keys = await sentOf(page, 'worker.keys');
  await page.keyboard.type('xyz');
  await frames(page, 4);
  expect(await sentOf(page, 'worker.keys')).toBe(keys);
  await page.keyboard.press('Escape');
  await expect.poll(() => seated(page)).toBeNull();
  clean();
});

test('a floor going to sleep keeps the seat and the draft; waking it brings the laptop back', async ({ page }) => {
  const clean = watchErrors(page);
  const w = await sitAt(page, 0, 'transcript');
  await draft(page, 'while it sleeps');
  const floor = (state: string) =>
    page.evaluate((st) => {
      const where = window.__h3d.where();
      if (!where) throw new Error('not in a building');
      window.__h3d.inject({ t: 'floor.upsert', seq: 0, floor: { session: 'lab', state: st, building: where.building, index: where.floors.indexOf('lab'), desks: window.__h3d.layout('lab')?.desks } } as never);
    }, state);
  await floor('asleep');
  await frames(page, 8);
  expect(await seated(page)).toBe(w.id);
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.seat())).note).toContain('is asleep');
  expect(await promptState(page)).toMatchObject({ text: 'while it sleeps', focused: true });
  await floor('running');
  await expect.poll(async () => (await page.evaluate(() => window.__h3d.seat())).state).toBe('ok');
  await expect.poll(async () => (await tstate(page))?.watches).toBe(1);
  expect(await seated(page)).toBe(w.id);
  expect(await promptState(page)).toMatchObject({ text: 'while it sleeps' });
  clean();
});

test('your floor moving to another storey of the building moves you with it, still seated', async ({ page }) => {
  const clean = watchErrors(page);
  const w = await sitAt(page, 0, 'transcript');
  await draft(page, 'a floor up');
  const y0 = (await page.evaluate(() => window.__h3d.pose()))?.y;
  // The building's floors are listed again with lab last: it is the ground floor now (the walker is moved with it, which is not a step).
  await page.evaluate(() => {
    const where = window.__h3d.where();
    if (!where) throw new Error('not in a building');
    window.__h3d.inject({ t: 'building.upsert', seq: 0, building: { id: where.building, name: 'Work', sort: 0, floors: [...where.floors.filter((x) => x !== 'lab'), 'lab'] } } as never);
  });
  await frames(page, 8);
  expect((await page.evaluate(() => window.__h3d.pose()))?.y, 'the floor moved').not.toBe(y0);
  await stillThere(page, w.id, 'transcript');
  expect(await promptState(page)).toMatchObject({ text: 'a floor up', focused: true });
  clean();
});

const removeFloor = (page: Page, session = FLOOR) => page.evaluate((x) => window.__h3d.inject({ t: 'floor.removed', seq: 1_000_000, session: x } as never), session);
const mode = (page: Page) => page.evaluate(() => window.__h3d.view().mode);
const seatBar = (page: Page) => page.evaluate(() => window.__h3d.seat());

test('the worker you sit at leaves and the floor shrinks past its desk: the view, the draft and the keyboard stay', async ({ page }) => {
  const clean = watchErrors(page);
  const w = await sitAt(page, 'last', 'transcript');
  expect(w.desk, 'a desk to trim away').toBeGreaterThan(0);
  await draft(page, 'still here');
  const before = (await tstate(page))?.box;
  expect(before).toBeTruthy();
  const built = await rebuilds(page);
  await gone(page, w.id);
  // The bridge sizes the floor from its workers: the desk of the one that left is trimmed away.
  await upsert(page, FLOOR, w.desk);
  await frames(page, 8);
  expect(await rebuilds(page), 'the scene was rebuilt without the desk').toBeGreaterThan(built);
  expect(await seated(page)).toBe(w.id);
  expect((await tstate(page))?.mounted).toBe(true);
  // The glass is where it was: the conversation is still laid over it, visible and under the caret.
  const after = (await tstate(page))?.box;
  expect(after).toBeTruthy();
  // (The bar says why on more lines now, so the glass is refitted a little smaller, but it is the same place.)
  const mid = (b: typeof before) => ({ x: (b?.left ?? 0) + (b?.width ?? 0) / 2, y: (b?.top ?? 0) + (b?.height ?? 0) / 2 });
  expect(Math.abs(mid(after).x - mid(before).x)).toBeLessThan(30);
  expect(Math.abs(mid(after).y - mid(before).y)).toBeLessThan(30);
  expect(after?.width ?? 0).toBeGreaterThan((before?.width ?? 0) * 0.8);
  await expect(box(page)).toBeVisible();
  expect(await promptState(page)).toMatchObject({ text: 'still here', focused: true });
  await expect.poll(async () => (await seatBar(page)).state).toBe('offline');
  await page.keyboard.type(' and more');
  await expect(box(page)).toHaveText('still here and more');
  // A window resize refits the camera to the glass it has kept.
  await page.setViewportSize({ width: 1100, height: 700 });
  await frames(page, 6);
  await expect(box(page)).toBeVisible();
  expect((await tstate(page))?.box).toBeTruthy();
  await page.keyboard.press('Escape');
  await expect.poll(() => seated(page)).toBeNull();
  clean();
});

for (const view of ['transcript', 'terminal'] as const) {
  test(`${view}: the floor you sit on being removed keeps you seated, offline, with your draft; Esc then leaves cleanly`, async ({ page }) => {
    const clean = watchErrors(page);
    const w = await sitAt(page, 0, view);
    if (view === 'transcript') await draft(page, 'typed while it went');
    const keys = await sentOf(page, 'worker.keys');
    const prompts = await sentOf(page, 'worker.prompt');
    await removeFloor(page);
    await frames(page, 10);
    // Nothing took you from it: still on the floor, still at the laptop, in the view you had.
    expect(await mode(page)).toBe('floor');
    await stillThere(page, w.id, view, true);
    await expect.poll(async () => (await seatBar(page)).state).toBe('offline');
    expect((await seatBar(page)).note).toContain('Nothing you type is sent');
    if (view === 'transcript') {
      expect(await promptState(page)).toMatchObject({ text: 'typed while it went', focused: true });
      await page.keyboard.type('!');
      await page.keyboard.press('Enter');
      await frames(page, 4);
      await expect(box(page)).toContainText('typed while it went!');
      expect(await sentOf(page, 'worker.prompt')).toBe(prompts);
    } else {
      await page.keyboard.type('xyz');
      await frames(page, 4);
      expect(await sentOf(page, 'worker.keys')).toBe(keys);
    }
    // Esc is yours: it gets you up, and then the floor that is gone is left for the city.
    await page.keyboard.press('Escape');
    await expect.poll(() => seated(page)).toBeNull();
    await expect.poll(() => mode(page)).toBe('city');
    expect(await page.evaluate(() => window.__h3d.view().floor)).toBeNull();
    expect(await page.evaluate(() => window.__h3d.where())).toBeNull();
    await expect(page.locator('.seat')).toBeHidden();
    expect((await tstate(page))?.mounted).toBe(false);
    // The city and the other floors work as usual.
    await expect
      .poll(async () => {
        await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
        return page.evaluate(() => window.__h3d.view().floor);
      })
      .toBe('herdr-3d');
    await frames(page, 4);
    clean();
  });
}

test('the floor coming back while you still sit at it brings the worker back too', async ({ page }) => {
  const clean = watchErrors(page);
  const w = await sitAt(page, 0, 'transcript');
  await draft(page, 'back soon');
  const worker = await page.evaluate((id) => window.__h3d.worker(id), w.id);
  const where = await page.evaluate(() => window.__h3d.where());
  if (!worker || !where) throw new Error('nothing to restore');
  await removeFloor(page);
  await frames(page, 6);
  await expect.poll(async () => (await seatBar(page)).state).toBe('offline');
  await page.evaluate(
    ([f, b, i, n]) => window.__h3d.inject({ t: 'floor.upsert', seq: 0, floor: { session: f, state: 'running', building: b, index: i, desks: n } } as never),
    [FLOOR, where.building, where.floors.indexOf(FLOOR), 12] as const,
  );
  await page.evaluate((x) => window.__h3d.inject({ t: 'worker.upsert', seq: 0, worker: x } as never), worker);
  await expect.poll(async () => (await seatBar(page)).state).toBe('ok');
  await stillThere(page, w.id, 'transcript');
  expect(await promptState(page)).toMatchObject({ text: 'back soon', focused: true });
  clean();
});

test('Ctrl+Esc while the worker is away: the bar keeps saying so in the terminal view and back, and never promises your keys', async ({ page }) => {
  const clean = watchErrors(page);
  const w = await sitAt(page, 0, 'transcript');
  await gone(page, w.id);
  await expect.poll(async () => (await seatBar(page)).state).toBe('offline');
  const keys = await sentOf(page, 'worker.keys');
  for (const to of ['terminal', 'transcript', 'terminal'] as const) {
    await seatMode(page, to);
    await frames(page, 4);
    const bar = await seatBar(page);
    expect(bar.state, `bar in ${to}`).toBe('offline');
    expect(bar.note).toContain(`${w.name} is no longer on the floor.`);
    expect(bar.note).not.toContain('Your keys go to');
  }
  await page.keyboard.type('xyz');
  await frames(page, 4);
  expect(await sentOf(page, 'worker.keys')).toBe(keys);
  // The reason is readable at a glance: the note wraps instead of ending in an ellipsis.
  const note = page.locator('.seat-note');
  const fit = await note.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight, text: e.textContent, lh: parseFloat(getComputedStyle(e).lineHeight) }));
  expect(fit.sw, JSON.stringify(fit)).toBeLessThanOrEqual(fit.cw + 1);
  expect(fit.sh, JSON.stringify(fit)).toBeLessThanOrEqual(fit.ch + 1);
  clean();
});
