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
  /** M3d: the hash (sha256, hex) of the building's logo; absent without one. The image is GET /logo/{id}. */
  logo?: string;
}

/** The logo hash of a building: a non-empty string, else null (older bridges and odd values have none). */
export function logoHashOf(b: Pick<Building, 'logo'> | null | undefined): string | null {
  const h = b?.logo;
  return typeof h === 'string' && /^[0-9a-f]{8,128}$/i.test(h) ? h : null;
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
  /** #184: the floor's issue tracker when it is not GitHub (absent: GitHub). */
  tracker?: 'kaneo';
  /** #184: the floor's Kaneo link, kept while the floor uses GitHub too (switching back finds it). */
  kaneo?: KaneoLink;
}

/** #184: a floor's Kaneo workspace and project: ids, and the names they had when saved. */
export interface KaneoLink {
  workspace_id: string;
  workspace_name?: string;
  project_id: string;
  project_name?: string;
}

/** #184: the issue trackers a floor can use. */
export type Tracker = 'github' | 'kaneo';

/** #184: the bridge-wide Kaneo connection (`kaneo` in the snapshot, `kaneo.update`). Never the key: only `key_set`. */
export interface KaneoState {
  /** `off`: nothing saved; `paused`: Kaneo refused the key at run time (a bad key, or its quota): re-test, or wait. */
  state: 'off' | 'ready' | 'paused';
  /** The bridge has a Kaneo client: without it nothing can be tested. */
  available: boolean;
  url: string;
  api_base: string;
  web_origin: string;
  key_set: boolean;
  default_workspace: KaneoWorkspace | null;
  generation: number;
  /** Unix ms: when Kaneo floors poll again (paused only). */
  paused_until?: number;
  last_error?: { kind: string; message: string; at: number; runtime?: boolean };
}

/** #184: `kaneo.update`: the connection, flat. */
export interface KaneoUpdate extends KaneoState {
  t: 'kaneo.update';
  seq: number;
}

export interface KaneoWorkspace {
  id: string;
  name: string;
  slug?: string;
}

export interface KaneoProject {
  id: string;
  workspace_id: string;
  name: string;
  slug?: string;
}

/** #184: `kaneo.test` / `kaneo.set` args: absent fields are the saved ones; a blank key is the saved key (same instance only). */
export interface KaneoFields {
  url?: string;
  key?: string;
}

/** #184: `kaneo.test` ack. */
export interface KaneoTestAck {
  ok: boolean;
  latency_ms: number;
  url: string;
  api_base: string;
  web_origin: string;
  /** [] is authenticated, but no floor can be linked yet. */
  workspaces: KaneoWorkspace[];
  user?: string;
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
  /** #57: the structured question its agent's latest turn waits on, read from its transcript (whatever `status` says). */
  ask?: Ask;
  /** #83: its wrap-up, while armed or needing you. */
  wrapup?: WrapUp;
  /** #90: the open questions of its agent's final message, found by the AI integration's models, until answered or moot. */
  followup?: Followup;
  /** #155: how a Codex worker the bridge hired was launched (absent for other workers). */
  codex?: WorkerCodex;
}

/**
 * #155: a Codex worker's launch. `shared`: its terminal runs against a Codex app-server of its own, which the bridge
 * owns (`server` says how that server is); `legacy`: Codex's embedded server, as before the switch (`note` says why a
 * hire asked for shared runs legacy). `attached`: the bridge has joined its thread (#156: whenever its server runs).
 * #156: `thread` is the thread `worker.answer_async` names, `turn` its running turn while attached, `questions` its
 * async question batches, oldest first (docs/protocol.md "Codex async questions"). #157: `async_blocked`: herdr's
 * `blocked`, if it says so, is only an async question's (attached, the running turn asked a question Codex still holds,
 * no approval or blocking question open): the worker goes on working and takes prompts.
 */
export interface WorkerCodex {
  mode: 'shared' | 'legacy';
  server?: 'starting' | 'running' | 'down' | 'stopped';
  note?: string;
  attached?: boolean;
  thread?: string;
  turn?: string;
  questions?: CodexBatch[];
  async_blocked?: boolean;
}

/** #156: one async question message of a shared Codex worker's thread; `batch` is Codex's call_id. */
export interface CodexBatch {
  batch: string;
  turn: string;
  seen: ('live' | 'history')[];
  /** Another batch of the same turn with the same questions, seen only the other way under another id. */
  twin?: string;
  /** Live and history gave this id different questions: it cannot be answered. */
  conflict?: boolean;
  /** When the bridge first saw it, unix ms. */
  at: number;
  questions: CodexQuestion[];
}

/**
 * #156: one async question. `sent`: the server accepted the bridge's answer (`unconfirmed`: no response came;
 * `undelivered`: its turn ended without it, it may be answered again); `answered`: its reply envelope was seen.
 */
export interface CodexQuestion {
  index: number;
  title: string;
  /** Suggested answers; none: free text. */
  options?: string[];
  state: 'pending' | 'sending' | 'sent' | 'answered' | 'dismissed';
  answer?: string;
  answered_by?: 'bridge' | 'other';
  unconfirmed?: boolean;
  undelivered?: boolean;
  error?: string;
  truncated?: boolean;
}

/** #156: `worker.answer_async`'s ack: sent, not yet answered. */
export interface AsyncAnswerAck {
  state: 'sent';
  via: 'turn/steer' | 'turn/start';
  turn?: string;
  fallback?: boolean;
  unconfirmed?: boolean;
}

/** #155: the shared Codex server switch (`codex_server` in the snapshot, `codex_server.update`). */
export interface CodexServerState {
  /** New Codex workers get their own app-server. */
  enabled: boolean;
  /** The bridge can launch them; without it the switch cannot be turned on. */
  available: boolean;
}

/** #155: `codex_server.update`: the switch, flat. */
export interface CodexServerUpdate extends CodexServerState {
  t: 'codex_server.update';
  seq: number;
}

/**
 * #83: a worker's wrap-up. `armed`: the cleanup prompt went out and the bridge waits for the agent's result line;
 * `needs_you`: disarmed without a send home (BLOCKED, no result, a time-out, a failed check), `reason` says why.
 */
export interface WrapUp {
  state: 'armed' | 'needs_you';
  /** The send home's worktree choice, made up front. */
  worktree: FireWorktree;
  /** Unix ms (bridge clock). */
  armed_at: number;
  reason?: string;
}

/** #83: `worker.wrapup` ack: the prompt went out now, or (`queued`) for the agent's next turn. */
export interface WrapUpAck {
  queued?: boolean;
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
  /** M13 screen: whether a game shares its screen (absent from an older bridge: it cannot grab frames). */
  screen?: ScreenState;
  /** #92 AI integration: the classification model and the LLM (absent from an older bridge, or one without the service). Never a key. */
  ai?: AiState;
  /** #90 follow-up questions: the feature's settings and state (absent from an older bridge, or one without the AI service). */
  followups?: FollowupsState;
  /** #110 pack up on request: the feature's settings and state (absent from an older bridge, or one without the AI service). */
  packup?: PackupState;
  /** #98 "Classify unknown commands": the activity classifier's settings and state (absent from an older bridge, or one without the AI service). */
  activity?: ActivityState;
  /** #118 floor overview summaries: the feature's settings and state (absent from an older bridge, or one without the AI service). */
  digest?: DigestState;
  /** #106 the inbox's dismissed finished rows: worker id → the `status_since` of the done episode hidden (absent from an older bridge: none). */
  inbox_dismissed?: Record<string, number>;
  /** #155 the shared Codex server switch (absent from an older bridge). */
  codex_server?: CodexServerState;
  /** #184 the Kaneo connection (absent from an older bridge). Never a key. */
  kaneo?: KaneoState;
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
  | LimitsUpdate
  // M13 screen
  | ScreenStateEvent
  // #92 AI integration
  | AiUpdate
  // #90 follow-up questions
  | FollowupsUpdate
  // #110 pack up on request
  | PackupUpdate
  // #98 what the agent is doing
  | WorkerActivityEvent
  // #98 activity settings ("Classify unknown commands")
  | ActivityUpdate
  // #118 floor overview summaries
  | DigestUpdate
  // #106 the inbox: a finished row was dismissed
  | InboxDismissed
  // #155 the shared Codex server switch
  | CodexServerUpdate
  // #184 the Kaneo connection
  | KaneoUpdate
  // M13 whiteboard
  | WhiteboardUpdated;

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
  /** #184: `github` or `kaneo` (null: GitHub). */
  tracker?: Tracker | null;
  /** #184: checked with Kaneo before it is saved (a live project of that workspace). */
  kaneo?: { workspace_id: string; project_id: string } | null;
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
  /** #155: how a Codex hire was launched: shared, or legacy and why (absent for other hires, or with the switch off). */
  codex?: WorkerCodex;
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
  /** #83: the cleanup prompt (the bridge appends its result-line footer) and the send home's worktree choice. */
  'worker.wrapup': { id: string; prompt: string; worktree?: FireWorktree };
  'worker.wrapup.cancel': { id: string };
  /** M5 */
  'worker.prompt': { id: string; text: string };
  /** Exactly one of `choice` or `cancel`. */
  'worker.answer': { id: string; hash: string; choice?: number; cancel?: boolean };
  /** #57: an answer for every question of the worker's ask, or `cancel` (Esc on its dialog) with an optional `prompt` sent after. */
  'worker.answer_ask': { id: string; tool_use_id: string; answers?: AskAnswerArg[]; cancel?: boolean; prompt?: string };
  'worker.changes': { id: string };
  /** #136: the worker's slash commands and skills (ack `WorkerCommands`). */
  'worker.commands': { id: string };
  /** #137: the worker's files and directories ranked against `query` (ack `WorkerFiles`). `limit` 1–100, default 30. */
  'worker.files': { id: string; query: string; limit?: number };
  /** #74: `fullscreen` asks the bridge to zoom the pane's herdr tab while the watch lasts (absent / false: as before). */
  'terminal.watch': { id: string; fps?: number; cols?: number; rows?: number; fullscreen?: boolean };
  'terminal.unwatch': { id: string };
  /** #74: the seat bar's fullscreen toggle; `on: false` goes back to the split view. Needs a watch of the worker. */
  'terminal.zoom': { id: string; on: boolean };
  'worker.keys': { id: string; input: KeyItem[] };
  // M16: the transcript view at a laptop (docs/protocol.md "Laptops: transcript").
  'transcript.watch': { id: string; limit?: number };
  'transcript.unwatch': { id: string };
  /** The items before `before` (a cursor); with `agent`, a Claude subagent's own timeline (`before` '': its newest). */
  'transcript.page': { id: string; before: string; limit?: number; agent?: string };
  /** One item in full; with `agent`, an item of that subagent's timeline. */
  'transcript.item': { id: string; item: string; agent?: string };
  /** M16 phase 2: one image by the hash of an `ImageRef` this connection was sent (never a path). */
  'transcript.image': { id: string; hash: string; size: 'thumb' | 'full'; agent?: string };
  /** M16 phase 2: every image of the session (no bytes), also the ones older than the watch's window. */
  'transcript.images': { id: string; before?: string; limit?: number };
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
  // #92 AI integration (docs/protocol.md "AI integration"). A key is sent here and nowhere else, and never comes back.
  'ai.get': Record<string, never>;
  'ai.models': AiFields;
  'ai.test': AiFields;
  'ai.set': AiFields;
  'ai.clear': { role: AiRole };
  // #90 follow-up questions (docs/protocol.md "Follow-up questions").
  'followups.get': Record<string, never>;
  'followups.set': { enabled?: boolean; threshold?: number };
  'followups.test': { threshold?: number };
  'worker.answer_followup': { id: string; turn_id: string; answers: FollowupAnswer[] };
  'worker.dismiss_followup': { id: string; turn_id: string };
  // #110 pack up on request (docs/protocol.md "Pack up on request"). `packup.detect` acks `PackupDetectAck`.
  'packup.get': Record<string, never>;
  'packup.set': { enabled?: boolean; threshold?: number };
  'packup.test': { threshold?: number };
  'packup.detect': { id: string; text: string };
  // #106 the inbox: hide a done worker's row until its next working → done. Ack `{dismissed: boolean}`; false: ignored (no longer current).
  'inbox.dismiss': { id: string; status_since: number };
  // #98 activity settings ("Classify unknown commands", docs/protocol.md).
  'activity.get': Record<string, never>;
  // #184 Kaneo (docs/protocol.md "Kaneo"). A key is sent in test and set and nowhere else, and never comes back.
  'kaneo.get': Record<string, never>;
  'kaneo.test': KaneoFields;
  'kaneo.set': KaneoFields & { default_workspace?: string | null };
  'kaneo.clear': Record<string, never>;
  /** The saved connection's workspaces: `{workspaces, generation}`. */
  'kaneo.workspaces': Record<string, never>;
  /** A workspace's projects with the saved connection: `{workspace_id, projects, generation}`. */
  'kaneo.projects': { workspace_id: string };
  'codex_server.get': Record<string, never>; // #155
  'codex_server.set': { enabled: boolean };
  // #156 Codex async questions. `worker.answer_async` acks `AsyncAnswerAck`.
  'worker.answer_async': { id: string; thread: string; batch: string; answers: { index: number; answer: string }[] };
  'worker.dismiss_async': { id: string; thread: string; batch: string; indexes?: number[] };
  'activity.set': { model_enabled?: boolean; threshold?: number; margin?: number; daily_cap?: number };
  // #118 floor overview summaries (docs/protocol.md "Floor overview summaries"). `digest.test` acks `DigestTestAck`.
  'digest.get': Record<string, never>;
  /** #174: `reasoning_effort` "" is the provider's default (nothing sent); `max_tokens` the completion budget, reasoning included. */
  'digest.set': { enabled?: boolean; daily_cap?: number; reasoning_effort?: string; max_tokens?: number };
  'digest.test': Record<string, never>;
  /** #174: try the failed summary lines of a worker (every worker without an id) again; acks `{ retried }`. */
  'digest.retry': { id?: string };
  'issue.get': { session: string; id: string };
  'issue.comment': { session: string; id: string; body: string };
  'issue.close': { session: string; id: string; reason: CloseReason; confirm: true };
  /** #52: `after` (with the `order` capability) also places the card: null the top of the column, a card id right after it. */
  'issue.set_status': { session: string; id: string; column: string; after?: string | null };
  'pr.get': { session: string; id: string };
  'pr.comment': { session: string; id: string; body: string };
  'pr.merge': { session: string; id: string; method: MergeMethod; confirm: true; override?: boolean; confirm_override?: true };
  'worker.open_pr.prepare': { id: string };
  'worker.open_pr': { id: string; title: string; body: string; confirm: true };
  // M13 screen (docs/protocol.md "Screen share").
  /** Sent after every (re)connect, sharing or not: it makes this connection a game a grab can ask. */
  'screen.share': { sharing: boolean; surface?: DisplaySurface };
  /** The answer to a frame request that has no frame (the JPEG itself goes to POST /screen/frame/{req_id}). */
  'screen.frame': { req_id: string; error: string; message?: string };
  'screen.grab': { floor: string; requester: string };
  // M13 whiteboard (docs/protocol.md "Whiteboard"; the board's bytes are HTTP, net/whiteboard.ts).
  'whiteboard.get': { floor: string };
  'whiteboard.clear': { floor: string; confirm: true; author?: string };
  'drops.list': { limit?: number };
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
  /** #101: the main thread's context in use, in tokens (what the next turn starts with; 0 or absent: unknown). Absent from older bridges. */
  context_tokens?: number;
  /** #101: `context_window` was assumed (the model table or its family), not seen or reported. Absent from older bridges. */
  context_window_estimated?: boolean;
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
  /** #138: the text the bridge sent, when it rewrote the typed one for the worker's harness (absent: as typed). */
  sent?: string;
  /** #140: the prompt runs a built-in whose output or dialog shows only in the worker's terminal (absent: no). */
  terminal?: boolean;
  /** #156: sent through a shared Codex worker's app-server (herdr refused it: blocked by an async question). */
  via?: 'app_server';
}

/** M5: `worker.answer` ack. */
export interface AnswerAck {
  sent: string[];
  resolved: boolean;
}

// #57: agents' structured questions (Claude's AskUserQuestion, Codex's request_user_input), docs/protocol.md
// "Laptops: asks".

export interface AskOption {
  label: string;
  description?: string;
  /** Claude's markdown preview of the option (capped). */
  preview?: string;
}

export interface AskQuestion {
  /** Codex's question id; absent for Claude. */
  id?: string;
  header: string;
  question: string;
  /** Several options may be picked. */
  multi: boolean;
  /** It takes a typed answer too (Claude's "Type something", Codex's "None of the above" with notes). */
  other: boolean;
  /** The typed answer is masked on the agent's screen. */
  secret?: boolean;
  options: AskOption[];
  truncated?: boolean;
}

/** A worker's pending ask. */
export interface Ask {
  tool_use_id: string;
  source: string;
  agent: 'claude' | 'codex' | string;
  questions: AskQuestion[];
  /** When the agent asked, unix ms. */
  since: number;
}

/** One question's answer in `worker.answer_ask`: option numbers (1-based) and/or a typed `other`. */
export interface AskAnswerArg {
  question: number;
  choices?: number[];
  other?: string;
}

/** `worker.answer_ask` ack: the steps taken (typed text is "text") and whether the transcript recorded the answer. */
export interface AnswerAskAck {
  sent: string[];
  resolved: boolean;
  prompted?: boolean;
}

/** A recorded answer on an ask's transcript card. */
export interface AskAnswer {
  question: number;
  answer: string;
  labels?: string[];
  other?: string;
  notes?: string;
}

/** An AskUserQuestion / request_user_input tool item's question card. */
export interface TranscriptAsk {
  agent: string;
  questions: AskQuestion[];
  outcome: 'pending' | 'answered' | 'declined' | 'clarify' | 'interrupted' | string;
  answers?: AskAnswer[];
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

/** #136: a slash command or skill in `worker.commands`. */
export interface CommandEntry {
  /** No leading slash; keeps its namespace (`caveman:caveman-commit`). */
  name: string;
  description: string;
  /** '' when there is none. */
  argument_hint: string;
  /** `command`: the harness's own; `custom`: a `.claude/commands` file; `skill`: anything else. */
  kind: 'command' | 'skill' | 'custom';
  /**
   * #140, a `command` only: `always` when its output or dialog shows only in the worker's terminal, `bare` when only
   * `/name` alone does (with arguments it is inline), '' otherwise. Absent from a bridge before #140.
   */
  terminal?: 'always' | 'bare' | '';
}

/** #136: `worker.commands` ack. */
export interface WorkerCommands {
  commands: CommandEntry[];
  /** No probe of the harness succeeded yet: `commands` holds only the bridge's static built-ins. */
  partial: boolean;
}

/** #137: a file or directory of a worker's checkout in `worker.files`. */
export interface FileMatch {
  /** Relative to the checkout, `/`-separated, no leading `./`, no trailing `/`; verbatim (spaces, `#`, `?` unquoted). */
  path: string;
  kind: 'file' | 'dir';
  /**
   * Code point offsets in `path` of the matched query characters, ascending (`[]` for an empty query). Not UTF-16
   * indices: highlight with `Array.from(path)`, never `path[i]` / `path.slice`.
   */
  indices: number[];
}

/** #137: `worker.files` ack. */
export interface WorkerFiles {
  /** Best first; never null. */
  files: FileMatch[];
  /** What listed the checkout: `git ls-files`, `rg --files` outside git, or nothing (no rg: `files` is empty). */
  source: 'git' | 'rg' | 'none';
  /** Why `files` is empty or may be incomplete or stale; null when there is nothing to say. */
  reason: string | null;
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
  'ai.update', // #92 AI integration
  'followups.update', // #90 follow-up questions
  'packup.update', // #110 pack up on request
  'worker.activity', // #98 what the agent is doing
  'activity.update', // #98 activity settings
  'digest.update', // #118 floor overview summaries
  'inbox.dismissed', // #106 the inbox: a finished row dismissed
  'codex_server.update', // #155 the shared Codex server switch
  'kaneo.update', // #184 the Kaneo connection
  'screen.state', // M13 screen
  // M13 whiteboard
  'whiteboard.updated',
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
    // #92 AI integration: the fields of `AiState` flat in the event.
    case 'ai.update':
      return isObj(o.classifier) && isObj(o.llm);
    // #90 follow-up questions: the fields of `FollowupsState` flat in the event.
    case 'followups.update':
      return typeof o.enabled === 'boolean' && typeof o.state === 'string';
    // #110 pack up on request: the fields of `PackupState` flat in the event.
    case 'packup.update':
      return typeof o.enabled === 'boolean' && typeof o.state === 'string';
    // #98: `activity` absent (or null) clears it.
    case 'worker.activity':
      return isStr(o.id) && (o.activity === undefined || o.activity === null || isObj(o.activity));
    // #98 activity settings: the fields of `ActivityState` flat in the event.
    case 'activity.update':
      return typeof o.model_enabled === 'boolean' && typeof o.state === 'string';
    // #118 floor overview summaries: the fields of `DigestState` flat in the event.
    case 'digest.update':
      return typeof o.enabled === 'boolean' && typeof o.state === 'string';
    // #155: the shared Codex server switch, flat.
    case 'codex_server.update':
      return typeof o.enabled === 'boolean' && typeof o.available === 'boolean';
    // #184: the Kaneo connection, flat.
    case 'kaneo.update':
      return typeof o.state === 'string' && typeof o.key_set === 'boolean';
    // #106: a dismissal of one done episode.
    case 'inbox.dismissed':
      return isStr(o.id) && isInt(o.status_since);
    // M13 screen: the fields of `ScreenState` flat in the event.
    case 'screen.state':
      return typeof o.sharing === 'boolean';
    // M13 whiteboard: the fields of `WhiteboardState` flat in the event.
    case 'whiteboard.updated':
      return isWhiteboardState(o);
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

/**
 * #74: where a watched pane stands in its herdr tab. `single`: the tab has one pane; `zoomed`: this pane fills the tab;
 * `split`: the tab has several panes and this one shows at its own split size. `applied`: the bridge zoomed the tab
 * for this watch. `headless`: the tab's area is herdr's headless 120 × 40, so likely no herdr screen is attached and a
 * zoom did not make the pane's terminal any wider.
 */
export interface ZoomInfo {
  state: 'single' | 'zoomed' | 'split';
  applied: boolean;
  headless?: boolean;
}

/** `terminal.watch` ack; `zoom` is absent from a bridge before #74. */
export interface WatchAck {
  pane: string;
  cols: number;
  rows: number;
  zoom?: ZoomInfo;
}

/** `terminal.zoom` ack: the watch's new size and zoom state. */
export interface ZoomAck {
  pane: string;
  cols: number;
  rows: number;
  zoom: ZoomInfo;
}

/** #74: the watched pane's zoom, focus or size changed (a connection-scoped message like the frames: no seq, not replayed). */
export interface TerminalState {
  t: 'terminal.state';
  id: string;
  pane: string;
  cols: number;
  rows: number;
  zoom: ZoomInfo;
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

/** Who put an image in the conversation: `input` is only what the user attached to a prompt; `agent` is what the agent viewed or generated. */
export type ImageOrigin = 'input' | 'agent';

/**
 * An image in a transcript item (phase 2). Never has bytes: `transcript.image` serves them by `hash`, and only a hash this
 * connection was sent. The client never sends a path.
 */
export interface ImageRef {
  /** sha256 of the image bytes, hex; absent when `unavailable`. The same image twice has the same hash. */
  hash?: string;
  /** image/png, image/jpeg, image/gif, image/webp; `binary` for inline bytes that are none of them (no thumbnail). */
  mime?: string;
  bytes?: number;
  width?: number;
  height?: number;
  source: 'inline' | 'path';
  /** A path image's file (or a URL): text for the "not available" card, never fetched by the client. */
  path?: string;
  origin: ImageOrigin;
  /** A detail for a badge on an `agent` image. */
  kind?: 'generated' | 'viewed';
  /** The item the image is in, its `seq` and its `ts`: the Images tab links back to it. */
  item_id?: string;
  seq?: number;
  ts?: number;
  /** The bridge did not take the image; `reason` says why. */
  unavailable?: boolean;
  reason?: 'not_allowed' | 'missing' | 'too_large' | 'not_image' | 'invalid' | string;
}

/** An image part of an item (`parts`, a tool's `images`). */
export interface ImagePart {
  image: ImageRef;
}

/** What an older bridge (phase 1) sent for an image: only its place. */
export interface ImageOmittedPart {
  image_omitted: true;
}

/** A hunk as the bridge sends it: lines start with ' ', '-' or '+'; Codex patches have no line numbers (all 0). */
export interface TranscriptHunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: string[] | null;
}

/** A file's change as unified-diff hunks (`TranscriptHunk`s from the bridge; the renderer reads other shapes too). */
export interface TranscriptDiff {
  path: string;
  hunks: unknown[];
  /** Lines were left out (`transcript.item` has them). */
  truncated?: boolean;
}

export interface TranscriptItem {
  /** Stable across updates: Claude message.id/uuid (+block), Codex item id/call_id. */
  id: string;
  /** Order within this transcript. */
  seq: number;
  /** Unix ms (0: the line had no timestamp). */
  ts: number;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'subagent' | 'compaction' | 'notice' | 'unknown';
  /** Noise shown only with "show system": dropped lines (as notices) and unknown ones. */
  hidden?: boolean;
  /** user / assistant / thinking: markdown text and images, in order. */
  parts?: Array<{ text: string } | ImagePart | ImageOmittedPart>;
  /** #183, user: the reply to Codex's async questions (`parts` holds the native envelope as sent): one entry per answer, in
   * order. Plain text, not markdown. */
  answers?: Array<{ question: string; answer: string }>;
  /** A part's text was cut (`transcript.item` has it all). */
  truncated?: boolean;
  /** A tool call and its result (the result may arrive later, as an update); a subagent's call has one too. */
  tool?: {
    name: string;
    input_summary: string;
    input?: unknown;
    status: 'running' | 'ok' | 'error' | 'interrupted';
    output_text?: string;
    output_truncated?: boolean;
    /** Images in the output (what the agent viewed: a `Read` of a PNG, a screenshot, Codex `view_image`). */
    images?: Array<ImagePart | ImageOmittedPart>;
    diff?: TranscriptDiff;
    /** Every file of a patch that changes more than one (`diff` is the first). */
    diffs?: TranscriptDiff[];
    /** #57: an ask call's question card. */
    ask?: TranscriptAsk;
  };
  /** `agent_id` is '' until the call's result names it (its timeline: `transcript.page` with `agent`). */
  subagent?: { agent_id: string; description: string; status: string };
  /** `source`: the line type it came from ("system/turn_duration", "attachment/date", …). */
  notice?: { text: string; source?: string };
  /** `unknown`: the line or block type the bridge did not know. */
  raw_type?: string;
}

/** What a watch says of the transcript it reads (the ack; the first push after a `pending` one). */
export interface TranscriptHead {
  harness: string;
  session: string;
  version: string;
  /** Where the next `transcript.page` starts (older items). */
  cursor: string;
  has_more: boolean;
  /** No transcript yet (a fresh hire, a plain shell): items come once it appears. */
  pending: boolean;
}

/** `transcript.watch` ack. */
export interface TranscriptWatchAck extends TranscriptHead {
  items: TranscriptItem[];
}

/** `transcript.page` ack: the items before the asked cursor (or a subagent's), oldest first. */
export interface TranscriptPageAck {
  items: TranscriptItem[];
  /** Where the page before this one starts. */
  cursor: string;
  has_more: boolean;
}

/** `transcript.item` ack. */
export interface TranscriptItemAck {
  item: TranscriptItem;
}

/** `transcript.image` ack. */
export interface TranscriptImageAck {
  mime: string;
  width: number;
  height: number;
  /** Bytes of the decoded image sent. */
  bytes: number;
  size: 'thumb' | 'full';
  /** Base64. */
  data: string;
}

/** `transcript.images` ack: a run of the session's images, oldest first; `has_more`: the older ones start at `cursor` (ask again with `before`). */
export interface TranscriptImagesAck {
  images: ImageRef[];
  cursor?: string;
  has_more?: boolean;
}

export interface TranscriptItems extends Partial<TranscriptHead> {
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
export type ConnMessage = TerminalFrame | TerminalClosed | TerminalState | TranscriptItems | TranscriptClosed;

export function isTerminalFrame(m: ServerMessage): m is TerminalFrame {
  const o = m as unknown as Obj;
  return m.t === 'terminal.frame' && isStr(o.id) && isInt(o.n) && typeof o.full === 'boolean' && isInt(o.cols) && isInt(o.rows) && isStr(o.data);
}

const ZOOM_STATES = ['single', 'zoomed', 'split'];

/** A well-formed `zoom` object (state, applied, optional headless). */
export function isZoomInfo(v: unknown): v is ZoomInfo {
  const o = v as Obj | null;
  return !!o && typeof o === 'object' && isStr(o.state) && ZOOM_STATES.includes(o.state) && typeof o.applied === 'boolean' && (o.headless === undefined || typeof o.headless === 'boolean');
}

export function isTerminalState(m: ServerMessage): m is TerminalState {
  const o = m as unknown as Obj;
  return m.t === 'terminal.state' && isStr(o.id) && isInt(o.cols) && isInt(o.rows) && isZoomInfo(o.zoom);
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

export type RunTicket =
  | { kind: 'issue'; repo: string; number: number; url: string }
  | { kind: 'text'; text: string }
  /** #184: an item of a provider that numbers no GitHub issues (a Kaneo task), resolved by the bridge. */
  | { kind: 'item'; url?: string; item: WorkItem; provider_name: string };

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
  /** #118: the issue's title and its page, from the floor's board (absent while unknown, or from an older bridge). The game never builds the URL. */
  title?: string;
  url?: string;
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
  /**
   * M6c, game-only: an orchestrator that sits in the corner office up the mezzanine stair instead of at its desk
   * (see docs/decisions.md). The real bridge never sends it; fixtures, the simulator and tests do.
   */
  corner?: boolean;
  /** M7: the neutral form of `issue`: the board card the worker's run is about. */
  work_item?: WorkItem;
}

// M7: boards. Items are addressed by an opaque `id` scoped by `provider`; clients never parse ids and show `key`.

/** M7: `{provider, id}` of a card (the bridge's neutral form of an issue link). */
export interface WorkItem {
  provider: string;
  id: string;
  /** #118: on a worker's `work_item`, the card's title and page where the provider has them. */
  title?: string;
  url?: string;
  /** #184: the item's readable key (`HRD-12`) where no GitHub issue names it. */
  key?: string;
}

export type CloseReason = 'completed' | 'not_planned' | 'duplicate';
export type MergeMethod = 'merge' | 'squash' | 'rebase';
export type Priority = 'urgent' | 'high' | 'medium' | 'low';

export interface BoardColumn {
  /** Opaque; "" is the leading "No status" column. */
  id: string;
  name: string;
  done?: boolean;
  /** #184: a provider's virtual status, not a workflow column: `planned` or `archived` (archive is not completion). */
  kind?: 'planned' | 'archived' | '';
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
  /** #52: a card's place in its column can be set (`issue.set_status` with `after`); cards carry `position`. */
  order?: boolean;
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
  /** Unix ms; 0 or null: unknown (#184: Kaneo gives none): never shown as a time. */
  updated_at: number | null;
  closed_at: number | null;
  /** #52: the card's rank in the provider's order (0 first); absent for a card that has no place in it. */
  position?: number;
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
  /** #184: the failed poll's error code (`unauthorized`, `forbidden`, `rate_limited`, …), and while the provider refused the key, when polling resumes (unix ms). */
  error_code?: string;
  paused_until?: number;
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

// #92 AI integration (docs/protocol.md "AI integration"): the bridge-wide classification model (Jev) and
// OpenAI-compatible LLM. Features take them from the bridge; this is only their settings.

export type AiRole = 'classifier' | 'llm';
/** off: nothing configured; incomplete: a part is missing; invalid: the last test or call failed; ready. */
export type AiRoleState = 'off' | 'incomplete' | 'invalid' | 'ready';

export interface AiClassifier {
  state: AiRoleState;
  model: string;
  key_set: boolean;
  /** The last four characters of the key ('' when it is too short to show any). */
  key_hint: string;
  /** The fields the bridge's environment sets: read-only here. */
  env: string[];
}

export interface AiLlm {
  state: AiRoleState;
  base_url: string;
  model: string;
  key_set: boolean;
  key_hint: string;
  /** Whether the endpoint takes response_format (null: not known yet). */
  json_mode: boolean | null;
  extra_body?: Record<string, unknown>;
  env: string[];
}

export interface AiLastError {
  role: AiRole;
  kind: string;
  message: string;
  at: number;
  /** A feature's call hit it (not a test or a model list). */
  runtime?: boolean;
}

export interface AiState {
  classifier: AiClassifier;
  llm: AiLlm;
  last_error?: AiLastError;
}

/** `ai.update`: the whole state, flat. */
export interface AiUpdate extends AiState {
  t: 'ai.update';
  seq: number;
}

/**
 * What ai.models, ai.test and ai.set name. A field left out is the current one; a blank or absent key is the
 * current key. `extra_body`: left out keeps, null clears, an object sets (LLM only).
 */
export interface AiFields {
  role: AiRole;
  base_url?: string;
  model?: string;
  key?: string;
  extra_body?: Record<string, unknown> | null;
}

export interface AiModel {
  id: string;
  description?: string;
}

export interface AiModelsAck {
  models: AiModel[];
  /** The LLM's base URL as the bridge resolved it. */
  base_url?: string;
}

export interface AiTestAck {
  ok: boolean;
  latency_ms: number;
  json_mode?: boolean;
  base_url?: string;
  score?: number;
}

// #90 follow-up questions (docs/protocol.md "Follow-up questions"): the open questions of an agent's final message,
// detected by the AI integration's classifier and extracted by its LLM once the feature is switched on.

export type FollowupKind = 'yes_no' | 'choice' | 'open';

export interface FollowupQuestion {
  id: string;
  question: string;
  kind: FollowupKind;
  /** A choice's options (never on yes_no or open). */
  options?: string[];
}

/** A worker's open questions (`Worker.followup`). */
export interface Followup {
  /** The turn they were asked in: an answer names it (another one is `stale`). */
  turn_id: string;
  questions: FollowupQuestion[];
  /** The classifier's score. */
  score: number;
  /** model: the LLM listed them; fallback: it failed, one open item stands for them. */
  source: 'model' | 'fallback';
  /** Unix ms (bridge clock). */
  at: number;
  /** The end of the message (a fallback's), for the card. */
  tail?: string;
}

/** off: switched off; incomplete: on, but a model is not ready (nothing runs); ready. */
export type FollowupsFeatureState = 'off' | 'incomplete' | 'ready';

export interface FollowupsState {
  enabled: boolean;
  threshold: number;
  state: FollowupsFeatureState;
  /** The models that are not ready. */
  missing?: AiRole[];
  roles: { classifier: AiRoleState; llm: AiRoleState };
  /** The fields the bridge's environment sets (`enabled`): read-only here. */
  env: string[];
  /** A passing followups.test covers the models in use: it can be switched on. */
  tested: boolean;
}

/** `followups.update`: the whole state, flat. */
export interface FollowupsUpdate extends FollowupsState {
  t: 'followups.update';
  seq: number;
}

/** One answer of `worker.answer_followup`: yes_no "Yes" / "No", a choice's option or typed text, an open answer; a note after it. */
export interface FollowupAnswer {
  id: string;
  value: string;
  note?: string;
}

export interface FollowupsTestSample {
  name: 'questions' | 'done';
  expect: 'flag' | 'skip';
  score: number;
  flagged: boolean;
  questions?: FollowupQuestion[];
  source?: 'model' | 'fallback';
  error?: string;
}

/** `followups.test` ack: ok false with `reason` when it ran but did not pass. */
export interface FollowupsTestAck {
  ok: boolean;
  reason?: string;
  threshold: number;
  samples: FollowupsTestSample[];
  latency_ms: number;
}

// #110 pack up on request (docs/protocol.md "Pack up on request"): before a prompt goes out, whether it also tells the
// worker to leave once the task is done, and what to cut; the same settings shape as the follow-up questions'.

/** The feature's settings and state: the same fields as the follow-up questions'. */
export type PackupState = FollowupsState;

/** `packup.update`: the whole state, flat. */
export interface PackupUpdate extends PackupState {
  t: 'packup.update';
  seq: number;
}

/** A part `packup.detect` cut: [start, end) in UTF-16 code units of the text (JavaScript string indexes). */
export interface PackupRange {
  start: number;
  end: number;
}

/** `packup.detect` ack. matched false: send the prompt as written. matched: `task` is what is left (absent or empty: nothing, the send-home dialog), `removed` what was cut. */
export interface PackupDetectAck {
  matched: boolean;
  task?: string;
  removed?: PackupRange[];
  score: number;
}

export interface PackupTestSample {
  text: string;
  expect: 'match' | 'skip';
  /** One of the four the test must get right (the cut included). */
  core?: boolean;
  score: number;
  matched: boolean;
  task?: string;
  want_task?: string;
  right: boolean;
  error?: string;
}

/** `packup.test` ack: ok false with `reason` when it ran but did not pass; `right` of `total` came out as expected. */
export interface PackupTestAck {
  ok: boolean;
  reason?: string;
  threshold: number;
  samples: PackupTestSample[];
  right: number;
  total: number;
  latency_ms: number;
}

// #98 activity settings (docs/protocol.md): "Classify unknown commands", the opt-in classification of the
// shell commands the bridge's rules cannot place (the desk monitor's activity word), by the AI integration's classifier.

/** off: switched off; incomplete: on, but the classifier is not ready (nothing is sent); ready: classifying; capped: the daily cap is reached, rules only today. */
export type ActivityFeatureState = 'off' | 'incomplete' | 'ready' | 'capped';

export interface ActivityState {
  /** The "Classify unknown commands" switch (off by default). */
  model_enabled: boolean;
  /** The lowest top score the model's label needs (default 0.6). */
  threshold: number;
  /** How far the top score must beat the runner-up (default 0.2). */
  margin: number;
  /** The most classifier calls a day (default 2000). */
  daily_cap: number;
  calls_today: number;
  /** Commands whose label is remembered (normalised), so asking again costs nothing. */
  cache_size: number;
  state: ActivityFeatureState;
  /** The #92 classifier role's state. */
  classifier: AiRoleState;
  /** The fields the bridge's environment sets (`model_enabled`, HERDR_WORLD_ACTIVITY_MODEL): read-only here. */
  env: string[];
}

/** `inbox.dismissed`: the finished row of `id`, done since `status_since`, was dismissed (by any client). */
export interface InboxDismissed {
  t: 'inbox.dismissed';
  seq: number;
  id: string;
  status_since: number;
}

/** `activity.update`: the whole state, flat. */
export interface ActivityUpdate extends ActivityState {
  t: 'activity.update';
  seq: number;
}

// #118 floor overview summaries (docs/protocol.md "Floor overview summaries"): the configured LLM writes the
// overview's task and now lines (`WorkerDigest` sources `llm`), opt-in, gated on a passing `digest.test`.

/** off: switched off; incomplete: on, but the LLM is not ready (nothing is sent); ready: lines are written (until the daily cap). */
export type DigestFeatureState = 'off' | 'incomplete' | 'ready';

export interface DigestState {
  enabled: boolean;
  state: DigestFeatureState;
  /** The models that are not ready (`llm`). */
  missing?: AiRole[];
  roles: { llm: AiRoleState };
  /** The fields the bridge's environment sets (`enabled`, HERDR_WORLD_DIGEST_ENABLED): read-only here. */
  env: string[];
  /** A passing digest.test covers the LLM in use: it can be switched on. */
  tested: boolean;
  /** The most LLM calls a day (default 300); past it no new calls until tomorrow, the lines written (and cached) stay. */
  daily_cap: number;
  calls_today: number;
  /** #174: the reasoning effort chosen ('': the provider's default, nothing sent) and the completion budget in effect (default 1024). Both are this feature's only. */
  reasoning_effort: string;
  max_tokens: number;
  /** What the model's catalog says of its reasoning; `support` is `unknown` until it was read. */
  reasoning: DigestReasoning;
  /** The chosen effort is one the model does not take: it is not sent. */
  effort_stale: boolean;
}

/** #174: a model's reasoning effort as its catalog lists it. `efforts` (lowest first) is what to offer; `listed`: it is the catalog's own list. */
export interface DigestReasoning {
  support: 'supported' | 'unsupported' | 'unknown';
  model?: string;
  efforts: string[];
  listed: boolean;
  default_effort?: string;
  mandatory?: boolean;
}

/** #174: how a call ended and what it spent: never any text. */
export interface CallDiagnostics {
  status: number;
  finish_reason?: string;
  native_finish_reason?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  content: 'absent' | 'empty' | 'nonempty';
  content_chars: number;
}

/** `digest.update`: the whole state, flat. */
export interface DigestUpdate extends DigestState {
  t: 'digest.update';
  seq: number;
}

/** `digest.test` ack: the two sample lines the LLM wrote; ok false with `reason` when one came back empty. */
export interface DigestTestAck {
  ok: boolean;
  reason?: string;
  samples: Array<{ kind: 'task' | 'now'; line?: string; error?: string; diag?: CallDiagnostics }>;
  latency_ms: number;
}

// M13 screen share (docs/protocol.md "Screen share"): the TV shows the shared screen locally; the bridge asks this
// game for one frame per `screen.grab` (`screen.frame_request`, on this connection only, never replayed) and tells it
// who looked (`screen.grabbed`).

/** What `getDisplayMedia` captured: a tab, a window or a whole screen. */
export type DisplaySurface = 'browser' | 'window' | 'monitor';

export const DISPLAY_SURFACES: readonly DisplaySurface[] = ['browser', 'window', 'monitor'];

export interface ScreenState {
  sharing: boolean;
  surface?: DisplaySurface;
}

/** `screen.state`: whether a game shares, flat. */
export interface ScreenStateEvent extends ScreenState {
  t: 'screen.state';
  seq: number;
}

export interface ScreenFrameRequest {
  t: 'screen.frame_request';
  req_id: string;
}

export interface ScreenGrabbed {
  t: 'screen.grabbed';
  requester: string;
  floor: string;
  at: number;
}

export type ScreenMessage = ScreenFrameRequest | ScreenGrabbed;

/** The `screen.grab` ack. */
export interface ScreenGrabResult {
  path: string;
  bytes: number;
  w: number;
  h: number;
  surface?: DisplaySurface;
  at: number;
  expires: number;
}

/** The connection-scoped screen messages (no `seq`). A frame request id is 32 lowercase hex digits. */
export function isScreenMessage(m: ServerMessage): m is ScreenMessage {
  const o = m as unknown as Obj;
  if (m.t === 'screen.frame_request') return isStr(o.req_id) && /^[0-9a-f]{32}$/.test(o.req_id);
  if (m.t === 'screen.grabbed') return isStr(o.requester) && isStr(o.floor);
  return false;
}

// ---- M13 whiteboard (docs/protocol.md "Whiteboard") ----------------------------------------------------------------

/** An agent's pin the board's render does not show yet. */
export interface WhiteboardPin {
  id: string;
  kind: 'image' | 'note' | string;
  author: string;
  note?: string;
  file?: string;
  version: number;
  at: number;
}

/** A floor's board without its content: `whiteboard.get`'s ack, `whiteboard.updated`. */
export interface WhiteboardState {
  floor: string;
  /** 0: never saved. */
  version: number;
  author: string;
  at: number;
  /** The version render.png shows; `render` false: there is none (empty or cleared). */
  render_version: number;
  render: boolean;
  /** The render is behind `version` (agents pinned since): `stale_pins` is what it does not show. */
  stale: boolean;
  stale_pins: WhiteboardPin[];
}

export interface WhiteboardUpdated extends WhiteboardState {
  t: 'whiteboard.updated';
  seq: number;
}

export function isWhiteboardState(o: unknown): o is WhiteboardState {
  if (!isObj(o)) return false;
  return isStr(o.floor) && isInt(o.version) && isInt(o.render_version) && typeof o.render === 'boolean' && typeof o.stale === 'boolean' && Array.isArray(o.stale_pins);
}

/** One file in Drop Zone's data directory (`drops.list`), newest first; `image`: it can be pinned. */
export interface Drop {
  path: string;
  name: string;
  size: number;
  mtime: number;
  mime: string;
  image: boolean;
  /** Why not: not_image, too_large. */
  reason?: string;
}

export interface DropsListAck {
  drops: Drop[];
}

// #98 what the agent is doing (docs/protocol.md "Activity"): the bridge's label for a Claude or Codex worker's current
// tool call (rules over the tool name and shell command, the classification model for the rest when switched on), sent in
// the worker and on every change. The desk monitor shows it as a card (the word, the detail, a mascot); a client treats a
// kind it does not know as `working`.

export type ActivityKind =
  | 'thinking'
  | 'replying'
  | 'writing'
  | 'investigating'
  | 'testing'
  | 'building'
  | 'shipping'
  | 'researching'
  | 'delegating'
  | 'planning'
  | 'waiting'
  | 'image'
  | 'working';

export interface Activity {
  kind: ActivityKind;
  /**
   * Short and safe: file basename(s), the test runner or the clipped command head (≤ 32 chars). Waiting while idle:
   * what is awaited ("Testing in the background", "Monitor: e2e log", "Subagent: …", "Wakes at 14:05").
   */
  detail?: string;
  /** Unix ms (bridge clock) when this label started (waiting while idle: the turn's end). */
  since: number;
  source: 'rule' | 'model' | 'derived';
  /** Only for kind `image`: the viewed image, fetched with `transcript.image {id, hash, size: 'thumb'}`. */
  image?: { hash: string; w: number; h: number };
  /** Only for kind `waiting` while idle/done: the open background tasks. */
  tasks?: number;
}

export interface Worker {
  /** #98: present while working, and while idle/done for `waiting` on open background tasks; absent otherwise. */
  activity?: Activity;
}

/**
 * #118: the floor overview's lines for a worker, from its transcript (docs/protocol.md "Floor overview digest"). The
 * task from its first prompt on; `now_source` only once a turn of its agent was read (Claude and Codex only). `llm`: the configured LLM wrote it (#118 floor overview summaries switched on).
 */
export interface WorkerDigest {
  /** What it was asked to do, one line (≤ 80). */
  task?: string;
  task_source?: 'ai_title' | 'prompt' | 'llm' | string;
  /** What it is doing now, one line (≤ 100); absent when `now_source` is `title`: the line is the worker's own `title`. */
  now?: string;
  now_source?: 'recap' | 'title' | 'llm' | string;
  /** Unix ms (bridge clock) the `now` line was written. */
  now_at?: number;
  /** #174: what became of the model's line while a fallback shows in its place (absent: nothing awaited). */
  task_status?: DigestLineStatus;
  now_status?: DigestLineStatus;
}

/**
 * #174: `pending` (a call is out, or it waits for the daily budget: reason `daily_cap`), `retrying` (the last attempt
 * failed, the next is at `retry_at`) or `failed` (nothing is scheduled: a retry, a new prompt, a setting or, for the now
 * line, the next turn starts it again). `reason` is an `ai.*` error kind (truncated, empty_answer, bad_response,
 * provider_failed, timeout, rate_limited, auth_failed, unreachable, bad_config), `no_line` or `failed`.
 */
export interface DigestLineStatus {
  state: 'pending' | 'retrying' | 'failed';
  reason?: string;
  attempts?: number;
  /** Unix ms of the next attempt (`retrying` only). */
  retry_at?: number;
}

export interface Worker {
  /** #118 */
  digest?: WorkerDigest;
}

/** #98: a worker's activity changed (`activity` absent: cleared). At most 2 a second per worker. */
export interface WorkerActivityEvent {
  t: 'worker.activity';
  seq: number;
  id: string;
  session?: string;
  workspace_id?: string;
  activity?: Activity | null;
}
