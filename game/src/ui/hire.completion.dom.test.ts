// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../net/client';
import type { Draft as PromptDraft } from './composer/draft';
import { HireDialog, type HireHost } from './hire';

// #39: the real Hire worker dialog's First task completes `/` skills, `@` files and `@r:` repositories of the hire's
// context, and none of it ever holds the dialog: the lookups are asked only when a popup opens, answer only the popup,
// and a reply for a context the dialog has left is never shown or put in.

const prep = (cwd = '/home/test') => ({
  cwd,
  label: 'default',
  git: null,
  choice: { harness: 'codex', model: 'gpt', effort: 'high' },
  choice_source: 'floor_default',
  capacity: { floor: { count: 0, soft: 10, hard: 20 }, host: { count: 0, soft: 10, hard: 20 } },
});

const flush = () => new Promise((r) => setTimeout(r, 0));

interface Ask {
  t: string;
  args: Record<string, unknown>;
  answer(r: CommandResult): Promise<void>;
  settled: boolean;
}

function setup() {
  const asks: Ask[] = [];
  const host = {
    store: {
      hireOptions: { codex: { models: ['gpt'], efforts: ['high'] }, claude: { models: ['opus'], efforts: ['max'] } },
      floorView: () => ({ seats: Array(10).fill(null) }),
      limits: { version: 0, list: () => [] },
      workerView: () => null,
      repoRefs: { state: { all_buildings: false }, onChange: () => () => {} },
    },
    send: (t: string, args: Record<string, unknown>) => {
      if (t === 'hire.prepare') return Promise.resolve({ ok: true, data: prep() });
      return new Promise<CommandResult>((res) => {
        const a: Ask = {
          t,
          args,
          settled: false,
          async answer(r) {
            a.settled = true;
            res(r);
            await flush();
          },
        };
        asks.push(a);
      });
    },
    unsupported: () => false,
    reserve: () => () => {},
    held: () => new Set<number>(),
    toast: () => {},
    now: () => Date.now(),
    upload: () => new Promise(() => {}),
  } as unknown as HireHost;
  const dlg = new HireDialog(document.body, host);
  const of = (t: string) => asks.filter((a) => a.t === t);
  return { dlg, asks, of, draft: () => (dlg as unknown as { editor: { draft: PromptDraft } }).editor.draft };
}

const box = () => document.querySelector<HTMLElement>('#hire-task')!;
const pop = () => document.querySelector<HTMLElement>('.desk-dlg--hire .cmp-pop');
const isOpen = () => !!pop() && !pop()!.hidden;
const rows = () => [...document.querySelectorAll<HTMLElement>('.desk-dlg--hire [role="option"]')];
const status = () => {
  const s = document.querySelector<HTMLElement>('.desk-dlg--hire .cmp-pop-status');
  return s && !s.hidden ? s.textContent : null;
};
const retry = () => document.querySelector<HTMLButtonElement>('.desk-dlg--hire .cmp-pop-retry')!;
const text = () => (box().textContent ?? '').replace(/​/g, '');

/** Typing `s` at the end of the First task (the browser's way: the text node, the caret, then `input`). */
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
const press = (k: string) => box().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

describe('HireDialog: completion in the First task (#39)', () => {
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

  it('with the skill lookup stalled: opens and types at once, / says Loading skills…, and an ordinary task is hired before it answers', async () => {
    const { dlg, of, draft } = setup();
    dlg.open('floor', 0);
    await flush();
    // Opening asked nothing but hire.prepare.
    expect(of('hire.commands')).toHaveLength(0);
    type('/');
    expect(isOpen()).toBe(true);
    expect(status()).toBe('Loading skills…');
    expect(of('hire.commands').map((a) => a.args)).toEqual([{ session: 'floor', harness: 'codex', cwd: '/home/test' }]);
    // The dialog is not busy: the editor takes typing, Hire is on.
    expect(box().getAttribute('contenteditable')).toBe('true');
    expect(document.querySelector<HTMLButtonElement>('.desk-dlg--hire button[type="submit"]')?.disabled).toBe(false);
    press('Escape');
    expect(isOpen()).toBe(false);
    type(' fix the lobby lights');
    press('Enter');
    await flush();
    await flush();
    const hires = of('worker.hire');
    expect(hires).toHaveLength(1);
    expect(hires[0]!.args.prompt).toBe('/ fix the lobby lights');
    expect(of('hire.commands')[0]!.settled).toBe(false);
    // The lookup answers late, then fails: neither touches what was typed (nor opens anything).
    await of('hire.commands')[0]!.answer({ ok: false, code: 'timeout', message: 'no answer' });
    expect(draft().doc.text).toBe('/ fix the lobby lights');
    expect(isOpen()).toBe(false);
  });

  it('a failed lookup says why in the popup and Try again asks again', async () => {
    const { dlg, of } = setup();
    dlg.open('floor', 0);
    await flush();
    type('/');
    await of('hire.commands')[0]!.answer({ ok: false, code: 'internal', message: 'probe failed' });
    expect(status()).toBe('Could not load skills: probe failed.');
    expect(retry().hidden).toBe(false);
    retry().click();
    expect(of('hire.commands')).toHaveLength(2);
    expect(status()).toBe('Loading skills…');
    await of('hire.commands')[1]!.answer({ ok: true, data: { commands: [{ name: 'grill', description: 'Grill it', argument_hint: '', kind: 'skill' }], partial: false } });
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining('/grill')]);
    expect(retry().hidden).toBe(true);
    press('Enter');
    expect(text()).toBe('/grill ');
  });

  it('@ searches the hire’s folder, @r: the other floors’ repositories; a file is a chip, a repository plain text', async () => {
    const { dlg, of, draft } = setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      dlg.open('floor', 0);
      await vi.runAllTimersAsync();
      type('@lob');
      expect(status()).toBe('Searching files…');
      await vi.advanceTimersByTimeAsync(60);
      expect(of('hire.files').map((a) => a.args)).toEqual([{ session: 'floor', cwd: '/home/test', query: 'lob', limit: 30 }]);
      of('hire.files')[0]!.answer({ ok: true, data: { files: [{ path: 'src/lobby.ts', kind: 'file', indices: [4, 5, 6] }], source: 'git', reason: null } });
      await vi.runAllTimersAsync();
      press('Enter');
      expect(draft().snapshot().segments.some((g) => g.kind === 'file' && g.path === 'src/lobby.ts')).toBe(true);
      type('then @r:api');
      expect(of('hire.repos').map((a) => a.args)).toEqual([{ session: 'floor' }]);
      of('hire.repos')[0]!.answer({ ok: true, data: { repos: [{ session: 'api', building: 'Work', same_building: true, repo: 'acme/api', dir: '/src/api', cloned: true }] } });
      await vi.runAllTimersAsync();
      press('Enter');
      expect(draft().doc.text.endsWith('then /src/api ')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('another harness or floor: the old context’s reply is never shown, and its rows are never put in', async () => {
    const { dlg, of } = setup();
    dlg.open('floor', 0);
    await flush();
    const gen = dlg.lookupGeneration;
    type('/');
    expect(of('hire.commands')).toHaveLength(1);
    // The harness changes while the Codex list is on its way.
    const claude = document.querySelector<HTMLInputElement>('[data-key="harness:claude"]')!;
    claude.checked = true;
    claude.dispatchEvent(new Event('change'));
    await flush();
    expect(dlg.lookupGeneration).toBe(gen + 1);
    // The open popup asks again, in the new context.
    expect(of('hire.commands').map((a) => a.args.harness)).toEqual(['codex', 'claude']);
    await of('hire.commands')[0]!.answer({ ok: true, data: { commands: [{ name: 'codex-only', description: '', argument_hint: '', kind: 'skill' }], partial: false } });
    expect(rows()).toHaveLength(0);
    expect(status()).toBe('Loading skills…');
    await of('hire.commands')[1]!.answer({ ok: true, data: { commands: [{ name: 'claude-skill', description: '', argument_hint: '', kind: 'skill' }], partial: false } });
    expect(rows().map((r) => r.querySelector('.tx-cmd-name')?.textContent)).toEqual(['/claude-skill']);

    // Rows listed for one floor, then the dialog moves to another: a pick of them puts nothing in.
    const before = text();
    dlg.open('other', 1);
    await flush();
    expect(isOpen()).toBe(false);
    expect(dlg.lookupGeneration).toBeGreaterThan(gen + 1);
    expect(text()).not.toContain('/claude-skill');
    void before;
  });
});
