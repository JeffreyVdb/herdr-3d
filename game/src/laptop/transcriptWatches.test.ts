import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { TranscriptChild, TranscriptItem } from '../net/protocol';
import { targetKey, TranscriptWatches, watchAck } from './transcriptWatches';

const item = (id: string, seq = 1, extra: Partial<TranscriptItem> = {}): TranscriptItem => ({ id, seq, ts: 0, kind: 'assistant', parts: [{ text: id }], ...extra });

function harness() {
  const sent: Array<{ t: string; args: Record<string, unknown>; resolve: (r: CommandResult) => void }> = [];
  const log: string[] = [];
  /** The updates of each push, whole. */
  const updates: TranscriptItem[][] = [];
  const failed: Array<[string, string]> = [];
  const closed: Array<[string, string]> = [];
  let now = 0;
  /** #26: a child watch's target reads `worker/child`. */
  const of = (id: string, child?: TranscriptChild) => (child ? `${id}/${child.id}` : id);
  const heads: string[] = [];
  const w = new TranscriptWatches({
    send: (t, args) => new Promise((resolve) => sent.push({ t, args: args as unknown as Record<string, unknown>, resolve })),
    sink: {
      reset: (id, ack, child) => log.push(`reset ${of(id, child)} ${ack.items.map((i) => i.id).join(',')}${ack.availability ? ` (${ack.availability})` : ''}`),
      push: (id, items, u, head, child) => {
        updates.push(u);
        if (head) heads.push(`${of(id, child)} ${JSON.stringify(head)}`);
        log.push(`push ${of(id, child)} +${items.map((i) => i.id).join(',')} ~${u.map((i) => i.id).join(',')}`);
      },
      stop: (id, child) => log.push(`stop ${of(id, child)}`),
    },
    failed: (id, code, _m, child) => failed.push([of(id, child), code]),
    closed: (id, reason, child) => closed.push([of(id, child), reason]),
    now: () => now,
  });
  const answer = async (i: number, r: CommandResult) => {
    sent[i]?.resolve(r);
    await Promise.resolve();
    await Promise.resolve();
  };
  const ack = (items: TranscriptItem[], o: object = {}): CommandResult => ({ ok: true, data: { harness: 'claude', session: 's1', version: '2.3.1', cursor: 'c:1', has_more: false, pending: false, items, ...o } });
  return { w, sent, log, updates, heads, failed, closed, answer, ack, tick: (ms: number) => (now += ms) };
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
    // A push meanwhile is the old watch's: the new ack has it.
    h.w.items({ t: 'transcript.items', id: 'a', items: [item('x2', 2)], updates: [] });
    await h.answer(1, h.ack([item('x1'), item('x2', 2)]));
    expect(h.log).toEqual(['reset a x1', 'reset a x1,x2']);
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

  it('hands the ack to the sink, then pushes; pushes before the ack are dropped (the ack is newer)', async () => {
    const h = harness();
    h.w.sync(want('a'));
    h.w.items({ t: 'transcript.items', id: 'a', items: [item('x2', 2)], updates: [] });
    h.w.items({ t: 'transcript.items', id: 'zzz', items: [item('q')], updates: [] }); // not watched
    expect(h.log).toEqual([]);
    await h.answer(0, h.ack([item('x1')]));
    expect(h.w.ready('a')).toBe(true);
    expect(h.log).toEqual(['reset a x1']);
    h.w.items({ t: 'transcript.items', id: 'a', updates: [item('x1', 1, { kind: 'tool' })] });
    h.w.items({ t: 'transcript.items', id: 'a', items: [], updates: [] }); // nothing in it
    expect(h.log).toEqual(['reset a x1', 'push a + ~x1']);
    // #58: nothing in it but the session's head (a pending transcript that appeared empty): the sink needs the head.
    h.w.items({ t: 'transcript.items', id: 'a', items: [], updates: [], harness: 'claude', session: 's2' });
    expect(h.log.at(-1)).toBe('push a + ~');
  });

  it("a re-watch: the replaced watch's update arriving before the new ack does not undo the ack's newer item", async () => {
    const running = item('t1', 2, { kind: 'tool', tool: { name: 'Bash', input_summary: 'ls', status: 'running' } });
    const done = item('t1', 2, { kind: 'tool', tool: { name: 'Bash', input_summary: 'ls', status: 'ok', output_text: 'a b' } });
    const h = harness();
    h.w.sync(new Map([['a', 200]]));
    await h.answer(0, h.ack([item('x1'), running]));
    // Stood up (a print keeps the watch), sat down again: made again.
    h.w.sync(new Map([['a', 1]]));
    h.w.refresh('a');
    h.w.sync(new Map([['a', 200]]));
    expect(h.sent).toHaveLength(2);
    // The old watch's last push, from before the re-watch, lands while the new ack is still to come.
    h.w.items({ t: 'transcript.items', id: 'a', items: [], updates: [running] });
    await h.answer(1, h.ack([item('x1'), done]));
    expect(h.log).toEqual(['reset a x1,t1', 'reset a x1,t1']);
    expect(h.updates).toEqual([]);
    // Live pushes of the new watch still apply.
    h.w.items({ t: 'transcript.items', id: 'a', items: [item('x3', 3)], updates: [done] });
    expect(h.log.at(-1)).toBe('push a +x3 ~t1');
    expect(h.updates).toEqual([[done]]);
  });

  it('the watches made again after a close or for more items drop what comes before their ack too', async () => {
    const h = harness();
    h.w.sync(new Map([['a', 1]]));
    await h.answer(0, h.ack([item('x1')]));
    // More items wanted: a new watch; a push of the old one meanwhile is dropped.
    h.w.sync(new Map([['a', 200]]));
    h.w.items({ t: 'transcript.items', id: 'a', items: [item('old', 2)], updates: [] });
    await h.answer(1, h.ack([item('x0'), item('x1', 2)]));
    // Closed (resync): watched again at once; a push before that ack is dropped as well.
    h.tick(5000);
    h.w.closed({ t: 'transcript.closed', id: 'a', reason: 'resync' });
    h.w.items({ t: 'transcript.items', id: 'a', items: [item('old2', 3)], updates: [] });
    await h.answer(2, h.ack([item('x1', 2), item('x2', 3)]));
    h.w.items({ t: 'transcript.items', id: 'a', items: [item('x4', 4)], updates: [] });
    expect(h.log).toEqual(['reset a x1', 'reset a x0,x1', 'reset a x1,x2', 'push a +x4 ~']);
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
    // The old session is gone even while the replacement ack is delayed.
    expect(h.log).toEqual(['reset a old', 'reset a ']);
    await h.answer(1, h.ack([item('new')], { session: 's2' }));
    expect(h.log).toEqual(['reset a old', 'reset a ', 'reset a new']);
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

describe('TranscriptWatches: #26 child targets', () => {
  const ada: TranscriptChild = { id: 'ch_ada', generation: 3, provider: 'claude' };
  const bell: TranscriptChild = { id: 'ch_bell', generation: 3, provider: 'claude' };
  const kid = (child: TranscriptChild) => [{ id: 'a', child }];

  it('a child is watched by its own target beside the worker’s own; each gets its own acks and pushes', async () => {
    const h = harness();
    h.w.sync(want('a'), kid(ada));
    expect(h.sent.map((s) => [s.t, s.args])).toEqual([
      ['transcript.watch', { id: 'a', limit: 200 }],
      ['transcript.watch', { id: 'a', limit: 200, child: ada }],
    ]);
    expect(h.w.ids()).toEqual(['a', targetKey('a', ada)]);
    await h.answer(1, h.ack([item('c1')], { session: 'agent-1', availability: 'available' }));
    await h.answer(0, h.ack([item('p1')]));
    h.w.items({ t: 'transcript.items', id: 'a', items: [item('p2', 2)], updates: [] });
    h.w.items({ t: 'transcript.items', id: 'a', child: ada, items: [item('c2', 2)], updates: [] });
    expect(h.log).toEqual(['reset a/ch_ada c1 (available)', 'reset a p1', 'push a +p2 ~', 'push a/ch_ada +c2 ~']);
    // Back to the parent: only the child's watch goes; the worker's own is untouched.
    h.w.sync(want('a'));
    expect(h.sent.slice(2).map((s) => [s.t, s.args])).toEqual([['transcript.unwatch', { id: 'a', child: ada }]]);
    expect(h.log.at(-1)).toBe('stop a/ch_ada');
    expect(h.w.ids()).toEqual(['a']);
    expect(h.w.ready('a')).toBe(true);
  });

  it('a late ack or a stale push of a child replaced by another (or by another generation) is dropped', async () => {
    const h = harness();
    h.w.sync(new Set(), kid(ada));
    h.w.sync(new Set(), kid(bell)); // you opened another child before the first answered
    expect(h.sent.map((s) => [s.t, s.args])).toEqual([
      ['transcript.watch', { id: 'a', limit: 200, child: ada }],
      ['transcript.unwatch', { id: 'a', child: ada }],
      ['transcript.watch', { id: 'a', limit: 200, child: bell }],
    ]);
    await h.answer(0, h.ack([item('ada1')])); // the first one's ack, late
    h.w.items({ t: 'transcript.items', id: 'a', child: ada, items: [item('ada2', 2)], updates: [] });
    expect(h.log).toEqual(['stop a/ch_ada']);
    await h.answer(2, h.ack([item('bell1')]));
    // A push naming the same row of another generation, or no child at all, is not this watch's.
    h.w.items({ t: 'transcript.items', id: 'a', child: { ...bell, generation: 2 }, items: [item('old', 2)], updates: [] });
    h.w.items({ t: 'transcript.items', id: 'a', items: [item('own', 2)], updates: [] });
    h.w.closed({ t: 'transcript.closed', id: 'a', child: { ...bell, generation: 2 }, reason: 'session_changed' });
    expect(h.log).toEqual(['stop a/ch_ada', 'reset a/ch_bell bell1']);
    expect(h.closed).toEqual([]);
    // The game sees the worker's next generation: the child of the old one is unwatched (its row is gone with it).
    h.w.sync(new Set(), kid({ ...bell, generation: 4 }));
    expect(h.sent.slice(3).map((s) => [s.t, s.args])).toEqual([
      ['transcript.unwatch', { id: 'a', child: bell }],
      ['transcript.watch', { id: 'a', limit: 200, child: { ...bell, generation: 4 } }],
    ]);
  });

  it('a pending child: its head alone changes the availability; the push that brings its log has its cursor', async () => {
    const h = harness();
    h.w.sync(new Set(), kid(ada));
    await h.answer(0, h.ack([], { session: '', pending: true, availability: 'pending' }));
    h.w.items({ t: 'transcript.items', id: 'a', child: ada, items: [], updates: [], harness: 'claude', session: '', pending: true, availability: 'unavailable', cursor: 'c:1', has_more: false, version: '' });
    h.w.items({ t: 'transcript.items', id: 'a', child: ada, items: [item('c1', 4)], updates: [], harness: 'claude', session: 'ag', pending: false, availability: 'available', cursor: 'c:4', has_more: true, version: '2' });
    expect(h.log).toEqual(['reset a/ch_ada  (pending)', 'push a/ch_ada + ~', 'push a/ch_ada +c1 ~']);
    expect(h.heads).toEqual([
      'a/ch_ada {"harness":"claude","session":"","cursor":"c:1","has_more":false,"pending":true,"availability":"unavailable"}',
      'a/ch_ada {"harness":"claude","session":"ag","cursor":"c:4","has_more":true,"pending":false,"availability":"available"}',
    ]);
    expect(watchAck({ availability: 'later' }).availability).toBeUndefined();
  });

  it('a child’s closes: its log went (not_found) or resync are watched again; session_changed and evicted end it', async () => {
    const h = harness();
    h.w.sync(new Set(), kid(ada));
    await h.answer(0, h.ack([item('c1')]));
    h.w.closed({ t: 'transcript.closed', id: 'a', child: ada, reason: 'resync' });
    expect(h.sent.at(-1)?.args).toEqual({ id: 'a', limit: 200, child: ada });
    await h.answer(1, h.ack([item('c1')]));
    h.tick(3000);
    h.w.closed({ t: 'transcript.closed', id: 'a', child: ada, reason: 'not_found' });
    h.tick(2500);
    h.w.sync(new Set(), kid(ada));
    expect(h.sent).toHaveLength(3);
    await h.answer(2, h.ack([], { pending: true, availability: 'unavailable' }));
    h.w.closed({ t: 'transcript.closed', id: 'a', child: ada, reason: 'session_changed' });
    h.tick(2500);
    expect(h.log.slice(-1)).toEqual(['stop a/ch_ada']);
    expect(h.closed).toEqual([
      ['a/ch_ada', 'resync'],
      ['a/ch_ada', 'not_found'],
      ['a/ch_ada', 'session_changed'],
    ]);
    // A refusal (the child went meanwhile) says which target it was.
    h.w.sync(new Set(), kid(bell));
    await h.answer(3, { ok: false, code: 'not_found', message: 'worker "a" has no claude child "ch_bell"' });
    expect(h.failed).toEqual([['a/ch_bell', 'not_found']]);
  });

  it('the connection dropping stops the child’s watch too', async () => {
    const h = harness();
    h.w.sync(want('a'), kid(ada));
    h.w.lost();
    expect(h.log).toEqual(['stop a', 'stop a/ch_ada']);
    expect(h.w.count).toBe(0);
  });
});
