import type { HandoffAdded, HandoffCabinet, HandoffCandidate, HandoffEntry, HandoffRemoved, Worker } from '../net/protocol';

/**
 * #223 handoffs, the game's side: pure logic, no DOM. The bridge owns the candidate (`Worker.handoff`: its identity,
 * never the text) and the cabinet; this says which transcript row the inline Handoff button belongs to, why a worker
 * has nothing to file, how a search snippet's private-use markers become text runs, the floors' drawer counts, and
 * the hire task a handoff hands on.
 */

/** The snippet's match markers (the bridge's FTS5 `snippet()` private-use characters). */
export const MARK_OPEN = '\uE000';
export const MARK_CLOSE = '\uE001';

/** The hire task of "Hire from handoff" (the ticket's words). */
export function hireTask(path: string): string {
  return `Read ${path} and continue the work. Invoke the skills it suggests.`;
}

/**
 * The row of the timeline the inline button goes on: the last loaded assistant item of the candidate's message
 * (Claude: `<message>#<n>`, consecutive text blocks merge into one row, so the last one; Codex: the message's item
 * id). Only an item the view has: a page that does not hold the candidate's row shows no button, never the last row
 * of a partial page. Null: no row (no candidate, Codex's `last_agent_message`, the row not loaded yet).
 */
export function handoffRow(items: Iterable<{ id: string; kind: string; seq: number }>, c: HandoffCandidate | null | undefined): string | null {
  if (!c || !c.message || c.source !== 'message') return null;
  let best: { id: string; seq: number } | null = null;
  for (const it of items) {
    if (it.kind !== 'assistant') continue;
    const ok = c.harness === 'codex' ? it.id === c.message : it.id.startsWith(`${c.message}#`);
    if (ok && (!best || it.seq > best.seq)) best = { id: it.id, seq: it.seq };
  }
  return best?.id ?? null;
}

/** The worker's candidate when the bridge offers one. */
export function candidateOf(w: Pick<Worker, 'handoff'> | null | undefined): HandoffCandidate | null {
  const c = w?.handoff;
  return c && typeof c === 'object' && typeof c.id === 'string' && c.id && typeof c.revision === 'string' ? c : null;
}

/** Why a worker has nothing to file now ("" when it has: its candidate can be filed). Never a substitute. */
export function noCandidateWhy(w: Worker, name: string, cabinet: boolean): string {
  if (!cabinet) return 'This herdr-world has no filing cabinet (start it with --handoff-dir).';
  const c = candidateOf(w);
  if (c?.too_large) return `${name}’s last reply is larger than 1 MB: a literal handoff never cuts it.`;
  if (c) return '';
  if (w.agent_kind !== 'claude' && w.agent_kind !== 'codex' && w.harness !== 'claude' && w.harness !== 'codex') return `${name} runs no Claude or Codex agent, so there is no reply to file.`;
  if (w.status === 'working') return `${name} is working: its reply is not finished yet.`;
  return `${name} has no completed reply to file: a turn is running, it was interrupted, or a new prompt came after it. No summary is made instead.`;
}

/** What a preview leaves out, said plainly (null: nothing). */
export function omittedNote(c: HandoffCandidate): string | null {
  const n = c.images ?? 0;
  if (n <= 0) return null;
  return `${n === 1 ? 'An image' : `${n} images`} in this message ${n === 1 ? 'is' : 'are'} not text and ${n === 1 ? 'is' : 'are'} left out of the handoff.`;
}

/** A snippet as runs of text, `hit` for the matches. Unpaired markers are dropped; nothing is markup. */
export function snippetRuns(s: string): Array<{ text: string; hit: boolean }> {
  const out: Array<{ text: string; hit: boolean }> = [];
  let hit = false;
  let buf = '';
  const flush = () => {
    if (buf) out.push({ text: buf, hit });
    buf = '';
  };
  for (const ch of s) {
    if (ch === MARK_OPEN || ch === MARK_CLOSE) {
      flush();
      hit = ch === MARK_OPEN;
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

/** A fresh operation id for one filing dialog: a repeated submit (a reconnect) files nothing twice. */
export function newOp(rand: () => number = Math.random): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = 'ho-';
  for (let i = 0; i < 20; i++) s += a[Math.floor(rand() * a.length) % a.length];
  return s;
}

/** The cabinet's three drawers, how many folder tabs each shows for a count: bottom first, at most `per` a drawer. */
export function drawerFill(count: number, per = 8): [number, number, number] {
  const n = Math.max(0, Math.floor(count));
  const bottom = Math.min(per, n);
  const middle = Math.min(per, Math.max(0, n - per));
  const top = Math.min(per, Math.max(0, n - 2 * per));
  return [top, middle, bottom];
}

/** The source's word in the cabinet. */
export function sourceWord(s: string): string {
  return s === 'literal' ? 'As written' : s === 'agent' ? 'By the agent' : s === 'llm' ? 'By the LLM' : s;
}

/**
 * #223: the filing cabinet's counts (`World.handoffs`, `handoff.added` / `handoff.removed`) and the handoffs filed
 * since the game last took them (the filing walk plays them). `known` false: the bridge has no cabinet.
 */
export class HandoffBook {
  known = false;
  version = 0;
  private readonly counts = new Map<string, number>();
  private filed: HandoffEntry[] = [];

  reset(c: HandoffCabinet | undefined): void {
    this.known = !!c && typeof c === 'object' && typeof c.counts === 'object' && c.counts !== null;
    this.counts.clear();
    if (this.known) for (const [f, n] of Object.entries((c as HandoffCabinet).counts)) if (Number.isInteger(n) && n > 0) this.counts.set(f, n);
    this.version++;
  }

  count(floor: string): number {
    return this.counts.get(floor) ?? 0;
  }

  added(e: HandoffAdded): void {
    this.known = true;
    this.counts.set(e.session, Math.max(0, e.handoff_count));
    this.filed.push(e.handoff);
    this.version++;
  }

  removed(e: HandoffRemoved): void {
    this.known = true;
    this.counts.set(e.session, Math.max(0, e.handoff_count));
    this.version++;
  }

  /** The handoffs filed since the last call (the walks to the cabinet). */
  takeFiled(): HandoffEntry[] {
    const out = this.filed;
    this.filed = [];
    return out;
  }
}
