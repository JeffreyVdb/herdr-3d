/**
 * Starting a run (M6): the start-run dialog's and the presets panel's state
 * as pure functions, so vitest covers them. The ticket input (an issue
 * number, an issue URL or free text, detected as you type), the prompt
 * preview's generated / custom states, what blocks Start or Save, and the
 * args `run.prepare`, `run.start` and `preset.*` send.
 */

import type { CodexProfilesState, CommandArgs, Hire, HireOptions, Preset, PresetRoles, RunPrepare } from '../net/protocol';
import { modelsFor } from './hire';
import { labelsOf, modelLabel } from './modelLabel';
import { PRESET_ROLES, ROLE_LABEL, type PresetBook } from './presets';
import { roleProfileLabel } from './runProfiles';
import { effortsFor } from './settings';

const bytes = (s: string) => new TextEncoder().encode(s).length;

// ---- the ticket ------------------------------------------------------------------

/** At most this many bytes of free text (the bridge's limit). */
export const TICKET_TEXT_MAX = 4096;
/** At most this many bytes of extra instructions. */
export const EXTRA_MAX = 8192;

/** M7: a card of the floor's issue board, as the dialog names it. */
export interface WorkItemRef {
  provider: string;
  id: string;
  /** `#9`. */
  key: string;
  title: string;
  /** Where the provider shows it; absent when it has no page. */
  url?: string | undefined;
  /** What the provider is called, for the dialog's copy. */
  provider_name?: string | undefined;
}

export type TicketInput =
  | { kind: 'empty' }
  /** M7: "Hand to a worker": the run starts on this card of the issue board (`work_item`), whatever the provider. */
  | { kind: 'work_item'; item: WorkItemRef; why: null }
  /** `repo` null: a bare number on a floor with no linked repo (`why` says so). */
  | { kind: 'issue'; number: number; repo: string | null; url: string | null; from: 'number' | 'url'; arg: number | string; why: string | null }
  | { kind: 'text'; text: string; why: string | null };

const ISSUE_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/issues\/(\d{1,9})\/?(?:[?#]\S*)?$/;
const ISSUE_NUMBER = /^#?(\d{1,9})$/;

export const issueUrl = (repo: string, n: number) => `https://github.com/${repo}/issues/${n}`;

/**
 * What the one ticket input holds: `3` or `#3` is an issue of the floor's
 * linked repo (`repo`: `settings.repo ?? suggested.repo`), an issue URL
 * carries its own repo, anything else is free text (trimmed; it may span lines).
 */
export function parseTicket(input: string, repo: string | null | undefined): TicketInput {
  const t = input.trim();
  if (!t) return { kind: 'empty' };
  const num = ISSUE_NUMBER.exec(t);
  if (num) {
    const n = Number(num[1]);
    if (n < 1) return { kind: 'text', text: t, why: 'Issue numbers start at 1.' };
    const r = repo || null;
    return { kind: 'issue', number: n, repo: r, url: r ? issueUrl(r, n) : null, from: 'number', arg: n, why: r ? null : 'This floor has no linked repo: paste the issue’s URL, or link a repo in the floor settings.' };
  }
  const url = ISSUE_URL.exec(t);
  if (url) {
    const r = `${url[1]}/${url[2]}`;
    const n = Number(url[3]);
    if (n < 1) return { kind: 'text', text: t, why: 'Issue numbers start at 1.' };
    const u = issueUrl(r, n);
    return { kind: 'issue', number: n, repo: r, url: u, from: 'url', arg: u, why: null };
  }
  return { kind: 'text', text: t, why: bytes(t) > TICKET_TEXT_MAX ? `The ticket text is at most ${TICKET_TEXT_MAX} bytes.` : null };
}

/** The ticket's args (`issue` or `text`, or neither while there is none or it cannot be sent). */
export function ticketArgs(t: TicketInput): { issue?: number | string; text?: string; work_item?: { provider: string; id: string } } {
  if (t.kind === 'work_item') return { work_item: { provider: t.item.provider, id: t.item.id } };
  if (t.kind === 'issue' && !t.why) return { issue: t.arg };
  if (t.kind === 'text' && !t.why) return { text: t.text };
  return {};
}

/** What the dialog says it read, e.g. "Issue #3 · JeffreyVdb/lab". */
export function ticketLine(t: TicketInput): string {
  if (t.kind === 'empty') return 'An issue number, an issue URL, or what to build in your own words.';
  if (t.kind === 'work_item') return `${t.item.key} · ${t.item.title}`;
  if (t.kind === 'issue') return t.repo ? `Issue #${t.number} · ${t.repo}` : `Issue #${t.number}`;
  const words = t.text.split(/\s+/).filter(Boolean).length;
  return `Free text · ${words} ${words === 1 ? 'word' : 'words'}`;
}

// ---- the prompt preview --------------------------------------------------------------

/**
 * The preview: `generated` is the bridge's latest `run.prepare` prompt, `text`
 * what the textarea holds. Until the user edits it, it follows `generated`;
 * once edited it is custom and later field changes never overwrite it (the
 * dialog offers "Reset to generated" instead).
 */
export interface Preview {
  generated: string;
  text: string;
  custom: boolean;
}

export const emptyPreview = (): Preview => ({ generated: '', text: '', custom: false });

/** A new prompt from `run.prepare`. */
export function previewGenerated(p: Preview, prompt: string): Preview {
  return p.custom ? { ...p, generated: prompt } : { generated: prompt, text: prompt, custom: false };
}

/** The user typed in the preview; typed back to the generated prompt it follows the fields again. */
export function previewEdited(p: Preview, text: string): Preview {
  return { ...p, text, custom: text !== p.generated };
}

export function previewReset(p: Preview): Preview {
  return { ...p, text: p.generated, custom: false };
}

/** `[Image #n]`: the marker of an image whose upload has not given it a path yet (`[Image #n: <path>]` once it has). */
const PATHLESS_IMAGE = /\[Image #(\d+)\]/g;

/** The part of the Extra instructions' draft that tells its images from its prose (a `DraftSnapshot` has it). */
export interface ExtraImages {
  segments: readonly ({ kind: 'text'; text: string } | { kind: 'image' } | { kind: 'file' })[];
  images: readonly { n: number }[];
}

const bareMarkers = (text: string): Map<number, number> => {
  const out = new Map<number, number>();
  for (const m of text.matchAll(PATHLESS_IMAGE)) out.set(Number(m[1]), (out.get(Number(m[1])) ?? 0) + 1);
  return out;
};

/**
 * The generated prompt names an image of the Extra instructions by a bare `[Image #n]` (the upload is on its way, or
 * has failed, or has just finished and the prompt is not yet made again). The First prompt is read-only then: an edit
 * would freeze that marker, without the path the orchestrator needs, into a prompt that overrides the one the bridge
 * composes. It opens again when the preview carries the path or the image is gone. Only an image of the Extra counts:
 * a marker-shaped sentence the user typed in the Extra instructions is prose (the draft says which is which), so a
 * bare marker locks only where the preview holds more of that number than the Extra's own prose does, and the Extra
 * has an image with that number. A custom prompt never locks: it has no bare marker of the Extra's (its own images
 * are chips).
 */
export function previewLocked(p: Preview, extra: ExtraImages): boolean {
  if (p.custom || extra.images.length === 0) return false;
  const prose = bareMarkers(extra.segments.map((g) => (g.kind === 'text' ? g.text : '')).join(''));
  for (const [n, count] of bareMarkers(p.text)) if (n <= extra.images.length && count > (prose.get(n) ?? 0)) return true;
  return false;
}

/** Custom, and the fields now generate something else. */
export function previewStale(p: Preview): boolean {
  return p.custom && p.text !== p.generated;
}

/** `run.start`'s `prompt`: only a custom one (otherwise the bridge composes it). */
export function previewArg(p: Preview): string | undefined {
  return p.custom ? p.text : undefined;
}

// ---- the form ---------------------------------------------------------------------------

export interface RunForm {
  ticket: string;
  desk: number;
  /** '' until the first prepare says which one is the default. */
  preset: string;
  orch: Hire | null;
  extra: string;
  worktree: boolean;
  /** '' = the generated label (`run.prepare`'s). */
  label: string;
  /** M7: the card the run starts on (the ticket input then shows it instead of a text box). */
  workItem: WorkItemRef | null;
}

/** `run.prepare` args for the form as it is. */
export function prepareArgs(floor: string, f: RunForm, t: TicketInput): CommandArgs['run.prepare'] {
  const a: CommandArgs['run.prepare'] = { floor, ...ticketArgs(t) };
  if (f.preset) a.preset = f.preset;
  if (f.orch) a.orch = { ...f.orch };
  const extra = f.extra.trim();
  if (extra && bytes(f.extra) <= EXTRA_MAX) a.extra = f.extra;
  return a;
}

/** Why Start is off (null: it can be pressed); `desk` and capacity are checked by the dialog. */
export function startBlocker(f: RunForm, t: TicketInput, p: Preview, options: HireOptions, book: PresetBook): string | null {
  if (t.kind === 'empty') return 'Say what to work on: an issue number, an issue URL or free text.';
  if (t.why) return t.why;
  if (!book.get(f.preset)) return book.list().length ? 'Choose a team preset.' : 'There is no team preset yet: create one first.';
  const o = f.orch;
  if (!o || !options[o.harness]) return 'Choose the orchestrator’s harness.';
  if (!modelsFor(options, o.harness).includes(o.model)) return 'Choose the orchestrator’s model.';
  if (!effortsFor(options, o.harness, o.model).includes(o.effort)) return 'Choose the orchestrator’s effort.';
  if (bytes(f.extra) > EXTRA_MAX) return `Extra instructions are at most ${EXTRA_MAX} bytes.`;
  const label = f.label.trim();
  if (bytes(label) > 64) return 'The label is at most 64 bytes.';
  if (label.startsWith('-')) return 'The label can’t start with “-”.';
  if (p.custom) {
    if (!p.text.trim()) return 'The prompt is empty: type one, or reset it to the generated one.';
    if (p.text.trim().startsWith('--')) return 'The prompt can’t start with “--” (herdr would read it as a flag).';
  }
  return null;
}

/** `run.start` args: the label only when typed, the worktree only when the folder is a repo, the prompt only when custom. */
export function startArgs(floor: string, f: RunForm, t: TicketInput, p: Preview, prep: RunPrepare | null, worktreeOk: boolean): CommandArgs['run.start'] {
  const a: CommandArgs['run.start'] = { floor, desk_index: f.desk, ...ticketArgs(t), orch: { ...(f.orch as Hire) }, preset: f.preset };
  if (f.extra.trim()) a.extra = f.extra;
  a.worktree = !!prep?.git && f.worktree && worktreeOk;
  const label = f.label.trim();
  if (label) a.label = label;
  const prompt = previewArg(p);
  if (prompt !== undefined) a.prompt = prompt;
  return a;
}

// ---- presets ------------------------------------------------------------------------------

/** "claude · Opus 5.5 · medium": the model by its readable name (#200) when `options` has one. */
export const hireLine = (h: Hire, options: HireOptions = {}) => `${h.harness} · ${modelLabel(h.harness, h.model, labelsOf(options, h.harness))} · ${h.effort}`;

/** One line per role for a preset's row in the list. */
export function presetLines(p: Preset, options: HireOptions = {}, profiles: CodexProfilesState | null = null): Array<{ role: string; line: string }> {
  return PRESET_ROLES.map((r) => {
    const profile = roleProfileLabel(profiles, p.roles[r]); // #167
    return { role: ROLE_LABEL[r], line: hireLine(p.roles[r], options) + (profile ? ` · ${profile}` : '') };
  });
}

export interface PresetDraft {
  name: string;
  roles: PresetRoles;
}

const sameHire = (a: Hire, b: Hire) => a.harness === b.harness && a.model === b.model && a.effort === b.effort && (a.codex_profile ?? '') === (b.codex_profile ?? '');
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Why a draft cannot be saved (null: it can); `except` is the preset being edited. */
export function presetBlocker(d: PresetDraft, options: HireOptions, book: PresetBook, except = ''): { field: 'name' | 'roles'; why: string } | null {
  const name = d.name.trim();
  if (!name) return { field: 'name', why: 'Give the preset a name.' };
  if (bytes(name) > 40) return { field: 'name', why: 'The name is at most 40 bytes.' };
  if (CONTROL.test(name)) return { field: 'name', why: 'The name can’t hold control characters.' };
  if (book.nameTaken(name, except)) return { field: 'name', why: `Another preset is already called “${name}”.` };
  for (const r of PRESET_ROLES) {
    const h = d.roles[r];
    const ok = !!options[h.harness] && modelsFor(options, h.harness).includes(h.model) && effortsFor(options, h.harness, h.model).includes(h.effort);
    if (!ok) return { field: 'roles', why: `Choose a harness, model and effort the bridge offers for ${ROLE_LABEL[r].toLowerCase()}.` };
  }
  return null;
}

/** `preset.update` args with only what changed (null: nothing did). */
export function presetPatch(p: Preset, d: PresetDraft): CommandArgs['preset.update'] | null {
  const a: CommandArgs['preset.update'] = { id: p.id };
  const name = d.name.trim();
  if (name !== p.name) a.name = name;
  if (!PRESET_ROLES.every((r) => sameHire(p.roles[r], d.roles[r]))) a.roles = structuredClone(d.roles);
  return a.name === undefined && a.roles === undefined ? null : a;
}

/** "Build team 2" for a copy of "Build team", the first name nobody has. */
export function freshName(base: string, book: PresetBook): string {
  const b = base.trim() || 'New team';
  for (let k = 2; ; k++) {
    const n = `${b} ${k}`;
    if (!book.nameTaken(n) && bytes(n) <= 40) return n;
    if (bytes(n) > 40) return freshName('New team', book);
  }
}
