import { describe, expect, it } from 'vitest';
import type { Floor, HireOptions, Snapshot, Worker } from '../net/protocol';
import { WorldStore } from './store';
import { aiTitle, ageText, allNodes, buildOverview, countItems, sinceText, titleKey, visibleRows, type OverviewWorkerRow } from './overview';

const NOW = 1_790_000_000_000;

const floor = (session: string, over: Partial<Floor> = {}): Floor => ({ session, state: 'running', building: 'b1', index: 0, ...over });

const worker = (id: string, session: string, over: Partial<Worker> = {}): Worker => ({
  id,
  session,
  workspace_id: `ws-${id}`,
  label: `label-${id}`,
  name: id,
  status: 'idle',
  status_since: NOW - 60_000,
  ...over,
});

const orch = (id: string, session: string, desk: number, over: Partial<Worker> = {}) =>
  worker(id, session, { role: 'orch', run: `run-${id}`, desk_index: desk, issue: { repo: 'o/r', number: 118, title: 'Floor overview', url: 'https://example.test/118' }, work_item: { provider: 'gh', id: 'o/r#118' }, ...over });
const free = (id: string, session: string, desk: number, role: string, orchId: string | undefined, over: Partial<Worker> = {}) =>
  worker(id, session, { role, run: 'run', desk_index: desk, ...(orchId ? { orch_id: orchId } : {}), round: 1, issue: { repo: 'o/r', number: 118 }, work_item: { provider: 'gh', id: 'o/r#118' }, ...over });

function store(workers: Worker[], floors: Floor[] = [floor('top'), floor('bottom', { index: 1 }), floor('lot', { building: null, index: null })], hire?: HireOptions): WorldStore {
  const s = new WorldStore(NOW);
  const snap: Snapshot = {
    t: 'world.snapshot',
    seq: 1,
    world: { buildings: [{ id: 'b1', name: 'Work', sort: 0, floors: ['top', 'bottom'] }], unassigned: ['lot'], floors, workers, ...(hire ? { hire_options: hire } : {}) },
  };
  s.applySnapshot(snap, NOW);
  return s;
}

const keys = (s: WorldStore, session = 'top', collapsed: ReadonlySet<string> = new Set()) => {
  const t = buildOverview(s, session);
  return visibleRows(t, collapsed).map((r) => `${'  '.repeat(r.depth)}${r.row.key}`);
};

describe('buildOverview: the tree', () => {
  it('is flat without orchestrators: employees by desk', () => {
    const s = store([worker('c', 'top', { desk_index: 2 }), worker('a', 'top', { desk_index: 0 }), worker('b', 'top', { desk_index: 1 }), worker('x', 'bottom')]);
    expect(keys(s)).toEqual(['a', 'b', 'c']);
  });

  it('nests freelancers under their orchestrator: orchestrators by desk, then round, role (code, review, ux, ground), desk; employees last', () => {
    const s = store([
      worker('emp', 'top', { desk_index: 0 }),
      orch('o2', 'top', 9),
      orch('o1', 'top', 1),
      free('rev1', 'top', 3, 'review', 'o1'),
      free('code2', 'top', 5, 'code', 'o1', { round: 2 }),
      free('ground1', 'top', 6, 'ground', 'o1'),
      free('codeA', 'top', 7, 'code', 'o1'),
      free('codeB', 'top', 4, 'code', 'o1'),
      free('ux1', 'top', 8, 'ux', 'o2'),
    ]);
    expect(keys(s)).toEqual(['o1', '  codeB', '  codeA', '  rev1', '  ground1', '  code2', 'o2', '  ux1', 'emp']);
  });

  it('a freelancer whose orchestrator is on another floor sits under a ghost row; one elsewhere whose orchestrator is here stays nested with its floor', () => {
    const s = store([
      orch('far', 'bottom', 0, { name: 'Bramble' }),
      free('lost', 'top', 2, 'code', 'far'),
      orch('home', 'top', 1),
      free('away', 'bottom', 3, 'review', 'home'),
      free('here', 'top', 4, 'code', 'home'),
    ]);
    expect(keys(s)).toEqual(['home', '  here', '  away', 'ghost:far', '  lost']);
    const t = buildOverview(s, 'top');
    const ghost = t.nodes.find((n) => n.row.kind === 'ghost')?.row;
    expect(ghost).toMatchObject({ kind: 'ghost', id: 'far', name: 'Bramble', floor: 'Floor 1' });
    const away = t.nodes[0]?.children.map((c) => c.row).find((c) => c.kind === 'worker' && c.id === 'away');
    expect(away).toMatchObject({ floor: 'Floor 1' });
    expect(t.nodes[0]?.children.map((c) => c.row).find((c) => c.kind === 'worker' && c.id === 'here')).toMatchObject({ floor: null });
  });

  it('puts freelancers with no orchestrator (or one that is gone) in an Unlinked group, before the employees', () => {
    const s = store([worker('emp', 'top', { desk_index: 0 }), free('solo', 'top', 2, 'code', undefined), free('orphan', 'top', 1, 'review', 'gone')]);
    expect(keys(s)).toEqual(['unlinked', '  solo', '  orphan', 'emp']);
  });

  it('hides a collapsed group’s children', () => {
    const s = store([orch('o1', 'top', 0), free('c1', 'top', 1, 'code', 'o1'), worker('emp', 'top', { desk_index: 5 })]);
    expect(keys(s, 'top', new Set(['o1']))).toEqual(['o1', 'emp']);
    const rows = visibleRows(buildOverview(s, 'top'), new Set(['o1']));
    expect(rows[0]).toMatchObject({ expandable: true, expanded: false, depth: 0 });
    expect(rows[1]).toMatchObject({ expandable: false, depth: 0 });
  });

  it('keeps the order when only statuses change', () => {
    const ws = [orch('o1', 'top', 4), free('c1', 'top', 2, 'code', 'o1'), free('r1', 'top', 1, 'review', 'o1'), worker('emp', 'top', { desk_index: 0 })];
    const before = keys(store(ws));
    const busy = ws.map((w, i) => ({ ...w, status: ['working', 'blocked', 'done', 'idle'][i] as string, status_since: NOW - i * 1000 }));
    expect(keys(store(busy))).toEqual(before);
  });

  it('an empty floor has no rows', () => {
    const t = buildOverview(store([worker('x', 'bottom')]), 'top');
    expect(t.nodes).toEqual([]);
    expect(t.total).toBe(0);
  });
});

describe('buildOverview: a row', () => {
  const row = (s: WorldStore, id: string): OverviewWorkerRow => {
    const t = buildOverview(s, 'top');
    const all = allNodes(t).map((n) => n.row);
    const r = all.find((x) => x.kind === 'worker' && x.id === id);
    if (!r || r.kind !== 'worker') throw new Error(`no row ${id}`);
    return r;
  };

  it('takes its light from the store’s display (the top bar’s), with name, harness, model and since', () => {
    const s = store([worker('a', 'top', { status: 'working', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', status_since: NOW - 4 * 60_000 })]);
    const r = row(s, 'a');
    expect(r).toMatchObject({ display: s.workerView('a')?.display, name: 'a', harness: 'claude', model: 'Opus 5.5 high', role: null, tag: null });
    expect(sinceText(r.display, r.since, NOW)).toBe('working 4m');
  });

  it('the model is its readable name and effort, no harness word (#229): a Codex model by the bridge’s label, else a GPT slug by rule, else its id', () => {
    const hire: HireOptions = {
      claude: { models: ['claude-haiku-5-5'], efforts: ['high'] },
      codex: { models: ['gpt-6-sol', 'gpt-6-luna', 'o9-preview'], efforts: ['medium'], model_labels: { 'gpt-6-sol': 'GPT-6-Sol' } },
    };
    const s = store(
      [
        worker('h', 'top', { desk_index: 0, harness: 'claude', model: 'claude-haiku-5-5', effort: 'high' }),
        worker('c', 'top', { desk_index: 1, harness: 'codex', model: 'gpt-6-sol', effort: 'medium' }),
        worker('l', 'top', { desk_index: 2, harness: 'codex', model: 'gpt-6-luna', effort: 'medium' }),
        worker('o', 'top', { desk_index: 3, harness: 'codex', model: 'o9-preview', effort: 'medium' }),
      ],
      undefined,
      hire,
    );
    expect(row(s, 'h').model).toBe('Haiku 5.5 high');
    expect(row(s, 'c')).toMatchObject({ harness: 'codex', model: 'GPT 6 Sol medium' });
    expect(row(s, 'l').model).toBe('GPT 6 Luna medium');
    expect(row(s, 'o').model).toBe('o9-preview medium');
  });

  it('an orchestrator: role, round, over-cap and its ticket with the issue’s title; no run words (#229)', () => {
    const s = store([orch('o', 'top', 0, { phase: 'waiting_user', pass: 3, round: 2, harness: 'claude', model: 'claude-opus-5-5', effort: 'high' })]);
    const r = row(s, 'o');
    expect(r).toMatchObject({ role: 'orch', tag: 'ORCH', model: 'Opus 5.5 high', orch: { round: 2, overCap: true } });
    expect(r.orch).toEqual({ round: 2, overCap: true });
    expect(row(store([orch('o', 'top', 0)]), 'o').orch).toEqual({ round: null, overCap: false });
    expect(r.ticket).toEqual({ key: '#118', title: 'Floor overview', item: { floor: 'top', id: 'o/r#118' }, url: 'https://example.test/118' });
    expect(r.display).toBe('needs_you');
  });

  it('a freelancer shows its ticket only when it differs from its orchestrator’s', () => {
    const s = store([
      orch('o', 'top', 0),
      free('same', 'top', 1, 'code', 'o'),
      free('other', 'top', 2, 'review', 'o', { issue: { repo: 'o/r', number: 7, title: 'Another' }, work_item: { provider: 'gh', id: 'o/r#7' } }),
    ]);
    expect(row(s, 'same').ticket).toBeNull();
    expect(row(s, 'other').ticket).toMatchObject({ key: '#7', title: 'Another' });
    expect(row(s, 'same').tag).toBe('CODE r1');
  });

  it('carries the status of a line the model has not written; of a model’s now line a failed refresh (#174, #198) or one on its way (#119)', () => {
    const src = store([
      worker('a', 'top', { desk_index: 0, digest: { task: 'Investigate. Missing diffs.', task_source: 'prompt', now_source: 'title', task_status: { state: 'retrying', reason: 'truncated', attempts: 2, retry_at: NOW + 5 }, now_status: { state: 'failed', reason: 'timeout' } }, title: 'Reading' }),
      worker('b', 'top', { desk_index: 1, digest: { task: 'x', task_source: 'llm', now: 'y', now_source: 'llm', task_status: { state: 'failed' }, now_status: { state: 'pending' } } }),
      worker('c', 'top', { desk_index: 2, digest: { task: 'z', task_source: 'prompt', now_source: 'title', task_status: { state: 'bogus' } as never }, title: 't' }),
      worker('d', 'top', { desk_index: 3, digest: { now: 'Reading the lift code', now_source: 'llm', now_at: NOW - 60_000, now_status: { state: 'failed', reason: 'timeout', attempts: 1 } } }),
      worker('e', 'top', { desk_index: 4, digest: { now: 'Reading the lift code', now_source: 'llm', now_at: NOW - 60_000, now_status: { state: 'retrying', reason: 'timeout', attempts: 1, retry_at: NOW + 5 } } }),
    ]);
    const rows = buildOverview(src, 'top').nodes.map((n) => n.row as OverviewWorkerRow);
    expect(rows[0]?.task?.status).toEqual({ state: 'retrying', reason: 'truncated', attempts: 2, retry_at: NOW + 5 });
    expect(rows[0]?.now?.status).toEqual({ state: 'failed', reason: 'timeout' });
    expect(rows[1]?.task?.status).toBeUndefined();
    // #119 (reverses #198's rule): pending beside a model's now line is its refresh call, out now. A model's task line has none.
    expect(rows[1]?.now?.status).toEqual({ state: 'pending' });
    expect(rows[2]?.task?.status).toBeUndefined();
    // #198: the model's previous now line still shows, and its refresh failed: both, with the line's time.
    expect(rows[3]?.now).toEqual({ text: 'Reading the lift code', source: 'llm', llm: true, at: NOW - 60_000, status: { state: 'failed', reason: 'timeout', attempts: 1 } });
    expect(rows[4]?.now?.status).toEqual({ state: 'retrying', reason: 'timeout', attempts: 1, retry_at: NOW + 5 });
  });

  it('#119: a now line awaited with no fallback text to show keeps its status (an empty line), a task line with no text stays out', () => {
    const s = store([
      worker('title', 'top', { desk_index: 0, title: '  ', digest: { now_source: 'title', now_status: { state: 'pending' } } }),
      worker('recap', 'top', { desk_index: 1, digest: { now_source: 'recap', now_status: { state: 'pending', reason: 'daily_cap' } } }),
      worker('none', 'top', { desk_index: 2, title: '', digest: { now_source: 'title' } }),
      worker('failed', 'top', { desk_index: 3, title: '', digest: { now_source: 'title', now_status: { state: 'failed', reason: 'timeout' } } }),
      worker('task', 'top', { desk_index: 4, digest: { task: ' ', task_source: 'prompt', task_status: { state: 'pending' } } }),
    ]);
    expect(row(s, 'title').now).toEqual({ text: '', source: 'title', llm: false, status: { state: 'pending' } });
    expect(row(s, 'recap').now).toEqual({ text: '', source: 'recap', llm: false, status: { state: 'pending', reason: 'daily_cap' } });
    expect(row(s, 'none').now).toBeNull();
    expect(row(s, 'failed').now).toBeNull();
    expect(row(s, 'task').task).toBeNull();
  });

  it('#119: titleKey leaves out what changes on every tick of a terminal title (Codex spinner frames, the action-required blink)', () => {
    // Codex: thread-title generation pending (the spinner after the name), a /title order with the spinner later, the mic.
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    expect(new Set(frames.map((f) => titleKey(`Fix the lift doors ${f}`)))).toEqual(new Set(['Fix the lift doors']));
    expect(new Set(frames.map((f) => titleKey(`herdr-3d ${f} Working`)))).toEqual(new Set(['herdr-3d Working']));
    expect(titleKey('● ⠋ Fix the lift doors')).toBe(titleKey('● ⠙ Fix the lift doors'));
    expect(titleKey('[ ! ] Action Required')).toBe(titleKey('[ . ] Action Required'));
    // A real change is still one; a title with nothing of the kind is itself, its spaces collapsed.
    expect(titleKey('Fix the lift doors ⠋')).not.toBe(titleKey('Fix the stairs ⠋'));
    expect(titleKey('  Reading   hub.go ')).toBe('Reading hub.go');
  });

  it('a one-off worker’s task, and every worker’s now line from the digest: the recap, else its title; the activity apart', () => {
    const s = store([
      worker('recap', 'top', { desk_index: 0, digest: { task: 'Fix the flaky e2e', task_source: 'ai_title', now: 'Waiting for review', now_source: 'recap', now_at: NOW } }),
      worker('title', 'top', { desk_index: 1, status: 'working', title: 'Reading hub.go', activity: { kind: 'testing', detail: 'pytest', since: NOW, source: 'rule' }, digest: { task: 'Port it', task_source: 'prompt', now_source: 'title' } }),
      worker('fresh', 'top', { desk_index: 2, title: 'Claude Code' }),
      worker('llm', 'top', { desk_index: 3, digest: { task: 'x', task_source: 'llm', now: 'y', now_source: 'llm' } }),
      worker('think', 'top', { desk_index: 4, status: 'working', activity: { kind: 'thinking', since: NOW, source: 'rule' } }),
    ]);
    expect(row(s, 'recap')).toMatchObject({ task: { text: 'Fix the flaky e2e', source: 'ai_title', llm: false }, now: { text: 'Waiting for review', source: 'recap', llm: false }, activity: null, act: null });
    // #232: the verb and the detail apart (the since column gives the detail way first), and joined for the row's label.
    expect(row(s, 'title')).toMatchObject({ task: { text: 'Port it', source: 'prompt' }, now: { text: 'Reading hub.go', source: 'title' }, activity: 'Testing · pytest', act: { verb: 'Testing', detail: 'pytest' } });
    expect(row(s, 'think')).toMatchObject({ activity: 'Thinking', act: { verb: 'Thinking', detail: '' } });
    // No turn read yet (no digest): no task or now line.
    expect(row(s, 'fresh')).toMatchObject({ task: null, now: null });
    expect(row(s, 'llm')).toMatchObject({ task: { llm: true }, now: { llm: true } });
  });

  it('#198: a model’s now line carries when it was written (now_at); its sparkle says how old it is', () => {
    const s = store([
      worker('llm', 'top', { desk_index: 0, digest: { task: 'x', task_source: 'llm', now: 'Rerunning the login test', now_source: 'llm', now_at: NOW - 2 * 60_000 } }),
      worker('recap', 'top', { desk_index: 1, digest: { now: 'Waiting for review', now_source: 'recap', now_at: NOW } }),
      worker('old', 'top', { desk_index: 2, digest: { now: 'y', now_source: 'llm' } }),
    ]);
    const now = row(s, 'llm').now;
    if (!now) throw new Error('no now line');
    expect(now).toEqual({ text: 'Rerunning the login test', source: 'llm', llm: true, at: NOW - 2 * 60_000 });
    expect(row(s, 'recap').now?.at).toBeUndefined();
    expect(row(s, 'llm').task?.at).toBeUndefined();
    expect(ageText(now.at as number, NOW)).toBe('2m ago');
    expect(aiTitle(now, NOW)).toBe(
      'AI-generated summary of this worker’s recent activity (its last 5 steps); generated 2m ago. The time is when the summary was written, not when the activity happened.',
    );
    // The same line, later: only its age moves.
    expect(aiTitle(now, NOW + 60 * 60_000)).toContain('; generated 1h 02m ago.');
    // A bridge that sends no time: no age made up. A task line has none: what it sums up instead.
    const plain = row(s, 'old').now;
    if (!plain) throw new Error('no now line');
    expect(aiTitle(plain, NOW)).toBe('AI-generated summary of this worker’s recent activity (its last 5 steps).');
    expect(aiTitle(row(s, 'llm').task as NonNullable<OverviewWorkerRow['task']>, NOW, 'task')).toBe('AI-generated summary of what this worker was asked to do.');
  });

  it('crew members have no task line; a finished freelancer’s now is its report’s summary', () => {
    const s = store([
      orch('o', 'top', 0, { digest: { task: 'orch task', task_source: 'prompt', now: 'Waiting', now_source: 'recap' } }),
      free('done', 'top', 1, 'code', 'o', { status: 'done', report: { state: 'ready', summary: 'Added the tracker and its tests.' }, digest: { now_source: 'title' }, title: 'Done' }),
    ]);
    expect(row(s, 'o').task).toBeNull();
    expect(row(s, 'o').now).toMatchObject({ text: 'Waiting', source: 'recap' });
    expect(row(s, 'done').now).toEqual({ text: 'Added the tracker and its tests.', source: 'report', llm: false });
  });

  it('an asleep floor’s workers are asleep', () => {
    const s = store([worker('a', 'top', { status: 'working' })], [floor('top', { state: 'asleep' })]);
    expect(row(s, 'a').display).toBe('asleep');
  });
});

describe('counts and times', () => {
  it('countItems are the top bar’s numbers', () => {
    const s = store([
      worker('w', 'top', { status: 'working' }),
      worker('b', 'top', { status: 'blocked' }),
      worker('d', 'top', { status: 'done' }),
      worker('i', 'top', { status: 'idle' }),
      worker('t', 'top', { status: 'idle', activity: { kind: 'waiting', since: NOW, source: 'derived', tasks: 1 } }),
    ]);
    const v = s.floorView('top');
    if (!v) throw new Error('no floor');
    expect(countItems(v.counts, false)).toEqual([
      { kind: 'working', n: 1, label: 'working' },
      { kind: 'needs_you', n: 1, label: 'needs you' },
      { kind: 'waiting', n: 1, label: 'waiting' },
      { kind: 'idle', n: 2, label: 'idle' },
    ]);
    expect(countItems({ ...v.counts, waiting: 0, needsYou: 2 }, false).map((c) => c.label)).toEqual(['working', 'need you', 'idle']);
    expect(countItems(v.counts, true)).toEqual([{ kind: 'asleep', n: 5, label: 'asleep' }]);
  });

  it('ageText', () => {
    expect(ageText(NOW - 20_000, NOW)).toBe('just now');
    expect(ageText(NOW + 5000, NOW)).toBe('just now');
    expect(ageText(NOW - 4 * 60_000, NOW)).toBe('4m ago');
    expect(ageText(NOW - 125 * 60_000, NOW)).toBe('2h 05m ago');
    expect(ageText(NOW - 3 * 86_400_000, NOW)).toBe('3d ago');
  });

  it('sinceText', () => {
    expect(sinceText('working', NOW - 20_000, NOW)).toBe('working <1m');
    expect(sinceText('needs_you', NOW - 4 * 60_000, NOW)).toBe('needs you 4m');
    expect(sinceText('idle', NOW - 125 * 60_000, NOW)).toBe('idle 2h 05m');
    expect(sinceText('done', NOW - 3 * 86_400_000, NOW)).toBe('done 3d');
    expect(sinceText('idle', NOW + 5000, NOW)).toBe('idle <1m');
  });
});
