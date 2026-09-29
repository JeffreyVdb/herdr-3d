import { mkdtempSync, rmSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { logoHashOf } from '../src/net/protocol';
import { hashOf, logoType } from './fixture-logo';
import { startFixtureServer } from './fixture-server';

const PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from('fake-image-data')]);
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');

let dir: string;
let srv: Server;
let sock: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'h3d-fxl-'));
  sock = join(dir, 'fx.sock');
  srv = await startFixtureServer(sock, { defaultFixture: 'demo' });
});
afterAll(() => {
  srv.close();
  rmSync(dir, { recursive: true, force: true });
});

function http(method: string, path: string, body?: Buffer): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: sock, method, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** A simulated connection; resolves with the messages it received so far on demand. */
async function connect(key: string) {
  const ws = new WebSocket(`ws+unix://${sock}:/fixture/demo?sim=1&simlogo=${key}`);
  const got: Array<Record<string, unknown>> = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d)) as Record<string, unknown>));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'hello', proto: 1, client: 'test' }));
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(pred()).toBe(true);
  };
  await until(() => got.some((m) => m.t === 'world.snapshot'));
  const snap = got.find((m) => m.t === 'world.snapshot') as { world: { buildings: Array<{ id: string }> } };
  return { ws, got, until, building: snap.world.buildings[0]?.id as string };
}

describe('the fixture /logo routes', () => {
  it('stores, serves and clears a logo, announcing each change with a building.upsert', async () => {
    const c = await connect('k-store');
    const url = `/logo/${c.building}?simlogo=k-store`;
    expect((await http('GET', url)).status).toBe(404);

    const put = await http('PUT', url, PNG);
    expect(put.status).toBe(200);
    const hash = hashOf(PNG);
    expect(JSON.parse(put.body.toString())).toMatchObject({ t: 'ack', data: { id: c.building, logo: hash } });
    await c.until(() => c.got.some((m) => m.t === 'building.upsert' && logoHashOf((m as { building: { logo?: string } }).building) === hash));

    const get = await http('GET', `${url}&h=${hash}`);
    expect(get.status).toBe(200);
    expect(get.body.equals(PNG)).toBe(true);
    expect(get.headers['content-type']).toBe('image/png');
    expect(get.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await http('GET', url)).headers['cache-control']).toBe('no-cache');

    expect((await http('PUT', url, Buffer.concat([PNG, Buffer.from('2')]))).status).toBe(200);
    await c.until(() => c.got.filter((m) => m.t === 'building.upsert').length === 2);
    const second = c.got.filter((m) => m.t === 'building.upsert')[1] as { building: { logo?: string } };
    expect(second.building.logo).not.toBe(hash);

    expect((await http('DELETE', url)).status).toBe(200);
    await c.until(() => c.got.filter((m) => m.t === 'building.upsert').length === 3);
    expect((c.got.filter((m) => m.t === 'building.upsert')[2] as { building: { logo?: string } }).building.logo).toBeUndefined();
    expect((await http('GET', url)).status).toBe(404);
    c.ws.close();
  });

  it('refuses what the bridge refuses: oversize, other types, empty, unknown building', async () => {
    const c = await connect('k-limits');
    const url = `/logo/${c.building}?simlogo=k-limits`;
    const code = (r: { body: Buffer }) => (JSON.parse(r.body.toString()) as { code: string }).code;
    const big = await http('PUT', url, Buffer.concat([PNG, Buffer.alloc(1 << 20)]));
    expect([big.status, code(big)]).toEqual([413, 'logo_too_large']);
    const gif = await http('PUT', url, Buffer.from('GIF89a....'));
    expect([gif.status, code(gif)]).toEqual([415, 'logo_unsupported']);
    const empty = await http('PUT', url, Buffer.alloc(0));
    expect([empty.status, code(empty)]).toEqual([422, 'logo_invalid']);
    const nobody = await http('PUT', `/logo/b_nope?simlogo=k-limits`, PNG);
    expect([nobody.status, code(nobody)]).toEqual([404, 'not_found']);
    expect((await http('PUT', url, SVG)).status).toBe(200);
    c.ws.close();
  });

  it('keeps worlds apart by their simlogo key, and 404s an unknown key', async () => {
    const a = await connect('k-a');
    const b = await connect('k-b');
    await http('PUT', `/logo/${a.building}?simlogo=k-a`, PNG);
    expect((await http('GET', `/logo/${b.building}?simlogo=k-b`)).status).toBe(404);
    expect((await http('GET', `/logo/${a.building}?simlogo=k-x`)).status).toBe(404);
    expect((await http('GET', `/logo/${a.building}`)).status).toBe(404);
    a.ws.close();
    b.ws.close();
  });

  it('deleting the building deletes its logo', async () => {
    const c = await connect('k-del');
    await http('PUT', `/logo/${c.building}?simlogo=k-del`, PNG);
    c.ws.send(JSON.stringify({ t: 'building.delete', req_id: 'r1', args: { id: c.building } }));
    await c.until(() => c.got.some((m) => m.t === 'ack' && m.req_id === 'r1'));
    expect((await http('GET', `/logo/${c.building}?simlogo=k-del`)).status).toBe(404);
    c.ws.close();
  });

  it('simfail=logo_busy fails the next upload once; logo_missing hides fetched logos', async () => {
    const ws = new WebSocket(`ws+unix://${sock}:/fixture/demo?sim=1&simlogo=k-fail&simfail=logo_busy`);
    const got: Array<Record<string, unknown>> = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d)) as Record<string, unknown>));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'hello', proto: 1, client: 'test' }));
    for (let i = 0; i < 200 && !got.some((m) => m.t === 'world.snapshot'); i++) await new Promise((r) => setTimeout(r, 10));
    const id = (got.find((m) => m.t === 'world.snapshot') as { world: { buildings: Array<{ id: string }> } }).world.buildings[0]?.id as string;
    const url = `/logo/${id}?simlogo=k-fail`;
    expect((await http('PUT', url, PNG)).status).toBe(503);
    expect((await http('PUT', url, PNG)).status).toBe(200);
    ws.close();
  });

  it('types uploads by their bytes', () => {
    expect(logoType(PNG)).toBe('image/png');
    expect(logoType(SVG)).toBe('image/svg+xml');
    expect(logoType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(logoType(Buffer.from('<html><svg>'))).toBeNull();
    expect(logoType(Buffer.from('plain'))).toBeNull();
  });
});
