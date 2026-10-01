/**
 * M13 screen share: answering the bridge's `screen.frame_request`s. The only time a frame leaves the browser is in
 * reply to one, for the capture that is live when it arrives: each request is bound to that capture's generation, and
 * one that waited in the queue past its capture's end (a Stop, then maybe a new Share of another source) is never
 * encoded nor uploaded. Requests are answered one at a time, in order (an encode is a few tens of ms, and the bridge
 * has at most 4 waiting); a request that cannot have a frame is answered with `screen.frame {req_id, error}` at once,
 * so the grab fails with the reason rather than a timeout.
 */

import type { CommandResult } from '../net/client';
import { encodeFrame, FrameError, type FrameSource } from './frame';

export interface ResponderDeps {
  /** The live capture: its source and generation, or null while not sharing. */
  live(): { source: FrameSource; gen: number } | null;
  alive(gen: number): boolean;
  encode?: (s: FrameSource, alive: () => boolean) => Promise<{ blob: Blob; w: number; h: number }>;
  /** POST /screen/frame/<id> (net/screenFrame.ts). */
  post(reqId: string, jpeg: Blob): Promise<CommandResult>;
  /** The `screen.frame` command (no frame, and why). */
  refuse(reqId: string, error: string, message: string): void;
  log?: (msg: string) => void;
}

/** Most requests kept waiting behind the one being answered (the bridge caps them at 4). */
const MAX_QUEUED = 8;

export type FrameOutcome = { reqId: string; ok: true; bytes: number; w: number; h: number } | { reqId: string; ok: false; code: string };

/** A request waiting its turn, with the generation of the capture that was live when it arrived. */
interface Queued {
  reqId: string;
  gen: number;
}

export class FrameResponder {
  private readonly queue: Queued[] = [];
  private busy = false;
  /** Every answer given, newest last (test hook; bounded). */
  readonly answered: FrameOutcome[] = [];

  constructor(private readonly d: ResponderDeps) {}

  /** One frame request from the bridge. */
  request(reqId: string): void {
    if (this.queue.some((q) => q.reqId === reqId)) return;
    const live = this.d.live();
    if (!live) {
      this.fail(reqId, 'not_sharing', 'screen sharing is off');
      return;
    }
    if (this.queue.length >= MAX_QUEUED) {
      this.fail(reqId, 'unavailable', 'too many frame requests at once');
      return;
    }
    this.queue.push({ reqId, gen: live.gen });
    if (!this.busy) void this.drain();
  }

  /**
   * The capture ended (Stop, Chrome's "Stop sharing"): every request still waiting goes, unanswered. The bridge
   * already failed their grabs on `screen.share {sharing: false}` (or when this connection went away), so telling it
   * again would only be refused.
   */
  ended(): void {
    for (const q of this.queue.splice(0)) this.record({ reqId: q.reqId, ok: false, code: 'stopped' });
  }

  private async drain(): Promise<void> {
    this.busy = true;
    try {
      for (let q = this.queue.shift(); q !== undefined; q = this.queue.shift()) await this.answer(q);
    } finally {
      this.busy = false;
    }
  }

  private async answer({ reqId, gen }: Queued): Promise<void> {
    const alive = () => this.d.alive(gen);
    const live = this.d.live();
    // The capture it was asked of, and no other: one started since is a different source the agent never asked for.
    if (!live || live.gen !== gen || !alive()) {
      this.fail(reqId, 'stopped', 'screen sharing stopped before the frame was taken');
      return;
    }
    let frame: { blob: Blob; w: number; h: number };
    try {
      frame = await (this.d.encode ?? encodeFrame)(live.source, alive);
    } catch (err) {
      const e = err instanceof FrameError ? err : new FrameError('encode_failed', String(err));
      this.fail(reqId, e.code, e.message);
      return;
    }
    // Checked again just before anything is sent: a Stop during the encode sends nothing.
    if (!alive()) {
      this.fail(reqId, 'stopped', 'screen sharing stopped while the frame was taken');
      return;
    }
    const r = await this.d.post(reqId, frame.blob);
    if (r.ok) {
      this.record({ reqId, ok: true, bytes: frame.blob.size, w: frame.w, h: frame.h });
      return;
    }
    this.d.log?.(`screen frame ${reqId} not taken: ${r.code}: ${r.message}`);
    // The bridge refused it (and failed the grab itself), or it never got there: say so, so the grab ends now.
    if (r.code === 'offline' || r.code === 'frame_timeout') this.d.refuse(reqId, 'upload_failed', r.message);
    this.record({ reqId, ok: false, code: r.code });
  }

  private fail(reqId: string, code: string, message: string): void {
    this.d.refuse(reqId, code, message);
    this.record({ reqId, ok: false, code });
  }

  private record(o: FrameOutcome): void {
    this.answered.push(o);
    if (this.answered.length > 50) this.answered.shift();
  }
}
