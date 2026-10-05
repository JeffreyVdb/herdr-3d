// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Floor, Snapshot, Worker } from '../net/protocol';
import { WorldStore } from '../world/store';
import { buildOverview, countItems } from '../world/overview';
import { OverviewOverlay, type OverviewHost } from './overview';
import { OverviewPrefs } from './overviewPrefs';

const NOW = 1_790_000_000_000;

const worker = (id: string, over: Partial<Worker> = {}): Worker => ({ id, session: 'top', workspace_id: `ws-${id}`, label: id, name: id, status: 'idle', status_since: NOW - 60_000, ...over });

function world(workers: Worker[]): WorldStore {
  const s = new WorldStore(NOW);
  const floors: Floor[] = [{ session: 'top', state: 'running', building: 'b1', index: 0 }];
  const snap: Snapshot = { t: 'world.snapshot', seq: 1, world: { buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['top'] }], unassigned: [], floors, workers } };
  s.applySnapshot(snap, NOW);
  return s;
}

const CREW = [
  worker('o1', { role: 'orch', desk_index: 0, status: 'working', issue: { repo: 'o/r', number: 118, title: 'Floor overview' }, work_item: { provider: 'gh', id: 'o/r#118' } }),
  worker('c1', { role: 'code', orch_id: 'o1', round: 1, desk_index: 1, issue: { repo: 'o/r', number: 118 }, work_item: { provider: 'gh', id: 'o/r#118' } }),
  worker('r1', { role: 'review', orch_id: 'o1', round: 1, desk_index: 2 }),
  worker('emp', { desk_index: 3, status: 'blocked', digest: { task: 'Fix the flaky test', task_source: 'prompt', now_source: 'title' }, title: 'Running vitest' }),
];

function setup(workers: Worker[] = CREW, over: Partial<OverviewHost> = {}) {
  const store = world(workers);
  const bg = document.body.appendChild(document.createElement('div'));
  bg.className = 'hud';
  const host: OverviewHost = {
    data: (s) => {
      const fv = store.floorView(s);
      return fv ? { tree: buildOverview(store, s), where: 'Floor 1 of 1 · Work', counts: countItems(fv.counts, fv.asleep), asleep: fv.asleep } : null;
    },
    goTo: vi.fn(),
    openTicket: vi.fn(),
    hire: vi.fn(),
    calm: () => false,
    screenRect: () => null,
    closed: vi.fn(),
    now: () => NOW,
    ...over,
  };
  const prefs = new OverviewPrefs(null);
  const ov = new OverviewOverlay(document.body, host, prefs);
  return { ov, host, bg, prefs, store };
}

const key = (k: string, o: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
const keys = (ov: OverviewOverlay) => ov.info().rows.map((r) => `${'  '.repeat(r.depth)}${r.key}`);

afterEach(() => void (document.body.innerHTML = ''));

describe('the overview page (#118)', () => {
  it('opens over everything with the game behind it inert, and Esc closes it and gives the background back', async () => {
    const { ov, host, bg } = setup();
    ov.open('top');
    expect(ov.isOpen).toBe(true);
    const root = document.querySelector('.ov') as HTMLElement;
    expect(root.hidden).toBe(false);
    expect(root.hasAttribute('open')).toBe(true);
    expect(bg.inert).toBe(true);
    expect(document.querySelector('.ov-floor')?.textContent).toBe('top');
    expect([...document.querySelectorAll('.ov-count')].map((c) => c.getAttribute('title'))).toEqual(['1 working', '1 needs you', '2 idle']);
    key('Escape');
    await vi.waitFor(() => expect(ov.isOpen).toBe(false));
    expect(root.hidden).toBe(true);
    expect(bg.inert).toBe(false);
    expect(host.closed).toHaveBeenCalledTimes(1);
  });

  it('leaves the command palette out of what it makes inert, so the palette over the page is live (#147)', () => {
    const { ov, bg } = setup();
    const pal = document.body.appendChild(document.createElement('dialog'));
    pal.className = 'credits palette';
    ov.open('top');
    expect(bg.inert).toBe(true);
    expect(pal.inert).toBeFalsy(); // (jsdom: the property is only there once something sets it)
    ov.closeNow();
    expect(bg.inert).toBe(false);
  });

  it('marks the lines the LLM wrote AI, and only those (#118 phase 2)', () => {
    const { ov } = setup([
      worker('a', { desk_index: 0, digest: { task: 'Fix the login test', task_source: 'llm', now: 'Running the e2e suite', now_source: 'llm', now_at: NOW } }),
      worker('b', { desk_index: 1, digest: { task: 'Port the importer', task_source: 'prompt', now: 'Back after lunch', now_source: 'recap', now_at: NOW } }),
      worker('c', { desk_index: 2, digest: { task: 'Tidy the docs', task_source: 'ai_title', now: 'Writing the changelog', now_source: 'llm', now_at: NOW } }),
    ]);
    ov.open('top');
    const rows = [...document.querySelectorAll<HTMLElement>('.ov-row')];
    const marked = (r: HTMLElement | undefined) => [...(r?.querySelectorAll('.ov-line') ?? [])].map((l) => !!l.querySelector('.ov-llm'));
    expect(rows.map((r) => r.querySelector('.ov-task')?.textContent?.includes('AI') ?? false)).toEqual([true, false, false]);
    expect(rows.map((r) => r.querySelectorAll('.ov-llm').length)).toEqual([2, 0, 1]);
    expect(marked(rows[0]).every(Boolean)).toBe(true);
    expect(rows[0]?.querySelector('.ov-llm')?.getAttribute('title')).toBe('Summarised by the AI model');
    expect(rows[0]?.textContent).toContain('Running the e2e suite');
  });

  it('renders the tree, its lights from the display, and the lines', () => {
    const { ov } = setup();
    ov.open('top');
    expect(keys(ov)).toEqual(['o1', '  c1', '  r1', 'emp']);
    const rows = [...document.querySelectorAll<HTMLElement>('.ov-row')];
    expect(rows.map((r) => r.dataset.display)).toEqual(['working', 'idle', 'idle', 'needs_you']);
    expect(rows[0]?.querySelector('.ov-ticket')?.textContent).toBe('#118Floor overview');
    expect(rows[1]?.querySelector('.ov-ticket')).toBeNull(); // the orchestrator's own ticket
    expect(rows[3]?.querySelector('.ov-task')?.textContent).toContain('Fix the flaky test');
    expect(rows[3]?.querySelector('.ov-now')?.textContent).toContain('Running vitest');
    expect(rows[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(rows[1]?.getAttribute('aria-level')).toBe('2');
  });

  it('an orchestrator’s meta line: model, phase, round, pass and the over-cap chip', () => {
    const { ov } = setup([worker('o1', { role: 'orch', desk_index: 0, phase: 'waiting_user', round: 2, pass: 3, harness: 'claude', model: 'claude-opus-5-5' })]);
    ov.open('top');
    const row = document.querySelector('.ov-row[data-key="o1"]') as HTMLElement;
    expect(row.querySelector('.ov-meta')?.textContent).toMatch(/ · waiting for you · round 2 · pass 3 of 3$/);
    expect(row.querySelector('.ov-cap')?.textContent).toBe('Over cap');
  });

  it('a row’s click goes to that worker’s transcript and closes the page; a ticket’s opens the issue over it', () => {
    const { ov, host } = setup();
    ov.open('top');
    (document.querySelector('.ov-row[data-key="o1"] .ov-ticket') as HTMLElement).click();
    expect(host.openTicket).toHaveBeenCalledWith('top', 'o/r#118');
    expect(ov.isOpen).toBe(true);
    (document.querySelector('.ov-row[data-key="emp"] .ov-name') as HTMLElement).click();
    expect(host.goTo).toHaveBeenCalledWith('emp');
    expect(ov.isOpen).toBe(false);
  });

  it('keys: ↓ j ↑ k move, ← → fold and unfold, Space toggles, Shift+← / Shift+→ all, t the ticket, Enter the transcript', () => {
    const { ov, host, prefs } = setup();
    ov.open('top');
    expect(ov.info().focused).toBe('o1');
    key('ArrowDown');
    key('j');
    expect(ov.info().focused).toBe('r1');
    key('k');
    key('ArrowUp');
    expect(ov.info().focused).toBe('o1');
    key('ArrowLeft');
    expect(keys(ov)).toEqual(['o1', 'emp']);
    expect(prefs.collapsed('o1')).toBe(true);
    key('ArrowRight');
    expect(keys(ov)).toEqual(['o1', '  c1', '  r1', 'emp']);
    key(' ');
    expect(keys(ov)).toEqual(['o1', 'emp']);
    key('ArrowRight', { shiftKey: true });
    expect(keys(ov)).toEqual(['o1', '  c1', '  r1', 'emp']);
    key('ArrowLeft', { shiftKey: true });
    expect(keys(ov)).toEqual(['o1', 'emp']);
    key('ArrowRight');
    key('ArrowDown');
    key('ArrowLeft'); // on a child: up to its orchestrator
    expect(ov.info().focused).toBe('o1');
    key('t');
    expect(host.openTicket).toHaveBeenCalledWith('top', 'o/r#118');
    key('ArrowDown');
    key('Enter');
    expect(host.goTo).toHaveBeenCalledWith('c1');
  });

  it('a collapse folds the group’s rows away under it (height and opacity, a slight spring), out of the tree at once; calm: gone at once', async () => {
    const anims: Array<{ el: Element; frames: Keyframe[]; opts: KeyframeAnimationOptions; done: () => void }> = [];
    const proto = HTMLElement.prototype as unknown as { animate?: unknown };
    const had = proto.animate;
    proto.animate = function (this: Element, frames: Keyframe[], opts: KeyframeAnimationOptions) {
      let done = () => {};
      const finished = new Promise<void>((r) => (done = r));
      anims.push({ el: this, frames, opts, done });
      return { finished, cancel: () => done() } as unknown as Animation;
    };
    try {
      const { ov } = setup();
      ov.open('top');
      const kids = ['c1', 'r1'].map((k) => document.querySelector(`.ov-row[data-key="${k}"]`) as HTMLElement);
      key('ArrowLeft'); // o1 folds
      expect(keys(ov)).toEqual(['o1', 'emp']);
      expect(ov.info().focused).toBe('o1');
      expect(document.activeElement?.getAttribute('data-key')).toBe('o1');
      // Still on the board, under their group, folding: inert, not tree items, not focusable.
      const order = [...document.querySelectorAll<HTMLElement>('.ov-board > *')];
      expect(order.map((e) => e.dataset.key)).toEqual(['o1', 'c1', 'r1', 'emp']);
      for (const el of kids) {
        expect(el.classList.contains('ov-row--leaving')).toBe(true);
        expect(el.inert).toBe(true);
        expect(el.getAttribute('aria-hidden')).toBe('true');
        expect(el.hasAttribute('role')).toBe(false);
        expect(el.tabIndex).toBe(-1);
      }
      const fold = anims.filter((a) => kids.includes(a.el as HTMLElement));
      expect(fold).toHaveLength(2);
      for (const a of fold) {
        expect(a.frames.at(-1)).toMatchObject({ height: '0px', opacity: 0 });
        expect(a.opts.easing).toMatch(/cubic-bezier\(0\.45, -0\.22/); // the spring's lift
      }
      // A live refresh meanwhile keeps them folding where they are.
      ov.refresh();
      expect([...document.querySelectorAll<HTMLElement>('.ov-board > *')].map((e) => e.dataset.key)).toEqual(['o1', 'c1', 'r1', 'emp']);
      for (const a of fold) a.done();
      await vi.waitFor(() => expect(document.querySelectorAll('.ov-row--leaving')).toHaveLength(0));
      expect([...document.querySelectorAll<HTMLElement>('.ov-board > *')].map((e) => e.dataset.key)).toEqual(['o1', 'emp']);
      // Unfolding while they fold: they go at once and the group's rows come back.
      key('ArrowRight');
      key('ArrowLeft');
      key('ArrowRight');
      expect(document.querySelectorAll('.ov-row--leaving')).toHaveLength(0);
      expect([...document.querySelectorAll<HTMLElement>('.ov-board > *')].map((e) => e.dataset.key)).toEqual(['o1', 'c1', 'r1', 'emp']);
      ov.closeNow();
      document.body.innerHTML = '';
      // Calm: no fold, they are gone at once.
      const calm = setup(CREW, { calm: () => true });
      calm.ov.open('top');
      anims.length = 0;
      key('ArrowLeft');
      expect(anims).toHaveLength(0);
      expect([...document.querySelectorAll<HTMLElement>('.ov-board > *')].map((e) => e.dataset.key)).toEqual(['o1', 'emp']);
    } finally {
      proto.animate = had;
    }
  });

  it('Expand all and Collapse all buttons', () => {
    const { ov } = setup();
    ov.open('top');
    const btn = (t: string) => [...document.querySelectorAll<HTMLButtonElement>('.ov-btn')].find((b) => b.textContent === t) as HTMLButtonElement;
    btn('Collapse all').click();
    expect(keys(ov)).toEqual(['o1', 'emp']);
    btn('Expand all').click();
    expect(keys(ov)).toEqual(['o1', '  c1', '  r1', 'emp']);
  });

  it('stays live: a status change updates the row in place (same element), never its place', () => {
    const { ov, store } = setup();
    ov.open('top');
    const el = document.querySelector('.ov-row[data-key="c1"]');
    store.applyEvent({ t: 'worker.status', seq: 2, id: 'c1', session: 'top', workspace_id: 'ws-c1', status: 'working', prev_status: 'idle', status_since: NOW, title: 'Coding' }, NOW);
    ov.refresh();
    expect(keys(ov)).toEqual(['o1', '  c1', '  r1', 'emp']);
    const now = document.querySelector<HTMLElement>('.ov-row[data-key="c1"]');
    expect(now).toBe(el);
    expect(now?.dataset.display).toBe('working');
  });

  it('an empty floor: Nobody’s here yet, and Hire', () => {
    const { ov, host } = setup([]);
    ov.open('top');
    expect(ov.info().empty).toBe(true);
    const empty = document.querySelector('.ov-empty') as HTMLElement;
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toContain('Nobody’s here yet');
    (empty.querySelector('button') as HTMLButtonElement).click();
    expect(host.hire).toHaveBeenCalled();
    expect(ov.isOpen).toBe(false);
  });

  it('battery saver or reduced motion: calm (no blink, cascade or flap)', () => {
    const calm = setup(CREW, { calm: () => true });
    calm.ov.open('top');
    expect(calm.ov.info().calm).toBe(true);
    expect(document.querySelector('.ov')?.hasAttribute('data-calm')).toBe(true);
    document.body.innerHTML = '';
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q }) as MediaQueryList);
    const reduced = setup();
    reduced.ov.open('top');
    expect(reduced.ov.info().calm).toBe(true);
    vi.unstubAllGlobals();
  });

  it('a modal dialog over it (the issue window) gets the keys', () => {
    const { ov } = setup();
    ov.open('top');
    const d = document.body.appendChild(document.createElement('dialog'));
    // jsdom has no showModal top layer: `:modal` is what the page asks.
    const qs = document.querySelector.bind(document);
    vi.spyOn(document, 'querySelector').mockImplementation(((sel: string) => (sel === 'dialog:modal' ? d : qs(sel))) as typeof document.querySelector);
    key('Escape');
    expect(ov.isOpen).toBe(true);
    vi.restoreAllMocks();
  });
});
