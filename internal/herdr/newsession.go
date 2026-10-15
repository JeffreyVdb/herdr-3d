package herdr

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// #58: session.create. herdr has no `session create` verb: a session is
// created by starting a server under a name it has not seen. Starting one
// under a known name wakes that session instead, so a new name must be free
// in every sense herdr has: not listed (running or not), no folder under the
// sessions folder, and no transient unit herdr-s-<name> still loaded.

// newSessionRe is the character set of a new session's name (issue #58,
// decision 1): stricter than herdr's (no uppercase, no dots), so it is also
// a safe unit name, path component and floor name.
var newSessionRe = regexp.MustCompile(`^[a-z0-9_-]+$`)

// MaxSessionName is herdr's own cap on a session name, in bytes.
const MaxSessionName = 64

// sunPath is the size of sockaddr_un.sun_path on Linux, and clientSocket
// the longest socket herdr binds in a session's folder: a session's
// server fails to start when <sessions folder>/<name>/herdr-client.sock does
// not fit (measured, docs/decisions.md "New herdr sessions").
const (
	sunPath      = 108
	clientSocket = "/herdr-client.sock"
)

// MaxNewSessionName is the longest name a new session may have when herdr
// keeps sessions in sessionsDir: its client socket must fit sun_path, and
// herdr refuses names over 64 bytes.
func MaxNewSessionName(sessionsDir string) int {
	n := sunPath - len(filepath.Clean(sessionsDir)) - 1 - len(clientSocket)
	return max(0, min(n, MaxSessionName))
}

// CheckNewSessionName says, readably, why name cannot be a new session's
// name (nil: it can): ^[a-z0-9_-]+$, no leading "-" (it would read as a
// flag), not herdr's "default", and at most maxLen bytes
// (MaxNewSessionName).
func CheckNewSessionName(name string, maxLen int) error {
	switch {
	case name == "":
		return errors.New("Give the floor a name.")
	case name == "default":
		return errors.New("“default” is herdr’s own session: pick another name.")
	case !newSessionRe.MatchString(name):
		return errors.New("Use only lowercase letters, digits, “_” and “-”.")
	case name[0] == '-':
		return errors.New("The name cannot start with “-”.")
	case len(name) > maxLen:
		return fmt.Errorf("Keep the name to at most %d characters (herdr’s socket path on this host).", maxLen)
	}
	return nil
}

// ValidNewSessionName reports whether name may be a new session's name
// (CheckNewSessionName).
func ValidNewSessionName(name string, maxLen int) bool {
	return CheckNewSessionName(name, maxLen) == nil
}

// SessionsDir is the folder herdr keeps named sessions in, learned from
// `session list`: the parent of a named session's folder, else the
// "sessions" folder in the default session's.
func SessionsDir(list []Session) (string, error) {
	var def string
	for _, s := range list {
		if !filepath.IsAbs(s.SessionDir) {
			continue
		}
		if !s.Default {
			return filepath.Dir(filepath.Clean(s.SessionDir)), nil
		}
		def = filepath.Join(s.SessionDir, "sessions")
	}
	if def == "" {
		return "", errors.New("herdr session list names no session folder")
	}
	return def, nil
}

// SessionUnit is the transient systemd unit a session's server runs in.
func SessionUnit(name string) string { return "herdr-s-" + name + ".service" }

// NewSessionTaken says, readably, why name is not free for a new session
// (""; free): herdr lists it (running or not), something is at
// <sessionsDir>/<name> (a stale folder, a backup), or unitLoaded (nil: not
// checked) says its transient unit is still loaded.
func NewSessionTaken(list []Session, sessionsDir, name string, unitLoaded func(unit string) bool) string {
	for _, s := range list {
		if s.Name != name {
			continue
		}
		if s.Running {
			return fmt.Sprintf("“%s” is already a herdr session.", name)
		}
		return fmt.Sprintf("“%s” is already a herdr session (asleep): wake its floor instead.", name)
	}
	dir := filepath.Join(sessionsDir, name)
	if _, err := os.Lstat(dir); !errors.Is(err, os.ErrNotExist) {
		return fmt.Sprintf("“%s” already has a folder in herdr’s sessions folder (%s): starting it would reuse what is there.", name, dir)
	}
	if unit := SessionUnit(name); unitLoaded != nil && unitLoaded(unit) {
		return fmt.Sprintf("The service %s is still loaded: a server under that name may still be starting or stopping.", unit)
	}
	return ""
}

// TransientUnitLoaded reports whether a transient user unit is loaded, by
// its unit file under runtimeDir (RuntimeDir), which systemd removes
// when it unloads the unit (--collect: when it stops). No runtime dir:
// nothing is known to be loaded.
func TransientUnitLoaded(runtimeDir string) func(unit string) bool {
	return func(unit string) bool {
		if runtimeDir == "" || unit == "" || strings.ContainsAny(unit, "/\x00") || strings.HasPrefix(unit, ".") {
			return false
		}
		_, err := os.Lstat(filepath.Join(runtimeDir, "systemd", "transient", unit))
		return err == nil
	}
}

// RuntimeDir is the user's runtime directory, where systemd keeps the
// transient unit files: $XDG_RUNTIME_DIR, else /run/user/<uid> (a bridge
// started outside a login session may not have the variable).
func RuntimeDir() string {
	if d := os.Getenv("XDG_RUNTIME_DIR"); filepath.IsAbs(d) {
		return d
	}
	return "/run/user/" + strconv.Itoa(os.Getuid())
}

// CreateSession starts a server under a new session name, as the
// transient user unit herdr-s-<session> with a login fish environment (the
// wake's launch). The caller checks the name is free (NewSessionTaken)
// first: herdr would wake a session it knows instead.
func (c *Control) CreateSession(ctx context.Context, session string) error {
	if err := CheckNewSessionName(session, MaxSessionName); err != nil {
		return fmt.Errorf("%w: invalid new session %q: %v", ErrNotAllowed, session, err)
	}
	home, err := c.home()
	if err != nil {
		return err
	}
	_, err = c.run(ctx, opCreateSession, map[string]string{"session": session, "home": home})
	return err
}
