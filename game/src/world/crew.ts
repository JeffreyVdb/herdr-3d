/**
 * M6: write-code crews as the game shows them (docs/protocol.md "Runs and
 * freelancers", contract §1.4). The orchestrator (`orch`) is an employee;
 * `code`, `review`, `ux` and `ground` are freelancers: they walk in, read
 * their brief, work, hand in a report (a reviewer's with a verdict stamp)
 * and walk out with their briefcase. Everything here is derived from the
 * worker the bridge sends plus one bit the game remembers (whether it has
 * worked since it was first seen). Pure; vitest covers it.
 */

import type { Worker, WorkerIssue, WorkerReport } from '../net/protocol';
import { effectiveStatus } from './codexQuestions';

export type CrewRole = 'orch' | 'code' | 'review' | 'ux' | 'ground';

/** A freelancer's lifecycle (contract 1.4; `leaving` is the walk-out, not a state of a worker still there). */
export type Lifecycle = 'hired' | 'onboarding' | 'working' | 'blocked' | 'reporting' | 'idle';

/** Review passes an orchestrator may run before it must ask you (write-code's cap). */
export const PASS_CAP = 3;

const ROLES: readonly CrewRole[] = ['orch', 'code', 'review', 'ux', 'ground'];
const LABEL_ROLE = /^(ORCH|CODE|REVIEW|UX|GROUND)\|/;

/** The bridge's `role`, else (an older bridge) the label's prefix; null for everyone else. */
export function crewRole(w: Pick<Worker, 'role' | 'label'>): CrewRole | null {
  const r = w.role?.toLowerCase();
  if (r && (ROLES as readonly string[]).includes(r)) return r as CrewRole;
  if (r) return null;
  const m = LABEL_ROLE.exec(w.label ?? '');
  return m ? ((m[1] as string).toLowerCase() as CrewRole) : null;
}

export const isFreelancer = (r: CrewRole | null): r is Exclude<CrewRole, 'orch'> => r !== null && r !== 'orch';

/** A ready report's `input_required`, trimmed; null when there is none. */
function requestText(r: WorkerReport | undefined): string | null {
  if (!r || r.state !== 'ready' || typeof r.input_required !== 'string') return null;
  const s = r.input_required.trim();
  return s || null;
}

/** #215: the orchestrator resolved the report's request (without resuming the worker): who, and its note. */
export function inputResolved(r: WorkerReport | undefined): { by: string; note: string } | null {
  const res = r?.input_resolved;
  if (!res || typeof res !== 'object' || !requestText(r)) return null;
  const by = typeof res.by === 'string' && res.by.trim() ? res.by.trim() : 'orchestrator';
  return { by, note: typeof res.note === 'string' ? res.note.trim() : '' };
}

/** A ready report's `input_required` that still asks, trimmed; null when there is none or it was resolved (#215). */
export function inputRequired(r: WorkerReport | undefined): string | null {
  return inputResolved(r) ? null : requestText(r);
}

/** Who a report's request is for: its `input_for`, else the orchestrator when the worker has one, else you. */
export function requestFor(r: WorkerReport | undefined, orchId: string | null | undefined): 'orchestrator' | 'user' {
  const f = typeof r?.input_for === 'string' ? r.input_for.trim().toLowerCase() : '';
  if (f === 'orchestrator' || f === 'user') return f;
  return orchId ? 'orchestrator' : 'user';
}

/** `Asked of the orchestrator (Cog)` / `Asked of you`. */
export function askedOfText(who: 'orchestrator' | 'user', orchName: string | null | undefined): string {
  if (who === 'user') return 'Asked of you';
  const n = orchName?.trim();
  return n ? `Asked of the orchestrator (${n})` : 'Asked of the orchestrator';
}

/** `Request resolved by orchestrator: accepted as AC4 evidence`. */
export function resolvedText(res: { by: string; note: string }): string {
  return `Request resolved by ${res.by}${res.note ? `: ${res.note}` : ''}`;
}

/** What a report request is called wherever it shows (never "waiting for an answer": the agent asked no question). */
export const REPORT_REQUEST = 'Report request';

/** Whether a worker counts as having worked: seen `working` or `done`, or it handed in a report. */
export function hasWorked(w: Pick<Worker, 'status' | 'report' | 'codex'>): boolean {
  const status = effectiveStatus(w); // #157: blocked only by a Codex async question, it works
  return status === 'working' || status === 'done' || w.report?.state === 'ready';
}

/**
 * A freelancer's lifecycle state. `worked`: it was seen working since it
 * first appeared (see `CrewMemory`). Blocked (its agent, or its report still
 * asks: a request the orchestrator resolved, #215, does not) wins, then a ready report, then working; no agent yet is `hired`, an
 * agent that has not worked yet is `onboarding` (reading its brief), and one
 * that worked and waits without a report is `idle`. #157: a Codex worker herdr calls blocked only because of an async
 * question works (`effectiveStatus`).
 */
export function lifecycle(w: Pick<Worker, 'status' | 'agent_kind' | 'report' | 'codex'>, worked: boolean): Lifecycle {
  const status = effectiveStatus(w);
  if (status === 'blocked' || inputRequired(w.report)) return 'blocked';
  if (w.report?.state === 'ready') return 'reporting';
  if (status === 'working') return 'working';
  if (!w.agent_kind || status === 'unknown') return 'hired';
  if (!worked && status !== 'done') return 'onboarding';
  return 'idle';
}

/** Past the cap, or at it and waiting for you (the bridge's `over_cap`; the same rule when it does not say). */
export function overCap(w: Pick<Worker, 'over_cap' | 'pass' | 'phase'>): boolean {
  if (w.over_cap === true) return true;
  const p = w.pass;
  if (typeof p !== 'number') return false;
  return p > PASS_CAP || (p === PASS_CAP && w.phase === 'waiting_user');
}

export type StampTone = 'pass' | 'changes' | 'incomplete';

export interface Stamp {
  tone: StampTone;
  /** What the rubber stamp says. */
  text: string;
  blockers: number;
}

/** A reviewer's verdict stamp from a ready report; null without a (known) verdict. */
export function stampOf(r: WorkerReport | undefined): Stamp | null {
  if (!r || r.state !== 'ready') return null;
  const blockers = typeof r.blockers === 'number' && r.blockers > 0 ? r.blockers : 0;
  switch (r.verdict) {
    case 'PASS':
      return { tone: 'pass', text: 'PASS', blockers: 0 };
    case 'CHANGES_REQUIRED':
      return { tone: 'changes', text: blockers ? `CHANGES · ${blockers} BLOCKER${blockers === 1 ? '' : 'S'}` : 'CHANGES', blockers };
    case 'INCOMPLETE':
      return { tone: 'incomplete', text: 'INCOMPLETE', blockers: 0 };
  }
  return null;
}

const PHASES: Record<string, string> = {
  setup: 'setting up',
  research: 'researching',
  coding: 'coding',
  review: 'in review',
  fixing: 'fixing',
  waiting_user: 'waiting for you',
  pr: 'PR open',
  done: 'done',
};

/** An orchestrator's phase in words (`waiting_user` → `waiting for you`); other values as they came. */
export function phaseWords(phase: string | undefined): string | null {
  const p = phase?.trim();
  if (!p) return null;
  return PHASES[p] ?? p;
}

/** `pass 2 of 3`; past the cap `pass 4 · cap 3`; null when unknown. */
export function passWords(pass: number | undefined): string | null {
  if (typeof pass !== 'number' || !Number.isInteger(pass) || pass < 0) return null;
  return pass > PASS_CAP ? `pass ${pass} · cap ${PASS_CAP}` : `pass ${pass} of ${PASS_CAP}`;
}

/** `owner/repo#7`. */
export function issueText(i: WorkerIssue | undefined): string | null {
  if (!i || typeof i.repo !== 'string' || !i.repo || typeof i.number !== 'number') return null;
  return `${i.repo}#${i.number}`;
}

/** The round from the bridge, else the label's trailing `|r<N>`. */
export function roundOf(w: Pick<Worker, 'round' | 'label'>): number | null {
  if (typeof w.round === 'number' && w.round >= 1) return w.round;
  const m = /\|r(\d+)$/.exec(w.label ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * Run colours: a run's members share one (the chest badge, the card's role
 * tag), so a run reads as a group. Deep enough to carry white text (≥ 4.5:1).
 */
export const RUN_COLORS = [0x2f5fd0, 0x0b7d6e, 0x8a3fc2, 0xb3541e, 0xa3226b, 0x3d6b1f, 0x1f6f9a, 0x8a5a00];

export function runColor(run: string | undefined | null): number | null {
  if (!run) return null;
  let h = 2166136261;
  for (let i = 0; i < run.length; i++) h = Math.imul(h ^ run.charCodeAt(i), 16777619);
  return RUN_COLORS[(h >>> 0) % RUN_COLORS.length] ?? null;
}

/** What the game shows for a crew member. */
export interface CrewView {
  role: CrewRole;
  freelancer: boolean;
  /** Freelancers only (null for an orchestrator). */
  life: Lifecycle | null;
  run: string | null;
  runColor: number | null;
  round: number | null;
  ticket: string | null;
  /** `owner/repo#n`. */
  issue: string | null;
  orchId: string | null;
  /** Orchestrators: the phase in words and the pass. */
  phase: string | null;
  pass: number | null;
  overCap: boolean;
  stamp: Stamp | null;
  /** The report's `input_required` while it still asks: the COMPLETE text (#215), previews cut it themselves. */
  ask: string | null;
  /** #215: the bridge cut `ask` (it was longer than it keeps). */
  askTruncated: boolean;
  /** #215: who decides (the report's `input_for`, else the orchestrator when it has one, else you); null when nothing asks. */
  askFor: 'orchestrator' | 'user' | null;
  /** #215: `Asked of the orchestrator (Cog)` / `Asked of you`; null when nothing asks. */
  askWho: string | null;
  /** #215: the orchestrator resolved the report's request without resuming the worker; it no longer counts. */
  resolved: { by: string; note: string; line: string } | null;
  summary: string | null;
  /** Counts as needing you: an over-cap orchestrator, a freelancer whose report still asks (a resolved request does not, #215). */
  needsYou: boolean;
  /** The card's role tag: `ORCH`, `CODE r2`. */
  tag: string;
}

/** `orchName`: the freelancer's orchestrator's name, for who a report request is asked of. */
export function crewView(w: Worker, worked: boolean, orchName?: string | null): CrewView | null {
  const role = crewRole(w);
  if (!role) return null;
  const freelancer = isFreelancer(role);
  const round = roundOf(w);
  const orch = role === 'orch';
  const cap = orch && overCap(w);
  const ask = freelancer ? inputRequired(w.report) : null;
  const askFor = ask ? requestFor(w.report, w.orch_id) : null;
  const res = freelancer ? inputResolved(w.report) : null;
  const summary = freelancer && w.report?.state === 'ready' && typeof w.report.summary === 'string' ? w.report.summary.trim() || null : null;
  const run = w.run?.trim() || null;
  return {
    role,
    freelancer,
    life: freelancer ? lifecycle(w, worked) : null,
    run,
    runColor: runColor(run),
    round,
    ticket: w.ticket?.trim() || null,
    issue: issueText(w.issue) ?? (w.work_item?.key?.trim() || null), // #184: a Kaneo task by its key
    orchId: freelancer ? (w.orch_id ?? null) : null,
    phase: orch ? phaseWords(w.phase) : null,
    pass: orch && typeof w.pass === 'number' ? w.pass : null,
    overCap: cap,
    stamp: freelancer ? stampOf(w.report) : null,
    ask,
    askTruncated: ask !== null && w.report?.input_truncated === true,
    askFor,
    askWho: askFor ? askedOfText(askFor, orchName) : null,
    resolved: res ? { ...res, line: resolvedText(res) } : null,
    summary,
    needsYou: cap || ask !== null,
    tag: `${role.toUpperCase()}${freelancer && round ? ` r${round}` : ''}`,
  };
}

/**
 * The one thing the game remembers per worker: whether it has worked since
 * it was first seen (onboarding ends there). A snapshot keeps what was known
 * of workers still in it; a worker that is gone is forgotten.
 */
export class CrewMemory {
  private readonly worked = new Set<string>();

  observe(w: Pick<Worker, 'id' | 'status' | 'report' | 'codex'>): void {
    if (hasWorked(w)) this.worked.add(w.id);
  }

  snapshot(workers: Iterable<Pick<Worker, 'id' | 'status' | 'report' | 'codex'>>): void {
    const keep = new Set<string>();
    for (const w of workers) {
      if (this.worked.has(w.id) || hasWorked(w)) keep.add(w.id);
    }
    this.worked.clear();
    for (const id of keep) this.worked.add(id);
  }

  forget(id: string): void {
    this.worked.delete(id);
  }

  has(id: string): boolean {
    return this.worked.has(id);
  }
}
