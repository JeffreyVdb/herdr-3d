// A throwaway herdr session owned by a test, like the Go integration test
// (internal/app/integration_test.go): a headless `herdr --session <name> server`
// with herdr pane / Claude variables stripped. Every herdr call is checked to
// target that session only; `cleanup()` stops and deletes it, also on failure,
// and removes the `herdr-s-<name>` systemd unit a bridge wake may have made.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { openSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const PREFIX = 'h3d-m2game-';
/** Name prefixes this helper may create and touch (M2 latency, M3 floors). */
export const PREFIXES = [PREFIX, 'h3d-m3game-'];
const ours = (name: string) => PREFIXES.some((p) => name.startsWith(p)) && /^[A-Za-z0-9._-]{1,64}$/.test(name);

/** process.env without HERDR_* and CLAUDE* (they retarget herdr at the caller's own pane). */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('HERDR_') && !k.startsWith('CLAUDE')) out[k] = v;
  return out;
}

export function herdrBin(): string {
  try {
    return execFileSync('sh', ['-c', 'command -v herdr'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('herdr is not installed');
  }
}

interface SessionInfo {
  name: string;
  running: boolean;
  session_dir: string;
  socket_path: string;
}

export function listSessions(bin = herdrBin()): SessionInfo[] {
  const out = execFileSync(bin, ['session', 'list', '--json'], { env: cleanEnv(), encoding: 'utf8', timeout: 15_000 });
  return (JSON.parse(out) as { sessions: SessionInfo[] }).sessions;
}

/** Runs herdr against the named throwaway session only. */
export function runScoped(name: string, args: string[], bin = herdrBin()): string {
  if (!ours(name)) throw new Error(`refusing to touch non-throwaway session ${name}`);
  const i = args.indexOf('--session');
  const targeted = (i >= 0 && args[i + 1] === name) || (args[0] === 'session' && (args[1] === 'stop' || args[1] === 'delete') && args[2] === name);
  if (!targeted) throw new Error(`herdr call outside the throwaway session: herdr ${args.join(' ')}`);
  return execFileSync(bin, args, { env: cleanEnv(), encoding: 'utf8', timeout: 30_000 });
}

/**
 * Stops and forgets the transient unit `herdr-s-<name>` that the bridge's
 * `floor.wake` starts (systemd-run --user --collect). Only for our own
 * throwaway names; returns problems instead of throwing.
 */
export function removeWakeUnit(name: string): string[] {
  if (!ours(name)) return [`refusing to touch the unit of non-throwaway session ${name}`];
  const unit = `herdr-s-${name}.service`;
  const problems: string[] = [];
  const sc = (args: string[]) => execFileSync('systemctl', ['--user', ...args], { env: cleanEnv(), encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
  let active = '';
  try {
    active = sc(['is-active', unit]).trim();
  } catch (e) {
    active = String((e as { stdout?: string }).stdout ?? '').trim();
  }
  if (active === 'active' || active === 'activating' || active === 'deactivating') {
    try {
      sc(['stop', unit]);
    } catch (e) {
      problems.push(`systemctl stop ${unit}: ${String(e)}`);
    }
  }
  try {
    sc(['reset-failed', unit]);
  } catch {
    // Not loaded (collected already): nothing to forget.
  }
  return problems;
}

export class Throwaway {
  readonly name: string;
  private srv: ChildProcess | null = null;
  private exited: Promise<void> = Promise.resolve();
  info: SessionInfo | null = null;
  private readonly bin: string;
  constructor(bin = herdrBin(), prefix = PREFIX) {
    if (!PREFIXES.includes(prefix)) throw new Error(`unknown throwaway prefix ${prefix}`);
    this.bin = bin;
    this.name = prefix + randomBytes(4).toString('hex');
  }

  async start(cwd: string, log: string): Promise<void> {
    if (listSessions(this.bin).some((s) => s.name === this.name)) throw new Error(`session ${this.name} already exists`);
    const fd = openSync(log, 'a');
    this.srv = spawn(this.bin, ['--session', this.name, 'server'], { env: cleanEnv(), cwd, stdio: ['ignore', fd, fd], detached: true });
    const srv = this.srv;
    this.exited = new Promise((res) => srv.once('exit', () => res()));
    const deadline = Date.now() + 15_000;
    for (;;) {
      this.info = listSessions(this.bin).find((s) => s.name === this.name) ?? null;
      if (this.info?.running) return;
      if (Date.now() > deadline) throw new Error(`throwaway herdr server ${this.name} did not come up`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  run(args: string[]): string {
    return runScoped(this.name, args, this.bin);
  }

  /** Stop herdr's way (saves state), then delete the session. Safe to call twice. */
  async cleanup(): Promise<string[]> {
    const problems: string[] = [];
    if (!this.srv) return problems;
    try {
      runScoped(this.name, ['session', 'stop', this.name, '--json'], this.bin);
    } catch (e) {
      problems.push(`stop: ${String(e)}`);
    }
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10_000));
    if ((await Promise.race([this.exited.then(() => 'ok' as const), timeout])) === 'timeout') {
      problems.push(`herdr server for ${this.name} did not exit; killing it`);
      this.srv.kill('SIGTERM');
      await Promise.race([this.exited, new Promise((r) => setTimeout(r, 3000))]);
      this.srv.kill('SIGKILL');
    }
    // A server the bridge woke runs in its own unit, not as our child: wait
    // for herdr to report it stopped before deleting.
    for (let i = 0; i < 50 && listSessions(this.bin).some((s) => s.name === this.name && s.running); i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    problems.push(...removeWakeUnit(this.name));
    try {
      runScoped(this.name, ['session', 'delete', this.name, '--json'], this.bin);
    } catch (e) {
      problems.push(`delete: ${String(e)}`);
    }
    if (listSessions(this.bin).some((s) => s.name === this.name)) problems.push(`session ${this.name} still listed`);
    this.srv = null;
    return problems;
  }
}
