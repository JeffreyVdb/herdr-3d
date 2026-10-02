import type { CommandResult } from '../net/client';
import type { CommandArgs } from '../net/protocol';
import type { MonitorCards } from '../render/monitorCards';
import { FRAMES } from '../render/mascotArt';
import type { MonitorPrefs } from '../ui/monitorPrefs';
import { activityOf, basename, cardFace, monitorMode, type CardFace, type MonitorMode } from '../world/activity';
import { hash32 } from '../world/derive';
import { WatchPlanner, type Candidate, type ScreenConfig } from '../world/screens';
import type { WorkerView } from '../world/store';
import { ImageFeed } from './imageFeed';

/**
 * #98: what the desk monitors show while you stand (`world/activity.ts` says which view; `render/monitorCards.ts` draws
 * the cards and images). Once per laptop plan (every 250 ms, nothing here runs per frame but the clock): every desk of
 * the floor gets its card, its resting mascot or its terminal glance, and the laptops leave the covered desks' terminals
 * unwatched. An image is fetched (`transcript.image {id, hash, size: 'thumb'}`, the bridge serves a worker's current
 * activity image to a connection on its floor) only for the few desks near you and in view, chosen like the live screens
 * (`IMAGE_CFG`); every other desk, and one whose fetch failed, shows "Looking at an image" with the mascot holding a
 * picture. A desk that stops being near loses its image (texture disposed, bitmap closed).
 */

/** Desks whose image is fetched: as near as the live screens, as many. */
export const IMAGE_CFG: ScreenConfig = {
  live: 4,
  fps: 0,
  seatedFps: 0,
  range: 9,
  keepRange: 12,
  graceMs: 2500,
  swapMargin: 1.5,
  minHoldMs: 3000,
  retryMs: 10_000,
};

/** The counter ticks once a second. */
const TICK_MS = 1000;

export interface MonitorsHost {
  send<T extends 'transcript.image' | 'transcript.images'>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** A thumbnail's bytes as a bitmap (flipped, for a texture). */
  decode(blob: Blob): Promise<ImageBitmap>;
}

/** A seated worker of the floor, at its desk. */
export interface MonitorSeat {
  desk: number;
  view: WorkerView;
}

interface Load {
  desk: number;
  hash: string;
  gen: number;
  state: 'loading' | 'shown' | 'failed';
}

export interface MonitorDeskInfo {
  id: string;
  desk: number;
  mode: MonitorMode;
  /** What the card says (null: the terminal glance); the image's state for an image desk. */
  word: string | null;
  detail: string | null;
  badge: string | null;
  pose: string | null;
  timer: string | null;
  image: 'loading' | 'shown' | 'failed' | 'far' | null;
  aspect: number | null;
}

function reducedMotion(): MediaQueryList | null {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
  } catch {
    return null;
  }
}

export class Monitors {
  readonly planner = new WatchPlanner(IMAGE_CFG);
  private cards: MonitorCards | null = null;
  private readonly modes = new Map<string, MonitorMode>();
  /** Desk → the worker whose card it shows. */
  private readonly at = new Map<number, string>();
  private readonly faces = new Map<number, CardFace>();
  private readonly loads = new Map<string, Load>();
  private gen = 0;
  private lastTick = -Infinity;
  private readonly motionQuery = reducedMotion();
  /** Image fetches made (test hook). */
  fetches = 0;

  constructor(
    private readonly host: MonitorsHost,
    readonly prefs: MonitorPrefs,
  ) {
    this.motionQuery?.addEventListener?.('change', () => this.cards?.setMotion(!this.motionQuery?.matches));
  }

  /** The floor you are on changed (null: none): the old cards and images go. */
  setCards(cards: MonitorCards | null): void {
    if (cards === this.cards) return;
    this.clearLoads();
    this.cards?.dispose();
    this.cards = cards;
    this.modes.clear();
    this.at.clear();
    this.faces.clear();
    this.planner.clear();
    cards?.setMotion(!this.motionQuery?.matches);
  }

  /** Asleep: every monitor dark. */
  setVisible(on: boolean): void {
    this.cards?.setVisible(on);
  }

  /** A worker's monitor shows a card, a resting mascot or an image: its terminal is not watched for the glance. */
  covers(id: string): boolean {
    const m = this.modes.get(id);
    return m !== undefined && m !== 'glance';
  }

  /**
   * Once per plan. `seats`: the floor's seated workers; `cands`: the laptops' candidates (distance, in view), for which
   * images are near; `skip`: desks with no card (the one you sit at, a desk someone packs up at); `enabled` false (an
   * asleep floor) shows none; `online` false fetches nothing. `wall` is unix ms, for the counters.
   */
  plan(now: number, wall: number, seats: readonly MonitorSeat[], cands: readonly Candidate[], skip: ReadonlySet<number>, enabled: boolean, online: boolean): void {
    const cards = this.cards;
    if (!cards) return;
    const pref = this.prefs.monitors;
    const seen = new Set<number>();
    const imaging = new Map<string, { desk: number; hash: string; caption: string }>();
    this.modes.clear();
    for (const { desk, view } of seats) {
      const id = view.worker.id;
      seen.add(desk);
      const mode: MonitorMode = enabled && !skip.has(desk) ? monitorMode(view, pref) : 'glance';
      this.modes.set(id, mode);
      if (mode === 'glance') {
        this.setFace(desk, null, id, wall);
        continue;
      }
      if (mode === 'image') {
        const a = activityOf(view.worker);
        if (a?.image) imaging.set(id, { desk, hash: a.image.hash, caption: basename(a.detail) || 'Image' });
      }
      this.setFace(desk, cardFace(mode, view, view.since), id, wall);
    }
    for (const d of [...this.at.keys()]) if (!seen.has(d)) this.setFace(d, null, '', wall);
    // Images: only the desks near you and in view are fetched.
    this.planner.plan(
      now,
      cands.filter((c) => imaging.has(c.id)),
      online ? IMAGE_CFG.live : 0,
    );
    const near = new Set(this.planner.live);
    for (const [id, l] of [...this.loads]) {
      const want = imaging.get(id);
      if (!want || !near.has(id) || want.hash !== l.hash || want.desk !== l.desk) this.drop(id);
    }
    for (const id of near) {
      const want = imaging.get(id);
      if (want && !this.loads.has(id)) this.load(id, want.desk, want.hash, want.caption);
    }
  }

  private setFace(desk: number, face: CardFace | null, id: string, wall: number): void {
    const cards = this.cards;
    if (!cards) return;
    if (!face) {
      if (!this.at.has(desk)) return;
      this.at.delete(desk);
      this.faces.delete(desk);
      cards.set(desk, null, 0, wall);
      return;
    }
    this.at.set(desk, id);
    this.faces.set(desk, face);
    // Each desk's mascot a little out of step with its neighbours'.
    cards.set(desk, face, ((hash32(id) >>> 4) % 1000) / (1000 / FRAMES), wall);
  }

  private load(id: string, desk: number, hash: string, caption: string): void {
    const cards = this.cards;
    if (!cards) return;
    const l: Load = { desk, hash, gen: ++this.gen, state: 'loading' };
    this.loads.set(id, l);
    this.fetches++;
    const feed = new ImageFeed(id, { send: (t, args) => this.host.send(t, args) });
    feed.admit(hash);
    const stale = () => this.loads.get(id) !== l || this.cards !== cards;
    void feed
      .thumb(hash)
      .then(async (d) => {
        if (!d) throw new Error('no thumbnail');
        const bmp = await this.host.decode(d.blob);
        if (stale()) {
          bmp.close();
          return;
        }
        cards.setImage(desk, hash, bmp, caption);
        l.state = 'shown';
      })
      .catch(() => {
        // The card says "Looking at an image" instead: never a broken texture.
        if (!stale()) l.state = 'failed';
      })
      .finally(() => feed.dispose());
  }

  private drop(id: string): void {
    const l = this.loads.get(id);
    if (!l) return;
    this.loads.delete(id);
    this.cards?.clearImage(l.desk);
  }

  private clearLoads(): void {
    for (const id of [...this.loads.keys()]) this.drop(id);
  }

  /** Once per frame: the mascots' clock; the counters once a second. */
  frame(now: number, wall: number): void {
    const cards = this.cards;
    if (!cards) return;
    cards.frame(now);
    if (now - this.lastTick < TICK_MS) return;
    this.lastTick = now;
    cards.tick(wall);
  }

  /** The connection dropped: images are fetched again once it is back. */
  lost(): void {
    this.clearLoads();
    this.planner.clear();
  }

  // --- test hooks ---

  info(): MonitorDeskInfo[] {
    const cards = this.cards;
    if (!cards) return [];
    const out: MonitorDeskInfo[] = [];
    const byId = new Map([...this.at].map(([d, id]) => [id, d]));
    for (const [id, mode] of this.modes) {
      const desk = byId.get(id);
      const f = desk === undefined ? undefined : this.faces.get(desk);
      const l = this.loads.get(id);
      const img = desk === undefined ? null : cards.imageOf(desk);
      out.push({
        id,
        desk: desk ?? -1,
        mode,
        word: f?.word ?? null,
        detail: f ? f.detail : null,
        badge: f?.badge ?? null,
        pose: f?.pose ?? null,
        timer: desk === undefined ? null : cards.timerText(desk),
        image: mode !== 'image' ? null : l ? l.state : 'far',
        aspect: img?.aspect ?? null,
      });
    }
    return out.sort((a, b) => a.desk - b.desk);
  }

  stats(): { ledger: MonitorCards['ledger']; alive: number; textures: ReturnType<MonitorCards['textureVersions']>; motion: boolean; fetches: number; images: number[]; meshes: number } | null {
    const c = this.cards;
    return c ? { ledger: { ...c.ledger }, alive: c.texturesAlive, textures: c.textureVersions(), motion: c.motion, fetches: this.fetches, images: c.imageDesks(), meshes: c.drawn() } : null;
  }
}
