import { describe, expect, it, vi } from 'vitest';
import type { PingEntry } from '../world/inboxPings';
import { awayText, burstText, DesktopNotify, pingTitle, type NotificationApi, type NotifyEnv } from './desktopNotify';

interface Made {
  title: string;
  options: NotificationOptions & { renotify?: boolean };
  closed: boolean;
  click(): void;
}

function fakeEnv(o: { focused?: boolean; permission?: NotificationPermission; api?: boolean; throws?: boolean } = {}) {
  const made: Made[] = [];
  const state = { focused: o.focused ?? false, permission: o.permission ?? ('granted' as NotificationPermission) };
  class Fake {
    static get permission() {
      return state.permission;
    }
    onclick: ((ev: Event) => unknown) | null = null;
    onclose: ((ev: Event) => unknown) | null = null;
    constructor(title: string, options: NotificationOptions = {}) {
      if (o.throws) throw new TypeError("Failed to construct 'Notification': Illegal constructor.");
      const self = this;
      made.push({
        title,
        options,
        get closed() {
          return closed;
        },
        click: () => self.onclick?.(new Event('click')),
      });
      let closed = false;
      this.close = () => {
        closed = true;
        this.onclose?.(new Event('close'));
      };
    }
    close(): void {}
  }
  const focusWindow = vi.fn();
  const env: NotifyEnv = { api: () => (o.api === false ? undefined : (Fake as unknown as NotificationApi)), focused: () => state.focused, focusWindow };
  return { env, made, state, focusWindow };
}

const note = (tag = 'w1', onClick = vi.fn()) => ({ title: 'Chirp needs you', body: 'Herdr 3D › h3d · needs you', tag, onClick });

describe('DesktopNotify', () => {
  it('in the background, shows one with the worker as its tag and no renotify', () => {
    const { env, made } = fakeEnv();
    expect(new DesktopNotify(env).show(note(), true)).toBe('shown');
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ title: 'Chirp needs you', options: { body: 'Herdr 3D › h3d · needs you', tag: 'w1', renotify: false } });
  });

  it('in front, shows none and says so, whatever the setting', () => {
    const { env, made } = fakeEnv({ focused: true });
    const d = new DesktopNotify(env);
    expect(d.show(note(), true)).toBe('focused');
    expect(d.show(note(), false)).toBe('focused');
    expect(made).toEqual([]);
  });

  it('switched off, not granted, no API or a refusing constructor: none', () => {
    for (const [o, enabled] of [[{}, false], [{ permission: 'default' }, true], [{ permission: 'denied' }, true], [{ api: false }, true], [{ throws: true }, true]] as const) {
      const { env, made } = fakeEnv(o);
      expect(new DesktopNotify(env).show(note(), enabled)).toBe('off');
      expect(made).toEqual([]);
    }
  });

  it('a click focuses the window, closes it, then runs its action', () => {
    const { env, made, focusWindow } = fakeEnv();
    const go = vi.fn(() => expect(focusWindow).toHaveBeenCalled());
    new DesktopNotify(env).show(note('w1', go), true);
    made[0]?.click();
    expect(go).toHaveBeenCalledOnce();
    expect(made[0]?.closed).toBe(true);
  });

  it('closes the ones of given tags still up', () => {
    const { env, made } = fakeEnv();
    const d = new DesktopNotify(env);
    d.show(note('a'), true);
    d.show(note('b'), true);
    d.close(['a', 'zzz']);
    expect(made.map((m) => m.closed)).toEqual([true, false]);
  });
});

const e = (name: string, reason: 'blocked' | 'done'): PingEntry => ({ id: name, name, session: 's', role: null, reason, since: 1 });

describe('ping texts', () => {
  it('titles', () => {
    expect(pingTitle('needs', 'Chirp')).toBe('Chirp needs you');
    expect(pingTitle('finished', 'Nutmeg')).toBe('Nutmeg finished');
  });

  it('a burst: need you when any does, finished otherwise, three names and the rest', () => {
    expect(burstText([e('A', 'done'), e('B', 'blocked'), e('C', 'done'), e('D', 'done')], 1)).toEqual({ title: '4 agents need you', body: 'A, B, C and 1 more' });
    expect(burstText([e('A', 'done'), e('B', 'done'), e('C', 'done'), e('D', 'done'), e('E', 'done')], 0)).toEqual({ title: '5 agents finished', body: 'A, B, C and 2 more' });
  });

  it('while you were away', () => {
    expect(awayText(1, 3)).toBe('While you were away: 3 finished, 1 needs you');
    expect(awayText(2, 0)).toBe('While you were away: 2 need you');
    expect(awayText(0, 1)).toBe('While you were away: 1 finished');
  });
});
