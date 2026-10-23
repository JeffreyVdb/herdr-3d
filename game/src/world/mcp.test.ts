import { describe, expect, it } from 'vitest';
import type { McpHarness, McpProvider, McpServer, McpSnapshot } from '../net/protocol';
import {
  ageOf,
  ageText,
  attentionCount,
  cellText,
  configStale,
  expectedNameError,
  HARNESSES,
  hudLine,
  mcpRows,
  MCP_STALE_MS,
  providerTone,
  statusTone,
  wallModel,
  wallProvider,
  type Received,
} from './mcp';

const T0 = Date.parse('2026-10-23T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const READ_STATES = ['ok', 'partial', 'failed', 'pending', 'unavailable', 'unsupported'] as const;
const STATUSES = ['not_checked', 'disabled', 'approval_required', 'blocked', 'connecting', 'connected', 'auth_required', 'failed', 'unknown'] as const;

const server = (name: string, o: Partial<McpServer> = {}): McpServer => ({
  name,
  source: 'user',
  plugin: '',
  transport: 'stdio',
  enabled: true,
  approval: 'n/a',
  status: 'not_checked',
  status_scope: 'config',
  status_at: null,
  reason: '',
  ...o,
});

const provider = (state: string, servers: McpServer[] = [], o: Partial<McpProvider> = {}): McpProvider => ({
  available: state !== 'unavailable',
  version: '1.0.0',
  reason: '',
  config: { state, read_at: state === 'ok' || state === 'partial' ? iso(T0 - 5_000) : null, stale: false, note: '' },
  check: { state: 'none', at: null, note: '' },
  servers,
  skills: { state: 'ok', read_at: iso(T0 - 5_000), stale: false, complete: false, note: '', items: [], errors: [] },
  ...o,
});

const snapshot = (claude: McpProvider, codex: McpProvider, expected?: string[]): McpSnapshot => ({
  context: { floor: 'lab', cwd: '/home/me/repos/x', cwd_display: '~/repos/x', codex_profile: null, codex_profile_name: 'codex', claude_config: '~/.claude' },
  checkouts: [{ path: '/home/me/repos/x', display: '~/repos/x', label: 'x (default)' }],
  ...(expected ? { expected } : {}),
  generated_at: iso(T0),
  providers: { claude, codex },
});

const received = (snap: McpSnapshot, at = T0): Received => ({ snap, at });

describe('mcpRows: the client merge rule, every combination', () => {
  // Per provider: its read state × the name present or absent; the name expected or not. 6 × 2 × 6 × 2 × 2 = 288 cases.
  const cases: Array<{ cs: string; xs: string; inC: boolean; inX: boolean; expected: boolean }> = [];
  for (const cs of READ_STATES) for (const xs of READ_STATES) for (const inC of [true, false]) for (const inX of [true, false]) for (const expected of [true, false]) cases.push({ cs, xs, inC, inX, expected });

  it('has the whole matrix', () => expect(cases).toHaveLength(288));

  it.each(cases)('claude $cs (present $inC) × codex $xs (present $inX), expected $expected', ({ cs, xs, inC, inX, expected }) => {
    const snap = snapshot(provider(cs, inC ? [server('github')] : []), provider(xs, inX ? [server('github')] : []), expected ? ['github'] : []);
    const rows = mcpRows(snap);
    const row = rows.find((r) => r.name === 'github');
    if (!inC && !inX && !expected) {
      // Nobody has it and nobody expects it: no row.
      expect(row).toBeUndefined();
      return;
    }
    expect(row, 'one row').toBeDefined();
    if (!row) return;
    expect(rows.filter((r) => r.name === 'github')).toHaveLength(1);
    expect(row.expected).toBe(expected);
    for (const [h, state, present] of [
      ['claude', cs, inC],
      ['codex', xs, inX],
    ] as Array<[McpHarness, string, boolean]>) {
      const c = row.cells[h];
      const known = state === 'ok' || state === 'partial';
      // Both providers always have a cell.
      expect(c, h).toBeDefined();
      if (present) {
        expect(c.kind, h).toBe('present');
        expect(c.server?.name).toBe('github');
      } else if (known) {
        expect(c.kind, h).toBe(expected ? 'missing' : 'not_configured');
        expect(cellText(c, h)).toMatch(/not configured in/i);
      } else {
        // A failed, pending, unavailable or unsupported read never says "not configured".
        expect(c.kind, h).toBe('unknown');
        expect(cellText(c, h)).toBe('Unknown');
      }
      // Only an expected name that is absent from a known read is an alert.
      expect(c.attention, h).toBe(!present && known && expected);
    }
    expect(row.missing).toBe(HARNESSES.some((h) => row.cells[h].kind === 'missing'));
    // Expected but absent from both known reads: shown as not configured, an alert on both.
    if (expected && !inC && !inX && (cs === 'ok' || cs === 'partial') && (xs === 'ok' || xs === 'partial')) {
      expect(row.cells.claude.kind).toBe('missing');
      expect(row.cells.codex.kind).toBe('missing');
    }
  });

  it('never calls a disabled, auth required, failed or approval required server missing; the attention ones need you', () => {
    for (const status of STATUSES) {
      for (const expected of [true, false]) {
        const snap = snapshot(provider('ok', [server('s', { status })]), provider('ok', [server('s', { status, status_scope: 'probe' })]), expected ? ['s'] : []);
        const [row] = mcpRows(snap);
        for (const h of HARNESSES) {
          expect(row?.cells[h].kind, `${status} ${h}`).toBe('present');
          expect(row?.cells[h].attention, `${status} ${h}`).toBe(['failed', 'auth_required', 'approval_required'].includes(status));
        }
        expect(row?.missing).toBe(false);
      }
    }
  });

  it('keeps the same name in both providers on one row, its cells apart; sorts by name; names compare exactly', () => {
    const snap = snapshot(provider('ok', [server('github', { status: 'connected', status_scope: 'probe' }), server('Zed')]), provider('ok', [server('github', { status: 'auth_required', source: 'project' }), server('alpha'), server('GitHub')]), ['linear']);
    const rows = mcpRows(snap);
    expect(rows.map((r) => r.name)).toEqual(['alpha', 'GitHub', 'github', 'linear', 'Zed']);
    const gh = rows.find((r) => r.name === 'github');
    expect(gh?.cells.claude.server?.status).toBe('connected');
    expect(gh?.cells.codex.server?.status).toBe('auth_required');
    expect(gh?.cells.codex.server?.source).toBe('project');
    // `GitHub` is another server: Claude Code does not have it.
    expect(rows.find((r) => r.name === 'GitHub')?.cells.claude.kind).toBe('not_configured');
  });

  it('counts each provider’s attention as the sum of its cells (configured that need you, expected it lacks), on any mix', () => {
    const states = READ_STATES;
    let seed = 196;
    const rnd = (n: number) => ((seed = (seed * 1664525 + 1013904223) >>> 0) % n);
    const names = ['a', 'b', 'c', 'd', 'e'];
    for (let i = 0; i < 400; i++) {
      const pick = () => names.filter(() => rnd(2) === 0).map((n) => server(n, { status: STATUSES[rnd(STATUSES.length)] as string }));
      const expected = names.filter(() => rnd(3) === 0);
      const snap = snapshot(provider(states[rnd(states.length)] as string, pick()), provider(states[rnd(states.length)] as string, pick()), expected);
      const rows = mcpRows(snap);
      for (const h of HARNESSES) expect(attentionCount(snap.providers[h], expected), `case ${i} ${h}`).toBe(rows.filter((r) => r.cells[h].attention).length);
      // Every name of either side and every expected one has its row, once.
      const want = new Set([...expected, ...snap.providers.claude.servers.map((s) => s.name), ...snap.providers.codex.servers.map((s) => s.name)]);
      expect(rows.map((r) => r.name).sort()).toEqual([...want].sort());
    }
  });
});

describe('stale and age', () => {
  it('ages a timestamp on the bridge’s clock, whatever the browser’s clock says', () => {
    const snap = snapshot(provider('ok'), provider('ok'));
    // The browser runs 3 hours ahead of the bridge: the read was 5 s old when the Snapshot was made, it arrived 10 s ago.
    const r = received(snap, T0 + 3 * 3600_000);
    expect(ageOf(snap.providers.claude.config.read_at, r, T0 + 3 * 3600_000 + 10_000)).toBe(15_000);
    expect(ageOf(null, r, T0)).toBeNull();
    expect(ageOf('nonsense', r, T0)).toBeNull();
  });

  it('says ages coarsely', () => {
    expect([ageText(null), ageText(0), ageText(59_999), ageText(60_000), ageText(59 * 60_000 + 59_999), ageText(3600_000), ageText(25 * 3600_000)]).toEqual(['', 'just now', 'just now', '1 min ago', '59 min ago', '1 h ago', '1 d ago']);
  });

  it('is stale when the bridge says so or the read is over 2 minutes old; a stale provider never looks healthy', () => {
    const fresh = provider('ok', [server('github', { status: 'connected', status_scope: 'probe' })]);
    const flagged = provider('ok', fresh.servers, { config: { ...fresh.config, stale: true } });
    const r = received(snapshot(fresh, flagged));
    expect(configStale(fresh, r, T0)).toBe(false);
    expect(providerTone(fresh, r, T0)).toBe('ok');
    expect(configStale(flagged, r, T0)).toBe(true);
    expect(providerTone(flagged, r, T0)).toBe('stale');
    // The same fresh read, looked at 2 minutes later: stale.
    expect(configStale(fresh, r, T0 + MCP_STALE_MS - 5_000)).toBe(false);
    expect(configStale(fresh, r, T0 + MCP_STALE_MS)).toBe(true);
    expect(providerTone(fresh, r, T0 + MCP_STALE_MS)).toBe('stale');
    // A read without a time is never fresh.
    const noTime = provider('ok', [], { config: { state: 'ok', read_at: null, stale: false, note: '' } });
    expect(providerTone(noTime, r, T0)).toBe('stale');
    // A failed read that kept the last good data: stale, its servers shown; without data: failed.
    expect(providerTone(provider('failed', fresh.servers, { config: { state: 'failed', read_at: iso(T0 - 600_000), stale: true, note: '' } }), r, T0)).toBe('stale');
    expect(providerTone(provider('failed'), r, T0)).toBe('failed');
    // A connected server on stale data is not green.
    expect(statusTone('connected', false)).toBe('ok');
    expect(statusTone('connected', true)).toBe('muted');
    for (const s of STATUSES) expect(statusTone(s, true)).toBe('muted');
  });

  it('gives every read state its tone, and only a fresh ok read is ok', () => {
    const r = received(snapshot(provider('ok'), provider('ok')));
    expect(READ_STATES.map((s) => providerTone(provider(s), r, T0))).toEqual(['ok', 'partial', 'failed', 'pending', 'unavailable', 'unsupported']);
    expect(providerTone(provider('weird'), r, T0)).toBe('failed');
    expect(providerTone(provider('ok', [], { available: false }), r, T0)).toBe('unavailable');
  });
});

describe('the wall', () => {
  const base = () =>
    snapshot(
      provider('ok', [server('github', { status: 'connected', status_scope: 'probe' }), server('sentry', { status: 'auth_required' }), server('linear')], {
        skills: { state: 'ok', read_at: iso(T0 - 5_000), stale: false, complete: false, note: '', items: [{ name: 'deploy', description: '', source: 'user', plugin: '', enabled: true, invocation: 'both', where: '~/.claude/skills/deploy' }], errors: [] },
        check: { state: 'ok', at: iso(T0 - 3 * 60_000), note: '' },
      }),
      provider('ok', [server('github')], { skills: { state: 'ok', read_at: iso(T0), stale: false, complete: true, note: '', items: [], errors: [] } }),
      ['github', 'notion'],
    );

  it('shows per provider the configured count, what needs attention, the skills, the scope and the ages', () => {
    const m = wallModel({ unsupported: false, live: true, asking: false, r: received(base()), now: T0 });
    expect(m.mode).toBe('data');
    expect(m.scope).toBe('~/repos/x · Codex profile codex');
    expect(m.providers.map((p) => [p.name, p.big, p.attention, p.skills, p.age, p.tag])).toEqual([
      ['Claude Code', '3 MCP servers', '2 need attention', '1+ skills', 'Read just now · checked 3 min ago', ''],
      ['Codex', '1 MCP server', '1 needs attention', '0 skills', 'Read just now', ''],
    ]);
    expect(hudLine(m)).toBe('Claude Code 3 MCP (2 need you) · Codex 1 MCP (1 needs you)');
  });

  it('has calm screens for an old bridge, no connection, nobody looking yet, the first read, a refusal', () => {
    const at = (o: Partial<Parameters<typeof wallModel>[0]>) => wallModel({ unsupported: false, live: true, asking: false, r: null, now: T0, ...o });
    expect(at({ unsupported: true, r: received(base()) })).toMatchObject({ mode: 'unsupported', scope: 'No MCP inventory on this bridge' });
    expect(at({ live: false, r: received(base()) })).toMatchObject({ mode: 'offline' });
    expect(at({})).toMatchObject({ mode: 'idle' });
    expect(at({ asking: true })).toMatchObject({ mode: 'loading' });
    expect(at({ error: 'No such Codex profile' })).toMatchObject({ mode: 'error', scope: 'No such Codex profile' });
    for (const m of [at({ unsupported: true }), at({ live: false }), at({}), at({ asking: true })]) expect(m.providers).toEqual([]);
  });

  it('shows a missing CLI, a pending or failed read, user scope; never a count it cannot trust', () => {
    const s = base();
    s.providers.codex = provider('unavailable', [], { reason: 'codex not found on PATH' });
    s.providers.claude = provider('pending');
    s.context.cwd = null;
    const m = wallModel({ unsupported: false, live: true, asking: false, r: received(s), now: T0 });
    expect(m.scope).toBe('User scope only · Codex profile codex');
    expect(m.providers.map((p) => [p.big, p.attention, p.tone])).toEqual([
      ['Reading…', '', 'pending'],
      ['CLI not found', '', 'unavailable'],
    ]);
    s.providers.claude = provider('failed');
    expect(wallProvider('claude', received(s), T0)).toMatchObject({ big: 'Couldn’t read', attention: '', tone: 'failed' });
  });

  it('redraws only when what it shows changes: the same data a second later is the same key, a minute later the age moves', () => {
    const r = received(base());
    const k = (now: number) => wallModel({ unsupported: false, live: true, asking: false, r, now }).key;
    expect(k(T0 + 1_000)).toBe(k(T0));
    expect(k(T0 + 30_000)).toBe(k(T0));
    expect(k(T0 + 61_000)).not.toBe(k(T0));
    // A new Snapshot with the same content (another generated_at, same ages) is the same picture.
    const again = base();
    again.generated_at = iso(T0 + 20_000);
    for (const h of HARNESSES) {
      again.providers[h].config.read_at = iso(Date.parse(again.providers[h].config.read_at ?? '') + 20_000);
      if (again.providers[h].check.at) again.providers[h].check.at = iso(Date.parse(again.providers[h].check.at ?? '') + 20_000);
    }
    expect(wallModel({ unsupported: false, live: true, asking: false, r: received(again, T0 + 20_000), now: T0 + 20_000 }).key).toBe(k(T0 + 20_000));
  });

  it('tags a stale or partial provider and counts its attention from the data it kept', () => {
    const s = base();
    s.providers.claude.config.stale = true;
    s.providers.codex.config.state = 'partial';
    const m = wallModel({ unsupported: false, live: true, asking: false, r: received(s), now: T0 });
    expect(m.providers.map((p) => [p.tone, p.tag, p.attentionCount])).toEqual([
      ['stale', 'stale', 2],
      ['partial', 'partial', 1],
    ]);
    expect(hudLine(m)).toContain('stale');
  });
});

describe('expected names', () => {
  it('takes what the bridge takes', () => {
    expect(expectedNameError('  github ', [])).toBeNull();
    expect(expectedNameError('   ', [])).toMatch(/Type/);
    expect(expectedNameError('a'.repeat(100), [])).toBeNull();
    expect(expectedNameError('a'.repeat(101), [])).toMatch(/100 bytes/);
    expect(expectedNameError('é'.repeat(51), [])).toMatch(/100 bytes/);
    expect(expectedNameError('git\u0007hub', [])).toMatch(/control/);
    expect(expectedNameError('github', ['github'])).toMatch(/already/);
    expect(expectedNameError('GitHub', ['github'])).toBeNull();
    expect(expectedNameError('x', Array.from({ length: 32 }, (_, i) => `s${i}`))).toMatch(/32/);
  });
});
