// #74 server rack: the bridge host's stats, simulated for the fixture server (`sim=1`, see tools/fixture-sim.ts). Rules,
// like herdr-world's (docs/protocol.md "Host stats"):
// - `host.watch {}` acks and starts this connection's frames: a `host.stats` after 1 s (`simhostms` / 5), then every 5 s
//   (`simhostms`, default 5000), and a `host.disk` every second (`simhostms` / 5); `host.unwatch {}` acks and stops them.
//   Both are idempotent; frames carry no `seq` and are never replayed; a closed connection takes its watch with it;
// - the numbers are scripted: `sim.host {cpu?, mem?, updates?, disks?}` changes what the next frames say (`updates:
//   null` drops the field, as on a host that is not Arch-based), `simhost=<scenario>` picks the start (`ok`, `hot`,
//   `noupdates`, `busy`: a disk at 6000 IOPS);
// - `simfail=no_host` plays a bridge before it: `host.watch` and `host.unwatch` are `unknown_command`;
// - `sim.host_log {}` (not a bridge command) answers the commands and frames of this connection, for tests.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export const HOST_SCENARIOS = ['ok', 'hot', 'noupdates', 'busy'] as const;

export interface HostDisk {
  name: string;
  r_iops: number;
  w_iops: number;
  r_bps: number;
  w_bps: number;
}

interface Numbers {
  cpu: number | null;
  mem: number;
  updates: number | null;
  disks: HostDisk[];
}

const GIB = 2 ** 30;
const TOTAL = 32 * GIB;

export function startNumbers(scenario: string): Numbers {
  const disk = (r: number, w: number): HostDisk => ({ name: 'nvme0n1', r_iops: r, w_iops: w, r_bps: r * 4096, w_bps: w * 4096 });
  switch (scenario) {
    case 'hot':
      return { cpu: 93.4, mem: 82.5, updates: 12, disks: [disk(40, 900)] };
    case 'noupdates':
      return { cpu: 12.4, mem: 41.3, updates: null, disks: [disk(12, 240)] };
    case 'busy':
      return { cpu: 61.2, mem: 55, updates: 0, disks: [disk(6000, 6000)] };
    default:
      return { cpu: 12.4, mem: 41.3, updates: 3, disks: [disk(12, 240)] };
  }
}

export class HostSim {
  private nums: Numbers;
  private watching = false;
  private timers: unknown[] = [];
  private readonly log = { watch: 0, unwatch: 0, stats: 0, disk: 0 };

  constructor(
    scenario: string,
    private readonly on: boolean,
    private readonly everyMs: number,
    private readonly later: (fn: () => void, ms: number) => unknown,
    private readonly cancel: (h: unknown) => void,
    private readonly now: () => number,
    private readonly error: (code: string, message: string) => Error,
  ) {
    this.nums = startNumbers(scenario);
  }

  dispose(): void {
    this.stop();
  }

  handle(t: unknown, a: Obj, send: Send, ack: (data?: unknown) => void): boolean {
    if (t === 'sim.host') {
      const n = this.nums;
      if (a.cpu !== undefined) n.cpu = a.cpu === null ? null : Number(a.cpu);
      if (typeof a.mem === 'number') n.mem = a.mem;
      if (a.updates !== undefined) n.updates = a.updates === null ? null : Number(a.updates);
      if (Array.isArray(a.disks)) n.disks = (a.disks as Obj[]).map((d) => ({ name: String(d.name ?? 'nvme0n1'), r_iops: Number(d.r_iops ?? 0), w_iops: Number(d.w_iops ?? 0), r_bps: Number(d.r_bps ?? 0), w_bps: Number(d.w_bps ?? 0) }));
      ack();
      return true;
    }
    if (t === 'sim.host_log') {
      ack({ ...this.log, watching: this.watching });
      return true;
    }
    if (t !== 'host.watch' && t !== 'host.unwatch') return false;
    if (!this.on) throw this.error('unknown_command', `unknown command: "${String(t)}"`);
    if (t === 'host.unwatch') {
      this.log.unwatch++;
      this.stop();
      ack();
      return true;
    }
    this.log.watch++;
    if (!this.watching) {
      this.watching = true;
      this.timers.push(this.later(() => this.statsAndSchedule(send), this.everyMs / 5));
      this.timers.push(this.later(() => this.diskTick(send), this.everyMs / 5));
    }
    ack();
    return true;
  }

  private stop(): void {
    this.watching = false;
    for (const h of this.timers) this.cancel(h);
    this.timers = [];
  }

  private statsAndSchedule(send: Send): void {
    if (!this.watching) return;
    this.stats(send);
    this.timers.push(this.later(() => this.statsAndSchedule(send), this.everyMs));
  }

  private stats(send: Send): void {
    const n = this.nums;
    this.log.stats++;
    send({
      t: 'host.stats',
      cpu_pct: n.cpu,
      cpus: 12,
      load1: 0.82,
      mem_used_pct: n.mem,
      mem_used_bytes: Math.round((TOTAL * n.mem) / 100),
      mem_total_bytes: TOTAL,
      sampled_at: new Date(this.now()).toISOString().replace(/\.\d+Z$/, 'Z'),
      ...(n.updates === null ? {} : { updates: { count: n.updates, checked_at: new Date(this.now() - 31 * 60_000).toISOString().replace(/\.\d+Z$/, 'Z') } }),
    });
  }

  private diskTick(send: Send): void {
    if (!this.watching) return;
    this.log.disk++;
    send({ t: 'host.disk', disks: this.nums.disks });
    this.timers.push(this.later(() => this.diskTick(send), this.everyMs / 5));
  }
}
