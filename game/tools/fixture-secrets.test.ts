import { afterEach, describe, expect, it } from 'vitest';
import { loadFixture } from './fixture-server.ts';
import { SimWorld, type SimOptions } from './fixture-sim.ts';
import { SIM_CODEX_THREAD, SIM_CODEX_WORKER } from './fixture-codex-questions.ts';
import { SIM_BUILD_TEAM } from './fixture-start.ts';
import { detect, ownerDir, SECRETS_DIR, SecretsSim } from './fixture-secrets.ts';

// #108: the fixture's prompt secrets: the switch, the fake detector's scan, worker.prompt's review gate, and (round 2)
// every other route's, with round 5's revoke, `Worker.secret_files` and the wrap-up's hand-over.

type Msg = Record<string, unknown>;
const worlds: SimWorld[] = [];
afterEach(() => worlds.splice(0).forEach((w) => w.dispose()));

function world(o: Partial<SimOptions> = {}) {
  const rec = loadFixture('demo-m5');
  const w = new SimWorld(rec.snapshot, { stepMs: 20, usageMs: 0, ...o });
  worlds.push(w);
  const heard: Msg[] = [];
  /** Everything every command was answered with, events included, in order. */
  const log: Msg[] = [];
  w.start((m) => heard.push(m as Msg));
  let n = 0;
  const run = (t: string, args: Msg = {}) => {
    const out: Msg[] = [];
    w.handle({ t, req_id: `r${++n}`, args }, (m) => (out.push(m as Msg), log.push(m as Msg)));
    return out;
  };
  /** The command's answer, once it came (a prompt to an idle worker answers a step later). */
  const answer = async (t: string, args: Msg = {}) => {
    const out: Msg[] = [];
    w.handle({ t, req_id: `r${++n}`, args }, (m) => (out.push(m as Msg), log.push(m as Msg)));
    for (let i = 0; i < 50 && !out.some((m) => m.t === 'ack' || m.t === 'error'); i++) await new Promise((r) => setTimeout(r, 10));
    return out.find((m) => m.t === 'ack' || m.t === 'error') as Msg;
  };
  const snap = w.snapshot() as { world: { workers: { id: string; name: string; status: string }[]; prompt_secrets?: unknown } };
  const id = (name: string) => snap.world.workers.find((x) => x.name === name)?.id as string;
  return { w, run, answer, id, heard, log, snap };
}

const TEXT = 'deploy with TOKEN=ghp_abcdefghijklmnopqrstu1 and PASSWORD="hunt😀r2"; the password is s3cr3t!x then ghp_abcdefghijklmnopqrstu1 and hunt😀r2';

describe('the fixture’s fake detector (#108)', () => {
  it('finds assignments, a GitHub token, prose and repeats, in UTF-16 code units, apart, in order', () => {
    const c = detect(TEXT);
    expect(c.map((x) => [x.id, TEXT.slice(x.start, x.end), x.kinds])).toEqual([
      ['c1', 'ghp_abcdefghijklmnopqrstu1', ['gitleaks:github-pat', 'assignment']],
      ['c2', 'hunt😀r2', ['assignment']],
      ['c3', 's3cr3t!x', ['prose']],
      ['c4', 'ghp_abcdefghijklmnopqrstu1', ['gitleaks:github-pat']],
      ['c5', 'hunt😀r2', ['repeat']],
    ]);
  });

  it('leaves templates, references and names without a value alone; says when a value is encoded', () => {
    expect(detect('TOKEN=$GITHUB_TOKEN api_key=${KEY} pw: <your-password> max_tokens=5 [secret in file /x/y]')).toEqual([]);
    // #117: a redaction is no value (the bridge's `notASecret`), in an assignment too: the check's text for a protected task.
    expect(detect('TOKEN=[redacted] and PASSWORD=[redacted] the password is [redacted]')).toEqual([]);
    expect(detect('DB_PASSWORD=p%40ss')).toEqual([{ id: 'c1', start: 12, end: 18, kinds: ['assignment'], encoded: true }]);
  });
});

describe('the fixture’s fake detector and the bridge’s own references (#108 round 4)', () => {
  const ref = `[secret in file ${SECRETS_DIR}/${'A'.repeat(26)}/${'B2'.repeat(13)}]`;

  it('never proposes one: not the value it is, not a value glued to it, not a repeat of its bytes', () => {
    expect(detect(`TOKEN=${ref} and PASSWORD="${ref}" and api_key=${ref}x`)).toEqual([]);
    // Its follow-ups scan clean (a pack-up's task, an interpreted task), whatever else they hold.
    expect(detect(`Deploy with TOKEN=${ref}, then again with ${ref}`)).toEqual([]);
    const t = `password=hunter22 and ${ref} and hunter22`;
    expect(detect(t).map((c) => [t.slice(c.start, c.end), c.kinds])).toEqual([
      ['hunter22', ['assignment']],
      ['hunter22', ['repeat']],
    ]);
  });

  it('text that only looks like one is read as any other (another directory, a short name, no closing bracket)', () => {
    for (const look of [`[secret in file /tmp/${'A'.repeat(26)}/${'B'.repeat(26)}]`, `[secret in file ${SECRETS_DIR}/ABC/${'B'.repeat(26)}]`, `[secret in file ${SECRETS_DIR}/${'A'.repeat(26)}/${'B'.repeat(26)}`]) {
      expect(detect(`TOKEN=${look}`).length, look).toBe(1);
    }
  });
});

describe('the fixture’s prompt secrets (#108)', () => {
  it('the switch: off by default, set, shared by a key, absent on an older bridge', () => {
    const a = world({ secrets: 'k1' });
    const b = world({ secrets: 'k1' });
    // Round 5's `dir` (the files' directory) is there while one is available.
    expect(a.snap.world.prompt_secrets).toEqual({ enabled: false, available: true, dir: SECRETS_DIR });
    const out = a.run('prompt_secrets.set', { enabled: true });
    expect(out[0]).toMatchObject({ t: 'prompt_secrets.update', enabled: true, available: true });
    expect(out.at(-1)).toMatchObject({ t: 'ack', data: { enabled: true, available: true } });
    expect(b.heard.filter((m) => m.t === 'prompt_secrets.update')).toEqual([{ t: 'prompt_secrets.update', enabled: true, available: true, dir: SECRETS_DIR, seq: expect.any(Number) }]);
    expect(b.run('prompt_secrets.get').at(-1)).toMatchObject({ data: { enabled: true } });
    expect(a.run('prompt_secrets.set', {}).at(-1)).toMatchObject({ t: 'error', code: 'bad_request' });
    expect(world({ secretsOn: true, secretsDir: 'none' }).snap.world.prompt_secrets).toEqual({ enabled: true, available: false });
    const old = world({ fail: 'no_secrets' });
    expect(old.snap.world.prompt_secrets).toBeUndefined();
    expect(old.run('prompt_secrets.get').at(-1)).toMatchObject({ t: 'error', code: 'unknown_command' });
  });

  it('scans while on: candidates and a revision bound to the text; off it is refused', () => {
    const off = world();
    expect(off.run('prompt_secrets.scan', { text: TEXT }).at(-1)).toMatchObject({ t: 'error', code: 'secrets_review_off' });
    const on = world({ secretsOn: true });
    const r1 = on.run('prompt_secrets.scan', { text: TEXT }).at(-1)?.data as { revision: string; candidates: unknown[] };
    expect(r1.candidates).toHaveLength(5);
    const r2 = on.run('prompt_secrets.scan', { text: `${TEXT} ` }).at(-1)?.data as { revision: string };
    expect(r2.revision).not.toBe(r1.revision);
    expect(on.run('prompt_secrets.scan', { text: 'x'.repeat(32 * 1024 + 1) }).at(-1)).toMatchObject({ code: 'bad_request' });
  });

  it('worker.prompt: a review is required, checked, and protected ranges go to files; the rest is sent as typed', async () => {
    const e = world({ secretsOn: true });
    const pebble = e.id('Pebble');
    expect(await e.answer('worker.prompt', { id: pebble, text: TEXT })).toMatchObject({ t: 'error', code: 'secrets_review_required', message: '5 possible secrets: review them' });
    const scan = e.run('prompt_secrets.scan', { text: TEXT }).at(-1)?.data as { revision: string; candidates: Array<{ id: string; start: number; end: number }> };
    const c = Object.fromEntries(scan.candidates.map((x) => [x.id, x]));
    // c1 protected, c2 corrected to take its quotes, c3 ignored, c4 protected, c5 (the same value as c2) ignored;
    // "deploy" marked by hand.
    const decisions = [
      { candidate: 'c1', action: 'protect', start: c.c1!.start, end: c.c1!.end },
      { candidate: 'c2', action: 'protect', start: c.c2!.start - 1, end: c.c2!.end + 1 },
      { candidate: 'c3', action: 'ignore' },
      { candidate: 'c4', action: 'protect' },
      { candidate: 'c5', action: 'ignore' },
      { action: 'protect', start: 0, end: 6 },
    ];
    const ack = await e.answer('worker.prompt', { id: pebble, text: TEXT, secrets: { revision: scan.revision, decisions } });
    expect(ack).toMatchObject({ t: 'ack', data: { protected: 4 } });
    const sent = (ack.data as { sent: string }).sent;
    // The bridge's shape: <dir>/<owner>/<file>, both names 26 of A-Z2-7 (the worker's directory is one per owner).
    expect(sent).toMatch(new RegExp(`^\\[secret in file ${SECRETS_DIR}/${ownerDir(pebble)}/[A-Z2-7]{26}\\] with TOKEN=\\[secret in file [^\\]]+\\] and PASSWORD=\\[secret in file [^\\]]+\\]; the password is s3cr3t!x then \\[secret in file [^\\]]+\\] and hunt😀r2$`));
    const files = (e.run('sim.secret_files').at(-1)?.data as { files: Array<{ path: string; text: string }> }).files.filter((f) => sent.includes(f.path));
    expect(files.map((f) => f.text)).toEqual(['deploy', 'ghp_abcdefghijklmnopqrstu1', '"hunt😀r2"', 'ghp_abcdefghijklmnopqrstu1']);
    // The identical submission again reuses its files.
    const again = await e.answer('worker.prompt', { id: pebble, text: TEXT, secrets: { revision: scan.revision, decisions: [...decisions].reverse() } });
    expect((again.data as { sent: string }).sent).toBe(sent);
  });

  it('refuses a stale or wrong review, a missing directory, a review while off; simfail gives each code once', async () => {
    const e = world({ secretsOn: true });
    const pebble = e.id('Pebble');
    const scan = e.run('prompt_secrets.scan', { text: 'password=abc123' }).at(-1)?.data as { revision: string };
    const send = (decisions: unknown[], revision = scan.revision) => e.answer('worker.prompt', { id: pebble, text: 'password=abc123', secrets: { revision, decisions } });
    expect(await send([{ candidate: 'c1', action: 'ignore' }], 'nope')).toMatchObject({ code: 'secrets_review_stale' });
    expect(await send([])).toMatchObject({ code: 'secrets_review_required' });
    expect(await send([{ candidate: 'c1', action: 'ignore' }, { action: 'protect', start: 10, end: 12 }])).toMatchObject({ code: 'secrets_review_required', message: expect.stringMatching(/overlap/) });
    expect(await send([{ candidate: 'c1', action: 'ignore', start: 3, end: 9 }])).toMatchObject({ code: 'secrets_review_required' });
    // Everything ignored: sent as typed.
    expect(await send([{ candidate: 'c1', action: 'ignore' }])).toMatchObject({ t: 'ack', data: { protected: 0 } });
    // The switch changed since the scan: stale.
    e.run('prompt_secrets.set', { enabled: false });
    e.run('prompt_secrets.set', { enabled: true });
    expect(await send([{ candidate: 'c1', action: 'protect' }])).toMatchObject({ code: 'secrets_review_stale' });
    const none = world({ secretsOn: true, secretsDir: 'none' });
    const s2 = none.run('prompt_secrets.scan', { text: 'password=abc123' }).at(-1)?.data as { revision: string };
    expect(await none.answer('worker.prompt', { id: none.id('Pebble'), text: 'password=abc123', secrets: { revision: s2.revision, decisions: [{ candidate: 'c1', action: 'protect' }] } })).toMatchObject({ code: 'secrets_unavailable' });
    for (const code of ['secrets_review_stale', 'secrets_review_required', 'secrets_unavailable', 'secrets_review_off']) {
      const f = world({ secretsOn: true, fail: code });
      const s = f.run('prompt_secrets.scan', { text: 'password=abc123' }).at(-1)?.data as { revision: string };
      const args = { id: f.id('Pebble'), text: 'password=abc123', secrets: { revision: s.revision, decisions: [{ candidate: 'c1', action: 'ignore' }] } };
      expect(await f.answer('worker.prompt', args)).toMatchObject({ code });
      if (code === 'secrets_review_off') expect(f.run('prompt_secrets.get').at(-1)).toMatchObject({ data: { enabled: false } });
    }
    // Off, a prompt without a review goes as before, one with a review is stale.
    const off = world();
    expect(await off.answer('worker.prompt', { id: off.id('Pebble'), text: 'password=abc123' })).toMatchObject({ t: 'ack' });
    expect(await off.answer('worker.prompt', { id: off.id('Pebble'), text: 'password=abc123', secrets: { revision: 'r', decisions: [] } })).toMatchObject({ code: 'secrets_review_stale' });
  });
});

// ---- round 2's routes and round 5's contract -------------------------------------------------------------------

type Scan = { revision: string; candidates: Array<{ id: string; start: number; end: number }> };
type File = { path: string; owner: string; text: string };
type W = ReturnType<typeof world>;

const scanOf = (e: W, text: string) => e.run('prompt_secrets.scan', { text }).at(-1)?.data as Scan;
/** A review of `text`: each candidate in order protected (`p`) or ignored (`i`). */
const reviewOf = (e: W, text: string, choices: string) => {
  const s = scanOf(e, text);
  return { revision: s.revision, decisions: s.candidates.map((c, i) => ({ candidate: c.id, action: choices[i] === 'i' ? 'ignore' : 'protect' })) };
};
const filesOf = (e: W) => (e.run('sim.secret_files').at(-1)?.data as { files: File[] }).files;
/** The paths of the exact `[secret in file …]` references in a text (the file list is the whole host's). */
const refsOf = (text: unknown) => [...String(text).matchAll(/\[secret in file ([^\]]+)\]/g)].map((m) => m[1] as string);
const fileAt = (e: W, path: string) => filesOf(e).find((f) => f.path === path);
/** The last `worker.upsert` of a worker that `heard` holds. */
const upserted = (e: W, id: string) =>
  e.log
    .filter((m) => m.t === 'worker.upsert' && (m.worker as { id: string }).id === id)
    .map((m) => m.worker as { secret_files?: number })
    .at(-1);

/** The models of the AI integration, played (no endpoint): the classifier's score and the LLM's answers. */
function models(e: W, complete: (user: string) => string, score = 0.97) {
  const ai = (e.w as unknown as { ai: Record<string, unknown> }).ai;
  ai.ready = () => true;
  ai.classify = async () => score;
  ai.complete = async (msgs: Array<{ content: string }>) => complete(msgs.at(-1)?.content ?? '');
  (e.w as unknown as { packup: { enabled: boolean } }).packup.enabled = true;
}

/** The LLM's interpretation: a Claude hire whose task is what follows "Task: " in the latest sentence. */
const interpretation = (user: string) => {
  const u = JSON.parse(user) as { command: string; pending_hire: { sources: string[] } | null };
  const source = u.pending_hire ? u.pending_hire.sources.length : 0;
  const start = u.command.indexOf('Task: ') + 6;
  const value = u.command.slice(start);
  return JSON.stringify({
    intent: 'hire',
    hire: {
      sources: [],
      harness: { provenance: 'dictated', value: 'claude' },
      model: { provenance: 'resolved', value: 'claude-opus-5-5' },
      effort: { provenance: 'dictated', value: 'high' },
      task: { provenance: 'dictated', value, span: { source, start, end: start + value.length } },
      questions: [],
      ready_for_review: true,
    },
  });
};

describe('the fixture’s prompt secrets on every other route (#108 round 2)', () => {
  it('worker.hire: required, then the prompt with references, its files the new worker’s (secret_files); a failed hire leaves none', async () => {
    const e = world({ secretsOn: true });
    const hire = (prompt: string, extra: Msg = {}) => e.answer('worker.hire', { session: 'pastry', desk_index: 15, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', prompt, ...extra });
    expect(await hire('Use TOKEN=abc123xyz to deploy')).toMatchObject({ code: 'secrets_review_required', message: '1 possible secret: review them' });
    const ack = await hire('Use TOKEN=abc123xyz to deploy', { secrets: reviewOf(e, 'Use TOKEN=abc123xyz to deploy', 'p') });
    expect(ack).toMatchObject({ t: 'ack', data: { protected: 1, prompted: true } });
    const id = (ack.data as { id: string }).id;
    const first = (e.run('sim.first_prompts').at(-1)?.data as Array<{ id: string; prompt: string }>).find((p) => p.id === id)?.prompt ?? '';
    expect(first).toMatch(/^Use TOKEN=\[secret in file [^\]]+\] to deploy$/);
    const [path] = refsOf(first);
    expect(fileAt(e, path as string)).toMatchObject({ owner: id, text: 'abc123xyz' });
    expect(upserted(e, id)?.secret_files).toBe(1);
    // A hire that fails removes the files its review made.
    const f = world({ secretsOn: true, fail: 'hire_failed' });
    const before = filesOf(f).length;
    expect(await f.answer('worker.hire', { session: 'pastry', desk_index: 15, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', prompt: 'password=hunter22', secrets: reviewOf(f, 'password=hunter22', 'p') })).toMatchObject({ code: 'hire_failed' });
    expect(filesOf(f)).toHaveLength(before);
  });

  it('run.start: a review per text keyed by its path, the path in every refusal; the ack’s prompt holds the references', async () => {
    const e = world({ secretsOn: true });
    const base = { session: 'herdr-3d', desk_index: 12, orch: { harness: 'claude', model: 'claude-opus-5-5', effort: 'high' }, preset: SIM_BUILD_TEAM.id, worktree: false };
    const text = 'Rotate it: API_KEY=k3y-v4lue-9';
    expect(await e.answer('run.start', { ...base, text })).toMatchObject({ code: 'secrets_review_required', message: 'text: 1 possible secret: review them' });
    // An extra beside an edited prompt is not sent: a review keyed by it is refused.
    expect(await e.answer('run.start', { ...base, text: 'Tidy', extra: 'x', prompt: '/write-code Tidy', secrets: { extra: reviewOf(e, 'x', '') } })).toMatchObject({ code: 'secrets_review_required', message: 'extra: a review of a text the command does not send' });
    expect(await e.answer('run.start', { ...base, text, secrets: reviewOf(e, text, 'p') })).toMatchObject({ code: 'bad_request', message: expect.stringMatching(/keyed by each text/) });
    const ack = await e.answer('run.start', { ...base, text, extra: 'and the password is s3cr3t!x', secrets: { text: reviewOf(e, text, 'p'), extra: reviewOf(e, 'and the password is s3cr3t!x', 'i') } });
    expect(ack).toMatchObject({ t: 'ack', data: { protected: 1 } });
    const d = ack.data as { id: string; prompt: string };
    expect(d.prompt).toContain('Rotate it: API_KEY=[secret in file ');
    expect(d.prompt).toContain('and the password is s3cr3t!x');
    expect(fileAt(e, refsOf(d.prompt)[0] as string)).toMatchObject({ owner: d.id, text: 'k3y-v4lue-9' });
  });

  it('stored prompts: an all-ignore review saves as typed, protecting is secrets_review_stored; presets and their check too', async () => {
    const e = world({ secretsOn: true });
    const prompt = 'Deploy with TOKEN=abc123xyz';
    const spec = { floor: 'pastry', title: 'Deploy', prompt, due_at: Date.now() + 3_600_000, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', cwd: '/home/dev/pastry' };
    expect(await e.answer('schedule.create', spec)).toMatchObject({ code: 'secrets_review_required' });
    expect(await e.answer('schedule.create', { ...spec, secrets: reviewOf(e, prompt, 'p') })).toMatchObject({ code: 'secrets_review_stored', message: expect.stringMatching(/protect them when you hire/) });
    const ok = await e.answer('schedule.create', { ...spec, secrets: reviewOf(e, prompt, 'i') });
    expect(ok).toMatchObject({ t: 'ack', data: { prompt } });
    const id = (ok.data as { id: string }).id;
    expect(await e.answer('schedule.update', { id, ...spec, due_at: spec.due_at + 1000 })).toMatchObject({ code: 'secrets_review_required' });
    expect(await e.answer('schedule.cancel', { id, secrets: reviewOf(e, prompt, 'i') })).toMatchObject({ code: 'bad_request' });
    const preset = { name: 'Deploy', prompt, harness: 'claude', model: 'claude-opus-5-5', effort: 'high' };
    expect(await e.answer('hire_preset.create', { ...preset, secrets: reviewOf(e, prompt, 'p') })).toMatchObject({ code: 'secrets_review_stored' });
    expect(await e.answer('hire_preset.create', { ...preset, secrets: reviewOf(e, prompt, 'i') })).toMatchObject({ t: 'ack', data: { prompt } });
    expect(await e.answer('hire_preset.check', { prompt })).toMatchObject({ code: 'secrets_review_required' });
    expect(await e.answer('hire_preset.check', { prompt, secrets: reviewOf(e, prompt, 'i') })).toMatchObject({ t: 'ack' });
    expect(filesOf(e).some((f) => f.owner === 'stored')).toBe(false);
  });

  it('a schedule saved before the switch was on fails its fire; retry with a review of its stored prompt repairs it', async () => {
    const e = world({ secrets: `k-${Math.random()}` });
    const prompt = 'Deploy with TOKEN=abc123xyz';
    const spec = { floor: 'pastry', title: 'Deploy', prompt, due_at: Date.now() + 3_600_000, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', cwd: '/home/dev/pastry' };
    const id = ((await e.answer('schedule.create', spec)).data as { id: string }).id;
    e.run('prompt_secrets.set', { enabled: true });
    const last = () => e.log.filter((m) => m.t === 'schedule.upsert' && (m.schedule as { id: string }).id === id).map((m) => m.schedule as { state: string; state_reason?: string }).at(-1);
    e.run('sim.schedule_fire', { id });
    expect(last()).toMatchObject({ state: 'failed', state_reason: expect.stringMatching(/^its prompt was not reviewed for secrets: it has 1 possible secrets .* open the schedule, review them and retry it; nothing was sent$/) });
    // A retry without a review fails again; one that protects is refused; an all-ignore review fires it as typed.
    expect(await e.answer('schedule.retry', { id })).toMatchObject({ t: 'ack' });
    expect(last()).toMatchObject({ state: 'failed' });
    expect(await e.answer('schedule.retry', { id, secrets: reviewOf(e, prompt, 'p') })).toMatchObject({ code: 'secrets_review_stored' });
    expect(await e.answer('schedule.retry', { id, secrets: reviewOf(e, prompt, 'i') })).toMatchObject({ t: 'ack' });
    expect(last()?.state).toBe('running');
    for (let i = 0; i < 50 && last()?.state === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(last()?.state).toBe('done');
    // Off, a review is stale.
    e.run('prompt_secrets.set', { enabled: false });
    expect(await e.answer('schedule.retry', { id, secrets: { revision: 'r', decisions: [] } })).toMatchObject({ code: 'secrets_review_stale' });
  });

  it('packup.detect: the models read the references, its hand-over makes the follow-up need no review and claims the files', async () => {
    const e = world({ secretsOn: true });
    models(e, () => JSON.stringify({ remove: [' and end your turn'] }));
    const pebble = e.id('Pebble');
    const text = 'Deploy with TOKEN=abc123xyz and end your turn';
    expect(await e.answer('packup.detect', { id: pebble, text })).toMatchObject({ code: 'secrets_review_required' });
    const ack = await e.answer('packup.detect', { id: pebble, text, secrets: reviewOf(e, text, 'p') });
    const d = ack.data as { matched: boolean; sent: string; task: string; removed: Array<{ start: number; end: number }>; protected: number; secrets_pending: string };
    expect(d).toMatchObject({ matched: true, protected: 1, secrets_pending: expect.any(String) });
    expect(d.sent).toMatch(/^Deploy with TOKEN=\[secret in file [^\]]+\] and end your turn$/);
    expect(d.task).toBe(d.sent.slice(0, d.sent.indexOf(' and end')));
    // `removed` indexes what the models read.
    expect(d.sent.slice(d.removed[0]?.start, d.removed[0]?.end)).toBe(' and end your turn');
    const [path] = refsOf(d.sent);
    expect(fileAt(e, path as string)?.owner).toMatch(/^pending:/);
    // Another worker's prompt cannot use it.
    expect(await e.answer('worker.prompt', { id: e.id('Mochi'), text: d.sent, secrets_pending: d.secrets_pending })).toMatchObject({ code: 'secrets_review_stale' });
    const sent = await e.answer('worker.prompt', { id: pebble, text: d.sent, secrets_pending: d.secrets_pending });
    expect(sent).toMatchObject({ t: 'ack' });
    expect(fileAt(e, path as string)?.owner).toBe(pebble);
    expect(upserted(e, pebble)?.secret_files).toBe(1);
    // A text the hand-over did not answer is reviewed as usual (its references scan clean, a new value does not).
    expect(await e.answer('worker.prompt', { id: pebble, text: `${d.task} with password=hunter22`, secrets_pending: d.secrets_pending })).toMatchObject({ code: 'secrets_review_required' });
    // simfail=secrets_pending_stale plays an expired hand-over; off, a hand-over is stale.
    const f = world({ secretsOn: true, fail: 'secrets_pending_stale' });
    expect(await f.answer('worker.prompt', { id: f.id('Pebble'), text: 'hi', secrets_pending: 'x' })).toMatchObject({ code: 'secrets_review_stale' });
    const off = world();
    expect(await off.answer('worker.prompt', { id: off.id('Pebble'), text: 'hi', secrets_pending: 'x' })).toMatchObject({ code: 'secrets_review_stale' });
  });

  it('round 5: worker.wrapup takes packup’s hand-over for its task and the cleanup; a bridge before it refuses the field', async () => {
    for (const fail of [undefined, 'old_wrapup']) {
      const e = world({ secretsOn: true, ...(fail ? { fail } : {}) });
      models(e, () => JSON.stringify({ remove: [' and go home'] }));
      // Mochi is in a worktree of its own: it can be sent home.
      const pebble = e.id('Mochi');
      const text = 'Push with TOKEN=abc123xyz and go home';
      const d = (await e.answer('packup.detect', { id: pebble, text, secrets: reviewOf(e, text, 'p') })).data as { task: string; secrets_pending: string };
      const prompt = `${d.task}\n\nOnce that is done: Stop every server, background process, pane and freelancer you started in this session. Don’t touch anything else.`;
      const ack = await e.answer('worker.wrapup', { id: pebble, prompt, secrets_pending: d.secrets_pending });
      if (fail) {
        expect(ack).toMatchObject({ code: 'bad_request', message: 'bad args: json: unknown field "secrets_pending"' });
        continue;
      }
      expect(ack).toMatchObject({ t: 'ack' });
      expect(fileAt(e, refsOf(d.task)[0] as string)?.owner).toBe(pebble);
      // Any other prompt is reviewed as usual.
      e.run('worker.wrapup.cancel', { id: pebble });
      expect(await e.answer('worker.wrapup', { id: pebble, prompt: 'Clean up, the password is s3cr3t!x', secrets_pending: d.secrets_pending })).toMatchObject({ code: 'secrets_review_required' });
    }
  });

  it('hire.interpret: the LLM reads the references, the hand-over carries the task into worker.hire (claimed once)', async () => {
    const e = world({ secretsOn: true });
    models(e, interpretation);
    const text = 'Hire Claude. Task: deploy with password=hunter22';
    const ack = await e.answer('hire.interpret', { text, secrets: reviewOf(e, text, 'p') });
    const d = ack.data as { text: string; protected: number; secrets_pending: string; hire: { sources: string[]; task: { value: string } } };
    expect(d).toMatchObject({ protected: 1, secrets_pending: expect.any(String) });
    expect(d.text).toMatch(/^Hire Claude\. Task: deploy with password=\[secret in file [^\]]+\]$/);
    expect(d.hire.sources).toEqual([d.text]);
    // A follow-up keeps the token; the proposal's sentences need no review with it, and do without it.
    const pendingHire = d.hire;
    expect(await e.answer('hire.interpret', { text: 'High effort.', pending: { ...pendingHire, sources: ['the password is s3cr3t!x'] } })).toMatchObject({ code: 'secrets_review_required', message: 'pending.sources[0]: 1 possible secret: review them' });
    const hire = (extra: Msg) => e.answer('worker.hire', { session: 'pastry', desk_index: 15, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', prompt: d.hire.task.value, ...extra });
    const hired = await hire({ secrets_pending: d.secrets_pending });
    expect(hired).toMatchObject({ t: 'ack', data: { prompted: true } });
    const id = (hired.data as { id: string }).id;
    expect(fileAt(e, refsOf(d.text)[0] as string)).toMatchObject({ owner: id, text: 'hunter22' });
    // One hire takes it.
    expect(await e.answer('worker.hire', { session: 'pastry', desk_index: 14, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', prompt: d.hire.task.value, secrets_pending: d.secrets_pending })).toMatchObject({ code: 'secrets_review_stale' });
  });

  it('answers: a review per path (answers[N].other, answers[N].answer), the texts passed on with references, files the worker’s', async () => {
    const e = world({ secretsOn: true, codex: 'ask' });
    const pebble = e.id('Pebble');
    e.run('sim.ask', { id: pebble, ask: { tool_use_id: 'tu1', questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A' }], other: true }] } });
    const other = 'the password is s3cr3t!x';
    const args = { id: pebble, tool_use_id: 'tu1', answers: [{ question: 0, other }] };
    expect(await e.answer('worker.answer_ask', args)).toMatchObject({ code: 'secrets_review_required', message: 'answers[0].other: 1 possible secret: review them' });
    expect(await e.answer('worker.answer_ask', { ...args, secrets: { 'answers[0].other': reviewOf(e, other, 'p') } })).toMatchObject({ t: 'ack' });
    expect(filesOf(e).find((f) => f.owner === pebble && f.text === 's3cr3t!x')).toBeTruthy();
    const pixel = SIM_CODEX_WORKER;
    const answer = 'use TOKEN=abc123xyz';
    const a2 = { id: pixel, thread: SIM_CODEX_THREAD, batch: 'call_3', answers: [{ index: 1, answer }] };
    expect(await e.answer('worker.answer_async', a2)).toMatchObject({ code: 'secrets_review_required', message: 'answers[0].answer: 1 possible secret: review them' });
    expect(await e.answer('worker.answer_async', { ...a2, secrets: { 'answers[0].answer': reviewOf(e, answer, 'p') } })).toMatchObject({ t: 'ack' });
    expect(filesOf(e).find((f) => f.owner === pixel && f.text === 'abc123xyz')).toBeTruthy();
  });

  it('worker.handoff (agent): the instruction reviewed, the request holds the references, the ack says how many', async () => {
    const e = world({ secretsOn: true });
    const pebble = e.id('Pebble');
    const instruction = 'focus on the deploy, TOKEN=abc123xyz';
    expect(await e.answer('worker.handoff', { worker: pebble, mode: 'agent', op: 'op-1', instruction })).toMatchObject({ code: 'secrets_review_required' });
    const ack = await e.answer('worker.handoff', { worker: pebble, mode: 'agent', op: 'op-2', instruction, secrets: reviewOf(e, instruction, 'p') });
    expect(ack).toMatchObject({ t: 'ack', data: { protected: 1, request: { instruction: expect.stringMatching(/^focus on the deploy, TOKEN=\[secret in file [^\]]+\]$/) } } });
  });

  it('round 5: prompt_secrets.revoke removes what a worker holds (secret_files goes), on or off; an older bridge has neither', async () => {
    const e = world({ secrets: `k-${Math.random()}`, secretsOn: true });
    const pebble = e.id('Pebble');
    const text = 'TOKEN=abc123xyz and password=hunter22';
    const sent = await e.answer('worker.prompt', { id: pebble, text, secrets: reviewOf(e, text, 'pp') });
    expect(sent).toMatchObject({ data: { protected: 2 } });
    const paths = refsOf((sent.data as { sent: string }).sent);
    expect(upserted(e, pebble)?.secret_files).toBe(2);
    expect((e.w.snapshot() as { world: { workers: Array<{ id: string; secret_files?: number }> } }).world.workers.find((w) => w.id === pebble)?.secret_files).toBe(2);
    e.run('prompt_secrets.set', { enabled: false });
    expect(e.run('prompt_secrets.revoke', { worker: pebble }).at(-1)).toMatchObject({ t: 'ack', data: { removed: 2 } });
    expect(upserted(e, pebble)).not.toHaveProperty('secret_files');
    expect(filesOf(e).filter((f) => paths.includes(f.path))).toEqual([]);
    expect(e.run('prompt_secrets.revoke', { worker: pebble }).at(-1)).toMatchObject({ data: { removed: 0 } });
    expect(e.run('prompt_secrets.revoke', { worker: 'nobody' }).at(-1)).toMatchObject({ code: 'not_found' });
    expect(world({ secretsDir: 'none' }).run('prompt_secrets.revoke', { worker: pebble }).at(-1)).toMatchObject({ code: 'secrets_unavailable' });
    const old = world({ secretsOn: true, fail: 'no_revoke' });
    expect(old.run('prompt_secrets.revoke', { worker: old.id('Pebble') }).at(-1)).toMatchObject({ code: 'unknown_command' });
    expect(await old.answer('worker.prompt', { id: old.id('Pebble'), text, secrets: reviewOf(old, text, 'pp') })).toMatchObject({ data: { protected: 2 } });
    expect(upserted(old, old.id('Pebble'))?.secret_files).toBeUndefined();
  });

  it('the gate alone: answer_followup’s paths, a review keyed by a text not sent, all-or-nothing files, off', () => {
    const sim = new SecretsSim({ emit: () => {}, error: (code, message) => Object.assign(new Error(message), { code }), takeFailure: () => false }, { on: true });
    const w = { packupLooks: () => true, schedulePrompt: () => undefined };
    const scan = (text: string) => {
      let d: Scan | undefined;
      sim.handle('prompt_secrets.scan', { text }, () => {}, (x) => (d = x as Scan));
      return d as Scan;
    };
    const rev = (text: string) => ({ revision: scan(text).revision, decisions: scan(text).candidates.map((c) => ({ candidate: c.id, action: 'protect' })) });
    const a = { id: 'w1', turn_id: 't1', note: 'TOKEN=abc123xyz', answers: [{ id: 'q1', value: 'yes', note: 'password=hunter22' }] };
    expect(() => sim.gate('worker.answer_followup', structuredClone(a), () => {}, w)).toThrow(/note: 1 possible secret/);
    const b = structuredClone(a) as typeof a & { secrets?: unknown };
    b.secrets = { note: rev(a.note), 'answers[0].note': rev('password=hunter22') };
    sim.gate('worker.answer_followup', b, () => {}, w);
    expect(b).not.toHaveProperty('secrets');
    expect(b.note).toMatch(/^TOKEN=\[secret in file [^\]]+\]$/);
    expect(b.answers[0]?.note).toMatch(/^password=\[secret in file [^\]]+\]$/);
    expect(b.answers[0]?.value).toBe('yes');
    // A review of a text the command does not send; a second text refused undoes the first one's files.
    const before = SecretsSim.files().length;
    const c = { ...structuredClone(a), secrets: { note: rev(a.note), 'answers[1].value': rev('yes') } };
    expect(() => sim.gate('worker.answer_followup', c, () => {}, w)).toThrow(/answers\[1\]\.value: a review of a text the command does not send/);
    const d = { ...structuredClone(a), secrets: { note: rev(a.note) } };
    expect(() => sim.gate('worker.answer_followup', d, () => {}, w)).toThrow(/answers\[0\]\.note: 1 possible secret/);
    expect(SecretsSim.files()).toHaveLength(before);
    const off = new SecretsSim({ emit: () => {}, error: (code, message) => Object.assign(new Error(message), { code }), takeFailure: () => false });
    expect(off.gate('worker.answer_followup', structuredClone(a), () => {}, w)).toBeNull();
    expect(() => off.gate('worker.hire', { prompt: 'x', secrets_pending: 't' }, () => {}, w)).toThrow(/switch is off/);
  });
});
