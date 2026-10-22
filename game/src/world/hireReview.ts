/**
 * #212: the choices of a dictated hire under review, as pure functions so vitest covers them. A `ReviewChoice` is what the
 * interpreter (#211) proposed, and then what the human made of it: harness, model, effort and the task, each with where its
 * value came from.
 *
 * Nothing here falls back. `resolveChoice` / `resolveVisibleChoice` (world/hire.ts) are made for a form that must always be
 * valid: an unknown model becomes the first one, a missing effort becomes `high`. A dictated hire is the opposite: a value
 * that is missing or not valid stays empty until the human picks one, and a model or effort they picked is never swapped
 * for another. The functions below only ever keep a value that is still valid, or clear it.
 */

import type { HandoffEntry, HireInterpretation, HireIntentField, HireOptions } from '../net/protocol';
import { modelsFor } from './hire';
import { effortsFor } from './settings';

/** The four sections of the review, in order. */
export type ReviewSection = 'agent' | 'effort' | 'task' | 'where';
export const REVIEW_SECTIONS: readonly ReviewSection[] = ['agent', 'effort', 'task', 'where'];

/** The fields the interpreter proposes (the rest of the hire is the desk, the folder, the label and the worktree). */
export type ReviewField = 'harness' | 'model' | 'effort' | 'task';

/**
 * Where a value came from, as the review says it: `dictated` (said, and valid as said), `resolved` (the interpreter took
 * it from the catalog for what was said), `default` (the floor, the folder or the name the bridge offers), `chosen` (the
 * human picked or typed it here), `missing` (not said), `invalid` (said, but not usable: it has to be chosen again).
 */
export type Origin = 'dictated' | 'resolved' | 'default' | 'chosen' | 'missing' | 'invalid' | 'handoff';

export const ORIGIN_LABEL: Record<Origin, string> = {
  dictated: 'Dictated',
  resolved: 'Resolved by the interpreter',
  default: 'Default',
  chosen: 'Your choice',
  missing: 'Not given',
  invalid: 'Needs a new choice',
  handoff: 'From the handoff',
};

/** The interpreter's question for a missing effort, word for word (internal/hireintent EffortQuestion). */
export const EFFORT_QUESTION = 'What effort level should this agent use?';

export interface ReviewChoice {
  harness: string;
  model: string;
  /** '' until one is chosen: never preselected. It may be held while the model is not valid yet (`effortOk` says). */
  effort: string;
  /** The complete task, as dictated and as edited since. */
  task: string;
  origin: Record<ReviewField, Origin>;
  /** The words the interpreter or the human gave that were not usable (an unsupported effort, an unknown model). */
  said: Partial<Record<ReviewField, string>>;
  /** Counts the human's edits; a late interpretation reply only changes what was not edited since its `since`. */
  rev: number;
  edited: Record<ReviewField, number>;
}

const NONE: Record<ReviewField, number> = { harness: 0, model: 0, effort: 0, task: 0 };

/** The levels the human may pick for this harness and model: the model's own, none before it is valid. */
export function effortChoices(cat: HireOptions, harness: string, model: string): string[] {
  return modelsFor(cat, harness).includes(model) ? effortsFor(cat, harness, model) : [];
}

export const harnessOk = (c: ReviewChoice, cat: HireOptions): boolean => !!c.harness && !!cat[c.harness];
export const modelOk = (c: ReviewChoice, cat: HireOptions): boolean => harnessOk(c, cat) && modelsFor(cat, c.harness).includes(c.model);
export const effortOk = (c: ReviewChoice, cat: HireOptions): boolean => modelOk(c, cat) && !!c.effort && effortsFor(cat, c.harness, c.model).includes(c.effort);
export const taskOk = (c: ReviewChoice): boolean => c.task.trim() !== '';

/**
 * The sections that need the human before Hire: missing, invalid or conflicting values. Never a default. `taskIssue` is
 * the task's own sendability problem (a flag-looking or too long text), which the caller knows: a non-empty task that
 * cannot be sent needs the human as much as an empty one.
 */
export function needsAttention(c: ReviewChoice, cat: HireOptions, taskIssue: string | null = null): Set<ReviewSection> {
  const out = new Set<ReviewSection>();
  if (!modelOk(c, cat)) out.add('agent');
  if (!effortOk(c, cat)) out.add('effort');
  if (!taskOk(c) || taskIssue) out.add('task');
  return out;
}

/** Why the proposal's field does not hold a value (its words, if any, are kept for the question). */
function read(f: HireIntentField, valid: (v: string) => boolean): { value: string; origin: Origin; said?: string } {
  const good = (f.provenance === 'dictated' || f.provenance === 'resolved') && !!f.value && valid(f.value);
  if (good) return { value: f.value as string, origin: f.provenance as Origin };
  const bad = f.provenance === 'invalid' || (!!f.value && (f.provenance === 'dictated' || f.provenance === 'resolved'));
  const said = f.said ?? (f.value && bad ? f.value : undefined);
  return { value: '', origin: bad ? 'invalid' : 'missing', ...(said ? { said } : {}) };
}

/**
 * The review's starting choice from the interpreter's proposal, checked against the catalog. A value the catalog does not
 * have is empty and `invalid`; one that is missing is empty and `missing`. An effort said before its model is valid is
 * held, and checked once the model is.
 */
/**
 * #223: "Hire from handoff": the review's starting choice from a filed handoff, checked against the catalog like a
 * proposal. Its harness and model when the catalog has them (else empty and `invalid`, the handoff's word kept); the
 * effort is never taken (a handoff does not record one): the human picks it; the task reads the handoff.
 */
export function fromHandoff(e: Pick<HandoffEntry, 'harness' | 'model'>, task: string, cat: HireOptions): ReviewChoice {
  const field = (v: string | undefined): HireIntentField => (v ? { provenance: 'resolved', value: v } : { provenance: 'missing' });
  const c = fromInterpretation(
    { sources: [], harness: field(e.harness), model: field(e.model), effort: { provenance: 'missing' }, task: { provenance: 'dictated', value: task }, questions: [], ready_for_review: true },
    cat,
  );
  const as = (o: Origin): Origin => (o === 'resolved' ? 'handoff' : o);
  return { ...c, origin: { harness: as(c.origin.harness), model: as(c.origin.model), effort: c.origin.effort, task: 'handoff' } };
}

export function fromInterpretation(h: HireInterpretation, cat: HireOptions): ReviewChoice {
  const harness = read(h.harness, (v) => !!cat[v]);
  const model = read(h.model, (v) => !!harness.value && modelsFor(cat, harness.value).includes(v));
  // #190: with no harness yet (a family that names several, a choice to make), an effort some harness takes is held.
  const anyHarness = (v: string) => Object.keys(cat).some((hn) => modelsFor(cat, hn).some((m) => effortsFor(cat, hn, m).includes(v)));
  const supported = (v: string) => (model.value ? effortsFor(cat, harness.value, model.value).includes(v) : harness.value ? (cat[harness.value]?.efforts ?? []).includes(v) : anyHarness(v));
  const effort = read(h.effort, supported);
  const task = h.task.provenance === 'dictated' && h.task.value ? h.task.value : '';
  const c: ReviewChoice = {
    harness: harness.value,
    model: model.value,
    effort: effort.value,
    task,
    origin: { harness: harness.origin, model: model.origin, effort: effort.origin, task: task ? 'dictated' : 'missing' },
    said: {},
    rev: 0,
    edited: { ...NONE },
  };
  for (const [k, r] of [['harness', harness], ['model', model], ['effort', effort]] as const) if (r.said) c.said[k] = r.said;
  return c;
}

function touch(c: ReviewChoice, ...fields: ReviewField[]): ReviewChoice {
  const rev = c.rev + 1;
  const edited = { ...c.edited };
  for (const f of fields) edited[f] = rev;
  return { ...c, rev, edited };
}

/** An effort that no longer fits the model (or harness) is cleared, never replaced; its word is kept to say why. */
function recheckEffort(c: ReviewChoice, cat: HireOptions): ReviewChoice {
  if (!c.effort) return c;
  const ok = c.model ? effortOk(c, cat) : !!c.harness && (cat[c.harness]?.efforts ?? []).includes(c.effort);
  if (ok) return c;
  return { ...c, effort: '', origin: { ...c.origin, effort: 'invalid' }, said: { ...c.said, effort: c.effort } };
}

/**
 * The human picked a harness. Its models are others: the model is empty until they pick one (no "first model" falls in),
 * and the effort stays only if the new harness takes it.
 */
export function pickHarness(c: ReviewChoice, harness: string, cat: HireOptions): ReviewChoice {
  if (!cat[harness] || harness === c.harness) return c;
  const keepModel = modelsFor(cat, harness).includes(c.model);
  const next: ReviewChoice = {
    ...touch(c, 'harness', 'model'),
    harness,
    model: keepModel ? c.model : '',
    origin: { ...c.origin, harness: 'chosen', model: keepModel ? c.origin.model : 'missing' },
    said: { ...c.said },
  };
  delete next.said.harness;
  if (!keepModel) delete next.said.model;
  return recheckEffort(next, cat);
}

/** The human picked a model of the current harness: a still-supported effort stays, any other is cleared. */
export function pickModel(c: ReviewChoice, model: string, cat: HireOptions): ReviewChoice {
  if (!modelsFor(cat, c.harness).includes(model)) return c;
  const next: ReviewChoice = { ...touch(c, 'model'), model, origin: { ...c.origin, model: 'chosen' }, said: { ...c.said } };
  delete next.said.model;
  return recheckEffort(next, cat);
}

/** #190: the human picked one of the interpreter's choices: its harness and model together. */
export function pickAgent(c: ReviewChoice, harness: string, model: string, cat: HireOptions): ReviewChoice {
  if (!modelsFor(cat, harness).includes(model)) return c;
  return pickModel(pickHarness(c, harness, cat), model, cat);
}

/** #190: the interpreter's model question, as the review asks it: its words and its choices by harness, in its order. */
export interface AgentQuestion {
  text: string;
  choices: Array<{ harness: string; models: string[] }>;
}

/**
 * #190: the interpreter's question about the model (one it could not take, a family that names several, a selection it
 * found unclear) while the human has not picked a harness or model since. Its choices are exactly its own, those the
 * catalog still has. Null: no question, or the human answered it.
 */
export function agentQuestion(c: ReviewChoice, h: HireInterpretation | null, cat: HireOptions): AgentQuestion | null {
  const q = h?.questions.find((x) => x.field === 'model' || x.field === 'selection');
  if (!q || c.origin.harness === 'chosen' || c.origin.model === 'chosen') return null;
  const choices: AgentQuestion['choices'] = [];
  for (const ch of q.choices ?? []) {
    if (!modelsFor(cat, ch.harness).includes(ch.model)) continue;
    const group = choices.find((g) => g.harness === ch.harness) ?? choices[choices.push({ harness: ch.harness, models: [] }) - 1]!;
    if (!group.models.includes(ch.model)) group.models.push(ch.model);
  }
  return { text: q.text, choices };
}

/**
 * An effort, from a click (`chosen`) or a dictated reply (`dictated`). Only one the model supports is taken: null for any
 * other, and nothing changes.
 */
export function pickEffort(c: ReviewChoice, effort: string, cat: HireOptions, by: 'chosen' | 'dictated' = 'chosen'): ReviewChoice | null {
  if (!effortChoices(cat, c.harness, c.model).includes(effort)) return null;
  const next: ReviewChoice = { ...touch(c, 'effort'), effort, origin: { ...c.origin, effort: by }, said: { ...c.said } };
  delete next.said.effort;
  return next;
}

/** The human edited the task: its text as typed, whole. */
export function editTask(c: ReviewChoice, task: string): ReviewChoice {
  return { ...touch(c, 'task'), task, origin: { ...c.origin, task: 'chosen' } };
}

/**
 * A later reply of the interpreter (a follow-up, or a slow answer), for a request made when the choice was at `since`
 * (`rev`): it changes only what the human has not edited since. The harness and model go together; an effort the human
 * picked stays when the model it came with still fits it, and is cleared (never replaced) when it does not.
 */
export function applyInterpretation(c: ReviewChoice, h: HireInterpretation, cat: HireOptions, since: number): ReviewChoice {
  const fresh = fromInterpretation(h, cat);
  const agentEdited = c.edited.harness > since || c.edited.model > since;
  const effortEdited = c.edited.effort > since;
  const taskEdited = c.edited.task > since;
  let next: ReviewChoice = { ...c, said: { ...c.said }, origin: { ...c.origin } };
  const take = (f: ReviewField) => {
    next[f] = fresh[f];
    next.origin[f] = fresh.origin[f];
    if (fresh.said[f]) next.said[f] = fresh.said[f];
    else delete next.said[f];
  };
  if (!agentEdited) {
    take('harness');
    take('model');
  }
  if (!effortEdited) take('effort');
  if (!taskEdited) take('task');
  next = recheckEffort(next, cat);
  return next;
}

/** The catalog changed under the review (a model left it): a value that is gone is cleared, one that is still there stays. */
export function revalidate(c: ReviewChoice, cat: HireOptions): ReviewChoice {
  let next = c;
  if (c.harness && !cat[c.harness]) next = { ...next, harness: '', model: '', origin: { ...next.origin, harness: 'invalid', model: 'missing' }, said: { ...next.said, harness: c.harness } };
  else if (c.model && !modelsFor(cat, c.harness).includes(c.model)) next = { ...next, model: '', origin: { ...next.origin, model: 'invalid' }, said: { ...next.said, model: c.model } };
  return recheckEffort(next, cat);
}

/** A task as one readable line for the collapsed section: whitespace squeezed, cut with an ellipsis. */
export function taskPreview(task: string, max = 90): string {
  const s = task.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
