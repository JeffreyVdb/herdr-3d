import { describe, expect, it, vi } from 'vitest';
import { isWorldEvent, parseMessage, type ServerMessage, type Snapshot } from '../net/protocol';
import { activityFailureText, activityStateOf, ActivitySettingsBook } from './activitySettings';
import { WorldStore } from './store';

const state = (over: Record<string, unknown> = {}) => ({
  model_enabled: false,
  threshold: 0.6,
  margin: 0.2,
  daily_cap: 2000,
  calls_today: 0,
  cache_size: 0,
  state: 'off',
  classifier: 'off',
  env: [],
  ...over,
});
const snap = (activity?: unknown): Snapshot => ({
  t: 'world.snapshot',
  seq: 10,
  world: { buildings: [], unassigned: [], floors: [], workers: [], ...(activity === undefined ? {} : { activity: activity as never }) },
});

describe('activity settings (#98 “Classify unknown commands”)', () => {
  it('reads a well-formed state and drops what it does not know', () => {
    expect(activityStateOf(state({ state: 'capped', classifier: 'ready', calls_today: 2000.7, cache_size: -3, env: ['model_enabled', 7], extra: 1 }))).toEqual({
      model_enabled: false,
      threshold: 0.6,
      margin: 0.2,
      daily_cap: 2000,
      calls_today: 2000,
      cache_size: 0,
      state: 'capped',
      classifier: 'ready',
      env: ['model_enabled'],
    });
    // An unknown role state reads as off; a bad feature state, a missing switch or number is no state at all.
    expect(activityStateOf(state({ classifier: 'weird' }))?.classifier).toBe('off');
    expect(activityStateOf(state({ state: 'running' }))).toBeNull();
    expect(activityStateOf(state({ model_enabled: 'yes' }))).toBeNull();
    expect(activityStateOf(state({ margin: undefined }))).toBeNull();
    expect(activityStateOf(null)).toBeNull();
  });

  it('the book is unknown without a state, known with one, and tells its listeners', () => {
    const b = new ActivitySettingsBook();
    const fn = vi.fn();
    b.onChange(fn);
    b.reset(undefined);
    expect(b.known).toBe(false);
    expect(b.state).toBeNull();
    expect(b.upsert({ t: 'activity.update', seq: 3, ...state({ model_enabled: true, state: 'incomplete' }) })).toBe(true);
    expect(b.known).toBe(true);
    expect(b.state).toMatchObject({ model_enabled: true, state: 'incomplete' });
    // A malformed update changes nothing.
    expect(b.upsert({ t: 'activity.update' })).toBe(false);
    expect(b.state?.state).toBe('incomplete');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('the store keeps it from the snapshot and activity.update; a bridge without it sends none', () => {
    const s = new WorldStore(0);
    s.applySnapshot(snap());
    expect(s.activitySettings.known).toBe(false);
    s.applySnapshot(snap(state()));
    expect(s.activitySettings.state?.state).toBe('off');
    const m = parseMessage(JSON.stringify({ t: 'activity.update', seq: 11, ...state({ model_enabled: true, state: 'ready', classifier: 'ready', calls_today: 12, cache_size: 40 }) })) as ServerMessage;
    expect(isWorldEvent(m)).toBe(true);
    s.applyEvent(m as never);
    expect(s.activitySettings.state).toMatchObject({ model_enabled: true, state: 'ready', calls_today: 12, cache_size: 40 });
    expect(isWorldEvent({ t: 'activity.update', seq: 12, state: 'ready' } as unknown as ServerMessage)).toBe(false);
  });

  it('says what went wrong in plain words', () => {
    expect(activityFailureText('env_locked', 'model_enabled is set by the environment')).toContain('HERDR_WORLD_ACTIVITY_MODEL');
    expect(activityFailureText('bad_request', 'bad args: threshold must be in [0.05, 0.99]')).toBe('Not accepted: threshold must be in [0.05, 0.99]');
    expect(activityFailureText('unknown_command', '')).toContain('Update it');
    expect(activityFailureText('internal', 'the store is read-only')).toBe('The store is read-only');
  });
});
