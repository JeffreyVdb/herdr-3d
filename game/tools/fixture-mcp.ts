// #196 MCP & skills wall: `mcp.inventory` and `mcp.check`, simulated for the fixture server (`sim=1`, see
// tools/fixture-sim.ts). Like herdr-world's (docs/protocol.md "MCP and skills"):
// - `mcp.inventory {floor, cwd?, codex_profile?}` acks a Snapshot: `cwd` absent is the floor's default checkout, null
//   user scope only (no project servers or skills), another must be one of the floor's checkouts (`bad_request`);
//   `codex_profile` must be a key of the Codex profiles (`not_found`; absent or null: the default `codex`);
// - Claude Code has `github` (user), `linear` (project, not approved: approval required), `sentry` (user, http) and the
//   `context7` plugin's server; Codex has `github` and `sentry` on the default profile, `github` and `jira` on `work`,
//   nothing on `spare`. Skills: two Claude ones from disk (incomplete list), three Codex ones (one disabled) and a load
//   error;
// - `mcp.check {…, harness}` acks after `simmcpcheckms` (default 600) with that provider's probe: Claude `github` and
//   `context7` connected, `sentry` needs a sign-in, `linear` stays approval required (never started), a claude.ai
//   connector `Gmail` found; Codex `github` connected, `sentry` failed ("Connection closed"). Later inventories keep
//   the probe's statuses, as the bridge's cache does;
// - the floor's `expected_mcp` (floor.settings.set, tools/fixture-sim.ts) is the Snapshot's `expected`;
// - scripted: `sim.mcp {stale?, fail?, unavailable?, pending?: 'claude'|'codex'|null, delay?: {codex_profile, ms},
//   expected?: false}`: that provider's read is stale (10 minutes old), failed (no data), its CLI missing, still
//   pending; replies for that Codex profile (null: the default) take `ms`; `expected: false` plays a bridge without
//   `expected_mcp` (no `expected` in the Snapshot). `sim.mcp_log {}` answers the commands it took, for tests;
// - `simfail=no_mcp` plays a bridge before it: both commands are `unknown_command`.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
type Obj = Record<string, unknown>;
type Harness = 'claude' | 'codex';

const MIN = 60_000;

export interface McpSimHost {
  /** The floor's default checkout and its other checkouts (absolute paths); throws `unknown_session` for no such floor. */
  checkouts(floor: string): { default: string; all: string[] };
  /** The floor's expected server names (absent: none set). */
  expected(floor: string): string[] | undefined;
  /** A Codex profile by key (null: the default), or null when there is none such; key and name `""` when the bridge lists no profiles. */
  profile(key: string | null): { key: string; name: string } | null;
  later(fn: () => void, ms: number): unknown;
  now(): number;
  error(code: string, message: string): Error;
}

interface Script {
  stale: Harness | null;
  fail: Harness | null;
  unavailable: Harness | null;
  pending: Harness | null;
  /** Codex profile key ('codex' for the default) → reply delay. */
  delay: Map<string, number>;
  expected: boolean;
}

interface Srv {
  name: string;
  source: string;
  plugin?: string;
  transport: string;
  project?: boolean;
}

const CLAUDE: Srv[] = [
  { name: 'github', source: 'user', transport: 'stdio' },
  { name: 'linear', source: 'project', transport: 'http', project: true },
  { name: 'sentry', source: 'user', transport: 'http' },
  { name: 'context7', source: 'plugin', plugin: 'context7', transport: 'stdio' },
];
const CODEX: Record<string, Srv[]> = {
  codex: [
    { name: 'github', source: 'user', transport: 'stdio' },
    { name: 'sentry', source: 'user', transport: 'http' },
  ],
  work: [
    { name: 'github', source: 'user', transport: 'stdio' },
    { name: 'jira', source: 'project', transport: 'http', project: true },
  ],
};
const PROBE: Record<Harness, Record<string, { status: string; reason?: string }>> = {
  claude: { github: { status: 'connected' }, context7: { status: 'connected' }, sentry: { status: 'auth_required', reason: 'Authentication required' }, Gmail: { status: 'connected' } },
  codex: { github: { status: 'connected' }, jira: { status: 'connected' }, sentry: { status: 'failed', reason: 'Connection closed' } },
};

const display = (p: string) => p.replace(/^\/home\/[^/]+/, '~');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

export class McpSim {
  private readonly h: McpSimHost;
  private readonly on: boolean;
  private readonly checkMs: number;
  private readonly script: Script = { stale: null, fail: null, unavailable: null, pending: null, delay: new Map(), expected: true };
  /** The last check per `cwd|profile|harness`: when, and the probe's statuses. */
  private readonly checks = new Map<string, number>();
  private readonly log: Obj[] = [];

  constructor(h: McpSimHost, on: boolean, checkMs = 600) {
    this.h = h;
    this.on = on;
    this.checkMs = checkMs;
  }

  handle(t: unknown, a: Obj, ack: (d?: unknown) => void, fail: (e: unknown) => void): boolean {
    if (t === 'sim.mcp') {
      for (const k of ['stale', 'fail', 'unavailable', 'pending'] as const) if (k in a) this.script[k] = (a[k] as Harness | null) ?? null;
      if (a.delay && typeof a.delay === 'object') {
        const d = a.delay as Obj;
        this.script.delay.set(typeof d.codex_profile === 'string' ? d.codex_profile : 'codex', Number(d.ms) || 0);
      }
      if (typeof a.expected === 'boolean') this.script.expected = a.expected;
      ack();
      return true;
    }
    if (t === 'sim.mcp_log') {
      ack({ commands: this.log.map((x) => ({ ...x })) });
      return true;
    }
    if (t !== 'mcp.inventory' && t !== 'mcp.check') return false;
    if (!this.on) throw this.h.error('unknown_command', `unknown command: "${String(t)}"`);
    const floor = typeof a.session === 'string' ? a.session : '';
    const co = this.h.checkouts(floor);
    let cwd: string | null = co.default;
    if ('cwd' in a) {
      if (a.cwd === null) cwd = null;
      else if (typeof a.cwd !== 'string' || !a.cwd.startsWith('/') || !co.all.includes(a.cwd)) throw this.h.error('bad_request', 'bad args: cwd must be an existing absolute directory');
      else cwd = a.cwd;
    }
    const key = a.codex_profile === undefined || a.codex_profile === null ? null : String(a.codex_profile);
    const profile = this.h.profile(key);
    if (!profile) throw this.h.error('not_found', `unknown codex profile: "${String(key)}"`);
    const harness = t === 'mcp.check' ? (a.harness as Harness) : null;
    if (t === 'mcp.check' && harness !== 'claude' && harness !== 'codex') throw this.h.error('bad_request', 'bad args: harness must be claude or codex');
    this.log.push({ t, floor, cwd, codex_profile: profile.key, ...(harness ? { harness } : {}) });
    const ms = (this.script.delay.get(profile.key || 'codex') ?? 0) + (harness ? this.checkMs : 0);
    const answer = () => {
      try {
        if (harness) this.checks.set(`${cwd}|${profile.key}|${harness}`, this.h.now());
        ack(this.snapshot(floor, cwd, co.all, profile));
      } catch (e) {
        fail(e);
      }
    };
    if (ms > 0) this.h.later(answer, ms);
    else answer();
    return true;
  }

  private snapshot(floor: string, cwd: string | null, all: string[], profile: { key: string; name: string }): Obj {
    const now = this.h.now();
    const expected = this.h.expected(floor) ?? [];
    return {
      context: { floor, cwd, cwd_display: cwd === null ? '' : display(cwd), codex_profile: profile.key, codex_profile_name: profile.name, claude_config: '~/.claude' },
      checkouts: all.map((p, i) => ({ path: p, display: display(p), label: `${p.split('/').pop() ?? p}${i === 0 ? ' (default)' : ''}` })),
      ...(this.script.expected ? { expected } : {}),
      generated_at: iso(now),
      providers: {
        claude: this.provider('claude', CLAUDE, cwd, profile.key, now),
        codex: this.provider('codex', CODEX[profile.key || 'codex'] ?? [], cwd, profile.key, now),
      },
    };
  }

  private provider(h: Harness, list: Srv[], cwd: string | null, profile: string, now: number): Obj {
    const s = this.script;
    const checkedAt = this.checks.get(`${cwd}|${profile}|${h}`) ?? null;
    const skills = this.skills(h, cwd, now);
    if (s.unavailable === h) {
      return {
        available: false,
        version: '',
        reason: `${h} not found on the bridge's PATH`,
        config: { state: 'unavailable', read_at: null, stale: false, note: '' },
        check: { state: 'none', at: null, note: '' },
        servers: [],
        skills: { ...skills, state: 'unavailable', read_at: null, items: [], errors: [] },
      };
    }
    if (s.pending === h || s.fail === h) {
      const state = s.pending === h ? 'pending' : 'failed';
      return {
        available: true,
        version: h === 'claude' ? '2.1.309' : '0.163.0',
        reason: '',
        config: { state, read_at: null, stale: false, note: state === 'failed' ? 'The configuration could not be read' : '' },
        check: { state: 'none', at: null, note: '' },
        servers: [],
        skills: { ...skills, state, read_at: null, items: [], errors: [] },
      };
    }
    const stale = s.stale === h;
    const readAt = iso(now - (stale ? 10 * MIN : 4_000));
    const servers: Obj[] = list
      .filter((x) => cwd !== null || !x.project)
      .map((x) => {
        const unapproved = h === 'claude' && x.project;
        const probe = checkedAt !== null && !unapproved ? PROBE[h][x.name] : undefined;
        return {
          name: x.name,
          source: x.source,
          plugin: x.plugin ?? '',
          transport: x.transport,
          enabled: true,
          approval: unapproved ? 'pending' : 'n/a',
          status: unapproved ? 'approval_required' : (probe?.status ?? 'not_checked'),
          status_scope: probe ? 'probe' : 'config',
          status_at: probe ? iso(checkedAt as number) : null,
          reason: probe?.reason ?? (unapproved ? 'Not approved in this checkout' : ''),
        };
      });
    if (h === 'claude' && checkedAt !== null) servers.push({ name: 'Gmail', source: 'connector', plugin: '', transport: 'http', enabled: true, approval: 'n/a', status: 'connected', status_scope: 'probe', status_at: iso(checkedAt), reason: '' });
    return {
      available: true,
      version: h === 'claude' ? '2.1.309' : '0.163.0',
      reason: '',
      config: { state: 'ok', read_at: readAt, stale, note: stale ? 'The last read failed; this is the one before it' : '' },
      check: checkedAt === null ? { state: 'none', at: null, note: '' } : { state: 'ok', at: iso(checkedAt), note: '' },
      servers,
      skills: { ...skills, read_at: readAt, stale },
    };
  }

  private skills(h: Harness, cwd: string | null, now: number): Obj {
    const read = iso(now - 4_000);
    if (h === 'claude') {
      const items = [{ name: 'deploy', description: 'Ship the current branch to staging', source: 'user', plugin: '', enabled: true, invocation: 'both', where: '~/.claude/skills/deploy' }];
      if (cwd !== null) items.push({ name: 'review', description: 'Review the changes against the repo’s standards', source: 'project', plugin: '', enabled: true, invocation: 'user_only', where: `${display(cwd)}/.claude/skills/review` });
      return { state: 'ok', read_at: read, stale: false, complete: false, note: 'Found on disk; claude.ai-synced and lazily loaded skills are not listed', items, errors: [] };
    }
    return {
      state: 'ok',
      read_at: read,
      stale: false,
      complete: true,
      note: '',
      items: [
        { name: 'changelog', description: 'Write the changelog entry', source: 'user', plugin: '', enabled: true, invocation: 'both', where: '~/.codex/skills/changelog' },
        { name: 'imagegen', description: 'Generate images', source: 'system', plugin: '', enabled: true, invocation: 'model_only', where: '~/.codex/skills/.system/imagegen' },
        { name: 'legacy-lint', description: 'Old lint rules', source: 'user', plugin: '', enabled: false, invocation: 'both', where: '~/.codex/skills/legacy-lint' },
      ],
      errors: [{ where: '~/.codex/skills/broken', message: 'Invalid SKILL.md frontmatter' }],
    };
  }
}
