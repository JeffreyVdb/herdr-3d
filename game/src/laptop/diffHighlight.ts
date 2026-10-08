/**
 * #206: syntax colours inside the transcript's diff rows, added after the rows draw.
 *
 * A diff's rows draw plain, as before, and stay so in the DOM: colours are painted over their text with the CSS Custom
 * Highlight API (`CSS.highlights`, one highlight per token colour, `::highlight()` in transcript.css), which costs no
 * restyle or layout. Without the API (jsdom, old browsers) rows stay plain.
 * - The language is the path's extension's (diffTokens.diffLanguage); none known, nothing happens.
 * - Each hunk's two sides are tokenized whole (diffTokens.hunkSides), so what spans rows colours right.
 * - A hunk of up to MAIN_BUDGET characters is tokenized on the page's thread, in background tasks of about SLICE_MS
 *   (one hunk at least, then the next while the slice lasts). A larger one (a created 2,000-line file is one hunk, ~100 ms)
 *   goes to a worker (diffHighlight.worker.ts, made on first need); without one it stays plain.
 * - Ranges are painted only on the rows around what a diff's box shows (its view, and a view more above and below), and
 *   only while the box is on screen or near it: Chromium re-checks every range in the page on any change to the DOM
 *   (~1.5 µs a range on the e2e host: the ~30,000 of two large diffs would add ~45 ms to every frame that changes the
 *   page). Scrolling the box moves them along, in the frame it scrolls in. A row is painted only while it still shows
 *   the text it drew with; a diff that left the page (a re-render, a live update, a loaded full change) loses its ranges.
 * - Results are kept (MAX_CACHE characters): a diff drawn again (a re-render, the terminal and back) colours at once.
 *
 * `?diffhl=off` turns it off and `?diffhl=trace` measures every slice (performance entries `tx-diff-hl`), for the
 * long-task check (e2e/h206-diff-highlight.spec.ts).
 */
import { diffLanguage, HL_COLOURS, hunkSides, rowRanges, tokenizeHunk, tokensText, type HunkSides, type HunkTokens } from './diffTokens';
import type { DiffHlReply, DiffHlRequest } from './diffHighlight.worker';

type Highlighter = typeof import('highlight.js/lib/common').default;

/** Characters (both sides) a hunk may have to be tokenized on the page's thread: ~10 ms in Chromium. */
export const MAIN_BUDGET = 12_000;
/** Past this a hunk is not coloured at all, even by the worker. */
export const MAX_HUNK = 1_000_000;
/** A background task's work: past it the next hunk waits for the next task. */
const SLICE_MS = 8;
/** Characters of tokenized hunks kept for a diff drawn again. */
const MAX_CACHE = 2_000_000;
/** How often diffs that left the page are looked for, while there are any (most go sooner: when anything is drawn or painted). */
const SWEEP_MS = 10_000;

const MODE = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('diffhl');
  } catch {
    return null;
  }
})();
const OFF = MODE === 'off';
const TRACE = MODE === 'trace';

/** One hunk of one drawn diff. */
interface Hunk {
  diff: Diff;
  lines: readonly string[];
  sides: HunkSides | null;
  size: number;
  key: string;
  state: 'idle' | 'queued' | 'done';
  tokens: HunkTokens | null;
}

/** A drawn row of code, the diff's `n`th: hunk `hk`'s line `i`, in `row` (its text cell `dt`, one text node as drawn). */
interface Row {
  n: number;
  hk: Hunk;
  i: number;
  row: HTMLElement;
  dt: HTMLElement;
  /** Its ranges while painted, on the text node they paint; false: nothing to paint there, ever. */
  painted: { node: Text; ranges: Array<[Highlight, StaticRange]> } | null | false;
}

interface Diff {
  path: unknown;
  /** The language, once the highlighter is loaded (null: none, the diff stays plain). */
  lang: string | null | undefined;
  /** The box its rows scroll in. */
  body: HTMLElement;
  /** Its drawn rows of code, top to bottom. */
  rows: Row[];
  /** Its box is on screen, or near. */
  inView: boolean;
  painted: Set<Row>;
  /**
   * Its box was seen in the page: until then a box not in it is one still being built, not one gone (a diff is drawn
   * before its row is put in the page). The timer sweeps one never seen twice before letting go of it.
   */
  seen: boolean;
  unseen: number;
}

/** What a diff's view tells about its rows. */
export interface DiffColours {
  /** A row was drawn (hunk `k`'s line `i`; the row, and its text cell `dt` holding the line as drawn): colour it when its hunk is ready. */
  row(k: number, i: number, row: HTMLElement, dt: HTMLElement): void;
}

/** The page can paint highlights. */
const canPaint = () => typeof Highlight === 'function' && typeof StaticRange === 'function' && typeof CSS !== 'undefined' && !!CSS.highlights;

/**
 * Colours for a diff's rows: `hunks` are its hunks' lines (null for a hunk that is not code: it stays plain), `body` the
 * box its rows are drawn in. Null when its path names no language at all, or the page cannot paint highlights.
 */
export function diffColours(path: unknown, hunks: ReadonlyArray<readonly string[] | null>, body: HTMLElement): DiffColours | null {
  if (OFF || !canPaint() || diffLanguage(path, () => true) === null) return null;
  // A diff drawn is often one re-rendered: the one it replaced lets go of its ranges now.
  sweep();
  const diff: Diff = { path, lang: undefined, body, rows: [], inView: !observers(), painted: new Set(), seen: false, unseen: 0 };
  const work = hunks.map((lines): Hunk | null => (lines ? { diff, lines, sides: null, size: 0, key: '', state: 'idle', tokens: null } : null));
  live.add(diff);
  byBody.set(body, diff);
  io?.observe(body);
  ro?.observe(body);
  body.addEventListener('scroll', () => dirty(diff), { passive: true });
  sweepLater();
  return {
    row(k, i, row, dt) {
      const hk = work[k];
      if (!hk) return;
      diff.rows.push({ n: diff.rows.length, hk, i, row, dt, painted: null });
      if (hk.state === 'done') dirty(diff);
      else if (hk.state === 'idle') {
        hk.state = 'queued';
        incoming.push(hk);
        pump();
      }
    },
  };
}

// ---- the queues -----------------------------------------------------------------------------------------------

let hl: Highlighter | null = null;
let hlLoad: Promise<void> | null = null;
let hlFailed = false;
/** Hunks waiting for the highlighter, or to be sorted (cache, page, worker). */
const incoming: Hunk[] = [];
/** Hunks for the page's thread. */
const mainQ: Hunk[] = [];
/** Hunks for the worker. */
const workerQ: Hunk[] = [];
const cache = new Map<string, { tokens: HunkTokens; size: number }>();
let cached = 0;
let scheduled = false;

function done(hk: Hunk, tokens: HunkTokens | null): void {
  hk.state = 'done';
  hk.tokens = tokens;
  if (tokens && hk.key && !cache.has(hk.key) && hk.size <= MAX_CACHE / 4) {
    cache.set(hk.key, { tokens, size: hk.size });
    cached += hk.size;
    for (const [k, v] of cache) {
      if (cached <= MAX_CACHE) break;
      cached -= v.size;
      cache.delete(k);
    }
  }
  if (tokens) dirty(hk.diff);
}

/** Sorts what came in, once the highlighter is there: known language or not, from the cache, here or in the worker. */
function sort(): void {
  const h = hl as Highlighter;
  for (const hk of incoming.splice(0)) {
    const d = hk.diff;
    if (d.lang === undefined) d.lang = diffLanguage(d.path, (n) => !!h.getLanguage(n));
    if (!d.lang) {
      done(hk, null);
      continue;
    }
    const sides = hunkSides(hk.lines);
    hk.sides = sides;
    hk.size = sides.old.length + sides.neu.length;
    hk.key = `${d.lang}\n${sides.old}\u0000${sides.neu}`;
    const hit = cache.get(hk.key);
    if (hit) {
      // Freshest last: the cache drops its oldest first.
      cache.delete(hk.key);
      cache.set(hk.key, hit);
      done(hk, hit.tokens);
    } else if (hk.size <= MAIN_BUDGET) mainQ.push(hk);
    else if (hk.size <= MAX_HUNK && worker() !== null) workerQ.push(hk);
    else done(hk, null);
  }
  feedWorker();
}

const now = () => performance.now();
const alive = (d: Diff) => d.body.isConnected;

function pump(): void {
  if (scheduled) return;
  scheduled = true;
  const sched = (globalThis as { scheduler?: { postTask?: (f: () => void, o: { priority: string }) => Promise<unknown> } }).scheduler;
  if (sched?.postTask) void sched.postTask(run, { priority: 'background' }).catch(() => {});
  else setTimeout(run, 0);
}

/** One background task: hunks tokenized while the slice lasts. */
function run(): void {
  scheduled = false;
  if (!hl) {
    // No highlighter (its chunk failed to load): everything stays plain.
    if (hlFailed) for (const hk of incoming.splice(0)) done(hk, null);
    else {
      hlLoad ??= import('highlight.js/lib/common').then(
        (m) => {
          hl = m.default;
        },
        () => {
          hlFailed = true;
        },
      );
      void hlLoad.then(pump);
    }
    return;
  }
  const t0 = now();
  const end = t0 + SLICE_MS;
  sort();
  let n = 0;
  let chars = 0;
  for (;;) {
    if (n > 0 && now() >= end) break;
    const hk = mainQ.shift();
    if (!hk) break;
    n++;
    if (!alive(hk.diff)) {
      done(hk, null);
      continue;
    }
    const lang = hk.diff.lang as string;
    const h = hl;
    chars += hk.size;
    done(hk, tokenizeHunk((text, language) => h.highlight(text, { language, ignoreIllegals: true }).value, lang, (hk.sides as HunkSides).old, (hk.sides as HunkSides).neu));
  }
  if (TRACE) performance.measure('tx-diff-hl', { start: t0, end: now(), detail: { chars } });
  if (mainQ.length || incoming.length) pump();
  idle();
}

/** Traced: a mark each time nothing is left to do (what the long-task check waits for, without looking at rows). */
function idle(): void {
  if (TRACE && !diffColoursBusy()) performance.mark('tx-diff-hl-idle');
}

// ---- painting -------------------------------------------------------------------------------------------------

/** The highlights' names: a token colour's `tx-hl-<colour>` (HL_COLOURS' order), and an added or deleted row's plain text. */
export const HL_NAMES = HL_COLOURS.map(([c]) => `tx-hl-${c}`);
export const HL_PLAIN = 'tx-hl-plain';

let plainHl: Highlight | null = null;
let colourHls: Highlight[] = [];

/** The highlights, in the page's registry (made the first time; put back if it lost them). */
function highlights(): { plain: Highlight; colours: Highlight[] } {
  if (!plainHl) {
    // A row's plain text under its tokens' colours.
    plainHl = new Highlight();
    plainHl.priority = 0;
    colourHls = HL_NAMES.map(() => Object.assign(new Highlight(), { priority: 1 }));
  }
  const reg = CSS.highlights;
  if (reg.get(HL_PLAIN) !== plainHl) reg.set(HL_PLAIN, plainHl);
  HL_NAMES.forEach((name, i) => {
    if (reg.get(name) !== colourHls[i]) reg.set(name, colourHls[i] as Highlight);
  });
  return { plain: plainHl, colours: colourHls };
}

/** Which boxes are on screen or near (a missing one, as in jsdom: all are), and when one changes size. */
let io: IntersectionObserver | null | undefined;
let ro: ResizeObserver | null = null;
const byBody = new WeakMap<Element, Diff>();
/** Diffs drawn and not let go of yet. */
const live = new Set<Diff>();
/** Diffs whose painted rows need a look, at the next frame. */
const dirtyQ = new Set<Diff>();
let frameAsked = false;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;

function observers(): IntersectionObserver | null {
  if (io !== undefined) return io;
  io = null;
  if (typeof IntersectionObserver === 'function') {
    // The timeline scrolls: a box within a screen of showing counts already (scrollMargin: within the timeline's clip too).
    const margin = '100% 0px';
    io = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          const d = byBody.get(e.target);
          if (!d) continue;
          d.inView = e.isIntersecting;
          dirty(d);
        }
      },
      { rootMargin: margin, scrollMargin: margin },
    );
  }
  if (typeof ResizeObserver === 'function')
    ro = new ResizeObserver((es) => {
      for (const e of es) {
        const d = byBody.get(e.target);
        if (d) dirty(d);
      }
    });
  return io;
}

function dirty(d: Diff): void {
  dirtyQ.add(d);
  if (frameAsked) return;
  frameAsked = true;
  // In the frame's own callbacks: a box scrolled in a frame has its colours in that frame.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}

/** A frame's painting: every diff that changed (scrolled, came into view, gained rows or tokens) brought up to date. */
function flush(): void {
  frameAsked = false;
  const t0 = now();
  sweep();
  let ranges = 0;
  for (const d of dirtyQ) {
    dirtyQ.delete(d);
    ranges += update(d);
  }
  if (TRACE) performance.measure('tx-diff-hl', { start: t0, end: now(), detail: { ranges } });
  idle();
}

/**
 * Of `count` rows (top to bottom, `edges(i)` the top and bottom of the `i`th), those `[lo, hi]` that reach into
 * `[top, bottom]`; none when hi < lo.
 */
export function rowWindow(count: number, edges: (i: number) => readonly [number, number], top: number, bottom: number): [number, number] {
  let a = 0;
  let b = count;
  // The first row whose bottom is below `top`.
  while (a < b) {
    const m = (a + b) >> 1;
    if (edges(m)[1] > top) b = m;
    else a = m + 1;
  }
  const lo = a;
  b = count;
  // The first row from there whose top is at or below `bottom`.
  while (a < b) {
    const m = (a + b) >> 1;
    if (edges(m)[0] >= bottom) b = m;
    else a = m + 1;
  }
  return [lo, a - 1];
}

/** The rows of a diff to paint: those its box shows, and a box's height more above and below it. */
function windowOf(d: Diff): [number, number] {
  if (!d.inView) return [0, -1];
  // Nothing to tell what shows (jsdom): all.
  if (!io) return [0, d.rows.length - 1];
  const box = d.body.getBoundingClientRect();
  // Not laid out (hidden).
  if (!box.height) return [0, -1];
  const edges = (i: number) => {
    const r = (d.rows[i] as Row).row.getBoundingClientRect();
    return [r.top, r.bottom] as const;
  };
  return rowWindow(d.rows.length, edges, box.top - box.height, box.bottom + box.height);
}

/** A diff's ranges brought to its window: rows that left it (or changed) lose theirs, rows that came in gain theirs. */
function update(d: Diff): number {
  if (!alive(d)) {
    if (d.seen) forget(d);
    return 0;
  }
  d.seen = true;
  const [lo, hi] = windowOf(d);
  for (const r of d.painted) if (r.n < lo || r.n > hi || !intact(r)) unpaint(d, r);
  let added = 0;
  for (let n = lo; n <= hi; n++) {
    const r = d.rows[n] as Row;
    if (r.painted === null) added += paint(d, r);
  }
  return added;
}

/** A painted row still is the one text node with the line it drew. */
function intact(r: Row): boolean {
  const p = r.painted;
  return !!p && r.dt.firstChild === p.node && r.dt.childNodes.length === 1 && p.node.data === r.hk.lines[r.i];
}

/** A row's ranges: its tokens' colours over (an added or deleted row's) plain text in the context's colour; the sign as drawn. */
function paint(d: Diff, r: Row): number {
  const hk = r.hk;
  if (hk.state !== 'done') return 0;
  const sides = hk.sides;
  const at = sides?.at[r.i];
  const tokens = at && hk.tokens ? (at[0] ? hk.tokens.neu : hk.tokens.old)[at[1]] : undefined;
  const line = hk.lines[r.i] as string;
  const sign = sides?.sign[r.i] ?? 0;
  const node = r.dt.firstChild;
  // Nothing to colour (an empty line, a `\ No newline` row), or a row changed under us: it stays as drawn.
  if (!tokens?.length || r.dt.childNodes.length !== 1 || node?.nodeType !== Node.TEXT_NODE || (node as Text).data !== line || line.slice(0, sign) + tokensText(tokens) !== line) {
    r.painted = false;
    return 0;
  }
  const hls = highlights();
  const ranges: Array<[Highlight, StaticRange]> = [];
  const add = (h: Highlight, start: number, end: number) => {
    const rg = new StaticRange({ startContainer: node, startOffset: start, endContainer: node, endOffset: end });
    h.add(rg);
    ranges.push([h, rg]);
  };
  if (sign && (line[0] === '+' || line[0] === '-')) add(hls.plain, sign, line.length);
  const spec = rowRanges(tokens, sign);
  for (let i = 0; i < spec.length; i += 3) add(hls.colours[spec[i] as number] as Highlight, spec[i + 1] as number, spec[i + 2] as number);
  r.painted = { node: node as Text, ranges };
  d.painted.add(r);
  return ranges.length;
}

function unpaint(d: Diff, r: Row): void {
  if (r.painted) for (const [h, rg] of r.painted.ranges) h.delete(rg);
  r.painted = null;
  d.painted.delete(r);
}

/** A diff that left the page: its ranges go, and nothing watches it any more. */
function forget(d: Diff): void {
  for (const r of d.painted) unpaint(d, r);
  live.delete(d);
  dirtyQ.delete(d);
  io?.unobserve(d.body);
  ro?.unobserve(d.body);
}

/** Lets go of the diffs that left the page; `timed`, also of those never in it since the last time. */
function sweep(timed = false): void {
  for (const d of live) {
    if (alive(d)) d.seen = true;
    else if (d.seen || (timed && ++d.unseen > 1)) forget(d);
  }
}

/** While diffs are held, one that left the page unnoticed is let go of within SWEEP_MS (one never in it, within twice that). */
function sweepLater(): void {
  if (sweepTimer !== null) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    sweep(true);
    if (live.size) sweepLater();
  }, SWEEP_MS);
}

/** For tests: the highlights' ranges now. */
export const diffRangeCount = (): number => (plainHl?.size ?? 0) + colourHls.reduce((s, h) => s + h.size, 0);

// ---- the worker -----------------------------------------------------------------------------------------------

let theWorker: Worker | null | undefined;
let inFlight: { id: number; hk: Hunk } | null = null;
let nextId = 1;

function worker(): Worker | null {
  if (theWorker !== undefined) return theWorker;
  theWorker = null;
  if (typeof Worker === 'undefined') return null;
  try {
    const w = new Worker(new URL('./diffHighlight.worker.ts', import.meta.url), { type: 'module', name: 'diff-highlight' });
    w.onmessage = (e: MessageEvent<DiffHlReply>) => {
      const f = inFlight;
      if (!f || e.data.id !== f.id) return;
      const t0 = now();
      inFlight = null;
      done(f.hk, e.data.tokens);
      feedWorker();
      if (TRACE) performance.measure('tx-diff-hl', { start: t0, end: now(), detail: { reply: f.hk.size } });
      idle();
    };
    // A worker that cannot load or run, or a reply that cannot be read: what it had and what waits for it stays plain,
    // and no other is made.
    w.onerror = w.onmessageerror = () => {
      theWorker = null;
      w.terminate();
      if (inFlight) done(inFlight.hk, null);
      inFlight = null;
      for (const hk of workerQ.splice(0)) done(hk, null);
    };
    theWorker = w;
  } catch {
    theWorker = null;
  }
  return theWorker;
}

/** One hunk at a time: one that left the page meanwhile is never sent. */
function feedWorker(): void {
  const w = theWorker;
  if (!w || inFlight) return;
  for (let hk = workerQ.shift(); hk; hk = workerQ.shift()) {
    if (!alive(hk.diff)) {
      done(hk, null);
      continue;
    }
    const sides = hk.sides as HunkSides;
    inFlight = { id: nextId++, hk };
    const req: DiffHlRequest = { id: inFlight.id, lang: hk.diff.lang as string, old: sides.old, neu: sides.neu };
    w.postMessage(req);
    return;
  }
}

/** For tests: what this module still has to do. */
export const diffColoursBusy = (): boolean => scheduled || frameAsked || !!inFlight || incoming.length + mainQ.length + workerQ.length + dirtyQ.size > 0;
