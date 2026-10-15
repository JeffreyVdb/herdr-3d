import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_CHANGED_MESSAGE, onBridgeChanged } from './bridgeChanged';
import { bridgeUrl } from './endpoint';
import { deleteLogo, logoUrl, putLogo } from './logo';
import { frameUrl, postFrame } from './screenFrame';
import { postUpload, uploadUrl } from './upload';
import { boardUrl, dropUrl, fileUrl, getBoard, putFile, renderUrl, saveBoard } from './whiteboard';

// #57: a page's HTTP routes name its bridge, as its /ws does, and the helper refuses them (409 bridge_changed) once
// another tab put another bridge in use. The page then follows the switch rather than showing a failed request.

const loc = { protocol: 'http:', host: '127.0.0.1:7777', pathname: '/', search: '', hash: '' };

describe('the HTTP routes carry the page’s bridge', () => {
  it.each(['aaaaaaaaaa', 'none'])('bridge=%s on every route, beside the token', (bridge) => {
    const ws = bridgeUrl(loc, 't0k', bridge);
    const urls = [
      logoUrl(ws, 'b_1', 'h1'),
      uploadUrl(ws, { label: 'x', n: 1 }),
      frameUrl(ws, 'ab'.repeat(16)),
      boardUrl(ws, 'herdr-3d'),
      fileUrl(ws, 'herdr-3d', 'f1'),
      renderUrl(ws, 'herdr-3d', 3),
      dropUrl(ws, '/tmp/a.png', true),
    ];
    for (const u of urls) {
      const q = new URL(u).searchParams;
      expect(q.get('bridge'), u).toBe(bridge);
      expect(q.get('token'), u).toBe('t0k');
    }
  });
  it('a page no helper serves names none', () => {
    expect(new URL(boardUrl(bridgeUrl(loc, 't0k', null), 'f')).searchParams.has('bridge')).toBe(false);
  });
});

describe('a 409 bridge_changed', () => {
  afterEach(() => onBridgeChanged(null));
  const answer = (status: number, body: unknown) => vi.fn(() => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) }));
  const changed = () => answer(409, { t: 'error', code: 'bridge_changed', message: 'the bridge in use changed: reload the game' });
  const ws = bridgeUrl(loc, 't0k', 'aaaaaaaaaa');
  const blob = new Blob(['x'], { type: 'image/png' });
  const routes: Array<[string, (f: ReturnType<typeof answer>) => Promise<{ ok: boolean; code?: string; message?: string }>]> = [
    ['logo put', (f) => putLogo(ws, 'b_1', blob, f)],
    ['logo delete', (f) => deleteLogo(ws, 'b_1', f)],
    ['upload', (f) => postUpload(ws, blob, {}, undefined, f)],
    ['frame', (f) => postFrame(ws, 'ab'.repeat(16), blob, f)],
    ['board', (f) => getBoard(ws, 'herdr-3d', f)],
    ['board file', (f) => putFile(ws, 'herdr-3d', 'f1', blob, f)],
    ['board save', (f) => saveBoard(ws, 'herdr-3d', { base: 1, author: 'me', scene: { elements: [], appState: {} }, render: blob }, f)],
  ];
  it.each(routes)('%s: the page follows the switch, and the result says so', async (_, send) => {
    const follow = vi.fn();
    onBridgeChanged(follow);
    const r = await send(changed());
    expect(r).toMatchObject({ ok: false, code: 'bridge_changed', message: BRIDGE_CHANGED_MESSAGE });
    expect(follow).toHaveBeenCalledTimes(1);
  });
  it.each(routes)('%s: another refusal is not a switch', async (_, send) => {
    const follow = vi.fn();
    onBridgeChanged(follow);
    const r = await send(answer(409, { t: 'error', code: 'whiteboard_conflict', message: 'stale', version: 4 }));
    expect(r.ok).toBe(false);
    expect(follow).not.toHaveBeenCalled();
  });
});
