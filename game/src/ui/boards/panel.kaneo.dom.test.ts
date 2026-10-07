// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardIssues, IssueCard } from '../../net/protocol';
import { BoardsPanel, type BoardsHost, type BoardState } from './panel';

// #184: a Kaneo board in the Issues overlay: its own words, its virtual columns, no GitHub close, and the board's
// limits (a truncated read, a paused key) said out loud.

const tick = () => new Promise((r) => setTimeout(r, 0));

const task = (id: string, column: string, over: Partial<IssueCard> = {}): IssueCard => ({
  id,
  key: `HRD-${id.slice(1)}`,
  title: `Task ${id}`,
  state: column === 'done' ? 'closed' : 'open',
  column,
  url: `https://tasks.example.test/dashboard/workspace/w/project/p/task/${id}`,
  labels: [],
  assignees: [],
  updated_at: 0,
  closed_at: null,
  ...over,
});

const board = (over: Partial<BoardIssues> = {}): BoardIssues => ({
  t: 'board.issues',
  session: 'floor',
  provider: 'kaneo',
  provider_name: 'Kaneo',
  initial: false,
  fetched_at: 1000,
  capabilities: { comment: true, close: false, set_status: true, order: true },
  columns: [
    { id: 'planned', name: 'Planned', kind: 'planned' },
    { id: 'to-do', name: 'To Do' },
    { id: 'done', name: 'Done', done: true },
    { id: 'shipped', name: 'Shipped', done: true },
    { id: 'archived', name: 'Archived', kind: 'archived' },
  ],
  cards: [task('t1', 'to-do'), task('t2', 'to-do'), task('t3', 'done'), task('t4', 'archived'), task('t5', 'planned')],
  ...over,
});

function setup(issues: BoardIssues) {
  const state: BoardState = { issues, prs: null, off: null };
  const sent: Array<{ t: string; args: Record<string, unknown> }> = [];
  const asked: unknown[][] = [];
  const opened: string[] = [];
  const host = {
    store: { floorView: () => ({ workers: [] }) },
    session: () => 'floor',
    state: () => state,
    refresh: () => {},
    external: (u: string) => opened.push(u),
    send: async (t: string, args: Record<string, unknown>) => {
      sent.push({ t, args });
      if (t === 'issue.get') return { ok: true, data: { card: issues.cards[0], body: 'The **description**', author: { name: '' }, created_at: 0, comments: [] } };
      return { ok: true, data: {} };
    },
    toast: () => {},
    now: () => 2000,
    unsupported: () => false,
    whyNoRun: () => null,
    whyNoHire: () => null,
    goTo: () => {},
    handTo: () => {},
    ask: (...a: unknown[]) => asked.push(a),
  } as unknown as BoardsHost;
  const panel = new BoardsPanel(document.body, host);
  return { panel, sent, asked, opened };
}

describe('a Kaneo board (#184)', () => {
  beforeEach(() => {
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

  it('names tasks, marks planned and archived as their own kind (archive is not done) and both final columns as done', () => {
    const { panel } = setup(board());
    panel.open('issues', 'floor');
    expect(document.getElementById('board-title')!.textContent).toBe('Tasks · floor');
    const col = (id: string) => document.querySelector<HTMLElement>(`.bd-col[data-col="${id}"]`)!;
    expect(col('planned').dataset.kind).toBe('planned');
    expect(col('archived').dataset.kind).toBe('archived');
    expect(col('archived').dataset.done).toBeUndefined();
    expect(col('archived').textContent).toContain('archived, not done');
    expect(col('done').dataset.done).toBe('true');
    expect(col('shipped').dataset.done).toBe('true');
    expect(col('done').querySelector('.bd-closed')!.textContent).toBe('done');
    expect(col('archived').querySelector('.bd-closed')).toBeNull();
    expect(col('to-do').textContent).toContain('HRD-1');
    expect(document.querySelector('.bd-body')!.textContent).not.toMatch(/ago|recently/); // no timestamps to invent
  });

  it('offers no GitHub close, opens the task in Kaneo, and asks a worker with the description it read', async () => {
    const { panel, asked, opened } = setup(board());
    panel.openItem('issues', 'floor', 't1');
    await tick();
    const foot = document.getElementById('item-title')!.closest('dialog')!;
    const buttons = [...foot.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).not.toContain('Close issue…');
    expect(buttons).toContain('Open in Kaneo');
    expect(document.getElementById('item-title')!.textContent).toBe('Task t1');
    foot.querySelector<HTMLButtonElement>('[data-key="open"]')!.click();
    expect(opened).toEqual(['https://tasks.example.test/dashboard/workspace/w/project/p/task/t1']);
    foot.querySelector<HTMLButtonElement>('[data-key="ask"]')!.click();
    expect(asked[0]?.slice(2)).toEqual(['kaneo', 'The **description**']);
  });

  it('says a truncated board is incomplete, and a drop there moves only the status', async () => {
    const { panel, sent } = setup(board({ truncated: true }));
    panel.open('issues', 'floor');
    expect(document.querySelector('.bd-notice, [class*="notice"]')!.textContent).toContain('some items are missing');
    (panel as unknown as { dropCard(id: string, column: string, after: string | null): void }).dropCard('t1', 'done', 't3');
    await tick();
    expect(sent.at(-1)).toEqual({ t: 'issue.set_status', args: { session: 'floor', id: 't1', column: 'done' } });
  });

  it('a refused key pauses the board and says how to resume', () => {
    const { panel } = setup(board({ stale: true, error: 'kaneo: 401', error_code: 'unauthorized', paused_until: 5_000_000 }));
    panel.open('issues', 'floor');
    const text = document.querySelector('[data-tone]')!.textContent ?? '';
    expect(text).toContain('refused herdr-world’s key');
    expect(text).toContain('paused');
    expect(text).toContain('Settings');
  });
});
