// #247: repositories on other floors for the fixture server's `sim=1` (tools/fixture-sim.ts hands these commands
// over). Rules, like herdr-world's:
// - the snapshot's `repo_refs` is `{all_buildings}`, off by default; `repo_refs.set {all_buildings}` refuses a missing
//   one (`bad_request`); a change is a `repo_refs.update` with the switch flat in it; the ack is the switch.
// - `worker.repos {id}` lists the other floors with a stored `settings.repo` or `settings.default_cwd` (never the
//   suggestions): the worker's building's by index, then, with the switch on, the other buildings' by sort and the
//   unassigned lot by name. There is no disk here: a folder exists unless its path has a `missing` segment, and it is a
//   checkout of the floor's repo when its basename is the repo's name (ignoring case). A folder-only floor whose folder
//   is missing is left out.
// - `simrepos=<key>`: the connections with the same key share the switch (a change reaches all of them, as the
//   bridge's does), and each starts with demo-m5's floors set up for `@r:` (`seedRepos`): depot-manager's folder is a
//   checkout of its repo, pastry has only a folder, and scratchpad sits in the Personal building with a repo and no
//   folder. Without it the switch is the connection's own and the floors are as recorded.
// - #54 repository discovery, with `simrepos=<key>` only (without it the bridge is an older one: no `repo_discovery`
//   in the snapshot, `repo_discovery.*` unknown, rows without `id`/`source`). The key's connections share the roots,
//   the interval and the scans. There is no disk: `DISK` is what the bridge host has; a root finds the checkouts at
//   or under it, a root with a `missing` segment fails (stale when it was scanned before). `repo_discovery.set
//   {roots?, interval_minutes?}` checks like herdr-world (absolute, once each, 1–1440 minutes; `bad_request` with its
//   words), publishes, then scans: `scanning` at once, the result `SCAN_MS` later (a new `revision` when the
//   repositories changed). `repo_discovery.refresh` scans again. `worker.repos` merges like herdr-world: one row
//   per repository (a floor's repo or folder matched to a discovered checkout), the rest after, by name.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).

type Obj = Record<string, unknown>;
type Send = (m: Obj) => void;

interface FloorLike {
  session: string;
  building: string | null;
  index: number | null;
  settings?: { repo?: string; default_cwd?: string };
}

export interface ReposHost {
  /** The buildings in sort order, each with its floors in index order, and the unassigned lot by name. */
  layout(): { buildings: { id: string; name: string; floors: string[] }[]; unassigned: string[] };
  floor(session: string): FloorLike | undefined;
  /** The session of a worker, or undefined. */
  sessionOf(id: string): string | undefined;
  emit(send: Send, m: Obj): void;
  error(code: string, message: string): Error;
}

/** #54: a checkout on the simulated bridge host: its GitHub repo (none: local-only or another host) and repository. */
interface Checkout {
  path: string;
  repo?: string;
  /** The repository it is a worktree of (its main checkout's path); none: its own. */
  of?: string;
}

/** #54: what the simulated bridge host has under /home/dev/devel. */
export const DISK: readonly Checkout[] = [
  { path: '/home/dev/devel/fomra/depot-manager', repo: 'fomra/depot-manager' },
  { path: '/home/dev/devel/trees/depot-manager-fix', repo: 'fomra/depot-manager', of: '/home/dev/devel/fomra/depot-manager' },
  { path: '/home/dev/devel/JeffreyVdb/field-notes', repo: 'JeffreyVdb/field-notes' },
  { path: '/home/dev/devel/JeffreyVdb/herdr-3d', repo: 'JeffreyVdb/herdr-3d' },
  { path: '/home/dev/devel/scratch/api' },
  { path: '/home/dev/devel/work/api' },
  { path: '/home/dev/devel/notes' },
];
/** #54: how long a simulated scan takes. */
export const SCAN_MS = 300;

interface RootState {
  path: string;
  state: 'pending' | 'ok' | 'stale' | 'error';
  error?: string;
  found: Checkout[];
  last_success_at: number | null;
}

interface Discovery {
  roots: string[];
  interval: number;
  revision: number;
  scanning: boolean;
  lastScan: number | null;
  lastSuccess: number | null;
  states: Map<string, RootState>;
  timer: ReturnType<typeof setTimeout> | null;
  print: string;
}

/** The switch the connections of one `simrepos` key share, and who hears its changes. */
interface Shared {
  all: boolean;
  worlds: Set<(m: Obj) => void>;
  disc: Discovery;
}

const newDiscovery = (): Discovery => ({ roots: [], interval: 10, revision: 0, scanning: false, lastScan: null, lastSuccess: null, states: new Map(), timer: null, print: '[]' });

/** `p` as herdr-world keeps it (Go's `filepath.Clean` of an absolute path). */
function clean(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

const lower = (s: string) => s.toLowerCase();
/** A checkout's repository identity, as herdr-world's (`gh:` a GitHub repo, else `git:` its main checkout's .git). */
const idOf = (c: Checkout) => (c.repo ? `gh:${lower(c.repo)}` : `git:${c.of ?? c.path}/.git`);

interface Found {
  id: string;
  repo?: string;
  checkouts: Checkout[];
}

/** The discovered repositories: grouped, main checkouts first then by path; by name. */
function catalog(d: Discovery): Found[] {
  const by = new Map<string, Found>();
  const seen = new Set<string>();
  for (const r of d.roots) {
    for (const c of d.states.get(r)?.found ?? []) {
      if (seen.has(c.path)) continue;
      seen.add(c.path);
      const id = idOf(c);
      const g = by.get(id) ?? { id, ...(c.repo ? { repo: c.repo } : {}), checkouts: [] };
      g.checkouts.push(c);
      by.set(id, g);
    }
  }
  const name = (g: Found) => lower(g.repo?.split('/')[1] ?? base(g.checkouts[0]?.path ?? ''));
  for (const g of by.values()) g.checkouts.sort((a, b) => Number(!!a.of) - Number(!!b.of) || (a.path < b.path ? -1 : 1));
  return [...by.values()].sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : a.id < b.id ? -1 : 1));
}
const shared = new Map<string, Shared>();

/** demo-m5's floors set up for `@r:` (`simrepos`); a floor the fixture lacks is skipped. */
export function seedRepos(floors: Map<string, FloorLike>, buildings: { id: string; name: string }[]): void {
  const set = (s: string, settings: { repo?: string; default_cwd?: string }) => {
    const f = floors.get(s);
    if (f) f.settings = { ...(f.settings ?? {}), ...settings };
  };
  set('depot-manager', { default_cwd: '/home/dev/devel/fomra/depot-manager' });
  set('pastry', { default_cwd: '/home/dev/pastry' });
  const personal = buildings.find((b) => b.name === 'Personal');
  const scratch = floors.get('scratchpad');
  if (personal && scratch) {
    scratch.building = personal.id;
    scratch.index = 0;
    set('scratchpad', { repo: 'JeffreyVdb/field-notes' });
  }
}

const exists = (dir: string) => !dir.split('/').includes('missing');
function base(dir: string): string {
  return dir.replace(/\/+$/, '').split('/').pop() ?? '';
}

export class ReposSim {
  private own = false;
  private readonly group: Shared | null;
  private readonly hear: ((m: Obj) => void) | null = null;

  constructor(
    private readonly h: ReposHost,
    key: string | null,
    /** This world's own announce (its last connection's send), for a change another connection made. */
    announce?: (m: Obj) => void,
  ) {
    if (key === null) {
      this.group = null;
      return;
    }
    let g = shared.get(key);
    if (!g) shared.set(key, (g = { all: false, worlds: new Set(), disc: newDiscovery() }));
    this.group = g;
    if (announce) {
      this.hear = announce;
      g.worlds.add(announce);
    }
  }

  dispose(): void {
    if (this.group && this.hear) this.group.worlds.delete(this.hear);
    if (this.group && this.group.worlds.size === 0 && this.group.disc.timer) {
      clearTimeout(this.group.disc.timer);
      this.group.disc.timer = null;
      this.group.disc.scanning = false;
    }
  }

  private get all(): boolean {
    return this.group ? this.group.all : this.own;
  }

  view(): Obj {
    return { all_buildings: this.all };
  }

  decorate(world: Obj): void {
    world.repo_refs = this.view();
    if (this.group) world.repo_discovery = this.discoveryView(); // #54: only a keyed bridge scans
  }

  /** #54: the settings and the scans' status, as `repo_discovery` and `repo_discovery.update` carry it. */
  discoveryView(): Obj {
    const d = (this.group as Shared).disc;
    const roots = d.roots.map((path) => {
      const r = d.states.get(path) as RootState;
      return { path, state: r.state, ...(r.error ? { error: r.error } : {}), checkouts: r.found.length, last_success_at: r.last_success_at };
    });
    const cat = catalog(d);
    return {
      roots: [...d.roots],
      interval_minutes: d.interval,
      status: {
        state: d.roots.length === 0 ? 'off' : d.scanning ? 'scanning' : 'idle',
        revision: d.revision,
        repositories: cat.length,
        checkouts: cat.reduce((n, g) => n + g.checkouts.length, 0),
        last_scan_at: d.lastScan,
        last_success_at: d.lastSuccess,
        ...(d.lastScan !== null ? { last_duration_ms: SCAN_MS } : {}),
        ...(d.scanning ? { progress: { phase: 'walking', done: 0, total: d.roots.length } } : {}),
        roots,
      },
    };
  }

  /** #54: tells every connection of the key (this one through `send` when given, first). */
  private tellDiscovery(send: Send | null): void {
    const g = this.group as Shared;
    const m = { t: 'repo_discovery.update', ...this.discoveryView() };
    if (send) this.h.emit(send, m);
    for (const w of g.worlds) if (!send || w !== this.hear) w(m);
  }

  /** #54: a scan: `scanning` now, every root's result `SCAN_MS` later (a later change starts over). */
  private scan(): void {
    const g = this.group as Shared;
    const d = g.disc;
    if (d.timer) clearTimeout(d.timer);
    d.timer = null;
    if (d.roots.length === 0) {
      d.scanning = false;
      return;
    }
    d.scanning = true;
    d.timer = setTimeout(() => {
      d.timer = null;
      d.scanning = false;
      const now = Date.now();
      let failed = false;
      for (const path of d.roots) {
        const r = d.states.get(path) as RootState;
        if (!exists(path)) {
          failed = true;
          r.error = 'the folder does not exist on the bridge host';
          r.state = r.last_success_at === null ? 'error' : 'stale';
          continue;
        }
        r.found = DISK.filter((c) => c.path === path || c.path.startsWith(path === '/' ? '/' : `${path}/`));
        r.state = 'ok';
        delete r.error;
        r.last_success_at = now;
      }
      d.lastScan = now;
      if (!failed) d.lastSuccess = now;
      this.bump();
      this.tellDiscovery(null);
    }, SCAN_MS);
  }

  /** #54: a new revision when the discovered repositories changed. */
  private bump(): void {
    const d = (this.group as Shared).disc;
    const print = JSON.stringify(catalog(d));
    if (print !== d.print) {
      d.print = print;
      d.revision++;
    }
  }

  private discovery(t: string, a: Obj, send: Send, ack: (d?: unknown) => void): void {
    if (!this.group) throw this.h.error('unknown_command', `unknown command: ${t}`);
    const d = this.group.disc;
    if (t === 'repo_discovery.set') {
      const extra = Object.keys(a).filter((k) => k !== 'roots' && k !== 'interval_minutes');
      if (extra.length) throw this.h.error('bad_request', `bad args: unknown field "${extra[0]}"`);
      if (a.roots === undefined && a.interval_minutes === undefined) throw this.h.error('bad_request', 'roots or interval_minutes is required');
      const roots = a.roots === undefined ? d.roots : a.roots;
      const minutes = a.interval_minutes === undefined ? d.interval : a.interval_minutes;
      if (!Array.isArray(roots) || roots.some((r) => typeof r !== 'string')) throw this.h.error('bad_request', 'bad args: roots must be a list of strings');
      if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440)
        throw this.h.error('bad_request', 'The refresh interval must be a whole number of minutes from 1 to 1440.');
      const cleaned: string[] = [];
      (roots as string[]).forEach((r, i) => {
        if (!r.startsWith('/')) throw this.h.error('bad_request', `Scan folder ${i + 1} must be an absolute path on the bridge host, starting with /: "${r}" is not.`);
        const c = clean(r);
        const j = cleaned.indexOf(c);
        if (j >= 0) throw this.h.error('bad_request', `Scan folder ${i + 1} is the same as folder ${j + 1} (${c}).`);
        cleaned.push(c);
      });
      d.interval = minutes;
      if (JSON.stringify(cleaned) !== JSON.stringify(d.roots)) {
        d.roots = cleaned;
        const keep = new Map<string, RootState>();
        for (const r of cleaned) keep.set(r, d.states.get(r) ?? { path: r, state: 'pending', found: [], last_success_at: null });
        d.states = keep;
        this.bump(); // a removed root's repositories go at once
        this.scan();
      }
    } else {
      if (Object.keys(a).length) throw this.h.error('bad_request', `bad args: unknown field "${Object.keys(a)[0]}"`);
      if (t === 'repo_discovery.refresh') this.scan();
    }
    this.tellDiscovery(send);
    ack(this.discoveryView());
  }

  /** `worker.repos`'s rows for a worker of `session`. */
  repos(session: string): Obj[] {
    const { buildings, unassigned } = this.h.layout();
    const own = this.h.floor(session)?.building ?? null;
    const row = (s: string, building: string | null, same: boolean): Obj | null => {
      const st = this.h.floor(s)?.settings;
      const repo = st?.repo ?? '';
      const dir = st?.default_cwd ?? '';
      if (s === session || (!repo && !dir)) return null;
      if (!repo && !exists(dir)) return null;
      const cloned = !!repo && !!dir && exists(dir) && base(dir).toLowerCase() === (repo.split('/')[1] ?? '').toLowerCase();
      return { session: s, building, same_building: same, ...(repo ? { repo } : {}), ...(dir ? { dir } : {}), cloned };
    };
    const same: Obj[] = [];
    const other: Obj[] = [];
    for (const b of buildings) {
      for (const s of b.floors) {
        const mine = own !== null && b.id === own;
        if (!mine && !this.all) continue;
        const r = row(s, b.name, mine);
        if (r) (mine ? same : other).push(r);
      }
    }
    if (this.all) for (const s of unassigned) {
      const r = row(s, null, false);
      if (r) other.push(r);
    }
    const rows = [...same, ...other];
    return this.group ? this.merge(rows) : rows;
  }

  /** #54: herdr-world's merge: one row per repository, the floors' first (in their order), the rest of the scan after. */
  private merge(rows: Obj[]): Obj[] {
    const cat = catalog((this.group as Shared).disc);
    const byPath = (dir: string) => cat.find((g) => g.checkouts.some((c) => dir === c.path || dir.startsWith(`${c.path}/`)));
    const groups = new Map<string, Obj[]>();
    for (const r of rows) {
      const repo = r.repo as string | undefined;
      const dir = r.dir as string | undefined;
      const id = repo ? `gh:${lower(repo)}` : (byPath(dir ?? '')?.id ?? `dir:${clean(dir ?? '')}`);
      groups.set(id, [...(groups.get(id) ?? []), r]);
    }
    const out: Obj[] = [];
    for (const [id, fs] of groups) {
      const found = cat.find((g) => g.id === id);
      const win = fs.find((f) => !f.repo || f.cloned === true);
      const row: Obj = { id, source: 'floor', ...(win ?? fs[0]) };
      if (!row.repo) {
        const repo = fs.find((f) => f.repo)?.repo ?? found?.repo;
        if (repo) Object.assign(row, { repo, cloned: true });
      }
      if (!win && found) Object.assign(row, { dir: found.checkouts[0]?.path, cloned: !!row.repo });
      if (found) row.checkouts = found.checkouts.length;
      out.push(row);
    }
    for (const g of cat) {
      if (groups.has(g.id)) continue;
      out.push({ id: g.id, source: 'discovered', building: null, same_building: false, ...(g.repo ? { repo: g.repo } : {}), dir: g.checkouts[0]?.path, cloned: !!g.repo, checkouts: g.checkouts.length });
    }
    return out;
  }

  handle(t: unknown, a: Obj, send: Send, ack: (d?: unknown) => void): boolean {
    if (t === 'worker.repos') {
      const extra = Object.keys(a).filter((k) => k !== 'id');
      if (extra.length) throw this.h.error('bad_request', `bad args: unknown field "${extra[0]}"`);
      const session = typeof a.id === 'string' ? this.h.sessionOf(a.id) : undefined;
      if (session === undefined) throw this.h.error('unknown_worker', `unknown worker: "${String(a.id)}"`);
      ack({ repos: this.repos(session) });
      return true;
    }
    if (t === 'repo_discovery.get' || t === 'repo_discovery.set' || t === 'repo_discovery.refresh') {
      this.discovery(t, a, send, ack);
      return true;
    }
    if (t !== 'repo_refs.get' && t !== 'repo_refs.set') return false;
    if (t === 'repo_refs.set') {
      if (typeof a.all_buildings !== 'boolean') throw this.h.error('bad_request', 'bad args: all_buildings is required');
      if (a.all_buildings !== this.all) {
        const m = { t: 'repo_refs.update', all_buildings: a.all_buildings };
        if (this.group) {
          this.group.all = a.all_buildings;
          // Every connection of the key hears it, this one first (before its ack).
          this.h.emit(send, m);
          for (const w of this.group.worlds) if (w !== this.hear) w(m);
        } else {
          this.own = a.all_buildings;
          this.h.emit(send, m);
        }
      }
    }
    ack(this.view());
    return true;
  }
}
