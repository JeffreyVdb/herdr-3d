// Fetches, transcodes and audits the office radio's music (M15).
//
//   node tools/music.ts                  fetch every track that is missing or changed: download (or take it from
//                                        music/incoming/), check its sha256, transcode to Ogg Opus 96 kb/s,
//                                        loudness-normalised (EBU R128, two-pass loudnorm) to the manifest's target
//   node tools/music.ts --dry-run        list what would be fetched (no download, no ffmpeg)
//   node tools/music.ts --check          exit 1 unless the manifest, the lock and public/music agree (no network,
//                                        no ffmpeg)
//   node tools/music.ts --check --release  the same, and fail while any row is claimStatus "hold"
//   node tools/music.ts --pin            first fetch of a new row (or a reviewed upstream change): record the
//                                        source's sha256 and the output's length and loudness in the manifest
//   node tools/music.ts --force          transcode every track again
//   node tools/music.ts --only <id|genre>   limit fetch / pin / proof to one row or one genre
//   node tools/music.ts --jobs <n>       tracks transcoded at once (default 2)
//   node tools/music.ts --proof          archive each row's source page (and claim statement page) into music/proof/
//   node tools/music.ts credits [--out <file>]   write MUSIC_CREDITS.txt (default: dist/MUSIC_CREDITS.txt)
//   node tools/music.ts testclips [--out <dir>]  the tiny generated clips the Playwright radio spec plays (one tone per
//                                        genre, 90 s, mostly silence): default e2e/fixtures/music/
//
// Inputs: music/manifest.json (one row per recording: license, attribution, claim status, proof, sha256, length,
// loudness). Outputs: public/music/<genre>/<id>.ogg (git-ignored: ~60 MB) and music/music.lock.json (the source's
// and the output's sha256 and size, and the encoder). `ffmpeg` from PATH is used when there is one, else the
// pinned `ffmpeg-static` devDependency. Rows whose source needs a sign-in (empty downloadUrl) take the file from
// music/incoming/<id>.<ext>, still checked against the manifest's sha256.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { creditsText, GENRES, isGenre, type MusicRow, type Manifest } from '../src/audio/tracks.ts';

export const GAME_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_VERSION = 1;
export const BITRATE = '96k';
export const MIN_PER_GENRE = 5;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) herdr-3d-music-fetch';
const MAX_BYTES = 120 * 1024 * 1024;

export interface Paths {
  root: string;
  manifest: string;
  lock: string;
  /** Archived pages, relative paths in the manifest resolve against `root`. */
  proof: string;
  incoming: string;
  cache: string;
  out: string;
}

export function paths(root = GAME_DIR): Paths {
  return {
    root,
    manifest: join(root, 'music', 'manifest.json'),
    lock: join(root, 'music', 'music.lock.json'),
    proof: join(root, 'music', 'proof'),
    incoming: join(root, 'music', 'incoming'),
    cache: join(root, 'music', '.cache'),
    out: join(root, 'public', 'music'),
  };
}

export const outFile = (p: Paths, r: Pick<MusicRow, 'genre' | 'id'>) => join(p.out, r.genre, `${r.id}.ogg`);

const sha256 = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Writes via a sibling temp file and a rename, so a crash never leaves half a file. */
function writeAtomic(file: string, data: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

// ---- manifest and lock -----------------------------------------------------------------------

export function loadManifest(p: Paths): Manifest {
  const m = JSON.parse(readFileSync(p.manifest, 'utf8')) as Partial<Manifest>;
  if (typeof m.targetLufs !== 'number' || !Array.isArray(m.tracks)) throw new Error(`${p.manifest}: expected { targetLufs, tracks: [] }`);
  return { targetLufs: m.targetLufs, tracks: m.tracks };
}

export function saveManifest(p: Paths, m: Manifest): void {
  writeAtomic(p.manifest, `${JSON.stringify(m, null, 2)}\n`);
}

export interface LockEntry {
  /** The downloaded (or hand-fetched) source. */
  src: { sha256: string; bytes: number };
  /** The transcoded file. */
  out: { sha256: string; bytes: number; durationSec: number; lufs: number };
  /** Hash of what shapes the output (target loudness, bitrate): a change means transcoding again. */
  settings: string;
}

export interface Lock {
  version: number;
  /** The ffmpeg that made the outputs: their sha256 is only comparable to another build of the same version. */
  encoder: string;
  tracks: Record<string, LockEntry>;
}

export function loadLock(p: Paths): Lock {
  if (!existsSync(p.lock)) return { version: LOCK_VERSION, encoder: '', tracks: {} };
  const l = JSON.parse(readFileSync(p.lock, 'utf8')) as Partial<Lock>;
  return { version: LOCK_VERSION, encoder: l.encoder ?? '', tracks: l.version === LOCK_VERSION && l.tracks ? l.tracks : {} };
}

function saveLock(p: Paths, m: Manifest, lock: Lock): void {
  // Manifest order, so a refetched track is one entry of diff.
  const tracks: Record<string, LockEntry> = {};
  for (const r of m.tracks) {
    const e = lock.tracks[r.id];
    if (e) tracks[r.id] = e;
  }
  writeAtomic(p.lock, `${JSON.stringify({ version: LOCK_VERSION, encoder: lock.encoder, tracks }, null, 2)}\n`);
}

export const settingsHash = (m: Manifest) => sha256(JSON.stringify({ v: LOCK_VERSION, lufs: m.targetLufs, bitrate: BITRATE, codec: 'opus' })).slice(0, 16);

// ---- the audit (vitest runs it too) ----------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LICENSES = ['CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'custom'];

/** A license URL that is NonCommercial or NoDerivatives (by-nc, by-nd, by-nc-sa, …). */
export const isNcNd = (url: string) => /creativecommons\.org\/licenses\/by-(nc|nd)/i.test(url) || /[-/](nc|nd)(-|\/|$)/i.test(new URL(url, 'https://x/').pathname);

/** What is wrong with the rows themselves (no files, no lock): the rules of the issue's Licensing section. */
export function auditRows(rows: readonly MusicRow[]): string[] {
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const at = `${r.id || '(no id)'}`;
    const need = (ok: unknown, what: string) => {
      if (!ok) bad.push(`${at}: ${what}`);
    };
    need(typeof r.id === 'string' && ID.test(r.id), 'id must be kebab-case');
    need(!seen.has(r.id), 'duplicate id');
    seen.add(r.id);
    need(isGenre(r.genre), `unknown genre ${String(r.genre)}`);
    need(r.title?.trim(), 'no title');
    need(r.artist?.trim(), 'no artist');
    need(/^https:\/\//.test(r.sourceUrl ?? ''), 'sourceUrl must be an https URL');
    need(r.downloadUrl === '' || /^https:\/\//.test(r.downloadUrl ?? ''), 'downloadUrl must be an https URL, or empty for a manual download');
    need(LICENSES.includes(r.license), `license must be one of ${LICENSES.join(', ')}`);
    need(/^https:\/\//.test(r.licenseUrl ?? ''), 'licenseUrl must be an https URL');
    if (r.licenseUrl && isNcNd(r.licenseUrl)) bad.push(`${at}: NC / ND license (${r.licenseUrl}) is not allowed in a game we sell`);
    if (r.license === 'CC-BY-3.0' || r.license === 'CC-BY-4.0') {
      need(r.attribution?.trim(), 'a CC BY track needs its exact attribution string');
      need(!r.attribution || r.attribution.includes(r.title), 'the attribution must name the title');
      need(!r.attribution || r.attribution.includes(r.licenseUrl), 'the attribution must link the license');
    }
    if (r.license === 'CC0-1.0') need(r.attribution === null, 'a CC0 track has no attribution (null)');
    if (r.license === 'custom') need(r.note?.trim(), 'a custom license needs a note saying what grants it');
    need(r.claimStatus === 'cleared' || r.claimStatus === 'hold', 'claimStatus must be cleared or hold');
    if (r.claimStatus === 'cleared') {
      need(/^https:\/\//.test(r.claimUrl ?? ''), 'a cleared track needs the claimUrl of the publisher’s not-registered statement');
      need(r.claimProof?.trim(), 'a cleared track needs its claimProof (archived statement)');
    }
    need(DATE.test(r.verifiedAt ?? ''), 'verifiedAt must be YYYY-MM-DD');
    need(r.proof?.trim(), 'no proof (archived page)');
    need(HEX64.test(r.sha256 ?? ''), 'sha256 must be the source file’s sha256 (run with --pin)');
    need(typeof r.durationSec === 'number' && r.durationSec > 0, 'durationSec must be positive');
    need(typeof r.loudnessLufs === 'number' && Number.isFinite(r.loudnessLufs), 'loudnessLufs must be a number');
  }
  for (const g of GENRES) {
    const n = rows.filter((r) => r.genre === g.id).length;
    if (n < MIN_PER_GENRE) bad.push(`${g.id}: ${n} track(s), at least ${MIN_PER_GENRE} needed`);
  }
  return bad;
}

/** Proof files named by the rows that are not on disk. */
export function missingProof(p: Paths, rows: readonly MusicRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    for (const f of [r.proof, r.claimProof]) if (f && !existsSync(join(p.root, f))) out.push(`${r.id}: proof file ${f} is missing`);
  }
  return out;
}

/** Rows still on claim hold: a release build must not ship them. */
export function holdRows(rows: readonly MusicRow[]): string[] {
  return rows.filter((r) => r.claimStatus !== 'cleared').map((r) => `${r.id}: claimStatus is ${r.claimStatus}`);
}

/** The manifest's per-row numbers against the lock's (both are committed). */
export function auditLock(m: Manifest, lock: Lock): string[] {
  const bad: string[] = [];
  const ids = new Set(m.tracks.map((r) => r.id));
  for (const r of m.tracks) {
    const e = lock.tracks[r.id];
    if (!e) {
      bad.push(`${r.id}: not in the lock (run the fetch)`);
      continue;
    }
    if (e.src.sha256 !== r.sha256) bad.push(`${r.id}: the lock’s source sha256 differs from the manifest’s`);
    if (Math.abs(e.out.durationSec - r.durationSec) > 0.05) bad.push(`${r.id}: length ${r.durationSec} s in the manifest, ${e.out.durationSec} s in the lock`);
    if (Math.abs(e.out.lufs - r.loudnessLufs) > 0.05) bad.push(`${r.id}: ${r.loudnessLufs} LUFS in the manifest, ${e.out.lufs} in the lock`);
    if (e.settings !== settingsHash(m)) bad.push(`${r.id}: made with other settings than the manifest’s (fetch with --force)`);
  }
  for (const id of Object.keys(lock.tracks)) if (!ids.has(id)) bad.push(`${id}: in the lock but not in the manifest`);
  return bad;
}

export interface OggInfo {
  channels: number;
  durationSec: number;
}

/** Reads an Ogg Opus file's head and last page: null unless it is one. No ffmpeg needed. */
export function oggOpusInfo(b: Uint8Array): OggInfo | null {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (buf.length < 64 || buf.toString('latin1', 0, 4) !== 'OggS') return null;
  const head = buf.indexOf('OpusHead', 0, 'latin1');
  if (head < 0 || head > 128) return null;
  const channels = buf[head + 9] ?? 0;
  const preSkip = buf.readUInt16LE(head + 10);
  const last = buf.lastIndexOf('OggS', buf.length - 27, 'latin1');
  if (last < 0) return null;
  const granule = buf.readBigInt64LE(last + 6);
  if (granule < 0n) return null;
  return { channels, durationSec: Math.round(((Number(granule) - preSkip) / 48000) * 100) / 100 };
}

export interface CheckResult {
  problems: string[];
  files: number;
  bytes: number;
  /** Notes that are not failures (a different encoder build: hashes not compared). */
  notes: string[];
}

/** `--check`: the manifest audit, the lock, the proof files and the transcoded files on disk. */
export function check(o: { root?: string; release?: boolean; currentEncoder?: () => string } = {}): CheckResult {
  const p = paths(o.root);
  const m = loadManifest(p);
  const lock = loadLock(p);
  const problems = [...auditRows(m.tracks), ...missingProof(p, m.tracks), ...auditLock(m, lock)];
  const notes: string[] = [];
  if (o.release) problems.push(...holdRows(m.tracks).map((x) => `release: ${x}`));
  let files = 0;
  let bytes = 0;
  let hashes = true;
  const encoder = (o.currentEncoder ?? (() => ''))();
  if (encoder && lock.encoder && encoder !== lock.encoder) {
    hashes = false;
    notes.push(`the lock was made with ${lock.encoder}, this is ${encoder}: output hashes not compared`);
  }
  for (const r of m.tracks) {
    const f = outFile(p, r);
    if (!existsSync(f)) {
      problems.push(`${r.id}: no ${f.slice(p.root.length + 1)} (run \`pnpm music\`)`);
      continue;
    }
    const buf = readFileSync(f);
    files++;
    bytes += buf.length;
    const info = oggOpusInfo(buf);
    if (!info) {
      problems.push(`${r.id}: not an Ogg Opus file`);
      continue;
    }
    if (Math.abs(info.durationSec - r.durationSec) > 0.1) problems.push(`${r.id}: the file is ${info.durationSec} s, the manifest says ${r.durationSec} s`);
    const e = lock.tracks[r.id];
    if (e && hashes && (sha256(buf) !== e.out.sha256 || buf.length !== e.out.bytes)) problems.push(`${r.id}: the file differs from the lock (fetch it again with --force)`);
  }
  return { problems, files, bytes, notes };
}

// ---- ffmpeg ----------------------------------------------------------------------------------

export interface Ffmpeg {
  path: string;
  /** e.g. "ffmpeg 7.0.2-static": what the lock records. */
  version: string;
  /** Runs it; resolves to stderr (where ffmpeg logs) and rejects on a non-zero exit. */
  run(args: string[]): Promise<string>;
}

/** `H3D_FFMPEG`, `ffmpeg` on PATH, else the pinned `ffmpeg-static`; null when there is none. */
export function findFfmpeg(): Ffmpeg | null {
  const candidates: string[] = [];
  if (process.env.H3D_FFMPEG) candidates.push(process.env.H3D_FFMPEG);
  candidates.push('ffmpeg');
  try {
    const s = createRequire(import.meta.url)('ffmpeg-static') as string | null;
    if (s) candidates.push(s);
  } catch {
    // Not installed: only PATH.
  }
  for (const path of candidates) {
    const v = spawnSync(path, ['-version'], { encoding: 'utf8' });
    if (v.status !== 0) continue;
    const version = /^ffmpeg version (\S+)/m.exec(v.stdout)?.[1] ?? 'unknown';
    return {
      path,
      version: `ffmpeg ${version}`,
      run(args) {
        return new Promise((res, rej) => {
          const c = spawn(path, ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
          const err: Buffer[] = [];
          c.stderr.on('data', (d: Buffer) => err.push(d));
          c.on('error', rej);
          c.on('close', (code) => {
            const text = Buffer.concat(err).toString('utf8');
            if (code === 0) res(text);
            else rej(new Error(`ffmpeg ${args.slice(0, 4).join(' ')}… failed (${code}): ${text.split('\n').slice(-6).join('\n')}`));
          });
        });
      },
    };
  }
  return null;
}

const last = <T>(a: T[]): T | undefined => a[a.length - 1];

/** First pass of loudnorm: the source's measured loudness (the JSON ffmpeg prints). */
export async function measureSource(ff: Ffmpeg, src: string, target: number): Promise<Record<string, string>> {
  const err = await ff.run(['-i', src, '-vn', '-af', `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-']);
  const start = err.lastIndexOf('{');
  const end = err.indexOf('}', start);
  if (start < 0 || end < 0) throw new Error('loudnorm printed no measurement');
  return JSON.parse(err.slice(start, end + 1)) as Record<string, string>;
}

/** Integrated loudness (LUFS) of a file, EBU R128. */
export async function measureLufs(ff: Ffmpeg, file: string): Promise<number> {
  const err = await ff.run(['-i', file, '-vn', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-']);
  const m = last([...err.matchAll(/^\s*I:\s+(-?\d+(?:\.\d+)?) LUFS/gm)]);
  if (!m) throw new Error('ebur128 printed no summary');
  return Number(m[1]);
}

/** Two-pass loudnorm to `target` LUFS, then Ogg Opus at 96 kb/s. Bit-exact (no encoder string in the file). */
export async function transcode(ff: Ffmpeg, src: string, dst: string, target: number, meta: { title: string; artist: string; license: string }): Promise<void> {
  const m = await measureSource(ff, src, target);
  const filter = [
    `loudnorm=I=${target}:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
    'aresample=48000',
  ].join(',');
  await ff.run([
    '-y', '-i', src, '-vn', '-map', '0:a:0', '-map_metadata', '-1', '-af', filter,
    '-c:a', 'libopus', '-b:a', BITRATE, '-vbr', 'on', '-application', 'audio', '-compression_level', '10',
    '-fflags', '+bitexact', '-flags:a', '+bitexact',
    '-metadata', `title=${meta.title}`, '-metadata', `artist=${meta.artist}`, '-metadata', `comment=${meta.license}`,
    '-f', 'ogg', dst,
  ]);
}

// ---- fetch -----------------------------------------------------------------------------------

export interface RunOptions {
  root?: string;
  dryRun?: boolean;
  force?: boolean;
  /** Record the source's sha256 and the output's length / loudness in the manifest (new rows, reviewed upstream changes). */
  pin?: boolean;
  /** A row id or a genre. */
  only?: string;
  /** Tracks transcoded at once (default 2). */
  jobs?: number;
  fetch?: typeof fetch;
  ffmpeg?: Ffmpeg | null;
  log?: (s: string) => void;
}

export interface RunResult {
  fetched: string[];
  skipped: string[];
  /** Rows waiting for a file in music/incoming/. */
  manual: string[];
  failed: Array<{ id: string; error: string }>;
}

function selected(m: Manifest, only?: string): MusicRow[] {
  if (!only) return m.tracks;
  const rows = m.tracks.filter((r) => r.id === only || r.genre === only);
  if (!rows.length) throw new Error(`--only ${only}: no such row or genre`);
  return rows;
}

const incomingFile = (p: Paths, r: MusicRow): string | null => {
  if (!existsSync(p.incoming)) return null;
  const f = readdirSync(p.incoming).find((n) => n.startsWith(`${r.id}.`));
  return f ? join(p.incoming, f) : null;
};

async function download(r: MusicRow, dst: string, f: typeof fetch): Promise<Uint8Array> {
  const res = await f(r.downloadUrl, { redirect: 'follow', headers: { 'user-agent': USER_AGENT, referer: r.sourceUrl } });
  if (!res.ok) throw new Error(`${r.downloadUrl}: HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (/text\/html/i.test(type)) throw new Error(`${r.downloadUrl}: got a web page, not audio (a login or hotlink redirect?): download it by hand into music/incoming/${r.id}.<ext>`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`${r.downloadUrl}: ${buf.length} bytes is over the ${MAX_BYTES} cap`);
  if (buf.length < 10_000) throw new Error(`${r.downloadUrl}: only ${buf.length} bytes`);
  writeAtomic(dst, buf);
  return buf;
}

/** Fetches, verifies and transcodes what is missing or changed. */
export async function run(o: RunOptions = {}): Promise<RunResult> {
  const p = paths(o.root);
  const log = o.log ?? ((s: string) => console.log(s));
  const m = loadManifest(p);
  const lock = loadLock(p);
  const rows = selected(m, o.only);
  const settings = settingsHash(m);
  const out: RunResult = { fetched: [], skipped: [], manual: [], failed: [] };

  const upToDate = (r: MusicRow): boolean => {
    const e = lock.tracks[r.id];
    const f = outFile(p, r);
    if (o.force || !e || e.settings !== settings || !r.sha256 || e.src.sha256 !== r.sha256 || !existsSync(f)) return false;
    return statSync(f).size === e.out.bytes && sha256(readFileSync(f)) === e.out.sha256;
  };
  const todo = rows.filter((r) => !upToDate(r));
  out.skipped = rows.filter((r) => !todo.includes(r)).map((r) => r.id);
  log(`${todo.length} to fetch, ${out.skipped.length} up to date`);
  if (o.dryRun) {
    for (const r of todo) log(`  would fetch ${r.id}: ${incomingFile(p, r) ? 'from music/incoming/' : r.downloadUrl || 'MANUAL: put the file in music/incoming/'}`);
    out.fetched = todo.map((r) => r.id);
    return out;
  }
  if (!todo.length) return out;
  const ff = o.ffmpeg === undefined ? findFfmpeg() : o.ffmpeg;
  if (!ff) throw new Error('no ffmpeg: install it, set H3D_FFMPEG, or `pnpm install` (the pinned ffmpeg-static; pnpm 11 must allow its install script: see pnpm-workspace.yaml)');
  mkdirSync(p.cache, { recursive: true });
  lock.encoder = ff.version;

  const one = async (r: MusicRow): Promise<void> => {
    try {
      const manual = incomingFile(p, r);
      let src = manual ?? join(p.cache, `${r.id}.src`);
      let srcBytes: Uint8Array | null = null;
      if (!manual) {
        if (!r.downloadUrl) {
          out.manual.push(r.id);
          log(`  ${r.id}: no direct download (sign-in): save the file as music/incoming/${r.id}.<ext>, then run again`);
          return;
        }
        // A cached download of the right file is reused.
        if (existsSync(src)) srcBytes = readFileSync(src);
        if (!srcBytes || (r.sha256 && sha256(srcBytes) !== r.sha256)) {
          log(`  ${r.id}: downloading ${r.downloadUrl}`);
          srcBytes = await download(r, src, o.fetch ?? fetch);
        }
      } else srcBytes = readFileSync(src);
      const srcHash = sha256(srcBytes);
      if (r.sha256 && srcHash !== r.sha256 && !o.pin) {
        throw new Error(`the source's sha256 is ${srcHash}, the manifest says ${r.sha256}: the file changed upstream or is the wrong one (review it, then --pin)`);
      }
      const tmp = join(p.cache, `${r.id}.ogg`);
      await transcode(ff, src, tmp, m.targetLufs, { title: r.title, artist: r.artist, license: r.license });
      const bytes = readFileSync(tmp);
      const info = oggOpusInfo(bytes);
      if (!info) throw new Error('the transcode is not an Ogg Opus file');
      const lufs = Math.round((await measureLufs(ff, tmp)) * 10) / 10;
      const entry: LockEntry = { src: { sha256: srcHash, bytes: srcBytes.length }, out: { sha256: sha256(bytes), bytes: bytes.length, durationSec: info.durationSec, lufs }, settings };
      if (o.pin || !r.sha256) {
        if (!o.pin) throw new Error('no sha256 in the manifest yet: run with --pin to record it from this download');
        if (r.sha256 && r.sha256 !== srcHash) log(`  ${r.id}: WARNING the source changed upstream: sha256 re-pinned, review the archived page and the license again`);
        r.sha256 = srcHash;
        r.durationSec = info.durationSec;
        r.loudnessLufs = lufs;
        saveManifest(p, m);
      } else {
        if (Math.abs(info.durationSec - r.durationSec) > 0.1) throw new Error(`the output is ${info.durationSec} s, the manifest says ${r.durationSec} s (a different ffmpeg? --pin after checking)`);
        if (Math.abs(lufs - r.loudnessLufs) > 0.3) throw new Error(`the output is ${lufs} LUFS, the manifest says ${r.loudnessLufs} (a different ffmpeg? --pin after checking)`);
        entry.out.durationSec = r.durationSec;
        entry.out.lufs = r.loudnessLufs;
      }
      mkdirSync(dirname(outFile(p, r)), { recursive: true });
      copyFileSync(tmp, `${outFile(p, r)}.tmp`);
      renameSync(`${outFile(p, r)}.tmp`, outFile(p, r));
      rmSync(tmp);
      lock.tracks[r.id] = entry;
      saveLock(p, m, lock); // after every track: an interrupted run keeps what it made
      out.fetched.push(r.id);
      log(`  ${r.id}: ${info.durationSec.toFixed(1)} s, ${lufs} LUFS, ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);
    } catch (e) {
      out.failed.push({ id: r.id, error: e instanceof Error ? e.message : String(e) });
      log(`  ${r.id}: FAILED: ${out.failed[out.failed.length - 1]?.error}`);
    }
  };
  const queue = [...todo];
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) await one(r);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.jobs ?? 2, todo.length)) }, worker));
  saveLock(p, m, lock);
  return out;
}

// ---- proof: archived pages -------------------------------------------------------------------

/** A page without scripts, styles, inline SVG and embedded blobs: what a reviewer reads, a fraction of the size. */
export function stripPage(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, '')
    .replace(/<link\b[^>]*rel=["']?(?:stylesheet|preload|modulepreload|preconnect|dns-prefetch|icon)[^>]*>/gi, '')
    .replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]{200,}/g, 'data:…')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

const norm = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\/deed(\.[a-z_A-Z]+)?$/, '').replace(/\/legalcode$/, '');

/** Fetches `url` and stores its stripped copy at `dst`, with a header saying where and when it came from. */
export async function archivePage(url: string, dst: string, f: typeof fetch = fetch, now = new Date()): Promise<{ bytes: number; html: string }> {
  const res = await f(url, { redirect: 'follow', headers: { 'user-agent': USER_AGENT, accept: 'text/html' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const html = body.toString('utf8');
  const header = `<!-- Archived proof page. Source: ${url} | fetched: ${now.toISOString()} | HTTP ${res.status} | original body: ${body.length} bytes, sha256 ${sha256(body)} | scripts, styles, inline SVG and comments stripped by tools/music.ts -->\n`;
  writeAtomic(dst, header + stripPage(html));
  return { bytes: body.length, html };
}

/** `--proof`: archives every row's source page and claim page (each URL once, even when rows share it). */
export async function archiveProofs(o: { root?: string; only?: string; fetch?: typeof fetch; log?: (s: string) => void } = {}): Promise<string[]> {
  const p = paths(o.root);
  const log = o.log ?? ((s: string) => console.log(s));
  const m = loadManifest(p);
  const warnings: string[] = [];
  const done = new Map<string, string>();
  for (const r of selected(m, o.only)) {
    const jobs: Array<[string, string | undefined, boolean]> = [
      [r.sourceUrl, r.proof, true],
      [r.claimUrl ?? '', r.claimProof, false],
    ];
    for (const [url, rel, license] of jobs) {
      if (!url || !rel) continue;
      let html = done.get(rel);
      if (html === undefined) {
        const a = await archivePage(url, join(p.root, rel), o.fetch ?? fetch);
        html = a.html;
        done.set(rel, html);
        log(`  ${rel}: ${url} (${(a.bytes / 1024).toFixed(0)} KB)`);
      }
      if (license && !html.includes(norm(r.licenseUrl)) && !html.replace(/http:\/\//g, 'https://').includes(norm(r.licenseUrl))) {
        warnings.push(`${r.id}: its page does not link ${r.licenseUrl}: check the license by hand`);
      }
      if (license && !html.includes(r.title.replace(/&/g, '&amp;')) && !html.includes(r.title)) warnings.push(`${r.id}: its page does not mention "${r.title}"`);
    }
  }
  for (const w of warnings) log(`  WARNING ${w}`);
  return warnings;
}

// ---- e2e test clips --------------------------------------------------------------------------

/** One clip per genre for the Playwright radio spec: a 1.5 s tone (a note per genre) then silence to 90 s, 12 kb/s Ogg Opus (~12 KB). */
export async function writeTestClips(dir: string, ff: Ffmpeg): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const notes: Record<string, number> = { house: 261.63, jazz: 293.66, rock: 329.63, pop: 392, rap: 440 };
  const out: string[] = [];
  for (const g of GENRES) {
    const f = join(dir, `${g.id}.ogg`);
    await ff.run([
      '-y', '-f', 'lavfi', '-i', `sine=frequency=${notes[g.id]}:duration=1.5`, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=88.5',
      '-filter_complex', '[0:a]volume=0.2,aresample=48000[t];[t][1:a]concat=n=2:v=0:a=1', '-c:a', 'libopus', '-b:a', '12k',
      '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-f', 'ogg', f,
    ]);
    out.push(f);
  }
  return out;
}

// ---- credits ---------------------------------------------------------------------------------

export function writeCredits(out: string, root?: string): string {
  const m = loadManifest(paths(root));
  const text = creditsText(m.tracks, m.targetLufs);
  writeAtomic(out, `${text}\n`);
  return text;
}

async function main(argv: string[]): Promise<number> {
  const flag = (f: string) => argv.includes(f);
  const value = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const only = value('--only');
  if (argv[0] === 'credits') {
    const out = resolve(value('--out') ?? join(GAME_DIR, 'dist', 'MUSIC_CREDITS.txt'));
    writeCredits(out);
    console.log(`wrote ${out}`);
    return 0;
  }
  if (argv[0] === 'testclips') {
    const ff = findFfmpeg();
    if (!ff) throw new Error('no ffmpeg');
    for (const f of await writeTestClips(resolve(value('--out') ?? join(GAME_DIR, 'e2e', 'fixtures', 'music')), ff)) console.log(`wrote ${f}`);
    return 0;
  }
  if (flag('--check')) {
    const ff = findFfmpeg();
    const r = check({ release: flag('--release'), currentEncoder: () => ff?.version ?? '' });
    for (const n of r.notes) console.log(`note: ${n}`);
    for (const b of r.problems) console.error(b);
    console.log(r.problems.length ? `${r.problems.length} problem(s)` : `music ok: ${r.files} files, ${(r.bytes / 1024 / 1024).toFixed(1)} MB${flag('--release') ? ', no rows on hold' : ''}`);
    return r.problems.length ? 1 : 0;
  }
  if (flag('--proof')) {
    await archiveProofs({ ...(only ? { only } : {}) });
    return 0;
  }
  const r = await run({ force: flag('--force'), dryRun: flag('--dry-run'), pin: flag('--pin'), ...(only ? { only } : {}), ...(value('--jobs') ? { jobs: Number(value('--jobs')) } : {}) });
  if (r.manual.length) console.log(`waiting for a manual download: ${r.manual.join(', ')}`);
  if (r.failed.length) {
    console.error(`${r.failed.length} failed: ${r.failed.map((f) => f.id).join(', ')}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`music: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
