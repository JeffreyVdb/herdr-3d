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

	"github.com/JeffreyVdb/herdr-3d/internal/shell"
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
	envRe   = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*=`)
)

// Launch is one shared-server Codex worker's launch: its files, all
// directly in Dir (Control.CodexRun) and named by the worker's marker hex,
// and the token that marks its processes.
type Launch struct {
	Dir   string // the private codex run directory
	Name  string // the worker's marker hex
	Token string // the processes' MarkerVar value
	Cwd   string // the directory the server trusts (in memory) and the TUI names with -C
	// Shell is the language of the launcher (#68): bash (the zero value) or
	// fish. It is not recorded with a stored launch: everything that works
	// from a stored launch (Alive, FindServer, Stop, Remove) is
	// shell-independent.
	Shell shell.Kind
	// Env (#139) is what the server runs with besides the pane's
	// environment, as NAME=value: CODEX_HOME for a worker on a Codex
	// profile, nil for the default one. The launcher sets it on the
	// server's own command line, after the startup files (a CODEX_HOME
	// that ~/.bashrc or config.fish sets cannot undo it). Not recorded:
	// nothing that works from a stored launch needs it.
	Env []string
}

// NewLaunch returns a launch with a fresh token and a Bash launcher.
func NewLaunch(dir, name, cwd string) (Launch, error) {
	return NewLaunchFor(shell.Default, dir, name, cwd)
}

// NewLaunchFor is NewLaunch with a launcher written for sh.
func NewLaunchFor(sh shell.Kind, dir, name, cwd string) (Launch, error) {
	var rnd [16]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		return Launch{}, err
	}
	l := Launch{Dir: dir, Name: name, Token: hex.EncodeToString(rnd[:]), Cwd: cwd, Shell: sh.Or()}
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
	case strings.ContainsRune(l.Dir, 0):
		return errors.New("codexapp: run directory holds a NUL")
	}
	if _, err := shell.Parse(string(l.Shell)); err != nil {
		return fmt.Errorf("codexapp: %w", err)
	}
	for _, kv := range l.Env {
		if !envRe.MatchString(kv) || strings.HasPrefix(kv, MarkerVar+"=") || strings.ContainsAny(kv, "\x00\n\r") {
			return fmt.Errorf("codexapp: %q is not an environment variable the launcher sets", kv)
		}
	}
	return nil
}

var plainDirRe = regexp.MustCompile(`^/[A-Za-z0-9._/+@,=:-]{1,255}$`)

// plainDir is herdr.ValidPlainDir (the -C the TUI is started with must
// pass both).
func plainDir(d string) bool {
	return plainDirRe.MatchString(d) && filepath.Clean(d) == d
}

// Script, Socket, PIDFile and Log are the launch's files. The launcher's
// extension follows its shell (#68: ".sh" for bash, ".fish" for fish).
func (l Launch) Script() string { return l.scriptFor(l.Shell) }
func (l Launch) scriptFor(k shell.Kind) string {
	return filepath.Join(l.Dir, l.Name+k.LauncherExt())
}
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

// bashQuote single-quotes s for bash: nothing is special inside '…', so
// only the quote itself needs closing, escaping and reopening.
func bashQuote(s string) string { return "'" + strings.ReplaceAll(s, `'`, `'\''`) + "'" }

// fishQuote single-quotes s for fish.
func fishQuote(s string) string {
	return "'" + strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(s) + "'"
}

// tomlString is s as a TOML basic string.
func tomlString(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

// Render is the launcher, in the launch's shell. Typed into the worker's
// initialized pane as `setsid -f <shell> <script>`, it gives the server the
// pane's environment (direnv's exports, Herdr's HERDR_PANE_ID for its
// session-id hook) and lets the user's `codex` wrapper apply (phase 1, D1).
// It marks the server's processes, records the launcher's pid, and starts
// `codex app-server` on the worker's socket with the worker's directory
// trusted in memory only (B10: config.toml is not written) and
// ServerFeatures.
func (l Launch) Render() string {
	if l.Shell.Or() == shell.Fish {
		return l.renderFish()
	}
	return l.renderBash()
}

// renderBash is the Bash launcher (#68). A script run as `bash <file>` reads
// no startup file, so a `codex` function or alias of the user's ~/.bashrc
// would be lost (fish loads config.fish even then). The launcher therefore
// marks itself and records its pid, then re-executes itself as an
// interactive bash (-i: ~/.bashrc and the usual `[[ $- != *i* ]] && return`
// guard behave as in the pane's own shell; no terminal is needed) running
// the one command line. The pid recorded stays the supervising process
// (exec keeps it) and, unlike a variable exported inside a running shell,
// its own environment carries the marker. HISTFILE is dropped so the
// session cannot rewrite the user's history, and history expansion is off
// (+H) so a "!" in a path is just a character.
func (l Launch) renderBash() string {
	trust := "projects={" + tomlString(l.Cwd) + "={trust_level=\"trusted\"}}"
	exports := ""
	for _, kv := range l.Env {
		k, v, _ := strings.Cut(kv, "=")
		exports += "export " + k + "=" + bashQuote(v) + "; "
	}
	run := "unset HISTFILE; " + exports + "codex app-server -c " + bashQuote(trust) + " -c " + bashQuote(ServerFeatures) +
		" --listen " + bashQuote("unix://"+l.Socket()) + " </dev/null >" + bashQuote(l.Log()) + " 2>&1"
	return strings.Join([]string{
		"# herdr-3d (#68): this worker's own Codex app-server, started from its pane (bash).",
		"export " + MarkerVar + "=" + l.Token,
		"echo $$ >" + bashQuote(l.PIDFile()),
		`exec "$BASH" -i +H -c ` + bashQuote(run),
		"",
	}, "\n")
}

// renderFish is the fish launcher of v1.45.0, kept for the explicit fish
// compatibility option.
func (l Launch) renderFish() string {
	trust := "projects={" + tomlString(l.Cwd) + "={trust_level=\"trusted\"}}"
	lines := []string{
		"# herdr-3d (#155): this worker's own Codex app-server, started from its pane.",
		"set -gx " + MarkerVar + " " + l.Token,
		"echo $fish_pid >" + fishQuote(l.PIDFile()),
	}
	for _, kv := range l.Env {
		k, v, _ := strings.Cut(kv, "=")
		lines = append(lines, "set -gx "+k+" "+fishQuote(v))
	}
	return strings.Join(append(lines,
		"codex app-server -c "+fishQuote(trust)+" -c "+fishQuote(ServerFeatures)+" --listen "+fishQuote("unix://"+l.Socket())+
			" </dev/null >"+fishQuote(l.Log())+" 2>&1",
		""), "\n")
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
	for _, p := range append(l.scripts(), l.Socket(), l.PIDFile()) {
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

// scripts are the launcher the launch may have, in every shell's format: a
// launch recorded by v1.45.0 left a ".fish" launcher, which a bridge whose
// policy is bash now must still clean up (and a launch Write replaces).
func (l Launch) scripts() []string {
	out := make([]string, 0, len(shell.Known))
	for _, k := range shell.Known {
		out = append(out, l.scriptFor(k))
	}
	return out
}

// Remove deletes the launch's files: the socket (and the socket Codex
// made the listen path a link to, when it is one of this user's sockets),
// the pid file, the launcher (of any shell's format) and the log. Call it
// once the server is gone.
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
	for _, p := range append(l.scripts(), l.Socket(), l.PIDFile(), l.Log()) {
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
