import { describe, expect, it } from 'vitest';
import type { Preset, RunPrepare } from '../net/protocol';
import { PresetBook, presetOf } from './presets';
import {
  emptyPreview,
  freshName,
  parseTicket,
  prepareArgs,
  presetBlocker,
  presetPatch,
  previewArg,
  previewEdited,
  previewGenerated,
  previewReset,
  previewStale,
  startArgs,
  startBlocker,
  ticketArgs,
  ticketLine,
  type RunForm,
} from './startRun';
import { DEFAULT_HIRE_OPTIONS } from './store';

const H = DEFAULT_HIRE_OPTIONS;
const opus = { harness: 'claude', model: 'claude-opus-5-5', effort: 'medium' };
const sol = (effort: string) => ({ harness: 'codex', model: 'gpt-6-sol', effort });
const BUILD: Preset = { id: 'p_5eedb0000001', name: 'Build team', seeded: true, roles: { orch: opus, coder: opus, reviewer: sol('high'), ux: sol('high'), researcher: sol('low') } };

const book = (...ps: Preset[]) => {
  const b = new PresetBook();
  b.reset(ps);
  return b;
};
const form = (over: Partial<RunForm> = {}): RunForm => ({ ticket: '3', desk: 4, preset: BUILD.id, orch: { ...opus }, extra: '', worktree: true, label: '', ...over });

describe('parseTicket', () => {
  it('reads a bare number or #n as an issue of the floor’s repo', () => {
    for (const v of ['3', '#3', '  #3 \n']) {
      expect(parseTicket(v, 'JeffreyVdb/lab')).toEqual({ kind: 'issue', number: 3, repo: 'JeffreyVdb/lab', url: 'https://github.com/JeffreyVdb/lab/issues/3', from: 'number', arg: 3, why: null });
    }
  });

  it('needs a linked repo for a bare number', () => {
    const t = parseTicket('#12', null);
    expect(t).toMatchObject({ kind: 'issue', number: 12, repo: null, url: null });
    expect(t.kind === 'issue' && t.why).toMatch(/no linked repo/);
    expect(ticketArgs(t)).toEqual({});
  });

  it('reads an issue URL with its own repo, normalised', () => {
    for (const v of ['https://github.com/fomra/depot-manager/issues/41', 'https://github.com/fomra/depot-manager/issues/41/', 'https://github.com/fomra/depot-manager/issues/41#issuecomment-9']) {
      const t = parseTicket(v, 'JeffreyVdb/lab');
      expect(t).toEqual({ kind: 'issue', number: 41, repo: 'fomra/depot-manager', url: 'https://github.com/fomra/depot-manager/issues/41', from: 'url', arg: 'https://github.com/fomra/depot-manager/issues/41', why: null });
      expect(ticketArgs(t)).toEqual({ issue: 'https://github.com/fomra/depot-manager/issues/41' });
    }
  });

  it('takes anything else as free text, trimmed, lines kept', () => {
    const t = parseTicket('  Add a dark mode\nto the settings  ', 'x/y');
    expect(t).toEqual({ kind: 'text', text: 'Add a dark mode\nto the settings', why: null });
    expect(ticketArgs(t)).toEqual({ text: 'Add a dark mode\nto the settings' });
    expect(ticketLine(t)).toBe('Free text · 7 words');
    // A pull request URL, "3 bugs", issue 0: text, not an issue.
    expect(parseTicket('https://github.com/a/b/pull/3', 'x/y').kind).toBe('text');
    expect(parseTicket('3 bugs', 'x/y').kind).toBe('text');
    expect(parseTicket('#0', 'x/y')).toMatchObject({ kind: 'text', why: 'Issue numbers start at 1.' });
  });

  it('refuses text over 4096 bytes and says nothing for an empty input', () => {
    expect(parseTicket('é'.repeat(2049), null)).toMatchObject({ kind: 'text', why: 'The ticket text is at most 4096 bytes.' });
    expect(parseTicket(' \n ', null)).toEqual({ kind: 'empty' });
    expect(ticketArgs({ kind: 'empty' })).toEqual({});
    expect(ticketLine(parseTicket('#3', 'JeffreyVdb/lab'))).toBe('Issue #3 · JeffreyVdb/lab');
  });
});

describe('the prompt preview', () => {
  it('follows the generated prompt until edited', () => {
    let p = previewGenerated(emptyPreview(), 'A');
    expect(p).toEqual({ generated: 'A', text: 'A', custom: false });
    p = previewGenerated(p, 'B');
    expect(p.text).toBe('B');
    expect(previewArg(p)).toBeUndefined();
  });

  it('keeps a custom edit through later field changes, flags it stale, resets on demand', () => {
    let p = previewGenerated(emptyPreview(), 'A');
    p = previewEdited(p, 'A, but careful');
    expect(p).toEqual({ generated: 'A', text: 'A, but careful', custom: true });
    expect(previewStale(p)).toBe(true);
    p = previewGenerated(p, 'B');
    expect(p).toEqual({ generated: 'B', text: 'A, but careful', custom: true });
    expect(previewArg(p)).toBe('A, but careful');
    p = previewReset(p);
    expect(p).toEqual({ generated: 'B', text: 'B', custom: false });
    expect(previewStale(p)).toBe(false);
  });

  it('is generated again when edited back to the generated prompt', () => {
    let p = previewEdited(previewGenerated(emptyPreview(), 'A'), 'Ax');
    p = previewEdited(p, 'A');
    expect(p.custom).toBe(false);
    expect(previewGenerated(p, 'C').text).toBe('C');
  });
});

describe('run args and blockers', () => {
  const b = book(BUILD);
  const t = parseTicket('3', 'JeffreyVdb/lab');
  const prep = { git: { repo_root: '/r', default_branch: 'main', base_sha: 'abc', base_time: 0, fetched: true } } as unknown as RunPrepare;

  it('prepare sends the ticket, the preset and orch once known, and extra', () => {
    expect(prepareArgs('lab', form({ preset: '', orch: null }), parseTicket('', null))).toEqual({ session: 'lab' });
    expect(prepareArgs('lab', form({ extra: 'Keep it small' }), t)).toEqual({ session: 'lab', issue: 3, preset: BUILD.id, orch: opus, extra: 'Keep it small' });
  });

  it('start sends a prompt only when custom, a label only when typed', () => {
    const gen = previewGenerated(emptyPreview(), '/write-code …');
    expect(startArgs('lab', form(), t, gen, prep, true)).toEqual({ session: 'lab', desk_index: 4, issue: 3, orch: opus, preset: BUILD.id, worktree: true });
    const custom = previewEdited(gen, '/write-code … and more');
    expect(startArgs('lab', form({ label: ' ORCH|lab ', worktree: false }), parseTicket('Make it purple', null), custom, prep, true)).toEqual({
      session: 'lab',
      desk_index: 4,
      text: 'Make it purple',
      orch: opus,
      preset: BUILD.id,
      worktree: false,
      label: 'ORCH|lab',
      prompt: '/write-code … and more',
    });
    // No worktree when origin could not be fetched, or the folder is no repo.
    expect(startArgs('lab', form(), t, gen, prep, false).worktree).toBe(false);
    expect(startArgs('lab', form(), t, gen, { ...prep, git: null }, true).worktree).toBe(false);
  });

  it('blocks Start with a reason', () => {
    const p = previewGenerated(emptyPreview(), 'x');
    expect(startBlocker(form(), t, p, H, b)).toBeNull();
    expect(startBlocker(form(), parseTicket('', null), p, H, b)).toMatch(/^Say what to work on/);
    expect(startBlocker(form(), parseTicket('3', null), p, H, b)).toMatch(/no linked repo/);
    expect(startBlocker(form({ preset: 'p_gone' }), t, p, H, b)).toBe('Choose a team preset.');
    expect(startBlocker(form({ preset: '' }), t, p, H, book())).toBe('There is no team preset yet: create one first.');
    expect(startBlocker(form({ orch: { ...opus, model: 'gpt-6-sol' } }), t, p, H, b)).toBe('Choose the orchestrator’s model.');
    expect(startBlocker(form({ orch: sol('ultra') }), t, p, H, b)).toBeNull();
    expect(startBlocker(form({ orch: { ...opus, effort: 'ultra' } }), t, p, H, b)).toBe('Choose the orchestrator’s effort.');
    expect(startBlocker(form({ extra: 'x'.repeat(8193) }), t, p, H, b)).toBe('Extra instructions are at most 8192 bytes.');
    expect(startBlocker(form({ label: '-x' }), t, p, H, b)).toBe('The label can’t start with “-”.');
    expect(startBlocker(form(), t, previewEdited(p, '  '), H, b)).toMatch(/^The prompt is empty/);
    expect(startBlocker(form(), t, previewEdited(p, '--help'), H, b)).toMatch(/can’t start with “--”/);
  });
});

describe('presets', () => {
  it('keeps well-formed presets by name, knows an older bridge by the missing list', () => {
    const b = new PresetBook();
    b.reset(undefined);
    expect(b.known).toBe(false);
    b.reset([{ ...BUILD, name: 'zeta' }, { id: 'p_2', name: 'Alpha', roles: BUILD.roles }, { id: 'p_bad', name: 'Bad', roles: { orch: opus } }]);
    expect(b.known).toBe(true);
    expect(b.list().map((p) => p.name)).toEqual(['Alpha', 'zeta']);
    expect(b.nameTaken('ALPHA')).toBe(true);
    expect(b.nameTaken('alpha', 'p_2')).toBe(false);
    expect(presetOf({ id: 'p', name: 'n', roles: BUILD.roles, extra: 1 })).toEqual({ id: 'p', name: 'n', roles: BUILD.roles });
  });

  it('defaults to the floor’s last preset, else Build team, else the first', () => {
    const other: Preset = { ...BUILD, id: 'p_a', name: 'Aardvark', seeded: false };
    const b = book(BUILD, other);
    expect(b.defaultFor('p_a')?.id).toBe('p_a');
    expect(b.defaultFor('p_gone')?.id).toBe(BUILD.id);
    b.remove(BUILD.id);
    expect(b.defaultFor(undefined)?.id).toBe('p_a');
  });

  it('validates a draft like the bridge', () => {
    const b = book(BUILD);
    const roles = structuredClone(BUILD.roles);
    expect(presetBlocker({ name: 'Solo', roles }, H, b)).toBeNull();
    expect(presetBlocker({ name: ' ', roles }, H, b)).toEqual({ field: 'name', why: 'Give the preset a name.' });
    expect(presetBlocker({ name: 'build TEAM', roles }, H, b)).toEqual({ field: 'name', why: 'Another preset is already called “build TEAM”.' });
    expect(presetBlocker({ name: 'Build team', roles }, H, b, BUILD.id)).toBeNull();
    expect(presetBlocker({ name: 'x'.repeat(41), roles }, H, b)?.why).toBe('The name is at most 40 bytes.');
    expect(presetBlocker({ name: 'tab\there', roles }, H, b)?.field).toBe('name');
    expect(presetBlocker({ name: 'Solo', roles: { ...roles, ux: { harness: 'codex', model: 'claude-opus-5-5', effort: 'high' } } }, H, b)).toEqual({ field: 'roles', why: 'Choose a harness, model and effort the bridge offers for ux reviewers.' });
  });

  it('patches only what changed; roles replace all five', () => {
    const roles = structuredClone(BUILD.roles);
    expect(presetPatch(BUILD, { name: 'Build team ', roles })).toBeNull();
    expect(presetPatch(BUILD, { name: 'Ship team', roles })).toEqual({ id: BUILD.id, name: 'Ship team' });
    roles.reviewer.effort = 'xhigh';
    expect(presetPatch(BUILD, { name: 'Build team', roles })).toEqual({ id: BUILD.id, roles });
  });

  it('names a copy after the first free number', () => {
    const b = book(BUILD, { ...BUILD, id: 'p_2', name: 'Build team 2' });
    expect(freshName('Build team', b)).toBe('Build team 3');
  });
});
