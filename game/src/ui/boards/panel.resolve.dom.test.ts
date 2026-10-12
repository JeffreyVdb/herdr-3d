// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardPrs, PullRequest } from '../../net/protocol';
import { BoardsPanel, type BoardsHost } from './panel';

// #248: the PR footer: three groups, one primary, "Resolve conflicts with a worker" only on a conflicting PR.

const tick = () => new Promise((r) => setTimeout(r, 0));
const pr = (n: number, mergeable: PullRequest['mergeable']): PullRequest => ({
  id: `p${n}`,
  key: `#${n}`,
  title: `PR ${n}`,
  state: 'open',
  url: `https://example.test/pull/${n}`,
  head_branch: `b${n}`,
  base_branch: 'main',
  checks: 'success',
  review: 'none',
  mergeable,
  closes: [],
  capabilities: { comment: true, merge: true },
});
const PRS = [pr(1, 'mergeable'), pr(2, 'conflicting'), pr(3, 'unknown')];
const board: BoardPrs = { session: 'floor', provider: 'github', provider_name: 'GitHub', initial: false, fetched_at: 1000, t: 'board.prs', prs: PRS, merged: [] };

function setup(whyNoHire: string | null = null) {
  const resolve = vi.fn();
  const review = vi.fn();
  const host = {
    store: { floorView: () => ({ workers: [] }) },
    session: () => 'floor',
    state: () => ({ issues: null, prs: board, off: null }),
    refresh: () => {},
    external: () => {},
    send: async (_t: string, a: { id: string }) => ({ ok: true, data: { pr: PRS.find((p) => p.id === a.id), body: 'Body', author: { name: 'ann' }, created_at: 1000, comments: [], checks: [], files: [] } }),
    toast: () => {},
    now: () => 2000,
    unsupported: () => false,
    whyNoRun: () => null,
    whyNoHire: () => whyNoHire,
    goTo: () => {},
    review,
    resolve,
  } as unknown as BoardsHost;
  const panel = new BoardsPanel(document.body, host);
  const open = async (id: string) => {
    panel.openItem('prs', 'floor', id);
    await tick();
    await tick();
  };
  const key = (k: string) => document.querySelector<HTMLElement>(`.bd-actions [data-key="${k}"]`);
  return { panel, open, key, resolve, review };
}

describe('BoardsPanel: the PR footer (#248)', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });
  afterEach(() => document.body.replaceChildren());

  it('a mergeable or unknown PR: Review is the one primary, no Resolve, no Comment button', async () => {
    const s = setup();
    for (const [id, merge] of [['p1', ['merge']], ['p3', ['merge', 'merge-anyway']]] as const) {
      await s.open(id);
      expect(s.panel.summary()?.item?.actions, id).toEqual(['review', 'merge-method', ...merge, 'open']);
      expect(document.querySelectorAll('.bd-actions .btn--primary')).toHaveLength(1);
      expect(s.key('review')!.classList.contains('btn--primary')).toBe(true);
    }
    // The comment box itself stays.
    expect(document.querySelector('#bd-comment')).not.toBeNull();
  });

  it('a conflicting PR: Resolve is the one primary, Review quiet; the select stays and Merge says why it is off', async () => {
    const s = setup();
    await s.open('p2');
    expect(s.panel.summary()?.item?.actions).toEqual(['resolve', 'review', 'merge-method', 'merge', 'open']);
    expect([...document.querySelectorAll<HTMLElement>('.bd-actions .btn--primary')].map((b) => b.dataset.key)).toEqual(['resolve']);
    expect(s.key('review')!.classList.contains('btn--quiet')).toBe(true);
    expect(s.key('merge')!.getAttribute('aria-disabled')).toBe('true');
    expect(s.key('merge')!.title).toMatch(/merge conflicts/);
    // Three groups, in order: the workers, the merge, the way out.
    expect([...document.querySelectorAll<HTMLElement>('.bd-actions > .bd-group')].map((g) => [...g.querySelectorAll<HTMLElement>('[data-key]')].map((e) => e.dataset.key))).toEqual([['resolve', 'review'], ['merge-method', 'merge'], ['open']]);
  });

  it('Resolve hands over the merge method picked in the select', async () => {
    const s = setup();
    await s.open('p2');
    const sel = s.key('merge-method') as HTMLSelectElement;
    sel.value = 'rebase';
    sel.dispatchEvent(new Event('change'));
    s.key('resolve')!.click();
    expect(s.resolve).toHaveBeenCalledWith('floor', expect.objectContaining({ id: 'p2' }), 'rebase');
  });

  it('follows whyNoHire like Review: on screen but off, with the reason as its tooltip', async () => {
    const s = setup('The floor is asleep.');
    await s.open('p2');
    expect(s.key('resolve')!.getAttribute('aria-disabled')).toBe('true');
    expect(s.key('resolve')!.title).toBe('The floor is asleep.');
    s.key('resolve')!.click();
    expect(s.resolve).not.toHaveBeenCalled();
  });
});
