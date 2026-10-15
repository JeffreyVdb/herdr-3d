import { describe, expect, it, vi } from 'vitest';
import { BridgeApi, BridgeBook, followActiveBridge, type BridgeEntry, type BridgeList } from './bridges';

// #57: a page keeps the bridge its per-bridge keys were chosen for. Another tab switching (or adding the first bridge)
// must make it start over on the new one, whether it hears of it from the list it polls or when its connection drops.

const entry = (id: string, name: string): BridgeEntry => ({ id, name, kind: 'ssh', host: `dev@${id}`, address: `dev@${id}`, active: false, state: 'up' });
const A = entry('aaaaaaaaaa', 'devbox');
const B = entry('bbbbbbbbbb', 'Laptop');
const list = (active: string, ...bridges: BridgeEntry[]): BridgeList => ({ active, bridges: bridges.map((b) => ({ ...b, active: b.id === active })) });

function setup(start: BridgeList | null, scope: string | null) {
  let current = start;
  const fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(current) }));
  const book = new BridgeBook(new BridgeApi('t0k', fetch), 60_000);
  if (start) book.set(start);
  const moved = vi.fn<(to: BridgeEntry | null) => void>();
  const follow = followActiveBridge(book, () => scope, moved);
  return { book, fetch, moved, follow, helperSays: (l: BridgeList) => (current = l) };
}

describe('followActiveBridge', () => {
  it('a list that names another bridge in use: the page moves to it, once', async () => {
    const { book, moved } = setup(list(A.id, A, B), A.id);
    book.set(list(A.id, A, B));
    expect(moved).not.toHaveBeenCalled();
    book.set(list(B.id, A, B));
    expect(moved).toHaveBeenCalledTimes(1);
    expect(moved.mock.calls[0]?.[0]?.name).toBe('Laptop');
    book.set(list(A.id, A, B));
    book.set(list(B.id, A, B));
    expect(moved).toHaveBeenCalledTimes(1);
  });

  it('a dropped connection asks the helper which bridge is in use (no poll runs in a background tab)', async () => {
    const { fetch, moved, follow, helperSays } = setup(list(A.id, A, B), A.id);
    helperSays(list(B.id, A, B));
    expect(fetch).not.toHaveBeenCalled();
    await follow.connLost();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(moved).toHaveBeenCalledWith(expect.objectContaining({ id: B.id }));
  });

  it('the same bridge after a drop (a bridge restart, an edited address): the page stays', async () => {
    const { moved, follow } = setup(list(A.id, A, B), A.id);
    await follow.connLost();
    expect(moved).not.toHaveBeenCalled();
  });

  it('a helper with no bridge: nothing to follow until one is added elsewhere', async () => {
    const { book, moved } = setup(list(''), null);
    book.set(list(''));
    expect(moved).not.toHaveBeenCalled();
    book.set(list(A.id, A));
    expect(moved).toHaveBeenCalledWith(expect.objectContaining({ id: A.id }));
  });

  it('a page whose scope came from memory (the helper was slow at start) is checked once the helper answers', async () => {
    const { moved, follow, helperSays } = setup(null, A.id);
    helperSays(list(B.id, A, B));
    await follow.connLost();
    expect(moved).toHaveBeenCalledWith(expect.objectContaining({ id: B.id }));
  });

  it('a page no helper serves follows nothing', async () => {
    const book = new BridgeBook(null);
    const moved = vi.fn();
    await followActiveBridge(book, () => null, moved).connLost();
    expect(moved).not.toHaveBeenCalled();
  });
});
