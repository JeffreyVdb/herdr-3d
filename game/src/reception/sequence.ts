import type { GameAudio, Playback } from '../audio';
import type { Said } from './lines';
import { CLIP_MS, clipKey } from './manifest';

/** How long a bubble stays up for reading, whatever the clip length (ms). */
export function readingMs(text: string): number {
  return Math.min(9000, Math.max(2600, 1200 + text.length * 60));
}

/** How long a line waits for its clip to load before it goes on without sound (ms). */
export const LOAD_WAIT_MS = 1500;
/** A clip still playing this long after its length is cut off (a suspended context, a lost `ended`). */
const STALL_MS = 3000;
/** Silence between two lines, and after the last one before the bubble goes (ms). */
const GAP_MS = 350;
const END_MS = 900;

export interface SequenceOptions {
  audio: Pick<GameAudio, 'playAt' | 'preload' | 'stop' | 'muted' | 'state'>;
  /** Where the voice comes from (world space), asked as each line starts. */
  at: () => { x: number; y: number; z: number };
  /** Line `i` starts: its bubble shows. `silent`: no sound comes with it; `talkMs`: how long it is spoken. */
  show: (s: Said, i: number, silent: boolean, talkMs: number) => void;
  /** No line is on: the last one is over, or a new sequence cut in (its first bubble comes with its clip). */
  hide: () => void;
  /** Clip length (ms), for the talking and for timing a line without sound. Default: the lock file. */
  clipMs?: (id: string) => number;
  /** A monotonic clock (ms). */
  now?: () => number;
}

/**
 * Says lines one after the other, timed by the audio that actually plays: a
 * line's bubble shows when its clip starts (or, without sound, right away),
 * and the next line starts only once that clip has ended and the bubble has
 * been up long enough to read. A clip that takes too long to load is dropped
 * (it never starts late) and its line goes on silently. Muted or without an
 * AudioContext, lines are timed by the clip lengths from the lock. Timers,
 * not frames: a sequence finishes even when the lobby isn't rendered.
 */
export class LineSequence {
  /** Clip ids in the order their lines started (with or without sound). */
  readonly clips: string[] = [];
  private readonly o: SequenceOptions;
  private readonly clipMs: (id: string) => number;
  private readonly now: () => number;
  /** Bumped by every start / cancel: callbacks of an older sequence do nothing. */
  private run = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private playing: Playback | null = null;

  constructor(o: SequenceOptions) {
    this.o = o;
    this.clipMs = o.clipMs ?? ((id) => CLIP_MS[id] ?? 0);
    this.now = o.now ?? (() => performance.now());
  }

  /** Cuts off whatever is being said and says `lines`. */
  start(lines: readonly Said[]): void {
    this.cancel();
    this.o.hide();
    const run = this.run;
    // The rest loads while the first line plays.
    if (this.sounds()) for (const s of lines.slice(1)) this.o.audio.preload(clipKey(s.id));
    this.line(lines, 0, run);
  }

  /** Stops the current sequence, its sound and its timers (the bubble is left to the caller). */
  cancel(): void {
    this.run++;
    this.clear();
    this.playing?.cancel();
    this.playing = null;
    this.o.audio.stop();
  }

  private sounds(): boolean {
    return !this.o.audio.muted && this.o.audio.state === 'running';
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private after(ms: number, fn: () => void): void {
    this.clear();
    this.timer = setTimeout(fn, Math.max(0, ms));
  }

  private line(lines: readonly Said[], i: number, run: number): void {
    if (run !== this.run) return;
    this.clear();
    this.playing = null;
    const s = lines[i];
    if (!s) {
      this.o.hide();
      return;
    }
    this.clips.push(s.id);
    const ms = this.clipMs(s.id) || readingMs(s.text) * 0.6;
    if (!this.sounds()) {
      this.begin(lines, i, run, ms, null);
      return;
    }
    const pb = this.o.audio.playAt(clipKey(s.id), this.o.at());
    this.playing = pb;
    let late = false;
    // Loading too long: drop the clip so it can't start under a later line, and go on without it.
    this.after(LOAD_WAIT_MS, () => {
      late = true;
      pb.cancel();
      this.begin(lines, i, run, ms, null);
    });
    void pb.started.then((ok) => {
      if (late || run !== this.run) return;
      this.begin(lines, i, run, ms, ok ? pb : null);
    });
  }

  /** Line `i` is on: with `pb` its clip is playing, without it the line is silent. */
  private begin(lines: readonly Said[], i: number, run: number, ms: number, pb: Playback | null): void {
    if (run !== this.run) return;
    const s = lines[i];
    if (!s) return;
    this.clear();
    this.o.show(s, i, !pb, ms);
    const gap = i === lines.length - 1 ? END_MS : GAP_MS;
    const read = readingMs(s.bubble);
    const next = () => this.line(lines, i + 1, run);
    if (!pb) {
      this.playing = null;
      this.after(Math.max(ms + gap, read), next);
      return;
    }
    const shown = this.now();
    this.after(ms + STALL_MS, () => pb.cancel());
    void pb.ended.then(() => {
      if (run !== this.run) return;
      this.playing = null;
      this.after(Math.max(gap, read - (this.now() - shown)), next);
    });
  }
}
