/**
 * M13 screen share: the share's life, from the Share click to Stop. One capture at a time:
 *
 *   off ── start() ──▶ picking ── chosen, playing ──▶ live ── stop() / Chrome's "Stop sharing" ──▶ off
 *                         └── cancelled / refused ──▶ off
 *
 * While live the track may be `paused` (muted: the OS made the source unavailable for now, e.g. a minimised window)
 * and its size and surface change (a resize, "Share this tab instead"). Stop releases every track; it is idempotent,
 * because `track.stop()` fires no `ended` and Chrome's own Stop races ours. `gen` tells one capture from the next, so
 * nothing of a stopped one (a frame being encoded, a late picker answer) survives into another.
 */

import type { DisplaySurface } from '../net/protocol';
import { browserCapture, classifyCaptureError, requestDisplay, surfaceOf, type CaptureEnv, type CaptureFailure } from './capture';
import type { FrameSource } from './frame';

export type SharePhase = 'off' | 'picking' | 'live';

export interface ShareView {
  phase: SharePhase;
  surface?: DisplaySurface | undefined;
  /** Live, but the source has no picture right now (track muted). */
  paused: boolean;
  /** The video's size (0 until it plays). */
  w: number;
  h: number;
  gen: number;
}

export interface ShareDeps {
  capture?: CaptureEnv;
  /** The hidden `<video>` the TV texture and the frame grabs read (default: a 1 px element kept in the page). */
  makeVideo?: () => HTMLVideoElement;
  now?: () => number;
  mac?: boolean;
  log?: (msg: string) => void;
}

const isMac = () => typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

/** A muted inline video, in the page but invisible: a detached or `display: none` one may stop delivering frames. */
function hiddenVideo(): HTMLVideoElement {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.autoplay = true;
  v.setAttribute('aria-hidden', 'true');
  v.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.append(v);
  return v;
}

export class ScreenShare {
  private st: ShareView = { phase: 'off', paused: false, w: 0, h: 0, gen: 0 };
  private stream: MediaStream | null = null;
  private trk: MediaStreamTrack | null = null;
  private vid: HTMLVideoElement | null = null;
  private undo: Array<() => void> = [];
  private readonly listeners = new Set<(v: ShareView) => void>();
  private readonly env: CaptureEnv;
  private readonly now: () => number;
  private readonly mac: boolean;

  constructor(private readonly deps: ShareDeps = {}) {
    this.env = deps.capture ?? browserCapture();
    this.now = deps.now ?? (() => performance.now());
    this.mac = deps.mac ?? isMac();
  }

  get view(): ShareView {
    return this.st;
  }

  /** The playing video, while live. */
  get video(): HTMLVideoElement | null {
    return this.st.phase === 'live' ? this.vid : null;
  }

  /** Whether this browser can share a screen at all. */
  get supported(): boolean {
    return this.env.media !== null;
  }

  onChange(fn: (v: ShareView) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** What a frame grab reads, while live. */
  source(): FrameSource | null {
    return this.st.phase === 'live' && this.vid && this.trk ? { video: this.vid, track: this.trk } : null;
  }

  /** Whether capture `gen` is still the live one. */
  alive(gen: number): boolean {
    return this.st.phase === 'live' && this.st.gen === gen;
  }

  /**
   * Starts a capture. Call it straight from the click (getDisplayMedia needs the user activation, so it runs before
   * anything is awaited). Resolves once the share is live or did not start: with the failure to show, or null (live,
   * cancelled, or stopped meanwhile).
   */
  async start(): Promise<Exclude<CaptureFailure, { kind: 'cancelled' }> | null> {
    if (this.st.phase !== 'off') return null;
    const gen = this.st.gen + 1;
    const t0 = this.now();
    let picked: Promise<MediaStream>;
    try {
      picked = requestDisplay(this.env);
    } catch (err) {
      picked = Promise.reject(err);
    }
    this.set({ phase: 'picking', paused: false, w: 0, h: 0, gen });
    let stream: MediaStream;
    try {
      stream = await picked;
    } catch (err) {
      const e = err as { name?: unknown; message?: unknown };
      this.deps.log?.(`getDisplayMedia: ${String(e?.name)}: ${String(e?.message)}`);
      if (this.st.gen === gen) this.set({ phase: 'off', paused: false, w: 0, h: 0, gen });
      const f = classifyCaptureError(err, { mac: this.mac, elapsedMs: this.now() - t0 });
      return f.kind === 'cancelled' ? null : f;
    }
    if (!this.picking(gen)) {
      for (const t of stream.getTracks()) t.stop(); // stopped while the picker was open
      return null;
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      for (const t of stream.getTracks()) t.stop();
      this.set({ phase: 'off', paused: false, w: 0, h: 0, gen });
      return { kind: 'failed', message: "Screen sharing wasn't started: the browser gave no video. Press Share screen to try again." };
    }
    this.stream = stream;
    this.trk = track;
    const video = (this.vid ??= (this.deps.makeVideo ?? hiddenVideo)());
    video.muted = true;
    video.srcObject = stream;
    const on = <K extends string>(target: EventTarget, type: K, fn: () => void) => {
      target.addEventListener(type, fn);
      this.undo.push(() => target.removeEventListener(type, fn));
    };
    on(track, 'ended', () => this.stop()); // Chrome's "Stop sharing", or the source closed
    on(track, 'mute', () => this.patch({ paused: true }));
    on(track, 'unmute', () => this.patch({ paused: false, surface: surfaceOf(track) }));
    on(video, 'resize', () => this.patch({ w: video.videoWidth, h: video.videoHeight, surface: surfaceOf(track) }));
    try {
      await video.play();
    } catch (err) {
      this.deps.log?.(`screen video did not play: ${String(err)}`);
      if (this.st.gen === gen) this.teardown(gen);
      return this.st.gen === gen ? { kind: 'failed', message: "Screen sharing wasn't started: the video did not play. Press Share screen to try again." } : null;
    }
    if (!this.picking(gen)) return null;
    this.set({ phase: 'live', surface: surfaceOf(track), paused: track.muted, w: video.videoWidth, h: video.videoHeight, gen });
    return null;
  }

  /** Stops sharing and releases every track (also while the picker is open). Safe to call any time. */
  stop(): void {
    if (this.st.phase === 'off') return;
    this.teardown(this.st.gen + 1);
  }

  /** Re-reads the surface (after a "Share this tab instead"); notifies when it changed. */
  refresh(): void {
    if (this.st.phase === 'live' && this.trk) this.patch({ surface: surfaceOf(this.trk) });
  }

  /** Whether capture `gen` is still the one being started (a Stop meanwhile ends it). */
  private picking(gen: number): boolean {
    return this.st.gen === gen && this.st.phase === 'picking';
  }

  private teardown(gen: number): void {
    for (const u of this.undo.splice(0)) u();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    if (this.vid) {
      this.vid.pause();
      this.vid.srcObject = null;
    }
    this.stream = null;
    this.trk = null;
    this.set({ phase: 'off', paused: false, w: 0, h: 0, gen });
  }

  private patch(p: Partial<ShareView>): void {
    if (this.st.phase !== 'live') return;
    const next = { ...this.st, ...p };
    if (next.paused === this.st.paused && next.w === this.st.w && next.h === this.st.h && next.surface === this.st.surface) return;
    this.set(next);
  }

  private set(v: ShareView): void {
    this.st = v;
    for (const fn of this.listeners) fn(v);
  }

  /** Removes the hidden video (the game goes away). */
  dispose(): void {
    this.stop();
    this.vid?.remove();
    this.vid = null;
    this.listeners.clear();
  }
}
