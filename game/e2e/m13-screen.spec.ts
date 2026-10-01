import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { frames, openGame, RESULTS } from './game';

// M13 (#15) screen share: the top bar's Share screen, the LIVE badge and Stop, the TV showing the share, and the
// bridge's frame requests answered with a JPEG. The browser's picker and macOS cannot run here: getDisplayMedia is
// replaced before the page loads (addInitScript) by an animated canvas's captureStream(), a real video track, so
// playback, the VideoTexture, the JPEG encode and the track's end are the real ones. The fixture simulator plays the
// bridge (`screen.share`, `screen.grab`, POST /screen/frame/<id>; tools/fixture-share.ts). Manual Mac checks of the
// real picker: docs/protocol.md "Screen share".
// `H3D_EVIDENCE_DIR` says where the screenshots go (default: test-results/m13-screen).

const EVIDENCE = process.env.H3D_EVIDENCE_DIR ?? resolve(RESULTS, 'm13-screen');
mkdirSync(EVIDENCE, { recursive: true });
const FLOOR = 'herdr-3d';
const SIM = 'play=none&sim=1&simms=150&simusage=0';

interface Mock {
  calls: unknown[];
  tracks: MediaStreamTrack[];
  fail: string | null;
  /** The rejection's message (default: a picker cancel's). */
  failMessage?: string;
}
declare global {
  interface Window {
    __screenMock: Mock;
  }
}

/** getDisplayMedia → a fresh 1280×720 canvas stream per call (a "window"), or a rejection named `fail`. */
async function installScreenMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const mock: Mock = { calls: [], tracks: [], fail: null };
    window.__screenMock = mock;
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async (opts: unknown) => {
        mock.calls.push(JSON.parse(JSON.stringify(opts, (k, v) => (k === 'controller' ? 'CaptureController' : v))));
        if (mock.fail) throw new DOMException(mock.failMessage ?? (mock.fail === 'NotAllowedError' ? 'Permission denied' : 'no'), mock.fail);
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const g = canvas.getContext('2d') as CanvasRenderingContext2D;
        let n = 0;
        const paint = () => {
          g.fillStyle = '#164b9b';
          g.fillRect(0, 0, 1280, 720);
          g.fillStyle = '#ffc233';
          g.fillRect(80 + ((n * 12) % 900), 420, 220, 160);
          g.fillStyle = '#ffffff';
          g.font = 'bold 64px sans-serif';
          g.fillText(`Shared window · frame ${n++}`, 60, 120);
        };
        paint();
        const timer = setInterval(paint, 100);
        const stream = canvas.captureStream(10);
        const track = stream.getVideoTracks()[0] as MediaStreamTrack;
        const settings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...settings(), displaySurface: 'window' }) as MediaTrackSettings;
        track.addEventListener('ended', () => clearInterval(timer));
        mock.tracks.push(track);
        return stream;
      },
    });
  });
}

async function onFloor(page: Page): Promise<void> {
  await installScreenMock(page);
  await openGame(page, 'demo-m5', '', SIM);
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await facingTv(page);
}

/** In front of the TV on the north wall, looking at it: 3.2 m away it fills the screenshots, within 3 m it is looked at. */
async function facingTv(page: Page, z = 3.2): Promise<void> {
  await page.evaluate(
    ([s, z]) => {
      const tv = window.__h3d.layout(s as string)?.props.find((p) => p.id === 'tv');
      if (tv) window.__h3d.setPose({ x: (tv.box.min[0] + tv.box.max[0]) / 2, z: z as number, yaw: 0, pitch: 0.08 });
    },
    [FLOOR, z] as const,
  );
  await frames(page, 3);
}

const screen = (page: Page) => page.evaluate(() => window.__h3d.screen());
const shares = async (page: Page) => (await page.evaluate(() => window.__h3d.screen()))?.reported ?? [];

test('Share → LIVE and the TV plays it; a frame request gets a JPEG and a toast; Stop clears it all', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await onFloor(page);
  // The game told the bridge it is a game that does not share.
  await expect.poll(() => shares(page)).toEqual([{ sharing: false }]);
  expect((await screen(page))?.tv).toMatchObject({ live: false });
  await expect(page.locator('.share-start')).toBeVisible();
  // Looking at the TV: its bar says it is off and where to start.
  await facingTv(page, 2.4);
  await expect(page.locator('.prompt')).toContainText('Screen-share TV');
  await expect(page.locator('.prompt')).toContainText('Off · Share screen in the top bar');
  await facingTv(page);
  await page.screenshot({ path: resolve(EVIDENCE, '01-share-button.png') });

  await page.locator('.share-start').click();
  await expect(page.locator('.share-live')).toBeVisible();
  await expect(page.locator('.share-start')).toBeHidden();
  await expect(page.locator('.share-what')).toHaveText('Sharing a window');
  await facingTv(page, 2.4);
  await expect(page.locator('.prompt')).toContainText('Live · sharing a window');
  await facingTv(page);
  const call = (await page.evaluate(() => window.__screenMock.calls))[0];
  expect(call).toMatchObject({ audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'include', monitorTypeSurfaces: 'include', preferCurrentTab: false });
  await expect.poll(async () => (await screen(page))?.phase).toBe('live');
  const live = await screen(page);
  expect(live).toMatchObject({ surface: 'window', w: 1280, h: 720, texture: { w: 1280, h: 720 } });
  // Letterboxed: 16:9 in the TV's screen, never stretched.
  const tv = live?.tv;
  expect(tv?.live).toBe(true);
  expect((tv?.w ?? 0) / (tv?.h ?? 1)).toBeCloseTo(16 / 9, 3);
  expect(tv?.w).toBeLessThanOrEqual((tv?.screenW ?? 0) + 1e-6);
  expect(tv?.h).toBeLessThanOrEqual((tv?.screenH ?? 0) + 1e-6);
  await expect.poll(() => shares(page)).toEqual([{ sharing: false }, { sharing: true, surface: 'window' }]);
  await frames(page, 6);
  // The TV shows the shared picture's own colours (unlit, sRGB-decoded on the WebGL2 fallback too): most of the
  // picture is the canvas's #164b9b background, seen through the TV as that blue (washed out, it would be #5394cd).
  const tvShot = PNG.sync.read(await page.screenshot({ clip: { x: 480, y: 300, width: 320, height: 180 } }));
  let blue = 0;
  for (let i = 0; i < tvShot.data.length; i += 4) {
    const d = [0x16, 0x4b, 0x9b].map((v, c) => Math.abs((tvShot.data[i + c] as number) - v));
    if (Math.max(...d) < 14) blue++;
  }
  expect(blue / (tvShot.width * tvShot.height)).toBeGreaterThan(0.4);
  await page.screenshot({ path: resolve(EVIDENCE, '02-live-tv.png') });
  // On a wide bar the badge also says what is shared (under 1500 px only the tape and Stop: the words are its title).
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(page.locator('.share-what')).toBeVisible();
  await page.locator('.topbar').screenshot({ path: resolve(EVIDENCE, '03-live-badge.png') });
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator('.share-what')).toBeHidden();
  await expect(page.locator('.share-live')).toHaveAttribute('title', /^Sharing a window\./);
  await facingTv(page);

  // An agent asks: the bridge sends a frame request, the game answers with a JPEG over HTTP.
  const t0 = Date.now();
  const grab = await page.evaluate(() => window.__h3d.screenGrab({ floor: 'herdr-3d', requester: 'Nibble' }));
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(grab).toMatchObject({ ok: true, data: { w: 1280, h: 720, surface: 'window' } });
  expect((grab.data as { bytes: number }).bytes).toBeGreaterThan(1000);
  await expect(page.locator('.toast')).toHaveText('Nibble looked at your screen');
  await page.screenshot({ path: resolve(EVIDENCE, '04-grab-toast.png') });
  const log = (await page.evaluate(async () => (await fetch('/screen/_log')).json())).data as Array<{ id: string; result: string; w: number }>;
  const answered = (await screen(page))?.answered ?? [];
  expect(answered).toHaveLength(1);
  expect(answered[0]).toMatchObject({ ok: true, w: 1280, h: 720 });
  expect(log.find((e) => e.id === answered[0]?.reqId)).toMatchObject({ result: 'ok', w: 1280 });

  // Stop: the badge goes, the TV shows its sign again, every track is released, the bridge is told.
  await page.locator('.share-stop').click();
  await expect(page.locator('.share-start')).toBeVisible();
  await expect(page.locator('.share-live')).toBeHidden();
  const off = await screen(page);
  expect(off).toMatchObject({ phase: 'off', texture: null, tv: { live: false } });
  expect(await page.evaluate(() => window.__screenMock.tracks.map((t) => t.readyState))).toEqual(['ended']);
  await expect.poll(async () => (await shares(page)).at(-1)).toEqual({ sharing: false });
  // Not sharing: a grab is refused, and no frame is sent.
  const refused = await page.evaluate(() => window.__h3d.screenGrab({ floor: 'herdr-3d', requester: 'Nibble' }));
  expect(refused).toMatchObject({ ok: false, code: 'not_sharing' });
  expect((await screen(page))?.answered).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("Chrome's own Stop sharing (the track ends) clears the share; sharing again works", async ({ page }) => {
  await onFloor(page);
  await page.locator('.share-start').click();
  await expect.poll(async () => (await screen(page))?.phase).toBe('live');
  await page.evaluate(() => {
    const t = window.__screenMock.tracks[0] as MediaStreamTrack;
    t.stop();
    t.dispatchEvent(new Event('ended')); // what Chrome's bar does; stop() alone fires nothing
  });
  await expect(page.locator('.share-start')).toBeVisible();
  await expect(page.locator('.toast')).toHaveText('Screen sharing stopped');
  expect(await screen(page)).toMatchObject({ phase: 'off', texture: null, tv: { live: false } });
  await expect.poll(async () => (await shares(page)).at(-1)).toEqual({ sharing: false });
  // A second share is a fresh capture, and its frames are its own.
  await page.locator('.share-start').click();
  await expect.poll(async () => (await screen(page))?.phase).toBe('live');
  expect(await page.evaluate(() => window.__screenMock.tracks.length)).toBe(2);
  const grab = await page.evaluate(() => window.__h3d.screenGrab({ floor: 'herdr-3d', requester: 'Pickle' }));
  expect(grab).toMatchObject({ ok: true, data: { w: 1280, h: 720 } });
});

test('a cancelled picker changes nothing and says nothing; a refusal by the browser says what to do', async ({ page }) => {
  await onFloor(page);
  await page.evaluate(() => (window.__screenMock.fail = 'NotAllowedError'));
  await page.locator('.share-start').click();
  await expect.poll(() => page.evaluate(() => window.__screenMock.calls.length)).toBe(1);
  await frames(page, 3);
  expect((await screen(page))?.phase).toBe('off');
  await expect(page.locator('.share-start')).toBeVisible();
  await expect(page.locator('.toast')).toHaveAttribute('hidden', ''); // no toast was shown
  await page.evaluate(() => (window.__screenMock.fail = 'NotReadableError'));
  await page.locator('.share-start').click();
  await expect(page.locator('.toast')).toContainText('could not be captured');
  expect((await screen(page))?.phase).toBe('off');
});

test('the macOS denial is read in full: the toast stays clear of the plan limits panel', async ({ page }) => {
  await installScreenMock(page);
  await openGame(page, 'demo-m5', '', 'play=none&sim=1&simms=150&simusage=0&simlimits=ok');
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await expect(page.locator('.limits')).toBeVisible();
  await page.evaluate(() => Object.assign(window.__screenMock, { fail: 'NotAllowedError', failMessage: 'Permission denied by system' }));
  for (const width of [1920, 1280]) {
    await page.setViewportSize({ width, height: width === 1920 ? 1080 : 720 });
    await page.locator('.share-start').click();
    const toast = page.locator('.toast');
    await expect(toast).toContainText('record the screen');
    await expect(toast).toHaveCSS('opacity', '1');
    const [t, l] = [await toast.boundingBox(), await page.locator('.limits').boundingBox()];
    if (!t || !l) throw new Error('no toast or limits panel');
    const overlaps = t.x < l.x + l.width && l.x < t.x + t.width && t.y < l.y + l.height && l.y < t.y + t.height;
    expect(overlaps, `toast ${JSON.stringify(t)} limits ${JSON.stringify(l)} at ${width}`).toBe(false);
    await page.screenshot({ path: resolve(EVIDENCE, `07-denied-${width}.png`) });
  }
});
