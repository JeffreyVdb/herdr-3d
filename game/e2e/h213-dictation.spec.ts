import { expect, test } from '@playwright/test';
import { frames, leftInTerminal, openGame, openMenu, seatMode, watchErrors } from './game';
import { answered, bar, dictate, enterFloor, fakeOpenAI, field, hires, openBar, review, reviewReady, sentOf, setUpLlm, status, type Review } from './dictation';

// #213 on demo-m4 against the fixture bridge (`sim=1`, tools/fixture-interpret.ts): the dictation bar → `hire.interpret`
// → the review (#212) → Hire. The fixture's interpreter calls the LLM the game set up in Settings: a fake
// OpenAI-compatible server each test starts on an OS-leased loopback port (e2e/dictation.ts), which answers the final
// result for each canned sentence (no spec reaches a real provider). Nothing but the review's Hire sends `worker.hire`.

const SIM = 'play=none&sim=1&simms=150&simusage=0';

test('each of the five phrases, filled or pasted: the populated review first, then exactly one hire with the reviewed tuple', async ({ page, context }) => {
  test.setTimeout(240_000);
  const clean = watchErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const llm = await fakeOpenAI();
  try {
    await openGame(page, 'demo-m4', '', SIM);
    await setUpLlm(page, llm);
    const cases = [
      { floor: 'scratchpad', how: 'paste', text: 'Spawn an agent. Use Sonnet 5.5 with high effort. Task: fix the login bug.', tuple: ['claude', 'claude-sonnet-5-5', 'high'], task: 'fix the login bug.' },
      { floor: 'scratchpad', how: 'fill', text: 'Hire an agent on GPT-6 Luna with medium effort. Task: write the release notes for 0.9.', tuple: ['codex', 'gpt-6-luna', 'medium'], task: 'write the release notes for 0.9.' },
      { floor: 'scratchpad', how: 'paste', text: 'Let an agent research this for me. Opus 5.5, xhigh effort. Task: find out why the elevator\nqueues riders twice.', tuple: ['claude', 'claude-opus-5-5', 'xhigh'], task: 'find out why the elevator\nqueues riders twice.' },
      { floor: 'pastry', how: 'fill', text: 'Hire a worker with GPT-6 Sol at ultra effort. Task: profile the city renderer.', tuple: ['codex', 'gpt-6-sol', 'ultra'], task: 'profile the city renderer.' },
      { floor: 'pastry', how: 'paste', text: 'Spawn a worker on Fable 5.1, low effort. Task: tidy the CSS tokens.', tuple: ['claude', 'claude-fable-5-1', 'low'], task: 'tidy the CSS tokens.' },
    ] as const;
    for (const [i, c] of cases.entries()) {
      if ((await page.evaluate(() => window.__h3d.pose()?.floor)) !== c.floor) await enterFloor(page, c.floor);
      await openBar(page);
      await dictate(page, c.text, c.how);
      // Fully specified, it still opens the review first: nothing is hired yet.
      const r = await reviewReady(page, c.floor);
      await expect(bar(page)).toBeHidden();
      expect([r.choice.harness, r.choice.model, r.choice.effort], c.text).toEqual([...c.tuple]);
      expect(r.choice.task).toBe(c.task);
      expect(r.sections.filter((s) => s.open).map((s) => s.id), c.text).toEqual([]);
      expect(r.blocker).toBeNull();
      expect(await hires(page)).toHaveLength(i);
      await page.locator('.desk-dlg--review [data-key="hire"]').click();
      await expect.poll(async () => (await hires(page)).length).toBe(i + 1);
      const sent = (await hires(page))[i] as { args: Record<string, unknown> };
      expect(sent.args).toMatchObject({ session: c.floor, harness: c.tuple[0], model: c.tuple[1], effort: c.tuple[2], prompt: c.task });
      // The hire lands and the review goes.
      await expect.poll(() => review(page), { timeout: 30_000 }).toBeNull();
    }
    expect(await hires(page)).toHaveLength(5);
    // The bar never sent one: every hire.interpret is followed by exactly the reviewed Hire.
    expect(await sentOf(page, 'hire.interpret')).toHaveLength(5);
  } finally {
    await llm.close();
  }
  clean();
});

test('a missing effort opens Effort; “high” dictated over the open review fills it, sends its proposal as pending and hires nothing; Cancel drops it', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const llm = await fakeOpenAI();
  try {
    await openGame(page, 'demo-m4', '', SIM);
    await setUpLlm(page, llm);
    // With no review open, a bare effort is unclear.
    await enterFloor(page, 'pastry');
    await openBar(page);
    await dictate(page, 'high');
    await expect(status(page)).toHaveText('Your intent is unclear.');
    expect(((await sentOf(page, 'hire.interpret'))[0]?.args as { pending?: unknown }).pending).toBeUndefined();
    await field(page).fill('');
    await dictate(page, 'Hire an agent on Sonnet 5.5. Task: fix the flaky elevator test.');
    let r = await reviewReady(page, 'pastry');
    expect(r.sections.map((s) => [s.id, s.open])).toEqual([['agent', false], ['effort', true], ['task', false], ['where', false]]);
    expect(r.choice.effort).toBe('');
    expect(r.blocker).not.toBeNull();
    // The chord reaches the game over the review; the bar opens on top of it.
    await openBar(page);
    await dictate(page, 'high');
    await expect(bar(page)).toBeHidden();
    await expect.poll(async () => (await review(page))?.choice.effort).toBe('high');
    r = (await review(page)) as Review;
    expect(r.choice.task).toBe('fix the flaky elevator test.');
    expect(r.blocker).toBeNull();
    // The keyboard is the review's again.
    expect(await page.evaluate(() => !!document.activeElement?.closest('.desk-dlg--review'))).toBe(true);
    const follow = (await sentOf(page, 'hire.interpret')).at(-1)?.args as { text: string; pending?: { sources: string[] } };
    expect(follow.text).toBe('high');
    expect(follow.pending?.sources).toEqual(['Hire an agent on Sonnet 5.5. Task: fix the flaky elevator test.']);
    expect(await hires(page)).toHaveLength(0);
    // Cancel discards the pending proposal: the next "high" goes without one, and is unclear.
    await page.keyboard.press('Escape');
    await expect.poll(() => review(page)).toBeNull();
    await openBar(page);
    await dictate(page, 'High effort, please.');
    await expect(status(page)).toHaveText('Your intent is unclear.');
    expect(((await sentOf(page, 'hire.interpret')).at(-1)?.args as { pending?: unknown }).pending).toBeUndefined();
    expect(await hires(page)).toHaveLength(0);
  } finally {
    await llm.close();
  }
  clean();
});

test('unsupported, unclear, negated, quoted, hypothetical and existing-worker phrases each say so, keep the text and hire nobody', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const llm = await fakeOpenAI();
  try {
    await openGame(page, 'demo-m4', '', SIM);
    await setUpLlm(page, llm);
    await openBar(page);
    const cases: Array<[string, string]> = [
      ['Open Settings.', 'Not supported yet.'],
      ['Fire the idle agent at desk three.', 'Not supported yet.'],
      ['Tell Sprout to fix the tests.', 'Not supported yet.'],
      ['Hire two agents and open the elevator.', 'Not supported yet.'],
      ['Do not hire an agent for the login bug.', 'Your intent is unclear.'],
      ['“Hire an agent,” she said, laughing.', 'Your intent is unclear.'],
      ['What if I hired an agent to fix the build?', 'Your intent is unclear.'],
      ['Yesterday I hired an agent to fix the build.', 'Your intent is unclear.'],
    ];
    for (const [i, [text, line]] of cases.entries()) {
      await dictate(page, text);
      await expect(status(page)).toHaveText(line);
      await expect.poll(async () => (await sentOf(page, 'hire.interpret')).length).toBe(i + 1);
      await expect(field(page)).toHaveValue(text);
      expect(await review(page)).toBeNull();
    }
    expect(await sentOf(page, 'hire.prepare')).toHaveLength(0);
    expect(await hires(page)).toHaveLength(0);
  } finally {
    await llm.close();
  }
  clean();
});

test('provider errors and timeouts keep the text and hire nobody; Enter while one is pending sends nothing more; no LLM is not_ready', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  const llm = await fakeOpenAI();
  try {
    await openGame(page, 'demo-m4', '', SIM);
    await enterFloor(page, 'pastry');
    // No LLM set up yet: the bridge says so, nothing is called.
    await openBar(page);
    await dictate(page, 'Hire an agent. Task: fix the login bug.');
    await expect(status(page)).toHaveText(/^No AI model is ready to read commands/);
    await expect(status(page)).toHaveAttribute('data-tone', 'error');
    await page.keyboard.press('Escape');
    await setUpLlm(page, llm);
    expect(await page.evaluate(() => window.__h3d.simInterpret({ timeout_ms: 2000 }))).toEqual({ ok: true });
    await openBar(page);
    // The provider fails (HTTP 500).
    await dictate(page, 'Hire an agent. FAIL Task: fix the login bug.');
    await expect(status(page)).toHaveText('The AI provider failed. Press Enter to try again.');
    await expect(field(page)).toHaveValue('Hire an agent. FAIL Task: fix the login bug.');
    // Too slow: a timeout. Enter again and again while it is on its way: still one request.
    const before = (await sentOf(page, 'hire.interpret')).length;
    await dictate(page, 'Hire an agent. SLOW Task: fix the login bug.');
    await expect.poll(() => page.evaluate(() => window.__h3d.dictation()?.state)).toBe('pending');
    await field(page).press('Enter');
    await field(page).press('Enter');
    // (Send says it is busy, aria-disabled: Playwright would wait for it; a person's click does not.)
    await bar(page).locator('.dict-send').click({ force: true });
    // The box is never disabled while it waits: more dictation lands in it.
    await expect(field(page)).toBeEditable();
    await expect(status(page)).toHaveText('The AI model did not answer in time. Press Enter to try again.');
    expect((await sentOf(page, 'hire.interpret')).length).toBe(before + 1);
    await expect(field(page)).toHaveValue('Hire an agent. SLOW Task: fix the login bug.');
    expect(await review(page)).toBeNull();
    expect(await hires(page)).toHaveLength(0);
  } finally {
    await llm.close();
  }
  clean();
});

test('an answer for a bar that was closed is no one’s: it opens no review, closes no bar and keeps the new draft', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const llm = await fakeOpenAI();
  try {
    await openGame(page, 'demo-m4', '', SIM);
    await setUpLlm(page, llm);
    await enterFloor(page, 'pastry');
    // Esc while it is on its way, the bar opened again and a new command typed (not sent): the old answer changes nothing.
    await openBar(page);
    await dictate(page, 'Hire an agent on Sonnet 5.5 with high effort. SLOW Task: stale dismissed request.');
    await expect.poll(() => page.evaluate(() => window.__h3d.dictation()?.state)).toBe('pending');
    await page.keyboard.press('Escape');
    await expect(bar(page)).toBeHidden();
    await openBar(page);
    await field(page).fill('Open Settings.');
    await answered(page, 0);
    await expect(bar(page)).toBeVisible();
    await expect(field(page)).toHaveValue('Open Settings.');
    await expect(field(page)).toBeFocused();
    expect(await page.evaluate(() => window.__h3d.dictation())).toMatchObject({ state: 'editing', status: '' });
    expect(await review(page)).toBeNull();
    expect(await sentOf(page, 'hire.prepare')).toHaveLength(0);
    expect(await hires(page)).toHaveLength(0);
    await page.keyboard.press('Escape');
    // Esc while it is on its way and the bar left closed: still no review.
    await openBar(page);
    await dictate(page, 'Hire an agent on Sonnet 5.5 with high effort. SLOW Task: another dismissed request.');
    await expect.poll(() => page.evaluate(() => window.__h3d.dictation()?.state)).toBe('pending');
    await page.keyboard.press('Escape');
    await expect(bar(page)).toBeHidden();
    await answered(page, 1);
    await expect(bar(page)).toBeHidden();
    expect(await review(page)).toBeNull();
    expect(await page.evaluate(() => window.__h3d.dialog())).toBeNull();
    expect(await sentOf(page, 'hire.prepare')).toHaveLength(0);
    expect(await hires(page)).toHaveLength(0);
  } finally {
    await llm.close();
  }
  clean();
});

test('no floor in context: an answer after Esc asks nothing; Esc while it asks which floor closes the bar and gives the keyboard back', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const llm = await fakeOpenAI();
  try {
    await openGame(page, 'demo-m4', '', SIM);
    await setUpLlm(page, llm);
    expect(await page.evaluate(() => window.__h3d.pose()?.floor ?? null)).toBeNull();
    const opener = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 60) ?? null);
    // A hire whose answer comes after Esc: no floor question, no bar, no review.
    await openBar(page);
    await dictate(page, 'Hire an agent on Sonnet 5.5 with high effort. SLOW Task: fix the login bug.');
    await expect.poll(() => page.evaluate(() => window.__h3d.dictation()?.state)).toBe('pending');
    await page.keyboard.press('Escape');
    await answered(page, 0);
    await expect(bar(page)).toBeHidden();
    expect(await review(page)).toBeNull();
    // The floor question: Esc closes the bar, as everywhere else, and the keyboard goes back where it was.
    await openBar(page);
    await dictate(page, 'Hire an agent on Sonnet 5.5 with high effort. Task: fix the login bug.');
    await expect.poll(() => page.evaluate(() => window.__h3d.dictation()?.state)).toBe('floor');
    await page.keyboard.press('Escape');
    await expect(bar(page)).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.activeElement?.outerHTML.slice(0, 60) ?? null)).toBe(opener);
    // Opened again, it starts empty, as after any Esc.
    await openBar(page);
    await expect(field(page)).toHaveValue('');
    expect(await page.evaluate(() => window.__h3d.dictation()?.state)).toBe('editing');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.__h3d.pose()?.floor ?? null)).toBeNull();
    expect(await review(page)).toBeNull();
    expect(await sentOf(page, 'hire.prepare')).toHaveLength(0);
    expect(await hires(page)).toHaveLength(0);
  } finally {
    await llm.close();
  }
  clean();
});

test('no floor in context asks which; an asleep floor is refused with the hire’s own message; another opens the review there', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  const llm = await fakeOpenAI();
  try {
    await openGame(page, 'demo-m4', '', SIM);
    await setUpLlm(page, llm);
    expect(await page.evaluate(() => window.__h3d.pose()?.floor ?? null)).toBeNull();
    // The mouse's way in: the Menu's row.
    await openMenu(page);
    await page.getByRole('button', { name: /^Dictate a command/ }).click();
    await expect(bar(page)).toBeVisible();
    await expect(field(page)).toBeFocused();
    await dictate(page, 'Hire an agent on Sonnet 5.5 with high effort. Task: fix the login bug.');
    await expect.poll(() => page.evaluate(() => window.__h3d.dictation()?.state)).toBe('floor');
    await expect(bar(page).locator('.dict-question')).toHaveText('Hire on which floor?');
    const floors = (await page.evaluate(() => window.__h3d.dictation()))?.floors.map((f) => f.session) ?? [];
    expect(floors).toEqual(expect.arrayContaining(['pastry', 'depot-manager', 'herdr-3d', 'scratchpad']));
    // Keyboard: ↓ to the asleep floor, Enter: refused, the text and the list stay.
    const active = async () => (await page.evaluate(() => window.__h3d.dictation()))?.floors.find((f) => f.active)?.session;
    for (let i = 0; i < floors.length && (await active()) !== 'depot-manager'; i++) await field(page).press('ArrowDown');
    expect(await active()).toBe('depot-manager');
    await field(page).press('Enter');
    await expect(status(page)).toHaveText('depot-manager is asleep. Wake it from the elevator (L) to hire.');
    expect(await page.evaluate(() => window.__h3d.dictation()?.state)).toBe('floor');
    expect(await sentOf(page, 'hire.prepare')).toHaveLength(0);
    // A floor that can take the hire: the bar goes, the elevator takes you there, and the review opens at its first free desk.
    await bar(page).locator('[data-session="pastry"]').click();
    await expect(bar(page)).toBeHidden();
    const r = await reviewReady(page, 'pastry');
    expect(await page.evaluate(() => window.__h3d.pose()?.floor)).toBe('pastry');
    expect([r.choice.harness, r.choice.model, r.choice.effort]).toEqual(['claude', 'claude-sonnet-5-5', 'high']);
    expect(await hires(page)).toHaveLength(0);
    expect(await sentOf(page, 'hire.interpret')).toHaveLength(1);
  } finally {
    await llm.close();
  }
  clean();
});

test('input: IME Enter does not send, Shift+Enter keeps its line, held movement is let go on open, and the keyboard goes back on close', async ({ page }) => {
  test.setTimeout(120_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  await enterFloor(page, 'pastry');
  // Walking with S held: the chord lets go of it (the bar has the keyboard) and nothing moves after.
  const start = await page.evaluate(() => window.__h3d.pose());
  await page.keyboard.down('KeyS');
  await frames(page, 6);
  const walking = await page.evaluate(() => window.__h3d.pose());
  expect(Math.hypot((walking?.x ?? 0) - (start?.x ?? 0), (walking?.z ?? 0) - (start?.z ?? 0))).toBeGreaterThan(0.01);
  const opener = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 60) ?? null);
  await openBar(page);
  const held = await page.evaluate(() => window.__h3d.pose());
  await frames(page, 15);
  const after = await page.evaluate(() => window.__h3d.pose());
  expect([after?.x, after?.z]).toEqual([held?.x, held?.z]);
  // Letters typed in the bar are its own: no walking, no shortcut.
  await page.keyboard.type('Hire an agent. Task: line one');
  await page.keyboard.up('KeyS');
  await frames(page, 6);
  expect([(await page.evaluate(() => window.__h3d.pose()))?.x, (await page.evaluate(() => window.__h3d.pose()))?.z]).toEqual([held?.x, held?.z]);
  // Shift+Enter is a new line, not a send.
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('line two');
  await expect(field(page)).toHaveValue('Hire an agent. Task: line one\nline two');
  // An IME composing: its Enter (isComposing, and Safari's keyCode 229 after compositionend) sends nothing.
  await field(page).evaluate((el) => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    const safari = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(safari, 'keyCode', { value: 229 });
    el.dispatchEvent(safari);
  });
  await frames(page, 3);
  expect(await sentOf(page, 'hire.interpret')).toHaveLength(0);
  await expect(field(page)).toHaveValue('Hire an agent. Task: line one\nline two');
  // Esc closes it; the keyboard goes back where it was.
  await page.keyboard.press('Escape');
  await expect(bar(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.activeElement?.outerHTML.slice(0, 60) ?? null)).toBe(opener);
  // The chord again closes it too.
  await openBar(page);
  await page.keyboard.press('Control+Shift+Space');
  await expect(bar(page)).toBeHidden();
  clean();
});

test('the bar opens from the city, a floor, the seated terminal and the conversation; the pane never gets the chord', async ({ page }) => {
  test.setTimeout(150_000);
  const clean = watchErrors(page);
  await openGame(page, 'demo-m4', '', SIM);
  // The city.
  await openBar(page);
  await page.keyboard.press('Escape');
  await expect(bar(page)).toBeHidden();
  // A floor.
  await enterFloor(page, 'herdr-3d');
  await openBar(page);
  await page.keyboard.press('Escape');
  // Seated at Sprout's laptop, the terminal's input focused.
  const L = await page.evaluate(() => window.__h3d.layout('herdr-3d'));
  const sprout = (await page.evaluate(() => window.__h3d.world())).find((f) => f.session === 'herdr-3d')?.workers.find((x) => x.name === 'Sprout');
  if (!L || !sprout) throw new Error('no floor or worker');
  await leftInTerminal(page, sprout.id);
  const s = L.slots[sprout.desk];
  if (!s) throw new Error('no desk');
  const p = await page.evaluate(() => window.__h3d.pose());
  const [x, z] = [s.seat.x - Math.sin(s.yaw) * 1.4, s.seat.z - Math.cos(s.yaw) * 1.4];
  const yaw = Math.atan2(-(s.seat.x - x), -(s.seat.z - z));
  const pitch = Math.atan2(0.95 - (p?.eye ?? 1.6), Math.hypot(s.seat.x - x, s.seat.z - z));
  await page.evaluate(([yy, pp, xx, zz]) => window.__h3d.setPose({ x: xx, z: zz, yaw: yy, pitch: pp }), [yaw, pitch, x, z] as const);
  await frames(page, 2);
  expect(await page.evaluate((id) => window.__h3d.sitAt(id), sprout.id)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__h3d.seat().mode)).toBe('terminal');
  await expect(page.locator('.seat-input')).toBeFocused();
  await page.keyboard.type('ls');
  await openBar(page);
  await page.keyboard.type('x');
  await page.keyboard.press('Escape');
  await expect(bar(page)).toBeHidden();
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(sprout.id);
  await expect(page.locator('.seat-input')).toBeFocused();
  // Nothing of the chord, nor what was typed in the bar, reached the pane.
  await page.keyboard.type('y');
  await expect
    .poll(async () =>
      (await sentOf(page, 'worker.keys'))
        .flatMap((c) => (c.args as { input: Array<{ text?: string; key?: string }> }).input)
        .map((k) => k.text ?? `<${k.key}>`)
        .join(''),
    )
    .toBe('lsy');
  // The conversation.
  await seatMode(page, 'transcript');
  await expect(page.locator('.seat-transcript')).toBeVisible();
  await page.locator('.seat-transcript .tx-scroll').focus();
  await openBar(page);
  await page.keyboard.press('Escape');
  await expect(bar(page)).toBeHidden();
  expect(await page.evaluate(() => window.__h3d.seated())).toBe(sprout.id);
  await expect(page.locator('.seat-transcript .tx-scroll')).toBeFocused();
  clean();
});
