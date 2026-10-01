/**
 * M13 screen share: answering the bridge's `screen.frame_request`s. The only time a frame leaves the browser is in
 * reply to one, for the capture that is live when it arrives. Requests are answered one at a time, in order (an
 * encode is a few tens of ms, and the bridge has at most 4 waiting); a request that cannot have a frame is answered
 * with `screen.frame {req_id, error}` at once, so the grab fails with the reason rather than a timeout.
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

export class FrameResponder {
  private readonly queue: string[] = [];
  private busy = false;
  /** Every answer given, newest last (test hook; bounded). */
  readonly answered: FrameOutcome[] = [];

  constructor(private readonly d: ResponderDeps) {}

  /** One frame request from the bridge. */
  request(reqId: string): void {
    if (this.queue.includes(reqId)) return;
    if (this.queue.length >= MAX_QUEUED) {
      this.fail(reqId, 'unavailable', 'too many frame requests at once');
      return;
    }
    this.queue.push(reqId);
    if (!this.busy) void this.drain();
  }

  private async drain(): Promise<void> {
    this.busy = true;
    try {
      for (let id = this.queue.shift(); id !== undefined; id = this.queue.shift()) await this.answer(id);
    } finally {
      this.busy = false;
    }
  }

  private async answer(reqId: string): Promise<void> {
    const live = this.d.live();
    if (!live) {
      this.fail(reqId, 'not_sharing', 'screen sharing is off');
      return;
    }
    const alive = () => this.d.alive(live.gen);
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
