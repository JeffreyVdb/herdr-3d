// #184: Kaneo for the fixture server's `sim=1` (tools/fixture-sim.ts hands these commands over first). Rules, like
// herdr-world's (docs/protocol.md "Kaneo"):
// - The snapshot's `kaneo` is the connection (`simkaneo=off`, the default: nothing saved; `connected`: already saved
//   for https://kaneo.example.test with Studio as the default workspace; `unavailable`: a bridge without a Kaneo
//   client; `old`: a bridge before Kaneo, no `kaneo` at all and every kaneo.* command `unknown_command`).
//   Never a key: `key_set` only. Every change is a `kaneo.update` with the state flat in it.
// - `kaneo.test {url?, key?}` resolves the address (https, or http to 127.0.0.1 / localhost; a trailing /api is the
//   same instance) and checks the key: a blank key is the saved key, for the saved instance only (else
//   `key_required`). An address with `offline` in it is `unreachable`; a key starting with `bad` is `unauthorized`
//   (the 401 that may be a quota), `forbidden` is `forbidden`, `empty` reaches no workspace, `slow` answers after
//   `simkaneoslow` ms (default 1500). Any other key passes: Studio, Home, Locked, Empty and Slow lane.
// - `kaneo.set {url?, key?, default_workspace?}` needs a passing test of that very address and key (`test_required`)
//   and a default the test found (`bad_request`); the generation moves when the address or the key does.
//   `kaneo.clear {}` disconnects.
// - `kaneo.workspaces {}` and `kaneo.projects {workspace_id}` use the saved connection (`not_configured` without
//   one). Studio has herdr-3d (HRD) and Website (WEB, a board longer than the bridge reads: `truncated`), Home has
//   Garden (GDN), Locked's projects are `forbidden`, Empty has none, Slow lane's answer after `simkaneoslow` ms (the
//   rapid-switch case).
// - `floor.settings.set` with `tracker` / `kaneo` checks the project against Kaneo like the bridge: a project of
//   another workspace or an unknown one (`gone`) is refused; `not_configured` without a connection.
// - A Kaneo floor's board (`board.watch` and the issue commands of a floor whose tracker is Kaneo): Planned, To Do,
//   In Progress, In Review, Done and Shipped (both final), Archived; tasks with keys, no timestamps, priorities,
//   labels, assignees; `close` is off, `issue.close` is `unsupported`. A task (HRD-4) has a long description the list
//   leaves out (fetched with `issue.get`). Writes queue a poll. A drop with `after` on the truncated board is
//   `unsupported`. `sim.kaneo` (the simulator's own command) makes the next polls fail (`{fail: "unauthorized" |
//   "forbidden" | "message" | null}`: a refused key pauses the board for five minutes), the next placed move stale
//   (`{stale: true}`: the 409 of a board that changed), or polls (`{poll: true}`).
// - A run on a Kaneo task is an `item` ticket: the prompt carries the key, title, link and description.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { BoardColumn, BoardComment, Floor, FloorSettings, IssueCard, KaneoProject, KaneoWorkspace } from '../src/net/protocol.ts';

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

export type KaneoMode = 'off' | 'connected' | 'unavailable' | 'old';

export interface KaneoDeps {
  floors: Map<string, Floor>;
  emit(send: Send, m: Obj): void;
  error(code: string, message: string): Error;
  later(fn: () => void, ms: number): unknown;
  now(): number;
}

const COMMANDS = new Set(['kaneo.get', 'kaneo.test', 'kaneo.set', 'kaneo.clear', 'kaneo.workspaces', 'kaneo.projects', 'sim.kaneo']);
const BOARD = new Set(['board.watch', 'board.unwatch', 'board.refresh', 'issue.get', 'issue.comment', 'issue.close', 'issue.set_status']);
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const COOLDOWN = 5 * 60_000;
export const SIM_KANEO_URL = 'https://kaneo.example.test';

export const SIM_KANEO_WORKSPACES: KaneoWorkspace[] = [
  { id: 'ws-studio', name: 'Studio', slug: 'studio' },
  { id: 'ws-home', name: 'Home', slug: 'home' },
  { id: 'ws-locked', name: 'Locked', slug: 'locked' },
  { id: 'ws-empty', name: 'Empty', slug: 'empty' },
  { id: 'ws-slow', name: 'Slow lane', slug: 'slow' },
];
const PROJECTS: KaneoProject[] = [
  { id: 'p-herdr', workspace_id: 'ws-studio', name: 'herdr-3d', slug: 'HRD' },
  { id: 'p-web', workspace_id: 'ws-studio', name: 'Website', slug: 'WEB' },
  { id: 'p-garden', workspace_id: 'ws-home', name: 'Garden', slug: 'GDN' },
  { id: 'p-slow', workspace_id: 'ws-slow', name: 'Slow project', slug: 'SLW' },
];

const COLUMNS: BoardColumn[] = [
  { id: 'planned', name: 'Planned', kind: 'planned' },
  { id: 'to-do', name: 'To Do' },
  { id: 'in-progress', name: 'In Progress' },
  { id: 'in-review', name: 'In Review' },
  { id: 'done', name: 'Done', done: true },
  { id: 'shipped', name: 'Shipped', done: true },
  { id: 'archived', name: 'Archived', kind: 'archived' },
];
const FINAL = new Set(['done', 'shipped']);

const LONG_BODY = ['## A long one', '', 'The list leaves this description out (Kaneo defers bodies over 64 KiB); the task view reads it.', '', ...Array.from({ length: 40 }, (_, i) => `${i + 1}. Step ${i + 1}: check the floor still reads Kaneo after a restart.`)].join('\n');

interface SimTask {
  card: IssueCard;
  body: string;
  comments: BoardComment[];
}

interface SimProject {
  project: KaneoProject;
  tasks: SimTask[];
  order: string[];
  truncated: boolean;
}

function task(p: KaneoProject, n: number, title: string, column: string, o: Partial<IssueCard> & { body?: string } = {}): SimTask {
  const id = `task-${p.slug?.toLowerCase()}-${n}`;
  const { body, ...rest } = o;
  const card: IssueCard = {
    id,
    key: `${p.slug}-${n}`,
    title,
    state: FINAL.has(column) ? 'closed' : 'open',
    column,
    url: `${SIM_KANEO_URL}/dashboard/workspace/${p.workspace_id}/project/${p.id}/task/${id}`,
    labels: [],
    assignees: [],
    author: '',
    updated_at: 0,
    closed_at: null,
    ...rest,
  };
  return { card, body: body ?? `## ${title}\n\nA Kaneo task of **${p.name}**.\n\n- [ ] do it\n- [ ] check it`, comments: [] };
}

function seed(p: KaneoProject): SimProject {
  const L = (name: string, color: string) => ({ name, color });
  let tasks: SimTask[];
  if (p.id === 'p-web') {
    tasks = Array.from({ length: 40 }, (_, i) => task(p, i + 1, `Website page ${i + 1}`, COLUMNS[1 + (i % 5)]!.id));
  } else {
    tasks = [
      task(p, 1, 'Plan the Kaneo lobby sign', 'planned'),
      task(p, 2, 'Read the boards from Kaneo', 'in-progress', { priority: 'high', labels: [L('bridge', '#1d76db')], assignees: [{ name: 'Theo' }] }),
      task(p, 3, 'Settings: Kaneo connection', 'in-review', { priority: 'medium', labels: [L('game', '#0e8a16')] }),
      task(p, 4, 'A task with a long description', 'to-do', { priority: 'urgent', body: LONG_BODY }),
      task(p, 5, 'Pick a workspace per floor', 'to-do', { labels: [L('design', '#d876e3')] }),
      task(p, 6, 'Write the protocol docs', 'done', { labels: [L('docs', '#0075ca')] }),
      task(p, 7, 'Ship the helper allowlist', 'shipped'),
      task(p, 8, 'Old idea: sync with GitHub', 'archived', { priority: 'low' }),
    ];
    const c2 = tasks[1];
    if (c2) c2.comments.push({ id: 'kc-1', author: { name: 'Theo' }, body: 'Started on the **bridge** side.', created_at: 0 });
  }
  return { project: p, tasks, order: tasks.map((t) => t.card.id), truncated: p.id === 'p-web' };
}

export class KaneoSim {
  private readonly d: KaneoDeps;
  private readonly mode: KaneoMode;
  private readonly slowMs: number;
  private state: { url: string; api_base: string; web_origin: string; key: string; default_workspace: KaneoWorkspace | null; generation: number } | null = null;
  private generation = 0;
  private passed: { api_base: string; key: string; workspaces: KaneoWorkspace[] } | null = null;
  private paused: { until: number } | null = null;
  private readonly projects = new Map<string, SimProject>();
  private watching: { session: string; send: Send } | null = null;
  private failing: string | null = null;
  private staleNext = false;
  private pending = false;

  constructor(d: KaneoDeps, mode: KaneoMode = 'off', slowMs = 1500) {
    this.d = d;
    this.mode = mode;
    this.slowMs = slowMs;
    if (mode === 'connected') {
      this.generation = 1;
      this.state = { url: SIM_KANEO_URL, api_base: `${SIM_KANEO_URL}/api`, web_origin: SIM_KANEO_URL, key: 'sim-key', default_workspace: SIM_KANEO_WORKSPACES[0]!, generation: 1 };
    }
  }

  view(): Obj {
    const s = this.state;
    const v: Obj = {
      state: !s ? 'off' : this.paused ? 'paused' : 'ready',
      available: this.mode !== 'unavailable',
      url: s?.url ?? '',
      api_base: s?.api_base ?? '',
      web_origin: s?.web_origin ?? '',
      key_set: !!s,
      default_workspace: s?.default_workspace ?? null,
      generation: this.generation,
    };
    if (s && this.paused) {
      v.paused_until = this.paused.until;
      v.last_error = { kind: 'unauthorized', message: 'Kaneo refused the API key. It may be wrong or revoked, or out of its request quota: wait a minute and test again.', at: this.d.now(), runtime: true };
    }
    return v;
  }

  decorate(world: Obj): void {
    if (this.mode !== 'old') world.kaneo = this.view();
  }

  /** Whether a floor uses Kaneo. */
  isKaneo(session: string): boolean {
    return this.d.floors.get(session)?.settings?.tracker === 'kaneo';
  }

  private bad(m: string): Error {
    return this.d.error('bad_request', `bad args: ${m}`);
  }

  private only(a: Obj, keys: string[]): void {
    for (const k of Object.keys(a)) if (!keys.includes(k)) throw this.bad(`json: unknown field "${k}"`);
  }

  private publish(send: Send): void {
    this.d.emit(send, { t: 'kaneo.update', ...this.view() });
  }

  /** Answers the kaneo.* commands, and the board commands of a Kaneo floor; false: not ours. */
  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): boolean {
    if (typeof t !== 'string') return false;
    if (BOARD.has(t)) {
      const session = typeof a.session === 'string' ? a.session : '';
      if (t === 'board.watch' && !this.isKaneo(session)) this.watching = null; // the GitHub boards take over
      if (!this.isKaneo(session)) return false;
      try {
        this.board(t, a, send, ack);
      } catch (e) {
        fail(e);
      }
      return true;
    }
    if (!COMMANDS.has(t)) return false;
    if (this.mode === 'old' && t !== 'sim.kaneo') return false;
    try {
      switch (t) {
        case 'kaneo.get':
          this.only(a, []);
          ack(this.view());
          break;
        case 'kaneo.test':
          this.only(a, ['url', 'key']);
          this.test(a, send, ack, fail);
          break;
        case 'kaneo.set':
          this.only(a, ['url', 'key', 'default_workspace']);
          ack(this.save(a, send));
          break;
        case 'kaneo.clear':
          this.only(a, []);
          this.state = null;
          this.generation++;
          this.passed = null;
          this.paused = null;
          this.publish(send);
          ack(this.view());
          break;
        case 'kaneo.workspaces':
          this.only(a, []);
          this.saved();
          ack({ workspaces: SIM_KANEO_WORKSPACES, generation: this.generation });
          break;
        case 'kaneo.projects':
          this.only(a, ['workspace_id']);
          this.projectsOf(a, ack, fail);
          break;
        case 'sim.kaneo':
          ack(this.control(a, send));
          break;
      }
    } catch (e) {
      fail(e);
    }
    return true;
  }

  private resolve(raw: string): { url: string; api_base: string; web_origin: string } {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw this.d.error('bad_url', 'Not a Kaneo instance URL: it does not parse.');
    }
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (u.username || u.password || u.search || u.hash || !(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) {
      throw this.d.error('bad_url', 'Not a Kaneo instance URL: use https (http only for 127.0.0.1), with no credentials or query.');
    }
    const path = u.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
    const origin = `${u.protocol}//${u.host}${path}`;
    return { url: raw.trim(), api_base: `${origin}/api`, web_origin: origin };
  }

  private draft(a: Obj): { url: string; api_base: string; web_origin: string; key: string } {
    if (this.mode === 'unavailable') throw this.d.error('unsupported', 'This bridge cannot reach Kaneo: it has no Kaneo client.');
    const raw = typeof a.url === 'string' ? a.url.trim() : (this.state?.url ?? '');
    if (!raw) throw this.d.error('bad_url', 'Enter the Kaneo instance URL, e.g. https://kaneo.example.com.');
    const inst = this.resolve(raw);
    let key = typeof a.key === 'string' ? a.key.trim() : '';
    if (!key) {
      if (this.state && this.state.api_base === inst.api_base) key = this.state.key;
      else if (this.state) throw this.d.error('key_required', `Enter the API key for this instance: the saved key is only ever sent to ${this.state.api_base}.`);
      else throw this.d.error('key_required', 'Enter the API key.');
    }
    return { ...inst, key };
  }

  private outcome(d: { url: string; key: string }): { code: string; message: string } | null {
    if (d.url.includes('offline')) return { code: 'unreachable', message: 'Kaneo could not be reached: dial tcp: connection refused' };
    if (d.key.startsWith('bad')) return { code: 'unauthorized', message: 'Kaneo refused the API key. It may be wrong or revoked, or out of its request quota: wait a minute and test again.' };
    if (d.key.startsWith('forbidden')) return { code: 'forbidden', message: 'This key may not reach that Kaneo workspace or project.' };
    return null;
  }

  private test(a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): void {
    const d = this.draft(a);
    const done = () => {
      const bad = this.outcome(d);
      if (bad) return fail(this.d.error(bad.code, bad.message));
      const workspaces = d.key.startsWith('empty') ? [] : SIM_KANEO_WORKSPACES;
      this.passed = { api_base: d.api_base, key: d.key, workspaces };
      if (this.state && this.state.api_base === d.api_base && this.state.key === d.key && this.paused) {
        // A passing re-test of the saved connection ends the pause: the boards poll again now.
        this.paused = null;
        this.failing = null;
        this.publish(send);
        if (this.watching) this.queue(this.watching.session, 10);
      }
      ack({ ok: true, latency_ms: d.key.startsWith('slow') ? this.slowMs : 84, url: d.url, api_base: d.api_base, web_origin: d.web_origin, workspaces, user: 'Fixture User' });
    };
    if (d.key.startsWith('slow')) this.d.later(done, this.slowMs);
    else done();
  }

  private save(a: Obj, send: Send): Obj {
    const d = this.draft(a);
    const p = this.passed;
    if (!p || p.api_base !== d.api_base || p.key !== d.key) throw this.d.error('test_required', 'Test the connection first: only a connection whose test passed is saved.');
    let def = this.state?.default_workspace ?? null;
    if ('default_workspace' in a) {
      const id = a.default_workspace;
      if (id === null || id === '') def = null;
      else {
        def = p.workspaces.find((w) => w.id === id) ?? null;
        if (!def) throw this.d.error('bad_request', 'The default workspace is not one this key reaches: test again and pick it from the list.');
      }
    } else if (def && !p.workspaces.some((w) => w.id === def?.id)) def = null;
    if (!this.state || this.state.api_base !== d.api_base || this.state.key !== d.key) this.generation++;
    this.state = { url: d.url, api_base: d.api_base, web_origin: d.web_origin, key: d.key, default_workspace: def, generation: this.generation };
    this.paused = null;
    this.publish(send);
    return this.view();
  }

  private saved(): void {
    if (this.mode === 'unavailable') throw this.d.error('unsupported', 'This bridge cannot reach Kaneo: it has no Kaneo client.');
    if (!this.state) throw this.d.error('not_configured', 'Kaneo is not connected: set it up in Settings first.');
  }

  private projectsOf(a: Obj, ack: (d?: unknown) => void, fail: (e: unknown) => void): void {
    if (typeof a.workspace_id !== 'string' || !a.workspace_id) throw this.bad('workspace_id must be 1-200 bytes');
    this.saved();
    const ws = a.workspace_id;
    const answer = () => {
      if (ws === 'ws-locked') return fail(this.d.error('forbidden', 'This key may not reach that Kaneo workspace or project.'));
      ack({ workspace_id: ws, projects: PROJECTS.filter((p) => p.workspace_id === ws), generation: this.generation });
    };
    if (ws === 'ws-slow') this.d.later(answer, this.slowMs);
    else answer();
  }

  // ---- floor settings ---------------------------------------------------------------------------------

  /** Checks a floor's `tracker` / `kaneo` like the bridge; returns what to store over `cur`. */
  applySettings(cur: FloorSettings, a: Obj): FloorSettings {
    const next: FloorSettings = { ...cur };
    if ('tracker' in a) {
      if (a.tracker === null || a.tracker === 'github') delete next.tracker;
      else if (a.tracker === 'kaneo') next.tracker = 'kaneo';
      else throw this.bad(`tracker must be github or kaneo, got ${JSON.stringify(a.tracker)}`);
    }
    if ('kaneo' in a) {
      const k = a.kaneo;
      if (k === null) delete next.kaneo;
      else {
        if (!isObj(k) || typeof k.workspace_id !== 'string' || !k.workspace_id || typeof k.project_id !== 'string' || !k.project_id) throw this.bad('kaneo needs a workspace_id and a project_id');
        next.kaneo = { workspace_id: k.workspace_id, project_id: k.project_id };
      }
    }
    if (next.tracker === 'kaneo' && !next.kaneo) throw this.bad('a Kaneo floor needs its workspace and project: choose a project');
    const link = next.kaneo;
    const changed = link && (link.workspace_id !== cur.kaneo?.workspace_id || link.project_id !== cur.kaneo?.project_id || (next.tracker === 'kaneo' && cur.tracker !== 'kaneo'));
    if (link && changed) {
      this.saved();
      const p = PROJECTS.find((x) => x.id === link.project_id);
      if (!p) throw this.d.error('not_found', 'That Kaneo project is gone (deleted, or this key cannot see it): pick another.');
      if (p.workspace_id !== link.workspace_id) throw this.d.error('bad_request', 'That Kaneo project belongs to another workspace: pick the project again.');
      next.kaneo = { ...link, workspace_name: SIM_KANEO_WORKSPACES.find((w) => w.id === p.workspace_id)?.name ?? '', project_name: p.name };
    } else if (link && cur.kaneo) next.kaneo = { ...cur.kaneo };
    return next;
  }

  // ---- the board of a Kaneo floor ----------------------------------------------------------------------

  private projectOf(session: string): SimProject {
    const link = this.d.floors.get(session)?.settings?.kaneo;
    if (!link) throw this.d.error('unsupported', 'the floor has no board (no Kaneo project linked)');
    let p = this.projects.get(link.project_id);
    if (!p) {
      const proj = PROJECTS.find((x) => x.id === link.project_id);
      if (!proj) throw this.d.error('not_found', 'not found: project');
      p = seed(proj);
      this.projects.set(proj.id, p);
    }
    return p;
  }

  private message(session: string, initial: boolean): Obj {
    const p = this.projectOf(session);
    const rank = new Map(p.order.map((id, i) => [id, i]));
    const m: Obj = {
      t: 'board.issues',
      session,
      provider: 'kaneo',
      provider_name: 'Kaneo',
      initial,
      fetched_at: this.d.now(),
      stale: this.failing !== null,
      truncated: p.truncated,
      capabilities: { comment: true, close: false, set_status: true, order: true },
      columns: COLUMNS,
      cards: p.tasks.map((t) => ({ ...t.card, position: rank.get(t.card.id) ?? 0 })),
    };
    if (this.failing !== null) {
      m.error = this.failing === 'unauthorized' ? 'kaneo: 401 Unauthorized (the key may be out of its request quota)' : this.failing === 'forbidden' ? 'kaneo: 403 Forbidden' : this.failing;
      m.error_code = this.failing === 'unauthorized' || this.failing === 'forbidden' ? this.failing : 'provider_failed';
      if (this.failing === 'unauthorized' && this.paused) m.paused_until = this.paused.until;
    }
    return m;
  }

  private poll(session: string): void {
    const w = this.watching;
    if (!w || w.session !== session || !this.isKaneo(session)) return;
    w.send(this.message(session, false));
  }

  private queue(session: string, ms = 40): void {
    if (this.pending) return;
    this.pending = true;
    this.d.later(() => {
      this.pending = false;
      this.poll(session);
    }, ms);
  }

  private card(session: string, a: Obj): SimTask {
    const p = this.projectOf(session);
    const t = p.tasks.find((x) => x.card.id === a.id);
    if (!t) throw this.d.error('not_found', `not found: "${String(a.id)}"`);
    return t;
  }

  private board(t: string, a: Obj, send: Send, ack: (d?: unknown) => void): void {
    const session = a.session as string;
    if (!this.state) {
      if (t === 'board.watch') {
        this.watching = null;
        return ack({ enabled: false, reason: 'Kaneo is not connected: connect it in Settings' });
      }
      throw this.d.error('unsupported', 'the floor has no board (Kaneo is not connected: connect it in Settings)');
    }
    switch (t) {
      case 'board.watch':
        this.only(a, ['session']);
        this.watching = { session, send };
        ack({ enabled: true });
        send(this.message(session, true));
        return;
      case 'board.unwatch':
        if (this.watching?.session === session) this.watching = null;
        return ack();
      case 'board.refresh':
        if (this.paused && this.paused.until > this.d.now()) return ack({ queued: false });
        this.queue(session, 20);
        return ack({ queued: true });
      case 'issue.get': {
        const c = this.card(session, a);
        return ack({ card: c.card, body: c.body, author: { name: '' }, created_at: 0, comments: c.comments, comments_truncated: false });
      }
      case 'issue.comment': {
        const c = this.card(session, a);
        if (typeof a.body !== 'string' || !a.body.trim()) throw this.bad('body must be 1-65536 bytes of text');
        const made: BoardComment = { id: `kc-${c.comments.length + 2}-${this.d.now()}`, author: { name: 'Fixture User' }, body: a.body, created_at: this.d.now() };
        c.comments.push(made);
        this.queue(session);
        return ack({ comment: made });
      }
      case 'issue.close':
        throw this.d.error('unsupported', 'unsupported: Kaneo has no close: move the task to a final column');
      case 'issue.set_status': {
        const p = this.projectOf(session);
        const c = this.card(session, a);
        const col = a.column;
        if (typeof col !== 'string' || !COLUMNS.some((x) => x.id === col)) throw this.d.error('not_found', `not found: column "${String(col)}"`);
        if ('after' in a) {
          if (p.truncated) throw this.d.error('unsupported', 'unsupported: a card cannot be placed on a board the bridge did not read in full');
          if (this.staleNext) {
            this.staleNext = false;
            this.queue(session);
            throw this.d.error('stale', 'stale: the board changed since it was read (409)');
          }
          const rest = p.order.filter((x) => x !== c.card.id);
          const inCol = (x: string) => p.tasks.find((y) => y.card.id === x)?.card.column === col;
          let at: number;
          if (a.after === null) {
            const first = rest.findIndex(inCol);
            at = first < 0 ? 0 : first;
          } else {
            if (typeof a.after !== 'string' || !inCol(a.after)) throw this.bad('after is not another card of that column');
            at = rest.indexOf(a.after) + 1;
          }
          p.order = [...rest.slice(0, at), c.card.id, ...rest.slice(at)];
        }
        c.card.column = col;
        c.card.state = FINAL.has(col) ? 'closed' : 'open';
        this.queue(session);
        return ack();
      }
    }
  }

  private control(a: Obj, send: Send): Obj {
    if ('fail' in a) {
      this.failing = typeof a.fail === 'string' ? a.fail : null;
      if (this.failing === 'unauthorized' && this.state) {
        this.paused = { until: this.d.now() + COOLDOWN };
        this.publish(send);
      } else if (this.failing === null && this.paused) {
        this.paused = null;
        this.publish(send);
      }
    }
    if (a.stale === true) this.staleNext = true;
    const session = this.watching?.session;
    if (session && (a.poll === true || 'fail' in a)) this.queue(session, 10);
    return { watching: session ?? null, failing: this.failing };
  }

  /** A run's ticket of a Kaneo task (the bridge resolves it through the tracker); null: not a Kaneo item of the floor. */
  resolveWorkItem(session: string, wi: { provider?: unknown; id?: unknown }): { item: { provider: string; id: string; key: string; title: string; url: string }; body: string } | null {
    if (wi.provider !== 'kaneo' || typeof wi.id !== 'string' || !this.isKaneo(session) || !this.state) return null;
    let p: SimProject;
    try {
      p = this.projectOf(session);
    } catch {
      return null;
    }
    const t = p.tasks.find((x) => x.card.id === wi.id);
    if (!t) return null;
    return { item: { provider: 'kaneo', id: t.card.id, key: t.card.key, title: t.card.title, url: t.card.url ?? '' }, body: t.body };
  }
}
