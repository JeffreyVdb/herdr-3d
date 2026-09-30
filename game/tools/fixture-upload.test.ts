import { mkdtempSync, rmSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UPLOAD_MAX_BYTES } from '../src/net/upload';
import { startFixtureServer } from './fixture-server';
import { cleanLabel, imageType, UPLOAD_MAX } from './fixture-upload';

const PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from('fake-image-data')]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const GIF = Buffer.from('GIF89a....');
const WEBP = Buffer.from('RIFF\0\0\0\0WEBPVP8 ');

let dir: string;
let srv: Server;
let sock: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'h3d-fxu-'));
  sock = join(dir, 'fx.sock');
  srv = await startFixtureServer(sock, { defaultFixture: 'demo' });
});
afterAll(() => {
  srv.close();
  rmSync(dir, { recursive: true, force: true });
});

function http(method: string, path: string, body?: Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: sock, method, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const post = (q: string, body?: Buffer) => http('POST', `/upload?${q}`, body);
const parse = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;

describe('the fixture POST /upload (the bridge’s contract)', () => {
  it('answers a deterministic absolute path with the mime and size, by the bytes, whatever the hint says', async () => {
    const r = await post('label=nibble&n=2&upload_key=t1', PNG);
    expect(r.status).toBe(200);
    expect(parse(r)).toEqual({ data: { path: '/home/fixture/drops/2026-09/h3d-nibble-2.png', mime: 'image/png', size: PNG.length } });
    expect(parse(await post('label=a&n=1&upload_key=t1', JPG))).toMatchObject({ data: { path: '/home/fixture/drops/2026-09/h3d-a-1.jpg', mime: 'image/jpeg' } });
    expect(parse(await post('label=a&n=3&upload_key=t1', GIF))).toMatchObject({ data: { mime: 'image/gif' } });
    expect(parse(await post('label=a&n=4&upload_key=t1', WEBP))).toMatchObject({ data: { mime: 'image/webp' } });
  });

  it('cleans the label like the bridge and falls back on "hire"', async () => {
    const path = async (label: string) => (parse(await post(`label=${encodeURIComponent(label)}&n=1&upload_key=t2`, PNG)) as { data: { path: string } }).data.path;
    expect(await path('Nibble the 2nd!')).toBe('/home/fixture/drops/2026-09/h3d-nibble-the-2nd-1.png');
    expect(await path('../../etc')).toBe('/home/fixture/drops/2026-09/h3d-etc-1.png');
    expect(await path('')).toBe('/home/fixture/drops/2026-09/h3d-hire-1.png');
    expect(await path('!!!')).toBe('/home/fixture/drops/2026-09/h3d-hire-1.png');
    expect(cleanLabel('x'.repeat(40))).toHaveLength(24);
    expect(cleanLabel(null)).toBe('hire');
  });

  it('refuses what the bridge refuses: other types by their bytes, empty, a bad n, over the cap', async () => {
    const code = (r: { body: string }) => (parse(r) as { t: string; code: string }).code;
    const svg = await post('label=a&n=1&upload_key=t3', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    expect([svg.status, code(svg)]).toEqual([415, 'upload_unsupported']);
    expect(parse(svg)).toMatchObject({ t: 'error' });
    const text = await post('label=a&n=1&upload_key=t3', Buffer.from('not an image'));
    expect([text.status, code(text)]).toEqual([415, 'upload_unsupported']);
    const empty = await post('label=a&n=1&upload_key=t3');
    expect([empty.status, code(empty)]).toEqual([400, 'bad_request']);
    for (const n of ['0', '-1', 'x', '1.5', '']) {
      const bad = await post(`label=a&n=${n}&upload_key=t3`, PNG);
      expect([bad.status, code(bad)]).toEqual([400, 'bad_request']);
    }
    const big = await post('label=a&n=1&upload_key=t3', Buffer.concat([PNG, Buffer.alloc(UPLOAD_MAX)]));
    expect([big.status, code(big)]).toEqual([413, 'upload_too_large']);
  });

  it('takes an image of exactly the cap and shares the constant with the client', async () => {
    expect(UPLOAD_MAX).toBe(UPLOAD_MAX_BYTES);
    const exact = Buffer.concat([PNG, Buffer.alloc(UPLOAD_MAX - PNG.length)]);
    expect(exact.length).toBe(26214400);
    expect((await post('label=a&n=1&upload_key=t4', exact)).status).toBe(200);
  });

  it('fail_upload=N fails the first N uploads of a key, then succeeds; a key of its own counts on its own', async () => {
    const q = (n: number, key: string) => `label=a&n=${n}&fail_upload=1&upload_key=${key}`;
    const first = await post(q(1, 't5'), PNG);
    expect([first.status, (parse(first) as { code: string }).code]).toEqual([502, 'dropzone_unavailable']);
    expect((await post(q(1, 't5'), PNG)).status).toBe(200);
    expect((await post(q(1, 't6'), PNG)).status).toBe(502);
    expect((await post('label=a&n=1&fail_upload=all&upload_key=t7', PNG)).status).toBe(502);
    expect((await post('label=a&n=1&fail_upload=all&upload_key=t7', PNG)).status).toBe(502);
  });

  it('#64: fail_code=upload_busy fails with the bridge’s 429, upload_delay holds the answer back', async () => {
    const busy = await post('label=a&n=1&fail_upload=all&fail_code=upload_busy&upload_key=t9', PNG);
    expect([busy.status, (parse(busy) as { code: string }).code]).toEqual([429, 'upload_busy']);
    const t0 = Date.now();
    expect((await post('label=a&n=1&upload_delay=150&upload_key=t10', PNG)).status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  });

  it('logs what it received per key, never the bytes', async () => {
    await post('label=a&n=1&upload_key=t8', PNG);
    await post('label=a&n=2&upload_key=t8&fail_upload=2', JPG);
    await post('label=a&n=3&upload_key=t8', Buffer.from('nope'));
    const log = (parse(await http('GET', '/upload/_log?upload_key=t8')) as { data: unknown[] }).data;
    expect(log).toEqual([
      { label: 'a', n: 1, size: PNG.length, mime: 'image/png', result: 'ok' },
      { label: 'a', n: 2, size: JPG.length, mime: 'image/jpeg', result: 'dropzone_unavailable' },
      { label: 'a', n: 3, size: 4, mime: null, result: 'upload_unsupported' },
    ]);
    expect((parse(await http('GET', '/upload/_log?upload_key=none')) as { data: unknown[] }).data).toEqual([]);
  });

  it('is POST only', async () => {
    expect((await http('GET', '/upload')).status).toBe(405);
    expect((await http('PUT', '/upload', PNG)).status).toBe(405);
    expect((await http('POST', '/upload/_log')).status).toBe(405);
  });

  it('types uploads by their bytes', () => {
    expect(imageType(PNG)?.mime).toBe('image/png');
    expect(imageType(JPG)?.ext).toBe('jpg');
    expect(imageType(GIF)?.mime).toBe('image/gif');
    expect(imageType(Buffer.from('GIF87a'))?.mime).toBe('image/gif');
    expect(imageType(WEBP)?.mime).toBe('image/webp');
    expect(imageType(Buffer.from('RIFF\0\0\0\0WAVEfmt '))).toBeNull();
    expect(imageType(Buffer.alloc(0))).toBeNull();
    expect(imageType(Buffer.from('<html>'))).toBeNull();
  });
});
