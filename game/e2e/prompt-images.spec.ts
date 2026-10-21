import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expectCommandDone, frames, openGame, RESULTS, seatMode, watchErrors } from './game';

// #64: a pasted screenshot in every field that prompts an agent, next to hire-composer.spec.ts (the hire dialog's First
// task, the same shared composer). Built game, fixture server with sim=1 and the fixture POST /upload. Paste is a real
// ClipboardEvent carrying files, typing and keys are real keyboard input.
//   - the desk prompt overlay (P), one draft per worker;
//   - Start Run: Extra instructions and First prompt (the Ticket stays text);
//   - the transcript view's prompt box;
//   - a paste at a laptop's terminal.
// `H3D_EVIDENCE_DIR` says where the screenshots go (default: test-results/prompt-images).

const EVIDENCE = process.env.H3D_EVIDENCE_DIR ?? resolve(RESULTS, 'prompt-images');
mkdirSync(EVIDENCE, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(EVIDENCE, `${name}.png`) });

const FLOOR = 'herdr-3d';
const SIM = 'play=none&sim=1&simms=150&simusage=0';
const unique = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const DROP = '/home/fixture/drops/2026-09';

const sent = (page: Page) => page.evaluate(() => window.__h3d.sent());
const sentOf = async (page: Page, t: string) => (await sent(page)).filter((c) => c.t === t);
const dialog = (page: Page) => page.evaluate(() => window.__h3d.dialog());
const panel = (page: Page) => page.evaluate(() => window.__h3d.panel());

type Panel = NonNullable<ReturnType<Window['__h3d']['panel']>>;
type Prompt = Extract<Panel, { kind: 'prompt' }>;
type Dialog = NonNullable<ReturnType<Window['__h3d']['dialog']>>;
type Run = Extract<Dialog, { kind: 'start-run' }>;

interface Img {
  name: string;
  color?: string;
  /** Not a picture: a file of this type (a PDF), or, with `bytes`, a file of that size. */
  mime?: string;
  bytes?: number;
}

/** A real paste: a ClipboardEvent whose DataTransfer holds PNG files (drawn here, so thumbnails have pixels). */
async function paste(page: Page, target: string, files: Img[]): Promise<void> {
  await page.evaluate(
    async ({ files, target }) => {
      const dt = new DataTransfer();
      for (const f of files) {
        if (f.mime || f.bytes) {
          dt.items.add(new File([new Uint8Array(f.bytes ?? 16).fill(7)], f.name, { type: f.mime ?? 'image/png' }));
          continue;
        }
        const c = document.createElement('canvas');
        c.width = 480;
        c.height = 270;
        const g = c.getContext('2d') as CanvasRenderingContext2D;
        g.fillStyle = f.color ?? '#2f6bf0';
        g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = '#ffffff';
        g.fillRect(c.width * 0.1, c.height * 0.1, c.width * 0.3, c.height * 0.8);
        g.font = 'bold 34px sans-serif';
        g.fillText(f.name, c.width * 0.45, c.height / 2);
        const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/png'));
        dt.items.add(new File([blob], f.name, { type: 'image/png' }));
      }
      (document.querySelector(target) as HTMLElement).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { files, target },
  );
}

async function pasteText(page: Page, target: string, text: string): Promise<void> {
  await page.evaluate(
    ({ text, target }) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      (document.querySelector(target) as HTMLElement).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { text, target },
  );
}

/** The editor's text without the chips (a contenteditable has no value). */
const shown = (box: Locator) => box.evaluate((e) => (e as HTMLElement).innerText.replace(/​/g, '').replace(/\n$/, ''));
const idOf = (page: Page, name: string) => page.evaluate((n) => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === n)?.id ?? '', name);

/** An upload error the fixture makes on purpose is a real 4xx/5xx the browser logs by itself: only script errors count. */
function scriptErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return () => expect(errors).toEqual([]);
}

async function onFloor(page: Page, extra = '', fixture = 'demo-m5', open = ''): Promise<{ key: string }> {
  const key = unique();
  await openGame(page, fixture, open, `${SIM}&upload_key=${key}${extra}`);
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  return { key };
}

// ---- the desk prompt overlay (P) -----------------------------------------------------------------------------------

const promptDlg = (page: Page) => page.locator('dialog.desk-dlg--prompt');
const pEditor = (page: Page) => page.locator('#prompt-text');
const pChips = (page: Page) => promptDlg(page).locator('.cmp-chip');
const pState = async (page: Page) => (await panel(page)) as Prompt;

async function openPrompt(page: Page, name: string): Promise<string> {
  const id = await idOf(page, name);
  expect(id, `worker ${name}`).not.toBe('');
  await page.evaluate((w) => window.__h3d.openPrompt(w), id);
  await expect(promptDlg(page)).toBeVisible();
  await expect(pEditor(page)).toBeFocused();
  return id;
}

test('P: a pasted screenshot is a chip; Enter sends the text with its [Image #n: path] marker; Shift+Enter is a new line', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await onFloor(page);
  const id = await openPrompt(page, 'Pebble');
  await expect(promptDlg(page).locator('#prompt-keys')).toContainText('paste a screenshot to add it');
  await page.keyboard.type('Compare the header with this');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('and fix it: ');
  await paste(page, '#prompt-text', [{ name: 'header.png' }]);
  await expect(pChips(page)).toHaveCount(1);
  await expect(pChips(page).first().locator('.cmp-state')).toHaveText('Uploaded');
  await expect(pChips(page).first().locator('img')).toBeVisible();
  const before = await pState(page);
  expect(before.text).toBe(`Compare the header with this\nand fix it: [Image #1: ${DROP}/h3d-prompt-pebble-1.png]`);
  expect(before.images).toEqual([{ n: 1, name: 'header.png', status: 'ready', path: `${DROP}/h3d-prompt-pebble-1.png` }]);
  await shot(page, '01-prompt-overlay-chip');
  expect(await sentOf(page, 'worker.prompt')).toHaveLength(0);

  await page.keyboard.press('Enter');
  await expect.poll(async () => (await sentOf(page, 'worker.prompt')).map((c) => c.args)).toEqual([
    { id, text: `Compare the header with this\nand fix it: [Image #1: ${DROP}/h3d-prompt-pebble-1.png]` },
  ]);
  await expect.poll(async () => (await pState(page)).state).toBe('sent');
  // Sent: the note is empty again, chips gone, the overlay stays open for the next one.
  await expect(pChips(page)).toHaveCount(0);
  expect(await shown(pEditor(page))).toBe('');
  await expect(pEditor(page)).toBeFocused();
  await expect(promptDlg(page)).toBeVisible();
  clean();
});

test('P: an image alone is a prompt; typing and plain-text paste are as before', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page);
  const id = await openPrompt(page, 'Pebble');
  await pasteText(page, '#prompt-text', 'Run the tests.');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await sentOf(page, 'worker.prompt')).map((c) => c.args)).toEqual([{ id, text: 'Run the tests.' }]);
  await expect.poll(async () => (await pState(page)).state).toBe('sent');
  await paste(page, '#prompt-text', [{ name: 'only.png' }]);
  await expect(pChips(page).locator('.cmp-state')).toHaveText('Uploaded');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await sentOf(page, 'worker.prompt')).length).toBe(2);
  expect((await sentOf(page, 'worker.prompt'))[1]!.args).toEqual({ id, text: `[Image #1: ${DROP}/h3d-prompt-pebble-1.png]` });
  clean();
});

test('P: each worker keeps its own unsent draft, images too, across close and reopen', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page);
  await openPrompt(page, 'Pebble');
  await page.keyboard.type('for Pebble ');
  await paste(page, '#prompt-text', [{ name: 'kept.png' }]);
  await expect(pChips(page).locator('.cmp-state')).toHaveText('Uploaded');
  await page.keyboard.type(' end');
  const text = (await pState(page)).text;
  await page.keyboard.press('Escape');
  await expect(promptDlg(page)).toBeHidden();
  // Another worker: an empty note.
  await openPrompt(page, 'Zippy');
  await expect(pChips(page)).toHaveCount(0);
  expect(await shown(pEditor(page))).toBe('');
  await page.keyboard.type('for Zippy');
  await page.keyboard.press('Escape');
  await expect(promptDlg(page)).toBeHidden();
  // Back to the first: text and the (already uploaded) chip, no second upload.
  await openPrompt(page, 'Pebble');
  await expect(pChips(page)).toHaveCount(1);
  await expect(pChips(page).locator('.cmp-state')).toHaveText('Uploaded');
  expect((await pState(page)).text).toBe(text);
  expect((await sentOf(page, 'worker.prompt'))).toHaveLength(0);
  await page.keyboard.press('Escape');
  await openPrompt(page, 'Zippy');
  expect((await pState(page)).text).toBe('for Zippy');
  clean();
});

test('P: an image that did not upload (Drop Zone down, upload_busy) blocks the send and keeps the note; Retry then send goes', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = scriptErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  const { key } = await onFloor(page, '&fail_upload=1&fail_code=upload_busy');
  const id = await openPrompt(page, 'Pebble');
  await page.keyboard.type('see ');
  await paste(page, '#prompt-text', [{ name: 'bad.png', color: '#e8413a' }]);
  const chip = pChips(page).first();
  await expect(chip.locator('.cmp-state')).toContainText('Failed');
  await expect(chip.locator('.cmp-state')).toHaveAttribute('title', /too many uploads at once/);
  await expect(promptDlg(page).locator('.cmp-notice')).toContainText('Image 1 (bad.png) failed to upload');
  await page.keyboard.press('Enter');
  await expect(promptDlg(page).locator('.dd-status--error')).toContainText('did not upload');
  expect(await sentOf(page, 'worker.prompt')).toHaveLength(0);
  await expect(pEditor(page)).toHaveAttribute('contenteditable', 'true');
  await shot(page, '02-prompt-overlay-upload-failed');
  await chip.locator('.cmp-retry').click();
  await expect(chip.locator('.cmp-state')).toHaveText('Uploaded');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await sentOf(page, 'worker.prompt')).map((c) => c.args)).toEqual([{ id, text: `see [Image #1: ${DROP}/h3d-prompt-pebble-1.png]` }]);
  const log = (await page.evaluate(async (k) => (await fetch(`/upload/_log?upload_key=${k}`)).json(), key)).data as Array<{ result: string }>;
  expect(log.map((e) => e.result)).toEqual(['upload_busy', 'ok']);
  clean();
});

test('P: an image over 25 MB or not an image is refused with a message and never goes up; a pending upload holds the send', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const { key } = await onFloor(page, '&upload_delay=1500');
  const id = await openPrompt(page, 'Pebble');
  await paste(page, '#prompt-text', [{ name: 'huge.png', bytes: (25 << 20) + 1 }]);
  await expect(promptDlg(page).locator('.cmp-refusal')).toContainText('huge.png is 25.0 MB');
  await expect(pChips(page)).toHaveCount(0);
  await paste(page, '#prompt-text', [{ name: 'doc.pdf', mime: 'application/pdf' }]);
  await expect(promptDlg(page).locator('.cmp-refusal')).toContainText('doc.pdf is not a PNG, JPEG, GIF or WebP image');
  await expect(pChips(page)).toHaveCount(0);
  await promptDlg(page).locator('.cmp-dismiss').click(); // the refusals hold the send (below) until they are dismissed
  await expect(promptDlg(page).locator('.cmp-refusal')).toBeHidden();
  // A pending upload: Enter waits (read-only, the status says so), nothing is sent until it is up.
  await page.keyboard.type('look ');
  await paste(page, '#prompt-text', [{ name: 'slow.png' }]);
  await expect(pChips(page).locator('.cmp-state')).toHaveText('Uploading…');
  await page.keyboard.press('Enter');
  await expect(promptDlg(page).locator('.dd-status[role="status"]')).toContainText('Uploading the images');
  await expect(pEditor(page)).toHaveAttribute('contenteditable', 'false');
  expect(await sentOf(page, 'worker.prompt')).toHaveLength(0);
  await expect.poll(async () => (await sentOf(page, 'worker.prompt')).map((c) => c.args), { timeout: 10_000 }).toEqual([{ id, text: `look [Image #1: ${DROP}/h3d-prompt-pebble-1.png]` }]);
  const log = (await page.evaluate(async (k) => (await fetch(`/upload/_log?upload_key=${k}`)).json(), key)).data as unknown[];
  expect(log).toHaveLength(1); // the two refused files never reached the bridge
  clean();
});

test('P: a file the note refused holds the send (text kept, refusal stays up) until the refusal is dismissed from the keyboard; then it goes', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page);
  const id = await openPrompt(page, 'Pebble');
  await page.keyboard.type('look at this');
  await paste(page, '#prompt-text', [{ name: 'huge.png', bytes: (25 << 20) + 1 }]);
  const refusal = promptDlg(page).locator('.cmp-refusal');
  await expect(refusal).toContainText('huge.png is 25.0 MB');
  await expect(pChips(page)).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(promptDlg(page).locator('.dd-status--error')).toContainText('Nothing was sent: huge.png is 25.0 MB');
  await page.getByRole('button', { name: 'Send to Pebble' }).click();
  await frames(page, 3);
  expect(await sentOf(page, 'worker.prompt')).toHaveLength(0);
  await expect(refusal).toBeVisible();
  expect(await shown(pEditor(page))).toBe('look at this');
  expect((await pState(page)).state).toBe('ready');
  await shot(page, '11-prompt-overlay-refused-holds-send');
  // Plain text and plain-text paste go on working; they do not resolve the refusal.
  await pasteText(page, '#prompt-text', ', please');
  await expect(refusal).toBeVisible();
  // The explicit resolution, by keyboard: Tab reaches the dismiss button, Enter presses it, the note has focus again.
  await page.keyboard.press('Tab');
  await expect(promptDlg(page).locator('.cmp-dismiss')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(refusal).toBeHidden();
  await expect(pEditor(page)).toBeFocused();
  expect(await sentOf(page, 'worker.prompt')).toHaveLength(0);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await sentOf(page, 'worker.prompt')).map((c) => c.args)).toEqual([{ id, text: 'look at this, please' }]);
  clean();
});

// ---- Start Run ------------------------------------------------------------------------------------------------------

const runDlg = (page: Page) => page.locator('dialog.desk-dlg--run');
const extraBox = (page: Page) => page.locator('#run-extra');
const promptBox = (page: Page) => page.locator('#run-prompt');
const extraChips = (page: Page) => runDlg(page).locator('.dd-extra .cmp-chip');
const slipChips = (page: Page) => runDlg(page).locator('.dd-slip .cmp-chip');
const runState = async (page: Page) => (await dialog(page)) as Run;

async function openRun(page: Page): Promise<Run> {
  await page.evaluate(() => window.__h3d.openStartRun({ floor: 'herdr-3d', desk: 5 }));
  await expect.poll(async () => { const d = await dialog(page); return d?.kind === 'start-run' && d.state; }, { timeout: 10_000 }).toBe('ready');
  await page.locator('#run-ticket').fill('7');
  return settled(page);
}
async function settled(page: Page): Promise<Run> {
  await expect.poll(async () => { const d = await dialog(page); return d?.kind === 'start-run' && d.state === 'ready' && !d.preparing; }, { timeout: 10_000 }).toBe(true);
  return runState(page);
}
const runStarts = (page: Page) => sentOf(page, 'run.start');

test('Start Run: a screenshot pasted in Extra instructions is a chip; the generated First prompt carries the marker and shows the chip; Start sends it in `extra`', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await onFloor(page, '', 'demo-m4');
  await openRun(page);
  await expect(runDlg(page).locator('#run-extra-hint')).toContainText('paste a screenshot to add it');
  await extraBox(page).click();
  await page.keyboard.type('Match this mock-up: ');
  await paste(page, '#run-extra', [{ name: 'mock.png' }]);
  await expect(extraChips(page)).toHaveCount(1);
  await expect(extraChips(page).locator('.cmp-state')).toHaveText('Uploaded');
  const marker = `[Image #1: ${DROP}/h3d-run-extra-1.png]`;
  // The generated prompt follows: the marker in its text, a chip where the orchestrator will read one.
  await expect.poll(async () => (await runState(page)).preview.text, { timeout: 10_000 }).toContain(marker);
  const d = await settled(page);
  expect(d.form.extra).toBe(`Match this mock-up: ${marker}`);
  expect(d.preview).toMatchObject({ custom: false });
  await expect(slipChips(page)).toHaveCount(1);
  await expect(slipChips(page).locator('.cmp-state')).toHaveText('Uploaded');
  await expect(slipChips(page).locator('img')).toBeVisible();
  expect(await shown(promptBox(page))).not.toContain('Image #1: /home'); // the chip stands for the path
  await shot(page, '03-start-run-extra-chip');
  expect(d.blocker).toBeNull();

  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(async () => (await runStarts(page)).length).toBe(1);
  const args = (await runStarts(page))[0]!.args as { extra?: string; prompt?: string; text?: string; issue?: unknown };
  expect(args.extra).toBe(`Match this mock-up: ${marker}`);
  expect(args.prompt).toBeUndefined(); // not edited: the bridge composes it from the extra
  await expectCommandDone(page, 'run.start');
  clean();
});

test('Start Run: pasting straight into the First prompt works, and the edited prompt goes as `prompt` with its marker', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page, '', 'demo-m4');
  await openRun(page);
  await promptBox(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n\nAlso look at ');
  await paste(page, '#run-prompt', [{ name: 'direct.png', color: '#12a26a' }]);
  await expect(slipChips(page)).toHaveCount(1);
  await expect(slipChips(page).locator('.cmp-state')).toHaveText('Uploaded');
  const marker = `[Image #1: ${DROP}/h3d-run-prompt-1.png]`;
  await expect.poll(async () => (await runState(page)).preview.text).toMatch(/Also look at \[Image #1: [^\]]+h3d-run-prompt-1\.png\]$/);
  const d = await runState(page);
  expect(d.preview).toMatchObject({ custom: true });
  await expect(runDlg(page).locator('.dd-preview-tape')).toHaveText('Edited');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(async () => (await runStarts(page)).length).toBe(1);
  const args = (await runStarts(page))[0]!.args as { prompt?: string; extra?: string };
  expect(args.prompt).toMatch(/^\/write-code https:\/\/github.com\/JeffreyVdb\/herdr-3d\/issues\/7\n/);
  expect(args.prompt!.endsWith(`Also look at ${marker}`)).toBe(true);
  expect(args.extra).toBeUndefined();
  clean();
});

test('Start Run: removing the image in Extra takes the marker out of the generated prompt; Reset brings the generated prompt back with its chip', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page, '', 'demo-m4');
  await openRun(page);
  await extraBox(page).click();
  await paste(page, '#run-extra', [{ name: 'mock.png' }]);
  await expect(slipChips(page)).toHaveCount(1);
  // Edit the prompt: it is custom, the chip in it stays whatever happens in Extra.
  await promptBox(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' Thanks.');
  expect((await runState(page)).preview.custom).toBe(true);
  await runDlg(page).locator('[data-key="reset-prompt"]').click();
  expect((await runState(page)).preview.custom).toBe(false);
  await expect(slipChips(page)).toHaveCount(1);
  // Remove it from Extra: the (generated again) prompt loses the marker and the chip.
  await extraChips(page).first().locator('.cmp-remove').click();
  await expect.poll(async () => (await runState(page)).preview.text).not.toContain('[Image #1');
  await expect(slipChips(page)).toHaveCount(0);
  expect((await runState(page)).form.extra).toBe('');
  clean();
});

test('Start Run: an image that did not upload blocks Start and says why; Retry, then it starts', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = scriptErrors(page);
  await onFloor(page, '&fail_upload=1', 'demo-m4');
  await openRun(page);
  await extraBox(page).click();
  await page.keyboard.type('see ');
  await paste(page, '#run-extra', [{ name: 'bad.png', color: '#e8413a' }]);
  await expect(extraChips(page).locator('.cmp-state')).toContainText('Failed');
  const d = await runState(page);
  expect(d.blocker).toMatch(/^Extra instructions: image 1 \(bad\.png\) did not upload/);
  await expect(runDlg(page).locator('[data-key="start"]')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(runDlg(page).locator('.dd-status--error')).toContainText('did not upload');
  expect(await runStarts(page)).toHaveLength(0);
  await shot(page, '04-start-run-upload-failed');
  await extraChips(page).first().locator('.cmp-retry').click();
  await expect(extraChips(page).locator('.cmp-state')).toHaveText('Uploaded');
  await expect.poll(async () => (await runState(page)).blocker).toBeNull();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(async () => (await runStarts(page)).length).toBe(1);
  expect(((await runStarts(page))[0]!.args as { extra: string }).extra).toBe(`see [Image #1: ${DROP}/h3d-run-extra-1.png]`);
  clean();
});

test('Start Run: a pending upload holds Start until it is up; too big / not an image is refused in the field; the Ticket takes no image', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page, '&upload_delay=1500', 'demo-m4');
  await openRun(page);
  await extraBox(page).click();
  await paste(page, '#run-extra', [{ name: 'huge.png', bytes: (25 << 20) + 1 }, { name: 'doc.pdf', mime: 'application/pdf' }]);
  await expect(runDlg(page).locator('.dd-extra .cmp-refusal')).toContainText('huge.png is 25.0 MB');
  await expect(extraChips(page)).toHaveCount(0);
  await runDlg(page).locator('.dd-extra .cmp-dismiss').click(); // a refusal holds the start until it is dismissed (below)
  await paste(page, '#run-extra', [{ name: 'slow.png' }]);
  await expect(extraChips(page).locator('.cmp-state')).toHaveText('Uploading…');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(runDlg(page).locator('.dd-status[role="status"]')).toContainText('Uploading the images');
  expect(await runStarts(page)).toHaveLength(0);
  await expect.poll(async () => (await runStarts(page)).length, { timeout: 10_000 }).toBe(1);
  expect(((await runStarts(page))[0]!.args as { extra: string }).extra).toBe(`[Image #1: ${DROP}/h3d-run-extra-1.png]`);
  clean();
});

test('Start Run: the Ticket stays text: no chip, no promise of one in its hint', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page, '', 'demo-m4');
  await openRun(page);
  await paste(page, '#run-ticket', [{ name: 'nope.png' }]);
  await expect(runDlg(page).locator('.cmp-chip')).toHaveCount(0);
  expect(await page.locator('#run-ticket').evaluate((e) => e.tagName)).toBe('TEXTAREA');
  await expect(page.locator('#run-ticket-hint')).not.toContainText('screenshot');
  clean();
});

test('Start Run: a file Extra or the First prompt refused holds Start (the fields keep their text) until each refusal is dismissed; then it starts', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page, '', 'demo-m4');
  await openRun(page);
  await extraBox(page).click();
  await page.keyboard.type('Extra text');
  await paste(page, '#run-extra', [{ name: 'doc.pdf', mime: 'application/pdf' }]);
  await paste(page, '#run-prompt', [{ name: 'huge.png', bytes: (25 << 20) + 1 }]);
  const extraRefusal = runDlg(page).locator('.dd-extra .cmp-refusal');
  const slipRefusal = runDlg(page).locator('.dd-slip .cmp-refusal');
  await expect(extraRefusal).toContainText('doc.pdf is not a PNG, JPEG, GIF or WebP image');
  await expect(slipRefusal).toContainText('huge.png is 25.0 MB');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(runDlg(page).locator('.dd-status--error')).toContainText('Extra instructions: Nothing was started: doc.pdf is not a PNG');
  await expect(extraRefusal).toBeInViewport(); // a refusal scrolled out of sight is brought back
  await runDlg(page).locator('[data-key="start"]').click({ force: true }); // aria-disabled: pressed anyway, it says why and does not go
  await frames(page, 3);
  expect(await runStarts(page)).toHaveLength(0);
  expect((await runState(page)).blocker).toMatch(/^Extra instructions: Nothing was started/);
  expect(await shown(extraBox(page))).toBe('Extra text');
  await expect(extraRefusal).toBeVisible();
  await shot(page, '12-start-run-refused-holds-start');
  await extraRefusal.locator('.cmp-dismiss').click();
  await expect(extraRefusal).toBeHidden();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(runDlg(page).locator('.dd-status--error')).toContainText('First prompt: Nothing was started: huge.png is 25.0 MB');
  expect(await runStarts(page)).toHaveLength(0);
  await slipRefusal.locator('.cmp-dismiss').click();
  await expect(slipRefusal).toBeHidden();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(async () => (await runStarts(page)).length).toBe(1);
  const args = (await runStarts(page))[0]!.args as { extra?: string; prompt?: string };
  expect(args.extra).toBe('Extra text');
  expect(args.prompt).toBeUndefined();
  clean();
});

test('Start Run: the First prompt is read-only while its generated text names an Extra image that has no path yet; once it has, an edit goes with the path, never a bare marker', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page, '&upload_delay=5000', 'demo-m4');
  await openRun(page);
  await extraBox(page).click();
  await page.keyboard.type('Mock: ');
  await paste(page, '#run-extra', [{ name: 'mock.png' }]);
  await expect(extraChips(page).locator('.cmp-state')).toHaveText('Uploading…');
  // The generated prompt carries the bare marker while the upload is on its way: the field says why it cannot be edited.
  await expect.poll(async () => (await runState(page)).preview.text, { timeout: 10_000 }).toMatch(/\[Image #1\]/);
  await expect(promptBox(page)).toHaveAttribute('contenteditable', 'false');
  await expect(runDlg(page).locator('#run-prompt-note')).toContainText('Read-only until the image in Extra instructions has uploaded');
  await shot(page, '13-start-run-first-prompt-waits-for-image');
  await promptBox(page).click({ force: true }); // aria-disabled: Playwright would wait for it; a user's click lands at once
  await page.keyboard.type('EDIT');
  expect((await runState(page)).preview.custom).toBe(false);
  expect(await shown(promptBox(page))).not.toContain('EDIT');
  // The image is up: the preview carries its path (as a chip), and the First prompt can be edited.
  const marker = `[Image #1: ${DROP}/h3d-run-extra-1.png]`;
  await expect.poll(async () => (await runState(page)).preview.text, { timeout: 20_000 }).toContain(marker);
  await expect(promptBox(page)).toHaveAttribute('contenteditable', 'true');
  await settled(page);
  await promptBox(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\nBe careful');
  expect((await runState(page)).preview.custom).toBe(true);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(async () => (await runStarts(page)).length).toBe(1);
  const args = (await runStarts(page))[0]!.args as { extra?: string; prompt?: string };
  expect(args.prompt).toContain(marker);
  expect(args.prompt).not.toMatch(/\[Image #1\]/);
  expect(args.prompt!.endsWith('Be careful')).toBe(true);
  expect(args.extra).toBe(`Mock: ${marker}`);
  clean();
});

test('Start Run: marker-shaped words typed in Extra (no image attached) never lock the First prompt', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await onFloor(page, '', 'demo-m4');
  await openRun(page);
  await extraBox(page).click();
  const literal = 'Keep the literal label [Image #1] in the docs.';
  await pasteText(page, '#run-extra', literal);
  await settled(page);
  await expect(extraChips(page)).toHaveCount(0);
  await expect.poll(async () => (await runState(page)).preview.text, { timeout: 10_000 }).toContain(literal);
  // Plain text: the First prompt stays editable, says nothing about an image, and an edit of it goes as usual.
  await expect(promptBox(page)).toHaveAttribute('contenteditable', 'true');
  await expect(runDlg(page).locator('#run-prompt-note')).not.toContainText('Read-only');
  await promptBox(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\nBe careful');
  expect((await runState(page)).preview.custom).toBe(true);
  await expect(runDlg(page).locator('[data-key="reset-prompt"]')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(async () => (await runStarts(page)).length).toBe(1);
  const args = (await runStarts(page))[0]!.args as { extra?: string; prompt?: string };
  expect(args.extra).toBe(literal);
  expect(args.prompt).toContain(literal);
  expect(args.prompt!.endsWith('Be careful')).toBe(true);
  clean();
});

// ---- the seated view ------------------------------------------------------------------------------------------------

async function sitAt(page: Page, name: string, extra = ''): Promise<{ id: string; key: string }> {
  const { key } = await onFloor(page, extra, 'demo-m5', '&prints=0');
  const id = await idOf(page, name);
  expect(await page.evaluate((i) => window.__h3d.face(i), id), `facing ${name}`).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
  await expect(page.locator('.seat')).toBeVisible();
  await frames(page, 20);
  return { id, key };
}

const tx = (page: Page) => page.locator('.seat-transcript .tx');
const txBox = (page: Page) => tx(page).locator('.tx-input');
const txChips = (page: Page) => tx(page).locator('.cmp-chip');
const seatNote = async (page: Page) => (await page.evaluate(() => window.__h3d.seat())).note;

/** #98: the conversation is up as you sit (a Claude worker); the keyboard to its prompt box. */
async function toTranscript(page: Page): Promise<void> {
  await seatMode(page, 'transcript');
  await expect(tx(page)).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(txBox(page)).toBeFocused();
}

test('transcript: a pasted screenshot is a chip in the prompt box; Enter sends worker.prompt with the marker; Shift+Enter is a new line', { tag: '@smoke' }, async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  const { id } = await sitAt(page, 'Pebble');
  await toTranscript(page);
  await expect(txBox(page)).toHaveAttribute('data-placeholder', /paste a screenshot to add it/);
  await page.keyboard.type('what is wrong here?');
  await page.keyboard.press('Shift+Enter');
  await paste(page, '.seat-transcript .tx-input', [{ name: 'broken.png' }]);
  await expect(txChips(page)).toHaveCount(1);
  await expect(txChips(page).locator('.cmp-state')).toHaveText('Uploaded');
  await shot(page, '05-transcript-chip');
  expect(await sentOf(page, 'worker.prompt')).toHaveLength(0);
  await page.keyboard.press('Enter');
  const marker = `[Image #1: ${DROP}/h3d-transcript-pebble-1.png]`;
  await expect.poll(async () => (await sentOf(page, 'worker.prompt')).map((c) => c.args)).toEqual([{ id, text: `what is wrong here?\n${marker}` }]);
  await expect(txChips(page)).toHaveCount(0);
  expect(await shown(txBox(page))).toBe('');
  await expect(txBox(page)).toBeFocused();
  // Plain typing and a plain-text paste are as before.
  await page.keyboard.type('thanks');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await sentOf(page, 'worker.prompt')).length).toBe(2);
  // The box is read-only until the send is answered.
  await expect(txBox(page)).toHaveAttribute('contenteditable', 'true');
  await pasteText(page, '.seat-transcript .tx-input', 'from the clipboard');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await sentOf(page, 'worker.prompt')).map((c) => (c.args as { text: string }).text)).toEqual([`what is wrong here?\n${marker}`, 'thanks', 'from the clipboard']);
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(id);
  clean();
});

test('transcript: a failed upload (Drop Zone down) blocks the send with a word, keeps the prompt; a pending one holds it; too big / not an image is refused', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = scriptErrors(page);
  await sitAt(page, 'Pebble', '&fail_upload=1');
  await toTranscript(page);
  await page.keyboard.type('see ');
  await paste(page, '.seat-transcript .tx-input', [{ name: 'huge.png', bytes: (25 << 20) + 1 }, { name: 'doc.pdf', mime: 'application/pdf' }]);
  await expect(tx(page).locator('.cmp-refusal')).toContainText('huge.png is 25.0 MB');
  await expect(txChips(page)).toHaveCount(0);
  await tx(page).locator('.cmp-dismiss').click(); // a refusal holds the send until it is dismissed (below)
  await paste(page, '.seat-transcript .tx-input', [{ name: 'bad.png', color: '#e8413a' }]);
  await expect(txChips(page).locator('.cmp-state')).toContainText('Failed');
  await page.keyboard.press('Enter');
  await expect(tx(page).locator('.cmp-notice')).toContainText('Nothing was sent: image 1 (bad.png) did not upload');
  expect(await sentOf(page, 'worker.prompt')).toHaveLength(0);
  await expect(txBox(page)).toHaveAttribute('contenteditable', 'true');
  expect(await shown(txBox(page))).toContain('see');
  await shot(page, '06-transcript-upload-failed');
  await txChips(page).first().locator('.cmp-retry').click();
  await expect(txChips(page).locator('.cmp-state')).toHaveText('Uploaded');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await sentOf(page, 'worker.prompt')).length).toBe(1);
  expect(((await sentOf(page, 'worker.prompt'))[0]!.args as { text: string }).text).toMatch(/^see \[Image #1: [^\]]+\]$/);
  clean();
});

test('transcript: a pending upload holds the prompt (the box read-only) until it is up', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await sitAt(page, 'Pebble', '&upload_delay=1500');
  await toTranscript(page);
  await paste(page, '.seat-transcript .tx-input', [{ name: 'slow.png' }]);
  await expect(txChips(page).locator('.cmp-state')).toHaveText('Uploading…');
  await page.keyboard.press('Enter');
  await expect(txBox(page)).toHaveAttribute('contenteditable', 'false');
  expect(await sentOf(page, 'worker.prompt')).toHaveLength(0);
  await expect.poll(async () => (await sentOf(page, 'worker.prompt')).length, { timeout: 10_000 }).toBe(1);
  await expect(txBox(page)).toHaveAttribute('contenteditable', 'true');
  clean();
});

test('transcript: a file the box refused holds the send (prompt kept, refusal stays up) until it is dismissed; then it goes', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const { id } = await sitAt(page, 'Pebble');
  await toTranscript(page);
  await page.keyboard.type('see this');
  await paste(page, '.seat-transcript .tx-input', [{ name: 'doc.pdf', mime: 'application/pdf' }]);
  const refusal = tx(page).locator('.cmp-refusal');
  await expect(refusal).toContainText('doc.pdf is not a PNG, JPEG, GIF or WebP image');
  await page.keyboard.press('Enter');
  await expect(tx(page).locator('.cmp-notice')).toContainText('Nothing was sent: doc.pdf is not a PNG');
  await tx(page).locator('.tx-send').click();
  await frames(page, 3);
  expect(await sentOf(page, 'worker.prompt')).toHaveLength(0);
  await expect(refusal).toBeVisible();
  expect(await shown(txBox(page))).toBe('see this');
  await shot(page, '14-transcript-refused-holds-send');
  await txBox(page).focus();
  await page.keyboard.press('Tab');
  await expect(tx(page).locator('.cmp-dismiss')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(refusal).toBeHidden();
  await expect(txBox(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await sentOf(page, 'worker.prompt')).map((c) => c.args)).toEqual([{ id, text: 'see this' }]);
  clean();
});

test('terminal: an image pasted at an agent’s laptop is uploaded and pasted as its marker (worker.prompt); a text paste is as before', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const { id } = await sitAt(page, 'Pebble');
  await seatMode(page, 'terminal');
  await paste(page, '.seat-input', [{ name: 'shot-a.png' }, { name: 'shot-b.png', color: '#12a26a' }]);
  await expect.poll(async () => (await sentOf(page, 'worker.prompt')).map((c) => c.args)).toEqual([
    { id, text: `[Image #1: ${DROP}/h3d-terminal-pebble-1.png][Image #2: ${DROP}/h3d-terminal-pebble-2.png]` },
  ]);
  await expect.poll(() => seatNote(page)).toMatch(/Pasted into Pebble.s terminal/);
  await pasteText(page, '.seat-input', 'Run the tests.');
  await expect.poll(async () => (await sentOf(page, 'worker.prompt')).map((c) => (c.args as { text: string }).text)).toEqual([
    `[Image #1: ${DROP}/h3d-terminal-pebble-1.png][Image #2: ${DROP}/h3d-terminal-pebble-2.png]`,
    'Run the tests.',
  ]);
  expect(await sentOf(page, 'worker.keys')).toHaveLength(0);
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(id);
  await shot(page, '07-terminal-pasted');
  clean();
});

// #42: a plain shell (no agent to read a picture) is src/laptop/pasteImages.test.ts "a plain shell says it cannot take an
// image; …"; the seat bar's note, its error state and the toast of a refused paste are the case below.
test('terminal: a failed upload (Drop Zone down), a refused file and a pending upload: nothing is pasted until every image is up', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = scriptErrors(page);
  const { key } = await sitAt(page, 'Pebble', '&fail_upload=1&upload_delay=800');
  await seatMode(page, 'terminal');
  await paste(page, '.seat-input', [{ name: 'huge.png', bytes: (25 << 20) + 1 }]);
  await expect.poll(() => seatNote(page)).toMatch(/huge\.png is 25\.0 MB.* Nothing was pasted\./);
  await paste(page, '.seat-input', [{ name: 'a.png' }]);
  await expect.poll(() => seatNote(page)).toMatch(/^Uploading the image for Pebble/);
  expect(await sentOf(page, 'worker.prompt')).toHaveLength(0);
  await expect.poll(() => seatNote(page)).toMatch(/Nothing was pasted into Pebble.s terminal: image 1 \(a\.png\) did not upload \(.*Drop Zone.*\)\. Paste again to retry\./);
  expect((await page.evaluate(() => window.__h3d.seat())).state).toBe('error');
  await expect(page.locator('.toast').last()).toContainText('did not upload');
  expect(await sentOf(page, 'worker.prompt')).toHaveLength(0);
  // Paste again: the fixture fails only the first upload; while it is on its way nothing is sent.
  await paste(page, '.seat-input', [{ name: 'a.png' }]);
  await page.waitForTimeout(200);
  expect(await sentOf(page, 'worker.prompt')).toHaveLength(0);
  await expect.poll(async () => (await sentOf(page, 'worker.prompt')).length, { timeout: 10_000 }).toBe(1);
  const log = (await page.evaluate(async (k) => (await fetch(`/upload/_log?upload_key=${k}`)).json(), key)).data as Array<{ result: string }>;
  expect(log.map((e) => e.result)).toEqual(['dropzone_unavailable', 'ok']);
  clean();
});
