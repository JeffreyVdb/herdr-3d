import * as THREE from 'three/webgpu';
import type { BoardIssues, BoardPrs } from '../../net/protocol';
import { closesText, holdersOf, issuePlacements, keysById, PR_CAP, paperOf, pinOf, prPlacements, verdictOf, wallColumns, type BoardSize, type Placement } from '../../world/boards';
import { hash32 } from '../../world/derive';
import type { Prop } from '../../world/layout';
import type { WorkerView } from '../../world/store';
import type { FloorPool } from '../floorPool';
import { BODY_TINTS } from '../palette';
import { NoteFlights, type FlightInfo } from './flight';
import { Gong } from './gong';
import { NoteBoard, type NoteInfo } from './noteBoard';
import { drawIssueNote, drawPrNote, ISSUE_CELL, onHolderPill, PR_CELL, sameIssueFace, samePrFace, type Backdrop, type IssueFace, type PrFace } from './paint';

/**
 * M7: the corkboard (issues), the pull request board and the merge gong on the board wall of a floor. Owns the two
 * `NoteBoard`s, the note flights (peel-off, merge fly-off) and the gong; the office gives it the boards' boxes and the
 * game gives it data. Everything is in the office's coordinates, under `group`.
 */

/** Why a board shows nothing (no data to draw notes from). */
export interface BoardOff {
  text: string;
  sub?: string;
}

export interface BoardShown {
  /** The last message, null before the first one. */
  msg: BoardIssues | null;
  off: BoardOff | null;
}

export interface PrsShown {
  msg: BoardPrs | null;
  /** The issue board's message: PRs name the issues they close by its keys. */
  issues: BoardIssues | null;
  off: BoardOff | null;
}

const tintCss = (id: string) => `#${(BODY_TINTS[hash32(id) % BODY_TINTS.length] ?? 0xffd84a).toString(16).padStart(6, '0')}`;

interface Placed {
  origin: THREE.Vector3;
  size: BoardSize;
}

export class BoardsView {
  readonly group = new THREE.Group();
  readonly flights = new NoteFlights();
  readonly gong: Gong | null;
  private readonly issues: NoteBoard<IssueFace> | null;
  private readonly prs: NoteBoard<PrFace> | null;
  private readonly issuesAt: Placed | null;
  private readonly prsAt: Placed | null;
  /** What each board shows now, so a world change that leaves it as it is draws nothing. */
  private readonly keys = { issues: '', prs: '' };
  /** What was shown last, to show again when a held note comes back. */
  private lastIssues: { s: BoardShown; workers: readonly WorkerView[] } | null = null;
  private issuesFilled = false;
  /** The notes on the issue board (where they settle, and their faces), for a click to find the holder's tag. */
  private shownIssues: Array<{ place: Placement; face: IssueFace }> = [];
  private scratch: CanvasRenderingContext2D | null = null;
  private prsFilled = false;
  private readonly heightM: number;
  /** Notes held off their board (peeled) until the next poll or this time (ms). */
  private readonly held = new Map<string, number>();

  constructor(
    props: readonly Prop[],
    height: number,
    /** Puts a board's backdrop texture on its front. */
    swap: (id: 'board.issues' | 'board.prs', tex: THREE.Texture) => void,
    /** #141: the notes' batches and atlases from there. */
    pool?: FloorPool,
  ) {
    this.group.name = 'boards';
    this.heightM = height;
    const place = (id: string): Placed | null => {
      const p = props.find((x) => x.id === id);
      if (!p) return null;
      const b = p.box;
      return { origin: new THREE.Vector3(b.min[0], b.min[1], b.max[2]), size: { w: b.max[0] - b.min[0], h: b.max[1] - b.min[1] } };
    };
    this.issuesAt = place('board.issues');
    this.prsAt = place('board.prs');
    this.issues = this.issuesAt
      ? new NoteBoard<IssueFace>({ size: this.issuesAt.size, cell: ISSUE_CELL, cols: 8, rows: 4, draw: (g, x, y, f) => drawIssueNote(g, x, y, f), same: sameIssueFace, backdrop: (t) => swap('board.issues', t), pool: pool && { pool, key: 'notes.issues' } })
      : null;
    this.prs = this.prsAt
      ? new NoteBoard<PrFace>({ size: this.prsAt.size, cell: PR_CELL, cols: 4, rows: 6, draw: (g, x, y, f) => drawPrNote(g, x, y, f), same: samePrFace, backdrop: (t) => swap('board.prs', t), pool: pool && { pool, key: 'notes.prs' } })
      : null;
    if (this.issues && this.issuesAt) {
      this.issues.group.position.copy(this.issuesAt.origin);
      this.group.add(this.issues.group);
    }
    if (this.prs && this.prsAt) {
      this.prs.group.position.copy(this.prsAt.origin);
      this.group.add(this.prs.group);
    }
    this.group.add(this.flights.group);
    // The gong hangs on the board wall under the PR board.
    this.gong = this.prsAt ? new Gong(this.prsAt.origin.x + this.prsAt.size.w / 2, this.prsAt.origin.z - 0.06 + 0.02) : null;
    if (this.gong) this.group.add(this.gong.group);
  }

  // ---- data ---------------------------------------------------------------------------------

  setIssues(s: BoardShown, workers: readonly WorkerView[], now: number): void {
    const board = this.issues;
    const at = this.issuesAt;
    if (!board || !at) return;
    this.lastIssues = { s, workers };
    const empty = (b: Backdrop['state']) => {
      const d: Backdrop = { title: 'Issues', accent: '#ffb38a', note: s.msg ? `${s.msg.provider_name}${s.msg.stale ? ' · stale' : ''}` : '', state: b };
      const key = JSON.stringify(d);
      if (key !== this.keys.issues) {
        this.keys.issues = key;
        board.setBackdrop(d);
        board.setNotes([], now, false);
      }
      this.shownIssues = [];
      this.issuesFilled = false;
    };
    if (!s.msg || s.off) return empty(s.off ? { kind: 'off', ...s.off } : { kind: 'loading', text: 'Waiting for the bridge…' });
    const m = s.msg;
    if (m.fetched_at === 0 && m.cards.length === 0) return empty({ kind: 'loading', text: `Waiting for ${m.provider_name}…` });
    const { columns, hiddenColumns } = wallColumns(m);
    const total = m.cards.filter((c) => c.state === 'open').length;
    const back: Backdrop = {
      title: 'Issues',
      accent: '#ffb38a',
      note: `${m.provider_name} · ${total} open${m.stale ? ' · stale' : ''}`,
      state: {
        kind: 'ready',
        heads: columns.map((c) => ({ name: c.name, count: c.cards.length, more: c.more, done: c.done })),
        empty: m.cards.length ? '' : 'Nothing here yet',
        more: 0,
        footer: hiddenColumns ? `+${hiddenColumns} more ${hiddenColumns === 1 ? 'column' : 'columns'} in the overlay` : null,
      },
    };
    const holders = holdersOf(m.cards, workers);
    const places = issuePlacements(columns, at.size);
    const entries = places
      .filter((p) => !this.isHeld(p.id, now))
      .map((p) => {
        const col = columns.find((c) => c.shown.some((x) => x.id === p.id));
        const card = col?.shown.find((x) => x.id === p.id);
        const h = holders.get(p.id);
        const face: IssueFace = {
          key: card?.key ?? '',
          title: card?.title ?? '',
          paper: card ? paperOf(card) : '#ffe27a',
          pin: card ? pinOf(card) : '#f4f4f0',
          holder: h ? { id: h.id, name: h.name, tint: tintCss(h.id) } : null,
          done: col?.done ?? false,
        };
        return { id: p.id, place: p, face };
      });
    this.shownIssues = entries;
    const key = JSON.stringify([back, entries]);
    if (key === this.keys.issues) return;
    this.keys.issues = key;
    board.setBackdrop(back);
    board.setNotes(entries, now, this.issuesFilled);
    this.issuesFilled = true;
  }

  /**
   * A click on a note's holder tag on the issue wall: the worker's id (null: not on one). The ray is the world's; the
   * board is a plane (its group's z = 0) and each note a rotated rectangle on it, the tag a rectangle of its cell.
   */
  pickHolder(ray: THREE.Ray): string | null {
    const board = this.issues;
    if (!board || !this.shownIssues.length) return null;
    board.group.updateWorldMatrix(true, false);
    const r = ray.clone().applyMatrix4(new THREE.Matrix4().copy(board.group.matrixWorld).invert());
    if (Math.abs(r.direction.z) < 1e-6) return null;
    const t = -r.origin.z / r.direction.z;
    if (t < 0) return null;
    const x = r.origin.x + r.direction.x * t;
    const y = r.origin.y + r.direction.y * t;
    this.scratch ??= document.createElement('canvas').getContext('2d');
    const g = this.scratch;
    if (!g) return null;
    // Topmost first: the notes lie over one another, later ones over earlier.
    for (let i = this.shownIssues.length - 1; i >= 0; i--) {
      const { place: p, face } = this.shownIssues[i] as (typeof this.shownIssues)[number];
      const dx = x - p.x;
      const dy = y - p.y;
      const c = Math.cos(p.rot);
      const sn = Math.sin(p.rot);
      const lx = dx * c + dy * sn;
      const ly = -dx * sn + dy * c;
      if (Math.abs(lx) > p.w / 2 || Math.abs(ly) > p.h / 2) continue;
      // On this note: it is the one under the pointer whether or not the tag is.
      if (!face.holder) return null;
      return onHolderPill(g, face.holder.name, (lx / p.w + 0.5) * ISSUE_CELL.w, (0.5 - ly / p.h) * ISSUE_CELL.h) ? face.holder.id : null;
    }
    return null;
  }

  setPrs(s: PrsShown, workers: readonly WorkerView[], now: number): void {
    const board = this.prs;
    const at = this.prsAt;
    if (!board || !at) return;
    const empty = (b: Backdrop['state']) => {
      const d: Backdrop = { title: 'Pull requests', accent: '#b9a5ff', note: s.msg ? `${s.msg.provider_name}${s.msg.stale ? ' · stale' : ''}` : '', state: b };
      const key = JSON.stringify(d);
      if (key !== this.keys.prs) {
        this.keys.prs = key;
        board.setBackdrop(d);
        board.setNotes([], now, false);
      }
      this.prsFilled = false;
    };
    if (!s.msg || s.off) return empty(s.off ? { kind: 'off', ...s.off } : { kind: 'loading', text: 'Waiting for the bridge…' });
    const m = s.msg;
    if (m.fetched_at === 0 && m.prs.length === 0) return empty({ kind: 'loading', text: `Waiting for ${m.provider_name}…` });
    const back: Backdrop = {
      title: 'Pull requests',
      accent: '#b9a5ff',
      note: `${m.provider_name} · ${m.prs.length} open${m.stale ? ' · stale' : ''}`,
      state: { kind: 'ready', heads: null, empty: m.prs.length ? '' : 'No open pull requests', more: Math.max(0, m.prs.length - PR_CAP), footer: null },
    };
    const keys = keysById(s.issues);
    const shown = m.prs.slice(0, PR_CAP);
    const places = prPlacements(shown, at.size);
    const entries = places.map((p, i) => {
      const pr = shown[i];
      const face: PrFace = {
        key: pr?.key ?? '',
        title: pr?.title ?? '',
        branch: pr?.head_branch ?? '',
        checks: pr?.checks ?? 'none',
        review: pr?.review ?? 'none',
        draft: pr?.draft === true,
        closes: pr ? closesText(pr.closes, keys) : '',
        stamp: pr ? (verdictOf(pr, workers) ?? null) : null,
      };
      return { id: p.id, place: p, face };
    });
    const key = JSON.stringify([back, entries]);
    if (key === this.keys.prs) return;
    this.keys.prs = key;
    board.setBackdrop(back);
    board.setNotes(entries, now, this.prsFilled);
    this.prsFilled = true;
  }

  private isHeld(id: string, now: number): boolean {
    const until = this.held.get(id);
    if (until === undefined) return false;
    if (now >= until) {
      this.held.delete(id);
      return false;
    }
    return true;
  }

  // ---- flights ----------------------------------------------------------------------------------

  private local(at: Placed, p: Placement, z = 0.02): THREE.Vector3 {
    return new THREE.Vector3(at.origin.x + p.x, at.origin.y + p.y, at.origin.z + z);
  }

  /** The note of an issue leaves its board and is carried to `to` (office coordinates). False: it is not on the board. */
  peel(id: string, to: THREE.Vector3, now: number, ms = 1500): boolean {
    const at = this.issuesAt;
    const taken = this.issues?.take(id);
    if (!at || !taken) return false;
    this.held.set(id, now + ms + 400);
    this.flights.launch(
      { id, kind: 'peel', draw: (g) => drawIssueNote(g, 0, 0, taken.face), px: ISSUE_CELL, size: { w: taken.place.w, h: taken.place.h }, from: this.local(at, taken.place), to, rot: taken.place.rot, ms },
      now,
    );
    return true;
  }

  /** A merged PR's note flies off its board. False: it is not on the board. */
  flyOff(id: string, now: number): boolean {
    const at = this.prsAt;
    const taken = this.prs?.take(id);
    if (!at || !taken) return false;
    const from = this.local(at, taken.place);
    const to = new THREE.Vector3(from.x + 0.5, Math.min(this.heightM - 0.35, from.y + 1.1), from.z + 1.7);
    this.flights.launch({ id, kind: 'merged', draw: (g) => drawPrNote(g, 0, 0, taken.face), px: PR_CELL, size: { w: taken.place.w, h: taken.place.h }, from, to, rot: taken.place.rot }, now);
    return true;
  }

  /** The gong's centre, in office coordinates. */
  gongAt(): THREE.Vector3 | null {
    return this.gong ? new THREE.Vector3(this.gong.group.position.x, 0.5, this.gong.group.position.z + 0.1) : null;
  }

  // ---- frame ---------------------------------------------------------------------------------------

  /** Steps everything; returns whether something still moves. */
  frame(now: number): boolean {
    let busy = false;
    // A peeled note comes back to its column once its flight is over.
    if (this.held.size && this.lastIssues && [...this.held.values()].some((until) => now >= until)) this.setIssues(this.lastIssues.s, this.lastIssues.workers, now);
    if (this.issues?.frame(now)) busy = true;
    if (this.prs?.frame(now)) busy = true;
    if (this.flights.frame(now)) busy = true;
    if (this.gong?.frame(now)) busy = true;
    return busy;
  }

  // ---- test hooks --------------------------------------------------------------------------------------

  info(now: number): { issues: NoteInfo[]; prs: NoteInfo[]; flights: FlightInfo[]; flightLog: Array<{ id: string; kind: string }>; gongRings: number; issuesWrites: number; prsWrites: number } {
    return {
      issues: this.issues?.info() ?? [],
      prs: this.prs?.info() ?? [],
      flights: this.flights.info(now),
      flightLog: [...this.flights.log],
      gongRings: this.gong?.rings ?? 0,
      issuesWrites: this.issues?.writes ?? 0,
      prsWrites: this.prs?.writes ?? 0,
    };
  }

  /** The number of instanced draws the notes take (two, however many notes: one batch per board). */
  get noteBatches(): number {
    return (this.issues ? 1 : 0) + (this.prs ? 1 : 0);
  }

  dispose(): void {
    this.issues?.dispose();
    this.prs?.dispose();
    this.flights.dispose();
    this.gong?.dispose();
    this.group.removeFromParent();
  }
}
