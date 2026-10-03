import { describe, expect, it } from 'vitest';
import { DigestBook, digestFailureText, digestStateOf } from './digestSettings';

describe('the floor overview summaries’ state (#118)', () => {
  it('reads a well-formed state strictly, dropping what it does not know', () => {
    expect(digestStateOf({ enabled: true, state: 'ready', roles: { llm: 'ready' }, env: ['enabled', 3], tested: true, daily_cap: 300.7, calls_today: 12, extra: 1 })).toEqual({
      enabled: true, state: 'ready', roles: { llm: 'ready' }, env: ['enabled'], tested: true, daily_cap: 300, calls_today: 12,
    });
    expect(digestStateOf({ enabled: false, state: 'off', roles: { llm: 'weird' }, daily_cap: 300, missing: ['llm', 'x'] })).toMatchObject({ roles: { llm: 'off' }, missing: ['llm'], calls_today: 0, tested: false });
    for (const bad of [null, [], { enabled: 'yes', state: 'off', daily_cap: 1 }, { enabled: true, state: 'capped', daily_cap: 1 }, { enabled: true, state: 'ready' }]) {
      expect(digestStateOf(bad)).toBeNull();
    }
  });

  it('the book: a snapshot without it is unknown; an update replaces it and tells', () => {
    const b = new DigestBook();
    let n = 0;
    b.onChange(() => n++);
    b.reset(undefined);
    expect(b.known).toBe(false);
    expect(b.upsert({ t: 'digest.update', seq: 3, enabled: true, state: 'ready', roles: { llm: 'ready' }, env: [], tested: true, daily_cap: 5, calls_today: 1 })).toBe(true);
    expect(b.known).toBe(true);
    expect(b.state?.daily_cap).toBe(5);
    expect(b.upsert({ junk: true })).toBe(false);
    expect(n).toBe(2);
  });

  it('plain words for its failures', () => {
    expect(digestFailureText('test_required', 'x')).toContain('Run the test first');
    expect(digestFailureText('env_locked', 'x')).toContain('HERDR_WORLD_DIGEST_ENABLED');
    expect(digestFailureText('incomplete', 'x')).toContain('LLM must be ready');
    expect(digestFailureText('unsupported', 'x')).toContain('no floor overview summaries');
    expect(digestFailureText('timeout', 'x')).toContain('Try again');
  });
});
