import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeRunPaths, removeRunPaths, runPaths } from './live-paths';

describe('live run paths', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it('are scoped to the run: two runs at once never touch each other’s socket or database', () => {
    const root = mkdtempSync(join(tmpdir(), 'h3d-live-paths-'));
    roots.push(root);
    const runtime = join(root, 'run');
    const tmp = join(root, 'tmp');
    const a = runPaths('h3d-m5integ', 'h3d-m5integ-aaaaaa', runtime, tmp);
    const b = runPaths('h3d-m5integ', 'h3d-m5integ-bbbbbb', runtime, tmp);
    expect(a.sock).toBe(join(runtime, 'h3d-m5integ', 'h3d-m5integ-aaaaaa', 'bridge.sock'));
    expect(a.db).toBe(join(tmp, 'h3d-m5integ', 'h3d-m5integ-aaaaaa', 'world.db'));
    expect(a.sock).not.toBe(b.sock);
    expect(a.db).not.toBe(b.db);
    // A Unix socket path must stay short (108 bytes) under a usual runtime dir.
    expect(runPaths('h3d-m5integ', 'h3d-m5integ-aaaaaa', '/run/user/1000').sock.length).toBeLessThan(100);

    makeRunPaths(a);
    makeRunPaths(b);
    for (const p of [a, b]) {
      writeFileSync(p.sock, '');
      writeFileSync(p.db, '');
    }
    removeRunPaths(a);
    expect([existsSync(a.sock), existsSync(a.db)]).toEqual([false, false]);
    expect([existsSync(b.sock), existsSync(b.db)]).toEqual([true, true]);
    removeRunPaths(b);
    expect([existsSync(join(runtime, 'h3d-m5integ')), existsSync(join(tmp, 'h3d-m5integ'))]).toEqual([false, false]);
  });

  it('refuses a run name that could leave the scope', () => {
    expect(() => runPaths('h3d-m5integ', '..', '/run/user/1000')).toThrow();
    expect(() => runPaths('h3d-m5integ', 'a/b', '/run/user/1000')).toThrow();
  });
});
