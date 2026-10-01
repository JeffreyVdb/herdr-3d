import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { frames, openGame, RESULTS, shot, watchErrors } from './game';

// M13 (#15): the whiteboard, on the demo fixture with the simulator (sim=1) and the fixture server's whiteboard
// (tools/fixture-whiteboard.ts: the bridge's HTTP routes and commands in memory, one set of boards per `wb_key`, kept
// across page loads as the bridge keeps them across restarts). The editor is the real Excalidraw, driven with real
// keys, pointer drags and a real paste. Every request to another host than the preview server is blocked and
// recorded: the board must make none. Screenshots for the pull request go to docs/img/m13 (H3D_EVIDENCE_DIR).

const EVIDENCE = process.env.H3D_EVIDENCE_DIR ?? resolve(RESULTS, 'm13');
mkdirSync(EVIDENCE, { recursive: true });
const evidence = (page: Page, name: string) => page.screenshot({ path: resolve(EVIDENCE, `${name}.png`) });

const FLOOR = 'herdr-3d';
const unique = () => `wb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

type Info = NonNullable<ReturnType<Window['__h3d']['whiteboard']>>;
const info = (page: Page) => page.evaluate(() => window.__h3d.whiteboard()) as Promise<Info>;

interface Stored {
  version: number;
  render: boolean;
  render_version: number;
  stale: boolean;
  files: string[];
  renderSha: string | null;
  saves: number;
  elements: Array<Record<string, unknown>>;
  history: number[];
}

async function stored(page: Page, key: string): Promise<Stored> {
  return page.evaluate(async ({ key, floor }) => {
    const r = await fetch(`/whiteboard/_state?wb_key=${key}&floor=${floor}`);
    return ((await r.json()) as { data: Stored }).data;
  }, { key, floor: FLOOR });
}

/** Blocks every request that leaves the preview server, and lists them. */
async function offline(page: Page): Promise<string[]> {
  const out: string[] = [];
  await page.context().route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.protocol === 'data:' || u.protocol === 'blob:' || ((u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port === process.env.PORTLEASE_PREVIEW_PORT)) return route.fallback();
    out.push(u.href);
    return route.abort();
  });
  return out;
}

/** Into the floor, standing back from the whiteboard on the north wall, looking at it. */
async function faceBoard(page: Page): Promise<void> {
  await page.evaluate((floor) => window.__h3d.enterFloor(floor), FLOOR);
  await frames(page, 3);
  await page.evaluate((floor) => {
    const b = window.__h3d.layout(floor)?.props.find((p) => p.id === 'whiteboard')?.box;
    if (!b) throw new Error('no whiteboard prop');
    window.__h3d.setPose({ x: (b.min[0] + b.max[0]) / 2, z: 2.4, yaw: 0, pitch: 0.02 });
  }, FLOOR);
  await frames(page, 3);
}

async function openBoard(page: Page): Promise<void> {
  await page.keyboard.press('KeyE');
  await expect.poll(async () => (await info(page)).overlay.loaded, { timeout: 60_000, message: 'the editor loads' }).toBe(true);
  await expect(page.locator('.wb .excalidraw')).toBeVisible();
}

const editorChunks = (page: Page) => page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\/assets\/(editor|excalidraw-)/.test(n)));

/** A real drag on the board's canvas, from (x0, y0) to (x1, y1) in fractions of it. */
async function drag(page: Page, x0: number, y0: number, x1: number, y1: number): Promise<void> {
  const box = await page.locator('.wb-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  await page.mouse.move(box.x + box.width * x0, box.y + box.height * y0);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width * (x0 + ((x1 - x0) * i) / 8), box.y + box.height * (y0 + ((y1 - y0) * i) / 8));
  await page.mouse.up();
}

const sceneTypes = (page: Page) =>
  page.evaluate(() => {
    const api = window.__h3d.excalidraw() as { getSceneElements(): Array<{ type: string; isDeleted: boolean }> } | null;
    return (api?.getSceneElements() ?? []).map((e) => e.type).sort();
  });

const savedAt = async (page: Page, min: number) => {
  await expect.poll(async () => { const i = await info(page); return i.overlay.status === 'saved' && (i.state?.version ?? 0) >= min; }, { timeout: 30_000, message: `saved at version ${min} or later` }).toBe(true);
};

/** A pasted screenshot: a real ClipboardEvent carrying a PNG file, on the editor. */
async function pasteImage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 360;
    c.height = 200;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    g.fillStyle = '#12a26a';
    g.fillRect(0, 0, 360, 200);
    g.fillStyle = '#ffffff';
    g.fillRect(30, 30, 120, 140);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'screenshot.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
}

test('draw, close, reload: the drawing is still there, the room shows its render, and nothing leaves the machine', async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  const external = await offline(page);
  const key = unique();
  await openGame(page, 'demo', '&me=Theo', `play=none&sim=1&simusage=0&wb_key=${key}`);
  await faceBoard(page);
  expect(await page.evaluate(() => window.__h3d.lookAt())).toMatchObject({ kind: 'prop', id: 'whiteboard' });
  await expect(page.locator('.prompt')).toContainText('Empty · draw the first thing');
  await shot(page, 'm13-board-empty');
  // Nothing of the editor before it is opened.
  expect(await editorChunks(page)).toEqual([]);

  await openBoard(page);
  const chunks = await editorChunks(page);
  expect(chunks.some((n) => /\/assets\/editor-/.test(n))).toBe(true);
  // The keys are the editor's: WASD does not walk the game behind it.
  const pose = await page.evaluate(() => window.__h3d.pose());
  await page.keyboard.press('KeyR'); // the rectangle tool
  await drag(page, 0.25, 0.3, 0.45, 0.55);
  await page.keyboard.press('KeyT'); // text
  const box = await page.locator('.wb-canvas').boundingBox();
  await page.mouse.click((box?.x ?? 0) + (box?.width ?? 0) * 0.55, (box?.y ?? 0) + (box?.height ?? 0) * 0.4);
  await page.keyboard.type('Ship it 先');
  // Esc finishes the text (Excalidraw's), it does not close the board.
  await page.keyboard.press('Escape');
  expect((await info(page)).overlay.open).toBe(true);
  await pasteImage(page);
  await expect.poll(() => sceneTypes(page), { timeout: 15_000 }).toEqual(['image', 'rectangle', 'text']);
  expect(await page.evaluate(() => window.__h3d.pose())).toMatchObject({ x: pose?.x, z: pose?.z });
  await savedAt(page, 1);
  // The hand-drawn font and the CJK subset for 先 came from the game itself (the CDN fallback would be blocked above).
  const fonts = (await editorChunks(page)).filter((n) => n.includes('/assets/excalidraw-0.18.1/fonts/'));
  expect(fonts.some((n) => n.includes('/fonts/Excalifont/'))).toBe(true);
  expect(fonts.some((n) => n.includes('/fonts/Xiaolai/'))).toBe(true);
  await evidence(page, 'whiteboard-drawn');

  // Esc: the selection goes first, then the board closes (the image is still selected after the paste).
  for (let i = 0; i < 4 && (await info(page)).overlay.open; i++) await page.keyboard.press('Escape');
  await expect.poll(async () => (await info(page)).overlay.open).toBe(false);
  const st = await stored(page, key);
  expect(st.render && !st.stale && st.render_version === st.version).toBe(true);
  // The pasted picture is stored once, under the sha256 of its stored bytes.
  expect(st.files).toHaveLength(1);
  const fileId = st.files[0] as string;
  const bytes = await page.evaluate(async ({ key, floor, id }) => Array.from(new Uint8Array(await (await fetch(`/whiteboard/${floor}/files/${id}?wb_key=${key}`)).arrayBuffer())), { key, floor: FLOOR, id: fileId });
  expect(createHash('sha256').update(Buffer.from(bytes)).digest('hex')).toBe(fileId);
  expect(st.elements.find((e) => e.type === 'image')?.fileId).toBe(fileId);
  // The room's board shows that render.
  await expect.poll(async () => (await info(page)).shown, { timeout: 15_000 }).toBe(`render:${st.version}`);
  await frames(page, 4);
  await shot(page, 'm13-board-render');
  await evidence(page, 'room-board');

  // render.png: a PNG within 2400 px, not blank, the bytes the room loads.
  const png = await page.evaluate(async ({ key, floor, v }) => Array.from(new Uint8Array(await (await fetch(`/whiteboard/${floor}/render.png?wb_key=${key}&v=${v}`)).arrayBuffer())), { key, floor: FLOOR, v: st.version });
  const img = PNG.sync.read(Buffer.from(png));
  expect(createHash('sha256').update(Buffer.from(png)).digest('hex')).toBe(st.renderSha);
  expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(2400);
  const colours = new Set<number>();
  for (let i = 0; i < img.data.length; i += 4 * 97) colours.add((img.data[i] as number) * 65536 + (img.data[i + 1] as number) * 256 + (img.data[i + 2] as number));
  expect(colours.size, 'the render has the drawing in it').toBeGreaterThan(3);

  // A reload (the bridge keeps boards across restarts): the drawing and the room's board are back.
  await page.reload();
  await page.waitForFunction(() => window.__h3d?.ready && window.__h3d.frames >= 3, undefined, { timeout: 60_000 });
  await faceBoard(page);
  await expect.poll(async () => (await info(page)).shown, { timeout: 15_000 }).toBe(`render:${st.version}`);
  await expect(page.locator('.prompt')).toContainText('Last change by Theo');
  await openBoard(page);
  expect(await sceneTypes(page)).toEqual(['image', 'rectangle', 'text']);
  // Opening it saved nothing new.
  await frames(page, 10);
  expect((await stored(page, key)).saves).toBe(st.saves);
  await page.locator('.wb-close').click();
  await expect.poll(async () => (await info(page)).overlay.open).toBe(false);

  expect(external, 'requests that left the machine').toEqual([]);
  clean();
});

test('pin a drop (stored once), an agent pin lands on the open board, clear asks first and keeps the history', async ({ page }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  const external = await offline(page);
  const key = unique();
  await openGame(page, 'demo', '&me=Theo', `play=none&sim=1&simusage=0&wb_key=${key}`);
  await faceBoard(page);
  await openBoard(page);

  // The picker: the newest drops, a document greyed out.
  await page.getByRole('button', { name: 'Pin a drop' }).click();
  const picker = page.locator('.wb-picker');
  await expect(picker.locator('.wb-drop')).toHaveCount(4);
  await expect(picker.locator('.wb-drop[disabled]')).toHaveCount(1);
  await expect(picker.locator('.wb-drop[disabled]')).toContainText('Not an image');
  await expect(picker.locator('.wb-drop-img').first()).toHaveJSProperty('complete', true);
  await evidence(page, 'pin-a-drop');
  await picker.locator('.wb-drop', { hasText: 'checkout-flow.png' }).click();
  await expect.poll(() => sceneTypes(page), { timeout: 15_000 }).toEqual(['image']);
  await savedAt(page, 1);
  // The same drop again: a second image, one file.
  await page.getByRole('button', { name: 'Pin a drop' }).click();
  await picker.locator('.wb-drop', { hasText: 'checkout-flow.png' }).click();
  await expect.poll(() => sceneTypes(page), { timeout: 15_000 }).toEqual(['image', 'image']);
  await savedAt(page, 2);
  let st = await stored(page, key);
  expect(st.files).toHaveLength(1);
  expect(st.elements.filter((e) => e.type === 'image').map((e) => e.fileId)).toEqual([st.files[0], st.files[0]]);

  // A stroke in progress, and meanwhile an agent pins a note (the Go-made element): the board merges it, the stroke
  // stays, and the board is saved again with a fresh render (no longer stale).
  const box = await page.locator('.wb-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  // (Right of the pinned pictures: the shape panel takes the left edge while a tool is on.)
  await page.keyboard.press('KeyR');
  await page.mouse.move(box.x + box.width * 0.76, box.y + box.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.82, box.y + box.height * 0.65, { steps: 4 });
  const pin = await page.evaluate(async ({ key, floor }) => (await (await fetch(`/whiteboard/_pin?wb_key=${key}&floor=${floor}&author=Nibble&note=${encodeURIComponent('Use the blue CTA')}`, { method: 'POST' })).json()) as { data: { version: number; elements: string[] } }, { key, floor: FLOOR });
  await page.waitForTimeout(800);
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.75, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => sceneTypes(page), { timeout: 15_000 }).toEqual(['image', 'image', 'rectangle', 'text']);
  await expect.poll(async () => { const s = await stored(page, key); return !s.stale && s.version > pin.data.version; }, { timeout: 30_000 }).toBe(true);
  st = await stored(page, key);
  expect(st.elements.some((e) => e.id === pin.data.elements[0] && e.text === 'Use the blue CTA')).toBe(true);
  expect(st.elements.filter((e) => e.type === 'rectangle')).toHaveLength(1);
  await evidence(page, 'agent-pin-merged');

  // Clear asks first; Keep it keeps it.
  await page.getByRole('button', { name: 'Clear board' }).click();
  await expect(page.locator('.wb-confirm')).toContainText(`Clear the whiteboard for everyone on ${FLOOR}?`);
  await evidence(page, 'clear-confirm');
  await page.getByRole('button', { name: 'Keep it' }).click();
  expect((await stored(page, key)).version).toBe(st.version);
  await page.getByRole('button', { name: 'Clear board' }).click();
  await page.locator('.wb-confirm').getByRole('button', { name: 'Clear board' }).click();
  await expect.poll(() => sceneTypes(page), { timeout: 15_000 }).toEqual([]);
  const cleared = await stored(page, key);
  expect(cleared.render).toBe(false);
  expect(cleared.history.length).toBeGreaterThan(3);
  await page.locator('.wb-close').click();
  await expect.poll(async () => (await info(page)).shown, { timeout: 15_000 }).toBeNull();

  expect(external, 'requests that left the machine').toEqual([]);
  clean();
});

test('an agent pin on a closed board: the room lists it until the board is opened and rendered again', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  const key = unique();
  await openGame(page, 'demo', '&me=Theo', `play=none&sim=1&simusage=0&wb_key=${key}`);
  await faceBoard(page);
  await page.evaluate(async ({ key, floor }) => fetch(`/whiteboard/_pin?wb_key=${key}&floor=${floor}&author=Nibble&note=${encodeURIComponent('Deploy after 5')}`, { method: 'POST' }), { key, floor: FLOOR });
  await expect.poll(async () => (await info(page)).shown, { timeout: 15_000 }).toBe('pins:1');
  await expect(page.locator('.prompt')).toContainText('1 new pin');
  await frames(page, 4);
  await evidence(page, 'room-stale-pins');
  // Opening the board lays the note out and renders it: the room shows the render, nothing stale.
  await openBoard(page);
  await expect.poll(async () => { const s = await stored(page, key); return s.render && !s.stale; }, { timeout: 30_000 }).toBe(true);
  const st = await stored(page, key);
  await page.locator('.wb-close').click();
  await expect.poll(async () => (await info(page)).shown, { timeout: 15_000 }).toBe(`render:${st.version}`);
  clean();
});
