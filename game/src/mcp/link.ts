import type * as THREE from 'three/webgpu';
import type { CommandResult } from '../net/client';
import type { McpHarness, McpRequest, McpSnapshot } from '../net/protocol';
import { HostWatchGate } from '../world/hostStats';
import { hudLine, MCP_POLL_MS, wallModel, type McpWallModel, type Received } from '../world/mcp';

/** The bridge answers a first read within 10 s per provider (then `pending`); a check takes up to 20 s. Room on top of both. */
export const INVENTORY_TIMEOUT_MS = 25_000;
export const CHECK_TIMEOUT_MS = 45_000;

/** What the link needs of the floor's office (render/office.ts). */
export interface McpOffice {
  readonly id: string;
  /** Whether the wall screen is in view of `camera` (big enough on it to be looked at). */
  tickMcp(camera: THREE.Camera): boolean;
  /** The screen's picture; it redraws only when `key` changed. */
  setMcpScreen(m: McpWallModel): void;
}

export interface McpLinkDeps {
  request(t: 'mcp.inventory' | 'mcp.check', args: McpRequest & { harness?: McpHarness }, timeoutMs: number): Promise<CommandResult>;
  /** The look-at bar's line for the screen changed. */
  hudInfo(line: string): void;
  /** Whether the bridge has answered `unknown_command` to `mcp.inventory` (the app's `unsupported` set), and noting that it has. */
  unsupported(): boolean;
  markUnsupported(): void;
  /** Milliseconds, monotonic (the in-view gate and the poll period). */
  now(): number;
  /** Milliseconds, the wall clock (`Date.now`): the ages of what the bridge read. */
  clock(): number;
  /** What the overview page shows changed (a Snapshot came, a request went out or ended, the context moved). */
  changed(): void;
}

export interface McpStep {
  office: McpOffice | null;
  /** You stand on an office floor (not the lobby, its fire escape, the street or the city) and the plan view is shut. */
  here: boolean;
  /** The tab is visible and the bridge is connected: only then is the bridge asked. */
  live: boolean;
  /** The bridge is connected (a hidden tab keeps what it has; a dropped connection does not). */
  connected: boolean;
  /** The floor the overview page is open for (null: shut). */
  page: string | null;
  camera: THREE.Camera;
}

/**
 * A floor's chosen context: `cwd` absent is the floor's default checkout (the bridge picks it), null user scope only;
 * `codex_profile` absent is the default profile. The overview's selectors set it; the wall shows the same one.
 */
export interface McpChoice {
  cwd?: string | null;
  codex_profile?: string;
}

/** One request the link sent, and what came of it (test hook). */
export interface McpLogEntry {
  t: 'mcp.inventory' | 'mcp.check';
  key: string;
  args: McpRequest & { harness?: McpHarness };
  /** ok, an error code, or `dropped` (the reply was for a context that is no longer shown). */
  result?: 'ok' | 'dropped' | string;
}

/** What the overview page reads of the link. */
export interface McpView {
  floor: string;
  choice: McpChoice;
  /** The Snapshot of exactly this context, and when it came (null: none yet). */
  received: Received | null;
  /** An `mcp.inventory` for this context is out. */
  asking: boolean;
  /** A check per provider for this context is out. */
  checking: Record<McpHarness, boolean>;
  /** The bridge refused this context (an unknown profile, a checkout that is gone): its words. */
  error: string | null;
  unsupported: boolean;
  live: boolean;
}

/**
 * #196: what the game does around the MCP & skills wall: it asks `mcp.inventory` only while the screen is in view on the
 * floor you stand on (after 300 ms of it, `HostWatchGate`, and not past 3 s after you look away) or the overview page is
 * open, the tab visible and the bridge connected; then every `MCP_POLL_MS` while that lasts, one request at a time. An
 * old bridge (`unknown_command`) gets the calm "No MCP inventory on this bridge" screen and is never asked again.
 *
 * Every request carries the context it was made for, its key: the floor, the chosen checkout and Codex profile, and the
 * connection's generation. A reply whose key is not the shown one any more (the floor, checkout or profile changed, the
 * connection dropped) is dropped, never shown (AC6). Checks (`mcp.check`) go only from the page's buttons, one per
 * provider and context at a time, keyed the same way.
 */
export class McpLink {
  private readonly gate = new HostWatchGate({ onMs: 300, offMs: 3000 });
  private readonly choices = new Map<string, McpChoice>();
  private gen = 0;
  private floor: string | null = null;
  private live = false;
  private connected = false;
  private office: McpOffice | null = null;
  private got: { key: string; r: Received } | null = null;
  private err: { key: string; text: string } | null = null;
  /** The key of the inventory request out, and when it went (monotonic). */
  private out: string | null = null;
  private askedKey: string | null = null;
  private askedAt = -Infinity;
  private readonly checks = new Set<string>();
  private fed = '';
  private hud = '';
  private wanted = false;
  readonly log: McpLogEntry[] = [];

  constructor(private readonly d: McpLinkDeps) {}

  /** The context key of a floor's choice on this connection. */
  private keyOf(floor: string, c: McpChoice): string {
    return JSON.stringify([floor, c.cwd === undefined ? '~default' : c.cwd, c.codex_profile ?? '~default', this.gen]);
  }

  private get key(): string | null {
    return this.floor === null ? null : this.keyOf(this.floor, this.choice(this.floor));
  }

  choice(floor: string): McpChoice {
    return this.choices.get(floor) ?? {};
  }

  /** The overview's selectors: another checkout (`cwd`: null user scope, undefined the floor's default) or Codex profile (undefined: the default). */
  choose(floor: string, c: McpChoice): void {
    const was = this.choice(floor);
    const next: McpChoice = {};
    if (c.cwd !== undefined) next.cwd = c.cwd;
    if (c.codex_profile !== undefined) next.codex_profile = c.codex_profile;
    if (was.cwd === next.cwd && was.codex_profile === next.codex_profile) return;
    this.choices.set(floor, next);
    this.d.changed();
    // A new context is asked at once (the page is open: it is wanted), and its predecessor's reply will be dropped.
    if (floor === this.floor) this.poll(true);
  }

  /** Once per frame. */
  step(s: McpStep): void {
    const now = this.d.now();
    if (s.office !== this.office) {
      this.office = s.office;
      this.fed = '';
    }
    const floor = s.page ?? (s.here ? (s.office?.id ?? null) : null);
    if (floor !== this.floor) {
      this.floor = floor;
      this.d.changed();
    }
    if (s.connected !== this.connected) {
      // A dropped connection takes its requests with it: their replies (if any come) are for another generation.
      if (!s.connected) this.connLost();
      this.connected = s.connected;
      this.d.changed();
    }
    this.live = s.live;
    const inView = s.office ? s.office.tickMcp(s.camera) : false;
    if (s.here && s.live && s.office !== null && !this.d.unsupported()) this.gate.step(now, inView);
    else this.gate.release();
    this.wanted = s.live && !this.d.unsupported() && this.floor !== null && (s.page !== null || this.gate.watching);
    if (this.wanted) this.poll(false);
    this.feed();
  }

  /** The connection dropped: what was out is for an old generation now. */
  connLost(): void {
    this.gen++;
    this.out = null;
    this.checks.clear();
    this.askedKey = null;
    this.gate.reset();
  }

  /** The page's Refresh: ask now (unless that very request is out). */
  refresh(): void {
    this.poll(true);
  }

  /** The page's "Check connections" for one provider: `mcp.check` for the shown context, once at a time. */
  check(h: McpHarness): void {
    const key = this.key;
    const floor = this.floor;
    if (key === null || floor === null || !this.live || this.d.unsupported() || this.checks.has(`${key}|${h}`)) return;
    this.checks.add(`${key}|${h}`);
    const args = { ...this.args(floor), harness: h };
    const entry: McpLogEntry = { t: 'mcp.check', key, args };
    this.push(entry);
    this.d.changed();
    void this.d.request('mcp.check', args, CHECK_TIMEOUT_MS).then((r) => {
      this.checks.delete(`${key}|${h}`);
      this.settle(entry, key, r);
    });
  }

  private args(floor: string): McpRequest {
    const c = this.choice(floor);
    const a: McpRequest = { floor };
    if (c.cwd !== undefined) a.cwd = c.cwd;
    if (c.codex_profile !== undefined) a.codex_profile = c.codex_profile;
    return a;
  }

  private poll(force: boolean): void {
    const key = this.key;
    const floor = this.floor;
    if (key === null || floor === null || !this.live || this.d.unsupported()) return;
    if (!force && !this.wanted) return;
    if (this.out === key) return; // that very request is out
    const now = this.d.now();
    if (!force && this.askedKey === key && now - this.askedAt < MCP_POLL_MS) return;
    this.askedKey = key;
    this.askedAt = now;
    this.out = key;
    const args = this.args(floor);
    const entry: McpLogEntry = { t: 'mcp.inventory', key, args };
    this.push(entry);
    this.d.changed();
    void this.d.request('mcp.inventory', args, INVENTORY_TIMEOUT_MS).then((r) => {
      if (this.out === key) this.out = null;
      this.settle(entry, key, r);
    });
  }

  private settle(entry: McpLogEntry, key: string, r: CommandResult): void {
    if (!r.ok && r.code === 'unknown_command') {
      entry.result = r.code;
      this.d.markUnsupported();
      this.gate.reset();
      this.d.changed();
      return;
    }
    if (key !== this.key) {
      entry.result = 'dropped';
      return;
    }
    if (r.ok) {
      entry.result = 'ok';
      this.got = { key, r: { snap: r.data as McpSnapshot, at: this.d.clock() } };
      if (this.err?.key === key) this.err = null;
    } else {
      entry.result = r.code;
      // A timeout or a dropped socket is tried again on the next poll; the bridge's refusal of the context is shown.
      if (r.code !== 'timeout' && r.code !== 'disconnected' && r.code !== 'offline') this.err = { key, text: refusalText(r.code, r.message) };
    }
    this.d.changed();
    this.feed();
  }

  private push(e: McpLogEntry): void {
    this.log.push(e);
    if (this.log.length > 400) this.log.shift();
  }

  /** The shown context's Snapshot (never another context's). */
  private shown(): Received | null {
    const key = this.key;
    return this.got && key !== null && this.got.key === key ? this.got.r : null;
  }

  model(): McpWallModel {
    const key = this.key;
    return wallModel({
      unsupported: this.d.unsupported(),
      live: this.connected,
      asking: this.out !== null && this.out === key,
      r: this.shown(),
      error: this.err && this.err.key === key ? this.err.text : null,
      now: this.d.clock(),
    });
  }

  private feed(): void {
    const m = this.model();
    const o = this.office;
    if (o && m.key !== this.fed) {
      this.fed = m.key;
      o.setMcpScreen(m);
    }
    const hud = hudLine(m);
    if (hud !== this.hud) {
      this.hud = hud;
      this.d.hudInfo(hud);
    }
  }

  /** What the overview page shows for `floor` (its context must be the shown one: the page is open on the floor you are on). */
  view(floor: string): McpView {
    const c = this.choice(floor);
    const key = this.keyOf(floor, c);
    const mine = floor === this.floor;
    return {
      floor,
      choice: c,
      received: mine ? this.shown() : null,
      asking: mine && this.out === key,
      checking: { claude: this.checks.has(`${key}|claude`), codex: this.checks.has(`${key}|codex`) },
      error: mine && this.err?.key === key ? this.err.text : null,
      unsupported: this.d.unsupported(),
      live: this.connected,
    };
  }

  /** What the link knows (test hook). */
  info(): { floor: string | null; key: string | null; wanted: boolean; watching: boolean; asking: boolean; mode: McpWallModel['mode']; hud: string; context: McpSnapshot['context'] | null } {
    return { floor: this.floor, key: this.key, wanted: this.wanted, watching: this.gate.watching, asking: this.out !== null && this.out === this.key, mode: this.model().mode, hud: this.hud, context: this.shown()?.snap.context ?? null };
  }
}

/** The bridge's refusal of a context in words: an unknown Codex profile, a checkout that is not a directory any more. */
export function refusalText(code: string, message: string): string {
  if (code === 'not_found') return 'That Codex profile is not on the bridge any more. Pick another.';
  if (code === 'bad_request') return 'That checkout is not a folder on the bridge any more. Pick another.';
  return message || `The bridge said ${code}.`;
}
