import { describe, expect, it } from 'vitest';
import { loadFixture } from './fixture-server';
import { SimWorld, type SimOptions } from './fixture-sim';

type Msg = Record<string, unknown>;
type Snap = {
  context: { floor: string; cwd: string | null; codex_profile: string | null; codex_profile_name: string };
  checkouts: Array<{ path: string }>;
  expected?: string[];
  providers: Record<'claude' | 'codex', { available: boolean; config: { state: string; stale: boolean }; check: { state: string }; servers: Array<{ name: string; status: string; status_scope: string; source: string }>; skills: { complete: boolean; items: Array<{ name: string; enabled: boolean | null }>; errors: unknown[] } }>;
};

/** The demo-m118 world on a fake clock; `cmd` answers one command (ack data, or the error), `advance` runs due timers. */
function rig(o: Partial<SimOptions> = {}) {
  const { snapshot } = loadFixture('demo-m118');
  let now = Date.parse('2026-10-23T12:00:00Z');
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const world = new SimWorld(snapshot as never, {
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(++id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => timers.delete(h as number),
    ...o,
  });
  const out: Msg[] = [];
  let n = 0;
  const send = (t: string, args: Msg = {}) => {
    const req = `r${++n}`;
    world.handle({ t, req_id: req, args }, (m) => out.push(m));
    return () => out.find((m) => m.req_id === req);
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
    }
    now = end;
  };
  const cmd = (t: string, args: Msg = {}) => {
    const r = send(t, args);
    advance(5_000);
    return r() as Msg & { data?: Snap; code?: string };
  };
  return { world, send, cmd, advance, out };
}

describe('the fixture bridge’s MCP & skills (tools/fixture-mcp.ts)', () => {
  it('answers mcp.inventory for the floor’s default checkout: both providers, servers, skills, the expected list', () => {
    const r = rig();
    const a = r.cmd('mcp.inventory', { floor: 'lab' });
    const s = a.data as Snap;
    expect(s.context).toMatchObject({ floor: 'lab', codex_profile: '', codex_profile_name: '' }); // no profiles on this bridge
    expect(s.context.cwd).toBe(s.checkouts[0]?.path);
    expect(s.expected).toEqual([]);
    expect(s.providers.claude.servers.map((x) => [x.name, x.status])).toEqual([
      ['github', 'not_checked'],
      ['linear', 'approval_required'],
      ['sentry', 'not_checked'],
      ['context7', 'not_checked'],
    ]);
    expect(s.providers.codex.servers.map((x) => x.name)).toEqual(['github', 'sentry']);
    expect(s.providers.claude.skills.complete).toBe(false);
    expect(s.providers.codex.skills.complete).toBe(true);
    expect(s.providers.codex.skills.items.find((x) => x.name === 'legacy-lint')?.enabled).toBe(false);
    expect(s.providers.codex.skills.errors).toHaveLength(1);
    // Never config, commands, args, env, headers or URLs.
    expect(JSON.stringify(s)).not.toMatch(/https?:|command|args|env|header|token/i);
  });

  it('reads user scope without project servers or skills; refuses an unknown checkout or profile', () => {
    const r = rig();
    const s = r.cmd('mcp.inventory', { floor: 'lab', cwd: null }).data as Snap;
    expect(s.context.cwd).toBeNull();
    expect(s.providers.claude.servers.map((x) => x.name)).not.toContain('linear');
    expect(r.cmd('mcp.inventory', { floor: 'lab', cwd: '/nowhere' }).code).toBe('bad_request');
    expect(r.cmd('mcp.inventory', { floor: 'lab', codex_profile: 'work' }).code).toBe('not_found'); // no profiles on this bridge
    expect(r.cmd('mcp.inventory', { floor: 'nope' }).code).toBe('unknown_session');
  });

  it('answers each Codex profile with its own servers', () => {
    const r = rig({ codexProfiles: 2 });
    const work = r.cmd('mcp.inventory', { floor: 'lab', codex_profile: 'work' }).data as Snap;
    expect(work.context).toMatchObject({ codex_profile: 'work', codex_profile_name: 'work' });
    expect(work.providers.codex.servers.map((x) => x.name)).toEqual(['github', 'jira']);
    expect((r.cmd('mcp.inventory', { floor: 'lab', codex_profile: 'spare' }).data as Snap).providers.codex.servers).toEqual([]);
  });

  it('checks a provider when asked: probe statuses, a connector found, the unapproved project server never started; later reads keep them', () => {
    const r = rig();
    const s = r.cmd('mcp.check', { floor: 'lab', harness: 'claude' }).data as Snap;
    expect(s.providers.claude.check.state).toBe('ok');
    expect(s.providers.claude.servers.map((x) => [x.name, x.status, x.status_scope])).toEqual([
      ['github', 'connected', 'probe'],
      ['linear', 'approval_required', 'config'],
      ['sentry', 'auth_required', 'probe'],
      ['context7', 'connected', 'probe'],
      ['Gmail', 'connected', 'probe'],
    ]);
    expect(s.providers.codex.check.state).toBe('none');
    const again = r.cmd('mcp.inventory', { floor: 'lab' }).data as Snap;
    expect(again.providers.claude.servers.find((x) => x.name === 'sentry')?.status).toBe('auth_required');
    expect(r.cmd('mcp.check', { floor: 'lab', harness: 'gemini' }).code).toBe('bad_request');
  });

  it('is scripted: stale, failed, pending, a missing CLI, slow replies per profile, a bridge without expected_mcp', () => {
    const r = rig({ codexProfiles: 2 });
    r.cmd('sim.mcp', { stale: 'codex', fail: 'claude' });
    let s = r.cmd('mcp.inventory', { floor: 'lab' }).data as Snap;
    expect(s.providers.codex.config.stale).toBe(true);
    expect(s.providers.claude.config.state).toBe('failed');
    expect(s.providers.claude.servers).toEqual([]);
    r.cmd('sim.mcp', { stale: null, fail: null, unavailable: 'codex', pending: 'claude', expected: false });
    s = r.cmd('mcp.inventory', { floor: 'lab' }).data as Snap;
    expect([s.providers.codex.available, s.providers.codex.config.state, s.providers.claude.config.state]).toEqual([false, 'unavailable', 'pending']);
    expect('expected' in s).toBe(false);
    r.cmd('sim.mcp', { delay: { codex_profile: 'work', ms: 3000 } });
    const slow = r.send('mcp.inventory', { floor: 'lab', codex_profile: 'work' });
    const fast = r.send('mcp.inventory', { floor: 'lab', codex_profile: 'spare' });
    expect(fast()).toBeDefined();
    expect(slow()).toBeUndefined();
    r.advance(3000);
    expect((slow()?.data as Snap).context.codex_profile).toBe('work');
    expect((r.cmd('sim.mcp_log').data as unknown as { commands: Msg[] }).commands.filter((c) => c.t === 'mcp.inventory').length).toBeGreaterThan(3);
  });

  it('stores the expected servers with the floor’s settings, as the bridge checks them, and says them in the Snapshot', () => {
    const r = rig();
    expect(r.cmd('floor.settings.set', { floor: 'lab', expected_mcp: ['github', 'notion'] }).t).toBe('ack');
    const up = r.out.filter((m) => m.t === 'floor.upsert').at(-1) as { floor: { settings?: { expected_mcp?: string[] } } };
    expect(up.floor.settings?.expected_mcp).toEqual(['github', 'notion']);
    expect((r.cmd('mcp.inventory', { floor: 'lab' }).data as Snap).expected).toEqual(['github', 'notion']);
    for (const bad of [[' x'], [''], ['a', 'a'], ['a'.repeat(101)], ['x\u0001'], Array.from({ length: 33 }, (_, i) => `s${i}`)]) expect(r.cmd('floor.settings.set', { floor: 'lab', expected_mcp: bad }).code, JSON.stringify(bad).slice(0, 40)).toBe('bad_request');
    expect(r.cmd('floor.settings.set', { floor: 'lab', expected_mcp: [] }).t).toBe('ack');
    expect((r.cmd('mcp.inventory', { floor: 'lab' }).data as Snap).expected).toEqual([]);
  });

  it('plays a bridge before it: unknown_command, and expected_mcp is an unknown key', () => {
    const r = rig({ fail: 'no_mcp' });
    expect(r.cmd('mcp.inventory', { floor: 'lab' }).code).toBe('unknown_command');
    expect(r.cmd('mcp.check', { floor: 'lab', harness: 'codex' }).code).toBe('unknown_command');
    expect(r.cmd('floor.settings.set', { floor: 'lab', expected_mcp: ['github'] }).code).toBe('bad_request');
  });
});
