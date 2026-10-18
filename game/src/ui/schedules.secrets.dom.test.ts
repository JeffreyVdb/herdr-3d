// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Building, Floor, Schedule } from '../net/protocol';
import { flush, installDialogs, secretsBridge } from '../test/secretsBridge';
import { HandoffBook } from '../world/handoff';
import { ScheduleBook } from '../world/schedule';
import type { Draft } from './composer/draft';
import type { DialogHost } from './hire';
import { ScheduleFormDialog, type ScheduleFormHost } from './scheduleForm';
import { SchedulesDialog, type SchedulesHost } from './schedules';
import { STORED_REASON } from './secretsFlow';

// #108 round 4: a schedule's prompt is stored: reviewed with every match ignored and nothing protectable (Protect says
// why), saved with that review; a schedule its check failed is retried with a review of its stored prompt.

const T = Date.UTC(2026, 9, 17, 7, 0);
const H = 3_600_000;
const PROMPT = 'Rotate the backups with TOKEN=ghp_abcdefghijklmnopqrstu1 tonight';
const UNREVIEWED = 'its prompt was not reviewed for secrets: it has 1 possible secret that “Review prompt secrets before sending” has not seen left as typed (saved before the switch was on, or the rules changed): open the schedule, review them and retry it; nothing was sent';

function sched(o: Partial<Schedule> = {}): Schedule {
  return { id: 'sch_1', floor: 'f1', title: 'Nightly', prompt: PROMPT, due_at: T + H, on_miss: 'run_late', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', cwd: '/home/dev', worktree: false, wake_floor: true, source: { kind: 'manual' }, state: 'scheduled', created_at: T - H, updated_at: T - H, ...o };
}

function world() {
  const floors = new Map<string, Floor>([['f1', { id: 'f1', session: 'f1', name: 'herdr-3d', state: 'running', building: 'b1', index: 0 } as Floor]]);
  const buildings = new Map<string, Building>([['b1', { id: 'b1', name: 'Work', sort: 0, floors: ['f1'] } as Building]]);
  return { floors, buildings, floorName: (id: string) => floors.get(id)?.name ?? id, city: () => [{ floors: [{ id: 'f1' }] }] };
}

function form(o: { on?: boolean } = {}) {
  document.body.replaceChildren();
  const b = secretsBridge({ on: o.on ?? true });
  const schedules = new ScheduleBook();
  schedules.reset([]);
  const handoffs = new HandoffBook();
  handoffs.reset({ counts: {} });
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const host = {
    store: {
      ...world(),
      schedules,
      handoffs,
      hireOptions: { claude: { models: ['claude-opus-5-5'], efforts: ['high'] } },
      floorView: () => ({ settings: {}, suggested: {} }),
    },
    unsupported: () => false,
    toast: () => {},
    now: () => T,
    secrets: b.flow,
    send: async (t: string, args: Record<string, unknown>) => {
      sent.push({ t, args });
      if (t === 'hire.prepare') return { ok: true, data: { cwd: '/home/dev', label: 'Pixel', git: null, choice: { harness: 'claude', model: 'claude-opus-5-5', effort: 'high' }, choice_source: 'floor_default', capacity: { floor: { count: 0, soft: 9, hard: 9 }, host: { count: 0, soft: 9, hard: 9 } } } };
      if (t === 'schedule.create') return { ok: true, data: { ...sched(), ...args, id: 'sch_new' } };
      return { ok: true, data: {} };
    },
  } as unknown as ScheduleFormHost;
  const dlg = new ScheduleFormDialog(document.body, host);
  const fill = async (prompt: string) => {
    dlg.open({ floor: 'f1' });
    await flush();
    for (const [k, v] of [
      ['title', 'Nightly'],
      ['when', 'in 2h'],
    ]) {
      const el = document.querySelector<HTMLInputElement>(`[data-key="${k}"]`)!;
      el.value = v as string;
      el.dispatchEvent(new Event('input'));
    }
    (dlg as unknown as { composer: { getDraft(): Draft } }).composer.getDraft().replace(0, 0, prompt);
  };
  const save = async () => {
    document.querySelector<HTMLFormElement>('#sf-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
  };
  return { b, dlg, sent, fill, save, of: (t: string) => sent.filter((x) => x.t === t).map((x) => x.args) };
}

function list(s: Schedule, o: { on?: boolean } = {}) {
  document.body.replaceChildren();
  const b = secretsBridge({ on: o.on ?? true });
  const book = new ScheduleBook();
  book.reset([s]);
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const host = {
    store: { ...world(), schedules: book, workers: new Map(), workerView: () => null },
    unsupported: () => false,
    toast: () => {},
    now: () => T,
    secrets: b.flow,
    send: async (t: string, args: Record<string, unknown>) => (sent.push({ t, args }), { ok: true, data: {} }),
    create: () => {},
    edit: () => {},
    goTo: () => {},
  } as unknown as SchedulesHost & DialogHost;
  const dlg = new SchedulesDialog(document.body, host);
  const retry = () => document.querySelector<HTMLButtonElement>(`.sch-row[data-id="${s.id}"] [data-act="retry"]`)!;
  return { b, dlg, sent, retry, retries: () => sent.filter((x) => x.t === 'schedule.retry').map((x) => x.args) };
}

describe('schedules and prompt secrets (#108 round 4)', () => {
  beforeEach(() => {
    localStorage.clear();
    installDialogs();
    vi.stubGlobal('CSS', { escape: (s: string) => s });
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('the form’s Save: the stored review first (every match ignored, Protect refused with why), saved with it as typed', async () => {
    const e = form();
    await e.fill(PROMPT);
    await e.save();
    expect(e.b.open()).toMatchObject({ stored: STORED_REASON, action: 'Confirm and save', target: '“Nightly”', counts: { protect: 0, ignore: 1 } });
    expect(e.of('schedule.create')).toEqual([]);
    e.b.confirm();
    await flush();
    const [args] = e.of('schedule.create');
    expect(args).toMatchObject({ title: 'Nightly', prompt: PROMPT, secrets: { decisions: [{ candidate: 'c1', action: 'ignore' }] } });
    expect(e.b.gate(PROMPT, args!.secrets, 'schedule', { stored: true })).toMatchObject({ protected: 0, text: PROMPT });
  });

  it('Cancel saves nothing (the prompt stays); a clean prompt saves as today; off: no scan', async () => {
    const e = form();
    await e.fill(PROMPT);
    await e.save();
    e.b.cancel();
    await flush();
    expect(e.of('schedule.create')).toEqual([]);
    expect(e.dlg.summary()).toMatchObject({ status: 'Not saved: the prompt is still here.', saving: false });
    const c = form();
    await c.fill('Rotate the backups tonight');
    await c.save();
    expect(c.b.open()).toBeNull();
    expect(c.of('schedule.create')[0]).not.toHaveProperty('secrets');
    const off = form({ on: false });
    await off.fill(PROMPT);
    expect(document.querySelector('[data-key="review"]')).toBeNull();
    await off.save();
    expect(off.b.scans).toEqual([]);
    expect(off.of('schedule.create')).toHaveLength(1);
  });

  it('a schedule its check failed: “Review and retry” opens the stored review with why, and retries with it', async () => {
    const e = list(sched({ state: 'failed', state_reason: UNREVIEWED }));
    e.dlg.open({ floor: 'f1' });
    await flush();
    expect(e.retry().textContent).toBe('Review and retry');
    e.retry().click();
    await flush();
    expect(e.b.open()).toMatchObject({ stored: STORED_REASON, notice: expect.stringMatching(/^Its prompt was not reviewed for secrets\./), counts: { ignore: 1 } });
    expect(e.retries()).toEqual([]);
    e.b.confirm();
    await flush();
    const [args] = e.retries();
    expect(args).toMatchObject({ id: 'sch_1', secrets: { decisions: [{ candidate: 'c1', action: 'ignore' }] } });
    expect(e.b.gate(PROMPT, args!.secrets, 'schedule', { stored: true })).toMatchObject({ protected: 0 });
  });

  it('Cancel on that review retries nothing; off, Retry is today’s (no review)', async () => {
    const e = list(sched({ state: 'failed', state_reason: UNREVIEWED }));
    e.dlg.open({ floor: 'f1' });
    await flush();
    e.retry().click();
    await flush();
    e.b.cancel();
    await flush();
    expect(e.retries()).toEqual([]);
    expect(e.dlg.summary()?.status).toBe('“Nightly” was not retried: the review was cancelled.');
    const off = list(sched({ state: 'failed', state_reason: 'herdr failed' }), { on: false });
    off.dlg.open({ floor: 'f1' });
    await flush();
    expect(off.retry().textContent).toBe('Retry');
    off.retry().click();
    await flush();
    expect(off.retries()).toEqual([{ id: 'sch_1' }]);
  });
});
