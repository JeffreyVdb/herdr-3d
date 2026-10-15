/**
 * #57: a page's HTTP routes (`/logo`, `/upload`, `/screen/frame`, `/whiteboard`, `/drops`) name its bridge, as its
 * `/ws` does, and the helper refuses them with 409 `bridge_changed` once another bridge is in use (a switch made in
 * another tab). The routes' readers report it here; the page then follows the switch (it asks the helper which bridge
 * is in use and starts over on it) instead of treating it as the request's own failure.
 */

export const BRIDGE_CHANGED = 'bridge_changed';

/** What a refused request says while the page moves. */
export const BRIDGE_CHANGED_MESSAGE = 'another bridge is in use now: the game reloads on it';

let follow: (() => void) | null = null;

/** The page's way to follow a switch (App's), or null. */
export function onBridgeChanged(fn: (() => void) | null): void {
  follow = fn;
}

/** A route answered `code` (with `message`): a `bridge_changed` sets the page moving and says so. */
export function routeRefusal(code: string, message: string): { code: string; message: string } {
  if (code !== BRIDGE_CHANGED) return { code, message };
  follow?.();
  return { code, message: BRIDGE_CHANGED_MESSAGE };
}
