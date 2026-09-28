import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameAudio, Playback } from '../audio';
import type { Said } from './lines';
import { LineSequence, LOAD_WAIT_MS, readingMs } from './sequence';

const WELCOME: Said = { kind: 'welcome-morning', id: 'welcome', text: 'Good morning!', bubble: 'Good morning!' };
const NUDGE: Said = { kind: 'nudge', id: 'nudge', text: 'Someone needs you.', bubble: 'Two floors need you.' };
const GOODBYE: Said = { kind: 'goodbye', id: 'goodbye', text: 'Bye!', bubble: 'Bye!' };
/** Clip lengths as the lock has them (ms). */
const LOCK: Record<string, number> = { welcome: 4000, nudge: 2000, goodbye: 1500 };

/**
 * A GameAudio whose clips take `loadMs` to load (counted from the first
 * preload or play, like the real cache) and then play for `playMs` (default:
 * the lock length). It logs what really sounds, and when.
 */
function fakeAudio(loadMs: Record<string, number>, playMs: Record<string, number> = LOCK) {
  const log: string[] = [];
  const ready = new Map<string, Promise<void>>();
  const live = new Set<() => void>();
  let playing = 0;
  let most = 0;
  const load = (clip: string) => {
    const id = clip.replace('receptionist/', '');
    let p = ready.get(id);
    if (!p) {
      p = new Promise((r) => setTimeout(r, loadMs[id] ?? 0));
      ready.set(id, p);
    }
    return { id, p };
  };
  const audio = {
    muted: false,
    state: 'running' as GameAudio['state'],
    plays: [] as string[],
    preload: (clip: string) => void load(clip),
    stop: () => {
      for (const f of [...live]) f();
    },
    playAt: (clip: string): Playback => {
      const { id, p } = load(clip);
      audio.plays.push(id);
      let over = false;
      let on = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let started!: (ok: boolean) => void;
      let ended!: () => void;
      const finish = () => {
        if (over) return;
        over = true;
        live.delete(finish);
        clearTimeout(timer);
        if (on) {
          playing--;
          log.push(`${Date.now()} end ${id}`);
        }
        started(false);
        ended();
      };
      live.add(finish);
      void p.then(() => {
        if (over) return;
        on = true;
        most = Math.max(most, ++playing);
        log.push(`${Date.now()} start ${id}`);
        started(true);
        timer = setTimeout(finish, playMs[id] ?? 0);
      });
      return { started: new Promise((r) => (started = r)), ended: new Promise((r) => (ended = r)), cancel: finish };
    },
  };
  return { audio, log, most: () => most };
}

function sequence(audio: ReturnType<typeof fakeAudio>['audio']) {
  const shown: string[] = [];
  const seq = new LineSequence({
    audio,
    at: () => ({ x: 0, y: 1.2, z: 0 }),
    show: (s, i, silent, talkMs) => shown.push(`${Date.now()} show ${s.id}${silent ? ' silent' : ''} ${talkMs}`),
    hide: () => shown.push(`${Date.now()} hide`),
    clipMs: (id) => LOCK[id] ?? 0,
    now: () => Date.now(),
  });
  return { seq, shown };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('LineSequence', () => {
  it('a welcome that loads late and a nudge that loads first: in order, never together, bubbles with the voice', async () => {
    const f = fakeAudio({ welcome: 1200, nudge: 10 });
    const { seq, shown } = sequence(f.audio);
    seq.start([WELCOME, NUDGE]);
    await vi.advanceTimersByTimeAsync(20_000);
    // The nudge was loaded first (preloaded), yet it starts only after the welcome has played out, plus a breath.
    expect(f.log).toEqual(['1200 start welcome', '5200 end welcome', '5550 start nudge', '7550 end nudge']);
    expect(f.most()).toBe(1);
    // Each bubble shows when its clip starts; the last goes after it ends and a pause.
    expect(shown).toEqual(['0 hide', '1200 show welcome 4000', '5550 show nudge 2000', `${7550 + Math.max(900, readingMs(NUDGE.bubble) - 2000)} hide`]);
    expect(seq.clips).toEqual(['welcome', 'nudge']);
  });

  it('waits for the bubble to be read before the next line, even after a short clip', async () => {
    const f = fakeAudio({}, { welcome: 300, nudge: 300 });
    const { seq, shown } = sequence(f.audio);
    seq.start([WELCOME, NUDGE]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.log.slice(0, 3)).toEqual(['0 start welcome', '300 end welcome', `${readingMs(WELCOME.bubble)} start nudge`]);
    expect(shown[2]).toBe(`${readingMs(WELCOME.bubble)} show nudge 2000`);
  });

  it('drops a clip that loads too slowly (it never starts late) and goes on silently', async () => {
    const f = fakeAudio({ welcome: 4000, nudge: 10 });
    const { seq, shown } = sequence(f.audio);
    seq.start([WELCOME, NUDGE]);
    await vi.advanceTimersByTimeAsync(20_000);
    const next = LOAD_WAIT_MS + Math.max(4000 + 350, readingMs(WELCOME.bubble));
    expect(f.log).toEqual([`${next} start nudge`, `${next + 2000} end nudge`]);
    expect(shown.slice(0, 3)).toEqual(['0 hide', `${LOAD_WAIT_MS} show welcome silent 4000`, `${next} show nudge 2000`]);
    expect(f.most()).toBe(1);
    expect(seq.clips).toEqual(['welcome', 'nudge']);
  });

  it('a clip whose load fails goes on silently, timed by the lock', async () => {
    const f = fakeAudio({ welcome: 50 });
    const failing = { ...f.audio, playAt: (clip: string) => (clip.endsWith('welcome') ? { started: Promise.resolve(false), ended: Promise.resolve(), cancel: () => undefined } : f.audio.playAt(clip)) };
    const { seq, shown } = sequence(failing);
    seq.start([WELCOME, NUDGE]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(shown.slice(0, 3)).toEqual(['0 hide', '0 show welcome silent 4000', '4350 show nudge 2000']);
    expect(f.log[0]).toBe('4350 start nudge');
  });

  it('cuts off a clip that never reports its end', async () => {
    const f = fakeAudio({}, { welcome: 1e9, nudge: 2000 });
    const { seq } = sequence(f.audio);
    seq.start([WELCOME, NUDGE]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.log.slice(0, 3)).toEqual(['0 start welcome', '7000 end welcome', '7350 start nudge']);
  });

  it.each([
    ['muted', { muted: true }],
    ['before the first gesture', { state: 'idle' }],
    ['without Web Audio', { state: 'none' }],
  ] as const)('%s: no sound, timed by the lock, the clips still recorded', async (_, over) => {
    const f = fakeAudio({});
    Object.assign(f.audio, over);
    const { seq, shown } = sequence(f.audio);
    seq.start([WELCOME, NUDGE]);
    // The first bubble shows at once: there is no clip to wait for.
    expect(shown).toEqual(['0 hide', '0 show welcome silent 4000']);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(shown).toEqual(['0 hide', '0 show welcome silent 4000', '4350 show nudge silent 2000', `${4350 + 2900} hide`]);
    expect(f.audio.plays).toEqual([]);
    expect(f.log).toEqual([]);
    expect(seq.clips).toEqual(['welcome', 'nudge']);
  });

  it('a new sequence cuts off the current one: its clip stops, the rest is never said', async () => {
    const f = fakeAudio({ welcome: 100, goodbye: 400 });
    const { seq, shown } = sequence(f.audio);
    seq.start([WELCOME, NUDGE]);
    await vi.advanceTimersByTimeAsync(2000);
    seq.start([GOODBYE]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.log).toEqual(['100 start welcome', '2000 end welcome', '2400 start goodbye', '3900 end goodbye']);
    expect(shown).toEqual(['0 hide', '100 show welcome 4000', '2000 hide', '2400 show goodbye 1500', `${3900 + Math.max(900, readingMs(GOODBYE.bubble) - 1500)} hide`]);
    expect(seq.clips).toEqual(['welcome', 'goodbye']);
    expect(f.most()).toBe(1);
  });

  it('a new sequence while the next line is still loading: that line never starts', async () => {
    const f = fakeAudio({ nudge: 900 }, { welcome: 100, nudge: 2000, goodbye: 100 });
    // The nudge is not preloaded here: its load starts with its own line.
    const { seq } = sequence({ ...f.audio, preload: () => undefined });
    seq.start([WELCOME, NUDGE]);
    const nudgeAt = readingMs(WELCOME.bubble);
    await vi.advanceTimersByTimeAsync(nudgeAt + 500);
    expect(f.audio.plays).toEqual(['welcome', 'nudge']);
    seq.start([GOODBYE]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.log).toEqual(['0 start welcome', '100 end welcome', `${nudgeAt + 500} start goodbye`, `${nudgeAt + 600} end goodbye`]);
  });

  it('cancel() stops the sound and every timer', async () => {
    const f = fakeAudio({});
    const { seq, shown } = sequence(f.audio);
    seq.start([WELCOME, NUDGE]);
    await vi.advanceTimersByTimeAsync(1000);
    seq.cancel();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.log).toEqual(['0 start welcome', '1000 end welcome']);
    expect(shown).toEqual(['0 hide', '0 show welcome 4000']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
