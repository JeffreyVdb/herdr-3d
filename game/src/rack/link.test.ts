import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { HostDiskRate, HostStats } from '../net/protocol';
import type { RackMode } from '../world/hostStats';
import { DISK_LIVE_MS, RackLink, type RackOffice } from './link';

const frame = (n = 1): HostStats => ({ t: 'host.stats', cpu_pct: 10 + n, cpus: 8, load1: 0.5, mem_used_pct: 40, mem_used_bytes: 4e9, mem_total_bytes: 1e10, sampled_at: '2026-10-16T12:00:05Z' });
const disks = (iops: number): HostDiskRate[] => [{ name: 'nvme0n1', r_iops: iops, w_iops: 0, r_bps: 0, w_bps: 0 }];

function rig() {
  let now = 1000;
  let inView = false;
  let unsupported = false;
  const sent: string[] = [];
  const hud: string[] = [];
  const answer: { next: CommandResult } = { next: { ok: true, data: undefined } };
  const screens: Array<{ mode: RackMode; frame: HostStats | null }> = [];
  const diskCalls: Array<readonly HostDiskRate[] | null> = [];
  const motion: boolean[] = [];
  const mkOffice = (): RackOffice => ({
    tickRack: () => inView,
    setRackDisks: (d) => void diskCalls.push(d),
    setRackScreen: (mode, f) => void screens.push({ mode, frame: f }),
    setRackMotion: (on) => void motion.push(on),
  });
  const link = new RackLink({
    request: async (t) => {
      sent.push(t);
      return answer.next;
    },
    hudInfo: (l) => void hud.push(l),
    unsupported: () => unsupported,
    markUnsupported: () => {
      unsupported = true;
    },
    now: () => now,
  });
  let office: RackOffice | null = mkOffice();
  const camera = {} as never;
  const step = (o: Partial<{ here: boolean; live: boolean; calm: boolean }> = {}) => link.step({ office, here: true, live: true, calm: false, camera, ...o });
  return {
    link, sent, hud, screens, diskCalls, motion, answer,
    look: (v: boolean) => void (inView = v),
    advance: (ms: number, o: Parameters<typeof step>[0] = {}) => {
      now += ms;
      step(o);
    },
    step,
    newOffice: () => void (office = mkOffice()),
    tick: () => now,
  };
}

describe('RackLink', () => {
  it('asks the bridge to sample only after 300 ms of looking, and stops 10 s after looking away', async () => {
    const r = rig();
    r.step();
    expect(r.sent).toEqual([]);
    r.look(true);
    r.advance(100);
    r.advance(200);
    expect(r.sent).toEqual([]);
    r.advance(100); // 300 ms of it
    expect(r.sent).toEqual(['host.watch']);
    r.advance(1000);
    expect(r.sent).toEqual(['host.watch']); // once
    r.look(false);
    r.advance(0);
    r.advance(9000);
    expect(r.sent).toEqual(['host.watch']);
    r.advance(1100);
    expect(r.sent).toEqual(['host.watch', 'host.unwatch']);
    expect(r.link.info().watching).toBe(false);
  });

  it('ends the watch at once on a hidden tab, another floor, leaving the floor and a lost bridge', () => {
    const r = rig();
    r.look(true);
    const watch = () => {
      r.advance(0);
      r.advance(300);
    };
    watch();
    expect(r.sent).toEqual(['host.watch']);
    r.link.hidden();
    expect(r.sent).toEqual(['host.watch', 'host.unwatch']);
    r.advance(1000);
    r.advance(300);
    expect(r.sent.at(-1)).toBe('host.watch');
    // Another floor: a new office.
    r.newOffice();
    r.advance(10);
    expect(r.sent.slice(-2)).toEqual(['host.watch', 'host.unwatch']);
    r.advance(400);
    r.advance(300);
    expect(r.sent.at(-1)).toBe('host.watch');
    // Out of the floor (the lobby, the plan view): at once, though the rack is still in view.
    r.advance(10, { here: false });
    expect(r.sent.at(-1)).toBe('host.unwatch');
    r.advance(400);
    r.advance(300);
    expect(r.sent.at(-1)).toBe('host.watch');
    // A dropped bridge, a hidden tab: no command, and a live one watches again.
    const n = r.sent.length;
    r.link.connLost();
    r.advance(10, { live: false });
    expect(r.sent).toHaveLength(n);
    r.advance(400);
    r.advance(300);
    expect(r.sent.at(-1)).toBe('host.watch');
  });

  it('shows the idle screen on a bridge that does not know host.watch, and never asks again', async () => {
    const r = rig();
    r.answer.next = { ok: false, code: 'unknown_command', message: 'unknown command "host.watch"' };
    r.look(true);
    r.advance(0);
    r.advance(300);
    await Promise.resolve();
    await Promise.resolve();
    r.advance(1000);
    expect(r.link.info().mode).toBe('unsupported');
    expect(r.screens.at(-1)?.mode).toBe('unsupported');
    expect(r.hud.at(-1)).toBe('No host stats on this bridge');
    r.advance(5000);
    r.advance(5000);
    expect(r.sent).toEqual(['host.watch']);
  });

  it('redraws the screen once per host.stats frame, and shows the last one dimmed when nobody watches', () => {
    const r = rig();
    r.look(true);
    r.advance(0);
    r.advance(300);
    expect(r.screens.at(-1)?.mode).toBe('waiting');
    const draws = () => r.screens.length;
    r.link.onMessage(frame(1));
    r.advance(16);
    expect(r.screens.at(-1)).toMatchObject({ mode: 'live', frame: { cpu_pct: 11 } });
    const n = draws();
    for (let i = 0; i < 60; i++) r.advance(16); // a second of frames with nothing new
    expect(draws()).toBe(n);
    r.link.onMessage(frame(2));
    r.advance(16);
    r.link.onMessage(frame(3));
    r.advance(16);
    expect(draws()).toBe(n + 2);
    expect(r.hud.at(-1)).toBe('CPU 13% · Mem 40%');
    // Looking away for 10 s: unwatched, the last frame stays, dimmed.
    r.look(false);
    r.advance(0);
    r.advance(11_000);
    expect(r.screens.at(-1)).toMatchObject({ mode: 'dim', frame: { cpu_pct: 13 } });
  });

  it('draws a frame that was old when the watch began as stale until the next one comes', () => {
    const r = rig();
    r.look(true);
    r.advance(0);
    r.advance(300);
    r.link.onMessage(frame(1));
    r.advance(16);
    r.look(false);
    r.advance(0);
    r.advance(11_000); // unwatched
    r.advance(40_000); // the frame is 51 s old
    r.look(true);
    r.advance(0);
    r.advance(300); // watching again
    expect(r.screens.at(-1)?.mode).toBe('stale');
    expect(r.link.info().stale).toBe(true);
    r.link.onMessage(frame(2));
    r.advance(16);
    expect(r.screens.at(-1)?.mode).toBe('live');
  });

  it('keeps a frame that is not old live when it looks again', () => {
    const r = rig();
    r.look(true);
    r.advance(0);
    r.advance(300);
    r.link.onMessage(frame(1));
    r.advance(16);
    r.look(false);
    r.advance(0);
    r.advance(11_000);
    r.advance(5000);
    r.look(true);
    r.advance(0);
    r.advance(300);
    expect(r.screens.at(-1)?.mode).toBe('live');
  });

  it('writes the LED rates once per host.disk frame, and falls back to the calm blink without live data', () => {
    const r = rig();
    r.look(true);
    r.advance(0);
    r.advance(300);
    expect(r.diskCalls).toEqual([]); // nothing to write yet
    r.link.onMessage({ t: 'host.disk', disks: disks(100) });
    r.advance(16);
    expect(r.diskCalls).toHaveLength(1);
    expect(r.diskCalls[0]?.[0]?.r_iops).toBe(100);
    for (let i = 0; i < 30; i++) r.advance(16);
    expect(r.diskCalls).toHaveLength(1); // frames of the game are not writes
    r.link.onMessage({ t: 'host.disk', disks: disks(5000) });
    r.advance(16);
    expect(r.diskCalls).toHaveLength(2);
    // The frames stop: calm after DISK_LIVE_MS.
    r.advance(DISK_LIVE_MS + 100);
    expect(r.diskCalls.at(-1)).toBeNull();
    // Unwatched: calm too, whatever came last.
    r.link.onMessage({ t: 'host.disk', disks: disks(7) });
    r.advance(16);
    expect(r.diskCalls.at(-1)?.[0]?.r_iops).toBe(7);
    r.look(false);
    r.advance(0);
    r.advance(11_000);
    expect(r.diskCalls.at(-1)).toBeNull();
  });

  it('tells the rack about battery saver and reduced motion', () => {
    const r = rig();
    r.step({ calm: false });
    r.step({ calm: true });
    r.step({ calm: true });
    expect(r.motion).toEqual([true, false]);
  });
});
