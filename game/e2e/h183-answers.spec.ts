import { expect, test, type Page } from '@playwright/test';
import { frames, openGame, shot, watchErrors } from './game';

// #183: your answer to a Codex async question in the conversation, for real, on the WebGL2 path: the simulating fixture
// server (sim=1) at Tofu's seat, with answer items pushed through `simTranscript` in the bridge's shape (`answers`, and
// `parts` holding the native envelope). A readable entry in your bubble, no envelope syntax or ids, wrapping at a narrow
// window and at 200% text zoom (nothing overlaps, nothing scrolls sideways), and the raw reply collapsed behind its summary.

const FLOOR = 'herdr-3d';
const SIM = 'play=none&sim=1&simms=500&simusage=0';

const ENVELOPE = (q: string, a: string) =>
  `<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call_9\\",0]","question":${JSON.stringify(q)},"answer":${JSON.stringify(a)}}]\n</send_user_message_question_reply>`;

async function sitAt(page: Page, name: string): Promise<void> {
  await openGame(page, 'demo-m5', '&prints=0', SIM);
  await page.evaluate((s) => window.__h3d.enterFloor(s), FLOOR);
  await frames(page, 3);
  const id = await page.evaluate((n) => window.__h3d.world().flatMap((f) => f.workers).find((w) => w.name === n)?.id ?? '', name);
  expect(await page.evaluate((i) => window.__h3d.face(i), id), `facing ${name}`).toBe(true);
  await frames(page, 3);
  expect(await page.evaluate((w) => window.__h3d.sitAt(w), id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seated())).toBe(id);
  await frames(page, 30);
}

test('#183: an async answer reads as a question and its answer, wraps at a narrow window and 200%, keeps the raw reply collapsed', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await page.setViewportSize({ width: 800, height: 640 });
  await sitAt(page, 'Tofu');
  await expect.poll(() => page.evaluate(() => window.__h3d.transcript()?.mounted)).toBe(true);
  const tx = page.locator('.seat-transcript .tx');
  await expect(tx.locator('.tx-user').first()).toBeVisible();

  const q1 = 'Which board should receive the Shift Plan template ticket? I found two DevOps boards in Monday, and the app also has GitHub issues.';
  const a1 = 'GitHub: Fomra/shift-plan';
  const q2 = 'Any context for the fixture?';
  const a2 = `First line, "quoted" <b>not bold</b> **not bold either** naïve 日本語\nsecond line https://example.com/${'long-path-segment/'.repeat(8)}end`;
  await page.evaluate(
    ([e1, e2, ...rest]) =>
      window.__h3d.simTranscript({
        id: window.__h3d.seated(),
        items: [
          { id: 'h183-one', seq: 91, ts: Date.now(), kind: 'user', parts: [{ text: e1 as string }], answers: [{ question: rest[0] as string, answer: rest[1] as string }] },
          { id: 'h183-two', seq: 92, ts: Date.now(), kind: 'user', parts: [{ text: e2 as string }], answers: [{ question: rest[0] as string, answer: rest[1] as string }, { question: rest[2] as string, answer: rest[3] as string }] },
        ],
      }),
    [ENVELOPE(q1, a1), ENVELOPE(q2, a2), q1, a1, q2, a2],
  );
  const one = tx.locator('[data-id="h183-one"]');
  const two = tx.locator('[data-id="h183-two"]');
  await one.scrollIntoViewIfNeeded();
  await expect(one.locator('.tx-ans-label')).toHaveText('Your answer');
  await expect(one.locator('.tx-ans-q')).toHaveText(q1);
  await expect(one.locator('.tx-ans-a')).toHaveText(a1);
  await expect(two.locator('.tx-ans-pair')).toHaveCount(2);
  await expect(two.locator('.tx-ans-a').nth(1)).toHaveText(a2);
  await expect(tx.locator('.tx-ans b, .tx-ans strong')).toHaveCount(0);
  // Default view: no envelope syntax or ids (the raw reply is in a closed <details>).
  for (const row of [one, two]) {
    const shown = await row.evaluate((r) => {
      const c = r.cloneNode(true) as HTMLElement;
      c.querySelectorAll('details').forEach((d) => d.remove());
      return c.innerText;
    });
    expect(shown).not.toMatch(/send_user_message_question_reply|questionItemId|request_user_input_async|call_9/);
    expect(await row.locator('details').evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
  }
  await expect(one.locator('details summary')).toHaveText('Raw reply');

  // The label and the disclosure are secondary but readable: WCAG AA (4.5:1) on the bubble they sit in.
  const contrast = (row: typeof one, sel: string) =>
    row.evaluate((r, selector) => {
      const lum = (c: string) => {
        const [R, G, B] = (c.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map((v) => {
          const x = Number(v) / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        }) as [number, number, number];
        return 0.2126 * R + 0.7152 * G + 0.0722 * B;
      };
      const fg = lum(getComputedStyle(r.querySelector(selector) as HTMLElement).color);
      const bg = lum(getComputedStyle(r.querySelector('.tx-bubble') as HTMLElement).backgroundColor);
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    }, sel);
  expect(await contrast(one, '.tx-ans-label')).toBeGreaterThanOrEqual(4.5);
  expect(await contrast(one, '.tx-ans-raw summary')).toBeGreaterThanOrEqual(4.5);

  const layout = (z: number) =>
    tx.evaluate((root, zoom) => {
      const scroller = root.querySelector('.tx-scroll') as HTMLElement;
      const sr = scroller.getBoundingClientRect();
      const rows = [...root.querySelectorAll<HTMLElement>('[data-id^="h183-"]')];
      return {
        zoom,
        sideways: scroller.scrollWidth - scroller.clientWidth,
        inside: rows.every((r) => {
          const b = (r.querySelector('.tx-bubble') as HTMLElement).getBoundingClientRect();
          return b.left >= sr.left - 0.5 && b.right <= sr.right + 0.5;
        }),
        clipped: rows.some((r) => [...r.querySelectorAll<HTMLElement>('.tx-ans-q, .tx-ans-a')].some((e) => e.scrollWidth > e.clientWidth + 1)),
      };
    }, z);
  expect(await layout(100)).toEqual({ zoom: 100, sideways: 0, inside: true, clipped: false });
  await frames(page, 4);
  await shot(page, 'h183-answers-100');

  await tx.locator('.tx-scroll').focus();
  for (let i = 0; i < 12 && (await tx.locator('.tx-zoom-level').textContent()) !== '200%'; i++) await page.keyboard.press('Control+=');
  await expect(tx.locator('.tx-zoom-level')).toHaveText('200%');
  await two.scrollIntoViewIfNeeded();
  expect(await layout(200)).toEqual({ zoom: 200, sideways: 0, inside: true, clipped: false });
  await frames(page, 4);
  await shot(page, 'h183-answers-200');

  // The raw reply opens on a click and carries the envelope.
  await two.locator('details summary').click();
  await expect(two.locator('details pre')).toContainText('send_user_message_question_reply');
  clean();
});
