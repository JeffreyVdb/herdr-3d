// #155: the shared Codex server switch for the fixture server's `sim=1` (tools/fixture-sim.ts hands these commands
// over). Rules, like herdr-world's:
// - the snapshot's `codex_server` is `{enabled, available, allow_unverified}`, off by default; `available` is false with
//   `simfail=no_codex_run` (a bridge without its --codex-run directory);
// - `codex_server.set` patches either preference and refuses an empty patch (`bad_request`) and switching on while unavailable
//   (`unsupported`); a change is a `codex_server.update` with the switch flat in it; the ack is the switch.
// - #186: with `simfail=codex_unverified` (a Codex the shared server is not verified with), a Codex hire while the
//   switch is on falls back as herdr-world's does: its ack and its worker carry `codex: {mode: 'legacy', note}`.
// Otherwise no worker is launched differently here: the hires stay the simulator's.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export interface CodexServerHost {
  emit(send: Send, m: Obj): void;
  error(code: string, message: string): Error;
}

export class CodexServerSim {
  private enabled = false;
  private allowUnverified = false;

  private readonly h: CodexServerHost;
  private readonly available: boolean;
  private readonly unverified: boolean;

  constructor(h: CodexServerHost, available: boolean, unverified = false) {
    this.h = h;
    this.available = available;
    this.unverified = unverified;
  }

  /** #186: how a hire of `harness` was launched (the ack's and the worker's `codex`), when it is not the usual way. */
  hire(harness: string): { mode: 'legacy'; note: string } | undefined {
    if (!this.enabled || this.allowUnverified || !this.unverified || harness !== 'codex') return undefined;
    return {
      mode: 'legacy',
      note: 'shared Codex server: unsupported Codex version: "codex-cli 0.999.0" (supported: codex-cli 0.160.x, 0.161.x, 0.162.x or 0.163.x); started the usual way',
    };
  }

  view(): Obj {
    return { enabled: this.enabled, available: this.available, allow_unverified: this.allowUnverified };
  }

  decorate(world: Obj): void {
    world.codex_server = this.view();
  }

  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void): boolean {
    if (t !== 'codex_server.get' && t !== 'codex_server.set') return false;
    if (t === 'codex_server.set') {
      if (a.enabled === undefined && a.allow_unverified === undefined) throw this.h.error('bad_request', 'bad args: enabled or allow_unverified is required');
      if ((a.enabled !== undefined && typeof a.enabled !== 'boolean') || (a.allow_unverified !== undefined && typeof a.allow_unverified !== 'boolean')) {
        throw this.h.error('bad_request', 'bad args: expected boolean');
      }
      const enabled = typeof a.enabled === 'boolean' ? a.enabled : this.enabled;
      const allowUnverified = typeof a.allow_unverified === 'boolean' ? a.allow_unverified : this.allowUnverified;
      if (enabled && !this.available) throw this.h.error('unsupported', 'unsupported: this bridge has no private run directory for Codex servers');
      if (enabled !== this.enabled || allowUnverified !== this.allowUnverified) {
        this.enabled = enabled;
        this.allowUnverified = allowUnverified;
        this.h.emit(send, { t: 'codex_server.update', ...this.view() });
      }
    }
    ack(this.view());
    return true;
  }
}
