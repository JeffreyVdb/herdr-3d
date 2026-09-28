// In-memory simulation of the bridge's commands for the fixture server
// (opt-in: `?sim=1` on the WebSocket URL, or `--simulate`). It starts from a
// fixture's snapshot and answers like herdr-world would: building.create /
// rename / delete / reorder, floor.assign, floor.settings.set, and
// floor.wake / floor.sleep with a scripted transition (transition → state →
// per-worker resume → done, one step every `stepMs`). M4: hire.prepare,
// worker.hire, worker.fire.prepare and worker.fire (see "M4" below for the
// rules: which cwds are git repos, who has a dirty tree, the caps). Events go
// out before the ack, with consecutive seqs. Nothing touches herdr or a
// database.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { Building, Cap, Floor, FloorSettings, Hire, HireOptions, Worker } from '../src/net/protocol.ts';

type Msg = Record<string, unknown>;
type Send = (m: Msg) => void;
type Obj = Record<string, unknown>;

export interface SimOptions {
  /** Time between the scripted steps of a wake or sleep (and a hire, a send-home). */
  stepMs?: number;
  /**
   * `wake_failed` / `sleep_failed`: the next wake / sleep fails after its transition;
   * M4: `hire_failed` / `fire_failed` the next hire / send-home, `fetch_failed` the next prepare's `git fetch`.
   */
  fail?: string | undefined;
  /** M4: per-floor caps `{session: {soft, hard}}` (default 24 / 32); the host's are 60 / 80. */
  caps?: Record<string, { soft: number; hard: number }>;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

/** The M3 contract's lists (same as DEFAULT_HIRE_OPTIONS in src/world/store.ts). */
export const SIM_HIRE_OPTIONS: HireOptions = {
  claude: { models: ['claude-opus-5-5', 'claude-fable-5-1'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  codex: {
    models: ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    extra_efforts: { 'gpt-6-sol': ['ultra'], 'gpt-6-astra': ['ultra'] },
  },
};

/** M4: the caps a floor has unless `caps` says otherwise, and the host's. */
export const SIM_FLOOR_CAP = { soft: 24, hard: 32 };
export const SIM_HOST_CAP = { soft: 60, hard: 80 };
/** Names for new hires (the bridge's list starts like this). */
const SIM_NAMES = ['Gumdrop', 'Hopper', 'Inky', 'Jumble', 'Kazoo', 'Lentil', 'Mango', 'Nimbus', 'Orzo', 'Pompom', 'Quokka', 'Rumble', 'Sesame', 'Truffle', 'Udon', 'Vroom', 'Wasabi'];
/** What `git status --porcelain` says for a worker that is mid-task. */
const SIM_DIRTY = [' M game/src/app.ts', ' M game/src/ui/hud.ts', '?? notes/todo.md'];

class CmdError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const bad = (m: string) => new CmdError('bad_request', `bad args: ${m}`);

function onlyKeys(a: Obj, keys: string[]): void {
  for (const k of Object.keys(a)) if (!keys.includes(k)) throw bad(`json: unknown field "${k}"`);
}

function str(a: Obj, k: string): string {
  const v = a[k];
  if (typeof v !== 'string') throw bad(`${k} must be a string`);
  return v;
}

function cleanName(v: string): string {
  const n = v.trim();
  if (!n || bytes(n) > 64) throw new CmdError('bad_request', 'invalid argument: building name must be 1-64 bytes');
  return n;
}

export class SimWorld {
  seq: number;
  private readonly buildings = new Map<string, Omit<Building, 'floors'>>();
  private readonly floors = new Map<string, Floor>();
  private readonly workers: Worker[];
  private readonly hire: HireOptions;
  private readonly hireSent: boolean;
  /** Worker statuses from before a sleep, restored on wake. */
  private readonly beforeSleep = new Map<string, string>();
  private readonly timers = new Set<unknown>();
  private readonly stepMs: number;
  private fail: string | undefined;
  private nextId = 0;
  /** M4: desks a hire in flight reserved, per floor (`session:desk`). */
  private readonly hiring = new Set<string>();
  /** M4: workers being sent home right now. */
  private readonly leaving = new Set<string>();
  /** M4: the last harness/model/effort hired per floor. */
  private readonly lastHire = new Map<string, Hire>();
  private readonly caps: Record<string, { soft: number; hard: number }>;
  private readonly now: () => number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (h: unknown) => void;

  constructor(snapshot: { seq: number; world: Obj }, o: SimOptions = {}) {
    const w = structuredClone(snapshot.world) as { buildings: Building[]; floors: Floor[]; workers: Worker[]; hire_options?: HireOptions };
    this.seq = snapshot.seq;
    for (const b of w.buildings) this.buildings.set(b.id, { id: b.id, name: b.name, sort: b.sort });
    for (const f of w.floors) this.floors.set(f.session, f);
    this.workers = w.workers;
    this.hire = w.hire_options ?? SIM_HIRE_OPTIONS;
    this.hireSent = w.hire_options !== undefined;
    this.stepMs = o.stepMs ?? 600;
    this.fail = o.fail;
    this.caps = o.caps ?? {};
    this.now = o.now ?? (() => Date.now());
    this.setT = o.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = o.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  dispose(): void {
    for (const t of this.timers) this.clearT(t);
    this.timers.clear();
  }

  // ---- world ---------------------------------------------------------------

  private floorsOf(id: string): string[] {
    return [...this.floors.values()]
      .filter((f) => f.building === id)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((f) => f.session);
  }

  private building(id: string): Building {
    const b = this.buildings.get(id);
    if (!b) throw new CmdError('not_found', `not found: building "${id}"`);
    return { ...b, floors: this.floorsOf(id) };
  }

  private sorted(): Building[] {
    return [...this.buildings.values()].sort((a, b) => a.sort - b.sort).map((b) => this.building(b.id));
  }

  snapshot(): Msg {
    const buildings = this.sorted();
    const unassigned = [...this.floors.values()].filter((f) => f.building === null).map((f) => f.session).sort();
    const order = [...buildings.flatMap((b) => b.floors), ...unassigned];
    const floors = order.map((s) => this.floors.get(s) as Floor);
    const workers = order.flatMap((s) => this.workers.filter((w) => w.session === s));
    const world: Obj = { buildings, unassigned, floors, workers };
    if (this.hireSent) world.hire_options = this.hire;
    return { t: 'world.snapshot', seq: this.seq, world: structuredClone(world) };
  }

  private emit(send: Send, m: Msg): void {
    send({ ...structuredClone(m), seq: ++this.seq });
  }

  private floorEvent(send: Send, f: Floor): void {
    this.emit(send, { t: 'floor.upsert', floor: f });
  }

  private floor(a: Obj): Floor {
    const s = str(a, 'session');
    const f = this.floors.get(s);
    if (!f) throw new CmdError('unknown_session', `unknown session: "${s}"`);
    return f;
  }

  // ---- commands ------------------------------------------------------------

  /** Answers one client message (after the hello). */
  handle(m: Obj, send: Send): void {
    const reqId = m.req_id;
    if (typeof reqId !== 'string' || !reqId) {
      send({ t: 'error', code: 'bad_request', message: 'missing req_id' });
      return;
    }
    const ack = (data?: unknown) => send(data === undefined ? { t: 'ack', req_id: reqId } : { t: 'ack', req_id: reqId, data });
    const fail = (e: unknown) => {
      const err = e instanceof CmdError ? e : new CmdError('internal', String(e));
      send({ t: 'error', req_id: reqId, code: err.code, message: err.message });
    };
    try {
      const a = m.args === undefined || m.args === null ? {} : m.args;
      if (!isObj(a)) throw bad('args must be an object');
      switch (m.t) {
        case 'building.create':
          return ack(this.create(a, send));
        case 'building.rename':
          return ack(this.rename(a, send));
        case 'building.delete':
          return ack(this.remove(a, send));
        case 'building.reorder':
          return ack(this.reorder(a, send));
        case 'floor.assign':
          return ack(this.assign(a, send));
        case 'floor.settings.set':
          return ack(this.settings(a, send));
        case 'floor.wake':
          return this.wake(a, send, ack, fail);
        case 'floor.sleep':
          return this.sleep(a, send, ack, fail);
        case 'hire.prepare':
          return ack(this.hirePrepare(a));
        case 'worker.hire':
          return this.hireWorker(a, send, ack, fail);
        case 'worker.fire.prepare':
          return ack(this.firePrepare(a));
        case 'worker.fire':
          return this.fireWorker(a, send, ack, fail);
      }
      throw new CmdError('unknown_command', `unknown command: "${String(m.t)}"`);
    } catch (e) {
      fail(e);
    }
  }

  private taken(name: string, except = ''): void {
    for (const b of this.buildings.values()) {
      if (b.id !== except && b.name.toLowerCase() === name.toLowerCase()) throw new CmdError('name_taken', `name already used: "${name}"`);
    }
  }

  private create(a: Obj, send: Send): { id: string } {
    onlyKeys(a, ['name']);
    const name = cleanName(str(a, 'name'));
    this.taken(name);
    const id = `b_sim${(++this.nextId).toString(16).padStart(9, '0')}`;
    const sort = Math.max(-1, ...[...this.buildings.values()].map((b) => b.sort)) + 1;
    this.buildings.set(id, { id, name, sort });
    this.emit(send, { t: 'building.upsert', building: this.building(id) });
    return { id };
  }

  private rename(a: Obj, send: Send): undefined {
    onlyKeys(a, ['id', 'name']);
    const id = str(a, 'id');
    const b = this.building(id);
    const name = cleanName(str(a, 'name'));
    this.taken(name, id);
    this.buildings.set(id, { id, name, sort: b.sort });
    this.emit(send, { t: 'building.upsert', building: this.building(id) });
    return undefined;
  }

  private remove(a: Obj, send: Send): undefined {
    onlyKeys(a, ['id']);
    const id = str(a, 'id');
    const b = this.building(id);
    for (const s of b.floors) {
      const f = this.floors.get(s) as Floor;
      f.building = null;
      f.index = null;
      this.floorEvent(send, f);
    }
    this.buildings.delete(id);
    this.resort(
      [...this.buildings.values()].sort((x, y) => x.sort - y.sort).map((x) => x.id),
      send,
    );
    this.emit(send, { t: 'building.removed', id });
    return undefined;
  }

  private resort(ids: string[], send: Send): void {
    ids.forEach((id, i) => {
      const b = this.buildings.get(id);
      if (!b || b.sort === i) return;
      b.sort = i;
      this.emit(send, { t: 'building.upsert', building: this.building(id) });
    });
  }

  private reorder(a: Obj, send: Send): undefined {
    onlyKeys(a, ['ids']);
    const ids = a.ids;
    const n = this.buildings.size;
    if (!Array.isArray(ids) || ids.length !== n || new Set(ids).size !== n || !ids.every((x) => typeof x === 'string' && this.buildings.has(x))) {
      throw new CmdError('bad_request', `invalid argument: ids must list each of the ${n} buildings exactly once`);
    }
    this.resort(ids as string[], send);
    return undefined;
  }

  private assign(a: Obj, send: Send): undefined {
    onlyKeys(a, ['session', 'building', 'index']);
    const f = this.floor(a);
    const to = a.building;
    if (to !== null && typeof to !== 'string') throw bad('building must be a string or null');
    if (a.index !== undefined && (typeof a.index !== 'number' || !Number.isInteger(a.index))) throw bad('index must be an int');
    if (to !== null) this.building(to);
    if (f.transition) throw new CmdError('busy', `busy: ${f.session} is ${f.transition}`);
    const from = f.building;
    const before = new Map([...this.floors.values()].map((x) => [x.session, `${x.building}:${x.index}`]));
    const reindex = (id: string, list: string[]) =>
      list.forEach((s, i) => {
        const x = this.floors.get(s) as Floor;
        x.building = id;
        x.index = i;
      });
    if (from !== null) reindex(from, this.floorsOf(from).filter((s) => s !== f.session));
    f.building = null;
    f.index = null;
    if (to !== null) {
      const list = this.floorsOf(to);
      let i = typeof a.index === 'number' ? a.index : list.length;
      if (i < 0 || i > list.length) i = list.length;
      list.splice(i, 0, f.session);
      reindex(to, list);
    }
    for (const x of this.floors.values()) if (before.get(x.session) !== `${x.building}:${x.index}`) this.floorEvent(send, x);
    for (const id of new Set([from, to])) if (id !== null && this.buildings.has(id)) this.emit(send, { t: 'building.upsert', building: this.building(id) });
    return undefined;
  }

  private checkSettings(a: Obj): void {
    onlyKeys(a, ['session', 'repo', 'project', 'status_field', 'default_cwd', 'default_hire']);
    const repo = a.repo;
    if (repo !== undefined && repo !== null && (typeof repo !== 'string' || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo))) {
      throw bad('repo must be owner/repo');
    }
    const p = a.project;
    if (p !== undefined && p !== null) {
      if (!isObj(p) || typeof p.owner !== 'string' || !p.owner || typeof p.number !== 'number' || !Number.isInteger(p.number) || p.number < 1) {
        throw bad('project must be {owner, number >= 1}');
      }
      onlyKeys(p, ['owner', 'number']);
    }
    const sf = a.status_field;
    if (sf !== undefined && sf !== null) {
      // Like the bridge's validLabel: not blank, at most 64 bytes, stored as sent.
      const label = (s: unknown) => typeof s === 'string' && s.trim() !== '' && bytes(s) <= 64;
      const ok =
        isObj(sf) &&
        label(sf.name) &&
        Array.isArray(sf.options) &&
        sf.options.length >= 1 &&
        sf.options.length <= 20 &&
        sf.options.every(label) &&
        new Set(sf.options).size === sf.options.length;
      if (!ok) throw bad('status_field must be {name, options: 1-20 unique names}');
    }
    const cwd = a.default_cwd;
    if (cwd !== undefined && cwd !== null) {
      if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw bad('default_cwd must be an absolute path');
      // Stands in for the bridge's os.Stat check.
      if (cwd.includes('missing')) throw bad(`default_cwd ${cwd}: no such directory`);
    }
    const h = a.default_hire;
    if (h !== undefined && h !== null) {
      if (!isObj(h) || typeof h.harness !== 'string' || typeof h.model !== 'string' || typeof h.effort !== 'string') throw bad('default_hire must be {harness, model, effort}');
      const o = this.hire[h.harness];
      if (!o) throw bad(`default_hire: unknown harness ${h.harness}`);
      if (!o.models.includes(h.model)) throw bad(`default_hire: ${h.harness} has no model ${h.model}`);
      if (![...o.efforts, ...(o.extra_efforts?.[h.model] ?? [])].includes(h.effort)) throw bad(`default_hire: ${h.model} has no effort ${h.effort}`);
    }
  }

  private settings(a: Obj, send: Send): undefined {
    const f = this.floor(a);
    this.checkSettings(a);
    if (f.transition) throw new CmdError('busy', `busy: ${f.session} is ${f.transition}`);
    const s: FloorSettings = { ...(f.settings ?? {}) };
    const set = s as Record<string, unknown>;
    for (const k of ['repo', 'project', 'status_field', 'default_cwd', 'default_hire'] as const) {
      if (!(k in a)) continue;
      if (a[k] === null) delete set[k];
      else set[k] = a[k];
    }
    if (Object.keys(s).length) f.settings = s;
    else delete f.settings;
    this.floorEvent(send, f);
    return undefined;
  }

  private later(steps: Array<() => void>): void {
    let i = 0;
    const next = () => {
      const step = steps[i++];
      if (!step) return;
      const h = this.setT(() => {
        this.timers.delete(h);
        step();
        next();
      }, this.stepMs);
      this.timers.add(h);
    };
    next();
  }

  private upsertWorker(send: Send, w: Worker): void {
    this.emit(send, { t: 'worker.upsert', worker: w });
  }

  private wake(a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): void {
    onlyKeys(a, ['session']);
    const f = this.floor(a);
    if (f.transition) throw new CmdError('busy', `busy: ${f.session} is ${f.transition}`);
    if (f.state === 'running') throw new CmdError('invalid_state', `invalid state: ${f.session} is running`);
    f.transition = 'waking';
    this.floorEvent(send, f);
    const ws = this.workers.filter((w) => w.session === f.session);
    if (this.fail === 'wake_failed') {
      this.fail = undefined;
      this.later([
        () => {
          delete f.transition;
          this.floorEvent(send, f);
          fail(new CmdError('wake_failed', `herdr server for ${f.session} did not answer ping within 10s (simulated)`));
        },
      ]);
      return;
    }
    const resumable = ws.filter((w) => w.agent_session);
    const steps: Array<() => void> = [
      () => {
        f.state = 'running';
        this.floorEvent(send, f);
        ws.forEach((w, i) => {
          w.status = this.beforeSleep.get(w.id) ?? (i % 3 === 0 ? 'working' : 'idle');
          this.beforeSleep.delete(w.id);
          if (w.agent_session) w.resume = 'pending';
          this.upsertWorker(send, w);
        });
      },
      ...resumable.map((w, i) => () => {
        // Every third agent needs the bridge's fallback re-launch.
        w.resume = i % 3 === 2 ? 'fallback' : 'confirmed';
        this.upsertWorker(send, w);
      }),
      () => {
        delete f.transition;
        this.floorEvent(send, f);
        ack({ workers: ws.map((w) => ({ id: w.id, resume: w.resume ?? 'none' })) });
      },
    ];
    this.later(steps);
  }

  private sleep(a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): void {
    onlyKeys(a, ['session']);
    const f = this.floor(a);
    if (f.transition) throw new CmdError('busy', `busy: ${f.session} is ${f.transition}`);
    if (f.state === 'asleep') throw new CmdError('invalid_state', `invalid state: ${f.session} is asleep`);
    f.transition = 'sleeping';
    this.floorEvent(send, f);
    if (this.fail === 'sleep_failed') {
      this.fail = undefined;
      this.later([
        () => {
          delete f.transition;
          this.floorEvent(send, f);
          fail(new CmdError('sleep_failed', `herdr session stop ${f.session}: exit status 1 (simulated)`));
        },
      ]);
      return;
    }
    this.later([
      () => {
        f.state = 'asleep';
        delete f.transition;
        this.floorEvent(send, f);
        for (const w of this.workers) {
          if (w.session !== f.session) continue;
          this.beforeSleep.set(w.id, w.status);
          w.status = 'unknown';
          delete w.resume;
          delete w.title;
          this.upsertWorker(send, w);
        }
        ack();
      },
    ]);
  }

  // ---- M4: hire and send home ------------------------------------------------
  //
  // Rules of the simulation: a cwd is a git repo unless it has `/scratch` in
  // it (its repo root: the path before `-wt/…`); `offline` in it (or
  // `simfail=fetch_failed`) makes the fetch fail. A worker that is `working`
  // has uncommitted changes and 2 unpushed commits, a `blocked` one 1
  // unpushed commit, everyone else is clean. Caps: `caps`, else 24 / 32 per
  // floor, 60 / 80 for the host (running floors' workers).

  private floorCap(f: Floor): Cap {
    const c = this.caps[f.session] ?? SIM_FLOOR_CAP;
    const inFlight = [...this.hiring].filter((k) => k.startsWith(`${f.session}:`)).length;
    return { count: this.workers.filter((w) => w.session === f.session).length + inFlight, soft: c.soft, hard: c.hard };
  }

  private hostCap(): Cap {
    const running = new Set([...this.floors.values()].filter((f) => f.state === 'running').map((f) => f.session));
    return { count: this.workers.filter((w) => running.has(w.session)).length + this.hiring.size, ...SIM_HOST_CAP };
  }

  private runningFloor(a: Obj): Floor {
    const f = this.floor(a);
    if (f.state !== 'running') throw new CmdError('invalid_state', `invalid state: ${f.session} is asleep`);
    if (f.transition) throw new CmdError('busy', `busy: ${f.session} is ${f.transition}`);
    return f;
  }

  private defaultCwd(f: Floor): string {
    return f.settings?.default_cwd ?? f.suggested?.default_cwd ?? this.rootOf(this.workers.find((w) => w.session === f.session && w.cwd)) ?? '/home/dev';
  }

  /** A worker's repo root checkout (its cwd outside a worktree). */
  private rootOf(w: Worker | undefined): string | undefined {
    return w?.worktree?.repo_root ?? w?.cwd;
  }

  private git(cwd: string, fetch: boolean): Obj | null {
    if (cwd.includes('/scratch')) return null;
    const root = cwd.replace(/-wt\/[^/]+$/, '');
    let h = 0;
    for (const c of root) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
    const g: Obj = {
      repo_root: root,
      default_branch: 'main',
      base_sha: (h.toString(16).padStart(8, '0') + 'c0ffee1d15ea5e0b5e55ed0ddba11cafe0').slice(0, 40),
      base_time: this.now() - (3 * 60 + 12) * 60_000,
      fetched: true,
    };
    const failed = fetch && (cwd.includes('offline') || this.fail === 'fetch_failed');
    if (failed) {
      if (this.fail === 'fetch_failed') this.fail = undefined;
      g.fetched = false;
      g.fetch_error = 'ssh: Could not resolve hostname github.com (simulated)';
    }
    return g;
  }

  private nextName(session: string): string {
    const taken = new Set(this.workers.filter((w) => w.session === session).map((w) => w.name));
    for (let k = 1; ; k++) {
      for (const n of SIM_NAMES) {
        const name = k === 1 ? n : `${n} ${k}`;
        if (!taken.has(name)) return name;
      }
    }
  }

  private choice(f: Floor): { choice: Hire | null; choice_source: string } {
    const d = f.settings?.default_hire;
    if (d) return { choice: d, choice_source: 'floor_default' };
    const last = this.lastHire.get(f.session);
    return last ? { choice: last, choice_source: 'last' } : { choice: null, choice_source: 'none' };
  }

  private hirePrepare(a: Obj): Obj {
    onlyKeys(a, ['session', 'cwd']);
    const f = this.runningFloor(a);
    if (a.cwd !== undefined && (typeof a.cwd !== 'string' || !a.cwd.startsWith('/'))) throw bad('cwd must be an absolute path');
    const cwd = (a.cwd as string | undefined) ?? this.defaultCwd(f);
    return {
      cwd,
      ...this.choice(f),
      label: this.nextName(f.session),
      git: this.git(cwd, true),
      capacity: { floor: this.floorCap(f), host: this.hostCap(), load: { load1: 2.36, cpus: 16, mem_used_pct: 41.4 } },
    };
  }

  /** Desks the bridge renders for a floor: `max(highest + 1, min(96, max(6, workers + 2)))`. */
  private desksFor(session: string): number {
    const ws = this.workers.filter((w) => w.session === session);
    const top = Math.max(-1, ...ws.map((w) => w.desk_index ?? -1));
    return Math.max(top + 1, Math.min(96, Math.max(6, ws.length + 2)));
  }

  /** The floor's desks after a hire or a send-home; a floor.upsert when that changes them. */
  private resize(send: Send, f: Floor): void {
    const next = this.desksFor(f.session);
    if (next === f.desks) return;
    f.desks = next;
    this.floorEvent(send, f);
  }

  private hireWorker(a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): void {
    onlyKeys(a, ['session', 'desk_index', 'harness', 'model', 'effort', 'label', 'cwd', 'worktree', 'prompt']);
    const f = this.runningFloor(a);
    const desk = a.desk_index;
    if (typeof desk !== 'number' || !Number.isInteger(desk) || desk < 0) throw bad('desk_index must be an int >= 0');
    const harness = str(a, 'harness');
    const model = str(a, 'model');
    const effort = str(a, 'effort');
    const o = this.hire[harness];
    if (!o) throw bad(`unknown harness ${harness}`);
    if (!o.models.includes(model)) throw bad(`${harness} has no model ${model}`);
    if (![...o.efforts, ...(o.extra_efforts?.[model] ?? [])].includes(effort)) throw bad(`${model} has no effort ${effort}`);
    for (const k of ['label', 'cwd', 'prompt']) if (a[k] !== undefined && typeof a[k] !== 'string') throw bad(`${k} must be a string`);
    if (typeof a.label === 'string' && (!a.label.trim() || bytes(a.label) > 64 || a.label.startsWith('-'))) throw bad('label must be 1-64 bytes, not starting with -');
    if (typeof a.prompt === 'string' && a.prompt.startsWith('--')) throw bad('prompt must not start with --');
    if (a.worktree !== undefined && typeof a.worktree !== 'boolean') throw bad('worktree must be a bool');
    const cwd = (a.cwd as string | undefined) ?? this.defaultCwd(f);
    if (!cwd.startsWith('/')) throw bad('cwd must be an absolute path');
    const git = this.git(cwd, false);
    if (a.worktree === true && !git) throw bad(`worktree: ${cwd} is not a git repository`);
    if (desk >= (f.desks ?? 0) || this.hiring.has(`${f.session}:${desk}`) || this.workers.some((w) => w.session === f.session && w.desk_index === desk)) {
      throw new CmdError('desk_taken', `desk_taken: desk ${desk} of ${f.session} is ${desk >= (f.desks ?? 0) ? 'out of range' : 'occupied'}`);
    }
    const cap = this.floorCap(f);
    if (cap.count >= cap.hard) throw new CmdError('capacity', `capacity: ${f.session} has ${cap.count} workers (hard cap ${cap.hard})`);
    const host = this.hostCap();
    if (host.count >= host.hard) throw new CmdError('capacity', `capacity: the host has ${host.count} workers (hard cap ${host.hard})`);
    if (this.fail === 'hire_failed') {
      this.fail = undefined;
      this.later([() => fail(new CmdError('hire_failed', 'hire_failed: herdr agent start: claude exited during startup (simulated)'))]);
      return;
    }
    const name = this.nextName(f.session);
    const label = (a.label as string | undefined)?.trim() || name;
    const n = ++this.nextId;
    const id = `${(0x5173a4 + n).toString(16)}e0-0000-4000-a000-${n.toString(16).padStart(12, '0')}`;
    const ws = `wh${n.toString(36)}`;
    // Like the bridge: h3d/<name>-<first 6 hex of the id>.
    const branch = a.worktree === true ? `h3d/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id.replace(/-/g, '').slice(0, 6)}` : undefined;
    const root = git ? (git.repo_root as string) : undefined;
    const checkout = branch && root ? `${root}-wt/${branch.slice(4)}` : cwd;
    const now = this.now();
    const w: Worker = {
      id,
      session: f.session,
      workspace_id: ws,
      label,
      cwd: checkout,
      pane_id: `${ws}:p1`,
      pane_label: `h3d-${id.slice(-8)}`,
      agent_kind: harness,
      status: 'idle',
      name,
      desk_index: desk,
      harness,
      model,
      effort,
      status_since: now,
      hired_at: now,
    };
    if (branch && root) {
      w.branch = branch;
      w.worktree = { repo_root: root, repo_name: root.split('/').pop() ?? root, checkout_path: checkout, linked: true };
    } else if (root) {
      w.worktree = { repo_root: root, repo_name: root.split('/').pop() ?? root, checkout_path: cwd, linked: false };
    }
    const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : '';
    this.lastHire.set(f.session, { harness, model, effort });
    const held = `${f.session}:${desk}`;
    this.hiring.add(held);
    // Worktree, agent start and trust take a step; then the first task starts it working.
    this.later([
      () => {
        this.hiring.delete(held);
        this.workers.push(w);
        this.resize(send, f);
        this.upsertWorker(send, w);
        const data: Obj = { id, workspace_id: ws, trust: 'approved' };
        if (prompt) data.prompted = true;
        if (branch) {
          data.branch = branch;
          data.base_sha = git?.base_sha;
        }
        ack(data);
      },
      ...(prompt
        ? [
            () => {
              if (!this.workers.includes(w)) return;
              const prev = w.status;
              w.status = 'working';
              w.title = prompt.split('\n')[0]?.slice(0, 80) ?? '';
              w.status_since = this.now();
              this.emit(send, { t: 'worker.status', id, session: w.session, workspace_id: ws, status: 'working', prev_status: prev, status_since: w.status_since, title: w.title });
            },
          ]
        : []),
    ]);
  }

  private worker(a: Obj): Worker {
    const id = str(a, 'id');
    const w = this.workers.find((x) => x.id === id);
    if (!w) throw new CmdError('unknown_worker', `unknown worker: "${id}"`);
    return w;
  }

  private tree(w: Worker): { dirty: string[]; unpushed: number } {
    if (w.status === 'working') return { dirty: SIM_DIRTY, unpushed: 2 };
    if (w.status === 'blocked') return { dirty: [], unpushed: 1 };
    return { dirty: [], unpushed: 0 };
  }

  private firePrepare(a: Obj): Obj {
    onlyKeys(a, ['id']);
    const w = this.worker(a);
    const t = this.tree(w);
    const wt = w.worktree;
    const linked = !!wt?.linked;
    const clean = !t.dirty.length && !t.unpushed;
    // herdr will not close a repo's main checkout while its linked worktrees are open on the floor.
    const open = wt && !linked ? this.workers.filter((x) => x !== w && x.session === w.session && x.worktree?.linked && x.worktree.repo_root === wt.repo_root) : [];
    const out: Obj = {
      name: w.name ?? w.label,
      label: w.label,
      worktree: wt ? { path: wt.checkout_path, linked } : null,
      dirty: t.dirty,
      unpushed: t.unpushed,
      can_delete: linked && clean,
      can_fire: open.length === 0,
    };
    if (open.length) out.fire_blocked = `it is ${wt?.repo_name ?? 'the repo'}’s main checkout and ${open.length} of its worktrees are still open here (${open.map((x) => x.name).join(', ')}): send them home first`;
    if (w.branch) out.branch = w.branch;
    if (!linked) out.reason = wt ? 'it works in the repo’s main checkout, not a worktree of its own' : 'it is not in a git worktree';
    else if (!clean) out.reason = [t.dirty.length ? 'the worktree has uncommitted changes' : '', t.unpushed ? `${t.unpushed} ${t.unpushed === 1 ? 'commit is' : 'commits are'} not on any remote` : ''].filter(Boolean).join(' and ');
    return out;
  }

  private fireWorker(a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): void {
    onlyKeys(a, ['id', 'worktree']);
    const w = this.worker(a);
    const choice = a.worktree ?? 'keep';
    if (choice !== 'keep' && choice !== 'delete' && choice !== 'delete_branch') throw bad('worktree must be keep, delete or delete_branch');
    const f = this.floors.get(w.session);
    if (f?.transition) throw new CmdError('busy', `busy: ${f.session} is ${f.transition}`);
    if (this.leaving.has(w.id)) throw new CmdError('busy', `busy: ${w.name ?? w.id} is already being sent home`);
    const p = this.firePrepare({ id: w.id });
    if (choice !== 'keep') {
      if (!w.worktree?.linked) throw bad('worktree: the worker is not in a linked worktree');
      if (choice === 'delete_branch' && !w.branch?.startsWith('h3d/')) throw bad('worktree: delete_branch only deletes h3d/ branches');
      if (!p.can_delete) throw new CmdError('not_clean', `not_clean: ${String(p.reason)}`);
    }
    if (p.can_fire === false) throw new CmdError('fire_failed', `fire_failed: ${String(p.fire_blocked)}`);
    if (this.fail === 'fire_failed') {
      this.fail = undefined;
      this.later([() => fail(new CmdError('fire_failed', 'fire_failed: the agent did not exit after /exit within 10s (simulated)'))]);
      return;
    }
    // /exit, the agent released, workspace close (and worktree remove): one step. The desk count follows the removal.
    this.leaving.add(w.id);
    this.later([
      () => {
        this.leaving.delete(w.id);
        const i = this.workers.indexOf(w);
        if (i < 0) return fail(new CmdError('unknown_worker', `unknown worker: "${w.id}"`));
        this.workers.splice(i, 1);
        this.emit(send, { t: 'worker.removed', id: w.id, session: w.session, workspace_id: w.workspace_id, reason: 'sent_home' });
        if (f) this.resize(send, f);
        ack({ worktree: choice === 'keep' ? 'kept' : choice === 'delete' ? 'deleted' : 'deleted_branch', released: true });
      },
    ]);
  }
}
