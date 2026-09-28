/**
 * herdr-world protocol v1 (docs/protocol.md), as the game consumes it.
 *
 * Fields marked "M2" / "M3" are additive and may be missing when talking to an
 * older bridge; the world store supplies fallbacks for every one of them.
 * Unknown fields and unknown message types are ignored.
 */

export const PROTO = 1;

export type WorkerStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface Building {
  id: string;
  name: string;
  sort: number;
  /** Sessions in this building, top floor first (bridge-derived). */
  floors: string[];
}

export interface Floor {
  session: string;
  state: string; // running | asleep
  default?: boolean;
  building: string | null;
  index: number | null;
  error?: string;
  /** M2: desks the floor renders. */
  desks?: number;
  /** M3: a wake or sleep is in progress. */
  transition?: FloorTransition;
  /** M3: stored floor settings, only the keys that are set. */
  settings?: FloorSettings;
  /** M3: bridge-derived defaults (effective value = `settings.X ?? suggested.X`). */
  suggested?: FloorSuggested;
}

export type FloorTransition = 'waking' | 'sleeping';

export interface GithubProject {
  owner: string;
  number: number;
}

export interface StatusField {
  name: string;
  options: string[];
}

export interface Hire {
  harness: string;
  model: string;
  effort: string;
}

export interface FloorSettings {
  /** `owner/repo` on GitHub. */
  repo?: string;
  project?: GithubProject;
  status_field?: StatusField;
  /** Absolute directory on the bridge host. */
  default_cwd?: string;
  default_hire?: Hire;
}

export interface FloorSuggested {
  repo?: string;
  default_cwd?: string;
}

export interface HarnessOptions {
  models: string[];
  efforts: string[];
  /** Extra efforts only some models take (codex: `ultra` for sol/astra). */
  extra_efforts?: Record<string, string[]>;
}

/** M3: models and efforts `default_hire` may use, per harness. */
export type HireOptions = Record<string, HarnessOptions>;

/** M3: a worker's resume after a wake. */
export type ResumeState = 'pending' | 'confirmed' | 'fallback' | 'failed';

export interface Worktree {
  repo_root: string;
  repo_name?: string;
  checkout_path: string;
  linked: boolean;
}

export interface Worker {
  id: string;
  session: string;
  workspace_id: string;
  label: string;
  cwd?: string;
  pane_id?: string;
  pane_label?: string;
  agent_kind?: string;
  agent_name?: string;
  agent_session?: string;
  status: string;
  title?: string;
  tokens?: Record<string, string>;
  worktree?: Worktree;
  role?: string;
  run?: string;
  /** M2: cute display name, unique per floor. */
  name?: string;
  /** M2: persistent desk slot on its floor. */
  desk_index?: number;
  /** M2: claude | codex | other. */
  harness?: string;
  /** M2: e.g. claude-opus-5-5, gpt-6-sol. */
  model?: string;
  /** M2: reasoning effort. */
  effort?: string;
  /** M2: unix ms (bridge clock) when `status` last changed. */
  status_since?: number;
  /** M3: resume progress during and after a wake. */
  resume?: ResumeState;
  /** M4: unix ms (bridge clock) when the bridge hired this worker. */
  hired_at?: number;
  /** M4: the checkout's current branch, for a worker in a linked worktree (when known). */
  branch?: string;
}

export interface World {
  buildings: Building[];
  unassigned: string[];
  floors: Floor[];
  workers: Worker[];
  /** M3 */
  hire_options?: HireOptions;
}

export interface Hello {
  t: 'hello';
  proto: number;
  client: string;
  since_seq?: number;
  epoch?: string;
}

export interface Welcome {
  t: 'welcome';
  proto: number;
  server_seq: number;
  epoch: string;
  resume: 'snapshot' | 'replay';
  server?: string;
}

export interface Snapshot {
  t: 'world.snapshot';
  seq: number;
  world: World;
}

export interface BuildingUpsert {
  t: 'building.upsert';
  seq: number;
  building: Building;
}
export interface BuildingRemoved {
  t: 'building.removed';
  seq: number;
  id: string;
}
export interface FloorUpsert {
  t: 'floor.upsert';
  seq: number;
  floor: Floor;
}
export interface FloorRemoved {
  t: 'floor.removed';
  seq: number;
  session: string;
}
export interface WorkerUpsert {
  t: 'worker.upsert';
  seq: number;
  worker: Worker;
}
export interface WorkerStatusEvent {
  t: 'worker.status';
  seq: number;
  id: string;
  session: string;
  workspace_id: string;
  status: string;
  prev_status?: string;
  /** M2 */
  status_since?: number;
  /** M2: the terminal title, "" when cleared. Absent on an older bridge. */
  title?: string;
}
export interface WorkerRemoved {
  t: 'worker.removed';
  seq: number;
  id: string;
  session: string;
  workspace_id: string;
  /** M4: `sent_home` when the removal comes from `worker.fire`. */
  reason?: string;
}

export type WorldEvent =
  | BuildingUpsert
  | BuildingRemoved
  | FloorUpsert
  | FloorRemoved
  | WorkerUpsert
  | WorkerStatusEvent
  | WorkerRemoved;

export interface ErrorMessage {
  t: 'error';
  req_id?: string;
  code: string;
  message: string;
}

export interface Ack {
  t: 'ack';
  req_id: string;
  data?: unknown;
}

/** `floor.settings.set` args: absent = unchanged, null = clear, value = set. */
export interface SettingsPatch {
  repo?: string | null;
  project?: GithubProject | null;
  status_field?: StatusField | null;
  default_cwd?: string | null;
  default_hire?: Hire | null;
}

/** M4: `hire.prepare` ack: what the hire dialog offers for a floor (and a cwd). */
export interface HirePrepare {
  cwd: string;
  /** The preselected harness/model/effort; null or absent when `choice_source` is `none`. */
  choice?: Hire | null;
  choice_source: 'floor_default' | 'last' | 'none';
  /** The next generated name: the default label. */
  label: string;
  git: HireGit | null;
  capacity: HireCapacity;
}

export interface HireGit {
  repo_root: string;
  default_branch: string;
  /** `origin/<default_branch>` as fetched (or last fetched). */
  base_sha: string;
  /** Unix ms, the base commit's time. */
  base_time: number;
  fetched: boolean;
  fetch_error?: string;
}

export interface Cap {
  count: number;
  soft: number;
  hard: number;
}

export interface HireCapacity {
  floor: Cap;
  host: Cap;
  load?: { load1: number; cpus: number; mem_used_pct: number };
}

/** M4: `worker.hire` ack. */
export interface HireAck {
  id: string;
  workspace_id: string;
  branch?: string;
  base_sha?: string;
  trust: 'none' | 'avoided' | 'approved';
}

/** M4: `worker.fire.prepare` ack: what the send-home dialog shows. */
export interface FirePrepare {
  name: string;
  label: string;
  branch?: string;
  worktree: { path: string; linked: boolean } | null;
  /** `git status --porcelain` lines (capped). */
  dirty: string[];
  /** Commits not on any remote. */
  unpushed: number;
  can_delete: boolean;
  /** Why the worktree cannot be deleted. */
  reason?: string;
}

export type FireWorktree = 'keep' | 'delete' | 'delete_branch';

/** M4: `worker.fire` ack. */
export interface FireAck {
  worktree: 'kept' | 'deleted' | 'deleted_branch';
}

/** Commands and their args (docs/protocol.md "Commands", M3 and M4 additions). */
export interface CommandArgs {
  'building.create': { name: string };
  'building.rename': { id: string; name: string };
  'building.delete': { id: string };
  'building.reorder': { ids: string[] };
  'floor.assign': { session: string; building: string | null; index?: number };
  'floor.wake': { session: string };
  'floor.sleep': { session: string };
  'floor.settings.set': { session: string } & SettingsPatch;
  /** M4 */
  'hire.prepare': { session: string; cwd?: string };
  'worker.hire': {
    session: string;
    desk_index: number;
    harness: string;
    model: string;
    effort: string;
    label?: string;
    cwd?: string;
    worktree?: boolean;
    prompt?: string;
  };
  'worker.fire.prepare': { id: string };
  /** `handoff` (M9) and `stop_services` (#14) are reserved, not sent yet. */
  'worker.fire': { id: string; worktree?: FireWorktree };
}

export type CommandName = keyof CommandArgs;

export interface Command<T extends CommandName = CommandName> {
  t: T;
  req_id: string;
  args: CommandArgs[T];
}

/** Any other object with a string `t` (acks, future event types). */
export interface OtherMessage {
  t: string;
  seq?: number;
}

export type ServerMessage = Welcome | Snapshot | WorldEvent | ErrorMessage | Ack | OtherMessage;

const EVENT_TYPES = new Set([
  'building.upsert',
  'building.removed',
  'floor.upsert',
  'floor.removed',
  'worker.upsert',
  'worker.status',
  'worker.removed',
]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Parses one text frame; null when it is not a JSON object with a string `t`. */
export function parseMessage(raw: string): ServerMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v) || !isStr(v.t)) return null;
  return v as unknown as ServerMessage;
}

export function isWelcome(m: ServerMessage): m is Welcome {
  const o = m as unknown as Obj;
  return m.t === 'welcome' && isInt(o.server_seq) && isStr(o.epoch) && (o.resume === 'snapshot' || o.resume === 'replay');
}

export function isSnapshot(m: ServerMessage): m is Snapshot {
  const o = m as unknown as Obj;
  if (m.t !== 'world.snapshot' || !isInt(o.seq) || !isObj(o.world)) return false;
  const w = o.world;
  return Array.isArray(w.buildings) && Array.isArray(w.floors) && Array.isArray(w.workers);
}

/** A known world event with the fields the store needs; anything else is ignored. */
export function isWorldEvent(m: ServerMessage): m is WorldEvent {
  if (!EVENT_TYPES.has(m.t)) return false;
  const o = m as unknown as Obj;
  if (!isInt(o.seq)) return false;
  switch (m.t) {
    case 'building.upsert':
      return isObj(o.building) && isStr(o.building.id);
    case 'building.removed':
      return isStr(o.id);
    case 'floor.upsert':
      return isObj(o.floor) && isStr(o.floor.session);
    case 'floor.removed':
      return isStr(o.session);
    case 'worker.upsert':
      return isObj(o.worker) && isStr(o.worker.id) && isStr(o.worker.session);
    case 'worker.status':
      return isStr(o.id) && isStr(o.status);
    case 'worker.removed':
      return isStr(o.id);
  }
  return false;
}

export function isAck(m: ServerMessage): m is Ack {
  const o = m as unknown as Obj;
  return m.t === 'ack' && isStr(o.req_id);
}

export function isError(m: ServerMessage): m is ErrorMessage {
  const o = m as unknown as Obj;
  return m.t === 'error' && isStr(o.code);
}
