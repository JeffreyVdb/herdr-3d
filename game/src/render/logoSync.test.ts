import { describe, expect, it } from 'vitest';
import { LogoSync } from './logoSync';
import { LogoCache, LogoStaleError, type DecodedLogo } from './logos';

const url = (b: string, h: string) => `http://x/logo/${b}?h=${h}`;

/** The actual cache and sync logic, with a loader whose answers the test controls one request at a time. */
function rig() {
  const requests: { url: string; hash: string; ok: (d: DecodedLogo) => void; stale: () => void; fail: () => void }[] = [];
  const cache = new LogoCache((u, hash) => new Promise<DecodedLogo>((ok, no) => requests.push({ url: u, hash, ok, stale: () => no(new LogoStaleError('logo 404')), fail: () => no(new Error('logo 500')) })));
  let want = new Map<string, string>();
  let misses = 0;
  const sync = new LogoSync(cache, url, (loaded) => {
    if (!loaded) misses++;
    resync();
  });
  const resync = () => {
    sync.update(want);
    sync.prune(want);
  };
  const advertise = (m: Record<string, string>) => {
    want = new Map(Object.entries(m));
    resync();
  };
  const png = (hash: string): DecodedLogo => ({ image: { close() {} } as never, width: 10, height: 10, hash });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { requests, cache, sync, advertise, png, settle, misses: () => misses };
}

describe('LogoSync', () => {
  it('shows the logo of the advertised hash once it has loaded, and asks once per hash', async () => {
    const r = rig();
    r.advertise({ A: 'H1' });
    r.advertise({ A: 'H1' });
    expect(r.requests).toHaveLength(1);
    r.requests[0]!.ok(r.png('H1'));
    await r.settle();
    expect(r.sync.shown.get('A')?.hash).toBe('H1');
    expect(r.requests).toHaveLength(1);
  });

  describe('H1 -> H2 -> H1 with the first H1 request still pending', () => {
    it('drops the stale answer of the superseded request and asks again (nothing loaded)', async () => {
      const r = rig();
      r.advertise({ A: 'H1' });
      r.advertise({ A: 'H2' });
      r.advertise({ A: 'H1' }); // restored: shares the pending request
      expect(r.requests.map((q) => q.hash)).toEqual(['H1', 'H2']);
      r.requests[0]!.stale(); // the bridge answered it while it still had H2
      await r.settle();
      expect(r.cache.isStale(url('A', 'H1'))).toBe(false);
      expect(r.requests.map((q) => q.hash)).toEqual(['H1', 'H2', 'H1']); // asked again, once
      r.requests[2]!.ok(r.png('H1'));
      await r.settle();
      expect(r.sync.shown.get('A')?.hash).toBe('H1');
      r.requests[1]!.ok(r.png('H2')); // H2's answer arrives late: nobody advertises it, so it is not shown
      await r.settle();
      expect(r.sync.shown.get('A')?.hash).toBe('H1');
      expect(r.requests).toHaveLength(3);
    });

    it('does the same when H2 has already loaded: H2 stays until H1 is there, then H1 shows', async () => {
      const r = rig();
      r.advertise({ A: 'H1' });
      r.advertise({ A: 'H2' });
      r.requests[1]!.ok(r.png('H2'));
      await r.settle();
      expect(r.sync.shown.get('A')?.hash).toBe('H2');
      r.advertise({ A: 'H1' });
      expect(r.sync.shown.get('A')?.hash).toBe('H2'); // no flash of the name
      r.requests[0]!.stale();
      await r.settle();
      expect(r.requests.map((q) => q.hash)).toEqual(['H1', 'H2', 'H1']);
      expect(r.sync.shown.get('A')?.hash).toBe('H2');
      r.requests[2]!.ok(r.png('H1'));
      await r.settle();
      expect(r.sync.shown.get('A')?.hash).toBe('H1');
    });

    it('drops a failure of the superseded request the same way', async () => {
      const r = rig();
      r.advertise({ A: 'H1' });
      r.advertise({ A: 'H2' });
      r.advertise({ A: 'H1' });
      r.requests[0]!.fail();
      await r.settle();
      expect(r.cache.hasFailed('H1')).toBe(false);
      expect(r.requests.map((q) => q.hash)).toEqual(['H1', 'H2', 'H1']);
      r.requests[2]!.ok(r.png('H1'));
      await r.settle();
      expect(r.sync.shown.get('A')?.hash).toBe('H1');
    });

    it('does not loop when the bridge really has another logo: the second stale answer sticks', async () => {
      const r = rig();
      r.advertise({ A: 'H1' });
      r.advertise({ A: 'H2' });
      r.advertise({ A: 'H1' });
      r.requests[0]!.stale();
      await r.settle();
      r.requests[2]!.stale(); // the asked-again request is stale too
      await r.settle();
      expect(r.cache.isStale(url('A', 'H1'))).toBe(true);
      r.advertise({ A: 'H1' });
      r.advertise({ A: 'H1' });
      await r.settle();
      expect(r.requests).toHaveLength(3);
      r.advertise({ A: 'H3' }); // its next upsert
      expect(r.requests.map((q) => q.hash)).toEqual(['H1', 'H2', 'H1', 'H3']);
    });
  });

  it('a stale answer after the restore is dropped even when the request was made by another building', async () => {
    const r = rig();
    r.advertise({ A: 'H1', B: 'H1' }); // B shares A's request
    r.advertise({ A: 'H2', B: 'H1' });
    r.advertise({ A: 'H1', B: 'H1' });
    expect(r.requests.map((q) => q.url)).toEqual([url('A', 'H1'), url('A', 'H2')]);
    r.requests[0]!.stale();
    await r.settle();
    // One new request serves both buildings.
    expect(r.requests.filter((q) => q.hash === 'H1')).toHaveLength(2);
    r.requests[2]!.ok(r.png('H1'));
    await r.settle();
    expect(r.sync.shown.get('A')?.hash).toBe('H1');
    expect(r.sync.shown.get('B')?.hash).toBe('H1');
  });

  it('A and B sharing H1 still work when A really is stale: B gets its own image (the hash names the bytes, so A shows it too), then A moves on', async () => {
    const r = rig();
    r.advertise({ A: 'H1', B: 'H1' });
    expect(r.requests).toHaveLength(1);
    r.requests[0]!.stale(); // A's URL: the bridge has H2 for A already
    await r.settle();
    expect(r.cache.isStale(url('A', 'H1'))).toBe(true);
    expect(r.requests.map((q) => q.url)).toEqual([url('A', 'H1'), url('B', 'H1')]); // B asked with its own URL
    r.requests[1]!.ok(r.png('H1'));
    await r.settle();
    expect(r.sync.shown.get('B')?.hash).toBe('H1');
    expect(r.sync.shown.get('A')?.hash).toBe('H1');
    r.advertise({ A: 'H2', B: 'H1' });
    expect(r.requests.at(-1)).toMatchObject({ url: url('A', 'H2') });
    r.requests.at(-1)!.ok(r.png('H2'));
    await r.settle();
    expect(r.sync.shown.get('A')?.hash).toBe('H2');
    expect(r.sync.shown.get('B')?.hash).toBe('H1');
    expect(r.requests).toHaveLength(3);
  });

  it('forgets a stale URL when the building goes to another hash and back, though another building keeps the hash current', async () => {
    const r = rig();
    r.advertise({ A: 'H1', B: 'H1' });
    r.requests[0]!.stale();
    await r.settle();
    r.requests[1]!.ok(r.png('H1'));
    await r.settle();
    expect(r.cache.isStale(url('A', 'H1'))).toBe(true); // B keeps H1 current, so keep() does not prune it
    r.advertise({ A: 'H2', B: 'H1' });
    r.advertise({ A: 'H1', B: 'H1' });
    expect(r.cache.isStale(url('A', 'H1'))).toBe(false);
    expect(r.sync.shown.get('A')?.hash).toBe('H1'); // H1 is cached: shown at once
  });
});
