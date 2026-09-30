import './imagesTab.css';
import type { ImageRef } from '../net/protocol';
import { h, ICON, icon } from '../ui/dom';
import { originLabel, openImageLightbox, unavailableText, type Lightbox } from '../ui/imageLightbox';
import type { ImageFeed } from './imageFeed';

/**
 * M16 phase 2: every image of the session in the seated overlay's third mode. Two groups, **Input** (what you attached to
 * a prompt) and **Agent** (what the agent viewed or made, with a small badge for which), newest first. The same image
 * twice is one tile with a count. Thumbnails are fetched as they scroll into view; a click opens the lightbox (with
 * "jump to message" back into the conversation). What the bridge did not open (outside its roots, gone) is a compact
 * "not available" tile with the path as text; bytes that are not an image are a chip.
 */

export interface ImagesTabHost {
  /** This worker's images (null: nothing can be fetched; every image shows as not available). */
  feed: ImageFeed | null;
  /** A fresh Conversation | Images strip for this view's bar (null: none). */
  tabs(): HTMLElement | null;
  /** "Jump to message": the conversation, at the item the image is in. */
  jump(ref: ImageRef): void;
}

export interface ImagesTabView {
  /** The keyboard to the tab (its scroll and arrow keys work at once). */
  focus(): void;
  /** Ask for the list of images again (the tab was shown, or an item with an image arrived). */
  refresh(): void;
  destroy(): void;
}

export type MountImagesTab = (container: HTMLElement, host: ImagesTabHost) => ImagesTabView;

export function mountImagesTab(container: HTMLElement, host: ImagesTabHost): ImagesTabView {
  return new ImagesTab(container, host);
}

// ---------------------------------------------------------------------------------------------------------------
// Grouping (pure)

/** One tile: an image, and how many times it appears in its group. */
export interface Tile {
  /** Stable for the same image: its hash, or (not available) where it came from. */
  key: string;
  /** The newest occurrence: what a click opens and "jump to message" goes to. */
  ref: ImageRef;
  count: number;
}

export interface ImageGroups {
  input: Tile[];
  agent: Tile[];
}

const finite = (n: unknown, d = 0) => (typeof n === 'number' && Number.isFinite(n) ? n : d);

/** The key that makes two refs the same tile within a group. */
export function tileKey(r: ImageRef, i: number): string {
  if (r.hash && !r.unavailable) return `h:${r.hash}`;
  // Not available: the same path is the same missing image; with no path, every one is its own.
  return r.path ? `p:${r.path}:${r.reason ?? ''}` : `u:${r.item_id ?? ''}:${i}`;
}

/**
 * Splits a session's image list by origin, one tile per distinct image, newest first (by time, then place in the
 * conversation, then place in the list). Both groups keep the newest occurrence of an image for the click.
 */
export function groupImages(refs: readonly ImageRef[]): ImageGroups {
  const out: ImageGroups = { input: [], agent: [] };
  const seen: Record<'input' | 'agent', Map<string, Tile & { at: number }>> = { input: new Map(), agent: new Map() };
  const order = (r: ImageRef, i: number) => finite(r.ts) * 1e6 + finite(r.seq) * 1e3 + i;
  refs.forEach((r, i) => {
    const g = r.origin === 'input' ? 'input' : 'agent';
    const key = tileKey(r, i);
    const at = order(r, i);
    const have = seen[g].get(key);
    if (!have) seen[g].set(key, { key, ref: r, count: 1, at });
    else {
      have.count++;
      if (at >= have.at) {
        have.ref = r;
        have.at = at;
      }
    }
  });
  for (const g of ['input', 'agent'] as const) {
    out[g] = [...seen[g].values()].sort((a, b) => b.at - a.at).map(({ key, ref, count }) => ({ key, ref, count }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

const KINDS: Record<string, string> = { viewed: 'viewed', generated: 'generated' };

function clock(ts: number | undefined): string {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return '';
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function size(n: number | undefined): string {
  if (!n || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1 << 20) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1 << 20)).toFixed(1)} MB`;
}

class ImagesTab implements ImagesTabView {
  private readonly root: HTMLDivElement;
  private readonly scroller: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly countEl: HTMLSpanElement;
  private readonly status: HTMLDivElement;
  private readonly lists: Record<'input' | 'agent', HTMLUListElement>;
  private readonly sections: Record<'input' | 'agent', HTMLElement>;
  private readonly heads: Record<'input' | 'agent', HTMLElement>;
  private readonly tiles = new Map<string, HTMLLIElement>();
  private readonly tileOf = new WeakMap<Element, Tile>();
  private groups: ImageGroups = { input: [], agent: [] };
  private refs: ImageRef[] | null = null;
  private error: string | null = null;
  private loading = false;
  private destroyed = false;
  private io: IntersectionObserver | null = null;
  private readonly aborts = new Map<Element, AbortController>();
  private lightbox: Lightbox | null = null;
  /** Bumped by every ask: a late answer to an older one is dropped. */
  private gen = 0;

  constructor(
    container: HTMLElement,
    private readonly host: ImagesTabHost,
  ) {
    this.countEl = h('span', { class: 'imgs-count-total' });
    const bar = h('div', { class: 'imgs-bar' }, h('span', { class: 'imgs-title' }, 'Images'), this.countEl);
    const tabs = host.tabs();
    if (tabs) bar.append(tabs);
    this.status = h('div', { class: 'imgs-status', role: 'status', 'aria-live': 'polite' });
    const section = (g: 'input' | 'agent', title: string, hint: string) => {
      const count = h('span', { class: 'imgs-h-n' });
      const head = h('h3', { class: 'imgs-h' }, h('span', { class: 'imgs-h-t' }, title), count, h('span', { class: 'imgs-h-hint' }, hint));
      const list = h('ul', { class: 'imgs-grid', 'aria-label': title });
      const sec = h('section', { class: 'imgs-group', 'data-origin': g }, head, list);
      this.heads[g] = count;
      this.lists[g] = list;
      this.sections[g] = sec;
      return sec;
    };
    this.heads = {} as Record<'input' | 'agent', HTMLElement>;
    this.lists = {} as Record<'input' | 'agent', HTMLUListElement>;
    this.sections = {} as Record<'input' | 'agent', HTMLElement>;
    this.body = h('div', { class: 'imgs-body' }, section('input', 'Input', 'what you attached to a prompt'), section('agent', 'Agent', 'viewed or generated by the agent'));
    this.scroller = h('div', { class: 'imgs-scroll', tabindex: '-1', 'aria-label': 'Images in this conversation' }, this.status, this.body);
    this.root = h('div', { class: 'imgs' }, bar, this.scroller);
    this.scroller.addEventListener('keydown', (e) => this.onKey(e));
    if (typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver(
        (entries) => {
          for (const en of entries) if (en.isIntersecting) this.load(en.target as HTMLElement);
        },
        { root: this.scroller, rootMargin: '240px 0px' },
      );
    }
    container.append(this.root);
    this.render();
    this.refresh();
  }

  focus(): void {
    if (this.destroyed) return;
    const active = document.activeElement;
    if (active && this.root.contains(active) && active !== this.scroller) return;
    this.scroller.focus({ preventScroll: true });
  }

  refresh(): void {
    if (this.destroyed) return;
    const feed = this.host.feed;
    if (!feed) {
      this.refs = [];
      this.render();
      return;
    }
    const my = ++this.gen;
    this.loading = this.refs === null;
    if (this.error !== null) {
      this.error = null;
      this.loading = true;
    }
    this.render();
    feed.list().then(
      (refs) => {
        if (this.destroyed || my !== this.gen) return;
        this.refs = refs;
        this.error = null;
        this.loading = false;
        this.render();
      },
      (e: unknown) => {
        if (this.destroyed || my !== this.gen) return;
        this.error = e instanceof Error && e.message ? e.message : 'the bridge did not answer';
        this.loading = false;
        this.render();
      },
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.lightbox?.close();
    this.io?.disconnect();
    for (const a of this.aborts.values()) a.abort();
    this.aborts.clear();
    this.tiles.clear();
    this.root.remove();
  }

  // --- rendering ---

  private render(): void {
    this.groups = groupImages(this.refs ?? []);
    const total = this.groups.input.length + this.groups.agent.length;
    this.countEl.textContent = this.refs ? `${total} ${total === 1 ? 'image' : 'images'}` : '';
    this.root.dataset.state = this.error !== null ? 'error' : this.loading ? 'loading' : total ? 'ready' : 'empty';
    this.status.replaceChildren();
    if (this.error !== null) {
      this.status.append(h('span', { class: 'imgs-msg imgs-err' }, `Couldn’t load the images: ${this.error}`), ' ', h('button', { class: 'imgs-link', onclick: () => this.refresh() }, 'Try again'));
    } else if (this.loading) this.status.append(h('span', { class: 'imgs-msg' }, 'Loading the images…'));
    else if (!total) {
      this.status.append(
        h('span', { class: 'imgs-empty-t' }, 'No images in this conversation yet'),
        h('span', { class: 'imgs-msg' }, 'Screenshots you paste or attach show up under Input, pictures the agent looks at or makes under Agent.'),
      );
    }
    this.status.hidden = !this.status.childNodes.length;
    for (const g of ['input', 'agent'] as const) this.renderGroup(g);
  }

  private renderGroup(g: 'input' | 'agent'): void {
    const tiles = this.groups[g];
    this.sections[g].hidden = tiles.length === 0;
    this.heads[g].textContent = tiles.length ? String(tiles.length) : '';
    const want = tiles.map((t) => this.tile(g, t));
    const list = this.lists[g];
    const same = list.children.length === want.length && want.every((li, i) => list.children[i] === li);
    if (!same) {
      const a = document.activeElement;
      const key = a instanceof HTMLElement && list.contains(a) ? a.closest('li')?.dataset.key : undefined;
      list.replaceChildren(...want);
      if (key) list.querySelector<HTMLElement>(`li[data-key="${CSS.escape(key)}"] .imgs-tile`)?.focus({ preventScroll: true });
    }
    // Tiles that left the group are forgotten.
    for (const [k, li] of [...this.tiles]) {
      if (li.dataset.group === g && !tiles.some((t) => `${g}:${t.key}` === k)) {
        this.io?.unobserve(li);
        this.aborts.get(li)?.abort();
        this.aborts.delete(li);
        this.tiles.delete(k);
      }
    }
  }

  /** The tile's element: kept while the image stays, its count and target updated. */
  private tile(g: 'input' | 'agent', t: Tile): HTMLLIElement {
    const id = `${g}:${t.key}`;
    let li = this.tiles.get(id);
    if (!li) {
      li = this.make(g, t);
      this.tiles.set(id, li);
    }
    const r = t.ref;
    this.tileOf.set(li, t);
    const badge = li.querySelector<HTMLElement>('.imgs-n');
    if (badge) {
      badge.textContent = t.count > 1 ? `×${t.count}` : '';
      badge.hidden = t.count < 2;
    }
    const btn = li.querySelector<HTMLElement>('.imgs-tile');
    btn?.setAttribute('aria-label', this.label(t));
    li.dataset.item = r.item_id ?? '';
    return li;
  }

  private label(t: Tile): string {
    const r = t.ref;
    const dims = r.width && r.height ? `, ${r.width} by ${r.height}` : '';
    const times = t.count > 1 ? `, ${t.count} times` : '';
    const gone = r.unavailable || r.mime === 'binary' ? ', not available' : '';
    return `${originLabel(r)}${dims}${times}${gone}`;
  }

  private make(g: 'input' | 'agent', t: Tile): HTMLLIElement {
    const r = t.ref;
    const fetchable = !!r.hash && !r.unavailable && r.mime !== 'binary' && !!this.host.feed?.canFetch(r);
    const binary = r.mime === 'binary';
    const kind = g === 'agent' && r.kind && KINDS[r.kind] ? h('span', { class: `imgs-kind imgs-kind-${r.kind}` }, KINDS[r.kind]) : null;
    const n = h('span', { class: 'imgs-n', hidden: true });
    let face: HTMLElement;
    if (fetchable) {
      const img = h('img', { class: 'imgs-img', alt: '', draggable: 'false', loading: 'lazy', decoding: 'async' });
      face = h('span', { class: 'imgs-face imgs-pending' }, img);
    } else if (binary) {
      face = h('span', { class: 'imgs-face imgs-chip' }, icon(ICON.image), h('span', { class: 'imgs-chip-t' }, 'binary'), h('span', { class: 'imgs-chip-s' }, size(r.bytes)));
    } else {
      face = this.goneFace(r);
    }
    const caption = h('span', { class: 'imgs-cap' }, r.width && r.height ? h('span', { class: 'imgs-dims' }, `${r.width} × ${r.height}`) : null, clock(r.ts) ? h('span', { class: 'imgs-when' }, clock(r.ts)) : null);
    const btn = h('button', { class: 'imgs-tile' }, face, n, kind, caption);
    btn.addEventListener('click', () => this.open(g, t.key));
    const li = h('li', { class: fetchable ? 'imgs-item' : 'imgs-item imgs-item-gone', 'data-key': t.key, 'data-group': g }, btn);
    if (fetchable && r.hash) {
      li.dataset.hash = r.hash;
      if (this.io) this.io.observe(li);
      else queueMicrotask(() => this.load(li));
    }
    return li;
  }

  private goneFace(r: ImageRef): HTMLElement {
    return h(
      'span',
      { class: 'imgs-face imgs-gone' },
      icon(ICON.image),
      h('span', { class: 'imgs-gone-t' }, 'Not available'),
      r.path ? h('code', { class: 'imgs-gone-path', title: r.path }, r.path) : h('span', { class: 'imgs-gone-why' }, unavailableText(r)),
    );
  }

  /** A tile came into view: its thumbnail. */
  private load(li: HTMLElement): void {
    const hash = li.dataset.hash;
    const feed = this.host.feed;
    if (!hash || !feed || li.dataset.loaded || this.aborts.has(li)) return;
    this.io?.unobserve(li);
    const ac = new AbortController();
    this.aborts.set(li, ac);
    const tile = this.tileOf.get(li);
    void feed.thumb(hash, ac.signal).then((d) => {
      this.aborts.delete(li);
      if (this.destroyed || ac.signal.aborted) return;
      const face = li.querySelector<HTMLElement>('.imgs-face');
      const img = li.querySelector<HTMLImageElement>('.imgs-img');
      if (!d || !face || !img) {
        if (tile && face) face.replaceWith(this.goneFace(tile.ref));
        li.classList.add('imgs-item-gone');
        return;
      }
      li.dataset.loaded = '1';
      img.src = d.url;
      face.classList.remove('imgs-pending');
    });
  }

  // --- lightbox ---

  private open(g: 'input' | 'agent', key: string): void {
    const order = [...this.groups.input, ...this.groups.agent];
    const i = (g === 'input' ? 0 : this.groups.input.length) + this.groups[g].findIndex((t) => t.key === key);
    if (i < (g === 'input' ? 0 : this.groups.input.length) || !order[i]) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.lightbox?.close();
    this.lightbox = openImageLightbox({
      feed: this.host.feed,
      refs: order.map((t) => t.ref),
      index: i,
      onJump: (ref) => this.host.jump(ref),
      onClosed: () => {
        this.lightbox = null;
        if (!this.destroyed && opener?.isConnected) opener.focus({ preventScroll: true });
      },
    });
  }

  // --- keys ---

  private tileButtons(): HTMLElement[] {
    return [...this.root.querySelectorAll<HTMLElement>('.imgs-item .imgs-tile')].filter((b) => !b.closest('[hidden]'));
  }

  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    // Enter / Space on a tile or link is the button's; the game must not see it either.
    if ((e.key === 'Enter' || e.key === ' ') && target?.closest('button, a')) {
      e.stopPropagation();
      return;
    }
    const tiles = this.tileButtons();
    const at = tiles.indexOf(document.activeElement as HTMLElement);
    const page = Math.max(80, this.scroller.clientHeight * 0.9);
    const focus = (b: HTMLElement | undefined) => {
      if (!b) return;
      b.focus({ preventScroll: true });
      b.scrollIntoView({ block: 'nearest' });
    };
    switch (e.key) {
      case 'ArrowRight':
        focus(tiles[at < 0 ? 0 : Math.min(tiles.length - 1, at + 1)]);
        break;
      case 'ArrowLeft':
        focus(tiles[at < 0 ? 0 : Math.max(0, at - 1)]);
        break;
      case 'ArrowDown':
      case 'j':
        if (at < 0) focus(tiles[0]);
        else focus(this.vertical(tiles, at, 1));
        break;
      case 'ArrowUp':
      case 'k':
        if (at < 0) this.scroller.scrollTop -= 48;
        else focus(this.vertical(tiles, at, -1));
        break;
      case 'PageDown':
        this.scroller.scrollTop += page;
        break;
      case 'PageUp':
        this.scroller.scrollTop -= page;
        break;
      case 'Home':
        this.scroller.scrollTop = 0;
        focus(tiles[0]);
        break;
      case 'End':
        this.scroller.scrollTop = this.scroller.scrollHeight;
        focus(tiles[tiles.length - 1]);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  /** The tile in the next row (dir 1) or the previous (-1), nearest in x. */
  private vertical(tiles: HTMLElement[], at: number, dir: 1 | -1): HTMLElement | undefined {
    const cur = tiles[at];
    if (!cur) return undefined;
    const r0 = cur.getBoundingClientRect();
    let best: HTMLElement | undefined;
    let bestScore = Infinity;
    for (const t of tiles) {
      const r = t.getBoundingClientRect();
      const dy = (r.top - r0.top) * dir;
      if (dy < 4) continue;
      const score = dy * 1000 + Math.abs(r.left - r0.left);
      if (score < bestScore) {
        best = t;
        bestScore = score;
      }
    }
    return best ?? cur;
  }
}
