import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, seatMode, shot, watchErrors } from './game';

// #31: a file reference in the transcript (`[label](/path)`) keeps its friendly label; activating it (Enter / Space,
// or a click) opens a popover with the full path and "Copy file path", which puts exactly the path on the clipboard.
// demo-m5 against the fixture bridge (`sim=1`): `sim.final` (tools/fixture-handoff.ts) plays Zippy's agent ending its
// turn with the message under test; Zippy's checkout is /home/dev/devel/herdr-3d, for the relative reference.

const SIM = 'play=none&sim=1&simms=150&simusage=0';
const REPRO = '/tmp/herdr-remote-runtime-handoff-2026-10-09.md';
const MESSAGE = `Saved the [handoff document](${REPRO}) in \`/tmp\`. The plan is in [the plan](./docs/plan%20v2.md), and [the site](https://example.com/) has the rest.`;

async function sitAtZippy(page: Page): Promise<void> {
  await openGame(page, 'demo-m5', '&prints=0', SIM);
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const id = await page.evaluate(() => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === 'Zippy')?.id ?? '');
  expect(await page.evaluate((i) => window.__h3d.face(i), id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((i) => window.__h3d.sitAt(i), id)).toBe(true);
  await frames(page, 20);
  await seatMode(page, 'transcript');
  await expect(page.locator('.seat-transcript .tx .tx-scroll')).toBeFocused();
  const r = await page.evaluate((a) => window.__h3d.simHandoff('sim.final', a), { id, text: MESSAGE });
  expect(r.ok).toBe(true);
}

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test('a file reference opens by keyboard, copies its exact path, and gives the keyboard back on Esc', async ({ page, context }) => {
  const clean = watchErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await sitAtZippy(page);
  const tx = page.locator('.seat-transcript .tx');
  const ref = tx.getByRole('button', { name: 'handoff document', exact: true });
  await expect(ref).toHaveCount(1);
  // The friendly label is what shows; the path is not in the text, and the reference is no navigable link.
  await expect(ref).toHaveText('handoff document');
  await expect(ref).not.toHaveAttribute('href');
  await expect(ref).toHaveAttribute('aria-expanded', 'false');
  await expect(tx.locator('.tx-md', { hasText: 'Saved the' })).not.toContainText(REPRO);
  // The web link is unchanged.
  const web = tx.locator('a[href="https://example.com/"]');
  await expect(web).toHaveAttribute('target', '_blank');
  await expect(web).toHaveAttribute('rel', 'noopener noreferrer');
  await page.evaluate(() => navigator.clipboard.writeText('before'));

  // Both references are in the tab order: from the second, Shift+Tab reaches the first.
  await ref.scrollIntoViewIfNeeded();
  await tx.getByRole('button', { name: 'the plan', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(ref).toBeFocused();
  await page.keyboard.press('Enter');
  const dlg = tx.getByRole('dialog', { name: 'File path' });
  await expect(dlg).toBeVisible();
  await expect(ref).toHaveAttribute('aria-expanded', 'true');
  await expect(dlg.locator('.tx-fref-path')).toHaveText(REPRO);
  const copy = dlg.getByRole('button', { name: 'Copy file path' });
  await expect(copy).toBeFocused();

  // Inside the screen: nothing clips it.
  const [p, s] = await Promise.all([dlg.boundingBox(), tx.boundingBox()]);
  expect(p && s).toBeTruthy();
  expect(p!.x).toBeGreaterThanOrEqual(s!.x - 0.5);
  expect(p!.y).toBeGreaterThanOrEqual(s!.y - 0.5);
  expect(p!.x + p!.width).toBeLessThanOrEqual(s!.x + s!.width + 0.5);
  expect(p!.y + p!.height).toBeLessThanOrEqual(s!.y + s!.height + 0.5);
  // The top-most thing at its centre is the popover itself.
  expect(await dlg.evaluate((d) => {
    const b = d.getBoundingClientRect();
    return d.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2));
  })).toBe(true);
  await shot(page, 'h31-popover');
  // The shot hides the HUD for a moment, which blurs what had the keyboard: back on Copy.
  await copy.focus();

  await page.keyboard.press('Enter');
  await expect(dlg.getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect(dlg.getByRole('status')).toHaveText('File path copied to the clipboard.');
  expect(await clipboard(page)).toBe(REPRO);

  // Esc closes it, the keyboard is back on the reference, and you are still seated.
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await expect(ref).toBeFocused();
  await expect(ref).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => window.__h3d.seat().mode)).toBe('transcript');
  await expect(page.locator('.seat')).toBeVisible();

  // Space opens it as well; a click outside closes it.
  await page.keyboard.press(' ');
  await expect(dlg).toBeVisible();
  await tx.locator('.tx-bar .tx-title').click();
  await expect(dlg).toBeHidden();

  // A relative reference: a click, the path in Zippy's checkout, copied by pointer.
  const plan = tx.getByRole('button', { name: 'the plan', exact: true });
  await plan.click();
  await expect(dlg.locator('.tx-fref-path')).toHaveText('/home/dev/devel/herdr-3d/docs/plan v2.md');
  await expect(dlg.locator('.tx-fref-note')).toHaveText('Written as ./docs/plan v2.md, in the worker’s checkout.');
  await dlg.getByRole('button', { name: 'Copy file path' }).click();
  await expect.poll(() => clipboard(page)).toBe('/home/dev/devel/herdr-3d/docs/plan v2.md');
  await page.keyboard.press('Escape');
  await expect(plan).toBeFocused();
  clean();
});

test('a refused clipboard says so and leaves the path selected for the copy key', async ({ page, context }) => {
  const clean = watchErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await sitAtZippy(page);
  const tx = page.locator('.seat-transcript .tx');
  // The browser refuses the write (as it does without permission or outside a secure context).
  await page.evaluate(() => {
    const real = navigator.clipboard.writeText.bind(navigator.clipboard);
    (window as unknown as { __realWrite: typeof real }).__realWrite = real;
    navigator.clipboard.writeText = () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
  });
  const ref = tx.getByRole('button', { name: 'handoff document', exact: true });
  await ref.scrollIntoViewIfNeeded();
  await ref.focus();
  await page.keyboard.press('Enter');
  const dlg = tx.getByRole('dialog', { name: 'File path' });
  await page.keyboard.press('Enter');
  const status = dlg.getByRole('status');
  await expect(status).toBeVisible();
  await expect(status).toContainText('Couldn’t copy');
  await expect(status).toContainText(/press (Ctrl\+C|⌘C) to copy it/);
  await expect(dlg.locator('.tx-fref-path')).toBeFocused();
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(REPRO);
  await shot(page, 'h31-copy-refused');
  // The shot hides the HUD for a moment, which blurs what had the keyboard: back on the path (selected again).
  await dlg.locator('.tx-fref-path').focus();
  // The copy key copies the selection (the browser's own copy, not the refused API).
  await page.evaluate(() => (window as unknown as { __realWrite: (t: string) => Promise<void> }).__realWrite('before'));
  expect(await clipboard(page)).toBe('before');
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(() => clipboard(page)).toBe(REPRO);
  await page.keyboard.press('Escape');
  await expect(ref).toBeFocused();
  clean();
});

test('on a phone-sized screen the popover wraps the path and stays inside the transcript', async ({ page }) => {
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 740 });
  await sitAtZippy(page);
  const tx = page.locator('.seat-transcript .tx');
  const ref = tx.getByRole('button', { name: 'handoff document', exact: true });
  await ref.scrollIntoViewIfNeeded();
  await ref.click();
  const dlg = tx.getByRole('dialog', { name: 'File path' });
  await expect(dlg).toBeVisible();
  const path = dlg.locator('.tx-fref-path');
  await expect(path).toHaveText(REPRO);
  const [p, s] = await Promise.all([dlg.boundingBox(), tx.boundingBox()]);
  expect(p!.x).toBeGreaterThanOrEqual(s!.x - 0.5);
  expect(p!.x + p!.width).toBeLessThanOrEqual(s!.x + s!.width + 0.5);
  expect(p!.y).toBeGreaterThanOrEqual(s!.y - 0.5);
  expect(p!.y + p!.height).toBeLessThanOrEqual(s!.y + s!.height + 0.5);
  // The whole path shows, wrapped (no horizontal scroll inside it).
  expect(await path.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  await shot(page, 'h31-popover-narrow');
  clean();
});

// U2: a short seated screen has little room on either side of a reference. Wherever the reference is in the visible
// timeline, the popover opens with Copy wholly in view, on top and with the keyboard (never scrolled out of its own
// box), and at least the start of the path readable; only the path and its note scroll. Both UI themes (Ubuntu's
// buttons are taller), an absolute path and a relative one with its note, opened by pointer and by keyboard.
const MANY = Array.from(
  { length: 25 },
  (_, i) => `Position ${i + 1}: Saved the [handoff document ${i + 1}](${REPRO}). The plan is in [the plan ${i + 1}](./docs/plan%20v2.md).`,
).join('\n\n');

async function sitWithMany(page: Page, ui: 'quiet' | 'ubuntu', size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  if (ui === 'ubuntu') {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('h3d.theme.ui', 'ubuntu');
        localStorage.setItem('h3d.theme.transcript', 'ubuntu');
      } catch {
        /* blocked */
      }
    });
  }
  await openGame(page, 'demo-m5', '&prints=0', SIM);
  await page.evaluate(() => window.__h3d.themeLoaded());
  await page.evaluate(() => window.__h3d.enterFloor('herdr-3d'));
  await frames(page, 3);
  const id = await page.evaluate(() => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === 'Zippy')?.id ?? '');
  expect(await page.evaluate((i) => window.__h3d.face(i), id)).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((i) => window.__h3d.sitAt(i), id)).toBe(true);
  await frames(page, 20);
  await seatMode(page, 'transcript');
  const r = await page.evaluate((a) => window.__h3d.simHandoff('sim.final', a), { id, text: MANY });
  expect(r.ok).toBe(true);
  await expect(page.locator('.seat-transcript .tx-file-ref', { hasText: 'handoff document 25' })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-ui-theme'))).toBe(ui);
}

/** Scrolls the timeline so a reference of this kind has its top at `at` of the visible timeline's height; returns its name. */
async function bringTo(page: Page, kind: 'handoff document' | 'the plan', at: number): Promise<string> {
  const name = await page.evaluate(
    ({ kind, at }) => {
      const sc = document.querySelector<HTMLElement>('.seat-transcript .tx-scroll')!;
      const max = sc.scrollHeight - sc.clientHeight;
      const refs = [...sc.querySelectorAll<HTMLElement>('.tx-file-ref')].filter((a) => a.textContent!.startsWith(`${kind} `));
      // The middle one that can sit there (the first ones cannot be low, the last ones cannot be high).
      for (const a of refs.slice(10).concat(refs.slice(0, 10).reverse())) {
        const y = a.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
        const want = y - at * sc.clientHeight;
        if (want < 0 || want > max) continue;
        sc.scrollTop = want;
        return a.textContent!;
      }
      return '';
    },
    { kind, at },
  );
  expect(name, `a ${kind} at ${at}`).not.toBe('');
  await frames(page, 2);
  return name;
}

async function expectCopyInView(page: Page, label: string): Promise<void> {
  const dlg = page.locator('.seat-transcript .tx-fref[role="dialog"]');
  await expect(dlg, label).toBeVisible();
  const copy = dlg.getByRole('button', { name: 'Copy file path' });
  await expect(copy, label).toBeFocused();
  // Past the opening animation.
  await page.waitForTimeout(200);
  const m = await page.evaluate(() => {
    const d = document.querySelector<HTMLElement>('.seat-transcript .tx-fref')!;
    const b = d.querySelector<HTMLElement>('.tx-fref-copy')!;
    // (What scrolls the path: its body; the popover itself before it had one.)
    const body = d.querySelector<HTMLElement>('.tx-fref-body') ?? d;
    const path = d.querySelector<HTMLElement>('.tx-fref-path')!;
    const root = document.querySelector<HTMLElement>('.seat-transcript .tx')!;
    const rect = (e: Element) => {
      const r = e.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    const c = rect(b);
    // On top at its centre and near each corner.
    const pts: [number, number][] = [
      [(c.left + c.right) / 2, (c.top + c.bottom) / 2],
      [c.left + 2, c.top + 2],
      [c.right - 2, c.top + 2],
      [c.left + 2, c.bottom - 2],
      [c.right - 2, c.bottom - 2],
    ];
    const lh = parseFloat(getComputedStyle(path).lineHeight);
    const bv = rect(body);
    const pv = rect(path);
    return {
      copy: c,
      pop: rect(d),
      root: rect(root),
      win: { width: innerWidth, height: innerHeight },
      onTop: pts.every(([x, y]) => b.contains(document.elementFromPoint(x, y))),
      popScrolled: d.scrollTop,
      popClipsCopy: c.bottom > d.getBoundingClientRect().top + d.clientTop + d.clientHeight + 0.5,
      // How much of the path shows in the body, against two lines of it (or all of it).
      pathShown: Math.min(pv.bottom, bv.bottom) - Math.max(pv.top, bv.top),
      pathWant: Math.min(pv.bottom - pv.top, 2 * lh),
      pathTopShown: pv.top >= bv.top - 0.5,
      bodyScrolls: getComputedStyle(body).overflowY === 'auto',
      noSideways: path.scrollWidth <= path.clientWidth + 1,
    };
  });
  const e = 0.5;
  const inside = (o: { top: number; bottom: number; left: number; right: number }, i: typeof o) =>
    o.top >= i.top - e && o.bottom <= i.bottom + e && o.left >= i.left - e && o.right <= i.right + e;
  const view = { top: 0, left: 0, bottom: m.win.height, right: m.win.width };
  expect(inside(m.copy, m.pop), `${label}: Copy inside the popover ${JSON.stringify(m)}`).toBe(true);
  expect(m.popClipsCopy, `${label}: Copy not under the popover's fold ${JSON.stringify(m)}`).toBe(false);
  expect(m.popScrolled, `${label}: the popover itself not scrolled`).toBe(0);
  expect(inside(m.copy, view), `${label}: Copy inside the window ${JSON.stringify(m)}`).toBe(true);
  expect(inside(m.pop, m.root), `${label}: the popover inside the transcript ${JSON.stringify(m)}`).toBe(true);
  expect(m.onTop, `${label}: nothing covers Copy`).toBe(true);
  expect(m.pathTopShown, `${label}: the path starts in view`).toBe(true);
  expect(m.pathShown, `${label}: two lines of the path (or all of it) show ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(m.pathWant - 1);
  expect(m.bodyScrolls, `${label}: the rest of the path scrolls`).toBe(true);
  expect(m.noSideways, `${label}: the path wraps`).toBe(true);
}

for (const size of [
  { width: 640, height: 360 },
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
]) {
  for (const ui of ['quiet', 'ubuntu'] as const) {
    test(`at ${size.width}x${size.height} (${ui}) Copy is in view wherever the reference is`, async ({ page }) => {
      const clean = watchErrors(page);
      await sitWithMany(page, ui, size);
      const tx = page.locator('.seat-transcript .tx');
      const dlg = tx.getByRole('dialog', { name: 'File path' });
      for (const at of [0.12, 0.5, 0.88]) {
        for (const kind of ['handoff document', 'the plan'] as const) {
          for (const how of ['pointer', 'keyboard'] as const) {
            const label = `${kind} at ${at}, ${how}`;
            const name = await bringTo(page, kind, at);
            const ref = tx.getByRole('button', { name, exact: true });
            if (how === 'pointer') await ref.click();
            else {
              await ref.evaluate((e) => e.focus({ preventScroll: true }));
              await page.keyboard.press('Enter');
            }
            if (kind === 'the plan') await expect(dlg.locator('.tx-fref-note'), label).toBeVisible();
            await expectCopyInView(page, label);
            if (size.width === 640 && at === 0.12 && how === 'pointer') {
              await shot(page, `h31-short-${ui}-${kind === 'the plan' ? 'relative' : 'absolute'}`);
              // The shot hides the HUD for a moment, which blurs what had the keyboard: back on Copy.
              await dlg.getByRole('button', { name: 'Copy file path' }).focus();
            }
            await page.keyboard.press('Escape');
            await expect(dlg, label).toBeHidden();
          }
        }
      }
      clean();
    });
  }
}
