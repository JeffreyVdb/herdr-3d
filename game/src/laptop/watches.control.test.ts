import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { TerminalFrame } from '../net/protocol';
import { Watches } from './watches';

// #176: the seated watch that owns its pane (terminal.watch with control).
function harness() {
  const sent: Array<{ t: string; args: Record<string, unknown>; resolve: (r: CommandResult) => void }> = [];
  const frames: Array<[string, number, boolean]> = [];
  const control: string[] = [];
  let now = 0;
  const w = new Watches({
    send: (t, args) => new Promise((resolve) => sent.push({ t, args: args as unknown as Record<string, unknown>, resolve })),
    sink: { frame: (id, f) => frames.push([id, f.n, f.full]), stop: () => undefined },
    failed: () => undefined,
    closed: () => undefined,
    controlChanged: (id) => control.push(id),
    now: () => now,
  });
  const answer = async (i: number, r: CommandResult) => {
    sent[i]?.resolve(r);
    await Promise.resolve();
    await Promise.resolve();
  };
  const f = (id: string, n: number, full = false): TerminalFrame => ({ t: 'terminal.frame', id, pane: 'w1:p1', n, full, cols: 150, rows: 40, data: '' });
  return { w, sent, frames, control, answer, f, tick: (ms: number) => (now += ms) };
}

const grid = { cols: 150, rows: 40, cell: { width: 8.4, height: 17 } };

describe('Watches: control (#176)', () => {
  it('asks to own the pane at the grid, follows the tab without zooming, and keeps its process across fps and grid changes', async () => {
    const h = harness();
    h.w.sync(new Map([['a', 15]]), new Map([['a', false]]), new Map([['a', grid]]));
    expect(h.sent.map((s) => [s.t, s.args])).toEqual([['terminal.watch', { id: 'a', fps: 15, fullscreen: false, control: true, cols: 150, rows: 40 }]]);
    expect(h.w.controlOf('a')).toMatchObject({ mode: 'pending', cols: 150, rows: 40 });
    await h.answer(0, { ok: true, data: { pane: 'w1:p1', cols: 150, rows: 40, control: true } });
    expect(h.w.controlOf('a')?.mode).toBe('pending');
    h.w.control({ t: 'terminal.control', id: 'a', pane: 'w1:p1', mode: 'control', cols: 150, rows: 40 });
    expect(h.w.controlOf('a')?.mode).toBe('control');
    // A new fps (reading the conversation) or a new grid does not restart it: that would release the pane.
    h.w.sync(new Map([['a', 1]]), new Map([['a', false]]), new Map([['a', { ...grid, cols: 120 }]]));
    expect(h.sent).toHaveLength(1);
    // The grid goes as terminal.resize, with the cell's size.
    void h.w.resize('a', { cols: 120, rows: 38, cell: { width: 8.4, height: 17 } });
    expect(h.sent[1]).toMatchObject({ t: 'terminal.resize', args: { id: 'a', cols: 120, rows: 38, cell_width_px: 8, cell_height_px: 17 } });
    expect(h.w.controlOf('a')).toMatchObject({ cols: 120, rows: 38 });
    // Control off (standing up, the seat's watch now an ambient one): watched again without it.
    h.w.sync(new Map([['a', 4]]));
    expect(h.sent[2]).toMatchObject({ t: 'terminal.watch', args: { id: 'a', fps: 4 } });
    expect(h.sent[2]?.args.control).toBeUndefined();
    expect(h.w.controlOf('a')).toBeNull();
  });

  it('the wheel and back to live go as terminal.scroll; the history follows terminal.history', async () => {
    const h = harness();
    h.w.sync(new Map([['a', 15]]), new Map(), new Map([['a', grid]]));
    await h.answer(0, { ok: true, data: { pane: 'w1:p1', cols: 150, rows: 40, control: true } });
    expect(h.w.scroll('a', { lines: 3 })).toBeNull(); // not owned yet
    h.w.control({ t: 'terminal.control', id: 'a', pane: 'w1:p1', mode: 'control', cols: 150, rows: 40 });
    void h.w.scroll('a', { lines: 3, column: 10, row: 5, modifiers: 1 });
    void h.w.scroll('a', { lines: -2 });
    expect(h.sent.slice(1).map((s) => s.args)).toEqual([
      { id: 'a', direction: 'up', lines: 3, column: 10, row: 5, modifiers: 1 },
      { id: 'a', direction: 'down', lines: 2 },
    ]);
    h.w.history({ t: 'terminal.history', id: 'a', pane: 'w1:p1', offset: 3, max: 200, rows: 40 });
    expect(h.w.controlOf('a')?.history).toEqual({ offset: 3, max: 200, rows: 40 });
    expect(h.w.controlOf('a')).toMatchObject({ paste: false, mouse: false }); // a bridge of #176 part 1 says neither
    h.w.control({ t: 'terminal.control', id: 'a', pane: 'w1:p1', mode: 'control', cols: 150, rows: 40, paste: true, mouse: true });
    expect(h.w.controlOf('a')).toMatchObject({ paste: true, mouse: true });
    const n = h.control.length;
    h.w.history({ t: 'terminal.history', id: 'a', pane: 'w1:p1', offset: 3, max: 200, rows: 40 });
    expect(h.control).toHaveLength(n); // the same says nothing
    void h.w.scroll('a', { bottom: true });
    expect(h.sent.at(-1)?.args).toEqual({ id: 'a', bottom: true });
    expect(h.w.controlOf('a')?.history?.offset).toBe(0); // at once
  });

  it('read only: no resize, no scroll, the history forgotten; an ack without control is a bridge that cannot own panes', async () => {
    const h = harness();
    h.w.sync(new Map([['a', 15]]), new Map(), new Map([['a', grid]]));
    await h.answer(0, { ok: true, data: { pane: 'w1:p1', cols: 120, rows: 36, control: true } });
    h.w.control({ t: 'terminal.control', id: 'a', pane: 'w1:p1', mode: 'observe', reason: 'busy', cols: 120, rows: 36 });
    expect(h.w.controlOf('a')).toMatchObject({ mode: 'observe', reason: 'busy', history: null, paste: false, mouse: false });
    expect(h.w.resize('a', grid)).toBeNull();
    expect(h.w.scroll('a', { lines: 1 })).toBeNull();
    h.w.history({ t: 'terminal.history', id: 'a', pane: 'w1:p1', offset: 9, max: 9, rows: 36 });
    expect(h.w.controlOf('a')?.history).toBeNull();

    const o = harness();
    o.w.sync(new Map([['b', 15]]), new Map(), new Map([['b', grid]]));
    await o.answer(0, { ok: true, data: { pane: 'w1:p1', cols: 120, rows: 36 } });
    expect(o.w.controlOf('b')?.mode).toBe('none');
    expect(o.w.resize('b', grid)).toBeNull();
  });

  it('a bridge before #176 refuses the argument: watched as before, never asked again', async () => {
    const h = harness();
    h.w.sync(new Map([['a', 15]]), new Map([['a', false]]), new Map([['a', grid]]));
    await h.answer(0, { ok: false, code: 'bad_request', message: 'bad args: json: unknown field "control"' });
    expect(h.sent[1]?.args).toEqual({ id: 'a', fps: 15, fullscreen: false });
    expect(h.w.noControl).toBe(true);
    expect(h.w.controlOf('a')).toBeNull();
    h.w.sync(new Map([['a', 15]]), new Map([['a', false]]), new Map([['a', grid]]));
    expect(h.sent).toHaveLength(2);
  });

  it('a frame gap of a controlled watch asks for a full frame with a same-size resize, never a new watch', async () => {
    const h = harness();
    h.w.sync(new Map([['a', 15]]), new Map(), new Map([['a', grid]]));
    await h.answer(0, { ok: true, data: { pane: 'w1:p1', cols: 150, rows: 40, control: true } });
    h.w.control({ t: 'terminal.control', id: 'a', pane: 'w1:p1', mode: 'control', cols: 150, rows: 40 });
    h.w.frame(h.f('a', 1, true));
    h.w.frame(h.f('a', 2));
    h.tick(3000);
    h.w.frame(h.f('a', 4)); // 3 is missing
    expect(h.sent.map((s) => s.t)).toEqual(['terminal.watch', 'terminal.resize']);
    expect(h.sent[1]?.args).toMatchObject({ id: 'a', cols: 150, rows: 40 });
    h.w.frame(h.f('a', 5)); // a diff before the full one: dropped
    h.w.frame(h.f('a', 6, true));
    expect(h.frames.map((x) => x.slice(1))).toEqual([[1, true], [2, false], [6, true]]);
  });
});
