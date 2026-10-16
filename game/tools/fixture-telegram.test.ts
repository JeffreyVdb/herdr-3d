import { describe, expect, it } from 'vitest';
import type { Snapshot, WorldEvent } from '../src/net/protocol';
import { WorldStore } from '../src/world/store';
import { loadFixture } from './fixture-server';
import { SimWorld, type SimOptions } from './fixture-sim';
import { SIM_CODE } from './fixture-telegram';

type Msg = Record<string, unknown>;

/** A sim on demo-m4, manual timers. */
function rig(o: Partial<SimOptions> = {}) {
  const timers: Array<() => void> = [];
  const { snapshot } = loadFixture('demo-m4');
  const sim = new SimWorld(snapshot as never, { setTimeout: (fn) => timers.push(fn), clearTimeout: () => {}, ...o });
  const store = new WorldStore(0);
  store.applySnapshot(sim.snapshot() as unknown as Snapshot);
  const out: Msg[] = [];
  let n = 0;
  const send = (m: Msg) => {
    out.push(m);
    if (typeof m.seq === 'number') store.applyEvent(m as unknown as WorldEvent);
  };
  const cmd = (t: string, args: unknown) => {
    const req_id = `r${++n}`;
    const from = out.length;
    sim.handle({ t, req_id, args }, send);
    const got = () => out.slice(from);
    return { ack: () => got().find((m) => m.t === 'ack' && m.req_id === req_id) as Msg | undefined, err: () => got().find((m) => m.t === 'error' && m.req_id === req_id) as Msg | undefined };
  };
  const settle = () => {
    while (timers.length) (timers.shift() as () => void)();
  };
  return { sim, store, cmd, settle, out };
}

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

describe('the simulated Telegram notifications (#11)', () => {
  it('walks token, pairing, test and switch in order, and never sends the token back', () => {
    const r = rig();
    expect(r.store.notifySettings.state).toMatchObject({ enabled: false, state: 'off', missing: ['token', 'recipient'], channel: { key_set: false } });
    expect(r.cmd('notify.set', { enabled: true }).err()?.code).toBe('not_configured');
    expect(r.cmd('notify.token.set', { key: 'nope' }).err()?.code).toBe('bad_request');
    expect(r.cmd('notify.token.set', { key: '123:bad0000000000000000000000' }).err()?.code).toBe('unauthorized');
    expect(r.cmd('notify.token.set', { key: TOKEN }).ack()).toBeTruthy();
    expect(JSON.stringify(r.out)).not.toContain('AAHdq');
    expect(r.store.notifySettings.state?.channel).toMatchObject({ key_set: true, key_hint: 'Dsaw', bot: 'herdr3d_bot' });
    expect(r.cmd('notify.test', {}).err()?.code).toBe('not_paired');
    expect(r.cmd('notify.pair.start', {}).ack()).toBeTruthy();
    expect(r.store.notifySettings.state?.channel.pairing).toMatchObject({ state: 'waiting', code: SIM_CODE });
    r.cmd('sim.telegram', { pair: true });
    expect(r.store.notifySettings.state?.channel).toMatchObject({ paired: { name: 'Ada' } });
    expect(r.store.notifySettings.state?.channel.pairing).toBeUndefined();
    expect(r.cmd('notify.set', { enabled: true }).err()?.code).toBe('test_required');
    expect(r.cmd('notify.test', {}).ack()?.data).toEqual({ ok: true, latency_ms: 240 });
    expect(r.cmd('notify.set', { enabled: true, quiet: true, events: { done: false } }).ack()).toBeTruthy();
    expect(r.store.notifySettings.state).toMatchObject({ enabled: true, state: 'ready', tested: true, quiet: true, events: { needs_you: true, done: false } });
  });

  it('pairs by itself after simtelegrampair, expires, conflicts and blocks', () => {
    const r = rig({ telegram: 'token', telegramPairMs: 500 });
    r.cmd('notify.pair.start', {});
    r.settle();
    expect(r.store.notifySettings.state?.channel.paired?.name).toBe('Ada');
    r.cmd('notify.pair.start', {});
    r.cmd('sim.telegram', { conflict: true });
    expect(r.store.notifySettings.state?.channel.pairing?.state).toBe('conflict');
    r.cmd('sim.telegram', { expire: true });
    expect(r.store.notifySettings.state?.channel.pairing).toMatchObject({ state: 'expired' });
    r.settle(); // a stale timer pairs nothing
    expect(r.store.notifySettings.state?.channel.pairing?.state).toBe('expired');
    r.cmd('sim.telegram', { blocked: true });
    expect(r.cmd('notify.test', {}).err()?.code).toBe('blocked');
    expect(r.store.notifySettings.state?.last_error?.code).toBe('blocked');
  });

  it('forgets the last delivery error once the channel changes (pair, cancel, unpair), like the bridge (#12)', () => {
    const r = rig({ telegram: 'on' });
    const blockTest = () => {
      r.cmd('sim.telegram', { blocked: true });
      expect(r.cmd('notify.test', {}).err()?.code).toBe('blocked');
      expect(r.store.notifySettings.state).toMatchObject({ state: 'blocked', last_error: { code: 'blocked' } });
      r.cmd('sim.telegram', { blocked: false });
    };
    blockTest();
    r.cmd('notify.pair.start', {});
    expect(r.store.notifySettings.state?.last_error).toBeUndefined();
    blockTest();
    r.cmd('notify.pair.cancel', {});
    expect(r.store.notifySettings.state?.last_error).toBeUndefined();
    blockTest();
    expect(r.cmd('notify.unpair', {}).ack()).toBeTruthy();
    expect(r.store.notifySettings.state).toMatchObject({ state: 'incomplete', missing: ['recipient'] });
    expect(r.store.notifySettings.state?.last_error).toBeUndefined();
    expect(r.store.notifySettings.state?.channel.paired).toBeUndefined();
  });

  it('env: the switch and the token are the environment’s', () => {
    const r = rig({ telegram: 'env' });
    expect(r.store.notifySettings.state).toMatchObject({ enabled: true, env: ['enabled', 'token'], channel: { key_env: true } });
    expect(r.cmd('notify.set', { enabled: false }).err()?.code).toBe('env_locked');
    expect(r.cmd('notify.token.clear', {}).err()?.code).toBe('env_locked');
  });

  it('old: no notify, and the commands are unknown', () => {
    const r = rig({ telegram: 'old' });
    expect(r.store.notifySettings.known).toBe(false);
    expect(r.cmd('notify.get', {}).err()?.code).toBe('unknown_command');
  });
});
