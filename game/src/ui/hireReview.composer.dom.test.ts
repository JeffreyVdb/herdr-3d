// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { HirePrepare } from '../net/protocol';
import { hireTask } from '../world/handoff';
import { fromHandoff } from '../world/hireReview';
import { CAT, FULL } from '../world/hireReviewFixtures';
import type { Draft as PromptDraft } from './composer/draft';
import type { HireHost } from './hire';
import { HirePrefs } from './hirePrefs';
import { HireReviewDialog } from './hireReview';

// The review's task is the shared composer, as every other prompt box: a pasted image goes up before `worker.hire`
// (its path in the task), and `/` and `@` complete the hire's skills, files and repositories (#39). "Hire from
// handoff" opens this review.

const prep = (): HirePrepare => ({
  cwd: '/home/test',
  label: 'Nibble',
  git: null,
  choice: { harness: 'codex', model: 'gpt-6-luna', effort: 'high' },
  choice_source: 'floor_default',
  capacity: { floor: { count: 1, soft: 10, hard: 20 }, host: { count: 1, soft: 10, hard: 20 } },
});

const flush = () => new Promise((r) => setTimeout(r, 0));

interface Ask {
  t: string;
  args: Record<string, unknown>;
  answer(r: CommandResult): void;
}

function setup() {
  const asks: Ask[] = [];
  const uploads: Array<{ label: string; answer(r: CommandResult): void }> = [];
  const host = {
    store: {
      floorName: (id: string) => id,
      hireOptions: CAT,
      floorView: () => ({ seats: Array(6).fill(null), asleep: false, transition: null, level: { number: 2, count: 3 }, building: { name: 'HQ' } }),
      limits: { version: 0, list: () => [] },
      workerView: () => null,
      repoRefs: { state: { all_buildings: false }, onChange: () => () => {} },
    },
    send: (t: string, args: Record<string, unknown>) => {
      if (t === 'hire.prepare') return Promise.resolve({ ok: true, data: prep() } as CommandResult);
      return new Promise<CommandResult>((answer) => asks.push({ t, args, answer }));
    },
    upload: (_file: Blob, hint: { label: string }) => new Promise<CommandResult>((answer) => uploads.push({ label: hint.label, answer })),
    unsupported: () => false,
    reserve: () => () => {},
    held: () => new Set<number>(),
    toast: () => {},
    goTo: () => {},
    beep: () => {},
    hirePrefs: new HirePrefs(null),
    now: () => Date.now(),
  } as unknown as HireHost;
  const rv = new HireReviewDialog(document.body, host);
  const draft = () => (rv as unknown as { composer: { getDraft(): PromptDraft } }).composer.getDraft();
  const of = (t: string) => asks.filter((a) => a.t === t);
  return { rv, asks, uploads, draft, of };
}

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const hireBtn = () => q<HTMLButtonElement>('[data-key="hire"]')!;
const box = () => q('#review-task')!;
const pop = () => q('.desk-dlg--review .cmp-pop');
const isOpen = () => !!pop() && !pop()!.hidden;
const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });

/** Typing `s` at the end of the task (the browser's way: the text node, the caret, then `input`). */
function type(s: string): void {
  const ed = box();
  ed.focus();
  let node = [...ed.childNodes].reverse().find((n) => n.nodeType === Node.TEXT_NODE) as Text | undefined;
  if (!node) {
    node = document.createTextNode('');
    ed.replaceChildren(node);
  }
  const at = node.length;
  node.insertData(at, s);
  document.getSelection()?.setBaseAndExtent(node, at + s.length, node, at + s.length);
  ed.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('HireReviewDialog: the task is the shared composer', () => {
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

  it('hire from handoff: the task keeps its origin; a pasted image goes up first and its path is in the task worker.hire carries', async () => {
    const t = setup();
    const task = hireTask('/handoffs/floor/20261020-1200-pip-login.md');
    const choice = { ...fromHandoff({ harness: 'claude', model: 'claude-haiku-5-5' }, task, CAT), effort: 'high' };
    t.rv.open('floor', FULL, undefined, { choice });
    await flush();
    expect(t.rv.summary()!.choice.origin.task).toBe('handoff');
    expect(t.draft().doc.text).toBe(task);
    expect(q('[data-hook="task-origin"]')!.textContent).toContain('Reads the handoff file');

    t.draft().addImages([png()]);
    expect(t.rv.summary()!.form.prompt).toBe(`${task}[Image #1]`);
    expect(t.rv.summary()!.choice.origin.task).toBe('chosen');
    hireBtn().click();
    await flush();
    // Nothing is sent while the image is on its way, and the box is busy.
    expect(t.of('worker.hire')).toHaveLength(0);
    expect(t.rv.summary()!.state).toBe('hiring');
    expect(t.rv.summary()!.status).toBe('Uploading the image…');
    expect(t.uploads).toHaveLength(1);
    t.uploads[0]!.answer({ ok: true, data: { path: '/drop/h3d-Nibble-1.png' } } as CommandResult);
    await flush();
    await flush();
    const hires = t.of('worker.hire');
    expect(hires).toHaveLength(1);
    expect(hires[0]!.args.prompt).toContain(task);
    expect(hires[0]!.args.prompt).toContain('/drop/h3d-Nibble-1.png');
    expect(hires[0]!.args.prompt).not.toContain('[Image #1]');
  });

  it('an image that fails to upload: nobody is hired, the review stays as it was with the image', async () => {
    const t = setup();
    t.rv.open('floor', FULL);
    await flush();
    t.draft().addImages([png()]);
    hireBtn().click();
    await flush();
    t.uploads[0]!.answer({ ok: false, code: 'too_large', message: 'too big' } as CommandResult);
    await flush();
    await flush();
    expect(t.of('worker.hire')).toHaveLength(0);
    const s = t.rv.summary()!;
    expect(s.state).toBe('ready');
    expect(s.error).toBe(true);
    expect(s.status).toContain('did not upload');
    expect(t.draft().snapshot().images).toHaveLength(1);
  });

  it('/ asks the skills of the review’s harness and folder; @ searches the folder’s files', async () => {
    const t = setup();
    t.rv.open('floor', FULL);
    await flush();
    t.draft().replace(0, t.draft().doc.text.length, '');
    type('/');
    expect(isOpen()).toBe(true);
    expect(t.of('hire.commands').map((a) => a.args)).toEqual([{ floor: 'floor', harness: 'claude', cwd: '/home/test' }]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      type(' then @lob');
      await vi.advanceTimersByTimeAsync(60);
      expect(t.of('hire.files').map((a) => a.args)).toEqual([{ floor: 'floor', cwd: '/home/test', query: 'lob', limit: 30 }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
