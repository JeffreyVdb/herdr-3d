package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"reflect"
	"regexp"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"github.com/JeffreyVdb/herdr-3d/internal/activity"
	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
	"github.com/JeffreyVdb/herdr-3d/internal/codexaccount"
	"github.com/JeffreyVdb/herdr-3d/internal/digest"
	"github.com/JeffreyVdb/herdr-3d/internal/followup"
	"github.com/JeffreyVdb/herdr-3d/internal/gitops"
	"github.com/JeffreyVdb/herdr-3d/internal/handoff"
	"github.com/JeffreyVdb/herdr-3d/internal/handoffllm"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/manual/inputwatch"
	"github.com/JeffreyVdb/herdr-3d/internal/hireintent"
	"github.com/JeffreyVdb/herdr-3d/internal/hoststats"
	"github.com/JeffreyVdb/herdr-3d/internal/kaneoconf"
	"github.com/JeffreyVdb/herdr-3d/internal/limits"
	"github.com/JeffreyVdb/herdr-3d/internal/notify"
	"github.com/JeffreyVdb/herdr-3d/internal/packup"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/repodisc"
	"github.com/JeffreyVdb/herdr-3d/internal/runs"
	"github.com/JeffreyVdb/herdr-3d/internal/schedsuggest"
	"github.com/JeffreyVdb/herdr-3d/internal/shell"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
	"github.com/JeffreyVdb/herdr-3d/internal/whiteboard"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// ErrSlowConsumer is why a client whose send queue filled up was dropped.
var ErrSlowConsumer = errors.New("slow consumer")

// Options configure a Hub.
type Options struct {
	Manual             ManualHerdr
	ManualDir          string
	ManualShell        string
	ManualSnapshot     func(context.Context, string) (*herdr.Snapshot, error)
	ManualNoNewPrivs   func(context.Context, string) (bool, error)
	ManualEffectStatus func(context.Context) ([]byte, error)
	// #213: what the input detection reads (nil: inputwatch.System()) and
	// how often a running manual run is sampled (default
	// DefaultManualInputPoll).
	ManualInputProc inputwatch.Proc
	ManualInputPoll time.Duration
	Ring               int           // events kept for since_seq replay (default 4096)
	Queue              int           // per-client send queue, in messages (default 1024)
	MaxDesks           int           // cap on the desks a floor renders beyond its occupied ones (default DefaultMaxDesks)
	NameHold           time.Duration // how long a name stays held for a worker that left its floor, from when it left (default DefaultNameHold)
	Server             string        // version banner sent in welcome
	Log                *slog.Logger
	Now                func() time.Time // bridge clock for status_since and the name hold (default time.Now)

	// Herdr wakes floors and puts them to sleep (nil: floor.wake and
	// floor.sleep fail with internal).
	Herdr FloorHerdr
	// Sessions, if set, is the only set of sessions floor commands may act
	// on (the watcher's --sessions filter, checked again here).
	Sessions *regexp.Regexp
	// #58: UnitLoaded reports whether a transient user unit is loaded, the
	// last check before session.create starts herdr-s-<name>, and what a
	// wake waits on before it starts one (default: its unit file under
	// herdr.RuntimeDir).
	UnitLoaded func(unit string) bool
	// WakeTimeout bounds starting a woken server, its answering ping and
	// its floor being seen running, together (default DefaultWakeTimeout).
	WakeTimeout time.Duration
	// ResumeTimeout is how long a wake waits for the agents before the
	// fallback, and again for the fallback and its result; each bounds
	// every herdr call in it (default DefaultResumeTimeout).
	ResumeTimeout time.Duration
	// SleepTimeout bounds waiting for a stopped floor to be seen asleep
	// (default DefaultSleepTimeout).
	SleepTimeout time.Duration
	// ResumePoll is how often a wake looks at the panes' processes, and
	// ResumeSettle how long an agent process must keep running to count as
	// resumed (defaults 500 ms, 1.5 s).
	ResumePoll, ResumeSettle time.Duration
	// CodexSession finds the Codex session id of a cwd for the sleep
	// backfill, skipping ids already in use (nil: no backfill).
	CodexSession func(cwd string, skip func(id string) bool) (string, error)
	// RepoOf returns the GitHub owner/repo of a directory, or "" (nil: no
	// repo suggestions). It runs off the hub goroutine.
	RepoOf func(ctx context.Context, dir string) string
	// StatDir checks a default_cwd setting and a hire's cwd (default: an
	// existing directory).
	StatDir func(dir string) error

	// Hire hires workers and sends them home (nil: worker.hire and
	// worker.fire fail with internal).
	Hire HireHerdr
	// Git reads git state for hires and send-homes and runs their few git
	// commands (nil: no git info, no worktree hires or deletes).
	Git Git

	// M5 usage. Changes reads a worker's git changes for worker.changes
	// (nil: it fails with internal). Usage, if set, reads the workers'
	// agent transcripts for their usage (nil: no usage).
	Changes ChangesGit
	Usage   *UsageConfig
	// #136: Commands lists a worker's slash commands and skills for
	// worker.commands (nil: it fails with internal).
	Commands CommandCatalog
	// #137: Files ranks a worker's files for worker.files (nil: it fails
	// with internal).
	Files FileIndex
	// #138: Prompts rewrites a composer prompt for its worker's harness
	// (nil: prompts go as typed).
	Prompts PromptTranslator
	// #196: MCP answers mcp.inventory and mcp.check (*mcpinv.Service;
	// nil: they fail as unsupported). MCPClaudeDir is Claude Code's config
	// dir (the Claude cache key's home, shown as claude_config); MCPCodexHome
	// the Codex home of the default profile while no profile is listed.
	MCP          MCPInventory
	MCPClaudeDir string
	MCPCodexHome string
	// Caps are the worker caps (zero: DefaultCaps).
	Caps Caps
	// HireOptions, if set, replaces what can be hired (the harness catalogs).
	HireOptions *proto.HireOptions
	// Load reads the host load for hire.prepare (nil: none).
	Load func() *proto.HostLoad
	// HomeDir is a hire's cwd when neither it nor the floor names one
	// (default: the user's home directory).
	HomeDir string
	// BranchOf reads the branch checked out at a linked worktree (default
	// gitops.HeadBranch).
	BranchOf func(checkout string) string
	// TrustTimeout bounds answering an agent's trust dialog, and retrying
	// the first prompt (default DefaultTrustTimeout); SeenTimeout how long a
	// hire or send-home waits for the bridge to see the workspace appear or
	// go (default DefaultSeenTimeout); ExitTimeout how long an agent has to
	// exit when sent home (default DefaultExitTimeout).
	TrustTimeout, SeenTimeout, ExitTimeout time.Duration
	// #83: WrapUpTimeout is how long an armed wrap-up waits for its result
	// (default DefaultWrapUpTimeout), WrapUpDebounce how long the ended turn
	// and herdr's idle must hold before it is read (default
	// DefaultWrapUpDebounce).
	WrapUpTimeout, WrapUpDebounce time.Duration
	// #224: AgentHandoffTimeout is how long an agent handoff request waits
	// for its file and its turn's end (default DefaultAgentHandoffTimeout),
	// AgentHandoffGrace how long after the turn ended the file may still
	// appear (default DefaultAgentHandoffGrace).
	AgentHandoffTimeout, AgentHandoffGrace time.Duration
	// HirePoll is how often a hire or send-home looks at a pane, and
	// ExitPause the pause between Codex's /quit and Enter (defaults 250 ms,
	// 400 ms).
	HirePoll, ExitPause time.Duration

	// M5 term: the laptops.
	// Term watches panes and types into them (nil: the laptop commands
	// fail with internal, no questions are read).
	Term TermHerdr
	// PaneSize is a pane's size in cells, the observer's default size
	// (nil or not ok: 120 × 40).
	PaneSize func(ctx context.Context, socket, pane string) (cols, rows int, ok bool)
	// Fresh reads a floor's workspaces from herdr right now (a
	// session.snapshot), not from the hub's last observation: the check
	// before the bridge closes a repository's idle main checkout. Nil: it
	// cannot be checked and nothing is closed.
	Fresh func(ctx context.Context, socket string) ([]world.WorkerObs, error)
	// #74: PaneState is a pane's size and what its tab does with it (zoomed,
	// focused, how many panes), read from the session's snapshot (nil: the
	// size from PaneSize, and no fullscreen laptops). ZoomPoll is how often
	// a followed watch looks again (default DefaultZoomPoll).
	PaneState func(ctx context.Context, socket, pane string) (herdr.PaneState, bool)
	ZoomPoll  time.Duration
	// #176: PaneScroll reads where a pane's view is in herdr's history
	// (pane.get; nil: a controlled laptop gets no terminal.history).
	// HistoryPoll is how often a view above the live bottom is read again
	// (default DefaultHistoryPoll).
	PaneScroll  func(ctx context.Context, socket, pane string) (herdr.PaneScroll, bool)
	HistoryPoll time.Duration
	// MaxWatches caps the watches of one connection, MaxObservers all of
	// them (defaults DefaultMaxWatches, DefaultMaxObservers).
	MaxWatches, MaxObservers int
	// FirstFrame bounds a new observer's wait for its first frame, and
	// ObserverBackoff is the first wait before restarting a failed one
	// (defaults DefaultFirstFrame, DefaultObserverBackoff).
	FirstFrame, ObserverBackoff time.Duration
	// QuestionPoll is how often a blocked worker's screen is read again,
	// AnswerTimeout how long worker.answer waits for it to leave blocked,
	// PromptRetryWait how long worker.prompt waits after pressing Enter
	// again (defaults DefaultQuestionPoll, DefaultAnswerTimeout,
	// DefaultPromptRetryWait).
	QuestionPoll, AnswerTimeout, PromptRetryWait time.Duration
	// #95: PromptReadyWait is how long a prompt to Claude waits for the
	// agent to be ready before it is typed, PromptAckWait how long it then
	// waits for the agent to start working before Enter is pressed again
	// (defaults DefaultPromptReadyWait, DefaultPromptAckWait).
	PromptReadyWait, PromptAckWait time.Duration
	// #57: AskStepTimeout is how long worker.answer_ask waits for the
	// dialog to show each step, AskResolveTimeout how long for the
	// transcript to record the answer (defaults DefaultAskStepTimeout,
	// DefaultAskResolveTimeout).
	AskStepTimeout, AskResolveTimeout time.Duration

	// M16 transcript: MaxTranscriptWatches caps the transcript watches of
	// one connection (default DefaultMaxTranscriptWatches), TranscriptFlush
	// is the least time between two pushes of a watch (default
	// DefaultTranscriptFlush). Transcripts are read with Usage (nil: none).
	MaxTranscriptWatches int
	TranscriptFlush      time.Duration

	// M6 runs.
	// RunsDir is write-code's runs directory, where the freelancers'
	// reports are (<RunsDir>/<h3d_run>/<h3d_report>; "": no reports), and
	// ReportPoll how often they are looked at (default DefaultReportPoll).
	RunsDir    string
	ReportPoll time.Duration
	// RunLaunch finds the ticket of an orchestrator the game started (an
	// issue, or #184 a provider's item), from its run_launch record
	// (default: the store's).
	RunLaunch func(ctx context.Context, workerID string) (runs.Launch, bool)

	// M7 boards.
	// Boards finds the issue tracker and the code host of a floor's link
	// (nil: no boards). The server never imports a provider.
	Boards BoardFactory
	// PRGit is the git of worker.open_pr: reads and the push (nil:
	// worker.open_pr.prepare and worker.open_pr fail with unsupported).
	PRGit PRGit
	// BoardWatchPoll and BoardIdlePoll are how often a floor is polled with
	// and without a watcher, BoardRefreshMin the shortest time between the
	// polls board.refresh starts on one floor, BoardTick how often the
	// poller looks for a floor that is due (defaults DefaultBoardWatchPoll,
	// DefaultBoardIdlePoll, DefaultBoardRefreshMin, DefaultBoardTick).
	BoardWatchPoll, BoardIdlePoll, BoardRefreshMin, BoardTick time.Duration

	// M10 limits: reads the Claude and Codex plan limits while a client is
	// connected (nil: none, and limits.refresh fails with unsupported).
	Limits *limits.Config

	// M13 screen share (screen.go).
	// ScreenDir is where grabbed frames are stored, a private directory on
	// tmpfs ("": none, and screen.grab fails with internal). ScreenTimeout
	// bounds a grab's wait for its frame (default DefaultScreenTimeout),
	// ScreenTTL how long a frame is kept (default screenshare.DefaultTTL),
	// ScreenSweep how often expired ones are removed (default
	// screenshare.DefaultSweep).
	ScreenDir                             string
	ScreenTimeout, ScreenTTL, ScreenSweep time.Duration
	// #108 prompt secrets (promptsecrets.go): SecretsDir is the private
	// directory protected files go to ("": none, and a review that protects
	// anything fails with secrets_unavailable). SecretScanTimeout bounds a
	// scan or a review's writes (default DefaultSecretScanTimeout),
	// SecretsSweep how often the janitor reconciles the files with the
	// workers (default DefaultSecretsSweep), SecretReuseTTL how long a sent
	// review's files serve its identical retry (default
	// DefaultSecretReuseTTL), and (round 2) SecretPendingTTL how long a
	// pending owner's files wait for the worker a hire or a preview's
	// follow-up gives them to (default DefaultSecretPendingTTL).
	SecretsDir                                                        string
	SecretScanTimeout, SecretsSweep, SecretReuseTTL, SecretPendingTTL time.Duration
	// M13 whiteboard: the floors' boards (nil: the whiteboard commands and
	// routes fail with unsupported), and Drop Zone's data directory for
	// drops.list ("": drops_unavailable).
	Whiteboards *whiteboard.Store
	DropsRoot   string

	// #223 handoffs: the filing cabinet (nil: the handoff commands fail
	// with unsupported, workers have no handoff candidate and the snapshot
	// has no handoffs).
	Handoffs *handoff.Service

	// #92 AI integration: the classification model and the LLM (nil: the
	// ai.* commands fail with unsupported, the snapshot has no ai).
	AI *ai.Service
	// #184: the Kaneo connection (nil: the kaneo.* commands fail with
	// unsupported, the snapshot has no kaneo, and no floor gets a Kaneo
	// board).
	Kaneo *kaneoconf.Service
	// #54: repository discovery (nil: the repo_discovery.* commands fail
	// with unsupported, the snapshot has no repo_discovery, and
	// worker.repos lists the floors only). NewHub configures it from the
	// stored settings.
	RepoDiscovery *repodisc.Service
	// #138: the Codex profiles (nil: the codex_profiles.* commands fail
	// with unsupported and the snapshot has no codex_profiles). NewHub
	// configures it from the stored settings. Limits.Accounts is the same
	// service when the limits are read per profile.
	CodexProfiles *codexaccount.Service
	// #139: CodexPrepare is a test hook in place of CodexProfiles.Prepare
	// (nil: the service's).
	CodexPrepare func(ctx context.Context, key string) (env []string, release func(), err error)
	// #90 follow-up questions: FollowupsEnabled is the environment's toggle
	// (HERDR_WORLD_FOLLOWUPS_ENABLED; nil: not set), FollowupDebounce how
	// long an ended turn and herdr's not-working status hold before the
	// message is looked at (default DefaultFollowupDebounce), FollowupRoles
	// the models (default AI; tests pass fakes).
	FollowupsEnabled *bool
	FollowupDebounce time.Duration
	FollowupRoles    followup.Roles
	// #66 schedule suggestions: ScheduleSuggestionsEnabled is the
	// environment's toggle (HERDR_WORLD_SCHEDULE_SUGGESTIONS_ENABLED; nil:
	// not set), ScheduleSuggestRoles the models (default FollowupRoles, then
	// AI; tests pass fakes). They look at the follow-up questions' turn ends
	// (FollowupDebounce).
	CommandRequestsEnabled     *bool
	ScheduleSuggestionsEnabled *bool
	ScheduleSuggestRoles       schedsuggest.Roles
	// #110 pack up on request: PackupEnabled is the environment's toggle
	// (HERDR_WORLD_PACKUP_ENABLED; nil: not set), PackupTimeout bounds a
	// packup.detect's models (default packup.DetectTimeout), PackupRoles the models
	// (default AI; tests pass fakes).
	PackupEnabled *bool
	PackupTimeout time.Duration
	PackupRoles   packup.Roles
	// #211 dictated hiring: HireIntentRoles the LLM and classifier (#190)
	// of hire.interpret (default AI; tests pass fakes), HireIntentTimeout its
	// bound (default hireintent.DefaultTimeout).
	HireIntentRoles   hireintent.Roles
	HireIntentTimeout time.Duration
	// #95 hire_preset.check: HirePresetRoles the classifier (default AI;
	// tests pass fakes), HirePresetCheckTimeout its bound (default
	// hirePresetCheckTimeout).
	HirePresetRoles        HirePresetRoles
	HirePresetCheckTimeout time.Duration
	// #98 activity: ActivityModel is the environment's "Classify unknown
	// commands" toggle (HERDR_WORLD_ACTIVITY_MODEL; nil: not set),
	// ActivityThrottle the least time between two worker.activity events of
	// a worker (default DefaultActivityThrottle), ActivityRoles the
	// classifier (default AI; tests pass fakes).
	ActivityModel    *bool
	ActivityThrottle time.Duration
	ActivityRoles    activity.Roles
	// #118 phase 2 floor overview summaries: DigestEnabled is the
	// environment's toggle (HERDR_WORLD_DIGEST_ENABLED; nil: not set),
	// DigestSettle how long after a turn ended its now line waits (default
	// DefaultDigestSettle), DigestGap the least time between two now lines
	// of a worker (default DefaultDigestGap), DigestRoles the LLM (default
	// AI; tests pass fakes). #174: DigestRetry is how long after a task
	// line's n-th failed attempt the next goes, and (#198) after a now line's
	// n-th failure in a row its newer steps may (default digest.RetryDelay:
	// growing, ok false once the attempts are used up).
	DigestEnabled *bool
	DigestSettle  time.Duration
	DigestGap     time.Duration
	DigestRoles   digest.Roles
	DigestRetry   func(n int) (time.Duration, bool)
	// #9 LLM handoffs: HandoffLLMEnabled is the environment's toggle
	// (HERDR_WORLD_HANDOFF_LLM_ENABLED; nil: not set), HandoffLLMRoles the
	// LLM (default AI; tests pass fakes), HandoffReduce the transcript
	// reducer (default handoffllm.Reduce; tests pass fakes).
	HandoffLLMEnabled *bool
	HandoffLLMRoles   handoffllm.Roles
	HandoffReduce     func(ctx context.Context, in handoffllm.Input) (handoffllm.Payload, error)

	// #11 notifications: NotifyChannel is where messages go (the app's
	// Telegram channel; nil: none, the notify.* commands fail with
	// unsupported and the snapshot has no notify), NotifyEnabled the
	// environment's switch (HERDR_WORLD_NOTIFY_ENABLED; nil: not set),
	// NotifySettle how long a done waits (default notify.DefaultSettle),
	// NotifyClock the service's clock (default the wall clock; tests pass a
	// fake).
	NotifyChannel notify.Channel
	NotifyEnabled *bool
	NotifySettle  time.Duration
	NotifyClock   notify.Clock
	// NotifyLimits is the outbound budget (#106; nil: notify's defaults).
	NotifyLimits *notify.Limits

	// #155 shared Codex server: CodexRun is the private directory of the
	// shared launches' launchers and sockets ("" or no CodexHost: the switch
	// cannot be turned on), CodexHost their checks, files, processes and
	// protocol adapter (NewCodexHost; tests pass a fake), CodexPoll how
	// often the shared servers and the bridge's joins are looked at
	// (default DefaultCodexPoll), CodexStartTimeout how long a started
	// server has to answer (default DefaultCodexStartTimeout). #156:
	// CodexRejoin is how long a join that gave up after its retries waits
	// before it is tried again (default DefaultCodexRejoin).
	CodexRun          string
	CodexShell        shell.Kind // #68: the launchers' shell (default bash); Control's policy
	CodexHost         CodexHost
	CodexPoll         time.Duration
	CodexStartTimeout time.Duration
	CodexRejoin       time.Duration

	// #62 scheduled agents: ScheduleTick is how often the runner looks at
	// the wall clock (Now) for due schedules (default DefaultScheduleTick).
	ScheduleTick time.Duration

	// #74 server rack: HostStatsPoll is how often CPU, memory and updates
	// are sampled while a connection watches (default
	// hoststats.DefaultStatsEvery, 5 s). HostStats says how the host is
	// read (nil: the real /proc, /sys and clock, and pending updates
	// through checkupdates on a supported host; tests pass fixture roots, a
	// fake clock and a fake runner).
	HostStatsPoll time.Duration
	HostStats     *hoststats.Config

	// #22 native child agents: ChildSources report the workers' native
	// children (Claude's #23 and Codex's #25 in production; tests pass
	// childagentstest.FixtureSource).
	ChildSources []childagents.Source
	// #27: CodexChildren observes a shared worker's child threads through
	// the bridge's join of its root thread (codexchild.Source, also one of
	// ChildSources; nil: not observed).
	CodexChildren CodexChildren
}

// DefaultMaxDesks is the default Options.MaxDesks.
const DefaultMaxDesks = 96

// DefaultNameHold is the default Options.NameHold.
const DefaultNameHold = 7 * 24 * time.Hour

// minDesks is the fewest desks a floor renders; spareDesks how many free
// desks it keeps beyond its workers (within MaxDesks).
const (
	minDesks   = 6
	spareDesks = 2
)

// Hub owns the world model. A single goroutine (Run) applies watcher
// observations and client commands, persists through the store, assigns
// event sequence numbers and fans events out to clients. Nothing it does
// blocks on a client: a client that cannot keep up is dropped.
type Hub struct {
	manualProcesses map[string]proto.ManualProcess
	manualOrder     map[string]uint64
	manualNext      uint64
	manualLocks     map[string]*sync.Mutex
	manualStopBusy  map[string]bool
	manualPolling   bool
	manualCleanups  map[string]manualCleanupLink
	mi              manualInput // #213
	opts            Options
	log             *slog.Logger
	st              *store.Store
	epoch           string
	updates         chan world.Update
	ops             chan func(context.Context)
	done            chan struct{} // closed when Run stops processing operations, before waiting for background tasks

	seq     uint64
	ring    *ring
	clients map[*Client]struct{}

	buildings map[string]store.Building
	assign    map[string]store.Assignment     // by floor id
	floors    map[string]*floorState          // by floor id (#58): real floors and the virtual floors of discovered sessions
	vfloors   map[string]store.VirtualFloor   // #58: the virtual floor definitions, by id (mirrors virtual_floor)
	hidden    map[string]bool                 // #58: floor id → hidden (mirrors floor_hidden)
	workers   map[string]*proto.Worker        // by worker id
	saved     map[string]savedWorker          // what the store last got, by worker id
	desks     map[string]map[string]int       // floor → worker id → desk index (mirrors desk_assignment)
	names     map[string]map[string]nameClaim // floor → name → claim (mirrors worker_name)

	viewBuildings map[string]proto.Building
	viewFloors    map[string]proto.Floor

	settings map[string]store.FloorSettings // by floor id (mirrors floor_repo)
	lastHire map[string]store.Hire          // by floor id (mirrors floor_hire_last)
	branches map[string]branchRead          // checkout path → its branch, read recently
	resume   map[string]string              // worker id → resume state, during and after a wake
	rescan   chan struct{}                  // asks the watcher to look at sessions now
	creating map[string]*createOp           // #58: session.create in progress, by name
	suggest  chan suggestJob                // repo lookups for the suggester
	wg       sync.WaitGroup                 // floor operations and the suggester

	usage map[string]*proto.Usage // M5 usage: by worker id, as last published
	// H3D-2: the transcript session each usage was read from (usageFor), and
	// the model and effort the hire record, tokens or hire op reported for
	// each worker, kept apart from the model and effort its transcript
	// observed (usage): the view merges them (shownModel), the store and
	// metaOf only ever see the reported ones.
	usageFor map[string]usageTag
	reported map[string]modelEffort
	// M5 term
	credentials        map[string]*credentialRequest
	credentialAttempts map[string]int
	credentialTimeout  time.Duration
	term               termWatches              // laptop screens being watched
	zoom               zoomTabs                 // #74: the tabs zoomed for them
	lanes              map[string]*inputLane    // worker id → its input commands, in order
	questions          map[string]questionState // worker id → what its blocked screen asks
	calls              map[string]workerCalls   // #106: worker id → the calls its transcript waits on
	asking             map[string]bool          // worker id → its screen reader runs
	// #57: worker id → its ask as last published, and the last ask call
	// whose result its transcript recorded.
	asks        map[string]*proto.Ask
	askResolved map[string]string
	// #95: worker id → the prompts typed into it lately (fingerprints), and
	// how often herdr saw it start working or get blocked.
	typed  map[string][]typedNote
	starts map[string]uint64
	// #95 R1: worker id → EraseTyped's count for a prompt partly typed
	// into its input box that could not be erased.
	dirty map[string]int
	// M6 launch
	presets    map[string]store.Preset // by id (mirrors team_preset)
	lastPreset map[string]string       // floor id → preset id (mirrors floor_preset_last)
	runPending map[string]bool         // orchestrators of launches whose run id is not known yet

	runs runsState // M6 runs

	// M16 transcript
	tx        txWatches     // transcripts being watched
	usageKick chan struct{} // asks the usage tracker for a round now

	boards boardsState // M7 boards

	// M10 limits
	limits       map[string]proto.Limits // by limitsKey (provider, Codex profile), as last published
	limitsPoller *limits.Poller
	cp           codexProfilesState // #138 Codex profiles
	nclients     atomic.Int32       // len(clients), for the poller

	screen screenState // M13 screen share

	wrapups map[string]*wrapUp // #83: by worker id

	dismissed map[string]int64 // #106: inbox dismissals, worker id → status_since

	fu  followupState // #90 follow-up questions
	cr  commandRequestState
	ss  suggestState      // #66 schedule suggestions
	ho  handoffState      // #223 handoffs
	ah  agentHandoffState // #224 agent handoff requests
	llm llmHandoffState   // #9 LLM handoffs
	pk  packupState       // #110 pack up on request
	kn  kaneoState        // #184 Kaneo

	act activityHub // #98 activity

	// #118: worker id → its transcript's digest (the overview's lines come
	// from it; phase 2's summarizer reads it).
	dg  map[string]*transcript.Digest
	dgs digestHub // #118 phase 2: floor overview summaries

	cx codexState  // #155 shared Codex server
	nt notifyState // #11 notifications

	rr  repoRefsState      // #247 repositories on other floors
	ps  promptSecretsState // #108 prompt secrets
	rd  repoDiscState      // #54 repository discovery
	sc  scheduleState      // #62 scheduled agents
	hs  hostState          // #74 server rack
	ch  childState         // #22 native child agents
	mcp mcpState           // #196 MCP & skills: worker observations

	hirePresets map[string]store.HirePreset // #93: by id (mirrors hire_preset)
}

// sessionState is what the floors of one herdr session share (#58): its
// real floor and its virtual floors have one running state, one wake or
// sleep, one observation, and one set of hires and send-homes in flight
// (each op names its floor).
type sessionState struct {
	session string
	running bool
	def     bool
	err     string
	gen     uint64
	socket  string
	byWS    map[string]string // workspace id → worker id, over the session
	all     []string          // every worker id of the session, in herdr's sidebar order

	op        *floorOp           // wake or sleep in progress
	hires     map[string]*hireOp // hires in flight, by worker id
	fires     map[string]*fireOp // send-homes in flight, by worker id
	last      []world.WorkerObs  // the workers last observed (a hire re-applies them)
	looked    bool               // #108 round 5: the last observation showed the session running, workers and all
	origins   map[string]string  // cwd → GitHub repo, from the suggester
	askedCwds []string           // cwds of the last repo lookup
	askedAt   time.Time
}

// floorState is one floor: a session's real floor (id == session) or a
// virtual floor on it (#58). The session's state is shared.
type floorState struct {
	*sessionState
	id        string
	virtual   bool
	order     []string // this floor's worker ids in herdr's sidebar order
	suggested *proto.Suggested
}

type savedWorker struct {
	workspaceID, label string
	fps                map[store.Fingerprint]bool
	meta               workerMeta
}

// workerMeta is what the bridge keeps with a worker beyond what herdr
// currently shows: the last known harness, model and effort, and since
// when (unix ms) it has had its status.
// modelEffort is a model and an effort as one source says them ("": unknown).
type modelEffort struct{ model, effort string }

type workerMeta struct {
	harness, model, effort string
	status                 string
	statusSince            int64
	hiredAt                int64
	floor                  string // #58: the floor id it belongs to
	// M6 runs: an orchestrator's last known phase and pass.
	phase   string
	pass    int
	passSet bool
}

// branchRead is a linked worktree's branch as read at.
type branchRead struct {
	branch string
	at     time.Time
}

// nameClaim is who owns a name on a floor.
type nameClaim struct {
	owner    string    // worker id
	released time.Time // when the owner was seen leaving the floor; zero while it is on it
}

// Client is one connected protocol client, as seen by the hub.
type Client struct {
	name string
	send chan []byte
	kick func(error) // closes the connection; never blocks
}

// NewClient makes a client with a bounded send queue. kick is called (at
// most once per reason, from the hub goroutine) to disconnect it.
func (h *Hub) NewClient(name string, kick func(error)) *Client {
	return &Client{name: name, send: make(chan []byte, h.opts.Queue), kick: kick}
}

// Send is the client's outgoing queue.
func (c *Client) Send() <-chan []byte { return c.send }

// NewHub loads buildings and floor assignments from st.
func NewHub(ctx context.Context, st *store.Store, opts Options) (*Hub, error) {
	if opts.Ring <= 0 {
		opts.Ring = 4096
	}
	if opts.Queue <= 0 {
		opts.Queue = 1024
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.MaxDesks <= 0 {
		opts.MaxDesks = DefaultMaxDesks
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.NameHold <= 0 {
		opts.NameHold = DefaultNameHold
	}
	if opts.WakeTimeout <= 0 {
		opts.WakeTimeout = DefaultWakeTimeout
	}
	if opts.ResumeTimeout <= 0 {
		opts.ResumeTimeout = DefaultResumeTimeout
	}
	if opts.SleepTimeout <= 0 {
		opts.SleepTimeout = DefaultSleepTimeout
	}
	if opts.ResumePoll <= 0 {
		opts.ResumePoll = defaultResumePoll
	}
	if opts.ResumeSettle <= 0 {
		opts.ResumeSettle = defaultResumeSettle
	}
	if opts.StatDir == nil {
		opts.StatDir = isDir
	}
	if opts.Caps == (Caps{}) {
		opts.Caps = DefaultCaps
	}
	if opts.HomeDir == "" {
		opts.HomeDir = homeDir()
	}
	if opts.BranchOf == nil {
		opts.BranchOf = gitops.HeadBranch
	}
	if opts.TrustTimeout <= 0 {
		opts.TrustTimeout = DefaultTrustTimeout
	}
	if opts.SeenTimeout <= 0 {
		opts.SeenTimeout = DefaultSeenTimeout
	}
	if opts.ExitTimeout <= 0 {
		opts.ExitTimeout = DefaultExitTimeout
	}
	if opts.WrapUpTimeout <= 0 {
		opts.WrapUpTimeout = DefaultWrapUpTimeout
	}
	if opts.WrapUpDebounce <= 0 {
		opts.WrapUpDebounce = DefaultWrapUpDebounce
	}
	if opts.AgentHandoffTimeout <= 0 { // #224
		opts.AgentHandoffTimeout = DefaultAgentHandoffTimeout
	}
	if opts.AgentHandoffGrace <= 0 {
		opts.AgentHandoffGrace = DefaultAgentHandoffGrace
	}
	if opts.FollowupDebounce <= 0 {
		opts.FollowupDebounce = DefaultFollowupDebounce
	}
	if opts.ActivityThrottle <= 0 {
		opts.ActivityThrottle = DefaultActivityThrottle
	}
	if opts.DigestSettle <= 0 { // #118
		opts.DigestSettle = DefaultDigestSettle
	}
	if opts.DigestRetry == nil {
		opts.DigestRetry = digest.RetryDelay
	}
	if opts.DigestGap <= 0 {
		opts.DigestGap = DefaultDigestGap
	}
	if opts.HirePoll <= 0 {
		opts.HirePoll = defaultHirePoll
	}
	if opts.ExitPause <= 0 {
		opts.ExitPause = defaultExitPause
	}
	if opts.ScheduleTick <= 0 { // #62
		opts.ScheduleTick = DefaultScheduleTick
	}
	termDefaults(&opts)  // M5 term
	runsDefaults(&opts)  // M6 runs
	boardDefaults(&opts) // M7 boards
	var epoch [8]byte
	_, _ = rand.Read(epoch[:])
	h := &Hub{
		opts:            opts,
		manualProcesses: map[string]proto.ManualProcess{},
		manualOrder:     map[string]uint64{},
		manualLocks:     map[string]*sync.Mutex{},
		manualStopBusy:  map[string]bool{},
		manualCleanups:  map[string]manualCleanupLink{},
		log:             opts.Log,
		st:              st,
		epoch:           hex.EncodeToString(epoch[:]),
		updates:         make(chan world.Update, 256),
		ops:             make(chan func(context.Context), 64),
		done:            make(chan struct{}),
		ring:            newRing(opts.Ring),
		clients:         map[*Client]struct{}{},
		floors:          map[string]*floorState{},
		vfloors:         map[string]store.VirtualFloor{},
		hidden:          map[string]bool{},
		workers:         map[string]*proto.Worker{},
		saved:           map[string]savedWorker{},
		desks:           map[string]map[string]int{},
		names:           map[string]map[string]nameClaim{},
		viewBuildings:   map[string]proto.Building{},
		viewFloors:      map[string]proto.Floor{},
		resume:          map[string]string{},
		branches:        map[string]branchRead{},
		rescan:          make(chan struct{}, 1),
		creating:        map[string]*createOp{},
		suggest:         make(chan suggestJob, 256),
		usage:           map[string]*proto.Usage{},
		usageFor:        map[string]usageTag{},
		reported:        map[string]modelEffort{},
		limits:          map[string]proto.Limits{},
		limitsPoller:    newLimitsPoller(opts.Limits),
		dg:              map[string]*transcript.Digest{},
		mcp:             mcpState{obs: map[string]*mcpObs{}},
	}
	h.initManualInput() // #213
	if err := h.initManualProcesses(ctx); err != nil {
		return nil, err
	}
	h.initTerm()        // M5 term
	h.initTranscripts() // M16 transcript
	h.initRuns()        // M6 runs
	h.initScreen()      // M13 screen
	h.initHostStats()   // #74 server rack
	if h.opts.RunLaunch == nil {
		h.opts.RunLaunch = storeRunLaunch(st, h.log)
	}
	if err := h.reload(ctx); err != nil {
		return nil, err
	}
	var err error
	if err := h.loadVirtualFloors(ctx); err != nil { // #58
		return nil, err
	}
	if h.settings, err = st.FloorSettings(ctx); err != nil {
		return nil, err
	}
	if h.lastHire, err = st.LastHires(ctx); err != nil {
		return nil, err
	}
	if err := h.loadLaunch(ctx); err != nil { // M6 launch
		return nil, err
	}
	if err := h.loadWrapUps(ctx); err != nil { // #83
		return nil, err
	}
	if err := h.loadInbox(ctx); err != nil { // #106
		return nil, err
	}
	if err := h.initFollowups(ctx); err != nil { // #90
		return nil, err
	}
	h.initCommandRequests()
	if err := h.initScheduleSuggestions(ctx); err != nil { // #66
		return nil, err
	}
	if err := h.initHandoffs(ctx); err != nil { // #223
		return nil, err
	}
	if err := h.loadAgentHandoffs(ctx); err != nil { // #224
		return nil, err
	}
	if err := h.initHandoffLLM(ctx); err != nil { // #9
		return nil, err
	}
	if err := h.initPackup(ctx); err != nil { // #110
		return nil, err
	}
	if err := h.initActivity(ctx); err != nil { // #98
		return nil, err
	}
	if opts.CodexPoll <= 0 { // #155
		h.opts.CodexPoll = DefaultCodexPoll
	}
	if opts.CodexStartTimeout <= 0 {
		h.opts.CodexStartTimeout = DefaultCodexStartTimeout
	}
	if opts.CodexRejoin <= 0 { // #156
		h.opts.CodexRejoin = DefaultCodexRejoin
	}
	if err := h.initCodex(ctx); err != nil { // #155
		return nil, err
	}
	if err := h.initRepoRefs(ctx); err != nil { // #247
		return nil, err
	}
	if err := h.initPromptSecrets(ctx); err != nil { // #108
		return nil, err
	}
	if err := h.initRepoDiscovery(ctx); err != nil { // #54
		return nil, err
	}
	if err := h.initCodexProfiles(ctx); err != nil { // #138
		return nil, err
	}
	if err := h.initDigest(ctx); err != nil { // #118
		return nil, err
	}
	if err := h.initNotify(ctx); err != nil { // #11
		return nil, err
	}
	if err := h.initBoards(ctx); err != nil { // M7 boards
		return nil, err
	}
	h.ch = childState{reg: childagents.New()}    // #22
	if err := h.loadSchedules(ctx); err != nil { // #62
		return nil, err
	}
	if err := h.loadHirePresets(ctx); err != nil { // #93
		return nil, err
	}
	desks, err := st.Desks(ctx)
	if err != nil {
		return nil, err
	}
	for _, d := range desks {
		h.floorDesks(d.Floor)[d.WorkerID] = d.Index
	}
	names, err := st.Names(ctx)
	if err != nil {
		return nil, err
	}
	for _, c := range names {
		h.floorNames(c.Floor)[c.Name] = nameClaim{owner: c.WorkerID, released: c.Released}
	}
	for _, b := range h.buildingViews() {
		h.viewBuildings[b.ID] = b
	}
	return h, nil
}

// Epoch identifies this hub instance; since_seq is only valid within one.
func (h *Hub) Epoch() string { return h.epoch }

// Updates is where watchers send observations.
func (h *Hub) Updates() chan<- world.Update { return h.updates }

// Rescans signals when the watcher should look at sessions right away
// (watch.Config.Rescan).
func (h *Hub) Rescans() <-chan struct{} { return h.rescan }

// Run processes updates and client operations until ctx is done. Floor
// operations still running end with ctx before it returns.
func (h *Hub) Run(ctx context.Context) error {
	defer h.closePromptSecrets() // #108: once nothing uses the files
	defer h.wg.Wait()
	// Background tasks can query the hub (e.g. secrets cleanup reads live
	// workers). Release those queries once the event loop stops, before
	// waiting for the tasks that issued them.
	defer close(h.done)
	defer h.stopHostSampler() // #74
	if h.opts.RepoOf != nil {
		h.wg.Add(1)
		go h.suggester(ctx)
	}
	if h.opts.Usage != nil { // M5 usage
		h.wg.Add(1)
		go h.trackUsage(ctx)
	}
	if h.opts.RunsDir != "" { // M6 runs
		h.wg.Add(1)
		go h.trackReports(ctx)
	}
	if h.limitsPoller != nil { // M10 limits
		h.wg.Add(1)
		go h.trackLimits(ctx)
	}
	if h.screen.frames != nil { // M13 screen
		h.wg.Add(1)
		go h.runScreenJanitor(ctx)
	}
	if h.ps.files != nil { // #108 prompt secrets
		h.wg.Add(2)
		go h.runSecretsJanitor(ctx)
		go h.runSecretCounts(ctx) // round 5
	}
	if h.opts.AI != nil { // #92 AI integration
		h.wg.Add(1)
		go h.trackAI(ctx)
	}
	if h.opts.Kaneo != nil { // #184 Kaneo
		h.wg.Add(1)
		go h.trackKaneo(ctx)
	}
	if h.opts.RepoDiscovery != nil { // #54
		h.wg.Add(1)
		go h.trackRepoDiscovery(ctx)
	}
	if h.nt.svc != nil { // #11 notifications
		h.wg.Add(2)
		go h.runNotify(ctx)
		go h.trackNotify(ctx)
	}
	h.runChildSources(ctx)      // #22
	var codexC <-chan time.Time // #155
	if h.codexAvailable() || len(h.cx.launches) > 0 {
		t := time.NewTicker(h.opts.CodexPoll)
		defer t.Stop()
		codexC = t.C
	}
	var boardC <-chan time.Time // M7 boards
	if h.opts.Boards != nil {
		t := time.NewTicker(h.opts.BoardTick)
		defer t.Stop()
		boardC = t.C
	}
	manualC := time.NewTicker(time.Second)
	defer manualC.Stop()
	h.syncManualInputTicker()
	defer func() {
		if h.mi.ticker != nil {
			h.mi.ticker.Stop()
		}
	}()
	h.reconcileCredentials()
	credentialTick := time.NewTicker(time.Second)
	defer credentialTick.Stop()
	schedC := time.NewTicker(h.opts.ScheduleTick) // #62: a look at the wall clock, not a timer to a due time
	defer schedC.Stop()
	for {
		select {
		case <-ctx.Done():
			for id, r := range h.credentials {
				h.expireCredential(id, r)
			}
			return nil
		case <-manualC.C:
			h.pollManualProcesses(ctx)
			h.syncManualInputTicker()
		case <-h.manualInputTick(): // #213
			h.sampleManualInput(ctx)
		case <-credentialTick.C:
			h.reconcileCredentials()
		case <-schedC.C:
			h.checkSchedules(ctx)
		case <-boardC:
			h.boardTick(ctx)
		case <-codexC:
			h.codexTick(ctx)
		case u := <-h.updates:
			switch u := u.(type) {
			case world.FloorObs:
				_, known := h.floors[u.Session]
				h.applyFloor(ctx, u)
				if !known { // #62: a schedule may wait for it
					h.checkSchedules(ctx)
				}
			case world.FloorGone:
				h.removeFloor(u)
			case world.AgentDetected:
				h.agentDetected(u)
			case world.Listed: // #62
				h.listed(ctx, u)
			}
		case op := <-h.ops:
			op(ctx)
		}
	}
}

func (h *Hub) do(ctx context.Context, op func(context.Context)) error {
	select {
	case h.ops <- op:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-h.done:
		return errHubStopped
	}
}

var errHubStopped = errors.New("hub stopped")

// Join registers c after hello: it queues the welcome, then either the
// replay of every event after hello.SinceSeq (same epoch, still in the ring)
// or a fresh world.snapshot, then live events. It all happens in the hub
// goroutine, so nothing is missed or duplicated between them.
func (h *Hub) Join(ctx context.Context, c *Client, hello proto.Hello) error {
	return h.do(ctx, func(context.Context) {
		resume := proto.ResumeSnapshot
		var replay [][]byte
		if hello.SinceSeq != nil && hello.Epoch == h.epoch {
			if evs, ok := h.ring.since(*hello.SinceSeq, h.seq); ok && len(evs) <= cap(c.send)/2 {
				resume, replay = proto.ResumeReplay, evs
			}
		}
		h.clients[c] = struct{}{}
		h.setClients()
		h.deliver(c, mustJSON(proto.Welcome{
			T: proto.TWelcome, Proto: proto.Version, ServerSeq: h.seq, Epoch: h.epoch, Resume: resume, Server: h.opts.Server,
		}))
		if resume == proto.ResumeSnapshot {
			h.deliver(c, mustJSON(h.snapshot()))
			return
		}
		for _, msg := range replay {
			h.deliver(c, msg)
		}
	})
}

// Leave unregisters c. It works after the client's own context is gone.
func (h *Hub) Leave(c *Client) {
	_ = h.do(context.Background(), func(context.Context) {
		delete(h.clients, c)
		h.setClients()
		h.dropWatches(c)                        // M5 term
		h.dropTranscriptWatches(c)              // M16 transcript
		h.dropBoardWatch(c)                     // M7 boards
		h.standsOn(context.Background(), c, "") // #98
		h.dropScreen(c)                         // M13 screen
		h.dropHostWatch(c)                      // #74 server rack
	})
}

// Command runs one client command; its ack or error is queued to c after
// the events it caused. Accepted or rejected, it is audited.
func (h *Hub) Command(ctx context.Context, c *Client, cmd proto.Command) error {
	return h.do(ctx, func(ctx context.Context) {
		if _, ok := h.clients[c]; !ok {
			return
		}
		if cmd.ReqID == "" {
			h.audit(ctx, c, cmd, errNoReqID)
			h.reply(c, cmd, nil, errNoReqID)
			return
		}
		var start func(context.Context, *Client, proto.Command) error
		switch cmd.T {
		case proto.CmdManualProcessStart, proto.CmdManualProcessStop, proto.CmdManualProcessDismiss:
			start = h.startManualCommand
		case proto.CmdFloorWake, proto.CmdFloorSleep:
			start = h.startFloorOp
		case proto.CmdSessionCreate: // #58
			start = h.startSessionCreate
		case proto.CmdFloorSettings: // #184: a Kaneo link is checked off the hub goroutine
			start = h.startFloorSettings
		case proto.CmdWorkerHire:
			start = h.startHire
		case proto.CmdWorkerFire:
			start = h.startFire
		case proto.CmdHirePrepare:
			start = h.startHirePrepare
		case proto.CmdFirePrepare:
			start = h.startFirePrepare
		case proto.CmdWorkerWrapUp: // #83
			start = h.startWrapUp
		case proto.CmdWorkerWrapUpCancel:
			start = h.startWrapUpCancel
		case proto.CmdWorkerChanges: // M5 usage
			start = h.startChanges
		case proto.CmdWorkerCommands: // #136
			start = h.startCommands
		case proto.CmdWorkerFiles: // #137
			start = h.startFiles
		case proto.CmdWorkerRepos: // #247
			start = h.startWorkerRepos
		case proto.CmdHireCommands: // #39
			start = h.startHireCommands
		case proto.CmdHireFiles: // #39
			start = h.startHireFiles
		case proto.CmdHireRepos: // #39
			start = h.startHireRepos
		case proto.CmdRepoRefsGet, proto.CmdRepoRefsSet: // #247
			start = h.startRepoRefs
		case proto.CmdPromptSecretsGet, proto.CmdPromptSecretsSet, proto.CmdPromptSecretsScan: // #108
			start = h.startPromptSecrets
		case proto.CmdPromptSecretsRevoke: // #108 round 5
			start = h.startRevokeSecrets
		case proto.CmdRepoDiscoveryGet, proto.CmdRepoDiscoverySet, proto.CmdRepoDiscoveryRefresh: // #54
			start = h.startRepoDiscovery
		case proto.CmdCodexProfilesGet, proto.CmdCodexProfilesSet: // #138
			start = h.startCodexProfiles
		case proto.CmdCodexProfilesShare, proto.CmdCodexProfilesMoveSkill: // #167: the file work off the hub goroutine
			start = h.startCodexShare
		// M5 term
		case proto.CmdTerminalWatch:
			start = h.startWatch
		case proto.CmdTerminalUnwatch:
			start = h.startUnwatch
		case proto.CmdTerminalZoom: // #74
			start = h.startZoom
		case proto.CmdTerminalResize: // #176
			start = h.startResize
		case proto.CmdTerminalScroll: // #176
			start = h.startScroll
		case proto.CmdManualProcessCredential:
			start = h.startManualCredential
		case proto.CmdTerminalInput:
			start = h.startTerminalInput
		case proto.CmdWorkerKeys:
			start = h.startKeys
		case proto.CmdWorkerPrompt:
			start = h.startPrompt
		case proto.CmdWorkerAnswer:
			start = h.startAnswer
		case proto.CmdWorkerAnswerAsk: // #57
			start = h.startAnswerAsk
		// M16 transcript
		case proto.CmdTranscriptWatch:
			start = h.startTranscriptWatch
		case proto.CmdTranscriptUnwatch:
			start = h.startTranscriptUnwatch
		case proto.CmdTranscriptPage, proto.CmdTranscriptItem, proto.CmdTranscriptImage, proto.CmdTranscriptImages:
			start = h.startTranscriptRead
		// M6 launch
		case proto.CmdRunPrepare:
			start = h.startRunPrepare
		case proto.CmdRunStart:
			start = h.startRunStart
		case proto.CmdLimitsRefresh: // M10 limits
			start = h.startLimitsRefresh
		case proto.CmdAIGet, proto.CmdAIModels, proto.CmdAITest, proto.CmdAISet, proto.CmdAIClear: // #92
			start = h.startAI
		case proto.CmdKaneoGet, proto.CmdKaneoTest, proto.CmdKaneoSet, proto.CmdKaneoClear, proto.CmdKaneoWorkspaces, proto.CmdKaneoProjects: // #184
			start = h.startKaneo
		case proto.CmdFollowupsGet, proto.CmdFollowupsSet, proto.CmdFollowupsTest: // #90
			start = h.startFollowups
		case proto.CmdScheduleSuggestionsGet, proto.CmdScheduleSuggestionsSet, proto.CmdScheduleSuggestionsZone: // #66
			start = h.startScheduleSuggestions
		case proto.CmdWorkerDismissCommandRequest:
			start = h.startDismissCommandRequest
		case proto.CmdWorkerDismissScheduleSuggestion: // #66
			start = h.startDismissScheduleSuggestion
		case proto.CmdPackupGet, proto.CmdPackupSet, proto.CmdPackupTest, proto.CmdPackupDetect: // #110
			start = h.startPackup
		case proto.CmdHireInterpret: // #211
			start = h.startHireInterpret
		case proto.CmdHirePresetCheck: // #95
			start = h.startHirePresetCheck
		case proto.CmdHirePresetCreate, proto.CmdHirePresetUpdate, proto.CmdHirePresetDelete: // #93; #108: a prompt is scanned first
			start = h.startHirePreset
		case proto.CmdCodexServerGet, proto.CmdCodexServerSet: // #155
			start = h.startCodexServer
		case proto.CmdWorkerAnswerAsync: // #156
			start = h.startAnswerAsync
		case proto.CmdWorkerDismissAsync:
			start = h.startDismissAsync
		case proto.CmdInboxDismiss: // #106
			start = h.startInboxDismiss
		case proto.CmdWorkerAnswerFollowup:
			start = h.startAnswerFollowup
		case proto.CmdWorkerDismissFollowup:
			start = h.startDismissFollowup
		case proto.CmdWorkerRetryFollowup: // #60
			start = h.startRetryFollowup
		case proto.CmdWorkerFollowupMessage: // #60
			start = h.startFollowupMessage
		case proto.CmdWorkerHandoffPreview: // #223
			start = h.startHandoffPreview
		case proto.CmdWorkerHandoff: // #223
			start = h.startHandoff
		case proto.CmdHandoffList, proto.CmdHandoffGet, proto.CmdHandoffDelete: // #223
			start = h.startHandoffs
		case proto.CmdWorkerHandoffCancel: // #224, #9
			start = h.startHandoffCancel
		case proto.CmdHandoffLLMGet, proto.CmdHandoffLLMSet, proto.CmdHandoffLLMTest: // #9
			start = h.startHandoffLLM
		case proto.CmdActivityGet, proto.CmdActivitySet: // #98
			start = h.startActivity
		case proto.CmdDigestGet, proto.CmdDigestSet, proto.CmdDigestTest, proto.CmdDigestRetry: // #118, #174
			start = h.startDigest
		case proto.CmdNotifyGet, proto.CmdNotifySet, proto.CmdNotifyTest, proto.CmdNotifyTokenSet, proto.CmdNotifyTokenClear,
			proto.CmdNotifyPairStart, proto.CmdNotifyPairCancel, proto.CmdNotifyUnpair: // #11
			start = h.startNotify
		// M7 boards
		case proto.CmdBoardWatch:
			start = h.startBoardWatch
		case proto.CmdBoardUnwatch:
			start = h.startBoardUnwatch
		case proto.CmdBoardRefresh:
			start = h.startBoardRefresh
		case proto.CmdIssueGet:
			start = h.startIssueGet
		case proto.CmdIssueComment:
			start = h.startIssueComment
		case proto.CmdIssueClose:
			start = h.startIssueClose
		case proto.CmdIssueSetStatus:
			start = h.startIssueSetStatus
		case proto.CmdPRGet:
			start = h.startPRGet
		case proto.CmdPRComment:
			start = h.startPRComment
		case proto.CmdPRMerge:
			start = h.startPRMerge
		case proto.CmdOpenPRPrepare:
			start = h.startOpenPRPrepare
		case proto.CmdWorkerOpenPR:
			start = h.startOpenPR
		// M13 screen
		case proto.CmdScreenShare:
			start = h.startScreenShare
		case proto.CmdScreenFrame:
			start = h.startScreenFrame
		case proto.CmdScreenGrab:
			start = h.startScreenGrab
		// M13 whiteboard
		case proto.CmdWhiteboardGet:
			start = h.startWhiteboardGet
		case proto.CmdWhiteboardClear:
			start = h.startWhiteboardClear
		case proto.CmdWhiteboardPin:
			start = h.startWhiteboardPin
		case proto.CmdDropsList:
			start = h.startDropsList
		// #196 MCP & skills
		case proto.CmdMCPInventory:
			start = h.startMCPInventory
		case proto.CmdMCPCheck:
			start = h.startMCPCheck
		// #74 server rack
		case proto.CmdHostWatch:
			start = h.startHostWatch
		case proto.CmdHostUnwatch:
			start = h.startHostUnwatch
		// #62 scheduled agents
		case proto.CmdScheduleCreate, proto.CmdScheduleUpdate, proto.CmdScheduleCancel, proto.CmdScheduleRunNow,
			proto.CmdScheduleRetry, proto.CmdScheduleDismiss:
			start = h.startSchedule
		}
		if start != nil {
			// Accepted: the audit row is written (or begun) and the reply
			// sent when the slow part is done.
			if err := start(ctx, c, cmd); err != nil {
				h.audit(ctx, c, cmd, err)
				h.reply(c, cmd, nil, err)
			}
			return
		}
		data, err := h.command(ctx, cmd)
		h.audit(ctx, c, cmd, err)
		h.reply(c, cmd, data, err)
	})
}

func (h *Hub) audit(ctx context.Context, c *Client, cmd proto.Command, err error) {
	if aerr := h.st.Audit(ctx, c.name, cmd.T, auditArgs(cmd), err); aerr != nil {
		h.log.Error("audit log write failed", "err", aerr)
	}
}

// reply sends a command's ack or error to c, if it is still connected.
func (h *Hub) reply(c *Client, cmd proto.Command, data any, err error) {
	if err != nil {
		code := errorCode(err)
		h.log.Info("command rejected", "client", c.name, "cmd", cmd.T, "req_id", cmd.ReqID, "code", code, "err", err)
		h.deliver(c, mustJSON(proto.Error{T: proto.TError, ReqID: cmd.ReqID, Code: code, Message: err.Error(), Data: data}))
		return
	}
	h.replyAck(c, cmd, mustJSON(proto.Ack{T: proto.TAck, ReqID: cmd.ReqID, Data: data}))
}

// replyAck sends cmd's ack, already encoded.
func (h *Hub) replyAck(c *Client, cmd proto.Command, ack []byte) {
	h.log.Info("command applied", "client", c.name, "cmd", cmd.T, "req_id", cmd.ReqID)
	h.deliver(c, ack)
}

var (
	errUnknownSession = errors.New("unknown session")
	errNoReqID        = errors.New("commands need a req_id")
)

func errorCode(err error) string {
	var bad *badArgsError
	var fetch *fetchFailedError
	var coded *codedError // M5 usage
	switch {
	case errors.As(err, &coded):
		return coded.code
	case followupErrorCode(err) != "": // #90
		return followupErrorCode(err)
	case scheduleSuggestErrorCode(err) != "": // #66
		return scheduleSuggestErrorCode(err)
	case handoffLLMErrorCode(err) != "": // #9
		return handoffLLMErrorCode(err)
	case handoffErrorCode(err) != "": // #223
		return handoffErrorCode(err)
	case packupErrorCode(err) != "": // #110
		return packupErrorCode(err)
	case promptSecretsErrorCode(err) != "": // #108
		return promptSecretsErrorCode(err)
	case activityErrorCode(err) != "": // #98
		return activityErrorCode(err)
	case digestErrorCode(err) != "": // #118
		return digestErrorCode(err)
	case notifyErrorCode(err) != "": // #11
		return notifyErrorCode(err)
	case aiErrorCode(err) != "": // #92
		return aiErrorCode(err)
	case kaneoErrorCode(err) != "": // #184
		return kaneoErrorCode(err)
	case boardCode(err) != "": // M7 boards
		return boardCode(err)
	case errors.As(err, &fetch):
		return proto.ErrFetchFailed
	case errors.As(err, &bad), errors.Is(err, store.ErrInvalid), errors.Is(err, errNoReqID):
		return proto.ErrBadRequest
	case errors.Is(err, store.ErrNotFound):
		return proto.ErrNotFound
	case errors.Is(err, store.ErrNameTaken), errors.Is(err, store.ErrFloorExists):
		return proto.ErrNameTaken
	case errors.Is(err, store.ErrFloorHasWorkers): // #58
		return proto.ErrInvalidState
	case errors.Is(err, errUnknownSession):
		return proto.ErrUnknownSession
	case errors.Is(err, errUnknownCommand):
		return proto.ErrUnknownCommand
	case errors.Is(err, errBusy):
		return proto.ErrBusy
	case errors.Is(err, errInvalidState):
		return proto.ErrInvalidState
	case errors.Is(err, errWakeFailed):
		return proto.ErrWakeFailed
	case errors.Is(err, errSleepFailed):
		return proto.ErrSleepFailed
	case errors.Is(err, errUnknownWorker):
		return proto.ErrUnknownWorker
	case errors.Is(err, errDeskTaken):
		return proto.ErrDeskTaken
	case errors.Is(err, errCapacity):
		return proto.ErrCapacity
	case errors.Is(err, errNotClean):
		return proto.ErrNotClean
	case errors.Is(err, errHireFailed):
		return proto.ErrHireFailed
	case errors.Is(err, errFireFailed):
		return proto.ErrFireFailed
	// M5 term
	case errors.Is(err, errInputFailed):
		return proto.ErrInputFailed
	case errors.Is(err, errPromptFailed):
		return proto.ErrPromptFailed
	case errors.Is(err, errStale):
		return proto.ErrStale
	}
	return proto.ErrInternal
}

type badArgsError struct{ err error }

func (e *badArgsError) Error() string { return "bad args: " + e.err.Error() }

var errUnknownCommand = errors.New("unknown command")

func decodeArgs(raw json.RawMessage, v any) error {
	if len(raw) == 0 || string(raw) == "null" {
		raw = json.RawMessage("{}")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return &badArgsError{err}
	}
	return nil
}

func (h *Hub) command(ctx context.Context, cmd proto.Command) (any, error) {
	var data any
	var err error
	switch cmd.T {
	case proto.CmdBuildingCreate:
		var a proto.BuildingCreateArgs
		if err = decodeArgs(cmd.Args, &a); err == nil {
			var b store.Building
			if b, err = h.st.CreateBuilding(ctx, "b_"+randHex(6), a.Name); err == nil {
				data = map[string]string{"id": b.ID}
			}
		}
	case proto.CmdBuildingRename:
		var a proto.BuildingRenameArgs
		if err = decodeArgs(cmd.Args, &a); err == nil {
			err = h.st.RenameBuilding(ctx, a.ID, a.Name)
		}
	case proto.CmdBuildingDelete:
		var a proto.BuildingDeleteArgs
		if err = decodeArgs(cmd.Args, &a); err == nil {
			err = h.st.DeleteBuilding(ctx, a.ID)
		}
	case proto.CmdBuildingReorder:
		var a proto.BuildingReorderArgs
		if err = decodeArgs(cmd.Args, &a); err == nil {
			err = h.st.ReorderBuildings(ctx, a.IDs)
		}
	case proto.CmdFloorAssign:
		var a proto.FloorAssignArgs
		if err = decodeArgs(cmd.Args, &a); err == nil {
			floor := floorArg(a.Floor, a.Session)
			var f *floorState
			if f, err = h.floorFor(floor); err != nil {
				break
			}
			if err = h.notBusy(floor, f); err != nil {
				break
			}
			building, index := "", -1
			if a.Building != nil {
				building = *a.Building
			}
			if a.Index != nil {
				index = *a.Index
			}
			err = h.st.AssignFloor(ctx, floor, building, index)
		}
	case proto.CmdFloorCreate: // #58
		var a proto.FloorCreateArgs
		if err = decodeArgs(cmd.Args, &a); err == nil {
			data, err = h.floorCreate(ctx, a)
		}
	case proto.CmdFloorRename:
		var a proto.FloorRenameArgs
		if err = decodeArgs(cmd.Args, &a); err == nil {
			err = h.floorRename(ctx, a)
		}
	case proto.CmdFloorDelete:
		var a proto.FloorDeleteArgs
		if err = decodeArgs(cmd.Args, &a); err == nil {
			err = h.floorDelete(ctx, a)
		}
	case proto.CmdFloorHide:
		var a proto.FloorHideArgs
		if err = decodeArgs(cmd.Args, &a); err == nil {
			err = h.floorHide(ctx, a)
		}
	// M6 launch
	case proto.CmdPresetCreate, proto.CmdPresetUpdate, proto.CmdPresetDelete:
		data, err = h.presetCommand(ctx, cmd)
	default:
		err = fmt.Errorf("%w: %q", errUnknownCommand, cmd.T)
	}
	if err != nil {
		return nil, err
	}
	if err := h.afterChange(ctx); err != nil {
		return nil, err
	}
	return data, nil
}

// reload reads buildings and floor assignments back from the store.
func (h *Hub) reload(ctx context.Context) error {
	bs, err := h.st.Buildings(ctx)
	if err != nil {
		return err
	}
	as, err := h.st.Assignments(ctx)
	if err != nil {
		return err
	}
	h.buildings = map[string]store.Building{}
	for _, b := range bs {
		h.buildings[b.ID] = b
	}
	h.assign = map[string]store.Assignment{}
	for _, a := range as {
		h.assign[a.Floor] = a
	}
	return nil
}

func (h *Hub) applyFloor(ctx context.Context, u world.FloorObs) {
	if _, ok := h.vfloors[u.Session]; ok { // #58: never minted for a known session, but a session may take the name later
		h.log.Warn("herdr session named like a virtual floor ignored", "session", u.Session)
		return
	}
	f := h.floors[u.Session]
	if f != nil && u.Gen < f.gen {
		h.log.Debug("stale floor observation dropped", "session", u.Session, "gen", u.Gen, "current", f.gen)
		return
	}
	isNew := f == nil
	if isNew {
		f = &floorState{sessionState: &sessionState{session: u.Session, byWS: map[string]string{}}, id: u.Session}
		h.floors[u.Session] = f
	}
	h.placeVirtualFloors(u.Session) // #58: its virtual floors come (back) with it
	fresh := u.Fresh || isNew
	// A worker that vanishes from a floor we watched run without a gap had
	// its workspace closed.
	closing := !isNew && f.running && u.Running && !fresh
	if f.running != u.Running && !isNew {
		h.log.Info("floor state changed", "session", u.Session, "running", u.Running)
	}
	if f.running && !u.Running {
		// Resume states end with the next sleep.
		for _, id := range f.all {
			delete(h.resume, id)
		}
	}
	if op := f.op; op != nil {
		switch {
		case op.kind == proto.TransitionSleeping && !u.Running:
			op.asleep = true // the asleep floor goes out without its transition
			op.signal()
		case op.kind == proto.TransitionWaking && u.Running:
			op.running = true
			op.signal()
		}
	}
	f.gen, f.running, f.def, f.err = u.Gen, u.Running, u.Default, u.Err
	if u.Socket != "" {
		f.socket = u.Socket
	}
	var evs []proto.Event
	f.looked = u.Running && !u.KeepWorkers
	if !u.KeepWorkers {
		f.last = u.Workers
		evs = h.syncWorkers(ctx, u.Session, f, u.Workers, fresh, closing)
		h.refreshSuggestions(u.Session)
		h.askOrigins(u.Session, f)
	}
	// The floor (state, desks) goes first, then its workers.
	h.syncLayout()
	for _, ev := range evs {
		h.emit(ev)
	}
	h.relink()                           // M6 runs
	h.afterObserve(ctx)                  // M5 term
	h.fillRunIDs(ctx)                    // M6 launch
	h.createdFloor(u.Session, u.Running) // #58: after its floor.upsert
}

// removeFloor takes a session that went away out of the world: its real
// floor and (#58) its virtual floors, whose definitions stay for when it
// comes back.
func (h *Hub) removeFloor(u world.FloorGone) {
	f := h.floors[u.Session]
	if f == nil || u.Gen < f.gen || f.virtual {
		return
	}
	h.scheduleManualCleanup(context.Background(), "", u.Session, "session removed", true)
	for _, g := range h.sessionFloors(u.Session) {
		for _, id := range g.order {
			w := h.workers[id]
			delete(h.workers, id)
			delete(h.saved, id)
			delete(h.reported, id) // H3D-2
			delete(h.typed, id)    // #95
			delete(h.starts, id)
			delete(h.dirty, id)
			delete(h.dg, id)                               // #118
			delete(h.dgs.ws, id)                           // #118 phase 2
			h.dropFollowup(context.Background(), id, true) // #90: gone
			h.dropCommandRequest(context.Background(), id, "gone")
			h.dropSuggestion(context.Background(), id, store.ScheduleSuggestGone) // #66
			h.ch.reg.Remove(id)                                                   // #22: its children go with its worker.removed
			if w != nil {
				h.emit(proto.Event{T: proto.EvWorkerRemoved, ID: id, Session: w.Session, FloorID: w.Floor, WorkspaceID: w.WorkspaceID})
			}
		}
		delete(h.floors, g.id)
		delete(h.desks, g.id)
		if err := h.st.FreeFloorDesks(context.Background(), g.id); err != nil {
			h.log.Error("freeing desks failed", "session", u.Session, "floor", g.id, "err", err)
		}
		// Names stay held for the hold, should the session come back.
		h.releaseNames(context.Background(), g.id, nil, nil, nil, h.opts.Now())
	}
	h.log.Info("floor removed", "session", u.Session)
	h.syncLayout()
	h.relink()      // M6 runs
	h.syncWatches() // M5 term
}

// resync re-applies a running floor's last observation, e.g. once a hire
// knows its workspace.
func (h *Hub) resync(ctx context.Context, session string) {
	f := h.floors[session]
	if f == nil || !f.running {
		return
	}
	evs := h.syncWorkers(ctx, session, f, f.last, false, false)
	h.syncLayout()
	for _, ev := range evs {
		h.emit(ev)
	}
	h.relink()          // M6 runs
	h.afterObserve(ctx) // M5 term
	h.fillRunIDs(ctx)   // M6 launch
}

// syncWorkers assigns identities, desks and names to the observed workers
// of a floor and returns the worker events of the diff (the caller emits
// them after the floor's own events).
func (h *Hub) syncWorkers(ctx context.Context, session string, f *floorState, obs []world.WorkerObs, fresh, closing bool) []proto.Event {
	// A repository's main checkout herdr opened for its worktree group is
	// not a worker (see world.HiddenMainCheckouts); it stays in the raw
	// observation, so its disappearance is not a closed worker.
	rawWS := map[string]bool{}
	for _, w := range obs {
		rawWS[w.WorkspaceID] = true
	}
	if hidden := world.HiddenMainCheckouts(obs, h.holdRepos(f), h.hireWorkspaces(f)); len(hidden) > 0 {
		shown := make([]world.WorkerObs, 0, len(obs))
		for _, w := range obs {
			if !hidden[w.WorkspaceID] {
				shown = append(shown, w)
			}
		}
		obs = shown
	}
	defer h.signalOps(f)
	assigned := map[string]string{} // workspace id → worker id
	if !fresh {
		for _, w := range obs {
			if id, ok := f.byWS[w.WorkspaceID]; ok {
				assigned[w.WorkspaceID] = id
			}
		}
	}
	// A hired workspace is its hire's worker, whatever else matched it.
	creating := false
	for _, op := range f.hires {
		if op.workspaceID == "" {
			creating = true
			continue
		}
		for ws, id := range assigned {
			if id == op.id && ws != op.workspaceID {
				delete(assigned, ws)
			}
		}
		for _, w := range obs {
			if w.WorkspaceID == op.workspaceID {
				assigned[w.WorkspaceID] = op.id
			}
		}
	}
	var unresolved []world.WorkerObs
	for _, w := range obs {
		if _, ok := assigned[w.WorkspaceID]; !ok {
			unresolved = append(unresolved, w)
		}
	}
	records := map[string]store.Worker{}      // stored state of reconciled workers
	var storedRuns map[string]store.WorkerRun // M6 runs: their phase and pass
	if len(unresolved) > 0 {
		taken := map[string]bool{}
		for _, id := range assigned {
			taken[id] = true
		}
		recs, err := h.st.SessionWorkers(ctx, session)
		if err != nil {
			h.log.Error("loading worker identities failed", "session", session, "err", err)
		}
		for _, r := range recs {
			records[r.ID] = r
		}
		storedRuns = h.storedRuns(ctx, session) // M6 runs
		for _, op := range f.hires {
			taken[op.id] = true // a hire's identity is only its own workspace
		}
		matches := world.Reconcile(unresolved, candidates(recs), taken)
		for _, w := range unresolved {
			if m, ok := matches[w.WorkspaceID]; ok {
				assigned[w.WorkspaceID] = m.ID
				h.log.Debug("worker reconciled", "session", session, "workspace", w.WorkspaceID, "worker", m.ID, "by", m.How)
				continue
			}
			if creating {
				// Possibly the workspace a hire is creating: wait until the
				// hire knows its id (it re-applies this observation).
				h.log.Debug("new workspace deferred while a hire creates one", "session", session, "workspace", w.WorkspaceID)
				continue
			}
			id := uuid.NewString()
			assigned[w.WorkspaceID] = id
			h.log.Debug("new worker", "session", session, "workspace", w.WorkspaceID, "worker", id)
		}
	}

	if creating {
		kept := make([]world.WorkerObs, 0, len(obs))
		for _, w := range obs {
			if _, ok := assigned[w.WorkspaceID]; ok {
				kept = append(kept, w)
			}
		}
		obs = kept
	}
	present := map[string]bool{}
	for _, id := range assigned {
		present[id] = true
	}
	at := h.opts.Now()
	now := at.UnixMilli()
	ids := make([]string, len(obs))
	metas := make([]workerMeta, len(obs))
	for i, w := range obs {
		id := assigned[w.WorkspaceID]
		ids[i] = id
		var base workerMeta
		if prev := h.workers[id]; prev != nil {
			base = metaOf(prev)
			if r, ok := h.reported[id]; ok { // H3D-2: not the view's, which may hold what its transcript says
				base.model, base.effort = r.model, r.effort
			}
		} else if op := f.hires[id]; op != nil {
			base = workerMeta{harness: op.harness, model: op.model, effort: op.effort, hiredAt: op.hiredAt, floor: op.floor}
		} else if r, ok := records[id]; ok {
			base = workerMeta{harness: r.Harness, model: r.Model, effort: r.Effort, status: r.Status, statusSince: r.StatusSince,
				hiredAt: r.HiredAt, floor: r.FloorID}
			base = withStoredRun(base, storedRuns[id]) // M6 runs
		}
		metas[i] = nextMeta(base, w, now)
		// #58: the worker's floor is its stored (or hired) one while that is
		// a floor of this session; else, and when it has none, the real
		// floor. A changed floor is stored with the worker below.
		if g := h.floors[metas[i].floor]; g == nil || g.session != session {
			metas[i].floor = session
		}
	}
	h.inheritFloors(session, f, obs, ids, metas) // #58 stage 3

	var evs []proto.Event
	sentHome := map[string]bool{} // deliberate departures: no hold for their names
	for _, id := range f.all {
		if present[id] {
			continue
		}
		w := h.workers[id]
		h.scheduleManualCleanup(ctx, id, "", "owner workspace closed", true)
		delete(h.workers, id)
		delete(h.saved, id)
		delete(h.reported, id) // H3D-2
		delete(h.typed, id)    // #95
		delete(h.starts, id)
		delete(h.dirty, id)
		delete(h.dg, id)              // #118
		delete(h.dgs.ws, id)          // #118 phase 2
		h.dropFollowup(ctx, id, true) // #90: gone
		h.dropCommandRequest(ctx, id, "gone")
		h.dropSuggestion(ctx, id, store.ScheduleSuggestGone) // #66
		delete(h.ho.cands, id)                               // #223
		h.ch.reg.Remove(id)                                  // #22: its children go with its worker.removed
		if w == nil {
			continue
		}
		if closing && !rawWS[w.WorkspaceID] {
			if err := h.st.CloseWorker(ctx, id); err != nil {
				h.log.Error("recording closed worker failed", "worker", id, "err", err)
			}
			h.forgetWrapUp(ctx, id)       // #83: closed in herdr
			h.forgetAgentHandoff(ctx, id) // #224
			h.forgetLLMHandoff(id)        // #9
			h.forgetDismissed(ctx, id)    // #106
			h.releaseSecrets(id)          // #108: it really ended
		}
		ev := proto.Event{T: proto.EvWorkerRemoved, ID: id, Session: session, FloorID: w.Floor, WorkspaceID: w.WorkspaceID}
		if op := f.fires[id]; op != nil && !rawWS[op.workspaceID] {
			ev.Reason = proto.RemovedSentHome
			op.removed = true
			sentHome[id] = true
			op.signal()
			h.forgetWrapUp(ctx, id)       // #83: sent home
			h.forgetAgentHandoff(ctx, id) // #224
			h.forgetLLMHandoff(id)        // #9
			h.releaseSecrets(id)          // #108
		}
		evs = append(evs, ev)
	}
	// #58: each floor of the session seats, names and lists its own
	// workers.
	for _, g := range h.sessionFloors(session) {
		var gObs []world.WorkerObs
		var gIDs []string
		var gMetas []workerMeta
		onFloor := map[string]bool{}
		for i, id := range ids {
			if metas[i].floor == g.id {
				gObs, gIDs, gMetas = append(gObs, obs[i]), append(gIDs, id), append(gMetas, metas[i])
				onFloor[id] = true
			}
		}
		evs = append(evs, h.syncFloorWorkers(ctx, g, gObs, gIDs, gMetas, onFloor, present, sentHome, at)...)
	}
	f.byWS = assigned
	f.all = ids
	return evs
}

// syncFloorWorkers seats, names, stores and lists the workers of one floor
// (obs, ids and metas, in sidebar order; onFloor is the same ids) and
// returns their events. present is every worker of the session: one that
// moved to another of its floors loses its desk and name here without
// touching the store, which its new floor's rows replace.
func (h *Hub) syncFloorWorkers(ctx context.Context, f *floorState, obs []world.WorkerObs, ids []string, metas []workerMeta,
	onFloor, present, sentHome map[string]bool, at time.Time) []proto.Event {
	floor, session := f.id, f.session
	// Before anyone is named: whoever left (seen now, or while the bridge
	// was down) holds its name from now on.
	h.releaseNames(ctx, floor, onFloor, present, sentHome, at)
	// Desks are held by the floor's current workers only: this frees the
	// desks of removed workers and of stored ones that did not come back.
	desks := h.floorDesks(floor)
	for id := range desks {
		if !onFloor[id] {
			delete(desks, id)
			if present[id] {
				continue // seated on its new floor below
			}
			if err := h.st.FreeDesk(ctx, id); err != nil {
				h.log.Error("freeing desk failed", "worker", id, "err", err)
			}
		}
	}

	names, claimed := h.nameWorkers(floor, ids, at)
	for i, id := range ids {
		if op := f.hires[id]; op != nil && !op.seen {
			claimed[i] = true // its name was only reserved in memory
		}
	}

	// M6 runs: freelancers sit next to their orchestrator.
	links := h.links(h.members(floor, obs, ids))
	moved := h.seatNearOrch(f, desks, obs, ids, links, at)

	used := map[int]bool{}
	for _, d := range desks {
		used[d] = true
	}
	for _, op := range f.hires {
		if op.floor == floor {
			used[op.desk] = true // reserved
		}
	}
	var evs []proto.Event
	order := make([]string, 0, len(obs))
	for i, w := range obs {
		id := ids[i]
		order = append(order, id)
		h.persist(ctx, id, session, w, metas[i])
		h.persistRun(ctx, id, metas[i]) // M6 runs
		if claimed[i] {
			if err := h.st.ClaimName(ctx, floor, names[i], id); err != nil {
				h.log.Error("saving worker name failed", "worker", id, "name", names[i], "err", err)
			}
		}
		desk, seated := desks[id]
		if moved[id] { // M6 runs
			if err := h.st.AssignDesk(ctx, floor, desk, id); err != nil {
				h.log.Error("saving desk failed", "worker", id, "desk", desk, "err", err)
			}
		}
		if op := f.hires[id]; !seated && op != nil {
			desk, seated = op.desk, true
			desks[id] = desk
			if err := h.st.AssignDesk(ctx, floor, desk, id); err != nil {
				h.log.Error("saving desk failed", "worker", id, "desk", desk, "err", err)
			}
		}
		if !seated {
			for used[desk] {
				desk++
			}
			used[desk] = true
			desks[id] = desk
			if err := h.st.AssignDesk(ctx, floor, desk, id); err != nil {
				h.log.Error("saving desk failed", "worker", id, "desk", desk, "err", err)
			}
			h.seatedNew(id, at) // M6 runs
		}
		next := workerView(id, session, w, metas[i], names[i], desk, h.resume[id])
		h.reported[id] = modelEffort{metas[i].model, metas[i].effort}
		next.Model, next.Effort = h.shownModel(id, next.AgentSession)                 // H3D-2
		next.ChildGeneration = h.childSession(id, h.childRoot(id, next.AgentSession)) // #22: a replaced session drops its children
		next.SecretFiles = h.ps.counts[id]                                            // #108 round 5
		h.withRun(next, w, metas[i], links[id])                                       // M6 runs
		if w.Worktree != nil && w.Worktree.Linked && w.Worktree.CheckoutPath != "" {
			next.Branch = h.branchOf(w.Worktree.CheckoutPath, at)
		}
		next.Usage = h.usage[id]          // M5 usage
		next.Ask = h.asks[id]             // #57
		next.WrapUp = h.wrapUpView(id)    // #83
		if next.Status == statusWorking { // #90: at work again: its questions are moot, and so is a look under way
			h.dropFollowup(ctx, id, false)
		}
		next.Followup = h.followupView(id)
		if s := h.cr.shown[id]; s.request != nil && s.source.Agent != next.AgentSession {
			h.dropCommandRequest(ctx, id, "moved")
			delete(h.cr.latest, id)
		}
		next.CommandRequest = h.commandRequestView(id)
		next.ScheduleSuggestion = h.suggestionView(id)      // #66
		next.Handoff = h.handoffView(id, next.AgentSession) // #223
		next.AgentHandoff = h.agentHandoffView(id)          // #224
		h.llmSessionSeen(id, next.AgentSession)             // #9: another session stops its job
		next.LLMHandoff = h.llmHandoffView(id)
		next.Activity = h.activityFor(id, next, h.workers[id]) // #98: for its status, in the same event
		next.Digest = h.workerDigest(id, next)                 // #118
		h.noteCodexThread(ctx, id, next.AgentSession)          // #155
		next.Codex = h.codexWorkerView(id)
		h.withQuestion(next) // M5 term
		if op := f.hires[id]; op != nil && !op.seen {
			op.seen = true
			op.signal()
		}
		prev := h.workers[id]
		h.workers[id] = next
		h.pruneDismissed(ctx, next) // #106
		// #95: a typed prompt is acked by the worker starting, however short
		// its turn.
		if (next.Status == statusWorking || next.Status == statusBlocked) && (prev == nil || prev.Status != next.Status) {
			h.starts[id]++
		}
		// #58: a watched worker starting a turn: its transcript is read now
		// (the prompt's user line, the first items), not on the next tick.
		if prev != nil && prev.Status != statusWorking && next.Status == statusWorking && h.tx.watched(id) {
			h.kickUsage()
		}
		switch {
		case prev == nil:
			evs = append(evs, proto.Event{T: proto.EvWorkerUpsert, Worker: next})
		case reflect.DeepEqual(prev, next):
		case sameExceptStatus(prev, next):
			title := next.Title
			evs = append(evs, proto.Event{T: proto.EvWorkerStatus, ID: id, Session: session, FloorID: floor,
				WorkspaceID: next.WorkspaceID, Status: next.Status, PrevStatus: prev.Status, StatusSince: next.StatusSince,
				Title: &title})
		default:
			evs = append(evs, proto.Event{T: proto.EvWorkerUpsert, Worker: next})
		}
	}
	f.order = order
	return evs
}

// floorDesks returns a floor's desk map, creating it.
func (h *Hub) floorDesks(session string) map[string]int {
	m := h.desks[session]
	if m == nil {
		m = map[string]int{}
		h.desks[session] = m
	}
	return m
}

// floorNames returns a floor's name claims, creating them.
func (h *Hub) floorNames(session string) map[string]nameClaim {
	m := h.names[session]
	if m == nil {
		m = map[string]nameClaim{}
		h.names[session] = m
	}
	return m
}

// shownModel is the model and effort a worker shows (H3D-2), each field on
// its own: what the transcript of its current agent session says of it (its
// usage), else what was reported (the hire op, the stored record, the h3d_*
// tokens), else unknown. A usage is the evidence of the transcript session
// it was read from (usageFor.evidenceOf): not of another one the worker has
// now.
func (h *Hub) shownModel(id, agent string) (model, effort string) {
	model, effort = h.reported[id].model, h.reported[id].effort
	u := h.usage[id]
	if u == nil || !h.usageFor[id].evidenceOf(agent) {
		return model, effort
	}
	if m := usage.CleanModel(u.Model); m != "" {
		model = m
	}
	if e := usage.CleanEffort(u.Effort); e != "" {
		effort = e
	}
	return model, effort
}

func metaOf(w *proto.Worker) workerMeta {
	m := workerMeta{harness: w.Harness, model: w.Model, effort: w.Effort, status: w.Status, statusSince: w.StatusSince,
		hiredAt: w.HiredAt, floor: w.Floor}
	m.phase = w.Phase // M6 runs
	if w.Pass != nil {
		m.pass, m.passSet = *w.Pass, true
	}
	return m
}

// branchTTL is how long a linked worktree's branch, read from its files,
// is reused.
const branchTTL = 15 * time.Second

// branchOf returns the branch checked out at a linked worktree, read at
// most every branchTTL.
func (h *Hub) branchOf(checkout string, at time.Time) string {
	if r, ok := h.branches[checkout]; ok && at.Sub(r.at) < branchTTL && !at.Before(r.at) {
		return r.branch
	}
	b := h.opts.BranchOf(checkout)
	h.branches[checkout] = branchRead{branch: b, at: at}
	return b
}

// nextMeta folds an observation into what the bridge knows about a worker:
// harness, model and effort (the reported ones, H3D-2: not what a transcript
// says of them) are remembered once seen (herdr drops tokens on a restart),
// and status_since only moves when the status changes.
func nextMeta(m workerMeta, w world.WorkerObs, now int64) workerMeta {
	if w.Harness != "" {
		m.harness = w.Harness
	}
	m.harness = world.ResolveHarness(m.harness, w.AgentKind)
	if w.Model != "" {
		m.model = w.Model
	}
	if w.Effort != "" {
		m.effort = w.Effort
	}
	if m.status != w.Status || m.statusSince == 0 {
		m.status, m.statusSince = w.Status, now
	}
	return runMeta(m, w) // M6 runs
}

// releaseNames records that the owners of a floor's names who are not
// among present left it at at: each name stays held for the name hold from
// then. A worker that left while the bridge was down is recorded at the
// first observation after, so its hold starts late, never early. A worker
// in sentHome was sent home on purpose and will not come back: its name is
// released as already held for the whole hold, so it is free at once (and
// the first to be recycled should every name be held).
//
// #58: present is who is on the floor; elsewhere who is on another floor of
// its session: such an owner moved, and its claim here goes (its new
// floor's claim replaces the stored one).
func (h *Hub) releaseNames(ctx context.Context, floor string, present, elsewhere, sentHome map[string]bool, at time.Time) {
	claims := h.names[floor]
	for name, c := range claims {
		if present[c.owner] {
			continue
		}
		if elsewhere[c.owner] {
			delete(claims, name)
			continue
		}
		if !c.released.IsZero() {
			continue
		}
		c.released = at
		if sentHome[c.owner] {
			c.released = at.Add(-h.opts.NameHold)
		}
		claims[name] = c
		if err := h.st.ReleaseName(ctx, c.owner, c.released); err != nil {
			h.log.Error("releasing worker name failed", "worker", c.owner, "name", name, "err", err)
		}
	}
}

// nameWorkers returns the names of a floor's workers (all present, after
// releaseNames) and which of their claims changed and must be stored. A
// worker keeps the name it owns on the floor. One that owns none (new, or
// back after its hold ran out and a newcomer took its name) gets a name
// that no worker on the floor owns and no worker that left less than the
// hold ago still holds. Taking a name whose hold ran out takes it from its
// owner, who gets a new name if it ever comes back. When every name is
// held, the one released longest ago is taken the same way (world.PickName):
// a name is never suffixed, and one a worker on the floor owns is never
// taken. So names are unique on a floor, and a worker that returns within
// its hold has its name unless the floor ran out of names.
func (h *Hub) nameWorkers(session string, ids []string, at time.Time) (names []string, claimed []bool) {
	claims := h.floorNames(session)
	owned := make(map[string]string, len(claims)) // worker id → name
	for name, c := range claims {
		owned[c.owner] = name
	}
	names, claimed = make([]string, len(ids)), make([]bool, len(ids))
	for i, id := range ids {
		name, ok := owned[id]
		if !ok {
			continue
		}
		names[i] = name
		if !claims[name].released.IsZero() { // back on the floor
			claims[name] = nameClaim{owner: id}
			claimed[i] = true
		}
	}
	held, released := h.heldNames(session, at)
	for i, id := range ids {
		if names[i] != "" {
			continue
		}
		names[i] = world.PickName(id, held, released)
		held[names[i]] = true
		delete(released, names[i]) // owned now
		claims[names[i]] = nameClaim{owner: id}
		claimed[i] = true
	}
	return names, claimed
}

// sameExceptStatus reports whether only the status (and its age) and the
// title differ: that is a worker.status event, anything else an upsert.
func sameExceptStatus(a, b *proto.Worker) bool {
	x, y := *a, *b
	x.Status, y.Status = "", ""
	x.StatusSince, y.StatusSince = 0, 0
	x.Title, y.Title = "", ""
	return reflect.DeepEqual(x, y)
}

// persist writes a worker's identity, fingerprints and meta when they
// changed; a status change alone is a cheaper update.
func (h *Hub) persist(ctx context.Context, id, session string, w world.WorkerObs, m workerMeta) {
	fps := fingerprints(w)
	prev, ok := h.saved[id]
	if ok && prev.workspaceID == w.WorkspaceID && prev.label == w.Label && sameIdentityMeta(prev.meta, m) {
		changed := false
		for _, fp := range fps {
			if !prev.fps[fp] {
				changed = true
				break
			}
		}
		if !changed {
			if prev.meta != m {
				if err := h.st.SetWorkerStatus(ctx, id, m.status, m.statusSince); err != nil {
					h.log.Error("saving worker status failed", "worker", id, "err", err)
					return
				}
				prev.meta = m
				h.saved[id] = prev
			}
			return
		}
	}
	rec := store.Worker{ID: id, Session: session, FloorID: m.floor, WorkspaceID: w.WorkspaceID, Label: w.Label, Fingerprints: fps,
		Status: m.status, StatusSince: m.statusSince, Harness: m.harness, Model: m.model, Effort: m.effort, HiredAt: m.hiredAt}
	if err := h.st.SaveWorker(ctx, rec); err != nil {
		h.log.Error("saving worker failed", "worker", id, "err", err)
		return
	}
	set := map[store.Fingerprint]bool{}
	for _, fp := range fps {
		set[fp] = true
	}
	h.saved[id] = savedWorker{workspaceID: w.WorkspaceID, label: w.Label, fps: set, meta: m}
}

func sameIdentityMeta(a, b workerMeta) bool {
	a.status, a.statusSince, b.status, b.statusSince = "", 0, "", 0
	a.phase, a.pass, a.passSet, b.phase, b.pass, b.passSet = "", 0, false, "", 0, false // M6 runs: in worker_run
	return a == b
}

func fingerprints(w world.WorkerObs) []store.Fingerprint {
	var fps []store.Fingerprint
	for _, m := range w.Markers {
		fps = append(fps, store.Fingerprint{Kind: store.FPMarker, Value: m})
	}
	if w.AgentSession != "" {
		fps = append(fps, store.Fingerprint{Kind: store.FPAgentSession, Value: w.AgentSession})
	}
	if w.Label != "" {
		fps = append(fps, store.Fingerprint{Kind: store.FPLabelCwd, Value: world.LabelCwdKey(w.Label, w.IdentityCwd)})
	}
	return fps
}

func candidates(recs []store.Worker) []world.Candidate {
	out := make([]world.Candidate, 0, len(recs))
	for _, r := range recs {
		c := world.Candidate{ID: r.ID, WorkspaceID: r.WorkspaceID, Closed: r.Closed}
		for _, fp := range r.Fingerprints {
			switch fp.Kind {
			case store.FPMarker:
				c.Markers = append(c.Markers, fp.Value)
			case store.FPAgentSession:
				c.AgentSessions = append(c.AgentSessions, fp.Value)
			case store.FPLabelCwd:
				c.LabelCwds = append(c.LabelCwds, fp.Value)
			}
		}
		out = append(out, c)
	}
	return out
}

func workerView(id, session string, w world.WorkerObs, m workerMeta, name string, desk int, resume string) *proto.Worker {
	floor := m.floor
	if floor == "" {
		floor = session
	}
	return &proto.Worker{
		ID: id, Session: session, Floor: floor, WorkspaceID: w.WorkspaceID, Label: w.Label, Cwd: w.Cwd,
		PaneID: w.PaneID, PaneLabel: w.PaneLabel, AgentKind: w.AgentKind, AgentName: w.AgentName,
		AgentSession: w.AgentSession, Status: w.Status, Title: w.Title, Tokens: w.Tokens,
		Worktree: w.Worktree, Role: w.Role, Run: w.Run,
		Name: name, DeskIndex: desk, Harness: m.harness, Model: m.model, Effort: m.effort, StatusSince: m.statusSince,
		Resume: resume, HiredAt: m.hiredAt,
	}
}

// buildingViews returns buildings in sort order with their known floors
// (floor ids; #58: a virtual floor stands in its base's building).
func (h *Hub) buildingViews() []proto.Building {
	bs := make([]proto.Building, 0, len(h.buildings))
	for _, b := range h.buildings {
		bs = append(bs, proto.Building{ID: b.ID, Name: b.Name, Sort: b.Sort, Floors: []string{}, Logo: b.Logo})
	}
	sort.Slice(bs, func(i, j int) bool {
		if bs[i].Sort != bs[j].Sort {
			return bs[i].Sort < bs[j].Sort
		}
		return bs[i].ID < bs[j].ID
	})
	byID := map[string]int{}
	for i, b := range bs {
		byID[b.ID] = i
	}
	as := make([]store.Assignment, 0, len(h.assign))
	for _, a := range h.assign {
		if _, known := h.floors[a.Floor]; known {
			as = append(as, a)
		}
	}
	sort.Slice(as, func(i, j int) bool { return as[i].Index < as[j].Index })
	for _, a := range as {
		if i, ok := byID[a.BuildingID]; ok {
			bs[i].Floors = append(bs[i].Floors, a.Floor)
		}
	}
	return bs
}

func (h *Hub) floorView(floor string, f *floorState) proto.Floor {
	v := proto.Floor{ID: floor, Name: h.floorName(f), Session: f.session, BaseSession: f.session, Virtual: f.virtual,
		Hidden: h.hidden[floor], State: world.Asleep, Default: f.def, Error: f.err, Desks: h.deskCount(floor, f),
		Settings: settingsView(h.settings[floor])}
	if f.running {
		v.State = world.Running
	}
	if f.op != nil && !f.op.asleep {
		v.Transition = f.op.kind
	}
	if f.suggested != nil {
		s := *f.suggested
		v.Suggested = &s
	}
	v.LastPreset = h.lastPresetOf(floor) // M6 launch
	if a, ok := h.assign[floor]; ok {
		if _, ok := h.buildings[a.BuildingID]; ok {
			b, i := a.BuildingID, a.Index
			v.Building, v.Index = &b, &i
		}
	}
	return v
}

// deskCount is how many desks a floor renders: every occupied desk, and
// otherwise its workers and pending hires plus spares (at least minDesks),
// capped at MaxDesks.
func (h *Hub) deskCount(floor string, f *floorState) int {
	highest := -1
	count := len(f.order)
	for _, id := range f.order {
		if d, ok := h.desks[floor][id]; ok && d > highest {
			highest = d
		}
	}
	// Virtual floors' hires live on their base session, just like real
	// floors'. Count only reservations not already seated by an observation.
	for _, op := range f.hires {
		if op.floor != floor {
			continue
		}
		highest = max(highest, op.desk)
		if !op.seen {
			count++
		}
	}
	return max(highest+1, min(h.opts.MaxDesks, max(minDesks, count+spareDesks)))
}

// syncLayout emits building and floor events for whatever changed since the
// last call: floor upserts, floor removals, building upserts, building
// removals, in that order.
func (h *Hub) syncLayout() {
	names := make([]string, 0, len(h.floors))
	for s := range h.floors {
		names = append(names, s)
	}
	sort.Strings(names)
	for _, s := range names {
		v := h.floorView(s, h.floors[s])
		if old, ok := h.viewFloors[s]; !ok || !reflect.DeepEqual(old, v) {
			h.viewFloors[s] = v
			h.emit(proto.Event{T: proto.EvFloorUpsert, Floor: &v})
		}
	}
	gone := []string{}
	for s := range h.viewFloors {
		if _, ok := h.floors[s]; !ok {
			gone = append(gone, s)
		}
	}
	sort.Strings(gone)
	for _, s := range gone {
		old := h.viewFloors[s]
		delete(h.viewFloors, s)
		h.emit(proto.Event{T: proto.EvFloorRemoved, Session: old.Session, FloorID: s})
	}
	views := h.buildingViews()
	for i := range views {
		v := views[i]
		if old, ok := h.viewBuildings[v.ID]; !ok || !reflect.DeepEqual(old, v) {
			h.viewBuildings[v.ID] = v
			h.emit(proto.Event{T: proto.EvBuildingUpsert, Building: &v})
		}
	}
	removed := []string{}
	for id := range h.viewBuildings {
		if _, ok := h.buildings[id]; !ok {
			removed = append(removed, id)
		}
	}
	sort.Strings(removed)
	for _, id := range removed {
		delete(h.viewBuildings, id)
		h.emit(proto.Event{T: proto.EvBuildingRemoved, ID: id})
	}
}

// snapshot renders the world: buildings in order with their floors in
// order, then the unassigned lot by name.
func (h *Hub) snapshot() proto.Snapshot {
	hire := h.hireOptions()
	w := proto.World{Buildings: h.buildingViews(), Unassigned: []string{}, Floors: []proto.Floor{}, Workers: []proto.Worker{},
		HireOptions: &hire, Presets: h.presetViews(), Limits: h.limitsViews(), Children: []proto.Child{}} // M6 launch: presets; M10 limits; #22
	w.Host, _ = os.Hostname()
	w.ManualProcesses = h.manualProcessViews()
	w.Screen = h.screenView()                           // M13 screen
	w.AI = h.aiView()                                   // #92 AI integration
	w.Kaneo = h.kaneoView()                             // #184 Kaneo
	w.Followups = h.followupsView()                     // #90
	w.ScheduleSuggestions = h.scheduleSuggestionsView() // #66
	w.Handoffs = h.handoffsView()                       // #223
	w.Packup = h.packupView()                           // #110
	w.Activity = h.activityView()                       // #98
	w.Digest = h.digestView()                           // #118
	w.HandoffLLM = h.handoffLLMView()                   // #9
	w.Notify = h.notifyView()                           // #11
	w.InboxDismissed = h.inboxDismissedView()           // #106
	w.CodexServer = h.codexServerView()                 // #155
	w.RepoRefs = h.repoRefsView()                       // #247
	w.PromptSecrets = h.promptSecretsView()             // #108
	w.RepoDiscovery = h.repoDiscoveryView()             // #54
	w.CodexProfiles = h.codexProfilesView()             // #138
	w.Schedules = h.schedulesView()                     // #62
	w.HirePresets = h.hirePresetViews()                 // #93
	w.HerdrInstructions = true                          // #95
	w.ScheduleHerdrInstructions = true                  // #127
	w.PreparePreview = true                             // #134
	placed := map[string]bool{}
	var order []string
	for _, b := range w.Buildings {
		for _, s := range b.Floors {
			placed[s] = true
			order = append(order, s)
		}
	}
	for _, s := range sortedFloors(h.floors) {
		if !placed[s] {
			w.Unassigned = append(w.Unassigned, s)
			order = append(order, s)
		}
	}
	for _, s := range order {
		f := h.floors[s]
		w.Floors = append(w.Floors, h.floorView(s, f))
		for _, id := range f.order {
			if wk := h.workers[id]; wk != nil {
				w.Workers = append(w.Workers, *wk)
				w.Children = append(w.Children, h.ch.reg.Children(id)...) // #22
			}
		}
	}
	return proto.Snapshot{T: proto.TSnapshot, Seq: h.seq, World: w}
}

func sortedFloors(m map[string]*floorState) []string {
	out := make([]string, 0, len(m))
	for s := range m {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

// emit assigns the next seq, keeps the event for replay and sends it to
// every client.
func (h *Hub) emit(ev proto.Event) {
	h.seq++
	ev.Seq = h.seq
	msg := mustJSON(ev)
	h.ring.add(ev.Seq, msg)
	for c := range h.clients {
		h.deliver(c, msg)
	}
	h.notifyEvent(ev) // #11: never blocks
}

// deliver queues msg for c without blocking, dropping c if its queue is full.
func (h *Hub) deliver(c *Client, msg []byte) {
	if _, ok := h.clients[c]; !ok {
		return
	}
	select {
	case c.send <- msg:
	default:
		delete(h.clients, c)
		h.setClients()
		h.log.Warn("dropping slow client", "client", c.name, "queue", cap(c.send))
		c.kick(ErrSlowConsumer)
	}
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
