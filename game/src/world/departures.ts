import type { Schedule } from '../net/protocol';
import { civilAt } from './daylight';
import type { Box3 } from './layout';
import { SCHEDULE_GRACE_MS, scheduleSections, spanText, type ScheduleBook } from './schedule';

/**
 * #65 (part 4 of #61): the departures boards, the game's side: what each board says, as text, and when that can next
 * change. Pure, no DOM: the boards (render/departuresBoard.ts) draw exactly this model and redraw only when it differs
 * from the one they drew last.
 *
 * - A row is an upcoming schedule (`scheduleSections`' upcoming: scheduled, waiting, running), soonest first: its
 *   title, its time on the zone's clock and a status: a countdown, "Due now", "Boarding" (waiting), "Departing"
 *   (running) or "Delayed +Xm".
 * - **Delayed**: an upcoming schedule that has not started (scheduled or waiting) whose `due_at` is more than the
 *   bridge's grace (`SCHEDULE_GRACE_MS`, 5 min) ago, by `spanText` of how long ago. Within the grace a scheduled one is
 *   "Due now" (the bridge's 30 s tick has not fired it yet) and a waiting one boards. A running one departs, however
 *   late: it has fired, and how late it fired is the dialog's and the toast's.
 * - **Cadence**: a row due within an hour (either side) reads its countdown to the second and the board ticks every
 *   second; else to the minute, ticking on the minute (and at the instant a row comes within the hour). Each row's text
 *   is computed from the clock rounded down to its own step, so between two ticks nothing changes.
 */

const S = 1000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The floor board's rows. */
export const FLOOR_ROWS = 3;

export type DepartureState = 'scheduled' | 'due' | 'boarding' | 'departing' | 'delayed';

export interface DepartureRow {
  id: string;
  title: string;
  /** `10:45`, `Sun 09:00` (another day this week), `24 Oct 09:00`. */
  time: string;
  state: DepartureState;
  /** `in 12m 07s`, `Due now`, `Boarding`, `Departing`, `Delayed +12m`. */
  status: string;
}

/** A floor's departures as a board shows them. */
export interface Departures {
  rows: DepartureRow[];
  /** Failed and skipped schedules not dismissed: "N need attention". */
  attention: number;
  /** Upcoming ones past the rows shown. */
  later: number;
}

export interface FloorBoard extends Departures {
  /** False: the bridge is older than scheduled agents (#62), its snapshot has none. */
  known: boolean;
  /** When the text can next change (unix ms); Infinity: only when the schedules do. */
  nextAt: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const down = (t: number, step: number) => Math.floor(t / step) * step;

/** How long until a departure (ms > 0): `in 42s`, `in 12m 07s`, `in 4h 05m`, `in 2d 3h`. */
export function boardCountdown(ms: number): string {
  if (ms < MIN) return `in ${Math.floor(ms / S)}s`;
  if (ms < HOUR) return `in ${Math.floor(ms / MIN)}m ${pad(Math.floor((ms % MIN) / S))}s`;
  if (ms < DAY) return `in ${Math.floor(ms / HOUR)}h ${pad(Math.floor((ms % HOUR) / MIN))}m`;
  return `in ${Math.floor(ms / DAY)}d ${Math.floor((ms % DAY) / HOUR)}h`;
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A departure's time on the zone's clock: `10:45` today, `Sun 09:00` within six days either side, else `24 Oct 09:00`. */
export function boardTime(at: number, now: number, tz: string): string {
  const c = civilAt(at, tz);
  const n = civilAt(now, tz);
  const clock = `${pad(c.hour)}:${pad(c.minute)}`;
  const days = Math.round((Date.UTC(c.year, c.month - 1, c.day) - Date.UTC(n.year, n.month - 1, n.day)) / DAY);
  if (days === 0) return clock;
  if (Math.abs(days) <= 6) return `${WEEKDAY[c.weekday]} ${clock}`;
  return `${c.day} ${MONTH[c.month - 1]} ${clock}`;
}

/** A departure's state and status at `now` (see the top of the file). */
export function departureState(s: Pick<Schedule, 'state' | 'due_at'>, now: number): { state: DepartureState; status: string } {
  if (s.state === 'running') return { state: 'departing', status: 'Departing' };
  const late = now - s.due_at;
  if (late > SCHEDULE_GRACE_MS) return { state: 'delayed', status: `Delayed +${spanText(late)}` };
  if (s.state === 'waiting') return { state: 'boarding', status: 'Boarding' };
  if (late >= 0) return { state: 'due', status: 'Due now' };
  return { state: 'scheduled', status: boardCountdown(-late) };
}

/** One floor's departures (`list`: that floor's schedules) at `now`, at most `n` rows, and when they can next change. */
function departuresOf(list: readonly Schedule[], now: number, tz: string, n: number): Departures & { nextAt: number } {
  const sec = scheduleSections(list);
  const shown = sec.upcoming.slice(0, Math.max(0, n));
  let nextAt = Infinity;
  const rows = shown.map((s): DepartureRow => {
    // Within the hour either side: to the second; else to the minute, until the row comes within the hour.
    const fine = Math.abs(s.due_at - now) <= HOUR;
    const step = fine ? S : MIN;
    const at = down(now, step);
    nextAt = Math.min(nextAt, at + step);
    if (!fine && s.due_at - HOUR > now) nextAt = Math.min(nextAt, s.due_at - HOUR);
    return { id: s.id, title: s.title, time: boardTime(s.due_at, at, tz), ...departureState(s, at) };
  });
  return { rows, attention: sec.attention.length, later: sec.upcoming.length - shown.length, nextAt };
}

/** The floor board of `floor`. */
export function floorDepartures(book: Pick<ScheduleBook, 'known' | 'all'>, floor: string, now: number, tz: string, n = FLOOR_ROWS): FloorBoard {
  if (!book.known) return { known: false, rows: [], attention: 0, later: 0, nextAt: Infinity };
  return { known: true, ...departuresOf(book.all().filter((s) => s.floor === floor), now, tz, n) };
}

/** A floor of the lobby's building: its id, name and level (1 = the bottom office floor). */
export interface LobbyFloor {
  id: string;
  name: string;
  level: number;
}

export interface LobbyGroup extends Departures {
  floor: string;
  name: string;
  level: number;
}

/** The lobby board: a group per floor of its building (`floors`, and only those), the top floor first, `n` rows each. */
export function lobbyDepartures(book: Pick<ScheduleBook, 'known' | 'all'>, floors: readonly LobbyFloor[], now: number, tz: string, n: number): { known: boolean; groups: LobbyGroup[]; nextAt: number } {
  const byFloor = new Map<string, Schedule[]>(floors.map((f) => [f.id, []]));
  if (book.known) for (const s of book.all()) byFloor.get(s.floor)?.push(s);
  let nextAt = Infinity;
  const groups = [...floors]
    .sort((a, b) => b.level - a.level)
    .map((f): LobbyGroup => {
      const d = departuresOf(byFloor.get(f.id) ?? [], now, tz, n);
      nextAt = Math.min(nextAt, d.nextAt);
      return { floor: f.id, name: f.name, level: f.level, rows: d.rows, attention: d.attention, later: d.later };
    });
  return { known: book.known, groups, nextAt };
}

/**
 * The floor board's line on the HUD while you aim at it: the next departure and what else is on, in words that change
 * when a departure moves on, not every second (no countdown). Pure.
 */
export function departuresLine(m: Pick<FloorBoard, 'known' | 'rows' | 'attention' | 'later'> | null): string {
  if (!m) return 'This floor’s scheduled agents';
  if (!m.known) return 'This herdr-world can’t schedule agents yet';
  const parts: string[] = [];
  const r = m.rows[0];
  if (r) {
    const what = { scheduled: `at ${r.time}`, due: 'due now', boarding: 'boarding', departing: 'departing', delayed: 'delayed' }[r.state];
    parts.push(`Next: “${r.title}” ${what}`);
    const more = m.rows.length - 1 + m.later;
    if (more > 0) parts.push(`${more} more`);
  } else parts.push('No departures scheduled');
  if (m.attention > 0) parts.push(`${m.attention} ${m.attention === 1 ? 'needs' : 'need'} attention`);
  return parts.join(' · ');
}

/**
 * What E on a board opens: a floor's board (`floor` undefined: the floor you are on, `here`) or a lobby group (its
 * floor) that floor's schedules; the lobby board anywhere else (`null`) every floor's, every building's.
 */
export function departuresScope(floor: string | null | undefined, here: string | null): { floor: string | null; allFloors?: boolean } {
  if (floor === null) return { floor: null, allFloors: true };
  return { floor: floor ?? here };
}

/** A lobby group's place on the board: 0..1 across (u, left to right) and down (v, top to bottom). */
export interface Cell {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface LobbyPlan {
  cols: number;
  rows: number;
  /** Departures a group shows (under its floor's line). */
  lines: number;
  /** A line's height on the board, a share of its height. */
  line: number;
  /** The header's share of the board's height (the board above the groups). */
  head: number;
  /** A page's cells: a group each, `perPage` of them. */
  cells: Cell[];
  /** Groups a page holds, and how many pages the floors take (one while they fit at two lines): `lobbyPage`. */
  perPage: number;
  pages: number;
}

/** The lobby board's measures (metres): its margin, header, the gap under it and between columns, a line's height. */
const LOBBY_MARGIN = 0.14;
const LOBBY_HEAD = 0.5;
const LOBBY_GAP = 0.06;
const LOBBY_COL_GAP = 0.24;
/** A group's gap below it, in lines. */
const LOBBY_ROW_GAP = 0.5;
/** A line no bigger than this (type would outgrow the columns), and while it can be, no smaller. */
const LINE_MAX = 0.24;
const LINE_MIN = 0.14;
/** A column at least this wide holds a time, a title and a countdown. */
const CELL_MIN = 2.2;

/**
 * How `n` floors' groups fit a `w` × `h` m lobby board: three departures a floor while a line can stay `LINE_MIN` tall,
 * else two; among those the plan with the biggest line (ties: fewer columns), columns no narrower than `CELL_MIN`. The
 * groups read left to right, then down. A building too tall for one page at two lines takes **pages** of even size
 * (9 floors: 5 + 4), as few as hold them at two lines, each planned as above (`lobbyPage` turns them). Never one line:
 * a group shows its next two or three departures. Pure.
 */
export function lobbyBoardPlan(n: number, w: number, h: number): LobbyPlan {
  const head = LOBBY_HEAD / h;
  const top = LOBBY_HEAD + LOBBY_GAP;
  const bodyW = w - 2 * LOBBY_MARGIN;
  const bodyH = h - top - LOBBY_MARGIN;
  if (n <= 0) return { cols: 1, rows: 0, lines: 3, line: LINE_MAX / h, head, cells: [], perPage: 0, pages: 1 };
  const plan = (k: number, cols: number, lines: number) => {
    const rows = Math.ceil(k / cols);
    const line = Math.min(LINE_MAX, bodyH / (rows * (1 + lines) + (rows - 1) * LOBBY_ROW_GAP));
    return { cols, rows, lines, line, cellW: (bodyW - (cols - 1) * LOBBY_COL_GAP) / cols };
  };
  /** The best plan for `k` groups at `LINE_MIN` or more, or (`small`) at two lines whatever the size; null: none. */
  const fit = (k: number, small = false) => {
    let best: ReturnType<typeof plan> | null = null;
    for (const lines of [3, 2]) {
      for (let cols = 1; cols <= k; cols++) {
        const p = plan(k, cols, lines);
        if (p.cellW < CELL_MIN && (cols > 1 || !small)) break;
        if ((p.line >= LINE_MIN || (small && lines === 2)) && (!best || p.line > best.line + 1e-9)) best = p;
      }
      if (best) break;
    }
    return best;
  };
  let per = n;
  if (!fit(n)) {
    let cap = 1;
    while (cap < n && fit(cap + 1)) cap++;
    per = Math.ceil(n / Math.ceil(n / cap));
  }
  // A board too small for even one group at `LINE_MIN`: two lines, as big as fit.
  const p = (fit(per) ?? fit(per, true)) as ReturnType<typeof plan>;
  const groupH = (1 + p.lines) * p.line;
  const cells: Cell[] = [];
  for (let i = 0; i < per; i++) {
    const c = i % p.cols;
    const r = Math.floor(i / p.cols);
    const x = LOBBY_MARGIN + c * (p.cellW + LOBBY_COL_GAP);
    const y = top + r * (groupH + LOBBY_ROW_GAP * p.line);
    cells.push({ u0: x / w, u1: (x + p.cellW) / w, v0: y / h, v1: (y + groupH) / h });
  }
  return { cols: p.cols, rows: p.rows, lines: p.lines, line: p.line / h, head, cells, perPage: per, pages: Math.ceil(n / per) };
}

/** How long the lobby board shows a page of floors before the next, when they take more than one. */
export const LOBBY_PAGE_MS = 10_000;

/**
 * The page of `n` floors' groups (`per` a page) the lobby board shows at `now`: the floors `start` to `end` (top floor
 * first) and when the next page turns (`nextAt`; never with one page). A pure function of the clock, so a board that was
 * out of view comes back on the page it would be on.
 */
export function lobbyPage(n: number, per: number, now: number): { page: number; pages: number; start: number; end: number; nextAt: number } {
  const pages = per > 0 ? Math.max(1, Math.ceil(n / per)) : 1;
  if (pages === 1) return { page: 0, pages, start: 0, end: n, nextAt: Infinity };
  const turn = Math.floor(now / LOBBY_PAGE_MS);
  const page = turn % pages;
  return { page, pages, start: page * per, end: Math.min(n, (page + 1) * per), nextAt: (turn + 1) * LOBBY_PAGE_MS };
}

/** The group at a point of the board (u, v as in `Cell`), or null: the header, a margin or a gap (all floors). */
export function cellAt(plan: Pick<LobbyPlan, 'cells'>, u: number, v: number): number | null {
  const i = plan.cells.findIndex((c) => u >= c.u0 && u <= c.u1 && v >= c.v0 && v <= c.v1);
  return i < 0 ? null : i;
}

/** The pick boxes of a +z-facing board's groups: each cell on its face, a centimetre proud of the board's box. */
export function cellBoxes(board: Box3, cells: readonly Cell[]): Box3[] {
  const [x0, y0, z0] = board.min;
  const [x1, y1, z1] = board.max;
  return cells.map((c) => ({ min: [x0 + c.u0 * (x1 - x0), y1 - c.v1 * (y1 - y0), z0], max: [x0 + c.u1 * (x1 - x0), y1 - c.v0 * (y1 - y0), z1 + 0.01] }));
}
