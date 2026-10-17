// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Building, Floor, HandoffCandidate, HandoffEntry, Schedule } from '../net/protocol';
import { HandoffBook } from '../world/handoff';
import { ScheduleBook } from '../world/schedule';
import type { Draft } from './composer/draft';
import { ScheduleFormDialog, type ScheduleFormHost } from './scheduleForm';

// #64 schedules: the create / edit form: its prefill (hire.prepare, a floor's settings when the floor can't prepare,
// a schedule to edit), the checks that hold Save back, the spec it sends, the cabinet pick, and the transcript path:
// the literal handoff filed once on Save, also across a failed-then-retried create, never on Cancel, and a filing error
// that schedules nothing.

const T = Date.UTC(2026, 9, 17, 7, 0);
const H = 3_600_000;
type Reply = { ok: true; data: unknown } | { ok: false; code: string; message: string };

const PREP = {
  cwd: '/home/dev/herdr-3d',
  label: 'Pixel',
  git: { repo_root: '/home/dev/herdr-3d', default_branch: 'main', base_sha: 'abc1234', base_time: T - H, fetched: true },
  choice: { harness: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  choice_source: 'floor_default',
  capacity: { floor: { count: 1, soft: 24, hard: 32 }, host: { count: 1, soft: 60, hard: 80 } },
};
const CAND: HandoffCandidate = { id: 'cand-1', session: 'sess-1', revision: 'rev-1', harness: 'claude', message: 'msg_01', source: 'message', bytes: 40 };
const ENTRY = (id: number, title: string): HandoffEntry => ({ id, floor: 'f1', title, worker_name: 'Pixel', source: 'literal', path: `/home/dev/handoff/f1/${id}.md`, created_at: T - H, bytes: 10 }) as HandoffEntry;

function sched(o: Partial<Schedule> = {}): Schedule {
  return { id: 'sch_1', floor: 'f1', title: 'After the soak', prompt: 'Delete the backups.', due_at: T + 5 * H, on_miss: 'run_late', max_lateness_ms: 2 * H, harness: 'codex', model: 'gpt-6-sol', effort: 'medium', cwd: '/home/dev/other', worktree: true, wake_floor: false, handoff_path: '/h/old.md', source: { kind: 'manual' }, state: 'scheduled', created_at: T - H, updated_at: T - H, ...o };
}

function setup(o: { replies?: Partial<Record<string, Reply | ((args: Record<string, unknown>) => Reply)>>; floorSettings?: Record<string, unknown> } = {}) {
  document.body.replaceChildren();
  const schedules = new ScheduleBook();
  schedules.reset([]);
  const handoffs = new HandoffBook();
  handoffs.reset({ counts: { f1: 2 } });
  const floors = new Map<string, Floor>([['f1', { id: 'f1', session: 'f1', name: 'herdr-3d', state: 'running', building: 'b1', index: 0 } as Floor]]);
  const buildings = new Map<string, Building>([['b1', { id: 'b1', name: 'Work', sort: 0, floors: ['f1'] } as Building]]);
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const toasts: string[] = [];
  const saved: Array<{ id: string; created: boolean }> = [];
  const host = {
    store: {
      schedules,
      handoffs,
      floors,
      buildings,
      hireOptions: { claude: { models: ['claude-opus-5-5', 'claude-sonnet-5-5'], efforts: ['low', 'high'] }, codex: { models: ['gpt-6-sol'], efforts: ['medium', 'high'] } },
      floorName: (id: string) => floors.get(id)?.name ?? id,
      floorView: () => ({ settings: o.floorSettings ?? {}, suggested: {} }),
      city: () => [{ floors: [{ id: 'f1' }] }],
    },
    unsupported: () => false,
    toast: (m: string) => toasts.push(m),
    now: () => T,
    send: async (t: string, args: Record<string, unknown>) => {
      sent.push({ t, args });
      const r = o.replies?.[t];
      if (typeof r === 'function') return r(args);
      if (r) return r;
      if (t === 'hire.prepare') return { ok: true, data: { ...PREP, cwd: (args.cwd as string) ?? PREP.cwd } };
      if (t === 'schedule.create' || t === 'schedule.update') return { ok: true, data: { ...sched(), ...args, id: (args.id as string) ?? 'sch_new' } };
      if (t === 'worker.handoff') return { ok: true, data: { handoff: { path: '/home/dev/handoff/f1/filed.md' } } };
      if (t === 'handoff.list') return { ok: true, data: { floor: 'f1', handoffs: [ENTRY(1, 'Loader refactor'), ENTRY(2, 'Search')] } };
      return { ok: true, data: {} };
    },
    saved: (s: Schedule, created: boolean) => saved.push({ id: s.id, created }),
  } as unknown as ScheduleFormHost;
  const dlg = new ScheduleFormDialog(document.body, host);
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const q = <E extends HTMLElement>(sel: string) => document.querySelector<E>(sel)!;
  const type = (key: string, v: string) => {
    const el = q<HTMLInputElement>(`[data-key="${key}"]`);
    el.value = v;
    el.dispatchEvent(new Event('input'));
  };
  const prompt = (text: string) => (dlg as unknown as { composer: { getDraft(): Draft } }).composer.getDraft().replace(0, 0, text);
  const pick = (key: string) => {
    const r = q<HTMLInputElement>(`[data-key="${key}"]`);
    r.checked = true;
    r.dispatchEvent(new Event('change'));
  };
  const save = async () => {
    q<HTMLFormElement>('#sf-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
  };
  const of = (t: string) => sent.filter((x) => x.t === t);
  return { dlg, schedules, sent, toasts, saved, flush, q, type, prompt, pick, save, of };
}

describe('ScheduleFormDialog (#64 schedules)', () => {
  beforeEach(() => {
    localStorage.clear();
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
    vi.stubGlobal('CSS', { escape: (s: string) => s });
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('“New” takes the floor’s defaults from hire.prepare, holds Save until the spec is valid, then creates it', async () => {
    const e = setup();
    e.dlg.open({ floor: 'f1' });
    await e.flush();
    let s = e.dlg.summary();
    expect(e.of('hire.prepare')[0]?.args).toEqual({ floor: 'f1' });
    expect(s).toMatchObject({ mode: 'create', floor: 'f1', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', cwd: '/home/dev/herdr-3d', worktree: true, wakeFloor: true, onMiss: 'run_late', handoff: 'none', when: '' });
    expect(s.blocker).toBe('Give it a title.');
    expect(e.q('[data-key="save"]').getAttribute('aria-disabled')).toBe('true');
    expect(e.q('[data-hook="sf-why"]').textContent).toBe('Give it a title.');
    e.type('title', 'After the soak');
    expect(e.dlg.summary().blocker).toMatch(/^Say when/);
    e.type('when', 'in 2h');
    s = e.dlg.summary();
    expect(s.due).toBe(T + 2 * H);
    expect(s.resolved).toContain('UTC');
    expect(s.resolved).toContain('in 2 h');
    expect(s.blocker).toBe('Write the prompt, or attach a handoff for it to read.');
    e.prompt('Delete the backups.');
    expect(e.dlg.summary().blocker).toBeNull();
    expect(e.q('[data-key="save"]').getAttribute('aria-disabled')).toBeNull();
    e.pick('wake');
    const wake = e.q<HTMLInputElement>('[data-key="wake"]');
    wake.checked = false;
    wake.dispatchEvent(new Event('change'));
    e.type('late-hours', '1.5');
    await e.save();
    expect(e.of('schedule.create')[0]?.args).toEqual({
      floor: 'f1',
      title: 'After the soak',
      prompt: 'Delete the backups.',
      due_at: T + 2 * H,
      on_miss: 'run_late',
      max_lateness_ms: 1.5 * H,
      harness: 'claude',
      model: 'claude-opus-5-5',
      effort: 'high',
      cwd: '/home/dev/herdr-3d',
      worktree: true,
      wake_floor: false,
    });
    expect(e.dlg.isOpen).toBe(false);
    expect(e.saved).toEqual([{ id: 'sch_new', created: true }]);
    expect(e.toasts[0]).toMatch(/^Scheduled “After the soak” for /);
  });

  it('says why a time can’t be used, and a past one never enables Save', async () => {
    const e = setup();
    e.dlg.open({ floor: 'f1' });
    await e.flush();
    e.type('title', 'x');
    e.prompt('y');
    e.type('when', 'next tuesday');
    expect(e.q('[data-hook="sf-resolved"]').dataset.error).toBe('true');
    expect(e.dlg.summary().blocker).toMatch(/not a time I can read/);
    e.type('when', '2020-01-01 00:00 UTC');
    expect(e.dlg.summary().blocker).toMatch(/not in the future/);
    e.type('when', 'tomorrow 10:45 UTC');
    expect(e.dlg.summary()).toMatchObject({ due: Date.UTC(2026, 9, 18, 10, 45), blocker: null });
    e.pick('sf-miss:skip');
    expect(document.querySelector('[data-key="late-hours"]')).toBeNull(); // "only if less than … late" is run late's
    // Save with a blocker says it, sends nothing.
    e.type('title', '');
    await e.save();
    expect(e.of('schedule.create')).toEqual([]);
    expect(e.dlg.summary()).toMatchObject({ status: 'Give it a title.', error: true });
  });

  it('the picker fills the field in the zone’s wall clock', async () => {
    const e = setup();
    e.dlg.open({ floor: 'f1' });
    await e.flush();
    const p = e.q<HTMLInputElement>('[data-key="when-picker"]');
    p.value = '2026-10-20T09:30';
    p.dispatchEvent(new Event('change'));
    expect(e.dlg.summary().when).toBe('2026-10-20 09:30');
    expect(e.dlg.summary().due).not.toBeNull();
  });

  it('a floor that can’t prepare (asleep) falls back to its settings and says so', async () => {
    const e = setup({ replies: { 'hire.prepare': { ok: false, code: 'invalid_state', message: 'invalid state: f1 is asleep' } }, floorSettings: { default_hire: { harness: 'codex', model: 'gpt-6-sol', effort: 'high' }, default_cwd: '/home/dev/pastry' } });
    e.dlg.open({ floor: 'f1' });
    await e.flush();
    const s = e.dlg.summary();
    expect(s).toMatchObject({ harness: 'codex', model: 'gpt-6-sol', effort: 'high', cwd: '/home/dev/pastry' });
    expect(s.note).toMatch(/could not prepare this floor now/);
    expect(e.q('[data-hook="sf-prep"]').textContent).toContain('checked when you save');
    // The worktree is a plain choice then.
    expect(e.q('#sf-worktree')).toBeTruthy();
  });

  it('Edit opens the schedule as it is, sends the whole spec without source, and keeps its handoff', async () => {
    const e = setup();
    const s0 = sched();
    e.schedules.upsert(s0);
    e.dlg.open({ floor: 'f1', edit: s0 });
    await e.flush();
    const s = e.dlg.summary();
    expect(s).toMatchObject({ mode: 'edit', title: 'After the soak', harness: 'codex', model: 'gpt-6-sol', effort: 'medium', cwd: '/home/dev/other', worktree: true, wakeFloor: false, maxLateHours: '2', handoff: 'keep', handoffPath: '/h/old.md', due: T + 5 * H });
    expect(e.of('hire.prepare')[0]?.args).toEqual({ floor: 'f1', cwd: '/home/dev/other' });
    expect(e.q<HTMLSelectElement>('[data-key="floor"]').disabled).toBe(true);
    e.type('title', 'Renamed');
    await e.save();
    const a = e.of('schedule.update')[0]?.args;
    expect(a).toMatchObject({ id: 'sch_1', floor: 'f1', title: 'Renamed', due_at: T + 5 * H, harness: 'codex', handoff_path: '/h/old.md', wake_floor: false, max_lateness_ms: 2 * H });
    expect(a).not.toHaveProperty('source');
    expect(e.saved).toEqual([{ id: 'sch_1', created: false }]);
  });

  it('an edited schedule that moves on or goes is said in the form, and Save stays off', async () => {
    const e = setup();
    const s0 = sched();
    e.schedules.upsert(s0);
    e.dlg.open({ floor: 'f1', edit: s0 });
    await e.flush();
    e.schedules.upsert(sched({ state: 'waiting' }));
    e.dlg.refresh();
    expect(e.q('[data-hook="sf-stale"]').textContent).toBe('This schedule is waiting now: only one that is still scheduled can be edited.');
    expect(e.dlg.summary().blocker).toMatch(/waiting now/);
    e.schedules.removed({ t: 'schedule.removed', seq: 1, id: 'sch_1' });
    e.dlg.refresh();
    expect(e.q('[data-hook="sf-stale"]').textContent).toMatch(/cancelled or removed/);
    await e.save();
    expect(e.of('schedule.update')).toEqual([]);
  });

  it('picks a handoff from the floor’s cabinet, searching like the cabinet (a late answer is dropped)', async () => {
    vi.useFakeTimers();
    let release: ((r: Reply) => void) | null = null;
    const e = setup({
      replies: {
        'handoff.list': (args) => (args.q === 'lo' ? ({ __slow: true } as unknown as Reply) : { ok: true, data: { floor: 'f1', handoffs: args.q ? [ENTRY(1, 'Loader refactor')] : [ENTRY(1, 'Loader refactor'), ENTRY(2, 'Search')] } }),
      },
    });
    // A slow first search: its answer comes after a newer one and must not win.
    const send = (e.dlg as unknown as { host: ScheduleFormHost }).host.send.bind((e.dlg as unknown as { host: ScheduleFormHost }).host);
    (e.dlg as unknown as { host: { send: unknown } }).host.send = (t: string, args: Record<string, unknown>) => (t === 'handoff.list' && args.q === 'lo' ? new Promise((r) => (release = r as never)) : send(t as never, args as never));
    e.dlg.open({ floor: 'f1' });
    await vi.advanceTimersByTimeAsync(50);
    e.pick('sf-handoff:cabinet');
    await vi.advanceTimersByTimeAsync(50);
    expect(e.dlg.summary().cabinet.map((c) => c.id)).toEqual([1, 2]);
    expect(e.dlg.summary().blocker).toBe('Give it a title.');
    e.type('title', 'Go on');
    e.type('when', 'in 1h');
    expect(e.dlg.summary().blocker).toBe('Pick a handoff from the cabinet, or choose None.');
    e.type('cab-search', 'lo');
    await vi.advanceTimersByTimeAsync(200);
    e.type('cab-search', 'loader');
    await vi.advanceTimersByTimeAsync(200);
    expect(e.dlg.summary().cabinet.map((c) => c.id)).toEqual([1]);
    release!({ ok: true, data: { floor: 'f1', handoffs: [ENTRY(9, 'Stale')] } });
    await vi.advanceTimersByTimeAsync(50);
    expect(e.dlg.summary().cabinet.map((c) => c.id)).toEqual([1]);
    e.q<HTMLButtonElement>('.sf-cab-row[data-id="1"]').click();
    expect(e.dlg.summary()).toMatchObject({ handoffPath: '/home/dev/handoff/f1/1.md', blocker: null }); // an empty prompt is fine with a handoff
    e.q<HTMLFormElement>('#sf-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.advanceTimersByTimeAsync(50);
    expect(e.of('schedule.create')[0]?.args).toMatchObject({ prompt: '', handoff_path: '/home/dev/handoff/f1/1.md' });
    vi.useRealTimers();
  });

  describe('from a transcript row', () => {
    const open = (e: ReturnType<typeof setup>) =>
      e.dlg.open({ floor: 'f1', prefill: { choice: { harness: 'codex', model: 'gpt-6-sol', effort: 'high' }, cwd: '/home/dev/wt/pixel', transcript: { worker: 'w-1', name: 'Pixel', candidate: CAND } } });
    const fill = (e: ReturnType<typeof setup>) => {
      e.type('title', 'Follow up');
      e.type('when', 'in 24h');
    };

    it('prefills the source worker’s choice and folder, no time, an empty prompt, the message attached', async () => {
      const e = setup();
      open(e);
      await e.flush();
      expect(e.of('hire.prepare')[0]?.args).toEqual({ floor: 'f1', cwd: '/home/dev/wt/pixel' });
      const s = e.dlg.summary();
      expect(s).toMatchObject({ harness: 'codex', model: 'gpt-6-sol', effort: 'high', cwd: '/home/dev/wt/pixel', when: '', due: null, handoff: 'transcript' });
      expect(e.q('#sf-title').textContent).toBe('Schedule a follow-up to Pixel');
      expect(e.q('[data-hook="sf-attach"]').textContent).toMatch(/^Attach this message as a handoff/);
      expect(e.q('[data-key="save"]').textContent).toBe('File and schedule');
    });

    it('files the literal handoff once on Save, then creates with its path and the source', async () => {
      const e = setup();
      open(e);
      await e.flush();
      fill(e);
      await e.save();
      expect(e.of('worker.handoff').map((x) => x.args)).toEqual([{ worker: 'w-1', mode: 'literal', session: 'sess-1', candidate: 'cand-1', revision: 'rev-1', op: expect.stringMatching(/^ho-/) }]);
      expect(e.of('schedule.create')[0]?.args).toMatchObject({ prompt: '', handoff_path: '/home/dev/handoff/f1/filed.md', source: { kind: 'transcript', worker: 'w-1', message: 'msg_01' } });
      expect(e.sent.map((x) => x.t).filter((t) => t !== 'hire.prepare')).toEqual(['worker.handoff', 'schedule.create']);
    });

    it('a failed create keeps the form; saving again does not file twice', async () => {
      let n = 0;
      const e = setup({ replies: { 'schedule.create': (a) => (++n === 1 ? { ok: false, code: 'busy', message: 'busy: cwd /home/dev/wt/pixel is in the worktree /home/dev/wt/pixel, which is being removed (sending Pixel home)' } : { ok: true, data: { ...sched(), ...a, id: 'sch_new' } }) } });
      open(e);
      await e.flush();
      fill(e);
      await e.save();
      expect(e.dlg.isOpen).toBe(true);
      expect(e.dlg.summary()).toMatchObject({ error: true, handoffPath: '/home/dev/handoff/f1/filed.md' });
      expect(e.dlg.summary().status).toMatch(/^“Follow up” was not scheduled: cwd .* being removed \(sending Pixel home\)\. Try again in a moment\. The message is filed; saving again uses it\.$/);
      expect(e.q('[data-key="save"]').textContent).toBe('Schedule');
      await e.save();
      expect(e.of('worker.handoff')).toHaveLength(1);
      expect(e.of('schedule.create')).toHaveLength(2);
      expect(e.of('schedule.create')[1]?.args.handoff_path).toBe('/home/dev/handoff/f1/filed.md');
      expect(e.dlg.isOpen).toBe(false);
    });

    it('an unanswered filing is sent again with the same op (the bridge answers existing)', async () => {
      let n = 0;
      const e = setup({ replies: { 'worker.handoff': () => (++n === 1 ? { ok: false, code: 'timeout', message: 'herdr-world did not answer worker.handoff within 10 s' } : { ok: true, data: { handoff: { path: '/home/dev/handoff/f1/filed.md' }, existing: true } }) } });
      open(e);
      await e.flush();
      fill(e);
      await e.save();
      expect(e.of('schedule.create')).toEqual([]);
      await e.save();
      const ops = e.of('worker.handoff').map((x) => x.args.op);
      expect(ops).toHaveLength(2);
      expect(ops[0]).toBe(ops[1]);
      expect(e.of('schedule.create')).toHaveLength(1);
    });

    it('a filing error schedules nothing and keeps the form open with the error', async () => {
      const e = setup({ replies: { 'worker.handoff': { ok: false, code: 'handoff_unavailable', message: 'no such handoff candidate: a newer turn started' } } });
      open(e);
      await e.flush();
      fill(e);
      await e.save();
      expect(e.dlg.isOpen).toBe(true);
      expect(e.of('schedule.create')).toEqual([]);
      expect(e.dlg.summary()).toMatchObject({ error: true, status: 'Pixel’s last reply can’t be filed now: a newer turn started. Nothing was filed. Nothing was scheduled.' });
    });

    it('Cancel files nothing; None schedules without it (and then a prompt is needed)', async () => {
      const e = setup();
      open(e);
      await e.flush();
      fill(e);
      e.q<HTMLButtonElement>('[data-key="cancel"]').click();
      expect(e.dlg.isOpen).toBe(false);
      expect(e.sent.map((x) => x.t)).toEqual(['hire.prepare']);
      open(e);
      await e.flush();
      fill(e);
      e.pick('sf-handoff:none');
      expect(e.dlg.summary().blocker).toBe('Write the prompt, or attach a handoff for it to read.');
      e.prompt('Check the soak.');
      await e.save();
      expect(e.of('worker.handoff')).toEqual([]);
      expect(e.of('schedule.create')[0]?.args).not.toHaveProperty('handoff_path');
      expect(e.of('schedule.create')[0]?.args.source).toEqual({ kind: 'transcript', worker: 'w-1', message: 'msg_01' });
    });
  });
});
