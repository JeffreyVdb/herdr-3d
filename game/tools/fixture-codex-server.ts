// #155: the shared Codex server switch for the fixture server's `sim=1` (tools/fixture-sim.ts hands these commands
// over). Rules, like herdr-world's:
// - the snapshot's `codex_server` is `{enabled, available}`, off by default; `available` is false with
//   `simfail=no_codex_run` (a bridge without its --codex-run directory);
// - `codex_server.set {enabled}` refuses a missing `enabled` (`bad_request`) and switching on while unavailable
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

  constructor(
    private readonly h: CodexServerHost,
    private readonly available: boolean,
    private readonly unverified = false,
  ) {}

  /** #186: how a hire of `harness` was launched (the ack's and the worker's `codex`), when it is not the usual way. */
  hire(harness: string): { mode: 'legacy'; note: string } | undefined {
    if (!this.enabled || !this.unverified || harness !== 'codex') return undefined;
    return {
      mode: 'legacy',
      note: 'shared Codex server: unsupported Codex version: "codex-cli 0.162.0" (supported: codex-cli 0.160.x or 0.161.x); started the usual way',
    };
  }

  view(): Obj {
    return { enabled: this.enabled, available: this.available };
  }

  decorate(world: Obj): void {
    world.codex_server = this.view();
  }

  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void): boolean {
    if (t !== 'codex_server.get' && t !== 'codex_server.set') return false;
    if (t === 'codex_server.set') {
      if (typeof a.enabled !== 'boolean') throw this.h.error('bad_request', 'bad args: enabled is required');
      if (a.enabled && !this.available) throw this.h.error('unsupported', 'unsupported: this bridge has no private run directory for Codex servers');
      if (a.enabled !== this.enabled) {
        this.enabled = a.enabled;
        this.h.emit(send, { t: 'codex_server.update', ...this.view() });
      }
    }
    ack(this.view());
    return true;
  }
}
