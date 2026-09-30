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
  previewLocked,
  previewReset,
  previewStale,
  startArgs,
  startBlocker,
  ticketArgs,
  ticketLine,
  type RunForm,
} from './startRun';
import { Draft } from '../ui/composer/draft';
import { markedText } from '../ui/composer/field';
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
const form = (over: Partial<RunForm> = {}): RunForm => ({ ticket: '3', desk: 4, preset: BUILD.id, orch: { ...opus }, extra: '', worktree: true, label: '', workItem: null, ...over });

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

describe('an image of the Extra instructions that has no path yet (#64)', () => {
  const shot = () => new File([new Uint8Array(4).fill(1)], 'shot.png', { type: 'image/png' });
  const extraDraft = (upload: (f: File, h: string, s: AbortSignal) => Promise<unknown> = () => new Promise(() => {})) =>
    new Draft({ upload: upload as never, createUrl: () => '', revokeUrl: () => {} });
  /** What the bridge makes of the Extra's text: a task line, then the text as the field serialises it. */
  const generated = (d: Draft) => previewGenerated(emptyPreview(), `/write-code task\n\n${markedText(d.snapshot())}`);

  it('locks the First prompt while the generated text carries the bare marker of a pending image, and opens it when the path is there', async () => {
    let finish!: (r: { ok: true; data: { path: string } }) => void;
    const extra = extraDraft(() => new Promise((r) => (finish = r as typeof finish)));
    extra.addImages([shot()]);
    await Promise.resolve();
    let p = generated(extra);
    expect(p.text).toContain('[Image #1]');
    expect(previewLocked(p, extra.snapshot())).toBe(true);
    // The upload finishes: until the prompt is made again the old one still has the bare marker, so it stays locked.
    finish({ ok: true, data: { path: '/drops/shot.png' } });
    await extra.resolve();
    expect(previewLocked(p, extra.snapshot())).toBe(true);
    p = previewGenerated(p, `/write-code task\n\n${markedText(extra.snapshot())}`);
    expect(p.text).toContain('[Image #1: /drops/shot.png]');
    expect(previewLocked(p, extra.snapshot())).toBe(false);
  });

  it('a failed image keeps it locked until the image is retried (path) or removed (the next prompt has no marker)', async () => {
    let answer: (r: unknown) => void = () => {};
    const extra = extraDraft(() => new Promise((r) => (answer = r)));
    extra.addImages([shot()]);
    await Promise.resolve();
    answer({ ok: false, code: 'internal', message: 'drop zone down' });
    await extra.resolve();
    expect(extra.snapshot().images[0]?.status).toBe('error');
    let p = generated(extra);
    expect(p.text).toContain('[Image #1]');
    expect(previewLocked(p, extra.snapshot())).toBe(true);
    extra.removeImage(extra.snapshot().images[0]!.occ);
    p = generated(extra);
    expect(previewLocked(p, extra.snapshot())).toBe(false);
  });

  it('a marker-shaped sentence typed in the Extra, with no image attached, never locks', () => {
    const extra = extraDraft();
    extra.replace(0, 0, 'Keep the literal label [Image #1] in the docs.');
    const p = generated(extra);
    expect(p.text).toContain('[Image #1]');
    expect(previewLocked(p, extra.snapshot())).toBe(false);
    expect(previewArg(p)).toBeUndefined();
  });

  it('literal prose next to a real pending image: the image locks it, and the same number in the prose does not hide or double it', async () => {
    const extra = extraDraft();
    extra.replace(0, 0, 'Keep the label [Image #1] in the docs. ');
    extra.addImages([shot()]);
    await Promise.resolve();
    const p = generated(extra);
    expect(p.text.match(/\[Image #1\]/g)).toHaveLength(2); // the prose and the chip collide on the number
    expect(previewLocked(p, extra.snapshot())).toBe(true);
    // A prose number with no image of that number beside a real pending image #1.
    const other = extraDraft();
    other.replace(0, 0, 'see [Image #2] ');
    other.addImages([shot()]);
    expect(previewLocked(generated(other), other.snapshot())).toBe(true);
  });

  it('prose that collides with the number of an uploaded image does not lock', async () => {
    const extra = extraDraft(() => Promise.resolve({ ok: true, data: { path: '/drops/a.png' } }));
    extra.replace(0, 0, 'Keep the label [Image #1] in the docs. ');
    extra.addImages([shot()]);
    await extra.resolve();
    const p = generated(extra);
    expect(p.text).toContain('[Image #1: /drops/a.png]');
    expect(p.text).toContain('the label [Image #1] in');
    expect(previewLocked(p, extra.snapshot())).toBe(false);
  });

  it('with the lock in force the edit that would freeze a pathless marker cannot happen: the prompt sent is the bridge\'s', () => {
    const p = previewGenerated(emptyPreview(), 'task\n\n[Image #1]');
    expect(previewLocked(p, { segments: [{ kind: 'image' }], images: [{ n: 1 }] })).toBe(true);
    expect(previewArg(p)).toBeUndefined(); // generated: run.start carries no prompt, the bridge composes it from the resolved extra
  });

  it('an edited prompt, a prompt with path markers and a prompt with no image are never locked', () => {
    const one = { segments: [{ kind: 'image' }], images: [{ n: 1 }] } as const;
    expect(previewLocked(previewEdited(previewGenerated(emptyPreview(), 'a'), 'a, edited'), one)).toBe(false);
    expect(previewLocked(previewEdited(previewGenerated(emptyPreview(), 'a [Image #1]'), 'a [Image #1], edited'), one)).toBe(false);
    expect(previewLocked(previewGenerated(emptyPreview(), 'a [Image #1: /drops/a.png]'), one)).toBe(false);
    expect(previewLocked(previewGenerated(emptyPreview(), 'plain'), one)).toBe(false);
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

describe('the store and presets', () => {
  it('takes presets from the snapshot and follows preset.upsert / preset.removed', async () => {
    const { WorldStore } = await import('./store');
    const s = new WorldStore(0);
    s.applySnapshot({ t: 'world.snapshot', seq: 1, world: { buildings: [], unassigned: [], floors: [], workers: [], presets: [BUILD] } });
    expect(s.presets.known).toBe(true);
    const v = s.presets.version;
    s.applyEvent({ t: 'preset.upsert', seq: 2, preset: { ...BUILD, id: 'p_2', name: 'Another' } });
    expect(s.presets.list().map((p) => p.name)).toEqual(['Another', 'Build team']);
    s.applyEvent({ t: 'preset.removed', seq: 3, id: BUILD.id });
    expect(s.presets.list().map((p) => p.id)).toEqual(['p_2']);
    expect(s.presets.version).toBeGreaterThan(v);
    // An older bridge's snapshot has no presets.
    s.applySnapshot({ t: 'world.snapshot', seq: 4, world: { buildings: [], unassigned: [], floors: [], workers: [] } });
    expect(s.presets.known).toBe(false);
    expect(s.presets.list()).toEqual([]);
  });
});

describe('preset events on the wire', () => {
  it('are world events when well formed', async () => {
    const { isWorldEvent, parseMessage } = await import('../net/protocol');
    const ev = (raw: unknown) => {
      const m = parseMessage(JSON.stringify(raw));
      return !!m && isWorldEvent(m);
    };
    expect(ev({ t: 'preset.upsert', seq: 5, preset: BUILD })).toBe(true);
    expect(ev({ t: 'preset.removed', seq: 6, id: BUILD.id })).toBe(true);
    expect(ev({ t: 'preset.upsert', seq: 7, preset: { id: 'p' } })).toBe(false);
    expect(ev({ t: 'preset.removed', seq: 8 })).toBe(false);
  });
});

// M7: "Hand to a worker" starts the run on a card of the issue board, sent as `work_item` (never parsed, never a repo/number).
describe('a work item as the ticket', () => {
  const item = { provider: 'github', id: 'JeffreyVdb/lab#7', key: '#7', title: 'Render markdown safely' };
  const t = { kind: 'work_item', item, why: null } as const;

  it('sends the card’s provider and opaque id and nothing else of it', () => {
    expect(ticketArgs(t)).toEqual({ work_item: { provider: 'github', id: 'JeffreyVdb/lab#7' } });
    expect(ticketLine(t)).toBe('#7 · Render markdown safely');
  });

  it('is a ticket for prepare and start, with no other ticket field', () => {
    const f = form({ ticket: '', workItem: item });
    expect(prepareArgs('lab', f, t)).toEqual({ session: 'lab', work_item: { provider: 'github', id: 'JeffreyVdb/lab#7' }, preset: BUILD.id, orch: { ...opus } });
    expect(startBlocker(f, t, emptyPreview(), H, book(BUILD))).toBeNull();
    const a = startArgs('lab', f, t, emptyPreview(), null, false);
    expect(a).toMatchObject({ session: 'lab', desk_index: 4, work_item: { provider: 'github', id: 'JeffreyVdb/lab#7' } });
    expect(a).not.toHaveProperty('issue');
    expect(a).not.toHaveProperty('text');
  });
});
