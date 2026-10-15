import { expect, test, type Locator, type Page } from '@playwright/test';
import { frames, openGame, openMenu, settingsSection, shot, watchErrors } from './game';

// #40 on demo-m4 with the simulator: Settings → Task levels and the Hire dialog's chips keep their dialog's header and
// body where they are, whatever is clicked or pressed. The bug: a chip's visually hidden radio had no containing block
// inside the scrolling body, so focusing it (a label click, an arrow key, a redraw's focus) scrolled the dialog itself,
// which clips, and left it blank. Every check measures right after the click or key, in one evaluate: a locator action
// in between would scroll the page back into view and hide the bug.

const SIM = 'play=none&sim=1&simms=150';
const SIZES = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: '390', width: 390, height: 640 },
] as const;
const THEMES = ['quiet', 'ubuntu'] as const;

/** Three named levels, none set: the fixture's own catalog sets them by a click. */
const SEED = {
  v: 2,
  levels: [
    { id: 'a', name: 'Very trivial', harness: '', model: '', effort: '' },
    { id: 'b', name: 'Trivial', harness: '', model: '', effort: '' },
    { id: 'c', name: 'Slightly complex', harness: '', model: '', effort: '' },
  ],
  default: null,
};

interface Geometry {
  dialog: number;
  head: number;
  body: number;
  doc: number;
  /** The focus is in the dialog (not on the page's body). */
  focusIn: boolean;
  /** What has the focus (its label, for a chip's radio) overlaps the scrolling body's box. */
  focusShown: boolean;
  key: string | null;
}

/** The dialog's geometry after two frames: its own scroll, its header's and body's tops, the page's scroll, the focus. */
async function geometry(page: Page, dialog: string, scroller: string): Promise<Geometry> {
  return page.evaluate(
    ([d, s]) =>
      new Promise<Geometry>((done) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const dlg = document.querySelector<HTMLElement>(d)!;
            const body = dlg.querySelector<HTMLElement>(s)!;
            const head = dlg.querySelector<HTMLElement>('header, .dd-head')!;
            const a = document.activeElement as HTMLElement | null;
            const box = (a?.closest('label') ?? a) as HTMLElement | null;
            const r = box?.getBoundingClientRect();
            const b = body.getBoundingClientRect();
            done({
              dialog: dlg.scrollTop,
              head: Math.round(head.getBoundingClientRect().top),
              body: Math.round(b.top),
              doc: document.scrollingElement?.scrollTop ?? 0,
              focusIn: !!a && a !== document.body && dlg.contains(a),
              focusShown: !!r && r.bottom > b.top && r.top < b.bottom,
              key: a?.dataset.key ?? null,
            });
          }),
        ),
      ),
    [dialog, scroller] as const,
  );
}

/** Waits for the dialog's own animations (its entrance slides 12 px) so its resting place is what is measured. */
async function settle(page: Page, dialog: string): Promise<void> {
  await page.evaluate(async (d) => {
    const dlg = document.querySelector<HTMLElement>(d);
    const finite = (dlg?.getAnimations({ subtree: true }) ?? []).filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
  }, dialog);
}

/** Scrolls only the inner scroller so `target` sits in its middle (never the dialog, never through a locator). */
async function bringIntoBody(target: Locator, scroller: string): Promise<void> {
  await target.evaluate((el, s) => {
    const body = el.closest<HTMLElement>(s)!;
    const box = (el.closest('label') ?? el).getBoundingClientRect();
    const b = body.getBoundingClientRect();
    body.scrollTop += box.top + box.height / 2 - (b.top + b.height / 2);
  }, scroller);
}

/** Clicks the middle of `target` with the mouse (a box read, no locator action that scrolls). */
async function clickAt(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('nothing to click');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** Settings: the dialog's frame stays put and the focus stays usable after `act`. */
function settingsCheck(page: Page) {
  const D = 'dialog.settings';
  const S = '.settings-body';
  let before: Geometry | null = null;
  return {
    async ready(target: Locator) {
      await settle(page, D);
      await bringIntoBody(target, S);
      before = await geometry(page, D, S);
      expect(before.dialog, 'the dialog starts unscrolled').toBe(0);
    },
    async after(what: string, focus = true) {
      const g = await geometry(page, D, S);
      expect(g.dialog, `${what}: the dialog itself never scrolls`).toBe(0);
      expect(g.head, `${what}: the header stays`).toBe(before?.head);
      expect(g.body, `${what}: the body stays`).toBe(before?.body);
      expect(g.doc, `${what}: the page never scrolls`).toBe(0);
      if (focus) {
        expect(g.focusIn, `${what}: the focus stays in the dialog (${g.key})`).toBe(true);
        expect(g.focusShown, `${what}: the focused control is in view (${g.key})`).toBe(true);
      }
      return g;
    },
  };
}

async function openSettings(page: Page): Promise<Locator> {
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  // #49: one section at a time; Task levels is picked from the list (the picker on a phone).
  return settingsSection(page, 'task-levels');
}

async function setup(page: Page, theme: (typeof THEMES)[number], size: (typeof SIZES)[number]): Promise<void> {
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.addInitScript(
    ([seed, t]) => {
      if (!sessionStorage.getItem('h40.seeded')) {
        localStorage.setItem('h3d.hire.taskLevels', JSON.stringify(seed));
        sessionStorage.setItem('h40.seeded', '1');
      }
      if (t === 'ubuntu') localStorage.setItem('h3d.theme.ui', 'ubuntu');
    },
    [SEED, theme] as const,
  );
  await openGame(page, 'demo-m4', '', SIM);
  await page.evaluate(() => window.__h3d.themeLoaded());
}

const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('h3d.hire.taskLevels') ?? 'null') as typeof SEED | null);

for (const theme of THEMES) {
  for (const size of SIZES) {
    test(`Settings → Task levels keeps the dialog in place: mouse, ${theme}, ${size.name}`, async ({ page }) => {
      test.setTimeout(180_000);
      const clean = watchErrors(page);
      await setup(page, theme, size);
      const section = await openSettings(page);
      const check = settingsCheck(page);
      const row = (id: string) => section.locator(`.tl-level[data-level="${id}"]`);
      const chip = (key: string) => section.locator(`label:has([data-key="${key}"])`);

      // Harness: the level is set with the harness's first shown model.
      const harness = row('b').locator('[data-pick="tl-b-harness"] label').last();
      await check.ready(harness);
      await clickAt(page, harness);
      await check.after('harness chip');
      await expect(row('b').locator('.settings-badge')).toHaveText('Set');

      // Effort: another one than the level holds.
      const effort = row('b').locator('[data-pick="tl-b-effort"] label:not(:has(input:checked))').first();
      await check.ready(effort);
      await clickAt(page, effort);
      await check.after('effort chip');

      // Model: another one, when the harness lists them as chips.
      const model = row('b').locator('[data-pick="tl-b-model"] label:not(:has(input:checked))').first();
      if (await model.count()) {
        await check.ready(model);
        await clickAt(page, model);
        await check.after('model chip');
      }

      // Default, then Move up / Move down.
      const def = row('c').locator('.tl-default');
      await check.ready(def);
      await clickAt(page, def);
      await check.after('Default');
      expect((await stored(page))?.default).toBe('c');
      const up = section.locator('[data-key="tl-c-up"]');
      await check.ready(up);
      await clickAt(page, up);
      await check.after('Move up');
      const down = section.locator('[data-key="tl-a-down"]');
      await check.ready(down);
      await clickAt(page, down);
      await check.after('Move down');
      expect((await stored(page))?.levels.map((l) => l.id)).toEqual(['c', 'a', 'b']);

      // Clear: the level stays, not set.
      const clear = section.locator('[data-key="tl-b-clear"]');
      await check.ready(clear);
      await clickAt(page, clear);
      await check.after('Clear');
      await expect(row('b').locator('.settings-badge')).toHaveText('Not set');

      // Add level: a new row, its name focused (and brought into the body's view).
      const add = section.locator('[data-key="tl-add"]');
      await check.ready(add);
      await clickAt(page, add);
      const added = await check.after('Add level');
      expect(added.key).toMatch(/^tl-.+-name$/);
      await expect(section.locator('.tl-level')).toHaveCount(4);
      await shot(page, `h40-settings-${theme}-${size.name}`);

      // Rename it by typing, Enter saves.
      await page.keyboard.type('Docs');
      await page.keyboard.press('Enter');
      await check.after('rename');
      expect((await stored(page))?.levels.map((l) => l.name)).toEqual(['Slightly complex', 'Very trivial', 'Trivial', 'Docs']);

      // Remove it: the focus goes to the previous row's name.
      const remove = section.locator('.tl-level').last().locator('[data-key$="-remove"]');
      await check.ready(remove);
      await clickAt(page, remove);
      const removed = await check.after('Remove');
      expect(removed.key).toBe('tl-b-name');
      await expect(section.locator('.tl-level')).toHaveCount(3);

      // A Settings row never runs off the side.
      const overflow = await section.locator('.tl-level').evaluateAll((rows) => rows.map((r) => r.scrollWidth - r.clientWidth));
      for (const o of overflow) expect(o).toBeLessThanOrEqual(0);
      expect(await page.locator('dialog.settings .settings-body').evaluate((b) => b.scrollWidth - b.clientWidth)).toBeLessThanOrEqual(0);

      // #49: picking another section and coming back (a click on its tab, the picker on a phone) moves nothing either.
      await check.ready(row('a'));
      await settingsSection(page, 'harness-models');
      await check.after('another section', false);
      await settingsSection(page, 'task-levels');
      await check.after('back to Task levels', false);
      clean();
    });

    test(`Settings → Task levels keeps the dialog in place: keyboard, ${theme}, ${size.name}`, async ({ page }) => {
      test.setTimeout(180_000);
      const clean = watchErrors(page);
      await setup(page, theme, size);
      const section = await openSettings(page);
      const check = settingsCheck(page);
      const key = (k: string) => section.locator(`[data-key="${k}"]`);
      /** Puts the keyboard on a control without scrolling anything, as Tab would have. */
      const focus = async (k: string) => {
        await check.ready(key(k));
        await key(k).evaluate((e) => (e as HTMLElement).focus({ preventScroll: true }));
      };

      // Arrow keys along a chip group: each one picks (and redraws the row).
      await focus('tl-a-harness:' + (await section.locator('[data-pick="tl-a-harness"] input').first().getAttribute('value')));
      await page.keyboard.press('Space');
      await check.after('Space on a harness chip');
      await page.keyboard.press('ArrowRight');
      await check.after('ArrowRight on the harness chips');
      await page.keyboard.press('Tab');
      await check.after('Tab into the model or effort chips');
      await page.keyboard.press('ArrowRight');
      await check.after('ArrowRight on the next chips');

      // The Default radios are one group: an arrow moves the mark.
      await focus('tl-a-default');
      await page.keyboard.press('ArrowDown');
      const moved = await check.after('ArrowDown on Default');
      expect(moved.key).toBe('tl-b-default');
      expect((await stored(page))?.default).toBe('b');

      // Buttons: Enter and Space.
      await focus('tl-c-up');
      await page.keyboard.press('Enter');
      await check.after('Enter on Move up');
      await page.keyboard.press('Enter');
      const top = await check.after('Enter on Move up again');
      // At the top: still focused, now off.
      expect(top.key).toBe('tl-c-up');
      await expect(key('tl-c-up')).toHaveAttribute('aria-disabled', 'true');
      await focus('tl-c-down');
      await page.keyboard.press('Space');
      await check.after('Space on Move down');
      await focus('tl-a-clear');
      await page.keyboard.press('Space');
      await check.after('Space on Clear');
      await focus('tl-add');
      await page.keyboard.press('Enter');
      await check.after('Enter on Add level');
      // Esc in a name field with nothing typed is the dialog's; typed, it reverts first.
      await page.keyboard.type('x');
      await page.keyboard.press('Escape');
      await check.after('Escape reverting a name');
      await expect(page.locator('dialog.settings')).toBeVisible();
      await page.keyboard.press('Tab');
      await check.after('Tab from the name');
      await focus('tl-b-remove');
      await page.keyboard.press('Enter');
      await check.after('Enter on Remove');

      // #49: the section list from the keyboard (wide only: a phone has the picker): Shift+Tab out of the body reaches the
      // selected tab, arrows move along the list and show each section, and the dialog stays put throughout.
      if (size.width >= 800) {
        await check.ready(key('tl-add'));
        const tab = page.locator('[role="tab"][data-tab="task-levels"]');
        await tab.focus();
        await page.keyboard.press('ArrowDown');
        await check.after('ArrowDown on the section list');
        await expect(page.locator('[role="tab"][aria-selected="true"]')).toBeFocused();
        await expect(section).toBeHidden();
        await page.keyboard.press('ArrowUp');
        await check.after('ArrowUp on the section list');
        await expect(tab).toBeFocused();
        await expect(section).toBeVisible();
        await page.keyboard.press('Tab');
        await check.after('Tab from the list into the section');
      }
      clean();
    });

    test(`the Hire dialog's chips keep the dialog in place: ${theme}, ${size.name}`, async ({ page }) => {
      test.setTimeout(150_000);
      const clean = watchErrors(page);
      await setup(page, theme, size);
      await page.evaluate(() => window.__h3d.enterFloor('pastry'));
      await frames(page, 3);
      await page.evaluate(() => window.__h3d.openHire(14));
      await expect.poll(() => page.evaluate(() => window.__h3d.dialog()?.kind === 'hire' && window.__h3d.dialog()?.state), { timeout: 10_000 }).toBe('ready');
      const D = 'dialog.desk-dlg--hire';
      const dlg = page.locator(D);
      const pick = async (group: string, what: string) => {
        const label = dlg.locator(`[data-pick="${group}"] label:not(:has(input:checked))`).first();
        await settle(page, D);
        // What scrolls the chips depends on the width (the options pane, or the whole form on a phone): scroll it as far
        // as the chip allows (the chip at its top), the hardest case for a radio placed outside it.
        const S = await label.evaluate((el) => {
          let sc = el.parentElement;
          while (sc && !(['auto', 'scroll'].includes(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight)) sc = sc.parentElement;
          if (!sc) return '.hire-options-pane';
          sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 8;
          return `.${sc.classList[0]}`;
        });
        const before = await geometry(page, D, S);
        expect(before.dialog).toBe(0);
        await clickAt(page, label);
        let g = await geometry(page, D, S);
        expect(g.dialog, `${what}: the dialog itself never scrolls`).toBe(0);
        expect(g.head, `${what}: the header stays`).toBe(before.head);
        expect(g.focusIn && g.focusShown, `${what}: the focus is usable (${g.key})`).toBe(true);
        await page.keyboard.press('ArrowRight');
        g = await geometry(page, D, S);
        expect(g.dialog, `${what} + ArrowRight: the dialog itself never scrolls`).toBe(0);
        expect(g.head, `${what} + ArrowRight: the header stays`).toBe(before.head);
      };
      await pick('effort', 'effort chip');
      await pick('harness', 'harness chip');
      await shot(page, `h40-hire-${theme}-${size.name}`);
      clean();
    });
  }
}
