import type { AgentHandoff, CacheState, HandoffAdded, HandoffCabinet, HandoffCandidate, HandoffEntry, HandoffRemoved, UsageCache, Worker } from '../net/protocol';

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
 * #198: the first task of "Hire with handoff" (the ticket's words): the filed handoff's final path as it is (spaces
 * kept, nothing quoted), then the human's task as written. Only blank lines before and after the task are dropped; its
 * lines, indentation and inner blank lines stay. Never the handoff's text, never `hireTask`'s generic continuation.
 */
export function hireWithHandoffTask(path: string, task: string): string {
  const body = task.replace(/^(?:[ \t]*\r?\n)+/u, '').replace(/(?:\r?\n[ \t]*)+$/u, '');
  return `First read the handoff here: ${path} and then follow these instructions:\n\n${body}`;
}

/**
 * #198: the bytes a filed handoff's path is assumed to take before it is known (the size check before anything is
 * generated). The file name is bounded by the bridge (a 13-byte stamp, a 32-byte worker part, a 48-byte slug, a
 * collision suffix, `.md`: about 100 bytes); the cabinet's directory and the floor's id are not known here, so the rest
 * is a generous allowance. The exact size is checked again with the real path before the hire is sent.
 */
export const HANDOFF_PATH_RESERVE = 1024;

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
    this.counts.set(e.floor_id ?? e.session, Math.max(0, e.handoff_count));
    this.filed.push(e.handoff);
    this.version++;
  }

  removed(e: HandoffRemoved): void {
    this.known = true;
    this.counts.set(e.floor_id ?? e.session, Math.max(0, e.handoff_count));
    this.version++;
  }

  /** The handoffs filed since the last call (the walks to the cabinet). */
  takeFiled(): HandoffEntry[] {
    const out = this.filed;
    this.filed = [];
    return out;
  }
}

// ---- #224: asking the agent ----

/**
 * The composer's exact top-level "/handoff [instruction]" (the bridge reads the same rule before translating): the
 * trimmed text starts with "/handoff" and a blank or the end. The instruction ("" for none); null when the text is
 * any other prompt (prose, a quoted example, a path, a longer name).
 */
export function handoffCommand(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith('/handoff')) return null;
  const rest = t.slice('/handoff'.length);
  if (rest !== '' && !/^\s/u.test(rest)) return null;
  return rest.trim();
}

/**
 * A cache's estimated state at `now` (unix ms), the bridge's rule (usage.CacheState): warm only before the earliest
 * expiry, expired only after the latest, else unknown. Never a promise that the next request hits.
 */
export function cacheState(c: UsageCache | null | undefined, now: number): CacheState {
  if (!c) return 'unknown';
  if ((c.expires_from ?? 0) > 0 && now < (c.expires_from ?? 0)) return 'warm';
  if ((c.expires_to ?? 0) > 0 && now > (c.expires_to ?? 0)) return 'expired';
  return 'unknown';
}

const mins = (ms: number) => (ms >= 3_600_000 && ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : `${Math.round(ms / 60_000)} min`);
const tokensWord = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

/** The estimate as the dialog says it: a short label, the sentence, and the evidence line. Context tokens, never the JSONL's size. */
export function cacheCopy(c: UsageCache | null | undefined, state: CacheState, contextTokens?: number): { label: string; line: string; evidence: string } {
  const n = c?.context_tokens || contextTokens || 0;
  const about = n > 0 ? ` (about ${tokensWord(n)} tokens)` : '';
  const label = state === 'warm' ? 'Likely warm' : state === 'expired' ? 'May have expired' : 'Unknown';
  const line =
    state === 'warm'
      ? `Agent cache is likely still warm, an estimate: the request can reuse the current conversation context${about}, though a reuse is never certain.`
      : `Agent cache may have expired. Generating a handoff can process the current conversation context again${about}.`;
  const bits: string[] = [];
  if (c) {
    const ttl = c.ttl_min_ms && c.ttl_max_ms && c.ttl_min_ms !== c.ttl_max_ms ? `${mins(c.ttl_min_ms)}–${mins(c.ttl_max_ms)}` : c.ttl_min_ms ? `${c.ttl_max_ms ? '' : 'at least '}${mins(c.ttl_min_ms)}` : '';
    const src: Record<string, string> = {
      observed_1h: 'observed 1-hour cache writes',
      observed_5m: 'observed 5-minute cache writes',
      observed_mixed: 'observed 5-minute and 1-hour writes',
      documented: 'the provider’s documented default',
      assumed: 'assumed: this route’s lifetime is not documented',
      unknown: 'no evidence yet',
    };
    bits.push(ttl ? `Kept ${ttl}, from ${src[c.policy] ?? c.policy}` : `Lifetime unknown (${src[c.policy] ?? c.policy})`);
    if (c.request_to) bits.push(`last request ${c.request_from ? '' : 'by '}${new Date(c.request_to).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    if (c.cache_read) bits.push(`it reused ${tokensWord(c.cache_read)} cached tokens`);
    if (c.reason) bits.push(c.reason);
  } else bits.push('No cache evidence read yet');
  return { label, line, evidence: bits.join(' · ') };
}

/** A request's outcome as a toast (null: nothing to say yet). */
export function agentHandoffNote(a: AgentHandoff | null | undefined, name: string): { text: string; kind: 'info' | 'error' } | null {
  if (!a) return null;
  if (a.state === 'filed') {
    const home = a.send_home_result === 'started' ? ` ${name} is on the way home.` : a.send_home_result === 'skipped' ? ` ${name} stays: ${a.send_home_reason ?? 'it can’t go now'}.` : '';
    return { text: `Filed ${name}’s handoff, written by its agent.${home}`, kind: 'info' };
  }
  if (a.state === 'failed') return { text: `${name}’s agent handoff was not filed: ${a.reason ?? 'it failed'}. ${name} stays; nobody was sent home.`, kind: 'error' };
  return null;
}
