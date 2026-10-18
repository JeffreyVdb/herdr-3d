// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { HireInterpretation, HirePrepare } from '../net/protocol';
import { flush, installDialogs, secretsBridge } from '../test/secretsBridge';
import { CAT, FULL } from '../world/hireReviewFixtures';
import type { HireHost } from './hire';
import { HireReviewDialog } from './hireReview';
import { HirePrefs } from './hirePrefs';

// #108 round 4: a dictated hire's review with prompt secrets reviewed: the interpreter's hand-over goes with the hire; the
// task as it answered it needs no review again, an edited one is reviewed as usual; the hand-over survives a follow-up.

const prep: HirePrepare = {
  cwd: '/home/test',
  label: 'Nibble',
  git: null,
  choice: { harness: 'codex', model: 'gpt-6-luna', effort: 'high' },
  choice_source: 'floor_default',
  capacity: { floor: { count: 1, soft: 10, hard: 20 }, host: { count: 1, soft: 10, hard: 20 } },
};
const REF = '[secret in file /run/user/1000/herdr-world/secrets/AAAAAAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBBBBBB]';
const TASK = `log in with the password in ${REF} and fix the login bug.`;
const WITH_REF: HireInterpretation = { ...FULL, sources: [`Hire a Claude Code agent on Haiku 5.5 with high effort to ${TASK}`], task: { provenance: 'dictated', value: TASK } };

function setup() {
  document.body.replaceChildren();
  const b = secretsBridge();
  const hires: Array<Record<string, unknown>> = [];
  const host = {
    store: {
      floorName: (id: string) => id,
      hireOptions: CAT,
      floorView: () => ({ seats: Array(6).fill(null), asleep: false, transition: null, level: { number: 2, count: 3 }, building: { name: 'HQ' } }),
      limits: { version: 0, list: () => [] },
      workerView: () => null,
    },
    send: (t: string, args: Record<string, unknown>): Promise<CommandResult> => {
      if (t === 'hire.prepare') return Promise.resolve({ ok: true, data: prep });
      hires.push(args);
      return Promise.resolve({ ok: true, data: { id: 'w9', prompted: true } });
    },
    unsupported: () => false,
    reserve: () => () => {},
    held: () => new Set(),
    toast: () => {},
    goTo: () => {},
    beep: () => {},
    hirePrefs: new HirePrefs(null),
    now: () => Date.now(),
    secrets: b.flow,
  } as unknown as HireHost;
  const rv = new HireReviewDialog(document.body, host);
  const hire = () => document.querySelector<HTMLElement>('.desk-dlg [data-key="hire"]')!.click();
  const task = () => document.querySelector<HTMLTextAreaElement>('#review-task')!;
  return { b, rv, hires, hire, task };
}

describe('HireReviewDialog and prompt secrets (#108 round 4)', () => {
  beforeEach(() => {
    installDialogs();
    vi.stubGlobal('CSS', { escape: (s: string) => s });
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('the task as the interpreter answered it: Hire sends it with the hand-over, no scan, no review', async () => {
    const t = setup();
    t.rv.open('floor', WITH_REF, undefined, undefined, 'tok-1');
    await flush();
    expect(t.rv.pendingHandover()).toBe('tok-1');
    t.hire();
    await flush();
    expect(t.b.scans).toEqual([]);
    expect(t.hires).toEqual([expect.objectContaining({ prompt: TASK, secrets_pending: 'tok-1' })]);
    expect(t.hires[0]).not.toHaveProperty('secrets');
  });

  it('an edited task: reviewed as usual (the reference scans clean), sent with its review and the hand-over', async () => {
    const t = setup();
    t.rv.open('floor', WITH_REF, undefined, undefined, 'tok-1');
    await flush();
    const edited = `${TASK} Then use TOKEN=ghp_abcdefghijklmnopqrstu1 to push.`;
    t.task().value = edited;
    t.task().dispatchEvent(new Event('input'));
    t.hire();
    await flush();
    expect(t.b.open()).toMatchObject({ counts: { found: 1 }, action: 'Confirm and send' });
    expect(t.hires).toEqual([]);
    t.b.confirm();
    await flush();
    expect(t.hires).toEqual([expect.objectContaining({ prompt: edited, secrets_pending: 'tok-1', secrets: expect.objectContaining({ decisions: [expect.objectContaining({ candidate: 'c1', action: 'protect' })] }) })]);
    expect(t.b.gate(edited, t.hires[0]!.secrets)).toMatchObject({ protected: 1 });
  });

  it('a follow-up’s answer keeps the hand-over; Cancel on the review hires nobody and keeps the task', async () => {
    const t = setup();
    t.rv.open('floor', WITH_REF, undefined, undefined, 'tok-1');
    await flush();
    expect(t.rv.apply(WITH_REF, t.rv.begin()!)).toBe(true);
    expect(t.rv.pendingHandover()).toBe('tok-1');
    t.task().value = `${TASK} PASSWORD=hunter22`;
    t.task().dispatchEvent(new Event('input'));
    t.hire();
    await flush();
    t.b.cancel();
    await flush();
    expect(t.hires).toEqual([]);
    expect(t.rv.summary()).toMatchObject({ state: 'ready', status: 'Not hired: the review was cancelled. The task is still here.' });
  });
});
