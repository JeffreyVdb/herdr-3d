// M10: the plan limits, simulated for the fixture server (`sim=1`, see tools/fixture-sim.ts). Rules, like
// herdr-world's (docs/protocol.md "Plan limits"):
// - the snapshot's `limits` holds a reading per provider, taken when the client connects (`at` = now), so it is fresh;
// - `limits.refresh {}` answers `{queued: true}` and sends `limits.update` for both providers with `at` = now (a
//   second refresh within 20 s answers `{queued: false}` and sends nothing);
// - `simlimits=<scenario>` picks the readings: `ok` (default), `hot` (Claude week 91 %, Codex 5h 88 %: red), `reached`
//   (Codex rateLimitReachedType set, 5h at 100 %), `old` (Claude's reading is 15 minutes old), `transcript` (Codex
//   from a session log: stale, "as of"), `noplan` (Claude: no plan), `none` (`limits: []`, nothing read yet);
// - `simfail=no_m10` plays a bridge before M10: no `limits` in the snapshot, `limits.refresh` is `unknown_command`.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { Limits } from '../src/net/protocol.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export const LIMIT_SCENARIOS = ['ok', 'hot', 'reached', 'old', 'transcript', 'noplan', 'none'] as const;
export type LimitScenario = (typeof LIMIT_SCENARIOS)[number];

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The readings of a scenario at `now` (unix ms). */
export function readings(scenario: string, now: number): Limits[] {
  const claude = (over: Partial<Limits> = {}, five = 11, week = 61): Limits => ({
    provider: 'claude',
    plan: 'team',
    windows: [
      { label: '5h', pct: five, resets_at: now + 2 * HOUR + 9 * MIN, window_mins: 300 },
      { label: 'week', pct: week, resets_at: now + 2 * 24 * HOUR + 5 * HOUR, window_mins: 10080 },
      { label: 'week', model: 'Opus', pct: 34, resets_at: now + 2 * 24 * HOUR + 5 * HOUR, window_mins: 10080 },
      { label: 'week', model: 'Fable', pct: 3, resets_at: now + 2 * 24 * HOUR + 5 * HOUR, window_mins: 10080 },
    ],
    at: now,
    stale: false,
    source: 'probe',
    ...over,
  });
  const codex = (over: Partial<Limits> = {}, week = 19): Limits => ({
    provider: 'codex',
    plan: 'prolite',
    windows: [{ label: 'week', pct: week, resets_at: now + 3 * 24 * HOUR, window_mins: 10080 }],
    at: now,
    stale: false,
    source: 'probe',
    credits: { has_credits: false, unlimited: false, balance: '0' },
    ...over,
  });
  switch (scenario) {
    case 'none':
      return [];
    case 'hot':
      return [claude({}, 40, 91), codex({ windows: [{ label: '5h', pct: 88, resets_at: now + 50 * MIN, window_mins: 300 }, { label: 'week', pct: 64, resets_at: now + 3 * 24 * HOUR, window_mins: 10080 }] })];
    case 'reached':
      return [claude(), codex({ reached: 'rate_limit_reached', windows: [{ label: '5h', pct: 100, resets_at: now + 35 * MIN, window_mins: 300 }, { label: 'week', pct: 64, resets_at: now + 3 * 24 * HOUR, window_mins: 10080 }] })];
    case 'old':
      return [claude({ at: now - 15 * MIN }), codex()];
    case 'transcript':
      return [claude(), codex({ at: now - 50 * MIN, stale: true, source: 'transcript', error: 'failed' })];
    case 'noplan':
      return [{ provider: 'claude', plan: '', windows: [], at: now, stale: false, error: 'no_plan', source: 'probe' }, codex()];
    default:
      return [claude(), codex()];
  }
}

export class LimitsSim {
  private lastRefresh = -Infinity;

  constructor(
    private readonly scenario: string,
    private readonly on: boolean,
    private readonly now: () => number,
    private readonly emit: (send: Send, m: Obj) => void,
    private readonly error: (code: string, message: string) => Error,
  ) {}

  decorate(world: Obj): void {
    if (this.on) world.limits = readings(this.scenario, this.now());
  }

  handle(t: unknown, send: Send, ack: (data?: unknown) => void): boolean {
    if (t !== 'limits.refresh') return false;
    if (!this.on) throw this.error('unknown_command', 'unknown command: "limits.refresh"');
    const now = this.now();
    const queued = now - this.lastRefresh >= 20_000;
    if (queued) {
      this.lastRefresh = now;
      for (const l of readings(this.scenario === 'none' ? 'ok' : this.scenario, now)) this.emit(send, { t: 'limits.update', ...l });
    }
    ack({ queued });
    return true;
  }
}
