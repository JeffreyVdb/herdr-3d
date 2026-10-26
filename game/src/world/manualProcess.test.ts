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

it('routes snapshot and live process events into the world book', async () => {
  const { WorldStore } = await import('./store');
  const { isWorldEvent } = await import('../net/protocol');
  const store = new WorldStore();
  store.applySnapshot({ t: 'world.snapshot', seq: 1, world: { buildings: [], unassigned: [], floors: [], workers: [], host: 'bridge', manual_processes: [process('a', 'running', 'none')] } });
  expect(store.host).toBe('bridge');
  const upsert = { t: 'manual_process.upsert', seq: 2, process: process('a', 'exited', 'needed') } as const;
  expect(isWorldEvent(upsert)).toBe(true);
  store.applyEvent(upsert);
  expect(store.manualProcesses.get('a')?.cleanup).toBe('needed');
  const removed = { t: 'manual_process.removed', seq: 3, id: 'a' } as const;
  expect(isWorldEvent(removed)).toBe(true);
  store.applyEvent(removed);
  expect(store.manualProcesses.get('a')).toBeUndefined();
  expect(isWorldEvent({ t: 'manual_process.upsert', seq: 4, process: {} } as never)).toBe(false);
});
