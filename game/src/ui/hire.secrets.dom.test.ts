// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import { flush, installDialogs, secretsBridge } from '../test/secretsBridge';
import type { Draft as PromptDraft } from './composer/draft';
import { HireDialog, type HireHost } from './hire';
import { HirePrefs } from './hirePrefs';

// #108 round 4: the hire dialog's first task through the review: resolved (images up) and reviewed before the desk is
// held and before a background hire closes the dialog; `worker.hire` carries the review; Cancel hires nobody.

const prep = {
  cwd: '/home/test',
  label: 'default',
  git: null,
  choice: { harness: 'codex', model: 'gpt', effort: 'high' },
  choice_source: 'floor_default',
  capacity: { floor: { count: 0, soft: 10, hard: 20 }, host: { count: 0, soft: 10, hard: 20 } },
};
const TASK = 'Deploy the site with TOKEN=ghp_abcdefghijklmnopqrstu1 and report back';

interface Inner {
  editor: { draft: PromptDraft };
}

function setup(o: { on?: boolean; background?: boolean; hires?: CommandResult[] } = {}) {
  document.body.replaceChildren();
  const b = secretsBridge({ on: o.on ?? true });
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const holds = new Set<number>();
  const toasts: string[] = [];
  const answers = [...(o.hires ?? [])];
  const prefs = new HirePrefs(null);
  prefs.hireInBackground = o.background === true;
  const host = {
    store: { floorName: (id: string) => id, hireOptions: { codex: { models: ['gpt'], efforts: ['high'] } }, floorView: () => ({ seats: Array(10).fill(null) }), limits: { version: 0, list: () => [] }, workerView: () => null },
    send: (t: string, args: Record<string, unknown>) => {
      sent.push({ t, args });
      if (t === 'hire.prepare') return Promise.resolve({ ok: true, data: prep });
      return Promise.resolve(answers.shift() ?? { ok: true, data: { id: 'w9', prompted: true, protected: 1 } });
    },
    unsupported: () => false,
    reserve: (_s: string, d: number) => {
      holds.add(d);
      return () => holds.delete(d);
    },
    held: () => holds,
    toast: (text: string) => void toasts.push(text),
    hirePrefs: prefs,
    now: () => Date.now(),
    upload: () => new Promise(() => {}),
    secrets: b.flow,
  } as unknown as HireHost;
  const dlg = new HireDialog(document.body, host);
  const hires = () => sent.filter((s) => s.t === 'worker.hire').map((s) => s.args);
  const press = (key: string) => document.querySelector<HTMLElement>(`.desk-dlg [data-key="${key}"]:not(.desk-dlg--secrets *)`)!.click();
  return { b, dlg, inner: dlg as unknown as Inner, sent, hires, holds, toasts, press };
}

async function typed(t: ReturnType<typeof setup>, text: string) {
  t.dlg.open('floor', 0);
  await flush();
  t.inner.editor.draft.replace(0, 0, text);
  await flush();
}

describe('HireDialog and prompt secrets (#108 round 4)', () => {
  beforeEach(() => {
    localStorage.clear();
    installDialogs();
    vi.stubGlobal('CSS', { escape: (s: string) => s });
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('a first task with a secret: the review first (nothing hired, no desk held), Confirm hires with the review the bridge takes', async () => {
    const t = setup();
    await typed(t, TASK);
    t.press('hire');
    await flush();
    expect(t.b.open()).toMatchObject({ target: 'default at Desk 1', action: 'Confirm and send', counts: { found: 1 } });
    expect(t.hires()).toEqual([]);
    expect(t.holds.size).toBe(0);
    expect(t.dlg.summary()!.state).toBe('hiring');
    t.b.confirm();
    await flush();
    const [args] = t.hires();
    expect(args).toMatchObject({ floor: 'floor', desk_index: 0, prompt: TASK, secrets: { decisions: [{ candidate: 'c1', action: 'protect' }] } });
    expect(t.b.gate(TASK, args!.secrets)).toMatchObject({ protected: 1 });
  });

  it('in the background: the review opens before the dialog closes; Confirm closes it and hires', async () => {
    const t = setup({ background: true });
    await typed(t, TASK);
    t.press('hire');
    await flush();
    expect(t.b.open()).not.toBeNull();
    expect(t.dlg.isOpen).toBe(true);
    expect(t.holds.size).toBe(0);
    t.b.confirm();
    await flush();
    expect(t.dlg.isOpen).toBe(false);
    expect(t.hires()).toHaveLength(1);
    expect(t.toasts).toEqual(['Agent spawned successfully.']);
  });

  it('Cancel: nobody hired, the desk free, the task kept and said so', async () => {
    const t = setup();
    await typed(t, TASK);
    t.press('hire');
    await flush();
    t.b.cancel();
    await flush();
    expect(t.hires()).toEqual([]);
    expect(t.holds.size).toBe(0);
    expect(t.dlg.summary()).toMatchObject({ state: 'ready', status: 'Not hired: the first task is still here.', form: { prompt: TASK } });
  });

  it('nothing found: hired as today (no dialog, no `secrets`); off: no scan, no “Review secrets”', async () => {
    const t = setup();
    await typed(t, 'tidy the docs');
    t.press('hire');
    await flush();
    expect(t.b.open()).toBeNull();
    expect(t.hires()).toEqual([expect.not.objectContaining({ secrets: expect.anything() })]);
    const off = setup({ on: false });
    await typed(off, TASK);
    expect(document.querySelector('.desk-dlg [data-key="review"]')).toBeNull();
    off.press('hire');
    await flush();
    expect(off.b.scans).toEqual([]);
    expect(off.hires()).toEqual([expect.objectContaining({ prompt: TASK })]);
    expect(off.hires()[0]).not.toHaveProperty('secrets');
  });

  it('“Review secrets” opens the review on purpose (nothing found), a mark by hand goes with the hire', async () => {
    const t = setup();
    await typed(t, 'use the code 4471 to get in');
    t.press('review');
    await flush();
    expect(t.b.open()).toMatchObject({ manual: true, counts: { found: 0 } });
    const r = t.b.dlg as unknown as { req: { review: { mark(a: number, b: number): unknown } } };
    r.req.review.mark(13, 17);
    t.b.confirm();
    await flush();
    const [args] = t.hires();
    expect(args!.secrets).toMatchObject({ decisions: [{ action: 'protect', start: 13, end: 17 }] });
    expect(t.b.gate('use the code 4471 to get in', args!.secrets)).toMatchObject({ protected: 1 });
  });

  it('refused as stale: reviewed again with a note, hired only on the new Confirm', async () => {
    const t = setup({ hires: [{ ok: false, code: 'secrets_review_stale', message: 'stale' }] });
    await typed(t, TASK);
    t.press('hire');
    await flush();
    t.b.confirm();
    await flush();
    expect(t.hires()).toHaveLength(1);
    expect(t.b.open()).toMatchObject({ notice: expect.stringMatching(/^This review no longer fits/) });
    t.b.confirm();
    await flush();
    expect(t.hires()).toHaveLength(2);
    expect(t.dlg.isOpen).toBe(false);
  });

  it('drafts: memory only while on (no storage key holds the task at any step), written again once the switch goes off', async () => {
    const stored = () => Object.keys(localStorage).filter((k) => (localStorage.getItem(k) ?? '').includes('ghp_abcdefghijklmnopqrstu1'));
    const t = setup();
    await typed(t, TASK);
    t.dlg.close();
    expect(stored()).toEqual([]);
    t.dlg.open('floor', 0);
    await flush();
    expect(t.dlg.summary()!.form.prompt).toBe(TASK);
    t.press('hire');
    await flush();
    expect(stored()).toEqual([]);
    t.b.cancel();
    await flush();
    expect(stored()).toEqual([]);
    t.b.book.upsert({ enabled: false, available: true });
    expect(stored()).toEqual(['h3d.draft.hire.floor:0']);
    t.b.book.upsert({ enabled: true, available: true });
    expect(stored()).toEqual([]);
  });
});
