import { describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import { frameUrl, postFrame } from '../net/screenFrame';
import { isScreenMessage, parseMessage, type ServerMessage } from '../net/protocol';
import { letterbox } from '../render/tv';
import { encodeFrame, FrameError, frameReady, frameSize, FRAME_QUALITY, type FrameSource } from './frame';
import { FrameResponder } from './responder';

describe('frameSize', () => {
  it('caps the width at 1920 and keeps the aspect, never upscales', () => {
    expect(frameSize(3840, 2160)).toEqual({ w: 1920, h: 1080 });
    expect(frameSize(2560, 1600)).toEqual({ w: 1920, h: 1200 });
    expect(frameSize(1280, 720)).toEqual({ w: 1280, h: 720 });
    expect(frameSize(1920, 1080)).toEqual({ w: 1920, h: 1080 });
    expect(frameSize(5120, 2880)).toEqual({ w: 1920, h: 1080 });
  });
  it('a very tall source is held at 4096 tall', () => {
    expect(frameSize(1000, 10000)).toEqual({ w: 410, h: 4096 });
    expect(frameSize(1080, 1920)).toEqual({ w: 1080, h: 1920 });
  });
  it('nothing for nothing', () => {
    expect(frameSize(0, 720)).toEqual({ w: 0, h: 0 });
    expect(frameSize(NaN, 720)).toEqual({ w: 0, h: 0 });
    expect(frameSize(1, 1)).toEqual({ w: 1, h: 1 });
  });
});

function source(o: Partial<{ w: number; h: number; muted: boolean; state: 'live' | 'ended'; ready: number }> = {}): FrameSource {
  return {
    video: { videoWidth: o.w ?? 2560, videoHeight: o.h ?? 1440, readyState: o.ready ?? 4 } as unknown as FrameSource['video'],
    track: { readyState: o.state ?? 'live', muted: o.muted ?? false, enabled: true },
  };
}

function canvas(type = 'image/jpeg', blob: Blob | null = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type })) {
  const draws: unknown[][] = [];
  const c = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: (...a: unknown[]) => draws.push(a) }),
    toBlob: vi.fn((cb: (b: Blob | null) => void, t: string, q: number) => {
      expect([t, q]).toEqual(['image/jpeg', FRAME_QUALITY]);
      queueMicrotask(() => cb(blob));
    }),
  };
  return { c, draws };
}

describe('encodeFrame', () => {
  it('draws the current frame at its encoded size and gives a JPEG', async () => {
    const { c, draws } = canvas();
    const s = source();
    const r = await encodeFrame(s, () => true, () => c as unknown as HTMLCanvasElement);
    expect([c.width, c.height, r.w, r.h]).toEqual([1920, 1080, 1920, 1080]);
    expect(draws).toEqual([[s.video, 0, 0, 1920, 1080]]);
    expect(r.blob.type).toBe('image/jpeg');
  });
  it('refuses a source that has no picture', async () => {
    for (const s of [source({ muted: true }), source({ state: 'ended' }), source({ ready: 1 }), source({ w: 0 })]) {
      expect(frameReady(s)).toBe(false);
      await expect(encodeFrame(s, () => true, () => canvas().c as unknown as HTMLCanvasElement)).rejects.toMatchObject({ code: 'unavailable' });
    }
  });
  it('a Stop during the encode drops the frame', async () => {
    let alive = true;
    const { c } = canvas();
    const p = encodeFrame(source(), () => alive, () => c as unknown as HTMLCanvasElement);
    alive = false;
    await expect(p).rejects.toMatchObject({ code: 'stopped' });
  });
  it('no JPEG (null, or a PNG fallback) is an error', async () => {
    await expect(encodeFrame(source(), () => true, () => canvas('image/jpeg', null).c as unknown as HTMLCanvasElement)).rejects.toMatchObject({ code: 'encode_failed' });
    await expect(encodeFrame(source(), () => true, () => canvas('image/png').c as unknown as HTMLCanvasElement)).rejects.toMatchObject({ code: 'encode_failed' });
  });
});

describe('FrameResponder', () => {
  const jpeg = new Blob([new Uint8Array(10)], { type: 'image/jpeg' });
  const ID = (n: number) => n.toString(16).padStart(32, '0');

  function responder(o: { live?: boolean; encode?: () => Promise<{ blob: Blob; w: number; h: number }>; post?: (id: string) => Promise<CommandResult> } = {}) {
    let gen = 1;
    let live = o.live ?? true;
    const refused: Array<[string, string]> = [];
    const posted: string[] = [];
    const r = new FrameResponder({
      live: () => (live ? { source: source(), gen } : null),
      alive: (g) => live && g === gen,
      encode: o.encode ?? (async () => ({ blob: jpeg, w: 1920, h: 1080 })),
      post: async (id) => (posted.push(id), o.post ? o.post(id) : { ok: true, data: null }),
      refuse: (id, code) => refused.push([id, code]),
    });
    return {
      r,
      refused,
      posted,
      stop: () => {
        live = false;
        gen++;
      },
      /** A new Share (another source, maybe): live again, as a later capture. */
      restart: () => {
        live = true;
        gen += 2;
      },
      gen: () => gen,
    };
  }
  const settle = () => new Promise((res) => setTimeout(res, 0));

  it('a request while sharing posts one JPEG; none while not sharing', async () => {
    const t = responder();
    t.r.request(ID(1));
    await settle();
    expect(t.posted).toEqual([ID(1)]);
    expect(t.r.answered).toEqual([{ reqId: ID(1), ok: true, bytes: 10, w: 1920, h: 1080 }]);
    const off = responder({ live: false });
    off.r.request(ID(2));
    await settle();
    expect(off.posted).toEqual([]);
    expect(off.refused).toEqual([[ID(2), 'not_sharing']]);
  });

  it('answers in order, one at a time, a repeated id once', async () => {
    let running = 0;
    let most = 0;
    const t = responder({
      encode: async () => {
        most = Math.max(most, ++running);
        await settle();
        running--;
        return { blob: jpeg, w: 1, h: 1 };
      },
    });
    t.r.request(ID(1));
    t.r.request(ID(2));
    t.r.request(ID(2));
    t.r.request(ID(3));
    for (let i = 0; i < 10; i++) await settle();
    expect(t.posted).toEqual([ID(1), ID(2), ID(3)]);
    expect(most).toBe(1);
  });

  it('a Stop during the encode sends nothing and says why', async () => {
    let release: () => void = () => {};
    const t = responder({ encode: () => new Promise((res) => (release = () => res({ blob: jpeg, w: 1, h: 1 }))) });
    t.r.request(ID(1));
    await settle();
    t.stop();
    release();
    await settle();
    expect(t.posted).toEqual([]);
    expect(t.refused).toEqual([[ID(1), 'stopped']]);
  });

  // SC-R1: a request that waited behind a slow upload is bound to its capture: after Stop and a new Share (another
  // source) it is neither encoded nor uploaded, with or without the controller dropping the queue.
  for (const dropped of [true, false]) {
    it(`a queued request never crosses a Stop into the next share${dropped ? '' : ' (queue not dropped)'}`, async () => {
      let release: () => void = () => {};
      const encoded: number[] = [];
      let t!: ReturnType<typeof responder>;
      t = responder({
        encode: async () => (encoded.push(t.gen()), { blob: jpeg, w: 1, h: 1 }),
        post: (id) => (id === ID(1) ? new Promise((res) => (release = () => res({ ok: true, data: null }))) : Promise.resolve({ ok: true, data: null })),
      });
      t.r.request(ID(1));
      t.r.request(ID(2));
      await settle();
      expect(t.posted).toEqual([ID(1)]);
      t.stop();
      if (dropped) t.r.ended();
      t.restart();
      release();
      for (let i = 0; i < 5; i++) await settle();
      expect(encoded).toEqual([1]);
      expect(t.posted).toEqual([ID(1)]);
      expect(t.r.answered.find((a) => a.reqId === ID(2))).toEqual({ reqId: ID(2), ok: false, code: 'stopped' });
      expect(t.refused).toEqual(dropped ? [] : [[ID(2), 'stopped']]);
      // A request of the new capture is answered from it.
      t.r.request(ID(3));
      await settle();
      expect(t.posted).toEqual([ID(1), ID(3)]);
      expect(encoded).toEqual([1, 4]);
    });
  }

  it('an encode failure and an unreachable bridge are told to the bridge', async () => {
    const bad = responder({ encode: () => Promise.reject(new FrameError('unavailable', 'paused')) });
    bad.r.request(ID(1));
    await settle();
    expect(bad.refused).toEqual([[ID(1), 'unavailable']]);
    const offline = responder({ post: async () => ({ ok: false, code: 'offline', message: 'x' }) });
    offline.r.request(ID(2));
    await settle();
    expect(offline.refused).toEqual([[ID(2), 'upload_failed']]);
    // A refusal by the bridge (it failed the grab itself) is not answered again.
    const refused = responder({ post: async () => ({ ok: false, code: 'frame_invalid', message: 'x' }) });
    refused.r.request(ID(3));
    await settle();
    expect(refused.refused).toEqual([]);
    expect(refused.r.answered).toEqual([{ reqId: ID(3), ok: false, code: 'frame_invalid' }]);
  });
});

describe('the frame upload', () => {
  it('goes beside the WebSocket with its token', () => {
    expect(frameUrl('ws://127.0.0.1:7777/ws?token=abc', 'f'.repeat(32))).toBe(`http://127.0.0.1:7777/screen/frame/${'f'.repeat(32)}?token=abc`);
    expect(frameUrl('wss://h/fixture/demo?play=none#x', 'a')).toBe('https://h/screen/frame/a?play=none');
  });
  it('POSTs the JPEG and reads the answer', async () => {
    const fetcher = vi.fn(async (_u: string, i?: RequestInit) => {
      expect(i?.method).toBe('POST');
      expect((i?.headers as Record<string, string>)['Content-Type']).toBe('image/jpeg');
      return { ok: true, status: 200, json: async () => ({ t: 'ack', data: { bytes: 3, w: 1, h: 1 } }) };
    });
    expect(await postFrame('ws://h/ws', 'a', new Blob(['x']), fetcher)).toEqual({ ok: true, data: { bytes: 3, w: 1, h: 1 } });
    const refused = vi.fn(async () => ({ ok: false, status: 422, json: async () => ({ t: 'error', code: 'frame_invalid', message: 'not a JPEG' }) }));
    expect(await postFrame('ws://h/ws', 'a', new Blob(['x']), refused)).toEqual({ ok: false, code: 'frame_invalid', message: 'not a JPEG' });
    const down = vi.fn(async () => Promise.reject(new Error('net')));
    expect(await postFrame('ws://h/ws', 'a', new Blob(['x']), down)).toMatchObject({ ok: false, code: 'offline' });
  });
});

describe('screen messages', () => {
  const m = (o: object) => parseMessage(JSON.stringify(o)) as ServerMessage;
  it('a frame request needs a real id', () => {
    expect(isScreenMessage(m({ t: 'screen.frame_request', req_id: 'a'.repeat(32) }))).toBe(true);
    expect(isScreenMessage(m({ t: 'screen.frame_request', req_id: '../x' }))).toBe(false);
    expect(isScreenMessage(m({ t: 'screen.grabbed', requester: 'Nibble', floor: 'herdr-3d', at: 1 }))).toBe(true);
    expect(isScreenMessage(m({ t: 'screen.grabbed', floor: 'x' }))).toBe(false);
  });
});

describe('letterbox', () => {
  it('fits without cropping or stretching', () => {
    const f = letterbox(2, 1, 1920, 1080);
    expect(f.w).toBeCloseTo(16 / 9, 9);
    expect(f.h).toBe(1);
    expect(letterbox(2, 1, 4000, 1000)).toEqual({ w: 2, h: 0.5 });
    expect(letterbox(2, 1, 1080, 1920)).toEqual({ w: 0.5625, h: 1 });
    expect(letterbox(2, 1, 0, 1)).toEqual({ w: 0, h: 0 });
  });
});
