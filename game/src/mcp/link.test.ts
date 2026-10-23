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
  context: { floor: a.floor, cwd: a.cwd === undefined ? '/repo' : a.cwd, cwd_display: a.cwd === undefined ? '~/repo' : (a.cwd ?? ''), codex_profile: a.codex_profile ?? null, codex_profile_name: a.codex_profile ?? 'codex', claude_config: '~/.claude' },
  checkouts: [],
  expected: [],
  generated_at: new Date(T0).toISOString(),
  providers: { claude: provider(n), codex: provider(n) },
});

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
