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
    expect(failureText('worker.hire', 'fetch_failed', 'fetch_failed: git fetch origin in /r: ssh: Could not resolve hostname github.com')).toBe(
      'git fetch origin failed (git fetch origin in /r: ssh: Could not resolve hostname github.com), so no worktree was made and nobody was hired. Fetch again, or hire without a worktree.',
    );
    expect(failureText('worker.hire', 'fetch_failed', '')).toBe('git fetch origin failed, so no worktree was made and nobody was hired. Fetch again, or hire without a worktree.');
    expect(failureText('worker.fire', 'not_clean', '2 uncommitted changes')).toBe('The worktree was kept: 2 uncommitted changes.');
    expect(failureText('worker.fire', 'busy', '', { worker: 'Pixel' })).toBe('Pixel is still being hired or already on the way out.');
    expect(failureText('worker.fire.prepare', 'unknown_worker', '', { worker: 'Pixel' })).toBe('Pixel is no longer on the floor.');
    expect(failureText('worker.fire', 'fire_failed', 'no exit', { worker: 'Pixel' })).toBe('Pixel could not be sent home: no exit.');
    expect(failureText('worker.hire', 'unknown_command', 'unknown command')).toBe('This herdr-world can’t hire workers yet. Update the bridge to use it.');
  });
});

describe('failureText: boards (M7)', () => {
  it('says an older bridge can’t show boards', () => {
    expect(failureText('board.watch', 'unknown_command', 'unknown command "board.watch"')).toBe('This herdr-world can’t show the issues and pull request boards yet. Update the bridge to use it.');
  });

  it('names the item and the provider, never an id', () => {
    expect(failureText('pr.merge', 'checks_not_green', 'checks are failure', { item: '#31', provider: 'GitHub' })).toBe('#31’s checks are not passing (checks are failure). Wait for them, or merge anyway.');
    expect(failureText('pr.merge', 'not_mergeable', 'the pull request has merge conflicts', { item: '#31' })).toBe('#31 is not mergeable (the pull request has merge conflicts).');
    expect(failureText('pr.merge', 'stale', '', { item: '#31' })).toMatch(/^#31 changed while you decided/);
    expect(failureText('issue.close', 'not_found', 'x', { item: '#9' })).toMatch(/^#9 is not on the board any more/);
    expect(failureText('issue.close', 'provider_failed', 'GitHub auth', { provider: 'GitHub' })).toBe('GitHub refused or failed: GitHub auth. Nothing was changed as far as herdr-world knows; try again.');
    expect(failureText('issue.comment', 'rate_limited', '', { provider: 'GitHub' })).toMatch(/^GitHub is rate limiting/);
    expect(failureText('issue.set_status', 'unsupported', 'no project', { provider: 'GitHub' })).toBe('GitHub can’t do that here (no project).');
    expect(failureText('issue.close', 'confirmation_required', '')).toMatch(/wanted a confirmation/);
  });

  it('still calls a missing building a building', () => {
    expect(failureText('building.rename', 'not_found', '')).toBe('That building no longer exists.');
  });
});
