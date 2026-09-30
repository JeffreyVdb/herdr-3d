// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { ImageRef, TranscriptItem } from '../net/protocol';
import { ImageFeed, type ImageFeedHost } from './imageFeed';
import { imageRuns, imagesOf, isImageOnly, thumbSize } from './transcriptImages';
import { mountTranscript, type TranscriptRenderHost, type TranscriptView } from './transcriptRender';

// jsdom has neither showModal nor close on <dialog>, no object URLs, no IntersectionObserver.
beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal(): void; close(): void };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function (this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
  let n = 0;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:test/${++n}`;
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
});

let seq = 0;
const T0 = Date.UTC(2026, 8, 30, 9, 0, 0);
function item(kind: TranscriptItem['kind'], extra: Partial<TranscriptItem> = {}): TranscriptItem {
  seq++;
  return { id: `i${seq}`, seq, ts: T0 + seq * 1000, kind, ...extra };
}
const text = (t: string) => ({ text: t });
const H = (n: number) => n.toString(16).padStart(64, '0');
const ref = (n: number, extra: Partial<ImageRef> = {}): ImageRef => ({ hash: H(n), mime: 'image/png', bytes: 100, width: 640, height: 400, source: 'inline', origin: 'agent', kind: 'viewed', ...extra });
const img = (n: number, extra: Partial<ImageRef> = {}) => ({ image: ref(n, extra) });
const user = (...parts: unknown[]) => item('user', { parts: parts as NonNullable<TranscriptItem['parts']> });
const agent = (...parts: unknown[]) => item('assistant', { parts: parts as NonNullable<TranscriptItem['parts']> });

describe('the grouping rule', () => {
  const ids = (items: TranscriptItem[], sys = false) => imageRuns(items, sys);

  it('image-only user/assistant items with images and no text', () => {
    expect(isImageOnly(user(img(1)))).toBe(true);
    expect(isImageOnly(user(img(1), text('  \n')))).toBe(true);
    expect(isImageOnly(user(img(1), text('look')))).toBe(false);
    expect(isImageOnly(user(text('only text')))).toBe(false);
    expect(isImageOnly(user())).toBe(false);
    expect(isImageOnly(item('tool', { tool: { name: 'Read', input_summary: '', status: 'ok', images: [img(1)] } }))).toBe(false);
    expect(isImageOnly(user({ image_omitted: true }))).toBe(true);
  });

  it('adjacent image-only items of one role share a strip', () => {
    seq = 0;
    const a = agent(img(1));
    const b = agent(img(2), img(3));
    const c = agent(img(4));
    expect(ids([a, b, c])).toEqual([[a.id, b.id, c.id]]);
  });

  it('a text part, a tool row and a change of role break the run', () => {
    seq = 0;
    const a1 = agent(img(1));
    const a2 = agent(img(2));
    const talk = agent(text('and now this'), img(3));
    const a3 = agent(img(4));
    const tool = item('tool', { tool: { name: 'Bash', input_summary: 'ls', status: 'ok' } });
    const a4 = agent(img(5));
    const u1 = user(img(6));
    const a5 = agent(img(7));
    const a6 = agent(img(8));
    expect(ids([a1, a2, talk, a3, tool, a4, u1, a5, a6])).toEqual([[a1.id, a2.id], [a3.id], [a4.id], [u1.id], [a5.id, a6.id]]);
    // Thinking, notices and compactions are visible rows too.
    for (const between of [item('thinking', { parts: [text('hm')] }), item('notice', { notice: { text: 'Turn took 3s' } }), item('compaction', { notice: { text: 'c' } })]) {
      const x = agent(img(1));
      const y = agent(img(2));
      expect(ids([x, between, y])).toEqual([[x.id], [y.id]]);
    }
  });

  it('rows the view hides do not break a run, unless "show system" shows them', () => {
    seq = 0;
    const a = agent(img(1));
    const hidden = item('notice', { hidden: true, notice: { text: '', source: 'attachment/date' } });
    const unknown = item('unknown', { hidden: true, raw_type: 'x' });
    const b = agent(img(2));
    expect(ids([a, hidden, unknown, b], false)).toEqual([[a.id, b.id]]);
    expect(ids([a, hidden, unknown, b], true)).toEqual([[a.id], [b.id]]);
  });

  it('thumbnail sizes: at most the long side, never enlarged', () => {
    expect(thumbSize({ width: 1280, height: 720 }, 420)).toEqual({ w: 420, h: 236 });
    expect(thumbSize({ width: 375, height: 667 }, 240)).toEqual({ w: 135, h: 240 });
    expect(thumbSize({ width: 100, height: 50 }, 420)).toEqual({ w: 100, h: 50 });
    expect(thumbSize({}, 240).w).toBeGreaterThan(0);
  });

  it('imagesOf keeps refs in order and an older bridge’s placeholders as unavailable ones', () => {
    const rs = imagesOf([img(1), text('x'), { image_omitted: true }, img(2)]);
    expect(rs.map((r) => r.hash ?? r.reason)).toEqual([H(1), 'omitted', H(2)]);
  });
});

// A feed that answers thumbnails like the bridge (a real 1x1 PNG) and records what was asked.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
function fakeFeed(sent: ImageRef[] = []) {
  const asked: Array<{ hash: string; size: string }> = [];
  const host: ImageFeedHost = {
    send: (_t, args) => {
      const a = args as { hash?: string; size?: string };
      if (a.hash) asked.push({ hash: a.hash, size: a.size ?? '' });
      return Promise.resolve<CommandResult>({ ok: true, data: { mime: 'image/png', width: 1, height: 1, bytes: 70, size: a.size ?? 'thumb', data: PNG_1X1 } });
    },
  };
  const feed = new ImageFeed('w1', host);
  feed.noteRefs(sent);
  return { feed, asked };
}

let container: HTMLDivElement;
let view: TranscriptView | null = null;
const flush = () => new Promise((r) => setTimeout(r, 0));
const $ = <E extends Element = HTMLElement>(sel: string) => container.querySelector<E>(sel);
const $$ = <E extends Element = HTMLElement>(sel: string) => [...container.querySelectorAll<E>(sel)];
const row = (id: string) => $(`[data-id="${id}"]`) as HTMLElement;

function mount(feed: ImageFeed | null): TranscriptView {
  const host: TranscriptRenderHost = { images: feed, onPromptSubmit: () => Promise.resolve(true), onAnswer: () => {}, onSwitchToTerminal: () => {}, loadSubagent: async () => [] };
  view = mountTranscript(container, host);
  return view;
}

beforeEach(() => {
  seq = 0;
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  view?.destroy();
  view = null;
  container.remove();
  document.querySelectorAll('dialog').forEach((d) => d.remove());
  vi.unstubAllGlobals();
});

describe('images in the conversation', () => {
  it('a message’s images are one strip; text between them starts another; thumbnails load once, by hash', async () => {
    const { feed, asked } = fakeFeed([ref(1), ref(2), ref(3)]);
    mount(feed).setItems([user(text('two shots'), img(1), img(2), text('and one more'), img(3))]);
    await flush();
    await flush();
    const strips = $$('.tx-bubble .tx-strip');
    expect(strips.map((s) => s.querySelectorAll('.tx-thumb').length)).toEqual([2, 1]);
    expect($$('.tx-thumb img').map((i) => i.getAttribute('src'))).toEqual(['blob:test/1', 'blob:test/2', 'blob:test/3']);
    expect(asked).toEqual([
      { hash: H(1), size: 'thumb' },
      { hash: H(2), size: 'thumb' },
      { hash: H(3), size: 'thumb' },
    ]);
    // Sizes: several share the row (<= 240 px), a lone one gets more (<= 420 px), (the row wraps: transcript.css, checked in the e2e).
    expect(($$('.tx-thumb')[0] as HTMLElement).style.width).toBe('240px');
    expect(($$('.tx-thumb')[2] as HTMLElement).style.width).toBe('420px');
  });

  it('a Read of an image shows it inside the expanded tool row', async () => {
    const { feed, asked } = fakeFeed([ref(9)]);
    mount(feed).setItems([item('tool', { tool: { name: 'Read', input_summary: 'dialog-evidence/hire.png', status: 'ok', images: [img(9)] } })]);
    await flush();
    expect($('.tx-thumb')).toBeNull(); // collapsed: nothing shown, nothing fetched
    expect(asked).toEqual([]);
    ($('.tx-tool-row') as HTMLButtonElement).click();
    await flush();
    await flush();
    expect($$('.tx-tool-body .tx-strip .tx-thumb img').length).toBe(1);
    expect(asked).toEqual([{ hash: H(9), size: 'thumb' }]);
    expect($('.tx-note')?.textContent ?? '').not.toContain('No output');
  });

  it('thumbnails are fetched when they scroll into view, not before', async () => {
    let observed: Array<{ el: Element; cb: IntersectionObserverCallback }> = [];
    class FakeIO {
      constructor(private readonly cb: IntersectionObserverCallback) {}
      observe(el: Element) {
        observed.push({ el, cb: this.cb });
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', FakeIO);
    const { feed, asked } = fakeFeed([ref(1), ref(2)]);
    mount(feed).setItems([user(img(1)), agent(text('gap')), user(img(2))]);
    await flush();
    expect(asked).toEqual([]);
    expect(observed.length).toBe(2);
    const second = observed[1] as (typeof observed)[number];
    second.cb([{ target: second.el, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await flush();
    await flush();
    expect(asked).toEqual([{ hash: H(2), size: 'thumb' }]);
    observed = [];
  });

  it('a path outside the bridge’s roots is text and "not available"; nothing is fetched; the path is never an src', async () => {
    const { feed, asked } = fakeFeed();
    const r: ImageRef = { source: 'path', path: '/etc/passwd <img src=x onerror=alert(1)>', origin: 'input', unavailable: true, reason: 'not_allowed' };
    mount(feed).setItems([user(text('see'), { image: r })]);
    await flush();
    const card = $('.tx-imgcard') as HTMLElement;
    expect(card.textContent).toContain('Image not available');
    expect(card.querySelector('.tx-imgcard-path')?.textContent).toBe('/etc/passwd <img src=x onerror=alert(1)>');
    expect(card.querySelector('img')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(card.title).toContain('only opens images from');
    expect(asked).toEqual([]);
  });

  it('bytes that are no image are a chip; a hash the bridge never sent is not asked for', async () => {
    const { feed, asked } = fakeFeed();
    mount(feed).setItems([user({ image: ref(1, { mime: 'binary' }) }), agent({ image: ref(2) })]);
    await flush();
    expect($('.tx-imgchip')?.textContent).toContain('binary data');
    expect($$('.tx-imgcard').length).toBe(1); // hash 2 was never sent to this connection
    expect(asked).toEqual([]);
  });

  it('a failed thumbnail becomes the card', async () => {
    const host: ImageFeedHost = { send: () => Promise.resolve<CommandResult>({ ok: false, code: 'not_found', message: 'gone' }) };
    const feed = new ImageFeed('w1', host);
    feed.noteRefs([ref(4)]);
    mount(feed).setItems([user(img(4))]);
    await flush();
    await flush();
    await flush();
    expect($('.tx-thumb')).toBeNull();
    expect($('.tx-imgcard')).not.toBeNull();
  });

  it('click opens the lightbox on the strip’s images, Esc closes it and leaves the view', async () => {
    const { feed } = fakeFeed([ref(1), ref(2)]);
    mount(feed).setItems([user(img(1), img(2))]);
    await flush();
    await flush();
    ($$('.tx-thumb')[1] as HTMLButtonElement).click();
    const dlg = document.querySelector('dialog.ilb') as HTMLDialogElement;
    expect(dlg).not.toBeNull();
    expect(dlg.querySelector('.ilb-count')?.textContent).toBe('2 / 2');
    expect(dlg.querySelector('.ilb-copy')).not.toBeNull();
    expect(dlg.querySelector('.ilb-zoom-in')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.querySelector('dialog.ilb')).toBeNull();
    expect($('.tx')).not.toBeNull();
  });
});

describe('adjacent image-only items share one strip', () => {
  it('merges a run into its first row, undoes it when text or a tool comes between, and follows updates', async () => {
    const { feed } = fakeFeed([ref(1), ref(2), ref(3), ref(4)]);
    const v = mount(feed);
    const a = agent(img(1));
    const b = agent(img(2));
    const c = agent(img(3));
    v.setItems([a, b, c]);
    await flush();
    expect(row(a.id).querySelectorAll('.tx-strip .tx-thumb').length).toBe(3);
    expect(row(b.id).hidden).toBe(true);
    expect(row(c.id).hidden).toBe(true);
    expect(row(a.id).querySelector('.tx-strip')?.getAttribute('aria-label')).toBe('3 images');
    expect(v.hasItem(b.id)).toBe(true);

    // A tool row arrives between c and a fourth image: a new strip after it.
    const tool = item('tool', { tool: { name: 'Bash', input_summary: 'ls', status: 'ok' } });
    const d = agent(img(4));
    v.applyUpdates([tool, d]);
    await flush();
    expect(row(a.id).querySelectorAll('.tx-thumb').length).toBe(3);
    expect(row(d.id).hidden).toBe(false);
    expect(row(d.id).querySelectorAll('.tx-thumb').length).toBe(1);

    // b now says something: the run splits (a | b | c) and every row shows its own image.
    v.applyUpdates([{ ...b, parts: [{ text: 'this one matters' }, img(2)] }]);
    await flush();
    expect(row(a.id).querySelectorAll('.tx-thumb').length).toBe(1);
    expect(row(b.id).hidden).toBe(false);
    expect(row(b.id).querySelectorAll('.tx-thumb').length).toBe(1);
    expect(row(c.id).hidden).toBe(false);
    expect(row(c.id).querySelectorAll('.tx-thumb').length).toBe(1);
  });

  it('a user run and an assistant run do not mix, and a merged item is found through its first row', async () => {
    const { feed } = fakeFeed([ref(1), ref(2), ref(3)]);
    const v = mount(feed);
    const u1 = user(img(1));
    const u2 = user(img(2));
    const a1 = agent(img(3));
    v.setItems([u1, u2, a1]);
    await flush();
    expect(row(u1.id).querySelectorAll('.tx-thumb').length).toBe(2);
    expect(row(a1.id).querySelectorAll('.tx-thumb').length).toBe(1);
    const scrolled: Element[] = [];
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    expect(v.scrollToItem(u2.id)).toBe(true);
    expect(scrolled[0]).toBe(row(u1.id));
    expect(v.scrollToItem('nope')).toBe(false);
  });
});
