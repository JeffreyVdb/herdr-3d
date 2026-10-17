// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Building, Floor, Schedule } from '../net/protocol';
import { ScheduleBook } from '../world/schedule';
import type { DialogHost } from './hire';
import { SchedulesDialog, type SchedulesHost } from './schedules';

// #64 schedules: the scheduled agents dialog: its three sections, every action, the all-floors toggle, the empty
// states, inline errors, live updates that keep the focus, and opening on one row.

const T = Date.UTC(2026, 9, 17, 7, 0);
const H = 3_600_000;
type Reply = { ok: true; data: unknown } | { ok: false; code: string; message: string };

function sched(id: string, o: Partial<Schedule> = {}): Schedule {
  return { id, floor: 'f1', title: `Task ${id}`, prompt: 'Do it.', due_at: T + H, on_miss: 'run_late', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', cwd: '/home/dev/herdr-3d', worktree: false, wake_floor: true, source: { kind: 'manual' }, state: 'scheduled', created_at: T - H, updated_at: T - H, ...o };
}

function setup(list: Schedule[], o: { known?: boolean; replies?: Partial<Record<string, Reply>>; workers?: string[] } = {}) {
  document.body.replaceChildren();
  const book = new ScheduleBook();
  book.reset(o.known === false ? undefined : list);
  const floors = new Map<string, Floor>([
    ['f1', { id: 'f1', session: 'f1', name: 'herdr-3d', state: 'running', building: 'b1', index: 0 } as Floor],
    ['f2', { id: 'f2', session: 'f2', name: 'pastry', state: 'running', building: 'b2', index: 0 } as Floor],
  ]);
  const buildings = new Map<string, Building>([
    ['b1', { id: 'b1', name: 'Work', sort: 0, floors: ['f1'] } as Building],
    ['b2', { id: 'b2', name: 'Home', sort: 1, floors: ['f2'] } as Building],
  ]);
  const workers = new Map((o.workers ?? []).map((id) => [id, { id, name: `Worker ${id}` }]));
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const calls: string[] = [];
  const host = {
    store: {
      schedules: book,
      floors,
      buildings,
      workers,
      floorName: (id: string) => floors.get(id)?.name ?? id,
      city: () => [{ floors: [{ id: 'f1' }] }, { floors: [{ id: 'f2' }] }],
      workerView: (id: string) => (workers.has(id) ? { name: `Worker ${id}` } : null),
    },
    unsupported: () => false,
    toast: () => {},
    now: () => T,
    send: async (t: string, args: Record<string, unknown>) => {
      sent.push({ t, args });
      return o.replies?.[t] ?? { ok: true, data: {} };
    },
    create: (f: string) => calls.push(`create:${f}`),
    edit: (s: Schedule) => calls.push(`edit:${s.id}`),
    goTo: (id: string) => calls.push(`go:${id}`),
  } as unknown as SchedulesHost & DialogHost;
  const dlg = new SchedulesDialog(document.body, host);
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const row = (id: string) => document.querySelector<HTMLElement>(`.sch-row[data-id="${id}"]`)!;
  const btn = (id: string, key: string) => row(id).querySelector<HTMLButtonElement>(`[data-act="${key}"]`)!;
  return { dlg, book, sent, calls, flush, row, btn };
}

describe('SchedulesDialog (#64 schedules)', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
    Element.prototype.scrollIntoView = function () {};
    vi.stubGlobal('CSS', { escape: (s: string) => s });
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const mix = () => [
    sched('later', { due_at: T + 5 * H }),
    sched('soon', { due_at: T + 2 * H, handoff_path: '/h/a.md', max_lateness_ms: 2 * H }),
    sched('wait', { state: 'waiting', due_at: T - 60_000, state_reason: 'waking floor f1' }),
    sched('run', { state: 'running', due_at: T - 120_000, fired_at: T - 30_000 }),
    sched('fail', { state: 'failed', state_reason: 'floor f1 is gone', updated_at: T - 60_000 }),
    sched('skip', { state: 'skipped', state_reason: 'missed: bridge was offline', updated_at: T - 2 * H }),
    sched('ok', { state: 'done', due_at: T - 3 * H, fired_at: T - 3 * H + 60_000, worker_id: 'w-here' }),
    sched('late', { state: 'done', due_at: T - 9 * H, fired_at: T - 6 * H, worker_id: 'w-gone' }),
    sched('other', { floor: 'f2', due_at: T + 3 * H }),
  ];

  it('shows the three sections of the floor, each in its order, with what each row needs', async () => {
    const e = setup(mix(), { workers: ['w-here'] });
    e.dlg.open({ floor: 'f1' });
    const s = e.dlg.summary();
    expect(s.allFloors).toBe(false);
    expect(s.upcoming.map((r) => r.id)).toEqual(['run', 'wait', 'soon', 'later']);
    expect(s.attention.map((r) => r.id)).toEqual(['fail', 'skip']);
    expect(s.done.map((r) => r.id)).toEqual(['ok', 'late']);
    // Upcoming: a countdown, its actions by state; running is "starting" with none.
    expect(s.upcoming.find((r) => r.id === 'soon')).toMatchObject({ countdown: 'in 2 h', actions: ['edit', 'run-now', 'cancel'] });
    expect(s.upcoming.find((r) => r.id === 'wait')?.actions).toEqual(['cancel']);
    expect(s.upcoming.find((r) => r.id === 'run')).toMatchObject({ countdown: 'starting now', actions: [] });
    expect(e.row('run').textContent).toContain('Starting');
    expect(e.row('wait').querySelector('[data-hook="sch-reason"]')?.textContent).toBe('waking floor f1');
    expect(e.row('soon').querySelector('[data-hook="sch-handoff"]')?.getAttribute('title')).toBe('/h/a.md');
    expect(e.row('soon').querySelector('[data-hook="sch-miss"]')?.textContent).toBe('Run late, only if less than 2h late');
    expect(e.row('soon').textContent).toContain('Claude Code · claude-opus-5-5 · high');
    expect(e.row('soon').textContent).toContain('/home/dev/herdr-3d');
    // Needs attention: the reason; Retry and Dismiss.
    expect(s.attention[0]?.actions).toEqual(['retry', 'dismiss']);
    expect(e.row('fail').querySelector('[data-hook="sch-reason"]')?.textContent).toBe('floor f1 is gone');
    // Done: a late badge past the grace; the way to the worker only while it is here.
    expect(s.done.find((r) => r.id === 'late')?.late).toBe('+3h late');
    expect(s.done.find((r) => r.id === 'ok')?.late).toBeNull();
    expect(s.done.find((r) => r.id === 'ok')?.actions).toEqual(['go']);
    expect(s.done.find((r) => r.id === 'late')?.actions).toEqual([]);
    expect(e.btn('ok', 'go').textContent).toBe('Go to Worker w-here');
    e.btn('ok', 'go').click();
    expect(e.calls).toEqual(['go:w-here']);
    expect(e.dlg.isOpen).toBe(false);
  });

  it('a Run now before its time is no late run', () => {
    const e = setup([sched('early', { state: 'done', due_at: T + 5 * H, fired_at: T })]);
    e.dlg.open({ floor: 'f1' });
    expect(e.dlg.summary().done[0]?.late).toBeNull();
  });

  it('empty states: each section, the whole dialog, and a bridge before schedules', () => {
    const e = setup([sched('a')]);
    e.dlg.open({ floor: 'f1' });
    const texts = [...document.querySelectorAll('.sch-sec-empty')].map((p) => p.textContent);
    expect(texts).toEqual(['Nothing needs you.', 'None has started yet.']);
    e.dlg.open({ floor: 'f2' });
    expect(e.dlg.summary().empty).toBe('No scheduled agents on pastry.');
    expect(document.querySelectorAll('.sch-sec')).toHaveLength(0);
    const old = setup([], { known: false });
    old.dlg.open({ floor: 'f1' });
    expect(old.dlg.summary().empty).toBe('This herdr-world can’t schedule agents yet.');
    expect(document.querySelector('[data-key="new"]')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('All floors groups the rows by Building › floor; outside a floor it opens on all of them', () => {
    const e = setup(mix());
    e.dlg.open({ floor: 'f1' });
    expect(e.dlg.summary().upcoming.map((r) => r.id)).not.toContain('other');
    const toggle = document.querySelector<HTMLButtonElement>('[data-key="all-floors"]')!;
    toggle.click();
    let s = e.dlg.summary();
    expect(s.allFloors).toBe(true);
    expect(document.querySelector('[data-key="all-floors"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(s.groups).toEqual(['Work › herdr-3d', 'Home › pastry']);
    expect(s.upcoming.map((r) => r.id)).toEqual(['run', 'wait', 'soon', 'later', 'other']);
    expect(document.activeElement).toBe(document.querySelector('[data-key="all-floors"]'));
    e.dlg.close();
    e.dlg.open({ floor: null });
    s = e.dlg.summary();
    expect(s.allFloors).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-key="all-floors"]')!.disabled).toBe(true);
  });

  it('“New” and Edit open the form; Run now, Retry and Dismiss send their command and say so', async () => {
    const e = setup(mix());
    e.dlg.open({ floor: 'f1' });
    document.querySelector<HTMLButtonElement>('[data-key="new"]')!.click();
    e.btn('soon', 'edit').click();
    expect(e.calls).toEqual(['create:f1', 'edit:soon']);
    e.btn('soon', 'run-now').click();
    expect(e.btn('soon', 'run-now').disabled).toBe(true); // on its way
    await e.flush();
    e.btn('fail', 'retry').click();
    await e.flush();
    e.btn('skip', 'dismiss').click();
    await e.flush();
    expect(e.sent).toEqual([
      { t: 'schedule.run_now', args: { id: 'soon' } },
      { t: 'schedule.retry', args: { id: 'fail' } },
      { t: 'schedule.dismiss', args: { id: 'skip' } },
    ]);
    expect(e.dlg.summary().status).toBe('Dismissed “Task skip”.');
  });

  it('Cancel asks first in its row: Keep it (or Esc) steps back, the confirm sends it', async () => {
    const e = setup(mix());
    e.dlg.open({ floor: 'f1' });
    e.btn('wait', 'cancel').click();
    expect(e.dlg.summary().confirming).toBe('wait');
    expect(e.row('wait').textContent).toContain('Cancel “Task wait”? It will not start');
    expect(document.activeElement).toBe(e.btn('wait', 'keep'));
    e.btn('wait', 'keep').click();
    expect(e.dlg.summary().confirming).toBeNull();
    expect(document.activeElement).toBe(e.btn('wait', 'cancel'));
    e.btn('wait', 'cancel').click();
    const esc = new Event('cancel', { cancelable: true });
    document.querySelector('dialog')!.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(e.dlg.summary().confirming).toBeNull();
    e.btn('wait', 'cancel').click();
    e.btn('wait', 'confirm-cancel').click();
    await e.flush();
    expect(e.sent).toEqual([{ t: 'schedule.cancel', args: { id: 'wait' } }]);
    expect(e.dlg.summary().status).toBe('Cancelled “Task wait”.');
  });

  it('a refused command is said inline, in the dialog', async () => {
    const e = setup(mix(), { replies: { 'schedule.run_now': { ok: false, code: 'invalid_state', message: 'invalid state: schedule soon is waiting; schedule.run_now needs it scheduled' } } });
    e.dlg.open({ floor: 'f1' });
    e.btn('soon', 'run-now').click();
    await e.flush();
    const s = e.dlg.summary();
    expect(s.error).toBe(true);
    expect(s.status).toBe('“Task soon” did not start: it moved on meanwhile (schedule soon is waiting; schedule.run_now needs it scheduled). The list shows where it is now.');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(s.status);
  });

  it('follows upserts and removals live, keeping the focus where it was', () => {
    const e = setup(mix());
    e.dlg.open({ floor: 'f1' });
    e.btn('later', 'edit').focus();
    e.book.upsert(sched('new', { due_at: T + 30 * 60_000, title: 'Just made' }));
    e.book.removed({ t: 'schedule.removed', seq: 1, id: 'skip', floor_id: 'f1' });
    e.book.upsert(sched('soon', { state: 'running', due_at: T + 2 * H, fired_at: T }));
    e.dlg.refresh();
    const s = e.dlg.summary();
    expect(s.upcoming.map((r) => r.id)).toEqual(['run', 'wait', 'new', 'soon', 'later']);
    expect(s.attention.map((r) => r.id)).toEqual(['fail']);
    expect(s.upcoming.find((r) => r.id === 'soon')?.actions).toEqual([]);
    expect(document.activeElement).toBe(e.btn('later', 'edit'));
    // A confirm whose schedule can no longer be cancelled goes.
    e.btn('wait', 'cancel').click();
    e.book.upsert(sched('wait', { state: 'running', fired_at: T }));
    e.dlg.refresh();
    expect(e.dlg.summary().confirming).toBeNull();
  });

  it('opens on a row: its floor, marked and focused', () => {
    const e = setup(mix());
    e.dlg.open({ focus: 'other' });
    const s = e.dlg.summary();
    expect(s.floor).toBe('f2');
    expect(s.allFloors).toBe(false);
    expect(e.row('other').dataset.focus).toBe('true');
    expect(document.activeElement).toBe(e.row('other'));
  });

  it('the countdowns tick while it is open, in place', () => {
    vi.useFakeTimers();
    let now = T;
    const e = setup([sched('a', { due_at: T + 90_000 })]);
    (e.dlg as unknown as { host: { now: () => number } }).host.now = () => now;
    e.dlg.open({ floor: 'f1' });
    const el = e.row('a').querySelector('.sch-countdown')!;
    expect(el.textContent).toBe('in 1 min');
    now += 45_000;
    vi.advanceTimersByTime(1000);
    expect(e.row('a').querySelector('.sch-countdown')).toBe(el);
    expect(el.textContent).toBe('in 45 s');
    e.dlg.close();
    now += 30_000;
    vi.advanceTimersByTime(5000);
    expect(el.textContent).toBe('in 45 s');
  });
});
