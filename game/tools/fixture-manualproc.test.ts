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

  it('#213: plays attention episodes: the credential request, confirmed and uncertain input, two runs, clear and exit', () => {
    const workers = [{ id: 'w', name: 'Zippy', session: 'floor', cwd: '/work' }] as Worker[];
    type P = { id: string; state: string; attention?: { id: string; kind: string; confidence: string; reason: string }; input_detection?: string; credential?: unknown; launched?: string };
    const events: Array<{ process?: P }> = []; const later: Array<() => void> = [];
    const sim = new ManualProcessSim({ workers, now: () => 1000, emit: (_s, e) => events.push(structuredClone(e) as never), upsert: () => {}, final: () => {}, later: (fn) => later.push(fn) }, undefined, 'sudo-k');
    sim.seed();
    expect(workers[0]!.command_request!.commands[0]!.command).toBe('sudo -k python3 tools/hello_world_server.py 80\n');
    const handle = (t: string, args: Record<string, unknown>) => sim.handle(t, args, () => {}, () => {}, (e) => { throw e; });
    handle('manual_process.start', { op: 'a', worker: 'w', command: 'sudo -k python3 tools/hello_world_server.py 80\n', askpass: true });
    handle('manual_process.start', { op: 'b', worker: 'w', command: 'read x' });
    later.forEach((fn) => fn());
    const last = (id: string) => events.filter((e) => e.process?.id === id).at(-1)!.process!;
    const [a, b] = ['mp_00000001', 'mp_00000002'];
    expect(last(a)).toMatchObject({ state: 'waiting', launched: 'sudo -A -k python3 tools/hello_world_server.py 80\n', attention: { kind: 'credential', confidence: 'authenticated', reason: 'askpass' }, input_detection: 'hints' });
    expect(last(a).attention!.id).toBe((last(a).credential as { request: string }).request);
    handle('sim.manual_attention', { id: b, attention: 'confirmed' });
    expect(last(b)).toMatchObject({ state: 'waiting', attention: { kind: 'input', confidence: 'confirmed', reason: 'tty_read' } });
    handle('sim.manual_attention', { id: b, attention: 'uncertain' });
    expect(last(b)).toMatchObject({ state: 'running', attention: { kind: 'input', confidence: 'uncertain' } });
    handle('sim.manual_attention', { id: b, attention: 'clear' });
    expect(last(b).attention).toBeUndefined();
    handle('manual_process.credential', { id: a, request: (last(a).credential as { request: string }).request, cancel: true });
    expect(last(a)).toMatchObject({ state: 'exited' });
    expect(last(a).attention).toBeUndefined();
  });
});
