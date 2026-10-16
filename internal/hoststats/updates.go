package hoststats

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/execpath"
)

// Defaults of the updates check.
const (
	DefaultUpdatesEvery   = 12 * time.Hour
	DefaultUpdatesTimeout = 60 * time.Second
)

// Runner runs one program to its end and returns its stdout and exit code.
// ExecRunner is the real one, the tests' a fake. err is set when the program
// did not run to an exit (not found, killed by the context).
type Runner interface {
	Run(ctx context.Context, path string, env []string) (stdout []byte, exit int, err error)
}

// stopGrace is how long a cancelled or timed-out run has, after SIGTERM, to
// clean up (checkupdates removes its db.lck in a TERM trap) before SIGKILL.
const stopGrace = 3 * time.Second

// ExecRunner runs real processes, each in its own process group so that a
// cancelled context takes the children down too: SIGTERM to the group first,
// SIGKILL to it after stopGrace. stderr is discarded.
type ExecRunner struct{}

// Run implements Runner.
func (ExecRunner) Run(ctx context.Context, path string, env []string) ([]byte, int, error) {
	cmd := exec.CommandContext(ctx, path)
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
	cmd.WaitDelay = stopGrace
	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Start()
	if err != nil {
		return nil, -1, err
	}
	pgid := cmd.Process.Pid
	err = cmd.Wait()
	if ctx.Err() != nil {
		// After the grace Go kills only the leader: end what is left of the group.
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) && ctx.Err() == nil {
		return out.Bytes(), ee.ExitCode(), nil
	}
	if err != nil {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return out.Bytes(), -1, err
	}
	return out.Bytes(), 0, nil
}

// UpdatesConfig configures the pending-updates check. The zero value is the
// real thing.
type UpdatesConfig struct {
	// Runner runs checkupdates (default ExecRunner).
	Runner Runner
	// Resolve finds an executable by name (default execpath.Resolve, which
	// also looks in ~/.local/bin); it supports a name when the result is an
	// absolute path.
	Resolve func(name string) string
	// OSRelease is the file that says which distribution this is (default
	// /etc/os-release).
	OSRelease string
	// StateDir is CHECKUPDATES_DB: a directory of the bridge's own, so
	// checkupdates' throwaway sync database never meets another run's lock
	// ("": checkupdates' default, shared; only tests).
	StateDir string
	// Env is the environment checkupdates gets (default os.Environ).
	Env func() []string
	// Every is the least time between two runs (default 12 h), Timeout how
	// long one may take (default 60 s).
	Every, Timeout time.Duration
}

// UpdatesResult is the last good count of pending updates and when it was
// taken.
type UpdatesResult struct {
	Count     int
	CheckedAt time.Time
}

// Updates counts pending pacman updates on Arch-based hosts with
// `checkupdates` (pacman-contrib), which syncs a throwaway copy of the sync
// database and never touches the real one, needs no root and cannot cause a
// partial upgrade. The bridge never runs `pacman -Sy` itself.
//
// A run starts only from Poll, which the Sampler calls while somebody
// watches, and at most once per Every since the last run began, whether it
// worked, failed, timed out or was cancelled with the last watcher (so
// watching, unwatching and watching again never starts another mirror sync).
// Exit 0 is the updates (one line each), 2 none; exit 1 or a timeout keeps
// the last good count with its time, never an invented one.
type Updates struct {
	cfg UpdatesConfig
	now func() time.Time

	mu        sync.Mutex
	supported bool
	bin       string // checkupdates, resolved
	fakeDir   string // where fakeroot was found, for checkupdates' PATH
	last      *UpdatesResult
	lastRun   time.Time
	running   bool
}

// NewUpdates makes the checker; now is the clock of the 12 h cache.
func NewUpdates(cfg UpdatesConfig, now func() time.Time) *Updates {
	if cfg.Runner == nil {
		cfg.Runner = ExecRunner{}
	}
	if cfg.Resolve == nil {
		cfg.Resolve = execpath.Resolve
	}
	if cfg.OSRelease == "" {
		cfg.OSRelease = "/etc/os-release"
	}
	if cfg.Env == nil {
		cfg.Env = os.Environ
	}
	if cfg.Every <= 0 {
		cfg.Every = DefaultUpdatesEvery
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = DefaultUpdatesTimeout
	}
	return &Updates{cfg: cfg, now: now}
}

// Refresh decides whether this host is supported: Arch or Arch-based
// (/etc/os-release ID=arch or arch in ID_LIKE) with `checkupdates` and
// `fakeroot` both found. It is asked again at every Start, so installing
// pacman-contrib needs no restart.
func (u *Updates) Refresh() {
	var bin, fakeDir string
	if archBased(u.cfg.OSRelease) {
		cu, fr := u.cfg.Resolve("checkupdates"), u.cfg.Resolve("fakeroot")
		if filepath.IsAbs(cu) && filepath.IsAbs(fr) {
			bin, fakeDir = cu, filepath.Dir(fr)
		}
	}
	u.mu.Lock()
	u.supported, u.bin, u.fakeDir = bin != "", bin, fakeDir
	u.mu.Unlock()
}

// Supported reports whether the host can be asked.
func (u *Updates) Supported() bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.supported
}

// Last is the last good result, nil when there is none (or the host is not
// supported).
func (u *Updates) Last() *UpdatesResult {
	u.mu.Lock()
	defer u.mu.Unlock()
	if !u.supported || u.last == nil {
		return nil
	}
	r := *u.last
	return &r
}

// Poll starts a run when the host is supported, none is running and the
// last one began Every ago or more (or never). It returns at once; done, if
// not nil, is called after a run ends, with whether it changed Last. A run
// cancelled by ctx still counts as an attempt (it leaves Last as it was).
func (u *Updates) Poll(ctx context.Context, done func(changed bool)) {
	u.mu.Lock()
	now := u.now()
	if !u.supported || u.running || (!u.lastRun.IsZero() && now.Sub(u.lastRun) < u.cfg.Every && !now.Before(u.lastRun)) {
		u.mu.Unlock()
		return
	}
	u.running, u.lastRun = true, now
	bin, fakeDir := u.bin, u.fakeDir
	u.mu.Unlock()
	go func() {
		rctx, cancel := context.WithTimeout(ctx, u.cfg.Timeout)
		defer cancel()
		env := u.cfg.Env()
		if u.cfg.StateDir != "" {
			env = append(env, "CHECKUPDATES_DB="+u.cfg.StateDir)
		}
		env = withPathDir(env, fakeDir)
		out, exit, err := u.cfg.Runner.Run(rctx, bin, env)
		if err != nil || exit < 0 {
			// Not ended on its own (cancelled, timed out, killed): its TERM trap
			// may not have run, so its lock is stale. Only our own directory.
			u.dropStaleLock()
		}
		changed := false
		u.mu.Lock()
		u.running = false
		switch {
		case ctx.Err() != nil: // stopped watching: no result, but the attempt counts
		case err != nil || (exit != 0 && exit != 2): // exit 1, a timeout: keep the last good count
		default:
			n := 0
			if exit == 0 {
				n = countLines(out)
			}
			u.last = &UpdatesResult{Count: n, CheckedAt: u.now()}
			changed = true
		}
		u.mu.Unlock()
		if done != nil {
			done(changed)
		}
	}()
}

// dropStaleLock removes db.lck from the bridge's own CHECKUPDATES_DB, left by
// a run that was stopped before its trap removed it. Safe because one run
// happens at a time and the process group has been reaped. Never touches the
// shared default directory (StateDir "") or anything but that one file.
func (u *Updates) dropStaleLock() {
	if u.cfg.StateDir == "" {
		return
	}
	_ = os.Remove(filepath.Join(u.cfg.StateDir, "db.lck"))
}

func countLines(b []byte) int {
	n := 0
	for _, l := range bytes.Split(b, []byte{'\n'}) {
		if len(bytes.TrimSpace(l)) > 0 {
			n++
		}
	}
	return n
}

// withPathDir puts dir (where fakeroot was found) on PATH's end when it is
// not on it, so checkupdates finds fakeroot as the bridge did, also under a
// systemd user manager that lacks ~/.local/bin.
func withPathDir(env []string, dir string) []string {
	if dir == "" {
		return env
	}
	for i, kv := range env {
		if p, ok := strings.CutPrefix(kv, "PATH="); ok {
			for _, d := range filepath.SplitList(p) {
				if d == dir {
					return env
				}
			}
			env[i] = "PATH=" + p + string(os.PathListSeparator) + dir
			return env
		}
	}
	return append(env, "PATH="+dir)
}

// archBased reads os-release: ID=arch, or arch among ID_LIKE.
func archBased(path string) bool {
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		v = strings.Trim(v, `"'`)
		switch k {
		case "ID":
			if v == "arch" {
				return true
			}
		case "ID_LIKE":
			for _, f := range strings.Fields(v) {
				if f == "arch" {
					return true
				}
			}
		}
	}
	return false
}
