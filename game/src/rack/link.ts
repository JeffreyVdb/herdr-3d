import type * as THREE from 'three/webgpu';
import type { CommandResult } from '../net/client';
import type { HostDiskRate, HostMessage, HostStats } from '../net/protocol';
import { HostWatchGate, hudLine, rackMode, STALE_MS, type GateAction, type RackMode } from '../world/hostStats';

/** The disk frames come every second; with none for this long the LEDs fall back to their calm blink. */
export const DISK_LIVE_MS = 3000;

/** What the link needs of the floor's office (render/office.ts). */
export interface RackOffice {
  tickRack(camera: THREE.Camera): boolean;
  setRackDisks(disks: readonly HostDiskRate[] | null): void;
  setRackScreen(mode: RackMode, frame: HostStats | null): void;
  setRackMotion(on: boolean): void;
}

export interface RackLinkDeps {
  request(t: 'host.watch' | 'host.unwatch'): Promise<CommandResult>;
  /** The look-at bar's line for the rack changed. */
  hudInfo(line: string): void;
  /** Whether the bridge has answered `unknown_command` to host.watch (the app's `unsupported` set), and noting that it has. */
  unsupported(): boolean;
  markUnsupported(): void;
  /** Milliseconds, monotonic. */
  now(): number;
}

export interface RackStep {
  office: RackOffice | null;
  /** You stand on an office floor (not the lobby, its fire escape, the street or the city) and the plan view is shut. */
  here: boolean;
  /** The tab is visible and the bridge is connected. */
  live: boolean;
  /** Battery saver or reduced motion. */
  calm: boolean;
  camera: THREE.Camera;
}

/**
 * What the game does around the server rack (#74): it asks the bridge to sample (`host.watch`) only while the rack is in
 * view on the floor you stand on, the tab is visible and the bridge is connected, after 300 ms of it and with a 10 s
 * grace after you look away (`HostWatchGate`), and ends the watch at once on a hidden tab, another floor or a dropped
 * connection. It feeds the office's rack the frames it hears (the screen is redrawn once per `host.stats`, the LEDs'
 * rates written once per `host.disk`) and the HUD's line. An old bridge (`unknown_command`) gets the calm idle screen.
 */
export class RackLink {
  private readonly gate = new HostWatchGate();
  private frame: HostStats | null = null;
  private frameAt = 0;
  private rev = 0;
  /** The last frame was old (STALE_MS) when this watch began and no newer one has come. */
  private stale = false;
  private disks: readonly HostDiskRate[] | null = null;
  private diskAt = -Infinity;
  private disksDirty = false;
  private office: RackOffice | null = null;
  private fed = '';
  private diskLive = false;
  private calm: boolean | null = null;
  private hud = '';
  /** The commands sent, with their answers (test hook). */
  readonly log: Array<{ t: 'host.watch' | 'host.unwatch'; result?: CommandResult }> = [];

  constructor(private readonly d: RackLinkDeps) {}

  /** A `host.stats` or `host.disk` frame of this connection's watch. */
  onMessage(m: HostMessage): void {
    if (m.t === 'host.stats') {
      this.frame = m;
      this.frameAt = this.d.now();
      this.stale = false;
      this.rev++;
    } else {
      this.disks = m.disks;
      this.diskAt = this.d.now();
      this.disksDirty = true;
    }
  }

  /** Once per frame. */
  step(s: RackStep): void {
    const now = this.d.now();
    if (s.office !== this.office) {
      // Another floor (or none): its predecessor's watch ends at once; the new office is fed everything again.
      this.send(this.gate.release());
      this.office = s.office;
      this.fed = '';
      this.diskLive = false;
      this.disksDirty = this.disks !== null;
      this.calm = null;
    }
    const o = this.office;
    if (!o) return;
    const inView = o.tickRack(s.camera);
    if (!s.here || !s.live || this.d.unsupported()) this.send(this.gate.release());
    else this.send(this.gate.step(now, inView));
    this.feed(o, now, s.calm);
  }

  /** The tab went hidden: the watch ends at once. */
  hidden(): void {
    this.send(this.gate.release());
  }

  /** The connection dropped: the bridge forgot the watch with it. */
  connLost(): void {
    this.gate.reset();
  }

  private send(a: GateAction): void {
    if (!a) return;
    const t = a === 'watch' ? 'host.watch' : 'host.unwatch';
    if (a === 'watch') this.stale = this.frame !== null && this.d.now() - this.frameAt > STALE_MS;
    const entry: (typeof this.log)[number] = { t };
    this.log.push(entry);
    if (this.log.length > 400) this.log.shift();
    void this.d.request(t).then((r) => {
      entry.result = r;
      if (!r.ok && r.code === 'unknown_command') {
        this.d.markUnsupported();
        this.gate.reset();
      }
    });
  }

  private mode(): RackMode {
    return rackMode({ unsupported: this.d.unsupported(), hasFrame: this.frame !== null, watching: this.gate.watching, stale: this.stale });
  }

  private feed(o: RackOffice, now: number, calm: boolean): void {
    if (calm !== this.calm) {
      this.calm = calm;
      o.setRackMotion(!calm);
    }
    // The LEDs: live while this watch hears disk frames, the calm blink otherwise. Written when a frame came or that changed.
    const live = this.gate.watching && this.disks !== null && now - this.diskAt <= DISK_LIVE_MS;
    if (live !== this.diskLive || (live && this.disksDirty)) {
      this.diskLive = live;
      o.setRackDisks(live ? this.disks : null);
    }
    this.disksDirty = false;
    // The screen: redrawn only when the mode or the frame changed.
    const mode = this.mode();
    const key = `${mode}|${this.rev}`;
    if (key !== this.fed) {
      this.fed = key;
      o.setRackScreen(mode, this.frame);
    }
    const hud = hudLine(this.frame, mode === 'unsupported');
    if (hud !== this.hud) {
      this.hud = hud;
      this.d.hudInfo(hud);
    }
  }

  /** What the link knows (test hook). */
  info(): { watching: boolean; mode: RackMode; stale: boolean; frames: number; hud: string } {
    return { watching: this.gate.watching, mode: this.mode(), stale: this.stale, frames: this.rev, hud: this.hud };
  }
}
