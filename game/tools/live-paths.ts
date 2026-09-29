// A live check's private bridge paths, scoped to its run: the socket under
// $XDG_RUNTIME_DIR/<scope>/<run>/ and the database under /tmp/<scope>/<run>/.
// Runs in parallel worktrees never share, replace or remove each other's.
import { mkdirSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface RunPaths {
  sockDir: string;
  sock: string;
  dbDir: string;
  db: string;
}

/** The paths of run `run` (unique: the run's mkdtemp name) of a live check `scope` (`h3d-m5integ`). */
export function runPaths(scope: string, run: string, runtime: string, tmp = '/tmp'): RunPaths {
  if (!/^[\w.-]+$/.test(scope) || !/^[\w.-]+$/.test(run) || run === '.' || run === '..') throw new Error(`bad live run ${scope}/${run}`);
  const sockDir = join(runtime, scope, run);
  const dbDir = join(tmp, scope, run);
  return { sockDir, sock: join(sockDir, 'bridge.sock'), dbDir, db: join(dbDir, 'world.db') };
}

/** Makes the run's directories (the socket's private to you). */
export function makeRunPaths(p: RunPaths): void {
  mkdirSync(p.sockDir, { recursive: true, mode: 0o700 });
  mkdirSync(p.dbDir, { recursive: true });
}

/** Removes the run's directories, and the scope's once no other run is left in it. */
export function removeRunPaths(p: RunPaths): void {
  for (const d of [p.sockDir, p.dbDir]) {
    rmSync(d, { recursive: true, force: true });
    try {
      rmdirSync(dirname(d)); // only when empty
    } catch {
      // another run is in it (or it is gone)
    }
  }
}
