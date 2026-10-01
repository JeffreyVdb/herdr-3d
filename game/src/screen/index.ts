/**
 * M13 screen share, put together: the capture (share.ts), the TV texture every floor's TV shows (render/tv.ts), the
 * top bar control (ui/screenShare.ts), the answers to the bridge's frame requests (responder.ts) and what the
 * bridge is told (`screen.share` after every connect and every change). docs/protocol.md "Screen share".
 */

import type { CommandResult } from '../net/client';
import type { CommandArgs, ScreenMessage } from '../net/protocol';
import { postFrame } from '../net/screenFrame';
import { ScreenTexture } from '../render/tv';
import { sharedLine, ShareControl } from '../ui/screenShare';
import { FrameResponder } from './responder';
import { ScreenShare, type ShareDeps, type ShareView } from './share';

export interface ScreenHost {
  send<T extends 'screen.share' | 'screen.frame'>(t: T, args: CommandArgs[T]): Promise<CommandResult>;
  /** The bridge WebSocket URL (frames go beside it, with its token). */
  url: string;
  toast(msg: string, kind: 'info' | 'error'): void;
  /** The floor whose TV shows the share, if any is loaded. */
  office(): { setScreen(tex: import('three/webgpu').Texture | null, w: number, h: number, paused: boolean): void } | null;
  log?(msg: string): void;
  /** What the TV's look-at bar says. */
  tvInfo?(line: string): void;
}

/** The TV's look-at bar. */
export function tvLine(v: ShareView): string {
  if (v.phase !== 'live') return v.phase === 'picking' ? 'Choosing what to share…' : 'Off · Share screen in the top bar';
  return `Live · ${sharedLine(v).toLowerCase()} · agents see a frame only when they ask`;
}

export class ScreenShareController {
  readonly share: ScreenShare;
  readonly texture: ScreenTexture;
  readonly responder: FrameResponder;
  readonly control: ShareControl;
  /** Who looked, newest last (test hook). */
  readonly grabbed: Array<{ requester: string; floor: string }> = [];
  /** Every `screen.share` sent, oldest first (test hook; bounded). */
  readonly reports: Array<CommandArgs['screen.share']> = [];
  private connected = false;
  private reported: string | null = null;
  private stopping = false;
  private last: ShareView;

  constructor(
    private readonly host: ScreenHost,
    deps: ShareDeps = {},
  ) {
    this.share = new ScreenShare({ ...(host.log ? { log: host.log } : {}), ...deps });
    this.last = this.share.view;
    this.texture = new ScreenTexture(this.share);
    this.texture.onChange(() => this.paint());
    this.control = new ShareControl({ start: () => this.start(), stop: () => this.stop() }, this.share.supported);
    this.responder = new FrameResponder({
      live: () => {
        const source = this.share.source();
        return source ? { source, gen: this.share.view.gen } : null;
      },
      alive: (gen) => this.share.alive(gen),
      post: (id, jpeg) => postFrame(this.host.url, id, jpeg),
      refuse: (id, error, message) => void this.host.send('screen.frame', { req_id: id, error, message }),
      ...(host.log ? { log: host.log } : {}),
    });
    this.share.onChange((v) => this.changed(v));
  }

  /** The Share click: getDisplayMedia is called before anything else happens. */
  start(): void {
    if (!this.share.supported) {
      this.host.toast('This browser cannot share a screen here. Use Chrome on the Mac.', 'error');
      return;
    }
    void this.share.start().then((f) => {
      if (f) this.host.toast(f.message, 'error');
    });
  }

  stop(): void {
    this.stopping = true;
    this.share.stop();
    this.stopping = false;
  }

  /** The bridge connection went live (or away): a new connection is told whether this game shares. */
  setConnected(live: boolean): void {
    if (live === this.connected) return;
    this.connected = live;
    this.reported = null;
    if (live) this.report();
  }

  onMessage(m: ScreenMessage): void {
    if (m.t === 'screen.frame_request') {
      this.share.refresh();
      this.responder.request(m.req_id);
      return;
    }
    this.grabbed.push({ requester: m.requester, floor: m.floor });
    if (this.grabbed.length > 20) this.grabbed.shift();
    this.host.toast(`${m.requester} looked at your screen`, 'info');
  }

  /** Puts the share (or the sign) on the loaded floor's TV; call after a floor is built. */
  paint(): void {
    const cur = this.texture.current;
    this.host.office()?.setScreen(cur?.texture ?? null, cur?.w ?? 0, cur?.h ?? 0, cur?.paused ?? false);
  }

  private changed(v: ShareView): void {
    const was = this.last;
    this.last = v;
    this.control.set(v);
    if (was.phase === 'live' && (v.phase !== 'live' || v.gen !== was.gen)) this.responder.ended();
    this.host.tvInfo?.(tvLine(v));
    if (was.phase === 'live' && v.phase === 'off' && !this.stopping) this.host.toast('Screen sharing stopped', 'info');
    this.report();
  }

  private report(): void {
    if (!this.connected) return;
    const v = this.share.view;
    const args: CommandArgs['screen.share'] = v.phase === 'live' ? { sharing: true, ...(v.surface ? { surface: v.surface } : {}) } : { sharing: false };
    const key = JSON.stringify(args);
    if (key === this.reported) return;
    this.reported = key;
    this.reports.push(args);
    if (this.reports.length > 50) this.reports.shift();
    void this.host.send('screen.share', args);
  }

  dispose(): void {
    this.texture.dispose();
    this.share.dispose();
  }
}
