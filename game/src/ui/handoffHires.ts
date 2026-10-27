import type { HandoffHire, HireAck } from '../net/protocol';
import { hireWithHandoffTask } from '../world/handoff';
import { pendingHire } from '../world/handoffHire';
import { notPromptedBackgroundText, SPAWNED_TEXT } from './hireCoordinator';
import { hiredToast } from './hiredToast';
import type { ToastKind } from './hud';

/**
 * #219: how a background "Hire with handoff" ended, said once, by the browser that asked. The bridge holds the hire
 * (`World.handoff_hires`, world/handoffHire.ts) and hires once the handoff is filed; this only reads its records. It
 * never sends `worker.hire`: a world update, a late ack, a reconnect or a reload is never a hire.
 *
 * Who says it: the record's `origin` is this browser's id (`localStorage`, one per browser); other browsers only show
 * the desk held and the source's card line. Once: every terminal op said is remembered (a bounded list in
 * `localStorage`), so a repeated update, a reconnect or a reload says nothing again, and a hire that ended during a
 * reload is still said after it. Without storage it is remembered for this page only.
 *
 * What it says: hired, the background hire's own toast and beep (`Agent spawned successfully.`; a task that did not
 * reach the agent, the not-prompted or uncertain words, never a second hire). Failed or cancelled, the review that sent
 * it gives the task back (a `session` of this page: `giveBack`, "Review again"); without one (the page was reloaded,
 * the task lived in the old one) a toast with the reason and, when it was filed, where the handoff is. While the review
 * that sent it is open on it (`watching`), the review says it itself and `claim`s the op.
 */

export const ORIGIN_KEY = 'h3d.handoffHire.origin';
export const ANNOUNCED_KEY = 'h3d.handoffHire.announced';
/** The ops remembered as said (the oldest go first): far more than the bridge keeps (50 terminal records). */
export const ANNOUNCED_MAX = 200;
/** A record with no session here waits this long: a tab of this browser that has the task says it first. */
export const ORPHAN_WAIT_MS = 1500;

/** What the review that sent a handoff hire keeps for it in this page. */
export interface HandoffHireSession {
  /** The task as reviewed, without the line that points to the handoff (a not-prompted hire puts it in their Prompt note). */
  task: string;
  /** The review is open on this op now: it says the outcome itself. */
  watching(): boolean;
  /** Failed or cancelled while the review was closed: the task and settings come back. */
  giveBack(r: HandoffHire): void;
  /** The op ended (any way, said by anyone): what it held can go. */
  done(): void;
}

export interface HandoffHireHost {
  records(): HandoffHire[];
  toast(msg: string, kind: ToastKind): void;
  beep(): void;
  floorName(id: string): string;
  workerView?(id: string): { name: string; desk: number } | null;
  /** A hired worker whose first task did not reach it: the task in its Prompt (P) note (true: it is there now). */
  holdTask?(workerId: string, text: string): boolean;
  /** Absent: `window.localStorage` (when it can be read). */
  storage?: Storage | null;
  later?(fn: () => void, ms: number): void;
}

const ORIGIN_RE = /^[A-Za-z0-9_-]{1,80}$/;

function newOrigin(rand: () => number = Math.random): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = 'br-';
  for (let i = 0; i < 20; i++) s += a[Math.floor(rand() * a.length) % a.length];
  return s;
}

/** A hired record's delivery, as the hire's ack says it (the not-prompted words read it). */
export function promptAckOf(r: Pick<HandoffHire, 'prompt_error' | 'delivery'>): Pick<HireAck, 'prompt_error' | 'delivery'> {
  return { ...(r.prompt_error ? { prompt_error: r.prompt_error } : {}), ...(r.delivery === 'unknown' ? { delivery: 'unknown' as const } : {}) };
}

/** The words of a record that ended without a hire, for a toast (no review to give the task back to). */
export function handoffHireFailureText(r: HandoffHire, floorName: string): string {
  const where = `Desk ${r.desk_index + 1} of ${floorName}`;
  const reason = (r.reason ?? '').trim() || (r.state === 'cancelled' ? 'Cancelled: nothing was filed and nobody was hired.' : 'Nobody was hired.');
  const saved = r.path ? ` ${r.worker_name}’s handoff is saved at ${r.path}: hire from it in the cabinet.` : '';
  return `${where} · ${reason}${saved}`;
}

export class HandoffHireAnnouncer {
  readonly origin: string;
  private readonly sessions = new Map<string, HandoffHireSession>();
  /** This page's copy of the said ops (all of them when there is no storage). */
  private readonly said = new Set<string>();
  private readonly waiting = new Set<string>();
  private readonly store: Storage | null;

  constructor(private readonly host: HandoffHireHost) {
    this.store = host.storage !== undefined ? host.storage : storageOf();
    let origin = '';
    try {
      origin = this.store?.getItem(ORIGIN_KEY) ?? '';
    } catch {
      origin = '';
    }
    if (!ORIGIN_RE.test(origin)) {
      origin = newOrigin();
      try {
        this.store?.setItem(ORIGIN_KEY, origin);
      } catch {
        // kept for this page only
      }
    }
    this.origin = origin;
  }

  /** The review that sent `op` keeps its task here until the op ends. */
  session(op: string, s: HandoffHireSession): void {
    // A resend of the same op (its first send got no answer): the newer press holds the task now.
    const was = this.sessions.get(op);
    this.sessions.set(op, s);
    if (was && was !== s) was.done();
  }

  /** The review said how `op` ended (it was open on it): nobody says it again. */
  claim(op: string): void {
    this.remember(op);
    this.end(op);
  }

  /** The bridge never took `op` (its request, asked again, was refused): its session ends, and nothing is said. */
  release(op: string): void {
    this.end(op);
  }

  /** Whether `op`'s outcome was said already (here, or in this browser before a reload). */
  announced(op: string): boolean {
    return this.said.has(op) || this.stored().includes(op);
  }

  /** The records as the world has them now: each of this browser's that ended is said, once. */
  sync(): void {
    for (const r of this.host.records()) {
      if (r.origin !== this.origin || pendingHire(r) || this.announced(r.op)) continue;
      const s = this.sessions.get(r.op);
      if (s?.watching()) continue;
      if (!s) {
        // Another tab of this browser may have its task: it says it first; this one says it only if nobody did.
        if (this.waiting.has(r.op)) continue;
        this.waiting.add(r.op);
        (this.host.later ?? ((fn, ms) => void setTimeout(fn, ms)))(() => {
          this.waiting.delete(r.op);
          const now = this.host.records().find((x) => x.op === r.op) ?? r;
          if (!this.announced(r.op) && !this.sessions.has(r.op)) this.announce(now, null);
        }, ORPHAN_WAIT_MS);
        continue;
      }
      this.announce(r, s);
    }
  }

  private announce(r: HandoffHire, s: HandoffHireSession | null): void {
    this.remember(r.op);
    try {
      if (r.state === 'hired') this.hired(r, s);
      else if (s) s.giveBack(r);
      else this.host.toast(handoffHireFailureText(r, this.host.floorName(r.floor)), r.state === 'cancelled' ? 'info' : 'error');
    } finally {
      this.end(r.op);
    }
  }

  private hired(r: HandoffHire, s: HandoffHireSession | null): void {
    const home = r.send_home_result === 'skipped' ? ` ${r.worker_name} was not sent home: ${(r.send_home_reason ?? '').trim() || 'it could not go then.'}` : '';
    if (r.prompted !== false) {
      this.host.toast(`${SPAWNED_TEXT}${home}`, home ? 'warn' : 'info');
      this.host.beep();
      return;
    }
    // The agent is there, its first task is not: prompted by hand (P), never hired again.
    const w = r.hired ? (this.host.workerView?.(r.hired) ?? null) : null;
    const held = !!s && !!r.hired && !!r.path && r.delivery !== 'unknown' && this.host.holdTask?.(r.hired, hireWithHandoffTask(r.path, s.task)) === true;
    const t = hiredToast(`Hired ${w?.name ?? r.label ?? 'the new agent'} at Desk ${(w?.desk ?? r.desk_index) + 1}.`, undefined, notPromptedBackgroundText(promptAckOf(r), held));
    this.host.toast(`${t.text}${home}`, t.kind);
  }

  private end(op: string): void {
    const s = this.sessions.get(op);
    this.sessions.delete(op);
    s?.done();
  }

  private stored(): string[] {
    try {
      const v: unknown = JSON.parse(this.store?.getItem(ANNOUNCED_KEY) ?? '[]');
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private remember(op: string): void {
    this.said.add(op);
    try {
      if (!this.store) return;
      const list = this.stored().filter((x) => x !== op);
      list.push(op);
      this.store.setItem(ANNOUNCED_KEY, JSON.stringify(list.slice(-ANNOUNCED_MAX)));
    } catch {
      // this page remembers it
    }
  }
}

function storageOf(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}
