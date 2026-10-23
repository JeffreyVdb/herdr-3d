/**
 * #110 pack up on request: before a prompt goes out, the bridge's `packup.detect` says whether it also tells the
 * worker to leave once the task is done, and what to cut. Pure: who it applies to, the ack read strictly (anything
 * odd is no match: the prompt goes as written), the original split into kept and struck parts for the confirm
 * dialog, the worktree choice it preselects and the wrap-up prompt "Send and go home" sends. The feature's settings
 * include the feature's own extraction policy (`PackupBook`).
 */

import type { FirePrepare, FireWorktree, PackupState, PackupDetectAck, PackupRange, Worker } from '../net/protocol';
import { crewRole, isFreelancer } from './crew';
import { followupFailureText, followupsStateOf } from './followup';
import { reasoningOf } from './digestSettings';
import { fireOptions } from './hire';
import { WRAPUP_PROMPT } from './wrapup';

/** The feature's settings and state, from the snapshot's `packup` and `packup.update`. */
export type PackupSettings = PackupState & Required<Pick<PackupState, 'reasoning_effort' | 'max_tokens' | 'reasoning' | 'effort_stale' | 'timeout_ms'>>;
export function packupStateOf(v: unknown): PackupSettings | null {
  const base = followupsStateOf(v);
  if (!base) return null;
  const o = v as Record<string, unknown>;
  return {
    ...base,
    reasoning_effort: typeof o.reasoning_effort === 'string' ? o.reasoning_effort : '',
    max_tokens: typeof o.max_tokens === 'number' && Number.isFinite(o.max_tokens) && o.max_tokens > 0 ? Math.floor(o.max_tokens) : 600,
    reasoning: reasoningOf(o.reasoning),
    effort_stale: o.effort_stale === true,
    timeout_ms: typeof o.timeout_ms === 'number' && Number.isFinite(o.timeout_ms) && o.timeout_ms > 0 ? o.timeout_ms : 1200,
  };
}

export class PackupBook {
  /** The bridge sent a `packup` state (it has the feature). */
  known = false;
  version = 0;
  private cur: PackupSettings | null = null;
  private readonly listeners = new Set<() => void>();

  get state(): PackupSettings | null {
    return this.cur;
  }

  reset(v: unknown): void {
    this.cur = packupStateOf(v);
    this.known = this.cur !== null;
    this.version++;
    this.emit();
  }

  upsert(v: unknown): boolean {
    const next = packupStateOf(v);
    if (!next) return false;
    this.cur = next;
    this.known = true;
    this.version++;
    this.emit();
    return true;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}

/** Whether a prompt to this worker is looked at: the wrap-up's workers (Claude or Codex agents), never a freelancer. */
export function packupApplies(w: Pick<Worker, 'agent_kind' | 'harness' | 'role' | 'label'> | null | undefined): boolean {
  if (!w) return false;
  const kind = w.agent_kind || '';
  const harness = kind || w.harness || '';
  return !!kind && (harness === 'claude' || harness === 'codex') && !isFreelancer(crewRole(w));
}

/** What a `packup.detect` ack means: send as written, the send-home dialog (nothing left), or confirm the cut. */
export type PackupVerdict = { kind: 'send' } | { kind: 'home' } | { kind: 'confirm'; task: string; removed: PackupRange[] };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Ranges that are sorted, apart and inside `len`, else null. */
export function validRanges(v: unknown, len: number): PackupRange[] | null {
  if (!Array.isArray(v) || !v.length) return null;
  let at = 0;
  const out: PackupRange[] = [];
  for (const r of v as unknown[]) {
    const o = r as Partial<PackupRange> | null;
    if (!o || !isInt(o.start) || !isInt(o.end) || o.start < at || o.end <= o.start || o.end > len) return null;
    out.push({ start: o.start, end: o.end });
    at = o.end;
  }
  return out;
}

/** Reads a `packup.detect` ack for `text`: anything but a well-formed match is "send as written". */
export function packupVerdict(ack: unknown, text: string): PackupVerdict {
  const a = ack as Partial<PackupDetectAck> | null;
  if (!a || a.matched !== true) return { kind: 'send' };
  const task = typeof a.task === 'string' ? a.task.trim() : '';
  if (!task) return { kind: 'home' };
  const removed = validRanges(a.removed, text.length);
  return removed ? { kind: 'confirm', task, removed } : { kind: 'send' };
}

/** The original prompt as kept and struck parts, in order. */
export function struckParts(text: string, removed: PackupRange[]): Array<{ text: string; struck: boolean }> {
  const out: Array<{ text: string; struck: boolean }> = [];
  let at = 0;
  for (const r of removed) {
    if (r.start > at) out.push({ text: text.slice(at, r.start), struck: false });
    out.push({ text: text.slice(r.start, r.end), struck: true });
    at = r.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), struck: false });
  return out;
}

/** The worktree choice the confirm dialog starts with: the worktree and its branch, else the worktree, else keep. */
export function packupChoice(p: FirePrepare): FireWorktree {
  const o = fireOptions(p).enabled;
  return o.delete_branch ? 'delete_branch' : o.delete ? 'delete' : 'keep';
}

/** The cleanup request "Send and go home" adds after the task (the bridge then adds its result-line footer). */
export const PACKUP_CLEANUP = `Once that is done: ${WRAPUP_PROMPT}`;

/** The wrap-up prompt "Send and go home" sends: the task first, then the cleanup request. */
export const packupPrompt = (task: string): string => `${task.trim()}\n\n${PACKUP_CLEANUP}`;

/** Plain words for a `packup.*` failure. */
export function packupFailureText(code: string, message: string): string {
  if (code === 'env_locked') return 'The bridge’s environment switches this (HERDR_WORLD_PACKUP_ENABLED).';
  return followupFailureText(code, message);
}

/**
 * How a send through the pack-up check ended: send as written now, done (the task went, the worker goes home after it),
 * or nothing sent. #108 round 4: or send as written the text the check read (`text`: its protected secrets as
 * references) with the check's hand-over (`secrets_pending`), which needs no review again (`ui/packupSend.ts`).
 */
export type PackupOutcome = 'send' | 'done' | 'cancel' | { handover: string; text: string };
