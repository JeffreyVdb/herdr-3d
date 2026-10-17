import { describe, expect, it } from 'vitest';
import type { Schedule } from '../net/protocol';
import { boardCountdown, boardTime, cellAt, cellBoxes, departureState, departuresScope, floorDepartures, lobbyBoardPlan, lobbyDepartures, type LobbyFloor } from './departures';
import { ScheduleBook, SCHEDULE_GRACE_MS } from './schedule';

// #65 (part 4 of #61): the departures boards' text model. The board draws exactly this, so a board redraws only when
// it changes, and `nextAt` says when it can next change (a second under an hour away, else the next minute).

const T = Date.UTC(2026, 9, 17, 7, 0); // Sat 17 Oct 2026, 07:00 UTC (09:00 in Brussels)
const S = 1000;
const M = 60_000;
const H = 3_600_000;
const D = 24 * H;
const TZ = 'Europe/Brussels';

function sched(id: string, o: Partial<Schedule> = {}): Schedule {
  return {
    id,
    floor: 'herdr-3d',
    title: `Task ${id}`,
    prompt: 'Do it.',
    due_at: T + H,
    on_miss: 'run_late',
    harness: 'claude',
    model: 'claude-opus-5-5',
    effort: 'high',
    cwd: '/home/dev/herdr-3d',
    worktree: false,
    wake_floor: true,
    source: { kind: 'manual' },
    state: 'scheduled',
    created_at: T - H,
    updated_at: T - H,
    ...o,
  };
}

const book = (list: Schedule[] | undefined) => {
  const b = new ScheduleBook();
  b.reset(list);
  return b;
};

describe('a departure’s state (#65)', () => {
  it('scheduled counts down; due within the grace says so; past the grace it is delayed by spanText', () => {
    expect(departureState(sched('a', { due_at: T + 90 * S }), T)).toEqual({ state: 'scheduled', status: 'in 1m 30s' });
    expect(departureState(sched('a', { due_at: T }), T)).toEqual({ state: 'due', status: 'Due now' });
    expect(departureState(sched('a', { due_at: T - SCHEDULE_GRACE_MS }), T)).toEqual({ state: 'due', status: 'Due now' });
    expect(departureState(sched('a', { due_at: T - SCHEDULE_GRACE_MS - S }), T)).toEqual({ state: 'delayed', status: 'Delayed +5m' });
    expect(departureState(sched('a', { due_at: T - 2 * H - 20 * M }), T)).toEqual({ state: 'delayed', status: 'Delayed +2h 20m' });
  });

  it('waiting boards until the grace is over, then it is delayed too; running is departing, late or not', () => {
    expect(departureState(sched('a', { state: 'waiting', due_at: T - M }), T)).toEqual({ state: 'boarding', status: 'Boarding' });
    // Waiting before its time (a Run now that waits for a desk) boards as well.
    expect(departureState(sched('a', { state: 'waiting', due_at: T + H }), T)).toEqual({ state: 'boarding', status: 'Boarding' });
    expect(departureState(sched('a', { state: 'waiting', due_at: T - 12 * M }), T)).toEqual({ state: 'delayed', status: 'Delayed +12m' });
    expect(departureState(sched('a', { state: 'running', due_at: T - 3 * H, fired_at: T - S }), T)).toEqual({ state: 'departing', status: 'Departing' });
  });

  it('the countdown has seconds under an hour, minutes under a day, hours beyond', () => {
    expect(boardCountdown(42 * S)).toBe('in 42s');
    expect(boardCountdown(59 * M + 59 * S + 999)).toBe('in 59m 59s');
    expect(boardCountdown(H)).toBe('in 1h 00m');
    expect(boardCountdown(4 * H + 5 * M + 59 * S)).toBe('in 4h 05m');
    expect(boardCountdown(2 * D + 3 * H + 59 * M)).toBe('in 2d 3h');
  });

  it('the time is the zone’s clock; another day says which', () => {
    expect(boardTime(T + H + 45 * M, T, TZ)).toBe('10:45');
    expect(boardTime(T + D, T, TZ)).toBe('Sun 09:00');
    expect(boardTime(T + 6 * D, T, TZ)).toBe('Fri 09:00');
    expect(boardTime(T + 7 * D, T, TZ)).toBe('24 Oct 09:00');
    expect(boardTime(T - D, T, TZ)).toBe('Fri 09:00');
    expect(boardTime(T, T, 'UTC')).toBe('07:00');
  });
});

describe('the floor board (#65)', () => {
  it('empty: no rows, nothing to tick', () => {
    const b = floorDepartures(book([]), 'herdr-3d', T, TZ);
    expect(b).toEqual({ known: true, rows: [], attention: 0, later: 0, nextAt: Infinity });
  });

  it('a bridge before #62 (no schedules in its snapshot) is not known: the board says so, it does not throw', () => {
    expect(floorDepartures(book(undefined), 'herdr-3d', T, TZ)).toEqual({ known: false, rows: [], attention: 0, later: 0, nextAt: Infinity });
  });

  it('the floor’s next three upcoming, soonest first; the rest are later; other floors and done ones are not there', () => {
    const b = book([
      sched('d', { due_at: T + 4 * H, title: 'Fourth' }),
      sched('a', { due_at: T + 10 * M, title: 'First' }),
      sched('c', { due_at: T + 2 * H, title: 'Third', state: 'waiting' }),
      sched('b', { due_at: T + H + 30 * M, title: 'Second' }),
      sched('x', { due_at: T + M, floor: 'pastry' }),
      sched('y', { state: 'done', fired_at: T - H }),
    ]);
    const f = floorDepartures(b, 'herdr-3d', T, TZ);
    expect(f.rows).toEqual([
      { id: 'a', title: 'First', time: '09:10', state: 'scheduled', status: 'in 10m 00s' },
      { id: 'b', title: 'Second', time: '10:30', state: 'scheduled', status: 'in 1h 30m' },
      { id: 'c', title: 'Third', time: '11:00', state: 'boarding', status: 'Boarding' },
    ]);
    expect(f.later).toBe(1);
    expect(f.attention).toBe(0);
  });

  it('counts the failed and skipped ones not dismissed as needing attention', () => {
    const b = book([sched('a', { state: 'failed' }), sched('b', { state: 'skipped' }), sched('c', { state: 'failed', floor: 'pastry' })]);
    expect(floorDepartures(b, 'herdr-3d', T, TZ)).toMatchObject({ rows: [], attention: 2 });
  });

  it('ticks a second ahead while one is under an hour away (either side), else at the next minute', () => {
    const at = T + 400; // mid-second
    expect(floorDepartures(book([sched('a', { due_at: T + 30 * M })]), 'herdr-3d', at, TZ).nextAt).toBe(T + S);
    expect(floorDepartures(book([sched('a', { due_at: T - 30 * M })]), 'herdr-3d', at, TZ).nextAt).toBe(T + S);
    expect(floorDepartures(book([sched('a', { due_at: T + 3 * H })]), 'herdr-3d', at + 20 * S, TZ).nextAt).toBe(T + M);
    // Beyond the hour, the one that comes into it first: the minute, or the instant it does if sooner.
    expect(floorDepartures(book([sched('a', { due_at: T + H + 10 * S })]), 'herdr-3d', at, TZ).nextAt).toBe(T + 10 * S);
  });

  it('the text only changes on those ticks: between two of them it reads the same', () => {
    const b = book([sched('a', { due_at: T + 3 * H + 17 * S }), sched('b', { due_at: T + 40 * M + 300 })]);
    for (const now of [T + 100, T + 900, T + 2 * S + 400]) {
      const f = floorDepartures(b, 'herdr-3d', now, TZ);
      const g = floorDepartures(b, 'herdr-3d', f.nextAt - 1, TZ);
      expect(g.rows, `${now}`).toEqual(f.rows);
    }
    // Beyond the hour alone: a whole minute of the same text.
    const far = book([sched('a', { due_at: T + 3 * H + 17 * S })]);
    const f = floorDepartures(far, 'herdr-3d', T + 5 * S, TZ);
    expect(f.nextAt).toBe(T + M);
    expect(floorDepartures(far, 'herdr-3d', T + M - 1, TZ).rows).toEqual(f.rows);
    expect(floorDepartures(far, 'herdr-3d', T + M, TZ).rows).not.toEqual(f.rows);
  });

  it('a snapshot again, a re-delivered upsert or a removal gives the same picture: no duplicates, no stale rows', () => {
    const a = sched('a', { due_at: T + 10 * M });
    const b = book([a, sched('b', { due_at: T + 20 * M })]);
    const first = floorDepartures(b, 'herdr-3d', T, TZ);
    b.upsert(a);
    expect(floorDepartures(b, 'herdr-3d', T, TZ)).toEqual(first);
    b.reset([a, sched('b', { due_at: T + 20 * M })]);
    expect(floorDepartures(b, 'herdr-3d', T, TZ)).toEqual(first);
    b.removed({ t: 'schedule.removed', seq: 9, id: 'b' });
    expect(floorDepartures(b, 'herdr-3d', T, TZ).rows.map((r) => r.id)).toEqual(['a']);
    b.upsert({ ...a, state: 'cancelled' });
    expect(floorDepartures(b, 'herdr-3d', T, TZ).rows).toEqual([]);
  });
});

describe('the lobby board (#65)', () => {
  const floors: LobbyFloor[] = [
    { id: 'herdr-3d', name: 'herdr-3d', level: 1 },
    { id: 'depot', name: 'depot-manager', level: 2 },
    { id: 'pastry', name: 'pastry', level: 3 },
  ];

  it('one group per floor of the building, the top floor first; another building’s floors are not on it', () => {
    const b = book([
      sched('a', { floor: 'herdr-3d', due_at: T + 5 * M }),
      sched('b', { floor: 'pastry', due_at: T + 2 * H }),
      sched('c', { floor: 'pastry', state: 'failed' }),
      sched('d', { floor: 'elsewhere', due_at: T + M }),
      sched('e', { floor: 'elsewhere', state: 'skipped' }),
    ]);
    const l = lobbyDepartures(b, floors, T, TZ, 3);
    expect(l.known).toBe(true);
    expect(l.groups.map((g) => [g.floor, g.name, g.level, g.rows.map((r) => r.id), g.attention])).toEqual([
      ['pastry', 'pastry', 3, ['b'], 1],
      ['depot', 'depot-manager', 2, [], 0],
      ['herdr-3d', 'herdr-3d', 1, ['a'], 0],
    ]);
    expect(l.nextAt).toBe(T + S);
  });

  it('at most `lines` rows a floor, the rest counted as later', () => {
    const b = book([1, 2, 3, 4].map((i) => sched(`s${i}`, { due_at: T + i * H })));
    const g = lobbyDepartures(b, floors, T, TZ, 2).groups.find((x) => x.floor === 'herdr-3d');
    expect(g?.rows.map((r) => r.id)).toEqual(['s1', 's2']);
    expect(g?.later).toBe(2);
  });

  it('a bridge before #62: every group empty, not known', () => {
    const l = lobbyDepartures(book(undefined), floors, T, TZ, 3);
    expect(l.known).toBe(false);
    expect(l.groups.every((g) => g.rows.length === 0 && g.attention === 0)).toBe(true);
  });
});

describe('what a board opens (#65)', () => {
  it('a floor’s board or a lobby group: that floor; the lobby board elsewhere: all floors', () => {
    expect(departuresScope(undefined, 'herdr-3d')).toEqual({ floor: 'herdr-3d' });
    expect(departuresScope('pastry', 'herdr-3d')).toEqual({ floor: 'pastry' });
    expect(departuresScope('pastry', null)).toEqual({ floor: 'pastry' });
    expect(departuresScope(null, null)).toEqual({ floor: null, allFloors: true });
    expect(departuresScope(null, 'herdr-3d')).toEqual({ floor: null, allFloors: true });
  });
});

describe('the lobby board’s groups (#65)', () => {
  // The lobby board: 4.4 × 2.4 m.
  const W = 4.4;
  const Hm = 2.4;

  it('three lines a floor while they fit, the biggest type that does; fewer lines for a tall building', () => {
    expect(lobbyBoardPlan(1, W, Hm)).toMatchObject({ cols: 1, rows: 1, lines: 3 });
    expect(lobbyBoardPlan(3, W, Hm)).toMatchObject({ cols: 2, rows: 2, lines: 3 });
    expect(lobbyBoardPlan(6, W, Hm)).toMatchObject({ cols: 2, rows: 3, lines: 2 });
    expect(lobbyBoardPlan(12, W, Hm)).toMatchObject({ cols: 2, rows: 6, lines: 1 });
    expect(lobbyBoardPlan(0, W, Hm).cells).toEqual([]);
  });

  it('cells do not overlap, sit under the header and inside the board, one per floor in order', () => {
    for (const n of [1, 2, 3, 5, 8, 12, 20]) {
      const p = lobbyBoardPlan(n, W, Hm);
      expect(p.cells).toHaveLength(n);
      for (const [i, c] of p.cells.entries()) {
        expect(c.u0, `${n}`).toBeGreaterThan(0);
        expect(c.u1).toBeLessThan(1);
        expect(c.v0).toBeGreaterThanOrEqual(p.head);
        expect(c.v1).toBeLessThan(1);
        for (const d of p.cells.slice(i + 1)) expect(c.u0 < d.u1 && d.u0 < c.u1 && c.v0 < d.v1 && d.v0 < c.v1, `${n}: cells ${i}`).toBe(false);
      }
      // Reading order: left to right, then down.
      if (n > 1) expect(p.cells[1]!.v0 > p.cells[0]!.v0 || p.cells[1]!.u0 > p.cells[0]!.u0).toBe(true);
    }
  });

  it('a point in a group is that group; the header and the gaps are the board (all floors)', () => {
    const p = lobbyBoardPlan(3, W, Hm);
    p.cells.forEach((c, i) => expect(cellAt(p, (c.u0 + c.u1) / 2, (c.v0 + c.v1) / 2)).toBe(i));
    expect(cellAt(p, 0.5, p.head / 2)).toBeNull();
    expect(cellAt(p, 0.5, (p.cells[0]!.v0 + p.cells[0]!.v1) / 2)).toBeNull(); // between the columns
    expect(cellAt(p, 0.002, 0.5)).toBeNull();
  });

  it('a group’s pick box is its cell on the board’s face, a centimetre proud of it', () => {
    const board = { min: [1, 1, 0], max: [5.4, 3.4, 0.1] } as { min: [number, number, number]; max: [number, number, number] };
    const p = lobbyBoardPlan(1, W, Hm);
    const [b] = cellBoxes(board, p.cells);
    const c = p.cells[0]!;
    expect(b!.min[0]).toBeCloseTo(1 + c.u0 * 4.4, 6);
    expect(b!.max[0]).toBeCloseTo(1 + c.u1 * 4.4, 6);
    expect(b!.max[1]).toBeCloseTo(3.4 - c.v0 * 2.4, 6);
    expect(b!.min[1]).toBeCloseTo(3.4 - c.v1 * 2.4, 6);
    expect(b!.min[2]).toBe(0);
    expect(b!.max[2]).toBeCloseTo(0.11, 6);
  });
});
