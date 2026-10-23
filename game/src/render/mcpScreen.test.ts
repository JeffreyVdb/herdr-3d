import { describe, expect, it } from 'vitest';
import '../test/fakeCanvas';
import { floorLayout } from '../world/layout';
import { wallModel, type McpWallModel, type Received } from '../world/mcp';
import type { McpProvider, McpSnapshot } from '../net/protocol';
import { buildMcpScreen } from './mcpScreen';

const T0 = Date.parse('2026-10-23T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const provider = (o: Partial<McpProvider> = {}): McpProvider => ({
  available: true,
  version: '1',
  reason: '',
  config: { state: 'ok', read_at: iso(T0 - 4_000), stale: false, note: '' },
  check: { state: 'none', at: null, note: '' },
  servers: [{ name: 'github', source: 'user', plugin: '', transport: 'stdio', enabled: true, approval: 'n/a', status: 'not_checked', status_scope: 'config', status_at: null, reason: '' }],
  skills: { state: 'ok', read_at: iso(T0 - 4_000), stale: false, complete: true, note: '', items: [], errors: [] },
  ...o,
});
const snap = (claude: McpProvider, codex: McpProvider): McpSnapshot => ({
  context: { floor: 'lab', cwd: '/home/me/x', cwd_display: '~/x', codex_profile: 'codex', codex_profile_name: 'codex', claude_config: '~/.claude' },
  checkouts: [],
  expected: [],
  generated_at: iso(T0),
  providers: { claude, codex },
});
const model = (s: McpSnapshot | null, o: Partial<Parameters<typeof wallModel>[0]> = {}): McpWallModel => wallModel({ unsupported: false, live: true, asking: false, r: s ? ({ snap: s, at: T0 } satisfies Received) : null, now: T0, ...o });

describe('the MCP wall screen (#196)', () => {
  const box = floorLayout(6).props.find((p) => p.id === 'screen.mcp')?.box;
  if (!box) throw new Error('no screen.mcp');

  it('is a bezel and a glass facing the room, two draws, in its box', () => {
    const m = buildMcpScreen(box);
    expect(m.info().drawCalls).toBe(2);
    const glass = m.group.getObjectByName('screen.mcp.glass');
    expect(glass?.position.z).toBeGreaterThan(box.max[2]);
    expect(glass?.position.x).toBeCloseTo((box.min[0] + box.max[0]) / 2, 5);
    m.dispose();
  });

  it('draws the providers’ columns, and only when what it shows changes', () => {
    const m = buildMcpScreen(box);
    const s = snap(provider(), provider({ servers: [] }));
    m.set(model(s));
    expect(m.info().draws).toBe(1);
    expect(m.info().lines).toEqual(expect.arrayContaining(['MCP & skills', '~/x · Codex profile codex', 'Claude Code', '1 MCP server', 'Nothing needs attention', 'Codex', '0 MCP servers']));
    m.set(model(s, { now: T0 + 20_000 }));
    m.set(model(s, { now: T0 + 40_000 }));
    expect(m.info().draws).toBe(1);
    m.set(model(s, { now: T0 + 70_000 }));
    expect(m.info().draws).toBe(2); // the age moved to "1 min ago"
    m.dispose();
  });

  it('is never green (a config read is not a connection): amber for what needs you, grey when stale', () => {
    const m = buildMcpScreen(box);
    m.set(model(snap(provider(), provider())));
    expect(m.info().tones.map((t) => t.ink)).toEqual(['text', 'text']);
    m.set(model(snap(provider({ servers: [{ name: 'x', source: 'user', plugin: '', transport: 'stdio', enabled: true, approval: 'n/a', status: 'auth_required', status_scope: 'probe', status_at: null, reason: '' }] }), provider())));
    expect(m.info().tones.map((t) => t.ink)).toEqual(['warn', 'text']);
    m.set(model(snap(provider({ config: { state: 'ok', read_at: iso(T0 - 600_000), stale: true, note: '' } }), provider({ config: { state: 'partial', read_at: iso(T0), stale: false, note: '' } }))));
    expect(m.info().tones.map((t) => [t.tone, t.ink])).toEqual([
      ['stale', 'grey'],
      ['partial', 'text'],
    ]);
    expect(m.info().lines).toEqual(expect.arrayContaining(['stale', 'partial']));
    m.set(model(snap(provider({ config: { state: 'failed', read_at: null, stale: false, note: '' }, servers: [] }), provider({ available: false, config: { state: 'unavailable', read_at: null, stale: false, note: '' }, servers: [] }))));
    expect(m.info().lines).toEqual(expect.arrayContaining(['Couldn’t read', 'CLI not found']));
    m.dispose();
  });

  it('says when each provider was last checked, in grey with "may be out of date" once that is over 10 minutes', () => {
    const m = buildMcpScreen(box);
    const checked = (ageMs: number) => provider({ check: { state: 'ok', at: iso(T0 - ageMs), note: '' } });
    m.set(model(snap(checked(3 * 60_000), checked(2 * 3600_000))));
    expect(m.info().lines).toEqual(expect.arrayContaining(['Read just now', 'Checked 3 min ago', 'Checked 2 h ago', 'May be out of date']));
    expect(m.info().lines.filter((l) => l === 'May be out of date')).toHaveLength(1);
    expect(m.info().tones.map((t) => t.check)).toEqual(['text', 'grey']);
    // Never checked: no line.
    m.set(model(snap(provider(), provider())));
    expect(m.info().lines.some((l) => l.startsWith('Check') || l === 'May be out of date')).toBe(false);
    expect(m.info().tones.map((t) => t.check)).toEqual(['', '']);
    m.dispose();
  });

  it('has its calm screens', () => {
    const m = buildMcpScreen(box);
    m.set(model(null, { unsupported: true }));
    expect(m.info()).toMatchObject({ mode: 'unsupported', lines: ['MCP & skills', 'No MCP inventory on this bridge', 'Update herdr-world to see them here'] });
    m.set(model(null, { live: false }));
    expect(m.info().mode).toBe('offline');
    m.set(model(null, { asking: true }));
    expect(m.info().lines).toContain('Reading the configuration…');
    m.dispose();
  });
});
