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
  | WorkerRemoved
  | WorkerUsageEvent;

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
  /** False when `git fetch origin` failed: a worktree hire is then refused (`fetch_failed`), a plain one is not. */
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
  /** `approved`: the bridge answered the agent's trust dialog; `none`: none showed; `avoided` is reserved. */
  trust: 'none' | 'avoided' | 'approved';
  /** Whether the first task was sent (absent without one). */
  prompted?: boolean;
  prompt_error?: string;
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
  /**
   * `can_delete`, and the branch is one the bridge made for this worker, still checked out and all on a remote:
   * only then may `worker.fire` use `delete_branch` (absent, from an older bridge: false).
   */
  can_delete_branch?: boolean;
  /** Why the worktree cannot be deleted. */
  reason?: string;
  /** False when herdr would refuse to close the workspace (a main checkout whose worktrees are still open). */
  can_fire?: boolean;
  fire_blocked?: string;
}

export type FireWorktree = 'keep' | 'delete' | 'delete_branch';

/** M4: `worker.fire` ack. */
export interface FireAck {
  worktree: 'kept' | 'deleted' | 'deleted_branch';
  /** Whether the agent left by itself after /exit (/quit); false: it took Ctrl-C. */
  released?: boolean;
  /** e.g. the tree became dirty during the exit, so the worktree was kept. */
  note?: string;
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

// M5 panels: the prompt overlay, quick replies, the Changes panel and usage (docs/protocol.md "Laptops").

/** M5: a blocked worker's question, read from its screen (present only while it is `blocked`). */
export interface QuestionChoice {
  n: number;
  label: string;
}

export interface Question {
  /** `permission` | `choice` | `trust` | `other` (blocked, no menu recognised). */
  kind: string;
  /** The question line, trimmed; "" when none was found. */
  text: string;
  /** The last few non-empty screen lines. */
  excerpt: string[];
  /** Numbered choices of a recognised menu, else []. */
  choices: QuestionChoice[];
  /** The highlighted choice, when seen. */
  selected?: number;
  /** Identifies this question for `worker.answer`. */
  hash: string;
}

/** M5: token usage and the API-equivalent cost estimate of a worker's agent session. */
export interface Usage {
  /** The headline count ("37k tokens"). */
  tokens: number;
  input?: number;
  output?: number;
  cache_write?: number;
  cache_read?: number;
  /** An estimate in USD: always shown as `≈$`. */
  cost_usd_est: number;
  /** `known`, `unknown_model` (priced as the most expensive known model: flagged), `none` (no model seen). */
  priced: string;
  model?: string;
  /** 0–100, null when unknown. */
  context_pct?: number | null;
  context_window?: number;
  updated_at?: number;
}

export interface Worker {
  /** M5: the question of a blocked worker. */
  question?: Question;
  /** M5 */
  usage?: Usage;
}

/** M5: usage changed (at most every 5 s per worker). */
export interface WorkerUsageEvent {
  t: 'worker.usage';
  seq: number;
  id: string;
  session?: string;
  usage: Usage;
}

/** M5: `worker.prompt` ack. */
export interface PromptAck {
  /** The worker was working: the agent takes the prompt on its next turn. */
  queued: boolean;
  /** herdr's paste needed one more Enter. */
  retried: boolean;
}

/** M5: `worker.answer` ack. */
export interface AnswerAck {
  sent: string[];
  resolved: boolean;
}

/** M5: a changed file in `worker.changes`. */
export interface ChangeFile {
  path: string;
  orig_path?: string;
  /** Porcelain v2 letters: `.` unchanged, `M`, `A`, `D`, `R`, … */
  index?: string;
  worktree?: string;
  untracked?: boolean;
  insertions: number;
  deletions: number;
  binary: boolean;
}

/** M5: `worker.changes` ack: the worker's checkout against its base. */
export interface Changes {
  cwd: string;
  /** null when detached. */
  branch: string | null;
  head?: string;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  /** The merge-base with origin's default branch; null: diffed against HEAD. */
  base: { ref: string; sha: string } | null;
  files: ChangeFile[];
  stat: { files: number; insertions: number; deletions: number };
  diff: string;
  /** The uncapped size of the diff. */
  diff_bytes: number;
  truncated: boolean;
  /** Files whose diff was left out (the cap). */
  omitted: string[];
}

export interface CommandArgs {
  'worker.prompt': { id: string; text: string };
  /** Exactly one of `choice` or `cancel`. */
  'worker.answer': { id: string; hash: string; choice?: number; cancel?: boolean };
  'worker.changes': { id: string };
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
  'worker.usage',
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
    case 'worker.usage':
      return isStr(o.id) && isObj(o.usage);
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
