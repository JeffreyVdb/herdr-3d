import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { frames, leftInTerminal, openGame, openMenu, seatMode, watchErrors } from './game';

// #213 on demo-m4 against the fixture bridge (`sim=1`, tools/fixture-interpret.ts): the dictation bar → `hire.interpret`
// → the review (#212) → Hire. The fixture's interpreter calls the LLM the game set up in Settings: a fake
// OpenAI-compatible server started here on an OS-leased loopback port, which answers the final result for each canned
// sentence (no spec reaches a real provider). Nothing but the review's Hire sends `worker.hire`.

const SIM = 'play=none&sim=1&simms=150&simusage=0';
const LLM_KEY = 'sk-test-llm-key-abcdef';

interface Fake {
  url: string;
  close(): Promise<void>;
}

type Field = { provenance: string; value?: string; said?: string };
interface Interp {
  sources: string[];
  harness: Field;
  model: Field;
  effort: Field;
  task: { provenance: string; value?: string; span?: { source: number; start: number; end: number } };
  questions: Array<{ field: string; text: string }>;
  ready_for_review: boolean;
}

/** Model words → the demo catalog's real launch ids (tools/fixture-sim.ts SIM_HIRE_OPTIONS, the snapshot's hire_options). */
const MODELS: Array<[string, string, string]> = [
  ['Sonnet 5.5', 'claude', 'claude-sonnet-5-5'],
  ['Opus 5.5', 'claude', 'claude-opus-5-5'],
  ['Fable 5.1', 'claude', 'claude-fable-5-1'],
  ['GPT-6 Luna', 'codex', 'gpt-6-luna'],
  ['GPT-6 Sol', 'codex', 'gpt-6-sol'],
];
const EFFORT_Q = 'What effort level should this agent use?';

/** The fake LLM's proposal for a hire sentence: the model and effort said before "Task:", the task all that follows it. */
function hireOf(cmd: string): Interp {
  const at = cmd.indexOf('Task: ');
  const head = at >= 0 ? cmd.slice(0, at) : cmd;
  const m = MODELS.find(([n]) => head.includes(n));
  const effort = /\b(low|medium|high|xhigh|max|ultra) effort\b/i.exec(head)?.[1]?.toLowerCase();
  const task = at >= 0 ? cmd.slice(at + 6) : '';
  const questions = [
    ...(m ? [] : [{ field: 'model', text: 'Which model should this agent use?' }]),
    ...(effort ? [] : [{ field: 'effort', text: EFFORT_Q }]),
    ...(task ? [] : [{ field: 'task', text: 'What should this agent work on?' }]),
  ];
  return {
    sources: [cmd],
    harness: m ? { provenance: 'resolved', value: m[1] } : { provenance: 'missing' },
    model: m ? { provenance: 'resolved', value: m[2] } : { provenance: 'missing' },
    effort: effort ? { provenance: 'dictated', value: effort } : { provenance: 'missing' },
    task: task ? { provenance: 'dictated', value: task, span: { source: 0, start: at + 6, end: cmd.length } } : { provenance: 'missing' },
    questions,
    ready_for_review: questions.length === 0,
  };
}

const UNSUPPORTED = [/^Open Settings/, /^Fire the idle agent/, /^Tell Sprout/, /two agents/];
const UNCLEAR = [/^Do not hire/, /^“Hire an agent,” she said/, /^What if I hired/, /^Yesterday I hired/];
const HIRE = /^(Spawn|Hire|Let) (an?|two) (agent|worker)/i;

/** The final result for one request, as the bridge would answer it. */
function decide(cmd: string, pending: Interp | null): unknown {
  if (/^(high|High effort, please\.)$/i.test(cmd.trim())) {
    // A reply fills the pending proposal's effort; with none it is unclear (it never makes a proposal by itself).
    if (!pending) return { intent: 'unclear' };
    const questions = pending.questions.filter((q) => q.field !== 'effort');
    return { intent: 'hire', hire: { ...pending, effort: { provenance: 'dictated', value: 'high' }, questions, ready_for_review: questions.length === 0 } };
  }
  if (UNSUPPORTED.some((re) => re.test(cmd))) return { intent: 'unsupported', ...(/two agents/.test(cmd) ? { reason: 'multiple' } : {}) };
  if (UNCLEAR.some((re) => re.test(cmd))) return { intent: 'unclear' };
  if (HIRE.test(cmd)) return { intent: 'hire', hire: hireOf(cmd) };
  return { intent: 'unclear' };
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => done(b));
  });
}

/** An OpenAI-compatible endpoint (JSON mode): the AI test's object, else `decide`'s result. FAIL answers 500, SLOW after 2.5 s. */
function fakeOpenAI(): Promise<Fake> {
  const server: Server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${LLM_KEY}`) return void res.writeHead(401).end('{"error":{"message":"bad key"}}');
    if (req.url === '/v1/models') return void res.end('{"object":"list","data":[{"id":"mimo-v2.6-flash"}]}');
    if (req.url !== '/v1/chat/completions') return void res.writeHead(404).end('{}');
    void body(req).then((b) => {
      if (b.includes('Reply with exactly this JSON')) return void res.end(JSON.stringify({ choices: [{ message: { content: '{"ok": true}' } }] }));
      const msgs = (JSON.parse(b) as { messages: Array<{ content: string }> }).messages;
      const user = JSON.parse(msgs.at(-1)?.content ?? '{}') as { command: string; pending_hire: Interp | null };
      if (user.command.includes('FAIL')) return void res.writeHead(500).end('{"error":{"message":"upstream exploded"}}');
      const answer = () => res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decide(user.command, user.pending_hire)) } }] }));
      if (user.command.includes('SLOW')) setTimeout(answer, 2500);
      else answer();
    });
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      done({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))) });
    });
  });
}

/** The LLM set up through Settings' AI integration (only the LLM: the interpreter needs no classifier). */
async function setUpLlm(page: Page, llm: Fake): Promise<void> {
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const box = dialog.getByRole('group', { name: /^LLM/ });
  await box.getByLabel('Base URL').fill(`${llm.url}/v1`);
  await box.getByLabel('API key').fill(LLM_KEY);
  await box.getByLabel('Model').fill('mimo-v2.6-flash');
  await box.getByRole('button', { name: 'Test' }).click();
  await expect(box).toContainText('Test passed');
  await box.getByRole('button', { name: 'Save' }).click();
  await expect(box.locator('.settings-badge')).toHaveText('Ready');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

const bar = (page: Page) => page.locator('dialog.dictation');
const field = (page: Page) => bar(page).locator('textarea');
const status = (page: Page) => bar(page).locator('.dict-status');
const sentOf = async (page: Page, t: string) => (await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === t);
const hires = (page: Page) => sentOf(page, 'worker.hire');
type Review = Extract<NonNullable<ReturnType<Window['__h3d']['dialog']>>, { kind: 'hire-review' }>;
const review = async (page: Page) => {
  const d = await page.evaluate(() => window.__h3d.dialog());
  return d?.kind === 'hire-review' ? (d as Review) : null;
};

async function openBar(page: Page): Promise<void> {
  await page.keyboard.press('Control+Shift+Space');
  await expect(bar(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
}

/** Puts `text` in the bar as dictation would (`paste`: a real Ctrl+V of the clipboard, as Wispr Flow does) and presses Enter. */
async function dictate(page: Page, text: string, how: 'fill' | 'paste' = 'fill'): Promise<void> {
  if (how === 'paste') {
    await field(page).fill('');
    await page.evaluate((t) => navigator.clipboard.writeText(t), text);
    await page.keyboard.press('ControlOrMeta+V');
  } else await field(page).fill(text);
  await expect(field(page)).toHaveValue(text);
  await field(page).press('Enter');
}

async function reviewReady(page: Page, session?: string): Promise<Review> {
  await expect.poll(async () => (await review(page))?.state, { timeout: 20_000 }).toBe('ready');
  const r = (await review(page)) as Review;
  if (session) expect(r.session).toBe(session);
  return r;
}

async function enterFloor(page: Page, session: string): Promise<void> {
  await page.evaluate((s) => window.__h3d.enterFloor(s), session);
  await frames(page, 3);
}

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
