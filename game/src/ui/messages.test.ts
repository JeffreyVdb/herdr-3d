import { describe, expect, it } from 'vitest';
import { failureText } from './messages';

describe('failureText', () => {
  it('names the floor and the recovery for wake/sleep failures', () => {
    expect(failureText('floor.wake', 'busy', 'x', { floor: 'pastry' })).toBe('pastry is already waking up or going to sleep. Try again once it is done.');
    expect(failureText('floor.wake', 'invalid_state', 'running', { floor: 'pastry' })).toBe('pastry is already awake.');
    expect(failureText('floor.sleep', 'invalid_state', 'asleep', { floor: 'pastry' })).toBe('pastry is already asleep.');
    expect(failureText('floor.wake', 'wake_failed', 'no answer to ping within 10s', { floor: 'pastry' })).toBe('pastry did not wake up: no answer to ping within 10s.');
    expect(failureText('floor.sleep', 'sleep_failed', '', { floor: 'pastry' })).toBe('pastry did not go to sleep: herdr session stop failed.');
  });

  it('tells an older bridge apart from a read-only one', () => {
    expect(failureText('floor.wake', 'unknown_command', 'unknown command "floor.wake"')).toBe('This herdr-world can’t wake floors yet. Update the bridge to use it.');
    expect(failureText('building.create', 'unknown_command', 'the fixture server is read-only')).toBe(
      'This herdr-world can’t create buildings yet (the fixture server is read-only). Update the bridge to use it.',
    );
  });

  it('covers connection trouble and the M1 codes', () => {
    expect(failureText('building.create', 'name_taken', 'name already used', { name: 'Work' })).toBe('Another building is already called “Work”. Pick another name.');
    expect(failureText('floor.assign', 'unknown_session', '', { floor: 'gone' })).toMatch(/does not know gone/);
    expect(failureText('building.rename', 'timeout', '')).toMatch(/check before you retry/);
    expect(failureText('building.rename', 'offline', '')).toMatch(/nothing was sent/);
    expect(failureText('building.rename', 'weird', 'boom')).toBe('weird: boom');
  });

  it('explains the M4 hire and send-home refusals', () => {
    expect(failureText('worker.hire', 'desk_taken', 'desk 4 is occupied', { desk: 5 })).toBe('Desk 5 is taken or gone (desk 4 is occupied). Pick another free desk.');
    expect(failureText('worker.hire', 'capacity', 'pastry has 32 workers (hard cap 32)')).toBe('Over the hard cap: pastry has 32 workers (hard cap 32). Send someone home first.');
    expect(failureText('hire.prepare', 'invalid_state', 'asleep', { floor: 'depot-manager' })).toBe('depot-manager is asleep. Wake it from the elevator (L) first.');
    expect(failureText('worker.hire', 'hire_failed', 'agent start: timeout')).toBe('The hire did not go through: agent start: timeout.');
    expect(failureText('worker.fire', 'not_clean', '2 uncommitted changes')).toBe('The worktree was kept: 2 uncommitted changes.');
    expect(failureText('worker.fire', 'busy', '', { worker: 'Pixel' })).toBe('Pixel is still being hired or already on the way out.');
    expect(failureText('worker.fire.prepare', 'unknown_worker', '', { worker: 'Pixel' })).toBe('Pixel is no longer on the floor.');
    expect(failureText('worker.fire', 'fire_failed', 'no exit', { worker: 'Pixel' })).toBe('Pixel could not be sent home: no exit.');
    expect(failureText('worker.hire', 'unknown_command', 'unknown command')).toBe('This herdr-world can’t hire workers yet. Update the bridge to use it.');
  });
});
