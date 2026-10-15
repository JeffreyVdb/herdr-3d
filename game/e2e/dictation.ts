import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Page } from '@playwright/test';
import { frames, openMenu, settingsSection } from './game';

// #213, #214: the dictation bar's e2e helpers, shared by h213-dictation.spec.ts and the h214 specs. The fixture's
// interpreter (`sim=1`, tools/fixture-interpret.ts) calls the LLM the game set up in Settings: a fake OpenAI-compatible
// server each test starts on an OS-leased loopback port (`fakeOpenAI`, closed in the test's `finally`), which answers the
// final result for each canned sentence. No spec reaches a real provider.

export const LLM_KEY = 'sk-test-llm-key-abcdef';

export interface Fake {
  url: string;
  close(): Promise<void>;
}

type Field = { provenance: string; value?: string; said?: string };
export interface Interp {
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
export const EFFORT_Q = 'What effort level should this agent use?';

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
export function fakeOpenAI(): Promise<Fake> {
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
export async function setUpLlm(page: Page, llm: Fake): Promise<void> {
  await openMenu(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await settingsSection(page, 'ai');
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

export const bar = (page: Page) => page.locator('dialog.dictation');
export const field = (page: Page) => bar(page).locator('textarea');
export const status = (page: Page) => bar(page).locator('.dict-status');
export const sentOf = async (page: Page, t: string) => (await page.evaluate(() => window.__h3d.sent())).filter((c) => c.t === t);
export const hires = (page: Page) => sentOf(page, 'worker.hire');
export type Review = Extract<NonNullable<ReturnType<Window['__h3d']['dialog']>>, { kind: 'hire-review' }>;
export const review = async (page: Page) => {
  const d = await page.evaluate(() => window.__h3d.dialog());
  return d?.kind === 'hire-review' ? (d as Review) : null;
};

export async function openBar(page: Page): Promise<void> {
  await page.keyboard.press('Control+Shift+Space');
  await expect(bar(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
}

/** Puts `text` in the bar as dictation would (`paste`: a real Ctrl+V of the clipboard, as Wispr Flow does) and presses Enter. */
export async function dictate(page: Page, text: string, how: 'fill' | 'paste' = 'fill'): Promise<void> {
  if (how === 'paste') {
    await field(page).fill('');
    await page.evaluate((t) => navigator.clipboard.writeText(t), text);
    await page.keyboard.press('ControlOrMeta+V');
  } else await field(page).fill(text);
  await expect(field(page)).toHaveValue(text);
  await field(page).press('Enter');
}

export async function reviewReady(page: Page, session?: string): Promise<Review> {
  await expect.poll(async () => (await review(page))?.state, { timeout: 20_000 }).toBe('ready');
  const r = (await review(page)) as Review;
  if (session) expect(r.floor).toBe(session);
  return r;
}

export async function enterFloor(page: Page, session: string): Promise<void> {
  await page.evaluate((s) => window.__h3d.enterFloor(s), session);
  await frames(page, 3);
}

/** Waits until the client has the answer to the `n`th `hire.interpret` (0-based), and a few frames for it to be routed. */
export async function answered(page: Page, n: number): Promise<void> {
  await expect.poll(async () => (await sentOf(page, 'hire.interpret'))[n]?.result?.ok, { timeout: 20_000 }).toBe(true);
  await frames(page, 6);
}
