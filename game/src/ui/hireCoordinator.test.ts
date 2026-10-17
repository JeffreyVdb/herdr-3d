import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../net/client';
import type { CommandArgs } from '../net/protocol';
import { Draft } from './composer/draft';
import { HireCoordinator, SPAWNED_NOTICE_GAP_MS, SPAWNED_TEXT, type HireRequest } from './hireCoordinator';

// #210: the hire coordinator: what it sends is what was reviewed at Hire, one operation per submission, one message
// (and one beep) per background outcome, and only its own desk held.

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const sends: Array<CommandArgs['worker.hire']> = [];
  const answers: Array<(r: CommandResult) => void> = [];
  const held = new Map<string, number>();
  const toasts: Array<{ text: string; kind: string }> = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const handed: Array<{ id: string; text: string; from: unknown }> = [];
  // What the new worker's Prompt (P) note takes (false: it already had something in it).
  let takes = true;
  let beeps = 0;
  const hires = new HireCoordinator({
    send: (_t, args) => {
      sends.push(args);
      return new Promise((r) => answers.push(r));
    },
    reserve: (s, d) => {
      const k = `${s}:${d}`;
      held.set(k, (held.get(k) ?? 0) + 1);
      return () => held.set(k, (held.get(k) ?? 0) - 1);
    },
    toast: (text, kind) => void toasts.push({ text, kind }),
    beep: () => void beeps++,
    workerView: (id) => (id === 'w1' ? { name: 'Gumdrop', desk: 14 } : null),
    later: (fn, ms) => void timers.push({ fn, ms }),
    holdTask: (id, text, from) => {
      handed.push({ id, text, from });
      return takes;
    },
  });
  const answer = (i: number, r: CommandResult) => answers[i]!(r);
  const noteTakes = (v: boolean) => void (takes = v);
  return { hires, sends, answer, held, toasts, timers, handed, noteTakes, beeps: () => beeps };
}

const args = (desk: number, prompt?: string): CommandArgs['worker.hire'] => ({ floor: 'pastry', desk_index: desk, harness: 'claude', model: 'claude-opus-5-5', effort: 'high', ...(prompt ? { prompt } : {}) });
const req = (o: Partial<HireRequest> = {}): HireRequest => ({ key: 'k1', floor: 'pastry', desk: 14, args: args(14), who: 'Gumdrop', prompt: null, background: true, ...o });
const draft = (text: string, upload: ConstructorParameters<typeof Draft>[0]['upload'] = async () => ({ ok: true, data: { path: '/tmp/x.png' } })) => {
  const d = new Draft({ upload });
  d.replace(0, 0, text);
  return d;
};

describe('HireCoordinator: the snapshot', () => {
  it('holds the desk before start returns, and lets go of only its own hold once the hire ends', async () => {
    const t = setup();
    const a = t.hires.start(req());
    expect(t.held.get('pastry:14')).toBe(1);
    expect(a.phase).toBe('hiring');
    const b = t.hires.start(req({ key: 'k2', desk: 15, args: args(15) }));
    expect(t.hires.inFlight).toHaveLength(2);
    t.answer(0, { ok: true, data: { id: 'w1', prompted: true } });
    await a.done;
    expect(t.held.get('pastry:14')).toBe(0);
    expect(t.held.get('pastry:15')).toBe(1);
    expect(t.hires.inFlight).toEqual([b]);
  });

  it('sends what was reviewed at Hire: later edits of the args, the draft or the request do not reach it', async () => {
    const t = setup();
    const d = draft('label the loaves');
    const a = args(14, 'label the loaves');
    const r = req({ args: a, prompt: d });
    const op = t.hires.start(r);
    a.model = 'claude-sonnet-5-5';
    r.background = false;
    d.replace(0, 0, 'NOT THIS ');
    await tick();
    expect(t.sends).toHaveLength(1);
    expect(t.sends[0]).toMatchObject({ model: 'claude-opus-5-5', prompt: 'label the loaves' });
    expect(op.request.background).toBe(true);
    expect(Object.isFrozen(op.request) && Object.isFrozen(op.request.args)).toBe(true);
    t.answer(0, { ok: true, data: { id: 'w1', prompted: true } });
    expect(await op.done).toMatchObject({ kind: 'hired', revision: 1 });
    expect(t.toasts).toEqual([{ text: SPAWNED_TEXT, kind: 'info' }]);
  });

  it('holds the desk while the images go up: worker.hire only once they are uploaded', async () => {
    const t = setup();
    let finish!: (r: CommandResult) => void;
    const d = draft('see ', () => new Promise((r) => (finish = r)));
    d.addImages([new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })]);
    const op = t.hires.start(req({ args: args(14, 'see [Image #1]'), prompt: d }));
    expect(t.held.get('pastry:14')).toBe(1);
    await tick();
    expect(op.phase).toBe('uploading');
    expect(t.sends).toHaveLength(0);
    finish({ ok: true, data: { path: '/drops/shot.png' } });
    await tick();
    await tick();
    expect(t.sends).toHaveLength(1);
    expect(t.sends[0]!.prompt).toContain('/drops/shot.png');
  });

  it('in the foreground the images go up first, as the dialog always did: the desk is held only for worker.hire', async () => {
    const t = setup();
    let finish!: (r: CommandResult) => void;
    const d = draft('see ', () => new Promise((r) => (finish = r)));
    d.addImages([new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })]);
    const op = t.hires.start(req({ args: args(14, 'see [Image #1]'), prompt: d, background: false }));
    expect(t.held.get('pastry:14')).toBeUndefined();
    await tick();
    expect(op.phase).toBe('uploading');
    expect(t.held.get('pastry:14')).toBeUndefined();
    finish({ ok: true, data: { path: '/drops/shot.png' } });
    await tick();
    await tick();
    expect(t.sends).toHaveLength(1);
    expect(t.held.get('pastry:14')).toBe(1);
    t.answer(0, { ok: true, data: { id: 'w1', prompted: true } });
    await op.done;
    expect(t.held.get('pastry:14')).toBe(0);
  });

  it('in the foreground an image that did not upload never holds the desk', async () => {
    const t = setup();
    const d = draft('see ', async () => ({ ok: false, code: 'dropzone_unavailable', message: 'Drop Zone is down' }));
    d.addImages([new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })]);
    const op = t.hires.start(req({ args: args(14, 'see [Image #1]'), prompt: d, background: false }));
    expect(await op.done).toMatchObject({ kind: 'not_sent' });
    expect(t.held.has('pastry:14')).toBe(false);
    expect(t.sends).toHaveLength(0);
  });

  it('in the foreground with no first task the desk is held at once (nothing to upload)', () => {
    const t = setup();
    t.hires.start(req({ background: false }));
    expect(t.held.get('pastry:14')).toBe(1);
    expect(t.sends).toHaveLength(1);
  });
});

describe('HireCoordinator: one operation per submission', () => {
  it('a second start with the same key while it runs is the same operation: one worker.hire', async () => {
    const t = setup();
    const a = t.hires.start(req());
    const b = t.hires.start(req({ args: args(14, 'other') }));
    expect(b).toBe(a);
    expect(t.sends).toHaveLength(1);
    expect(t.held.get('pastry:14')).toBe(1);
    t.answer(0, { ok: true, data: { id: 'w1', prompted: true } });
    await a.done;
    // Over: the same key is a new submission (a retry after a failure).
    const c = t.hires.start(req());
    expect(c).not.toBe(a);
    expect(t.sends).toHaveLength(2);
  });
});

describe('HireCoordinator: what a background hire says, once', () => {
  it('success: exactly the success toast and one beep, whoever reads the outcome how often', async () => {
    const t = setup();
    const op = t.hires.start(req());
    expect(t.toasts).toEqual([]);
    expect(t.beeps()).toBe(0);
    t.answer(0, { ok: true, data: { id: 'w1', prompted: true } });
    await op.done;
    await op.done;
    await tick();
    expect(t.toasts).toEqual([{ text: 'Agent spawned successfully.', kind: 'info' }]);
    expect(t.beeps()).toBe(1);
    expect(t.timers).toEqual([]);
  });

  it('a Codex fallback is its own warning after the success toast, which keeps its exact words', async () => {
    const t = setup();
    const op = t.hires.start(req());
    t.answer(0, { ok: true, data: { id: 'w1', prompted: true, codex: { mode: 'legacy', note: 'shared Codex server: not verified; started the usual way' } } });
    await op.done;
    expect(t.toasts).toEqual([{ text: SPAWNED_TEXT, kind: 'info' }]);
    expect(t.timers.map((x) => x.ms)).toEqual([SPAWNED_NOTICE_GAP_MS]);
    t.timers[0]!.fn();
    expect(t.toasts[1]).toMatchObject({ kind: 'warn', text: expect.stringMatching(/^No own Codex server/) });
    expect(t.beeps()).toBe(1);
  });

  it('prompted:false: the worker is there, the task was not delivered: an error, no beep, never hired again; the task goes to their prompt', async () => {
    const t = setup();
    const d = draft('go');
    const op = t.hires.start(req({ args: args(14, 'go'), prompt: d }));
    await tick();
    t.answer(0, { ok: true, data: { id: 'w1', prompted: false, prompt_error: 'agent busy' } });
    expect(await op.done).toMatchObject({ kind: 'not_prompted', prompt: 'go' });
    expect(t.handed).toEqual([{ id: 'w1', text: 'go', from: d }]);
    expect(t.toasts).toEqual([{ kind: 'error', text: 'Hired Gumdrop at Desk 15. The first task was not sent (agent busy): prompt them yourself (P); the task is in their prompt.' }]);
    expect(t.beeps()).toBe(0);
    expect(t.sends).toHaveLength(1);
  });

  it('prompted:false with something already in their prompt: it is not overwritten, and the toast points nowhere it cannot open', async () => {
    const t = setup();
    t.noteTakes(false);
    const op = t.hires.start(req({ args: args(14, 'go'), prompt: draft('go') }));
    await tick();
    t.answer(0, { ok: true, data: { id: 'w1', prompted: false, prompt_error: 'agent busy' } });
    await op.done;
    expect(t.handed).toHaveLength(1);
    expect(t.toasts).toEqual([{ kind: 'error', text: 'Hired Gumdrop at Desk 15. The first task was not sent (agent busy): prompt them yourself (P).' }]);
    expect(t.toasts[0]!.text).not.toMatch(/hire dialog|in their prompt/);
    expect(t.sends).toHaveLength(1);
  });

  it('prompted:false in the foreground: the dialog says it; nothing is handed to the prompt', async () => {
    const t = setup();
    const op = t.hires.start(req({ args: args(14, 'go'), prompt: draft('go'), background: false }));
    await tick();
    t.answer(0, { ok: true, data: { id: 'w1', prompted: false, prompt_error: 'agent busy' } });
    expect(await op.done).toMatchObject({ kind: 'not_prompted' });
    expect(t.handed).toEqual([]);
    expect(t.toasts).toEqual([]);
  });

  it('an image that did not upload: no worker.hire, the desk let go, an error that says so', async () => {
    const t = setup();
    const d = draft('see ', async () => ({ ok: false, code: 'dropzone_unavailable', message: 'Drop Zone is down' }));
    d.addImages([new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })]);
    const op = t.hires.start(req({ args: args(14, 'see [Image #1]'), prompt: d }));
    const o = await op.done;
    expect(o).toMatchObject({ kind: 'not_sent', result: { reason: 'upload' } });
    expect(t.sends).toHaveLength(0);
    expect(t.held.get('pastry:14')).toBe(0);
    expect(t.toasts).toHaveLength(1);
    expect(t.toasts[0]).toMatchObject({ kind: 'error', text: expect.stringMatching(/^Nothing was hired at Desk 15: image 1 \(shot\.png\) did not upload/) });
    expect(t.beeps()).toBe(0);
  });

  it('a refusal: the desk let go, the bridge’s reason, no beep', async () => {
    const t = setup();
    const op = t.hires.start(req());
    t.answer(0, { ok: false, code: 'hire_failed', message: 'hire_failed: claude exited during startup' });
    expect(await op.done).toMatchObject({ kind: 'failed', code: 'hire_failed' });
    expect(t.held.get('pastry:14')).toBe(0);
    expect(t.toasts).toHaveLength(1);
    expect(t.toasts[0]!.kind).toBe('error');
    expect(t.beeps()).toBe(0);
  });

  for (const code of ['timeout', 'disconnected'] as const) {
    it(`${code}: an unknown outcome, said once, and no second worker.hire`, async () => {
      const t = setup();
      const op = t.hires.start(req());
      t.answer(0, { ok: false, code, message: 'no answer' });
      expect(await op.done).toMatchObject({ kind: 'unknown', code });
      await tick();
      expect(t.sends).toHaveLength(1);
      expect(t.toasts).toHaveLength(1);
      expect(t.toasts[0]).toMatchObject({ kind: 'warn', text: expect.stringContaining('It may still have gone through') });
      expect(t.beeps()).toBe(0);
    });
  }

  // #214: a dictated review hands over no draft, so its unknown outcome points to no hire dialog (nothing is kept there).
  it('an unknown outcome says the task stays in its hire dialog only when there is a draft there', async () => {
    const dictated = setup();
    const a = dictated.hires.start(req({ args: args(14, 'bake the rye') }));
    dictated.answer(0, { ok: false, code: 'timeout', message: 'no answer' });
    await a.done;
    expect(dictated.toasts[0]!.text).toMatch(/look at the desk before you hire again\.$/);
    expect(dictated.toasts[0]!.text).not.toContain('hire dialog');

    const typed = setup();
    const b = typed.hires.start(req({ args: args(14, 'bake the rye'), prompt: draft('bake the rye') }));
    await tick();
    typed.answer(0, { ok: false, code: 'disconnected', message: 'no answer' });
    await b.done;
    expect(typed.toasts[0]!.text).toMatch(/look at the desk before you hire again\. The task stays in its hire dialog\.$/);
  });

  it('offline: never sent, so a plain failure', async () => {
    const t = setup();
    const op = t.hires.start(req());
    t.answer(0, { ok: false, code: 'offline', message: 'not connected' });
    expect(await op.done).toMatchObject({ kind: 'failed', code: 'offline' });
    expect(t.toasts[0]!.kind).toBe('error');
  });

  it('two hires on their way end on their own: each its own toast and beep', async () => {
    const t = setup();
    const a = t.hires.start(req());
    const b = t.hires.start(req({ key: 'k2', desk: 15, args: args(15) }));
    t.answer(1, { ok: false, code: 'hire_failed', message: 'nope' });
    await b.done;
    expect(t.toasts.map((x) => x.kind)).toEqual(['error']);
    expect(t.toasts[0]!.text).toContain('16');
    t.answer(0, { ok: true, data: { id: 'w1', prompted: true } });
    await a.done;
    expect(t.toasts.map((x) => x.text)).toEqual([expect.any(String), SPAWNED_TEXT]);
    expect(t.beeps()).toBe(1);
  });

  it('in the foreground it says nothing itself: the caller does', async () => {
    const t = setup();
    const ok = t.hires.start(req({ background: false }));
    t.answer(0, { ok: true, data: { id: 'w1', prompted: true } });
    await ok.done;
    const bad = t.hires.start(req({ key: 'k2', background: false }));
    t.answer(1, { ok: false, code: 'disconnected', message: '' });
    await bad.done;
    expect(t.toasts).toEqual([]);
    expect(t.beeps()).toBe(0);
  });
});

describe('HireCoordinator: #95 the herdr hiring instructions', () => {
  it('counts the bytes the bridge adds against the limit: a task that fits alone is not sent, and says why', async () => {
    const t = setup();
    const added = 400;
    const fits = 'x'.repeat(32 * 1024 - added);
    const ok = t.hires.start(req({ args: { ...args(14, fits), herdr_instructions: true }, prompt: draft(fits), added }));
    await tick();
    expect(t.sends[0]).toMatchObject({ prompt: fits, herdr_instructions: true });
    t.answer(0, { ok: true, data: { id: 'w1', prompted: true } });
    await ok.done;
    const over = `${fits}y`;
    const o = await t.hires.start(req({ key: 'k2', args: { ...args(15, over), herdr_instructions: true }, prompt: draft(over), added, background: false })).done;
    expect(o.kind).toBe('not_sent');
    expect(o.kind === 'not_sent' && o.message).toContain('herdr hiring instructions');
    expect(t.sends).toHaveLength(1);
  });
});
