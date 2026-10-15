// Package shell is the bridge's shell policy (#68): which shell starts a
// woken floor's server and runs a shared Codex worker's launcher. It is a
// two-value enum, not a command: Bash is the default, Fish an explicit
// compatibility option, and nothing else is accepted. The bridge never
// reads $SHELL and never prefers whichever shell happens to be installed.
package shell

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// Kind is the shell policy.
type Kind string

// The supported shells.
const (
	Bash Kind = "bash"
	Fish Kind = "fish"
)

// Default is the policy when none is configured.
const Default = Bash

// Option names how the policy is set, for the errors that mention it.
const Option = "--shell (or $HERDR_WORLD_SHELL)"

// Parse reads the policy as configured: "" is Default, anything but bash
// and fish is refused.
func Parse(s string) (Kind, error) {
	switch Kind(s) {
	case "":
		return Default, nil
	case Bash, Fish:
		return Kind(s), nil
	}
	return "", fmt.Errorf("unknown shell %q: %s takes bash (the default) or fish", s, Option)
}

// Or is k, Default when it is empty.
func (k Kind) Or() Kind {
	if k == "" {
		return Default
	}
	return k
}

// LauncherExt is the extension of a shared Codex launcher written in k's
// language: ".sh" (run explicitly as `bash <file>`, never as `sh`) or ".fish".
func (k Kind) LauncherExt() string {
	if k.Or() == Fish {
		return ".fish"
	}
	return ".sh"
}

// Known is every shell a launcher may have been written for: v1.45.0 wrote
// only ".fish", so cleanup removes the launchers of all of them whatever
// the policy is now.
var Known = []Kind{Bash, Fish}

// MissingError reports that the configured shell is not installed.
type MissingError struct {
	Kind     Kind
	Searched []string
	// Path is set when the shell was resolved earlier, at this path, and
	// is no longer an executable file there.
	Path string
}

func (e *MissingError) Error() string {
	other := Fish
	if e.Kind.Or() == Fish {
		other = Bash
	}
	if e.Path != "" {
		return fmt.Sprintf("the configured shell %q at %s is no longer an executable file: install it again, or set %s to %s; "+
			"the bridge never falls back to another shell on its own", string(e.Kind.Or()), e.Path, Option, other)
	}
	return fmt.Sprintf("the configured shell %q was not found (looked in $PATH and %v): install it, or set %s to %s; "+
		"the bridge never falls back to another shell on its own", string(e.Kind.Or()), e.Searched, Option, other)
}

// FallbackDirs are searched after $PATH: a user systemd manager's PATH is
// often short, and these hold the distributions' shells.
var FallbackDirs = []string{"/usr/bin", "/bin", "/usr/local/bin"}

// legacyFish is where v1.45.0 hardcoded fish. It is preferred for fish so
// the compatibility path's argv stays what it was.
const legacyFish = "/bin/fish"

// Locate resolves k to an absolute path. Tests replace it.
var Locate = locate

// Resolve is the absolute path of k's executable. Fish is /bin/fish when it
// exists; otherwise the first of $PATH and FallbackDirs. A missing shell is
// a *MissingError.
func Resolve(k Kind) (string, error) { return Locate(k.Or()) }

func locate(k Kind) (string, error) {
	var searched []string
	if k == Fish {
		searched = append(searched, legacyFish)
		if executable(legacyFish) {
			return legacyFish, nil
		}
	}
	searched = append(searched, "$PATH")
	if p, err := exec.LookPath(string(k)); err == nil {
		if abs, err := filepath.Abs(p); err == nil && executable(abs) {
			return abs, nil
		}
	}
	for _, d := range FallbackDirs {
		p := filepath.Join(d, string(k))
		searched = append(searched, d)
		if executable(p) {
			return p, nil
		}
	}
	return "", &MissingError{Kind: k, Searched: searched}
}

// Verify reports whether bin, a path Resolve returned earlier, is still
// the executable of k: it exists, is a regular file once symlinks are
// followed and has an execute bit. If not, the error is the same
// *MissingError a shell that was never installed gets. One stat.
func Verify(k Kind, bin string) error {
	if !executable(bin) {
		return &MissingError{Kind: k.Or(), Path: bin}
	}
	return nil
}

// executable stats p, which follows symlinks.
func executable(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular() && st.Mode().Perm()&0o111 != 0
}
