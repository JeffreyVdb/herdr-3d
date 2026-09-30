import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { frames, openGame, shot, watchErrors } from './game';

// M15, the office radio, on the demo-m3b fixture (three floors in one building, herdr-3d on top). The tracks are
// not the real ones: every request for /music/<genre>/<id>.ogg is answered with a tiny generated clip of that genre
// (e2e/fixtures/music, `node tools/music.ts testclips`), so the spec runs without fetched audio and, with the
// route in place, with none of the real files' bandwidth.

const CLIPS = resolve(import.meta.dirname, 'fixtures/music');
const NAMES = ['Melodic house', 'Soft jazz', 'Rock', 'Pop', 'Rap'];

async function serveClips(page: Page, opts: { missing?: (genre: string, id: string) => boolean } = {}): Promise<{ requests: string[] }> {
  const requests: string[] = [];
  await page.route(/\/music\/[a-z]+\/[^/]+\.ogg$/, (route) => {
    const m = /\/music\/([a-z]+)\/([^/]+)\.ogg$/.exec(new URL(route.request().url()).pathname);
    const genre = m?.[1] ?? 'house';
    requests.push(`${genre}/${m?.[2]}`);
    if (opts.missing?.(genre, m?.[2] ?? '')) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: 'audio/ogg', body: readFileSync(resolve(CLIPS, `${genre}.ogg`)) });
  });
  return { requests };
}

type Radio = NonNullable<ReturnType<Window['__h3d']['radio']>>;
const radio = (page: Page) => page.evaluate(() => window.__h3d.radio()) as Promise<Radio>;
const lookAt = (page: Page) => page.evaluate(() => window.__h3d.lookAt());

/** In the lounge aisle, at the coffee counter, looking west and down at the radio. */
async function faceRadio(page: Page): Promise<void> {
  await page.evaluate(() => {
    const L = window.__h3d.layout('herdr-3d');
    const b = L?.props.find((p) => p.id === 'radio')?.box;
    if (!b) throw new Error('no radio prop');
    const z = (b.min[2] + b.max[2]) / 2;
    window.__h3d.setPose({ x: 1.3, z, yaw: Math.PI / 2, pitch: -0.5 });
  });
  await frames(page, 3);
}

test('the radio: look at it, E through the genres, R skips, the track toast, and it fades in the lobby', async ({ page }) => {
  test.setTimeout(180_000);
  const clean = watchErrors(page);
  await serveClips(page);
  await openGame(page, 'demo-m3b');
  expect(await page.evaluate(() => window.__h3d.radio())).toMatchObject({ genre: 'house', playing: false, volume: 0.4 });
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  await faceRadio(page);
  expect(await lookAt(page)).toMatchObject({ kind: 'prop', id: 'radio' });

  // The hint on the look-at bar.
  const bar = page.locator('.prompt');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute('aria-label', 'Radio: Melodic house · E next genre · R next track');
  await expect(bar).toContainText('Melodic house');
  await shot(page, 'm15-radio-hint');

  // The first key is the gesture that unlocks sound: the saved genre (Melodic house) starts on the floor.
  await page.keyboard.press('Shift');
  await expect.poll(async () => (await radio(page)).playing, { timeout: 15_000, message: 'the radio starts on the floor after the first gesture' }).toBe(true);
  const first = await radio(page);
  expect(first).toMatchObject({ genre: 'house', muted: false });
  expect(first.trackId).toBeTruthy();
  // The now-playing toast: title and artist, about 3 s.
  const toast = page.locator('.toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('♪');
  await shot(page, 'm15-radio-toast');
  await expect(toast).toHaveAttribute('hidden', '', { timeout: 6_000 });

  // E: Melodic house → Soft jazz → Rock → Pop → Rap → Off → Melodic house.
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('KeyE');
    await expect.poll(async () => (await radio(page)).genre, { timeout: 5_000 }).not.toBe(seen.at(-1) ?? 'house');
    seen.push((await radio(page)).genre);
    if (seen.at(-1) !== 'off') {
      await expect.poll(async () => (await radio(page)).playing, { timeout: 15_000, message: `${seen.at(-1)} plays` }).toBe(true);
      const r = await radio(page);
      expect(r.trackId, 'the track is one of the genre’s').toBeTruthy();
    }
  }
  expect(seen).toEqual(['jazz', 'rock', 'pop', 'rap', 'off', 'house']);
  // Off is a stop: the bar says so, and R has nothing to skip.
  for (let i = 0; i < 5; i++) await page.keyboard.press('KeyE');
  await expect.poll(async () => (await radio(page)).genre).toBe('off');
  expect(await radio(page)).toMatchObject({ playing: false, trackId: null });
  await expect(bar).toHaveAttribute('aria-label', 'Radio: Off · E next genre · R next track');
  await page.keyboard.press('KeyE');
  await expect.poll(async () => (await radio(page)).genre).toBe('house');
  await expect.poll(async () => (await radio(page)).playing, { timeout: 15_000 }).toBe(true);

  // R: the next track of the genre.
  const before = (await radio(page)).trackId;
  await page.keyboard.press('KeyR');
  await expect.poll(async () => (await radio(page)).trackId, { timeout: 5_000 }).not.toBe(before);
  await expect.poll(async () => (await radio(page)).playing, { timeout: 15_000 }).toBe(true);

  // The event log has the story.
  const ev = await page.evaluate(() => window.__h3d.radioEvents());
  expect(ev.filter((e) => e.kind === 'genre').map((e) => e.genre)).toEqual(['jazz', 'rock', 'pop', 'rap', 'off', 'house', 'jazz', 'rock', 'pop', 'rap', 'off', 'house']);
  expect(ev.some((e) => e.kind === 'start')).toBe(true);

  // Down to the lobby: it fades out and stops; back on the floor it comes back.
  await page.evaluate(() => window.__h3d.enterLobby());
  await frames(page, 3);
  await expect.poll(async () => (await radio(page)).playing, { timeout: 5_000, message: 'faded out in the lobby' }).toBe(false);
  expect((await radio(page)).genre).toBe('house');
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  await expect.poll(async () => (await radio(page)).playing, { timeout: 15_000, message: 'back on the floor' }).toBe(true);
  const fades = (await page.evaluate(() => window.__h3d.radioEvents())).filter((e) => e.kind === 'fade').map((e) => e.detail);
  expect(fades.slice(-2)).toEqual(['out', 'in']);

  // The city has no radio either.
  await page.evaluate(() => window.__h3d.leaveFloor());
  await expect.poll(async () => (await radio(page)).playing, { timeout: 5_000 }).toBe(false);
  clean();
});

test('the radio prop stands on the counter: screenshot, the genre on its display, and the saved genre', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await serveClips(page);
  // A player who left the radio on Rock, the music at 0.25.
  await page.addInitScript(() => localStorage.setItem('h3d.audio', JSON.stringify({ muted: false, volume: 0.8, music: { volume: 0.25, muted: false, genre: 'rock' } })));
  await openGame(page, 'demo-m3b');
  expect(await radio(page)).toMatchObject({ genre: 'rock', volume: 0.25 });
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  // Close, from the aisle, the counter and the radio in the frame.
  await page.evaluate(() => {
    const b = window.__h3d.layout('herdr-3d')?.props.find((p) => p.id === 'radio')?.box;
    if (!b) throw new Error('no radio prop');
    window.__h3d.setPose({ x: 1.45, z: (b.min[2] + b.max[2]) / 2 + 0.1, yaw: Math.PI / 2 + 0.12, pitch: -0.42 });
  });
  await page.keyboard.press('Shift');
  await expect.poll(async () => (await radio(page)).playing, { timeout: 15_000 }).toBe(true);
  await frames(page, 4);
  await shot(page, 'm15-radio');
  clean();
});

test('a missing track file is skipped and the radio plays the next one', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  // The first two tracks it asks for are not there.
  let asked = 0;
  const served = await serveClips(page, { missing: () => ++asked <= 2 });
  await openGame(page, 'demo-m3b');
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  await page.keyboard.press('Shift');
  await expect.poll(async () => (await radio(page)).playing, { timeout: 20_000 }).toBe(true);
  const ev = await page.evaluate(() => window.__h3d.radioEvents());
  expect(ev.filter((e) => e.kind === 'skip')).toHaveLength(2);
  expect(served.requests.length).toBeGreaterThanOrEqual(3);
  // Not an error on the page: watchErrors ignores the 404s of a media request, and nothing threw.
  const errors = await page.evaluate(() => window.__h3d.error);
  expect(errors).toBeNull();
  void clean;
});

test('the sound control has a music popover with a slider and mute of its own, and the Music credits panel lists every track', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await serveClips(page);
  await openGame(page, 'demo-m3b');
  const group = page.getByRole('group', { name: 'Sound' });
  await expect(group).toBeVisible();
  const master = group.getByRole('slider', { name: 'Sound volume' });
  await expect(master).toHaveValue('80');
  // The music's controls are in the popover under the Music button.
  const trigger = group.getByRole('button', { name: 'Music' });
  const pop = page.locator('.audio-pop');
  await expect(pop).toBeHidden();
  await trigger.click();
  await expect(pop).toBeVisible();
  const music = pop.getByRole('slider', { name: 'Music volume' });
  await expect(music).toHaveValue('40');
  await music.fill('65');
  expect(await radio(page)).toMatchObject({ volume: 0.65, muted: false });
  await expect(master).toHaveValue('80');
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('h3d.audio'))) ?? '{}').music).toMatchObject({ volume: 0.65, genre: 'house' });
  // The music mute is its own too.
  const muteMusic = pop.getByRole('button', { name: 'Mute music' });
  await muteMusic.click();
  expect(await radio(page)).toMatchObject({ muted: true });
  await expect(muteMusic).toHaveAttribute('aria-pressed', 'true');
  await expect(group.getByRole('button', { name: 'Music, muted' })).toBeVisible();
  await expect(group.getByRole('button', { name: 'Mute all sound' })).toHaveAttribute('aria-pressed', 'false');
  await muteMusic.click();
  expect(await radio(page)).toMatchObject({ muted: false });
  // Esc closes the popover and gives focus back to its button.
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(pop).toBeVisible();
  await shot(page, 'm15-audio-controls');
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();

  // The credits panel: opened from the popover, one row per manifest track, license and source linked.
  const total = await page.evaluate(async () => (await (await fetch('/MUSIC_CREDITS.txt')).text()).split('\n').filter((l) => l.startsWith('"')).length);
  await trigger.click();
  await pop.getByRole('button', { name: 'Music credits' }).click();
  await expect(pop).toBeHidden();
  const dialog = page.getByRole('dialog', { name: 'Music credits' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.credits-row:not(.credits-font)')).toHaveCount(total);
  expect(total).toBeGreaterThanOrEqual(25);
  // The genres, then (#59) the fonts: Recursive, each transcript preset's two (all OFL), and the box-drawing subset.
  await expect(dialog.getByRole('heading', { level: 3 })).toHaveCount(6);
  await expect(dialog.locator('.credits-font .credits-title')).toHaveText(['Recursive', 'Departure Mono', 'Archivo', 'JetBrains Mono', 'Atkinson Hyperlegible Next', 'Space Mono', 'Newsreader', 'H3D Box (DejaVu Sans Mono)']);
  for (const link of await dialog.locator('.credits-font').getByRole('link', { name: /license, SIL Open Font License 1\.1/ }).all()) await expect(link).toHaveAttribute('href', /openfontlicense\.org/);
  for (const n of NAMES) await expect(dialog.locator('.credits-genre-name', { hasText: n })).toHaveCount(1);
  const first = dialog.locator('.credits-row').first();
  await expect(first.getByRole('link', { name: /license, CC/ })).toHaveAttribute('href', /creativecommons\.org/);
  await expect(first.getByRole('link', { name: /source page/ })).toHaveAttribute('href', /^https:\/\//);
  await shot(page, 'm15-credits');
  // Game keys are not for the panel: E behind it does not tune the radio; Esc closes it and gives focus back.
  const g = (await radio(page)).genre;
  await page.keyboard.press('KeyE');
  expect((await radio(page)).genre).toBe(g);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  clean();
});

// Opt-in (H3D_BENCH=1): frame time on the busy 60-worker floor in the lounge with the radio playing against off.
// WebGL2 on llvmpipe here: only the relative numbers mean something (the Mac jobs are in tools/mac-perf.ts). The
// radio costs the render loop nothing of its own (streams decode off the main thread; a listener update only when the
// camera moves), so the two should agree within the noise.
test('bench: the radio playing on perf-floor60 against off', async ({ page }) => {
  test.skip(!process.env.H3D_BENCH, 'set H3D_BENCH=1 to run');
  test.setTimeout(600_000);
  await serveClips(page);
  // The genre for a run comes from sessionStorage, so it survives the reload between runs.
  await page.addInitScript(() => {
    const g = sessionStorage.getItem('bench-genre');
    if (g) localStorage.setItem('h3d.audio', JSON.stringify({ muted: false, volume: 0.8, music: { volume: 0.4, muted: false, genre: g } }));
  });
  const out: Record<string, unknown> = {};
  for (const [name, genre] of [
    ['radio-house', 'house'],
    ['radio-off', 'off'],
    ['radio-house-again', 'house'],
    ['radio-off-again', 'off'],
  ] as const) {
    await openGame(page, 'perf-floor60', '&ts', 'play=none&sim=1');
    await page.evaluate((g) => sessionStorage.setItem('bench-genre', g), genre);
    await page.reload();
    await page.waitForFunction(() => window.__h3d?.ready && window.__h3d.frames >= 3, undefined, { timeout: 60_000 });
    await page.evaluate(() => window.__h3d.enterFloor('perf-floor'));
    await frames(page, 3);
    await page.evaluate(() => {
      const L = window.__h3d.layout('perf-floor');
      const b = L?.props.find((p) => p.id === 'radio')?.box;
      if (!b) throw new Error('no radio prop');
      window.__h3d.setPose({ x: 1.3, z: (b.min[2] + b.max[2]) / 2, yaw: Math.PI / 2, pitch: -0.3 });
    });
    await page.keyboard.press('Shift');
    if (genre !== 'off') await expect.poll(async () => (await radio(page)).playing, { timeout: 20_000 }).toBe(true);
    else expect(await radio(page)).toMatchObject({ genre: 'off', playing: false });
    await page.waitForTimeout(1000);
    const r = await page.evaluate(() => window.__h3d.bench({ frames: 240, warm: 40, sway: false }));
    out[name] = { frameMs: r.frameMs, pipelinedMs: r.pipelinedMs, drawCalls: r.drawCalls, playing: (await radio(page)).playing };
    console.log(`m15-bench ${name}: ${JSON.stringify(out[name])}`);
  }
});
