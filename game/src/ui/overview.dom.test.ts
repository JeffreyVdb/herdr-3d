// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Floor, Snapshot, Worker } from '../net/protocol';
import { WorldStore } from '../world/store';
import { buildCityOverview, buildOverview, cityCountItems, countItems } from '../world/overview';
import { OverviewOverlay, type OverviewHost } from './overview';
import { OverviewFilterPrefs, OverviewPrefs } from './overviewPrefs';

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
    cityData: () => ({ tree: buildCityOverview(store), where: '1 floor in 1 building', counts: cityCountItems(store.city().flatMap((b) => b.floors)) }),
    goToFloor: vi.fn(),
    goTo: vi.fn(),
    goToChild: vi.fn(),
    openTicket: vi.fn(),
    retrySummary: vi.fn(),
    hire: vi.fn(),
    calm: () => false,
    screenRect: () => null,
    floorName: (f) => f,
    closed: vi.fn(),
    now: () => NOW,
    ...over,
  };
  const prefs = new OverviewPrefs(null);
  const filter = new OverviewFilterPrefs(null);
  const ov = new OverviewOverlay(document.body, host, prefs, filter);
  return { ov, host, bg, prefs, filter, store };
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

  it('marks the lines the LLM wrote with the sparkle beside their label, and only those (#118 phase 2, #232)', () => {
    const { ov } = setup([
      worker('a', { desk_index: 0, digest: { task: 'Fix the login test', task_source: 'llm', now: 'Running the e2e suite', now_source: 'llm', now_at: NOW } }),
      worker('b', { desk_index: 1, digest: { task: 'Port the importer', task_source: 'prompt', now: 'Back after lunch', now_source: 'recap', now_at: NOW } }),
      worker('c', { desk_index: 2, digest: { task: 'Tidy the docs', task_source: 'ai_title', now: 'Writing the changelog', now_source: 'llm', now_at: NOW } }),
    ]);
    ov.open('top');
    const rows = [...document.querySelectorAll<HTMLElement>('.ov-row')];
    expect(rows.map((r) => r.querySelectorAll('.ov-ai').length)).toEqual([2, 0, 1]);
    // Both kinds of line: the sparkle is the label's, before the text, never in the since column or after the text.
    for (const m of document.querySelectorAll<HTMLElement>('.ov-ai')) {
      expect(m.parentElement?.localName).toBe('b');
      expect(m.parentElement?.parentElement?.firstElementChild).toBe(m.parentElement);
      expect(m.getAttribute('role')).toBe('img');
      expect(m.getAttribute('aria-label')).toBe(m.title);
      const svg = m.querySelector('svg');
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
      expect(svg?.querySelector('path')?.getAttribute('fill')).toBe('currentColor');
    }
    expect(rows[0]?.querySelector('.ov-task > b')?.textContent).toBe('Task');
    expect(rows[0]?.querySelector('.ov-task .ov-ai')?.getAttribute('title')).toBe('AI-generated summary of what this worker was asked to do.');
    expect(rows[0]?.querySelector('.ov-now .ov-ai')?.getAttribute('title')).toMatch(/^AI-generated summary of this worker’s recent activity \(its last 5 steps\); generated just now\./);
    expect(document.querySelector('.ov-since .ov-ai, .ov-llm')).toBeNull();
    // A task line has no time: the sparkle alone (#119: its metadata slot kept, empty); a model's now line says how old it
    // is at the line's end.
    expect(rows[0]?.querySelector('.ov-task .ov-ai-meta')?.textContent).toBe('');
    expect(rows[0]?.querySelector('.ov-now > .ov-ai-meta > .ov-age')?.textContent).toBe('just now');
    expect(rows[0]?.getAttribute('aria-label')).toContain('Task: Fix the login test (AI summary) · Now: Running the e2e suite (AI summary, just now)');
    expect(rows[1]?.getAttribute('aria-label')).not.toContain('AI');
  });

  it('a model’s now line with no time keeps its sparkle and invents no age (#232)', () => {
    const { ov } = setup([worker('a', { desk_index: 0, digest: { now: 'Writing the changelog', now_source: 'llm' } })]);
    ov.open('top');
    const line = document.querySelector<HTMLElement>('.ov-now');
    expect(line?.querySelector('.ov-ai')?.getAttribute('aria-label')).toBe('AI-generated summary of this worker’s recent activity (its last 5 steps).');
    expect(line?.querySelector('.ov-ai-meta')?.childElementCount).toBe(0); // #119: the slot is kept, empty
    expect(line?.textContent).toBe('NowWriting the changelog');
    expect(document.querySelector('.ov-row')?.getAttribute('aria-label')).toContain('Now: Writing the changelog (AI summary)');
  });

  it('says how long ago the model wrote a now line, and the 20 s refresh moves the ages and the time in place (#198, #232)', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let now = NOW;
      const act = { kind: 'investigating' as const, detail: 'grep -n activityOf', since: NOW - 5_000, source: 'rule' as const };
      const { ov } = setup([worker('a', { desk_index: 0, status: 'working', activity: act, digest: { now: 'Running the e2e suite', now_source: 'llm', now_at: NOW - 30_000 } })], { now: () => now });
      ov.open('top');
      const row = document.querySelector<HTMLElement>('.ov-row');
      const parts = { line: row?.querySelector('.ov-now'), doing: row?.querySelector('.ov-doing'), verb: row?.querySelector('.ov-verb'), age: row?.querySelector('.ov-age'), time: row?.querySelector('.ov-time') };
      const mark = () => row?.querySelector<HTMLElement>('.ov-now .ov-ai');
      expect(parts.age?.textContent).toBe('just now');
      expect(mark()?.getAttribute('title')).toBe(
        'AI-generated summary of this worker’s recent activity (its last 5 steps); generated just now. The time is when the summary was written, not when the activity happened.',
      );
      expect(parts.doing?.textContent).toBe('Investigating · grep -n activityOf · 1m');
      expect(row?.getAttribute('aria-label')).toContain('Now: Running the e2e suite (AI summary, just now)');
      // Three minutes on, nothing else changed: the page's own timer moves the age and the time, and only them.
      now = NOW + 3 * 60_000;
      vi.advanceTimersByTime(20_000);
      expect(document.querySelector('.ov-row')).toBe(row);
      for (const [k, e] of Object.entries(parts)) expect(row?.querySelector(`.ov-${k === 'line' ? 'now' : k}`), k).toBe(e);
      expect(row?.querySelector('.ov-now-text')?.textContent).toBe('Running the e2e suite');
      expect(parts.age?.textContent).toBe('3m ago');
      expect(parts.time?.textContent).toBe('4m');
      expect(parts.doing?.textContent).toBe('Investigating · grep -n activityOf · 4m');
      expect(mark()?.getAttribute('aria-label')).toContain('; generated 3m ago. The time is when the summary was written');
      expect(row?.getAttribute('aria-label')).toContain('(AI summary, 3m ago)');
      expect(row?.getAttribute('aria-label')).toMatch(/ · working 4m$/);
      ov.closeNow();
    } finally {
      vi.useRealTimers();
    }
  });

  // #174
  const STATUSED = [
    worker('t1', { desk_index: 0, status: 'working', title: 'Reading hub.go', digest: { task: 'Investigate. Missing transcript diffs.', task_source: 'prompt', now_source: 'title', task_status: { state: 'retrying', reason: 'bad_response', attempts: 1, retry_at: NOW + 60_000 }, now_status: { state: 'failed', reason: 'truncated', attempts: 1 } } }),
    worker('t2', { desk_index: 1, digest: { task: 'Replace Hacker with Ubuntu styling', task_source: 'prompt', now_source: 'title', task_status: { state: 'pending' } }, title: 'idle' }),
    worker('t3', { desk_index: 2, digest: { task: 'Fine', task_source: 'llm', now_source: 'title', task_status: { state: 'failed', reason: 'timeout' } }, title: 'x' }),
  ];

  it('says what became of the model’s line where the AI badge would be, and how to recover (#174)', () => {
    const { ov } = setup(STATUSED);
    ov.open('top');
    const rows = [...document.querySelectorAll<HTMLElement>('.ov-row')];
    const task = (i: number) => rows[i]?.querySelector('.ov-task .ov-ai-state');
    const now = (i: number) => rows[i]?.querySelector('.ov-now .ov-ai-state');
    expect(task(0)?.textContent).toMatch(/^AI retry \d\d:\d\d/);
    expect(task(0)?.getAttribute('title')).toContain('failed: the model’s answer was not usable');
    expect(task(0)?.getAttribute('title')).toContain('tries again at');
    expect(now(0)?.textContent).toBe('AI failed');
    expect(now(0)?.getAttribute('aria-label')).toContain('token budget');
    expect(now(0)?.getAttribute('title')).toContain('with newer activity or when the turn ends');
    expect(rows[0]?.querySelectorAll('.ov-retry')).toHaveLength(2);
    // Pending: (#119) the busy mark in the line's metadata (its words in its title and for a screen reader), no retry, and
    // no sparkle (the line shown is the fallback); the model's own line carries the sparkle and no status.
    const busy = rows[1]?.querySelector<HTMLElement>('.ov-task > .ov-ai-meta > .ov-busy');
    expect(busy?.getAttribute('role')).toBe('img');
    expect(busy?.getAttribute('aria-label')).toBe('The AI line is being written; the line shown is the fallback until then.');
    expect(busy?.title).toBe(busy?.getAttribute('aria-label'));
    expect(rows[1]?.querySelector('.ov-task-text')?.textContent).toBe('Replace Hacker with Ubuntu styling');
    expect(task(1)).toBeNull();
    expect(rows[1]?.querySelector('.ov-ai')).toBeNull();
    expect(rows[1]?.querySelector('.ov-retry')).toBeNull();
    const css = readFileSync(resolve(import.meta.dirname, 'overview.css'), 'utf8');
    expect(css).toMatch(/\.ov-ai-state--pending \{[^}]*border: 0/);
    expect(rows[2]?.querySelector('.ov-ai-state')).toBeNull();
    expect(rows[2]?.querySelector('.ov-task .ov-ai')).not.toBeNull();
    // The row's spoken label has the words too.
    expect(rows[0]?.getAttribute('aria-label')).toContain('Task: Investigate. Missing transcript diffs. (AI retry');
    expect(rows[0]?.getAttribute('aria-label')).toContain('(AI failed)');
  });

  it('Retry (the button, and R on the focused row) asks the host to try that worker’s summary again', () => {
    const { ov, host } = setup(STATUSED);
    ov.open('top');
    const rows = [...document.querySelectorAll<HTMLElement>('.ov-row')];
    rows[0]?.querySelector<HTMLButtonElement>('.ov-retry')?.click();
    expect(host.retrySummary).toHaveBeenLastCalledWith('t1');
    expect(host.goTo).not.toHaveBeenCalled(); // not an open of the row
    const press = (key: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    expect(ov.info().focused).toBe('t1');
    press('r');
    expect(host.retrySummary).toHaveBeenCalledTimes(2);
    press('ArrowDown'); // a pending line is not retried
    press('r');
    press('ArrowDown'); // the model's own line has nothing to retry
    press('r');
    expect(host.retrySummary).toHaveBeenCalledTimes(2);
  });

  // #198: a failed refresh of a model's now line that still shows.
  const KEPT = [
    worker('k1', { desk_index: 0, status: 'working', digest: { now: 'Reading the lift code', now_source: 'llm', now_at: NOW - 4 * 60_000, now_status: { state: 'failed', reason: 'timeout', attempts: 1 } } }),
    worker('k2', { desk_index: 1, status: 'working', digest: { now: 'Editing the door timer', now_source: 'llm', now_at: NOW - 60_000, now_status: { state: 'retrying', reason: 'timeout', attempts: 1, retry_at: NOW + 9 * 60_000 } } }),
    worker('k3', { desk_index: 2, status: 'working', digest: { now: 'Running the lift tests', now_source: 'llm', now_at: NOW - 60_000, now_status: { state: 'pending' } } }),
  ];

  it('a model’s line whose refresh failed keeps its sparkle and age, says so quietly after them, and offers Retry (#198)', () => {
    const { ov } = setup(KEPT);
    ov.open('top');
    const rows = [...document.querySelectorAll<HTMLElement>('.ov-row')];
    const line = (i: number) => rows[i]?.querySelector<HTMLElement>('.ov-now');
    const chip = (i: number) => line(i)?.querySelector<HTMLElement>('.ov-ai-state');
    expect(line(0)?.querySelector('.ov-now-text')?.textContent).toBe('Reading the lift code');
    expect(line(0)?.querySelector('.ov-ai')).not.toBeNull();
    expect(line(0)?.querySelector('.ov-age')?.textContent).toBe('4m ago');
    expect(chip(0)?.textContent).toBe('refresh failed');
    expect(chip(0)?.classList.contains('ov-ai-state--kept')).toBe(true);
    // In reading order: the label and its sparkle, the line, then its metadata: the age, the failed refresh, Retry (#232).
    expect([...(line(0)?.children ?? [])].map((e) => e.className)).toEqual(['', 'ov-text ov-now-text', 'ov-ai-meta']);
    expect([...(line(0)?.querySelector('.ov-ai-meta')?.children ?? [])].map((e) => e.className)).toEqual(['ov-age', 'ov-ai-state ov-ai-state--failed ov-ai-state--kept', 'ov-retry']);
    expect(line(0)?.classList.contains('ov-line--status')).toBe(true);
    expect(chip(0)?.getAttribute('aria-label')).toBe(chip(0)?.getAttribute('title'));
    expect(chip(0)?.getAttribute('aria-label')).toContain('Refreshing this AI summary from newer activity failed: the model did not answer in time. The summary shown is the previous one');
    expect(chip(0)?.getAttribute('aria-label')).not.toContain('fallback');
    expect(rows[0]?.getAttribute('aria-label')).toContain('Now: Reading the lift code (AI summary, 4m ago; refresh failed)');
    expect(chip(1)?.textContent).toMatch(/^refresh failed · retry \d\d:\d\d/);
    expect(chip(1)?.getAttribute('title')).toContain('It tries again at');
    expect(rows[1]?.getAttribute('aria-label')).toMatch(/\(AI summary, 1m ago; refresh failed · retry \d\d:\d\d.*\)/);
    expect(line(1)?.querySelector('.ov-retry')).not.toBeNull();
    // #119 (#198 showed nothing here): a refresh call out keeps the line, dimmed, and the busy mark takes the age's place.
    expect(line(2)?.querySelector('.ov-now-text')?.textContent).toBe('Running the lift tests');
    expect(line(2)?.classList.contains('ov-now--refreshing')).toBe(true);
    expect(line(2)?.querySelector('.ov-ai-meta')?.textContent).toBe('');
    expect(line(2)?.querySelector('.ov-ai-meta > .ov-busy')?.getAttribute('aria-label')).toMatch(/^Refreshing this AI summary from newer activity\./);
    expect(line(2)?.querySelector('.ov-age, .ov-flaprow')).toBeNull();
    expect(line(2)?.hasAttribute('aria-busy')).toBe(false);
    expect(chip(2)).toBeNull();
    expect(line(2)?.querySelector('.ov-retry')).toBeNull();
    expect(line(2)?.classList.contains('ov-line--status')).toBe(false);
    expect(rows[2]?.getAttribute('aria-label')).toContain('Now: Running the lift tests (AI summary, 1m ago; refreshing)');
  });

  it('the live activity is the since column’s plain words while working, the name and model alone in the Worker column (#232)', () => {
    const act = { kind: 'waiting' as const, detail: 'ssh -o StrictHostKeyChecking=no op@54.83', since: NOW - 5_000, source: 'rule' as const };
    const bg = { kind: 'waiting' as const, since: NOW, source: 'derived' as const, tasks: 1 };
    const { ov } = setup([
      worker('a', { desk_index: 0, status: 'working', activity: act, digest: { task: 'Recreate the IAM role', task_source: 'prompt', now: 'Verifying host credentials', now_source: 'llm', now_at: NOW } }),
      worker('b', { desk_index: 1, status: 'working', activity: { kind: 'testing', detail: 'pytest', since: NOW, source: 'rule' } }),
      worker('c', { desk_index: 2 }),
      worker('d', { desk_index: 3, status: 'working', activity: { kind: 'thinking', detail: '', since: NOW, source: 'rule' } }),
      worker('e', { desk_index: 4, status: 'working' }),
      worker('f', { desk_index: 5, status: 'blocked', activity: { kind: 'testing', detail: 'pytest', since: NOW, source: 'rule' } }),
      worker('g', { desk_index: 6, status: 'idle', activity: bg }),
      worker('h', { desk_index: 7, status: 'done' }),
    ]);
    ov.open('top');
    const row = (k: string) => document.querySelector<HTMLElement>(`.ov-row[data-key="${k}"]`) as HTMLElement;
    const doing = (k: string) => row(k).querySelector<HTMLElement>('.ov-row > .ov-since > .ov-doing');
    // No third line under the model: the Worker column is the mark, the name and the model.
    expect(document.querySelector('.ov-actline, .ov-act')).toBeNull();
    expect([...row('a').querySelector('.ov-who')!.children].map((e) => e.className)).toEqual(['ov-name', 'ov-meta']);
    // Working with an activity: the verb, the detail (the game's own clip, 32), how long it has worked; whole in the title.
    const clipped = 'Waiting · ssh -o StrictHostKeyChecking=no…';
    expect(doing('a')?.textContent).toBe(`${clipped} · 1m`);
    expect([...doing('a')!.children].map((e) => e.className)).toEqual(['ov-state ov-state--act', 'ov-sep', 'ov-time']);
    expect([...doing('a')!.querySelector('.ov-state')!.children].map((e) => e.textContent)).toEqual(['Waiting', ' · ssh -o StrictHostKeyChecking=no…']);
    expect(doing('a')?.querySelector<HTMLElement>('.ov-state')?.title).toBe(clipped);
    expect(row('a').getAttribute('aria-label')).toContain(` · ${clipped} · `);
    expect(doing('b')?.textContent).toBe('Testing · pytest · 1m');
    expect(doing('d')?.textContent).toBe('Thinking · 1m');
    expect(doing('d')?.querySelector('.ov-detail')).toBeNull();
    // Working with none: the status, as before. Every other state: its own word, never an activity it may still carry.
    expect(doing('e')?.textContent).toBe('working 1m');
    expect(doing('f')?.textContent).toBe('needs you 1m');
    expect(doing('g')?.textContent).toBe('waiting 1m');
    expect(doing('h')?.textContent).toBe('done 1m');
    expect(doing('c')?.textContent).toBe('idle 1m');
    for (const k of ['e', 'f', 'g', 'h', 'c']) expect(row(k).querySelector('.ov-verb, .ov-state--act'), k).toBeNull();
    // The hint follows the time in the column, never in another one.
    expect(row('a').querySelector('.ov-since > .ov-hint')?.textContent).toBe('Open transcript↵'); // the gap spaces the key
    expect(row('a').querySelector('.ov-row > .ov-hint')).toBeNull();
    // A row with only its live activity: no blank work column, and not "No turn yet" (it is in one).
    expect(row('b').querySelector('.ov-what')?.textContent).toBe('No summary yet');
    expect(row('b').querySelector('.ov-now')).toBeNull();
    expect(row('c').querySelector('.ov-what')?.textContent).toBe('No turn yet');
    // The header names what each column holds.
    expect([...document.querySelectorAll('.ov-cols > span')].map((e) => e.textContent)).toEqual(['', 'Worker', 'Working on', 'Doing · for']);
    // The CSS: only the detail is cut (it goes to a hidden second line when too little of it would show), the verb, the
    // separator and the time never, none of them in a box that cuts with an ellipsis; the hint goes under the time,
    // absolute (no row grows for it), and no longer hides anything; the sparkle and the words are the user's colour in
    // forced colours.
    const css = readFileSync(resolve(import.meta.dirname, 'overview.css'), 'utf8');
    const rule = (sel: string) => [...css.matchAll(new RegExp(`\\n${sel.replace(/[.+]/g, '\\$&')} \\{([^}]*)\\}`, 'g'))].map((m) => m[1]).join('');
    expect(rule('.ov-detail')).toMatch(/flex: 1 1 10ch;[^}]*min-width: 0;[^}]*text-overflow: ellipsis/);
    expect(rule('.ov-state--act')).toMatch(/flex-wrap: wrap;[^}]*overflow: hidden/);
    expect(rule('.ov-state--act')).not.toMatch(/text-overflow/);
    for (const sel of ['.ov-verb', '.ov-state']) expect(rule(sel), sel).toMatch(/flex: none/);
    expect(rule('.ov-time')).toMatch(/flex: none/);
    expect(rule('.ov-sep')).toMatch(/flex: none/);
    expect(rule('.ov-doing + .ov-hint')).toMatch(/position: absolute/);
    expect(css).not.toMatch(/ov-since-text|\.ov-actline|\.ov-act\b|\.ov-llm/);
    expect(css).toMatch(/@media \(forced-colors: active\) \{[^@]*:root \.ov-row\[data-display\] \.ov-ai,\s*:root \.ov-row\[data-display\] \.ov-since \{\s*color: CanvasText;/);
  });

  it('Retry and R on the row of a model’s line whose refresh failed ask the host to retry that worker (#198)', () => {
    const { ov, host } = setup(KEPT);
    ov.open('top');
    const press = (k: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    expect(ov.info().focused).toBe('k1');
    press('r');
    expect(host.retrySummary).toHaveBeenLastCalledWith('k1');
    press('ArrowDown');
    press('r');
    expect(host.retrySummary).toHaveBeenLastCalledWith('k2');
    press('ArrowDown'); // a refresh on its way: nothing to retry
    press('r');
    expect(host.retrySummary).toHaveBeenCalledTimes(2);
    document.querySelector<HTMLButtonElement>('.ov-row[data-key="k1"] .ov-retry')?.click();
    expect(host.retrySummary).toHaveBeenLastCalledWith('k1');
    expect(host.retrySummary).toHaveBeenCalledTimes(3);
    expect(host.goTo).not.toHaveBeenCalled();
  });

  it('Enter and Space on the focused Retry button are the button’s own: not the row’s open or fold; R and Enter on the row still work (#174)', () => {
    const { ov, host } = setup(STATUSED);
    ov.open('top');
    const btn = document.querySelector<HTMLButtonElement>('.ov-row[data-key="t1"] .ov-task .ov-retry');
    expect(btn).not.toBeNull();
    btn?.focus();
    // The capture handler leaves the event alone (not prevented, not stopped), so the browser clicks the button.
    for (const k of ['Enter', ' ']) {
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      btn?.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(host.goTo).not.toHaveBeenCalled();
    expect(ov.isOpen).toBe(true);
    btn?.click(); // what the browser does for either key
    expect(host.retrySummary).toHaveBeenCalledTimes(1);
    expect(host.goTo).not.toHaveBeenCalled();
    // Other keys from the button still drive the page (Esc closes it), and the row keeps its keys.
    const r = new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true });
    btn?.dispatchEvent(r);
    expect(r.defaultPrevented).toBe(true);
    expect(host.retrySummary).toHaveBeenCalledTimes(2);
    const row = document.querySelector<HTMLElement>('.ov-row[data-key="t1"]');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    row?.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(host.goTo).toHaveBeenCalledWith('t1');
  });

  it('the row’s Open transcript hint never takes a pointer: it is not a hit target, so Retry’s whole area is (#174)', () => {
    const { ov } = setup(STATUSED);
    ov.open('top');
    const css = readFileSync(resolve(import.meta.dirname, 'overview.css'), 'utf8');
    expect(css).toMatch(/\.ov-hint\s*\{[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/@media \(max-width: 760px\)\s*\{\s*\.ov-hint\s*\{\s*display:\s*none/);
    expect(document.querySelector('.ov-row .ov-hint')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('a line with a status wraps its chip and Retry under the text on a phone (#174)', () => {
    const { ov } = setup(STATUSED);
    ov.open('top');
    expect(document.querySelectorAll('.ov-ai-state').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.ov-line--status')).toHaveLength(document.querySelectorAll('.ov-ai-state').length);
    expect(document.querySelector('.ov-row[data-key="t3"] .ov-line--status')).toBeNull();
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

  it('an orchestrator’s meta line is its model and effort alone, no run words; the ORCH and over-cap chips stay (#229)', () => {
    const { ov } = setup([worker('o1', { role: 'orch', desk_index: 0, phase: 'waiting_user', round: 2, pass: 3, harness: 'claude', model: 'claude-opus-5-5', effort: 'high' })]);
    ov.open('top');
    const row = document.querySelector('.ov-row[data-key="o1"]') as HTMLElement;
    expect(row.querySelector('.ov-meta')?.textContent).toBe('Opus 5.5 high');
    expect(row.querySelector('.ov-who')?.textContent).not.toMatch(/waiting|round|pass/i);
    expect(row.querySelector('.ov-tag')?.textContent).toBe('ORCH');
    expect(row.querySelector('.ov-cap')?.textContent).toBe('Over cap');
  });

  it('the harness is a white mark before the name, named for a screen reader; the row’s label keeps it (#229)', () => {
    const { ov } = setup([
      worker('cl', { desk_index: 0, harness: 'claude', model: 'claude-haiku-5-5', effort: 'high' }),
      worker('cx', { desk_index: 1, harness: 'codex', model: 'gpt-6-sol', effort: 'medium' }),
      worker('gm', { desk_index: 2, harness: 'gemini', model: 'gemini-3', effort: 'high' }),
      worker('no', { desk_index: 3 }),
    ]);
    ov.open('top');
    const row = (k: string) => document.querySelector(`.ov-row[data-key="${k}"]`) as HTMLElement;
    const mark = (k: string) => row(k).querySelector('.ov-who > svg.ov-mark');
    for (const [k, name] of [['cl', 'Claude'], ['cx', 'Codex']] as const) {
      const m = mark(k)!;
      expect(m.getAttribute('role')).toBe('img');
      expect(m.getAttribute('aria-label')).toBe(name);
      expect(m.querySelector('title')?.textContent).toBe(name);
      expect(m.getAttribute('fill')).toBe('#fff');
      expect(m.querySelector('path')?.getAttribute('d')).toBeTruthy();
      expect(m.nextElementSibling?.classList.contains('ov-name')).toBe(true);
      expect(row(k).getAttribute('aria-label')).toContain(`${k} · ${name} · `);
    }
    // The mark's tooltip is no text of the row.
    expect(ov.info().rows.find((r) => r.key === 'cl')?.text).toMatch(/^clHaiku 5\.5 high/);
    expect(mark('cl')!.getAttribute('viewBox')).toBe('0 0 100 100');
    expect(mark('cx')!.getAttribute('viewBox')).toBe('1.68 1.75 16.65 16.5');
    expect(row('cl').querySelector('.ov-meta')?.textContent).toBe('Haiku 5.5 high');
    // No bridge labels here: the GPT slug is named by rule.
    expect(row('cx').querySelector('.ov-meta')?.textContent).toBe('GPT 6 Sol medium');
    // A harness without a mark: no icon, its name in the meta line and the label.
    expect(mark('gm')).toBeNull();
    expect(row('gm').querySelector('.ov-meta')?.textContent).toBe('gemini gemini-3 high');
    expect(row('gm').getAttribute('aria-label')).toContain('gemini');
    expect(mark('no')).toBeNull();
    expect(row('no').querySelector('.ov-meta')?.textContent).toBe('');
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

describe('opening the page again (#145)', () => {
  const rowEls = () => [...document.querySelectorAll<HTMLElement>('.ov-board > .ov-row')];
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
  /** Every `animate` call (jsdom has none): the folds a refresh starts. */
  function stubAnimate(): { calls: Element[]; restore: () => void } {
    const proto = HTMLElement.prototype as unknown as { animate?: unknown };
    const had = proto.animate;
    const calls: Element[] = [];
    proto.animate = function (this: Element) {
      calls.push(this);
      return { finished: new Promise<void>(() => undefined), cancel: () => undefined } as unknown as Animation;
    };
    return { calls, restore: () => void (proto.animate = had) };
  }

  it('the same floor again keeps its rows: the same elements, nothing built again', async () => {
    const { ov } = setup();
    ov.open('top');
    const before = rowEls();
    const what = before.map((el) => el.querySelector('.ov-what'));
    ov.closeNow();
    ov.open('top');
    const after = rowEls();
    expect(after).toHaveLength(before.length);
    after.forEach((el, i) => expect(el, el.dataset.key).toBe(before[i]));
    after.forEach((el, i) => expect(el.querySelector('.ov-what')).toBe(what[i]));
    expect(keys(ov)).toEqual(['o1', '  c1', '  r1', 'emp']);
    // The cascade plays again over the kept rows, and the first row is focused, as on a first open.
    expect(document.querySelector('.ov')?.classList.contains('ov--enter')).toBe(true);
    await frame();
    expect(ov.info().focused).toBe('o1');
    expect(document.activeElement?.getAttribute('data-key')).toBe('o1');
  });

  it('what changed while it was closed shows at once: a new row, a departed one, a status, with no flash or fold', () => {
    const anim = stubAnimate();
    try {
      const { ov, store } = setup();
      ov.open('top');
      const kept = document.querySelector('.ov-row[data-key="o1"]');
      ov.closeNow();
      store.applyEvent({ t: 'worker.status', seq: 2, id: 'emp', session: 'top', workspace_id: 'ws-emp', status: 'working', prev_status: 'blocked', status_since: NOW, title: 'Coding' }, NOW);
      store.applyEvent({ t: 'worker.removed', seq: 3, id: 'r1', session: 'top', workspace_id: 'ws-r1' }, NOW);
      store.applyEvent({ t: 'worker.upsert', seq: 4, worker: worker('n1', { desk_index: 4, status: 'working' }) }, NOW);
      ov.open('top');
      expect(keys(ov)).toEqual(['o1', '  c1', 'emp', 'n1']);
      expect(rowEls().map((e) => e.dataset.key)).toEqual(['o1', 'c1', 'emp', 'n1']);
      expect(document.querySelector('.ov-row[data-key="o1"]')).toBe(kept);
      const emp = document.querySelector<HTMLElement>('.ov-row[data-key="emp"]');
      expect(emp?.dataset.display).toBe('working');
      expect(document.querySelectorAll('.ov-row--flash, .ov-row--new, .ov-row--leaving, .ov-flip-in')).toHaveLength(0);
      expect(anim.calls.filter((el) => el.classList.contains('ov-row'))).toHaveLength(0);
      // A row the filter hides now goes at once too (Active only: c1 idle, never folding away during the open).
      ov.closeNow();
      key('f');
      ov.open('top');
      key('f');
      ov.closeNow();
      ov.open('top');
      expect(document.querySelectorAll('.ov-row--leaving')).toHaveLength(0);
      expect(rowEls().map((e) => e.dataset.key)).toEqual(keys(ov).map((k) => k.trim()));
    } finally {
      anim.restore();
    }
  });

  it('another view builds its own rows: the all-floors page, then the floor again', () => {
    const { ov } = setup();
    ov.open('top');
    const before = rowEls();
    key('a');
    expect(ov.info().view).toBe('city');
    expect(rowEls().some((el) => before.includes(el))).toBe(false);
    ov.closeNow();
    ov.open('top');
    expect(keys(ov)).toEqual(['o1', '  c1', '  r1', 'emp']);
    expect(rowEls().some((el) => before.includes(el))).toBe(false);
  });

  it('the first row takes the focus on the next frame, not in the key that opened the page; a key pressed first wins', async () => {
    const { ov } = setup();
    const opener = document.body.appendChild(document.createElement('button'));
    opener.focus();
    ov.open('top');
    expect(document.activeElement).toBe(opener);
    expect(ov.info().focused).toBe('o1');
    key('ArrowDown');
    expect(document.activeElement?.getAttribute('data-key')).toBe('c1');
    await frame();
    expect(document.activeElement?.getAttribute('data-key')).toBe('c1');
    ov.closeNow();
    expect(document.activeElement).toBe(opener);
    // Closed before its frame: nothing is focused on the closed page.
    ov.open('top');
    ov.closeNow();
    await frame();
    expect(document.activeElement).toBe(opener);
  });
});
