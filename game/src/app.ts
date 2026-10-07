import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BridgeClient, type CommandResult, type ConnState, type SocketLike } from './net/client';
import { bridgeUrl, takeToken } from './net/endpoint';
import { postUpload } from './net/upload';
import { loggedArgs } from './net/redact';
import { deleteLogo, logoUrl, putLogo } from './net/logo';
import { LogoCache } from './render/logos';
import { LogoSync } from './render/logoSync';
import { logoHashOf, type AnswerAck, type AnswerAskAck, type Ask, type BoardMessage, type CommandArgs, type CommandName, type IssueCard, type MergedPullRequest, type PullRequest, type Question, type WatchBoardAck, type WorldEvent } from './net/protocol';
import { CityView } from './render/city';
import { shouldRender, targetHz } from './render/framePolicy';
import { Arrivals, type ArrivalInfo, type ArrivalSpec, type DeliverSpec } from './render/arrivals';
import { memberOf, OfficeView, REACH, seatOf, type Target } from './render/office';
import { OutsideView } from './render/outside';
import { BUILDING_TINTS, LOT_TINT } from './render/palette';
import { WalkView } from './render/walk';
import { DaylightEase, lookOf } from './render/daylook';
import { TimeOfDay, overridesFrom } from './world/timeOfDay';
import type { Daylight } from './world/daylight';
import { TimePrefs } from './ui/timePrefs';
import { RadioLink } from './radio/link';
import { createGameAudio, createReception, receptionContext, type GameAudio, type Reception, type ReceptionEvent } from './reception';
import { Hud, type PlanLabel } from './ui/hud';
import { HireDialog, type HirePrefill } from './ui/hire';
import { Panels } from './ui/panels';
import { SendHomeDialog } from './ui/sendHome';
import { needsYouText, sentHomeText, wrapUpOf } from './world/wrapup';
import { RADIUS, Walker } from './input/walk';
// #124: the keyboard shortcuts, one table (dispatch, the ? reference, the hints and the top bar's titles).
import { binding, findBinding, keyName, loadLayout, pressesBinding, type DispatchedId, type Match, type Scope } from './input/shortcuts';
import { typingIn } from './input/typing';
import { ShortcutsDialog } from './ui/shortcutsDialog';
import { Palette } from './ui/palette';
import { paletteCommands, type PaletteCommand } from './world/palette';
import { Laptops, type WatchCommand } from './laptop';
import { SeatBar } from './ui/seat';
import { blocked, blocked3, groundAt, nudgeClear, type WalkWorld } from './world/collide';
import { buildingPlan, floorY, loadedFloor, placeAt, walkWorld, type Area, type BuildingPlan, type Place } from './world/building';
import { EYE_HEIGHT, floorLayout as floorLayoutIn, openingsFor, outlineOf, overlookReach, seatRect, type Opening, type Outline } from './world/layout';
import { STAND_LIFT, type ArrivalKind } from './world/arrival';
import { displayName, resolveHarness, type Display } from './world/derive';
import { firstFreeDesk, freeDesks, isFreshHire, Reservations } from './world/hire';
import { deskToDeskRoute, handOver, walkOutRoute, type Dest, type Waypoint } from './world/route';
// M6c: reports walk over to the orchestrator's desk.
import { DeliveryBook, reportArrived, reportFact, trayFolderAt, TRAY_CAP, type Entry, type ReportFact, type TrayPose } from './world/delivery';
import { toneColor } from './render/tray';
import { WorldStore, type Change, type Counts, type FloorView, type WorkerView } from './world/store';
// M5: P prompt, C changes, N next, 1–9 / 0 quick replies.
import { ChangesPanel } from './ui/changes';
import { failureText as commandFailure } from './ui/messages';
import { PromptOverlay } from './ui/prompt';
import { answerable, answerArgs, answerKeys, digitPick, pickLabel, questionLine, type Pick as AnswerPick } from './world/answer';
import { askLine, askOf, isSimple, optionLabel, quickReplyBlocker } from './world/ask';
import { faceSpots, needQueue, nextNeed, type NeedItem } from './world/next';
import { promptBlocker } from './world/prompt';
// M6 start: starting a run from an empty desk or the top bar; team presets.
import { m6StartButtons, type M6StartButtons } from './ui/startButtons';
import { PresetsPanel } from './ui/presets';
import { runUnsupported, StartRunDialog, type StartRunOptions } from './ui/startRun';
// M6 crew: freelancers drop in (M6b) and walk out with their briefcase.
import { crewRole, inputRequired, isFreelancer } from './world/crew';
// M7: the issues and pull request boards.
import { askPrompt, BoardBook, nearestDesk, reviewPrompt } from './world/boards';
import { BoardsPanel, type BoardOff, type BoardState } from './ui/boards/panel';
import { openExternal } from './ui/boards/external';
import { OpenPrDialog } from './ui/boards/openPr';
// M13 screen share
import { ScreenShareController } from './screen';
// M10 limits
import { LimitsWidget } from './ui/limits';
// #100 the inbox chip under them
import { InboxChip, type InboxEntry } from './ui/inbox';
import { HirePrefs } from './ui/hirePrefs';
import { onPlayerAct, waitForHire } from './ui/hireGoto';
import { InboxPrefs } from './ui/inboxPrefs';
import { inboxQueue, inboxReason, inboxWhere, type InboxCandidate } from './world/inbox';
// #92 AI integration
import { aiSection } from './ui/aiSection';
// #90 follow-up questions
import { followupsSection } from './ui/followupsSection';
import { packupSection } from './ui/packupSection';
import { digestSection } from './ui/digestSection';
import { digestFailureText } from './world/digestSettings';
import { packupApplies, packupVerdict, type PackupOutcome } from './world/packup';
import { activitySection } from './ui/activitySection';
import { codexServerSection } from './ui/codexServerSection';
import { aiChip } from './world/ai';
import { LimitsPrefs } from './ui/limitsPrefs';
import { MonitorPrefs } from './ui/monitorPrefs';
import type { SettingsDialog } from './ui/settings';
import { displaySection, timeSection } from './ui/settingsSections';
import { notifySection } from './ui/notifySection';
import { ThemeLoader } from './ui/themeLoader';
import { ViewPrefs } from './ui/themePrefs';
import { can } from './world/boards';
import { bannerVersion, type BuildInfo } from './version';
// M13: the whiteboard (Excalidraw, loaded on first use) and its render on the room's board.
import { WhiteboardOverlay } from './ui/whiteboard';
// #118: the floor overview (the lounge wall's screen and its page).
import { OverviewOverlay, type ViewRect } from './ui/overview';
import { OverviewPrefs } from './ui/overviewPrefs';
import { buildOverview, countItems, type OverviewData } from './world/overview';
import { loadBoardTexture } from './render/whiteboardTexture';
import type { WhiteboardState } from './net/protocol';
// #100: the inbox's pings (desktop notifications, the chime)
import { awayText, burstText, BURST_TAG, DesktopNotify, pingTitle } from './ui/desktopNotify';
import { InboxPings, pingEntries, type PingEntry, type PingOut } from './world/inboxPings';

export interface AppOptions {
  renderer: THREE.WebGPURenderer;
  host: HTMLElement;
  params: URLSearchParams;
  /** The build info the About panel shows. */
  buildInfo?: BuildInfo;
  /** The bridge's build version, from each welcome (null when it does not say). */
  onBridgeVersion?: (version: string | null) => void;
}

export interface LookAt {
  kind: Target['kind'];
  id: string;
  /** A worker's name; for your own desk (#20), the name on its plate. */
  name?: string;
  label?: string;
}

export interface Pose {
  x: number;
  z: number;
  yaw: number;
  pitch?: number;
  /** Feet above the street (absolute). Left out: stay at the current level. */
  y?: number;
}

type Mode = 'city' | 'floor';

/** The building you walk around in: its floors (ground first), outline, plan and look. */
interface BuildingCtx {
  id: string | null;
  name: string;
  tint: number;
  floors: FloorView[];
  outline: Outline;
  openings: Opening[];
  plan: BuildingPlan;
  /** Changes when the outside has to be rebuilt (floors, their order, size, name, colour). */
  shape: string;
}

const CLIENT = 'herdr-3d-game/0.2';
/** Gap between the gong rings of several PRs merged in one poll. */
const GONG_GAP_MS = 450;

/** Everything between the renderer and the bridge: views, input, HUD, frame pacing. */
export class App {
  readonly store = new WorldStore();
  /** M10 limits: the always-on plan limits widget and what it remembers. */
  private readonly limitsPrefs = new LimitsPrefs();
  /** #98: what the desk monitors show while you stand: the agent's activity, or its terminal. */
  readonly monitorPrefs = new MonitorPrefs();
  /** #59: the transcript's and the terminal's presets (fonts, colours) and zooms, and hidden tool calls. */
  readonly themes = new ThemeLoader(new ViewPrefs());
  /** M17: the time of day: the settings (Settings), the page's overrides, the eased light and the clock. */
  readonly timePrefs = new TimePrefs();
  /** #91: the Settings window; features add their sections to it (`settings.addSection`). */
  readonly settings: SettingsDialog;
  readonly timeOfDay: TimeOfDay;
  readonly daylight = new DaylightEase();
  /** The last sample read, and what the clock shows from it. */
  private sample: Daylight | null = null;
  clockFace = { time: '', date: '', zone: '' };
  /** When to read the time again (Date.now ms; the next minute, or never while pinned). */
  private nextRead = 0;
  private clockOffice: OfficeView | null = null;
  readonly limitsWidget: LimitsWidget;
  /** #100: the inbox chip under the plate, its list, and what it remembers per browser. */
  readonly inbox: InboxChip;
  readonly inboxPrefs = new InboxPrefs();
  readonly hirePrefs = new HirePrefs(); // #116
  /** #116: cancels the go-to still waiting for its new hire. */
  private stopHireGoto: (() => void) | null = null;
  private hireGotoGen = 0;
  readonly hud: Hud;
  readonly city: CityView;
  readonly client: BridgeClient;
  readonly panels: Panels;
  /** M4: the hire and send-home dialogs, and the workers dropping in (M6b) and walking out. */
  readonly hire: HireDialog;
  readonly sendHome: SendHomeDialog;
  readonly arrivals: Arrivals;
  /** M6c: the reports on their way to an orchestrator's desk, and what is in its in-tray. */
  private readonly deliveries = new DeliveryBook();
  /** What each delivery on its way was built against (its key → the layout and orchestrator seat), to tell when the world moved under it. */
  private readonly deliveryCtx = new Map<string, { layout: object; orchDesk: number; corner: boolean; leaving?: boolean }>();
  /** M4: hires on their way: their desks' "+" is hidden until the worker is there. */
  private readonly reserved = new Reservations();
  /** Commands sent to the bridge, in order (test hook). */
  readonly sent: Array<{ t: CommandName; args: unknown; result?: CommandResult }> = [];
  /** Commands the bridge answered `unknown_command` for: an older bridge. */
  private readonly unsupported = new Set<CommandName>();
  mode: Mode = 'city';
  /** The floor with an interior: the one you are on, or (outside) the one you last left; null in the lobby. */
  office: OfficeView | null = null;
  /** Where you are in the building (walk mode). */
  place: Place = { area: 'floor', storey: null };
  /** Reception events the app detected, in order (test hook), and the receptionist once coder B's module is in. */
  readonly receptionEvents: Array<{ ev: ReceptionEvent; at: number; building: string | null }> = [];
  readonly audio: GameAudio;
  readonly reception: Reception;
  /** M15: the office radio (E and R on it, fades with where you are, toast, display). */
  readonly radio: RadioLink;
  /** M13: the screen share and the TV that shows it. */
  readonly screen: ScreenShareController;
  /** Worker id → status on screen as of the last rendered frame, and when it got there. */
  readonly rendered = new Map<string, { status: Display; at: number }>();
  frames = 0;
  batterySaver = false;
  conn: ConnState = { phase: 'stopped' };
  readonly url: string;
  /** M3d: the building logos' textures, by hash. */
  readonly logos = new LogoCache();
  private logoSig = '';
  private readonly logoSync = new LogoSync(
    this.logos,
    (b, hash) => logoUrl(this.url, b, hash),
    (loaded) => {
      this.syncLogos();
      if (!loaded) this.panels.refresh(); // the Buildings panel says when a saved logo could not be loaded
    },
  );
  /** #20: the name on your desk's name plate (`?me=`; the bridge sends no user name yet). */
  readonly owner: string;
  /** M5: live laptop screens, sitting at a worker's laptop, and the bar while you do. */
  readonly laptops: Laptops;
  readonly seatBar: SeatBar;
  /** M5: the `terminal.watch` / `unwatch` the game sends by itself, the last 400 (test hook; not in `sent`). */
  readonly watchLog: Array<{ t: CommandName; args: unknown; result?: CommandResult }> = [];
  /** M5: P, the prompt overlay; C, the Changes side panel. */
  readonly prompt: PromptOverlay;
  readonly changes: ChangesPanel;
  /** #124: the `?` shortcut reference. */
  readonly shortcuts: ShortcutsDialog;
  /** #147: the command palette (⌘/Ctrl+P), from every view. */
  readonly palette: Palette;
  /** M5: the worker N went to last (the next N goes on from there), and one it rides the elevator to. */
  private lastNeed: string | null = null;
  private pendingNeed: NeedItem | null = null;
  /** M5: workers with an answer on its way. */
  private readonly answering = new Set<string>();
  /** M6 start: the start-run dialog, the team presets panel and their top bar buttons. */
  readonly startRun: StartRunDialog;
  readonly presetsPanel: PresetsPanel;
  private readonly m6Buttons: M6StartButtons;
  /** M7: the boards' state (last messages per floor), their overlay and item modals. */
  readonly boardBook = new BoardBook();
  readonly boardsPanel: BoardsPanel;
  /** M7: "Open PR" for a plain worker, from its Changes panel. */
  readonly openPr: OpenPrDialog;
  /** M7: the `board.watch` / `unwatch` / `refresh` the game sends by itself, the last 400 (test hook; not in `sent`). */
  readonly boardLog: Array<{ t: CommandName; args: unknown; result?: CommandResult }> = [];
  /** M13: the whiteboard overlay, each floor's board as last heard of, and the `whiteboard.get`s the game sent by itself (test hook; not in `sent`). */
  readonly whiteboard: WhiteboardOverlay;
  /** #118: the floor overview page, and when the wall screen and the page last had the world as it is. */
  readonly overview: OverviewOverlay;
  private overviewDirty = true;
  private overviewAt = 0;
  private overviewOffice: OfficeView | null = null;
  private readonly wbStates = new Map<string, WhiteboardState>();
  private readonly wbFetching = new Set<string>();
  private wbLoad: { office: OfficeView; key: string; abort: AbortController } | null = null;
  readonly wbLog: Array<{ t: CommandName; args: unknown; result?: CommandResult }> = [];
  /** M7: pages the game asked to open, and how (test hook). */
  readonly opened: Array<{ url: string; via: string }> = [];
  private readonly token: string | null;
  private readonly noOpen: boolean;
  /** The floor this connection watches for boards (null: none). */
  private watched: string | null = null;
  /** `board.watch` answers by floor (`enabled: false` with a reason: no repo linked). */
  private readonly boardWatch = new Map<string, { enabled: boolean; reason?: string }>();

  private readonly r: THREE.WebGPURenderer;
  private readonly cityCam: THREE.PerspectiveCamera;
  private readonly fpCam: THREE.PerspectiveCamera;
  private readonly planCam: THREE.OrthographicCamera;
  private readonly controls: OrbitControls;
  private readonly walker: Walker;
  private readonly walk: WalkView;
  private building: BuildingCtx | null = null;
  /** Storey of the floor with an interior (null: none, e.g. in the lobby). */
  private loaded: number | null = null;
  private worldCache: { key: unknown[]; world: WalkWorld } | null = null;
  /** #187: how often the floor's scene was rebuilt (a desk count or outline change), for the tests. */
  rebuilds = 0;
  private fireDoor = 0;
  private mezzDoor = 0;
  /** Whether the hint on screen is the seated one. */
  private hintSitting = false;
  private readonly shadows: boolean;
  private planOpen = false;
  private lastActivity = 0;
  private lastRender = -Infinity;
  private lastT = 0;
  private statusDirty = true;
  private cameraMoved = true;
  private focus: number | null = null;
  private tween: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; t0: number; ms: number } | null = null;
  private target: Target | null = null;
  /** #124: a worker, desk or prop picked with T instead of aimed at, and where the walker looked when it was: moving or turning lets it go. */
  private keyTarget: { target: Target; session: string; pose: { x: number; z: number; yaw: number; pitch: number } } | null = null;
  private transitioning = false;
  private readonly fixture: boolean;
  private readonly vp = { width: 1, height: 1 };
  private readonly ray = new THREE.Vector3();
  private down: { x: number; y: number } | null = null;
  private planLabelsKey = '';
  /** World data behind the plan labels changed (status, names, seats). */
  private planDirty = false;

  constructor(o: AppOptions) {
    this.r = o.renderer;
    this.shadows = o.params.get('shadows') !== '0';
    this.owner = (o.params.get('me') ?? '').trim().slice(0, 40) || 'You';
    this.batterySaver = o.params.get('battery') === '1';
    this.timeOfDay = new TimeOfDay(this.timePrefs, overridesFrom(o.params, (m) => console.warn(m)));
    this.hud = new Hud(o.host);
    this.hud.setBattery(this.batterySaver);
    // Sound (the first click, key or pointer lock unlocks it) and the receptionist in every lobby.
    this.audio = createGameAudio();
    this.hud.mountAudio(this.audio);
    if (o.buildInfo) this.hud.mountAbout(o.buildInfo);
    this.settings = this.hud.mountSettings();
    this.shortcuts = new ShortcutsDialog(o.host);
    this.palette = new Palette(o.host, {
      commands: () => paletteCommands(this.activeScopes()),
      store: this.store,
      here: () => this.hereSession(),
      online: () => this.conn.phase === 'live',
      run: (c, floor) => void this.runPaletteCommand(c, floor),
      goTo: (s) => void this.goToFloor(s),
    });
    this.settings.addSection('display', 'Display', displaySection(this.limitsPrefs, this.monitorPrefs, this.inboxPrefs, this.hirePrefs), { store: 'browser' });
    this.settings.addSection('time', 'Day and night', timeSection({ prefs: this.timePrefs, time: this.timeOfDay }), { store: 'browser' });
    // #100: how the inbox reaches you beyond its chip: desktop notifications and the chime.
    this.settings.addSection('notifications', 'Notifications', notifySection({ prefs: this.inboxPrefs, audio: this.audio }), { store: 'browser' });
    // #92: the bridge-wide AI models. A chip while one is set up but unusable, a toast when a call just stopped one.
    this.settings.addSection(
      'ai',
      'AI integration',
      aiSection({ book: this.store.ai, send: (t, args) => this.send(t, args), usedBy: { classifier: ['Follow-up questions', 'Pack up on request', 'Classify unknown commands'], llm: ['Follow-up questions', 'Pack up on request', 'Floor overview summaries'] } }),
      { store: 'bridge' },
    );
    // #90: the first feature on those models: its own switch and threshold, under them.
    const settings = this.settings;
    settings.addSection('followups', 'Follow-up questions', followupsSection({ book: this.store.followups, send: (t, args) => this.send(t, args), showAi: () => settings.reveal('ai') }), {
      store: 'bridge',
    });
    // #110: the second, on the prompts you send: strip a "then go home" and send the worker home after the task.
    settings.addSection('packup', 'Pack up on request', packupSection({ book: this.store.packup, send: (t, args) => this.send(t, args), showAi: () => settings.reveal('ai') }), {
      store: 'bridge',
    });
    // #98: the desk monitors' words for the commands the rules can't place, on the same classifier (absent without the service).
    settings.addSection(
      'activity',
      'Classify unknown commands',
      activitySection({ book: this.store.activitySettings, send: (t, args) => this.send(t, args), showAi: () => settings.reveal('ai') }),
      { store: 'bridge' },
    );
    // #118: the floor overview's task and now lines, written by the LLM for the floors someone is viewing.
    settings.addSection(
      'digest',
      'Floor overview summaries',
      digestSection({ book: this.store.digestSettings, send: (t, args) => this.send(t, args), showAi: () => settings.reveal('ai') }),
      { store: 'bridge' },
    );
    // #155: whether new Codex workers get a Codex server of their own (the bridge's switch, off by default).
    settings.addSection('codex', 'Codex workers', codexServerSection({ book: this.store.codexServer, send: (t, args) => this.send(t, args) }), { store: 'bridge' });
    this.store.ai.onChange((notice) => {
      this.hud.setAiChip(aiChip(this.store.ai.state));
      if (notice) this.hud.toast(notice, 7000, 'error');
    });
    this.limitsWidget = new LimitsWidget(
      this.hud.root,
      this.store.limits,
      { now: () => Date.now(), refresh: () => this.send('limits.refresh', {}), toast: (m) => this.hud.toast(m, 3600, 'info') },
      this.limitsPrefs,
    );
    // Nothing re-renders it between readings but a reading turning stale.
    setInterval(() => this.limitsWidget.tick(), 30_000);
    this.inbox = new InboxChip(this.hud.root, this.limitsWidget.root, { go: (id) => void this.goToWorker(id), dismiss: (id) => void this.dismissInbox(id), now: () => Date.now() });
    this.inbox.enabled = this.inboxPrefs.settings.show;
    this.inboxPrefs.onChange(() => {
      this.inbox.enabled = this.inboxPrefs.settings.show;
      this.inbox.set(this.inboxEntries());
    });
    this.reception = createReception({ audio: this.audio, overlay: this.hud.root, shadows: this.shadows });
    this.radio = new RadioLink({ music: this.audio.music, toast: (m, ms, soft) => this.hud.toast(m, ms, 'info', soft), hudRadio: (n) => this.hud.setRadio(n) });
    this.city = new CityView(
      this.hud.floorList,
      this.shadows,
      (s) => void this.enterFloor(s),
      this.hud.buildingList,
      (b) => this.openElevator(b),
    );
    this.city.badges = o.params.get('badges') !== '0';

    this.cityCam = new THREE.PerspectiveCamera(42, 1, 0.1, 600);
    this.fpCam = new THREE.PerspectiveCamera(70, 1, 0.05, 320);
    this.walk = new WalkView(this.shadows);
    // M17: start at the time's light (not eased from noon), and follow the settings live.
    this.readTime(true);
    this.timePrefs.onChange(() => this.readTime(false));
    this.planCam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
    this.controls = new OrbitControls(this.cityCam, this.r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = 1.38;
    this.controls.minAzimuthAngle = -0.45;
    this.controls.maxAzimuthAngle = 1.95;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 220;
    this.controls.addEventListener('change', () => this.activity(true));
    this.controls.addEventListener('start', () => (this.tween = null));

    this.walker = new Walker(
      this.r.domElement,
      () => this.activity(true),
      (locked, error) => {
        if (error && this.mode === 'floor') {
          this.setPlan(true);
          this.hud.toast('Mouse look needs pointer lock, which this browser refused. The floor plan works instead.');
        }
        this.updateHint();
        this.activity(false);
      },
    );

    this.fixture = /\/fixture\//.test(o.params.get('ws') ?? '');
    const token = takeToken(window.location, safeStorage(), (u) => history.replaceState(null, '', u));
    this.token = token;
    this.noOpen = o.params.get('open') === 'none';
    this.url = bridgeUrl(window.location, token);
    this.client = new BridgeClient({
      url: this.url,
      clientName: CLIENT,
      socket: (u) => new WebSocket(u) as unknown as SocketLike,
      handlers: {
        onWelcome: (w) => o.onBridgeVersion?.(bannerVersion(w.server)),
        onSnapshot: (s) => {
          this.applyChange(this.store.applySnapshot(s));
          this.yieldTakenDesks(this.store.workers.keys());
          this.syncDeliveries(); // M6c
        },
        onEvent: (e) => this.onWorldEvent(e),
        onConn: (m) => this.laptops.onConn(m),
        onBoard: (m) => this.onBoard(m),
        onScreen: (m) => this.screen.onMessage(m), // M13 screen
        onState: (s) => {
          // M3d: a logo that could not be fetched is tried again once the bridge is back (also after a replay, which sends no snapshot).
          if (s.phase === 'live' && this.conn.phase !== 'live' && this.logos.retryFailed()) this.syncLogos();
          this.conn = s;
          // M7: a dropped connection forgot its board watch; the next live one watches again.
          if (s.phase !== 'live') this.watched = null;
          this.syncBoardWatch();
          // M13: a new connection may have missed boards' saves: read the floor's again.
          if (s.phase === 'live' && this.conn.phase !== 'live') {
            this.wbStates.clear();
            this.refreshWhiteboard();
          }
          // M5: a dropped connection took every watch with it; the next live one watches again.
          this.laptops.setConnected(s.phase === 'live');
          this.screen.setConnected(s.phase === 'live'); // M13: a new connection is told whether this game shares
          this.hud.setConn(s, this.fixture, Date.now());
          this.palette.refresh(); // #147: the floors grey out without a connection
          this.updateNotice();
        },
      },
    });

    // M13 screen share: the top bar control, the TV texture, the frames the bridge asks for.
    this.screen = new ScreenShareController({
      // Not `send`: the share's reports and refusals stay out of the command log the other features' tests read.
      send: async (t, args) => {
        const r = await this.client.request(t, args);
        if (!r.ok && r.code === 'unknown_command') this.unsupported.add(t);
        return r;
      },
      url: this.url,
      toast: (m, kind) => this.hud.toast(m, kind === 'error' ? 9000 : 3600, kind),
      office: () => this.office,
      log: (m) => console.info(m),
      tvInfo: (line) => this.hud.setPropInfo('tv', line),
    });
    this.hud.mountScreenShare(this.screen.control.el);

    this.panels = new Panels(o.host, {
      store: this.store,
      here: () => this.hereSession(),
      inLobby: () => this.mode === 'floor' && this.place.area === 'lobby',
      send: (t, args) => this.send(t, args),
      unsupported: (t) => this.unsupported.has(t),
      travel: (s) => {
        this.panels.close();
        void this.enterFloor(s).then(() => this.afterTravel(s));
      },
      travelLobby: (b) => {
        this.panels.close();
        void this.enterLobby(b);
      },
      toast: (m, kind) => this.hud.toast(m, kind === 'error' ? 6500 : 3600, kind),
      logoUrl: (b, hash) => logoUrl(this.url, b, hash),
      logoFailed: (hash) => this.logos.unavailable(hash),
      setLogo: (b, f) => this.setLogo(b, f),
      clearLogo: (b) => this.clearLogo(b),
    });

    const dialogHost = {
      store: this.store,
      send: <T extends CommandName>(t: T, args: CommandArgs[T]) => this.send(t, args),
      unsupported: (t: CommandName) => this.unsupported.has(t),
      toast: (m: string, kind: 'info' | 'error') => this.hud.toast(m, kind === 'error' ? 6500 : 3600, kind),
      now: () => Date.now(),
    };
    const upload = (f: Blob, hint: { label?: string; n?: number }, signal?: AbortSignal) => postUpload(this.url, f, hint, signal);
    const hireHost = { ...dialogHost, upload, reserve: (s: string, d: number) => this.reserve(s, d), held: (s: string) => this.heldDesks(s) };
    this.hire = new HireDialog(o.host, { ...hireHost, goTo: (id) => this.goToNewHire(id), orchestrate: { off: () => runUnsupported(hireHost), open: (s, d) => this.startRun.open({ session: s, desk: d }, true) } });
    // M6 start
    this.presetsPanel = new PresetsPanel(o.host, dialogHost);
    this.startRun = new StartRunDialog(o.host, {
      ...hireHost,
      hireAt: (s, d) => {
        this.hire.open(s, d);
        this.hire.focusTab();
      },
      openPresets: (from) => this.presetsPanel.open(from),
      started: (id, item) => {
        this.followOrch(id);
        // M7: "Hand to a worker": the card's note peels off the board and is carried to the orchestrator's desk.
        if (item) this.peelNote(item.id, id);
      },
    });
    this.sendHome = new SendHomeDialog(o.host, dialogHost);
    this.boardsPanel = new BoardsPanel(o.host, {
      ...dialogHost,
      session: () => this.hereSession(),
      state: (session) => this.boardState(session),
      refresh: (session) => void this.sendBoard('board.refresh', { session }),
      external: (url) => this.external(url),
      handTo: (session, card, provider) => this.handTo(session, card, provider),
      ask: (session, card) => this.askAbout(session, card),
      review: (session, pr) => this.reviewPr(session, pr),
      whyNoRun: (session) => this.whyNoRun(session),
      whyNoHire: (session) => this.whyNoHire(session),
      goTo: (id) => void this.goToWorker(id),
    });
    this.arrivals = new Arrivals(this.shadows);
    this.walk.scene.add(this.arrivals.group);
    this.seatBar = new SeatBar(this.hud.root, {
      text: (t) => this.laptops.typeText(t),
      paste: (t, files) => this.laptops.paste(t, files),
      stand: () => this.laptops.stand(),
      toggle: () => this.laptops.toggleTranscript(),
      fullscreen: (a) => this.laptops.fullscreen(a),
    }, this.themes.prefs);
    this.laptops = new Laptops(
      {
        store: this.store,
        send: (t, args) => this.send(t, args),
        watch: (t, args) => this.sendWatch(t, args),
        unsupported: (t) => this.unsupported.has(t),
        toast: (m, kind) => this.hud.toast(m, kind === 'error' ? 5200 : 3200, kind),
        upload,
        seat: this.seatBar,
        insets: () => ({ top: parseFloat(this.hud.root.style.getPropertyValue('--topbar-bottom')) || 70, bottom: this.seatBar.el.getBoundingClientRect().height + 18 }),
        layer: this.hud.root,
        themes: this.themes,
        monitors: this.monitorPrefs,
        packup: (id, text, signal) => this.packupCheck(id, text, signal), // #110
        overview: () => this.openOverview(false), // #118
      },
      o.params,
    );
    // M5: the Changes panel sits in the HUD, under the top bar, and leaves the floor in view.
    this.prompt = new PromptOverlay(o.host, { ...dialogHost, upload, packup: (id, text, signal) => this.packupCheck(id, text, signal) });
    this.openPr = new OpenPrDialog(o.host, {
      ...dialogHost,
      providerName: (session) => this.boardBook.get(session).prs?.provider_name ?? this.boardBook.get(session).issues?.provider_name ?? 'the provider',
      external: (url) => this.external(url),
    });
    this.whiteboard = new WhiteboardOverlay(o.host, {
      wsUrl: () => this.url,
      author: () => this.owner,
      send: (t, args) => this.send(t, args),
      toast: (m, kind) => this.hud.toast(m, kind === 'error' ? 6500 : 3600, kind),
      saved: (st) => this.onWhiteboard(st),
      closed: () => {
        this.updateHint();
        this.activity(true);
      },
    });
    this.overview = new OverviewOverlay(
      o.host,
      {
        data: (session) => this.overviewData(session),
        goTo: (id) => void this.goToWorker(id, 'transcript'),
        openTicket: (session, id) => this.boardsPanel.openItem('issues', session, id),
        retrySummary: (id) =>
          void this.send('digest.retry', { id }).then((r) => {
            if (!r.ok) this.hud.toast(digestFailureText(r.code, r.message), 6500, 'error');
          }),
        hire: () => this.openHire(),
        calm: () => this.batterySaver,
        screenRect: (session) => this.overviewScreenRect(session),
        closed: () => {
          this.updateHint();
          this.activity(true);
        },
      },
      new OverviewPrefs(),
    );
    this.changes = new ChangesPanel(this.hud.root, {
      ...dialogHost,
      blur: () => (document.activeElement as HTMLElement | null)?.blur?.(),
      openPr: { available: (id) => this.canOpenPr(id), open: (id) => this.openPrFor(id) },
    });

    this.hud.on('city', () => void this.leaveFloor());
    this.hud.on('hire', () => this.openHire());
    this.hud.on('palette', () => this.togglePalette());
    this.hud.on('buildings', () => this.openBuildings());
    this.hud.on('elevator', () => !this.transitioning && this.openElevator());
    this.hud.on('battery', () => this.toggleBattery());
    this.hud.on('issues', () => this.openBoard('issues'));
    this.hud.on('prs', () => this.openBoard('prs'));
    this.hud.on('overview', () => this.openOverview(false));
    this.m6Buttons = m6StartButtons(this.hud, { run: () => this.openStartRun(), presets: (b) => this.openPresets(b), off: () => runUnsupported(hireHost) });
    this.bindInput();
    // #124: the keys' names as this keyboard labels them (Chromium's layout map), in the titles that name a key.
    loadLayout(() => {
      this.hud.refreshKeyTitles();
      this.m6Buttons.sync();
      this.inbox.set(this.inboxEntries());
    });
    this.resize();
    this.hud.setCity(0, 0, zero());
    this.updateNotice();
    this.updateHint();
  }

  start(): void {
    this.client.start();
    void this.r.setAnimationLoop((t) => this.tick(t));
  }

  /** Stops the frame loop (the benchmark drives frames itself). */
  pause(): void {
    void this.r.setAnimationLoop(null);
  }

  resume(): void {
    this.lastRender = -Infinity;
    // M17: back from a hidden tab: the time moved on.
    this.readTime(false);
    void this.r.setAnimationLoop((t) => this.tick(t));
  }

  // ---- world -> views --------------------------------------------------------

  private applyChange(c: Change): void {
    this.statusDirty = true;
    this.planDirty = true;
    this.activity(false);
    if (c.structure) {
      const firstWorld = this.city.isEmpty;
      this.city.build(this.store.city());
      if (firstWorld) this.frameCity(false);
      if (this.mode === 'floor') this.syncWalk();
      this.syncLogos();
    } else {
      for (const id of c.workers) {
        const v = this.store.workerView(id);
        if (!v) continue;
        this.city.updateWorker(v);
        if (this.office?.session === v.worker.session) this.office.updateWorker(v);
      }
      for (const s of c.sessions) {
        const fv = this.store.floorView(s);
        if (fv) this.city.updateFloor(fv);
      }
    }
    this.refreshTopbar();
    this.updateNotice();
    if (this.mode === 'floor') this.updateHint();
    this.prompt.refresh();
    this.changes.refresh();
    this.panels.refresh();
    this.palette.refresh(); // #147
    this.hire.refresh();
    this.sendHome.refresh();
    this.startRun.refresh();
    this.presetsPanel.refresh();
    this.limitsWidget.update();
    this.inbox.set(this.inboxEntries());
    this.m6Buttons.sync();
    // M7: holders and verdict stamps on the boards follow the workers.
    if (c.structure || c.workers.size) this.pushBoards();
    this.pingInbox(c); // #100
    this.overviewDirty = true; // #118
  }

  // ---- M6c: reports walk over to the orchestrator's desk ---------------------------

  /** Every ready report (to an orchestrator, without a question) in the world as it is. */
  private reportFacts(): ReportFact[] {
    const out: ReportFact[] = [];
    for (const id of this.store.workers.keys()) {
      const v = this.store.workerView(id);
      const f = v && reportFact(v);
      if (f) out.push(f);
    }
    return out;
  }

  /** A snapshot (the first, or a reconnect's): every report is where it is, none plays. */
  private syncDeliveries(): void {
    for (const a of this.arrivals.info(performance.now() / 1000)) if (a.kind === 'deliver') this.arrivals.cancel(a.id);
    this.deliveryCtx.clear();
    this.deliveries.sync(this.reportFacts(), new Set(this.store.workers.keys()));
    this.syncTrays();
  }

  /**
   * A worker upsert was applied: a freelancer's report that just became ready (pending → ready, a new one, or its
   * question answered) starts its walk to the orchestrator, once per report (world/delivery.ts); one already ready,
   * or seen before, plays nothing.
   */
  private noticeReport(was: { report?: import('./net/protocol').WorkerReport } | undefined, id: string): void {
    const v = this.store.workerView(id);
    const f = v && reportFact(v);
    if (!v || !f) return;
    const now = v.worker.report;
    const play = !!was && this.store.snapshots > 0 && (reportArrived(was.report, now) || (!!inputRequired(was.report) && !inputRequired(now)));
    const r = this.deliveries.add(f, play);
    if (r === 'queued') this.pumpDeliveries();
    else if (r === 'tray') this.syncTrays();
  }

  /**
   * Starts the next report in line on each floor that has no freelancer walking (one walk at a time on a floor: two
   * walkers never share the aisles, whatever their routes); then the trays follow.
   */
  private pumpDeliveries(): void {
    // (A walk is under way until its freelancer has sat down again, whatever the book says of its folder.)
    const busy = this.deliveries.activeSessions();
    for (const a of this.arrivals.info(performance.now() / 1000)) if (a.kind === 'deliver') busy.add(a.session);
    for (const orch of this.deliveries.queuedOrchs()) {
      for (;;) {
        const e = this.deliveries.next(orch, busy);
        if (!e) break;
        if (this.startDelivery(e)) {
          busy.add(e.session);
          break;
        }
        // Nobody can see it (another floor, the city, a sleeping floor, no way): it resolves at once.
        this.deliveries.land(e.key);
        this.arrivals.skip({ id: `deliver:${e.key}`, kind: 'deliver', session: e.session, desk: e.desk });
      }
    }
    this.syncTrays();
  }

  /** The destination of reports to this orchestrator, as the office seats it. */
  private destOf(ov: WorkerView): Dest {
    return ov.worker.corner === true && ov.crew?.role === 'orch' ? { corner: ov.desk } : { slot: ov.desk };
  }

  /** Starts a delivery's walk: false when it cannot be shown (the floor is not the one you see, it sleeps, the orchestrator is not on it, no way). */
  private startDelivery(e: Entry): boolean {
    const o = this.office;
    const ctx = this.building;
    const v = this.store.workerView(e.id);
    const ov = this.store.workerView(e.orch);
    const fv = this.store.floorView(e.session);
    if (!o || !ctx || !v || !ov || !fv || this.mode !== 'floor' || o.session !== e.session || ov.worker.session !== e.session || fv.asleep) return false;
    if (v.crew?.life !== 'reporting' || this.arrivals.has(e.id) || o.awayDesks().has(v.desk) || o.awayDesks().has(ov.desk)) return false;
    const storey = ctx.floors.findIndex((f) => f.session === e.session);
    const L = o.layout;
    const slot = L.slots[v.desk];
    const dest = this.destOf(ov);
    const ho = handOver(L, dest);
    if (storey < 0 || !slot || !ho) return false;
    const route = deskToDeskRoute(L, storey, v.desk, dest);
    if (route.length < 3) return false;
    const fy = floorY(storey);
    const m = memberOf(v);
    const n = Math.min(this.deliveries.tray(e.orch).length, TRAY_CAP - 1);
    const pose: TrayPose = { x: ho.seat.x, y: fy + ho.up, z: ho.seat.z, yaw: ho.seatYaw, side: o.kits[ov.desk]?.side ?? ho.side };
    const land = trayFolderAt(pose, n);
    const deliver: DeliverSpec = {
      key: e.key,
      handYaw: ho.yaw,
      // Busy at its screen it turns and takes it; anyone else (waiting for you, asleep, idle, done) lets the freelancer put it on the tray.
      swivels: ov.display === 'working',
      orchDesk: ov.desk,
      turn: ho.swivel,
      hand: { x: ho.seat.x + (ho.x - ho.seat.x) * 0.55, y: fy + ho.up + 0.95, z: ho.seat.z },
      tray: land,
      edge: toneColor(e.tone),
    };
    const spec: ArrivalSpec = {
      id: `deliver:${e.key}`,
      kind: 'deliver',
      session: e.session,
      desk: v.desk,
      name: v.name,
      route,
      seatYaw: slot.yaw,
      tint: m.tint,
      cue: m.cue,
      display: m.display,
      phase: m.phase,
      harness: resolveHarness(v.worker),
      deliver,
    };
    if (m.crew) spec.crew = m.crew;
    if (!this.arrivals.start(spec, performance.now() / 1000)) return false;
    this.deliveryCtx.set(e.key, { layout: L, orchDesk: ov.desk, corner: 'corner' in dest });
    o.setOut(v.desk, { chair: 0 });
    this.activity(true);
    return true;
  }

  /**
   * The world changed under the walks (a desk moved, a floor went to sleep, the office was rebuilt for a new layout, an
   * orchestrator is gone, you are not looking any more): every delivery that no longer fits resolves at once, its folder
   * on the tray and its freelancer seated where the world seats it now. The others go on; the queue follows.
   */
  private reconcileDeliveries(): void {
    const live = new Set<string>();
    for (const a of this.arrivals.info(performance.now() / 1000)) {
      if (a.kind !== 'deliver' || !a.key) continue;
      live.add(a.key);
      if (this.deliveryStale(a)) this.resolveDelivery(a);
    }
    for (const key of [...this.deliveryCtx.keys()]) if (!live.has(key)) this.deliveryCtx.delete(key);
    for (const e of this.deliveries.pending()) {
      // A queued report waits at its freelancer's desk, wherever that is now; an "active" one with no walk is over.
      const v = this.store.workerView(e.id);
      if (v) Object.assign(e, { session: v.worker.session, desk: v.desk });
      if (e.stage === 'active' && !live.has(e.key)) this.deliveries.land(e.key);
    }
    this.pumpDeliveries();
  }

  /** Whether a delivery on its way no longer fits the world: false for one whose freelancer is leaving (that walk is the walk-out's). */
  private deliveryStale(a: ArrivalInfo): boolean {
    const e = this.deliveries.get(a.key as string);
    const c = this.deliveryCtx.get(a.key as string);
    // (Its freelancer's workspace closed: the hand-over finishes and the walk-out follows, whatever the book still has of it.)
    if (c?.leaving || e?.leaving) return false;
    if (!e) return true;
    const v = this.store.workerView(e.id);
    if (!v) return false;
    const ov = this.store.workerView(e.orch);
    const fv = this.store.floorView(a.session);
    const o = this.office;
    if (!ov || !fv || !c || !o || fv.asleep || this.mode !== 'floor' || o.session !== a.session || o.layout !== c.layout) return true;
    return v.worker.session !== a.session || v.desk !== a.desk || ov.worker.session !== a.session || ov.desk !== c.orchDesk || (ov.worker.corner === true && ov.crew?.role === 'orch') !== c.corner;
  }

  /** Ends a delivery where it stands: its folder is on the tray, its desk and the orchestrator's chair are as the world says. */
  private resolveDelivery(a: ArrivalInfo): void {
    const c = a.key ? this.deliveryCtx.get(a.key) : undefined;
    this.arrivals.cancel(a.id);
    if (a.key) {
      this.deliveries.land(a.key);
      this.deliveryCtx.delete(a.key);
    }
    const o = this.office;
    if (o?.session !== a.session) return;
    o.setOut(a.desk, null);
    if (c) o.setSwivel(c.orchDesk, null);
  }

  /** The in-trays and the waiting reports of the floor with an interior, from the book. */
  private syncTrays(): void {
    const o = this.office;
    if (!o) return;
    const waiting: number[] = [];
    for (const e of this.deliveries.pending()) if (e.stage === 'queued' && e.session === o.session) waiting.push(e.desk);
    o.setWaiting(waiting);
    for (let i = 0; i < o.desksCount; i++) {
      const v = o.seat(i);
      if (v?.crew?.role === 'orch') o.setTray(i, this.deliveries.tray(v.worker.id).map((e) => e.tone));
    }
  }

  /** The reports on your floor stop: what is on their way lands on the tray. `keep`: the floor that stays in view. */
  private endDeliveries(keep: string | null): void {
    for (const a of this.arrivals.info(performance.now() / 1000)) {
      if (a.kind !== 'deliver' || a.session === keep) continue;
      this.arrivals.cancel(a.id); // (a freelancer leaving behind it is settled with it: `takeEnded`)
      if (a.key) this.deliveryCtx.delete(a.key);
    }
    for (const e of this.deliveries.pending()) if (e.session !== keep) this.deliveries.land(e.key);
  }

  /**
   * A freelancer's workspace closes: its folder leaves the tray; a delivery on its way lands first (a hand-over under way
   * is finished, any other step ends where it stands) and it walks out from there. False: it was not on a delivery.
   */
  private leaveDelivery(id: string): boolean {
    const now = performance.now() / 1000;
    const d = this.arrivals.info(now).find((a) => a.kind === 'deliver' && a.key?.startsWith(`${id}@`));
    const entry = d ? this.deliveries.get(d.key as string) : undefined;
    this.deliveries.close(id, d?.key ?? undefined);
    this.syncTrays();
    // Queued or not on the way: nothing to finish here; a folder that landed with it stays until the freelancer has left.
    if (!d) return false;
    const ov = entry ? this.store.workerView(entry.orch) : null;
    const corner = ov ? (this.destOf(ov) as { corner?: number }).corner : undefined;
    const standing = d.phase === 'walk' || d.phase === 'hand';
    const from = standing ? { x: d.x, y: d.y - STAND_LIFT, z: d.z, ...(corner !== undefined ? { corner } : {}) } : undefined;
    const spec = this.arrivalSpec('out', id, from);
    if (!spec) return false;
    // At the hand-over spot it finishes handing over; anywhere else the delivery ends here and the walk-out takes over.
    if (d.phase === 'hand' && this.arrivals.chain(d.id, spec)) {
      const c = this.deliveryCtx.get(d.key as string);
      if (c) c.leaving = true;
      return true;
    }
    this.arrivals.cancel(d.id);
    this.arrivals.cancel(id);
    this.beginArrival(spec);
    return true;
  }

  /** Test hook: the in-trays, waiting reports and walks not yet landed. */
  trayStates(): { trays: Array<{ desk: number; worker: string; folders: number; edges: number[] }>; waiting: number[]; pending: number } {
    const o = this.office;
    const trays: Array<{ desk: number; worker: string; folders: number; edges: number[] }> = [];
    if (o) {
      for (let i = 0; i < o.desksCount; i++) {
        const v = o.seat(i);
        if (v?.crew?.role === 'orch') trays.push({ desk: i, worker: v.worker.id, ...o.trayInfo(i) });
      }
    }
    return { trays: trays.map(({ desk, worker, folders, edges }) => ({ desk, worker, folders, edges })), waiting: this.deliveries.pending().filter((e) => e.stage === 'queued').map((e) => e.desk), pending: this.deliveries.pending().length };
  }

  // ---- M4: hire, send home, dropping in and walking out ----------------------------

  /**
   * A world event, with what M4 plays for it: a fresh hire's first upsert
   * drops it in to its chair (M6b), a `sent_home` removal walks it out
   * (captured before the store forgets the worker). Workers you cannot see
   * resolve at once.
   */
  private onWorldEvent(e: WorldEvent): void {
    let after: (() => void) | null = null;
    // M6: a freelancer that shows up after the snapshot drops in too, and one that goes (whatever the reason) walks out.
    const freelancer = (w: Parameters<typeof crewRole>[0] | undefined) => !!w && isFreelancer(crewRole(w));
    if (e.t === 'worker.upsert' && !this.store.workers.has(e.worker.id) && (isFreshHire(e.worker.hired_at, Date.now()) || (this.store.snapshots > 0 && freelancer(e.worker)))) {
      const id = e.worker.id;
      after = () => this.startArrival('in', id);
    } else if (e.t === 'worker.removed' && this.store.workers.has(e.id) && (e.reason === 'sent_home' || freelancer(this.store.workers.get(e.id)))) {
      // M6c: its folder leaves the tray with it; one on its way lands, and a walk in progress goes on as the walk-out.
      if (!this.leaveDelivery(e.id)) {
        const spec = this.arrivalSpec('out', e.id);
        const v = this.store.workerView(e.id);
        this.arrivals.cancel(e.id);
        if (spec) this.beginArrival(spec);
        else {
          if (v) this.arrivals.skip({ id: e.id, kind: 'out', session: v.worker.session, desk: v.desk });
          this.deliveries.settle(e.id);
        }
      }
    } else if (e.t === 'worker.removed' || e.t === 'floor.removed') {
      // Gone some other way: a drop-in stops where it is.
      if (e.t === 'worker.removed') this.arrivals.cancel(e.id);
    } else if (e.t === 'worker.upsert' && this.arrivals.has(e.worker.id)) {
      const old = this.store.workers.get(e.worker.id);
      if (old && (old.session !== e.worker.session || old.desk_index !== e.worker.desk_index)) this.arrivals.cancel(e.worker.id);
    }
    this.wrapUpToasts(e); // #83
    const was = e.t === 'worker.upsert' ? this.store.workers.get(e.worker.id) : undefined;
    this.applyChange(this.store.applyEvent(e));
    if (e.t === 'worker.removed') {
      // M6c: an orchestrator that is gone takes its tray with it; a worker that is gone is forgotten.
      this.deliveries.dropOrch(e.id);
      this.deliveries.forget(e.id);
      this.syncTrays();
    }
    if (e.t === 'worker.upsert' || e.t === 'worker.removed' || e.t === 'floor.upsert') this.reconcileDeliveries(); // M6c
    if (e.t === 'worker.upsert') this.yieldTakenDesks([e.worker.id]);
    if (e.t === 'worker.upsert') this.noticeReport(was, e.worker.id); // M6c
    if (e.t === 'whiteboard.updated') this.onWhiteboard(e); // M13
    after?.();
  }

  /**
   * #83: what a wrap-up did by itself, said before the store forgets what it was: the worker went home after its
   * CLEAN (`sent_home` while armed), or the wrap-up stopped and needs you.
   */
  private wrapUpToasts(e: WorldEvent): void {
    const id = e.t === 'worker.removed' ? e.id : e.t === 'worker.upsert' ? e.worker.id : null;
    const old = id ? this.store.workers.get(id) : undefined;
    const was = old ? wrapUpOf(old) : null;
    if (!old || was?.state !== 'armed') return;
    const name = displayName(old);
    if (e.t === 'worker.removed' && e.reason === 'sent_home') this.hud.toast(sentHomeText(name, was, !!old.worktree?.linked), 4800, 'info');
    else if (e.t === 'worker.upsert') {
      const now = wrapUpOf(e.worker);
      if (now?.state === 'needs_you') this.hud.toast(needsYouText(name, now), 6500, 'error');
    }
  }

  // ---- #100: the inbox's pings -------------------------------------------------

  /** What pings for a new inbox entry (world/inboxPings.ts); the worker you sit at never does. */
  private readonly pings = new InboxPings({ emit: (p) => this.onPing(p), focus: () => this.laptops.seated, gates: () => this.inboxPrefs.settings });
  private readonly notify = new DesktopNotify();
  /** The store's snapshot count the pings last saw: one more is a snapshot (the first or a reconnect's). */
  private pingSnapshots = 0;

  private pingInbox(c: Change): void {
    const snapshot = this.store.snapshots !== this.pingSnapshots;
    this.pingSnapshots = this.store.snapshots;
    if (!snapshot && !c.structure && !c.workers.size && !c.sessions.size) return;
    const entries = pingEntries(this.needCandidates(), this.store.inboxDismissed);
    this.pings.update(entries, snapshot);
  }

  /**
   * A ping: the chime (once per burst), and a desktop notification with the game in the background (its click goes to
   * the worker, a collapsed burst's opens the inbox's list), or the chip's pulse and a soft toast with it in front. A
   * snapshot's new entries are one soft toast (the documented exception to "toasts only on a live change").
   */
  private onPing(p: PingOut): void {
    const s = this.inboxPrefs.settings;
    if (p.t === 'away') return this.hud.toast(awayText(p.needs, p.finished), 5200, 'info', true);
    if (p.t === 'ping' && p.chime && s.chime) this.audio.playUi(p.kind, s.chimeVolume);
    let text: { title: string; body: string };
    let shown: ReturnType<DesktopNotify['show']>;
    if (p.t === 'burst') {
      text = burstText(p.entries, p.needs);
      this.notify.close(p.entries.map((e) => e.id));
      shown = this.notify.show({ ...text, tag: BURST_TAG, onClick: () => void this.openInboxList() }, s.desktop);
    } else {
      const id = p.entry.id;
      text = this.pingText(p.entry);
      shown = this.notify.show({ ...text, tag: id, onClick: () => void this.goToWorker(id) }, s.desktop);
    }
    if (shown !== 'focused') return;
    this.inbox.pulse();
    this.hud.toast(`${text.title} · ${text.body}`, 4200, 'info', true);
  }

  /**
   * A ping's words: "Chirp needs you", `Building › Floor · reason`, in the list's own terms (world/inbox.ts's
   * `inboxWhere` / `inboxReason`).
   */
  private pingText(e: PingEntry): { title: string; body: string } {
    const where = inboxWhere(this.store, e.session);
    const v = this.store.workerView(e.id);
    const why = e.reason === 'done' || !v ? null : inboxReason(v).toLowerCase();
    return { title: pingTitle(e.reason === 'blocked' ? 'needs' : 'finished', e.name), body: why ? `${where} · ${why}` : where };
  }

  /** Workers whose done is still settling before it pings (test hook). */
  pendingPings(): string[] {
    return this.pings.pending();
  }

  /**
   * M6b: the world seats these workers where they are (a new hire, or one
   * moved to a desk another worker sent home is still leaving: the bridge
   * frees a desk as its worker goes). A walk-out still on such a desk gives
   * it up for good (`Arrivals.yieldDesk`), and the desk is the new worker's
   * at once: look-at, its card, its laptop.
   */
  private yieldTakenDesks(ids: Iterable<string>): void {
    if (!this.arrivals.count) return;
    const now = performance.now() / 1000;
    for (const id of ids) {
      const v = this.store.workerView(id);
      if (!v || !this.arrivals.yieldDesk(v.worker.session, v.desk, id, now)) continue;
      if (this.office?.session === v.worker.session) this.office.setAway(v.desk, null);
    }
  }

  /**
   * What a walk needs: the worker's look, desk and route in the building you
   * are in (null: not visible from here). M6b: a hire drops in to its chair,
   * which only the floor with an interior shows; the walk-out goes down the
   * fire escape, which the whole building sees.
   */
  private arrivalSpec(kind: ArrivalKind, id: string, from?: Waypoint & { corner?: number }): ArrivalSpec | null {
    const v = this.store.workerView(id);
    const ctx = this.building;
    if (!v || this.mode !== 'floor' || !ctx) return null;
    const session = v.worker.session;
    const storey = ctx.floors.findIndex((f) => f.session === session);
    if (storey < 0) return null;
    if (kind === 'in' && this.office?.session !== session) return null;
    const L = this.office?.session === session ? this.office.layout : this.layoutOf(session);
    const slot = L?.slots[v.desk];
    if (!L || !slot) return null;
    const route = kind === 'out' ? walkOutRoute(L, ctx.plan, storey, v.desk, from) : [{ x: slot.seat.x, y: floorY(storey), z: slot.seat.z }];
    const m = memberOf(v);
    const spec: ArrivalSpec = {
      id,
      kind,
      session,
      desk: v.desk,
      name: v.name,
      route,
      seatYaw: slot.yaw,
      tint: m.tint,
      cue: m.cue,
      display: m.display,
      phase: m.phase,
      harness: resolveHarness(v.worker),
    };
    // M6: a freelancer's briefcase and look.
    if (v.crew?.freelancer) spec.carry = 'briefcase';
    if (m.crew) spec.crew = m.crew;
    // M6c: leaving from where it stands (mid-delivery), not from its desk.
    if (from) spec.standing = true;
    return spec;
  }

  private startArrival(kind: ArrivalKind, id: string): void {
    const spec = this.arrivalSpec(kind, id);
    if (spec) this.beginArrival(spec);
    else {
      const v = this.store.workerView(id);
      if (v) this.arrivals.skip({ id, kind, session: v.worker.session, desk: v.desk });
    }
  }

  private beginArrival(spec: ArrivalSpec): void {
    if (!this.arrivals.start(spec, performance.now() / 1000)) return;
    // The desk changes at once (no "+" flash before the next frame); a hire is at its desk already (M6b), only its figure drops in.
    if (this.office?.session === spec.session && spec.kind === 'out' && !spec.standing) this.office.setAway(spec.desk, { show: 'busy', display: spec.display, cue: spec.cue.color, harness: spec.harness, packed: 0 });
    this.activity(true);
  }

  /** A hire is on its way to `desk`; the returned function ends this hire's hold (its ack came). */
  private reserve(session: string, desk: number): () => void {
    const release = this.reserved.add(session, desk);
    this.applyReserve();
    return () => {
      // Another hire still holding the desk, or a walk on it, keeps it as it is.
      if (!release() || this.office?.session !== session) return;
      const walking = this.arrivals.info(performance.now() / 1000).some((a) => a.session === session && a.desk === desk);
      if (!walking) this.office.setAway(desk, null);
    };
  }

  private applyReserve(): void {
    const o = this.office;
    if (!o) return;
    for (const r of this.reserved.all()) if (o.session === r.session && !o.seat(r.desk)) o.setAway(r.desk, { show: 'empty', display: 'idle', cue: 0xffffff });
  }

  /** Desks of a floor that are not free for another hire: a hire or a walk is on its way there. */
  heldDesks(session: string): Set<number> {
    const out = this.reserved.desks(session);
    for (const a of this.arrivals.info(performance.now() / 1000)) if (a.session === session) out.add(a.desk);
    return out;
  }

  /** The hire dialog for a desk of the floor you are on; no desk: the first free one (the top bar's Hire). */
  openHire(desk?: number, prefill?: HirePrefill): void {
    const s = this.hereSession();
    const fv = s ? this.store.floorView(s) : null;
    if (!s || !fv) {
      this.hud.toast('Walk onto an office floor to hire someone there.', 2400);
      return;
    }
    if (fv.asleep || fv.transition) {
      this.hud.toast(`${s} is ${fv.transition === 'waking' ? 'waking up' : fv.transition === 'sleeping' ? 'going to sleep' : 'asleep'}. Wake it from the elevator (L) to hire.`, 3200);
      return;
    }
    const held = this.heldDesks(s);
    const d = desk ?? firstFreeDesk(fv, held);
    if (d === null) {
      this.hud.toast(`No free desk on ${s} right now.`, 2400);
      return;
    }
    if (held.has(d) && !fv.seats[d]) {
      this.hud.toast(`Someone is already on the way to Desk ${d + 1}.`, 2000);
      return;
    }
    const seat = fv.seats[d];
    if (seat) {
      this.hud.toast(`${seat.name} sits at Desk ${d + 1}.`, 2000);
      return;
    }
    this.walker.release();
    this.walker.stop();
    this.panels.close();
    this.hire.open(s, d, prefill);
  }

  /** The send-home dialog for a worker. */
  openSendHome(id: string): void {
    if (!this.store.workerView(id)) return;
    this.walker.release();
    this.walker.stop();
    this.panels.close();
    this.sendHome.open(id);
  }

  /** M4 dialogs are open (keys go to them). */
  get dialogOpen(): boolean {
    return this.hire.isOpen || this.sendHome.isOpen || this.prompt.isOpen || this.startRun.isOpen || this.presetsPanel.isOpen || this.boardsPanel.isOpen || this.openPr.isOpen || this.whiteboard.isOpen || this.overview.isOpen;
  }

  /** The desks of the floor with an interior as shown: who sits there, whether its "+" is up, what the walk animation holds (test hook). */
  deskStates(): Array<{ desk: number; worker: string | null; plus: boolean; away: 'busy' | 'empty' | null }> {
    const o = this.office;
    if (!o) return [];
    const away = o.awayDesks();
    return Array.from({ length: o.desksCount }, (_, i) => {
      const w = o.seat(i);
      const a = away.get(i) ?? null;
      return { desk: i, worker: w?.worker.id ?? null, plus: !w && !a, away: a };
    });
  }

  // ---- commands and panels ------------------------------------------------------

  /** Sends a command; remembers commands an older bridge does not know. */
  /** M13: the screen share and this floor's TV (test hook). */
  screenInfo() {
    const v = this.screen.share.view;
    return {
      phase: v.phase,
      surface: v.surface ?? null,
      paused: v.paused,
      w: v.w,
      h: v.h,
      tv: this.office?.screenInfo() ?? null,
      texture: this.screen.texture.current ? { w: this.screen.texture.current.w, h: this.screen.texture.current.h } : null,
      answered: [...this.screen.responder.answered],
      grabbed: [...this.screen.grabbed],
      reported: [...this.screen.reports],
    };
  }

  async send<T extends CommandName>(t: T, args: CommandArgs[T]): Promise<CommandResult> {
    // The log (and window.__h3d.sent()) never holds a typed API key; the command goes out as it is.
    const entry: (typeof this.sent)[number] = { t, args: loggedArgs(t, args) };
    this.sent.push(entry);
    const r = await this.client.request(t, args);
    entry.result = r;
    if (!r.ok && r.code === 'unknown_command') this.unsupported.add(t);
    if (!r.ok && r.code === 'unknown_command') this.m6Buttons.sync();
    return r;
  }

  /**
   * #110 pack up on request: the check before a prompt from the laptop's composer or the P overlay goes out. Only
   * while the feature is ready and for a worker it applies to; any failure or a late answer sends it as written.
   * A match opens the confirm (the send home's pack-up mode), nothing left of the prompt the plain send home.
   */
  private packupCheck(id: string, text: string, signal: AbortSignal): Promise<PackupOutcome> | null {
    if (this.store.packup.state?.state !== 'ready' || this.unsupported.has('packup.detect') || !packupApplies(this.store.workers.get(id))) return null;
    return this.packupRun(id, text, signal);
  }

  private async packupRun(id: string, text: string, signal: AbortSignal): Promise<PackupOutcome> {
    const r = await this.send('packup.detect', { id, text });
    if (signal.aborted) return 'cancel';
    const v = r.ok ? packupVerdict(r.data, text) : ({ kind: 'send' } as const);
    if (v.kind === 'send') return 'send';
    if (v.kind === 'home') {
      this.sendHome.open(id, { fromPackup: true });
      return 'cancel';
    }
    const c = await this.sendHome.openPackup(id, { original: text, task: v.task, removed: v.removed });
    if (c === 'done') return 'done';
    return c === 'stay' && !signal.aborted ? 'send' : 'cancel';
  }

  // ---- M6 start: starting a run, team presets ------------------------------------------

  /**
   * The start-run dialog for a floor (default: the one you are on) and a desk
   * (default: its first free one). M7's "Hand to a worker" calls it with an issue.
   */
  openStartRun(o: Partial<StartRunOptions> = {}): void {
    const s = o.session ?? this.hereSession();
    const fv = s ? this.store.floorView(s) : null;
    if (!s || !fv) {
      this.hud.toast('Walk onto an office floor to start a run there.', 2400);
      return;
    }
    if (fv.asleep || fv.transition) {
      this.hud.toast(`${s} is ${fv.transition === 'waking' ? 'waking up' : fv.transition === 'sleeping' ? 'going to sleep' : 'asleep'}. Wake it from the elevator (L) to start a run.`, 3200);
      return;
    }
    const held = this.heldDesks(s);
    const d = o.desk ?? firstFreeDesk(fv, held);
    if (d === null) {
      this.hud.toast(`No free desk on ${s} right now.`, 2400);
      return;
    }
    const seat = fv.seats[d];
    if (seat || held.has(d)) {
      this.hud.toast(seat ? `${seat.name} sits at Desk ${d + 1}.` : `Someone is already on the way to Desk ${d + 1}.`, 2000);
      return;
    }
    this.walker.release();
    this.walker.stop();
    this.panels.close();
    const opts: StartRunOptions & { desk: number } = { session: s, desk: d };
    if (o.issue !== undefined) opts.issue = o.issue;
    // M7: "Hand to a worker" starts on a card of the board.
    if (o.workItem) opts.workItem = o.workItem;
    this.startRun.open(opts);
  }

  /** The team presets panel (from the top bar, or over the start-run dialog). */
  openPresets(from: HTMLElement | null = null): void {
    this.walker.release();
    this.walker.stop();
    this.panels.close();
    this.presetsPanel.open(from);
  }

  /**
   * #116: after a hire is acknowledged (the hire dialog was still its own), sits you at the new worker's laptop with its
   * conversation on screen, if Settings → Display says so. The ack can come before the worker is in the store and
   * `sitAt` fails while the hire is still dropping into its chair ("not at the desk right now"), so it waits, for at most
   * `HIRE_GOTO_WAIT_MS`, for the worker and the end of its arrival; on timeout the toast stands alone. It never yanks: the
   * moment you act (a key, a press, the wheel, a dialog taking `open`, or a pose that is no longer the one you had: moved,
   * turned, sat) it is gone for good, whatever the state is by the next look; and a modal dialog (Settings, About: not in
   * `dialogOpen`, but `dismissOverlays` would close them), a panel, a seat taken, a transition or a floor left drops it too.
   */
  private goToNewHire(id: string): void {
    this.stopHireGoto?.(); // (a newer hire's go-to takes over)
    if (!this.hirePrefs.goToNew) return;
    const gen = ++this.hireGotoGen;
    let acted = false;
    const w = this.walker;
    const pose = [w.x, w.z, w.yaw, w.sitting];
    const stopActs = onPlayerAct(() => (acted = true));
    const cancel = waitForHire({
      acted: () => acted || w.x !== pose[0] || w.z !== pose[1] || w.yaw !== pose[2] || w.sitting !== pose[3],
      check: () => {
        const v = this.store.workerView(id);
        const here = this.mode === 'floor' && this.place.area === 'floor' && (!v || this.office?.session === v.worker.session);
        const busy = this.dialogOpen || this.panels.open || this.hud.sheetOpen || !!document.querySelector('dialog:modal') || this.transitioning || !!this.laptops.seated;
        if (!this.hirePrefs.goToNew || !here || busy) return 'drop';
        return v && !this.arrivals.has(id) && !this.office?.awayDesks().has(v.desk) ? 'go' : 'wait';
      },
      go: () => void this.goToWorker(id, 'transcript'), // (false, or facing only: the toast already says they are coming)
      end: () => {
        stopActs();
        if (this.hireGotoGen === gen) this.stopHireGoto = null;
      },
    });
    this.stopHireGoto = cancel;
  }

  /** A run started: you turn to its orchestrator's desk on the floor you are on, and watch it drop in. */
  private followOrch(id: string): void {
    const v = this.store.workerView(id);
    if (!v || this.mode !== 'floor' || this.office?.session !== v.worker.session) return;
    this.faceWorker(id);
  }

  /** The elevator panel of a building (null: the unassigned lot); walking around, of the building you are in. */
  openElevator(building?: string | null): void {
    const b = building !== undefined ? building : this.mode === 'floor' && this.building ? this.building.id : null;
    this.walker.release();
    this.walker.stop();
    this.panels.openElevator(b);
  }

  openBuildings(): void {
    this.walker.release();
    this.walker.stop();
    this.panels.openBuildings();
  }

  private refreshTopbar(): void {
    if (this.mode === 'floor') {
      // On a floor, or its landing: that floor. In the lobby, on the street or the stairs: the building.
      const ctx = this.building;
      const p = this.place;
      const s = p.storey !== null ? ctx?.floors[p.storey]?.session : undefined;
      const fv = s ? this.store.floorView(s) : null;
      if (fv) this.hud.setFloor(fv, p.area === 'fire-escape' ? 'fire-escape' : 'floor');
      else if (ctx) {
        const total = zero();
        for (const f of ctx.floors) {
          const v = this.store.floorView(f.session);
          if (!v || v.asleep) continue;
          total.working += v.counts.working;
          total.needsYou += v.counts.needsYou;
          total.idle += v.counts.idle;
          total.waiting += v.counts.waiting; // #98
          total.total += v.counts.total;
        }
        this.hud.setBuilding(ctx.name, p.area, ctx.floors.length, total);
      }
      return;
    }
    const city = this.store.city();
    const total = zero();
    let floors = 0;
    for (const b of city)
      for (const f of b.floors) {
        floors++;
        if (f.asleep) continue;
        total.working += f.counts.working;
        total.needsYou += f.counts.needsYou;
        total.idle += f.counts.idle;
        total.waiting += f.counts.waiting; // #98
        total.total += f.counts.total;
      }
    this.hud.setCity(city.filter((b) => b.building).length, floors, total);
  }

  private updateNotice(): void {
    if (this.store.snapshots > 0) {
      if (this.city.isEmpty && this.mode === 'city') this.hud.setNotice('No floors yet', 'herdr-world is connected but sees no herdr sessions. Start one with <code>herdr</code> and it shows up here.');
      else this.hud.setNotice(null);
      return;
    }
    const s = this.conn;
    const where = `<code>${escapeHtml(this.url.replace(/token=[^&]+/, 'token=…'))}</code>`;
    if (s.phase === 'failed') this.hud.setNotice('The bridge refused this game', `${escapeHtml(s.reason)}. Update the game or the bridge so their protocol versions match.`);
    else if (s.phase === 'waiting') this.hud.setNotice('Waiting for herdr-world', `No answer from ${where}. Retrying with backoff; check that the helper tunnel is up.`);
    else this.hud.setNotice('Connecting to herdr-world', `Opening ${where}…`);
  }

  // ---- modes -------------------------------------------------------------------

  async enterFloor(session: string, opts: { transition?: boolean; pose?: Pose } = {}): Promise<void> {
    const fv = this.store.floorView(session);
    if (!fv || this.transitioning) return;
    const swap = () => {
      // Read the floor again: events keep arriving while the doors close, and
      // until the office exists nothing else applies them to it.
      const now = this.store.floorView(session);
      const ctx = now ? this.buildingFor(session) : null;
      if (!now || !ctx) {
        this.hud.toast(`${session} is gone.`);
        return;
      }
      this.walker.stop();
      this.setBuilding(ctx);
      const storey = ctx.floors.findIndex((f) => f.session === session);
      this.loadFloor(storey, now);
      this.enterWalk();
      const L = (this.office as OfficeView).layout;
      const p = opts.pose ?? { x: L.spawn.x, z: L.spawn.z, yaw: L.spawn.yaw, pitch: -0.05 };
      this.walker.place(p.x, p.z, p.yaw, p.pitch ?? 0, p.y ?? floorY(storey));
      this.afterPlace();
    };
    await this.ride(fv.level ? `${fv.level.number}` : fv.session, swap, opts.transition);
  }

  /** The elevator to a building's lobby (null: the unassigned lot's). */
  async enterLobby(building: string | null, opts: { transition?: boolean } = {}): Promise<void> {
    if (this.transitioning || !this.buildingById(building)) return;
    const swap = () => {
      const ctx = this.buildingById(building);
      if (!ctx) {
        this.hud.toast('That building is gone.');
        return;
      }
      this.walker.stop();
      this.setBuilding(ctx);
      this.unloadFloor();
      this.enterWalk();
      const s = ctx.plan.lobby.spawn;
      this.walker.place(s.x, s.z, s.yaw, -0.05, 0);
      this.afterPlace();
      this.receptionEvent('arrive-elevator');
    };
    await this.ride('L', swap, opts.transition);
  }

  /** Elevator doors close, `swap` runs, doors open (or at once, for tests and reduced motion). */
  private async ride(label: string, swap: () => void, transition = true): Promise<void> {
    this.transitioning = true;
    try {
      if (transition === false || reducedMotionTest()) swap();
      else await this.hud.doorsTransition(label, swap);
    } finally {
      this.transitioning = false;
      this.activity(true);
    }
  }

  private enterWalk(): void {
    this.mode = 'floor';
    this.hud.setMode('floor');
    this.city.setVisible(false);
    this.planCam.userData.fit = false;
    this.setPlan(false);
  }

  /** After a teleport (arrival, setPose): where you are, and everything that shows it. */
  private afterPlace(): void {
    this.place = { area: 'floor', storey: null };
    this.updatePlace(false, true);
    this.walker.applyTo(this.fpCam, this.walk.base);
    this.refreshTopbar();
    this.statusDirty = true;
    this.cameraMoved = true;
    this.updateHint();
  }

  async leaveFloor(): Promise<void> {
    if (this.mode !== 'floor' || this.transitioning) return;
    const session = this.office?.session ?? this.building?.floors[0]?.session ?? null;
    const swap = () => {
      this.walker.release();
      this.walker.stop();
      this.unloadFloor();
      this.dropOutside();
      this.arrivals.clear();
      this.endDeliveries(null); // M6c
      this.building = null;
      this.mode = 'city';
      this.setPlan(false);
      this.hud.setMode('city');
      this.city.setVisible(true);
      this.refreshTopbar();
      const b = session ? this.city.buildingOf(session) : null;
      if (b !== null) this.focusBuilding(b, false);
      this.statusDirty = true;
      this.cameraMoved = true;
      this.updateHint();
      this.updateNotice();
    };
    await this.ride('CITY', swap);
  }

  // ---- the building around you -------------------------------------------------------

  /** The building a floor is in (the unassigned lot's floors make one too). */
  private buildingFor(session: string): BuildingCtx | null {
    return this.store.floors.has(session) ? this.buildingById(this.panels.buildingOf(session)) : null;
  }

  private buildingById(id: string | null): BuildingCtx | null {
    const store = this.store;
    if (id !== null && !store.buildings.has(id)) return null;
    const floors = id === null ? store.stack(null) : store.stack(id).reverse();
    if (!floors.length) return null;
    // The city view's colour for it, so the facade matches the dollhouse.
    const bi = store.city().findIndex((b) => (b.building?.id ?? null) === id);
    const tint = id === null ? LOT_TINT : (BUILDING_TINTS[Math.max(0, bi) % BUILDING_TINTS.length] ?? 0xffb8b0);
    const outline = outlineOf(floors.map((f) => f.desks));
    const openings = openingsFor(outline.width, outline.depth);
    const door = openings.find((o) => o.kind === 'door') as Opening;
    const plan = buildingPlan(outline, floors.length, { z0: door.u0, z1: door.u1, height: door.y1 });
    const name = id === null ? 'Unassigned lot' : (store.buildings.get(id)?.name ?? 'Building');
    return { id, name, tint, floors, outline, openings, plan, shape: JSON.stringify([id, name, tint, outline, floors.map((f) => f.session)]) };
  }

  /** Switches to a building (or a new shape of it): rebuilds the outside only when its shape changed. */
  private setBuilding(ctx: BuildingCtx): void {
    const prev = this.building;
    // Walks belong to their building: in another one they are over.
    if (prev && prev.id !== ctx.id) {
      this.arrivals.clear();
      this.endDeliveries(null); // M6c
    }
    this.building = ctx;
    let o = this.walk.outside;
    if (!o || !prev || prev.shape !== ctx.shape) {
      this.dropOutside();
      o = new OutsideView(ctx.plan, ctx.openings, { name: ctx.name, tint: ctx.tint, floors: ctx.floors.map((f) => ({ session: f.session, asleep: f.asleep })) });
      o.lobby.setReceptionist(this.reception.object);
      this.walk.setOutside(o);
      o.setLoaded(this.loaded);
      this.walk.setOffice(this.office, this.loaded === null ? 0 : floorY(this.loaded));
    }
    o.setFloors(ctx.floors.map((f) => f.asleep));
    this.showLobbyLogo();
    this.worldCache = null;
  }

  // ---- M3d: building logos ------------------------------------------------------------

  /**
   * Follows the buildings' logo hashes: fetches the ones not held yet (once
   * each), puts the loaded ones on the city's signs and the current
   * building's lobby (a texture swap in the lobby; in the city only the signs
   * are rebuilt, not the buildings), and lets the cache drop the textures
   * nobody uses. A logo that cannot be fetched leaves the name.
   */
  private syncLogos(): void {
    const want = new Map<string, string>();
    for (const b of this.store.buildings.values()) {
      const hash = logoHashOf(b);
      if (hash) want.set(b.id, hash);
    }
    this.logoSync.update(want);
    const sig = [...this.logoSync.shown].map(([id, e]) => `${id}:${e.hash}`).join(',');
    if (sig !== this.logoSig) {
      this.logoSig = sig;
      this.city.setLogos(this.logoSync.shown);
    }
    this.showLobbyLogo();
    this.logoSync.prune(want);
  }

  private showLobbyLogo(): void {
    const o = this.walk.outside;
    if (o && this.building) o.lobby.setLogo(this.building.id === null ? null : (this.logoSync.shown.get(this.building.id) ?? null));
  }

  /** Test hook: what shows the logos now. */
  logoInfo(): { fetches: number; cached: number; city: ReturnType<CityView['signInfo']>; lobby: { canopy: { showing: string; hash: string | null }; wall: { showing: string; hash: string | null } } | null } {
    const l = this.walk.outside?.lobby.signs;
    return {
      fetches: this.logos.fetches,
      cached: this.logos.size,
      city: this.city.signInfo(),
      lobby: l ? { canopy: { showing: l.canopy.showing, hash: l.canopy.hash }, wall: { showing: l.wall.showing, hash: l.wall.hash } } : null,
    };
  }

  /** The Buildings panel's file input: sends a logo for a building. */
  setLogo(building: string, file: File): Promise<CommandResult> {
    return putLogo(this.url, building, file);
  }

  clearLogo(building: string): Promise<CommandResult> {
    return deleteLogo(this.url, building);
  }

  private dropOutside(): void {
    const o = this.walk.outside;
    if (!o) return;
    // The receptionist is not ours to dispose.
    o.lobby.slot.clear();
    this.walk.setOutside(null);
    o.dispose();
  }

  /** Gives floor `storey` of the current building its interior (the one you are on or about to enter). */
  private loadFloor(storey: number, view?: FloorView): void {
    const ctx = this.building;
    const f = ctx?.floors[storey];
    const fv = view ?? (f ? this.store.floorView(f.session) : null);
    if (!ctx || !fv) return;
    const old = this.office;
    this.endDeliveries(fv.session); // M6c: the reports on the floor you leave resolve at once
    this.office = new OfficeView(fv, { shadows: this.shadows, outline: ctx.outline, owner: this.owner });
    this.loaded = storey;
    this.mezzDoor = 0;
    this.fireDoor = 0;
    this.walk.setOffice(this.office, floorY(storey));
    this.walk.outside?.setLoaded(storey);
    old?.dispose();
    this.screen.paint(); // M13: the share on this floor's TV
    this.office.setPlan(this.planOpen);
    this.worldCache = null;
    this.planCam.userData.fit = false;
    this.statusDirty = true;
    this.cameraMoved = true;
    this.syncBoardWatch();
    this.pushBoards();
    this.syncWhiteboard(); // M13
    this.syncTrays(); // M6c
  }

  private unloadFloor(): void {
    if (!this.office) return;
    this.endDeliveries(null); // M6c
    this.office.dispose();
    this.office = null;
    this.loaded = null;
    this.syncBoardWatch();
    this.walk.setOffice(null, 0);
    this.walk.outside?.setLoaded(null);
    this.worldCache = null;
    this.statusDirty = true;
  }

  /** The world changed while walking: follow the building (floors moved, added, resized, asleep). */
  private syncWalk(): void {
    const session = this.office?.session ?? null;
    const ctx = session ? this.buildingFor(session) : this.building ? this.buildingById(this.building.id) : null;
    const fv = session ? this.store.floorView(session) : null;
    if (!ctx || (session && !fv)) {
      this.hud.toast(`${session ?? this.building?.name ?? 'That building'} is gone.`);
      void this.leaveFloor();
      return;
    }
    const was = this.loaded;
    this.setBuilding(ctx);
    if (this.office && fv) {
      const storey = ctx.floors.findIndex((f) => f.session === fv.session);
      if (storey !== was && was !== null) {
        // The floor moved in its building: inside it, you move with it.
        if (this.place.area === 'floor') this.walker.place(this.walker.x, this.walker.z, this.walker.yaw, this.walker.pitch, floorY(storey));
        this.loaded = storey;
        this.walk.setOffice(this.office, floorY(storey));
        this.walk.outside?.setLoaded(storey);
      }
      if (!this.office.apply(fv, ctx.outline)) this.rebuildOffice();
    }
    // Something solid appeared under you (a hire's chair, a rebuilt layout): step out to the nearest free spot, keeping your floor.
    // Only when there is none nearby (the fire escape changed shape, the room shrank): back to safety.
    const world = this.walkWorldNow();
    if (blocked3(this.walker, RADIUS, world)) {
      // Out the back of the chair you stand in (into the aisle), if you stand in one.
      const seat = this.office?.layout.slots.find((sl) => blocked(this.walker, 0, [seatRect(sl)]));
      const free = nudgeClear(this.walker, RADIUS, world, seat && { x: -Math.sin(seat.yaw), z: -Math.cos(seat.yaw) });
      const L = this.office?.layout;
      if (free) this.walker.place(free.x, free.z, this.walker.yaw, this.walker.pitch, free.y);
      else if (L && this.loaded !== null) this.walker.place(L.spawn.x, L.spawn.z, L.spawn.yaw, 0, floorY(this.loaded));
      else this.walker.place(ctx.plan.lobby.spawn.x, ctx.plan.lobby.spawn.z, 0, 0, 0);
    }
    // #187: the world moved you (the floor's storey, a nudge out of a new chair), not your feet: a seat stays.
    this.laptops.rebase(this.walker);
    this.updatePlace(false, true);
    this.cameraMoved = true;
  }

  private rebuildOffice(): void {
    const ctx = this.building;
    if (!this.office || this.loaded === null || !ctx) return;
    const fv = this.store.floorView(this.office.session);
    if (!fv) return;
    const old = this.office;
    this.rebuilds++;
    this.office = new OfficeView(fv, { shadows: this.shadows, outline: ctx.outline, owner: this.owner });
    this.walk.setOffice(this.office, floorY(this.loaded));
    old.dispose();
    this.screen.paint(); // M13
    this.office.setDoor(this.fireDoor);
    this.office.setMezzDoor(this.mezzDoor);
    this.office.setPlan(this.planOpen);
    this.worldCache = null;
    this.planCam.userData.fit = false;
    this.cameraMoved = true;
    this.pushBoards();
    this.syncWhiteboard(); // M13
    this.reconcileDeliveries(); // M6c: the walks were built for the old layout
    this.syncTrays(); // M6c
  }

  /** What the walker touches now (rebuilt when the floor with an interior or its seats change). */
  private walkWorldNow(): WalkWorld {
    const ctx = this.building;
    if (!ctx) return { supports: [], solids: [] };
    const obstacles = this.office?.obstacles() ?? null;
    const key: unknown[] = [ctx.plan, this.loaded, obstacles];
    const c = this.worldCache;
    if (!c || key.some((k, i) => k !== c.key[i])) {
      const loaded = this.loaded !== null && obstacles && this.office ? loadedFloor(this.office.layout, this.loaded, obstacles) : null;
      this.worldCache = { key, world: walkWorld(ctx.plan, loaded) };
    }
    return (this.worldCache as { world: WalkWorld }).world;
  }

  /**
   * Where the walker is now, and what follows from it: a landing gives its
   * floor the interior (its door opens onto it), the lobby needs none;
   * crossing the lobby's front door is what the receptionist hears about.
   */
  private updatePlace(walked: boolean, force = false): void {
    const ctx = this.building;
    if (!ctx) return;
    const prev = this.place;
    const next = placeAt(this.walker, ctx.plan);
    if (next.area === 'fire-escape' && next.storey !== null && next.storey !== this.loaded) this.loadFloor(next.storey);
    if (next.area === 'floor' && next.storey !== null && next.storey !== this.loaded) this.loadFloor(next.storey);
    if (next.area === 'lobby' && this.office) this.unloadFloor();
    if (this.office) this.office.root.visible = next.area === 'floor' || next.area === 'fire-escape';
    if (!force && next.area === prev.area && next.storey === prev.storey) return;
    this.place = next;
    if (walked && prev.area === 'street' && next.area === 'lobby') this.receptionEvent('arrive-street');
    if (walked && prev.area === 'lobby' && next.area === 'street') this.receptionEvent('leave-front');
    if (next.area !== 'floor' && this.planOpen) this.setPlan(false);
    this.hud.setArea(next.area);
    this.refreshTopbar();
    this.updateHint();
    this.panels.refresh();
    this.statusDirty = true;
  }

  /** The session of the floor you are on (inside it), else null. */
  hereSession(): string | null {
    return this.mode === 'floor' && this.place.area === 'floor' && this.office ? this.office.session : null;
  }

  private receptionEvent(ev: ReceptionEvent): void {
    const ctx = this.building;
    if (!ctx) return;
    this.receptionEvents.push({ ev, at: Date.now(), building: ctx.id });
    this.reception.handle(ev, receptionContext(this.store, ctx.id, new Date()));
  }

  /** Fire-escape door of the floor with an interior: open while you are near it. */
  private animateDoors(dt: number): void {
    const o = this.office;
    const ctx = this.building;
    if (o && ctx && this.loaded !== null) {
      const e = ctx.plan.escape;
      const dz = (e.door.z0 + e.door.z1) / 2;
      const near = Math.abs(this.walker.y - floorY(this.loaded)) < 1 && Math.hypot(this.walker.x, this.walker.z - dz) < 2.4;
      const want = near ? 1 : 0;
      if (this.fireDoor !== want) {
        const k = 1 - Math.exp(-dt * 9);
        this.fireDoor = Math.abs(want - this.fireDoor) < 0.01 ? want : this.fireDoor + (want - this.fireDoor) * k;
        o.setDoor(this.fireDoor);
        this.cameraMoved = true;
      }
      // The corner office's glass door: open while you are at the head of the stair or just inside.
      const m = o.layout.mezzanine;
      const dx = (m.door.x0 + m.door.x1) / 2;
      const up = this.walker.y - floorY(this.loaded);
      // M6c: it opens for a freelancer carrying a report up there (or coming down) the same way.
      const walkerAtDoor = this.arrivals.count > 0 && this.arrivals.info(performance.now() / 1000).some((a) => a.session === o.session && a.y - floorY(this.loaded as number) > m.y - 1.2 && a.y - floorY(this.loaded as number) < m.y + 0.5 && Math.hypot(a.x - dx, a.z - m.door.z) < 1.9);
      const atDoor = (up > m.y - 1.2 && up < m.y + 0.5 && Math.hypot(this.walker.x - dx, this.walker.z - m.door.z) < 1.9) || walkerAtDoor;
      const mWant = atDoor ? 1 : 0;
      if (this.mezzDoor !== mWant) {
        const k = 1 - Math.exp(-dt * 9);
        this.mezzDoor = Math.abs(mWant - this.mezzDoor) < 0.01 ? mWant : this.mezzDoor + (mWant - this.mezzDoor) * k;
        o.setMezzDoor(this.mezzDoor);
        this.cameraMoved = true;
      }
    }
    if (this.walk.outside?.lobby.update(dt, this.walker)) this.cameraMoved = true;
  }

  /** City camera: frame everything, or one building. */
  focusBuilding(i: number | null, animate = true): void {
    const f = i === null ? this.city.frameAll() : this.city.building(i);
    if (!f) return;
    this.focus = i;
    const dist = (f.radius / Math.sin(THREE.MathUtils.degToRad(this.cityCam.fov) / 2)) * (i === null ? 0.64 : 0.82);
    // From the south-east, low enough to look into the open floors.
    const dir = new THREE.Vector3().setFromSphericalCoords(1, 1.28, 0.5);
    const toPos = f.center.clone().addScaledVector(dir, dist);
    if (!animate) {
      this.controls.target.copy(f.center);
      this.cityCam.position.copy(toPos);
      this.controls.update();
      this.tween = null;
    } else {
      this.tween = { from: [this.controls.target.clone(), this.cityCam.position.clone()], to: [f.center.clone(), toPos], t0: performance.now(), ms: 650 };
    }
    this.activity(true);
  }

  private frameCity(animate: boolean): void {
    this.focusBuilding(null, animate);
  }

  setPlan(open: boolean): void {
    if (this.mode !== 'floor' || !this.office || this.place.area !== 'floor') open = false;
    this.planOpen = open;
    this.office?.setPlan(open);
    this.walk.setPlan(open);
    this.hud.setPlan(open, this.office?.session ?? '');
    if (open) this.walker.release();
    this.planLabelsKey = '';
    this.cameraMoved = true;
    this.updateHint();
    this.activity(true);
  }

  get plan(): boolean {
    return this.planOpen;
  }

  get busy(): boolean {
    return this.transitioning;
  }

  private toggleBattery(): void {
    this.batterySaver = !this.batterySaver;
    this.hud.setBattery(this.batterySaver);
    this.overviewDirty = true; // #118: the lights stop (or start) blinking
    this.hud.toast(this.batterySaver ? 'Battery saver on: 60 fps moving, 30 fps idle' : 'Battery saver off: 120 fps moving, 60 fps idle', 2200);
  }

  // ---- #118: the floor overview -----------------------------------------------------------------------

  /**
   * E at the lounge wall's screen (`fromScreen`: the page grows out of it) or O / the top bar's Overview (out of the
   * centre): the overview of the floor you are on.
   */
  openOverview(fromScreen: boolean): void {
    const s = this.hereSession();
    if (!s) {
      this.hud.toast('Walk onto an office floor to see its overview.', 2400);
      return;
    }
    this.walker.release();
    this.walker.stop();
    this.panels.close();
    if (this.planOpen) this.setPlan(false);
    this.updateHint();
    this.overview.open(s, fromScreen ? this.overviewScreenRect(s) : null);
  }

  /** What the page and the wall screen show of a floor (null: no such floor). */
  private overviewData(session: string): OverviewData | null {
    const fv = this.store.floorView(session);
    if (!fv) return null;
    return {
      tree: buildOverview(this.store, session),
      where: fv.level ? `Floor ${fv.level.number} of ${fv.level.count} · ${fv.building?.name ?? ''}` : 'Unassigned lot',
      counts: countItems(fv.counts, fv.asleep),
      asleep: fv.asleep,
    };
  }

  /** Where the wall screen of a floor is on your view (CSS px), or null when that floor is not around you or it is out of view. */
  private overviewScreenRect(session: string): ViewRect | null {
    const o = this.office;
    const p = o?.session === session ? o.layout.props.find((x) => x.id === 'screen.overview') : null;
    if (!o || !p || this.mode !== 'floor') return null;
    o.root.updateMatrixWorld(true);
    this.fpCam.updateMatrixWorld();
    const [x1, y0, z0] = [p.box.max[0], p.box.min[1], p.box.min[2]];
    const [y1, z1] = [p.box.max[1], p.box.max[2]];
    let l = Infinity;
    let t = Infinity;
    let r = -Infinity;
    let b = -Infinity;
    for (const [y, z] of [
      [y0, z0],
      [y0, z1],
      [y1, z0],
      [y1, z1],
    ] as const) {
      const v = o.root.localToWorld(new THREE.Vector3(x1, y, z)).project(this.fpCam);
      if (v.z > 1 || v.z < -1) return null; // behind you
      const px = ((v.x + 1) / 2) * this.vp.width;
      const py = ((1 - v.y) / 2) * this.vp.height;
      l = Math.min(l, px);
      r = Math.max(r, px);
      t = Math.min(t, py);
      b = Math.max(b, py);
    }
    l = Math.max(0, l);
    t = Math.max(0, t);
    r = Math.min(this.vp.width, r);
    b = Math.min(this.vp.height, b);
    return r - l > 8 && b - t > 8 ? { left: l, top: t, width: r - l, height: b - t } : null;
  }

  /** The wall screen and the open page follow the world (at most 4 times a second); the screen's blink and paging. */
  private stepOverview(now: number): void {
    const o = this.office;
    if ((this.overviewDirty || o !== this.overviewOffice) && now - this.overviewAt >= 250) {
      this.overviewDirty = false;
      this.overviewAt = now;
      this.overviewOffice = o;
      const calm = this.batterySaver || reducedMotionTest();
      if (o) o.setOverview(o.isAsleep ? null : this.overviewData(o.session), calm, Date.now());
      if (this.overview.isOpen) this.overview.refresh();
    }
    o?.tickOverview(Date.now(), this.fpCam);
  }

  /** #118: what the overview page and the wall screen show (test hook). */
  overviewInfo(): { page: ReturnType<OverviewOverlay['info']>; wall: ReturnType<OfficeView['overviewInfo']> } {
    return { page: this.overview.info(), wall: this.office?.overviewInfo() ?? null };
  }

  // ---- M13: whiteboard --------------------------------------------------------------------------------

  /** E on the whiteboard: the floor's board in the editor (an older bridge has none). */
  openWhiteboard(): void {
    const s = this.hereSession();
    if (!s) {
      this.hud.toast('Walk onto an office floor to use its whiteboard.', 2400);
      return;
    }
    if (this.unsupported.has('whiteboard.get')) {
      this.hud.toast('Update the bridge to use the whiteboard.', 3200);
      return;
    }
    this.walker.release();
    this.walker.stop();
    this.panels.close();
    this.updateHint();
    void this.whiteboard.open(s);
  }

  /** A floor's board changed (an event, a save of ours): the open editor merges it, the room shows its render. */
  private onWhiteboard(st: WhiteboardState): void {
    const old = this.wbStates.get(st.floor);
    if (old && old.version > st.version) return;
    this.wbStates.set(st.floor, st);
    this.whiteboard.updated(st);
    if (this.office?.session === st.floor) {
      this.syncWhiteboard();
      this.hud.setWhiteboard(st);
    }
  }

  /** Reads the board of the floor with an interior again (after a reconnect, or the first time). */
  private refreshWhiteboard(): void {
    const s = this.office?.session;
    if (!s || this.unsupported.has('whiteboard.get')) return;
    void this.fetchWhiteboard(s);
  }

  private async fetchWhiteboard(floor: string): Promise<void> {
    if (this.wbFetching.has(floor)) return;
    this.wbFetching.add(floor);
    try {
      await this.fetchWhiteboardOnce(floor);
    } finally {
      this.wbFetching.delete(floor);
    }
  }

  private async fetchWhiteboardOnce(floor: string): Promise<void> {
    const entry: (typeof this.wbLog)[number] = { t: 'whiteboard.get', args: { floor } };
    this.wbLog.push(entry);
    if (this.wbLog.length > 400) this.wbLog.shift();
    const r = await this.client.request('whiteboard.get', { floor });
    entry.result = r;
    if (!r.ok) {
      if (r.code === 'unknown_command' || r.code === 'unsupported') this.unsupported.add('whiteboard.get');
      return;
    }
    this.onWhiteboard(r.data as WhiteboardState);
  }

  /** The room's board shows its floor's render (one texture per floor; loading it again only when it changed). */
  private syncWhiteboard(): void {
    const o = this.office;
    if (!o) return;
    const st = this.wbStates.get(o.session);
    if (!st) {
      if (this.conn.phase === 'live') this.refreshWhiteboard();
      return;
    }
    this.hud.setWhiteboard(st);
    const key = `${st.version}:${st.render_version}:${st.render}:${st.stale_pins.length}`;
    if (this.wbLoad?.office === o && this.wbLoad.key === key) return;
    this.wbLoad?.abort.abort();
    const abort = new AbortController();
    this.wbLoad = { office: o, key, abort };
    loadBoardTexture(this.url, st, abort.signal)
      .then((tex) => {
        if (this.office !== o || abort.signal.aborted) {
          tex?.dispose();
          return;
        }
        o.setWhiteboard(tex);
        this.activity(false);
      })
      .catch((err: unknown) => {
        if (!abort.signal.aborted) console.warn('whiteboard render not loaded', err);
      });
  }

  /** M13: what the room's whiteboard shows (test hook). */
  whiteboardInfo(): { state: WhiteboardState | null; shown: string | null; overlay: ReturnType<WhiteboardOverlay['info']> } {
    const s = this.office?.session;
    return { state: s ? (this.wbStates.get(s) ?? null) : null, shown: this.office?.whiteboardShown ?? null, overlay: this.whiteboard.info() };
  }

  // ---- M7: boards ------------------------------------------------------------------------------------

  /** The overlay of the floor you are on: the Issues or Pull requests list. An older bridge has none. */
  openBoard(which: 'issues' | 'prs'): void {
    const s = this.hereSession();
    if (!s) {
      this.hud.toast('Walk onto an office floor to see its boards.', 2400);
      return;
    }
    if (this.unsupported.has('board.watch')) {
      this.hud.toast('Update the bridge to use boards.', 3200);
      return;
    }
    this.walker.release();
    this.walker.stop();
    this.panels.close();
    this.boardsPanel.open(which, s);
  }

  /** A board message (no seq): the floor you watch has news. */
  private onBoard(m: BoardMessage): void {
    const u = this.boardBook.apply(m);
    const o = this.office;
    if (!o || m.session !== o.session) return;
    if (u.kind === 'prs' && u.merged.length) this.merged(u.merged);
    this.pushBoards();
  }

  /** Merged PRs (never the initial replay): each note flies off the board and the gong rings once per PR, a beat apart. */
  private merged(list: MergedPullRequest[]): void {
    const o = this.office;
    if (!o) return;
    const now = performance.now();
    for (const p of list) o.boards.flyOff(p.id, now);
    list.forEach((_, i) => {
      const ring = (): void => {
        if (this.office !== o) return;
        o.boards.gong?.ring(performance.now());
        const at = o.boards.gongAt();
        if (at) {
          o.root.updateMatrixWorld(true);
          this.audio.playAt('gong.wav', o.root.localToWorld(at));
        }
      };
      if (i === 0) ring();
      else window.setTimeout(ring, i * GONG_GAP_MS);
    });
    this.activity(false);
  }

  /** Watches the floor you stand on for boards, and only that one (one per connection); nothing on the street or in the city. */
  private syncBoardWatch(): void {
    const want = this.office && this.conn.phase === 'live' ? this.office.session : null;
    if (want === this.watched) return;
    const prev = this.watched;
    this.watched = want;
    if (prev) {
      this.boardBook.drop(prev);
      this.boardWatch.delete(prev);
      // Watching another floor replaces this watch by itself; only leaving for nowhere unwatches.
      if (!want) void this.sendBoard('board.unwatch', { session: prev });
    }
    if (want && !this.unsupported.has('board.watch')) void this.watchBoard(want);
    else this.pushBoards();
  }

  private async watchBoard(session: string): Promise<void> {
    const r = await this.sendBoard('board.watch', { session });
    if (this.watched !== session) return;
    if (r.ok) {
      const d = (r.data ?? {}) as Partial<WatchBoardAck>;
      this.boardWatch.set(session, d.enabled === false ? { enabled: false, ...(d.reason ? { reason: d.reason } : {}) } : { enabled: true });
    } else if (r.code !== 'unknown_command') {
      this.boardWatch.set(session, { enabled: false, reason: commandFailure('board.watch', r.code, r.message, { floor: session }) });
    }
    this.pushBoards();
  }

  /** A command the game sends by itself for the boards: like `send`, logged apart from `sent`. */
  private async sendBoard<T extends 'board.watch' | 'board.unwatch' | 'board.refresh'>(t: T, args: CommandArgs[T]): Promise<CommandResult> {
    const entry: (typeof this.boardLog)[number] = { t, args };
    this.boardLog.push(entry);
    if (this.boardLog.length > 400) this.boardLog.shift();
    const r = await this.client.request(t, args);
    entry.result = r;
    if (!r.ok && r.code === 'unknown_command') {
      this.unsupported.add(t);
      this.pushBoards();
    }
    return r;
  }

  private boardOff(session: string): BoardOff | null {
    if (this.unsupported.has('board.watch')) return { text: 'Update the bridge to use boards', sub: 'This herdr-world does not know the issues and pull request boards yet.' };
    const w = this.boardWatch.get(session);
    if (w && !w.enabled) {
      const why = w.reason ? `${w.reason.charAt(0).toUpperCase()}${w.reason.slice(1).replace(/\.$/, '')}.` : 'No issue provider is linked to this floor.';
      return { text: 'No board on this floor', sub: `${why} Link a repository in the floor’s settings (elevator, then the gear).` };
    }
    return null;
  }

  private boardState(session: string): BoardState {
    const b = this.boardBook.get(session);
    return { issues: b.issues, prs: b.prs, off: this.boardOff(session) };
  }

  /** Shows what the boards say now: on the wall, on the look-at prompt, on the top bar, and in the overlay. */
  private pushBoards(): void {
    const o = this.office;
    this.hud.setBoardButtons(this.unsupported.has('board.watch') ? 'Update the bridge to use boards.' : null);
    if (o) {
      const s = o.session;
      const st = this.boardState(s);
      const workers = this.store.floorView(s)?.workers ?? [];
      const now = performance.now();
      o.boards.setIssues({ msg: st.issues, off: st.off }, workers, now);
      o.boards.setPrs({ msg: st.prs, issues: st.issues, off: st.off }, workers, now);
      const info = (msg: { provider_name: string; fetched_at: number } | null, n: number) =>
        st.off ? { task: st.off.text, live: !this.unsupported.has('board.watch'), why: st.off.sub ?? st.off.text } : msg && msg.fetched_at ? { task: `${msg.provider_name} · ${n} open`, live: true } : { task: 'Waiting for the bridge…', live: true };
      this.hud.setBoardInfo('board.issues', info(st.issues, st.issues?.cards.filter((c) => c.state === 'open').length ?? 0));
      this.hud.setBoardInfo('board.prs', info(st.prs, st.prs?.prs.length ?? 0));
      this.activity(false);
    }
    this.boardsPanel.refresh();
  }

  /** Opens a provider's page in the user's browser (the Mac helper does it), else in a new window. */
  external(url: string): void {
    void openExternal(url, this.noOpen ? { token: this.token, open: () => undefined } : { token: this.token }).then((via) => {
      this.opened.push({ url, via });
      if (via === 'refused') this.hud.toast("That link can't be opened from here.", 3200, 'error');
    });
  }

  /** The free desk nearest to you on a floor (not the first one), else null. */
  private nearestFreeDesk(session: string): number | null {
    const fv = this.store.floorView(session);
    const L = this.office?.session === session ? this.office.layout : this.layoutOf(session);
    if (!fv || !L) return null;
    const held = this.heldDesks(session);
    return nearestDesk(L.slots, freeDesks(fv).filter((d) => !held.has(d)), { x: this.walker.x, z: this.walker.z });
  }

  private whyFloorBusy(session: string): string | null {
    const fv = this.store.floorView(session);
    if (!fv) return `${session} is gone.`;
    if (fv.asleep || fv.transition) return `${session} is ${fv.transition === 'waking' ? 'waking up' : fv.transition === 'sleeping' ? 'going to sleep' : 'asleep'}: wake it from the elevator (L) first.`;
    if (this.nearestFreeDesk(session) === null) return `No free desk on ${session} right now.`;
    return null;
  }

  private whyNoRun(session: string): string | null {
    return runUnsupported({ store: this.store, unsupported: (t) => this.unsupported.has(t) }) ?? this.whyFloorBusy(session);
  }

  private whyNoHire(session: string): string | null {
    if (this.unsupported.has('hire.prepare') || this.unsupported.has('worker.hire')) return commandFailure('worker.hire', 'unknown_command', '');
    return this.whyFloorBusy(session);
  }

  /** "Hand to a worker": the start-run dialog with the card, the floor's last team, at the free desk nearest to you. */
  private handTo(session: string, card: IssueCard, provider: string): void {
    const desk = this.nearestFreeDesk(session);
    const b = this.boardBook.get(session).issues;
    this.boardsPanel.close();
    this.openStartRun({
      session,
      ...(desk !== null ? { desk } : {}),
      workItem: { provider: provider || (b?.provider ?? ''), id: card.id, key: card.key, title: card.title, url: card.url, provider_name: b?.provider_name },
    });
  }

  /**
   * "Open PR" shows for a plain worker (no run role) on the floor whose PR board says it can open one from a branch.
   * The bridge decides again (branch, checkout, origin): this only keeps the button where it can work.
   */
  private canOpenPr(id: string): boolean {
    const v = this.store.workerView(id);
    if (!v || crewRole(v.worker) !== null || this.unsupported.has('worker.open_pr')) return false;
    return can(this.boardBook.get(v.worker.session).prs, null, 'open_from_branch');
  }

  private openPrFor(id: string): void {
    if (!this.canOpenPr(id)) return;
    this.walker.release();
    this.walker.stop();
    this.openPr.open(id);
  }

  /** "Ask a worker…": the hire dialog at the nearest free desk with a first prompt to look into it. */
  private askAbout(session: string, card: IssueCard): void {
    const desk = this.nearestFreeDesk(session);
    this.boardsPanel.close();
    this.openHire(desk ?? undefined, { prompt: askPrompt(card.key, card.url) });
  }

  /** "Review with a worker": the hire dialog with the last team's reviewer and the code-review prompt for the PR. */
  private reviewPr(session: string, pr: PullRequest): void {
    const desk = this.nearestFreeDesk(session);
    const fv = this.store.floorView(session);
    const preset = this.store.presets.defaultFor(fv?.floor.last_preset);
    const reviewer = preset?.roles.reviewer;
    this.boardsPanel.close();
    this.openHire(desk ?? undefined, { prompt: reviewPrompt(reviewer?.harness ?? 'claude', { key: pr.key, ...(pr.url ? { url: pr.url } : {}) }), ...(reviewer ? { choice: reviewer } : {}) });
  }

  /** The note of a card leaves its board and is carried to an orchestrator's desk. */
  private peelNote(cardId: string, orchId: string): void {
    const o = this.office;
    const v = this.store.workerView(orchId);
    if (!o || !v || o.session !== v.worker.session) return;
    const slot = o.layout.slots[v.desk];
    if (!slot) return;
    o.boards.peel(cardId, new THREE.Vector3(slot.desk.x, 1.05, slot.desk.z), performance.now());
    this.activity(true);
  }

  /** Everything the boards show on the wall (test hook). */
  boardsInfo(): (ReturnType<OfficeView['boards']['info']> & { session: string; watched: string | null; off: string | null; batches: number; office: number }) | null {
    const o = this.office;
    if (!o) return null;
    return { session: o.session, watched: this.watched, off: this.boardOff(o.session)?.text ?? null, ...o.boards.info(performance.now()), batches: o.boards.noteBatches, office: o.serial };
  }

  /** Applies a board message as if the bridge had sent it (test hook). */
  injectBoard(m: BoardMessage): void {
    this.onBoard(m);
  }

  private updateHint(): void {
    // #124: the keys come from the shortcut table; every line ends on the way to the rest of them.
    const more = ` · <strong>${keyName('help')}</strong> all shortcuts`;
    this.hintSitting = this.walker.sitting;
    if (this.mode === 'city') {
      this.hud.setHint(this.city.isEmpty ? null : `Drag to orbit · Scroll to zoom · <strong>Click a floor</strong> to go inside · <strong>${keyName('buildings')}</strong> buildings${more}`);
      return;
    }
    const area = this.place.area;
    const look = this.walker.locked ? '' : this.walker.lockAvailable ? '<strong>Click</strong> to look around · ' : '';
    if (area === 'lobby') {
      this.hud.setHint(this.walker.locked ? null : `${look}WASD walks · <strong>E</strong> at the desk: the floor directory · <strong>L</strong> elevator · the glass doors lead outside${more}`);
      return;
    }
    if (area === 'street') {
      this.hud.setHint(this.walker.locked ? null : `${look}WASD walks · the glass doors lead into the lobby, the fire escape up the side · <strong>L</strong> elevator${more}`);
      return;
    }
    if (area === 'fire-escape') {
      this.hud.setHint(this.walker.locked ? null : `${look}WASD walks · a floor's door opens as you walk up to it · <strong>L</strong> elevator${more}`);
      return;
    }
    const fv = this.office ? this.store.floorView(this.office.session) : null;
    const asleep = fv?.asleep && !fv.transition ? 'This floor is asleep: the elevator (<strong>L</strong>) wakes it · ' : '';
    if (this.walker.sitting && !this.planOpen) this.hud.setHint(this.walker.locked ? `At your desk · <strong>WASD</strong> gets up${more}` : `At your desk · ${look}<strong>WASD</strong> or <strong>Esc</strong> gets up${more}`);
    else if (this.planOpen) this.hud.setHint(`<strong>Click</strong> the floor to walk there · WASD walks · <strong>L</strong> elevator · <strong>Tab</strong> back to first person${more}`);
    else if (this.walker.locked) this.hud.setHint(null);
    // #118: the floor overview is in the hint too (the top bar's button goes where the bar is short).
    else if (asleep) this.hud.setHint(`${asleep}<strong>Click</strong> to look around · WASD walks · <strong>← →</strong> turn${more}`);
    else if (!this.walker.lockAvailable) this.hud.setHint(`WASD walks · <strong>← →</strong> turn · <strong>${keyName('select.next')}</strong> pick · <strong>${keyName('hire')}</strong> hire · <strong>L</strong> elevator · <strong>${keyName('overview')}</strong> overview · <strong>Tab</strong> floor plan (mouse look is unavailable here)${more}`);
    else this.hud.setHint(`<strong>Click</strong> to look around · WASD walks · <strong>← →</strong> turn · <strong>${keyName('select.next')}</strong> pick · <strong>${keyName('hire')}</strong> hire · <strong>L</strong> elevator · <strong>${keyName('overview')}</strong> overview · <strong>Tab</strong> floor plan · Esc releases the mouse${more}`);
  }

  // ---- input -------------------------------------------------------------------

  private bindInput(): void {
    const canvas = this.r.domElement;
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => this.onVisibility());
    window.addEventListener('keydown', (e) => this.onPaletteKey(e), true);
    window.addEventListener('keydown', (e) => this.onHelpKey(e), true);
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    canvas.addEventListener('pointerdown', (e) => (this.down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointermove', (e) => {
      if (this.mode === 'city' && !this.down) this.city.setHover(this.cityPick(e));
      this.pointerAt = { clientX: e.clientX, clientY: e.clientY };
    });
    canvas.addEventListener('pointerleave', () => (this.pointerAt = null));
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
      this.onClick(e);
    });
    canvas.addEventListener('wheel', () => this.activity(true), { passive: true });
    this.hud.planElement.addEventListener('click', (e) => this.onPlanClick(e));
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    // A release always reaches the walker, whatever the view, focus or open
    // sheet: a key let go anywhere else must not stay held.
    if (!down) {
      if (this.walker.key(e, false) && this.mode === 'floor') e.preventDefault();
      return;
    }
    // M13: the whiteboard's editor owns every key while it is open (its Esc closes it, ui/whiteboard.ts).
    if (this.whiteboard.isOpen) return;
    // M10 (#47): a screen-filling dialog hides the plan limits; Shift+L still peeks them over it (else the dialog owns the keys).
    if (pressesBinding(e, 'limits') && this.limitsWidget.overScreen && !typingIn(e.target)) {
      e.preventDefault();
      if (!e.repeat) this.limitsWidget.toggleFromKey(); // a held key does not re-toggle the peek
      return;
    }
    // Open dialogs (sheet, panels, confirmations, hire / send home) handle their own keys.
    // (#124: so does the shortcut list, even with the focus out on the page behind it: Tab there is not the floor plan.)
    if (this.hud.sheetOpen || this.panels.open || this.dialogOpen || this.shortcuts.isOpen) return;
    // M5: at a worker's laptop every key goes to its terminal (Esc gets you up).
    if (this.laptops.key(e)) return;
    // #124: a text field's keys are its own (the shortcut list from inside one is `onHelpKey`'s).
    if (typingIn(e.target)) return;
    // M5: keys in the Changes panel are its own.
    if (this.changes.owns(e.target)) return;
    this.activity(true);
    if (this.mode === 'floor' && this.walker.key(e, true)) {
      e.preventDefault();
      return;
    }
    const m = findBinding(e, this.activeScopes(), false);
    if (!m) return;
    const id = m.binding.id as DispatchedId;
    // From a focused control Tab moves focus as usual; from the scene it is the floor plan / the way into the top bar.
    if ((id === 'plan' || id === 'topbar') && !this.sceneFocused()) return;
    if (!m.binding.quiet) e.preventDefault();
    // A held key does not re-fire a toggle or an opener (B, Tab, H, I, ...).
    if (e.repeat && !m.binding.repeat) return;
    this.actions[id](m);
  }

  /**
   * #124: the scopes the shortcut table is live in right now: where you are, what you aim at (or picked with T) and what
   * is open. `findBinding` dispatches only from these.
   */
  private activeScopes(): Set<Scope> {
    const s = new Set<Scope>(['any']);
    if (this.mode === 'city') {
      s.add('city');
      if (this.focus !== null) s.add('city:focus');
      return s;
    }
    s.add('floor');
    const t = this.target;
    if (this.keyTarget) s.add('selected');
    if (this.planOpen) s.add('plan');
    if (this.walker.sitting) s.add('sitting');
    // C on a worker works under the plan too (it always did); the other aimed keys do not.
    if (this.changes.isOpen || (this.planOpen && t?.kind === 'worker')) s.add('changes');
    if (t && (!this.planOpen || (t.kind === 'prop' && t.id === 'reception'))) {
      const a = aimScope(t);
      if (a) s.add(a);
    }
    return s;
  }

  /** What each binding of the table does (the compiler wants one for every id that is not only listed). */
  private readonly actions: Record<DispatchedId, (m: Match) => void> = {
    palette: () => this.togglePalette(), // #147: `onPaletteKey` takes the chord in the capture phase; this is the table's own entry
    help: () => this.openShortcuts(),
    'help.field': () => this.openShortcuts(),
    'next-need': () => {
      if (!this.transitioning) this.goNextNeed();
    },
    inbox: () => this.openInboxKey(),
    limits: () => this.limitsWidget.toggleFromKey(),
    battery: () => this.toggleBattery(),
    settings: () => this.settings.open(),
    overview: () => {
      // #118: the overview of the floor you are on, wherever you stand on it (the city and the lobby say where to go).
      if (!this.transitioning) this.openOverview(false);
    },
    'look.level': () => this.walker.level(),
    hire: () => this.openHire(),
    issues: () => this.openBoard('issues'),
    prs: () => this.openBoard('prs'),
    run: () => this.openStartRun(),
    elevator: () => {
      // The elevator from anywhere on the floor (the top bar has it too).
      if (!this.transitioning) this.openElevator();
    },
    plan: () => {
      if (this.place.area !== 'floor') this.hud.toast('The floor plan is for office floors.', 1800);
      else this.setPlan(!this.planOpen);
    },
    topbar: () => {
      this.walker.release();
      this.hud.focusTopbar();
    },
    leave: () => void this.leaveFloor(),
    stand: () => this.standUp(),
    'plan.close': () => this.setPlan(false),
    buildings: () => this.openBuildings(),
    'city.unfocus': () => this.focusBuilding(null),
    'select.next': () => this.cycleTarget(1),
    'select.prev': () => this.cycleTarget(-1),
    'select.clear': () => this.clearKeyTarget(),
    'worker.sit': () => this.aimed('worker', (t) => void this.sitAt(t.id)),
    'worker.prompt': () => this.aimed('worker', (t) => this.openPrompt(t.id)),
    'worker.changes': () => this.toggleChanges(this.target?.kind === 'worker' ? this.target.id : null),
    'worker.home': () => this.aimed('worker', (t) => this.openSendHome(t.id)),
    'worker.answer': (m) => this.aimed('worker', (t) => this.answerKey(t.id, Number(m.code.slice(-1)))),
    'desk.hire': () => this.aimed('desk', (t) => this.openHire(t.desk)),
    'own-desk.sit': () => this.sit(),
    'board.open': () => this.aimed('board', (t) => this.openBoard(t.id === 'board.issues' ? 'issues' : 'prs')),
    'elevator.open': () => this.openElevator(),
    'reception.open': () => {
      // The receptionist answers, and the elevator panel is the building's floor directory.
      this.receptionEvent('interact');
      this.openElevator();
    },
    'whiteboard.open': () => this.openWhiteboard(),
    'overview.open': () => this.openOverview(true),
    'radio.genre': () => this.radio.cycle(),
    'radio.track': () => this.radio.skip(),
  };

  /** Runs `fn` on the aimed target when it is of that kind (the binding's scope says it is; this narrows the type). */
  private aimed<K extends Target['kind']>(kind: K, fn: (t: Target & { kind: K }) => void): void {
    const t = this.target;
    if (t?.kind === kind) fn(t as Target & { kind: K });
  }

  /**
   * #124: `?` and Ctrl/Cmd+/, bound in the capture phase so they reach the game from under the dialogs that stop their
   * keys (About, Settings, the music credits, a panel's rows). The rule, deliberately: the reference opens from any
   * non-typing context but the seated terminal (no help key there: Esc, then ?) and the whiteboard (it owns every key);
   * from inside a text field only the modifier chord does, and `?` types. A modal over a modal is fine: Esc closes the top one.
   */
  private onHelpKey(e: KeyboardEvent): void {
    if (e.isComposing || this.whiteboard.isOpen || this.laptops.seated || this.shortcuts.isOpen) return;
    const typing = typingIn(e.target);
    if (!(pressesBinding(e, 'help.field') || (!typing && pressesBinding(e, 'help')))) return;
    // The image previews and a card being dragged have their own capture-phase Esc: not over them.
    if (document.querySelector('dialog.ilb[open], dialog.cmp-lightbox[open], .bd-dragging')) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) this.openShortcuts();
  }

  /**
   * #147: ⌘/Ctrl+P, in the capture phase, so it reaches the game from every view: under a dialog, in a field, seated at a
   * laptop (the terminal does not get it) and on the whiteboard (Excalidraw does not either). It is always cancelled
   * (no print dialog, even on a repeat or where the palette will not open); it opens the palette, or closes it when it
   * is up. Not during an IME composition. Over the image previews it opens (the palette is the topmost modal and gets
   * Esc first: `inPalette` keeps the previews' own capture-phase Esc away from it); a card being dragged is let go first.
   */
  private onPaletteKey(e: KeyboardEvent): void {
    if (e.isComposing || !pressesBinding(e, 'palette')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    this.togglePalette();
  }

  togglePalette(): void {
    if (this.palette.isOpen) this.palette.close();
    else this.openPalette();
  }

  openPalette(): void {
    this.boardsPanel.cancelDrag(); // a card in the air is put back: the palette is modal, the drop would land under it
    this.walker.release();
    this.walker.stop();
    this.palette.open(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  }

  /**
   * #147: the palette picked `command` (`floor`: the floor chosen for it when it acts on one and you were not on one).
   * The modals and the whiteboard go first (as for a teleport) and a seat is left; then the floor, by the elevator;
   * then the very action its key would run.
   */
  private async runPaletteCommand(command: PaletteCommand, floor: string | null): Promise<void> {
    if (this.transitioning || !(await this.dismissOverlays()) || this.transitioning) return;
    if (this.laptops.seated) this.laptops.stand(null, true);
    if (floor !== null && this.hereSession() !== floor) {
      await this.enterFloor(floor);
      if (this.hereSession() !== floor) return; // the floor went meanwhile
    }
    if (command.id === 'presets') return this.openPresets();
    if (command.id === 'about') return this.hud.openAbout();
    const b = binding(command.id);
    const chord = b.keys[0];
    this.actions[command.id as DispatchedId]({ binding: b, chord: chord ?? {}, code: chord?.code ?? '' });
  }

  /** #147: a floor picked from the palette's `@` list: the modals go, you get up from a seat, the elevator takes you there. */
  private async goToFloor(session: string): Promise<void> {
    if (this.transitioning || !(await this.dismissOverlays()) || this.transitioning) return;
    if (this.laptops.seated) this.laptops.stand(null, true);
    this.walker.release();
    this.walker.stop();
    await this.enterFloor(session);
  }

  /** The `?` reference: grouped, per platform, over whatever is up. */
  openShortcuts(): void {
    this.walker.release();
    this.walker.stop();
    this.shortcuts.open(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  }

  /** Shift+N: the inbox's list, with the keyboard in it (again: closed). */
  private openInboxKey(): void {
    const s = this.inbox.summary();
    if (s.open) {
      this.inbox.closeList();
      return;
    }
    if (!s.shown) {
      this.hud.toast('Nothing in the inbox: no one needs you and nothing is waiting to be read.', 2600);
      return;
    }
    this.walker.release();
    this.walker.stop();
    this.inbox.openList(true);
  }

  /** Nothing but the scene has keyboard focus (no HUD control). */
  private sceneFocused(): boolean {
    const a = document.activeElement;
    return !a || a === document.body || a === this.r.domElement;
  }

  private cityRayFloor(e: { clientX: number; clientY: number }): string | null {
    const rect = this.r.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.cityCam);
    return this.city.pickFloor(rc.ray.origin, rc.ray.direction);
  }

  /** Floor under the pointer in the city: its badge, else the floor itself. */
  private cityPick(e: { clientX: number; clientY: number }): string | null {
    const rect = this.r.domElement.getBoundingClientRect();
    return this.city.pickBadge(this.cityCam, e.clientX - rect.left, e.clientY - rect.top, this.vp) ?? this.cityRayFloor(e);
  }

  private onClick(e: PointerEvent): void {
    if (this.mode === 'city') {
      const rect = this.r.domElement.getBoundingClientRect();
      const badge = this.city.pickBadge(this.cityCam, e.clientX - rect.left, e.clientY - rect.top, this.vp);
      if (badge) {
        void this.enterFloor(badge);
        return;
      }
      const s = this.cityRayFloor(e);
      if (!s) return;
      const b = this.city.buildingOf(s);
      // First click on a building: focus it and open its elevator panel; on
      // the focused building, a click on a floor goes straight inside.
      if (b !== null && this.focus !== b) {
        this.focusBuilding(b);
        const id = this.city.buildingId(b);
        if (id !== undefined) this.openElevator(id);
      } else void this.enterFloor(s);
      return;
    }
    // M5: seated, a click keeps the keyboard on the laptop (no mouse look).
    if (this.laptops.seated) return this.laptops.focusSeat();
    if (!this.planOpen && this.clickPrints(e)) return;
    if (!this.planOpen && this.clickBoardHolder(e)) return;
    if (!this.planOpen) this.walker.requestLock();
  }

  /** M16 phase 2: a click on a print lying on a desk (from the crosshair while the mouse looks, else the pointer). */
  private clickPrints(e: PointerEvent): boolean {
    if (this.mode !== 'floor' || this.place.area !== 'floor') return false;
    const canvas = this.r.domElement;
    const rect = canvas.getBoundingClientRect();
    const locked = document.pointerLockElement === canvas;
    const x = locked ? 0 : ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = locked ? 0 : -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.walker.applyTo(this.fpCam, this.walk.base);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(x, y), this.fpCam);
    return this.laptops.clickPrint(ray);
  }

  /** Where the pointer last was over the scene (null: not over it); it aims when the mouse does not look. */
  private pointerAt: { clientX: number; clientY: number } | null = null;

  /** The worker whose tag on an issue-wall note is under the aim (the crosshair while the mouse looks, else the pointer). */
  private holderUnderAim(e?: { clientX: number; clientY: number }): string | null {
    const o = this.office;
    if (this.mode !== 'floor' || this.place.area !== 'floor' || !o || this.planOpen || this.laptops.seated) return null;
    const canvas = this.r.domElement;
    const at = document.pointerLockElement === canvas ? null : (e ?? this.pointerAt);
    if (!at && document.pointerLockElement !== canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = at ? ((at.clientX - rect.left) / rect.width) * 2 - 1 : 0;
    const y = at ? -((at.clientY - rect.top) / rect.height) * 2 + 1 : 0;
    this.walker.applyTo(this.fpCam, this.walk.base);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(x, y), this.fpCam);
    return o.boards.pickHolder(ray.ray);
  }

  /** A click on a holder's tag on the issue wall: that worker's transcript. */
  private clickBoardHolder(e: PointerEvent): boolean {
    const id = this.holderUnderAim(e);
    if (!id) return false;
    void this.goToWorker(id);
    return true;
  }

  /** Test hook: the worker whose tag on an issue note is under a point of the viewport (NDC). */
  holderAtNdc(ndcX: number, ndcY: number): string | null {
    const o = this.office;
    if (this.mode !== 'floor' || !o) return null;
    this.walker.applyTo(this.fpCam, this.walk.base);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.fpCam);
    return o.boards.pickHolder(ray.ray);
  }

  /** Test hook: a click on the print under a point of the viewport (NDC), as the pointer would. */
  clickPrintAt(ndcX: number, ndcY: number): boolean {
    if (this.mode !== 'floor') return false;
    this.walker.applyTo(this.fpCam, this.walk.base);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.fpCam);
    return this.laptops.clickPrint(ray);
  }

  private onPlanClick(e: MouseEvent): void {
    if (!this.office || (e.target as HTMLElement).closest('.plan-card')) return;
    const rect = this.r.domElement.getBoundingClientRect();
    const p = new THREE.Vector3(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1, 0).unproject(this.planCam);
    const L = this.office.layout;
    const fy = floorY(this.loaded ?? 0);
    if (p.x < 0 || p.z < 0 || p.x > L.width || p.z > L.depth || blocked({ x: p.x, z: p.z }, 0.28, this.office.obstacles()) || blocked3({ x: p.x, y: fy, z: p.z }, RADIUS, this.walkWorldNow())) {
      this.hud.toast('Something is in the way there.', 1600);
      return;
    }
    // Face the clicked point's nearest desk row: keep it simple, face north.
    this.walker.place(p.x, p.z, this.walker.yaw, this.walker.pitch, fy);
    this.cameraMoved = true;
    this.activity(true);
  }

  private onVisibility(): void {
    if (document.hidden) {
      void this.r.setAnimationLoop(null);
      this.walker.release();
      this.walker.stop();
    } else {
      this.resume();
    }
  }

  private activity(camera: boolean): void {
    this.lastActivity = performance.now();
    if (camera) this.cameraMoved = true;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.vp.width = w;
    this.vp.height = h;
    this.r.setSize(w, h);
    this.cityCam.aspect = this.fpCam.aspect = w / h;
    this.cityCam.updateProjectionMatrix();
    this.fpCam.updateProjectionMatrix();
    this.planCam.userData.fit = false;
    this.cameraMoved = true;
  }

  // ---- frame -------------------------------------------------------------------

  /** Animation-loop callback: frame pacing, then update + render. */
  tick(now: number): void {
    const active = this.walker.moving || this.tween !== null || this.transitioning || this.arrivals.count > 0 || !!this.office?.boardsBusy;
    const hz = targetHz({ hidden: document.hidden, batterySaver: this.batterySaver, sinceActivity: active ? 0 : now - this.lastActivity });
    if (!shouldRender(now, this.lastRender, hz)) return;
    const dt = Math.min(0.1, this.lastRender === -Infinity ? 1 / 60 : (now - this.lastRender) / 1000);
    this.lastRender = now;
    this.step(dt, now / 1000);
    this.render();
  }

  // ---- time of day (M17) -------------------------------------------------------

  /** Reads the time: the light's target (`snap`: straight there), the clock, when to read again. */
  readTime(snap: boolean): void {
    const s = this.timeOfDay.sample();
    this.sample = s;
    // A pinned time is frozen and starts where it stays: no easing from the last one.
    this.daylight.set(s, snap || this.timeOfDay.pinned);
    const f = TimeOfDay.face(s, this.timeOfDay.timeZone);
    this.clockFace = f;
    this.clockOffice = null;
    this.hud.setPropInfo('clock', `${f.time} · ${f.date} · ${f.zone}`);
    const now = Date.now();
    // Next read: just past the next minute (the clock rolls over on time), or never while pinned.
    this.nextRead = this.timeOfDay.pinned ? Infinity : now - (now % 60_000) + 60_050;
    this.applyDaylight();
  }

  private applyDaylight(): void {
    const look = lookOf(this.daylight.state);
    this.walk.setDaylight(look);
    this.city.setDaylight(look);
  }

  private stepDaylight(dt: number): void {
    if (Date.now() >= this.nextRead) this.readTime(false);
    if (this.daylight.step(dt)) this.applyDaylight();
    if (this.office && this.office !== this.clockOffice) {
      this.office.setClock(this.clockFace);
      this.clockOffice = this.office;
    }
  }

  /** M17: the light and the clock as shown (test hook). */
  daylightInfo(): { daylight: number; target: number; warmth: number; zone: string; zoneSource: string; latitude: number | null; pinned: boolean; model: string; instant: number; clock: { time: string; date: string; zone: string }; lamps: number[]; face: { time: string; date: string; day: boolean } | null } {
    const info = this.office?.lightInfo();
    return {
      daylight: +this.daylight.state.day.toFixed(4),
      target: +this.daylight.target.day.toFixed(4),
      warmth: +this.daylight.state.warmth.toFixed(4),
      zone: this.timeOfDay.timeZone,
      zoneSource: this.timeOfDay.zoneSource,
      latitude: this.timeOfDay.latitude,
      pinned: this.timeOfDay.pinned,
      model: this.sample?.model ?? 'fixed',
      instant: this.timeOfDay.instant(),
      clock: { ...this.clockFace },
      lamps: info?.lamps ?? [],
      face: info?.clock ?? null,
    };
  }

  /** One update at `dt` seconds of game time `t`. Also used by the benchmark. */
  step(dt: number, t: number): void {
    this.lastT = t;
    this.stepDaylight(dt);
    this.stepOverview(performance.now()); // #118
    if (this.mode === 'floor' && this.building) {
      if (this.walker.step(dt, this.walkWorldNow())) {
        this.cameraMoved = true;
        this.updatePlace(true);
      }
      // Sat down or got up (walking, Esc, a teleport): the hint follows.
      if (this.hintSitting !== this.walker.sitting) this.updateHint();
      // Up on the mezzanine (or near the top of its stair): look-at reaches down over the floor, cards read as nearer.
      this.office?.setOverlook(this.overlooking);
      this.animateDoors(dt);
      const area = this.place.area;
      this.walk.setDim(!!this.office?.isAsleep && (area === 'floor' || area === 'fire-escape'));
      this.walker.applyTo(this.fpCam, this.walk.base);
      this.stepArrivals(t);
      const moved = this.cameraMoved;
      if (this.planOpen) this.fitPlan();
      if (this.office?.root.visible) this.office.frame(t, this.planOpen ? this.planCam : this.fpCam, this.fpCam, this.vp, moved);
      // The receptionist looks at you and places the bubble while the lobby can be seen (hud.css hides it elsewhere).
      if (area === 'lobby' || area === 'street') this.reception.update(dt, this.fpCam);
      this.audio.setListener(this.fpCam);
      this.radio.frame(area === 'floor', this.office);
      this.updateLookAt();
      if (this.planOpen && (moved || this.planDirty)) this.layoutPlanLabels();
    } else {
      this.radio.frame(false, null);
      if (this.tween) {
        const k = Math.min(1, (performance.now() - this.tween.t0) / this.tween.ms);
        const e = 1 - (1 - k) ** 3;
        this.controls.target.lerpVectors(this.tween.from[0], this.tween.to[0], e);
        this.cityCam.position.lerpVectors(this.tween.from[1], this.tween.to[1], e);
        if (k >= 1) this.tween = null;
        this.cameraMoved = true;
      }
      this.controls.update();
      this.city.frame(t, this.cityCam);
    }
    // M5: live laptop screens, and the camera at the laptop you sit at.
    const onFloor = this.mode === 'floor' && (this.place.area === 'floor' || this.place.area === 'fire-escape');
    // #110: a pack-up check's dialog keeps you seated (the prompt box and its draft stay); it still owns the keys.
    // #118: the overview opened from the transcript (O) keeps the seat: Esc closes it back onto the conversation.
    const blocked = this.planOpen || this.panels.open || (this.dialogOpen && !this.sendHome.keepsSeat && !this.overview.isOpen) || this.hud.sheetOpen || this.transitioning;
    this.laptops.frame({ now: performance.now(), office: this.office, onFloor, camera: this.fpCam, walker: this.walker, blocked });
    if (this.laptops.animating) this.activity(true);
    this.cameraMoved = false;
  }

  /** Walkers in and out, and what their desks show meanwhile. */
  private stepArrivals(t: number): void {
    this.arrivals.group.position.y = -this.walk.base;
    const o = this.office;
    for (const d of this.arrivals.update(performance.now() / 1000, t)) {
      if (o?.session !== d.session) continue;
      o.setAway(d.desk, d.away);
      if (d.drop !== undefined) o.setDrop(d.desk, d.drop);
      if (d.out !== undefined) o.setOut(d.desk, d.out);
    }
    for (const w of this.arrivals.swivels) if (o?.session === w.session) o.setSwivel(w.desk, w.swivel);
    this.applyReserve();
    // M6c: folders that landed, freelancers that have left, and the next report in line.
    let moved = false;
    for (const key of this.arrivals.takeLanded()) {
      this.deliveries.land(key);
      moved = true;
    }
    for (const id of this.arrivals.takeEnded()) {
      this.deliveries.settle(id);
      moved = true;
    }
    if (moved || this.deliveries.queuedOrchs().length) this.pumpDeliveries();
  }

  render(): void {
    if (this.mode === 'floor') this.r.render(this.walk.scene, this.planOpen ? this.planCam : this.fpCam);
    else this.r.render(this.city.scene, this.cityCam);
    this.frames++;
    if (this.statusDirty) {
      this.statusDirty = false;
      const at = Date.now();
      const applied = this.mode === 'floor' && this.office ? this.office.applied : this.city.applied;
      for (const [id, status] of applied) {
        const prev = this.rendered.get(id);
        if (!prev || prev.status !== status) this.rendered.set(id, { status, at });
      }
    }
  }

  private fitPlan(): void {
    if (!this.office || this.planCam.userData.fit) return;
    const L = this.office.layout;
    const aspect = this.vp.width / this.vp.height;
    const pad = 1.6;
    // Leave room for the top bar and the plan card on the left.
    let halfH = L.depth / 2 + pad;
    let halfW = halfH * aspect;
    if (halfW < L.width / 2 + pad) {
      halfW = L.width / 2 + pad;
      halfH = halfW / aspect;
    }
    const cx = L.width / 2 - halfW * 0.12;
    Object.assign(this.planCam, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
    this.planCam.position.set(cx, 30, L.depth / 2 - halfH * 0.06);
    this.planCam.up.set(0, 0, -1);
    this.planCam.lookAt(cx, 0, L.depth / 2 - halfH * 0.06);
    this.planCam.updateProjectionMatrix();
    this.planCam.updateMatrixWorld();
    this.planCam.userData.fit = true;
  }

  private layoutPlanLabels(): void {
    const o = this.office;
    if (!o) return;
    this.planDirty = false;
    const toScreen = (x: number, y: number, z: number) => {
      const v = new THREE.Vector3(x, y, z).project(this.planCam);
      return { x: ((v.x + 1) / 2) * this.vp.width, y: ((1 - v.y) / 2) * this.vp.height };
    };
    const labels: PlanLabel[] = [];
    for (const p of o.layout.props) {
      // M15: the radio is a thing on the counter, not a placeholder to label; M17: nor is a look-only prop (the clock on the partition).
      // #118: nor is the overview's screen, on the lounge wall the Lounge label already marks.
      if (p.id === 'radio' || p.id === 'screen.overview' || p.milestone === null) continue;
      const c = toScreen((p.box.min[0] + p.box.max[0]) / 2, 0, (p.box.min[2] + p.box.max[2]) / 2);
      labels.push({ ...c, text: p.label, kind: 'prop' });
    }
    o.layout.slots.forEach((slot, i) => {
      const v = o.seat(i);
      const at = seatOf(o.layout, i, v);
      const s = at?.slot ?? slot;
      if (v) labels.push({ ...toScreen(s.seat.x, 1.2 + (at?.y ?? 0), s.seat.z), text: v.name, kind: 'worker', display: v.display });
      else labels.push({ ...toScreen(s.desk.x, 0.8, s.desk.z), text: `+ ${i + 1}`, kind: 'desk' });
    });
    // #20: the corner office on its mezzanine, its stair, your desk.
    const m = o.layout.mezzanine;
    labels.push({ ...toScreen((m.rect.x0 + m.rect.x1) / 2 + 1.2, m.y, m.rect.z1 - 0.8), text: 'Corner office (mezzanine)', kind: 'prop' });
    labels.push({ ...toScreen((m.stair.x0 + m.stair.x1) / 2, 1.5, (m.stair.top + m.stair.bottom) / 2), text: 'Stair', kind: 'prop' });
    labels.push({ ...toScreen(m.desk.desk.x, m.y + 0.8, m.desk.desk.z - 1.2), text: 'Your desk', kind: 'prop' });
    const me = toScreen(this.walker.x, 0, this.walker.z);
    // Everything the labels show, so a status or seat change redraws them too.
    const key = JSON.stringify([labels.map((l) => [l.kind, l.text, l.display ?? '', l.x | 0, l.y | 0]), me.x | 0, me.y | 0, this.walker.yaw.toFixed(2)]);
    if (key === this.planLabelsKey) return;
    this.planLabelsKey = key;
    this.hud.setPlanLabels(labels, { ...me, angle: -this.walker.yaw });
  }

  private updateLookAt(): void {
    const t = this.pickedTarget() ?? this.computeLookAt();
    this.target = t;
    const w = t?.kind === 'worker' ? this.store.workerView(t.id) : null;
    // M5: E sits at the worker's laptop, or says why it cannot.
    const why = w ? this.laptops.whyNot(w.worker.id, this.office) : null;
    this.hud.setKeyState('E', w ? (why ? { live: false, why } : { live: true }) : null);
    this.lookAtM5(this.planOpen ? null : w);
    // A holder's tag of an issue note under the aim: the pointer turns to a hand, the crosshair's prompt offers the click.
    const locked = document.pointerLockElement === this.r.domElement;
    const aimed = locked ? (t?.kind === 'board' && t.id === 'board.issues' ? this.holderUnderAim() : null) : null;
    this.hud.setBoardHolder(aimed ? (this.store.workerView(aimed)?.name ?? null) : null);
    // The plan has its own labels; the prompt bar belongs to first person.
    this.hud.setTarget(this.planOpen ? null : t, w);
    this.r.domElement.style.cursor = !locked && this.holderUnderAim() ? 'pointer' : '';
  }

  private computeLookAt(): Target | null {
    this.fpCam.getWorldDirection(this.ray);
    const o = this.fpCam.position;
    const area = this.place.area;
    if (area === 'floor' && this.office) {
      // Your desk only from inside your office, standing (E sits you down).
      return this.office.pick([o.x, o.y, o.z], [this.ray.x, this.ray.y, this.ray.z], this.overlooking ? overlookReach(this.office.layout) : REACH, this.inOffice() && !this.walker.sitting);
    }
    const lobby = this.walk.outside?.lobby;
    if (area === 'lobby' && lobby) {
      const t = lobby.pick([o.x, o.y + this.walk.base, o.z], [this.ray.x, this.ray.y, this.ray.z], REACH);
      return t ? LOBBY_TARGETS[t] : null;
    }
    return null;
  }

  // ---- #124: picking a target without aiming ------------------------------------------------

  /** The worker, desk or prop picked with T, while it holds: you have not moved or turned since and it is still there. */
  private pickedTarget(): Target | null {
    const k = this.keyTarget;
    if (!k) return null;
    const w = this.walker;
    const o = this.office;
    const same = Math.abs(w.x - k.pose.x) < 1e-6 && Math.abs(w.z - k.pose.z) < 1e-6 && Math.abs(w.yaw - k.pose.yaw) < 1e-6 && Math.abs(w.pitch - k.pose.pitch) < 1e-6;
    if (this.mode === 'floor' && this.place.area === 'floor' && o?.session === k.session && same && o.stillPickable(k.target)) return k.target;
    this.keyTarget = null;
    return null;
  }

  private clearKeyTarget(): void {
    if (!this.keyTarget) return;
    this.keyTarget = null;
    this.updateLookAt();
  }

  /**
   * T / Shift+T: picks the next / previous worker, desk or prop of the floor and turns to it, so the card, the prompt and the
   * keys (E, P, C, X, the answer digits) are what aiming at it gives. From nothing picked or aimed it starts at the nearest
   * one. Level, unlike aiming: a picked one does not need to be within reach, and look up and down (Page Up / Down) is only for aiming by hand.
   */
  private cycleTarget(dir: 1 | -1): void {
    const o = this.office;
    if (this.mode !== 'floor' || this.place.area !== 'floor' || !o) {
      this.hud.toast('Workers, desks and props are on an office floor.', 2000);
      return;
    }
    const list = o.keyTargets(this.inOffice() && !this.walker.sitting);
    if (!list.length) return;
    const same = (a: Target, b: Target) => a.kind === b.kind && a.id === b.id;
    const here = this.target;
    const at = here ? list.findIndex((x) => same(x.target, here)) : -1;
    this.walker.applyTo(this.fpCam, this.walk.base);
    const eye = this.fpCam.position;
    let i = at >= 0 ? (at + dir + list.length) % list.length : 0;
    if (at < 0) {
      // Nothing aimed: the nearest, whichever way you cycle.
      let best = Infinity;
      list.forEach((x, n) => {
        const d = Math.hypot(x.at[0] - eye.x, x.at[2] - eye.z);
        if (d < best) [best, i] = [d, n];
      });
    }
    const pick = list[i];
    if (!pick) return;
    this.walker.lookToward(pick.at[0] - eye.x, pick.at[1] - eye.y, pick.at[2] - eye.z);
    this.walker.applyTo(this.fpCam, this.walk.base);
    const w = this.walker;
    this.keyTarget = { target: pick.target, session: o.session, pose: { x: w.x, z: w.z, yaw: w.yaw, pitch: w.pitch } };
    this.activity(true);
    this.updateLookAt();
  }

  // ---- M5: prompt, changes, quick replies, the next who needs you ----------------

  /** The looked-at worker's card shows its usage; P and C say why when they can't be used on it. */
  private lookAtM5(w: WorkerView | null): void {
    this.office?.setFocus(w?.worker.id ?? null);
    if (!w) return;
    // Every frame: only the floor's state, not a whole floor view.
    const fl = this.store.floors.get(w.worker.session);
    const f = fl ? { asleep: fl.state === 'asleep', transition: fl.transition ?? null } : null;
    const p = promptBlocker(w, f, this.unsupported.has('worker.prompt'));
    this.hud.setKeyState('P', p ? { live: false, why: p } : { live: true });
    const c = this.changesBlocker(w, f);
    this.hud.setKeyState('C', c ? { live: false, why: c } : { live: true });
    this.hud.setKeyState('answer', this.unsupported.has('worker.answer') ? { live: false, why: 'This herdr-world can’t answer questions yet. Update the bridge to use it.' } : null);
  }

  private changesBlocker(w: WorkerView, f: Pick<FloorView, 'asleep' | 'transition'> | null): string | null {
    if (this.unsupported.has('worker.changes')) return 'This herdr-world can’t show changes yet. Update the bridge to use it.';
    if (f?.asleep || f?.transition) return `${w.worker.session} is ${f.transition === 'waking' ? 'waking up' : f.transition === 'sleeping' ? 'going to sleep' : 'asleep'}: wake it from the elevator (L) first.`;
    if (!w.worker.cwd) return `${w.name} has no folder to look at.`;
    return null;
  }

  /** P: the prompt overlay for a worker (a toast says why when it can't take one). */
  openPrompt(id: string): void {
    const v = this.store.workerView(id);
    if (!v) return;
    const why = promptBlocker(v, this.store.floorView(v.worker.session), this.unsupported.has('worker.prompt'));
    if (why) {
      this.hud.toast(why, 3600);
      return;
    }
    this.walker.release();
    this.walker.stop();
    this.panels.close();
    this.prompt.open(id);
  }

  /** C: opens a worker's Changes panel; on the worker it shows (or none), closes it. */
  toggleChanges(id: string | null): void {
    if (this.changes.isOpen && (id === null || id === this.changes.worker)) {
      this.changes.close();
      return;
    }
    const v = id ? this.store.workerView(id) : null;
    if (!v) return;
    const why = this.changesBlocker(v, this.store.floorView(v.worker.session));
    if (why) {
      this.hud.toast(why, 3600);
      return;
    }
    this.walker.release();
    this.walker.stop();
    this.changes.open(v.worker.id);
  }

  /** A digit on a blocked worker: that choice of its question; 0 is Deny. */
  private answerKey(id: string, digit: number): void {
    const v = this.store.workerView(id);
    if (!v) return;
    // #57: an agent's structured question: a digit answers one that one pick answers; 0 dismisses it.
    const ask = v.display === 'needs_you' ? askOf(v.worker) : null;
    if (ask) {
      const q0 = ask.questions[0] as NonNullable<(typeof ask.questions)[0]>;
      if (digit !== 0 && !isSimple(ask)) {
        this.hud.toast(`${v.name} asks ${quickReplyBlocker(ask) === 'pick several' ? 'a question with several picks' : `${ask.questions.length} questions`}: sit at its laptop (E) and answer in the transcript view.`, 3600);
        return;
      }
      if (digit > q0.options.length) {
        this.hud.toast(`${v.name}’s question has ${q0.options.length === 1 ? 'one option: 1' : `options 1–${q0.options.length}`}; 0 dismisses it; to type an answer, sit at its laptop (E).`, 3200);
        return;
      }
      void this.answerAsk(id, ask, digit);
      return;
    }
    const q = v.display === 'needs_you' ? answerable(v.worker.question) : null;
    if (!q) {
      this.hud.toast(v.display === 'needs_you' ? `${v.name} needs you, but its screen showed no question to answer from here: sit at its laptop (E).` : `${v.name} isn’t asking anything right now.`, 3000);
      return;
    }
    const pick = digit === 0 ? answerKeys(q).deny : digitPick(q, digit);
    if (!pick) {
      const n = q.choices.length;
      this.hud.toast(n ? `${v.name}’s question has ${n === 1 ? 'one choice: 1' : `choices 1–${n}`}; 0 denies.` : `${v.name}’s question has no numbered choices: 0 dismisses it (Esc); to answer in words, sit at its laptop (E).`, 3000);
      return;
    }
    void this.answer(id, pick);
  }

  /** Answers a blocked worker's question (`worker.answer` with its hash); the result as a toast. */
  async answer(id: string, pick: AnswerPick): Promise<void> {
    const v = this.store.workerView(id);
    const q: Question | null = v?.display === 'needs_you' ? answerable(v.worker.question) : null;
    if (!v || !q) return;
    if (this.unsupported.has('worker.answer')) {
      this.hud.toast('This herdr-world can’t answer questions yet. Update the bridge to use it.', 4000, 'error');
      return;
    }
    if (this.answering.has(id)) {
      this.hud.toast(`Still answering ${v.name}…`, 1600);
      return;
    }
    const label = pickLabel(q, pick);
    this.answering.add(id);
    this.hud.toast(`Answering ${v.name}: ${label}…`, 2400);
    const r = await this.send('worker.answer', answerArgs(id, q, pick));
    this.answering.delete(id);
    const name = this.store.workerView(id)?.name ?? v.name;
    if (r.ok) {
      const ack = (r.data ?? {}) as Partial<AnswerAck>;
      if (ack.resolved === false) this.hud.toast(`Sent “${label}” to ${name}, but it is still waiting: look at its laptop (E).`, 4200);
      else this.hud.toast(`Answered ${name}: ${label}.`, 2600);
      return;
    }
    if (r.code === 'stale') {
      const now = this.store.workerView(id);
      const cur = now?.display === 'needs_you' ? answerable(now.worker.question) : null;
      this.hud.toast(cur ? `${name}’s question changed: now “${questionLine(cur)}”. Look at its card and answer again.` : `${name}’s question is gone: it is ${now ? now.display.replace('_', ' ') : 'no longer on the floor'}.`, 5200, 'error');
      return;
    }
    if (r.code === 'invalid_state') {
      this.hud.toast(`${name} isn’t waiting for an answer any more.`, 3200);
      return;
    }
    this.hud.toast(r.code === 'unknown_command' ? 'This herdr-world can’t answer questions yet. Update the bridge to use it.' : commandFailure('worker.answer', r.code, r.message, { worker: name }), 5200, 'error');
  }

  /** #57: answers a worker's ask from where you stand: option `digit` of its one question, 0 dismisses it. */
  private async answerAsk(id: string, ask: Ask, digit: number): Promise<void> {
    const v = this.store.workerView(id);
    if (!v) return;
    if (this.unsupported.has('worker.answer_ask')) {
      this.hud.toast('This herdr-world can’t answer questions from here yet: sit at its laptop (E) and answer in its terminal.', 4000, 'error');
      return;
    }
    if (this.answering.has(id)) {
      this.hud.toast(`Still answering ${v.name}…`, 1600);
      return;
    }
    const label = digit === 0 ? 'dismissed' : optionLabel(ask.questions[0]?.options[digit - 1]?.label ?? String(digit)).text;
    this.answering.add(id);
    this.hud.toast(digit === 0 ? `Dismissing ${v.name}’s question…` : `Answering ${v.name}: ${label}…`, 2400);
    const args: CommandArgs['worker.answer_ask'] = digit === 0 ? { id, tool_use_id: ask.tool_use_id, cancel: true } : { id, tool_use_id: ask.tool_use_id, answers: [{ question: 0, choices: [digit] }] };
    const r = await this.send('worker.answer_ask', args);
    this.answering.delete(id);
    const name = this.store.workerView(id)?.name ?? v.name;
    if (r.ok) {
      const ack = (r.data ?? {}) as Partial<AnswerAskAck>;
      if (ack.resolved === false) this.hud.toast(`Sent “${label}” to ${name}, but it has not recorded it yet: look at its laptop (E).`, 4200);
      else this.hud.toast(digit === 0 ? `Dismissed ${name}’s question.` : `Answered ${name}: ${label}.`, 2600);
      return;
    }
    if (r.code === 'stale') {
      const cur = askOf(this.store.workerView(id)?.worker);
      this.hud.toast(cur ? `${name} asks something else now: “${askLine(cur)}”. Look at its card and answer again.` : `${name}’s question was answered meanwhile.`, 5200, 'error');
      return;
    }
    this.hud.toast(r.code === 'unknown_command' ? 'This herdr-world can’t answer questions from here yet. Update the bridge to use it.' : commandFailure('worker.answer_ask', r.code, r.message, { worker: name }), 5200, 'error');
  }

  /** Every worker of the city, as N's queue and the inbox take them. */
  private needCandidates(): InboxCandidate[] {
    return this.store.city().flatMap((b) =>
      b.floors.flatMap((f) =>
        f.workers.map((w) => ({ id: w.worker.id, session: f.session, building: b.building?.id ?? null, display: w.display, since: w.since, desk: w.desk, name: w.name, role: crewRole(w.worker) })),
      ),
    );
  }

  /** Who needs you, in the order N visits them (blocked, then done; your building first). */
  needs(): NeedItem[] {
    const here = this.mode === 'floor' ? (this.building?.id ?? null) : undefined;
    return needQueue(this.needCandidates().map(({ role: _, ...w }) => w), here);
  }

  /** #100: who is in the inbox, in its list's order (needs you, then done; no building first; freelancers' done per Settings). */
  inboxItems(): NeedItem[] {
    return inboxQueue(this.needCandidates(), { freelancers: this.inboxPrefs.settings.freelancers, dismissed: this.store.inboxDismissed });
  }

  /** #100: the inbox list's rows. */
  private inboxEntries(): InboxEntry[] {
    return this.inboxItems().flatMap((item) => {
      const v = this.store.workerView(item.id);
      return v ? [{ id: item.id, name: item.name, harness: v.harness, where: inboxWhere(this.store, item.session), reason: inboxReason(v), blocked: item.reason === 'blocked', dismissable: item.reason === 'done', since: item.since }] : [];
    });
  }

  /**
   * #106: a finished row's ×: the bridge hides it for every browser until that worker's next working → done (the row
   * goes when `inbox.dismissed` comes back). Only a worker that is done now; a bridge from before #106 says so.
   */
  private async dismissInbox(id: string): Promise<void> {
    const v = this.store.workerView(id);
    if (v?.display !== 'done') return;
    const r = await this.send('inbox.dismiss', { id, status_since: v.since });
    if (!r.ok) this.hud.toast(r.code === 'unknown_command' ? 'This herdr-world can’t dismiss inbox rows yet. Update the bridge to use it.' : commandFailure('inbox.dismiss', r.code, r.message, { worker: v.name }), 5200, 'error');
  }

  /**
   * #106: a collapsed burst notification's click: shuts whatever modal is up first (as a single worker's does, through
   * `goToWorker`), then opens the inbox's list. Nothing when the whiteboard stays up asking about its changes.
   */
  private async openInboxList(): Promise<void> {
    if (await this.dismissOverlays()) this.inbox.openList();
  }

  /**
   * #100: an inbox row's (or a notification's) click. Unlike N it teleports: straight onto the worker's floor (no
   * elevator panel), facing it, and sat at its laptop with its conversation on screen (not the view E remembers),
   * from anywhere (`view`: 'terminal' puts the terminal on screen instead). False when it cannot be done (in a transition, the worker or its floor went). When the laptop
   * cannot be sat at, you are left facing the worker with the reason (`sitAt`'s toast), and it is still true.
   */
  async goToWorker(id: string, view: 'terminal' | 'transcript' = 'transcript'): Promise<boolean> {
    if (this.transitioning) return false;
    const was = this.store.workerView(id);
    if (!was) return false;
    // #106: going to a finished worker reads it: the episode (its `since` now) leaves the inbox once you are there.
    const finished = was.display === 'done' ? was.since : null;
    // A notification's click can come with any dialog up (the window was in the background): it goes first.
    if (!(await this.dismissOverlays()) || this.transitioning) return false;
    const session = this.store.workerView(id)?.worker.session;
    if (!session) return false;
    if (this.laptops.seated) this.laptops.stand(null, true);
    this.walker.release();
    this.walker.stop();
    this.pendingNeed = null;
    if (!(this.mode === 'floor' && this.place.area === 'floor' && this.office?.session === session)) await this.enterFloor(session);
    if (this.mode !== 'floor' || this.office?.session !== session) return false; // the floor went meanwhile
    if (this.planOpen) this.setPlan(false);
    this.faceWorker(id);
    // The conversation for this sit only: what E opens next time stays as you left it.
    if (this.sitAt(id)) {
      this.laptops.transcript.setMode(view, false);
      this.laptops.focusSeat();
    }
    if (finished !== null) void this.send('inbox.dismiss', { id, status_since: finished }); // #106 (an older bridge just ignores it)
    return true;
  }

  /**
   * #100: shuts every modal dialog and the whiteboard, each the way its own close does (Settings' fields as on Esc, the
   * elevator's pending confirm answered no, the whiteboard saved first), so a teleport never lands behind one. Resolves
   * once their `close` handlers ran: one hands focus back to its opener, and that must come before the seat takes it.
   * False when one stays up (the whiteboard asking what to do with changes it could not save).
   */
  private async dismissOverlays(): Promise<boolean> {
    const open = [...document.querySelectorAll<HTMLDialogElement>('dialog:modal')];
    // (A dialog torn down by its host's close may never say so: not waited for forever.)
    const closed = open.map((d) => new Promise<void>((done) => (d.addEventListener('close', () => done(), { once: true }), setTimeout(done, 500))));
    this.panels.close();
    this.prompt.close();
    if (this.overview.isOpen) this.overview.closeNow(); // #118
    for (const d of open) if (d.open) d.close();
    await Promise.all(closed);
    if (this.whiteboard.isOpen) await this.whiteboard.close();
    return !this.whiteboard.isOpen;
  }

  /**
   * N: the next worker who needs you. On this floor you are put facing it;
   * on another the elevator opens with that floor picked (you ride there, and
   * arrive facing it). Returns who it is (null: nobody needs you).
   */
  goNextNeed(): NeedItem | null {
    const item = nextNeed(this.needs(), this.lastNeed);
    if (!item) {
      this.lastNeed = null;
      this.hud.toast('Nobody needs you right now.', 2200);
      return null;
    }
    this.lastNeed = item.id;
    const v = this.store.workerView(item.id);
    const what = item.reason === 'blocked' ? 'needs you' : 'is done';
    const ask = v && item.reason === 'blocked' ? askOf(v.worker) : null;
    const q = v && item.reason === 'blocked' && !ask ? answerable(v.worker.question) : null;
    const about = ask ? `: asks “${askLine(ask)}”` : q ? `: “${questionLine(q)}”` : v ? `: ${v.worker.title?.trim() || v.worker.label}` : '';
    if (this.mode === 'floor' && this.place.area === 'floor' && this.office?.session === item.session) {
      this.pendingNeed = null;
      this.faceWorker(item.id);
      this.hud.toast(`${item.name} ${what}${about} · N: the next one`, 3600);
      return item;
    }
    // Another floor: the elevator, that floor picked (no teleporting between floors).
    this.pendingNeed = item;
    const level = this.store.floorView(item.session)?.level;
    const where = level ? `floor ${level.number} (${item.session})` : item.session;
    this.walker.release();
    this.walker.stop();
    this.panels.openElevator(this.panels.buildingOf(item.session), { session: item.session, note: `${item.name} ${what} on ${where}${about}. Enter rides there.` });
    return item;
  }

  /** Arrived by elevator: N's worker on this floor gets faced. */
  private afterTravel(session: string): void {
    const p = this.pendingNeed;
    if (!p || p.session !== session) return;
    this.pendingNeed = null;
    if (this.office?.session === session) this.faceWorker(p.id);
  }

  /** Stands you facing a worker of the floor you are on (behind its chair, else beside it, else across the desk). */
  faceWorker(id: string): boolean {
    const v = this.store.workerView(id);
    const o = this.office;
    if (!v || !o || o.session !== v.worker.session || this.loaded === null) return false;
    const slot = o.layout.slots[v.desk];
    if (!slot) return false;
    if (this.walker.sitting) this.walker.stand();
    const y = floorY(this.loaded);
    const spots = faceSpots(slot.seat, slot.yaw).filter((p) => !blocked({ x: p.x, z: p.z }, RADIUS, o.obstacles()) && !blocked3({ x: p.x, y, z: p.z }, RADIUS, this.walkWorldNow()));
    for (const p of spots) {
      this.setPose({ ...p, y });
      if (this.lookAt()?.id === id) return true;
    }
    const first = spots[0];
    if (first) this.setPose({ ...first, y });
    return false;
  }

  // ---- test hooks --------------------------------------------------------------

  /** Applies a protocol event as if the bridge had sent it. */
  inject(e: WorldEvent): void {
    this.onWorldEvent(e);
  }

  /** What E, P, C, X and the digits act on now (test hook). */
  targetInfo(): { kind: string; id: string; label: string; picked: boolean } | null {
    const t = this.target;
    return t ? { kind: t.kind, id: t.id, label: t.label, picked: this.keyTarget?.target === t } : null;
  }

  lookAt(): LookAt | null {
    if (this.mode !== 'floor') return null;
    this.walker.applyTo(this.fpCam, this.walk.base);
    const t = this.computeLookAt();
    if (!t) return null;
    const out: LookAt = { kind: t.kind, id: t.id, label: t.label };
    if (t.kind === 'worker' || t.kind === 'own-desk') out.name = t.name;
    return out;
  }

  // ---- the corner office (#20) -------------------------------------------------------

  /** Up on the mezzanine or high on its stair: look-at reaches the whole floor, cards read as nearer. */
  get overlooking(): boolean {
    return this.mode === 'floor' && this.place.area === 'floor' && this.loaded !== null && !!this.office && this.walker.y - floorY(this.loaded) > 1.5;
  }

  /** Inside the glass office on the mezzanine. */
  private inOffice(): boolean {
    const o = this.office;
    if (!o || this.loaded === null || this.place.area !== 'floor') return false;
    const m = o.layout.mezzanine;
    const w = this.walker;
    return w.y - floorY(this.loaded) > m.y - 0.1 && w.x > m.rect.x0 && w.x < m.rect.x1 && w.z > m.rect.z0 && w.z < m.rect.z1;
  }

  get seated(): boolean {
    return this.walker.sitting;
  }

  /** Sits you at your desk, facing the floor over the glass; false when you are not in your office. */
  sit(): boolean {
    const o = this.office;
    if (!o || this.loaded === null || !this.inOffice()) return false;
    const m = o.layout.mezzanine;
    this.walker.place(m.sit.x, m.sit.z, m.sit.yaw, m.sit.pitch, floorY(this.loaded) + m.y);
    this.walker.sit();
    this.cameraMoved = true;
    this.statusDirty = true;
    this.updateHint();
    this.activity(true);
    return true;
  }

  standUp(): void {
    if (!this.walker.sitting) return;
    this.walker.stand();
    this.updateHint();
    this.activity(true);
  }

  // ---- M5: sitting at a worker's laptop ----------------------------------------

  /** A watch the game makes by itself: like `send`, logged in `watchLog` instead of `sent`. */
  private async sendWatch<T extends WatchCommand>(t: T, args: CommandArgs[T]): Promise<CommandResult> {
    const entry: (typeof this.watchLog)[number] = { t, args };
    this.watchLog.push(entry);
    if (this.watchLog.length > 400) this.watchLog.shift();
    const r = await this.client.request(t, args);
    // An image is megabytes of base64: the log keeps whether it came, not what.
    entry.result = r.ok && (t === 'transcript.image' || t === 'transcript.images') ? { ok: true, data: null } : r;
    if (!r.ok && r.code === 'unknown_command') this.unsupported.add(t);
    return r;
  }

  /** E on a worker: sits you at its laptop; false (and a toast saying why) when you cannot. */
  sitAt(id: string): boolean {
    if (this.mode !== 'floor' || this.place.area !== 'floor' || this.transitioning) return false;
    const why = this.laptops.whyNot(id, this.office);
    if (why) {
      this.hud.toast(why, 3000);
      return false;
    }
    this.walker.release();
    this.walker.stop();
    this.walker.stand();
    this.laptops.sit(id, this.office, this.fpCam, this.walker);
    this.activity(true);
    return true;
  }

  /** Places the walker: `y` (feet, absolute) puts you on any floor, the fire escape, the street or in the lobby; without it you stay at your level. */
  setPose(p: Pose): void {
    let y = p.y;
    if (y === undefined) y = this.building ? (groundAt(this.walkWorldNow().supports, p.x, p.z, this.walker.y + 0.05) ?? this.walker.y) : this.walker.y;
    const ctx = this.building;
    if (ctx) {
      // Onto another floor: it gets the interior first, so its walls and desks are there.
      const next = placeAt({ x: p.x, y, z: p.z }, ctx.plan);
      if ((next.area === 'floor' || next.area === 'fire-escape') && next.storey !== null && next.storey !== this.loaded) this.loadFloor(next.storey);
    }
    this.walker.place(p.x, p.z, p.yaw, p.pitch ?? 0, y);
    this.updatePlace(false);
    this.walker.applyTo(this.fpCam, this.walk.base);
    this.cameraMoved = true;
    this.activity(true);
  }

  pose(): Pose & { eye: number; y: number; area: Area; storey: number | null; floor: string | null; seated: boolean } {
    const s = this.place.storey;
    return {
      x: this.walker.x,
      z: this.walker.z,
      yaw: this.walker.yaw,
      pitch: this.walker.pitch,
      eye: EYE_HEIGHT,
      y: this.walker.y,
      area: this.place.area,
      storey: s,
      floor: s !== null ? (this.building?.floors[s]?.session ?? null) : null,
      seated: this.walker.sitting,
    };
  }

  /** The building you walk around in (test hook). */
  get where(): { building: string | null; name: string; floors: string[]; loaded: string | null } | null {
    const b = this.building;
    return this.mode === 'floor' && b ? { building: b.id, name: b.name, floors: b.floors.map((f) => f.session), loaded: this.office?.session ?? null } : null;
  }

  /** The layout of a floor as walked: in its building's outline. */
  layoutOf(session: string): OfficeView['layout'] | null {
    const f = this.store.floorView(session);
    const ctx = f ? this.buildingFor(session) : null;
    return f ? floorLayoutIn(f.desks, ctx?.outline) : null;
  }

  /** The building plan you walk around in (test hook: the fire escape, the lobby, the street). */
  get plan3(): BuildingPlan | null {
    return this.mode === 'floor' ? (this.building?.plan ?? null) : null;
  }

  get cameraCity(): THREE.PerspectiveCamera {
    return this.cityCam;
  }

  get orbit(): OrbitControls {
    return this.controls;
  }

  get time(): number {
    return this.lastT;
  }

  /** Screen point (CSS px) of a floor itself in the city view (to click its building). */
  floorPoint(session: string): { x: number; y: number } | null {
    return this.mode === 'city' ? this.city.floorPoint(this.cityCam, session, this.vp) : null;
  }

  /** Lights of the office on screen: off on an asleep floor. */
  get officeAsleep(): boolean | null {
    return this.office?.isAsleep ?? null;
  }

  /** Screen point (CSS px) of a floor's badge in the city view. */
  badgePoint(session: string): { x: number; y: number } | null {
    return this.mode === 'city' ? this.city.badgePoint(this.cityCam, session, this.vp) : null;
  }
}

/** #124: the shortcut scope an aimed (or picked) target puts live: E means what you look at. */
function aimScope(t: Target): Scope | null {
  switch (t.kind) {
    case 'worker':
      return 'aim:worker';
    case 'desk':
      return 'aim:desk';
    case 'own-desk':
      return 'aim:own-desk';
    case 'board':
      return t.id === 'board.issues' || t.id === 'board.prs' ? 'aim:board' : null;
    case 'prop':
      return t.id === 'elevator' ? 'aim:elevator' : t.id === 'whiteboard' ? 'aim:whiteboard' : t.id === 'radio' ? 'aim:radio' : t.id === 'reception' ? 'aim:reception' : t.id === 'screen.overview' ? 'aim:overview' : null;
  }
}

const LOBBY_TARGETS: Record<'reception' | 'elevator', Target> = {
  reception: { kind: 'prop', id: 'reception', label: 'Reception', milestone: 'M3b' },
  elevator: { kind: 'prop', id: 'elevator', label: 'Elevator', milestone: 'M3' },
};

function zero(): Counts {
  return { working: 0, needsYou: 0, idle: 0, done: 0, waiting: 0, total: 0 };
}

/** Durable, so an installed app can start without the #token= URL; the helper's token survives its restarts. */
function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function reducedMotionTest(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
