import { describe, expect, it } from 'vitest';
import { blocked, moveWithCollision, pickNearest, rayBox } from './collide';
import { assignDesks, deskCountFallback, displayStatus, MAX_DESKS, modelCue, modelText, taskLine } from './derive';
import { COUNTER_RECT, COUNTER_TOP, departuresBoardBox, EYE_HEIGHT, HEAD, floorLayout, MCP_SCREEN_BOX, openingsFor, outlineOf, overviewScreenBox, podGrid, POST_W, RACK_BOX, ROOM_HEIGHT, seatRect, slotBoxes, wallPieces, type Rect } from './layout';

describe('deskCountFallback', () => {
  it.each([
    [0, -1, 6],
    [3, 2, 6],
    [4, 3, 6],
    [5, 4, 7],
    [18, 19, 20],
    [60, 59, 62],
    [95, 94, 96],
    [200, 199, 200],
    [2, 40, 41],
  ])('%i workers, max desk %i -> %i desks', (n, max, want) => {
    expect(deskCountFallback(n, max)).toBe(want);
  });
  it('honours a smaller cap', () => {
    expect(deskCountFallback(30, 29, 16)).toBe(30);
    expect(deskCountFallback(10, 3, 8)).toBe(8);
  });
});

describe('assignDesks', () => {
  it('keeps bridge desks and fills the rest lowest-first in order', () => {
    const m = assignDesks([{ id: 'a', desk_index: 2 }, { id: 'b' }, { id: 'c', desk_index: 0 }, { id: 'd' }]);
    expect([...m]).toEqual([
      ['a', 2],
      ['c', 0],
      ['b', 1],
      ['d', 3],
    ]);
  });
  it('moves the second of two clashing desks', () => {
    const m = assignDesks([
      { id: 'a', desk_index: 1 },
      { id: 'b', desk_index: 1 },
    ]);
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toBe(0);
  });
  it('keeps previous local desks while they are free', () => {
    const prev = new Map([
      ['b', 5],
      ['c', 0],
    ]);
    const m = assignDesks([{ id: 'a', desk_index: 0 }, { id: 'b' }, { id: 'c' }], prev);
    expect(m.get('b')).toBe(5);
    expect(m.get('c')).toBe(1);
  });
});

describe('display helpers', () => {
  it('maps herdr statuses to cards', () => {
    expect(['working', 'done', 'blocked', 'idle', 'unknown'].map((s) => displayStatus(s, false))).toEqual([
      'working',
      'done',
      'needs_you',
      'idle',
      'idle',
    ]);
    expect(displayStatus('working', true)).toBe('asleep');
  });
  it('tells model families apart and stays neutral when unknown', () => {
    const fam = (h: string | undefined, m: string | undefined) => modelCue(h, m).family;
    expect(fam('claude', 'claude-opus-5-5')).toBe('opus');
    expect(fam('claude', 'claude-fable-5-1')).toBe('fable');
    expect(fam('codex', 'gpt-6-sol')).toBe('sol');
    expect(fam('codex', 'gpt-6-luna')).toBe('luna');
    expect(fam('codex', 'gpt-6-astra')).toBe('astra');
    expect(fam('claude', undefined)).toBe('unknown');
    expect(fam(undefined, undefined)).toBe('none');
    const colors = ['claude-opus-5-5', 'claude-fable-5-1', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra'].map((m) => modelCue('x', m).color);
    expect(new Set(colors).size).toBe(5);
    expect(modelCue('codex', 'gpt-6-sol').hat).toBe('cap');
    expect(modelCue('claude', 'claude-opus-5-5').hat).toBe('beanie');
    expect(modelCue(undefined, undefined).hat).toBe('none');
  });
  it('shows the model as its readable name and effort, never the harness (#229)', () => {
    expect(modelText('claude', 'claude-opus-5-5', 'high')).toBe('Opus 5.5 high');
    expect(modelText('claude', 'claude-haiku-5-5', 'high')).toBe('Haiku 5.5 high');
    // A Codex model: the bridge's label, tidied as the pickers do (#200); without one, a GPT slug by rule, the same
    // words; any other id as it is.
    const options = { codex: { models: ['gpt-6-sol'], efforts: ['medium'], model_labels: { 'gpt-6-sol': 'GPT-6-Sol' } } };
    expect(modelText('codex', 'gpt-6-sol', 'medium', options)).toBe('GPT 6 Sol medium');
    expect(modelText('codex', 'gpt-6-luna', undefined, options)).toBe('GPT 6 Luna');
    expect(modelText('codex', 'gpt-6-sol', 'high')).toBe('GPT 6 Sol high');
    expect(modelText('codex', 'gpt-6-sol-2026-08-01', 'high')).toBe('gpt-6-sol-2026-08-01 high');
    expect(modelText('claude', 'claude-opus-4-20250514', 'high')).toBe('claude-opus-4-20250514 high');
    expect(modelText('claude', undefined, undefined)).toBe('');
    expect(modelText(undefined, undefined, undefined)).toBe('');
  });
  it('uses the title, else the label, as the task', () => {
    expect(taskLine({ title: ' Fix CI ', label: 'L' })).toBe('Fix CI');
    expect(taskLine({ title: '', label: 'CODE|x' })).toBe('CODE|x');
    expect(taskLine({ label: 'L' })).toBe('L');
  });
});

describe('floorLayout', () => {
  it('is deterministic for a desk count', () => {
    for (const n of [6, 9, 20, 62, 96]) expect(floorLayout(n)).toEqual(floorLayout(n));
  });

  it.each([6, 7, 9, 13, 20, 41, 62, 96])('%i desks: one slot each, inside the room, not overlapping', (n) => {
    const l = floorLayout(n);
    expect(l.slots).toHaveLength(n);
    expect(l.slots.map((s) => s.index)).toEqual([...Array(n).keys()]);
    for (const s of l.slots) {
      for (const p of [s.desk, s.seat, s.chairIn]) {
        expect(p.x).toBeGreaterThan(0.5);
        expect(p.x).toBeLessThan(l.width - 0.5);
        expect(p.z).toBeGreaterThan(0.5);
        expect(p.z).toBeLessThan(l.depth - 0.5);
      }
    }
    const seats = new Set(l.slots.map((s) => `${s.seat.x},${s.seat.z}`));
    expect(seats.size).toBe(n);
    // Desks stay clear of the lounge, the board wall and the lobby.
    const board = l.walls[4];
    for (const s of l.slots) {
      expect(s.seat.x).toBeGreaterThan(l.rug.x1);
      expect(s.seat.z + 0.4).toBeLessThan(board?.min[2] ?? 0);
    }
  });

  it('grows with the desk count', () => {
    const a = floorLayout(6);
    const b = floorLayout(96);
    expect(b.width * b.depth).toBeGreaterThan(a.width * a.depth);
    expect(podGrid(62)).toEqual({ pods: 16, cols: 5, rows: 4 });
  });

  it('has every placeholder prop, labelled', () => {
    const ids = floorLayout(20).props.map((p) => p.id);
    expect(ids.sort()).toEqual(
      ['board.departures', 'board.issues', 'board.prs', 'board.services', 'clock', 'dropzone', 'elevator', 'filing', 'lounge', 'radio', 'screen.mcp', 'screen.overview', 'server.rack', 'tv', 'whiteboard'].sort(),
    );
  });

  it('M17: hangs the clock on the board partition, facing the desks, above them, only to be looked at', () => {
    for (const n of [0, 6, 20, 62, 96]) {
      const l = floorLayout(n);
      const clock = l.props.find((p) => p.id === 'clock');
      expect(clock, `${n} desks`).toMatchObject({ label: 'Clock', milestone: null, solid: false });
      const b = (clock as NonNullable<typeof clock>).box;
      const wall = l.walls[4] as NonNullable<(typeof l.walls)[4]>;
      // On the partition's north face (the desks' side), within its length and under its top.
      expect(b.max[2]).toBeCloseTo(wall.min[2], 5);
      expect(b.min[0]).toBeGreaterThan(wall.min[0]);
      expect(b.max[0]).toBeLessThan(wall.max[0]);
      expect(b.max[1]).toBeLessThanOrEqual(wall.max[1]);
      // Above the monitors: readable from the desks.
      expect(b.min[1]).toBeGreaterThan(1.5);
    }
  });

  it('puts the radio on the lounge counter, in reach from the lounge aisle, without a collider of its own', () => {
    for (const n of [6, 20, 62]) {
      const l = floorLayout(n);
      const radio = l.props.find((p) => p.id === 'radio');
      expect(radio).toMatchObject({ label: 'Radio', solid: false });
      const b = (radio as NonNullable<typeof radio>).box;
      // Standing on the counter top, inside the counter's footprint.
      expect(b.min[1]).toBe(COUNTER_TOP);
      expect(b.min[0]).toBeGreaterThanOrEqual(COUNTER_RECT.x0);
      expect(b.max[0]).toBeLessThanOrEqual(COUNTER_RECT.x1);
      expect(b.min[2]).toBeGreaterThanOrEqual(COUNTER_RECT.z0);
      expect(b.max[2]).toBeLessThanOrEqual(COUNTER_RECT.z1);
      // It is not solid, and its footprint touches no collider but the counter it stands on (nor the sofa or the coffee table).
      const foot = { x0: b.min[0], z0: b.min[2], x1: b.max[0], z1: b.max[2] };
      const hits = l.colliders.filter((c) => c.x0 < foot.x1 && c.x1 > foot.x0 && c.z0 < foot.z1 && c.z1 > foot.z0);
      expect(hits).toEqual([COUNTER_RECT]);
      // The lounge aisle (east of the counter): free to stand on, and looking west and down at the radio hits it first.
      const stand = { x: 1.3, z: 4.55 };
      expect(blocked(stand, 0.28, l.colliders)).toBe(false);
      const c: [number, number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      const first = (from: [number, number, number]) => {
        const d: [number, number, number] = [c[0] - from[0], c[1] - from[1], c[2] - from[2]];
        const len = Math.hypot(...d);
        return pickNearest(from, [d[0] / len, d[1] / len, d[2] / len], l.props.map((p) => ({ boxes: [p.box], value: p.id })), 3)?.value;
      };
      expect(first([stand.x, EYE_HEIGHT, stand.z])).toBe('radio');
      // Every stand-off along the aisle in front of the counter can reach it.
      for (const z of [3.7, 4.1, 4.5, 4.8]) expect(first([1.3, EYE_HEIGHT, z]), `from z=${z}`).toBe('radio');
    }
  });

  it('#118: hangs the floor overview screen on the lounge wall, as big as the blank stretch allows', () => {
    // The depths the building outlines take (MIN_D, and the desk grid's rows).
    for (const [depth, width] of [
      [14, 7.35],
      [17.8, 4.75],
      [23.1, 6.85],
      [28.4, 5.75],
    ] as const) {
      const b = overviewScreenBox(depth);
      const at = `depth ${depth}`;
      // A thin bezel box on the west wall, facing +x.
      expect(b.min[0], at).toBe(0);
      expect(b.max[0], at).toBeLessThanOrEqual(0.1);
      // 0.4 m clear of the north-west corner, and of the frame (sill and jambs, 5 cm past the hole) of the northernmost west window.
      expect(b.min[2], at).toBeCloseTo(0.4, 5);
      const west = openingsFor(30, depth).filter((o) => o.wall === 'west' && o.kind === 'window');
      expect(west.length, at).toBeGreaterThan(0);
      const frame = Math.min(...west.map((o) => o.u0)) - 0.05;
      expect(frame - b.max[2], at).toBeGreaterThanOrEqual(0.4 - 1e-9);
      expect(b.max[2] - b.min[2], at).toBeCloseTo(width, 3);
      // Over the counter's coffee machine, mugs and the radio's antenna (1.4 m), under the window heads and well under the ceiling.
      expect(b.min[1], at).toBeGreaterThanOrEqual(1.55);
      expect(b.max[1], at).toBeLessThan(HEAD);
      expect(ROOM_HEIGHT - b.max[1], at).toBeGreaterThanOrEqual(0.8);
      expect(b.max[1] - b.min[1], at).toBeCloseTo(4, 1);
    }
  });

  it('#118: the screen is a prop of every floor, clear of the counter, the radio and the mezzanine posts; the radio stays the nearest pick', () => {
    for (const n of [0, 6, 20, 62, 96]) {
      const l = floorLayout(n);
      const screen = l.props.find((p) => p.id === 'screen.overview');
      expect(screen, `${n} desks`).toMatchObject({ label: 'Floor overview', solid: false });
      const b = (screen as NonNullable<typeof screen>).box;
      expect(b).toEqual(overviewScreenBox(l.depth));
      const radio = l.props.find((p) => p.id === 'radio')?.box;
      expect(b.min[1]).toBeGreaterThan(radio?.max[1] ?? Infinity);
      expect(b.min[1]).toBeGreaterThan(COUNTER_TOP + 0.5);
      for (const p of l.mezzanine.posts) {
        const h = POST_W / 2;
        const post = { x0: p.x - h, z0: p.z - h, x1: p.x + h, z1: p.z + h };
        expect(post.x0 > b.max[0] + 0.5 || post.z1 < b.min[2] - 0.5 || post.z0 > b.max[2] + 0.5, `post at ${p.x},${p.z}`).toBe(true);
      }
      // Aimed at from the lounge, the screen is what you hit; aiming at the radio still hits the radio first.
      const pick = (from: [number, number, number], to: [number, number, number]) => {
        const d: [number, number, number] = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
        const len = Math.hypot(...d);
        return pickNearest(from, [d[0] / len, d[1] / len, d[2] / len], l.props.map((p) => ({ boxes: [p.box], value: p.id })), 4)?.value;
      };
      const mid: [number, number, number] = [b.max[0], (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      expect(pick([2.6, EYE_HEIGHT, 2.6], mid)).toBe('screen.overview');
      const r = radio as NonNullable<typeof radio>;
      const rc: [number, number, number] = [(r.min[0] + r.max[0]) / 2, (r.min[1] + r.max[1]) / 2, (r.min[2] + r.max[2]) / 2];
      for (const z of [3.7, 4.1, 4.5, 4.8]) expect(pick([1.3, EYE_HEIGHT, z], rc), `from z=${z}`).toBe('radio');
    }
  });

  it('#65: stands the departures board on the board partition, both faces readable, clear of every other prop, on every floor', () => {
    const outlines = [undefined, { width: 18, depth: 14 }, { width: 24, depth: 17.8 }, { width: 31, depth: 23.1 }, { width: 40, depth: 28.4 }];
    for (const n of [0, 6, 20, 62, 96]) {
      for (const outline of outlines) {
        const l = floorLayout(n, outline);
        const at = `${n} desks, ${l.width} x ${l.depth}`;
        const board = l.props.find((p) => p.id === 'board.departures');
        expect(board, at).toMatchObject({ label: 'Departures board', milestone: '#65', solid: false });
        const b = (board as NonNullable<typeof board>).box;
        expect(b, at).toEqual(departuresBoardBox(l.width, l.depth));
        // On the partition's top, within its length, a little deeper than it (both faces proud of the wall's).
        const wall = l.walls[4] as NonNullable<(typeof l.walls)[4]>;
        expect(b.min[1], at).toBeCloseTo(wall.max[1], 5);
        expect(b.min[0], at).toBeGreaterThan(wall.min[0] + 1);
        expect(b.max[0], at).toBeLessThan(wall.max[0] - 1);
        expect(b.min[2], at).toBeLessThan(wall.min[2]);
        expect(b.max[2], at).toBeGreaterThan(wall.max[2]);
        expect(b.max[2] - b.min[2], at).toBeLessThan(0.3);
        // Big enough to read across the floor, well under the ceiling and its light strips.
        expect(b.max[0] - b.min[0], at).toBeGreaterThanOrEqual(3);
        expect(b.max[1] - b.min[1], at).toBeGreaterThanOrEqual(1.2);
        expect(ROOM_HEIGHT - b.max[1], at).toBeGreaterThanOrEqual(2);
        // It overlaps no other prop (the boards and the clock on the partition, the whiteboard, the cabinet, the overview screen…).
        for (const p of l.props) {
          if (p.id === 'board.departures') continue;
          const o = p.box;
          const hit = b.min[0] < o.max[0] && b.max[0] > o.min[0] && b.min[1] < o.max[1] && b.max[1] > o.min[1] && b.min[2] < o.max[2] && b.max[2] > o.min[2];
          expect(hit, `${p.id} at ${at}`).toBe(false);
        }
        // Nor the mezzanine (its slab, posts and stair) nor a window: it stands mid-room, on no outer wall.
        const m = l.mezzanine;
        expect(b.min[2] > m.rect.z1 || b.max[0] < m.rect.x0, at).toBe(true);
        expect(b.min[2] > m.stair.bottom || b.max[0] < m.stair.x0 - 0.1, at).toBe(true);
        for (const p of m.posts) expect(p.x + POST_W / 2 < b.min[0] - 0.5 || p.x - POST_W / 2 > b.max[0] + 0.5 || p.z + POST_W / 2 < b.min[2] - 0.5, `post at ${p.x},${p.z}`).toBe(true);
        expect(b.min[0], at).toBeGreaterThan(1);
        expect(b.max[0], at).toBeLessThan(l.width - 1);
        expect(b.min[2], at).toBeGreaterThan(1);
        expect(b.max[2], at).toBeLessThan(l.depth - 1);
        // Aimed at from either side within reach, the board is what you hit, over the partition (a blocker).
        const props = l.props.map((p) => ({ boxes: [p.box], value: p.id }));
        const mid = (b.min[1] + b.max[1]) / 2;
        const cx = (b.min[0] + b.max[0]) / 2;
        for (const [z, face] of [
          [b.min[2] - 1.6, b.min[2]],
          [b.max[2] + 1.6, b.max[2]],
        ] as const) {
          const from: [number, number, number] = [cx + 0.8, EYE_HEIGHT, z];
          const d: [number, number, number] = [cx - from[0], mid - from[1], face - from[2]];
          const len = Math.hypot(...d);
          expect(len, at).toBeLessThan(3);
          expect(pickNearest(from, [d[0] / len, d[1] / len, d[2] / len], props, 3, l.walls)?.value, `${at} from z ${z}`).toBe('board.departures');
        }
      }
    }
  });

  it('#74: stands the server rack against the north wall between the lounge window and the whiteboard, on every floor', () => {
    for (const n of [0, 6, 20, 62, 96]) {
      const l = floorLayout(n);
      const rack = l.props.find((p) => p.id === 'server.rack');
      expect(rack, `${n} desks`).toMatchObject({ label: 'Server rack', milestone: null, solid: true });
      const b = (rack as NonNullable<typeof rack>).box;
      expect(b).toEqual({ min: [RACK_BOX[0], RACK_BOX[1], RACK_BOX[2]], max: [RACK_BOX[3], RACK_BOX[4], RACK_BOX[5]] });
      // On the floor, against the north wall, a short rack: its monitor is about chest high.
      expect(b.min[1]).toBe(0);
      expect(b.min[2]).toBe(0);
      expect(b.max[1]).toBeGreaterThan(1.4);
      expect(b.max[1]).toBeLessThanOrEqual(1.7);
      // Clear of the north windows (their frames reach 5 cm past the hole): the lounge window and the corner office's.
      for (const o of l.openings.filter((o) => o.wall === 'north' && o.kind === 'window')) {
        expect(b.min[0] >= o.u1 + 0.05 || b.max[0] <= o.u0 - 0.05, `window ${o.u0}-${o.u1}`).toBe(true);
      }
      // East of the rug and west of the whiteboard, a clear margin on both sides.
      expect(b.min[0] - l.rug.x1).toBeGreaterThanOrEqual(0.5);
      const wb = l.props.find((p) => p.id === 'whiteboard') as NonNullable<ReturnType<typeof floorLayout>['props'][number]>;
      expect(wb.box.min[0] - b.max[0]).toBeGreaterThanOrEqual(0.6);
      expect(b.max[0] - b.min[0]).toBeGreaterThanOrEqual(0.85); // wide enough to read as a rack next to the sofa and the board
      // It overlaps no other prop, and none of the mezzanine's posts with the room they keep around them.
      for (const p of l.props) {
        if (p.id === 'server.rack') continue;
        const o = p.box;
        const hit = b.min[0] < o.max[0] && b.max[0] > o.min[0] && b.min[1] < o.max[1] && b.max[1] > o.min[1] && b.min[2] < o.max[2] && b.max[2] > o.min[2];
        expect(hit, `${p.id} at ${n} desks`).toBe(false);
      }
      for (const p of l.mezzanine.posts) {
        const h = POST_W / 2;
        expect(p.x - h > b.max[0] + 0.5 || p.z - h > b.max[2] + 0.5, `post at ${p.x},${p.z}`).toBe(true);
      }
      // Solid (a collider), and nothing else blocks the way to stand in front of it.
      expect(l.colliders).toContainEqual({ x0: RACK_BOX[0], z0: RACK_BOX[2], x1: RACK_BOX[3], z1: RACK_BOX[5] });
      const stand = { x: (b.min[0] + b.max[0]) / 2, z: 1.7 };
      expect(blocked(stand, 0.28, l.colliders), `standing at ${stand.x},${stand.z}`).toBe(false);
      // Aimed at from there, the rack is what you hit (its monitor, at eye height).
      const mid: [number, number, number] = [stand.x, 1.25, b.max[2]];
      const from: [number, number, number] = [stand.x, EYE_HEIGHT, stand.z];
      const d: [number, number, number] = [mid[0] - from[0], mid[1] - from[1], mid[2] - from[2]];
      const len = Math.hypot(...d);
      expect(pickNearest(from, [d[0] / len, d[1] / len, d[2] / len], l.props.map((p) => ({ boxes: [p.box], value: p.id })), 3)?.value, `${n} desks`).toBe('server.rack');
    }
  });

  it('#196: hangs the MCP & skills screen on the north wall over the rack, clear of everything, on every floor size and outline', () => {
    const outlines = [undefined, { width: 18, depth: 14 }, { width: 24, depth: 17.8 }, { width: 31, depth: 23.1 }, { width: 40, depth: 28.4 }, outlineOf([MAX_DESKS])];
    const inside = (a: { min: readonly number[]; max: readonly number[] }, o: { min: readonly number[]; max: readonly number[] }) =>
      [0, 1, 2].every((i) => (a.min[i] as number) < (o.max[i] as number) && (a.max[i] as number) > (o.min[i] as number));
    for (let n = 0; n <= MAX_DESKS; n++) {
      for (const outline of outlines) {
        const l = floorLayout(n, outline);
        const at = `${n} desks, ${l.width} x ${l.depth}`;
        const screen = l.props.find((p) => p.id === 'screen.mcp');
        expect(screen, at).toMatchObject({ label: 'MCP & skills', milestone: '#196', solid: false });
        const b = (screen as NonNullable<typeof screen>).box;
        expect(b, at).toEqual({ min: [MCP_SCREEN_BOX[0], MCP_SCREEN_BOX[1], MCP_SCREEN_BOX[2]], max: [MCP_SCREEN_BOX[3], MCP_SCREEN_BOX[4], MCP_SCREEN_BOX[5]] });
        // A thin bezel box on the north wall, facing +z, above the rack's monitor and under the window heads.
        expect(b.min[2], at).toBe(0);
        expect(b.max[2], at).toBeLessThanOrEqual(0.1);
        expect(b.min[1] - RACK_BOX[4], at).toBeGreaterThanOrEqual(0.2);
        expect(b.max[1], at).toBeLessThan(HEAD);
        // It overlaps no other prop (the rack, the whiteboard, the TV, the boards, the overview screen…), with room to spare on the wall.
        for (const p of l.props) {
          if (p.id === 'screen.mcp') continue;
          expect(inside(b, p.box), `${p.id} at ${at}`).toBe(false);
          if (p.box.min[2] < 0.2 && p.id !== 'server.rack') expect(p.box.min[0] - b.max[0] >= 0.3 || b.min[0] - p.box.max[0] >= 0.3 || p.box.min[1] - b.max[1] >= 0.3 || b.min[1] - p.box.max[1] >= 0.3, `${p.id} margin at ${at}`).toBe(true);
        }
        // Clear of the north windows' frames (5 cm past the hole) by 0.2 m, and of the mezzanine (slab, glass, posts and their room).
        for (const o of l.openings.filter((o) => o.wall === 'north')) {
          expect(b.min[0] >= o.u1 + 0.05 + 0.2 || b.max[0] <= o.u0 - 0.05 - 0.2 || b.max[1] <= o.y0, `window ${o.u0}-${o.u1} at ${at}`).toBe(true);
        }
        const m = l.mezzanine;
        expect(b.max[0] < m.rect.x0 - 1, at).toBe(true);
        expect(inside(b, m.slab), at).toBe(false);
        for (const g of m.glass) expect(inside(b, g), at).toBe(false);
        for (const p of m.posts) expect(p.x - POST_W / 2 > b.max[0] + 0.5 || p.z - POST_W / 2 > b.max[2] + 0.5, `post at ${p.x},${p.z} at ${at}`).toBe(true);
        // Nor any wall but the north one it hangs on: the partition and the board wall are far south.
        expect(l.boardWall.z0, at).toBeGreaterThan(5);
      }
    }
  });

  it('#196: the MCP screen is read from where you stand in front of the rack and from the lounge, and the rack stays its own pick', () => {
    for (const n of [0, 6, 13, 20, 62, 96]) {
      const l = floorLayout(n);
      const b = l.props.find((p) => p.id === 'screen.mcp')?.box as NonNullable<ReturnType<typeof floorLayout>['props'][number]>['box'];
      const props = l.props.map((p) => ({ boxes: [p.box], value: p.id }));
      const pick = (from: [number, number, number], to: [number, number, number]) => {
        const d: [number, number, number] = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
        const len = Math.hypot(...d);
        return pickNearest(from, [d[0] / len, d[1] / len, d[2] / len], props, 4, l.walls)?.value;
      };
      const mid: [number, number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]];
      // From the rack's front, looking up at the screen; from the lounge's east end, looking north-east.
      for (const from of [
        [6.2, EYE_HEIGHT, 1.9],
        [5.4, EYE_HEIGHT, 2.4],
        [4.6, EYE_HEIGHT, 3.0],
      ] as Array<[number, number, number]>) {
        expect(blocked({ x: from[0], z: from[2] }, 0.28, l.colliders), `stand ${from} at ${n}`).toBe(false);
        expect(pick(from, mid), `from ${from} at ${n} desks`).toBe('screen.mcp');
        // A comfortable reading distance for a 2.1 m screen: about 2 to 3.5 m.
        const dist = Math.hypot(mid[0] - from[0], mid[1] - from[1], mid[2] - from[2]);
        expect(dist).toBeGreaterThan(1.5);
        expect(dist).toBeLessThan(4);
      }
      // Looking at the rack's monitor from in front of it still picks the rack.
      const rack = l.props.find((p) => p.id === 'server.rack')?.box as typeof b;
      expect(pick([6.2, EYE_HEIGHT, 1.7], [6.2, 1.25, rack.max[2]]), `${n} desks`).toBe('server.rack');
    }
  });

  it('spawns at the entrance, free to move, facing the board wall within reach', () => {
    for (const n of [6, 20, 62]) {
      const l = floorLayout(n);
      expect(blocked(l.spawn, 0.3, l.colliders)).toBe(false);
      expect(l.spawn.z).toBeGreaterThan(l.depth - 2);
      // yaw 0 looks down -z: the first thing ahead at eye height is the PRs board.
      const eye = [l.spawn.x, EYE_HEIGHT, l.spawn.z] as const;
      const hit = pickNearest(eye, [0, 0, -1], l.props.map((p) => ({ boxes: [p.box], value: p.id })), 3);
      expect(hit?.value).toBe('board.prs');
    }
  });

  it('keeps every seat reachable from the spawn (flood fill over a 0.25 m grid)', () => {
    const l = floorLayout(62);
    const r = 0.3;
    const step = 0.25;
    const key = (i: number, j: number) => `${i},${j}`;
    const seen = new Set<string>();
    const q: Array<[number, number]> = [[Math.round(l.spawn.x / step), Math.round(l.spawn.z / step)]];
    while (q.length) {
      const [i, j] = q.pop() as [number, number];
      if (seen.has(key(i, j))) continue;
      // The fire-escape doorway is open: stay inside the room.
      if (i * step < 0 || i * step > l.width || j * step < 0 || j * step > l.depth) continue;
      if (blocked({ x: i * step, z: j * step }, r, l.colliders)) continue;
      seen.add(key(i, j));
      q.push([i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]);
    }
    for (const s of l.slots) {
      const i = Math.round(s.seat.x / step);
      const j = Math.round(s.seat.z / step);
      const near = [-2, -1, 0, 1, 2].some((a) => [-2, -1, 0, 1, 2].some((b) => seen.has(key(i + a, j + b))));
      expect(near, `seat ${s.index}`).toBe(true);
    }
  });
});

describe('building outline', () => {
  const counts = [6, 10, 20, 41, 62];
  const outline = outlineOf(counts);
  const floors = counts.map((n) => floorLayout(n, outline));

  it('is the biggest floor in each direction, and every floor shares it', () => {
    expect(outline.width).toBe(Math.max(...counts.map((n) => floorLayout(n).width)));
    expect(outline.depth).toBe(Math.max(...counts.map((n) => floorLayout(n).depth)));
    for (const l of floors) expect([l.width, l.depth]).toEqual([outline.width, outline.depth]);
    expect(outlineOf([])).toEqual({ width: 18, depth: 14 });
  });

  it('keeps the desk grid centred and the lounge and cabinet against the walls', () => {
    for (const l of floors) {
      const xs = l.slots.flatMap((s) => [s.desk.x - 0.7, s.desk.x + 0.7]);
      // Pod centres (a pod's desks meet back to back), a pod 3.7 m deep with its chairs.
      const zs = l.slots.flatMap((s) => {
        const cz = s.desk.z + (s.yaw === 0 ? 0.35 : -0.35);
        return [cz - 1.85, cz + 1.85];
      });
      const a = l.deskArea;
      expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo((a.x0 + a.x1) / 2, 6);
      expect((Math.min(...zs) + Math.max(...zs)) / 2).toBeCloseTo((a.z0 + a.z1) / 2, 6);
      const lounge = l.props.find((p) => p.id === 'lounge');
      const filing = l.props.find((p) => p.id === 'filing');
      expect(lounge?.box.min[0]).toBeLessThan(1);
      expect(lounge?.box.min[2]).toBeLessThan(1);
      expect(filing?.box.max[0]).toBeCloseTo(l.width - 0.3, 6);
      expect(filing?.box.min[2]).toBeLessThan(1);
    }
  });

  it('lines the windows and the fire-escape door up from floor to floor', () => {
    const [first] = floors;
    for (const l of floors) {
      expect(l.openings).toEqual(first?.openings);
      expect(l.fireDoor).toEqual(first?.fireDoor);
    }
    const door = first?.openings.find((o) => o.kind === 'door');
    expect(door).toMatchObject({ wall: 'west' });
    expect(door?.u0).toBeCloseTo(outline.depth - 2.8, 6);
    expect(door?.u1).toBeCloseTo(outline.depth - 1.6, 6);
    // Clear of the board wall (it ends west at x >= 3) and south of the coffee counter.
    expect(first?.walls[4]?.min[0]).toBeGreaterThanOrEqual(3);
    expect(door?.u0).toBeGreaterThan(first?.walls[4]?.max[2] ?? 0);
  });

  it('grows every floor when one floor outgrows the outline', () => {
    const before = outlineOf([6, 20]);
    const after = outlineOf([6, 20, 96]);
    expect(after.width).toBeGreaterThan(before.width);
    expect(after.depth).toBeGreaterThan(before.depth);
    for (const n of [6, 20, 96]) expect(floorLayout(n, after)).toMatchObject({ width: after.width, depth: after.depth });
    expect(floorLayout(6, after).fireDoor.z0).toBeCloseTo(after.depth - 2.8, 6);
  });

  it('keeps every seat reachable and the doorway free on a floor bigger than its desks need', () => {
    const l = floorLayout(6, outlineOf([96]));
    const mid = (l.fireDoor.z0 + l.fireDoor.z1) / 2;
    expect(blocked({ x: -0.1, z: mid }, 0.28, l.colliders)).toBe(false);
    expect(blocked({ x: -0.1, z: l.fireDoor.z0 - 0.4 }, 0.28, l.colliders)).toBe(true);
    for (const s of l.slots) expect(blocked(s.seat, 0.28, l.colliders)).toBe(false);
  });
});

describe('wallPieces', () => {
  it('cuts a wall around its window and door, keeping the rest', () => {
    const wall = { min: [0, 0, -0.2] as [number, number, number], max: [10, 3, 0] as [number, number, number] };
    const pieces = wallPieces(wall, 0, [
      { u0: 6, u1: 7.2, y0: 0, y1: 2.3 },
      { u0: 2, u1: 4, y0: 0.9, y1: 2.4 },
    ]);
    const vol = (b: { min: number[]; max: number[] }) => (b.max[0]! - b.min[0]!) * (b.max[1]! - b.min[1]!) * (b.max[2]! - b.min[2]!);
    const total = pieces.reduce((n, b) => n + vol(b), 0);
    expect(total).toBeCloseTo(0.2 * (30 - 2 * 1.5 - 1.2 * 2.3), 6);
    // Nothing is left in either hole.
    const inside = (x: number, y: number) => pieces.some((b) => x > b.min[0]! && x < b.max[0]! && y > b.min[1]! && y < b.max[1]!);
    expect(inside(3, 1.5)).toBe(false);
    expect(inside(6.6, 1)).toBe(false);
    expect(inside(3, 0.5)).toBe(true);
    expect(inside(6.6, 2.8)).toBe(true);
    expect(inside(5, 1.5)).toBe(true);
  });
});

describe('moveWithCollision', () => {
  const wall: Rect = { x0: 2, z0: -5, x1: 2.2, z1: 5 };
  it('stops at a wall and slides along it', () => {
    const p = moveWithCollision({ x: 0, z: 0 }, { x: 5, z: 1 }, 0.3, [wall]);
    expect(p.x).toBeCloseTo(1.7, 6);
    expect(p.z).toBeCloseTo(1, 6);
  });
  it('does not tunnel through thin walls on a big step', () => {
    const p = moveWithCollision({ x: 0, z: 0 }, { x: 50, z: 0 }, 0.3, [wall]);
    expect(p.x).toBeLessThanOrEqual(1.7 + 1e-9);
  });
  it('moves freely without obstacles', () => {
    expect(moveWithCollision({ x: 1, z: 1 }, { x: -0.5, z: 2 }, 0.3, [])).toEqual({ x: 0.5, z: 3 });
  });
  it('keeps the walker inside the room', () => {
    const l = floorLayout(6);
    let p = { x: l.spawn.x, z: l.spawn.z };
    for (let i = 0; i < 200; i++) p = moveWithCollision(p, { x: 0.37, z: 0.29 }, 0.3, l.colliders);
    expect(p.x).toBeLessThan(l.width);
    expect(p.z).toBeLessThan(l.depth);
    expect(blocked(p, 0.3, l.colliders)).toBe(false);
  });
});

describe('picking', () => {
  const b = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
  it('rayBox hits and misses', () => {
    expect(rayBox([-1, 0.5, 0.5], [1, 0, 0], b)).toBeCloseTo(1, 6);
    expect(rayBox([-1, 2, 0.5], [1, 0, 0], b)).toBeNull();
    expect(rayBox([2, 0.5, 0.5], [1, 0, 0], b)).toBeNull();
    expect(rayBox([0.5, 0.5, 0.5], [0, 0, 1], b)).toBe(0);
  });
  it('picks the nearest target within range, behind no wall', () => {
    const l = floorLayout(6);
    const s = l.slots[2];
    if (!s) throw new Error('slot');
    const boxes = slotBoxes(s);
    const targets = [
      { boxes: [boxes.seat], value: 'worker' },
      { boxes: [boxes.desk], value: 'desk' },
    ];
    // Standing 1.5 m south of a south-row seat, looking north at it.
    const eye = [s.seat.x, 1.0, s.seat.z + 1.5] as const;
    expect(pickNearest(eye, [0, 0, -1], targets, 3)?.value).toBe('worker');
    expect(pickNearest(eye, [0, 0, -1], targets, 1)).toBeNull();
    const wall = { min: [s.seat.x - 1, 0, s.seat.z + 0.8] as [number, number, number], max: [s.seat.x + 1, 3, s.seat.z + 0.9] as [number, number, number] };
    expect(pickNearest(eye, [0, 0, -1], targets, 3, [wall])).toBeNull();
    expect(seatRect(s).x1 - seatRect(s).x0).toBeCloseTo(0.6, 6);
  });
});
