package app

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/claudechild"
	"github.com/JeffreyVdb/herdr-3d/internal/codex"
	"github.com/JeffreyVdb/herdr-3d/internal/codexaccount"
	"github.com/JeffreyVdb/herdr-3d/internal/codexchild"
	"github.com/JeffreyVdb/herdr-3d/internal/execpath"
	"github.com/JeffreyVdb/herdr-3d/internal/fileindex"
	"github.com/JeffreyVdb/herdr-3d/internal/githubcli"
	"github.com/JeffreyVdb/herdr-3d/internal/gitops"
	"github.com/JeffreyVdb/herdr-3d/internal/gitremote"
	"github.com/JeffreyVdb/herdr-3d/internal/handoff"
	"github.com/JeffreyVdb/herdr-3d/internal/harness"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/hoststats"
	"github.com/JeffreyVdb/herdr-3d/internal/imgcache"
	"github.com/JeffreyVdb/herdr-3d/internal/kaneoconf"
	"github.com/JeffreyVdb/herdr-3d/internal/limits"
	"github.com/JeffreyVdb/herdr-3d/internal/notify"
	"github.com/JeffreyVdb/herdr-3d/internal/notify/telegram"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/repodisc"
	"github.com/JeffreyVdb/herdr-3d/internal/screenshare"
	"github.com/JeffreyVdb/herdr-3d/internal/secretfiles"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/shell"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
	"github.com/JeffreyVdb/herdr-3d/internal/upload"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
	"github.com/JeffreyVdb/herdr-3d/internal/watch"
	"github.com/JeffreyVdb/herdr-3d/internal/whiteboard"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// Environment variables mirroring the flags (a flag wins over its variable).
const (
	EnvSocket     = "HERDR_WORLD_SOCKET"
	EnvDB         = "HERDR_WORLD_DB"
	EnvHerdr      = "HERDR_WORLD_HERDR"
	EnvCodexCLI   = "HERDR_WORLD_CODEX_CLI"
	EnvClaudeCLI  = "HERDR_WORLD_CLAUDE_CLI"
	EnvSessions   = "HERDR_WORLD_SESSIONS"
	EnvPoll       = "HERDR_WORLD_POLL"
	EnvResnapshot = "HERDR_WORLD_RESNAPSHOT"
	EnvMaxDesks   = "HERDR_WORLD_MAX_DESKS"
	EnvNameHold   = "HERDR_WORLD_NAME_HOLD"
	EnvSystemdRun = "HERDR_WORLD_SYSTEMD_RUN"
	EnvWakeTime   = "HERDR_WORLD_WAKE_TIMEOUT"
	EnvResumeTime = "HERDR_WORLD_RESUME_TIMEOUT"
	EnvWrapUpTime = "HERDR_WORLD_WRAPUP_TIMEOUT"
	EnvCodex      = "HERDR_WORLD_CODEX_SESSIONS"
	EnvGit        = "HERDR_WORLD_GIT"
	EnvGH         = "HERDR_WORLD_GH"     // M7 boards
	EnvRG         = "HERDR_WORLD_RG"     // #137 worker.files
	EnvClaude     = "HERDR_WORLD_CLAUDE" // M10 limits
	EnvCodexBin   = "HERDR_WORLD_CODEX"  // M10 limits
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

// M13 screen share: where grabbed frames are stored (default
// screenshare.DefaultDir: $XDG_RUNTIME_DIR/herdr-world/screen, tmpfs).
const EnvScreenDir = "HERDR_WORLD_SCREEN_DIR"

// #108 prompt secrets: where protected prompt secrets are kept (default
// secretfiles.DefaultDir: $XDG_RUNTIME_DIR/herdr-world/secrets, tmpfs).
const EnvSecretsDir = "HERDR_WORLD_SECRETS_DIR"

// EnvCodexRun names the private directory of the shared Codex servers'
// launchers and sockets (#155).
const EnvCodexRun = "HERDR_WORLD_CODEX_RUN"

// EnvShell names the shell policy (#68): bash (the default) or fish. It picks
// the login shell that starts a woken floor's herdr server and the shell
// that runs a shared Codex worker's launcher. $SHELL is never read.
const EnvShell = "HERDR_WORLD_SHELL"

// DefaultCodexRun is $XDG_RUNTIME_DIR/herdr-world/codex (#155): short, so a
// worker's socket path stays under the 108-byte limit.
func DefaultCodexRun() string {
	return filepath.Join(filepath.Dir(DefaultSocket()), "codex")
}

// #92 AI integration: the settings the bridge environment fixes (read-only in
// the game's panel). The keys are files, so a key never sits in the
// environment; the stored settings and keys are one 0600 file next to the
// database.
const (
	EnvAIFile              = "HERDR_WORLD_AI_FILE"
	EnvAIClassifierKeyFile = "HERDR_WORLD_AI_CLASSIFIER_KEY_FILE"
	EnvAIClassifierModel   = "HERDR_WORLD_AI_CLASSIFIER_MODEL"
	EnvAILLMBaseURL        = "HERDR_WORLD_AI_LLM_BASE_URL"
	EnvAILLMKeyFile        = "HERDR_WORLD_AI_LLM_KEY_FILE"
	EnvAILLMModel          = "HERDR_WORLD_AI_LLM_MODEL"
)

// #90 follow-up questions: the environment's toggle (true or false; unset:
// the panel's). While set it wins and the panel shows it read-only.
const EnvFollowupsEnabled = "HERDR_WORLD_FOLLOWUPS_ENABLED"

// #110 pack up on request: the environment's toggle (true or false; unset:
// the panel's). While set it wins and the panel shows it read-only.
const EnvPackupEnabled = "HERDR_WORLD_PACKUP_ENABLED"

// #66 schedule suggestions: the environment's toggle (true or false; unset:
// the panel's). While set it wins and the panel shows it read-only.
const EnvScheduleSuggestionsEnabled = "HERDR_WORLD_SCHEDULE_SUGGESTIONS_ENABLED"

// #118 phase 2 floor overview summaries: the environment's toggle (true or
// false; unset: the panel's). While set it wins and the panel shows it
// read-only; the LLM must still be ready.
const EnvDigestEnabled = "HERDR_WORLD_DIGEST_ENABLED"

// #9 LLM handoffs: the environment's toggle (true or false; unset: the
// panel's). While set it wins, needs no test and the panel shows it
// read-only; the LLM must still be ready.
const EnvHandoffLLMEnabled = "HERDR_WORLD_HANDOFF_LLM_ENABLED"

// #98 activity: the environment's "Classify unknown commands" toggle (true
// or false; unset: the panel's). While set it wins and the panel shows it
// read-only.
const EnvActivityModel = "HERDR_WORLD_ACTIVITY_MODEL"

// DefaultAIFile is ai.json next to the database.
func DefaultAIFile(db string) string { return filepath.Join(filepath.Dir(db), "ai.json") }

// #184 Kaneo: the connection's settings and key, one 0600 file of its own
// next to the database (not the AI integration's).
const EnvKaneoFile = "HERDR_WORLD_KANEO_FILE"

// DefaultKaneoFile is kaneo.json next to the database.
func DefaultKaneoFile(db string) string { return filepath.Join(filepath.Dir(db), "kaneo.json") }

// #11 notifications: the Telegram bot token and the paired person, one 0600
// file of their own next to the database; the token may come from a file
// the environment names instead (then the panel cannot change it). The
// environment's switch (true or false; unset: the panel's) wins while set.
const (
	EnvTelegramFile    = "HERDR_WORLD_TELEGRAM_FILE"
	EnvTelegramKeyFile = "HERDR_WORLD_TELEGRAM_KEY_FILE"
	EnvNotifyEnabled   = "HERDR_WORLD_NOTIFY_ENABLED"
)

// DefaultTelegramFile is telegram.json next to the database.
func DefaultTelegramFile(db string) string { return filepath.Join(filepath.Dir(db), "telegram.json") }

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

// #23 Claude subagents: the directory of the bridge's own Claude Code hook
// settings and their log ("-": no hooks, the transcripts alone).
const EnvClaudeHooks = "HERDR_WORLD_CLAUDE_HOOKS"

// DefaultClaudeHooks is claude-hooks next to the database.
func DefaultClaudeHooks(db string) string { return filepath.Join(filepath.Dir(db), "claude-hooks") }

// #223 handoffs: the filing cabinet's directory.
const EnvHandoffDir = "HERDR_WORLD_HANDOFF_DIR"

// DefaultHandoffDir is ~/handoff.
func DefaultHandoffDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "/"
	}
	return filepath.Join(home, "handoff")
}

// #51 image upload: Drop Zone's base URL. The bridge is its only client; a
// browser never names an upstream.
const (
	EnvDropzoneURL     = "HERDR_WORLD_DROPZONE_URL"
	DefaultDropzoneURL = "http://127.0.0.1:8080"
)

// M16 phase 2: the images of the transcripts. Drop Zone's data directory
// is where #13/#51's [Image #n: path] markers point; only under it (and
// the other roots in docs/protocol.md "Laptops: transcript") is a path read.
const (
	EnvDropzoneData = "HERDR_WORLD_DROPZONE_DATA"
	EnvImageCache   = "HERDR_WORLD_IMAGE_CACHE"
)

// DefaultDropzoneData is $DROPZONE_DATA (Drop Zone's own variable), else ~/drops.
func DefaultDropzoneData() string {
	if d := os.Getenv("DROPZONE_DATA"); d != "" {
		return d
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, "drops")
	}
	return ""
}

// transcriptImages builds the images the transcripts are read with: the
// bounded content-addressed cache (with a 0700 disk directory unless
// cacheDir is "-") and the roots path images may be under.
func transcriptImages(log *slog.Logger, dropzoneData, cacheDir, codexSessions string) *transcript.Images {
	var roots []string
	if dropzoneData != "" {
		roots = append(roots, dropzoneData)
	}
	codexHome := filepath.Dir(codexSessions)
	if codexSessions == "" {
		codexHome = filepath.Dir(codex.DefaultSessionsDir())
	}
	roots = append(roots, filepath.Join(codexHome, "generated_images"))
	dir := cacheDir
	switch dir {
	case "":
		dir = imgcache.DefaultDir()
	case "-":
		dir = ""
	}
	cache, err := imgcache.New(imgcache.Config{Dir: dir})
	if err != nil {
		log.Warn("image disk cache off", "dir", dir, "err", err)
		cache, _ = imgcache.New(imgcache.Config{})
	}
	return &transcript.Images{Cache: cache, Roots: roots}
}

// M13 whiteboard: where the floors' boards are kept.
const EnvWhiteboards = "HERDR_WORLD_WHITEBOARDS"

// M5 term: the laptops' caps.
const (
	EnvMaxWatches   = "HERDR_WORLD_MAX_WATCHES"
	EnvMaxObservers = "HERDR_WORLD_MAX_OBSERVERS"
)

// M16 transcript: the transcript watches' cap.
const EnvMaxTranscriptWatches = "HERDR_WORLD_MAX_TRANSCRIPT_WATCHES"

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

// resolveShell reads the shell policy (an explicit value, else bash: never
// $SHELL, and never whichever shell happens to be installed) and finds its
// executable. A shell that is not installed refuses the start with the option
// to change, instead of failing at the first wake.
func resolveShell(configured string) (shell.Kind, string, error) {
	kind, err := shell.Parse(configured)
	if err != nil {
		return "", "", fmt.Errorf("-shell: %w", err)
	}
	bin, err := shell.Resolve(kind)
	if err != nil {
		return "", "", fmt.Errorf("-shell: %w", err)
	}
	return kind, bin, nil
}

// orNone is v, "" for "-".
func orNone(v string) string {
	if v == "-" {
		return ""
	}
	return v
}

func orDefault(v, def string) string {
	if v != "" {
		return v
	}
	return def
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
	wrapUpTimeout, err := envDuration(EnvWrapUpTime, server.DefaultWrapUpTimeout) // #83
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
	maxTxWatches, err := envInt(EnvMaxTranscriptWatches, server.DefaultMaxTranscriptWatches) // M16 transcript
	if err != nil {
		return err
	}
	fs := newFlagSet(name, "serve", stderr)
	socket := fs.String("socket", envOr(EnvSocket, DefaultSocket()), "unix socket to serve on ($"+EnvSocket+")")
	db := fs.String("db", envOr(EnvDB, DefaultDB()), "SQLite database ($"+EnvDB+")")
	herdrBin := fs.String("herdr", envOr(EnvHerdr, "herdr"), "herdr executable ($"+EnvHerdr+")")
	systemdRun := fs.String("systemd-run", envOr(EnvSystemdRun, "systemd-run"), "systemd-run executable, to wake floors ($"+EnvSystemdRun+")")
	gitBin := fs.String("git", envOr(EnvGit, "git"), "git executable, for worktree hires and send-home checks ($"+EnvGit+")")
	ghBin := fs.String("gh", envOr(EnvGH, "gh"), "gh executable, for the issue and pull request boards ($"+EnvGH+")")           // M7 boards
	rgBin := fs.String("rg", envOr(EnvRG, "rg"), "rg executable, to list a worker's files outside git ($"+EnvRG+")")            // #137 worker.files
	claudeBin := fs.String("claude", envOr(EnvClaude, "claude"), "claude executable, to read the plan limits ($"+EnvClaude+")") // M10 limits
	codexBin := fs.String("codex", envOr(EnvCodexBin, "codex"), "codex executable, to read the plan limits ($"+EnvCodexBin+")") // M10 limits
	noLimits := fs.Bool("no-limits", false, "do not read the Claude and Codex plan limits")                                     // M10 limits
	codexSessions := fs.String("codex-sessions", envOr(EnvCodex, codex.DefaultSessionsDir()), "Codex rollout directory, for the sleep backfill and usage ($"+EnvCodex+")")
	claudeProjects := fs.String("claude-projects", envOr(EnvClaudeProjects, usage.DefaultClaudeProjects()), "Claude Code transcript directory, for usage ($"+EnvClaudeProjects+")")
	claudeHooks := fs.String("claude-hooks", os.Getenv(EnvClaudeHooks), "directory of the bridge's own Claude Code hook settings and log, passed to the Claude workers it starts, \"-\" for none (default claude-hooks next to the database) (#23) ($"+EnvClaudeHooks+")")
	codexCLI := fs.String("codex-cli", envOr(EnvCodexCLI, "codex"), "Codex binary for model and command discovery ($"+EnvCodexCLI+")")
	claudeCLI := fs.String("claude-cli", envOr(EnvClaudeCLI, "claude"), "Claude Code binary for model and command discovery ($"+EnvClaudeCLI+")")
	runsDir := fs.String("runs-dir", envOr(EnvRunsDir, DefaultRunsDir()), "write-code runs directory, for the freelancers' reports ($"+EnvRunsDir+")")                                                       // M6 runs
	dropzoneURL := fs.String("dropzone-url", envOr(EnvDropzoneURL, DefaultDropzoneURL), "Drop Zone URL, where pasted images are uploaded ($"+EnvDropzoneURL+")")                                             // #51 upload
	dropzoneData := fs.String("dropzone-data", envOr(EnvDropzoneData, DefaultDropzoneData()), "Drop Zone's data directory: a root a transcript's [Image #n: path] may be read under ($"+EnvDropzoneData+")") // M16 images
	imageCache := fs.String("image-cache", os.Getenv(EnvImageCache), "directory of the transcript image disk cache, \"-\" for none (default $XDG_CACHE_HOME/herdr-world/img) ($"+EnvImageCache+")")          // M16 images
	codexRun := fs.String("codex-run", envOr(EnvCodexRun, DefaultCodexRun()), "private directory of the shared Codex servers' launchers and sockets, \"-\" for none (#155) ($"+EnvCodexRun+")")
	shellPolicy := fs.String("shell", os.Getenv(EnvShell), "shell of woken floors' login environment and of the shared Codex launchers: bash (the default) or fish, an explicit compatibility option; $SHELL is never used ($"+EnvShell+")")
	screenDir := fs.String("screen-dir", os.Getenv(EnvScreenDir), "private directory (tmpfs) for screen-share frames (default $XDG_RUNTIME_DIR/herdr-world/screen) ($"+EnvScreenDir+")")                      // M13 screen
	secretsDir := fs.String("secrets-dir", os.Getenv(EnvSecretsDir), "private directory (tmpfs) for protected prompt secrets (default $XDG_RUNTIME_DIR/herdr-world/secrets) ($"+EnvSecretsDir+")")            // #108
	handoffDir := fs.String("handoff-dir", envOr(EnvHandoffDir, DefaultHandoffDir()), "directory of the filing cabinet's handoffs (<dir>/<floor>/*.md), \"-\" for none ($"+EnvHandoffDir+")")                 // #223
	whiteboards := fs.String("whiteboards", envOr(EnvWhiteboards, whiteboard.DefaultRoot()), "directory of the floors' whiteboards, \"-\" for none ($"+EnvWhiteboards+")")                                    // M13 whiteboard
	aiFile := fs.String("ai-file", os.Getenv(EnvAIFile), "file of the AI integration's settings and keys, 0600 (default ai.json next to the database) ($"+EnvAIFile+")")                                      // #92
	kaneoFile := fs.String("kaneo-file", os.Getenv(EnvKaneoFile), "file of the Kaneo connection's settings and key, 0600 (default kaneo.json next to the database) ($"+EnvKaneoFile+")")                      // #184
	telegramFile := fs.String("telegram-file", os.Getenv(EnvTelegramFile), "file of the Telegram bot token and the paired account, 0600 (default telegram.json next to the database) ($"+EnvTelegramFile+")") // #11
	telegramKey := fs.String("telegram-key-file", os.Getenv(EnvTelegramKeyFile), "file holding the Telegram bot token; overrides the panel's ($"+EnvTelegramKeyFile+")")                                      // #11
	notifyEnabled := fs.String("notify-enabled", os.Getenv(EnvNotifyEnabled), "true or false: switch the Telegram notifications on or off, overriding the panel's toggle ($"+EnvNotifyEnabled+")")            // #11
	aiClsKey := fs.String("ai-classifier-key-file", os.Getenv(EnvAIClassifierKeyFile), "file holding the classification model's key; overrides the panel's ($"+EnvAIClassifierKeyFile+")")
	aiClsModel := fs.String("ai-classifier-model", os.Getenv(EnvAIClassifierModel), "classification model; overrides the panel's ($"+EnvAIClassifierModel+")")
	aiLLMBase := fs.String("ai-llm-base-url", os.Getenv(EnvAILLMBaseURL), "OpenAI-compatible endpoint's base URL; overrides the panel's ($"+EnvAILLMBaseURL+")")
	aiLLMKey := fs.String("ai-llm-key-file", os.Getenv(EnvAILLMKeyFile), "file holding the LLM's key; overrides the panel's ($"+EnvAILLMKeyFile+")")
	aiLLMModel := fs.String("ai-llm-model", os.Getenv(EnvAILLMModel), "LLM model; overrides the panel's ($"+EnvAILLMModel+")")
	followupsEnabled := fs.String("followups-enabled", os.Getenv(EnvFollowupsEnabled), "true or false: switch the follow-up questions on or off, overriding the panel's toggle ($"+EnvFollowupsEnabled+")")                                           // #90
	packupEnabled := fs.String("packup-enabled", os.Getenv(EnvPackupEnabled), "true or false: switch pack up on request on or off, overriding the panel's toggle ($"+EnvPackupEnabled+")")                                                            // #110
	scheduleSuggestionsEnabled := fs.String("schedule-suggestions-enabled", os.Getenv(EnvScheduleSuggestionsEnabled), "true or false: switch the schedule suggestions on or off, overriding the panel's toggle ($"+EnvScheduleSuggestionsEnabled+")") // #66
	digestEnabled := fs.String("digest-enabled", os.Getenv(EnvDigestEnabled), "true or false: switch the floor overview summaries on or off, overriding the panel's toggle ($"+EnvDigestEnabled+")")                                                  // #118
	handoffLLMEnabled := fs.String("handoff-llm-enabled", os.Getenv(EnvHandoffLLMEnabled), "true or false: switch LLM handoffs on or off, overriding the panel's toggle ($"+EnvHandoffLLMEnabled+")")                                                 // #9
	activityModel := fs.String("activity-model", os.Getenv(EnvActivityModel), "true or false: switch \"Classify unknown commands\" on or off, overriding the panel's toggle ($"+EnvActivityModel+")")                                                 // #98
	pricingFile := fs.String("pricing", os.Getenv(EnvPricing), "JSON file of model prices merged over the built-in table ($"+EnvPricing+")")
	sessions := fs.String("sessions", os.Getenv(EnvSessions), "only watch sessions whose name matches this regexp ($"+EnvSessions+")")
	fs.DurationVar(&poll, "poll", poll, "session discovery interval ($"+EnvPoll+")")
	fs.DurationVar(&resnap, "resnapshot", resnap, "safety re-snapshot interval per session ($"+EnvResnapshot+")")
	fs.IntVar(&maxDesks, "max-desks", maxDesks, "most desks a floor renders beyond its occupied ones ($"+EnvMaxDesks+")")
	fs.DurationVar(&nameHold, "name-hold", nameHold, "how long a worker's name stays held after it leaves its floor ($"+EnvNameHold+")")
	fs.DurationVar(&wakeTimeout, "wake-timeout", wakeTimeout, "how long a woken server has to start, answer ping and be seen running ($"+EnvWakeTime+")")
	fs.DurationVar(&resumeTimeout, "resume-timeout", resumeTimeout, "how long a wake waits for the agents, before the fallback and again for it ($"+EnvResumeTime+")")
	fs.DurationVar(&wrapUpTimeout, "wrapup-timeout", wrapUpTimeout, "how long an armed wrap-up waits for the agent's result line before it needs you ($"+EnvWrapUpTime+")")
	fs.IntVar(&caps.FloorSoft, "warn-workers-per-floor", caps.FloorSoft, "workers on a floor above which the hire dialog warns ($"+EnvFloorWarn+")")
	fs.IntVar(&caps.FloorHard, "max-workers-per-floor", caps.FloorHard, "most workers a floor may be hired up to ($"+EnvFloorMax+")")
	fs.IntVar(&caps.HostSoft, "warn-workers", caps.HostSoft, "workers on the host above which the hire dialog warns ($"+EnvHostWarn+")")
	fs.IntVar(&caps.HostHard, "max-workers", caps.HostHard, "most workers the host may be hired up to ($"+EnvHostMax+")")
	fs.IntVar(&maxWatches, "max-watches", maxWatches, "most laptop screens one connection may watch ($"+EnvMaxWatches+")")
	fs.IntVar(&maxObservers, "max-observers", maxObservers, "most laptop screens watched at once, host-wide ($"+EnvMaxObservers+")")
	fs.IntVar(&maxTxWatches, "max-transcript-watches", maxTxWatches, "most transcripts one connection may watch ($"+EnvMaxTranscriptWatches+")")
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
	shellKind, shellBin, err := resolveShell(*shellPolicy) // #68: refused before anything starts
	if err != nil {
		return err
	}
	if maxDesks < 1 {
		return fmt.Errorf("-max-desks must be at least 1, got %d", maxDesks)
	}
	if nameHold <= 0 {
		return fmt.Errorf("-name-hold must be positive, got %s", nameHold)
	}
	var followupsOn *bool // #90
	if *followupsEnabled != "" {
		on, err := strconv.ParseBool(*followupsEnabled)
		if err != nil {
			return fmt.Errorf("-followups-enabled must be true or false, got %q", *followupsEnabled)
		}
		followupsOn = &on
	}
	var scheduleSuggestionsOn *bool // #66
	if *scheduleSuggestionsEnabled != "" {
		on, err := strconv.ParseBool(*scheduleSuggestionsEnabled)
		if err != nil {
			return fmt.Errorf("-schedule-suggestions-enabled must be true or false, got %q", *scheduleSuggestionsEnabled)
		}
		scheduleSuggestionsOn = &on
	}
	var packupOn *bool // #110
	if *packupEnabled != "" {
		on, err := strconv.ParseBool(*packupEnabled)
		if err != nil {
			return fmt.Errorf("-packup-enabled must be true or false, got %q", *packupEnabled)
		}
		packupOn = &on
	}
	var digestOn *bool // #118
	if *digestEnabled != "" {
		on, err := strconv.ParseBool(*digestEnabled)
		if err != nil {
			return fmt.Errorf("-digest-enabled must be true or false, got %q", *digestEnabled)
		}
		digestOn = &on
	}
	var notifyOn *bool // #11
	if *notifyEnabled != "" {
		on, err := strconv.ParseBool(*notifyEnabled)
		if err != nil {
			return fmt.Errorf("-notify-enabled must be true or false, got %q", *notifyEnabled)
		}
		notifyOn = &on
	}
	var handoffLLMOn *bool // #9
	if *handoffLLMEnabled != "" {
		on, err := strconv.ParseBool(*handoffLLMEnabled)
		if err != nil {
			return fmt.Errorf("-handoff-llm-enabled must be true or false, got %q", *handoffLLMEnabled)
		}
		handoffLLMOn = &on
	}
	var activityOn *bool // #98
	if *activityModel != "" {
		on, err := strconv.ParseBool(*activityModel)
		if err != nil {
			return fmt.Errorf("-activity-model must be true or false, got %q", *activityModel)
		}
		activityOn = &on
	}
	images, err := upload.New(upload.Config{URL: *dropzoneURL}) // #51 upload
	if err != nil {
		return fmt.Errorf("-dropzone-url: %w", err)
	}
	if wrapUpTimeout <= 0 {
		return fmt.Errorf("-wrapup-timeout must be positive, got %s", wrapUpTimeout)
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
	if maxTxWatches < 1 {
		return fmt.Errorf("-max-transcript-watches must be at least 1, got %d", maxTxWatches)
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
	var lim *limits.Config
	if !*noLimits { // M10 limits
		lim = &limits.Config{ClaudeBin: *claudeBin, CodexBin: *codexBin, CodexSessions: *codexSessions, Log: log}
	}
	if *screenDir == "" { // M13 screen
		dir, fallback, err := screenshare.DefaultDir()
		switch {
		case err != nil:
			log.Warn("no directory for screen-share frames: screen.grab will fail", "err", err)
		case fallback:
			log.Warn("XDG_RUNTIME_DIR is not set: screen-share frames go to the user's runtime directory", "dir", dir)
		}
		*screenDir = dir
	}
	if *secretsDir == "" { // #108
		dir, fallback, err := secretfiles.DefaultDir()
		switch {
		case err != nil:
			log.Warn("no directory for protected prompt secrets: a review that protects one will be refused", "err", err)
		case fallback:
			log.Warn("XDG_RUNTIME_DIR is not set: protected prompt secrets go to the user's runtime directory", "dir", dir)
		}
		*secretsDir = dir
	}
	hireOptions := discoverHireOptions(ctx, log, *codexCLI, *claudeCLI)
	if err := ctx.Err(); err != nil {
		return err
	}
	kaneo, kaneoFloors, err := Kaneo(kaneoconf.Options{File: orDefault(*kaneoFile, DefaultKaneoFile(*db))}) // #184
	if err != nil {
		return fmt.Errorf("kaneo settings: %w", err)
	}
	tg, err := Telegram(telegram.Options{File: orDefault(*telegramFile, DefaultTelegramFile(*db)), KeyFile: *telegramKey, Log: log}) // #11
	if err != nil {
		return fmt.Errorf("telegram settings: %w", err)
	}
	return Serve(ctx, ServeConfig{
		Socket: *socket, DB: *db, Herdr: &herdr.Client{Bin: *herdrBin}, Only: only,
		Poll: poll, Resnapshot: resnap, MaxDesks: maxDesks, NameHold: nameHold, Log: log, Name: name,
		Control:     &herdr.Control{Herdr: *herdrBin, SystemdRun: *systemdRun, Only: only, CodexRun: orNone(*codexRun), Shell: shellKind, ShellBin: shellBin},
		CodexRun:    orNone(*codexRun), // #155 shared Codex server
		WakeTimeout: wakeTimeout, ResumeTimeout: resumeTimeout, WrapUpTimeout: wrapUpTimeout, CodexSessions: *codexSessions,
		RepoOf: (&gitremote.Resolver{Git: *gitBin}).Repo, Git: &gitops.Git{Bin: *gitBin}, Caps: caps,
		ClaudeProjects: *claudeProjects, Pricing: pricing, HireOptions: &hireOptions,
		ClaudeHooks: orDefault(*claudeHooks, DefaultClaudeHooks(*db)), ClaudeCLI: *claudeCLI, CodexCLI: *codexCLI, // #23 hooks; #136 worker.commands
		RG:         *rgBin, // #137 worker.files
		MaxWatches: maxWatches, MaxObservers: maxObservers, MaxTranscriptWatches: maxTxWatches,
		RunsDir:          *runsDir,                                                          // M6 runs
		Boards:           Boards(&githubcli.Client{Bin: *ghBin}, nil, kaneoFloors),          // M7 boards; #184 Kaneo floors
		Kaneo:            kaneo,                                                             // #184
		Limits:           lim,                                                               // M10 limits
		Uploads:          images,                                                            // #51 upload
		TranscriptImages: transcriptImages(log, *dropzoneData, *imageCache, *codexSessions), // M16 images
		ScreenDir:        *screenDir,                                                        // M13 screen
		SecretsDir:       *secretsDir,                                                       // #108 prompt secrets
		Whiteboards:      *whiteboards,                                                      // M13 whiteboard
		HandoffDir:       *handoffDir,                                                       // #223 handoffs
		DropsRoot:        *dropzoneData,                                                     // M13 drops.list
		AI: &ai.Options{File: orDefault(*aiFile, DefaultAIFile(*db)), Env: ai.Overrides{ // #92 AI integration
			ClassifierKeyFile: *aiClsKey, ClassifierModel: *aiClsModel, LLMBaseURL: *aiLLMBase, LLMKeyFile: *aiLLMKey, LLMModel: *aiLLMModel}},
		FollowupsEnabled:           followupsOn,           // #90 follow-up questions
		PackupEnabled:              packupOn,              // #110 pack up on request
		ScheduleSuggestionsEnabled: scheduleSuggestionsOn, // #66 schedule suggestions
		ActivityModel:              activityOn,            // #98 activity
		DigestEnabled:              digestOn,              // #118 floor overview summaries
		HandoffLLMEnabled:          handoffLLMOn,          // #9 LLM handoffs
		Notify:                     tg,                    // #11 notifications
		NotifyEnabled:              notifyOn,
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
	// Hire, if set, replaces Control as the hires' and send-homes' write
	// path (the integration tests: herdr's own, but no agent starts).
	Hire server.HireHerdr
	// Git runs the git commands of hires and send-homes (nil: no git info,
	// no worktree hires or deletes).
	Git *gitops.Git
	// Caps are the worker caps (zero: server.DefaultCaps).
	Caps server.Caps
	// HireOptions, if set, replaces what can be hired (discovered at CLI startup).
	HireOptions *proto.HireOptions
	// #136: ClaudeCLI and CodexCLI are the harness binaries worker.commands
	// probes (both empty: worker.commands is not configured).
	ClaudeCLI, CodexCLI string
	// #137: RG is the rg executable worker.files lists a checkout outside
	// git with (empty: "rg"). worker.files needs Git.
	RG string
	// TrustTimeout, SeenTimeout and ExitTimeout: see server.Options.
	TrustTimeout, SeenTimeout, ExitTimeout time.Duration
	// WakeTimeout and ResumeTimeout: see server.Options (0: defaults).
	WakeTimeout, ResumeTimeout time.Duration
	// WrapUpTimeout: see server.Options (0: the default).
	WrapUpTimeout time.Duration
	// ResumePoll and ResumeSettle: see server.Options (0: defaults).
	ResumePoll, ResumeSettle time.Duration
	// CodexSessions is the Codex rollout directory for the sleep backfill
	// ("": no backfill).
	CodexSessions string
	// RepoOf finds a directory's GitHub repo for the floor suggestion (nil:
	// no suggestions).
	RepoOf func(ctx context.Context, dir string) string
	// #23: ClaudeHooks is the directory of the bridge's Claude hook settings
	// and their log ("" or "-": no hooks). With ClaudeProjects, the Claude
	// workers' subagents are read from their transcripts either way.
	ClaudeHooks string
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

	// M16 transcript: MaxTranscriptWatches caps one connection's transcript
	// watches (0: server.DefaultMaxTranscriptWatches).
	MaxTranscriptWatches int

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

	// M10 limits: reads the Claude and Codex plan limits while a client is
	// connected (nil: none).
	Limits *limits.Config

	// #51: where POST /upload puts images (nil: it answers
	// dropzone_unavailable).
	Uploads server.Uploader

	// M16 phase 2: the transcripts' images (nil: inline images are
	// described but not kept, no path is read).
	TranscriptImages *transcript.Images

	// #155 shared Codex server: the private directory of its launchers and
	// sockets ("": the switch cannot be turned on); the version check runs
	// CodexCLI.
	CodexRun string

	// M13 screen share: where grabbed frames are stored ("": none, and
	// screen.grab fails); ScreenTimeout and ScreenTTL: see server.Options.
	ScreenDir                string
	SecretsDir               string // #108
	ScreenTimeout, ScreenTTL time.Duration
	// M13 whiteboard: the boards' directory ("" or "-": no whiteboards) and
	// Drop Zone's data directory, for drops.list ("": none).
	Whiteboards string
	DropsRoot   string
	// #223: the filing cabinet's directory ("" or "-": none, the handoff
	// commands answer unsupported).
	HandoffDir string
	// #92 AI integration: the classification model and the LLM (nil: none,
	// the ai.* commands answer unsupported).
	AI *ai.Options
	// #184: the Kaneo connection (nil: none, the kaneo.* commands answer
	// unsupported and Kaneo floors have no board).
	Kaneo *kaneoconf.Service
	// #90 follow-up questions: the environment's toggle (nil: the panel's).
	FollowupsEnabled *bool
	// #110 pack up on request: the environment's toggle (nil: the panel's).
	PackupEnabled *bool
	// #66 schedule suggestions: the environment's toggle (nil: the panel's).
	ScheduleSuggestionsEnabled *bool
	// #98 activity: the environment's "Classify unknown commands" toggle
	// (nil: the panel's).
	ActivityModel *bool
	// #118 phase 2 floor overview summaries: the environment's toggle (nil:
	// the panel's).
	DigestEnabled *bool
	// #9 LLM handoffs: the environment's toggle (nil: the panel's).
	HandoffLLMEnabled *bool
	// #11 notifications: where messages go (nil: none, the notify.*
	// commands answer unsupported), and the environment's switch (nil: the
	// panel's).
	Notify        notify.Channel
	NotifyEnabled *bool
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
	if cfg.Hire != nil {
		opts.Hire = cfg.Hire
	}
	opts.Fresh = freshWorkers(cfg.Herdr)
	opts.MaxWatches, opts.MaxObservers, opts.PaneSize = cfg.MaxWatches, cfg.MaxObservers, paneSize(cfg.Herdr) // M5 term
	opts.PaneState = paneState(cfg.Herdr)                                                                     // #74
	opts.MaxTranscriptWatches = cfg.MaxTranscriptWatches                                                      // M16 transcript
	if cfg.Git != nil {
		opts.Git = cfg.Git
		opts.Changes = cfg.Git // M5 usage
		opts.PRGit = cfg.Git   // M7 boards
	}
	if cfg.ClaudeCLI != "" || cfg.CodexCLI != "" { // #136
		cctx, cancel := context.WithCancel(ctx)
		catalog := harness.NewCommandCatalog(cctx, log, cfg.ClaudeCLI, cfg.CodexCLI)
		defer func() {
			cancel()
			catalog.Wait()
		}()
		opts.Commands = catalog
		opts.Prompts = harness.NewPrompts(catalog) // #138
	}
	if cfg.Git != nil { // #137
		fctx, cancel := context.WithCancel(ctx)
		files := fileindex.New(fctx, fileindex.Options{Git: cfg.Git, RG: &fileindex.RG{Bin: cfg.RG}, Log: log})
		defer func() {
			cancel()
			files.Wait()
		}()
		opts.Files = files
	}
	if cfg.Git != nil { // #54 repository discovery: its own short git timeout, a few calls at a time
		dctx, cancel := context.WithCancel(ctx)
		disc := repodisc.New(dctx, repodisc.Options{Git: &gitops.Git{Bin: cfg.Git.Bin, Timeout: repodisc.DefaultGitTimeout}, Log: log})
		defer func() {
			cancel()
			disc.Wait()
		}()
		opts.RepoDiscovery = disc
	}
	if cfg.ClaudeProjects != "" || cfg.CodexSessions != "" { // M5 usage
		opts.Usage = &server.UsageConfig{Roots: usage.Roots{ClaudeProjects: cfg.ClaudeProjects, CodexSessions: cfg.CodexSessions},
			Pricing: cfg.Pricing, Images: cfg.TranscriptImages}
	}
	if cfg.ClaudeProjects != "" { // #23 Claude subagents, from the usage tracker's reads (and the hooks')
		src := claudeChildren(log, cfg.ClaudeHooks, cfg.Control)
		opts.ChildSources = append(opts.ChildSources, src)
		opts.Usage.ClaudeChildren = func(session string) server.ChildReader { return src.Listener(session) }
	}
	if cfg.CodexSessions != "" || cfg.CodexRun != "" {
		// #25 Codex subagents, from the usage tracker's reads of their
		// rollouts; #27 a shared-server worker's, live from its own
		// app-server through the bridge's join, in the same source.
		src := codexchild.New(codexchild.Options{Log: log.Warn})
		opts.ChildSources = append(opts.ChildSources, src)
		opts.CodexChildren = src
		if cfg.CodexSessions != "" {
			opts.Usage.CodexChildren = func(session string) server.ChildReader { return src.Listener(session) }
		}
	}
	opts.RunsDir, opts.ReportPoll = cfg.RunsDir, cfg.ReportPoll // M6 runs
	opts.Boards = cfg.Boards                                    // M7 boards
	opts.BoardWatchPoll, opts.BoardIdlePoll, opts.BoardRefreshMin, opts.BoardTick =
		cfg.BoardWatchPoll, cfg.BoardIdlePoll, cfg.BoardRefreshMin, cfg.BoardTick
	opts.Limits = cfg.Limits // M10 limits
	// #138: the Codex profiles, the bridge's own home first; the limits are read per profile.
	userHome, _ := os.UserHomeDir()
	opts.CodexProfiles = codexaccount.New(userHome, codex.DefaultHome())
	if cfg.Limits != nil {
		lim := *cfg.Limits
		lim.Accounts = opts.CodexProfiles
		opts.Limits = &lim
	}
	opts.ScreenDir, opts.ScreenTimeout, opts.ScreenTTL = cfg.ScreenDir, cfg.ScreenTimeout, cfg.ScreenTTL // M13 screen
	opts.SecretsDir = cfg.SecretsDir                                                                     // #108
	if cfg.CodexRun != "" && cfg.Control != nil {                                                        // #155
		opts.CodexRun = cfg.CodexRun
		opts.CodexShell = cfg.Control.Shell // #68: the launchers are written in the shell that runs them
		opts.CodexHost = server.NewCodexHost(execpath.Resolve(cmp.Or(cfg.CodexCLI, "codex")), execpath.Resolve("direnv"))
	}

	if cfg.Whiteboards != "" && cfg.Whiteboards != "-" { // M13 whiteboard
		opts.Whiteboards = whiteboard.New(cfg.Whiteboards)
	}
	opts.DropsRoot = cfg.DropsRoot
	if cfg.HandoffDir != "" && cfg.HandoffDir != "-" { // #223 handoffs
		dir, err := filepath.Abs(cfg.HandoffDir)
		if err != nil {
			return fmt.Errorf("handoff directory: %w", err)
		}
		if opts.Handoffs, err = handoff.New(dir, st, nil); err != nil {
			return fmt.Errorf("handoff directory: %w", err)
		}
	}
	if cfg.AI != nil { // #92 AI integration
		svc, err := ai.New(*cfg.AI)
		if err != nil {
			return fmt.Errorf("ai integration: %w", err)
		}
		opts.AI = svc
	}
	opts.Kaneo = cfg.Kaneo                                           // #184
	opts.FollowupsEnabled = cfg.FollowupsEnabled                     // #90
	opts.PackupEnabled = cfg.PackupEnabled                           // #110
	opts.ScheduleSuggestionsEnabled = cfg.ScheduleSuggestionsEnabled // #66
	opts.ActivityModel = cfg.ActivityModel                           // #98
	opts.DigestEnabled = cfg.DigestEnabled                           // #118
	opts.HandoffLLMEnabled = cfg.HandoffLLMEnabled                   // #9
	if cfg.Notify != nil {                                           // #11
		opts.NotifyChannel, opts.NotifyEnabled = cfg.Notify, cfg.NotifyEnabled
	}
	opts.Caps, opts.HireOptions, opts.Load = cfg.Caps, cfg.HireOptions, server.HostLoad
	// #74 server rack: checkupdates' throwaway sync database lives in a
	// directory of the bridge's own, next to the world database, so it never
	// meets another checkupdates' lock (a bar module, a cron job).
	opts.HostStats = &hoststats.Config{Updates: hoststats.UpdatesConfig{StateDir: filepath.Join(filepath.Dir(cfg.DB), "checkupdates")}}
	opts.TrustTimeout, opts.SeenTimeout, opts.ExitTimeout = cfg.TrustTimeout, cfg.SeenTimeout, cfg.ExitTimeout
	opts.WrapUpTimeout = cfg.WrapUpTimeout // #83
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
	run("server", func() error {
		srv := server.NewServer(hub, log)
		srv.SetUploader(cfg.Uploads)
		return srv.Serve(ctx, ln)
	})
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

// ListSessions is `herdr session list` (read only), for session.create's
// checks (#58).
func (f floorHerdr) ListSessions(ctx context.Context) ([]herdr.Session, error) {
	return f.read.ListSessions(ctx)
}

// paneState reads a pane's size and what its tab does with it (zoomed,
// focused, how many panes) from its session's snapshot, read only (#74).
func paneState(read watch.Herdr) func(ctx context.Context, socket, pane string) (herdr.PaneState, bool) {
	return func(ctx context.Context, socket, pane string) (herdr.PaneState, bool) {
		if read == nil || socket == "" {
			return herdr.PaneState{}, false
		}
		ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		snap, err := read.Snapshot(ctx, socket)
		if err != nil {
			return herdr.PaneState{}, false
		}
		return snap.PaneState(pane)
	}
}

// paneSize is the laptop observer's default size: the size of paneState.
func paneSize(read watch.Herdr) func(ctx context.Context, socket, pane string) (int, int, bool) {
	state := paneState(read)
	return func(ctx context.Context, socket, pane string) (int, int, bool) {
		st, ok := state(ctx, socket, pane)
		return st.Cols, st.Rows, ok
	}
}

// freshWorkers reads a session's workspaces from herdr right now (read
// only: session.snapshot), what the hub checks before it closes an idle
// main checkout.
func freshWorkers(read watch.Herdr) func(ctx context.Context, socket string) ([]world.WorkerObs, error) {
	if read == nil {
		return nil
	}
	return func(ctx context.Context, socket string) ([]world.WorkerObs, error) {
		snap, err := read.Snapshot(ctx, socket)
		if err != nil {
			return nil, err
		}
		return world.FromSnapshot(snap), nil
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
	board := fs.String("board", "", "watch this floor's issue and pull request boards too (board.watch): with -once, stop at the first fetched pair")
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
	if *once && *board == "" && welcome.Resume == proto.ResumeReplay && hello.SinceSeq != nil && *hello.SinceSeq == welcome.ServerSeq {
		return nil
	}
	if *board != "" { // M7 boards
		watch := proto.Command{T: proto.CmdBoardWatch, ReqID: "dump-board", Args: mustMarshal(proto.BoardArgs{Session: *board})}
		if err := conn.Send(ctx, watch); err != nil {
			return err
		}
	}
	fetched := map[string]bool{}
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
		if *board != "" && *once {
			var b struct {
				FetchedAt int64 `json:"fetched_at"`
			}
			if (env.T == proto.TBoardIssues || env.T == proto.TBoardPRs) && json.Unmarshal(msg, &b) == nil && b.FetchedAt > 0 {
				fetched[env.T] = true
			}
			if env.T == proto.TError || (env.T == proto.TAck && strings.Contains(string(msg), `"enabled":false`)) ||
				(fetched[proto.TBoardIssues] && fetched[proto.TBoardPRs]) {
				_ = conn.Close()
				return nil
			}
			continue
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
		fmt.Fprintf(stderr, "  %s cmd session.create '{\"name\":\"h3d-scratch\"}'\n", name)
		fmt.Fprintf(stderr, "  %s cmd worker.hire '{\"session\":\"h3d-scratch\",\"desk_index\":0,\"harness\":\"codex\",\"model\":\"gpt-6-luna\",\"effort\":\"low\"}'\n", name)
		fmt.Fprintf(stderr, "  %s cmd worker.fire '{\"id\":\"…\",\"worktree\":\"keep\"}'\n", name)
		fmt.Fprintf(stderr, "  %s cmd issue.comment '{\"session\":\"h3d-scratch\",\"id\":\"JeffreyVdb/h3d-lab#3\",\"body\":\"hi\"}'\n\nflags:\n", name)
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

func mustMarshal(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

// claudeChildren is the Claude child-agent source (#23). With a hooks
// directory it installs the bridge's hook settings there, which Control
// passes to the Claude workers it starts and resumes, and reads their log;
// without one (or without flock), the transcripts alone.
func claudeChildren(log *slog.Logger, dir string, control *herdr.Control) *claudechild.Source {
	opts := claudechild.Options{Log: log}
	if dir == "" || dir == "-" {
		return claudechild.New(opts)
	}
	flock, ferr := exec.LookPath("flock")
	cat, cerr := exec.LookPath("cat")
	abs, aerr := filepath.Abs(dir)
	if err := errors.Join(ferr, cerr, aerr); err != nil {
		log.Warn("claude hooks not installed: subagents are read from the transcripts only", "err", err)
		return claudechild.New(opts)
	}
	flock, _ = filepath.Abs(flock)
	cat, _ = filepath.Abs(cat)
	settings, hookLog, err := claudechild.InstallHooks(abs, flock, cat)
	if err != nil {
		log.Warn("claude hooks not installed: subagents are read from the transcripts only", "err", err)
		return claudechild.New(opts)
	}
	if control != nil {
		control.ClaudeSettings = settings
	}
	opts.HookLog = hookLog
	return claudechild.New(opts)
}
