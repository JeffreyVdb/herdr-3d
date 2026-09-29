import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { TerminalFrame } from '../net/protocol';
import { Watches } from './watches';

function harness() {
  const sent: Array<{ t: string; args: Record<string, unknown>; resolve: (r: CommandResult) => void }> = [];
  const frames: Array<[string, number, boolean]> = [];
  const stopped: string[] = [];
  const failed: Array<[string, string]> = [];
  const closed: Array<[string, string]> = [];
  let now = 0;
  const w = new Watches({
    send: (t, args) => new Promise((resolve) => sent.push({ t, args: args as unknown as Record<string, unknown>, resolve })),
    sink: { frame: (id, f) => frames.push([id, f.n, f.full]), stop: (id) => stopped.push(id) },
    failed: (id, code) => failed.push([id, code]),
    closed: (id, reason) => closed.push([id, reason]),
    now: () => now,
  });
  const answer = async (i: number, r: CommandResult) => {
    sent[i]?.resolve(r);
    await Promise.resolve();
    await Promise.resolve();
  };
  const f = (id: string, n: number, full = false): TerminalFrame => ({ t: 'terminal.frame', id, pane: 'w1:p1', n, full, cols: 120, rows: 36, data: '' });
  return { w, sent, frames, stopped, failed, closed, answer, f, tick: (ms: number) => (now += ms) };
}

const want = (...e: Array<[string, number]>) => new Map(e);

describe('Watches', () => {
  it('watches and unwatches to match what the game wants; a new fps restarts the watch', () => {
    const h = harness();
    h.w.sync(want(['a', 4], ['b', 4]));
    expect(h.sent.map((s) => [s.t, s.args])).toEqual([
      ['terminal.watch', { id: 'a', fps: 4 }],
      ['terminal.watch', { id: 'b', fps: 4 }],
    ]);
    h.w.sync(want(['a', 4], ['b', 4]));
    expect(h.sent).toHaveLength(2);
    h.w.sync(want(['a', 10]));
    expect(h.sent.slice(2).map((s) => [s.t, s.args.id, s.args.fps])).toEqual([
      ['terminal.unwatch', 'b', undefined],
      ['terminal.watch', 'a', 10],
    ]);
    expect(h.stopped).toEqual(['b']);
    expect(h.w.count).toBe(1);
    expect(h.w.fps('a')).toBe(10);
  });

  it('applies frames in order from a full one; a gap asks for a full frame again', () => {
    const h = harness();
    h.w.sync(want(['a', 4]));
    h.w.frame(h.f('a', 1, true));
    h.w.frame(h.f('a', 2));
    h.w.frame(h.f('zzz', 1, true)); // not watched
    expect(h.frames).toEqual([
      ['a', 1, true],
      ['a', 2, false],
    ]);
    h.tick(5000);
    h.w.frame(h.f('a', 4)); // 3 went missing
    expect(h.frames).toHaveLength(2);
    expect(h.sent.map((s) => s.t)).toEqual(['terminal.watch', 'terminal.watch']);
    // Diffs before the new full frame are dropped (no second resync right away).
    h.w.frame(h.f('a', 5));
    expect(h.sent).toHaveLength(2);
    h.w.frame(h.f('a', 1, true));
    h.w.frame(h.f('a', 2));
    expect(h.frames.slice(2)).toEqual([
      ['a', 1, true],
      ['a', 2, false],
    ]);
  });

  it('a refused watch stops and is reported; unknown_command turns screens off', async () => {
    const h = harness();
    h.w.sync(want(['a', 4], ['b', 4]));
    await h.answer(0, { ok: false, code: 'capacity', message: 'too many watches' });
    expect(h.failed).toEqual([['a', 'capacity']]);
    expect(h.w.ids()).toEqual(['b']);
    await h.answer(1, { ok: false, code: 'unknown_command', message: 'unknown command: "terminal.watch"' });
    expect(h.w.disabled).toContain('terminal.watch');
    expect(h.w.count).toBe(0);
    h.w.sync(want(['c', 4]));
    expect(h.sent).toHaveLength(2);
  });

  it('ignores a late answer for an older watch of the same worker', async () => {
    const h = harness();
    h.w.sync(want(['a', 4]));
    h.w.sync(want(['a', 10]));
    await h.answer(0, { ok: false, code: 'timeout', message: '' });
    expect(h.w.fps('a')).toBe(10);
    expect(h.failed).toEqual([]);
  });

  it('terminal.closed ends the watch; observer_failed backs off; the next sync re-watches a changed pane', () => {
    const h = harness();
    h.w.sync(want(['a', 4], ['b', 4]));
    h.w.closed({ t: 'terminal.closed', id: 'a', reason: 'pane_changed' });
    h.w.closed({ t: 'terminal.closed', id: 'b', reason: 'observer_failed' });
    expect(h.closed).toEqual([
      ['a', 'pane_changed'],
      ['b', 'observer_failed'],
    ]);
    expect(h.failed).toEqual([['b', 'observer_failed']]);
    expect(h.w.count).toBe(0);
    h.w.sync(want(['a', 4]));
    expect(h.sent.slice(2).map((s) => [s.t, s.args.id])).toEqual([['terminal.watch', 'a']]);
  });

  it('forgets everything when the connection drops, and watches again after it', () => {
    const h = harness();
    h.w.sync(want(['a', 4], ['b', 4]));
    h.w.lost();
    expect(h.w.count).toBe(0);
    expect(h.stopped.sort()).toEqual(['a', 'b']);
    // Nothing is unwatched (that connection is gone); the same want watches again.
    h.w.sync(want(['a', 4], ['b', 4]));
    expect(h.sent.map((s) => s.t)).toEqual(['terminal.watch', 'terminal.watch', 'terminal.watch', 'terminal.watch']);
  });
});
