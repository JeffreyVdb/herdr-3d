import { describe, expect, it } from 'vitest';
import { bannerVersion, loadHelperVersion, summarize } from './version';

describe('bannerVersion', () => {
  it.each([
    ['herdr-world v0.2.0', 'v0.2.0'],
    ['herdr-world dev', 'dev'],
    ['herdr-world v0.2.0-3-gabc-dirty', 'v0.2.0-3-gabc-dirty'],
    ['h3d-fixture-server', null],
    ['herdr-world', null],
    ['', null],
    [undefined, null],
  ])('%j -> %j', (banner, want) => {
    expect(bannerVersion(banner)).toBe(want);
  });
});

describe('summarize', () => {
  it('lists the sides it knows and passes when they agree', () => {
    expect(summarize({ game: 'v1', helper: 'v1', bridge: 'v1' })).toEqual({
      text: 'game v1 · helper v1 · bridge v1',
      mismatch: false,
    });
  });

  it('flags any disagreement', () => {
    const s = summarize({ game: 'v2', helper: 'v2', bridge: 'v1' });
    expect(s.mismatch).toBe(true);
    expect(s.text).toBe('game v2 · helper v2 · bridge v1 · versions differ');
  });

  it('leaves out sides that are not there (fixtures, dev server) without flagging', () => {
    expect(summarize({ game: 'dev', helper: null, bridge: null })).toEqual({ text: 'game dev', mismatch: false });
  });

  it('does not count an "unknown" side, but still shows it', () => {
    const s = summarize({ game: 'v2', helper: 'v2', bridge: 'unknown' });
    expect(s.mismatch).toBe(false);
    expect(s.text).toContain('bridge unknown');
  });
});

describe('loadHelperVersion', () => {
  const reply = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

  it('reads version from the helper health JSON', async () => {
    expect(await loadHelperVersion(reply({ version: 'v1.2.3', tunnel: {} }))).toBe('v1.2.3');
  });

  it('is null without a version, on non-JSON, or when the request fails', async () => {
    expect(await loadHelperVersion(reply({ tunnel: {} }))).toBeNull();
    expect(await loadHelperVersion((async () => new Response('<html>')) as unknown as typeof fetch)).toBeNull();
    expect(
      await loadHelperVersion((async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch),
    ).toBeNull();
  });
});
