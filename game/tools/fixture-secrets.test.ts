import { afterEach, describe, expect, it } from 'vitest';
import { loadFixture } from './fixture-server.ts';
import { SimWorld, type SimOptions } from './fixture-sim.ts';
import { detect, ownerDir, SECRETS_DIR } from './fixture-secrets.ts';

// #108: the fixture's prompt secrets: the switch, the fake detector's scan, and worker.prompt's review gate.

type Msg = Record<string, unknown>;
const worlds: SimWorld[] = [];
afterEach(() => worlds.splice(0).forEach((w) => w.dispose()));

function world(o: Partial<SimOptions> = {}) {
  const rec = loadFixture('demo-m5');
  const w = new SimWorld(rec.snapshot, { stepMs: 20, usageMs: 0, ...o });
  worlds.push(w);
  const heard: Msg[] = [];
  w.start((m) => heard.push(m as Msg));
  let n = 0;
  const run = (t: string, args: Msg = {}) => {
    const out: Msg[] = [];
    w.handle({ t, req_id: `r${++n}`, args }, (m) => out.push(m as Msg));
    return out;
  };
  /** The command's answer, once it came (a prompt to an idle worker answers a step later). */
  const answer = async (t: string, args: Msg = {}) => {
    const out: Msg[] = [];
    w.handle({ t, req_id: `r${++n}`, args }, (m) => out.push(m as Msg));
    for (let i = 0; i < 50 && !out.some((m) => m.t === 'ack' || m.t === 'error'); i++) await new Promise((r) => setTimeout(r, 10));
    return out.find((m) => m.t === 'ack' || m.t === 'error') as Msg;
  };
  const snap = w.snapshot() as { world: { workers: { id: string; name: string; status: string }[]; prompt_secrets?: unknown } };
  const id = (name: string) => snap.world.workers.find((x) => x.name === name)?.id as string;
  return { w, run, answer, id, heard, snap };
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
    expect(detect('DB_PASSWORD=p%40ss')).toEqual([{ id: 'c1', start: 12, end: 18, kinds: ['assignment'], encoded: true }]);
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
