import type { LogoCache, LogoEntry } from './logos';

/**
 * Follows the hashes the buildings advertise (building id -> logo hash): which
 * logo each building shows, and which ones to fetch. The App owns one and
 * feeds it after every structural change; it holds no views.
 *
 * A hash that changes (also back to one seen before: H1 -> H2 -> H1) is
 * announced to the cache, so nothing learnt while the building advertised
 * something else (a stale or failed answer, a request still on its way) can
 * hide the hash it advertises now.
 */
export class LogoSync {
  /** The logo each building shows now: the loaded one for its hash, else the previous one until that has loaded. */
  readonly shown = new Map<string, LogoEntry>();
  /** Building id -> the hash it advertised last ('' while it advertises none). A first advertisement is not a change. */
  private readonly advertised = new Map<string, string>();

  /**
   * @param urlOf the URL of a building's logo at a hash
   * @param settled called when a request has come back: sync again (`loaded` false: the logo could not be had)
   */
  constructor(
    private readonly cache: LogoCache,
    private readonly urlOf: (building: string, hash: string) => string,
    private readonly settled: (loaded: boolean) => void,
  ) {}

  /** Updates `shown` and starts the fetches that are due; then the caller moves its views and calls `prune`. */
  update(want: ReadonlyMap<string, string>): void {
    for (const id of this.advertised.keys()) if (!want.has(id)) this.advertised.set(id, '');
    for (const id of [...this.shown.keys()]) if (!want.has(id)) this.shown.delete(id);
    for (const [id, hash] of want) {
      const url = this.urlOf(id, hash);
      const before = this.advertised.get(id);
      if (before !== hash) {
        this.advertised.set(id, hash);
        if (before !== undefined) this.cache.advertised(url, hash);
      }
      const e = this.cache.peek(hash);
      if (e) this.shown.set(id, e);
      else if (this.cache.hasFailed(hash)) this.shown.delete(id);
      else if (this.cache.isStale(url)) {
        // The bridge has another logo for this building already: its building.upsert (new hash) is on its way, and syncs again.
      } else {
        // Coming in: the old logo (if any) stays until it has, so a change does not flash the name.
        void this.cache.load(hash, url).then((loaded) => this.settled(loaded !== null));
      }
    }
  }

  /** Lets the cache drop the textures no view shows and the marks of hashes no building has. */
  prune(want: ReadonlyMap<string, string>): void {
    this.cache.keep([...this.shown.values()].map((e) => e.hash), want.values());
  }
}
