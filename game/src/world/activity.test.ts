import { describe, expect, it } from 'vitest';
import type { Activity, Worker } from '../net/protocol';
import { activityOf, basename, BLANK_GLYPH, cardFace, CLOCK_GLYPH, clip, elapsedText, faceKey, monitorMode, TIMER_GLYPHS, TIMER_SLOTS, timerGlyphs } from './activity';
import type { Display } from './derive';

const act = (over: Partial<Activity> = {}): Activity => ({ kind: 'testing', detail: 'pytest -n auto', since: 1000, source: 'rule', ...over });
type W = Pick<Worker, 'status'> & { activity?: Activity };
const view = (harness: string | undefined, display: Display, worker: W) => ({ harness, display, worker });

describe('activityOf', () => {
  it('reads a known kind, its detail and since', () => {
    expect(activityOf({ status: 'working', activity: act() })).toEqual({ kind: 'testing', detail: 'pytest -n auto', since: 1000, image: null, tasks: 0 });
  });

  it('treats a kind it does not know as working', () => {
    expect(activityOf({ status: 'working', activity: act({ kind: 'juggling' as Activity['kind'] }) })?.kind).toBe('working');
    expect(activityOf({ status: 'working', activity: { since: 5 } as Activity })?.kind).toBe('working');
  });

  it('shows nothing that disagrees with the status: only waiting while idle or done, nothing while blocked', () => {
    expect(activityOf({ status: 'idle', activity: act() })).toBeNull();
    expect(activityOf({ status: 'done', activity: act({ kind: 'thinking' }) })).toBeNull();
    expect(activityOf({ status: 'idle', activity: act({ kind: 'waiting', tasks: 2 }) })).toMatchObject({ kind: 'waiting', tasks: 2 });
    expect(activityOf({ status: 'done', activity: act({ kind: 'waiting' }) })?.kind).toBe('waiting');
    expect(activityOf({ status: 'blocked', activity: act({ kind: 'waiting' }) })).toBeNull();
    expect(activityOf({ status: 'unknown', activity: act() })).toBeNull();
    expect(activityOf({ status: 'working' })).toBeNull();
  });

  it('keeps the detail short whatever arrives, and drops what does not check', () => {
    const long = 'cd /home/dev/src/project && uv run pytest -n auto tests/unit -k "not slow" | tail -20';
    const a = activityOf({ status: 'working', activity: act({ detail: long, since: Number.NaN, tasks: -1 }) });
    expect([...(a?.detail ?? '')].length).toBeLessThanOrEqual(32);
    expect(a?.detail.endsWith('…')).toBe(true);
    expect(a?.since).toBeNull();
    expect(a?.tasks).toBe(0);
    expect(activityOf({ status: 'working', activity: act({ detail: 42 as unknown as string }) })?.detail).toBe('');
  });

  it('takes an image only with a hash that looks like one', () => {
    const hash = 'a'.repeat(64);
    expect(activityOf({ status: 'working', activity: act({ kind: 'image', image: { hash, w: 640, h: 400 } }) })?.image).toEqual({ hash, w: 640, h: 400 });
    expect(activityOf({ status: 'working', activity: act({ kind: 'image', image: { hash: '../etc/passwd', w: 1, h: 1 } }) })?.image).toBeNull();
    expect(activityOf({ status: 'working', activity: act({ kind: 'testing', image: { hash, w: 1, h: 1 } }) })?.image).toBeNull();
  });
});

describe('monitorMode', () => {
  it('shows the card for a Claude or Codex worker with an activity, the image for an image', () => {
    expect(monitorMode(view('claude', 'working', { status: 'working', activity: act() }), 'activity')).toBe('card');
    expect(monitorMode(view('codex', 'working', { status: 'working', activity: act({ kind: 'image', image: { hash: 'b'.repeat(64), w: 1, h: 1 } }) }), 'activity')).toBe('image');
    expect(monitorMode(view('claude', 'waiting', { status: 'idle', activity: act({ kind: 'waiting' }) }), 'activity')).toBe('card');
  });

  it('rests when idle or done with nothing to show; the terminal otherwise', () => {
    expect(monitorMode(view('claude', 'done', { status: 'done' }), 'activity')).toBe('rest');
    expect(monitorMode(view('codex', 'idle', { status: 'idle' }), 'activity')).toBe('rest');
    expect(monitorMode(view('claude', 'working', { status: 'working' }), 'activity')).toBe('glance');
    expect(monitorMode(view('claude', 'needs_you', { status: 'blocked', activity: act() }), 'activity')).toBe('glance');
    expect(monitorMode(view('claude', 'needs_you', { status: 'idle', activity: act({ kind: 'waiting' }) }), 'activity')).toBe('glance');
    expect(monitorMode(view('claude', 'asleep', { status: 'idle' }), 'activity')).toBe('glance');
    // A plain shell or another harness keeps its terminal.
    expect(monitorMode(view(undefined, 'idle', { status: 'idle' }), 'activity')).toBe('glance');
    expect(monitorMode(view('aider', 'working', { status: 'working', activity: act() }), 'activity')).toBe('glance');
  });

  it('is the terminal everywhere with the Terminal preference', () => {
    expect(monitorMode(view('claude', 'working', { status: 'working', activity: act() }), 'terminal')).toBe('glance');
    expect(monitorMode(view('claude', 'done', { status: 'done' }), 'terminal')).toBe('glance');
  });
});

describe('cardFace', () => {
  it('has the word in big type, the detail under it and counts from the label’s start', () => {
    const f = cardFace('card', view('claude', 'working', { status: 'working', activity: act() }), 50);
    expect(f).toEqual({ mascot: 'crab', pose: 'testing', tone: 'testing', word: 'Testing', detail: 'pytest -n auto', badge: null, since: 1000 });
  });

  it('gives Codex its cloud, and Thinking its own pose', () => {
    const f = cardFace('card', view('codex', 'working', { status: 'working', activity: act({ kind: 'thinking', detail: '' }) }), 50);
    expect(f).toMatchObject({ mascot: 'cloud', pose: 'thinking', word: 'Thinking', detail: '' });
  });

  it('shows what a waiting worker waits on as a badge, with the number of tasks', () => {
    const f = cardFace('card', view('claude', 'waiting', { status: 'idle', activity: act({ kind: 'waiting', detail: 'Testing in the background', tasks: 3 }) }), 50);
    expect(f).toMatchObject({ pose: 'waiting', word: 'Waiting', detail: '', badge: 'Testing in the background · 3 tasks', since: 1000 });
    expect(cardFace('card', view('claude', 'waiting', { status: 'idle', activity: act({ kind: 'waiting', detail: '', tasks: 1 }) }), 50).badge).toBeNull();
  });

  it('says "Looking at an image" with the picture pose where the image itself is not shown', () => {
    const f = cardFace('image', view('codex', 'working', { status: 'working', activity: act({ kind: 'image', detail: 'needs-you-desk.png' }) }), 50);
    expect(f).toMatchObject({ pose: 'image', word: 'Looking at an image', detail: 'needs-you-desk.png' });
  });

  it('rests: the crab asleep after Done, counting from the status', () => {
    expect(cardFace('rest', view('claude', 'done', { status: 'done' }), 777)).toEqual({ mascot: 'crab', pose: 'rest', tone: 'done', word: 'All done', detail: '', badge: null, since: 777 });
    expect(cardFace('rest', view('codex', 'idle', { status: 'idle' }), 0)).toMatchObject({ mascot: 'cloud', tone: 'idle', word: 'Resting', since: null });
  });

  it('keys the text cell on what it draws, never on the time', () => {
    const a = cardFace('card', view('claude', 'working', { status: 'working', activity: act({ since: 1 }) }), 50);
    const b = cardFace('card', view('claude', 'working', { status: 'working', activity: act({ since: 99_999 }) }), 50);
    expect(faceKey(a)).toBe(faceKey(b));
    expect(faceKey(a)).not.toBe(faceKey({ ...a, detail: 'go test ./...' }));
  });
});

describe('the elapsed counter', () => {
  it('reads m:ss under an hour, then hours and minutes, then days and hours', () => {
    expect(elapsedText(0)).toBe('0:00');
    expect(elapsedText(7_400)).toBe('0:07');
    expect(elapsedText(754_000)).toBe('12:34');
    expect(elapsedText(3_599_999)).toBe('59:59');
    expect(elapsedText(3_600_000)).toBe('1h 00m');
    expect(elapsedText(3_900_000)).toBe('1h 05m');
    expect(elapsedText(86_399_000)).toBe('23h 59m');
    expect(elapsedText(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 04h');
    expect(elapsedText(100 * 86_400_000)).toBe('99d+');
    expect(elapsedText(-5000)).toBe('0:00');
    expect(elapsedText(Number.NaN)).toBe('0:00');
  });

  it('never needs more than its slots', () => {
    for (const ms of [0, 59_000, 3_599_000, 36_000_000, 86_399_000, 99 * 86_400_000 + 23 * 3_600_000, 1e12]) expect(elapsedText(ms).length).toBeLessThanOrEqual(TIMER_SLOTS - 1);
  });

  it('is a clock and the text in glyphs of the atlas, blank after; none is all blank', () => {
    const g = timerGlyphs('1h 05m');
    expect(g).toHaveLength(TIMER_SLOTS);
    expect(g[0]).toBe(CLOCK_GLYPH);
    expect(g.slice(1, 7).map((i) => TIMER_GLYPHS[i]).join('')).toBe('1h 05m');
    expect(g[7]).toBe(BLANK_GLYPH);
    expect(timerGlyphs(null).every((i) => i === BLANK_GLYPH)).toBe(true);
  });
});

describe('helpers', () => {
  it('clips on code points and trims', () => {
    expect(clip('  a  b  ')).toBe('a b');
    expect(clip('x'.repeat(40), 10)).toBe(`${'x'.repeat(9)}…`);
    expect([...clip('🦀'.repeat(40), 5)]).toHaveLength(5);
  });

  it('takes the basename of a path', () => {
    expect(basename('/tmp/shots/needs-you-desk.png')).toBe('needs-you-desk.png');
    expect(basename('C:\\shots\\a.png')).toBe('a.png');
    expect(basename('plain.png')).toBe('plain.png');
  });
});
