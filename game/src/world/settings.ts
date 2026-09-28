/**
 * Floor settings (M3): the settings panel's form, its validation (the rules of
 * `floor.settings.set`) and the patch it sends: only changed keys, `null` to
 * clear. Every key stands alone (the status field needs no project). Pure, so
 * it is covered by vitest.
 */

import type { FloorSettings, FloorSuggested, GithubProject, Hire, HireOptions, SettingsPatch, StatusField } from '../net/protocol';

/** The panel's inputs, as typed. */
export interface SettingsForm {
  repo: string;
  projectOwner: string;
  projectNumber: string;
  statusName: string;
  /** One status per row, in board order; blank rows do not count. */
  statusOptions: string[];
  defaultCwd: string;
  /** '' = no default hire. */
  harness: string;
  model: string;
  effort: string;
}

export type FieldKey = keyof SettingsForm;

/** What the form asks for, key by key (`null` = not set). */
export interface SettingsValue {
  repo: string | null;
  project: GithubProject | null;
  status_field: StatusField | null;
  default_cwd: string | null;
  default_hire: Hire | null;
}

export const DEFAULT_STATUS_FIELD: StatusField = { name: 'Status', options: ['Todo', 'Doing', 'QA', 'Done'] };

const OWNER = /^[A-Za-z0-9-]{1,39}$/;
const REPO = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;
const MAX_TEXT = 64;
const MAX_OPTIONS = 20;

const bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * The form for stored settings: the repo falls back to the bridge's
 * suggestion, the status field to the default (what a floor without one uses).
 */
export function formFrom(
  settings: FloorSettings,
  suggested: FloorSuggested,
): { form: SettingsForm; repoSuggested: boolean; statusDefault: boolean; cwdPlaceholder: string } {
  const status = settings.status_field ?? DEFAULT_STATUS_FIELD;
  const hire = settings.default_hire;
  return {
    form: {
      repo: settings.repo ?? suggested.repo ?? '',
      projectOwner: settings.project?.owner ?? '',
      projectNumber: settings.project ? String(settings.project.number) : '',
      statusName: status.name,
      statusOptions: [...status.options],
      defaultCwd: settings.default_cwd ?? '',
      harness: hire?.harness ?? '',
      model: hire?.model ?? '',
      effort: hire?.effort ?? '',
    },
    repoSuggested: !settings.repo && !!suggested.repo,
    statusDefault: !settings.status_field,
    cwdPlaceholder: suggested.default_cwd ?? '',
  };
}

/** `owner/repo`, also from a pasted GitHub https or ssh URL; null when it is none of those. */
export function normalizeRepo(input: string): string | null {
  let s = input.trim();
  const url = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(.+?)(?:\.git)?\/?$/.exec(s);
  if (url?.[1]) s = url[1];
  return REPO.test(s) ? s : null;
}

/** Efforts a model takes: its harness's, plus the model's extra ones. */
export function effortsFor(o: HireOptions, harness: string, model: string): string[] {
  const h = o[harness];
  if (!h) return [];
  return [...h.efforts, ...(h.extra_efforts?.[model] ?? []).filter((e) => !h.efforts.includes(e))];
}

/** A label as a text input shows it: without line breaks, trimmed. */
const shown = (s: string) => s.replace(/[\r\n]/g, '').trim();

/**
 * Validates the form like the bridge does; `errors` is keyed by input and
 * `badOption` is the status row to fix. A status label whose row still shows
 * a stored label comes back exactly as stored (the bridge accepts spaces
 * around a label, commas, even line breaks), so saving never rewrites
 * statuses nobody touched; edited labels are trimmed.
 */
export function parseForm(
  f: SettingsForm,
  hire: HireOptions,
  stored: FloorSettings = {},
): { value: SettingsValue; errors: Partial<Record<FieldKey, string>>; badOption: number | null } {
  const errors: Partial<Record<FieldKey, string>> = {};
  const value: SettingsValue = { repo: null, project: null, status_field: null, default_cwd: null, default_hire: null };
  let badOption: number | null = null;

  if (f.repo.trim()) {
    const r = normalizeRepo(f.repo);
    if (r) value.repo = r;
    else errors.repo = 'Use owner/repo, e.g. JeffreyVdb/herdr-3d.';
  }

  const owner = f.projectOwner.trim();
  const num = f.projectNumber.trim();
  if (owner || num) {
    if (!owner) errors.projectOwner = 'Add the owner of the project (a user or an organization).';
    else if (!OWNER.test(owner)) errors.projectOwner = 'A GitHub owner is 1–39 letters, digits or dashes.';
    const n = Number(num);
    if (!num) errors.projectNumber = 'Add the project number (from its URL: …/projects/3).';
    else if (!/^\d+$/.test(num) || !Number.isSafeInteger(n) || n < 1) errors.projectNumber = 'The project number is a whole number from 1.';
    if (!errors.projectOwner && !errors.projectNumber) value.project = { owner, number: n };
  }

  // The status field: an empty name and no statuses = none.
  const rows = f.statusOptions.map((o, i) => ({ text: o.trim(), i })).filter((r) => r.text);
  if (f.statusName.trim() || rows.length) {
    const was = stored.status_field;
    const name = was && shown(was.name) === f.statusName.trim() ? was.name : f.statusName.trim();
    if (!name) errors.statusName = 'Name the status field, e.g. Status.';
    else if (bytes(name) > MAX_TEXT) errors.statusName = `Keep the field name within ${MAX_TEXT} bytes.`;
    // Each stored label backs at most one row (twins that differ by a space stay two).
    const free = [...(was?.options ?? [])];
    const picked = rows.map((r) => {
      const k = free.findIndex((o) => shown(o) === r.text);
      return { i: r.i, label: (k < 0 ? undefined : free.splice(k, 1)[0]) ?? r.text };
    });
    const options = picked.map((p) => p.label);
    const seen = new Set<string>();
    const twice = picked.find((p) => (seen.has(p.label) ? true : (seen.add(p.label), false)));
    const long = picked.find((p) => bytes(p.label) > MAX_TEXT);
    const over = picked[MAX_OPTIONS];
    if (!options.length) errors.statusOptions = 'Add at least one status. To remove the status field, empty its name too.';
    else if (over) errors.statusOptions = `Use at most ${MAX_OPTIONS} statuses.`;
    else if (long) errors.statusOptions = `Keep each status within ${MAX_TEXT} bytes.`;
    else if (twice) errors.statusOptions = `“${twice.label}” is listed twice.`;
    badOption = (over ?? long ?? twice)?.i ?? null;
    if (!errors.statusName && !errors.statusOptions) value.status_field = { name, options };
  }

  const cwd = f.defaultCwd.trim();
  if (cwd) {
    if (!cwd.startsWith('/')) errors.defaultCwd = 'Use an absolute path on the server, e.g. /home/dev/devel/herdr-3d.';
    else value.default_cwd = cwd;
  }

  if (f.harness) {
    const h = hire[f.harness];
    if (!h) errors.harness = `${f.harness} is not a harness this bridge can hire.`;
    else {
      if (!h.models.includes(f.model)) errors.model = f.model ? `${f.harness} has no model ${f.model}.` : 'Choose a model.';
      const efforts = effortsFor(hire, f.harness, f.model);
      if (!errors.model && !efforts.includes(f.effort)) errors.effort = f.effort ? `${f.model} does not take effort ${f.effort}.` : 'Choose an effort.';
      else if (errors.model && !f.effort) errors.effort = 'Choose an effort.';
      if (!errors.model && !errors.effort) value.default_hire = { harness: f.harness, model: f.model, effort: f.effort };
    }
  }
  return { value, errors, badOption };
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.length === kb.length && ka.every((k) => same(ra[k], rb[k]));
}

const KEYS = ['repo', 'project', 'status_field', 'default_cwd', 'default_hire'] as const;

/**
 * `floor.settings.set` args (minus `session`): the keys that differ from what
 * is stored. The pre-filled default status field is what a floor without one
 * uses already, so it is only sent once it differs from the default.
 */
export function settingsPatch(stored: FloorSettings, want: SettingsValue): SettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const k of KEYS) {
    const have = stored[k] ?? null;
    if (same(have, want[k])) continue;
    if (k === 'status_field' && have === null && same(want[k], DEFAULT_STATUS_FIELD)) continue;
    patch[k] = want[k];
  }
  return patch as SettingsPatch;
}
