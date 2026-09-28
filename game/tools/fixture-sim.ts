// In-memory simulation of the bridge's commands for the fixture server
// (opt-in: `?sim=1` on the WebSocket URL, or `--simulate`). It starts from a
// fixture's snapshot and answers like herdr-world would: building.create /
// rename / delete / reorder, floor.assign, floor.settings.set, and
// floor.wake / floor.sleep with a scripted transition (transition → state →
// per-worker resume → done, one step every `stepMs`). Events go out before
// the ack, with consecutive seqs. Nothing touches herdr or a database.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { Building, Floor, FloorSettings, HireOptions, Worker } from '../src/net/protocol.ts';

type Msg = Record<string, unknown>;
type Send = (m: Msg) => void;
type Obj = Record<string, unknown>;

export interface SimOptions {
  /** Time between the scripted steps of a wake or sleep. */
  stepMs?: number;
  /** `wake_failed` / `sleep_failed`: the next wake / sleep fails after its transition. */
  fail?: string | undefined;
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
}
