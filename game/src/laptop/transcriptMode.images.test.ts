import { describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { ImageRef, TranscriptItem } from '../net/protocol';
import type { ImageFeed } from './imageFeed';
import type { ImagesTabHost, ImagesTabView, MountImagesTab } from './imagesTab';
import { distinctImages, TranscriptMode, type MountTranscript, type ReadMode, type SeatMode, type SeatTabs, type TranscriptRenderHost } from './transcriptMode';
import { TranscriptWatches, watchAck } from './transcriptWatches';

// The third seat mode (M16 phase 2): the images tab next to the conversation, in one overlay, without a DOM.

const item = (id: string, seq = 1): TranscriptItem => ({ id, seq, ts: 0, kind: 'assistant', parts: [{ text: id }] });
const ref = (o: Partial<ImageRef> = {}): ImageRef => ({ source: 'inline', origin: 'input', hash: 'a'.repeat(64), mime: 'image/png', ...o });

class FakeBox {
  hidden = false;
  focused = 0;
  style: Record<string, string> = {};
  constructor(private readonly into: FakeBox[]) {
    into.push(this);
  }
  remove(): void {
    const i = this.into.indexOf(this);
    if (i >= 0) this.into.splice(i, 1);
  }
  focus(): void {
    this.focused++;
  }
}

class FakeView {
  calls: string[] = [];
  destroyed = false;
  present = new Set<string>();
  tabs = 0;
  focused = 0;
  constructor(readonly host: TranscriptRenderHost) {}
  setItems(items: TranscriptItem[]): void {
    this.present = new Set(items.map((i) => i.id));
    this.calls.push(`set ${items.map((i) => i.id).join(',')}`);
  }
  applyUpdates(): void {}
  setBlocked(): void {}
  setAsk(): void {}
  setFollowup(): void {}
  setActivity(): void {}
  setPending(): void {}
  attachTabs(): void {
    this.tabs++;
  }
  hasItem(id: string): boolean {
    return this.present.has(id);
  }
  scrollToItem(id: string): boolean {
    this.calls.push(`scroll ${id}`);
    return this.present.has(id);
  }
  focus(): void {
    this.focused++;
  }
  focusPrompt(): void {
    this.calls.push('prompt');
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeTab implements ImagesTabView {
  destroyed = false;
  refreshed = 0;
  focused = 0;
  constructor(readonly host: ImagesTabHost) {}
  focus(): void {
    this.focused++;
  }
  refresh(): void {
    this.refreshed++;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class MemStorage {
  data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function fakeFeed(lists: ImageRef[][] = [[]]) {
  const listeners = new Set<() => void>();
  let n = 0;
  const feed = {
    list: vi.fn(() => Promise.resolve(lists[Math.min(n++, lists.length - 1)] as ImageRef[])),
    onChange: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    fire: () => listeners.forEach((f) => f()),
    listeners,
  };
  return feed;
}

function harness(o: { feed?: ReturnType<typeof fakeFeed> | null; images?: boolean; storage?: MemStorage } = {}) {
  const layer: FakeBox[] = [];
  const panes: FakeBox[] = [];
  const views: FakeView[] = [];
  const tabs: FakeTab[] = [];
  const stripUpdates: Array<[ReadMode, number | null]> = [];
  let strips = 0;
  let stripsDisposed = 0;
  const sent: Array<{ t: string; args: Record<string, unknown>; resolve: (r: CommandResult) => void }> = [];
  const status: Array<[string, string | null]> = [];
  const modes: SeatMode[] = [];
  const mount: MountTranscript = (_box, host) => {
    const v = new FakeView(host);
    views.push(v);
    return v;
  };
  const mountTab: MountImagesTab = (_box, host) => {
    const t = new FakeTab(host);
    tabs.push(t);
    return t;
  };
  const storage = o.storage ?? new MemStorage();
  const feed = o.feed === undefined ? fakeFeed() : o.feed;
  const tx = new TranscriptMode({
    feed: () => feed as unknown as ImageFeed | null,
    send: (t, args) => new Promise((resolve) => sent.push({ t, args: args as unknown as Record<string, unknown>, resolve })),
    renderer: () => Promise.resolve(mount),
    ...(o.images === false
      ? {}
      : {
          imagesRenderer: () => Promise.resolve(mountTab),
          pane: () => new FakeBox(panes) as unknown as HTMLElement,
          tabs: (): SeatTabs => ({
            create: () => {
              strips++;
              return {} as HTMLElement;
            },
            update: (m, n) => stripUpdates.push([m, n]),
            dispose: () => {
              stripsDisposed++;
            },
          }),
        }),
    overlay: () => new FakeBox(layer) as unknown as HTMLElement,
    storage: storage as unknown as Storage,
    status: (kind, text) => status.push([kind, text]),
    modeChanged: (m) => modes.push(m),
  });
  return { tx, layer, panes, views, tabs, sent, status, modes, storage, feed, stripUpdates, strips: () => strips, stripsDisposed: () => stripsDisposed };
}

describe('the images mode', () => {
  it('mounts the tab on the first switch to it, next to the conversation, in one overlay', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
    h.tx.setMode('images');
    expect(h.tx.mode).toBe('images');
    expect(h.tx.shown).toBe(true);
    expect(h.layer).toHaveLength(1);
    await flush();
    expect(h.tabs).toHaveLength(1);
    expect(h.views).toHaveLength(0); // the conversation is not built until it is asked for
    expect(h.tx.tabMounted).toBe(true);
    // The conversation later: both live, one shown, one overlay.
    h.tx.flip();
    await flush();
    expect(h.tx.mode).toBe('transcript');
    expect(h.views).toHaveLength(1);
    expect(h.views[0]?.tabs).toBe(1); // it got its strip
    expect(h.layer).toHaveLength(1);
    expect(h.panes).toHaveLength(2);
    expect(h.panes.map((p) => p.hidden)).toEqual([true, false]); // the tab's pane hidden, the conversation's shown
    h.tx.flip();
    expect(h.tx.mode).toBe('images');
    expect(h.panes.map((p) => p.hidden)).toEqual([false, true]);
    expect(h.tabs).toHaveLength(1); // not mounted twice
    expect(h.tabs[0]?.refreshed).toBeGreaterThan(0); // asked again when shown
    expect(h.modes).toEqual(['terminal', 'images', 'transcript', 'images']);
  });

  it('Ctrl+Esc goes back to the view you read last', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
    h.tx.toggle();
    expect(h.tx.mode).toBe('transcript');
    h.tx.flip();
    h.tx.toggle();
    expect(h.tx.mode).toBe('terminal');
    h.tx.toggle();
    expect(h.tx.mode).toBe('images');
    h.tx.flip();
    h.tx.toggle();
    h.tx.toggle();
    expect(h.tx.mode).toBe('transcript');
    // flip does nothing at the terminal.
    h.tx.toggle();
    h.tx.flip();
    expect(h.tx.mode).toBe('terminal');
  });

  it('remembers the last view per worker (and survives blocked storage)', () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
    h.tx.setMode('images');
    h.tx.sit('b', 'Bo');
    expect(h.tx.mode).toBe('terminal');
    h.tx.setMode('transcript');
    h.tx.sit('a', 'Ada');
    expect(h.tx.mode).toBe('images');
    h.tx.sit('b', 'Bo');
    expect(h.tx.mode).toBe('transcript');
    // The bridge has no transcripts: the terminal.
    h.tx.sit('a', 'Ada', false);
    expect(h.tx.mode).toBe('terminal');
    // A new controller reads the same storage.
    const again = harness({ storage: h.storage as MemStorage });
    again.tx.sit('a', 'Ada');
    expect(again.tx.mode).toBe('images');
    // Terminal last: forgotten.
    again.tx.toggle();
    const third = harness({ storage: h.storage as MemStorage });
    third.tx.sit('a', 'Ada');
    expect(third.tx.mode).toBe('terminal');
    const blocked = harness({
      storage: {
        getItem: () => {
          throw new Error('x');
        },
        setItem: () => {
          throw new Error('x');
        },
        removeItem: () => {
          throw new Error('x');
        },
      } as unknown as MemStorage,
    });
    blocked.tx.sit('a', 'Ada');
    blocked.tx.setMode('images');
    expect(blocked.tx.mode).toBe('images');
  });

  it('without an images tab the mode is the conversation', () => {
    const h = harness({ images: false });
    h.tx.sit('a', 'Ada');
    h.tx.setMode('images');
    expect(h.tx.mode).toBe('transcript');
    h.tx.flip(); // there is nothing to flip to
    expect(h.tx.mode).toBe('transcript');
  });

  it('a tab module that does not load falls back to the conversation and says so', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
    const tx = new TranscriptMode({
      feed: () => null,
      send: () => Promise.resolve({ ok: true, data: {} }),
      renderer: () => Promise.resolve((() => new FakeView({} as TranscriptRenderHost)) as unknown as MountTranscript),
      imagesRenderer: () => Promise.resolve(null),
      pane: () => new FakeBox([]) as unknown as HTMLElement,
      overlay: () => new FakeBox([]) as unknown as HTMLElement,
      storage: null,
      status: (k, t) => h.status.push([k, t]),
      modeChanged: () => {},
    });
    tx.sit('a', 'Ada');
    tx.setMode('images');
    await flush();
    expect(tx.mode).toBe('transcript');
    expect(h.status.at(-1)?.[0]).toBe('error');
  });

  it('counts the distinct images for the strip, and asks again (debounced) when the feed says they changed', async () => {
    vi.useFakeTimers();
    try {
      const shot = ref({ hash: '1'.repeat(64) });
      const feed = fakeFeed([[shot, { ...shot }, ref({ hash: '2'.repeat(64), origin: 'agent' })], [shot, ref({ hash: '3'.repeat(64) })]]);
      const h = harness({ feed });
      h.tx.sit('a', 'Ada');
      h.tx.setMode('transcript');
      await vi.advanceTimersByTimeAsync(0);
      expect(h.tx.imageCount).toBe(2); // the same screenshot twice is one
      // A burst of changes: one list.
      feed.fire();
      feed.fire();
      feed.fire();
      expect(feed.list).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(400);
      expect(feed.list).toHaveBeenCalledTimes(2);
      expect(h.tx.imageCount).toBe(2);
      expect(h.stripUpdates.at(-1)).toEqual(['transcript', 2]);
      // Standing up drops the listener and any timer.
      feed.fire();
      h.tx.stand();
      expect(feed.listeners.size).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(feed.list).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinctImages: the same bytes are one image per origin; a path that was not opened counts alone', () => {
    const a = ref({ hash: 'a'.repeat(64) });
    expect(distinctImages([a, { ...a }, { ...a, origin: 'agent' }])).toBe(2);
    expect(distinctImages([{ source: 'path', origin: 'input', unavailable: true, path: '/x.png' }, { source: 'path', origin: 'input', unavailable: true, path: '/x.png' }])).toBe(2);
    expect(distinctImages([])).toBe(0);
  });
});

describe('jump to message', () => {
  const jumpRef = (item_id: string): ImageRef => ref({ item_id, seq: 3, ts: 5 });

  it('goes to the conversation and scrolls to an item that is loaded', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
    h.tx.reset('a', watchAck({ harness: 'claude', session: 's', cursor: 'c:1', has_more: false, items: [item('x1'), item('x2', 2)] }));
    h.tx.setMode('images');
    await flush();
    await h.tx.jump(jumpRef('x2'));
    await flush();
    expect(h.tx.mode).toBe('transcript');
    expect(h.views[0]?.calls.at(-1)).toBe('scroll x2');
    expect(h.sent).toEqual([]); // no paging: it was there
  });

  it('pages older items in until the message is found, then scrolls to it', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
    h.tx.reset('a', watchAck({ harness: 'claude', session: 's', cursor: 'c:201', has_more: true, items: [item('n1', 201), item('n2', 202)] }));
    h.tx.setMode('images');
    await flush();
    void h.tx.jump(jumpRef('old-3'));
    await flush();
    expect(h.tx.mode).toBe('transcript');
    // The first page does not have it; the second does.
    expect(h.sent.map((s) => [s.t, s.args])).toEqual([['transcript.page', { id: 'a', before: 'c:201', limit: 200 }]]);
    h.sent[0]?.resolve({ ok: true, data: { items: [item('old-1', 1), item('old-2', 2)], cursor: 'c:1', has_more: true } });
    await flush();
    // (the cursor is the page's own: the next page starts before it)
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.args).toEqual({ id: 'a', before: 'c:1', limit: 200 });
    h.sent[1]?.resolve({ ok: true, data: { items: [item('old-3', 0)], cursor: 'c:0', has_more: false } });
    await flush();
    expect(h.views[0]?.calls.at(-1)).toBe('scroll old-3');
    // The timeline is in seq order with the older items first.
    expect(h.views[0]?.calls.filter((c) => c.startsWith('set')).at(-1)).toBe('set old-3,old-1,old-2,n1,n2');
    expect(h.tx.itemCount).toBe(5);
  });

  it('gives up with a message when the message is not to be found', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
    h.tx.reset('a', watchAck({ harness: 'claude', session: 's', cursor: 'c:5', has_more: true, items: [item('n1', 5)] }));
    h.tx.setMode('transcript');
    await flush();
    const p = h.tx.jump(jumpRef('nowhere'));
    await flush();
    h.sent[0]?.resolve({ ok: true, data: { items: [item('o', 1)], cursor: 'c:1', has_more: false } });
    await expect(p.then(() => flush()).then(() => h.status.at(-1))).resolves.toEqual(['error', 'That message is too far back to show here.']);
    // A failed page says why, too.
    const g = harness();
    g.tx.sit('a', 'Ada');
    g.tx.reset('a', watchAck({ harness: 'claude', session: 's', cursor: 'c:5', has_more: true, items: [item('n1', 5)] }));
    g.tx.setMode('transcript');
    await flush();
    void g.tx.jump(jumpRef('nowhere'));
    await flush();
    g.sent[0]?.resolve({ ok: false, code: 'invalid_state', message: 'the transcript changed' });
    await flush();
    expect(g.status.at(-1)?.[0]).toBe('error');
  });

  it('waits for the conversation to mount when the tab was the first view', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
    h.tx.reset('a', watchAck({ harness: 'claude', session: 's', cursor: 'c:1', has_more: false, items: [item('x1'), item('x2', 2)] }));
    h.tx.setMode('images');
    await flush();
    expect(h.views).toHaveLength(0);
    await h.tx.jump(jumpRef('x1'));
    await flush();
    expect(h.views).toHaveLength(1);
    expect(h.views[0]?.calls.at(-1)).toBe('scroll x1');
  });

  it('an image with no item to go to does nothing', async () => {
    const h = harness();
    h.tx.sit('a', 'Ada');
    h.tx.setMode('images');
    await expect(h.tx.jump(ref())).resolves.toBe(false);
    expect(h.tx.mode).toBe('images');
  });
});

describe('sit / read / stand cycles with the images tab', () => {
  it('20 cycles leave no views, tabs, overlays, panes, strips, listeners or watches behind', async () => {
    const feed = fakeFeed([[ref({ item_id: 'i0' })]]);
    const h = harness({ feed });
    const wsent: Array<{ t: string; id: string; resolve: (r: CommandResult) => void }> = [];
    const tw = new TranscriptWatches({
      send: (t, args) => new Promise((resolve) => wsent.push({ t, id: args.id, resolve })),
      sink: { reset: (id, a) => h.tx.reset(id, a), push: (id, i, u) => h.tx.push(id, i, u), stop: () => {} },
      failed: () => {},
      closed: () => {},
      now: () => 0,
    });
    for (let i = 0; i < 20; i++) {
      const id = `w${i % 3}`;
      h.tx.sit(id, 'Ada');
      tw.sync(new Set([id]));
      wsent.at(-1)?.resolve({ ok: true, data: { items: [item(`i${i}`)] } });
      await flush();
      h.tx.toggle(); // the conversation
      if (i % 2) h.tx.flip(); // the images
      if (i % 4 === 0) h.tx.toggle(); // the terminal
      await flush();
      if (i % 3 === 0) {
        h.tx.setMode('images');
        await flush();
      }
      feed.fire();
      h.tx.stand();
      tw.sync(new Set());
      await flush();
      expect(h.layer).toHaveLength(0);
      expect(h.panes).toHaveLength(0);
      expect(feed.listeners.size).toBe(0);
    }
    const c = h.tx.counts;
    expect(c.overlays).toBe(c.removed);
    expect(c.mounted).toBe(c.destroyed);
    expect(c.tabsMounted).toBe(c.tabsDestroyed);
    expect(c.tabsMounted).toBeGreaterThan(0);
    expect(h.views.every((v) => v.destroyed)).toBe(true);
    expect(h.tabs.every((t) => t.destroyed)).toBe(true);
    expect(h.strips()).toBeGreaterThan(0);
    expect(h.stripsDisposed()).toBeGreaterThan(0);
    expect(tw.count).toBe(0);
  });

  it('standing up while the tab module loads mounts nothing', async () => {
    let done: (m: MountImagesTab) => void = () => {};
    const layer: FakeBox[] = [];
    const tabs: FakeTab[] = [];
    const tx = new TranscriptMode({
      feed: () => null,
      send: () => Promise.resolve({ ok: true, data: {} }),
      renderer: () => Promise.resolve(null),
      imagesRenderer: () => new Promise((r) => (done = r)),
      pane: () => new FakeBox([]) as unknown as HTMLElement,
      overlay: () => new FakeBox(layer) as unknown as HTMLElement,
      storage: null,
      status: () => {},
      modeChanged: () => {},
    });
    tx.sit('a', 'Ada');
    tx.setMode('images');
    tx.stand();
    done((_c, host) => {
      const t = new FakeTab(host);
      tabs.push(t);
      return t;
    });
    await flush();
    expect(tabs).toHaveLength(0);
    expect(layer).toHaveLength(0);
  });
});
