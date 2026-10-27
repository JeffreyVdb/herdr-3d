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
// #58 virtual floors: inside the sim a floor's and a worker's `session` is the FLOOR ID (a real floor's is its session's
// name, so every fixture keeps working as it was), and `base_session` the herdr session. `emit` and `snapshot` turn that
// into the wire's shape (`Floor.id` / `session`, `Worker.floor` / `session`, `floor_id` on the floor and worker events),
// and the floor-scoped commands' `floor` arg is read as that id (an older client's `session` too). Virtual floors are
// made, renamed, hidden and deleted with `floor.create` / `floor.rename` / `floor.hide` / `floor.delete`; their wake and
// sleep are their session's (every floor of it), and a virtual floor stays in its base floor's building.
//
// Plain erasable TypeScript: node runs it directly (tools/fixture-server.ts).
import type { Building, Cap, CodexProfile, Floor, FloorSettings, Hire, HireOptions, TranscriptItem, Worker, WorkerCodex } from '../src/net/protocol.ts';
import { screensOf, type SimScreens } from './fixture-screen.ts';
import { hashOf, type StoredLogo } from './fixture-logo.ts';
import { logoPng, MAGENTA, type Palette } from './logo-art.ts';

type Msg = Record<string, unknown>;
type Send = (m: Msg) => void;
type Obj = Record<string, unknown>;
// M5: prompt, answer, changes and usage.
import { PanelsSim, simCommands, simFiles } from './fixture-panels.ts';
// M6 start: team presets and starting a run.
import { herdrInstructions, StartSim } from './fixture-start.ts';
// M6 crew: a scripted freelancer (`sim.crew`, `simcrew=<ms>`).
import { CrewSim } from './fixture-crew.ts';
// M7: the issues and pull request boards (`board.watch`, `sim.boards`, `simfail=no_m7`).
import { BoardSim } from './fixture-boards.ts';
import { KaneoSim, type KaneoDetail, type KaneoMode } from './fixture-kaneo.ts';
import { TelegramSim, type TelegramMode } from './fixture-telegram.ts';
// M10: the plan limits (`limits.refresh`, `simlimits=<scenario>`, `simfail=no_m10`).
import { LimitsSim } from './fixture-limits.ts';
// #138: the Codex profiles (`codex_profiles.*`, `simcodexprofiles=<n>`).
import { CodexProfilesSim } from './fixture-codex-profiles.ts';
// #92: the AI integration (`ai.*`, `simjev=<url>`, `simai=off`, `simfail=no_ai`).
import { AiSim } from './fixture-ai.ts';
// #90: follow-up questions (`followups.*`, `worker.answer_followup`, `sim.turn`).
import { FollowupSim } from './fixture-followup.ts';
// #213: the dictation bar's interpreter (`hire.interpret`, `sim.interpret`).
import { InterpretSim } from './fixture-interpret.ts';
// #110: pack up on request (`packup.*`, `sim.packup_lag`).
import { PackupSim } from './fixture-packup.ts';
// #118: floor overview summaries (`digest.*`).
import { DigestSim } from './fixture-digest.ts';
// #98: "Classify unknown commands" (`activity.get` / `activity.set`, `sim.activity_settings`).
import { ActivitySettingsSim } from './fixture-activity-settings.ts';
import { CodexServerSim } from './fixture-codex-server.ts';
import { ReposSim, seedRepos } from './fixture-repos.ts';
// #108: prompt secrets (`prompt_secrets.*`, every route's gate, `sim.secret_files`, `simsecrets=<key>`,
// `simsecretson=1`, `simsecretsdir=none`, `simfail=no_secrets|secrets_*|no_revoke|old_wrapup`).
import { SecretsSim } from './fixture-secrets.ts';
// #93 hire presets (`hire_preset.*`, `simhirepresets=<key>`, `simfail=no_hire_presets`); #95 the herdr hiring
// instructions (`worker.hire`'s `herdr_instructions`, `hire.prepare`'s lines, `hire_preset.check`, `sim.first_prompts`,
// `simfail=no_herdr_instructions`).
import { HirePresetSim } from './fixture-hirepreset.ts';
// #106: the inbox's dismissals (`inbox.dismiss`, `sim.status`, `simfail=no_inbox`).
import { InboxSim } from './fixture-inbox.ts';
import { ChildrenSim } from './fixture-children.ts'; // #26
// M16: the transcript view (`transcript.watch`, `sim.transcript`, `simfail=no_m16`).
import { TranscriptSim } from './fixture-transcript.ts';
// #57: agents' structured questions (`sim.ask`, `worker.answer_ask`).
import { AskSim } from './fixture-ask.ts';
// M13: the screen share (`screen.share`, `screen.grab`, `screen.frame`; the frames on POST /screen/frame/<id>).
import { ShareSim } from './fixture-share.ts';
// #98: what the agents are doing (`sim.activity`, `simactivity=demo|all`).
import { ActivitySim } from './fixture-activity.ts';
// #157: shared Codex workers' async questions (`sim.codex*`, `worker.answer_async`, `simcodex=ask`).
import { CodexQuestionsSim } from './fixture-codex-questions.ts';
// #74: the server rack's host stats (`host.watch`, `sim.host`, `simhost=<scenario>`, `simfail=no_host`).
import { HostSim } from './fixture-host.ts';
// #196: the MCP & skills wall (`mcp.inventory`, `mcp.check`, `sim.mcp`, `simmcpcheckms=<ms>`, `simfail=no_mcp`).
import { McpSim } from './fixture-mcp.ts';
// #223: literal handoffs and the filing cabinet (`worker.handoff*`, `handoff.*`, `sim.final`, `simhandoffs=<n>`, `simfail=no_handoff`).
import { HandoffSim } from './fixture-handoff.ts';
// #219: "Hire with handoff" in the background (`simhandoffhires=1`).
import { HandoffHireSim, type HireResult } from './fixture-handoffhire.ts';
// #64 schedules: scheduled agents (`schedule.*`, `sim.schedule_fire`, `sim.schedule_fail`, `simschedules=<n>`, `simfail=no_schedules`; #127 `simfail=no_schedule_instructions`).
import { ScheduleSim } from './fixture-schedule.ts';
// #66: schedule suggestions (`schedule_suggestions.*`, `worker.dismiss_schedule_suggestion`, `sim.suggest`, `simschedsuggest=`, `simsuggest=<key>`).
import { schedSuggestMode, SchedSuggestSim } from './fixture-schedsuggest.ts';
import { ManualProcessSim } from './fixture-manualproc.ts';

export interface SimOptions {
  /** Time between the scripted steps of a wake or sleep (and a hire, a send-home). */
  stepMs?: number;
  /** #26: the fixture's recorded child events, folded into the world's children (tools/fixture-children.ts). */
  childEvents?: readonly Record<string, unknown>[];
  /** `simclock=manual`: scripted timers run only when `sim.advance {ms}` releases them. */
  manualClock?: boolean;
  /**
   * `wake_failed` / `sleep_failed`: the next wake / sleep fails after its transition;
   * M4: `hire_failed` / `fire_failed` the next hire / send-home (#210: `prompt_undelivered` the next hire with a first task
   * starts its worker but acks `prompted: false`); `fetch_failed`: origin is unreachable for the
   * whole run (every prepare reports the failed `git fetch`, every worktree hire is refused with `fetch_failed`).
   * #58: `session_create_failed` the next `session.create`; `no_sessions`: an older bridge without it.
   */
  fail?: string | undefined;
  /** M4: per-floor caps `{session: {soft, hard}}` (default 24 / 32); the host's are 60 / 80. */
  caps?: Record<string, { soft: number; hard: number }>;
  /** M5: how often working agents' usage goes out as `worker.usage` (ms; 0: never; default 5000). */
  usageMs?: number;
  /** M6: plays the scripted freelancer's lifecycle by itself, a step every `crewMs` (0 / absent: only on `sim.crew`). */
  crewMs?: number;
  /** #92: where Jev is (`simjev=<url>`; default the real API) and whether the bridge has the service (`simai=off`). */
  jev?: string;
  ai?: 'on' | 'off';
  /** UI-focused feature cases can answer their model requests in process (`simmodel=packup|hiring`). */
  modelFixture?: 'packup' | 'hiring';
  /** M10: which readings the plan limits show (tools/fixture-limits.ts; default `ok`). */
  limits?: string;
  /** #138: this many Codex profiles (`simcodexprofiles=<n>`; tools/fixture-codex-profiles.ts; absent: a bridge before them). */
  codexProfiles?: number;
  /** #74: the host stats' scripted numbers (`simhost=ok|hot|noupdates|busy`) and their period (`simhostms=<ms>`, default 5000; tools/fixture-host.ts). */
  host?: string;
  hostMs?: number;
  /** #196: how long an `mcp.check` takes (`simmcpcheckms=<ms>`, default 600; tools/fixture-mcp.ts). */
  mcpCheckMs?: number;
  /** #51: this many extra Claude models (`claude-lab-01`…) on top of the three, to see a long model list (`simmodels=<n>`). */
  models?: number;
  /** #74: the bridge's pane zoom as played by the screens (tools/fixture-screen.ts; `simzoom=`; absent: a bridge before it). */
  zoom?: 'old' | 'single' | 'split' | 'headless';
  /** #175: every worker's laptop replays this recording (`simscreen=narrow`: a split pane's 60×40; absent: agent or shell). */
  screen?: 'narrow';
  /** #176: how the bridge owns the seated pane (`simcontrol=old|none|busy`, tools/fixture-screen.ts; absent: it does). */
  control?: 'old' | 'none' | 'busy';
  /** #58: a prompt's `user` item goes to its worker's transcript watch this long after the agent took it (`simecho=<ms>`; absent: never). */
  echoMs?: number;
  /** #98: seeds the workers' activities on start (`simactivity=demo|all`, tools/fixture-activity.ts). */
  activity?: string;
  /** #157: seeds a shared Codex worker's async questions on start (`simcodex=ask`, tools/fixture-codex-questions.ts). */
  codex?: string;
  /** #60: seeds Pebble's follow-up questions on start (`simfollowup=grill|fallback|fallback-fail`, tools/fixture-followup.ts). */
  followup?: string;
  /** #184: the Kaneo connection to start with (`simkaneo=off|connected|unavailable|old`, tools/fixture-kaneo.ts), and how long its slow answers take (`simkaneoslow=<ms>`). */
  kaneo?: KaneoMode;
  kaneoSlowMs?: number;
  /** #102: how a Kaneo task's `issue.get` answers to start with (`simkaneodetail=slow|fail`; `sim.kaneo {detail}` changes it). */
  kaneoDetail?: KaneoDetail;
  /** #11: the Telegram notifications to start with (`simtelegram=off|token|paired|on|env|old`, tools/fixture-telegram.ts), and when a pairing's code arrives (`simtelegrampair=<ms>`; absent: only by `sim.telegram {pair: true}`). */
  telegram?: TelegramMode;
  telegramPairMs?: number;
  /** #171: the transcript timeline every watch gets (`simtx=<name>`, default the fixture's name; tools/fixture-transcript.ts). */
  transcript?: string;
  /** #223: this many handoffs in the first floor's cabinet to start with (`simhandoffs=<n>`). */
  handoffs?: number;
  /** #9: the LLM handoffs' state and outcome with no endpoint (`simhandoffllm=`, `simhandoffllmout=`; tools/fixture-handoff.ts). */
  handoffLlm?: string;
  handoffLlmOut?: string;
  /** #219: the bridge hires after an agent or LLM handoff itself (`simhandoffhires=1`; tools/fixture-handoffhire.ts). */
  handoffHires?: boolean;
  /** #64 schedules: this many schedules across the first two floors to start with (`simschedules=<n>`; tools/fixture-schedule.ts). */
  schedules?: number;
  /** #66: the schedule suggestions' state with no models (`simschedsuggest=on|off|incomplete|env|env-off|none`), and Zippy's seeded suggestion, remembered by the key (`simsuggest=<key>`; tools/fixture-schedsuggest.ts). */
  schedSuggest?: string;
  suggestKey?: string;
  manual?: string;
  commandRequest?: string;
  /** #247: `simrepos=<key>`: demo-m5's floors set up for `@r:`, the shared switch shared by the key's connections (tools/fixture-repos.ts). */
  repos?: string;
  /** #93: `simhirepresets=<key>`: the hire presets shared by the key's connections, as a bridge's database (tools/fixture-hirepreset.ts). */
  hirePresets?: string;
  /** #108: `simsecrets=<key>` shares the prompt-secrets switch, `simsecretson=1` starts it on, `simsecretsdir=none` has no private directory (tools/fixture-secrets.ts). */
  secrets?: string;
  secretsOn?: boolean;
  secretsDir?: 'none';
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

/** The M3 contract's lists (same as DEFAULT_HIRE_OPTIONS in src/world/store.ts). */
export const SIM_HIRE_OPTIONS: HireOptions = {
  claude: { models: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
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
  readonly data?: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
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

/** #58: a virtual floor's name: trimmed, 1-64 bytes, no control characters. */
function vfloorName(a: Obj): string {
  const n = str(a, 'name').trim();
  if (!n || bytes(n) > 64 || /[\u0000-\u001f\u007f]/.test(n)) throw new CmdError('bad_request', 'A floor name is 1-64 bytes, no control characters.');
  return n;
}

function cleanName(v: string): string {
  const n = v.trim();
  if (!n || bytes(n) > 64) throw new CmdError('bad_request', 'invalid argument: building name must be 1-64 bytes');
  return n;
}

/** #58: the floor-scoped commands whose floor arg was `session` before #58 (`floor` now; the sim reads either). */
const FLOOR_ARG = new Set([
  'floor.assign',
  'floor.wake',
  'floor.sleep',
  'floor.settings.set',
  'hire.prepare',
  'hire.commands',
  'hire.files',
  'hire.repos',
  'worker.hire',
  'run.prepare',
  'run.start',
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
  'mcp.inventory',
  'mcp.check',
]);

/** #58: events naming a worker's floor by `session` inside the sim (`floor_id` on the wire). */
const WORKER_FLOOR_EVENTS = new Set(['worker.status', 'worker.removed', 'worker.usage', 'worker.activity', 'floor.removed', 'handoff.added', 'handoff.removed']);

/** #58: sessions herdr has (asleep) that are not floors: session.create refuses their names. */
const SIM_HERDR_ONLY = ['old-notes'];
/** #58: the sim host's sun_path cap on a new session's name. */
const SIM_MAX_SESSION = 56;

export class SimWorld {
  seq: number;
  private readonly buildings = new Map<string, Omit<Building, 'floors'>>();
  private readonly floors = new Map<string, Floor>();
  private readonly workers: Worker[];
  private readonly hire: HireOptions;
  private readonly hireSent: boolean;
  /** Worker statuses from before a sleep, restored on wake. */
  private readonly beforeSleep = new Map<string, string>();
  /** #58: the names a `session.create` is starting. */
  private readonly creating = new Set<string>();
  private readonly timers = new Set<unknown>();
  private readonly stepMs: number;
  private fail: string | undefined;
  private readonly zoomMode: SimOptions['zoom'];
  private readonly screenName: SimOptions['screen'];
  private readonly controlMode: SimOptions['control'];
  private nextId = 0;
  /** M4: desks a hire in flight reserved, per floor (`session:desk`). */
  private readonly hiring = new Set<string>();
  /** M4: workers being sent home right now. */
  private readonly leaving = new Set<string>();
  /** M4: the last harness/model/effort hired per floor. */
  private readonly lastHire = new Map<string, Hire>();
  /** #95: each hire's first prompt as the worker gets it (the herdr hiring instructions added), in order (`sim.first_prompts`). */
  private readonly firstPrompts: Array<{ id: string; floor: string; prompt: string }> = [];
  /** M4: the branch the bridge recorded making for a worker (`hire_branch`), by worker id. */
  private readonly hireBranch = new Map<string, string>();
  /** M4 `simfail=fetch_failed`: `git fetch origin` fails in every repo. */
  private readonly originDown: boolean;
  private readonly caps: Record<string, { soft: number; hard: number }>;
  private readonly now: () => number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (h: unknown) => void;
  private manualTime: number | null = null;
  private readonly manualTimers = new Map<object, { at: number; fn: () => void }>();

  constructor(snapshot: { seq: number; world: Obj }, o: SimOptions = {}) {
    const w = structuredClone(snapshot.world) as { buildings: Building[]; floors: Floor[]; workers: Worker[]; hire_options?: HireOptions };
    this.seq = snapshot.seq;
    for (const b of w.buildings) this.buildings.set(b.id, { id: b.id, name: b.name, sort: b.sort });
    // #58: inside the sim `session` is the floor id (see the top).
    for (const f of w.floors) {
      const id = f.id ?? f.session;
      const x: Floor = { ...f, session: id, base_session: f.base_session ?? f.session, name: f.name ?? f.session };
      delete x.id;
      this.floors.set(id, x);
    }
    this.workers = w.workers;
    for (const x of this.workers) {
      if (x.floor) x.session = x.floor;
      delete x.floor;
    }
    const base = structuredClone(w.hire_options ?? SIM_HIRE_OPTIONS);
    if (o.models && base.claude) base.claude.models.push(...Array.from({ length: o.models }, (_, i) => `claude-lab-${String(i + 1).padStart(2, '0')}`));
    this.hire = base;
    this.hireSent = w.hire_options !== undefined || !!o.models;
    this.stepMs = o.stepMs ?? 600;
    this.originDown = o.fail === 'fetch_failed';
    this.fail = this.originDown ? undefined : o.fail;
    // The fixture's h3d/… branches stand for earlier hires by the bridge (it recorded them); any other branch is the user's.
    for (const x of this.workers) if (x.branch?.startsWith('h3d/') && x.worktree?.linked) this.hireBranch.set(x.id, x.branch);
    this.caps = o.caps ?? {};
    this.handoffMode = o.fail === 'no_handoff' ? 'off' : 'on'; // #223
    this.handoffSeed = o.handoffs ?? 0;
    this.scheduleMode = o.fail === 'no_schedules' ? 'off' : 'on'; // #64 schedules
    this.scheduleSeed = o.schedules ?? 0;
    this.scheduleInstructions = o.fail !== 'no_schedule_instructions' && o.fail !== 'no_herdr_instructions'; // #127
    this.schedSuggestMode = o.schedSuggest; // #66
    this.suggestKey = o.suggestKey ?? null;
    this.manualPreset = o.manual;
    this.commandRequestPreset = o.commandRequest;
    this.handoffLlm = { ...(o.handoffLlm ? { state: o.handoffLlm } : {}), ...(o.handoffLlmOut ? { outcome: o.handoffLlmOut } : {}) }; // #9
    this.handoffHireMode = o.handoffHires === true && this.handoffMode === 'on'; // #219
    this.now = o.now ?? (() => Date.now());
    this.setT = o.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = o.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    if (o.manualClock) {
      this.manualTime = 0;
      this.setT = (fn, ms) => {
        const h = {};
        this.manualTimers.set(h, { at: (this.manualTime ?? 0) + ms, fn });
        return h;
      };
      this.clearT = (h) => this.manualTimers.delete(h as object);
    }
    if (o.usageMs !== undefined) this.usageMs = o.usageMs;
    // M6 start (tools/fixture-start.ts): `simfail=no_m6` plays an M5 bridge.
    this.start6 = new StartSim(
      {
        floors: this.floors,
        workers: this.workers,
        hire: this.hire,
        emit: (send, m) => this.emit(send, m),
        prepare: (session, preview) => this.hirePrepare(preview ? { session, preview } : { session }),
        hireWorker: (a, send, ack, fail) => this.hireWorker(a, send, ack, fail),
        error: (code, message) => new CmdError(code, message),
        workItem: (session, wi) => this.kaneo.resolveWorkItem(session, wi) ?? this.boards.resolveWorkItem(session, wi),
        // #167: the Codex profiles sim (made below), read when a run or a preset asks.
        ...(o.codexProfiles
          ? {
              runProfiles: {
                list: () => {
                  const w: Record<string, unknown> = {};
                  this.codexProfiles?.decorate(w);
                  return (w.codex_profiles as { profiles: CodexProfile[] } | undefined)?.profiles ?? [];
                },
                pick: (cwd: string) => (this.codexProfiles as CodexProfilesSim).pick(cwd, this.limits.codexBase()),
              },
            }
          : {}),
      },
      o.fail !== 'no_m6',
      (snapshot.world as { presets?: unknown }).presets,
    );
    if (o.crewMs !== undefined) this.crewMs = o.crewMs;
    this.echoMs = o.echoMs ?? null;
    this.zoomMode = o.zoom;
    this.screenName = o.screen;
    this.controlMode = o.control;
    this.transcripts = new TranscriptSim(
      {
        worker: (id) => this.workers.find((x) => x.id === id),
        floor: (session) => this.floors.get(session),
        now: this.now,
        error: (code, message) => new CmdError(code, message),
        extra: (id) => [...this.asks.extra(id), ...this.handoffs.extra(id)], // #223: the replies and prompts sim.final played
        activityHash: (id) => this.activity.hash(id),
        child: (worker, id) => this.children.get(worker, id), // #26
      },
      o.fail !== 'no_m16',
      o.transcript,
    );
    this.activity = new ActivitySim(
      { workers: this.workers, floors: this.floors, emit: (send, m) => this.emit(send, m), now: this.now, error: (code, message) => new CmdError(code, message) },
      o.activity,
    );
    this.ai = new AiSim(o.jev ?? 'https://api.typesafe.ai', o.fail === 'no_ai' ? 'old' : (o.ai ?? 'on'), (send, m) => this.emit(send, m), (code, message) => new CmdError(code, message), o.modelFixture);
    this.ai.onChange = (send) => {
      this.followups.changed(send); // #90: a model's state is the feature's
      this.schedSuggest.changed(send); // #66: and the schedule suggestions'
      this.packup.changed(send); // #110: and pack up's
      this.digest.changed(send); // #118: and the summaries' (the LLM's)
      this.handoffs.llmChanged(send); // #9: and the LLM handoffs' 
      this.activitySettings.changed(send); // #98: the classifier's too
    };
    this.activitySettings = new ActivitySettingsSim({ ai: this.ai, emit: (send, m) => this.emit(send, m), error: (code, message) => new CmdError(code, message) });
    if (o.codex) this.codexq.seed(o.codex); // #157
    if (o.followup) this.followups.seed(o.followup); // #60
    if (this.suggestKey !== null) this.schedSuggest.seed();
    this.manual.seed(); // #66
    if (o.repos !== undefined) seedRepos(this.floors, [...this.buildings.values()]); // #247
    this.repos = new ReposSim(
      {
        layout: () => {
          const buildings = this.sorted();
          return { buildings, unassigned: [...this.floors.values()].filter((f) => f.building === null).map((f) => f.session).sort() };
        },
        floor: (s) => this.floors.get(s),
        sessionOf: (id) => this.workers.find((w) => w.id === id)?.session,
        emit: (send, m) => this.emit(send, m),
        error: (code, message) => new CmdError(code, message),
      },
      o.repos ?? null,
      (m) => this.announce(m),
    );
    this.secrets = new SecretsSim(
      {
        emit: (send, m) => this.emit(send, m),
        error: (code, message) => new CmdError(code, message),
        takeFailure: (code) => this.takeFailure(code),
        hasWorker: (id) => this.workers.some((w) => w.id === id),
      },
      {
        key: o.secrets ?? null,
        on: o.secretsOn === true,
        available: o.secretsDir !== 'none',
        supported: o.fail !== 'no_secrets',
        announce: (m) => this.announce(m),
        revoke: o.fail !== 'no_revoke',
        wrapupHandover: o.fail !== 'old_wrapup',
      },
    ); // #108
    this.hirePresets = new HirePresetSim(
      { hasFloor: (id) => this.floors.has(id), hire: this.hire, emit: (send, m) => this.emit(send, m), error: (code, message) => new CmdError(code, message), now: () => this.now(), ai: this.ai },
      o.fail !== 'no_hire_presets',
      o.hirePresets ?? null,
      (m) => this.announce(m),
      o.fail !== 'no_herdr_instructions',
    ); // #93, #95
    this.codexServer = new CodexServerSim({ emit: (send, m) => this.emit(send, m), error: (code, message) => new CmdError(code, message) }, o.fail !== 'no_codex_run', o.fail === 'codex_unverified', o.fail === 'codex_direnv'); // #155, #186, #116
    this.children = new ChildrenSim({ workers: this.workers, emit: (send, m) => this.emit(send, m), error: (code, message) => new CmdError(code, message) }, o.childEvents ?? []);
    this.inbox = new InboxSim({ workers: this.workers, emit: (send, m) => this.emit(send, m), error: (code, message) => new CmdError(code, message), now: () => this.now() }, o.fail !== 'no_inbox');
    this.host = new HostSim(
      o.host ?? 'ok',
      o.fail !== 'no_host',
      o.hostMs ?? 5000,
      (fn, ms) => {
        const h = this.setT(() => {
          this.timers.delete(h);
          fn();
        }, ms);
        this.timers.add(h);
        return h;
      },
      (h) => {
        this.clearT(h);
        this.timers.delete(h);
      },
      this.now,
      (code, message) => new CmdError(code, message),
    );
    this.mcp = new McpSim(
      {
        checkouts: (floor) => {
          const f = this.floor({ session: floor });
          const d = this.defaultCwd(f);
          const all = [d];
          for (const w of this.workers) {
            const r = w.session === f.session ? this.rootOf(w) : undefined;
            if (r && !all.includes(r)) all.push(r);
          }
          return { default: d, all };
        },
        expected: (floor) => this.floors.get(floor)?.settings?.expected_mcp,
        profile: (key) => (this.codexProfiles ? this.codexProfiles.find(key) : key === null ? { key: '', name: '' } : null),
        later: (fn, ms) => {
          const h = this.setT(() => {
            this.timers.delete(h);
            fn();
          }, ms);
          this.timers.add(h);
          return h;
        },
        now: this.now,
        error: (code, message) => new CmdError(code, message),
      },
      o.fail !== 'no_mcp',
      o.mcpCheckMs,
    );
    this.codexProfiles = o.codexProfiles ? new CodexProfilesSim({ emit: (send, m) => this.emit(send, m), error: (code, message) => new CmdError(code, message), now: this.now }, o.codexProfiles) : null; // #138
    this.limits = new LimitsSim(o.limits ?? 'ok', o.fail !== 'no_m10', this.now, (send, m) => this.emit(send, m), (code, message) => new CmdError(code, message), this.codexProfiles);
    this.codexProfiles?.seed(this.workers); // #139
    if (this.codexProfiles) this.hirePresets.seed(CodexProfilesSim.GONE_PRESET); // #139: a preset whose profile is gone
    this.boards = new BoardSim(
      {
        floors: this.floors,
        workers: this.workers,
        now: this.now,
        later: (fn, ms) => {
          const h = this.setT(() => {
            this.timers.delete(h);
            fn();
          }, ms);
          this.timers.add(h);
          return h;
        },
        error: (code, message) => new CmdError(code, message),
        hireBranch: (id) => this.hireBranch.get(id),
        dirty: (w) => this.tree(w).dirty.length > 0,
      },
      o.fail !== 'no_m7',
    );
    this.kaneo = new KaneoSim(
      {
        floors: this.floors,
        emit: (send, m) => this.emit(send, m),
        error: (code, message) => new CmdError(code, message),
        later: (fn, ms) => {
          const h = this.setT(() => {
            this.timers.delete(h);
            fn();
          }, ms);
          this.timers.add(h);
          return h;
        },
        now: this.now,
      },
      o.kaneo ?? 'off',
      o.kaneoSlowMs ?? 1500,
      o.kaneoDetail ?? null,
    );
    this.telegram = new TelegramSim(
      {
        emit: (send, m) => this.emit(send, m),
        error: (code, message) => new CmdError(code, message),
        later: (fn, ms) => {
          const h = this.setT(() => {
            this.timers.delete(h);
            fn();
          }, ms);
          this.timers.add(h);
          return h;
        },
        now: this.now,
      },
      o.telegram ?? 'off',
      o.telegramPairMs ?? null,
    );
  }

  /** M10: the plan limits (tools/fixture-limits.ts). */
  private readonly limits: LimitsSim;
  /** #74: the host stats of the server rack (tools/fixture-host.ts). */
  private readonly host: HostSim;
  /** #196: the MCP & skills wall (tools/fixture-mcp.ts). */
  private readonly mcp: McpSim;
  /** #92: the AI integration (tools/fixture-ai.ts). */
  private readonly ai: AiSim;
  /** #98: "Classify unknown commands" (tools/fixture-activity-settings.ts). */
  private readonly activitySettings: ActivitySettingsSim;
  /** #155: the shared Codex server switch (tools/fixture-codex-server.ts). */
  private readonly codexServer: CodexServerSim;
  /** #138: the Codex profiles (null: a bridge before them). */
  private readonly codexProfiles: CodexProfilesSim | null;
  /** #247: repositories on other floors (tools/fixture-repos.ts). */
  private readonly repos: ReposSim;
  /** #108: prompt secrets (tools/fixture-secrets.ts). */
  private readonly secrets: SecretsSim;
  private readonly hirePresets: HirePresetSim; // #93
  private readonly inbox: InboxSim;
  private readonly children: ChildrenSim; // #26
  /** M13: the screen share (tools/fixture-share.ts). */
  private readonly share = new ShareSim(
    (send, m) => this.emit(send, m),
    (code, message) => new CmdError(code, message),
    (session) => this.floors.has(session),
  );
  private readonly transcripts: TranscriptSim;
  private readonly handoffMode: 'on' | 'off';
  private readonly handoffSeed: number;
  private readonly scheduleMode: 'on' | 'off';
  private readonly scheduleSeed: number;
  private readonly scheduleInstructions: boolean;
  private readonly schedSuggestMode: string | undefined; // #66
  private readonly suggestKey: string | null;
  private readonly manualPreset: string | undefined;
  private readonly commandRequestPreset: string | undefined;
  private readonly handoffLlm: { state?: string; outcome?: string };
  private readonly handoffHireMode: boolean;
  /** #98: the agents' activities (tools/fixture-activity.ts). */
  private readonly activity: ActivitySim;

  /** M7: boards, work items and opening a PR (tools/fixture-boards.ts). */
  private readonly boards: BoardSim;
  /** #184: the Kaneo connection and Kaneo floors' boards (tools/fixture-kaneo.ts). */
  private readonly kaneo: KaneoSim;
  /** #11: the Telegram notifications (tools/fixture-telegram.ts). */
  private readonly telegram: TelegramSim;

  /** M6 start: presets and runs (tools/fixture-start.ts). */
  private readonly start6: StartSim;

  dispose(): void {
    this.share.dispose();
    this.repos.dispose(); // #247
    this.secrets.dispose(); // #108
    this.hirePresets.dispose(); // #93
    this.host.dispose(); // #74
    for (const t of this.timers) this.clearT(t);
    this.timers.clear();
  }

  /** Release timers in deadline order, including timers scheduled by another step. The wall clock still dates events. */
  private advance(a: Obj): void {
    onlyKeys(a, ['ms']);
    if (this.manualTime === null) throw new CmdError('invalid_state', 'sim.advance needs simclock=manual');
    const ms = a.ms;
    if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms < 0 || ms > 60_000) throw bad('ms must be an integer from 0 to 60000');
    const until = this.manualTime + ms;
    for (;;) {
      let next: [object, { at: number; fn: () => void }] | null = null;
      for (const entry of this.manualTimers) if (entry[1].at <= until && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.manualTimers.delete(next[0]);
      this.manualTime = next[1].at;
      next[1].fn();
    }
    this.manualTime = until;
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
    const logo = this.logos.get(id);
    return { ...b, floors: this.floorsOf(id), ...(logo ? { logo: logo.hash } : {}) };
  }

  // ---- M3d building logos (tools/fixture-logo.ts) --------------------------

  private readonly logos = new Map<string, StoredLogo>();
  private out: Send | null = null;

  logoOf(id: string): StoredLogo | undefined {
    return this.logos.get(id);
  }

  /** M13: an event from the HTTP side (tools/fixture-whiteboard.ts), in this world's sequence. */
  announce(m: Msg): void {
    if (this.out) this.emit(this.out, m);
  }

  /** The `simfail` still pending, for the HTTP side. */
  failure(): string | undefined {
    return this.fail;
  }

  /** True (and used up) when `simfail` is `code`. */
  takeFailure(code: string): boolean {
    if (this.fail !== code) return false;
    this.fail = undefined;
    return true;
  }

  /** Stores a logo and tells the client, like the bridge's PUT /logo/{id}. */
  setLogo(id: string, logo: StoredLogo): StoredLogo {
    this.building(id);
    this.logos.set(id, logo);
    if (this.out) this.emit(this.out, { t: 'building.upsert', building: this.building(id) });
    return logo;
  }

  /** `simlogos=1`: every building starts with a made-up logo (a ring and three bars, a colour of its own), for perf runs. */
  seedLogos(): void {
    const rings: Palette['ring'][] = [MAGENTA.ring, [47, 107, 240], [18, 162, 106], [242, 169, 59], [138, 90, 200]];
    let i = 0;
    for (const b of this.sorted()) {
      const bytes = logoPng(512, 192, { ring: rings[i++ % rings.length] as Palette['ring'], bars: MAGENTA.bars });
      this.logos.set(b.id, { bytes, hash: hashOf(bytes), type: 'image/png' });
    }
  }

  clearLogo(id: string): void {
    this.building(id);
    if (!this.logos.delete(id)) return;
    if (this.out) this.emit(this.out, { t: 'building.upsert', building: this.building(id) });
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
    world.prepare_preview = true; // #134
    this.start6.decorate(world);
    this.boards.decorate(world as { workers?: Worker[] });
    this.limits.decorate(world);
    this.ai.decorate(world); // #92
    this.followups.decorate(world); // #90
    this.schedSuggest.decorate(world); // #66
    this.packup.decorate(world); // #110
    this.digest.decorate(world); // #118
    this.activitySettings.decorate(world); // #98
    this.codexServer.decorate(world); // #155
    this.codexProfiles?.decorate(world); // #138
    this.repos.decorate(world); // #247
    this.secrets.decorate(world); // #108
    this.hirePresets.decorate(world); // #93
    this.kaneo.decorate(world); // #184
    this.telegram.decorate(world); // #11
    this.handoffs.decorate(world); // #223
    this.schedules.decorate(world);
    this.manual.decorate(world); // #64 schedules
    this.inbox.decorate(world); // #106
    this.children.decorate(world); // #26
    this.share.decorate(world); // M13
    const out = structuredClone(world);
    // #58: the wire's shape (see the top).
    out.floors = (out.floors as Floor[]).map((f) => this.wireFloor(f));
    out.workers = (out.workers as Worker[]).map((x) => this.wireWorker(x));
    return { t: 'world.snapshot', seq: this.seq, world: out };
  }

  /** #58: a floor's herdr session (a virtual floor's base session; the sim's `session` is the floor id). */
  private baseOf(id: string): string {
    return this.floors.get(id)?.base_session ?? this.goneBase.get(id) ?? id;
  }

  /** #58: the herdr sessions of floors that went (their `floor.removed`). */
  private readonly goneBase = new Map<string, string>();

  /** #58: a sim floor as the wire has it: `id` the floor id, `session` its herdr session. */
  wireFloor(f: Floor): Floor {
    const base = f.base_session ?? f.session;
    return { ...f, id: f.session, name: f.name ?? f.session, session: base, base_session: base, virtual: f.virtual === true, hidden: f.hidden === true };
  }

  /** #58: a sim worker as the wire has it: `floor` the floor id, `session` its herdr session. */
  private wireWorker(w: Worker): Worker {
    return { ...w, floor: w.session, session: this.baseOf(w.session) };
  }

  private emit(send: Send, m: Msg): void {
    const x = structuredClone(m);
    // #58: the wire's shape (see the top).
    if (x.floor && typeof x.floor === 'object') x.floor = this.wireFloor(x.floor as Floor);
    if (x.worker && typeof x.worker === 'object') x.worker = this.wireWorker(x.worker as Worker);
    if (typeof x.t === 'string' && WORKER_FLOOR_EVENTS.has(x.t) && typeof x.session === 'string') {
      x.floor_id = x.session;
      x.session = this.baseOf(x.session);
    }
    if ((x.t === 'board.issues' || x.t === 'board.prs') && typeof x.session === 'string') {
      x.floor = x.session;
      x.session = this.baseOf(x.session);
    }
    send({ ...x, seq: ++this.seq });
    // #219: a source worker that leaves takes its waiting handoff hires with it.
    if (m.t === 'worker.removed' && typeof m.id === 'string') this.handoffHireSim?.sourceGone(m.id, send);
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

  /** #58: every floor of `f`'s herdr session (its real floor and its virtual floors): a wake or a sleep is theirs. */
  private sessionFloors(f: Floor): Floor[] {
    const base = f.base_session ?? f.session;
    return [...this.floors.values()].filter((x) => (x.base_session ?? x.session) === base);
  }

  // ---- commands ------------------------------------------------------------

  /** Answers one client message (after the hello). */
  handle(m: Obj, send: Send): void {
    const reqId = m.req_id;
    if (typeof reqId !== 'string' || !reqId) {
      send({ t: 'error', code: 'bad_request', message: 'missing req_id' });
      return;
    }
    let ack = (data?: unknown) => send(data === undefined ? { t: 'ack', req_id: reqId } : { t: 'ack', req_id: reqId, data });
    let fail = (e: unknown) => {
      const err = e instanceof CmdError ? e : e instanceof Error && 'code' in e && typeof e.code === 'string' ? new CmdError(e.code, e.message) : new CmdError('internal', String(e));
      send({ t: 'error', req_id: reqId, code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) });
    };
    try {
      const a = m.args === undefined || m.args === null ? {} : m.args;
      if (!isObj(a)) throw bad('args must be an object');
      // #58: the floor id goes where the sim reads it (`session`: see the top); `floor` wins over an older client's `session`.
      if (typeof m.t === 'string' && FLOOR_ARG.has(m.t) && typeof a.floor === 'string') {
        a.session = a.floor;
        delete a.floor;
      }
      // M5: laptop screens and seated input (tools/fixture-screen.ts); world events close the watches they end.
      const screens = screensOf(this, () => ({
        worker: (id: string) => this.workers.find((w) => w.id === id),
        manualProcess: (id: string) => this.manual.has(id),
        floor: (s: string) => this.floors.get(s),
        later: (fn: () => void, ms: number) => {
          const h = this.setT(() => {
            this.timers.delete(h);
            fn();
          }, ms);
          this.timers.add(h);
          return h;
        },
        cancel: (h: unknown) => {
          this.clearT(h);
          this.timers.delete(h);
        },
        now: () => this.now(),
        failNext: (code: string) => this.fail === code && ((this.fail = undefined), true),
        zoomMode: () => this.zoomMode,
        recording: () => this.screenName,
        controlMode: () => this.controlMode,
      }));
      send = screens.tap(send);
      // M16: world events end the transcript watches they concern, too.
      const plain = send;
      send = (x: Msg) => {
        plain(x);
        this.transcripts.onEvent(x);
      };
      // #108: prompt secrets' commands (a revoke changes a worker's `secret_files`); every route that carries typed
      // text passes their gate first, and is from here on its texts with their references (round 2).
      if (this.secrets.handle(m.t, a, send, (d) => (this.syncSecretFiles(send), ack(d)))) return;
      // #219: a request with a hire is known by its args as sent, before the gate puts any of its texts in files.
      if (m.t === 'worker.handoff' && this.handoffHireMode) this.handoffHires.note(a);
      const g = this.secrets.gate(m.t, a, send, { packupLooks: (id) => this.packup.looksAt(id), schedulePrompt: (id) => this.schedules.promptOf(id) });
      if (g) {
        const [plainAck, plainFail] = [ack, fail];
        ack = (data?: unknown) => {
          const d = g.ack(data);
          this.syncSecretFiles(send);
          plainAck(d);
        };
        fail = (e: unknown) => {
          g.fail();
          this.syncSecretFiles(send);
          plainFail(e);
        };
      }
      // #90: a prompt or keys make a worker's follow-up questions moot.
      if (m.t === 'worker.prompt' || m.t === 'worker.keys') this.followups.clear(a.id, send);
      // #66: the transcript going on makes a worker's schedule suggestion moot; a save from it closes it.
      if (m.t === 'worker.prompt' || m.t === 'sim.prompt_turn' || m.t === 'sim.final') this.schedSuggest.moved(a.id, send);
      if (m.t === 'schedule.create') {
        const created = ack;
        ack = (data?: unknown) => {
          this.schedSuggest.created(a.source, send);
          created(data);
        };
      }
      if (this.manual.handle(m.t, a, send, ack, fail)) return;
      if (this.schedSuggest.handle(m.t, a, send, ack, fail)) return;
      if (this.followups.handle(m.t, a, send, ack, fail)) return;
      if (this.packup.handle(m.t, a, send, ack, fail)) return; // #110
      if (this.interpreter.handle(m.t, a, ack, fail)) return; // #213
      if (this.digest.handle(m.t, a, send, ack, fail)) return; // #118 (board.watch passes on to the boards)
      if (this.transcripts.handle(m.t, a, send, ack, fail)) return;
      if (this.asks.handle(m.t, a, send, ack, fail)) return;
      if (this.codexq.handle(m.t, a, send, ack, fail)) return; // #157
      if (this.activity.handle(m.t, a, send, ack, fail)) return; // #98
      if (screens.handle(m.t, a, send, ack, (code, message) => send({ t: 'error', req_id: reqId, code, message }))) return;
      if (this.start6.handle(m.t, a, send, ack, fail)) return;
      if (this.kaneo.handle(m.t, a, send, ack, fail)) return; // #184: a Kaneo floor's board, before the GitHub ones
      if (this.telegram.handle(m.t, a, send, ack, fail)) return; // #11
      if (this.boards.handle(m.t, a, send, ack, fail)) return;
      if (this.limits.handle(m.t, send, ack)) return;
      if (this.host.handle(m.t, a, send, ack)) return; // #74
      if (this.mcp.handle(m.t, a, ack, fail)) return; // #196
      if (this.ai.handle(m.t, a, send, ack, fail)) return; // #92
      if (this.activitySettings.handle(m.t, a, send, ack)) return; // #98
      if (this.codexServer.handle(m.t, a, send, ack)) return; // #155
      if (this.codexProfiles?.handle(m.t, a, send, ack, () => this.limits.codexBase())) return; // #138
      if (this.repos.handle(m.t, a, send, ack)) return; // #247
      if (this.hirePresets.handle(m.t, a, send, ack)) return; // #93
      if (this.inbox.handle(m.t, a, send, ack)) return; // #106
      if (this.children.handle(m.t, a, send, ack)) return; // #26
      if (this.handoffs.handle(m.t, a, send, ack, fail)) return; // #223, #9
      if (this.schedules.handle(m.t, a, send, ack, fail)) return; // #64 schedules
      if (this.share.handle(m.t, a, send, ack, fail)) return; // M13
      switch (m.t) {
        case 'sim.advance':
          this.advance(a);
          return ack();
        case 'sim.first_prompts': // #95: the simulator's own, not a bridge command
          return ack(structuredClone(this.firstPrompts));
        case 'sim.swap': // #52
          return ack(this.swap(a, send, screens));
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
        case 'session.create': // #58
          return this.createSession(a, send, ack, fail);
        case 'floor.create': // #58
          return ack(this.createFloor(a, send));
        case 'floor.rename':
          return ack(this.renameFloor(a, send));
        case 'floor.hide':
          return ack(this.hideFloor(a, send));
        case 'floor.delete':
          return ack(this.deleteFloor(a, send));
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
        // #83: wrap up, then send home; `sim.wrapup` plays the agent's result line.
        case 'worker.wrapup':
          return ack(this.wrapUp(a, send));
        case 'worker.wrapup.cancel':
          return ack(this.wrapUpCancel(a, send));
        case 'sim.wrapup':
          return this.wrapUpResult(a, send, ack);
        // M5 (tools/fixture-panels.ts)
        case 'worker.prompt':
          return this.panels.prompt(a, send, ack, fail);
        case 'worker.answer':
          return this.panels.answer(a, send, ack);
        case 'worker.changes':
          return this.panels.changes(a, ack, fail);
        case 'worker.commands': // #136
          return this.panels.commands(a, ack);
        case 'worker.files': // #137
          return this.panels.files(a, ack);
        case 'hire.commands': // #39
        case 'hire.files':
        case 'hire.repos':
          return this.hireLookup(m.t, a, ack);
        // M6 crew (tools/fixture-crew.ts): the simulator's own, not a bridge command.
        case 'sim.crew':
          return ack(this.crew.handle(a, send));
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
    this.logos.delete(id);
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
    // #58 decision 4: a virtual floor only moves within its base floor's building.
    if (f.virtual && (to === null || to !== f.building)) throw bad('a virtual floor stays in its base session’s building: only its position can change');
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
    // #58 decision 4: a real floor takes its virtual floors along, right after it (unassigned: they are too).
    if (!f.virtual && from !== to) {
      const vs = this.sessionFloors(f).filter((x) => x.virtual);
      if (from !== null) reindex(from, this.floorsOf(from).filter((s) => !vs.some((v) => v.session === s)));
      for (const v of vs) {
        v.building = null;
        v.index = null;
      }
      if (to !== null) {
        const list = this.floorsOf(to);
        list.splice(list.indexOf(f.session) + 1, 0, ...vs.map((v) => v.session));
        reindex(to, list);
      }
    }
    for (const x of this.floors.values()) if (before.get(x.session) !== `${x.building}:${x.index}`) this.floorEvent(send, x);
    for (const id of new Set([from, to])) if (id !== null && this.buildings.has(id)) this.emit(send, { t: 'building.upsert', building: this.building(id) });
    return undefined;
  }

  // ---- #58: virtual floors -------------------------------------------------------

  /** `floor.create {name, base_session}`: a virtual floor, last in its base floor's building (the lot with it). */
  private createFloor(a: Obj, send: Send): Floor {
    onlyKeys(a, ['name', 'base_session']);
    const name = vfloorName(a);
    const base = str(a, 'base_session');
    const real = this.floors.get(base);
    if (!real || real.virtual) throw new CmdError('unknown_session', `unknown session: "${base}"`);
    let id = '';
    do id = `v-${(++this.nextId).toString(16).padStart(12, '0')}`;
    while (this.floors.has(id));
    const f: Floor = { session: id, name, base_session: base, virtual: true, hidden: false, state: real.state, building: real.building, index: null, desks: 6 };
    if (real.transition) f.transition = real.transition;
    this.floors.set(id, f);
    if (real.building !== null) {
      const list = this.floorsOf(real.building).filter((s) => s !== id);
      list.push(id);
      list.forEach((s, i) => ((this.floors.get(s) as Floor).index = i));
    }
    this.floorEvent(send, f);
    if (real.building !== null) this.emit(send, { t: 'building.upsert', building: this.building(real.building) });
    return this.wireFloor(f);
  }

  private virtualFloor(a: Obj): Floor {
    const id = str(a, 'floor');
    const f = this.floors.get(id);
    if (!f) throw new CmdError('not_found', `no floor “${id}”`);
    if (!f.virtual) throw bad('only a virtual floor can be renamed or deleted');
    return f;
  }

  private renameFloor(a: Obj, send: Send): undefined {
    onlyKeys(a, ['floor', 'name']);
    const f = this.virtualFloor(a);
    f.name = vfloorName(a);
    this.floorEvent(send, f);
    return undefined;
  }

  /** `floor.hide {floor, hidden}` (decision 2): stored and broadcast; the client hides it while it has no worker. */
  private hideFloor(a: Obj, send: Send): undefined {
    onlyKeys(a, ['floor', 'hidden']);
    const id = str(a, 'floor');
    const f = this.floors.get(id);
    if (!f) throw new CmdError('unknown_session', `unknown session: "${id}"`);
    if (typeof a.hidden !== 'boolean') throw bad('hidden must be a bool');
    if ((f.hidden === true) === a.hidden) return undefined;
    f.hidden = a.hidden;
    this.floorEvent(send, f);
    return undefined;
  }

  /** `floor.delete {floor, move_workers?}`: refused while it has workers, unless they move to the real floor. */
  private deleteFloor(a: Obj, send: Send): undefined {
    onlyKeys(a, ['floor', 'move_workers']);
    const f = this.virtualFloor(a);
    const ws = this.workers.filter((w) => w.session === f.session);
    if (ws.length && a.move_workers !== true) throw new CmdError('invalid_state', `floor “${f.name ?? f.session}” has ${ws.length} worker${ws.length === 1 ? '' : 's'}: ${ws.map((w) => w.name ?? w.label).join(', ')}`);
    const base = f.base_session ?? f.session;
    const from = f.building;
    this.floors.delete(f.session);
    this.goneBase.set(f.session, base);
    if (from !== null) this.floorsOf(from).forEach((s, i) => ((this.floors.get(s) as Floor).index = i));
    this.emit(send, { t: 'floor.removed', session: f.session });
    this.hirePresets.dropFloor(f.session, send); // #93: its own presets go with it
    this.handoffHireSim?.floorGone(f.session, send); // #219: and the handoff hires waiting for it
    for (const w of ws) {
      // The real floor seats them at its lowest free desks.
      const taken = new Set(this.workers.filter((x) => x.session === base).map((x) => x.desk_index));
      let desk = 0;
      while (taken.has(desk)) desk++;
      w.session = base;
      w.desk_index = desk;
      this.upsertWorker(send, w);
    }
    const real = this.floors.get(base);
    if (real && ws.length) this.resize(send, real);
    if (from !== null && this.buildings.has(from)) this.emit(send, { t: 'building.upsert', building: this.building(from) });
    return undefined;
  }

  private checkSettings(a: Obj): void {
    onlyKeys(a, ['session', 'repo', 'project', 'status_field', 'default_cwd', 'default_hire', 'tracker', 'kaneo', ...(this.fail === 'no_mcp' ? [] : ['expected_mcp'])]);
    // #196: the expected MCP servers, checked like the bridge's (docs/protocol.md "MCP and skills").
    const em = a.expected_mcp;
    if (em !== undefined && em !== null) {
      if (!Array.isArray(em) || em.length > 32) throw bad('expected_mcp must be at most 32 names');
      const seen = new Set<string>();
      for (const n of em) {
        if (typeof n !== 'string' || n !== n.trim() || !n || bytes(n) > 100 || /[\u0000-\u001f\u007f]/.test(n)) throw bad('expected_mcp: each name is 1-100 bytes, trimmed, no control characters');
        if (seen.has(n)) throw bad(`expected_mcp: ${n} is listed twice`);
        seen.add(n);
      }
    }
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
    // #184: the tracker and the Kaneo link, checked like the bridge (tools/fixture-kaneo.ts).
    const s: FloorSettings = 'tracker' in a || 'kaneo' in a ? this.kaneo.applySettings(f.settings ?? {}, a) : { ...(f.settings ?? {}) };
    // A connection watching the floor gets the board of its new link, like the bridge's watchers.
    const watcher = 'tracker' in a || 'kaneo' in a || 'repo' in a ? (this.kaneo.release(f.session) ?? this.boards.release(f.session)) : null;
    const set = s as Record<string, unknown>;
    for (const k of ['repo', 'project', 'status_field', 'default_cwd', 'default_hire', 'expected_mcp'] as const) {
      if (!(k in a)) continue;
      if (a[k] === null || (k === 'expected_mcp' && Array.isArray(a[k]) && a[k].length === 0)) delete set[k];
      else set[k] = a[k];
    }
    if (Object.keys(s).length) f.settings = s;
    else delete f.settings;
    this.floorEvent(send, f);
    if (watcher) {
      if (this.kaneo.isKaneo(f.session)) this.kaneo.rewatch(f.session, watcher);
      else this.boards.rewatch(f.session, watcher);
    }
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

  /**
   * #52 (`sim.swap`, the simulator's own): what herdr can do under a desk in one observation. `{id, pane: true}`: the
   * worker's primary pane changes (an agent started in another pane), a new `pane_id` under the same worker id, so its
   * watch closes with `pane_changed`. `{id, name?}`: its workspace closes and a new one takes the desk at once: a new
   * worker id and pane, named `name` (default: the same name, free again), no `hired_at` (no walk-in). `hold` (ms): the
   * new pane's first frame comes that much later. Acks the worker id and pane now at the desk.
   */
  private swap(a: Obj, send: Send, screens: SimScreens): { id: string; pane: string } {
    onlyKeys(a, ['id', 'pane', 'name', 'hold']);
    const i = this.workers.findIndex((w) => w.id === str(a, 'id'));
    const old = this.workers[i];
    if (!old) throw new CmdError('unknown_worker', `unknown worker: "${String(a.id)}"`);
    const hold = a.hold === undefined ? 0 : Number(a.hold);
    const n = ++this.nextId;
    if (a.pane === true) {
      old.pane_id = `${old.workspace_id}:s${n}`;
      if (hold) screens.holdFirst(old.id, hold);
      this.upsertWorker(send, old);
      return { id: old.id, pane: old.pane_id };
    }
    const w = structuredClone(old);
    delete w.hired_at;
    w.id = `${(0x52a000 + n).toString(16)}e0-0000-4000-a000-${n.toString(16).padStart(12, '0')}`;
    w.workspace_id = `ws${n.toString(36)}`;
    w.pane_id = `${w.workspace_id}:p1`;
    w.name = a.name === undefined ? (old.name ?? '') : str(a, 'name');
    w.status_since = this.now();
    this.workers.splice(i, 1, w);
    this.emit(send, { t: 'worker.removed', id: old.id, session: old.session, workspace_id: old.workspace_id });
    if (hold) screens.holdFirst(w.id, hold);
    this.upsertWorker(send, w);
    return { id: w.id, pane: w.pane_id };
  }

  private upsertWorker(send: Send, w: Worker): void {
    this.emit(send, { t: 'worker.upsert', worker: w });
  }

  /**
   * #108 round 5: each worker's `secret_files` (how many protected files it holds; left out at 0) as the files are
   * now, a `worker.upsert` for each that changed (written, claimed, revoked). Not on a bridge before round 5.
   */
  private syncSecretFiles(send: Send): void {
    if (!this.secrets.revocable) return;
    for (const w of this.workers) {
      const n = this.secrets.held(w.id);
      if ((w.secret_files ?? 0) === n) continue;
      if (n) w.secret_files = n;
      else delete w.secret_files;
      this.upsertWorker(send, w);
    }
  }

  /**
   * #58 `session.create`, with herdr-world's rule (`herdr.CheckNewSessionName`; this host's sun_path cap is 56) and its
   * taken checks: a floor, or a herdr session the bridge does not show (SIM_HERDR_ONLY). The floor comes up in the lot a
   * step later, then the ack.
   */
  private createSession(a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): void {
    if (this.fail === 'no_sessions') throw new CmdError('unknown_command', 'unknown command: "session.create"');
    onlyKeys(a, ['name']);
    const name = str(a, 'name');
    if (!name) throw new CmdError('bad_request', 'Give the floor a name.');
    if (name === 'default') throw new CmdError('bad_request', '“default” is herdr’s own session: pick another name.');
    if (!/^[a-z0-9_-]+$/.test(name)) throw new CmdError('bad_request', 'Use only lowercase letters, digits, “_” and “-”.');
    if (name.startsWith('-')) throw new CmdError('bad_request', 'The name cannot start with “-”.');
    if (name.length > SIM_MAX_SESSION) throw new CmdError('bad_request', `Keep the name to at most ${SIM_MAX_SESSION} characters (herdr’s socket path on this host).`);
    if (this.creating.has(name)) throw new CmdError('busy', `“${name}” is being created already.`);
    if (this.floors.has(name)) throw new CmdError('name_taken', `“${name}” is already a floor.`);
    if (SIM_HERDR_ONLY.includes(name)) throw new CmdError('name_taken', `“${name}” is already a herdr session (asleep): wake its floor instead.`);
    this.creating.add(name);
    const failing = this.fail === 'session_create_failed';
    if (failing) this.fail = undefined;
    this.later([
      () => {
        this.creating.delete(name);
        if (failing) return fail(new CmdError('session_create_failed', `herdr started ${name}, but its floor was not seen running within 10s; it was stopped and removed again.`));
        const f: Floor = { session: name, name, base_session: name, state: 'running', building: null, index: null };
        this.floors.set(name, f);
        this.floorEvent(send, f);
        ack({ session: name });
      },
    ]);
  }

  private wake(a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): void {
    onlyKeys(a, ['session']);
    const f = this.floor(a);
    if (f.transition) throw new CmdError('busy', `busy: ${f.session} is ${f.transition}`);
    if (f.state === 'running') throw new CmdError('invalid_state', `invalid state: ${f.session} is running`);
    // #58: a wake is the session's: every floor of it wakes.
    const fs = this.sessionFloors(f);
    const each = (fn: (x: Floor) => void) => {
      for (const x of fs) {
        fn(x);
        this.floorEvent(send, x);
      }
    };
    each((x) => (x.transition = 'waking'));
    const ws = this.workers.filter((w) => fs.some((x) => x.session === w.session));
    if (this.fail === 'wake_failed') {
      this.fail = undefined;
      this.later([
        () => {
          each((x) => delete x.transition);
          fail(new CmdError('wake_failed', `herdr server for ${f.session} did not answer ping within 10s (simulated)`));
        },
      ]);
      return;
    }
    const resumable = ws.filter((w) => w.agent_session);
    const steps: Array<() => void> = [
      () => {
        each((x) => (x.state = 'running'));
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
        each((x) => delete x.transition);
        ack({ workers: ws.filter((w) => w.session === f.session).map((w) => ({ id: w.id, resume: w.resume ?? 'none' })) });
      },
    ];
    this.later(steps);
  }

  private sleep(a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void): void {
    onlyKeys(a, ['session']);
    const f = this.floor(a);
    if (f.transition) throw new CmdError('busy', `busy: ${f.session} is ${f.transition}`);
    if (f.state === 'asleep') throw new CmdError('invalid_state', `invalid state: ${f.session} is asleep`);
    // #58: a sleep is the session's: every floor of it goes to sleep.
    const fs = this.sessionFloors(f);
    const each = (fn: (x: Floor) => void) => {
      for (const x of fs) {
        fn(x);
        this.floorEvent(send, x);
      }
    };
    each((x) => (x.transition = 'sleeping'));
    if (this.fail === 'sleep_failed') {
      this.fail = undefined;
      this.later([
        () => {
          each((x) => delete x.transition);
          fail(new CmdError('sleep_failed', `herdr session stop ${f.session}: exit status 1 (simulated)`));
        },
      ]);
      return;
    }
    this.later([
      () => {
        each((x) => {
          x.state = 'asleep';
          delete x.transition;
        });
        for (const w of this.workers) {
          if (!fs.some((x) => x.session === w.session)) continue;
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

  // ---- #90: follow-up questions (tools/fixture-followup.ts) ------

  private followupSim: FollowupSim | null = null;

  private get followups(): FollowupSim {
    this.followupSim ??= new FollowupSim({
      workers: this.workers,
      ai: this.ai,
      emit: (send, m) => this.emit(send, m),
      error: (code, message) => new CmdError(code, message),
      now: () => this.now(),
      push: (id, items, updates) => this.transcripts.push(id, items, updates),
      nextSeq: (id) => this.transcripts.nextSeq(id),
      prompt: (a, send, ack, fail) => this.panels.prompt(a, send, ack, fail),
    });
    return this.followupSim;
  }

  private manualSim: ManualProcessSim | null = null;
  private get manual(): ManualProcessSim {
    this.manualSim ??= new ManualProcessSim({ workers: this.workers, now: () => this.now(), emit: (send, m) => this.emit(send, m), upsert: (send, w) => this.upsertWorker(send, w), final: (id, text) => void this.handoffs.handle('sim.final', { id, text }, () => undefined, () => undefined), later: (fn, ms) => { this.setT(fn, ms); } }, this.manualPreset, this.commandRequestPreset);
    return this.manualSim;
  }

  // ---- #66: schedule suggestions (tools/fixture-schedsuggest.ts) ------

  private schedSuggestSim: SchedSuggestSim | null = null;

  private get schedSuggest(): SchedSuggestSim {
    this.schedSuggestSim ??= new SchedSuggestSim(
      {
        workers: this.workers,
        ai: this.ai,
        emit: (send, m) => this.emit(send, m),
        error: (code, message) => new CmdError(code, message),
        now: () => this.now(),
        upsert: (send, w) => this.upsertWorker(send, w),
        final: (id, text) =>
          void this.handoffs.handle(
            'sim.final',
            { id, text },
            () => undefined,
            () => undefined,
          ),
      },
      schedSuggestMode(this.schedSuggestMode),
      this.suggestKey,
    );
    return this.schedSuggestSim;
  }

  // ---- #223: handoffs and the filing cabinet (tools/fixture-handoff.ts) ------

  private handoffSim: HandoffSim | null = null;

  private get handoffs(): HandoffSim {
    this.handoffSim ??= new HandoffSim(
      {
        workers: this.workers,
        floors: () => [...this.sorted().flatMap((b) => b.floors), ...[...this.floors.values()].filter((f) => f.building === null).map((f) => f.session)],
        emit: (send, m) => this.emit(send, m),
        error: (code, message) => new CmdError(code, message),
        now: () => this.now(),
        push: (id, items, updates) => this.transcripts.push(id, items, updates),
        nextSeq: (id) => this.transcripts.nextSeq(id),
        upsert: (send, w) => this.upsertWorker(send, w),
        fireBlocked: (id) => {
          const p = this.firePrepare({ id });
          return p.can_fire === false ? String(p.fire_blocked ?? 'it cannot be sent home') : '';
        },
        fire: (id, send) =>
          this.fireWorker(
            { id },
            send,
            () => undefined,
            () => undefined,
          ),
        ai: this.ai, // #9
        hires: this.handoffHires, // #219
      },
      this.handoffMode !== 'off',
      this.handoffSeed,
      this.handoffLlm,
    );
    return this.handoffSim;
  }

  // ---- #219: pending handoff hires (tools/fixture-handoffhire.ts) ------

  private handoffHireSim: HandoffHireSim | null = null;

  private get handoffHires(): HandoffHireSim {
    this.handoffHireSim ??= new HandoffHireSim(
      {
        emit: (send, m) => this.emit(send, m),
        error: (code, message) => new CmdError(code, message),
        now: () => this.now(),
        check: (hire, op, source) => this.handoffHireCheck(hire, op, source),
        hire: (args, op, send) =>
          new Promise<HireResult>((resolve) => {
            const no = (e: unknown) => resolve({ ok: false, code: e instanceof CmdError ? e.code : 'hire_failed', message: e instanceof Error ? e.message : String(e) });
            try {
              // The wire's `floor` is the simulator's `session` (see the top).
              const { floor, ...rest } = args;
              this.hireWorker({ ...rest, session: floor ?? rest.session }, send, (d) => resolve({ ok: true, data: (d ?? {}) as Obj }), no, op);
            } catch (e) {
              no(e);
            }
          }),
        sendHome: (id, send) => {
          const w = this.workers.find((x) => x.id === id);
          if (!w) return 'it left already';
          const why = this.firePrepare({ id }).can_fire === false ? String(this.firePrepare({ id }).fire_blocked ?? 'it cannot be sent home') : w.status === 'working' ? `${w.name ?? w.id} is working` : w.status === 'blocked' ? `${w.name ?? w.id} is blocked: it waits on you` : '';
          if (why) return why;
          try {
            this.fireWorker({ id }, send, () => undefined, () => undefined);
            return '';
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
        },
        claim: (hire, worker) => this.secrets.claimHandoffHire(hire, worker),
        release: (hire) => this.secrets.releaseHandoffHire(hire),
        floorName: (id) => this.floors.get(id)?.name ?? id,
        later: (fn, ms) => {
          const h = this.setT(() => {
            this.timers.delete(h);
            fn();
          }, ms);
          this.timers.add(h);
        },
        out: () => this.out,
      },
      this.handoffHireMode,
    );
    return this.handoffHireSim;
  }

  /** #219: `worker.handoff`'s `hire` checked as `worker.hire` checks its args before anything is made (the bridge's accept). */
  private handoffHireCheck(a: Obj, op: string, source: string | null): void {
    const f = this.runningFloor({ session: a.floor ?? a.session });
    const desk = a.desk_index;
    if (typeof desk !== 'number' || !Number.isInteger(desk) || desk < 0) throw new CmdError('bad_request', 'bad args: hire.desk_index must be an int >= 0');
    const o = this.hire[str(a, 'harness')];
    const model = str(a, 'model');
    const effort = str(a, 'effort');
    if (!o) throw new CmdError('bad_request', `bad args: unknown harness ${String(a.harness)}`);
    if (!o.models.includes(model)) throw new CmdError('bad_request', `bad args: ${String(a.harness)} has no model ${model}`);
    if (![...o.efforts, ...(o.extra_efforts?.[model] ?? [])].includes(effort)) throw new CmdError('bad_request', `bad args: ${model} has no effort ${effort}`);
    if (a.label !== undefined && (typeof a.label !== 'string' || !a.label.trim() || bytes(a.label) > 64 || a.label.startsWith('-'))) throw new CmdError('bad_request', 'bad args: label must be 1-64 bytes, not starting with -');
    if (a.cwd !== undefined && (typeof a.cwd !== 'string' || !a.cwd.startsWith('/'))) throw new CmdError('bad_request', 'bad args: cwd must be an absolute path');
    const prompt = String(a.prompt ?? '');
    if (prompt.startsWith('--')) throw new CmdError('bad_request', 'bad args: prompt must not start with --');
    // The task, the line that points to the handoff (a 1024-byte path allowance) and the herdr instructions: one prompt.
    const extra = bytes(`First read the handoff here: ${'x'.repeat(1024)} and then follow these instructions:\n\n`) + (a.herdr_instructions === true ? 2 + bytes(herdrInstructions(f.session)) : 0);
    if (bytes(prompt) + extra > 32 * 1024) throw new CmdError('bad_request', 'bad args: the task with the line that points to the handoff must fit in 32 KiB');
    const held = this.handoffHires.holder(f.session, desk, op);
    if (desk >= (f.desks ?? 0) || this.hiring.has(`${f.session}:${desk}`) || held || this.workers.some((w) => w.session === f.session && w.desk_index === desk)) {
      throw new CmdError('desk_taken', held ? `Desk ${desk + 1} is held for ${held.worker_name}'s handoff hire.` : `desk_taken: desk ${desk} of ${f.session} is ${desk >= (f.desks ?? 0) ? 'out of range' : 'occupied'}`);
    }
    // The caps count the other waiting holds, and not the source when it goes home right after.
    const leaving = source && this.workers.some((w) => w.id === source && w.session === f.session) ? 1 : 0;
    const cap = this.floorCap(f);
    const count = cap.count + this.handoffHires.waiting(f.session, op) - leaving;
    if (count >= cap.hard) throw new CmdError('capacity', `capacity: ${f.session} has ${count} workers (hard cap ${cap.hard})`);
    const host = this.hostCap();
    const hostCount = host.count + this.handoffHires.waiting(null, op) - (source ? 1 : 0);
    if (hostCount >= host.hard) throw new CmdError('capacity', `capacity: the host has ${hostCount} workers (hard cap ${host.hard})`);
  }

  // ---- #64 schedules: scheduled agents (tools/fixture-schedule.ts) ------

  private scheduleSim: ScheduleSim | null = null;

  private get schedules(): ScheduleSim {
    this.scheduleSim ??= new ScheduleSim(
      {
        floors: () => [...this.sorted().flatMap((b) => b.floors), ...[...this.floors.values()].filter((f) => f.building === null).map((f) => f.session)],
        floor: (id) => this.floors.get(id),
        hire: this.hire,
        workers: this.workers,
        emit: (send, m) => this.emit(send, m),
        out: () => this.out,
        error: (code, message) => new CmdError(code, message),
        now: () => this.now(),
        later: (fn, ms) => {
          const h = this.setT(() => {
            this.timers.delete(h);
            fn();
          }, ms);
          this.timers.add(h);
          return h;
        },
        cancel: (h) => {
          this.clearT(h);
          this.timers.delete(h);
        },
        freeDesk: (id) => {
          const f = this.floors.get(id);
          const n = f?.desks ?? 0;
          for (let d = 0; d < n; d++) if (!this.hiring.has(`${id}:${d}`) && !this.handoffHireSim?.holder(id, d) && !this.workers.some((w) => w.session === id && w.desk_index === d)) return d;
          return null;
        },
        hireWorker: (a, send, ack, fail) => this.hireWorker(a, send, ack, fail),
        stored: (s) => this.secrets.storedFire(s.id, s.prompt), // #108
        lines: (floor) => herdrInstructions(floor), // #127
      },
      this.scheduleMode !== 'off',
      this.scheduleSeed,
      this.scheduleInstructions,
    );
    return this.scheduleSim;
  }

  // ---- #213: the dictation bar's interpreter (tools/fixture-interpret.ts) ------

  private interpretSim: InterpretSim | null = null;

  private get interpreter(): InterpretSim {
    this.interpretSim ??= new InterpretSim({ ai: this.ai, hireOptions: () => this.hire, error: (code, message) => new CmdError(code, message) });
    return this.interpretSim;
  }

  // ---- #110: pack up on request (tools/fixture-packup.ts) ------

  private packupSim: PackupSim | null = null;

  private get packup(): PackupSim {
    this.packupSim ??= new PackupSim({
      workers: this.workers,
      ai: this.ai,
      emit: (send, m) => this.emit(send, m),
      error: (code, message) => new CmdError(code, message),
      now: () => this.now(),
    });
    return this.packupSim;
  }

  // ---- #118: floor overview summaries (tools/fixture-digest.ts) ------

  private digestSim: DigestSim | null = null;

  private get digest(): DigestSim {
    this.digestSim ??= new DigestSim({
      workers: this.workers,
      ai: this.ai,
      emit: (send, m) => this.emit(send, m),
      error: (code, message) => new CmdError(code, message),
      now: () => this.now(),
    });
    return this.digestSim;
  }

  // ---- #57: asks (tools/fixture-ask.ts) ------

  private askSim: AskSim | null = null;

  private get asks(): AskSim {
    this.askSim ??= new AskSim({
      workers: this.workers,
      floors: this.floors,
      stepMs: this.stepMs,
      emit: (send, m) => this.emit(send, m),
      after: (ms, fn) => {
        const h = this.setT(() => {
          this.timers.delete(h);
          fn();
        }, ms);
        this.timers.add(h);
      },
      now: () => this.now(),
      takeFail: (code) => {
        if (this.fail !== code) return false;
        this.fail = undefined;
        return true;
      },
      error: (code, message) => new CmdError(code, message),
      push: (id, items, updates) => this.transcripts.push(id, items, updates),
      nextSeq: (id) => this.transcripts.nextSeq(id),
      work: (send, w, title) => this.panels.work(send, w, title),
    });
    return this.askSim;
  }

  // ---- #157: Codex async questions (tools/fixture-codex-questions.ts) ------

  private codexqSim: CodexQuestionsSim | null = null;

  private get codexq(): CodexQuestionsSim {
    this.codexqSim ??= new CodexQuestionsSim({
      workers: this.workers,
      floors: this.floors,
      stepMs: this.stepMs,
      emit: (send, m) => this.emit(send, m),
      after: (ms, fn) => {
        const h = this.setT(() => {
          this.timers.delete(h);
          fn();
        }, ms);
        this.timers.add(h);
      },
      now: () => this.now(),
      takeFail: (code) => {
        if (this.fail !== code) return false;
        this.fail = undefined;
        return true;
      },
      error: (code, message) => new CmdError(code, message),
    });
    return this.codexqSim;
  }

  // ---- M5: prompt, answer, changes, usage (tools/fixture-panels.ts) ------

  private panelsSim: PanelsSim | null = null;
  private usageMs = 5000;
  private readonly echoMs: number | null;
  private echoes = 0;

  /** #58: the prompt as the agent writes it to its transcript: trimmed, a user item after the others. */
  private echo(w: Worker, text: string): void {
    if (this.echoMs === null) return;
    const h = this.setT(() => {
      this.timers.delete(h);
      const item: TranscriptItem = { id: `sim-echo-${++this.echoes}`, seq: this.transcripts.nextSeq(w.id), ts: this.now(), kind: 'user', parts: [{ text: text.trim() }] };
      this.transcripts.push(w.id, [item], []);
    }, this.echoMs);
    this.timers.add(h);
  }

  private get panels(): PanelsSim {
    this.panelsSim ??= new PanelsSim({
      workers: this.workers,
      floors: this.floors,
      stepMs: this.stepMs,
      emit: (send, m) => this.emit(send, m),
      after: (ms, fn) => {
        const h = this.setT(() => {
          this.timers.delete(h);
          fn();
        }, ms);
        this.timers.add(h);
      },
      now: () => this.now(),
      takeFail: (code) => {
        if (this.fail !== code) return false;
        this.fail = undefined;
        return true;
      },
      error: (code, message) => new CmdError(code, message),
      echo: (w, text) => this.echo(w, text),
    });
    return this.panelsSim;
  }

  /** After the snapshot went out: the periodic `worker.usage` of working agents (`usageMs`). */
  start(send: Send, o: { usageMs?: number } = {}): void {
    this.out = send;
    this.usageMs = o.usageMs ?? this.usageMs;
    this.panels.start(send, this.usageMs);
    this.crew.start(send, this.crewMs);
  }

  // ---- M6 crew: the scripted freelancer (tools/fixture-crew.ts) ------------

  private crewSim: CrewSim | null = null;
  private crewMs = 0;

  private get crew(): CrewSim {
    this.crewSim ??= new CrewSim({
      workers: this.workers,
      floors: this.floors,
      emit: (send, m) => this.emit(send, m),
      after: (ms, fn) => {
        const h = this.setT(() => {
          this.timers.delete(h);
          fn();
        }, ms);
        this.timers.add(h);
      },
      now: () => this.now(),
      error: (code, message) => new CmdError(code, message),
    });
    return this.crewSim;
  }

  // ---- M4: hire and send home ------------------------------------------------
  //
  // Rules of the simulation: a cwd is a git repo unless it has `/scratch` in
  // it (its repo root: the path before `-wt/…`); `offline` in it (or
  // `simfail=fetch_failed`) makes every fetch fail: prepare says so, a
  // worktree hire is refused (`fetch_failed`). A worker that is `working`
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

  /**
   * #39: worker.commands, worker.files and worker.repos for a hire with no worker yet: the floor (running for
   * commands and files; a floor's wake or sleep does not hold them), the harness, the folder (absolute; a worktree
   * hire's must be a repository), answered after half a step like the worker ones.
   */
  private hireLookup(t: string, a: Obj, ack: (d?: unknown) => void): void {
    const reply = (d: unknown) => {
      const h = this.setT(() => {
        this.timers.delete(h);
        ack(d);
      }, Math.round(this.stepMs / 2));
      this.timers.add(h);
    };
    if (t === 'hire.repos') {
      onlyKeys(a, ['session']);
      reply({ repos: this.repos.repos(this.floor(a).session) });
      return;
    }
    onlyKeys(a, t === 'hire.commands' ? ['session', 'harness', 'cwd', 'worktree'] : ['session', 'cwd', 'worktree', 'query', 'limit']);
    const f = this.floor(a);
    if (f.state !== 'running') throw new CmdError('invalid_state', `invalid state: ${f.session} is asleep`);
    if (a.cwd !== undefined && (typeof a.cwd !== 'string' || !a.cwd.startsWith('/'))) throw bad(`cwd must be an absolute path, got ${JSON.stringify(a.cwd)}`);
    const cwd = (a.cwd as string | undefined) ?? this.defaultCwd(f);
    if (a.worktree === true && !this.git(cwd, false)) throw bad(`worktree: ${cwd} is not in a git work tree`);
    if (t === 'hire.commands') {
      const data = simCommands(str(a, 'harness'));
      if (!data) throw bad(`harness must be claude or codex, got ${JSON.stringify(a.harness)}`);
      reply(data);
      return;
    }
    const query = a.query ?? '';
    const limit = a.limit ?? 0;
    if (typeof query !== 'string') throw bad('query must be a string');
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) throw bad('limit must be an integer >= 0');
    if (Array.from(query).length > 256) throw bad('query is longer than 256 characters');
    reply(
      cwd.includes('/scratch')
        ? { files: [], source: 'none', reason: 'not a git work tree, and rg is not installed to list it; the checkout has no files to search' }
        : { files: simFiles(query, limit === 0 ? 30 : Math.min(limit, 100)), source: 'git', reason: null },
    );
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
    const failed = fetch && (cwd.includes('offline') || this.originDown);
    if (failed) {
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
    onlyKeys(a, ['session', 'cwd', 'preview']);
    const f = this.runningFloor(a);
    if (a.cwd !== undefined && (typeof a.cwd !== 'string' || !a.cwd.startsWith('/'))) throw bad('cwd must be an absolute path');
    if (a.preview !== undefined && typeof a.preview !== 'boolean') throw bad('preview must be a bool');
    const cwd = (a.cwd as string | undefined) ?? this.defaultCwd(f);
    // #134: a preview reads the local refs (never a fetch's failure).
    const git = this.git(cwd, a.preview !== true);
    if (git && a.preview === true) Object.assign(git, { fetched: false, preview: true });
    return {
      cwd,
      ...this.choice(f),
      label: this.nextName(f.session),
      git,
      capacity: { floor: this.floorCap(f), host: this.hostCap(), load: { load1: 2.36, cpus: 16, mem_used_pct: 41.4 } },
      // #95: the lines a worker.hire with herdr_instructions adds here (the sim's session is the floor id).
      ...(this.hirePresets.instructions ? { herdr_instructions: herdrInstructions(f.session) } : {}),
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

  /** `own` (#219): the handoff hire whose hold this hire takes over. */
  private hireWorker(a: Obj, send: Send, ack: (d?: unknown) => void, fail: (e: unknown) => void, own?: string): void {
    onlyKeys(a, ['session', 'desk_index', 'harness', 'model', 'effort', 'label', 'cwd', 'worktree', 'prompt', ...(this.hirePresets.instructions ? ['herdr_instructions'] : []), ...(this.codexProfiles ? ['codex_profile'] : [])]);
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
    if (a.herdr_instructions !== undefined && typeof a.herdr_instructions !== 'boolean') throw bad('herdr_instructions must be a bool');
    if (a.herdr_instructions === true && !(typeof a.prompt === 'string' && a.prompt.trim())) throw bad('herdr_instructions needs a prompt');
    // #95: the lines go after the task (the bridge checks the whole prompt).
    const typed = typeof a.prompt === 'string' ? a.prompt : '';
    const first = a.herdr_instructions === true ? `${typed}\n\n${herdrInstructions(f.session)}` : typed;
    if (bytes(first) > 32 * 1024) throw bad('prompt must be 1-32768 bytes of text, not starting with "--"');
    if (a.worktree !== undefined && typeof a.worktree !== 'boolean') throw bad('worktree must be a bool');
    const cwd = (a.cwd as string | undefined) ?? this.defaultCwd(f);
    if (!cwd.startsWith('/')) throw bad('cwd must be an absolute path');
    // A worktree hire fetches origin first: its branch must start from a fresh origin/<default>.
    const git = this.git(cwd, a.worktree === true);
    if (a.worktree === true && !git) throw bad(`worktree: ${cwd} is not a git repository`);
    if (desk >= (f.desks ?? 0) || this.hiring.has(`${f.session}:${desk}`) || this.workers.some((w) => w.session === f.session && w.desk_index === desk)) {
      throw new CmdError('desk_taken', `desk_taken: desk ${desk} of ${f.session} is ${desk >= (f.desks ?? 0) ? 'out of range' : 'occupied'}`);
    }
    // #219: a desk held for a handoff hire is nobody else's.
    const holder = this.handoffHireSim?.holder(f.session, desk, own);
    if (holder) throw new CmdError('desk_taken', `Desk ${desk + 1} is held for ${holder.worker_name}'s handoff hire.`);
    const cap = this.floorCap(f);
    if (cap.count >= cap.hard) throw new CmdError('capacity', `capacity: ${f.session} has ${cap.count} workers (hard cap ${cap.hard})`);
    const host = this.hostCap();
    if (host.count >= host.hard) throw new CmdError('capacity', `capacity: the host has ${host.count} workers (hard cap ${host.hard})`);
    // Like the bridge, after the accept: nothing is made.
    if (a.worktree === true && git && !git.fetched) {
      this.later([() => fail(new CmdError('fetch_failed', `fetch_failed: git fetch origin in ${String(git.repo_root)}: ${String(git.fetch_error)}`))]);
      return;
    }
    if (this.fail === 'mcp_startup') {
      this.fail = undefined;
      this.later([() => fail(new CmdError('hire_failed', 'Codex did not become ready within 30 seconds.', {
        operation: 'mcp-startup-fixture', cwd, codex_profile: 'default', delivery: 'not_sent', retryable: true,
        startup: [{ name: 'code-intel', stage: 'failed', category: 'timeout', source: 'terminal' }],
      }))]);
      return;
    }
    if (this.fail === 'hire_failed') {
      this.fail = undefined;
      this.later([() => fail(new CmdError('hire_failed', 'hire_failed: herdr agent start: claude exited during startup (simulated)'))]);
      return;
    }
    // The name is the label when that is a free generated name, else the next one (like the bridge).
    const want = (a.label as string | undefined)?.trim() ?? '';
    const named = SIM_NAMES.includes(want) && !this.workers.some((x) => x.session === f.session && x.name === want);
    const name = named ? want : this.nextName(f.session);
    const label = want || name;
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
    let codex: WorkerCodex | undefined = this.codexServer.hire(harness); // #186
    let reason = ''; // #140: an Auto hire's pick
    if (typeof a.codex_profile === 'string' && a.codex_profile) {
      if (harness !== 'codex') throw new CmdError('bad_request', `bad args: codex_profile is for a Codex hire, not "${harness}"`);
      const profiles = this.codexProfiles as CodexProfilesSim; // (a bridge before #139 refused the field above)
      let key = a.codex_profile;
      if (key === 'auto') ({ key, reason } = profiles.pick(cwd, this.limits.codexBase()));
      codex = profiles.hire(key, codex); // #139
    }
    if (codex) w.codex = codex;
    if (branch && root) {
      w.branch = branch;
      w.worktree = { repo_root: root, repo_name: root.split('/').pop() ?? root, checkout_path: checkout, linked: true };
    } else if (root) {
      w.worktree = { repo_root: root, repo_name: root.split('/').pop() ?? root, checkout_path: cwd, linked: false };
    }
    const prompt = first.trim();
    if (prompt) this.firstPrompts.push({ id, floor: f.session, prompt: first });
    // #210: the worker starts but its first task never reaches it (`prompted: false`), like the bridge's partial success.
    const undelivered = !!prompt && this.fail === 'prompt_undelivered' && ((this.fail = undefined), true);
    this.lastHire.set(f.session, { harness, model, effort });
    const held = `${f.session}:${desk}`;
    this.hiring.add(held);
    // Worktree, agent start and trust take a step; then the first task starts it working.
    this.later([
      () => {
        this.hiring.delete(held);
        this.workers.push(w);
        if (branch) this.hireBranch.set(id, branch);
        this.resize(send, f);
        this.upsertWorker(send, w);
        // herdr opens the repo's main checkout too when the floor has no workspace in it: one more (not hired) worker.
        if (branch && root && !this.workers.some((x) => x.session === f.session && x.cwd === root)) this.mainCheckout(send, f, root);
        const data: Obj = { id, workspace_id: ws, trust: 'approved' };
        if (undelivered) {
          data.prompted = false;
          data.prompt_error = 'the agent did not take the task (simulated)';
        } else if (prompt) data.prompted = true;
        if (codex) data.codex = codex;
        if (reason) data.codex_profile_reason = reason;
        if (branch) {
          data.branch = branch;
          data.base_sha = git?.base_sha;
        }
        ack(data);
      },
      ...(prompt && !undelivered
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

  /** The workspace herdr opens for a worktree group's main checkout: a plain worker at the lowest free desk, no `hired_at`. */
  private mainCheckout(send: Send, f: Floor, root: string): void {
    const taken = new Set(this.workers.filter((x) => x.session === f.session).map((x) => x.desk_index));
    let desk = 0;
    while (taken.has(desk) || this.hiring.has(`${f.session}:${desk}`) || this.handoffHireSim?.holder(f.session, desk)) desk++;
    const n = ++this.nextId;
    const ws = `wm${n.toString(36)}`;
    const repo = root.split('/').pop() ?? root;
    const w: Worker = {
      id: `${(0x5173a4 + n).toString(16)}e0-0000-4000-b000-${n.toString(16).padStart(12, '0')}`,
      session: f.session,
      workspace_id: ws,
      label: repo,
      cwd: root,
      pane_id: `${ws}:p1`,
      status: 'unknown',
      name: this.nextName(f.session),
      desk_index: desk,
      status_since: this.now(),
      worktree: { repo_root: root, repo_name: repo, checkout_path: root, linked: false },
    };
    this.workers.push(w);
    this.resize(send, f);
    this.upsertWorker(send, w);
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
      // Only a branch the bridge made for this worker, still checked out (and clean, all pushed).
      can_delete_branch: linked && clean && !!w.branch && this.hireBranch.get(w.id) === w.branch,
      can_fire: open.length === 0,
    };
    if (open.length) out.fire_blocked = `it is ${wt?.repo_name ?? 'the repo'}’s main checkout and ${open.length} of its worktrees are still open here (${open.map((x) => x.name).join(', ')}): send them home first`;
    if (w.branch) out.branch = w.branch;
    if (!linked) out.reason = wt ? 'it works in the repo’s main checkout, not a worktree of its own' : 'it is not in a git worktree';
    else if (!clean) out.reason = [t.dirty.length ? 'the worktree has uncommitted changes' : '', t.unpushed ? `${t.unpushed} ${t.unpushed === 1 ? 'commit is' : 'commits are'} not on any remote` : ''].filter(Boolean).join(' and ');
    return out;
  }

  /**
   * #83: `worker.wrapup` checks like `worker.fire` (an agent in Claude or Codex, a delete only when clean), arms the
   * worker and acks; the result comes from `sim.wrapup`. A worker already armed is busy.
   */
  private wrapUp(a: Obj, send: Send): Obj {
    onlyKeys(a, ['id', 'prompt', 'worktree']);
    const w = this.worker(a);
    const prompt = str(a, 'prompt');
    if (!prompt.trim()) throw bad('prompt must be 1-16000 bytes');
    const choice = a.worktree ?? 'keep';
    if (choice !== 'keep' && choice !== 'delete' && choice !== 'delete_branch') throw bad('worktree must be keep, delete or delete_branch');
    if (w.agent_kind !== 'claude' && w.agent_kind !== 'codex') throw new CmdError('invalid_state', `invalid state: ${w.name ?? w.id} runs no Claude or Codex agent: its wrap-up result could not be read`);
    if (w.wrapup?.state === 'armed' || this.leaving.has(w.id)) throw new CmdError('busy', `busy: ${w.name ?? w.id} is wrapping up already`);
    const p = this.firePrepare({ id: w.id });
    if (choice !== 'keep') {
      if (!w.worktree?.linked) throw bad('worktree: the worker is not in a linked worktree');
      if (!p.can_delete) throw new CmdError('not_clean', `not clean: ${String(p.reason)}: commit and push first, or keep the worktree`);
      if (choice === 'delete_branch' && !p.can_delete_branch) throw bad('the bridge made no branch for it: delete the worktree only');
    }
    if (p.can_fire === false) throw new CmdError('fire_failed', `fire_failed: ${String(p.fire_blocked)}`);
    w.wrapup = { state: 'armed', worktree: choice, armed_at: this.now() };
    this.upsertWorker(send, w);
    return { queued: w.status === 'working' };
  }

  private wrapUpCancel(a: Obj, send: Send): undefined {
    onlyKeys(a, ['id']);
    const w = this.worker(a);
    if (!w.wrapup) throw new CmdError('invalid_state', `invalid state: ${w.name ?? w.id} is not wrapping up`);
    if (this.leaving.has(w.id)) throw new CmdError('busy', `busy: ${w.name ?? w.id} reported CLEAN and is being sent home`);
    delete w.wrapup;
    this.upsertWorker(send, w);
    return undefined;
  }

  /** `sim.wrapup {id, verdict: clean|blocked|none, reason?}`: what the armed worker's transcript says. */
  private wrapUpResult(a: Obj, send: Send, ack: (d?: unknown) => void): void {
    onlyKeys(a, ['id', 'verdict', 'reason']);
    const w = this.worker(a);
    const u = w.wrapup;
    if (u?.state !== 'armed') throw new CmdError('invalid_state', `invalid state: ${w.name ?? w.id} is not armed`);
    if (a.verdict !== 'clean') {
      w.wrapup = { ...u, state: 'needs_you', reason: a.verdict === 'blocked' ? str(a, 'reason') : 'did not report a wrap-up result' };
      this.upsertWorker(send, w);
      return ack();
    }
    // CLEAN: the same steps as worker.fire with the armed choice; nobody waits for its ack.
    this.leaving.add(w.id);
    const f = this.floors.get(w.session);
    ack();
    this.later([
      () => {
        this.leaving.delete(w.id);
        const i = this.workers.indexOf(w);
        if (i < 0) return;
        this.workers.splice(i, 1);
        this.hireBranch.delete(w.id);
        this.secrets.release(w.id); // #108: a worker that really ends takes its files with it
        this.emit(send, { t: 'worker.removed', id: w.id, session: w.session, workspace_id: w.workspace_id, reason: 'sent_home' });
        if (f) this.resize(send, f);
      },
    ]);
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
      if (choice === 'delete_branch' && !this.hireBranch.has(w.id)) throw bad('worktree: delete_branch needs a branch herdr-world made for this worker');
      if (!p.can_delete) throw new CmdError('not_clean', `not_clean: ${String(p.reason)}`);
      if (choice === 'delete_branch' && !p.can_delete_branch) throw new CmdError('not_clean', `not_clean: ${w.name ?? w.id} is no longer on ${String(this.hireBranch.get(w.id))}`);
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
        this.hireBranch.delete(w.id);
        this.secrets.release(w.id); // #108
        this.emit(send, { t: 'worker.removed', id: w.id, session: w.session, workspace_id: w.workspace_id, reason: 'sent_home' });
        if (f) this.resize(send, f);
        ack({ worktree: choice === 'keep' ? 'kept' : choice === 'delete' ? 'deleted' : 'deleted_branch', released: true });
      },
    ]);
  }
}
