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
  /** M6 start: the team preset of the last successful `run.start` here (omitted: none, or it was deleted). */
  last_preset?: string;
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
  /** Additional efforts supported by this model beyond the harness's common ones. */
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
  /** M5: the question of a blocked worker. */
  question?: Question;
  /** M5: its agent session's token usage and cost estimate. */
  usage?: Usage;
}

export interface World {
  buildings: Building[];
  unassigned: string[];
  floors: Floor[];
  workers: Worker[];
  /** M3 */
  hire_options?: HireOptions;
  /** M6 start: team presets by name (absent from an older bridge). */
  presets?: Preset[];
  /** M10 limits: the latest reading of each provider (absent from an older bridge or with --no-limits: no widget; `[]` before the first reading). */
  limits?: Limits[];
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
  | WorkerUsageEvent
  // M6 start
  | PresetUpsert
  | PresetRemoved
  // M10 limits
  | LimitsUpdate;

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

/** Commands and their args (docs/protocol.md "Commands", M3, M4 and M5 additions). */
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
  /** M5 */
  'worker.prompt': { id: string; text: string };
  /** Exactly one of `choice` or `cancel`. */
  'worker.answer': { id: string; hash: string; choice?: number; cancel?: boolean };
  'worker.changes': { id: string };
  'terminal.watch': { id: string; fps?: number; cols?: number; rows?: number };
  'terminal.unwatch': { id: string };
  'worker.keys': { id: string; input: KeyItem[] };
  // M16: the transcript view at a laptop (docs/protocol.md "Laptops: transcript").
  'transcript.watch': { id: string; limit?: number };
  'transcript.unwatch': { id: string };
  'transcript.page': { id: string; before: string; limit?: number };
  'transcript.item': { id: string; item: string };
  // M6 start: team presets and starting a run.
  'preset.create': { name: string; roles: PresetRoles };
  /** `roles` replaces all five. */
  'preset.update': { id: string; name?: string; roles?: PresetRoles };
  'preset.delete': { id: string };
  'run.prepare': RunTicketArgs & { session: string; preset?: string; orch?: Hire; extra?: string };
  'run.start': RunTicketArgs & {
    session: string;
    desk_index: number;
    orch: Hire;
    preset: string;
    extra?: string;
    worktree?: boolean;
    label?: string;
    /** The edited preview; absent: the bridge composes it. */
    prompt?: string;
  };
  // M7: boards (docs/protocol.md "Boards: issues and pull requests").
  'board.watch': { session: string };
  'board.unwatch': { session: string };
  'board.refresh': { session: string };
  /** M10 limits: read the plan limits now (at most every 20 s). */
  'limits.refresh': Record<string, never>;
  'issue.get': { session: string; id: string };
  'issue.comment': { session: string; id: string; body: string };
  'issue.close': { session: string; id: string; reason: CloseReason; confirm: true };
  'issue.set_status': { session: string; id: string; column: string };
  'pr.get': { session: string; id: string };
  'pr.comment': { session: string; id: string; body: string };
  'pr.merge': { session: string; id: string; method: MergeMethod; confirm: true; override?: boolean; confirm_override?: true };
  'worker.open_pr.prepare': { id: string };
  'worker.open_pr': { id: string; title: string; body: string; confirm: true };
}

// M5: blocked workers' questions, usage, and the acks of the prompt, answer and Changes commands (docs/protocol.md
// "Laptops: screens, input, changes and usage").

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
  // M6 start
  'preset.upsert',
  'preset.removed',
  'limits.update',
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
    // M6 start
    case 'preset.upsert':
      return isObj(o.preset) && isStr(o.preset.id) && isStr(o.preset.name) && isObj(o.preset.roles);
    case 'preset.removed':
      return isStr(o.id);
    // M10 limits: the fields of `Limits` flat in the event.
    case 'limits.update':
      return isStr(o.provider) && Array.isArray(o.windows);
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

// M5: laptop screens (`terminal.watch` / `terminal.unwatch`, the connection-scoped `terminal.frame` /
// `terminal.closed`) and seated input (`worker.keys`). No `seq`: frames are sent only to the watching connection
// and never replayed; the client re-watches after a reconnect.

/** One `worker.keys` item: literal text (no control characters) or one allowlisted herdr key name. */
export type KeyItem = { text: string } | { key: string };

/** `terminal.watch` ack. */
export interface WatchAck {
  pane: string;
  cols: number;
  rows: number;
}

export interface TerminalFrame {
  t: 'terminal.frame';
  id: string;
  pane: string;
  /** Counts frames per watch from 1; a re-watch starts again at a `full` frame. */
  n: number;
  /** true: reset the screen, then apply `data`; false: apply `data` on top (diffs compose by concatenation). */
  full: boolean;
  cols: number;
  rows: number;
  /** Base64 ANSI bytes. */
  data: string;
}

export type ClosedReason = 'worker_removed' | 'asleep' | 'pane_changed' | 'observer_failed';

export interface TerminalClosed {
  t: 'terminal.closed';
  id: string;
  reason: ClosedReason | string;
}

// M16: a worker's agent conversation as a timeline of normalised items (`transcript.watch` / `transcript.unwatch`
// / `transcript.page` / `transcript.item`, the connection-scoped `transcript.items` / `transcript.closed`). Like
// frames, no `seq`: sent only to the watching connection, never replayed; the client re-watches after a reconnect.

/** An image in a transcript item (phase 1: never sent, only noted). */
export interface ImagePart {
  image_omitted: true;
}

export interface TranscriptItem {
  /** Stable across updates: Claude message.id/uuid (+block), Codex item id/call_id. */
  id: string;
  /** Order within this transcript. */
  seq: number;
  /** Unix ms. */
  ts: number;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'subagent' | 'compaction' | 'notice' | 'unknown';
  /** user / assistant: markdown text and images, in order. */
  parts?: Array<{ text: string } | ImagePart>;
  /** A tool call and its result (the result may arrive later, as an update). */
  tool?: {
    name: string;
    input_summary: string;
    input?: unknown;
    status: 'running' | 'ok' | 'error' | 'interrupted';
    output_text?: string;
    output_truncated?: boolean;
    diff?: { path: string; hunks: unknown[] };
  };
  subagent?: { agent_id: string; description: string; status: string };
  notice?: { text: string };
  /** `unknown`: the line or block type the bridge did not know. */
  raw_type?: string;
}

/** `transcript.watch` ack (and `transcript.page`'s: the items before `cursor`). */
export interface TranscriptWatchAck {
  harness: string;
  session: string;
  version: string;
  /** Where the next `transcript.page` starts (older items). */
  cursor: string;
  has_more: boolean;
  /** No transcript yet (a fresh hire, a plain shell): items come once it appears. */
  pending: boolean;
  items: TranscriptItem[];
}

export interface TranscriptItems {
  t: 'transcript.items';
  id: string;
  /** New items (absent: none). */
  items?: TranscriptItem[];
  /** Whole replacements of items already sent, by `id` (a tool result arriving, a streamed message growing). */
  updates?: TranscriptItem[];
}

export type TranscriptClosedReason = 'worker_removed' | 'asleep' | 'session_changed' | 'resync' | 'not_found';

export interface TranscriptClosed {
  t: 'transcript.closed';
  id: string;
  reason: TranscriptClosedReason | string;
}

export function isTranscriptItems(m: ServerMessage): m is TranscriptItems {
  const o = m as unknown as Obj;
  return m.t === 'transcript.items' && isStr(o.id) && (o.items === undefined || Array.isArray(o.items)) && (o.updates === undefined || Array.isArray(o.updates));
}

export function isTranscriptClosed(m: ServerMessage): m is TranscriptClosed {
  const o = m as unknown as Obj;
  return m.t === 'transcript.closed' && isStr(o.id) && isStr(o.reason);
}

/** Connection-scoped messages (no `seq`): screens and transcripts of watched laptops. */
export type ConnMessage = TerminalFrame | TerminalClosed | TranscriptItems | TranscriptClosed;

export function isTerminalFrame(m: ServerMessage): m is TerminalFrame {
  const o = m as unknown as Obj;
  return m.t === 'terminal.frame' && isStr(o.id) && isInt(o.n) && typeof o.full === 'boolean' && isInt(o.cols) && isInt(o.rows) && isStr(o.data);
}

export function isTerminalClosed(m: ServerMessage): m is TerminalClosed {
  const o = m as unknown as Obj;
  return m.t === 'terminal.closed' && isStr(o.id) && isStr(o.reason);
}

// M6 start: team presets and starting a run (docs/protocol.md "Team presets and starting a run").

/** The five roles of a run's team. */
export type PresetRole = 'orch' | 'coder' | 'reviewer' | 'ux' | 'researcher';

export type PresetRoles = Record<PresetRole, Hire>;

export interface Preset {
  /** `p_<12 hex>`. */
  id: string;
  name: string;
  /** The bridge seeded it ("Build team"); only marks its origin. */
  seeded?: boolean;
  roles: PresetRoles;
}

export interface PresetUpsert {
  t: 'preset.upsert';
  seq: number;
  preset: Preset;
}

export interface PresetRemoved {
  t: 'preset.removed';
  seq: number;
  id: string;
}

/**
 * Exactly one of `issue` (a number, `"#3"`, `"3"` or an issue URL), `text` or (M7) `work_item`; `run.prepare` also
 * takes none.
 */
export interface RunTicketArgs {
  issue?: number | string;
  text?: string;
  /** M7: a card of the floor's issue board, by its opaque id. */
  work_item?: WorkItem;
}

export type RunTicket = { kind: 'issue'; repo: string; number: number; url: string } | { kind: 'text'; text: string };

/** `run.prepare` ack: the start-run dialog's defaults and its live prompt preview. */
export interface RunPrepare {
  /** "" while there is no ticket yet (or no preset at all). */
  prompt: string;
  /** "" while there is no ticket yet. */
  label: string;
  ticket?: RunTicket | null;
  /** "" when there is no preset at all. */
  preset: string;
  /** The asked-for or the preset's orchestrator; null with no preset and none asked for. */
  orch: Hire | null;
  cwd: string;
  git: HireGit | null;
  capacity: HireCapacity;
}

/** `run.start` ack: the `worker.hire` ack plus the launch and the prompt that was sent. */
export interface RunStartAck extends HireAck {
  launch_id: string;
  prompt: string;
}

// M6 crew: write-code runs and freelancers (docs/protocol.md "Runs and freelancers"). All optional; an older bridge
// sends none of them (the game then reads the role from the label and shows no report, phase or pass).

/** M6: the GitHub issue a run works on. */
export interface WorkerIssue {
  /** `owner/name`. */
  repo: string;
  number: number;
}

/** M6: a freelancer's report as the bridge read it (`<runs-dir>/<h3d_run>/<h3d_report>`). */
export interface WorkerReport {
  /** `pending` (no file yet), `ready`, `invalid`. */
  state: 'pending' | 'ready' | 'invalid' | string;
  /** Unix ms, the file's mtime. */
  at?: number;
  /** Reviewers: `PASS` | `CHANGES_REQUIRED` | `INCOMPLETE`. */
  verdict?: string;
  /** Reviewers: `issues_found` with priority BLOCKER, and all of them. */
  blockers?: number;
  issues?: number;
  /** The worker is blocked on its orchestrator or you (≤ 500 bytes). */
  input_required?: string | null;
  /** Coders / researchers: the first 300 bytes of their summary. */
  summary?: string;
  /** `invalid`: why. */
  error?: string;
}

// Declaration merging: the M6 fields of a worker, next to the ones above.
export interface Worker {
  /** M6: the write-code round (`h3d_round`, else the label's `|r<N>`). */
  round?: number;
  /** M6: the ticket field of a freelancer's label (or `h3d_ticket`). */
  ticket?: string;
  issue?: WorkerIssue;
  /** M6, freelancers: the worker id of its orchestrator. */
  orch_id?: string;
  /** M6, orchestrators: `research|coding|review|fixing|waiting_user|pr|done` (others passed through). */
  phase?: string;
  /** M6, orchestrators: review passes so far. */
  pass?: number;
  /** M6, orchestrators: past the 3-pass cap (or at it, waiting for you). */
  over_cap?: boolean;
  /** M6, freelancers with a report token. */
  report?: WorkerReport;
  /** M7: the neutral form of `issue`: the board card the worker's run is about. */
  work_item?: WorkItem;
}

// M7: boards. Items are addressed by an opaque `id` scoped by `provider`; clients never parse ids and show `key`.

/** M7: `{provider, id}` of a card (the bridge's neutral form of an issue link). */
export interface WorkItem {
  provider: string;
  id: string;
}

export type CloseReason = 'completed' | 'not_planned' | 'duplicate';
export type MergeMethod = 'merge' | 'squash' | 'rebase';
export type Priority = 'urgent' | 'high' | 'medium' | 'low';

export interface BoardColumn {
  /** Opaque; "" is the leading "No status" column. */
  id: string;
  name: string;
  done?: boolean;
}

export interface BoardLabel {
  name: string;
  /** `#rrggbb`. */
  color: string;
}

export interface BoardPerson {
  name: string;
  avatar_url?: string;
}

/** Board-level capabilities; a card or PR may override some of them. */
export interface BoardCaps {
  comment?: boolean;
  close?: boolean;
  set_status?: boolean;
  merge?: boolean;
  open_from_branch?: boolean;
}

export interface IssueCard {
  id: string;
  /** Shown to people: `#9`. */
  key: string;
  title: string;
  state: 'open' | 'closed';
  /** A column id. */
  column: string;
  /** Absent when the provider has no page for it. */
  url?: string;
  labels: BoardLabel[];
  priority?: Priority;
  assignees: BoardPerson[];
  author?: string;
  updated_at: number | null;
  closed_at: number | null;
  capabilities?: BoardCaps;
}

export interface BoardRate {
  remaining: number;
  reset_at: number;
}

/** Fields both board messages carry. */
export interface BoardBase {
  session: string;
  provider: string;
  /** "GitHub": the game says "Open in GitHub". */
  provider_name: string;
  /** true: the cache replayed on `board.watch`; never ring the gong for it. */
  initial: boolean;
  /** Unix ms of the data's poll; 0: nothing fetched yet. */
  fetched_at: number;
  stale?: boolean;
  error?: string;
  truncated?: boolean;
  rate?: BoardRate;
  capabilities?: BoardCaps;
}

/** Connection-scoped (no `seq`). */
export interface BoardIssues extends BoardBase {
  t: 'board.issues';
  columns: BoardColumn[];
  cards: IssueCard[];
}

export type Checks = 'success' | 'failure' | 'pending' | 'none';
export type ReviewState = 'approved' | 'changes_requested' | 'review_required' | 'none';
export type Mergeable = 'mergeable' | 'conflicting' | 'unknown';

export interface PullRequest {
  id: string;
  key: string;
  title: string;
  state: 'open';
  draft?: boolean;
  url?: string;
  head_branch: string;
  base_branch?: string;
  author?: string;
  checks: Checks;
  review: ReviewState;
  mergeable: Mergeable;
  /** Ids of the issues it closes (other repos' included). */
  closes: string[];
  additions?: number;
  deletions?: number;
  changed_files?: number;
  updated_at?: number | null;
  capabilities?: BoardCaps;
}

export interface MergedPullRequest {
  id: string;
  key: string;
  title: string;
  merged_at: number;
  closes?: string[];
}

export interface BoardPrs extends BoardBase {
  t: 'board.prs';
  prs: PullRequest[];
  merged: MergedPullRequest[];
}

export type BoardMessage = BoardIssues | BoardPrs;

export interface BoardComment {
  id: string;
  author: BoardPerson;
  body: string;
  created_at: number;
}

/** `issue.get` ack. */
export interface IssueDetail {
  card: IssueCard;
  /** Raw markdown: the game sanitises. */
  body: string;
  author: BoardPerson;
  created_at: number;
  comments: BoardComment[];
  comments_truncated?: boolean;
}

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
  change: string;
}

export interface PrCheck {
  name: string;
  state: 'success' | 'failure' | 'pending' | 'neutral' | 'skipped';
  url?: string;
}

/** `pr.get` ack. */
export interface PrDetail {
  pr: PullRequest;
  body: string;
  author: BoardPerson;
  created_at: number;
  files: PrFile[];
  files_truncated?: boolean;
  checks: PrCheck[];
  comments: BoardComment[];
  comments_truncated?: boolean;
}

export interface CommentAck {
  comment: BoardComment;
}

/** `worker.open_pr.prepare` ack. */
export interface OpenPrPrepare {
  can_open: boolean;
  reason?: string;
  branch?: string;
  base?: string;
  ahead?: number;
  dirty?: boolean;
  existing?: { id: string; key: string; url?: string };
  title?: string;
  body?: string;
}

/** `worker.open_pr` ack. */
export interface OpenPrAck {
  pr: { id: string; key: string; url?: string };
  pushed: boolean;
  existed: boolean;
}

/** `board.watch` ack. */
export interface WatchBoardAck {
  enabled: boolean;
  reason?: string;
}

export function isBoardIssues(m: ServerMessage): m is BoardIssues {
  const o = m as unknown as Obj;
  return m.t === 'board.issues' && isStr(o.session) && Array.isArray(o.columns) && Array.isArray(o.cards);
}

export function isBoardPrs(m: ServerMessage): m is BoardPrs {
  const o = m as unknown as Obj;
  return m.t === 'board.prs' && isStr(o.session) && Array.isArray(o.prs);
}

/** The connection-scoped board messages (no `seq`, never replayed): see docs/protocol.md "Boards". */
export function isBoardMessage(m: ServerMessage): m is BoardMessage {
  return isBoardIssues(m) || isBoardPrs(m);
}

// M10 limits (docs/protocol.md "Plan limits"): the Claude and Codex plan windows.

/** One usage window of a plan; `model` names a per-model window ("Opus"). */
export interface LimitWindow {
  /** "5h", "week", or a duration ("3d") for another window. */
  label: string;
  model?: string;
  /** 0–100. */
  pct: number;
  /** Unix ms; 0 when unknown. */
  resets_at: number;
  window_mins?: number;
  /** Codex's rateLimitReachedType of the model's own limit this window belongs to. */
  reached?: string;
}

export interface LimitCredits {
  has_credits: boolean;
  unlimited: boolean;
  balance?: string;
}

/** One provider's limits as of `at` (unix ms). */
export interface Limits {
  provider: string;
  plan: string;
  windows: LimitWindow[];
  at: number;
  /** Not a fresh answer of the CLI: from a transcript, or the last probe failed. */
  stale: boolean;
  /** Why there is no fresh reading: no_plan, not_installed, timeout, failed. */
  error?: string;
  /** probe | transcript. */
  source?: string;
  /** Codex's rateLimitReachedType while a limit is reached. */
  reached?: string;
  credits?: LimitCredits;
}

/** `limits.update`: a provider's new reading, flat. */
export interface LimitsUpdate extends Limits {
  t: 'limits.update';
  seq: number;
}

/** `limits.refresh` ack. */
export interface LimitsRefreshAck {
  queued: boolean;
}
