// #98: "Classify unknown commands" (the activity settings) for the fixture server's `sim=1` (tools/fixture-sim.ts hands
// these commands over). Rules, like herdr-world's:
// - the snapshot's `activity` is the feature's state (absent with `simai=off` or `simfail=no_ai`): `off` until
//   `activity.set {model_enabled: true}`, then `incomplete` while the AI integration's classifier is not ready
//   (tools/fixture-ai.ts), `capped` once `calls_today` reaches `daily_cap`, else `ready`; every change (the AI
//   integration's too) is an `activity.update` with the state flat in it;
// - `activity.set` checks like the bridge: `bad_request` for a value out of range, `env_locked` for a field the
//   environment sets; no test gate;
// - `sim.activity_settings {env?, model_enabled?, calls_today?, cache_size?}` (the simulator's own, not a bridge
//   command) plays what the panel cannot do: the environment setting the switch, the day's calls, the cache.
// No classification runs here: the monitor's words are tools/fixture-activity.ts'.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { AiSim } from './fixture-ai.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export interface ActivitySettingsHost {
  readonly ai: AiSim;
  emit(send: Send, m: Obj): void;
  error(code: string, message: string): Error;
}

const LIMITS = { threshold: [0.05, 0.99], margin: [0, 0.99], daily_cap: [1, 1_000_000] } as const;

export class ActivitySettingsSim {
  private modelEnabled = false;
  private threshold = 0.6;
  private margin = 0.2;
  private dailyCap = 2000;
  private callsToday = 0;
  private cacheSize = 0;
  private env: string[] = [];
  private last = '';

  private readonly h: ActivitySettingsHost;

  constructor(h: ActivitySettingsHost) {
    this.h = h;
  }

  view(): Obj {
    const classifier = (this.h.ai.view() as { classifier: { state: string } }).classifier.state;
    const state = !this.modelEnabled ? 'off' : !this.h.ai.ready('classifier') ? 'incomplete' : this.callsToday >= this.dailyCap ? 'capped' : 'ready';
    return {
      model_enabled: this.modelEnabled,
      threshold: this.threshold,
      margin: this.margin,
      daily_cap: this.dailyCap,
      calls_today: this.callsToday,
      cache_size: this.cacheSize,
      state,
      classifier,
      env: [...this.env],
    };
  }

  decorate(world: Obj): void {
    if (!this.h.ai.present) return;
    world.activity = this.view();
    this.last = JSON.stringify(world.activity);
  }

  /** Emits activity.update when the state changed (also after the AI integration's). */
  changed(send: Send): void {
    const v = JSON.stringify(this.view());
    if (v === this.last) return;
    this.last = v;
    this.h.emit(send, { t: 'activity.update', ...this.view() });
  }

  private set(a: Obj): void {
    for (const k of Object.keys(a)) {
      if (!['model_enabled', 'threshold', 'margin', 'daily_cap'].includes(k)) throw this.h.error('bad_request', `bad args: unknown field "${k}"`);
      if (this.env.includes(k)) throw this.h.error('env_locked', `${k} is set by the bridge environment (HERDR_WORLD_ACTIVITY_MODEL)`);
    }
    if (a.model_enabled !== undefined && typeof a.model_enabled !== 'boolean') throw this.h.error('bad_request', 'bad args: model_enabled must be a boolean');
    for (const k of ['threshold', 'margin', 'daily_cap'] as const) {
      const v = a[k];
      if (v === undefined) continue;
      const [min, max] = LIMITS[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (k === 'daily_cap' && !Number.isInteger(v))) throw this.h.error('bad_request', `bad args: ${k} must be ${k === 'daily_cap' ? 'a whole number ' : ''}in [${min}, ${max}]`);
    }
    if (typeof a.model_enabled === 'boolean') this.modelEnabled = a.model_enabled;
    if (typeof a.threshold === 'number') this.threshold = a.threshold;
    if (typeof a.margin === 'number') this.margin = a.margin;
    if (typeof a.daily_cap === 'number') this.dailyCap = a.daily_cap;
  }

  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void): boolean {
    if (t !== 'activity.get' && t !== 'activity.set' && t !== 'sim.activity_settings') return false;
    if (!this.h.ai.present) throw this.h.error('unsupported', 'unsupported: the bridge has no AI integration');
    if (t === 'activity.set') this.set(a);
    else if (t === 'sim.activity_settings') {
      if (Array.isArray(a.env)) this.env = a.env.filter((x): x is string => typeof x === 'string');
      if (typeof a.model_enabled === 'boolean') this.modelEnabled = a.model_enabled;
      if (typeof a.calls_today === 'number') this.callsToday = Math.max(0, Math.floor(a.calls_today));
      if (typeof a.cache_size === 'number') this.cacheSize = Math.max(0, Math.floor(a.cache_size));
    }
    this.changed(send);
    ack(this.view());
    return true;
  }
}
