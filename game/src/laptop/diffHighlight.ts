/**
 * #206: syntax colours inside the transcript's diff rows, added after the rows draw.
 *
 * A diff's rows draw plain, as before; this then colours them in place, a hunk at a time, without a long task:
 * - The language is the path's extension's (diffTokens.diffLanguage); none known, nothing happens.
 * - Each hunk's two sides are tokenized whole (diffTokens.hunkSides), so what spans rows colours right.
 * - A hunk of up to MAIN_BUDGET characters is tokenized on the page's thread, in background tasks of about SLICE_MS
 *   (one hunk at least, then the next while the slice lasts). A larger one (a created 2,000-line file is one hunk, ~100 ms)
 *   goes to a worker (diffHighlight.worker.ts, made on first need); without one it stays plain.
 * - Rows are coloured a batch a frame (PAINT_MS of work), and only the rows that were drawn: "Show next" colours its
 *   page when it draws it. A row is coloured only while it is in the page and still shows the text it drew
 *   with (a re-render, a live update or a loaded full change made new rows, with their own work).
 * - Results are kept (MAX_CACHE characters): a diff drawn again (a re-render, the terminal and back) colours at once.
 *
 * `?diffhl=off` turns it off and `?diffhl=trace` measures every slice (performance entries `tx-diff-hl`), for the
 * long-task check (e2e/h206-diff-highlight.spec.ts).
 */
import { diffLanguage, hunkSides, tokenizeHunk, tokensText, type HunkSides, type HunkTokens, type LineTokens } from './diffTokens';
import type { DiffHlReply, DiffHlRequest } from './diffHighlight.worker';

type Highlighter = typeof import('highlight.js/lib/common').default;

/** Characters (both sides) a hunk may have to be tokenized on the page's thread: ~10 ms in Chromium. */
export const MAIN_BUDGET = 12_000;
/** Past this a hunk is not coloured at all, even by the worker. */
export const MAX_HUNK = 1_000_000;
/** A background task's work: past it the next hunk waits for the next task. */
const SLICE_MS = 8;
/** The rows coloured in a frame: as many as this takes (the page's restyle and layout of them after costs ~4x that). */
const PAINT_MS = 4;
/** Rows coloured between two looks at the clock. */
const ROWS_PER_CHECK = 16;
/** Characters of tokenized hunks kept for a diff drawn again. */
const MAX_CACHE = 2_000_000;

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
  /** Rows drawn before its tokens were ready: [hunk line, text cell]. */
  rows: Array<[number, HTMLElement]>;
}

interface Diff {
  path: unknown;
  /** The language, once the highlighter is loaded (null: none, the diff stays plain). */
  lang: string | null | undefined;
  alive: () => boolean;
}

/** What a diff's view tells about its rows. */
export interface DiffColours {
  /** A row was drawn (hunk `k`'s line `i`, its text cell `dt` holding the line as drawn): colour it when its hunk is ready. */
  row(k: number, i: number, dt: HTMLElement): void;
}

/**
 * Colours for a diff's rows: `hunks` are its hunks' lines (null for a hunk that is not code: it stays plain), `alive`
 * says the diff is still in the page. Null when its path names no language at all.
 */
export function diffColours(path: unknown, hunks: ReadonlyArray<readonly string[] | null>, alive: () => boolean): DiffColours | null {
  if (OFF || diffLanguage(path, () => true) === null) return null;
  const diff: Diff = { path, lang: undefined, alive };
  const work = hunks.map((lines): Hunk | null => (lines ? { diff, lines, sides: null, size: 0, key: '', state: 'idle', tokens: null, rows: [] } : null));
  return {
    row(k, i, dt) {
      const hk = work[k];
      if (!hk) return;
      if (hk.state === 'done') {
        if (hk.tokens) toPaint(hk, i, dt);
        return;
      }
      hk.rows.push([i, dt]);
      if (hk.state === 'idle') {
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
/** Rows to colour: the cell, its sign (`+`, `-`, space or none), its tokens, the text it must still show. */
const paintQ: Array<{ dt: HTMLElement; sign: string; tokens: LineTokens; text: string }> = [];
const cache = new Map<string, { tokens: HunkTokens; size: number }>();
let cached = 0;
let scheduled = false;
/** A batch of rows was coloured: the next waits for a frame. */
let frameWait = false;

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
  if (tokens) for (const [i, dt] of hk.rows) toPaint(hk, i, dt);
  hk.rows = [];
}

function toPaint(hk: Hunk, i: number, dt: HTMLElement): void {
  const sides = hk.sides;
  const at = sides?.at[i];
  const tokens = at && hk.tokens ? (at[0] ? hk.tokens.neu : hk.tokens.old)[at[1]] : undefined;
  // Nothing to colour (an empty line, a `\ No newline` row): the row stays as drawn.
  if (!sides || !tokens || !tokens.length) return;
  const line = hk.lines[i] as string;
  paintQ.push({ dt, sign: line.slice(0, sides.sign[i]), tokens, text: line });
  pump();
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

function pump(): void {
  if (scheduled) return;
  scheduled = true;
  const sched = (globalThis as { scheduler?: { postTask?: (f: () => void, o: { priority: string }) => Promise<unknown> } }).scheduler;
  if (sched?.postTask) void sched.postTask(run, { priority: 'background' }).catch(() => {});
  else setTimeout(run, 0);
}

/** One background task: rows first (what was tokenized shows), then hunks, while the slice lasts. */
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
  let rows = 0;
  let chars = 0;
  // Rows: one batch a frame. The page restyles and lays out what a batch added in the frame after it; batches piled up
  // between two frames would make that one long.
  if (!frameWait && paintQ.length) {
    const stop = t0 + PAINT_MS;
    for (let p = paintQ.shift(); p; p = paintQ.shift()) {
      paint(p.dt, p.sign, p.tokens, p.text);
      if (++n % ROWS_PER_CHECK === 0 && now() >= stop) break;
    }
    rows = n;
    frameWait = true;
    nextFrame(() => {
      frameWait = false;
      if (paintQ.length) pump();
      else idle();
    });
  }
  for (;;) {
    if (n > 0 && now() >= end) break;
    const hk = mainQ.shift();
    if (!hk) break;
    n++;
    if (!hk.diff.alive()) {
      done(hk, null);
      continue;
    }
    const lang = hk.diff.lang as string;
    const h = hl;
    chars += hk.size;
    done(hk, tokenizeHunk((text, language) => h.highlight(text, { language, ignoreIllegals: true }).value, lang, (hk.sides as HunkSides).old, (hk.sides as HunkSides).neu));
  }
  if (TRACE) performance.measure('tx-diff-hl', { start: t0, end: now(), detail: { rows, chars } });
  if (mainQ.length || incoming.length) pump();
  idle();
}

/** Traced: a mark each time nothing is left to do (what the long-task check waits for, without looking at rows). */
function idle(): void {
  if (TRACE && !diffColoursBusy()) performance.mark('tx-diff-hl-idle');
}

/** After the next frame (a timer where there are none, as in tests). */
function nextFrame(f: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(f, 0));
  else setTimeout(f, 16);
}

/** A row's text cell, coloured: the sign as drawn, then the tokens, each in its spans. Skipped once the row is gone or changed. */
function paint(dt: HTMLElement, sign: string, tokens: LineTokens, text: string): void {
  if (!dt.isConnected || dt.childNodes.length !== 1 || dt.textContent !== text) return;
  if (sign + tokensText(tokens) !== text) return;
  const out: Node[] = [];
  if (sign) {
    const s = document.createElement('span');
    s.className = 'tx-dsg';
    s.textContent = sign;
    out.push(s);
  }
  for (let i = 0; i < tokens.length; i += 2) {
    const cls = tokens[i] as string;
    let node: Node = document.createTextNode(tokens[i + 1] as string);
    if (cls) {
      const levels = cls.split(',');
      for (let j = levels.length - 1; j >= 0; j--) {
        const s = document.createElement('span');
        s.className = levels[j] as string;
        s.append(node);
        node = s;
      }
    }
    out.push(node);
  }
  dt.replaceChildren(...out);
  dt.classList.add('tx-hl');
}

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
    if (!hk.diff.alive()) {
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
export const diffColoursBusy = (): boolean => scheduled || frameWait || !!inFlight || incoming.length + mainQ.length + workerQ.length + paintQ.length > 0;
