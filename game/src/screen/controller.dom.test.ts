// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { DisplayOptions } from './capture';
import { ScreenShareController } from '.';

class FakeTrack extends EventTarget {
  readyState = 'live';
  muted = false;
  enabled = true;
  stop(): void {
    this.readyState = 'ended';
  }
  getSettings() {
    return { displaySurface: 'browser' };
  }
}

function setup() {
  const track = new FakeTrack();
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  const video = Object.assign(new EventTarget(), { muted: false, srcObject: null as unknown, videoWidth: 1280, videoHeight: 800, readyState: 4, play: async () => {}, pause() {}, remove() {} });
  const sent: Array<[string, unknown]> = [];
  const toasts: Array<[string, string]> = [];
  const screens: Array<[boolean, number, number, boolean]> = [];
  const c = new ScreenShareController(
    {
      send: async (t, args) => (sent.push([t, args]), { ok: true, data: null }),
      url: 'ws://127.0.0.1:1/ws?token=t',
      toast: (m, k) => toasts.push([m, k]),
      office: () => ({ setScreen: (tex, w, h, p) => screens.push([tex !== null, w, h, p]) }),
    },
    { capture: { media: { getDisplayMedia: vi.fn(async (_o: DisplayOptions) => stream) } }, makeVideo: () => video as unknown as HTMLVideoElement },
  );
  return { c, track, sent, toasts, screens };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('ScreenShareController', () => {
  it('tells every new connection whether it shares, and every change', async () => {
    const t = setup();
    t.c.setConnected(true);
    expect(t.sent).toEqual([['screen.share', { sharing: false }]]);
    t.c.start();
    await settle();
    expect(t.c.share.view.phase).toBe('live');
    expect(t.sent.at(-1)).toEqual(['screen.share', { sharing: true, surface: 'browser' }]);
    // A reconnect: told again.
    t.c.setConnected(false);
    t.c.setConnected(true);
    expect(t.sent.filter(([, a]) => (a as { sharing: boolean }).sharing)).toHaveLength(2);
    t.c.stop();
    expect(t.sent.at(-1)).toEqual(['screen.share', { sharing: false }]);
    expect(t.toasts).toEqual([]); // our own Stop says nothing
  });

  it('LIVE in the top bar while sharing, Share screen otherwise; the TV gets the texture', async () => {
    const t = setup();
    const el = t.c.control.el;
    const live = el.querySelector<HTMLElement>('.share-live');
    const start = el.querySelector<HTMLButtonElement>('.share-start');
    expect(live?.hidden).toBe(true);
    expect(start?.hidden).toBe(false);
    start?.click();
    await settle();
    expect(live?.hidden).toBe(false);
    expect(start?.hidden).toBe(true);
    expect(el.querySelector('.share-what')?.textContent).toBe('Sharing a tab');
    expect(t.screens.at(-1)).toEqual([true, 1280, 800, false]);
    el.querySelector<HTMLButtonElement>('.share-stop')?.click();
    expect(live?.hidden).toBe(true);
    expect(t.screens.at(-1)).toEqual([false, 0, 0, false]);
  });

  it("Chrome's own Stop sharing says the share stopped", async () => {
    const t = setup();
    t.c.start();
    await settle();
    t.track.dispatchEvent(new Event('ended'));
    expect(t.c.share.view.phase).toBe('off');
    expect(t.toasts).toEqual([['Screen sharing stopped', 'info']]);
  });

  it('a grab shows who looked; a frame request while off is refused', async () => {
    const t = setup();
    t.c.onMessage({ t: 'screen.grabbed', requester: 'Nibble', floor: 'herdr-3d', at: 1 });
    expect(t.toasts).toEqual([['Nibble looked at your screen', 'info']]);
    t.c.onMessage({ t: 'screen.frame_request', req_id: 'a'.repeat(32) });
    await settle();
    expect(t.sent).toEqual([['screen.frame', { req_id: 'a'.repeat(32), error: 'not_sharing', message: 'screen sharing is off' }]]);
  });
});
