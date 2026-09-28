// A throwaway herdr session owned by a test, like the Go integration test
// (internal/app/integration_test.go): a headless `herdr --session <name> server`
// with herdr pane / Claude variables stripped. Every herdr call is checked to
// target that session only; `cleanup()` stops and deletes it, also on failure.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { openSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const PREFIX = 'h3d-m2game-';

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
  if (!name.startsWith(PREFIX)) throw new Error(`refusing to touch non-throwaway session ${name}`);
  const i = args.indexOf('--session');
  const targeted = (i >= 0 && args[i + 1] === name) || (args[0] === 'session' && (args[1] === 'stop' || args[1] === 'delete') && args[2] === name);
  if (!targeted) throw new Error(`herdr call outside the throwaway session: herdr ${args.join(' ')}`);
  return execFileSync(bin, args, { env: cleanEnv(), encoding: 'utf8', timeout: 30_000 });
}

export class Throwaway {
  readonly name = PREFIX + randomBytes(4).toString('hex');
  private srv: ChildProcess | null = null;
  private exited: Promise<void> = Promise.resolve();
  info: SessionInfo | null = null;
  private readonly bin: string;
  constructor(bin = herdrBin()) {
    this.bin = bin;
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
