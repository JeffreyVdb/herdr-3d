import { describe, expect, it } from 'vitest';
import '../test/fakeCanvas';
import type { Schedule } from '../net/protocol';
import { floorDepartures, lobbyBoardPlan, lobbyDepartures, type DepartureRow, type FloorBoard } from '../world/departures';
import { ScheduleBook } from '../world/schedule';
import { attentionText, buildFloorDepartures, buildLobbyDepartures, EMPTY, OLD_BRIDGE, paintFloorBoard, paintLobbyBoard, rowColumns, type LobbyBoardModel } from './departuresBoard';
import { STATUS_CHIP_CSS, STATUS_CSS, WALL as WALL_COLORS, WALL_UBUNTU } from './palette';

// #65 (part 4 of #61): the departures boards' textures. The fake canvas measures 10 px a character and records nothing,
// so each test records what the painter writes (`fillText`) and the colours it fills shapes with (`fill`).

const T = Date.UTC(2026, 9, 17, 7, 0);
const M = 60_000;
const H = 3_600_000;
const TZ = 'UTC';

interface Text {
  s: string;
  x: number;
  y: number;
  fill: string;
  align: string;
}

/** A canvas context that records its text and its shape fills. */
function recorder(W = 992, Hpx = 378) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = Hpx;
  const g = c.getContext('2d') as unknown as CanvasRenderingContext2D & Record<string, unknown>;
  const texts: Text[] = [];
  const fills: string[] = [];
  g.fillText = (s: string, x: number, y: number) => void texts.push({ s, x, y, fill: String(g.fillStyle), align: String(g.textAlign) });
  g.fill = () => void fills.push(String(g.fillStyle));
  return { g: g as CanvasRenderingContext2D, W, H: Hpx, texts, fills, said: () => texts.map((t) => t.s) };
}

const row = (o: Partial<DepartureRow>): DepartureRow => ({ id: 'a', title: 'Nightly soak cleanup', time: '09:10', state: 'scheduled', status: 'in 10m 00s', ...o });
const board = (o: Partial<FloorBoard>): FloorBoard => ({ known: true, rows: [], attention: 0, later: 0, nextAt: Infinity, ...o });

function sched(id: string, o: Partial<Schedule> = {}): Schedule {
  return {
    id, floor: 'herdr-3d', title: `Task ${id}`, prompt: 'Do it.', due_at: T + H, on_miss: 'run_late', harness: 'claude', model: 'claude-opus-5-5', effort: 'high',
    cwd: '/home/dev/herdr-3d', worktree: false, wake_floor: true, source: { kind: 'manual' }, state: 'scheduled', created_at: T - H, updated_at: T - H, ...o,
  };
}

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe('the floor board’s texture (#65)', () => {
  it('empty: "No departures scheduled" and how to schedule one; no attention line', () => {
    const r = recorder();
    paintFloorBoard(r.g, r.W, r.H, board({}));
    expect(r.said()).toEqual(['Departures', EMPTY, 'Look here and press E to schedule an agent.']);
    expect(r.fills).not.toContain(STATUS_CSS.needs_you);
  });

  it('a bridge older than scheduled agents says so, and nothing else', () => {
    const r = recorder();
    paintFloorBoard(r.g, r.W, r.H, board({ known: false }));
    expect(r.said()).toEqual(['Departures', OLD_BRIDGE]);
  });

  it('three upcoming: each time on flaps, the title, the countdown right-aligned; the rest later', () => {
    const r = recorder();
    paintFloorBoard(r.g, r.W, r.H, board({
      rows: [row({ id: 'a', title: 'First', time: '09:10' }), row({ id: 'b', title: 'Second', time: '10:30', status: 'in 1h 20m' }), row({ id: 'c', title: 'Third', time: 'Sun 11:00', status: 'in 1d 2h' })],
      later: 2,
    }));
    const said = r.said();
    for (const t of ['First', 'Second', 'Third', 'in 10m 00s', 'in 1h 20m', 'in 1d 2h', 'Sun', '+2 later']) expect(said).toContain(t);
    // The flaps: a character each, the time's digits in the board's yellow.
    const flapped = r.texts.filter((t) => t.align === 'center').map((t) => t.s).join('');
    expect(flapped).toBe('091010301100');
    expect(r.texts.filter((t) => t.align === 'center').every((t) => t.fill === WALL_COLORS.accent)).toBe(true);
    // Rows top to bottom, each status at the right edge.
    const titles = ['First', 'Second', 'Third'].map((s) => r.texts.find((t) => t.s === s) as Text);
    expect(titles[0]!.y).toBeLessThan(titles[1]!.y);
    expect(titles[1]!.y).toBeLessThan(titles[2]!.y);
    const status = r.texts.find((t) => t.s === 'in 10m 00s') as Text;
    expect(status.align).toBe('right');
    expect(status.x).toBeGreaterThan(r.W * 0.9);
  });

  it('the attention count is a red line: 1 needs, 2 need', () => {
    expect(attentionText(1)).toBe('1 needs attention');
    const r = recorder();
    paintFloorBoard(r.g, r.W, r.H, board({ rows: [row({})], attention: 2 }));
    const line = r.texts.find((t) => t.s === '2 need attention') as Text;
    expect(line).toBeDefined();
    expect(r.fills).toContain(STATUS_CSS.needs_you);
    expect(line.y).toBeGreaterThan(r.H * 0.85);
    // Red on the board's ink reads (text: 4.5:1), in either UI theme's office.
    for (const c of [WALL_COLORS, WALL_UBUNTU]) expect(contrast(STATUS_CSS.needs_you, c.ink)).toBeGreaterThanOrEqual(4.5);
  });

  it('waiting boards on a teal chip; departing on a blue one, its time dimmed; late is a red "Delayed +Xm" chip', () => {
    const r = recorder();
    paintFloorBoard(r.g, r.W, r.H, board({
      rows: [row({ id: 'w', state: 'boarding', status: 'Boarding' }), row({ id: 'r', state: 'departing', status: 'Departing' }), row({ id: 'l', state: 'delayed', status: 'Delayed +12m' })],
    }));
    for (const [s, chipBg] of [
      ['Boarding', STATUS_CHIP_CSS.waiting],
      ['Departing', STATUS_CHIP_CSS.working],
      ['Delayed +12m', STATUS_CHIP_CSS.needs_you],
    ] as const) {
      const t = r.texts.find((x) => x.s === s) as Text;
      expect(t, s).toBeDefined();
      expect(t.fill).toBe('#ffffff');
      expect(r.fills).toContain(chipBg);
      expect(contrast('#ffffff', chipBg), s).toBeGreaterThanOrEqual(4.5);
    }
    // The departing row's flaps are dimmed: it has left.
    const flapInks = r.texts.filter((t) => t.align === 'center').map((t) => t.fill);
    expect(flapInks.slice(4, 8).every((f) => f === WALL_COLORS.text3)).toBe(true);
    expect(flapInks.slice(0, 4).every((f) => f === WALL_COLORS.accent)).toBe(true);
  });

  it('a long title is cut with an ellipsis before the status column; a countdown’s seconds never move the cut', () => {
    const long = 'Rotate every staging credential, then re-run the nightly soak against the new cluster and file the report';
    const u = 378 / 100;
    const style = { flapW: u * 8, flapH: u * 13, title: u * 8, status: u * 7, day: 0 };
    const cut = (rows: DepartureRow[]) => {
      const r = recorder();
      const rects: number[][] = [];
      (r.g as unknown as Record<string, unknown>).roundRect = (x: number, y: number, w: number, h: number) => void rects.push([x, y, w, h]);
      paintFloorBoard(r.g, r.W, r.H, board({ rows }));
      return { t: r.texts.find((x) => x.s.startsWith('Rotate')) as Text, texts: r.texts, rects, W: r.W };
    };
    // Countdowns: the column keeps room for the widest one (`in 23h 59m`, 10 characters in the fake), whatever this one says.
    for (const status of ['in 9s', 'in 59m 59s', 'in 4h 05m']) {
      const { t, W } = cut([row({ title: long, status })]);
      expect(t.s.endsWith('…')).toBe(true);
      expect(t.s.slice(0, -1)).toBe(t.s.slice(0, -1).trimEnd());
      const col = rowColumns(u * 5, W - u * 5, style, 100);
      expect(t.x).toBeCloseTo(col.title, 6);
      expect(t.s.length).toBe(Math.floor(col.titleMax / 10));
    }
    // A chip: the cut ends before the chip's left edge, with a gap; every title of the board is cut at the same place.
    const { t, texts, rects, W } = cut([row({ title: long, status: 'Delayed +2h 20m', state: 'delayed' }), row({ id: 'b', title: `${long} again`, status: 'in 9s' })]);
    const chipX = Math.min(...rects.filter((r) => r[0]! > W / 2).map((r) => r[0]!));
    expect(t.x + t.s.length * 10).toBeLessThanOrEqual(chipX - u * 8 * 0.9 + 1e-6);
    const other = texts.find((x) => x.s.startsWith('Rotate') && x !== t) as Text;
    expect(other.s.length).toBe(t.s.length);
  });

  it('the sun yellow on a flap and white titles on the ink read (Ubuntu: its orange text on aubergine)', () => {
    for (const c of [WALL_COLORS, WALL_UBUNTU]) {
      expect(contrast(c.accent, c.flap)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.accent, c.ink)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.text, c.ink)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.text2, c.ink)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.text3, c.ink)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.text, c.flap)).toBeGreaterThanOrEqual(4.5);
      for (const d of ['working', 'done', 'waiting', 'needs_you'] as const) expect(contrast('#ffffff', STATUS_CHIP_CSS[d]), d).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('Ubuntu’s office board: its glass, its orange clocks, its face', () => {
    const r = recorder();
    const fills: string[] = [];
    const rect = r.g.fillRect.bind(r.g);
    r.g.fillRect = (x: number, y: number, w: number, h: number) => (fills.push(String(r.g.fillStyle)), rect(x, y, w, h));
    let font = '';
    const text = r.g.fillText;
    r.g.fillText = (s: string, x: number, y: number) => ((font ||= r.g.font), text(s, x, y));
    paintFloorBoard(r.g, r.W, r.H, board({ rows: [row({})] }), WALL_UBUNTU);
    expect(fills[0]).toBe(WALL_UBUNTU.ink);
    expect(fills).not.toContain(WALL_COLORS.ink);
    const flapInks = r.texts.filter((t) => t.align === 'center').map((t) => t.fill);
    expect(flapInks.slice(0, 4).every((f) => f === WALL_UBUNTU.accent)).toBe(true);
    expect(font).toContain('"Ubuntu"');
  });
});

describe('the floor board’s redraws (#65)', () => {
  const box = { min: [7.4, 2.5, 9.59], max: [10.6, 3.9, 9.81] } as { min: [number, number, number]; max: [number, number, number] };

  it('no redraw, no texture upload when nothing changed; a model is computed only when the schedules or the clock call for it', () => {
    const b = new ScheduleBook();
    b.reset([sched('a', { due_at: T + 3 * H + 17_000 })]);
    const mesh = buildFloorDepartures(box);
    let models = 0;
    const model = (now: number) => {
      models++;
      return floorDepartures(b, 'herdr-3d', now, TZ);
    };
    expect(mesh.tick(b.version, T + 5_000, true, model)).toBe(true);
    expect(mesh.info()).toMatchObject({ draws: 1, nextAt: T + M });
    // Idle: the same schedules, before the next minute: not due, nothing computed.
    for (const now of [T + 6_000, T + 30_000, T + M - 1]) {
      expect(mesh.due(b.version, now)).toBe(false);
      expect(mesh.tick(b.version, now, true, model)).toBe(false);
    }
    expect(models).toBe(1);
    // A re-delivered upsert: the version moves, the picture does not: computed, not drawn.
    b.upsert(sched('a', { due_at: T + 3 * H + 17_000 }));
    expect(mesh.tick(b.version, T + 40_000, true, model)).toBe(false);
    expect(models).toBe(2);
    expect(mesh.info().draws).toBe(1);
    // The minute: the countdown moves, a redraw.
    expect(mesh.tick(b.version, T + M, true, model)).toBe(true);
    expect(mesh.info().draws).toBe(2);
    mesh.dispose();
  });

  it('ticks every second while a departure is under an hour away, once a minute beyond', () => {
    const b = new ScheduleBook();
    b.reset([sched('a', { due_at: T + 20 * M })]);
    const mesh = buildFloorDepartures(box);
    const model = (now: number) => floorDepartures(b, 'herdr-3d', now, TZ);
    mesh.tick(b.version, T + 300, true, model);
    expect(mesh.info().nextAt).toBe(T + 1_000);
    for (let s = 1; s <= 5; s++) expect(mesh.tick(b.version, T + s * 1_000, true, model), `${s} s`).toBe(true);
    expect(mesh.info().draws).toBe(6);
    expect(mesh.info().model?.rows[0]?.status).toBe('in 19m 55s');
    mesh.dispose();
  });

  it('at most once a second, whatever comes in; out of view nothing is drawn after the first picture, and it catches up in view', () => {
    const b = new ScheduleBook();
    b.reset([]);
    const mesh = buildFloorDepartures(box);
    const model = (now: number) => floorDepartures(b, 'herdr-3d', now, TZ);
    expect(mesh.tick(b.version, T, false, model)).toBe(true); // the first picture, out of view or not
    b.upsert(sched('a', { due_at: T + 5 * H }));
    expect(mesh.tick(b.version, T + 300, true, model)).toBe(false); // within the second
    expect(mesh.tick(b.version, T + 1_000, false, model)).toBe(false); // out of view
    expect(mesh.info().draws).toBe(1);
    expect(mesh.due(b.version, T + 1_000)).toBe(true);
    expect(mesh.tick(b.version, T + 2_000, true, model)).toBe(true);
    expect(mesh.info().model?.rows.map((r) => r.id)).toEqual(['a']);
    mesh.dispose();
  });

  it('a row replaced by one that reads the same is no redraw (the id is not drawn), yet the board knows it', () => {
    const b = new ScheduleBook();
    b.reset([sched('a', { title: 'Same task', due_at: T + 3 * H })]);
    const mesh = buildFloorDepartures(box);
    const model = (now: number) => floorDepartures(b, 'herdr-3d', now, TZ);
    expect(mesh.tick(b.version, T + 1_000, true, model)).toBe(true);
    b.removed({ t: 'schedule.removed', seq: 2, id: 'a' });
    b.upsert(sched('b', { title: 'Same task', due_at: T + 3 * H }));
    expect(mesh.tick(b.version, T + 2_000, true, model)).toBe(false);
    expect(mesh.info().draws).toBe(1);
    expect(mesh.info().model?.rows.map((r) => r.id)).toEqual(['b']);
    mesh.dispose();
  });
});

describe('the lobby board’s texture (#65)', () => {
  const floors = [
    { id: 'herdr-3d', name: 'herdr-3d', level: 1 },
    { id: 'depot', name: 'depot-manager', level: 2 },
    { id: 'pastry', name: 'pastry', level: 3 },
  ];
  const lobby = (b: ScheduleBook): LobbyBoardModel => {
    const plan = lobbyBoardPlan(floors.length, 5.5, 2.7);
    return { ...lobbyDepartures(b, floors, T, TZ, plan.lines), building: 'Work', plan, logo: null, page: 0, pages: 1 };
  };

  it('a group per floor: its number on a flap, its name, its departures or "No departures scheduled", its attention count', () => {
    const b = new ScheduleBook();
    b.reset([sched('a', { title: 'Soak cleanup', due_at: T + 10 * M }), sched('f', { floor: 'pastry', state: 'failed' }), sched('x', { floor: 'other', title: 'Not here' })]);
    const r = recorder(1376, 736);
    paintLobbyBoard(r.g, r.W, r.H, lobby(b));
    const said = r.said();
    for (const t of ['Departures', 'Work', 'pastry', 'depot-manager', 'herdr-3d', 'Soak cleanup', 'in 10m 00s', '1 needs attention']) expect(said, t).toContain(t);
    expect(said.filter((s) => s === EMPTY)).toHaveLength(2);
    expect(said).not.toContain('Not here');
    // Top floor first, each group's number on its flap.
    const at = (s: string) => r.texts.find((t) => t.s === s) as Text;
    expect(at('3').align).toBe('center');
    expect(at('pastry').y).toBeLessThanOrEqual(at('herdr-3d').y);
  });

  it('a bridge older than scheduled agents: the floors, no rows, and why', () => {
    const b = new ScheduleBook();
    b.reset(undefined);
    const r = recorder(1376, 736);
    paintLobbyBoard(r.g, r.W, r.H, lobby(b));
    expect(r.said()).toContain(OLD_BRIDGE);
    expect(r.said()).not.toContain(EMPTY);
    expect(r.said()).toContain('depot-manager');
  });

  it('the lobby board redraws on a new logo or floors (invalidate), not otherwise', () => {
    const b = new ScheduleBook();
    b.reset([]);
    const mesh = buildLobbyDepartures({ min: [6.2, 1, 0], max: [11.8, 3.8, 0.1] });
    let logo: LobbyBoardModel['logo'] = null;
    const model = () => ({ ...lobby(b), logo });
    expect(mesh.tick(b.version, T, true, model)).toBe(true);
    expect(mesh.due(b.version, T + 5_000)).toBe(false);
    logo = { hash: 'H1', image: document.createElement('canvas'), width: 200, height: 100 };
    mesh.invalidate();
    expect(mesh.tick(b.version, T + 5_000, true, model)).toBe(true);
    expect(mesh.info().model?.logo).toBe('H1');
    mesh.invalidate();
    expect(mesh.tick(b.version, T + 9_000, true, model)).toBe(false);
    expect(mesh.info().draws).toBe(2);
    mesh.dispose();
  });

  it('a building of more floors than a page holds: a page of groups, each with two or three departures, and which page', () => {
    const tall = Array.from({ length: 12 }, (_, i) => ({ id: `f${i + 1}`, name: `floor-${i + 1}`, level: i + 1 }));
    const plan = lobbyBoardPlan(tall.length, 5.5, 2.7);
    expect(plan.pages).toBe(2);
    const b = new ScheduleBook();
    b.reset([1, 2, 3, 4].map((k) => sched(`t${k}`, { floor: 'f12', title: `Top ${k}`, due_at: T + k * H })));
    const top = [...tall].reverse();
    const page = (i: number): LobbyBoardModel => {
      const floors = top.slice(i * plan.perPage, (i + 1) * plan.perPage);
      return { ...lobbyDepartures(b, floors, T, TZ, plan.lines), building: 'Tower', plan, logo: null, page: i, pages: plan.pages };
    };
    const r = recorder(1376, 736);
    paintLobbyBoard(r.g, r.W, r.H, page(0));
    const said = r.said();
    expect(said).toContain('Floors 12–7 · 1/2');
    // The top floor's next three (its fourth is "later"), not one.
    for (const t of ['Top 1', 'Top 2', 'Top 3', '+1 later']) expect(said, t).toContain(t);
    expect(said).not.toContain('floor-6');
    const r2 = recorder(1376, 736);
    paintLobbyBoard(r2.g, r2.W, r2.H, page(1));
    expect(r2.said()).toContain('Floors 6–1 · 2/2');
    expect(r2.said()).toContain('floor-1');
    expect(r2.said()).not.toContain('floor-12');
    // A page turn is a new picture; the same page is not.
    const mesh = buildLobbyDepartures({ min: [6.2, 1, 0], max: [11.8, 3.8, 0.1] });
    let at = 0;
    const model = () => page(at);
    expect(mesh.tick(b.version, T, true, model)).toBe(true);
    mesh.invalidate();
    expect(mesh.tick(b.version, T + 1_000, true, model)).toBe(false);
    at = 1;
    mesh.invalidate();
    expect(mesh.tick(b.version, T + 2_000, true, model)).toBe(true);
    expect(mesh.shown()?.groups.map((g) => g.floor)).toEqual(['f6', 'f5', 'f4', 'f3', 'f2', 'f1']);
    mesh.dispose();
  });
});
