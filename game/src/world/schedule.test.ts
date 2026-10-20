import { describe, expect, it } from 'vitest';
import type { HireOptions, Schedule, Snapshot } from '../net/protocol';
import { lateBy, lateText, maxLateMs, onMissText, ScheduleBook, scheduleBlocker, scheduleSections, scheduleSpec, scheduleToast, type ScheduleForm } from './schedule';
import { WorldStore } from './store';

// #64 schedules: the book of the bridge's schedules, the dialog's sections, lateness, the toasts and the form's checks.

const T = Date.UTC(2026, 9, 17, 7, 0);
const H = 3_600_000;
function sched(id: string, o: Partial<Schedule> = {}): Schedule {
  return {
    id,
    floor: 'herdr-3d',
    title: `Task ${id}`,
    prompt: 'Do it.',
    due_at: T + H,
    on_miss: 'run_late',
    harness: 'claude',
    model: 'claude-opus-5-5',
    effort: 'high',
    cwd: '/home/dev/herdr-3d',
    worktree: false,
    wake_floor: true,
    source: { kind: 'manual' },
    state: 'scheduled',
    created_at: T - H,
    updated_at: T - H,
    ...o,
  };
}

describe('ScheduleBook', () => {
  it('a snapshot without schedules (a bridge before #62) reads as none, and unknown', () => {
    const b = new ScheduleBook();
    b.reset(undefined);
    expect(b.known).toBe(false);
    expect(b.all()).toEqual([]);
    b.reset([sched('a'), { id: 7 } as unknown as Schedule]);
    expect(b.known).toBe(true);
    expect(b.all().map((s) => s.id)).toEqual(['a']);
  });

  it('upserts, removes, and bumps its version only on a change', () => {
    const b = new ScheduleBook();
    b.reset([]);
    const v0 = b.version;
    b.upsert(sched('a'));
    b.upsert(sched('a', { state: 'running' }));
    expect(b.get('a')?.state).toBe('running');
    expect(b.version).toBe(v0 + 2);
    b.removed({ t: 'schedule.removed', seq: 1, id: 'nope' });
    expect(b.version).toBe(v0 + 2);
    b.removed({ t: 'schedule.removed', seq: 2, id: 'a', floor_id: 'herdr-3d' });
    expect(b.all()).toEqual([]);
    // A cancelled or dismissed one is out of view, whatever event brings it.
    b.upsert(sched('c', { state: 'cancelled' }));
    b.upsert(sched('d', { state: 'failed', dismissed_at: T }));
    expect(b.all()).toEqual([]);
  });

  it('is the store’s: the snapshot resets it and the events reach it', () => {
    const st = new WorldStore(T);
    const snap = (schedules?: Schedule[]): Snapshot => ({ t: 'world.snapshot', seq: 1, world: { buildings: [], unassigned: [], floors: [], workers: [], ...(schedules ? { schedules } : {}) } });
    st.applySnapshot(snap([sched('a')]));
    expect(st.schedules.all().map((s) => s.id)).toEqual(['a']);
    st.applyEvent({ t: 'schedule.upsert', seq: 2, schedule: sched('b') });
    st.applyEvent({ t: 'schedule.removed', seq: 3, id: 'a', floor_id: 'herdr-3d' });
    expect(st.schedules.all().map((s) => s.id)).toEqual(['b']);
    st.applySnapshot(snap());
    expect(st.schedules.known).toBe(false);
    expect(st.schedules.all()).toEqual([]);
  });
});

describe('scheduleSections', () => {
  it('upcoming soonest first (starting ones too), needs attention latest first, done newest first and at most 50', () => {
    const list = [
      sched('late', { due_at: T + 5 * H }),
      sched('soon', { due_at: T + H }),
      sched('wait', { state: 'waiting', due_at: T - 60_000 }),
      sched('run', { state: 'running', due_at: T - 120_000, fired_at: T }),
      sched('f1', { state: 'failed', updated_at: T - 2 * H }),
      sched('s1', { state: 'skipped', updated_at: T - H }),
      ...Array.from({ length: 55 }, (_, i) => sched(`d${i}`, { state: 'done', fired_at: T - i * 60_000 })),
    ];
    const s = scheduleSections(list);
    expect(s.upcoming.map((x) => x.id)).toEqual(['run', 'wait', 'soon', 'late']);
    expect(s.attention.map((x) => x.id)).toEqual(['s1', 'f1']);
    expect(s.done).toHaveLength(50);
    expect(s.done[0]?.id).toBe('d0');
    expect(s.done.at(-1)?.id).toBe('d49');
  });
});

describe('lateness', () => {
  it('is late only past the 5-minute grace, and never for an early Run now', () => {
    expect(lateBy({ due_at: T, fired_at: T + 5 * 60_000 })).toBeNull();
    expect(lateBy({ due_at: T, fired_at: T + 5 * 60_000 + 1 })).toBe(5 * 60_000 + 1);
    expect(lateBy({ due_at: T, fired_at: T - 3 * H })).toBeNull();
    expect(lateBy({ due_at: T })).toBeNull();
    expect(lateText(3 * H)).toBe('+3h late');
    expect(lateText(2 * H + 20 * 60_000)).toBe('+2h 20m late');
    expect(lateText(7 * 60_000)).toBe('+7m late');
    expect(lateText(28 * H)).toBe('+1d 4h late');
  });

  it('the on_miss policy in words', () => {
    expect(onMissText({ on_miss: 'run_late' })).toBe('Run late if missed');
    expect(onMissText({ on_miss: 'run_late', max_lateness_ms: 2 * H })).toBe('Run late, only if less than 2h late');
    expect(onMissText({ on_miss: 'skip' })).toBe('Skip if missed');
  });
});

describe('scheduleToast', () => {
  it('fired, fired late, failed and skipped, each with the title', () => {
    const was = sched('a', { state: 'running' });
    expect(scheduleToast(was, sched('a', { state: 'done', fired_at: T + H + 60_000 }))).toEqual({ kind: 'fired', text: 'Scheduled agent “Task a” started.', level: 'info' });
    expect(scheduleToast(was, sched('a', { state: 'done', fired_at: T + 4 * H }))).toEqual({ kind: 'late', text: 'Scheduled agent “Task a” started 3h late.', level: 'warn' });
    expect(scheduleToast(sched('a'), sched('a', { state: 'failed', state_reason: 'floor herdr-3d is gone' }))?.text).toBe('Scheduled agent “Task a” failed: floor herdr-3d is gone.');
    expect(scheduleToast(sched('a'), sched('a', { state: 'skipped', state_reason: 'missed: bridge was offline' }))).toMatchObject({ kind: 'skipped', level: 'warn' });
  });

  it('says nothing on first sight, in the same state, or for a schedule that waits or starts', () => {
    expect(scheduleToast(undefined, sched('a', { state: 'done', fired_at: T }))).toBeNull();
    expect(scheduleToast(sched('a', { state: 'failed' }), sched('a', { state: 'failed', updated_at: T }))).toBeNull();
    expect(scheduleToast(sched('a'), sched('a', { state: 'waiting' }))).toBeNull();
    expect(scheduleToast(sched('a'), sched('a', { state: 'running' }))).toBeNull();
  });
});

const OPTS: HireOptions = { claude: { models: ['claude-opus-5-5'], efforts: ['low', 'high'] } };
function form(o: Partial<ScheduleForm> = {}): ScheduleForm {
  return { floor: 'herdr-3d', title: 'After the soak', prompt: 'Delete the backups.', due: T + H, dueError: '', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', cwd: '/home/dev/herdr-3d', worktree: true, wakeFloor: true, onMiss: 'run_late', maxLateHours: '', handoff: { kind: 'none' }, instructions: false, ...o };
}

describe('scheduleBlocker', () => {
  it('passes a valid form and names the first problem otherwise', () => {
    expect(scheduleBlocker(form(), OPTS, T)).toBeNull();
    const cases: Array<[Partial<ScheduleForm>, RegExp]> = [
      [{ floor: '' }, /floor/],
      [{ title: '  ' }, /title/],
      [{ title: 'é'.repeat(101) }, /at most 200 bytes/],
      [{ title: 'a\tb' }, /control/],
      [{ due: null, dueError: '“x” is not a time I can read.' }, /not a time I can read/],
      [{ due: T }, /passed/],
      [{ harness: 'codex' }, /harness/],
      [{ model: 'x' }, /model/],
      [{ effort: 'max' }, /effort/],
      [{ cwd: '' }, /folder/],
      [{ cwd: 'rel/path' }, /absolute/],
      [{ prompt: '  ' }, /prompt, or attach a handoff/],
      [{ prompt: '--flag' }, /“--”/],
      [{ maxLateHours: '0' }, /hours above 0/],
      [{ maxLateHours: 'soon' }, /hours above 0/],
    ];
    for (const [o, re] of cases) expect(scheduleBlocker(form(o), OPTS, T), JSON.stringify(o)).toMatch(re);
    expect(scheduleBlocker(form({ prompt: 'x'.repeat(32 * 1024 + 1) }), OPTS, T)).toMatch(/32 KiB/);
    // An empty prompt is fine with a handoff; a bad limit is ignored with skip.
    expect(scheduleBlocker(form({ prompt: '', handoff: { kind: 'path', path: '/h/a.md' } }), OPTS, T)).toBeNull();
    expect(scheduleBlocker(form({ prompt: '', handoff: { kind: 'transcript' } }), OPTS, T)).toBeNull();
    expect(scheduleBlocker(form({ onMiss: 'skip', maxLateHours: 'x' }), OPTS, T)).toBeNull();
  });
});

describe('scheduleSpec', () => {
  it('the whole spec, wake_floor always, the limit only with run_late, the handoff path and source when given', () => {
    expect(scheduleSpec(form({ wakeFloor: false, maxLateHours: '1.5' }), 'Delete the backups.', null)).toEqual({
      floor: 'herdr-3d',
      title: 'After the soak',
      prompt: 'Delete the backups.',
      due_at: T + H,
      on_miss: 'run_late',
      max_lateness_ms: 1.5 * H,
      harness: 'claude',
      model: 'claude-opus-5-5',
      effort: 'high',
      cwd: '/home/dev/herdr-3d',
      worktree: true,
      wake_floor: false,
    });
    expect(scheduleSpec(form({ onMiss: 'skip', maxLateHours: '2' }), '', null).max_lateness_ms).toBeUndefined();
    expect(scheduleSpec(form({ handoff: { kind: 'path', path: '/h/a.md' } }), '', null).handoff_path).toBe('/h/a.md');
    const src = { kind: 'transcript' as const, worker: 'w1', message: 'msg_01' };
    const t = scheduleSpec(form({ handoff: { kind: 'transcript' } }), '', '/h/filed.md', src);
    expect(t.handoff_path).toBe('/h/filed.md');
    expect(t.source).toEqual(src);
    expect(maxLateMs('')).toBeNull();
    expect(maxLateMs('2,5')).toBe(2.5 * H);
  });
});

describe('#127 schedules’ herdr hiring instructions', () => {
  it('the spec carries the flag only when ticked (off: the field is left out)', () => {
    expect(scheduleSpec(form({ instructions: true }), 'Spawn reviewers.', null).herdr_instructions).toBe(true);
    expect('herdr_instructions' in scheduleSpec(form(), 'Spawn reviewers.', null)).toBe(false);
  });

  it('the book knows whether the bridge takes the flag (absent: an older bridge)', () => {
    const st = new WorldStore(T);
    const snap = (flag?: boolean): Snapshot => ({ t: 'world.snapshot', seq: 1, world: { buildings: [], unassigned: [], floors: [], workers: [], schedules: [sched('a', { herdr_instructions: true })], ...(flag !== undefined ? { schedule_herdr_instructions: flag } : {}) } });
    st.applySnapshot(snap(true));
    expect(st.schedules.instructions).toBe(true);
    expect(st.schedules.get('a')?.herdr_instructions).toBe(true);
    st.applySnapshot(snap());
    expect(st.schedules.instructions).toBe(false);
  });
});
