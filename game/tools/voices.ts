// Generates the receptionist's voice clips with Xiaomi MiMo-V2.5-TTS, once,
// offline: the game only ever plays the committed MP3s.
//
//   node tools/voices.ts                 generate the lines that are missing or changed
//   node tools/voices.ts --dry-run       list what would be generated (no key read, no calls)
//   node tools/voices.ts --check         exit 1 when a clip is missing, stale, orphaned, broken or
//                                        differs from the lock (no calls)
//   node tools/voices.ts --relock        re-record each clip's sha256, size and length in the lock
//                                        after editing a clip by hand (no key read, no calls)
//   node tools/voices.ts --force         regenerate every line
//   node tools/voices.ts design [--takes 3] [--out <dir>]
//                                        takes of the reference script from the voice
//                                        description (voicedesign); copy the one you like
//                                        to voices/receptionist-reference.mp3
//   node tools/voices.ts info            duration, bitrate and size of every committed clip
//
// Inputs: voices/receptionist.json (the lines and the voice settings) and, for
// the cloned voice, voices/receptionist-reference.mp3. Outputs:
// public/voices/receptionist/<id>.mp3 and voices/receptionist.lock.json, which
// stores a hash of each line's text + voice settings (an unchanged line is
// never regenerated) and the sha256, size and length of the clip it made.
//
// The API key is read from /tmp/xiaomi when a call is about to be made, kept
// in memory, sent only in the `api-key` header and never logged or written.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLines, type VoiceLine } from '../src/reception/lines.ts';

export const KEY_FILE = '/tmp/xiaomi';
export const ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions';
export const GAME_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_VERSION = 1;

export interface VoiceSettings {
  /** Which voice every line is spoken in: the clone of the designed reference, or one built-in voice. */
  use: 'clone' | 'builtin';
  /** Performance direction (the `user` message, not spoken). */
  direction: string;
  design: { model: string; description: string; text: string };
  clone: { model: string; reference: string };
  builtin: { model: string; voice: string };
}

export interface Manifest {
  voice: VoiceSettings;
  lines: VoiceLine[];
}

export interface LockEntry {
  /** lineHash of the line the clip was made from. */
  hash: string;
  /** The clip file: its sha256, size and length. */
  sha256: string;
  bytes: number;
  ms: number;
}

export interface Lock {
  version: number;
  lines: Record<string, LockEntry>;
}

export interface Paths {
  manifest: string;
  lock: string;
  voices: string;
  clips: string;
}

export function paths(root = GAME_DIR): Paths {
  return {
    manifest: join(root, 'voices', 'receptionist.json'),
    lock: join(root, 'voices', 'receptionist.lock.json'),
    voices: join(root, 'voices'),
    clips: join(root, 'public', 'voices', 'receptionist'),
  };
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`voice manifest: ${what} must be a non-empty string`);
  return v;
};

export function loadManifest(p: Paths): Manifest {
  const raw = JSON.parse(readFileSync(p.manifest, 'utf8')) as { voice?: Record<string, Record<string, unknown> | string> };
  const v = raw.voice ?? {};
  const o = (k: string) => (typeof v[k] === 'object' && v[k] !== null ? (v[k] as Record<string, unknown>) : {});
  const use = v.use;
  if (use !== 'clone' && use !== 'builtin') throw new Error('voice manifest: voice.use must be "clone" or "builtin"');
  return {
    voice: {
      use,
      direction: str(v.direction, 'voice.direction'),
      design: { model: str(o('design').model, 'voice.design.model'), description: str(o('design').description, 'voice.design.description'), text: str(o('design').text, 'voice.design.text') },
      clone: { model: str(o('clone').model, 'voice.clone.model'), reference: str(o('clone').reference, 'voice.clone.reference') },
      builtin: { model: str(o('builtin').model, 'voice.builtin.model'), voice: str(o('builtin').voice, 'voice.builtin.voice') },
    },
    lines: parseLines(raw),
  };
}

export function loadLock(p: Paths): Lock {
  if (!existsSync(p.lock)) return { version: LOCK_VERSION, lines: {} };
  const l = JSON.parse(readFileSync(p.lock, 'utf8')) as Partial<Lock>;
  return { version: LOCK_VERSION, lines: l.version === LOCK_VERSION && l.lines ? l.lines : {} };
}

/** Writes via a sibling temp file and a rename, so a crash never leaves half a file. */
function writeAtomic(file: string, data: string | Uint8Array): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

function saveLock(p: Paths, m: Manifest, lock: Lock): void {
  // Manifest order, so the diff of a regenerated line is one entry.
  const lines: Record<string, LockEntry> = {};
  for (const l of m.lines) {
    const e = lock.lines[l.id];
    if (e) lines[l.id] = e;
  }
  writeAtomic(p.lock, `${JSON.stringify({ version: LOCK_VERSION, lines }, null, 2)}\n`);
}

const sha256 = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The voice every line uses, as it goes into the hash: model plus the reference clip's hash or the built-in name. */
function voiceKey(p: Paths, v: VoiceSettings): { model: string; voice: string } {
  if (v.use === 'builtin') return { model: v.builtin.model, voice: v.builtin.voice };
  const ref = join(p.voices, v.clone.reference);
  if (!existsSync(ref)) throw new Error(`no reference clip at ${ref}: run \`node tools/voices.ts design\` and copy the take you like there`);
  return { model: v.clone.model, voice: `sha256:${sha256(readFileSync(ref))}` };
}

/** Hash of everything that changes a clip: text, direction, model and voice. */
export function lineHash(line: VoiceLine, v: VoiceSettings, voice: { model: string; voice: string }): string {
  return sha256(JSON.stringify({ v: LOCK_VERSION, text: line.text, direction: v.direction, model: voice.model, voice: voice.voice, format: 'mp3' }));
}

export interface Mp3Info {
  frames: number;
  ms: number;
  sampleRate: number;
  kbps: number;
  channels: number;
}

const BITRATES: Record<string, number[]> = {
  // MPEG-1 Layer III, MPEG-2/2.5 Layer III (kbps by index 1..14).
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/**
 * Walks the MPEG Layer III frames of an MP3: frame count, duration and
 * average bitrate. Returns null unless frames (after an optional ID3v2 tag)
 * cover the file, at least 5 of them.
 */
export function mp3Info(b: Uint8Array): Mp3Info | null {
  let i = 0;
  if (b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    i = 10 + (((b[6] ?? 0) & 0x7f) << 21) + (((b[7] ?? 0) & 0x7f) << 14) + (((b[8] ?? 0) & 0x7f) << 7) + ((b[9] ?? 0) & 0x7f);
  }
  const start = i;
  let frames = 0;
  let samples = 0;
  let bits = 0;
  let sampleRate = 0;
  let channels = 0;
  while (i + 4 <= b.length) {
    const h1 = b[i + 1] ?? 0;
    const h2 = b[i + 2] ?? 0;
    if (b[i] !== 0xff || (h1 & 0xe0) !== 0xe0) break;
    const ver = (h1 >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    const layer = (h1 >> 1) & 3; // 1 = Layer III
    const bi = h2 >> 4;
    const si = (h2 >> 2) & 3;
    if (ver === 1 || layer !== 1 || bi === 0 || bi === 15 || si === 3) break;
    const kbps = (ver === 3 ? BITRATES.v1 : BITRATES.v2)?.[bi] ?? 0;
    const sr = RATES[ver]?.[si] ?? 0;
    const pad = (h2 >> 1) & 1;
    const spf = ver === 3 ? 1152 : 576;
    const len = Math.floor(((spf / 8) * kbps * 1000) / sr) + pad;
    if (len < 4) break;
    frames++;
    samples += spf;
    bits += kbps * 1000 * (spf / sr);
    sampleRate = sr;
    channels = ((b[i + 3] ?? 0) >> 6) === 3 ? 1 : 2;
    i += len;
  }
  // Frames must run to (about) the end: an ID3v1 tag or a little padding may follow.
  if (frames < 5 || Math.min(i, b.length) - start < (b.length - start) * 0.9) return null;
  const secs = samples / sampleRate;
  return { frames, ms: Math.round(secs * 1000), sampleRate, kbps: Math.round(bits / secs / 1000), channels };
}

export interface RunOptions {
  root?: string;
  fetch?: typeof fetch;
  /** Only ever called when a request is about to be made. */
  readKey?: () => string;
  log?: (msg: string) => void;
  force?: boolean;
  dryRun?: boolean;
  concurrency?: number;
  retries?: number;
  retryDelayMs?: number;
}

export interface RunResult {
  generated: string[];
  skipped: string[];
  removed: string[];
  bytes: number;
}

export function readKeyFile(file = KEY_FILE): string {
  let key = '';
  try {
    key = readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error(`cannot read the MiMo API key file ${file}`);
  }
  if (!key) throw new Error(`the MiMo API key file ${file} is empty`);
  return key;
}

interface TtsRequest {
  model: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  audio: { format: 'mp3'; voice?: string };
  stream: false;
}

/** The chat-completions body for one line in the configured voice. */
export function lineRequest(p: Paths, v: VoiceSettings, text: string): TtsRequest {
  const messages: TtsRequest['messages'] = [
    { role: 'user', content: v.direction },
    { role: 'assistant', content: text },
  ];
  if (v.use === 'builtin') return { model: v.builtin.model, messages, audio: { format: 'mp3', voice: v.builtin.voice }, stream: false };
  const ref = readFileSync(join(p.voices, v.clone.reference)).toString('base64');
  if (ref.length > 10_000_000) throw new Error('reference clip too large for voiceclone (10 MB base64 limit)');
  return { model: v.clone.model, messages, audio: { format: 'mp3', voice: `data:audio/mpeg;base64,${ref}` }, stream: false };
}

export function designRequest(v: VoiceSettings): TtsRequest {
  return {
    model: v.design.model,
    messages: [
      { role: 'user', content: v.design.description },
      { role: 'assistant', content: v.design.text },
    ],
    audio: { format: 'mp3' },
    stream: false,
  };
}

class ApiError extends Error {
  readonly status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One TTS call, retried on 429/5xx. The key is redacted from anything that could reach a log. */
async function synthesize(body: TtsRequest, key: string, o: Required<Pick<RunOptions, 'fetch' | 'retries' | 'retryDelayMs'>>): Promise<Uint8Array> {
  const redact = (s: string) => (key ? s.split(key).join('[key]') : s);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await o.fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new ApiError(res.status, `MiMo HTTP ${res.status}: ${redact((await res.text()).slice(0, 400))}`);
      const j = (await res.json()) as { choices?: Array<{ finish_reason?: string; message?: { audio?: { data?: string } } }> };
      const c = j.choices?.[0];
      const data = c?.message?.audio?.data;
      if (c?.finish_reason !== 'stop' || !data) throw new ApiError(0, `MiMo returned no complete audio (finish_reason ${JSON.stringify(c?.finish_reason ?? null)})`);
      return new Uint8Array(Buffer.from(data, 'base64'));
    } catch (e) {
      const status = e instanceof ApiError ? e.status : -1;
      const retry = status === 429 || status >= 500 || status === -1;
      if (!retry || attempt >= o.retries) throw new Error(redact(e instanceof Error ? e.message : String(e)));
      await sleep(o.retryDelayMs * 2 ** attempt);
    }
  }
}

function clipFiles(p: Paths): string[] {
  return existsSync(p.clips) ? readdirSync(p.clips).filter((f) => f.endsWith('.mp3')) : [];
}

export interface Audit {
  /** Lines without a clip. */
  missing: string[];
  /** Clips without a line. */
  orphans: string[];
  /** Lines whose text or voice changed since their clip was made (or with no lock entry). */
  stale: string[];
  /** Clips that aren't valid MP3. */
  broken: string[];
  /** Clips whose sha256, size or length isn't what the lock recorded: swapped, edited or regenerated by hand. */
  mismatched: string[];
  bytes: number;
}

/** Manifest vs committed clips vs lock, without calling anything. */
export function audit(root = GAME_DIR): Audit {
  const p = paths(root);
  const m = loadManifest(p);
  const lock = loadLock(p);
  const files = new Set(clipFiles(p));
  const ids = new Set(m.lines.map((l) => l.id));
  let voice: { model: string; voice: string } | null = null;
  try {
    voice = voiceKey(p, m.voice);
  } catch {
    voice = null; // no reference clip: every line is stale
  }
  const a: Audit = { missing: [], orphans: [], stale: [], broken: [], mismatched: [], bytes: 0 };
  for (const l of m.lines) {
    const f = `${l.id}.mp3`;
    if (!files.has(f)) {
      a.missing.push(l.id);
      continue;
    }
    const buf = readFileSync(join(p.clips, f));
    a.bytes += buf.length;
    const info = mp3Info(buf);
    if (!info) a.broken.push(l.id);
    const e = lock.lines[l.id];
    if (!voice || e?.hash !== lineHash(l, m.voice, voice)) a.stale.push(l.id);
    if (e && (e.sha256 !== sha256(buf) || e.bytes !== buf.length || e.ms !== info?.ms)) a.mismatched.push(l.id);
  }
  for (const f of files) if (!ids.has(f.slice(0, -4))) a.orphans.push(f);
  return a;
}

/**
 * Re-records the sha256, size and length of every committed clip in the lock,
 * keeping each line's hash: for a clip edited on purpose (trimmed, say). Only
 * lines that already have a lock entry and a valid MP3 are touched, so a stale
 * or missing line stays stale or missing. Reads no key and calls nothing.
 */
export function relock(o: Pick<RunOptions, 'root' | 'log'> = {}): string[] {
  const p = paths(o.root);
  const log = o.log ?? ((s: string) => console.log(s));
  const m = loadManifest(p);
  const lock = loadLock(p);
  const done: string[] = [];
  for (const l of m.lines) {
    const e = lock.lines[l.id];
    const f = join(p.clips, `${l.id}.mp3`);
    if (!e || !existsSync(f)) continue;
    const buf = readFileSync(f);
    const info = mp3Info(buf);
    if (!info) {
      log(`  ${l.id}: not an MP3, left alone`);
      continue;
    }
    const next = { hash: e.hash, sha256: sha256(buf), bytes: buf.length, ms: info.ms };
    if (next.sha256 !== e.sha256 || next.bytes !== e.bytes || next.ms !== e.ms) done.push(l.id);
    lock.lines[l.id] = next;
  }
  saveLock(p, m, lock);
  log(`relocked ${done.length} clip(s)${done.length ? `: ${done.join(', ')}` : ''}`);
  return done;
}

/** Generates what's missing or changed, removes clips of deleted lines. */
export async function run(o: RunOptions = {}): Promise<RunResult> {
  const p = paths(o.root);
  const log = o.log ?? ((s: string) => console.log(s));
  const m = loadManifest(p);
  const lock = loadLock(p);
  const voice = voiceKey(p, m.voice);
  mkdirSync(p.clips, { recursive: true });

  const out: RunResult = { generated: [], skipped: [], removed: [], bytes: 0 };
  const todo: Array<{ line: VoiceLine; hash: string }> = [];
  for (const l of m.lines) {
    const hash = lineHash(l, m.voice, voice);
    const file = join(p.clips, `${l.id}.mp3`);
    if (!o.force && lock.lines[l.id]?.hash === hash && existsSync(file)) out.skipped.push(l.id);
    else todo.push({ line: l, hash });
  }
  const ids = new Set(m.lines.map((l) => l.id));
  for (const f of clipFiles(p)) {
    const id = f.slice(0, -4);
    if (ids.has(id)) continue;
    out.removed.push(id);
    if (!o.dryRun) rmSync(join(p.clips, f));
  }
  for (const id of Object.keys(lock.lines)) if (!ids.has(id)) delete lock.lines[id];

  log(`voice: ${m.voice.use === 'clone' ? `${m.voice.clone.model}, cloned from voices/${m.voice.clone.reference}` : `${m.voice.builtin.model}, built-in ${m.voice.builtin.voice}`}`);
  log(`${todo.length} to generate, ${out.skipped.length} up to date, ${out.removed.length} removed`);
  if (o.dryRun) {
    for (const t of todo) log(`  would generate ${t.line.id}: ${t.line.text}`);
    out.generated = todo.map((t) => t.line.id);
    return out;
  }

  if (todo.length) {
    const key = (o.readKey ?? readKeyFile)();
    const call = { fetch: o.fetch ?? fetch, retries: o.retries ?? 3, retryDelayMs: o.retryDelayMs ?? 2000 };
    const queue = [...todo];
    const worker = async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        const audio = await synthesize(lineRequest(p, m.voice, t.line.text), key, call);
        const info = mp3Info(audio);
        if (!info) throw new Error(`${t.line.id}: the response is not an MP3`);
        writeAtomic(join(p.clips, `${t.line.id}.mp3`), audio);
        lock.lines[t.line.id] = { hash: t.hash, sha256: sha256(audio), bytes: audio.length, ms: info.ms };
        saveLock(p, m, lock); // after every clip: an interrupted run keeps what it made
        out.generated.push(t.line.id);
        log(`  ${t.line.id}: ${(info.ms / 1000).toFixed(2)} s, ${(audio.length / 1024).toFixed(1)} KB, ${info.kbps} kb/s ${info.sampleRate / 1000} kHz`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 3, todo.length)) }, worker));
  }
  saveLock(p, m, lock);
  for (const l of m.lines) {
    const f = join(p.clips, `${l.id}.mp3`);
    if (existsSync(f)) out.bytes += statSync(f).size;
  }
  log(`clips: ${m.lines.length}, ${(out.bytes / 1024).toFixed(1)} KB in total`);
  return out;
}

/** `takes` voice-design takes of the reference script, into `dir`. */
export async function design(o: RunOptions & { takes?: number; out?: string } = {}): Promise<string[]> {
  const p = paths(o.root);
  const log = o.log ?? ((s: string) => console.log(s));
  const m = loadManifest(p);
  const dir = o.out ?? mkdtempSync(join(tmpdir(), 'h3d-voice-takes-'));
  mkdirSync(dir, { recursive: true });
  const key = (o.readKey ?? readKeyFile)();
  const call = { fetch: o.fetch ?? fetch, retries: o.retries ?? 3, retryDelayMs: o.retryDelayMs ?? 2000 };
  const files: string[] = [];
  for (let i = 1; i <= (o.takes ?? 3); i++) {
    const audio = await synthesize(designRequest(m.voice), key, call);
    const info = mp3Info(audio);
    if (!info) throw new Error(`take ${i}: the response is not an MP3`);
    const f = join(dir, `take-${i}.mp3`);
    writeAtomic(f, audio);
    files.push(f);
    log(`  ${f}: ${(info.ms / 1000).toFixed(2)} s, ${(audio.length / 1024).toFixed(1)} KB, ${info.kbps} kb/s ${info.sampleRate / 1000} kHz`);
  }
  log(`copy the take you like to ${join(p.voices, m.voice.clone.reference)}, then run \`node tools/voices.ts\``);
  return files;
}

function info(root = GAME_DIR): void {
  const p = paths(root);
  let total = 0;
  let ms = 0;
  for (const f of clipFiles(p).sort()) {
    const buf = readFileSync(join(p.clips, f));
    const i = mp3Info(buf);
    total += buf.length;
    ms += i?.ms ?? 0;
    console.log(`${f.padEnd(28)} ${i ? `${(i.ms / 1000).toFixed(2)} s  ${i.kbps} kb/s  ${i.sampleRate / 1000} kHz  ${i.channels === 1 ? 'mono' : 'stereo'}` : 'NOT AN MP3'}  ${(buf.length / 1024).toFixed(1)} KB`);
  }
  console.log(`total: ${(total / 1024).toFixed(1)} KB, ${(ms / 1000).toFixed(1)} s of audio`);
}

async function main(argv: string[]): Promise<number> {
  const flag = (f: string) => argv.includes(f);
  const value = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv[0] === 'design') {
    const takes = Number(value('--takes') ?? 3);
    const out = value('--out');
    await design({ takes, ...(out ? { out: resolve(out) } : {}) });
    return 0;
  }
  if (argv[0] === 'info') {
    info();
    return 0;
  }
  if (flag('--check')) {
    const a = audit();
    const bad = [
      ...a.missing.map((x) => `missing clip: ${x}`),
      ...a.orphans.map((x) => `orphan clip: ${x}`),
      ...a.stale.map((x) => `stale clip: ${x}`),
      ...a.broken.map((x) => `not an MP3: ${x}`),
      ...a.mismatched.map((x) => `clip differs from the lock: ${x} (restore it from git, or \`--relock\` if you edited it on purpose)`),
    ];
    for (const b of bad) console.error(b);
    console.log(
      bad.length
        ? `${bad.length} problem(s); \`node tools/voices.ts\` makes missing and stale clips and deletes orphans`
        : `clips match the manifest and the lock (${(a.bytes / 1024).toFixed(1)} KB)`,
    );
    return bad.length ? 1 : 0;
  }
  if (flag('--relock')) {
    relock();
    return 0;
  }
  await run({ force: flag('--force'), dryRun: flag('--dry-run') });
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`voices: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
