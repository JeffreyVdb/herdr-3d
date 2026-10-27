import { describe, expect, it } from 'vitest';
import type { ManualAttention, ManualProcess, Worker } from '../net/protocol';
import { attentionCount, attentionDetail, attentionLabel, AttentionEpisodes, attentionOf, commandRequestOf, detectionNote, ManualProcessBook, needsAttention, openAttention, shortCommand } from './manualProcess';

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

describe('#213 attention', () => {
  const run = (o: Partial<ManualProcess> = {}) => ({ id: 'p', worker: 'w', state: 'running', cleanup: 'none', command: 'sudo -k id\nprintf done', title: 'sudo -k id', created_at: 1, ...o }) as ManualProcess;
  const input = (confidence: string, reason = 'tty_read', id = 'ep1') => ({ id, kind: 'input', confidence, reason, since: 10 }) as unknown as ManualAttention;
  const credential = { request: 'cr_1', prompt: '[sudo] password for fixture:', user: 'root', attempt: 1, expires_at: 99 };

  it('words each kind by its certainty; an input episode is never a password request', () => {
    const confirmed = attentionOf(run({ attention: input('confirmed') }))!;
    const uncertain = attentionOf(run({ attention: input('uncertain', 'tty_wait') }))!;
    const sudoTerm = attentionOf(run({ attention: input('uncertain', 'sudo_terminal') }))!;
    expect([attentionLabel(confirmed), attentionLabel(uncertain)]).toEqual(['Waiting for input', 'May be waiting for input']);
    for (const a of [confirmed, uncertain, sudoTerm]) expect(`${attentionLabel(a)} ${attentionDetail(a)}`).not.toMatch(/password request|Password requested/);
    const c = attentionOf(run({ state: 'waiting', credential, attention: { id: 'cr_1', kind: 'credential', confidence: 'authenticated', reason: 'askpass', since: 7, expires_at: 99 } }))!;
    expect(c).toEqual({ id: 'cr_1', kind: 'credential', confidence: 'authenticated', reason: 'askpass', since: 7, expires_at: 99 });
    expect(attentionLabel(c)).toBe('Password requested');
  });
  it('renders an unknown reason generically and ignores malformed attention', () => {
    const odd = attentionOf(run({ attention: input('confirmed', 'some_new_code') }))!;
    expect(attentionLabel(odd)).toBe('Waiting for input');
    expect(attentionDetail(odd)).toBe('');
    for (const bad of [null, 'x', {}, { ...input('confirmed'), id: '' }, { ...input('confirmed'), since: 'now' }, { ...input('confirmed'), kind: 'password' }, input('authenticated'), { id: 'x', kind: 'credential', confidence: 'authenticated', reason: 'askpass', since: 1 }, { ...input('confirmed'), expires_at: 'soon' }])
      expect(attentionOf(run({ attention: bad as never }))).toBeNull();
  });
  it('takes the credential field as the episode (an older bridge sends no attention), and nothing once a run ended', () => {
    expect(attentionOf(run({ credential }))?.kind).toBe('credential');
    expect(attentionOf(run({ credential, attention: input('confirmed') }))).toMatchObject({ id: 'cr_1', kind: 'credential' });
    for (const state of ['exited', 'stopped', 'failed'] as const) expect(attentionOf(run({ state, attention: input('confirmed') }))).toBeNull();
  });
  it('orders several runs, counts them and says what detection cannot see', () => {
    const list = openAttention([run({ id: 'b', attention: { ...input('uncertain', 'tty_wait', 'e2'), since: 20 } }), run({ id: 'a', attention: input('uncertain') }), run({ id: 'c' })]);
    expect(list.map((r) => r.process.id)).toEqual(['a', 'b']);
    expect(attentionCount(list)).toBe('2 runs may be waiting for input');
    expect(attentionCount([...list, { process: run(), attention: attentionOf(run({ credential }))! }])).toBe('3 runs need you');
    expect(shortCommand(run())).toBe('sudo -k id');
    expect(shortCommand(run({ command: 'x'.repeat(60) }), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(detectionNote(run({ input_detection: 'hints' }))).toMatch(/may not be detected/);
    expect(detectionNote(run({ input_detection: 'none' }))).toMatch(/not detected/);
    expect(detectionNote(run({ input_detection: 'full' }))).toBeNull();
    expect(detectionNote(run())).toBeNull();
  });
  it('announces an episode once for the page, also across a reconnect snapshot, and reports the ones that closed', () => {
    const e = new AttentionEpisodes();
    const one = openAttention([run({ attention: input('confirmed') })]);
    expect(e.update(one).fresh).toHaveLength(1);
    expect(e.update(one).fresh).toHaveLength(0);
    expect(e.update([])).toEqual({ fresh: [], gone: ['ep1'] });
    expect(e.update(one).fresh).toHaveLength(0); // the same episode after a reconnect
    expect(e.update(openAttention([run({ attention: input('confirmed', 'tty_read', 'ep2') })])).fresh.map((r) => r.attention.id)).toEqual(['ep2']);
  });
});
