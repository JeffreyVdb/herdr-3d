import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { McpHarness, McpProvider, McpRequest, McpSnapshot } from '../net/protocol';
import { MCP_POLL_MS, type McpWallModel } from '../world/mcp';
import { McpLink, type McpOffice } from './link';

const T0 = Date.parse('2026-10-23T12:00:00Z');

const provider = (n: number): McpProvider => ({
  available: true,
  version: '1',
  reason: '',
  config: { state: 'ok', read_at: new Date(T0).toISOString(), stale: false, note: '' },
  check: { state: 'none', at: null, note: '' },
  servers: Array.from({ length: n }, (_, i) => ({ name: `s${i}`, source: 'user', plugin: '', transport: 'stdio', enabled: true, approval: 'n/a', status: 'not_checked', status_scope: 'config', status_at: null, reason: '' })),
  skills: { state: 'ok', read_at: new Date(T0).toISOString(), stale: false, complete: true, note: '', items: [], errors: [] },
});

const snap = (a: McpRequest, n = 1): McpSnapshot => ({
  context: { floor: a.floor, cwd: a.cwd === undefined ? '/repo' : a.cwd, cwd_display: a.cwd === undefined ? '~/repo' : (a.cwd ?? ''), codex_profile: a.codex_profile ?? 'codex', codex_profile_name: a.codex_profile ?? 'codex', claude_config: '~/.claude' },
  checkouts: [],
  expected: [],
  generated_at: new Date(T0).toISOString(),
  providers: { claude: provider(n), codex: provider(n) },
});

/** A Snapshot after a Claude check at `at` (bridge time) that found its servers needing sign-in; `expected` as given. */
const checked = (a: McpRequest, at: number, o: { n?: number; state?: string; expected?: string[]; gen?: number } = {}): McpSnapshot => {
  const s = snap(a, o.n ?? 1);
  const p = s.providers.claude;
  const when = new Date(at).toISOString();
  p.check = { state: o.state ?? 'ok', at: when, note: '' };
  p.servers = p.servers.map((x) => ({ ...x, status: 'auth_required', status_scope: 'probe', status_at: when, reason: 'Authentication required' }));
  return { ...s, expected: o.expected ?? [], generated_at: new Date(o.gen ?? at).toISOString() };
};

/** A request the rig holds until the test answers it. */
interface Held {
  t: 'mcp.inventory' | 'mcp.check';
  args: McpRequest & { harness?: McpHarness };
  timeout: number;
  answer(r: CommandResult): Promise<void>;
}

function rig() {
  let now = 1000;
  let inView = false;
  let unsupported = false;
  const held: Held[] = [];
  const hud: string[] = [];
  const screens: McpWallModel[] = [];
  let changes = 0;
  const mkOffice = (id: string): McpOffice => ({ id, tickMcp: () => inView, setMcpScreen: (m) => void screens.push(m) });
  const link = new McpLink({
    request: (t, args, timeout) =>
      new Promise<CommandResult>((resolve) => {
        held.push({
          t,
          args,
          timeout,
          answer: async (r) => {
            resolve(r);
            await Promise.resolve();
            await Promise.resolve();
          },
        });
      }),
    hudInfo: (l) => void hud.push(l),
    unsupported: () => unsupported,
    markUnsupported: () => void (unsupported = true),
    now: () => now,
    clock: () => T0 + now,
    changed: () => void changes++,
  });
  let office: McpOffice | null = mkOffice('lab');
  const camera = {} as never;
  type S = Partial<{ here: boolean; live: boolean; connected: boolean; page: string | null }>;
  const step = (o: S = {}) => link.step({ office, here: true, live: true, connected: true, page: null, camera, ...o });
  return {
    link,
    held,
    hud,
    screens,
    changes: () => changes,
    look: (v: boolean) => void (inView = v),
    advance: (ms: number, o: S = {}) => {
      now += ms;
      step(o);
    },
    step,
    office: (id: string | null) => void (office = id === null ? null : mkOffice(id)),
    sent: () => held.map((h) => `${h.t} ${JSON.stringify(h.args)}`),
  };
}

describe('McpLink: when it asks', () => {
  it('asks only after 300 ms of looking at the wall, then every 20 s while you look, and stops when you look away', () => {
    const r = rig();
    r.step();
    r.advance(10_000);
    expect(r.held).toEqual([]); // never looked: never asked
    r.look(true);
    r.advance(100); // the gate's clock starts here
    r.advance(250);
    expect(r.held).toEqual([]);
    r.advance(60);
    expect(r.sent()).toEqual(['mcp.inventory {"floor":"lab"}']);
    expect(r.held[0]?.timeout).toBeGreaterThan(20_000);
    // One at a time: while it is out, nothing else goes.
    r.advance(MCP_POLL_MS + 1);
    expect(r.held).toHaveLength(1);
    void r.held[0]?.answer({ ok: true, data: snap({ floor: 'lab' }) });
  });

  it('polls every 20 s while wanted, and not at all once you look away (after a 3 s grace)', async () => {
    const r = rig();
    r.look(true);
    r.step();
    r.advance(300);
    await r.held[0]?.answer({ ok: true, data: snap({ floor: 'lab' }) });
    r.advance(MCP_POLL_MS - 400);
    expect(r.held).toHaveLength(1);
    r.advance(500);
    expect(r.held).toHaveLength(2);
    await r.held[1]?.answer({ ok: true, data: snap({ floor: 'lab' }) });
    r.look(false);
    r.advance(1000);
    expect(r.link.info().wanted).toBe(true); // the grace
    r.advance(3000);
    expect(r.link.info().wanted).toBe(false);
    r.advance(MCP_POLL_MS * 3);
    expect(r.held).toHaveLength(2);
  });

  it('asks while the overview page is open, wherever you look; not with the tab hidden, the bridge gone, off a floor, or on an old bridge', async () => {
    const r = rig();
    r.step({ page: 'lab' });
    expect(r.held).toHaveLength(1); // the page wants it at once
    await r.held[0]?.answer({ ok: true, data: snap({ floor: 'lab' }) });
    r.advance(MCP_POLL_MS + 1, { page: 'lab', live: false });
    expect(r.held).toHaveLength(1);
    r.advance(1, { page: 'lab', live: false, connected: false });
    expect(r.held).toHaveLength(1);
    r.look(true);
    r.advance(MCP_POLL_MS + 1, { here: false });
    expect(r.held).toHaveLength(1);
    r.office(null);
    r.advance(MCP_POLL_MS + 1);
    expect(r.held).toHaveLength(1);
    // Back: asked again; an old bridge answers unknown_command and is never asked again.
    r.office('lab');
    r.advance(1, { page: 'lab' });
    expect(r.held).toHaveLength(2);
    await r.held[1]?.answer({ ok: false, code: 'unknown_command', message: 'unknown command: "mcp.inventory"' });
    expect(r.link.info().mode).toBe('unsupported');
    r.advance(MCP_POLL_MS * 2, { page: 'lab' });
    r.link.refresh();
    r.link.check('claude');
    expect(r.held).toHaveLength(2);
    r.advance(1, { page: 'lab' });
    expect(r.screens.at(-1)?.scope).toBe('No MCP inventory on this bridge');
    expect(r.hud.at(-1)).toBe('No MCP inventory on this bridge');
  });

  it('never sends mcp.check by itself: only the page’s button, once per provider and context at a time', async () => {
    const r = rig();
    r.step({ page: 'lab' });
    for (let i = 0; i < 10; i++) r.advance(MCP_POLL_MS, { page: 'lab' });
    expect(r.held.every((h) => h.t === 'mcp.inventory')).toBe(true);
    const before = r.held.length;
    r.link.check('codex');
    r.link.check('codex');
    expect(r.held.slice(before).map((h) => [h.t, h.args.harness])).toEqual([['mcp.check', 'codex']]);
    expect(r.held.at(-1)?.timeout).toBeGreaterThan(20_000);
    expect(r.link.view('lab').checking).toEqual({ claude: false, codex: true });
    await r.held.at(-1)?.answer({ ok: true, data: snap({ floor: 'lab' }, 3) });
    expect(r.link.view('lab').checking.codex).toBe(false);
    expect(r.link.view('lab').received?.snap.providers.codex.servers).toHaveLength(3);
  });
});

describe('McpLink: contexts (AC6)', () => {
  it('drops a late reply for the Codex profile you switched away from, and shows the new one', async () => {
    const r = rig();
    r.step({ page: 'lab' });
    await r.held[0]?.answer({ ok: true, data: snap({ floor: 'lab' }) });
    r.link.choose('lab', { codex_profile: 'work' });
    r.step({ page: 'lab' });
    const slow = r.held[1];
    expect(slow?.args).toEqual({ floor: 'lab', codex_profile: 'work' });
    // The page shows "reading" for work, never the default profile's data.
    expect(r.link.view('lab').received).toBeNull();
    expect(r.link.view('lab').asking).toBe(true);
    r.link.choose('lab', { codex_profile: 'spare' });
    r.step({ page: 'lab' });
    const fast = r.held[2];
    expect(fast?.args).toEqual({ floor: 'lab', codex_profile: 'spare' });
    await fast?.answer({ ok: true, data: snap({ floor: 'lab', codex_profile: 'spare' }, 2) });
    expect(r.link.info().context?.codex_profile).toBe('spare');
    // work's reply comes late: dropped, the page and the wall stay on spare.
    await slow?.answer({ ok: true, data: snap({ floor: 'lab', codex_profile: 'work' }, 9) });
    expect(r.link.log.map((e) => [e.args.codex_profile ?? 'default', e.result])).toEqual([
      ['default', 'ok'],
      ['work', 'dropped'],
      ['spare', 'ok'],
    ]);
    expect(r.link.view('lab').received?.snap.context.codex_profile).toBe('spare');
    r.step({ page: 'lab' });
    expect(r.screens.at(-1)?.scope).toBe('~/repo · Codex profile spare');
  });

  it('drops a late reply for another checkout, another floor, or across a reconnect; a check’s too', async () => {
    const r = rig();
    r.step({ page: 'lab' });
    const first = r.held[0];
    // The checkout: user scope only.
    r.link.choose('lab', { cwd: null });
    r.step({ page: 'lab' });
    expect(r.held[1]?.args).toEqual({ floor: 'lab', cwd: null });
    await first?.answer({ ok: true, data: snap({ floor: 'lab' }) });
    expect(r.link.view('lab').received).toBeNull();
    // A check under way when the floor changes.
    r.link.check('claude');
    const check = r.held.at(-1);
    r.office('ops');
    r.step({ page: null });
    expect(r.link.info().floor).toBe('ops');
    await check?.answer({ ok: true, data: snap({ floor: 'lab', cwd: null }) });
    await r.held[1]?.answer({ ok: true, data: snap({ floor: 'lab', cwd: null }) });
    expect(r.link.log.map((e) => e.result)).toEqual(['dropped', 'dropped', 'dropped']);
    // Each floor keeps its own choice.
    expect(r.link.choice('lab')).toEqual({ cwd: null });
    expect(r.link.choice('ops')).toEqual({});
    // A reconnect: the reply of the old connection is dropped, a new request goes.
    r.step({ page: 'ops' });
    const old = r.held.at(-1);
    r.step({ page: 'ops', connected: false, live: false });
    expect(r.link.info().mode).toBe('offline');
    r.step({ page: 'ops' });
    const fresh = r.held.at(-1);
    expect(fresh).not.toBe(old);
    await old?.answer({ ok: true, data: snap({ floor: 'ops' }, 7) });
    expect(r.link.view('ops').received).toBeNull();
    await fresh?.answer({ ok: true, data: snap({ floor: 'ops' }, 2) });
    expect(r.link.view('ops').received?.snap.providers.claude.servers).toHaveLength(2);
  });

  it('A → B → A: the abandoned A reply is dropped, never shown over the newer A, and never clears the newer marker', async () => {
    const r = rig();
    r.step({ page: 'lab' });
    const a1 = r.held[0];
    r.link.choose('lab', { codex_profile: 'b' });
    const b1 = r.held[1];
    r.link.choose('lab', {});
    const a2 = r.held[2];
    expect([a1, b1, a2].map((x) => x?.args)).toEqual([{ floor: 'lab' }, { floor: 'lab', codex_profile: 'b' }, { floor: 'lab' }]);
    // The abandoned A1 answers first: dropped, and A2 is still out.
    await a1?.answer({ ok: true, data: snap({ floor: 'lab' }, 9) });
    expect(r.link.view('lab').received).toBeNull();
    expect(r.link.view('lab').asking).toBe(true);
    expect(r.link.info().asking).toBe(true);
    // One at a time still: the poll does not send another A while A2 is out.
    r.advance(MCP_POLL_MS + 1, { page: 'lab' });
    expect(r.held).toHaveLength(3);
    await a2?.answer({ ok: true, data: snap({ floor: 'lab' }, 2) });
    await b1?.answer({ ok: true, data: snap({ floor: 'lab', codex_profile: 'b' }, 5) });
    expect(r.link.view('lab').received?.snap.providers.claude.servers).toHaveLength(2);
    expect(r.link.log.map((e) => [e.args.codex_profile ?? 'default', e.result])).toEqual([
      ['default', 'dropped'],
      ['b', 'dropped'],
      ['default', 'ok'],
    ]);
  });

  it('A → B → A the other way round: A2 lands first, then the abandoned A1 does not replace it', async () => {
    const r = rig();
    r.step({ page: 'lab' });
    r.link.choose('lab', { codex_profile: 'b' });
    r.link.choose('lab', {});
    await r.held[2]?.answer({ ok: true, data: snap({ floor: 'lab' }, 2) });
    await r.held[0]?.answer({ ok: true, data: snap({ floor: 'lab' }, 9) });
    expect(r.link.view('lab').received?.snap.providers.claude.servers).toHaveLength(2);
    expect(r.link.log.map((e) => e.result)).toEqual(['dropped', undefined, 'ok']);
  });

  it('a floor change and back, and a check across A → B → A: the abandoned replies are dropped, the new context asks at once', async () => {
    const r = rig();
    r.step({ page: 'lab' });
    const l1 = r.held[0];
    r.link.check('codex');
    const c1 = r.held[1];
    r.office('ops');
    r.step({ page: null });
    r.office('lab');
    r.step({ page: 'lab' });
    // Back on lab: a new request goes at once (the old one is abandoned), and the check can be asked again.
    const l2 = r.held[2];
    expect(l2?.t).toBe('mcp.inventory');
    expect(r.link.view('lab').checking.codex).toBe(false);
    r.link.check('codex');
    const c2 = r.held[3];
    expect(c2?.t).toBe('mcp.check');
    await l1?.answer({ ok: true, data: snap({ floor: 'lab' }, 9) });
    await c1?.answer({ ok: true, data: snap({ floor: 'lab' }, 8) });
    expect(r.link.view('lab').received).toBeNull();
    expect(r.link.view('lab').asking).toBe(true);
    expect(r.link.view('lab').checking.codex).toBe(true);
    await l2?.answer({ ok: true, data: snap({ floor: 'lab' }, 2) });
    expect(r.link.view('lab').received?.snap.providers.claude.servers).toHaveLength(2);
    await c2?.answer({ ok: true, data: snap({ floor: 'lab' }, 3) });
    expect(r.link.view('lab').received?.snap.providers.claude.servers).toHaveLength(3);
    expect(r.link.view('lab').checking.codex).toBe(false);
    expect(r.link.log.map((e) => [e.t, e.result])).toEqual([
      ['mcp.inventory', 'dropped'],
      ['mcp.check', 'dropped'],
      ['mcp.inventory', 'ok'],
      ['mcp.check', 'ok'],
    ]);
  });

  it('keeps the A data it has when you come back to A (it is A’s), and a reconnect in between drops the old reply', async () => {
    const r = rig();
    r.step({ page: 'lab' });
    await r.held[0]?.answer({ ok: true, data: snap({ floor: 'lab' }, 4) });
    r.link.choose('lab', { codex_profile: 'b' });
    expect(r.link.view('lab').received).toBeNull();
    r.link.choose('lab', {});
    expect(r.link.view('lab').received?.snap.providers.claude.servers).toHaveLength(4);
    const a2 = r.held.at(-1);
    r.step({ page: 'lab', connected: false, live: false });
    r.step({ page: 'lab' });
    const a3 = r.held.at(-1);
    expect(a3).not.toBe(a2);
    await a2?.answer({ ok: true, data: snap({ floor: 'lab' }, 9) });
    expect(r.link.view('lab').received).toBeNull();
    await a3?.answer({ ok: true, data: snap({ floor: 'lab' }, 1) });
    expect(r.link.view('lab').received?.snap.providers.claude.servers).toHaveLength(1);
  });

  it('queues a Refresh made while a request is out, and sends it when that one ends (only while still wanted)', async () => {
    const r = rig();
    r.step({ page: 'lab' });
    expect(r.held).toHaveLength(1);
    const before = r.link.view('lab').sent;
    r.link.refresh();
    r.link.refresh();
    expect(r.held).toHaveLength(1); // one at a time
    await r.held[0]?.answer({ ok: true, data: snap({ floor: 'lab' }) });
    expect(r.held).toHaveLength(2); // the queued one, once
    expect(r.link.view('lab').seq).toBeLessThanOrEqual(before);
    await r.held[1]?.answer({ ok: true, data: snap({ floor: 'lab' }) });
    expect(r.link.view('lab').seq).toBeGreaterThan(before);
    expect(r.held).toHaveLength(2);
    // Queued, then the page shut and you look away: it is not sent.
    r.advance(MCP_POLL_MS + 1, { page: 'lab' });
    expect(r.held).toHaveLength(3);
    r.link.refresh();
    r.office(null);
    r.step({ page: null, here: false });
    await r.held[2]?.answer({ ok: true, data: snap({ floor: 'lab' }) });
    expect(r.held).toHaveLength(3);
  });

  it('numbers each request, and says which one the shown Snapshot came from', async () => {
    const r = rig();
    expect(r.link.view('lab')).toMatchObject({ seq: 0, sent: 0 });
    r.step({ page: 'lab' });
    expect(r.link.view('lab')).toMatchObject({ seq: 0, sent: 1 });
    r.link.check('claude');
    expect(r.link.view('lab').sent).toBe(2);
    await r.held[1]?.answer({ ok: true, data: snap({ floor: 'lab' }, 3) });
    expect(r.link.view('lab').seq).toBe(2);
    // The inventory asked before the check answers after it: nothing in it is newer than what is shown.
    await r.held[0]?.answer({ ok: true, data: snap({ floor: 'lab' }, 1) });
    expect(r.link.view('lab').seq).toBe(2);
    expect(r.link.view('lab').received?.snap.providers.claude.servers).toHaveLength(3);
    expect(r.link.log.map((e) => [e.t, e.result])).toEqual([
      ['mcp.inventory', 'stale'],
      ['mcp.check', 'ok'],
    ]);
    expect(r.link.view('lab').asking).toBe(false);
  });

  it('a check that ends after a poll asked meanwhile has answered is shown, not lost (F-R6)', async () => {
    const r = rig();
    r.step({ page: 'lab' });
    await r.held[0]?.answer({ ok: true, data: snap({ floor: 'lab' }) });
    // t = 19 s: Check connections; t = 20.001 s: the automatic poll goes and answers at once with the unchecked data.
    r.advance(19_000, { page: 'lab' });
    r.link.check('claude');
    r.advance(MCP_POLL_MS - 19_000 + 1, { page: 'lab' });
    const [check, poll] = [r.held[1], r.held[2]];
    expect([check?.t, poll?.t]).toEqual(['mcp.check', 'mcp.inventory']);
    await poll?.answer({ ok: true, data: { ...snap({ floor: 'lab' }), expected: ['poll'] } });
    expect(r.link.view('lab').checking.claude).toBe(true);
    // t = 21 s: the check ends. Its provider is shown; the context and expected list stay the poll's (asked later).
    await check?.answer({ ok: true, data: checked({ floor: 'lab' }, T0 + 21_000, { expected: ['check'] }) });
    const v = r.link.view('lab');
    expect(v.checking.claude).toBe(false);
    expect(v.received?.snap.providers.claude.check).toMatchObject({ state: 'ok', at: new Date(T0 + 21_000).toISOString() });
    expect(v.received?.snap.providers.claude.servers[0]).toMatchObject({ status: 'auth_required', status_scope: 'probe' });
    expect(v.received?.snap.expected).toEqual(['poll']);
    expect(v.seq).toBe(3);
    expect(r.link.log.map((e) => [e.t, e.result])).toEqual([
      ['mcp.inventory', 'ok'],
      ['mcp.check', 'ok'],
      ['mcp.inventory', 'ok'],
    ]);
  });

  it('a Refresh during a check: whichever lands last, the check’s evidence stays, until newer evidence comes', async () => {
    const r = rig();
    r.step({ page: 'lab' });
    await r.held[0]?.answer({ ok: true, data: snap({ floor: 'lab' }) });
    r.link.check('claude');
    r.link.refresh();
    const [check, refresh] = [r.held[1], r.held[2]];
    expect([check?.t, refresh?.t]).toEqual(['mcp.check', 'mcp.inventory']);
    // The check lands first, then the Refresh asked before it ended (the bridge's data from before the check).
    await check?.answer({ ok: true, data: checked({ floor: 'lab' }, T0 + 2000) });
    await refresh?.answer({ ok: true, data: { ...snap({ floor: 'lab' }, 4), expected: ['later'] } });
    let p = r.link.view('lab').received?.snap.providers;
    expect(p?.claude.check.state).toBe('ok');
    // Its servers, the other provider and the expected list are the newer request's; the check's statuses are put on them.
    expect(p?.claude.servers.map((s) => s.status)).toEqual(['auth_required', 'not_checked', 'not_checked', 'not_checked']);
    expect(p?.codex.servers).toHaveLength(4);
    expect(r.link.view('lab').received?.snap.expected).toEqual(['later']);
    // The next poll carries the same last check: taken whole (it is asked later).
    r.advance(MCP_POLL_MS + 1, { page: 'lab' });
    await r.held[3]?.answer({ ok: true, data: checked({ floor: 'lab' }, T0 + 2000, { n: 2, gen: T0 + 22_000 }) });
    p = r.link.view('lab').received?.snap.providers;
    expect(p?.claude.servers).toHaveLength(2);
    expect(r.link.view('lab').seq).toBe(4);
  });

  it('a check the busy bridge did not start (no time) is shown over an older check, and the next poll replaces it', async () => {
    const r = rig();
    r.step({ page: 'lab' });
    await r.held[0]?.answer({ ok: true, data: checked({ floor: 'lab' }, T0 - 60_000) });
    r.link.check('claude');
    const busy = checked({ floor: 'lab' }, T0 - 60_000, { gen: T0 });
    busy.providers.claude.check = { state: 'skipped', at: null, note: 'The bridge is busy with other checks.' };
    await r.held[1]?.answer({ ok: true, data: busy });
    expect(r.link.view('lab').received?.snap.providers.claude.check.state).toBe('skipped');
    r.advance(MCP_POLL_MS + 1, { page: 'lab' });
    await r.held[2]?.answer({ ok: true, data: checked({ floor: 'lab' }, T0 - 60_000, { gen: T0 + 20_000 }) });
    expect(r.link.view('lab').received?.snap.providers.claude.check.state).toBe('ok');
  });

  it('a newer configuration read is applied after a dated check, also when the bridge no longer reports the check (F-R7)', async () => {
    const r = rig();
    r.step({ page: 'lab' });
    await r.held[0]?.answer({ ok: true, data: snap({ floor: 'lab' }, 2) });
    r.link.check('claude');
    const done = checked({ floor: 'lab' }, T0 + 2000, { n: 2 });
    const when = new Date(T0 + 2000).toISOString();
    done.providers.claude.servers.push({ name: 'claude.ai Gmail', source: 'connector', plugin: '', transport: 'http', enabled: null, approval: 'n/a', status: 'connected', status_scope: 'probe', status_at: when, reason: '' });
    await r.held[1]?.answer({ ok: true, data: done });
    // The bridge forgot the check (its recent window passed and the key was evicted and read again): no check, and the
    // configuration changed meanwhile: s1 removed, s2 added, another skill, a newer read.
    const later = (names: string[], skill: string, readAt: number): McpSnapshot => {
      const s = snap({ floor: 'lab' }, 0);
      const p = s.providers.claude;
      const base = provider(1).servers[0]!;
      p.servers = names.map((name) => ({ ...base, name }));
      p.config.read_at = p.skills.read_at = new Date(readAt).toISOString();
      p.skills.items = [{ name: skill, description: '', source: 'user', plugin: '', enabled: true, invocation: 'both', where: `~/.claude/skills/${skill}` }];
      return { ...s, generated_at: new Date(readAt).toISOString() };
    };
    const claude = () => r.link.view('lab').received?.snap.providers.claude;
    r.advance(MCP_POLL_MS + 1, { page: 'lab' });
    await r.held[2]?.answer({ ok: true, data: later(['s0', 's2'], 'deploy', T0 + 21_000) });
    expect(claude()?.config.read_at).toBe(new Date(T0 + 21_000).toISOString());
    expect(claude()?.skills.items.map((s) => s.name)).toEqual(['deploy']);
    // The check's evidence stays with its time on the servers still configured, and on the one only the check sees.
    expect(claude()?.servers.map((s) => [s.name, s.status, s.status_scope, s.status_at])).toEqual([
      ['s0', 'auth_required', 'probe', when],
      ['s2', 'not_checked', 'config', null],
      ['claude.ai Gmail', 'connected', 'probe', when],
    ]);
    expect(claude()?.check).toMatchObject({ state: 'ok', at: when });
    // And on Refresh.
    r.link.refresh();
    await r.held[3]?.answer({ ok: true, data: later(['s2', 's3'], 'review', T0 + 25_000) });
    expect(claude()?.servers.map((s) => [s.name, s.status])).toEqual([
      ['s2', 'not_checked'],
      ['s3', 'not_checked'],
      ['claude.ai Gmail', 'connected'],
    ]);
    expect(claude()?.skills.items.map((s) => s.name)).toEqual(['review']);
    expect(r.link.log.map((e) => e.result)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(r.link.view('lab').seq).toBe(4);
  });

  it('a configuration read answered by a check asked before a later poll does not replace the poll’s (send order)', async () => {
    const r = rig();
    r.step({ page: 'lab' });
    await r.held[0]?.answer({ ok: true, data: snap({ floor: 'lab' }, 1) });
    r.link.check('claude');
    r.link.refresh();
    await r.held[2]?.answer({ ok: true, data: snap({ floor: 'lab' }, 3) });
    // The check's own read is older than the Refresh's by send order: its evidence is shown on the Refresh's servers.
    await r.held[1]?.answer({ ok: true, data: checked({ floor: 'lab' }, T0 + 3000, { n: 1 }) });
    const p = r.link.view('lab').received?.snap.providers.claude;
    expect(p?.servers.map((s) => [s.name, s.status])).toEqual([
      ['s0', 'auth_required'],
      ['s1', 'not_checked'],
      ['s2', 'not_checked'],
    ]);
    expect(p?.check.state).toBe('ok');
  });

  it('ages a provider taken from an earlier-asked reply on the newest reply’s clock pair', async () => {
    const r = rig();
    r.step({ page: 'lab' });
    r.link.check('claude');
    r.link.refresh(); // queued: the first inventory is out
    await r.held[0]?.answer({ ok: true, data: { ...snap({ floor: 'lab' }), generated_at: new Date(T0 + 1000).toISOString() } });
    r.advance(5000, { page: 'lab' });
    await r.held[1]?.answer({ ok: true, data: checked({ floor: 'lab' }, T0 + 6000, { gen: T0 + 6000 }) });
    const got = r.link.view('lab').received;
    expect(got?.snap.generated_at).toBe(new Date(T0 + 6000).toISOString());
    expect(got?.at).toBe(T0 + 1000 + 5000);
  });

  it('shows the bridge’s refusal of a context in words, and a timeout is just asked again', async () => {
    const r = rig();
    r.step({ page: 'lab' });
    r.link.choose('lab', { codex_profile: 'gone' });
    r.step({ page: 'lab' });
    await r.held[1]?.answer({ ok: false, code: 'not_found', message: 'unknown codex profile' });
    expect(r.link.view('lab').error).toMatch(/Codex profile is not on the bridge/);
    expect(r.link.model().mode).toBe('error');
    r.link.choose('lab', {});
    r.step({ page: 'lab' });
    expect(r.link.view('lab').error).toBeNull();
    await r.held[2]?.answer({ ok: false, code: 'timeout', message: 'slow' });
    expect(r.link.view('lab').error).toBeNull();
    r.advance(MCP_POLL_MS + 1, { page: 'lab' });
    expect(r.held).toHaveLength(4);
  });

  it('feeds the wall only when its picture changes', async () => {
    const r = rig();
    r.look(true);
    r.step();
    r.advance(300);
    const n = r.screens.length;
    r.advance(16);
    r.advance(16);
    expect(r.screens).toHaveLength(n);
    await r.held[0]?.answer({ ok: true, data: snap({ floor: 'lab' }) });
    expect(r.screens.at(-1)?.mode).toBe('data');
    const m = r.screens.length;
    for (let i = 0; i < 100; i++) r.advance(16);
    expect(r.screens).toHaveLength(m);
  });
});
