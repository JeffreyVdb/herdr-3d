/**
 * #57: the bridges the helper knows, and which one the game talks to. The helper owns the list (its `/api/bridges`,
 * docs/protocol.md "Through h3d-helper"): it keeps one supervised connection per bridge and proxies the game's `/ws`
 * (and every other bridge route) to the one in use. Switching is `activate`, then a reload: the same-origin `/ws` then
 * reaches the new bridge.
 *
 * A page the helper does not serve (Vite on the server, the e2e preview, a fixture page) has no token and no such
 * endpoint: `loadBridges` answers null and nothing here shows. The helper answers from what it last saw: a request never
 * waits on an ssh handshake.
 */

/** The helper token's header on its `/api/` routes (never a URL: it would land in logs). */
const OPEN_TOKEN_HEADER = 'x-h3d-token';

export type BridgeKind = 'ssh' | 'local';

/** What a bridge's connection is doing now (the helper's tunnel states; `down` is a local socket that does not answer). */
export type BridgeState = 'up' | 'connecting' | 'degraded' | 'backoff' | 'stopped' | 'down';

export interface BridgeEntry {
  id: string;
  name: string;
  kind: BridgeKind;
  host?: string;
  remote_socket?: string;
  socket?: string;
  /** How it is reached, for the list: `user@host`, `user@host:/socket` or the local socket's path. */
  address: string;
  /** The one the game talks to. */
  active: boolean;
  state: BridgeState | string;
  since?: string;
  last_error?: string;
  /** Its build version (empty until it answered once). */
  version?: string;
}

export interface BridgeList {
  /** The id in use ('' with no bridge). */
  active: string;
  bridges: BridgeEntry[];
}

/** What an add or an edit sends. */
export interface BridgeFields {
  name: string;
  kind: BridgeKind;
  host?: string;
  remote_socket?: string;
  socket?: string;
}

export type BridgeResult = { ok: true; list: BridgeList } | { ok: false; status: number; message: string };

type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const isOnline = (b: Pick<BridgeEntry, 'state'>): boolean => b.state === 'up';

/** The list as the helper sent it, or null for anything else (not a helper, an older one, HTML from Vite). */
export function parseBridgeList(body: unknown): BridgeList | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as { active?: unknown; bridges?: unknown };
  if (typeof o.active !== 'string' || !Array.isArray(o.bridges)) return null;
  const bridges: BridgeEntry[] = [];
  for (const b of o.bridges as unknown[]) {
    const e = b as Partial<BridgeEntry> | null;
    if (!e || typeof e.id !== 'string' || typeof e.name !== 'string' || (e.kind !== 'ssh' && e.kind !== 'local') || typeof e.state !== 'string') return null;
    bridges.push({ ...(e as BridgeEntry), address: typeof e.address === 'string' ? e.address : '', active: e.id === o.active });
  }
  return { active: o.active, bridges };
}

/** The helper's message for a refusal, else a sentence for the status. */
async function failure(r: { status: number; json(): Promise<unknown> }): Promise<{ ok: false; status: number; message: string }> {
  let message = '';
  try {
    const b = (await r.json()) as { message?: unknown } | null;
    if (typeof b?.message === 'string') message = b.message;
  } catch {
    // not JSON: the status says it
  }
  if (!message) message = r.status === 403 ? 'The helper refused the request: reload the game from the helper’s address.' : `The helper answered ${r.status}.`;
  return { ok: false, status: r.status, message };
}

export class BridgeApi {
  private readonly doFetch: FetchLike;

  constructor(
    private readonly token: string,
    fetchFn?: FetchLike,
  ) {
    this.doFetch = fetchFn ?? ((u, init) => fetch(u, init));
  }

  /** The list, or null when the page is not served by a helper that has one (or it did not answer within `ms`). */
  async load(ms = 2500): Promise<BridgeList | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await this.doFetch('/api/bridges', { headers: { [OPEN_TOKEN_HEADER]: this.token }, cache: 'no-store', signal: ctl.signal });
      if (!r.ok) return null;
      return parseBridgeList(await r.json());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  add(f: BridgeFields): Promise<BridgeResult> {
    return this.change('POST', '/api/bridges', f);
  }

  update(id: string, f: BridgeFields): Promise<BridgeResult> {
    return this.change('PUT', `/api/bridges/${encodeURIComponent(id)}`, f);
  }

  remove(id: string): Promise<BridgeResult> {
    return this.change('DELETE', `/api/bridges/${encodeURIComponent(id)}`);
  }

  activate(id: string): Promise<BridgeResult> {
    return this.change('POST', `/api/bridges/${encodeURIComponent(id)}/activate`);
  }

  private async change(method: string, url: string, body?: BridgeFields): Promise<BridgeResult> {
    const headers: Record<string, string> = { [OPEN_TOKEN_HEADER]: this.token };
    if (body) headers['content-type'] = 'application/json';
    try {
      const r = await this.doFetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!r.ok) return await failure(r);
      const list = parseBridgeList(await r.json());
      return list ? { ok: true, list } : { ok: false, status: r.status, message: 'The helper’s answer was not a bridge list.' };
    } catch {
      return { ok: false, status: 0, message: 'The helper did not answer. Is it still running?' };
    }
  }
}

/**
 * The game's copy of the list: what the helper last said, read again every `pollMs` while something watches (the
 * palette's bridge list, Settings → Bridges), so their state dots follow the bridges. Null: no helper on this page.
 */
export class BridgeBook {
  list: BridgeList | null = null;
  private readonly listeners = new Set<() => void>();
  private watchers = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private loading: Promise<void> | null = null;

  constructor(
    readonly api: BridgeApi | null,
    private readonly pollMs = 2000,
  ) {}

  get available(): boolean {
    return this.api !== null && this.list !== null;
  }

  /** The bridge in use (null: none, or no helper). */
  get active(): BridgeEntry | null {
    return this.list?.bridges.find((b) => b.id === this.list?.active) ?? null;
  }

  set(list: BridgeList | null): void {
    this.list = list;
    for (const fn of this.listeners) fn();
  }

  /** Asks the helper again (one request at a time); a failed read keeps the last list. */
  refresh(): Promise<void> {
    if (!this.api) return Promise.resolve();
    this.loading ??= this.api
      .load()
      .then((l) => {
        if (l) this.set(l);
      })
      .finally(() => (this.loading = null));
    return this.loading;
  }

  /** Reads the list now and every `pollMs` until the returned stop (each watcher its own). */
  watch(): () => void {
    this.watchers++;
    void this.refresh();
    if (!this.timer && this.api) this.timer = setInterval(() => void this.refresh(), this.pollMs);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      if (--this.watchers === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/**
 * #57: a page keeps the bridge its per-bridge keys were chosen for (`bridgeScope()`, set once at start). When the helper
 * names another one in use (a switch made in another tab, or the first bridge added there), the drafts, seats and
 * overview state this page holds are the old bridge's: `moved` is called once, with the bridge now in use, and the page
 * starts over on it (a reload). The helper refuses this page's `/ws` meanwhile (`?bridge=`), so the new bridge's world
 * never shows under the old one's state.
 *
 * It hears of a switch from any list the book gets (Settings and the palette poll while open) and, since a tab in the
 * background polls nothing, from `connLost`: a switch elsewhere closes this page's connection, and its reconnects are
 * refused until it moves.
 */
export function followActiveBridge(book: BridgeBook, scope: () => string | null, moved: (to: BridgeEntry | null) => void): { connLost(): Promise<void> } {
  let done = false;
  const check = () => {
    const l = book.list;
    if (done || !book.api || !l || (l.active || null) === scope()) return;
    done = true;
    moved(book.active);
  };
  book.onChange(check);
  return { connLost: () => (book.api && !done ? book.refresh() : Promise.resolve()) };
}
