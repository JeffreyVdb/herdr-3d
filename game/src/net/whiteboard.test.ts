import { describe, expect, it } from 'vitest';
import { boardUrl, dropUrl, fileUrl, getBoard, putFile, renderUrl, saveBoard, sha256Hex, type Fetcher } from './whiteboard';

const WS = 'ws://127.0.0.1:7777/ws?token=t0k&wb_key=k1';

function fake(status: number, body: unknown): { fetcher: Fetcher; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetcher: async (url, init) => {
      calls.push({ url, ...(init ? { init } : {}) });
      return { ok: status < 300, status, json: async () => body };
    },
  };
}

describe('whiteboard HTTP', () => {
  it('derives every URL from the WebSocket one, keeping its query (the token)', () => {
    expect(boardUrl(WS, 'herdr-3d')).toBe('http://127.0.0.1:7777/whiteboard/herdr-3d?token=t0k&wb_key=k1');
    expect(fileUrl(WS, 'f', 'ab')).toBe('http://127.0.0.1:7777/whiteboard/f/files/ab?token=t0k&wb_key=k1');
    expect(renderUrl('wss://h/ws?token=x', 'f', 7)).toBe('https://h/whiteboard/f/render.png?token=x&v=7');
    expect(dropUrl(WS, '/home/me/drops/2026-10/a b.png', true)).toBe('http://127.0.0.1:7777/drops/file?token=t0k&wb_key=k1&path=%2Fhome%2Fme%2Fdrops%2F2026-10%2Fa+b.png&thumb=1');
  });

  it('saves the scene and the render as one multipart request on a base version', async () => {
    const f = fake(200, { t: 'ack', data: { floor: 'f', version: 4 } });
    const r = await saveBoard(WS, 'f', { base: 3, author: 'Theo', scene: { elements: [{ id: 'a' }], appState: { viewBackgroundColor: '#fff' } }, render: new Blob([new Uint8Array([137, 80])], { type: 'image/png' }) }, f.fetcher);
    expect(r).toEqual({ ok: true, data: { floor: 'f', version: 4 } });
    const call = f.calls[0];
    expect(call?.url).toBe('http://127.0.0.1:7777/whiteboard/f/save?token=t0k&wb_key=k1&base=3&author=Theo');
    expect(call?.init?.method).toBe('POST');
    const form = call?.init?.body as FormData;
    expect(JSON.parse(await (form.get('scene') as Blob).text())).toEqual({ elements: [{ id: 'a' }], appState: { viewBackgroundColor: '#fff' } });
    expect((form.get('render') as Blob).size).toBe(2);
  });

  it('carries the current version of a conflict, and the code of a refusal', async () => {
    const conflict = await saveBoard(WS, 'f', { base: 1, author: '', scene: { elements: [], appState: {} }, render: new Blob([]) }, fake(409, { t: 'error', code: 'whiteboard_conflict', message: 'at 5', version: 5 }).fetcher);
    expect(conflict).toEqual({ ok: false, code: 'whiteboard_conflict', message: 'at 5', version: 5 });
    const hash = await putFile(WS, 'f', 'ab', new Blob(['x']), fake(422, { t: 'error', code: 'whiteboard_hash_mismatch', message: 'no' }).fetcher);
    expect(hash).toMatchObject({ ok: false, code: 'whiteboard_hash_mismatch' });
    const offline = await getBoard(WS, 'f', async () => {
      throw new Error('down');
    });
    expect(offline).toMatchObject({ ok: false, code: 'offline' });
    expect(await getBoard(WS, 'f', fake(200, { data: { nope: 1 } }).fetcher)).toMatchObject({ ok: false, code: 'internal' });
  });

  it('hashes bytes as the bridge names files', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
