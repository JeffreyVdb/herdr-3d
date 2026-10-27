/**
 * Hire and send home (M4): the dialogs' state as pure functions, so vitest
 * covers them. Which choice is preselected, the capacity states, how old the
 * worktree base is, which send-home options are enabled, the first task's
 * keys, and the args each command sends.
 */

import type { Cap, CommandArgs, FirePrepare, FireWorktree, Hire, HireCapacity, HireGit, HireOptions, HirePrepare } from '../net/protocol';
import { effortsFor } from './settings';
import type { FloorView } from './store';

/** The names a harness goes by in the player's words (Hire, Settings, the inbox). */
export const HARNESS_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

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

/**
 * The catalog as the model pickers offer it: each harness keeps its place and its efforts, and its models are the ones
 * `hidden` does not name, in catalog order. A harness with every model hidden stays as a key with no models, so it can
 * still be picked and shows its empty state. The catalog itself is not changed (Settings, presets and runs read it whole).
 */
export function visibleOptions(options: HireOptions, hidden: (harness: string) => ReadonlySet<string>): HireOptions {
  const out: HireOptions = {};
  for (const [harness, o] of Object.entries(options)) {
    const off = hidden(harness);
    out[harness] = { ...o, models: o.models.filter((m) => !off.has(m)) };
  }
  return out;
}

/**
 * The catalog a model picker offers (Hire, Start run, team presets, floor defaults): the models Settings leaves shown,
 * with `keep` (a saved choice: a preset's role, a floor default) still offered for its harness when it is hidden, so
 * opening a picker never rewrites what was saved. `hidden` absent (no Settings): the whole catalog. Validation keeps
 * reading the whole catalog, so a saved choice of a hidden model stays valid.
 */
export function offeredOptions(options: HireOptions, hidden: ((harness: string) => ReadonlySet<string>) | null | undefined, keep: ReadonlyArray<Partial<Hire> | null | undefined> = []): HireOptions {
  if (!hidden) return options;
  const out = visibleOptions(options, hidden);
  for (const k of keep) {
    const all = k?.harness ? options[k.harness]?.models : undefined;
    const shown = k?.harness ? out[k.harness] : undefined;
    if (!k?.model || !all || !shown || shown.models.includes(k.model) || !all.includes(k.model)) continue;
    shown.models = all.filter((m) => m === k.model || shown.models.includes(m));
  }
  return out;
}

/**
 * `resolveChoice` for the Hire dialog: a harness with no visible model stays the harness (model and effort empty) rather
 * than resolving to nothing, so the dialog can show its empty state and the player can still switch harness.
 */
export function resolveVisibleChoice(options: HireOptions, want: Partial<Hire> | null | undefined): Hire {
  const c = resolveChoice(options, want);
  if (c) return c;
  const harness = want?.harness && options[want.harness] ? want.harness : (Object.keys(options)[0] ?? '');
  return { harness, model: '', effort: '' };
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

/** "origin/main @ 1a2b3c4, 3 h old"; a preview without local origin refs: "origin/HEAD" (#134). */
export function baseText(g: HireGit, now: number): string {
  if (g.preview && (!g.default_branch || !g.base_sha)) return 'origin/HEAD';
  return `origin/${g.default_branch} @ ${g.base_sha.slice(0, 7)}, ${ageText(g.base_time, now)}`;
}

/** #134: what a preview's base is: the last fetched one, or not known yet; either way the hire fetches before it branches (null: a fetch's answer). */
export function baseHint(g: HireGit): string | null {
  if (!g.preview) return null;
  return !g.default_branch || !g.base_sha ? 'not fetched into this checkout yet; checked before branching' : 'last fetched; refreshed before branching';
}

/**
 * Whether a worktree hire can be offered: origin was just fetched, or (#134) the base is a local preview. A worktree
 * branches from a freshly fetched origin/<default>, never from a stale one: the hire fetches first and is refused
 * (`fetch_failed`) when that fails.
 */
export function worktreeUsable(g: HireGit | null): boolean {
  return !!g && (g.fetched || g.preview === true);
}

/** Why the worktree is off after a failed fetch (null: origin is fresh, or the base is a preview that was not fetched). */
export function fetchNote(g: HireGit): { text: string; error: boolean } | null {
  if (g.fetched || g.preview) return null;
  const why = g.fetch_error ? `: ${g.fetch_error}` : '';
  return { text: `git fetch origin failed${why}. A worktree needs a fresh origin/${g.default_branch || 'main'}: fetch again, or hire without one.`, error: true };
}

/**
 * #134: the git answer a dialog keeps: a preview of the repository a fetch already answered for says less than that
 * fetch (a failure it showed, or the base it found), so the fetch's answer stays.
 */
export function newerGit(had: HireGit | null | undefined, got: HireGit | null): HireGit | null {
  return got?.preview && had && !had.preview && had.repo_root === got.repo_root ? had : got;
}

/**
 * #134: the fetches a dialog sent for origin. A preview never cancels one: a fetch's answer is still the dialog's when
 * no fetch was sent after it (nor the dialog opened again) and the dialog shows the repository it is about, whatever
 * previews were sent or answered meanwhile (`newerGit` keeps it over those). Another repository's answer is dropped.
 */
export class OriginFetches {
  private n = 0;

  /** A fetch sent now: every older one's answer is stale. */
  start(): number {
    return ++this.n;
  }

  /** The dialog opened again: no fetch sent before is its. */
  forget(): void {
    this.n++;
  }

  /** Whether fetch `ticket`'s git `got` is still for `shown`, the git on screen (no repository on either side: the same). */
  current(ticket: number, shown: HireGit | null | undefined, got: HireGit | null): boolean {
    return ticket === this.n && (shown?.repo_root ?? null) === (got?.repo_root ?? null);
  }
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

/** Where a hire may sit down: the desk, or why the floor or desk cannot take one (`ms`: how long the game's toast stays). */
export type HireSeat = { ok: true; desk: number } | { ok: false; msg: string; ms: number };

/**
 * #58 decision 3: why a floor takes no hire (or run) now, null when it does. A floor that is waking up or going to sleep
 * takes nobody; an asleep real floor neither (wake it first), but an asleep virtual floor does: the bridge wakes its
 * session first ("Waking floor…"). `what`: "hire" or "start a run".
 */
export function floorClosed(fv: Pick<FloorView, 'name' | 'asleep' | 'transition' | 'virtual'>, what = 'hire'): string | null {
  if (!fv.transition && (!fv.asleep || fv.virtual)) return null;
  const state = fv.transition === 'waking' ? 'waking up' : fv.transition === 'sleeping' ? 'going to sleep' : 'asleep';
  return `${fv.name} is ${state}. Wake it from the elevator (L) to ${what}.`;
}

/**
 * The floor and desk a hire opens for, by the rules the Hire dialog has always had (App.openHire, and the review dialog):
 * a floor that is gone or changing state takes nobody (an asleep one: `floorClosed`), no `desk` is the first free one,
 * and a desk somebody sits at or another hire is on its way to is not offered.
 */
export function resolveHireDesk(floor: string | null, fv: FloorView | null, held: ReadonlySet<number>, desk?: number): HireSeat {
  if (!floor || !fv) return { ok: false, msg: 'Walk onto an office floor to hire someone there.', ms: 2400 };
  const closed = floorClosed(fv);
  if (closed) return { ok: false, msg: closed, ms: 3200 };
  const d = desk ?? firstFreeDesk(fv, held);
  if (d === null) return { ok: false, msg: `No free desk on ${fv.name} right now.`, ms: 2400 };
  if (held.has(d) && !fv.seats[d]) return { ok: false, msg: `Someone is already on the way to Desk ${d + 1}.`, ms: 2000 };
  const seat = fv.seats[d];
  if (seat) return { ok: false, msg: `${seat.name} sits at Desk ${d + 1}.`, ms: 2000 };
  return { ok: true, desk: d };
}

/**
 * Hires on their way, one entry per `worker.hire` in flight (Esc closes the
 * dialog, not the hire, so another can start meanwhile). Each hire holds its
 * desk and only its own `release` lets go of it: an older hire's ack never
 * frees a newer hire's desk, and no hire picks a desk another one holds.
 */
export class Reservations {
  private readonly held = new Map<number, { floor: string; desk: number }>();
  private next = 0;

  /** Holds `desk` of floor `floor` (an id); the returned function lets go of this hold only (true: the desk is no longer held by anyone). */
  add(floor: string, desk: number): () => boolean {
    const id = ++this.next;
    this.held.set(id, { floor, desk });
    return () => this.held.delete(id) && !this.has(floor, desk);
  }

  has(floor: string, desk: number): boolean {
    for (const r of this.held.values()) if (r.floor === floor && r.desk === desk) return true;
    return false;
  }

  /** Desks of a floor some hire holds. */
  desks(floor: string): Set<number> {
    const out = new Set<number>();
    for (const r of this.held.values()) if (r.floor === floor) out.add(r.desk);
    return out;
  }

  all(): Array<{ floor: string; desk: number }> {
    return [...this.held.values()];
  }
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
export function formFromPrepare(p: HirePrepare, options: HireOptions, worktreeByDefault = true): HireForm {
  const c = resolveVisibleChoice(options, p.choice ?? null);
  return {
    prompt: '',
    harness: c.harness,
    model: c.model,
    effort: c.effort,
    label: p.label,
    cwd: p.cwd,
    worktree: worktreeByDefault && worktreeUsable(p.git),
  };
}

/** Why a hire is held back by the caps (null: there is room). */
export function capBlocker(cap: CapacityView | null): string | null {
  return cap?.level === 'full' ? 'Over the hard cap: send someone home first.' : null;
}

/** Why the folder or the label cannot be sent (null: they can). */
export function optionsBlocker(f: Pick<HireForm, 'cwd' | 'label'>): string | null {
  const cwd = f.cwd.trim();
  if (cwd && !cwd.startsWith('/')) return 'The folder must be an absolute path.';
  const label = f.label.trim();
  if (new TextEncoder().encode(label).length > 64) return 'The label is at most 64 bytes.';
  if (label.startsWith('-')) return 'The label can’t start with “-”.';
  return null;
}

/** Why the first task cannot be sent (null: it can, or there is none). */
export function promptBlocker(prompt: string): string | null {
  return prompt.trim().startsWith('--') ? 'The first task can’t start with “--” (herdr would read it as a flag).' : null;
}

/** Why the form cannot be sent (null: it can). */
export function hireBlocker(f: HireForm, options: HireOptions, cap: CapacityView | null): string | null {
  const capped = capBlocker(cap);
  if (capped) return capped;
  if (!options[f.harness]) return 'Choose a harness.';
  if (!modelsFor(options, f.harness).length) return 'Every model for this harness is hidden. Show one in Settings.';
  if (!modelsFor(options, f.harness).includes(f.model)) return 'Choose a model.';
  if (!effortsFor(options, f.harness, f.model).includes(f.effort)) return 'Choose an effort.';
  return optionsBlocker(f) ?? promptBlocker(f.prompt);
}

/** `worker.hire` args: the label and cwd only when set, the worktree only when the cwd is a repo (and never after a failed fetch), the prompt only when there is one. */
export function hireArgs(floor: string, desk: number, f: HireForm, git: HireGit | null): CommandArgs['worker.hire'] {
  const a: CommandArgs['worker.hire'] = { floor, desk_index: desk, harness: f.harness, model: f.model, effort: f.effort };
  const label = f.label.trim();
  if (label) a.label = label;
  const cwd = f.cwd.trim();
  if (cwd) a.cwd = cwd;
  if (git) a.worktree = f.worktree && worktreeUsable(git);
  if (f.prompt.trim()) a.prompt = f.prompt.trimEnd();
  return a;
}

/** The send-home choices for a worktree: which are offered, which may be picked, and the warning. */
export interface FireOptions {
  /** Only a worker in a linked worktree of its own has worktree choices. */
  offered: boolean;
  /** The choices listed: "delete the worktree and the branch" only when the bridge may delete the branch. */
  choices: FireWorktree[];
  enabled: Record<FireWorktree, boolean>;
  warning: string | null;
  /** Why the branch stays although the worktree may go, null otherwise. */
  branchNote: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What is left on the desk, e.g. "3 uncommitted changes and 2 commits not on any remote", null when clean. */
export function leftovers(p: FirePrepare): string | null {
  const parts: string[] = [];
  if (p.dirty.length) parts.push(plural(p.dirty.length, 'uncommitted change'));
  if (p.unpushed > 0) parts.push(`${plural(p.unpushed, 'commit')} not on any remote`);
  return parts.length ? parts.join(' and ') : null;
}

/**
 * #63: a scheduled agent holds the worktree. The bridge's reason (`worker.fire.prepare`'s `reason`, and the message of
 * the `invalid_state` that refuses a delete) is "used by scheduled agent '<title>' at <due>", maybe "… and 2 more".
 * Returns that reason, null for any other.
 */
export function scheduleHold(why: string | null | undefined): string | null {
  const m = /(?:^|: )(used by scheduled agent '.*)$/s.exec(why?.trim() ?? '');
  return m ? m[1]!.replace(/\.$/, '') : null;
}

/** Why the worker cannot be sent home at all (herdr would refuse to close its workspace), else null. */
export function fireBlocked(p: FirePrepare): string | null {
  if (p.can_fire !== false) return null;
  return p.fire_blocked ?? 'herdr would refuse to close its workspace';
}

export function fireOptions(p: FirePrepare): FireOptions {
  const offered = !!p.worktree?.linked;
  const del = offered && p.can_delete;
  // The bridge only deletes a branch it made for this worker (and only once it is all pushed).
  const delBranch = del && p.can_delete_branch === true;
  let warning: string | null = null;
  if (offered && !p.can_delete) {
    const left = leftovers(p);
    const hold = scheduleHold(p.reason);
    // Commit and push only helps with what is left on the desk; a scheduled agent's hold ends when it starts.
    const next = hold
      ? / and \d+ more$/.test(hold)
        ? 'The worktree stays until those agents start, or until their schedules are cancelled.'
        : 'The worktree stays until that agent starts, or until its schedule is cancelled.'
      : left
        ? 'The worktree stays; commit and push first to delete it.'
        : 'The worktree stays.';
    warning = `Deleting is off: ${p.reason ?? left ?? 'the bridge cannot tell whether the work is safe'}. ${next}`;
  }
  const choices: FireWorktree[] = !offered ? [] : delBranch ? ['keep', 'delete', 'delete_branch'] : ['keep', 'delete'];
  const branchNote = del && !delBranch && p.branch ? `The branch ${p.branch} stays either way: herdr-world only deletes a branch it made for this worker.` : null;
  return { offered, choices, enabled: { keep: true, delete: del, delete_branch: delBranch }, warning, branchNote };
}

/** `worker.fire` args: the worktree choice only for a worktree worker, and never a disabled one. */
export function fireArgs(id: string, p: FirePrepare, choice: FireWorktree): CommandArgs['worker.fire'] {
  const o = fireOptions(p);
  if (!o.offered || !o.enabled[choice]) return { id };
  return { id, worktree: choice };
}

/** A worker whose first upsert carries a `hired_at` this recent drops in (M6b; bridge clock vs ours). */
export const FRESH_HIRE_MS = 15_000;

export function isFreshHire(hiredAt: number | undefined, now: number): boolean {
  return typeof hiredAt === 'number' && Number.isFinite(hiredAt) && now - hiredAt < FRESH_HIRE_MS && hiredAt - now < FRESH_HIRE_MS;
}
