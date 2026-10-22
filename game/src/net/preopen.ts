import type { SocketFactory, SocketLike } from './client';

/**
 * #146: the bridge's socket, opened while the renderer starts and the game is built, before the client exists. It says
 * hello as soon as it opens, so the bridge's welcome and snapshot (on the real path: the helper's tunnel dial, the
 * upgrade, then hello → welcome → snapshot, ~3 round trips) arrive while the rest of the start-up runs.
 *
 * Until the client takes it, what the socket gets (its opening, every message in order, an error, its close) is kept;
 * the client's handlers get all of it in a microtask after `take`, once `connect` has set all four. The first connect's
 * hello is the one sent here: the client's own (the same text, sent on the replayed open) is dropped, once, so the
 * bridge sees exactly one. A socket that failed or closed before the client took it is replayed as such: the client
 * treats it like any failed connect (reconnect with backoff).
 */
export class Preopened {
  private readonly sock: SocketLike;
  private readonly kept: Array<() => void> = [];
  /** Taken by the client (or discarded): no second take. */
  private done = false;
  /** The client's handlers get events directly (the kept ones are replayed). */
  private live = false;
  /** The client's first send, when it is the hello sent here, is dropped once. */
  private dropHello = true;
  private readonly view: SocketLike;

  constructor(
    readonly url: string,
    open: SocketFactory,
    private readonly hello: string,
  ) {
    const view: SocketLike = {
      send: (data) => {
        if (this.dropHello) {
          this.dropHello = false;
          if (data === this.hello) return;
        }
        this.sock.send(data);
      },
      close: (code, reason) => {
        this.kept.length = 0;
        this.sock.close(code, reason);
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    this.view = view;
    this.sock = open(url);
    this.sock.onopen = (ev) => {
      this.sock.send(this.hello);
      this.deliver(() => view.onopen?.(ev));
    };
    this.sock.onmessage = (ev) => this.deliver(() => view.onmessage?.(ev));
    this.sock.onerror = (ev) => this.deliver(() => view.onerror?.(ev));
    this.sock.onclose = (ev) => this.deliver(() => view.onclose?.(ev));
  }

  /**
   * The client's first socket, when it asks for this URL: the socket (its handlers get what came so far in a microtask).
   * Any other URL closes it and returns null (the client opens its own). Only once.
   */
  take(url: string): SocketLike | null {
    if (this.done) return null;
    this.done = true;
    if (url !== this.url) {
      this.discard();
      return null;
    }
    queueMicrotask(() => {
      while (this.kept.length) this.kept.shift()?.();
      this.live = true;
    });
    return this.view;
  }

  /** Nothing took it (start-up failed, or another URL): closes it. A no-op once taken. */
  close(): void {
    if (this.done) return;
    this.done = true;
    this.discard();
  }

  private discard(): void {
    this.kept.length = 0;
    this.sock.onopen = this.sock.onmessage = this.sock.onerror = this.sock.onclose = null;
    this.sock.close(1000, 'not used');
  }

  private deliver(fn: () => void): void {
    if (this.live) fn();
    else this.kept.push(fn);
  }
}

/**
 * The client's socket factory: the pre-opened socket for its first connect (when the URL is the same), a new socket for
 * every other one (reconnects, a second URL). The pre-opened socket is offered once, whatever the answer.
 */
export function firstPreopened(pre: Preopened | null, open: SocketFactory): SocketFactory {
  let first = pre;
  return (url) => {
    const p = first;
    first = null;
    return p?.take(url) ?? open(url);
  };
}
