import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../src/net/protocol';
import { WorldStore } from '../src/world/store';
import { ActivitySettingsSim } from './fixture-activity-settings';
import type { AiSim } from './fixture-ai';
import { loadFixture } from './fixture-server';
import { SimWorld } from './fixture-sim';

type Msg = Record<string, unknown>;

class CmdError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The settings on a stand-in AI integration whose classifier is ready or not. */
function rig(present = true) {
  const ai = { classifier: 'off', present, ready: (role: string) => role === 'classifier' && ai.classifier === 'ready', view: () => ({ classifier: { state: ai.classifier }, llm: { state: 'off' } }) };
  const out: Msg[] = [];
  let seq = 0;
  const sim = new ActivitySettingsSim({ ai: ai as unknown as AiSim, emit: (send, m) => send({ ...m, seq: ++seq }), error: (code, message) => new CmdError(code, message) });
  const send = (m: Msg) => out.push(m);
  const cmd = (t: string, a: Msg = {}) => {
    const acks: unknown[] = [];
    try {
      sim.handle(t, a, send, (d) => acks.push(d));
      return { ok: true as const, data: acks[0] as Msg };
    } catch (e) {
      return { ok: false as const, code: (e as CmdError).code, message: (e as Error).message };
    }
  };
  return { ai, sim, out, cmd };
}

describe('the simulator’s “Classify unknown commands” (#98)', () => {
  it('is off by default, incomplete without the classifier, ready with it, capped at the daily cap', () => {
    const r = rig();
    expect(r.cmd('activity.get').data).toMatchObject({ model_enabled: false, threshold: 0.6, margin: 0.2, daily_cap: 2000, state: 'off', classifier: 'off', env: [] });
    expect(r.cmd('activity.set', { model_enabled: true }).data).toMatchObject({ model_enabled: true, state: 'incomplete' });
    expect(r.out.at(-1)).toMatchObject({ t: 'activity.update', model_enabled: true, state: 'incomplete' });
    r.ai.classifier = 'ready';
    r.sim.changed((m) => r.out.push(m));
    expect(r.out.at(-1)).toMatchObject({ t: 'activity.update', state: 'ready', classifier: 'ready' });
    expect(r.cmd('sim.activity_settings', { calls_today: 2000, cache_size: 7 }).data).toMatchObject({ state: 'capped', calls_today: 2000, cache_size: 7 });
    expect(r.cmd('activity.set', { daily_cap: 5000 }).data).toMatchObject({ state: 'ready' });
    // Nothing changed: no update.
    const n = r.out.length;
    r.sim.changed((m) => r.out.push(m));
    expect(r.out.length).toBe(n);
  });

  it('checks like the bridge: ranges, unknown fields and the environment’s switch', () => {
    const r = rig();
    expect(r.cmd('activity.set', { threshold: 1.2 })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(r.cmd('activity.set', { margin: -0.1 })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(r.cmd('activity.set', { daily_cap: 12.5 })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(r.cmd('activity.set', { model_enabled: 'yes' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(r.cmd('activity.set', { classify: true })).toMatchObject({ ok: false, code: 'bad_request' });
    r.cmd('sim.activity_settings', { env: ['model_enabled'], model_enabled: true });
    expect(r.cmd('activity.set', { model_enabled: false })).toMatchObject({ ok: false, code: 'env_locked' });
    expect(r.cmd('activity.set', { threshold: 0.7 }).data).toMatchObject({ threshold: 0.7, env: ['model_enabled'], model_enabled: true });
    expect(rig(false).cmd('activity.get')).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('is in the simulating server’s snapshot, and not in one without the AI service', () => {
    const { snapshot } = loadFixture('demo-m5');
    const store = new WorldStore(0);
    store.applySnapshot(new SimWorld(snapshot as never, {}).snapshot() as unknown as Snapshot);
    expect(store.activitySettings.state).toMatchObject({ model_enabled: false, state: 'off' });
    const off = new WorldStore(0);
    off.applySnapshot(new SimWorld(snapshot as never, { ai: 'off' }).snapshot() as unknown as Snapshot);
    expect(off.activitySettings.known).toBe(false);
  });
});
