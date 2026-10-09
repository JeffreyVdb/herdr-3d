package codexapp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// MarkerVar marks every process of a shared-server launch: the launcher
// sets it, so the app-server and everything it starts (MCP servers, the
// model's commands) carry it. Only a process of this user whose
// environment has MarkerVar=<the launch's token> exactly is the launch's
// to signal; one that merely names the launch's paths is not.
const MarkerVar = "H3D_CODEX_SERVER"

var (
	nameRe  = regexp.MustCompile(`^[0-9a-f]{6,32}$`)
	tokenRe = regexp.MustCompile(`^[0-9a-f]{32}$`)
)

// Launch is one shared-server Codex worker's launch: its files, all
// directly in Dir (Control.CodexRun) and named by the worker's marker hex,
// and the token that marks its processes.
type Launch struct {
	Dir   string // the private codex run directory
	Name  string // the worker's marker hex
	Token string // the processes' MarkerVar value
	Cwd   string // the directory the server trusts (in memory) and the TUI names with -C
}

// NewLaunch returns a launch with a fresh token.
func NewLaunch(dir, name, cwd string) (Launch, error) {
	var rnd [16]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		return Launch{}, err
	}
	l := Launch{Dir: dir, Name: name, Token: hex.EncodeToString(rnd[:]), Cwd: cwd}
	return l, l.Valid()
}

// Valid checks the launch's parts.
func (l Launch) Valid() error {
	switch {
	case !filepath.IsAbs(l.Dir) || filepath.Clean(l.Dir) != l.Dir:
		return fmt.Errorf("codexapp: run directory %q is not absolute and clean", l.Dir)
	case !nameRe.MatchString(l.Name):
		return fmt.Errorf("codexapp: launch name %q is not a marker hex", l.Name)
	case !tokenRe.MatchString(l.Token):
		return errors.New("codexapp: launch token is not 32 hex")
	case !plainDir(l.Cwd):
		return fmt.Errorf("codexapp: %q is not a plain directory path", l.Cwd)
	}
	return nil
}

var plainDirRe = regexp.MustCompile(`^/[A-Za-z0-9._/+@,=:-]{1,255}$`)

// plainDir is herdr.ValidPlainDir (the -C the TUI is started with must
// pass both).
func plainDir(d string) bool {
	return plainDirRe.MatchString(d) && filepath.Clean(d) == d
}

// Script, Socket, PIDFile and Log are the launch's files.
func (l Launch) Script() string  { return filepath.Join(l.Dir, l.Name+".fish") }
func (l Launch) Socket() string  { return filepath.Join(l.Dir, l.Name+".sock") }
func (l Launch) PIDFile() string { return filepath.Join(l.Dir, l.Name+".pid") }
func (l Launch) Log() string     { return filepath.Join(l.Dir, l.Name+".log") }

// ServerFeatures is the -c override every shared server starts with
// (#186 follow-up, findings §14). Codex 0.162 turns instant_interrupt on
// by default: a steer (the bridge's answer, or a line typed while a turn
// runs) cancels the model request in flight and is recorded at once, so
// an answer no longer waits for the turn's next model request and is no
// longer dropped when the turn ends first; the bridge's sent/delivered
// model (#158) rests on that. Off is 0.160's and 0.161's default, so the
// override changes nothing on them.
const ServerFeatures = "features.instant_interrupt=false"

// fishQuote single-quotes s for fish.
func fishQuote(s string) string {
	return "'" + strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(s) + "'"
}

// tomlString is s as a TOML basic string.
func tomlString(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

// Render is the launcher: fish, typed into the worker's initialized pane as
// `setsid -f fish <script>`, so the server gets the pane's environment
// (direnv's exports, Herdr's HERDR_PANE_ID for its session-id hook) and the
// user's `codex` wrapper function applies (phase 1, D1). It marks the
// server's processes, records the launcher's pid, and starts `codex
// app-server` on the worker's socket with the worker's directory trusted
// in memory only (B10: config.toml is not written) and ServerFeatures.
func (l Launch) Render() string {
	trust := "projects={" + tomlString(l.Cwd) + "={trust_level=\"trusted\"}}"
	return strings.Join([]string{
		"# herdr-3d (#155): this worker's own Codex app-server, started from its pane.",
		"set -gx " + MarkerVar + " " + l.Token,
		"echo $fish_pid >" + fishQuote(l.PIDFile()),
		"codex app-server -c " + fishQuote(trust) + " -c " + fishQuote(ServerFeatures) + " --listen " + fishQuote("unix://"+l.Socket()) +
			" </dev/null >" + fishQuote(l.Log()) + " 2>&1",
		"",
	}, "\n")
}

// Write creates the run directory (0700, this user's) and the launcher
// (0600), removing what an earlier launch of the same name left.
func (l Launch) Write() error {
	if err := l.Valid(); err != nil {
		return err
	}
	if err := PrivateDir(l.Dir); err != nil {
		return err
	}
	for _, p := range []string{l.Socket(), l.PIDFile()} {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return os.WriteFile(l.Script(), []byte(l.Render()), 0o600)
}

// PrivateDir makes dir (and its parents) and checks it is a directory of
// this user that no one else may enter.
func PrivateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	st, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !st.IsDir() || !ok || int(sys.Uid) != os.Getuid() {
		return fmt.Errorf("codexapp: %s is not a directory of this user", dir)
	}
	if st.Mode().Perm()&0o077 != 0 {
		if err := os.Chmod(dir, 0o700); err != nil {
			return err
		}
	}
	return nil
}

// Remove deletes the launch's files: the socket (and the socket Codex
// made the listen path a link to, when it is one of this user's sockets),
// the pid file, the launcher and the log. Call it once the server is gone.
func (l Launch) Remove() error {
	var errs []error
	if target, err := os.Readlink(l.Socket()); err == nil {
		if !filepath.IsAbs(target) {
			target = filepath.Join(l.Dir, target)
		}
		if st, err := os.Lstat(target); err == nil && st.Mode()&os.ModeSocket != 0 &&
			int(st.Sys().(*syscall.Stat_t).Uid) == os.Getuid() {
			errs = append(errs, removeMissingOK(target))
		}
	}
	for _, p := range []string{l.Socket(), l.PIDFile(), l.Script(), l.Log()} {
		errs = append(errs, removeMissingOK(p))
	}
	return errors.Join(errs...)
}

func removeMissingOK(p string) error {
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// Probe connects to the launch's socket and initializes, returning the
// server's userAgent; it joins nothing.
func Probe(ctx context.Context, sock string) (string, error) {
	c, err := dial(ctx, sock, nil)
	if err != nil {
		return "", err
	}
	defer c.close()
	var init struct {
		UserAgent string `json:"userAgent"`
	}
	err = c.call(ctx, "initialize", map[string]any{
		"clientInfo":   map[string]any{"name": ClientName, "title": "herdr-3d", "version": "probe"},
		"capabilities": map[string]any{"experimentalApi": true},
	}, &init)
	return init.UserAgent, err
}

// WaitReady probes the socket until the server answers, backing off up to
// half a second, until ctx ends.
func WaitReady(ctx context.Context, sock string) (string, error) {
	backoff := 50 * time.Millisecond
	for {
		pctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		ua, err := Probe(pctx, sock)
		cancel()
		if err == nil {
			return ua, nil
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("the app-server at %s did not answer: %w (%v)", sock, ctx.Err(), err)
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 500*time.Millisecond)
	}
}
