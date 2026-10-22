import { helloFor, type SocketFactory } from './client';
import { bridgeUrl, type LocationLike } from './endpoint';
import { bridgeScope, migrateBridgeKeys, setBridgeScope } from './bridgeScope';
import type { BridgeBook, BridgeList } from './bridges';
import { firstPreopened, Preopened } from './preopen';

/** The name the game says hello with. */
export const GAME_CLIENT = 'herdr-3d-game/0.2';

/** #146: the first connect's hello (no resume point yet), as the client sends it. */
export const FIRST_HELLO = JSON.stringify(helloFor(GAME_CLIENT, { epoch: null, seq: null }));

/**
 * The bridge socket's URL, for the pre-opened socket and the game alike (#146: one helper, the same inputs). #57: the
 * helper lets this page through to the bridge its keys belong to only (`none`: it had none): its /ws and every HTTP
 * route (logos, uploads, frames, whiteboards, drops), whose URLs derive from this one.
 */
export function socketUrl(loc: LocationLike, token: string | null, book: Pick<BridgeBook, 'list'>): string {
  return bridgeUrl(loc, token, bridgeScope() ?? (book.list ? 'none' : null));
}

type ScopeStorage = Parameters<typeof migrateBridgeKeys>[0];

/** #57: the bridge in use when the helper last said (shared; only read when it does not answer at start). */
export const LAST_BRIDGE_KEY = 'h3d.bridges.active';

function rememberBridge(storage: ScopeStorage, id: string): void {
  try {
    storage?.setItem(LAST_BRIDGE_KEY, id);
  } catch {
    // not remembered
  }
}

function rememberedBridge(storage: ScopeStorage): string | null {
  try {
    return storage?.getItem(LAST_BRIDGE_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * #57: the helper's answer sets the bridge scope before anything reads the per-bridge keys. With no answer in time on
 * a page the helper serves (it has a token), the bridge it last named, so drafts never land in another bridge's keys.
 */
export function applyBridgeList(list: BridgeList | null, token: string | null, book: BridgeBook, storage: ScopeStorage): void {
  if (list) {
    // The keys kept before #57 belong to the first bridge (the one an install from before came up with).
    if (list.bridges[0]) migrateBridgeKeys(storage, list.bridges[0].id);
    setBridgeScope(list.active || null);
    rememberBridge(storage, list.active);
    book.set(list);
  } else if (token) {
    setBridgeScope(rememberedBridge(storage));
  }
}

export interface EarlyStart {
  /** The renderer's `init()`, already running. */
  init: Promise<unknown>;
  /** The helper's bridge list (null: no helper, or it did not answer in time). */
  list: Promise<BridgeList | null>;
  /** The canvas font. */
  fonts: Promise<unknown>;
  token: string | null;
  book: BridgeBook;
  storage: ScopeStorage;
  location: LocationLike;
  /** Opens the socket early (`new Preopened(url, …)` in the page). */
  preopen(url: string): Preopened;
}

/**
 * #146: the renderer's init, the helper's bridge list and the font, side by side; the bridge socket opens as soon as
 * its URL is known (the list settled the scope), so its handshake overlaps the rest of the start-up. Resolves with the
 * pre-opened socket once all three are done. When any of them fails, the socket is closed (or never opened, when the
 * list settles after the failure) and the error is passed on.
 */
export async function startEarly(o: EarlyStart): Promise<Preopened> {
  const at: { failed: boolean; pre: Preopened | null } = { failed: false, pre: null };
  const opened = o.list.then((list) => {
    if (at.failed) return;
    applyBridgeList(list, o.token, o.book, o.storage);
    at.pre = o.preopen(socketUrl(o.location, o.token, o.book));
  });
  try {
    await Promise.all([o.init, opened, o.fonts]);
  } catch (err) {
    at.failed = true;
    at.pre?.close();
    throw err;
  }
  return at.pre as Preopened;
}

/**
 * #146: builds the game with a socket factory that hands it the pre-opened socket for its first connect. When building
 * (or starting) it throws, nothing took the socket: it is closed.
 */
export function handOver<T>(pre: Preopened, open: SocketFactory, build: (socket: SocketFactory) => T): T {
  try {
    return build(firstPreopened(pre, open));
  } catch (err) {
    pre.close();
    throw err;
  }
}
