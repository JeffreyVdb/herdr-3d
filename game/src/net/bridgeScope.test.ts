// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Drafts } from '../ui/drafts';
import { HireModelPrefs } from '../ui/hireModelPrefs';
import { OverviewPrefs } from '../ui/overviewPrefs';
import { keepDraft } from '../whiteboard/draft';
import { bridgeKey, migrateBridgeKeys, MIGRATED_KEY, setBridgeScope } from './bridgeScope';

afterEach(() => {
  setBridgeScope(null);
  localStorage.clear();
});

describe('per-bridge browser state (#57)', () => {
  it('scopes the per-bridge keys by the bridge in use, and leaves them as they were without one', () => {
    expect(bridgeKey('h3d.seat.terminal')).toBe('h3d.seat.terminal');
    setBridgeScope('aaaaaaaaaa');
    expect(bridgeKey('h3d.seat.terminal')).toBe('h3d.b.aaaaaaaaaa.seat.terminal');
    expect(bridgeKey('h3d.draft.')).toBe('h3d.b.aaaaaaaaaa.draft.');
    expect(bridgeKey('h3d.draft.', 'bbbbbbbbbb')).toBe('h3d.b.bbbbbbbbbb.draft.');
    setBridgeScope('../x');
    expect(bridgeKey('h3d.seat.terminal')).toBe('h3d.seat.terminal');
  });

  it('keeps drafts, overview, hidden models and task levels apart per bridge, and brings them back on the way back', () => {
    const write = () => {
      new Drafts('hire').set('herdr-3d:4', { text: 'fix the bug' });
      new OverviewPrefs().setCollapsed('orch-1', true);
      new HireModelPrefs().setShown('claude', 'claude-haiku-5-5', false);
      keepDraft('ws://x/ws|herdr-3d', { v: 1, at: 1, elements: [], files: [], appState: null });
    };
    setBridgeScope('aaaaaaaaaa');
    write();
    expect(Object.keys(localStorage).sort()).toEqual([
      'h3d.b.aaaaaaaaaa.draft.hire.herdr-3d:4',
      'h3d.b.aaaaaaaaaa.hire.hiddenModels',
      'h3d.b.aaaaaaaaaa.overview.collapsed',
      'h3d.b.aaaaaaaaaa.wb.draft.ws://x/ws|herdr-3d',
    ]);

    // Another bridge (a new page load: new stores) sees none of it.
    setBridgeScope('bbbbbbbbbb');
    expect(new Drafts('hire').get('herdr-3d:4')).toBeNull();
    expect(new OverviewPrefs().collapsed('orch-1')).toBe(false);
    expect(new HireModelPrefs().isShown('claude', 'claude-haiku-5-5')).toBe(true);

    // Back on A: all of it.
    setBridgeScope('aaaaaaaaaa');
    expect(new Drafts('hire').get('herdr-3d:4')?.text).toBe('fix the bug');
    expect(new OverviewPrefs().collapsed('orch-1')).toBe(true);
    expect(new HireModelPrefs().isShown('claude', 'claude-haiku-5-5')).toBe(false);
  });

  it('moves the keys kept before #57 into the first bridge’s namespace, once, leaving client preferences shared', () => {
    localStorage.setItem('h3d.token', 'secret');
    localStorage.setItem('h3d.audio.volume', '0.4');
    localStorage.setItem('h3d.seat.terminal', '["w1"]');
    localStorage.setItem('h3d.seat.images', '["w2"]');
    localStorage.setItem('h3d.overview.collapsed', '["o1"]');
    localStorage.setItem('h3d.overview.filter.city', 'all');
    localStorage.setItem('h3d.hire.hiddenModels', '{"claude":["x"]}');
    localStorage.setItem('h3d.hire.taskLevels', '{"v":2,"levels":[]}');
    localStorage.setItem('h3d.hire.goto', 'false');
    localStorage.setItem('h3d.draft.hire.herdr-3d:4', '{"v":1}');
    localStorage.setItem('h3d.wb.draft.ws://x|f', '{}');
    expect(migrateBridgeKeys(localStorage, 'aaaaaaaaaa')).toBe(7);
    expect(Object.keys(localStorage).sort()).toEqual(
      [
        'h3d.audio.volume',
        'h3d.b.aaaaaaaaaa.draft.hire.herdr-3d:4',
        'h3d.b.aaaaaaaaaa.hire.hiddenModels',
        'h3d.b.aaaaaaaaaa.hire.taskLevels',
        'h3d.b.aaaaaaaaaa.overview.collapsed',
        'h3d.b.aaaaaaaaaa.seat.images',
        'h3d.b.aaaaaaaaaa.seat.terminal',
        'h3d.b.aaaaaaaaaa.wb.draft.ws://x|f',
        MIGRATED_KEY,
        'h3d.hire.goto',
        'h3d.overview.filter.city',
        'h3d.token',
      ].sort(),
    );
    expect(localStorage.getItem('h3d.b.aaaaaaaaaa.seat.terminal')).toBe('["w1"]');
    // Once: a later unscoped key (a page no helper served) stays where it is.
    localStorage.setItem('h3d.seat.terminal', '["w9"]');
    expect(migrateBridgeKeys(localStorage, 'bbbbbbbbbb')).toBe(0);
    expect(localStorage.getItem('h3d.seat.terminal')).toBe('["w9"]');
    expect(localStorage.getItem('h3d.b.bbbbbbbbbb.seat.terminal')).toBeNull();
  });

  it('never overwrites a key already in the namespace', () => {
    localStorage.setItem('h3d.seat.terminal', '["old"]');
    localStorage.setItem('h3d.b.aaaaaaaaaa.seat.terminal', '["new"]');
    migrateBridgeKeys(localStorage, 'aaaaaaaaaa');
    expect(localStorage.getItem('h3d.b.aaaaaaaaaa.seat.terminal')).toBe('["new"]');
    expect(localStorage.getItem('h3d.seat.terminal')).toBeNull();
  });
});
