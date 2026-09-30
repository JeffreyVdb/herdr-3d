import type { Raycaster } from 'three/webgpu';
import type { ImageRef } from '../net/protocol';
import type { PrintMeshes } from '../render/prints';
import { openImageLightbox } from '../ui/imageLightbox';
import { pickPrints, PRINT_DESKS, type PrintPick } from '../world/prints';
import { WatchPlanner, type Candidate, type ScreenConfig } from '../world/screens';
import type { ImageFeed, ImageFeeds } from './imageFeed';

/**
 * M16 phase 2: which desks have prints, and what is on them. The nearest `PRINT_DESKS` desks in view (with the one you
 * sit at) are "active": their worker's transcript is watched with a handful of items (the images come from
 * `transcript.images`, not from the window), the list is turned into prints (`world/prints.ts`), the thumbnails are
 * fetched and become textures on the desk's picture planes (`render/prints.ts`). A desk that stops being near or in view
 * (the planner's hysteresis, as the live screens') loses all of it: prints removed, textures disposed, bitmaps closed,
 * the watch dropped (which lets go of the feed's thumbnails and object URLs). Nothing is fetched for any other desk, and
 * nothing here runs per frame: `update` is the laptop plan's (every 250 ms), `tick` follows it.
 */

/** Desks with prints are chosen like live screens are, a little nearer. */
export const PRINT_CFG: ScreenConfig = {
  live: PRINT_DESKS,
  fps: 0,
  seatedFps: 0,
  range: 5,
  keepRange: 7,
  graceMs: 4000,
  swapMargin: 1,
  minHoldMs: 2500,
  retryMs: 10_000,
};

/** Items a print-only transcript watch asks for. */
export const PRINT_WATCH_LIMIT = 1;
/** A new image makes the list stale; it is read again this long after (a burst of images is one read). */
export const RELIST_MS = 1000;
const RETRY_MS = 3000;

export interface PrintsHost {
  feeds: ImageFeeds;
  /** The transcript watch of a worker was acked (the bridge answers `transcript.images` only then). */
  ready(id: string): boolean;
  /** A thumbnail's bytes as a bitmap (flipped, for a texture). */
  decode(blob: Blob): Promise<ImageBitmap>;
}

interface State {
  id: string;
  desk: number;
  /** Tells a late answer for a desk that lost its prints (or its worker) from this one. */
  gen: number;
  feed: ImageFeed | null;
  off: (() => void) | null;
  picks: PrintPick[];
  dirtyAt: number | null;
  refreshing: boolean;
  /** Prints whose thumbnail is being made, is made, or cannot be (blank for good until the feed resets). */
  tried: Set<string>;
}

export interface PrintDeskInfo {
  id: string;
  desk: number;
  prints: Array<{ key: string; tray: 'in' | 'out'; blank: boolean; loaded: boolean; x: number; z: number; yaw: number }>;
  textures: number;
}

export class Prints {
  readonly planner = new WatchPlanner(PRINT_CFG);
  private meshes: PrintMeshes | null = null;
  private readonly states = new Map<string, State>();
  private readonly pinned = new Map<string, number>();
  private gen = 0;
  /** Lightboxes opened from a print (test hook). */
  lightboxes = 0;
  private now = 0;

  constructor(
    private readonly host: PrintsHost,
    /** `?prints=<n>`: how many desks near you have prints (0 turns them off, like `screens=0`). */
    readonly desksMax = PRINT_DESKS,
  ) {}

  /** The floor you are on changed (null: none): every desk's prints go. */
  setMeshes(meshes: PrintMeshes | null): void {
    if (meshes === this.meshes) return;
    this.clear();
    this.meshes?.dispose();
    this.meshes = meshes;
  }

  get active(): string[] {
    return [...this.states.keys()];
  }

  /**
   * Once per plan. `cands` are the desks the camera could see prints on; `desks` maps every seated worker of the floor to
   * its desk; `seat` is the worker you sit at; `enabled` false (asleep, offline, no transcripts) takes every print away.
   */
  update(now: number, cands: readonly Candidate[], desks: ReadonlyMap<string, number>, seat: string | null, enabled: boolean): void {
    this.now = now;
    if (!enabled || !this.meshes || this.desksMax <= 0) {
      this.planner.clear();
      this.clear();
      return;
    }
    this.planner.plan(now, cands, this.desksMax);
    const want = new Set(this.planner.live);
    if (seat && desks.has(seat)) want.add(seat);
    for (const id of this.pinned.keys()) if (desks.has(id)) want.add(id);
    for (const id of [...this.states.keys()]) {
      const d = desks.get(id);
      const st = this.states.get(id) as State;
      if (!want.has(id) || d === undefined) this.deactivate(id);
      else if (d !== st.desk) {
        // Moved desks: start over there.
        this.deactivate(id);
        this.activate(id, d);
      }
    }
    for (const id of want) {
      const d = desks.get(id);
      if (d !== undefined && !this.states.has(id)) this.activate(id, d);
    }
    this.tick(now);
  }

  /** A watch was refused or failed: not tried again for a while. */
  failed(id: string, now: number): void {
    this.planner.failed(id, now);
    if (!this.pinned.has(id)) this.deactivate(id);
  }

  /** The watch ended on the bridge's side. */
  forget(id: string): void {
    this.planner.forget(id);
  }

  /** The workers whose transcripts the prints need watched (a few items each). */
  wants(): string[] {
    return this.active;
  }

  private activate(id: string, desk: number): void {
    const st: State = { id, desk, gen: ++this.gen, feed: null, off: null, picks: [], dirtyAt: this.now, refreshing: false, tried: new Set() };
    this.states.set(id, st);
    this.follow(st);
  }

  private follow(st: State): void {
    const feed = this.host.feeds.get(st.id);
    if (feed === st.feed) return;
    st.off?.();
    st.feed = feed;
    st.off = feed.onChange(() => this.mark(st));
    // A new feed knows nothing of what was tried before.
    st.tried.clear();
    this.mark(st);
  }

  private mark(st: State): void {
    if (this.states.get(st.id) !== st) return;
    // The first read is not delayed; later ones wait for the burst of images to end.
    const at = this.now + (st.picks.length ? RELIST_MS : 0);
    st.dirtyAt = st.dirtyAt === null ? at : Math.min(st.dirtyAt, at);
  }

  private deactivate(id: string): void {
    const st = this.states.get(id);
    if (!st) return;
    this.states.delete(id);
    st.gen = ++this.gen;
    st.off?.();
    st.off = null;
    this.meshes?.clearDesk(st.desk);
  }

  /** Every desk loses its prints. */
  clear(): void {
    for (const id of [...this.states.keys()]) this.deactivate(id);
  }

  /** After `update`: reads the lists that are due. */
  tick(now: number): void {
    this.now = now;
    for (const st of this.states.values()) {
      this.follow(st);
      if (st.dirtyAt === null || now < st.dirtyAt || st.refreshing || !this.host.ready(st.id)) continue;
      this.refresh(st);
    }
  }

  private refresh(st: State): void {
    const feed = st.feed;
    if (!feed || feed.isDisposed) return;
    const gen = st.gen;
    st.refreshing = true;
    st.dirtyAt = null;
    void feed
      .list()
      .then((refs) => {
        if (st.gen !== gen || this.states.get(st.id) !== st) return;
        this.show(st, refs);
      })
      .catch(() => {
        if (st.gen === gen && this.states.get(st.id) === st) st.dirtyAt = this.now + RETRY_MS;
      })
      .finally(() => {
        if (st.gen === gen) st.refreshing = false;
      });
  }

  private show(st: State, refs: readonly ImageRef[]): void {
    const meshes = this.meshes;
    const feed = st.feed;
    if (!meshes || !feed) return;
    st.picks = pickPrints(refs);
    meshes.setDesk(st.desk, st.id, st.picks);
    for (const p of st.picks) {
      if (p.blank || !p.ref.hash || st.tried.has(p.key) || meshes.loaded(st.desk).has(p.key)) continue;
      if (!feed.canFetch(p.ref)) continue;
      st.tried.add(p.key);
      this.load(st, p, feed);
    }
  }

  private load(st: State, p: PrintPick, feed: ImageFeed): void {
    const gen = st.gen;
    void feed
      .thumb(p.ref.hash as string)
      .then(async (d) => {
        if (!d || st.gen !== gen) return;
        const bmp = await this.host.decode(d.blob);
        const meshes = this.meshes;
        if (st.gen !== gen || !meshes || this.states.get(st.id) !== st) {
          bmp.close();
          return;
        }
        const tex = meshes.texture(bmp);
        if (!meshes.setTexture(st.desk, p.key, tex)) meshes.release(tex);
      })
      .catch(() => {
        /* stays a blank card */
      });
  }

  // --- clicks ---

  /** A ray (the crosshair, the pointer) at the prints: opens the lightbox on the one it hits. */
  click(ray: Raycaster): boolean {
    const meshes = this.meshes;
    if (!meshes) return false;
    const hit = meshes.pick(ray);
    if (!hit) return false;
    const st = [...this.states.values()].find((s) => s.desk === hit.desk);
    const feed = st?.feed;
    if (!st || !feed) return false;
    const picks = meshes.picks(hit.desk);
    const id = st.id;
    this.pinned.set(id, (this.pinned.get(id) ?? 0) + 1);
    this.lightboxes++;
    openImageLightbox({
      feed,
      refs: picks.map((p) => p.ref),
      index: hit.index,
      onClosed: () => {
        const n = (this.pinned.get(id) ?? 1) - 1;
        if (n <= 0) this.pinned.delete(id);
        else this.pinned.set(id, n);
      },
    });
    return true;
  }

  /** A print's place in the world (test hook). */
  worldOf(desk: number, index: number): { x: number; y: number; z: number } | null {
    return this.meshes?.worldPosition(desk, index) ?? null;
  }

  /** Workers kept active while a lightbox from one of their prints is open. */
  pins(): string[] {
    return [...this.pinned.keys()];
  }

  // --- test hooks ---

  info(): PrintDeskInfo[] {
    const m = this.meshes;
    if (!m) return [];
    return [...this.states.values()].map((st) => {
      const i = m.info(st.desk);
      return { id: st.id, desk: st.desk, prints: i?.prints ?? [], textures: m.loaded(st.desk).size };
    });
  }

  counts(): { alive: number; created: number; disposed: number; closed: number; desks: number } {
    const l = this.meshes?.ledger;
    return { alive: this.meshes?.texturesAlive ?? 0, created: l?.created ?? 0, disposed: l?.disposed ?? 0, closed: l?.closed ?? 0, desks: this.states.size };
  }

  dispose(): void {
    this.setMeshes(null);
  }
}

/** A thumbnail's blob as an upright bitmap for a texture. */
export function decodeBitmap(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none' });
}

/** `?prints=<n>`: desks with prints around you (default PRINT_DESKS, 0: none, at most 4). */
export function printsParam(v: string | null, def = PRINT_DESKS): number {
  if (v === null || v.trim() === '') return def;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? Math.min(4, n) : def;
}
