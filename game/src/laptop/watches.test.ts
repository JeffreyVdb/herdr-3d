import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { TerminalFrame } from '../net/protocol';
import { Watches } from './watches';

function harness() {
  const sent: Array<{ t: string; args: Record<string, unknown>; resolve: (r: CommandResult) => void }> = [];
  const frames: Array<[string, number, boolean]> = [];
  const stopped: string[] = [];
  const reasons: Array<string | undefined> = [];
  const failed: Array<[string, string]> = [];
  const closed: Array<[string, string]> = [];
  const changed: string[] = [];
  let now = 0;
  const w = new Watches({
    send: (t, args) => new Promise((resolve) => sent.push({ t, args: args as unknown as Record<string, unknown>, resolve })),
    sink: {
      frame: (id, f) => frames.push([id, f.n, f.full]),
      stop: (id, reason) => {
        stopped.push(id);
        reasons.push(reason);
      },
    },
    failed: (id, code) => failed.push([id, code]),
    closed: (id, reason) => closed.push([id, reason]),
    zoomChanged: (id) => changed.push(id),
    now: () => now,
  });
  const answer = async (i: number, r: CommandResult) => {
    sent[i]?.resolve(r);
    await Promise.resolve();
    await Promise.resolve();
  };
  const f = (id: string, n: number, full = false): TerminalFrame => ({ t: 'terminal.frame', id, pane: 'w1:p1', n, full, cols: 120, rows: 36, data: '' });
  return { w, sent, frames, stopped, reasons, failed, closed, changed, answer, f, tick: (ms: number) => (now += ms) };
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
    h.w.sync(want(['a', 4], ['b', 4], ['c', 4]));
    h.w.sync(want(['a', 4], ['b', 4]));
    h.w.closed({ t: 'terminal.closed', id: 'a', reason: 'pane_changed' });
    h.w.closed({ t: 'terminal.closed', id: 'b', reason: 'observer_failed' });
    // #52: the screen hears why the bridge ended it (an unwatch of the game's own says nothing).
    expect(h.stopped).toEqual(['c', 'a', 'b']);
    expect(h.reasons).toEqual([undefined, 'pane_changed', 'observer_failed']);
    expect(h.closed).toEqual([
      ['a', 'pane_changed'],
      ['b', 'observer_failed'],
    ]);
    expect(h.failed).toEqual([['b', 'observer_failed']]);
    expect(h.w.count).toBe(0);
    h.w.sync(want(['a', 4]));
    expect(h.sent.slice(4).map((s) => [s.t, s.args.id])).toEqual([['terminal.watch', 'a']]);
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

  describe('fullscreen (#74)', () => {
    const split = { pane: 'w1:p1', cols: 60, rows: 40, zoom: { state: 'split', applied: false } };
    const fs = (...ids: string[]) => new Map(ids.map((id) => [id, true] as const));
    const off = (...ids: string[]) => new Map(ids.map((id) => [id, false] as const));

    it('asks for fullscreen only for the watches that want it; a change restarts the watch', async () => {
      const h = harness();
      h.w.sync(want(['a', 4], ['b', 4]), fs('b'));
      expect(h.sent.map((s) => s.args)).toEqual([{ id: 'a', fps: 4 }, { id: 'b', fps: 4, fullscreen: true }]);
      h.w.sync(want(['a', 4], ['b', 4]), fs('b'));
      expect(h.sent).toHaveLength(2);
      h.w.sync(want(['a', 4], ['b', 4]), fs());
      expect(h.sent.slice(2).map((s) => s.args)).toEqual([{ id: 'b', fps: 4 }]);
    });

    it('a watch told "no fullscreen" says so (false is not the same as saying nothing: the bridge follows it)', async () => {
      const h = harness();
      h.w.sync(want(['a', 4], ['b', 4]), off('b'));
      expect(h.sent.map((s) => s.args)).toEqual([{ id: 'a', fps: 4 }, { id: 'b', fps: 4, fullscreen: false }]);
      h.w.sync(want(['a', 4], ['b', 4]), off('b'));
      expect(h.sent).toHaveLength(2);
      h.w.sync(want(['a', 4], ['b', 4]), fs('b'));
      expect(h.sent[2]?.args).toEqual({ id: 'b', fps: 4, fullscreen: true });
    });

    it('keeps the ack’s zoom state and size, and follows terminal.state', async () => {
      const h = harness();
      h.w.sync(want(['a', 4]), fs('a'));
      expect(h.w.zoomOf('a')).toBeNull();
      await h.answer(0, { ok: true, data: split });
      expect(h.w.zoomOf('a')).toEqual({ zoom: split.zoom, size: { cols: 60, rows: 40 }, fullscreen: true });
      h.w.state({ t: 'terminal.state', id: 'a', pane: 'w1:p1', cols: 131, rows: 47, zoom: { state: 'zoomed', applied: true } });
      expect(h.w.zoomOf('a')).toMatchObject({ zoom: { state: 'zoomed' }, size: { cols: 131, rows: 47 } });
      h.w.state({ t: 'terminal.state', id: 'zzz', pane: 'x', cols: 1, rows: 1, zoom: { state: 'split', applied: false } });
      expect(h.changed).toEqual(['a', 'a']);
    });

    it('an older bridge: no zoom in the ack means no state and no error', async () => {
      const h = harness();
      h.w.sync(want(['a', 4]), fs('a'));
      await h.answer(0, { ok: true, data: { pane: 'w1:p1', cols: 120, rows: 36 } });
      expect(h.w.zoomOf('a')).toBeNull();
      expect(h.failed).toEqual([]);
    });

    it('a bridge that refuses the argument is asked again without it, and never with it again', async () => {
      const h = harness();
      h.w.sync(want(['a', 4]), fs('a'));
      await h.answer(0, { ok: false, code: 'bad_request', message: 'bad args: json: unknown field "fullscreen"' });
      expect(h.sent[1]?.args).toEqual({ id: 'a', fps: 4 });
      expect(h.failed).toEqual([]);
      h.w.sync(want(['a', 4]), fs('a'));
      expect(h.sent).toHaveLength(2);
      h.w.sync(want(['a', 4], ['b', 4]), fs('a', 'b'));
      expect(h.sent[2]?.args).toEqual({ id: 'b', fps: 4 });
    });

    it('terminal.zoom switches the watch without restarting it, and takes the answer', async () => {
      const h = harness();
      h.w.sync(want(['a', 4]), fs());
      await h.answer(0, { ok: true, data: split });
      const done = h.w.zoom('a', true);
      expect(h.sent[1]).toMatchObject({ t: 'terminal.zoom', args: { id: 'a', on: true } });
      // The next plan (the pref says fullscreen now) does not restart the watch.
      h.w.sync(want(['a', 4]), fs('a'));
      expect(h.sent).toHaveLength(2);
      await h.answer(1, { ok: true, data: { pane: 'w1:p1', cols: 131, rows: 47, zoom: { state: 'zoomed', applied: true } } });
      await done;
      expect(h.w.zoomOf('a')).toMatchObject({ zoom: { state: 'zoomed', applied: true }, size: { cols: 131, rows: 47 }, fullscreen: true });
    });

    it('a bridge that does not know terminal.zoom drops the state and says so', async () => {
      const h = harness();
      h.w.sync(want(['a', 4]), fs());
      await h.answer(0, { ok: true, data: split });
      const done = h.w.zoom('a', true);
      await h.answer(1, { ok: false, code: 'unknown_command', message: 'unknown command' });
      await done;
      expect(h.w.zoomUnsupported).toBe(true);
      expect(h.w.zoomOf('a')).toBeNull();
    });

    it('a resync keeps the zoom state and asks for fullscreen again', async () => {
      const h = harness();
      h.w.sync(want(['a', 4]), fs('a'));
      await h.answer(0, { ok: true, data: split });
      h.w.frame(h.f('a', 1, true));
      h.tick(3000);
      h.w.frame(h.f('a', 5));
      expect(h.sent[1]?.args).toEqual({ id: 'a', fps: 4, fullscreen: true });
      expect(h.w.zoomOf('a')?.zoom.state).toBe('split');
    });

    it('a resync after the chip turned fullscreen off repeats "off", not nothing', async () => {
      const h = harness();
      h.w.sync(want(['a', 4]), fs('a'));
      await h.answer(0, { ok: true, data: split });
      const done = h.w.zoom('a', false);
      await h.answer(1, { ok: true, data: { ...split, zoom: { state: 'split', applied: false } } });
      await done;
      h.w.frame(h.f('a', 1, true));
      h.tick(3000);
      h.w.frame(h.f('a', 5));
      expect(h.sent[2]?.args).toEqual({ id: 'a', fps: 4, fullscreen: false });
    });
  });
});
