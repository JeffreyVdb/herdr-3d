/**
 * #98: what a desk monitor shows of its worker's activity (`Worker.activity`, the bridge's label for what a Claude or
 * Codex agent is doing right now). Pure: which view a monitor is in, the card's word, detail and pose, and the elapsed
 * counter's text and glyphs. The render side (`render/monitorCards.ts`) draws it; `laptop/monitors.ts` plans it.
 */

import type { Activity, ActivityKind, Worker } from '../net/protocol';
import type { Display } from './derive';

export const ACTIVITY_KINDS: readonly ActivityKind[] = [
  'thinking',
  'replying',
  'writing',
  'investigating',
  'testing',
  'building',
  'shipping',
  'researching',
  'delegating',
  'planning',
  'waiting',
  'image',
  'working',
];

const KNOWN = new Set<string>(ACTIVITY_KINDS);

/** The monitor's word per kind (an image shows itself; far away, or until it loads, the words say so). */
export const ACTIVITY_WORD: Record<ActivityKind, string> = {
  thinking: 'Thinking',
  replying: 'Replying',
  writing: 'Writing',
  investigating: 'Investigating',
  testing: 'Testing',
  building: 'Building',
  shipping: 'Shipping',
  researching: 'Researching',
  delegating: 'Delegating',
  planning: 'Planning',
  waiting: 'Waiting',
  image: 'Looking at an image',
  working: 'Working',
};

/** The detail line is short and safe (the bridge clips it to 32): never more than this, whatever arrives. */
export const DETAIL_MAX = 32;

/** An activity as the monitor reads it: a known kind (unknown ones are `working`), the detail clipped, numbers checked. */
export interface ShownActivity {
  kind: ActivityKind;
  detail: string;
  /** Unix ms (bridge clock); null when the bridge sent none that is usable. */
  since: number | null;
  image: { hash: string; w: number; h: number } | null;
  tasks: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Clips to `max` characters with an ellipsis (code points, so a surrogate pair is never split). */
export function clip(s: string, max = DETAIL_MAX): string {
  const t = s.replace(/\s+/g, ' ').trim();
  const cps = [...t];
  return cps.length <= max ? t : `${cps.slice(0, max - 1).join('').trimEnd()}…`;
}

/**
 * The worker's activity, or null when there is none to show. The bridge sends one while herdr says `working`, and while
 * `idle`/`done` only a `waiting` one (open background tasks); an activity that disagrees with the status (a status
 * event that beat the clearing one, at most half a second) is not shown, so a finished turn never keeps its last word.
 */
export function activityOf(w: Pick<Worker, 'status'> & { activity?: Activity | null | undefined }): ShownActivity | null {
  const a = w.activity as unknown;
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return null;
  const o = a as Record<string, unknown>;
  const kind: ActivityKind = typeof o.kind === 'string' && KNOWN.has(o.kind) ? (o.kind as ActivityKind) : 'working';
  if (w.status === 'working') {
    // shown
  } else if (kind !== 'waiting' || (w.status !== 'idle' && w.status !== 'done')) return null;
  const img = o.image as Record<string, unknown> | undefined;
  const image =
    kind === 'image' && typeof img === 'object' && img !== null && typeof img.hash === 'string' && /^[0-9a-f]{16,128}$/.test(img.hash)
      ? { hash: img.hash, w: finite(img.w) && img.w > 0 ? img.w : 0, h: finite(img.h) && img.h > 0 ? img.h : 0 }
      : null;
  return {
    kind,
    detail: typeof o.detail === 'string' ? clip(o.detail) : '',
    since: finite(o.since) && o.since > 0 ? o.since : null,
    image,
    tasks: finite(o.tasks) && o.tasks > 0 ? Math.floor(o.tasks) : 0,
  };
}

/** #98: idle or done, but waiting on its own background tasks (a Monitor, a background command, a subagent, a wake-up). */
export function isWaiting(w: Pick<Worker, 'status'> & { activity?: Activity | null | undefined }): boolean {
  return (w.status === 'idle' || w.status === 'done') && activityOf(w)?.kind === 'waiting';
}

/** The client's "Desk monitors" preference: the activity card, or the terminal everywhere (as before #98). */
export type MonitorPref = 'activity' | 'terminal';

/**
 * What a desk monitor's content area shows (the status bar above it is the same in every view):
 * - `glance`: the terminal's last lines (no activity to show, a plain shell, a worker that needs you, the Terminal pref);
 * - `card`: the activity card (mascot, word, detail, elapsed time);
 * - `image`: the image the agent looks at (near desks; far ones and failed fetches show the card for it);
 * - `rest`: idle or done with no activity: the mascot resting (the crab asleep, the cloud drifting).
 */
export type MonitorMode = 'glance' | 'card' | 'image' | 'rest';

export function monitorMode(v: { harness: string | undefined; display: Display; worker: Pick<Worker, 'status'> & { activity?: Activity | null | undefined } }, pref: MonitorPref): MonitorMode {
  if (pref === 'terminal') return 'glance';
  if (v.harness !== 'claude' && v.harness !== 'codex') return 'glance';
  if (v.display === 'needs_you' || v.display === 'asleep') return 'glance';
  const a = activityOf(v.worker);
  if (a) return a.kind === 'image' ? 'image' : 'card';
  return v.display === 'done' || v.display === 'idle' ? 'rest' : 'glance';
}

/** The mascot's poses: one per kind, plus resting. `image` is the far desks' "looking at an image" (holding a picture). */
export type Pose = ActivityKind | 'rest';
export const POSES: readonly Pose[] = [...ACTIVITY_KINDS, 'rest'];

/** The mascot per harness: an orange pixel crab for Claude workers, a white and teal cloud with a `>_` face for Codex. */
export type Mascot = 'crab' | 'cloud';
export const MASCOTS: readonly Mascot[] = ['crab', 'cloud'];
export const mascotOf = (harness: string | undefined): Mascot => (harness === 'codex' ? 'cloud' : 'crab');

/** A card's colour family: the kind's, or a resting one's status. */
export type Tone = ActivityKind | 'done' | 'idle';

/** What one card shows. */
export interface CardFace {
  mascot: Mascot;
  pose: Pose;
  tone: Tone;
  word: string;
  /** Under the word (the command head, file names); empty: none. */
  detail: string;
  /** Waiting: what is awaited, as a small badge instead of the detail line (null: none). */
  badge: string | null;
  /** The elapsed counter counts from here (unix ms, bridge clock); null: no counter. */
  since: number | null;
}

/**
 * The card of a monitor in `card`, `image` (far, loading or failed: "Looking at an image" with a picture) or `rest`
 * mode; `statusSince` is when the status started (a resting card counts from there).
 */
export function cardFace(mode: Exclude<MonitorMode, 'glance'>, v: { harness: string | undefined; display: Display; worker: Pick<Worker, 'status'> & { activity?: Activity | null | undefined } }, statusSince: number): CardFace {
  const mascot = mascotOf(v.harness);
  const a = mode === 'rest' ? null : activityOf(v.worker);
  if (!a) {
    const done = v.display === 'done';
    return { mascot, pose: 'rest', tone: done ? 'done' : 'idle', word: done ? 'All done' : 'Resting', detail: '', badge: null, since: statusSince > 0 ? statusSince : null };
  }
  if (a.kind === 'waiting') {
    const tasks = a.tasks > 1 ? `${a.tasks} tasks` : '';
    const badge = [a.detail, tasks].filter(Boolean).join(' · ');
    return { mascot, pose: 'waiting', tone: 'waiting', word: ACTIVITY_WORD.waiting, detail: '', badge: badge || null, since: a.since };
  }
  return { mascot, pose: a.kind, tone: a.kind, word: ACTIVITY_WORD[a.kind], detail: a.detail, badge: null, since: a.since };
}

/** Same face, same cell: the text cell is drawn again only when one of these changes (never for the counter). */
export const faceKey = (f: CardFace): string => [f.mascot, f.pose, f.tone, f.word, f.detail, f.badge ?? ''].join('\u0000');

/**
 * The elapsed counter: `0:07`, `12:34` under an hour, `1h 05m` under a day, `3d 04h` after (at most 7 characters;
 * `99d+` past 99 days). Negative (the bridge's clock ahead of this one) counts as 0.
 */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const two = (n: number) => String(n).padStart(2, '0');
  if (s < 3600) return `${Math.floor(s / 60)}:${two(s % 60)}`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${two(Math.floor((s % 3600) / 60))}m`;
  const d = Math.floor(s / 86_400);
  return d > 99 ? '99d+' : `${d}d ${two(Math.floor((s % 86_400) / 3600))}h`;
}

/** The counter's glyphs, in the order of the glyph atlas (render/monitorCards.ts); the last one is a small clock. */
export const TIMER_GLYPHS = '0123456789:hmd +';
export const CLOCK_GLYPH = TIMER_GLYPHS.length;
export const BLANK_GLYPH = TIMER_GLYPHS.indexOf(' ');
/** The counter's slots: the clock, then up to 7 characters. */
export const TIMER_SLOTS = 8;

/** The counter as glyph indexes (`TIMER_SLOTS` of them): the clock and the text, blank after; all blank for none. */
export function timerGlyphs(text: string | null): number[] {
  const out = new Array<number>(TIMER_SLOTS).fill(BLANK_GLYPH);
  if (text === null) return out;
  out[0] = CLOCK_GLYPH;
  [...text].slice(0, TIMER_SLOTS - 1).forEach((ch, i) => {
    const g = TIMER_GLYPHS.indexOf(ch);
    out[i + 1] = g < 0 ? BLANK_GLYPH : g;
  });
  return out;
}

/** The basename of a path-like detail (an image's caption): what follows the last `/` or `\`. */
export function basename(s: string): string {
  const t = s.trim();
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  return i >= 0 ? t.slice(i + 1) : t;
}
