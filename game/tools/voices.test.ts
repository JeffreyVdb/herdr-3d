import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LINE_KINDS } from '../src/reception/lines';
import { audit, ENDPOINT, GAME_DIR, mp3Info, paths, run, type Lock } from './voices';

/** `n` silent-ish MPEG-1 Layer III frames: 64 kb/s, 44.1 kHz, mono, 208 bytes each. */
function mp3(n: number, fill = 0): Uint8Array {
  const b = new Uint8Array(n * 208).fill(fill);
  for (let i = 0; i < n; i++) b.set([0xff, 0xfb, 0x50, 0xc4], i * 208);
  return b;
}

const KEY = 'sk-test-0123456789abcdef';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { model: string; messages: Array<{ role: string; content: string }>; audio: { format: string; voice?: string }; stream: boolean };
}

/** A stubbed MiMo endpoint: answers each call with `responses` in turn (then 200 + a clip). */
function fakeApi(responses: Array<() => Response> = []) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Call['body'] });
    const r = responses.shift();
    if (r) return r();
    const data = Buffer.from(mp3(40, calls.length)).toString('base64');
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', audio: { id: 'x', data } } }] });
  }) as typeof fetch;
  return { fetch: f, calls };
}

let root: string;
let keyReads = 0;
let logs: string[] = [];
const readKey = () => {
  keyReads++;
  return KEY;
};
const log = (s: string) => logs.push(s);

const LINES = LINE_KINDS.map((kind) => ({ id: `${kind}-1`, kind, text: `(Happy) The ${kind} line.` }));

function writeManifest(over: { use?: 'clone' | 'builtin'; direction?: string; lines?: typeof LINES } = {}): void {
  const voice = {
    use: over.use ?? 'clone',
    direction: over.direction ?? 'Friendly and upbeat.',
    design: { model: 'mimo-v2.5-tts-voicedesign', description: 'An original, warm receptionist voice.', text: 'Good morning!' },
    clone: { model: 'mimo-v2.5-tts-voiceclone', reference: 'receptionist-reference.mp3' },
    builtin: { model: 'mimo-v2.5-tts', voice: 'Mia' },
  };
  writeFileSync(join(root, 'voices', 'receptionist.json'), JSON.stringify({ voice, lines: over.lines ?? LINES }));
}

const lock = () => JSON.parse(readFileSync(join(root, 'voices', 'receptionist.lock.json'), 'utf8')) as Lock;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'h3d-voices-'));
  mkdirSync(join(root, 'voices'));
  writeFileSync(join(root, 'voices', 'receptionist-reference.mp3'), mp3(60, 7));
  writeManifest();
  keyReads = 0;
  logs = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('mp3Info', () => {
  it('counts frames and duration, and rejects what isn’t an MP3', () => {
    const i = mp3Info(mp3(100));
    expect(i).toMatchObject({ frames: 100, sampleRate: 44100, kbps: 64, channels: 1 });
    expect(i?.ms).toBe(Math.round(((100 * 1152) / 44100) * 1000));
    // With an ID3v2 tag in front.
    const tag = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 10, ...new Array(10).fill(0)]);
    expect(mp3Info(new Uint8Array([...tag, ...mp3(20)]))?.frames).toBe(20);
    expect(mp3Info(new TextEncoder().encode('{"error":"nope"}'))).toBeNull();
    expect(mp3Info(mp3(3))).toBeNull();
    // Garbage after a few frames: not a clip.
    expect(mp3Info(new Uint8Array([...mp3(10), ...new Uint8Array(4000).fill(1)]))).toBeNull();
  });
});

describe('the voice generator', () => {
  it('clones every line from the reference clip, with the key only in the api-key header', async () => {
    const api = fakeApi();
    const r = await run({ root, fetch: api.fetch, readKey, log, retryDelayMs: 1 });
    expect(r.generated.sort()).toEqual(LINES.map((l) => l.id).sort());
    expect(api.calls).toHaveLength(LINES.length);
    const ref = readFileSync(join(root, 'voices', 'receptionist-reference.mp3')).toString('base64');
    for (const c of api.calls) {
      expect(c.url).toBe(ENDPOINT);
      expect(c.headers['api-key']).toBe(KEY);
      expect(c.body).toMatchObject({ model: 'mimo-v2.5-tts-voiceclone', stream: false, audio: { format: 'mp3', voice: `data:audio/mpeg;base64,${ref}` } });
      expect(c.body.messages[0]).toEqual({ role: 'user', content: 'Friendly and upbeat.' });
      expect(c.body.messages[1]?.role).toBe('assistant');
    }
    expect(api.calls.map((c) => c.body.messages[1]?.content).sort()).toEqual(LINES.map((l) => l.text).sort());
    for (const l of LINES) {
      expect(mp3Info(readFileSync(join(paths(root).clips, `${l.id}.mp3`)))?.frames).toBe(40);
      expect(lock().lines[l.id]).toMatchObject({ bytes: 40 * 208, ms: Math.round(((40 * 1152) / 44100) * 1000) });
    }
    expect(keyReads).toBe(1);
    expect(logs.join('\n')).not.toContain(KEY);
    expect(readFileSync(join(root, 'voices', 'receptionist.lock.json'), 'utf8')).not.toContain(KEY);
  });

  it('is idempotent: unchanged lines are not regenerated, and no key is read', async () => {
    await run({ root, fetch: fakeApi().fetch, readKey, log });
    const before = lock();
    keyReads = 0;
    const api = fakeApi();
    const r = await run({ root, fetch: api.fetch, readKey, log });
    expect(api.calls).toHaveLength(0);
    expect(keyReads).toBe(0);
    expect(r.generated).toEqual([]);
    expect(r.skipped).toHaveLength(LINES.length);
    expect(lock()).toEqual(before);
  });

  it('regenerates only what changed: a line’s text, then the whole set for new voice settings', async () => {
    await run({ root, fetch: fakeApi().fetch, readKey, log });
    const edited = LINES.map((l) => (l.id === 'goodbye-1' ? { ...l, text: 'See you later!' } : l));
    writeManifest({ lines: edited });
    let api = fakeApi();
    expect((await run({ root, fetch: api.fetch, readKey, log })).generated).toEqual(['goodbye-1']);
    expect(api.calls.map((c) => c.body.messages[1]?.content)).toEqual(['See you later!']);

    writeManifest({ lines: edited, direction: 'Calm and warm.' });
    api = fakeApi();
    expect((await run({ root, fetch: api.fetch, readKey, log })).generated).toHaveLength(LINES.length);

    // A new reference take changes the voice: everything again.
    writeFileSync(join(root, 'voices', 'receptionist-reference.mp3'), mp3(61, 9));
    api = fakeApi();
    expect((await run({ root, fetch: api.fetch, readKey, log })).generated).toHaveLength(LINES.length);

    // Built-in fallback: one named voice on the plain model.
    writeManifest({ lines: edited, direction: 'Calm and warm.', use: 'builtin' });
    api = fakeApi();
    expect((await run({ root, fetch: api.fetch, readKey, log })).generated).toHaveLength(LINES.length);
    expect(api.calls[0]?.body).toMatchObject({ model: 'mimo-v2.5-tts', audio: { format: 'mp3', voice: 'Mia' } });
  });

  it('removes the clip of a deleted line, and regenerates a deleted clip', async () => {
    await run({ root, fetch: fakeApi().fetch, readKey, log });
    writeManifest({ lines: [...LINES, { id: 'goodbye-2', kind: 'goodbye', text: 'Bye!' }] });
    await run({ root, fetch: fakeApi().fetch, readKey, log });
    expect(existsSync(join(paths(root).clips, 'goodbye-2.mp3'))).toBe(true);
    writeManifest();
    const api = fakeApi();
    const r = await run({ root, fetch: api.fetch, readKey, log });
    expect(r.removed).toEqual(['goodbye-2']);
    expect(api.calls).toHaveLength(0);
    expect(existsSync(join(paths(root).clips, 'goodbye-2.mp3'))).toBe(false);
    expect(lock().lines['goodbye-2']).toBeUndefined();

    rmSync(join(paths(root).clips, 'quiet-1.mp3'));
    expect((await run({ root, fetch: fakeApi().fetch, readKey, log })).generated).toEqual(['quiet-1']);
  });

  it('--dry-run and --force', async () => {
    const api = fakeApi();
    const dry = await run({ root, fetch: api.fetch, readKey, log, dryRun: true });
    expect(dry.generated).toHaveLength(LINES.length);
    expect(api.calls).toHaveLength(0);
    expect(keyReads).toBe(0);
    expect(existsSync(join(root, 'voices', 'receptionist.lock.json'))).toBe(false);
    await run({ root, fetch: fakeApi().fetch, readKey, log });
    const again = fakeApi();
    await run({ root, fetch: again.fetch, readKey, log, force: true });
    expect(again.calls).toHaveLength(LINES.length);
  });

  it('retries 429 and 5xx, fails on the rest without the key in the message', async () => {
    const api = fakeApi([() => new Response('slow down', { status: 429 }), () => new Response('oops', { status: 503 })]);
    writeManifest({ lines: LINES });
    await run({ root, fetch: api.fetch, readKey, log, retryDelayMs: 1, concurrency: 1 });
    expect(api.calls).toHaveLength(LINES.length + 2);

    rmSync(join(paths(root).clips, 'quiet-1.mp3'));
    const bad = fakeApi([() => new Response(`invalid key ${KEY}`, { status: 401 })]);
    const err = await run({ root, fetch: bad.fetch, readKey, log, retryDelayMs: 1 }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('MiMo HTTP 401');
    expect((err as Error).message).not.toContain(KEY);
    expect(bad.calls).toHaveLength(1);

    const empty = fakeApi([() => Response.json({ choices: [{ finish_reason: 'content_filter', message: {} }] })]);
    await expect(run({ root, fetch: empty.fetch, readKey, log, retryDelayMs: 1 })).rejects.toThrow(/no complete audio/);
  });

  it('refuses to clone without a reference clip', async () => {
    rmSync(join(root, 'voices', 'receptionist-reference.mp3'));
    await expect(run({ root, fetch: fakeApi().fetch, readKey, log })).rejects.toThrow(/no reference clip/);
    expect(keyReads).toBe(0);
  });
});

describe('audit', () => {
  it('finds missing, orphan, stale and broken clips', async () => {
    await run({ root, fetch: fakeApi().fetch, readKey, log });
    expect(audit(root)).toMatchObject({ missing: [], orphans: [], stale: [], broken: [] });
    rmSync(join(paths(root).clips, 'nudge-1.mp3'));
    writeFileSync(join(paths(root).clips, 'old-line.mp3'), mp3(10));
    writeFileSync(join(paths(root).clips, 'quiet-1.mp3'), 'not audio');
    writeManifest({ lines: LINES.map((l) => (l.id === 'goodbye-1' ? { ...l, text: 'Changed!' } : l)) });
    expect(audit(root)).toMatchObject({ missing: ['nudge-1'], orphans: ['old-line.mp3'], stale: ['goodbye-1'], broken: ['quiet-1'] });
  });
});

describe('the committed voice clips', () => {
  it('match the manifest: a clip per line, no orphans, none stale, all MP3, under ~1 MB', () => {
    const a = audit(GAME_DIR);
    expect(a.missing, 'lines without a clip: run `pnpm -C game voices`').toEqual([]);
    expect(a.orphans, 'clips without a line').toEqual([]);
    expect(a.stale, 'clips older than their line or voice settings').toEqual([]);
    expect(a.broken, 'clips that are not MP3').toEqual([]);
    expect(a.bytes).toBeLessThan(1024 * 1024);
  });
});
