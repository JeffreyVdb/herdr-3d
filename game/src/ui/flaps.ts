/**
 * #119: the overview's split-flap motion, one clock for every line on the page. A now line that waits for the model's
 * first summary is a row of flap cells turning through `░▒▓█` (`skeleton`); a model's line that arrives resolves left to
 * right, each character turning through a few glyphs before it settles on its own letter (`resolve`), like a
 * departures board.
 *
 * The cells are the page's DOM, kept across the page's refreshes (the overview keeps the line's element): a job holds
 * its cells and goes on whatever else of the row is rebuilt. A glyph is the cell's `data-g`, drawn by CSS
 * (`content: attr(data-g) / ''`, no text of the page's and nothing for a screen reader); a resolving cell holds its
 * final character, unseen, so it already takes that character's width in the line's own face and the line never
 * reflows; a resolved line is one text node again.
 *
 * Calm (reduced motion, battery saver): no job runs. The CSS `data-calm` rule stops only CSS animations, so the clock
 * asks `calm()` itself: a resolve shows its text at once, and a running job ends where it is.
 */

export const FLAP_GLYPHS = ['░', '▒', '▓', '█'] as const;
/** A skeleton cell turns this often. */
const SKELETON_MS = 110;
/** A resolving cell turns this often. */
const TURN_MS = 55;
/** Every cell of a line turns at least this long, */
const RESOLVE_LEAD_MS = 140;
/** and the line settles from its first cell to its last over this. */
const RESOLVE_SWEEP_MS = 280;
/** Lines that arrive together start this far apart, at most `STAGGER_MAX` steps: none takes over 600 ms. */
export const RESOLVE_STAGGER_MS = 60;
const STAGGER_MAX = 3;
/** A resolve begun within this of the previous one is of the same batch (the same refresh). */
const BATCH_MS = 40;
/** The longest a line resolves, its stagger included. */
export const RESOLVE_MAX_MS = STAGGER_MAX * RESOLVE_STAGGER_MS + RESOLVE_LEAD_MS + RESOLVE_SWEEP_MS;

export interface FlapClockDeps {
  /** No motion: reduced motion or battery saver. */
  calm(): boolean;
  now?(): number;
  frame?(cb: () => void): void;
}

interface Job {
  /** One frame; false when the job is over. */
  step(t: number): boolean;
  /** Ends it at once, at its final state. */
  finish(): void;
}

/** A glyph for cell `i` at turn `n`: it changes every turn, cells apart from their neighbours. */
const glyph = (i: number, n: number): string => FLAP_GLYPHS[(i * 3 + n + (n >> 1) + ((i * n) & 1)) % FLAP_GLYPHS.length] as string;

function setGlyph(cell: HTMLElement, g: string): void {
  if (cell.dataset.g !== g) cell.dataset.g = g;
}

export class FlapClock {
  private readonly jobs = new Map<HTMLElement, Job>();
  private armed = false;
  private batch = { at: -Infinity, n: 0 };
  private readonly now: () => number;
  private readonly frame: (cb: () => void) => void;

  constructor(private readonly deps: FlapClockDeps) {
    this.now = deps.now ?? (() => performance.now());
    this.frame = deps.frame ?? ((cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => cb()) : setTimeout(cb, 16)));
  }

  /** Lines with a job running (for a test). */
  get running(): number {
    return this.jobs.size;
  }

  /** Whether a line has a job running. */
  busy(line: HTMLElement): boolean {
    return this.jobs.has(line);
  }

  /** A line's skeleton cells turn until the line gets another job, is cancelled or leaves the page. */
  skeleton(line: HTMLElement, cells: readonly HTMLElement[]): void {
    this.cancel(line);
    cells.forEach((c, i) => setGlyph(c, glyph(i, 0)));
    if (this.deps.calm() || !cells.length) return;
    let turn = -1;
    const t0 = this.now();
    this.add(line, {
      step: (t) => {
        if (!line.isConnected) return false;
        const n = Math.floor((t - t0) / SKELETON_MS);
        if (n !== turn) {
          turn = n;
          cells.forEach((c, i) => setGlyph(c, glyph(i, n)));
        }
        return true;
      },
      finish: () => undefined,
    });
  }

  /**
   * The text of `el` (a line's text span) resolves to `text` left to right. Calm: the text at once. `el` holds one text
   * node again when it is over (or cancelled).
   */
  resolve(line: HTMLElement, el: HTMLElement, text: string): void {
    this.cancel(line);
    if (this.deps.calm() || !text) {
      el.textContent = text;
      return;
    }
    const t0 = this.now();
    if (t0 - this.batch.at > BATCH_MS) this.batch = { at: t0, n: 0 };
    else this.batch = { at: t0, n: this.batch.n + 1 };
    const start = t0 + Math.min(this.batch.n, STAGGER_MAX) * RESOLVE_STAGGER_MS;
    // A cell per character, the spaces plain text (the line wraps between words as it will once resolved).
    const cells: HTMLElement[] = [];
    const parts: Node[] = [];
    for (const ch of text) {
      if (/\s/.test(ch)) {
        parts.push(document.createTextNode(ch));
        continue;
      }
      const c = document.createElement('span');
      c.className = 'ov-ch';
      c.textContent = ch;
      setGlyph(c, glyph(cells.length, 0));
      cells.push(c);
      parts.push(c);
    }
    el.replaceChildren(...parts);
    const last = Math.max(1, cells.length - 1);
    const settle = cells.map((_, i) => start + RESOLVE_LEAD_MS + (i / last) * RESOLVE_SWEEP_MS);
    let left = cells.length;
    let turn = -1;
    const done = () => {
      el.textContent = text;
    };
    this.add(line, {
      step: (t) => {
        if (!el.isConnected) return false;
        const n = Math.floor((t - t0) / TURN_MS);
        const turned = n !== turn;
        turn = n;
        cells.forEach((c, i) => {
          if (!c.dataset.g) return;
          if (t >= (settle[i] as number)) {
            delete c.dataset.g;
            left--;
          } else if (turned) setGlyph(c, glyph(i, n));
        });
        if (left > 0) return true;
        done();
        return false;
      },
      finish: done,
    });
  }

  /** Ends a line's job at its final state (a resolve shows its text). */
  cancel(line: HTMLElement): void {
    const j = this.jobs.get(line);
    if (!j) return;
    this.jobs.delete(line);
    j.finish();
  }

  /** Ends every job (the page closes, or turns calm). */
  clear(): void {
    for (const line of [...this.jobs.keys()]) this.cancel(line);
  }

  private add(line: HTMLElement, job: Job): void {
    this.jobs.set(line, job);
    this.arm();
  }

  private arm(): void {
    if (this.armed || !this.jobs.size) return;
    this.armed = true;
    this.frame(() => this.tick());
  }

  private tick(): void {
    this.armed = false;
    if (this.deps.calm()) {
      this.clear();
      return;
    }
    const t = this.now();
    for (const [line, job] of [...this.jobs]) {
      if (this.jobs.get(line) !== job) continue;
      if (!job.step(t)) this.jobs.delete(line);
    }
    this.arm();
  }
}
