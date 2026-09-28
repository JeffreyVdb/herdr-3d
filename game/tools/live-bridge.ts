// A private herdr-world for the live specs: started, restarted and stopped by
// the spec itself (the M3 spec restarts it to check what persists). It only
// ever watches the throwaway session it is given (`--sessions ^<name>$`), and
// runs with HERDR_* / CLAUDE* stripped.
import { spawn, type ChildProcess } from 'node:child_process';
import { openSync } from 'node:fs';
import { request } from 'node:http';
import { cleanEnv, PREFIXES } from './herdr-throwaway.ts';

export interface BridgeConfig {
  bin: string;
  socket: string;
  db: string;
  /** The throwaway session, the only one the bridge may see. */
  session: string;
  log: string;
}

export function bridgeHealthy(socket: string): Promise<boolean> {
  return new Promise((res) => {
    const r = request({ socketPath: socket, path: '/healthz' }, (x) => {
      x.resume();
      res(x.statusCode === 200);
    });
    r.on('error', () => res(false));
    r.end();
  });
}

export class LiveBridge {
  private p: ChildProcess | null = null;
  private readonly c: BridgeConfig;

  constructor(c: BridgeConfig) {
    if (!PREFIXES.some((x) => c.session.startsWith(x))) throw new Error(`refusing to watch non-throwaway session ${c.session}`);
    this.c = c;
  }

  async start(): Promise<void> {
    const fd = openSync(this.c.log, 'a');
    const p = spawn(this.c.bin, ['--socket', this.c.socket, '--db', this.c.db, '--sessions', `^${this.c.session}$`, '--log-level', 'debug'], {
      env: cleanEnv(),
      stdio: ['ignore', fd, fd],
    });
    this.p = p;
    for (let i = 0; !(await bridgeHealthy(this.c.socket)); i++) {
      if (i > 150 || p.exitCode !== null) throw new Error(`bridge did not come up (see ${this.c.log})`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async stop(): Promise<void> {
    const p = this.p;
    this.p = null;
    if (!p || p.exitCode !== null) return;
    const gone = new Promise((r) => p.once('exit', r));
    p.kill('SIGTERM');
    if ((await Promise.race([gone.then(() => 'ok'), new Promise((r) => setTimeout(() => r('late'), 5000))])) === 'late') p.kill('SIGKILL');
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }
}
