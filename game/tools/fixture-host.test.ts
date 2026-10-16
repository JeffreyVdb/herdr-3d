import { describe, expect, it } from 'vitest';
import { loadFixture } from './fixture-server';
import { HostSim, startNumbers } from './fixture-host';
import { SimWorld } from './fixture-sim';

type Msg = Record<string, unknown>;

/** A HostSim on a fake clock: `advance(ms)` runs what is due, in order. */
function rig(scenario = 'ok', on = true) {
  let now = Date.parse('2026-10-16T12:00:00Z');
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sim = new HostSim(
    scenario,
    on,
    5000,
    (fn, ms) => {
      timers.set(++id, { at: now + ms, fn });
      return id;
    },
    (h) => timers.delete(h as number),
    () => now,
    (code, message) => Object.assign(new Error(message), { code }),
  );
  const out: Msg[] = [];
  const acks: unknown[] = [];
  const cmd = (t: string, a: Msg = {}) => sim.handle(t, a, (m) => out.push(m), (d) => acks.push(d));
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
  const of = (t: string) => out.filter((m) => m.t === t);
  return { sim, cmd, advance, of, out, acks, timers };
}

describe('HostSim', () => {
  it('sends host.stats after 1 s and then every 5 s, and host.disk every second, only while watched', () => {
    const r = rig();
    r.advance(60_000);
    expect(r.out).toEqual([]); // nobody watches
    expect(r.cmd('host.watch')).toBe(true);
    r.advance(999);
    expect(r.out).toEqual([]);
    r.advance(1);
    expect(r.of('host.stats')).toHaveLength(1);
    expect(r.of('host.disk')).toHaveLength(1);
    r.advance(5000);
    expect(r.of('host.stats')).toHaveLength(2);
    expect(r.of('host.disk')).toHaveLength(6);
    expect(r.of('host.stats')[0]).toMatchObject({ t: 'host.stats', cpu_pct: 12.4, cpus: 12, mem_used_pct: 41.3, mem_total_bytes: 32 * 2 ** 30, sampled_at: '2026-10-16T12:01:01Z', updates: { count: 3 } });
    expect(r.of('host.disk')[0]).toMatchObject({ disks: [{ name: 'nvme0n1', r_iops: 12, w_iops: 240 }] });
    expect(r.out.every((m) => !('seq' in m))).toBe(true);
    r.cmd('host.unwatch');
    const n = r.out.length;
    r.advance(60_000);
    expect(r.out).toHaveLength(n);
    expect(r.timers.size).toBe(0);
  });

  it('is idempotent: a second host.watch is not a second stream, an unwatch of nothing is fine', () => {
    const r = rig();
    r.cmd('host.watch');
    r.cmd('host.watch');
    r.advance(1000);
    expect(r.of('host.stats')).toHaveLength(1);
    r.cmd('host.unwatch');
    r.cmd('host.unwatch');
    r.cmd('host.watch');
    r.advance(1000);
    expect(r.of('host.stats')).toHaveLength(2);
    r.cmd('sim.host_log');
    expect(r.acks.at(-1)).toMatchObject({ watch: 3, unwatch: 2, stats: 2, watching: true });
  });

  it('plays the numbers sim.host sets, with no updates field when it says null', () => {
    const r = rig();
    r.cmd('host.watch');
    r.cmd('sim.host', { cpu: 97, mem: 91, updates: null, disks: [{ name: 'sda', r_iops: 1, w_iops: 2 }, { name: 'sdb' }] });
    r.advance(1000);
    const s = r.of('host.stats')[0] as Msg;
    expect(s).toMatchObject({ cpu_pct: 97, mem_used_pct: 91 });
    expect('updates' in s).toBe(false);
    expect((r.of('host.disk')[0] as { disks: Array<{ name: string }> }).disks.map((d) => d.name)).toEqual(['sda', 'sdb']);
    r.cmd('sim.host', { cpu: null, updates: 0 });
    r.advance(5000);
    expect(r.of('host.stats')[1]).toMatchObject({ cpu_pct: null, updates: { count: 0 } });
  });

  it('plays a bridge before the command: unknown_command', () => {
    const r = rig('ok', false);
    expect(() => r.cmd('host.watch')).toThrow(/unknown command/);
    expect(() => r.cmd('host.unwatch')).toThrow(/unknown command/);
    expect(r.cmd('foo.bar')).toBe(false);
  });

  it('has scenarios, and stops on dispose', () => {
    expect(startNumbers('hot').cpu).toBeGreaterThan(90);
    expect(startNumbers('noupdates').updates).toBeNull();
    expect(startNumbers('busy').disks[0]?.r_iops).toBeGreaterThan(5000);
    const r = rig();
    r.cmd('host.watch');
    r.sim.dispose();
    r.advance(10_000);
    expect(r.out).toEqual([]);
  });
});

describe('the simulated world', () => {
  it('answers host.watch on a connection and keeps its frames to it', () => {
    const { snapshot } = loadFixture('demo-m4');
    let now = 0;
    let id = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const world = new SimWorld(snapshot as never, {
      now: () => now,
      setTimeout: (fn, ms) => {
        timers.set(++id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (h) => timers.delete(h as number),
    });
    const out: Msg[] = [];
    world.handle({ t: 'host.watch', req_id: 'a' }, (m) => out.push(m));
    expect(out).toEqual([{ t: 'ack', req_id: 'a' }]);
    now = 1000;
    for (const [k, t] of [...timers]) if (t.at <= now) (timers.delete(k), t.fn());
    expect(out.map((m) => m.t)).toEqual(['ack', 'host.stats', 'host.disk']);
    world.handle({ t: 'host.unwatch', req_id: 'b' }, (m) => out.push(m));
    expect(out.at(-1)).toEqual({ t: 'ack', req_id: 'b' });
    world.dispose();
  });
});
