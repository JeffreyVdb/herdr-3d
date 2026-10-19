import { describe, expect, it } from 'vitest';
import { CodexServerSim } from './fixture-codex-server.ts';

class CmdError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function sim(available = true, unverified = false, direnv = false) {
  const sent: Array<Record<string, unknown>> = [];
  const s = new CodexServerSim({ emit: (send, m) => send(m), error: (code, message) => new CmdError(code, message) }, available, unverified, direnv);
  const run = (t: string, a: Record<string, unknown> = {}) => {
    let acked: unknown;
    s.handle(t, a, (m) => sent.push(m), (d) => (acked = d));
    return acked;
  };
  return { s, sent, run };
}

describe('the fixture’s shared Codex server switch (#155)', () => {
  it('is off by default, switches on with an update, and acks the switch', () => {
    const { s, sent, run } = sim();
    const world: Record<string, unknown> = {};
    s.decorate(world);
    expect(world.codex_server).toEqual({ enabled: false, available: true, allow_unverified: false });
    expect(run('codex_server.set', { enabled: true })).toEqual({ enabled: true, available: true, allow_unverified: false });
    expect(sent).toEqual([{ t: 'codex_server.update', enabled: true, available: true, allow_unverified: false }]);
    expect(run('codex_server.get')).toEqual({ enabled: true, available: true, allow_unverified: false });
  });

  it('refuses a missing enabled, and switching on without a run directory', () => {
    const { run } = sim(false);
    expect(() => run('codex_server.set', {})).toThrow(/enabled or allow_unverified is required/);
    try {
      run('codex_server.set', { enabled: true });
      throw new Error('accepted');
    } catch (e) {
      expect((e as CmdError).code).toBe('unsupported');
    }
    expect(run('codex_server.set', { enabled: false })).toEqual({ enabled: false, available: false, allow_unverified: false });
  });

  it('accepting the risk persists across enabled-only commands and removes the version fallback', () => {
    const { s, run } = sim(true, true);
    run('codex_server.set', { allow_unverified: true });
    run('codex_server.set', { enabled: true });
    expect(run('codex_server.get')).toMatchObject({ enabled: true, allow_unverified: true });
    expect(s.hire('codex')).toBeUndefined();
    run('codex_server.set', { allow_unverified: false });
    expect(s.hire('codex')?.mode).toBe('legacy');
  });

  it('#186: on an unverified Codex, a Codex hire with the switch on falls back; otherwise hires are untouched', () => {
    const { s, run } = sim(true, true);
    expect(s.hire('codex')).toBeUndefined();
    run('codex_server.set', { enabled: true });
    expect(s.hire('codex')).toMatchObject({ mode: 'legacy', note: expect.stringContaining('"codex-cli 0.999.0"') });
    expect(s.hire('claude')).toBeUndefined();
    const plain = sim();
    plain.run('codex_server.set', { enabled: true });
    expect(plain.s.hire('codex')).toBeUndefined();
  });

  it('#116: with direnv unselected, a Codex hire with the switch on falls back with the one-line reason, even when unverified Codex is allowed', () => {
    const { s, run } = sim(true, false, true);
    expect(s.hire('codex')).toBeUndefined();
    run('codex_server.set', { enabled: true, allow_unverified: true });
    expect(s.hire('codex')).toEqual({
      mode: 'legacy',
      note: 'shared Codex server: direnv is installed through mise but has no version selected for /home/u/repo; started the usual way',
    });
    expect(s.hire('claude')).toBeUndefined();
  });
});
