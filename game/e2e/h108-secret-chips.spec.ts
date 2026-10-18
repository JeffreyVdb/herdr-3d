import { expect, test } from '@playwright/test';
import { watchErrors } from './game';
import { boot, SURFACES } from './ui-surfaces';

// #108 round 4: a prompt sent with a protected value, in the conversation. Its reference to the file is a masked chip
// ("protected file" on the review's tape), its path on demand (the file popover, #31); a selection copied across it
// carries the reference as it was sent, never the tape's words.

const REF = /\[secret in file \/run\/user\/1000\/herdr-world\/secrets\/[A-Z2-7]{26}\/[A-Z2-7]{26}\]/;

test('a protected value’s reference is a chip in the conversation: its path in the file popover, the reference in a copy', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const s = SURFACES.find((x) => x.name === 'secret-chips')!;
  await boot(page, s.fixture, { ui: 'quiet' }, s.extra ?? '', s.wsQuery);
  await s.open(page);
  const msg = page.locator('.seat-transcript .tx-item.tx-user:not(.tx-pending) .tx-md', { has: page.locator('.secret-chip') }).last();
  const chip = msg.locator('.secret-chip');
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAccessibleName(/^Protected file: \/run\/user\/1000\/herdr-world\/secrets\//);
  // On screen: the tape's words, never the path or the value.
  const visible = await msg.evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll('.secret-chip-ref').forEach((x) => x.remove());
    return c.textContent?.trim();
  });
  expect(visible).toBe('Deploy with TOKEN=protected file now');
  expect(await page.content()).not.toContain('ghp_abcdefghijklmnopqrstu1');
  // A copy of the whole message: the reference as sent, in place.
  const copied = await msg.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    const t = sel.toString();
    sel.removeAllRanges();
    return t;
  });
  expect(copied.trim()).toMatch(new RegExp(`^Deploy with TOKEN=${REF.source} now$`));
  // A press opens the file popover with the path and "Copy file path".
  await chip.click();
  const pop = page.locator('.seat-transcript .tx-fref[role="dialog"]');
  await expect(pop).toBeVisible();
  await expect(pop.locator('.tx-fref-path')).toHaveText(/^\/run\/user\/1000\/herdr-world\/secrets\/[A-Z2-7]{26}\/[A-Z2-7]{26}$/);
  await expect(pop.locator('.tx-fref-copy')).toHaveText('Copy file path');
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  clean();
});
