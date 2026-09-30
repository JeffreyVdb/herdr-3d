import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { ImageRef, TranscriptItem } from '../net/protocol';
import { ImageFeed, LIST_PAGE } from './imageFeed';

const H = (n: number) => n.toString(16).padStart(64, '0');
const ref = (n: number, o: Partial<ImageRef> = {}): ImageRef => ({ source: 'inline', origin: 'input', hash: H(n), mime: 'image/png', item_id: `i${n}`, seq: n, ...o });
const item = (id: string, ...refs: ImageRef[]): TranscriptItem => ({ id, seq: 1, ts: 0, kind: 'user', parts: refs.map((image) => ({ image })) });

type Sent = { t: string; args: Record<string, unknown> };

function feedOf(reply: (s: Sent) => CommandResult = () => ({ ok: true, data: { images: [] } })) {
  const sent: Sent[] = [];
  const feed = new ImageFeed('w', {
    send: (t, args) => {
      const s = { t, args: args as unknown as Record<string, unknown> };
      sent.push(s);
      return Promise.resolve(reply(s));
    },
  });
  return { feed, sent };
}

describe('what the feed calls a change of the session list', () => {
  it('a duplicate occurrence of a known hash and an unavailable image are changes, a re-sent item is not', () => {
    const { feed } = feedOf();
    let changes = 0;
    feed.onChange(() => changes++);
    feed.note([item('a', ref(1))]);
    expect(changes).toBe(1);
    // The same bytes again, in another item: the count badge and the jump target move.
    feed.note([item('b', ref(1))]);
    expect(changes).toBe(2);
    // Refused by the bridge: a card in the tab, a blank print.
    feed.note([item('c', ref(2, { hash: '', unavailable: true, reason: 'not_allowed', source: 'path', path: '/etc/x.png' }))]);
    expect(changes).toBe(3);
    // An update of an item already shown (a streamed message growing) is not.
    feed.note([item('b', ref(1))]);
    feed.noteRefs([ref(1, { item_id: 'a' })]);
    expect(changes).toBe(3);
    // ... but it becoming available is.
    feed.note([item('c', ref(3, { source: 'path', path: '/etc/x.png' }))]);
    expect(changes).toBe(4);
  });

  it('a change makes the next list() ask again', async () => {
    const { feed, sent } = feedOf();
    await feed.list();
    await feed.list();
    expect(sent.filter((s) => s.t === 'transcript.images')).toHaveLength(1);
    feed.note([item('a', ref(1))]);
    feed.note([item('b', ref(1))]);
    await feed.list();
    expect(sent.filter((s) => s.t === 'transcript.images')).toHaveLength(2);
    feed.note([item('c', ref(4, { hash: '', unavailable: true, reason: 'missing' }))]);
    await feed.list();
    expect(sent.filter((s) => s.t === 'transcript.images')).toHaveLength(3);
  });

  it("a subagent's images are fetchable from its log and do not touch the session list", async () => {
    const { feed, sent } = feedOf();
    let changes = 0;
    feed.onChange(() => changes++);
    const r = ref(9);
    expect(feed.canFetch(r)).toBe(false);
    feed.note([item('s1', r)], 'a7');
    expect(changes).toBe(0);
    expect(feed.canFetch(r)).toBe(true);
    await feed.thumb(r.hash as string);
    expect(sent.at(-1)).toEqual({ t: 'transcript.image', args: { id: 'w', hash: r.hash, size: 'thumb', agent: 'a7' } });
  });
});

describe('the session list', () => {
  it('follows the cursor to the end: 2001 images arrive whole and in order', async () => {
    const all = Array.from({ length: 2001 }, (_, i) => ref(i + 1));
    const { feed, sent } = feedOf((s) => {
      const before = s.args.before as string | undefined;
      const end = before ? Number(before.slice(2)) : all.length;
      const start = Math.max(0, end - 800);
      return { ok: true, data: { images: all.slice(start, end), ...(start > 0 ? { cursor: `c:${start}`, has_more: true } : {}) } };
    });
    const refs = await feed.list();
    expect(refs).toHaveLength(2001);
    expect(refs.map((r) => r.item_id)).toEqual(all.map((r) => r.item_id));
    const asks = sent.filter((s) => s.t === 'transcript.images');
    expect(asks).toHaveLength(3);
    expect(asks[0]?.args).toEqual({ id: 'w', limit: LIST_PAGE });
    expect(asks[1]?.args).toEqual({ id: 'w', limit: LIST_PAGE, before: 'c:1201' });
    expect(feed.listed()).toHaveLength(2001);
    expect(feed.canFetch(refs[0] as ImageRef)).toBe(true);
  });

  it('a bridge that repeats its cursor cannot loop it', async () => {
    const { feed, sent } = feedOf(() => ({ ok: true, data: { images: [ref(1)], cursor: 'c:5', has_more: true } }));
    await feed.list();
    expect(sent.filter((s) => s.t === 'transcript.images')).toHaveLength(2);
  });

  it('a failed page fails the list, and the next list() tries again', async () => {
    let fail = true;
    const { feed } = feedOf(() => (fail ? { ok: false, code: 'busy', message: 'later' } : { ok: true, data: { images: [ref(1)] } }));
    await expect(feed.list()).rejects.toThrow('later');
    fail = false;
    expect(await feed.list()).toHaveLength(1);
  });
});
