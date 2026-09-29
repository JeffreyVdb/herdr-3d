import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { creditsText, GENRES, LICENSE_NAME, MANIFEST, ROWS, type MusicRow } from '../src/audio/tracks';
import {
  archivePage,
  auditLock,
  auditRows,
  check,
  findFfmpeg,
  GAME_DIR,
  holdRows,
  isNcNd,
  loadLock,
  loadManifest,
  MIN_PER_GENRE,
  missingProof,
  oggOpusInfo,
  outFile,
  paths,
  run,
  stripPage,
  writeCredits,
} from './music';

const rows = (): MusicRow[] => structuredClone(ROWS) as MusicRow[];

/** The manifest with one row edited, and what the audit says about it. */
const problems = (edit: (r: MusicRow) => void, pick = (r: MusicRow) => r.license === 'CC-BY-4.0' && r.claimStatus === 'cleared'): string[] => {
  const all = rows();
  const r = all.find(pick) as MusicRow;
  edit(r);
  return auditRows(all).filter((p) => p.startsWith(`${r.id}:`));
};

describe('the committed music manifest', () => {
  it('passes its own audit: licenses, attribution, proof and claim status on every row, and enough tracks per genre', () => {
    expect(auditRows(ROWS)).toEqual([]);
    for (const g of GENRES) expect(ROWS.filter((r) => r.genre === g.id).length, g.id).toBeGreaterThanOrEqual(MIN_PER_GENRE);
  });

  it('has its archived proof pages, and a lock that agrees with it (source hash, length, loudness, settings)', () => {
    const p = paths();
    expect(missingProof(p, ROWS)).toEqual([]);
    expect(auditLock(MANIFEST, loadLock(p))).toEqual([]);
    expect(loadManifest(p)).toEqual(MANIFEST);
  });

  it('only ships what the licensing rule allows: CC0, CC BY 3.0 / 4.0 or a named custom grant; no NC, no ND; no Tobu', () => {
    for (const r of ROWS) {
      expect(['CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'custom'], r.id).toContain(r.license);
      expect(isNcNd(r.licenseUrl), r.id).toBe(false);
      expect(/tobu|ncs\.io|incompetech|pixabay/i.test(`${r.artist} ${r.sourceUrl} ${r.downloadUrl}`), r.id).toBe(false);
      // Claim status is one of the two, and a cleared row names the publisher's statement.
      if (r.claimStatus === 'cleared') expect(r.claimProof, r.id).toBeTruthy();
    }
  });

  it('every archived proof page says where and when it was taken and has no scripts', () => {
    const p = paths();
    for (const r of ROWS) {
      const html = readFileSync(join(p.root, r.proof), 'utf8');
      expect(html.startsWith('<!-- Archived proof page. Source: '), r.id).toBe(true);
      expect(html, r.id).toContain(r.sourceUrl);
      expect(html, r.id).not.toMatch(/<script/i);
    }
  });

  it('a release build has no track on hold: the check says which are (dev builds may)', () => {
    const hold = holdRows(ROWS);
    expect(hold.length).toBe(ROWS.filter((r) => r.claimStatus === 'hold').length);
    // The free-stock-music rows are the ones with the publisher's not-registered statement.
    expect(ROWS.filter((r) => r.claimStatus === 'cleared').length).toBeGreaterThanOrEqual(19);
    expect(hold.every((h) => /claimStatus is hold$/.test(h))).toBe(true);
  });
});

describe('the audit', () => {
  it('fails an NC or ND license', () => {
    for (const url of ['https://creativecommons.org/licenses/by-nc/4.0/', 'https://creativecommons.org/licenses/by-nd/4.0/', 'https://creativecommons.org/licenses/by-nc-sa/4.0/', 'https://creativecommons.org/licenses/by-nc-nd/3.0/']) {
      const p = problems((r) => (r.licenseUrl = url));
      expect(p.some((x) => /NC \/ ND/.test(x)), url).toBe(true);
    }
    expect(isNcNd('https://creativecommons.org/licenses/by/4.0/')).toBe(false);
    expect(isNcNd('https://creativecommons.org/publicdomain/zero/1.0/')).toBe(false);
  });

  it('fails a CC BY row without its attribution, or one that leaves out the title or the license link', () => {
    expect(problems((r) => (r.attribution = null)).some((x) => /attribution/.test(x))).toBe(true);
    expect(problems((r) => (r.attribution = '   ')).some((x) => /attribution/.test(x))).toBe(true);
    expect(problems((r) => (r.attribution = 'Music by somebody')).length).toBeGreaterThanOrEqual(2);
    expect(problems((r) => (r.attribution = `${r.title} by somebody`)).some((x) => /link the license/.test(x))).toBe(true);
    // A CC0 row has none.
    expect(problems((r) => (r.attribution = 'Thanks!'), (r) => r.license === 'CC0-1.0').some((x) => /CC0/.test(x))).toBe(true);
  });

  it('fails a row without proof, without a source hash, or a cleared row without its claim statement', () => {
    expect(problems((r) => (r.proof = '')).some((x) => /proof/.test(x))).toBe(true);
    expect(problems((r) => (r.sha256 = '')).some((x) => /sha256/.test(x))).toBe(true);
    expect(problems((r) => delete r.claimProof).some((x) => /claimProof/.test(x))).toBe(true);
    expect(problems((r) => delete r.claimUrl).some((x) => /claimUrl/.test(x))).toBe(true);
    expect(problems((r) => (r.claimStatus = 'maybe' as MusicRow['claimStatus'])).some((x) => /claimStatus/.test(x))).toBe(true);
    expect(problems((r) => (r.license = 'GPL' as MusicRow['license'])).some((x) => /license must be/.test(x))).toBe(true);
  });

  it('fails a genre with fewer than five tracks, and duplicate ids', () => {
    expect(auditRows(rows().filter((r) => r.genre !== 'jazz'))).toContain('jazz: 0 track(s), at least 5 needed');
    const pop = rows().filter((r) => r.genre === 'pop').map((r) => r.id);
    const four = rows().filter((r) => r.genre !== 'pop' || pop.slice(0, 4).includes(r.id));
    expect(auditRows(four)).toEqual(['pop: 4 track(s), at least 5 needed']);
    const dup = rows();
    (dup[1] as MusicRow).id = (dup[0] as MusicRow).id;
    expect(auditRows(dup).some((x) => /duplicate id/.test(x))).toBe(true);
  });

  it('the lock audit finds a changed source hash, a missing entry and an orphan', () => {
    const lock = structuredClone(loadLock(paths()));
    const first = MANIFEST.tracks[0] as MusicRow;
    (lock.tracks[first.id] as NonNullable<(typeof lock.tracks)[string]>).src.sha256 = '0'.repeat(64);
    delete lock.tracks[(MANIFEST.tracks[1] as MusicRow).id];
    lock.tracks.ghost = structuredClone(lock.tracks[(MANIFEST.tracks[2] as MusicRow).id]) as NonNullable<(typeof lock.tracks)[string]>;
    const p = auditLock(MANIFEST, lock);
    expect(p).toContain(`${first.id}: the lock’s source sha256 differs from the manifest’s`);
    expect(p.some((x) => x.startsWith(`${(MANIFEST.tracks[1] as MusicRow).id}: not in the lock`))).toBe(true);
    expect(p).toContain('ghost: in the lock but not in the manifest');
  });
});

describe('MUSIC_CREDITS.txt', () => {
  it('lists every manifest row: title, creator, source, license with its link, the exact credit and the changes', () => {
    const text = creditsText(ROWS);
    for (const r of ROWS) {
      expect(text, r.id).toContain(`"${r.title}" by ${r.artist}`);
      expect(text, r.id).toContain(`Source: ${r.sourceUrl}`);
      expect(text, r.id).toContain(`License: ${LICENSE_NAME[r.license]} (${r.licenseUrl})`);
      expect(text, r.id).toContain(`Credit: ${r.attribution ?? 'none required'}`);
    }
    expect(text.split('\n').filter((l) => l.startsWith('"')).length).toBe(ROWS.length);
    expect(text.split('\n').filter((l) => l.startsWith('  Changes: ')).length).toBe(ROWS.length);
    expect(text).toContain('loudness-normalised');
    for (const g of GENRES) expect(text).toContain(`\n${g.name}\n${'-'.repeat(g.name.length)}\n`);
  });

  it('is written from the manifest by the tool, byte for byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h3d-credits-'));
    try {
      const out = join(dir, 'MUSIC_CREDITS.txt');
      const text = writeCredits(out);
      expect(readFileSync(out, 'utf8')).toBe(`${creditsText(ROWS, MANIFEST.targetLufs)}\n`);
      expect(text).toBe(creditsText(ROWS, MANIFEST.targetLufs));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('proof pages', () => {
  it('strips scripts, styles, svg and comments and says where the copy came from', async () => {
    const html = '<html><head><style>a{}</style><script>evil()</script><!-- c --></head><body><p>CC BY 4.0</p><svg><path/></svg></body></html>';
    const dir = mkdtempSync(join(tmpdir(), 'h3d-proof-'));
    try {
      const dst = join(dir, 'p.html');
      const f = (async () => new Response(html)) as typeof fetch;
      const a = await archivePage('https://example.org/track', dst, f, new Date('2026-09-29T10:00:00Z'));
      expect(a.bytes).toBe(html.length);
      const saved = readFileSync(dst, 'utf8');
      expect(saved).toContain('Source: https://example.org/track | fetched: 2026-09-29T10:00:00.000Z | HTTP 200');
      expect(saved).toContain(createHash('sha256').update(html).digest('hex'));
      expect(saved).toContain('<p>CC BY 4.0</p>');
      expect(saved).not.toMatch(/evil|<style|<svg|<!-- c/);
      await expect(archivePage('https://example.org/x', dst, (async () => new Response('no', { status: 404 })) as typeof fetch)).rejects.toThrow('HTTP 404');
      expect(stripPage('a<script>x</script>b')).toBe('ab');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Ogg Opus reader', () => {
  it('reads the generated e2e clips: opus, mono, 90 s', () => {
    for (const g of GENRES) {
      const f = join(GAME_DIR, 'e2e', 'fixtures', 'music', `${g.id}.ogg`);
      expect(existsSync(f), g.id).toBe(true);
      expect(oggOpusInfo(readFileSync(f)), g.id).toEqual({ channels: 1, durationSec: 90 });
    }
    expect(oggOpusInfo(new Uint8Array(200))).toBeNull();
    expect(oggOpusInfo(Buffer.from('not ogg at all'.repeat(10)))).toBeNull();
  });
});

// The fetch itself, against a throwaway root, a stub server and the real ffmpeg (from PATH or ffmpeg-static).
const ffmpeg = findFfmpeg();

describe.skipIf(!ffmpeg)('fetch and transcode', () => {
  let root = '';
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));

  /** A 3 s two-tone WAV, quiet (about -35 LUFS): the "download". */
  const source = (): Uint8Array => {
    const dir = mkdtempSync(join(tmpdir(), 'h3d-src-'));
    const f = join(dir, 's.wav');
    const r = spawnSync((ffmpeg as NonNullable<typeof ffmpeg>).path, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3', '-filter_complex', '[0:a][1:a]amix=inputs=2,volume=0.05', '-ar', '44100', '-ac', '2', f]);
    expect(r.status).toBe(0);
    const b = new Uint8Array(readFileSync(f));
    rmSync(dir, { recursive: true, force: true });
    return b;
  };

  const row = (over: Partial<MusicRow> = {}): MusicRow => ({
    id: 'test-tone',
    genre: 'jazz',
    title: 'Test Tone',
    artist: 'Nobody',
    sourceUrl: 'https://example.org/test-tone',
    downloadUrl: 'https://example.org/test-tone.wav',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    attribution: null,
    claimStatus: 'hold',
    verifiedAt: '2026-09-29',
    proof: 'music/proof/test-tone.html',
    sha256: '',
    durationSec: 0,
    loudnessLufs: 0,
    ...over,
  });

  const setup = (r: MusicRow) => {
    root = mkdtempSync(join(tmpdir(), 'h3d-music-'));
    seen.length = 0;
    mkdirSync(join(root, 'music', 'proof'), { recursive: true });
    writeFileSync(join(root, 'music', 'proof', 'test-tone.html'), '<p>proof</p>');
    writeFileSync(join(root, 'music', 'manifest.json'), JSON.stringify({ targetLufs: -16, tracks: [r] }));
    return paths(root);
  };
  const logs: string[] = [];
  const opts = (fetchBytes: Uint8Array | (() => Response)) => ({
    root,
    ffmpeg,
    log: (s: string) => logs.push(s),
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), referer: (init?.headers as Record<string, string>).referer as string });
      return typeof fetchBytes === 'function' ? fetchBytes() : new Response(fetchBytes as BodyInit, { headers: { 'content-type': 'audio/wav' } });
    }) as typeof fetch,
  });
  const seen: Array<{ url: string; referer: string }> = [];

  it('downloads with the track page as referer, normalises to -16 LUFS, writes Ogg Opus 96 kb/s, pins the manifest and the lock, and skips what is up to date', async () => {
    const wav = source();
    const p = setup(row());
    // Without a pinned hash a first fetch refuses, and says how to pin.
    const refused = await run(opts(wav));
    expect(refused.failed[0]?.error).toMatch(/--pin/);
    expect(existsSync(outFile(p, row()))).toBe(false);

    const first = await run({ ...opts(wav), pin: true });
    expect(first.failed).toEqual([]);
    expect(first.fetched).toEqual(['test-tone']);
    expect(seen.at(-1)).toEqual({ url: 'https://example.org/test-tone.wav', referer: 'https://example.org/test-tone' });
    const m = loadManifest(p);
    const r = m.tracks[0] as MusicRow;
    expect(r.sha256).toBe(createHash('sha256').update(wav).digest('hex'));
    expect(r.durationSec).toBeGreaterThan(2.9);
    expect(r.durationSec).toBeLessThan(3.2);
    expect(r.loudnessLufs).toBeGreaterThan(-16.6);
    expect(r.loudnessLufs).toBeLessThan(-15.4);
    const ogg = readFileSync(outFile(p, r));
    expect(oggOpusInfo(ogg)).toMatchObject({ channels: 2 });
    // 96 kb/s: 3 s is about 36 KB, nowhere near the 500 KB of the WAV.
    expect(ogg.length).toBeGreaterThan(15_000);
    expect(ogg.length).toBeLessThan(80_000);
    const lock = loadLock(p);
    expect(lock.tracks['test-tone']?.src.sha256).toBe(r.sha256);
    expect(lock.tracks['test-tone']?.out.sha256).toBe(createHash('sha256').update(ogg).digest('hex'));
    expect(lock.encoder).toBe((ffmpeg as NonNullable<typeof ffmpeg>).version);
    expect(auditLock(m, lock)).toEqual([]);
    // The check passes its file part (the per-genre minimum is the only complaint of a one-row manifest).
    const c = check({ root });
    expect(c.problems.filter((x) => !/track\(s\), at least/.test(x) && !/claimUrl|claimProof/.test(x))).toEqual([]);
    expect(c.files).toBe(1);

    // Up to date: nothing downloaded, nothing transcoded.
    const n = seen.length;
    const again = await run(opts(wav));
    expect(again).toMatchObject({ fetched: [], skipped: ['test-tone'] });
    expect(seen.length).toBe(n);
    // A different download than the pinned one is refused, not pinned.
    rmSync(join(p.cache, 'test-tone.src'));
    const bad = await run({ ...opts(new Uint8Array(20_000).fill(7)), force: true });
    expect(bad.failed[0]?.error).toMatch(/changed upstream/);
    expect(readFileSync(outFile(p, r)).equals(ogg)).toBe(true);
  }, 60_000);

  it('--check fails a missing, swapped or truncated file and a release with a row on hold', async () => {
    const wav = source();
    const p = setup(row());
    await run({ ...opts(wav), pin: true });
    const f = outFile(p, row());
    const good = readFileSync(f);
    const only = (x: string[]) => x.filter((y) => !/track\(s\), at least/.test(y) && !/claimUrl|claimProof/.test(y));
    expect(only(check({ root }).problems)).toEqual([]);
    expect(only(check({ root, release: true }).problems)).toEqual(['release: test-tone: claimStatus is hold']);
    writeFileSync(f, good.subarray(0, good.length - 4000));
    expect(only(check({ root }).problems).join('\n')).toMatch(/differs from the lock|the file is/);
    writeFileSync(f, Buffer.from('RIFF nonsense'.repeat(20)));
    expect(only(check({ root }).problems).join('\n')).toMatch(/not an Ogg Opus file/);
    rmSync(f);
    expect(only(check({ root }).problems).join('\n')).toMatch(/no public\/music\/jazz\/test-tone\.ogg/);
    // A file from another ffmpeg build is not compared by hash, only by shape and length.
    writeFileSync(f, good);
    expect(only(check({ root, currentEncoder: () => 'ffmpeg 99.0' }).problems)).toEqual([]);
    const other = Buffer.from(good);
    other[other.length - 10] = (other[other.length - 10] ?? 0) ^ 0xff;
    writeFileSync(f, other);
    expect(check({ root, currentEncoder: () => 'ffmpeg 99.0' }).notes[0]).toMatch(/hashes not compared/);
  }, 60_000);

  it('a row with no direct download waits for music/incoming/<id>.<ext>, and takes it against the hash', async () => {
    const wav = source();
    const p = setup(row({ downloadUrl: '' }));
    const none = await run(opts(wav));
    expect(none.manual).toEqual(['test-tone']);
    expect(none.failed).toEqual([]);
    expect(seen).toEqual([]);
    mkdirSync(p.incoming, { recursive: true });
    writeFileSync(join(p.incoming, 'test-tone.wav'), wav);
    const done = await run({ ...opts(wav), pin: true });
    expect(done).toMatchObject({ fetched: ['test-tone'], manual: [] });
    // Now pinned: a hand-downloaded wrong file is refused.
    writeFileSync(join(p.incoming, 'test-tone.wav'), new Uint8Array(30_000).fill(3));
    const bad = await run({ ...opts(wav), force: true });
    expect(bad.failed[0]?.error).toMatch(/changed upstream|wrong one/);
  }, 60_000);

  it('a page instead of audio (a login redirect) is an error that points at music/incoming/', async () => {
    const p = setup(row());
    const r = await run({ ...opts(() => new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } })), pin: true });
    expect(r.failed[0]?.error).toMatch(/web page, not audio.*music\/incoming\/test-tone/);
    expect(existsSync(outFile(p, row()))).toBe(false);
  });

  it('--dry-run downloads nothing and writes nothing', async () => {
    const p = setup(row({ sha256: 'a'.repeat(64) }));
    const r = await run({ ...opts(new Uint8Array(1)), dryRun: true, ffmpeg: null });
    expect(r.fetched).toEqual(['test-tone']);
    expect(seen).toEqual([]);
    expect(existsSync(p.lock)).toBe(false);
    expect(existsSync(p.out)).toBe(false);
  });
});
