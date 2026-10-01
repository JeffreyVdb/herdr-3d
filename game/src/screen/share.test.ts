import { describe, expect, it, vi } from 'vitest';
import { classifyCaptureError, displayOptions, FAST_DENIAL_MS, MAC_SETTINGS, requestDisplay, surfaceOf, type DisplayOptions } from './capture';
import { ScreenShare, type ShareView } from './share';

/** A capture track: `ended` / `mute` / `unmute` are dispatched by the test, `stop()` fires nothing (like the real one). */
class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live';
  muted = false;
  enabled = true;
  surface = 'window';
  stops = 0;
  stop(): void {
    this.readyState = 'ended';
    this.stops++;
  }
  getSettings() {
    return { displaySurface: this.surface };
  }
}

function fakeStream(track = new FakeTrack()) {
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream };
}

class FakeVideo extends EventTarget {
  muted = false;
  srcObject: unknown = null;
  videoWidth = 1280;
  videoHeight = 720;
  readyState = 4;
  paused = true;
  playFails = false;
  play = vi.fn(async () => {
    if (this.playFails) throw new Error('NotAllowedError: play() failed');
    this.paused = false;
  });
  pause(): void {
    this.paused = true;
  }
  remove(): void {}
}

function setup(o: { mac?: boolean; now?: () => number } = {}) {
  const video = new FakeVideo();
  let answer: { resolve(s: MediaStream): void; reject(e: unknown): void } | null = null;
  const calls: DisplayOptions[] = [];
  const media = {
    getDisplayMedia: vi.fn((opts: DisplayOptions) => {
      calls.push(opts);
      return new Promise<MediaStream>((resolve, reject) => (answer = { resolve, reject }));
    }),
  };
  const focus: string[] = [];
  class Controller {
    setFocusBehavior(v: string) {
      focus.push(v);
    }
  }
  const share = new ScreenShare({ capture: { media, Controller }, makeVideo: () => video as unknown as HTMLVideoElement, mac: o.mac ?? false, now: o.now ?? (() => 0) });
  const views: ShareView[] = [];
  share.onChange((v) => views.push(v));
  return { share, video, media, calls, focus, views, answer: () => answer as NonNullable<typeof answer> };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the getDisplayMedia request', () => {
  it('offers tab, window and screen, excludes this tab, allows switching, no audio, bounded', () => {
    const o = displayOptions();
    expect(o).toMatchObject({
      audio: false,
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      monitorTypeSurfaces: 'include',
      systemAudio: 'exclude',
      windowAudio: 'exclude',
      video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 15, max: 30 } },
    });
    // No exact/min constraint and no displaySurface hint: they reject or narrow the picker.
    expect(JSON.stringify(o)).not.toMatch(/"(exact|min|displaySurface)"/);
    expect('controller' in o).toBe(false);
  });

  it('a fresh controller per capture, focus kept on the game, set before the call', () => {
    const order: string[] = [];
    class Controller {
      setFocusBehavior(v: string) {
        order.push(`focus:${v}`);
      }
    }
    const media = { getDisplayMedia: vi.fn((o: DisplayOptions) => (order.push('call'), expect(o.controller).toBeInstanceOf(Controller), Promise.resolve({} as MediaStream))) };
    void requestDisplay({ media, Controller });
    void requestDisplay({ media, Controller });
    expect(order).toEqual(['focus:no-focus-change', 'call', 'focus:no-focus-change', 'call']);
    expect(media.getDisplayMedia.mock.calls[0]?.[0].controller).not.toBe(media.getDisplayMedia.mock.calls[1]?.[0].controller);
  });

  it('works without a CaptureController, and one that throws is left out', async () => {
    const media = { getDisplayMedia: vi.fn((_o: DisplayOptions) => Promise.resolve({} as MediaStream)) };
    await requestDisplay({ media });
    class Broken {
      setFocusBehavior(): void {
        throw new Error('nope');
      }
    }
    await requestDisplay({ media, Controller: Broken });
    expect(media.getDisplayMedia.mock.calls.map((c) => 'controller' in c[0])).toEqual([false, false]);
    await expect(requestDisplay({ media: null })).rejects.toMatchObject({ name: 'NotSupportedError' });
  });

  it('reads the surface kind', () => {
    expect(surfaceOf({ getSettings: () => ({ displaySurface: 'browser' }) as MediaTrackSettings })).toBe('browser');
    expect(surfaceOf({ getSettings: () => ({ displaySurface: 'application' }) as unknown as MediaTrackSettings })).toBeUndefined();
    expect(surfaceOf(null)).toBeUndefined();
  });
});

describe('capture errors', () => {
  const err = (name: string, message = '') => new DOMException(message, name);
  it('a cancelled picker says nothing', () => {
    expect(classifyCaptureError(err('NotAllowedError', 'Permission denied'), { mac: true, elapsedMs: 4000 })).toEqual({ kind: 'cancelled' });
    expect(classifyCaptureError(err('NotAllowedError', 'Permission denied'), { mac: false, elapsedMs: 10 })).toEqual({ kind: 'cancelled' });
  });
  it('macOS denying it says where to allow Chrome', () => {
    for (const f of [classifyCaptureError(err('NotAllowedError', 'Permission denied by system'), { mac: true, elapsedMs: 3000 }), classifyCaptureError(err('NotAllowedError', 'Permission denied'), { mac: true, elapsedMs: FAST_DENIAL_MS - 1 })]) {
      expect(f.kind).toBe('os_denied');
      expect('message' in f && f.message).toContain(MAC_SETTINGS);
    }
  });
  it('the rest have clear words', () => {
    expect(classifyCaptureError(err('NotFoundError'), { mac: false, elapsedMs: 0 }).kind).toBe('not_found');
    expect(classifyCaptureError(err('NotReadableError'), { mac: true, elapsedMs: 0 })).toMatchObject({ kind: 'not_readable', message: expect.stringContaining('Privacy & Security') });
    expect(classifyCaptureError(err('InvalidStateError'), { mac: false, elapsedMs: 0 })).toMatchObject({ kind: 'needs_click', message: expect.stringContaining('Share screen again') });
    expect(classifyCaptureError(new TypeError('bad'), { mac: false, elapsedMs: 0 }).kind).toBe('unsupported');
    expect(classifyCaptureError(err('AbortError'), { mac: false, elapsedMs: 0 })).toMatchObject({ kind: 'failed', message: "Screen sharing wasn't started. Press Share screen to try again." });
  });
});

describe('ScreenShare', () => {
  it('off → picking → live, then Stop releases every track and the video', async () => {
    const t = setup();
    expect(t.share.view.phase).toBe('off');
    const started = t.share.start();
    // getDisplayMedia was called synchronously, inside the click.
    expect(t.media.getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(t.focus).toEqual(['no-focus-change']);
    expect(t.share.view.phase).toBe('picking');
    const { stream, track } = fakeStream();
    t.answer().resolve(stream);
    expect(await started).toBeNull();
    expect(t.share.view).toMatchObject({ phase: 'live', surface: 'window', paused: false, w: 1280, h: 720 });
    expect(t.video.srcObject).toBe(stream);
    expect(t.video.muted).toBe(true);
    expect(t.share.video).toBe(t.video);
    expect(t.share.source()).not.toBeNull();
    const gen = t.share.view.gen;
    expect(t.share.alive(gen)).toBe(true);
    t.share.stop();
    expect(track.stops).toBe(1);
    expect(t.video.srcObject).toBeNull();
    expect(t.video.paused).toBe(true);
    expect(t.share.view.phase).toBe('off');
    expect(t.share.alive(gen)).toBe(false);
    expect(t.share.source()).toBeNull();
    t.share.stop(); // idempotent
    expect(track.stops).toBe(1);
    expect(t.views.map((v) => v.phase)).toEqual(['picking', 'live', 'off']);
  });

  it("Chrome's Stop sharing (track ended) clears it; a later ended does nothing", async () => {
    const t = setup();
    const started = t.share.start();
    const { stream, track } = fakeStream();
    t.answer().resolve(stream);
    await started;
    track.stop();
    track.dispatchEvent(new Event('ended'));
    expect(t.share.view.phase).toBe('off');
    track.dispatchEvent(new Event('ended'));
    expect(t.views.filter((v) => v.phase === 'off')).toHaveLength(1);
  });

  it('a cancelled picker goes back to off and returns nothing to show', async () => {
    const t = setup();
    const started = t.share.start();
    t.answer().reject(new DOMException('Permission denied', 'NotAllowedError'));
    expect(await started).toBeNull();
    expect(t.share.view.phase).toBe('off');
  });

  it('a macOS denial comes back as the settings help', async () => {
    let now = 0;
    const t = setup({ mac: true, now: () => now });
    const started = t.share.start();
    now = 40;
    t.answer().reject(new DOMException('Permission denied', 'NotAllowedError'));
    expect(await started).toMatchObject({ kind: 'os_denied' });
    expect(t.share.view.phase).toBe('off');
  });

  it('Stop while the picker is open: the stream that comes later is stopped at once', async () => {
    const t = setup();
    const started = t.share.start();
    t.share.stop();
    expect(t.share.view.phase).toBe('off');
    const { stream, track } = fakeStream();
    t.answer().resolve(stream);
    expect(await started).toBeNull();
    expect(track.stops).toBe(1);
    expect(t.share.view.phase).toBe('off');
    expect(t.video.srcObject).toBeNull();
  });

  it('a second start while picking or live is ignored', async () => {
    const t = setup();
    const a = t.share.start();
    expect(await t.share.start()).toBeNull();
    t.answer().resolve(fakeStream().stream);
    await a;
    expect(await t.share.start()).toBeNull();
    expect(t.media.getDisplayMedia).toHaveBeenCalledTimes(1);
  });

  it('mute pauses, unmute resumes, a resize or a switched surface is followed', async () => {
    const t = setup();
    const started = t.share.start();
    const { stream, track } = fakeStream();
    t.answer().resolve(stream);
    await started;
    track.muted = true;
    track.dispatchEvent(new Event('mute'));
    expect(t.share.view.paused).toBe(true);
    track.muted = false;
    track.surface = 'browser';
    track.dispatchEvent(new Event('unmute'));
    expect(t.share.view).toMatchObject({ paused: false, surface: 'browser' });
    t.video.videoWidth = 1920;
    t.video.videoHeight = 1200;
    t.video.dispatchEvent(new Event('resize'));
    expect(t.share.view).toMatchObject({ w: 1920, h: 1200 });
    track.surface = 'monitor';
    t.share.refresh();
    expect(t.share.view.surface).toBe('monitor');
    // After Stop, the old track's events change nothing.
    t.share.stop();
    track.dispatchEvent(new Event('mute'));
    t.video.dispatchEvent(new Event('resize'));
    expect(t.share.view.phase).toBe('off');
  });

  it('a video that does not play ends the share with a message', async () => {
    const t = setup();
    t.video.playFails = true;
    const started = t.share.start();
    const { stream, track } = fakeStream();
    t.answer().resolve(stream);
    expect(await started).toMatchObject({ kind: 'failed' });
    expect(track.stops).toBe(1);
    expect(t.share.view.phase).toBe('off');
  });

  it('a stream without video is refused and released', async () => {
    const t = setup();
    const started = t.share.start();
    const audio = new FakeTrack();
    t.answer().resolve({ getTracks: () => [audio], getVideoTracks: () => [] } as unknown as MediaStream);
    expect(await started).toMatchObject({ kind: 'failed' });
    expect(audio.stops).toBe(1);
  });

  it('a restart is a new generation', async () => {
    const t = setup();
    let s = t.share.start();
    t.answer().resolve(fakeStream().stream);
    await s;
    const first = t.share.view.gen;
    t.share.stop();
    s = t.share.start();
    t.answer().resolve(fakeStream().stream);
    await s;
    await flush();
    expect(t.share.view.gen).toBeGreaterThan(first);
    expect(t.share.alive(first)).toBe(false);
    expect(t.share.alive(t.share.view.gen)).toBe(true);
  });

  it('unsupported without getDisplayMedia', () => {
    expect(new ScreenShare({ capture: { media: null } }).supported).toBe(false);
  });
});
