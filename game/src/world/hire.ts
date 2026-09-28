/**
 * Hire and send home (M4): the dialogs' state as pure functions, so vitest
 * covers them. Which choice is preselected, the capacity states, how old the
 * worktree base is, which send-home options are enabled, the first task's
 * keys, and the args each command sends.
 */

import type { Cap, CommandArgs, FirePrepare, FireWorktree, Hire, HireCapacity, HireGit, HireOptions, HirePrepare } from '../net/protocol';
import { effortsFor } from './settings';
import type { FloorView } from './store';

/** The effort a fresh choice starts at when nothing says otherwise. */
const PREFERRED_EFFORT = 'high';

/** Models of a harness, [] for an unknown one. */
export function modelsFor(options: HireOptions, harness: string): string[] {
  return options[harness]?.models ?? [];
}

/**
 * A valid harness / model / effort, as close to `want` as the options allow:
 * an unknown harness falls back to the first one, an unknown model to the
 * harness's first, an effort the model does not take to `high` (else its
 * first). `want` null (no floor default, nothing hired yet) is the same fallback.
 */
export function resolveChoice(options: HireOptions, want: Partial<Hire> | null | undefined): Hire | null {
  const harnesses = Object.keys(options);
  const harness = want?.harness && options[want.harness] ? want.harness : harnesses[0];
  if (!harness) return null;
  const models = modelsFor(options, harness);
  const model = want?.model && models.includes(want.model) ? want.model : models[0];
  if (!model) return null;
  const efforts = effortsFor(options, harness, model);
  const effort = want?.effort && efforts.includes(want.effort) ? want.effort : efforts.includes(PREFERRED_EFFORT) ? PREFERRED_EFFORT : efforts[0];
  if (!effort) return null;
  return { harness, model, effort };
}

/** Where the preselected choice came from, as the dialog says it. */
export function choiceNote(source: HirePrepare['choice_source'], matches: boolean): string | null {
  if (!matches) return null;
  if (source === 'floor_default') return 'Floor default';
  if (source === 'last') return 'Last hire here';
  return null;
}

export type CapLevel = 'ok' | 'warn' | 'full';

/** A cap after one more hire: `warn` above the soft cap, `full` when the hard cap is already reached. */
export function capLevel(c: Cap): CapLevel {
  if (c.count >= c.hard) return 'full';
  if (c.count + 1 > c.soft) return 'warn';
  return 'ok';
}

export interface CapacityView {
  level: CapLevel;
  floor: CapLevel;
  host: CapLevel;
  /** One line per cap that needs saying; empty when both are fine. */
  lines: string[];
  /** Host load, e.g. "load 2.4 on 16 CPUs · memory 41 %", null when unknown. */
  load: string | null;
}

const worst = (a: CapLevel, b: CapLevel): CapLevel => (a === 'full' || b === 'full' ? 'full' : a === 'warn' || b === 'warn' ? 'warn' : 'ok');
const workers = (n: number) => `${n} ${n === 1 ? 'worker' : 'workers'}`;

export function capacityView(c: HireCapacity, floor: string): CapacityView {
  const f = capLevel(c.floor);
  const h = capLevel(c.host);
  const lines: string[] = [];
  const say = (level: CapLevel, where: string, cap: Cap) => {
    if (level === 'full') lines.push(`${where} has ${workers(cap.count)}: its hard cap is ${cap.hard}.`);
    else if (level === 'warn') lines.push(`${where} will have ${workers(cap.count + 1)}, over its soft cap of ${cap.soft} (hard cap ${cap.hard}).`);
  };
  say(f, floor, c.floor);
  say(h, 'The host', c.host);
  const l = c.load;
  const load = l ? `load ${l.load1.toFixed(1)} on ${l.cpus} ${l.cpus === 1 ? 'CPU' : 'CPUs'} · memory ${Math.round(l.mem_used_pct)} %` : null;
  return { level: worst(f, h), floor: f, host: h, lines, load };
}

/** "3 h old", "12 min old", "2 d old", "just now" (base commit time vs now, unix ms). */
export function ageText(then: number, now: number): string {
  const s = Math.max(0, (now - then) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)} min old`;
  const h = m / 60;
  if (h < 48) return `${Math.floor(h)} h old`;
  return `${Math.floor(h / 24)} d old`;
}

/** "origin/main @ 1a2b3c4, 3 h old". */
export function baseText(g: HireGit, now: number): string {
  return `origin/${g.default_branch} @ ${g.base_sha.slice(0, 7)}, ${ageText(g.base_time, now)}`;
}

/** The note under the worktree base: fresh, stale or the fetch error. */
export function fetchNote(g: HireGit): { text: string; error: boolean } | null {
  if (g.fetch_error) return { text: `git fetch origin failed: ${g.fetch_error}. The base is what was fetched last.`, error: true };
  if (!g.fetched) return { text: 'Not fetched just now: the base is what was fetched last.', error: false };
  return null;
}

/** The desks of a floor nobody sits at, lowest first. */
export function freeDesks(v: FloorView): number[] {
  const out: number[] = [];
  v.seats.forEach((s, i) => {
    if (!s) out.push(i);
  });
  return out;
}

/** The desk the top bar's Hire opens: the first free one, skipping `taken` (hires in flight). */
export function firstFreeDesk(v: FloorView, taken: ReadonlySet<number> = new Set()): number | null {
  return freeDesks(v).find((d) => !taken.has(d)) ?? null;
}

/** What a key in the first-task textarea does: Enter sends, Shift+Enter is a new line, anything else types. */
export function taskKey(e: { key: string; shiftKey: boolean; isComposing?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): 'send' | 'newline' | null {
  if (e.key !== 'Enter' || e.isComposing) return null;
  if (e.shiftKey) return 'newline';
  if (e.altKey) return null;
  return 'send';
}

/** The hire dialog as filled in. */
export interface HireForm {
  prompt: string;
  harness: string;
  model: string;
  effort: string;
  label: string;
  cwd: string;
  worktree: boolean;
}

/** The form a prepare opens with. */
export function formFromPrepare(p: HirePrepare, options: HireOptions): HireForm {
  const c = resolveChoice(options, p.choice ?? null);
  return {
    prompt: '',
    harness: c?.harness ?? '',
    model: c?.model ?? '',
    effort: c?.effort ?? '',
    label: p.label,
    cwd: p.cwd,
    worktree: p.git !== null,
  };
}

/** Why the form cannot be sent (null: it can). */
export function hireBlocker(f: HireForm, options: HireOptions, cap: CapacityView | null): string | null {
  if (cap?.level === 'full') return 'Over the hard cap: send someone home first.';
  if (!options[f.harness]) return 'Choose a harness.';
  if (!modelsFor(options, f.harness).includes(f.model)) return 'Choose a model.';
  if (!effortsFor(options, f.harness, f.model).includes(f.effort)) return 'Choose an effort.';
  const cwd = f.cwd.trim();
  if (cwd && !cwd.startsWith('/')) return 'The folder must be an absolute path.';
  if (f.label.trim().length > 64) return 'The label is at most 64 characters.';
  return null;
}

/** `worker.hire` args: the label and cwd only when set, the worktree only when the cwd is a repo, the prompt only when there is one. */
export function hireArgs(session: string, desk: number, f: HireForm, git: HireGit | null): CommandArgs['worker.hire'] {
  const a: CommandArgs['worker.hire'] = { session, desk_index: desk, harness: f.harness, model: f.model, effort: f.effort };
  const label = f.label.trim();
  if (label) a.label = label;
  const cwd = f.cwd.trim();
  if (cwd) a.cwd = cwd;
  if (git) a.worktree = f.worktree;
  if (f.prompt.trim()) a.prompt = f.prompt;
  return a;
}

/** The send-home choices for a worktree: which are offered, which may be picked, and the warning. */
export interface FireOptions {
  /** Only a worker in a linked worktree of its own has worktree choices. */
  offered: boolean;
  enabled: Record<FireWorktree, boolean>;
  warning: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What is left on the desk, e.g. "3 uncommitted changes and 2 commits not on any remote", null when clean. */
export function leftovers(p: FirePrepare): string | null {
  const parts: string[] = [];
  if (p.dirty.length) parts.push(plural(p.dirty.length, 'uncommitted change'));
  if (p.unpushed > 0) parts.push(`${plural(p.unpushed, 'commit')} not on any remote`);
  return parts.length ? parts.join(' and ') : null;
}

export function fireOptions(p: FirePrepare): FireOptions {
  const offered = !!p.worktree?.linked;
  const del = offered && p.can_delete;
  let warning: string | null = null;
  if (offered && !p.can_delete) {
    const left = leftovers(p);
    warning = `Deleting is off: ${p.reason ?? left ?? 'the bridge cannot tell whether the work is safe'}. The worktree stays; commit and push first to delete it.`;
  }
  return { offered, enabled: { keep: true, delete: del, delete_branch: del }, warning };
}

/** `worker.fire` args: the worktree choice only for a worktree worker, and never a disabled one. */
export function fireArgs(id: string, p: FirePrepare, choice: FireWorktree): CommandArgs['worker.fire'] {
  const o = fireOptions(p);
  if (!o.offered || !o.enabled[choice]) return { id };
  return { id, worktree: choice };
}

/** A worker whose first upsert carries a `hired_at` this recent walks in (bridge clock vs ours). */
export const FRESH_HIRE_MS = 15_000;

export function isFreshHire(hiredAt: number | undefined, now: number): boolean {
  return typeof hiredAt === 'number' && Number.isFinite(hiredAt) && now - hiredAt < FRESH_HIRE_MS && hiredAt - now < FRESH_HIRE_MS;
}
