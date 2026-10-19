import { describe, expect, it, vi } from 'vitest';
import type { Worker } from '../src/net/protocol.ts';
import type { AiSim } from './fixture-ai.ts';
import { cleanLine, DigestSim } from './fixture-digest.ts';

// #118: the fixture cleans the LLM's answer like internal/digest's Clean.
describe('fixture floor overview summaries: the line', () => {
  it('keeps the first line, without quotes, markdown or a full stop, clipped', () => {
    expect(cleanLine('"Running the e2e suite."', 100)).toBe('Running the e2e suite');
    expect(cleanLine('\n**Fixing the `login` test**\nmore', 100)).toBe('Fixing the login test');
    expect(cleanLine('x'.repeat(120), 100)).toHaveLength(100);
    expect(cleanLine('```\n```', 100)).toBeNull();
    expect(cleanLine('  ""  ', 100)).toBeNull();
  });
});

// #119: while the fixture's call for a line is out, that line says pending in a worker.upsert of its own (a model's now
// line too, as the bridge does), and the line that comes back goes out without it.
describe('fixture floor overview summaries: pending while a call is out', () => {
  it('says pending for each line in turn, then sends the written lines with no status', async () => {
    const answers: Array<(s: string) => void> = [];
    const ai = {
      present: true,
      ready: () => true,
      fingerprint: () => 'fp',
      view: () => ({ llm: { state: 'ready' } }),
      complete: () => new Promise<string>((r) => answers.push(r)),
    } as unknown as AiSim;
    const worker = { id: 'w', session: 's', workspace_id: 'ws', label: 'w', name: 'w', status: 'working', status_since: 0, title: 'Reading hub.go', digest: { task: 'Port the importer', task_source: 'prompt', now_source: 'title' } } as Worker;
    const sent: Array<Record<string, unknown>> = [];
    const sim = new DigestSim({ workers: [worker], ai, emit: (_s, m) => sent.push(m), error: (c, m) => Object.assign(new Error(m), { code: c }), now: () => 1 });
    const send = () => undefined;
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const answer = async (s: string) => {
      await vi.waitFor(() => expect(answers.length).toBeGreaterThan(0));
      answers.shift()?.(s);
      await tick();
    };
    sim.handle('digest.test', {}, send, () => undefined, () => undefined);
    await answer('Fix the login test');
    await answer('Running the login test');
    sim.handle('digest.set', { enabled: true }, send, () => undefined, () => undefined);
    sim.handle('board.watch', { session: 's' }, send, () => undefined, () => undefined);
    const digests = () => sent.filter((m) => m.t === 'worker.upsert').map((m) => structuredClone((m.worker as Worker).digest));
    await vi.waitFor(() => expect(digests()).toHaveLength(1));
    expect(digests()[0]).toMatchObject({ task_source: 'prompt', task_status: { state: 'pending' } });
    await answer('Port the importer to the new API');
    await vi.waitFor(() => expect(digests()).toHaveLength(2));
    expect(digests()[1]).toMatchObject({ now_source: 'title', now_status: { state: 'pending' } });
    await answer('Reading the importer');
    await vi.waitFor(() => expect(digests()).toHaveLength(3));
    expect(digests()[2]).toEqual({ task: 'Port the importer to the new API', task_source: 'llm', now: 'Reading the importer', now_source: 'llm', now_at: 1 });
  });
});
