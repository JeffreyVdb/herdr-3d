import { describe, expect, it } from 'vitest';
import type { ManualProcess, Worker } from '../net/protocol';
import { commandRequestOf, ManualProcessBook, needsAttention } from './manualProcess';

const worker = (request: unknown) => ({ command_request: request }) as Pick<Worker, 'command_request'>;
const cmd = { command: 'printf "hello\\n"\ntrue', cwd: '/tmp', cwd_named: false, host: 'bridge' };
const process = (id: string, state: ManualProcess['state'], cleanup: ManualProcess['cleanup']) => ({ id, worker: 'w', state, cleanup }) as ManualProcess;

describe('manual processes', () => {
  it('accepts exact multi-line commands and optional fields, rejects malformed requests', () => {
    const request = { key: 'turn', at: 1, commands: [cmd] };
    expect(commandRequestOf(worker(request))?.commands[0]?.command).toBe(cmd.command);
    expect(commandRequestOf(worker({ ...request, commands: [{ ...cmd, host: 'elsewhere' }] }))).toBeNull();
    expect(commandRequestOf(worker({ ...request, commands: [{ ...cmd, variants: [{ label: 'bad' }] }] }))).toBeNull();
  });
  it('replaces snapshots, upserts and removes records, retaining cleanup needing attention', () => {
    const b = new ManualProcessBook();
    b.reset([process('a', 'running', 'none'), process('b', 'exited', 'needed')]);
    expect(b.all().filter(needsAttention)).toHaveLength(2);
    b.upsert(process('a', 'stopped', 'done'));
    expect(b.all().filter(needsAttention)).toHaveLength(1);
    b.removed('b');
    expect(b.all().map((p) => p.id)).toEqual(['a']);
    b.reset(undefined);
    expect(b.known).toBe(false);
    expect(b.all()).toEqual([]);
  });
});
