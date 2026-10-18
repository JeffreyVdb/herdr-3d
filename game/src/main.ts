import '@fontsource-variable/recursive/full.css';
import './fonts/quiet.css';
import './ui/themes.css';
import './ui/uiTheme.css';
import './ui/hud.css';
import './ui/panels.css';
import './ui/hire.css';
import './ui/m5.css';
import * as THREE from 'three/webgpu';
import { App, type LookAt, type Pose } from './app';
import { backendName, forceWebGLFromSearch, type BackendName } from './backend';
import { runBench, type BenchOptions, type BenchResult } from './bench';
import type { ScreenMeshInfo } from './laptop';
import type { ActivityState, BoardMessage, CommandName, WorldEvent, FollowupsState, Worker } from './net/protocol';
import type { ArrivalInfo } from './render/arrivals';
import type { CrewInfo } from './render/office';
import type { HireSummary } from './ui/hire';
import type { ReviewSummary } from './ui/hireReview';
import type { DictationSummary } from './ui/dictation';
import type { SecretsReviewSummary } from './ui/secretsReview';
import type { HireInterpretation } from './net/protocol';
import type { HandoffDialogSummary } from './ui/handoffDialog';
import type { CabinetSummary } from './ui/cabinet';
import type { SchedulesOpen, SchedulesSummary } from './ui/schedules';
import type { ScheduleFormSummary } from './ui/scheduleForm';
import type { PanelSummary } from './ui/panels';
import type { SendHomeSummary } from './ui/sendHome';
import type { ChangesSummary } from './ui/changes';
import type { InboxChip } from './ui/inbox';
import type { PromptSummary } from './ui/prompt';
// M6 start
import type { PresetsSummary } from './ui/presets';
import type { HirePresetsSummary } from './ui/hirePresets';
import type { AddFloorSummary } from './ui/addFloor';
import type { StartRunOptions, StartRunSummary } from './ui/startRun';
// M7: boards
import type { BoardSummary } from './ui/boards/panel';
import type { OpenPrSummary } from './ui/boards/openPr';
import type { NeedItem } from './world/next';
import { BuildInfo, loadHelperVersion } from './version';
import { takeToken } from './net/endpoint';
import { BridgeApi, BridgeBook } from './net/bridges';
import { migrateBridgeKeys, setBridgeScope } from './net/bridgeScope';
import type { Area, BuildingPlan } from './world/building';
import type { floorLayout } from './world/layout';
import { walkOutRoute, type Waypoint } from './world/route';

/** Debug/test hook, read by the Playwright tests and the Mac perf run. */
export interface H3DDebug {
  backend: BackendName | null;
  frames: number;
  error: string | null;
  /** True once a world snapshot has been rendered. */
  ready: boolean;
  /**
   * `busy` while the elevator-door transition runs; `asleep`: the office's lights are off (null in the city).
   * `floor` is the floor with an interior (the one you are on, or outside the one you last left; null in the
   * lobby); M3b: `area` where you are walking, `building` its name.
   */
  view(): {
    mode: 'city' | 'floor';
    floor: string | null;
    plan: boolean;
    busy: boolean;
    asleep: boolean | null;
    area: Area | null;
    building: string | null;
    /** M3c: sitting at your desk in the corner office. */
    seated: boolean;
    /** M3c: up on the mezzanine (look-at reaches the whole floor, cards read as nearer, all of them show). */
    overlook: boolean;
  };
  /** What the centre of the screen picks in first person (within 3 m; the whole floor up on the mezzanine), else null. */
  lookAt(): LookAt | null;
  /** #124: what E, P, C, X and the digits act on right now (aimed at, or picked with T), and whether it was picked; the shortcut list's state. */
  target(): { kind: string; id: string; label: string; picked: boolean } | null;
  shortcutsOpen(): boolean;
  /** M3c: sits you at your desk (as E on it does); false unless you stand in your corner office. */
  sit(): boolean;
  /** Status shown on screen for a worker, and when (unix ms) it got there. */
  status(workerId: string): { status: string; at: number } | null;
  /**
   * Workers per floor as the store sees them: `name`/`desk` as shown, and
   * what the bridge sent for them (null from a bridge without those fields).
   */
  world(): Array<{
    /** #58: the floor id (a real floor's is its session's name). */
    id: string;
    /** #58: the floor's name. */
    name: string;
    /** The herdr session it lives in (a virtual floor's base session). */
    session: string;
    virtual: boolean;
    hidden: boolean;
    /** M3: the building's name, null in the lot. */
    building: string | null;
    asleep: boolean;
    desks: number;
    workers: Array<{ id: string; name: string; label: string; desk: number; status: string; bridgeName: string | null; bridgeDesk: number | null; harness: string | null }>;
  }>;
  /** The office layout of a floor, in its building's outline (for scripted camera paths). */
  layout(floor: string): ReturnType<typeof floorLayout> | null;
  /** M3b: the building you walk around in (fire escape, lobby, street), null in the city. */
  building(): BuildingPlan | null;
  /** M3b: the building's id (null: the lot), name, floors ground first, and the floor with an interior. */
  where(): { building: string | null; name: string; floors: string[]; loaded: string | null } | null;
  /** M3b: rides the elevator to a building's lobby (null: the lot); no argument: the current building's. */
  enterLobby(building?: string | null): Promise<void>;
  /** M3b: the walk-out route (M4) from a desk of a floor, as waypoints. */
  route(floor: string, desk: number): Waypoint[];
  /** M3b: the receptionist's state: what it said (and when), the clip ids played, the cooldown ends, the bubble text. */
  reception(): ReturnType<import('./reception').Reception['debug']> | null;
  /** M3b: reception events the game detected (front door in / out, elevator arrival, E at the desk). */
  receptionEvents(): Array<{ ev: string; at: number; building: string | null }>;
  /** M15: the office radio: its genre (`off` too), the track, whether it is sounding (on its floor, not muted, fade in), the music volume. */
  radio(): { genre: string; trackId: string | null; playing: boolean; volume: number; muted: boolean } | null;
  /** M15: what the radio did, in order: genre changes, tracks picked and started, skipped files, fades in and out. */
  radioEvents(): Array<{ at: number; kind: string; genre?: string; trackId?: string; detail?: string }>;
  enterFloor(floor: string, pose?: Pose): Promise<void>;
  /** Applies a protocol event as if the bridge had sent it (drives live updates deterministically). */
  inject(e: WorldEvent): void;
  /** The world's worker as the bridge sent it (a copy; null: none). */
  worker(id: string): Worker | null;
  leaveFloor(): Promise<void>;
  /** `y` (feet above the street) places you on any floor, landing, the street or in the lobby. */
  setPose(p: Pose): void;
  /** M3b: with `y` (feet above the street), `area` and `storey` (the floor, or the landing's floor). */
  pose(): (Pose & { eye: number; y: number; area: Area; storey: number | null; floor: string | null; seated: boolean }) | null;
  plan(open: boolean): void;
  focusBuilding(i: number | null): void;
  /** Speech-bubble cards on screen and what they say; M5: a question (`ask`), the looked-at one's `usage`, `tall` when drawn with room for them. */
  cards(): Array<{ desk: number; name: string; display: string; task: string; ask?: { text: string; about?: string[]; choices: Array<{ n: number; label: string }>; selected?: number | undefined } | null; usage?: string | null; tall: boolean; tag?: { text: string; color: string } | null; stamp?: { tone: string; text: string } | null; crew?: string[] | null; tape?: { text: string; color: string; box?: boolean } | null }>;
  /** Screen point of a floor's badge in the city (to click it). */
  badgePoint(floor: string): { x: number; y: number } | null;
  /** M5: per worker of the floor you are on, what its laptop shows (live / pending / frozen / glow / dark) and its watch fps; #52: its pane, and whose screen is on its glass (`<worker id>@<pane>`, null: none). */
  screens(): Array<{ id: string; pane: string | null; desk: number; state: string; fps: number | null; shows: string | null }>;
  /**
   * #52: records what every laptop of the floor shows at each rendered frame (`screens()`, taken right after the frame is
   * drawn) from `true` on; `false` stops and returns the record.
   */
  screenTrace(on: boolean): Array<{ frame: number; screens: ReturnType<H3DDebug['screens']> }>;
  /** #52: the fixture simulator's `sim.swap`: a new pane under a worker, or a new worker at its desk (`sim=1`). */
  simSwap(args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string }>;
  /** M5: the worker whose laptop you sit at, or null. */
  seated(): string | null;
  /** M5: sits you at a worker's laptop as E does (false, with a toast, when you cannot). */
  sitAt(workerId: string): boolean;
  /** M5: a live laptop's screen text from its xterm buffer, one string per row (null when not live). */
  screenText(workerId: string): string[] | null;
  /** M5: how much of a worker's frozen laptop screen is not black (0–1), null when it is not frozen. */
  frozenInk(workerId: string): number | null;
  /** M5: the seat bar (shown, its tape, its note, ok / busy / error / offline); M16: which mode it shows. */
  seat(): { shown: boolean; tape: string; note: string; state: string; mode?: string; ask?: string | null; fullscreen?: { label: string; pressed: boolean; unavailable: boolean } | null };
  /** #74: plays the human unzooming the watched pane's tab, in the fixture simulator (`simzoom=`): a `terminal.state` follows. */
  simUnzoom(workerId: string): Promise<boolean>;
  /**
   * #59: the transcript's and the terminal's presets as picked (#216: and the application UI theme, `ui`), the one the terminal draws with (its fonts loaded),
   * each view's zoom, hidden tool calls, and the seated screen's font; `themeLoaded` settles when the latest picks'
   * fonts are in.
   */
  theme(): { ui: string; transcript: string; terminal: string; ready: string; transcriptZoom: number; terminalZoom: number; hideTools: boolean; showChanges: boolean; terminalFont: string | null };
  themeLoaded(): Promise<void>;
  /** #187: how many times the floor's scene was rebuilt (a desk count or building outline change) since the page opened. */
  officeRebuilds(): number;
  /** M16: the seated view's mode, its transcript watches and items, the overlay's box (null: hidden) and whether the view is mounted. */
  transcript(): ReturnType<import('./laptop').Laptops['transcriptState']> | null;
  /** M16 phase 2: the prints on the desks near you (per desk: worker, prints with tray/blank/loaded/slot x,z), the textures' ledger, the transcript watches and lightboxes opened from prints. */
  prints(): ReturnType<import('./laptop').Laptops['printsState']> | null;
  /** #98: per worker of the floor with an interior, what its desk monitor shows (card, rest, image, glance) and says; the cards' ledger. */
  monitors(): ReturnType<import('./laptop').Laptops['monitorsState']> | null;
  /** #98: where a worker's desk monitor's terminal area is on the viewport (CSS px), null when not on screen. */
  monitorRect(workerId: string): { left: number; top: number; width: number; height: number } | null;
  /** #98: the fixture simulator's `sim.activity` (a worker's activity, its status, an image it looks at). */
  simActivity(args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string }>;
  /** M16 phase 2: a print's world position (a debug camera aims at it). */
  printWorld(desk: number, index: number): { x: number; y: number; z: number } | null;
  /** M16 phase 2: clicks the print under a viewport point (NDC, -1..1) as the pointer would; true when one opened a lightbox. */
  clickPrint(ndcX: number, ndcY: number): boolean;
  /** The worker whose tag on an issue-wall note is under a viewport point (NDC, -1..1); null: none. */
  holderAt(ndcX: number, ndcY: number): string | null;
  /** M16: the fixture simulator's `sim.transcript` (push items to a watch, close it) and `sim.transcripts` (its watches). */
  simTranscript(args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string }>;
  simTranscripts(): Promise<{ watches: number; ids: string[] } | null>;
  /** #57: the fixture simulator's `sim.ask` (a worker's agent asks, or the terminal ends the ask). */
  simAsk(args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string }>;
  /**
   * #157: the fixture simulator's Codex async questions: `sim.codex` (ask a batch, change the launch, open an approval,
   * arm a failure), `sim.codex_answer` (the terminal answers), `sim.codex_turn_end` (`t` names which; fixture server only).
   */
  simCodex(t: 'sim.codex' | 'sim.codex_answer' | 'sim.codex_turn_end', args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string }>;
  /** #83: the fixture simulator's `sim.wrapup`: an armed worker's transcript reports `clean`, `blocked` (with a reason) or `none`. */
  simWrapUp(args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string }>;
  /** #106: the simulator moves a worker to a status (`sim.status`, a `worker.status` with a new `status_since`; fixture server only). */
  simStatus(id: string, status: string): Promise<boolean>;
  /** Release the fixture simulator’s held timers (`simclock=manual`), after the test observed the previous step. */
  simAdvance(ms: number): Promise<boolean>;
  /** #110: the simulator holds each later `packup.detect` ack this long after its answer (`sim.packup_lag`; fixture server only). */
  simPackupLag(ms: number): Promise<boolean>;
  /** M16 phase 2: the simulator's `sim.image` (makes a PNG, answers its ImageRef, to push in `simTranscript` items). */
  simImage(args: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  /** M16 phase 2: the image feeds alive (one per worker whose images are on screen) and the object URLs they hold. */
  imageFeeds(): { ids: string[] };
  /** M5: this connection's watches as the game counts them, and as the simulator (`sim=1`) does. */
  watches(): Promise<{ game: number; sim: number | null }>;
  /** M5: drops the connection and connects again (the bridge forgets every watch; the game re-watches). */
  reconnect(): void;
  /** M5: the `terminal.watch` / `unwatch` the game sent by itself (the last 400; `sent()` leaves them out). */
  watchLog(): Array<{ t: CommandName; args: unknown; result?: { ok: boolean; code?: string } }>;
  bench(o?: BenchOptions): Promise<BenchResult>;
  /** M3: opens the elevator panel of a building id (null: the lot); no argument: the current floor's building. */
  openElevator(building?: string | null): void;
  /** M3: opens the buildings panel. */
  openBuildings(): void;
  /** M3: opens a floor's settings panel. */
  openSettings(floor: string): void;
  /** #216: shows a toast of that kind (the UI theme's coverage and screenshots). */
  toast(message: string, kind?: 'info' | 'warn' | 'error', ms?: number): void;
  /** #216: picks the application UI theme as Settings → Appearance does (the live-switch tests). */
  setUiTheme(id: 'quiet' | 'ubuntu'): void;
  /** M3: what the open panel shows, null when none is open; M5: else the prompt overlay's, else the Changes panel's. */
  panel(): PanelSummary | PromptSummary | ChangesSummary | null;
  /** M3: commands sent to the bridge so far, with their result once answered. */
  sent(): Array<{ t: CommandName; args: unknown; result?: { ok: boolean; code?: string } }>;
  /** M3: screen point of a floor itself in the city (to click its building). */
  floorPoint(floor: string): { x: number; y: number } | null;
  /** M3: connection phase and the bridge epoch (changes when the bridge restarts). */
  connection(): { phase: string; epoch: string | null };
  /** M4: opens the hire dialog for a desk (0-based) of the floor you are on; no desk: the first free one (the top bar's Hire). */
  openHire(desk?: number): void;
  /** #212: opens the review of a dictated hire (a fixture interpretation until phase 4); nothing is sent until its Hire is pressed. */
  openHireReview(interp: HireInterpretation, desk?: number): boolean;
  /** #213: opens the dictation bar (as its chord does: movement let go, the keyboard's place remembered). */
  openDictation(): void;
  /** #213: what the dictation bar shows (state, text, its line, the floor list), null when it is closed. */
  dictation(): DictationSummary | null;
  /** #213: the fixture simulator's `sim.interpret` (`timeout_ms`: how long its `hire.interpret` waits for the LLM). */
  simInterpret(args: { timeout_ms?: number }): Promise<{ ok: boolean; code?: string }>;
  /** M4: opens the send-home dialog for a worker. */
  openSendHome(workerId: string): void;
  /** M4: what the open hire / send-home dialog shows, null when neither is open; M6: the presets panel (on top), else the start-run dialog first. */
  dialog(): HireSummary | ReviewSummary | SendHomeSummary | StartRunSummary | PresetsSummary | HirePresetsSummary | AddFloorSummary | OpenPrSummary | DictationSummary | SecretsReviewSummary | null;
  /** M6: the start-run dialog for a floor (default: yours) and desk (default: its first free one), as the top bar's Run and M7 open it. */
  openStartRun(o?: Partial<StartRunOptions>): void;
  /** M6: the team presets panel. */
  openPresets(): void;
  /** M4: workers walking out (M6b: or dropping in) right now (phase, position, how far along, what their desk shows). */
  arrivals(): ArrivalInfo[];
  /** M4: walks that ended: `played` false when nobody could see it (it resolved at once). */
  arrivalLog(): Array<{ id: string; kind: 'in' | 'out' | 'deliver'; played: boolean; floor: string; desk: number }>;
  /** M6c: how far the corner office's glass door is open (0..1; it opens for a walker up the stair like for you). */
  mezzDoor(): number;
  /** M6c: the in-trays of the floor with an interior: per orchestrator desk, the folders in it (edge colours, oldest first); `waiting`: reports queued behind a delivery; `pending`: deliveries not yet on a tray. */
  trays(): { trays: Array<{ desk: number; worker: string; folders: number; edges: number[] }>; waiting: number[]; pending: number };
  /** #223: the filing dialog and the cabinet as shown, the drawers' folder tabs and the filing walks; open them. */
  handoffDialog(): HandoffDialogSummary | null;
  cabinet(): CabinetSummary | null;
  filing(): { drawers: [number, number, number] | null; walks: string[] };
  openHandoff(id: string): void;
  openCabinet(floor?: string): void;
  /** #64 schedules: the scheduled agents dialog and its form as shown; open the dialog (as the Menu and palette do); the toast up now. */
  schedules(): SchedulesSummary | null;
  scheduleForm(): ScheduleFormSummary | null;
  openSchedules(o?: SchedulesOpen): void;
  toastState(): { shown: boolean; text: string; kind: string; action: string | null } | null;
  /** #64 schedules: the fixture bridge's schedule plays (`sim=1`, tools/fixture-schedule.ts). */
  simSchedule(t: 'sim.schedule_fire' | 'sim.schedule_fail', args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string }>;
  /** #108: the files the fixture bridge wrote for protected prompt secrets (`sim.secret_files`; the simulator's own). */
  simSecretFiles(): Promise<Array<{ path: string; owner: string; text: string }>>;
  /** M4: plays walks `k` times as fast (tests). */
  arrivalRate(k: number): void;
  /** M4: the desks of the floor with an interior: who sits there, whether its "+" shows, what a walk holds it as. */
  desks(): Array<{ desk: number; worker: string | null; plus: boolean; away: 'busy' | 'empty' | null }>;
  /** M6b: what a desk of the floor with an interior draws: its parts (instances drawn), the docked laptop's sticker, the dock side; `dropping`: a hire dropping in. */
  deskArt(desk: number): { parts: Record<string, number>; sticker: { logo: string; rim: number } | null; side: 1 | -1; dropping: boolean; band?: string | null } | null;
  /** M6b: where a worker's live screen is drawn (world centre and size) against its desk monitor's terminal area; null when not live. */
  screenMesh(workerId: string): ScreenMeshInfo | null;
  /** M5: N, as the key does: who it went to (null: nobody needs you). */
  nextNeed(): NeedItem | null;
  /** M5: who needs you, in the order N visits them. */
  needs(): NeedItem[];
  /** #100: the inbox chip (shown, count, whether someone needs you, its list open and the rows it shows), who is in it, and a row's teleport (resolves once you sit, or could not). */
  inbox(): ReturnType<InboxChip['summary']> | null;
  inboxItems(): NeedItem[];
  goToWorker(workerId: string): Promise<boolean>;
  /** M5: P / C on a worker, as the keys do. */
  openPrompt(workerId: string): void;
  openChanges(workerId: string): void;
  /** M5: stands you facing a worker of the floor you are on, as N does; false when look-at does not pick it from there. */
  face(workerId: string): boolean;
  /** M6: the crew of the floor with an interior (role, lifecycle, stamp, the crew parts drawn at its desk) and the crew parts drawn at all. */
  crew(): { members: CrewInfo[]; shown: string[] };
  /** M6: the scripted freelancer of the fixture simulator (`sim=1`): one `sim.crew` step. */
  simCrew(args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string }>;
  /** #92: the fixture simulator's `sim.ai {reject}`: a feature's call got the role's key rejected (`sim=1`). */
  simAi(args: Record<string, unknown>): Promise<{ ok: boolean; code?: string }>;
  /** #90: the fixture simulator's `sim.turn {id, text}`: a worker's agent ends its turn with that message (`sim=1`). */
  simTurn(args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string }>;
  /** #95: each hire's first prompt as the simulated worker got it, in order (`sim.first_prompts`; fixture server only). */
  simFirstPrompts(): Promise<Array<{ id: string; floor: string; prompt: string }>>;
  /** #223: the fixture bridge's handoff plays: `sim.final`, `sim.prompt_turn`, `sim.handoff_fail`. */
  simHandoff(t: 'sim.final' | 'sim.prompt_turn' | 'sim.handoff_fail' | 'sim.agent_turn' | 'sim.agent_skill' | 'sim.cache' | 'sim.handoff_llm' | 'sim.llm_finish', args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string }>;
  /** #90: the follow-up questions feature's state as the bridge last sent it (null: none). */
  followups(): FollowupsState | null;
  /** #110: pack up on request's settings and state as the bridge sent them (null: none). */
  packup(): FollowupsState | null;
  /** #98: the "Classify unknown commands" settings as the bridge last sent them (null: none). */
  activitySettings(): ActivityState | null;
  /** #98: the fixture simulator's `sim.activity_settings {env?, calls_today?, cache_size?}` (`sim=1`, tools/fixture-activity-settings.ts). */
  simActivitySettings(args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string }>;
  /** M7: the open Issues / Pull requests overlay (and its item modal), null when none is open. */
  board(): BoardSummary | null;
  /** M7: what the boards on the wall show: notes (with their atlas cell and pose), flights, gong rings, buffer writes. */
  boards(): ReturnType<import('./app').App['boardsInfo']>;
  /** M10: what the plan limits widget shows (null before the game is up). */
  limits(): ReturnType<import('./ui/limits').LimitsWidget['summary']> | null;
  /** M7: applies a board message as if the bridge had sent it. */
  injectBoard(m: BoardMessage): void;
  /** #52: the last board message of that kind of the floor you are on, as the game has it (a copy). */
  boardMessage(which: 'issues' | 'prs'): BoardMessage | null;
  /** M7: the overlay for the floor you are on, as the top bar's Issues / PRs (and E on a board) open it. */
  openBoard(which: 'issues' | 'prs'): void;
  /** M7: the overlay with an item's modal open (an opaque id). */
  openBoardItem(which: 'issues' | 'prs', id: string): void;
  /** M7: the `board.watch` / `unwatch` / `refresh` the game sent by itself (`sent()` leaves them out). */
  boardLog(): Array<{ t: CommandName; args: unknown; result?: { ok: boolean; code?: string } }>;
  /** M7: pages the game asked to open, and how (`helper`: the Mac helper's endpoint took it, `window`: a new window). */
  opened(): Array<{ url: string; via: string }>;
  /** M3d: what shows the building logos: fetches made, textures held, the city's signs (building, hash, lit) and, with a lobby, whether the entrance sign and the reception wall show the logo or the name. */
  logos(): ReturnType<import('./app').App['logoInfo']> | null;
  /** M7: the fixture simulator's `sim.boards` (merge a PR, make polls fail, …). */
  simBoards(args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string }>;
  /** #184: the fixture simulator's `sim.kaneo` (make a Kaneo board's polls fail, the next placed move stale, …). */
  simKaneo(args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string }>;
  /** #11: the fixture simulator's `sim.telegram` (pair now, expire the code, show a conflict, make tests blocked). */
  simTelegram(args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string }>;
  /** #74: the fixture simulator's `sim.host` (script the host's numbers) and `sim.host_log` (the commands and frames of this connection). */
  simHost(t: 'sim.host' | 'sim.host_log', args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; code?: string }>;
  /** M17: the light as shown (`daylight`, eased) and its `target`, the zone and where it comes from, the latitude, whether the time is pinned, the office lamps and what the wall clock's face shows. */
  daylight(): ReturnType<import('./app').App['daylightInfo']> | null;
  /** M13: the screen share (phase, surface, paused, video size), what this floor's TV shows, the frames answered and who looked. */
  screen(): ReturnType<import('./app').App['screenInfo']> | null;
  /** M13: sends `screen.grab` on the game's own connection, as M14's CLI would on its own (the fixture simulator answers it). */
  screenGrab(args: { floor: string; requester: string }): Promise<{ ok: boolean; data?: unknown; code?: string; message?: string }>;
  /** M13: Stop, as the top bar's button does. */
  screenStop(): void;
  /** M17: what the office clock shows, `14:05 · Wed 30 Sep` (null before the game is up). */
  clock(): string | null;
  /** M13: the floor's whiteboard (its state, what the room's board shows, the overlay), and opening it as E does. */
  whiteboard(): ReturnType<import('./app').App['whiteboardInfo']> | null;
  openWhiteboard(): void;
  /** M13: the open editor's Excalidraw API (for drawing in tests), null when none is open. */
  excalidraw(): unknown;
  /** M13: the `whiteboard.get`s the game sent by itself (`sent()` leaves them out). */
  wbLog(): Array<{ t: CommandName; args: unknown; result?: { ok: boolean; code?: string } }>;
  /** #100: the workers whose done is still settling before it pings. */
  pendingPings(): string[];
  /** #118: the floor overview page and the lounge wall's screen (what each shows). */
  overview(): ReturnType<import('./app').App['overviewInfo']> | null;
  /** #65: the departures boards: the floor's and the lobby's (what each shows, its redraws, the lobby's groups' boxes). */
  departures(): ReturnType<import('./app').App['departuresInfo']> | null;
  /** #74: the server rack: what it shows (screen mode, redraws, LED rates), the host watch and the commands sent for it. */
  rack(): ReturnType<import('./app').App['rackInfo']> | null;
  /** #74: shows or hides the floor's rack. */
  rackShown(on: boolean): void;
}

declare global {
  interface Window {
    __h3d: H3DDebug;
  }
}

const params = new URLSearchParams(window.location.search);
let app: App | null = null;
let renderer: THREE.WebGPURenderer | null = null;

/** #52: `screenTrace(true)`'s record, null while off. */
let screenTrace: Array<{ frame: number; screens: ReturnType<H3DDebug['screens']> }> | null = null;

const h3d: H3DDebug = {
  backend: null,
  frames: 0,
  error: null,
  ready: false,
  view: () => ({
    mode: app?.mode ?? 'city',
    floor: app?.office?.id ?? null,
    plan: app?.plan ?? false,
    busy: app?.busy ?? false,
    asleep: app?.officeAsleep ?? null,
    area: app?.mode === 'floor' ? app.place.area : null,
    building: app?.where?.name ?? null,
    seated: app?.seated ?? false,
    overlook: app?.overlooking ?? false,
  }),
  sit: () => app?.sit() ?? false,
  lookAt: () => app?.lookAt() ?? null,
  target: () => app?.targetInfo() ?? null,
  shortcutsOpen: () => app?.shortcuts.isOpen ?? false,
  status: (id) => app?.rendered.get(id) ?? null,
  world: () =>
    app
      ? app.store
          .city()
          .flatMap((b) => b.floors)
          .map((f) => ({
            id: f.id,
            name: f.name,
            session: f.baseSession,
            virtual: f.virtual,
            hidden: f.hidden,
            building: f.building?.name ?? null,
            asleep: f.asleep,
            desks: f.desks,
            workers: f.workers.map((w) => ({
              id: w.worker.id,
              name: w.name,
              label: w.worker.label,
              desk: w.desk,
              status: w.worker.status,
              bridgeName: w.worker.name ?? null,
              bridgeDesk: w.worker.desk_index ?? null,
              harness: w.harness ?? null,
            })),
          }))
      : [],
  layout: (s) => app?.layoutOf(s) ?? null,
  building: () => app?.plan3 ?? null,
  where: () => app?.where ?? null,
  enterLobby: async (b) => {
    if (!app) return;
    await app.enterLobby(b === undefined ? (app.where?.building ?? null) : b, { transition: false });
  },
  route: (s, desk) => {
    const L = app?.layoutOf(s);
    const w = app?.where;
    const plan = app?.plan3;
    const storey = w ? w.floors.indexOf(s) : -1;
    return L && plan && storey >= 0 ? walkOutRoute(L, plan, storey, desk) : [];
  },
  reception: () => app?.reception.debug() ?? null,
  receptionEvents: () => structuredClone(app?.receptionEvents ?? []),
  radio: () => (app ? { ...app.radio.state } : null),
  radioEvents: () => structuredClone([...(app?.radio.events ?? [])]),
  enterFloor: async (s, pose) => {
    await app?.enterFloor(s, pose ? { transition: false, pose } : { transition: false });
  },
  leaveFloor: async () => app?.leaveFloor(),
  inject: (e) => app?.inject(e),
  worker: (id) => {
    const w = app?.store.workers.get(id);
    return w ? (JSON.parse(JSON.stringify(w)) as Worker) : null;
  },
  setPose: (p) => app?.setPose(p),
  pose: () => (app?.mode === 'floor' ? app.pose() : null),
  plan: (open) => app?.setPlan(open),
  focusBuilding: (i) => app?.focusBuilding(i, false),
  cards: () => app?.office?.shownCards() ?? [],
  badgePoint: (s) => app?.badgePoint(s) ?? null,
  screens: () => app?.laptops.screens() ?? [],
  screenTrace: (on) => {
    const out = screenTrace ?? [];
    screenTrace = on ? [] : null;
    return out;
  },
  simSwap: async (args) => {
    if (!app) return { ok: false, code: 'not_started' };
    // `sim.swap` is the fixture simulator's, not a bridge command.
    const r = await app.client.request('sim.swap' as CommandName, args as never);
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: (r as { code?: string }).code ?? 'error' };
  },
  seated: () => app?.laptops.seated ?? null,
  officeRebuilds: () => app?.rebuilds ?? 0,
  sitAt: (id) => app?.sitAt(id) ?? false,
  screenText: (id) => app?.laptops.text(id) ?? null,
  frozenInk: (id) => app?.laptops.frozenInk(id) ?? null,
  seat: () => app?.seatBar.summary() ?? { shown: false, tape: '', note: '', state: '' },
  theme: () => {
    const t = app?.themes;
    return t
      ? { ui: t.ui.id, transcript: t.theme.id, terminal: t.terminal.id, ready: t.ready.id, transcriptZoom: t.prefs.zoom('transcript'), terminalZoom: t.prefs.zoom('terminal'), hideTools: t.prefs.hideTools, showChanges: t.prefs.showChanges, terminalFont: app?.laptops.seatedFont() ?? null }
      : { ui: '', transcript: '', terminal: '', ready: '', transcriptZoom: 100, terminalZoom: 100, hideTools: false, showChanges: true, terminalFont: null };
  },
  themeLoaded: () => app?.themes.loading ?? Promise.resolve(),
  transcript: () => app?.laptops.transcriptState() ?? null,
  prints: () => app?.laptops.printsState() ?? null,
  monitors: () => app?.laptops.monitorsState() ?? null,
  monitorRect: (id) => app?.laptops.monitorRect(id) ?? null,
  simActivity: async (args) => {
    if (!app) return { ok: false, code: 'not_started' };
    // `sim.activity` is the fixture simulator's, not a bridge command.
    const r = await app.client.request('sim.activity' as CommandName, args as never);
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: (r as { code?: string }).code ?? 'error' };
  },
  printWorld: (desk, index) => app?.laptops.printWorld(desk, index) ?? null,
  clickPrint: (x, y) => app?.clickPrintAt(x, y) ?? false,
  holderAt: (x, y) => app?.holderAtNdc(x, y) ?? null,
  simTranscript: async (args) => {
    if (!app) return { ok: false, code: 'not_started' };
    // `sim.transcript` is the fixture simulator's, not a bridge command.
    const r = await app.client.request('sim.transcript' as CommandName, args as never);
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: (r as { code?: string }).code ?? 'error' };
  },
  simAsk: async (args) => {
    if (!app) return { ok: false, code: 'not_started' };
    // `sim.ask` is the fixture simulator's, not a bridge command.
    const r = await app.client.request('sim.ask' as CommandName, args as never);
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: (r as { code?: string }).code ?? 'error' };
  },
  simCodex: async (t, args) => {
    if (!app) return { ok: false, code: 'not_started' };
    const r = await app.client.request(t as CommandName, args as never);
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: (r as { code?: string }).code ?? 'error' };
  },
  simAdvance: async (ms) => (await app?.client.request('sim.advance' as CommandName, { ms } as never))?.ok ?? false,
  simStatus: async (id, status) => (await app?.client.request('sim.status' as CommandName, { id, status } as never))?.ok ?? false,
  simPackupLag: async (ms) => (await app?.client.request('sim.packup_lag' as CommandName, { ms } as never))?.ok ?? false,
  simWrapUp: async (args) => {
    if (!app) return { ok: false, code: 'not_started' };
    // `sim.wrapup` is the fixture simulator's, not a bridge command.
    const r = await app.client.request('sim.wrapup' as CommandName, args as never);
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: (r as { code?: string }).code ?? 'error' };
  },
  simImage: async (args) => {
    if (!app) return null;
    const r = await app.client.request('sim.image' as CommandName, args as never);
    return r.ok ? (r.data as Record<string, unknown>) : null;
  },
  imageFeeds: () => ({ ids: app?.laptops.feeds.ids() ?? [] }),
  simTranscripts: async () => {
    if (!app) return null;
    const r = await app.client.request('sim.transcripts' as CommandName, {} as never);
    return r.ok ? (r.data as { watches: number; ids: string[] }) : null;
  },
  watches: async () => {
    if (!app) return { game: 0, sim: null };
    // `sim.watches` is the fixture simulator's, not a bridge command.
    const r = await app.client.request('sim.watches' as CommandName, {} as never);
    return { game: app.laptops.watchCount, sim: r.ok ? ((r.data as { watches?: number }).watches ?? null) : null };
  },
  simUnzoom: async (id) => (await app?.client.request('sim.unzoom' as CommandName, { id } as never))?.ok ?? false,
  reconnect: () => {
    app?.client.stop();
    app?.client.start();
  },
  watchLog: () => structuredClone(app?.watchLog ?? []),
  openElevator: (b) => (b === undefined ? app?.openElevator() : app?.openElevator(b)),
  openBuildings: () => app?.openBuildings(),
  openSettings: (s) => app?.panels.openSettings(s),
  toast: (message, kind = 'info', ms = 600_000) => app?.hud.toast(message, ms, kind),
  setUiTheme: (id) => app?.themes.prefs.setUiTheme(id),
  panel: () => app?.panels.summary() ?? app?.prompt.summary() ?? app?.changes.summary() ?? null,
  sent: () => structuredClone(app?.sent ?? []),
  floorPoint: (s) => app?.floorPoint(s) ?? null,
  connection: () => ({ phase: app?.conn.phase ?? 'stopped', epoch: app?.client.resume.epoch ?? null }),
  openHire: (desk) => app?.openHire(desk),
  openHireReview: (interp, desk) => app?.openHireReview(interp, desk) ?? false,
  openDictation: () => app?.openDictation(),
  dictation: () => app?.dictation.summary() ?? null,
  simInterpret: async (args) => {
    if (!app) return { ok: false, code: 'not_started' };
    // `sim.interpret` is the fixture simulator's, not a bridge command.
    const r = await app.client.request('sim.interpret' as CommandName, args as never);
    return r.ok ? { ok: true } : { ok: false, code: (r as { code?: string }).code ?? 'error' };
  },
  openSendHome: (id) => app?.openSendHome(id),
  // #108: the review of a prompt's secrets opens over the others (the P overlay, the pack-up confirm): it comes first.
  dialog: () => app?.secretsReview.summary() ?? app?.addFloor.summary() ?? app?.presetsPanel.summary() ?? app?.hirePresets.summary() ?? app?.openPr.summary() ?? app?.startRun.summary() ?? app?.hire.summary() ?? app?.hireReview.summary() ?? app?.sendHome.summary() ?? app?.dictation.summary() ?? null,
  openStartRun: (o) => app?.openStartRun(o),
  openPresets: () => app?.openPresets(),
  arrivals: () => app?.arrivals.info(performance.now() / 1000) ?? [],
  arrivalLog: () => structuredClone(app?.arrivals.log ?? []),
  arrivalRate: (k) => app?.arrivals.setRate(k, performance.now() / 1000),
  trays: () => app?.trayStates() ?? { trays: [], waiting: [], pending: 0 },
  handoffDialog: () => app?.handoffDialog.summary() ?? null,
  cabinet: () => app?.cabinet.summary() ?? null,
  filing: () => app?.filingStates() ?? { drawers: null, walks: [] },
  openHandoff: (id) => app?.openHandoff(id, false),
  openCabinet: (floor) => app?.openCabinet(floor ?? app.hereFloor()),
  schedules: () => app?.schedules.summary() ?? null,
  scheduleForm: () => app?.scheduleForm.summary() ?? null,
  openSchedules: (o) => app?.openSchedules(o),
  toastState: () => app?.hud.toastState() ?? null,
  simSchedule: async (t, args) => {
    if (!app) return { ok: false, code: 'not_started' };
    const r = await app.client.request(t as CommandName, args as never);
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: (r as { code?: string }).code ?? 'error' };
  },
  simSecretFiles: async () => {
    const r = await app?.client.request('sim.secret_files' as CommandName, {} as never);
    return r?.ok ? ((r.data as { files?: Array<{ path: string; owner: string; text: string }> }).files ?? []) : [];
  },
  mezzDoor: () => app?.office?.mezzDoor01 ?? 0,
  desks: () => app?.deskStates() ?? [],
  deskArt: (d) => {
    const o = app?.office;
    const info = o?.deskInfo(d);
    return o && info ? { ...info, dropping: o.dropping().includes(d) } : null;
  },
  screenMesh: (id) => app?.laptops.screenMesh(id) ?? null,
  nextNeed: () => app?.goNextNeed() ?? null,
  needs: () => app?.needs() ?? [],
  inbox: () => app?.inbox.summary() ?? null,
  inboxItems: () => app?.inboxItems() ?? [],
  goToWorker: (id) => app?.goToWorker(id) ?? Promise.resolve(false),
  openPrompt: (id) => app?.openPrompt(id),
  face: (id) => app?.faceWorker(id) ?? false,
  crew: () => app?.office?.crewInfo() ?? { members: [], shown: [] },
  simCrew: async (args) => {
    if (!app) return { ok: false, code: 'not_started' };
    // `sim.crew` is the fixture simulator's, not a bridge command.
    const r = await app.client.request('sim.crew' as CommandName, args as never);
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: (r as { code?: string }).code ?? 'error' };
  },
  simAi: async (args) => {
    if (!app) return { ok: false, code: 'not_started' };
    const r = await app.client.request('sim.ai' as CommandName, args as never);
    return r.ok ? { ok: true } : { ok: false, code: (r as { code?: string }).code ?? 'error' };
  },
  simHandoff: async (t, args) => {
    if (!app) return { ok: false, code: 'not_started' };
    const r = await app.client.request(t as CommandName, args as never);
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: (r as { code?: string }).code ?? 'error' };
  },
  simFirstPrompts: async () => {
    if (!app) return [];
    const r = await app.client.request('sim.first_prompts' as CommandName, {} as never);
    return r.ok ? (r.data as Array<{ id: string; floor: string; prompt: string }>) : [];
  },
  simTurn: async (args) => {
    if (!app) return { ok: false, code: 'not_started' };
    const r = await app.client.request('sim.turn' as CommandName, args as never);
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: (r as { code?: string }).code ?? 'error' };
  },
  board: () => app?.boardsPanel.summary() ?? null,
  boards: () => app?.boardsInfo() ?? null,
  limits: () => app?.limitsWidget.summary() ?? null,
  followups: () => app?.store.followups.state ?? null,
  packup: () => app?.store.packup.state ?? null,
  activitySettings: () => app?.store.activitySettings.state ?? null,
  simActivitySettings: async (args) => {
    if (!app) return { ok: false, code: 'not_started' };
    const r = await app.client.request('sim.activity_settings' as CommandName, args as never);
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: (r as { code?: string }).code ?? 'error' };
  },
  injectBoard: (m) => app?.injectBoard(m),
  boardMessage: (w) => {
    const s = app?.hereFloor();
    const b = s ? app?.boardBook.get(s) : null;
    return structuredClone((w === 'issues' ? b?.issues : b?.prs) ?? null);
  },
  openBoard: (w) => app?.openBoard(w),
  openBoardItem: (w, id) => {
    const s = app?.hereFloor();
    if (s) app?.boardsPanel.openItem(w, s, id);
  },
  boardLog: () => structuredClone(app?.boardLog ?? []),
  opened: () => structuredClone(app?.opened ?? []),
  simBoards: async (args) => {
    if (!app) return { ok: false, code: 'not_started' };
    // `sim.boards` is the fixture simulator's, not a bridge command.
    const r = await app.client.request('sim.boards' as CommandName, args as never);
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: (r as { code?: string }).code ?? 'error' };
  },
  simKaneo: async (args) => {
    if (!app) return { ok: false, code: 'not_started' };
    const r = await app.client.request('sim.kaneo' as CommandName, args as never);
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: (r as { code?: string }).code ?? 'error' };
  },
  simTelegram: async (args) => {
    if (!app) return { ok: false, code: 'not_started' };
    const r = await app.client.request('sim.telegram' as CommandName, args as never);
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: (r as { code?: string }).code ?? 'error' };
  },
  simHost: async (t, args) => {
    if (!app) return { ok: false, code: 'not_started' };
    const r = await app.client.request(t as CommandName, args as never);
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: (r as { code?: string }).code ?? 'error' };
  },
  logos: () => app?.logoInfo() ?? null,
  daylight: () => app?.daylightInfo() ?? null,
  screen: () => (app ? structuredClone(app.screenInfo()) : null),
  screenGrab: async (args) => {
    if (!app) return { ok: false, code: 'not_started' };
    const r = await app.client.request('screen.grab', args, { timeoutMs: 15_000 });
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: r.code, message: r.message };
  },
  screenStop: () => app?.screen.stop(),
  clock: () => (app?.clockFace.time ? `${app.clockFace.time} · ${app.clockFace.date}` : null),
  whiteboard: () => app?.whiteboardInfo() ?? null,
  openWhiteboard: () => app?.openWhiteboard(),
  excalidraw: () => app?.whiteboard.current?.excalidraw ?? null,
  wbLog: () => structuredClone(app?.wbLog ?? []),
  pendingPings: () => app?.pendingPings() ?? [],
  overview: () => (app ? structuredClone(app.overviewInfo()) : null),
  departures: () => (app ? structuredClone(app.departuresInfo()) : null),
  rack: () => (app ? structuredClone(app.rackInfo()) : null),
  rackShown: (on) => app?.rackShown(on),
  openChanges: (id) => {
    if (app?.changes.worker !== id) app?.toggleChanges(id);
  },
  bench: async (o) => {
    if (!app || !renderer) throw new Error('not started');
    return runBench(app, renderer, o);
  },
};
window.__h3d = h3d;

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** #57: the bridge in use when the helper last said (shared; only read when it does not answer at start). */
const LAST_BRIDGE_KEY = 'h3d.bridges.active';

function rememberBridge(id: string): void {
  try {
    safeLocalStorage()?.setItem(LAST_BRIDGE_KEY, id);
  } catch {
    // not remembered
  }
}

function rememberedBridge(): string | null {
  try {
    return safeLocalStorage()?.getItem(LAST_BRIDGE_KEY) || null;
  } catch {
    return null;
  }
}

async function start(): Promise<void> {
  const r = new THREE.WebGPURenderer({
    antialias: true,
    forceWebGL: forceWebGLFromSearch(window.location.search),
    trackTimestamp: params.has('ts'),
  });
  renderer = r;
  r.setPixelRatio(window.devicePixelRatio);
  r.setSize(window.innerWidth, window.innerHeight);
  r.shadowMap.enabled = params.get('shadows') !== '0';
  r.shadowMap.type = THREE.PCFShadowMap;
  document.body.appendChild(r.domElement);
  await r.init();

  h3d.backend = backendName(r.backend);
  const buildInfo = new BuildInfo();
  buildInfo.setBackend(h3d.backend);
  const overlay = document.getElementById('debug');
  if (overlay) overlay.textContent = `backend: ${h3d.backend}`;

  // #57: a page the helper serves (it has a token) asks it which bridge is in use, alongside the font, before anything
  // reads the per-bridge keys; the helper answers from memory (never after an ssh handshake), within 2.5 s or not at all.
  const token = takeToken(window.location, safeLocalStorage(), (u) => history.replaceState(null, '', u));
  const bridges = new BridgeBook(token ? new BridgeApi(token) : null);
  const [list] = await Promise.all([
    bridges.api?.load() ?? Promise.resolve(null),
    // Canvas text (boards, cards) needs the font before it is drawn.
    Promise.race([
      Promise.all(['800 32px "Recursive Variable"', '500 25px "Recursive Variable"'].map((f) => document.fonts.load(f))),
      new Promise((res) => setTimeout(res, 1500)),
    ]),
  ]);
  if (list) {
    // The keys kept before #57 belong to the first bridge (the one an install from before came up with).
    if (list.bridges[0]) migrateBridgeKeys(safeLocalStorage(), list.bridges[0].id);
    setBridgeScope(list.active || null);
    rememberBridge(list.active);
    bridges.set(list);
  } else if (token) {
    // The helper did not answer in time: the bridge it last named, so drafts never land in another bridge's keys.
    setBridgeScope(rememberedBridge());
  }

  void loadHelperVersion().then((v) => buildInfo.setHelper(v));
  app = new App({ renderer: r, host: document.body, params, buildInfo, onBridgeVersion: (v) => buildInfo.setBridge(v), token, bridges });
  const a = app;
  const origRender = a.render.bind(a);
  a.render = () => {
    origRender();
    h3d.frames = a.frames;
    screenTrace?.push({ frame: a.frames, screens: a.laptops.screens() });
    if (!h3d.ready && a.store.snapshots > 0) h3d.ready = true;
  };
  a.start();
  const floor = params.get('floor');
  if (floor) {
    const wait = setInterval(() => {
      if (a.store.floorView(floor)) {
        clearInterval(wait);
        void a.enterFloor(floor, { transition: false }).then(() => {
          if (params.get('plan') === '1') a.setPlan(true);
        });
      }
    }, 50);
  }
}

if (params.has('composer-demo')) {
  // #51, test only: the prompt composer in a fixture dialog, no game (e2e/composer.spec.ts). Loaded on this parameter only.
  void import('./ui/composer/demo').then((m) => m.mountDemo());
} else {
  start().catch((err: unknown) => {
    h3d.error = String(err);
    console.error('h3d: renderer failed to start', err);
    const overlay = document.getElementById('debug');
    if (overlay) {
      overlay.textContent = `renderer error: ${String(err)}`;
      overlay.classList.add('error');
    }
  });
}
