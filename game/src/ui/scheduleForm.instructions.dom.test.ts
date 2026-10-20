// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { Building, Floor, HandoffCandidate, Schedule } from '../net/protocol';
import { flush, installDialogs, secretsBridge } from '../test/secretsBridge';
import { HandoffBook } from '../world/handoff';
import { ScheduleBook } from '../world/schedule';
import type { Draft } from './composer/draft';
import { INSTRUCTIONS_HINT_OFF, INSTRUCTIONS_HINT_ON } from './hireInstructions';
import { SCHEDULE_ASK_TEXT, SCHEDULE_LINES_MISSING, ScheduleFormDialog, type ScheduleFormHost, type ScheduleFormOpen } from './scheduleForm';

// #127: the schedule form's "Add herdr hiring instructions" (off for a new schedule, an edit's as saved, never ticked by a
// prefill) and Save's question: after the secrets review, with the box off, the classifier (`hire_preset.check`) and, on
// a "yes", "Schedule with instructions" / "Schedule without" in the dialog before anything is filed or saved.

const T = Date.UTC(2026, 9, 17, 7, 0);
const H = 3_600_000;
const LINES = 'Start every agent you hire in its own herdr workspace or tab.\n\nAlso tag every herdr workspace you create with the token h3d_floor=f1.';
const TASK = 'Roll the upgrade out: start an agent for each service.';
const PLAIN = 'Delete the backups.';
const CAND: HandoffCandidate = { id: 'cand-1', session: 'sess-1', revision: 'rev-1', harness: 'claude', message: 'msg_01', source: 'message', bytes: 40 };
const enc = new TextEncoder();

function sched(o: Partial<Schedule> = {}): Schedule {
  return { id: 'sch_1', floor: 'f1', title: 'Rollout', prompt: TASK, due_at: T + 5 * H, on_miss: 'run_late', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', cwd: '/home/dev', worktree: false, wake_floor: true, source: { kind: 'manual' }, state: 'scheduled', created_at: T - H, updated_at: T - H, ...o };
}

interface Opts {
  /** The bridge takes the flag (`schedule_herdr_instructions`; default true). */
  instructions?: boolean;
  /** `hire.prepare`'s lines (null: it fails, an asleep floor). */
  lines?: string | null;
  classifier?: string | null;
  /** What `hire_preset.check` answers (default: a yes). */
  check?: (args: Record<string, unknown>) => CommandResult | Promise<CommandResult>;
  unsupported?: string[];
  secrets?: boolean;
  list?: Schedule[];
  /** `schedule.create`'s answers in turn (then saved). */
  create?: CommandResult[];
}

function setup(o: Opts = {}) {
  document.body.replaceChildren();
  const b = o.secrets ? secretsBridge({ on: true }) : null;
  const schedules = new ScheduleBook();
  schedules.reset(o.list ?? [], o.instructions ?? true);
  const handoffs = new HandoffBook();
  handoffs.reset({ counts: {} });
  const floors = new Map<string, Floor>([['f1', { id: 'f1', session: 'f1', name: 'herdr-3d', state: 'running', building: 'b1', index: 0 } as Floor]]);
  const buildings = new Map<string, Building>([['b1', { id: 'b1', name: 'Work', sort: 0, floors: ['f1'] } as Building]]);
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const lines = o.lines === undefined ? LINES : o.lines;
  const creates = [...(o.create ?? [])];
  const host = {
    store: {
      schedules,
      handoffs,
      floors,
      buildings,
      hireOptions: { claude: { models: ['claude-opus-5-5'], efforts: ['high'] } },
      floorName: (id: string) => floors.get(id)?.name ?? id,
      floorView: () => ({ settings: { default_hire: { harness: 'claude', model: 'claude-opus-5-5', effort: 'high' }, default_cwd: '/home/dev' }, suggested: {} }),
      city: () => [{ floors: [{ id: 'f1' }] }],
      ...(o.classifier === null ? {} : { ai: { state: { classifier: { state: o.classifier ?? 'ready' } } } }),
    },
    upload: async () => ({ ok: true, data: { path: '/drop/image.png' } }),
    unsupported: (t: string) => !!o.unsupported?.includes(t),
    toast: () => {},
    now: () => T,
    ...(b ? { secrets: b.flow } : {}),
    send: async (t: string, args: Record<string, unknown>) => {
      sent.push({ t, args });
      if (t === 'hire.prepare') {
        if (lines === null) return { ok: false, code: 'floor_asleep', message: 'floor asleep' };
        return { ok: true, data: { cwd: '/home/dev', label: 'Pixel', git: null, choice: { harness: 'claude', model: 'claude-opus-5-5', effort: 'high' }, choice_source: 'floor_default', capacity: { floor: { count: 0, soft: 9, hard: 9 }, host: { count: 0, soft: 9, hard: 9 } }, herdr_instructions: lines } };
      }
      if (t === 'hire_preset.check') return o.check ? o.check(args) : { ok: true, data: { delegates: true, score: 0.9 } };
      if (t === 'schedule.create' && creates.length) return creates.shift();
      if (t === 'schedule.create' || t === 'schedule.update') return { ok: true, data: { ...sched(), ...args, id: (args.id as string) ?? 'sch_new' } };
      if (t === 'worker.handoff') return { ok: true, data: { handoff: { path: '/home/dev/handoff/f1/filed.md' } } };
      return { ok: true, data: {} };
    },
  } as unknown as ScheduleFormHost;
  const dlg = new ScheduleFormDialog(document.body, host);
  const q = <E extends HTMLElement>(sel: string) => document.querySelector<E>(`dialog.desk-dlg--sched ${sel}`);
  const type = (key: string, v: string) => {
    const el = q<HTMLInputElement>(`[data-key="${key}"]`)!;
    el.value = v;
    el.dispatchEvent(new Event('input'));
  };
  const draft = () => (dlg as unknown as { composer: { getDraft(): Draft } }).composer.getDraft();
  const open = async (oo: Partial<ScheduleFormOpen> = {}, prompt: string | null = TASK) => {
    dlg.open({ floor: 'f1', ...oo });
    await flush();
    if (!oo.edit) {
      if (!oo.prefill?.title) type('title', 'Rollout');
      type('when', 'in 2h');
    }
    if (prompt !== null) draft().replace(0, 0, prompt);
    await flush();
  };
  const save = async () => {
    document.querySelector<HTMLFormElement>('#sf-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
  };
  const press = async (key: string) => {
    q<HTMLElement>(`[data-key="${key}"]`)!.click();
    await flush();
  };
  const tick = (on: boolean) => {
    const box = q<HTMLInputElement>('#sf-instructions')!;
    box.checked = on;
    box.dispatchEvent(new Event('change'));
  };
  const esc = () => {
    const e = new Event('cancel', { cancelable: true });
    document.querySelector('dialog.desk-dlg--sched')!.dispatchEvent(e);
    if (!e.defaultPrevented) dlg.close();
    return e;
  };
  const of = (t: string) => sent.filter((x) => x.t === t).map((x) => x.args);
  const ask = () => q<HTMLElement>('[data-hook="sf-ask"]');
  return { b, dlg, sent, q, type, draft, open, save, press, tick, esc, of, ask };
}

describe('ScheduleFormDialog: herdr hiring instructions (#127)', () => {
  beforeEach(() => {
    localStorage.clear();
    installDialogs();
    vi.stubGlobal('CSS', { escape: (s: string) => s });
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('a new schedule has the box off; ticked, “What’s added” shows the floor’s lines and the bytes, and Save sends the flag without asking', async () => {
    const e = setup({ classifier: null });
    await e.open({}, PLAIN);
    expect(e.dlg.summary().instructions).toEqual({ on: false, lines: LINES });
    expect(e.q('[data-hook="instructions"]')?.getAttribute('data-on')).toBe('false');
    expect(e.q('#sf-instructions-hint')?.textContent).toBe(INSTRUCTIONS_HINT_OFF);
    expect(e.q('[data-hook="instructions-lines"]')).toBeNull();
    e.tick(true);
    expect(e.q('#sf-instructions-hint')?.textContent).toBe(INSTRUCTIONS_HINT_ON);
    expect(e.q('[data-hook="instructions-lines"] pre')?.textContent).toBe(LINES);
    const total = enc.encode(PLAIN).length + 2 + enc.encode(LINES).length;
    expect(e.q('[data-hook="instructions-bytes"]')?.textContent).toBe(`With them, the prompt is ${total} of 32,768 bytes.`);
    // Typing keeps the count current.
    e.draft().replace(PLAIN.length, PLAIN.length, ' Now.');
    await flush();
    expect(e.q('[data-hook="instructions-bytes"]')?.textContent).toBe(`With them, the prompt is ${total + 5} of 32,768 bytes.`);
    await e.save();
    expect(e.of('hire_preset.check')).toEqual([]);
    expect(e.of('schedule.create')).toEqual([expect.objectContaining({ prompt: `${PLAIN} Now.`, herdr_instructions: true })]);
  });

  it('a follow-up or a suggestion’s prefill never ticks it', async () => {
    for (const prefill of [{ title: 'Follow up', transcript: { worker: 'A', name: 'Pixel', candidate: CAND } }, { title: 'Check the soak', prompt: TASK, source: { kind: 'suggestion' as const, worker: 'A', message: 'm1' } }]) {
      const e = setup();
      await e.open({ prefill }, null);
      expect(e.dlg.summary().instructions?.on).toBe(false);
    }
  });

  it('when hire.prepare cannot answer (an asleep floor), the box stays and “What’s added” says the lines come when it starts', async () => {
    const e = setup({ lines: null, classifier: 'not_configured' });
    await e.open({}, PLAIN);
    expect(e.dlg.summary().instructions).toEqual({ on: false, lines: null });
    e.tick(true);
    expect(e.q('[data-hook="instructions-missing"]')?.textContent).toBe(SCHEDULE_LINES_MISSING);
    expect(e.q('[data-hook="instructions-lines"] pre')).toBeNull();
    // No size the form can know: the bridge's check at Save is the one.
    e.draft().replace(0, PLAIN.length, 'x'.repeat(32 * 1024 - 10));
    await flush();
    expect(e.dlg.summary().blocker).toBeNull();
    await e.save();
    expect(e.of('schedule.create')[0]).toMatchObject({ herdr_instructions: true });
  });

  it('the size blocker: the prompt with the lines over 32 KiB holds Save, with the hire form’s reason', async () => {
    const e = setup();
    const room = 32 * 1024 - 2 - enc.encode(LINES).length;
    await e.open({}, 'x'.repeat(room + 3));
    e.tick(true);
    expect(e.dlg.summary().blocker).toBe('With the herdr hiring instructions, the prompt is 3 bytes over 32 KiB. Shorten it, or untick Add herdr hiring instructions.');
    await e.save();
    expect(e.of('schedule.create')).toEqual([]);
    e.tick(false);
    expect(e.dlg.summary().blocker).toBeNull();
  });

  it('Edit seeds the box from the saved schedule and sends it unchanged; an unchanged prompt is not asked about', async () => {
    const on = sched({ herdr_instructions: true });
    const e = setup({ list: [on] });
    await e.open({ edit: on }, null);
    expect(e.dlg.summary().instructions?.on).toBe(true);
    e.type('title', 'Rollout, later');
    await e.save();
    expect(e.of('schedule.update')).toEqual([expect.objectContaining({ id: 'sch_1', herdr_instructions: true })]);

    const off = sched();
    const f = setup({ list: [off] });
    await f.open({ edit: off }, null);
    expect(f.dlg.summary().instructions?.on).toBe(false);
    f.type('title', 'Rollout, later');
    await f.save();
    // Saved off with this prompt: its choice stands, no question.
    expect(f.of('hire_preset.check')).toEqual([]);
    expect(f.of('schedule.update')[0]).not.toHaveProperty('herdr_instructions');

    // A changed prompt with the box off asks.
    const g = setup({ list: [off] });
    await g.open({ edit: off }, 'Then ');
    await g.save();
    expect(g.of('hire_preset.check')).toEqual([{ prompt: `Then ${TASK}` }]);
    expect(g.ask()).not.toBeNull();
    expect(g.of('schedule.update')).toEqual([]);
  });

  it('an older bridge: no box, no question, and no field sent', async () => {
    const e = setup({ instructions: false });
    await e.open();
    expect(e.q('[data-hook="instructions"]')).toBeNull();
    expect(e.dlg.summary().instructions).toBeNull();
    await e.save();
    expect(e.of('hire_preset.check')).toEqual([]);
    expect(e.of('schedule.create')[0]).not.toHaveProperty('herdr_instructions');
    const old = sched({ herdr_instructions: true });
    const f = setup({ instructions: false, list: [old] });
    await f.open({ edit: old }, null);
    await f.save();
    expect(f.of('schedule.update')[0]).not.toHaveProperty('herdr_instructions');
  });

  it('a task the classifier says starts agents: Save asks in the dialog, nothing is filed or saved; Save again only refocuses it', async () => {
    const e = setup();
    await e.open({ prefill: { title: 'Follow up', transcript: { worker: 'A', name: 'Pixel', candidate: CAND } } });
    await e.save();
    expect(e.of('hire_preset.check')).toEqual([{ prompt: TASK }]);
    expect(e.ask()?.textContent).toContain(SCHEDULE_ASK_TEXT);
    expect(e.q('[data-key="ask-with"]')?.textContent).toBe('Schedule with instructions');
    expect(e.q('[data-key="ask-without"]')?.textContent).toBe('Schedule without');
    expect(document.activeElement?.getAttribute('data-key')).toBe('ask-with');
    expect(e.dlg.summary()).toMatchObject({ asking: true, saving: false, blocker: 'Answer the question above first.' });
    expect(e.of('worker.handoff')).toEqual([]);
    expect(e.of('schedule.create')).toEqual([]);
    await e.save();
    expect(e.of('hire_preset.check')).toHaveLength(1);
    expect(e.of('schedule.create')).toEqual([]);
    // The key held down since Save (Enter repeats) does not answer: only a fresh press does.
    const repeat = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true });
    e.q('[data-key="ask-with"]')!.dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true);
  });

  it('“Schedule with instructions” ticks the box, files the message, then saves with the flag', async () => {
    const e = setup();
    await e.open({ prefill: { title: 'Follow up', transcript: { worker: 'A', name: 'Pixel', candidate: CAND } } });
    await e.save();
    await e.press('ask-with');
    expect(e.dlg.summary().instructions?.on).toBe(true);
    const order = e.sent.map((s) => s.t).filter((t) => t !== 'hire.prepare');
    expect(order).toEqual(['hire_preset.check', 'worker.handoff', 'schedule.create']);
    expect(e.of('schedule.create')[0]).toMatchObject({ prompt: TASK, handoff_path: '/home/dev/handoff/f1/filed.md', herdr_instructions: true, source: { kind: 'transcript', worker: 'A', message: 'msg_01' } });
    expect(e.dlg.isOpen).toBe(false);
  });

  it('“Schedule with instructions” over the limit with the lines: back to the form, the box ticked and the blocker, nothing filed or saved', async () => {
    const e = setup();
    const room = 32 * 1024 - 2 - enc.encode(LINES).length;
    const long = `Start an agent for each service. ${'x'.repeat(room)}`;
    await e.open({ prefill: { title: 'Follow up', transcript: { worker: 'A', name: 'Pixel', candidate: CAND } } }, long);
    await e.save();
    await e.press('ask-with');
    expect(e.dlg.summary()).toMatchObject({ asking: false, saving: false, error: true, instructions: { on: true } });
    expect(e.dlg.summary().status).toMatch(/^With the herdr hiring instructions, the prompt is \d+ bytes over 32 KiB/);
    expect(document.activeElement?.id).toBe('sf-instructions');
    expect(e.of('worker.handoff')).toEqual([]);
    expect(e.of('schedule.create')).toEqual([]);
  });

  // An image counts as its short marker while typing; Save sizes the prompt with its uploaded path, and the lines.
  const image = async (e: ReturnType<typeof setup>) => {
    e.draft().addImages([new File(['x'], 'shot.png', { type: 'image/png' })]);
    await flush();
  };
  const resolvedOver = async (e: ReturnType<typeof setup>) => {
    const r = await e.draft().resolve({ maxBytes: 64 * 1024 });
    if (!r.ok) throw new Error(`resolve failed: ${JSON.stringify(r)}`);
    return enc.encode(r.text).length + 2 + enc.encode(LINES).length - 32 * 1024;
  };
  const room = 32 * 1024 - 2 - enc.encode(LINES).length;

  it('the box ticked by hand, an image’s path taking the prompt with the lines over 32 KiB: nothing filed or saved, the box still ticked', async () => {
    const e = setup({ classifier: null });
    await e.open({ prefill: { title: 'Follow up', transcript: { worker: 'A', name: 'Pixel', candidate: CAND } } }, 'x'.repeat(room - 10));
    await image(e);
    e.tick(true);
    // The marker fits: no blocker while typing.
    expect(e.dlg.summary().blocker).toBeNull();
    expect(await resolvedOver(e)).toBeGreaterThan(0);
    await e.save();
    expect(e.dlg.summary()).toMatchObject({ asking: false, saving: false, error: true, instructions: { on: true } });
    expect(e.dlg.summary().status).toMatch(/with the image and file paths and the herdr hiring instructions.*untick Add herdr hiring instructions/);
    expect(document.activeElement?.id).toBe('sf-instructions');
    expect(e.of('worker.handoff')).toEqual([]);
    expect(e.of('schedule.create')).toEqual([]);
  });

  it('the image’s path with the lines exactly at 32 KiB saves with the flag', async () => {
    const e = setup({ classifier: null });
    await e.open({}, 'x'.repeat(room - 100));
    await image(e);
    e.tick(true);
    e.draft().replace(0, 0, 'x'.repeat(-(await resolvedOver(e))));
    await flush();
    expect(await resolvedOver(e)).toBe(0);
    await e.save();
    expect(e.of('schedule.create')).toEqual([expect.objectContaining({ herdr_instructions: true })]);
  });

  it('Edit with the box on: an image’s path taking it over with the lines updates nothing', async () => {
    const on = sched({ herdr_instructions: true });
    const e = setup({ list: [on] });
    await e.open({ edit: on }, 'x'.repeat(room - 10 - enc.encode(TASK).length));
    await image(e);
    expect(e.dlg.summary().blocker).toBeNull();
    expect(await resolvedOver(e)).toBeGreaterThan(0);
    await e.save();
    expect(e.dlg.summary()).toMatchObject({ saving: false, error: true, instructions: { on: true } });
    expect(e.of('schedule.update')).toEqual([]);
  });

  it('“Schedule with instructions” with an image’s path taking it over: nothing filed or saved', async () => {
    const e = setup();
    const text = 'Start an agent for each service. ';
    await e.open({ prefill: { title: 'Follow up', transcript: { worker: 'A', name: 'Pixel', candidate: CAND } } }, text + 'x'.repeat(room - 10 - text.length));
    await image(e);
    await e.save();
    await e.press('ask-with');
    expect(e.dlg.summary()).toMatchObject({ asking: false, saving: false, error: true, instructions: { on: true } });
    expect(e.dlg.summary().status).toMatch(/^With the herdr hiring instructions, the prompt is \d+ bytes over 32 KiB/);
    expect(e.of('worker.handoff')).toEqual([]);
    expect(e.of('schedule.create')).toEqual([]);
  });

  it('“Schedule without” saves as typed and is remembered for exactly this text', async () => {
    const e = setup({ create: [{ ok: false, code: 'internal', message: 'disk full' }] });
    await e.open();
    await e.save();
    await e.press('ask-without');
    expect(e.dlg.summary().instructions?.on).toBe(false);
    expect(e.of('schedule.create')[0]).not.toHaveProperty('herdr_instructions');
    // The save failed: Save again does not ask twice for the same text.
    await e.save();
    expect(e.of('hire_preset.check')).toHaveLength(1);
    expect(e.of('schedule.create')).toHaveLength(2);
  });

  it('Esc on the question goes back to the form: nothing filed or saved, the dialog stays', async () => {
    const e = setup();
    await e.open({ prefill: { title: 'Follow up', transcript: { worker: 'A', name: 'Pixel', candidate: CAND } } });
    await e.save();
    expect(e.esc().defaultPrevented).toBe(true);
    expect(e.dlg.isOpen).toBe(true);
    expect(e.ask()).toBeNull();
    expect(e.dlg.summary()).toMatchObject({ asking: false, saving: false, status: 'Not saved: the prompt is still here.' });
    expect(e.of('worker.handoff')).toEqual([]);
    expect(e.of('schedule.create')).toEqual([]);
  });

  it('no question for a “no”, an error, a timeout, a classifier not ready, or a bridge without the check: saved as is, the box never ticked', async () => {
    const cases: Array<[string, Opts, number]> = [
      ['no', { check: () => ({ ok: true, data: { delegates: false, score: 0.2 } }) }, 1],
      ['error', { check: () => ({ ok: false, code: 'internal', message: 'boom' }) }, 1],
      ['timeout', { check: () => ({ ok: false, code: 'timeout', message: 'herdr-world did not answer hire_preset.check within 1.5 s' }) }, 1],
      ['unknown_command', { check: () => ({ ok: false, code: 'unknown_command', message: 'unknown command' }) }, 1],
      ['not ready', { classifier: 'not_configured' }, 0],
      ['no classifier', { classifier: null }, 0],
      ['unsupported', { unsupported: ['hire_preset.check'] }, 0],
    ];
    for (const [name, o, checks] of cases) {
      const e = setup(o);
      await e.open();
      await e.save();
      expect(e.of('hire_preset.check'), name).toHaveLength(checks);
      expect(e.ask(), name).toBeNull();
      expect(e.of('schedule.create'), name).toHaveLength(1);
      expect(e.of('schedule.create')[0], name).not.toHaveProperty('herdr_instructions');
    }
  });

  it('an edit takes the question back; an answer that arrives after an edit saves nothing', async () => {
    const e = setup();
    await e.open();
    await e.save();
    expect(e.ask()).not.toBeNull();
    e.type('title', 'Rollout tonight');
    expect(e.ask()).toBeNull();
    expect(e.dlg.summary().asking).toBe(false);
    for (const change of [() => e.tick(true), () => e.type('when', 'in 3h')]) {
      e.tick(false);
      await e.save();
      expect(e.ask()).not.toBeNull();
      change();
      expect(e.ask()).toBeNull();
    }
    expect(e.of('schedule.create')).toEqual([]);

    // The classifier's "yes" for a form edited meanwhile is dropped: nothing saved, no question.
    let release: (r: CommandResult) => void = () => {};
    const f = setup({ check: () => new Promise<CommandResult>((r) => (release = r)) });
    await f.open();
    await f.save();
    expect(f.of('hire_preset.check')).toHaveLength(1);
    f.type('title', 'Another title');
    release({ ok: true, data: { delegates: true, score: 0.9 } });
    await flush();
    expect(f.ask()).toBeNull();
    expect(f.of('schedule.create')).toEqual([]);
    expect(f.dlg.summary()).toMatchObject({ saving: false, status: 'The form changed while its prompt was checked: nothing was saved. Save again to go on.' });
  });

  it('after the secrets review: the check gets the reviewed text and its review, never before', async () => {
    const e = setup({ secrets: true });
    const secret = 'Start an agent per service with TOKEN=ghp_abcdefghijklmnopqrstu1 and report back';
    await e.open({}, secret);
    await e.save();
    expect(e.b!.open()).not.toBeNull();
    expect(e.of('hire_preset.check')).toEqual([]);
    e.b!.confirm('c1');
    await flush();
    expect(e.of('hire_preset.check')).toEqual([{ prompt: secret, secrets: { revision: expect.any(String), decisions: [{ candidate: 'c1', action: 'ignore' }] } }]);
    expect(e.ask()).not.toBeNull();
    await e.press('ask-with');
    expect(e.of('schedule.create')[0]).toMatchObject({ prompt: secret, herdr_instructions: true, secrets: { decisions: [{ candidate: 'c1', action: 'ignore' }] } });
  });
});
