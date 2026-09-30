import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { TranscriptItem } from '../net/protocol';
import { TranscriptWatches, watchAck } from './transcriptWatches';

const item = (id: string, seq = 1, extra: Partial<TranscriptItem> = {}): TranscriptItem => ({ id, seq, ts: 0, kind: 'assistant', parts: [{ text: id }], ...extra });

function harness() {
  const sent: Array<{ t: string; args: Record<string, unknown>; resolve: (r: CommandResult) => void }> = [];
  const log: string[] = [];
  const failed: Array<[string, string]> = [];
  const closed: Array<[string, string]> = [];
  let now = 0;
  const w = new TranscriptWatches({
    send: (t, args) => new Promise((resolve) => sent.push({ t, args: args as unknown as Record<string, unknown>, resolve })),
    sink: {
      reset: (id, ack) => log.push(`reset ${id} ${ack.items.map((i) => i.id).join(',')}`),
      push: (id, items, updates) => log.push(`push ${id} +${items.map((i) => i.id).join(',')} ~${updates.map((i) => i.id).join(',')}`),
      stop: (id) => log.push(`stop ${id}`),
    },
    failed: (id, code) => failed.push([id, code]),
    closed: (id, reason) => closed.push([id, reason]),
    now: () => now,
  });
  const answer = async (i: number, r: CommandResult) => {
    sent[i]?.resolve(r);
    await Promise.resolve();
    await Promise.resolve();
  };
  const ack = (items: TranscriptItem[], o: object = {}): CommandResult => ({ ok: true, data: { harness: 'claude', session: 's1', version: '2.3.1', cursor: 'c:1', has_more: false, pending: false, items, ...o } });
  return { w, sent, log, failed, closed, answer, ack, tick: (ms: number) => (now += ms) };
}

const want = (...ids: string[]) => new Set(ids);

describe('TranscriptWatches', () => {
  it('watches and unwatches to match what the game wants', () => {
    const h = harness();
    h.w.sync(want('a'));
    h.w.sync(want('a'));
    expect(h.sent.map((s) => [s.t, s.args])).toEqual([['transcript.watch', { id: 'a', limit: 200 }]]);
    h.w.sync(want());
    expect(h.sent.slice(1).map((s) => [s.t, s.args])).toEqual([['transcript.unwatch', { id: 'a' }]]);
    expect(h.log).toEqual(['stop a']);
    expect(h.w.count).toBe(0);
  });

  it('a worker can be watched with a few items (desk prints); sitting there makes the watch again with more', async () => {
    const h = harness();
    h.w.sync(new Map([['a', 1]]));
    h.w.sync(new Map([['a', 1]]));
    expect(h.sent.map((s) => s.args)).toEqual([{ id: 'a', limit: 1 }]);
    expect(h.w.limitOf('a')).toBe(1);
    await h.answer(0, h.ack([item('x1')]));
    // Sat down: a watch of 200 replaces it (the bridge replaces a watch of the same worker); a late answer to the first is ignored.
    h.w.sync(new Map([['a', 200]]));
    h.w.sync(new Map([['a', 200]]));
    expect(h.sent.slice(1).map((s) => [s.t, s.args])).toEqual([['transcript.watch', { id: 'a', limit: 200 }]]);
    expect(h.w.limitOf('a')).toBe(200);
    await h.answer(1, h.ack([item('x0', 1), item('x1', 2)]));
    expect(h.log).toEqual(['reset a x1', 'reset a x0,x1']);
    // Back to few items: the bigger watch stays (nothing is made again for fewer).
    h.w.sync(new Map([['a', 1]]));
    expect(h.sent).toHaveLength(2);
    expect(h.w.limitOf('a')).toBe(200);
  });

  it('refresh (you sat down again): a watch a print kept with items enough is made again, and its ack resets the sink', async () => {
    const h = harness();
    h.w.sync(new Map([['a', 200]]));
    await h.answer(0, h.ack([item('x1')]));
    // Stood up: the print keeps the watch of 200.
    h.w.sync(new Map([['a', 1]]));
    expect(h.sent).toHaveLength(1);
    // Sat down again: the view is empty, the history comes with a new ack.
    h.w.refresh('a');
    h.w.sync(new Map([['a', 200]]));
    h.w.sync(new Map([['a', 200]]));
    expect(h.sent.map((s) => [s.t, s.args])).toEqual([
      ['transcript.watch', { id: 'a', limit: 200 }],
      ['transcript.watch', { id: 'a', limit: 200 }],
    ]);
    expect(h.w.ready('a')).toBe(false);
    // Pushes meanwhile wait for the new ack.
    h.w.items({ t: 'transcript.items', id: 'a', items: [item('x2', 2)], updates: [] });
    await h.answer(1, h.ack([item('x1'), item('x2', 2)]));
    expect(h.log).toEqual(['reset a x1', 'reset a x1,x2', 'push a +x2 ~']);
    // Once: the next syncs keep it.
    h.w.sync(new Map([['a', 200]]));
    h.w.sync(new Map([['a', 1]]));
    expect(h.sent).toHaveLength(2);
    expect(h.w.limitOf('a')).toBe(200);
  });

  it('refresh of a print watch of a few items makes one watch with more', async () => {
    const h = harness();
    h.w.sync(new Map([['a', 1]]));
    await h.answer(0, h.ack([item('x1')]));
    h.w.refresh('a');
    h.w.sync(new Map([['a', 200]]));
    h.w.sync(new Map([['a', 200]]));
    expect(h.sent.map((s) => s.args)).toEqual([
      { id: 'a', limit: 1 },
      { id: 'a', limit: 200 },
    ]);
  });

  it('refresh while the ack is still to come: nothing is made again, that ack resets the sink; a late one for an older watch is ignored', async () => {
    const h = harness();
    h.w.sync(new Map([['a', 1]]));
    h.w.sync(new Map([['a', 200]]));
    expect(h.sent).toHaveLength(2);
    // Stood up and sat down again before the ack.
    h.w.sync(new Map([['a', 1]]));
    h.w.refresh('a');
    h.w.sync(new Map([['a', 200]]));
    expect(h.sent).toHaveLength(2);
    await h.answer(0, h.ack([item('stale')]));
    expect(h.log).toEqual([]);
    await h.answer(1, h.ack([item('x0'), item('x1', 2)]));
    expect(h.log).toEqual(['reset a x0,x1']);
    // The refresh was used up by that ack.
    h.w.sync(new Map([['a', 200]]));
    expect(h.sent).toHaveLength(2);
  });

  it('refresh does not skip the back-off after a close, and is dropped for a worker not wanted', async () => {
    const h = harness();
    h.w.sync(want('a'));
    await h.answer(0, h.ack([]));
    h.tick(5000);
    h.w.closed({ t: 'transcript.closed', id: 'a', reason: 'resync' });
    await h.answer(1, h.ack([item('x1')]));
    h.w.closed({ t: 'transcript.closed', id: 'a', reason: 'resync' });
    expect(h.sent).toHaveLength(2);
    h.w.refresh('a');
    h.w.sync(want('a'));
    expect(h.sent).toHaveLength(2);
    h.tick(2000);
    h.w.sync(want('a'));
    expect(h.sent).toHaveLength(3);
    // Made after the back-off: its ack is the fresh one, nothing more is made.
    await h.answer(2, h.ack([item('x1')]));
    h.w.sync(want('a'));
    expect(h.sent).toHaveLength(3);

    // Not wanted at the next sync (no transcripts for it): forgotten.
    h.w.refresh('a');
    h.w.sync(want());
    h.w.sync(want('a'));
    await h.answer(4, h.ack([]));
    h.w.sync(want('a'));
    expect(h.sent.map((s) => s.t)).toEqual(['transcript.watch', 'transcript.watch', 'transcript.watch', 'transcript.unwatch', 'transcript.watch']);
  });

  it('refresh does nothing once transcripts are off', async () => {
    const h = harness();
    h.w.sync(want('a'));
    await h.answer(0, { ok: false, code: 'unknown_command', message: 'unknown command: "transcript.watch"' });
    h.w.refresh('a');
    h.w.sync(want('a'));
    expect(h.sent).toHaveLength(1);
  });

  it('hands the ack to the sink, then pushes; pushes before the ack wait for it', async () => {
    const h = harness();
    h.w.sync(want('a'));
    h.w.items({ t: 'transcript.items', id: 'a', items: [item('x2', 2)], updates: [] });
    h.w.items({ t: 'transcript.items', id: 'zzz', items: [item('q')], updates: [] }); // not watched
    expect(h.log).toEqual([]);
    await h.answer(0, h.ack([item('x1')]));
    expect(h.w.ready('a')).toBe(true);
    h.w.items({ t: 'transcript.items', id: 'a', updates: [item('x1', 1, { kind: 'tool' })] });
    h.w.items({ t: 'transcript.items', id: 'a', items: [], updates: [] }); // nothing in it
    expect(h.log).toEqual(['reset a x1', 'push a +x2 ~', 'push a + ~x1']);
  });

  it('drops malformed items and fills in a partial ack', () => {
    expect(watchAck({ items: [item('a'), { nope: 1 }, 'x', null] })).toEqual({ harness: '', session: '', version: '', cursor: '', has_more: false, pending: false, items: [item('a')] });
    expect(watchAck(null).items).toEqual([]);
    expect(watchAck({ pending: true }).pending).toBe(true);
  });

  it('session_changed watches again at once and resets the sink with the new session', async () => {
    const h = harness();
    h.w.sync(want('a'));
    await h.answer(0, h.ack([item('old')]));
    h.tick(5000);
    h.w.closed({ t: 'transcript.closed', id: 'a', reason: 'session_changed' });
    expect(h.closed).toEqual([['a', 'session_changed']]);
    expect(h.sent.map((s) => s.t)).toEqual(['transcript.watch', 'transcript.watch']);
    // The old view stays until the new ack (no stop in between).
    expect(h.log).toEqual(['reset a old']);
    await h.answer(1, h.ack([item('new')], { session: 's2' }));
    expect(h.log).toEqual(['reset a old', 'reset a new']);
  });

  it('resync and not_found watch again, not more often than every 2 s', async () => {
    const h = harness();
    h.w.sync(want('a'));
    await h.answer(0, h.ack([]));
    h.tick(5000);
    h.w.closed({ t: 'transcript.closed', id: 'a', reason: 'resync' });
    expect(h.sent).toHaveLength(2);
    // Right after: it waits.
    h.w.closed({ t: 'transcript.closed', id: 'a', reason: 'resync' });
    expect(h.sent).toHaveLength(2);
    h.w.sync(want('a'));
    expect(h.sent).toHaveLength(2);
    h.tick(2000);
    h.w.sync(want('a'));
    expect(h.sent).toHaveLength(3);
    // not_found waits for the next sync after 2 s (the transcript may appear).
    h.tick(5000);
    h.w.closed({ t: 'transcript.closed', id: 'a', reason: 'not_found' });
    h.w.sync(want('a'));
    expect(h.sent).toHaveLength(3);
    h.tick(2000);
    h.w.sync(want('a'));
    expect(h.sent.map((s) => s.t)).toEqual(['transcript.watch', 'transcript.watch', 'transcript.watch', 'transcript.watch']);
    expect(h.log.filter((l) => l.startsWith('stop'))).toEqual([]);
  });

  it('worker_removed and asleep end the watch; nothing is unwatched', () => {
    const h = harness();
    h.w.sync(want('a', 'b'));
    h.w.closed({ t: 'transcript.closed', id: 'a', reason: 'worker_removed' });
    h.w.closed({ t: 'transcript.closed', id: 'b', reason: 'asleep' });
    h.w.closed({ t: 'transcript.closed', id: 'c', reason: 'asleep' }); // not watched
    expect(h.closed).toEqual([
      ['a', 'worker_removed'],
      ['b', 'asleep'],
    ]);
    expect(h.log).toEqual(['stop a', 'stop b']);
    h.w.sync(want());
    expect(h.sent.map((s) => s.t)).toEqual(['transcript.watch', 'transcript.watch']);
  });

  it('a refused watch is reported and retried later; unknown_command turns transcripts off', async () => {
    const h = harness();
    h.w.sync(want('a', 'b'));
    await h.answer(0, { ok: false, code: 'capacity', message: 'too many' });
    expect(h.failed).toEqual([['a', 'capacity']]);
    h.w.sync(want('a', 'b'));
    expect(h.sent).toHaveLength(2);
    h.tick(5000);
    h.w.sync(want('a', 'b'));
    expect(h.sent).toHaveLength(3);
    await h.answer(1, { ok: false, code: 'unknown_command', message: 'unknown command: "transcript.watch"' });
    expect(h.w.disabled).toContain('transcript.watch');
    expect(h.w.count).toBe(0);
    h.w.sync(want('c'));
    expect(h.sent).toHaveLength(3);
  });

  it('ignores a late answer for an older watch of the same worker', async () => {
    const h = harness();
    h.w.sync(want('a'));
    h.w.sync(want());
    h.w.sync(want('a'));
    await h.answer(0, h.ack([item('stale')]));
    expect(h.log).toEqual(['stop a']);
    await h.answer(2, h.ack([item('fresh')]));
    expect(h.log).toEqual(['stop a', 'reset a fresh']);
  });

  it('forgets everything when the connection drops, and watches again after it', () => {
    const h = harness();
    h.w.sync(want('a'));
    h.w.lost();
    expect(h.w.count).toBe(0);
    expect(h.log).toEqual(['stop a']);
    h.w.sync(want('a'));
    expect(h.sent.map((s) => s.t)).toEqual(['transcript.watch', 'transcript.watch']);
  });
});
