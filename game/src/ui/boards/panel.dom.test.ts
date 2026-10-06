// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardIssues, BoardPrs, IssueCard, PullRequest } from '../../net/protocol';
import { h, replaceKeepingFocus } from '../dom';
import { BoardsPanel, type BoardsHost, type BoardState } from './panel';

// #160: a redraw of the board (a poll, a world event) never moves a scroll position.
// jsdom has no layout, so a scroller is a stored number; the two things a browser does that lost it are simulated:
// emptying a scroller clamps it to 0, and focus() without preventScroll scrolls the element into view (here: to the top).

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Gives `el` a scroll offset that survives nothing but a write, and a hook for what a browser would do to it. */
function scroller(el: HTMLElement) {
  const at = { top: 0, left: 0 };
  Object.defineProperty(el, 'scrollTop', { get: () => at.top, set: (v: number) => void (at.top = v), configurable: true });
  Object.defineProperty(el, 'scrollLeft', { get: () => at.left, set: (v: number) => void (at.left = v), configurable: true });
  return at;
}

const card = (n: number): IssueCard => ({ id: `i${n}`, key: `#${n}`, title: `Issue ${n}`, state: 'open', column: 'todo', labels: [], assignees: [], updated_at: null, closed_at: null, capabilities: { comment: true } });
const pr = (n: number): PullRequest => ({ id: `p${n}`, key: `#${n}`, title: `PR ${n}`, state: 'open', head_branch: `b${n}`, checks: 'success', review: 'none', mergeable: 'mergeable', closes: [], capabilities: { comment: true } });
const base = { session: 'floor', provider: 'github', provider_name: 'GitHub', initial: false, fetched_at: 1000 };

const issues = (n: number): BoardIssues => ({ ...base, t: 'board.issues', columns: [{ id: 'todo', name: 'Todo' }], cards: Array.from({ length: n }, (_, i) => card(i + 1)) });
const prs = (n: number): BoardPrs => ({ ...base, t: 'board.prs', prs: Array.from({ length: n }, (_, i) => pr(i + 1)), merged: [] });

function setup() {
  let state: BoardState = { issues: issues(40), prs: prs(40), off: null };
  const host = {
    store: { floorView: () => ({ workers: [] }) },
    session: () => 'floor',
    state: () => state,
    refresh: () => {},
    external: () => {},
    send: async (t: string) => (t === 'issue.get' ? { ok: true, data: { card: card(1), body: 'Body', author: { name: 'ann' }, created_at: 1000, comments: [] } } : { ok: true, data: { pr: pr(1), body: 'Body', author: { name: 'ann' }, created_at: 1000, comments: [], checks: [], files: [] } }),
    toast: () => {},
    now: () => 2000,
    unsupported: () => false,
    whyNoRun: () => null,
    whyNoHire: () => null,
    goTo: () => {},
  } as unknown as BoardsHost;
  const panel = new BoardsPanel(document.body, host);
  const body = document.querySelector<HTMLElement>('.bd-body') as HTMLElement;
  const item = document.querySelector<HTMLElement>('.bd-item') as HTMLElement;
  const at = scroller(body);
  const itemAt = scroller(item);
  const real = body.replaceChildren.bind(body);
  body.replaceChildren = (...n) => {
    real(...n);
    at.top = 0;
    at.left = 0;
  };
  const realItem = item.replaceChildren.bind(item);
  item.replaceChildren = (...n) => {
    realItem(...n);
    itemAt.top = 0;
    itemAt.left = 0;
  };
  return { panel, body, item, at, itemAt, set: (s: Partial<BoardState>) => (state = { ...state, ...s }) };
}

describe('BoardsPanel: scroll position across a refresh (#160)', () => {
  const focus = HTMLElement.prototype.focus;
  const focused: Array<boolean | undefined> = [];
  beforeEach(() => {
    // jsdom has no modal dialogs.
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
    // A browser scrolls the focused element into view unless told not to; the first card is at the top.
    HTMLElement.prototype.focus = function (this: HTMLElement, o?: FocusOptions) {
      focused.push(o?.preventScroll);
      focus.call(this, o);
      if (!o?.preventScroll) {
        const s = this.closest<HTMLElement>('.bd-body');
        if (s) s.scrollTop = 0;
      }
    };
    vi.stubGlobal('CSS', { escape: (s: string) => s });
  });
  afterEach(() => {
    HTMLElement.prototype.focus = focus;
    focused.length = 0;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  for (const [which, card] of [['issues', '.bd-card'] as const, ['prs', '.bd-pr'] as const]) {
    describe(which, () => {
      it('keeps the scroll offset with the focus on a card', () => {
        const { panel, body, at } = setup();
        panel.open(which, 'floor');
        expect(document.activeElement?.matches(card)).toBe(true);
        at.top = 700;
        at.left = 40;
        focused.length = 0;
        panel.refresh();
        // The board opts out of the scroll-into-view of the refocus (a browser may scroll before render() puts the offset back).
        expect(focused).toEqual([true]);
        expect(at).toEqual({ top: 700, left: 40 });
        expect(document.activeElement?.matches(card)).toBe(true);
        expect(body.contains(document.activeElement)).toBe(true);
      });

      it('keeps the scroll offset with the focus elsewhere', () => {
        const { panel, at } = setup();
        panel.open(which, 'floor');
        (document.activeElement as HTMLElement).blur();
        at.top = 700;
        panel.refresh();
        expect(at.top).toBe(700);
      });

      it('keeps it when the data changed and the focused card is still there', () => {
        const { panel, at, set } = setup();
        panel.open(which, 'floor');
        const focused = document.activeElement as HTMLElement;
        const key = focused.dataset.key;
        at.top = 500;
        set({ issues: issues(41), prs: prs(41) });
        panel.refresh();
        expect(at.top).toBe(500);
        expect((document.activeElement as HTMLElement).dataset.key).toBe(key);
      });
    });
  }

  it('starts at the top when it is opened, switched to the other list or another floor', () => {
    const { panel, at } = setup();
    panel.open('issues', 'floor');
    at.top = 600;
    panel.open('prs', 'floor');
    expect(at.top).toBe(0);
    at.top = 600;
    panel.close();
    panel.open('prs', 'floor');
    expect(at.top).toBe(0);
  });

  it('keeps the open item scrolled, and the comment box typed in, with its caret and its own scroll', async () => {
    const { panel, item, itemAt } = setup();
    panel.openItem('issues', 'floor', 'i1');
    await tick();
    const box = document.querySelector<HTMLTextAreaElement>('#bd-comment') as HTMLTextAreaElement;
    expect(box).toBeTruthy();
    // The box's own scroll goes when it is detached.
    const boxAt = scroller(box);
    const real = item.replaceChildren;
    item.replaceChildren = (...n) => {
      real.call(item, ...n);
      boxAt.top = 0;
    };
    box.value = 'a long\ncomment\nthat scrolls';
    box.focus();
    box.setSelectionRange(3, 9);
    itemAt.top = 250;
    boxAt.top = 30;
    panel.refresh();
    expect(document.querySelector('#bd-comment')).toBe(box);
    expect(itemAt.top).toBe(250);
    expect(boxAt.top).toBe(30);
    expect(box.value).toBe('a long\ncomment\nthat scrolls');
    expect([box.selectionStart, box.selectionEnd]).toEqual([3, 9]);
    expect(document.activeElement).toBe(box);
  });
});

describe('replaceKeepingFocus', () => {
  const focus = HTMLElement.prototype.focus;
  const calls: Array<[string | undefined, boolean | undefined]> = [];
  beforeEach(() => {
    vi.stubGlobal('CSS', { escape: (s: string) => s });
    HTMLElement.prototype.focus = function (this: HTMLElement, o?: FocusOptions) {
      calls.push([this.dataset.key, o?.preventScroll]);
      focus.call(this, o);
    };
  });
  afterEach(() => {
    HTMLElement.prototype.focus = focus;
    calls.length = 0;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  const btn = (key: string) => h('button', { 'data-key': key });
  const list = (...keys: string[]) => {
    const el = document.createElement('div');
    document.body.append(el);
    el.append(...keys.map(btn));
    return el;
  };

  it('by default puts focus back on the same element with a plain focus(), which scrolls to it', () => {
    const el = list('a', 'b');
    el.querySelector<HTMLElement>('[data-key="b"]')?.focus();
    calls.length = 0;
    replaceKeepingFocus(el, [btn('a'), btn('b')]);
    expect(calls).toEqual([['b', undefined]]);
  });

  it('with keepScroll puts focus back on the same element without scrolling to it', () => {
    const el = list('a', 'b');
    el.querySelector<HTMLElement>('[data-key="b"]')?.focus();
    calls.length = 0;
    replaceKeepingFocus(el, [btn('a'), btn('b')], undefined, { keepScroll: true });
    expect(calls).toEqual([['b', true]]);
  });

  it('brings a different element into view when the focused one is gone, keepScroll or not', () => {
    for (const keepScroll of [false, true]) {
      const el = list('a', 'b');
      el.querySelector<HTMLElement>('[data-key="b"]')?.focus();
      calls.length = 0;
      replaceKeepingFocus(el, [btn('a')], undefined, { keepScroll });
      expect(calls).toEqual([['a', undefined]]);
      el.remove();
    }
  });

  it('uses the fallback key before the first control', () => {
    const el = list('a', 'b');
    el.querySelector<HTMLElement>('[data-key="a"]')?.focus();
    calls.length = 0;
    replaceKeepingFocus(el, [btn('x'), btn('new')], 'new');
    expect(calls).toEqual([['new', undefined]]);
  });

  // A shared caller (Buildings reorder): the same-key control moves, e.g. below a tall block; focus must follow it into view.
  it('default mode scrolls a moved same-key control into view; keepScroll leaves the scroller alone', () => {
    const offset: Record<string, number> = { 'bdown:A': 1000 };
    HTMLElement.prototype.focus = function (this: HTMLElement, o?: FocusOptions) {
      calls.push([this.dataset.key, o?.preventScroll]);
      focus.call(this, o);
      if (!o?.preventScroll) {
        const s = this.parentElement as HTMLElement;
        s.scrollTop = offset[this.dataset.key ?? ''] ?? 0;
      }
    };
    for (const [keepScroll, scrollTop] of [[false, 1000], [true, 0]] as const) {
      const el = list('bdown:A', 'bdown:B', 'bdown:C');
      el.scrollTop = 0;
      el.querySelector<HTMLElement>('[data-key="bdown:A"]')?.focus();
      el.scrollTop = 0;
      replaceKeepingFocus(el, [btn('bdown:B'), btn('bdown:A'), btn('bdown:C')], undefined, keepScroll ? { keepScroll } : undefined);
      expect((document.activeElement as HTMLElement).dataset.key).toBe('bdown:A');
      expect(el.scrollTop).toBe(scrollTop);
      el.remove();
    }
  });
});
