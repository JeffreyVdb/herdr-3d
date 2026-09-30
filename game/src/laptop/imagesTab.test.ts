// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageRef } from '../net/protocol';
import type { ImageData, ImageFeed } from './imageFeed';
import { groupImages, mountImagesTab, tileKey, type ImagesTabHost, type ImagesTabView } from './imagesTab';

const H = (c: string) => c.repeat(64);
const ref = (o: Partial<ImageRef> = {}): ImageRef => ({ source: 'inline', origin: 'input', hash: H('a'), mime: 'image/png', width: 100, height: 50, item_id: 'i', seq: 1, ts: 1000, ...o });

describe('groupImages', () => {
  it('splits by origin, newest first, and counts the same image once per group', () => {
    const shot = ref({ hash: H('1'), ts: 1000, seq: 1, item_id: 'u1' });
    const g = groupImages([
      shot,
      ref({ hash: H('2'), ts: 2000, seq: 2, item_id: 'u2' }),
      { ...shot, ts: 3000, seq: 3, item_id: 'u3' },
      ref({ hash: H('3'), origin: 'agent', kind: 'viewed', ts: 1500, seq: 4, item_id: 't1' }),
      ref({ hash: H('4'), origin: 'agent', kind: 'generated', ts: 2500, seq: 5, item_id: 't2' }),
      // The same bytes on the other side are the other group's tile.
      ref({ hash: H('1'), origin: 'agent', kind: 'viewed', ts: 100, seq: 6, item_id: 't3' }),
    ]);
    expect(g.input.map((t) => [t.ref.hash?.[0], t.count, t.ref.item_id])).toEqual([
      ['1', 2, 'u3'], // newest occurrence; jump goes there
      ['2', 1, 'u2'],
    ]);
    expect(g.agent.map((t) => [t.ref.hash?.[0], t.count])).toEqual([
      ['4', 1],
      ['3', 1],
      ['1', 1],
    ]);
  });

  it('orders ties by place in the conversation and then in the list, and keeps not-available refs apart', () => {
    const g = groupImages([
      ref({ hash: H('a'), ts: 0, seq: 1 }),
      ref({ hash: H('b'), ts: 0, seq: 2 }),
      { source: 'path', origin: 'input', unavailable: true, reason: 'not_allowed', path: '/etc/x.png', seq: 3, ts: 0 },
      { source: 'path', origin: 'input', unavailable: true, reason: 'not_allowed', path: '/etc/x.png', seq: 4, ts: 0 },
      { source: 'path', origin: 'input', unavailable: true, reason: 'missing', path: '/etc/x.png', seq: 5, ts: 0 },
      { source: 'inline', origin: 'input', unavailable: true, reason: 'invalid', seq: 6, ts: 0, item_id: 'a' },
      { source: 'inline', origin: 'input', unavailable: true, reason: 'invalid', seq: 7, ts: 0, item_id: 'a' },
    ]);
    // The same missing path twice is one tile; another reason, or no path at all, is its own.
    expect(g.input.map((t) => t.count)).toEqual([1, 1, 1, 2, 1, 1]);
    expect(g.agent).toEqual([]);
    expect(groupImages([])).toEqual({ input: [], agent: [] });
  });

  it('tileKey is the hash for an image that opened', () => {
    expect(tileKey(ref({ hash: H('9') }), 0)).toBe(`h:${H('9')}`);
    expect(tileKey({ source: 'path', origin: 'input', unavailable: true, path: '/p' }, 3)).toBe('p:/p:');
  });
});

// --- the DOM ---

interface Fake {
  feed: ImageFeed;
  list: ReturnType<typeof vi.fn>;
  thumbs: string[];
  known: Set<string>;
  jumped: ImageRef[];
}

function fakeFeed(refs: ImageRef[] | (() => Promise<ImageRef[]>), goneHashes: string[] = []): Fake {
  const thumbs: string[] = [];
  const known = new Set(refs instanceof Function ? [] : refs.map((r) => r.hash).filter((x): x is string => !!x));
  const list = vi.fn(() => (refs instanceof Function ? refs() : Promise.resolve(refs)));
  const data = (hash: string): ImageData => ({ blob: new Blob(['x']), url: `blob:fake/${hash.slice(0, 4)}`, width: 100, height: 50, mime: 'image/png' });
  const feed = {
    list,
    listed: () => null,
    canFetch: (r: ImageRef) => !!r.hash && !r.unavailable && r.mime !== 'binary' && known.has(r.hash),
    thumb: (hash: string) => {
      thumbs.push(hash);
      return Promise.resolve(goneHashes.includes(hash) ? null : data(hash));
    },
    thumbNow: () => null,
    full: () => Promise.resolve({ ok: false as const, reason: 'error' as const, message: 'no' }),
    onChange: () => () => {},
  } as unknown as ImageFeed;
  return { feed, list, thumbs, known, jumped: [] };
}

const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function mount(f: Fake | null, tabs: HTMLElement | null = null): { root: HTMLElement; view: ImagesTabView; host: ImagesTabHost } {
  const root = document.createElement('div');
  document.body.append(root);
  const host: ImagesTabHost = { feed: f?.feed ?? null, tabs: () => tabs, jump: (r) => f?.jumped.push(r) };
  return { root, view: mountImagesTab(root, host), host };
}

describe('the images tab', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = () => {};
    // jsdom has no <dialog> modal.
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  const shot = ref({ hash: H('1'), item_id: 'u1', ts: 3000, seq: 1, width: 1280, height: 720 });
  const lost: ImageRef = { source: 'path', origin: 'input', unavailable: true, reason: 'not_allowed', path: '/etc/hosts.png', item_id: 'u1', seq: 1, ts: 3000 };
  const viewed = ref({ hash: H('2'), origin: 'agent', kind: 'viewed', item_id: 't1', seq: 2, ts: 4000 });
  const made = ref({ hash: H('3'), origin: 'agent', kind: 'generated', item_id: 'a1', seq: 3, ts: 5000 });
  const binary = ref({ hash: H('4'), origin: 'agent', kind: 'viewed', mime: 'binary', bytes: 2048, item_id: 't2', seq: 4, ts: 6000 });

  it('shows Input and Agent, newest first, a count on a repeated image, and thumbnails as they load', async () => {
    const f = fakeFeed([shot, { ...shot, item_id: 'u2', ts: 3500, seq: 2 }, lost, viewed, made, binary]);
    const { root } = mount(f);
    await tick();
    const groups = [...root.querySelectorAll('.imgs-group')].map((g) => [g.getAttribute('data-origin'), (g as HTMLElement).hidden]);
    expect(groups).toEqual([['input', false], ['agent', false]]);
    const inputTiles = [...root.querySelectorAll('.imgs-group[data-origin="input"] .imgs-item')];
    expect(inputTiles).toHaveLength(2);
    // The screenshot sent twice: one tile with ×2; the lost path is a compact "not available" tile with its path as text.
    const first = inputTiles.find((t) => t.getAttribute('data-hash') === H('1')) as HTMLElement;
    expect(first.querySelector('.imgs-n')?.textContent).toBe('×2');
    expect(first.querySelector('.imgs-n')?.hasAttribute('hidden')).toBe(false);
    const gone = inputTiles.find((t) => t.classList.contains('imgs-item-gone')) as HTMLElement;
    expect(gone.textContent).toContain('Not available');
    expect(gone.querySelector('.imgs-gone-path')?.textContent).toBe('/etc/hosts.png');
    // Agent: newest first (binary, generated, viewed), each with its kind; binary is a chip and fetches nothing.
    const agent = [...root.querySelectorAll('.imgs-group[data-origin="agent"] .imgs-item')];
    expect(agent.map((t) => t.querySelector('.imgs-kind')?.textContent)).toEqual(['viewed', 'generated', 'viewed']);
    expect(agent[0]?.querySelector('.imgs-chip-t')?.textContent).toBe('binary');
    expect(f.thumbs.sort()).toEqual([H('1'), H('2'), H('3')].sort());
    expect(first.querySelector<HTMLImageElement>('.imgs-img')?.getAttribute('src')).toMatch(/^blob:fake\//);
    expect(root.querySelector('.imgs-count-total')?.textContent).toBe('5 images');
    expect(root.querySelector('.imgs-h-n')?.textContent).toBe('2');
  });

  it('a thumbnail the bridge will not give becomes a not-available tile', async () => {
    const f = fakeFeed([shot], [H('1')]);
    const { root } = mount(f);
    await tick();
    const tile = root.querySelector('.imgs-item') as HTMLElement;
    expect(tile.classList.contains('imgs-item-gone')).toBe(true);
    expect(tile.textContent).toContain('Not available');
  });

  it('an empty session says what will show up, and a failed list can be tried again', async () => {
    const empty = fakeFeed([]);
    const a = mount(empty);
    await tick();
    expect(a.root.querySelector('.imgs')?.getAttribute('data-state')).toBe('empty');
    expect(a.root.querySelector('.imgs-empty-t')?.textContent).toBe('No images in this conversation yet');
    expect([...a.root.querySelectorAll('.imgs-group')].every((g) => (g as HTMLElement).hidden)).toBe(true);
    let n = 0;
    const flaky = fakeFeed(() => (n++ === 0 ? Promise.reject(new Error('the bridge did not answer')) : Promise.resolve([shot])));
    flaky.known.add(H('1'));
    const b = mount(flaky);
    await tick();
    expect(b.root.querySelector('.imgs')?.getAttribute('data-state')).toBe('error');
    expect(b.root.querySelector('.imgs-err')?.textContent).toContain('the bridge did not answer');
    b.root.querySelector<HTMLButtonElement>('.imgs-link')?.click();
    await tick();
    expect(b.root.querySelector('.imgs')?.getAttribute('data-state')).toBe('ready');
    // No feed at all (no transcript): nothing to fetch, nothing to show.
    const c = mount(null);
    await tick();
    expect(c.root.querySelector('.imgs')?.getAttribute('data-state')).toBe('empty');
  });

  it('refresh asks again and updates in place: a new image appears, an old tile keeps its element', async () => {
    let refs = [shot];
    const f = fakeFeed(() => Promise.resolve(refs));
    f.known.add(H('1'));
    f.known.add(H('5'));
    const { root, view } = mount(f);
    await tick();
    const before = root.querySelector('.imgs-item') as HTMLElement;
    refs = [shot, ref({ hash: H('5'), item_id: 'u9', ts: 9000, seq: 9 })];
    view.refresh();
    await tick();
    const tiles = [...root.querySelectorAll('.imgs-group[data-origin="input"] .imgs-item')];
    expect(tiles.map((t) => t.getAttribute('data-hash'))).toEqual([H('5'), H('1')]); // newest first
    expect(tiles[1]).toBe(before);
    expect(f.list).toHaveBeenCalledTimes(2);
  });

  it('a click opens the lightbox on that image with its neighbours, and jump goes to the message', async () => {
    const f = fakeFeed([shot, viewed, made]);
    const { root } = mount(f);
    await tick();
    root.querySelector<HTMLButtonElement>('.imgs-group[data-origin="agent"] .imgs-item[data-hash="' + H('2') + '"] .imgs-tile')?.click();
    const dlg = document.querySelector('dialog.ilb') as HTMLDialogElement;
    expect(dlg).toBeTruthy();
    // Visible order: Input, then Agent newest first: shot, generated, viewed.
    expect(dlg.querySelector('.ilb-count')?.textContent).toBe('3 / 3');
    expect(dlg.querySelector('.ilb-badge')?.textContent).toBe('Agent viewed');
    (dlg.querySelector('.ilb-jump') as HTMLButtonElement).click();
    expect(f.jumped.map((r) => r.item_id)).toEqual(['t1']);
    expect(document.querySelector('dialog.ilb')).toBeNull();
  });

  it('arrow keys move between tiles, Enter is the tile button’s, and nothing reaches the game', async () => {
    const f = fakeFeed([shot, viewed, made]);
    const { root } = mount(f);
    await tick();
    const scroller = root.querySelector('.imgs-scroll') as HTMLElement;
    const seen: string[] = [];
    document.addEventListener('keydown', (e) => seen.push(e.key));
    const press = (key: string, target: Element = document.activeElement ?? scroller) => {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      target.dispatchEvent(e);
      return e;
    };
    const tiles = [...root.querySelectorAll<HTMLElement>('.imgs-tile')];
    press('ArrowRight', scroller);
    expect(document.activeElement).toBe(tiles[0]);
    press('ArrowRight');
    expect(document.activeElement).toBe(tiles[1]);
    press('End');
    expect(document.activeElement).toBe(tiles[2]);
    press('Home');
    expect(document.activeElement).toBe(tiles[0]);
    press('Enter');
    expect(seen).toEqual([]); // handled here; the seated view's own keys never see them
    // A key the tab does not use goes on (the flip key is the seat's).
    const i = press('i');
    expect(i.defaultPrevented).toBe(false);
    expect(seen).toEqual(['i']);
  });

  it('puts the mode’s tab strip in its bar and cleans up on destroy', async () => {
    const strip = document.createElement('div');
    strip.className = 'seat-tabs';
    const f = fakeFeed([shot]);
    const { root, view } = mount(f, strip);
    await tick();
    expect(root.querySelector('.imgs-bar .seat-tabs')).toBe(strip);
    view.destroy();
    expect(root.querySelector('.imgs')).toBeNull();
    view.destroy(); // twice is fine
  });
});
