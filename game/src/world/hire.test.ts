import { describe, expect, it } from 'vitest';
import type { FirePrepare, HireGit, HirePrepare } from '../net/protocol';
import {
  floorClosed,
  resolveHireDesk,
  ageText,
  baseHint,
  newerGit,
  baseText,
  capacityView,
  capLevel,
  choiceNote,
  fetchNote,
  fireArgs,
  fireBlocked,
  fireOptions,
  firstFreeDesk,
  formFromPrepare,
  hireArgs,
  hireBlocker,
  isFreshHire,
  leftovers,
  Reservations,
  resolveChoice,
  offeredOptions,
  resolveVisibleChoice,
  scheduleHold,
  visibleOptions,
  worktreeUsable,
} from './hire';
import { DEFAULT_HIRE_OPTIONS, type FloorView } from './store';
import type { HireOptions } from '../net/protocol';

const H = DEFAULT_HIRE_OPTIONS;
const NOW = 1_790_600_000_000;
const git: HireGit = { repo_root: '/r', default_branch: 'main', base_sha: '1a2b3c4d5e6f', base_time: NOW - 3 * 3600_000 - 60_000, fetched: true };
const prep = (over: Partial<HirePrepare> = {}): HirePrepare => ({
  cwd: '/home/dev/devel/herdr-3d',
  choice: { harness: 'codex', model: 'gpt-6-sol', effort: 'ultra' },
  choice_source: 'last',
  label: 'Gumdrop',
  git,
  capacity: { floor: { count: 3, soft: 10, hard: 12 }, host: { count: 20, soft: 40, hard: 60 } },
  ...over,
});

describe('resolveChoice', () => {
  it('keeps a valid choice, extra efforts included', () => {
    expect(resolveChoice(H, { harness: 'codex', model: 'gpt-6-sol', effort: 'ultra' })).toEqual({ harness: 'codex', model: 'gpt-6-sol', effort: 'ultra' });
    expect(resolveChoice(H, { harness: 'claude', model: 'claude-fable-5-1', effort: 'max' })).toEqual({ harness: 'claude', model: 'claude-fable-5-1', effort: 'max' });
  });
  it('falls back field by field: unknown harness, model or effort', () => {
    expect(resolveChoice(H, null)).toEqual({ harness: 'claude', model: 'claude-opus-5-5', effort: 'high' });
    expect(resolveChoice(H, { harness: 'gemini', model: 'x', effort: 'low' })).toEqual({ harness: 'claude', model: 'claude-opus-5-5', effort: 'low' });
    expect(resolveChoice(H, { harness: 'codex', model: 'gpt-7', effort: 'low' })).toEqual({ harness: 'codex', model: 'gpt-6-sol', effort: 'low' });
    // ultra is only for sol and astra.
    expect(resolveChoice(H, { harness: 'codex', model: 'gpt-6-luna', effort: 'ultra' })).toEqual({ harness: 'codex', model: 'gpt-6-luna', effort: 'high' });
    expect(resolveChoice({}, null)).toBeNull();
    expect(resolveChoice({ x: { models: ['m'], efforts: ['e'] } }, null)).toEqual({ harness: 'x', model: 'm', effort: 'e' });
  });
  it('names where the preselection came from while it is untouched', () => {
    expect(choiceNote('floor_default', true)).toBe('Floor default');
    expect(choiceNote('last', true)).toBe('Last hire here');
    expect(choiceNote('none', true)).toBeNull();
    expect(choiceNote('last', false)).toBeNull();
  });
});

describe('capacity', () => {
  it('warns above the soft cap and refuses at the hard cap', () => {
    expect(capLevel({ count: 8, soft: 10, hard: 12 })).toBe('ok');
    expect(capLevel({ count: 9, soft: 10, hard: 12 })).toBe('ok');
    expect(capLevel({ count: 10, soft: 10, hard: 12 })).toBe('warn');
    expect(capLevel({ count: 11, soft: 10, hard: 12 })).toBe('warn');
    expect(capLevel({ count: 12, soft: 10, hard: 12 })).toBe('full');
    expect(capLevel({ count: 30, soft: 10, hard: 12 })).toBe('full');
  });
  it('says which cap, and the host load', () => {
    const ok = capacityView({ floor: { count: 1, soft: 10, hard: 12 }, host: { count: 1, soft: 40, hard: 60 } }, 'scratchpad');
    expect(ok).toEqual({ level: 'ok', floor: 'ok', host: 'ok', lines: [], load: null });
    const warn = capacityView({ floor: { count: 3, soft: 3, hard: 4 }, host: { count: 20, soft: 40, hard: 60 }, load: { load1: 2.36, cpus: 16, mem_used_pct: 41.4 } }, 'scratchpad');
    expect(warn.level).toBe('warn');
    expect(warn.lines).toEqual(['scratchpad will have 4 workers, over its soft cap of 3 (hard cap 4).']);
    expect(warn.load).toBe('load 2.4 on 16 CPUs · memory 41 %');
    const full = capacityView({ floor: { count: 3, soft: 3, hard: 4 }, host: { count: 60, soft: 40, hard: 60 } }, 'scratchpad');
    expect(full.level).toBe('full');
    expect(full.host).toBe('full');
    expect(full.lines).toEqual(['scratchpad will have 4 workers, over its soft cap of 3 (hard cap 4).', 'The host has 60 workers: its hard cap is 60.']);
  });
});

describe('worktree base', () => {
  it('#134: a preview: the last fetched base, a worktree still offered (the hire fetches first), never a fetch failure', () => {
    const preview: HireGit = { ...git, fetched: false, preview: true };
    expect(worktreeUsable(preview)).toBe(true);
    expect(fetchNote(preview)).toBeNull();
    expect(baseText(preview, NOW)).toBe('origin/main @ 1a2b3c4, 3 h old');
    expect(baseHint(preview)).toBe('last fetched; refreshed before branching');
    expect(baseHint(git)).toBeNull();
    const f = formFromPrepare(prep({ git: preview }), H);
    expect(f.worktree).toBe(true);
    expect(hireArgs('s', 0, f, preview).worktree).toBe(true);
    // No local origin refs yet: not known, not a failure, and the worktree stays on.
    const unknown: HireGit = { ...preview, default_branch: '', base_sha: '', base_time: 0 };
    expect(baseText(unknown, NOW)).toBe('origin/HEAD');
    expect(baseHint(unknown)).toBe('not fetched into this checkout yet; checked before branching');
    expect(fetchNote(unknown)).toBeNull();
    expect(formFromPrepare(prep({ git: unknown }), H).worktree).toBe(true);
    // A fetch that failed is still one.
    expect(worktreeUsable({ ...git, fetched: false, fetch_error: 'offline' })).toBe(false);
  });

  it('#134: a preview of the same repository does not replace what a fetch said', () => {
    const failed: HireGit = { ...git, fetched: false, fetch_error: 'offline' };
    const preview: HireGit = { ...git, fetched: false, preview: true };
    expect(newerGit(failed, preview)).toBe(failed);
    expect(newerGit(git, preview)).toBe(git);
    // Another repository, a fetch's answer, nothing before: the new answer.
    const other: HireGit = { ...preview, repo_root: '/elsewhere' };
    expect(newerGit(failed, other)).toBe(other);
    expect(newerGit(preview, git)).toBe(git);
    expect(newerGit(failed, null)).toBeNull();
    expect(newerGit(null, preview)).toBe(preview);
    expect(newerGit(undefined, preview)).toBe(preview);
  });

  it('shows the SHA and its age', () => {
    expect(baseText(git, NOW)).toBe('origin/main @ 1a2b3c4, 3 h old');
    expect(ageText(NOW - 30_000, NOW)).toBe('just now');
    expect(ageText(NOW - 12 * 60_000, NOW)).toBe('12 min old');
    expect(ageText(NOW - 3 * 86400_000, NOW)).toBe('3 d old');
    expect(ageText(NOW + 5000, NOW)).toBe('just now');
  });
  it('a failed fetch turns the worktree off, with the reason', () => {
    expect(fetchNote(git)).toBeNull();
    expect(worktreeUsable(git)).toBe(true);
    expect(worktreeUsable(null)).toBe(false);
    const failed = { ...git, fetched: false, fetch_error: 'Could not resolve host: github.com' };
    expect(worktreeUsable(failed)).toBe(false);
    expect(fetchNote(failed)).toEqual({ text: 'git fetch origin failed: Could not resolve host: github.com. A worktree needs a fresh origin/main: fetch again, or hire without one.', error: true });
    expect(fetchNote({ ...git, fetched: false })?.text).toBe('git fetch origin failed. A worktree needs a fresh origin/main: fetch again, or hire without one.');
    // The form starts without a worktree, and even a form that asks for one does not send it.
    expect(formFromPrepare(prep({ git: failed }), H).worktree).toBe(false);
    expect(formFromPrepare(prep({ git }), H).worktree).toBe(true);
    expect(formFromPrepare(prep({ git }), H, false).worktree).toBe(false);
    const f = { ...formFromPrepare(prep({ git }), H), worktree: true };
    expect(hireArgs('s', 0, f, failed).worktree).toBe(false);
    expect(hireArgs('s', 0, f, git).worktree).toBe(true);
  });
});

describe('hire form', () => {
  it('opens on the prepared choice, label and cwd; the worktree on for a repo', () => {
    expect(formFromPrepare(prep(), H)).toEqual({ prompt: '', harness: 'codex', model: 'gpt-6-sol', effort: 'ultra', label: 'Gumdrop', cwd: '/home/dev/devel/herdr-3d', worktree: true });
    expect(formFromPrepare(prep({ git: null, choice: null, choice_source: 'none' }), H)).toMatchObject({ harness: 'claude', model: 'claude-opus-5-5', effort: 'high', worktree: false });
  });
  it('blocks at the hard cap and on bad fields', () => {
    const f = formFromPrepare(prep(), H);
    const cap = capacityView(prep().capacity, 'x');
    expect(hireBlocker(f, H, cap)).toBeNull();
    expect(hireBlocker(f, H, capacityView({ floor: { count: 12, soft: 10, hard: 12 }, host: { count: 1, soft: 9, hard: 9 } }, 'x'))).toMatch(/hard cap/);
    expect(hireBlocker({ ...f, model: 'gpt-6-luna' }, H, cap)).toBe('Choose an effort.');
    expect(hireBlocker({ ...f, cwd: 'relative/dir' }, H, cap)).toMatch(/absolute/);
    expect(hireBlocker({ ...f, cwd: '' }, H, cap)).toBeNull();
    // The bridge's label and prompt rules.
    expect(hireBlocker({ ...f, label: '-rm' }, H, cap)).toMatch(/can’t start with “-”/);
    expect(hireBlocker({ ...f, label: 'é'.repeat(33) }, H, cap)).toMatch(/64 bytes/);
    expect(hireBlocker({ ...f, prompt: '--help me' }, H, cap)).toMatch(/“--”/);
    expect(hireBlocker({ ...f, prompt: 'Fix --flag parsing' }, H, cap)).toBeNull();
  });
  it('sends only what is set', () => {
    const f = formFromPrepare(prep(), H);
    expect(hireArgs('herdr-3d', 5, f, git)).toEqual({ floor: 'herdr-3d', desk_index: 5, harness: 'codex', model: 'gpt-6-sol', effort: 'ultra', label: 'Gumdrop', cwd: '/home/dev/devel/herdr-3d', worktree: true });
    expect(hireArgs('s', 0, { ...f, label: '  ', cwd: '', prompt: 'Fix the\nflaky test', worktree: false }, git)).toEqual({ floor: 's', desk_index: 0, harness: 'codex', model: 'gpt-6-sol', effort: 'ultra', worktree: false, prompt: 'Fix the\nflaky test' });
    // No repo: no worktree key at all.
    expect(hireArgs('s', 0, { ...f, worktree: true }, null)).not.toHaveProperty('worktree');
    expect(hireArgs('s', 0, { ...f, prompt: '   ' }, null)).not.toHaveProperty('prompt');
  });
  it('first free desk skips hires in flight', () => {
    const seats = [{}, null, {}, null, null] as unknown as FloorView['seats'];
    const v = { seats } as FloorView;
    expect(firstFreeDesk(v)).toBe(1);
    expect(firstFreeDesk(v, new Set([1, 3]))).toBe(4);
    expect(firstFreeDesk(v, new Set([1, 3, 4]))).toBeNull();
  });
});

describe('hires on their way (reservations)', () => {
  it('each hire holds its own desk; an older ack lets go of its own hold only', () => {
    const r = new Reservations();
    // Hire A to desk 4 is sent, the dialog is Esc'd; hire B picks the first free desk that nobody holds.
    const releaseA = r.add('pastry', 4);
    const v = { seats: [{ name: 'x' }, null, { name: 'y' }, { name: 'z' }, null, null, null] } as unknown as FloorView;
    expect(firstFreeDesk(v, r.desks('pastry'))).toBe(1);
    const releaseB = r.add('pastry', 1);
    expect(firstFreeDesk(v, r.desks('pastry'))).toBe(5);
    expect(r.desks('pastry')).toEqual(new Set([1, 4]));
    // A's ack: A's desk is free of holds, B's is still held.
    expect(releaseA()).toBe(true);
    expect(r.has('pastry', 4)).toBe(false);
    expect(r.has('pastry', 1)).toBe(true);
    // Releasing twice does nothing.
    expect(releaseA()).toBe(false);
    expect(r.has('pastry', 1)).toBe(true);
    expect(releaseB()).toBe(true);
    expect(r.all()).toEqual([]);
  });

  it('two holds on one desk (a retry after desk_taken): the desk stays held until both let go; floors are separate', () => {
    const r = new Reservations();
    const a = r.add('pastry', 2);
    const b = r.add('pastry', 2);
    r.add('scratchpad', 2);
    expect(a()).toBe(false);
    expect(r.has('pastry', 2)).toBe(true);
    expect(b()).toBe(true);
    expect(r.desks('pastry')).toEqual(new Set());
    expect(r.desks('scratchpad')).toEqual(new Set([2]));
  });
});

describe('send home', () => {
  const fp = (over: Partial<FirePrepare> = {}): FirePrepare => ({
    name: 'Pixel',
    label: 'CODE|m2-go',
    branch: 'h3d/pixel-m2-go',
    worktree: { path: '/wt/m2-go', linked: true },
    dirty: [],
    unpushed: 0,
    can_delete: true,
    can_delete_branch: true,
    ...over,
  });
  it('offers delete for a clean linked worktree, and the branch too when the bridge made it', () => {
    expect(fireOptions(fp())).toEqual({ offered: true, choices: ['keep', 'delete', 'delete_branch'], enabled: { keep: true, delete: true, delete_branch: true }, warning: null, branchNote: null });
    expect(fireArgs('id1', fp(), 'delete_branch')).toEqual({ id: 'id1', worktree: 'delete_branch' });
  });
  it('a clean worktree on a branch the bridge did not make: delete the worktree only, the branch stays', () => {
    for (const p of [fp({ branch: 'dev/bridge-ws', can_delete_branch: false }), (({ can_delete_branch: _, ...older }) => older)(fp({ branch: 'dev/bridge-ws' }))]) {
      const o = fireOptions(p);
      expect(o).toMatchObject({ offered: true, choices: ['keep', 'delete'], enabled: { keep: true, delete: true, delete_branch: false }, warning: null });
      expect(o.branchNote).toBe('The branch dev/bridge-ws stays either way: herdr-world only deletes a branch it made for this worker.');
      // Never sent, even if asked.
      expect(fireArgs('id1', p, 'delete_branch')).toEqual({ id: 'id1' });
      expect(fireArgs('id1', p, 'delete')).toEqual({ id: 'id1', worktree: 'delete' });
    }
  });
  it('disables delete and warns for a dirty or unpushed one', () => {
    const dirty = fp({ dirty: [' M src/app.ts', '?? notes.md', ' D old.ts'], unpushed: 2, can_delete: false, can_delete_branch: false });
    expect(leftovers(dirty)).toBe('3 uncommitted changes and 2 commits not on any remote');
    const o = fireOptions(dirty);
    expect(o.enabled).toEqual({ keep: true, delete: false, delete_branch: false });
    expect(o.choices).toEqual(['keep', 'delete']);
    expect(o.branchNote).toBeNull();
    expect(o.warning).toBe('Deleting is off: 3 uncommitted changes and 2 commits not on any remote. The worktree stays; commit and push first to delete it.');
    expect(fireOptions({ ...dirty, reason: 'the branch is not pushed' }).warning).toMatch(/^Deleting is off: the branch is not pushed\./);
    // A disabled choice is never sent.
    expect(fireArgs('id1', dirty, 'delete')).toEqual({ id: 'id1' });
    expect(leftovers(fp({ unpushed: 1 }))).toBe('1 commit not on any remote');
  });
  it('#63: a scheduled agent’s hold is its own reason, with its own advice; commit and push only for leftovers', () => {
    const hold = "used by scheduled agent 'After the soak' at 2026-10-17 12:45 CEST";
    expect(scheduleHold(hold)).toBe(hold);
    expect(scheduleHold(`invalid state: ${hold} and 2 more`)).toBe(`${hold} and 2 more`);
    for (const other of [undefined, null, '', '2 uncommitted changes', 'not in a linked worktree (only those can be deleted)', 'invalid state: floor s is asleep']) {
      expect(scheduleHold(other)).toBeNull();
    }
    const held = fp({ can_delete: false, can_delete_branch: false, reason: hold });
    expect(fireOptions(held)).toMatchObject({ offered: true, enabled: { keep: true, delete: false, delete_branch: false } });
    expect(fireOptions(held).warning).toBe(`Deleting is off: ${hold}. The worktree stays until that agent starts, or until its schedule is cancelled.`);
    expect(fireOptions({ ...held, reason: `${hold} and 2 more` }).warning).toBe(
      `Deleting is off: ${hold} and 2 more. The worktree stays until those agents start, or until their schedules are cancelled.`,
    );
    // Held and dirty: the hold is the reason, and commit and push would not help.
    expect(fireOptions({ ...held, dirty: [' M a.ts'] }).warning).not.toMatch(/commit and push/);
    // Neither a hold nor leftovers: no advice that would not help.
    expect(fireOptions(fp({ can_delete: false, reason: 'reading the git state failed: boom' })).warning).toBe('Deleting is off: reading the git state failed: boom. The worktree stays.');
  });
  it('knows when herdr would not close the workspace at all', () => {
    expect(fireBlocked(fp())).toBeNull();
    expect(fireBlocked(fp({ can_fire: true }))).toBeNull();
    expect(fireBlocked(fp({ can_fire: false, fire_blocked: 'send its worktrees home first' }))).toBe('send its worktrees home first');
    expect(fireBlocked(fp({ can_fire: false }))).toBe('herdr would refuse to close its workspace');
  });
  it('has no worktree choices without a linked worktree', () => {
    expect(fireOptions(fp({ worktree: null, can_delete: false, can_delete_branch: false }))).toEqual({ offered: false, choices: [], enabled: { keep: true, delete: false, delete_branch: false }, warning: null, branchNote: null });
    expect(fireOptions(fp({ worktree: { path: '/repo', linked: false }, can_delete: false })).offered).toBe(false);
    expect(fireArgs('id1', fp({ worktree: null }), 'keep')).toEqual({ id: 'id1' });
  });
});

describe('fresh hires', () => {
  it('walk in only within 15 s of hired_at', () => {
    expect(isFreshHire(NOW - 2000, NOW)).toBe(true);
    expect(isFreshHire(NOW - 16_000, NOW)).toBe(false);
    expect(isFreshHire(undefined, NOW)).toBe(false);
    // A bridge clock a little ahead still counts; far ahead does not.
    expect(isFreshHire(NOW + 3000, NOW)).toBe(true);
    expect(isFreshHire(NOW + 60_000, NOW)).toBe(false);
  });
});

// Fixture slugs only: nothing in the app hides a model by default.
const CAT: HireOptions = {
  codex: { models: ['x-1', 'x-2', 'x-3'], efforts: ['low', 'high'], extra_efforts: { 'x-2': ['ultra'] } },
  claude: { models: ['y-1', 'y-2'], efforts: ['low', 'high', 'max'] },
};
const hiding =
  (map: Record<string, string[]>) =>
  (harness: string): ReadonlySet<string> =>
    new Set(map[harness] ?? []);

describe('visible hire options (#194)', () => {
  it('with nothing hidden, the whole catalog', () => {
    expect(visibleOptions(CAT, hiding({}))).toEqual(CAT);
  });

  it('drop hidden models, keep catalog order, efforts and extra efforts; the catalog itself is untouched', () => {
    const v = visibleOptions(CAT, hiding({ codex: ['x-1'] }));
    expect(v.codex).toEqual({ models: ['x-2', 'x-3'], efforts: ['low', 'high'], extra_efforts: { 'x-2': ['ultra'] } });
    expect(v.claude).toEqual(CAT.claude);
    expect(CAT.codex?.models).toEqual(['x-1', 'x-2', 'x-3']);
  });

  it('keep a harness whose models are all hidden, with no models', () => {
    const v = visibleOptions(CAT, hiding({ codex: ['x-1', 'x-2', 'x-3'] }));
    expect(Object.keys(v)).toEqual(['codex', 'claude']);
    expect(v.codex?.models).toEqual([]);
  });

  it('a model the bridge no longer lists is simply not in the catalog to filter', () => {
    expect(visibleOptions(CAT, hiding({ codex: ['gone'] })).codex?.models).toEqual(['x-1', 'x-2', 'x-3']);
  });
});

describe('visible choice resolution (#194)', () => {
  it('a hidden model falls to the first visible one of its harness, effort normalized against it', () => {
    const v = visibleOptions(CAT, hiding({ codex: ['x-1', 'x-2'] }));
    expect(resolveVisibleChoice(v, { harness: 'codex', model: 'x-1', effort: 'ultra' })).toEqual({ harness: 'codex', model: 'x-3', effort: 'high' });
    expect(resolveVisibleChoice(visibleOptions(CAT, hiding({ codex: ['x-1'] })), { harness: 'codex', model: 'x-1', effort: 'ultra' })).toEqual({ harness: 'codex', model: 'x-2', effort: 'ultra' });
  });

  it('keeps a visible choice as it is, extra efforts included', () => {
    const v = visibleOptions(CAT, hiding({ codex: ['x-1'] }));
    expect(resolveVisibleChoice(v, { harness: 'codex', model: 'x-2', effort: 'ultra' })).toEqual({ harness: 'codex', model: 'x-2', effort: 'ultra' });
  });

  it('a harness with no visible model stays the harness, with an empty model and effort', () => {
    const v = visibleOptions(CAT, hiding({ codex: ['x-1', 'x-2', 'x-3'] }));
    expect(resolveVisibleChoice(v, { harness: 'codex', model: 'x-1', effort: 'high' })).toEqual({ harness: 'codex', model: '', effort: '' });
    expect(resolveVisibleChoice(v, null)).toEqual({ harness: 'codex', model: '', effort: '' });
  });

  it('the Hire blocker says so for an all-hidden harness, and never accepts a hidden model', () => {
    const v = visibleOptions(CAT, hiding({ codex: ['x-1', 'x-2', 'x-3'] }));
    const f = { prompt: '', harness: 'codex', model: '', effort: '', label: '', cwd: '', worktree: false };
    expect(hireBlocker(f, v, null)).toMatch(/hidden/);
    const g = { ...f, harness: 'claude', model: 'y-1', effort: 'high' };
    expect(hireBlocker(g, v, null)).toBeNull();
    expect(hireBlocker({ ...g, model: 'y-2', effort: 'max' }, visibleOptions(CAT, hiding({ claude: ['y-2'] })), null)).toBe('Choose a model.');
  });

  it('the preselected choice is still resolved on the whole catalog: a hidden floor default is not the one the form opens on', () => {
    const v = visibleOptions(CAT, hiding({ codex: ['x-1'] }));
    expect(formFromPrepare(prep({ choice: { harness: 'codex', model: 'x-1', effort: 'high' } }), v)).toMatchObject({ model: 'x-2', effort: 'high' });
  });
});

describe('offered options: what a model picker other than Hire offers', () => {
  it('without Settings, the whole catalog', () => {
    expect(offeredOptions(CAT, null, [{ harness: 'codex', model: 'x-1' }])).toBe(CAT);
  });

  it('the models Settings leaves shown, plus a saved choice of a hidden one, in catalog order', () => {
    const o = offeredOptions(CAT, hiding({ codex: ['x-1', 'x-3'], claude: ['y-1'] }), [{ harness: 'codex', model: 'x-3' }, null, { harness: 'claude', model: 'y-2' }]);
    expect(o.codex).toEqual({ models: ['x-2', 'x-3'], efforts: ['low', 'high'], extra_efforts: { 'x-2': ['ultra'] } });
    expect(o.claude?.models).toEqual(['y-2']);
    expect(CAT.codex?.models).toEqual(['x-1', 'x-2', 'x-3']);
  });

  it('never offers a model the catalog does not list, nor one under another harness', () => {
    const o = offeredOptions(CAT, hiding({ codex: ['x-1'] }), [{ harness: 'codex', model: 'gone' }, { harness: 'claude', model: 'x-1' }, { harness: 'gemini', model: 'x-1' }]);
    expect(o.codex?.models).toEqual(['x-2', 'x-3']);
    expect(o.claude?.models).toEqual(['y-1', 'y-2']);
    expect(Object.keys(o)).toEqual(['codex', 'claude']);
  });
});

describe('#58 decision 3: an asleep virtual floor takes a hire', () => {
  const fv = (over: Partial<FloorView>) => ({ id: 'v-0123456789ab', name: 'Frontend', asleep: false, transition: null, virtual: true, seats: [null, null], ...over }) as unknown as FloorView;
  it('opens on an asleep virtual floor (its session wakes first), never on an asleep real one', () => {
    expect(floorClosed(fv({ asleep: true }))).toBeNull();
    expect(resolveHireDesk('v-0123456789ab', fv({ asleep: true }), new Set())).toEqual({ ok: true, desk: 0 });
    expect(floorClosed(fv({ asleep: true, virtual: false, name: 'main' }))).toBe('main is asleep. Wake it from the elevator (L) to hire.');
    expect(floorClosed(fv({ asleep: true, virtual: false, name: 'main' }), 'start a run')).toBe('main is asleep. Wake it from the elevator (L) to start a run.');
  });
  it('waits while the session is waking up or going to sleep, by the floor’s name', () => {
    expect(floorClosed(fv({ asleep: true, transition: 'waking' }))).toBe('Frontend is waking up. Wake it from the elevator (L) to hire.');
    expect(resolveHireDesk('v-0123456789ab', fv({ transition: 'sleeping' }), new Set())).toMatchObject({ ok: false, msg: 'Frontend is going to sleep. Wake it from the elevator (L) to hire.' });
    expect(resolveHireDesk('v-0123456789ab', fv({ seats: [{} as never] }), new Set())).toMatchObject({ ok: false, msg: 'No free desk on Frontend right now.' });
  });
});
