package app

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codex"
	"github.com/JeffreyVdb/herdr-3d/internal/githubcli"
	"github.com/JeffreyVdb/herdr-3d/internal/gitops"
	"github.com/JeffreyVdb/herdr-3d/internal/gitremote"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
	"github.com/JeffreyVdb/herdr-3d/internal/watch"
)

// Environment variables mirroring the flags (a flag wins over its variable).
const (
	EnvSocket     = "HERDR_WORLD_SOCKET"
	EnvDB         = "HERDR_WORLD_DB"
	EnvHerdr      = "HERDR_WORLD_HERDR"
	EnvSessions   = "HERDR_WORLD_SESSIONS"
	EnvPoll       = "HERDR_WORLD_POLL"
	EnvResnapshot = "HERDR_WORLD_RESNAPSHOT"
	EnvMaxDesks   = "HERDR_WORLD_MAX_DESKS"
	EnvNameHold   = "HERDR_WORLD_NAME_HOLD"
	EnvSystemdRun = "HERDR_WORLD_SYSTEMD_RUN"
	EnvWakeTime   = "HERDR_WORLD_WAKE_TIMEOUT"
	EnvResumeTime = "HERDR_WORLD_RESUME_TIMEOUT"
	EnvCodex      = "HERDR_WORLD_CODEX_SESSIONS"
	EnvGit        = "HERDR_WORLD_GIT"
	EnvGH         = "HERDR_WORLD_GH" // M7 boards
	EnvFloorWarn  = "HERDR_WORLD_WARN_WORKERS_PER_FLOOR"
	EnvFloorMax   = "HERDR_WORLD_MAX_WORKERS_PER_FLOOR"
	EnvHostWarn   = "HERDR_WORLD_WARN_WORKERS"
	EnvHostMax    = "HERDR_WORLD_MAX_WORKERS"
	EnvLogLevel   = "HERDR_WORLD_LOG_LEVEL"
	EnvLogFormat  = "HERDR_WORLD_LOG_FORMAT"
	// M5 usage.
	EnvClaudeProjects = "HERDR_WORLD_CLAUDE_PROJECTS"
	EnvPricing        = "HERDR_WORLD_PRICING"
)

// M6 runs: write-code's runs directory (the contract names this variable).
const EnvRunsDir = "H3D_RUNS_DIR"

// DefaultRunsDir is $XDG_STATE_HOME/write-code/runs (~/.local/state/…).
func DefaultRunsDir() string {
	dir := os.Getenv("XDG_STATE_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(dir, "write-code", "runs")
}

// M5 term: the laptops' caps.
const (
	EnvMaxWatches   = "HERDR_WORLD_MAX_WATCHES"
	EnvMaxObservers = "HERDR_WORLD_MAX_OBSERVERS"
)

const worldUsage = `usage:
  %[1]s [serve] [flags]          run the bridge (default)
  %[1]s dump [flags]             print the world snapshot, then events, as JSON lines
  %[1]s cmd [flags] TYPE [ARGS]  send one command (ARGS is a JSON object) and print the reply
  %[1]s -version

Run "%[1]s <subcommand> -h" for its flags.
`

// World is the entry point of herdr-world. It returns the exit code.
func World(name string, args []string, stdout, stderr io.Writer) int {
	sub := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub, args = args[0], args[1:]
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var err error
	switch sub {
	case "serve":
		err = serveMain(ctx, name, args, stdout, stderr)
	case "dump":
		err = dumpMain(ctx, name, args, stdout, stderr)
	case "cmd":
		err = cmdMain(ctx, name, args, stdout, stderr)
	case "help":
		fmt.Fprintf(stdout, worldUsage, name)
		return 0
	default:
		fmt.Fprintf(stderr, "%s: unknown subcommand %q\n", name, sub)
		fmt.Fprintf(stderr, worldUsage, name)
		return 2
	}
	var exit exitError
	switch {
	case err == nil:
		return 0
	case errors.Is(err, flag.ErrHelp):
		return 0
	case errors.As(err, &exit):
		return int(exit)
	default:
		fmt.Fprintf(stderr, "%s: %v\n", name, err)
		return 1
	}
}

// exitError is a quiet non-zero exit (the message was already printed).
type exitError int

func (e exitError) Error() string { return "exit " + strconv.Itoa(int(e)) }

// DefaultSocket is $XDG_RUNTIME_DIR/herdr-world/bridge.sock.
func DefaultSocket() string {
	dir := os.Getenv("XDG_RUNTIME_DIR")
	if dir == "" {
		dir = filepath.Join("/run/user", strconv.Itoa(os.Getuid()))
	}
	return filepath.Join(dir, "herdr-world", "bridge.sock")
}

// DefaultDB is $XDG_STATE_HOME/herdr-world/world.db (~/.local/state/…).
func DefaultDB() string {
	dir := os.Getenv("XDG_STATE_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(dir, "herdr-world", "world.db")
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envDuration(key string, def time.Duration) (time.Duration, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return d, nil
}

func envInt(key string, def int) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return n, nil
}

func newFlagSet(name, sub string, stderr io.Writer) *flag.FlagSet {
	fs := flag.NewFlagSet(name+" "+sub, flag.ContinueOnError)
	fs.SetOutput(stderr)
	return fs
}

func usageError(err error) error {
	if errors.Is(err, flag.ErrHelp) {
		return err
	}
	return exitError(2)
}

func serveMain(ctx context.Context, name string, args []string, stdout, stderr io.Writer) error {
	poll, err := envDuration(EnvPoll, 2*time.Second)
	if err != nil {
		return err
	}
	resnap, err := envDuration(EnvResnapshot, 30*time.Second)
	if err != nil {
		return err
	}
	maxDesks, err := envInt(EnvMaxDesks, server.DefaultMaxDesks)
	if err != nil {
		return err
	}
	nameHold, err := envDuration(EnvNameHold, server.DefaultNameHold)
	if err != nil {
		return err
	}
	wakeTimeout, err := envDuration(EnvWakeTime, server.DefaultWakeTimeout)
	if err != nil {
		return err
	}
	resumeTimeout, err := envDuration(EnvResumeTime, server.DefaultResumeTimeout)
	if err != nil {
		return err
	}
	caps := server.DefaultCaps
	for _, c := range []struct {
		env string
		v   *int
	}{{EnvFloorWarn, &caps.FloorSoft}, {EnvFloorMax, &caps.FloorHard}, {EnvHostWarn, &caps.HostSoft}, {EnvHostMax, &caps.HostHard}} {
		if *c.v, err = envInt(c.env, *c.v); err != nil {
			return err
		}
	}
	// M5 term
	maxWatches, err := envInt(EnvMaxWatches, server.DefaultMaxWatches)
	if err != nil {
		return err
	}
	maxObservers, err := envInt(EnvMaxObservers, server.DefaultMaxObservers)
	if err != nil {
		return err
	}
	fs := newFlagSet(name, "serve", stderr)
	socket := fs.String("socket", envOr(EnvSocket, DefaultSocket()), "unix socket to serve on ($"+EnvSocket+")")
	db := fs.String("db", envOr(EnvDB, DefaultDB()), "SQLite database ($"+EnvDB+")")
	herdrBin := fs.String("herdr", envOr(EnvHerdr, "herdr"), "herdr executable ($"+EnvHerdr+")")
	systemdRun := fs.String("systemd-run", envOr(EnvSystemdRun, "systemd-run"), "systemd-run executable, to wake floors ($"+EnvSystemdRun+")")
	gitBin := fs.String("git", envOr(EnvGit, "git"), "git executable, for worktree hires and send-home checks ($"+EnvGit+")")
	ghBin := fs.String("gh", envOr(EnvGH, "gh"), "gh executable, for the issue and pull request boards ($"+EnvGH+")") // M7 boards
	codexSessions := fs.String("codex-sessions", envOr(EnvCodex, codex.DefaultSessionsDir()), "Codex rollout directory, for the sleep backfill and usage ($"+EnvCodex+")")
	claudeProjects := fs.String("claude-projects", envOr(EnvClaudeProjects, usage.DefaultClaudeProjects()), "Claude Code transcript directory, for usage ($"+EnvClaudeProjects+")")
	runsDir := fs.String("runs-dir", envOr(EnvRunsDir, DefaultRunsDir()), "write-code runs directory, for the freelancers' reports ($"+EnvRunsDir+")") // M6 runs
	pricingFile := fs.String("pricing", os.Getenv(EnvPricing), "JSON file of model prices merged over the built-in table ($"+EnvPricing+")")
	sessions := fs.String("sessions", os.Getenv(EnvSessions), "only watch sessions whose name matches this regexp ($"+EnvSessions+")")
	fs.DurationVar(&poll, "poll", poll, "session discovery interval ($"+EnvPoll+")")
	fs.DurationVar(&resnap, "resnapshot", resnap, "safety re-snapshot interval per session ($"+EnvResnapshot+")")
	fs.IntVar(&maxDesks, "max-desks", maxDesks, "most desks a floor renders beyond its occupied ones ($"+EnvMaxDesks+")")
	fs.DurationVar(&nameHold, "name-hold", nameHold, "how long a worker's name stays held after it leaves its floor ($"+EnvNameHold+")")
	fs.DurationVar(&wakeTimeout, "wake-timeout", wakeTimeout, "how long a woken server has to start, answer ping and be seen running ($"+EnvWakeTime+")")
	fs.DurationVar(&resumeTimeout, "resume-timeout", resumeTimeout, "how long a wake waits for the agents, before the fallback and again for it ($"+EnvResumeTime+")")
	fs.IntVar(&caps.FloorSoft, "warn-workers-per-floor", caps.FloorSoft, "workers on a floor above which the hire dialog warns ($"+EnvFloorWarn+")")
	fs.IntVar(&caps.FloorHard, "max-workers-per-floor", caps.FloorHard, "most workers a floor may be hired up to ($"+EnvFloorMax+")")
	fs.IntVar(&caps.HostSoft, "warn-workers", caps.HostSoft, "workers on the host above which the hire dialog warns ($"+EnvHostWarn+")")
	fs.IntVar(&caps.HostHard, "max-workers", caps.HostHard, "most workers the host may be hired up to ($"+EnvHostMax+")")
	fs.IntVar(&maxWatches, "max-watches", maxWatches, "most laptop screens one connection may watch ($"+EnvMaxWatches+")")
	fs.IntVar(&maxObservers, "max-observers", maxObservers, "most laptop screens watched at once, host-wide ($"+EnvMaxObservers+")")
	level := fs.String("log-level", envOr(EnvLogLevel, "info"), "debug, info, warn or error ($"+EnvLogLevel+")")
	format := fs.String("log-format", envOr(EnvLogFormat, "text"), "text or json ($"+EnvLogFormat+")")
	showVersion := fs.Bool("version", false, "print version and exit")
	if err := fs.Parse(args); err != nil {
		return usageError(err)
	}
	if *showVersion {
		fmt.Fprintln(stdout, Banner(name))
		return nil
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("serve takes no arguments, got %q", fs.Args())
	}
	if maxDesks < 1 {
		return fmt.Errorf("-max-desks must be at least 1, got %d", maxDesks)
	}
	if nameHold <= 0 {
		return fmt.Errorf("-name-hold must be positive, got %s", nameHold)
	}
	if wakeTimeout <= 0 || resumeTimeout <= 0 {
		return fmt.Errorf("-wake-timeout and -resume-timeout must be positive, got %s and %s", wakeTimeout, resumeTimeout)
	}
	if caps.FloorHard < 1 || caps.HostHard < 1 || caps.FloorSoft < 0 || caps.HostSoft < 0 ||
		caps.FloorSoft > caps.FloorHard || caps.HostSoft > caps.HostHard {
		return fmt.Errorf("worker caps: want 0 <= warn <= max and max >= 1, got per floor %d/%d, host %d/%d",
			caps.FloorSoft, caps.FloorHard, caps.HostSoft, caps.HostHard)
	}
	if maxWatches < 1 || maxObservers < 1 {
		return fmt.Errorf("-max-watches and -max-observers must be at least 1, got %d and %d", maxWatches, maxObservers)
	}
	log, err := newLogger(stderr, *level, *format)
	if err != nil {
		return err
	}
	pricing := usage.DefaultPricing()
	if *pricingFile != "" {
		if pricing, err = usage.LoadPricing(*pricingFile); err != nil {
			return fmt.Errorf("-pricing: %w", err)
		}
	}
	var only *regexp.Regexp
	if *sessions != "" {
		if only, err = regexp.Compile(*sessions); err != nil {
			return fmt.Errorf("-sessions: %w", err)
		}
	}
	return Serve(ctx, ServeConfig{
		Socket: *socket, DB: *db, Herdr: &herdr.Client{Bin: *herdrBin}, Only: only,
		Poll: poll, Resnapshot: resnap, MaxDesks: maxDesks, NameHold: nameHold, Log: log, Name: name,
		Control:     &herdr.Control{Herdr: *herdrBin, SystemdRun: *systemdRun, Only: only},
		WakeTimeout: wakeTimeout, ResumeTimeout: resumeTimeout, CodexSessions: *codexSessions,
		RepoOf: (&gitremote.Resolver{Git: *gitBin}).Repo, Git: &gitops.Git{Bin: *gitBin}, Caps: caps,
		ClaudeProjects: *claudeProjects, Pricing: pricing,
		MaxWatches: maxWatches, MaxObservers: maxObservers,
		RunsDir: *runsDir,                                     // M6 runs
		Boards:  GitHubBoards(&githubcli.Client{Bin: *ghBin}), // M7 boards
	})
}

// ServeConfig configures Serve.
type ServeConfig struct {
	Socket     string
	DB         string
	Herdr      watch.Herdr
	Only       *regexp.Regexp
	Poll       time.Duration
	Resnapshot time.Duration
	Ring       int
	MaxDesks   int           // default server.DefaultMaxDesks
	NameHold   time.Duration // default server.DefaultNameHold
	Log        *slog.Logger
	Name       string
	// Control is the write path that wakes floors and puts them to sleep,
	// hires workers and sends them home (nil: those commands fail). Pings
	// go through Herdr.
	Control *herdr.Control
	// Git runs the git commands of hires and send-homes (nil: no git info,
	// no worktree hires or deletes).
	Git *gitops.Git
	// Caps are the worker caps (zero: server.DefaultCaps).
	Caps server.Caps
	// HireOptions, if set, replaces what can be hired (tests only).
	HireOptions *proto.HireOptions
	// TrustTimeout, SeenTimeout and ExitTimeout: see server.Options.
	TrustTimeout, SeenTimeout, ExitTimeout time.Duration
	// WakeTimeout and ResumeTimeout: see server.Options (0: defaults).
	WakeTimeout, ResumeTimeout time.Duration
	// ResumePoll and ResumeSettle: see server.Options (0: defaults).
	ResumePoll, ResumeSettle time.Duration
	// CodexSessions is the Codex rollout directory for the sleep backfill
	// ("": no backfill).
	CodexSessions string
	// RepoOf finds a directory's GitHub repo for the floor suggestion (nil:
	// no suggestions).
	RepoOf func(ctx context.Context, dir string) string
	// M5 usage: ClaudeProjects is the Claude Code transcript directory; with
	// CodexSessions, where workers' usage is read from ("" and "": no
	// usage). Pricing prices it (nil: the built-in table).
	ClaudeProjects string
	Pricing        *usage.Pricing
	// Ready, if set, is called once the socket is listening.
	Ready func()

	// M5 term: MaxWatches and MaxObservers cap the laptop screens (0:
	// server.DefaultMaxWatches, server.DefaultMaxObservers).
	MaxWatches, MaxObservers int

	// M6 runs: RunsDir is write-code's runs directory, where the
	// freelancers' reports are read ("": no reports); ReportPoll how often
	// (0: server.DefaultReportPoll).
	RunsDir    string
	ReportPoll time.Duration

	// M7 boards: Boards finds the issue tracker and code host of a floor's
	// link (nil: no boards). The poll timings are server.Options' (0:
	// defaults).
	Boards                                                    server.BoardFactory
	BoardWatchPoll, BoardIdlePoll, BoardRefreshMin, BoardTick time.Duration
}

// Serve runs the bridge until ctx is done: store, hub, session watchers and
// the WebSocket server on a private unix socket.
func Serve(ctx context.Context, cfg ServeConfig) error {
	log := cfg.Log
	st, err := store.Open(ctx, cfg.DB)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer st.Close()
	opts := server.Options{Ring: cfg.Ring, MaxDesks: cfg.MaxDesks, NameHold: cfg.NameHold,
		Server: Banner(cfg.Name), Log: log, Sessions: cfg.Only, RepoOf: cfg.RepoOf,
		WakeTimeout: cfg.WakeTimeout, ResumeTimeout: cfg.ResumeTimeout, ResumePoll: cfg.ResumePoll, ResumeSettle: cfg.ResumeSettle}
	if cfg.Control != nil {
		opts.Herdr = floorHerdr{Control: cfg.Control, read: cfg.Herdr}
		opts.Hire = cfg.Control
		opts.Term = cfg.Control // M5 term
	}
	opts.MaxWatches, opts.MaxObservers, opts.PaneSize = cfg.MaxWatches, cfg.MaxObservers, paneSize(cfg.Herdr) // M5 term
	if cfg.Git != nil {
		opts.Git = cfg.Git
		opts.Changes = cfg.Git // M5 usage
		opts.PRGit = cfg.Git   // M7 boards
	}
	if cfg.ClaudeProjects != "" || cfg.CodexSessions != "" { // M5 usage
		opts.Usage = &server.UsageConfig{Roots: usage.Roots{ClaudeProjects: cfg.ClaudeProjects, CodexSessions: cfg.CodexSessions},
			Pricing: cfg.Pricing}
	}
	opts.RunsDir, opts.ReportPoll = cfg.RunsDir, cfg.ReportPoll // M6 runs
	opts.Boards = cfg.Boards                                    // M7 boards
	opts.BoardWatchPoll, opts.BoardIdlePoll, opts.BoardRefreshMin, opts.BoardTick =
		cfg.BoardWatchPoll, cfg.BoardIdlePoll, cfg.BoardRefreshMin, cfg.BoardTick
	opts.Caps, opts.HireOptions, opts.Load = cfg.Caps, cfg.HireOptions, server.HostLoad
	opts.TrustTimeout, opts.SeenTimeout, opts.ExitTimeout = cfg.TrustTimeout, cfg.SeenTimeout, cfg.ExitTimeout
	if dir := cfg.CodexSessions; dir != "" {
		opts.CodexSession = func(cwd string, skip func(string) bool) (string, error) { return codex.FindSession(dir, cwd, skip) }
	}
	hub, err := server.NewHub(ctx, st, opts)
	if err != nil {
		return err
	}
	ln, err := server.Listen(cfg.Socket)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	log.Info("herdr-world starting", "version", Banner(cfg.Name), "socket", cfg.Socket, "db", cfg.DB, "epoch", hub.Epoch())

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	errs := make(chan error, 3)
	run := func(what string, fn func() error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := fn(); err != nil {
				errs <- fmt.Errorf("%s: %w", what, err)
			}
			cancel()
		}()
	}
	run("hub", func() error { return hub.Run(ctx) })
	run("watch", func() error {
		return watch.Run(ctx, watch.Config{
			Herdr: cfg.Herdr, Out: hub.Updates(), Only: cfg.Only, Poll: cfg.Poll, Resnapshot: cfg.Resnapshot, Log: log,
			Rescan: hub.Rescans(),
		})
	})
	run("server", func() error { return server.NewServer(hub, log).Serve(ctx, ln) })
	if cfg.Ready != nil {
		cfg.Ready()
	}
	<-ctx.Done()
	log.Info("herdr-world shutting down")
	wg.Wait()
	close(errs)
	return errors.Join(slicesOf(errs)...)
}

// floorHerdr is server.FloorHerdr: the write path plus read-only pings.
type floorHerdr struct {
	*herdr.Control
	read watch.Herdr
}

func (f floorHerdr) Ping(ctx context.Context, socket string) error {
	_, err := f.read.Ping(ctx, socket)
	return err
}

// paneSize reads a pane's size from its session's layout (read only:
// session.snapshot), the laptop observer's default size.
func paneSize(read watch.Herdr) func(ctx context.Context, socket, pane string) (int, int, bool) {
	return func(ctx context.Context, socket, pane string) (int, int, bool) {
		if read == nil || socket == "" {
			return 0, 0, false
		}
		ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		snap, err := read.Snapshot(ctx, socket)
		if err != nil {
			return 0, 0, false
		}
		return snap.PaneSize(pane)
	}
}

func slicesOf(ch <-chan error) []error {
	var out []error
	for err := range ch {
		out = append(out, err)
	}
	return out
}

func newLogger(w io.Writer, level, format string) (*slog.Logger, error) {
	var lv slog.Level
	if err := lv.UnmarshalText([]byte(level)); err != nil {
		return nil, fmt.Errorf("-log-level: %w", err)
	}
	opts := &slog.HandlerOptions{Level: lv}
	switch format {
	case "text":
		return slog.New(slog.NewTextHandler(w, opts)), nil
	case "json":
		return slog.New(slog.NewJSONHandler(w, opts)), nil
	}
	return nil, fmt.Errorf("-log-format: want text or json, got %q", format)
}

func dumpMain(ctx context.Context, name string, args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet(name, "dump", stderr)
	socket := fs.String("socket", envOr(EnvSocket, DefaultSocket()), "bridge socket ($"+EnvSocket+")")
	once := fs.Bool("once", false, "exit after the snapshot (or the replay)")
	since := fs.Int64("since", -1, "replay events after this seq instead of taking a snapshot (needs -epoch)")
	epoch := fs.String("epoch", "", "bridge epoch the -since seq belongs to (from a previous welcome)")
	if err := fs.Parse(args); err != nil {
		return usageError(err)
	}
	conn, err := dial(ctx, *socket)
	if err != nil {
		return err
	}
	defer conn.CloseNow()
	hello := proto.Hello{Client: "herdr-world-dump/" + Banner(name), Epoch: *epoch}
	if *since >= 0 {
		s := uint64(*since)
		hello.SinceSeq = &s
	}
	welcome, err := conn.Hello(ctx, hello)
	if err != nil {
		return err
	}
	fmt.Fprintf(stderr, "welcome: epoch=%s server_seq=%d resume=%s\n", welcome.Epoch, welcome.ServerSeq, welcome.Resume)
	if *once && welcome.Resume == proto.ResumeReplay && hello.SinceSeq != nil && *hello.SinceSeq == welcome.ServerSeq {
		return nil
	}
	for {
		env, msg, err := conn.Read(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if _, err := fmt.Fprintf(stdout, "%s\n", msg); err != nil {
			return err
		}
		if *once && (env.T == proto.TSnapshot || (welcome.Resume == proto.ResumeReplay && env.Seq >= welcome.ServerSeq)) {
			_ = conn.Close()
			return nil
		}
	}
}

func cmdMain(ctx context.Context, name string, args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet(name, "cmd", stderr)
	socket := fs.String("socket", envOr(EnvSocket, DefaultSocket()), "bridge socket ($"+EnvSocket+")")
	timeout := fs.Duration("timeout", time.Minute, "give up after this long (a floor.wake can take ~30 s)")
	fs.Usage = func() {
		fmt.Fprintf(stderr, "usage: %s cmd [flags] TYPE [ARGS-JSON]\n\ncommands: %s\n\nexamples:\n", name, strings.Join(proto.Commands, ", "))
		fmt.Fprintf(stderr, "  %s cmd building.create '{\"name\":\"Work\"}'\n", name)
		fmt.Fprintf(stderr, "  %s cmd floor.assign '{\"session\":\"herdr-3d\",\"building\":\"b_…\",\"index\":0}'\n", name)
		fmt.Fprintf(stderr, "  %s cmd floor.settings.set '{\"session\":\"herdr-3d\",\"repo\":\"JeffreyVdb/herdr-3d\"}'\n", name)
		fmt.Fprintf(stderr, "  %s cmd floor.sleep '{\"session\":\"h3d-scratch\"}'\n", name)
		fmt.Fprintf(stderr, "  %s cmd worker.hire '{\"session\":\"h3d-scratch\",\"desk_index\":0,\"harness\":\"codex\",\"model\":\"gpt-6-luna\",\"effort\":\"low\"}'\n", name)
		fmt.Fprintf(stderr, "  %s cmd worker.fire '{\"id\":\"…\",\"worktree\":\"keep\"}'\n\nflags:\n", name)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return usageError(err)
	}
	if fs.NArg() < 1 || fs.NArg() > 2 {
		fs.Usage()
		return exitError(2)
	}
	cmd := proto.Command{T: fs.Arg(0), ReqID: "cmd-" + strconv.FormatInt(time.Now().UnixNano(), 36)}
	if fs.NArg() == 2 {
		cmd.Args = json.RawMessage(fs.Arg(1))
		if !json.Valid(cmd.Args) {
			return fmt.Errorf("ARGS is not valid JSON: %s", fs.Arg(1))
		}
	}
	ctx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()
	conn, err := dial(ctx, *socket)
	if err != nil {
		return err
	}
	defer conn.CloseNow()
	if _, err := conn.Hello(ctx, proto.Hello{Client: "herdr-world-cmd/" + Banner(name)}); err != nil {
		return err
	}
	if err := conn.Send(ctx, cmd); err != nil {
		return err
	}
	for {
		env, msg, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		if env.ReqID != cmd.ReqID || (env.T != proto.TAck && env.T != proto.TError) {
			continue // snapshot and events
		}
		fmt.Fprintf(stdout, "%s\n", msg)
		_ = conn.Close()
		if env.T == proto.TError {
			return exitError(1)
		}
		return nil
	}
}

func dial(ctx context.Context, socket string) (*proto.Conn, error) {
	dctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	conn, err := proto.Dial(dctx, socket)
	if err != nil {
		return nil, fmt.Errorf("is herdr-world running? %w", err)
	}
	return conn, nil
}
