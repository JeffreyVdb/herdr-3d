/**
 * Floor settings (M3): the settings panel's form, its validation (the rules of
 * `floor.settings.set`) and the patch it sends: only changed keys, `null` to
 * clear. Every key stands alone (the status field needs no project). Pure, so
 * it is covered by vitest.
 */

import type { FloorSettings, FloorSuggested, GithubProject, Hire, HireOptions, SettingsPatch, StatusField, Tracker } from '../net/protocol';

/**
 * A status row: the text in its input, and the stored label the row was
 * opened with (null for a row added in the panel or a pre-filled default).
 * The row keeps that label wherever it moves, so twins that look the same in
 * their inputs stay apart.
 */
export interface StatusRow {
  text: string;
  stored: string | null;
}

/** The panel's inputs, as typed. */
export interface SettingsForm {
  repo: string;
  projectOwner: string;
  projectNumber: string;
  statusName: string;
  /** One status per row, in board order; blank rows do not count. */
  statusOptions: StatusRow[];
  defaultCwd: string;
  /** '' = no default hire. */
  harness: string;
  model: string;
  effort: string;
  /** #184: the floor's issue tracker, and its Kaneo workspace and project ids ('' = none chosen). */
  tracker: Tracker;
  kaneoWorkspace: string;
  kaneoProject: string;
}

export type FieldKey = keyof SettingsForm;

/** What the form asks for, key by key (`null` = not set). */
export interface SettingsValue {
  repo: string | null;
  project: GithubProject | null;
  status_field: StatusField | null;
  default_cwd: string | null;
  default_hire: Hire | null;
  tracker: Tracker;
  kaneo: { workspace_id: string; project_id: string } | null;
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
  kaneoDefault: string | null = null,
): { form: SettingsForm; repoSuggested: boolean; statusDefault: boolean; cwdPlaceholder: string } {
  const stored = settings.status_field;
  const status = stored ?? DEFAULT_STATUS_FIELD;
  const hire = settings.default_hire;
  return {
    form: {
      repo: settings.repo ?? suggested.repo ?? '',
      projectOwner: settings.project?.owner ?? '',
      projectNumber: settings.project ? String(settings.project.number) : '',
      statusName: status.name,
      statusOptions: status.options.map((o) => ({ text: o, stored: stored ? o : null })),
      defaultCwd: settings.default_cwd ?? '',
      harness: hire?.harness ?? '',
      model: hire?.model ?? '',
      effort: hire?.effort ?? '',
      // #184: a floor without a Kaneo link starts from the bridge's default workspace; a linked one keeps its own.
      tracker: settings.tracker === 'kaneo' ? 'kaneo' : 'github',
      kaneoWorkspace: settings.kaneo?.workspace_id ?? kaneoDefault ?? '',
      kaneoProject: settings.kaneo?.project_id ?? '',
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

/** A label as a text input shows it: without line breaks. */
const shown = (s: string) => s.replace(/[\r\n]/g, '');

/** The stored label while its input still shows it as opened; else the text as typed, trimmed. */
const kept = (text: string, stored: string | null | undefined) => (stored != null && shown(text) === shown(stored) ? stored : text.trim());

/**
 * Validates the form like the bridge does; `errors` is keyed by input and
 * `badOption` is the status row to fix. A status row (or the field name) still
 * showing the stored label it was opened with comes back exactly as stored
 * (the bridge accepts spaces around a label, commas, even line breaks), so
 * saving never rewrites statuses nobody touched; any edit is read trimmed.
 */
export function parseForm(
  f: SettingsForm,
  hire: HireOptions,
  stored: FloorSettings = {},
): { value: SettingsValue; errors: Partial<Record<FieldKey, string>>; badOption: number | null } {
  const errors: Partial<Record<FieldKey, string>> = {};
  const value: SettingsValue = { repo: null, project: null, status_field: null, default_cwd: null, default_hire: null, tracker: f.tracker, kaneo: null };
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
  const picked = f.statusOptions.flatMap((r, i) => (r.text.trim() ? [{ i, label: kept(r.text, r.stored) }] : []));
  if (f.statusName.trim() || picked.length) {
    const name = kept(f.statusName, stored.status_field?.name);
    if (!name) errors.statusName = 'Name the status field, e.g. Status.';
    else if (bytes(name) > MAX_TEXT) errors.statusName = `Keep the field name within ${MAX_TEXT} bytes.`;
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
  // #184: a Kaneo floor needs its workspace and project. On a GitHub floor an unfinished pick keeps the stored link.
  const stored184 = stored.kaneo ? { workspace_id: stored.kaneo.workspace_id, project_id: stored.kaneo.project_id } : null;
  if (f.kaneoWorkspace && f.kaneoProject) value.kaneo = { workspace_id: f.kaneoWorkspace, project_id: f.kaneoProject };
  else if (f.tracker === 'kaneo') {
    if (!f.kaneoWorkspace) errors.kaneoWorkspace = 'Choose the Kaneo workspace.';
    errors.kaneoProject = 'Choose the project whose tasks this floor shows.';
  } else value.kaneo = stored184;
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
  // #184: absent tracker is GitHub; the Kaneo link compares by its ids (the names are the bridge's).
  if ((stored.tracker ?? 'github') !== want.tracker) patch.tracker = want.tracker === 'kaneo' ? 'kaneo' : null;
  const have = stored.kaneo ? { workspace_id: stored.kaneo.workspace_id, project_id: stored.kaneo.project_id } : null;
  if (!same(have, want.kaneo)) patch.kaneo = want.kaneo;
  return patch as SettingsPatch;
}
