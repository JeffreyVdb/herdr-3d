// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { Hire, HireOptions, Preset, RunPrepare } from '../net/protocol';
import { flush, installDialogs, secretsBridge } from '../test/secretsBridge';
import { PresetBook } from '../world/presets';
import { StartRunDialog, type StartRunHost } from './startRun';

// #108 round 4: Start run's texts through the review, each alone (the ticket, the extra instructions, an edited
// prompt): `run.start` carries a review per text, keyed by its path; Cancel starts nothing; off as today.

const CAT: HireOptions = { claude: { models: ['claude-fable-5-1'], efforts: ['high'] } };
const role = (): Hire => ({ harness: 'claude', model: 'claude-fable-5-1', effort: 'high' });
const PRESET: Preset = { id: 'p_000000000001', name: 'Team', roles: { orch: role(), coder: role(), reviewer: role(), ux: role(), researcher: role() } };
const TICKET = 'Rotate the deploy credential, the old one is TOKEN=ghp_abcdefghijklmnopqrstu1';
const EXTRA = 'Use PASSWORD=hunter22 for the staging database.';

function cleanup() {
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close();
  document.body.replaceChildren();
}

/** `starts`: `run.start`'s answers in turn (then started); a promise is an answer still on its way. */
function setup(o: { on?: boolean; starts?: Array<CommandResult | Promise<CommandResult>> } = {}) {
  cleanup();
  const b = secretsBridge({ on: o.on ?? true });
  const refusals = [...(o.starts ?? [])];
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const toasts: string[] = [];
  const book = new PresetBook();
  book.reset([PRESET]);
  const store = {
    floorName: (id: string) => id,
    hireOptions: CAT,
    presets: book,
    floorView: () => ({ seats: Array(10).fill(null), floor: {}, settings: {}, suggested: {} }),
    limits: { version: 0, list: () => [] },
    workerView: () => null,
    repoRefs: { state: { all_buildings: false }, onChange: () => () => {} },
  };
  const send = (t: string, args: Record<string, unknown>): Promise<CommandResult> => {
    sent.push({ t, args });
    if (t === 'run.prepare') {
      const prep: RunPrepare = { prompt: '$write-code the ticket', label: 'ORCH|run', preset: PRESET.id, orch: PRESET.roles.orch, cwd: '/home/test', git: null, capacity: { floor: { count: 0, soft: 10, hard: 20 }, host: { count: 0, soft: 10, hard: 20 } } };
      return Promise.resolve({ ok: true, data: prep });
    }
    if (t === 'run.start') return Promise.resolve(refusals.shift() ?? { ok: true, data: { id: 'w9', launch_id: 'l1', prompt: 'p', prompted: true } });
    return Promise.resolve({ ok: true, data: {} });
  };
  const host = { store, send, unsupported: () => false, reserve: () => () => {}, held: () => new Set<number>(), toast: (m: string) => toasts.push(m), now: () => Date.now(), upload: () => new Promise(() => {}), hireAt: () => {}, openPresets: () => {}, started: () => {}, secrets: b.flow } as unknown as StartRunHost;
  const dlg = new StartRunDialog(document.body, host);
  const starts = () => sent.filter((s) => s.t === 'run.start').map((s) => s.args);
  const start = () => document.querySelector<HTMLElement>('.desk-dlg--run [data-key="start"]')!.click();
  /** Esc: the dialog's `cancel`, then its close. */
  const esc = () => {
    dlg.element.dispatchEvent(new Event('cancel'));
    dlg.close();
  };
  return { b, dlg, sent, starts, start, esc, toasts };
}

async function opened(t: ReturnType<typeof setup>, ticket: string, extra = '') {
  t.dlg.open({ floor: 'floor', desk: 0 });
  await flush();
  const ta = document.querySelector<HTMLTextAreaElement>('#run-ticket')!;
  ta.value = ticket;
  ta.dispatchEvent(new Event('input'));
  if (extra) {
    const ed = document.querySelector<HTMLElement>('#run-extra')!;
    ed.focus();
    const node = document.createTextNode(extra);
    ed.replaceChildren(node);
    document.getSelection()?.setBaseAndExtent(node, extra.length, node, extra.length);
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await vi.advanceTimersByTimeAsync(400); // the preview's run.prepare
  await flush();
}

describe('StartRunDialog and prompt secrets (#108 round 4)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    installDialogs();
    vi.stubGlobal('CSS', { escape: (s: string) => s });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('the ticket and the extra instructions, each reviewed in turn (its name in the title); run.start carries both, keyed', async () => {
    const t = setup();
    await opened(t, TICKET, EXTRA);
    t.start();
    await flush();
    expect(t.b.open()).toMatchObject({ field: 'the ticket', counts: { found: 1 } });
    expect(t.starts()).toEqual([]);
    t.b.confirm();
    await flush();
    expect(t.b.open()).toMatchObject({ field: 'the extra instructions', counts: { found: 1 } });
    t.b.confirm();
    await flush();
    const [args] = t.starts();
    expect(args).toMatchObject({ text: TICKET, extra: EXTRA });
    const secrets = args!.secrets as Record<string, unknown>;
    expect(Object.keys(secrets).sort()).toEqual(['extra', 'text']);
    expect(t.b.gate(TICKET, secrets.text, 'run', { field: 'text' })).toMatchObject({ protected: 1 });
    expect(t.b.gate(EXTRA, secrets.extra, 'run', { field: 'extra' })).toMatchObject({ protected: 1 });
  });

  it('Cancel on any text starts nothing and says so; a clean ticket starts as today (no `secrets`)', async () => {
    const t = setup();
    await opened(t, TICKET);
    t.start();
    await flush();
    t.b.cancel();
    await flush();
    expect(t.starts()).toEqual([]);
    expect(t.dlg.summary()).toMatchObject({ state: 'ready', status: 'Not started: the review was cancelled. Everything is still here.' });
    const c = setup();
    await opened(c, 'Fix the flaky login test');
    c.start();
    await flush();
    expect(c.b.open()).toBeNull();
    expect(c.starts()).toEqual([expect.objectContaining({ text: 'Fix the flaky login test' })]);
    expect(c.starts()[0]).not.toHaveProperty('secrets');
  });

  it('off: no scan, no “Review secrets”, started as today', async () => {
    const t = setup({ on: false });
    await opened(t, TICKET);
    expect(document.querySelector('.desk-dlg--run [data-key="review"]')).toBeNull();
    t.start();
    await flush();
    expect(t.b.scans).toEqual([]);
    expect(t.starts()).toEqual([expect.objectContaining({ text: TICKET })]);
  });

  // #108 round 4 fix (D1's audit): closed meanwhile, a run's review sends nothing again.
  it('refused as stale, then closed while its texts are scanned again: started once, no review opens', async () => {
    const t = setup({ starts: [{ ok: false, code: 'secrets_review_stale', message: 'stale' }] });
    await opened(t, TICKET);
    t.start();
    await flush();
    const release = t.b.holdScans();
    t.b.confirm();
    await flush();
    expect(t.starts()).toHaveLength(1);
    t.dlg.close();
    release();
    await flush();
    expect(t.b.open()).toBeNull();
    expect(t.starts()).toHaveLength(1);
  });

  // #108 round 4 fix 2 (UX D1): Esc says the run is still starting only while its run.start is at the bridge; closed while
  // a refusal's texts are scanned again, nothing starts and nothing is said (decisions row 43).
  it('refused as stale, then Esc while its texts are scanned again: nothing is said, started once', async () => {
    const t = setup({ starts: [{ ok: false, code: 'secrets_review_stale', message: 'stale' }] });
    await opened(t, TICKET);
    t.start();
    await flush();
    const release = t.b.holdScans();
    t.b.confirm();
    await flush();
    expect(t.starts()).toHaveLength(1);
    expect(t.dlg.summary()).toMatchObject({ state: 'starting' });
    t.esc();
    release();
    await flush();
    expect(t.b.open()).toBeNull();
    expect(t.starts()).toHaveLength(1);
    expect(t.toasts).toEqual([]);
  });

  it('Esc while its texts are scanned the first time: nothing is said, nothing starts', async () => {
    const t = setup();
    await opened(t, TICKET);
    const release = t.b.holdScans();
    t.start();
    await flush();
    t.esc();
    release();
    await flush();
    expect(t.b.open()).toBeNull();
    expect(t.starts()).toEqual([]);
    expect(t.toasts).toEqual([]);
  });

  it('Esc while its run.start is at the bridge: the run is still starting, and its toast says how it went', async () => {
    let answer!: (r: CommandResult) => void;
    const t = setup({ starts: [new Promise<CommandResult>((r) => (answer = r))] });
    await opened(t, TICKET);
    t.start();
    await flush();
    t.b.confirm();
    await flush();
    expect(t.starts()).toHaveLength(1);
    t.esc();
    expect(t.toasts).toEqual(['The run is still starting; its orchestrator shows up at the desk when it is hired.']);
    answer({ ok: true, data: { id: 'w9', launch_id: 'l1', prompt: 'p', prompted: true } });
    await flush();
    expect(t.toasts).toHaveLength(2);
    expect(t.toasts[1]).toMatch(/^Started a run/);
  });

  it('an earlier opening’s run.start still at the bridge: a newer opening’s Esc during its own scan again says nothing', async () => {
    let answer!: (r: CommandResult) => void;
    const t = setup({ starts: [new Promise<CommandResult>((r) => (answer = r)), { ok: false, code: 'secrets_review_stale', message: 'stale' }] });
    await opened(t, TICKET);
    t.start();
    await flush();
    t.b.confirm();
    await flush();
    expect(t.starts()).toHaveLength(1);
    t.esc();
    expect(t.toasts).toHaveLength(1);
    // Opened again (another desk): its own run, refused as stale, then Esc while it is scanned again.
    t.dlg.open({ floor: 'floor', desk: 1 });
    await flush();
    const ta = document.querySelector<HTMLTextAreaElement>('#run-ticket')!;
    ta.value = TICKET;
    ta.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(400);
    await flush();
    t.start();
    await flush();
    const release = t.b.holdScans();
    t.b.confirm();
    await flush();
    expect(t.starts()).toHaveLength(2);
    expect(t.dlg.summary()).toMatchObject({ state: 'starting', desk: 1 });
    t.esc();
    expect(t.toasts).toHaveLength(1);
    release();
    answer({ ok: true, data: { id: 'w9', launch_id: 'l1', prompt: 'p', prompted: true } });
    await flush();
    expect(t.starts()).toHaveLength(2);
    expect(t.toasts.slice(1)).toEqual([expect.stringMatching(/^Started a run/)]);
  });

  it('an earlier opening’s run.start still at the bridge is that opening’s: a newer one’s Esc during its first scan says nothing', async () => {
    let answer!: (r: CommandResult) => void;
    const t = setup({ starts: [new Promise<CommandResult>((r) => (answer = r))] });
    await opened(t, TICKET);
    t.start();
    await flush();
    t.b.confirm();
    await flush();
    t.esc();
    expect(t.toasts).toHaveLength(1);
    t.dlg.open({ floor: 'floor', desk: 1 });
    await flush();
    const ta = document.querySelector<HTMLTextAreaElement>('#run-ticket')!;
    ta.value = TICKET;
    ta.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(400);
    await flush();
    const release = t.b.holdScans();
    t.start();
    await flush();
    t.esc();
    expect(t.toasts).toHaveLength(1);
    release();
    answer({ ok: true, data: { id: 'w9', launch_id: 'l1', prompt: 'p', prompted: true } });
    await flush();
    expect(t.starts()).toHaveLength(1);
    expect(t.toasts.slice(1)).toEqual([expect.stringMatching(/^Started a run/)]);
  });
});
