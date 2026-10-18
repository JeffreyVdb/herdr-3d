// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
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

/** `create`: `schedule.create`'s answers in turn (then saved); a promise is an answer still on its way. */
function form(o: { on?: boolean; create?: Array<CommandResult | Promise<CommandResult>> } = {}) {
  document.body.replaceChildren();
  const b = secretsBridge({ on: o.on ?? true });
  const answers = [...(o.create ?? [])];
  const schedules = new ScheduleBook();
  schedules.reset([]);
  const handoffs = new HandoffBook();
  handoffs.reset({ counts: {} });
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const toasts: string[] = [];
  const host = {
    store: {
      ...world(),
      schedules,
      handoffs,
      hireOptions: { claude: { models: ['claude-opus-5-5'], efforts: ['high'] } },
      floorView: () => ({ settings: {}, suggested: {} }),
    },
    unsupported: () => false,
    toast: (m: string) => toasts.push(m),
    now: () => T,
    secrets: b.flow,
    send: async (t: string, args: Record<string, unknown>) => {
      sent.push({ t, args });
      if (t === 'hire.prepare') return { ok: true, data: { cwd: '/home/dev', label: 'Pixel', git: null, choice: { harness: 'claude', model: 'claude-opus-5-5', effort: 'high' }, choice_source: 'floor_default', capacity: { floor: { count: 0, soft: 9, hard: 9 }, host: { count: 0, soft: 9, hard: 9 } } } };
      if (t === 'schedule.create') return answers.shift() ?? { ok: true, data: { ...sched(), ...args, id: 'sch_new' } };
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
  /** Esc: the dialog's `cancel`, then its close. */
  const esc = () => {
    document.querySelector<HTMLDialogElement>('dialog.desk-dlg--sched')!.dispatchEvent(new Event('cancel'));
    dlg.close();
  };
  return { b, dlg, sent, fill, save, esc, toasts, of: (t: string) => sent.filter((x) => x.t === t).map((x) => x.args) };
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

  // #108 round 4 fix (D1's audit): a schedule's review is the list's or the form's while it is open; closed meanwhile
  // (closed and opened again too), nothing of it goes and no review opens.
  it('the list closed (or closed and opened again) while a retry’s prompt is scanned: nothing is retried, no review opens', async () => {
    for (const reopen of [false, true]) {
      const e = list(sched({ state: 'failed', state_reason: UNREVIEWED }));
      e.dlg.open({ floor: 'f1' });
      await flush();
      const release = e.b.holdScans();
      e.retry().click();
      await flush();
      e.dlg.close();
      if (reopen) e.dlg.open({ floor: 'f1' });
      release();
      await flush();
      expect(e.b.open()).toBeNull();
      expect(e.retries()).toEqual([]);
      if (reopen) {
        // The list open now says nothing of it, and its Retry is free.
        expect(e.dlg.summary()?.status).toBe('');
        expect(e.retry().disabled).toBe(false);
      }
    }
  });

  it('the form refused as stale, then closed while its prompt is scanned again: saved once, no review opens', async () => {
    const e = form({ create: [{ ok: false, code: 'secrets_review_stale', message: 'stale' }] });
    await e.fill(PROMPT);
    await e.save();
    const release = e.b.holdScans();
    e.b.confirm();
    await flush();
    expect(e.of('schedule.create')).toHaveLength(1);
    e.dlg.close();
    release();
    await flush();
    expect(e.b.open()).toBeNull();
    expect(e.of('schedule.create')).toHaveLength(1);
  });

  // #108 round 4 fix 2 (UX D1's audit): Esc says the schedule is still being saved only while its schedule.create is at the
  // bridge; closed while its prompt is scanned (or scanned again after a refusal), nothing is saved and nothing is said.
  it('the form: Esc while its prompt is scanned, or scanned again after a stale refusal: nothing is said', async () => {
    const first = form();
    await first.fill(PROMPT);
    const release1 = first.b.holdScans();
    await first.save();
    first.esc();
    release1();
    await flush();
    expect(first.b.open()).toBeNull();
    expect(first.of('schedule.create')).toEqual([]);
    expect(first.toasts).toEqual([]);

    const again = form({ create: [{ ok: false, code: 'secrets_review_stale', message: 'stale' }] });
    await again.fill(PROMPT);
    await again.save();
    const release2 = again.b.holdScans();
    again.b.confirm();
    await flush();
    expect(again.of('schedule.create')).toHaveLength(1);
    again.esc();
    release2();
    await flush();
    expect(again.b.open()).toBeNull();
    expect(again.of('schedule.create')).toHaveLength(1);
    expect(again.toasts).toEqual([]);
  });

  it('the form: Esc while its schedule.create is at the bridge says it is still being saved', async () => {
    let answer!: (r: CommandResult) => void;
    const e = form({ create: [new Promise<CommandResult>((r) => (answer = r))] });
    await e.fill(PROMPT);
    await e.save();
    e.b.confirm();
    await flush();
    expect(e.of('schedule.create')).toHaveLength(1);
    e.esc();
    expect(e.toasts).toEqual(['The schedule is still being saved; the list shows it once herdr-world answers.']);
    answer({ ok: true, data: { ...sched(), id: 'sch_new' } });
    await flush();
    expect(e.toasts).toHaveLength(1);
  });

  it('the form: an earlier opening’s save still at the bridge; a newer opening’s Esc during its own scan again says nothing', async () => {
    let answer!: (r: CommandResult) => void;
    const e = form({ create: [new Promise<CommandResult>((r) => (answer = r)), { ok: false, code: 'secrets_review_stale', message: 'stale' }] });
    await e.fill(PROMPT);
    await e.save();
    e.b.confirm();
    await flush();
    e.esc();
    expect(e.toasts).toHaveLength(1);
    await e.fill(PROMPT);
    await e.save();
    const release = e.b.holdScans();
    e.b.confirm();
    await flush();
    expect(e.of('schedule.create')).toHaveLength(2);
    e.esc();
    expect(e.toasts).toHaveLength(1);
    release();
    answer({ ok: true, data: { ...sched(), id: 'sch_new' } });
    await flush();
    expect(e.of('schedule.create')).toHaveLength(2);
    expect(e.toasts).toHaveLength(1);
  });

  it('the form: an earlier opening’s save still at the bridge is that opening’s; a newer one’s Esc during its first scan says nothing', async () => {
    let answer!: (r: CommandResult) => void;
    const e = form({ create: [new Promise<CommandResult>((r) => (answer = r))] });
    await e.fill(PROMPT);
    await e.save();
    e.b.confirm();
    await flush();
    e.esc();
    expect(e.toasts).toHaveLength(1);
    await e.fill(PROMPT);
    const release = e.b.holdScans();
    await e.save();
    e.esc();
    expect(e.toasts).toHaveLength(1);
    release();
    answer({ ok: true, data: { ...sched(), id: 'sch_new' } });
    await flush();
    expect(e.b.open()).toBeNull();
    expect(e.of('schedule.create')).toHaveLength(1);
  });
});
