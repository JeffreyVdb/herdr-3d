import { describe, expect, it } from 'vitest';
import type { Worker } from '../src/net/protocol';
import { ManualProcessSim } from './fixture-manualproc';

describe('manual process fixture', () => {
  it('keeps start ops idempotent and retries credentials without storing the password', () => {
    const workers = [{ id: 'w', name: 'Zippy', session: 'floor', cwd: '/work' }] as Worker[];
    const events: Record<string, unknown>[] = []; const later: Array<() => void> = [];
    const sim = new ManualProcessSim({ workers, now: () => 1000, emit: (_s, e) => events.push(structuredClone(e)), upsert: () => {}, final: () => {}, later: (fn) => later.push(fn) }, undefined, 'sudo');
    sim.seed();
    const result: unknown[] = [];
    const handle = (t: string, args: Record<string, unknown>) => sim.handle(t, args, () => {}, (v) => result.push(v), (e) => { throw e; });
    const request = workers[0]!.command_request!;
    handle('manual_process.start', { op: 'once', worker: 'w', command: request.commands[0]!.command, source: { kind: 'suggestion', key: request.key, index: 0 }, askpass: true });
    handle('manual_process.start', { op: 'once', worker: 'w', command: 'different' });
    expect(result[0]).toEqual(result[1]);
    later[0]!();
    const p = (events.at(-1)!.process as { id: string; credential: { request: string } });
    handle('manual_process.credential', { id: p.id, request: p.credential.request, secret: 'synthetic-wrong' });
    const retry = (events.at(-1)!.process as { credential: { request: string; attempt: number } }).credential;
    expect(retry.attempt).toBe(2);
    handle('manual_process.credential', { id: p.id, request: retry.request, secret: 'fixture-pass' });
    expect(JSON.stringify(events)).not.toContain('synthetic-wrong');
    expect(JSON.stringify(events)).not.toContain('fixture-pass');
    expect((events.at(-1)!.process as { state: string }).state).toBe('running');
  });
});
