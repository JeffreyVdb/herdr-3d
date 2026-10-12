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

/** The switch the connections of one `simrepos` key share, and who hears its changes. */
interface Shared {
  all: boolean;
  worlds: Set<(m: Obj) => void>;
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
const base = (dir: string) => dir.replace(/\/+$/, '').split('/').pop() ?? '';

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
    if (!g) shared.set(key, (g = { all: false, worlds: new Set() }));
    this.group = g;
    if (announce) {
      this.hear = announce;
      g.worlds.add(announce);
    }
  }

  dispose(): void {
    if (this.group && this.hear) this.group.worlds.delete(this.hear);
  }

  private get all(): boolean {
    return this.group ? this.group.all : this.own;
  }

  view(): Obj {
    return { all_buildings: this.all };
  }

  decorate(world: Obj): void {
    world.repo_refs = this.view();
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
    return [...same, ...other];
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
