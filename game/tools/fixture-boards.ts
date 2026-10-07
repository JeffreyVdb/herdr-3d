// M7: the issues and pull request boards, simulated for the fixture server (`sim=1`, see tools/fixture-sim.ts). Rules,
// like herdr-world's (docs/protocol.md "Boards: issues and pull requests"):
// - `board.watch {session}` answers `{enabled}` and then, from the cache, `board.issues` and `board.prs` with
//   `initial: true`. A floor with no effective repo (`settings.repo ?? suggested.repo`) is `enabled: false`
//   ("no repo linked"). One watch per connection; `board.unwatch` ends it. Board messages carry no `seq`.
// - The repo decides the board: `JeffreyVdb/herdr-3d` and `JeffreyVdb/lab` have a project (columns from a live field),
//   `JeffreyVdb/bench` has 100 issues and 20 pull requests (the perf check), every other repo has no project (Open /
//   Closed, no `set_status`). Item ids are `<repo>#<n>` like the GitHub provider's; nothing here is parsed by the game.
// - Every write queues a poll of that floor: `board.issues` then `board.prs`, `initial: false`. `sim.boards` (the
//   simulator's own command) merges a PR, makes the next polls fail (`stale`), sets the rate limit or the paging flag.
// - `pr.merge` refuses like the bridge: `confirmation_required`, `not_mergeable` (conflicts, always),
//   `checks_not_green` / `not_mergeable` unless `override` and `confirm_override`. A merge is announced once, on the
//   next poll, and moves the issues it closes to Done.
// - #52: a project's cards carry `position` (their rank in the project's one order, seeded to match the old sort) and
//   the board the `order` capability. `issue.set_status` takes `after` like the bridge: absent the status only, null the
//   top of the column (right before its first card; an empty column: the top of the project), a card id of the target
//   column right after it (unknown, another column's or the card itself: `bad_request`; no project: `unsupported`).
//   `sim.boards {fail_write: "message"}` makes every `issue.set_status` fail with `provider_failed` (null clears it);
//   `{no_refresh: true}` makes writes queue no poll (a refresh that is late), `false` back to normal.
//   `{partial_write: "message"}` makes an `issue.set_status` with `after` change the status, not the place, and fail
//   with `provider_failed` ("its status changed, but its place in the column did not: …"); its poll is queued.
// - `simfail=no_m7` plays a bridge before M7: every board command is `unknown_command`.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { BoardCaps, BoardColumn, BoardComment, BoardIssues, BoardLabel, BoardPrs, IssueCard, PullRequest, Worker } from '../src/net/protocol.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export interface BoardsDeps {
  floors: Map<string, { session: string; settings?: { repo?: string }; suggested?: { repo?: string }; state?: string }>;
  workers: Worker[];
  now(): number;
  later(fn: () => void, ms: number): unknown;
  error(code: string, message: string): Error;
  /** The h3d/… branch the bridge recorded for a worker. */
  hireBranch(id: string): string | undefined;
  /** Whether the worker's checkout has uncommitted changes. */
  dirty(w: Worker): boolean;
}

const COMMANDS = new Set([
  'board.watch',
  'board.unwatch',
  'board.refresh',
  'issue.get',
  'issue.comment',
  'issue.close',
  'issue.set_status',
  'pr.get',
  'pr.comment',
  'pr.merge',
  'worker.open_pr.prepare',
  'worker.open_pr',
  'sim.boards',
]);

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const PROVIDER = 'github';
const NAME = 'GitHub';
const HOUR = 3_600_000;

/** A markdown body that must render inert: script, handlers, `javascript:` links, svg, iframes, a form, a tracking image. */
export const XSS_BODY = [
  '## Markdown probe',
  '',
  'Normal **bold**, _italic_, `code` and a [safe link](https://example.com/docs).',
  '',
  '<img src=x onerror="window.__xss=1">',
  '',
  '[click me](javascript:window.__xss=2)',
  '',
  '<script>window.__xss=3</script>',
  '',
  '<a href="javascript:window.__xss=4" onclick="window.__xss=5">a raw link</a>',
  '',
  '<svg onload="window.__xss=6"><circle r="4"/></svg>',
  '',
  '<iframe src="javascript:window.__xss=7"></iframe>',
  '',
  '<form action="https://evil.example/"><input name="x"><button>send</button></form>',
  '',
  '![tracking pixel](https://evil.example/pixel.png)',
  '',
  '<div style="position:fixed;inset:0" onmouseover="window.__xss=8">cover</div>',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '```ts',
  'const answer = 42;',
  '```',
].join('\n');

const PLAIN_BODY = [
  '## Goal',
  '',
  'Show this on the board, with **everything** you need to pick it up:',
  '',
  '- the columns come from the provider',
  '- a note is a card',
  '- `E` opens the overlay',
  '',
  'See [the protocol](https://github.com/JeffreyVdb/herdr-3d/blob/main/docs/protocol.md) for the wire.',
  '',
  '### Acceptance',
  '',
  '1. It works on a repo with a project.',
  '2. It works on a repo without one.',
].join('\n');

interface SimCard {
  card: IssueCard;
  body: string;
  author: string;
  created_at: number;
  comments: BoardComment[];
}

interface SimPr {
  pr: PullRequest;
  body: string;
  author: string;
  created_at: number;
  files: Array<{ path: string; additions: number; deletions: number; change: string }>;
  checks: Array<{ name: string; state: string; url?: string }>;
  comments: BoardComment[];
}

interface Repo {
  repo: string;
  project: boolean;
  columns: BoardColumn[];
  cards: SimCard[];
  prs: SimPr[];
  /** Merged since the last poll: announced by the next `board.prs`. */
  merged: Array<{ id: string; key: string; title: string; merged_at: number; closes: string[] }>;
  /** #52: the project's order of the cards (ids), across all columns; empty without a project. */
  order: string[];
  next: number;
  fetchedAt: number;
}

const L = (name: string, color: string): BoardLabel => ({ name, color });
const LABELS = {
  bridge: L('bridge', '#1d76db'),
  game: L('game', '#0e8a16'),
  design: L('design', '#d876e3'),
  bug: L('bug', '#d73a4a'),
  docs: L('docs', '#0075ca'),
  p1: L('P1', '#b60205'),
  p2: L('priority: medium', '#fbca04'),
  low: L('low', '#c5def5'),
  urgent: L('urgent', '#e11d21'),
};

const PROJECT_COLUMNS: BoardColumn[] = [
  { id: '49294ed0', name: 'Todo' },
  { id: 'ae6334b4', name: 'Doing' },
  { id: '64e1b0ac', name: 'QA' },
  { id: 'ccf5765b', name: 'Done', done: true },
];
const PLAIN_COLUMNS: BoardColumn[] = [
  { id: 'open', name: 'Open' },
  { id: 'closed', name: 'Closed', done: true },
];
const COL = { todo: '49294ed0', doing: 'ae6334b4', qa: '64e1b0ac', done: 'ccf5765b' } as const;

const person = (name: string) => ({ name, avatar_url: `https://avatars.example/${name}.png` });

function comment(id: string, author: string, body: string, at: number): BoardComment {
  return { id, author: person(author), body, created_at: at };
}

function mkCard(repo: string, n: number, title: string, column: string, o: Partial<IssueCard> & { body?: string; age?: number } = {}): SimCard {
  const id = `${repo}#${n}`;
  const updated = (o.updated_at as number | undefined) ?? Date.now() - (o.age ?? n) * HOUR;
  const { body, age: _age, ...rest } = o;
  const card: IssueCard = {
    id,
    key: `#${n}`,
    title,
    state: 'open',
    column,
    url: `https://github.com/${repo}/issues/${n}`,
    labels: [],
    assignees: [],
    author: 'JeffreyVdb',
    updated_at: updated,
    closed_at: null,
    ...rest,
  };
  return { card, body: body ?? PLAIN_BODY, author: 'JeffreyVdb', created_at: updated - 48 * HOUR, comments: [comment(`IC_${n}a`, 'JeffreyVdb', 'Started on the **bridge** side first.', updated - 20 * HOUR)] };
}

function mkPr(repo: string, n: number, title: string, head: string, o: Partial<PullRequest> & { closes?: string[] } = {}): SimPr {
  const id = `${repo}#${n}`;
  const pr: PullRequest = {
    id,
    key: `#${n}`,
    title,
    state: 'open',
    draft: false,
    url: `https://github.com/${repo}/pull/${n}`,
    head_branch: head,
    base_branch: 'main',
    author: 'JeffreyVdb',
    checks: 'success',
    review: 'approved',
    mergeable: 'mergeable',
    closes: [],
    additions: 120 + n,
    deletions: 14,
    changed_files: 3,
    updated_at: Date.now() - n * HOUR,
    ...o,
  };
  return {
    pr,
    body: `## What\n\n${title}\n\nCloses ${pr.closes.join(', ') || 'nothing'}.`,
    author: 'JeffreyVdb',
    created_at: Date.now() - (n + 5) * HOUR,
    files: [
      { path: 'internal/server/boards.go', additions: 90 + n, deletions: 4, change: 'modified' },
      { path: 'game/src/app.ts', additions: 25, deletions: 10, change: 'modified' },
      { path: 'docs/protocol.md', additions: 5, deletions: 0, change: 'added' },
    ],
    checks:
      pr.checks === 'none'
        ? []
        : [
            { name: 'go', state: pr.checks === 'pending' ? 'pending' : pr.checks, url: `https://github.com/${repo}/actions/runs/${n}` },
            { name: 'game', state: pr.checks === 'failure' ? 'success' : pr.checks, url: `https://github.com/${repo}/actions/runs/${n + 1}` },
            { name: 'lint', state: 'skipped' },
          ],
    comments: [comment(`PC_${n}a`, 'reviewer', 'Looks good, one nit: rename `x`.', Date.now() - n * HOUR)],
  };
}

/** The lab repo: two runs' issues (the fixture's orchestrators hold #3 and #4) and their PRs. */
function toyRepo(now: number): Repo {
  const r = 'JeffreyVdb/lab';
  const cards = [
    mkCard(r, 1, 'Set up the lab project', COL.done, { state: 'closed', closed_at: now - 26 * HOUR, updated_at: now - 26 * HOUR, labels: [LABELS.docs] }),
    mkCard(r, 2, 'Add a health endpoint', COL.done, { state: 'closed', closed_at: now - 5 * HOUR, updated_at: now - 5 * HOUR, labels: [LABELS.bridge] }),
    mkCard(r, 3, 'Overcap: review passes never end', COL.doing, { priority: 'urgent', labels: [LABELS.urgent, LABELS.bug], updated_at: now - 30 * 60_000 }),
    mkCard(r, 4, 'Lobby: the receptionist waves at the door', COL.doing, { priority: 'high', labels: [LABELS.p1, LABELS.game], updated_at: now - 2 * HOUR }),
    mkCard(r, 5, 'Coffee machine sound', COL.todo, { labels: [LABELS.design], updated_at: now - 9 * HOUR }),
    mkCard(r, 6, 'Rename the elevator floor labels', COL.todo, { priority: 'low', labels: [LABELS.low, LABELS.game], updated_at: now - 12 * HOUR }),
    mkCard(r, 7, 'Render markdown safely (XSS probe)', COL.todo, { priority: 'medium', labels: [LABELS.p2, LABELS.docs], body: XSS_BODY, updated_at: now - 3 * HOUR }),
    mkCard(r, 8, 'Docs: describe the boards', COL.qa, { labels: [LABELS.docs], updated_at: now - 4 * HOUR }),
  ];
  const c7 = cards[6];
  if (c7) c7.comments.push(comment('IC_7x', 'mallory', XSS_BODY, now - HOUR));
  const prs = [
    mkPr(r, 9, 'Overcap: stop after three passes', 'h3d/overcap-fix', { closes: [`${r}#3`], checks: 'failure', review: 'changes_requested' }),
    mkPr(r, 10, 'Lobby: wave at the door', 'h3d/lobby', { closes: [`${r}#4`], checks: 'pending', review: 'none', mergeable: 'unknown' }),
  ];
  return { repo: r, project: true, columns: PROJECT_COLUMNS, cards, prs, merged: [], order: [], next: 11, fetchedAt: now };
}

function herdrRepo(now: number): Repo {
  const r = 'JeffreyVdb/herdr-3d';
  const t = [
    ['M8: Lounge, coffee machine and the wandering worker', COL.todo, 'medium', [LABELS.game, LABELS.p2]],
    ['M9: Send-home handoff', COL.todo, undefined, [LABELS.bridge]],
    ['M10: Plan limits in the hire dialog', COL.todo, 'low', [LABELS.game, LABELS.low]],
    ['M11: Drop Zone inbox', COL.todo, undefined, [LABELS.design]],
    ['M12: Services board', COL.todo, undefined, [LABELS.bridge]],
    ['M13: Whiteboard and screen share', COL.todo, undefined, [LABELS.game]],
    ['M14: Stop services on send-home', COL.todo, undefined, [LABELS.bridge]],
    ['M15: Radio', COL.todo, undefined, [LABELS.game]],
    ['M7: Issues Kanban + Pull Requests board (GitHub)', COL.doing, 'high', [LABELS.p1, LABELS.bridge, LABELS.game]],
    ['Perf: 120 Hz on the Mac at 96 desks', COL.doing, undefined, [LABELS.game]],
    ['Flaky reconnect test on CI', COL.qa, 'medium', [LABELS.bug, LABELS.p2]],
    ['Docs: architecture refresh', COL.qa, undefined, [LABELS.docs]],
    ['Bridge: audit log rotation', COL.todo, 'low', [LABELS.bridge, LABELS.low]],
  ] as const;
  const nums = [12, 13, 14, 15, 16, 17, 18, 19, 9, 20, 21, 22, 23];
  const cards = t.map(([title, col, prio, labels], i) => mkCard(r, nums[i] as number, title, col, { labels: [...labels], ...(prio ? { priority: prio } : {}), updated_at: now - (i * 2 + 1) * HOUR }));
  for (const [n, title, ago] of [[7, 'M6: Team presets and starting a run', 30], [6, 'M5: Laptops: screens, input, changes', 55], [5, 'M4: Hire and send home', 80]] as const) {
    cards.push(mkCard(r, n, title, COL.done, { state: 'closed', closed_at: now - ago * HOUR, updated_at: now - ago * HOUR, labels: [LABELS.game] }));
  }
  const prs = [
    mkPr(r, 32, 'feat: M7 boards', 'feat/9-m7', { closes: [`${r}#9`], checks: 'success', review: 'approved' }),
    mkPr(r, 33, 'fix: reconnect flake', 'fix/reconnect-flake', { checks: 'failure', review: 'changes_requested' }),
    mkPr(r, 34, 'docs: protocol boards section', 'docs/protocol-boards', { checks: 'success', review: 'review_required' }),
    mkPr(r, 35, 'feat: lounge', 'feat/lounge', { checks: 'pending', review: 'none', mergeable: 'conflicting', draft: true }),
  ];
  return { repo: r, project: true, columns: PROJECT_COLUMNS, cards, prs, merged: [], order: [], next: 36, fetchedAt: now };
}

/** 100 issues and 20 pull requests: the perf check. */
function perfRepo(now: number): Repo {
  const r = 'JeffreyVdb/bench';
  const cols = PROJECT_COLUMNS.map((c) => c.id);
  const prio = [undefined, undefined, 'low', 'medium', 'high', 'urgent'] as const;
  const lab = [LABELS.bridge, LABELS.game, LABELS.design, LABELS.bug, LABELS.docs];
  const cards = Array.from({ length: 100 }, (_, i) => {
    const col = cols[i % cols.length] as string;
    const done = col === COL.done;
    const p = prio[i % prio.length];
    return mkCard(r, i + 1, `Perf note ${i + 1}: ${['refactor the hub fan-out', 'tune shadow cascades', 'write vitest for the store', 'chase a seq gap', 'profile the city view'][i % 5]}`, col, {
      labels: [lab[i % lab.length] as BoardLabel],
      ...(p ? { priority: p } : {}),
      ...(done ? { state: 'closed', closed_at: now - (i + 1) * 600_000 } : {}),
      updated_at: now - (i + 1) * 600_000,
    });
  });
  const prs = Array.from({ length: 20 }, (_, i) =>
    mkPr(r, 101 + i, `Perf PR ${i + 1}: ${['hub', 'shadows', 'store', 'replay', 'city'][i % 5]} work`, `feat/perf-${i + 1}`, {
      closes: i % 3 === 0 ? [`${r}#${i + 1}`] : [],
      checks: (['success', 'failure', 'pending', 'none'] as const)[i % 4] as PullRequest['checks'],
      review: (['approved', 'changes_requested', 'review_required', 'none'] as const)[i % 4] as PullRequest['review'],
    }),
  );
  return { repo: r, project: true, columns: PROJECT_COLUMNS, cards, prs, merged: [], order: [], next: 121, fetchedAt: now };
}

/** Any other repo: no project, so Open / Closed. */
function plainRepo(repo: string, now: number): Repo {
  const cards = [
    mkCard(repo, 1, 'Track the savings plan', 'open', { labels: [LABELS.docs], updated_at: now - HOUR }),
    mkCard(repo, 2, 'Alert on unhealthy hosts', 'open', { priority: 'high', labels: [LABELS.p1, LABELS.bug], updated_at: now - 3 * HOUR }),
    mkCard(repo, 3, 'S3 cleanup dry run', 'open', { updated_at: now - 6 * HOUR }),
    mkCard(repo, 4, 'Retire the old dashboard', 'closed', { state: 'closed', closed_at: now - 30 * HOUR, updated_at: now - 30 * HOUR }),
  ];
  const prs = [mkPr(repo, 5, 'Savings plan report', 'feat/savings', { closes: [`${repo}#1`] })];
  return { repo, project: false, columns: PLAIN_COLUMNS, cards, prs, merged: [], order: [], next: 6, fetchedAt: now };
}

const RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const byUrgency = (a: IssueCard, b: IssueCard) =>
  (RANK[a.priority ?? ''] ?? 4) - (RANK[b.priority ?? ''] ?? 4) || (b.updated_at ?? 0) - (a.updated_at ?? 0) || a.key.localeCompare(b.key, undefined, { numeric: true });
const byClosed = (a: IssueCard, b: IssueCard) => (b.closed_at ?? b.updated_at ?? 0) - (a.closed_at ?? a.updated_at ?? 0) || byUrgency(a, b);

/** A project's first order: column by column, each the way the game sorted it before there was one. */
function seedOrder(b: Repo): Repo {
  if (!b.project) return b;
  b.order = b.columns.flatMap((col) =>
    b.cards
      .map((c) => c.card)
      .filter((c) => c.column === col.id)
      .sort(col.done ? byClosed : byUrgency)
      .map((c) => c.id),
  );
  return b;
}

export class BoardSim {
  readonly enabled: boolean;
  private readonly d: BoardsDeps;
  private readonly repos = new Map<string, Repo>();
  private watching: { session: string; send: Send } | null = null;
  /** `sim.boards`: what the next polls say. */
  private failing: string | null = null;
  private rate: { remaining: number; reset_at: number } | null = null;
  private truncated = false;
  private pending = false;
  /** `sim.boards {fail_write}`: what every issue.set_status fails with. */
  private failWrite: string | null = null;
  /** `sim.boards {no_refresh}`: writes queue no poll. */
  private noRefresh = false;
  /** `sim.boards {partial_write}`: what an issue.set_status with `after` fails with once its status changed. */
  private partialWrite: string | null = null;

  constructor(d: BoardsDeps, enabled: boolean) {
    this.d = d;
    this.enabled = enabled;
  }

  /** Adds `work_item` to every worker that has an `issue` (the bridge sends both). */
  decorate(world: { workers?: Worker[] }): void {
    if (!this.enabled) return;
    for (const w of world.workers ?? []) if (w.issue && !w.work_item) w.work_item = { provider: PROVIDER, id: `${w.issue.repo}#${w.issue.number}` };
  }

  private repoOf(session: string): string | null {
    const f = this.d.floors.get(session);
    return f?.settings?.repo ?? f?.suggested?.repo ?? null;
  }

  private board(repo: string): Repo {
    let b = this.repos.get(repo);
    if (!b) {
      const now = this.d.now();
      b = seedOrder(repo === 'JeffreyVdb/lab' ? toyRepo(now) : repo === 'JeffreyVdb/herdr-3d' ? herdrRepo(now) : repo === 'JeffreyVdb/bench' ? perfRepo(now) : plainRepo(repo, now));
      this.repos.set(repo, b);
    }
    return b;
  }

  /** The GitHub provider's neutral issue for a work item of a floor (the bridge resolves it to the M6 path); null: not on the board. */
  resolveWorkItem(session: string, wi: { provider?: unknown; id?: unknown }): { repo: string; number: number; url: string; key: string; title: string } | null {
    const repo = this.repoOf(session);
    if (!repo || wi.provider !== PROVIDER || typeof wi.id !== 'string') return null;
    const c = this.board(repo).cards.find((x) => x.card.id === wi.id);
    if (!c) return null;
    return { repo, number: Number(c.card.key.slice(1)), url: c.card.url ?? '', key: c.card.key, title: c.card.title };
  }

  // ---- messages ---------------------------------------------------------------------------------

  private caps(b: Repo, kind: 'issues' | 'prs'): BoardCaps {
    return kind === 'issues' ? { comment: true, close: true, set_status: b.project, order: b.project } : { comment: true, merge: true, open_from_branch: true };
  }

  private base(b: Repo, initial: boolean) {
    return {
      provider: PROVIDER,
      provider_name: NAME,
      initial,
      fetched_at: initial ? b.fetchedAt : this.d.now(),
      stale: this.failing !== null,
      ...(this.failing !== null ? { error: this.failing } : {}),
      truncated: this.truncated,
      ...(this.rate ? { rate: this.rate } : { rate: { remaining: 4870, reset_at: this.d.now() + HOUR } }),
    };
  }

  private issues(session: string, b: Repo, initial: boolean): BoardIssues {
    const rank = new Map(b.order.map((id, i) => [id, i]));
    const cards = b.cards.map((c) => {
      const at = rank.get(c.card.id);
      const card = at === undefined ? c.card : { ...c.card, position: at };
      return c.card.state === 'closed' ? { ...card, capabilities: { close: false } } : card;
    });
    return { t: 'board.issues', session, ...this.base(b, initial), capabilities: this.caps(b, 'issues'), columns: b.columns, cards } as BoardIssues;
  }

  private prs(session: string, b: Repo, initial: boolean, merged: Repo['merged']): BoardPrs {
    return { t: 'board.prs', session, ...this.base(b, initial), capabilities: this.caps(b, 'prs'), prs: b.prs.map((p) => p.pr), merged } as BoardPrs;
  }

  /** A poll of the watched floor's board (or the floor asked): the merges since the last one are announced now, once. */
  private poll(session: string): void {
    const w = this.watching;
    if (!w || w.session !== session) return;
    const repo = this.repoOf(session);
    if (!repo) return;
    const b = this.board(repo);
    if (this.failing === null) b.fetchedAt = this.d.now();
    const merged = b.merged;
    if (this.failing === null) b.merged = [];
    w.send({ ...this.issues(session, b, false) });
    w.send({ ...this.prs(session, b, false, this.failing === null ? merged : []) });
  }

  private queue(session: string, ms = 40): void {
    if (this.pending) return;
    this.pending = true;
    this.d.later(() => {
      this.pending = false;
      this.poll(session);
    }, ms);
  }

  // ---- commands ------------------------------------------------------------------------------------

  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): boolean {
    if (typeof t !== 'string' || !COMMANDS.has(t)) return false;
    if (!this.enabled && t !== 'sim.boards') return false;
    try {
      switch (t) {
        case 'board.watch':
          return this.watch(a, send, ack), true;
        case 'board.unwatch':
          this.only(a, ['session']);
          if (this.watching?.session === this.session(a).session) this.watching = null;
          return ack(), true;
        case 'board.refresh': {
          this.only(a, ['session']);
          const s = this.session(a).session;
          this.queue(s, 20);
          return ack({ queued: true }), true;
        }
        case 'issue.get':
          return ack(this.issueGet(a)), true;
        case 'issue.comment':
          return ack(this.commentOn(a, 'issue')), true;
        case 'issue.close':
          return this.close(a), ack(), true;
        case 'issue.set_status':
          return this.setStatus(a), ack(), true;
        case 'pr.get':
          return ack(this.prGet(a)), true;
        case 'pr.comment':
          return ack(this.commentOn(a, 'pr')), true;
        case 'pr.merge':
          return this.merge(a), ack({ merged: true }), true;
        case 'worker.open_pr.prepare':
          return ack(this.openPrPrepare(a)), true;
        case 'worker.open_pr':
          return ack(this.openPr(a)), true;
        case 'sim.boards':
          return ack(this.simControl(a)), true;
      }
    } catch (e) {
      fail(e);
      return true;
    }
    return false;
  }

  private bad(m: string): Error {
    return this.d.error('bad_request', `bad args: ${m}`);
  }

  private only(a: Obj, keys: string[]): void {
    for (const k of Object.keys(a)) if (!keys.includes(k)) throw this.bad(`json: unknown field "${k}"`);
  }

  private session(a: Obj): { session: string; repo: string | null } {
    if (typeof a.session !== 'string') throw this.bad('session must be a string');
    if (!this.d.floors.has(a.session)) throw this.d.error('unknown_session', `unknown session: "${a.session}"`);
    return { session: a.session, repo: this.repoOf(a.session) };
  }

  private repoFor(a: Obj): { session: string; b: Repo } {
    const { session, repo } = this.session(a);
    if (!repo) throw this.d.error('unsupported', 'this floor has no issue provider (no repo linked)');
    return { session, b: this.board(repo) };
  }

  private watch(a: Obj, send: Send, ack: (d?: unknown) => void): void {
    this.only(a, ['session']);
    const { session, repo } = this.session(a);
    if (!repo) {
      this.watching = null;
      ack({ enabled: false, reason: 'no repo linked' });
      return;
    }
    this.watching = { session, send };
    const b = this.board(repo);
    ack({ enabled: true });
    send({ ...this.issues(session, b, true) });
    send({ ...this.prs(session, b, true, []) });
  }

  /** #184: the floor's tracker is about to change: the watch of that floor ends here, its connection is returned. */
  release(session: string): Send | null {
    const w = this.watching;
    if (!w || w.session !== session) return null;
    this.watching = null;
    return w.send;
  }

  /** #184: a watch handed over after the floor's tracker changed: the new board, as the bridge sends its watchers. */
  rewatch(session: string, send: Send): void {
    const repo = this.repoOf(session);
    if (!repo) return;
    this.watching = { session, send };
    const b = this.board(repo);
    send({ ...this.issues(session, b, true) });
    send({ ...this.prs(session, b, true, []) });
  }

  private text(a: Obj, k: string, max = 65_536): string {
    const v = a[k];
    if (typeof v !== 'string' || !v.trim() || bytes(v) > max) throw this.bad(`${k} must be 1-${max} bytes of text`);
    if ([...v].some((c) => c.charCodeAt(0) < 32 && c !== '\n' && c !== '\t')) throw this.bad(`${k} has control characters`);
    return v;
  }

  private card(a: Obj): { session: string; b: Repo; c: SimCard } {
    const { session, b } = this.repoFor(a);
    const id = this.text(a, 'id', 512);
    const c = b.cards.find((x) => x.card.id === id);
    if (!c) throw this.d.error('not_found', `not found: "${id}"`);
    return { session, b, c };
  }

  private pr(a: Obj): { session: string; b: Repo; p: SimPr } {
    const { session, b } = this.repoFor(a);
    const id = this.text(a, 'id', 512);
    const p = b.prs.find((x) => x.pr.id === id);
    if (!p) throw this.d.error('not_found', `not found: "${id}"`);
    return { session, b, p };
  }

  private issueGet(a: Obj): Obj {
    this.only(a, ['session', 'id']);
    const { c } = this.card(a);
    return { card: c.card, body: c.body, author: person(c.author), created_at: c.created_at, comments: c.comments, comments_truncated: false };
  }

  private prGet(a: Obj): Obj {
    this.only(a, ['session', 'id']);
    const { p } = this.pr(a);
    return { pr: p.pr, body: p.body, author: person(p.author), created_at: p.created_at, files: p.files, files_truncated: false, checks: p.checks, comments: p.comments, comments_truncated: false };
  }

  private commentOn(a: Obj, kind: 'issue' | 'pr'): Obj {
    this.only(a, ['session', 'id', 'body']);
    const body = this.text(a, 'body');
    const target = kind === 'issue' ? this.card(a) : this.pr(a);
    const list = 'c' in target ? target.c.comments : target.p.comments;
    const made = comment(`C_${list.length + 1}_${this.d.now()}`, 'JeffreyVdb', body, this.d.now());
    list.push(made);
    this.queue(target.session);
    return { comment: made };
  }

  private confirm(a: Obj, k = 'confirm', what = 'this'): void {
    if (a[k] !== true) throw this.d.error('confirmation_required', `${what} needs ${k}: true`);
  }

  private close(a: Obj): void {
    this.only(a, ['session', 'id', 'reason', 'confirm']);
    const { session, b, c } = this.card(a);
    this.confirm(a, 'confirm', 'closing an issue');
    if (a.reason !== 'completed' && a.reason !== 'not_planned' && a.reason !== 'duplicate') throw this.bad('reason must be completed, not_planned or duplicate');
    if (c.card.state === 'closed') throw this.d.error('invalid_state', 'the issue is already closed');
    c.card.state = 'closed';
    c.card.closed_at = this.d.now();
    c.card.updated_at = this.d.now();
    c.card.column = b.project ? COL.done : 'closed';
    this.queue(session);
  }

  private setStatus(a: Obj): void {
    this.only(a, ['session', 'id', 'column', 'after']);
    const { session, b, c } = this.card(a);
    if (!b.project) throw this.d.error('unsupported', 'this floor has no project: statuses cannot be set');
    const col = this.text(a, 'column', 512);
    if (!b.columns.some((x) => x.id === col)) throw this.d.error('not_found', `not found: column "${col}"`);
    const id = c.card.id;
    let at: number | null = null; // where in the order it goes (null: it stays)
    if ('after' in a) {
      const rest = b.order.filter((x) => x !== id);
      const inCol = (x: string) => b.cards.find((y) => y.card.id === x)?.card.column === col;
      if (a.after === null) {
        const first = rest.findIndex(inCol);
        at = first < 0 ? 0 : first;
      } else {
        if (typeof a.after !== 'string' || a.after === id || !inCol(a.after)) throw this.bad(`after ${JSON.stringify(a.after)} is not another card of that column`);
        at = rest.indexOf(a.after) + 1;
      }
      if (this.failWrite === null && this.partialWrite === null) b.order = [...rest.slice(0, at), id, ...rest.slice(at)];
    }
    if (this.failWrite !== null) throw this.d.error('provider_failed', this.failWrite);
    c.card.column = col;
    c.card.updated_at = this.d.now();
    if (!this.noRefresh) this.queue(session);
    // The status landed, the place did not: the bridge refreshes all the same.
    if (this.partialWrite !== null && 'after' in a) throw this.d.error('provider_failed', `its status changed, but its place in the column did not: ${this.partialWrite}`);
  }

  /** Marks a PR merged: gone from the open list, announced on the next poll, its issues closed and in Done. */
  private mergePr(session: string, b: Repo, p: SimPr): void {
    b.prs = b.prs.filter((x) => x !== p);
    b.merged.push({ id: p.pr.id, key: p.pr.key, title: p.pr.title, merged_at: this.d.now(), closes: p.pr.closes });
    for (const id of p.pr.closes) {
      const c = b.cards.find((x) => x.card.id === id);
      if (!c || c.card.state === 'closed') continue;
      c.card.state = 'closed';
      c.card.closed_at = this.d.now();
      c.card.updated_at = this.d.now();
      c.card.column = b.project ? COL.done : 'closed';
    }
    this.queue(session);
  }

  private merge(a: Obj): void {
    this.only(a, ['session', 'id', 'method', 'confirm', 'override', 'confirm_override']);
    const { session, b, p } = this.pr(a);
    this.confirm(a, 'confirm', 'a merge');
    if (a.method !== 'merge' && a.method !== 'squash' && a.method !== 'rebase') throw this.bad('method must be merge, squash or rebase');
    const override = a.override === true;
    if (override) this.confirm(a, 'confirm_override', 'an override');
    const pr = p.pr;
    if (pr.mergeable === 'conflicting') throw this.d.error('not_mergeable', 'the pull request has merge conflicts');
    if (pr.checks !== 'success' && !override) throw this.d.error('checks_not_green', `checks are ${pr.checks}`);
    if (pr.mergeable !== 'mergeable' && !override) throw this.d.error('not_mergeable', `mergeable state is ${pr.mergeable}`);
    if (this.failing === 'head_moved') throw this.d.error('stale', 'the head moved: read the pull request again');
    this.mergePr(session, b, p);
  }

  private plainWorker(a: Obj): { w: Worker; repo: string; branch: string } {
    if (typeof a.id !== 'string') throw this.bad('id must be a string');
    const w = this.d.workers.find((x) => x.id === a.id);
    if (!w) throw this.d.error('unknown_worker', `unknown worker: "${a.id}"`);
    const repo = this.repoOf(w.session);
    if (!repo) throw this.d.error('unsupported', 'this floor has no code host (no repo linked)');
    const branch = this.d.hireBranch(w.id);
    if (w.role || /^(ORCH|CODE|REVIEW|UX|GROUND)\|/.test(w.label)) throw this.d.error('invalid_state', 'only a plain worker can open a pull request');
    if (!branch) throw this.d.error('invalid_state', 'this worker is not on a branch the bridge made for it');
    return { w, repo, branch };
  }

  private openPrPrepare(a: Obj): Obj {
    this.only(a, ['id']);
    const { w, repo, branch } = this.plainWorker(a);
    const dirty = this.d.dirty(w);
    const existing = this.board(repo).prs.find((p) => p.pr.head_branch === branch);
    const out: Obj = { can_open: !dirty, branch, base: 'main', ahead: 2, dirty, title: `Work on ${branch.replace(/^h3d\//, '')}`, body: `- Work on ${branch.replace(/^h3d\//, '')}\n- Tidy the tests` };
    if (dirty) out.reason = 'the checkout has uncommitted changes: commit them first';
    if (existing) out.existing = { id: existing.pr.id, key: existing.pr.key, url: existing.pr.url };
    return out;
  }

  private openPr(a: Obj): Obj {
    this.only(a, ['id', 'title', 'body', 'confirm']);
    const { w, repo, branch } = this.plainWorker(a);
    this.confirm(a, 'confirm', 'opening a pull request');
    const title = this.text(a, 'title', 256);
    if (typeof a.body !== 'string' || bytes(a.body) > 65_536) throw this.bad('body must be at most 65536 bytes');
    if (this.d.dirty(w)) throw this.d.error('invalid_state', 'the checkout has uncommitted changes');
    const b = this.board(repo);
    const have = b.prs.find((p) => p.pr.head_branch === branch);
    if (have) return { pr: { id: have.pr.id, key: have.pr.key, url: have.pr.url }, pushed: false, existed: true };
    const n = b.next++;
    const made = mkPr(repo, n, title, branch, { updated_at: this.d.now() });
    b.prs.unshift(made);
    this.queue(w.session);
    return { pr: { id: made.pr.id, key: made.pr.key, url: made.pr.url }, pushed: true, existed: false };
  }

  /** The simulator's own command: what the next polls say, and scripted merges. */
  private simControl(a: Obj): Obj {
    const session = typeof a.session === 'string' ? a.session : this.watching?.session;
    if (!session) throw this.bad('no floor watched');
    const repo = this.repoOf(session);
    if (!repo) throw this.bad('the floor has no repo');
    const b = this.board(repo);
    if (typeof a.merge === 'string') {
      const p = b.prs.find((x) => x.pr.id === a.merge);
      if (!p) throw this.d.error('not_found', `not found: "${a.merge}"`);
      this.mergePr(session, b, p);
    }
    if (a.fail !== undefined) this.failing = typeof a.fail === 'string' ? a.fail : null;
    if (a.rate !== undefined) this.rate = isObj(a.rate) ? (a.rate as { remaining: number; reset_at: number }) : null;
    if (typeof a.truncated === 'boolean') this.truncated = a.truncated;
    if (a.fail_write !== undefined) this.failWrite = typeof a.fail_write === 'string' ? a.fail_write : null;
    if (typeof a.no_refresh === 'boolean') this.noRefresh = a.no_refresh;
    if (a.partial_write !== undefined) this.partialWrite = typeof a.partial_write === 'string' ? a.partial_write : null;
    if (isObj(a.card)) {
      // Moves a card (a poll finds it in another column) without a command of the game's.
      const c = b.cards.find((x) => x.card.id === (a.card as Obj).id);
      if (c && typeof (a.card as Obj).column === 'string') c.card.column = (a.card as Obj).column as string;
    }
    if (a.poll === true || a.merge !== undefined || a.fail !== undefined || a.rate !== undefined || a.truncated !== undefined || a.card !== undefined) this.queue(session, 10);
    return { session, repo, prs: b.prs.map((p) => p.pr.id), merged: b.merged.length };
  }
}

/** The floor's repos this simulator has boards for (test hook). */
export const SIM_REPOS = ['JeffreyVdb/lab', 'JeffreyVdb/herdr-3d', 'JeffreyVdb/bench'];
